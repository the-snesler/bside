import {
  isContentMessageResponse,
  isPageCaptureDoneRequest,
  isPageCapturePrepareRequest,
  isPageExecuteCancelRequest,
  isPageExecuteRequest,
  isPageFetchPdfRequest,
  isPageFindRequest,
  isPageHealthRequest,
  isPageOutlineRequest,
  isPageSearchResultsRequest,
  isPageShieldRequest,
  isPageSnapshotRequest,
  isPageTableRequest,
  isPageMenuTargetRequest,
} from "@/lib/protocol";
import type { ContentMessage, PageExecuteRequest, PageResponse } from "@/lib/protocol";
import type { CursorPoint } from "@/lib/domain/cursor";
import {
  buildOutline,
  createElementRefRegistry,
  executeDomAction,
  extractFrameOutline,
  extractSnapshot,
  extractTable,
  findInPage,
  measureForCapture,
  measureFrameForCapture,
  describeMenuTarget,
  settleDom,
} from "@/lib/tools/page-executor";
import { createPageCursor } from "@/lib/tools/page-cursor";
import { createPageShield } from "@/lib/tools/page-shield";
import { readSearchPage } from "@/lib/tools/search-results";
import { fetchPdf } from "@/lib/pdf/fetch";

/** The shield shows again on its own if the background never ends a capture. */
const CAPTURE_SHIELD_TIMEOUT_MS = 5_000;

/**
 * Firefox's id for a frame (a `WindowProxy`) or a frame element, as
 * `tabs.sendMessage` addresses it; -1 when unknown. `runtime.getFrameId` is
 * Firefox-only (96+) and missing from the shared WebExtension types.
 */
function frameIdOf(target: Window | Element): number {
  try {
    const getFrameId = (browser.runtime as unknown as { getFrameId?: (target: unknown) => number }).getFrameId;
    const id = getFrameId?.(target);
    return typeof id === "number" && Number.isSafeInteger(id) ? id : -1;
  } catch {
    return -1;
  }
}

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  // Every HTTP(S) frame gets its own instance so cross-origin frames can be
  // read and operated. about:blank and srcdoc frames are left out: they are
  // same-origin with their parent, whose instance walks them inline.
  allFrames: true,
  runAt: "document_idle",
  main() {
    const top = window === window.top;
    // Requests name the frame they are for; an instance answers only its own.
    // A subframe whose id Firefox does not report answers nothing.
    const ownFrameId = top ? 0 : frameIdOf(window);
    if (ownFrameId <= 0 && !top) return;

    // One ref registry per document lifetime; a navigation reloads this
    // content script and starts a fresh registry with a new document id.
    const registry = createElementRefRegistry();

    // Only the top frame has a shield. The background owns its state; a new
    // document (or one restored from the back/forward cache) asks for it,
    // since a push may have missed it. Subframes never message the background.
    let messageCount = 0;
    const tellBackground = (type: ContentMessage["type"]) => {
      const message: ContentMessage = { v: 1, id: `content-${++messageCount}`, type };
      browser.runtime.sendMessage(message).then((response: unknown) => {
        if (isContentMessageResponse(response)) shield?.set(response.shield);
      }, () => {});
    };
    const shield = top ? createPageShield(document, () => tellBackground("shield.takeover")) : null;
    if (shield) {
      tellBackground("shield.sync");
      window.addEventListener("pageshow", (event) => { if (event.persisted) tellBackground("shield.sync"); });
    }
    // Only the top frame draws the agent's cursor, over the whole tab; the
    // background asks for it only when the user can see the tab.
    const cursor = top ? createPageCursor(document) : null;
    /** Glides still on the way, by `page.execute` request id, so a cancelled run can stop its action. */
    const glides = new Map<string, AbortController>();
    const execute = async (message: PageExecuteRequest): Promise<PageResponse> => {
      let landed: CursorPoint | null = null;
      const stop = new AbortController();
      const present = cursor && message.present && document.visibilityState === "visible" ? message.present : null;
      if (present) glides.set(message.id, stop);
      try {
        const result = await executeDomAction(document, registry, message.action, settleDom, {
          refPrefix: message.refPrefix,
          frameIdOf,
          ...(present ? {
            present: async (gesture) => {
              const shown = await cursor!.present(gesture, present.ms, present.from, stop.signal);
              glides.delete(message.id);
              landed = shown.at;
              return !shown.stopped;
            },
          } : {}),
        });
        return { v: 1, id: message.id, ok: true, type: "page.execute", result, documentId: registry.documentId, cursor: landed };
      } finally {
        glides.delete(message.id);
      }
    };

    let captureTimer: ReturnType<typeof setTimeout> | undefined;
    const endCapture = () => {
      clearTimeout(captureTimer);
      shield?.hideForCapture(false);
      cursor?.hideForCapture(false);
    };

    browser.runtime.onMessage.addListener((message: unknown): Promise<PageResponse> | undefined => {
      // Top-frame-only requests are validated to name frame 0, so a subframe never answers them.
      if ((message as { frameId?: unknown } | null)?.frameId !== ownFrameId) return undefined;
      if (isPageHealthRequest(message)) {
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.health", url: location.href });
      }
      if (isPageMenuTargetRequest(message)) {
        const menus = Reflect.get(browser, "menus") as { getTargetElement(id: number): Element | undefined };
        let element: Element | undefined;
        try { element = menus.getTargetElement(message.targetElementId); } catch { /* Expired target. */ }
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.menu-target", alt: describeMenuTarget(element) });
      }
      // Cross-origin frames are listed with Firefox's frame id, so the background can read them through their own instance.
      if (isPageSnapshotRequest(message)) {
        const outline = buildOutline(document, registry, { frameIdOf });
        const snapshot = extractSnapshot(document, message.tabId, registry, { offset: message.offset, maxChars: message.maxChars }, outline);
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.snapshot", snapshot, frames: outline.frames.length });
      }
      if (isPageFindRequest(message)) {
        const outline = buildOutline(document, registry, { frameIdOf });
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.find", result: findInPage(document, registry, message.query, outline), frames: outline.frames.length });
      }
      if (isPageOutlineRequest(message)) {
        const outline = extractFrameOutline(document, registry, message.maxChars, { refPrefix: message.refPrefix, frameIdOf });
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.outline", outline });
      }
      if (isPageSearchResultsRequest(message)) {
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.search-results", page: readSearchPage(document, location.href) });
      }
      if (isPageExecuteRequest(message)) return execute(message);
      if (isPageExecuteCancelRequest(message)) {
        const glide = glides.get(message.executeId);
        glide?.abort();
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.execute-cancel", cancelled: glide !== undefined });
      }
      if (isPageTableRequest(message)) {
        const read = extractTable(document, registry, message.target, { offset: message.offset, limit: message.limit }, { refPrefix: message.refPrefix, frameIdOf });
        if (!read.ok) {
          const { code, summary } = read.result;
          return Promise.resolve({ v: 1, id: message.id, ok: false, error: { code: code === "STALE_SNAPSHOT" || code === "TARGET_MISSING" ? code : "NOT_INTERACTABLE", message: summary, retryable: false, phase: "page" } });
        }
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.table", table: read.table });
      }
      if (isPageCapturePrepareRequest(message)) {
        const measured = message.childFrameId !== null
          ? measureFrameForCapture(document, registry, message.childFrameId, frameIdOf)
          : measureForCapture(document, registry, message.target, { refPrefix: message.refPrefix, frameIdOf });
        if (!measured.ok) {
          const { code, summary } = measured.result;
          return Promise.resolve({ v: 1, id: message.id, ok: false, error: { code: code === "STALE_SNAPSHOT" || code === "TARGET_MISSING" ? code : "NOT_INTERACTABLE", message: summary, retryable: false, phase: "page" } });
        }
        clearTimeout(captureTimer);
        shield?.hideForCapture(true);
        cursor?.hideForCapture(true);
        captureTimer = setTimeout(endCapture, CAPTURE_SHIELD_TIMEOUT_MS);
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.capture-prepare", geometry: measured.geometry });
      }
      if (isPageCaptureDoneRequest(message)) {
        endCapture();
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.capture-done" });
      }
      if (isPageFetchPdfRequest(message)) {
        return fetchPdf(message.url, message.credentials).then((result) => ({ v: 1, id: message.id, ok: true, type: "page.fetch-pdf", result }));
      }
      if (isPageShieldRequest(message) && shield) {
        shield.set(message.shield);
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.shield" });
      }
      return undefined;
    });
  },
});
