import { vi } from "vitest";
import type { TabControllerBrowserApi } from "@/lib/background/tab-controller";
import type { PageRequest, PageResponse } from "@/lib/protocol";
import {
  buildOutline,
  createElementRefRegistry,
  executeDomAction,
  extractFrameOutline,
  extractSnapshot,
  findInPage,
  measureForCapture,
  type ElementRefRegistry,
} from "@/lib/tools/page-executor";

export interface FakeFrameSpec {
  /** Firefox's frame id; 0 is the top frame. */
  frameId: number;
  url: string;
  /** Body HTML. `<iframe data-frame-id="5" data-src="https://…">` is a cross-origin frame with that id. */
  html: string;
  title?: string;
  /** No content script answers in this frame (sandboxed, still loading, or not a web page). */
  unreadable?: boolean;
}

export interface FakeFrame {
  spec: FakeFrameSpec;
  document: Document;
  registry: ElementRefRegistry;
}

/**
 * One tab whose frames are separate documents (the top frame is the test
 * window's document), each answered the way
 * `entrypoints/page.content.ts` answers in that frame, by the real page
 * executor. Requests must be addressed to one frame, in both the options and
 * the message, or the fake throws.
 */
export function createFramedTab(specs: FakeFrameSpec[], tabUrl = specs[0]!.url) {
  const frames = new Map<number, FakeFrame>();
  const load = (spec: FakeFrameSpec, documentId = `doc-${spec.frameId}`) => {
    // The top frame is the window's own document, so computed styles apply; subframes are windowless documents.
    const document = spec.frameId === 0 ? globalThis.document : globalThis.document.implementation.createHTMLDocument(spec.title ?? "");
    document.body.innerHTML = spec.html;
    for (const frame of Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe[data-src]"))) {
      Object.defineProperty(frame, "contentDocument", { get: () => null });
      Object.defineProperty(frame, "src", { get: () => frame.dataset.src });
    }
    frames.set(spec.frameId, { spec, document, registry: createElementRefRegistry(documentId) });
  };
  for (const spec of specs) load(spec);
  const frameIdOf = (element: Element) => Number(element.getAttribute("data-frame-id") ?? -1);
  const instant = async () => {};

  const respond = async (frame: FakeFrame, request: PageRequest): Promise<PageResponse> => {
    const { document, registry, spec } = frame;
    const base = { v: 1 as const, id: request.id, ok: true as const };
    switch (request.type) {
      case "page.health":
        return { ...base, type: "page.health", url: spec.url };
      case "page.snapshot": {
        const outline = buildOutline(document, registry, { frameIdOf });
        const snapshot = extractSnapshot(document, request.tabId, registry, request, outline);
        return { ...base, type: "page.snapshot", snapshot: { ...snapshot, url: spec.url, title: spec.title ?? "" }, frames: outline.frames.length };
      }
      case "page.find": {
        const outline = buildOutline(document, registry, { frameIdOf });
        return { ...base, type: "page.find", result: { ...findInPage(document, registry, request.query, outline), url: spec.url }, frames: outline.frames.length };
      }
      case "page.outline":
        return { ...base, type: "page.outline", outline: { ...extractFrameOutline(document, registry, request.maxChars, { refPrefix: request.refPrefix, frameIdOf }), url: spec.url, title: spec.title ?? "" } };
      case "page.execute": {
        const result = await executeDomAction(document, registry, request.action, instant, { refPrefix: request.refPrefix, frameIdOf });
        return { ...base, type: "page.execute", result, documentId: registry.documentId };
      }
      case "page.capture-prepare": {
        const measured = measureForCapture(document, registry, request.target, { refPrefix: request.refPrefix, frameIdOf });
        if (!measured.ok) return { v: 1, id: request.id, ok: false, error: { code: "TARGET_MISSING", message: measured.result.summary, retryable: false, phase: "page" } };
        return { ...base, type: "page.capture-prepare", geometry: { ...measured.geometry, url: spec.url } };
      }
      case "page.capture-done":
        return { ...base, type: "page.capture-done" };
      default:
        throw new Error(`unhandled fake request type: ${request.type}`);
    }
  };

  const sendMessage = vi.fn(async (_tabId: number, message: unknown, options: { frameId: number }) => {
    const request = message as PageRequest;
    if (options?.frameId !== request.frameId) throw new Error(`request for frame ${request.frameId} sent to frame ${options?.frameId}`);
    const frame = frames.get(options.frameId);
    if (!frame || frame.spec.unreadable) throw new Error("Could not establish connection. Receiving end does not exist.");
    return respond(frame, request);
  });

  const api: TabControllerBrowserApi = { tabs: {
    query: vi.fn(async () => [{ id: 1, url: tabUrl, title: specs[0]!.title ?? "" }]),
    update: vi.fn(async () => {}),
    goBack: vi.fn(async () => {}),
    sendMessage,
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
  } };

  /** Loads a new document into a frame, as a navigation would: a fresh registry with a new document id. */
  const navigateFrame = (spec: FakeFrameSpec, documentId: string) => load(spec, documentId);
  /** Removes a frame, as if its iframe element were taken out of the page. */
  const removeFrame = (frameId: number) => frames.delete(frameId);
  /** Requests sent to one frame, in order. */
  const requestsTo = (frameId: number) => sendMessage.mock.calls.filter((call) => call[2]?.frameId === frameId).map((call) => call[1] as PageRequest);

  return { api, frames, sendMessage, navigateFrame, removeFrame, requestsTo };
}
