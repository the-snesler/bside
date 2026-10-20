import { vi } from "vitest";

// The default device key persists in IndexedDB, which Node lacks. Keep it in
// memory for the whole test run; device-key tests inject their own stores.
vi.mock("@/lib/background/device-key-store", async () => {
  const { MemoryDeviceKeyStore } = await import("@/tests/helpers/memory-key-store");
  return { indexedDBDeviceKeyStore: new MemoryDeviceKeyStore() };
});
