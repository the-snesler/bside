// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserProgram, ScratchFiles, WorkspaceState } from "@/lib/background/browser-program";
import { FrameAliases, TabController, type CaptureOptions, type TabControllerBrowserApi } from "@/lib/background/tab-controller";
import type { CaptureGeometry, PointerAction, PointerOutcome, ShotView, ViewportPoint } from "@/lib/domain/tools";
import type { PagePointerRequest, PageRequest } from "@/lib/protocol";
import { createElementRefRegistry, pointerAt, type CursorGesture, type ElementRefRegistry } from "@/lib/tools/page-executor";
import { createPageCursor, strokeRoute } from "@/lib/tools/page-cursor";
import { cursorMs } from "@/lib/domain/cursor";

const instant = async () => {};

/** One recorded event: its type, target id, and the fields coordinate actions set. */
interface Seen { type: string; on: string; x: number; y: number; buttons: number; button: number; pointerId?: number; pressure?: number; detail: number }

const TYPES = ["pointerover", "pointerenter", "pointermove", "pointerdown", "pointerup", "pointerout", "pointerleave", "mouseover", "mouseenter", "mousemove",
  "mousedown", "mouseup", "mouseout", "mouseleave", "click", "auxclick", "contextmenu", "dblclick"];

describe("pointerAt: effects at a point", () => {
  let registry: ElementRefRegistry;
  let view: ShotView;
  let seen: Seen[];
  let board: HTMLElement;
  let palette: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<canvas id="board" width="400" height="400"></canvas><div id="palette"></div><button id="go"><span id="go-label">Go</span></button>' +
      '<input id="name" aria-label="Name"><p id="status"></p>';
    window.scrollTo(0, 0);
    registry = createElementRefRegistry("doc-top");
    const root = document.documentElement;
    view = { documentId: "doc-top", scrollX: window.scrollX, scrollY: window.scrollY, width: root.clientWidth || window.innerWidth, height: root.clientHeight || window.innerHeight };
    board = document.getElementById("board")!;
    palette = document.getElementById("palette")!;
    // The board covers (0, 0)–(400, 400) and the palette (400, 0)–(450, 400); the button (500, 0)–(560, 30); the input (500, 100)–(700, 130).
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: (x: number, y: number) => {
        if (x < 400 && y < 400) return [board, document.body];
        if (x < 450 && y < 400) return [palette, document.body];
        if (x >= 500 && x < 560 && y < 30) return [document.getElementById("go-label")!, document.getElementById("go")!, document.body];
        if (x >= 500 && x < 700 && y >= 100 && y < 130) return [document.getElementById("name")!, document.body];
        return [document.body];
      },
    });
    seen = [];
    for (const element of [board, palette, document.getElementById("go")!, document.getElementById("name")!]) {
      for (const type of TYPES) {
        element.addEventListener(type, (event) => {
          if (event.target !== element && !(event.target as Element).closest?.(`#${element.id}`)) return;
          if (event.currentTarget !== element || (event.target !== element && element.id !== "go")) return;
          const mouse = event as PointerEvent;
          seen.push({ type, on: element.id, x: mouse.clientX, y: mouse.clientY, buttons: mouse.buttons, button: mouse.button, pointerId: mouse.pointerId, pressure: mouse.pressure, detail: mouse.detail });
        });
      }
    }
  });

  const act = (action: PointerAction, shot: ShotView | null = view) => pointerAt(document, registry, shot, action, instant, {});
  const types = (on?: string) => seen.filter((event) => !on || event.on === on).map((event) => event.type);
  const click = (points: ViewportPoint[], button: "left" | "middle" | "right" = "left", double = false): PointerAction => ({ kind: "click", points, button, double });

  it("clicks at the exact point: moves onto the element, then down, up, and click, as Firefox's mouse pointer", async () => {
    const result = await act(click([{ x: 120.5, y: 80 }]));
    expect(result).toMatchObject({ ok: true, outcome: { kind: "acted", documentId: "doc-top", result: { ok: true, summary: expect.stringMatching(/^Clicked canvas 0×0\./) } } });
    expect(types()).toEqual(["pointerover", "mouseover", "pointerenter", "mouseenter", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
    const down = seen.find((event) => event.type === "pointerdown")!;
    expect(down).toMatchObject({ x: 120.5, y: 80, buttons: 1, button: 0, pointerId: 0, pressure: 0.5, detail: 1 });
    expect(seen.find((event) => event.type === "pointerup")).toMatchObject({ x: 120.5, y: 80, buttons: 0, pressure: 0 });
    expect(seen.every((event) => event.x === 120.5 && event.y === 80)).toBe(true);
  });

  it("leaves out the mouse events a cancelled pointerdown suppresses, as a browser does, and still clicks", async () => {
    board.addEventListener("pointerdown", (event) => event.preventDefault());
    await act(click([{ x: 10, y: 10 }]));
    expect(types()).toEqual(["pointerover", "mouseover", "pointerenter", "mouseenter", "pointermove", "mousemove", "pointerdown", "pointerup", "click"]);
  });

  it("right-clicks with contextmenu and no click, middle-clicks with auxclick, and double-clicks with two clicks and dblclick", async () => {
    await act(click([{ x: 10, y: 10 }], "right"));
    expect(types().slice(-5)).toEqual(["pointerdown", "mousedown", "pointerup", "mouseup", "contextmenu"]);
    expect(seen.find((event) => event.type === "pointerdown")).toMatchObject({ button: 2, buttons: 2 });
    seen = [];
    await act(click([{ x: 10, y: 10 }], "middle"));
    expect(types().slice(-1)).toEqual(["auxclick"]);
    expect(seen.find((event) => event.type === "mousedown")).toMatchObject({ button: 1, buttons: 4 });
    seen = [];
    const result = await act(click([{ x: 10, y: 10 }], "left", true));
    expect(types().filter((type) => type === "click" || type === "dblclick")).toEqual(["click", "click", "dblclick"]);
    expect(seen.filter((event) => event.type === "click").map((event) => event.detail)).toEqual([1, 2]);
    expect(result.ok && result.outcome.kind === "acted" && result.outcome.result.summary).toMatch(/^Double-clicked /);
  });

  it("names the control a click landed in by its ref, and focuses it like a real mousedown", async () => {
    const result = await act(click([{ x: 510, y: 110 }]));
    expect(result.ok && result.outcome.kind === "acted" && result.outcome.result.summary).toMatch(/^Clicked \[e\d+ textbox "Name"\]\./);
    expect(document.activeElement?.id).toBe("name");
    const button = await act(click([{ x: 520, y: 10 }]));
    expect(button.ok && button.outcome.kind === "acted" && button.outcome.result.summary).toMatch(/^Clicked \[e\d+ button "Go"\]\./);
    expect(document.activeElement?.id).toBe("go");
  });

  it("clicks several points in turn, on what is at each one then, and reports the page's change", async () => {
    let painted = 0;
    board.addEventListener("click", () => { document.getElementById("status")!.textContent = `Painted ${++painted} cells`; });
    palette.addEventListener("click", () => { document.getElementById("status")!.textContent = `Picked a color after ${painted}`; });
    const result = await act(click([{ x: 10, y: 10 }, { x: 420, y: 10 }, { x: 30, y: 10 }]));
    expect(types().filter((type) => type === "click")).toEqual(["click", "click", "click"]);
    expect(seen.filter((event) => event.type === "click").map((event) => event.on)).toEqual(["board", "palette", "board"]);
    expect(result.ok && result.outcome.kind === "acted" && result.outcome.result.summary).toContain("Clicked 3 points, the first on canvas");
    expect(result.ok && result.outcome.kind === "acted" && result.outcome.result.summary).toContain("+ Painted 2 cells");
  });

  it("drags in small steps from the first point to the last, with the button held, to the element under each step", async () => {
    const result = await act({ kind: "drag", path: [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 420, y: 10 }] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const moves = seen.filter((event) => event.type === "pointermove" && event.buttons === 1);
    // 40 px then 370 px in steps of at most 4 px.
    expect(moves).toHaveLength(10 + 93);
    expect(moves.every((event) => event.pressure === 0.5 && event.pointerId === 0)).toBe(true);
    expect(moves.at(-1)).toMatchObject({ on: "palette", x: 420, y: 10 });
    expect(seen.find((event) => event.type === "pointerdown")).toMatchObject({ on: "board", x: 10, y: 10 });
    expect(seen.filter((event) => event.type === "pointerup")).toEqual([expect.objectContaining({ on: "palette", x: 420, y: 10, buttons: 0 })]);
    // The pointer crossed from the board onto the palette, and the button went up somewhere else: no click.
    expect(types("board")).toContain("pointerout");
    expect(types()).not.toContain("click");
    expect(result.ok && result.outcome.kind === "acted" && result.outcome.result.summary).toMatch(/^Dragged from canvas 0×0 through 3 points to div\./);
  });

  it("sends every move and the release to the element that captured the pointer, then clicks it", async () => {
    board.hasPointerCapture = (id: number) => id === 0;
    await act({ kind: "drag", path: [{ x: 10, y: 10 }, { x: 430, y: 10 }, { x: 900, y: 900 }] });
    expect(seen.filter((event) => event.type === "pointermove" && event.buttons === 1).every((event) => event.on === "board")).toBe(true);
    expect(types("palette")).toEqual([]);
    expect(seen.find((event) => event.type === "pointerup")).toMatchObject({ on: "board", x: 900, y: 900 });
    expect(types("board").at(-1)).toBe("click");
  });

  it("moves the pointer onto a point without pressing anything", async () => {
    const result = await act({ kind: "hover", at: { x: 420, y: 200 } });
    expect(types()).toEqual(["pointerover", "mouseover", "pointerenter", "mouseenter", "pointermove", "mousemove"]);
    expect(seen.every((event) => event.on === "palette" && event.x === 420 && event.y === 200 && event.buttons === 0)).toBe(true);
    expect(result.ok && result.outcome.kind === "acted" && result.outcome.result.summary).toMatch(/^Moved the pointer onto div\./);
  });

  it("refuses before any event: a stale view, a first point outside the viewport, a later click outside it, or clicks in different frames", async () => {
    expect(await act(click([{ x: 10, y: 10 }]), { ...view, scrollY: view.scrollY + 40 })).toMatchObject({ ok: false, result: { code: "STALE_SNAPSHOT" } });
    expect(await act({ kind: "drag", path: [{ x: -5, y: 10 }, { x: 10, y: 10 }] })).toMatchObject({ ok: false, result: { code: "NOT_INTERACTABLE", summary: expect.stringContaining("first point is outside") } });
    expect(await act(click([{ x: 10, y: 10 }, { x: 10, y: view.height + 5 }]))).toMatchObject({ ok: false, result: { summary: "Point 2 is outside the visible part of the page." } });
    const frame = document.createElement("iframe");
    frame.setAttribute("data-frame-id", "5");
    Object.defineProperties(frame, {
      contentDocument: { get: () => null }, clientWidth: { get: () => 100 }, clientHeight: { get: () => 100 },
      getBoundingClientRect: { value: () => ({ left: 800, top: 0, x: 800, y: 0, width: 100, height: 100, right: 900, bottom: 100 }) },
    });
    document.body.append(frame);
    const hit = document.elementsFromPoint.bind(document);
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: (x: number, y: number) => (x >= 800 && x < 900 && y < 100 ? [frame, document.body] : hit(x, y)) });
    const split = await pointerAt(document, registry, view, click([{ x: 10, y: 10 }, { x: 810, y: 10 }]), instant, { frameIdOf: (element) => Number(element.getAttribute("data-frame-id") ?? -1) });
    expect(split).toMatchObject({ ok: false, result: { summary: "Points 1 and 2 are in different frames; click each frame's points in a separate call." } });
    expect(seen).toEqual([]);
  });
});

describe("page.clickAt(), hoverAt(), dragAlong() in programs", () => {
  const VIEWPORT = { x: 0, y: 0, width: 1920, height: 1000 };

  function setup(answer: (request: PagePointerRequest) => PointerOutcome | "lost" = (request) => ({ kind: "acted", documentId: "doc-top", result: { ok: true, summary: `Did ${request.action.kind}.\nPage outline unchanged.` } })) {
    const pointers: PagePointerRequest[] = [];
    const sendMessage = vi.fn(async (_tabId: number, message: unknown, options: { frameId: number }) => {
      const request = message as PageRequest;
      if (request.type === "page.capture-prepare") {
        const geometry: CaptureGeometry = { documentId: "doc-top", url: "https://guestbook.example/", title: "Guestbook", viewport: VIEWPORT, page: { width: 1920, height: 1000 }, element: null };
        return { v: 1, id: request.id, ok: true, type: "page.capture-prepare", geometry };
      }
      if (request.type === "page.capture-done") return { v: 1, id: request.id, ok: true, type: "page.capture-done" };
      if (request.type === "page.pointer") {
        expect(options.frameId).toBe(0);
        pointers.push(request);
        const outcome = answer(request);
        if (outcome === "lost") throw new Error("Receiving end does not exist.");
        return { v: 1, id: request.id, ok: true, type: "page.pointer", outcome };
      }
      throw new Error(`unexpected ${request.type}`);
    });
    const api: TabControllerBrowserApi = { tabs: {
      query: vi.fn(async () => [{ id: 1, url: "https://guestbook.example/", title: "Guestbook" }]),
      update: vi.fn(async () => {}), goBack: vi.fn(async () => {}), sendMessage,
      captureTab: vi.fn(async (_tabId: number, _options: CaptureOptions) => `data:image/jpeg;base64,${"A".repeat(400)}`),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    } };
    const onEffect = vi.fn();
    const program = new BrowserProgram(new TabController(api, async () => false, new FrameAliases()), { state: new WorkspaceState(), runId: "r1", sessionId: "s1", files: new ScratchFiles(), maxImages: 4 }, onEffect);
    const signal = new AbortController().signal;
    const run = (source: string, readOnly = false) => program.execute(`const page = browser.tab("/tabs/1/page.md");\nawait page.screenshot();\n${source}`, signal, { readOnly: () => readOnly });
    return { run, pointers, onEffect };
  }

  // The 1920×1000 viewport is captured at 1600/1920, so a pixel is 1.2 CSS px.
  it("clicks pixels of a screenshot as viewport points, with the button and double-click options", async () => {
    const { run, pointers, onEffect } = setup();
    const result = await run('return await page.clickAt("s1", 100, 50);');
    expect(result.ok, result.summary).toBe(true);
    expect(result.summary).toContain("s1 (100, 50): Did click.");
    expect(pointers[0]!.action).toEqual({ kind: "click", points: [{ x: 120, y: 60 }], button: "left", double: false });
    expect(onEffect).toHaveBeenCalledTimes(1);
    await run('await page.clickAt("s1", 100, 50, {button: "right"}); await page.clickAt("s1", [[0, 0], [10, 20]], {double: true});');
    expect(pointers[1]!.action).toMatchObject({ button: "right", double: false });
    expect(pointers[2]!.action).toEqual({ kind: "click", points: [{ x: 0, y: 0 }, { x: 12, y: 24 }], button: "left", double: true });
  });

  it("drags along a path and hovers a point", async () => {
    const { run, pointers } = setup();
    const result = await run('await page.dragAlong("s1", [[10, 10], [20, 10], [20, 30]]); await page.hoverAt("s1", 5, 5);');
    expect(result.ok, result.summary).toBe(true);
    expect(result.summary).toContain("s1, 3 points from (10, 10): Did drag.");
    expect(pointers[0]!.action).toEqual({ kind: "drag", path: [{ x: 12, y: 12 }, { x: 24, y: 12 }, { x: 24, y: 36 }] });
    expect(pointers[1]!.action).toEqual({ kind: "hover", at: { x: 6, y: 6 } });
  });

  it("refuses clicks and drags in read-only mode before reaching the page, and still hovers and locates", async () => {
    const { run, pointers, onEffect } = setup();
    expect(await run('await page.clickAt("s1", 1, 1);', true)).toMatchObject({ ok: false, code: "ACTION_DENIED" });
    expect(await run('await page.dragAlong("s1", [[1, 1], [2, 2]]);', true)).toMatchObject({ ok: false, code: "ACTION_DENIED" });
    expect(pointers).toEqual([]);
    expect(onEffect).not.toHaveBeenCalled();
    expect((await run('await page.hoverAt("s1", 1, 1);', true)).ok).toBe(true);
  });

  it("fails the program with the page's refusal and keeps it from claiming the effect", async () => {
    const { run } = setup(() => ({ kind: "acted", documentId: "doc-top", result: { ok: false, code: "TARGET_MISSING", summary: "Clicked 1 point; nothing is at point 2 any more, so the rest were not clicked." } }));
    const result = await run('await page.clickAt("s1", [[1, 1], [2, 2]]);');
    expect(result).toMatchObject({ ok: false, code: "TARGET_MISSING" });
    expect(result.summary).toContain("nothing is at point 2 any more");
  });

  it("reports a drag whose page stopped answering as possibly done, never as done", async () => {
    const { run } = setup(() => "lost");
    const result = await run('await page.dragAlong("s1", [[1, 1], [2, 2]]);');
    expect(result).toMatchObject({ ok: false, code: "TAB_CHANGED" });
    expect(result.summary).toContain("may have taken effect");
  });

  it.each([
    ['page.dragAlong("s1", [[1, 1]])', "2–500 [x, y] pairs"],
    ['page.dragAlong("s1", [[1, 1], [2]])', "2–500 [x, y] pairs"],
    ['page.dragAlong("s1", [[1, 1], [2, 2000]])', "x 0–1600, y 0–833"],
    ['page.clickAt("s1", [])', "1–100 [x, y] pairs"],
    ['page.clickAt("s1", 1, 1, {button: "back"})', 'Use clickAt("s1", x, y'],
    ['page.clickAt("s1", 1, 1, {double: true, button: "right"})', "Only the left button double-clicks"],
    ['page.clickAt("s1", 1, 1, {force: true})', 'Use clickAt("s1", x, y'],
    ['page.hoverAt("s1", 1, 1, {})', 'Use hoverAt("s1", x, y)'],
    ['page.clickAt("s2", 1, 1)', "No screenshot s2"],
  ])("checks arguments before reaching the page: %s", async (call, message) => {
    const { run, pointers, onEffect } = setup();
    const result = await run(`await ${call};`);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain(message);
    expect(pointers).toEqual([]);
    expect(onEffect).not.toHaveBeenCalled();
  });
});

describe("the agent cursor at screenshot coordinates", () => {
  let registry: ElementRefRegistry;
  let view: ShotView;
  let board: HTMLElement;
  let clicks: { x: number; y: number }[];

  beforeEach(() => {
    document.body.innerHTML = '<canvas id="board" width="400" height="400"></canvas>';
    window.scrollTo(0, 0);
    registry = createElementRefRegistry("doc-top");
    const root = document.documentElement;
    view = { documentId: "doc-top", scrollX: window.scrollX, scrollY: window.scrollY, width: root.clientWidth || window.innerWidth, height: root.clientHeight || window.innerHeight };
    board = document.getElementById("board")!;
    Object.defineProperty(document, "elementsFromPoint", { configurable: true, value: () => [board, document.body] });
    clicks = [];
    board.addEventListener("click", (event) => clicks.push({ x: event.clientX, y: event.clientY }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.querySelectorAll("bside-cursor").forEach((host) => host.remove());
  });

  it("shows each click's exact point before that click, a hover's point, and a drag's whole path", async () => {
    const order: string[] = [];
    board.addEventListener("pointerdown", (event) => order.push(`down ${event.clientX},${event.clientY}`));
    const present = vi.fn(async (gesture: CursorGesture) => {
      order.push(`${gesture.kind} ${"at" in gesture ? `${gesture.at!.x},${gesture.at!.y}` : ""}`);
      return true;
    });
    const points = [{ x: 10, y: 20 }, { x: 30, y: 40 }];
    await pointerAt(document, registry, view, { kind: "click", points, button: "left", double: false }, instant, { present });
    expect(order).toEqual(["click 10,20", "down 10,20", "click 30,40", "down 30,40"]);
    expect(present.mock.calls.map(([gesture]) => gesture.element)).toEqual([board, board]);

    present.mockClear();
    await pointerAt(document, registry, view, { kind: "hover", at: { x: 5, y: 6 } }, instant, { present });
    expect(present.mock.calls[0]![0]).toEqual({ kind: "hover", element: board, at: { x: 5, y: 6 } });
    present.mockClear();
    const path = [{ x: 1, y: 1 }, { x: 50, y: 1 }, { x: 50, y: 50 }];
    await pointerAt(document, registry, view, { kind: "drag", path }, instant, { present });
    expect(present.mock.calls).toEqual([[{ kind: "stroke", element: board, path }]]);
  });

  it("stops a batch between clicks when the glide is stopped, and before anything when the first one is", async () => {
    let allowed = 1;
    const present = async () => allowed-- > 0;
    const batch = await pointerAt(document, registry, view, { kind: "click", points: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], button: "left", double: false }, instant, { present });
    expect(batch).toMatchObject({ ok: true, outcome: { kind: "acted", result: { ok: false, code: "SKIPPED", summary: "Stopped after clicking 1 of 3 points; the rest were not clicked." } } });
    expect(clicks).toEqual([{ x: 1, y: 1 }]);
    const none = await pointerAt(document, registry, view, { kind: "drag", path: [{ x: 1, y: 1 }, { x: 9, y: 9 }] }, instant, { present: async () => false });
    expect(none).toMatchObject({ ok: true, outcome: { result: { code: "SKIPPED", summary: "Stopped before acting; nothing was done on the page." } } });
    expect(clicks).toHaveLength(1);
  });

  it("goes exactly to a point without scrolling the page, even when the element's center is off-screen", async () => {
    vi.spyOn(board, "getBoundingClientRect").mockReturnValue({ left: 0, top: -3000, width: 400, height: 8000, right: 400, bottom: 5000, x: 0, y: -3000, toJSON: () => ({}) });
    const scroll = vi.fn();
    board.scrollIntoView = scroll;
    const cursor = createPageCursor(document);
    expect(await cursor.present({ kind: "click", element: board, at: { x: 120, y: 80 } }, 10, null)).toEqual({ stopped: false, at: { x: 120, y: 80 } });
    expect(await cursor.present({ kind: "stroke", element: board, path: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 90 }] }, 10, null)).toEqual({ stopped: false, at: { x: 60, y: 90 } });
    expect(scroll).not.toHaveBeenCalled();
  });

  it("samples a long stroke's route down, keeping its end", () => {
    const path = Array.from({ length: 200 }, (_, i) => ({ x: i, y: 0 }));
    const route = strokeRoute(path);
    expect(route).toHaveLength(24);
    expect(route.at(-1)).toEqual({ x: 199, y: 0 });
    expect(strokeRoute(path.slice(0, 5))).toEqual(path.slice(1, 5));
  });
});

describe("TabController.pointer: the cursor in a tab the user can see", () => {
  function setup(active: boolean, hold = false) {
    const requests: PagePointerRequest[] = [];
    const cancels: { executeId: string }[] = [];
    let release: (() => void) | null = null;
    const api: TabControllerBrowserApi = { tabs: {
      query: vi.fn(async (query: { active?: boolean }) => {
        const all = [{ id: 1, url: "https://guestbook.example/", title: "Guestbook", active }];
        return query.active ? all.filter((tab) => tab.active) : all;
      }),
      update: vi.fn(async () => {}), goBack: vi.fn(async () => {}),
      sendMessage: vi.fn(async (_tabId: number, message: unknown) => {
        const request = message as PageRequest;
        if (request.type === "page.execute-cancel") {
          cancels.push(request);
          release?.();
          return { v: 1, id: request.id, ok: true, type: "page.execute-cancel", cancelled: true };
        }
        if (request.type !== "page.pointer") throw new Error(`unexpected ${request.type}`);
        requests.push(request);
        if (hold) await new Promise<void>((resolve) => { release = resolve; });
        const result = cancels.length ? { ok: false, code: "SKIPPED" as const, summary: "Stopped before acting; nothing was done on the page." } : { ok: true, summary: "Clicked." };
        if (request.action.kind === "locate") return { v: 1, id: request.id, ok: true, type: "page.pointer", outcome: { kind: "hit", documentId: "doc", hit: { label: "canvas", box: { x: 0, y: 0, width: 1, height: 1 } } }, cursor: null };
        return { v: 1, id: request.id, ok: true, type: "page.pointer", outcome: { kind: "acted", documentId: "doc", result }, cursor: request.present ? { x: 70 + requests.length, y: 80 } : null };
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    } };
    return { api, requests, cancels };
  }
  const view: ShotView = { documentId: "doc", scrollX: 0, scrollY: 0, width: 1280, height: 800 };
  const click: PointerAction = { kind: "click", points: [{ x: 10, y: 10 }], button: "left", double: false };

  it("asks the top frame to show the cursor for effects, starting where the last one landed, never for a hit test", async () => {
    const { api, requests } = setup(true);
    const controller = await new TabController(api).forTab(1);
    await controller.pointer(view, click);
    await controller.pointer(view, { kind: "locate", at: { x: 1, y: 1 } });
    await controller.pointer(view, { kind: "hover", at: { x: 1, y: 1 } });
    expect(requests.map((request) => request.present)).toEqual([{ ms: cursorMs(0), from: null }, null, { ms: cursorMs(1), from: { x: 71, y: 80 } }]);
  });

  it("acts at once in a tab the user cannot see", async () => {
    const { api, requests } = setup(false);
    await (await new TabController(api).forTab(1)).pointer(view, click);
    expect(requests[0]!.present).toBeNull();
  });

  it("tells the page to stop when the run is cancelled during the glide", async () => {
    const { api, requests, cancels } = setup(true, true);
    const controller = await new TabController(api).forTab(1);
    const stop = new AbortController();
    const outcome = controller.pointer(view, click, stop.signal);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    stop.abort();
    expect(await outcome).toMatchObject({ ok: true, value: { kind: "acted", result: { code: "SKIPPED" } } });
    expect(cancels).toEqual([expect.objectContaining({ frameId: 0, tabId: 1, executeId: requests[0]!.id })]);
  });
});
