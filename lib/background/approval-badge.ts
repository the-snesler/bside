/**
 * Toolbar badge that flags a run paused on `request_action_confirmation`, so
 * a pending approval stays visible while the sidebar is closed. Only
 * `BackgroundRuntime` drives it; `pending` lets the toolbar click handler
 * open (rather than toggle closed) the sidebar synchronously.
 */

export interface ApprovalBadgeBrowserApi {
  setBadgeText(details: { text: string }): Promise<void> | void;
  setBadgeBackgroundColor(details: { color: string }): Promise<void> | void;
}

const BADGE_COLOR = "#d97706";

export class ApprovalBadge {
  #api: ApprovalBadgeBrowserApi;
  #pending = false;

  constructor(api: ApprovalBadgeBrowserApi) {
    this.#api = api;
  }

  get pending(): boolean {
    return this.#pending;
  }

  /** Always writes through, so startup and terminal clears are unconditional. Badge failures never affect a run. */
  set(pending: boolean): void {
    this.#pending = pending;
    if (pending) void Promise.resolve().then(() => this.#api.setBadgeBackgroundColor({ color: BADGE_COLOR })).catch(() => {});
    void Promise.resolve().then(() => this.#api.setBadgeText({ text: pending ? "!" : "" })).catch(() => {});
  }
}
