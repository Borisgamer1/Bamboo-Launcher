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
  console.log("[Cosmetics] installCosmetic: stub —", entity.slug, "(pipeline removed, cosmetic display works via server API)");
  emitCosmeticEvent({
    type: "status_changed",
    slug: entity.slug,
    status: "installed",
  });
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
