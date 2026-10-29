/**
 * Toolbar badge that flags runs paused on the user (a confirmation or a help
 * request), so a pending pause stays visible while the sidebar is closed.
 * Several runs can wait at once: the badge tracks each waiting run by id and
 * shows `!` while any does, `•` for unread scheduled results otherwise. Only
 * `BackgroundRuntime` drives it; `attention` lets the toolbar click handler
 * open (rather than toggle closed) the sidebar synchronously.
 */

export interface ApprovalBadgeBrowserApi {
  setBadgeText(details: { text: string }): Promise<void> | void;
  setBadgeBackgroundColor(details: { color: string }): Promise<void> | void;
}

const BADGE_COLOR = "#d97706";

export class ApprovalBadge {
  #api: ApprovalBadgeBrowserApi;
  /** Runs waiting for the user, in the order they began waiting. */
  #waiting = new Set<string>();
  #results = false;

  constructor(api: ApprovalBadgeBrowserApi) {
    this.#api = api;
  }

  /** Some run waits for the user. */
  get pending(): boolean {
    return this.#waiting.size > 0;
  }
  get attention(): boolean { return this.pending || this.#results; }

  /** The waiting runs' ids, the one that has waited longest first. */
  waitingRuns(): string[] {
    return [...this.#waiting];
  }

  setResults(results: boolean): void {
    if (results === this.#results) return;
    this.#results = results;
    this.#write();
  }

  /** Marks whether `runId` waits for the user. A run already waiting keeps its place. */
  setPending(runId: string, pending: boolean): void {
    if (pending) this.#waiting.add(runId);
    else this.#waiting.delete(runId);
    this.#write();
  }

  /** The run ended (or stopped waiting for good): it no longer counts. */
  clearRun(runId: string): void {
    this.setPending(runId, false);
  }

  /** At startup no run can be waiting; writes through, clearing a stale badge. */
  clearAll(): void {
    this.#waiting.clear();
    this.#write();
  }

  /** Always writes through, so startup and terminal clears are unconditional. Badge failures never affect a run. */
  #write(): void {
    const pending = this.pending;
    if (pending) void Promise.resolve().then(() => this.#api.setBadgeBackgroundColor({ color: BADGE_COLOR })).catch(() => {});
    void Promise.resolve().then(() => this.#api.setBadgeText({ text: pending ? "!" : this.#results ? "•" : "" })).catch(() => {});
  }
}
