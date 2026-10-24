import type { Conversation } from "./conversation";

/** Only these metadata fields may cross into a problem report. Never spread
 * stored records, errors, tool calls, or provider diagnostics into the output. */
export interface ProblemRun {
  startedAt: number;
  endedAt: number | null;
  status: "running" | "completed" | "cancelled" | "failed";
  providerResponses: number;
  error: { code: string; status?: number; retryable: boolean } | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
  toolCalls: { durationMs: number; ok: boolean; code: string | null; outputChars: number; truncatedOutput: boolean }[];
}

const CODES = new Set([
  "AUTHENTICATION", "RATE_LIMIT", "INVALID_REQUEST", "TIMEOUT", "NETWORK",
  "PROVIDER_UNAVAILABLE", "PROVIDER_RESPONSE_FAILED", "CONTEXT_OVERFLOW",
  "INVALID_TOOL_ARGUMENTS", "LIMIT_EXCEEDED", "PROTOCOL_ERROR", "UNSUPPORTED_PAGE",
  "TAB_CHANGED", "STALE_SNAPSHOT", "TARGET_MISSING", "NOT_INTERACTABLE",
  "NAVIGATION_INTERRUPTED", "ACTION_DENIED", "SKIPPED", "TOOL_ERROR", "CONNECTION_ERROR",
]);
const code = (value: string | null) => value === null ? null : CODES.has(value) ? value : "OTHER";
const number = (value: number) => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

/** An allowlist export, not a scrub of the raw context export. No free-text
 * field, URL (even an origin), local id, title, path, or request id survives. */
export function buildProblemReport(conversation: Conversation, run: ProblemRun | null, version: string): string {
  const kinds = ["message", "tool-call", "tool-result", "run-digest", "run-usage", "compaction"] as const;
  return JSON.stringify({
    format: "bside-problem-report", version: 1,
    extensionVersion: /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version) ? version : "unknown",
    contentIncluded: false,
    omitted: "All prompts, page and model text, tool names/arguments/results, digests, summaries, files, URLs, titles, identifiers, credentials and error messages.",
    conversation: { itemCounts: Object.fromEntries(kinds.map((kind) => [kind, conversation.items.filter((item) => item.kind === kind).length])) },
    latestRun: run ? {
      status: ["running", "completed", "cancelled", "failed"].includes(run.status) ? run.status : "unknown",
      durationMs: run.endedAt === null ? null : number(run.endedAt - run.startedAt),
      providerResponses: number(run.providerResponses),
      error: run.error ? { code: code(run.error.code), retryable: run.error.retryable === true,
        status: run.error.status && run.error.status >= 100 && run.error.status <= 599 ? Math.round(run.error.status) : null } : null,
      tokens: Object.fromEntries((["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const).map((key) => [key, number(run.usage[key])])),
      toolCalls: run.toolCalls.map((call) => ({ durationMs: number(call.durationMs), ok: call.ok === true,
        code: code(call.code), outputChars: number(call.outputChars), truncatedOutput: call.truncatedOutput === true })),
    } : null,
  }, null, 2);
}
