import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceKey } from "@/lib/background/device-key";
import { MemoryDeviceKeyStore } from "@/tests/helpers/memory-key-store";
import {
  appendConversationItem,
  CONVERSATION_CHUNK_SIZE,
  createSession,
  deleteAllSessions,
  deleteOpenAICredential,
  deleteSession,
  ensureOpenSession,
  getAppSettings,
  getConversation,
  getCredentialStatus,
  getOpenAICredential,
  getOpenSessionId,
  getChatGPTCredential,
  getHistorySettings,
  getRunCheckpoint,
  loadMessageQueue,
  saveMessageQueue,
  hasChatGPTSignInNotice,
  listSessions,
  loadWorkspaceFiles,
  migrateConversation,
  migrateCredentials,
  pruneSessions,
  recoverInterruptedRun,
  saveAppSettings,
  saveHistorySettings,
  saveOpenAICredential,
  saveRunCheckpoint,
  touchSession,
  updateSession,
  workspaceStore,
} from "@/lib/storage";
import { titleFromPrompt, type ConversationItem } from "@/lib/domain/conversation";
import { EMPTY_USAGE, type RunUsageV1 } from "@/lib/domain/usage";

const message = (id: string, text = id): ConversationItem => ({ id, kind: "message", role: "assistant", text, at: 1 });
const prompt = (id: string, text: string): ConversationItem => ({ id, kind: "message", role: "user", text, context: null, at: 1 });

/** A session with `count` items and one scratch file in its last workspace slot. */
async function sessionWith(count: number): Promise<string> {
  const { id } = await createSession();
  for (let i = 0; i < count; i += 1) await appendConversationItem(id, message(`m${i}`));
  await workspaceStore(id).write({ slot: 63, path: "/workspace/notes.md", content: "Scratch" });
  return id;
}

function runUsage(patch: Partial<RunUsageV1> = {}): RunUsageV1 {
  return { version: 1, runId: "run-1", billing: "api-key", modelId: "gpt-5.6-terra", responses: 1, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0, ...patch };
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe("storage: defaults", () => {
  it("returns default app settings when nothing is stored", async () => {
    const settings = await getAppSettings();
    expect(settings).toEqual({
      version: 1,
      providerId: "openai",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
    });
  });

  it("lists no sessions, then opens a fresh empty one, when nothing is stored", async () => {
    expect(await listSessions()).toEqual([]);
    const id = await ensureOpenSession();
    expect(id).toMatch(/^[\da-f-]{36}$/);
    expect(await ensureOpenSession()).toBe(id);
    expect(await getOpenSessionId()).toBe(id);
    expect(await getConversation(id)).toMatchObject({ id, title: "", titleSource: "prompt", pinned: false, itemCount: 0, items: [] });
  });

  it("returns unconfigured credential status when nothing is stored", async () => {
    const status = await getCredentialStatus();
    expect(status).toEqual({ configured: false, maskedSuffix: null });
  });

  it("returns null run checkpoint when nothing is stored", async () => {
    expect(await getRunCheckpoint()).toBeNull();
  });
});

describe("storage: malformed-version rejection", () => {
  it("resets app settings with a malformed version to defaults", async () => {
    await browser.storage.local.set({ appSettings: { version: 2, providerId: "openai" } });
    const settings = await getAppSettings();
    expect(settings.version).toBe(1);
    expect(settings.modelId).toBe("gpt-5.6-terra");
    // Corrupt value is repaired in place, not just masked on read.
    const raw = await browser.storage.local.get("appSettings");
    expect(raw.appSettings).toEqual(settings);
  });

  it("discards a credential with a missing apiKey field", async () => {
    await browser.storage.local.set({ openaiCredential: { version: 1, updatedAt: 1 } });
    expect(await getOpenAICredential()).toBeNull();
    expect(await getCredentialStatus()).toEqual({ configured: false, maskedSuffix: null });
  });

  it("discards a run checkpoint with an unknown status", async () => {
    await browser.storage.local.set({
      runCheckpoint: {
        version: 1,
        runId: "r1",
        status: "not-a-real-status",
        partialAssistantText: "",
        lastSeq: 0,
        updatedAt: 1,
      },
    });
    expect(await getRunCheckpoint()).toBeNull();
  });

  it("discards a run checkpoint with an invalid session id", async () => {
    await saveRunCheckpoint({ version: 2, runId: "r1", sessionId: "../escape", status: "running", partialAssistantText: "", usage: null, lastSeq: 0, updatedAt: 1 });
    expect(await getRunCheckpoint()).toBeNull();
  });
});

describe("storage: credential non-exposure", () => {
  it("never includes the raw key in the public status", async () => {
    await saveOpenAICredential("sk-super-secret-value-0000");
    const status = await getCredentialStatus();
    expect(status.configured).toBe(true);
    expect(status.maskedSuffix).toBe("0000");
    expect(Object.keys(status)).toEqual(["configured", "maskedSuffix"]);
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("clears configured status after deleting the credential", async () => {
    await saveOpenAICredential("sk-super-secret-value-0000");
    await deleteOpenAICredential();
    expect(await getCredentialStatus()).toEqual({ configured: false, maskedSuffix: null });
  });
});

describe("storage: API key encryption at rest", () => {
  it("round-trips the key through a sealed v2 record with no plaintext in storage.local", async () => {
    await saveOpenAICredential("sk-super-secret-value-0000");
    const stored = await browser.storage.local.get(null);
    expect(stored.openaiCredential).toMatchObject({ version: 2, iv: expect.any(String), ciphertext: expect.any(String) });
    expect(JSON.stringify(stored)).not.toContain("sk-super-secret");
    expect((await getOpenAICredential())?.apiKey).toBe("sk-super-secret-value-0000");
  });

  it("deletes a record that a different (e.g. lost and regenerated) device key cannot open", async () => {
    await saveOpenAICredential("sk-super-secret-value-0000");
    expect(await getOpenAICredential(new DeviceKey(new MemoryDeviceKeyStore()))).toBeNull();
    expect(await browser.storage.local.get("openaiCredential")).toEqual({});
    expect(await getCredentialStatus()).toEqual({ configured: false, maskedSuffix: null });
  });

  it("deletes a tampered record", async () => {
    await saveOpenAICredential("sk-super-secret-value-0000");
    const { openaiCredential } = await browser.storage.local.get("openaiCredential") as { openaiCredential: { ciphertext: string } };
    await browser.storage.local.set({ openaiCredential: { ...openaiCredential, ciphertext: btoa("tampered-ciphertext!") } });
    expect(await getOpenAICredential()).toBeNull();
    expect(await browser.storage.local.get("openaiCredential")).toEqual({});
  });

  it("keeps the record but reports it absent while the key store is unavailable", async () => {
    await saveOpenAICredential("sk-super-secret-value-0000");
    const store = new MemoryDeviceKeyStore();
    store.load = async () => { throw new Error("IndexedDB unavailable"); };
    expect(await getOpenAICredential(new DeviceKey(store))).toBeNull();
    expect((await getOpenAICredential())?.apiKey).toBe("sk-super-secret-value-0000");
  });
});

describe("storage: ChatGPT model catalog", () => {
  it("reads a catalog saved with per-model efforts as plain listings, so efforts come from Pi", async () => {
    const sealed = { version: 2, iv: "B".repeat(16), ciphertext: "C".repeat(64) };
    await browser.storage.local.set({ chatgptCredential: { ...sealed,
      models: [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", reasoningEfforts: ["none"], defaultReasoningEffort: "none" }] } });
    expect(await getChatGPTCredential()).toEqual({ ...sealed, models: [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }] });
  });
});

describe("storage: credential migration", () => {
  const legacyApiKey = { version: 1, apiKey: "sk-test-legacy-plaintext", updatedAt: 5 };
  const legacyChatGPT = { version: 1, salt: "A".repeat(24), iv: "B".repeat(16), ciphertext: "C".repeat(64),
    models: [{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra", reasoningEfforts: ["none"], defaultReasoningEffort: "none" }] };

  it("deletes a legacy PIN-wrapped ChatGPT credential and flags the sign-in notice", async () => {
    const registration = { version: 1, hostId: `urn:uuid:${crypto.randomUUID()}`, clientId: "oaiapp_test", subject: "test-user",
      redirectUri: "http://127.0.0.1:1455/mozoauth2/test-addon" };
    await browser.storage.local.set({ chatgptCredential: legacyChatGPT, chatgptRegistration: registration });
    await migrateCredentials();
    const stored = await browser.storage.local.get(null);
    expect(stored.chatgptCredential).toBeUndefined();
    // The registration holds no PIN-wrapped secret; login discards it if its callback is stale.
    expect(stored.chatgptRegistration).toEqual(registration);
    expect(await hasChatGPTSignInNotice()).toBe(true);
  });

  it("never deletes a legacy ChatGPT credential without recording the sign-in notice", async () => {
    await browser.storage.local.set({ chatgptCredential: legacyChatGPT });
    const set = browser.storage.local.set.bind(browser.storage.local);
    const spy = vi.spyOn(browser.storage.local, "set").mockImplementation(async (items) => {
      if ("chatgptSignInNotice" in items) throw new Error("Interrupted");
      return set(items);
    });
    await expect(migrateCredentials()).rejects.toThrow("Interrupted");
    spy.mockRestore();
    // Either both survive for the next startup to retry, or the notice is set.
    const stored = await browser.storage.local.get(null);
    expect(stored.chatgptCredential !== undefined || await hasChatGPTSignInNotice()).toBe(true);
    await migrateCredentials();
    expect((await browser.storage.local.get(null)).chatgptCredential).toBeUndefined();
    expect(await hasChatGPTSignInNotice()).toBe(true);
  });

  it("re-encrypts a plaintext API key and removes the plaintext copy", async () => {
    await browser.storage.local.set({ openaiCredential: legacyApiKey });
    await migrateCredentials();
    const stored = await browser.storage.local.get(null);
    expect(stored.openaiCredential).toMatchObject({ version: 2, iv: expect.any(String), ciphertext: expect.any(String), updatedAt: 5 });
    expect(stored.openaiCredential).not.toHaveProperty("apiKey");
    expect(JSON.stringify(stored)).not.toContain("sk-test-legacy-plaintext");
    expect(await getOpenAICredential()).toEqual({ apiKey: "sk-test-legacy-plaintext", updatedAt: 5 });
    expect(await hasChatGPTSignInNotice()).toBe(false);
  });

  it("is a no-op when run again", async () => {
    await browser.storage.local.set({ openaiCredential: legacyApiKey, chatgptCredential: legacyChatGPT });
    await migrateCredentials();
    const first = await browser.storage.local.get(null);
    await migrateCredentials();
    expect(await browser.storage.local.get(null)).toEqual(first);
    await browser.storage.local.remove("chatgptSignInNotice");
    await migrateCredentials();
    expect(await hasChatGPTSignInNotice()).toBe(false);
  });

  it("applies the same upgrade when a getter runs before the startup migration", async () => {
    await browser.storage.local.set({ openaiCredential: legacyApiKey, chatgptCredential: legacyChatGPT });
    expect((await getOpenAICredential())?.apiKey).toBe("sk-test-legacy-plaintext");
    expect(await getChatGPTCredential()).toBeNull();
    expect(JSON.stringify(await browser.storage.local.get(null))).not.toContain("sk-test-legacy-plaintext");
    expect(await hasChatGPTSignInNotice()).toBe(true);
  });

  it("keeps the plaintext key for a later retry when the device key is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await browser.storage.local.set({ openaiCredential: legacyApiKey });
    const store = new MemoryDeviceKeyStore();
    store.load = async () => { throw new Error("IndexedDB unavailable"); };
    await migrateCredentials(new DeviceKey(store));
    expect((await browser.storage.local.get("openaiCredential")).openaiCredential).toEqual(legacyApiKey);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("sk-test");
    await migrateCredentials();
    expect((await getOpenAICredential())?.apiKey).toBe("sk-test-legacy-plaintext");
  });
});

describe("storage: sessions", () => {
  it("restores appended items from storage, in order, across chunk boundaries", async () => {
    const id = await sessionWith(CONVERSATION_CHUNK_SIZE * 2 + 3);
    const conversation = await getConversation(id);
    expect(conversation?.items.map((item) => item.id)).toEqual(Array.from({ length: CONVERSATION_CHUNK_SIZE * 2 + 3 }, (_, i) => `m${i}`));
    expect(conversation?.itemCount).toBe(CONVERSATION_CHUNK_SIZE * 2 + 3);
    expect(await getConversation(id)).toEqual(conversation);
  });

  it("appends by writing only the tail chunk and the session record, however long the history", async () => {
    const set = vi.spyOn(browser.storage.local, "set");
    for (const count of [5, CONVERSATION_CHUNK_SIZE * 3, CONVERSATION_CHUNK_SIZE * 4 + 7]) {
      const id = await sessionWith(count);
      set.mockClear();
      await appendConversationItem(id, message("next"));
      expect(set).toHaveBeenCalledTimes(1);
      const written = set.mock.calls[0]![0] as Record<string, { items?: unknown[] }>;
      const tail = Math.floor(count / CONVERSATION_CHUNK_SIZE);
      expect(Object.keys(written).sort()).toEqual([`conversation:${id}`, `conversation:${id}:items:${tail}`]);
      expect(written[`conversation:${id}:items:${tail}`]!.items).toHaveLength(count % CONVERSATION_CHUNK_SIZE + 1);
    }
    set.mockRestore();
  });

  it("serializes concurrent appends without losing items", async () => {
    const { id } = await createSession();
    await Promise.all(Array.from({ length: 40 }, (_, i) => appendConversationItem(id, message(`m${i}`))));
    expect((await getConversation(id))?.items).toHaveLength(40);
  });

  it("refuses to append to an unknown session", async () => {
    await expect(appendConversationItem("missing", message("m"))).rejects.toThrow("Unknown session");
    expect(await browser.storage.local.get(null)).toEqual({});
  });

  it("truncates history at a corrupt chunk, repairs the record, and keeps appending", async () => {
    const id = await sessionWith(CONVERSATION_CHUNK_SIZE * 2 + 5);
    await browser.storage.local.set({ [`conversation:${id}:items:1`]: { version: 1, items: [{ garbage: true }] } });
    expect((await getConversation(id))?.items).toHaveLength(CONVERSATION_CHUNK_SIZE);
    const stored = await browser.storage.local.get(null);
    expect(stored[`conversation:${id}`]).toMatchObject({ itemCount: CONVERSATION_CHUNK_SIZE });
    expect(stored[`conversation:${id}:items:1`]).toBeUndefined();
    expect(stored[`conversation:${id}:items:2`]).toBeUndefined();
    await appendConversationItem(id, message("after"));
    expect((await getConversation(id))?.items.at(-1)?.id).toBe("after");
    expect((await getConversation(id))?.items).toHaveLength(CONVERSATION_CHUNK_SIZE + 1);
  });

  it("loses only the tail chunk's items when appending after the tail chunk is corrupt", async () => {
    const id = await sessionWith(CONVERSATION_CHUNK_SIZE + 3);
    await browser.storage.local.set({ [`conversation:${id}:items:1`]: "corrupt" });
    await appendConversationItem(id, message("after"));
    const items = (await getConversation(id))!.items;
    expect(items).toHaveLength(CONVERSATION_CHUNK_SIZE + 1);
    expect(items.at(-1)?.id).toBe("after");
  });

  it("stores run digests and compactions, and revalidates them on read", async () => {
    const id = (await createSession()).id;
    const digest = { version: 1 as const, status: "completed" as const, error: null, omittedEntries: 0,
      entries: [{ type: "program" as const, source: "return 1;", ok: true, code: null, urls: ["https://example.com/"], excerpt: "1" }] };
    await appendConversationItem(id, message("m0"));
    await appendConversationItem(id, { id: "d0", kind: "run-digest", digest, at: 1 });
    await appendConversationItem(id, { id: "k0", kind: "compaction", summary: "Summary", firstKeptItemId: "m0", tokensBefore: 10, at: 2 });
    expect((await getConversation(id))?.items.map((item) => item.kind)).toEqual(["message", "run-digest", "compaction"]);
    for (const bad of [
      { id: "d1", kind: "run-digest", digest: { ...digest, entries: [{ type: "program", source: 1 }] }, at: 1 },
      { id: "k1", kind: "compaction", summary: "x".repeat(60_001), firstKeptItemId: "m0", tokensBefore: 10, at: 2 },
      { id: "k2", kind: "compaction", summary: "Summary", tokensBefore: 10, at: 2 },
    ]) {
      await browser.storage.local.set({ [`conversation:${id}:items:0`]: { version: 1, items: [message("m0"), bad, message("m2")] } });
      expect((await getConversation(id))?.items).toEqual([]);
      await browser.storage.local.set({ [`conversation:${id}`]: { version: 2, id, createdAt: 0, updatedAt: 0, itemCount: 3 } });
    }
  });

  it("ignores items a chunk holds past the committed count", async () => {
    const id = await sessionWith(2);
    await browser.storage.local.set({ [`conversation:${id}:items:0`]: { version: 1, items: [message("m0"), message("m1"), message("uncommitted")] } });
    expect((await getConversation(id))?.items.map((item) => item.id)).toEqual(["m0", "m1"]);
    await appendConversationItem(id, message("m2"));
    expect((await getConversation(id))?.items.map((item) => item.id)).toEqual(["m0", "m1", "m2"]);
  });

  it("reads a session with a corrupt record as empty and restarts it on the next append", async () => {
    const id = await sessionWith(3);
    await browser.storage.local.set({ [`conversation:${id}`]: { version: 2, id: "other", itemCount: 3 } });
    expect(await getConversation(id)).toMatchObject({ id, items: [] });
    await appendConversationItem(id, message("fresh"));
    expect((await getConversation(id))?.items.map((item) => item.id)).toEqual(["fresh"]);
  });

  it("drops invalid index entries and rebuilds a corrupt index from the session records", async () => {
    const a = await createSession();
    await appendConversationItem(a.id, prompt("u1", "Plan the trip"));
    const b = await sessionWith(1);
    const { conversationIndex } = await browser.storage.local.get("conversationIndex") as { conversationIndex: { sessions: unknown[] } };
    await browser.storage.local.set({ conversationIndex: { version: 1, sessions: [...conversationIndex.sessions, { id: "bad" }, conversationIndex.sessions[0]] } });
    expect((await listSessions()).map((session) => session.id).sort()).toEqual([a.id, b].sort());

    await browser.storage.local.set({ conversationIndex: "corrupt" });
    const rebuilt = await listSessions();
    expect(rebuilt.map((session) => session.id).sort()).toEqual([a.id, b].sort());
    expect(rebuilt.find((session) => session.id === a.id)).toMatchObject({ title: "Plan the trip", itemCount: 1 });
  });

  it("titles a session from its first prompt once, and never overwrites a user title", async () => {
    const { id } = await createSession();
    await touchSession(id, { prompt: "  Compare   @Laptops (tab 4, /tabs/4/page.md, https://shop.example/l)\nprices ", modelId: "gpt-5.6-sol" });
    expect((await listSessions())[0]).toMatchObject({ title: "Compare @Laptops prices", lastModelId: "gpt-5.6-sol" });
    await touchSession(id, { prompt: "Second prompt" });
    expect((await listSessions())[0]?.title).toBe("Compare @Laptops prices");
    await updateSession(id, { title: "Laptop research" });
    await touchSession(id, { prompt: "Third" });
    expect((await listSessions())[0]).toMatchObject({ title: "Laptop research", titleSource: "user" });
    expect(titleFromPrompt("x".repeat(100))).toBe(`${"x".repeat(59)}…`);
  });

  it("refreshes the index item count and recency from the record at turn boundaries", async () => {
    const id = await sessionWith(3);
    expect((await listSessions())[0]?.itemCount).toBe(0);
    await touchSession(id);
    expect((await listSessions())[0]?.itemCount).toBe(3);
  });

  it("adds each ended run's usage to the session total, kept across reads and revalidated", async () => {
    const id = await sessionWith(0);
    expect((await listSessions())[0]?.usage).toEqual(EMPTY_USAGE);
    await touchSession(id, { usage: runUsage({ runId: "r1", input: 1000, cacheRead: 3000, cacheWrite: 500, output: 200, reasoning: 50, costUsd: 0.01 }) });
    await touchSession(id, { usage: runUsage({ runId: "r2", billing: "chatgpt", input: 100, output: 10, costUsd: null }) });
    await touchSession(id, { usage: runUsage({ runId: "r3", modelId: "account-model", input: 10, output: 1, costUsd: null }) });
    await touchSession(id);
    expect((await listSessions())[0]?.usage).toEqual({
      responses: 3, input: 4610, cacheRead: 3000, output: 211, reasoning: 50, costUsd: 0.01, pricedRuns: 1, planRuns: 1, unpricedRuns: 1,
    });

    // An entry written before totals existed, or with corrupt ones, is kept and counts from zero.
    const { conversationIndex } = await browser.storage.local.get("conversationIndex") as { conversationIndex: { sessions: Record<string, unknown>[] } };
    const { usage: _usage, ...legacy } = conversationIndex.sessions[0]!;
    const other = { ...legacy, id: "other", usage: { input: -1 } };
    await browser.storage.local.set({ conversationIndex: { version: 1, sessions: [legacy, other] } });
    expect(await listSessions()).toEqual(expect.arrayContaining([expect.objectContaining({ id, usage: EMPTY_USAGE }), expect.objectContaining({ id: "other", usage: EMPTY_USAGE })]));
  });

  it("stores run-usage items and sums them when rebuilding a corrupt index", async () => {
    const id = await sessionWith(1);
    const usage = runUsage({ input: 900, cacheRead: 100, output: 50, costUsd: 0.002 });
    await appendConversationItem(id, { id: "usage-run-1", kind: "run-usage", usage, at: 2 });
    expect((await getConversation(id))?.items.at(-1)).toEqual({ id: "usage-run-1", kind: "run-usage", usage, at: 2 });
    await browser.storage.local.set({ conversationIndex: "corrupt" });
    expect((await listSessions())[0]?.usage).toMatchObject({ input: 1000, cacheRead: 100, output: 50, costUsd: 0.002, pricedRuns: 1 });
    // A malformed usage item invalidates its chunk like any other malformed item.
    await appendConversationItem(id, { id: "bad", kind: "run-usage", usage: { ...usage, billing: "chatgpt", costUsd: 1 }, at: 3 });
    expect((await getConversation(id))?.items.map((item) => item.id)).toEqual([]);
  });

  it("lists pinned sessions first, then by most recent activity", async () => {
    const old = await sessionWith(1);
    const pinned = await sessionWith(1);
    const recent = await sessionWith(1);
    for (const [id, at] of [[old, 1], [pinned, 2], [recent, 3]] as const) {
      const key = `conversation:${id}`;
      const record = (await browser.storage.local.get(key))[key] as object;
      await browser.storage.local.set({ [key]: { ...record, updatedAt: at } });
      await touchSession(id);
    }
    await updateSession(old, { pinned: true });
    expect((await listSessions()).map((session) => session.id)).toEqual([old, recent, pinned]);
  });

  it("deletes every key of a session and clears the open pointer", async () => {
    const keep = await sessionWith(1);
    const id = await sessionWith(CONVERSATION_CHUNK_SIZE + 1);
    await ensureOpenSession();
    await browser.storage.local.set({ openConversation: { version: 1, id } });
    await deleteSession(id);
    expect(Object.keys(await browser.storage.local.get(null)).filter((key) => key.includes(id))).toEqual([]);
    expect(await getOpenSessionId()).toBeNull();
    expect((await listSessions()).map((session) => session.id)).toEqual([keep]);
    expect(await ensureOpenSession()).toBe(keep);
  });
});

describe("storage: message queue", () => {
  it("round-trips a session's queue, deletes it with the session, and drops malformed records", async () => {
    const id = (await createSession()).id;
    const queue = [{ id: "q1", mode: "follow-up" as const, text: "Then summarize", at: 1 }, { id: "q2", mode: "steer" as const, text: "Use tab 2", at: 2 }];
    await saveMessageQueue(id, queue);
    expect(await loadMessageQueue(id)).toEqual(queue);
    for (const bad of [
      { version: 2, messages: queue },
      { version: 1, messages: [{ ...queue[0], mode: "later" }] },
      { version: 1, messages: [{ ...queue[0], text: "   " }] },
      { version: 1, messages: Array.from({ length: 21 }, (_, i) => ({ ...queue[0], id: `q${i}` })) },
    ]) {
      await browser.storage.local.set({ [`queue:${id}`]: bad });
      expect(await loadMessageQueue(id)).toEqual([]);
      expect(await browser.storage.local.get(`queue:${id}`)).toEqual({});
    }
    await saveMessageQueue(id, queue);
    await deleteSession(id);
    expect(await browser.storage.local.get(`queue:${id}`)).toEqual({});
  });

  it("stores delivered steers as user items and revalidates their marker on read", async () => {
    const id = (await createSession()).id;
    await appendConversationItem(id, { id: "s0", kind: "message", role: "user", text: "Use tab 2", context: null, delivery: "steer", at: 1 });
    expect((await getConversation(id))?.items[0]).toMatchObject({ delivery: "steer" });
    await browser.storage.local.set({ [`conversation:${id}:items:0`]: { version: 1, items: [{ id: "s0", kind: "message", role: "user", text: "x", context: null, delivery: "later", at: 1 }] } });
    expect((await getConversation(id))?.items).toEqual([]);
  });
});

describe("storage: session workspace", () => {
  it("stores each file in its own slot record and reads back only the session's files", async () => {
    const a = workspaceStore("a");
    await a.write({ slot: 0, path: "/workspace/x.md", content: "X" });
    await a.write({ slot: 5, path: "/workspace/dir/y.csv", content: "1,2" });
    await workspaceStore("b").write({ slot: 0, path: "/workspace/x.md", content: "Other chat" });
    expect((await browser.storage.local.get("workspace:a:5"))["workspace:a:5"]).toEqual({ version: 1, path: "/workspace/dir/y.csv", content: "1,2" });
    expect(await loadWorkspaceFiles("a")).toEqual([{ slot: 0, path: "/workspace/x.md", content: "X" }, { slot: 5, path: "/workspace/dir/y.csv", content: "1,2" }]);
    await a.remove(0);
    expect(await loadWorkspaceFiles("a")).toEqual([{ slot: 5, path: "/workspace/dir/y.csv", content: "1,2" }]);
  });

  it("revalidates files on read, deleting malformed, oversized, traversing, and duplicate ones", async () => {
    await browser.storage.local.set({
      "workspace:a:0": { version: 1, path: "/workspace/ok.md", content: "fine" },
      "workspace:a:1": { version: 2, path: "/workspace/v2.md", content: "unknown version" },
      "workspace:a:2": { version: 1, path: "/workspace/big.md", content: "x".repeat(32_001) },
      "workspace:a:3": { version: 1, path: "/workspace/../etc/passwd", content: "no" },
      "workspace:a:4": { version: 1, path: "/workspace/ok.md", content: "duplicate" },
      "workspace:a:5": "corrupt",
      "workspace:a:6": { version: 1, path: "/workspace/max.md", content: "y".repeat(32_000) },
      "workspace:a:64": { version: 1, path: "/workspace/out-of-range.md", content: "never read" },
    });
    expect((await loadWorkspaceFiles("a")).map((file) => [file.slot, file.path])).toEqual([[0, "/workspace/ok.md"], [6, "/workspace/max.md"]]);
    expect(Object.keys(await browser.storage.local.get(null)).sort()).toEqual(["workspace:a:0", "workspace:a:6", "workspace:a:64"]);
  });
});

describe("storage: history retention and bulk deletion", () => {
  /** Backdates a session's last activity in its record and index entry. */
  async function setUpdatedAt(id: string, at: number): Promise<void> {
    const key = `conversation:${id}`;
    const record = (await browser.storage.local.get(key))[key] as object;
    await browser.storage.local.set({ [key]: { ...record, updatedAt: at } });
    await touchSession(id);
  }
  const keysOf = async (id: string) => Object.keys(await browser.storage.local.get(null)).filter((key) => key.includes(id));

  it("defaults retention to forever and resets a corrupt record", async () => {
    expect(await getHistorySettings()).toEqual({ version: 1, retention: "forever" });
    await saveHistorySettings({ version: 1, retention: "7d" });
    expect(await getHistorySettings()).toEqual({ version: 1, retention: "7d" });
    await browser.storage.local.set({ historySettings: { version: 1, retention: "1d" } });
    expect(await getHistorySettings()).toEqual({ version: 1, retention: "forever" });
    expect((await browser.storage.local.get("historySettings")).historySettings).toBeUndefined();
  });

  it("prunes unpinned sessions updated before the cutoff, except kept ones, removing every key", async () => {
    const old = await sessionWith(CONVERSATION_CHUNK_SIZE + 1);
    const pinned = await sessionWith(1);
    const kept = await sessionWith(1);
    const recent = await sessionWith(1);
    for (const [id, at] of [[old, 100], [pinned, 100], [kept, 100], [recent, 300]] as const) await setUpdatedAt(id, at);
    await updateSession(pinned, { pinned: true });
    await browser.storage.local.set({ openConversation: { version: 1, id: old } });

    expect(await pruneSessions(200, [kept])).toEqual([old]);
    expect(await keysOf(old)).toEqual([]);
    expect(await getOpenSessionId()).toBeNull();
    expect((await listSessions()).map((session) => session.id).sort()).toEqual([pinned, kept, recent].sort());
    expect(await pruneSessions(200, [kept])).toEqual([]);
  });

  it("deletes every session except kept ones, pinned included", async () => {
    const pinned = await sessionWith(1);
    await updateSession(pinned, { pinned: true });
    const other = await sessionWith(2);
    const kept = await sessionWith(1);
    expect((await deleteAllSessions([kept])).sort()).toEqual([pinned, other].sort());
    expect([...await keysOf(pinned), ...await keysOf(other)]).toEqual([]);
    expect((await listSessions()).map((session) => session.id)).toEqual([kept]);
    expect((await getConversation(kept))?.items).toHaveLength(1);
  });
});

describe("storage: legacy conversation migration", () => {
  const items: ConversationItem[] = [
    prompt("u1", "Summarize @Inbox (tab 3, /tabs/3/page.md, https://mail.example/) please"),
    ...Array.from({ length: CONVERSATION_CHUNK_SIZE + 2 }, (_, i) => message(`a${i}`)),
  ];
  const legacy = { version: 1, id: "default", items, updatedAt: 50 };

  it("moves the single conversation into the first session, then removes the old record", async () => {
    await browser.storage.local.set({ conversation: legacy });
    await migrateConversation();
    const stored = await browser.storage.local.get(null);
    expect(stored.conversation).toBeUndefined();
    expect(await listSessions()).toEqual([{
      id: "default", title: "Summarize @Inbox please", titleSource: "prompt", createdAt: 1, updatedAt: 50, pinned: false,
      itemCount: items.length, lastModelId: null, usage: EMPTY_USAGE,
    }]);
    expect((await getConversation("default"))?.items).toEqual(items);
    expect(await getOpenSessionId()).toBe("default");
  });

  it("is a no-op when run again, and never overwrites items added after an incomplete migration", async () => {
    await browser.storage.local.set({ conversation: legacy });
    const remove = vi.spyOn(browser.storage.local, "remove").mockRejectedValueOnce(new Error("Interrupted"));
    await expect(migrateConversation()).rejects.toThrow("Interrupted");
    remove.mockRestore();
    expect((await browser.storage.local.get("conversation")).conversation).toEqual(legacy);
    await appendConversationItem("default", message("later"));

    await migrateConversation();
    const after = await browser.storage.local.get(null);
    expect(after.conversation).toBeUndefined();
    expect((await getConversation("default"))?.items.at(-1)?.id).toBe("later");
    await migrateConversation();
    expect(await browser.storage.local.get(null)).toEqual(after);
  });

  it("keeps the old record when the migrated session does not read back", async () => {
    await browser.storage.local.set({ conversation: legacy });
    const set = browser.storage.local.set.bind(browser.storage.local);
    const spy = vi.spyOn(browser.storage.local, "set").mockImplementation(async (values) =>
      set(Object.fromEntries(Object.entries(values).filter(([key]) => !key.endsWith(":items:1")))));
    await expect(migrateConversation()).rejects.toThrow("did not verify");
    spy.mockRestore();
    expect((await browser.storage.local.get("conversation")).conversation).toEqual(legacy);

    await migrateConversation();
    expect((await getConversation("default"))?.items).toEqual(items);
    expect((await browser.storage.local.get("conversation")).conversation).toBeUndefined();
  });

  it("removes a malformed or empty legacy record without creating a session", async () => {
    for (const conversation of [{ version: 1, id: "default", items: [{ garbage: true }], updatedAt: 5 }, "corrupt", { ...legacy, items: [] }]) {
      await browser.storage.local.set({ conversation });
      await migrateConversation();
      expect(await browser.storage.local.get(null)).toEqual({});
    }
  });

  it("recovers a pre-sessions interrupted run into the migrated session", async () => {
    await browser.storage.local.set({
      conversation: legacy,
      runCheckpoint: { version: 1, runId: "r0", status: "running", partialAssistantText: "Half", lastSeq: 1, updatedAt: 1 },
    });
    await migrateConversation();
    expect(await recoverInterruptedRun()).toBe("default");
    expect((await getConversation("default"))?.items.at(-1)).toMatchObject({ id: "interrupted-r0", text: expect.stringContaining("Half") });
  });
});

describe("storage: interrupted run recovery", () => {
  it("converts a checkpoint left running into a visible interrupted assistant message in the run's session", async () => {
    const other = await sessionWith(0);
    const sessionId = await sessionWith(1);
    await saveRunCheckpoint({
      version: 2,
      runId: "run-1",
      sessionId,
      status: "running",
      partialAssistantText: "The page says",
      usage: null,
      lastSeq: 3,
      updatedAt: 10,
    });

    expect(await recoverInterruptedRun()).toBe(sessionId);

    const conversation = await getConversation(sessionId);
    expect(conversation?.items).toHaveLength(2);
    const item = conversation?.items[1];
    expect(item?.kind).toBe("message");
    if (item?.kind === "message") {
      expect(item.role).toBe("assistant");
      expect(item.text).toContain("The page says");
      expect(item.text).toContain("Interrupted");
    }
    expect((await getConversation(other))?.items).toEqual([]);
    expect((await listSessions()).find((session) => session.id === sessionId)?.itemCount).toBe(2);
    expect(await getRunCheckpoint()).toBeNull();
  });

  it("persists the usage an interrupted run had checkpointed and adds it to the session total", async () => {
    const sessionId = await sessionWith(1);
    const usage = runUsage({ runId: "run-5", input: 400, output: 40, costUsd: 0.001 });
    await saveRunCheckpoint({ version: 2, runId: "run-5", sessionId, status: "running", partialAssistantText: "", usage, lastSeq: 2, updatedAt: 10 });
    await recoverInterruptedRun();
    expect((await getConversation(sessionId))?.items.slice(1).map((item) => item.kind === "run-usage" ? [item.id, item.usage] : item.kind))
      .toEqual(["message", ["usage-run-5", usage]]);
    expect((await listSessions())[0]?.usage).toMatchObject({ responses: 1, input: 400, output: 40, costUsd: 0.001 });
  });

  it("converts a checkpoint left awaiting-approval into a visible interrupted message", async () => {
    const sessionId = await sessionWith(0);
    await saveRunCheckpoint({
      version: 2,
      runId: "run-2",
      sessionId,
      status: "awaiting-approval",
      partialAssistantText: "",
      usage: null,
      lastSeq: 1,
      updatedAt: 10,
    });

    await recoverInterruptedRun();

    expect((await getConversation(sessionId))?.items).toHaveLength(1);
    expect(await getRunCheckpoint()).toBeNull();
  });

  it("silently clears a checkpoint that already reached a terminal status, or whose session is gone", async () => {
    const sessionId = await sessionWith(0);
    for (const checkpoint of [
      { version: 2, runId: "run-3", sessionId, status: "completed", partialAssistantText: "", usage: null, lastSeq: 1, updatedAt: 10 },
      { version: 2, runId: "run-4", sessionId: "deleted", status: "running", partialAssistantText: "", usage: null, lastSeq: 1, updatedAt: 10 },
    ] as const) {
      await saveRunCheckpoint(checkpoint);
      expect(await recoverInterruptedRun()).toBeNull();
      expect(await getRunCheckpoint()).toBeNull();
    }
    expect((await getConversation(sessionId))?.items).toEqual([]);
    expect(await getConversation("deleted")).toBeNull();
  });

  it("does nothing when there is no checkpoint", async () => {
    expect(await recoverInterruptedRun()).toBeNull();
    expect(await listSessions()).toEqual([]);
  });
});
