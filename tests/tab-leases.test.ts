import { describe, expect, it, vi } from "vitest";
import { BrowserProgram, ScratchFiles, TAB_IN_USE_MESSAGE, WorkspaceState } from "@/lib/background/browser-program";
import { TabController, type TabControllerBrowserApi } from "@/lib/background/tab-controller";
import type { DomAction, PageSnapshot } from "@/lib/domain/tools";

/** Two runs in different sessions, each with its own controller and program, sharing one WorkspaceState and one browser: user tab 1, and run B's own agent tab 9. */
function setup() {
  const tabs = new Map([
    [1, { id: 1, url: "https://example.com/", title: "Example", hidden: false }],
    [9, { id: 9, url: "https://example.org/", title: "Agent", hidden: true }],
  ]);
  const actions: { tabId: number; action: DomAction }[] = [];
  const snapshot = (id: number, offset: number, maxChars: number): PageSnapshot => {
    const text = 'Page text\n[e1 button "Continue"]';
    return {
      version: 2, tabId: id, documentId: `doc-${id}`, url: tabs.get(id)!.url, title: "Example",
      text: text.slice(offset, offset + maxChars), offset, end: Math.min(text.length, offset + maxChars), totalChars: text.length, selectionText: "",
    };
  };
  const sendMessage = vi.fn(async (id: number, message: unknown) => {
    const request = message as { type: string; action: DomAction; offset: number; maxChars: number };
    if (request.type === "page.health") return { ok: true, type: "page.health", url: tabs.get(id)!.url };
    if (request.type === "page.snapshot") return { ok: true, type: "page.snapshot", snapshot: snapshot(id, request.offset, request.maxChars) };
    actions.push({ tabId: id, action: request.action });
    return { ok: true, type: "page.execute", result: { ok: true, summary: "Clicked." }, documentId: `doc-${id}` };
  });
  const api: TabControllerBrowserApi = { tabs: {
    query: vi.fn(async () => [...tabs.values()]),
    update: vi.fn(async (id, { url }) => { tabs.get(id)!.url = url; }),
    goBack: vi.fn(async () => {}), sendMessage,
    create: vi.fn(async () => { throw new Error("not used"); }),
    hide: vi.fn(async (id) => { tabs.get(id)!.hidden = true; return [id]; }),
    show: vi.fn(async (id) => { tabs.get(id)!.hidden = false; }),
    remove: vi.fn(async (id) => { tabs.delete(id); }),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
  } };
  const state = new WorkspaceState();
  state.adoptTab(9, "s-b");
  const signal = new AbortController().signal;
  const runFor = (runId: string, sessionId: string) => {
    const effect = vi.fn();
    const program = new BrowserProgram(new TabController(api), { state, runId, sessionId, files: new ScratchFiles() }, effect);
    return { effect, run: (source: string) => program.execute(source, signal) };
  };
  return { api, tabs, actions, sendMessage, state, a: runFor("run-a", "s-a"), b: runFor("run-b", "s-b"), runFor };
}

const READ = 'await fs.read("/tabs/1/page.md");';

describe("user-tab leases", () => {
  it("leases a user tab to the first run that uses it, and refuses every use by another run before any effect", async () => {
    const { a, b, api, actions, sendMessage, state, tabs } = setup();
    expect((await a.run(READ)).ok).toBe(true);
    expect(state.leases.get(1)).toBe("run-a");
    const messages = sendMessage.mock.calls.length;

    for (const source of [
      READ,
      'await browser.tab("/tabs/1/page.md").snapshot();',
      'await browser.tab("/tabs/1/page.md").find("Continue");',
      'await browser.tab("/tabs/1/page.md").ref("e1").click();',
      'await browser.tab("/tabs/1/page.md").getByText("Continue").hover();',
      'await browser.tab("/tabs/1/page.md").screenshot();',
      'await browser.tab("/tabs/1/page.md").table("e1");',
      'await browser.tab("/tabs/1/page.md").navigate("https://example.com/next");',
      'await browser.tab("/tabs/1/page.md").goBack();',
      'await browser.tab("/tabs/1/page.md").savePdf("/workspace/a.pdf");',
      'await fs.remove("/tabs/1/page.md");',
      'await fs.move("/tabs/1/page.md", "/agent-tabs/1/page.md");',
    ]) {
      const result = await b.run(source);
      expect(result, source).toMatchObject({ ok: false, code: "TAB_IN_USE" });
      expect(result.summary).toContain(TAB_IN_USE_MESSAGE);
    }
    // Nothing reached the tab, and the refusals are not page effects, so they never block retry.
    expect(sendMessage.mock.calls.length).toBe(messages);
    expect(actions).toEqual([]);
    expect(b.effect).not.toHaveBeenCalled();
    expect(api.tabs.update).not.toHaveBeenCalled();
    expect(api.tabs.goBack).not.toHaveBeenCalled();
    expect(api.tabs.remove).not.toHaveBeenCalled();
    expect(api.tabs.hide).not.toHaveBeenCalled();
    expect(tabs.get(1)!.hidden).toBe(false);
    expect(state.leases.get(1)).toBe("run-a");
  });

  it("keeps earlier effects and stops at the refused call, also inside Promise.all", async () => {
    const { a, b, actions } = setup();
    await a.run(READ);
    const result = await b.run('const mine = browser.tab("/agent-tabs/9/page.md"); await mine.snapshot(); await mine.ref("e1").click(); await fs.read("/tabs/1/page.md"); await mine.ref("e1").click();');
    expect(result).toMatchObject({ ok: false, code: "TAB_IN_USE" });
    expect(result.summary).toContain("3 statements completed");
    expect(actions).toMatchObject([{ tabId: 9, action: { kind: "click", target: { kind: "ref", ref: "e1" } } }]);
    const parallel = await b.run('await Promise.all([fs.read("/agent-tabs/9/page.md"), fs.read("/tabs/1/page.md")]);');
    expect(parallel).toMatchObject({ ok: false, code: "TAB_IN_USE" });
  });

  it("does not count listing tabs or making a handle as use", async () => {
    const { a, b, state } = setup();
    await a.run(READ);
    expect((await b.run('fs.list("/tabs");')).ok).toBe(true);
    expect((await b.run('const page = browser.tab("/tabs/1/page.md");')).ok).toBe(true);
    expect(state.leases.get(1)).toBe("run-a");
  });

  it("leaves the session's own agent tabs alone: no lease, never refused", async () => {
    const { a, b, state } = setup();
    await a.run(READ);
    expect((await b.run('await fs.read("/agent-tabs/9/page.md"); await browser.tab("/agent-tabs/9/page.md").ref("e1").click();')).ok).toBe(true);
    expect(state.leases.has(9)).toBe(false);
  });

  it("lets another run use the tab once the holder's leases are released at its terminal state", async () => {
    const { a, b, state } = setup();
    await a.run(READ);
    expect((await b.run(READ)).code).toBe("TAB_IN_USE");
    state.releaseRunLeases("run-a");
    expect((await b.run(READ)).ok).toBe(true);
    expect(state.leases.get(1)).toBe("run-b");
  });

  it("leases per run, not per session: the session's next run re-acquires", async () => {
    const { a, runFor, state } = setup();
    await a.run(READ);
    const next = runFor("run-a2", "s-a");
    expect((await next.run(READ)).code).toBe("TAB_IN_USE");
    state.releaseRunLeases("run-a");
    expect((await next.run(READ)).ok).toBe(true);
    expect(state.leases.get(1)).toBe("run-a2");
  });

  it("drops the lease when the holder closes the tab or moves it into its agent tabs", async () => {
    const closing = setup();
    await closing.a.run(READ);
    expect((await closing.a.run('await fs.remove("/tabs/1/page.md");')).ok).toBe(true);
    expect(closing.state.leases.has(1)).toBe(false);

    const moving = setup();
    expect((await moving.a.run('await fs.move("/tabs/1/page.md", "/agent-tabs/1/page.md");')).ok).toBe(true);
    expect(moving.state.leases.has(1)).toBe(false);
    expect(moving.state.agentTabs.get(1)?.sessionId).toBe("s-a");
    // It is now session A's agent tab, invisible to run B.
    expect((await moving.b.run('await fs.read("/tabs/1/page.md");')).code).toBe("TARGET_MISSING");
  });

  it("forgets a closed tab's lease", () => {
    const state = new WorkspaceState();
    expect(state.acquireLease(1, "run-a")).toBe(true);
    expect(state.acquireLease(1, "run-a")).toBe(true);
    expect(state.acquireLease(1, "run-b")).toBe(false);
    state.releaseLease(1);
    expect(state.acquireLease(1, "run-b")).toBe(true);
  });
});
