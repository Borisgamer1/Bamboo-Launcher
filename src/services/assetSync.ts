// ============================================================
// Asset Sync Engine v2.0.0
// Diff-based synchronization: compares local cache with
// remote CDN manifest and downloads only changed files.
// Uses DownloadManager for queue-based downloads.
// ============================================================

import {
  type AssetManifest,
  type SyncProgress,
  type SyncResult,
  computeManifestDiff,
} from "./assetManifest";
import { fetchManifest } from "./githubCdn";
import {
  getCacheState,
  saveCacheState,
  deleteStaleAssets,
} from "./assetCache";
import {
  setLocalManifestVersion,
  setLastSyncTime,
  deleteAssetStatus,
} from "./assetDatabase";
import { downloadManager } from "./downloadManager";

// ===== Configuration =====

const CONFIG = {
  /** Delay before auto-sync on startup (ms) */
  initialSyncDelay: 2500,
  /** Whether to sync on startup */
  autoSync: true,
  /** Background sync interval (ms) — 30 minutes */
  backgroundSyncInterval: 30 * 60 * 1000,
};

// ===== Sync Engine Singleton =====

class AssetSyncEngine {
  private _syncing = false;
  private _autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private _bgInterval: ReturnType<typeof setInterval> | null = null;
  private _listeners: Set<() => void> = new Set();

  get isSyncing(): boolean {
    return this._syncing;
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify(): void {
    this._listeners.forEach((fn) => fn());
  }

  /**
   * Run a full synchronization cycle:
   * 1. Fetch remote manifest
   * 2. Compare with local cache state
   * 3. Download only changed/new files via DownloadManager
   * 4. Delete stale files
   * 5. Update local cache state
   */
  async sync(
    onProgress?: (progress: SyncProgress) => void
  ): Promise<SyncResult> {
    if (this._syncing) {
      return {
        success: false,
        filesDownloaded: 0,
        filesDeleted: 0,
        bytesDownloaded: 0,
        errors: ["Sync already in progress"],
        manifestVersion: 0,
      };
    }

    this._syncing = true;
    this.notify();

    const errors: string[] = [];
    let filesDownloaded = 0;
    let filesDeleted = 0;
    let bytesDownloaded = 0;

    try {
      // Step 1: Fetch remote manifest
      reportProgress(onProgress, {
        phase: "comparing",
        filesDone: 0,
        filesTotal: 0,
        bytesDone: 0,
        bytesTotal: 0,
        currentFile: "manifest.json",
        percent: 5,
      });

      let manifest: AssetManifest;
      try {
        manifest = await fetchManifest();
      } catch (err: any) {
        errors.push(`Failed to fetch manifest: ${err.message}`);
        return buildResult(false, 0, 0, 0, errors, 0);
      }

      // Step 2: Compare
      const localState = await getCacheState();
      const diff = computeManifestDiff(manifest, localState);

      reportProgress(onProgress, {
        phase: "comparing",
        filesDone: 0,
        filesTotal: diff.toDownload.length,
        bytesDone: 0,
        bytesTotal: diff.bytesToDownload,
        currentFile: "",
        percent: 10,
      });

      // No changes needed
      if (diff.toDownload.length === 0 && diff.toDelete.length === 0) {
        localState.manifestVersion = manifest.version;
        localState.lastSyncAt = Date.now();
        await saveCacheState(localState);
        await setLocalManifestVersion(manifest.version);
        await setLastSyncTime(Date.now());

        reportProgress(onProgress, {
          phase: "complete",
          filesDone: 0,
          filesTotal: 0,
          bytesDone: 0,
          bytesTotal: 0,
          currentFile: "",
          percent: 100,
        });

        this._syncing = false;
        this.notify();
        return buildResult(true, 0, 0, 0, [], manifest.version);
      }

      // Step 3: Download changed/new files using DownloadManager
      reportProgress(onProgress, {
        phase: "downloading",
        filesDone: 0,
        filesTotal: diff.toDownload.length,
        bytesDone: 0,
        bytesTotal: diff.bytesToDownload,
        currentFile: "",
        percent: 15,
      });

      // Set up overall progress tracking
      downloadManager.onOverallProgress((queueProgress) => {
        reportProgress(onProgress, {
          phase: "downloading",
          filesDone: queueProgress.tasksComplete,
          filesTotal: diff.toDownload.length,
          bytesDone: queueProgress.bytesDownloaded,
          bytesTotal: diff.bytesToDownload,
          currentFile: queueProgress.currentFile,
          percent: 15 + Math.round(queueProgress.percent * 0.7),
        });
      });

      // Enqueue all files for download
      const taskIds = downloadManager.enqueueBatch(diff.toDownload, "normal");

      // Wait for all downloads to complete
      await this.waitForDownloadManager(diff.toDownload.length);

      // Tally results
      for (const taskId of taskIds) {
        const task = downloadManager.getTask(taskId);
        if (!task) continue;

        if (task.state === "complete") {
          filesDownloaded++;
          bytesDownloaded += task.file.size;
        } else if (task.state === "failed") {
          errors.push(`${task.file.path}: ${task.error || "Download failed"}`);
        }
      }

      // Step 4: Delete stale files
      reportProgress(onProgress, {
        phase: "cleaning",
        filesDone: filesDownloaded,
        filesTotal: diff.toDownload.length,
        bytesDone: bytesDownloaded,
        bytesTotal: diff.bytesToDownload,
        currentFile: "",
        percent: 90,
      });

      if (diff.toDelete.length > 0) {
        filesDeleted = await deleteStaleAssets(diff.toDelete);
        // Also clean up new status store entries
        for (const path of diff.toDelete) {
          await deleteAssetStatus(path).catch(() => {});
        }
      }

      // Step 5: Update cache state
      await saveCacheState({
        ...localState,
        manifestVersion: manifest.version,
        lastSyncAt: Date.now(),
      });
      await setLocalManifestVersion(manifest.version);
      await setLastSyncTime(Date.now());

      reportProgress(onProgress, {
        phase: "complete",
        filesDone: filesDownloaded,
        filesTotal: diff.toDownload.length,
        bytesDone: bytesDownloaded,
        bytesTotal: diff.bytesToDownload,
        currentFile: "",
        percent: 100,
      });

      const hasErrors = errors.length > 0;
      return buildResult(
        !hasErrors,
        filesDownloaded,
        filesDeleted,
        bytesDownloaded,
        errors,
        manifest.version
      );
    } catch (err: any) {
      errors.push(`Sync engine error: ${err.message}`);
      return buildResult(false, filesDownloaded, filesDeleted, bytesDownloaded, errors, 0);
    } finally {
      this._syncing = false;
      this.notify();
    }
  }

  /** Wait for the DownloadManager to finish processing all queued downloads */
  private async waitForDownloadManager(expectedTotal: number): Promise<void> {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        const tasks = downloadManager.tasks;
        const active = tasks.filter((t) =>
          t.state === "queued" || t.state === "downloading"
        ).length;

        if (active === 0 && !downloadManager.isRunning) {
          clearInterval(check);
          resolve();
        }
      }, 200);
    });
  }

  /**
   * Quick check: is there a newer manifest version available?
   */
  async hasUpdates(): Promise<boolean> {
    try {
      const manifest = await fetchManifest();
      const localState = await getCacheState();
      if (manifest.version === 0) return false;
      return localState.manifestVersion < manifest.version;
    } catch {
      return false;
    }
  }

  // ===== Auto Sync =====

  /** Start auto-sync on app launch */
  startAutoSync(): void {
    if (!CONFIG.autoSync) return;

    this._autoSyncTimer = setTimeout(async () => {
      try {
        const result = await this.sync();
        if (result.filesDownloaded > 0) {
          console.log(
            `[AssetSync] Auto-sync: ${result.filesDownloaded} files, ${result.errors.length} errors`
          );
        }
      } catch (err) {
        console.warn("[AssetSync] Auto-sync failed:", err);
      }

      // Start background interval
      this._bgInterval = setInterval(async () => {
        try {
          const hasUpdates = await this.hasUpdates();
          if (hasUpdates) {
            console.log("[AssetSync] Background sync: updates found");
            await this.sync();
          }
        } catch {
          // Silently fail on background sync
        }
      }, CONFIG.backgroundSyncInterval);
    }, CONFIG.initialSyncDelay);
  }

  /** Stop auto-sync */
  stopAutoSync(): void {
    if (this._autoSyncTimer) {
      clearTimeout(this._autoSyncTimer);
      this._autoSyncTimer = null;
    }
    if (this._bgInterval) {
      clearInterval(this._bgInterval);
      this._bgInterval = null;
    }
  }
}

// ===== Helpers =====

function reportProgress(
  callback: ((progress: SyncProgress) => void) | undefined,
  progress: SyncProgress
): void {
  if (callback) {
    try {
      callback(progress);
    } catch {
      // Don't let progress callback errors break sync
    }
  }
}

function buildResult(
  success: boolean,
  filesDownloaded: number,
  filesDeleted: number,
  bytesDownloaded: number,
  errors: string[],
  manifestVersion: number
): SyncResult {
  return {
    success,
    filesDownloaded,
    filesDeleted,
    bytesDownloaded,
    errors,
    manifestVersion,
  };
}

// ===== Singleton Export =====

export const assetSyncEngine = new AssetSyncEngine();
export default assetSyncEngine;
