/**
 * Binds a controller to a single HTTP(S) tab and mediates every page request
 * against it: snapshots, find, and DOM actions are forwarded to the content
 * script, while navigate/go_back are driven directly through the tabs API with
 * a fixed settle/probe sequence. The bound tab never changes once captured; a
 * newly opened tab is never implicitly adopted. forTab creates a separate
 * controller for an explicitly selected workspace tab. Agent-tab ownership is
 * recorded as a session tab value (`AGENT_TAB_TAG_KEY`) on the tab itself.
 * Screenshots go through `tabs.captureTab`, bounded here (see `screenshot`).
 *
 * A tab's outline is its top frame's, with each cross-origin frame's own
 * outline spliced in at the frame's position (see `#composedOutline`). Frames
 * get short names (`f3`, see `FrameAliases`) that prefix their refs.
 *
 * A tab showing a PDF in Firefox's viewer has no content script. Its outline
 * is the PDF's text instead (see `#pdfOf`): another tab's content script
 * fetches the bytes, and the shared `PdfReader` extracts the text. Such a
 * tab is read-only.
 */

import type {
  NormalizedError,
  PageCaptureDoneRequest,
  PageCapturePrepareRequest,
  PageExecuteRequest,
  PageFetchPdfRequest,
  PageFindRequest,
  PageHealthRequest,
  PageOutlineRequest,
  PageResponse,
  PageSearchResultsRequest,
  PageShieldRequest,
  PageShieldState,
  PageSnapshotRequest,
  PageTableRequest,
} from "@/lib/protocol";
import { MAX_FRAME_OUTLINE_CHARS } from "@/lib/protocol";
import type { CaptureGeometry, ChildFrame, DomAction, ElementTarget, FrameOutline, PageArtifactSummary, PageErrorCode, PageFindResult, PageRect, PageSnapshot, PageTable, SearchPage, ToolResult } from "@/lib/domain/tools";
import { findInOutline, lineOffsets, sliceOutline } from "@/lib/domain/outline";
import { base64ToBytes, isPdfHeader, looksLikePdfUrl, PDF_LIMITS, PdfError, renderPdfText, type PdfFetchResult, type PdfText } from "@/lib/domain/pdf";
import { PdfReader } from "@/lib/background/pdf";
import { base64Bytes, formatKeyChord, isSessionId, validateHttpUrl, WORKSPACE_MAX_BINARY_BYTES } from "@/lib/validation";

const NAVIGATION_TIMEOUT_MS = 10_000;
const PROBE_DELAYS_MS = [100, 200, 400, 800, 1_600, 3_200];
const UNSUPPORTED_HOSTNAME_SUFFIXES = [".mozilla.org", ".mozilla.com"];
export const DEFAULT_SNAPSHOT_CHARS = 16_000;
export const ARTIFACT_SNAPSHOT_CHARS = 8_000;

/** Longest side of a screenshot, in image pixels; larger captures are rendered at a smaller scale. */
export const SCREENSHOT_MAX_DIMENSION = 1600;
/** Most bytes one screenshot may have (decoded), so any screenshot fits in a `/workspace` file; a larger one is retaken smaller, then refused. */
export const SCREENSHOT_MAX_BYTES = WORKSPACE_MAX_BINARY_BYTES;
/** A full-page screenshot covers at most this much of the page, in CSS pixels; the rest is cut. */
export const FULL_PAGE_MAX_CSS = { width: 4_000, height: 12_000 };
/** JPEG quality, then smaller scales and qualities tried in turn while an image is over the byte cap. */
const CAPTURE_ATTEMPTS = [{ scale: 1, quality: 70 }, { scale: 0.7, quality: 55 }, { scale: 0.5, quality: 45 }];

/** Firefox's frame id for a tab's top-level document. */
const TOP_FRAME = 0;
/** Other tabs asked in turn to fetch a PDF until one has a content script that answers. */
const PDF_HELPER_TABS = 4;
const PDF_READ_ONLY = "This tab shows a PDF in Firefox's viewer: bside can read it (snapshot, find) but not operate it, and it has no refs or tables.";

/**
 * Bounds on the cross-origin frames composed into one tab outline: nesting
 * depth (a frame in the top document is depth 1), how many are read, the
 * characters each may add, and the characters all of them may add.
 */
export const FRAME_LIMITS = { depth: 3, frames: 20, charsPerFrame: 30_000, totalChars: 150_000 };
/** How long a frame's content script may take to answer before the frame is shown as not readable. */
const FRAME_TIMEOUT_MS = 3_000;
/** The largest frame name (`f999999`), as refs allow. */
const MAX_FRAME_ALIAS = 999_999;

/**
 * Short names for a tab's cross-origin frames: `f1`, `f2`, … in the order
 * bside first sees them, never reused while the background runs, so a frame
 * keeps its name (and a ref like `f3:e12` its frame) across snapshots. A
 * frame's own document id then decides whether its refs are current.
 */
export class FrameAliases {
  #tabs = new Map<number, { next: number; byFrame: Map<number, number>; byAlias: Map<number, { frameId: number; parentFrameId: number }> }>();

  /** The frame's name number, assigning the next one on first sight; null once a tab has used them all. */
  name(tabId: number, frameId: number, parentFrameId: number): number | null {
    let tab = this.#tabs.get(tabId);
    if (!tab) this.#tabs.set(tabId, tab = { next: 1, byFrame: new Map(), byAlias: new Map() });
    let alias = tab.byFrame.get(frameId);
    if (alias === undefined) {
      if (tab.next > MAX_FRAME_ALIAS) return null;
      alias = tab.next++;
      tab.byFrame.set(frameId, alias);
    }
    tab.byAlias.set(alias, { frameId, parentFrameId });
    return alias;
  }

  /** Firefox's id for a named frame and for the frame it was last seen in. */
  lookup(tabId: number, alias: number): { frameId: number; parentFrameId: number } | null {
    return this.#tabs.get(tabId)?.byAlias.get(alias) ?? null;
  }

  /** A named frame's name number, by Firefox's id. */
  aliasOf(tabId: number, frameId: number): number | null {
    return this.#tabs.get(tabId)?.byFrame.get(frameId) ?? null;
  }

  /** Firefox's id for the frame a named frame was last seen in (0 for the top document). */
  parentOf(tabId: number, frameId: number): number | null {
    const alias = this.aliasOf(tabId, frameId);
    return alias === null ? null : this.lookup(tabId, alias)?.parentFrameId ?? null;
  }

  /** Drops a closed tab's names. */
  forget(tabId: number): void {
    this.#tabs.delete(tabId);
  }
}

/** A tab's outline, composed from its top frame and the cross-origin frames in it. */
interface ComposedOutline {
  documentId: string;
  url: string;
  title: string;
  lines: string[];
  selectionText: string;
  frames: Record<string, string>;
}

export const AGENT_TAB_TAG_KEY = "bside.agentTab";
export const AGENT_TAB_ROLES = ["agent", "search"] as const;

/**
 * Session value marking a tab bside owns. Firefox keeps it with the tab across
 * browser restarts, session restore, and undo-close, whatever ID the tab gets.
 */
export interface AgentTabTagV2 {
  v: 2;
  role: (typeof AGENT_TAB_ROLES)[number];
  /** The chat session whose runs may use the tab; each session has its own search tab. */
  sessionId: string;
  /** When a program last used the tab; idle auto-close counts from this. */
  lastUsedAt: number;
}

/** A tag from before agent tabs had an owning session. It names no session, so it is never adopted. */
export interface AgentTabTagV1 {
  v: 1;
  role: (typeof AGENT_TAB_ROLES)[number];
  lastUsedAt: number;
}

export type TabSnapshot = {
  id?: number;
  url?: string;
  title?: string;
  hidden?: boolean;
  active?: boolean;
  windowId?: number;
  index?: number;
  favIconUrl?: string;
  /** "loading" or "complete". */
  status?: string;
};
type TabUpdatedListener = (tabId: number, changeInfo: { status?: string }, tab: TabSnapshot) => void;

/** `tabs.captureTab` options (Firefox's `extensionTypes.ImageDetails`): `rect` in CSS pixels of the document, `scale` image pixels per CSS pixel. */
export interface CaptureOptions {
  format: "jpeg" | "png";
  quality?: number;
  rect: PageRect;
  scale: number;
}

/** What a screenshot covers: the visible viewport, the whole page (within `FULL_PAGE_MAX_CSS`), or one element. */
export interface ScreenshotRequest {
  area: "viewport" | "full";
  target: ElementTarget | null;
  /** The frame `target` is in: 0 for the top document, else the frame's name number (`f3` is 3). */
  frame: number;
  format: "jpeg" | "png";
}

/** One bounded screenshot, held in memory for one provider round; never persisted. */
export interface Screenshot {
  mimeType: "image/jpeg" | "image/png";
  /** Base64 image bytes, without a data-URL prefix. */
  data: string;
  /** Decoded size in bytes. */
  bytes: number;
  width: number;
  height: number;
  url: string;
  documentId: string;
  /** Whether a full-page or element capture was cut at `FULL_PAGE_MAX_CSS`. */
  cut: boolean;
}

export interface TabControllerBrowserApi {
  tabs: {
    query(query: { active?: boolean; lastFocusedWindow?: boolean }): Promise<TabSnapshot[]>;
    create?(properties: { url: string; active: boolean }): Promise<TabSnapshot>;
    hide?(tabId: number): Promise<number[]>;
    show?(tabId: number): Promise<void>;
    move?(tabId: number, moveProperties: { windowId: number; index: number }): Promise<unknown>;
    remove?(tabId: number): Promise<void>;
    /** Resolves to a data URL. Needs `<all_urls>`. */
    captureTab?(tabId: number, options: CaptureOptions): Promise<string>;
    update(tabId: number, updateProperties: { url: string } | { active: true }): Promise<unknown>;
    goBack(tabId: number): Promise<void>;
    /** Always called with a `frameId`; without one, every frame of the tab would receive the message. */
    sendMessage(tabId: number, message: unknown, options: { frameId: number }): Promise<unknown>;
    onUpdated: {
      addListener(callback: TabUpdatedListener): void;
      removeListener(callback: TabUpdatedListener): void;
    };
  };
  /** Firefox's `search` API: runs the user's default engine. Needs the `search` permission. */
  search?: {
    query(properties: { text: string; tabId: number }): Promise<void>;
  };
  sessions?: {
    getTabValue(tabId: number, key: string): Promise<unknown>;
    setTabValue(tabId: number, key: string, value: unknown): Promise<void>;
    removeTabValue(tabId: number, key: string): Promise<void>;
  };
}

export type PageOutcome<T> = { ok: true; value: T } | { ok: false; error: NormalizedError };
/** A DOM action's result plus the document it ran in (null when the page navigated away). */
export type ActionOutcome = { result: ToolResult; documentId: string | null };

/** Whether a captured image is one flat color, as a tab that was not painted comes out. */
export type BlankImageCheck = (dataUrl: string) => Promise<boolean>;

export class TabController {
  #browserApi: TabControllerBrowserApi;
  #isBlank: BlankImageCheck;
  #frames: FrameAliases;
  #pdfs: PdfReader;
  #tabId: number | null = null;
  #url: string | null = null;
  #title: string | null = null;

  /**
   * Pass the background's one `FrameAliases` so every controller names a
   * tab's frames the same way, and its one `PdfReader` so a PDF is parsed once.
   */
  constructor(browserApi: TabControllerBrowserApi, isBlank: BlankImageCheck = isBlankImage, frames: FrameAliases = new FrameAliases(), pdfs: PdfReader = new PdfReader()) {
    this.#browserApi = browserApi;
    this.#isBlank = isBlank;
    this.#frames = frames;
    this.#pdfs = pdfs;
  }

  get frames(): FrameAliases {
    return this.#frames;
  }

  get tabId(): number | null {
    return this.#tabId;
  }

  /** Called on a tab's load/URL change so a viewer reload reads fresh PDF text. */
  forgetPdf(tabId: number): void {
    this.#pdfs.forgetTab(tabId);
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
    const controller = new TabController(this.#browserApi, this.#isBlank, this.#frames, this.#pdfs);
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

  /** An empty background tab, for a search to load into (see `search`). */
  async createBlankTab(): Promise<number> {
    if (!this.#browserApi.tabs.create) throw new Error("Tab creation is unavailable.");
    const tab = await this.#browserApi.tabs.create({ url: "about:blank", active: false });
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

  /** Switches to any tab, including a page bside cannot read (a new tab page, say). */
  async activateTab(tabId: number): Promise<void> {
    await this.#browserApi.tabs.update(tabId, { active: true });
  }

  /**
   * Moves a hidden tab next to the last-focused window's active tab, shows
   * it, and switches to it. Returns the tab that was active before, unless it
   * is the revealed tab itself. A failed move only leaves the tab where it was.
   */
  async revealTab(tabId: number): Promise<number | null> {
    const [active] = await this.#browserApi.tabs.query({ active: true, lastFocusedWindow: true });
    const previous = active?.id !== undefined && active.id !== tabId ? active.id : null;
    if (previous !== null && active!.windowId !== undefined && this.#browserApi.tabs.move) {
      await this.#browserApi.tabs.move(tabId, { windowId: active!.windowId, index: (active!.index ?? -2) + 1 }).catch(() => {});
    }
    await this.showTab(tabId);
    await this.#browserApi.tabs.update(tabId, { active: true });
    return previous;
  }

  /** Untags the tab first, so reopening it from recently closed tabs yields an ordinary tab. */
  async closeTab(tabId: number): Promise<void> {
    if (!this.#browserApi.tabs.remove) throw new Error("Closing tabs is unavailable.");
    await this.untagAgentTab(tabId).catch(() => {});
    await this.#browserApi.tabs.remove(tabId);
    this.#frames.forget(tabId);
    this.forgetPdf(tabId);
  }

  /** The tab's agent tag (current or legacy), or null when it has none or holds anything malformed. */
  async agentTabTag(tabId: number): Promise<AgentTabTagV2 | AgentTabTagV1 | null> {
    const value = await this.#browserApi.sessions?.getTabValue(tabId, AGENT_TAB_TAG_KEY);
    return isAgentTabTag(value) ? value : null;
  }

  async tagAgentTab(tabId: number, tag: AgentTabTagV2): Promise<void> {
    if (!this.#browserApi.sessions) throw new Error("Session tab values are unavailable.");
    await this.#browserApi.sessions.setTabValue(tabId, AGENT_TAB_TAG_KEY, tag);
  }

  async untagAgentTab(tabId: number): Promise<void> {
    if (!this.#browserApi.sessions) throw new Error("Session tab values are unavailable.");
    await this.#browserApi.sessions.removeTabValue(tabId, AGENT_TAB_TAG_KEY);
  }

  /**
   * Shows, updates, or removes the page shield in a tab. Returns whether its
   * content script applied it; one that is not loaded yet asks for the state itself when it starts.
   */
  async setShield(tabId: number, shield: PageShieldState): Promise<boolean> {
    const request: PageShieldRequest = { v: 1, id: crypto.randomUUID(), type: "page.shield", frameId: TOP_FRAME, tabId, shield };
    try {
      const response = (await this.#browserApi.tabs.sendMessage(tabId, request, { frameId: TOP_FRAME })) as PageResponse | undefined;
      return response?.ok === true && response.type === "page.shield";
    } catch {
      return false;
    }
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
      if (delay >= PROBE_DELAYS_MS[1]! && await this.#showsPdf(tabId, true)) return;
      if (Date.now() >= deadline) break;
    }
    if (await this.#showsPdf(tabId)) return;
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
    return this.capturePage(tab.id);
  }

  /** Captures the menu chip's source without activating it or falling back to the active tab. */
  async capturePage(tabId: number): Promise<PageOutcome<{ artifact: PageArtifactSummary; snapshot: PageSnapshot }>> {
    const outcome = await this.#snapshotOf(tabId, { offset: 0, maxChars: ARTIFACT_SNAPSHOT_CHARS });
    if (!outcome.ok) return outcome;

    this.#tabId = tabId;
    this.#url = outcome.value.url;
    this.#title = outcome.value.title;

    const artifact: PageArtifactSummary = {
      artifactId: `page:${tabId}:${outcome.value.documentId}`,
      kind: "page",
      title: outcome.value.title,
      url: outcome.value.url,
      capturedAt: Date.now(),
    };
    return { ok: true, value: { artifact, snapshot: outcome.value } };
  }

  async snapshot(options: { offset: number; maxChars: number } = { offset: 0, maxChars: DEFAULT_SNAPSHOT_CHARS }): Promise<PageOutcome<PageSnapshot>> {
    if (this.#tabId === null) return pageError("UNSUPPORTED_PAGE", "No page is attached.");
    return this.#snapshotOf(this.#tabId, options);
  }

  /** The top frame slices its own outline; a page with cross-origin frames is composed and sliced here instead. */
  async #snapshotOf(tabId: number, options: { offset: number; maxChars: number }): Promise<PageOutcome<PageSnapshot>> {
    const top = await this.#request<{ snapshot: PageSnapshot; frames: number }>(tabId, { type: "page.snapshot", frameId: TOP_FRAME, tabId, ...options }, "page.snapshot");
    if (!top.ok) return await this.#pdfSnapshot(tabId, options) ?? top;
    if (!(top.value.frames > 0)) return { ok: true, value: top.value.snapshot };
    const composed = await this.#composedOutline(tabId);
    if (!composed.ok) return composed;
    const { documentId, url, title, lines, selectionText, frames } = composed.value;
    const text = lines.join("\n");
    const { start, end } = sliceOutline(text, options.offset, options.maxChars);
    return { ok: true, value: { version: 2, tabId, documentId, url, title, text: text.slice(start, end), offset: start, end, totalChars: text.length, selectionText, frames } };
  }

  async find(query: string): Promise<PageOutcome<PageFindResult>> {
    const tabId = this.#tabId;
    if (tabId === null) return pageError("UNSUPPORTED_PAGE", "No page is attached.");
    const top = await this.#request<{ result: PageFindResult; frames: number }>(tabId, { type: "page.find", frameId: TOP_FRAME, tabId, query }, "page.find");
    if (!top.ok) {
      const pdf = await this.#pdfOf(tabId);
      if (!pdf.ok) return pdf;
      if (!pdf.value) return top;
      const lines = renderPdfText(pdf.value.pdf).split("\n");
      return { ok: true, value: { documentId: pdf.value.documentId, url: pdf.value.url, query, ...findInOutline(lines, lineOffsets(lines), query) } };
    }
    if (!(top.value.frames > 0)) return { ok: true, value: top.value.result };
    const composed = await this.#composedOutline(tabId);
    if (!composed.ok) return composed;
    const { documentId, url, lines, frames } = composed.value;
    return { ok: true, value: { documentId, url, query, ...findInOutline(lines, lineOffsets(lines), query), frames } };
  }

  /**
   * The top frame's whole outline with each cross-origin frame's outline in
   * place of its placeholder line: a `[frame f3 "Title" (url)]` header, the
   * frame's lines indented, and `[/frame f3]`. Frames are read in document
   * order within `FRAME_LIMITS`; one past a limit, or whose content script
   * does not answer (still loading, sandboxed, or not a web page), stays a
   * one-line placeholder with its URL.
   */
  async #composedOutline(tabId: number): Promise<PageOutcome<ComposedOutline>> {
    const top = await this.#frameOutline(tabId, TOP_FRAME, "", MAX_FRAME_OUTLINE_CHARS);
    if (!top.ok) return top;
    const budget = { frames: FRAME_LIMITS.frames, chars: FRAME_LIMITS.totalChars };
    const frames: Record<string, string> = {};
    const lines = await this.#spliceFrames(tabId, TOP_FRAME, top.value, 1, budget, frames);
    const { documentId, url, title, selectionText } = top.value;
    return { ok: true, value: { documentId, url, title, lines, selectionText, frames } };
  }

  async #spliceFrames(tabId: number, frameId: number, outline: FrameOutline, depth: number, budget: { frames: number; chars: number }, documents: Record<string, string>): Promise<string[]> {
    const lines: string[] = [];
    let next = 0;
    for (const child of outline.frames.toSorted((a, b) => a.line - b.line)) {
      if (child.line < next || child.line >= outline.lines.length) continue;
      lines.push(...outline.lines.slice(next, child.line));
      next = child.line + 1;
      lines.push(...await this.#childFrame(tabId, frameId, child, depth, budget, documents));
    }
    lines.push(...outline.lines.slice(next));
    return lines;
  }

  async #childFrame(tabId: number, parentFrameId: number, child: ChildFrame, depth: number, budget: { frames: number; chars: number }, documents: Record<string, string>): Promise<string[]> {
    const alias = this.#frames.name(tabId, child.frameId, parentFrameId);
    const name = alias === null ? "" : ` f${alias}`;
    const header = (url: string) => `[frame${name}${child.title ? ` ${JSON.stringify(child.title)}` : ""} (${clipUrl(url)})`;
    if (alias === null) return [`${header(child.url)} not shown: too many frames]`];
    if (depth > FRAME_LIMITS.depth) return [`${header(child.url)} not shown: nested too deeply]`];
    if (budget.frames <= 0 || budget.chars < 500) return [`${header(child.url)} not shown: frame limit for one page reached]`];
    budget.frames -= 1;
    const outline = await this.#frameOutline(tabId, child.frameId, `f${alias}:`, Math.min(FRAME_LIMITS.charsPerFrame, budget.chars));
    if (!outline.ok) return [`${header(child.url)} not readable: its content is not available to bside]`];
    budget.chars -= outline.value.lines.reduce((total, line) => total + line.length + 1, 0);
    documents[`f${alias}`] = outline.value.documentId;
    const inner = await this.#spliceFrames(tabId, child.frameId, outline.value, depth + 1, budget, documents);
    return [`${header(outline.value.url)}]`, ...inner.map((line) => `  ${line}`), `[/frame f${alias}]`];
  }

  /** One frame's whole outline, or an error when its content script does not answer in time. */
  async #frameOutline(tabId: number, frameId: number, refPrefix: string, maxChars: number): Promise<PageOutcome<FrameOutline>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<PageOutcome<FrameOutline>>((resolve) => {
      timer = setTimeout(() => resolve(pageError("TAB_CHANGED", "The frame did not answer.")), FRAME_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.#request<FrameOutline>(tabId, { type: "page.outline", frameId, tabId, refPrefix, maxChars }, "page.outline"), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** One page of a table's data rows, read by the frame it is in (0 for the top document). */
  async table(target: ElementTarget, page: { offset: number; limit: number }, frame = 0): Promise<PageOutcome<PageTable>> {
    const tabId = this.#tabId;
    if (tabId === null) return pageError("UNSUPPORTED_PAGE", "No page is attached.");
    if (await this.#isPdf()) return pageError("UNSUPPORTED_PAGE", PDF_READ_ONLY);
    const route = this.#route(tabId, frame);
    if (!route) return pageError("TARGET_MISSING", `Frame f${frame} is not on this page. Read a fresh snapshot.`);
    return this.#request<PageTable>(tabId, { type: "page.table", frameId: route.frameId, tabId, refPrefix: route.refPrefix, target, ...page }, "page.table");
  }

  /** A tab showing a PDF: its text as a read-only outline (no refs); null when the tab shows no PDF. */
  async #pdfSnapshot(tabId: number, options: { offset: number; maxChars: number }): Promise<PageOutcome<PageSnapshot> | null> {
    const pdf = await this.#pdfOf(tabId);
    if (!pdf.ok) return pdf;
    if (!pdf.value) return null;
    const { documentId, url, title } = pdf.value;
    const text = renderPdfText(pdf.value.pdf);
    const { start, end } = sliceOutline(text, options.offset, options.maxChars);
    return { ok: true, value: { version: 2, tabId, documentId, url, title, text: text.slice(start, end), offset: start, end, totalChars: text.length, selectionText: "", pdf: { pages: pdf.value.pdf.pages } } };
  }

  /**
   * The PDF a tab shows in Firefox's viewer, or null when it shows none. Only
   * called for a tab no content script answers in, and only once it finished
   * loading or when its URL names a PDF (`onlyPdfUrls` asks for just those);
   * the bytes decide whether it is one.
   */
  async #pdfOf(tabId: number, onlyPdfUrls = false): Promise<PageOutcome<{ pdf: PdfText; documentId: string; url: string; title: string } | null>> {
    const tab = (await this.allTabs()).find((candidate) => candidate.id === tabId);
    const url = tab?.url;
    if (!url || !isSupportedUrl(url) || !(looksLikePdfUrl(url) || (!onlyPdfUrls && tab.status === "complete"))) return { ok: true, value: null };
    try {
      const pdf = await this.#pdfs.read(pdfKey(tabId, url), async () => (await this.#fetchPdf(tabId, url))?.data ?? null);
      return { ok: true, value: pdf && { pdf, documentId: pdfDocumentId(url, pdf), url, title: pdf.title || tab.title || "" } };
    } catch (error) {
      return pageError("UNSUPPORTED_PAGE", `This tab shows a PDF that bside could not read. ${error instanceof PdfError ? error.message : "Something unexpected went wrong."}`);
    }
  }

  /** Whether a tab no content script answers in shows a PDF (one that could not be read counts), as for `#pdfOf`. */
  async #showsPdf(tabId: number, onlyPdfUrls = false): Promise<boolean> {
    const pdf = await this.#pdfOf(tabId, onlyPdfUrls);
    return !pdf.ok || pdf.value !== null;
  }

  /**
   * A PDF's bytes, fetched through another tab's content script (the
   * background's own `connect-src` does not reach the web): a tab on the
   * PDF's own origin first, with the user's cookies there as that site's own
   * page would send them; else any other readable tab, hidden agent tabs
   * first, without cookies. Null when the URL serves something else.
   */
  async #fetchPdf(pdfTabId: number, url: string): Promise<{ data: Uint8Array; base64: string } | null> {
    const origin = new URL(url).origin;
    const sameOrigin = (tab: TabSnapshot) => URL.parse(tab.url ?? "")?.origin === origin;
    const others = (await this.listTabs()).filter((tab) => tab.id !== pdfTabId);
    const helpers = [...others.filter(sameOrigin), ...others.filter((tab) => !sameOrigin(tab)).sort((a, b) => Number(b.hidden ?? false) - Number(a.hidden ?? false))];
    for (const helper of helpers.slice(0, PDF_HELPER_TABS)) {
      const fetched = await this.#request<PdfFetchResult>(helper.id!, { type: "page.fetch-pdf", frameId: TOP_FRAME, tabId: helper.id!, url, credentials: sameOrigin(helper) ? "include" : "omit" }, "page.fetch-pdf");
      // No content script answered there (another PDF, a page still loading): ask the next tab.
      if (!fetched.ok) continue;
      const result = fetched.value;
      if (result.kind === "pdf") {
        const data = base64ToBytes(result.base64);
        if (data.byteLength > PDF_LIMITS.bytes || !isPdfHeader(data)) throw new PdfError("The downloaded file was not a readable PDF.");
        return { data, base64: result.base64 };
      }
      if (result.kind === "not-pdf") {
        if (looksLikePdfUrl(url)) throw new PdfError("Its server did not send bside a PDF; it may need the user to be signed in.");
        return null;
      }
      if (result.kind === "too-large") throw new PdfError(`It is larger than ${PDF_LIMITS.bytes.toLocaleString("en-US")} bytes.`);
      throw new PdfError(`Downloading it failed${result.status ? ` (HTTP ${result.status})` : ""}.`);
    }
    throw new PdfError("No open web page could fetch it for reading; open any web page (for example with browser.open) and try again.");
  }

  /** The bound tab's PDF as base64, to save in `/workspace`. */
  async pdfData(): Promise<PageOutcome<{ base64: string; bytes: number; url: string }>> {
    const tabId = this.#tabId;
    if (tabId === null) return pageError("UNSUPPORTED_PAGE", "No page is attached.");
    const url = (await this.allTabs()).find((tab) => tab.id === tabId)?.url;
    if (!url || !isSupportedUrl(url) || await this.#probeHealth(tabId)) return pageError("UNSUPPORTED_PAGE", "This tab does not show a PDF.");
    try {
      const pdf = await this.#fetchPdf(tabId, url);
      return pdf ? { ok: true, value: { base64: pdf.base64, bytes: pdf.data.byteLength, url } } : pageError("UNSUPPORTED_PAGE", "This tab does not show a PDF.");
    } catch (error) {
      return pageError("UNSUPPORTED_PAGE", `This tab shows a PDF that bside could not fetch. ${error instanceof PdfError ? error.message : "Something unexpected went wrong."}`);
    }
  }

  /** The text of a PDF held as base64 (a `/workspace` file). */
  async pdfText(base64: string): Promise<PageOutcome<PdfText>> {
    try {
      const pdf = await this.#pdfs.read(`data ${hashText(base64)} ${base64.length}`, async () => base64ToBytes(base64));
      return pdf ? { ok: true, value: pdf } : pageError("UNSUPPORTED_PAGE", "The file is not a readable PDF.");
    } catch (error) {
      return pageError("UNSUPPORTED_PAGE", error instanceof PdfError ? error.message : "The file is not a readable PDF.");
    }
  }

  /** Whether the bound tab is a PDF bside has read; it can be read but not operated. */
  async #isPdf(): Promise<boolean> {
    return this.#tabId !== null && this.#url !== null && (await this.#pdfs.cached(pdfKey(this.#tabId, this.#url))) !== null;
  }

  /**
   * Runs the user's default search engine in a tab with Firefox's
   * `search.query`, waits for the results page, and reads it as a compact
   * `SearchPage` (never a snapshot). The tab need not be bound or readable
   * beforehand: a new search tab starts blank.
   */
  async search(tabId: number, text: string): Promise<PageOutcome<SearchPage>> {
    const search = this.#browserApi.search;
    if (!search) return pageError("UNSUPPORTED_PAGE", "Firefox's search API is unavailable.");
    // Listen before searching, so the results page finishing early is not missed.
    const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
    const complete = this.#waitForTabComplete(tabId, deadline);
    try {
      await search.query({ text, tabId });
    } catch {
      return pageError("NAVIGATION_INTERRUPTED", "Firefox could not run the search in the search tab.");
    }
    const settled = await this.#settleNavigation(tabId, deadline, complete);
    if (!settled.ok) return settled;
    return this.#request<SearchPage>(tabId, { type: "page.search-results", frameId: TOP_FRAME, tabId }, "page.search-results");
  }

  /**
   * Captures the bound tab with `tabs.captureTab`, bounded to
   * `SCREENSHOT_MAX_DIMENSION` pixels (by rendering at a smaller scale) and
   * `SCREENSHOT_MAX_BYTES` (retaking it smaller, then refusing). The page
   * measures itself first and hides its shield until the capture ends.
   *
   * Firefox paints background tabs for `captureTab` (it draws the document
   * from its content process), and a hidden agent tab is a background tab. If
   * a hidden tab still fails to capture or comes out blank, it is shown
   * without being activated, captured again, and hidden again; the hide runs
   * in `finally`, and Firefox never hides the active tab, so a tab the user
   * switched to (or is watching) stays visible.
   */
  async screenshot(request: ScreenshotRequest): Promise<PageOutcome<Screenshot>> {
    const tabId = this.#tabId;
    if (tabId === null) return pageError("UNSUPPORTED_PAGE", "No page is attached.");
    const capture = this.#browserApi.tabs.captureTab?.bind(this.#browserApi.tabs);
    if (!capture) return pageError("UNSUPPORTED_PAGE", "Screenshots are unavailable in this browser.");
    const measured = request.frame !== 0 && request.target
      ? await this.#measureInFrame(tabId, request.frame, request.target)
      : await this.#request<CaptureGeometry>(tabId, { type: "page.capture-prepare", frameId: TOP_FRAME, tabId, refPrefix: "", target: request.target, childFrameId: null }, "page.capture-prepare");
    if (!measured.ok) return await this.#isPdf() ? pageError("UNSUPPORTED_PAGE", "Screenshots of PDF tabs are not supported; read the PDF's text with snapshot() or find().") : measured;
    try {
      const geometry = measured.value;
      const { rect, cut } = captureRect(geometry, request);
      if (rect.width < 1 || rect.height < 1) {
        return pageError("NOT_INTERACTABLE", request.frame !== 0
          ? "The element is outside the visible part of its frame. Click or scroll it into view first, or take a viewport screenshot."
          : "There is nothing visible to capture.");
      }
      const fit = Math.min(1, SCREENSHOT_MAX_DIMENSION / Math.max(rect.width, rect.height));
      for (const attempt of CAPTURE_ATTEMPTS) {
        const scale = fit * attempt.scale;
        const options: CaptureOptions = { format: request.format, rect, scale, ...(request.format === "jpeg" ? { quality: attempt.quality } : {}) };
        const dataUrl = await this.#capture(tabId, options, capture);
        const image = parseImageDataUrl(dataUrl, request.format);
        if (!image) return pageError("TAB_CHANGED", "Firefox returned an unreadable screenshot.");
        if (image.bytes > SCREENSHOT_MAX_BYTES) continue;
        this.#url = geometry.url;
        this.#title = geometry.title;
        return { ok: true, value: {
          ...image, width: Math.max(1, Math.round(rect.width * scale)), height: Math.max(1, Math.round(rect.height * scale)),
          url: geometry.url, documentId: geometry.documentId, cut,
        } };
      }
      return { ok: false, error: { code: "LIMIT_EXCEEDED", message: `The screenshot stayed over ${SCREENSHOT_MAX_BYTES.toLocaleString("en-US")} bytes at reduced size; capture the viewport or one element instead.`, retryable: false, phase: "page" } };
    } catch {
      return pageError("TAB_CHANGED", "Firefox could not capture this tab.");
    } finally {
      const done: PageCaptureDoneRequest = { v: 1, id: crypto.randomUUID(), type: "page.capture-done", frameId: TOP_FRAME, tabId };
      await this.#browserApi.tabs.sendMessage(tabId, done, { frameId: TOP_FRAME }).catch(() => {});
    }
  }

  /**
   * Places an element inside a cross-origin frame in the top document: the
   * frame measures the element in its own viewport, then each enclosing frame
   * up to the top reports where it draws that frame (the frame element's
   * content box). The box is clipped to every frame's viewport on the way,
   * so only the part a user could see is captured. The top frame's answer
   * comes last, and it hides the shield until `page.capture-done`.
   */
  async #measureInFrame(tabId: number, frame: number, target: ElementTarget): Promise<PageOutcome<CaptureGeometry>> {
    const route = this.#route(tabId, frame);
    if (!route) return pageError("TARGET_MISSING", `Frame f${frame} is not on this page. Read a fresh snapshot.`);
    const inner = await this.#request<CaptureGeometry>(tabId, { type: "page.capture-prepare", frameId: route.frameId, tabId, refPrefix: route.refPrefix, target, childFrameId: null }, "page.capture-prepare");
    if (!inner.ok) return inner;
    let rect = clipRect(shiftRect(inner.value.element!, -inner.value.viewport.x, -inner.value.viewport.y), inner.value.viewport);
    let child = route.frameId;
    for (let hops = 0; hops < FRAME_LIMITS.depth; hops++) {
      const parent = this.#frames.parentOf(tabId, child);
      const parentAlias = parent === null || parent === TOP_FRAME ? null : this.#frames.aliasOf(tabId, parent);
      if (parent === null || (parent !== TOP_FRAME && parentAlias === null)) break;
      const refPrefix = parentAlias === null ? "" : `f${parentAlias}:`;
      const outer = await this.#request<CaptureGeometry>(tabId, { type: "page.capture-prepare", frameId: parent, tabId, refPrefix, target: null, childFrameId: child }, "page.capture-prepare");
      if (!outer.ok) return outer;
      const box = outer.value.element!;
      // The child's viewport is drawn at its content box: move into the parent's document, keeping what the box shows.
      rect = intersectRect(shiftRect(rect, box.x, box.y), box);
      if (parent === TOP_FRAME) return { ok: true, value: { ...outer.value, element: rect } };
      rect = clipRect(shiftRect(rect, -outer.value.viewport.x, -outer.value.viewport.y), outer.value.viewport);
      child = parent;
    }
    return pageError("TARGET_MISSING", `Frame f${frame} is no longer where the latest outline showed it. Read a fresh snapshot.`);
  }

  /** One capture, falling back to briefly showing a hidden tab when the capture fails or comes out blank. */
  async #capture(tabId: number, options: CaptureOptions, capture: (tabId: number, options: CaptureOptions) => Promise<string>): Promise<string> {
    let first: string | null = null;
    try {
      first = await capture(tabId, options);
      if (!(await this.#isBlank(first))) return first;
    } catch {
      // Retried below if the tab is hidden.
    }
    const hidden = (await this.allTabs()).find((tab) => tab.id === tabId)?.hidden === true;
    if (!hidden || !this.#browserApi.tabs.show || !this.#browserApi.tabs.hide) {
      if (first !== null) return first;
      throw new Error("Capture failed.");
    }
    await this.#browserApi.tabs.show(tabId);
    try {
      return await capture(tabId, options);
    } finally {
      await this.#browserApi.tabs.hide(tabId).catch(() => []);
    }
  }

  /**
   * Forwards one DOM action to the top document (`frame` 0) or to the frame
   * of that name. A click/press that tears down the document settles like a
   * navigation instead of repeating.
   */
  async act(action: DomAction, frame = 0): Promise<ActionOutcome> {
    const tabId = this.#tabId;
    if (tabId === null) return { result: { ok: false, code: "UNSUPPORTED_PAGE", summary: "No page is attached." }, documentId: null };
    if (await this.#isPdf()) {
      return { result: { ok: false, code: "UNSUPPORTED_PAGE", summary: PDF_READ_ONLY }, documentId: null };
    }
    const route = this.#route(tabId, frame);
    if (!route) return { result: { ok: false, code: "TARGET_MISSING", summary: `Frame f${frame} is not on this page. Read a fresh snapshot.` }, documentId: null };
    const request: PageExecuteRequest = { v: 1, id: crypto.randomUUID(), type: "page.execute", frameId: route.frameId, tabId, refPrefix: route.refPrefix, action };

    let response: PageResponse | undefined;
    try {
      response = (await this.#browserApi.tabs.sendMessage(tabId, request, { frameId: route.frameId })) as PageResponse | undefined;
    } catch {
      if (frame !== 0) return this.#lostFrame(tabId, route.frameId, frame, action);
      if (action.kind !== "click" && action.kind !== "press") {
        return { result: { ok: false, code: "TAB_CHANGED", summary: "Lost contact with the page." }, documentId: null };
      }
      const settled = await this.#settleNavigation(tabId);
      if (!settled.ok) {
        return { result: { ok: false, code: "NAVIGATION_INTERRUPTED", summary: "The page did not settle after the action." }, documentId: null };
      }
      await this.#refreshMetadata(settled.value.url);
      return {
        result: { ok: true, summary: `${action.kind === "click" ? "Clicked" : `Pressed ${formatKeyChord(action.key, action.modifiers)}`}; the page navigated to ${this.#url} (${JSON.stringify(this.#title ?? "")}). Earlier refs are invalid; read a snapshot or use page.find().` },
        documentId: null,
      };
    }

    if (!response) return { result: { ok: false, code: "TAB_CHANGED", summary: "The page did not respond." }, documentId: null };
    if (!response.ok) return { result: { ok: false, code: toToolResultCode(response.error.code), summary: response.error.message }, documentId: null };
    if (response.type !== "page.execute") return { result: { ok: false, code: "TARGET_MISSING", summary: "Unexpected response from the page." }, documentId: null };
    // A frame's diff covers only that frame; what its click did to the page around it needs a fresh read.
    const outside = frame !== 0 && response.result.ok && (action.kind === "click" || action.kind === "press")
      ? `\nThe diff covers frame f${frame} only; read a snapshot to see changes elsewhere on the page.`
      : "";
    return { result: { ...response.result, summary: `${response.result.summary}${outside}` }, documentId: response.documentId };
  }

  /** Firefox's id and the ref prefix for a named frame (0 is the top document); null for a name no outline of this tab gave out. */
  #route(tabId: number, frame: number): { frameId: number; refPrefix: string } | null {
    if (frame === 0) return { frameId: TOP_FRAME, refPrefix: "" };
    const known = this.#frames.lookup(tabId, frame);
    return known ? { frameId: known.frameId, refPrefix: `f${frame}:` } : null;
  }

  /**
   * A frame stopped answering during an action. After a click or press it is
   * probed for a while: a frame that answers again navigated or reloaded;
   * one that never does is gone, and the action may or may not have happened.
   */
  async #lostFrame(tabId: number, frameId: number, frame: number, action: DomAction): Promise<ActionOutcome> {
    const lost = `Lost contact with frame f${frame}`;
    if (action.kind === "click" || action.kind === "press") {
      for (const delay of PROBE_DELAYS_MS.slice(0, 4)) {
        await sleep(delay);
        const health = await this.#probeHealth(tabId, frameId);
        if (health) {
          const verb = action.kind === "click" ? "Clicked" : `Pressed ${formatKeyChord(action.key, action.modifiers)}`;
          return { result: { ok: true, summary: `${verb}; frame f${frame} navigated to ${health.url}. Its earlier refs are invalid; read a snapshot.` }, documentId: null };
        }
      }
    }
    return { result: { ok: false, code: "TAB_CHANGED", summary: `${lost}: it navigated, reloaded, or was removed${action.kind === "click" || action.kind === "press" ? ", and the action may have taken effect" : ""}. Read a fresh snapshot.` }, documentId: null };
  }

  async navigate(url: string): Promise<ToolResult> {
    if (this.#tabId === null) return { ok: false, code: "UNSUPPORTED_PAGE", summary: "No page is attached." };
    if (!validateHttpUrl(url) || !isSupportedUrl(url)) return { ok: false, code: "INVALID_TOOL_ARGUMENTS", summary: "Expected a supported absolute HTTP(S) URL." };
    this.forgetPdf(this.#tabId);
    await this.#browserApi.tabs.update(this.#tabId, { url });
    return this.#afterNavigation("Navigated");
  }

  async goBack(): Promise<ToolResult> {
    if (this.#tabId === null) return { ok: false, code: "UNSUPPORTED_PAGE", summary: "No page is attached." };
    this.forgetPdf(this.#tabId);
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
    body: Omit<PageSnapshotRequest, "v" | "id"> | Omit<PageFindRequest, "v" | "id"> | Omit<PageOutlineRequest, "v" | "id"> | Omit<PageSearchResultsRequest, "v" | "id"> |
      Omit<PageCapturePrepareRequest, "v" | "id"> | Omit<PageTableRequest, "v" | "id"> | Omit<PageFetchPdfRequest, "v" | "id">,
    type: "page.snapshot" | "page.find" | "page.outline" | "page.search-results" | "page.capture-prepare" | "page.table" | "page.fetch-pdf",
  ): Promise<PageOutcome<T>> {
    const request = { v: 1, id: crypto.randomUUID(), ...body };
    let response: PageResponse | undefined;
    try {
      response = (await this.#browserApi.tabs.sendMessage(tabId, request, { frameId: request.frameId })) as PageResponse | undefined;
    } catch {
      return pageError("TAB_CHANGED", "The page is not available.");
    }
    if (!response) return pageError("TAB_CHANGED", "The page did not respond.");
    if (!response.ok) return { ok: false, error: response.error };
    if (response.type !== type) return pageError("TAB_CHANGED", "Unexpected response from the page.");
    if (response.type === "page.snapshot") return { ok: true, value: { snapshot: response.snapshot, frames: response.frames } as T };
    if (response.type === "page.find") return { ok: true, value: { result: response.result, frames: response.frames } as T };
    if (response.type === "page.outline") return { ok: true, value: response.outline as T };
    if (response.type === "page.search-results") return { ok: true, value: response.page as T };
    if (response.type === "page.capture-prepare") return { ok: true, value: response.geometry as T };
    if (response.type === "page.table") return { ok: true, value: response.table as T };
    if (response.type === "page.fetch-pdf") return { ok: true, value: response.result as T };
    return pageError("TAB_CHANGED", "Unexpected response from the page.");
  }

  /** Waits for `tabs.onUpdated` completion, then probes `page.health` on a backoff until the deadline. */
  async #settleNavigation(tabId: number, deadline = Date.now() + NAVIGATION_TIMEOUT_MS, complete = this.#waitForTabComplete(tabId, deadline)): Promise<PageOutcome<{ url: string }>> {
    await complete;

    for (const delay of PROBE_DELAYS_MS) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(delay, remaining));
      const health = await this.#probeHealth(tabId);
      if (health) return { ok: true, value: health };
      // Firefox's PDF viewer never answers; a URL naming a PDF is checked early, any other page once probing gives up.
      if (delay >= PROBE_DELAYS_MS[1]! && await this.#showsPdf(tabId, true)) return { ok: true, value: { url: await this.#currentUrl(tabId) } };
    }
    if (await this.#showsPdf(tabId)) return { ok: true, value: { url: await this.#currentUrl(tabId) } };
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

  async #currentUrl(tabId: number): Promise<string> {
    return (await this.allTabs()).find((tab) => tab.id === tabId)?.url ?? "";
  }

  async #probeHealth(tabId: number, frameId = TOP_FRAME): Promise<{ url: string } | null> {
    const request: PageHealthRequest = { v: 1, id: crypto.randomUUID(), type: "page.health", frameId };
    try {
      const response = (await this.#browserApi.tabs.sendMessage(tabId, request, { frameId })) as PageResponse | undefined;
      if (response?.ok && response.type === "page.health") return { url: response.url };
    } catch {
      // Content script not attached yet on the new document; keep probing.
    }
    return null;
  }
}

/** The document rectangle a screenshot covers, and whether it was cut at `FULL_PAGE_MAX_CSS`. */
function captureRect(geometry: CaptureGeometry, request: ScreenshotRequest): { rect: PageRect; cut: boolean } {
  const page = { x: 0, y: 0, width: Math.min(geometry.page.width, FULL_PAGE_MAX_CSS.width), height: Math.min(geometry.page.height, FULL_PAGE_MAX_CSS.height) };
  const area = geometry.element ?? (request.area === "full" ? page : geometry.viewport);
  const x = Math.max(0, Math.floor(area.x));
  const y = Math.max(0, Math.floor(area.y));
  const right = Math.min(Math.ceil(area.x + area.width), x + FULL_PAGE_MAX_CSS.width);
  const bottom = Math.min(Math.ceil(area.y + area.height), y + FULL_PAGE_MAX_CSS.height);
  const cut = (request.area === "full" && !geometry.element && (geometry.page.width > page.width || geometry.page.height > page.height)) ||
    (geometry.element !== null && (right < area.x + area.width || bottom < area.y + area.height));
  return { rect: { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }, cut };
}

function shiftRect(rect: PageRect, dx: number, dy: number): PageRect {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

/** The part of `rect` inside `other`; empty (zero-size) when they do not overlap. */
function intersectRect(rect: PageRect, other: PageRect): PageRect {
  const x = Math.max(rect.x, other.x);
  const y = Math.max(rect.y, other.y);
  return { x, y, width: Math.max(0, Math.min(rect.x + rect.width, other.x + other.width) - x), height: Math.max(0, Math.min(rect.y + rect.height, other.y + other.height) - y) };
}

/** The part of a viewport-relative rect inside a viewport of that size. */
function clipRect(rect: PageRect, viewport: PageRect): PageRect {
  return intersectRect(rect, { x: 0, y: 0, width: viewport.width, height: viewport.height });
}

/** The base64 bytes of a `data:image/…;base64,` URL in the requested format, and their decoded size. */
function parseImageDataUrl(dataUrl: unknown, format: "jpeg" | "png"): { mimeType: "image/jpeg" | "image/png"; data: string; bytes: number } | null {
  const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
  const prefix = `data:${mimeType};base64,`;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) return null;
  const data = dataUrl.slice(prefix.length);
  const bytes = base64Bytes(data);
  return bytes ? { mimeType, data, bytes } : null;
}

/**
 * Whether an image is one flat color, sampled at 8×8. Needs the background
 * page's `createImageBitmap` and `OffscreenCanvas`; elsewhere it answers false.
 */
async function isBlankImage(dataUrl: string): Promise<boolean> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return false;
  try {
    const [header, data] = dataUrl.split(",", 2);
    const bytes = Uint8Array.from(atob(data ?? ""), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: /^data:([^;]+)/.exec(header ?? "")?.[1] ?? "image/png" }));
    const canvas = new OffscreenCanvas(8, 8);
    const context = canvas.getContext("2d");
    if (!context) return false;
    context.drawImage(bitmap, 0, 0, 8, 8);
    bitmap.close();
    const pixels = context.getImageData(0, 0, 8, 8).data;
    for (let i = 4; i < pixels.length; i += 4) {
      for (let channel = 0; channel < 3; channel++) if (Math.abs(pixels[i + channel]! - pixels[channel]!) > 2) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isAgentTabTag(value: unknown): value is AgentTabTagV2 | AgentTabTagV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.v === 1 || (v.v === 2 && isSessionId(v.sessionId))) && (AGENT_TAB_ROLES as readonly unknown[]).includes(v.role) &&
    typeof v.lastUsedAt === "number" && Number.isFinite(v.lastUsedAt);
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

function pdfKey(tabId: number, url: string): string {
  return `tab ${tabId} ${url}`;
}

/** A PDF's document id: the same text at the same URL is the same document. */
function pdfDocumentId(url: string, pdf: PdfText): string {
  return `pdf-${hashText(`${url}\n${pdf.pages}\n${pdf.pageTexts.join("\f")}`)}`;
}

/** FNV-1a, as eight hex digits. */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function clipUrl(url: string): string {
  return url.length > 200 ? `${url.slice(0, 199)}…` : url;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
