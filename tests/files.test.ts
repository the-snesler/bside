import { describe, expect, it, vi } from "vitest";
import { storage } from "wxt/utils/storage";
import { loadWorkspaceFiles, workspaceStore } from "@/lib/storage";
import { BackgroundRuntime } from "@/lib/background/runtime";
import { SidebarHub } from "@/lib/background/sidebar-hub";
import { BrowserProgram, DOWNLOADS_READ_ONLY_MESSAGE, ScratchFiles, WorkspaceState } from "@/lib/background/browser-program";
import { FileGuard, type FileGuardWebRequest, type HeadersReceivedDetails, type StreamFilterLike } from "@/lib/background/file-guard";
import { TabFiles, tabFileKey } from "@/lib/background/tab-files";
import { TabController, type TabControllerBrowserApi, type TabSnapshot } from "@/lib/background/tab-controller";
import { classifyFile, decodeText, FILE_LIMITS, fileNameFor, isPageContentType, looksLikeFileUrl, readableText } from "@/lib/domain/files";
import { bytesToBase64 } from "@/lib/domain/pdf";
import type { DomAction } from "@/lib/domain/tools";

const text = (value: string) => new TextEncoder().encode(value);

describe("files: what is a page, what is text", () => {
  it("treats only HTML and XHTML as web pages", () => {
    expect(isPageContentType("text/html; charset=utf-8")).toBe(true);
    expect(isPageContentType("Application/XHTML+XML")).toBe(true);
    for (const type of ["application/json", "text/plain", "application/xml", "text/csv", "image/png", "", null]) expect(isPageContentType(type)).toBe(false);
  });

  it("decides text from the bytes: a clean decode in the declared charset and no NUL bytes", () => {
    expect(decodeText(text("a,b\n1,2"), "text/csv")).toBe("a,b\n1,2");
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]), null)).toBe("hi");
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), "text/plain; charset=ISO-8859-1")).toBe("café");
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), "text/plain")).toBeNull();
    expect(decodeText(new Uint8Array([0x61, 0x00, 0x62]), "text/plain")).toBeNull();
    expect(decodeText(text("ok"), "text/plain; charset=made-up")).toBe("ok");
  });

  it("names the type from a signature first, else the declared type, else by whether it is text", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(classifyFile(png, "application/octet-stream")).toEqual({ mimeType: "image/png", text: null });
    expect(classifyFile(text("%PDF-1.7 ..."), "text/plain")).toEqual({ mimeType: "application/pdf", text: null });
    expect(classifyFile(text('{"a":1}'), "application/json; charset=utf-8")).toEqual({ mimeType: "application/json", text: '{"a":1}' });
    expect(classifyFile(text("plain"), null)).toEqual({ mimeType: "text/plain", text: "plain" });
    expect(classifyFile(new Uint8Array([1, 0, 2]), "")).toEqual({ mimeType: "application/octet-stream", text: null });
    expect(classifyFile(new Uint8Array([1, 0, 2]), "application/zip")).toEqual({ mimeType: "application/zip", text: null });
    // A file claiming to be an image that is not one loses the claim.
    expect(classifyFile(text("not an image"), "image/png")).toEqual({ mimeType: "text/plain", text: "not an image" });
  });

  it("names a file from Content-Disposition, else its URL, cleaned", () => {
    expect(fileNameFor("https://x.test/a/b.csv", "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.csv; filename=\"resume.csv\"")).toBe("résumé.csv");
    expect(fileNameFor("https://x.test/a/b.csv", 'attachment; filename="Q3 \\"final\\".csv"')).toBe('Q3 "final".csv');
    expect(fileNameFor("https://x.test/a/b.csv", "attachment; filename=plain.txt")).toBe("plain.txt");
    expect(fileNameFor("https://x.test/files/data%20set.json?x=1", null)).toBe("data set.json");
    expect(fileNameFor("https://x.test/", "attachment")).toBe("download");
    expect(fileNameFor("https://x.test/", 'attachment; filename="../../etc/passwd"')).toBe("..-..-etc-passwd");
  });

  it("re-indents minified JSON only, so paging cuts on lines", () => {
    const minified = JSON.stringify({ rows: Array.from({ length: 300 }, (_, i) => ({ id: i, name: `row ${i}` })) });
    expect(readableText(minified, "application/json")).toBe(JSON.stringify(JSON.parse(minified), null, 2));
    expect(readableText('{"short": true}', "application/json")).toBe('{"short": true}');
    expect(readableText(`not json ${"x".repeat(3000)}`, "text/plain")).toBe(`not json ${"x".repeat(3000)}`);
    expect(readableText(`{${"x".repeat(3000)}`, "application/json")).toBe(`{${"x".repeat(3000)}`);
  });

  it("recognizes common file URLs to check early", () => {
    expect(looksLikeFileUrl("https://x.test/data.JSON")).toBe(true);
    expect(looksLikeFileUrl("https://x.test/feed.xml?page=2")).toBe(true);
    expect(looksLikeFileUrl("https://x.test/report")).toBe(false);
  });
});

/** A response the fake web serves. */
interface FakeResponse { status?: number; contentType?: string | null; disposition?: string; body: Uint8Array | string }

/** A StreamFilter that records what the guard wrote to the tab. */
class FakeFilter implements StreamFilterLike {
  ondata: ((event: { data: ArrayBuffer }) => void) | null = null;
  onstop: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  written: Uint8Array[] = [];
  closed = false;
  write(data: ArrayBuffer | Uint8Array) { this.written.push(new Uint8Array(data instanceof Uint8Array ? data : new Uint8Array(data)).slice()); }
  close() { this.closed = true; }
  shown(): string { return new TextDecoder().decode(new Uint8Array(this.written.flatMap((chunk) => [...chunk]))); }
}

/**
 * A fake Firefox for files: tabs, `webRequest` (per-tab listeners, a
 * `StreamFilter` per filtered response), and what Firefox does with a
 * response no extension rewrote: HTML is a page (a content script answers),
 * JSON goes to the JSON viewer (no content script), text/plain shows as text
 * (a content script answers but the document is a file), and anything else
 * downloads to the Downloads folder, leaving the tab where it was.
 */
function fakeFirefox(web: Record<string, FakeResponse>) {
  type Doc = { kind: "page" | "viewer" | "text-file"; url: string; contentType: string; outline: string };
  const tabs = new Map<number, TabSnapshot & { doc: Doc }>();
  const downloads: string[] = [];
  const filters: FakeFilter[] = [];
  const executed: DomAction[] = [];
  const executeAnswer: { download?: unknown } = {};
  const listeners = { before: [] as [Function, { tabId: number; types: string[] }][], headers: [] as [Function, { tabId: number; types: string[] }][], error: [] as [Function, { tabId: number }][] };
  let lastLoaded = 0;
  let nextId = 10;
  let requestId = 0;

  const bytesOf = (body: Uint8Array | string) => typeof body === "string" ? text(body) : body;

  /** Loads `url` in a tab as Firefox would, through the webRequest listeners. */
  const load = (tabId: number, url: string, type: "main_frame" | "sub_frame" = "main_frame") => {
    const response = web[url] ?? { status: 404, contentType: "text/html", body: "<p>Not found</p>" };
    const id = String(++requestId);
    for (const [listener, filter] of listeners.before) if (filter.tabId === tabId && filter.types.includes(type)) listener({ requestId: id, type, tabId, url });
    const headers = [
      ...(response.contentType ? [{ name: "Content-Type", value: response.contentType }] : []),
      ...(response.disposition ? [{ name: "Content-Disposition", value: response.disposition }] : []),
      { name: "Content-Length", value: String(bytesOf(response.body).length) },
    ];
    let rewritten: { name: string; value?: string }[] | null = null;
    let filter: FakeFilter | null = null;
    const details: HeadersReceivedDetails = { requestId: id, url, type, tabId, statusCode: response.status ?? 200, responseHeaders: headers };
    for (const [listener, listenerFilter] of listeners.headers) {
      if (listenerFilter.tabId !== tabId || !listenerFilter.types.includes(type)) continue;
      const answer = listener(details) as { responseHeaders?: { name: string; value?: string }[] } | undefined;
      if (answer?.responseHeaders) rewritten = answer.responseHeaders;
    }
    filter = filters.find((candidate) => (candidate as unknown as { requestId: string }).requestId === id) ?? null;
    const body = bytesOf(response.body);
    if (filter) {
      // Delivered in chunks, as the network does.
      for (let offset = 0; offset < body.length; offset += 700) filter.ondata?.({ data: body.slice(offset, offset + 700).buffer });
      filter.onstop?.({});
    }
    if (type === "sub_frame") {
      if (!rewritten && response.disposition?.startsWith("attachment")) downloads.push(url);
      return;
    }
    const tab = tabs.get(tabId)!;
    const contentType = rewritten?.find((header) => header.name.toLowerCase() === "content-type")?.value ?? response.contentType ?? "";
    const attachment = !rewritten && /^attachment/i.test(response.disposition ?? "");
    if (attachment || (!rewritten && !/^(text\/html|application\/json|text\/plain)/.test(contentType))) {
      downloads.push(url);
      return;
    }
    tab.url = url;
    tab.title = url.split("/").pop();
    tab.status = "complete";
    tab.doc = contentType.startsWith("text/html") ? { kind: "page", url, contentType: "text/html", outline: new TextDecoder().decode(body).replace(/<[^>]+>/g, "") }
      : contentType.startsWith("application/json") ? { kind: "viewer", url, contentType, outline: "" }
      : { kind: "text-file", url, contentType: contentType.split(";")[0]!, outline: "" };
    lastLoaded = tabId;
  };

  const sendMessage = vi.fn(async (tabId: number, message: unknown) => {
    const tab = tabs.get(tabId);
    const request = message as { id: string; type: string; url: string; credentials: string; action: DomAction; offset: number; maxChars: number };
    if (!tab || tab.doc.kind === "viewer") throw new Error("Could not establish connection. Receiving end does not exist.");
    const base = { v: 1, id: request.id, ok: true };
    if (request.type === "page.health") return { ...base, type: "page.health", url: tab.doc.url, contentType: tab.doc.contentType };
    if (request.type === "page.fetch-file") {
      const response = web[request.url];
      if (!response || (response.status ?? 200) >= 400) return { ...base, type: "page.fetch-file", result: { kind: "failed", status: response?.status ?? 404 } };
      const body = bytesOf(response.body);
      return { ...base, type: "page.fetch-file", result: { kind: "file", base64: bytesToBase64(body), bytes: body.length, contentType: response.contentType ?? null, name: fileNameFor(request.url, response.disposition), url: request.url } };
    }
    if (tab.doc.kind === "text-file") return { v: 1, id: request.id, ok: false, error: { code: "UNSUPPORTED_PAGE", message: "This tab shows a file, not a web page.", retryable: false, phase: "page" } };
    if (request.type === "page.snapshot") {
      const outline = tab.doc.outline;
      return { ...base, type: "page.snapshot", frames: 0, snapshot: { version: 2, tabId, documentId: `doc-${tabId}`, url: tab.doc.url, title: tab.title, text: outline, offset: 0, end: outline.length, totalChars: outline.length, selectionText: "" } };
    }
    if (request.type === "page.execute") {
      executed.push(request.action);
      if (executeAnswer.download) return { ...base, type: "page.execute", result: { ok: true, summary: "Export is a download link; bside fetched its file instead of clicking it, so the page did not change." }, documentId: `doc-${tabId}`, download: executeAnswer.download };
      return { ...base, type: "page.execute", result: { ok: true, summary: "Clicked." }, documentId: `doc-${tabId}` };
    }
    throw new Error(`unexpected ${request.type}`);
  });

  const webRequest: FileGuardWebRequest = {
    onBeforeRequest: { addListener: vi.fn((listener, filter) => { listeners.before.push([listener, filter]); }), removeListener: vi.fn((listener) => { listeners.before = listeners.before.filter(([l]) => l !== listener); }) },
    onHeadersReceived: { addListener: vi.fn((listener, filter) => { listeners.headers.push([listener, filter]); }), removeListener: vi.fn((listener) => { listeners.headers = listeners.headers.filter(([l]) => l !== listener); }) },
    onErrorOccurred: { addListener: vi.fn((listener, filter) => { listeners.error.push([listener, filter]); }), removeListener: vi.fn((listener) => { listeners.error = listeners.error.filter(([l]) => l !== listener); }) },
    filterResponseData: vi.fn((id: string) => {
      const filter = new FakeFilter();
      (filter as unknown as { requestId: string }).requestId = id;
      filters.push(filter);
      return filter;
    }),
  };

  const api: TabControllerBrowserApi = {
    tabs: {
      query: vi.fn(async () => [...tabs.values()].map(({ doc: _doc, ...tab }) => tab)),
      create: vi.fn(async ({ url }) => {
        const tab = { id: nextId++, url: "about:blank", title: "New Tab", hidden: false, status: "complete", doc: { kind: "page" as const, url: "about:blank", contentType: "text/html", outline: "" } };
        tabs.set(tab.id, tab);
        if (url !== "about:blank") load(tab.id, url);
        return { id: tab.id, url: tab.url };
      }),
      hide: vi.fn(async (id) => { tabs.get(id)!.hidden = true; return [id]; }),
      update: vi.fn(async (id, properties) => { if ("url" in properties) load(id, properties.url); }),
      goBack: vi.fn(async () => {}),
      sendMessage,
      // Loads finish at once, so a listener added after one hears its completion.
      onUpdated: { addListener: vi.fn((listener) => { setTimeout(() => listener(lastLoaded, { status: "complete" }, {}), 0); }), removeListener: vi.fn() },
    },
  };
  const addTab = (id: number, url: string, doc: Doc["kind"] = "page", outline = "Page text") => {
    const contentType = doc === "page" ? "text/html" : doc === "viewer" ? "application/json" : "text/plain";
    tabs.set(id, { id, url, title: url, hidden: false, status: "complete", doc: { kind: doc, url, contentType, outline } });
  };
  return { api, webRequest, tabs, downloads, filters, executed, executeAnswer, listeners, addTab, load };
}

function setup(web: Record<string, FakeResponse>, options: { guard?: boolean; files?: ScratchFiles } = {}) {
  const firefox = fakeFirefox(web);
  const tabFiles = new TabFiles();
  const guard = options.guard === false ? null : new FileGuard(firefox.webRequest, tabFiles);
  const controller = new TabController(firefox.api, async () => false, undefined, tabFiles, undefined, guard);
  const state = new WorkspaceState();
  const files = options.files ?? new ScratchFiles();
  const effect = vi.fn();
  const program = new BrowserProgram(controller, { state, runId: "r1", sessionId: "s1", files }, effect);
  const run = (source: string) => program.execute(source, new AbortController().signal);
  return { ...firefox, tabFiles, guard, controller, state, files, effect, program, run };
}

const CSV = "name,value\nalpha,1\nbeta,2\n";
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 1, 2, 3, 0, 9]);
const WEB: Record<string, FakeResponse> = {
  "https://site.test/": { contentType: "text/html", body: "<p>Home</p><a>Export</a>" },
  "https://site.test/export": { contentType: "text/csv", disposition: 'attachment; filename="report.csv"', body: CSV },
  "https://site.test/archive.zip": { contentType: "application/zip", body: ZIP },
  "https://site.test/data.json": { contentType: "application/json", body: JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ id: i, label: `item ${i}` })) }) },
  "https://site.test/feed.xml": { contentType: "application/xml", body: "<feed><title>News</title></feed>" },
  "https://site.test/redirect": { status: 302, contentType: "text/csv", body: "" },
};

describe("FileGuard", () => {
  it("listens only to watched tabs, holds nested watches, and stops when the last is released", () => {
    const firefox = fakeFirefox(WEB);
    const guard = new FileGuard(firefox.webRequest, new TabFiles());
    const first = guard.watch(4);
    const second = guard.watch(4);
    expect(firefox.webRequest.onHeadersReceived.addListener).toHaveBeenCalledTimes(1);
    expect(firefox.webRequest.onHeadersReceived.addListener).toHaveBeenCalledWith(expect.any(Function), { urls: ["<all_urls>"], types: ["main_frame", "sub_frame"], tabId: 4 }, ["blocking", "responseHeaders"]);
    first();
    first();
    expect(guard.watching(4)).toBe(true);
    second();
    expect(guard.watching(4)).toBe(false);
    expect(firefox.listeners.headers).toHaveLength(0);
    expect(firefox.listeners.before).toHaveLength(0);
    expect(new FileGuard(null, new TabFiles()).watch(4)).toBeTypeOf("function");
  });

  it("keeps a download as a document: text shown in the tab, nothing downloaded, the file cached and queued", async () => {
    const firefox = fakeFirefox(WEB);
    firefox.addTab(4, "https://site.test/");
    const files = new TabFiles();
    const guard = new FileGuard(firefox.webRequest, files);
    guard.watch(4);
    firefox.load(4, "https://site.test/export");
    expect(firefox.downloads).toEqual([]);
    expect(firefox.filters[0]!.shown()).toBe(CSV);
    expect(firefox.filters[0]!.closed).toBe(true);
    expect(firefox.tabs.get(4)!.doc.contentType).toBe("text/css");
    const [captured] = await guard.take(4);
    expect(captured).toMatchObject({ ok: true, frame: "main", file: { url: "https://site.test/export", name: "report.csv", contentType: "text/csv" } });
    expect(new TextDecoder().decode(captured?.ok ? captured.file.data : undefined)).toBe(CSV);
    expect(await guard.take(4)).toEqual([]);
    expect((await files.cached(tabFileKey(4, "https://site.test/export")))?.body).toEqual({ kind: "text", text: CSV });
  });

  it("rewrites the headers: text/css, no disposition, length, or nosniff, the rest kept", () => {
    const firefox = fakeFirefox(WEB);
    const guard = new FileGuard(firefox.webRequest, new TabFiles());
    guard.watch(4);
    const [listener] = firefox.listeners.headers[0]!;
    const answer = listener({ requestId: "1", url: "https://site.test/a.bin", type: "main_frame", tabId: 4, statusCode: 200, responseHeaders: [
      { name: "Content-Type", value: "application/octet-stream" }, { name: "Content-Disposition", value: "attachment" }, { name: "Content-Length", value: "9" },
      { name: "X-Content-Type-Options", value: "nosniff" }, { name: "Cache-Control", value: "no-store" },
    ] });
    expect(answer).toEqual({ responseHeaders: [{ name: "Cache-Control", value: "no-store" }, { name: "Content-Type", value: "text/css; charset=utf-8" }] });
  });

  it("leaves web pages, redirects, errors, and sub-frames that are not attachments alone", () => {
    const firefox = fakeFirefox(WEB);
    const guard = new FileGuard(firefox.webRequest, new TabFiles());
    guard.watch(4);
    const [listener] = firefox.listeners.headers[0]!;
    const details = (overrides: Partial<HeadersReceivedDetails>, contentType: string, disposition?: string): HeadersReceivedDetails => ({
      requestId: "1", url: "https://site.test/x", type: "main_frame", tabId: 4, statusCode: 200,
      responseHeaders: [{ name: "content-type", value: contentType }, ...(disposition ? [{ name: "content-disposition", value: disposition }] : [])], ...overrides,
    });
    expect(listener(details({}, "text/html; charset=utf-8"))).toBeUndefined();
    expect(listener(details({ statusCode: 302 }, "text/csv"))).toBeUndefined();
    expect(listener(details({ statusCode: 404 }, "application/json"))).toBeUndefined();
    expect(listener(details({ type: "sub_frame" }, "application/pdf"))).toBeUndefined();
    expect(firefox.webRequest.filterResponseData).not.toHaveBeenCalled();
    expect(listener(details({ type: "sub_frame" }, "text/plain", "attachment; filename=a.txt"))).toMatchObject({ responseHeaders: expect.any(Array) });
    expect(listener(details({}, "text/html", "attachment; filename=page.html"))).toMatchObject({ responseHeaders: expect.any(Array) });
  });

  it("shows a notice in place of a binary file, and keeps its bytes", async () => {
    const firefox = fakeFirefox(WEB);
    firefox.addTab(4, "https://site.test/");
    const guard = new FileGuard(firefox.webRequest, new TabFiles());
    guard.watch(4);
    firefox.load(4, "https://site.test/archive.zip");
    expect(firefox.downloads).toEqual([]);
    expect(firefox.filters[0]!.shown()).toBe("bside kept this file (application/zip) instead of downloading it.\n");
    const [captured] = await guard.take(4);
    expect(captured?.ok && [...captured.file.data]).toEqual([...ZIP]);
  });

  it("keeps nothing past the size limit and says so in the tab", async () => {
    const firefox = fakeFirefox({ "https://site.test/huge.csv": { contentType: "text/csv", body: new Uint8Array(FILE_LIMITS.bytes + 1).fill(0x61) } });
    firefox.addTab(4, "https://site.test/");
    const files = new TabFiles();
    const guard = new FileGuard(firefox.webRequest, files);
    guard.watch(4);
    firefox.load(4, "https://site.test/huge.csv");
    expect(firefox.filters[0]!.shown()).toContain("The file is larger than 20,000,000 bytes, so bside did not keep it.");
    expect(await guard.take(4)).toEqual([{ ok: false, frame: "main", url: "https://site.test/huge.csv", reason: "The file is larger than 20,000,000 bytes, so bside did not keep it." }]);
    expect(await files.cached(tabFileKey(4, "https://site.test/huge.csv"))).toBeNull();
  });

  it("captures a sub-frame attachment without caching it as the tab's file", async () => {
    const firefox = fakeFirefox({ "https://site.test/frame.txt": { contentType: "text/plain", disposition: "attachment; filename=frame.txt", body: "framed" } });
    firefox.addTab(4, "https://site.test/");
    const files = new TabFiles();
    const guard = new FileGuard(firefox.webRequest, files);
    guard.watch(4);
    firefox.load(4, "https://site.test/frame.txt", "sub_frame");
    expect(firefox.downloads).toEqual([]);
    expect(await guard.take(4)).toMatchObject([{ ok: true, frame: "sub", file: { name: "frame.txt" } }]);
    expect(files.has(tabFileKey(4, "https://site.test/frame.txt"))).toBe(false);
  });

  it("waits for a main-frame request a click started before the action reports", async () => {
    const firefox = fakeFirefox(WEB);
    const guard = new FileGuard(firefox.webRequest, new TabFiles());
    guard.watch(4);
    const [before] = firefox.listeners.before[0]!;
    before({ requestId: "7", type: "main_frame", tabId: 4 });
    let quiet = false;
    const waiting = guard.quiet(4, 5_000).then(() => { quiet = true; });
    await Promise.resolve();
    expect(quiet).toBe(false);
    const [headers] = firefox.listeners.headers[0]!;
    headers({ requestId: "7", url: "https://site.test/", type: "main_frame", tabId: 4, statusCode: 200, responseHeaders: [{ name: "content-type", value: "text/html" }] });
    await waiting;
    expect(quiet).toBe(true);
  });
});

describe("files in browser programs", () => {
  it("opens a download URL into a tab that shows the file and keeps it, with nothing in the Downloads folder", async () => {
    const t = setup(WEB);
    const result = await t.run('const tab = await browser.open("https://site.test/export"); return await tab.snapshot();');
    expect(result.ok, result.summary).toBe(true);
    expect(t.downloads).toEqual([]);
    expect(t.api.tabs.create).toHaveBeenCalledWith({ url: "about:blank", active: false });
    expect(result.summary).toContain("File: report.csv · text/csv · 26 bytes\n\nname,value\nalpha,1\nbeta,2");
    expect(result.summary).toMatch(/Tab: \/agent-tabs\/10\/page\.md · File file-[0-9a-f]{8} \(read-only/);
    expect(result.summary).toContain('Note: /agent-tabs/10/page.md now shows a file. https://site.test/export is a file, not a web page: kept as /workspace/downloads/report.csv ("report.csv", text/csv, 26 bytes); read it with fs.read(path). Nothing reached the user\'s Downloads folder.');
    expect(await t.files.read("/workspace/downloads/report.csv")).toMatchObject({ kind: "download", name: "report.csv", mimeType: "text/csv", text: true, url: "https://site.test/export" });
    expect(t.program.tainted).toBe(true);
    // Listing and reading the kept file.
    const listed = await t.run('return await fs.list("/workspace/downloads");');
    expect(listed.summary).toContain('"downloadedFrom":"https://site.test/export"');
    const read = await t.run('return await fs.read("/workspace/downloads/report.csv");');
    expect(read.summary).toContain('File: /workspace/downloads/report.csv ("report.csv", text/csv, 26 bytes; downloaded from https://site.test/export)\nBEGIN_UNTRUSTED_FILE\nname,value');
  });

  it("keeps a binary file a navigation loads, and says bside cannot read it", async () => {
    const t = setup(WEB);
    t.addTab(1, "https://site.test/");
    const result = await t.run('const page = browser.tab("/tabs/1/page.md"); await page.navigate("https://site.test/archive.zip"); return await page.snapshot();');
    expect(result.ok, result.summary).toBe(true);
    expect(t.downloads).toEqual([]);
    expect(result.summary).toContain("File: archive.zip · application/zip · 11 bytes\n\nbside cannot read this type of file. It is kept in /workspace/downloads");
    expect(result.summary).toContain("kept as /workspace/downloads/archive.zip (\"archive.zip\", application/zip, 11 bytes); bside cannot read this type of file; setInputFiles(path) can upload it to a page.");
    const read = await t.run('return await fs.read("/workspace/downloads/archive.zip");');
    expect(read.summary).toContain('"note":"bside cannot read this file type.');
    // A file tab has no refs and takes no actions.
    const click = await t.run('return await browser.tab("/tabs/1/page.md").ref("e1").click();');
    expect(click).toMatchObject({ ok: false, code: "UNSUPPORTED_PAGE" });
    expect(click.summary).toContain("This tab shows a file, not a web page");
    expect(t.executed).toEqual([]);
  });

  it("reads a tab Firefox shows in its JSON viewer, re-indented, through another tab's fetch", async () => {
    const t = setup(WEB, { guard: false });
    t.addTab(1, "https://site.test/");
    t.addTab(2, "https://site.test/data.json", "viewer");
    const result = await t.run('return await fs.read("/tabs/2/page.md");');
    expect(result.ok, result.summary).toBe(true);
    expect(result.summary).toContain('File: data.json · application/json · ');
    expect(result.summary).toContain('{\n  "rows": [\n    {\n      "id": 0,');
    // Reading it keeps nothing; saveFile does.
    expect(await t.files.paths()).toEqual([]);
    const kept = await t.run('return await browser.tab("/tabs/2/page.md").saveFile();');
    expect(kept.summary).toContain("kept as /workspace/downloads/data.json");
  });

  it("reads a text document whose content script reports a file, never as an outline", async () => {
    const t = setup(WEB, { guard: false });
    t.addTab(1, "https://site.test/");
    t.addTab(3, "https://site.test/feed.xml", "text-file");
    const result = await t.run('return await browser.tab("/tabs/3/page.md").find("News");');
    expect(result.ok, result.summary).toBe(true);
    expect(result.summary).toContain("<feed><title>News</title></feed>");
  });

  it("keeps a URL with browser.download without opening a tab; not a page effect", async () => {
    const t = setup(WEB);
    t.addTab(1, "https://site.test/");
    const result = await t.run('const file = await browser.download("https://site.test/data.json"); return [file.path, file.mimeType, file.text];');
    expect(result.ok, result.summary).toBe(true);
    expect(result.summary).toBe('["/workspace/downloads/data.json","application/json",true]');
    expect(t.api.tabs.create).not.toHaveBeenCalled();
    expect(t.effect).not.toHaveBeenCalled();
    expect(t.program.tainted).toBe(true);
    const read = await t.run('return await fs.read("/workspace/downloads/data.json", {maxChars: 500});');
    expect(read.summary).toContain('BEGIN_UNTRUSTED_FILE\n{\n  "rows": [');
    expect((await t.run('return await browser.download("https://site.test/");')).summary).toContain("is a web page, not a file; open it with browser.open(url)");
    expect((await t.run('return await browser.download("https://user:pw@site.test/data.json");')).summary).toContain("does not take URLs with credentials");
    expect((await t.run('return await browser.download("https://site.test/missing.txt");')).summary).toContain("Downloading it failed (HTTP 404).");
  });

  it("keeps a download link's file without leaving the page", async () => {
    const t = setup(WEB);
    t.addTab(1, "https://site.test/");
    t.executeAnswer.download = { pageUrl: "https://site.test/", result: { kind: "file", base64: bytesToBase64(text("made in the page")), bytes: 16, contentType: "text/plain", name: "notes.txt", url: "blob:https://site.test/1234" } };
    const result = await t.run('return await browser.tab("/tabs/1/page.md").getByText("Export").click();');
    expect(result.ok, result.summary).toBe(true);
    expect(result.summary).toContain("is a download link; bside fetched its file instead of clicking it");
    // A blob: link's file is credited to its page.
    expect(result.summary).toContain("https://site.test/ is a file, not a web page: kept as /workspace/downloads/notes.txt");
    expect(await t.files.read("/workspace/downloads/notes.txt")).toMatchObject({ kind: "download", url: "https://site.test/" });
  });

  it("lets programs read and remove kept files, never write or move them, and upload them under their names", async () => {
    const t = setup(WEB);
    t.addTab(1, "https://site.test/");
    await t.run('await browser.download("https://site.test/export");');
    expect((await t.run('fs.write("/workspace/downloads/x.txt", "hi");')).summary).toContain(DOWNLOADS_READ_ONLY_MESSAGE);
    expect((await t.run('fs.move("/workspace/downloads/report.csv", "/workspace/r.csv");')).summary).toContain(DOWNLOADS_READ_ONLY_MESSAGE);
    expect((await t.run('fs.write("/workspace/notes.txt", "x"); fs.move("/workspace/notes.txt", "/workspace/downloads/notes.txt");')).summary).toContain(DOWNLOADS_READ_ONLY_MESSAGE);
    await t.run('await browser.tab("/tabs/1/page.md").getByText("Export").setInputFiles("/workspace/downloads/report.csv");');
    expect(t.executed.at(-1)).toMatchObject({ kind: "upload", files: [{ name: "report.csv", mimeType: "text/csv", base64: bytesToBase64(text(CSV)) }] });
    expect((await t.run('return await fs.remove("/workspace/downloads/report.csv");')).ok).toBe(true);
    expect(await t.files.paths()).toEqual(["/workspace/notes.txt"]);
  });

  it("keeps the same file once and names another one apart", async () => {
    const t = setup({ ...WEB, "https://other.test/export": { contentType: "text/csv", disposition: 'attachment; filename="report.csv"', body: "different\n" } });
    t.addTab(1, "https://site.test/");
    await t.run('await browser.download("https://site.test/export");');
    expect((await t.run('const again = await browser.download("https://site.test/export"); return again.path;')).summary).toBe("/workspace/downloads/report.csv");
    expect((await t.run('const other = await browser.download("https://other.test/export"); return other.path;')).summary).toBe("/workspace/downloads/report-2.csv");
  });

  it("reports a full workspace without failing the navigation that loaded the file", async () => {
    const files = new ScratchFiles();
    const t = setup(WEB, { files });
    for (let i = 0; i < 64; i++) await files.write(`/workspace/f${i}.txt`, { kind: "text", content: "x" });
    t.addTab(1, "https://site.test/");
    const navigated = await t.run('await browser.tab("/tabs/1/page.md").navigate("https://site.test/export");');
    expect(navigated.ok, navigated.summary).toBe(true);
    expect(navigated.summary).toContain("bside could not keep the file from https://site.test/export: This chat's workspace is full");
    expect(t.downloads).toEqual([]);
    const download = await t.run('return await browser.download("https://site.test/export");');
    expect(download).toMatchObject({ ok: false, code: "LIMIT_EXCEEDED" });
  });

  it("without the guard (no webRequest), opens URLs directly as before", async () => {
    const t = setup(WEB, { guard: false });
    t.addTab(1, "https://site.test/");
    const result = await t.run('return await browser.open("https://site.test/");');
    expect(result.ok, result.summary).toBe(true);
    expect(t.api.tabs.create).toHaveBeenCalledWith({ url: "https://site.test/", active: false });
  });
});

describe("kept files in storage", () => {
  it("keeps download records only under /workspace/downloads, with a valid URL, and nothing else there", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const store = workspaceStore(sessionId);
    const data = bytesToBase64(text(CSV));
    const download = { kind: "download" as const, name: "report.csv", mimeType: "text/csv", data, bytes: CSV.length, text: true, url: "https://site.test/export" };
    await store.write({ slot: 0, path: "/workspace/downloads/report.csv", ...download });
    await storage.setItem(`local:workspace:${sessionId}:1`, { version: 2, path: "/workspace/report.csv", ...download });
    await storage.setItem(`local:workspace:${sessionId}:2`, { version: 2, path: "/workspace/downloads/bad.csv", ...download, url: "javascript:alert(1)" });
    await storage.setItem(`local:workspace:${sessionId}:3`, { version: 2, path: "/workspace/downloads/notes.txt", kind: "text", content: "x" });
    await storage.setItem(`local:workspace:${sessionId}:4`, { version: 2, path: "/workspace/uploads/a.csv", ...download });
    expect(await loadWorkspaceFiles(sessionId)).toEqual([{ slot: 0, path: "/workspace/downloads/report.csv", ...download }]);
    expect(await storage.getItem(`local:workspace:${sessionId}:1`)).toBeNull();
  });
});

describe("the runtime's file guard", () => {
  it("watches every agent tab from adoption, and stops when the tab is released or closed", () => {
    const firefox = fakeFirefox(WEB);
    const guard = new FileGuard(firefox.webRequest, new TabFiles());
    const workspace = new WorkspaceState();
    const runtime = new BackgroundRuntime(new SidebarHub(), { tabControllerFactory: () => new TabController(firefox.api), workspace, fileGuard: guard });
    workspace.adoptTab(5, "11111111-1111-4111-8111-111111111111");
    // Synchronously, so a load started right after adoption is seen.
    expect(guard.watching(5)).toBe(true);
    workspace.adoptTab(6, "11111111-1111-4111-8111-111111111111", "search");
    workspace.releaseTab(5);
    expect(guard.watching(5)).toBe(false);
    expect(guard.watching(6)).toBe(true);
    runtime.handleTabRemoved(6);
    expect(guard.watching(6)).toBe(false);
  });
});
