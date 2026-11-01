import { afterEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "wxt/browser";
import { ENDED_RUN_GRACE_MS, MAX_ENDED_RUNS, MAX_REPLAY_EVENTS_PER_RUN, MAX_REPLAY_EVENTS_TOTAL, SidebarHub } from "@/lib/background/sidebar-hub";
import type { RuntimeSnapshot, SidebarEvent } from "@/lib/protocol";

type FakePort = Browser.runtime.Port & { received: SidebarEvent[]; send(message: unknown): Promise<void> };

function fakePort(): FakePort {
  const received: SidebarEvent[] = [];
  const listeners: Array<(message: unknown) => unknown> = [];
  return {
    name: "agent-sidebar:v1",
    postMessage: (message: unknown) => received.push(message as SidebarEvent),
    onMessage: { addListener: (listener: (message: unknown) => unknown) => listeners.push(listener), removeListener: () => {} },
    onDisconnect: { addListener: () => {} },
    disconnect: () => {},
    received,
    send: async (message: unknown) => { await Promise.all(listeners.map((listener) => listener(message))); },
  } as unknown as FakePort;
}

/** A hub whose delegate shows every view the session "open" and answers with a minimal snapshot of it; only the hub's own behavior is under test. */
function hubWithSnapshot(): SidebarHub {
  const hub = new SidebarHub();
  hub.delegate = {
    getSnapshots: async (views) => views.map((view) => ({ conversation: { id: view.sessionId }, runs: [] }) as unknown as RuntimeSnapshot),
    attachView: async (view) => { view.sessionId = "open"; },
    handleCommand: async () => {},
  };
  return hub;
}

/** A fresh sidebar connection, attached as the view of `windowId`; drops the `page.attached` every attached view gets. */
async function connect(hub: SidebarHub, windowId = 1): Promise<FakePort> {
  const port = fakePort();
  hub.handleConnect(port);
  await port.send({ v: 1, id: crypto.randomUUID(), type: "view.attach", windowId });
  port.received.length = 0;
  return port;
}

const subscribe = (port: FakePort, lastSeq: Record<string, number> | null) =>
  port.send({ v: 1, id: crypto.randomUUID(), type: "state.subscribe", lastSeq });

const delta = (hub: SidebarHub, runId: string, text: string) => hub.publishRunEvent(runId, "assistant.delta", { delta: text });
const seqsOf = (events: SidebarEvent[]) => events.map((event) => [event.runId, event.seq, event.type === "assistant.delta" ? event.payload.delta : event.type]);

afterEach(() => {
  vi.useRealTimers();
});

describe("SidebarHub: per-run sequencing", () => {
  it("numbers two interleaved runs independently and stamps each event with its own run's session", async () => {
    const hub = hubWithSnapshot();
    const port = await connect(hub);
    hub.startRun("a", "chat-a");
    hub.startRun("b", "chat-b");
    delta(hub, "a", "a1");
    delta(hub, "b", "b1");
    delta(hub, "a", "a2");
    delta(hub, "b", "b2");
    delta(hub, "b", "b3");
    expect(seqsOf(port.received)).toEqual([["a", 1, "a1"], ["b", 1, "b1"], ["a", 2, "a2"], ["b", 2, "b2"], ["b", 3, "b3"]]);
    expect(port.received.map((event) => event.conversationId)).toEqual(["chat-a", "chat-b", "chat-a", "chat-b", "chat-b"]);
    expect(hub.lastSeq("a")).toBe(2);
    expect(hub.lastSeq("b")).toBe(3);
    expect(hub.lastSeq("never")).toBe(0);
  });

  it("drops events of a run that was never registered, and keeps a registered run's seqs when it is registered again", async () => {
    const hub = hubWithSnapshot();
    const port = await connect(hub);
    delta(hub, "ghost", "lost");
    expect(port.received).toEqual([]);
    hub.startRun("a", "chat-a");
    delta(hub, "a", "a1");
    // The scheduled-run failure path registers again before its terminal event.
    hub.startRun("a", "chat-a");
    hub.publishRunEvent("a", "run.failed", { code: "PROTOCOL_ERROR", message: "Stopped.", retryable: false, phase: "persistence" });
    expect(port.received.map((event) => [event.runId, event.seq, event.type])).toEqual([["a", 1, "assistant.delta"], ["a", 2, "run.failed"]]);
    // Nothing follows a terminal event.
    delta(hub, "a", "late");
    expect(port.received).toHaveLength(2);
  });

  it("gives every non-run event seq 0 without disturbing run seqs or replays", async () => {
    const hub = hubWithSnapshot();
    const port = await connect(hub);
    hub.startRun("a", "chat-a");
    delta(hub, "a", "a1");
    hub.publishAsk(1, null);
    hub.publishQueue("chat-a", []);
    hub.publishSessions([]);
    hub.publishPermissionMode("auto");
    hub.publishAgentTabs({ bySession: {}, watching: null, takenOver: false });
    hub.focusComposer(1);
    hub.contentAccepted(port, ["c1"]);
    delta(hub, "a", "a2");
    expect(port.received.filter((event) => event.runId === null).map((event) => event.seq)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(seqsOf(port.received.filter((event) => event.runId !== null))).toEqual([["a", 1, "a1"], ["a", 2, "a2"]]);

    const back = await connect(hub);
    await subscribe(back, { a: 0 });
    expect(seqsOf(back.received)).toEqual([["a", 1, "a1"], ["a", 2, "a2"]]);
  });
});

describe("SidebarHub: reconnect replay", () => {
  it("replays each run's gap independently, in publication order", async () => {
    const hub = hubWithSnapshot();
    hub.startRun("a", "chat-a");
    hub.startRun("b", "chat-b");
    delta(hub, "a", "a1");
    delta(hub, "b", "b1");
    delta(hub, "b", "b2");
    delta(hub, "a", "a2");
    delta(hub, "b", "b3");
    delta(hub, "a", "a3");

    const port = await connect(hub);
    await subscribe(port, { a: 2, b: 1 });
    expect(seqsOf(port.received)).toEqual([["b", 2, "b2"], ["b", 3, "b3"], ["a", 3, "a3"]]);
    expect(port.received.some((event) => event.type === "state.snapshot")).toBe(false);

    // A sidebar that is up to date gets nothing.
    const current = await connect(hub);
    await subscribe(current, { a: 3, b: 3 });
    expect(current.received).toEqual([]);
  });

  it("replays a run the sidebar did not know yet from its start", async () => {
    const hub = hubWithSnapshot();
    hub.startRun("a", "chat-a");
    delta(hub, "a", "a1");
    hub.startRun("b", "chat-b");
    delta(hub, "b", "b1");
    const port = await connect(hub);
    await subscribe(port, { a: 1 });
    expect(seqsOf(port.received)).toEqual([["b", 1, "b1"]]);
  });

  it("sends a full snapshot when one run's gap is past its buffer, even though another run's is not", async () => {
    const hub = hubWithSnapshot();
    hub.startRun("a", "chat-a");
    hub.startRun("b", "chat-b");
    delta(hub, "b", "b1");
    for (let index = 1; index <= MAX_REPLAY_EVENTS_PER_RUN + 1; index += 1) delta(hub, "a", `a${index}`);
    delta(hub, "b", "b2");

    const port = await connect(hub);
    await subscribe(port, { a: 0, b: 1 });
    expect(port.received.map((event) => event.type)).toEqual(["state.snapshot"]);
    expect(port.received[0]!.seq).toBe(0);

    // The oldest event still buffered is a2, so a sidebar that applied a1 can still catch up.
    const close = await connect(hub);
    await subscribe(close, { a: 1, b: 1 });
    expect(close.received).toHaveLength(MAX_REPLAY_EVENTS_PER_RUN + 1);
    expect(close.received[0]).toMatchObject({ runId: "a", seq: 2 });
    expect(close.received.at(-1)).toMatchObject({ runId: "b", seq: 2 });
  });

  it("bounds the events buffered across all runs, dropping the oldest", async () => {
    const hub = hubWithSnapshot();
    const runs = Math.ceil(MAX_REPLAY_EVENTS_TOTAL / MAX_REPLAY_EVENTS_PER_RUN) + 1;
    for (let run = 0; run < runs; run += 1) {
      hub.startRun(`r${run}`, `chat-${run}`);
      for (let index = 1; index <= MAX_REPLAY_EVENTS_PER_RUN; index += 1) delta(hub, `r${run}`, `${run}:${index}`);
    }
    const all = Object.fromEntries(Array.from({ length: runs }, (_, run) => [`r${run}`, 0]));
    const port = await connect(hub);
    await subscribe(port, all);
    expect(port.received.map((event) => event.type)).toEqual(["state.snapshot"]);

    // The newest runs are still fully replayable; the oldest run's events are gone.
    const latest = Object.fromEntries(Array.from({ length: runs }, (_, run) => [`r${run}`, run === 0 ? MAX_REPLAY_EVENTS_PER_RUN : 0]));
    const newest = await connect(hub);
    await subscribe(newest, latest);
    expect(newest.received).toHaveLength(MAX_REPLAY_EVENTS_TOTAL);
    expect(newest.received.every((event) => event.type === "assistant.delta")).toBe(true);
  });

  it("keeps an ended run replayable for a grace period, then forgets it", async () => {
    vi.useFakeTimers();
    const hub = hubWithSnapshot();
    hub.startRun("a", "chat-a");
    delta(hub, "a", "a1");
    hub.publishRunEvent("a", "run.completed", { messageId: "m1" });

    const port = await connect(hub);
    await subscribe(port, { a: 1 });
    expect(port.received.map((event) => [event.seq, event.type])).toEqual([[2, "run.completed"]]);

    // A sidebar that never knew the run cannot tell from a replay what it ended with.
    const stranger = await connect(hub);
    await subscribe(stranger, {});
    expect(stranger.received.map((event) => event.type)).toEqual(["state.snapshot"]);

    vi.advanceTimersByTime(ENDED_RUN_GRACE_MS + 1);
    const late = await connect(hub);
    await subscribe(late, { a: 1 });
    expect(late.received.map((event) => event.type)).toEqual(["state.snapshot"]);
    expect(hub.lastSeq("a")).toBe(0);
  });

  it("forgets the oldest ended runs past MAX_ENDED_RUNS", async () => {
    const hub = hubWithSnapshot();
    for (let run = 0; run <= MAX_ENDED_RUNS; run += 1) {
      hub.startRun(`r${run}`, `chat-${run}`);
      hub.publishRunEvent(`r${run}`, "run.completed", { messageId: `m${run}` });
    }
    expect(hub.lastSeq("r0")).toBe(0);
    expect(hub.lastSeq("r1")).toBe(1);
    expect(hub.lastSeq(`r${MAX_ENDED_RUNS}`)).toBe(1);
  });

  it("answers a null lastSeq, an unknown run, or a seq ahead of the run with a snapshot", async () => {
    const hub = hubWithSnapshot();
    hub.startRun("a", "chat-a");
    delta(hub, "a", "a1");
    for (const lastSeq of [null, { a: 1, gone: 3 }, { a: 5 }] as Array<Record<string, number> | null>) {
      const port = await connect(hub);
      await subscribe(port, lastSeq);
      expect(port.received.map((event) => [event.type, event.seq])).toEqual([["state.snapshot", 0]]);
    }
  });
});

describe("SidebarHub: views", () => {
  /** A hub whose delegate records what it is asked and shows each window's view the session named for it. */
  function recordingHub(sessionFor: (windowId: number) => string = (windowId) => `chat-${windowId}`) {
    const hub = new SidebarHub();
    const asked: string[][] = [];
    const detached: string[] = [];
    const released: object[] = [];
    const commands: Array<{ type: string; owner: unknown }> = [];
    hub.delegate = {
      getSnapshots: async (views) => {
        asked.push(views.map((view) => view.sessionId));
        return views.map((view) => ({ conversation: { id: view.sessionId }, runs: [] }) as unknown as RuntimeSnapshot);
      },
      attachView: async (view) => { view.sessionId = sessionFor(view.windowId); },
      detachView: (view) => { detached.push(view.sessionId); },
      releaseOwner: (owner) => { released.push(owner); },
      handleCommand: async (command, owner) => { commands.push({ type: command.type, owner }); },
    };
    return { hub, asked, detached, released, commands };
  }
  const snapshotsOf = (port: FakePort) => port.received.filter((event) => event.type === "state.snapshot").map((event) => event.conversationId);
  const tab = (id: number, windowId: number, url = `https://example.com/${id}`) => ({ id, windowId, url, title: `Tab ${id}`, active: true }) as Browser.tabs.Tab;

  it("answers a Port nothing until it attaches, then its waiting commands in order", async () => {
    const { hub, commands } = recordingHub();
    const port = fakePort();
    hub.handleConnect(port);
    const subscribed = port.send({ v: 1, id: "s", type: "state.subscribe", lastSeq: null });
    const listed = port.send({ v: 1, id: "l", type: "session.list" });
    await Promise.resolve();
    await hub.broadcastSnapshot();
    expect(port.received).toEqual([]);
    expect(commands).toEqual([]);
    expect(hub.views()).toEqual([]);

    await port.send({ v: 1, id: "a", type: "view.attach", windowId: 7 });
    await Promise.all([subscribed, listed]);
    expect(snapshotsOf(port)).toEqual(["chat-7"]);
    expect(commands).toEqual([{ type: "session.list", owner: port }]);
    expect(hub.views()).toEqual([{ kind: "sidebar", windowId: 7, sessionId: "chat-7", tabId: null }]);
    expect(hub.viewOf(port)).toEqual(hub.views()[0]);
    // A second attach is ignored: a Port is one view for its lifetime.
    await port.send({ v: 1, id: "again", type: "view.attach", windowId: 8 });
    expect(hub.views()).toEqual([{ kind: "sidebar", windowId: 7, sessionId: "chat-7", tabId: null }]);
  });

  it("refuses a malformed attach and never answers a Port whose attach failed", async () => {
    const { hub, commands } = recordingHub(() => "");
    const port = fakePort();
    hub.handleConnect(port);
    await port.send({ v: 1, id: "bad", type: "view.attach", windowId: -1 });
    expect(hub.views()).toEqual([]);
    await port.send({ v: 1, id: "a", type: "view.attach", windowId: 3 });
    await port.send({ v: 1, id: "s", type: "state.subscribe", lastSeq: null });
    expect(port.received).toEqual([]);
    expect(commands).toEqual([]);
  });

  it("builds each view's own snapshot in one call and sends it only to that view", async () => {
    const { hub, asked } = recordingHub();
    const one = await connect(hub, 1);
    const two = await connect(hub, 2);
    asked.length = 0;
    await hub.broadcastSnapshot();
    expect(asked).toEqual([["chat-1", "chat-2"]]);
    expect(snapshotsOf(one)).toEqual(["chat-1"]);
    expect(snapshotsOf(two)).toEqual(["chat-2"]);
  });

  it("sends snapshots only to the views named, such as those that followed their window's tab to another chat", async () => {
    const { hub, asked } = recordingHub();
    const one = await connect(hub, 1);
    const two = await connect(hub, 2);
    asked.length = 0;
    hub.viewOf(two)!.sessionId = "chat-2b";
    await hub.broadcastSnapshot([hub.viewOf(two)!]);
    expect(asked).toEqual([["chat-2b"]]);
    expect(snapshotsOf(one)).toEqual([]);
    expect(snapshotsOf(two)).toEqual(["chat-2b"]);
  });

  it("sends each window's views that window's active page, and only when it changes", async () => {
    const query = vi.spyOn(browser.tabs, "query").mockResolvedValue([tab(10, 1), tab(20, 2)] as never);
    try {
      const { hub } = recordingHub();
      const one = fakePort(); hub.handleConnect(one);
      await one.send({ v: 1, id: "a", type: "view.attach", windowId: 1 });
      const two = fakePort(); hub.handleConnect(two);
      await two.send({ v: 1, id: "b", type: "view.attach", windowId: 2 });
      const pages = (port: FakePort) => port.received.filter((event) => event.type === "page.attached").map((event) => (event.payload as { tabId: number } | null)?.tabId ?? null);
      expect(pages(one)).toEqual([10]);
      expect(pages(two)).toEqual([20]);
      expect(hub.currentAttachment(1)?.tabId).toBe(10);

      query.mockResolvedValue([tab(10, 1), tab(21, 2, "about:addons")] as never);
      await hub.refreshAttachment();
      expect(pages(one)).toEqual([10]);
      expect(pages(two)).toEqual([20, null]);
      expect(query).toHaveBeenLastCalledWith({ active: true });
    } finally { query.mockRestore(); }
  });

  it("sends the Ask chip and composer focus only to their window's views", async () => {
    const { hub } = recordingHub();
    const one = await connect(hub, 1);
    const two = await connect(hub, 2);
    hub.publishAsk(2, null);
    hub.focusComposer(2);
    hub.focusComposer(null);
    expect(one.received).toEqual([]);
    expect(two.received.map((event) => event.type)).toEqual(["ask.changed", "composer.focus"]);
    // Every Port, attached or not, still gets the shared events.
    const waiting = fakePort(); hub.handleConnect(waiting);
    hub.publishSessions([]);
    expect([one, two, waiting].map((port) => port.received.at(-1)?.type)).toEqual(["session.listed", "session.listed", "session.listed"]);
  });

  it("detaches a view and releases what its Port prepared when the Port closes", async () => {
    const { hub, detached, released } = recordingHub();
    const port = fakePort();
    let disconnect!: () => void;
    Object.assign(port, { onDisconnect: { addListener: (listener: () => void) => { disconnect = listener; } } });
    hub.handleConnect(port);
    await port.send({ v: 1, id: "a", type: "view.attach", windowId: 4 });
    disconnect();
    expect(detached).toEqual(["chat-4"]);
    expect(released).toEqual([port]);
    expect(hub.views()).toEqual([]);
    expect(hub.viewOf(port)).toBeNull();
  });
});
