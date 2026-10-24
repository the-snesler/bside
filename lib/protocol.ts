/**
 * Shared, versioned wire contract between background, content scripts, and
 * extension UI surfaces. Every cross-context message is a JSON-compatible
 * discriminated union carrying an explicit `v: 1` envelope version.
 *
 * This file grows additively as later slices introduce new message types and
 * new fields on existing interfaces; never add ad-hoc message names outside
 * this contract, and never introduce a second representation of a type
 * already defined here.
 */

import type {
  CaptureGeometry,
  DomAction,
  ElementTarget,
  HelpKind,
  PageArtifactSummary,
  PageErrorCode,
  PageFindResult,
  PageSnapshot,
  SearchResult,
  ToolCall,
  ToolResult,
} from "@/lib/domain/tools";
import type { Conversation, ConversationItem, ConversationSummary, HistoryRetention, HistorySettingsV1, QueuedMessage } from "@/lib/domain/conversation";
import { HISTORY_RETENTIONS } from "@/lib/domain/conversation";
import { MAX_HELP_NOTE_CHARS } from "@/lib/domain/tools";
import { REASONING_EFFORTS, type AppSettingsV1, type ChatGPTStatus, type ProviderDefinition } from "@/lib/domain/provider";
import type { RunUsageV1 } from "@/lib/domain/usage";
import { isSkill, isSkillName, type Skill, type SkillSummary } from "@/lib/domain/skills";
import { isCustomInstructionsText, isSiteNote, isSiteOrigin, type SiteNote } from "@/lib/domain/instructions";
import type { MemoryApproval, MemoryChange } from "@/lib/domain/memory";
import { isSessionId, MAX_SESSION_TITLE_LEN, validateDomAction, validateElementTarget } from "@/lib/validation";

// ---------------------------------------------------------------------------
// Content script <-> background: PageRequest / PageResponse (tabs.sendMessage)
// ---------------------------------------------------------------------------

export const MAX_SNAPSHOT_CHARS = 40_000;
export const MAX_FIND_QUERY_LEN = 200;

export interface PageHealthRequest {
  v: 1;
  id: string;
  type: "page.health";
}

export interface PageSnapshotRequest {
  v: 1;
  id: string;
  type: "page.snapshot";
  tabId: number;
  offset: number;
  maxChars: number;
}

export interface PageFindRequest {
  v: 1;
  id: string;
  type: "page.find";
  tabId: number;
  query: string;
}

export interface PageSearchResultsRequest {
  v: 1;
  id: string;
  type: "page.search-results";
  tabId: number;
}

export interface PageExecuteRequest {
  v: 1;
  id: string;
  type: "page.execute";
  tabId: number;
  action: DomAction;
}

/**
 * The page shield over a watched agent tab: `"working"` while the tab's
 * session has the active run, `"idle"` otherwise, `"off"` when the tab is not
 * watched, the user took over, or a help request is open for it.
 */
export type PageShieldState = "off" | "working" | "idle";
export const PAGE_SHIELD_STATES: readonly PageShieldState[] = ["off", "working", "idle"];

/** Shows, updates, or removes the page shield. Carries only the state: no page text, selectors, or model output. */
export interface PageShieldRequest {
  v: 1;
  id: string;
  type: "page.shield";
  tabId: number;
  shield: PageShieldState;
}

/**
 * Measures the page for a screenshot: the viewport, the page size, and the
 * target element's box (a ref must come from the current document). The
 * page shield, if showing, is hidden until `page.capture-done` (or a short
 * timeout) so it is not in the image; it keeps blocking the user's input.
 */
export interface PageCapturePrepareRequest {
  v: 1;
  id: string;
  type: "page.capture-prepare";
  tabId: number;
  target: ElementTarget | null;
}

/** Ends a capture: the page shield shows again if it was hidden for it. */
export interface PageCaptureDoneRequest {
  v: 1;
  id: string;
  type: "page.capture-done";
  tabId: number;
}

export type PageRequest = PageHealthRequest | PageSnapshotRequest | PageFindRequest | PageSearchResultsRequest | PageExecuteRequest | PageShieldRequest |
  PageCapturePrepareRequest | PageCaptureDoneRequest;

export interface PageHealthResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.health";
  url: string;
}

export interface PageSnapshotResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.snapshot";
  snapshot: PageSnapshot;
}

export interface PageFindResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.find";
  result: PageFindResult;
}

export interface PageSearchResultsResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.search-results";
  results: SearchResult[];
  url: string;
  excerpt: string;
}

export interface PageExecuteResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.execute";
  result: ToolResult;
  documentId: string;
}

export interface PageShieldResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.shield";
}

export interface PageCapturePrepareResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.capture-prepare";
  geometry: CaptureGeometry;
}

export interface PageCaptureDoneResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.capture-done";
}

export interface PageErrorResponse {
  v: 1;
  id: string;
  ok: false;
  error: NormalizedError;
}

export type PageResponse =
  | PageHealthResponse
  | PageSnapshotResponse
  | PageFindResponse
  | PageSearchResultsResponse
  | PageExecuteResponse
  | PageShieldResponse
  | PageCapturePrepareResponse
  | PageCaptureDoneResponse
  | PageErrorResponse;

export function isPageHealthRequest(value: unknown): value is PageHealthRequest {
  return isEnvelope(value) && value.type === "page.health";
}

export function isPageSnapshotRequest(value: unknown): value is PageSnapshotRequest {
  if (!isEnvelope(value) || value.type !== "page.snapshot") return false;
  const candidate = value as Record<string, unknown>;
  return (
    isTabId(candidate.tabId) &&
    Number.isSafeInteger(candidate.offset) && (candidate.offset as number) >= 0 &&
    Number.isSafeInteger(candidate.maxChars) && (candidate.maxChars as number) >= 500 && (candidate.maxChars as number) <= MAX_SNAPSHOT_CHARS
  );
}

export function isPageFindRequest(value: unknown): value is PageFindRequest {
  if (!isEnvelope(value) || value.type !== "page.find") return false;
  const candidate = value as Record<string, unknown>;
  return isTabId(candidate.tabId) && typeof candidate.query === "string" &&
    candidate.query.trim().length > 0 && candidate.query.length <= MAX_FIND_QUERY_LEN;
}

export function isPageSearchResultsRequest(value: unknown): value is PageSearchResultsRequest {
  return isEnvelope(value) && value.type === "page.search-results" && isTabId((value as Record<string, unknown>).tabId);
}

export function isPageExecuteRequest(value: unknown): value is PageExecuteRequest {
  if (!isEnvelope(value) || value.type !== "page.execute") return false;
  const candidate = value as Record<string, unknown>;
  return isTabId(candidate.tabId) && validateDomAction(candidate.action) !== null;
}

export function isPageShieldRequest(value: unknown): value is PageShieldRequest {
  if (!isEnvelope(value) || value.type !== "page.shield") return false;
  const candidate = value as Record<string, unknown>;
  return isTabId(candidate.tabId) && (PAGE_SHIELD_STATES as readonly unknown[]).includes(candidate.shield);
}

export function isPageCapturePrepareRequest(value: unknown): value is PageCapturePrepareRequest {
  if (!isEnvelope(value) || value.type !== "page.capture-prepare") return false;
  const candidate = value as Record<string, unknown>;
  return isTabId(candidate.tabId) && (candidate.target === null || validateElementTarget(candidate.target) !== null);
}

export function isPageCaptureDoneRequest(value: unknown): value is PageCaptureDoneRequest {
  return isEnvelope(value) && value.type === "page.capture-done" && isTabId((value as Record<string, unknown>).tabId);
}

// ---------------------------------------------------------------------------
// Content script -> background: ContentMessage (runtime.sendMessage)
//
// Accepted only from this extension's top-frame content script in an HTTP(S)
// tab; the background acts on `sender.tab.id`, never on an id in the message.
// ---------------------------------------------------------------------------

export type ContentMessage =
  /** Sent when the content script starts (and on a back/forward cache restore): asks for the shield state of its own tab. */
  | { v: 1; id: string; type: "shield.sync" }
  /** The user pressed the shield's "Take over" button (a trusted click). */
  | { v: 1; id: string; type: "shield.takeover" };

export interface ContentMessageResponse {
  v: 1;
  id: string;
  ok: true;
  shield: PageShieldState;
}

export function isContentMessage(value: unknown): value is ContentMessage {
  return isEnvelope(value) && (value.type === "shield.sync" || value.type === "shield.takeover");
}

export function isContentMessageResponse(value: unknown): value is ContentMessageResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.v === 1 && candidate.ok === true && (PAGE_SHIELD_STATES as readonly unknown[]).includes(candidate.shield);
}

function isTabId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isEnvelope(value: unknown): value is { v: 1; id: string; type: string } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.v === 1 && typeof candidate.id === "string" && typeof candidate.type === "string";
}

// ---------------------------------------------------------------------------
// Normalized errors (shared across page and, from Slice 3 on, provider phases)
// ---------------------------------------------------------------------------

export interface NormalizedError {
  code:
    | "AUTHENTICATION"
    | "RATE_LIMIT"
    | "INVALID_REQUEST"
    | "TIMEOUT"
    | "NETWORK"
    | "PROVIDER_UNAVAILABLE"
    | "PROVIDER_RESPONSE_FAILED"
    | "CONTEXT_OVERFLOW"
    | "INVALID_TOOL_ARGUMENTS"
    | "LIMIT_EXCEEDED"
    | "PROTOCOL_ERROR"
    | PageErrorCode;
  message: string;
  retryable: boolean;
  phase: "setup" | "page" | "provider" | "tool" | "persistence";
  status?: number;
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Sidebar <-> background: the "agent-sidebar:v1" Port
//
// Slice 2 only implements state.subscribe / state.snapshot / page.attached.
// Slice 3+ extend SidebarCommand/SidebarEvent/RuntimeSnapshot with run
// sequencing, deltas, and gap replay on this same Port rather than a new one.
// ---------------------------------------------------------------------------

export const SIDEBAR_PORT_NAME = "agent-sidebar:v1";

export type SidebarCommand =
  | { v: 1; id: string; type: "skills.list" }
  | { v: 1; id: string; type: "tabs.list" }
  | { v: 1; id: string; type: "tabs.focus"; tabId: number }
  /** Closes one session's hidden agent tabs (the sidebar sends the open session's); refused while a run is active. */
  | { v: 1; id: string; type: "tabs.closeAgentTabs"; sessionId: string }
  /**
   * Shows one of the open session's agent tabs next to the active tab and switches to it, so the user can watch it.
   * bside keeps the tab: switching to any other tab hides it again. Watching another tab replaces this one.
   */
  | { v: 1; id: string; type: "tabs.watch"; tabId: number }
  /** Ends watching: switches back to the tab the user watched from (or a neighbour if it closed), hiding the watched tab again. */
  | { v: 1; id: string; type: "tabs.unwatch" }
  /** Removes the page shield from the watched agent tab until watching ends, like the shield's own "Take over" button. */
  | { v: 1; id: string; type: "tabs.takeOver"; tabId: number }
  | { v: 1; id: string; type: "settings.save"; settings: AppSettingsV1 }
  /** Looks up the site note to edit for a page URL. Answered with `siteNote.loaded` to the requesting sidebar only. */
  | { v: 1; id: string; type: "siteNote.get"; url: string }
  /**
   * "Remember something about this site": adds or replaces the note for one
   * origin. The sidebar's only write to user-authored data; the background
   * revalidates it. Answered with `siteNote.saved` to the requesting sidebar only.
   */
  | { v: 1; id: string; type: "siteNote.save"; note: SiteNote }
  /** Exports one session with its scratch files; run diagnostics, model input, and tool output are included only for the latest run's session. Answered with `context.exported` to the requesting sidebar only. */
  | { v: 1; id: string; type: "context.export"; sessionId: string }
  | { v: 1; id: string; type: "state.subscribe"; lastSeq: number | null }
  /** "New chat": opens an empty session (reusing the open one if it is an untouched new chat), which starts with an empty /workspace. */
  | { v: 1; id: string; type: "session.create" }
  /** Answered with `session.listed` to the requesting sidebar; every sidebar also gets `session.listed` whenever the index changes. */
  | { v: 1; id: string; type: "session.list" }
  /** Allowed while a run is active elsewhere; the run keeps its own session. Leaving an untouched new chat (no items, pin, or user title) deletes it. */
  | { v: 1; id: string; type: "session.open"; sessionId: string }
  /**
   * Refused for the active run's session. Deleting the open session opens the most recent remaining one, or a new empty one.
   * The session's scratch files are deleted with it; its agent tabs are closed, or with `closeAgentTabs: false` shown and handed to the user.
   */
  | { v: 1; id: string; type: "session.delete"; sessionId: string; closeAgentTabs: boolean }
  /** Sets a user title, which is never auto-overwritten. */
  | { v: 1; id: string; type: "session.rename"; sessionId: string; title: string }
  | { v: 1; id: string; type: "session.pin"; sessionId: string; pinned: boolean }
  /**
   * Starts a run in the open session. While the active run is in the open
   * session, queues the prompt as a follow-up instead: it starts the next
   * turn once that run completes (not after a failure or cancellation).
   */
  | { v: 1; id: string; type: "run.start"; prompt: string }
  /**
   * Guidance for the active run, delivered as a user message at its next tool
   * boundary, within the same turn and budgets. If `runId` is no longer
   * running (finished or cancelling), handled exactly like `run.start`.
   */
  | { v: 1; id: string; type: "run.steer"; runId: string; text: string }
  /** Discards a queued follow-up, or a steer not yet delivered, from a session's queue. */
  | { v: 1; id: string; type: "queue.remove"; sessionId: string; messageId: string }
  /** Starts a run with a queued follow-up of the open session now; refused while any run is active. */
  | { v: 1; id: string; type: "queue.send"; sessionId: string; messageId: string }
  /** Re-runs the open session's last turn's existing user message; accepted only when no run is active and that turn ended failed, cancelled, or interrupted without a committed page effect. */
  | { v: 1; id: string; type: "run.retry" }
  | { v: 1; id: string; type: "run.cancel"; runId: string }
  | { v: 1; id: string; type: "action.approve"; runId: string; callId: string }
  | { v: 1; id: string; type: "action.deny"; runId: string; callId: string }
  /** Answers the active run's pending `request_user_help`: `done` (the user finished in the tab) or `unable`, with an optional short note. */
  | { v: 1; id: string; type: "help.resolve"; runId: string; callId: string; outcome: HelpOutcome; note: string };

export type HelpOutcome = "done" | "unable";

export interface ApprovalRequest {
  call: ToolCall;
  origin: string;
  display: string;
  target: { ref?: string; role?: string; name?: string };
  /**
   * Set when the user's Ask memory policy gates a change a browser program
   * (`call`) is making, rather than a `request_action_confirmation` call.
   */
  memory?: MemoryApproval;
}

/** A run paused on `request_user_help`. `reason` is untrusted model text: render it as text only. */
export interface HelpRequest {
  call: ToolCall;
  /** One of the run's session's agent tabs (search tabs included). */
  tabId: number;
  kind: HelpKind;
  reason: string;
}

export interface RuntimeSnapshot {
  skills?: SkillSummary[];
  /** The open session. */
  conversation: Conversation;
  credential: { configured: boolean; maskedSuffix: string | null; chatgpt: ChatGPTStatus };
  provider: ProviderDefinition;
  settings: AppSettingsV1;
  page: AttachedPage | null;
  agentTabs: AgentTabsState;
  /** The open session's queued follow-ups and undelivered steers, oldest first. */
  queue: QueuedMessage[];
  /** The single active run, which may belong to a session other than the open one. */
  activeRun: {
    runId: string;
    conversationId: string;
    status: "running" | "awaiting-approval" | "awaiting-help" | "cancelling";
    partialAssistantText: string;
    pendingApproval: ApprovalRequest | null;
    pendingHelp: HelpRequest | null;
    /** Usage of the run's provider responses so far; `null` until one reports tokens. */
    usage: RunUsageV1 | null;
  } | null;
  lastSeq: number;
  notice: string | null;
}

export interface EventBase<T extends string, P> {
  v: 1;
  runId: string | null;
  /** Run events: the run's session. `state.snapshot`: the open session. Events not about one session: `null`. */
  conversationId: string | null;
  seq: number;
  type: T;
  at: number;
  payload: P;
}

/** Appended to a cancelled run's uncommitted partial text before persisting it, so the interruption stays visible after reload without ever being fed back into a future provider request. */
export const RUN_CANCELLED_SUFFIX = "\n\n[Stopped: cancelled before this response finished.]";

export type SidebarEvent =
  | EventBase<"skills.listed", { skills: SkillSummary[] }>
  | EventBase<"tabs.listed", { tabs: TabMention[] }>
  | EventBase<"context.exported", { requestId: string; markdown: string; filename: string }>
  /** `origin` is the page URL's origin, `null` for a page that cannot have a note; `note` is the one covering it, if any. */
  | EventBase<"siteNote.loaded", { requestId: string; origin: string | null; note: SiteNote | null }>
  /** `note` as saved, or `null` with a safe `error`. */
  | EventBase<"siteNote.saved", { requestId: string; note: SiteNote | null; error: string | null }>
  | EventBase<"state.snapshot", RuntimeSnapshot>
  | EventBase<"session.listed", { sessions: ConversationSummary[] }>
  | EventBase<"page.attached", AttachedPage | null>
  | EventBase<"agent-tabs.changed", AgentTabsState>
  /** A session's queue after it changed; `conversationId` is that session. Not run-sequenced. */
  | EventBase<"queue.changed", { messages: QueuedMessage[] }>
  | EventBase<"run.started", { prompt: string; page: PageArtifactSummary | null; retry: boolean }>
  | EventBase<"assistant.delta", { delta: string }>
  | EventBase<"tool.requested", { call: ToolCall; display: string }>
  | EventBase<"action.approval-required", ApprovalRequest>
  | EventBase<"help.requested", HelpRequest>
  /** `memory`: what a browser program saved or removed, names and taint only. */
  | EventBase<"tool.result", { callId: string; result: ToolResult; memory?: MemoryChange[] }>
  /** A steer reached the model; `item` is the persisted user message (`delivery: "steer"`), whose id is the queued message's. */
  | EventBase<"steer.delivered", { item: ConversationItem }>
  /** The run's cumulative usage after a provider response. At the run's end it is persisted as the `run-usage` item `usage-<runId>`. */
  | EventBase<"run.usage", { usage: RunUsageV1 }>
  | EventBase<"run.completed", { messageId: string }>
  | EventBase<"run.cancelled", { partialText: string; messageId: string | null }>
  | EventBase<"run.failed", NormalizedError>;

export function isSidebarCommand(value: unknown): value is SidebarCommand {
  if (!isEnvelope(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "skills.list") return true;
  if (candidate.type === "tabs.list") return true;
  if (candidate.type === "tabs.focus") return Number.isSafeInteger(candidate.tabId);
  if (candidate.type === "tabs.closeAgentTabs") return isSessionId(candidate.sessionId);
  if (candidate.type === "tabs.watch") return Number.isSafeInteger(candidate.tabId);
  if (candidate.type === "tabs.unwatch") return true;
  if (candidate.type === "tabs.takeOver") return Number.isSafeInteger(candidate.tabId);
  if (candidate.type === "settings.save") return isAppSettings(candidate.settings);
  if (candidate.type === "siteNote.get") return typeof candidate.url === "string" && candidate.url.length <= 8_192;
  if (candidate.type === "siteNote.save") return isSiteNote(candidate.note);
  if (candidate.type === "context.export") return isSessionId(candidate.sessionId);
  if (candidate.type === "session.create" || candidate.type === "session.list") return true;
  if (candidate.type === "session.open") return isSessionId(candidate.sessionId);
  if (candidate.type === "session.delete") return isSessionId(candidate.sessionId) && typeof candidate.closeAgentTabs === "boolean";
  if (candidate.type === "session.rename") {
    return isSessionId(candidate.sessionId) && typeof candidate.title === "string" && candidate.title.length <= MAX_SESSION_TITLE_LEN * 4;
  }
  if (candidate.type === "session.pin") return isSessionId(candidate.sessionId) && typeof candidate.pinned === "boolean";
  if (candidate.type === "state.subscribe") {
    return candidate.lastSeq === null || typeof candidate.lastSeq === "number";
  }
  if (candidate.type === "run.start") return typeof candidate.prompt === "string";
  if (candidate.type === "run.steer") return typeof candidate.runId === "string" && typeof candidate.text === "string";
  if (candidate.type === "queue.remove" || candidate.type === "queue.send") {
    return isSessionId(candidate.sessionId) && typeof candidate.messageId === "string";
  }
  if (candidate.type === "run.retry") return true;
  if (candidate.type === "run.cancel") return typeof candidate.runId === "string";
  if (candidate.type === "action.approve" || candidate.type === "action.deny") {
    return typeof candidate.runId === "string" && typeof candidate.callId === "string";
  }
  if (candidate.type === "help.resolve") {
    return typeof candidate.runId === "string" && typeof candidate.callId === "string" &&
      (candidate.outcome === "done" || candidate.outcome === "unable") &&
      typeof candidate.note === "string" && candidate.note.length <= MAX_HELP_NOTE_CHARS;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Options page <-> background: credential and settings (runtime.sendMessage)
//
// Accept these only when `sender.id === browser.runtime.id` and
// `sender.url === browser.runtime.getURL("options.html")`; never expose
// credential methods on the sidebar Port.
// ---------------------------------------------------------------------------

export type SkillsRequest =
  | { v: 1; id: string; type: "skills.list" }
  | { v: 1; id: string; type: "skills.save"; skill: Skill }
  | { v: 1; id: string; type: "skills.delete"; name: string };

export type SkillsResponse =
  | { v: 1; id: string; ok: true; skills: Skill[]; builtinNames: string[] }
  | { v: 1; id: string; ok: false; error: NormalizedError };

export function isSkillsRequest(value: unknown): value is SkillsRequest {
  if (!isEnvelope(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "skills.list") return true;
  if (candidate.type === "skills.save") return isSkill(candidate.skill);
  if (candidate.type === "skills.delete") return isSkillName(candidate.name);
  return false;
}

/** Custom instructions; options page only. Saving blank text clears them. */
export type InstructionsRequest =
  | { v: 1; id: string; type: "instructions.get" }
  | { v: 1; id: string; type: "instructions.save"; text: string };

export type InstructionsResponse =
  | { v: 1; id: string; ok: true; text: string }
  | { v: 1; id: string; ok: false; error: NormalizedError };

export function isInstructionsRequest(value: unknown): value is InstructionsRequest {
  if (!isEnvelope(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "instructions.get") return true;
  if (candidate.type === "instructions.save") return isCustomInstructionsText(candidate.text);
  return false;
}

/** Site notes; options page only (the sidebar's single-note `siteNote.save` is the one exception). */
export type SiteNotesRequest =
  | { v: 1; id: string; type: "siteNotes.list" }
  /** Adds a note, or replaces the note with the same origin. */
  | { v: 1; id: string; type: "siteNotes.save"; note: SiteNote }
  | { v: 1; id: string; type: "siteNotes.delete"; origin: string };

export type SiteNotesResponse =
  | { v: 1; id: string; ok: true; notes: SiteNote[] }
  | { v: 1; id: string; ok: false; error: NormalizedError };

export function isSiteNotesRequest(value: unknown): value is SiteNotesRequest {
  if (!isEnvelope(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "siteNotes.list") return true;
  if (candidate.type === "siteNotes.save") return isSiteNote(candidate.note);
  if (candidate.type === "siteNotes.delete") return isSiteOrigin(candidate.origin);
  return false;
}

export type CredentialRequest =
  | { v: 1; id: string; type: "credentials.openai.status" }
  | { v: 1; id: string; type: "credentials.openai.save"; apiKey: string }
  | { v: 1; id: string; type: "credentials.openai.delete" }
  | { v: 1; id: string; type: "credentials.chatgpt.login" | "credentials.chatgpt.disconnect" | "credentials.chatgpt.test" | "credentials.chatgpt.notice.dismiss" };

export type CredentialResponse =
  | { v: 1; id: string; ok: true; configured: boolean; maskedSuffix: string | null; chatgpt: ChatGPTStatus; notice: string | null }
  | { v: 1; id: string; ok: false; error: NormalizedError };

export type SettingsRequest =
  | { v: 1; id: string; type: "settings.get" }
  | { v: 1; id: string; type: "settings.save"; settings: AppSettingsV1 };

export type SettingsResponse =
  | { v: 1; id: string; ok: true; settings: AppSettingsV1; provider: ProviderDefinition; notice: string | null }
  | { v: 1; id: string; ok: false; error: NormalizedError };

/** History retention and bulk deletion; options page only, like credentials and settings. */
export type HistoryRequest =
  | { v: 1; id: string; type: "history.get" }
  /** Saves the retention and prunes immediately. */
  | { v: 1; id: string; type: "history.retention.save"; retention: HistoryRetention }
  /** Deletes every session, pinned ones included, except the active run's; the open session is replaced by a new empty one. */
  | { v: 1; id: string; type: "history.deleteAll" };

export type HistoryResponse =
  | { v: 1; id: string; ok: true; settings: HistorySettingsV1; sessionCount: number; notice: string | null }
  | { v: 1; id: string; ok: false; error: NormalizedError };

export function isHistoryRequest(value: unknown): value is HistoryRequest {
  if (!isEnvelope(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "history.get" || candidate.type === "history.deleteAll") return true;
  if (candidate.type === "history.retention.save") return (HISTORY_RETENTIONS as readonly unknown[]).includes(candidate.retention);
  return false;
}

export function isCredentialRequest(value: unknown): value is CredentialRequest {
  if (!isEnvelope(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "credentials.openai.status") return true;
  if (candidate.type === "credentials.openai.save") return typeof candidate.apiKey === "string";
  if (candidate.type === "credentials.openai.delete") return true;
  if (candidate.type === "credentials.chatgpt.login" || candidate.type === "credentials.chatgpt.disconnect" || candidate.type === "credentials.chatgpt.test" ||
    candidate.type === "credentials.chatgpt.notice.dismiss") return true;
  return false;
}

export function isSettingsRequest(value: unknown): value is SettingsRequest {
  if (!isEnvelope(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "settings.get") return true;
  if (candidate.type === "settings.save") return isAppSettings(candidate.settings);
  return false;
}

export interface TabMention { id: number; title: string; url: string; path: string }

/** The active tab as the sidebar shows it; `tabId` tells it apart from an agent tab being watched. */
export interface AttachedPage extends PageArtifactSummary { tabId: number }

/** One agent tab as the sidebar lists it. `favIconUrl` is only ever a `data:image/` URL, so showing it fetches nothing. */
export interface AgentTabSummary {
  id: number;
  role: "agent" | "search";
  title: string;
  url: string;
  favIconUrl: string | null;
  /** When a program last used the tab; idle auto-close counts from this. */
  lastUsedAt: number;
}

export interface AgentTabsState {
  /** Agent tabs (search tabs included) per owning session id, oldest first; sessions with none are omitted. */
  bySession: Record<string, AgentTabSummary[]>;
  /** The agent tab the user is watching (shown and active), if any. */
  watching: number | null;
  /** The user took over the watched tab: its page shield is gone until watching ends. */
  takenOver: boolean;
}

export function isAppSettings(value: unknown): value is AppSettingsV1 {
  if (!value || typeof value !== "object") return false;
  const settings = value as AppSettingsV1;
  return Object.keys(value).length === 4 && settings.version === 1 && settings.providerId === "openai" &&
    typeof settings.modelId === "string" && /^[\w.:-]{1,200}$/.test(settings.modelId) &&
    REASONING_EFFORTS.includes(settings.reasoningEffort);
}
