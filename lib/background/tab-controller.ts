/**
 * Binds a controller to a single HTTP(S) tab and mediates every page request
 * against it: snapshots, find, and DOM actions are forwarded to the content
 * script, while navigate/go_back are driven directly through the tabs API with
 * a fixed settle/probe sequence. The bound tab never changes once captured; a
 * newly opened tab is never implicitly adopted. forTab creates a separate
 * controller for an explicitly selected workspace tab.
 */

import type {
  NormalizedError,
  PageExecuteRequest,
  PageFindRequest,
  PageHealthRequest,
  PageResponse,
  PageSearchResultsRequest,
  PageSnapshotRequest,
} from "@/lib/protocol";
import type { DomAction, PageArtifactSummary, PageErrorCode, PageFindResult, PageSnapshot, SearchResult, ToolResult } from "@/lib/domain/tools";
import { validateHttpUrl } from "@/lib/validation";

const NAVIGATION_TIMEOUT_MS = 10_000;
const PROBE_DELAYS_MS = [100, 200, 400, 800, 1_600, 3_200];
const UNSUPPORTED_HOSTNAME_SUFFIXES = [".mozilla.org", ".mozilla.com"];
export const DEFAULT_SNAPSHOT_CHARS = 16_000;
export const ARTIFACT_SNAPSHOT_CHARS = 8_000;

type TabSnapshot = { id?: number; url?: string; title?: string; hidden?: boolean };
type TabUpdatedListener = (tabId: number, changeInfo: { status?: string }, tab: TabSnapshot) => void;

export interface TabControllerBrowserApi {
  tabs: {
    query(query: { active?: boolean; lastFocusedWindow?: boolean }): Promise<TabSnapshot[]>;
    create?(properties: { url: string; active: boolean }): Promise<TabSnapshot>;
    hide?(tabId: number): Promise<number[]>;
    show?(tabId: number): Promise<void>;
    remove?(tabId: number): Promise<void>;
    update(tabId: number, updateProperties: { url: string } | { active: true }): Promise<unknown>;
    goBack(tabId: number): Promise<void>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
    onUpdated: {
      addListener(callback: TabUpdatedListener): void;
      removeListener(callback: TabUpdatedListener): void;
    };
  };
}

export type PageOutcome<T> = { ok: true; value: T } | { ok: false; error: NormalizedError };
/** A DOM action's result plus the document it ran in (null when the page navigated away). */
export type ActionOutcome = { result: ToolResult; documentId: string | null };

export class TabController {
  #browserApi: TabControllerBrowserApi;
  #tabId: number | null = null;
  #url: string | null = null;
  #title: string | null = null;

  constructor(browserApi: TabControllerBrowserApi) {
    this.#browserApi = browserApi;
  }

  get tabId(): number | null {
    return this.#tabId;
  }

  async listTabs(): Promise<TabSnapshot[]> {
    return (await this.allTabs()).filter((tab) => isSupportedUrl(tab.url));
  }

  /** Every tab, including unsupported pages, so an agent tab on such a page is not mistaken for a closed one. */
  async allTabs(): Promise<TabSnapshot[]> {
    return (await this.#browserApi.tabs.query({})).filter((tab) => tab.id !== undefined);
  }

  async forTab(tabId: number): Promise<TabController> {
    const tab = (await this.listTabs()).find((tab) => tab.id === tabId);
    if (!tab) throw new Error("Tab is closed or unsupported.");
    const controller = new TabController(this.#browserApi);
    controller.#tabId = tabId;
    controller.#url = tab.url!;
    controller.#title = tab.title ?? "";
    return controller;
  }

  async createTab(url: string): Promise<number> {
    if (!validateHttpUrl(url) || !isSupportedUrl(url)) throw new Error("Expected a supported HTTP(S) URL.");
    if (!this.#browserApi.tabs.create) throw new Error("Tab creation is unavailable.");
    const tab = await this.#browserApi.tabs.create({ url, active: false });
    if (tab.id === undefined) throw new Error("Tab creation failed.");
    return tab.id;
  }

  async hideTab(tabId: number): Promise<void> {
    if (!this.#browserApi.tabs.hide || !(await this.#browserApi.tabs.hide(tabId)).includes(tabId)) {
      throw new Error("Firefox could not hide this tab (active or pinned tabs cannot be hidden).");
    }
  }

  async showTab(tabId: number): Promise<void> {
    if (!this.#browserApi.tabs.show) throw new Error("Showing tabs is unavailable.");
    await this.#browserApi.tabs.show(tabId);
  }

  async focusTab(tabId: number): Promise<void> {
    const tab = (await this.listTabs()).find((tab) => tab.id === tabId);
    if (!tab || tab.hidden) return;
    await this.#browserApi.tabs.update(tabId, { active: true });
  }

  async closeTab(tabId: number): Promise<void> {
    if (!this.#browserApi.tabs.remove) throw new Error("Closing tabs is unavailable.");
    await this.#browserApi.tabs.remove(tabId);
  }

  async waitUntilReady(tabId: number, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
    for (const delay of [0, ...PROBE_DELAYS_MS]) {
      signal.throwIfAborted();
      if (delay) await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, delay);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      signal.throwIfAborted();
      if (await this.#probeHealth(tabId)) return;
      if (Date.now() >= deadline) break;
    }
    throw new Error(`Tab ${tabId} opened but its page is not ready; list tabs and retry reading it. Do not open a duplicate.`);
  }

  currentAttachment(): PageArtifactSummary | null {
    if (this.#tabId === null || this.#url === null) return null;
    return {
      artifactId: `page:${this.#tabId}:${this.#url}`,
      kind: "page",
      title: this.#title ?? "",
      url: this.#url,
      capturedAt: Date.now(),
    };
  }

  /** Binds this controller to the active HTTP(S) tab and captures the head of its outline. */
  async captureActivePage(): Promise<PageOutcome<{ artifact: PageArtifactSummary; snapshot: PageSnapshot }>> {
    const tabs = await this.#browserApi.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (!tab || tab.id === undefined || !isSupportedUrl(tab.url)) {
      return pageError("UNSUPPORTED_PAGE", "This page cannot be attached.");
    }

    const outcome = await this.#request<PageSnapshot>(tab.id, { type: "page.snapshot", tabId: tab.id, offset: 0, maxChars: ARTIFACT_SNAPSHOT_CHARS }, "page.snapshot");
    if (!outcome.ok) return outcome;

    this.#tabId = tab.id;
    this.#url = outcome.value.url;
    this.#title = outcome.value.title;

    const artifact: PageArtifactSummary = {
      artifactId: `page:${tab.id}:${outcome.value.documentId}`,
      kind: "page",
      title: outcome.value.title,
      url: outcome.value.url,
      capturedAt: Date.now(),
    };
    return { ok: true, value: { artifact, snapshot: outcome.value } };
  }

  async snapshot(options: { offset: number; maxChars: number } = { offset: 0, maxChars: DEFAULT_SNAPSHOT_CHARS }): Promise<PageOutcome<PageSnapshot>> {
    if (this.#tabId === null) return pageError("UNSUPPORTED_PAGE", "No page is attached.");
    return this.#request<PageSnapshot>(this.#tabId, { type: "page.snapshot", tabId: this.#tabId, ...options }, "page.snapshot");
  }

  async find(query: string): Promise<PageOutcome<PageFindResult>> {
    if (this.#tabId === null) return pageError("UNSUPPORTED_PAGE", "No page is attached.");
    return this.#request<PageFindResult>(this.#tabId, { type: "page.find", tabId: this.#tabId, query }, "page.find");
  }

  async searchResults(): Promise<PageOutcome<{ results: SearchResult[]; url: string; excerpt: string }>> {
    if (this.#tabId === null) return pageError("UNSUPPORTED_PAGE", "No page is attached.");
    return this.#request(this.#tabId, { type: "page.search-results", tabId: this.#tabId }, "page.search-results");
  }

  /** Forwards one DOM action. A click/press that tears down the document settles like a navigation instead of repeating. */
  async act(action: DomAction): Promise<ActionOutcome> {
    const tabId = this.#tabId;
    if (tabId === null) return { result: { ok: false, code: "UNSUPPORTED_PAGE", summary: "No page is attached." }, documentId: null };
    const request: PageExecuteRequest = { v: 1, id: crypto.randomUUID(), type: "page.execute", tabId, action };

    let response: PageResponse | undefined;
    try {
      response = (await this.#browserApi.tabs.sendMessage(tabId, request)) as PageResponse | undefined;
    } catch {
      if (action.kind !== "click" && action.kind !== "press") {
        return { result: { ok: false, code: "TAB_CHANGED", summary: "Lost contact with the page." }, documentId: null };
      }
      const settled = await this.#settleNavigation(tabId);
      if (!settled.ok) {
        return { result: { ok: false, code: "NAVIGATION_INTERRUPTED", summary: "The page did not settle after the action." }, documentId: null };
      }
      await this.#refreshMetadata(settled.value.url);
      return {
        result: { ok: true, summary: `${action.kind === "click" ? "Clicked" : `Pressed ${action.key}`}; the page navigated to ${this.#url} (${JSON.stringify(this.#title ?? "")}). Earlier refs are invalid; read a snapshot or use page.find().` },
        documentId: null,
      };
    }

    if (!response) return { result: { ok: false, code: "TAB_CHANGED", summary: "The page did not respond." }, documentId: null };
    if (!response.ok) return { result: { ok: false, code: toToolResultCode(response.error.code), summary: response.error.message }, documentId: null };
    if (response.type !== "page.execute") return { result: { ok: false, code: "TARGET_MISSING", summary: "Unexpected response from the page." }, documentId: null };
    return { result: response.result, documentId: response.documentId };
  }

  async navigate(url: string): Promise<ToolResult> {
    if (this.#tabId === null) return { ok: false, code: "UNSUPPORTED_PAGE", summary: "No page is attached." };
    if (!validateHttpUrl(url) || !isSupportedUrl(url)) return { ok: false, code: "INVALID_TOOL_ARGUMENTS", summary: "Expected a supported absolute HTTP(S) URL." };
    await this.#browserApi.tabs.update(this.#tabId, { url });
    return this.#afterNavigation("Navigated");
  }

  async goBack(): Promise<ToolResult> {
    if (this.#tabId === null) return { ok: false, code: "UNSUPPORTED_PAGE", summary: "No page is attached." };
    await this.#browserApi.tabs.goBack(this.#tabId);
    return this.#afterNavigation("Went back");
  }

  async #afterNavigation(verb: string): Promise<ToolResult> {
    const tabId = this.#tabId!;
    const settled = await this.#settleNavigation(tabId);
    if (!settled.ok) return { ok: false, code: "NAVIGATION_INTERRUPTED", summary: "Navigation did not complete in time." };
    await this.#refreshMetadata(settled.value.url);
    return { ok: true, summary: `${verb} to ${this.#url} (${JSON.stringify(this.#title ?? "")}). Read it with page.snapshot() or page.find(text).` };
  }

  async #refreshMetadata(url: string): Promise<void> {
    const tab = (await this.#browserApi.tabs.query({})).find((candidate) => candidate.id === this.#tabId);
    this.#url = url;
    this.#title = tab?.title ?? this.#title;
  }

  async #request<T>(
    tabId: number,
    body: Omit<PageSnapshotRequest, "v" | "id"> | Omit<PageFindRequest, "v" | "id"> | Omit<PageSearchResultsRequest, "v" | "id">,
    type: "page.snapshot" | "page.find" | "page.search-results",
  ): Promise<PageOutcome<T>> {
    const request = { v: 1, id: crypto.randomUUID(), ...body };
    let response: PageResponse | undefined;
    try {
      response = (await this.#browserApi.tabs.sendMessage(tabId, request)) as PageResponse | undefined;
    } catch {
      return pageError("TAB_CHANGED", "The page is not available.");
    }
    if (!response) return pageError("TAB_CHANGED", "The page did not respond.");
    if (!response.ok) return { ok: false, error: response.error };
    if (response.type !== type) return pageError("TAB_CHANGED", "Unexpected response from the page.");
    if (response.type === "page.snapshot") return { ok: true, value: response.snapshot as T };
    if (response.type === "page.find") return { ok: true, value: response.result as T };
    if (response.type === "page.search-results") return { ok: true, value: { results: response.results, url: response.url, excerpt: response.excerpt } as T };
    return pageError("TAB_CHANGED", "Unexpected response from the page.");
  }

  /** Waits for `tabs.onUpdated` completion, then probes `page.health` on a backoff until the deadline. */
  async #settleNavigation(tabId: number): Promise<PageOutcome<{ url: string }>> {
    const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
    await this.#waitForTabComplete(tabId, deadline);

    for (const delay of PROBE_DELAYS_MS) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(delay, remaining));
      const health = await this.#probeHealth(tabId);
      if (health) return { ok: true, value: health };
    }
    return pageError("NAVIGATION_INTERRUPTED", "Navigation did not complete in time.");
  }

  #waitForTabComplete(tabId: number, deadline: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    let done = false;
    const listener: TabUpdatedListener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const finish = () => {
      if (done) return;
      done = true;
      this.#browserApi.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    this.#browserApi.tabs.onUpdated.addListener(listener);
    setTimeout(finish, Math.max(deadline - Date.now(), 0));
    return promise;
  }

  async #probeHealth(tabId: number): Promise<{ url: string } | null> {
    const request: PageHealthRequest = { v: 1, id: crypto.randomUUID(), type: "page.health" };
    try {
      const response = (await this.#browserApi.tabs.sendMessage(tabId, request)) as PageResponse | undefined;
      if (response?.ok && response.type === "page.health") return { url: response.url };
    } catch {
      // Content script not attached yet on the new document; keep probing.
    }
    return null;
  }
}

function pageError(code: PageErrorCode, message: string): { ok: false; error: NormalizedError } {
  return { ok: false, error: { code, message, retryable: false, phase: "page" } };
}

function toToolResultCode(code: NormalizedError["code"]): NonNullable<ToolResult["code"]> {
  switch (code) {
    case "UNSUPPORTED_PAGE":
    case "TAB_CHANGED":
    case "STALE_SNAPSHOT":
    case "TARGET_MISSING":
    case "NOT_INTERACTABLE":
    case "NAVIGATION_INTERRUPTED":
    case "INVALID_TOOL_ARGUMENTS":
    case "LIMIT_EXCEEDED":
      return code;
    default:
      return "TARGET_MISSING";
  }
}

function isSupportedUrl(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return !UNSUPPORTED_HOSTNAME_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix));
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
