import type { RunDigestStatus } from "@/lib/domain/conversation";

/** Stable prefix for removing this service's stale notifications after a restart. */
export const RUN_NOTIFICATION_PREFIX = "bside:run:v1:";
export const LONG_RUN_NOTIFICATION_MS = 60_000;
export const MAX_RUN_NOTIFICATIONS = 64;

export type PendingNotificationKind = "approval" | "help";

export interface RunNotificationOptions {
  type: "basic";
  title: string;
  message: string;
  iconUrl?: string;
}

interface NotificationEvent<Listener> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

/** Optional members let the service tolerate missing permissions or browser APIs. */
export interface RunNotificationsBrowserApi {
  create?(id: string, options: RunNotificationOptions): Promise<string> | string;
  clear?(id: string): Promise<boolean> | boolean;
  getAll?(): Promise<Record<string, unknown>> | Record<string, unknown>;
  onClicked?: NotificationEvent<(id: string) => void>;
  onClosed?: NotificationEvent<(id: string, byUser: boolean) => void>;
}

export interface RunNotificationsOptions {
  api?: RunNotificationsBrowserApi;
  /** The caller owns persistence and must call setEnabled when the preference changes. */
  enabled?: boolean;
  /** Called in the notification click's stack, preserving Firefox's user gesture. */
  openSidebar: () => void | Promise<unknown>;
  /** Called asynchronously; the caller handles sessions that no longer exist. */
  selectSession: (sessionId: string) => void | Promise<unknown>;
  /** A packaged extension asset, supplied by the background entrypoint if needed. */
  iconUrl?: string;
}

export interface FinishedNotification {
  scheduled: boolean;
  durationMs: number;
  status: RunDigestStatus;
}

type NotificationKind = PendingNotificationKind | "finished";
interface ManagedNotification {
  id: string;
  sessionId: string;
  kind: NotificationKind;
  creating?: Promise<void>;
}
interface RunNotificationsState {
  terminal: boolean;
  notice?: ManagedNotification;
}

/**
 * Background-owned, opt-in hints. Only opaque IDs enter the in-memory mapping;
 * notification IDs are random and their visible content is fixed. No storage,
 * page text, prompts, model output, or chat titles enter this service.
 *
 * All operations are best effort and their promises always resolve. Resolving a
 * wait calls clearPending; every terminal transition calls finished (which also
 * clears pending hints). clearRun removes all hints and forgets that run.
 */
export class RunNotifications {
  #options: RunNotificationsOptions;
  #enabled: boolean;
  #disposed = false;
  #initializing: Promise<void> | undefined;
  #generation = 0;
  // At most one hint per run; dismissed hints retain a bounded dedupe marker.
  #runs = new Map<string, RunNotificationsState>();
  #byId = new Map<string, ManagedNotification>();

  constructor(options: RunNotificationsOptions) {
    this.#options = options;
    this.#enabled = options.enabled === true;
  }

  /** Idempotent startup cleanup, including when notifications are disabled. */
  initialize(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    return this.#initializing ??= this.#initialize();
  }

  async #initialize(): Promise<void> {
    try { this.#options.api?.onClicked?.addListener(this.#clicked); } catch { /* Optional API. */ }
    try { this.#options.api?.onClosed?.addListener(this.#closed); } catch { /* Optional API. */ }
    try {
      const existing = await this.#options.api?.getAll?.();
      if (existing) await Promise.all(Object.keys(existing)
        .filter((id) => id.startsWith(RUN_NOTIFICATION_PREFIX))
        .map((id) => this.#clear(id)));
    } catch { /* Browser failures must never affect a run. */ }
  }

  /** Invalidates creates immediately, even when their browser promises are pending. */
  setEnabled(enabled: boolean): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#enabled = enabled === true;
    if (this.#enabled) return Promise.resolve();
    this.#generation++;
    return this.#clearAll();
  }

  pending(runId: string, sessionId: string, kind: PendingNotificationKind): Promise<void> {
    if (this.#disposed || !this.#enabled || (kind !== "approval" && kind !== "help")) return Promise.resolve();
    const run = this.#run(runId);
    if (run.terminal || run.notice?.kind === kind) return run.notice?.creating ?? Promise.resolve();
    if (run.notice) void this.#forget(run.notice);
    const message = kind === "approval"
      ? "A run needs your confirmation. Open bside to continue."
      : "A run needs your help. Open bside to continue.";
    return this.#show(run, sessionId, kind, message);
  }

  /** Ordinary successful runs notify after 60 seconds; scheduled runs notify for every terminal status. */
  finished(runId: string, sessionId: string, result: FinishedNotification): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const run = this.#run(runId);
    if (run.terminal) return run.notice?.creating ?? Promise.resolve();
    run.terminal = true;
    const clearing = run.notice ? this.#forget(run.notice) : Promise.resolve();
    run.notice = undefined;
    const terminal = result.status === "completed" || result.status === "failed"
      || result.status === "cancelled" || result.status === "interrupted";
    const longCompletion = result.status === "completed" && Number.isFinite(result.durationMs)
      && result.durationMs >= LONG_RUN_NOTIFICATION_MS;
    if (!this.#enabled || !terminal || (!result.scheduled && !longCompletion)) return clearing;
    const message = result.scheduled
      ? "A scheduled run has finished. Open bside to view it."
      : "A run has finished. Open bside to view it.";
    return Promise.all([clearing, this.#show(run, sessionId, "finished", message)]).then(() => {});
  }

  /** Resolving a wait permits a later, distinct wait of the same kind to notify again. */
  clearPending(runId: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run?.notice || run.notice.kind === "finished") return Promise.resolve();
    const notice = run.notice;
    run.notice = undefined;
    return this.#forget(notice);
  }

  clearRun(runId: string): Promise<void> {
    const run = this.#runs.get(runId);
    this.#runs.delete(runId);
    return run?.notice ? this.#forget(run.notice) : Promise.resolve();
  }

  /** Removes listeners, clears hints, and makes this instance permanently inert. */
  dispose(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    this.#disposed = true;
    this.#enabled = false;
    this.#generation++;
    try { this.#options.api?.onClicked?.removeListener(this.#clicked); } catch { /* Optional API. */ }
    try { this.#options.api?.onClosed?.removeListener(this.#closed); } catch { /* Optional API. */ }
    return this.#clearAll();
  }

  #run(runId: string): RunNotificationsState {
    let run = this.#runs.get(runId);
    if (run) return run;
    if (this.#runs.size >= MAX_RUN_NOTIFICATIONS) {
      const oldest = this.#runs.keys().next().value;
      if (oldest !== undefined) void this.clearRun(oldest);
    }
    run = { terminal: false };
    this.#runs.set(runId, run);
    return run;
  }

  #show(run: RunNotificationsState, sessionId: string, kind: NotificationKind, message: string): Promise<void> {
    try {
      const api = this.#options.api;
      // Creating without a clear method would leave hints we cannot invalidate.
      if (!api?.create || !api.clear) return Promise.resolve();
      const notice: ManagedNotification = { id: `${RUN_NOTIFICATION_PREFIX}${crypto.randomUUID()}`, sessionId, kind };
      run.notice = notice;
      this.#byId.set(notice.id, notice);
      return notice.creating = this.#create(notice, message);
    } catch { return Promise.resolve(); }
  }

  async #create(notice: ManagedNotification, message: string): Promise<void> {
    try {
      // Startup enumeration must finish before a new notification can be created.
      await this.initialize();
      if (!this.#current(notice)) return;
      const { api, iconUrl } = this.#options;
      await api!.create!(notice.id, { type: "basic", title: "bside", message, ...(iconUrl ? { iconUrl } : {}) });
    } catch {
      if (this.#byId.get(notice.id) === notice) this.#byId.delete(notice.id);
    }
    // A disable, resolve, eviction, or disposal may have raced the browser create.
    if (!this.#current(notice)) await this.#clear(notice.id);
  }

  #current(notice: ManagedNotification): boolean {
    return this.#enabled && !this.#disposed && this.#byId.get(notice.id) === notice;
  }

  #forget(notice: ManagedNotification): Promise<void> {
    this.#byId.delete(notice.id);
    return this.#clear(notice.id);
  }

  #clearAll(): Promise<void> {
    const notices = [...this.#runs.values()].flatMap((run) => run.notice ? [run.notice] : []);
    this.#runs.clear();
    this.#byId.clear();
    return Promise.all(notices.map((notice) => this.#clear(notice.id))).then(() => {});
  }

  async #clear(id: string): Promise<void> {
    try { await this.#options.api?.clear?.(id); } catch { /* Best effort. */ }
  }

  #closed = (id: string): void => {
    this.#byId.delete(id);
  };

  #clicked = (id: string): void => {
    const notice = this.#byId.get(id);
    if (!notice || !this.#current(notice)) return;
    const generation = this.#generation;
    // Do not introduce an await or defer this call: Firefox requires the gesture.
    try { void Promise.resolve(this.#options.openSidebar()).catch(() => {}); } catch { /* Best effort. */ }
    void Promise.resolve().then(() => {
      if (!this.#disposed && this.#enabled && generation === this.#generation) {
        return this.#options.selectSession(notice.sessionId);
      }
    }).catch(() => {});
    void this.#forget(notice);
  };
}
