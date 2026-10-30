import { beforeEach, describe, expect, it, vi } from "vitest";
import { storage } from "wxt/utils/storage";
import { BrowserProgram, parseProgram, ScratchFiles, WorkspaceState } from "@/lib/background/browser-program";
import { listMemories, runMemory } from "@/lib/background/memory";
import { saveMemorySettings } from "@/lib/storage";
import type { MemoryApproval } from "@/lib/domain/memory";
import type { ScratchFileEntry, ScratchStore } from "@/lib/background/browser-program";
import { TabController, type TabControllerBrowserApi } from "@/lib/background/tab-controller";
import type { DomAction, PageSnapshot, SearchPage } from "@/lib/domain/tools";
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
  const files = () => Object.fromEntries([...slots.values()].map((entry) => [entry.path, entry.kind === "text" ? entry.content : entry.data]));
  return { store, slots, files };
}

/** A Google results page for `url`, with `overrides`. */
function googlePage(url: string, overrides: Partial<SearchPage> = {}): SearchPage {
  return { engine: "google", engineName: "Google", url, results: [], answer: null, blocked: null, excerpt: "No results.", ...overrides };
}

function setup(options: { outline?: string; searchPage?: (url: string) => Partial<SearchPage>; sites?: SiteEnv; memory?: boolean } = {}) {
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
      const url = tabs.get(id)!.url;
      return { ok: true, type: "page.search-results", page: googlePage(url, options.searchPage?.(url)) };
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
  }, search: {
    // The user's default engine is Google here.
    query: vi.fn(async ({ text, tabId }) => {
      lastUpdated = tabId;
      tabs.get(tabId)!.url = `https://www.google.com/search?q=${encodeURIComponent(text)}`;
      documents.set(tabId, `doc-${tabId}-${text}`);
    }),
  } };
  const effect = vi.fn();
  const state = new WorkspaceState();
  const scratch = memoryStore();
  const files = new ScratchFiles(scratch.store);
  const controller = new TabController(api);
  const memory = options.memory ? runMemory("s1", "r1") : undefined;
  const program = new BrowserProgram(controller, { state, runId: "r1", sessionId: "s1", files, sites: options.sites, memory }, effect);
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
    const nextRun = new BrowserProgram(controller, { state, runId: "r1", sessionId: "s1", files }, () => {});
    expect((await nextRun.execute('return fs.read("/workspace/saved.md");', new AbortController().signal)).summary).toContain("hello");
    for (const path of ["/etc/passwd", "/workspace/../secret", "/workspace/./secret", "/workspace//secret"]) {
      expect((await run(`return fs.read(${JSON.stringify(path)});`)).ok).toBe(false);
    }
    expect((await run('await fs.remove("/workspace/saved.md");')).ok).toBe(true);
    expect(await files.paths()).toEqual([]);
  });

  it("persists each scratch-file change to one slot before reporting it, loading the session's files on first use", async () => {
    const scratch = memoryStore([{ slot: 3, path: "/workspace/kept.md", kind: "text", content: "from last week" }]);
    const files = new ScratchFiles(scratch.store);
    const { controller } = setup();
    const program = new BrowserProgram(controller, { state: new WorkspaceState(), runId: "r1", sessionId: "s1", files }, () => {});
    const run = (source: string) => program.execute(source, new AbortController().signal);
    expect(scratch.store.load).not.toHaveBeenCalled();

    expect((await run('return fs.read("/workspace/kept.md");')).summary).toBe("from last week");
    expect((await run('await fs.write("/workspace/a.md", "A"); await fs.write("/workspace/a.md", "A2"); await fs.move("/workspace/kept.md", "/workspace/old.md");')).ok).toBe(true);
    expect([...scratch.slots.entries()].map(([slot, entry]) => [slot, entry.path, entry.kind === "text" && entry.content])).toEqual([
      [3, "/workspace/old.md", "from last week"], [0, "/workspace/a.md", "A2"],
    ]);
    expect(scratch.store.load).toHaveBeenCalledTimes(1);

    // A failed write reports no change and leaves the file as it was.
    vi.mocked(scratch.store.write).mockRejectedValueOnce(new Error("Quota exceeded"));
    const failed = await run('await fs.write("/workspace/a.md", "lost");');
    expect(failed.ok).toBe(false);
    expect(failed.summary).toContain("Could not save the workspace change");
    expect((await run('return fs.read("/workspace/a.md");')).summary).toBe("A2");

    await expect(files.write("/workspace/big.txt", { kind: "text", content: "x".repeat(32_001) })).rejects.toThrow("Workspace limits");
    for (let n = 2; n < 64; n++) await files.write(`/workspace/f${n}.txt`, { kind: "text", content: "" });
    expect((await run('return fs.write("/workspace/one-too-many.txt", "x");')).summary).toContain("64 files");
    expect(scratch.slots.size).toBe(64);
  });

  it("uploads from the run's own session workspace", async () => {
    const { controller, actions } = setup();
    const state = new WorkspaceState();
    const mine = new BrowserProgram(controller, { state, runId: "r1", sessionId: "a", files: new ScratchFiles(memoryStore([{ slot: 0, path: "/workspace/cv.txt", kind: "text", content: "Mine" }]).store) }, () => {});
    const other = new BrowserProgram(controller, { state, runId: "r1", sessionId: "b", files: new ScratchFiles() }, () => {});
    const upload = 'await browser.tab("/tabs/1/page.md").getByRole("file").setInputFiles("/workspace/cv.txt");';
    expect((await other.execute(upload, new AbortController().signal)).summary).toContain("does not exist");
    expect((await mine.execute(upload, new AbortController().signal)).ok).toBe(true);
    expect(actions).toMatchObject([{ kind: "upload", files: [{ name: "cv.txt", text: "Mine" }] }]);
  });

  it("shows a run only its own session's agent tabs, and adopts moved tabs into its session", async () => {
    const { controller, tabs, state } = setup();
    const signal = new AbortController().signal;
    const programFor = (sessionId: string) => new BrowserProgram(controller, { state, runId: "r1", sessionId, files: new ScratchFiles() }, () => {});
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

  it("searches with the user's engine in one reusable hidden search tab per session", async () => {
    const { run, api, state, program } = setup({
      searchPage: (url) => url.includes("box%20office")
        ? { results: [{ title: "2020 Worldwide Box Office", url: "https://www.boxofficemojo.com/year/world/2020/", snippet: "Top grossing" }], answer: "Bad Boys for Life was the top film of 2020." }
        : {},
    });
    const first = await run('return web.search("box office 2020");');
    expect(first.ok, first.summary).toBe(true);
    expect(program.tainted).toBe(true);
    // The tab starts blank, hidden, and tagged; Firefox's search API loads the user's engine into it.
    expect(api.tabs.create).toHaveBeenCalledWith({ url: "about:blank", active: false });
    const tabId = state.searchTab("s1")!;
    expect(api.tabs.hide).toHaveBeenCalledWith(tabId);
    expect(state.agentTabs.get(tabId)).toMatchObject({ sessionId: "s1", role: "search" });
    expect(api.search!.query).toHaveBeenCalledWith({ text: "box office 2020", tabId });
    expect(first.summary).toContain(`from Google, the user's search engine (search tab /agent-tabs/${tabId}/page.md)`);
    expect(first.summary).toContain("BEGIN_UNTRUSTED_PAGE\nAnswer box: Bad Boys for Life was the top film of 2020.\n1. 2020 Worldwide Box Office\n   https://www.boxofficemojo.com/year/world/2020/\n   Top grossing\nEND_UNTRUSTED_PAGE");
    expect((first.data as { visited: string[] }).visited).toEqual(["https://www.google.com/search?q=box%20office%202020"]);

    const second = await run('return web.search("obscure query");');
    expect(api.tabs.create).toHaveBeenCalledTimes(1);
    expect(api.search!.query).toHaveBeenLastCalledWith({ text: "obscure query", tabId });
    expect(second.summary).toContain("No web results could be extracted");
    // No other engine is tried, and the tab is never navigated directly.
    expect(api.search!.query).toHaveBeenCalledTimes(2);
    expect(api.tabs.update).not.toHaveBeenCalled();

    // Another session gets its own search tab rather than seeing this one.
    const other = new BrowserProgram(new TabController(api), { state, runId: "r1", sessionId: "s2", files: new ScratchFiles() }, () => {});
    expect((await other.execute('return web.search("box office 2020");', new AbortController().signal)).ok).toBe(true);
    expect(api.tabs.create).toHaveBeenCalledTimes(2);
    expect(state.searchTab("s2")).not.toBe(tabId);
  });

  it.each([
    ["consent", "a consent page", "accept or reject its cookie consent"],
    ["captcha", "a CAPTCHA or bot check", "prove you are not a robot"],
  ] as const)("fails a search the engine blocks with a %s page and points the model at request_user_help on the search tab", async (blocked, shown, reason) => {
    const { run, api, state } = setup({ searchPage: () => ({ blocked, excerpt: "Before you continue" }) });
    const result = await run('const r = await web.search("orchids"); return r;');
    const path = `/agent-tabs/${state.searchTab("s1")}/page.md`;
    expect(result.ok).toBe(false);
    expect(result.code).toBe("UNSUPPORTED_PAGE");
    expect(result.summary).toContain(`Google (the user's search engine) is showing ${shown} instead of results in the search tab ${path}.`);
    expect(result.summary).toContain(`call request_user_help with tab "${path}", kind "verification"`);
    expect(result.summary).toContain(reason);
    expect(result.summary).toContain("Do not switch to another search engine");
    expect(api.search!.query).toHaveBeenCalledTimes(1);
    expect(api.tabs.update).not.toHaveBeenCalled();
  });

  it("says so when Firefox's search API is unavailable", async () => {
    const { run, api } = setup();
    delete api.search;
    const result = await run('return web.search("orchids");');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("Firefox's search API is unavailable");
  });

  it("reports the pages a program read, acted on, navigated, or opened, but not the search tab, for site notes", async () => {
    const { run } = setup({ searchPage: () => ({ results: [{ title: "R", url: "https://r.example/", snippet: "" }] }) });
    const pages = async (source: string) => {
      const result = await run(source);
      expect(result.ok, result.summary).toBe(true);
      return (result.data as { pages: string[] }).pages;
    };
    expect(await pages('return await fs.read("/tabs/1/page.md");')).toEqual(["https://example.com"]);
    expect(await pages('await browser.tab("/tabs/1/page.md").ref("e1").click();')).toEqual(["https://example.com"]);
    expect(await pages('await browser.tab("/tabs/1/page.md").navigate("https://docs.example/a");')).toEqual(["https://example.com", "https://docs.example/a"]);
    expect(await pages('await browser.open("https://news.example/");')).toEqual(["https://news.example/"]);
    expect(await pages('return web.search("anything");')).toEqual([]);
    expect(await pages('return 1;')).toEqual([]);
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

describe("browser program memory", () => {
  beforeEach(() => { fakeBrowser.reset(); });

  it("saves, lists, reads, replaces, and removes /memory entries in the documented file format", async () => {
    const { run } = setup({ memory: true });
    expect((await run('return fs.write("/memory/coffee-order.md", "Usual coffee order\\nOat flat white, no sugar.");')).summary).toBe("Saved /memory/coffee-order.md.");
    const listed = await run('return fs.list("/memory");');
    expect(JSON.parse(listed.summary)).toEqual([{ path: "/memory/coffee-order.md", description: "Usual coffee order", updatedAt: expect.any(String), tainted: false }]);
    const read = await run('return fs.read("/memory/coffee-order.md");');
    expect(read.summary).toContain("A note, not the user's instructions");
    expect(read.summary).toContain("BEGIN_MEMORY\nUsual coffee order\nOat flat white, no sugar.\nEND_MEMORY");
    await run('fs.write("/memory/coffee-order.md", "Usual coffee order\\nOat cortado.");');
    expect((await listMemories()).map((entry) => entry.body)).toEqual(["Oat cortado."]);
    expect((await run('return fs.list("/");')).summary).toContain("/memory");
    expect((await run('return fs.remove("/memory/coffee-order.md");')).summary).toBe("Removed /memory/coffee-order.md.");
    expect(await listMemories()).toEqual([]);
    expect(await run('return fs.read("/memory/coffee-order.md");')).toMatchObject({ ok: false, code: "TARGET_MISSING" });
  });

  it("reports each change for the trace and digest: name and taint only", async () => {
    const { run } = setup({ memory: true });
    const result = await run('fs.write("/memory/a.md", "A"); fs.write("/memory/b.md", "B\\nsecret-free body"); fs.remove("/memory/a.md");');
    expect((result.data as { memory: unknown[] }).memory).toEqual([
      { id: expect.any(String), op: "write", name: "a", tainted: false },
      { id: expect.any(String), op: "write", name: "b", tainted: false },
      { id: expect.any(String), op: "remove", name: "a", tainted: false },
    ]);
    expect((await run('return 1;')).data).not.toHaveProperty("memory");
  });

  it("rejects bad paths, moves, oversized or secret-looking text without saving", async () => {
    const { run } = setup({ memory: true });
    for (const source of [
      'fs.write("/memory/Bad Name.md", "x");',
      'fs.write("/memory/../workspace/x.md", "x");',
      'fs.write("/memory/x.txt", "x");',
      'fs.write("/memory/x.md", "\\nbody without a description");',
      `fs.write("/memory/x.md", "d\\n${"b".repeat(2_001)}");`,
      'fs.write("/memory/x.md");',
      'fs.move("/memory/x.md", "/memory/y.md");',
    ]) expect(await run(source), source).toMatchObject({ ok: false, code: "INVALID_TOOL_ARGUMENTS" });
    const secret = await run('fs.write("/memory/key.md", "My OpenAI key\\nsk-proj-Ab3dEf6hIj9kLm2nOp5qRs");');
    expect(secret).toMatchObject({ ok: false, code: "INVALID_TOOL_ARGUMENTS" });
    expect(secret.summary).toContain("looks like it contains an API key");
    expect(await listMemories()).toEqual([]);
    expect(await setup().run('return fs.list("/memory");')).toMatchObject({ ok: false, code: "UNSUPPORTED_PAGE" });
  });

  it("searches memories by name, description, and body with bounded results", async () => {
    const { run } = setup({ memory: true });
    await run('fs.write("/memory/flight-prefs.md", "How the user likes to fly\\nWindow seat, no red-eyes."); fs.write("/memory/coffee.md", "Coffee order\\nFlat white");');
    const hits = JSON.parse((await run('return memory.search("window seat");')).summary);
    expect(hits).toEqual([{ path: "/memory/flight-prefs.md", name: "flight-prefs", description: "How the user likes to fly", tainted: false, updatedAt: expect.any(String), excerpt: "Window seat, no red-eyes." }]);
    expect(JSON.parse((await run('return memory.search("o", 1);')).summary)).toHaveLength(1);
    for (const source of ['memory.search("");', 'memory.search("x", 21);', 'memory.list();', 'memory.search(fs);']) {
      expect((await run(source)).ok, source).toBe(false);
    }
    expect(() => parseProgram('const memory = 1;')).toThrow("Reserved variable name.");
  });

  it("marks changes tainted once the run read a page, site API, or tainted memory, and keeps it for the run", async () => {
    const clean = setup({ memory: true });
    await clean.run('fs.write("/memory/before.md", "Before");');
    await clean.run('const page = browser.tab("/tabs/1/page.md"); page.snapshot();');
    await clean.run('fs.write("/memory/after.md", "After");');
    expect(Object.fromEntries((await listMemories()).map((entry) => [entry.name, entry.provenance.by === "agent" && entry.provenance.tainted]))).toEqual({ before: false, after: true });

    // A fresh run that reads the tainted memory is tainted too.
    const reader = setup({ memory: true });
    await reader.run('fs.read("/memory/before.md");');
    await reader.run('fs.write("/memory/copy.md", "Copy");');
    expect((await listMemories()).find((entry) => entry.name === "copy")?.provenance).toMatchObject({ tainted: false });
    await reader.run('fs.read("/memory/after.md");');
    await reader.run('fs.write("/memory/copy.md", "Copy");');
    expect((await listMemories()).find((entry) => entry.name === "copy")?.provenance).toMatchObject({ tainted: true });

    const titles = setup({ memory: true });
    await titles.run('fs.list("/tabs");');
    expect(titles.program.tainted).toBe(true);
    const site = setup({ memory: true, sites: playerSites().sites });
    await site.run('youtube.search("cats");');
    expect(site.program.tainted).toBe(true);
    const marked = setup({ memory: true });
    marked.program.taint();
    expect((await marked.run('fs.write("/memory/x.md", "X");')).data).toMatchObject({ memory: [{ name: "x", tainted: true }] });
  });

  it("refuses every change while the user's policy is off, but still reads and searches", async () => {
    const { run } = setup({ memory: true });
    await run('fs.write("/memory/kept.md", "Kept");');
    await saveMemorySettings({ version: 1, writes: "off" });
    for (const source of ['fs.write("/memory/new.md", "New");', 'fs.remove("/memory/kept.md");']) {
      const result = await run(source);
      expect(result).toMatchObject({ ok: false, code: "ACTION_DENIED" });
      expect(result.summary).toContain("turned memory saving off");
    }
    expect((await listMemories()).map((entry) => entry.name)).toEqual(["kept"]);
    expect((await run('return fs.read("/memory/kept.md");')).ok).toBe(true);
    expect((await run('return memory.search("kept");')).ok).toBe(true);
  });

  it("puts each change to the user under the ask policy, and changes nothing when they decline", async () => {
    await saveMemorySettings({ version: 1, writes: "ask" });
    const { program, abort } = setup({ memory: true });
    const asked: MemoryApproval[] = [];
    const decide = (approved: boolean) => ({ confirmMemory: async (change: MemoryApproval) => { asked.push(change); return approved; } });
    const declined = await program.execute('fs.write("/memory/seat.md", "Seat\\nWindow");', abort.signal, decide(false));
    expect(declined).toMatchObject({ ok: false, code: "ACTION_DENIED" });
    expect(declined.summary).toContain("The user declined saving /memory/seat.md");
    expect(await listMemories()).toEqual([]);
    expect((await program.execute('fs.write("/memory/seat.md", "Seat\\nWindow"); fs.write("/memory/seat.md", "Seat\\nAisle");', abort.signal, decide(true))).ok).toBe(true);
    expect((await program.execute('fs.remove("/memory/seat.md");', abort.signal, decide(true))).ok).toBe(true);
    expect(asked).toEqual([
      { op: "write", name: "seat", description: "Seat", body: "Window", replaces: false, tainted: false },
      { op: "write", name: "seat", description: "Seat", body: "Window", replaces: false, tainted: false },
      { op: "write", name: "seat", description: "Seat", body: "Aisle", replaces: true, tainted: false },
      { op: "remove", name: "seat", description: "Seat", body: "Aisle", replaces: false, tainted: false },
    ]);
    // Nothing to ask about: a missing entry, or invalid text, fails first.
    expect(await program.execute('fs.remove("/memory/seat.md");', abort.signal, decide(true))).toMatchObject({ ok: false, code: "TARGET_MISSING" });
    expect((await program.execute('fs.write("/memory/key.md", "Key\\nsk-proj-Ab3dEf6hIj9kLm2nOp5qRs");', abort.signal, decide(true))).code).toBe("INVALID_TOOL_ARGUMENTS");
    expect(asked).toHaveLength(4);
    // Without a way to ask, nothing is saved.
    expect(await program.execute('fs.write("/memory/x.md", "X");', abort.signal)).toMatchObject({ ok: false, code: "ACTION_DENIED" });
  });

  it("gives concurrent memory writes their own slots", async () => {
    const { run } = setup({ memory: true });
    await run('Promise.all([fs.write("/memory/a.md", "A"), fs.write("/memory/b.md", "B"), fs.write("/memory/c.md", "C")]);');
    expect((await listMemories()).map((entry) => entry.name).toSorted()).toEqual(["a", "b", "c"]);
    expect((await Promise.all([0, 1, 2].map((slot) => storage.getItem(`local:memory:${slot}`)))).every(Boolean)).toBe(true);
  });
});
