import { getScheduledTasks, saveScheduledTasks } from "@/lib/storage";
import { isTaskDraft, isTaskId, MAX_SCHEDULED_TASKS, nextTaskTime, taskDraft, type ScheduledTask, type TaskDraft, type TaskRunStatus } from "@/lib/domain/automation";

export const SCHEDULE_ALARM = "bside:scheduled-tasks";
export interface SchedulerAlarms {
  create(name: string, info: { when: number }): Promise<void> | void;
  clear(name: string): Promise<unknown> | void;
}
export type TaskDispatch = { status: "started"; runId: string; sessionId: string } | { status: "skipped-busy" | "unavailable" };
export type RecordTaskStart = (sessionId: string, runId: string) => Promise<void>;
type DispatchTask = (task: ScheduledTask, scheduledAt: number, recordStart: RecordTaskStart) => Promise<TaskDispatch>;

/**
 * The alarm is only a wakeup. Versioned storage is authoritative. Mutations,
 * ticks, and completion writes share a lock; no run waits while holding it.
 * Busy ticks are skipped. Startup advances missed ticks without executing any.
 */
export class TaskScheduler {
  #alarms: SchedulerAlarms | null;
  #now: () => number;
  #dispatch: DispatchTask;
  #liveSessions: () => Promise<readonly string[]>;
  #ops: Promise<unknown> = Promise.resolve();
  #disposed = false;
  #available = true;

  constructor(options: { alarms?: SchedulerAlarms; now: () => number; dispatch: DispatchTask; liveSessions: () => Promise<readonly string[]> }) {
    this.#alarms = options.alarms ?? null;
    this.#now = options.now;
    this.#dispatch = options.dispatch;
    this.#liveSessions = options.liveSessions;
  }

  get available(): boolean { return this.#alarms !== null && this.#available && !this.#disposed; }

  #lock<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#ops.then(task);
    this.#ops = result.catch(() => {});
    return result;
  }

  async #arm(tasks: readonly ScheduledTask[]): Promise<void> {
    if (!this.#alarms || this.#disposed) return;
    try {
      await this.#alarms.clear(SCHEDULE_ALARM);
      const due = tasks.filter((t) => t.enabled && t.nextAt !== null).map((t) => t.nextAt!);
      if (due.length && !this.#disposed) await this.#alarms.create(SCHEDULE_ALARM, { when: Math.min(...due) });
      this.#available = true;
    } catch { this.#available = false; }
  }

  initialize(): Promise<void> {
    return this.#lock(async () => {
      const now = this.#now();
      const live = new Set(await this.#liveSessions());
      const tasks = await getScheduledTasks();
      for (const task of tasks) {
        if (task.lastRun?.endedAt === null) { task.lastRun = { ...task.lastRun, endedAt: now, status: "interrupted" }; task.unread = true; }
        if (task.sessionId && !live.has(task.sessionId)) this.#detach(task, now);
        if (task.enabled) {
          if (task.nextAt! <= now) task.lastTick = { at: now, status: "missed" };
          // Recompute daily times even after a timezone or DST change. Keep a
          // future interval deadline; a restart never starts a fresh countdown.
          if (task.schedule.kind === "daily" || task.nextAt! <= now) task.nextAt = nextTaskTime(task.schedule, now);
        }
      }
      await saveScheduledTasks(tasks);
      await this.#arm(tasks);
    });
  }

  list(): Promise<ScheduledTask[]> { return this.#lock(() => getScheduledTasks()); }

  save(id: string | null, draft: TaskDraft): Promise<ScheduledTask[]> {
    return this.#lock(async () => {
      if (!isTaskDraft(draft) || (id !== null && !isTaskId(id))) throw new Error("Invalid task. Check its name, prompt, HTTP(S) URL, and schedule.");
      const tasks = await getScheduledTasks();
      const previous = id ? tasks.find((t) => t.id === id) : undefined;
      if (id && !previous) throw new Error("That task no longer exists.");
      if (!previous && tasks.length >= MAX_SCHEDULED_TASKS) throw new Error(`Up to ${MAX_SCHEDULED_TASKS} tasks can be saved.`);
      const now = this.#now();
      const unchangedSchedule = previous?.enabled && draft.enabled && JSON.stringify(previous.schedule) === JSON.stringify(draft.schedule);
      const task: ScheduledTask = { ...taskDraft(draft), id: id ?? crypto.randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now,
        sessionId: previous?.sessionId ?? null, nextAt: draft.enabled ? (unchangedSchedule ? previous.nextAt : nextTaskTime(draft.schedule, now)) : null,
        unread: previous?.unread ?? false, lastTick: previous?.lastTick ?? null, lastRun: previous?.lastRun ?? null };
      const updated = previous ? tasks.map((t) => t.id === id ? task : t) : [...tasks, task];
      await saveScheduledTasks(updated);
      await this.#arm(updated);
      return updated;
    });
  }

  remove(id: string): Promise<ScheduledTask[]> {
    return this.#lock(async () => {
      const tasks = (await getScheduledTasks()).filter((t) => t.id !== id);
      await saveScheduledTasks(tasks);
      await this.#arm(tasks);
      return tasks;
    });
  }

  handleAlarm(name: string): Promise<void> {
    if (name !== SCHEDULE_ALARM || this.#disposed) return Promise.resolve();
    return this.#lock(async () => {
      const tasks = await getScheduledTasks();
      const now = this.#now();
      for (const task of tasks.toSorted((a, b) => (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity))) {
        if (this.#disposed || !task.enabled || task.nextAt === null || task.nextAt > now) continue;
        const scheduledAt = task.nextAt;
        task.nextAt = nextTaskTime(task.schedule, now);
        // Commit before dispatch. A crash at any later point skips this tick
        // rather than duplicating a potentially consequential run.
        task.lastTick = { at: now, status: "unavailable" };
        await saveScheduledTasks(tasks);
        let dispatched: TaskDispatch;
        try { dispatched = await this.#dispatch(structuredClone(task), scheduledAt, async (sessionId, runId) => {
          // Runtime calls this before starting provider/tab work. A restart can
          // always find the run's dedicated results session once work begins.
          task.sessionId = sessionId;
          task.lastRun = { runId, startedAt: now, endedAt: null, status: "running" };
          task.lastTick = { at: now, status: "started" };
          await saveScheduledTasks(tasks);
        }); }
        catch { dispatched = { status: "unavailable" }; }
        task.lastTick = { at: now, status: dispatched.status };
        if (dispatched.status === "started") {
          task.sessionId = dispatched.sessionId;
          task.lastRun = { runId: dispatched.runId, startedAt: now, endedAt: null, status: "running" };
        }
        await saveScheduledTasks(tasks);
      }
      await this.#arm(tasks);
    });
  }

  updateRun(taskId: string, runId: string, status: TaskRunStatus): Promise<void> {
    return this.#lock(async () => {
      const tasks = await getScheduledTasks();
      const task = tasks.find((t) => t.id === taskId && t.lastRun?.runId === runId);
      if (!task?.lastRun) return;
      const ended = ["completed", "failed", "cancelled", "interrupted"].includes(status);
      task.lastRun = { ...task.lastRun, status, endedAt: ended ? this.#now() : null };
      if (ended) task.unread = true;
      await saveScheduledTasks(tasks);
    });
  }

  #detach(task: ScheduledTask, at: number): void {
    task.sessionId = null;
    task.enabled = false;
    task.nextAt = null;
    task.lastRun = null;
    task.unread = false;
    task.lastTick = { at, status: "history-deleted" };
  }

  forgetSessions(ids: readonly string[]): Promise<void> {
    if (!ids.length) return Promise.resolve();
    return this.#lock(async () => {
      const tasks = await getScheduledTasks();
      for (const task of tasks) if (task.sessionId && ids.includes(task.sessionId)) this.#detach(task, this.#now());
      await saveScheduledTasks(tasks);
      await this.#arm(tasks);
    });
  }

  markRead(sessionId: string): Promise<void> {
    return this.#lock(async () => {
      const tasks = await getScheduledTasks();
      for (const task of tasks) if (task.sessionId === sessionId) task.unread = false;
      await saveScheduledTasks(tasks);
    });
  }

  dispose(): void {
    this.#disposed = true;
    void Promise.resolve().then(() => this.#alarms?.clear(SCHEDULE_ALARM)).catch(() => {});
  }
}
