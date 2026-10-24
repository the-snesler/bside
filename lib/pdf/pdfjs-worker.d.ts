/** pdf.js's worker module ships without types; bside only hands it to pdf.js (see `extract.ts`); the legacy build also runs on Firefox ESR and Node 22. */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
