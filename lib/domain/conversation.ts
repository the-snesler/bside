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
    };

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

export const SESSION_TITLE_MAX_CHARS = 60;

/** Matches a tab mention as `serializeDraft` encodes it; group 1 is the label. */
export const PROMPT_MENTION_PATTERN = /@([^\n]+?) \(tab (\d+), \/(agent-tabs|tabs)\/\2\/page\.md, (\S+)\)/g;

/** Default session title: the prompt with mentions rendered as `@label`, whitespace collapsed, truncated. */
export function titleFromPrompt(prompt: string): string {
  const text = prompt.replace(PROMPT_MENTION_PATTERN, "@$1").replace(/\s+/g, " ").trim();
  return text.length <= SESSION_TITLE_MAX_CHARS ? text : `${text.slice(0, SESSION_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}
