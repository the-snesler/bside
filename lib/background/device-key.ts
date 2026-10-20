/**
 * Per-profile AES-GCM key that encrypts credentials at rest in `storage.local`.
 * The key is generated non-extractable and persisted as a `CryptoKey` object
 * (structured clone keeps it non-extractable), so its raw bytes never appear
 * in storage, logs, or exports. Like Firefox saved passwords without a Primary
 * Password, this stops casual reads of the profile, not a full compromise.
 */

import { indexedDBDeviceKeyStore } from "@/lib/background/device-key-store";

export interface DeviceKeyStore {
  load(): Promise<unknown>;
  save(key: CryptoKey): Promise<void>;
}

/** JSON-compatible AES-GCM payload; `iv` is fresh for every seal. */
export interface SealedSecret {
  iv: string;
  ciphertext: string;
}

function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function isDeviceKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== "undefined" && value instanceof CryptoKey && !value.extractable &&
    value.algorithm.name === "AES-GCM" && value.usages.includes("encrypt") && value.usages.includes("decrypt");
}

export class DeviceKey {
  #store: DeviceKeyStore;
  #key: Promise<CryptoKey> | null = null;

  constructor(store: DeviceKeyStore = indexedDBDeviceKeyStore) {
    this.#store = store;
  }

  /** Loads the persisted key, generating and saving one silently on first use. */
  key(): Promise<CryptoKey> {
    this.#key ??= this.#loadOrCreate().catch((error: unknown) => { this.#key = null; throw error; });
    return this.#key;
  }

  async seal(plaintext: string, context: string): Promise<SealedSecret> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
      await this.key(), new TextEncoder().encode(plaintext));
    return { iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
  }

  /**
   * Returns null when the payload was not sealed by this key for this context
   * (lost key, tampering, corruption). Rejects only if the key is unavailable.
   */
  async open(sealed: SealedSecret, context: string): Promise<string | null> {
    const key = await this.key();
    try {
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(sealed.iv), additionalData: new TextEncoder().encode(context) },
        key, bytes(sealed.ciphertext));
      return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch { return null; }
  }

  async #loadOrCreate(): Promise<CryptoKey> {
    const saved = await this.#store.load();
    if (isDeviceKey(saved)) return saved;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await this.#store.save(key);
    return key;
  }
}

/** The background's device key, persisted in the extension's IndexedDB. */
export const deviceKey = new DeviceKey();
