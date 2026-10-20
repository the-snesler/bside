import type { DeviceKeyStore } from "@/lib/background/device-key";

/** In-memory stand-in for the IndexedDB device-key store (Node and happy-dom lack IndexedDB). */
export class MemoryDeviceKeyStore implements DeviceKeyStore {
  value: unknown = undefined;
  saves = 0;
  async load(): Promise<unknown> { return this.value; }
  async save(key: CryptoKey): Promise<void> { this.value = key; this.saves++; }
}
