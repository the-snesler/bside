/**
 * The files tabs show, as the background reads them: a tab showing a file
 * instead of a web page (Firefox's JSON, XML, text, or PDF viewer, or a
 * download bside's `FileGuard` turned into a document) reads as that file.
 * Its bytes come from the guard, which captured the tab's own response, or
 * from another tab's content script (`TabController`); `/workspace` PDFs come
 * from their files. Classified once (`classifyFile`): a PDF's text is
 * extracted in a `pdf-text` worker, text is decoded, anything else is kept
 * as bytes. A few are cached at a time, so paging through one reads it once.
 */

import { classifyFile, FILE_LIMITS, FileError, isPageContentType } from "@/lib/domain/files";
import { PDF_LIMITS, PdfError, type PdfText } from "@/lib/domain/pdf";
import { unavailablePdfExtractor, type PdfExtractor } from "@/lib/background/pdf";

/** A file's bytes as fetched or captured, with the headers that describe it. */
export interface LoadedFile {
  /** The URL it came from (after redirects). */
  url: string;
  data: Uint8Array;
  /** Its declared Content-Type, if any. */
  contentType: string | null;
  /** Its name: from Content-Disposition, else the URL (see `fileNameFor`). */
  name: string;
}

/** A file a tab shows, read: a PDF's text, decoded text, or a file bside cannot read (only kept). */
export interface TabFile {
  url: string;
  name: string;
  mimeType: string;
  bytes: number;
  data: Uint8Array;
  body: { kind: "pdf"; pdf: PdfText } | { kind: "text"; text: string } | { kind: "binary" };
}

/** Files that stay cached, and the bytes they may hold together. */
const CACHED_FILES = 8;
const CACHED_BYTES = 60_000_000;

export class TabFiles {
  readonly #extract: PdfExtractor;
  /** The file (or null: a web page, not a file) by key, oldest first; pending reads are shared. */
  #files = new Map<string, Promise<TabFile | null>>();
  /** Bytes held by each settled file, for the cache's byte bound. */
  #sizes = new Map<string, number>();

  constructor(extract: PdfExtractor = unavailablePdfExtractor) {
    this.#extract = extract;
  }

  /** A tab's document changed, even if its URL stayed the same; `keep` names a key to leave (the file the tab just loaded). */
  forgetTab(tabId: number, keep?: string): void {
    for (const key of [...this.#files.keys()]) {
      if (key.startsWith(`tab ${tabId} `) && key !== keep) this.#delete(key);
    }
  }

  /** Whether anything (a file, a web page, or a read in progress) is cached under `key`. */
  has(key: string): boolean {
    return this.#files.has(key);
  }

  /**
   * The file `load` yields, cached under `key`. `load` returns null for
   * something that is not a file (a web page), remembered like a file; so is
   * a loaded HTML response. A failure (thrown as `FileError` or `PdfError`,
   * safe to show) is not cached.
   */
  read(key: string, load: () => Promise<LoadedFile | null>): Promise<TabFile | null> {
    const cached = this.#files.get(key);
    if (cached) {
      this.#files.delete(key);
      this.#files.set(key, cached);
      return cached;
    }
    return this.#store(key, load());
  }

  /** Caches a file the guard is capturing under `key`, replacing anything there; `loading` rejects (`FileError`) when the capture failed. */
  put(key: string, loading: Promise<LoadedFile | null>): void {
    this.#delete(key);
    this.#store(key, loading).catch(() => {});
  }

  /** The cached file under `key`, if it has been read and is a file. */
  async cached(key: string): Promise<TabFile | null> {
    const pending = this.#files.get(key);
    return pending ? pending.catch(() => null) : null;
  }

  /** The text of a PDF held in bytes (a `/workspace` file), cached by its content; null when it is not a PDF. */
  async pdfText(key: string, data: Uint8Array): Promise<PdfText | null> {
    const file = await this.read(key, async () => ({ url: "", data, contentType: "application/pdf", name: "file.pdf" }));
    return file?.body.kind === "pdf" ? file.body.pdf : null;
  }

  #store(key: string, loading: Promise<LoadedFile | null>): Promise<TabFile | null> {
    const pending = loading.then((loaded) => this.#open(loaded));
    this.#files.set(key, pending);
    pending.then((file) => {
      if (this.#files.get(key) !== pending) return;
      this.#sizes.set(key, file?.bytes ?? 0);
      this.#trim();
    }, () => {
      if (this.#files.get(key) === pending) this.#delete(key);
    });
    this.#trim();
    return pending;
  }

  async #open(loaded: LoadedFile | null): Promise<TabFile | null> {
    if (loaded === null || isPageContentType(loaded.contentType)) return null;
    const { data } = loaded;
    if (data.byteLength > FILE_LIMITS.bytes) throw new FileError(`It is larger than ${FILE_LIMITS.bytes.toLocaleString("en-US")} bytes.`);
    const { mimeType, text } = classifyFile(data, loaded.contentType);
    const file = { url: loaded.url, name: loaded.name, mimeType, bytes: data.byteLength, data };
    if (mimeType === "application/pdf") {
      if (data.byteLength > PDF_LIMITS.bytes) throw new PdfError(`The PDF is larger than ${PDF_LIMITS.bytes.toLocaleString("en-US")} bytes.`);
      // A copy: an extractor may take over the bytes it reads, and the file keeps its own.
      return { ...file, body: { kind: "pdf", pdf: await this.#extract(data.slice()) } };
    }
    return { ...file, body: text === null ? { kind: "binary" } : { kind: "text", text } };
  }

  /** Drops the oldest files past the count or byte bound. */
  #trim(): void {
    let total = [...this.#sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
    while (this.#files.size > CACHED_FILES || (total > CACHED_BYTES && this.#files.size > 1)) {
      const oldest = this.#files.keys().next().value!;
      total -= this.#sizes.get(oldest) ?? 0;
      this.#delete(oldest);
    }
  }

  #delete(key: string): void {
    this.#files.delete(key);
    this.#sizes.delete(key);
  }
}

/** The cache key of the file a tab shows at a URL. */
export function tabFileKey(tabId: number, url: string): string {
  return `tab ${tabId} ${url}`;
}
