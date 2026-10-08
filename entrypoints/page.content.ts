import {
  isPageExecuteRequest,
  isPageFindRequest,
  isPageHealthRequest,
  isPageSearchResultsRequest,
  isPageSnapshotRequest,
} from "@/lib/protocol";
import type { PageResponse } from "@/lib/protocol";
import {
  createElementRefRegistry,
  executeDomAction,
  extractSearchResults,
  extractSnapshot,
  findInPage,
} from "@/lib/tools/page-executor";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_idle",
  main() {
    // One ref registry per document lifetime; a navigation reloads this
    // content script and starts a fresh registry with a new document id.
    const registry = createElementRefRegistry();

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
      return undefined;
    });
  },
});
