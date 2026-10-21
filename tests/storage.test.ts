import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceKey } from "@/lib/background/device-key";
import { MemoryDeviceKeyStore } from "@/tests/helpers/memory-key-store";
import {
  appendConversationItem,
  CONVERSATION_CHUNK_SIZE,
  createSession,
  deleteOpenAICredential,
  deleteSession,
  ensureOpenSession,
  getAppSettings,
  getConversation,
  getCredentialStatus,
  getOpenAICredential,
  getOpenSessionId,
  getChatGPTCredential,
  getRunCheckpoint,
  hasChatGPTSignInNotice,
  listSessions,
  migrateConversation,
  migrateCredentials,
  recoverInterruptedRun,
  saveAppSettings,
  saveOpenAICredential,
  saveRunCheckpoint,
  touchSession,
  updateSession,
} from "@/lib/storage";
import { titleFromPrompt, type ConversationItem } from "@/lib/domain/conversation";

const message = (id: string, text = id): ConversationItem => ({ id, kind: "message", role: "assistant", text, at: 1 });
const prompt = (id: string, text: string): ConversationItem => ({ id, kind: "message", role: "user", text, context: null, at: 1 });

async function sessionWith(count: number): Promise<string> {
  const { id } = await createSession();
  for (let i = 0; i < count; i += 1) await appendConversationItem(id, message(`m${i}`));
  return id;
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
    await saveRunCheckpoint({ version: 2, runId: "r1", sessionId: "../escape", status: "running", partialAssistantText: "", lastSeq: 0, updatedAt: 1 });
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
      itemCount: items.length, lastModelId: null,
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

  it("converts a checkpoint left awaiting-approval into a visible interrupted message", async () => {
    const sessionId = await sessionWith(0);
    await saveRunCheckpoint({
      version: 2,
      runId: "run-2",
      sessionId,
      status: "awaiting-approval",
      partialAssistantText: "",
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
      { version: 2, runId: "run-3", sessionId, status: "completed", partialAssistantText: "", lastSeq: 1, updatedAt: 10 },
      { version: 2, runId: "run-4", sessionId: "deleted", status: "running", partialAssistantText: "", lastSeq: 1, updatedAt: 10 },
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
