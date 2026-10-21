import { isTurnStart, type ConversationItem, type UserMessageItem } from "@/lib/domain/conversation";
import type { ToolCall, ToolResult } from "@/lib/domain/tools";

export type Activity = {
  kind: "activity";
  id: string;
  call: ToolCall;
  result: Omit<ToolResult, "data"> | null;
  startedAt: number;
  endedAt: number | null;
};

/** `steer`: guidance the user sent while the turn was working, where the model received it. */
export type TurnStep = { kind: "text" | "steer"; id: string; text: string } | Activity;

/** One user prompt, the work done for it, and its final answer. */
export type Turn = {
  id: string;
  prompt: UserMessageItem | null;
  steps: TurnStep[];
  answer: { id: string; text: string } | null;
  /** Set on the first turn the model still sees verbatim after the latest compaction: the summary of everything before it. */
  summary: string | null;
  startedAt: number;
  endedAt: number;
};

/**
 * Groups conversation items into turns. A completed turn's trailing assistant
 * message is its answer; earlier assistant text is interim work. The active
 * turn has no answer yet because any committed text may still be followed by
 * more tool calls. A steer is a step of the turn it was sent in, never a new
 * turn. Run digests are not shown; the latest compaction marks the turn it
 * starts at, and every item stays visible.
 */
export function buildTurns(items: ConversationItem[], running: boolean): Turn[] {
  const turns: Turn[] = [];
  const activities = new Map<string, Activity>();
  const compaction = items.findLast((item) => item.kind === "compaction");
  for (const item of items) {
    if (item.kind === "run-digest" || item.kind === "compaction") continue;
    let turn = turns.at(-1);
    if (isTurnStart(item) || !turn) {
      turn = {
        id: item.id,
        prompt: isTurnStart(item) ? item : null,
        steps: [],
        answer: null,
        summary: compaction?.kind === "compaction" && compaction.firstKeptItemId === item.id ? compaction.summary : null,
        startedAt: item.at,
        endedAt: item.at,
      };
      turns.push(turn);
      if (turn.prompt) continue;
    }
    turn.endedAt = Math.max(turn.endedAt, item.at);
    if (item.kind === "message") {
      turn.steps.push({ kind: item.role === "user" ? "steer" : "text", id: item.id, text: item.text });
    } else if (item.kind === "tool-call") {
      const activity: Activity = { kind: "activity", id: item.id, call: item.call, result: null, startedAt: item.at, endedAt: null };
      activities.set(item.call.id, activity);
      turn.steps.push(activity);
    } else {
      const activity = activities.get(item.callId);
      if (activity) {
        activity.result = item.result;
        activity.endedAt = item.at;
      }
    }
  }
  turns.forEach((turn, index) => {
    if (running && index === turns.length - 1) return;
    const last = turn.steps.at(-1);
    if (last?.kind === "text") {
      turn.steps.pop();
      turn.answer = { id: last.id, text: last.text };
    }
  });
  return turns;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
