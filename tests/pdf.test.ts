import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserProgram, ScratchFiles, WorkspaceState } from "@/lib/background/browser-program";
import { PdfReader, workerPdfExtractor, type PdfExtractor } from "@/lib/background/pdf";
import { TabController, type TabControllerBrowserApi, type TabSnapshot } from "@/lib/background/tab-controller";
import { bytesToBase64, isPdfHeader, looksLikePdfUrl, PDF_LIMITS, PDF_TIMEOUT_MS, PdfError, renderPdfText, type PdfText } from "@/lib/domain/pdf";
import { extractPdfText } from "@/lib/pdf/extract";
import { fetchPdf } from "@/lib/pdf/fetch";
import { isPageFetchPdfRequest } from "@/lib/protocol";
import { makePdf } from "./helpers/pdf";

afterEach(() => {
  vi.useRealTimers();
});

describe("PDF text extraction", () => {
  it("extracts each page's lines and the document title", async () => {
    const pdf = await extractPdfText(makePdf([["Quarterly report (draft)", "Revenue grew 12%"], ["Appendix A"]], { title: "Q3 Report" }));
    expect(pdf).toEqual({ pages: 2, pageTexts: ["Quarterly report (draft)\nRevenue grew 12%", "Appendix A"], title: "Q3 Report", cut: false });
    expect(renderPdfText(pdf)).toBe("PDF: 2 pages · Q3 Report\n\n--- Page 1 ---\nQuarterly report (draft)\nRevenue grew 12%\n\n--- Page 2 ---\nAppendix A");
  });

  it(`reads at most ${PDF_LIMITS.pages} pages and says which were not read`, async () => {
    const pdf = await extractPdfText(makePdf(Array.from({ length: PDF_LIMITS.pages + 5 }, (_, i) => [`Page body ${i + 1}`])));
    expect(pdf.pages).toBe(PDF_LIMITS.pages + 5);
    expect(pdf.pageTexts).toHaveLength(PDF_LIMITS.pages);
    expect(pdf.pageTexts.at(-1)).toBe(`Page body ${PDF_LIMITS.pages}`);
    expect(renderPdfText(pdf)).toContain(`[Pages ${PDF_LIMITS.pages + 1}–${PDF_LIMITS.pages + 5} not read: bside reads at most ${PDF_LIMITS.pages} pages.]`);
  });

  it("cuts long page text and keeps the document under the character limit", async () => {
    const line = "x".repeat(500);
    const pdf = await extractPdfText(makePdf([Array.from({ length: 60 }, () => line)], { fontSize: 1 }));
    expect(pdf.cut).toBe(true);
    expect(pdf.pageTexts[0]!.length).toBe(PDF_LIMITS.charsPerPage + 1);
    expect(renderPdfText(pdf)).toContain("cut at 20,000 characters per page");
    const capped: PdfText = { pages: 30, pageTexts: ["a", "b"], title: "", cut: true };
    expect(renderPdfText(capped)).toContain("[Pages 3–30 not read: the text limit (300,000 characters) was reached.]");
  });

  it("refuses files that are not PDFs with a safe message", async () => {
    await expect(extractPdfText(new TextEncoder().encode("<html>not a pdf</html>"))).rejects.toThrow(new PdfError("The file is not a readable PDF."));
  });

  it("notes a PDF with no text layer", () => {
    expect(renderPdfText({ pages: 1, pageTexts: [""], title: "", cut: false })).toContain("no extractable text; its pages may be scanned images");
  });

  it("recognizes PDFs by header and URL", () => {
    expect(isPdfHeader(makePdf([["x"]]))).toBe(true);
    expect(isPdfHeader(new TextEncoder().encode(`${" ".repeat(200)}%PDF-1.7`))).toBe(true);
    expect(isPdfHeader(new TextEncoder().encode("<!doctype html>"))).toBe(false);
    expect(looksLikePdfUrl("https://example.com/files/Report.PDF?download=1")).toBe(true);
    expect(looksLikePdfUrl("https://example.com/report")).toBe(false);
  });
});

/** A fetch that answers with `body` (streamed in 700-byte chunks) and records its calls. */
function fakeFetch(body: Uint8Array | string, init: { status?: number; headers?: Record<string, string> } = {}) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return vi.fn(async (_url: string, _init: RequestInit) => {
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, offset += 700));
      },
    });
    return new Response(stream, { status: init.status ?? 200, headers: init.headers });
  });
}

describe("fetching a PDF in a content script", () => {
  it("returns the bytes as base64, without a referrer, from the HTTP cache when it can", async () => {
    const pdf = makePdf([["Hello"]]);
    const fetchImpl = fakeFetch(pdf);
    expect(await fetchPdf("https://example.com/a.pdf", "include", fetchImpl)).toEqual({ kind: "pdf", base64: bytesToBase64(pdf), bytes: pdf.length });
    expect(fetchImpl).toHaveBeenCalledWith("https://example.com/a.pdf", expect.objectContaining({ credentials: "include", referrerPolicy: "no-referrer", cache: "force-cache" }));
  });

  it("stops at the first bytes of something that is not a PDF", async () => {
    expect(await fetchPdf("https://example.com/page", "omit", fakeFetch("<html>".repeat(1000)))).toEqual({ kind: "not-pdf" });
  });

  it("refuses PDFs over the byte limit, by header or while streaming", async () => {
    expect(await fetchPdf("https://example.com/a.pdf", "omit", fakeFetch(makePdf([["x"]]), { headers: { "content-length": String(PDF_LIMITS.bytes + 1) } }))).toEqual({ kind: "too-large" });
    const huge = new Uint8Array(PDF_LIMITS.bytes + 10);
    huge.set(new TextEncoder().encode("%PDF-1.4"));
    expect(await fetchPdf("https://example.com/a.pdf", "omit", vi.fn(async () => new Response(huge)))).toEqual({ kind: "too-large" });
  });

  it("reports HTTP and network failures without their bodies", async () => {
    expect(await fetchPdf("https://example.com/a.pdf", "omit", fakeFetch("Forbidden", { status: 403 }))).toEqual({ kind: "failed", status: 403 });
    expect(await fetchPdf("https://example.com/a.pdf", "omit", vi.fn(async () => { throw new TypeError("NetworkError"); }))).toEqual({ kind: "failed", status: null });
  });

  it("validates fetch requests: top frame, an HTTP(S) URL, and a credentials mode", () => {
    const request = { v: 1, id: "1", type: "page.fetch-pdf", frameId: 0, tabId: 3, url: "https://example.com/a.pdf", credentials: "include" };
    expect(isPageFetchPdfRequest(request)).toBe(true);
    expect(isPageFetchPdfRequest({ ...request, frameId: 2 })).toBe(false);
    expect(isPageFetchPdfRequest({ ...request, url: "file:///etc/passwd" })).toBe(false);
    expect(isPageFetchPdfRequest({ ...request, credentials: "same-origin" })).toBe(false);
  });
});

/** A worker that answers each posted PDF with `answer`, recording what it was sent. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  posted: { message: unknown; transfer: unknown[] }[] = [];
  terminated = false;
  constructor(private answer: ((data: ArrayBuffer) => unknown) | null) {
    FakeWorker.instances.push(this);
  }
  postMessage(message: { data: ArrayBuffer }, transfer: unknown[]) {
    this.posted.push({ message, transfer });
    if (this.answer) queueMicrotask(() => this.onmessage?.({ data: this.answer!(message.data) } as MessageEvent));
  }
  terminate() {
    this.terminated = true;
  }
}

describe("PDF reader", () => {
  it("extracts in a fresh worker per PDF, transfers a copy of the bytes, and ends the worker", async () => {
    FakeWorker.instances = [];
    const extract = workerPdfExtractor(() => new FakeWorker((data) => ({ ok: true, pdf: { pages: 1, pageTexts: [`${data.byteLength} bytes`], title: "", cut: false } })) as unknown as Worker);
    const bytes = new Uint8Array([1, 2, 3]);
    expect((await extract(bytes)).pageTexts).toEqual(["3 bytes"]);
    const [worker] = FakeWorker.instances;
    expect(worker!.terminated).toBe(true);
    expect(worker!.posted[0]!.transfer).toHaveLength(1);
    expect(bytes.byteLength).toBe(3);
  });

  it("passes on the worker's safe failure and refuses malformed answers", async () => {
    await expect(workerPdfExtractor(() => new FakeWorker(() => ({ ok: false, message: "The PDF is password-protected." })) as unknown as Worker)(new Uint8Array(1)))
      .rejects.toThrow("The PDF is password-protected.");
    await expect(workerPdfExtractor(() => new FakeWorker(() => ({ ok: true, pdf: { pages: "many" } })) as unknown as Worker)(new Uint8Array(1)))
      .rejects.toThrow("The PDF could not be read.");
  });

  it("gives up on a worker that does not answer in time", async () => {
    vi.useFakeTimers();
    FakeWorker.instances = [];
    const pending = workerPdfExtractor(() => new FakeWorker(null) as unknown as Worker)(new Uint8Array(1));
    const settled = expect(pending).rejects.toThrow("Reading the PDF took too long.");
    await vi.advanceTimersByTimeAsync(PDF_TIMEOUT_MS);
    await settled;
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
  });

  it("parses a PDF once for concurrent and later reads, remembers non-PDFs, and retries failures", async () => {
    const extract = vi.fn<PdfExtractor>(async () => ({ pages: 1, pageTexts: ["text"], title: "", cut: false }));
    const reader = new PdfReader(extract);
    const load = vi.fn(async () => makePdf([["x"]]));
    const [a, b] = await Promise.all([reader.read("k", load), reader.read("k", load)]);
    expect(a).toBe(b);
    await reader.read("k", load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(extract).toHaveBeenCalledTimes(1);

    const notPdf = vi.fn(async () => null);
    expect(await reader.read("html", notPdf)).toBeNull();
    expect(await reader.read("html", notPdf)).toBeNull();
    expect(notPdf).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async (): Promise<Uint8Array> => { throw new PdfError("Downloading it failed."); });
    await expect(reader.read("bad", failing)).rejects.toThrow("Downloading it failed.");
    await expect(reader.read("bad", failing)).rejects.toThrow("Downloading it failed.");
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

/**
 * Tabs for TabController: `pdf` tabs show a PDF in Firefox's viewer (no
 * content script answers there); the others answer health, snapshot, and
 * fetch-pdf requests, serving `files` by URL.
 */
function pdfBrowser(tabs: (TabSnapshot & { pdf?: boolean })[], files: Record<string, Uint8Array>) {
  const fetches: { tabId: number; url: string; credentials: string }[] = [];
  const sendMessage = vi.fn(async (tabId: number, message: unknown) => {
    const tab = tabs.find((candidate) => candidate.id === tabId)!;
    if (tab.pdf) throw new Error("Could not establish connection. Receiving end does not exist.");
    const request = message as { id: string; type: string; url: string; credentials: string; offset: number; maxChars: number };
    if (request.type === "page.health") return { v: 1, id: request.id, ok: true, type: "page.health", url: tab.url };
    if (request.type === "page.fetch-pdf") {
      fetches.push({ tabId, url: request.url, credentials: request.credentials });
      const file = files[request.url];
      return { v: 1, id: request.id, ok: true, type: "page.fetch-pdf", result: file ? { kind: "pdf", base64: bytesToBase64(file), bytes: file.length } : { kind: "not-pdf" } };
    }
    if (request.type === "page.snapshot") {
      const text = "Page text";
      return { v: 1, id: request.id, ok: true, type: "page.snapshot", frames: 0, snapshot: { version: 2, tabId, documentId: `doc-${tabId}`, url: tab.url, title: tab.title, text, offset: 0, end: text.length, totalChars: text.length, selectionText: "" } };
    }
    throw new Error(`unexpected ${request.type}`);
  });
  let nextId = 100;
  const api: TabControllerBrowserApi = {
    tabs: {
      query: vi.fn(async () => tabs.map(({ pdf: _pdf, ...tab }) => tab)),
      create: vi.fn(async ({ url }) => {
        const tab = { id: nextId++, url, title: url.split("/").pop()!, hidden: false, status: "complete", pdf: url in files };
        tabs.push(tab);
        return tab;
      }),
      hide: vi.fn(async (id) => [id]),
      update: vi.fn(async () => {}),
      goBack: vi.fn(async () => {}),
      sendMessage,
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  return { api, fetches, sendMessage };
}

const REPORT_URL = "https://reports.example/files/q3.pdf";
const REPORT = makePdf([["Quarterly report", "Revenue grew 12%"], ["Appendix A", "Methods"]], { title: "Q3 Report" });

function pdfSetup(tabs: (TabSnapshot & { pdf?: boolean })[] = [
  { id: 1, url: "https://news.example/", title: "News", hidden: false, status: "complete" },
  { id: 2, url: "https://reports.example/", title: "Reports", hidden: false, status: "complete" },
  { id: 3, url: REPORT_URL, title: "q3.pdf", hidden: false, status: "complete", pdf: true },
]) {
  const browser = pdfBrowser(tabs, { [REPORT_URL]: REPORT });
  const extract = vi.fn<PdfExtractor>((data) => extractPdfText(data));
  const reader = new PdfReader(extract);
  const controller = new TabController(browser.api, undefined, undefined, reader);
  return { ...browser, extract, reader, controller };
}

describe("PDF tabs", () => {
  it("reads a PDF tab's text as a read-only snapshot, fetched by a tab on the PDF's origin with its cookies", async () => {
    const { controller, fetches, extract } = pdfSetup();
    const tab = await controller.forTab(3);
    const snapshot = await tab.snapshot({ offset: 0, maxChars: 16_000 });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value).toMatchObject({ tabId: 3, url: REPORT_URL, title: "Q3 Report", pdf: { pages: 2 }, documentId: expect.stringMatching(/^pdf-[0-9a-f]{8}$/) });
    expect(snapshot.value.text).toBe("PDF: 2 pages · Q3 Report\n\n--- Page 1 ---\nQuarterly report\nRevenue grew 12%\n\n--- Page 2 ---\nAppendix A\nMethods");
    expect(fetches).toEqual([{ tabId: 2, url: REPORT_URL, credentials: "include" }]);

    // Paging, find, and the same document id reuse the parsed text.
    const second = await tab.snapshot({ offset: snapshot.value.text.indexOf("Revenue"), maxChars: 500 });
    expect(second.ok && second.value.text.startsWith("Revenue")).toBe(true);
    expect(second.ok && second.value.documentId).toBe(snapshot.value.documentId);
    const found = await tab.find("appendix");
    expect(found.ok && found.value).toMatchObject({ count: 1, url: REPORT_URL, documentId: snapshot.value.documentId });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(fetches).toHaveLength(1);
  });

  it("fetches without cookies through another tab when no tab is on the PDF's origin, hidden agent tabs first", async () => {
    const { controller, fetches } = pdfSetup([
      { id: 1, url: "https://news.example/", title: "News", hidden: false, status: "complete" },
      { id: 4, url: "https://agent.example/", title: "Agent tab", hidden: true, status: "complete" },
      { id: 3, url: REPORT_URL, title: "q3.pdf", hidden: false, status: "complete", pdf: true },
    ]);
    expect((await (await controller.forTab(3)).snapshot()).ok).toBe(true);
    expect(fetches).toEqual([{ tabId: 4, url: REPORT_URL, credentials: "omit" }]);
  });

  it("refuses actions and screenshots on a PDF tab with a clear message", async () => {
    const { controller } = pdfSetup();
    const tab = await controller.forTab(3);
    await tab.snapshot();
    const outcome = await tab.act({ kind: "click", target: { kind: "ref", ref: "e1", documentId: "x" } });
    expect(outcome.result).toMatchObject({ ok: false, code: "UNSUPPORTED_PAGE", summary: expect.stringContaining("bside can read it (snapshot, find) but not operate it") });
  });

  it("keeps the original error for an unresponsive tab that is not a PDF", async () => {
    const { controller, fetches } = pdfSetup([
      { id: 2, url: "https://reports.example/", title: "Reports", hidden: false, status: "complete" },
      { id: 5, url: "https://reports.example/viewer", title: "Viewer", hidden: false, status: "complete", pdf: true },
    ]);
    const snapshot = await (await controller.forTab(5)).snapshot();
    expect(snapshot).toMatchObject({ ok: false, error: { code: "TAB_CHANGED" } });
    expect(fetches).toHaveLength(1);
  });

  it("says when no open page can fetch the PDF", async () => {
    const { controller } = pdfSetup([{ id: 3, url: REPORT_URL, title: "q3.pdf", hidden: false, status: "complete", pdf: true }]);
    const snapshot = await (await controller.forTab(3)).snapshot();
    expect(snapshot).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_PAGE", message: expect.stringContaining("No open web page could fetch it") } });
  });

  it("treats a newly opened PDF as ready instead of waiting for a content script", async () => {
    const { controller } = pdfSetup();
    const tabId = await controller.createTab(REPORT_URL);
    await expect(controller.waitUntilReady(tabId, new AbortController().signal)).resolves.toBeUndefined();
  });
});

describe("PDFs in browser programs", () => {
  function programSetup() {
    const setup = pdfSetup();
    const files = new ScratchFiles();
    const state = new WorkspaceState();
    const program = new BrowserProgram(setup.controller, { state, sessionId: "s1", files }, () => {});
    const run = (source: string) => program.execute(source, new AbortController().signal);
    return { ...setup, files, program, run };
  }

  it("reads a PDF tab through fs.read and the page snapshot, marked read-only", async () => {
    const { run, program } = programSetup();
    const result = await run('return await fs.read("/tabs/3/page.md");');
    expect(result.ok, result.summary).toBe(true);
    expect(result.summary).toContain("URL: https://reports.example/files/q3.pdf");
    expect(result.summary).toMatch(/Tab: \/tabs\/3\/page\.md · PDF pdf-[0-9a-f]{8} \(read-only: no refs or actions/);
    expect(result.summary).toContain("BEGIN_UNTRUSTED_PAGE\nPDF: 2 pages · Q3 Report");
    expect(program.tainted).toBe(true);
  });

  it("saves a PDF tab to /workspace and reads it back as paged text, which taints the run", async () => {
    const { run, files, program } = programSetup();
    const saved = await run('return await browser.tab("/tabs/3/page.md").savePdf("/workspace/q3.pdf");');
    expect(saved.ok, saved.summary).toBe(true);
    expect(saved.summary).toBe(`Saved the PDF ${REPORT_URL} to /workspace/q3.pdf (${REPORT.length} bytes).`);
    expect(await files.read("/workspace/q3.pdf")).toMatchObject({ kind: "binary", mimeType: "application/pdf", bytes: REPORT.length });

    const fresh = new BrowserProgram(new TabController(pdfBrowser([], {}).api, undefined, undefined, new PdfReader(extractPdfText)), { state: new WorkspaceState(), sessionId: "s1", files }, () => {});
    const read = await fresh.execute('return await fs.read("/workspace/q3.pdf");', new AbortController().signal);
    expect(read.ok, read.summary).toBe(true);
    expect(read.summary).toContain("File: /workspace/q3.pdf (PDF, read-only)\nBEGIN_UNTRUSTED_PAGE\nPDF: 2 pages · Q3 Report");
    expect(fresh.tainted).toBe(true);
    const paged = await fresh.execute('return await fs.read("/workspace/q3.pdf", {offset: 58, maxChars: 500});', new AbortController().signal);
    expect(paged.summary).toContain("BEGIN_UNTRUSTED_PAGE\nRevenue grew 12%");
    expect(paged.summary).toContain("end of file");
    expect(program.tainted).toBe(true);
  });

  it("refuses savePdf on a web page and on a path that is not a .pdf", async () => {
    const { run } = programSetup();
    expect((await run('return await browser.tab("/tabs/1/page.md").savePdf("/workspace/x.pdf");')).summary).toContain("This tab does not show a PDF.");
    expect((await run('return await browser.tab("/tabs/3/page.md").savePdf("/workspace/x.txt");')).summary).toContain("savePdf() expects a /workspace path ending in .pdf.");
  });

  it("reports an unreadable /workspace PDF safely", async () => {
    const { run, files } = programSetup();
    await files.write("/workspace/broken.pdf", { kind: "binary", mimeType: "application/pdf", data: bytesToBase64(new TextEncoder().encode("%PDF-1.4 garbage")), bytes: 16 });
    const result = await run('return await fs.read("/workspace/broken.pdf");');
    expect(result.ok).toBe(false);
    expect(result.code).toBe("UNSUPPORTED_PAGE");
    expect(result.summary).toContain("/workspace/broken.pdf: The file is not a readable PDF.");
  });
});
