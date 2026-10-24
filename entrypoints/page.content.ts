import {
  isContentMessageResponse,
  isPageCaptureDoneRequest,
  isPageCapturePrepareRequest,
  isPageExecuteRequest,
  isPageFindRequest,
  isPageHealthRequest,
  isPageOutlineRequest,
  isPageSearchResultsRequest,
  isPageShieldRequest,
  isPageSnapshotRequest,
  isPageTableRequest,
} from "@/lib/protocol";
import type { ContentMessage, PageResponse } from "@/lib/protocol";
import {
  buildOutline,
  createElementRefRegistry,
  executeDomAction,
  extractFrameOutline,
  extractSearchResults,
  extractSnapshot,
  extractTable,
  findInPage,
  measureForCapture,
  measureFrameForCapture,
  settleDom,
} from "@/lib/tools/page-executor";
import { createPageShield } from "@/lib/tools/page-shield";

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
    let captureTimer: ReturnType<typeof setTimeout> | undefined;
    const endCapture = () => {
      clearTimeout(captureTimer);
      shield?.hideForCapture(false);
    };

    browser.runtime.onMessage.addListener((message: unknown): Promise<PageResponse> | undefined => {
      // Top-frame-only requests are validated to name frame 0, so a subframe never answers them.
      if ((message as { frameId?: unknown } | null)?.frameId !== ownFrameId) return undefined;
      if (isPageHealthRequest(message)) {
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.health", url: location.href });
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
        const excerpt = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.search-results", results: extractSearchResults(document), url: location.href, excerpt });
      }
      if (isPageExecuteRequest(message)) {
        return executeDomAction(document, registry, message.action, settleDom, { refPrefix: message.refPrefix, frameIdOf }).then((result) => (
          { v: 1, id: message.id, ok: true, type: "page.execute", result, documentId: registry.documentId }
        ));
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
        captureTimer = setTimeout(endCapture, CAPTURE_SHIELD_TIMEOUT_MS);
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.capture-prepare", geometry: measured.geometry });
      }
      if (isPageCaptureDoneRequest(message)) {
        endCapture();
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.capture-done" });
      }
      if (isPageShieldRequest(message) && shield) {
        shield.set(message.shield);
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.shield" });
      }
      return undefined;
    });
  },
});
