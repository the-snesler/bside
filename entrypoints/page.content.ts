import {
  isContentMessageResponse,
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
} from "@/lib/tools/page-executor";
import { createPageShield } from "@/lib/tools/page-shield";

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
      if (isPageShieldRequest(message)) {
        shield.set(message.shield);
        return Promise.resolve({ v: 1, id: message.id, ok: true, type: "page.shield" });
      }
      return undefined;
    });
  },
});
