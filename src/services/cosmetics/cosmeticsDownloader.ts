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

import type { ManifestFile, DownloadPriority } from "../assetManifest";
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
const installingSlugs = new Set<string>();

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
  console.log("[Cosmetics] installCosmetic: starting —", entity.slug);
  installingSlugs.delete(entity.slug); // Clean up any stale lock from a previous crash
  if (installingSlugs.has(entity.slug)) {
    console.log("[Cosmetics] installCosmetic: already installing, skipping —", entity.slug);
    return false;
  }
  installingSlugs.add(entity.slug);
  var allManifestFiles = buildCosmeticManifestFiles(entity);
  console.log("[Cosmetics] installCosmetic: manifest files =", JSON.stringify(allManifestFiles.map(function(f) { return f.path; })));
  if (allManifestFiles.length === 0) {
    emitCosmeticEvent({ type: "status_changed", slug: entity.slug, status: "installed" });
    return true;
  }

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
  emitCosmeticEvent({ type: "status_changed", slug: entity.slug, status: "downloading" });

  // Download files via downloadManager (uses GitHub CDN)
  const { downloadManager } = await import("../downloadManager");
  var priority: DownloadPriority = options.highPriority ? "high" : "normal";
  var taskIds = downloadManager.enqueueBatch(allManifestFiles, priority);
  console.log("[Cosmetics] installCosmetic: enqueued", taskIds.length, "tasks");

  await waitForTasks(taskIds, function(currentFile, bytesDone) {
    progress.currentFile = currentFile || "";
    progress.bytesInstalled = bytesDone;
    progress.percent = progress.bytesTotal > 0 ? Math.round((bytesDone / progress.bytesTotal) * 100) : 0;
    activeJobs.set(entity.id, progress);
    emitProgress(progress);
    if (options.onProgress) options.onProgress(progress);
  });


  // If GitHub CDN download failed, try direct server API as fallback
  if (!allOk && entity.files && entity.files.length > 0) {
    console.log("[Cosmetics] installCosmetic: GitHub CDN failed, trying server API fallback...");
    try {
      var { API_BASE: API, getLauncherHeaders: getHeaders } = await import("../api");
      var { storeAssetData: storeData } = await import("../assetDatabase");
      var fallbackOk = true;

      for (var fi = 0; fi < entity.files.length; fi++) {
        var fileRef = entity.files[fi];
        if (!fileRef.filePath || !fileRef.id) continue;

        try {
          progress.currentFile = fileRef.fileName || fileRef.filePath;
          emitProgress(progress);
          var url = API + "/content/files/" + encodeURIComponent(fileRef.id) + "/download";
          console.log("[Cosmetics] installCosmetic: fallback fetch —", url);
          var resp = await fetch(url, { headers: getHeaders() });
          if (resp.ok) {
            var buf = await resp.arrayBuffer();
            await storeData(fileRef.filePath, buf);
            console.log("[Cosmetics] installCosmetic: ✔ fallback downloaded", fileRef.fileName);
          } else {
            console.log("[Cosmetics] installCosmetic: ✖ fallback HTTP", resp.status, "for", fileRef.fileName);
            fallbackOk = false;
          }
        } catch (e) {
          console.log("[Cosmetics] installCosmetic: ✖ fallback error", e.message);
          fallbackOk = false;
        }
      }

      if (fallbackOk) {
        allOk = true;
        console.log("[Cosmetics] installCosmetic: ✔ fallback successful — all files from server");
      } else {
        console.log("[Cosmetics] installCosmetic: ✖ fallback also failed");
      }
    } catch (e) {
      console.log("[Cosmetics] installCosmetic: fallback import error", e.message);
    }
  }


    // Check results
  var tasks = taskIds.map(function(id) { return downloadManager.getTask(id); }).filter(Boolean);
  var allOk = tasks.every(function(t) { return t && t.state === "complete"; });

  if (!allOk) {
    console.log("[Cosmetics] installCosmetic: some downloads failed for", entity.slug);
    progress.status = "error";
    progress.lastError = "Download failed for one or more files";
    progress.finishedAt = Date.now();
    activeJobs.set(entity.id, progress);
    emitProgress(progress);
    installingSlugs.delete(entity.slug);
    emitCosmeticEvent({ type: "status_changed", slug: entity.slug, status: "error" });
    return false;
  }

  // Save to disk via IPC
  try {
    var { getAssetData } = await import("../assetDatabase");
    if (typeof window !== "undefined" && window.electronAPI?.saveCosmeticFiles) {
      var cosmeticsFiles = [];
      for (var fi = 0; fi < entity.files.length; fi++) {
        var fileRef = entity.files[fi];
        if (fileRef.filePath) {
          var binaryData = await getAssetData(fileRef.filePath);
          var fname = fileRef.fileName || fileRef.filePath.split("/").pop();
          if (binaryData) {
            console.log("[Cosmetics] installCosmetic: ✔ " + fname + " — kind:", fileRef.kind);
            cosmeticsFiles.push({
              fileName: fname,
              fileType: fileRef.kind || "other",
              data: Array.from(new Uint8Array(binaryData)),
            });
          } else {
            console.log("[Cosmetics] installCosmetic: ✖ " + fname + " — NOT in assetDatabase");
          }
        }
      }
      if (cosmeticsFiles.length > 0) {
        await window.electronAPI.saveCosmeticFiles({ slug: entity.slug, files: cosmeticsFiles });
        console.log("[Cosmetics] Saved", cosmeticsFiles.length, "files to disk for", entity.slug);
      }
    }
  } catch (e) {
    console.warn("[Cosmetics] Could not save files to disk:", e);
  }

  progress.status = "installed";
  progress.percent = 100;
  progress.bytesInstalled = progress.bytesTotal;
  progress.finishedAt = Date.now();
  activeJobs.set(entity.id, progress);
  emitProgress(progress);
  emitCosmeticEvent({ type: "status_changed", slug: entity.slug, status: "installed" });

  installingSlugs.delete(entity.slug);
  console.log("[Cosmetics] installCosmetic: done —", entity.slug);
  return true;
}




export async function downloadAllMissingCosmetics(): Promise<{ downloaded: number; failed: number }> {
  console.log("[Cosmetics] downloadAllMissingCosmetics: checking all cosmetics...");
  var { getAllCosmetics } = await import("./cosmeticsDataManager");
  var all = getAllCosmetics();
  var downloaded = 0;
  var failed = 0;

  for (var i = 0; i < all.length; i++) {
    var ent = all[i];
    if (!ent || !ent.slug) continue;

    // Check if already installed on disk
    var isInstalled = false;
    try {
      if (typeof window !== "undefined" && window.electronAPI?.readCosmeticFile) {
        var result = await window.electronAPI.readCosmeticFile("cosmetics/" + ent.slug + "/manifest.json");
        if (result && result.success) {
          var parsed = JSON.parse(result.data);
          if (parsed && parsed.modelFile) {
            isInstalled = true;
            console.log("[Cosmetics] downloadAllMissing: ✔ " + ent.slug + " already installed");
          }
        }
      }
    } catch (e) {
      // Not installed, continue to download
    }

    if (!isInstalled) {
      console.log("[Cosmetics] downloadAllMissing: downloading " + ent.slug + "...");
      try {
        var ok = await installCosmetic(ent);
        if (ok) { downloaded++; }
        else { failed++; }
      } catch (e) {
        console.warn("[Cosmetics] downloadAllMissing: error for", ent.slug, e);
        failed++;
      }
    }
  }

  console.log("[Cosmetics] downloadAllMissing: done —", downloaded, "downloaded,", failed, "failed");
  return { downloaded, failed };
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
