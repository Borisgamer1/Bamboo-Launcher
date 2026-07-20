// ============================================================
// Cosmetics Downloader v1.0.0 — Phase 4: DOWNLOAD LAYER
// ============================================================
//
// Responsibilities (DOWNLOAD layer only):
//  - Translate a CosmeticEntity → ManifestFile entries
//  - Use the existing DownloadManager to fetch bytes
//  - Reuse the cache (downloadManager already stores bytes + marks "ok")
//  - Publish progress through the SHARED event bus from the data manager
//  - Trigger cleanup of stale local files when a new version arrives
//
// Notes:
//  - per-file "downloading" status is already maintained by the underlying
//    `downloadManager.processTask()` (it calls `markDownloading(path)`);
//    we do NOT double-mark from here.
//  - This module does not own the listener set. Consumers connect via
//    `addCosmeticListener` from the data manager.
// ============================================================

import type { ManifestFile } from "../assetManifest";
import type { CosmeticDownloadProgress, CosmeticEntity } from "./types";
import {
  addCosmeticListener,
  emitCosmeticEvent,
  getCosmeticBySlug,
} from "./cosmeticsDataManager";

// ===== Constants =====

const COSMETICS_CATEGORY = "cosmetics";

// ===== Internal state =====

const activeJobs = new Map<string, CosmeticDownloadProgress>();

// ===== Manifest entry builder =====

export function buildCosmeticManifestFiles(entity: CosmeticEntity): ManifestFile[] {
  return entity.files
    .filter((f) => !!f.filePath)
    .map((f) => ({
      path: f.filePath as string,
      hash: f.fileHash || "",
      size: f.fileSize || 0,
    }));
}

export function computeCosmeticBytes(entity: CosmeticEntity): number {
  return entity.files.reduce((sum, f) => sum + (f.fileSize || 0), 0);
}

// ===== Install / Uninstall =====

export async function installCosmetic(
  entity: CosmeticEntity,
  options: {
    onProgress?: (progress: CosmeticDownloadProgress) => void;
    highPriority?: boolean;
  } = {}
): Promise<boolean> {
  const allManifestFiles = buildCosmeticManifestFiles(entity);
  // DEBUG: Download ALL files (removed filterToCosmetics — bug: paths may not start with "cosmetics/")
  console.log("[Cosmetics] installCosmetic: entity.slug =", entity.slug);
  console.log("[Cosmetics] installCosmetic: allManifestFiles =", JSON.stringify(allManifestFiles.map(function(f) { return f.path; })));
  var cosmeticManifestFiles = allManifestFiles;
  if (cosmeticManifestFiles.length === 0) {
    console.log("[Cosmetics] installCosmetic: NO files in manifest — entity.files was empty. entity.files.length =", entity.files.length);
    emitCosmeticEvent({
      type: "status_changed",
      slug: entity.slug,
      status: "installed",
    });
    return true;
  }
  console.log("[Cosmetics] installCosmetic: Downloading", cosmeticManifestFiles.length, "files");

  const { downloadManager } = await import("../downloadManager");

  const progress: CosmeticDownloadProgress = {
    cosmeticId: entity.id,
    status: "downloading",
    bytesInstalled: 0,
    bytesTotal: computeCosmeticBytes(entity),
    percent: 0,
    currentFile: "",
    startedAt: Date.now(),
  };
  activeJobs.set(entity.id, progress);

  emitProgress(progress);
  emitCosmeticEvent({
    type: "status_changed",
    slug: entity.slug,
    status: "downloading",
  });

  const priority = options.highPriority ? "high" : "normal";
  const taskIds = downloadManager.enqueueBatch(cosmeticManifestFiles, priority);

  await waitForTasks(taskIds, (currentFile, bytesDone) => {
    progress.currentFile = currentFile || "";
    progress.bytesInstalled = bytesDone;
    progress.percent =
      progress.bytesTotal > 0
        ? Math.round((progress.bytesInstalled / progress.bytesTotal) * 100)
        : 0;
    activeJobs.set(entity.id, progress);
    emitProgress(progress);
    options.onProgress?.(progress);
  });

  const tasks = taskIds
    .map((id) => downloadManager.getTask(id))
    .filter(
      (t): t is NonNullable<ReturnType<typeof downloadManager.getTask>> => !!t
    );
  const allOk = tasks.every((t) => t.state === "complete");

  if (!allOk) {
    const failed = tasks.filter((t) => t.state === "failed");
    progress.status = "error";
    progress.lastError = failed
      .map((t) => t.error || t.errorType || "unknown")
      .join("; ");
    progress.finishedAt = Date.now();
    activeJobs.set(entity.id, progress);
    emitProgress(progress);
    emitCosmeticEvent({
      type: "status_changed",
      slug: entity.slug,
      status: "error",
    });
    return false;
  }

  progress.status = "installed";
  progress.percent = 100;
  progress.finishedAt = Date.now();
  progress.bytesInstalled = progress.bytesTotal;
  activeJobs.set(entity.id, progress);
  emitProgress(progress);
  emitCosmeticEvent({
    type: "status_changed",
    slug: entity.slug,
    status: "installed",
  });

  // Save cosmetic files to disk (BambooLaufwerk/cosmetics/{slug}/)
  try {
    var { getAssetData } = await import("../assetDatabase");
    if (typeof window !== "undefined" && window.electronAPI?.saveCosmeticFiles) {
      var CosmeticFiles = [];
      for (var fi = 0; fi < entity.files.length; fi++) {
        var fileRef = entity.files[fi];
        if (fileRef.filePath) {
          var binaryData = await getAssetData(fileRef.filePath);
          if (binaryData) {
            CosmeticFiles.push({
              fileName: fileRef.fileName || fileRef.filePath.split("/").pop(),
              data: Array.from(new Uint8Array(binaryData)),
            });
          }
        }
      }
      if (CosmeticFiles.length > 0) {
        window.electronAPI.saveCosmeticFiles({ slug: entity.slug, files: CosmeticFiles });
        console.log("[cosmetics] Saved", CosmeticFiles.length, "files to disk for", entity.slug);
      }
    }
  } catch (e) {
    console.warn("[cosmetics] Could not save files to disk:", e);
  }

  return true;
}

export async function uninstallCosmetic(
  entityOrSlug: CosmeticEntity | string
): Promise<boolean> {
  const entity =
    typeof entityOrSlug === "string"
      ? getCosmeticBySlug(entityOrSlug)
      : entityOrSlug;
  if (!entity) return false;

  const { deleteAssetData, deleteAssetStatus } = await import("../assetDatabase");
  for (const f of entity.files) {
    if (!f.filePath) continue;
    try {
      await deleteAssetData(f.filePath);
      await deleteAssetStatus(f.filePath);
    } catch {
      // best-effort
    }
  }
  emitCosmeticEvent({
    type: "status_changed",
    slug: entity.slug,
    status: "not_installed",
  });
  return true;
}

export function getInstallProgress(cosmeticId: string): CosmeticDownloadProgress | undefined {
  return activeJobs.get(cosmeticId);
}

/**
 * Subscribe to download progress events for ALL cosmetics.
 * Returns an unsubscribe function. Wires directly through the
 * data manager's event bus — same channel used everywhere.
 */
export function subscribeToInstallProgress(
  callback: (progress: CosmeticDownloadProgress) => void
): () => void {
  return addCosmeticListener((event) => {
    if (event.type === "progress") callback(event.progress);
  });
}

/**
 * Subscribe to status changes for a single cosmetic by slug or id.
 * Returns an unsubscribe function.
 */
export function subscribeToStatusChanges(
  slugOrId: string,
  callback: (status: CosmeticDownloadProgress["status"]) => void
): () => void {
  return addCosmeticListener((event) => {
    if (event.type === "status_changed" && event.slug === slugOrId) {
      callback(event.status);
    }
  });
}

// ===== Internals =====

function emitProgress(progress: CosmeticDownloadProgress): void {
  emitCosmeticEvent({ type: "progress", progress });
}

// ===== Helpers =====

function filterToCosmetics(files: ManifestFile[]): ManifestFile[] {
  return files.filter((f) => f.path.startsWith(COSMETICS_CATEGORY + "/"));
}

async function waitForTasks(
  taskIds: string[],
  onTick: (currentFile: string | undefined, bytesDone: number) => void
): Promise<void> {
  const { downloadManager } = await import("../downloadManager");
  return new Promise<void>((resolve) => {
    const poll = (): void => {
      const tasks = taskIds
        .map((id) => downloadManager.getTask(id))
        .filter(
          (t): t is NonNullable<ReturnType<typeof downloadManager.getTask>> => !!t
        );
      const running = tasks.find((t) => t.state === "downloading");
      const bytesDone = tasks.reduce((sum, t) => sum + (t.bytesDownloaded ?? 0), 0);
      const terminal = tasks.every(
        (t) => t.state === "complete" || t.state === "failed" || t.state === "cancelled"
      );
      onTick(running?.file.path, bytesDone);
      if (!downloadManager.isRunning && terminal) {
        resolve();
        return;
      }
      setTimeout(poll, 250);
    };
    poll();
  });
}
