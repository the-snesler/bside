import { beforeEach, describe, expect, it, vi } from "vitest";
import { storage } from "wxt/utils/storage";
import { TaskScheduler, SCHEDULE_ALARM } from "@/lib/background/scheduler";
import { isTaskDraft, MAX_SCHEDULED_TASKS, nextTaskTime, type TaskDraft } from "@/lib/domain/automation";
import { getNotificationSettings, getScheduledTasks, saveScheduledTasks } from "@/lib/storage";
import { isAutomationRequest, isContentMessage, isSidebarCommand } from "@/lib/protocol";

const draft: TaskDraft = { name: "Morning check", prompt: "Check the page", url: "https://example.test/", enabled: true, schedule: { kind: "interval", minutes: 5 } };
beforeEach(() => fakeBrowser.reset());
function setup() {
  let now = new Date(2026, 9, 24, 8).getTime();
  const alarms = { create: vi.fn(), clear: vi.fn(async () => true) };
  const dispatch = vi.fn(async () => ({ status: "started" as const, sessionId: "results", runId: "run-1" }));
  const scheduler = new TaskScheduler({ alarms, now: () => now, dispatch, liveSessions: async () => ["results"] });
  return { alarms, scheduler, dispatch, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe("automation contracts", () => {
  it("bounds schedules, URLs, and prompts and excludes privileged commands from other protocols", () => {
    for (const schedule of [{ kind: "daily", time: "09:00" }, { kind: "interval", minutes: 5 }, { kind: "interval", minutes: 10080 }]) expect(isTaskDraft({ ...draft, schedule })).toBe(true);
    for (const schedule of [{ kind: "daily", time: "24:00" }, { kind: "daily", time: "9:00" }, { kind: "interval", minutes: 0 }, { kind: "interval", minutes: 4 }, { kind: "interval", minutes: 5.5 }, { kind: "interval", minutes: 10081 }, { kind: "interval", minutes: 5, extra: true }]) expect(isTaskDraft({ ...draft, schedule })).toBe(false);
    for (const url of ["file:///tmp/x", "javascript:alert(1)", "ftp://example.test/", "https://user:password@example.test/", "bad"]) expect(isTaskDraft({ ...draft, url })).toBe(false);
    for (const prompt of ["", " ", "x".repeat(16001)]) expect(isTaskDraft({ ...draft, prompt })).toBe(false);
    const requests = [{ type: "automation.get" }, { type: "automation.save", taskId: null, task: draft }, { type: "automation.delete", taskId: "task-1" }, { type: "automation.results", taskId: "task-1" }, { type: "automation.notifications.save", enabled: true }];
    for (const request of requests) {
      const message = { v: 1, id: "request", ...request };
      expect(isAutomationRequest(message)).toBe(true);
      expect(isSidebarCommand(message)).toBe(false);
      expect(isContentMessage(message)).toBe(false);
    }
    expect(isAutomationRequest({ v: 1, id: "x", type: "automation.notifications.save", enabled: "true" })).toBe(false);
    expect(isAutomationRequest({ v: 1, id: "x", type: "automation.save", taskId: null, task: { ...draft, prompt: "" } })).toBe(false);
  });

  it("computes daily times strictly in the future using the local calendar", () => {
    const before = new Date(2026, 9, 24, 8, 59).getTime();
    const morning = new Date(2026, 9, 24, 9).getTime();
    expect(nextTaskTime({ kind: "daily", time: "09:00" }, before)).toBe(morning);
    expect(nextTaskTime({ kind: "daily", time: "09:00" }, morning)).toBe(new Date(2026, 9, 25, 9).getTime());
    expect(nextTaskTime({ kind: "interval", minutes: 5 }, before)).toBe(before + 300_000);
  });

  it("revalidates records, drops duplicates and bounds storage, and defaults notifications off", async () => {
    const { scheduler } = setup();
    const [task] = await scheduler.save(null, draft);
    await storage.setItem("local:scheduledTasks", { version: 1, tasks: [task, task, { ...task, id: "bad", url: "file:///tmp/a" }, null] });
    expect(await getScheduledTasks()).toEqual([task]);
    const many = Array.from({ length: MAX_SCHEDULED_TASKS + 3 }, (_, i) => ({ ...task, id: `task-${i}` }));
    await storage.setItem("local:scheduledTasks", { version: 1, tasks: many });
    expect(await getScheduledTasks()).toHaveLength(MAX_SCHEDULED_TASKS);
    await expect(scheduler.save(null, draft)).rejects.toThrow("50");
    await storage.setItem("local:scheduledTasks", { version: 99, tasks: [task] });
    expect(await getScheduledTasks()).toEqual([]);
    expect(await storage.getItem("local:scheduledTasks")).toBeNull();
    expect(await getNotificationSettings()).toEqual({ version: 1, enabled: false });
    await storage.setItem("local:notificationSettings", { version: 1, enabled: "yes" });
    expect(await getNotificationSettings()).toEqual({ version: 1, enabled: false });
  });
});

describe("TaskScheduler", () => {
  it("commits a future tick before dispatch, ignores early/duplicate alarms, and runs once", async () => {
    const { scheduler, advance, dispatch, alarms, now } = setup();
    const [task] = await scheduler.save(null, draft);
    expect(alarms.create).toHaveBeenLastCalledWith(SCHEDULE_ALARM, { when: task!.nextAt });
    await scheduler.handleAlarm("another-alarm"); await scheduler.handleAlarm(SCHEDULE_ALARM);
    expect(dispatch).not.toHaveBeenCalled();
    advance(5 * 60_000);
    dispatch.mockImplementation(async () => {
      expect((await getScheduledTasks())[0]!.nextAt).toBeGreaterThan(now());
      return { status: "started", runId: "run-1", sessionId: "results" };
    });
    await Promise.all([scheduler.handleAlarm(SCHEDULE_ALARM), scheduler.handleAlarm(SCHEDULE_ALARM)]);
    expect(dispatch).toHaveBeenCalledOnce();
    expect((await scheduler.list())[0]).toMatchObject({ lastRun: { runId: "run-1", status: "running", endedAt: null }, sessionId: "results" });
  });

  it("skips missed ticks on restart, marks interrupted runs, and never catches up", async () => {
    const { scheduler, advance, dispatch, now } = setup();
    await scheduler.save(null, draft); advance(300_000); await scheduler.handleAlarm(SCHEDULE_ALARM);
    advance(10 * 24 * 60 * 60_000);
    await scheduler.initialize();
    expect(dispatch).toHaveBeenCalledOnce();
    expect((await scheduler.list())[0]).toMatchObject({ lastRun: { status: "interrupted", endedAt: now() }, lastTick: { status: "missed" }, nextAt: now() + 300_000, unread: true });
    await scheduler.handleAlarm(SCHEDULE_ALARM);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("disabling/deleting leaves history alone; missing sessions disable tasks and clear result links", async () => {
    const { scheduler, advance } = setup();
    const [task] = await scheduler.save(null, draft); advance(300_000); await scheduler.handleAlarm(SCHEDULE_ALARM);
    await scheduler.forgetSessions(["results"]);
    expect((await scheduler.list())[0]).toMatchObject({ enabled: false, sessionId: null, nextAt: null, lastRun: null, lastTick: { status: "history-deleted" } });
    await scheduler.save(task!.id, draft);
    advance(300_000); await scheduler.handleAlarm(SCHEDULE_ALARM);
    const records = await scheduler.list(); records[0]!.sessionId = "missing";
    await saveScheduledTasks(records); await scheduler.initialize();
    expect((await scheduler.list())[0]).toMatchObject({ enabled: false, sessionId: null });
    await scheduler.remove(task!.id); expect(await scheduler.list()).toEqual([]);
  });

  it("handles alarm API failure and disposal without dispatching disposed ticks", async () => {
    const { scheduler, alarms, advance, dispatch } = setup();
    alarms.create.mockImplementation(() => { throw new Error("unsupported"); });
    await scheduler.save(null, draft); expect(scheduler.available).toBe(false);
    advance(300_000); scheduler.dispose(); await scheduler.handleAlarm(SCHEDULE_ALARM);
    expect(dispatch).not.toHaveBeenCalled();
    const unavailable = new TaskScheduler({ now: Date.now, liveSessions: async () => [], dispatch });
    expect(unavailable.available).toBe(false); await unavailable.initialize();
  });
});
