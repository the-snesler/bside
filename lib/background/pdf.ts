/**
 * Reads PDFs for the background: tabs showing one in Firefox's viewer (bytes
 * fetched by `TabController`) and `/workspace/*.pdf` files. Text extraction
 * runs in a fresh `pdf-text` worker per PDF (`workerPdfExtractor`), so the
 * bundled pdf.js never loads into the background page. Texts are cached by
 * key, a few at a time, so reading a long PDF page by page parses it once.
 */

import { PDF_LIMITS, PDF_TIMEOUT_MS, PdfError, type PdfText, type PdfWorkerRequest, type PdfWorkerResponse } from "@/lib/domain/pdf";

export type PdfExtractor = (data: Uint8Array) => Promise<PdfText>;

/** PDFs whose text stays cached. */
const CACHED_PDFS = 8;

const unavailable: PdfExtractor = async () => {
  throw new PdfError("PDF reading is unavailable here.");
};

/** Extracts each PDF in a new worker, ended when it answers, fails, or takes longer than `PDF_TIMEOUT_MS`. */
export function workerPdfExtractor(createWorker: () => Worker): PdfExtractor {
  return (data) => new Promise<PdfText>((resolve, reject) => {
    const worker = createWorker();
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      worker.terminate();
      settle();
    };
    const timer = setTimeout(() => finish(() => reject(new PdfError("Reading the PDF took too long."))), PDF_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<PdfWorkerResponse>) => finish(() => {
      const answer = event.data;
      if (answer?.ok === true && isPdfText(answer.pdf)) resolve(answer.pdf);
      else reject(new PdfError(answer?.ok === false && typeof answer.message === "string" ? answer.message.slice(0, 200) : "The PDF could not be read."));
    });
    worker.onerror = () => finish(() => reject(new PdfError("The PDF reader stopped unexpectedly.")));
    // A copy, transferred: the worker owns it, and the caller's bytes stay usable.
    const buffer = data.slice().buffer;
    worker.postMessage({ data: buffer } satisfies PdfWorkerRequest, [buffer]);
  });
}

export class PdfReader {
  readonly #extract: PdfExtractor;
  /** Text (or null: not a PDF) by key, oldest first; pending reads are shared. */
  #texts = new Map<string, Promise<PdfText | null>>();

  constructor(extract: PdfExtractor = unavailable) {
    this.#extract = extract;
  }

  /**
   * The text of the PDF `load` yields, cached under `key`. `load` returns
   * null for something that is not a PDF, remembered like a text. A failure
   * (thrown as `PdfError`, safe to show) is not cached.
   */
  read(key: string, load: () => Promise<Uint8Array | null>): Promise<PdfText | null> {
    const cached = this.#texts.get(key);
    if (cached) {
      this.#texts.delete(key);
      this.#texts.set(key, cached);
      return cached;
    }
    const pending = (async () => {
      const data = await load();
      if (data === null) return null;
      if (data.byteLength > PDF_LIMITS.bytes) throw new PdfError(`The PDF is larger than ${PDF_LIMITS.bytes.toLocaleString("en-US")} bytes.`);
      return this.#extract(data);
    })();
    this.#texts.set(key, pending);
    pending.catch(() => {
      if (this.#texts.get(key) === pending) this.#texts.delete(key);
    });
    while (this.#texts.size > CACHED_PDFS) this.#texts.delete(this.#texts.keys().next().value!);
    return pending;
  }

  /** The cached text under `key`, if it has been read and is a PDF. */
  async cached(key: string): Promise<PdfText | null> {
    const pending = this.#texts.get(key);
    return pending ? pending.catch(() => null) : null;
  }
}

function isPdfText(value: unknown): value is PdfText {
  if (!value || typeof value !== "object") return false;
  const pdf = value as Record<string, unknown>;
  return Number.isSafeInteger(pdf.pages) && (pdf.pages as number) >= 0 && typeof pdf.title === "string" && typeof pdf.cut === "boolean" &&
    Array.isArray(pdf.pageTexts) && pdf.pageTexts.length <= PDF_LIMITS.pages && pdf.pageTexts.every((text) => typeof text === "string") &&
    pdf.pageTexts.reduce((total: number, text: string) => total + text.length, 0) <= PDF_LIMITS.chars + PDF_LIMITS.pages;
}
