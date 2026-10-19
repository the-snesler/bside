import type { ConversationItem } from "@/lib/domain/conversation";
import type { ToolCall, ToolResult } from "@/lib/domain/tools";

export type Activity = {
  kind: "activity";
  id: string;
  call: ToolCall;
  result: Omit<ToolResult, "data"> | null;
  startedAt: number;
  endedAt: number | null;
};

export type TurnStep = { kind: "text"; id: string; text: string } | Activity;

/** One user prompt, the work done for it, and its final answer. */
export type Turn = {
  id: string;
  prompt: Extract<ConversationItem, { kind: "message"; role: "user" }> | null;
  steps: TurnStep[];
  answer: { id: string; text: string } | null;
  startedAt: number;
  endedAt: number;
};

/**
 * Groups conversation items into turns. A completed turn's trailing assistant
 * message is its answer; earlier assistant text is interim work. The active
 * turn has no answer yet because any committed text may still be followed by
 * more tool calls.
 */
export function buildTurns(items: ConversationItem[], running: boolean): Turn[] {
  const turns: Turn[] = [];
  const activities = new Map<string, Activity>();
  for (const item of items) {
    let turn = turns.at(-1);
    if ((item.kind === "message" && item.role === "user") || !turn) {
      turn = {
        id: item.id,
        prompt: item.kind === "message" && item.role === "user" ? item : null,
        steps: [],
        answer: null,
        startedAt: item.at,
        endedAt: item.at,
      };
      turns.push(turn);
      if (turn.prompt) continue;
    }
    turn.endedAt = Math.max(turn.endedAt, item.at);
    if (item.kind === "message") {
      turn.steps.push({ kind: "text", id: item.id, text: item.text });
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
