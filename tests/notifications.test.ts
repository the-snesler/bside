import { describe, expect, it, vi } from "vitest";
import {
  LONG_RUN_NOTIFICATION_MS,
  MAX_RUN_NOTIFICATIONS,
  RUN_NOTIFICATION_PREFIX,
  RunNotifications,
  type FinishedNotification,
  type RunNotificationOptions,
  type RunNotificationsBrowserApi,
} from "@/lib/background/notifications";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function event<Listener extends (...args: never[]) => void>() {
  const listeners = new Set<Listener>();
  return {
    addListener: vi.fn((listener: Listener) => { listeners.add(listener); }),
    removeListener: vi.fn((listener: Listener) => { listeners.delete(listener); }),
    emit: (...args: Parameters<Listener>) => { for (const listener of listeners) listener(...args); },
    listeners,
  };
}

function harness(enabled?: boolean, existing: Record<string, RunNotificationOptions> = {}) {
  const visible = new Map(Object.entries(existing));
  const onClicked = event<(id: string) => void>();
  const onClosed = event<(id: string, byUser: boolean) => void>();
  const api = {
    create: vi.fn(async (id: string, options: RunNotificationOptions) => { visible.set(id, options); return id; }),
    clear: vi.fn(async (id: string) => {
      const removed = visible.delete(id);
      if (removed) onClosed.emit(id, false);
      return removed;
    }),
    getAll: vi.fn(async () => Object.fromEntries(visible)),
    onClicked,
    onClosed,
  } satisfies RunNotificationsBrowserApi;
  const openSidebar = vi.fn<() => void | Promise<unknown>>();
  const selectSession = vi.fn<(id: string) => void | Promise<unknown>>();
  const notifications = new RunNotifications({ api, enabled, openSidebar, selectSession, iconUrl: "moz-extension://test/icon.svg" });
  return { api, visible, notifications, openSidebar, selectSession };
}

const completed: FinishedNotification = { scheduled: false, durationMs: LONG_RUN_NOTIFICATION_MS, status: "completed" };

function notificationId(h: ReturnType<typeof harness>): string {
  const id = h.visible.keys().next().value;
  if (id === undefined) throw new Error("Expected a visible notification.");
  return id;
}

async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

describe("private run notifications", () => {
  it("defaults off for all kinds and creates only after an explicit opt-in", async () => {
    const h = harness();
    await h.notifications.initialize();
    await h.notifications.pending("r1", "s1", "approval");
    await h.notifications.pending("r2", "s2", "help");
    await h.notifications.finished("r3", "s3", completed);
    await h.notifications.finished("r4", "s4", { ...completed, scheduled: true });
    expect(h.api.create).not.toHaveBeenCalled();
    await h.notifications.setEnabled(true);
    await h.notifications.pending("r5", "s5", "approval");
    expect(h.api.create).toHaveBeenCalledOnce();
  });

  it("notifies successful long runs at exactly 60 seconds, with no ordinary failure or cancellation hint", async () => {
    const h = harness(true);
    await h.notifications.finished("short", "s", { ...completed, durationMs: LONG_RUN_NOTIFICATION_MS - 1 });
    for (const status of ["failed", "cancelled", "interrupted"] as const) {
      await h.notifications.finished(status, "s", { ...completed, status });
    }
    for (const durationMs of [NaN, Infinity, -1]) {
      await h.notifications.finished(`invalid-${durationMs}`, "s", { ...completed, durationMs });
    }
    expect(h.api.create).not.toHaveBeenCalled();
    await h.notifications.finished("long", "s", completed);
    expect(h.api.create).toHaveBeenCalledOnce();
    expect([...h.visible.values()]).toEqual([{ type: "basic", title: "bside", message: "A run has finished. Open bside to view it.", iconUrl: "moz-extension://test/icon.svg" }]);
  });

  it.each(["completed", "failed", "cancelled", "interrupted"] as const)("notifies short scheduled runs that are %s", async (status) => {
    const h = harness(true);
    await h.notifications.finished("run", "session", { scheduled: true, durationMs: 1, status });
    expect([...h.visible.values()]).toEqual([expect.objectContaining({ title: "bside", message: "A scheduled run has finished. Open bside to view it." })]);
    await h.notifications.finished("run", "session", { scheduled: true, durationMs: 1, status });
    expect(h.api.create).toHaveBeenCalledOnce();
  });

  it("sends fixed private content, random IDs, and no run, session, or arbitrary extra text to the browser", async () => {
    const h = harness(true);
    const privateText = "Private page, prompt, model result and chat title";
    await h.notifications.pending(privateText, `session:${privateText}`, "approval");
    await h.notifications.pending(`help:${privateText}`, `session:${privateText}`, "help");
    await h.notifications.finished(`finished:${privateText}`, `session:${privateText}`, {
      ...completed, prompt: privateText, title: privateText, output: privateText,
    } as FinishedNotification);
    expect(h.api.create).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(h.api.create.mock.calls)).not.toContain(privateText);
    expect([...h.visible.keys()].every((id) => id.startsWith(RUN_NOTIFICATION_PREFIX))).toBe(true);
    expect(new Set(h.api.create.mock.calls.map(([id]) => id)).size).toBe(3);
    expect(h.api.create.mock.calls.map(([, options]) => options.message)).toEqual([
      "A run needs your confirmation. Open bside to continue.",
      "A run needs your help. Open bside to continue.",
      "A run has finished. Open bside to view it.",
    ]);
  });

  it("deduplicates a wait, replaces its kind, and permits a new wait after resolution", async () => {
    const h = harness(true);
    await Promise.all([
      h.notifications.pending("run", "session", "approval"),
      h.notifications.pending("run", "session", "approval"),
    ]);
    expect(h.api.create).toHaveBeenCalledOnce();
    const approvalId = notificationId(h);
    await h.notifications.pending("run", "session", "help");
    expect(h.visible.has(approvalId)).toBe(false);
    expect(h.visible.size).toBe(1);
    await h.notifications.clearPending("run");
    expect(h.visible.size).toBe(0);
    await h.notifications.pending("run", "session", "help");
    expect(h.api.create).toHaveBeenCalledTimes(3);
  });

  it("keeps a dismissed wait deduplicated until it resolves and ignores its stale click", async () => {
    const h = harness(true);
    await h.notifications.pending("run", "session", "approval");
    const id = notificationId(h);
    h.visible.delete(id);
    h.api.onClosed.emit(id, true);
    h.api.onClicked.emit(id);
    expect(h.openSidebar).not.toHaveBeenCalled();
    await h.notifications.pending("run", "session", "approval");
    expect(h.api.create).toHaveBeenCalledOnce();
    await h.notifications.clearPending("run");
    await h.notifications.pending("run", "session", "approval");
    expect(h.api.create).toHaveBeenCalledTimes(2);
  });

  it("clears pending hints at every terminal transition and suppresses late pending events", async () => {
    for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
      const h = harness(true);
      await h.notifications.pending("run", "session", "help");
      const id = notificationId(h);
      await h.notifications.finished("run", "session", { ...completed, durationMs: 1, status });
      expect(h.visible.size).toBe(0);
      expect(h.api.clear).toHaveBeenCalledWith(id);
      await h.notifications.pending("run", "session", "help");
      expect(h.api.create).toHaveBeenCalledOnce();
    }
  });

  it("keeps the terminal result when clearing pending hints and removes it with clearRun", async () => {
    const h = harness(true);
    await h.notifications.pending("run", "session", "approval");
    await h.notifications.finished("run", "session", completed);
    expect(h.visible.size).toBe(1);
    await h.notifications.clearPending("run");
    expect(h.visible.size).toBe(1);
    await h.notifications.clearRun("run");
    expect(h.visible.size).toBe(0);
    await h.notifications.clearRun("run");
  });

  it("opens the sidebar synchronously and selects the mapped session asynchronously without awaiting open", async () => {
    const h = harness(true);
    const opening = deferred<void>();
    h.openSidebar.mockReturnValue(opening.promise);
    await h.notifications.finished("r1", "session-one", completed);
    const first = notificationId(h);
    await h.notifications.finished("r2", "session-two", completed);
    h.api.onClicked.emit("unknown");
    expect(h.openSidebar).not.toHaveBeenCalled();
    h.api.onClicked.emit(first);
    expect(h.openSidebar).toHaveBeenCalledOnce();
    expect(h.selectSession).not.toHaveBeenCalled();
    await flush();
    expect(h.selectSession).toHaveBeenCalledExactlyOnceWith("session-one");
    expect(h.visible.has(first)).toBe(false);
    expect(h.visible.size).toBe(1);
    h.api.onClicked.emit(first);
    expect(h.openSidebar).toHaveBeenCalledOnce();
    opening.resolve();
  });

  it.each(["throw", "reject"])("contains sidebar and deleted-session callback failures that %s", async (failure) => {
    const h = harness(true);
    const fail = () => { if (failure === "throw") throw new Error("private failure"); return Promise.reject(new Error("private failure")); };
    h.openSidebar.mockImplementation(fail);
    h.selectSession.mockImplementation(fail);
    await h.notifications.pending("r", "deleted-session", "help");
    expect(() => h.api.onClicked.emit(notificationId(h))).not.toThrow();
    await flush();
    expect(h.selectSession).toHaveBeenCalledWith("deleted-session");
    expect(h.visible.size).toBe(0);
  });

  it("cleans up only extension-owned IDs on startup, even when disabled, and initializes once", async () => {
    const options: RunNotificationOptions = { type: "basic", title: "bside", message: "old" };
    const stale = `${RUN_NOTIFICATION_PREFIX}old-random-id`;
    const h = harness(undefined, { [stale]: options, "other-feature": options });
    h.api.onClicked.emit(stale);
    await Promise.all([h.notifications.initialize(), h.notifications.initialize()]);
    expect([...h.visible.keys()]).toEqual(["other-feature"]);
    expect(h.api.clear).toHaveBeenCalledExactlyOnceWith(stale);
    expect(h.api.getAll).toHaveBeenCalledOnce();
    expect(h.api.onClicked.listeners.size).toBe(1);
    h.api.onClicked.emit(stale);
    expect(h.openSidebar).not.toHaveBeenCalled();
  });

  it("waits for restart cleanup before creating new hints", async () => {
    const h = harness(true);
    const enumerating = deferred<Record<string, RunNotificationOptions>>();
    h.api.getAll.mockReturnValue(enumerating.promise);
    const pending = h.notifications.pending("r", "s", "help");
    await flush();
    expect(h.api.create).not.toHaveBeenCalled();
    enumerating.resolve({});
    await pending;
    expect(h.api.create).toHaveBeenCalledOnce();
    expect(h.visible.size).toBe(1);
  });

  it("invalidates creates during startup cleanup on disable, even after re-enabling", async () => {
    const h = harness(true);
    const enumerating = deferred<Record<string, RunNotificationOptions>>();
    h.api.getAll.mockReturnValue(enumerating.promise);
    const stale = h.notifications.pending("r1", "s1", "help");
    await h.notifications.setEnabled(false);
    await h.notifications.setEnabled(true);
    const current = h.notifications.pending("r2", "s2", "help");
    enumerating.resolve({});
    await Promise.all([stale, current]);
    expect(h.api.create).toHaveBeenCalledOnce();
    h.api.onClicked.emit(notificationId(h));
    await flush();
    expect(h.selectSession).toHaveBeenCalledExactlyOnceWith("s2");
  });

  it("clears existing hints and late browser creates when disabled without deleting a newly enabled hint", async () => {
    const h = harness(true);
    await h.notifications.pending("visible", "s", "approval");
    const creating = deferred<string>();
    let lateId = "";
    h.api.create.mockImplementationOnce(async (id, options) => {
      lateId = id;
      await creating.promise;
      h.visible.set(id, options);
      return id;
    });
    const late = h.notifications.pending("late", "s", "help");
    await flush();
    expect(lateId).not.toBe("");
    await h.notifications.setEnabled(false);
    expect(h.visible.size).toBe(0);
    await h.notifications.setEnabled(true);
    await h.notifications.pending("late", "current-session", "help");
    const currentId = notificationId(h);
    creating.resolve(lateId);
    await late;
    expect([...h.visible.keys()]).toEqual([currentId]);
    h.api.onClicked.emit(lateId);
    expect(h.openSidebar).not.toHaveBeenCalled();
    h.api.onClicked.emit(currentId);
    await flush();
    expect(h.selectSession).toHaveBeenCalledExactlyOnceWith("current-session");
  });

  it("invalidates a pending browser create when its wait resolves", async () => {
    const h = harness(true);
    const creating = deferred<void>();
    h.api.create.mockImplementationOnce(async (id, options) => {
      await creating.promise;
      h.visible.set(id, options);
      return id;
    });
    const pending = h.notifications.pending("r", "s", "approval");
    await flush();
    await h.notifications.clearPending("r");
    creating.resolve();
    await pending;
    expect(h.visible.size).toBe(0);
    expect(h.api.clear).toHaveBeenCalledTimes(2);
  });

  it("bounds visible notifications and click mappings, clearing the oldest run", async () => {
    const h = harness(true);
    await h.notifications.finished("oldest", "old-session", completed);
    const oldestId = notificationId(h);
    for (let i = 0; i < MAX_RUN_NOTIFICATIONS; i++) {
      await h.notifications.finished(`r${i}`, `s${i}`, completed);
    }
    expect(h.visible.size).toBe(MAX_RUN_NOTIFICATIONS);
    expect(h.visible.has(oldestId)).toBe(false);
    h.api.onClicked.emit(oldestId);
    expect(h.openSidebar).not.toHaveBeenCalled();
    await h.notifications.setEnabled(false);
    expect(h.visible.size).toBe(0);
  });

  it("disposes listeners and hints idempotently and blocks queued session selections", async () => {
    const h = harness(true);
    await h.notifications.pending("r", "s", "help");
    const id = notificationId(h);
    h.api.onClicked.emit(id);
    const disposing = h.notifications.dispose();
    expect(h.api.onClicked.listeners.size).toBe(0);
    expect(h.api.onClosed.listeners.size).toBe(0);
    await disposing;
    expect(h.selectSession).not.toHaveBeenCalled();
    expect(h.visible.size).toBe(0);
    await h.notifications.dispose();
    await h.notifications.setEnabled(true);
    await h.notifications.initialize();
    await h.notifications.pending("r2", "s", "approval");
    await h.notifications.finished("r3", "s", completed);
    expect(h.api.create).toHaveBeenCalledOnce();
    expect(h.api.onClicked.removeListener).toHaveBeenCalledOnce();
    expect(h.api.onClosed.removeListener).toHaveBeenCalledOnce();
  });

  it.each(["disable", "dispose", "clearRun", "finished"] as const)("invalidates late creates on %s", async (action) => {
    const h = harness(true);
    const creating = deferred<void>();
    h.api.create.mockImplementationOnce(async (id, options) => {
      await creating.promise;
      h.visible.set(id, options);
      return id;
    });
    const pending = h.notifications.pending("r", "s", "help");
    await flush();
    if (action === "disable") await h.notifications.setEnabled(false);
    if (action === "dispose") await h.notifications.dispose();
    if (action === "clearRun") await h.notifications.clearRun("r");
    if (action === "finished") await h.notifications.finished("r", "s", { ...completed, durationMs: 1 });
    creating.resolve();
    await pending;
    expect(h.visible.size).toBe(0);
  });

  it("tolerates absent or partial browser APIs", async () => {
    for (const api of [undefined, {}, { create: vi.fn(async () => "id") }, { clear: vi.fn(async () => true) }]) {
      const notifications = new RunNotifications({ api, enabled: true, openSidebar: vi.fn(), selectSession: vi.fn() });
      await expect(notifications.initialize()).resolves.toBeUndefined();
      await expect(notifications.pending("r", "s", "approval")).resolves.toBeUndefined();
      await expect(notifications.finished("r", "s", completed)).resolves.toBeUndefined();
      await expect(notifications.setEnabled(false)).resolves.toBeUndefined();
      await expect(notifications.dispose()).resolves.toBeUndefined();
      if (api && "create" in api) expect(api.create).not.toHaveBeenCalled();
    }
  });

  it.each(["throw", "reject"])("contains browser methods that %s and never forwards their private errors", async (failure) => {
    const h = harness(true);
    const fail = () => { if (failure === "throw") throw new Error("private browser error"); return Promise.reject(new Error("private browser error")); };
    h.api.getAll.mockImplementation(fail);
    h.api.create.mockImplementation(fail);
    h.api.clear.mockImplementation(fail);
    h.api.onClicked.addListener.mockImplementation(() => { throw new Error("private listener error"); });
    h.api.onClosed.addListener.mockImplementation(() => { throw new Error("private listener error"); });
    h.api.onClicked.removeListener.mockImplementation(() => { throw new Error("private listener error"); });
    h.api.onClosed.removeListener.mockImplementation(() => { throw new Error("private listener error"); });
    await expect(h.notifications.initialize()).resolves.toBeUndefined();
    await expect(h.notifications.pending("r", "s", "help")).resolves.toBeUndefined();
    await expect(h.notifications.clearPending("r")).resolves.toBeUndefined();
    await expect(h.notifications.finished("r", "s", completed)).resolves.toBeUndefined();
    await expect(h.notifications.clearRun("r")).resolves.toBeUndefined();
    await expect(h.notifications.setEnabled(false)).resolves.toBeUndefined();
    await expect(h.notifications.dispose()).resolves.toBeUndefined();
  });
});
