import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabController } from "@/lib/background/tab-controller";
import type { TabControllerBrowserApi } from "@/lib/background/tab-controller";
import type { PageResponse } from "@/lib/protocol";
import type { PageSnapshotV1 } from "@/lib/domain/tools";

type UpdatedListener = (tabId: number, changeInfo: { status?: string }, tab: { url?: string }) => void;
type SendMessage = TabControllerBrowserApi["tabs"]["sendMessage"];

function buildSnapshot(url: string, title: string): PageSnapshotV1 {
  return {
    version: 1,
    tabId: 1,
    revision: `rev-${url}`,
    url,
    origin: new URL(url).origin,
    title,
    readableText: "",
    selectionText: "",
    viewport: { width: 0, height: 0, scrollX: 0, scrollY: 0 },
    nodes: [],
    truncated: { readableText: false, nodes: false },
    warnings: [],
  };
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

describe("TabController: navigate/back success", () => {
  it("navigates the bound tab and returns a fresh snapshot", async () => {
    const { api } = createBrowserApi("http://127.0.0.1:4173/agent-page.html", "Agent Fixture");
    const controller = new TabController(api);
    await controller.captureActivePage();

    const executePromise = controller.execute({
      id: "c1",
      name: "page_navigate",
      arguments: { url: "http://127.0.0.1:4173/next-page.html" },
    });
    await vi.advanceTimersByTimeAsync(200);
    const outcome = await executePromise;

    expect(outcome.result.ok).toBe(true);
    expect(outcome.snapshot?.url).toBe("http://127.0.0.1:4173/next-page.html");
  });

  it("goes back to the previous page", async () => {
    const { api } = createBrowserApi("http://127.0.0.1:4173/agent-page.html", "Agent Fixture");
    const controller = new TabController(api);
    await controller.captureActivePage();

    const executePromise = controller.execute({ id: "c2", name: "page_go_back", arguments: {} });
    await vi.advanceTimersByTimeAsync(200);
    const outcome = await executePromise;

    expect(outcome.result.ok).toBe(true);
    expect(outcome.snapshot).not.toBeNull();
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

    const executePromise = controller.execute({
      id: "c1",
      name: "page_click",
      arguments: { ref: "e1", revision: "rev-http://127.0.0.1:4173/agent-page.html" },
    });
    // Let the click's rejection propagate and the settle-navigation listener register.
    await vi.advanceTimersByTimeAsync(0);
    triggerUpdated("complete", "http://127.0.0.1:4173/next-page.html");
    await vi.advanceTimersByTimeAsync(200);

    const outcome = await executePromise;

    expect(executeAttempts).toBe(1);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.snapshot).not.toBeNull();
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

    const executePromise = controller.execute({
      id: "c1",
      name: "page_navigate",
      arguments: { url: "http://127.0.0.1:4173/next-page.html" },
    });
    await vi.advanceTimersByTimeAsync(10_100);
    const outcome = await executePromise;

    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.code).toBe("NAVIGATION_INTERRUPTED");
  });
});

describe("TabController: stale snapshot pass-through", () => {
  it("passes through STALE_SNAPSHOT when the page changed underneath a ref", async () => {
    const { api } = createBrowserApi("http://127.0.0.1:4173/agent-page.html", "Agent Fixture");
    const baseSendMessage = api.tabs.sendMessage as SendMessage;
    api.tabs.sendMessage = vi.fn(async (tabId: number, message: unknown) => {
      const request = message as { id: string; type: string };
      if (request.type === "page.execute") {
        return {
          v: 1,
          id: request.id,
          ok: true,
          type: "page.execute",
          result: { ok: false, code: "STALE_SNAPSHOT", summary: "Snapshot revision is stale." },
          snapshot: buildSnapshot("http://127.0.0.1:4173/agent-page.html", "Agent Fixture"),
        } satisfies PageResponse;
      }
      return baseSendMessage(tabId, message);
    });

    const controller = new TabController(api);
    await controller.captureActivePage();

    const outcome = await controller.execute({
      id: "c1",
      name: "page_click",
      arguments: { ref: "e1", revision: "an-old-revision" },
    });

    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.code).toBe("STALE_SNAPSHOT");
  });
});

describe("TabController: missing tab", () => {
  it("returns TAB_CHANGED when the bound tab is no longer reachable", async () => {
    const { api } = createBrowserApi("http://127.0.0.1:4173/agent-page.html", "Agent Fixture");
    const controller = new TabController(api);
    await controller.captureActivePage();

    api.tabs.sendMessage = vi.fn(async () => {
      throw new Error("Invalid tab ID: 1");
    });

    const outcome = await controller.execute({
      id: "c1",
      name: "page_fill",
      arguments: { ref: "e1", revision: "rev", text: "hi" },
    });

    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.code).toBe("TAB_CHANGED");
  });
});
