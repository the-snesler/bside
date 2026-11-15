/**
 * The agent's visible cursor: when bside acts in a tab the user can see, the
 * page shows a pointer gliding to each element before the action's events are
 * dispatched, so the user can follow (and stop) what is about to happen.
 *
 * The background decides whether to show it (only for a tab that is the
 * active tab in its window) and how long the glide takes. The pace starts slow
 * and decays with each action in a burst, so a long run is not slowed down
 * much; a pause resets it. The page scales the glide by distance and draws it.
 * The cursor is decoration only: it never dispatches input itself.
 */

import type { ToolResult } from "@/lib/domain/tools";

/** The result of an action that the run's cancellation stopped while its cursor was still on the way. */
export const STOPPED_BEFORE_ACTION: ToolResult = { ok: false, code: "SKIPPED", summary: "Stopped before acting; nothing was done on the page." };

/** A point in the top document's viewport, in CSS pixels. */
export interface CursorPoint {
  x: number;
  y: number;
}

/** How the page presents one action: the glide's base duration, and where the cursor was in the tab's previous document. */
export interface CursorPresentation {
  ms: number;
  from: CursorPoint | null;
}

export const CURSOR_PACING = {
  /** The first action's glide, for a long move. */
  baseMs: 650,
  /** No glide is shorter than this, however many actions came before. */
  floorMs: 120,
  /** Each action's glide is this fraction of the one before. */
  decay: 0.88,
  /** A gap this long between actions in a tab starts a new burst at the base pace. */
  idleResetMs: 20_000,
  /** A move this long (or longer) takes the whole duration; shorter moves take less, down to `nearShare`. */
  farPx: 800,
  nearShare: 0.55,
  /** Longest pause on the target before the action, after the glide. */
  maxDwellMs: 160,
  /** Most tabs whose pace is remembered at once. */
  maxTabs: 64,
} as const;

/** The glide's base duration for the `count`th action of a burst (0 first). */
export function cursorMs(count: number): number {
  const ms = CURSOR_PACING.baseMs * CURSOR_PACING.decay ** Math.max(0, count);
  return Math.max(CURSOR_PACING.floorMs, Math.round(ms));
}

/** The glide's duration for a move of `distance` pixels: shorter moves are quicker, never below the floor. */
export function glideMs(ms: number, distance: number): number {
  const reach = Math.min(1, Math.max(0, distance) / CURSOR_PACING.farPx);
  const scaled = ms * (CURSOR_PACING.nearShare + (1 - CURSOR_PACING.nearShare) * reach);
  return Math.max(Math.min(ms, CURSOR_PACING.floorMs), Math.round(scaled));
}

/** The pause on the target after the glide, so the user sees where it landed before the page reacts. */
export function dwellMs(ms: number): number {
  return Math.min(CURSOR_PACING.maxDwellMs, Math.round(ms * 0.25));
}

export function isCursorPoint(value: unknown): value is CursorPoint {
  if (typeof value !== "object" || value === null) return false;
  const { x, y } = value as Record<string, unknown>;
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) &&
    Math.abs(x) <= 1_000_000 && Math.abs(y) <= 1_000_000;
}

export function isCursorPresentation(value: unknown): value is CursorPresentation {
  if (typeof value !== "object" || value === null) return false;
  const { ms, from } = value as Record<string, unknown>;
  return Number.isSafeInteger(ms) && (ms as number) >= 0 && (ms as number) <= CURSOR_PACING.baseMs &&
    (from === null || isCursorPoint(from));
}

/**
 * Per-tab pacing, held by the background for its lifetime (in memory only).
 * `next` is asked once per action in a tab the user can see; a tab the user
 * cannot see gets no cursor and starts its next visible burst fresh.
 */
export class CursorPacer {
  #tabs = new Map<number, { count: number; lastAt: number; point: CursorPoint | null }>();

  constructor(readonly now: () => number = Date.now) {}

  /** The presentation for the next action in a visible tab. */
  next(tabId: number): CursorPresentation {
    const now = this.now();
    this.#prune(now);
    const state = this.#tabs.get(tabId);
    const count = state ? state.count : 0;
    this.#tabs.delete(tabId);
    this.#tabs.set(tabId, { count: count + 1, lastAt: now, point: state?.point ?? null });
    return { ms: cursorMs(count), from: state?.point ?? null };
  }

  /** Where the cursor ended after an action (null when the page did not report one, e.g. it navigated away). */
  landed(tabId: number, point: CursorPoint | null): void {
    const state = this.#tabs.get(tabId);
    if (state && point) state.point = point;
  }

  /** The tab is out of the user's sight: its next visible action starts a new burst. */
  forget(tabId: number): void {
    this.#tabs.delete(tabId);
  }

  #prune(now: number): void {
    for (const [tabId, state] of this.#tabs) {
      if (now - state.lastAt > CURSOR_PACING.idleResetMs) this.#tabs.delete(tabId);
    }
    while (this.#tabs.size >= CURSOR_PACING.maxTabs) this.#tabs.delete(this.#tabs.keys().next().value!);
  }
}
