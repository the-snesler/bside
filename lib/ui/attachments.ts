/**
 * The sidebar side of file attachments: picking files from a file input, a
 * paste, or a drop, checking them before reading, reading them as base64
 * for `attachment.prepare`, and labeling them on chips. Pure helpers; the
 * Port traffic lives in `use-background.ts`. The background stays
 * authoritative for names, types, and limits.
 */

import { ATTACHMENT_LIMITS } from "@/lib/domain/attachments";
import { bytesToBase64 } from "@/lib/domain/pdf";
import { VIEWABLE_IMAGE_TYPES, WORKSPACE_MAX_UPLOAD_BYTES } from "@/lib/validation";

/**
 * A file the user attached in this sidebar and has not sent. `waiting`: not
 * sent to the background yet (one file is read and prepared at a time, and
 * only while its chat is open); `uploading`: being read or prepared; `ready`:
 * prepared, with the background's `id`, name, and type; `failed`: refused,
 * with a safe `error`. The `File` stays so a stale id can be prepared again.
 */
export interface PendingFile {
  key: string;
  sessionId: string;
  file: File;
  name: string;
  mimeType: string;
  bytes: number;
  status: "waiting" | "uploading" | "ready" | "failed";
  id: string | null;
  error: string | null;
}

/** Where attached files came from: unnamed pasted images get a dated name. */
export type FileSource = "picker" | "paste" | "drop";

const pad = (value: number) => String(value).padStart(2, "0");

const EXTENSIONS: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/bmp": "bmp",
  "image/tiff": "tiff", "image/avif": "avif", "image/heic": "heic", "application/pdf": "pdf", "text/plain": "txt", "text/html": "html",
};

/** An extension for a type: a known one, else the subtype when it is a plain word, else `bin`. */
function extensionFor(mimeType: string): string {
  const type = mimeType.trim().toLowerCase();
  const known = EXTENSIONS[type];
  if (known) return known;
  const subtype = /^[a-z]+\/([a-z0-9]{1,10})$/.exec(type)?.[1];
  return subtype ?? "bin";
}

/** `pasted-YYYY-MM-DD-HHmmss.<ext>` in local time, for a pasted file without a name of its own. */
export function pastedFileName(mimeType: string, at: Date): string {
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `pasted-${date}-${time}.${extensionFor(mimeType)}`;
}

/**
 * The name to attach a file under. A pasted image comes from the clipboard
 * without a name of its own: Firefox calls it `image.png` (or nothing), so
 * it gets a dated `pasted-…` name instead. Other files keep theirs.
 */
export function attachedFileName(file: { name: string; type: string }, source: FileSource, at: Date): string {
  const name = file.name.trim();
  if (source === "paste" && (!name || /^image\.[a-z]{2,5}$/i.test(name) && file.type.startsWith("image/"))) return pastedFileName(file.type, at);
  return name || pastedFileName(file.type, at);
}

/** Whether a drag carries files from the computer (not links, text, or images dragged from a page). */
export function dragHasFiles(data: Pick<DataTransfer, "types"> | null | undefined): boolean {
  return !!data && Array.from(data.types ?? []).includes("Files");
}

/** The files a drop or paste carries: its `files`, else its file items. */
export function filesFromTransfer(data: Pick<DataTransfer, "files" | "items"> | null | undefined): File[] {
  if (!data) return [];
  const files = Array.from(data.files ?? []);
  if (files.length) return files;
  const items = Array.from(data.items ?? []);
  return items.filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter((file): file is File => file !== null);
}

/** Decimal sizes, like the 10 MB limit: `512 B`, `1.2 KB`, `3.4 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

/** A short type label for a chip: `PNG image`, `PDF`, `Text`, or the name's extension. */
export function describeFileType(mimeType: string, name: string, text = false): string {
  const type = mimeType.toLowerCase();
  if (type.startsWith("image/")) return `${(EXTENSIONS[type] ?? type.slice(6).split(/[+.;]/)[0] ?? "").toUpperCase()} image`.trim();
  if (type === "application/pdf") return "PDF";
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1];
  if (extension) return extension.toUpperCase();
  return text || type.startsWith("text/") ? "Text" : "File";
}

/** Whether bside can show the type as a thumbnail (the types it can show the model). */
export const isViewableImage = (mimeType: string) => VIEWABLE_IMAGE_TYPES.includes(mimeType.toLowerCase());

/**
 * Checks files before reading them, given how many this message already
 * carries: empty ones, ones over 10 MB, and any past 8 per message are
 * refused with a friendly message each; the rest are accepted in order.
 */
export function checkFiles(files: readonly { name: string; size: number }[], alreadyAttached: number): { accepted: number[]; errors: string[] } {
  const accepted: number[] = [];
  const errors: string[] = [];
  let overflow = 0;
  files.forEach((file, index) => {
    const name = file.name || "The pasted file";
    if (file.size === 0) errors.push(`${name} is empty.`);
    else if (file.size > WORKSPACE_MAX_UPLOAD_BYTES) errors.push(`${name} is larger than ${WORKSPACE_MAX_UPLOAD_BYTES / 1_000_000} MB (${formatBytes(file.size)}).`);
    else if (alreadyAttached + accepted.length >= ATTACHMENT_LIMITS.perMessage) overflow++;
    else accepted.push(index);
  });
  if (overflow) errors.push(`A message can carry up to ${ATTACHMENT_LIMITS.perMessage} files; ${overflow === 1 ? "1 file was" : `${overflow} files were`} not attached.`);
  return { accepted, errors };
}

/** A file's bytes as canonical base64 (encoded in chunks, so large files do not overflow the call stack). */
export async function fileToBase64(file: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

/**
 * A small `data:` thumbnail of a local image (longest side 96 px), or `null`
 * when it cannot be decoded. The sidebar's CSP allows `data:` images but not
 * `blob:` object URLs, and drawing a small copy keeps no full-size image in
 * the page.
 */
export async function imageThumbnail(file: Blob, size = 96): Promise<string | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/png");
    return url.startsWith("data:image/") ? url : null;
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
