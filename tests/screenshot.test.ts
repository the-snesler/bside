import { describe, expect, it, vi } from "vitest";
import { FULL_PAGE_MAX_CSS, SCREENSHOT_MAX_BYTES, SCREENSHOT_MAX_DIMENSION, TabController, VisibilityLock } from "@/lib/background/tab-controller";
import type { CaptureOptions, TabControllerBrowserApi, TabSnapshot } from "@/lib/background/tab-controller";
import type { CaptureGeometry } from "@/lib/domain/tools";
import type { PageResponse } from "@/lib/protocol";

const GEOMETRY: CaptureGeometry = {
  documentId: "doc-1",
  url: "https://example.com/",
  title: "Example",
  viewport: { x: 0, y: 300, width: 1280, height: 800 },
  page: { width: 1280, height: 3000 },
  element: null,
};

/** A data URL whose base64 text decodes to `bytes` bytes. */
function jpeg(bytes = 3000): string {
  return `data:image/jpeg;base64,${"A".repeat(Math.ceil(bytes / 3) * 4)}`;
}

function setup(options: {
  geometry?: CaptureGeometry;
  prepareError?: PageResponse;
  hidden?: boolean;
  capture?: (tabId: number, options: CaptureOptions) => Promise<string>;
  isBlank?: (dataUrl: string) => Promise<boolean>;
} = {}) {
  const log: string[] = [];
  const tab: TabSnapshot = { id: 7, url: "https://example.com/", title: "Example", hidden: options.hidden ?? false };
  const api: TabControllerBrowserApi = {
    tabs: {
      query: vi.fn(async () => [tab]),
      update: vi.fn(async () => {}),
      goBack: vi.fn(async () => {}),
      show: vi.fn(async () => { log.push("show"); tab.hidden = false; }),
      hide: vi.fn(async (tabId: number) => { log.push("hide"); tab.hidden = true; return [tabId]; }),
      captureTab: vi.fn(async (tabId: number, captureOptions: CaptureOptions) => {
        log.push(`capture${tab.hidden ? " hidden" : ""}`);
        return options.capture ? options.capture(tabId, captureOptions) : jpeg();
      }),
      sendMessage: vi.fn(async (_tabId: number, message: unknown) => {
        const request = message as { id: string; type: string };
        log.push(request.type);
        if (request.type === "page.capture-prepare") {
          return options.prepareError ? { ...options.prepareError, id: request.id } : { v: 1, id: request.id, ok: true, type: "page.capture-prepare", geometry: options.geometry ?? GEOMETRY };
        }
        if (request.type === "page.capture-done") return { v: 1, id: request.id, ok: true, type: "page.capture-done" };
        throw new Error(`unexpected ${request.type}`);
      }),
      onUpdated: { addListener: () => {}, removeListener: () => {} },
    },
  };
  return { api, log, tab, controller: () => new TabController(api, options.isBlank ?? (async () => false)).forTab(7) };
}

const VIEWPORT = { area: "viewport", target: null, frame: 0, format: "jpeg" } as const;

describe("TabController.screenshot", () => {
  it("captures the scrolled viewport as a JPEG within the size bounds, ending the capture afterwards", async () => {
    const { api, log, controller } = setup();
    const outcome = await (await controller()).screenshot(VIEWPORT);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(api.tabs.captureTab).toHaveBeenCalledWith(7, { format: "jpeg", quality: 70, rect: { x: 0, y: 300, width: 1280, height: 800 }, scale: 1 });
    expect(outcome.value).toMatchObject({ mimeType: "image/jpeg", width: 1280, height: 800, url: "https://example.com/", documentId: "doc-1", cut: false });
    expect(outcome.value.data).not.toContain("data:");
    expect(outcome.value.bytes).toBe(3000);
    // The page (and its shield) is told the capture ended only after the image was taken.
    expect(log).toEqual(["page.capture-prepare", "capture", "page.capture-done"]);
  });

  it("renders a wide viewport at a smaller scale so its longest side fits", async () => {
    const { api, controller } = setup({ geometry: { ...GEOMETRY, viewport: { x: 0, y: 0, width: 3200, height: 1800 } } });
    const outcome = await (await controller()).screenshot(VIEWPORT);
    expect(api.tabs.captureTab).toHaveBeenCalledWith(7, expect.objectContaining({ scale: SCREENSHOT_MAX_DIMENSION / 3200 }));
    expect(outcome.ok && outcome.value).toMatchObject({ width: SCREENSHOT_MAX_DIMENSION, height: 900 });
  });

  it("renders small areas at 1 CSS pixel per image pixel", async () => {
    const { api, controller } = setup({ geometry: { ...GEOMETRY, element: { x: 10.5, y: 400.2, width: 200, height: 40 } } });
    const ref = { kind: "ref", ref: "e5", documentId: "doc-1" } as const;
    const outcome = await (await controller()).screenshot({ ...VIEWPORT, target: ref });
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ type: "page.capture-prepare", frameId: 0, target: ref }), { frameId: 0 });
    expect(api.tabs.captureTab).toHaveBeenCalledWith(7, expect.objectContaining({ rect: { x: 10, y: 400, width: 201, height: 41 }, scale: 1 }));
    expect(outcome.ok && outcome.value).toMatchObject({ width: 201, height: 41, cut: false });
  });

  it("cuts a full-page capture at the page cap and says so", async () => {
    const { api, controller } = setup({ geometry: { ...GEOMETRY, page: { width: 1280, height: 50_000 } } });
    const outcome = await (await controller()).screenshot({ ...VIEWPORT, area: "full" });
    const rect = { x: 0, y: 0, width: 1280, height: FULL_PAGE_MAX_CSS.height };
    expect(api.tabs.captureTab).toHaveBeenCalledWith(7, expect.objectContaining({ rect, scale: SCREENSHOT_MAX_DIMENSION / FULL_PAGE_MAX_CSS.height }));
    expect(outcome.ok && outcome.value).toMatchObject({ height: SCREENSHOT_MAX_DIMENSION, cut: true });
  });

  it("retakes an oversized image smaller, then refuses it with a clear error", async () => {
    const big = setup({ capture: async (_id, options) => jpeg(options.scale < 1 ? 5000 : SCREENSHOT_MAX_BYTES + 1) , geometry: { ...GEOMETRY, viewport: { x: 0, y: 0, width: 800, height: 600 } } });
    const retaken = await (await big.controller()).screenshot(VIEWPORT);
    expect(big.api.tabs.captureTab).toHaveBeenNthCalledWith(2, 7, expect.objectContaining({ scale: 0.7, quality: 55 }));
    expect(retaken.ok && retaken.value.bytes).toBe(5001);

    const huge = setup({ capture: async () => jpeg(SCREENSHOT_MAX_BYTES + 1) });
    const refused = await (await huge.controller()).screenshot(VIEWPORT);
    expect(refused).toMatchObject({ ok: false, error: { code: "LIMIT_EXCEEDED" } });
    expect(huge.api.tabs.captureTab).toHaveBeenCalledTimes(3);
    expect(huge.log.at(-1)).toBe("page.capture-done");
  });

  it("passes the page's stale-ref error through without capturing", async () => {
    const { api, log, controller } = setup({ prepareError: { v: 1, id: "", ok: false, error: { code: "STALE_SNAPSHOT", message: "Ref e5 came from an earlier page load.", retryable: false, phase: "page" } } });
    const outcome = await (await controller()).screenshot({ ...VIEWPORT, target: { kind: "ref", ref: "e5", documentId: "old" } });
    expect(outcome).toMatchObject({ ok: false, error: { code: "STALE_SNAPSHOT" } });
    expect(api.tabs.captureTab).not.toHaveBeenCalled();
    expect(log).toEqual(["page.capture-prepare"]);
  });

  it("captures a hidden tab directly when Firefox paints it", async () => {
    const { log, tab, controller } = setup({ hidden: true });
    expect((await (await controller()).screenshot(VIEWPORT)).ok).toBe(true);
    expect(log).toEqual(["page.capture-prepare", "capture hidden", "page.capture-done"]);
    expect(tab.hidden).toBe(true);
  });

  it("shows a hidden tab that captured blank, captures it, and hides it again", async () => {
    const { api, log, tab, controller } = setup({ hidden: true, isBlank: async () => tab.hidden === true });
    const outcome = await (await controller()).screenshot(VIEWPORT);
    expect(outcome.ok).toBe(true);
    expect(log).toEqual(["page.capture-prepare", "capture hidden", "show", "capture", "hide", "page.capture-done"]);
    expect(api.tabs.update).not.toHaveBeenCalled();
    expect(tab.hidden).toBe(true);
  });

  it("hides the tab again even when the fallback capture fails", async () => {
    const { log, tab, controller } = setup({ hidden: true, capture: async () => { throw new Error("no paint"); } });
    const outcome = await (await controller()).screenshot(VIEWPORT);
    expect(outcome).toMatchObject({ ok: false, error: { code: "TAB_CHANGED" } });
    expect(log).toEqual(["page.capture-prepare", "capture hidden", "show", "capture", "hide", "page.capture-done"]);
    expect(tab.hidden).toBe(true);
  });

  it("never shows a visible tab, even when its capture is blank", async () => {
    const { api, controller } = setup({ isBlank: async () => true });
    expect((await (await controller()).screenshot(VIEWPORT)).ok).toBe(true);
    expect(api.tabs.show).not.toHaveBeenCalled();
    expect(api.tabs.hide).not.toHaveBeenCalled();
  });

  it("rejects an unreadable capture", async () => {
    const { controller } = setup({ capture: async () => "data:text/html;base64,PGI+" });
    expect(await (await controller()).screenshot(VIEWPORT)).toMatchObject({ ok: false, error: { code: "TAB_CHANGED" } });
  });

  it("lets one run at a time show a hidden tab for a capture, across controllers sharing the visibility lock", async () => {
    const log: string[] = [];
    const tabs: TabSnapshot[] = [7, 8].map((id) => ({ id, url: `https://example.com/${id}`, title: "Example", hidden: true }));
    const shown = new Set<number>();
    let mostShown = 0;
    const api: TabControllerBrowserApi = {
      tabs: {
        query: vi.fn(async () => tabs),
        update: vi.fn(async () => {}),
        goBack: vi.fn(async () => {}),
        show: vi.fn(async (tabId: number) => {
          log.push(`show ${tabId}`);
          tabs.find((tab) => tab.id === tabId)!.hidden = false;
          shown.add(tabId);
          mostShown = Math.max(mostShown, shown.size);
        }),
        hide: vi.fn(async (tabId: number) => {
          log.push(`hide ${tabId}`);
          tabs.find((tab) => tab.id === tabId)!.hidden = true;
          shown.delete(tabId);
          return [tabId];
        }),
        // A hidden tab never paints; a shown one takes a moment.
        captureTab: vi.fn(async (tabId: number) => {
          if (tabs.find((tab) => tab.id === tabId)!.hidden) throw new Error("no paint");
          await new Promise((resolve) => setTimeout(resolve, 5));
          return jpeg();
        }),
        sendMessage: vi.fn(async (tabId: number, message: unknown) => {
          const request = message as { id: string; type: string };
          if (request.type === "page.capture-prepare") return { v: 1, id: request.id, ok: true, type: "page.capture-prepare", geometry: { ...GEOMETRY, url: `https://example.com/${tabId}` } };
          return { v: 1, id: request.id, ok: true, type: "page.capture-done" };
        }),
        onUpdated: { addListener: () => {}, removeListener: () => {} },
      },
    };
    const visibility = new VisibilityLock();
    const [a, b] = await Promise.all([7, 8].map((id) => new TabController(api, async () => false, undefined, undefined, visibility).forTab(id)));
    const outcomes = await Promise.all([a!.screenshot(VIEWPORT), b!.screenshot(VIEWPORT)]);
    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true]);
    expect(mostShown).toBe(1);
    expect(log).toEqual(["show 7", "hide 7", "show 8", "hide 8"]);
    expect(tabs.every((tab) => tab.hidden)).toBe(true);
  });
});
