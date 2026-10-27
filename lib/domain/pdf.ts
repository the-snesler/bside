/**
 * PDF text, as bside reads it from a tab showing Firefox's PDF viewer or from
 * a `/workspace/*.pdf` file. pdf.js (bundled, in its own worker) extracts the
 * text within `PDF_LIMITS`; the tab's snapshot and `fs.read` render it with
 * `renderPdfText`. PDFs are read-only: no refs, no actions.
 */

export const PDF_LIMITS = {
  /** Largest PDF bside fetches or reads, in bytes. */
  bytes: 20_000_000,
  /** Pages whose text is extracted; later pages are listed as not read. */
  pages: 200,
  /** Characters of text kept per page. */
  charsPerPage: 20_000,
  /** Characters of text kept in all. */
  chars: 300_000,
};
/** How long fetching a PDF, and extracting its text, may each take. */
export const PDF_TIMEOUT_MS = 30_000;

export interface PdfText {
  /** Pages in the document. */
  pages: number;
  /** Text of the extracted pages, in order: at most `PDF_LIMITS.pages`, fewer when `cut`. */
  pageTexts: string[];
  /** The document's own title, if it has one. */
  title: string;
  /** Whether text was left out at `PDF_LIMITS.chars` or `charsPerPage`. */
  cut: boolean;
}

/** Whether a URL's path names a PDF (`/a/report.pdf`); others are recognized by their bytes. */
export function looksLikePdfUrl(url: string): boolean {
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Whether bytes are a PDF: the `%PDF-` header within the first 1024 bytes, as readers accept it. */
export function isPdfHeader(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 1024) - 5;
  for (let i = 0; i <= end; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) return true;
  }
  return false;
}

/** The text form of a PDF, one block per page, as outline text for a snapshot or `fs.read`. */
export function renderPdfText(pdf: PdfText): string {
  const lines = [`PDF: ${pdf.pages} page${pdf.pages === 1 ? "" : "s"}${pdf.title ? ` · ${pdf.title}` : ""}`];
  if (!pdf.pageTexts.some((text) => text.trim())) {
    lines.push("", "This PDF has no extractable text; its pages may be scanned images.");
  }
  pdf.pageTexts.forEach((text, index) => {
    lines.push("", `--- Page ${index + 1} ---`, text.trim() || "(no text on this page)");
  });
  if (pdf.pageTexts.length < pdf.pages) {
    lines.push("", `[Pages ${pdf.pageTexts.length + 1}–${pdf.pages} not read: ${pdf.cut ? `the text limit (${PDF_LIMITS.chars.toLocaleString("en-US")} characters) was reached` : `bside reads at most ${PDF_LIMITS.pages} pages`}.]`);
  } else if (pdf.cut) {
    lines.push("", `[Some page text was cut at ${PDF_LIMITS.charsPerPage.toLocaleString("en-US")} characters per page.]`);
  }
  return lines.join("\n");
}

/** What the background posts to the `pdf-text` worker (one PDF per worker), and its one answer. */
export interface PdfWorkerRequest {
  data: ArrayBuffer;
}
export type PdfWorkerResponse = { ok: true; pdf: PdfText } | { ok: false; message: string };

/**
 * What a content script reports after fetching a PDF for a tab showing it in
 * Firefox's viewer (`page.fetch-pdf`): the bytes as base64, or why not.
 */
export type PdfFetchResult =
  | { kind: "pdf"; base64: string; bytes: number }
  | { kind: "not-pdf" }
  | { kind: "too-large" }
  | { kind: "failed"; status: number | null };

/** A PDF failure whose message is safe to show the model. */
export class PdfError extends Error {}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
