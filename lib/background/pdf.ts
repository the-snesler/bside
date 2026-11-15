/**
 * Extracts a PDF's text for the background (`TabFiles` caches the results):
 * a fresh `pdf-text` worker per PDF (`workerPdfExtractor`), so the bundled
 * pdf.js never loads into the background page.
 */

import { PDF_LIMITS, PDF_TIMEOUT_MS, PdfError, type PdfText, type PdfWorkerRequest, type PdfWorkerResponse } from "@/lib/domain/pdf";

export type PdfExtractor = (data: Uint8Array) => Promise<PdfText>;

/** Where no worker can run (tests that read no PDF): every PDF fails to read. */
export const unavailablePdfExtractor: PdfExtractor = async () => {
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
    worker.onmessage = (event: MessageEvent<PdfWorkerResponse | { sourceName: string; targetName: string; action: string }>) => {
      const answer = event.data;
      // The bundled pdf.js auto-initializes in a browser worker and announces readiness before our result.
      if (answer && "sourceName" in answer && answer.sourceName === "worker" && answer.targetName === "main" && answer.action === "ready") return;
      finish(() => {
        if (answer && "ok" in answer && answer.ok === true && isPdfText(answer.pdf)) resolve(answer.pdf);
        else reject(new PdfError(answer && "ok" in answer && answer.ok === false && typeof answer.message === "string" ? answer.message.slice(0, 200) : "The PDF could not be read."));
      });
    };
    worker.onerror = () => finish(() => reject(new PdfError("The PDF reader stopped unexpectedly.")));
    // A copy, transferred: the worker owns it, and the caller's bytes stay usable.
    const buffer = data.slice().buffer;
    worker.postMessage({ data: buffer } satisfies PdfWorkerRequest, [buffer]);
  });
}

function isPdfText(value: unknown): value is PdfText {
  if (!value || typeof value !== "object") return false;
  const pdf = value as Record<string, unknown>;
  return Number.isSafeInteger(pdf.pages) && (pdf.pages as number) >= 0 && typeof pdf.title === "string" && typeof pdf.cut === "boolean" &&
    Array.isArray(pdf.pageTexts) && pdf.pageTexts.length <= PDF_LIMITS.pages && pdf.pageTexts.every((text) => typeof text === "string") &&
    pdf.pageTexts.reduce((total: number, text: string) => total + text.length, 0) <= PDF_LIMITS.chars + PDF_LIMITS.pages;
}
