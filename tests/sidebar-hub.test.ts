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

/** A hub whose delegate answers with a minimal snapshot; only the hub's own behavior is under test. */
function hubWithSnapshot(): SidebarHub {
  const hub = new SidebarHub();
  hub.delegate = {
    getSnapshot: async () => ({ conversation: { id: "open" }, runs: [] }) as unknown as RuntimeSnapshot,
    handleCommand: async () => {},
  };
  return hub;
}

/** A fresh sidebar connection; drops the `page.attached` every connection gets. */
function connect(hub: SidebarHub): FakePort {
  const port = fakePort();
  hub.handleConnect(port);
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
  it("numbers two interleaved runs independently and stamps each event with its own run's session", () => {
    const hub = hubWithSnapshot();
    const port = connect(hub);
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

  it("drops events of a run that was never registered, and keeps a registered run's seqs when it is registered again", () => {
    const hub = hubWithSnapshot();
    const port = connect(hub);
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
    const port = connect(hub);
    hub.startRun("a", "chat-a");
    delta(hub, "a", "a1");
    hub.publishAsk(null);
    hub.publishQueue("chat-a", []);
    hub.publishSessions([]);
    hub.publishPermissionMode("auto");
    hub.publishAgentTabs({ bySession: {}, watching: null, takenOver: false });
    hub.focusComposer();
    hub.contentAccepted(port, ["c1"]);
    delta(hub, "a", "a2");
    expect(port.received.filter((event) => event.runId === null).map((event) => event.seq)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(seqsOf(port.received.filter((event) => event.runId !== null))).toEqual([["a", 1, "a1"], ["a", 2, "a2"]]);

    const back = connect(hub);
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

    const port = connect(hub);
    await subscribe(port, { a: 2, b: 1 });
    expect(seqsOf(port.received)).toEqual([["b", 2, "b2"], ["b", 3, "b3"], ["a", 3, "a3"]]);
    expect(port.received.some((event) => event.type === "state.snapshot")).toBe(false);

    // A sidebar that is up to date gets nothing.
    const current = connect(hub);
    await subscribe(current, { a: 3, b: 3 });
    expect(current.received).toEqual([]);
  });

  it("replays a run the sidebar did not know yet from its start", async () => {
    const hub = hubWithSnapshot();
    hub.startRun("a", "chat-a");
    delta(hub, "a", "a1");
    hub.startRun("b", "chat-b");
    delta(hub, "b", "b1");
    const port = connect(hub);
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

    const port = connect(hub);
    await subscribe(port, { a: 0, b: 1 });
    expect(port.received.map((event) => event.type)).toEqual(["state.snapshot"]);
    expect(port.received[0]!.seq).toBe(0);

    // The oldest event still buffered is a2, so a sidebar that applied a1 can still catch up.
    const close = connect(hub);
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
    const port = connect(hub);
    await subscribe(port, all);
    expect(port.received.map((event) => event.type)).toEqual(["state.snapshot"]);

    // The newest runs are still fully replayable; the oldest run's events are gone.
    const latest = Object.fromEntries(Array.from({ length: runs }, (_, run) => [`r${run}`, run === 0 ? MAX_REPLAY_EVENTS_PER_RUN : 0]));
    const newest = connect(hub);
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

    const port = connect(hub);
    await subscribe(port, { a: 1 });
    expect(port.received.map((event) => [event.seq, event.type])).toEqual([[2, "run.completed"]]);

    // A sidebar that never knew the run cannot tell from a replay what it ended with.
    const stranger = connect(hub);
    await subscribe(stranger, {});
    expect(stranger.received.map((event) => event.type)).toEqual(["state.snapshot"]);

    vi.advanceTimersByTime(ENDED_RUN_GRACE_MS + 1);
    const late = connect(hub);
    await subscribe(late, { a: 1 });
    expect(late.received.map((event) => event.type)).toEqual(["state.snapshot"]);
    expect(hub.lastSeq("a")).toBe(0);
  });

  it("forgets the oldest ended runs past MAX_ENDED_RUNS", () => {
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
      const port = connect(hub);
      await subscribe(port, lastSeq);
      expect(port.received.map((event) => [event.type, event.seq])).toEqual([["state.snapshot", 0]]);
    }
  });
});
