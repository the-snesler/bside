import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "wxt/browser";
import { BackgroundRuntime } from "@/lib/background/runtime";
import { SidebarHub } from "@/lib/background/sidebar-hub";
import { TabController } from "@/lib/background/tab-controller";
import type { TabControllerBrowserApi } from "@/lib/background/tab-controller";
import { saveOpenAICredential } from "@/lib/storage";
import type { ProviderAdapter, ProviderAuth, ProviderEvent, ProviderTurnRequest } from "@/lib/domain/provider";
import type { SidebarEvent } from "@/lib/protocol";

/** A TabController bound to a browser API that always reports no attachable tab. */
function unsupportedPageTabControllerFactory(): TabController {
  const api: TabControllerBrowserApi = {
    tabs: {
      query: vi.fn(async () => []),
      update: vi.fn(async () => {}),
      goBack: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {
        throw new Error("no content script");
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  return new TabController(api);
}

class FakeProvider implements ProviderAdapter {
  readonly definition = { id: "openai" as const, name: "OpenAI", authMethods: [], models: [] };
  script: ProviderEvent[] | ((signal: AbortSignal) => AsyncIterable<ProviderEvent>) = [];

  async validateAuth(_auth: ProviderAuth, _signal: AbortSignal): Promise<void> {}

  async *streamTurn(_request: ProviderTurnRequest, _auth: ProviderAuth, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const events = typeof this.script === "function" ? this.script(signal) : this.script;
    yield* events;
  }
}

type FakePort = Browser.runtime.Port & { received: SidebarEvent[]; send: (msg: unknown) => Promise<void> };

function fakePort(): FakePort {
  const received: SidebarEvent[] = [];
  const listeners: Array<(msg: unknown) => unknown> = [];
  return {
    name: "agent-sidebar:v1",
    postMessage: (message: unknown) => received.push(message as SidebarEvent),
    onMessage: {
      addListener: (cb: (msg: unknown) => unknown) => listeners.push(cb),
      removeListener: (cb: (msg: unknown) => unknown) => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
    onDisconnect: { addListener: vi.fn() },
    disconnect: vi.fn(),
    received,
    send: async (msg: unknown) => {
      await Promise.all(listeners.map((cb) => cb(msg)));
    },
  } as unknown as FakePort;
}

/** Yields to the microtask queue repeatedly; no real timer, no macrotask. */
async function tick(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe("BackgroundRuntime: single active run", () => {
  it("drops a second run.start while a run is active and republishes a snapshot", async () => {
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    // Never resolves on its own; only ends via explicit cancellation elsewhere.
    const gate = Promise.withResolvers<never>();
    provider.script = () => ({ [Symbol.asyncIterator]: async function* () { await gate.promise; } });
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;

    const port = fakePort();
    hub.handleConnect(port);

    void port.send({ v: 1, id: "1", type: "run.start", prompt: "Hello" });
    await tick();
    await port.send({ v: 1, id: "2", type: "run.start", prompt: "Second" });

    const snapshot = await runtime.getSnapshot();
    expect(snapshot.activeRun).not.toBeNull();
    expect(snapshot.conversation.items.filter((item) => item.kind === "message" && item.role === "user")).toHaveLength(1);

    const snapshotEvents = port.received.filter((e) => e.type === "state.snapshot");
    expect(snapshotEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("never starts two runs even when run.start arrives twice before credential lookup resolves", async () => {
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    provider.script = [
      { type: "text.delta", delta: "hi" },
      { type: "turn.completed", replayState: null },
    ];
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);

    // Fire both before yielding to the event loop at all.
    const first = runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "A" });
    const second = runtime.handleCommand({ v: 1, id: "2", type: "run.start", prompt: "B" });
    await Promise.all([first, second]);

    const snapshot = await runtime.getSnapshot();
    const userMessages = snapshot.conversation.items.filter((item) => item.kind === "message" && item.role === "user");
    expect(userMessages).toHaveLength(1);
  });
});

describe("BackgroundRuntime: event sequencing", () => {
  it("assigns strictly increasing seq numbers across the run lifecycle", async () => {
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    provider.script = [
      { type: "text.delta", delta: "Hello" },
      { type: "text.delta", delta: " world" },
      { type: "turn.completed", replayState: null },
    ];
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);

    await runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Hi" });

    const runEvents = port.received.filter((e) => e.type !== "state.snapshot" && e.type !== "page.attached");
    const seqs = runEvents.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(runEvents.map((e) => e.type)).toEqual(["run.started", "assistant.delta", "run.completed"]);
  });
});

describe("BackgroundRuntime: cancellation", () => {
  it("publishes run.cancelled and clears the active run on explicit cancel", async () => {
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    provider.script = (signal: AbortSignal) => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "text.delta", delta: "partial" } as ProviderEvent;
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        const { promise, reject } = Promise.withResolvers<never>();
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        await promise;
      },
    });
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);

    const runCommand = runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Hi" });
    await tick();

    const runningSnapshot = await runtime.getSnapshot();
    const runId = runningSnapshot.activeRun?.runId;
    expect(runId).toBeDefined();

    await runtime.handleCommand({ v: 1, id: "2", type: "run.cancel", runId: runId as string });
    await runCommand;

    const cancelled = port.received.find((e) => e.type === "run.cancelled");
    expect(cancelled).toBeDefined();
    const finalSnapshot = await runtime.getSnapshot();
    expect(finalSnapshot.activeRun).toBeNull();
  });
});

describe("BackgroundRuntime: missing credential", () => {
  it("does not start a run and surfaces a notice when no key is configured", async () => {
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);

    await runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Hi" });

    const snapshot = await runtime.getSnapshot();
    expect(snapshot.activeRun).toBeNull();
    expect(snapshot.conversation.items).toHaveLength(0);

    // The one-time notice is consumed by the broadcastSnapshot() the missing
    // credential path already triggered; assert it reached the connected port.
    const broadcast = port.received.find((e) => e.type === "state.snapshot");
    expect(broadcast?.type).toBe("state.snapshot");
    if (broadcast?.type === "state.snapshot") {
      expect(broadcast.payload.notice).toContain("API key");
    }
  });
});
