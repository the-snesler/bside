import { describe, expect, it, vi } from "vitest";
import { TabBindings, type ChatTabValues } from "@/lib/background/tab-chats";
import type { ChatTabValueV1 } from "@/lib/background/tab-controller";

/** Tab values as Firefox keeps them, with each call recorded in order. */
function fakeValues(initial: Record<number, unknown> = {}) {
  const values = new Map<number, unknown>(Object.entries(initial).map(([id, value]) => [Number(id), value]));
  const calls: string[] = [];
  const gate = { hold: null as Promise<void> | null };
  const api: ChatTabValues = {
    chatTabValue: vi.fn(async (tabId: number) => {
      if (!values.has(tabId)) return undefined;
      const value = values.get(tabId) as ChatTabValueV1;
      return value?.v === 1 && typeof value.sessionId === "string" ? value : null;
    }),
    setChatTabValue: vi.fn(async (tabId: number, value: ChatTabValueV1) => {
      if (gate.hold) await gate.hold;
      calls.push(`set ${tabId} ${value.sessionId}`); values.set(tabId, value);
    }),
    removeChatTabValue: vi.fn(async (tabId: number) => { calls.push(`remove ${tabId}`); values.delete(tabId); }),
  };
  return { values, calls, api, gate };
}

describe("TabBindings", () => {
  it("binds, rebinds, and unbinds tabs, writing each change to the tab's value in order", async () => {
    const { values, calls, api, gate } = fakeValues();
    const bindings = new TabBindings(() => api);
    const held = Promise.withResolvers<void>();
    gate.hold = held.promise;
    expect(bindings.bind(1, "chat-a")).toBe(true);
    expect(bindings.bind(1, "chat-a")).toBe(false);
    bindings.bind(1, "chat-b");
    bindings.unbind(1);
    expect(bindings.sessionOf(1)).toBeUndefined();
    // The remove waits for the slower writes before it.
    gate.hold = null; held.resolve();
    await bindings.settled();
    expect(calls).toEqual(["set 1 chat-a", "set 1 chat-b", "remove 1"]);
    expect(values.has(1)).toBe(false);
    // Unbinding a tab with no binding writes nothing.
    bindings.unbind(2);
    await bindings.settled();
    expect(calls).toHaveLength(3);
  });

  it("drops every tab of deleted chats, and forgets a closed tab without writing", async () => {
    const { calls, api } = fakeValues();
    const bindings = new TabBindings(() => api);
    bindings.bind(1, "gone"); bindings.bind(2, "gone"); bindings.bind(3, "kept");
    await bindings.settled();
    bindings.dropSessions(["gone"]);
    bindings.forget(3);
    await bindings.settled();
    expect([1, 2, 3].map((id) => bindings.sessionOf(id))).toEqual([undefined, undefined, undefined]);
    expect(calls.slice(3)).toEqual(["remove 1", "remove 2"]);
  });

  it("restores a value naming a chat that exists, and removes stale and malformed ones", async () => {
    const { values, api } = fakeValues({ 1: { v: 1, sessionId: "live" }, 2: { v: 1, sessionId: "deleted" }, 3: { v: 7 }, 4: undefined });
    values.delete(4);
    const bindings = new TabBindings(() => api);
    const exists = async (id: string) => id === "live";
    expect(await bindings.restore(1, exists)).toBe("live");
    expect(await bindings.restore(2, exists)).toBeUndefined();
    expect(await bindings.restore(3, exists)).toBeUndefined();
    expect(await bindings.restore(4, exists)).toBeUndefined();
    await bindings.settled();
    expect([...values.keys()]).toEqual([1]);
    expect(api.removeChatTabValue).toHaveBeenCalledTimes(2);
  });

  it("keeps a binding made while the tab's value was being read", async () => {
    const { api } = fakeValues({ 1: { v: 1, sessionId: "older" } });
    const bindings = new TabBindings(() => api);
    const restoring = bindings.restore(1, async () => { bindings.bind(1, "newer"); return true; });
    expect(await restoring).toBe("newer");
    expect(bindings.sessionOf(1)).toBe("newer");
  });

  it("survives a failed write", async () => {
    const { api } = fakeValues();
    vi.mocked(api.setChatTabValue).mockRejectedValueOnce(new Error("Invalid tab ID"));
    const bindings = new TabBindings(() => api);
    bindings.bind(1, "chat");
    bindings.bind(2, "chat");
    await bindings.settled();
    expect(api.setChatTabValue).toHaveBeenCalledTimes(2);
    expect(bindings.sessionOf(1)).toBe("chat");
  });
});
