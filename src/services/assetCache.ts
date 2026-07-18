// ============================================================
// Asset Cache Service v1.0.0
// IndexedDB-backed local asset cache with hash-based
// integrity verification and blob URL generation.
// ============================================================

import type { ManifestFile, AssetCacheState, CachedFileEntry } from "./assetManifest";
import { EMPTY_CACHE_STATE } from "./assetManifest";

// ===== IndexedDB Setup =====

const DB_NAME = "BambooAssetCache";
const DB_VERSION = 1;
const STORE_NAME = "assets";
const META_STORE = "meta";

interface MetaEntry {
  key: string;
  value: unknown;
}

interface AssetEntry {
  path: string;
  data: ArrayBuffer;
  mimeType: string;
  hash: string;
  size: number;
  version: number;
  cachedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
      const db = (event.target as IDBOpenDBRequest).result;

      // Main asset store
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "path" });
        store.createIndex("hash", "hash", { unique: false });
        store.createIndex("version", "version", { unique: false });
        store.createIndex("cachedAt", "cachedAt", { unique: false });
      }

      // Metadata store for cache state
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = (event: Event) => {
      resolve((event.target as IDBOpenDBRequest).result);
    };

    request.onerror = () => {
      reject(request.error || new Error("Failed to open IndexedDB"));
    };

    request.onblocked = () => {
      console.warn("[AssetCache] IndexedDB upgrade blocked - close other tabs");
    };
  });

  return dbPromise;
}

// ===== Cache State Management =====

const META_CACHE_STATE = "cacheState";

/** Load the full cache state from IndexedDB */
export async function getCacheState(): Promise<AssetCacheState> {
  try {
    const db = await openDB();
    const tx = db.transaction(META_STORE, "readonly");
    const store = tx.objectStore(META_STORE);
    const result = await promisifyRequest<MetaEntry>(store.get(META_CACHE_STATE));

    if (result && typeof result.value === "object") {
      return result.value as AssetCacheState;
    }
    return { ...EMPTY_CACHE_STATE };
  } catch (err) {
    console.warn("[AssetCache] Failed to read cache state:", err);
    return { ...EMPTY_CACHE_STATE };
  }
}

/** Save the full cache state to IndexedDB */
export async function saveCacheState(state: AssetCacheState): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(META_STORE, "readwrite");
    const store = tx.objectStore(META_STORE);
    await promisifyRequest(store.put({ key: META_CACHE_STATE, value: state }));
  } catch (err) {
    console.warn("[AssetCache] Failed to save cache state:", err);
  }
}

/** Update only the per-category versions in the cache state */
export async function updateCategoryVersions(
  categoryVersions: Record<string, number>,
  manifestVersion: number
): Promise<void> {
  const state = await getCacheState();
  state.manifestVersion = manifestVersion;
  state.categoryVersions = { ...state.categoryVersions, ...categoryVersions };
  state.lastSyncAt = Date.now();
  await saveCacheState(state);
}

// ===== Asset CRUD =====

/** Store a downloaded asset in the cache */
export async function cacheAsset(
  file: ManifestFile,
  data: ArrayBuffer,
  mimeType: string,
  manifestVersion: number
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);

  const entry: AssetEntry = {
    path: file.path,
    data,
    mimeType,
    hash: file.hash,
    size: file.size,
    version: manifestVersion,
    cachedAt: Date.now(),
  };

  await promisifyRequest(store.put(entry));

  // Update cache state
  const state = await getCacheState();
  const cachedEntry: CachedFileEntry = {
    path: file.path,
    hash: file.hash,
    size: file.size,
    version: manifestVersion,
    cachedAt: Date.now(),
  };

  const existingIdx = state.files.findIndex((f) => f.path === file.path);
  if (existingIdx >= 0) {
    state.files[existingIdx] = cachedEntry;
  } else {
    state.files.push(cachedEntry);
  }

  await saveCacheState(state);
}

/** Get a cached asset by path */
export async function getCachedAsset(path: string): Promise<AssetEntry | null> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    return await promisifyRequest<AssetEntry | undefined>(store.get(path)).then((r) => r ?? null);
  } catch {
    return null;
  }
}

/** Check if a file exists in cache with the correct hash */
export async function hasCachedAsset(path: string, expectedHash?: string): Promise<boolean> {
  const entry = await getCachedAsset(path);
  if (!entry) return false;
  if (expectedHash && entry.hash !== expectedHash) return false;
  return true;
}

/** Get a cached asset as a blob URL for use in img src, etc.
 *  IMPORTANT: Caller must call revokeCachedAssetUrl(url) when done to prevent memory leaks. */
export async function getCachedAssetUrl(path: string): Promise<string | null> {
  const entry = await getCachedAsset(path);
  if (!entry) return null;
  const blob = new Blob([entry.data], { type: entry.mimeType });
  return URL.createObjectURL(blob);
}

/** Revoke a blob URL created by getCachedAssetUrl */
export function revokeCachedAssetUrl(url: string): void {
  try {
    if (url.startsWith("blob:")) {
      URL.revokeObjectURL(url);
    }
  } catch {
    // Ignore revoke errors
  }
}

/** Get a cached asset as a data URL (no cleanup needed, unlike blob URLs) */
export async function getCachedAssetDataUrl(path: string): Promise<string | null> {
  const entry = await getCachedAsset(path);
  if (!entry) return null;
  const blob = new Blob([entry.data], { type: entry.mimeType });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/** Get cached asset as raw text (for JSON configs, etc.) */
export async function getCachedAssetText(path: string): Promise<string | null> {
  const entry = await getCachedAsset(path);
  if (!entry) return null;
  const decoder = new TextDecoder("utf-8");
  return decoder.decode(entry.data);
}

/** Delete a specific asset from cache */
export async function deleteCachedAsset(path: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  await promisifyRequest(store.delete(path));

  const state = await getCacheState();
  state.files = state.files.filter((f) => f.path !== path);
  await saveCacheState(state);
}

/** Delete multiple stale assets */
export async function deleteStaleAssets(paths: string[]): Promise<number> {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);

  let count = 0;
  for (const path of paths) {
    await promisifyRequest(store.delete(path));
    count++;
  }

  const state = await getCacheState();
  state.files = state.files.filter((f) => !paths.includes(f.path));
  await saveCacheState(state);

  return count;
}

// ===== Cache Statistics =====

/** Get total size of all cached assets */
export async function getTotalCacheSize(): Promise<number> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);

    let totalSize = 0;
    const cursor = store.openCursor();
    await new Promise<void>((resolve, reject) => {
      const req = cursor;
      req.onsuccess = (event: Event) => {
        const c = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (c) {
          totalSize += (c.value as AssetEntry).size;
          c.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => reject(req.error);
    });
    return totalSize;
  } catch {
    return 0;
  }
}

/** Get count of cached files */
export async function getCachedFileCount(): Promise<number> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    return await promisifyRequest<number>(store.count());
  } catch {
    return 0;
  }
}

/** Clear the entire asset cache */
export async function clearCache(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    await promisifyRequest(store.clear());

    const metaTx = db.transaction(META_STORE, "readwrite");
    const metaStore = metaTx.objectStore(META_STORE);
    await promisifyRequest(metaStore.delete(META_CACHE_STATE));

    console.log("[AssetCache] Cache cleared");
  } catch (err) {
    console.warn("[AssetCache] Failed to clear cache:", err);
  }
}

// ===== SHA-256 Verification =====

/** Compute SHA-256 hash of an ArrayBuffer */
export async function computeHash(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Verify that data matches an expected hash */
export async function verifyHash(data: ArrayBuffer, expectedHash: string): Promise<boolean> {
  const hash = await computeHash(data);
  return hash === expectedHash;
}

// ===== Helpers =====

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Get the MIME type for a file based on its extension */
export function getMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "ico":
      return "image/x-icon";
    case "gif":
      return "image/gif";
    case "json":
      return "application/json";
    case "glb":
      return "model/gltf-binary";
    case "gltf":
      return "model/gltf+json";
    case "ttf":
      return "font/ttf";
    case "otf":
      return "font/otf";
    case "woff":
      return "font/woff";
    case "woff2":
      return "font/woff2";
    case "mp3":
      return "audio/mpeg";
    case "ogg":
      return "audio/ogg";
    case "wav":
      return "audio/wav";
    case "css":
      return "text/css";
    case "js":
      return "application/javascript";
    case "html":
      return "text/html";
    case "txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}
