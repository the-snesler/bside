import { beforeEach, describe, expect, it } from "vitest";
import { DeviceKey } from "@/lib/background/device-key";
import { MemoryDeviceKeyStore } from "@/tests/helpers/memory-key-store";
import {
  appendConversationItem,
  deleteOpenAICredential,
  getAppSettings,
  getConversation,
  getCredentialStatus,
  getOpenAICredential,
  getRunCheckpoint,
  recoverInterruptedRun,
  saveAppSettings,
  saveOpenAICredential,
  saveRunCheckpoint,
} from "@/lib/storage";

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

  it("returns an empty default conversation when nothing is stored", async () => {
    const conversation = await getConversation();
    expect(conversation.id).toBe("default");
    expect(conversation.items).toEqual([]);
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

  it("resets a conversation with malformed items to the default", async () => {
    await browser.storage.local.set({
      conversation: { version: 1, id: "default", items: [{ garbage: true }], updatedAt: 5 },
    });
    const conversation = await getConversation();
    expect(conversation.items).toEqual([]);
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

describe("storage: one-thread restore", () => {
  it("persists appended items under the single default conversation id", async () => {
    await appendConversationItem({
      id: "m1",
      kind: "message",
      role: "user",
      text: "Hello",
      context: null,
      at: 1,
    });
    await appendConversationItem({ id: "m2", kind: "message", role: "assistant", text: "Hi there", at: 2 });

    const conversation = await getConversation();
    expect(conversation.id).toBe("default");
    expect(conversation.items.map((item) => item.id)).toEqual(["m1", "m2"]);

    // Simulate a reload: fetch again from the same underlying storage.
    const restored = await getConversation();
    expect(restored.items).toEqual(conversation.items);
  });
});

describe("storage: interrupted run recovery", () => {
  it("converts a checkpoint left running into a visible interrupted assistant message", async () => {
    await saveRunCheckpoint({
      version: 1,
      runId: "run-1",
      status: "running",
      partialAssistantText: "The page says",
      lastSeq: 3,
      updatedAt: 10,
    });

    await recoverInterruptedRun();

    const conversation = await getConversation();
    expect(conversation.items).toHaveLength(1);
    const [item] = conversation.items;
    expect(item?.kind).toBe("message");
    if (item?.kind === "message") {
      expect(item.role).toBe("assistant");
      expect(item.text).toContain("The page says");
      expect(item.text).toContain("Interrupted");
    }
    expect(await getRunCheckpoint()).toBeNull();
  });

  it("converts a checkpoint left awaiting-approval into a visible interrupted message", async () => {
    await saveRunCheckpoint({
      version: 1,
      runId: "run-2",
      status: "awaiting-approval",
      partialAssistantText: "",
      lastSeq: 1,
      updatedAt: 10,
    });

    await recoverInterruptedRun();

    const conversation = await getConversation();
    expect(conversation.items).toHaveLength(1);
    expect(await getRunCheckpoint()).toBeNull();
  });

  it("silently clears a checkpoint that already reached a terminal status", async () => {
    await saveRunCheckpoint({
      version: 1,
      runId: "run-3",
      status: "completed",
      partialAssistantText: "",
      lastSeq: 1,
      updatedAt: 10,
    });

    await recoverInterruptedRun();

    const conversation = await getConversation();
    expect(conversation.items).toEqual([]);
    expect(await getRunCheckpoint()).toBeNull();
  });

  it("does nothing when there is no checkpoint", async () => {
    await recoverInterruptedRun();
    const conversation = await getConversation();
    expect(conversation.items).toEqual([]);
  });
});
