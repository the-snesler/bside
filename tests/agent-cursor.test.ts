// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CURSOR_PACING, CursorPacer, cursorMs, glideMs } from "@/lib/domain/cursor";
import { buildOutline, createElementRefRegistry, executeDomAction, type CursorGesture } from "@/lib/tools/page-executor";
import { arcPoints, createPageCursor } from "@/lib/tools/page-cursor";
import { TabController, type TabControllerBrowserApi, type TabSnapshot } from "@/lib/background/tab-controller";
import type { DomAction } from "@/lib/domain/tools";
import type { PageExecuteRequest, PageResponse } from "@/lib/protocol";

const instant = async () => {};
const CLICK: DomAction = { kind: "click", target: { kind: "ref", ref: "e1", documentId: "doc" } };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.documentElement.querySelectorAll("bside-cursor").forEach((host) => host.remove());
});

describe("cursor pacing", () => {
  it("starts slow and decays to the floor over a burst", () => {
    expect(cursorMs(0)).toBe(CURSOR_PACING.baseMs);
    const paces = Array.from({ length: 30 }, (_, n) => cursorMs(n));
    for (let n = 1; n < paces.length; n++) expect(paces[n]).toBeLessThanOrEqual(paces[n - 1]!);
    expect(paces[10]).toBeLessThan(250);
    expect(paces.at(-1)).toBe(CURSOR_PACING.floorMs);
  });

  it("makes short moves quicker than long ones, never below the floor", () => {
    expect(glideMs(600, 2_000)).toBe(600);
    expect(glideMs(600, 0)).toBe(Math.round(600 * CURSOR_PACING.nearShare));
    expect(glideMs(600, 400)).toBeGreaterThan(glideMs(600, 100));
    expect(glideMs(CURSOR_PACING.floorMs, 0)).toBe(CURSOR_PACING.floorMs);
  });

  it("arcs from start to end", () => {
    const points = arcPoints({ x: 0, y: 0 }, { x: 400, y: 0 });
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points.at(-1)).toEqual({ x: 400, y: 0 });
    expect(Math.abs(points[4]!.y)).toBeGreaterThan(10);
  });

  it("counts a tab's burst, remembers where its cursor landed, and restarts after a pause or out of sight", () => {
    let now = 0;
    const pacer = new CursorPacer(() => now);
    expect(pacer.next(1)).toEqual({ ms: cursorMs(0), from: null });
    pacer.landed(1, { x: 10, y: 20 });
    now += 1_000;
    expect(pacer.next(1)).toEqual({ ms: cursorMs(1), from: { x: 10, y: 20 } });
    expect(pacer.next(2)).toEqual({ ms: cursorMs(0), from: null });
    now += CURSOR_PACING.idleResetMs + 1;
    expect(pacer.next(1)).toEqual({ ms: cursorMs(0), from: null });
    pacer.next(1);
    pacer.forget(1);
    expect(pacer.next(1).ms).toBe(cursorMs(0));
  });
});

describe("executeDomAction with a cursor", () => {
  function setup(html: string) {
    document.body.innerHTML = html;
    const registry = createElementRefRegistry("doc");
    buildOutline(document, registry);
    return registry;
  }

  it("shows the gesture before dispatching the action's events", async () => {
    const registry = setup(`<button id="go">Go</button>`);
    const log: string[] = [];
    document.getElementById("go")!.addEventListener("click", () => log.push("click"));
    const present = vi.fn(async (gesture: CursorGesture) => {
      log.push(`present:${gesture.kind}:${gesture.element.id}`);
      return true;
    });
    const result = await executeDomAction(document, registry, CLICK, instant, { present });
    expect(result.ok).toBe(true);
    expect(log).toEqual(["present:click:go", "click"]);
  });

  it("does nothing when the glide was stopped", async () => {
    const registry = setup(`<button id="go">Go</button>`);
    const clicked = vi.fn();
    document.getElementById("go")!.addEventListener("click", clicked);
    const result = await executeDomAction(document, registry, CLICK, instant, { present: async () => false });
    expect(result).toEqual({ ok: false, code: "SKIPPED", summary: "Stopped before acting; nothing was done on the page." });
    expect(clicked).not.toHaveBeenCalled();
  });

  it("types into fields, carries drags, and skips page scrolls", async () => {
    const registry = setup(`<input id="name" aria-label="Name"><div id="a" draggable="true">A</div><div id="b" role="button">B</div>`);
    const gestures: string[] = [];
    const present = async (gesture: CursorGesture) => {
      gestures.push(gesture.kind === "drag" ? `drag:${gesture.element.id}>${gesture.to.id}` : `${gesture.kind}:${gesture.element.id}`);
      return true;
    };
    const outline = buildOutline(document, registry);
    const refOf = (id: string) => outline.byElement.get(document.getElementById(id)!)!.ref;
    const target = (id: string) => ({ kind: "ref" as const, ref: refOf(id), documentId: "doc" });
    await executeDomAction(document, registry, { kind: "fill", target: target("name"), text: "Ada" }, instant, { present });
    await executeDomAction(document, registry, { kind: "drag", target: target("a"), to: target("b") }, instant, { present });
    await executeDomAction(document, registry, { kind: "scroll", target: null, direction: "down", amount: "page" }, instant, { present });
    expect(gestures).toEqual(["type:name", "drag:a>b"]);
  });
});

describe("the page cursor", () => {
  function button(): HTMLButtonElement {
    document.body.innerHTML = `<button id="go">Go</button>`;
    const element = document.getElementById("go") as HTMLButtonElement;
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ left: 100, top: 40, width: 60, height: 20, right: 160, bottom: 60, x: 100, y: 40, toJSON: () => ({}) });
    return element;
  }

  it("lands on the element's center in a host that takes no input and stays out of the outline", async () => {
    const element = button();
    const cursor = createPageCursor(document);
    const shown = await cursor.present({ kind: "click", element }, 10, null);
    expect(shown).toEqual({ stopped: false, at: { x: 130, y: 50 } });
    const host = document.querySelector("bside-cursor") as HTMLElement;
    expect(host).not.toBeNull();
    expect(host.style.getPropertyValue("pointer-events")).toBe("none");
    expect(buildOutline(document, createElementRefRegistry("doc")).lines.join("\n")).not.toContain("bside");
  });

  it("stops when its signal aborts", async () => {
    const element = button();
    const cursor = createPageCursor(document);
    const stop = new AbortController();
    const shown = cursor.present({ kind: "click", element }, 600, { x: 900, y: 700 }, stop.signal);
    stop.abort();
    expect(await shown).toEqual({ stopped: true, at: null });
  });

  it("goes on without pointing at an element that has no box", async () => {
    document.body.innerHTML = `<button id="go">Go</button>`;
    const cursor = createPageCursor(document);
    expect(await cursor.present({ kind: "click", element: document.getElementById("go")! }, 10, null)).toEqual({ stopped: false, at: null });
  });
});

describe("TabController: the cursor in a tab the user can see", () => {
  function setupTab(tab: Partial<TabSnapshot>) {
    const requests: PageExecuteRequest[] = [];
    const cancels: unknown[] = [];
    let release: (() => void) | null = null;
    const api: TabControllerBrowserApi = {
      tabs: {
        query: vi.fn(async (query: { active?: boolean }) => {
          const all = [{ id: 1, url: "https://example.com/", title: "Example", ...tab }, { id: 2, url: "https://example.org/", title: "Other", active: true }];
          return query.active ? all.filter((candidate) => candidate.active) : all;
        }),
        update: vi.fn(async () => {}),
        goBack: vi.fn(async () => {}),
        sendMessage: vi.fn(async (_tabId: number, message: unknown) => {
          const request = message as { id: string; type: string };
          if (request.type === "page.health") return { v: 1, id: request.id, ok: true, type: "page.health", url: "https://example.com/" } satisfies PageResponse;
          if (request.type === "page.execute-cancel") {
            cancels.push(request);
            release?.();
            return { v: 1, id: request.id, ok: true, type: "page.execute-cancel", cancelled: true } satisfies PageResponse;
          }
          if (request.type === "page.execute") {
            const execute = request as PageExecuteRequest;
            requests.push(execute);
            if ((globalThis as { holdGlide?: boolean }).holdGlide) await new Promise<void>((resolve) => { release = resolve; });
            const stopped = cancels.length > 0;
            return {
              v: 1, id: request.id, ok: true, type: "page.execute", documentId: "doc",
              result: stopped ? { ok: false, code: "SKIPPED", summary: "Stopped before acting; nothing was done on the page." } : { ok: true, summary: "Clicked." },
              cursor: execute.present ? { x: 30 + requests.length, y: 40 } : null,
            } satisfies PageResponse;
          }
          throw new Error(`unhandled ${request.type}`);
        }),
        onUpdated: { addListener: () => {}, removeListener: () => {} },
      },
    };
    return { api, requests, cancels };
  }

  afterEach(() => { delete (globalThis as { holdGlide?: boolean }).holdGlide; });

  it("asks the page to glide, decaying with each action and starting where the last one landed", async () => {
    const { api, requests } = setupTab({ active: true });
    const controller = await new TabController(api).forTab(1);
    await controller.act(CLICK);
    await controller.act(CLICK);
    expect(requests.map((request) => request.present)).toEqual([
      { ms: cursorMs(0), from: null },
      { ms: cursorMs(1), from: { x: 31, y: 40 } },
    ]);
  });

  it("acts at once in a tab the user cannot see, in frames, and for page scrolls", async () => {
    const hidden = setupTab({ active: false, hidden: true });
    const controller = await new TabController(hidden.api).forTab(1);
    await controller.act(CLICK);
    expect(hidden.requests[0]!.present).toBeNull();

    const visible = setupTab({ active: true });
    const shown = await new TabController(visible.api).forTab(1);
    await shown.act({ kind: "scroll", target: null, direction: "down", amount: "page" });
    await shown.act(CLICK, 3).catch(() => null);
    expect(visible.requests[0]!.present).toBeNull();
    // Frame f3 was never named by an outline, so nothing was sent for it.
    expect(visible.requests).toHaveLength(1);
  });

  it("tells the page to stop a glide when the run is cancelled", async () => {
    const { api, requests, cancels } = setupTab({ active: true });
    const controller = await new TabController(api).forTab(1);
    (globalThis as { holdGlide?: boolean }).holdGlide = true;
    const stop = new AbortController();
    const outcome = controller.act(CLICK, 0, stop.signal);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    stop.abort();
    expect((await outcome).result).toMatchObject({ ok: false, code: "SKIPPED" });
    expect(cancels).toEqual([expect.objectContaining({ type: "page.execute-cancel", frameId: 0, tabId: 1, executeId: requests[0]!.id })]);
  });

  it("acts at once and never cancels when no glide was asked for", async () => {
    const { api, cancels } = setupTab({ active: false });
    const controller = await new TabController(api).forTab(1);
    const stop = new AbortController();
    stop.abort();
    expect((await controller.act(CLICK, 0, stop.signal)).result.ok).toBe(true);
    expect(cancels).toHaveLength(0);
  });
});
