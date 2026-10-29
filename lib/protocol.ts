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

import { isMcpArguments, MCP_CONTENT_LIMITS, type McpContentChoice, type McpContentSnapshot } from "@/lib/domain/mcp-content";
import type {
  CaptureGeometry,
  DomAction,
  ElementTarget,
  FrameOutline,
  HelpKind,
  PageArtifactSummary,
  PageErrorCode,
  PageFindResult,
  PageSnapshot,
  PageTable,
  SearchPage,
  ToolCall,
  ToolResult,
} from "@/lib/domain/tools";
import type { Conversation, ConversationItem, ConversationSummary, HistoryRetention, HistorySettingsV1, QueuedMessage } from "@/lib/domain/conversation";
import { HISTORY_RETENTIONS } from "@/lib/domain/conversation";
import { MAX_HELP_NOTE_CHARS, TABLE_LIMITS } from "@/lib/domain/tools";
import { isPermissionMode, type PermissionMode } from "@/lib/domain/permissions";
import { REASONING_EFFORTS, type AppSettingsV1, type ChatGPTStatus, type ProviderDefinition } from "@/lib/domain/provider";
import type { RunUsageV1 } from "@/lib/domain/usage";
import type { PdfFetchResult } from "@/lib/domain/pdf";
import { isSkill, isSkillName, type Skill, type SkillSummary } from "@/lib/domain/skills";
import { isCustomInstructionsText, isSiteNote, isSiteOrigin, type SiteNote } from "@/lib/domain/instructions";
import { isMemoryDraft, isMemoryName, MEMORY_WRITE_POLICIES, type MemoryApproval, type MemoryChange, type MemoryDraft, type MemoryEntry, type MemorySettingsV1 } from "@/lib/domain/memory";
import { isMcpToolName, MCP_TRUST_LEVELS, type McpApproval, type McpServerStatus, type McpTrust } from "@/lib/domain/mcp";
import { isMcpServerId } from "@/lib/mcp/servers";
import { isSessionId, isViewableImagePath, isWorkspacePath, MAX_SESSION_TITLE_LEN, validateDomAction, validateElementTarget, validateHttpUrl } from "@/lib/validation";
import type { AskContextV1 } from "@/lib/domain/ask";
import { isTaskDraft, isTaskId, type TaskDraft, type ScheduledTask, type ScheduledSource, type NotificationSettingsV1 } from "@/lib/domain/automation";

// ---------------------------------------------------------------------------
// Content script <-> background: PageRequest / PageResponse (tabs.sendMessage)
//
// The content script runs in every HTTP(S) frame. Each request names the frame
// it is for (`frameId`, Firefox's id: 0 is the top frame) and is sent with
// `tabs.sendMessage(tabId, request, { frameId })`; a content script answers
// only requests naming its own frame. Snapshot, find, search results, the
// shield, capture-done, and fetch-pdf are top-frame requests (`frameId` 0); health,
// outline, execute, table, capture-prepare, and menu-target may go to any frame. A frame other
// than the top renders its refs with the prefix the background names it by
// (`refPrefix`, e.g. `f3:`); the top frame's prefix is empty.
// ---------------------------------------------------------------------------

export const MAX_SNAPSHOT_CHARS = 40_000;
/** Most characters one `page.outline` may return (the top frame's whole outline). */
export const MAX_FRAME_OUTLINE_CHARS = 2_000_000;
export const MAX_FIND_QUERY_LEN = 200;

export interface PageHealthRequest {
  v: 1;
  id: string;
  type: "page.health";
  frameId: number;
}

export interface PageSnapshotRequest {
  v: 1;
  id: string;
  type: "page.snapshot";
  frameId: number;
  tabId: number;
  offset: number;
  maxChars: number;
}

export interface PageFindRequest {
  v: 1;
  id: string;
  type: "page.find";
  frameId: number;
  tabId: number;
  query: string;
}

export interface PageSearchResultsRequest {
  v: 1;
  id: string;
  type: "page.search-results";
  frameId: number;
  tabId: number;
}

/** One frame's whole outline, at most `maxChars`, with the cross-origin frames in it (`ChildFrame`). */
export interface PageOutlineRequest {
  v: 1;
  id: string;
  type: "page.outline";
  frameId: number;
  tabId: number;
  refPrefix: string;
  maxChars: number;
}

export interface PageExecuteRequest {
  v: 1;
  id: string;
  type: "page.execute";
  frameId: number;
  tabId: number;
  refPrefix: string;
  action: DomAction;
}

/** Reads one page of a table's data rows (`PageTable`); the target must name a table or grid in the frame's current document. */
export interface PageTableRequest {
  v: 1;
  id: string;
  type: "page.table";
  frameId: number;
  tabId: number;
  refPrefix: string;
  target: ElementTarget;
  offset: number;
  limit: number;
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
  frameId: number;
  tabId: number;
  shield: PageShieldState;
}

/**
 * Measures the page for a screenshot: the viewport, the page size, and the
 * target element's box (a ref must come from the current document), or with
 * `childFrameId`, the content box of that cross-origin child frame, to place
 * an element inside it. The page shield, if showing, is hidden until
 * `page.capture-done` (or a short timeout) so it is not in the image; it
 * keeps blocking the user's input.
 */
export interface PageCapturePrepareRequest {
  v: 1;
  id: string;
  type: "page.capture-prepare";
  frameId: number;
  tabId: number;
  refPrefix: string;
  target: ElementTarget | null;
  childFrameId: number | null;
}

/** Ends a capture: the page shield shows again if it was hidden for it. */
export interface PageCaptureDoneRequest {
  v: 1;
  id: string;
  type: "page.capture-done";
  frameId: number;
  tabId: number;
}

/**
 * Fetches a PDF for another tab, one showing it in Firefox's viewer, where no
 * content script runs (the background cannot fetch it: `connect-src`). With
 * `credentials: "include"` only from a page on the PDF's own origin.
 */
export interface PageFetchPdfRequest {
  v: 1;
  id: string;
  type: "page.fetch-pdf";
  frameId: number;
  tabId: number;
  url: string;
  credentials: "include" | "omit";
}

/**
 * Describes the element a context-menu click targeted (`menus.onClicked`'s
 * `targetElementId`, which only the clicked frame's document can resolve):
 * for "Ask bside about this image", its alt text or accessible label.
 */
export interface PageMenuTargetRequest {
  v: 1;
  id: string;
  type: "page.menu-target";
  frameId: number;
  tabId: number;
  targetElementId: number;
}

export type PageRequest = PageHealthRequest | PageSnapshotRequest | PageFindRequest | PageOutlineRequest | PageSearchResultsRequest | PageExecuteRequest |
  PageTableRequest | PageShieldRequest | PageCapturePrepareRequest | PageCaptureDoneRequest | PageFetchPdfRequest | PageMenuTargetRequest;

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
  /** Cross-origin frames in the outline; when there are any, the background composes the tab's outline instead. */
  frames: number;
}

export interface PageFindResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.find";
  result: PageFindResult;
  /** Cross-origin frames in the outline; when there are any, the background searches the composed outline instead. */
  frames: number;
}

export interface PageOutlineResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.outline";
  outline: FrameOutline;
}

export interface PageSearchResultsResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.search-results";
  page: SearchPage;
}

export interface PageExecuteResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.execute";
  result: ToolResult;
  documentId: string;
}

export interface PageTableResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.table";
  table: PageTable;
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

export interface PageFetchPdfResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.fetch-pdf";
  result: PdfFetchResult;
}

/** `alt`: untrusted page text, bounded by the background (`withAlt`); `null` when the element is gone or has none. */
export interface PageMenuTargetResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.menu-target";
  alt: string | null;
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
  | PageOutlineResponse
  | PageSearchResultsResponse
  | PageExecuteResponse
  | PageTableResponse
  | PageShieldResponse
  | PageCapturePrepareResponse
  | PageCaptureDoneResponse
  | PageFetchPdfResponse
  | PageMenuTargetResponse
  | PageErrorResponse;

export function isPageHealthRequest(value: unknown): value is PageHealthRequest {
  return isEnvelope(value) && value.type === "page.health" && isFrameId((value as Record<string, unknown>).frameId);
}

export function isPageSnapshotRequest(value: unknown): value is PageSnapshotRequest {
  if (!isEnvelope(value) || value.type !== "page.snapshot") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.frameId === 0 && isTabId(candidate.tabId) &&
    Number.isSafeInteger(candidate.offset) && (candidate.offset as number) >= 0 &&
    Number.isSafeInteger(candidate.maxChars) && (candidate.maxChars as number) >= 500 && (candidate.maxChars as number) <= MAX_SNAPSHOT_CHARS
  );
}

export function isPageFindRequest(value: unknown): value is PageFindRequest {
  if (!isEnvelope(value) || value.type !== "page.find") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.frameId === 0 && isTabId(candidate.tabId) && typeof candidate.query === "string" &&
    candidate.query.trim().length > 0 && candidate.query.length <= MAX_FIND_QUERY_LEN;
}

export function isPageOutlineRequest(value: unknown): value is PageOutlineRequest {
  if (!isEnvelope(value) || value.type !== "page.outline") return false;
  const candidate = value as Record<string, unknown>;
  return isFrameId(candidate.frameId) && isRefPrefix(candidate.frameId, candidate.refPrefix) && isTabId(candidate.tabId) &&
    Number.isSafeInteger(candidate.maxChars) && (candidate.maxChars as number) >= 500 && (candidate.maxChars as number) <= MAX_FRAME_OUTLINE_CHARS;
}

export function isPageSearchResultsRequest(value: unknown): value is PageSearchResultsRequest {
  if (!isEnvelope(value) || value.type !== "page.search-results") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.frameId === 0 && isTabId(candidate.tabId);
}

export function isPageExecuteRequest(value: unknown): value is PageExecuteRequest {
  if (!isEnvelope(value) || value.type !== "page.execute") return false;
  const candidate = value as Record<string, unknown>;
  return isFrameId(candidate.frameId) && isRefPrefix(candidate.frameId, candidate.refPrefix) && isTabId(candidate.tabId) &&
    validateDomAction(candidate.action) !== null;
}

export function isPageTableRequest(value: unknown): value is PageTableRequest {
  if (!isEnvelope(value) || value.type !== "page.table") return false;
  const candidate = value as Record<string, unknown>;
  return isFrameId(candidate.frameId) && isRefPrefix(candidate.frameId, candidate.refPrefix) && isTabId(candidate.tabId) &&
    validateElementTarget(candidate.target) !== null &&
    Number.isSafeInteger(candidate.offset) && (candidate.offset as number) >= 0 && (candidate.offset as number) <= TABLE_LIMITS.maxOffset &&
    Number.isSafeInteger(candidate.limit) && (candidate.limit as number) >= 1 && (candidate.limit as number) <= TABLE_LIMITS.maxRows;
}

export function isPageShieldRequest(value: unknown): value is PageShieldRequest {
  if (!isEnvelope(value) || value.type !== "page.shield") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.frameId === 0 && isTabId(candidate.tabId) && (PAGE_SHIELD_STATES as readonly unknown[]).includes(candidate.shield);
}

export function isPageCapturePrepareRequest(value: unknown): value is PageCapturePrepareRequest {
  if (!isEnvelope(value) || value.type !== "page.capture-prepare") return false;
  const candidate = value as Record<string, unknown>;
  const measuresChild = candidate.childFrameId !== null;
  if (measuresChild && (!isFrameId(candidate.childFrameId) || candidate.childFrameId === 0 || candidate.target !== null)) return false;
  return isFrameId(candidate.frameId) && isRefPrefix(candidate.frameId, candidate.refPrefix) && isTabId(candidate.tabId) &&
    (candidate.target === null || validateElementTarget(candidate.target) !== null);
}

export function isPageCaptureDoneRequest(value: unknown): value is PageCaptureDoneRequest {
  if (!isEnvelope(value) || value.type !== "page.capture-done") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.frameId === 0 && isTabId(candidate.tabId);
}

export function isPageFetchPdfRequest(value: unknown): value is PageFetchPdfRequest {
  if (!isEnvelope(value) || value.type !== "page.fetch-pdf") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.frameId === 0 && isTabId(candidate.tabId) && validateHttpUrl(candidate.url) !== null &&
    (candidate.credentials === "include" || candidate.credentials === "omit");
}

export function isPageMenuTargetRequest(value: unknown): value is PageMenuTargetRequest {
  if (!isEnvelope(value) || value.type !== "page.menu-target") return false;
  const candidate = value as Record<string, unknown>;
  return isFrameId(candidate.frameId) && isTabId(candidate.tabId) && Number.isSafeInteger(candidate.targetElementId) && (candidate.targetElementId as number) >= 0;
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

/** The fields of a `runtime.onMessage` sender that decide whether a content message is accepted. */
export interface ContentMessageSender {
  id?: string;
  url?: string;
  frameId?: number;
  tab?: { id?: number };
}

/**
 * The tab a content message may act on: the sender's own tab, when it is this
 * extension's content script in the top frame of an HTTP(S) tab; null for any
 * other sender. The content script runs in every frame, but only the top
 * frame's instance messages the background, so a subframe (whose page may be
 * another origin) never reaches the shield.
 */
export function contentMessageTab(sender: ContentMessageSender, extensionId: string): number | null {
  const tabId = sender.tab?.id;
  if (sender.id !== extensionId || sender.frameId !== 0 || !/^https?:/.test(sender.url ?? "")) return null;
  return Number.isSafeInteger(tabId) && (tabId as number) >= 0 ? tabId as number : null;
}

export function isContentMessageResponse(value: unknown): value is ContentMessageResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.v === 1 && candidate.ok === true && (PAGE_SHIELD_STATES as readonly unknown[]).includes(candidate.shield);
}

/** Firefox frame ids: 0 for the top frame, a large positive integer for a subframe. */
export function isFrameId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** The top frame's refs have no prefix; any other frame's name one frame (`f3:`). */
function isRefPrefix(frameId: unknown, value: unknown): boolean {
  return frameId === 0 ? value === "" : typeof value === "string" && /^f[1-9]\d{0,5}:$/.test(value);
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
  /** Sets the permission mode beside the composer. Accepted mid-run: the active run reads it at each gated call. */
  | { v: 1; id: string; type: "permissions.save"; mode: PermissionMode }
  /** Looks up the site note to edit for a page URL. Answered with `siteNote.loaded` to the requesting sidebar only. */
  | { v: 1; id: string; type: "siteNote.get"; url: string }
  /**
   * "Remember something about this site": adds or replaces the note for one
   * origin. The sidebar's only write to user-authored data; the background
   * revalidates it. Answered with `siteNote.saved` to the requesting sidebar only.
   */
  | { v: 1; id: string; type: "siteNote.save"; note: SiteNote }
  /**
   * The trace's Undo for memory changes runs made (the ids on their tool
   * results), newest first, each only while the entry is as that change left
   * it. The sidebar's only memory write. Answered with `memory.undone` to the
   * requesting sidebar only.
   */
  | { v: 1; id: string; type: "memory.undo"; changeIds: string[] }
  /**
   * Reads one of the open session's `/workspace` images so the sidebar can show
   * it where model Markdown references it. Not a run effect and never sent to
   * the model. Answered with `workspace.image.loaded` to the requesting sidebar only.
   */
  | { v: 1; id: string; type: "workspace.image"; sessionId: string; path: string }
  /** Exports one session with its scratch files; run diagnostics, model input, and tool output are included only for the latest run's session. Answered with `context.exported` to the requesting sidebar only. */
  | { v: 1; id: string; type: "context.export"; sessionId: string }
  /**
   * `lastSeq: null` asks for a full `state.snapshot`. Otherwise it names the
   * last event seq the sidebar applied for each run it knows (at most
   * `MAX_SUBSCRIBE_RUNS`): the background replays every run's missed events
   * when each run's buffer still covers them, else sends a full snapshot.
   */
  | { v: 1; id: string; type: "state.subscribe"; lastSeq: Record<string, number> | null }
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
  | { v: 1; id: string; type: "run.start"; prompt: string; askId?: string; contentIds?: string[]; sessionId?: string }
  /**
   * Guidance for the active run, delivered as a user message at its next tool
   * boundary, within the same turn and budgets. If `runId` is no longer
   * running (finished or cancelling), handled exactly like `run.start`.
   * `askId` (on either) sends the pending context-menu chip with the message;
   * a chip that is no longer pending refuses the send with a notice.
   */
  | { v: 1; id: string; type: "run.steer"; runId: string; text: string; askId?: string; contentIds?: string[]; sessionId?: string }
  | { v: 1; id: string; type: "mcp.content.list"; sessionId: string; kind: "prompt" | "resource" }
  | { v: 1; id: string; type: "mcp.content.prepare"; sessionId: string; choiceId: string; arguments: Record<string, string> }
  | { v: 1; id: string; type: "mcp.content.dismiss"; sessionId: string; contentIds: string[] }
  /** Removes the pending "Ask bside about…" chip, if it is still the one named. */
  | { v: 1; id: string; type: "ask.dismiss"; askId: string }
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

export type McpContentReply =
  | { ok: true; choices: McpContentChoice[]; errors: NormalizedError[] }
  | { ok: true; snapshot: McpContentSnapshot }
  | { ok: false; error: NormalizedError };

export type HelpOutcome = "done" | "unable";

/** A `/workspace` image's base64 bytes, or why there are none (another session, no such image file). */
export type WorkspaceImageReply =
  | { ok: true; mimeType: string; data: string }
  | { ok: false; reason: "session" | "missing" };

const isAskId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64;
const isContentIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= MCP_CONTENT_LIMITS.attachments && value.every(isAskId) && new Set(value).size === value.length;
const isOptionalAskId = (value: unknown) => value === undefined || isAskId(value);

/** A `state.subscribe` seq map: a plain object of at most `MAX_SUBSCRIBE_RUNS` run ids (≤64 characters) to non-negative integer seqs. */
function isRunSeqs(value: unknown): value is Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_SUBSCRIBE_RUNS) return false;
  return keys.every((runId) => {
    if (typeof runId !== "string" || !isAskId(runId)) return false;
    const seq = (value as Record<string, unknown>)[runId];
    return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0;
  });
}

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
  /**
   * Set when the server's "Always confirm writes" trust level gates a call
   * (`call`) of a connected account's tool that is not marked read-only.
   */
  mcp?: McpApproval;
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
  /** The permission mode beside the composer; it applies to the active run at its next gated call. */
  permissionMode: PermissionMode;
  page: AttachedPage | null;
  agentTabs: AgentTabsState;
  /** The open session's queued follow-ups and undelivered steers, oldest first. */
  queue: QueuedMessage[];
  /** The pending "Ask bside about…" chip from the page's context menu, shown beside the composer of any chat. */
  ask: AskContextV1 | null;
  /** Every run in progress, at most one per session; each may belong to a session other than the open one. */
  runs: RunState[];
  notice: string | null;
}

/** One run in progress, as of its event `lastSeq`. */
export interface RunState {
  runId: string;
  /** The run's session. */
  conversationId: string;
  status: "running" | "awaiting-approval" | "awaiting-help" | "cancelling";
  partialAssistantText: string;
  pendingApproval: ApprovalRequest | null;
  pendingHelp: HelpRequest | null;
  /** Usage of the run's provider responses so far; `null` until one reports tokens. */
  usage: RunUsageV1 | null;
  /** The seq of the run's last event this state reflects (0 before its first); its next event is `lastSeq + 1`. */
  lastSeq: number;
}

/** The most runs one `state.subscribe` may name. */
export const MAX_SUBSCRIBE_RUNS = 64;

export interface EventBase<T extends string, P> {
  v: 1;
  runId: string | null;
  /** Run events: the run's session. `state.snapshot`: the open session. Events not about one session: `null`. */
  conversationId: string | null;
  /** Run events: 1, 2, … within their own run (each run counts separately). Every other event: 0. */
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
  /** The change ids undone, and a safe `error` for any that were not. */
  | EventBase<"memory.undone", { requestId: string; undone: string[]; error: string | null }>
  | EventBase<"workspace.image.loaded", { requestId: string; result: WorkspaceImageReply }>
  | EventBase<"state.snapshot", RuntimeSnapshot>
  | EventBase<"session.listed", { sessions: ConversationSummary[] }>
  | EventBase<"page.attached", AttachedPage | null>
  | EventBase<"agent-tabs.changed", AgentTabsState>
  /** The permission mode changed (from any sidebar). Not run-sequenced. */
  | EventBase<"permissions.changed", { mode: PermissionMode }>
  /** A session's queue after it changed; `conversationId` is that session. Not run-sequenced. */
  | EventBase<"queue.changed", { messages: QueuedMessage[] }>
  /** The pending context-menu chip changed: a new click, alt text the page reported, sent, or removed. Not run-sequenced. */
  | EventBase<"ask.changed", { ask: AskContextV1 | null }>
  | EventBase<"composer.focus", null>
  | EventBase<"mcp.content.reply", { requestId: string; result: McpContentReply }>
  | EventBase<"mcp.content.accepted", { ids: string[] }>
  | EventBase<"run.started", { content?: McpContentSnapshot[]; prompt: string; page: PageArtifactSummary | null; ask: AskContextV1 | null; retry: boolean; scheduled?: ScheduledSource }>
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

/** The events sequenced per run (`seq` 1, 2, …); every other event carries seq 0. */
export const RUN_EVENT_TYPES = [
  "run.started", "assistant.delta", "tool.requested", "action.approval-required", "help.requested", "tool.result",
  "steer.delivered", "run.usage", "run.completed", "run.cancelled", "run.failed",
] as const satisfies readonly SidebarEvent["type"][];
export type RunEvent = Extract<SidebarEvent, { type: (typeof RUN_EVENT_TYPES)[number] }> & { runId: string };
/** A run's last event; nothing follows it. */
export const TERMINAL_RUN_EVENT_TYPES: ReadonlySet<SidebarEvent["type"]> = new Set(["run.completed", "run.cancelled", "run.failed"]);

export function isRunEvent(event: SidebarEvent): event is RunEvent {
  return event.runId !== null && (RUN_EVENT_TYPES as readonly string[]).includes(event.type);
}

export function isSidebarCommand(value: unknown): value is SidebarCommand {
  if (!isEnvelope(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "mcp.content.list") return isSessionId(candidate.sessionId) && (candidate.kind === "prompt" || candidate.kind === "resource");
  if (candidate.type === "mcp.content.prepare") return isSessionId(candidate.sessionId) && isAskId(candidate.choiceId) && isMcpArguments(candidate.arguments);
  if (candidate.type === "mcp.content.dismiss") return isSessionId(candidate.sessionId) && isContentIds(candidate.contentIds);
  if (candidate.type === "skills.list") return true;
  if (candidate.type === "tabs.list") return true;
  if (candidate.type === "tabs.focus") return Number.isSafeInteger(candidate.tabId);
  if (candidate.type === "tabs.closeAgentTabs") return isSessionId(candidate.sessionId);
  if (candidate.type === "tabs.watch") return Number.isSafeInteger(candidate.tabId);
  if (candidate.type === "tabs.unwatch") return true;
  if (candidate.type === "tabs.takeOver") return Number.isSafeInteger(candidate.tabId);
  if (candidate.type === "settings.save") return isAppSettings(candidate.settings);
  if (candidate.type === "permissions.save") return isPermissionMode(candidate.mode);
  if (candidate.type === "siteNote.get") return typeof candidate.url === "string" && candidate.url.length <= 8_192;
  if (candidate.type === "siteNote.save") return isSiteNote(candidate.note);
  if (candidate.type === "memory.undo") {
    return Array.isArray(candidate.changeIds) && candidate.changeIds.length > 0 && candidate.changeIds.length <= 64 &&
      candidate.changeIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 64);
  }
  if (candidate.type === "workspace.image") return isSessionId(candidate.sessionId) && isWorkspacePath(candidate.path) && isViewableImagePath(candidate.path);
  if (candidate.type === "context.export") return isSessionId(candidate.sessionId);
  if (candidate.type === "session.create" || candidate.type === "session.list") return true;
  if (candidate.type === "session.open") return isSessionId(candidate.sessionId);
  if (candidate.type === "session.delete") return isSessionId(candidate.sessionId) && typeof candidate.closeAgentTabs === "boolean";
  if (candidate.type === "session.rename") {
    return isSessionId(candidate.sessionId) && typeof candidate.title === "string" && candidate.title.length <= MAX_SESSION_TITLE_LEN * 4;
  }
  if (candidate.type === "session.pin") return isSessionId(candidate.sessionId) && typeof candidate.pinned === "boolean";
  if (candidate.type === "state.subscribe") {
    return candidate.lastSeq === null || isRunSeqs(candidate.lastSeq);
  }
  if (candidate.type === "run.start") return typeof candidate.prompt === "string" && isOptionalAskId(candidate.askId) && (candidate.contentIds === undefined || (isContentIds(candidate.contentIds) && isSessionId(candidate.sessionId)));
  if (candidate.type === "run.steer") return typeof candidate.runId === "string" && typeof candidate.text === "string" && isOptionalAskId(candidate.askId) && (candidate.contentIds === undefined || (isContentIds(candidate.contentIds) && isSessionId(candidate.sessionId)));
  if (candidate.type === "ask.dismiss") return isAskId(candidate.askId);
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

/** Automation settings and result selection: options.html only, never sidebar/content commands. */
export type AutomationRequest =
  | { v: 1; id: string; type: "automation.get" }
  | { v: 1; id: string; type: "automation.save"; taskId: string | null; task: TaskDraft }
  | { v: 1; id: string; type: "automation.delete"; taskId: string }
  | { v: 1; id: string; type: "automation.results"; taskId: string }
  | { v: 1; id: string; type: "automation.notifications.save"; enabled: boolean };
export type AutomationResponse =
  | { v: 1; id: string; ok: true; tasks: ScheduledTask[]; notifications: NotificationSettingsV1; available: boolean }
  | { v: 1; id: string; ok: false; error: NormalizedError };
export function isAutomationRequest(value: unknown): value is AutomationRequest {
  if (!isEnvelope(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.type === "automation.get") return true;
  if (v.type === "automation.save") return (v.taskId === null || isTaskId(v.taskId)) && isTaskDraft(v.task);
  if (v.type === "automation.delete" || v.type === "automation.results") return isTaskId(v.taskId);
  return v.type === "automation.notifications.save" && typeof v.enabled === "boolean";
}

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

/** Agent memory; options page only (the sidebar's `memory.undo` is the one exception). */
export type MemoryRequest =
  | { v: 1; id: string; type: "memory.list" }
  /** The user's edit of an existing entry: its description and body. Records the user as its source. */
  | { v: 1; id: string; type: "memory.save"; entry: MemoryDraft }
  | { v: 1; id: string; type: "memory.delete"; name: string }
  /** "Forget everything": deletes every entry. */
  | { v: 1; id: string; type: "memory.forgetAll" }
  | { v: 1; id: string; type: "memory.settings.save"; settings: MemorySettingsV1 };

export type MemoryResponse =
  | { v: 1; id: string; ok: true; entries: MemoryEntry[]; settings: MemorySettingsV1 }
  | { v: 1; id: string; ok: false; error: NormalizedError };

export function isMemoryRequest(value: unknown): value is MemoryRequest {
  if (!isEnvelope(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "memory.list" || candidate.type === "memory.forgetAll") return true;
  if (candidate.type === "memory.save") return isMemoryDraft(candidate.entry);
  if (candidate.type === "memory.delete") return isMemoryName(candidate.name);
  if (candidate.type === "memory.settings.save") {
    const settings = candidate.settings as Record<string, unknown> | null;
    return typeof settings === "object" && settings !== null && Object.keys(settings).length === 2 && settings.version === 1 &&
      (MEMORY_WRITE_POLICIES as readonly unknown[]).includes(settings.writes);
  }
  return false;
}

/** MCP connections; options page only. Tokens never appear in a request or response. */
export type McpRequest =
  | { v: 1; id: string; type: "mcp.list" }
  /** Opens the server's sign-in popup, then lists its tools. */
  | { v: 1; id: string; type: "mcp.connect"; server: string }
  /** Revokes the tokens where supported and deletes them; the tool choices and trust level are kept. */
  | { v: 1; id: string; type: "mcp.disconnect"; server: string }
  /** Lists the server's tools again. */
  | { v: 1; id: string; type: "mcp.refresh"; server: string }
  | { v: 1; id: string; type: "mcp.tool.toggle"; server: string; tool: string; enabled: boolean }
  | { v: 1; id: string; type: "mcp.trust.save"; server: string; trust: McpTrust };

export type McpResponse =
  | { v: 1; id: string; ok: true; servers: McpServerStatus[]; enabledTools: number; maxTools: number; notice: string | null }
  | { v: 1; id: string; ok: false; error: NormalizedError };

export function isMcpRequest(value: unknown): value is McpRequest {
  if (!isEnvelope(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "mcp.list") return Object.keys(candidate).length === 3;
  if (candidate.type === "mcp.connect" || candidate.type === "mcp.disconnect" || candidate.type === "mcp.refresh") return Object.keys(candidate).length === 4 && isMcpServerId(candidate.server);
  if (candidate.type === "mcp.tool.toggle") return Object.keys(candidate).length === 6 && isMcpServerId(candidate.server) && isMcpToolName(candidate.tool) && typeof candidate.enabled === "boolean";
  if (candidate.type === "mcp.trust.save") return Object.keys(candidate).length === 5 && isMcpServerId(candidate.server) && (MCP_TRUST_LEVELS as readonly unknown[]).includes(candidate.trust);
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

/** Options-only, local, metadata-only diagnostics. Deliberately no include-content switch. */
export type ProblemReportRequest =
  | { v: 1; id: string; type: "problemReport.list" }
  | { v: 1; id: string; type: "problemReport.export"; sessionId: string };

export type ProblemReportResponse =
  | { v: 1; id: string; ok: true; type: "problemReport.list"; sessions: { id: string; title: string }[] }
  | { v: 1; id: string; ok: true; type: "problemReport.export"; json: string; filename: string }
  | { v: 1; id: string; ok: false; error: NormalizedError };

export function isProblemReportRequest(value: unknown): value is ProblemReportRequest {
  if (!isEnvelope(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = candidate.type === "problemReport.list" ? ["v", "id", "type"] : ["v", "id", "type", "sessionId"];
  if (Object.keys(candidate).some((key) => !keys.includes(key))) return false;
  return candidate.type === "problemReport.list" ||
    (candidate.type === "problemReport.export" && isSessionId(candidate.sessionId));
}

/** Options routes may contain a hash, but never a query or a different page. */
export function isOptionsSender(sender: { id?: string; url?: string }, extensionId: string, optionsUrl: string): boolean {
  return sender.id === extensionId && sender.url?.replace(/#.*$/s, "") === optionsUrl;
}

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
