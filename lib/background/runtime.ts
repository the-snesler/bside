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
import type { ApprovalBadge } from "@/lib/background/approval-badge";
import { ChatGPTAuth } from "@/lib/background/chatgpt-auth";
import { WorkspaceState } from "@/lib/background/browser-program";
import type { SidebarHub } from "@/lib/background/sidebar-hub";
import { TabController } from "@/lib/background/tab-controller";
import type { AgentTabTagV1, TabControllerBrowserApi } from "@/lib/background/tab-controller";
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
import type { ConversationItem, ConversationRecordV1 } from "@/lib/domain/conversation";
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
/** Agent tabs no run has used for this long are closed. */
export const AGENT_TAB_IDLE_MS = 30 * 60_000;
const AGENT_TAB_SWEEP_MS = 60_000;

/** Time source for agent-tab idle tracking; background-page timers, since the MV2 page is persistent. */
export interface RuntimeClock {
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
}

const SYSTEM_CLOCK: RuntimeClock = { now: () => Date.now(), setInterval: (callback, ms) => setInterval(callback, ms) };

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
  #approvalBadge: ApprovalBadge | null;
  #activeRun: ActiveRun | null = null;
  #notice: string | null = null;
  #clock: RuntimeClock;
  #workspace: WorkspaceState;
  #latestContext: string | null = null;
  #resetting = false;
  /** Whether the last turn ended failed, cancelled, or interrupted, so `run.retry` may re-run it. */
  #lastTurnRetryable = false;
  /**
   * Whether that turn's last attempt committed a consequential page effect
   * (after an interruption: may have). Retrying it could repeat the effect,
   * so `run.retry` is refused.
   */
  #lastTurnHadPageEffect = false;
  #debugOutputs: string[] = [];
  #debugOutputChars = 0;
  #debugOutputTruncated = false;
  #runRecord: RunRecord | null = null;
  /** Settles once startup recovery/restoration finishes; every sidebar command waits on it. */
  #ready: Promise<void> = Promise.resolve();
  #agentTabSync: Promise<void> = Promise.resolve();
  #agentTabSyncQueued = false;
  /** Serialized tag last read from or written to each owned tab, so unchanged tags are not rewritten. */
  #agentTabTags = new Map<number, string>();
  #publishedAgentTabs = 0;

  constructor(
    sidebarHub: SidebarHub,
    options: { provider?: ProviderAdapter; chatgpt?: ChatGPTAuth; tabControllerFactory?: () => TabController; approvalBadge?: ApprovalBadge; clock?: RuntimeClock } = {},
  ) {
    this.#sidebarHub = sidebarHub;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#workspace = new WorkspaceState(() => this.#clock.now());
    this.#chatgpt = options.chatgpt ?? new ChatGPTAuth();
    this.#provider = options.provider ?? new OpenAIProvider(
      async (auth, signal) => auth.method === "chatgpt" ? this.#chatgpt.getAuth(signal) : auth,
      (id) => this.#modelCatalog.find((model) => model.id === id),
    );
    this.#tabControllerFactory = options.tabControllerFactory ?? (() => new TabController(browser as unknown as TabControllerBrowserApi));
    this.#approvalBadge = options.approvalBadge ?? null;
    this.#workspace.onOwnershipChange = () => void this.#queueAgentTabSync();
  }

  /** Runs once at background startup, before any Port connects. */
  async initialize(): Promise<void> {
    // An interrupted run can no longer be awaiting approval.
    this.#approvalBadge?.set(false);
    // Each step fails safe on its own: a failed recovery offers no retry, and a
    // failed restore leaves no agent tabs owned. Neither may cut the other short.
    this.#ready = Promise.allSettled([
      recoverInterruptedRun().then(async (recovered) => {
        if (!recovered) return;
        this.#lastTurnHadPageEffect = lastTurnRanProgram((await getConversation()).items);
        this.#lastTurnRetryable = true;
      }),
      this.#restoreAgentTabs(),
    ]).then(() => {});
    await this.#ready;
    this.#clock.setInterval(() => void this.#closeIdleAgentTabs(), AGENT_TAB_SWEEP_MS);
  }

  /**
   * Adopts a tagged tab that appears after startup: Firefox can restore a
   * session or a closed window at any time, not only before the background starts.
   */
  async handleTabCreated(tabId: number): Promise<void> {
    await this.#ready;
    if (this.#workspace.agentTabs.has(tabId)) return;
    const tabController = this.#tabControllerFactory();
    const tag = await tabController.agentTabTag(tabId).catch(() => null);
    // Untagged tabs, including bside's own tab before its tag is written, cost one read.
    if (!tag) return;
    const tab = (await tabController.allTabs()).find((candidate) => candidate.id === tabId);
    if (tab && (await this.#claimTaggedTab(tabController, tabId, tag, tab.hidden ?? false))) await this.#queueAgentTabSync();
  }

  /** Idle auto-close. Skipped entirely while a run is active, so a tab a run may be using is never closed under it. */
  async #closeIdleAgentTabs(): Promise<void> {
    if (this.#activeRun || this.#resetting) return;
    const cutoff = this.#clock.now() - AGENT_TAB_IDLE_MS;
    await this.#closeAgentTabs((lastUsedAt) => lastUsedAt <= cutoff);
  }

  /** Closes owned agent tabs matching `shouldClose`, stopping as soon as a run starts. */
  async #closeAgentTabs(shouldClose: (lastUsedAt: number) => boolean): Promise<void> {
    const tabController = this.#tabControllerFactory();
    for (const id of [...this.#workspace.agentTabs.keys()]) {
      // Re-read after every await: a run may have started or used the tab meanwhile.
      const lastUsedAt = this.#workspace.agentTabs.get(id);
      if (this.#activeRun) break;
      if (lastUsedAt === undefined || !shouldClose(lastUsedAt)) continue;
      try {
        await tabController.closeTab(id);
      } catch {
        // Already closed elsewhere; the sync below drops tabs that no longer exist.
        continue;
      }
      this.#workspace.observed.delete(id);
      this.#workspace.releaseTab(id);
    }
    await this.#queueAgentTabSync();
  }

  /**
   * Restores agent-tab ownership from session tags. Firefox reassigns tab IDs
   * after a browser restart but keeps each tab's session values, so only a
   * tagged tab is adopted, never one that merely has a former agent tab's ID or URL.
   * Nothing is dropped for being absent at startup: the tag stays with the tab,
   * and a tab session restore creates later is adopted by `handleTabCreated`.
   */
  async #restoreAgentTabs(): Promise<void> {
    const tabController = this.#tabControllerFactory();
    await Promise.all((await tabController.allTabs()).map(async (tab) => {
      const tag = await tabController.agentTabTag(tab.id!).catch(() => null);
      if (tag) await this.#claimTaggedTab(tabController, tab.id!, tag, tab.hidden ?? false);
    }));
    await this.#queueAgentTabSync();
  }

  /**
   * Adopts a tagged hidden tab. A tagged tab that is visible is released and
   * untagged instead of re-hidden: the user can see it and may be using it
   * (they selected it from the tab list, or Firefox showed it while bside was
   * disabled). Firefox applies a restored tab's hidden state and session values
   * in the same restore step, so a visible tag is not a tab still being restored.
   * Returns whether the tab was adopted.
   */
  async #claimTaggedTab(tabController: TabController, tabId: number, tag: AgentTabTagV1, hidden: boolean): Promise<boolean> {
    if (this.#workspace.agentTabs.has(tabId)) return false;
    if (!hidden) {
      await tabController.untagAgentTab(tabId).catch(() => {});
      return false;
    }
    this.#workspace.agentTabs.set(tabId, tag.lastUsedAt);
    this.#agentTabTags.set(tabId, JSON.stringify(tag));
    if (tag.role === "search" && this.#workspace.searchTabId === null) this.#workspace.searchTabId = tabId;
    return true;
  }

  /** Serializes agent-tab writes; changes made while a write is queued share it. */
  #queueAgentTabSync(): Promise<void> {
    if (this.#agentTabSyncQueued) return this.#agentTabSync;
    this.#agentTabSyncQueued = true;
    this.#agentTabSync = this.#agentTabSync
      .then(() => { this.#agentTabSyncQueued = false; return this.#syncAgentTabs(); })
      // A failed write is retried by the next ownership change.
      .catch(() => {});
    return this.#agentTabSync;
  }

  /** Writes agent-tab ownership to session tags, dropping tabs that were closed outside bside. */
  async #syncAgentTabs(): Promise<void> {
    // A tab adopted while the list is being read is missing from it but not
    // closed; adoption queued another sync that will see it.
    const listed = new Set(this.#workspace.agentTabs.keys());
    const tabController = this.#tabControllerFactory();
    const open = new Set((await tabController.allTabs()).map((tab) => tab.id!));
    for (const id of listed) if (!open.has(id)) this.#workspace.agentTabs.delete(id);
    if (this.#workspace.searchTabId !== null && !this.#workspace.agentTabs.has(this.#workspace.searchTabId)) this.#workspace.searchTabId = null;
    const writes: Promise<void>[] = [];
    for (const id of this.#agentTabTags.keys()) {
      if (this.#workspace.agentTabs.has(id)) continue;
      // A closed tab took its tag with it; a released one that is still open becomes an ordinary tab.
      if (!open.has(id)) this.#agentTabTags.delete(id);
      else writes.push(tabController.untagAgentTab(id).then(() => { this.#agentTabTags.delete(id); }));
    }
    for (const [id, lastUsedAt] of this.#workspace.agentTabs) {
      if (!open.has(id)) continue;
      const tag: AgentTabTagV1 = { v: 1, role: id === this.#workspace.searchTabId ? "search" : "agent", lastUsedAt };
      const serialized = JSON.stringify(tag);
      if (this.#agentTabTags.get(id) === serialized) continue;
      writes.push(tabController.tagAgentTab(id, tag).then(() => { this.#agentTabTags.set(id, serialized); }));
    }
    // A failed write leaves its cached tag stale, so the next sync retries it.
    await Promise.allSettled(writes);
    if (this.#workspace.agentTabs.size !== this.#publishedAgentTabs) {
      this.#publishedAgentTabs = this.#workspace.agentTabs.size;
      this.#sidebarHub.publishAgentTabs(this.#publishedAgentTabs);
    }
  }

  async getSnapshot(): Promise<RuntimeSnapshot> {
    await this.#ready;
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
      agentTabs: this.#workspace.agentTabs.size,
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
    await this.#ready;
    if (command.type === "tabs.list") {
      const tabs = await this.#tabControllerFactory().listTabs();
      return { tabs: tabs.map((tab) => ({ id: tab.id!, title: tab.title ?? "", url: tab.url!, path: `/${this.#workspace.agentTabs.has(tab.id!) ? "agent-tabs" : "tabs"}/${tab.id}/page.md` })) };
    }
    if (command.type === "tabs.focus") {
      // Agent tabs are hidden workspace tabs; activating one would unhide it.
      if (!this.#workspace.agentTabs.has(command.tabId)) await this.#tabControllerFactory().focusTab(command.tabId);
      return;
    }
    if (command.type === "tabs.closeAgentTabs") {
      // Refused rather than deferred while a run is active: the run may be using
      // these tabs, and a deferred close would fire after the user moved on.
      if (this.#activeRun || this.#resetting) return;
      await this.#closeAgentTabs(() => true);
      return;
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
        this.#lastTurnRetryable = false;
        this.#lastTurnHadPageEffect = false;
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
    if (command.type === "run.retry") {
      await this.#startRun(null);
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

  /** A `null` prompt is a retry: it re-runs the last turn's existing user message instead of appending a new one. */
  async #startRun(rawPrompt: string | null): Promise<void> {
    const retry = rawPrompt === null;
    if (this.#activeRun || this.#resetting || (retry && !this.#lastTurnRetryable)) {
      await this.#sidebarHub.broadcastSnapshot();
      return;
    }
    if (retry && this.#lastTurnHadPageEffect) {
      this.#notice = "The last attempt already changed a page, so retrying it could repeat that change. Send a new message to continue.";
      await this.#sidebarHub.broadcastSnapshot();
      return;
    }

    const prompt = retry ? null : validatePromptText(rawPrompt);
    if (!retry && !prompt) {
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
    let retryConversation: ConversationRecordV1 | null = null;
    try {
      const chatgpt = await this.#chatgpt.status();
      const credential = chatgpt.connected ? null : await getOpenAICredential();
      if (!chatgpt.connected && !credential) throw new ProviderStreamError("Sign in with ChatGPT or add an OpenAI API key in settings before starting a conversation.", "AUTHENTICATION");
      auth = chatgpt.connected ? await this.#chatgpt.getAuth(controller.signal) : { providerId: "openai", method: "api-key", secret: credential!.apiKey };
      if (retry) {
        retryConversation = await getConversation();
        if (!retryConversation.items.some(isUserMessage)) throw new ProviderStreamError("There is no turn to retry.", "INVALID_REQUEST");
      }
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

    const conversation = retryConversation ?? await appendConversationItem({
      id: crypto.randomUUID(),
      kind: "message",
      role: "user",
      text: prompt!,
      context: artifact ? { artifactId: artifact.artifactId, kind: "page", title: artifact.title, url: artifact.url, capturedAt: artifact.capturedAt } : null,
      at: Date.now(),
    });
    const userIndex = conversation.items.findLastIndex(isUserMessage);
    const userItem = conversation.items[userIndex] as UserMessage;
    this.#lastTurnRetryable = false;
    this.#lastTurnHadPageEffect = false;

    this.#sidebarHub.publishRunEvent(runId, "run.started", { prompt: userItem.text, page: userItem.context, retry });
    await this.#writeCheckpoint(runId, "running", "");

    // Pi owns assistant/tool replay during this run. Persisted tool items are
    // display/audit records only, so a new run starts from message history.
    // History ends at this turn's user message: on a retry, the failed
    // attempt's interim/partial assistant text stays visible but is not sent,
    // so the model answers the original prompt afresh against a new page
    // capture. Its page effects are never replayed.
    const transcript = conversation.items.slice(0, userIndex + 1).filter((item) => item.kind === "message");
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

    const runStartedAt = this.#clock.now();
    const result = await run.agentLoop.run({
      runId,
      conversationId: "default",
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
        this.#approvalBadge?.set(request !== null);
        void this.#sidebarHub.broadcastSnapshot();
      },
    });

    this.#keepRunTabsAlive(runStartedAt);
    record.endedAt = Date.now();
    record.status = result.status;
    if (result.status === "failed") record.error = result.error;
    if (this.#activeRun?.runId !== runId) return;
    flushDelta();
    this.#approvalBadge?.set(false);

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
      this.#lastTurnRetryable = true;
      this.#lastTurnHadPageEffect = result.hadPageEffect;
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
    this.#lastTurnRetryable = true;
    this.#lastTurnHadPageEffect = result.hadPageEffect;
    this.#activeRun = null;
  }

  /** Restarts the idle period of every agent tab used since `since`, so tabs a long run used are not closed right after it ends. */
  #keepRunTabsAlive(since: number): void {
    const now = this.#clock.now();
    let touched = false;
    for (const [id, lastUsedAt] of this.#workspace.agentTabs) {
      if (lastUsedAt < since) continue;
      this.#workspace.agentTabs.set(id, now);
      touched = true;
    }
    if (touched) void this.#queueAgentTabSync();
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

type UserMessage = Extract<ConversationItem, { kind: "message"; role: "user" }>;

function isUserMessage(item: ConversationItem): item is UserMessage {
  return item.kind === "message" && item.role === "user";
}

/**
 * Whether the last turn started a browser program. Run checkpoints record no
 * effects, so after an interruption any started program may have committed one.
 */
function lastTurnRanProgram(items: readonly ConversationItem[]): boolean {
  return items.slice(items.findLastIndex(isUserMessage) + 1).some((item) => item.kind === "tool-call" && item.call.name === "browser_program");
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
