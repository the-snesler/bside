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
  DomAction,
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
import { REASONING_EFFORTS, type AppSettingsV1, type ChatGPTStatus, type ProviderDefinition } from "@/lib/domain/provider";
import type { RunUsageV1 } from "@/lib/domain/usage";
import { isSkill, isSkillName, type Skill, type SkillSummary } from "@/lib/domain/skills";
import { isYouTubeRequest, type YouTubeRequest, type YouTubeResult } from "@/lib/domain/youtube";
import { isSessionId, MAX_SESSION_TITLE_LEN, validateDomAction } from "@/lib/validation";

// ---------------------------------------------------------------------------
// Content script <-> background: PageRequest / PageResponse (tabs.sendMessage)
// ---------------------------------------------------------------------------

export interface PageYouTubeRequest {
  v: 1;
  id: string;
  type: "page.youtube";
  tabId: number;
  request: YouTubeRequest;
}

export interface PageYouTubeResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.youtube";
  result: YouTubeResult;
}

export function isPageYouTubeRequest(value: unknown): value is PageYouTubeRequest {
  if (!isEnvelope(value) || value.type !== "page.youtube") return false;
  const candidate = value as Record<string, unknown>;
  return isTabId(candidate.tabId) && isYouTubeRequest(candidate.request);
}

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

export type PageRequest = PageHealthRequest | PageSnapshotRequest | PageFindRequest | PageSearchResultsRequest | PageExecuteRequest | PageYouTubeRequest;

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

export interface PageErrorResponse {
  v: 1;
  id: string;
  ok: false;
  error: NormalizedError;
}

export type PageResponse =
  | PageYouTubeResponse
  | PageHealthResponse
  | PageSnapshotResponse
  | PageFindResponse
  | PageSearchResultsResponse
  | PageExecuteResponse
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
  | { v: 1; id: string; type: "settings.save"; settings: AppSettingsV1 }
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
  | { v: 1; id: string; type: "action.deny"; runId: string; callId: string };

export interface ApprovalRequest {
  call: ToolCall;
  origin: string;
  display: string;
  target: { ref?: string; role?: string; name?: string };
}

export interface RuntimeSnapshot {
  skills?: SkillSummary[];
  /** The open session. */
  conversation: Conversation;
  credential: { configured: boolean; maskedSuffix: string | null; chatgpt: ChatGPTStatus };
  provider: ProviderDefinition;
  settings: AppSettingsV1;
  page: PageArtifactSummary | null;
  /** Hidden agent tabs (search tabs included) per owning session id; sessions with none are omitted. */
  agentTabs: Record<string, number>;
  /** The open session's queued follow-ups and undelivered steers, oldest first. */
  queue: QueuedMessage[];
  /** The single active run, which may belong to a session other than the open one. */
  activeRun: {
    runId: string;
    conversationId: string;
    status: "running" | "awaiting-approval" | "cancelling";
    partialAssistantText: string;
    pendingApproval: ApprovalRequest | null;
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
  | EventBase<"state.snapshot", RuntimeSnapshot>
  | EventBase<"session.listed", { sessions: ConversationSummary[] }>
  | EventBase<"page.attached", PageArtifactSummary | null>
  | EventBase<"agent-tabs.changed", { bySession: Record<string, number> }>
  /** A session's queue after it changed; `conversationId` is that session. Not run-sequenced. */
  | EventBase<"queue.changed", { messages: QueuedMessage[] }>
  | EventBase<"run.started", { prompt: string; page: PageArtifactSummary | null; retry: boolean }>
  | EventBase<"assistant.delta", { delta: string }>
  | EventBase<"tool.requested", { call: ToolCall; display: string }>
  | EventBase<"action.approval-required", ApprovalRequest>
  | EventBase<"tool.result", { callId: string; result: ToolResult }>
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
  if (candidate.type === "settings.save") return isAppSettings(candidate.settings);
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

export function isAppSettings(value: unknown): value is AppSettingsV1 {
  if (!value || typeof value !== "object") return false;
  const settings = value as AppSettingsV1;
  return Object.keys(value).length === 4 && settings.version === 1 && settings.providerId === "openai" &&
    typeof settings.modelId === "string" && /^[\w.:-]{1,200}$/.test(settings.modelId) &&
    REASONING_EFFORTS.includes(settings.reasoningEffort);
}
