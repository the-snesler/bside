/**
 * Keeps the files tabs bside controls load, instead of letting Firefox
 * download them to the user's Downloads folder or show them in a viewer no
 * content script can read.
 *
 * A tab is watched while someone holds it (`watch`): bside's agent tabs for
 * as long as they are its own, and a user's tab while a run's action or
 * navigation in it settles. A watched tab gets its own `webRequest` listeners
 * (filtered by `tabId`), so nothing else ever reaches them.
 *
 * In a watched tab, a successful main-frame response that is not a web page
 * (`isPageContentType`), or any `Content-Disposition: attachment` response in
 * a frame, is a file. Its headers are rewritten to show it as a document
 * (`Content-Disposition`, `Content-Length`, and `X-Content-Type-Options`
 * removed, `Content-Type: text/css`), and `filterResponseData` reads its body:
 *
 * - `text/css`, not `text/plain`: Firefox checks the raw bytes of `text/plain`
 *   for binary content in its network layer, before any extension filter,
 *   and hands binaries to the download manager. It displays `text/css`
 *   whatever the bytes are, and content scripts run in it.
 * - Text is written through, so the tab shows it; for anything else the tab
 *   shows one line saying bside kept it. The bytes go only to bside.
 * - Past `FILE_LIMITS.bytes` the tab gets a notice and nothing is kept.
 *
 * The filter receives the body already decoded (gzip and so on). A captured
 * file is cached as the tab's file (`TabFiles`), and queued for the run's
 * program to keep in `/workspace/downloads` (`take`).
 */

import { FILE_LIMITS, FileError, fileNameFor, isPageContentType } from "@/lib/domain/files";
import { tabFileKey, type LoadedFile, type TabFiles } from "@/lib/background/tab-files";

/** The part of Firefox's `StreamFilter` the guard uses. */
export interface StreamFilterLike {
  ondata: ((event: { data: ArrayBuffer }) => void) | null;
  onstop: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  write(data: ArrayBuffer | Uint8Array): void;
  close(): void;
}

export interface HeadersReceivedDetails {
  requestId: string;
  url: string;
  type: string;
  tabId: number;
  statusCode: number;
  responseHeaders?: { name: string; value?: string }[];
}

type HeadersListener = (details: HeadersReceivedDetails) => { responseHeaders?: { name: string; value?: string }[] } | undefined;
type RequestListener = (details: { requestId: string; type: string; tabId: number }) => void;
type RequestFilter = { urls: string[]; types: string[]; tabId: number };

/** The part of Firefox's `webRequest` the guard uses (`webRequestBlocking` and host permissions). */
export interface FileGuardWebRequest {
  onBeforeRequest: { addListener(listener: RequestListener, filter: RequestFilter): void; removeListener(listener: RequestListener): void };
  onHeadersReceived: { addListener(listener: HeadersListener, filter: RequestFilter, extra: string[]): void; removeListener(listener: HeadersListener): void };
  onErrorOccurred: { addListener(listener: RequestListener, filter: RequestFilter): void; removeListener(listener: RequestListener): void };
  filterResponseData(requestId: string): StreamFilterLike;
}

/** A file the guard captured in a tab, once its body ended, or why it was not kept. */
export type CapturedFile = { ok: true; frame: "main" | "sub"; file: LoadedFile } | { ok: false; frame: "main" | "sub"; url: string; reason: string };

/** Captured files each tab holds until a program takes them; older ones are dropped. */
const QUEUED_PER_TAB = 8;
/** How long a capture may take before `take` gives up on it. */
const CAPTURE_TIMEOUT_MS = 30_000;

interface WatchedTab {
  holds: number;
  headers: HeadersListener;
  before: RequestListener;
  error: RequestListener;
  /** Main-frame requests that started and have not answered yet. */
  inFlight: Set<string>;
  /** Waiters for `inFlight` to empty. */
  quiet: (() => void)[];
}

export class FileGuard {
  readonly #webRequest: FileGuardWebRequest | null;
  readonly #files: TabFiles;
  #tabs = new Map<number, WatchedTab>();
  #captured = new Map<number, Promise<CapturedFile>[]>();

  constructor(webRequest: FileGuardWebRequest | null, files: TabFiles) {
    this.#webRequest = webRequest;
    this.#files = files;
  }

  /** Whether the guard can act at all (Firefox's `webRequest` with `filterResponseData`). */
  get available(): boolean {
    return this.#webRequest !== null;
  }

  /**
   * Watches `tabId` until the returned release runs (idempotent). Holds nest:
   * the tab stays watched until every holder released it. Listeners are added
   * synchronously, so a load started right after is seen.
   */
  watch(tabId: number): () => void {
    const webRequest = this.#webRequest;
    if (!webRequest) return () => {};
    let tab = this.#tabs.get(tabId);
    if (!tab) {
      const filter = (types: string[]) => ({ urls: ["<all_urls>"], types, tabId });
      const watched: WatchedTab = {
        holds: 0, inFlight: new Set(), quiet: [],
        headers: (details) => this.#onHeaders(watched, details),
        before: (details) => { if (details.type === "main_frame") watched.inFlight.add(details.requestId); },
        error: (details) => this.#settled(watched, details.requestId),
      };
      tab = watched;
      this.#tabs.set(tabId, tab);
      webRequest.onBeforeRequest.addListener(tab.before, filter(["main_frame"]));
      webRequest.onHeadersReceived.addListener(tab.headers, filter(["main_frame", "sub_frame"]), ["blocking", "responseHeaders"]);
      webRequest.onErrorOccurred.addListener(tab.error, filter(["main_frame"]));
    }
    const held = tab;
    held.holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      held.holds -= 1;
      if (held.holds === 0 && this.#tabs.get(tabId) === held) this.#unwatch(tabId, held);
    };
  }

  /** Whether `tabId` is watched now. */
  watching(tabId: number): boolean {
    return this.#tabs.has(tabId);
  }

  /**
   * Waits (up to `timeoutMs`) until no main-frame request in the tab is
   * waiting for its answer, so a click that starts a download has its file
   * response seen before the action reports.
   */
  async quiet(tabId: number, timeoutMs: number): Promise<void> {
    const tab = this.#tabs.get(tabId);
    if (!tab || tab.inFlight.size === 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      tab.quiet.push(done);
    });
  }

  /** The files captured in a tab since the last take, each once its body ended (or failed). */
  async take(tabId: number): Promise<CapturedFile[]> {
    const queued = this.#captured.get(tabId) ?? [];
    this.#captured.delete(tabId);
    return Promise.all(queued.map((capture) => withTimeout(capture, CAPTURE_TIMEOUT_MS)));
  }

  /** The tab closed: stop watching it and drop what it captured. */
  forget(tabId: number): void {
    const tab = this.#tabs.get(tabId);
    if (tab) this.#unwatch(tabId, tab);
    this.#captured.delete(tabId);
  }

  #unwatch(tabId: number, tab: WatchedTab): void {
    const webRequest = this.#webRequest!;
    webRequest.onBeforeRequest.removeListener(tab.before);
    webRequest.onHeadersReceived.removeListener(tab.headers);
    webRequest.onErrorOccurred.removeListener(tab.error);
    this.#tabs.delete(tabId);
    for (const done of tab.quiet.splice(0)) done();
  }

  #settled(tab: WatchedTab, requestId: string): void {
    tab.inFlight.delete(requestId);
    if (tab.inFlight.size === 0) for (const done of tab.quiet.splice(0)) done();
  }

  #onHeaders(tab: WatchedTab, details: HeadersReceivedDetails): { responseHeaders?: { name: string; value?: string }[] } | undefined {
    if (details.type === "main_frame") this.#settled(tab, details.requestId);
    const headers = details.responseHeaders ?? [];
    const header = (name: string) => headers.find((candidate) => candidate.name.toLowerCase() === name)?.value ?? null;
    const contentType = header("content-type");
    const disposition = header("content-disposition");
    const attachment = /^\s*attachment\b/i.test(disposition ?? "");
    // Redirects, errors, and empty answers are the page's business; only a body that is a file is kept.
    if (details.statusCode < 200 || details.statusCode > 299 || details.statusCode === 204 || details.statusCode === 205) return undefined;
    const main = details.type === "main_frame";
    if (main ? !attachment && isPageContentType(contentType) : !attachment) return undefined;
    let filter: StreamFilterLike;
    try {
      filter = this.#webRequest!.filterResponseData(details.requestId);
    } catch {
      return undefined;
    }
    const frame = main ? "main" : "sub";
    const capture = this.#capture(filter, details.url, contentType, disposition);
    const queue = this.#captured.get(details.tabId) ?? [];
    queue.push(capture.then((file): CapturedFile => file.ok ? { ok: true, frame, file: file.file } : { ok: false, frame, url: details.url, reason: file.reason }));
    this.#captured.set(details.tabId, queue.slice(-QUEUED_PER_TAB));
    if (main) {
      this.#files.put(tabFileKey(details.tabId, details.url), capture.then((file) => {
        if (!file.ok) throw new FileError(file.reason);
        return file.file;
      }));
    }
    const kept = headers.filter((candidate) => !["content-disposition", "content-type", "content-length", "x-content-type-options"].includes(candidate.name.toLowerCase()));
    return { responseHeaders: [...kept, { name: "Content-Type", value: "text/css; charset=utf-8" }] };
  }

  /** Reads a file's body through `filter`: text passes through to the tab, anything else is replaced by a notice. */
  #capture(filter: StreamFilterLike, url: string, contentType: string | null, disposition: string | null): Promise<{ ok: true; file: LoadedFile } | { ok: false; reason: string }> {
    return new Promise((resolve) => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      let shown: boolean | null = null;
      let done = false;
      const finish = (result: { ok: true; file: LoadedFile } | { ok: false; reason: string }, notice?: string) => {
        if (done) return;
        done = true;
        try {
          if (notice) filter.write(new TextEncoder().encode(notice));
          filter.close();
        } catch {
          // The request is gone; the result stands.
        }
        resolve(result);
      };
      filter.ondata = (event) => {
        if (done) return;
        const bytes = new Uint8Array(event.data);
        total += bytes.length;
        if (total > FILE_LIMITS.bytes) {
          chunks.length = 0;
          const reason = `The file is larger than ${FILE_LIMITS.bytes.toLocaleString("en-US")} bytes, so bside did not keep it.`;
          finish({ ok: false, reason }, `\n${reason}\n`);
          return;
        }
        chunks.push(bytes);
        if (shown === null) {
          shown = looksLikeText(bytes);
          if (!shown) filter.write(new TextEncoder().encode(`bside kept this file (${contentType?.split(";", 1)[0]?.trim() || "unknown type"}) instead of downloading it.\n`));
        }
        if (shown) filter.write(bytes);
      };
      filter.onstop = () => finish({ ok: true, file: { url, data: join(chunks, total), contentType, name: fileNameFor(url, disposition) } });
      filter.onerror = () => finish({ ok: false, reason: "The file stopped loading before it ended." });
    });
  }
}

/** Whether a file's first bytes can be shown as text: no NUL bytes, not a PDF, and valid UTF-8 so far. */
function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 1024);
  if (head.includes(0)) return false;
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

function join(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function withTimeout(capture: Promise<CapturedFile>, ms: number): Promise<CapturedFile> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, frame: "main", url: "", reason: "The file took too long to load." }), ms);
    capture.then((file) => { clearTimeout(timer); resolve(file); });
  });
}
