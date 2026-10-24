import {
  isContentMessageResponse,
  isPageCaptureDoneRequest,
  isPageCapturePrepareRequest,
  isPageExecuteRequest,
  isPageFindRequest,
  isPageHealthRequest,
  isPageSearchResultsRequest,
  isPageShieldRequest,
  isPageSnapshotRequest,
} from "@/lib/protocol";
import type { ContentMessage, PageResponse } from "@/lib/protocol";
import {
  createElementRefRegistry,
  executeDomAction,
  extractSearchResults,
  extractSnapshot,
  findInPage,
  measureForCapture,
} from "@/lib/tools/page-executor";
import { createPageShield } from "@/lib/tools/page-shield";

/** The shield shows again on its own if the background never ends a capture. */
const CAPTURE_SHIELD_TIMEOUT_MS = 5_000;

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_idle",
  main() {
    // One ref registry per document lifetime; a navigation reloads this
    // content script and starts a fresh registry with a new document id.
    const registry = createElementRefRegistry();

    // The background owns the shield's state; a new document (or one restored
    // from the back/forward cache) asks for it, since a push may have missed it.
    let messageCount = 0;
    const tellBackground = (type: ContentMessage["type"]) => {
      const message: ContentMessage = { v: 1, id: `content-${++messageCount}`, type };
      browser.runtime.sendMessage(message).then((response: unknown) => {
        if (isContentMessageResponse(response)) shield.set(response.shield);
      }, () => {});
    };
    const shield = createPageShield(document, () => tellBackground("shield.takeover"));
    tellBackground("shield.sync");
    window.addEventListener("pageshow", (event) => { if (event.persisted) tellBackground("shield.sync"); });
    let captureTimer: ReturnType<typeof setTimeout> | undefined;
    const endCapture = () => {
      clearTimeout(captureTimer);
      shield.hideForCapture(false);
    };

    browser.runtime.onMessage.addListener((message: unknown): Promise<PageResponse> | undefined => {
      if (isPageHealthRequest(message)) {
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.health", url: location.href });
      }
      if (isPageSnapshotRequest(message)) {
        const snapshot = extractSnapshot(document, message.tabId, registry, { offset: message.offset, maxChars: message.maxChars });
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.snapshot", snapshot });
      }
      if (isPageFindRequest(message)) {
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.find", result: findInPage(document, registry, message.query) });
      }
      if (isPageSearchResultsRequest(message)) {
        const excerpt = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.search-results", results: extractSearchResults(document), url: location.href, excerpt });
      }
      if (isPageExecuteRequest(message)) {
        return executeDomAction(document, registry, message.action).then((result) => (
          { v: 1, id: message.id, ok: true, type: "page.execute", result, documentId: registry.documentId }
        ));
      }
      if (isPageCapturePrepareRequest(message)) {
        const measured = measureForCapture(document, registry, message.target);
        if (!measured.ok) {
          const { code, summary } = measured.result;
          return Promise.resolve({ v: 1, id: message.id, ok: false, error: { code: code === "STALE_SNAPSHOT" || code === "TARGET_MISSING" ? code : "NOT_INTERACTABLE", message: summary, retryable: false, phase: "page" } });
        }
        clearTimeout(captureTimer);
        shield.hideForCapture(true);
        captureTimer = setTimeout(endCapture, CAPTURE_SHIELD_TIMEOUT_MS);
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.capture-prepare", geometry: measured.geometry });
      }
      if (isPageCaptureDoneRequest(message)) {
        endCapture();
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.capture-done" });
      }
      if (isPageShieldRequest(message)) {
        shield.set(message.shield);
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.shield" });
      }
      return undefined;
    });
  },
});
