import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TAB_TAG_KEY, TabController } from "@/lib/background/tab-controller";
import type { TabControllerBrowserApi } from "@/lib/background/tab-controller";
import type { PageResponse } from "@/lib/protocol";
import type { PageSnapshot } from "@/lib/domain/tools";

type UpdatedListener = (tabId: number, changeInfo: { status?: string }, tab: { url?: string }) => void;
type SendMessage = TabControllerBrowserApi["tabs"]["sendMessage"];

function buildSnapshot(url: string, title: string): PageSnapshot {
  return { version: 2, tabId: 1, documentId: `doc-${url}`, url, title, text: "", offset: 0, end: 0, totalChars: 0, selectionText: "" };
}

function snapshotResponse(id: string, url: string, title: string): PageResponse {
  return { v: 1, id, ok: true, type: "page.snapshot", snapshot: buildSnapshot(url, title) };
}

function healthResponse(id: string, url: string): PageResponse {
  return { v: 1, id, ok: true, type: "page.health", url };
}

/**
 * An in-memory fake of the `tabs` slice of the WebExtension API used by
 * TabController. Tab-completion signals are dispatched via a (fake) timer,
 * not a microtask, to mirror the real API: `tabs.onUpdated` always fires
 * after the `tabs.update()` promise has already resolved and the caller has
 * had a chance to register its listener.
 */
function createBrowserApi(initialUrl: string, initialTitle: string) {
  const listeners: UpdatedListener[] = [];
  let currentUrl = initialUrl;
  let currentTitle = initialTitle;
  let contentScriptReady = true;

  const api: TabControllerBrowserApi = {
    tabs: {
      query: vi.fn(async () => [{ id: 1, url: currentUrl, title: currentTitle }]),
      update: vi.fn(async (_tabId: number, props: { url: string }) => {
        currentUrl = props.url;
        setTimeout(() => {
          for (const listener of [...listeners]) listener(1, { status: "complete" }, { url: currentUrl });
        }, 0);
      }),
      goBack: vi.fn(async () => {
        setTimeout(() => {
          for (const listener of [...listeners]) listener(1, { status: "complete" }, { url: currentUrl });
        }, 0);
      }),
      sendMessage: vi.fn(async (_tabId: number, message: unknown) => {
        if (!contentScriptReady) throw new Error("Receiving end does not exist.");
        const request = message as { id: string; type: string };
        if (request.type === "page.health") return healthResponse(request.id, currentUrl);
        if (request.type === "page.snapshot") return snapshotResponse(request.id, currentUrl, currentTitle);
        throw new Error(`unhandled fake request type: ${request.type}`);
      }),
      onUpdated: {
        addListener: (cb: UpdatedListener) => listeners.push(cb),
        removeListener: (cb: UpdatedListener) => {
          const index = listeners.indexOf(cb);
          if (index >= 0) listeners.splice(index, 1);
        },
      },
    },
  };

  return {
    api,
    triggerUpdated: (status: string, url?: string) => {
      for (const listener of [...listeners]) listener(1, { status }, { url: url ?? currentUrl });
    },
    setContentScriptReady: (value: boolean) => {
      contentScriptReady = value;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TabController: capture and binding", () => {
  it("binds the active HTTP(S) tab and returns its readable snapshot", async () => {
    const { api } = createBrowserApi("http://127.0.0.1:4173/agent-page.html", "Agent Fixture");
    const controller = new TabController(api);
    const outcome = await controller.captureActivePage();
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.artifact.title).toBe("Agent Fixture");
      expect(outcome.value.snapshot.url).toBe("http://127.0.0.1:4173/agent-page.html");
    }
  });

  it("refuses to attach an unsupported page", async () => {
    const { api } = createBrowserApi("about:preferences", "Settings");
    const controller = new TabController(api);
    const outcome = await controller.captureActivePage();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("UNSUPPORTED_PAGE");
  });
});

const CLICK = { kind: "click", target: { kind: "ref", ref: "e1", documentId: "doc" } } as const;

describe("TabController: navigate/back success", () => {
  it("navigates the bound tab and reports the settled URL and title", async () => {
    const { api } = createBrowserApi("http://127.0.0.1:4173/agent-page.html", "Agent Fixture");
    const controller = new TabController(api);
    await controller.captureActivePage();

    const navigatePromise = controller.navigate("http://127.0.0.1:4173/next-page.html");
    await vi.advanceTimersByTimeAsync(200);
    const result = await navigatePromise;

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Navigated to http://127.0.0.1:4173/next-page.html");
    expect(controller.currentAttachment()?.url).toBe("http://127.0.0.1:4173/next-page.html");
  });

  it("rejects non-HTTP navigation targets without touching the tab", async () => {
    const { api } = createBrowserApi("http://127.0.0.1:4173/agent-page.html", "Agent Fixture");
    const controller = new TabController(api);
    await controller.captureActivePage();
    expect(await controller.navigate("javascript:alert(1)")).toMatchObject({ ok: false, code: "INVALID_TOOL_ARGUMENTS" });
    expect(api.tabs.update).not.toHaveBeenCalled();
  });

  it("goes back to the previous page", async () => {
    const { api } = createBrowserApi("http://127.0.0.1:4173/agent-page.html", "Agent Fixture");
    const controller = new TabController(api);
    await controller.captureActivePage();

    const backPromise = controller.goBack();
    await vi.advanceTimersByTimeAsync(200);
    expect((await backPromise).ok).toBe(true);
  });
});

describe("TabController: click-disconnect navigation settlement", () => {
  it("settles navigation after a click disconnects, without repeating the click", async () => {
    const { api, triggerUpdated } = createBrowserApi("http://127.0.0.1:4173/agent-page.html", "Agent Fixture");
    let executeAttempts = 0;
    const baseSendMessage = api.tabs.sendMessage as SendMessage;
    api.tabs.sendMessage = vi.fn(async (tabId: number, message: unknown) => {
      const request = message as { type: string };
      if (request.type === "page.execute") {
        executeAttempts += 1;
        throw new Error("Receiving end does not exist.");
      }
      return baseSendMessage(tabId, message);
    });

    const controller = new TabController(api);
    await controller.captureActivePage();

    const actPromise = controller.act(CLICK);
    // Let the click's rejection propagate and the settle-navigation listener register.
    await vi.advanceTimersByTimeAsync(0);
    triggerUpdated("complete", "http://127.0.0.1:4173/next-page.html");
    await vi.advanceTimersByTimeAsync(200);

    const outcome = await actPromise;

    expect(executeAttempts).toBe(1);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.summary).toContain("the page navigated");
    expect(outcome.documentId).toBeNull();
  });

  it("does not treat a lost fill response as navigation", async () => {
    const { api } = createBrowserApi("http://127.0.0.1:4173/agent-page.html", "Agent Fixture");
    const controller = new TabController(api);
    await controller.captureActivePage();
    api.tabs.sendMessage = vi.fn(async () => { throw new Error("Invalid tab ID: 1"); });

    const outcome = await controller.act({ kind: "fill", target: CLICK.target, text: "hi" });
    expect(outcome.result).toMatchObject({ ok: false, code: "TAB_CHANGED" });
  });
});

describe("TabController: navigation timeout", () => {
  it("returns NAVIGATION_INTERRUPTED when the page never settles within 10 seconds", async () => {
    const { api, setContentScriptReady } = createBrowserApi("http://127.0.0.1:4173/agent-page.html", "Agent Fixture");
    const controller = new TabController(api);
    await controller.captureActivePage();

    setContentScriptReady(false);
    api.tabs.update = vi.fn(async () => {
      // Simulate a navigation that never reaches "complete" and whose
      // content script never responds.
    });

    const navigatePromise = controller.navigate("http://127.0.0.1:4173/next-page.html");
    await vi.advanceTimersByTimeAsync(10_100);
    expect(await navigatePromise).toMatchObject({ ok: false, code: "NAVIGATION_INTERRUPTED" });
  });
});

describe("TabController: action results pass through", () => {
  it("passes through STALE_SNAPSHOT and the executing document id", async () => {
    const { api } = createBrowserApi("http://127.0.0.1:4173/agent-page.html", "Agent Fixture");
    const baseSendMessage = api.tabs.sendMessage as SendMessage;
    api.tabs.sendMessage = vi.fn(async (tabId: number, message: unknown) => {
      const request = message as { id: string; type: string };
      if (request.type === "page.execute") {
        return { v: 1, id: request.id, ok: true, type: "page.execute", result: { ok: false, code: "STALE_SNAPSHOT", summary: "Ref came from an earlier page load." }, documentId: "doc-new" } satisfies PageResponse;
      }
      return baseSendMessage(tabId, message);
    });

    const controller = new TabController(api);
    await controller.captureActivePage();

    const outcome = await controller.act(CLICK);
    expect(outcome.result).toMatchObject({ ok: false, code: "STALE_SNAPSHOT" });
    expect(outcome.documentId).toBe("doc-new");
  });

  it("requests bounded snapshot slices from the bound tab", async () => {
    const { api } = createBrowserApi("http://127.0.0.1:4173/agent-page.html", "Agent Fixture");
    const controller = new TabController(api);
    await controller.captureActivePage();
    const outcome = await controller.snapshot({ offset: 500, maxChars: 2000 });
    expect(outcome.ok).toBe(true);
    expect(api.tabs.sendMessage).toHaveBeenLastCalledWith(1, expect.objectContaining({ type: "page.snapshot", offset: 500, maxChars: 2000 }));
  });
});

describe("TabController: agent-tab session tags", () => {
  function sessionsApi(initial: unknown) {
    const calls: string[] = [];
    let value = initial;
    const { api } = createBrowserApi("https://example.test/", "Example");
    api.tabs.remove = vi.fn(async () => { calls.push("remove"); });
    api.sessions = {
      getTabValue: vi.fn(async () => value),
      setTabValue: vi.fn(async (_tabId: number, _key: string, next: unknown) => { calls.push("set"); value = next; }),
      removeTabValue: vi.fn(async () => { calls.push("untag"); value = undefined; }),
    };
    return { api, calls };
  }

  it("round-trips a tag under its session key", async () => {
    const { api } = sessionsApi(undefined);
    const controller = new TabController(api);
    expect(await controller.agentTabTag(1)).toBeNull();
    await controller.tagAgentTab(1, { v: 1, role: "search", lastUsedAt: 5 });
    expect(api.sessions!.setTabValue).toHaveBeenCalledWith(1, AGENT_TAB_TAG_KEY, { v: 1, role: "search", lastUsedAt: 5 });
    expect(await controller.agentTabTag(1)).toEqual({ v: 1, role: "search", lastUsedAt: 5 });
  });

  it.each([
    ["an unknown version", { v: 2, role: "agent", lastUsedAt: 1 }],
    ["an unknown role", { v: 1, role: "user", lastUsedAt: 1 }],
    ["a non-numeric timestamp", { v: 1, role: "agent", lastUsedAt: "1" }],
    ["a non-finite timestamp", { v: 1, role: "agent", lastUsedAt: Number.POSITIVE_INFINITY }],
    ["a string", "agent"],
    ["null", null],
  ])("reads %s as untagged", async (_label, value) => {
    expect(await new TabController(sessionsApi(value).api).agentTabTag(1)).toBeNull();
  });

  it("untags a tab before closing it, so reopening it from recently closed tabs yields an ordinary tab", async () => {
    const { api, calls } = sessionsApi({ v: 1, role: "agent", lastUsedAt: 1 });
    await new TabController(api).closeTab(1);
    expect(calls).toEqual(["untag", "remove"]);
  });
});
