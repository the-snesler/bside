import { describe, expect, it } from "vitest";
import { DeviceKey } from "@/lib/background/device-key";
import { MemoryDeviceKeyStore } from "@/tests/helpers/memory-key-store";

describe("device key", () => {
  it("generates a non-extractable AES-GCM key once and reuses the persisted key object", async () => {
    const store = new MemoryDeviceKeyStore();
    const first = new DeviceKey(store);
    const [key, concurrent] = await Promise.all([first.key(), first.key()]);
    expect(concurrent).toBe(key);
    expect(store.saves).toBe(1);
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
    await expect(crypto.subtle.exportKey("jwk", key)).rejects.toThrow();

    // Structured clone (what IndexedDB stores) keeps the key non-extractable.
    const cloned = structuredClone(key);
    expect(cloned.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", cloned)).rejects.toThrow();

    store.value = cloned;
    const sealed = await first.seal("sk-test-device-key", "context");
    const restarted = new DeviceKey(store);
    expect(await restarted.open(sealed, "context")).toBe("sk-test-device-key");
    expect(store.saves).toBe(1);
  });

  it("uses a fresh IV for every seal and never stores the plaintext", async () => {
    const key = new DeviceKey(new MemoryDeviceKeyStore());
    const a = await key.seal("sk-test-device-key", "context");
    const b = await key.seal("sk-test-device-key", "context");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(JSON.stringify([a, b])).not.toContain("sk-test-device-key");
  });

  it("returns null for tampered payloads, a different context, or a different key", async () => {
    const key = new DeviceKey(new MemoryDeviceKeyStore());
    const sealed = await key.seal("sk-test-device-key", "context");
    const flipped = atob(sealed.ciphertext);
    const tampered = { ...sealed, ciphertext: btoa(String.fromCharCode(flipped.charCodeAt(0) ^ 1) + flipped.slice(1)) };
    expect(await key.open(tampered, "context")).toBeNull();
    expect(await key.open({ ...sealed, iv: (await key.seal("", "context")).iv }, "context")).toBeNull();
    expect(await key.open(sealed, "other-context")).toBeNull();
    expect(await key.open({ iv: "not base64!", ciphertext: "" }, "context")).toBeNull();
    expect(await new DeviceKey(new MemoryDeviceKeyStore()).open(sealed, "context")).toBeNull();
  });

  it("replaces an invalid persisted value and retries after a store failure", async () => {
    const store = new MemoryDeviceKeyStore();
    store.value = { not: "a key" };
    const key = await new DeviceKey(store).key();
    expect(store.value).toBe(key);

    let failures = 1;
    const flaky = new MemoryDeviceKeyStore();
    const load = flaky.load.bind(flaky);
    flaky.load = async () => { if (failures-- > 0) throw new Error("IndexedDB unavailable"); return load(); };
    const device = new DeviceKey(flaky);
    await expect(device.key()).rejects.toThrow("IndexedDB unavailable");
    expect((await device.key()).extractable).toBe(false);
  });
});
