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
import { API_BASE, getLauncherHeaders } from "../api";

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

  // CHECK: Is this cosmetic already installed on disk?
  try {
    if (typeof window !== "undefined" && window.electronAPI?.readCosmeticFile) {
      var existingManifest = await window.electronAPI.readCosmeticFile('cosmetics/' + entity.slug + '/manifest.json');
      console.log("[Cosmetics] installCosmetic: checking if already installed —", existingManifest?.success ? "MANIFEST FOUND" : "NOT FOUND");
      if (existingManifest && existingManifest.success) {
        try {
          var parsed = JSON.parse(existingManifest.data);
          if (parsed.modelFile || (parsed.files && parsed.files.length > 0)) {
            console.log("[Cosmetics] installCosmetic: ✔ ALREADY INSTALLED — modelFile:", parsed.modelFile, ", fileCount:", parsed.fileCount);
            emitCosmeticEvent({ type: "status_changed", slug: entity.slug, status: "installed" });
            return true;
          }
        } catch(parseErr) {
          console.log("[Cosmetics] installCosmetic: manifest parse failed, will re-download —", parseErr && parseErr.message);
        }
      } else {
        console.log("[Cosmetics] installCosmetic: NOT installed on disk — will download", entity.slug);
      }
    } else {
      console.log("[Cosmetics] installCosmetic: no electronAPI access, cannot check disk");
    }
  } catch(checkErr) {
    console.log("[Cosmetics] installCosmetic: Could not check disk — will download:", checkErr && checkErr.message);
  }

  console.log("[Cosmetics] installCosmetic: Downloading", cosmeticManifestFiles.length, "files");

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

  // ===== Download files DIRECTLY from server API (NOT GitHub CDN) =====
  // Root Cause Fix: Cosmetic files are stored on the server's filesystem
  // and served via /api/content/files/:fileId/download — NOT on GitHub CDN.
  console.log("[Cosmetics] installCosmetic: Starting direct server download for", entity.slug);
  
  var { storeAssetData } = await import("../assetDatabase");
  var downloadedCount = 0;
  var totalBytesDownloaded = 0;
  
  for (var fi = 0; fi < entity.files.length; fi++) {
    var fileRef = entity.files[fi];
    if (!fileRef.filePath || !fileRef.id) {
      console.log("[Cosmetics] installCosmetic: ⊘ skip file #" + fi + " — no filePath or id, fileName=" + (fileRef.fileName || "?"));
      continue;
    }
    
    progress.currentFile = fileRef.fileName || fileRef.filePath;
    console.log(`[Cosmetics] installCosmetic: Downloading ${fileRef.fileName} (id=${fileRef.id})`);
    
    try {
      var downloadUrl = API_BASE + '/content/files/' + encodeURIComponent(fileRef.id) + '/download';
      console.log("[Cosmetics] installCosmetic:   URL:", downloadUrl);
      
      var response = await fetch(downloadUrl, { headers: getLauncherHeaders() });
      
      if (!response.ok) {
        console.log("[Cosmetics] installCosmetic:   ✖ Server returned HTTP", response.status, response.statusText);
        progress.lastError = "HTTP " + response.status + " for " + fileRef.fileName;
        continue;
      }
      
      var arrayBuf = await response.arrayBuffer();
      console.log("[Cosmetics] installCosmetic:   ✔ Downloaded", fileRef.fileName, "—", arrayBuf.byteLength, "bytes");
      
      // Store in assetDatabase so the save-to-disk section can read it
      await storeAssetData(fileRef.filePath, arrayBuf);
      console.log("[Cosmetics] installCosmetic:   ✔ Stored in assetDatabase:", fileRef.filePath);
      
      downloadedCount++;
      totalBytesDownloaded += arrayBuf.byteLength;
      progress.bytesInstalled = totalBytesDownloaded;
      if (progress.bytesTotal > 0) {
        progress.percent = Math.round((progress.bytesInstalled / progress.bytesTotal) * 100);
      }
      activeJobs.set(entity.id, progress);
      emitProgress(progress);
      options.onProgress?.(progress);
      
    } catch (fetchErr) {
      console.log("[Cosmetics] installCosmetic:   ✖ Fetch error:", fetchErr.message || fetchErr);
      progress.lastError = String(fetchErr.message || fetchErr);
    }
  }
  
  console.log("[Cosmetics] installCosmetic: Direct download complete —", downloadedCount, "/", entity.files.length, "files downloaded");

  // If NO files were downloaded at all, report error
  if (downloadedCount === 0 && entity.files.length > 0) {
    progress.status = "error";
    progress.lastError = progress.lastError || "No files could be downloaded — server returned errors for all files";
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
          var fname = fileRef.fileName || fileRef.filePath.split("/").pop();
          if (binaryData) {
            console.log("[Cosmetics] installCosmetic: ✔ " + fname + " — kind:", fileRef.kind);
            CosmeticFiles.push({
              fileName: fname,
              fileType: fileRef.kind || "other",
              data: Array.from(new Uint8Array(binaryData)),
            });
          } else {
            console.log("[Cosmetics] installCosmetic: ✖ " + fname + " — NOT in assetDatabase (not downloaded?)");
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
