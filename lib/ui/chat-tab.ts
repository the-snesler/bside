/**
 * A chat popped out into a tab of its own (`chat.html#/<sessionId>`): the
 * hash that names its session, and the status its tab shows in the favicon
 * and title. Pure, so the page computes them from state it already has.
 */

import type { RunState } from "@/lib/protocol";
import type { RunDigestStatus } from "@/lib/domain/conversation";
import { isSessionId } from "@/lib/validation";

/** What a pop-out tab shows about its chat. */
export type ChatTabStatus = "idle" | "working" | "needs-you" | "failed" | "finished";

/** Each status's favicon: static SVGs of bside's face under `public/favicon/`. */
export const CHAT_TAB_ICONS: Readonly<Record<ChatTabStatus, string>> = {
  idle: "/favicon/idle.svg",
  working: "/favicon/working.svg",
  "needs-you": "/favicon/needs-you.svg",
  failed: "/favicon/failed.svg",
  finished: "/favicon/finished.svg",
};

/** The session a pop-out page's hash names (`#/<sessionId>`), or null when it names none. */
export function parseChatHash(hash: string): string | null {
  const match = /^#\/(.*)$/s.exec(hash);
  return match && isSessionId(match[1]) ? match[1] : null;
}

/** The hash that names `sessionId` in a pop-out page's URL. */
export function chatHash(sessionId: string): string {
  return `#/${sessionId}`;
}

export interface ChatTabState {
  /** The chat's run in progress, if any. */
  run: Pick<RunState, "status" | "pendingApproval" | "pendingHelp"> | null;
  /** How the chat's last turn ended, from its digest; null before any ended. */
  outcome: RunDigestStatus | null;
  /** The chat's last run failed, as the page saw its `run.failed` event (before a snapshot brings the digest). */
  failed: boolean;
  /** A run ended while the page was hidden, and the user has not looked since. */
  unseen: boolean;
}

/**
 * The status to show: needs you (a pending confirmation or help request),
 * working (any other run in progress), the last run failed or was
 * interrupted, it finished while the tab was hidden, else idle.
 */
export function chatTabStatus(state: ChatTabState): ChatTabStatus {
  const { run } = state;
  if (run) {
    const waiting = run.status === "awaiting-approval" || run.status === "awaiting-help" || run.pendingApproval !== null || run.pendingHelp !== null;
    return waiting ? "needs-you" : "working";
  }
  if (state.failed || state.outcome === "failed" || state.outcome === "interrupted") return "failed";
  return state.unseen ? "finished" : "idle";
}

/** The tab's title: the chat's title (untrusted text; only ever a document title) with its status's prefix. */
export function chatTabTitle(status: ChatTabStatus, title: string): string {
  const name = title.trim() || "New chat";
  switch (status) {
    case "working": return `◌ ${name}`;
    case "needs-you": return `(!) ${name}`;
    case "failed": return `✕ ${name}`;
    case "finished": return `• ${name}`;
    default: return `${name} — bside`;
  }
}
