/**
 * Files bside reads or keeps from the web: a tab showing something that is
 * not a web page (JSON, XML, plain text, a CSV, an image, an archive, a PDF),
 * a download a page started, or a URL fetched with `browser.download`.
 *
 * Nothing here keeps a list of file types. A response is a web page when it
 * is HTML or XHTML (`isPageContentType`), else it is a file. A file is text
 * when its bytes decode cleanly in its declared charset (UTF-8 if none) and
 * hold no NUL bytes (`decodeText`): what `cat` could show. Anything else is
 * kept as it is, and reading it says bside cannot.
 */

import { attachmentName, detectFileType } from "@/lib/domain/attachments";
import { isMimeType, VIEWABLE_IMAGE_TYPES } from "@/lib/validation";

export const FILE_LIMITS = {
  /** Largest file bside fetches, captures from a tab, or reads, in bytes (a PDF's limit too). */
  bytes: 20_000_000,
};
/** How long fetching a file may take. */
export const FILE_TIMEOUT_MS = 30_000;

/** What a content script reports after fetching a file (`page.fetch-file`, or a download link it was asked to click): the bytes as base64, or why not. */
export type FileFetchResult =
  | { kind: "file"; base64: string; bytes: number; contentType: string | null; name: string | null; url: string }
  | { kind: "too-large" }
  | { kind: "failed"; status: number | null };

/** A file failure whose message is safe to show the model. */
export class FileError extends Error {}

/** The type and subtype of a Content-Type, lowercase, without parameters; "" when there is none. */
export function mediaType(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

/** Whether a Content-Type (or `document.contentType`) is a web page bside reads as an outline: HTML or XHTML. Everything else is a file. */
export function isPageContentType(contentType: string | null | undefined): boolean {
  const type = mediaType(contentType);
  return type === "text/html" || type === "application/xhtml+xml";
}

/** The `charset` parameter of a Content-Type, if any. */
function charsetOf(contentType: string | null | undefined): string | null {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? "");
  return match ? match[1]!.toLowerCase() : null;
}

/**
 * The bytes as text when they are text: no NUL bytes, and they decode without
 * error in the declared charset (UTF-8 when none is declared or the label is
 * unknown). A byte-order mark is dropped. Null for anything else.
 */
export function decodeText(bytes: Uint8Array, contentType: string | null | undefined): string | null {
  if (bytes.includes(0)) return null;
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(charsetOf(contentType) ?? "utf-8", { fatal: true }); }
  catch { decoder = new TextDecoder("utf-8", { fatal: true }); }
  try { return decoder.decode(bytes); }
  catch { return null; }
}

/** The types bside recognizes by their bytes (`detectFileType`): a PDF, and the images `fs.view` shows. */
const SIGNATURE_TYPES: readonly string[] = ["application/pdf", ...VIEWABLE_IMAGE_TYPES];

/**
 * What a fetched file is: its type (a PDF or image signature wins over the
 * declared type, as for the user's attachments; else the declared type when
 * it is a valid MIME type; else `text/plain` or `application/octet-stream`)
 * and its text, or null when it is not text.
 */
export function classifyFile(bytes: Uint8Array, contentType: string | null | undefined): { mimeType: string; text: string | null } {
  const declared = mediaType(contentType);
  const detected = detectFileType(bytes, declared);
  if (SIGNATURE_TYPES.includes(detected.mimeType) && !detected.text) return { mimeType: detected.mimeType, text: null };
  const text = decodeText(bytes, contentType);
  const mimeType = isMimeType(declared) && !SIGNATURE_TYPES.includes(declared) ? declared : text !== null ? "text/plain" : "application/octet-stream";
  return { mimeType, text };
}

/**
 * The name a file keeps: the Content-Disposition `filename*` (RFC 5987),
 * else its `filename`, else the URL's last path segment, else `download`;
 * cleaned like an attachment's name.
 */
export function fileNameFor(url: string, disposition: string | null | undefined): string {
  return attachmentName(dispositionName(disposition ?? "") ?? urlName(url) ?? "download");
}

function dispositionName(disposition: string): string | null {
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(disposition);
  if (extended) {
    try { return decodeURIComponent(extended[2]!.trim()); }
    catch { /* Fall back to the plain parameter. */ }
  }
  const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(disposition);
  const name = plain ? (plain[1]?.replace(/\\(.)/g, "$1") ?? plain[2]!.trim()) : "";
  return name.trim() || null;
}

function urlName(url: string): string | null {
  try {
    const segment = new URL(url).pathname.split("/").pop() ?? "";
    return decodeURIComponent(segment).trim() || null;
  } catch {
    return null;
  }
}

/** Whether a URL's path names a file bside should check without waiting for the page to finish loading. */
export function looksLikeFileUrl(url: string): boolean {
  try {
    return /\.(pdf|json|geojson|ndjson|jsonl|xml|rss|atom|txt|log|csv|tsv|md|yaml|yml|toml)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Longest line a JSON file may have before bside reformats it, so paging cuts between lines. */
const JSON_LINE_LIMIT = 2_000;
/** Largest JSON text bside reformats. */
const JSON_REFORMAT_CHARS = 5_000_000;

/**
 * A text file as bside shows it to the model: unchanged, except JSON with a
 * line longer than 2,000 characters (minified), which is re-indented so it
 * can be paged by lines.
 */
export function readableText(text: string, mimeType: string): string {
  const jsonType = /(^application\/json$)|(\+json$)/.test(mimeType);
  if (text.length > JSON_REFORMAT_CHARS || !(jsonType || /^\s*[{[]/.test(text))) return text;
  if (!text.split("\n").some((line) => line.length > JSON_LINE_LIMIT)) return text;
  try { return JSON.stringify(JSON.parse(text), null, 2); }
  catch { return text; }
}

/** One line describing a file: its name, type, and size. */
export function describeFile(file: { name: string; mimeType: string; bytes: number }): string {
  return `${JSON.stringify(file.name)}, ${file.mimeType}, ${file.bytes.toLocaleString("en-US")} bytes`;
}
