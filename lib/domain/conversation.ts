/**
 * Conversation (session) shapes. Each session is persisted as an index entry,
 * a small per-session record, and fixed-size item chunks (see `lib/storage.ts`);
 * `Conversation` is the materialized view the sidebar renders.
 */

import type { McpContentSnapshot } from "@/lib/domain/mcp-content";
import type { HelpKind, PageArtifactSummary, ToolCall, ToolResult } from "@/lib/domain/tools";
import type { RunUsageV1, UsageTotals } from "@/lib/domain/usage";
import type { Skill } from "@/lib/domain/skills";
import type { SiteNote } from "@/lib/domain/instructions";
import type { MemoryChange } from "@/lib/domain/memory";
import type { AskContextV1 } from "@/lib/domain/ask";
import type { ScheduledSource } from "@/lib/domain/automation";

export type ConversationItem =
  | {
      id: string;
      kind: "message";
      role: "user";
      text: string;
      context: PageArtifactSummary | null;
      /** The skill a leading `/name` invoked, as it was when the message was accepted. */
      skill?: Skill;
      /**
       * The user's site notes covering the pages attached to a turn-start
       * message (its page outline and tab mentions), as they were when the
       * message was accepted. Rendered on the message, so replay stays byte-identical.
       */
      sites?: SiteNote[];
      /** What the user right-clicked ("Ask bside about…"), sent with this message; rendered on it on every replay. */
      ask?: AskContextV1;
      /** User-authored schedule metadata snapshotted at the tick, never a permission grant. */
      scheduled?: ScheduledSource;
      /** Immutable user-selected remote data, never elevated messages. */
      content?: McpContentSnapshot[];
      /**
       * `"steer"`: guidance sent while the turn's run was working, persisted
       * where the model received it (after a tool round). It belongs to the
       * current turn: never a turn start, a compaction boundary, or a retry target.
       */
      delivery?: "steer";
      at: number;
    }
  | { id: string; kind: "message"; role: "assistant"; text: string; at: number }
  | { id: string; kind: "tool-call"; call: ToolCall; at: number }
  | {
      id: string;
      kind: "tool-result";
      callId: string;
      result: Omit<ToolResult, "data">;
      /** Memory changes a browser program made (names and taint only), for the trace's Undo and the run digest. */
      memory?: MemoryChange[];
      at: number;
    }
  /** What a run did, appended when it ends; replayed to later runs as notes (see `lib/domain/run-digest.ts`). Not shown in the transcript. */
  | { id: string; kind: "run-digest"; digest: RunDigestV1; at: number }
  /** A run's tokens and estimated cost, appended when it ends (see `lib/domain/usage.ts`). Never sent to the model. */
  | { id: string; kind: "run-usage"; usage: RunUsageV1; at: number }
  /**
   * Model-written summary of every item before `firstKeptItemId` (a user
   * message), replacing them in later requests. The items themselves stay
   * stored and visible. Untrusted model text derived from page content.
   */
  | { id: string; kind: "compaction"; summary: string; firstKeptItemId: string; tokensBefore: number; at: number };

export type UserMessageItem = Extract<ConversationItem, { kind: "message"; role: "user" }>;

/** A user prompt that starts a turn; mid-turn steers do not. */
export function isTurnStart(item: ConversationItem): item is UserMessageItem {
  return item.kind === "message" && item.role === "user" && item.delivery !== "steer";
}

/**
 * A message typed while a run was working in its session. A `"follow-up"`
 * starts the next turn after the run completes; a `"steer"` waits for the
 * active run's next tool boundary and becomes a follow-up if the run ends
 * first. Persisted per session as `MessageQueueV1` until it is delivered.
 */
export interface QueuedMessage {
  id: string;
  mode: "follow-up" | "steer";
  /** Validated prompt text, mentions encoded as the composer serializes them. */
  text: string;
  /** The invoked skill, snapshotted when the message was accepted. */
  skill?: Skill;
  /** The context-menu chip sent with the message, taken when it was accepted. */
  ask?: AskContextV1;
  content?: McpContentSnapshot[];
  at: number;
}

export interface MessageQueueV1 {
  version: 1;
  messages: QueuedMessage[];
}

export const MAX_QUEUED_MESSAGES = 20;

/** Longer summaries are clipped before they are stored. */
export const COMPACTION_SUMMARY_MAX_CHARS = 60_000;

export type RunDigestStatus = "completed" | "failed" | "cancelled" | "interrupted";

/** One tool call of a run. `ok`/`approved`/`outcome` are `null` when an interruption left no result. */
export type RunDigestEntry =
  | { type: "program"; source: string; ok: boolean | null; code: string | null; urls: string[]; excerpt: string }
  | { type: "confirmation"; title: string; approved: boolean | null }
  /** A `request_user_help` pause: `outcome` is the user's answer, `"failed"` when the call was refused (not one of the chat's agent tabs). */
  | { type: "help"; kind: HelpKind; reason: string; outcome: "done" | "unable" | "failed" | null }
  /** A memory the preceding program saved or removed; `tainted` when the run had read untrusted content first. */
  | { type: "memory"; op: "write" | "remove"; name: string; tainted: boolean }
  /** A call of a connected account's tool: the server's name, its tool, and bounded excerpts of the arguments and result. Never tokens. */
  | { type: "mcp"; server: string; tool: string; args: string; ok: boolean | null; code: string | null; excerpt: string };

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
  /** Latest schedule that ran here; kept as a label after the task is deleted. */
  scheduled?: ScheduledSource;
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
  /** Running total of every run's usage, added as each run ends. */
  usage: UsageTotals;
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
