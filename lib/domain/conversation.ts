/**
 * Conversation (session) shapes. Each session is persisted as an index entry,
 * a small per-session record, and fixed-size item chunks (see `lib/storage.ts`);
 * `Conversation` is the materialized view the sidebar renders.
 */

import type { PageArtifactSummary, ToolCall, ToolResult } from "@/lib/domain/tools";

export type ConversationItem =
  | {
      id: string;
      kind: "message";
      role: "user";
      text: string;
      context: PageArtifactSummary | null;
      at: number;
    }
  | { id: string; kind: "message"; role: "assistant"; text: string; at: number }
  | { id: string; kind: "tool-call"; call: ToolCall; at: number }
  | {
      id: string;
      kind: "tool-result";
      callId: string;
      result: Omit<ToolResult, "data">;
      at: number;
    }
  /** What a run did, appended when it ends; replayed to later runs as notes (see `lib/domain/run-digest.ts`). Not shown in the transcript. */
  | { id: string; kind: "run-digest"; digest: RunDigestV1; at: number }
  /**
   * Model-written summary of every item before `firstKeptItemId` (a user
   * message), replacing them in later requests. The items themselves stay
   * stored and visible. Untrusted model text derived from page content.
   */
  | { id: string; kind: "compaction"; summary: string; firstKeptItemId: string; tokensBefore: number; at: number };

/** Longer summaries are clipped before they are stored. */
export const COMPACTION_SUMMARY_MAX_CHARS = 60_000;

export type RunDigestStatus = "completed" | "failed" | "cancelled" | "interrupted";

/** One tool call of a run. `ok`/`approved` are `null` when an interruption left no result. */
export type RunDigestEntry =
  | { type: "program"; source: string; ok: boolean | null; code: string | null; urls: string[]; excerpt: string }
  | { type: "confirmation"; title: string; approved: boolean | null };

export interface RunDigestV1 {
  version: 1;
  status: RunDigestStatus;
  /** Safe run-level error message (e.g. a run budget), never a raw provider body. */
  error: string | null;
  /** Most recent tool calls, oldest first; earlier ones beyond the bound are counted in `omittedEntries`. */
  entries: RunDigestEntry[];
  omittedEntries: number;
}

/** One session's entry in `ConversationIndexV1`. A session id is its conversation id. */
export interface ConversationSummary {
  id: string;
  /** Empty until the first prompt names the session. Untrusted text: render as text only. */
  title: string;
  /** `"prompt"` titles come from the first user prompt; `"user"` titles come from a rename and are never auto-overwritten. */
  titleSource: "prompt" | "user";
  createdAt: number;
  /** Last item append; renames and pins do not change it. */
  updatedAt: number;
  pinned: boolean;
  itemCount: number;
  /** Model of the latest run started in the session. */
  lastModelId: string | null;
}

export interface ConversationIndexV1 {
  version: 1;
  sessions: ConversationSummary[];
}

/** A session materialized for display: its index entry plus every item. Never persisted as one record. */
export interface Conversation extends ConversationSummary {
  items: ConversationItem[];
}

/** How long unpinned sessions are kept after their last activity. */
export type HistoryRetention = "forever" | "30d" | "7d";

export const HISTORY_RETENTIONS: readonly HistoryRetention[] = ["forever", "30d", "7d"];

/** Persisted as `local:historySettings`. */
export interface HistorySettingsV1 {
  version: 1;
  retention: HistoryRetention;
}

const RETENTION_DAYS: Record<HistoryRetention, number | null> = { forever: null, "30d": 30, "7d": 7 };

/** Sessions last updated before the returned time are past retention; `null` keeps everything. */
export function retentionCutoff(retention: HistoryRetention, now: number): number | null {
  const days = RETENTION_DAYS[retention];
  return days === null ? null : now - days * 24 * 60 * 60_000;
}

export const SESSION_TITLE_MAX_CHARS = 60;

/** Matches a tab mention as `serializeDraft` encodes it; group 1 is the label. */
export const PROMPT_MENTION_PATTERN = /@([^\n]+?) \(tab (\d+), \/(agent-tabs|tabs)\/\2\/page\.md, (\S+)\)/g;

/** Default session title: the prompt with mentions rendered as `@label`, whitespace collapsed, truncated. */
export function titleFromPrompt(prompt: string): string {
  const text = prompt.replace(PROMPT_MENTION_PATTERN, "@$1").replace(/\s+/g, " ").trim();
  return text.length <= SESSION_TITLE_MAX_CHARS ? text : `${text.slice(0, SESSION_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}
