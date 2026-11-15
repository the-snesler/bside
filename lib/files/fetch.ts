/**
 * Fetches a file in a content script: for a tab showing a file where none
 * runs (Firefox's JSON or PDF viewer) or one loaded before bside watched it,
 * for `browser.download(url)`, and for a download link the agent clicked
 * (fetched by that link's own frame, which alone can read the page's `blob:`
 * URLs). The background page cannot fetch it: its `connect-src` names only
 * bside's own services. Bounded by `FILE_LIMITS.bytes` and `FILE_TIMEOUT_MS`;
 * never sends a referrer. The file's type and name come from its headers.
 */

import { bytesToBase64 } from "@/lib/domain/pdf";
import { FILE_LIMITS, FILE_TIMEOUT_MS, fileNameFor, type FileFetchResult } from "@/lib/domain/files";

export async function fetchFile(
  url: string,
  options: { credentials: "include" | "omit"; cache: "force-cache" | "default" },
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
): Promise<FileFetchResult> {
  let response: Response;
  try {
    response = await fetchImpl(url, { credentials: options.credentials, referrerPolicy: "no-referrer", cache: options.cache, signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
  } catch {
    return { kind: "failed", status: null };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { kind: "failed", status: response.status };
  }
  if (Number(response.headers.get("content-length")) > FILE_LIMITS.bytes) {
    await response.body?.cancel().catch(() => {});
    return { kind: "too-large" };
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (!reader) break;
      const { done, value } = await reader.read();
      if (value) {
        chunks.push(value);
        total += value.length;
        if (total > FILE_LIMITS.bytes) {
          await reader.cancel().catch(() => {});
          return { kind: "too-large" };
        }
      }
      if (done) break;
    }
  } catch {
    return { kind: "failed", status: null };
  }
  const finalUrl = response.url || url;
  return {
    kind: "file", base64: bytesToBase64(join(chunks, total)), bytes: total,
    contentType: response.headers.get("content-type"), name: fileNameFor(finalUrl, response.headers.get("content-disposition")), url: finalUrl,
  };
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
