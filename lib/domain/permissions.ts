/**
 * The user's permission mode, chosen beside the composer and read at each
 * gated call, so a change applies mid-run.
 *
 * - `ask` (default): the model asks with `request_action_confirmation` before
 *   consequential actions, and each server's MCP trust level applies.
 * - `read-only`: every page interaction (except hover), navigation of the
 *   user's own tabs, closing or moving them, every MCP tool not annotated
 *   read-only, and every `request_action_confirmation` fail at once with
 *   `ACTION_DENIED`, before any effect. Reading, scrolling, searching, and
 *   opening or navigating bside's own agent tabs still work.
 * - `auto`: confirmations are answered approved without a card, and MCP
 *   "Always confirm writes" gates are skipped. The prompt does not change.
 *
 * Memory writes follow the separate memory write policy in both. Scheduled
 * runs always use `ask`.
 */
export type PermissionMode = "ask" | "read-only" | "auto";
export const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "read-only", "auto"];

export interface PermissionSettingsV1 {
  version: 1;
  mode: PermissionMode;
}

export const DEFAULT_PERMISSION_SETTINGS: PermissionSettingsV1 = { version: 1, mode: "ask" };

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (PERMISSION_MODES as readonly unknown[]).includes(value);
}

const READ_ONLY_MARK = "Not allowed: the user set bside to read-only mode";

/** What a read-only refusal tells the model; it names the user's setting so the model can say how to lift it. */
export function readOnlyRefusal(action: string): string {
  return `${READ_ONLY_MARK}, so ${action} is refused and nothing was changed. Answer from what you can read; if the task needs this action, tell the user to switch the mode beside the composer from "Read-only" to "Ask" and ask again. Do not try another way to make the change.`;
}

/** A `request_action_confirmation` answered in `auto` mode: approved as if the user confirmed, for that action only. The trace tells it apart by this text. */
export const AUTO_APPROVED_SUMMARY = "approved:true. The user confirmed the described action only (their permission mode approves actions without asking).";

/** A `request_action_confirmation` refused in `read-only` mode. */
export const READ_ONLY_DENIED_SUMMARY = `approved:false. ${readOnlyRefusal("this action")}`;

/** Whether a persisted result summary is a read-only refusal (a confirmation's, a program's diagnostic, or an MCP call's), for the trace. */
export function isReadOnlyRefusal(summary: string): boolean {
  return summary.includes(READ_ONLY_MARK);
}
