// ============================================================
// Asset Manifest System v2.0.0
// Types, comparisons, version tracking, integrity, and
// status management for the CDN-based content delivery system.
// ============================================================

// ===== Core Manifest Types =====

/** A single file entry in the manifest */
export interface ManifestFile {
  /** Relative path from repo root, e.g. "themes/bamboo/theme.json" */
  path: string;
  /** SHA-256 hex digest of the file content */
  hash: string;
  /** File size in bytes */
  size: number;
}

/** The root manifest that lists all assets across all categories */
export interface AssetManifest {
  /** Schema version for forward compatibility */
  schemaVersion: number;
  /** Monotonically increasing manifest version */
  version: number;
  /** ISO timestamp of last manifest update */
  updatedAt: string;
  /** All files in the repository */
  files: ManifestFile[];
}

/** Categories derived from file paths */
export const ASSET_CATEGORIES = [
  "themes",
  "cosmetics",
  "banners",
  "assets",
  "news",
  "events",
] as const;

export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

/** Extract category from a file path (first segment) */
export function getCategoryFromPath(filePath: string): AssetCategory | null {
  const firstSlash = filePath.indexOf("/");
  const cat = firstSlash === -1 ? filePath : filePath.substring(0, firstSlash);
  return ASSET_CATEGORIES.includes(cat as AssetCategory) ? (cat as AssetCategory) : null;
}

// ===== Local State Types =====

/** Tracks which files are cached locally */
export interface CachedFileEntry {
  /** Full file path */
  path: string;
  /** SHA-256 hash of the cached version */
  hash: string;
  /** File size in bytes */
  size: number;
  /** The manifest version when this file was cached */
  version: number;
  /** Unix timestamp of when this was cached */
  cachedAt: number;
}

/** The state of the local asset cache */
export interface AssetCacheState {
  /** Overall manifest version we're synced to */
  manifestVersion: number;
  /** Per-category versions */
  categoryVersions: Record<string, number>;
  /** Individual file cache entries */
  files: CachedFileEntry[];
  /** Unix timestamp of last successful sync */
  lastSyncAt: number;
}

// ===== Diff / Sync Types =====

/** Result of comparing local cache with remote manifest */
export interface ManifestDiff {
  /** Files that exist remotely but not locally, or have different hashes */
  toDownload: ManifestFile[];
  /** Files that exist locally but not in the remote manifest (stale) */
  toDelete: string[];
  /** Files that are unchanged */
  unchanged: number;
  /** Total files in remote manifest */
  totalRemote: number;
  /** Total bytes to download */
  bytesToDownload: number;
}

/** Progress callback for sync operations */
export interface SyncProgress {
  /** Current phase */
  phase: "comparing" | "downloading" | "verifying" | "cleaning" | "complete";
  /** Files downloaded so far */
  filesDone: number;
  /** Total files to download */
  filesTotal: number;
  /** Bytes downloaded so far */
  bytesDone: number;
  /** Total bytes to download */
  bytesTotal: number;
  /** Current file being processed */
  currentFile: string;
  /** Overall percentage (0-100) */
  percent: number;
}

/** Result of a sync operation */
export interface SyncResult {
  success: boolean;
  filesDownloaded: number;
  filesDeleted: number;
  bytesDownloaded: number;
  errors: string[];
  manifestVersion: number;
}

// ===== Default / Empty States =====

export const EMPTY_MANIFEST: AssetManifest = {
  schemaVersion: 1,
  version: 0,
  updatedAt: new Date(0).toISOString(),
  files: [],
};

export const EMPTY_CACHE_STATE: AssetCacheState = {
  manifestVersion: 0,
  categoryVersions: {},
  files: [],
  lastSyncAt: 0,
};

export const EMPTY_DIFF: ManifestDiff = {
  toDownload: [],
  toDelete: [],
  unchanged: 0,
  totalRemote: 0,
  bytesToDownload: 0,
};

// ===== Manifest Comparison =====

/**
 * Compare local cache state with a remote manifest to produce a diff.
 * Only files with different hashes or missing locally are flagged for download.
 */
export function computeManifestDiff(
  remote: AssetManifest,
  local: AssetCacheState
): ManifestDiff {
  const localMap = new Map<string, CachedFileEntry>();
  for (const entry of local.files) {
    localMap.set(entry.path, entry);
  }

  const remoteSet = new Set<string>();
  const toDownload: ManifestFile[] = [];
  let unchanged = 0;
  let bytesToDownload = 0;

  for (const file of remote.files) {
    remoteSet.add(file.path);
    const cached = localMap.get(file.path);

    if (!cached || cached.hash !== file.hash) {
      toDownload.push(file);
      bytesToDownload += file.size;
    } else {
      unchanged++;
    }
  }

  // Files in local cache but no longer in remote = stale
  const toDelete: string[] = [];
  for (const path of localMap.keys()) {
    if (!remoteSet.has(path)) {
      toDelete.push(path);
    }
  }

  return {
    toDownload,
    toDelete,
    unchanged,
    totalRemote: remote.files.length,
    bytesToDownload,
  };
}

// ===== Category Helpers =====

/** Compute per-category versions from a manifest by finding max hash per category */
export function computeCategoryVersions(files: ManifestFile[]): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const file of files) {
    const cat = getCategoryFromPath(file.path);
    if (cat) {
      let hashNum = 0;
      for (let i = 0; i < file.hash.length; i++) {
        hashNum = (hashNum * 31 + file.hash.charCodeAt(i)) & 0x7fffffff;
      }
      versions[cat] = Math.max(versions[cat] || 0, hashNum);
    }
  }
  return versions;
}

// ===== Phase 2: Asset Status Types =====

/** Possible states of a locally cached asset */
export type AssetStatus = "ok" | "damaged" | "missing" | "downloading" | "pending" | "stale";

/** Error categories for download failures */
export type DownloadErrorType = "network" | "timeout" | "hash_mismatch" | "size_mismatch" | "http_error" | "aborted" | "unknown";

/** Detailed info about a single cached asset */
export interface AssetInfo {
  path: string;
  /** Current status */
  status: AssetStatus;
  /** SHA-256 hash of the cached file (empty if missing) */
  hash: string;
  /** File size in bytes (0 if missing) */
  size: number;
  /** Manifest version this file was cached at */
  version: number;
  /** Unix timestamp when first installed */
  installedAt: number;
  /** Unix timestamp of last successful verification */
  lastChecked: number;
  /** Unix timestamp of last successful hash verification */
  verifiedAt: number;
  /** Number of failed download attempts */
  retryCount: number;
  /** Last error message (empty if no errors) */
  lastError: string;
  /** Last error category */
  lastErrorType: DownloadErrorType | null;
  /** MIME type */
  mimeType: string;
}

/** Summary of asset health across the entire cache */
export interface AssetHealthSummary {
  /** Total files in the manifest */
  totalManifestFiles: number;
  /** Files with status "ok" */
  healthy: number;
  /** Files with status "damaged" (hash mismatch) */
  damaged: number;
  /** Files with status "missing" (not in cache) */
  missing: number;
  /** Files with status "downloading" (in progress) */
  downloading: number;
  /** Files with status "stale" (not in manifest) */
  stale: number;
  /** Files with status "pending" (queued for download) */
  pending: number;
  /** Overall health percentage (0-100) */
  healthPercent: number;
  /** Local manifest version */
  localVersion: number;
  /** Remote manifest version */
  remoteVersion: number;
  /** Update available? */
  updateAvailable: boolean;
  /** Repair needed? */
  repairNeeded: boolean;
  /** Unix timestamp of last health check */
  checkedAt: number;
}

/** Report from an integrity check operation */
export interface IntegrityReport {
  /** Total files checked */
  totalChecked: number;
  /** Files that passed all checks */
  passed: number;
  /** Files that failed one or more checks */
  failed: number;
  /** Per-file results */
  files: IntegrityFileResult[];
  /** Whether the check passed overall */
  allHealthy: boolean;
  /** Timestamp of the check */
  checkedAt: number;
}

/** Result for a single file in an integrity check */
export interface IntegrityFileResult {
  path: string;
  /** Did it pass? */
  healthy: boolean;
  /** Check results */
  checks: {
    exists: boolean;
    sizeOk: boolean;
    hashOk: boolean;
  };
  /** Expected file info from manifest */
  expected: { size: number; hash: string } | null;
  /** Actual file info from cache */
  actual: { size: number; hash: string } | null;
}

/** Result of a repair operation */
export interface RepairResult {
  /** Files that were repaired successfully */
  repaired: number;
  /** Files that failed repair */
  failed: number;
  /** Details per file */
  details: RepairFileResult[];
  /** Whether all repairs succeeded */
  allRepaired: boolean;
}

/** Result for a single file repair */
export interface RepairFileResult {
  path: string;
  success: boolean;
  error?: string;
}

/** Combined result of a full checkup (sync + integrity + repair) */
export interface CheckupResult {
  /** Sync result */
  sync: SyncResult;
  /** Integrity report */
  integrity: IntegrityReport;
  /** Repair result (only if repair was needed) */
  repair: RepairResult | null;
  /** Overall health summary after checkup */
  health: AssetHealthSummary;
  /** Whether everything is healthy */
  allHealthy: boolean;
}

// ===== Phase 2: Download Manager Types =====

/** Priority levels for download queue */
export type DownloadPriority = "critical" | "high" | "normal" | "low";

/** A task in the download queue */
export interface DownloadTask {
  /** Unique task ID */
  id: string;
  /** The file to download */
  file: ManifestFile;
  /** Priority */
  priority: DownloadPriority;
  /** Current state */
  state: "queued" | "downloading" | "verifying" | "complete" | "failed" | "cancelled";
  /** Bytes downloaded so far */
  bytesDownloaded: number;
  /** Retry count */
  retryCount: number;
  /** Max retries */
  maxRetries: number;
  /** Error if failed */
  error?: string;
  /** Error category if failed */
  errorType?: DownloadErrorType;
  /** Timestamp when task was created */
  createdAt: number;
  /** Timestamp when download started */
  startedAt?: number;
  /** Timestamp when download completed */
  completedAt?: number;
}

/** Progress event for a download task */
export interface DownloadTaskProgress {
  taskId: string;
  filePath: string;
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
}

/** Overall download queue progress */
export interface DownloadQueueProgress {
  phase: "idle" | "downloading" | "complete";
  tasksTotal: number;
  tasksComplete: number;
  tasksFailed: number;
  bytesDownloaded: number;
  bytesTotal: number;
  percent: number;
  currentFile: string;
}

// ===== Default Values =====

export const EMPTY_ASSET_INFO: AssetInfo = {
  path: "",
  status: "missing",
  hash: "",
  size: 0,
  version: 0,
  installedAt: 0,
  lastChecked: 0,
  verifiedAt: 0,
  retryCount: 0,
  lastError: "",
  lastErrorType: null,
  mimeType: "application/octet-stream",
};

export const EMPTY_HEALTH_SUMMARY: AssetHealthSummary = {
  totalManifestFiles: 0,
  healthy: 0,
  damaged: 0,
  missing: 0,
  downloading: 0,
  stale: 0,
  pending: 0,
  healthPercent: 0,
  localVersion: 0,
  remoteVersion: 0,
  updateAvailable: false,
  repairNeeded: false,
  checkedAt: 0,
};

/** Priority sort weight map */
export const PRIORITY_WEIGHT: Record<DownloadPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};
