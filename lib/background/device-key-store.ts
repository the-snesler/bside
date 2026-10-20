/** Thin IndexedDB adapter for the device key; tests substitute an in-memory store. */
import type { DeviceKeyStore } from "@/lib/background/device-key";

const DATABASE = "bside-device-key";
const STORE = "keys";
const RECORD = "device-key:v1";

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function open(): Promise<IDBDatabase> {
  const request = indexedDB.open(DATABASE, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE);
  return settle(request);
}

export const indexedDBDeviceKeyStore: DeviceKeyStore = {
  async load() {
    const database = await open();
    try { return await settle(database.transaction(STORE).objectStore(STORE).get(RECORD)); }
    finally { database.close(); }
  },
  async save(key) {
    const database = await open();
    try {
      // Credentials are sealed with this key right after it is saved; losing it to a
      // crash before the write reaches disk would make them undecryptable.
      const transaction = database.transaction(STORE, "readwrite", { durability: "strict" });
      transaction.objectStore(STORE).put(key, RECORD);
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () => reject(transaction.error);
      });
    } finally { database.close(); }
  },
};
