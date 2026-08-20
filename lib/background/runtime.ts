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
import type { SidebarHub } from "@/lib/background/sidebar-hub";
import { TabController } from "@/lib/background/tab-controller";
import type { TabControllerBrowserApi } from "@/lib/background/tab-controller";
import { OpenAIProvider, ProviderStreamError } from "@/lib/providers/openai";
import { OPENAI_PROVIDER, DEFAULT_MODEL_ID, DEFAULT_REASONING_EFFORT } from "@/lib/providers/openai-models";
import {
  appendConversationItem,
  clearRunCheckpoint,
  getAppSettings,
  getConversation,
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
import type { AppSettingsV1, ProviderAdapter, ProviderAuth } from "@/lib/domain/provider";
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

const CHECKPOINT_MIN_INTERVAL_MS = 1_000;
const DELTA_COALESCE_MS = 16;
const DELTA_COALESCE_BYTES = 1024;

type RunLifecycleStatus = "running" | "awaiting-approval" | "cancelling";

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
  #tabControllerFactory: () => TabController;
  #activeRun: ActiveRun | null = null;
  #notice: string | null = null;

  constructor(
    sidebarHub: SidebarHub,
    options: { provider?: ProviderAdapter; tabControllerFactory?: () => TabController } = {},
  ) {
    this.#sidebarHub = sidebarHub;
    this.#provider = options.provider ?? new OpenAIProvider();
    this.#tabControllerFactory = options.tabControllerFactory ?? (() => new TabController(browser as unknown as TabControllerBrowserApi));
  }

  /** Runs once at background startup, before any Port connects. */
  async initialize(): Promise<void> {
    await recoverInterruptedRun();
  }

  async getSnapshot(): Promise<RuntimeSnapshot> {
    const [conversation, credential, settings] = await Promise.all([
      getConversation(),
      getCredentialStatus(),
      this.#getValidatedSettings(),
    ]);
    const notice = this.#notice;
    this.#notice = null;
    return {
      conversation,
      credential,
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

  async handleCommand(command: SidebarCommand): Promise<void> {
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
    if (request.type === "credentials.openai.status") {
      const status = await getCredentialStatus();
      return { v: 1, id: request.id, ok: true, ...status };
    }
    if (request.type === "credentials.openai.delete") {
      await deleteStoredCredential();
      return { v: 1, id: request.id, ok: true, configured: false, maskedSuffix: null };
    }

    // credentials.openai.save: validate through the provider before ever replacing the prior key.
    const auth: ProviderAuth = { providerId: "openai", method: "api-key", secret: request.apiKey };
    try {
      await this.#provider.validateAuth(auth, new AbortController().signal);
    } catch (error) {
      return { v: 1, id: request.id, ok: false, error: toNormalizedError(error, "setup") };
    }
    await saveOpenAICredential(request.apiKey);
    const status = await getCredentialStatus();
    return { v: 1, id: request.id, ok: true, ...status };
  }

  async handleSettingsRequest(request: SettingsRequest): Promise<SettingsResponse> {
    if (request.type === "settings.get") {
      const settings = await this.#getValidatedSettings();
      const notice = this.#notice;
      this.#notice = null;
      return { v: 1, id: request.id, ok: true, settings, provider: OPENAI_PROVIDER, notice };
    }
    await saveAppSettings(request.settings);
    return { v: 1, id: request.id, ok: true, settings: request.settings, provider: OPENAI_PROVIDER, notice: null };
  }

  /** Resets an invalid persisted model/effort combination once, surfacing a one-time notice. */
  async #getValidatedSettings(): Promise<AppSettingsV1> {
    const settings = await getAppSettings();
    const model = OPENAI_PROVIDER.models.find((candidate) => candidate.id === settings.modelId);
    if (model && (model.reasoningEfforts as readonly string[]).includes(settings.reasoningEffort)) {
      return settings;
    }
    const fallback: AppSettingsV1 = {
      version: 1,
      providerId: "openai",
      modelId: DEFAULT_MODEL_ID,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
    };
    await saveAppSettings(fallback);
    this.#notice = "Your saved model/reasoning combination was invalid, so settings were reset to defaults.";
    return fallback;
  }

  async #startRun(rawPrompt: string): Promise<void> {
    if (this.#activeRun) {
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
    const agentLoop = new AgentLoop(this.#provider, tabController, this.#sidebarHub);
    this.#activeRun = {
      runId,
      controller,
      agentLoop,
      status: "running",
      partialAssistantText: "",
      pendingApproval: null,
      lastCheckpointAt: 0,
    };

    const credential = await getOpenAICredential();
    if (!credential) {
      this.#activeRun = null;
      this.#notice = "Add an OpenAI API key in settings before starting a conversation.";
      await this.#sidebarHub.broadcastSnapshot();
      return;
    }

    this.#sidebarHub.startRun();

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

    await this.#runAgentLoop(runId, conversation.items, artifact, credential.apiKey);
  }

  async #runAgentLoop(runId: string, transcript: ConversationItem[], artifact: ContextArtifact | null, apiKey: string): Promise<void> {
    const run = this.#activeRun;
    if (!run || run.runId !== runId) return;

    const settings = await this.#getValidatedSettings();
    const auth: ProviderAuth = { providerId: "openai", method: "api-key", secret: apiKey };
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
      this.#sidebarHub.publishRunEvent(runId, "run.cancelled", { partialText: result.partialText });
      await clearRunCheckpoint();
      this.#activeRun = null;
      return;
    }
    this.#sidebarHub.publishRunEvent(runId, "run.failed", result.error);
    await clearRunCheckpoint();
    this.#activeRun = null;
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

function toNormalizedError(error: unknown, phase: NormalizedError["phase"]): NormalizedError {
  if (error instanceof ProviderStreamError) {
    return { code: error.code, message: error.message, retryable: error.retryable, phase, status: error.status, requestId: error.requestId };
  }
  const message = error instanceof Error ? error.message : "Unknown error.";
  return { code: "PROTOCOL_ERROR", message, retryable: false, phase };
}
