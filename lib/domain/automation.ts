import { isSessionId, validatePromptText } from "@/lib/validation";

export const MAX_SCHEDULED_TASKS = 50;
export const TASK_NAME_CHARS = 80;
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

export type TaskSchedule = { kind: "daily"; time: string } | { kind: "interval"; minutes: number };
export interface TaskDraft {
  name: string;
  prompt: string;
  url: string;
  enabled: boolean;
  schedule: TaskSchedule;
}
export type TaskRunStatus = "running" | "awaiting-approval" | "awaiting-help" | "completed" | "failed" | "cancelled" | "interrupted";
export interface ScheduledSource {
  taskId: string;
  name: string;
  scheduledAt: number;
  url: string;
}
export interface ScheduledTask extends TaskDraft {
  id: string;
  createdAt: number;
  updatedAt: number;
  sessionId: string | null;
  nextAt: number | null;
  unread: boolean;
  lastTick: { at: number; status: "started" | "skipped-busy" | "missed" | "unavailable" | "history-deleted" } | null;
  lastRun: { runId: string; startedAt: number; endedAt: number | null; status: TaskRunStatus } | null;
}
export interface ScheduledTasksV1 { version: 1; tasks: ScheduledTask[] }
export interface NotificationSettingsV1 { version: 1; enabled: boolean }

const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isTaskId = isSessionId;
const timestamp = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;
export function isTaskName(v: unknown): v is string {
  return typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= TASK_NAME_CHARS && !/[\r\n\x00-\x1f]/.test(v);
}
export function isTaskUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 2048 || v.trim() !== v) return false;
  try {
    const url = new URL(v);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch { return false; }
}
export function isTaskSchedule(v: unknown): v is TaskSchedule {
  if (!object(v) || Object.keys(v).length !== 2) return false;
  return (v.kind === "daily" && typeof v.time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v.time)) ||
    (v.kind === "interval" && Number.isInteger(v.minutes) && (v.minutes as number) >= MIN_INTERVAL_MINUTES && (v.minutes as number) <= MAX_INTERVAL_MINUTES);
}
export function isTaskDraft(v: unknown): v is TaskDraft {
  return object(v) && isTaskName(v.name) && typeof v.prompt === "string" && validatePromptText(v.prompt) === v.prompt &&
    isTaskUrl(v.url) && typeof v.enabled === "boolean" && isTaskSchedule(v.schedule);
}
export function isScheduledSource(v: unknown): v is ScheduledSource {
  return object(v) && isTaskId(v.taskId) && isTaskName(v.name) && timestamp(v.scheduledAt) && isTaskUrl(v.url);
}
export function isScheduledTask(v: unknown): v is ScheduledTask {
  if (!isTaskDraft(v)) return false;
  const t = v as unknown as Record<string, unknown>;
  if (!isTaskId(t.id) || typeof t.unread !== "boolean" || !timestamp(t.createdAt) || !timestamp(t.updatedAt) || (t.sessionId !== null && !isSessionId(t.sessionId)) ||
    (t.enabled ? !timestamp(t.nextAt) : t.nextAt !== null)) return false;
  if (t.lastTick !== null && (!object(t.lastTick) || !timestamp(t.lastTick.at) ||
    !["started", "skipped-busy", "missed", "unavailable", "history-deleted"].includes(t.lastTick.status as string))) return false;
  const r = t.lastRun;
  return r === null || (object(r) && isTaskId(r.runId) && timestamp(r.startedAt) && (r.endedAt === null || timestamp(r.endedAt)) &&
    ["running", "awaiting-approval", "awaiting-help", "completed", "failed", "cancelled", "interrupted"].includes(r.status as string));
}

/** Strictly future. A daily time follows the machine's local zone (including DST). */
export function nextTaskTime(schedule: TaskSchedule, now: number): number {
  if (schedule.kind === "interval") return now + schedule.minutes * 60_000;
  const [hour, minute] = schedule.time.split(":").map(Number) as [number, number];
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now) { next.setDate(next.getDate() + 1); next.setHours(hour, minute, 0, 0); }
  return next.getTime();
}

export function taskDraft(task: TaskDraft): TaskDraft {
  return { name: task.name, prompt: task.prompt, url: task.url, enabled: task.enabled, schedule: { ...task.schedule } };
}
