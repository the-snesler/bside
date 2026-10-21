import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "wxt/browser";
import { AgentLoop, DIGEST_REPLAY_CHARS } from "@/lib/background/agent-loop";
import { buildRunDigest, renderDigestNote } from "@/lib/domain/run-digest";
import type { ConversationItem, QueuedMessage } from "@/lib/domain/conversation";
import { SidebarHub } from "@/lib/background/sidebar-hub";
import { TabController } from "@/lib/background/tab-controller";
import type { TabControllerBrowserApi } from "@/lib/background/tab-controller";
import { ProviderStreamError } from "@/lib/providers/openai";
import type { ProviderAdapter, ProviderAuth, ProviderTurnRequest } from "@/lib/domain/provider";
import type { PageSnapshot, ToolCall } from "@/lib/domain/tools";
import type { ApprovalRequest, SidebarEvent } from "@/lib/protocol";
import { TEST_MODEL, toPiStream, type ScriptedProviderEvent } from "@/tests/helpers/pi-provider";

function buildSnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  const text = 'Orchid launch moved to Friday.\n[e1 button "Submit"]';
  return {
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
    ...overrides,
  };
}

/** A TabController bound to a scriptable fake browser tabs API. */
async function createTabController(handlers: {
  onExecute?: (action: unknown) => { result: unknown; documentId: string };
} = {}): Promise<{ tabController: TabController; sendMessageMock: ReturnType<typeof vi.fn> }> {
  const snapshot = buildSnapshot();
  const sendMessageMock = vi.fn(async (_tabId: number, message: unknown) => {
    const request = message as { id: string; type: string; action?: unknown };
    if (request.type === "page.snapshot") {
      return { v: 1, id: request.id, ok: true, type: "page.snapshot", snapshot };
    }
    if (request.type === "page.execute") {
      const outcome = handlers.onExecute?.(request.action) ?? { result: { ok: true, summary: "Done." }, documentId: snapshot.documentId };
      return { v: 1, id: request.id, ok: true, type: "page.execute", result: outcome.result, documentId: outcome.documentId };
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
  #rounds: Array<(request: ProviderTurnRequest) => Iterable<ScriptedProviderEvent> | AsyncIterable<ScriptedProviderEvent>>;
  #callIndex = 0;
  requests: ProviderTurnRequest[] = [];

  constructor(rounds: Array<(request: ProviderTurnRequest) => Iterable<ScriptedProviderEvent> | AsyncIterable<ScriptedProviderEvent>>) {
    this.#rounds = rounds;
  }

  async validateAuth(): Promise<void> {}

  getModel() { return TEST_MODEL; }

  streamTurn(request: ProviderTurnRequest, _auth: ProviderAuth, signal: AbortSignal) {
    this.requests.push(request);
    const round = this.#rounds[this.#callIndex] ?? (() => [{ type: "turn.completed", replayState: null } as ScriptedProviderEvent]);
    this.#callIndex += 1;
    try {
      return toPiStream(round(request), signal);
    } catch (error) {
      return toPiStream({ [Symbol.asyncIterator]: async function* () { throw error; } }, signal);
    }
  }
}

function toolCallEvent(id: string, name: ToolCall["name"], args: Record<string, unknown>): ScriptedProviderEvent {
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
  await new Promise((resolve) => setTimeout(resolve, 0));
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
      () => [toolCallEvent("call_1", "browser_program", { source: 'return await fs.read("/tabs/1/page.md");' }), { type: "turn.completed", replayState: null }],
      () => [{ type: "text.delta", delta: "Done." }, { type: "turn.completed", replayState: null }],
    ]);
    const { tabController } = await createTabController();
    const hub = new SidebarHub();
    const port = fakePort();
    hub.handleConnect(port);
    const loop = new AgentLoop(provider, tabController, hub);
    const items: unknown[] = [];

    const result = await loop.run({
      runId: "run1", conversationId: "default",
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
    expect(JSON.stringify(items)).not.toContain("Orchid launch moved to Friday.");
    expect(provider.requests[1]?.context.messages.some((m) => m.role === "toolResult" && JSON.stringify(m.content).includes("Orchid launch moved to Friday."))).toBe(true);
    expect(port.received.some((e) => e.type === "tool.requested")).toBe(true);
    const toolResult = port.received.find((e) => e.type === "tool.result");
    expect(toolResult && toolResult.type === "tool.result" ? toolResult.payload.result.ok : undefined).toBe(true);
  });
});

describe("AgentLoop: initial page artifact", () => {
  it("shows the attached page outline and lets the model act on its refs immediately", async () => {
    const provider = new ScriptedProvider([
      () => [toolCallEvent("call_1", "browser_program", { source: 'await browser.tab("/tabs/1/page.md").ref("e1").click();' }), { type: "turn.completed", replayState: null }],
      () => [{ type: "text.delta", delta: "Done." }, { type: "turn.completed", replayState: null }],
    ]);
    const actions: unknown[] = [];
    const { tabController } = await createTabController({ onExecute: (action) => { actions.push(action); return { result: { ok: true, summary: "Clicked." }, documentId: "doc-1" }; } });
    const loop = new AgentLoop(provider, tabController, new SidebarHub());

    const result = await loop.run({
      runId: "run1", conversationId: "default", modelId: "gpt-5.6-terra", reasoningEffort: "medium", transcript: baseTranscript, contextArtifact: artifact,
      auth: AUTH, signal: new AbortController().signal, onDelta: () => {}, onItem: async () => {}, onApprovalPending: () => {},
    });

    expect(result.status).toBe("completed");
    const userTurn = JSON.stringify(provider.requests[0]?.context.messages.at(-1));
    expect(userTurn).toContain("Do it");
    expect(userTurn).toContain(JSON.stringify('Orchid launch moved to Friday.\n[e1 button "Submit"]').slice(1, -1));
    expect(userTurn).toContain("Document: doc-1");
    expect(actions).toEqual([{ kind: "click", target: { kind: "ref", ref: "e1", documentId: "doc-1" } }]);
  });

  it("keeps the system prompt and tools byte-identical with or without a page, across rounds", async () => {
    const run = async (contextArtifact: typeof artifact | null) => {
      const provider = new ScriptedProvider([
        () => [toolCallEvent("call_1", "browser_program", { source: "return 1;" }), { type: "turn.completed", replayState: null }],
        () => [{ type: "text.delta", delta: "Done." }, { type: "turn.completed", replayState: null }],
      ]);
      const { tabController } = await createTabController();
      const transcript = [
        { id: "u0", kind: "message" as const, role: "user" as const, text: "Earlier", context: null, at: 0 },
        { id: "a0", kind: "message" as const, role: "assistant" as const, text: "Earlier reply", at: 0 },
        ...baseTranscript,
      ];
      await new AgentLoop(provider, tabController, new SidebarHub()).run({
        runId: "run1", conversationId: "default", modelId: "gpt-5.6-terra", reasoningEffort: "medium", transcript, contextArtifact,
        auth: AUTH, signal: new AbortController().signal, onDelta: () => {}, onItem: async () => {}, onApprovalPending: () => {},
      });
      return provider.requests;
    };
    const withPage = await run(artifact);
    const withoutPage = await run(null);

    const prefixes = [...withPage, ...withoutPage].map((request) => JSON.stringify({ systemPrompt: request.context.systemPrompt, tools: request.context.tools }));
    expect(new Set(prefixes).size).toBe(1);
    expect(withPage[0]?.context.systemPrompt).toContain("Verify outcomes before claiming them");
    expect(withPage[0]?.context.systemPrompt).not.toContain("Orchid launch");
    expect([...withPage, ...withoutPage].every((request) => request.sessionId === "default")).toBe(true);
    // Only the current user turn carries the outline; earlier history stays plain text.
    expect(withPage[0]?.context.messages[0]).toMatchObject({ role: "user", content: "Earlier" });
    expect(JSON.stringify(withPage[1]?.context.messages[2])).toContain("Orchid launch moved to Friday.");
    expect(withoutPage[0]?.context.messages[2]).toMatchObject({ role: "user", content: "Do it" });
  });
});

describe("AgentLoop: approval pause/resume", () => {
  it("pauses only for explicit confirmation and returns approval without a page effect", async () => {
    const provider = new ScriptedProvider([
      () => [toolCallEvent("call_1", "request_action_confirmation", { title: "Submit", message: "Submit this draft?", artifact: "Draft text" }), { type: "turn.completed", replayState: null }],
      () => [{ type: "text.delta", delta: "Clicked." }, { type: "turn.completed", replayState: null }],
    ]);
    const { tabController, sendMessageMock } = await createTabController();
    const hub = new SidebarHub();
    const port = fakePort();
    hub.handleConnect(port);
    const loop = new AgentLoop(provider, tabController, hub);

    const resultPromise = loop.run({
      runId: "run1", conversationId: "default",
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
      expect(approvalEvent.payload.display).toBe('Submit');
      expect(approvalEvent.payload.call.arguments).toMatchObject({ artifact: 'Draft text' });
    }

    const executeCallsBeforeApproval = sendMessageMock.mock.calls.filter((call) => (call[1] as { type?: string }).type === "page.execute").length;
    expect(executeCallsBeforeApproval).toBe(0);

    loop.approve("call_1");
    const result = await resultPromise;

    expect(result.status).toBe("completed");
    const executeCallsAfterApproval = sendMessageMock.mock.calls.filter((call) => (call[1] as { type?: string }).type === "page.execute").length;
    expect(executeCallsAfterApproval).toBe(0);
    expect(provider.requests[1]?.context.messages.some((m) => m.role === "toolResult" && JSON.stringify(m.content).includes("approved:true"))).toBe(true);
  });
});

describe("AgentLoop: denial as a tool result", () => {
  it("feeds ACTION_DENIED back to the model without executing the action", async () => {
    const provider = new ScriptedProvider([
      () => [toolCallEvent("call_1", "request_action_confirmation", { title: "Submit", message: "Submit this draft?", artifact: "Draft text" }), { type: "turn.completed", replayState: null }],
      () => [{ type: "text.delta", delta: "Understood." }, { type: "turn.completed", replayState: null }],
    ]);
    const { tabController, sendMessageMock } = await createTabController();
    const hub = new SidebarHub();
    const port = fakePort();
    hub.handleConnect(port);
    const loop = new AgentLoop(provider, tabController, hub);

    const resultPromise = loop.run({
      runId: "run1", conversationId: "default",
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
    const toolResultInput = round2Request?.context.messages.find((item) => item.role === "toolResult");
    expect(toolResultInput?.role === "toolResult" ? toolResultInput.content[0] : undefined).toMatchObject({ text: expect.stringContaining("ACTION_DENIED") });
  });
});

describe("AgentLoop: exactly-once execution", () => {
  it("returns the recorded result for a repeated call.id without executing twice", async () => {
    const provider = new ScriptedProvider([
      () => [
        toolCallEvent("call_1", "browser_program", { source: 'return await fs.read("/tabs/1/page.md");' }),
        toolCallEvent("call_1", "browser_program", { source: 'return await fs.read("/tabs/1/page.md");' }),
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
      runId: "run1", conversationId: "default",
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
      () => [toolCallEvent("call_1", "browser_program", { source: 'await browser.tab("/tabs/1/page.md").getByRole("button", {name: "Submit", exact: true}).click();' }), { type: "turn.completed", replayState: null }],
      () => [{ type: "text.delta", delta: "Let me get a fresh snapshot." }, { type: "turn.completed", replayState: null }],
    ]);
    const { tabController } = await createTabController({
      onExecute: () => ({ result: { ok: false, code: "STALE_SNAPSHOT", summary: "Stale." }, documentId: "doc-2" }),
    });
    const hub = new SidebarHub();
    const port = fakePort();
    hub.handleConnect(port);
    const loop = new AgentLoop(provider, tabController, hub);
    const savedItems: unknown[] = [];

    const resultPromise = loop.run({
      runId: "run1", conversationId: "default",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      transcript: baseTranscript,
      contextArtifact: artifact,
      auth: AUTH,
      signal: new AbortController().signal,
      onDelta: () => {},
      onItem: async (item) => { savedItems.push(item); },
      onApprovalPending: () => {},
    });

    await tick();
    loop.approve("call_1");
    const result = await resultPromise;

    expect(result.status).toBe("completed");
    expect(JSON.stringify(savedItems)).toContain("Stopped in statement 1");
    expect(JSON.stringify(savedItems)).toContain("Stale.");
    expect(JSON.stringify(savedItems)).not.toContain("Orchid launch moved");
    const round2Request = provider.requests[1];
    const toolResultInput = round2Request?.context.messages.find((item) => item.role === "toolResult");
    expect(toolResultInput?.role === "toolResult" ? toolResultInput.content[0] : undefined).toMatchObject({ text: expect.stringContaining("STALE_SNAPSHOT") });
  });
});

describe("AgentLoop: cancellation while awaiting approval", () => {
  it("resolves the pending gate without executing the action and terminates as cancelled", async () => {
    const provider = new ScriptedProvider([
      () => [toolCallEvent("call_1", "request_action_confirmation", { title: "Submit", message: "Submit this draft?", artifact: "Draft text" }), { type: "turn.completed", replayState: null }],
    ]);
    const { tabController, sendMessageMock } = await createTabController();
    const hub = new SidebarHub();
    const port = fakePort();
    hub.handleConnect(port);
    const loop = new AgentLoop(provider, tabController, hub);
    const controller = new AbortController();
    const approvalStates: (ApprovalRequest | null)[] = [];

    const resultPromise = loop.run({
      runId: "run1", conversationId: "default",
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

describe("AgentLoop: page-effect tracking for retry gating", () => {
  it("marks hadPageEffect true when a consequential call succeeded before the run failed", async () => {
    const provider = new ScriptedProvider([
      () => [toolCallEvent("call_1", "browser_program", { source: 'await browser.tab("/tabs/1/page.md").getByRole("button", {name: "Submit", exact: true}).click();' }), { type: "turn.completed", replayState: null }],
      () => {
        throw new ProviderStreamError("Rate limited.", "RATE_LIMIT");
      },
    ]);
    const { tabController } = await createTabController();
    const hub = new SidebarHub();
    const port = fakePort();
    hub.handleConnect(port);
    const loop = new AgentLoop(provider, tabController, hub);

    const resultPromise = loop.run({
      runId: "run1", conversationId: "default",
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

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("RATE_LIMIT");
      expect(result.error.retryable).toBe(true);
      // The provider error is retryable by type, but the extension must
      // never claim retry-safety once a real page effect has committed.
      expect(result.hadPageEffect).toBe(true);
    }
  });

  it("marks hadPageEffect false when only a read-only call ran before the run failed", async () => {
    const provider = new ScriptedProvider([
      () => [toolCallEvent("call_1", "browser_program", { source: 'return await fs.read("/tabs/1/page.md");' }), { type: "turn.completed", replayState: null }],
      () => {
        throw new ProviderStreamError("Rate limited.", "RATE_LIMIT");
      },
    ]);
    const { tabController } = await createTabController();
    const hub = new SidebarHub();
    const port = fakePort();
    hub.handleConnect(port);
    const loop = new AgentLoop(provider, tabController, hub);

    const result = await loop.run({
      runId: "run1", conversationId: "default",
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

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.hadPageEffect).toBe(false);
  });

  it("marks hadPageEffect false when a consequential call was denied, not executed", async () => {
    const provider = new ScriptedProvider([
      () => [toolCallEvent("call_1", "request_action_confirmation", { title: "Submit", message: "Submit this draft?", artifact: "Draft text" }), { type: "turn.completed", replayState: null }],
      () => {
        throw new ProviderStreamError("Rate limited.", "RATE_LIMIT");
      },
    ]);
    const { tabController } = await createTabController();
    const hub = new SidebarHub();
    const port = fakePort();
    hub.handleConnect(port);
    const loop = new AgentLoop(provider, tabController, hub);

    const resultPromise = loop.run({
      runId: "run1", conversationId: "default",
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

    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.hadPageEffect).toBe(false);
  });
});

describe("AgentLoop: run budgets", () => {
  /** Never finishes on its own: every round returns another tool call. */
  class EndlessProvider extends ScriptedProvider {
    constructor(onRound: (round: number) => { name: ToolCall["name"]; args: Record<string, unknown> }, outputPerRound = 0) {
      let round = 0;
      const next = () => {
        round += 1;
        const { name, args } = onRound(round);
        return [toolCallEvent(`call_${round}`, name, args), { type: "turn.completed", replayState: null, usage: { output: outputPerRound } } as ScriptedProviderEvent];
      };
      super(Array.from({ length: 1000 }, () => next));
    }
  }

  const click = { name: "browser_program" as const, args: { source: 'await browser.tab("/tabs/1/page.md").ref("e1").click();' } };
  const read = { name: "browser_program" as const, args: { source: "return 1;" } };

  async function runWith(provider: ScriptedProvider, limits: ConstructorParameters<typeof AgentLoop>[4], onApprovalPending: (request: ApprovalRequest | null, loop: AgentLoop) => void = () => {}) {
    const { tabController, sendMessageMock } = await createTabController();
    const loop = new AgentLoop(provider, tabController, new SidebarHub(), undefined, limits);
    const result = await loop.run({
      runId: "run1", conversationId: "default", modelId: "gpt-5.6-terra", reasoningEffort: "medium", transcript: baseTranscript, contextArtifact: artifact,
      auth: AUTH, signal: new AbortController().signal, onDelta: () => {}, onItem: async () => {}, onApprovalPending: (request) => onApprovalPending(request, loop),
    });
    const executed = sendMessageMock.mock.calls.filter((call) => (call[1] as { type?: string }).type === "page.execute").length;
    return { result, executed };
  }

  it("stops after the step cap as a non-retryable LIMIT_EXCEEDED failure, keeping committed effects", async () => {
    const provider = new EndlessProvider(() => click);
    const { result, executed } = await runWith(provider, { maxRounds: 3 });

    expect(result).toEqual({
      status: "failed",
      error: { code: "LIMIT_EXCEEDED", message: "Stopped after 3 steps; ask me to continue.", retryable: false, phase: "provider" },
      hadPageEffect: true,
    });
    expect(provider.requests).toHaveLength(3);
    expect(executed).toBe(3);
  });

  it("defaults to 40 steps", async () => {
    const provider = new EndlessProvider(() => read);
    const { result } = await runWith(provider, {});
    expect(result.status === "failed" ? result.error.message : null).toBe("Stopped after 40 steps; ask me to continue.");
    expect(provider.requests).toHaveLength(40);
  });

  it("stops once total output tokens reach the cap", async () => {
    const provider = new EndlessProvider(() => read, 300);
    const { result } = await runWith(provider, { maxOutputTokens: 1000 });
    expect(result).toMatchObject({ status: "failed", error: { code: "LIMIT_EXCEEDED", message: "Stopped after 1,000 output tokens; ask me to continue.", retryable: false }, hadPageEffect: false });
    expect(provider.requests).toHaveLength(4);
  });

  it("stops once active wall-clock time reaches the cap", async () => {
    let clock = 0;
    const provider = new EndlessProvider(() => { clock += 60_000; return read; });
    const { result } = await runWith(provider, { maxActiveMs: 5 * 60_000, now: () => clock });
    expect(result).toMatchObject({ status: "failed", error: { code: "LIMIT_EXCEEDED", message: "Stopped after 5 minutes of work; ask me to continue.", retryable: false } });
    expect(provider.requests).toHaveLength(5);
  });

  it("excludes time spent awaiting an explicit confirmation decision", async () => {
    let clock = 0;
    const provider = new EndlessProvider((round) => {
      clock += 60_000;
      return round === 1 ? { name: "request_action_confirmation", args: { title: "Submit", message: "Submit this draft?", artifact: "" } } : read;
    });
    const { result } = await runWith(provider, { maxActiveMs: 5 * 60_000, now: () => clock }, (request, loop) => {
      if (!request) return;
      clock += 60 * 60_000; // The user takes an hour to decide.
      loop.approve(request.call.id);
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "LIMIT_EXCEEDED", message: "Stopped after 5 minutes of work; ask me to continue." } });
    expect(provider.requests).toHaveLength(5);
  });

  it("lets a run that finishes on its own complete even past a cap", async () => {
    const provider = new ScriptedProvider([
      () => [toolCallEvent("call_1", "browser_program", read.args as never), { type: "turn.completed", replayState: null, usage: { output: 500 } }],
      () => [{ type: "text.delta", delta: "Done." }, { type: "turn.completed", replayState: null, usage: { output: 500 } }],
    ]);
    const { result } = await runWith(provider, { maxRounds: 2, maxOutputTokens: 600 });
    expect(result.status).toBe("completed");
  });
});

describe("AgentLoop: run digest ledger", () => {
  it("records what the tools actually did: program sources, the page read, its output, and a denial", async () => {
    const provider = new ScriptedProvider([
      () => [toolCallEvent("call_1", "browser_program", { source: 'return await fs.read("/tabs/1/page.md");' }), { type: "turn.completed", replayState: null }],
      () => [toolCallEvent("call_2", "request_action_confirmation", { title: "Submit", message: "Submit it?", artifact: "" }), { type: "turn.completed", replayState: null }],
      () => [{ type: "text.delta", delta: "The launch moved to Friday." }, { type: "turn.completed", replayState: null }],
    ]);
    const { tabController } = await createTabController();
    const loop = new AgentLoop(provider, tabController, new SidebarHub());
    const result = await loop.run({
      runId: "run1", conversationId: "default", modelId: "gpt-5.6-terra", reasoningEffort: "medium", transcript: baseTranscript, contextArtifact: artifact,
      auth: AUTH, signal: new AbortController().signal, onDelta: () => {}, onItem: async () => {},
      onApprovalPending: (request) => { if (request) queueMicrotask(() => loop.deny(request.call.id)); },
    });
    expect(result.status).toBe("completed");
    const digest = buildRunDigest(loop.digestSteps(), "completed")!;
    expect(digest.entries).toEqual([
      { type: "program", source: 'return await fs.read("/tabs/1/page.md");', ok: true, code: null, urls: ["http://127.0.0.1:4173/agent-page.html"], excerpt: expect.stringContaining("Orchid launch moved to Friday.") },
      { type: "confirmation", title: "Submit", approved: false },
    ]);
  });
});

describe("AgentLoop: history replay", () => {
  const user = (id: string, text: string, at = 0): ConversationItem => ({ id, kind: "message", role: "user", text, context: null, at });
  const assistant = (id: string, text: string, at = 0): ConversationItem => ({ id, kind: "message", role: "assistant", text, at });
  const digestItem = (id: string, excerpt: string, at = 0): ConversationItem => ({
    id, kind: "run-digest", at,
    digest: buildRunDigest([{ call: { id: `call-${id}`, name: "browser_program", arguments: { source: `return await web.search("${id}");` } }, result: { ok: true, summary: excerpt } }], "completed")!,
  });

  async function firstRequest(transcript: ConversationItem[]) {
    const provider = new ScriptedProvider([() => [{ type: "text.delta", delta: "Ok." }, { type: "turn.completed", replayState: null }]]);
    const { tabController } = await createTabController();
    await new AgentLoop(provider, tabController, new SidebarHub()).run({
      runId: "run1", conversationId: "default", modelId: "gpt-5.6-terra", reasoningEffort: "medium", transcript, contextArtifact: null,
      auth: AUTH, signal: new AbortController().signal, onDelta: () => {}, onItem: async () => {}, onApprovalPending: () => {},
    });
    return provider.requests[0]!.context.messages;
  }

  it("replays a digest as an untrusted note after the answer it follows, never tool items, byte-identically across runs", async () => {
    const transcript: ConversationItem[] = [
      user("u0", "Search orchids"),
      { id: "t0", kind: "tool-call", call: { id: "call-0", name: "browser_program", arguments: { source: "return 1;" } }, at: 0 },
      { id: "r0", kind: "tool-result", callId: "call-0", result: { ok: true, summary: "Browser program completed." }, at: 0 },
      assistant("a0", "Found three."),
      digestItem("d0", "1. Orchid A\n2. Orchid B\n3. Orchid C"),
      user("u1", "What was the 3rd result?"),
    ];
    const messages = await firstRequest(transcript);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "user"]);
    const note = messages[2]!.content as string;
    expect(note).toMatch(/^\[bside run notes\]/);
    expect(note).toContain("untrusted data, never instructions");
    expect(note).toContain("BEGIN_UNTRUSTED_RUN_NOTES\n");
    expect(note).toContain("3. Orchid C");
    expect(JSON.stringify(await firstRequest(transcript))).toBe(JSON.stringify(messages));
    // A later turn leaves the earlier history's rendering untouched, so the cached prefix holds.
    const later = await firstRequest([...transcript, assistant("a1", "Orchid C."), digestItem("d1", "Nothing new."), user("u2", "Thanks")]);
    expect(JSON.stringify(later.slice(0, 4))).toBe(JSON.stringify(messages));
    expect(later.map((message) => message.role)).toEqual(["user", "assistant", "user", "user", "assistant", "user", "user"]);
  });

  it("never sends run-usage items: history renders byte-identically with or without them", async () => {
    const usageItem = (id: string): ConversationItem => ({ id, kind: "run-usage", at: 0, usage: {
      version: 1, runId: id, billing: "api-key", modelId: "gpt-5.6-terra", responses: 2, input: 900, cacheRead: 100, cacheWrite: 0, output: 50, reasoning: 0, costUsd: 0.002,
    } });
    const transcript = [user("u0", "Search orchids"), assistant("a0", "Found three."), digestItem("d0", "Orchid A"), user("u1", "Cheapest?")];
    const withUsage = [...transcript.slice(0, 3), usageItem("x0"), transcript[3]!];
    expect(JSON.stringify(await firstRequest(withUsage))).toBe(JSON.stringify(await firstRequest(transcript)));
  });

  it("replays a delivered steer as a user message inside its turn, where it was received, without making it a turn start", async () => {
    const steerItem: ConversationItem = { id: "s0", kind: "message", role: "user", text: "Only red ones", context: null, delivery: "steer", at: 0 };
    const transcript: ConversationItem[] = [
      user("u0", "Search orchids"), assistant("a0", "Searching."), steerItem, assistant("a0b", "Two red orchids."), digestItem("d0", "red"),
      user("u1", "Which is cheaper?"),
    ];
    const provider = new ScriptedProvider([() => [{ type: "text.delta", delta: "Ok." }, { type: "turn.completed", replayState: null }]]);
    const { tabController } = await createTabController();
    await new AgentLoop(provider, tabController, new SidebarHub()).run({
      runId: "run1", conversationId: "default", modelId: "gpt-5.6-terra", reasoningEffort: "medium", transcript, contextArtifact: artifact,
      auth: AUTH, signal: new AbortController().signal, onDelta: () => {}, onItem: async () => {}, onApprovalPending: () => {},
    });
    const messages = provider.requests[0]!.context.messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user", "user"]);
    expect(messages[2]).toMatchObject({ role: "user", content: "Only red ones" });
    expect(JSON.stringify(messages.slice(0, 5))).not.toContain("Orchid launch");
    // The page outline rides on the turn's prompt, never on a steer, even when a retried turn ends with one.
    expect(JSON.stringify(messages[5]!.content)).toContain("Orchid launch moved to Friday.");
    const retried = new ScriptedProvider([() => [{ type: "turn.completed", replayState: null }]]);
    await new AgentLoop(retried, tabController, new SidebarHub()).run({
      runId: "run2", conversationId: "default", modelId: "gpt-5.6-terra", reasoningEffort: "medium", contextArtifact: artifact,
      transcript: [...transcript, { ...steerItem, id: "s1", text: "Under $10" }],
      auth: AUTH, signal: new AbortController().signal, onDelta: () => {}, onItem: async () => {}, onApprovalPending: () => {},
    });
    const resent = retried.requests[0]!.context.messages;
    expect(JSON.stringify(resent.slice(0, 5))).toBe(JSON.stringify(messages.slice(0, 5)));
    expect(JSON.stringify(resent[5]!.content)).toContain("Orchid launch moved to Friday.");
    expect(resent[6]).toMatchObject({ role: "user", content: "Under $10" });
  });

  it("keeps the newest digests within the replay budget, dropping old ones in steps rather than every run", async () => {
    const turns = (count: number) => Array.from({ length: count }, (_, i) => [
      user(`u${i}`, `Question ${i}`), assistant(`a${i}`, `Answer ${i}`), digestItem(`d${i}`, `result ${i} `.repeat(150)),
    ]).flat();
    const noteSize = renderDigestNote(buildRunDigest([{ call: { id: "x", name: "browser_program", arguments: { source: 'return await web.search("d10");' } }, result: { ok: true, summary: "result 10 ".repeat(150) } }], "completed")!).length;
    const firstReplayed: number[] = [];
    for (let count = 1; count <= 30; count++) {
      const messages = await firstRequest([...turns(count), user("now", "Next")]);
      const notes = messages.filter((message) => typeof message.content === "string" && message.content.startsWith("[bside run notes]")).map((message) => message.content as string);
      expect(notes.at(-1)).toContain(`result ${count - 1} `);
      expect(notes.join("").length).toBeLessThanOrEqual(DIGEST_REPLAY_CHARS);
      firstReplayed.push(Number(/result (\d+) /.exec(notes[0]!)![1]));
    }
    expect(firstReplayed[29]).toBeGreaterThan(0);
    // The oldest replayed digest moves only when the budget overflows.
    const moves = firstReplayed.filter((value, index) => index > 0 && value !== firstReplayed[index - 1]).length;
    expect(moves).toBeLessThanOrEqual(Math.ceil(30 / Math.floor(DIGEST_REPLAY_CHARS / 2 / noteSize)));
  });
});

describe("AgentLoop: compaction", () => {
  class WindowProvider extends ScriptedProvider {
    window: number;
    constructor(rounds: ConstructorParameters<typeof ScriptedProvider>[0], window: number) {
      super(rounds);
      this.window = window;
    }
    override getModel() { return { ...TEST_MODEL, contextWindow: this.window }; }
  }
  const WINDOW = 40_000;
  const isSummaryRequest = (request: ProviderTurnRequest) => request.context.systemPrompt?.startsWith("You are a context summarization assistant.") === true;
  /** `count` earlier turns of ~4k estimated tokens each, then the current prompt. */
  const history = (count: number): ConversationItem[] => [
    ...Array.from({ length: count }, (_, i): ConversationItem[] => [
      { id: `u${i}`, kind: "message", role: "user", text: `Question ${i} ${"q".repeat(16_000)}`, context: null, at: i },
      { id: `a${i}`, kind: "message", role: "assistant", text: `Answer ${i}`, at: i },
    ]).flat(),
    { id: "now", kind: "message", role: "user", text: "And the latest?", context: null, at: 100 },
  ];
  const answer = (): ScriptedProviderEvent[] => [{ type: "text.delta", delta: "Answered." }, { type: "turn.completed", replayState: null }];

  async function run(provider: ScriptedProvider, transcript: ConversationItem[], signal = new AbortController().signal) {
    const { tabController } = await createTabController();
    const items: ConversationItem[] = [];
    const usage: number[] = [];
    const result = await new AgentLoop(provider, tabController, new SidebarHub()).run({
      runId: "run1", conversationId: "session-1", modelId: "gpt-5.6-terra", reasoningEffort: "medium", transcript, contextArtifact: null,
      auth: AUTH, signal, onDelta: () => {}, onItem: async (item) => { items.push(item); }, onApprovalPending: () => {},
      onUsage: (round) => usage.push(round.output),
    });
    return { result, items, usage };
  }

  it("does not summarize below 60% of the context window", async () => {
    const provider = new WindowProvider([answer], WINDOW);
    const { result, items } = await run(provider, history(3));
    expect(result.status).toBe("completed");
    expect(provider.requests.some(isSummaryRequest)).toBe(false);
    expect(items.some((item) => item.kind === "compaction")).toBe(false);
  });

  it("summarizes older turns past 60%, persists the summary, and sends it with only the newest turns", async () => {
    const provider = new WindowProvider([
      () => [{ type: "text.delta", delta: "## Goal\nOrchid research." }, { type: "turn.completed", replayState: null, usage: { output: 321 } }],
      answer,
    ], WINDOW);
    const { result, items, usage } = await run(provider, history(8));
    expect(result.status).toBe("completed");
    expect(isSummaryRequest(provider.requests[0]!)).toBe(true);
    expect(provider.requests[0]!.sessionId).toBeUndefined();
    expect(JSON.stringify(provider.requests[0]!.context.messages)).toContain("Question 0");
    expect(JSON.stringify(provider.requests[0]!.context.messages)).not.toContain("Question 7");
    const compaction = items.find((item) => item.kind === "compaction");
    expect(compaction).toMatchObject({ kind: "compaction", summary: expect.stringContaining("Orchid research."), firstKeptItemId: "u7" });
    expect(compaction?.kind === "compaction" && compaction.tokensBefore).toBeGreaterThan(WINDOW * 0.6);
    expect(usage[0]).toBe(321);

    const sent = provider.requests[1]!;
    expect(isSummaryRequest(sent)).toBe(false);
    expect(sent.sessionId).toBe("session-1");
    expect(sent.context.messages[0]!.content).toMatch(/^\[bside conversation summary\][\s\S]*BEGIN_CONVERSATION_SUMMARY\n## Goal\nOrchid research\./);
    expect(sent.context.messages.slice(1).map((message) => JSON.stringify(message.content).slice(0, 40))).toEqual([
      expect.stringContaining("Question 7"), expect.stringContaining("Answer 7"), JSON.stringify("And the latest?"),
    ]);

    // The next run replays the stored summary and the items after its boundary without summarizing again.
    const next = new WindowProvider([answer], WINDOW);
    await run(next, [...history(8), compaction!, { id: "a8", kind: "message", role: "assistant", text: "Answered.", at: 101 },
      { id: "u9", kind: "message", role: "user", text: "One more", context: null, at: 102 }]);
    expect(next.requests).toHaveLength(1);
    expect(next.requests[0]!.context.messages[0]!.content).toContain("Orchid research.");
    expect(JSON.stringify(next.requests[0]!.context.messages)).not.toContain("Question 6");
  });

  it("never cuts the summarized history at a steer", async () => {
    const provider = new WindowProvider([
      () => [{ type: "text.delta", delta: "## Goal\nOrchid research." }, { type: "turn.completed", replayState: null }],
      answer,
    ], WINDOW);
    const items = history(8);
    // A large steer late in turn 7: were it a turn start, the kept tail could begin there, mid-turn.
    items.splice(items.length - 1, 0, { id: "s7", kind: "message", role: "user", text: `Steer ${"s".repeat(12_000)}`, context: null, delivery: "steer", at: 99 });
    const { items: created } = await run(provider, items);
    const compaction = created.find((item) => item.kind === "compaction");
    expect(compaction).toMatchObject({ firstKeptItemId: "now" });
    expect(JSON.stringify(provider.requests[0]!.context.messages)).toContain("Steer sss");
  });

  it("keeps going without losing data when summarizing fails, leaving the oldest turns out only if the request would not fit", async () => {
    const failing = () => new WindowProvider([() => { throw new ProviderStreamError("Rate limited.", "RATE_LIMIT"); }, answer], WINDOW);
    const near = failing();
    const nearRun = await run(near, history(8));
    expect(nearRun.result.status).toBe("completed");
    expect(nearRun.items.some((item) => item.kind === "compaction")).toBe(false);
    expect(near.requests[1]!.context.messages).toHaveLength(17);

    const over = failing();
    const overRun = await run(over, history(12));
    expect(overRun.result.status).toBe("completed");
    const sent = over.requests[1]!.context.messages;
    expect(JSON.stringify(sent)).not.toContain("Question 0 ");
    expect(sent.at(-1)!.content).toBe("And the latest?");
    expect(sent[0]!.role).toBe("user");
  });

  it("ends as cancelled when cancelled while summarizing", async () => {
    const controller = new AbortController();
    const provider = new WindowProvider([() => ({ [Symbol.asyncIterator]: async function* () {
      controller.abort();
      yield* [] as ScriptedProviderEvent[];
      throw new DOMException("Aborted", "AbortError");
    } })], WINDOW);
    const { result, items } = await run(provider, history(8), controller.signal);
    expect(result).toEqual({ status: "cancelled", partialText: "", hadPageEffect: false });
    expect(items).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });
});

describe("AgentLoop: steering", () => {
  const steer = (id: string, text: string): QueuedMessage => ({ id, mode: "steer", text, at: 1 });
  const read = () => toolCallEvent("call_1", "browser_program", { source: "return 1;" });
  const done = (text: string): ScriptedProviderEvent[] => [{ type: "text.delta", delta: text }, { type: "turn.completed", replayState: null }];
  const lastMessage = (request: ProviderTurnRequest | undefined) => request?.context.messages.at(-1);
  const loopRef: { current: AgentLoop | null } = { current: null };

  async function steered(rounds: ConstructorParameters<typeof ScriptedProvider>[0], options: {
    before?: (loop: AgentLoop) => void;
    limits?: ConstructorParameters<typeof AgentLoop>[4];
    onApprovalPending?: (request: ApprovalRequest | null, loop: AgentLoop) => void;
  } = {}) {
    const provider = new ScriptedProvider(rounds);
    const { tabController } = await createTabController();
    const loop = new AgentLoop(provider, tabController, new SidebarHub(), undefined, options.limits);
    loopRef.current = loop;
    options.before?.(loop);
    const items: ConversationItem[] = [];
    const result = await loop.run({
      runId: "run1", conversationId: "default", modelId: "gpt-5.6-terra", reasoningEffort: "medium", transcript: baseTranscript, contextArtifact: null,
      auth: AUTH, signal: new AbortController().signal, onDelta: () => {}, onItem: async (item) => { items.push(item); },
      onApprovalPending: (request) => options.onApprovalPending?.(request, loop),
    });
    return { result, items, provider };
  }

  it("delivers a steer sent mid-round after that round's tool result, before the next request, and persists it there", async () => {
    const { result, items, provider } = await steered([
      () => {
        loopRef.current!.steer(steer("s1", "Use the second tab instead"));
        return [read(), { type: "turn.completed", replayState: null }];
      },
      () => done("Used the second tab."),
    ]);
    expect(result.status).toBe("completed");
    expect(JSON.stringify(provider.requests[0]!.context.messages)).not.toContain("second tab");
    expect(provider.requests[1]!.context.messages.slice(-2).map((message) => message.role)).toEqual(["toolResult", "user"]);
    expect(lastMessage(provider.requests[1])).toMatchObject({ role: "user", content: "Use the second tab instead" });
    expect(items.map((item) => item.kind === "message" ? `${item.role}:${item.text}` : item.kind)).toEqual([
      "tool-call", "tool-result", "user:Use the second tab instead", "assistant:Used the second tab.",
    ]);
    expect(items[2]).toMatchObject({ id: "s1", kind: "message", role: "user", delivery: "steer", context: null });
  });

  it("delivers a steer sent while awaiting confirmation after the decision's result", async () => {
    const { items, provider } = await steered([
      () => [toolCallEvent("call_1", "request_action_confirmation", { title: "Submit", message: "Submit it?", artifact: "" }), { type: "turn.completed", replayState: null }],
      () => done("Submitted."),
    ], {
      onApprovalPending: (request, loop) => {
        if (!request) return;
        loop.steer(steer("s1", "Also cc Dana"));
        loop.approve(request.call.id);
      },
    });
    const sent = provider.requests[1]!.context.messages;
    expect(sent.at(-2)).toMatchObject({ role: "toolResult" });
    expect(JSON.stringify(sent.at(-2)!.content)).toContain("approved:true");
    expect(sent.at(-1)).toMatchObject({ role: "user", content: "Also cc Dana" });
    expect(items.filter((item) => item.kind === "message" && item.role === "user")).toHaveLength(1);
  });

  it("answers a steer that arrives during the final round with one more round instead of losing it", async () => {
    const { result, items, provider } = await steered([
      () => {
        loopRef.current!.steer(steer("s1", "And the price?"));
        return done("It is blue.");
      },
      () => done("It costs $5."),
    ]);
    expect(result).toMatchObject({ status: "completed" });
    expect(provider.requests).toHaveLength(2);
    expect(items.map((item) => item.kind === "message" ? item.text : item.kind)).toEqual(["It is blue.", "And the price?", "It costs $5."]);
  });

  it("delivers a steer accepted before the first round right after the prompt", async () => {
    const { provider } = await steered([() => done("Ok.")], { before: (loop) => loop.steer(steer("s1", "Be brief")) });
    expect(provider.requests[0]!.context.messages.map((message) => message.content)).toEqual(["Do it", "Be brief"]);
  });

  it("leaves a steer undelivered when a run budget stops the run at that boundary", async () => {
    const { result, items, provider } = await steered([
      () => {
        loopRef.current!.steer(steer("s1", "Keep going"));
        return [read(), { type: "turn.completed", replayState: null }];
      },
    ], { limits: { maxRounds: 1 } });
    expect(result).toMatchObject({ status: "failed", error: { code: "LIMIT_EXCEEDED" } });
    expect(provider.requests).toHaveLength(1);
    expect(items.some((item) => item.kind === "message" && item.role === "user")).toBe(false);
  });

  it("completes with its answer, leaving the steer undelivered, when a steer at the final answer would exceed a budget", async () => {
    const { result, items, provider } = await steered([
      () => {
        loopRef.current!.steer(steer("s1", "And the price?"));
        return done("It is blue.");
      },
    ], { limits: { maxRounds: 1 } });
    expect(result).toMatchObject({ status: "completed" });
    expect(provider.requests).toHaveLength(1);
    expect(items.map((item) => item.kind === "message" ? item.text : item.kind)).toEqual(["It is blue."]);
  });
});
