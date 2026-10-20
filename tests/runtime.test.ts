import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "wxt/browser";
import { AGENT_TAB_IDLE_MS, BackgroundRuntime } from "@/lib/background/runtime";
import { ApprovalBadge } from "@/lib/background/approval-badge";
import { ChatGPTAuth } from "@/lib/background/chatgpt-auth";
import { SidebarHub } from "@/lib/background/sidebar-hub";
import { TabController } from "@/lib/background/tab-controller";
import type { TabControllerBrowserApi } from "@/lib/background/tab-controller";
import type { RuntimeClock } from "@/lib/background/runtime";
import { ProviderStreamError } from "@/lib/providers/openai";
import { saveOpenAICredential, appendConversationItem, getAgentTabs, getConversation, getOpenAICredential, saveAgentTabs, saveRunCheckpoint } from "@/lib/storage";
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

describe("BackgroundRuntime: approval badge", () => {
  function fakeBadge() {
    const texts: string[] = [];
    const colors: string[] = [];
    const badge = new ApprovalBadge({
      setBadgeText: async ({ text }) => { texts.push(text); },
      setBadgeBackgroundColor: async ({ color }) => { colors.push(color); },
    });
    return { badge, texts, colors };
  }

  /** Round 1 asks for confirmation; later rounds answer, or wait for cancellation. */
  function confirmationProvider(): FakeProvider {
    const provider = new FakeProvider();
    let round = 0;
    provider.script = () => {
      round += 1;
      const events: ScriptedProviderEvent[] = round === 1
        ? [{ type: "tool.call", call: { id: "call_1", name: "request_action_confirmation", arguments: { title: "Submit", message: "Submit the draft?", artifact: "Draft" } } }, { type: "turn.completed", replayState: null }]
        : [{ type: "text.delta", delta: "Done." }, { type: "turn.completed", replayState: null }];
      return { [Symbol.asyncIterator]: async function* () { yield* events; } };
    };
    return provider;
  }

  async function startAwaitingApproval(badge: ApprovalBadge) {
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider: confirmationProvider(), tabControllerFactory: supportedPageTabControllerFactory, approvalBadge: badge });
    hub.delegate = runtime;
    const run = runtime.handleCommand({ v: 1, id: "start", type: "run.start", prompt: "Submit it" });
    await tick(200);
    const snapshot = await runtime.getSnapshot();
    expect(snapshot.activeRun?.status).toBe("awaiting-approval");
    return { runtime, run, runId: snapshot.activeRun!.runId };
  }

  it("sets the badge while awaiting approval and clears it when approved and the run completes", async () => {
    const { badge, texts, colors } = fakeBadge();
    const { runtime, run, runId } = await startAwaitingApproval(badge);
    expect(texts.at(-1)).toBe("!");
    expect(colors).toHaveLength(1);
    expect(badge.pending).toBe(true);

    await runtime.handleCommand({ v: 1, id: "approve", type: "action.approve", runId, callId: "call_1" });
    await run;
    expect((await runtime.getSnapshot()).activeRun).toBeNull();
    expect(texts.at(-1)).toBe("");
    expect(badge.pending).toBe(false);
  });

  it("clears the badge when the approval is denied", async () => {
    const { badge, texts } = fakeBadge();
    const { runtime, run, runId } = await startAwaitingApproval(badge);
    await runtime.handleCommand({ v: 1, id: "deny", type: "action.deny", runId, callId: "call_1" });
    await tick();
    expect(texts.at(-1)).toBe("");
    await run;
    expect(texts.at(-1)).toBe("");
  });

  it("clears the badge when the run is cancelled while awaiting approval", async () => {
    const { badge, texts } = fakeBadge();
    const { runtime, run, runId } = await startAwaitingApproval(badge);
    await runtime.handleCommand({ v: 1, id: "cancel", type: "run.cancel", runId });
    await run;
    expect((await runtime.getSnapshot()).activeRun).toBeNull();
    expect(texts.at(-1)).toBe("");
    expect(badge.pending).toBe(false);
  });

  it("clears the badge on every terminal transition, including a failed run", async () => {
    await saveOpenAICredential("sk-test");
    const { badge, texts } = fakeBadge();
    const provider = new FakeProvider();
    provider.script = () => ({ [Symbol.asyncIterator]: async function* () { throw new ProviderStreamError("Rate limited.", "RATE_LIMIT"); } });
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory, approvalBadge: badge });
    hub.delegate = runtime;
    await runtime.handleCommand({ v: 1, id: "start", type: "run.start", prompt: "Hi" });
    await tick();
    expect(texts).toEqual([""]);
  });

  it("clears a stale badge at startup while recovering an interrupted approval", async () => {
    await saveRunCheckpoint({ version: 1, runId: "r1", status: "awaiting-approval", partialAssistantText: "", lastSeq: 3, updatedAt: 1 });
    const { badge, texts } = fakeBadge();
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), approvalBadge: badge });
    await runtime.initialize();
    await tick();
    expect(texts).toEqual([""]);
    expect((await getConversation()).items.at(-1)).toMatchObject({ id: "interrupted-r1", role: "assistant" });
  });
});

describe("BackgroundRuntime: run.retry", () => {
  const userTexts = async () => (await getConversation()).items.flatMap((item) => item.kind === "message" && item.role === "user" ? [item.text] : []);
  const answer = (text: string): ScriptedProviderEvent[] => [{ type: "text.delta", delta: text }, { type: "turn.completed", replayState: null }];

  function scriptedRounds(provider: FakeProvider, rounds: Array<ScriptedProviderEvent[] | Error>): void {
    let round = 0;
    provider.script = (signal) => {
      const next = rounds[round++] ?? answer("Extra.");
      return { [Symbol.asyncIterator]: async function* () {
        if (next instanceof Error) throw next;
        yield* next;
        if (next.at(-1)?.type === "turn.completed") return;
        const { promise, reject } = Promise.withResolvers<never>();
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        await promise;
      } };
    };
  }

  function setup(provider: FakeProvider) {
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);
    return { runtime, port };
  }

  it("re-runs a failed turn without a second user message; the model sees history through the original prompt, not the failed attempt's interim text", async () => {
    await saveOpenAICredential("sk-test");
    await appendConversationItem({ id: "u0", kind: "message", role: "user", text: "Earlier", context: null, at: 1 });
    await appendConversationItem({ id: "a0", kind: "message", role: "assistant", text: "Earlier answer.", at: 2 });
    const provider = new FakeProvider();
    scriptedRounds(provider, [
      [{ type: "text.delta", delta: "Let me look." }, { type: "tool.call", call: { id: "call_1", name: "browser_program", arguments: { source: 'return await fs.read("/tabs/1/page.md");' } } }, { type: "turn.completed", replayState: null }],
      new ProviderStreamError("Rate limited.", "RATE_LIMIT"),
      answer("Found it."),
    ]);
    const { runtime, port } = setup(provider);

    await runtime.handleCommand({ v: 1, id: "start", type: "run.start", prompt: "Find it" });
    expect(port.received.find((event) => event.type === "run.failed")?.payload).toMatchObject({ code: "RATE_LIMIT", retryable: true });

    await runtime.handleCommand({ v: 1, id: "retry", type: "run.retry" });
    const started = port.received.filter((event) => event.type === "run.started").at(-1);
    expect(started?.payload).toMatchObject({ prompt: "Find it", retry: true });
    expect(port.received.at(-1)?.type).toBe("run.completed");
    expect(await userTexts()).toEqual(["Earlier", "Find it"]);
    expect(provider.requests[2]?.context.messages.map((message) => [message.role, JSON.stringify(message.content)])).toEqual([
      ["user", JSON.stringify("Earlier")],
      ["assistant", JSON.stringify([{ type: "text", text: "Earlier answer." }])],
      ["user", JSON.stringify("Find it")],
    ]);
    // The failed attempt stays visible in the same turn, followed by the retried answer.
    const items = (await getConversation()).items;
    expect(items.some((item) => item.kind === "message" && item.text === "Let me look.")).toBe(true);
    expect(items.at(-1)).toMatchObject({ role: "assistant", text: "Found it." });
  });

  it("re-runs a cancelled turn, keeping its stopped partial text visible but out of the retried request", async () => {
    await saveOpenAICredential("sk-test");
    const provider = new FakeProvider();
    scriptedRounds(provider, [[{ type: "text.delta", delta: "The page says" }], answer("Done.")]);
    const { runtime } = setup(provider);

    const run = runtime.handleCommand({ v: 1, id: "start", type: "run.start", prompt: "Read it" });
    await tick();
    await runtime.handleCommand({ v: 1, id: "cancel", type: "run.cancel", runId: (await runtime.getSnapshot()).activeRun!.runId });
    await run;

    await runtime.handleCommand({ v: 1, id: "retry", type: "run.retry" });
    expect(await userTexts()).toEqual(["Read it"]);
    expect(provider.requests[1]?.context.messages.map((message) => message.role)).toEqual(["user"]);
    const texts = (await getConversation()).items.flatMap((item) => item.kind === "message" && item.role === "assistant" ? [item.text] : []);
    expect(texts).toEqual([expect.stringContaining("Stopped"), "Done."]);
  });

  it("re-runs a turn interrupted by a background restart", async () => {
    await saveOpenAICredential("sk-test");
    await appendConversationItem({ id: "u1", kind: "message", role: "user", text: "Before restart", context: null, at: 1 });
    await saveRunCheckpoint({ version: 1, runId: "r1", status: "running", partialAssistantText: "Half", lastSeq: 2, updatedAt: 1 });
    const provider = new FakeProvider();
    scriptedRounds(provider, [answer("After restart.")]);
    const { runtime } = setup(provider);
    await runtime.initialize();

    await runtime.handleCommand({ v: 1, id: "retry", type: "run.retry" });
    expect(await userTexts()).toEqual(["Before restart"]);
    expect(provider.requests[0]?.context.messages.map((message) => message.role)).toEqual(["user"]);
    expect((await getConversation()).items.at(-1)).toMatchObject({ role: "assistant", text: "After restart." });
  });

  it("drops a retry after a completed turn, a successful retry, a context reset, or with no history", async () => {
    await saveOpenAICredential("sk-test");
    const provider = new FakeProvider();
    scriptedRounds(provider, [answer("One."), new ProviderStreamError("Rate limited.", "RATE_LIMIT"), answer("Two.")]);
    const { runtime, port } = setup(provider);

    await runtime.handleCommand({ v: 1, id: "none", type: "run.retry" });
    expect(provider.requests).toHaveLength(0);
    expect(port.received.at(-1)?.type).toBe("state.snapshot");

    await runtime.handleCommand({ v: 1, id: "start", type: "run.start", prompt: "First" });
    await runtime.handleCommand({ v: 1, id: "after-complete", type: "run.retry" });
    expect(provider.requests).toHaveLength(1);

    await runtime.handleCommand({ v: 1, id: "start2", type: "run.start", prompt: "Second" });
    await runtime.handleCommand({ v: 1, id: "retry", type: "run.retry" });
    await runtime.handleCommand({ v: 1, id: "retry-again", type: "run.retry" });
    expect(provider.requests).toHaveLength(3);
    expect(await userTexts()).toEqual(["First", "Second"]);

    scriptedRounds(provider, [new ProviderStreamError("Rate limited.", "RATE_LIMIT")]);
    await runtime.handleCommand({ v: 1, id: "start3", type: "run.start", prompt: "Third" });
    await runtime.handleCommand({ v: 1, id: "reset", type: "context.reset" });
    await runtime.handleCommand({ v: 1, id: "after-reset", type: "run.retry" });
    expect(provider.requests).toHaveLength(4);
    expect((await getConversation()).items).toEqual([]);
  });

  it("drops a retry while a run is active", async () => {
    await saveOpenAICredential("sk-test");
    const provider = new FakeProvider();
    scriptedRounds(provider, [new ProviderStreamError("Rate limited.", "RATE_LIMIT"), [{ type: "text.delta", delta: "Working" }]]);
    const { runtime } = setup(provider);
    await runtime.handleCommand({ v: 1, id: "start", type: "run.start", prompt: "Go" });

    const retry = runtime.handleCommand({ v: 1, id: "retry", type: "run.retry" });
    await tick();
    await runtime.handleCommand({ v: 1, id: "retry-again", type: "run.retry" });
    expect(provider.requests).toHaveLength(2);
    await runtime.handleCommand({ v: 1, id: "cancel", type: "run.cancel", runId: (await runtime.getSnapshot()).activeRun!.runId });
    await retry;
    expect(await userTexts()).toEqual(["Go"]);
  });
});

type FakeTab = { id: number; url: string; title: string; hidden: boolean };

/** A tabs API over a mutable tab list: enough for agent-tab bookkeeping and browser.open(). */
function fakeTabsApi(tabs: FakeTab[]) {
  let nextId = 100;
  const api = {
    tabs: {
      query: vi.fn(async () => tabs.map((tab) => ({ ...tab }))),
      create: vi.fn(async ({ url }: { url: string }) => {
        const tab = { id: nextId++, url, title: "", hidden: false };
        tabs.push(tab);
        return { ...tab };
      }),
      hide: vi.fn(async (tabId: number) => { tabs.find((tab) => tab.id === tabId)!.hidden = true; return [tabId]; }),
      show: vi.fn(async (tabId: number) => { tabs.find((tab) => tab.id === tabId)!.hidden = false; }),
      remove: vi.fn(async (tabId: number) => {
        const index = tabs.findIndex((tab) => tab.id === tabId);
        if (index < 0) throw new Error("Invalid tab ID");
        tabs.splice(index, 1);
      }),
      update: vi.fn(async () => {}),
      goBack: vi.fn(async () => {}),
      sendMessage: vi.fn(async (_tabId: number, message: unknown) => {
        const request = message as { id: string; type: string };
        if (request.type === "page.health") return { v: 1, id: request.id, ok: true, type: "page.health", url: "https://example.test/" };
        throw new Error("no content script");
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  } satisfies TabControllerBrowserApi;
  return { api, factory: () => new TabController(api) };
}

function programRound(source: string): ScriptedProviderEvent[][] {
  return [
    [{ type: "tool.call", call: { id: "program", name: "browser_program", arguments: { source } } }, { type: "turn.completed", replayState: null }],
    [{ type: "text.delta", delta: "Done." }, { type: "turn.completed", replayState: null }],
  ];
}

function scripted(provider: FakeProvider, rounds: ScriptedProviderEvent[][]): void {
  let round = 0;
  provider.script = () => {
    const events = rounds[round++] ?? [{ type: "turn.completed", replayState: null }];
    return { [Symbol.asyncIterator]: async function* () { yield* events; } };
  };
}

/** What the model was shown after the scripted program ran. */
function modelInput(provider: FakeProvider): string {
  return JSON.stringify(provider.requests.at(-1)?.context.messages);
}

describe("BackgroundRuntime: agent-tab ownership across restarts", () => {
  const userTab = { id: 1, url: "https://user.test/", title: "User", hidden: false };

  it("restores /agent-tabs at startup, dropping closed tabs and reused tab IDs", async () => {
    await saveAgentTabs({ version: 1, searchTabId: 6, tabs: {
      "5": { url: "https://kept.test/", lastUsedAt: 100 },
      "6": { url: "https://closed.test/", lastUsedAt: 100 },
      "7": { url: "https://agent.test/", lastUsedAt: 100 },
      "8": { url: "https://shown.test/", lastUsedAt: 100 },
    } });
    const { factory } = fakeTabsApi([
      userTab,
      { id: 5, url: "https://kept.test/", title: "Kept", hidden: true },
      // After a browser restart Firefox may hand an old ID to an unrelated tab.
      { id: 7, url: "https://other-extension.test/", title: "Grouped", hidden: true },
      { id: 8, url: "https://shown.test/", title: "Shown", hidden: false },
    ]);
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    scripted(provider, programRound('return fs.list("/agent-tabs");'));
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: factory });
    hub.delegate = runtime;
    await runtime.initialize();

    expect(await getAgentTabs()).toEqual({ version: 1, searchTabId: null, tabs: { "5": { url: "https://kept.test/", lastUsedAt: 100 } } });
    await runtime.handleCommand({ v: 1, id: "run", type: "run.start", prompt: "List agent tabs" });
    const listed = modelInput(provider);
    expect(listed).toContain("/agent-tabs/5/page.md");
    expect(listed).not.toMatch(/\/agent-tabs\/[678]\//);
  });

  it("holds sidebar commands until startup restoration finishes", async () => {
    await saveAgentTabs({ version: 1, searchTabId: null, tabs: { "5": { url: "https://kept.test/", lastUsedAt: 100 } } });
    const { factory } = fakeTabsApi([userTab, { id: 5, url: "https://kept.test/", title: "Kept", hidden: true }]);
    // Stall startup's storage reads; tabs.list itself never reads storage.
    const gate = Promise.withResolvers<void>();
    const get = browser.storage.local.get.bind(browser.storage.local);
    const stalled = vi.spyOn(browser.storage.local, "get").mockImplementation((async (keys: never) => { await gate.promise; return get(keys); }) as never);
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), tabControllerFactory: factory });

    const startup = runtime.initialize();
    let path: string | undefined;
    const listed = runtime.handleCommand({ v: 1, id: "tabs", type: "tabs.list" }).then((result) => { path = result && "tabs" in result ? result.tabs.find((tab) => tab.id === 5)?.path : undefined; });
    await tick();
    expect(path).toBeUndefined();
    gate.resolve();
    await Promise.all([startup, listed]);
    stalled.mockRestore();
    expect(path).toBe("/agent-tabs/5/page.md");
  });

  it("persists a tab opened by a program and releases it when the program closes it", async () => {
    const tabs = [userTab];
    const { factory } = fakeTabsApi(tabs);
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    scripted(provider, programRound('const page = await browser.open("https://example.test/"); return page.path();'));
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: factory });
    hub.delegate = runtime;
    await runtime.initialize();

    await runtime.handleCommand({ v: 1, id: "open", type: "run.start", prompt: "Open example" });
    await vi.waitFor(async () => expect(Object.keys((await getAgentTabs()).tabs)).toEqual(["100"]));
    expect((await getAgentTabs()).tabs["100"]?.url).toBe("https://example.test/");

    scripted(provider, programRound('return fs.remove("/agent-tabs/100/page.md");'));
    await runtime.handleCommand({ v: 1, id: "close", type: "run.start", prompt: "Close it" });
    await vi.waitFor(async () => expect((await getAgentTabs()).tabs).toEqual({}));
    expect(tabs.map((tab) => tab.id)).toEqual([1]);
  });
});

/** A manual clock: `sweep()` fires the runtime's idle timer and waits for it to settle. */
function manualClock(start = 10_000_000) {
  let time = start;
  let timer: (() => void) | null = null;
  const clock: RuntimeClock = { now: () => time, setInterval: (callback) => { timer = callback; return 1; } };
  return {
    clock,
    advance(ms: number) { time += ms; },
    async sweep() { timer!(); await tick(); },
  };
}

/** A provider whose single round blocks until `release()`, keeping a run active. */
function blockingProvider(): { provider: FakeProvider; release: () => void } {
  const provider = new FakeProvider();
  const gate = Promise.withResolvers<void>();
  provider.script = () => ({ [Symbol.asyncIterator]: async function* () {
    await gate.promise;
    yield { type: "turn.completed", replayState: null } as ScriptedProviderEvent;
  } });
  return { provider, release: () => gate.resolve() };
}

describe("BackgroundRuntime: closing agent tabs", () => {
  const minute = 60_000;
  const userTab = { id: 1, url: "https://user.test/", title: "User", hidden: false };
  const agentTab = (id: number) => ({ id, url: `https://agent-${id}.test/`, title: "", hidden: true });
  const owned = (now: number, ...entries: [number, number][]) => saveAgentTabs({ version: 1, searchTabId: entries[0]?.[0] ?? null,
    tabs: Object.fromEntries(entries.map(([id, idleMs]) => [String(id), { url: `https://agent-${id}.test/`, lastUsedAt: now - idleMs }])) });

  it("closes every agent tab, including the search tab, on request and leaves user tabs alone", async () => {
    const { clock } = manualClock();
    await owned(clock.now(), [5, 0], [6, 0]);
    const tabs = [userTab, agentTab(5), agentTab(6)];
    const { factory } = fakeTabsApi(tabs);
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider: new FakeProvider(), tabControllerFactory: factory, clock });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);
    await runtime.initialize();
    expect((await runtime.getSnapshot()).agentTabs).toBe(2);

    await port.send({ v: 1, id: "close", type: "tabs.closeAgentTabs" });
    expect(tabs.map((tab) => tab.id)).toEqual([1]);
    expect(await getAgentTabs()).toEqual({ version: 1, tabs: {}, searchTabId: null });
    expect((await runtime.getSnapshot()).agentTabs).toBe(0);
    const counts = port.received.flatMap((event) => event.type === "agent-tabs.changed" ? [event.payload.count] : []);
    expect(counts).toEqual([2, 0]);
  });

  it("refuses to close agent tabs while a run is active", async () => {
    const { clock } = manualClock();
    await owned(clock.now(), [5, 0]);
    const tabs = [userTab, agentTab(5)];
    const { factory } = fakeTabsApi(tabs);
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const { provider, release } = blockingProvider();
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: factory, clock });
    hub.delegate = runtime;
    await runtime.initialize();

    const run = runtime.handleCommand({ v: 1, id: "run", type: "run.start", prompt: "Wait" });
    await tick();
    expect((await runtime.getSnapshot()).activeRun).not.toBeNull();
    await runtime.handleCommand({ v: 1, id: "close", type: "tabs.closeAgentTabs" });
    expect(tabs.map((tab) => tab.id)).toEqual([1, 5]);
    release();
    await run;
    await runtime.handleCommand({ v: 1, id: "close", type: "tabs.closeAgentTabs" });
    expect(tabs.map((tab) => tab.id)).toEqual([1]);
  });

  it("auto-closes agent tabs once no run has used them for the idle period", async () => {
    const { clock, advance, sweep } = manualClock();
    await owned(clock.now(), [5, AGENT_TAB_IDLE_MS + minute], [6, 5 * minute]);
    const tabs = [userTab, agentTab(5), agentTab(6)];
    const { factory } = fakeTabsApi(tabs);
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), tabControllerFactory: factory, clock });
    await runtime.initialize();

    await sweep();
    expect(tabs.map((tab) => tab.id)).toEqual([1, 6]);
    expect(await getAgentTabs()).toEqual({ version: 1, searchTabId: null, tabs: { "6": { url: "https://agent-6.test/", lastUsedAt: clock.now() - 5 * minute } } });

    advance(AGENT_TAB_IDLE_MS - 6 * minute);
    await sweep();
    expect(tabs.map((tab) => tab.id)).toEqual([1, 6]);
    advance(2 * minute);
    await sweep();
    expect(tabs.map((tab) => tab.id)).toEqual([1]);
  });

  it("never auto-closes while a run is active, and restarts the idle period of tabs the run used", async () => {
    const { clock, advance, sweep } = manualClock();
    const tabs = [userTab, agentTab(5)];
    await owned(clock.now(), [5, minute]);
    const { factory } = fakeTabsApi(tabs);
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    const gate = Promise.withResolvers<void>();
    let round = 0;
    provider.script = () => ({ [Symbol.asyncIterator]: async function* () {
      if (round++ === 0) {
        yield { type: "tool.call", call: { id: "open", name: "browser_program", arguments: { source: 'const page = await browser.open("https://example.test/"); return page.path();' } } } as ScriptedProviderEvent;
      } else await gate.promise;
      yield { type: "turn.completed", replayState: null } as ScriptedProviderEvent;
    } });
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: factory, clock });
    hub.delegate = runtime;
    await runtime.initialize();

    const run = runtime.handleCommand({ v: 1, id: "run", type: "run.start", prompt: "Open example and think for a long time" });
    await vi.waitFor(() => expect(tabs.map((tab) => tab.id)).toEqual([1, 5, 100]));
    advance(AGENT_TAB_IDLE_MS + 10 * minute);
    await sweep();
    // Tab 5 is idle and tab 100 was opened long ago, but a run is active.
    expect(tabs.map((tab) => tab.id)).toEqual([1, 5, 100]);

    gate.resolve();
    await run;
    await sweep();
    expect(tabs.map((tab) => tab.id)).toEqual([1, 100]);
    advance(AGENT_TAB_IDLE_MS + minute);
    await sweep();
    expect(tabs.map((tab) => tab.id)).toEqual([1]);
  });
});

describe("BackgroundRuntime: Phase 0 integration (regression)", () => {
  const userTab = { id: 1, url: "https://user.test/", title: "User", hidden: false };

  it("finishes interrupted-run recovery and starts the idle sweep even when agent-tab restoration fails", async () => {
    await saveOpenAICredential("sk-test");
    await appendConversationItem({ id: "u1", kind: "message", role: "user", text: "Before restart", context: null, at: 1 });
    await saveRunCheckpoint({ version: 1, runId: "r1", status: "running", partialAssistantText: "", lastSeq: 2, updatedAt: 1 });
    const { api, factory } = fakeTabsApi([userTab]);
    api.tabs.query.mockRejectedValueOnce(new Error("Tabs unavailable."));
    const { clock, sweep } = manualClock();
    const provider = new FakeProvider();
    scripted(provider, [[{ type: "text.delta", delta: "After restart." }, { type: "turn.completed", replayState: null }]]);
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: factory, clock });
    hub.delegate = runtime;

    await runtime.initialize();
    await sweep();
    await runtime.handleCommand({ v: 1, id: "retry", type: "run.retry" });
    expect(provider.requests).toHaveLength(1);
    expect((await getConversation()).items.at(-1)).toMatchObject({ role: "assistant", text: "After restart." });
  });

  it("keeps a tab adopted while an earlier ownership write is still reading the tab list", async () => {
    await saveAgentTabs({ version: 1, searchTabId: null, tabs: { "5": { url: "https://agent-5.test/", lastUsedAt: 1 } } });
    const tabs = [userTab, { id: 5, url: "https://agent-5.test/", title: "", hidden: true }];
    const { api, factory } = fakeTabsApi(tabs);
    // Hold the tab-list read that releasing tab 5 starts until the next tab is created and hidden.
    const query = api.tabs.query.getMockImplementation()!;
    const remove = api.tabs.remove.getMockImplementation()!;
    const hide = api.tabs.hide.getMockImplementation()!;
    const gate = Promise.withResolvers<void>();
    let stallNext = false;
    api.tabs.query.mockImplementation(async () => {
      const listed = await query();
      if (stallNext) { stallNext = false; await gate.promise; }
      return listed;
    });
    api.tabs.remove.mockImplementation(async (tabId: number) => { await remove(tabId); stallNext = true; });
    api.tabs.hide.mockImplementation(async (tabId: number) => { const hidden = await hide(tabId); gate.resolve(); return hidden; });
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    scripted(provider, programRound('await fs.remove("/agent-tabs/5/page.md"); const page = await browser.open("https://example.test/"); return page.path();'));
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: factory });
    hub.delegate = runtime;
    await runtime.initialize();

    await runtime.handleCommand({ v: 1, id: "run", type: "run.start", prompt: "Swap tabs" });
    expect(modelInput(provider)).toContain("/agent-tabs/100/page.md");
    await vi.waitFor(async () => expect(Object.keys((await getAgentTabs()).tabs)).toEqual(["100"]));
    expect((await runtime.getSnapshot()).agentTabs).toBe(1);
  });

  it("re-persists an agent tab's URL after it navigates, so a restart still restores it", async () => {
    await saveAgentTabs({ version: 1, searchTabId: null, tabs: { "5": { url: "https://agent-5.test/", lastUsedAt: 1 } } });
    const tabs = [userTab, { id: 5, url: "https://agent-5.test/", title: "", hidden: true }];
    const { factory } = fakeTabsApi(tabs);
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), tabControllerFactory: factory });
    await runtime.initialize();

    tabs[1]!.url = "https://agent-5.test/next";
    runtime.handleTabUrlChanged(5);
    await vi.waitFor(async () => expect((await getAgentTabs()).tabs["5"]?.url).toBe("https://agent-5.test/next"));
    // A user-tab navigation is not an ownership change.
    runtime.handleTabUrlChanged(1);

    const restarted = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), tabControllerFactory: factory });
    await restarted.initialize();
    expect((await restarted.getSnapshot()).agentTabs).toBe(1);
  });
});
