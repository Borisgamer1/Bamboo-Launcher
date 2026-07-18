// ============================================================
// Asset Manager v2.0.0
// Central orchestrator for the entire asset system.
// Wraps sync, integrity checking, repair, and provides
// a unified health monitoring API.
// ============================================================

import type { ManifestFile } from "./assetManifest";
import type {
  AssetCategory,
  AssetInfo,
  AssetHealthSummary,
  CheckupResult,
  SyncResult,
  IntegrityReport,
  RepairResult,
  SyncProgress,
} from "./assetManifest";
import { EMPTY_HEALTH_SUMMARY, getCategoryFromPath } from "./assetManifest";
import { fetchManifest } from "./githubCdn";
import {
  getLocalManifestVersion,
  setLocalManifestVersion,
  getLastSyncTime,
  setLastSyncTime,
  buildAssetInfo,
  storeAssetData,
  getAssetData,
  deleteAssetData,
  getAssetStatus,
  getAllAssetStatuses,
  markDownloading,
  markCached,
  markMissing,
  markDamaged,
  getStatusCounts,
  getTotalDataSize,
  clearAll,
} from "./assetDatabase";
import { downloadManager } from "./downloadManager";
import { integrityChecker } from "./integrityChecker";
import { assetSyncEngine } from "./assetSync";

// ===== Asset Manager =====

class AssetManager {
  private _syncing = false;
  private _checking = false;
  private _repairing = false;
  private _listeners: Set<() => void> = new Set();

  // ===== State =====

  get isSyncing(): boolean { return this._syncing; }
  get isCheckingIntegrity(): boolean { return this._checking; }
  get isRepairing(): boolean { return this._repairing; }
  get isBusy(): boolean { return this._syncing || this._checking || this._repairing; }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify(): void {
    this._listeners.forEach((fn) => fn());
  }

  // ===== Sync =====

  /**
   * Run a full sync cycle: fetch manifest, compare, download changed files.
   * Delegates to AssetSyncEngine but with enhanced progress reporting.
   */
  async sync(
    onProgress?: (progress: SyncProgress) => void
  ): Promise<SyncResult> {
    this._syncing = true;
    this.notify();

    try {
      const result = await assetSyncEngine.sync(onProgress);
      if (result.success) {
        await setLastSyncTime(Date.now());
      }
      return result;
    } finally {
      this._syncing = false;
      this.notify();
    }
  }

  /**
   * Check if a newer manifest version is available on the CDN.
   */
  async hasUpdates(): Promise<boolean> {
    return assetSyncEngine.hasUpdates();
  }

  /**
   * Get the current local manifest version.
   */
  getLocalVersion(): Promise<number> {
    return getLocalManifestVersion();
  }

  /**
   * Get the remote manifest version (fetches from CDN).
   * Returns null if the CDN is unreachable.
   */
  async getRemoteVersion(): Promise<number | null> {
    try {
      const manifest = await fetchManifest();
      return manifest.version;
    } catch {
      return null;
    }
  }

  // ===== Integrity =====

  /**
   * Run a full integrity check on all locally cached assets.
   * Compares against the remote manifest.
   */
  async checkIntegrity(
    onProgress?: (checked: number, total: number, currentFile: string) => void
  ): Promise<IntegrityReport> {
    this._checking = true;
    this.notify();

    try {
      const manifest = await fetchManifest();
      return await integrityChecker.checkAll(manifest.files, onProgress);
    } finally {
      this._checking = false;
      this.notify();
    }
  }

  /**
   * Quick check: verify a single file.
   */
  async checkFile(path: string, expectedHash: string, expectedSize: number): Promise<boolean> {
    return integrityChecker.isHealthy(path, expectedHash, expectedSize);
  }

  // ===== Repair (Self-Healing) =====

  /**
   * Repair all damaged or missing assets automatically.
   * Fetches the manifest, identifies damaged files, and re-downloads them.
   */
  async repair(
    onProgress?: (repaired: number, total: number, currentFile: string) => void
  ): Promise<RepairResult> {
    this._repairing = true;
    this.notify();

    try {
      // First check what's damaged
      const manifest = await fetchManifest();
      const report = await integrityChecker.checkAll(manifest.files);

      // Collect damaged files from the report and match with manifest entries
      const manifestMap = new Map<string, ManifestFile>();
      for (const f of manifest.files) {
        manifestMap.set(f.path, f);
      }

      const damagedFiles: ManifestFile[] = [];
      for (const fileResult of report.files) {
        if (!fileResult.healthy) {
          const manifestFile = manifestMap.get(fileResult.path);
          if (manifestFile) {
            damagedFiles.push(manifestFile);
          } else if (fileResult.path) {
            // Stale file - delete it instead of repairing
            await deleteAssetData(fileResult.path).catch(() => {});
          }
        }
      }

      if (damagedFiles.length === 0) {
        return { repaired: 0, failed: 0, details: [], allRepaired: true };
      }

      return await integrityChecker.repairAll(damagedFiles, onProgress);
    } finally {
      this._repairing = false;
      this.notify();
    }
  }

  // ===== Full Checkup =====

  /**
   * Run a complete checkup: sync → integrity check → repair if needed.
   * This is the recommended maintenance operation.
   */
  async fullCheckup(
    onProgress?: (phase: string, detail: string) => void
  ): Promise<CheckupResult> {
    // Phase 1: Sync with CDN
    if (onProgress) onProgress("sync", "Checking for updates...");
    const syncResult = await this.sync();

    // Phase 2: Integrity check
    if (onProgress) onProgress("integrity", "Verifying local assets...");
    const integrityReport = await this.checkIntegrity();

    // Phase 3: Repair if needed
    let repairResult: RepairResult | null = null;
    if (!integrityReport.allHealthy) {
      if (onProgress) onProgress("repair", `Repairing ${integrityReport.failed} damaged files...`);
      repairResult = await this.repair();
    }

    // Build health summary
    const health = await this.getHealthSummary();

    if (onProgress) onProgress("complete", "Checkup complete");

    return {
      sync: syncResult,
      integrity: integrityReport,
      repair: repairResult,
      health,
      allHealthy: health.healthPercent >= 100,
    };
  }

  // ===== Health Summary =====

  /**
   * Build a comprehensive health summary of all assets.
   */
  async getHealthSummary(): Promise<AssetHealthSummary> {
    const localVersion = await getLocalManifestVersion();
    const remoteVersion = await this.getRemoteVersion();
    const counts = await getStatusCounts();
    const lastSync = await getLastSyncTime();

    const totalTracked =
      counts.ok + counts.damaged + counts.missing + counts.downloading + counts.pending;

    const summary: AssetHealthSummary = {
      totalManifestFiles: totalTracked,
      healthy: counts.ok,
      damaged: counts.damaged,
      missing: counts.missing,
      downloading: counts.downloading,
      stale: counts.stale || 0,
      pending: counts.pending,
      healthPercent: totalTracked > 0 ? Math.round((counts.ok / totalTracked) * 100) : 0,
      localVersion,
      remoteVersion: remoteVersion ?? 0,
      updateAvailable: remoteVersion !== null && remoteVersion > localVersion,
      repairNeeded: counts.damaged > 0 || counts.missing > 0,
      checkedAt: Date.now(),
    };

    return summary;
  }

  // ===== Asset Info =====

  /**
   * Get detailed info about a single cached asset.
   */
  async getAssetInfo(path: string): Promise<AssetInfo> {
    return buildAssetInfo(path);
  }

  /**
   * Get all cached asset paths.
   */
  async getAllAssetPaths(): Promise<string[]> {
    const statuses = await getAllAssetStatuses();
    return statuses.map((s) => s.path);
  }

  /**
   * Get assets by category.
   */
  async getAssetsByCategory(category: AssetCategory): Promise<AssetInfo[]> {
    const allPaths = await this.getAllAssetPaths();
    const infos: AssetInfo[] = [];

    for (const path of allPaths) {
      const cat = getCategoryFromPath(path);
      if (cat === category) {
        infos.push(await buildAssetInfo(path));
      }
    }

    return infos;
  }

  // ===== Cache Statistics =====

  /**
   * Get the total size of all cached assets in bytes.
   */
  async getTotalCacheSize(): Promise<number> {
    return getTotalDataSize();
  }

  /**
   * Format bytes into a human-readable string.
   */
  formatSize(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  // ===== Lifecycle =====

  /**
   * Start auto-sync and self-healing background maintenance.
   * Runs sequentially: sync → self-heal (integrity check + auto-repair).
   */
  startAutoSync(): void {
    // Subscribe to sync engine to run self-heal AFTER sync completes
    let selfHealScheduled = false;
    const runSelfHeal = async () => {
      if (selfHealScheduled) return;
      selfHealScheduled = true;

      // Wait a moment to ensure sync is truly done
      await new Promise(r => setTimeout(r, 2000));

      try {
        console.log("[AssetManager] Running self-heal check...");
        const health = await this.getHealthSummary();
        if (health.repairNeeded) {
          console.log(
            `[AssetManager] Self-heal: ${health.damaged} damaged, ${health.missing} missing - repairing...`
          );
          const repairResult = await this.repair();
          console.log(
            `[AssetManager] Self-heal complete: ${repairResult.repaired} repaired, ${repairResult.failed} failed`
          );
        } else {
          console.log("[AssetManager] Self-heal: all assets healthy");
        }
      } catch (err) {
        console.warn("[AssetManager] Self-heal failed:", err);
      }
    };

    // Override assetSyncEngine's startAutoSync to chain self-heal after it
    const originalStartAutoSync = assetSyncEngine.startAutoSync.bind(assetSyncEngine);
    assetSyncEngine.startAutoSync = () => {
      originalStartAutoSync();
      // Schedule self-heal after a delay (sync runs after initialSyncDelay of 2.5s, so 8s total)
      setTimeout(runSelfHeal, 8000);
    };

    assetSyncEngine.startAutoSync();
  }

  /**
   * Stop background operations.
   */
  stopAutoSync(): void {
    assetSyncEngine.stopAutoSync();
  }

  /**
   * Clear all locally cached assets and reset state.
   */
  async clearAll(): Promise<void> {
    await clearAll();
    await setLocalManifestVersion(0);
    await setLastSyncTime(0);
    this.notify();
  }
}

// ===== Singleton Export =====

export const assetManager = new AssetManager();
export default assetManager;
