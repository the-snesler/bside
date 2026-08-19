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
  JsonValue,
  PageArtifactSummary,
  PageErrorCode,
  PageSnapshotV1,
  PageToolName,
  ToolResult,
} from "@/lib/domain/tools";

// ---------------------------------------------------------------------------
// Content script <-> background: PageRequest / PageResponse (tabs.sendMessage)
// ---------------------------------------------------------------------------

export type DomPageToolName = Exclude<PageToolName, "page_navigate" | "page_go_back">;

export interface DomToolCall {
  id: string;
  name: DomPageToolName;
  arguments: JsonValue;
}

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
  mode: "readable" | "interactive";
}

export interface PageExecuteRequest {
  v: 1;
  id: string;
  type: "page.execute";
  tabId: number;
  call: DomToolCall;
}

export type PageRequest = PageHealthRequest | PageSnapshotRequest | PageExecuteRequest;

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
  snapshot: PageSnapshotV1;
}

export interface PageExecuteResponse {
  v: 1;
  id: string;
  ok: true;
  type: "page.execute";
  result: ToolResult;
  snapshot: PageSnapshotV1;
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
  | PageExecuteResponse
  | PageErrorResponse;

export function isPageHealthRequest(value: unknown): value is PageHealthRequest {
  return isEnvelope(value) && value.type === "page.health";
}

export function isPageSnapshotRequest(value: unknown): value is PageSnapshotRequest {
  if (!isEnvelope(value) || value.type !== "page.snapshot") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.tabId === "number" &&
    (candidate.mode === "readable" || candidate.mode === "interactive")
  );
}

export function isPageExecuteRequest(value: unknown): value is PageExecuteRequest {
  if (!isEnvelope(value) || value.type !== "page.execute") return false;
  const candidate = value as Record<string, unknown>;
  const call = candidate.call;
  return (
    typeof candidate.tabId === "number" &&
    typeof call === "object" &&
    call !== null &&
    typeof (call as Record<string, unknown>).id === "string" &&
    typeof (call as Record<string, unknown>).name === "string"
  );
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

export type SidebarCommand = { v: 1; id: string; type: "state.subscribe"; lastSeq: number | null };

export interface RuntimeSnapshot {
  page: PageArtifactSummary | null;
  lastSeq: number;
  notice: string | null;
}

export interface EventBase<T extends string, P> {
  v: 1;
  runId: string | null;
  conversationId: "default";
  seq: number;
  type: T;
  at: number;
  payload: P;
}

export type SidebarEvent =
  | EventBase<"state.snapshot", RuntimeSnapshot>
  | EventBase<"page.attached", PageArtifactSummary | null>;

export function isSidebarCommand(value: unknown): value is SidebarCommand {
  if (!isEnvelope(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "state.subscribe" &&
    (candidate.lastSeq === null || typeof candidate.lastSeq === "number")
  );
}
