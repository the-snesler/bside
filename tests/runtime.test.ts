import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  saveOpenAICredential, appendConversationItem, createSession, ensureOpenSession, getConversation, getOpenAICredential, getOpenSessionId,
  listSessions, loadMessageQueue, saveHistorySettings, saveMessageQueue, saveRunCheckpoint, setOpenSessionId, updateSession,
  getAppSettings, saveAppSettings, getSiteNotes,
} from "@/lib/storage";
import type { ConversationItem, ConversationSummary } from "@/lib/domain/conversation";
import type { ProviderAdapter, ProviderAuth, ProviderTurnRequest } from "@/lib/domain/provider";
import type { PageSnapshot } from "@/lib/domain/tools";
import type { AgentTabsState, SidebarCommand, SidebarEvent } from "@/lib/protocol";
import { splitSystemMessage, TEST_MODEL, toPiStream, type ScriptedProviderEvent } from "@/tests/helpers/pi-provider";
import { buildTurns } from "@/lib/ui/turns";
import { handleSkillsRequest } from "@/lib/background/skills";
import { handleInstructionsRequest, handleSiteNotesRequest } from "@/lib/background/instructions";

type ProviderUsage = NonNullable<Extract<ScriptedProviderEvent, { type: "turn.completed" }>["usage"]>;

/** The open session, as the sidebar shows it; empty before any session exists. */
async function openConversation(): Promise<{ items: ConversationItem[] }> {
  const id = await getOpenSessionId();
  return (id && await getConversation(id)) || { items: [] };
}

/** Appends to the open session (creating one), as an earlier background run would have. */
async function seed(item: ConversationItem): Promise<string> {
  const id = await ensureOpenSession();
  await appendConversationItem(id, item);
  return id;
}

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
    expect((await openConversation()).items).toHaveLength(0);
  });

  it("focuses a mentioned tab without capturing page content", async () => {
    const controller = supportedPageTabControllerFactory();
    const focusTab = vi.spyOn(controller, "focusTab");
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), tabControllerFactory: () => controller });
    await runtime.handleCommand({ v: 1, id: "focus", type: "tabs.focus", tabId: 1 });
    expect(focusTab).toHaveBeenCalledWith(1);
    expect((await openConversation()).items).toHaveLength(0);
  });

  it("saves inline model selection through the background", async () => {
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider: new FakeProvider(), tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const settings = { version: 1 as const, providerId: "openai" as const, modelId: "gpt-5.6-sol", reasoningEffort: "high" as const };
    await runtime.handleCommand({ v: 1, id: "settings", type: "settings.save", settings });
    expect((await runtime.getSnapshot()).settings).toEqual(settings);
  });

  it("exports complete tool output for debugging, persisting page content only as a bounded digest excerpt", async () => {
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
    const exported = await runtime.handleCommand({ v: 1, id: "export", type: "context.export", sessionId: (await getOpenSessionId())! });
    const outputs = exported?.markdown.split("## Full tool output — latest run")[1]?.split("## Conversation log")[0];
    expect(outputs).toContain("Orchid launch moved to Friday.");
    expect(outputs).toContain("Document: doc-1");
    expect(outputs).toContain('"durationMs"');
    const latestRun = exported?.markdown.split("## Latest run")[1]?.split("## Latest model input")[0];
    expect(latestRun).toContain('"modelId"');
    expect(latestRun).toContain('"status": "completed"');
    expect(latestRun).toContain('"providerResponses": 2');
    expect(latestRun).toContain('"name": "browser_program"');
    const persisted = (await openConversation()).items;
    expect(JSON.stringify(persisted.filter((item) => item.kind !== "run-digest"))).not.toContain("Orchid launch moved to Friday.");
    const digest = persisted.find((item) => item.kind === "run-digest");
    expect(digest?.kind === "run-digest" && digest.digest.entries[0]?.type === "program" && digest.digest.entries[0].excerpt).toContain("Orchid launch moved to Friday.");
    await runtime.handleCommand({ v: 1, id: "reset", type: "session.create" });
    expect((await runtime.handleCommand({ v: 1, id: "export2", type: "context.export", sessionId: (await getOpenSessionId())! }))?.markdown).not.toContain("Orchid launch moved to Friday.");
  });

  it("exports the latest model input without credentials and resets saved conversation", async () => {
    await saveOpenAICredential("sk-context-test-secret");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    provider.script = [{ type: "text.delta", delta: "Hello." }, { type: "turn.completed", replayState: null }];
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    await runtime.handleCommand({ v: 1, id: "start", type: "run.start", prompt: "Context export test" });
    const exported = await runtime.handleCommand({ v: 1, id: "export", type: "context.export", sessionId: (await getOpenSessionId())! });
    expect(exported?.filename).toMatch(/\.md$/);
    expect(exported?.markdown).toContain("Context export test");
    expect(exported?.markdown).toContain("browser_program");
    expect(exported?.markdown).toContain("Hello.");
    expect(exported?.markdown).not.toContain("sk-context-test-secret");
    await runtime.handleCommand({ v: 1, id: "reset", type: "session.create" });
    expect((await openConversation()).items).toEqual([]);
    expect((await getOpenAICredential())?.apiKey).toBe("sk-context-test-secret");
    const cleared = await runtime.handleCommand({ v: 1, id: "export2", type: "context.export", sessionId: (await getOpenSessionId())! });
    expect(cleared?.markdown).not.toContain("Context export test");
    expect(cleared?.markdown).toContain("No model input captured");
  });

  it("sends a download only to the requesting sidebar", async () => {
    await seed({ id: "u1", kind: "message", role: "user", text: "Saved context", context: null, at: 1 });
    const hub = new SidebarHub();
    hub.delegate = new BackgroundRuntime(hub, { provider: new FakeProvider() });
    const first = fakePort();
    const second = fakePort();
    hub.handleConnect(first); hub.handleConnect(second);
    await first.send({ v: 1, id: "download", type: "context.export", sessionId: (await getOpenSessionId())! });
    expect(first.received.find((event) => event.type === "context.exported")?.payload).toMatchObject({ requestId: "download", markdown: expect.stringContaining("Saved context") });
    expect(second.received.some((event) => event.type === "context.exported")).toBe(false);
  });
});

describe("BackgroundRuntime: saved skills", () => {
  const skill = { name: "brief", description: "Brief summary", body: "ORIGINAL_SKILL_BODY" };
  const save = (body = skill.body) => handleSkillsRequest({ v: 1, id: "save", type: "skills.save", skill: { ...skill, body } });
  const read: ScriptedProviderEvent[] = [{ type: "tool.call", call: { id: "read-skill", name: "browser_program", arguments: { source: 'return fs.read("/skills/brief.md");' } } }, { type: "turn.completed", replayState: null }];
  const answer: ScriptedProviderEvent[] = [{ type: "text.delta", delta: "Done." }, { type: "turn.completed", replayState: null }];
  const send = (runtime: BackgroundRuntime, command: Record<string, unknown>) => runtime.handleCommand({ v: 1, id: crypto.randomUUID(), ...command } as SidebarCommand);

  it("keeps bodies out of prompts, reads on demand, and pins retry/history despite edits", async () => {
    await saveOpenAICredential("sk-test");
    await save();
    const provider = new FakeProvider();
    let round = 0;
    provider.script = () => ({ [Symbol.asyncIterator]: async function* () {
      const current = round++;
      if (current === 1) throw new ProviderStreamError("Temporary failure", "NETWORK");
      yield* current === 0 || current === 2 ? read : answer;
    } });
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    await send(runtime, { type: "run.start", prompt: "/brief this page" });
    const originalRequest = provider.requests[0]!;
    expect(JSON.stringify(originalRequest)).not.toContain(skill.body);
    expect(JSON.stringify(provider.requests[1])).toContain(skill.body);
    await save("CHANGED_SKILL_BODY");
    await send(runtime, { type: "run.retry" });
    expect(provider.requests[2]!.context.messages[0]).toEqual(originalRequest.context.messages[0]);
    expect(JSON.stringify(provider.requests[3])).toContain(skill.body);
    expect(JSON.stringify(provider.requests[3])).not.toContain("CHANGED_SKILL_BODY");
    await send(runtime, { type: "run.start", prompt: "Follow up" });
    expect(provider.requests[4]!.context.messages[0]).toEqual(originalRequest.context.messages[0]);
    expect(provider.requests[4]!.context.systemPrompt).toEqual(originalRequest.context.systemPrompt);
    expect((await openConversation()).items.filter((item) => item.kind === "message" && item.role === "user")).toHaveLength(2);
  });

  it.each(["follow-up", "steer"] as const)("pins a %s invocation at acceptance through deletion and delivery", async (mode) => {
    await saveOpenAICredential("sk-test");
    await save();
    const gate = Promise.withResolvers<void>();
    const provider = new FakeProvider();
    let round = 0;
    provider.script = () => ({ [Symbol.asyncIterator]: async function* () {
      const current = round++;
      if (current === 0) { await gate.promise; yield* answer; }
      else yield* current === 1 ? read : answer;
    } });
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    const running = send(runtime, { type: "run.start", prompt: "Start" });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    if (mode === "steer") await send(runtime, { type: "run.steer", runId: (await runtime.getSnapshot()).activeRun!.runId, text: "/brief" });
    else await send(runtime, { type: "run.start", prompt: "/brief" });
    expect((await runtime.getSnapshot()).queue[0]?.skill).toEqual(skill);
    await handleSkillsRequest({ v: 1, id: "delete", type: "skills.delete", name: skill.name });
    gate.resolve();
    await running;
    await vi.waitFor(() => expect(provider.requests).toHaveLength(3));
    expect(JSON.stringify(provider.requests[2])).toContain(skill.body);
    const user = (await openConversation()).items.find((item) => item.kind === "message" && item.role === "user" && item.text === "/brief");
    expect(user).toMatchObject({ skill, ...(mode === "steer" ? { delivery: "steer" } : {}) });
  });

  it("refuses unknown explicit names before sending a provider request or persisting a turn", async () => {
    await saveOpenAICredential("sk-test");
    const provider = new FakeProvider();
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    await send(runtime, { type: "run.start", prompt: "/missing" });
    expect(provider.requests).toHaveLength(0);
    expect((await openConversation()).items).toHaveLength(0);
  });

  it("lists the current catalog in the system prompt and never on user messages, queued ones included", async () => {
    await saveOpenAICredential("sk-test");
    const gate = Promise.withResolvers<void>();
    const provider = new FakeProvider();
    let round = 0;
    provider.script = () => ({ [Symbol.asyncIterator]: async function* () {
      if (round++ === 0) await gate.promise;
      yield* answer;
    } });
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    const running = send(runtime, { type: "run.start", prompt: "Start" });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(1));
    await send(runtime, { type: "run.start", prompt: "Queued without skills" });
    await save();
    gate.resolve();
    await running;
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    expect(provider.requests[0]!.context.systemPrompt).not.toContain("/skills/brief.md");
    const { systemPrompt, messages } = provider.requests[1]!.context;
    expect(systemPrompt).toContain(JSON.stringify({ name: skill.name, description: skill.description, path: "/skills/brief.md" }));
    expect(systemPrompt).not.toContain(skill.body);
    expect(messages[0]).toEqual(provider.requests[0]!.context.messages[0]);
    expect(messages.at(-1)?.content).toBe("Queued without skills");
  });
});

describe("BackgroundRuntime: custom instructions and site notes", () => {
  const fixture = { origin: "http://127.0.0.1:4173", includeSubdomains: false, text: "FIXTURE_NOTE" };
  const github = { origin: "https://github.com", includeSubdomains: true, text: "GITHUB_NOTE" };
  const unrelated = { origin: "https://unrelated.example", includeSubdomains: false, text: "UNRELATED_NOTE" };
  const answer: ScriptedProviderEvent[] = [{ type: "text.delta", delta: "Done." }, { type: "turn.completed", replayState: null }];
  const send = (runtime: BackgroundRuntime, command: Record<string, unknown>) => runtime.handleCommand({ v: 1, id: crypto.randomUUID(), ...command } as SidebarCommand);

  it("snapshots instructions at run start and notes for the attached page and mentioned tabs onto the user message", async () => {
    await saveOpenAICredential("sk-test");
    await handleInstructionsRequest({ v: 1, id: "i", type: "instructions.save", text: "CUSTOM_INSTRUCTIONS" });
    for (const note of [fixture, github, unrelated]) await handleSiteNotesRequest({ v: 1, id: note.origin, type: "siteNotes.save", note });
    const provider = new FakeProvider();
    provider.script = answer;
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: supportedPageTabControllerFactory });
    hub.delegate = runtime;
    await send(runtime, { type: "run.start", prompt: "Compare with @PR (tab 7, /tabs/7/page.md, https://gist.github.com/x)" });
    const user = (await openConversation()).items.find((item) => item.kind === "message" && item.role === "user");
    expect(user).toMatchObject({ sites: [fixture, github] });
    const { systemPrompt, messages } = provider.requests[0]!.context;
    expect(systemPrompt).toContain("<user_instructions>\nCUSTOM_INSTRUCTIONS\n</user_instructions>");
    expect(systemPrompt).not.toContain("FIXTURE_NOTE");
    const turn = JSON.stringify(messages.at(-1));
    expect(turn).toContain("FIXTURE_NOTE");
    expect(turn).toContain("GITHUB_NOTE");
    expect(turn).not.toContain("UNRELATED_NOTE");
    // The notes the run used are in that session's export, inside the model input.
    const exported = await runtime.handleCommand({ v: 1, id: "export", type: "context.export", sessionId: (await getOpenSessionId())! });
    expect(exported?.markdown.split("## Latest model input")[1]).toContain("FIXTURE_NOTE");
    expect(exported?.markdown).toContain("CUSTOM_INSTRUCTIONS");
    expect(exported?.markdown).not.toContain("UNRELATED_NOTE");

    // A later run picks up edited instructions, but the earlier message keeps its snapshot.
    await handleInstructionsRequest({ v: 1, id: "i", type: "instructions.save", text: "EDITED_INSTRUCTIONS" });
    await handleSiteNotesRequest({ v: 1, id: "e", type: "siteNotes.save", note: { ...fixture, text: "EDITED_NOTE" } });
    await send(runtime, { type: "run.start", prompt: "Again" });
    const later = provider.requests[1]!.context;
    expect(later.systemPrompt).toContain("EDITED_INSTRUCTIONS");
    expect(JSON.stringify(later.messages[0])).toBe(JSON.stringify({ ...messages.at(-1)!, content: (messages.at(-1)!.content as { text: string }[])[0]!.text }));
    expect(JSON.stringify(later.messages.at(-1))).toContain("EDITED_NOTE");
  });

  it("answers the sidebar's site-note lookup and save", async () => {
    await handleSiteNotesRequest({ v: 1, id: "g", type: "siteNotes.save", note: github });
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), tabControllerFactory: unsupportedPageTabControllerFactory });
    expect(await send(runtime, { type: "siteNote.get", url: "https://gist.github.com/abc" })).toEqual({ origin: "https://gist.github.com", note: github });
    expect(await send(runtime, { type: "siteNote.get", url: "https://example.com/" })).toEqual({ origin: "https://example.com", note: null });
    expect(await send(runtime, { type: "siteNote.get", url: "about:addons" })).toEqual({ origin: null, note: null });
    const note = { origin: "https://example.com", includeSubdomains: false, text: "Remember me" };
    expect(await send(runtime, { type: "siteNote.save", note })).toEqual({ note, error: null });
    expect(await getSiteNotes()).toEqual([github, note]);
  });

  it("posts lookup and save replies only to the requesting sidebar", async () => {
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider: new FakeProvider(), tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const [asking, other] = [fakePort(), fakePort()];
    hub.handleConnect(asking);
    hub.handleConnect(other);
    await asking.send({ v: 1, id: "get", type: "siteNote.get", url: "https://example.com/a" });
    await asking.send({ v: 1, id: "save", type: "siteNote.save", note: { origin: "https://example.com", includeSubdomains: true, text: "Hi" } });
    await asking.send({ v: 1, id: "bad", type: "siteNote.save", note: { origin: "https://example.com/", includeSubdomains: true, text: "Hi" } });
    await vi.waitFor(() => expect(asking.received.filter((event) => event.type.startsWith("siteNote."))).toHaveLength(2));
    expect(asking.received.find((event) => event.type === "siteNote.loaded")?.payload).toEqual({ requestId: "get", origin: "https://example.com", note: null });
    expect(asking.received.find((event) => event.type === "siteNote.saved")?.payload).toEqual({
      requestId: "save", note: { origin: "https://example.com", includeSubdomains: true, text: "Hi" }, error: null,
    });
    expect(other.received.some((event) => event.type.startsWith("siteNote."))).toBe(false);
  });
});

class FakeProvider implements ProviderAdapter {
  readonly definition = { id: "openai" as const, name: "OpenAI", authMethods: [], models: [] };
  script: ScriptedProviderEvent[] | ((signal: AbortSignal) => AsyncIterable<ScriptedProviderEvent>) = [];
  requests: ProviderTurnRequest[] = [];

  async validateAuth(_auth: ProviderAuth, _signal: AbortSignal): Promise<void> {}

  getModel() { return TEST_MODEL; }

  streamTurn(request: ProviderTurnRequest, _auth: ProviderAuth, signal: AbortSignal) {
    this.requests.push(splitSystemMessage(request));
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
  it("queues a second run.start as a follow-up while the run is active, without a second user message", async () => {
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
    await tick();

    const snapshot = await runtime.getSnapshot();
    expect(snapshot.activeRun).not.toBeNull();
    expect(snapshot.conversation.items.filter((item) => item.kind === "message" && item.role === "user")).toHaveLength(1);
    expect(snapshot.queue).toEqual([{ id: expect.any(String), mode: "follow-up", text: "Second", at: expect.any(Number) }]);
    expect(port.received.find((e) => e.type === "queue.changed")).toMatchObject({ conversationId: snapshot.conversation.id, payload: { messages: snapshot.queue } });
    expect(provider.requests).toHaveLength(1);
  });

  it("never starts two runs at once even when run.start arrives twice before credential lookup resolves; the second follows the first", async () => {
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
    expect(userMessages.map((item) => item.text)).toEqual(["A", "B"]);
    expect(provider.requests[1]?.context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(snapshot.queue).toEqual([]);
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

    const runEvents = port.received.filter((e) => e.type !== "state.snapshot" && e.type !== "page.attached" && e.type !== "session.listed");
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
    vi.spyOn(auth, "models").mockResolvedValue([{ id: "account-model", name: "Account model" }]);
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
    const exported = await runtime.handleCommand({ v: 1, id: "export", type: "context.export", sessionId: (await getOpenSessionId())! });
    for (const value of [JSON.stringify(snapshot), exported!.markdown]) {
      expect(value).not.toContain("test-subscription-token");
      expect(value).not.toContain("sk-test-existing-key");
    }
  });

  it("derives account models' efforts from Pi and resets only an effort the saved model does not support", async () => {
    const auth = subscription();
    vi.spyOn(auth, "models").mockResolvedValue([{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }]);
    await saveAppSettings({ version: 1, providerId: "openai", modelId: "gpt-6.1-sol", reasoningEffort: "none" });
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), chatgpt: auth, tabControllerFactory: unsupportedPageTabControllerFactory });
    const response = await runtime.handleSettingsRequest({ v: 1, id: "get", type: "settings.get" });
    expect(response).toMatchObject({
      ok: true,
      settings: { modelId: "gpt-6.1-sol", reasoningEffort: "medium" },
      provider: { models: [{ id: "gpt-6.1-sol", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" }] },
      notice: 'GPT-6.1 Sol does not support "none" reasoning, so it was reset to "medium".',
    });
    expect(await getAppSettings()).toMatchObject({ modelId: "gpt-6.1-sol", reasoningEffort: "medium" });
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
    expect((await openConversation()).items).toEqual([]);
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
    expect((await openConversation()).items).toEqual([]);
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
  it("keys requests by the run's session and accumulates cached input tokens into the run record", async () => {
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

    const sessionId = (await runtime.getSnapshot()).conversation.id;
    expect(sessionId).toMatch(/^[\da-f-]{36}$/);
    expect(provider.requests.map((request) => request.sessionId)).toEqual([sessionId, sessionId]);
    const exported = await runtime.handleCommand({ v: 1, id: "export", type: "context.export", sessionId: (await getOpenSessionId())! });
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
    await seed({ id: "u1", kind: "message", role: "user", text: "Click submit", context: null, at: 1 });
    // The checkpoint does not record effects, so a program the interrupted attempt started may have committed one.
    await seed({ id: "c1", kind: "tool-call", call: { id: "call_1", name: "browser_program", arguments: { source: click } }, at: 2 });
    await saveRunCheckpoint({ version: 2, runId: "r1", sessionId: await ensureOpenSession(), status: "running", partialAssistantText: "", usage: null, lastSeq: 2, updatedAt: 1 });
    const provider = new FakeProvider();
    const { runtime, port } = setup(provider);
    await runtime.initialize();

    await runtime.handleCommand({ v: 1, id: "retry", type: "run.retry" });
    refusedRetry(provider, port, 0);
  });

  it("keeps a turn retryable across a failed retry that committed no page effect", async () => {
    await saveOpenAICredential("sk-test");
    await seed({ id: "u1", kind: "message", role: "user", text: "Read it", context: null, at: 1 });
    await saveRunCheckpoint({ version: 2, runId: "r1", sessionId: await ensureOpenSession(), status: "running", partialAssistantText: "", usage: null, lastSeq: 2, updatedAt: 1 });
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
    expect((await openConversation()).items.at(-1)).toMatchObject({ role: "assistant", text: "Done." });
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
    await saveRunCheckpoint({ version: 2, runId: "r1", sessionId: await ensureOpenSession(), status: "awaiting-approval", partialAssistantText: "", usage: null, lastSeq: 3, updatedAt: 1 });
    const { badge, texts } = fakeBadge();
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), approvalBadge: badge });
    await runtime.initialize();
    await tick();
    expect(texts).toEqual([""]);
    expect((await openConversation()).items.at(-1)).toMatchObject({ id: "interrupted-r1", role: "assistant" });
  });
});

describe("BackgroundRuntime: run.retry", () => {
  const userTexts = async () => (await openConversation()).items.flatMap((item) => item.kind === "message" && item.role === "user" ? [item.text] : []);
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
    await seed({ id: "u0", kind: "message", role: "user", text: "Earlier", context: null, at: 1 });
    await seed({ id: "a0", kind: "message", role: "assistant", text: "Earlier answer.", at: 2 });
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
    expect(port.received.filter((event) => event.type !== "session.listed").at(-1)?.type).toBe("run.completed");
    expect(await userTexts()).toEqual(["Earlier", "Find it"]);
    expect(provider.requests[2]?.context.messages.map((message) => [message.role, JSON.stringify(message.content)])).toEqual([
      ["user", JSON.stringify("Earlier")],
      ["assistant", JSON.stringify([{ type: "text", text: "Earlier answer." }])],
      ["user", JSON.stringify("Find it")],
    ]);
    // The failed attempt stays visible in the same turn, followed by the retried answer.
    const items = (await openConversation()).items;
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
    const texts = (await openConversation()).items.flatMap((item) => item.kind === "message" && item.role === "assistant" ? [item.text] : []);
    expect(texts).toEqual([expect.stringContaining("Stopped"), "Done."]);
  });

  it("re-runs a turn interrupted by a background restart", async () => {
    await saveOpenAICredential("sk-test");
    await seed({ id: "u1", kind: "message", role: "user", text: "Before restart", context: null, at: 1 });
    await saveRunCheckpoint({ version: 2, runId: "r1", sessionId: await ensureOpenSession(), status: "running", partialAssistantText: "Half", usage: null, lastSeq: 2, updatedAt: 1 });
    const provider = new FakeProvider();
    scriptedRounds(provider, [answer("After restart.")]);
    const { runtime } = setup(provider);
    await runtime.initialize();

    await runtime.handleCommand({ v: 1, id: "retry", type: "run.retry" });
    expect(await userTexts()).toEqual(["Before restart"]);
    expect(provider.requests[0]?.context.messages.map((message) => message.role)).toEqual(["user"]);
    expect((await openConversation()).items.at(-1)).toMatchObject({ role: "assistant", text: "After restart." });
  });

  it("drops a retry after a completed turn, a successful retry, a new chat, or with no history", async () => {
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
    await runtime.handleCommand({ v: 1, id: "reset", type: "session.create" });
    await runtime.handleCommand({ v: 1, id: "after-reset", type: "run.retry" });
    expect(provider.requests).toHaveLength(4);
    expect((await openConversation()).items).toEqual([]);
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

/** The open session at the start of each agent-tab test; tags name it as their owner unless a test says otherwise. */
let owner = "";
const tag = (lastUsedAt: number, role: TagRole = "agent", sessionId = owner) => ({ v: 2, role, sessionId, lastUsedAt });
/** Agent tabs per session, as counts. */
const tabCounts = (state: AgentTabsState) => Object.fromEntries(Object.entries(state.bySession).map(([id, tabs]) => [id, tabs.length]));
/** Opens an owner session before the runtime starts, so runs and tags share it. */
const openOwnerSession = async () => { owner = await ensureOpenSession(); };

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
  beforeEach(openOwnerSession);

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

    expect(tabCounts((await restarted.getSnapshot()).agentTabs)).toEqual({ [owner]: 2 });
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

    expect(tabCounts((await runtime.getSnapshot()).agentTabs)).toEqual({});
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

    await vi.waitFor(async () => expect(tabCounts((await runtime.getSnapshot()).agentTabs)).toEqual({ [owner]: 1 }));
    expect(await tabPaths(runtime)).toMatchObject({ 20: "/agent-tabs/20/page.md", 21: "/tabs/21/page.md", 22: "/tabs/22/page.md" });
    expect([...tags.keys()]).toEqual([20]);
    expect(port.received.flatMap((event) => event.type === "agent-tabs.changed" ? [tabCounts(event.payload)] : [])).toEqual([{ [owner]: 1 }]);
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
  beforeEach(openOwnerSession);
  const minute = 60_000;
  const userTab = { id: 1, url: "https://user.test/", title: "User", hidden: false };
  const agentTab = (id: number) => ({ id, url: `https://agent-${id}.test/`, title: "", hidden: true });
  /** Session tags of agent tabs restored at startup, each idle for the given time; the first is the search tab. */
  const owned = (now: number, ...entries: [number, number][]) =>
    new Map<number, unknown>(entries.map(([id, idleMs], index) => [id, tag(now - idleMs, index === 0 ? "search" : "agent")]));

  it("closes the chat's agent tabs, including its search tab, on request and leaves user tabs alone", async () => {
    const { clock } = manualClock();
    const tabs = [userTab, agentTab(5), agentTab(6)];
    const { tags, factory } = fakeTabsApi(tabs, owned(clock.now(), [5, 0], [6, 0]));
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider: new FakeProvider(), tabControllerFactory: factory, clock });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);
    await runtime.initialize();
    expect(tabCounts((await runtime.getSnapshot()).agentTabs)).toEqual({ [owner]: 2 });

    await port.send({ v: 1, id: "close", type: "tabs.closeAgentTabs", sessionId: owner });
    expect(tabs.map((tab) => tab.id)).toEqual([1]);
    expect(tags.size).toBe(0);
    expect(tabCounts((await runtime.getSnapshot()).agentTabs)).toEqual({});
    const counts = port.received.flatMap((event) => event.type === "agent-tabs.changed" ? [tabCounts(event.payload)] : []);
    expect([counts[0], counts.at(-1)]).toEqual([{ [owner]: 2 }, {}]);
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
    await runtime.handleCommand({ v: 1, id: "close", type: "tabs.closeAgentTabs", sessionId: owner });
    expect(tabs.map((tab) => tab.id)).toEqual([1, 5]);
    release();
    await run;
    await runtime.handleCommand({ v: 1, id: "close", type: "tabs.closeAgentTabs", sessionId: owner });
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
  beforeEach(openOwnerSession);

  it("finishes interrupted-run recovery and starts the idle sweep even when agent-tab restoration fails", async () => {
    await saveOpenAICredential("sk-test");
    await seed({ id: "u1", kind: "message", role: "user", text: "Before restart", context: null, at: 1 });
    await saveRunCheckpoint({ version: 2, runId: "r1", sessionId: await ensureOpenSession(), status: "running", partialAssistantText: "", usage: null, lastSeq: 2, updatedAt: 1 });
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
    expect((await openConversation()).items.at(-1)).toMatchObject({ role: "assistant", text: "After restart." });
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
    expect(tabCounts((await runtime.getSnapshot()).agentTabs)).toEqual({ [owner]: 1 });
  });

  it("retries an untag that failed on a later ownership change", async () => {
    const tabs = [userTab, { id: 5, url: "https://agent-5.test/", title: "", hidden: true }, { id: 6, url: "https://agent-6.test/", title: "", hidden: true }];
    const { api, tags, factory } = fakeTabsApi(tabs, new Map([[5, tag(1)], [6, tag(1)]]));
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    scripted(provider, programRound('return fs.move("/agent-tabs/5/page.md", "/tabs/5/page.md");'));
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: factory });
    hub.delegate = runtime;
    await runtime.initialize();
    api.sessions.removeTabValue.mockRejectedValue(new Error("Session store busy."));

    await runtime.handleCommand({ v: 1, id: "move", type: "run.start", prompt: "Show tab 5" });
    await tick();
    expect([...tags.keys()]).toEqual([5, 6]);
    api.sessions.removeTabValue.mockReset();
    scripted(provider, programRound('return fs.remove("/agent-tabs/6/page.md");'));
    await runtime.handleCommand({ v: 1, id: "close", type: "run.start", prompt: "Close tab 6" });
    await vi.waitFor(() => expect(tags.size).toBe(0));
    expect(tabs.map((tab) => [tab.id, tab.hidden])).toEqual([[1, false], [5, false]]);
  });
});

describe("BackgroundRuntime: session-scoped workspace and agent tabs", () => {
  const userTab = () => ({ id: 1, url: "https://user.test/", title: "User", hidden: false });
  const agentTab = (id: number) => ({ id, url: `https://agent-${id}.test/`, title: "", hidden: true });
  beforeEach(openOwnerSession);

  async function setup(tabs: FakeTab[] = [userTab()], tags = new Map<number, unknown>(), clock?: RuntimeClock) {
    await saveOpenAICredential("sk-test");
    const fake = fakeTabsApi(tabs, tags);
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: fake.factory, clock });
    hub.delegate = runtime;
    await runtime.initialize();
    const send = (command: Record<string, unknown>) => runtime.handleCommand({ v: 1, id: crypto.randomUUID(), ...command } as SidebarCommand);
    const program = (source: string, prompt = "Run a program") => { scripted(provider, programRound(source)); return send({ type: "run.start", prompt }); };
    const exported = async (sessionId: string) => (await send({ type: "context.export", sessionId }) as { markdown: string }).markdown.split("## Scratch files")[1];
    return { ...fake, tabs, hub, provider, runtime, send, program, exported };
  }
  const workspaceKeys = async (sessionId: string) => Object.keys(await browser.storage.local.get(null)).filter((key) => key.startsWith(`workspace:${sessionId}:`));

  it("persists each chat's /workspace across a restart, keeps chats apart, exports it, and deletes it with the chat", async () => {
    const { runtime, provider, send, program, exported, factory } = await setup();
    await program('return fs.write("/workspace/notes.md", "Alpha notes");');
    const alpha = owner;
    await send({ type: "session.create" });
    const beta = (await runtime.getSnapshot()).conversation.id;
    await program('return [fs.list("/workspace"), fs.write("/workspace/notes.md", "Beta notes")];');
    expect(modelInput(provider)).toContain("[[],");

    expect(await exported(alpha)).toContain("Alpha notes");
    expect(await exported(alpha)).not.toContain("Beta notes");
    expect(await exported(beta)).toContain("Beta notes");

    const restartedProvider = new FakeProvider();
    const restarted = new BackgroundRuntime(new SidebarHub(), { provider: restartedProvider, tabControllerFactory: factory });
    await restarted.initialize();
    await restarted.handleCommand({ v: 1, id: "open", type: "session.open", sessionId: alpha });
    scripted(restartedProvider, programRound('return fs.read("/workspace/notes.md");'));
    await restarted.handleCommand({ v: 1, id: "run", type: "run.start", prompt: "Read my notes" });
    expect(modelInput(restartedProvider)).toContain("Alpha notes");

    expect(await workspaceKeys(alpha)).toHaveLength(1);
    await restarted.handleCommand({ v: 1, id: "delete", type: "session.delete", sessionId: alpha, closeAgentTabs: true });
    expect(await workspaceKeys(alpha)).toEqual([]);
    expect(await workspaceKeys(beta)).toHaveLength(1);
  });

  it("tags tabs with their chat; other chats neither list nor reach them, and switching chats leaves them alone", async () => {
    const { runtime, provider, send, program, tags, tabs } = await setup();
    await program('const page = await browser.open("https://a.test/"); return page.path();');
    await vi.waitFor(() => expect(tags.get(100)).toMatchObject({ v: 2, role: "agent", sessionId: owner }));

    await send({ type: "session.create" });
    const beta = (await runtime.getSnapshot()).conversation.id;
    expect(tabs.find((tab) => tab.id === 100)?.hidden).toBe(true);
    expect(tabCounts((await runtime.getSnapshot()).agentTabs)).toEqual({ [owner]: 1 });
    expect(await tabPaths(runtime)).toEqual({ 1: "/tabs/1/page.md" });

    await program('return [fs.list("/tabs"), fs.list("/agent-tabs")];');
    expect(modelInput(provider)).toContain("/tabs/1/page.md");
    expect(modelInput(provider)).not.toContain("/100/page.md");
    await program('return fs.read("/agent-tabs/100/page.md");');
    expect(modelInput(provider)).toContain("closed or unsupported");

    await program('return fs.move("/tabs/1/page.md", "/agent-tabs/1/page.md");');
    await vi.waitFor(() => expect(tags.get(1)).toMatchObject({ v: 2, role: "agent", sessionId: beta }));
    expect(tabCounts((await runtime.getSnapshot()).agentTabs)).toEqual({ [owner]: 1, [beta]: 1 });
    await send({ type: "session.open", sessionId: owner });
    expect(await tabPaths(runtime)).toEqual({ 100: "/agent-tabs/100/page.md" });
  });

  it("deleting a chat closes its agent tabs, or with closeAgentTabs false shows and untags them", async () => {
    const kept = await createSessionWith(prompt("u1", "Kept tabs"));
    const closed = await createSessionWith(prompt("u2", "Closed tabs"));
    const tabs = [userTab(), agentTab(5), agentTab(6), agentTab(7), agentTab(8)];
    const { runtime, send, tags } = await setup(tabs, new Map([[5, tag(1, "agent", kept)], [6, tag(1, "search", kept)], [7, tag(1, "agent", closed)], [8, tag(1)]]));
    expect(tabCounts((await runtime.getSnapshot()).agentTabs)).toEqual({ [kept]: 2, [closed]: 1, [owner]: 1 });

    await send({ type: "session.delete", sessionId: kept, closeAgentTabs: false });
    expect(tabs.map((tab) => [tab.id, tab.hidden])).toEqual([[1, false], [5, false], [6, false], [7, true], [8, true]]);
    await vi.waitFor(() => expect([...tags.keys()]).toEqual([7, 8]));
    expect(await tabPaths(runtime)).toMatchObject({ 5: "/tabs/5/page.md", 6: "/tabs/6/page.md" });

    await send({ type: "session.delete", sessionId: closed, closeAgentTabs: true });
    expect(tabs.map((tab) => tab.id)).toEqual([1, 5, 6, 8]);
    expect(tabCounts((await runtime.getSnapshot()).agentTabs)).toEqual({ [owner]: 1 });
  });

  it("closes the agent tabs of chats removed by retention or Delete all history, and of chats that no longer exist", async () => {
    const DAY = 24 * 60 * 60_000;
    const old = await createSessionWith(prompt("u1", "Old"));
    const other = await createSessionWith(prompt("u2", "Other"));
    await setOpenSessionId(owner);
    await saveHistorySettings({ version: 1, retention: "7d" });
    const { clock } = manualClock(Date.now() + 30 * DAY);
    const tabs = [userTab(), agentTab(5), agentTab(6), agentTab(7), agentTab(8)];
    const tags = new Map<number, unknown>([[5, tag(clock.now(), "agent", old)], [6, tag(clock.now(), "agent", "deleted-elsewhere")], [7, tag(clock.now(), "agent", other)], [8, tag(clock.now())]]);
    await updateSession(other, { pinned: true });
    const { runtime } = await setup(tabs, tags, clock);
    expect(await getConversation(old)).toBeNull();
    expect(tabs.map((tab) => tab.id)).toEqual([1, 7, 8]);

    await runtime.handleHistoryRequest({ v: 1, id: "all", type: "history.deleteAll" });
    expect(tabs.map((tab) => tab.id)).toEqual([1]);
    expect(tags.size).toBe(0);
  });

  it("hands back a hidden tab with a pre-session v1 tag instead of adopting it, and untags a visible one", async () => {
    const tabs = [userTab(), agentTab(5), { ...agentTab(6), hidden: false }, agentTab(7)];
    const { api, runtime, tags } = await setup(tabs, new Map<number, unknown>([[5, { v: 1, role: "agent", lastUsedAt: 1 }], [6, { v: 1, role: "search", lastUsedAt: 1 }], [7, tag(1)]]));
    expect(tabCounts((await runtime.getSnapshot()).agentTabs)).toEqual({ [owner]: 1 });
    expect(tabs.map((tab) => [tab.id, tab.hidden])).toEqual([[1, false], [5, false], [6, false], [7, true]]);
    expect([...tags.keys()]).toEqual([7]);
    expect(await tabPaths(runtime)).toMatchObject({ 5: "/tabs/5/page.md", 6: "/tabs/6/page.md", 7: "/agent-tabs/7/page.md" });
    expect(api.tabs.remove).not.toHaveBeenCalled();
  });

  it("keeps a legacy tag for the next startup when Firefox cannot show its tab", async () => {
    const tabs = [userTab(), agentTab(5)];
    const { api, factory, tags } = fakeTabsApi(tabs, new Map<number, unknown>([[5, { v: 1, role: "agent", lastUsedAt: 1 }]]));
    api.tabs.show.mockRejectedValueOnce(new Error("Cannot show"));
    const runtime = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), tabControllerFactory: factory });
    await runtime.initialize();
    expect(tabCounts((await runtime.getSnapshot()).agentTabs)).toEqual({});
    expect([...tags.keys()]).toEqual([5]);
  });
});

describe("BackgroundRuntime: watching an agent tab", () => {
  type WindowTab = FakeTab & { windowId: number; index: number; active: boolean };
  beforeEach(openOwnerSession);

  /**
   * Tabs in windows, each with one active tab, where window 1 is focused.
   * Like Firefox, switching to a hidden tab shows it, and an active tab cannot be hidden.
   */
  async function setup(extra: WindowTab[] = [], extraTags: [number, unknown][] = [], clock?: RuntimeClock) {
    const tabs: WindowTab[] = [
      { id: 1, url: "https://user.test/", title: "User", hidden: false, windowId: 1, index: 0, active: true },
      { id: 2, url: "https://other.test/", title: "Other", hidden: false, windowId: 1, index: 1, active: false },
      { id: 5, url: "https://agent-5.test/", title: "Agent five", hidden: true, windowId: 1, index: 2, active: false },
      { id: 6, url: "https://agent-6.test/", title: "Agent six", hidden: true, windowId: 1, index: 3, active: false },
      ...extra,
    ];
    const fake = fakeTabsApi(tabs, new Map<number, unknown>([[5, tag(clock?.now() ?? 1)], [6, tag(clock?.now() ?? 1)], ...extraTags]));
    const activate = (tabId: number) => {
      const tab = tabs.find((candidate) => candidate.id === tabId)!;
      for (const other of tabs) if (other.windowId === tab.windowId) other.active = other === tab;
      tab.hidden = false;
    };
    const api = Object.assign(fake.api.tabs, {
      query: vi.fn(async (query: { active?: boolean; lastFocusedWindow?: boolean } = {}) => tabs
        .filter((tab) => (query.active === undefined || tab.active === query.active) && (!query.lastFocusedWindow || tab.windowId === 1))
        .map((tab) => ({ ...tab }))),
      update: vi.fn(async (tabId: number, properties: { active?: true; url?: string }) => { if (properties.active) activate(tabId); }),
      // Firefox reports only the tabs it hid: not an active one, nor one already hidden.
      hide: vi.fn(async (tabId: number) => {
        const tab = tabs.find((candidate) => candidate.id === tabId)!;
        if (tab.active || tab.hidden) return [];
        tab.hidden = true;
        return [tabId];
      }),
      move: vi.fn(async (tabId: number, { windowId, index }: { windowId: number; index: number }) => {
        Object.assign(tabs.find((candidate) => candidate.id === tabId)!, { windowId, index });
      }),
    });
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const port = fakePort();
    hub.handleConnect(port);
    const provider = new FakeProvider();
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: fake.factory, clock });
    hub.delegate = runtime;
    await runtime.initialize();
    const send = (command: Record<string, unknown>) => runtime.handleCommand({ v: 1, id: crypto.randomUUID(), ...command } as SidebarCommand);
    /** The user clicks a tab in the tab strip. */
    const switchTo = async (tabId: number) => { activate(tabId); await runtime.handleTabActivated(tabId); };
    const state = (id: number) => { const tab = tabs.find((candidate) => candidate.id === id)!; return { hidden: tab.hidden, active: tab.active }; };
    const watching = async () => (await runtime.getSnapshot()).agentTabs.watching;
    return { ...fake, api, tabs, port, provider, runtime, send, switchTo, state, watching };
  }

  it("shows the chat's agent tab beside the active tab, switches to it, and hides it again once the user switches away", async () => {
    const { api, tags, port, send, switchTo, state, watching, runtime } = await setup();
    await send({ type: "tabs.watch", tabId: 5 });
    expect(api.move).toHaveBeenCalledWith(5, { windowId: 1, index: 1 });
    expect(state(5)).toEqual({ hidden: false, active: true });
    expect(await watching()).toBe(5);
    expect(port.received.filter((event) => event.type === "agent-tabs.changed").at(-1)?.payload).toMatchObject({ watching: 5 });

    // Switching to the watched tab itself, or a tab in another window, is not leaving it.
    await runtime.handleTabActivated(5);
    expect(state(5)).toEqual({ hidden: false, active: true });

    await switchTo(2);
    expect(state(5)).toEqual({ hidden: true, active: false });
    expect(await watching()).toBeNull();
    // bside keeps the tab.
    expect(tags.get(5)).toMatchObject({ v: 2, sessionId: owner });
    expect(await tabPaths(runtime)).toMatchObject({ 5: "/agent-tabs/5/page.md" });
  });

  it("leaves the watched tab on screen when a tab in another window is activated", async () => {
    const { switchTo, send, state, watching } = await setup([{ id: 9, url: "https://window-2.test/", title: "", hidden: false, windowId: 2, index: 0, active: false }]);
    await send({ type: "tabs.watch", tabId: 5 });
    await switchTo(9);
    expect(state(5)).toEqual({ hidden: false, active: true });
    expect(await watching()).toBe(5);
  });

  it("goes back to the tab watched from, and watching another tab hides the first", async () => {
    const { send, state, watching } = await setup();
    await send({ type: "tabs.watch", tabId: 5 });
    await send({ type: "tabs.watch", tabId: 6 });
    expect(state(5)).toEqual({ hidden: true, active: false });
    expect(state(6)).toEqual({ hidden: false, active: true });
    expect(await watching()).toBe(6);

    await send({ type: "tabs.unwatch" });
    expect(state(1)).toEqual({ hidden: false, active: true });
    expect(state(6)).toEqual({ hidden: true, active: false });
    expect(await watching()).toBeNull();
  });

  it("goes back to the nearest visible tab when the tab watched from was closed", async () => {
    const { send, state, tabs } = await setup();
    await send({ type: "tabs.watch", tabId: 5 });
    tabs.splice(tabs.findIndex((tab) => tab.id === 1), 1);
    await send({ type: "tabs.unwatch" });
    expect(state(2)).toEqual({ hidden: false, active: true });
    expect(state(5)).toEqual({ hidden: true, active: false });
  });

  it("refuses another chat's agent tab and an ordinary tab", async () => {
    const other = await createSessionWith(prompt("u1", "Other chat"));
    await setOpenSessionId(owner);
    const { api, send, watching } = await setup(
      [{ id: 7, url: "https://agent-7.test/", title: "", hidden: true, windowId: 1, index: 4, active: false }],
      [[7, tag(1, "agent", other)]],
    );
    await send({ type: "tabs.watch", tabId: 7 });
    await send({ type: "tabs.watch", tabId: 2 });
    expect(api.show).not.toHaveBeenCalled();
    expect(await watching()).toBeNull();
  });

  it("hands the user a watched tab Firefox cannot hide again", async () => {
    const { api, send, switchTo, tags, runtime, state } = await setup();
    await send({ type: "tabs.watch", tabId: 5 });
    api.hide.mockRejectedValueOnce(new Error("Pinned tabs cannot be hidden."));
    await switchTo(1);
    expect(state(5)).toEqual({ hidden: false, active: false });
    await vi.waitFor(() => expect(tags.has(5)).toBe(false));
    expect(await tabPaths(runtime)).toMatchObject({ 5: "/tabs/5/page.md" });
  });

  it("keeps a tab it could not show, still hidden and owned", async () => {
    const { api, send, tags, state, watching } = await setup();
    api.show.mockRejectedValueOnce(new Error("Cannot show"));
    await send({ type: "tabs.watch", tabId: 5 });
    expect(state(5)).toEqual({ hidden: true, active: false });
    expect(await watching()).toBeNull();
    expect(tags.get(5)).toMatchObject({ v: 2, sessionId: owner });
  });

  it("never idle-closes the tab being watched", async () => {
    const { clock, advance, sweep } = manualClock();
    const { send, switchTo, tabs } = await setup([], [], clock);
    await send({ type: "tabs.watch", tabId: 5 });
    advance(AGENT_TAB_IDLE_MS + 60_000);
    await sweep();
    expect(tabs.map((tab) => tab.id)).toEqual([1, 2, 5]);

    await switchTo(1);
    await sweep();
    expect(tabs.map((tab) => tab.id)).toEqual([1, 2]);
  });

  it("attaches the watched tab to a message under /agent-tabs, and never another chat's", async () => {
    const other = await createSessionWith(prompt("u1", "Other chat"));
    await setOpenSessionId(owner);
    const { api, send, provider, switchTo } = await setup(
      [{ id: 7, url: "https://agent-7.test/", title: "", hidden: true, windowId: 1, index: 4, active: false }],
      [[7, tag(1, "agent", other)]],
    );
    api.sendMessage.mockImplementation((async (tabId: number, message: unknown) => {
      const request = message as { id: string; type: string };
      const text = `Page of tab ${tabId}`;
      return { v: 1, id: request.id, ok: true, type: "page.snapshot", snapshot: {
        version: 2, tabId, documentId: `doc-${tabId}`, url: `https://agent-${tabId}.test/`, title: `Tab ${tabId}`, text, offset: 0, end: text.length, totalChars: text.length, selectionText: "",
      } };
    }) as never);
    scripted(provider, [[{ type: "text.delta", delta: "Seen." }, { type: "turn.completed", replayState: null }]]);
    await send({ type: "tabs.watch", tabId: 5 });
    await send({ type: "run.start", prompt: "What is this?" });
    expect(modelInput(provider)).toContain("The user is looking at tab /agent-tabs/5/page.md");

    // Another chat's agent tab, made active some other way, stays invisible to this chat's runs.
    await switchTo(7);
    scripted(provider, [[{ type: "text.delta", delta: "Nothing attached." }, { type: "turn.completed", replayState: null }]]);
    await send({ type: "run.start", prompt: "And now?" });
    expect(modelInput(provider)).not.toContain("Page of tab 7");
    expect(modelInput(provider)).not.toContain("/7/page.md");
  });

  it("publishes each agent tab's title, site, and data-URL icon, never a remote icon", async () => {
    const { tabs, runtime } = await setup();
    Object.assign(tabs.find((tab) => tab.id === 5)!, { favIconUrl: "data:image/png;base64,AAAA" });
    Object.assign(tabs.find((tab) => tab.id === 6)!, { favIconUrl: "https://agent-6.test/favicon.ico", title: "Renamed" });
    runtime.handleTabUpdated(6, { title: "Renamed" });
    await vi.waitFor(async () => expect((await runtime.getSnapshot()).agentTabs.bySession[owner]).toEqual([
      { id: 5, role: "agent", title: "Agent five", url: "https://agent-5.test/", favIconUrl: "data:image/png;base64,AAAA", lastUsedAt: 1 },
      { id: 6, role: "agent", title: "Renamed", url: "https://agent-6.test/", favIconUrl: null, lastUsedAt: 1 },
    ]));
  });
});

describe("BackgroundRuntime: sessions", () => {
  /** Answers each round with `text`; a round scripted as `null` streams "Working" and then waits for cancellation. */
  function scripted(provider: FakeProvider, rounds: Array<string | null | Error>): void {
    let round = 0;
    provider.script = (signal) => {
      const next = round < rounds.length ? rounds[round++] : "Extra.";
      return { [Symbol.asyncIterator]: async function* () {
        if (next instanceof Error) throw next;
        yield { type: "text.delta", delta: next ?? "Working" } as ScriptedProviderEvent;
        if (next !== null) {
          yield { type: "turn.completed", replayState: null } as ScriptedProviderEvent;
          return;
        }
        const { promise, reject } = Promise.withResolvers<never>();
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        await promise;
      } };
    };
  }

  async function setup(rounds: Array<string | null | Error> = []) {
    await saveOpenAICredential("sk-test");
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    scripted(provider, rounds);
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);
    const send = (command: Record<string, unknown>): Promise<unknown> => runtime.handleCommand({ v: 1, id: crypto.randomUUID(), ...command } as SidebarCommand);
    const snapshot = () => runtime.getSnapshot();
    /** Notices are one-shot, so read the one the command's own snapshot broadcast carried. */
    const notice = () => port.received.findLast((event) => event.type === "state.snapshot")?.payload.notice;
    return { runtime, provider, port, send, snapshot, notice };
  }

  const texts = (conversation: { items: ConversationItem[] }) => conversation.items.flatMap((item) => item.kind === "message" ? [item.text] : []);

  it("New chat opens an empty session, reuses one that is already empty, and keeps the previous chat", async () => {
    const { send, snapshot } = await setup(["First answer."]);
    const empty = (await snapshot()).conversation.id;
    await send({ type: "session.create" });
    expect((await snapshot()).conversation.id).toBe(empty);

    await send({ type: "run.start", prompt: "First question" });
    await send({ type: "session.create" });
    const fresh = (await snapshot()).conversation;
    expect(fresh.id).not.toBe(empty);
    expect(fresh.items).toEqual([]);
    const { sessions } = await send({ type: "session.list" }) as { sessions: ConversationSummary[] };
    expect(sessions.map((session) => [session.id, session.title, session.itemCount])).toEqual([
      [fresh.id, "", 0], [empty, "First question", 2],
    ]);
    expect(sessions[1]?.lastModelId).toBe("gpt-5.6-terra");
  });

  it("New chat leaves the previous chat's run diagnostics in its export and starts without them", async () => {
    const { send } = await setup(["Noted."]);
    await send({ type: "run.start", prompt: "Remember this" });
    const previous = (await getOpenSessionId())!;
    await send({ type: "session.create" });
    expect((await send({ type: "context.export", sessionId: (await getOpenSessionId())! }) as { markdown: string }).markdown).toContain("No run recorded");
    expect((await send({ type: "context.export", sessionId: previous }) as { markdown: string }).markdown).toContain('"providerResponses"');
  });

  it("opens another session, deleting the empty one it leaves, and reopens the last session after a restart", async () => {
    const { send, snapshot } = await setup(["Answer A."]);
    await send({ type: "run.start", prompt: "Question A" });
    const a = (await snapshot()).conversation.id;
    await send({ type: "session.create" });
    const empty = (await snapshot()).conversation.id;
    await send({ type: "session.open", sessionId: a });
    expect(texts((await snapshot()).conversation)).toEqual(["Question A", "Answer A."]);
    expect((await listSessionIds())).toEqual([a]);
    expect(await getConversation(empty)).toBeNull();

    const restarted = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), tabControllerFactory: unsupportedPageTabControllerFactory });
    await restarted.initialize();
    expect((await restarted.getSnapshot()).conversation.id).toBe(a);
  });

  it("keeps an empty chat the user renamed or pinned when leaving it", async () => {
    const { send, snapshot } = await setup(["A."]);
    await send({ type: "run.start", prompt: "Question" });
    const asked = (await snapshot()).conversation.id;
    await send({ type: "session.create" });
    const named = (await snapshot()).conversation.id;
    await send({ type: "session.rename", sessionId: named, title: "Later" });
    await send({ type: "session.create" });
    expect((await snapshot()).conversation.id).not.toBe(named);
    await send({ type: "session.open", sessionId: asked });
    expect((await listSessionIds()).sort()).toEqual([asked, named].sort());
  });

  it("refuses to open an unknown session", async () => {
    const { send, snapshot, notice } = await setup();
    const open = (await snapshot()).conversation.id;
    await send({ type: "session.open", sessionId: "missing" });
    expect(notice()).toContain("no longer exists");
    expect((await snapshot()).conversation.id).toBe(open);
  });

  it("lets another session be viewed while the run keeps writing to its own session", async () => {
    const { send, snapshot, port } = await setup(["Older answer.", null]);
    await send({ type: "run.start", prompt: "Older chat" });
    const older = (await snapshot()).conversation.id;
    await send({ type: "session.create" });
    const running = (await snapshot()).conversation.id;
    const run = send({ type: "run.start", prompt: "Long task" });
    await tick();

    await send({ type: "session.open", sessionId: older });
    const viewing = await snapshot();
    expect(viewing.conversation.id).toBe(older);
    expect(viewing.activeRun).toMatchObject({ conversationId: running, partialAssistantText: "Working" });
    expect(port.received.filter((event) => event.type === "run.started").at(-1)?.conversationId).toBe(running);
    expect(port.received.filter((event) => event.type === "state.snapshot").at(-1)?.conversationId).toBe(older);

    // Still one run globally: a second run is refused in the session on screen.
    await send({ type: "run.start", prompt: "Meanwhile" });
    expect(texts((await snapshot()).conversation)).toEqual(["Older chat", "Older answer."]);

    await send({ type: "run.cancel", runId: viewing.activeRun!.runId });
    await run;
    expect(texts((await getConversation(running))!)).toEqual(["Long task", expect.stringContaining("Stopped")]);
    expect(texts((await snapshot()).conversation)).toEqual(["Older chat", "Older answer."]);
  });

  it("refuses to delete the active run's session, and deleting the open session opens the most recent one", async () => {
    const { send, snapshot, notice } = await setup(["One.", "Two.", null]);
    await send({ type: "run.start", prompt: "First" });
    const first = (await snapshot()).conversation.id;
    await send({ type: "session.create" });
    await send({ type: "run.start", prompt: "Second" });
    const second = (await snapshot()).conversation.id;
    await send({ type: "session.create" });
    const third = (await snapshot()).conversation.id;
    const run = send({ type: "run.start", prompt: "Third" });
    await tick();

    await send({ type: "session.delete", sessionId: third });
    expect(notice()).toContain("Stop the run");
    expect(await getConversation(third)).not.toBeNull();
    await send({ type: "run.cancel", runId: (await snapshot()).activeRun!.runId });
    await run;

    await send({ type: "session.delete", sessionId: third });
    expect((await snapshot()).conversation.id).toBe(second);
    await send({ type: "session.delete", sessionId: first });
    expect((await snapshot()).conversation.id).toBe(second);
    await send({ type: "session.delete", sessionId: second });
    const fresh = (await snapshot()).conversation;
    expect([first, second, third]).not.toContain(fresh.id);
    expect(fresh.items).toEqual([]);
    expect(await listSessionIds()).toEqual([fresh.id]);
  });

  it("renames and pins through the background, and answers session.list only to the requesting sidebar", async () => {
    const { send, snapshot, port, notice } = await setup(["A.", "B."]);
    await send({ type: "run.start", prompt: "Alpha" });
    const alpha = (await snapshot()).conversation.id;
    await send({ type: "session.create" });
    await send({ type: "run.start", prompt: "Beta" });

    await send({ type: "session.rename", sessionId: alpha, title: "  Trip   plans " });
    await send({ type: "session.pin", sessionId: alpha, pinned: true });
    await send({ type: "session.rename", sessionId: alpha, title: "   " });
    expect(notice()).toContain("1 to 120 characters");

    const before = port.received.length;
    await port.send({ v: 1, id: "list", type: "session.list" });
    const listed = port.received.filter((event) => event.type === "session.listed").at(-1);
    expect(listed?.type === "session.listed" && listed.payload.sessions.map((session) => [session.title, session.titleSource, session.pinned])).toEqual([
      ["Trip plans", "user", true], ["Beta", "prompt", false],
    ]);
    expect(port.received.slice(before).map((event) => event.type)).toEqual(["session.listed"]);
  });

  it("offers retry only in the session whose turn failed", async () => {
    const { send, snapshot, provider } = await setup([new ProviderStreamError("Rate limited.", "RATE_LIMIT"), "Recovered."]);
    await send({ type: "run.start", prompt: "Flaky" });
    const failed = (await snapshot()).conversation.id;
    await send({ type: "session.create" });
    await send({ type: "run.retry" });
    expect(provider.requests).toHaveLength(1);

    await send({ type: "session.open", sessionId: failed });
    await send({ type: "run.retry" });
    expect(provider.requests).toHaveLength(2);
    expect(texts((await snapshot()).conversation)).toEqual(["Flaky", "Recovered."]);
  });

  it("recovers an interrupted run into its own session, not the open one", async () => {
    const interrupted = await createSessionWith(prompt("u1", "Interrupted task"));
    const open = await createSessionWith(prompt("u2", "Other chat"));
    await setOpenSessionId(open);
    await saveRunCheckpoint({ version: 2, runId: "r9", sessionId: interrupted, status: "running", partialAssistantText: "Half", usage: null, lastSeq: 1, updatedAt: 1 });
    const { runtime, send, snapshot, provider } = await setup(["After restart."]);
    await runtime.initialize();

    expect((await snapshot()).conversation.id).toBe(open);
    expect((await getConversation(interrupted))?.items.at(-1)).toMatchObject({ id: "interrupted-r9", text: expect.stringContaining("Half") });
    expect((await getConversation(open))?.items).toHaveLength(1);
    await send({ type: "run.retry" });
    expect(provider.requests).toHaveLength(0);
    await send({ type: "session.open", sessionId: interrupted });
    await send({ type: "run.retry" });
    expect((await getConversation(interrupted))?.items.at(-1)).toMatchObject({ role: "assistant", text: "After restart." });
  });

  it("migrates the pre-sessions conversation at startup and keeps its prompt-cache key", async () => {
    await browser.storage.local.set({ conversation: { version: 1, id: "default", items: [prompt("u1", "Legacy question")], updatedAt: 5 } });
    const { runtime, send, snapshot, provider } = await setup(["Continued."]);
    await runtime.initialize();
    expect((await snapshot()).conversation).toMatchObject({ id: "default", title: "Legacy question" });
    await send({ type: "run.start", prompt: "Follow-up" });
    expect(provider.requests[0]?.sessionId).toBe("default");
    expect((await browser.storage.local.get("conversation")).conversation).toBeUndefined();
  });
});

describe("BackgroundRuntime: history drawer support", () => {
  const DAY = 24 * 60 * 60_000;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 0, 1));
  });
  afterEach(() => vi.useRealTimers());

  /** A clock on the (faked) system time; `sweep()` fires the runtime's periodic timer. */
  function systemClock() {
    let timer: (() => void) | null = null;
    const clock: RuntimeClock = { now: () => Date.now(), setInterval: (callback) => { timer = callback; return 1; } };
    return { clock, async sweep() { timer!(); await tick(); } };
  }

  async function setup(provider: FakeProvider = new FakeProvider()) {
    await saveOpenAICredential("sk-test");
    const { clock, sweep } = systemClock();
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory, clock });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);
    const send = (command: Record<string, unknown>) => runtime.handleCommand({ v: 1, id: crypto.randomUUID(), ...command } as SidebarCommand);
    const history = (request: Record<string, unknown>) => runtime.handleHistoryRequest({ v: 1, id: crypto.randomUUID(), ...request } as never);
    const listed = () => port.received.flatMap((event) => event.type === "session.listed" ? [event.payload.sessions] : []);
    return { hub, runtime, port, send, history, listed, sweep };
  }

  it("prunes unpinned chats past retention at startup, keeping pinned, open, and recent ones", async () => {
    const old = await createSessionWith(prompt("u1", "Old"));
    const pinned = await createSessionWith(prompt("u2", "Pinned"));
    await updateSession(pinned, { pinned: true });
    const open = await createSessionWith(prompt("u3", "Open"));
    await setOpenSessionId(open);
    vi.setSystemTime(Date.now() + 20 * DAY);
    const recent = await createSessionWith(prompt("u4", "Recent"));
    await saveHistorySettings({ version: 1, retention: "7d" });

    const { runtime } = await setup();
    await runtime.initialize();
    expect((await listSessionIds()).sort()).toEqual([pinned, open, recent].sort());
    expect(Object.keys(await browser.storage.local.get(null)).filter((key) => key.includes(old))).toEqual([]);
  });

  it("keeps everything by default, and applies a shorter retention from the options page at once, sparing the active run's chat", async () => {
    const { provider, release } = blockingProvider();
    const { runtime, send, history, listed } = await setup(provider);
    await runtime.initialize();
    const old = await createSessionWith(prompt("u1", "Old"));
    const running = (await runtime.getSnapshot()).conversation.id;
    const run = send({ type: "run.start", prompt: "Long task" });
    await tick();
    await send({ type: "session.create" });
    const open = (await runtime.getSnapshot()).conversation.id;
    vi.setSystemTime(Date.now() + 40 * DAY);

    expect(await history({ type: "history.retention.save", retention: "forever" })).toMatchObject({ ok: true, sessionCount: 3, notice: null });
    const saved = await history({ type: "history.retention.save", retention: "30d" });
    expect(saved).toMatchObject({ ok: true, settings: { version: 1, retention: "30d" }, sessionCount: 2, notice: expect.stringContaining("Deleted 1 chat") });
    expect(await getConversation(old)).toBeNull();
    expect(listed().at(-1)?.map((session) => session.id).sort()).toEqual([running, open].sort());
    release();
    await run;
  });

  it("re-applies retention on the first sweep an hour after the last pass", async () => {
    const { runtime, send, sweep } = await setup();
    await runtime.initialize();
    await saveHistorySettings({ version: 1, retention: "7d" });
    const stale = (await runtime.getSnapshot()).conversation.id;
    await send({ type: "session.rename", sessionId: stale, title: "Kept until left" });
    await send({ type: "session.create" });
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await sweep();
    expect(await getConversation(stale)).not.toBeNull();
    vi.setSystemTime(Date.now() + 8 * DAY);
    await sweep();
    expect(await getConversation(stale)).toBeNull();
    expect(await listSessionIds()).toEqual([(await runtime.getSnapshot()).conversation.id]);
  });

  it("deletes all history except the active run's chat and opens a fresh empty chat", async () => {
    const { provider, release } = blockingProvider();
    const { runtime, send, history, listed, port } = await setup(provider);
    await runtime.initialize();
    const pinned = await createSessionWith(prompt("u1", "Pinned"));
    await updateSession(pinned, { pinned: true });
    const running = (await runtime.getSnapshot()).conversation.id;
    const run = send({ type: "run.start", prompt: "Long task" });
    await tick();
    await send({ type: "session.create" });
    const viewing = (await runtime.getSnapshot()).conversation.id;

    const response = await history({ type: "history.deleteAll" });
    expect(response).toMatchObject({ ok: true, sessionCount: 2, notice: expect.stringContaining("active run was kept") });
    const fresh = port.received.findLast((event) => event.type === "state.snapshot")!;
    expect(fresh.type === "state.snapshot" && fresh.payload.conversation).toMatchObject({ items: [] });
    expect([pinned, viewing, running]).not.toContain(fresh.conversationId);
    expect(listed().at(-1)?.map((session) => session.id).sort()).toEqual([running, fresh.conversationId].sort());
    release();
    await run;
    expect((await getConversation(running))?.items[0]).toMatchObject({ role: "user", text: "Long task" });

    expect(await history({ type: "history.deleteAll" })).toMatchObject({ ok: true, sessionCount: 1, notice: "Deleted 2 chats." });
  });

  it("exports any chat by id, with run diagnostics only for the latest run's chat", async () => {
    const provider = new FakeProvider();
    provider.script = [{ type: "text.delta", delta: "Answer." }, { type: "turn.completed", replayState: null }];
    const { runtime, send, port } = await setup(provider);
    await send({ type: "run.start", prompt: "Alpha question" });
    const alpha = (await runtime.getSnapshot()).conversation.id;
    await send({ type: "session.create" });
    await send({ type: "run.start", prompt: "Beta question" });
    const beta = (await runtime.getSnapshot()).conversation.id;
    await send({ type: "session.open", sessionId: alpha });

    const exportOf = async (sessionId: string) => (await send({ type: "context.export", sessionId }) as { markdown: string } | undefined)?.markdown;
    const alphaExport = await exportOf(alpha);
    expect(alphaExport).toContain("Alpha question");
    expect(alphaExport).not.toContain("Beta question");
    expect(alphaExport).toContain("No run recorded for this chat");
    const betaExport = await exportOf(beta);
    expect(betaExport).toContain("Beta question");
    expect(betaExport).toContain('"providerResponses": 1');
    expect(betaExport).not.toContain("sk-test");

    expect(await exportOf("missing")).toBeUndefined();
    expect(port.received.findLast((event) => event.type === "state.snapshot")?.payload).toMatchObject({ notice: expect.stringContaining("no longer exists") });
  });

  it("pushes the session list to every sidebar when a run titles a chat, when it ends, and on session commands", async () => {
    const provider = new FakeProvider();
    provider.script = [{ type: "text.delta", delta: "Answer." }, { type: "turn.completed", replayState: null }];
    const { hub, runtime, send, listed, port } = await setup(provider);
    const other = fakePort();
    hub.handleConnect(other);
    await send({ type: "run.start", prompt: "Plan a @Trip (tab 4, /tabs/4/page.md, https://example.com/) today" });
    const id = (await runtime.getSnapshot()).conversation.id;
    const lists = listed();
    expect(lists[0]).toEqual([expect.objectContaining({ id, title: "Plan a @Trip today", itemCount: 1 })]);
    expect(lists.at(-1)).toEqual([expect.objectContaining({ id, itemCount: 2 })]);
    const runEvents = port.received.map((event) => event.type);
    expect(runEvents.indexOf("session.listed")).toBeGreaterThan(runEvents.indexOf("run.started"));

    await send({ type: "session.rename", sessionId: id, title: "Trip" });
    expect(listed().at(-1)).toEqual([expect.objectContaining({ id, title: "Trip", titleSource: "user" })]);
    expect(other.received.filter((event) => event.type === "session.listed")).toHaveLength(listed().length);
  });
});

const prompt = (id: string, text: string): ConversationItem => ({ id, kind: "message", role: "user", text, context: null, at: 1 });

async function createSessionWith(...items: ConversationItem[]): Promise<string> {
  const { id } = await createSession();
  for (const item of items) await appendConversationItem(id, item);
  return id;
}

async function listSessionIds(): Promise<string[]> {
  return (await listSessions()).map((session) => session.id);
}

describe("BackgroundRuntime: run digests and context continuity", () => {
  const programCall = (id: string, source = "return 1;"): ScriptedProviderEvent => ({ type: "tool.call", call: { id, name: "browser_program", arguments: { source } } });
  const done: ScriptedProviderEvent = { type: "turn.completed", replayState: null };

  function setup(rounds: Array<ScriptedProviderEvent[] | Error | "hang" | "loop">, tabControllerFactory = unsupportedPageTabControllerFactory) {
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    let round = 0;
    provider.script = (signal) => {
      const next = rounds[Math.min(round++, rounds.length - 1)]!;
      return { [Symbol.asyncIterator]: async function* () {
        if (next instanceof Error) throw next;
        if (next === "loop") { yield programCall(`loop-${round}`); yield done; return; }
        if (next === "hang") {
          const { promise, reject } = Promise.withResolvers<never>();
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          await promise;
        }
        yield* next as ScriptedProviderEvent[];
      } };
    };
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);
    return { runtime, provider, port };
  }
  const digests = async () => (await openConversation()).items.flatMap((item) => item.kind === "run-digest" ? [item.digest] : []);

  it("persists a digest after a completed run's answer and replays it as a note on the next run", async () => {
    await saveOpenAICredential("sk-test");
    const { runtime, provider } = setup([
      [programCall("read", 'return fs.read("/tabs/1/page.md");'), done],
      [{ type: "text.delta", delta: "It moved to Friday." }, done],
      [{ type: "text.delta", delta: "Friday." }, done],
    ], supportedPageTabControllerFactory);
    await runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "When is the launch?" });
    const items = (await openConversation()).items;
    expect(items.map((item) => item.kind)).toEqual(["message", "tool-call", "tool-result", "message", "run-digest"]);
    expect(await digests()).toEqual([{ version: 1, status: "completed", error: null, omittedEntries: 0, entries: [
      { type: "program", source: 'return fs.read("/tabs/1/page.md");', ok: true, code: null, urls: ["http://127.0.0.1:4173/agent-page.html"], excerpt: expect.stringContaining("Orchid launch moved to Friday.") },
    ] }]);

    await runtime.handleCommand({ v: 1, id: "2", type: "run.start", prompt: "Which day again?" });
    const messages = provider.requests[2]!.context.messages;
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "user"]);
    expect(messages[2]!.content).toEqual(expect.stringContaining("Orchid launch moved to Friday."));
    expect(messages[2]!.content).toMatch(/^\[bside run notes\]/);
    // Exports carry digests with the rest of the chat.
    const exported = await runtime.handleCommand({ v: 1, id: "export", type: "context.export", sessionId: (await getOpenSessionId())! });
    expect(exported?.markdown.split("## Conversation log")[1]).toContain('"kind": "run-digest"');
  });

  it("persists a digest for a failed run with its safe error, and leaves it out of the retried request", async () => {
    await saveOpenAICredential("sk-test");
    const { runtime, provider } = setup([[programCall("p1"), done], new ProviderStreamError("Rate limited.", "RATE_LIMIT"), [{ type: "text.delta", delta: "Ok." }, done]]);
    await runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Try" });
    expect(await digests()).toEqual([expect.objectContaining({ status: "failed", error: "Rate limited.", entries: [expect.objectContaining({ source: "return 1;", ok: true })] })]);
    await runtime.handleCommand({ v: 1, id: "2", type: "run.retry" });
    expect(provider.requests[2]!.context.messages.map((message) => message.role)).toEqual(["user"]);
  });

  it("persists a digest for a run stopped by a budget (LIMIT_EXCEEDED), bounded to the newest calls", async () => {
    await saveOpenAICredential("sk-test");
    const { runtime, port } = setup(["loop"]);
    await runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Loop" });
    expect(port.received.find((event) => event.type === "run.failed")?.payload).toMatchObject({ code: "LIMIT_EXCEEDED" });
    const [digest] = await digests();
    expect(digest).toMatchObject({ status: "failed", error: expect.stringContaining("Stopped after 40 steps"), omittedEntries: 24 });
    expect(digest!.entries).toHaveLength(16);
  });

  it("persists a digest for a cancelled run", async () => {
    await saveOpenAICredential("sk-test");
    const { runtime } = setup([[programCall("p1"), done], "hang"]);
    const run = runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Go" });
    await tick();
    await runtime.handleCommand({ v: 1, id: "2", type: "run.cancel", runId: (await runtime.getSnapshot()).activeRun!.runId });
    await run;
    expect(await digests()).toEqual([expect.objectContaining({ status: "cancelled", entries: [expect.objectContaining({ ok: true })] })]);
  });

  it("writes no digest for a run that used no tools", async () => {
    await saveOpenAICredential("sk-test");
    const { runtime } = setup([[{ type: "text.delta", delta: "Hi." }, done]]);
    await runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Hello" });
    expect(await digests()).toEqual([]);
  });

  it("rebuilds a digest from the persisted calls of a run interrupted by a restart", async () => {
    await seed({ id: "u1", kind: "message", role: "user", text: "Before restart", context: null, at: 1 });
    await seed({ id: "t1", kind: "tool-call", call: { id: "call_1", name: "browser_program", arguments: { source: 'return await web.search("orchids");' } }, at: 2 });
    await saveRunCheckpoint({ version: 2, runId: "r1", sessionId: await ensureOpenSession(), status: "running", partialAssistantText: "", usage: null, lastSeq: 2, updatedAt: 1 });
    const { runtime } = setup([[{ type: "text.delta", delta: "Ok." }, done]]);
    await runtime.initialize();
    const items = (await openConversation()).items;
    expect(items.at(-2)).toMatchObject({ id: "interrupted-r1" });
    expect(items.at(-1)).toMatchObject({ id: "digest-r1", kind: "run-digest", digest: { status: "interrupted", entries: [{ type: "program", source: 'return await web.search("orchids");', ok: null }] } });
  });

  it("publishes a snapshot with the compaction marker as soon as older turns are summarized", async () => {
    await saveOpenAICredential("sk-test");
    for (let i = 0; i < 6; i++) {
      await seed({ id: `u${i}`, kind: "message", role: "user", text: `Question ${i} ${"q".repeat(16_000)}`, context: null, at: i });
      await seed({ id: `a${i}`, kind: "message", role: "assistant", text: `Answer ${i}`, at: i });
    }
    const { runtime, provider, port } = setup([[{ type: "text.delta", delta: "Summary of orchids." }, done], [{ type: "text.delta", delta: "Answered." }, done]]);
    provider.getModel = () => ({ ...TEST_MODEL, contextWindow: 30_000 });
    await runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Latest?" });
    const items = (await openConversation()).items;
    const compaction = items.find((item) => item.kind === "compaction");
    expect(compaction).toMatchObject({ summary: "Summary of orchids.", firstKeptItemId: expect.any(String) });
    // Every item stays stored; only the model's view is summarized.
    expect(items.filter((item) => item.kind === "message")).toHaveLength(14);
    await tick();
    const snapshots = port.received.filter((event) => event.type === "state.snapshot");
    expect(snapshots.some((event) => event.type === "state.snapshot" && event.payload.conversation.items.some((item) => item.kind === "compaction"))).toBe(true);
    expect(provider.requests[1]!.context.messages[0]!.content).toContain("Summary of orchids.");
    const exported = await runtime.handleCommand({ v: 1, id: "export", type: "context.export", sessionId: (await getOpenSessionId())! });
    expect(exported?.markdown).toContain("Summary of orchids.");
  });
});

describe("BackgroundRuntime: talk while it works", () => {
  type Round = { events?: ScriptedProviderEvent[]; gate?: Promise<void>; error?: Error };
  const answer = (text: string): ScriptedProviderEvent[] => [{ type: "text.delta", delta: text }, { type: "turn.completed", replayState: null }];
  const program: ScriptedProviderEvent[] = [
    { type: "tool.call", call: { id: "call_1", name: "browser_program", arguments: { source: "return 1;" } } }, { type: "turn.completed", replayState: null },
  ];
  /** Rounds in order; a gated round waits for its gate (or cancellation) before streaming. */
  function scripted(provider: FakeProvider, rounds: Round[]): void {
    let round = 0;
    provider.script = (signal) => {
      const next = rounds[round++] ?? { events: answer("Extra.") };
      return { [Symbol.asyncIterator]: async function* () {
        if (next.gate) {
          await new Promise<void>((resolve, reject) => {
            void next.gate!.then(resolve);
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          });
        }
        if (next.error) throw next.error;
        yield* next.events ?? [];
      } };
    };
  }
  function setup(provider = new FakeProvider()) {
    const hub = new SidebarHub();
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);
    return { runtime, port, provider };
  }
  const send = (runtime: BackgroundRuntime, command: Record<string, unknown>) =>
    runtime.handleCommand({ v: 1, id: crypto.randomUUID(), ...command } as SidebarCommand);
  const userTexts = (items: ConversationItem[]) => items.flatMap((item) => item.kind === "message" && item.role === "user" ? [item.text] : []);
  const queueOf = async (runtime: BackgroundRuntime) => (await runtime.getSnapshot()).queue.map((message) => `${message.mode}:${message.text}`);

  beforeEach(async () => {
    await saveOpenAICredential("sk-test");
  });

  it("steers the running turn at its next tool boundary, showing the steer as pending until it is delivered", async () => {
    const { runtime, port, provider } = setup();
    const gate = Promise.withResolvers<void>();
    scripted(provider, [{ events: program, gate: gate.promise }, { events: answer("Used tab 2.") }]);
    const run = send(runtime, { type: "run.start", prompt: "Compare prices" });
    await tick();
    const { activeRun, conversation } = await runtime.getSnapshot();
    await send(runtime, { type: "run.steer", runId: activeRun!.runId, text: "  Use tab 2  " });
    const [pending] = (await runtime.getSnapshot()).queue;
    expect(pending).toEqual({ id: expect.any(String), mode: "steer", text: "Use tab 2", at: expect.any(Number) });
    // A pending steer is already on its way to the model.
    await send(runtime, { type: "queue.remove", sessionId: conversation.id, messageId: pending!.id });
    expect(await queueOf(runtime)).toEqual(["steer:Use tab 2"]);

    gate.resolve();
    await run;
    expect(JSON.stringify(provider.requests[0]!.context.messages)).not.toContain("Use tab 2");
    expect(provider.requests[1]!.context.messages.at(-1)).toMatchObject({ role: "user", content: "Use tab 2" });
    const items = (await openConversation()).items;
    expect(items.map((item) => item.kind === "message" ? item.role : item.kind)).toEqual(["user", "tool-call", "tool-result", "user", "assistant", "run-digest"]);
    expect(items[3]).toMatchObject({ id: pending!.id, delivery: "steer", text: "Use tab 2" });
    expect(port.received.find((event) => event.type === "steer.delivered")?.payload).toEqual({ item: items[3] });
    expect(await queueOf(runtime)).toEqual([]);
    expect(port.received.filter((event) => event.type === "run.started")).toHaveLength(1);
  });

  it("starts a queued follow-up as the next turn once the run completes, in the run's chat even after switching chats", async () => {
    const { runtime, port, provider } = setup();
    const gate = Promise.withResolvers<void>();
    scripted(provider, [{ events: answer("A done."), gate: gate.promise }, { events: answer("B done.") }]);
    const run = send(runtime, { type: "run.start", prompt: "A" });
    await tick();
    const first = (await runtime.getSnapshot()).conversation.id;
    await send(runtime, { type: "run.start", prompt: "B" });
    expect(await queueOf(runtime)).toEqual(["follow-up:B"]);
    await send(runtime, { type: "session.create" });
    // Another chat cannot queue for, or start beside, the run.
    await send(runtime, { type: "run.start", prompt: "C" });
    expect(await queueOf(runtime)).toEqual([]);

    gate.resolve();
    await run;
    const chat = await getConversation(first);
    expect(userTexts(chat!.items)).toEqual(["A", "B"]);
    expect(chat!.items.at(-1)).toMatchObject({ role: "assistant", text: "B done." });
    expect((await openConversation()).items).toEqual([]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.sessionId).toBe(first);
    expect(provider.requests[1]!.context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(port.received.filter((event) => event.type === "run.started").map((event) => event.conversationId)).toEqual([first, first]);
    expect(await loadMessageQueue(first)).toEqual([]);
  });

  it("keeps follow-ups waiting after a failed run until the user sends or removes them", async () => {
    const { runtime, provider } = setup();
    const gate = Promise.withResolvers<void>();
    scripted(provider, [{ gate: gate.promise, error: new ProviderStreamError("Rate limited.", "RATE_LIMIT") }, { events: answer("B done.") }]);
    const run = send(runtime, { type: "run.start", prompt: "A" });
    await tick();
    await send(runtime, { type: "run.start", prompt: "B" });
    await send(runtime, { type: "run.start", prompt: "C" });
    gate.resolve();
    await run;
    expect(provider.requests).toHaveLength(1);
    expect(await queueOf(runtime)).toEqual(["follow-up:B", "follow-up:C"]);

    const { conversation, queue } = await runtime.getSnapshot();
    await send(runtime, { type: "queue.remove", sessionId: conversation.id, messageId: queue[1]!.id });
    await send(runtime, { type: "queue.send", sessionId: conversation.id, messageId: queue[0]!.id });
    expect(userTexts((await openConversation()).items)).toEqual(["A", "B"]);
    expect(provider.requests).toHaveLength(2);
    expect(await queueOf(runtime)).toEqual([]);
  });

  it("turns steers still pending at cancellation into waiting follow-ups and sends nothing", async () => {
    const { runtime, provider } = setup();
    scripted(provider, [{ events: answer("Never."), gate: new Promise(() => {}) }]);
    const run = send(runtime, { type: "run.start", prompt: "A" });
    await tick();
    const runId = (await runtime.getSnapshot()).activeRun!.runId;
    await send(runtime, { type: "run.steer", runId, text: "S" });
    await send(runtime, { type: "run.start", prompt: "F" });
    await send(runtime, { type: "run.cancel", runId });
    await run;
    expect(await queueOf(runtime)).toEqual(["follow-up:S", "follow-up:F"]);
    expect(provider.requests).toHaveLength(1);
    expect(userTexts((await openConversation()).items)).toEqual(["A"]);
  });

  it("treats a steer for a run that already ended as a new prompt", async () => {
    const { runtime, provider } = setup();
    scripted(provider, [{ events: answer("One.") }, { events: answer("Two.") }]);
    await send(runtime, { type: "run.start", prompt: "A" });
    await send(runtime, { type: "run.steer", runId: "finished-run", text: "More" });
    expect(userTexts((await openConversation()).items)).toEqual(["A", "More"]);
    expect((await openConversation()).items.some((item) => item.kind === "message" && item.role === "user" && item.delivery === "steer")).toBe(false);
    expect(provider.requests).toHaveLength(2);
  });

  it("keeps queued messages across a background restart; the interrupted run's steers come back as follow-ups, unsent", async () => {
    const before = setup();
    scripted(before.provider, [{ events: answer("Never."), gate: new Promise(() => {}) }]);
    void send(before.runtime, { type: "run.start", prompt: "A" });
    await tick();
    await send(before.runtime, { type: "run.steer", runId: (await before.runtime.getSnapshot()).activeRun!.runId, text: "S" });
    await send(before.runtime, { type: "run.start", prompt: "F" });

    const after = setup();
    await after.runtime.initialize();
    expect(await queueOf(after.runtime)).toEqual(["follow-up:S", "follow-up:F"]);
    expect(after.provider.requests).toHaveLength(0);
    expect((await openConversation()).items.at(-1)).toMatchObject({ role: "assistant", text: expect.stringContaining("Interrupted") });
  });

  it("drops a queued message whose item a restart caught already written, so it is never sent twice", async () => {
    const id = await ensureOpenSession();
    await saveMessageQueue(id, [{ id: "q1", mode: "steer", text: "S", at: 1 }, { id: "q2", mode: "follow-up", text: "F", at: 2 }]);
    await appendConversationItem(id, { id: "q1", kind: "message", role: "user", text: "S", context: null, delivery: "steer", at: 3 });
    const { runtime } = setup();
    await runtime.initialize();
    expect(await queueOf(runtime)).toEqual(["follow-up:F"]);
  });

  it("gives a dispatched follow-up's user message its queued id", async () => {
    const { runtime, provider } = setup();
    const gate = Promise.withResolvers<void>();
    scripted(provider, [{ events: answer("A done."), gate: gate.promise }, { events: answer("B done.") }]);
    const run = send(runtime, { type: "run.start", prompt: "A" });
    await tick();
    await send(runtime, { type: "run.start", prompt: "B" });
    const [queued] = (await runtime.getSnapshot()).queue;
    gate.resolve();
    await run;
    expect((await openConversation()).items.find((item) => item.kind === "message" && item.text === "B")?.id).toBe(queued!.id);
  });

  it("retries a failed turn with the steers it received, without adding user items", async () => {
    const { runtime, provider } = setup();
    const gate = Promise.withResolvers<void>();
    scripted(provider, [{ events: program, gate: gate.promise }, { error: new ProviderStreamError("Rate limited.", "RATE_LIMIT") }, { events: answer("Done.") }]);
    const run = send(runtime, { type: "run.start", prompt: "A" });
    await tick();
    await send(runtime, { type: "run.steer", runId: (await runtime.getSnapshot()).activeRun!.runId, text: "S" });
    gate.resolve();
    await run;
    await send(runtime, { type: "run.retry" });
    expect(provider.requests[2]!.context.messages.map((message) => message.content)).toEqual(["A", "S"]);
    expect(userTexts((await openConversation()).items)).toEqual(["A", "S"]);
    expect((await openConversation()).items.at(-1)).toMatchObject({ role: "assistant", text: "Done." });
  });
});

describe("BackgroundRuntime: usage visibility", () => {
  const PRICED_MODEL = { ...TEST_MODEL, cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 } };
  const cost = (total: number) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total });
  const round = (events: ScriptedProviderEvent[], usage: Partial<ProviderUsage>): ScriptedProviderEvent[] =>
    [...events, { type: "turn.completed", replayState: null, usage }];
  const toolCall: ScriptedProviderEvent = { type: "tool.call", call: { id: "call_1", name: "browser_program", arguments: { source: "return 1;" } } };
  const text = (delta: string): ScriptedProviderEvent => ({ type: "text.delta", delta });

  function setup(rounds: Array<ScriptedProviderEvent[] | Error | "hang">, options: { chatgpt?: ChatGPTAuth } = {}) {
    const hub = new SidebarHub();
    const provider = new FakeProvider();
    provider.getModel = () => PRICED_MODEL;
    let index = 0;
    provider.script = (signal) => {
      const next = rounds[Math.min(index++, rounds.length - 1)]!;
      return { [Symbol.asyncIterator]: async function* () {
        if (next instanceof Error) throw next;
        if (next === "hang") {
          const { promise, reject } = Promise.withResolvers<never>();
          signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          await promise;
        }
        yield* next as ScriptedProviderEvent[];
      } };
    };
    const runtime = new BackgroundRuntime(hub, { provider, tabControllerFactory: unsupportedPageTabControllerFactory, ...options });
    hub.delegate = runtime;
    const port = fakePort();
    hub.handleConnect(port);
    return { runtime, provider, port };
  }
  const usageItems = async () => (await openConversation()).items.flatMap((item) => item.kind === "run-usage" ? [item] : []);

  it("persists a completed run's tokens and estimated cost after its digest, publishes it live, and totals it on the session", async () => {
    await saveOpenAICredential("sk-test");
    const { runtime, provider, port } = setup([
      round([toolCall], { input: 900, cacheRead: 0, cacheWrite: 100, output: 100, reasoning: 40, cost: cost(0.003) }),
      round([text("Done.")], { input: 100, cacheRead: 896, output: 50, cost: cost(0.001) }),
      round([text("Again.")], { input: 10, output: 5, cost: cost(0.0001) }),
    ]);
    await runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Hello" });
    const items = (await openConversation()).items;
    expect(items.map((item) => item.kind)).toEqual(["message", "tool-call", "tool-result", "message", "run-digest", "run-usage"]);
    const runId = port.received.find((event) => event.type === "run.started")!.runId!;
    const expected = {
      version: 1, runId, billing: "api-key", modelId: "gpt-5.6-terra", responses: 2,
      input: 1000, cacheRead: 896, cacheWrite: 100, output: 150, reasoning: 40, costUsd: expect.closeTo(0.004, 10),
    };
    expect(items.at(-1)).toEqual({ id: `usage-${runId}`, kind: "run-usage", usage: expected, at: expect.any(Number) });
    const live = port.received.filter((event) => event.type === "run.usage");
    expect(live.map((event) => event.type === "run.usage" && event.payload.usage.responses)).toEqual([1, 2]);
    expect(port.received.findIndex((event) => event.type === "run.usage")).toBeLessThan(port.received.findIndex((event) => event.type === "run.completed"));
    expect((await listSessions())[0]?.usage).toEqual({
      responses: 2, input: 1996, cacheRead: 896, output: 150, reasoning: 40, costUsd: expect.closeTo(0.004, 10), pricedRuns: 1, planRuns: 0, unpricedRuns: 0,
    });

    // Usage items never reach the model, so later requests replay history unchanged.
    await runtime.handleCommand({ v: 1, id: "2", type: "run.start", prompt: "Again" });
    expect(JSON.stringify(provider.requests[2]!.context.messages)).not.toMatch(/run-usage|costUsd|usage-/);
    expect(provider.requests[2]!.context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "user"]);
    // Totals keep accumulating, and a restarted background lists them from storage.
    const restarted = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), tabControllerFactory: unsupportedPageTabControllerFactory });
    await restarted.initialize();
    const { sessions } = await restarted.handleCommand({ v: 1, id: "list", type: "session.list" });
    expect(sessions[0]?.usage).toMatchObject({ responses: 3, input: 2006, output: 155, costUsd: expect.closeTo(0.0041, 10), pricedRuns: 2 });
  });

  it("records plan usage with no dollars on the ChatGPT path, and tokens only for a model without a bundled price", async () => {
    const chatgpt = new ChatGPTAuth();
    vi.spyOn(chatgpt, "status").mockResolvedValue({ connected: true, email: "user@example.test", signInAgain: false });
    vi.spyOn(chatgpt, "models").mockResolvedValue(null);
    vi.spyOn(chatgpt, "getAuth").mockResolvedValue({ providerId: "openai", method: "chatgpt", secret: "token" });
    const plan = setup([round([text("Hi.")], { input: 500, output: 20, cost: cost(0.5) })], { chatgpt });
    await plan.runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Hello" });
    expect((await usageItems())[0]?.usage).toMatchObject({ billing: "chatgpt", input: 500, output: 20, costUsd: null });
    expect((await listSessions())[0]?.usage).toMatchObject({ planRuns: 1, pricedRuns: 0, costUsd: 0 });

    fakeBrowser.reset();
    await saveOpenAICredential("sk-test");
    const unpriced = setup([round([text("Hi.")], { input: 500, output: 20 })]);
    unpriced.provider.getModel = () => TEST_MODEL;
    await unpriced.runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Hello" });
    expect((await usageItems())[0]?.usage).toMatchObject({ billing: "api-key", input: 500, costUsd: null });
    expect((await listSessions())[0]?.usage).toMatchObject({ unpricedRuns: 1, pricedRuns: 0 });
  });

  it("persists usage for failed and cancelled runs, sums a retried turn's runs, and records nothing for a run without tokens", async () => {
    await saveOpenAICredential("sk-test");
    const { runtime, port } = setup([
      round([toolCall], { input: 300, output: 30, cost: cost(0.001) }),
      new ProviderStreamError("Rate limited.", "RATE_LIMIT"),
      round([text("Done.")], { input: 200, output: 20, cost: cost(0.002) }),
      round([toolCall], { input: 50, output: 5, cost: cost(0.0005) }),
      "hang",
    ]);
    await runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Try" });
    expect(port.received.some((event) => event.type === "run.failed")).toBe(true);
    await runtime.handleCommand({ v: 1, id: "2", type: "run.retry" });
    expect((await usageItems()).map((item) => [item.usage.input, item.usage.costUsd])).toEqual([[300, 0.001], [200, 0.002]]);
    const turns = buildTurns((await openConversation()).items, false);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.usage).toMatchObject({ input: 500, output: 50, costUsd: expect.closeTo(0.003, 10), pricedRuns: 2 });

    const run = runtime.handleCommand({ v: 1, id: "3", type: "run.start", prompt: "Go" });
    await tick();
    await runtime.handleCommand({ v: 1, id: "4", type: "run.cancel", runId: (await runtime.getSnapshot()).activeRun!.runId });
    await run;
    expect((await usageItems()).map((item) => item.usage.input)).toEqual([300, 200, 50]);
    expect((await listSessions())[0]?.usage).toMatchObject({ input: 550, pricedRuns: 3 });

    await saveOpenAICredential("sk-test");
    const silent = setup([[text("Hi.")]]);
    await silent.runtime.handleCommand({ v: 1, id: "5", type: "run.start", prompt: "Quiet" });
    expect(await usageItems()).toHaveLength(3);
  });

  it("checkpoints usage during a run, so a restart persists what the interrupted run had used", async () => {
    await saveOpenAICredential("sk-test");
    const { runtime } = setup([round([toolCall], { input: 700, output: 70, cost: cost(0.002) }), "hang"]);
    void runtime.handleCommand({ v: 1, id: "1", type: "run.start", prompt: "Long" });
    // Wait for the checkpoint itself, not a fixed number of ticks: on a slow
    // machine the first round's usage lands after `tick()` returns.
    await vi.waitFor(async () => {
      const { runCheckpoint } = await fakeBrowser.storage.local.get("runCheckpoint") as { runCheckpoint?: { usage: unknown } };
      expect(runCheckpoint?.usage).toMatchObject({ input: 700, responses: 1 });
    });
    const snapshot = await runtime.getSnapshot();
    expect(snapshot.activeRun?.usage).toMatchObject({ input: 700, responses: 1 });
    const { runCheckpoint } = await fakeBrowser.storage.local.get("runCheckpoint") as { runCheckpoint: { usage: unknown } };
    expect(runCheckpoint.usage).toEqual(snapshot.activeRun?.usage);

    // The background dies; the next one recovers the run from its checkpoint.
    const restarted = new BackgroundRuntime(new SidebarHub(), { provider: new FakeProvider(), tabControllerFactory: unsupportedPageTabControllerFactory });
    await restarted.initialize();
    const runId = snapshot.activeRun!.runId;
    expect((await openConversation()).items.at(-1)).toMatchObject({ id: `usage-${runId}`, kind: "run-usage", usage: { input: 700, costUsd: 0.002 } });
    expect((await listSessions())[0]?.usage).toMatchObject({ input: 700, pricedRuns: 1 });
  });
});
