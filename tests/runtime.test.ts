import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "wxt/browser";
import { BackgroundRuntime } from "@/lib/background/runtime";
import { ChatGPTAuth } from "@/lib/background/chatgpt-auth";
import { SidebarHub } from "@/lib/background/sidebar-hub";
import { TabController } from "@/lib/background/tab-controller";
import type { TabControllerBrowserApi } from "@/lib/background/tab-controller";
import { ProviderStreamError } from "@/lib/providers/openai";
import { saveOpenAICredential, appendConversationItem, getConversation, getOpenAICredential } from "@/lib/storage";
import type { ProviderAdapter, ProviderAuth, ProviderTurnRequest } from "@/lib/domain/provider";
import type { PageSnapshot } from "@/lib/domain/tools";
import type { SidebarEvent } from "@/lib/protocol";
import { TEST_MODEL, toPiStream, type ScriptedProviderEvent } from "@/tests/helpers/pi-provider";

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

/** A TabController bound to a browser API that reports one attachable tab with a clickable button. */
function supportedPageTabControllerFactory(): TabController {
  const text = 'Orchid launch moved to Friday.\n[e1 button "Submit"]';
  const snapshot: PageSnapshot = {
    version: 2,
    tabId: 1,
    documentId: "doc-1",
    url: "http://127.0.0.1:4173/agent-page.html",
    title: "Agent Fixture",
    text,
    offset: 0,
    end: text.length,
    totalChars: text.length,
    selectionText: "",
  };
  const api: TabControllerBrowserApi = {
    tabs: {
      query: vi.fn(async () => [{ id: 1, url: snapshot.url, title: snapshot.title }]),
      update: vi.fn(async () => {}),
      goBack: vi.fn(async () => {}),
      sendMessage: vi.fn(async (_tabId: number, message: unknown) => {
        const request = message as { id: string; type: string };
        if (request.type === "page.snapshot") return { v: 1, id: request.id, ok: true, type: "page.snapshot", snapshot };
        if (request.type === "page.execute") {
          return { v: 1, id: request.id, ok: true, type: "page.execute", result: { ok: true, summary: "Clicked Submit." }, documentId: snapshot.documentId };
        }
        throw new Error(`unhandled request type: ${request.type}`);
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  return new TabController(api);
}

describe("context controls", () => {
  it("lists real tab mention paths without capturing page content", async () => {
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), tabControllerFactory: supportedPageTabControllerFactory });
    expect(await runtime.handleCommand({ v: 1, id: "tabs", type: "tabs.list" })).toEqual({ tabs: [
      { id: 1, title: "Agent Fixture", url: "http://127.0.0.1:4173/agent-page.html", path: "/tabs/1/page.md" },
    ] });
    expect((await getConversation()).items).toHaveLength(0);
  });

  it("focuses a mentioned tab without capturing page content", async () => {
    const controller = supportedPageTabControllerFactory();
    const focusTab = vi.spyOn(controller, "focusTab");
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), tabControllerFactory: () => controller });
    await runtime.handleCommand({ v: 1, id: "focus", type: "tabs.focus", tabId: 1 });
    expect(focusTab).toHaveBeenCalledWith(1);
    expect((await getConversation()).items).toHaveLength(0);
  });

  it("saves inline model selection through the background", async () => {
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider: new FakeProvider(), tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const settings = { version: 1 as const, providerId: "openai" as const, modelId: "gpt-5.6-sol", reasoningEffort: "high" as const };
    await runtime.handleCommand({ v: 1, id: "settings", type: "settings.save", settings });
    expect((await runtime.getSnapshot()).settings).toEqual(settings);
  });

  it("exports complete tool output for debugging without persisting page content", async () => {
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    let round = 0;
    provider.script = () => ({ [Symbol.asyncIterator]: async function* () {
      if (round++ === 0) yield { type: "tool.call", call: { id: "read", name: "browser_program", arguments: { source: 'return fs.read("/tabs/1/page.md");' } } } as ScriptedProviderEvent;
      yield { type: "turn.completed", replayState: null } as ScriptedProviderEvent;
    } });
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: supportedPageTabControllerFactory });
    hub.delegate = runtime;
    await runtime.handleCommand({ v: 1, id: "run", type: "run.start", prompt: "Read the fixture" });
    const exported = await runtime.handleCommand({ v: 1, id: "export", type: "context.export" });
    const outputs = exported?.markdown.split("## Full tool output — latest run")[1]?.split("## Conversation log")[0];
    expect(outputs).toContain("Orchid launch moved to Friday.");
    expect(outputs).toContain("Document: doc-1");
    expect(outputs).toContain('"durationMs"');
    const latestRun = exported?.markdown.split("## Latest run")[1]?.split("## Latest model input")[0];
    expect(latestRun).toContain('"modelId"');
    expect(latestRun).toContain('"status": "completed"');
    expect(latestRun).toContain('"providerResponses": 2');
    expect(latestRun).toContain('"name": "browser_program"');
    expect(JSON.stringify(await getConversation())).not.toContain("Orchid launch moved to Friday.");
    await runtime.handleCommand({ v: 1, id: "reset", type: "context.reset" });
    expect((await runtime.handleCommand({ v: 1, id: "export2", type: "context.export" }))?.markdown).not.toContain("Orchid launch moved to Friday.");
  });

  it("exports the latest model input without credentials and resets saved conversation", async () => {
    await saveOpenAICredential("sk-context-test-secret");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    provider.script = [{ type: "text.delta", delta: "Hello." }, { type: "turn.completed", replayState: null }];
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    await runtime.handleCommand({ v: 1, id: "start", type: "run.start", prompt: "Context export test" });
    const exported = await runtime.handleCommand({ v: 1, id: "export", type: "context.export" });
    expect(exported?.filename).toMatch(/\.md$/);
    expect(exported?.markdown).toContain("Context export test");
    expect(exported?.markdown).toContain("browser_program");
    expect(exported?.markdown).toContain("Hello.");
    expect(exported?.markdown).not.toContain("sk-context-test-secret");
    await runtime.handleCommand({ v: 1, id: "reset", type: "context.reset" });
    expect((await getConversation()).items).toEqual([]);
    expect((await getOpenAICredential())?.apiKey).toBe("sk-context-test-secret");
    const cleared = await runtime.handleCommand({ v: 1, id: "export2", type: "context.export" });
    expect(cleared?.markdown).not.toContain("Context export test");
    expect(cleared?.markdown).toContain("No model input captured");
  });

  it("sends a download only to the requesting sidebar", async () => {
    await appendConversationItem({ id: "u1", kind: "message", role: "user", text: "Saved context", context: null, at: 1 });
    const hub = new SidebarHub();
    hub.delegate = new BackgroundRuntime(hub, { provider: new FakeProvider() });
    const first = fakePort();
    const second = fakePort();
    hub.handleConnect(first); hub.handleConnect(second);
    await first.send({ v: 1, id: "download", type: "context.export" });
    expect(first.received.find((event) => event.type === "context.exported")?.payload).toMatchObject({ requestId: "download", markdown: expect.stringContaining("Saved context") });
    expect(second.received.some((event) => event.type === "context.exported")).toBe(false);
  });
});

class FakeProvider implements ProviderAdapter {
  readonly definition = { id: "openai" as const, name: "OpenAI", authMethods: [], models: [] };
  script: ScriptedProviderEvent[] | ((signal: AbortSignal) => AsyncIterable<ScriptedProviderEvent>) = [];
  requests: ProviderTurnRequest[] = [];

  async validateAuth(_auth: ProviderAuth, _signal: AbortSignal): Promise<void> {}

  getModel() { return TEST_MODEL; }

  streamTurn(request: ProviderTurnRequest, _auth: ProviderAuth, signal: AbortSignal) {
    this.requests.push(request);
    const events = typeof this.script === "function" ? this.script(signal) : this.script;
    return toPiStream(events, signal);
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
  await new Promise((resolve) => setTimeout(resolve, 0));
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
    expect(runEvents[0]?.type).toBe("run.started");
    expect(runEvents.at(-1)?.type).toBe("run.completed");
    const deltas = runEvents.filter((event) => event.type === "assistant.delta");
    expect(deltas.map((event) => event.payload.delta).join("")).toBe("Hello world");
  });
});

describe("BackgroundRuntime: cancellation", () => {
  it("publishes run.cancelled and clears the active run on explicit cancel", async () => {
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    provider.script = (signal: AbortSignal) => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "text.delta", delta: "partial" } as ScriptedProviderEvent;
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

  it("persists cancelled partial text as a visible interrupted message matching the published event", async () => {
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    provider.script = (signal: AbortSignal) => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "text.delta", delta: "The page says" } as ScriptedProviderEvent;
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
    const runId = (await runtime.getSnapshot()).activeRun?.runId as string;

    await runtime.handleCommand({ v: 1, id: "2", type: "run.cancel", runId });
    await runCommand;

    const cancelled = port.received.find((e) => e.type === "run.cancelled");
    expect(cancelled).toBeDefined();
    if (cancelled?.type !== "run.cancelled") throw new Error("expected run.cancelled");
    expect(cancelled.payload.partialText).toBe("The page says");
    expect(cancelled.payload.messageId).not.toBeNull();

    const snapshot = await runtime.getSnapshot();
    const lastItem = snapshot.conversation.items.at(-1);
    expect(lastItem?.kind).toBe("message");
    if (lastItem?.kind !== "message") throw new Error("expected a message item");
    expect(lastItem.role).toBe("assistant");
    expect(lastItem.text).toContain("The page says");
    expect(lastItem.text).toContain("Stopped");
    // Never fed back into a future provider request: it is a persisted
    // ConversationItem, not part of any run's replay state.
    expect(lastItem.id).toBe(cancelled.payload.messageId);
  });

  it("ignores a second run.cancel for the same run without duplicating the terminal event", async () => {
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    provider.script = (signal: AbortSignal) => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "text.delta", delta: "partial" } as ScriptedProviderEvent;
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
    const runId = (await runtime.getSnapshot()).activeRun?.runId as string;

    await runtime.handleCommand({ v: 1, id: "2", type: "run.cancel", runId });
    await runtime.handleCommand({ v: 1, id: "3", type: "run.cancel", runId });
    await runCommand;

    const cancelledEvents = port.received.filter((e) => e.type === "run.cancelled");
    expect(cancelledEvents).toHaveLength(1);
  });
});

describe("BackgroundRuntime: credential and settings changes from the options page", () => {
  function subscription(locked = false) {
    const auth = new ChatGPTAuth();
    vi.spyOn(auth, "status").mockResolvedValue({ connected: true, locked, email: locked ? null : "user@example.test" });
    vi.spyOn(auth, "models").mockResolvedValue([{ id: "account-model", name: "Account model", reasoningEfforts: ["none"], defaultReasoningEffort: "none" }]);
    vi.spyOn(auth, "getAuth").mockImplementation(async () => {
      if (locked) throw new ProviderStreamError("Unlock ChatGPT in settings.", "AUTHENTICATION");
      return { providerId: "openai", method: "chatgpt", secret: "test-subscription-token" };
    });
    return auth;
  }

  it("uses the subscription and account model while keeping tokens out of snapshots and exports", async () => {
    await saveOpenAICredential("sk-test-existing-key");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    const stream = vi.spyOn(provider, "streamTurn");
    provider.script = [{ type: "text.delta", delta: "Hello." }, { type: "turn.completed", replayState: null }];
    const runtime = new BackgroundRuntime(hub, { provider, chatgpt: subscription(), tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    await runtime.handleCommand({ v: 1, id: "start", type: "run.start", prompt: "Hello" });
    expect(stream.mock.calls[0]?.[1]).toMatchObject({ method: "chatgpt", secret: "test-subscription-token" });
    const snapshot = await runtime.getSnapshot();
    expect(snapshot.settings).toMatchObject({ modelId: "account-model", reasoningEffort: "none" });
    expect(snapshot.provider.models.map((model) => model.id)).toEqual(["account-model"]);
    expect(snapshot.credential).toMatchObject({ configured: true, chatgpt: { connected: true, locked: false } });
    const exported = await runtime.handleCommand({ v: 1, id: "export", type: "context.export" });
    for (const value of [JSON.stringify(snapshot), exported.markdown]) {
      expect(value).not.toContain("test-subscription-token");
      expect(value).not.toContain("sk-test-existing-key");
    }
  });

  it("blocks a locked subscription without falling back to the saved API key", async () => {
    await saveOpenAICredential("sk-test-existing-key");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    const runtime = new BackgroundRuntime(hub, { provider, chatgpt: subscription(true), tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    await runtime.handleCommand({ v: 1, id: "start", type: "run.start", prompt: "Hello" });
    expect(provider.requests).toEqual([]);
    expect((await getConversation()).items).toEqual([]);
    expect((await runtime.getSnapshot()).credential.configured).toBe(false);
  });

  it("runs the connection test without page tools or changing the conversation", async () => {
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    provider.script = [{ type: "text.delta", delta: "ChatGPT connection works." }, { type: "turn.completed", replayState: null }];
    const runtime = new BackgroundRuntime(hub, { provider, chatgpt: subscription(), tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const result = await runtime.handleCredentialRequest({ v: 1, id: "test", type: "credentials.chatgpt.test" });
    expect(result).toMatchObject({ ok: true, notice: expect.stringContaining("connection works") });
    expect(provider.requests[0]?.context.tools).toEqual([]);
    expect((await getConversation()).items).toEqual([]);
    expect((await runtime.getSnapshot()).activeRun).toBeNull();
    expect(JSON.stringify(result)).not.toContain("test-subscription-token");
  });

  it("rejects models and reasoning efforts outside the account catalog", async () => {
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), chatgpt: subscription() });
    const settings = { version: 1 as const, providerId: "openai" as const, modelId: "account-model", reasoningEffort: "high" as const };
    expect(await runtime.handleSettingsRequest({ v: 1, id: "effort", type: "settings.save", settings })).toMatchObject({ ok: false });
    expect(await runtime.handleSettingsRequest({ v: 1, id: "model", type: "settings.save", settings: { ...settings, modelId: "not-in-account" } })).toMatchObject({ ok: false });
  });

  it("pushes new credential state to already-connected sidebars without reconnecting", async () => {
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider: new FakeProvider(), tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);
    await port.send({ v: 1, id: "sub", type: "state.subscribe", lastSeq: null });
    const credentialStates = () => port.received.flatMap((event) => event.type === "state.snapshot" ? [event.payload.credential.configured] : []);
    expect(credentialStates()).toEqual([false]);

    expect(await runtime.handleCredentialRequest({ v: 1, id: "save", type: "credentials.openai.save", apiKey: "sk-test-1234" })).toMatchObject({ ok: true, configured: true });
    expect(credentialStates()).toEqual([false, true]);
    const latest = port.received.at(-1);
    expect(latest?.type === "state.snapshot" ? latest.payload.credential.maskedSuffix : null).toBe("1234");
    expect(JSON.stringify(port.received)).not.toContain("sk-test-1234");

    await runtime.handleCredentialRequest({ v: 1, id: "delete", type: "credentials.openai.delete" });
    expect(credentialStates()).toEqual([false, true, false]);
  });

  it("does not broadcast when key validation fails", async () => {
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    provider.validateAuth = async () => { throw new ProviderStreamError("The OpenAI API key was rejected.", "AUTHENTICATION", 401); };
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);
    expect(await runtime.handleCredentialRequest({ v: 1, id: "save", type: "credentials.openai.save", apiKey: "sk-bad" })).toMatchObject({ ok: false });
    expect(port.received.some((event) => event.type === "state.snapshot")).toBe(false);
  });

  it("pushes model changes saved from the options page to connected sidebars", async () => {
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider: new FakeProvider(), tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);
    const settings = { version: 1 as const, providerId: "openai" as const, modelId: "gpt-5.6-sol", reasoningEffort: "high" as const };
    await runtime.handleSettingsRequest({ v: 1, id: "s", type: "settings.save", settings });
    const latest = port.received.at(-1);
    expect(latest?.type === "state.snapshot" ? latest.payload.settings : null).toEqual(settings);
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

describe("BackgroundRuntime: cross-run transcript (regression)", () => {
  it("does not carry a prior run's tool-call/tool-result items into a new run's transcript", async () => {
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    // FakeProvider.streamTurn is called once per AgentLoop round; wire
    // distinct rounds via a counter. Run 1 emits a tool call (TabController
    // is unattached, so it resolves as a failed but still-persisted tool
    // result) then a final message; run 2 is plain text.
    let round = 0;
    const rounds: ScriptedProviderEvent[][] = [
      [
        { type: "tool.call", call: { id: "call_1", name: "browser_program", arguments: { source: 'return await fs.read("/tabs/1/page.md");' } } },
        { type: "turn.completed", replayState: null },
      ],
      [{ type: "text.delta", delta: "Done." }, { type: "turn.completed", replayState: null }],
      [{ type: "text.delta", delta: "Second reply." }, { type: "turn.completed", replayState: null }],
    ];
    provider.script = () => {
      const events = rounds[round] ?? [{ type: "turn.completed", replayState: null }];
      round += 1;
      return { [Symbol.asyncIterator]: async function* () { yield* events; } };
    };

    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);

    await runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Show the guestbook" });
    const firstRunConversation = (await runtime.getSnapshot()).conversation;
    expect(firstRunConversation.items.some((item) => item.kind === "tool-call")).toBe(true);
    expect(firstRunConversation.items.some((item) => item.kind === "tool-result")).toBe(true);

    await runtime.handleCommand({ v: 1, id: "2", type: "run.start", prompt: "Try again" });

    const secondRunRequest = provider.requests[2];
    expect(secondRunRequest).toBeDefined();
    expect(secondRunRequest?.context.messages.every((item) => item.role === "user" || item.role === "assistant")).toBe(true);
  });
});

describe("BackgroundRuntime: prompt-cache usage", () => {
  it("keys requests by conversation and accumulates cached input tokens into the run record", async () => {
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    let round = 0;
    provider.script = () => {
      round += 1;
      const events: ScriptedProviderEvent[] = round === 1
        ? [{ type: "tool.call", call: { id: "call_1", name: "browser_program", arguments: { source: "return 1;" } } }, { type: "turn.completed", replayState: null, usage: { input: 900, cacheRead: 0 } }]
        : [{ type: "text.delta", delta: "Done." }, { type: "turn.completed", replayState: null, usage: { input: 100, cacheRead: 896 } }];
      return { [Symbol.asyncIterator]: async function* () { yield* events; } };
    };
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;

    await runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Hello" });

    expect(provider.requests.map((request) => request.sessionId)).toEqual(["default", "default"]);
    const exported = await runtime.handleCommand({ v: 1, id: "export", type: "context.export" });
    expect(exported?.markdown).toContain('"providerResponses": 2');
    expect(exported?.markdown).toContain('"cacheRead": 896');
  });
});

describe("BackgroundRuntime: unsupported page permits ordinary chat (regression)", () => {
  it("completes a run with no page attachment when the active tab is unsupported", async () => {
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    provider.script = [
      { type: "text.delta", delta: "I can still help without a page." },
      { type: "turn.completed", replayState: null },
    ];
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);

    await runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Hi, no page needed" });

    const snapshot = await runtime.getSnapshot();
    expect(snapshot.activeRun).toBeNull();
    const userMessage = snapshot.conversation.items.find((item) => item.kind === "message" && item.role === "user");
    expect(userMessage?.kind === "message" ? userMessage.context : undefined).toBeNull();
    expect(provider.requests[0]?.context.systemPrompt).not.toContain("BEGIN_UNTRUSTED_PAGE_ARTIFACT");
    expect(port.received.some((e) => e.type === "run.completed")).toBe(true);
  });
});

describe("BackgroundRuntime: reconnect during approval (regression)", () => {
  it("reconstructs the pending approval card on a fresh port subscribe", async () => {
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    provider.script = () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "tool.call", call: { id: "call_1", name: "request_action_confirmation", arguments: { title: "Submit", message: "Submit the draft?", artifact: "Draft" } } } as ScriptedProviderEvent;
        yield { type: "turn.completed", replayState: null } as ScriptedProviderEvent;
      },
    });
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: supportedPageTabControllerFactory });
    hub.delegate = runtime;
    const firstPort = fakePort();
    hub.handleConnect(firstPort);

    void runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Click submit" });
    await tick(200);

    const reconnectedPort = fakePort();
    hub.handleConnect(reconnectedPort);
    await reconnectedPort.send({ v: 1, id: "2", type: "state.subscribe", lastSeq: null });

    const snapshotEvent = reconnectedPort.received.find((e) => e.type === "state.snapshot");
    expect(snapshotEvent).toBeDefined();
    if (snapshotEvent?.type !== "state.snapshot") throw new Error("expected state.snapshot");
    expect(snapshotEvent.payload.activeRun?.status).toBe("awaiting-approval");
    expect(snapshotEvent.payload.activeRun?.pendingApproval?.call.id).toBe("call_1");
  });
});

describe("BackgroundRuntime: retry gating on committed page effects (regression)", () => {
  it("marks a rate-limit failure non-retryable once a consequential action already succeeded this run", async () => {
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    let round = 0;
    provider.script = () => {
      round += 1;
      if (round === 1) {
        return {
          [Symbol.asyncIterator]: async function* () {
            yield { type: "tool.call", call: { id: "call_1", name: "browser_program", arguments: { source: 'await browser.tab("/tabs/1/page.md").getByRole("button", {name: "Submit", exact: true}).click();' } } } as ScriptedProviderEvent;
            yield { type: "turn.completed", replayState: null } as ScriptedProviderEvent;
          },
        };
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          throw new ProviderStreamError("Rate limited.", "RATE_LIMIT");
        },
      };
    };
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: supportedPageTabControllerFactory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);

    const runCommand = runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Click submit" });
    await runCommand;

    const failed = port.received.find((e) => e.type === "run.failed");
    expect(failed).toBeDefined();
    if (failed?.type !== "run.failed") throw new Error("expected run.failed");
    expect(failed.payload.code).toBe("RATE_LIMIT");
    // RATE_LIMIT is retryable by provider-error type, but the click already
    // committed a real page effect this run, so retry must never be offered.
    expect(failed.payload.retryable).toBe(false);
  });
});
