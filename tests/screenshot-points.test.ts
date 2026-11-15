// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserProgram, ScratchFiles, WorkspaceState } from "@/lib/background/browser-program";
import { FrameAliases, TabController, type CaptureOptions, type TabControllerBrowserApi } from "@/lib/background/tab-controller";
import type { CaptureGeometry, PageRect, PointerOutcome, ShotView } from "@/lib/domain/tools";
import type { PagePointerRequest, PageRequest } from "@/lib/protocol";
import { createElementRefRegistry, excludeFromOutline, pointerAt, type ElementRefRegistry } from "@/lib/tools/page-executor";

/** Gives an element a layout box, which happy-dom does not compute. */
function place(element: Element, box: PageRect): void {
  element.getBoundingClientRect = () => ({ left: box.x, top: box.y, x: box.x, y: box.y, width: box.width, height: box.height, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => ({}) }) as DOMRect;
}

/** Makes a document or shadow root answer hit tests from a fixed stack per point ("x,y"), topmost first. */
function stackAt(root: Document | ShadowRoot, stacks: Record<string, Element[]>): void {
  Object.defineProperty(root, "elementsFromPoint", { configurable: true, value: (x: number, y: number) => stacks[`${x},${y}`] ?? [] });
}

describe("pointerAt: what is at a point of the top frame", () => {
  let registry: ElementRefRegistry;
  let view: ShotView;

  beforeEach(() => {
    document.body.innerHTML = '<button id="save"><span id="label">Save</span></button><canvas id="board" width="400" height="300"></canvas><p id="text">Leave a drawing</p>' +
      '<iframe id="pay" title="Payment" data-frame-id="5"></iframe><div id="host"></div>';
    window.scrollTo(0, 0);
    registry = createElementRefRegistry("doc-top");
    const root = document.documentElement;
    view = { documentId: "doc-top", scrollX: window.scrollX, scrollY: window.scrollY, width: root.clientWidth || window.innerWidth, height: root.clientHeight || window.innerHeight };
  });

  const at = (x: number, y: number, shot: ShotView | null = view) => pointerAt(document, registry, shot, { kind: "locate", at: { x, y } }, { frameIdOf: (frame) => Number(frame.getAttribute("data-frame-id") ?? -1) });
  const hit = (outcome: ReturnType<typeof at>): Extract<PointerOutcome, { kind: "hit" }> => {
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok || outcome.outcome.kind !== "hit") throw new Error("expected a hit");
    return outcome.outcome;
  };

  it("names the control an element is inside by its ref, with the element's box", () => {
    const label = document.getElementById("label")!;
    place(label, { x: 12, y: 8, width: 40, height: 16 });
    stackAt(document, { "20,10": [label, document.getElementById("save")!, document.body, document.documentElement] });
    const found = hit(at(20, 10));
    expect(found.hit).toEqual({ label: '[e1 button "Save"]', box: { x: 12, y: 8, width: 40, height: 16 } });
    expect(found.documentId).toBe("doc-top");
  });

  it("describes an element without a ref by its tag, a media element's size, and a little text", () => {
    const board = document.getElementById("board")!;
    place(board, { x: 100, y: 200, width: 400, height: 300 });
    const text = document.getElementById("text")!;
    stackAt(document, { "150,250": [board, document.body], "5,600": [text, document.body] });
    expect(hit(at(150, 250)).hit.label).toBe("canvas 400×300");
    expect(hit(at(5, 600)).hit.label).toBe('p "Leave a drawing"');
  });

  it("looks through bside's own page shield to the page under it", () => {
    const shield = document.createElement("div");
    document.documentElement.append(shield);
    excludeFromOutline(shield);
    const board = document.getElementById("board")!;
    stackAt(document, { "150,250": [shield, board, document.body] });
    expect(hit(at(150, 250)).hit.label).toMatch(/^canvas /);
  });

  it("descends into shadow roots", () => {
    const host = document.getElementById("host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<button>Inner</button>";
    const inner = shadow.querySelector("button")!;
    stackAt(document, { "30,700": [host, document.body] });
    stackAt(shadow, { "30,700": [inner, host, document.body] });
    expect(hit(at(30, 700)).hit.label).toMatch(/button "Inner"\]$/);
  });

  it("hands a point in a cross-origin frame back with the frame's id and content box", () => {
    const frame = document.getElementById("pay")!;
    place(frame, { x: 100, y: 400, width: 304, height: 204 });
    Object.defineProperties(frame, {
      contentDocument: { get: () => null },
      clientLeft: { get: () => 2 }, clientTop: { get: () => 2 }, clientWidth: { get: () => 300 }, clientHeight: { get: () => 200 },
    });
    stackAt(document, { "150,450": [frame, document.body] });
    expect(at(150, 450)).toEqual({ ok: true, outcome: { kind: "frame", frameId: 5, box: { x: 102, y: 402, width: 300, height: 200 } } });
  });

  it("refuses once the page is not what the screenshot showed: another document, another scroll position, another window size", () => {
    expect(at(10, 10, { ...view, documentId: "doc-old" })).toMatchObject({ ok: false, result: { code: "STALE_SNAPSHOT", summary: expect.stringContaining("loaded a new document") } });
    expect(at(10, 10, { ...view, scrollY: view.scrollY + 300 })).toMatchObject({ ok: false, result: { code: "STALE_SNAPSHOT", summary: expect.stringContaining("scrolled") } });
    expect(at(10, 10, { ...view, width: view.width + 200 })).toMatchObject({ ok: false, result: { code: "STALE_SNAPSHOT", summary: expect.stringContaining("resized") } });
    // Sub-pixel drift (fractional scrolling) still matches.
    stackAt(document, { "10,10": [document.body] });
    expect(at(10, 10, { ...view, scrollY: view.scrollY + 0.5 }).ok).toBe(true);
  });

  it("refuses a point outside the viewport, and says when nothing is there", () => {
    expect(at(-1, 10)).toMatchObject({ ok: false, result: { code: "NOT_INTERACTABLE" } });
    expect(at(10, view.height)).toMatchObject({ ok: false, result: { code: "NOT_INTERACTABLE" } });
    stackAt(document, {});
    expect(at(10, 10)).toMatchObject({ ok: false, result: { code: "TARGET_MISSING" } });
  });
});

describe("page.elementAt(): coordinates read off a screenshot", () => {
  const VIEWPORT: PageRect = { x: 0, y: 500, width: 1920, height: 1000 };

  /** One user tab whose top frame answers capture-prepare with `VIEWPORT` and pointer requests from `answers` (by frame id). */
  function setup(answers: Record<number, (request: PagePointerRequest) => PointerOutcome | { error: string; code: string }>) {
    const pointers: { frameId: number; request: PagePointerRequest }[] = [];
    const captures: CaptureOptions[] = [];
    const sendMessage = vi.fn(async (_tabId: number, message: unknown, options: { frameId: number }) => {
      const request = message as PageRequest;
      expect(request.frameId).toBe(options.frameId);
      if (request.type === "page.capture-prepare") {
        const geometry: CaptureGeometry = {
          documentId: "doc-top", url: "https://guestbook.example/", title: "Guestbook", viewport: VIEWPORT, page: { width: 1920, height: 4000 },
          element: request.target ? { x: 100, y: 700, width: 400, height: 400 } : null,
        };
        return { v: 1, id: request.id, ok: true, type: "page.capture-prepare", geometry };
      }
      if (request.type === "page.capture-done") return { v: 1, id: request.id, ok: true, type: "page.capture-done" };
      if (request.type === "page.snapshot") {
        const text = '[e1 canvas "Board"]';
        return { v: 1, id: request.id, ok: true, type: "page.snapshot", snapshot: { version: 2, tabId: 1, documentId: "doc-top", url: "https://guestbook.example/", title: "Guestbook", text, offset: 0, end: text.length, totalChars: text.length, selectionText: "" }, frames: 0 };
      }
      if (request.type === "page.pointer") {
        pointers.push({ frameId: options.frameId, request });
        const answer = answers[options.frameId]!(request);
        if ("error" in answer) return { v: 1, id: request.id, ok: false, error: { code: answer.code, message: answer.error, retryable: false, phase: "page" } };
        return { v: 1, id: request.id, ok: true, type: "page.pointer", outcome: answer };
      }
      throw new Error(`unexpected ${request.type}`);
    });
    const api: TabControllerBrowserApi = { tabs: {
      query: vi.fn(async () => [{ id: 1, url: "https://guestbook.example/", title: "Guestbook" }, { id: 2, url: "https://other.example/", title: "Other" }]),
      update: vi.fn(async () => {}), goBack: vi.fn(async () => {}), sendMessage,
      captureTab: vi.fn(async (_tabId: number, options: CaptureOptions) => { captures.push(options); return `data:image/jpeg;base64,${"A".repeat(400)}`; }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    } };
    const state = new WorkspaceState();
    const onEffect = vi.fn();
    const program = new BrowserProgram(new TabController(api, async () => false, new FrameAliases()), { state, runId: "r1", sessionId: "s1", files: new ScratchFiles(), maxImages: 6 }, onEffect);
    const signal = new AbortController().signal;
    const run = (source: string, readOnly = false) => program.execute(`const page = browser.tab("/tabs/1/page.md");\n${source}`, signal, { readOnly: () => readOnly });
    return { run, pointers, captures, state, program, onEffect };
  }

  const button = (request: PagePointerRequest): PointerOutcome => ({ kind: "hit", documentId: "doc-top", hit: { label: '[e3 button "Submit"]', box: { x: request.action.at.x - 60, y: request.action.at.y - 30, width: 120, height: 60 } } });

  it("gives viewport and element screenshots ids, and none to a full page", async () => {
    const { run } = setup({});
    const result = await run('await page.screenshot(); await page.screenshot({fullPage: true}); await page.snapshot(); await page.screenshot({ref: "e1"});');
    expect(result.ok, result.summary).toBe(true);
    const lines = result.summary.split("\n");
    expect(lines[0]).toContain("[screenshot 1600x833 of https://guestbook.example/] (image 1 of this result) [shot s1]");
    expect(lines[1]).not.toContain("[shot");
    expect(lines.at(-1)).toContain("[screenshot 400x400 of https://guestbook.example/] (image 3 of this result) [shot s2]");
  });

  it("maps a pixel of a scaled viewport screenshot to the viewport point it shows, and the element's box back into the image", async () => {
    const { run, pointers, onEffect, program } = setup({ 0: button });
    const result = await run('await page.screenshot(); return await page.elementAt("s1", 800, 400);');
    expect(result.ok, result.summary).toBe(true);
    // The 1920×1000 viewport was captured at 1600/1920: pixel (800, 400) is viewport point (960, 480).
    expect(pointers).toHaveLength(1);
    expect(pointers[0]!.request).toMatchObject({
      frameId: 0, refPrefix: "", action: { kind: "locate", at: { x: 960, y: 480 } },
      view: { documentId: "doc-top", scrollX: 0, scrollY: 500, width: 1920, height: 1000 },
    });
    expect(result.summary).toContain('s1 (800, 400): [e3 button "Submit"], box (750, 375)–(850, 425) in s1 pixels.');
    // A hit test reads the page but changes nothing.
    expect(onEffect).not.toHaveBeenCalled();
    expect(program.tainted).toBe(true);
  });

  it("maps a pixel of an element screenshot from the element's corner, and works in read-only mode", async () => {
    const { run, pointers } = setup({ 0: button });
    const result = await run('await page.snapshot(); await page.ref("e1").screenshot(); return await page.elementAt("s1", 10, 20);', true);
    expect(result.ok, result.summary).toBe(true);
    // The element starts at (100, 700) on the page, scrolled 500: (110, 720) on the page is (110, 220) in the viewport.
    expect(pointers[0]!.request.action).toEqual({ kind: "locate", at: { x: 110, y: 220 } });
  });

  it("follows a point into a cross-origin frame, naming the frame and moving the point into its viewport", async () => {
    const { run, pointers, state } = setup({
      0: () => ({ kind: "frame", frameId: 7, box: { x: 200, y: 100, width: 400, height: 300 } }),
      7: () => ({ kind: "hit", documentId: "doc-captcha", hit: { label: '[f1:e2 checkbox "Not a robot"]', box: { x: 10, y: 10, width: 24, height: 24 } } }),
    });
    const result = await run('await page.screenshot(); return await page.elementAt("s1", 250, 125);');
    expect(result.ok, result.summary).toBe(true);
    expect(pointers.map((call) => call.frameId)).toEqual([0, 7]);
    expect(pointers[1]!.request).toMatchObject({ refPrefix: "f1:", view: null, action: { at: { x: 100, y: 50 } } });
    // The checkbox at (10, 10) in the frame is (210, 110) in the viewport: (175, 92)–(195, 112) in the image.
    expect(result.summary).toContain('[f1:e2 checkbox "Not a robot"], box (175, 92)–(195, 112) in s1 pixels.');
    // Its refs now resolve against the frame's document.
    expect(state.observed.get(1)).toEqual({ documentId: "doc-top", frames: { f1: "doc-captcha" } });
  });

  it("passes on the page's refusal when it no longer shows what the screenshot showed", async () => {
    const { run } = setup({ 0: () => ({ code: "STALE_SNAPSHOT", error: "The page scrolled since that screenshot. Take a new screenshot and read the coordinates from it." }) });
    const result = await run('await page.screenshot(); return await page.elementAt("s1", 10, 10);');
    expect(result).toMatchObject({ ok: false, code: "STALE_SNAPSHOT" });
    expect(result.summary).toContain("scrolled since that screenshot");
  });

  it.each([
    ['page.elementAt("s1", 10, 10)', "No screenshot s1"],
    ['page.screenshot({fullPage: true}); await page.elementAt("s1", 10, 10)', "full-page screenshots have no id"],
    ['page.screenshot(); await page.elementAt("s1", 1601, 10)', "x 0–1600, y 0–833"],
    ['page.screenshot(); await page.elementAt("s1", -1, 10)', "x 0–1600"],
    ['page.screenshot(); await page.elementAt("s1", "10", 10)', "x 0–1600"],
    ['page.screenshot(); await page.elementAt("shot1", 10, 10)', 'screenshot id like "s1"'],
    ['page.screenshot(); await page.elementAt("s1", 10)', "takes 3 argument"],
    ['page.screenshot(); await browser.tab("/tabs/2/page.md").elementAt("s1", 10, 10)', "Screenshot s1 is of /tabs/1/page.md, not /tabs/2/page.md"],
  ])("refuses bad arguments before reaching the page: %s", async (call, message) => {
    const { run, pointers } = setup({});
    const result = await run(`await ${call};`);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain(message);
    expect(pointers).toEqual([]);
  });
});
