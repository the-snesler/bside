import { describe, expect, it, vi } from "vitest";
import { BrowserProgram, parseProgram, ScratchFiles, WorkspaceState } from "@/lib/background/browser-program";
import type { ScratchFileEntry, ScratchStore } from "@/lib/background/browser-program";
import { TabController, type TabControllerBrowserApi } from "@/lib/background/tab-controller";
import type { DomAction, PageSnapshot, SearchResult } from "@/lib/domain/tools";
import type { SiteEnv } from "@/lib/sites/site-api";

/** A scratch store over a slot map, standing in for the session's storage.local records. */
function memoryStore(initial: ScratchFileEntry[] = []) {
  const slots = new Map(initial.map((entry) => [entry.slot, entry]));
  const store: ScratchStore = {
    load: vi.fn(async () => [...slots.values()].map((entry) => ({ ...entry }))),
    write: vi.fn(async (entry: ScratchFileEntry) => { slots.set(entry.slot, { ...entry }); }),
    remove: vi.fn(async (slot: number) => { slots.delete(slot); }),
  };
  /** Persisted contents by path. */
  const files = () => Object.fromEntries([...slots.values()].map((entry) => [entry.path, entry.content]));
  return { store, slots, files };
}

function setup(options: { outline?: string; searchResults?: (url: string) => SearchResult[]; sites?: SiteEnv } = {}) {
  const tabs = new Map([[1, { id: 1, url: "https://example.com", title: "Example", hidden: false }]]);
  const documents = new Map<number, string>([[1, "doc-1"]]);
  const actions: DomAction[] = [];
  const abort = new AbortController();
  const snapshot = (id: number, offset: number, maxChars: number): PageSnapshot => {
    const text = options.outline ?? 'Private page text\n[e1 button "Continue"]';
    return {
      version: 2, tabId: id, documentId: documents.get(id) ?? `doc-${id}`, url: tabs.get(id)!.url, title: "Example",
      text: text.slice(offset, offset + maxChars), offset, end: Math.min(text.length, offset + maxChars), totalChars: text.length, selectionText: "",
    };
  };
  const sendMessage = vi.fn(async (id: number, message: unknown) => {
    const request = message as { type: string; action: DomAction; offset: number; maxChars: number; query: string };
    if (request.type === "page.health") return { ok: true, type: "page.health", url: tabs.get(id)!.url };
    if (request.type === "page.snapshot") return { ok: true, type: "page.snapshot", snapshot: snapshot(id, request.offset, request.maxChars) };
    if (request.type === "page.find") {
      return { ok: true, type: "page.find", result: { documentId: documents.get(id) ?? `doc-${id}`, url: tabs.get(id)!.url, query: request.query, count: 1, matches: [{ offset: 0, text: '[e1 button "Continue"]' }] } };
    }
    if (request.type === "page.search-results") {
      return { ok: true, type: "page.search-results", results: options.searchResults?.(tabs.get(id)!.url) ?? [], url: tabs.get(id)!.url, excerpt: "No results." };
    }
    actions.push(request.action);
    return { ok: true, type: "page.execute", result: { ok: true, summary: "Clicked.\nPage changes (+1 −0 lines):\n+ Done" }, documentId: documents.get(id) ?? `doc-${id}` };
  });
  let nextId = 2;
  let lastUpdated = 1;
  const api: TabControllerBrowserApi = { tabs: {
    query: vi.fn(async () => [...tabs.values()]),
    update: vi.fn(async (id, { url }) => { lastUpdated = id; tabs.get(id)!.url = url; documents.set(id, `doc-${id}-${url}`); }),
    goBack: vi.fn(async () => {}), sendMessage,
    create: vi.fn(async ({ url }) => { const tab = { id: nextId++, url, title: "Agent", hidden: false }; tabs.set(tab.id, tab); return tab; }),
    hide: vi.fn(async (id) => { tabs.get(id)!.hidden = true; return [id]; }),
    show: vi.fn(async (id) => { tabs.get(id)!.hidden = false; }),
    remove: vi.fn(async (id) => { tabs.delete(id); }),
    onUpdated: { addListener: vi.fn((listener) => setTimeout(() => listener(lastUpdated, { status: "complete" }, {}), 0)), removeListener: vi.fn() },
  } };
  const effect = vi.fn();
  const state = new WorkspaceState();
  const scratch = memoryStore();
  const files = new ScratchFiles(scratch.store);
  const controller = new TabController(api);
  const program = new BrowserProgram(controller, { state, sessionId: "s1", files, sites: options.sites }, effect);
  const run = (source: string) => program.execute(source, abort.signal);
  return { run, tabs, actions, api, effect, state, scratch, files, controller, abort, sendMessage, program, documents };
}

describe("browser program boundary", () => {
  it.each([
    'const tabs = await fs.list("/tabs"); const agentTabs = await fs.list("/agent-tabs"); return JSON.stringify({tabs, agentTabs});',
    'const tabs = fs.list("/tabs"); const agentTabs = fs.list("/agent-tabs"); return [tabs, agentTabs];',
    'return {"tabs": fs.list("/tabs"), "agentTabs": fs.list("/agent-tabs")};',
  ])("accepts directory-list combinations: %s", async (source) => {
    const { run } = setup();
    const result = await run(source);
    expect(result.ok, result.summary).toBe(true);
    expect(result.summary).toContain("/tabs/1/page.md");
  });

  it("distinguishes an unreadable tab from invalid filesystem syntax", async () => {
    const { run, sendMessage } = setup();
    sendMessage.mockRejectedValue(new Error("No receiving end"));
    const result = await run('return await fs.read("/tabs/1/page.md");');
    expect(result.ok).toBe(false);
    expect(result.code).toBe("TAB_CHANGED");
    expect(result.summary).toContain("/tabs/1/page.md");
    expect(result.summary).toContain("do not open a duplicate");
    expect((await run('return fs.list("/tabs");')).ok).toBe(true);
  });

  it("preserves nested call ordering and stops after a failed filesystem read", async () => {
    const { run, scratch } = setup();
    const result = await run('return [fs.write("/workspace/before", "yes"), fs.read("/workspace/missing"), fs.write("/workspace/after", "no")];');
    expect(result.ok).toBe(false);
    expect(scratch.files()).toEqual({ "/workspace/before": "yes" });
    expect(result.summary).toContain("Stopped in statement 1");
    expect(result.data).toMatchObject({ diagnostic: expect.stringContaining("File does not exist") });
  });

  it("bounds shared-value expansion and keeps JSON a closed capability", async () => {
    const { run } = setup();
    expect((await run('const x = ["a"];')).ok).toBe(true);
    let result = await run('const x = [x, x];');
    for (let i = 0; i < 20 && result.ok; i++) result = await run('const x = [x, x]; return x;');
    expect(result.code).toBe("LIMIT_EXCEEDED");
    for (const source of ['return JSON.parse("{}");', 'const JSON = {kind: "json"};', 'return {constructor: JSON};']) {
      expect((await run(source)).ok).toBe(false);
    }
  });

  it.each([
    'await fs.write("/workspace/x", "x"); fetch("https://evil.example");',
    'browser.constructor("return globalThis")();', 'while (true) {}',
    'import("node:fs");', 'return globalThis.browser();', 'return fs["read"]("/workspace/x");',
    'return {__proto__: {}};', 'return (() => 1)();',
    'return browser.tab("/tabs/1/page.md").evaluate("alert(1)");',
    'return browser.tab("/tabs/1/page.md").locator("#email");',
    'return fs.read(`/workspace/x`);',
    'await fs.list("/");'.repeat(33),
  ])("rejects unsupported source before executing anything: %s", async (source) => {
    const { run, scratch, effect } = setup();
    expect(() => parseProgram(source)).toThrow();
    expect((await run(source)).ok).toBe(false);
    expect(scratch.slots.size).toBe(0);
    expect(effect).not.toHaveBeenCalled();
  });

  it("does not turn user-created objects into capabilities", async () => {
    const { run, actions } = setup();
    const result = await run('const fake = {kind: "page", tabId: 1}; await fake.navigate("https://example.com");');
    expect(result.ok).toBe(false);
    expect(actions).toHaveLength(0);
  });
});

describe("browser program output", () => {
  it("prints returns and bare expression statements but not assignments or duplicate snapshots", async () => {
    const { run } = setup();
    const result = await run('const page = browser.tab("/tabs/1/page.md"); const before = await page.snapshot(); await page.ref("e1").click(); return await page.find("Continue");');
    expect(result.ok, result.summary).toBe(true);
    expect(result.summary).not.toContain("Private page text");
    expect(result.summary).toContain("[3] Clicked.");
    expect(result.summary).toContain('[4] 1 match for "Continue" in /tabs/1/page.md');
    expect(result.summary).not.toContain("<page");
  });

  it("renders objects of page text as readable sections", async () => {
    const { run } = setup();
    const result = await run('const page = browser.tab("/tabs/1/page.md"); return {first: page.snapshot(), note: "x"};');
    expect(result.summary).toContain("── first ──\n# Example\nURL: https://example.com");
    expect(result.summary).toContain("Document: doc-1");
    expect(result.summary).toContain("── note ──\nx");
  });

  it("keeps the head of oversized output and states how much was cut", async () => {
    const { run } = setup({ outline: "x".repeat(39_000) });
    const result = await run('const page = browser.tab("/tabs/1/page.md"); return [page.snapshot({maxChars: 39000}), page.snapshot({maxChars: 39000})];');
    expect(result.ok).toBe(true);
    expect(result.summary.startsWith("── 0 ──\n# Example")).toBe(true);
    expect(result.summary).toMatch(/\[Output truncated: \d+ characters omitted \(limit 40000\)/);
    expect(result.summary.length).toBeLessThan(40_400);
  });

  it("pages snapshots and tells the model how to continue", async () => {
    const { run } = setup({ outline: "line one\nline two\n".repeat(200) });
    const result = await run('return browser.tab("/tabs/1/page.md").snapshot({offset: 0, maxChars: 500});');
    expect(result.summary).toContain("[Showing characters 0–500 of 3600. Continue with snapshot({offset: 500})");
    expect((await run('return browser.tab("/tabs/1/page.md").snapshot({mode: "interactive"});')).summary).toContain("Unsupported snapshot option mode");
    expect((await run('return browser.tab("/tabs/1/page.md").snapshot({maxChars: 99999});')).ok).toBe(false);
  });
});

describe("browser program targeting", () => {
  it("binds refs to the document whose outline the model last read", async () => {
    const { run, actions } = setup();
    const unread = await run('await browser.tab("/tabs/1/page.md").ref("e1").click();');
    expect(unread).toMatchObject({ ok: false, code: "STALE_SNAPSHOT" });
    expect(actions).toHaveLength(0);
    expect((await run('const page = browser.tab("/tabs/1/page.md"); await page.snapshot(); await page.ref("e1").click(); await page.ref("e1").fill("x");')).ok).toBe(true);
    expect(actions).toEqual([
      { kind: "click", target: { kind: "ref", ref: "e1", documentId: "doc-1" } },
      { kind: "fill", target: { kind: "ref", ref: "e1", documentId: "doc-1" }, text: "x" },
    ]);
  });

  it("invalidates refs after navigation until the new page is read", async () => {
    const { run, actions } = setup();
    await run('const page = browser.tab("/tabs/1/page.md"); await page.snapshot();');
    const result = await run('await page.navigate("https://example.com/next"); await page.ref("e1").click();');
    expect(result).toMatchObject({ ok: false, code: "STALE_SNAPSHOT" });
    expect(result.summary).toContain("Navigated to https://example.com/next");
    expect(actions).toHaveLength(0);
    expect((await run('await page.find("Continue"); await page.ref("e1").click();')).ok).toBe(true);
    expect(actions[0]).toMatchObject({ target: { documentId: "doc-1-https://example.com/next" } });
  });

  it("sends role and text locators for fresh resolution, with relaxed defaults", async () => {
    const { run, actions } = setup();
    expect((await run('const page = browser.tab("/tabs/1/page.md"); await page.getByRole("button", {name: "Cont"}).click(); await page.getByRole("textbox").fill("a"); await page.getByText("Save", {exact: true}).click(); await page.getByRole("combobox", {name: "Country"}).selectOption("Canada"); await page.getByRole("checkbox", {name: "Agree"}).check();')).ok).toBe(true);
    expect(actions.map((action) => action.kind === "scroll" ? null : action.target)).toEqual([
      { kind: "role", role: "button", name: "Cont", exact: false },
      { kind: "role", role: "textbox", name: null, exact: false },
      { kind: "role", role: "*", name: "Save", exact: true },
      { kind: "role", role: "combobox", name: "Country", exact: false },
      { kind: "role", role: "checkbox", name: "Agree", exact: false },
    ]);
    expect(actions[3]).toMatchObject({ values: ["Canada"] });
    expect(actions[4]).toMatchObject({ checked: true });
    expect((await run('await page.getByRole("button", {label: "x"}).click();')).summary).toContain("Unsupported getByRole() option label");
  });

  it("attaches only /workspace scratch files", async () => {
    const { run, actions } = setup();
    expect((await run('await fs.write("/workspace/report.csv", "a,b"); const page = browser.tab("/tabs/1/page.md"); await page.getByRole("file").setInputFiles("/workspace/report.csv");')).ok).toBe(true);
    expect(actions[0]).toMatchObject({ kind: "upload", files: [{ name: "report.csv", mimeType: "text/csv", text: "a,b" }] });
    expect((await run('await page.getByRole("file").setInputFiles("/etc/passwd");')).summary).toContain("Only /workspace scratch files");
    expect((await run('await page.getByRole("file").setInputFiles("/workspace/missing.txt");')).summary).toContain("does not exist");
    expect(actions).toHaveLength(1);
  });

  it("stops on a failed action and preserves prior effects without executing later calls", async () => {
    const { run, actions, sendMessage } = setup();
    sendMessage.mockImplementationOnce(async () => ({ ok: true, type: "page.execute", result: { ok: true, summary: "Clicked." }, documentId: "doc-1" }));
    sendMessage.mockImplementationOnce(async () => ({ ok: true, type: "page.execute", result: { ok: false, code: "TARGET_MISSING", summary: "Locator button matched 0 elements." }, documentId: "doc-1" }));
    const result = await run('const page = browser.tab("/tabs/1/page.md"); await page.getByRole("button", {name: "A"}).click(); await page.getByRole("button", {name: "Missing"}).click(); await page.getByRole("button", {name: "C"}).click();');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("2 statements completed");
    expect(result.summary).toContain("matched 0 elements");
    expect(result.summary).toContain("Output before the failure:\n[2] Clicked.");
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(actions).toHaveLength(0);
  });

  it("does not dispatch another action after cancellation during an effect", async () => {
    const { run, abort, sendMessage } = setup();
    sendMessage.mockImplementationOnce(async () => { abort.abort(); throw new Error("Response lost"); });
    // Fill has no navigation settlement fallback, so cancellation can be observed immediately.
    const result = await run('const page = browser.tab("/tabs/1/page.md"); await page.getByRole("textbox").fill("x"); await fs.write("/workspace/no", "no");');
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ACTION_DENIED");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("browser program tabs, files, and search", () => {
  it("keeps scratch files across runs, bounds them, and rejects host paths and traversal", async () => {
    const { run, state, files, controller } = setup();
    expect((await run('await fs.write("/workspace/notes.md", "hello"); await fs.move("/workspace/notes.md", "/workspace/saved.md");')).ok).toBe(true);
    const nextRun = new BrowserProgram(controller, { state, sessionId: "s1", files }, () => {});
    expect((await nextRun.execute('return fs.read("/workspace/saved.md");', new AbortController().signal)).summary).toContain("hello");
    for (const path of ["/etc/passwd", "/workspace/../secret", "/workspace/./secret", "/workspace//secret"]) {
      expect((await run(`return fs.read(${JSON.stringify(path)});`)).ok).toBe(false);
    }
    expect((await run('await fs.remove("/workspace/saved.md");')).ok).toBe(true);
    expect(await files.paths()).toEqual([]);
  });

  it("persists each scratch-file change to one slot before reporting it, loading the session's files on first use", async () => {
    const scratch = memoryStore([{ slot: 3, path: "/workspace/kept.md", content: "from last week" }]);
    const files = new ScratchFiles(scratch.store);
    const { controller } = setup();
    const program = new BrowserProgram(controller, { state: new WorkspaceState(), sessionId: "s1", files }, () => {});
    const run = (source: string) => program.execute(source, new AbortController().signal);
    expect(scratch.store.load).not.toHaveBeenCalled();

    expect((await run('return fs.read("/workspace/kept.md");')).summary).toBe("from last week");
    expect((await run('await fs.write("/workspace/a.md", "A"); await fs.write("/workspace/a.md", "A2"); await fs.move("/workspace/kept.md", "/workspace/old.md");')).ok).toBe(true);
    expect([...scratch.slots.entries()].map(([slot, entry]) => [slot, entry.path, entry.content])).toEqual([
      [3, "/workspace/old.md", "from last week"], [0, "/workspace/a.md", "A2"],
    ]);
    expect(scratch.store.load).toHaveBeenCalledTimes(1);

    // A failed write reports no change and leaves the file as it was.
    vi.mocked(scratch.store.write).mockRejectedValueOnce(new Error("Quota exceeded"));
    const failed = await run('await fs.write("/workspace/a.md", "lost");');
    expect(failed.ok).toBe(false);
    expect(failed.summary).toContain("Could not save the workspace change");
    expect((await run('return fs.read("/workspace/a.md");')).summary).toBe("A2");

    await expect(files.write("/workspace/big.txt", "x".repeat(32_001))).rejects.toThrow("Workspace limit");
    for (let n = 2; n < 64; n++) await files.write(`/workspace/f${n}.txt`, "");
    expect((await run('return fs.write("/workspace/one-too-many.txt", "x");')).summary).toContain("64 files");
    expect(scratch.slots.size).toBe(64);
  });

  it("uploads from the run's own session workspace", async () => {
    const { controller, actions } = setup();
    const state = new WorkspaceState();
    const mine = new BrowserProgram(controller, { state, sessionId: "a", files: new ScratchFiles(memoryStore([{ slot: 0, path: "/workspace/cv.txt", content: "Mine" }]).store) }, () => {});
    const other = new BrowserProgram(controller, { state, sessionId: "b", files: new ScratchFiles() }, () => {});
    const upload = 'await browser.tab("/tabs/1/page.md").getByRole("file").setInputFiles("/workspace/cv.txt");';
    expect((await other.execute(upload, new AbortController().signal)).summary).toContain("does not exist");
    expect((await mine.execute(upload, new AbortController().signal)).ok).toBe(true);
    expect(actions).toMatchObject([{ kind: "upload", files: [{ name: "cv.txt", text: "Mine" }] }]);
  });

  it("shows a run only its own session's agent tabs, and adopts moved tabs into its session", async () => {
    const { controller, tabs, state } = setup();
    const signal = new AbortController().signal;
    const programFor = (sessionId: string) => new BrowserProgram(controller, { state, sessionId, files: new ScratchFiles() }, () => {});
    const a = programFor("a");
    const b = programFor("b");
    expect((await a.execute('const page = await browser.open("https://example.com/a"); return page.path();', signal)).summary).toBe("/agent-tabs/2/page.md");
    expect(state.agentTabs.get(2)).toMatchObject({ sessionId: "a", role: "agent" });

    const listed = (await b.execute('return [fs.list("/tabs"), fs.list("/agent-tabs")];', signal)).summary;
    expect(listed).toContain("/tabs/1/page.md");
    expect(listed).not.toContain("/2/page.md");
    for (const source of ['return fs.read("/agent-tabs/2/page.md");', 'return fs.read("/tabs/2/page.md");', 'return fs.remove("/tabs/2/page.md");', 'return fs.move("/tabs/2/page.md", "/agent-tabs/2/page.md");']) {
      const result = await b.execute(source, signal);
      expect(result.code, source).toBe("TARGET_MISSING");
    }
    expect(tabs.has(2)).toBe(true);

    expect((await b.execute('return fs.move("/tabs/1/page.md", "/agent-tabs/1/page.md");', signal)).ok).toBe(true);
    expect(state.agentTabs.get(1)).toMatchObject({ sessionId: "b", role: "agent" });
    expect((await a.execute('return fs.list("/agent-tabs");', signal)).summary).not.toContain("/1/page.md");
  });

  it("opens hidden agent tabs, moves them into user tabs and closes exact targets", async () => {
    const { run, tabs, state, api } = setup();
    expect((await run('const page = await browser.open("https://example.com/research"); return page.path();')).summary).toContain("/agent-tabs/2/page.md");
    expect(tabs.get(2)?.hidden).toBe(true);
    expect((await run('return fs.list("/agent-tabs");')).summary).toContain("research");
    expect((await run('await fs.move("/agent-tabs/2/page.md", "/tabs/2/page.md");')).ok).toBe(true);
    expect(tabs.get(2)?.hidden).toBe(false);
    expect((await run('await fs.read("/agent-tabs/2/page.md");')).ok).toBe(false);
    expect((await run('await fs.remove("/tabs/2/page.md");')).ok).toBe(true);
    expect(api.tabs.remove).toHaveBeenCalledWith(2);
    expect(tabs.has(1)).toBe(true);
    expect(state.agentTabs.size).toBe(0);
  });

  it("reports a newly created tab if hiding fails so it is not orphaned", async () => {
    const { run, api, state } = setup();
    vi.mocked(api.tabs.hide!).mockResolvedValue([]);
    const result = await run('await browser.open("https://example.com");');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("/agent-tabs/2/page.md");
    expect(state.agentTabs.has(2)).toBe(true);
  });

  it("searches the web in one reusable hidden tab and falls back to a second engine", async () => {
    const { run, api, state } = setup({
      searchResults: (url) => url.includes("bing.com") || url.includes("box+office") || url.includes("box%20office")
        ? [{ title: "2020 Worldwide Box Office", url: "https://www.boxofficemojo.com/year/world/2020/", snippet: "Top grossing" }]
        : [],
    });
    const first = await run('return web.search("box office 2020");');
    expect(first.ok, first.summary).toBe(true);
    expect(first.summary).toContain("via DuckDuckGo");
    expect(first.summary).toContain("1. 2020 Worldwide Box Office\n   https://www.boxofficemojo.com/year/world/2020/\n   Top grossing");
    expect(api.tabs.create).toHaveBeenCalledTimes(1);
    expect(state.agentTabs.get(state.searchTab("s1")!)).toMatchObject({ sessionId: "s1", role: "search" });
    const second = await run('return web.search("obscure query");');
    expect(api.tabs.create).toHaveBeenCalledTimes(1);
    expect(second.summary).toContain("via Bing");
    // Another session gets its own search tab rather than seeing this one.
    const other = new BrowserProgram(new TabController(api), { state, sessionId: "s2", files: new ScratchFiles() }, () => {});
    expect((await other.execute('return web.search("box office 2020");', new AbortController().signal)).ok).toBe(true);
    expect(api.tabs.create).toHaveBeenCalledTimes(2);
    expect(state.searchTab("s2")).not.toBe(state.searchTab("s1"));
  });
});

/** A YouTube player backend whose responses wait `delay` ms, abort with their signal, and count overlapping requests. */
function playerSites(delay: (videoId: string) => number = () => 5) {
  let active = 0;
  const stats = { maxActive: 0, aborted: [] as string[] };
  const sites: SiteEnv = {
    cookie: async () => null,
    now: () => 0,
    fetch: async (_url, init) => {
      const videoId = JSON.parse(init.body as string).videoId as string;
      active++;
      stats.maxActive = Math.max(stats.maxActive, active);
      try {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { clearTimeout(timer); stats.aborted.push(videoId); reject(init.signal!.reason); };
          const timer = setTimeout(() => { init.signal?.removeEventListener("abort", onAbort); resolve(); }, delay(videoId));
          init.signal?.addEventListener("abort", onAbort, { once: true });
        });
      } finally { active--; }
      const body = videoId.startsWith("missing")
        ? { playabilityStatus: { status: "ERROR", reason: "Video unavailable" } }
        : { videoDetails: { videoId, title: `Title ${videoId}` } };
      return new Response(JSON.stringify(body));
    },
  };
  return { sites, stats };
}

describe("browser program values", () => {
  it("reads properties, indexes, and lengths of returned values", async () => {
    const { run } = setup();
    await run('const listing = fs.list("/tabs"); const words = ["alpha", "beta"]; const record = {"a b": 1};');
    expect((await run('return listing.entries[0].path;')).summary).toBe("/tabs/1/page.md");
    expect((await run('return [words.length, words[1], words[1].length, words[1][0], words[5], listing.missing, record["a b"]];')).summary)
      .toBe('[2,"beta",4,"b",null,null,1]');
    expect((await run('return fs.list("/tabs").entries.length;')).summary).toBe("1");
  });

  it.each([
    ['return fs.path;', "Capability handles have no properties"],
    ['const w = ["a"]; return w.first;', "Arrays and strings support [index] and .length"],
    ['const n = null; return n.x;', "Cannot read \"x\" of null"],
    ['const r = {}; return r["constructor"];', "Invalid property name"],
    ['const r = {}; return r[true];', "Index with a number or string"],
  ])("rejects unsafe or invalid reads: %s", async (source, message) => {
    const { run } = setup();
    const result = await run(source);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain(message);
  });

  it("reads single-quoted strings like JavaScript", async () => {
    const [statement] = parseProgram(`return ['site:x.com "little guy"', 'it\\'s', "it\\'s", '\\u0041\\n'];`);
    expect(statement?.expression).toEqual({ type: "array", values: ['site:x.com "little guy"', "it's", "it's", "A\n"].map((value) => ({ type: "literal", value })) });
    const { run } = setup();
    expect((await run("const r = {'a b': 1}; return r['a b'];")).summary).toBe("1");
    expect(() => parseProgram("return 'unterminated;")).toThrow("Unsupported syntax");
  });

  it("joins strings and adds numbers with + like JavaScript", async () => {
    const { run } = setup();
    expect((await run(`const domain = "x.com"; return 'site:' + domain + ' "little guy"';`)).summary).toBe('site:x.com "little guy"');
    expect((await run('return 1 + 2 + "a" + 1 + 2;')).summary).toBe("3a12");
    expect((await run('return {offset: 16000 + 16000};')).summary).toBe('{"offset":32000}');
    expect((await run('const listing = fs.list("/tabs"); return listing.entries[0].path + " of " + listing.entries.length;')).summary)
      .toBe("/tabs/1/page.md of 1");
    for (const source of ['return "a" +;', 'return + "a";', 'return "a" ++ "b";']) expect(() => parseProgram(source), source).toThrow();
  });

  it.each([
    ['return "a" + null;', "got null (a missing key reads as null)"],
    ['const r = {}; return "a" + r.title;', "got null"],
    ['return "a" + true;', "got a boolean"],
    ['return "a" + [1];', "got an array"],
    ['return "a" + {};', "got an object"],
    ['return "a" + fs;', "got <fs>"],
  ])("rejects + on values other than strings and numbers: %s", async (source, message) => {
    const result = await setup().run(source);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain(message);
  });

  it("bounds strings built with +", async () => {
    const { run } = setup();
    const result = await run(`const s = "${"x".repeat(1000)}";${" const s = s + s;".repeat(9)}`);
    expect(result.code).toBe("LIMIT_EXCEEDED");
    expect(result.summary).toContain("9 statements completed");
  });

  it("destructures arrays like JavaScript", async () => {
    const { run } = setup();
    expect((await run('const [a, , c, d] = ["x", "y", "z"]; return {a, c, d};')).summary).toBe('{"a":"x","c":"z","d":null}');
    expect((await run('let [first,] = [1, 2]; return first;')).summary).toBe("1");
    const result = await run('const [x] = "text";');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("Destructuring needs an array");
    for (const source of ['const [] = [1];', 'const [,] = [1];', 'const [a, a] = [1, 2];', 'const [fs] = [1];', 'const [a b] = [1];', 'const [...a] = [1];', 'return [a] = [1];']) {
      expect(() => parseProgram(source), source).toThrow();
    }
  });

  it("rejects prototype keys and reserved names at parse time", () => {
    for (const source of ['return fs.list("/").__proto__;', 'const r = {}; return r.prototype;', 'const youtube = 1;', 'const Promise = 1;']) {
      expect(() => parseProgram(source), source).toThrow();
    }
  });
});

describe("browser program concurrency", () => {
  it("runs Promise.all items concurrently and keeps their order", async () => {
    const { sites, stats } = playerSites((id) => id === "aaaaaaaaaaa" ? 20 : 1);
    const { run } = setup({ sites });
    const result = await run('const both = await Promise.all([youtube.getMetadata("aaaaaaaaaaa"), youtube.getMetadata("bbbbbbbbbbb")]); return [both[0].title, both[1].title];');
    expect(result.ok, result.summary).toBe(true);
    expect(result.summary).toBe('["Title aaaaaaaaaaa","Title bbbbbbbbbbb"]');
    expect(stats.maxActive).toBe(2);
    expect((result.data as { visited: string[] }).visited).toEqual(["https://www.youtube.com/watch?v=aaaaaaaaaaa", "https://www.youtube.com/watch?v=bbbbbbbbbbb"]);
  });

  it("destructures Promise.all results into variables", async () => {
    const { sites } = playerSites();
    const { run } = setup({ sites });
    const result = await run('const [a, b] = await Promise.all([youtube.getMetadata("aaaaaaaaaaa"), youtube.getMetadata("bbbbbbbbbbb")]); return [a.title, b.title];');
    expect(result.summary, result.summary).toBe('["Title aaaaaaaaaaa","Title bbbbbbbbbbb"]');
    // Bindings persist across programs like other variables.
    expect((await run("return b.title;")).summary).toBe("Title bbbbbbbbbbb");
  });

  it("caps concurrency and accepts an array of values already computed", async () => {
    const { sites, stats } = playerSites();
    const { run } = setup({ sites });
    const ids = Array.from({ length: 10 }, (_, i) => `video${String(i).padStart(6, "0")}`);
    const result = await run(`const all = await Promise.all([${ids.map((id) => `youtube.getMetadata("${id}")`).join(", ")}]); return all.length;`);
    expect(result.summary).toBe("10");
    expect(stats.maxActive).toBe(8);
    expect((await run('const xs = [1, 2]; return Promise.all(xs);')).summary).toBe("[1,2]");
  });

  it("cancels the remaining items when one fails and says which finished", async () => {
    const { sites, stats } = playerSites((id) => id === "slowslowslo" ? 1000 : 1);
    const { run } = setup({ sites });
    const result = await run('const x = await Promise.all([youtube.getMetadata("fastfastfas"), youtube.getMetadata("missing0000"), youtube.getMetadata("slowslowslo")]);');
    expect(result.ok).toBe(false);
    expect(result.code).toBe("TARGET_MISSING");
    expect(result.summary).toContain("Promise.all item 2 of 3 failed: youtube.getMetadata: YouTube video missing0000 is unavailable: Video unavailable. Items 1 finished; the others were cancelled.");
    expect(stats.aborted).toEqual(["slowslowslo"]);
  });

  it("serializes calls on one tab while different tabs run in parallel", async () => {
    const { run, sendMessage, tabs } = setup();
    tabs.set(2, { id: 2, url: "https://example.org", title: "Other", hidden: false });
    const original = sendMessage.getMockImplementation()!;
    const active = new Map<number, number>();
    let maxPerTab = 0;
    let maxOverall = 0;
    sendMessage.mockImplementation(async (id: number, message: unknown) => {
      active.set(id, (active.get(id) ?? 0) + 1);
      maxPerTab = Math.max(maxPerTab, active.get(id)!);
      maxOverall = Math.max(maxOverall, [...active.values()].reduce((sum, n) => sum + n, 0));
      try { await new Promise((resolve) => setTimeout(resolve, 5)); return await original(id, message); }
      finally { active.set(id, active.get(id)! - 1); }
    });
    const result = await run('const a = browser.tab("/tabs/1/page.md"); const b = browser.tab("/tabs/2/page.md"); const r = await Promise.all([a.snapshot(), a.find("Continue"), b.snapshot(), b.find("Continue")]); return r.length;');
    expect(result.ok, result.summary).toBe(true);
    expect(maxPerTab).toBe(1);
    expect(maxOverall).toBe(2);
  });

  it("gives concurrent scratch writes distinct slots", async () => {
    const { run, scratch } = setup();
    const result = await run('await Promise.all([fs.write("/workspace/a.md", "A"), fs.write("/workspace/b.md", "B"), fs.write("/workspace/c.md", "C")]);');
    expect(result.ok, result.summary).toBe(true);
    expect(scratch.files()).toEqual({ "/workspace/a.md": "A", "/workspace/b.md": "B", "/workspace/c.md": "C" });
    expect([...scratch.slots.keys()].sort()).toEqual([0, 1, 2]);
  });
});

describe("browser program site APIs", () => {
  it("passes only plain values to site APIs and fails cleanly without network access", async () => {
    const { sites } = playerSites();
    const withSites = setup({ sites });
    const handle = await withSites.run('return youtube.getMetadata(fs);');
    expect(handle.ok).toBe(false);
    expect(handle.summary).toContain("youtube.getMetadata() takes plain strings, numbers, and option objects.");
    expect((await withSites.run('return youtube.listChannels("x");')).summary).toContain("Unsupported method listChannels");
    const without = await setup().run('return youtube.getMetadata("aaaaaaaaaaa");');
    expect(without).toMatchObject({ ok: false, code: "UNSUPPORTED_PAGE" });
  });
});
