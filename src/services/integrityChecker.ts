// ============================================================
// Integrity Checker v2.0.0
// Comprehensive integrity verification with automatic
// self-healing repair for damaged or missing assets.
// ============================================================

import type { ManifestFile } from "./assetManifest";
import type {
  IntegrityReport,
  IntegrityFileResult,
  RepairResult,
  RepairFileResult,
} from "./assetManifest";
import {
  getAssetData,
  getAssetStatus,
  getAllAssetStatuses,
  verifyAndUpdateStatus,
  markMissing,
  markDamaged,
  markVerified,
  getLocalManifestVersion,
} from "./assetDatabase";
import { computeHash } from "./assetCache";
import { downloadManager } from "./downloadManager";

// ===== Configuration =====

const CONFIG = {
  /** Max concurrent repairs */
  repairConcurrency: 4,
  /** Auto-repair after check */
  autoRepair: true,
};

// ===== Integrity Checker =====

class IntegrityChecker {
  private _checking = false;
  private _repairing = false;
  private _listeners: Set<() => void> = new Set();

  get isChecking(): boolean { return this._checking; }
  get isRepairing(): boolean { return this._repairing; }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify(): void {
    this._listeners.forEach((fn) => fn());
  }

  // ===== Single File Checks =====

  /**
   * Check a single asset against expected manifest values.
   * Returns the integrity result for that file.
   */
  async checkFile(
    path: string,
    expected: { hash: string; size: number } | null
  ): Promise<IntegrityFileResult> {
    const data = await getAssetData(path);

    const checks = {
      exists: data !== null,
      sizeOk: false,
      hashOk: false,
    };

    let actualSize = 0;
    let actualHash = "";

    if (data) {
      actualSize = data.byteLength;
      checks.sizeOk = expected ? actualSize === expected.size : true;

      actualHash = await computeHash(data);
      checks.hashOk = expected ? actualHash === expected.hash : true;
    }

    const healthy = checks.exists && checks.sizeOk && checks.hashOk;

    // Update database status
    if (!checks.exists) {
      await markMissing(path);
    } else if (!checks.hashOk || !checks.sizeOk) {
      await markDamaged(path,
        !checks.sizeOk
          ? `Size mismatch: expected ${expected?.size}, got ${actualSize}`
          : `Hash mismatch`
      );
    } else {
      await markVerified(path);
    }

    return {
      path,
      healthy,
      checks,
      expected: expected ? { size: expected.size, hash: expected.hash } : null,
      actual: data ? { size: actualSize, hash: actualHash } : null,
    };
  }

  /**
   * Quick check: is a file healthy? (exists + size + hash match)
   */
  async isHealthy(
    path: string,
    expectedHash: string,
    expectedSize: number
  ): Promise<boolean> {
    return verifyAndUpdateStatus(path, expectedHash, expectedSize);
  }

  // ===== Full Integrity Check =====

  /**
   * Check all assets in the manifest against the local cache.
   * Also checks for stale files not in the manifest.
   */
  async checkAll(
    manifestFiles: ManifestFile[],
    onProgress?: (checked: number, total: number, currentFile: string) => void
  ): Promise<IntegrityReport> {
    this._checking = true;
    this.notify();

    const results: IntegrityFileResult[] = [];
    let passed = 0;
    let failed = 0;

    try {
      // Check all manifest files
      for (let i = 0; i < manifestFiles.length; i++) {
        const file = manifestFiles[i];
        if (onProgress) {
          onProgress(i + 1, manifestFiles.length, file.path);
        }

        const result = await this.checkFile(file.path, {
          hash: file.hash,
          size: file.size,
        });

        results.push(result);
        if (result.healthy) passed++;
        else failed++;
      }

      // Check for stale files (in cache but not in manifest)
      const allStatuses = await getAllAssetStatuses();
      const manifestPaths = new Set(manifestFiles.map((f) => f.path));

      for (const status of allStatuses) {
        if (!manifestPaths.has(status.path) && status.status !== "downloading") {
          results.push({
            path: status.path,
            healthy: false,
            checks: { exists: true, sizeOk: false, hashOk: false },
            expected: null,
            actual: { size: status.size, hash: status.hash },
          });
          failed++;
        }
      }
    } finally {
      this._checking = false;
      this.notify();
    }

    return {
      totalChecked: manifestFiles.length,
      passed,
      failed,
      files: results,
      allHealthy: failed === 0,
      checkedAt: Date.now(),
    };
  }

  // ===== Repair (Self-Healing) =====

  /**
   * Repair a single damaged or missing file by re-downloading it.
   */
  async repairFile(
    file: ManifestFile
  ): Promise<RepairFileResult> {
    return new Promise((resolve) => {
      const taskId = downloadManager.enqueue(
        file,
        "high", // Repair gets high priority
        (progress) => {
          // Progress tracking for this repair
        }
      );

      // Poll for completion
      const check = setInterval(() => {
        const task = downloadManager.getTask(taskId);
        if (!task || task.state === "cancelled") {
          clearInterval(check);
          resolve({ path: file.path, success: false, error: "Cancelled" });
        } else if (task.state === "complete") {
          clearInterval(check);
          resolve({ path: file.path, success: true });
        } else if (task.state === "failed") {
          clearInterval(check);
          resolve({ path: file.path, success: false, error: task.error || "Download failed" });
        }
      }, 200);
    });
  }

  /**
   * Repair all damaged or missing assets.
   * Uses DownloadManager to re-download affected files.
   */
  async repairAll(
    damagedFiles: ManifestFile[],
    onProgress?: (repaired: number, total: number, currentFile: string) => void
  ): Promise<RepairResult> {
    this._repairing = true;
    this.notify();

    const details: RepairFileResult[] = [];
    let repaired = 0;
    let failed = 0;

    try {
      // Enqueue all repairs
      const taskIds: string[] = [];
      for (const file of damagedFiles) {
        const id = downloadManager.enqueue(file, "high");
        taskIds.push(id);
      }

      // Wait for all to complete
      for (let i = 0; i < taskIds.length; i++) {
        const id = taskIds[i];
        const file = damagedFiles[i];

        // Wait for download to finish
        const result = await this.waitForTask(id, file.path);
        details.push(result);

        if (result.success) repaired++;
        else failed++;

        if (onProgress) {
          onProgress(i + 1, damagedFiles.length, file.path);
        }
      }
    } finally {
      this._repairing = false;
      this.notify();
    }

    return {
      repaired,
      failed,
      details,
      allRepaired: failed === 0,
    };
  }

  private waitForTask(taskId: string, path: string): Promise<RepairFileResult> {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        const task = downloadManager.getTask(taskId);
        if (!task || task.state === "cancelled") {
          clearInterval(check);
          resolve({ path, success: false, error: "Cancelled" });
        } else if (task.state === "complete") {
          clearInterval(check);
          resolve({ path, success: true });
        } else if (task.state === "failed") {
          clearInterval(check);
          resolve({ path, success: false, error: task.error || "Download failed" });
        }
      }, 200);
    });
  }

  // ===== Quick Health Check =====

  /**
   * Quick check: scan all statuses and return summary counts
   * without doing full hash verification (fast).
   */
  async quickHealthCheck(): Promise<{
    ok: number;
    damaged: number;
    missing: number;
    downloading: number;
    pending: number;
  }> {
    const statuses = await getAllAssetStatuses();
    const counts = { ok: 0, damaged: 0, missing: 0, downloading: 0, pending: 0 };

    for (const s of statuses) {
      if (s.status in counts) {
        counts[s.status as keyof typeof counts]++;
      }
    }

    return counts;
  }
}

// ===== Singleton Export =====

export const integrityChecker = new IntegrityChecker();
export default integrityChecker;
