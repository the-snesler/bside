/**
 * BackgroundRuntime materializes the sole conversation, owns the active
 * run's AbortController, and is the only place that calls the provider or
 * writes conversation/checkpoint storage. Sidebar and options pages never
 * own an inference request, tool loop, transcript authority, or credential
 * read — they only ever see what this file publishes through SidebarHub.
 *
 * Per-round provider/tool orchestration is delegated to `AgentLoop`; this
 * file owns run lifecycle (single-run enforcement, checkpointing,
 * persistence) and everything outside an active run (credentials, settings).
 */

import { AgentLoop } from "@/lib/background/agent-loop";
import { ChatGPTAuth } from "@/lib/background/chatgpt-auth";
import { WorkspaceState } from "@/lib/background/browser-program";
import type { SidebarHub } from "@/lib/background/sidebar-hub";
import { TabController } from "@/lib/background/tab-controller";
import type { TabControllerBrowserApi } from "@/lib/background/tab-controller";
import { decodeProviderError, OpenAIProvider, ProviderStreamError } from "@/lib/providers/openai";
import { OPENAI_PROVIDER, DEFAULT_MODEL_ID } from "@/lib/providers/openai-models";
import {
  appendConversationItem,
  clearRunCheckpoint,
  getAppSettings,
  getConversation,
  resetConversation,
  getCredentialStatus,
  getOpenAICredential,
  recoverInterruptedRun,
  saveAppSettings,
  saveOpenAICredential,
  saveRunCheckpoint,
  deleteOpenAICredential as deleteStoredCredential,
} from "@/lib/storage";
import type { RunStatus } from "@/lib/storage";
import { validatePromptText } from "@/lib/validation";
import type { ContextArtifact } from "@/lib/domain/tools";
import type { ConversationItem } from "@/lib/domain/conversation";
import type { AppSettingsV1, ModelDefinition, ProviderAdapter, ProviderAuth, ProviderDefinition } from "@/lib/domain/provider";
import type {
  ApprovalRequest,
  CredentialRequest,
  CredentialResponse,
  NormalizedError,
  RuntimeSnapshot,
  SettingsRequest,
  SettingsResponse,
  SidebarCommand,
} from "@/lib/protocol";
import { RUN_CANCELLED_SUFFIX } from "@/lib/protocol";

const CHECKPOINT_MIN_INTERVAL_MS = 1_000;
const DELTA_COALESCE_MS = 16;
const DELTA_COALESCE_BYTES = 1024;

type RunLifecycleStatus = "running" | "awaiting-approval" | "cancelling";

/** Run-level diagnostics for context export; held in memory only. */
interface RunRecord {
  runId: string;
  modelId: string;
  reasoningEffort: string;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "completed" | "cancelled" | "failed";
  error: NormalizedError | null;
  providerResponses: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
  toolCalls: { callId: string; name: string; startedAt: string; durationMs: number; ok: boolean; code: string | null; outputChars: number; truncatedOutput: boolean }[];
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
  agentLoop: AgentLoop;
  status: RunLifecycleStatus;
  partialAssistantText: string;
  pendingApproval: ApprovalRequest | null;
  lastCheckpointAt: number;
}

export class BackgroundRuntime {
  #sidebarHub: SidebarHub;
  #provider: ProviderAdapter;
  #chatgpt: ChatGPTAuth;
  #modelCatalog: readonly ModelDefinition[] = OPENAI_PROVIDER.models;
  #tabControllerFactory: () => TabController;
  #activeRun: ActiveRun | null = null;
  #notice: string | null = null;
  #workspace = new WorkspaceState();
  #latestContext: string | null = null;
  #resetting = false;
  #debugOutputs: string[] = [];
  #debugOutputChars = 0;
  #debugOutputTruncated = false;
  #runRecord: RunRecord | null = null;

  constructor(
    sidebarHub: SidebarHub,
    options: { provider?: ProviderAdapter; chatgpt?: ChatGPTAuth; tabControllerFactory?: () => TabController } = {},
  ) {
    this.#sidebarHub = sidebarHub;
    this.#chatgpt = options.chatgpt ?? new ChatGPTAuth();
    this.#provider = options.provider ?? new OpenAIProvider(
      async (auth, signal) => auth.method === "chatgpt" ? this.#chatgpt.getAuth(signal) : auth,
      (id) => this.#modelCatalog.find((model) => model.id === id),
    );
    this.#tabControllerFactory = options.tabControllerFactory ?? (() => new TabController(browser as unknown as TabControllerBrowserApi));
  }

  /** Runs once at background startup, before any Port connects. */
  async initialize(): Promise<void> {
    await recoverInterruptedRun();
  }

  async getSnapshot(): Promise<RuntimeSnapshot> {
    const [conversation, credential, settings, provider] = await Promise.all([
      getConversation(),
      this.#getCredentialStatus(),
      this.#getValidatedSettings(),
      this.#getProviderDefinition(),
    ]);
    const notice = this.#notice;
    this.#notice = null;
    return {
      conversation,
      credential: { ...credential, configured: credential.chatgpt.connected ? !credential.chatgpt.locked : credential.configured },
      provider,
      settings,
      page: this.#sidebarHub.currentAttachment(),
      activeRun: this.#activeRun
        ? {
            runId: this.#activeRun.runId,
            status: this.#activeRun.status,
            partialAssistantText: this.#activeRun.partialAssistantText,
            pendingApproval: this.#activeRun.pendingApproval,
          }
        : null,
      lastSeq: this.#sidebarHub.lastSeq(),
      notice,
    };
  }

  handleCommand(command: { v: 1; id: string; type: "context.export" }): Promise<{ markdown: string; filename: string }>;
  handleCommand(command: SidebarCommand): ReturnType<import("./sidebar-hub").SidebarHubDelegate["handleCommand"]>;
  async handleCommand(command: SidebarCommand): ReturnType<import("./sidebar-hub").SidebarHubDelegate["handleCommand"]> {
    if (command.type === "tabs.list") {
      const tabs = await this.#tabControllerFactory().listTabs();
      return { tabs: tabs.map((tab) => ({ id: tab.id!, title: tab.title ?? "", url: tab.url!, path: `/${this.#workspace.agentTabs.has(tab.id!) ? "agent-tabs" : "tabs"}/${tab.id}/page.md` })) };
    }
    if (command.type === "settings.save") {
      if (this.#activeRun) return;
      await this.handleSettingsRequest(command);
      return;
    }
    if (command.type === "context.export") {
      const conversation = await getConversation();
      const fence = (text: string) => {
        const delimiter = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
        return `${delimiter}\n${text}\n${delimiter}`;
      };
      return { filename: `bside-context-${new Date().toISOString().replace(/[:.]/g, "-")}.md`, markdown: [
        "# bside context export", `Exported: ${new Date().toISOString()}`, `Extension version: ${extensionVersion()}`,
        "## Latest run", "Model, timing, usage, and per-call results for the latest run in this background session.",
        this.#runRecord ? fence(JSON.stringify(this.#runRecord, null, 2)) : "No run recorded in this background session.",
        "## Latest model input", "This is the most recent request, not an exact live token count. It is held in memory only; after an extension restart only the saved conversation remains. It may include private page content. Credentials are not included.",
        this.#latestContext ? fence(this.#latestContext) : "No model input captured in this background session.",
        "## Full tool output — latest run", "Exact tool results, including bounded page snapshots and errors. Retained only until the next run, context reset, or extension restart. These are the snapshots exposed to the agent, not the entire page DOM.",
        this.#debugOutputTruncated ? "Earlier results were dropped to keep the debug buffer below 2 million characters." : "No tool results dropped from this run.",
        this.#debugOutputs.length ? fence(`[\n${this.#debugOutputs.join(",\n")}\n]`) : "No tool output captured in this run/session.",
        "## Conversation log", fence(JSON.stringify(conversation, null, 2)),
        "## Partial response", fence(this.#activeRun?.partialAssistantText ?? ""),
        "## Scratch files", fence(JSON.stringify(Object.fromEntries(this.#workspace.files), null, 2)),
      ].join("\n\n") };
    }
    if (command.type === "context.reset") {
      if (this.#activeRun || this.#resetting) return;
      this.#resetting = true;
      try {
        await resetConversation();
        this.#latestContext = null;
        this.#runRecord = null;
        this.#debugOutputs = [];
        this.#debugOutputChars = 0;
        this.#debugOutputTruncated = false;
        this.#workspace.files.clear();
        this.#sidebarHub.startRun();
        this.#notice = "Context reset. Conversation history and scratch files cleared; tabs and settings kept.";
        await this.#sidebarHub.broadcastSnapshot();
      } finally { this.#resetting = false; }
      return;
    }
    if (command.type === "run.start") {
      await this.#startRun(command.prompt);
      return;
    }
    if (command.type === "run.cancel") {
      this.#cancelRun(command.runId);
      return;
    }
    if (command.type === "action.approve") {
      this.#resolveApproval(command.runId, command.callId, true);
      return;
    }
    if (command.type === "action.deny") {
      this.#resolveApproval(command.runId, command.callId, false);
    }
  }

  async handleCredentialRequest(request: CredentialRequest): Promise<CredentialResponse> {
    try {
      let notice: string | null = null;
      if (request.type !== "credentials.openai.status") {
        if (this.#activeRun) throw new ProviderStreamError("Wait for the active run to finish before changing or testing credentials.", "INVALID_REQUEST");
        if (request.type === "credentials.openai.save") {
          await this.#provider.validateAuth({ providerId: "openai", method: "api-key", secret: request.apiKey }, new AbortController().signal);
          await saveOpenAICredential(request.apiKey);
        } else if (request.type === "credentials.openai.delete") await deleteStoredCredential();
        else if (request.type === "credentials.chatgpt.login") await this.#chatgpt.login(request.pin);
        else if (request.type === "credentials.chatgpt.unlock") await this.#chatgpt.unlock(request.pin);
        else if (request.type === "credentials.chatgpt.lock") await this.#chatgpt.lock();
        else if (request.type === "credentials.chatgpt.disconnect") {
          if (!await this.#chatgpt.disconnect()) notice = "Disconnected locally. Remote revocation was not confirmed; disconnect bside in ChatGPT settings to revoke access.";
        } else if (request.type === "credentials.chatgpt.test") {
          const signal = AbortSignal.timeout(120_000);
          const auth = await this.#chatgpt.getAuth(signal);
          const settings = await this.#getValidatedSettings();
          const model = this.#provider.getModel(settings.modelId);
          if (!model) throw new ProviderStreamError("The selected model is unavailable.", "INVALID_REQUEST");
          let completed = false;
          for await (const event of this.#provider.streamTurn({ model, reasoningEffort: settings.reasoningEffort,
            context: { messages: [{ role: "user", content: "Reply exactly: ChatGPT connection works.", timestamp: Date.now() }], tools: [] } }, auth, signal)) {
            if (event.type === "error") throw decodeProviderError(event.error.errorMessage);
            if (event.type === "done" && event.reason === "stop") completed = true;
          }
          if (!completed) throw new ProviderStreamError("ChatGPT did not complete the test response.", "PROVIDER_RESPONSE_FAILED");
          notice = "ChatGPT connection works. A streamed response completed using your subscription.";
        }
        await this.#sidebarHub.broadcastSnapshot();
      }
      return { v: 1, id: request.id, ok: true, ...await this.#getCredentialStatus(), notice };
    } catch (error) {
      return { v: 1, id: request.id, ok: false, error: toNormalizedError(error, "setup") };
    }
  }

  async #getCredentialStatus() {
    const [apiKey, chatgpt] = await Promise.all([getCredentialStatus(), this.#chatgpt.status()]);
    return { ...apiKey, chatgpt };
  }

  async #getProviderDefinition(): Promise<ProviderDefinition> {
    this.#modelCatalog = await this.#chatgpt.models() ?? OPENAI_PROVIDER.models;
    return { ...OPENAI_PROVIDER, models: this.#modelCatalog };
  }

  async handleSettingsRequest(request: SettingsRequest): Promise<SettingsResponse> {
    if (request.type === "settings.get") {
      const settings = await this.#getValidatedSettings();
      const notice = this.#notice;
      this.#notice = null;
      return { v: 1, id: request.id, ok: true, settings, provider: await this.#getProviderDefinition(), notice };
    }
    const provider = await this.#getProviderDefinition();
    const model = provider.models.find((model) => model.id === request.settings.modelId);
    if (this.#activeRun || !model || !model.reasoningEfforts.includes(request.settings.reasoningEffort))
      return { v: 1, id: request.id, ok: false, error: toNormalizedError(new ProviderStreamError("The model/reasoning selection is unavailable or a run is active.", "INVALID_REQUEST"), "setup") };
    await saveAppSettings(request.settings);
    await this.#sidebarHub.broadcastSnapshot();
    return { v: 1, id: request.id, ok: true, settings: request.settings, provider, notice: null };
  }

  /** Resets an invalid persisted model/effort combination once, surfacing a one-time notice. */
  async #getValidatedSettings(): Promise<AppSettingsV1> {
    const settings = await getAppSettings();
    const provider = await this.#getProviderDefinition();
    const model = provider.models.find((candidate) => candidate.id === settings.modelId);
    if (model && (model.reasoningEfforts as readonly string[]).includes(settings.reasoningEffort)) {
      return settings;
    }
    const defaultModel = provider.models.find((candidate) => candidate.id === DEFAULT_MODEL_ID) ?? provider.models[0]!;
    const fallback: AppSettingsV1 = {
      version: 1,
      providerId: "openai",
      modelId: defaultModel.id,
      reasoningEffort: defaultModel.defaultReasoningEffort,
    };
    await saveAppSettings(fallback);
    this.#notice = "Your saved model/reasoning combination was invalid, so settings were reset to defaults.";
    return fallback;
  }

  async #startRun(rawPrompt: string): Promise<void> {
    if (this.#activeRun || this.#resetting) {
      await this.#sidebarHub.broadcastSnapshot();
      return;
    }

    const prompt = validatePromptText(rawPrompt);
    if (!prompt) {
      this.#notice = "Message is empty or too long.";
      await this.#sidebarHub.broadcastSnapshot();
      return;
    }

    // Claim the run slot synchronously, before any `await`, so a second
    // `run.start` arriving before credential lookup resolves still sees an
    // active run and is dropped rather than racing into a second run.
    const runId = crypto.randomUUID();
    const controller = new AbortController();
    const tabController = this.#tabControllerFactory();
    const agentLoop = new AgentLoop(this.#provider, tabController, this.#sidebarHub, this.#workspace);
    this.#activeRun = {
      runId,
      controller,
      agentLoop,
      status: "running",
      partialAssistantText: "",
      pendingApproval: null,
      lastCheckpointAt: 0,
    };

    let auth: ProviderAuth;
    try {
      const chatgpt = await this.#chatgpt.status();
      const credential = chatgpt.connected ? null : await getOpenAICredential();
      if (!chatgpt.connected && !credential) throw new ProviderStreamError("Sign in with ChatGPT or add an OpenAI API key in settings before starting a conversation.", "AUTHENTICATION");
      auth = chatgpt.connected ? await this.#chatgpt.getAuth(controller.signal) : { providerId: "openai", method: "api-key", secret: credential!.apiKey };
    } catch (error) {
      this.#activeRun = null;
      this.#notice = toNormalizedError(error, "setup").message;
      await this.#sidebarHub.broadcastSnapshot();
      return;
    }

    this.#sidebarHub.startRun();

    this.#latestContext = null;
    this.#debugOutputs = [];
    this.#debugOutputChars = 0;
    this.#debugOutputTruncated = false;

    const captureOutcome = await tabController.captureActivePage();
    const artifact: ContextArtifact | null = captureOutcome.ok
      ? { ...captureOutcome.value.artifact, target: { kind: "tab", tabId: captureOutcome.value.snapshot.tabId }, snapshot: captureOutcome.value.snapshot }
      : null;

    const userItem: ConversationItem = {
      id: crypto.randomUUID(),
      kind: "message",
      role: "user",
      text: prompt,
      context: artifact ? { artifactId: artifact.artifactId, kind: "page", title: artifact.title, url: artifact.url, capturedAt: artifact.capturedAt } : null,
      at: Date.now(),
    };
    const conversation = await appendConversationItem(userItem);

    this.#sidebarHub.publishRunEvent(runId, "run.started", { prompt, page: userItem.kind === "message" ? userItem.context : null });
    await this.#writeCheckpoint(runId, "running", "");

    // Pi owns assistant/tool replay during this run. Persisted tool items are
    // display/audit records only, so a new run starts from message history.
    const transcript = conversation.items.filter((item) => item.kind === "message");
    await this.#runAgentLoop(runId, transcript, artifact, auth);
  }

  async #runAgentLoop(runId: string, transcript: ConversationItem[], artifact: ContextArtifact | null, auth: ProviderAuth): Promise<void> {
    const run = this.#activeRun;
    if (!run || run.runId !== runId) return;

    const settings = await this.#getValidatedSettings();
    const record: RunRecord = {
      runId, modelId: settings.modelId, reasoningEffort: settings.reasoningEffort, startedAt: Date.now(), endedAt: null, status: "running", error: null,
      providerResponses: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, toolCalls: [],
    };
    this.#runRecord = record;
    let coalesced = "";
    let lastFlush = Date.now();

    const flushDelta = () => {
      if (!coalesced) return;
      this.#sidebarHub.publishRunEvent(runId, "assistant.delta", { delta: coalesced });
      coalesced = "";
      lastFlush = Date.now();
    };

    const result = await run.agentLoop.run({
      runId,
      modelId: settings.modelId,
      reasoningEffort: settings.reasoningEffort,
      transcript,
      contextArtifact: artifact,
      auth,
      onContext: (context) => { this.#latestContext = context; },
      onUsage: (usage) => {
        record.providerResponses += 1;
        record.usage.input += usage.input;
        record.usage.output += usage.output;
        record.usage.cacheRead += usage.cacheRead;
        record.usage.cacheWrite += usage.cacheWrite;
        record.usage.totalTokens += usage.totalTokens;
        record.usage.cost += usage.cost.total;
      },
      onToolOutput: (call, result, timing) => {
        record.toolCalls.push({
          callId: call.id, name: call.name, startedAt: new Date(timing.startedAt).toISOString(), durationMs: timing.endedAt - timing.startedAt,
          ok: result.ok, code: result.code ?? null, outputChars: result.summary.length, truncatedOutput: result.summary.includes("[Output truncated:"),
        });
        const output = JSON.stringify({ call, result, timing: { startedAt: new Date(timing.startedAt).toISOString(), durationMs: timing.endedAt - timing.startedAt } }, null, 2);
        this.#debugOutputs.push(output);
        this.#debugOutputChars += output.length;
        while (this.#debugOutputChars > 2_000_000 && this.#debugOutputs.length) {
          this.#debugOutputChars -= this.#debugOutputs.shift()!.length;
          this.#debugOutputTruncated = true;
        }
      },
      signal: run.controller.signal,
      onDelta: (delta) => {
        if (this.#activeRun?.runId !== runId) return;
        run.partialAssistantText += delta;
        coalesced += delta;
        if (coalesced.length >= DELTA_COALESCE_BYTES || Date.now() - lastFlush >= DELTA_COALESCE_MS) flushDelta();
        void this.#maybeCheckpoint(runId, run);
      },
      onItem: async (item) => {
        await appendConversationItem(item);
        if (item.kind === "message" && item.role === "assistant") run.partialAssistantText = "";
        await this.#writeCheckpoint(runId, run.status, run.partialAssistantText);
      },
      onApprovalPending: (request) => {
        if (this.#activeRun?.runId !== runId) return;
        flushDelta();
        run.pendingApproval = request;
        run.status = request ? "awaiting-approval" : "running";
        void this.#sidebarHub.broadcastSnapshot();
      },
    });

    record.endedAt = Date.now();
    record.status = result.status;
    if (result.status === "failed") record.error = result.error;
    if (this.#activeRun?.runId !== runId) return;
    flushDelta();

    if (result.status === "completed") {
      const messageId = result.finalMessageId ?? (await this.#persistEmptyFinalMessage());
      this.#sidebarHub.publishRunEvent(runId, "run.completed", { messageId });
      await clearRunCheckpoint();
      this.#activeRun = null;
      return;
    }
    if (result.status === "cancelled") {
      const messageId = result.partialText ? await this.#persistCancelledMessage(result.partialText) : null;
      this.#sidebarHub.publishRunEvent(runId, "run.cancelled", { partialText: result.partialText, messageId });
      await clearRunCheckpoint();
      this.#activeRun = null;
      return;
    }
    // Retry is only ever safe to offer when this run touched no page state;
    // a provider-level retryable code (e.g. rate limit, network) must not
    // imply retry-safety once a consequential tool call has already
    // committed a real effect on the page.
    const error: NormalizedError = result.hadPageEffect ? { ...result.error, retryable: false } : result.error;
    this.#sidebarHub.publishRunEvent(runId, "run.failed", error);
    await clearRunCheckpoint();
    this.#activeRun = null;
  }

  /** Persists a cancelled run's uncommitted partial text so the interruption stays visible after reload; never fed back into a future provider request. */
  async #persistCancelledMessage(partialText: string): Promise<string> {
    const id = crypto.randomUUID();
    await appendConversationItem({ id, kind: "message", role: "assistant", text: `${partialText}${RUN_CANCELLED_SUFFIX}`, at: Date.now() });
    return id;
  }


  /** Rare: the model produced neither text nor a tool call. Persist an empty final message so `run.completed` always has a real id. */
  async #persistEmptyFinalMessage(): Promise<string> {
    const id = crypto.randomUUID();
    await appendConversationItem({ id, kind: "message", role: "assistant", text: "", at: Date.now() });
    return id;
  }
  async #maybeCheckpoint(runId: string, run: ActiveRun): Promise<void> {
    const now = Date.now();
    if (now - run.lastCheckpointAt < CHECKPOINT_MIN_INTERVAL_MS) return;
    run.lastCheckpointAt = now;
    await this.#writeCheckpoint(runId, run.status, run.partialAssistantText);
  }

  async #writeCheckpoint(runId: string, status: RunLifecycleStatus, partialAssistantText: string): Promise<void> {
    const checkpointStatus: RunStatus = status === "cancelling" ? "cancelled" : status;
    await saveRunCheckpoint({
      version: 1,
      runId,
      status: checkpointStatus,
      partialAssistantText,
      lastSeq: this.#sidebarHub.lastSeq(),
      updatedAt: Date.now(),
    });
  }

  #cancelRun(runId: string): void {
    if (!this.#activeRun || this.#activeRun.runId !== runId || this.#activeRun.status === "cancelling") return;
    this.#activeRun.status = "cancelling";
    this.#activeRun.controller.abort();
  }

  #resolveApproval(runId: string, callId: string, approved: boolean): void {
    if (!this.#activeRun || this.#activeRun.runId !== runId) return;
    if (this.#activeRun.pendingApproval?.call.id !== callId) return;
    if (approved) this.#activeRun.agentLoop.approve(callId);
    else this.#activeRun.agentLoop.deny(callId);
  }
}

function extensionVersion(): string {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return "unknown";
  }
}

function toNormalizedError(error: unknown, phase: NormalizedError["phase"]): NormalizedError {
  if (error instanceof ProviderStreamError) {
    return { code: error.code, message: error.message, retryable: error.retryable, phase, status: error.status, requestId: error.requestId };
  }
  const message = error instanceof Error ? error.message : "Unknown error.";
  return { code: "PROTOCOL_ERROR", message, retryable: false, phase };
}
