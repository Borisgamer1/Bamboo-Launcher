import { API_BASE, getLauncherHeaders } from "./api";

// ===== Types =====
export interface ContentTypeInfo {
  id: string;
  slug: string;
  name: string;
  description: string;
  currentVersion: number;
  isActive: boolean;
  filePattern: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContentManifestFile {
  id: string;
  contentTypeId: string;
  filePath: string;
  fileHash: string;
  fileSize: number;
  version: number;
  mimeType: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContentManifest {
  type: ContentTypeInfo;
  files: ContentManifestFile[];
}

export interface ContentCheckResult {
  updates: {
    typeSlug: string;
    currentVersion: number;
    files: ContentManifestFile[];
  }[];
  upToDate: boolean;
  checkedAt: string;
}

export interface ContentSyncStatus {
  typeSlug: string;
  typeName: string;
  status: "idle" | "checking" | "downloading" | "verifying" | "complete" | "error";
  progress: number;
  total: number;
  currentFile: string;
  version?: number;
  error?: string;
}

export interface SyncProgress {
  typeSlug: string;
  typeName: string;
  currentFile: string;
  filesComplete: number;
  filesTotal: number;
  bytesDownloaded: number;
  bytesTotal: number;
  percent: number;
}

export type ContentSyncState = "idle" | "checking" | "syncing" | "complete" | "error";

// ===== Types that map to the content types =====
export const CONTENT_TYPE_SLUGS = [
  "cosmetics",
  "news",
  "banners",
  "events",
  "themes",
  "assets",
] as const;

export type ContentTypeSlug = (typeof CONTENT_TYPE_SLUGS)[number];

// ===== Local storage keys =====
const STORAGE_KEY_VERSIONS = "bamboo-content-versions";
const STORAGE_KEY_LAST_SYNC = "bamboo-content-last-sync";
const STORAGE_KEY_MANIFEST_CACHE = "bamboo-content-manifest-cache";

// ===== Configuration =====
const CONFIG = {
  /** Max retries per failed download */
  maxRetries: 3,
  /** Delay between retries (ms) */
  retryDelay: 1000,
  /** Initial delay before auto-sync on startup (ms) */
  initialSyncDelay: 2000,
  /** Whether to sync on startup */
  autoSyncOnStartup: true,
  /** Background sync interval when idle (ms) - 5 minutes */
  backgroundSyncInterval: 5 * 60 * 1000,
  /** Timeout for individual file downloads (ms) */
  downloadTimeout: 30000,
};

// ===== ContentSyncService Singleton =====
class ContentSyncService {
  private _state: ContentSyncState = "idle";
  private _statusMap: Map<string, ContentSyncStatus> = new Map();
  private _overallProgress: number = 0;
  private _listeners: Set<() => void> = new Set();
  private _autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private _bgSyncInterval: ReturnType<typeof setInterval> | null = null;

  // ===== Getters =====
  get state() {
    return this._state;
  }

  get overallProgress() {
    return this._overallProgress;
  }

  get statuses(): ContentSyncStatus[] {
    return Array.from(this._statusMap.values());
  }

  /** Get status for a specific content type */
  getTypeStatus(slug: string): ContentSyncStatus | undefined {
    return this._statusMap.get(slug);
  }

  /** True if sync is currently running */
  get isActive(): boolean {
    return this._state === "checking" || this._state === "syncing";
  }

  // ===== Observer pattern =====
  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify() {
    this._listeners.forEach((fn) => fn());
  }

  private setState(state: ContentSyncState) {
    this._state = state;
    this.notify();
  }

  private setTypeStatus(slug: string, status: Partial<ContentSyncStatus>) {
    const existing = this._statusMap.get(slug) || {
      typeSlug: slug,
      typeName: slug,
      status: "idle" as const,
      progress: 0,
      total: 0,
      currentFile: "",
    };
    this._statusMap.set(slug, { ...existing, ...status });
    this.notify();
  }

  // ===== Local version tracking =====
  getLocalVersions(): Record<string, number> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_VERSIONS);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  private saveLocalVersions(versions: Record<string, number>) {
    try {
      localStorage.setItem(STORAGE_KEY_VERSIONS, JSON.stringify(versions));
    } catch {
      // Storage full - ignore
    }
  }

  updateLocalVersion(slug: string, version: number) {
    const versions = this.getLocalVersions();
    versions[slug] = version;
    this.saveLocalVersions(versions);
  }

  getLastSyncTime(): number {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_LAST_SYNC);
      return raw ? parseInt(raw, 10) : 0;
    } catch {
      return 0;
    }
  }

  private updateLastSyncTime() {
    try {
      localStorage.setItem(STORAGE_KEY_LAST_SYNC, String(Date.now()));
    } catch {
      // Ignore
    }
  }

  // ===== Manifest caching =====
  private getCachedManifest(): ContentManifest[] | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_MANIFEST_CACHE);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  private cacheManifest(manifest: ContentManifest[]) {
    try {
      localStorage.setItem(STORAGE_KEY_MANIFEST_CACHE, JSON.stringify(manifest));
    } catch {
      // Ignore
    }
  }

  // ===== API calls =====

  /** Fetch the full content manifest from the server */
  async fetchManifest(): Promise<ContentManifest[]> {
    const res = await fetch(`${API_BASE}/content/manifest`, {
      headers: getLauncherHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to fetch manifest: HTTP ${res.status}`);
    const json = await res.json();
    return json.data || [];
  }

  /** Check for updates by sending local versions to the server */
  async checkForUpdates(): Promise<ContentCheckResult> {
    const localVersions = this.getLocalVersions();
    const res = await fetch(`${API_BASE}/content/check`, {
      method: "POST",
      headers: getLauncherHeaders(),
      body: JSON.stringify({ versions: localVersions }),
    });
    if (!res.ok) throw new Error(`Failed to check updates: HTTP ${res.status}`);
    return res.json();
  }

  /** Get content types list */
  async fetchContentTypes(): Promise<ContentTypeInfo[]> {
    const res = await fetch(`${API_BASE}/content/types`, {
      headers: getLauncherHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to fetch content types: HTTP ${res.status}`);
    const json = await res.json();
    return json.data || [];
  }

  /** Download a single content file as ArrayBuffer */
  async downloadFile(
    typeSlug: string,
    filePath: string,
    signal?: AbortSignal
  ): Promise<{ data: ArrayBuffer; hash: string }> {
    const url = `${API_BASE}/content/download/${typeSlug}/${filePath}`;
    const res = await fetch(url, {
      headers: getLauncherHeaders(),
      signal,
    });
    if (!res.ok) throw new Error(`Failed to download ${filePath}: HTTP ${res.status}`);

    const hash = res.headers.get("X-Content-Hash") || "";
    const data = await res.arrayBuffer();
    return { data, hash };
  }

  /** Get the content status overview */
  async fetchStatus(): Promise<{
    status: string;
    types: { slug: string; name: string; version: number; updatedAt: string | null }[];
    totalFiles: number;
    totalSize: number;
  }> {
    const res = await fetch(`${API_BASE}/content/status`, {
      headers: getLauncherHeaders(),
    });
    if (!res.ok) throw new Error(`Failed to fetch content status: HTTP ${res.status}`);
    return res.json();
  }

  // ===== Content cache directory management =====

  /** Get the local cache directory path for a content type */
  getLocalContentPath(typeSlug: string): string {
    // In Electron, we'd use app.getPath('userData') via IPC
    // For the web renderer, we use IndexedDB/localStorage fallback
    return `bamboo-content/${typeSlug}`;
  }

  /** Get cached file as a data URL or blob URL */
  async getCachedFile(
    typeSlug: string,
    filePath: string
  ): Promise<string | null> {
    try {
      const db = await this.openDB();
      const tx = db.transaction("content", "readonly");
      const store = tx.objectStore("content");
      const key = `${typeSlug}/${filePath}`;
      const result = await new Promise<any>((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (!result) return null;

      // Create blob URL from stored data
      const blob = new Blob([result.data], { type: result.mimeType });
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  /** Check if a file exists in the local cache */
  async hasCachedFile(typeSlug: string, filePath: string): Promise<boolean> {
    try {
      const db = await this.openDB();
      const tx = db.transaction("content", "readonly");
      const store = tx.objectStore("content");
      const key = `${typeSlug}/${filePath}`;
      const count = await new Promise<number>((resolve, reject) => {
        const req = store.count(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return count > 0;
    } catch {
      return false;
    }
  }

  /** Save downloaded file to IndexedDB cache */
  private async cacheFile(
    typeSlug: string,
    filePath: string,
    data: ArrayBuffer,
    mimeType: string,
    hash: string,
    version: number
  ): Promise<void> {
    const db = await this.openDB();
    const tx = db.transaction("content", "readwrite");
    const store = tx.objectStore("content");
    const key = `${typeSlug}/${filePath}`;

    await new Promise<void>((resolve, reject) => {
      const req = store.put({
        key,
        typeSlug,
        filePath,
        data,
        mimeType,
        hash,
        version,
        cachedAt: Date.now(),
      });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /** Remove stale cached files for a content type */
  private async removeStaleFiles(
    typeSlug: string,
    validPaths: Set<string>
  ): Promise<number> {
    try {
      const db = await this.openDB();
      const tx = db.transaction("content", "readwrite");
      const store = tx.objectStore("content");
      const index = store.index("typeSlug");

      const keysToDelete: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const req = index.openCursor(IDBKeyRange.only(typeSlug));
        req.onsuccess = (event: any) => {
          const cursor = event.target?.result;
          if (cursor) {
            const entry = cursor.value;
            if (!validPaths.has(entry.filePath)) {
              keysToDelete.push(entry.key);
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        req.onerror = () => reject(req.error);
      });

      for (const k of keysToDelete) {
        store.delete(k);
      }

      return keysToDelete.length;
    } catch {
      return 0;
    }
  }

  /** Get total cached size for a content type */
  async getCachedSize(typeSlug: string): Promise<number> {
    try {
      const db = await this.openDB();
      const tx = db.transaction("content", "readonly");
      const store = tx.objectStore("content");
      const index = store.index("typeSlug");

      let totalSize = 0;
      await new Promise<void>((resolve, reject) => {
        const req = index.openCursor(IDBKeyRange.only(typeSlug));
        req.onsuccess = (event: any) => {
          const cursor = event.target?.result;
          if (cursor) {
            totalSize += cursor.value.data?.byteLength || 0;
            cursor.continue();
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

  /** Get total cache size across all types */
  async getTotalCacheSize(): Promise<number> {
    try {
      const db = await this.openDB();
      const tx = db.transaction("content", "readonly");
      const store = tx.objectStore("content");

      let totalSize = 0;
      await new Promise<void>((resolve, reject) => {
        const req = store.openCursor();
        req.onsuccess = (event: any) => {
          const cursor = event.target?.result;
          if (cursor) {
            totalSize += cursor.value.data?.byteLength || 0;
            cursor.continue();
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

  /** Clear the entire content cache */
  async clearCache(): Promise<void> {
    try {
      const db = await this.openDB();
      const tx = db.transaction("content", "readwrite");
      const store = tx.objectStore("content");
      await new Promise<void>((resolve, reject) => {
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
      this.saveLocalVersions({});
      localStorage.removeItem(STORAGE_KEY_LAST_SYNC);
      localStorage.removeItem(STORAGE_KEY_MANIFEST_CACHE);
      this._statusMap.clear();
      this.setState("idle");
    } catch {
      // Ignore
    }
  }

  // ===== IndexedDB helpers =====
  private dbPromise: Promise<IDBDatabase> | null = null;

  private async openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("BambooContentCache", 1);

      request.onupgradeneeded = (event: any) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains("content")) {
          const store = db.createObjectStore("content", { keyPath: "key" });
          store.createIndex("typeSlug", "typeSlug", { unique: false });
          store.createIndex("version", "version", { unique: false });
        }
      };

      request.onsuccess = (event: any) => resolve(event.target.result);
      request.onerror = () => reject(request.error);
    });

    return this.dbPromise;
  }

  // ===== SHA-256 hash computation =====
  private async computeHash(data: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // ===== Main sync logic =====

  /**
   * Run a full sync: check for updates, download changed files,
   * verify integrity, clean stale files.
   */
  async syncAll(onProgress?: (progress: SyncProgress) => void): Promise<{
    success: boolean;
    updated: number;
    errors: string[];
  }> {
    if (this.isActive) {
      console.warn("[ContentSync] Sync already in progress");
      return { success: false, updated: 0, errors: ["Sync already in progress"] };
    }

    const errors: string[] = [];
    let totalUpdated = 0;

    try {
      this.setState("checking");

      // Step 1: Get the full manifest
      const manifest = await this.fetchManifest();
      this.cacheManifest(manifest);

      // Step 2: Check for updates per type
      const checkResult = await this.checkForUpdates();
      const updates = checkResult.updates;

      // If no updates, we're done
      if (updates.length === 0) {
        this.setState("complete");
        this.updateLastSyncTime();
        for (const m of manifest) {
          this.setTypeStatus(m.type.slug, {
            status: "complete",
            progress: 100,
            total: 0,
            currentFile: "",
          });
        }
        this._overallProgress = 100;
        return { success: true, updated: 0, errors: [] };
      }

      this.setState("syncing");

      // Step 3: Download updates for each content type
      let totalFiles = 0;
      let completedFiles = 0;
      let totalBytes = 0;
      let downloadedBytes = 0;

      // Count totals
      for (const update of updates) {
        totalFiles += update.files.length;
        for (const file of update.files) {
          totalBytes += file.fileSize;
        }
      }

      // Update progress for all types
      for (const update of updates) {
        const typeName =
          manifest.find((m) => m.type.slug === update.typeSlug)?.type.name ||
          update.typeSlug;
        this.setTypeStatus(update.typeSlug, {
          typeName,
          status: "downloading",
          progress: 0,
          total: update.files.length,
          currentFile: "",
        });
      }

      // Build valid paths set for cleanup
      const validPathsByType = new Map<string, Set<string>>();

      // Download each file with retry support
      for (const update of updates) {
        const typeName =
          manifest.find((m) => m.type.slug === update.typeSlug)?.type.name ||
          update.typeSlug;
        const validPaths = new Set<string>();
        validPathsByType.set(update.typeSlug, validPaths);

        for (let i = 0; i < update.files.length; i++) {
          const file = update.files[i];
          validPaths.add(file.filePath);

          let retries = 0;
          let success = false;

          while (retries <= CONFIG.maxRetries && !success) {
            try {
              this.setTypeStatus(update.typeSlug, {
                currentFile: file.filePath,
                progress: Math.round((i / update.files.length) * 100),
              });

              const controller = new AbortController();
              const timeoutId = setTimeout(
                () => controller.abort(),
                CONFIG.downloadTimeout
              );

              const { data, hash } = await this.downloadFile(
                update.typeSlug,
                file.filePath,
                controller.signal
              );
              clearTimeout(timeoutId);

              // Verify integrity
              this.setTypeStatus(update.typeSlug, { status: "verifying" });

      if (!hash || hash.startsWith("placeholder-")) {
        // No valid hash from server, skip verification
      } else {
                const computedHash = await this.computeHash(data);
                if (computedHash !== hash) {
                  throw new Error(
                    `Hash mismatch for ${file.filePath}: expected ${hash}, got ${computedHash}`
                  );
                }
              }

              // Cache the file
              await this.cacheFile(
                update.typeSlug,
                file.filePath,
                data,
                file.mimeType,
                hash,
                update.currentVersion
              );

              downloadedBytes += data.byteLength;
              completedFiles++;
              totalUpdated++;

              // Report progress
              const percent = Math.round(
                ((completedFiles) / totalFiles) * 100
              );
              this._overallProgress = percent;

              if (onProgress) {
                onProgress({
                  typeSlug: update.typeSlug,
                  typeName,
                  currentFile: file.filePath,
                  filesComplete: completedFiles,
                  filesTotal: totalFiles,
                  bytesDownloaded: downloadedBytes,
                  bytesTotal: totalBytes,
                  percent,
                });
              }

              success = true;
            } catch (err: any) {
              retries++;
              if (retries > CONFIG.maxRetries) {
                const errorMsg = `Failed to download ${file.filePath} after ${CONFIG.maxRetries} retries: ${err.message}`;
                errors.push(errorMsg);
                console.error(`[ContentSync] ${errorMsg}`);
                this.setTypeStatus(update.typeSlug, {
                  status: "error",
                  error: err.message,
                });
              } else {
                // Wait before retry
                await new Promise((r) =>
                  setTimeout(r, CONFIG.retryDelay * retries)
                );
              }
            }
          }
        }

        // Update local version for this type
        this.updateLocalVersion(update.typeSlug, update.currentVersion);

        this.setTypeStatus(update.typeSlug, {
          status: "complete",
          progress: 100,
          currentFile: "",
        });
      }

      // Step 4: Clean stale files from cache
      for (const [typeSlug, validPaths] of validPathsByType) {
        const removed = await this.removeStaleFiles(typeSlug, validPaths);
        if (removed > 0) {
          console.log(
            `[ContentSync] Removed ${removed} stale files for ${typeSlug}`
          );
        }
      }

      // Step 5: Update timestamps
      this.updateLastSyncTime();
      this._overallProgress = 100;

      const hasErrors = errors.length > 0;
      this.setState(hasErrors ? "error" : "complete");

      return {
        success: !hasErrors,
        updated: totalUpdated,
        errors,
      };
    } catch (err: any) {
      const msg = `Sync failed: ${err.message}`;
      errors.push(msg);
      console.error(`[ContentSync] ${msg}`);
      this.setState("error");
      return { success: false, updated: totalUpdated, errors };
    }
  }

  /** Sync just a single content type */
  async syncType(typeSlug: string): Promise<boolean> {
    try {
      const manifest = await this.fetchManifest();
      const typeManifest = manifest.find((m) => m.type.slug === typeSlug);
      if (!typeManifest) {
        console.warn(`[ContentSync] Unknown content type: ${typeSlug}`);
        return false;
      }

      this.setTypeStatus(typeSlug, {
        typeName: typeManifest.type.name,
        status: "downloading",
        progress: 0,
        total: typeManifest.files.length,
        currentFile: "",
      });

      const validPaths = new Set<string>();
      let completed = 0;

      for (const file of typeManifest.files) {
        validPaths.add(file.filePath);

        try {
          this.setTypeStatus(typeSlug, { currentFile: file.filePath });

          const controller = new AbortController();
          const timeoutId = setTimeout(
            () => controller.abort(),
            CONFIG.downloadTimeout
          );

          const { data, hash } = await this.downloadFile(
            typeSlug,
            file.filePath,
            controller.signal
          );
          clearTimeout(timeoutId);

          await this.cacheFile(
            typeSlug,
            file.filePath,
            data,
            file.mimeType,
            hash,
            typeManifest.type.currentVersion
          );

          completed++;
          this.setTypeStatus(typeSlug, {
            progress: Math.round((completed / typeManifest.files.length) * 100),
          });
        } catch (err: any) {
          console.error(
            `[ContentSync] Failed to download ${file.filePath}: ${err.message}`
          );
        }
      }

      // Clean stale
      await this.removeStaleFiles(typeSlug, validPaths);

      // Update version
      this.updateLocalVersion(typeSlug, typeManifest.type.currentVersion);

      this.setTypeStatus(typeSlug, {
        status: "complete",
        progress: 100,
        currentFile: "",
      });

      return true;
    } catch (err: any) {
      this.setTypeStatus(typeSlug, {
        status: "error",
        error: err.message,
      });
      return false;
    }
  }

  // ===== Auto-sync & background sync =====

  /** Start auto-sync on application launch */
  startAutoSync(): void {
    if (!CONFIG.autoSyncOnStartup) return;

    // Delay initial sync to let the UI render first
    this._autoSyncTimer = setTimeout(async () => {
      try {
        await this.syncAll();
      } catch (err) {
        console.error("[ContentSync] Auto-sync failed:", err);
      }

      // Start background interval
      this._bgSyncInterval = setInterval(async () => {
        try {
          const check = await this.checkForUpdates();
          if (!check.upToDate) {
            console.log(
              "[ContentSync] Background check found updates, syncing..."
            );
            await this.syncAll();
          }
        } catch {
          // Silently fail on background checks
        }
      }, CONFIG.backgroundSyncInterval);
    }, CONFIG.initialSyncDelay);
  }

  /** Stop auto-sync and background sync */
  stopAutoSync(): void {
    if (this._autoSyncTimer) {
      clearTimeout(this._autoSyncTimer);
      this._autoSyncTimer = null;
    }
    if (this._bgSyncInterval) {
      clearInterval(this._bgSyncInterval);
      this._bgSyncInterval = null;
    }
  }

  /** Check if there are pending updates (non-blocking) */
  async hasPendingUpdates(): Promise<boolean> {
    try {
      const result = await this.checkForUpdates();
      return !result.upToDate;
    } catch {
      return false;
    }
  }

  /** Get a summary of local cache state */
  async getCacheSummary(): Promise<{
    types: { slug: string; name: string; localVersion: number; fileCount: number }[];
    totalFiles: number;
    totalSize: number;
    lastSync: number;
  }> {
    const localVersions = this.getLocalVersions();
    const lastSync = this.getLastSyncTime();
    const totalSize = await this.getTotalCacheSize();

    const types = [];
    let totalFiles = 0;

    try {
      const manifest = this.getCachedManifest();
      if (manifest) {
        for (const m of manifest) {
          const ver = localVersions[m.type.slug] || 0;
          types.push({
            slug: m.type.slug,
            name: m.type.name,
            localVersion: ver,
            fileCount: m.files.length,
          });
          totalFiles += m.files.length;
        }
      }
    } catch {
      // Ignore
    }

    return { types, totalFiles, totalSize, lastSync };
  }
}

// ===== Singleton export =====
export const contentSyncService = new ContentSyncService();
export default contentSyncService;
