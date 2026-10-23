/**
 * The page shield: bside's hands-off layer over an agent tab the user is
 * watching, so a stray click or keypress does not change the page under a run.
 * A subtle tinted vignette, plus a banner pinned top-center saying bside is
 * using the tab, with a "Take over" button. The background decides the state
 * (`PageShieldState`); "Take over" is reported to it and held there for the
 * rest of the watch, never in page state.
 *
 * The shield lives in a closed shadow root on its own host element appended to
 * `<html>`, outside `<body>`: page CSS cannot restyle it (the host's own
 * inline styles are `!important`, and page styles do not cross the shadow
 * boundary), page scripts cannot read inside it, and `excludeFromOutline`
 * keeps it out of every snapshot, find, and change diff. Styles are set
 * through the CSSOM, which page CSPs do not restrict.
 *
 * Only trusted (user) input is blocked. The agent's effects are synthetic
 * events dispatched straight to their target element (see page-executor.ts),
 * so they pass through untouched, as do its focus() and scroll calls.
 */

import type { PageShieldState } from "@/lib/protocol";
import { excludeFromOutline } from "@/lib/tools/page-executor";

/** Pointer and editing input that could change the page, blocked while the shield is up. */
const POINTER_EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "touchstart", "touchend", "dragstart", "drop"];
const KEY_EVENTS = ["keydown", "keypress", "keyup"];
const EDIT_EVENTS = ["beforeinput", "paste", "cut"];
const BLOCKED_EVENTS = [...POINTER_EVENTS, ...KEY_EVENTS, ...EDIT_EVENTS];
/** On the shield's own layer these would start a text selection, a focus change, or a menu. */
const PREVENTED_ON_LAYER = new Set(["pointerdown", "mousedown", "touchstart", "contextmenu", "dragstart"]);

const NAVY = "#15204f";
const CREAM = "#fafcda";
/** The mascot's body color, as RGB channels. */
const PERIWINKLE = "107 130 219";

const LABELS: Record<Exclude<PageShieldState, "off">, string> = {
  working: "bside is working in this tab",
  idle: "This is bside's tab",
};

export interface PageShield {
  readonly state: PageShieldState;
  set(state: PageShieldState): void;
}

/**
 * Whether the shield blocks this event: user input (`isTrusted`) aimed at the
 * page rather than at the shield. Seen from outside the closed shadow root,
 * an event inside the shield has the host in its composed path.
 */
export function blocksPageInput(event: Pick<Event, "isTrusted" | "composedPath">, host: EventTarget): boolean {
  return event.isTrusted && !event.composedPath().includes(host);
}

function css(element: HTMLElement, properties: Record<string, string>, important = false): void {
  for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value, important ? "important" : "");
}

/** `onTakeOver` runs for a trusted click on "Take over"; the shield hides at once and the background confirms. */
export function createPageShield(document: Document, onTakeOver: () => void): PageShield {
  const view = document.defaultView;
  const host = document.createElement("bside-shield");
  excludeFromOutline(host);
  css(host, { all: "initial", display: "block", position: "fixed", inset: "0", "z-index": "2147483647", "pointer-events": "none", "user-select": "none" }, true);
  const root = host.attachShadow({ mode: "closed" });

  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  css(layer, {
    position: "fixed", inset: "0", "pointer-events": "auto", cursor: "default", background: "transparent",
    "box-shadow": `inset 0 0 0 3px rgb(${PERIWINKLE} / 0.7), inset 0 0 56px 6px rgb(${PERIWINKLE} / 0.22)`,
  });

  const banner = document.createElement("div");
  banner.setAttribute("role", "status");
  banner.title = "Your clicks and typing are paused here so they don't get in bside's way. Take over to use this tab yourself.";
  css(banner, {
    position: "fixed", top: "12px", left: "0", right: "0", margin: "0 auto", width: "max-content", "max-width": "calc(100vw - 24px)",
    display: "flex", "align-items": "center", gap: "10px", padding: "5px 5px 5px 12px", "box-sizing": "border-box",
    background: NAVY, color: CREAM, "border-radius": "999px", "pointer-events": "auto",
    "box-shadow": "0 4px 16px rgb(0 0 0 / 0.28), 0 0 0 1px rgb(250 252 218 / 0.12)",
    font: "500 13px/1.3 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", "letter-spacing": "normal", "white-space": "nowrap",
  });
  const dot = document.createElement("span");
  css(dot, { width: "8px", height: "8px", "border-radius": "50%", background: `rgb(${PERIWINKLE})`, "flex-shrink": "0" });
  const label = document.createElement("span");
  css(label, { overflow: "hidden", "text-overflow": "ellipsis" });
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Take over";
  css(button, {
    margin: "0", padding: "4px 12px", border: "0", "border-radius": "999px", background: CREAM, color: NAVY,
    font: "600 12px/1.3 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", cursor: "pointer", "flex-shrink": "0",
  });
  banner.append(dot, label, button);
  root.append(layer, banner);

  let state: PageShieldState = "off";
  let pulse: Animation | null = null;
  const reducedMotion = () => view?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  const nudge = () => {
    if (!reducedMotion()) banner.animate?.([{ transform: "scale(1)" }, { transform: "scale(1.06)" }, { transform: "scale(1)" }], { duration: 260, easing: "ease-out" });
  };

  // Nothing that happens inside the shield reaches the page's own listeners.
  for (const type of BLOCKED_EVENTS) {
    root.addEventListener(type, (event) => event.stopPropagation());
    layer.addEventListener(type, (event) => {
      if (PREVENTED_ON_LAYER.has(type)) event.preventDefault();
      if (type === "pointerdown") nudge();
    }, { passive: false });
  }
  button.addEventListener("click", (event) => {
    // A page script cannot reach this button, and a synthetic click never counts.
    if (!event.isTrusted) return;
    set("off");
    onTakeOver();
  });

  // User input aimed at the page some other way (a focused field, a top-layer
  // dialog drawn above every z-index) is stopped at the window. Shortcuts with
  // Ctrl/Cmd/Alt keep their browser action; any edit they would make is
  // stopped as beforeinput/paste/cut.
  const onWindowInput = (event: Event) => {
    if (!blocksPageInput(event, host)) return;
    event.stopImmediatePropagation();
    const keyboard = event as KeyboardEvent;
    const shortcut = KEY_EVENTS.includes(event.type) && (keyboard.ctrlKey || keyboard.metaKey || keyboard.altKey);
    if (!shortcut) event.preventDefault();
    if (event.type === "pointerdown") nudge();
  };

  // A page that removes the host while the shield is up gets it back.
  const keepAttached = new (view?.MutationObserver ?? MutationObserver)(() => {
    if (state !== "off" && !host.isConnected) document.documentElement?.append(host);
  });

  function set(next: PageShieldState): void {
    if (next !== "off") {
      label.textContent = LABELS[next];
      pulse?.cancel();
      pulse = next === "working" && !reducedMotion()
        ? dot.animate?.([{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }], { duration: 1600, iterations: Infinity }) ?? null
        : null;
    }
    if (next === state) return;
    const wasOff = state === "off";
    state = next;
    if (next === "off") {
      pulse?.cancel();
      pulse = null;
      keepAttached.disconnect();
      host.remove();
      for (const type of BLOCKED_EVENTS) view?.removeEventListener(type, onWindowInput, true);
      return;
    }
    if (!wasOff) return;
    document.documentElement?.append(host);
    keepAttached.observe(document, { childList: true, subtree: false });
    if (document.documentElement) keepAttached.observe(document.documentElement, { childList: true });
    for (const type of BLOCKED_EVENTS) view?.addEventListener(type, onWindowInput, { capture: true, passive: false });
  }

  return {
    get state() { return state; },
    set,
  };
}
