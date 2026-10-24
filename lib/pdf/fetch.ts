/**
 * Fetches a PDF for a tab that shows it in Firefox's viewer, where no content
 * script runs. It runs in another tab's content script: the background page
 * cannot fetch it, since its `connect-src` names only bside's own services.
 * Bounded by `PDF_LIMITS.bytes` and `PDF_TIMEOUT_MS`; anything that does not
 * start like a PDF is dropped after its first bytes. Never sends a referrer.
 */

import { bytesToBase64, isPdfHeader, PDF_LIMITS, PDF_TIMEOUT_MS, type PdfFetchResult } from "@/lib/domain/pdf";

export async function fetchPdf(
  url: string,
  credentials: "include" | "omit",
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
): Promise<PdfFetchResult> {
  let response: Response;
  try {
    // The viewer usually just loaded it, so the HTTP cache often answers.
    response = await fetchImpl(url, { credentials, referrerPolicy: "no-referrer", cache: "force-cache", signal: AbortSignal.timeout(PDF_TIMEOUT_MS) });
  } catch {
    return { kind: "failed", status: null };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { kind: "failed", status: response.status };
  }
  if (Number(response.headers.get("content-length")) > PDF_LIMITS.bytes) {
    await response.body?.cancel().catch(() => {});
    return { kind: "too-large" };
  }
  const reader = response.body?.getReader();
  if (!reader) return { kind: "failed", status: response.status };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let checked = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        chunks.push(value);
        total += value.length;
        if (total > PDF_LIMITS.bytes) {
          await reader.cancel().catch(() => {});
          return { kind: "too-large" };
        }
      }
      if (!checked && (done || total >= 1024)) {
        checked = true;
        if (!isPdfHeader(join(chunks, total))) {
          if (!done) await reader.cancel().catch(() => {});
          return { kind: "not-pdf" };
        }
      }
      if (done) break;
    }
  } catch {
    return { kind: "failed", status: null };
  }
  return { kind: "pdf", base64: bytesToBase64(join(chunks, total)), bytes: total };
}

function join(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  chunks.splice(0, chunks.length, bytes);
  return bytes;
}
