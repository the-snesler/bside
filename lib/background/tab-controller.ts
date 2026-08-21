/**
 * Binds one agent run to a single HTTP(S) tab and mediates every page tool
 * call against it: DOM effects are forwarded to the content script, while
 * navigate/go_back are driven directly through the tabs API with a fixed
 * settle/probe sequence. The bound tab never changes once captured; a
 * newly opened tab is never adopted.
 */

import type {
  DomPageToolName,
  DomToolCall,
  NormalizedError,
  PageExecuteRequest,
  PageHealthRequest,
  PageResponse,
  PageSnapshotRequest,
} from "@/lib/protocol";
import type { PageArtifactSummary, PageErrorCode, PageSnapshotV1, ToolCall, ToolResult } from "@/lib/domain/tools";
import {
  validateGoBackArgs,
  validateNavigateArgs,
  validateSnapshotArgs,
} from "@/lib/validation";

const NAVIGATION_TIMEOUT_MS = 10_000;
const PROBE_DELAYS_MS = [100, 200, 400, 800, 1_600, 3_200];
const UNSUPPORTED_HOSTNAME_SUFFIXES = [".mozilla.org", ".mozilla.com"];

type TabSnapshot = { id?: number; url?: string; title?: string };
type TabUpdatedListener = (tabId: number, changeInfo: { status?: string }, tab: TabSnapshot) => void;

export interface TabControllerBrowserApi {
  tabs: {
    query(query: { active: boolean; lastFocusedWindow: boolean }): Promise<TabSnapshot[]>;
    update(tabId: number, updateProperties: { url: string }): Promise<unknown>;
    goBack(tabId: number): Promise<void>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
    onUpdated: {
      addListener(callback: TabUpdatedListener): void;
      removeListener(callback: TabUpdatedListener): void;
    };
  };
}

type PageOutcome<T> = { ok: true; value: T } | { ok: false; error: NormalizedError };
type ExecuteOutcome = { result: ToolResult; snapshot: PageSnapshotV1 | null };

export class TabController {
  #browserApi: TabControllerBrowserApi;
  #tabId: number | null = null;
  #url: string | null = null;
  #title: string | null = null;

  constructor(browserApi: TabControllerBrowserApi) {
    this.#browserApi = browserApi;
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

  /** Binds this controller to the active HTTP(S) tab and captures a readable snapshot. */
  async captureActivePage(): Promise<PageOutcome<{ artifact: PageArtifactSummary; snapshot: PageSnapshotV1 }>> {
    const tabs = await this.#browserApi.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (!tab || tab.id === undefined || !isSupportedUrl(tab.url)) {
      return pageError("UNSUPPORTED_PAGE", "This page cannot be attached.");
    }

    const outcome = await this.#requestSnapshot(tab.id, "readable");
    if (!outcome.ok) return outcome;

    this.#tabId = tab.id;
    this.#url = outcome.value.url;
    this.#title = outcome.value.title;

    const artifact: PageArtifactSummary = {
      artifactId: `page:${tab.id}:${outcome.value.revision}`,
      kind: "page",
      title: outcome.value.title,
      url: outcome.value.url,
      capturedAt: Date.now(),
    };
    return { ok: true, value: { artifact, snapshot: outcome.value } };
  }

  async snapshot(mode: "readable" | "interactive"): Promise<PageOutcome<PageSnapshotV1>> {
    if (this.#tabId === null) return pageError("UNSUPPORTED_PAGE", "No page is attached.");
    return this.#requestSnapshot(this.#tabId, mode);
  }

  async execute(call: ToolCall): Promise<ExecuteOutcome> {
    const outcome = await this.#executeInner(call);
    return outcome.result.ok && outcome.snapshot
      ? { result: { ...outcome.result, summary: appendSnapshotSummary(outcome.result.summary, outcome.snapshot) }, snapshot: outcome.snapshot }
      : outcome;
  }

  async #executeInner(call: ToolCall): Promise<ExecuteOutcome> {
    if (this.#tabId === null) {
      return { result: { ok: false, code: "UNSUPPORTED_PAGE", summary: "No page is attached." }, snapshot: null };
    }

    if (call.name === "page_snapshot") {
      const args = validateSnapshotArgs(call.arguments);
      if (!args) return { result: invalidArgs(), snapshot: null };
      const outcome = await this.snapshot(args.mode);
      if (!outcome.ok) {
        return { result: { ok: false, code: toToolResultCode(outcome.error.code), summary: outcome.error.message }, snapshot: null };
      }
      return { result: { ok: true, summary: "Captured a fresh page snapshot." }, snapshot: outcome.value };
    }

    if (call.name === "page_navigate") {
      const args = validateNavigateArgs(call.arguments);
      if (!args) return { result: invalidArgs(), snapshot: null };
      await this.#browserApi.tabs.update(this.#tabId, { url: args.url });
      return this.#afterNavigation(`Navigated to ${args.url}.`);
    }

    if (call.name === "page_go_back") {
      const args = validateGoBackArgs(call.arguments);
      if (!args) return { result: invalidArgs(), snapshot: null };
      await this.#browserApi.tabs.goBack(this.#tabId);
      return this.#afterNavigation("Went back to the previous page.");
    }

    return this.#executeDomForwarded(call);
  }

  async #executeDomForwarded(call: ToolCall): Promise<ExecuteOutcome> {
    const tabId = this.#tabId;
    if (tabId === null) {
      return { result: { ok: false, code: "UNSUPPORTED_PAGE", summary: "No page is attached." }, snapshot: null };
    }

    const domCall: DomToolCall = { id: call.id, name: call.name as DomPageToolName, arguments: call.arguments };
    const request: PageExecuteRequest = { v: 1, id: crypto.randomUUID(), type: "page.execute", tabId, call: domCall };

    let response: PageResponse | undefined;
    try {
      response = (await this.#browserApi.tabs.sendMessage(tabId, request)) as PageResponse | undefined;
    } catch {
      // The content script's execution context may have been destroyed by a
      // navigation the click itself triggered. Settle the same way
      // navigate/go_back would, then return a fresh snapshot without
      // repeating the action.
      if (call.name !== "page_click") {
        return { result: { ok: false, code: "TAB_CHANGED", summary: "Lost contact with the page." }, snapshot: null };
      }
      const settled = await this.#settleNavigation(tabId);
      if (!settled.ok) {
        return { result: { ok: false, code: "NAVIGATION_INTERRUPTED", summary: "The page did not settle after the click." }, snapshot: null };
      }
      const outcome = await this.#requestSnapshot(tabId, "interactive");
      if (!outcome.ok) {
        return { result: { ok: false, code: toToolResultCode(outcome.error.code), summary: outcome.error.message }, snapshot: null };
      }
      this.#url = outcome.value.url;
      this.#title = outcome.value.title;
      return { result: { ok: true, summary: "Clicked; the page navigated." }, snapshot: outcome.value };
    }

    if (!response) {
      return { result: { ok: false, code: "TAB_CHANGED", summary: "The page did not respond." }, snapshot: null };
    }
    if (!response.ok) {
      return { result: { ok: false, code: toToolResultCode(response.error.code), summary: response.error.message }, snapshot: null };
    }
    if (response.type !== "page.execute") {
      return { result: { ok: false, code: "TARGET_MISSING", summary: "Unexpected response from the page." }, snapshot: null };
    }
    return { result: response.result, snapshot: response.snapshot };
  }

  async #afterNavigation(successSummary: string): Promise<ExecuteOutcome> {
    const tabId = this.#tabId;
    if (tabId === null) {
      return { result: { ok: false, code: "UNSUPPORTED_PAGE", summary: "No page is attached." }, snapshot: null };
    }
    const settled = await this.#settleNavigation(tabId);
    if (!settled.ok) {
      return { result: { ok: false, code: "NAVIGATION_INTERRUPTED", summary: "Navigation did not complete in time." }, snapshot: null };
    }
    const outcome = await this.#requestSnapshot(tabId, "readable");
    if (!outcome.ok) {
      return { result: { ok: false, code: toToolResultCode(outcome.error.code), summary: outcome.error.message }, snapshot: null };
    }
    this.#url = outcome.value.url;
    this.#title = outcome.value.title;
    return { result: { ok: true, summary: successSummary }, snapshot: outcome.value };
  }

  async #requestSnapshot(tabId: number, mode: "readable" | "interactive"): Promise<PageOutcome<PageSnapshotV1>> {
    const request: PageSnapshotRequest = { v: 1, id: crypto.randomUUID(), type: "page.snapshot", tabId, mode };
    let response: PageResponse | undefined;
    try {
      response = (await this.#browserApi.tabs.sendMessage(tabId, request)) as PageResponse | undefined;
    } catch {
      return pageError("TAB_CHANGED", "The page is not available.");
    }
    if (!response) return pageError("TAB_CHANGED", "The page did not respond.");
    if (!response.ok) return { ok: false, error: response.error };
    if (response.type !== "page.snapshot") return pageError("TAB_CHANGED", "Unexpected response from the page.");
    return { ok: true, value: response.snapshot };
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

function invalidArgs(): ToolResult {
  return { ok: false, code: "INVALID_TOOL_ARGUMENTS", summary: "Invalid or missing arguments for this tool call." };
}

const MAX_SUMMARY_NODES = 40;
const MAX_SUMMARY_TEXT_LEN = 800;

/** Appends the fresh revision and a bounded description of the fresh snapshot so the model can observe the exact revision string these tools require, plus refs/values/text, without a separate page_snapshot call. */
function appendSnapshotSummary(summary: string, snapshot: PageSnapshotV1): string {
  const description = summarizeSnapshot(snapshot);
  const revision = `Revision: ${snapshot.revision}.`;
  return description ? `${summary} ${revision} ${description}` : `${summary} ${revision}`;
}

function summarizeSnapshot(snapshot: PageSnapshotV1): string {
  if (snapshot.nodes.length > 0) {
    const lines = snapshot.nodes.slice(0, MAX_SUMMARY_NODES).map(describeNode);
    const suffix = snapshot.nodes.length > MAX_SUMMARY_NODES ? ` (+${snapshot.nodes.length - MAX_SUMMARY_NODES} more elements)` : "";
    return `Elements: ${lines.join("; ")}${suffix}`;
  }
  if (snapshot.readableText) {
    const truncated = snapshot.readableText.length > MAX_SUMMARY_TEXT_LEN;
    const text = truncated ? `${snapshot.readableText.slice(0, MAX_SUMMARY_TEXT_LEN)}…` : snapshot.readableText;
    return `Page text: ${text}`;
  }
  return "";
}

function describeNode(node: PageSnapshotV1["nodes"][number]): string {
  const bits = [node.ref, node.role, node.name ? `"${node.name}"` : ""];
  if (node.value !== undefined) bits.push(`value=${JSON.stringify(node.value)}`);
  if (node.state.checked !== undefined) bits.push(node.state.checked ? "checked" : "unchecked");
  if (node.state.disabled) bits.push("disabled");
  return bits.filter(Boolean).join(" ");
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
