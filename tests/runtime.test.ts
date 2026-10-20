import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "wxt/browser";
import { AGENT_TAB_IDLE_MS, BackgroundRuntime } from "@/lib/background/runtime";
import { ApprovalBadge } from "@/lib/background/approval-badge";
import { ChatGPTAuth } from "@/lib/background/chatgpt-auth";
import { SidebarHub } from "@/lib/background/sidebar-hub";
import { TabController } from "@/lib/background/tab-controller";
import { AGENT_TAB_TAG_KEY } from "@/lib/background/tab-controller";
import type { TabControllerBrowserApi } from "@/lib/background/tab-controller";
import type { RuntimeClock } from "@/lib/background/runtime";
import { ProviderStreamError } from "@/lib/providers/openai";
import { saveOpenAICredential, appendConversationItem, getConversation, getOpenAICredential, saveRunCheckpoint } from "@/lib/storage";
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
  function subscription(failing = false) {
    const auth = new ChatGPTAuth();
    vi.spyOn(auth, "status").mockResolvedValue({ connected: true, email: "user@example.test", signInAgain: false });
    vi.spyOn(auth, "models").mockResolvedValue([{ id: "account-model", name: "Account model", reasoningEfforts: ["none"], defaultReasoningEffort: "none" }]);
    vi.spyOn(auth, "getAuth").mockImplementation(async () => {
      if (failing) throw new ProviderStreamError("ChatGPT token exchange failed. Reconnect in settings.", "AUTHENTICATION");
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
    expect(snapshot.credential).toMatchObject({ configured: true, chatgpt: { connected: true } });
    const exported = await runtime.handleCommand({ v: 1, id: "export", type: "context.export" });
    for (const value of [JSON.stringify(snapshot), exported.markdown]) {
      expect(value).not.toContain("test-subscription-token");
      expect(value).not.toContain("sk-test-existing-key");
    }
  });

  it("does not fall back to the saved API key when the subscription cannot authenticate", async () => {
    await saveOpenAICredential("sk-test-existing-key");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    const runtime = new BackgroundRuntime(hub, { provider, chatgpt: subscription(true), tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);
    await port.send({ v: 1, id: "sub", type: "state.subscribe", lastSeq: null });
    await runtime.handleCommand({ v: 1, id: "start", type: "run.start", prompt: "Hello" });
    expect(provider.requests).toEqual([]);
    expect((await getConversation()).items).toEqual([]);
    expect(port.received.some((event) => event.type === "state.snapshot" && event.payload.notice?.includes("Reconnect in settings"))).toBe(true);
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

  it("migrates legacy credentials at startup and dismisses the sign-in notice even during a run", async () => {
    await browser.storage.local.set({
      openaiCredential: { version: 1, apiKey: "sk-test-legacy-plaintext", updatedAt: 1 },
      chatgptCredential: { version: 1, salt: "A".repeat(24), iv: "B".repeat(16), ciphertext: "C".repeat(64), models: [] },
    });
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider: new FakeProvider(), tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    await runtime.initialize();
    expect(JSON.stringify(await browser.storage.local.get(null))).not.toContain("sk-test-legacy-plaintext");
    const status = await runtime.handleCredentialRequest({ v: 1, id: "status", type: "credentials.openai.status" });
    expect(status).toMatchObject({ ok: true, configured: true, maskedSuffix: "text", chatgpt: { connected: false, signInAgain: true } });
    const dismissed = await runtime.handleCredentialRequest({ v: 1, id: "dismiss", type: "credentials.chatgpt.notice.dismiss" });
    expect(dismissed).toMatchObject({ ok: true, chatgpt: { signInAgain: false } });
  });

  it("applies an options-page credential change only after the startup migration finishes", async () => {
    await browser.storage.local.set({ openaiCredential: { version: 1, apiKey: "sk-test-legacy-plaintext", updatedAt: 1 } });
    const sealing = Promise.withResolvers<void>();
    let sealWriteStarted = false;
    const set = browser.storage.local.set.bind(browser.storage.local);
    const spy = vi.spyOn(browser.storage.local, "set").mockImplementation(async (items) => {
      if ((items as { openaiCredential?: { version?: number } }).openaiCredential?.version === 2) {
        sealWriteStarted = true;
        await sealing.promise;
      }
      return set(items);
    });
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider: new FakeProvider(), tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const started = runtime.initialize();
    await vi.waitFor(() => expect(sealWriteStarted).toBe(true));
    const deleted = runtime.handleCredentialRequest({ v: 1, id: "delete", type: "credentials.openai.delete" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    sealing.resolve();
    await started;
    expect(await deleted).toMatchObject({ ok: true, configured: false });
    spy.mockRestore();
    // The migration's sealed copy must not resurrect a key deleted while it ran.
    expect(await getOpenAICredential()).toBeNull();
    expect(await browser.storage.local.get("openaiCredential")).toEqual({});
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

  const click = 'await browser.tab("/tabs/1/page.md").getByRole("button", {name: "Submit", exact: true}).click();';

  function refusedRetry(provider: FakeProvider, port: FakePort, requestsBefore: number) {
    expect(provider.requests).toHaveLength(requestsBefore);
    const snapshot = port.received.at(-1);
    if (snapshot?.type !== "state.snapshot") throw new Error("expected state.snapshot");
    expect(snapshot.payload.activeRun).toBeNull();
    expect(snapshot.payload.notice).toContain("already changed a page");
  }

  function setup(provider: FakeProvider) {
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: supportedPageTabControllerFactory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);
    return { runtime, port };
  }

  it("refuses run.retry after a failed attempt committed a page effect", async () => {
    await saveOpenAICredential("sk-test");
    const provider = new FakeProvider();
    let round = 0;
    provider.script = () => ({ [Symbol.asyncIterator]: async function* () {
      if (round++ > 0) throw new ProviderStreamError("Rate limited.", "RATE_LIMIT");
      yield { type: "tool.call", call: { id: "call_1", name: "browser_program", arguments: { source: click } } } as ScriptedProviderEvent;
      yield { type: "turn.completed", replayState: null } as ScriptedProviderEvent;
    } });
    const { runtime, port } = setup(provider);
    await runtime.handleCommand({ v: 1, id: "start", type: "run.start", prompt: "Click submit" });
    expect(port.received.some((event) => event.type === "run.failed")).toBe(true);

    await runtime.handleCommand({ v: 1, id: "retry", type: "run.retry" });
    refusedRetry(provider, port, 2);
  });

  it("refuses run.retry after a cancelled attempt committed a page effect", async () => {
    await saveOpenAICredential("sk-test");
    const provider = new FakeProvider();
    let round = 0;
    provider.script = (signal) => ({ [Symbol.asyncIterator]: async function* () {
      if (round++ === 0) {
        yield { type: "tool.call", call: { id: "call_1", name: "browser_program", arguments: { source: click } } } as ScriptedProviderEvent;
        yield { type: "turn.completed", replayState: null } as ScriptedProviderEvent;
        return;
      }
      if (round > 2) {
        yield { type: "turn.completed", replayState: null } as ScriptedProviderEvent;
        return;
      }
      const { promise, reject } = Promise.withResolvers<never>();
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      await promise;
    } });
    const { runtime, port } = setup(provider);
    const run = runtime.handleCommand({ v: 1, id: "start", type: "run.start", prompt: "Click submit" });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    await runtime.handleCommand({ v: 1, id: "cancel", type: "run.cancel", runId: (await runtime.getSnapshot()).activeRun!.runId });
    await run;
    expect(port.received.some((event) => event.type === "run.cancelled")).toBe(true);

    await runtime.handleCommand({ v: 1, id: "retry", type: "run.retry" });
    refusedRetry(provider, port, 2);
  });

  it("refuses run.retry after an interrupted attempt that had started a browser program", async () => {
    await saveOpenAICredential("sk-test");
    await appendConversationItem({ id: "u1", kind: "message", role: "user", text: "Click submit", context: null, at: 1 });
    // The checkpoint does not record effects, so a program the interrupted attempt started may have committed one.
    await appendConversationItem({ id: "c1", kind: "tool-call", call: { id: "call_1", name: "browser_program", arguments: { source: click } }, at: 2 });
    await saveRunCheckpoint({ version: 1, runId: "r1", status: "running", partialAssistantText: "", lastSeq: 2, updatedAt: 1 });
    const provider = new FakeProvider();
    const { runtime, port } = setup(provider);
    await runtime.initialize();

    await runtime.handleCommand({ v: 1, id: "retry", type: "run.retry" });
    refusedRetry(provider, port, 0);
  });

  it("keeps a turn retryable across a failed retry that committed no page effect", async () => {
    await saveOpenAICredential("sk-test");
    await appendConversationItem({ id: "u1", kind: "message", role: "user", text: "Read it", context: null, at: 1 });
    await saveRunCheckpoint({ version: 1, runId: "r1", status: "running", partialAssistantText: "", lastSeq: 2, updatedAt: 1 });
    const provider = new FakeProvider();
    let round = 0;
    provider.script = () => ({ [Symbol.asyncIterator]: async function* () {
      if (round++ === 0) throw new ProviderStreamError("Rate limited.", "RATE_LIMIT");
      yield { type: "text.delta", delta: "Done." } as ScriptedProviderEvent;
      yield { type: "turn.completed", replayState: null } as ScriptedProviderEvent;
    } });
    const { runtime } = setup(provider);
    await runtime.initialize();

    await runtime.handleCommand({ v: 1, id: "retry", type: "run.retry" });
    await runtime.handleCommand({ v: 1, id: "retry-again", type: "run.retry" });
    expect(provider.requests).toHaveLength(2);
    expect((await getConversation()).items.at(-1)).toMatchObject({ role: "assistant", text: "Done." });
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
type TagRole = "agent" | "search";

const tag = (lastUsedAt: number, role: TagRole = "agent") => ({ v: 1, role, lastUsedAt });

/**
 * A tabs + sessions API over a mutable tab list: enough for agent-tab
 * bookkeeping and browser.open(). `tags` holds each tab's agent session value,
 * which Firefox keeps with the tab whatever ID it has.
 */
function fakeTabsApi(tabs: FakeTab[], tags = new Map<number, unknown>()) {
  let nextId = 100;
  const open = (tabId: number) => { if (!tabs.some((tab) => tab.id === tabId)) throw new Error("Invalid tab ID"); };
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
        tags.delete(tabId);
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
    sessions: {
      getTabValue: vi.fn(async (tabId: number, key: string): Promise<unknown> => { open(tabId); return key === AGENT_TAB_TAG_KEY ? structuredClone(tags.get(tabId)) : undefined; }),
      setTabValue: vi.fn(async (tabId: number, key: string, value: unknown) => { open(tabId); if (key === AGENT_TAB_TAG_KEY) tags.set(tabId, structuredClone(value)); }),
      removeTabValue: vi.fn(async (tabId: number, key: string) => { open(tabId); if (key === AGENT_TAB_TAG_KEY) tags.delete(tabId); }),
    },
  } satisfies TabControllerBrowserApi;
  return { api, tags, factory: () => new TabController(api) };
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

/** The mount path the sidebar's tab list reports for each tab. */
async function tabPaths(runtime: BackgroundRuntime): Promise<Record<number, string>> {
  const listed = await runtime.handleCommand({ v: 1, id: "tabs", type: "tabs.list" });
  return Object.fromEntries((listed && "tabs" in listed ? listed.tabs : []).map((tab) => [tab.id, tab.path]));
}

describe("BackgroundRuntime: agent-tab ownership across restarts", () => {
  const userTab = { id: 1, url: "https://user.test/", title: "User", hidden: false };

  it("tags a tab a program opens and untags it when the program closes it", async () => {
    const { clock } = manualClock();
    const tabs = [userTab];
    const { api, tags, factory } = fakeTabsApi(tabs);
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    scripted(provider, programRound('const page = await browser.open("https://example.test/"); return page.path();'));
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: factory, clock });
    hub.delegate = runtime;
    await runtime.initialize();

    await runtime.handleCommand({ v: 1, id: "open", type: "run.start", prompt: "Open example" });
    await vi.waitFor(() => expect([...tags]).toEqual([[100, tag(clock.now())]]));

    scripted(provider, programRound('return fs.remove("/agent-tabs/100/page.md");'));
    await runtime.handleCommand({ v: 1, id: "close", type: "run.start", prompt: "Close it" });
    expect(tabs.map((tab) => tab.id)).toEqual([1]);
    expect(api.sessions.removeTabValue).toHaveBeenCalledWith(100, AGENT_TAB_TAG_KEY);
    expect(api.sessions.removeTabValue.mock.invocationCallOrder[0]).toBeLessThan(api.tabs.remove.mock.invocationCallOrder[0]!);
    expect(tags.size).toBe(0);
  });

  it("untags a tab moved to /tabs and tags a tab moved to /agent-tabs", async () => {
    const { clock } = manualClock();
    const tabs = [userTab, { id: 5, url: "https://agent-5.test/", title: "", hidden: true }];
    const { tags, factory } = fakeTabsApi(tabs, new Map([[5, tag(clock.now() - 1)]]));
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    scripted(provider, programRound('await fs.move("/agent-tabs/5/page.md", "/tabs/5/page.md"); return fs.move("/tabs/1/page.md", "/agent-tabs/1/page.md");'));
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: factory, clock });
    hub.delegate = runtime;
    await runtime.initialize();

    await runtime.handleCommand({ v: 1, id: "move", type: "run.start", prompt: "Swap tabs" });
    await vi.waitFor(() => expect([...tags]).toEqual([[1, tag(clock.now())]]));
    expect(tabs.map((tab) => [tab.id, tab.hidden])).toEqual([[1, true], [5, false]]);
    expect(await tabPaths(runtime)).toEqual({ 1: "/agent-tabs/1/page.md", 5: "/tabs/5/page.md" });
  });

  it("restores ownership after a browser restart reassigns tab IDs, from session tags alone", async () => {
    const { clock } = manualClock();
    const before = [userTab];
    const first = fakeTabsApi(before);
    await saveOpenAICredential("sk-test");
    const provider = new FakeProvider();
    scripted(provider, programRound('const a = await browser.open("https://a.test/"); const b = await browser.open("https://b.test/"); return [a.path(), b.path()];'));
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: first.factory, clock });
    hub.delegate = runtime;
    await runtime.initialize();
    await runtime.handleCommand({ v: 1, id: "open", type: "run.start", prompt: "Open two tabs" });
    await vi.waitFor(() => expect([...first.tags.keys()]).toEqual([100, 101]));

    // Firefox restarts: the session values follow the tabs to new IDs, and the
    // old IDs now name a user tab and an untagged hidden tab showing an agent tab's URL.
    const after = [
      { id: 100, url: "https://user-2.test/", title: "User 2", hidden: false },
      { id: 101, url: "https://b.test/", title: "", hidden: true },
      { id: 7, url: "https://a.test/navigated", title: "", hidden: true },
      { id: 8, url: "https://b.test/", title: "", hidden: true },
    ];
    const second = fakeTabsApi(after, new Map([[7, first.tags.get(100)], [8, first.tags.get(101)]]));
    const restarted = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), tabControllerFactory: second.factory, clock });
    await restarted.initialize();

    expect((await restarted.getSnapshot()).agentTabs).toBe(2);
    expect(await tabPaths(restarted)).toEqual({ 100: "/tabs/100/page.md", 101: "/tabs/101/page.md", 7: "/agent-tabs/7/page.md", 8: "/agent-tabs/8/page.md" });
    // Restored tags are current, so they are not rewritten, and untagged tabs stay untagged.
    expect(second.api.sessions.setTabValue).not.toHaveBeenCalled();
    expect([...second.tags.keys()]).toEqual([7, 8]);
  });

  it("restores the search tab's role", async () => {
    const { clock } = manualClock();
    const tabs = [userTab, { id: 5, url: "https://search.test/", title: "", hidden: true }, { id: 6, url: "https://agent-6.test/", title: "", hidden: true }];
    const { api, tags, factory } = fakeTabsApi(tabs, new Map([[5, tag(1, "search")], [6, tag(1)]]));
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    scripted(provider, programRound('return fs.remove("/agent-tabs/6/page.md");'));
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: factory, clock });
    hub.delegate = runtime;
    await runtime.initialize();

    // Releasing tab 6 resyncs ownership; a lost search role would rewrite tab 5's tag.
    await runtime.handleCommand({ v: 1, id: "run", type: "run.start", prompt: "Close tab 6" });
    await vi.waitFor(() => expect([...tags]).toEqual([[5, tag(1, "search")]]));
    expect(api.sessions.setTabValue).not.toHaveBeenCalled();
  });

  it("releases and untags a tagged tab Firefox restored as visible, without hiding it", async () => {
    const tabs = [userTab, { id: 5, url: "https://agent-5.test/", title: "", hidden: false }];
    const { api, tags, factory } = fakeTabsApi(tabs, new Map([[5, tag(1)]]));
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), tabControllerFactory: factory });
    await runtime.initialize();

    expect((await runtime.getSnapshot()).agentTabs).toBe(0);
    expect(await tabPaths(runtime)).toEqual({ 1: "/tabs/1/page.md", 5: "/tabs/5/page.md" });
    expect(tags.size).toBe(0);
    expect(api.tabs.hide).not.toHaveBeenCalled();
    expect(tabs.map((tab) => tab.id)).toEqual([1, 5]);
  });

  it("adopts a tagged hidden tab that session restore creates after startup, and only that one", async () => {
    const tabs: FakeTab[] = [userTab];
    const { tags, factory } = fakeTabsApi(tabs);
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider: new FakeProvider(), tabControllerFactory: factory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);
    await runtime.initialize();

    tabs.push(
      { id: 20, url: "https://agent-20.test/", title: "", hidden: true },
      { id: 21, url: "https://agent-21.test/", title: "", hidden: true },
      { id: 22, url: "https://agent-22.test/", title: "", hidden: false },
    );
    tags.set(20, tag(1)).set(22, tag(1));
    await Promise.all([20, 21, 22].map((id) => runtime.handleTabCreated(id)));

    await vi.waitFor(async () => expect((await runtime.getSnapshot()).agentTabs).toBe(1));
    expect(await tabPaths(runtime)).toMatchObject({ 20: "/agent-tabs/20/page.md", 21: "/tabs/21/page.md", 22: "/tabs/22/page.md" });
    expect([...tags.keys()]).toEqual([20]);
    expect(port.received.flatMap((event) => event.type === "agent-tabs.changed" ? [event.payload.count] : [])).toEqual([1]);
  });

  it("keeps a tab it is opening when tabs.onCreated reports it before it is hidden", async () => {
    const tabs = [userTab];
    const { api, tags, factory } = fakeTabsApi(tabs);
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    scripted(provider, programRound('const page = await browser.open("https://example.test/"); return page.path();'));
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: factory });
    hub.delegate = runtime;
    await runtime.initialize();
    const create = api.tabs.create.getMockImplementation()!;
    const created: Promise<void>[] = [];
    api.tabs.create.mockImplementation(async (properties) => {
      const tab = await create(properties);
      created.push(runtime.handleTabCreated(tab.id));
      return tab;
    });

    await runtime.handleCommand({ v: 1, id: "open", type: "run.start", prompt: "Open example" });
    await Promise.all(created);
    await vi.waitFor(() => expect([...tags.keys()]).toEqual([100]));
    expect(await tabPaths(runtime)).toMatchObject({ 100: "/agent-tabs/100/page.md" });
    expect(tabs.find((tab) => tab.id === 100)?.hidden).toBe(true);
  });

  it("holds sidebar commands until startup restoration finishes", async () => {
    const { api, factory } = fakeTabsApi([userTab, { id: 5, url: "https://kept.test/", title: "Kept", hidden: true }], new Map([[5, tag(100)]]));
    const gate = Promise.withResolvers<void>();
    const getTabValue = api.sessions.getTabValue.getMockImplementation()!;
    api.sessions.getTabValue.mockImplementation(async (tabId, key) => { await gate.promise; return getTabValue(tabId, key); });
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), tabControllerFactory: factory });

    const startup = runtime.initialize();
    let paths: Record<number, string> | undefined;
    const listed = tabPaths(runtime).then((result) => { paths = result; });
    await tick();
    expect(paths).toBeUndefined();
    gate.resolve();
    await Promise.all([startup, listed]);
    expect(paths?.[5]).toBe("/agent-tabs/5/page.md");
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
  /** Session tags of agent tabs restored at startup, each idle for the given time; the first is the search tab. */
  const owned = (now: number, ...entries: [number, number][]) =>
    new Map<number, unknown>(entries.map(([id, idleMs], index) => [id, tag(now - idleMs, index === 0 ? "search" : "agent")]));

  it("closes every agent tab, including the search tab, on request and leaves user tabs alone", async () => {
    const { clock } = manualClock();
    const tabs = [userTab, agentTab(5), agentTab(6)];
    const { tags, factory } = fakeTabsApi(tabs, owned(clock.now(), [5, 0], [6, 0]));
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider: new FakeProvider(), tabControllerFactory: factory, clock });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);
    await runtime.initialize();
    expect((await runtime.getSnapshot()).agentTabs).toBe(2);

    await port.send({ v: 1, id: "close", type: "tabs.closeAgentTabs" });
    expect(tabs.map((tab) => tab.id)).toEqual([1]);
    expect(tags.size).toBe(0);
    expect((await runtime.getSnapshot()).agentTabs).toBe(0);
    const counts = port.received.flatMap((event) => event.type === "agent-tabs.changed" ? [event.payload.count] : []);
    expect([counts[0], counts.at(-1)]).toEqual([2, 0]);
  });

  it("refuses to close agent tabs while a run is active", async () => {
    const { clock } = manualClock();
    const tabs = [userTab, agentTab(5)];
    const { factory } = fakeTabsApi(tabs, owned(clock.now(), [5, 0]));
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

  it("auto-closes restored agent tabs once their tagged last use is older than the idle period", async () => {
    const { clock, advance, sweep } = manualClock();
    const tabs = [userTab, agentTab(5), agentTab(6)];
    const { tags, factory } = fakeTabsApi(tabs, owned(clock.now(), [5, AGENT_TAB_IDLE_MS + minute], [6, 5 * minute]));
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), tabControllerFactory: factory, clock });
    await runtime.initialize();

    await sweep();
    expect(tabs.map((tab) => tab.id)).toEqual([1, 6]);
    expect([...tags]).toEqual([[6, tag(clock.now() - 5 * minute)]]);

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
    const { tags, factory } = fakeTabsApi(tabs, owned(clock.now(), [5, minute]));
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
    // The restarted idle period is written to the tag, so it survives a restart too.
    expect([...tags]).toEqual([[100, tag(clock.now())]]);
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
    const tabs = [userTab, { id: 5, url: "https://agent-5.test/", title: "", hidden: true }];
    const { api, tags, factory } = fakeTabsApi(tabs, new Map([[5, tag(1)]]));
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
    await vi.waitFor(() => expect([...tags.keys()]).toEqual([100]));
    expect((await runtime.getSnapshot()).agentTabs).toBe(1);
  });

  it("retries an untag that failed on the next ownership change", async () => {
    const tabs = [userTab, { id: 5, url: "https://agent-5.test/", title: "", hidden: true }, { id: 6, url: "https://agent-6.test/", title: "", hidden: true }];
    const { api, tags, factory } = fakeTabsApi(tabs, new Map([[5, tag(1)], [6, tag(1)]]));
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    scripted(provider, programRound('return fs.move("/agent-tabs/5/page.md", "/tabs/5/page.md");'));
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: factory });
    hub.delegate = runtime;
    await runtime.initialize();
    api.sessions.removeTabValue.mockRejectedValueOnce(new Error("Session store busy."));

    await runtime.handleCommand({ v: 1, id: "move", type: "run.start", prompt: "Show tab 5" });
    await tick();
    expect([...tags.keys()]).toEqual([5, 6]);
    scripted(provider, programRound('return fs.remove("/agent-tabs/6/page.md");'));
    await runtime.handleCommand({ v: 1, id: "close", type: "run.start", prompt: "Close tab 6" });
    await vi.waitFor(() => expect(tags.size).toBe(0));
    expect(tabs.map((tab) => [tab.id, tab.hidden])).toEqual([[1, false], [5, false]]);
  });
});
