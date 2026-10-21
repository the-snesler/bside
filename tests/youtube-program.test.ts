import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserProgram, parseProgram, ScratchFiles, WorkspaceState } from "@/lib/background/browser-program";
import { BUILTIN_SKILLS } from "@/lib/background/skills";
import { TabController, type TabControllerBrowserApi } from "@/lib/background/tab-controller";
import type { YouTubeRequest, YouTubeResult } from "@/lib/domain/youtube";
import { isPageYouTubeRequest } from "@/lib/protocol";

function setup(read: (request: YouTubeRequest) => YouTubeResult = () => ({ status: "ready", data: { title: "Untrusted title", loadedOnly: true } })) {
  const state = new WorkspaceState();
  const tabs: { id: number; url: string; hidden: boolean }[] = [];
  const requests: YouTubeRequest[] = [];
  const abort = new AbortController();
  vi.spyOn(TabController.prototype, "waitUntilReady").mockResolvedValue();
  const api: TabControllerBrowserApi = { tabs: {
    query: vi.fn(async () => tabs),
    create: vi.fn(async ({ url }) => { const tab = { id: tabs.length + 1, url, hidden: false }; tabs.push(tab); return tab; }),
    hide: vi.fn(async (id) => { tabs[id - 1]!.hidden = true; return [id]; }),
    update: vi.fn(async () => {}), goBack: vi.fn(async () => {}),
    sendMessage: vi.fn(async (_id, message) => {
      if (!isPageYouTubeRequest(message)) throw new Error("Bad request");
      requests.push(message.request);
      return { v: 1, id: message.id, type: "page.youtube", ok: true, result: read(message.request) };
    }),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
  } };
  const effect = vi.fn();
  const program = new BrowserProgram(new TabController(api), { state, sessionId: "youtube-session", files: new ScratchFiles() }, effect);
  return { state, api, tabs, requests, effect, abort, run: (source: string) => program.execute(source, abort.signal) };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("YouTube interpreted capability", () => {
  it("reuses a session-owned hidden tab and wraps compact data as untrusted", async () => {
    const s = setup();
    const first = await s.run('return await youtube.getMetadata("https://youtu.be/jNQXAC9IVRw");');
    const next = await s.run('return await youtube.getTranscript("jNQXAC9IVRw", {offset: 3, limit: 4});');
    expect(first.ok, first.summary).toBe(true);
    expect(next.ok, next.summary).toBe(true);
    expect(first.summary).toContain("BEGIN_UNTRUSTED_PAGE");
    expect(first.summary).toContain("/agent-tabs/1/page.md");
    expect(first.data).toMatchObject({ visited: expect.arrayContaining(["https://www.youtube.com/watch?v=jNQXAC9IVRw"]) });
    expect(s.api.tabs.create).toHaveBeenCalledTimes(1);
    expect(s.tabs[0]!.hidden).toBe(true);
    expect(s.state.agentTabs.get(1)?.sessionId).toBe("youtube-session");
    expect(s.requests[1]).toMatchObject({ operation: "transcript", offset: 3, limit: 4 });
  });

  it.each([
    'youtube.getMetadata("bad")',
    'youtube.getMetadata("https://youtube.com.evil.test/watch?v=jNQXAC9IVRw")',
    'youtube.getMetadata("http://www.youtube.com/watch?v=jNQXAC9IVRw")',
    'youtube.getMetadata("https://www.youtube.com/watch?v=bad")',
    'youtube.search("")',
    'youtube.search("query", {limit: 11})',
    'youtube.getComments("jNQXAC9IVRw", {limit: 21})',
    'youtube.getTranscript("jNQXAC9IVRw", {limit: 101})',
    'youtube.getTranscript("jNQXAC9IVRw", {offset: -1})',
    'youtube.getTranscript("jNQXAC9IVRw", {lang: "en"})',
    'youtube.getTranscript("jNQXAC9IVRw", browser)',
    'youtube.getMetadata("jNQXAC9IVRw", {})',
    'youtube.open("https://example.com")',
  ])("rejects invalid calls before opening tabs: %s", async (source) => {
    const s = setup();
    expect((await s.run(`return ${source};`)).ok).toBe(false);
    expect(s.api.tabs.create).not.toHaveBeenCalled();
  });

  it("encodes queries rather than accepting navigation targets", async () => {
    const s = setup();
    expect((await s.run('return youtube.search("a&b #c", {limit: 2, offset: 4});')).ok).toBe(true);
    expect(s.tabs[0]!.url).toBe("https://www.youtube.com/results?search_query=a%26b%20%23c");
  });

  it("executes each fixed preparation stage once and waits on data, not labels", async () => {
    vi.useFakeTimers();
    let n = 0;
    const s = setup((request) => {
      const performed = request.action === "read" ? {} : { performed: request.action };
      return ++n < 3 ? { status: "pending", action: "expand", message: "Expand", ...performed } : n < 5 ? { status: "pending", action: "open-transcript", message: "Open", ...performed } : { status: "ready", data: { segments: [{ startSeconds: 1, text: "Hello" }] } };
    });
    const promise = s.run('return youtube.getTranscript("jNQXAC9IVRw");');
    await vi.runAllTimersAsync();
    expect((await promise).ok).toBe(true);
    expect(s.requests.map((r) => r.action)).toEqual(["read", "expand", "read", "open-transcript", "read"]);
    expect(s.effect).toHaveBeenCalledTimes(3);
  });

  it("cancels polling before a queued DOM action and preserves the owned tab", async () => {
    vi.useFakeTimers();
    const s = setup(() => { s.abort.abort(); return { status: "pending", action: "expand", message: "Expand" }; });
    const result = await s.run('return youtube.getTranscript("jNQXAC9IVRw");');
    expect(result.code).toBe("ACTION_DENIED");
    expect(s.requests).toHaveLength(1);
    expect(s.state.agentTabs.get(1)?.sessionId).toBe("youtube-session");
  });

  it("does not consume a preparation stage when hydration removed its target", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const s = setup(() => {
      calls++;
      if (calls === 2) return { status: "pending", message: "Target is not mounted" };
      if (calls === 4) return { status: "pending", message: "Scrolled", performed: "load-comments" };
      if (calls === 5) return { status: "ready", data: { items: [{ text: "Comment" }] } };
      return { status: "pending", action: "load-comments", message: "Scroll" };
    });
    const promise = s.run('youtube.getComments("jNQXAC9IVRw");');
    await vi.runAllTimersAsync();
    expect((await promise).ok).toBe(true);
    expect(s.requests.map((r) => r.action)).toEqual(["read", "load-comments", "read", "load-comments", "read"]);
  });

  it("bounds loading and reports a same-tab retry without opening duplicates", async () => {
    vi.useFakeTimers();
    const s = setup(() => ({ status: "pending", message: "Loading" }));
    const promise = s.run('return youtube.getTranscript("jNQXAC9IVRw");');
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("15 seconds");
    expect(s.requests).toHaveLength(30);
    expect(s.api.tabs.create).toHaveBeenCalledTimes(1);
  });

  it("reports blocked and navigation errors without retrying or bypassing", async () => {
    const s = setup(() => ({ status: "blocked", message: "Consent required. Show this tab for the person." }));
    expect((await s.run('return youtube.getMetadata("jNQXAC9IVRw");')).summary).toContain("Consent required");
    expect(s.requests).toHaveLength(1);
    vi.mocked(s.api.tabs.sendMessage).mockRejectedValueOnce(new Error("Frame gone"));
    expect((await s.run('return youtube.getMetadata("jNQXAC9IVRw");')).code).toBe("TAB_CHANGED");
  });

  it("bounds a content request that never responds", async () => {
    vi.useFakeTimers();
    const s = setup();
    vi.mocked(s.api.tabs.sendMessage).mockImplementation(() => new Promise(() => {}));
    const promise = s.run('return youtube.getTranscript("jNQXAC9IVRw");');
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("15 seconds");
    expect(s.api.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed and oversized content responses", async () => {
    const s = setup();
    for (const result of [{ status: "ready" }, { status: "ready", data: "x".repeat(16000) }, { status: "pending", message: "wait", action: "eval" }]) {
      vi.mocked(s.api.tabs.sendMessage).mockResolvedValueOnce({ ok: true, type: "page.youtube", result });
      expect((await s.run('youtube.getMetadata("jNQXAC9IVRw");')).summary).toContain("Invalid or oversized");
    }
  });

  it("reuses its own tab after navigation readiness fails instead of creating duplicates", async () => {
    const s = setup();
    vi.mocked(TabController.prototype.waitUntilReady).mockRejectedValueOnce(new Error("Not ready"));
    expect((await s.run('youtube.getMetadata("jNQXAC9IVRw");')).code).toBe("NAVIGATION_INTERRUPTED");
    expect((await s.run('youtube.getMetadata("jNQXAC9IVRw");')).ok).toBe(true);
    expect(s.api.tabs.create).toHaveBeenCalledTimes(1);
  });

  it("does not borrow another session's matching video tab", async () => {
    const s = setup();
    s.tabs.push({ id: 1, url: "https://www.youtube.com/watch?v=jNQXAC9IVRw", hidden: true });
    s.state.adoptTab(1, "other-session");
    expect((await s.run('youtube.getMetadata("jNQXAC9IVRw");')).ok).toBe(true);
    expect(s.state.agentTabs.get(1)?.sessionId).toBe("other-session");
    expect(s.state.agentTabs.get(2)?.sessionId).toBe("youtube-session");
  });

  it("refuses to reach a reused tab transferred to another session", async () => {
    const s = setup();
    await s.run('youtube.getMetadata("jNQXAC9IVRw");');
    s.state.adoptTab(1, "other-session");
    expect((await s.run('youtube.getMetadata("jNQXAC9IVRw");')).code).toBe("TAB_CHANGED");
    expect(s.requests).toHaveLength(1);
  });

  it("keeps packaged examples parser-valid and rejects JavaScript escape hatches", () => {
    const skill = BUILTIN_SKILLS.find((skill) => skill.name === "youtube")!;
    const examples = skill.body.split("\n").filter((line) => line.startsWith("return "));
    expect(examples).toHaveLength(5);
    for (const source of examples) expect(() => parseProgram(source)).not.toThrow();
    for (const source of ['return youtube.getTranscript("jNQXAC9IVRw").segments;', 'return youtube.eval("code");', "return youtube.search('query');"]) expect(() => parseProgram(source)).toThrow();
  });
});
