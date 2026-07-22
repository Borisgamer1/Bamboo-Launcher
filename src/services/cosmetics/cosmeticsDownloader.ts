// ============================================================
// Cosmetics Downloader v1.0.0 — Phase 4: DOWNLOAD LAYER
// ============================================================
//
// Responsibilities (DOWNLOAD layer only):
//  - Translate a CosmeticEntity → ManifestFile entries
//  - Download cosmetic files directly from GitHub raw
//  - Publish progress through the SHARED event bus from the data manager
//  - Save files to disk via IPC
//
// Notes:
//  - Files are downloaded directly from GitHub raw content URLs because
//    the Render server only stores metadata (asset_files table), not
//    the actual file content on disk.
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
import { getRawFileUrl } from "../githubCdn";

// ===== Constants =====


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
  // Prevent parallel downloads of the same cosmetic
  if (installingSlugs.has(entity.slug)) {
    console.log("[Cosmetics] installCosmetic: already installing, skipping —", entity.slug);
    return false;
  }
  installingSlugs.add(entity.slug);
  var allManifestFiles = buildCosmeticManifestFiles(entity);
  console.log("[Cosmetics] installCosmetic: manifest files =", JSON.stringify(allManifestFiles.map(function(f) { return f.path; })));
  if (allManifestFiles.length === 0) {
    installingSlugs.delete(entity.slug);
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

  // ===== DOWNLOAD VON GITHUB RAW =====
  // Der Server speichert nur Metadaten (asset_files-Tabelle),
  // aber die Dateien liegen NICHT auf Render's Platte.
  // Stattdessen laden wir direkt von GitHub Raw Content:
  //   getRawFileUrl(filePath) baut:
  //   https://raw.githubusercontent.com/Borisgamer1/Bamboo-Launcher---Content/main/{filePath}
  // filePath = z.B. "Cosmetics/Vogel Cape/Vogel Cape.json" (relativ zum Repo-Root)
  var downloadedFiles: Array<{ fileName: string; fileType: string; data: number[] }> = [];
  var allOk = true;

  for (var fi = 0; fi < entity.files.length; fi++) {
    var fileRef = entity.files[fi];
    if (!fileRef.filePath) continue;

    try {
      progress.currentFile = fileRef.fileName || fileRef.filePath;
      progress.bytesInstalled = 0;
      activeJobs.set(entity.id, progress);
      emitProgress(progress);

      var url = getRawFileUrl(fileRef.filePath);
      console.log("[Cosmetics] installCosmetic: downloading", fileRef.fileName, "from GitHub...");

      var resp = await fetch(url);
      if (resp.ok) {
        var buf = await resp.arrayBuffer();
        var bytesDone = buf.byteLength;
        progress.bytesInstalled += bytesDone;
        progress.percent = progress.bytesTotal > 0 ? Math.round((progress.bytesInstalled / progress.bytesTotal) * 100) : 0;
        activeJobs.set(entity.id, progress);
        emitProgress(progress);

        var fname = fileRef.fileName || fileRef.filePath.split("/").pop() || "file";
        downloadedFiles.push({
          fileName: fname,
          fileType: fileRef.kind || "other",
          data: Array.from(new Uint8Array(buf)),
        });
        console.log("[Cosmetics] installCosmetic: ✔", fname, "(", bytesDone, "bytes )");
      } else {
        console.warn("[Cosmetics] installCosmetic: ✖ HTTP", resp.status, "for", fileRef.fileName);
        allOk = false;
      }
    } catch (e) {
      console.warn("[Cosmetics] installCosmetic: ✖ error", fileRef.fileName, ":", e.message);
      allOk = false;
    }
  }

  if (!allOk || downloadedFiles.length === 0) {
    console.log("[Cosmetics] installCosmetic: FAILED for", entity.slug);
    progress.status = "error";
    progress.lastError = "Download failed for one or more files";
    progress.finishedAt = Date.now();
    activeJobs.set(entity.id, progress);
    emitProgress(progress);
    installingSlugs.delete(entity.slug);
    emitCosmeticEvent({ type: "status_changed", slug: entity.slug, status: "error" });
    return false;
  }

  // Save to disk via IPC (direkt, ohne assetDatabase/IndexedDB)
  try {
    if (typeof window !== "undefined" && window.electronAPI?.saveCosmeticFiles) {
      var result = await window.electronAPI.saveCosmeticFiles({ slug: entity.slug, files: downloadedFiles });
      if (result && result.success) {
        console.log("[Cosmetics] installCosmetic: ✔ saved", downloadedFiles.length, "files to", result.path);
      } else {
        console.warn("[Cosmetics] installCosmetic: ✖ save returned:", result);
      }
    } else {
      console.warn("[Cosmetics] installCosmetic: ✖ no electronAPI.saveCosmeticFiles available");
    }
  } catch (e) {
    console.warn("[Cosmetics] installCosmetic: ✖ save error:", e.message);
  }

  progress.status = "installed";
  progress.percent = 100;
  progress.bytesInstalled = progress.bytesTotal;
  progress.finishedAt = Date.now();
  activeJobs.set(entity.id, progress);
  emitProgress(progress);
  emitCosmeticEvent({ type: "status_changed", slug: entity.slug, status: "installed" });

  installingSlugs.delete(entity.slug);
  console.log("[Cosmetics] installCosmetic: ✔ done —", entity.slug);
  return true;
}



export async function downloadAllMissingCosmetics(
  entities?: CosmeticEntity[]
): Promise<{ downloaded: number; failed: number }> {
  console.log("[Cosmetics] downloadAllMissingCosmetics: checking all cosmetics...");
  var all = entities;
  if (!all) {
    var { getAllCosmetics } = await import("./cosmeticsDataManager");
    all = getAllCosmetics();
  }
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
