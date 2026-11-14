/**
 * The agent's visible cursor (see `lib/domain/cursor.ts`): an arrow with a
 * small "bside" tag that glides to each element bside is about to act on, so
 * the user watching the tab can follow along. It is decoration only, with
 * `pointer-events: none`: it never receives or dispatches input. The action's
 * own events are dispatched by page-executor.ts after the glide.
 *
 * Like the page shield, it lives in a closed shadow root on its own host
 * appended to `<html>`, styled through the CSSOM with `!important` host
 * styles, excluded from outlines, and hidden while a screenshot is taken.
 * It fades out once bside stops acting for a moment.
 */

import { dwellMs, glideMs, type CursorPoint } from "@/lib/domain/cursor";
import { excludeFromOutline, type CursorGesture } from "@/lib/tools/page-executor";

const NAVY = "#15204f";
const CREAM = "#fafcda";
/** The mascot's body color, as RGB channels. */
const PERIWINKLE = "107 130 219";
const SVG = "http://www.w3.org/2000/svg";
/** The arrow's tip, from the cursor element's top-left corner. */
const TIP = { x: 3, y: 2 };
/** The cursor fades out this long after its last gesture. */
const IDLE_FADE_MS = 2_500;

export interface CursorPresented {
  stopped: boolean;
  at: CursorPoint | null;
}

export interface PageCursor {
  /**
   * Glides to the gesture's element (scrolled into view if it is not) and
   * plays it, taking about `ms` (scaled by distance) plus a short dwell.
   * `from` is where the cursor was in the tab's previous document, used when
   * this document has not shown it yet. Resolves with where it ended (null
   * if the element has no box to point at), and `stopped` if `signal` aborted
   * first, in which case the action must not run.
   */
  present(gesture: CursorGesture, ms: number, from: CursorPoint | null, signal?: AbortSignal): Promise<CursorPresented>;
  /** Hides the cursor from view while bside takes a screenshot. */
  hideForCapture(hidden: boolean): void;
}

function css(element: HTMLElement | SVGElement, properties: Record<string, string>, important = false): void {
  for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value, important ? "important" : "");
}

/**
 * The center of an element's box in the top document's viewport, adding the
 * offsets of the same-origin frames it is in; null when it has no box.
 */
export function viewportCenter(element: Element, top: Window | null): CursorPoint | null {
  const box = viewportBox(element, top);
  return box && { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

function viewportBox(element: Element, top: Window | null): { left: number; top: number; width: number; height: number } | null {
  const box = element.getBoundingClientRect();
  if (!box.width && !box.height) return null;
  let left = box.left;
  let y = box.top;
  let view = element.ownerDocument.defaultView;
  while (view && view !== top && view.frameElement) {
    const frame = view.frameElement;
    const outer = frame.getBoundingClientRect();
    left += outer.left + frame.clientLeft;
    y += outer.top + frame.clientTop;
    view = frame.ownerDocument.defaultView;
  }
  return { left, top: y, width: box.width, height: box.height };
}

function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (finished: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve(finished);
    };
    const stop = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** Points along a gentle arc from `a` to `b` (a quadratic curve bowing to one side), so the glide reads as a hand moving, not a slide. */
export function arcPoints(a: CursorPoint, b: CursorPoint, steps = 8): CursorPoint[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  const bow = Math.min(60, distance * 0.12);
  const control = distance ? { x: (a.x + b.x) / 2 - (dy / distance) * bow, y: (a.y + b.y) / 2 + (dx / distance) * bow } : a;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    return {
      x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * control.x + t ** 2 * b.x,
      y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * control.y + t ** 2 * b.y,
    };
  });
}

export function createPageCursor(document: Document): PageCursor {
  const view = document.defaultView;
  const host = document.createElement("bside-cursor");
  excludeFromOutline(host);
  css(host, { all: "initial", display: "block", position: "fixed", inset: "0", "z-index": "2147483647", "pointer-events": "none", "user-select": "none", overflow: "hidden" }, true);
  host.setAttribute("aria-hidden", "true");
  const root = host.attachShadow({ mode: "closed" });

  // The ring drawn around a field being typed in.
  const ring = document.createElement("div");
  css(ring, {
    position: "fixed", left: "0", top: "0", width: "0", height: "0", "box-sizing": "border-box", "border-radius": "6px",
    border: `2px solid rgb(${PERIWINKLE})`, "box-shadow": `0 0 0 4px rgb(${PERIWINKLE} / 0.22)`, opacity: "0",
    transition: "opacity 160ms ease-out",
  });

  // The cursor: an arrow, then a small name tag, translated so the arrow's tip sits on the point.
  const cursor = document.createElement("div");
  css(cursor, { position: "fixed", left: "0", top: "0", display: "flex", "align-items": "flex-start", opacity: "0", transition: "opacity 180ms ease-out", "will-change": "transform" });
  const arrow = document.createElementNS(SVG, "svg");
  arrow.setAttribute("width", "20");
  arrow.setAttribute("height", "22");
  arrow.setAttribute("viewBox", "0 0 20 22");
  css(arrow, { display: "block", overflow: "visible", filter: "drop-shadow(0 1px 2px rgb(0 0 0 / 0.35))", "transform-origin": `${TIP.x}px ${TIP.y}px`, transition: "transform 90ms ease-out" });
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", "M3 2 L3 18 L7.5 14 L10.5 20.5 L13.5 19.2 L10.6 12.8 L16.5 12.6 Z");
  path.setAttribute("fill", NAVY);
  path.setAttribute("stroke", CREAM);
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linejoin", "round");
  arrow.append(path);
  const tag = document.createElement("span");
  tag.textContent = "bside";
  css(tag, {
    margin: "14px 0 0 -2px", padding: "1px 7px", "border-radius": "999px", background: `rgb(${PERIWINKLE})`, color: CREAM,
    font: "600 11px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", "letter-spacing": "normal", "white-space": "nowrap",
    "box-shadow": "0 1px 3px rgb(0 0 0 / 0.3)",
  });
  cursor.append(arrow, tag);
  root.append(ring, cursor);

  let point: CursorPoint | null = null;
  let glide: Animation | null = null;
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  const reducedMotion = () => view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  // A page that removes the host while the cursor is showing gets it back.
  const keepAttached = new (view?.MutationObserver ?? MutationObserver)(() => {
    if (!host.isConnected) document.documentElement?.append(host);
  });
  const attach = () => {
    if (host.isConnected) return;
    document.documentElement?.append(host);
    keepAttached.observe(document, { childList: true });
    if (document.documentElement) keepAttached.observe(document.documentElement, { childList: true });
  };
  const fadeLater = () => {
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
      css(cursor, { opacity: "0" });
      css(ring, { opacity: "0" });
      fadeTimer = setTimeout(() => { keepAttached.disconnect(); host.remove(); }, 400);
    }, IDLE_FADE_MS);
  };
  const place = (at: CursorPoint) => {
    css(cursor, { transform: `translate(${at.x - TIP.x}px, ${at.y - TIP.y}px)` });
  };

  /** Moves to `to`, gliding along an arc unless motion is reduced (then it jumps and waits the same time). */
  async function moveTo(to: CursorPoint, ms: number, signal?: AbortSignal): Promise<boolean> {
    const from = point ?? to;
    const duration = glideMs(ms, Math.hypot(to.x - from.x, to.y - from.y));
    glide?.cancel();
    point = to;
    if (reducedMotion() || typeof cursor.animate !== "function" || from === to) {
      place(to);
      return sleep(duration, signal);
    }
    const frames = arcPoints(from, to).map((at) => ({ transform: `translate(${at.x - TIP.x}px, ${at.y - TIP.y}px)` }));
    place(to);
    const animation = cursor.animate(frames, { duration, easing: "cubic-bezier(0.3, 0, 0.2, 1)" });
    glide = animation;
    const finished = await Promise.race([
      animation.finished.then(() => true, () => false),
      sleep(duration + 100, signal).then((done) => done),
    ]);
    if (glide === animation) glide = null;
    if (!finished || signal?.aborted) {
      animation.cancel();
      return false;
    }
    return true;
  }

  function ripple(at: CursorPoint): void {
    if (reducedMotion()) return;
    arrow.animate?.([{ transform: "scale(1)" }, { transform: "scale(0.82)" }, { transform: "scale(1)" }], { duration: 220, easing: "ease-out" });
    const wave = document.createElement("div");
    css(wave, {
      position: "fixed", left: `${at.x - 14}px`, top: `${at.y - 14}px`, width: "28px", height: "28px", "border-radius": "50%",
      border: `2px solid rgb(${PERIWINKLE})`, "box-sizing": "border-box",
    });
    root.append(wave);
    const animation = wave.animate?.([{ transform: "scale(0.3)", opacity: 0.9 }, { transform: "scale(1.4)", opacity: 0 }], { duration: 420, easing: "ease-out" });
    if (animation) animation.finished.then(() => wave.remove(), () => wave.remove());
    else wave.remove();
  }

  function surround(element: Element): void {
    const box = viewportBox(element, view);
    if (!box) return;
    css(ring, { left: `${box.left - 3}px`, top: `${box.top - 3}px`, width: `${box.width + 6}px`, height: `${box.height + 6}px`, opacity: "1" });
  }

  /** Brings the element into view if it is off-screen, so the cursor can land on it. */
  function reveal(element: Element): CursorPoint | null {
    const at = viewportCenter(element, view);
    const width = view?.innerWidth ?? 0;
    const height = view?.innerHeight ?? 0;
    if (at && at.x >= 0 && at.y >= 0 && at.x <= width && at.y <= height) return at;
    try { (element as HTMLElement).scrollIntoView?.({ block: "center", inline: "nearest" }); } catch { /* detached or unsupported */ }
    return viewportCenter(element, view);
  }

  async function present(gesture: CursorGesture, ms: number, from: CursorPoint | null, signal?: AbortSignal): Promise<CursorPresented> {
    const stopped = { stopped: true, at: null };
    if (signal?.aborted) return stopped;
    clearTimeout(fadeTimer);
    const target = reveal(gesture.element);
    if (!target) return { stopped: false, at: null };
    attach();
    css(ring, { opacity: "0" });
    if (cursor.style.opacity !== "1") {
      // First showing in this document: start where it was in the last one, or just off the target.
      point = point ?? from ?? { x: target.x + 48, y: target.y + 64 };
      place(point);
      css(cursor, { opacity: "1" });
    }
    try {
      if (!await moveTo(target, ms, signal)) return stopped;
      if (gesture.kind === "click") ripple(target);
      if (gesture.kind === "type") surround(gesture.element);
      if (gesture.kind === "drag") {
        arrow.style.setProperty("transform", "scale(0.85)");
        const end = viewportCenter(gesture.to, view);
        if (end && !await moveTo(end, ms, signal)) return stopped;
        arrow.style.removeProperty("transform");
        if (end) ripple(end);
      }
      if (!await sleep(dwellMs(ms), signal)) return stopped;
      return { stopped: false, at: point };
    } finally {
      if (signal?.aborted) arrow.style.removeProperty("transform");
      fadeLater();
    }
  }

  function hideForCapture(hidden: boolean): void {
    css(host, { visibility: hidden ? "hidden" : "visible" }, true);
    if (hidden) view?.getComputedStyle(host).visibility;
  }

  return { present, hideForCapture };
}
