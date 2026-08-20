import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "wxt/browser";
import { AgentLoop } from "@/lib/background/agent-loop";
import { SidebarHub } from "@/lib/background/sidebar-hub";
import { TabController } from "@/lib/background/tab-controller";
import type { TabControllerBrowserApi } from "@/lib/background/tab-controller";
import type { ProviderAdapter, ProviderAuth, ProviderEvent, ProviderTurnRequest } from "@/lib/domain/provider";
import type { PageSnapshotV1, ToolCall } from "@/lib/domain/tools";
import type { ApprovalRequest, SidebarEvent } from "@/lib/protocol";

function buildSnapshot(overrides: Partial<PageSnapshotV1> = {}): PageSnapshotV1 {
  return {
    version: 1,
    tabId: 1,
    revision: "rev-1",
    url: "http://127.0.0.1:4173/agent-page.html",
    origin: "http://127.0.0.1:4173",
    title: "Agent Fixture",
    readableText: "Orchid launch moved to Friday.",
    selectionText: "",
    viewport: { width: 0, height: 0, scrollX: 0, scrollY: 0 },
    nodes: [{ ref: "e1", role: "button", name: "Submit", tag: "button", state: { disabled: false }, bounds: { x: 0, y: 0, width: 0, height: 0 }, inViewport: true }],
    truncated: { readableText: false, nodes: false },
    warnings: [],
    ...overrides,
  };
}

/** A TabController bound to a scriptable fake browser tabs API. */
async function createTabController(handlers: {
  onExecute?: (call: unknown) => { result: unknown; snapshot: PageSnapshotV1 };
} = {}): Promise<{ tabController: TabController; sendMessageMock: ReturnType<typeof vi.fn> }> {
  const snapshot = buildSnapshot();
  const sendMessageMock = vi.fn(async (_tabId: number, message: unknown) => {
    const request = message as { id: string; type: string; call?: { name: string; arguments: unknown } };
    if (request.type === "page.snapshot") {
      return { v: 1, id: request.id, ok: true, type: "page.snapshot", snapshot };
    }
    if (request.type === "page.execute") {
      const outcome = handlers.onExecute?.(request.call) ?? { result: { ok: true, summary: "Done." }, snapshot };
      return { v: 1, id: request.id, ok: true, type: "page.execute", result: outcome.result, snapshot: outcome.snapshot };
    }
    throw new Error(`unhandled request type: ${request.type}`);
  });

  const api: TabControllerBrowserApi = {
    tabs: {
      query: vi.fn(async () => [{ id: 1, url: snapshot.url, title: snapshot.title }]),
      update: vi.fn(async () => {}),
      goBack: vi.fn(async () => {}),
      sendMessage: sendMessageMock,
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  const tabController = new TabController(api);
  // Mirrors the real flow: BackgroundRuntime always binds the tab before AgentLoop runs.
  await tabController.captureActivePage();
  return { tabController, sendMessageMock };
}

class ScriptedProvider implements ProviderAdapter {
  readonly definition = { id: "openai" as const, name: "OpenAI", authMethods: [], models: [] };
  #rounds: Array<(request: ProviderTurnRequest) => ProviderEvent[]>;
  #callIndex = 0;
  requests: ProviderTurnRequest[] = [];

  constructor(rounds: Array<(request: ProviderTurnRequest) => ProviderEvent[]>) {
    this.#rounds = rounds;
  }

  async validateAuth(): Promise<void> {}

  async *streamTurn(request: ProviderTurnRequest, _auth: ProviderAuth, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this.requests.push(request);
    const round = this.#rounds[this.#callIndex] ?? (() => [{ type: "turn.completed", replayState: null } as ProviderEvent]);
    this.#callIndex += 1;
    for (const event of round(request)) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      yield event;
    }
  }
}

function toolCallEvent(id: string, name: ToolCall["name"], args: Record<string, unknown>): ProviderEvent {
  return { type: "tool.call", call: { id, name, arguments: args as never } };
}

const AUTH: ProviderAuth = { providerId: "openai", method: "api-key", secret: "sk-test" };

type FakePort = Browser.runtime.Port & { received: SidebarEvent[] };

function fakePort(): FakePort {
  const received: SidebarEvent[] = [];
  return {
    name: "agent-sidebar:v1",
    postMessage: (message: unknown) => received.push(message as SidebarEvent),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    onDisconnect: { addListener: vi.fn() },
    disconnect: vi.fn(),
    received,
  } as unknown as FakePort;
}

async function tick(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const baseTranscript = [{ id: "u1", kind: "message" as const, role: "user" as const, text: "Do it", context: null, at: 1 }];
const artifact = {
  artifactId: "a1",
  kind: "page" as const,
  title: "Agent Fixture",
  url: "http://127.0.0.1:4173/agent-page.html",
  capturedAt: 1,
  target: { kind: "tab" as const, tabId: 1 },
  snapshot: buildSnapshot(),
};

beforeEach(() => {
  fakeBrowser.reset();
});

describe("AgentLoop: read-only tool call", () => {
  it("auto-runs page_snapshot without approval", async () => {
    const provider = new ScriptedProvider([
      () => [toolCallEvent("call_1", "page_snapshot", { mode: "readable" }), { type: "turn.completed", replayState: null }],
      () => [{ type: "text.delta", delta: "Done." }, { type: "turn.completed", replayState: null }],
    ]);
    const { tabController } = await createTabController();
    const hub = new SidebarHub();
    const port = fakePort();
    hub.handleConnect(port);
    const loop = new AgentLoop(provider, tabController, hub);
    const items: unknown[] = [];

    const result = await loop.run({
      runId: "run1",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      transcript: baseTranscript,
      contextArtifact: artifact,
      auth: AUTH,
      signal: new AbortController().signal,
      onDelta: () => {},
      onItem: async (item) => {
        items.push(item);
      },
      onApprovalPending: () => {},
    });

    expect(result.status).toBe("completed");
    expect(port.received.some((e) => e.type === "action.approval-required")).toBe(false);
    expect(port.received.some((e) => e.type === "tool.requested")).toBe(true);
    const toolResult = port.received.find((e) => e.type === "tool.result");
    expect(toolResult && toolResult.type === "tool.result" ? toolResult.payload.result.ok : undefined).toBe(true);
  });
});

describe("AgentLoop: approval pause/resume", () => {
  it("pauses for a consequential call and resumes on approve, executing it", async () => {
    const provider = new ScriptedProvider([
      () => [toolCallEvent("call_1", "page_click", { ref: "e1", revision: "rev-1" }), { type: "turn.completed", replayState: null }],
      () => [{ type: "text.delta", delta: "Clicked." }, { type: "turn.completed", replayState: null }],
    ]);
    const { tabController, sendMessageMock } = await createTabController();
    const hub = new SidebarHub();
    const port = fakePort();
    hub.handleConnect(port);
    const loop = new AgentLoop(provider, tabController, hub);

    const resultPromise = loop.run({
      runId: "run1",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      transcript: baseTranscript,
      contextArtifact: artifact,
      auth: AUTH,
      signal: new AbortController().signal,
      onDelta: () => {},
      onItem: async () => {},
      onApprovalPending: () => {},
    });

    await tick();
    const approvalEvent = port.received.find((e) => e.type === "action.approval-required");
    expect(approvalEvent).toBeDefined();
    if (approvalEvent?.type === "action.approval-required") {
      expect(approvalEvent.payload.display).toBe('page.click("Submit")');
    }

    const executeCallsBeforeApproval = sendMessageMock.mock.calls.filter((call) => (call[1] as { type?: string }).type === "page.execute").length;
    expect(executeCallsBeforeApproval).toBe(0);

    loop.approve("call_1");
    const result = await resultPromise;

    expect(result.status).toBe("completed");
    const executeCallsAfterApproval = sendMessageMock.mock.calls.filter((call) => (call[1] as { type?: string }).type === "page.execute").length;
    expect(executeCallsAfterApproval).toBe(1);
  });
});

describe("AgentLoop: denial as a tool result", () => {
  it("feeds ACTION_DENIED back to the model without executing the action", async () => {
    const provider = new ScriptedProvider([
      () => [toolCallEvent("call_1", "page_click", { ref: "e1", revision: "rev-1" }), { type: "turn.completed", replayState: null }],
      () => [{ type: "text.delta", delta: "Understood." }, { type: "turn.completed", replayState: null }],
    ]);
    const { tabController, sendMessageMock } = await createTabController();
    const hub = new SidebarHub();
    const port = fakePort();
    hub.handleConnect(port);
    const loop = new AgentLoop(provider, tabController, hub);

    const resultPromise = loop.run({
      runId: "run1",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      transcript: baseTranscript,
      contextArtifact: artifact,
      auth: AUTH,
      signal: new AbortController().signal,
      onDelta: () => {},
      onItem: async () => {},
      onApprovalPending: () => {},
    });

    await tick();
    loop.deny("call_1");
    const result = await resultPromise;

    expect(result.status).toBe("completed");
    const executeCalls = sendMessageMock.mock.calls.filter((call) => (call[1] as { type?: string }).type === "page.execute").length;
    expect(executeCalls).toBe(0);

    const round2Request = provider.requests[1];
    const toolResultInput = round2Request?.transcript.find((item) => item.kind === "tool-result");
    expect(toolResultInput && toolResultInput.kind === "tool-result" ? toolResultInput.result.code : undefined).toBe("ACTION_DENIED");
  });
});

describe("AgentLoop: exactly-once execution", () => {
  it("returns the recorded result for a repeated call.id without executing twice", async () => {
    const provider = new ScriptedProvider([
      () => [
        toolCallEvent("call_1", "page_snapshot", { mode: "readable" }),
        toolCallEvent("call_1", "page_snapshot", { mode: "readable" }),
        { type: "turn.completed", replayState: null },
      ],
      () => [{ type: "text.delta", delta: "Done." }, { type: "turn.completed", replayState: null }],
    ]);
    const { tabController, sendMessageMock } = await createTabController();
    sendMessageMock.mockClear();
    const hub = new SidebarHub();
    const port = fakePort();
    hub.handleConnect(port);
    const loop = new AgentLoop(provider, tabController, hub);

    const result = await loop.run({
      runId: "run1",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      transcript: baseTranscript,
      contextArtifact: artifact,
      auth: AUTH,
      signal: new AbortController().signal,
      onDelta: () => {},
      onItem: async () => {},
      onApprovalPending: () => {},
    });

    expect(result.status).toBe("completed");
    const snapshotCalls = sendMessageMock.mock.calls.filter((call) => (call[1] as { type?: string }).type === "page.snapshot").length;
    // One snapshot call from captureActivePage-equivalent execution of the tool, not two.
    expect(snapshotCalls).toBe(1);
  });
});

describe("AgentLoop: stale-ref recovery", () => {
  it("feeds STALE_SNAPSHOT back to the model as a non-terminal result", async () => {
    const provider = new ScriptedProvider([
      () => [toolCallEvent("call_1", "page_click", { ref: "e1", revision: "stale-revision" }), { type: "turn.completed", replayState: null }],
      () => [{ type: "text.delta", delta: "Let me get a fresh snapshot." }, { type: "turn.completed", replayState: null }],
    ]);
    const { tabController } = await createTabController({
      onExecute: () => ({ result: { ok: false, code: "STALE_SNAPSHOT", summary: "Stale." }, snapshot: buildSnapshot({ revision: "rev-2" }) }),
    });
    const hub = new SidebarHub();
    const port = fakePort();
    hub.handleConnect(port);
    const loop = new AgentLoop(provider, tabController, hub);

    const resultPromise = loop.run({
      runId: "run1",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      transcript: baseTranscript,
      contextArtifact: artifact,
      auth: AUTH,
      signal: new AbortController().signal,
      onDelta: () => {},
      onItem: async () => {},
      onApprovalPending: () => {},
    });

    await tick();
    loop.approve("call_1");
    const result = await resultPromise;

    expect(result.status).toBe("completed");
    const round2Request = provider.requests[1];
    const toolResultInput = round2Request?.transcript.find((item) => item.kind === "tool-result");
    expect(toolResultInput && toolResultInput.kind === "tool-result" ? toolResultInput.result.code : undefined).toBe("STALE_SNAPSHOT");
  });
});

describe("AgentLoop: cancellation while awaiting approval", () => {
  it("resolves the pending gate without executing the action and terminates as cancelled", async () => {
    const provider = new ScriptedProvider([
      () => [toolCallEvent("call_1", "page_click", { ref: "e1", revision: "rev-1" }), { type: "turn.completed", replayState: null }],
    ]);
    const { tabController, sendMessageMock } = await createTabController();
    const hub = new SidebarHub();
    const port = fakePort();
    hub.handleConnect(port);
    const loop = new AgentLoop(provider, tabController, hub);
    const controller = new AbortController();
    const approvalStates: (ApprovalRequest | null)[] = [];

    const resultPromise = loop.run({
      runId: "run1",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      transcript: baseTranscript,
      contextArtifact: artifact,
      auth: AUTH,
      signal: controller.signal,
      onDelta: () => {},
      onItem: async () => {},
      onApprovalPending: (request) => approvalStates.push(request),
    });

    await tick();
    expect(approvalStates.at(-1)).not.toBeNull();

    controller.abort();
    const result = await resultPromise;

    expect(result.status).toBe("cancelled");
    expect(approvalStates.at(-1)).toBeNull();
    const executeCalls = sendMessageMock.mock.calls.filter((call) => (call[1] as { type?: string }).type === "page.execute").length;
    expect(executeCalls).toBe(0);
  });
});
