/**
 * The PDF text worker: the background starts one per PDF
 * (`new Worker("/pdf-text.js")`), posts the bytes, and gets the extracted
 * text back (see `lib/background/pdf.ts`). It holds the bundled pdf.js, so
 * the background page neither loads nor runs it.
 */

import { PdfError, type PdfWorkerRequest, type PdfWorkerResponse } from "@/lib/domain/pdf";
import { extractPdfText } from "@/lib/pdf/extract";

export default defineUnlistedScript(() => {
  const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<PdfWorkerRequest>) => void) | null; postMessage(message: PdfWorkerResponse): void };
  scope.onmessage = (event) => {
    scope.onmessage = null;
    extractPdfText(new Uint8Array(event.data.data)).then(
      (pdf) => scope.postMessage({ ok: true, pdf }),
      (error) => scope.postMessage({ ok: false, message: error instanceof PdfError ? error.message : "The PDF could not be read." }),
    );
  };
});
