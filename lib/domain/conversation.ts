/**
 * The persisted conversation shape. One local thread means exactly one
 * conversation id ("default") — no multi-chat management in this slice.
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

export interface ConversationRecordV1 {
  version: 1;
  id: "default";
  items: ConversationItem[];
  updatedAt: number;
}
