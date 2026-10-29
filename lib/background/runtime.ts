/**
 * BackgroundRuntime tracks the open session, owns each active run's
 * AbortController (a run may belong to a session other than the open one),
 * and is the only place that calls the provider or writes
 * conversation/checkpoint storage. Sidebar and options pages never
 * own an inference request, tool loop, transcript authority, or credential
 * read — they only ever see what this file publishes through SidebarHub.
 *
 * Per-round provider/tool orchestration is delegated to `AgentLoop`; this
 * file owns run lifecycle (the run registry, at most one run per session,
 * checkpointing, persistence) and everything outside a run (credentials, settings).
 */

import { PreparedMcpContent, type ContentAcceptance } from "@/lib/background/mcp-content";
import { hasPreparedMcpPrompt, type McpContentSnapshot } from "@/lib/domain/mcp-content";
import { McpError, toNormalizedMcpError } from "@/lib/mcp/errors";
import { AGENT_TOOL_NAMES, AgentLoop } from "@/lib/background/agent-loop";
import { getSkills, sidebarSkillCatalog } from "@/lib/background/skills";
import { captureInvokedSkill } from "@/lib/background/skill-context";
import { isAskContext, type AskContextV1 } from "@/lib/domain/ask";
import { skillCatalog, type Skill, type SkillSummary } from "@/lib/domain/skills";
import { readInstructions, saveSiteNoteFromSidebar } from "@/lib/background/instructions";
import { readMemoryIndex, runMemory, undoMemoryChanges } from "@/lib/background/memory";
import { matchSiteNotes, pageOrigin, siteNoteForPage, type SiteNote } from "@/lib/domain/instructions";
import type { ApprovalBadge } from "@/lib/background/approval-badge";
import { TaskScheduler, type RecordTaskStart, type SchedulerAlarms, type TaskDispatch } from "@/lib/background/scheduler";
import type { ScheduledSource, ScheduledTask } from "@/lib/domain/automation";
import { DEFAULT_PERMISSION_SETTINGS, type PermissionMode } from "@/lib/domain/permissions";
import type { RunNotifications } from "@/lib/background/notifications";
import type { McpConnections } from "@/lib/background/mcp";
import type { McpToolDefinition } from "@/lib/mcp/tools";
import { ChatGPTAuth } from "@/lib/background/chatgpt-auth";
import { ScratchFiles, WorkspaceState } from "@/lib/background/browser-program";
import type { AgentTab } from "@/lib/background/browser-program";
import type { SidebarHub } from "@/lib/background/sidebar-hub";
import { FrameAliases, TabController, VisibilityLock } from "@/lib/background/tab-controller";
import { PdfReader, workerPdfExtractor } from "@/lib/background/pdf";
import { browserSiteEnv } from "@/lib/sites";
import type { SiteEnv } from "@/lib/sites/site-api";
import type { AgentTabTagV1, AgentTabTagV2, TabControllerBrowserApi, TabSnapshot } from "@/lib/background/tab-controller";
import { decodeProviderError, describeModels, OPENAI_API_KEY_PROVIDER, OpenAIProvider, ProviderStreamError } from "@/lib/providers/openai";
import { DEFAULT_MODEL_ID } from "@/lib/providers/openai-models";
import {
  appendConversationItem,
  clearRunCheckpoint,
  createSession,
  deleteAllSessions,
  deleteSession,
  ensureOpenSession,
  getAppSettings,
  getConversation,
  getHistorySettings,
  getPermissionSettings,
  savePermissionSettings,
  getNotificationSettings,
  saveNotificationSettings,
  isSessionUntouched,
  loadMessageQueue,
  loadWorkspaceFiles,
  saveMessageQueue,
  workspaceStore,
  listSessions,
  migrateConversation,
  pruneSessions,
  saveHistorySettings,
  setOpenSessionId,
  touchSession,
  updateSession,
  getCredentialStatus,
  getOpenAICredential,
  migrateCredentials,
  clearChatGPTSignInNotice,
  recoverInterruptedRuns,
  saveAppSettings,
  saveOpenAICredential,
  saveRunCheckpoint,
  deleteOpenAICredential as deleteStoredCredential,
} from "@/lib/storage";
import type { RunStatus } from "@/lib/storage";
import { validatePromptText, validateSessionTitle, VIEWABLE_IMAGE_TYPES } from "@/lib/validation";
import type { ContextArtifact } from "@/lib/domain/tools";
import type { Conversation, ConversationItem, ConversationSummary, QueuedMessage, UserMessageItem } from "@/lib/domain/conversation";
import { isTurnStart, MAX_QUEUED_MESSAGES, PROMPT_MENTION_PATTERN, retentionCutoff } from "@/lib/domain/conversation";
import { buildRunDigest } from "@/lib/domain/run-digest";
import { buildProblemReport } from "@/lib/domain/problem-report";
import { hasTokens, newRunUsage, type RunUsageV1 } from "@/lib/domain/usage";
import type { AppSettingsV1, ModelDefinition, ProviderAdapter, ProviderAuth, ProviderDefinition } from "@/lib/domain/provider";
import type {
  AgentTabsState,
  AutomationRequest,
  AutomationResponse,
  AgentTabSummary,
  ApprovalRequest,
  ContentMessage,
  ContentMessageResponse,
  CredentialRequest,
  CredentialResponse,
  HelpOutcome,
  HelpRequest,
  HistoryRequest,
  HistoryResponse,
  ProblemReportRequest,
  ProblemReportResponse,
  NormalizedError,
  PageShieldState,
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
const MAX_TAB_TITLE_CHARS = 300;
/** Larger icons are left out of sidebar events; the sidebar shows a letter instead. */
const MAX_FAVICON_CHARS = 16_384;
/** History retention is enforced at startup, when it changes, and on the first sweep after this long. */
const RETENTION_SWEEP_MS = 60 * 60_000;

/** Time source for agent-tab idle tracking; background-page timers, since the MV2 page is persistent. */
export interface RuntimeClock {
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval?(timer: unknown): void;
}

const SYSTEM_CLOCK: RuntimeClock = { now: () => Date.now(), setInterval: (callback, ms) => setInterval(callback, ms), clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>) };

type RunLifecycleStatus = "running" | "awaiting-approval" | "awaiting-help" | "cancelling";

/** The user's instructions and site notes, the memory index, and connected accounts' tools, snapshotted when a run starts. */
interface Personalization {
  instructions: string;
  siteNotes: SiteNote[];
  memoryIndex: string | null;
  mcpTools: McpToolDefinition[];
}

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

/** One run's export diagnostics: its record, latest model input, and tool output. In memory only. */
interface RunDiagnostics {
  /** Set once the run reaches its agent loop; until then the run has nothing to export. */
  record: RunRecord | null;
  latestContext: string | null;
  outputs: string[];
  outputChars: number;
  outputTruncated: boolean;
}

/** Sessions whose latest run's diagnostics are kept for export, least recently run dropped first. */
const MAX_DIAGNOSTIC_SESSIONS = 8;
/** Tool output kept per run for export; older results are dropped first. */
const MAX_DEBUG_OUTPUT_CHARS = 2_000_000;

interface ActiveRun {
  runId: string;
  /** The session the run started in; every item it produces is appended there. */
  sessionId: string;
  scheduled?: ScheduledSource;
  controller: AbortController;
  agentLoop: AgentLoop;
  status: RunLifecycleStatus;
  partialAssistantText: string;
  pendingApproval: ApprovalRequest | null;
  pendingHelp: HelpRequest | null;
  /** The run's agent tabs the user took over since the run's last browser program; its next result says so. */
  takeovers: Set<number>;
  /** Published and checkpointed once a provider response reports tokens. */
  usage: RunUsageV1 | null;
  lastCheckpointAt: number;
  diagnostics: RunDiagnostics;
  /** When the slot was claimed; the duration of a run that ended before its agent loop counts from here. */
  claimedAt: number;
  /** The sidebar hub's run buffer was started for this run, so a terminal event must follow. */
  announced: boolean;
  /** The turn's user message is persisted (a retry's already was), so the run's digest and usage belong after it. */
  turnPersisted: boolean;
  /** The terminal event that was (or is being) published; set once, before publishing. */
  outcome: "completed" | "cancelled" | "failed" | null;
  /** Set when `#endRun` starts: the run writes no more checkpoints, and it ends only once. */
  ended: boolean;
}

interface AskAcceptance {
  ask: AskContextV1;
  commit(): void;
  release(): void;
}

export class BackgroundRuntime {
  #sidebarHub: SidebarHub;
  #provider: ProviderAdapter;
  #chatgpt: ChatGPTAuth;
  #modelCatalog: readonly ModelDefinition[] = OPENAI_API_KEY_PROVIDER.models;
  #tabControllerFactory: () => TabController;
  #sites: SiteEnv;
  #approvalBadge: ApprovalBadge | null;
  /** Connected accounts' tools; none when absent. */
  #mcp: McpConnections | null;
  #scheduler: TaskScheduler;
  /** Results sessions a scheduled launch is preparing to start a run in; no other run starts there meanwhile. */
  #scheduledStarting = new Set<string>();
  #notifications: RunNotifications | null;
  #sweepTimer: unknown;
  #disposed = false;
  #queueOps: Promise<unknown> = Promise.resolve();
  /** Follow-ups claimed for a run that is starting, by message id, with their session. */
  #queueClaims = new Map<string, string>();
  #preparedContent = new PreparedMcpContent();

  releaseContentOwner(owner: object): void { this.#preparedContent.releaseOwner(owner); }

  /**
   * Active runs by run id: at most one per session, any number of sessions
   * at once. Look runs up through `#runFor` (a session's run), `#run` (one
   * run by id), and `#anyRun`/`#runs` (any or every run).
   */
  #runs = new Map<string, ActiveRun>();
  #notice: string | null = null;
  #clock: RuntimeClock;
  #workspace: WorkspaceState;
  /** Cached `local:openConversation`; resolved lazily so every path sees a real session. */
  #openSessionId: string | null = null;
  #sessionOps: Promise<void> = Promise.resolve();
  /**
   * Sessions a pending session command may switch away from or delete, with
   * how many commands hold each; `"*"` holds every session ("Delete all
   * history"). No sidebar run or follow-up starts in a held session.
   */
  #heldSessions = new Map<string, number>();
  #lastRetentionAt = -Infinity;
  /**
   * Sessions whose last turn ended failed, cancelled, or interrupted, so
   * `run.retry` may re-run it while the session is open. `hadPageEffect`:
   * that attempt committed a consequential page effect (after an
   * interruption: may have), so retrying could repeat it and is refused.
   * A run starting in a session clears only that session's entry.
   */
  #retryable = new Map<string, { hadPageEffect: boolean }>();
  /**
   * Each session's latest run's diagnostics for `context.export` and problem
   * reports, from the moment that run reaches its agent loop (so a running
   * run's are live). Bounded to `MAX_DIAGNOSTIC_SESSIONS`; in memory only.
   */
  #diagnostics = new Map<string, RunDiagnostics>();
  /** Settles once startup recovery/restoration finishes; every sidebar command waits on it. */
  #ready: Promise<void> = Promise.resolve();
  /** The permission mode beside the composer, cached so a run reads it synchronously at each gated call. */
  #permissionMode: PermissionMode = DEFAULT_PERMISSION_SETTINGS.mode;
  #agentTabSync: Promise<void> = Promise.resolve();
  #agentTabSyncQueued = false;
  /** Serialized tag last read from or written to each owned tab, so unchanged tags are not rewritten. */
  #agentTabTags = new Map<number, string>();
  /** Agent tabs as last published to sidebars. */
  #agentTabsState: AgentTabsState = { bySession: {}, watching: null, takenOver: false };
  #publishedAgentTabs = JSON.stringify(this.#agentTabsState);
  /**
   * The agent tab the user is watching, shown and active, and the tab they
   * watched from. `takenOver`: the user pressed "Take over", which removes the
   * page shield until watching ends. In memory only: after a restart a visible
   * tagged tab is released to the user like any other.
   */
  #watching: { tabId: number; returnTabId: number | null; takenOver: boolean } | null = null;
  /** The page shield state last sent to a tab's content script. */
  #shieldSent: { tabId: number; shield: PageShieldState } | null = null;
  /** Each session's message queue once loaded; this cache is authoritative and written through to storage. */
  #queues = new Map<string, QueuedMessage[]>();
  /** The last menu gesture, held only in the background until sent or removed. */
  #ask: AskContextV1 | null = null;
  /** An in-flight send reserves its snapshot without removing the visible chip. */
  #askClaims = new Set<string>();

  setAsk(ask: AskContextV1): void {
    if (!isAskContext(ask) || ask.path !== null) return;
    this.#ask = structuredClone(ask);
    this.#sidebarHub.publishAsk(this.#ask);
    this.#sidebarHub.focusComposer();
  }

  updateAskAlt(id: string, alt: string | null): void {
    if (this.#ask?.id !== id || this.#ask.kind !== "image" || !alt) return;
    const next = { ...this.#ask, alt };
    if (!isAskContext(next)) return;
    this.#ask = next;
    this.#sidebarHub.publishAsk(next);
  }

  #claimAsk(id: string): AskAcceptance {
    if (this.#ask?.id !== id || this.#askClaims.has(id)) throw new McpError("PROTOCOL", "That page context is no longer available or is already being sent. Review the current chip before sending again.");
    const ask = { ...this.#ask };
    this.#askClaims.add(id);
    return {
      ask,
      commit: () => {
        this.#askClaims.delete(id);
        // A newer menu gesture or an explicit dismissal wins over this send.
        if (this.#ask?.id !== id) return;
        this.#ask = null;
        this.#sidebarHub.publishAsk(null);
      },
      release: () => { this.#askClaims.delete(id); },
    };
  }

  #snapshotAsk(selection: AskAcceptance | undefined, sessionId: string): AskContextV1 | undefined {
    if (!selection) return undefined;
    const ask = selection.ask;
    const owner = this.#workspace.agentTabs.get(ask.tabId)?.sessionId;
    const path = owner && owner !== sessionId ? null : `/${owner ? "agent-tabs" : "tabs"}/${ask.tabId}/page.md`;
    return { ...ask, path };
  }

  #askIsCurrent(id: string | undefined): boolean {
    if (!id || this.#ask?.id === id) return true;
    this.#notice = "That page context was replaced or removed. Review the current chip before sending again.";
    void this.#sidebarHub.broadcastSnapshot();
    return false;
  }

  constructor(
    sidebarHub: SidebarHub,
    options: { provider?: ProviderAdapter; chatgpt?: ChatGPTAuth; tabControllerFactory?: () => TabController; sites?: SiteEnv; approvalBadge?: ApprovalBadge; clock?: RuntimeClock; mcp?: McpConnections; alarms?: SchedulerAlarms; notifications?: RunNotifications; workspace?: WorkspaceState } = {},
  ) {
    this.#sidebarHub = sidebarHub;
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#workspace = options.workspace ?? new WorkspaceState(() => this.#clock.now());
    this.#chatgpt = options.chatgpt ?? new ChatGPTAuth();
    this.#provider = options.provider ?? new OpenAIProvider(
      async (auth, signal) => auth.method === "chatgpt" ? this.#chatgpt.getAuth(signal) : auth,
      (id) => this.#modelCatalog.find((model) => model.id === id),
    );
    // One set of frame names for the background's lifetime, so `f3:e12` names the same frame in every run,
    // and one PDF reader, so a PDF is parsed once (in the bundled pdf-text worker, never in this page).
    const frameAliases = new FrameAliases();
    const pdfs = new PdfReader(workerPdfExtractor(() => new Worker(browser.runtime.getURL("/pdf-text.js"))));
    const visibility = new VisibilityLock();
    this.#tabControllerFactory = options.tabControllerFactory ?? (() => new TabController(browser as unknown as TabControllerBrowserApi, undefined, frameAliases, pdfs, visibility));
    this.#sites = options.sites ?? browserSiteEnv();
    this.#approvalBadge = options.approvalBadge ?? null;
    this.#mcp = options.mcp ?? null;
    this.#notifications = options.notifications ?? null;
    this.#scheduler = new TaskScheduler({ alarms: options.alarms, now: () => this.#clock.now(),
      dispatch: (task, at, recordStart) => this.#launchScheduled(task, at, recordStart), liveSessions: async () => (await listSessions()).map((s) => s.id) });
    this.#workspace.onOwnershipChange = () => void this.#queueAgentTabSync();
  }

  /** Runs once at background startup, before any Port connects. */
  async initialize(): Promise<void> {
    // An interrupted run can no longer be awaiting approval or help.
    this.#approvalBadge?.clearAll();
    // Each step fails safe on its own: a failed migration retries next startup,
    // a failed recovery offers no retry, and a failed restore leaves no agent
    // tabs owned. None may cut another short. Recovery runs after the
    // conversation migration, since a pre-sessions checkpoint recovers into it.
    // Retention runs after agent-tab restoration, since it closes the tabs of
    // the sessions it deletes.
    const restored = this.#restoreAgentTabs();
    this.#ready = Promise.allSettled([
      migrateCredentials(),
      getPermissionSettings().then((settings) => { this.#permissionMode = settings.mode; }),
      migrateConversation()
        .catch(() => console.warn("[bside] Could not migrate the saved conversation; will retry at next startup."))
        .then(() => recoverInterruptedRuns())
        .then(async (recovered) => {
          // Each interrupted run's session may retry its turn, unless that attempt may have committed an effect.
          for (const { sessionId } of recovered) {
            const items = await getConversation(sessionId).then((conversation) => conversation?.items ?? []).catch(() => null);
            if (items) this.#retryable.set(sessionId, { hadPageEffect: lastTurnMayHaveCommitted(items) });
          }
        })
        .finally(() => this.#openSession())
        .finally(() => restored.catch(() => {}))
        .then(() => this.#applyRetention()),
      restored,
    ]).then(async () => {
      await this.#scheduler.initialize();
      await this.#syncScheduleBadge();
      await this.#notifications?.initialize();
      await this.#notifications?.setEnabled((await getNotificationSettings()).enabled);
    }).catch(() => {
      console.warn("[bside] Could not restore scheduled tasks; no missed runs will be started.");
    });
    await this.#ready;
    if (this.#disposed) return;
    this.#sweepTimer = this.#clock.setInterval(() => {
      void this.#closeIdleAgentTabs();
      if (this.#clock.now() - this.#lastRetentionAt >= RETENTION_SWEEP_MS) void this.#applyRetention().catch(() => {});
    }, AGENT_TAB_SWEEP_MS);
  }

  dispose(): void {
    this.#disposed = true;
    for (const run of this.#runs.values()) run.controller.abort();
    this.#scheduler.dispose();
    void this.#notifications?.dispose();
    this.#clock.clearInterval?.(this.#sweepTimer);
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

  /** A closed tab's lease ends with it. */
  handleTabRemoved(tabId: number): void {
    this.#workspace.releaseLease(tabId);
  }

  /** Republishes an agent tab whose title, URL, or icon changed, so the sidebar's list stays current. */
  handleTabUpdated(tabId: number, changeInfo: { title?: string; url?: string; favIconUrl?: string; status?: string }): void {
    if (changeInfo.status === "loading" || changeInfo.url !== undefined) this.#tabControllerFactory().forgetPdf(tabId);
    if (!this.#workspace.agentTabs.has(tabId)) return;
    if (changeInfo.title === undefined && changeInfo.url === undefined && changeInfo.favIconUrl === undefined) return;
    void this.#queueAgentTabSync();
  }

  /**
   * Hides the watched agent tab again once the user switches to another tab
   * in its window. Activations in other windows leave it on screen.
   */
  async handleTabActivated(tabId: number): Promise<void> {
    await this.#ready;
    const watching = this.#watching;
    if (!watching || watching.tabId === tabId) return;
    const tabController = this.#tabControllerFactory();
    const watched = (await tabController.allTabs()).find((tab) => tab.id === watching.tabId);
    if (this.#watching !== watching || watched?.active) return;
    this.#watching = null;
    if (watched) await this.#rehide(tabController, watching.tabId);
    await this.#queueAgentTabSync();
  }

  /**
   * Shows one of the open session's agent tabs next to the active tab and
   * switches to it. The tab stays bside's, and runs keep using it;
   * `handleTabActivated` hides it again once the user switches away. Watching
   * another tab hides the previous one and keeps the tab to go back to.
   */
  async #watchAgentTab(tabId: number): Promise<void> {
    const tab = this.#workspace.agentTabs.get(tabId);
    if (!tab || tab.sessionId !== await this.#openSession()) return;
    const tabController = this.#tabControllerFactory();
    const previous = this.#watching;
    if (previous?.tabId === tabId) {
      await tabController.activateTab(tabId).catch(() => {});
      return;
    }
    // Set first, so switching to the tab is not taken for the user leaving it.
    const watching = { tabId, returnTabId: previous?.returnTabId ?? null, takenOver: false };
    this.#watching = watching;
    try {
      const before = await tabController.revealTab(tabId);
      if (!previous) watching.returnTabId = before;
    } catch {
      if (this.#watching === watching) this.#watching = previous;
      await this.#rehide(tabController, tabId);
      await this.#queueAgentTabSync();
      return;
    }
    if (previous) await this.#rehide(tabController, previous.tabId);
    await this.#queueAgentTabSync();
  }

  /**
   * Switches back to the tab the user watched from, or else the watched
   * tab's nearest visible neighbour in its window, and hides the watched tab again.
   */
  async #stopWatching(): Promise<void> {
    const watching = this.#watching;
    if (!watching) return;
    const tabController = this.#tabControllerFactory();
    const tabs = await tabController.allTabs();
    const watched = tabs.find((tab) => tab.id === watching.tabId);
    const distance = (tab: TabSnapshot) => Math.abs((tab.index ?? 0) - (watched?.index ?? 0));
    const candidates = tabs.filter((tab) => !tab.hidden && tab.id !== watching.tabId && tab.windowId === watched?.windowId);
    const back = candidates.find((tab) => tab.id === watching.returnTabId) ?? candidates.toSorted((a, b) => distance(a) - distance(b))[0];
    if (this.#watching !== watching) return;
    this.#watching = null;
    if (back) await tabController.activateTab(back.id!).catch(() => {});
    if (watched) await this.#rehide(tabController, watching.tabId);
    await this.#queueAgentTabSync();
  }

  /**
   * "Take over" (from the shield in the page, or the sidebar): removes the
   * page shield from the watched tab until watching ends. If the tab's
   * session has an active run, that run's next browser program result says
   * the user may have changed the page (not while the run waits on a help
   * request for that tab: answering it says as much).
   */
  async #takeOver(tabId: number): Promise<void> {
    const watching = this.#watching;
    if (!watching || watching.tabId !== tabId || watching.takenOver) return;
    watching.takenOver = true;
    const sessionId = this.#workspace.agentTabs.get(tabId)?.sessionId;
    const run = sessionId === undefined ? undefined : this.#runFor(sessionId);
    if (run && run.pendingHelp?.tabId !== tabId) run.takeovers.add(tabId);
    await this.#queueAgentTabSync();
  }

  /**
   * The page shield a tab should show: only the watched agent tab has one,
   * unless the user took over or a help request is open for it. It says
   * bside is working while the tab's session has an active run.
   */
  #shieldFor(tabId: number): PageShieldState {
    const watching = this.#watching;
    const tab = this.#workspace.agentTabs.get(tabId);
    if (!tab || watching?.tabId !== tabId || watching.takenOver) return "off";
    // A help request names one of its own run's session's agent tabs.
    const run = this.#runFor(tab.sessionId);
    if (run?.pendingHelp?.tabId === tabId) return "off";
    return run ? "working" : "idle";
  }

  /**
   * Sends the watched tab its shield state when it changed, and removes the
   * shield from a tab no longer watched. A content script that is not loaded
   * yet (the tab is navigating) asks for its state when it starts.
   */
  async #syncShield(tabController: TabController): Promise<void> {
    const tabId = this.#watching?.tabId ?? null;
    const sent = this.#shieldSent;
    if (sent && sent.tabId !== tabId) {
      this.#shieldSent = null;
      if (sent.shield !== "off") await tabController.setShield(sent.tabId, "off");
    }
    if (tabId === null) return;
    const shield = this.#shieldFor(tabId);
    if (this.#shieldSent?.shield === shield) return;
    this.#shieldSent = { tabId, shield };
    await tabController.setShield(tabId, shield);
  }

  /** Resyncs the shield after a run or help request changed what it shows; a no-op unless a tab is (or was just) watched. */
  #refreshShield(): void {
    if (this.#watching || this.#shieldSent) void this.#queueAgentTabSync();
  }

  /**
   * A message from the content script in `tabId` (the sender's own tab, never
   * an id the page could choose): its shield state, after a takeover if asked.
   */
  async handleContentMessage(tabId: number, message: ContentMessage): Promise<ContentMessageResponse> {
    await this.#ready;
    if (message.type === "shield.takeover") await this.#takeOver(tabId);
    return { v: 1, id: message.id, ok: true, shield: this.#shieldFor(tabId) };
  }

  /** Hides a tab the user was watching. One Firefox cannot hide (pinned, or the only tab in its window) becomes the user's. */
  async #rehide(tabController: TabController, tabId: number): Promise<void> {
    if (!this.#workspace.agentTabs.has(tabId)) return;
    if (await tabController.hideTab(tabId).then(() => true, () => false)) return;
    // Firefox reports only the tabs it hid, so a tab still hidden (or already closed) needs nothing.
    const tab = (await tabController.allTabs()).find((candidate) => candidate.id === tabId);
    if (!tab || tab.hidden) return;
    this.#workspace.observed.delete(tabId);
    this.#workspace.releaseTab(tabId);
  }

  /**
   * Idle auto-close. Spares every tab of a session with an active run (a run
   * may be using any of its session's tabs, whatever their last use) and the
   * watched tab; other sessions' idle tabs close while runs are active.
   */
  async #closeIdleAgentTabs(): Promise<void> {
    const cutoff = this.#clock.now() - AGENT_TAB_IDLE_MS;
    await this.#closeAgentTabs((tab, id) => id !== this.#watching?.tabId && tab.lastUsedAt <= cutoff);
  }

  /**
   * Closes owned agent tabs matching `shouldClose`. With `spareRunning`, skips
   * every tab whose session has an active run, checked again before each
   * close, since a run may start in a session meanwhile; without it, the
   * caller guarantees `shouldClose` never matches an active run's session.
   */
  async #closeAgentTabs(shouldClose: (tab: AgentTab, id: number) => boolean, spareRunning = true): Promise<void> {
    const tabController = this.#tabControllerFactory();
    for (const id of [...this.#workspace.agentTabs.keys()]) {
      // Re-read after every await: a run may have started or used the tab meanwhile.
      const tab = this.#workspace.agentTabs.get(id);
      if (tab === undefined || (spareRunning && this.#runFor(tab.sessionId)) || !shouldClose(tab, id)) continue;
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
   *
   * A legacy v1 tag names no owning session, so its tab is never adopted:
   * a hidden one is shown and untagged, handing it to the user like a visible
   * one. If Firefox cannot show it, the tag stays and the next startup retries.
   * Returns whether the tab was adopted.
   */
  async #claimTaggedTab(tabController: TabController, tabId: number, tag: AgentTabTagV2 | AgentTabTagV1, hidden: boolean): Promise<boolean> {
    if (this.#workspace.agentTabs.has(tabId)) return false;
    if (!hidden || tag.v === 1) {
      if (hidden && !(await tabController.showTab(tabId).then(() => true, () => false))) return false;
      await tabController.untagAgentTab(tabId).catch(() => {});
      return false;
    }
    this.#workspace.agentTabs.set(tabId, { sessionId: tag.sessionId, role: tag.role, lastUsedAt: tag.lastUsedAt });
    this.#agentTabTags.set(tabId, JSON.stringify(tag));
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
    const open = new Map((await tabController.allTabs()).map((tab) => [tab.id!, tab]));
    for (const id of listed) if (!open.has(id)) this.#workspace.agentTabs.delete(id);
    const writes: Promise<void>[] = [];
    for (const id of this.#agentTabTags.keys()) {
      if (this.#workspace.agentTabs.has(id)) continue;
      // A closed tab took its tag with it; a released one that is still open becomes an ordinary tab.
      if (!open.has(id)) this.#agentTabTags.delete(id);
      else writes.push(tabController.untagAgentTab(id).then(() => { this.#agentTabTags.delete(id); }));
    }
    for (const [id, { sessionId, role, lastUsedAt }] of this.#workspace.agentTabs) {
      if (!open.has(id)) continue;
      const tag: AgentTabTagV2 = { v: 2, role, sessionId, lastUsedAt };
      const serialized = JSON.stringify(tag);
      if (this.#agentTabTags.get(id) === serialized) continue;
      writes.push(tabController.tagAgentTab(id, tag).then(() => { this.#agentTabTags.set(id, serialized); }));
    }
    // A failed write leaves its cached tag stale, so the next sync retries it.
    await Promise.allSettled(writes);
    if (this.#watching && !this.#workspace.agentTabs.has(this.#watching.tabId)) this.#watching = null;
    await this.#syncShield(tabController);
    const bySession: Record<string, AgentTabSummary[]> = {};
    for (const [id, tab] of this.#workspace.agentTabs) {
      if (open.has(id)) (bySession[tab.sessionId] ??= []).push(toAgentTabSummary(id, tab, open.get(id)!));
    }
    const state: AgentTabsState = { bySession, watching: this.#watching?.tabId ?? null, takenOver: this.#watching?.takenOver ?? false };
    const serialized = JSON.stringify(state);
    if (serialized !== this.#publishedAgentTabs) {
      this.#publishedAgentTabs = serialized;
      this.#agentTabsState = state;
      this.#sidebarHub.publishAgentTabs(state);
    }
  }

  /** The open session's id, resolved once and kept in step with `local:openConversation`. */
  async #openSession(): Promise<string> {
    this.#openSessionId ??= await ensureOpenSession();
    return this.#openSessionId;
  }

  /** The open session materialized; if it vanished from storage, the most recent (or a new) session is opened instead. */
  async #openConversation(): Promise<Conversation> {
    const conversation = await getConversation(await this.#openSession());
    if (conversation) return conversation;
    this.#openSessionId = null;
    return (await getConversation(await this.#openSession()))!;
  }

  /** The session's active run, if any: the one run that writes to that session. */
  #runFor(sessionId: string): ActiveRun | undefined {
    for (const run of this.#runs.values()) if (run.sessionId === sessionId) return run;
    return undefined;
  }

  /** The active run with this id, if it has not ended; a callback or command for an ended run finds none. */
  #run(runId: string): ActiveRun | undefined {
    return this.#runs.get(runId);
  }

  /** Some active run, for checks that hold while any run is active. */
  #anyRun(): ActiveRun | undefined {
    return this.#runs.values().next().value;
  }

  /** Every session with an active run: deletion and pruning spare them all. */
  #runSessions(): string[] {
    return [...this.#runs.values()].map((run) => run.sessionId);
  }

  /** Releases a run's slot and its leases on the user's tabs, unless another run has already replaced it. */
  #removeRun(run: ActiveRun): void {
    if (this.#runs.get(run.runId) !== run) return;
    this.#runs.delete(run.runId);
    this.#workspace.releaseRunLeases(run.runId);
  }

  /** Records `diagnostics` as `sessionId`'s latest run's, dropping the least recently run sessions past the bound. */
  #keepDiagnostics(sessionId: string, diagnostics: RunDiagnostics): void {
    this.#diagnostics.delete(sessionId);
    this.#diagnostics.set(sessionId, diagnostics);
    for (const id of this.#diagnostics.keys()) {
      if (this.#diagnostics.size <= MAX_DIAGNOSTIC_SESSIONS) break;
      // A running session's are kept: they describe the run now in progress.
      if (!this.#runFor(id)) this.#diagnostics.delete(id);
    }
  }

  async getSnapshot(): Promise<RuntimeSnapshot> {
    await this.#ready;
    const [conversation, credential, settings, provider] = await Promise.all([
      this.#openConversation(),
      this.#getCredentialStatus(),
      this.#getValidatedSettings(),
      this.#getProviderDefinition(),
    ]);
    const notice = this.#notice;
    this.#notice = null;
    return {
      conversation,
      credential: { ...credential, configured: credential.chatgpt.connected || credential.configured },
      provider,
      settings,
      permissionMode: this.#permissionMode,
      skills: sidebarSkillCatalog(await getSkills()),
      page: this.#sidebarHub.currentAttachment(),
      agentTabs: this.#agentTabsState,
      queue: [...await this.#queue(conversation.id)],
      ask: this.#ask,
      // Read together with each run's seq, so its next event is exactly lastSeq + 1.
      runs: [...this.#runs.values()].map((run) => ({
        runId: run.runId,
        conversationId: run.sessionId,
        status: run.status,
        partialAssistantText: run.partialAssistantText,
        pendingApproval: run.pendingApproval,
        pendingHelp: run.pendingHelp,
        usage: run.usage,
        lastSeq: this.#sidebarHub.lastSeq(run.runId),
      })),
      notice,
    };
  }

  handleCommand(command: Extract<SidebarCommand, { type: "context.export" }>): Promise<{ markdown: string; filename: string } | undefined>;
  handleCommand(command: { v: 1; id: string; type: "session.list" }): Promise<{ sessions: ConversationSummary[] }>;
  handleCommand(command: SidebarCommand, owner?: object): ReturnType<import("./sidebar-hub").SidebarHubDelegate["handleCommand"]>;
  async handleCommand(command: SidebarCommand, owner: object = this): ReturnType<import("./sidebar-hub").SidebarHubDelegate["handleCommand"]> {
    await this.#ready;
    if (command.type === "mcp.content.list" || command.type === "mcp.content.prepare" || command.type === "mcp.content.dismiss") {
      try {
        if (command.sessionId !== await this.#openSession()) throw new McpError("PROTOCOL", "This chat changed. Open the picker again.");
        if (command.type === "mcp.content.dismiss") { this.#preparedContent.dismiss(command.contentIds, owner); return; }
        if (!this.#mcp) throw new McpError("NOT_CONNECTED", "Connect an account in settings first.");
        if (command.type === "mcp.content.list") return { contentReply: { ok: true, ...await this.#mcp.contentCatalog(command.kind) } };
        const snapshot = await this.#mcp.prepareContent(command.choiceId, command.arguments, command.sessionId);
        if (command.sessionId !== await this.#openSession()) throw new McpError("PROTOCOL", "This chat changed while preparing content. Choose it again.");
        this.#preparedContent.add(snapshot, owner);
        return { contentReply: { ok: true, snapshot } };
      } catch (error) { return { contentReply: { ok: false, error: toNormalizedMcpError(error) } }; }
    }
    if (command.type === "skills.list") return { skills: sidebarSkillCatalog(await getSkills()) };
    if (command.type === "tabs.list") {
      // As the open session's runs see them: other sessions' agent tabs are left out.
      const openId = await this.#openSession();
      const owner = (id: number) => this.#workspace.agentTabs.get(id)?.sessionId;
      const tabs = (await this.#tabControllerFactory().listTabs()).filter((tab) => owner(tab.id!) === undefined || owner(tab.id!) === openId);
      return { tabs: tabs.map((tab) => ({ id: tab.id!, title: tab.title ?? "", url: tab.url!, path: `/${owner(tab.id!) ? "agent-tabs" : "tabs"}/${tab.id}/page.md` })) };
    }
    if (command.type === "tabs.focus") {
      // Agent tabs are hidden workspace tabs; activating one would unhide it.
      if (!this.#workspace.agentTabs.has(command.tabId)) await this.#tabControllerFactory().focusTab(command.tabId);
      return;
    }
    if (command.type === "tabs.watch") {
      await this.#watchAgentTab(command.tabId);
      return;
    }
    if (command.type === "tabs.unwatch") {
      await this.#stopWatching();
      return;
    }
    if (command.type === "tabs.takeOver") {
      await this.#takeOver(command.tabId);
      return;
    }
    if (command.type === "tabs.closeAgentTabs") {
      // Refused rather than deferred while the chat has an active run: it may be
      // using these tabs, and a deferred close would fire after the user moved
      // on. Other chats' runs never use them, so they do not matter.
      if (this.#runFor(command.sessionId)) return;
      await this.#closeAgentTabs((tab) => tab.sessionId === command.sessionId);
      return;
    }
    if (command.type === "settings.save") {
      // Accepted while runs are active: each run read its model and effort when it started.
      await this.handleSettingsRequest(command);
      return;
    }
    if (command.type === "permissions.save") {
      // Accepted mid-run: the active run reads the mode at its next gated call.
      await savePermissionSettings({ version: 1, mode: command.mode });
      this.#permissionMode = command.mode;
      this.#sidebarHub.publishPermissionMode(command.mode);
      return;
    }
    if (command.type === "siteNote.get") {
      const origin = pageOrigin(command.url);
      return { origin, note: origin ? siteNoteForPage((await readInstructions()).siteNotes, command.url) : null };
    }
    if (command.type === "siteNote.save") return saveSiteNoteFromSidebar(command.note);
    if (command.type === "memory.undo") return undoMemoryChanges(command.changeIds);
    if (command.type === "workspace.image") {
      // Only the open session's files, as the sidebar shows them; a read, never a run effect.
      if (command.sessionId !== await this.#openSession()) return { workspaceImage: { ok: false, reason: "session" } };
      const file = (await loadWorkspaceFiles(command.sessionId)).find((entry) => entry.path === command.path);
      return { workspaceImage: file?.kind === "binary" && VIEWABLE_IMAGE_TYPES.includes(file.mimeType)
        ? { ok: true, mimeType: file.mimeType, data: file.data }
        : { ok: false, reason: "missing" } };
    }
    if (command.type === "session.list") return { sessions: await listSessions() };
    if (command.type === "session.create" || command.type === "session.open" || command.type === "session.delete" ||
      command.type === "session.rename" || command.type === "session.pin") {
      await this.#runSessionCommand(command);
      return;
    }
    if (command.type === "context.export") return this.#exportSession(command.sessionId);
    if (command.type === "ask.dismiss") {
      if (this.#ask?.id === command.askId) {
        this.#ask = null;
        this.#sidebarHub.publishAsk(null);
      }
      return;
    }
    if ((command.type === "run.start" || command.type === "run.steer") && command.askId && this.#ask?.id !== command.askId) {
      this.#notice = "That page context was replaced or removed. Review the current chip before sending again.";
      await this.#sidebarHub.broadcastSnapshot();
      return;
    }
    if (command.type === "run.start" || command.type === "run.steer") {
      let claim: ReturnType<PreparedMcpContent["claim"]> | undefined;
      let askSelection: AskAcceptance | undefined;
      try {
        if (command.askId) askSelection = this.#claimAsk(command.askId);
        if (command.contentIds?.length) {
          if (command.sessionId !== await this.#openSession()) throw new McpError("PROTOCOL", "The chat changed. Review the selected attachments before sending.");
          claim = this.#preparedContent.claim(command.contentIds, command.sessionId, owner, () => this.#sidebarHub.contentAccepted(owner, command.contentIds!));
          if (!this.#mcp || !(await Promise.all(claim.accepted.content.map(item => this.#mcp!.contentAvailable(item)))).every(Boolean)) throw new McpError("NOT_CONNECTED", "A selected account changed or disconnected. Choose its attachment again.");
        }
        if (command.type === "run.start") await this.#submitPrompt(command.prompt, askSelection, claim?.accepted);
        else await this.#steer(command.runId, command.text, askSelection, claim?.accepted);
      } catch (error) {
        this.#notice = toNormalizedMcpError(error).message;
        await this.#sidebarHub.broadcastSnapshot();
      } finally { claim?.release(); askSelection?.release(); }
      return;
    }
    if (command.type === "queue.remove") {
      await this.#changeQueue(command.sessionId, queue => {
        // A steer or claimed follow-up is already being delivered.
        return !this.#queueClaims.has(command.messageId) && queue.some(message => message.id === command.messageId && message.mode === "follow-up")
          ? queue.filter(message => message.id !== command.messageId) : queue;
      });
      return;
    }
    if (command.type === "queue.send") {
      await this.#sendQueued(command.sessionId, command.messageId);
      return;
    }
    if (command.type === "run.retry") {
      await this.#startRun(await this.#openSession(), null);
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
      return;
    }
    if (command.type === "help.resolve") {
      this.#resolveHelp(command.runId, command.callId, command.outcome, command.note);
    }
  }

  /**
   * One session as Markdown, with its scratch files and its own latest run's
   * diagnostics, model input, and tool output while they are kept in memory.
   */
  async #exportSession(sessionId: string): Promise<{ markdown: string; filename: string } | undefined> {
    const conversation = await getConversation(sessionId);
    if (!conversation) {
      this.#notice = "That chat no longer exists.";
      await this.#sidebarHub.broadcastSnapshot();
      return undefined;
    }
    const latestRun = this.#diagnostics.get(sessionId);
    const files = await loadWorkspaceFiles(sessionId).catch(() => null);
    const fence = (text: string) => {
      const delimiter = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
      return `${delimiter}\n${text}\n${delimiter}`;
    };
    return { filename: `bside-context-${new Date().toISOString().replace(/[:.]/g, "-")}.md`, markdown: [
      "# bside context export", `Exported: ${new Date().toISOString()}`, `Extension version: ${extensionVersion()}`,
      "## Latest run", "Model, timing, usage, and per-call results for this chat's latest run in this background session.",
      latestRun?.record ? fence(JSON.stringify(latestRun.record, null, 2)) : "No run recorded for this chat in this background session.",
      "## Latest model input", "This is the most recent request, not an exact live token count. It is held in memory only; after an extension restart only the saved conversation remains. It may include private page content. Credentials are not included.",
      latestRun?.latestContext ? fence(latestRun.latestContext) : "No model input captured for this chat in this background session.",
      "## Full tool output — latest run", "Exact tool results, including bounded page snapshots and errors. Retained only until this chat's next run, deleting this chat, or extension restart. These are the snapshots exposed to the agent, not the entire page DOM.",
      latestRun?.outputTruncated ?"Earlier results were dropped to keep the debug buffer below 2 million characters." : "No tool results dropped from this run.",
      latestRun?.outputs.length ? fence(`[\n${latestRun.outputs.join(",\n")}\n]`) : "No tool output captured for this chat in this background session.",
      "## Conversation log", fence(JSON.stringify(conversation, null, 2)),
      "## Partial response", fence(this.#runFor(sessionId)?.partialAssistantText ?? ""),
      "## Scratch files", "This chat's /workspace files, kept until the chat is deleted. Binary files (saved screenshots) are listed by type and size, not exported.",
      files ? fence(JSON.stringify(Object.fromEntries(files.map((file) => [file.path, file.kind === "text" ? file.content : `[binary ${file.mimeType}, ${file.bytes} bytes]`])), null, 2)) : "The scratch files could not be read.",
    ].join("\n\n") };
  }

  /**
   * Serializes session changes. While one is pending, the sessions it `holds`
   * (from the moment it is queued) start no run but a scheduled one, so a
   * run never starts in a session that is being switched away from or
   * deleted. Other sessions' runs start and end as usual.
   */
  #queueSessionOp<T>(task: () => Promise<T>, holds: readonly string[] = []): Promise<T> {
    const release = this.#holdSessions(holds);
    const op = this.#sessionOps.then(task);
    this.#sessionOps = op.then(() => {}, () => {});
    return op.finally(release);
  }

  /** Holds sessions (see `#heldSessions`) until the returned release is called, once. */
  #holdSessions(ids: readonly string[]): () => void {
    for (const id of ids) this.#heldSessions.set(id, (this.#heldSessions.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const id of ids) {
        const count = (this.#heldSessions.get(id) ?? 1) - 1;
        if (count > 0) this.#heldSessions.set(id, count);
        else this.#heldSessions.delete(id);
      }
    };
  }

  /** Whether a pending session command holds `sessionId`, or a scheduled launch is preparing a run there. */
  #sessionHeld(sessionId: string): boolean {
    return this.#heldSessions.has("*") || this.#heldSessions.has(sessionId) || this.#scheduledStarting.has(sessionId);
  }

  /**
   * The sessions a session command holds: the open one (it may be switched
   * away from, and deleted if untouched) and, for a delete, the deleted one.
   * Renaming and pinning hold none.
   */
  #sessionsHeldBy(command: SessionCommand): string[] {
    if (command.type === "session.rename" || command.type === "session.pin") return [];
    // Resolved during startup, before any sidebar command runs; held in full otherwise.
    const open = this.#openSessionId === null ? ["*"] : [this.#openSessionId];
    return command.type === "session.delete" ? [...open, command.sessionId] : open;
  }

  /** Applies a session command, then republishes the snapshot and the session list. */
  async #runSessionCommand(command: SessionCommand): Promise<void> {
    try { await this.#queueSessionOp(() => this.#applySessionCommand(command), this.#sessionsHeldBy(command)); }
    catch { this.#notice = "Could not update chats. Try again."; }
    if (command.type === "session.open") {
      await this.#scheduler.markRead(await this.#openSession()).catch(() => {});
      await this.#syncScheduleBadge();
    }
    await this.#sidebarHub.broadcastSnapshot();
    await this.#publishSessions();
  }

  /** Pushes the session index to every sidebar. A failed read is skipped; the next change republishes. */
  async #publishSessions(): Promise<void> {
    try { this.#sidebarHub.publishSessions(await listSessions()); }
    catch { /* The lists stay as they were. */ }
  }

  /**
   * Deletes unpinned sessions not updated within the retention period. The
   * open session and every active run's session are never pruned. Also closes
   * agent tabs whose session no longer exists (one deleted while its tabs
   * could not be closed, or restored from an older profile). Returns the
   * number of sessions deleted.
   */
  async #applyRetention(): Promise<number> {
    this.#lastRetentionAt = this.#clock.now();
    // Holds no session: a run only starts in the open session, which is kept,
    // as a follow-up in the session whose run just completed, which was just
    // updated, or as a scheduled run, which starts under this same lock.
    const deleted = await this.#queueSessionOp(async () => {
      const cutoff = retentionCutoff((await getHistorySettings()).retention, this.#clock.now());
      const keep = [await this.#openSession(), ...this.#runSessions()];
      const ids = cutoff === null ? [] : await pruneSessions(cutoff, keep);
      await this.#forgetSessions(ids, true);
      const live = new Set((await listSessions()).map((session) => session.id));
      const orphaned = (tab: AgentTab) => !live.has(tab.sessionId);
      if ([...this.#workspace.agentTabs.values()].some(orphaned)) await this.#closeAgentTabs(orphaned, false);
      return ids;
    });
    if (deleted.length > 0) await this.#publishSessions();
    return deleted.length;
  }

  /**
   * "Delete all history": every session except active runs', pinned ones
   * included, with their scratch files and agent tabs. A deleted open session
   * is replaced by a new empty one.
   */
  async #deleteAllHistory(): Promise<string> {
    const { deleted, kept } = await this.#queueSessionOp(async () => {
      const kept = this.#runSessions();
      const openId = await this.#openSession();
      const deleted = await deleteAllSessions(kept);
      if (deleted.includes(openId)) {
        const { id } = await createSession();
        await setOpenSessionId(id);
        this.#openSessionId = id;
      }
      await this.#forgetSessions(deleted, true);
      return { deleted, kept };
    }, ["*"]);
    await this.#sidebarHub.broadcastSnapshot();
    await this.#publishSessions();
    const count = `Deleted ${deleted.length} ${deleted.length === 1 ? "chat" : "chats"}.`;
    if (kept.length === 0) return count;
    return kept.length === 1 ? `${count} The chat with the active run was kept.` : `${count} The chats with active runs were kept.`;
  }

  /**
   * Drops retry and debug state that described deleted sessions, and closes
   * their agent tabs, or with `closeTabs` false shows them and hands them to
   * the user (a tab Firefox cannot show is closed). Never a running session:
   * deletion and pruning both spare active runs'.
   */
  async #forgetSessions(ids: readonly string[], closeTabs: boolean): Promise<void> {
    // Do not await while holding the session-operation lock: an alarm may
    // already hold the scheduler lock and be waiting to reserve a session.
    // The queued detach runs before a subsequent settings read or alarm.
    void this.#scheduler.forgetSessions(ids).then(() => this.#syncScheduleBadge()).catch(() => {});
    for (const id of ids) {
      this.#retryable.delete(id);
      this.#diagnostics.delete(id);
    }
    await this.#withQueueLock(async () => {
      for (const id of ids) {
        for (const message of this.#queues.get(id) ?? []) this.#queueClaims.delete(message.id);
        this.#queues.delete(id);
        // An admission already in flight may have written after session deletion.
        await saveMessageQueue(id, []).catch(() => {});
      }
    });
    const owned = (tab: AgentTab) => ids.includes(tab.sessionId);
    if (![...this.#workspace.agentTabs.values()].some(owned)) return;
    if (!closeTabs) {
      const tabController = this.#tabControllerFactory();
      for (const [id, tab] of [...this.#workspace.agentTabs]) {
        if (!owned(tab) || !(await tabController.showTab(id).then(() => true, () => false))) continue;
        this.#workspace.observed.delete(id);
        this.#workspace.releaseTab(id);
      }
    }
    await this.#closeAgentTabs(owned, false);
  }

  async #applySessionCommand(command: SessionCommand): Promise<void> {
    const openId = await this.#openSession();
    if (command.type === "session.create") {
      // An untouched open session already is a new chat. A session with an
      // active run counts as touched even before its user message is written.
      if (this.#runFor(openId) || !(await isSessionUntouched(openId))) await this.#switchSession((await createSession()).id);
      return;
    }
    if (command.type === "session.open") {
      if (command.sessionId === openId) return;
      if ((await listSessions()).some((session) => session.id === command.sessionId)) await this.#switchSession(command.sessionId);
      else this.#notice = "That chat no longer exists.";
      return;
    }
    if (command.type === "session.rename" || command.type === "session.pin") {
      const title = command.type === "session.rename" ? validateSessionTitle(command.title) : undefined;
      if (title === null) {
        this.#notice = "Chat titles must be 1 to 120 characters.";
        return;
      }
      const patch = command.type === "session.rename" ? { title } : { pinned: command.pinned };
      if (!(await updateSession(command.sessionId, patch))) this.#notice = "That chat no longer exists.";
      return;
    }
    // Refused rather than cancelling first: deleting must never be how a run is stopped.
    if (this.#runFor(command.sessionId)) {
      this.#notice = "Stop the run in this chat before deleting it.";
      return;
    }
    await deleteSession(command.sessionId);
    await this.#forgetSessions([command.sessionId], command.closeAgentTabs);
    if (command.sessionId === openId) {
      // Opens the most recently updated remaining session, or a new empty one.
      this.#openSessionId = null;
      await this.#openSession();
    }
  }

  /**
   * Opens `id`. The previous session is deleted if it is untouched, so
   * abandoned new chats do not pile up. It is held until then: a run started
   * there after the check below would lose its session.
   */
  async #switchSession(id: string): Promise<void> {
    const previous = await this.#openSession();
    const release = this.#holdSessions([previous]);
    try {
      await setOpenSessionId(id);
      this.#openSessionId = id;
      if (previous !== id && !this.#runFor(previous) && await isSessionUntouched(previous)) await deleteSession(previous);
    } finally { release(); }
  }

  async handleCredentialRequest(request: CredentialRequest): Promise<CredentialResponse> {
    // The options page can message during startup; a change racing the
    // credential migration could be overwritten by its sealed legacy copy.
    await this.#ready;
    try {
      let notice: string | null = null;
      if (request.type === "credentials.chatgpt.notice.dismiss") await clearChatGPTSignInNotice();
      else if (request.type !== "credentials.openai.status") {
        // Refused while any run exists, in any chat: every run shares the one
        // credential (and ChatGPT's token refresh), so changing or testing it
        // would pull authentication out from under runs in progress.
        if (this.#anyRun()) throw new ProviderStreamError("Wait for active runs to finish before changing or testing credentials.", "INVALID_REQUEST");
        if (request.type === "credentials.openai.save") {
          await this.#provider.validateAuth({ providerId: "openai", method: "api-key", secret: request.apiKey }, new AbortController().signal);
          await saveOpenAICredential(request.apiKey);
        } else if (request.type === "credentials.openai.delete") await deleteStoredCredential();
        else if (request.type === "credentials.chatgpt.login") await this.#chatgpt.login();
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

  /** Options-only local report, with the chat's own latest run's diagnostics. */
  async handleProblemReportRequest(request: ProblemReportRequest): Promise<ProblemReportResponse> {
    await this.#ready;
    try {
      if (request.type === "problemReport.list") {
        return { v: 1, id: request.id, ok: true, type: request.type,
          sessions: (await listSessions()).map(({ id, title }) => ({ id, title })) };
      }
      const conversation = await getConversation(request.sessionId);
      if (!conversation) throw new Error("missing session");
      return { v: 1, id: request.id, ok: true, type: request.type,
        filename: "bside-problem-report.json",
        json: buildProblemReport(conversation, this.#diagnostics.get(request.sessionId)?.record ?? null, extensionVersion()) };
    } catch {
      return { v: 1, id: request.id, ok: false, error: { code: "INVALID_REQUEST", phase: "persistence", retryable: false,
        message: "Could not build this report. The chat may have been deleted; refresh and try again." } };
    }
  }

  /** Options page: history retention and "Delete all history". */
  async handleHistoryRequest(request: HistoryRequest): Promise<HistoryResponse> {
    await this.#ready;
    try {
      let notice: string | null = null;
      if (request.type === "history.retention.save") {
        await saveHistorySettings({ version: 1, retention: request.retention });
        const deleted = await this.#applyRetention();
        if (deleted > 0) notice = `Deleted ${deleted} ${deleted === 1 ? "chat" : "chats"} older than the new limit.`;
      } else if (request.type === "history.deleteAll") {
        notice = await this.#deleteAllHistory();
      }
      return { v: 1, id: request.id, ok: true, settings: await getHistorySettings(), sessionCount: (await listSessions()).length, notice };
    } catch (error) {
      return { v: 1, id: request.id, ok: false, error: toNormalizedError(error, "persistence") };
    }
  }

  /** Only the options-page adapter calls this; no automation command exists on the sidebar Port. */
  async handleAutomationRequest(request: AutomationRequest): Promise<AutomationResponse> {
    await this.#ready;
    try {
      if (request.type === "automation.save") await this.#scheduler.save(request.taskId, request.task);
      else if (request.type === "automation.delete") await this.#scheduler.remove(request.taskId);
      else if (request.type === "automation.notifications.save") {
        await saveNotificationSettings({ version: 1, enabled: request.enabled });
        await this.#notifications?.setEnabled(request.enabled);
      }
      else if (request.type === "automation.results") {
        const task = (await this.#scheduler.list()).find((t) => t.id === request.taskId);
        if (!task?.sessionId) throw new Error("This task has no saved results yet.");
        await this.openResultsSession(task.sessionId);
      }
      await this.#syncScheduleBadge();
      return { v: 1, id: request.id, ok: true, tasks: await this.#scheduler.list(), notifications: await getNotificationSettings(), available: this.#scheduler.available };
    } catch {
      return { v: 1, id: request.id, ok: false, error: { code: "INVALID_REQUEST", message: "Could not update automation. Check the task fields and try again.", retryable: false, phase: "persistence" } };
    }
  }

  async handleAlarm(name: string): Promise<void> {
    await this.#ready;
    await this.#scheduler.handleAlarm(name).catch(() => {});
  }

  /** A deliberate UI/notification click, never called by automatic dispatch. */
  async openResultsSession(sessionId: string): Promise<void> {
    await this.#ready;
    await this.#runSessionCommand({ v: 1, id: crypto.randomUUID(), type: "session.open", sessionId });
  }

  /**
   * The toolbar click while the badge asks for attention (after it opened the
   * sidebar synchronously): opens the chat of the run that has waited longest
   * for the user, else the most recent unread scheduled results.
   */
  async openAttentionSession(): Promise<void> {
    await this.#ready;
    const waiting = this.#longestWaitingRun();
    const sessionId = waiting ? waiting.sessionId :
      (await this.#scheduler.list()).filter((t) => t.unread).toSorted((a, b) => (b.lastRun?.startedAt ?? 0) - (a.lastRun?.startedAt ?? 0))[0]?.sessionId;
    if (sessionId) await this.openResultsSession(sessionId);
  }

  /** The active run that has waited longest for the user's confirmation or help, as the badge ordered them. */
  #longestWaitingRun(): ActiveRun | undefined {
    for (const runId of this.#approvalBadge?.waitingRuns() ?? []) {
      const run = this.#run(runId);
      if (run) return run;
    }
    return undefined;
  }

  async #syncScheduleBadge(): Promise<void> {
    this.#approvalBadge?.setResults((await this.#scheduler.list()).some((t) => t.unread));
  }

  async #launchScheduled(task: ScheduledTask, scheduledAt: number, recordStart: RecordTaskStart): Promise<TaskDispatch> {
    if (this.#disposed) return { status: "unavailable" };
    // Busy only while the task's results session has a run (or another launch
    // is preparing one there); runs in other chats never delay it. A first run
    // gets a new session, which nothing else can start a run in.
    const results = task.sessionId;
    const busy = () => results !== null && this.#runFor(results) !== undefined;
    if (busy() || (results !== null && this.#scheduledStarting.has(results))) return { status: "skipped-busy" };
    // Held from here until the run claims its slot, so a sidebar start or a
    // follow-up there cannot take the session between the check and the start.
    if (results !== null) this.#scheduledStarting.add(results);
    try {
      return await this.#queueSessionOp(async (): Promise<TaskDispatch> => {
        if (busy()) return { status: "skipped-busy" };
        // Never recreate a deleted results session from a stale alarm. Its
        // queued detach disables the task; only explicit re-enabling recreates it.
        if (task.sessionId && !await getConversation(task.sessionId)) return { status: "unavailable" };
        const sessionId = task.sessionId ?? (await createSession()).id;
        if (!task.sessionId) await updateSession(sessionId, { title: task.name });
        const runId = crypto.randomUUID();
        const scheduled: ScheduledSource = { taskId: task.id, name: task.name, url: task.url, scheduledAt };
        await recordStart(sessionId, runId);
        if (this.#disposed) return { status: "unavailable" };
        // #startRun claims the run's slot synchronously. Do not hold the
        // scheduler/session lock for the provider request or a user pause.
        // #startRun ends its own run on any exception; this only covers one
        // that escapes before it does.
        void this.#startRun(sessionId, task.prompt, undefined, { scheduled, runId }).catch(async (error: unknown) => {
          const run = this.#run(runId);
          if (run) await this.#abandonRun(run, error);
        });
        return { status: "started", runId, sessionId };
      });
    } finally { if (results !== null) this.#scheduledStarting.delete(results); }
  }

  async #getCredentialStatus() {
    const [apiKey, chatgpt] = await Promise.all([getCredentialStatus(), this.#chatgpt.status()]);
    return { ...apiKey, chatgpt };
  }

  async #getProviderDefinition(): Promise<ProviderDefinition> {
    // Efforts are derived on every read, so an updated Pi catalog reaches a saved account catalog.
    const account = await this.#chatgpt.models();
    this.#modelCatalog = account ? describeModels(account) : OPENAI_API_KEY_PROVIDER.models;
    return { ...OPENAI_API_KEY_PROVIDER, models: this.#modelCatalog };
  }

  async handleSettingsRequest(request: SettingsRequest): Promise<SettingsResponse> {
    await this.#ready;
    if (request.type === "settings.get") {
      const settings = await this.#getValidatedSettings();
      const notice = this.#notice;
      this.#notice = null;
      return { v: 1, id: request.id, ok: true, settings, provider: await this.#getProviderDefinition(), notice };
    }
    const provider = await this.#getProviderDefinition();
    const model = provider.models.find((model) => model.id === request.settings.modelId);
    // Saved even while runs are active: a run reads its model and effort once,
    // when its agent loop starts (`#runAgentLoop`), and keeps them for every
    // round and compaction, so a change applies to runs started after it.
    if (!model || !model.reasoningEfforts.includes(request.settings.reasoningEffort))
      return { v: 1, id: request.id, ok: false, error: toNormalizedError(new ProviderStreamError("The model/reasoning selection is unavailable.", "INVALID_REQUEST"), "setup") };
    await saveAppSettings(request.settings);
    await this.#sidebarHub.broadcastSnapshot();
    return { v: 1, id: request.id, ok: true, settings: request.settings, provider, notice: null };
  }

  /**
   * Resets an invalid persisted selection once, surfacing a one-time notice: an
   * unsupported effort to the model's default, an unavailable model to the defaults.
   */
  async #getValidatedSettings(): Promise<AppSettingsV1> {
    const settings = await getAppSettings();
    const provider = await this.#getProviderDefinition();
    const model = provider.models.find((candidate) => candidate.id === settings.modelId);
    if (model && (model.reasoningEfforts as readonly string[]).includes(settings.reasoningEffort)) {
      return settings;
    }
    if (model) {
      const fallback: AppSettingsV1 = { ...settings, reasoningEffort: model.defaultReasoningEffort };
      await saveAppSettings(fallback);
      this.#notice = `${model.name} does not support "${settings.reasoningEffort}" reasoning, so it was reset to "${model.defaultReasoningEffort}".`;
      return fallback;
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

  /**
   * A session's message queue, loaded once per background lifetime. Steers
   * found in storage then belong to a run a restart interrupted, so they load
   * as follow-ups. A delivered steer or dispatched follow-up keeps its queued
   * id as its item id, so one the restart caught between writing its item and
   * leaving the queue is dropped here rather than sent twice.
   */
  #withQueueLock<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.#queueOps.then(task);
    this.#queueOps = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #queue(sessionId: string): Promise<QueuedMessage[]> {
    const cached = this.#queues.get(sessionId);
    return cached ? Promise.resolve(cached) : this.#withQueueLock(() => this.#readQueue(sessionId));
  }

  /** Queue cache initialization; called only while holding the queue lock. */
  async #readQueue(sessionId: string): Promise<QueuedMessage[]> {
    const cached = this.#queues.get(sessionId);
    if (cached) return cached;
    let stored = await loadMessageQueue(sessionId).catch(() => []);
    if (stored.length > 0) {
      const delivered = new Set((await getConversation(sessionId).catch(() => null))?.items.map((item) => item.id));
      stored = stored.filter((message) => !delivered.has(message.id));
    }
    const queue = stored.map((message) => ({ ...message, mode: "follow-up" as const }));
    this.#queues.set(sessionId, queue);
    return queue;
  }

  /** Caller holds the queue lock through persistence and publication. Never call a locking helper here. */
  async #writeQueue(sessionId: string, messages: QueuedMessage[], requirePersistence = false): Promise<void> {
    if (requirePersistence) await saveMessageQueue(sessionId, messages);
    this.#queues.set(sessionId, messages);
    this.#sidebarHub.publishQueue(sessionId, messages);
    if (!requirePersistence) await saveMessageQueue(sessionId, messages).catch(() => console.warn("[bside] Could not save queued messages."));
  }

  #changeQueue(sessionId: string, change: (queue: QueuedMessage[]) => QueuedMessage[], after?: () => void): Promise<void> {
    return this.#withQueueLock(async () => {
      const queue = await this.#readQueue(sessionId);
      const next = change(queue);
      if (next !== queue) await this.#writeQueue(sessionId, next);
      after?.();
    });
  }

  /** All admissions, removals, delivery, and settlement share the same lock. */
  async #appendQueued(sessionId: string, message: QueuedMessage, selection?: ContentAcceptance, askSelection?: AskAcceptance): Promise<boolean> {
    const accepted = await this.#withQueueLock(async () => {
      const current = await this.#readQueue(sessionId);
      if (current.length >= MAX_QUEUED_MESSAGES) return false;
      await this.#writeQueue(sessionId, [...current, message], !!selection || !!askSelection);
      selection?.commit();
      askSelection?.commit();
      return true;
    });
    // Snapshot construction may load another chat's queue, so publish outside the lock.
    if (!accepted) { this.#notice = `Up to ${MAX_QUEUED_MESSAGES} messages can wait at once.`; await this.#sidebarHub.broadcastSnapshot(); }
    return accepted;
  }

  /** Refuses a queue at capacity with a notice. */
  async #queueFull(queue: readonly QueuedMessage[]): Promise<boolean> {
    if (queue.length < MAX_QUEUED_MESSAGES) return false;
    this.#notice = `Up to ${MAX_QUEUED_MESSAGES} messages can wait at once.`;
    await this.#sidebarHub.broadcastSnapshot();
    return true;
  }

  /** `run.start`: while the open session's run is active, the prompt waits as a follow-up; otherwise a run starts with it. */
  async #submitPrompt(rawPrompt: string, askSelection?: AskAcceptance, selection?: ContentAcceptance): Promise<void> {
    const sessionId = await this.#openSession();
    if (selection?.content.some(item => item.sessionId !== sessionId)) throw new McpError("PROTOCOL", "The chat changed. Choose the attachments again.");
    const queue = await this.#queue(sessionId);
    const prompt = validatePromptText(rawPrompt);
    if (prompt && !hasPreparedMcpPrompt(prompt, selection?.content)) throw new McpError("PROTOCOL", "Choose the MCP prompt from / and prepare its preview before sending.");
    if (!prompt || !this.#runFor(sessionId)) return this.#startRun(sessionId, rawPrompt, undefined, undefined, askSelection, selection);
    if (await this.#queueFull(queue)) return;
    const skill = await this.#captureSkill(prompt);
    if (skill === null) return;
    if (!this.#runFor(sessionId)) return this.#startRun(sessionId, prompt, undefined, { skill }, askSelection, selection);
    const current = await this.#queue(sessionId);
    if (await this.#queueFull(current)) return;
    if (!this.#askIsCurrent(askSelection?.ask.id)) return;
    const ask = this.#snapshotAsk(askSelection, sessionId);
    await this.#appendQueued(sessionId, { id: crypto.randomUUID(), mode: "follow-up", text: prompt, ...(skill ? { skill } : {}), ...(ask ? { ask } : {}), ...(selection?.content.length ? { content: selection.content } : {}), at: Date.now() }, selection, askSelection);
  }

  async #captureSkill(text: string): Promise<Skill | undefined | null> {
    try { return await captureInvokedSkill(text); }
    catch (error) {
      this.#notice = error instanceof Error ? error.message : "Could not read saved skills.";
      await this.#sidebarHub.broadcastSnapshot();
      return null;
    }
  }

  /** `run.steer`: hands guidance to the active run's agent loop and shows it as pending until delivered. */
  async #steer(runId: string, rawText: string, askSelection?: AskAcceptance, selection?: ContentAcceptance): Promise<void> {
    const run = this.#run(runId);
    if (!run) return this.#submitPrompt(rawText, askSelection, selection);
    if (selection?.content.some(item => item.sessionId !== run.sessionId)) throw new McpError("PROTOCOL", "Those attachments belong to another chat.");
    const queue = await this.#queue(run.sessionId);
    const text = validatePromptText(rawText);
    if (text && !hasPreparedMcpPrompt(text, selection?.content)) throw new McpError("PROTOCOL", "Choose the MCP prompt from / and prepare its preview before sending.");
    // Re-checked after loading: once a run ends or is cancelling, a steer could never be delivered.
    if (!text || this.#run(runId) !== run || run.status === "cancelling") return this.#submitPrompt(rawText, askSelection, selection);
    if (await this.#queueFull(queue)) return;
    const skill = await this.#captureSkill(text);
    if (skill === null) return;
    if (this.#run(runId) !== run || run.controller.signal.aborted) return this.#submitPrompt(rawText, askSelection, selection);
    const current = await this.#queue(run.sessionId);
    if (await this.#queueFull(current)) return;
    if (!this.#askIsCurrent(askSelection?.ask.id)) return;
    const ask = this.#snapshotAsk(askSelection, run.sessionId);
    const message: QueuedMessage = { id: crypto.randomUUID(), mode: "steer", text, ...(skill ? { skill } : {}), ...(ask ? { ask } : {}), ...(selection?.content.length ? { content: selection.content } : {}), at: Date.now() };
    if (!await this.#appendQueued(run.sessionId, message, selection, askSelection)) return;
    if (this.#run(runId) === run && !run.controller.signal.aborted) run.agentLoop.steer(message);
    else await this.#settleSteers(run.sessionId);
  }

  /** Steers the run never delivered become follow-ups: kept visible, and sent next only if the run completed. */
  async #settleSteers(sessionId: string): Promise<void> {
    await this.#changeQueue(sessionId, queue => queue.some(message => message.mode === "steer")
      ? queue.map(message => ({ ...message, mode: "follow-up" })) : queue);
  }

  /** Claim under the queue lock, then start outside it: a run itself delivers/removes queue entries. */
  async #runQueued(sessionId: string, messageId?: string): Promise<boolean> {
    const message = await this.#withQueueLock(async () => {
      // One claim per session at a time: a claimed follow-up is already starting this session's run.
      if (this.#runFor(sessionId) || [...this.#queueClaims.values()].includes(sessionId) || this.#sessionHeld(sessionId)) return undefined;
      const candidate = (await this.#readQueue(sessionId)).find(item => item.mode === "follow-up" && (messageId === undefined || item.id === messageId));
      if (candidate) this.#queueClaims.set(candidate.id, sessionId);
      return candidate;
    });
    if (!message) return false;
    try { await this.#startRun(sessionId, message.text, message.id, { skill: message.skill, ask: message.ask, content: message.content }); }
    finally { await this.#withQueueLock(async () => { this.#queueClaims.delete(message.id); }); }
    return true;
  }

  /** `queue.send`: only an unclaimed follow-up of the open session can start. */
  async #sendQueued(sessionId: string, messageId: string): Promise<void> {
    if (sessionId !== await this.#openSession() || !await this.#runQueued(sessionId, messageId)) await this.#sidebarHub.broadcastSnapshot();
  }

  /** Completed runs dispatch oldest first; failed/cancelled runs leave follow-ups pending. */
  async #dispatchFollowUp(sessionId: string): Promise<void> {
    await this.#runQueued(sessionId);
  }

  /**
   * Starts a run in `sessionId` (the open session, or a completed run's
   * session for a follow-up). A `null` prompt is a retry: it re-runs the last
   * turn's existing user message instead of appending a new one. `queuedId`
   * names the queued follow-up the prompt came from; its user message keeps
   * that id, and it leaves the queue once that message is written.
   */
  async #startRun(sessionId: string, rawPrompt: string | null, queuedId?: string, accepted?: { skill?: Skill; ask?: AskContextV1; scheduled?: ScheduledSource; runId?: string; content?: McpContentSnapshot[] }, askSelection?: AskAcceptance, selection?: ContentAcceptance): Promise<void> {
    if (this.#disposed) return;
    const retry = rawPrompt === null;
    const retryable = this.#retryable.get(sessionId);
    // A session runs at most one run; any number of sessions may run at once.
    // A scheduled run starts under the session lock, so session commands cannot hold its session.
    if (this.#runFor(sessionId) || (!accepted?.scheduled && this.#sessionHeld(sessionId)) || (retry && !retryable)) {
      await this.#sidebarHub.broadcastSnapshot();
      return;
    }
    if (retry && retryable?.hadPageEffect) {
      this.#notice = "The last attempt already changed a page or a connected account, so retrying it could repeat that change. Send a new message to continue.";
      await this.#sidebarHub.broadcastSnapshot();
      return;
    }

    const prompt = retry ? null : validatePromptText(rawPrompt);
    if (!retry && !prompt) {
      this.#notice = "Message is empty or too long.";
      await this.#sidebarHub.broadcastSnapshot();
      return;
    }

    // Claim the session's slot synchronously, before any `await`, so a second
    // start in this session arriving before credential lookup resolves still
    // sees its run and is dropped rather than racing into a second run there.
    const runId = accepted?.runId ?? crypto.randomUUID();
    const controller = new AbortController();
    const tabController = this.#tabControllerFactory();
    // The session's scratch files load on the first program that uses them; memory is global and read at each use.
    const scope = { state: this.#workspace, runId, sessionId, files: new ScratchFiles(workspaceStore(sessionId)), skills: new Map<string, Skill>(), sites: this.#sites,
      memory: runMemory(sessionId, runId) };
    const agentLoop = new AgentLoop(this.#provider, tabController, this.#sidebarHub, scope);
    const run: ActiveRun = {
      runId,
      sessionId,
      ...(accepted?.scheduled ? { scheduled: accepted.scheduled } : {}),
      controller,
      agentLoop,
      status: "running",
      partialAssistantText: "",
      pendingApproval: null,
      pendingHelp: null,
      takeovers: new Set(),
      usage: null,
      lastCheckpointAt: 0,
      diagnostics: { record: null, latestContext: null, outputs: [], outputChars: 0, outputTruncated: false },
      claimedAt: this.#clock.now(),
      announced: false,
      turnPersisted: retry,
      outcome: null,
      ended: false,
    };
    this.#runs.set(runId, run);

    let auth: ProviderAuth;
    let conversation: Conversation | null;
    let skill: Skill | undefined;
    let catalog: SkillSummary[];
    // Like skills, the run uses the custom instructions, site notes, and memory index as they are now.
    let personal: Personalization;
    let ask: AskContextV1 | undefined;
    try {
      if (!retry && !hasPreparedMcpPrompt(prompt!, selection?.content ?? accepted?.content)) throw new ProviderStreamError("MCP prompts require a prepared preview in a sidebar message. Use ordinary text for a scheduled task.", "INVALID_REQUEST");
      // Memory the run cannot read is left out of its prompt rather than stopping it.
      // Likewise for connected accounts' tools: one that cannot be read is not offered.
      personal = { ...await readInstructions(), memoryIndex: await readMemoryIndex().catch(() => null),
        mcpTools: await this.#mcp?.toolDefinitions(AGENT_TOOL_NAMES).catch(() => []) ?? [] };
      const available = await getSkills();
      catalog = skillCatalog(available);
      for (const skill of available) scope.skills.set(skill.name, skill);
      if (!retry) skill = accepted && !accepted.scheduled ? accepted.skill : await captureInvokedSkill(prompt!, available);
      const chatgpt = await this.#chatgpt.status();
      const credential = chatgpt.connected ? null : await getOpenAICredential();
      if (!chatgpt.connected && !credential) throw new ProviderStreamError("Sign in with ChatGPT or add an OpenAI API key in settings before starting a conversation.", "AUTHENTICATION");
      auth = chatgpt.connected ? await this.#chatgpt.getAuth(controller.signal) : { providerId: "openai", method: "api-key", secret: credential!.apiKey };
      conversation = await getConversation(sessionId);
      if (!conversation) throw new ProviderStreamError("This chat no longer exists.", "INVALID_REQUEST");
      if (retry && !conversation.items.some(isTurnStart)) throw new ProviderStreamError("There is no turn to retry.", "INVALID_REQUEST");
      if (!this.#askIsCurrent(askSelection?.ask.id)) throw new ProviderStreamError(this.#notice!, "INVALID_REQUEST");
      ask = retry ? conversation.items.findLast(isTurnStart)?.ask : accepted?.ask ?? this.#snapshotAsk(askSelection, sessionId);
      if (retry) run.scheduled = conversation.items.findLast(isTurnStart)?.scheduled;
      controller.signal.throwIfAborted();
    } catch (error) {
      // Not announced and no checkpoint yet: the run gives up its slot and reports why.
      run.ended = true;
      this.#removeRun(run);
      await this.#settleSteers(sessionId);
      this.#notice = toNormalizedError(error, "setup").message;
      if (run.scheduled) {
        const safe = error instanceof ProviderStreamError ? error.message : "Scheduled run could not start. Check your connection and task settings.";
        if (!retry) await appendConversationItem(sessionId, { id: crypto.randomUUID(), kind: "message", role: "user", text: prompt!, context: null, scheduled: run.scheduled, at: this.#clock.now() }).catch(() => {});
        await appendConversationItem(sessionId, { id: crypto.randomUUID(), kind: "run-digest", digest: { version: 1, status: "failed", error: safe, entries: [], omittedEntries: 0 }, at: this.#clock.now() }).catch(() => {});
        await touchSession(sessionId, { scheduled: run.scheduled }).catch(() => {});
        void this.#scheduler.updateRun(run.scheduled.taskId, runId, controller.signal.aborted ? "cancelled" : "failed").catch(() => {});
        void this.#notifications?.finished(runId, sessionId, { scheduled: true, durationMs: 0, status: controller.signal.aborted ? "cancelled" : "failed" });
        void this.#syncScheduleBadge();
        await this.#publishSessions();
      }
      await this.#sidebarHub.broadcastSnapshot();
      return;
    }

    // From here every exit reaches a terminal state: an exception anywhere
    // below (capture, persistence, settings, the agent loop, or its own
    // terminal path) ends the run through `#abandonRun`, which is a no-op once
    // the run has ended.
    try {
      this.#sidebarHub.startRun(runId, sessionId);
      run.announced = true;
      // A watched tab of this session now says bside is working in it.
      this.#refreshShield();

      // The active tab is an agent tab while the user watches one. The run's
      // own is attached under /agent-tabs; another session's stays invisible to it.
      const askOwner = ask ? this.#workspace.agentTabs.get(ask.tabId)?.sessionId : undefined;
      const captureOutcome = run.scheduled ? await this.#captureScheduledPage(tabController, run) : ask
        ? askOwner && askOwner !== sessionId ? null : await tabController.capturePage(ask.tabId)
        : await tabController.captureActivePage();
      const captured = captureOutcome?.ok ? captureOutcome.value : null;
      const capturedOwner = captured ? this.#workspace.agentTabs.get(captured.snapshot.tabId)?.sessionId : undefined;
      // Attaching a user's tab is the run's first use of it, so it takes the
      // lease; one another run holds is left out, and the turn says so.
      const pageInUse = captured && capturedOwner === undefined && !this.#workspace.acquireLease(captured.snapshot.tabId, runId)
        ? { tabId: captured.snapshot.tabId } : null;
      const artifact: ContextArtifact | null = captured && !pageInUse && (capturedOwner === undefined || capturedOwner === sessionId)
        ? { ...captured.artifact, target: { kind: "tab", tabId: captured.snapshot.tabId, mount: capturedOwner ? "agent-tabs" : "tabs" }, snapshot: captured.snapshot }
        : null;

      let items = conversation.items;
      if (!retry) {
        // Notes for the attached page and mentioned tabs ride on the message as a snapshot, so replay never changes.
        const sites = matchSiteNotes(personal.siteNotes, [...(artifact ? [artifact.url] : []), ...(ask ? [ask.pageUrl] : []), ...[...prompt!.matchAll(PROMPT_MENTION_PATTERN)].map((match) => match[4]!)]);
        const item: UserMessageItem = {
          id: queuedId ?? crypto.randomUUID(),
          kind: "message",
          role: "user",
          text: prompt!,
          skill,
          ...(ask ? { ask } : {}),
          ...(run.scheduled ? { scheduled: run.scheduled } : {}),
          ...((selection?.content ?? accepted?.content)?.length ? { content: selection?.content ?? accepted?.content } : {}),
          ...(sites.length ? { sites } : {}),
          context: artifact ? { artifactId: artifact.artifactId, kind: "page", title: artifact.title, url: artifact.url, capturedAt: artifact.capturedAt } : null,
          at: Date.now(),
        };
        try { await appendConversationItem(sessionId, item); }
        catch (error) {
          if (run.scheduled) throw error;
          // Nothing of the turn was written or published, so the run just gives up its slot.
          run.ended = true;
          this.#removeRun(run);
          await this.#settleSteers(sessionId);
          this.#refreshShield();
          this.#notice = "Could not save this message. Its prepared attachments are still available; try sending again.";
          await this.#sidebarHub.broadcastSnapshot();
          return;
        }
        selection?.commit();
        askSelection?.commit();
        run.turnPersisted = true;
        items = [...items, item];
        if (queuedId) await this.#changeQueue(sessionId, queue => {
          this.#queueClaims.delete(queuedId);
          return queue.filter(message => message.id !== queuedId);
        });
      }
      const userIndex = items.findLastIndex(isTurnStart);
      const userItem = items[userIndex] as UserMessageItem;
      this.#retryable.delete(sessionId);

      this.#sidebarHub.publishRunEvent(runId, "run.started", { prompt: userItem.text, page: userItem.context, ask: userItem.ask ?? null, content: userItem.content, retry, ...(userItem.scheduled ? { scheduled: userItem.scheduled } : {}) });
      await this.#writeCheckpoint(run, "running", "");

      // Pi owns assistant/tool replay during this run. Persisted tool items are
      // display/audit records only; earlier runs reach the model as message
      // text, run digests, and the latest compaction summary (see AgentLoop).
      // History ends at this turn's user message: on a retry, the failed
      // attempt's interim/partial assistant text and digest stay stored but are
      // not sent, so the model answers the original prompt afresh against a new
      // page capture. Its page effects are never replayed. A compaction the
      // failed attempt made is kept, so it is not summarized again, and so are
      // its delivered steers, which are the user's guidance for this turn.
      const transcript = [...items.slice(0, userIndex + 1), ...items.slice(userIndex + 1).filter((item) =>
        item.kind === "compaction" || (item.kind === "message" && item.role === "user"))];
      for (const item of transcript.slice(userIndex)) {
        if (item.kind === "message" && item.role === "user" && item.skill) scope.skills.set(item.skill.name, item.skill);
      }
      await this.#runAgentLoop(runId, transcript, catalog, personal, artifact, auth, pageInUse);
    } catch (error) {
      await this.#abandonRun(run, error);
    }
  }

  async #captureScheduledPage(tabs: TabController, run: ActiveRun): Promise<Awaited<ReturnType<TabController["captureActivePage"]>>> {
    let tabId: number | null = null;
    try {
      run.controller.signal.throwIfAborted();
      tabId = await tabs.createTab(run.scheduled!.url);
      this.#workspace.agentTabs.set(tabId, { role: "agent", sessionId: run.sessionId, lastUsedAt: this.#clock.now() });
      await tabs.tagAgentTab(tabId, { v: 2, role: "agent", sessionId: run.sessionId, lastUsedAt: this.#clock.now() });
      await tabs.hideTab(tabId);
      await tabs.waitUntilReady(tabId, run.controller.signal);
      const bound = await tabs.forTab(tabId);
      const outcome = await bound.snapshot();
      if (!outcome.ok) return outcome;
      const artifact = bound.currentAttachment()!;
      return { ok: true, value: { artifact, snapshot: outcome.value } };
    } catch {
      if (tabId !== null) {
        await tabs.closeTab(tabId).catch(() => {});
        this.#workspace.agentTabs.delete(tabId);
      }
      return { ok: false, error: { code: "UNSUPPORTED_PAGE", message: "The scheduled target could not be attached. Open its HTTP(S) URL in an agent tab to try again.", retryable: false, phase: "page" } };
    } finally { void this.#queueAgentTabSync(); }
  }

  async #runAgentLoop(runId: string, transcript: ConversationItem[], catalog: SkillSummary[], personal: Personalization,
    artifact: ContextArtifact | null, auth: ProviderAuth, pageInUse: { tabId: number } | null): Promise<void> {
    const run = this.#run(runId);
    if (!run) return;

    const settings = await this.#getValidatedSettings();
    // Titles a new session from its first prompt and records the model for the history list.
    // The index only lags on failure, so a failed write never stops the run.
    await touchSession(run.sessionId, { prompt: transcript.findLast(isTurnStart)?.text, modelId: settings.modelId, scheduled: run.scheduled }).catch(() => {});
    await this.#publishSessions();
    const record: RunRecord = {
      runId, modelId: settings.modelId, reasoningEffort: settings.reasoningEffort, startedAt: Date.now(), endedAt: null, status: "running", error: null,
      providerResponses: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, toolCalls: [],
    };
    // From here the session's export describes this run, live, replacing its previous run's.
    const diagnostics = run.diagnostics;
    diagnostics.record = record;
    this.#keepDiagnostics(run.sessionId, diagnostics);
    // Pi prices each response from its bundled catalog; a model it does not
    // list (an account-catalog model) is given zero prices, so no estimate.
    const model = this.#provider.getModel(settings.modelId);
    const priced = auth.method === "api-key" && model !== null && (model.cost.input > 0 || model.cost.output > 0);
    const runUsage = newRunUsage(runId, auth.method, settings.modelId, priced);
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
      conversationId: run.sessionId,
      modelId: settings.modelId,
      reasoningEffort: settings.reasoningEffort,
      transcript,
      skills: catalog,
      instructions: personal.instructions,
      siteNotes: personal.siteNotes,
      memoryIndex: personal.memoryIndex,
      ...(personal.mcpTools.length && this.#mcp ? { mcp: { tools: personal.mcpTools, call: this.#mcp.call.bind(this.#mcp) } } : {}),
      contextArtifact: artifact,
      pageInUse,
      auth,
      onContext: (context) => { diagnostics.latestContext = context; },
      onUsage: (usage) => {
        record.providerResponses += 1;
        record.usage.input += usage.input;
        record.usage.output += usage.output;
        record.usage.cacheRead += usage.cacheRead;
        record.usage.cacheWrite += usage.cacheWrite;
        record.usage.totalTokens += usage.totalTokens;
        record.usage.cost += usage.cost.total;
        runUsage.responses += 1;
        runUsage.input += usage.input;
        runUsage.cacheRead += usage.cacheRead;
        runUsage.cacheWrite += usage.cacheWrite;
        runUsage.output += usage.output;
        runUsage.reasoning += usage.reasoning ?? 0;
        if (runUsage.costUsd !== null) runUsage.costUsd += usage.cost.total;
        if (this.#run(runId) !== run || !hasTokens(runUsage)) return;
        run.usage = { ...runUsage };
        this.#sidebarHub.publishRunEvent(runId, "run.usage", { usage: run.usage });
      },
      onToolOutput: (call, result, timing) => {
        // Programs open, navigate, and use agent tabs; the sidebar lists them with their titles and last use.
        if (this.#workspace.agentTabs.size > 0) void this.#queueAgentTabSync();
        record.toolCalls.push({
          callId: call.id, name: call.name, startedAt: new Date(timing.startedAt).toISOString(), durationMs: timing.endedAt - timing.startedAt,
          ok: result.ok, code: result.code ?? null, outputChars: result.summary.length, truncatedOutput: result.summary.includes("[Output truncated:"),
        });
        const output = JSON.stringify({ call, result, timing: { startedAt: new Date(timing.startedAt).toISOString(), durationMs: timing.endedAt - timing.startedAt } }, null, 2);
        diagnostics.outputs.push(output);
        diagnostics.outputChars += output.length;
        while (diagnostics.outputChars > MAX_DEBUG_OUTPUT_CHARS && diagnostics.outputs.length) {
          diagnostics.outputChars -= diagnostics.outputs.shift()!.length;
          diagnostics.outputTruncated = true;
        }
      },
      signal: run.controller.signal,
      onDelta: (delta) => {
        if (this.#run(runId) !== run) return;
        run.partialAssistantText += delta;
        coalesced += delta;
        if (coalesced.length >= DELTA_COALESCE_BYTES || Date.now() - lastFlush >= DELTA_COALESCE_MS) flushDelta();
        void this.#maybeCheckpoint(run);
      },
      onItem: async (item) => {
        await appendConversationItem(run.sessionId, item);
        if (item.kind === "message" && item.role === "assistant") run.partialAssistantText = "";
        if (item.kind === "message" && item.role === "user") {
          // A delivered steer: shown inline in the turn and no longer pending.
          await this.#changeQueue(run.sessionId, queue => queue.filter(message => message.id !== item.id), () => {
            flushDelta();
            this.#sidebarHub.publishRunEvent(runId, "steer.delivered", { item });
          });
        }
        await this.#writeCheckpoint(run, run.status, run.partialAssistantText);
        // No run event carries a compaction; a snapshot shows its marker at once.
        if (item.kind === "compaction") void this.#sidebarHub.broadcastSnapshot();
      },
      // Scheduled runs are unattended: they always ask, whatever the sidebar's mode.
      permissionMode: () => run.scheduled ? "ask" : this.#permissionMode,
      onApprovalPending: (request) => {
        if (this.#run(runId) !== run) return;
        flushDelta();
        run.pendingApproval = request;
        run.status = request ? "awaiting-approval" : "running";
        this.#syncWaiting(run);
        if (request) void this.#notifications?.pending(runId, run.sessionId, "approval");
        else void this.#notifications?.clearPending(runId);
        if (run.scheduled) void this.#scheduler.updateRun(run.scheduled.taskId, runId, request ? "awaiting-approval" : "running").catch(() => {});
        void this.#sidebarHub.broadcastSnapshot();
      },
      onHelpPending: (request) => {
        if (this.#run(runId) !== run) return;
        flushDelta();
        run.pendingHelp = request;
        if (run.status !== "cancelling") run.status = request ? "awaiting-help" : "running";
        this.#syncWaiting(run);
        if (request) void this.#notifications?.pending(runId, run.sessionId, "help");
        else void this.#notifications?.clearPending(runId);
        if (run.scheduled) void this.#scheduler.updateRun(run.scheduled.taskId, runId, request ? "awaiting-help" : "running").catch(() => {});
        // The help tab's shield comes off while the request is open.
        this.#refreshShield();
        // Recorded when the pause opens; the run's next item records it running again.
        if (request) void this.#writeCheckpoint(run, run.status, run.partialAssistantText);
        void this.#sidebarHub.broadcastSnapshot();
      },
      userNotes: () => {
        const notes = [...run.takeovers].map((id) => `Note: the user took over /agent-tabs/${id}/page.md while watching it, so they may have changed that page. Read a fresh snapshot of it before relying on earlier observations.`);
        run.takeovers.clear();
        return notes;
      },
    });

    this.#keepRunTabsAlive(runStartedAt);
    record.endedAt = Date.now();
    record.status = result.status;
    if (result.status === "failed") record.error = result.error;
    if (this.#run(runId) !== run) return;
    flushDelta();

    // Written after the run's last message, so a replayed digest follows the
    // answer it describes, and before the terminal event, so a run started
    // right after it sees the digest. A failed write only loses the digest.
    // The run's usage follows its digest, under the id the sidebar gives the
    // item it builds from `run.usage`; the session total counts it once the index is touched.
    const persistDigestAndUsage = async () => {
      const digest = buildRunDigest(run.agentLoop.digestSteps(), result.status, result.status === "failed" ? result.error.message : null);
      if (digest) await appendConversationItem(run.sessionId, { id: crypto.randomUUID(), kind: "run-digest", digest, at: Date.now() }).catch(() => {});
      if (run.usage) await appendConversationItem(run.sessionId, { id: `usage-${runId}`, kind: "run-usage", usage: run.usage, at: Date.now() }).catch(() => {});
    };
    const finish = () => this.#endRun(run, result.status, this.#clock.now() - runStartedAt);
    if (result.status === "completed") {
      const messageId = result.finalMessageId ?? (await this.#persistEmptyFinalMessage(run.sessionId));
      await persistDigestAndUsage();
      run.outcome = "completed";
      this.#sidebarHub.publishRunEvent(runId, "run.completed", { messageId });
      await finish();
      await this.#dispatchFollowUp(run.sessionId);
      return;
    }
    if (result.status === "cancelled") {
      const messageId = result.partialText ? await this.#persistCancelledMessage(run.sessionId, result.partialText) : null;
      await persistDigestAndUsage();
      run.outcome = "cancelled";
      this.#sidebarHub.publishRunEvent(runId, "run.cancelled", { partialText: result.partialText, messageId });
      this.#retryable.set(run.sessionId, { hadPageEffect: result.hadPageEffect });
      await finish();
      return;
    }
    // Retry is only ever safe to offer when this run touched no page state;
    // a provider-level retryable code (e.g. rate limit, network) must not
    // imply retry-safety once a consequential tool call has already
    // committed a real effect on the page.
    const error: NormalizedError = result.hadPageEffect ? { ...result.error, retryable: false } : result.error;
    await persistDigestAndUsage();
    run.outcome = "failed";
    this.#sidebarHub.publishRunEvent(runId, "run.failed", error);
    this.#retryable.set(run.sessionId, { hadPageEffect: result.hadPageEffect });
    await finish();
  }

  /**
   * The terminal path every announced run takes exactly once, however it
   * ended: clears its checkpoint, adds its usage to the session total, records
   * the outcome for its scheduled task and notifications, releases its slot
   * and tab leases, and turns its undelivered steers into follow-ups. Each
   * step fails on its own, and the slot is released even if one throws.
   */
  async #endRun(run: ActiveRun, status: "completed" | "cancelled" | "failed", durationMs: number): Promise<void> {
    if (run.ended) return;
    // Synchronously, so no checkpoint write can be queued behind the clear below.
    run.ended = true;
    try {
      await clearRunCheckpoint(run.runId).catch(() => {});
      await touchSession(run.sessionId, { usage: run.usage ?? undefined, ...(run.scheduled ? { scheduled: run.scheduled } : {}) }).catch(() => {});
      if (run.scheduled) {
        await this.#scheduler.updateRun(run.scheduled.taskId, run.runId, status).catch(() => {});
        await this.#syncScheduleBadge().catch(() => {});
      }
      void this.#notifications?.finished(run.runId, run.sessionId, { scheduled: !!run.scheduled, durationMs, status }).catch(() => {});
    } finally {
      this.#approvalBadge?.clearRun(run.runId);
      this.#removeRun(run);
      this.#refreshShield();
    }
    // After the run slot is released, so no steer can be accepted for this run any more.
    await this.#settleSteers(run.sessionId).catch(() => {});
    await this.#publishSessions().catch(() => {});
  }

  /**
   * Ends a run that threw before reaching its terminal state (or during its
   * terminal path): stops it, writes a failed digest and its usage after its
   * turn, offers retry unless the turn may have committed an effect,
   * publishes `run.failed` unless a terminal event already went out, and then
   * takes `#endRun`. A no-op for a run that already ended.
   */
  async #abandonRun(run: ActiveRun, error: unknown): Promise<void> {
    if (run.ended || this.#run(run.runId) !== run) return;
    if (!run.outcome) {
      run.outcome = "failed";
      run.status = "cancelling";
      run.controller.abort();
      run.pendingApproval = null;
      run.pendingHelp = null;
      this.#syncWaiting(run);
      const failure: NormalizedError = {
        code: "PROTOCOL_ERROR",
        message: error instanceof ProviderStreamError ? error.message : "The run stopped unexpectedly. Its earlier actions may have taken effect.",
        retryable: false,
        phase: "persistence",
      };
      if (run.diagnostics.record) Object.assign(run.diagnostics.record, { endedAt: Date.now(), status: "failed", error: failure });
      if (run.turnPersisted) {
        const digest = buildRunDigest(run.agentLoop.digestSteps(), "failed", failure.message)
          ?? { version: 1, status: "failed", error: failure.message, entries: [], omittedEntries: 0 };
        await appendConversationItem(run.sessionId, { id: `digest-${run.runId}`, kind: "run-digest", digest, at: Date.now() }).catch(() => {});
        if (run.usage) await appendConversationItem(run.sessionId, { id: `usage-${run.runId}`, kind: "run-usage", usage: run.usage, at: Date.now() }).catch(() => {});
        // Effects are not known here, so a turn that started a program or a write is treated as having committed one.
        const items = await getConversation(run.sessionId).then((conversation) => conversation?.items ?? []).catch(() => null);
        this.#retryable.set(run.sessionId, { hadPageEffect: items === null || lastTurnMayHaveCommitted(items) });
      }
      if (!run.announced) {
        this.#sidebarHub.startRun(run.runId, run.sessionId);
        run.announced = true;
      }
      this.#sidebarHub.publishRunEvent(run.runId, "run.failed", failure);
    }
    await this.#endRun(run, run.outcome, this.#clock.now() - run.claimedAt);
    await this.#sidebarHub.broadcastSnapshot().catch(() => {});
  }

  /** Restarts the idle period of every agent tab used since `since`, so tabs a long run used are not closed right after it ends. */
  #keepRunTabsAlive(since: number): void {
    const now = this.#clock.now();
    let touched = false;
    for (const tab of this.#workspace.agentTabs.values()) {
      if (tab.lastUsedAt < since) continue;
      tab.lastUsedAt = now;
      touched = true;
    }
    if (touched) void this.#queueAgentTabSync();
  }

  /** Persists a cancelled run's uncommitted partial text so the interruption stays visible after reload; never fed back into a future provider request. */
  async #persistCancelledMessage(sessionId: string, partialText: string): Promise<string> {
    const id = crypto.randomUUID();
    await appendConversationItem(sessionId, { id, kind: "message", role: "assistant", text: `${partialText}${RUN_CANCELLED_SUFFIX}`, at: Date.now() });
    return id;
  }


  /** Rare: the model produced neither text nor a tool call. Persist an empty final message so `run.completed` always has a real id. */
  async #persistEmptyFinalMessage(sessionId: string): Promise<string> {
    const id = crypto.randomUUID();
    await appendConversationItem(sessionId, { id, kind: "message", role: "assistant", text: "", at: Date.now() });
    return id;
  }
  async #maybeCheckpoint(run: ActiveRun): Promise<void> {
    const now = Date.now();
    if (now - run.lastCheckpointAt < CHECKPOINT_MIN_INTERVAL_MS) return;
    run.lastCheckpointAt = now;
    await this.#writeCheckpoint(run, run.status, run.partialAssistantText);
  }

  /**
   * Saves the run's own checkpoint. The save is queued synchronously, before
   * this returns its promise, and never once the run has ended, so a late
   * write cannot recreate a checkpoint `#endRun` cleared.
   */
  async #writeCheckpoint(run: ActiveRun, status: RunLifecycleStatus, partialAssistantText: string): Promise<void> {
    if (run.ended) return;
    const checkpointStatus: RunStatus = status === "cancelling" ? "cancelled" : status;
    await saveRunCheckpoint({
      version: 3,
      runId: run.runId,
      sessionId: run.sessionId,
      status: checkpointStatus,
      partialAssistantText,
      usage: run.usage,
      lastSeq: this.#sidebarHub.lastSeq(run.runId),
      updatedAt: Date.now(),
    });
  }

  /**
   * Tells the badge whether `run` waits for the user: a confirmation or help
   * request is open and the run is not being cancelled. The badge keeps the
   * order runs began waiting in, for the toolbar click.
   */
  #syncWaiting(run: ActiveRun): void {
    this.#approvalBadge?.setPending(run.runId, !run.ended && run.status !== "cancelling" && (run.pendingApproval !== null || run.pendingHelp !== null));
  }

  #cancelRun(runId: string): void {
    const run = this.#run(runId);
    if (!run || run.status === "cancelling") return;
    run.status = "cancelling";
    this.#syncWaiting(run);
    void this.#notifications?.clearPending(runId);
    run.controller.abort();
  }

  #resolveHelp(runId: string, callId: string, outcome: HelpOutcome, note: string): void {
    const run = this.#run(runId);
    if (run?.pendingHelp?.call.id !== callId) return;
    run.agentLoop.resolveHelp(callId, outcome, note);
  }

  #resolveApproval(runId: string, callId: string, approved: boolean): void {
    const run = this.#run(runId);
    if (run?.pendingApproval?.call.id !== callId) return;
    if (approved) run.agentLoop.approve(callId);
    else run.agentLoop.deny(callId);
  }
}

type SessionCommand = Extract<SidebarCommand, { type: "session.create" | "session.open" | "session.delete" | "session.rename" | "session.pin" }>;

/**
 * Whether the last turn started a browser program. Run checkpoints record no
 * effects, so after an interruption any started program may have committed one.
 */
/** After an interruption: the last turn ran a browser program, or started a call of a connected account's tool not marked read-only. */
function lastTurnMayHaveCommitted(items: readonly ConversationItem[]): boolean {
  return items.slice(items.findLastIndex(isTurnStart) + 1).some((item) => item.kind === "tool-call" &&
    (item.call.name === "browser_program" || (item.call.mcp !== undefined && !item.call.mcp.readOnly)));
}

function toAgentTabSummary(id: number, tab: AgentTab, snapshot: TabSnapshot): AgentTabSummary {
  const icon = snapshot.favIconUrl;
  return {
    id,
    role: tab.role,
    title: (snapshot.title ?? "").slice(0, MAX_TAB_TITLE_CHARS),
    url: snapshot.url ?? "",
    favIconUrl: icon?.startsWith("data:image/") && icon.length <= MAX_FAVICON_CHARS ? icon : null,
    lastUsedAt: tab.lastUsedAt,
  };
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
