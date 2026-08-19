import {
  isPageExecuteRequest,
  isPageHealthRequest,
  isPageSnapshotRequest,
} from "@/lib/protocol";
import type {
  PageExecuteRequest,
  PageHealthRequest,
  PageResponse,
  PageSnapshotRequest,
} from "@/lib/protocol";
import { createElementRefRegistry, executeDomCall, extractSnapshot } from "@/lib/tools/page-executor";
import type { ElementRefRegistry } from "@/lib/tools/page-executor";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_idle",
  main() {
    // One live ref registry per document lifetime; a navigation reloads this
    // content script and starts a fresh registry/revision.
    const registry = createElementRefRegistry();

    browser.runtime.onMessage.addListener((message: unknown): Promise<PageResponse> | undefined => {
      if (isPageHealthRequest(message)) {
        return Promise.resolve(handleHealth(message));
      }
      if (isPageSnapshotRequest(message)) {
        return Promise.resolve(handleSnapshot(message, registry));
      }
      if (isPageExecuteRequest(message)) {
        return handleExecute(message, registry);
      }
      return undefined;
    });
  },
});

function handleHealth(request: PageHealthRequest): PageResponse {
  return { v: 1, id: request.id, ok: true, type: "page.health", url: location.href };
}

function handleSnapshot(request: PageSnapshotRequest, registry: ElementRefRegistry): PageResponse {
  const snapshot = extractSnapshot(document, request.tabId, registry, request.mode);
  return { v: 1, id: request.id, ok: true, type: "page.snapshot", snapshot };
}

async function handleExecute(request: PageExecuteRequest, registry: ElementRefRegistry): Promise<PageResponse> {
  const result = executeDomCall(document, registry, request.call);
  if (result.ok) {
    // Let layout/frameworks settle before re-reading the DOM for a fresh
    // snapshot; never guess a stale target instead.
    await waitAnimationFrames(2);
  }
  const snapshot = extractSnapshot(document, request.tabId, registry, "interactive");
  return { v: 1, id: request.id, ok: true, type: "page.execute", result, snapshot };
}

function waitAnimationFrames(count: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  let remaining = count;
  const step = () => {
    remaining -= 1;
    if (remaining <= 0) resolve();
    else requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return promise;
}
