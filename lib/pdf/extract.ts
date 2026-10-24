/**
 * PDF text extraction with the bundled pdf.js. It runs where it is imported:
 * in the extension that is the `pdf-text` worker (`entrypoints/pdf-text.ts`),
 * so parsing never blocks the background page. pdf.js's own worker code runs
 * in the same thread (`globalThis.pdfjsWorker`), so nothing is loaded from a
 * URL. No fonts, images, or canvases are touched: only the text layer.
 */

import { getDocument, PasswordException } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { PDF_LIMITS, PdfError, type PdfText } from "@/lib/domain/pdf";

(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

export async function extractPdfText(data: Uint8Array): Promise<PdfText> {
  if (data.byteLength > PDF_LIMITS.bytes) throw new PdfError(`The PDF is larger than ${PDF_LIMITS.bytes.toLocaleString("en-US")} bytes.`);
  const task = getDocument({
    data,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  try {
    let document;
    try {
      document = await task.promise;
    } catch (error) {
      throw new PdfError(error instanceof PasswordException ? "The PDF is password-protected." : "The file is not a readable PDF.");
    }
    const info = (await document.getMetadata().catch(() => null))?.info as { Title?: unknown } | undefined;
    const pageTexts: string[] = [];
    let total = 0;
    let cut = false;
    for (let number = 1; number <= Math.min(document.numPages, PDF_LIMITS.pages); number++) {
      if (total >= PDF_LIMITS.chars) {
        cut = true;
        break;
      }
      let text = "";
      try {
        const page = await document.getPage(number);
        text = pageText((await page.getTextContent()).items);
        page.cleanup();
      } catch {
        text = "(this page could not be read)";
      }
      const allowed = Math.min(PDF_LIMITS.charsPerPage, PDF_LIMITS.chars - total);
      if (text.length > allowed) {
        text = `${text.slice(0, allowed)}…`;
        cut = true;
      }
      pageTexts.push(text);
      total += text.length;
    }
    const title = typeof info?.Title === "string" ? info.Title.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    return { pages: document.numPages, pageTexts, title, cut };
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** A page's text items joined into lines: pdf.js marks line ends (`hasEOL`); runs of blank lines collapse. */
function pageText(items: readonly unknown[]): string {
  let text = "";
  for (const item of items) {
    if (!item || typeof item !== "object" || typeof (item as { str?: unknown }).str !== "string") continue;
    const { str, hasEOL } = item as { str: string; hasEOL?: boolean };
    text += str;
    if (hasEOL) text += "\n";
  }
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}
