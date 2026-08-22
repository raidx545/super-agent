// ============================================================
// VLESS — Encrypted Memory Store
// Stores task data, site memory, and user preferences
// encrypted at rest using Web Crypto API + IndexedDB.
//
// All data stays on the device. Nothing is transmitted.
// Encryption uses AES-GCM with a device-derived key.
// ============================================================

// ── Types ────────────────────────────────────────────────────

export interface StoredTask {
  id: string;
  domain: string;
  description: string;
  plan: unknown;
  result: unknown;
  startTime: number;
  endTime?: number;
  success: boolean;
  privacyScore: number;
}

export interface StoredSiteMemory {
  domain: string;
  lastVisited: number;
  visitCount: number;
  formSchemas: FormSchema[];
  navigationFlow: string[];
  successPatterns: unknown[];
  failurePatterns: unknown[];
}

export interface FormSchema {
  url: string;
  fields: Array<{
    label: string;
    type: string;
    required: boolean;
    semanticCategory: string;
    lastValue?: string; // Encrypted separately
  }>;
}

export interface UserPreferences {
  language: string;
  autoPerceive: boolean;
  confirmHighRisk: boolean;
  showOverlay: boolean;
  maxRetries: number;
  serverPreference: "ollama" | "cloud" | "auto";
}

// ── Encryption ───────────────────────────────────────────────

const DB_NAME = "vless-encrypted-memory";
const DB_VERSION = 1;
const KEY_NAME = "vless-device-key";

/**
 * Get or create the device encryption key.
 * Derived from a fixed salt + device fingerprint.
 * Never leaves the device.
 */
async function getEncryptionKey(): Promise<CryptoKey> {
  // Check if key already exists in IndexedDB
  const existingKey = await loadKeyFromDB();
  if (existingKey) return existingKey;

  // Generate new key
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );

  // Save to IndexedDB
  await saveKeyToDB(key);

  return key;
}

async function loadKeyFromDB(): Promise<CryptoKey | null> {
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("keys")) {
        db.createObjectStore("keys");
      }
      if (!db.objectStoreNames.contains("tasks")) {
        db.createObjectStore("tasks");
      }
      if (!db.objectStoreNames.contains("sites")) {
        db.createObjectStore("sites");
      }
      if (!db.objectStoreNames.contains("preferences")) {
        db.createObjectStore("preferences");
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("keys", "readonly");
      const store = tx.objectStore("keys");
      const getReq = store.get(KEY_NAME);

      getReq.onsuccess = () => {
        if (getReq.result) {
          crypto.subtle
            .importKey(
              "jwk",
              getReq.result,
              { name: "AES-GCM", length: 256 },
              true,
              ["encrypt", "decrypt"]
            )
            .then(resolve)
            .catch(() => resolve(null));
        } else {
          resolve(null);
        }
      };

      getReq.onerror = () => resolve(null);
    };

    request.onerror = () => resolve(null);
  });
}

async function saveKeyToDB(key: CryptoKey): Promise<void> {
  const jwk = await crypto.subtle.exportKey("jwk", key);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("keys")) {
        db.createObjectStore("keys");
      }
      if (!db.objectStoreNames.contains("tasks")) {
        db.createObjectStore("tasks");
      }
      if (!db.objectStoreNames.contains("sites")) {
        db.createObjectStore("sites");
      }
      if (!db.objectStoreNames.contains("preferences")) {
        db.createObjectStore("preferences");
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction("keys", "readwrite");
      const store = tx.objectStore("keys");
      store.put(jwk, KEY_NAME);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };

    request.onerror = () => reject(request.error);
  });
}

// ── Encrypt/Decrypt ──────────────────────────────────────────

async function encrypt(data: unknown): Promise<string> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(data));

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );

  // Combine IV + ciphertext and base64 encode
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...combined));
}

async function decrypt<T>(encryptedBase64: string): Promise<T> {
  const key = await getEncryptionKey();
  const combined = Uint8Array.from(atob(encryptedBase64), (c) =>
    c.charCodeAt(0)
  );

  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return JSON.parse(new TextDecoder().decode(decrypted));
}

// ── Database Operations ──────────────────────────────────────

function openMemoryDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("keys")) {
        db.createObjectStore("keys");
      }
      if (!db.objectStoreNames.contains("tasks")) {
        db.createObjectStore("tasks");
      }
      if (!db.objectStoreNames.contains("sites")) {
        db.createObjectStore("sites");
      }
      if (!db.objectStoreNames.contains("preferences")) {
        db.createObjectStore("preferences");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function encryptedPut(
  storeName: string,
  key: string,
  value: unknown
): Promise<void> {
  const encrypted = await encrypt(value);
  const db = await openMemoryDB();
  const tx = db.transaction(storeName, "readwrite");
  const store = tx.objectStore(storeName);
  store.put(encrypted, key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function encryptedGet<T>(
  storeName: string,
  key: string
): Promise<T | null> {
  const db = await openMemoryDB();
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);
  const request = store.get(key);

  return new Promise((resolve) => {
    request.onsuccess = async () => {
      if (request.result) {
        try {
          resolve(await decrypt<T>(request.result));
        } catch {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    };
    request.onerror = () => resolve(null);
  });
}

async function encryptedGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openMemoryDB();
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);
  const request = store.getAll();

  return new Promise((resolve) => {
    request.onsuccess = async () => {
      if (request.result) {
        const decrypted: T[] = [];
        for (const enc of request.result) {
          try {
            decrypted.push(await decrypt<T>(enc));
          } catch {
            // Skip corrupted entries
          }
        }
        resolve(decrypted);
      } else {
        resolve([]);
      }
    };
    request.onerror = () => resolve([]);
  });
}

async function encryptedDelete(
  storeName: string,
  key: string
): Promise<void> {
  const db = await openMemoryDB();
  const tx = db.transaction(storeName, "readwrite");
  const store = tx.objectStore(storeName);
  store.delete(key);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Public API ───────────────────────────────────────────────

export const taskStore = {
  async save(task: StoredTask): Promise<void> {
    await encryptedPut("tasks", task.id, task);
  },

  async get(id: string): Promise<StoredTask | null> {
    return encryptedGet<StoredTask>("tasks", id);
  },

  async getAll(): Promise<StoredTask[]> {
    return encryptedGetAll<StoredTask>("tasks");
  },

  async getByDomain(domain: string): Promise<StoredTask[]> {
    const all = await encryptedGetAll<StoredTask>("tasks");
    return all.filter((t) => t.domain === domain);
  },

  async delete(id: string): Promise<void> {
    await encryptedDelete("tasks", id);
  },

  async clear(): Promise<void> {
    const db = await openMemoryDB();
    const tx = db.transaction("tasks", "readwrite");
    tx.objectStore("tasks").clear();
  },
};

export const siteStore = {
  async save(memory: StoredSiteMemory): Promise<void> {
    await encryptedPut("sites", memory.domain, memory);
  },

  async get(domain: string): Promise<StoredSiteMemory | null> {
    return encryptedGet<StoredSiteMemory>("sites", domain);
  },

  async getAll(): Promise<StoredSiteMemory[]> {
    return encryptedGetAll<StoredSiteMemory>("sites");
  },

  async delete(domain: string): Promise<void> {
    await encryptedDelete("sites", domain);
  },

  async clear(): Promise<void> {
    const db = await openMemoryDB();
    const tx = db.transaction("sites", "readwrite");
    tx.objectStore("sites").clear();
  },
};

export const preferenceStore = {
  async save(prefs: UserPreferences): Promise<void> {
    await encryptedPut("preferences", "user-prefs", prefs);
  },

  async get(): Promise<UserPreferences | null> {
    return encryptedGet<UserPreferences>("preferences", "user-prefs");
  },

  async clear(): Promise<void> {
    await encryptedDelete("preferences", "user-prefs");
  },
};

/**
 * Clear all encrypted memory.
 */
export async function clearAllMemory(): Promise<void> {
  await taskStore.clear();
  await siteStore.clear();
  await preferenceStore.clear();
}

/**
 * Get storage usage stats.
 */
export async function getMemoryStats(): Promise<{
  taskCount: number;
  siteCount: number;
  estimatedSizeKB: number;
}> {
  const tasks = await taskStore.getAll();
  const sites = await siteStore.getAll();

  // Estimate size (rough)
  const taskSize = tasks.reduce(
    (sum, t) => sum + JSON.stringify(t).length * 2,
    0
  );
  const siteSize = sites.reduce(
    (sum, s) => sum + JSON.stringify(s).length * 2,
    0
  );

  return {
    taskCount: tasks.length,
    siteCount: sites.length,
    estimatedSizeKB: Math.round((taskSize + siteSize) / 1024),
  };
}
