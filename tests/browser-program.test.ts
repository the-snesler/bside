import { describe, expect, it, vi } from "vitest";
import { BrowserProgram, parseProgram, WorkspaceState } from "@/lib/background/browser-program";
import { TabController, type TabControllerBrowserApi } from "@/lib/background/tab-controller";
import type { PageSnapshotV1, PageToolCall } from "@/lib/domain/tools";

function setup() {
  let revision = 0;
  const tabs = new Map([[1, { id: 1, url: "https://example.com", title: "Example", hidden: false }]]);
  const calls: PageToolCall[] = [];
  const abort = new AbortController();
  const snapshot = (id: number): PageSnapshotV1 => ({
    version: 1, tabId: id, revision: `r${++revision}`, url: tabs.get(id)!.url, origin: "https://example.com", title: "Example",
    readableText: "Private page text", selectionText: "", viewport: { width: 100, height: 100, scrollX: 0, scrollY: 0 },
    nodes: [{ ref: `e${revision}`, role: "button", name: "Continue", tag: "button", state: { disabled: false }, bounds: { x: 0, y: 0, width: 10, height: 10 }, inViewport: true }],
    truncated: { nodes: false, readableText: false }, warnings: [],
  });
  const sendMessage = vi.fn(async (id: number, message: unknown) => {
    const request = message as { type: string; call: PageToolCall };
    if (request.type === "page.health") return { ok: true, type: "page.health", url: tabs.get(id)!.url };
    if (request.type === "page.snapshot") return { ok: true, type: "page.snapshot", snapshot: snapshot(id) };
    calls.push(request.call);
    return { ok: true, type: "page.execute", result: { ok: true, summary: "Clicked." }, snapshot: snapshot(id) };
  });
  const api: TabControllerBrowserApi = { tabs: {
    query: vi.fn(async () => [...tabs.values()]),
    update: vi.fn(async () => {}), goBack: vi.fn(async () => {}), sendMessage,
    create: vi.fn(async ({ url }) => { const tab = { id: 2, url, title: "Agent", hidden: false }; tabs.set(2, tab); return tab; }),
    hide: vi.fn(async (id) => { tabs.get(id)!.hidden = true; return [id]; }),
    show: vi.fn(async (id) => { tabs.get(id)!.hidden = false; }),
    remove: vi.fn(async (id) => { tabs.delete(id); }),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
  } };
  const effect = vi.fn();
  const state = new WorkspaceState();
  const controller = new TabController(api);
  const program = new BrowserProgram(controller, state, effect);
  const run = (source: string) => program.execute(source, abort.signal);
  return { run, tabs, calls, api, effect, state, controller, abort, sendMessage };
}

describe("browser program boundary", () => {
  it.each([
    'const tabs = await fs.list("/tabs"); const agentTabs = await fs.list("/agent-tabs"); return JSON.stringify({tabs, agentTabs});',
    'const tabs = fs.list("/tabs"); const agentTabs = fs.list("/agent-tabs"); return [tabs, agentTabs];',
    'return {"tabs": fs.list("/tabs"), "agentTabs": fs.list("/agent-tabs")};',
  ])("accepts the directory-list combinations from the reported trace: %s", async (source) => {
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
    expect(result.summary).toContain("Do not open a duplicate");
    expect((await run('return fs.list("/tabs");')).ok).toBe(true);
  });

  it("preserves nested call ordering and stops after a failed filesystem read", async () => {
    const { run, state } = setup();
    const result = await run('return [fs.write("/workspace/before", "yes"), fs.read("/workspace/missing"), fs.write("/workspace/after", "no")];');
    expect(result.ok).toBe(false);
    expect(state.files.get("/workspace/before")).toBe("yes");
    expect(state.files.has("/workspace/after")).toBe(false);
    expect(result.summary).toContain("Stopped in statement 1");
    expect(result.data).toMatchObject({ diagnostic: expect.stringContaining("File does not exist") });
  });

  it("bounds shared-value expansion and keeps JSON a closed capability", async () => {
    const { run } = setup();
    expect((await run('const x = ["a"];')).ok).toBe(true);
    let result = await run('const x = [x, x];');
    for (let i = 0; i < 20 && result.ok; i++) result = await run('const x = [x, x];');
    expect(result.code).toBe("LIMIT_EXCEEDED");
    for (const source of ['return JSON.parse("{}");', 'const JSON = {kind: "json"};', 'return {constructor: JSON};']) {
      expect((await run(source)).ok).toBe(false);
    }
  });

  it.each([
    'await fs.write("/workspace/x", "x"); fetch("https://evil.example");',
    'browser.constructor("return globalThis")();', 'while (true) {}',
    'import("node:fs");', 'return globalThis.browser;', 'return fs["read"]("/workspace/x");',
    'return {__proto__: {}};', 'return (() => 1)();',
    'return browser.tab("/tabs/1/page.md").evaluate("alert(1)");',
    'await fs.list("/");'.repeat(33),
  ])("rejects unsupported source before executing anything: %s", async (source) => {
    const { run, state, effect } = setup();
    expect(() => parseProgram(source)).toThrow();
    expect((await run(source)).ok).toBe(false);
    expect(state.files.size).toBe(0);
    expect(effect).not.toHaveBeenCalled();
  });

  it("does not turn user-created objects into capabilities", async () => {
    const { run, calls } = setup();
    const result = await run('const fake = {kind: "page", tabId: 1}; await fake.navigate("https://example.com");');
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("runs multiple actions and re-resolves the locator with the current revision each time", async () => {
    const { run, calls } = setup();
    const result = await run('const page = browser.tab("/tabs/1/page.md"); const next = page.getByRole("button", {name: "Continue", exact: true}); await next.click(); await next.click(); return await page.snapshot("readable");');
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.arguments)).toEqual([{ ref: "e1", revision: "r1" }, { ref: "e3", revision: "r3" }]);
    expect(result.summary).toContain("Revision: r5");
    expect((await run('await next.click();')).ok).toBe(true);
  });

  it("stops on a missing locator and preserves prior effects without executing later calls", async () => {
    const { run, calls } = setup();
    const result = await run('const page = browser.tab("/tabs/1/page.md"); await page.getByRole("button", {name: "Continue", exact: true}).click(); await page.getByRole("button", {name: "Missing", exact: true}).click(); await page.getByRole("button", {name: "Continue", exact: true}).click();');
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("2 statements completed");
    expect(result.summary).toContain("matched 0 elements");
    expect(calls).toHaveLength(1);
  });

  it("does not dispatch another action after cancellation during an effect", async () => {
    const { run, abort, sendMessage } = setup();
    sendMessage.mockImplementationOnce(async () => ({ ok: true, type: "page.snapshot", snapshot: {
      nodes: [{ ref: "e1", role: "button", name: "Continue" }], revision: "r1", truncated: { nodes: false, readableText: false },
    } as PageSnapshotV1 }));
    sendMessage.mockImplementationOnce(async () => { abort.abort(); throw new Error("Response lost"); });
    // Fill has no navigation settlement fallback, so cancellation can be observed immediately.
    const result = await run('const page = browser.tab("/tabs/1/page.md"); await page.getByRole("button", {name: "Continue", exact: true}).fill("x"); await fs.write("/workspace/no", "no");');
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ACTION_DENIED");
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps scratch files across runs, bounds them, and rejects host paths and traversal", async () => {
    const { run, state, controller } = setup();
    expect((await run('await fs.write("/workspace/notes.md", "hello"); await fs.move("/workspace/notes.md", "/workspace/saved.md");')).ok).toBe(true);
    const nextRun = new BrowserProgram(controller, state, () => {});
    expect((await nextRun.execute('return fs.read("/workspace/saved.md");', new AbortController().signal)).summary).toContain("hello");
    for (const path of ["/etc/passwd", "/workspace/../secret", "/workspace/./secret", "/workspace//secret"]) {
      expect((await run(`return fs.read(${JSON.stringify(path)});`)).ok).toBe(false);
    }
    expect((await run('await fs.remove("/workspace/saved.md");')).ok).toBe(true);
    expect(state.files.size).toBe(0);
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
});
