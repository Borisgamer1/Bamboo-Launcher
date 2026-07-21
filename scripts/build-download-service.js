// ============================================================
// BUILD: Cosmetics Download Service v2 — Sauber & Einfach
// ============================================================
// 1. main.js: Restore save-cosmetic-files + read-cosmetic-file handlers
// 2. cosmeticsDownloader.ts: Rewrite installCosmetic with downloadManager
// 3. CosmeticsView.tsx: Auto-download beim Tab-Öffnen
// ============================================================
var fs = require("fs");

// ======================================================================
// FIX 1: main.js — save-cosmetic-files + read-cosmetic-file wiederherstellen
// ======================================================================
var mainPath = "main.js";
var mc = fs.readFileSync(mainPath, "utf8");

// Find the current no-op save-cosmetic-files handler and replace with proper handler
var saveNoopStart = "ipcMain.handle('save-cosmetic-files', async (_event, data) => {\n  console.log('[cosmetics] save-cosmetic-files: pipeline removed, no-op');\n  return { success: true, path: '', fileCount: 0 };\n});\n";

var saveNew = `ipcMain.handle('save-cosmetic-files', async (_event, { slug, files }) => {
  try {
    var rootPath = 'C:\\\\BambooLaufwerk';
    var cosmeticDir = path.join(rootPath, 'cosmetics', slug);
    console.log('[cosmetics] save-cosmetic-files: target dir =', cosmeticDir);
    console.log('[cosmetics] save-cosmetic-files: slug =', slug, ', files count =', (files || []).length);
    if (!fs.existsSync(cosmeticDir)) fs.mkdirSync(cosmeticDir, { recursive: true });
    var savedFiles = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f.fileName || !f.data) continue;
      var filePath = path.join(cosmeticDir, f.fileName);
      // Ensure subdirectories exist (e.g. textures/subfolder/)
      var dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(f.data));
      savedFiles.push(f.fileName);
    }
    // Build manifest.json with real filenames
    var modelFile = null;
    var textureFiles = [];
    for (var fi = 0; fi < files.length; fi++) {
      var ftype = files[fi].fileType || "other";
      if (ftype === "model" && !modelFile) modelFile = files[fi].fileName;
      if (ftype === "texture" || ftype === "icon") textureFiles.push(files[fi].fileName);
    }
    // Fallback: if no model file detected, use first .json that isnt manifest.json
    if (!modelFile) {
      for (var sj = 0; sj < savedFiles.length; sj++) {
        if (savedFiles[sj].toLowerCase().endsWith(".json") && savedFiles[sj] !== "manifest.json") {
          modelFile = savedFiles[sj]; break;
        }
      }
    }
    // Fallback for textures: any .png files
    if (textureFiles.length === 0) {
      for (var sk = 0; sk < savedFiles.length; sk++) {
        if (savedFiles[sk].toLowerCase().endsWith(".png")) textureFiles.push(savedFiles[sk]);
      }
    }
    var manifest = {
      slug: slug,
      installedAt: Date.now(),
      fileCount: savedFiles.length,
      files: savedFiles,
      modelFile: modelFile,
      textureFiles: textureFiles,
    };
    fs.writeFileSync(path.join(cosmeticDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log('[cosmetics] save-cosmetic-files: SUCCESS — saved', savedFiles.length, 'files to', cosmeticDir);
    console.log('[cosmetics] Manifest — modelFile:', modelFile, ', textureFiles:', JSON.stringify(textureFiles));
    return { success: true, path: cosmeticDir, fileCount: savedFiles.length };
  } catch (e) {
    console.error('[cosmetics] Save error:', e.message);
    return { success: false, error: e.message };
  }
});
`;

var saveIdx = mc.indexOf(saveNoopStart);
if (saveIdx >= 0) {
  mc = mc.substring(0, saveIdx) + saveNew + mc.substring(saveIdx + saveNoopStart.length);
  console.log("[FIX 1a] ✅ save-cosmetic-files handler restored (" + saveNew.length + " chars)");
} else {
  console.log("[FIX 1a] ⚠️ Could not find save-cosmetic-files no-op. Checking current state...");
}

// Find and replace read-cosmetic-file no-op with proper handler
var readNoopStart = "ipcMain.handle('read-cosmetic-file', async (_event, filePath) => {\n  console.log('[cosmetics] read-cosmetic-file: pipeline removed, no-op');\n  return { success: false, error: 'Pipeline removed' };\n});";

var readNew = `ipcMain.handle('read-cosmetic-file', async (_event, filePath) => {
  var rootPath = 'C:\\\\BambooLaufwerk';
  try {
    if (!filePath) return { success: false, error: 'No file path provided' };
    var fullPath = path.isAbsolute(filePath) ? filePath : path.join(rootPath, filePath);
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: 'File not found: ' + filePath };
    }
    var ext = path.extname(fullPath).toLowerCase();
    if (ext === '.json') {
      var content = fs.readFileSync(fullPath, 'utf-8');
      return { success: true, data: content, type: 'json' };
    }
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.webp') {
      var raw = fs.readFileSync(fullPath);
      var mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
      var mimeType = mime[ext] || 'image/png';
      var base64 = raw.toString('base64');
      return { success: true, data: 'data:' + mimeType + ';base64,' + base64, type: 'image' };
    }
    var content = fs.readFileSync(fullPath, 'utf-8');
    return { success: true, data: content, type: 'text' };
  } catch (e) {
    console.error('[cosmetics] Read error:', e.message);
    return { success: false, error: e.message };
  }
});`;

var readIdx = mc.indexOf(readNoopStart);
if (readIdx >= 0) {
  mc = mc.substring(0, readIdx) + readNew + mc.substring(readIdx + readNoopStart.length);
  console.log("[FIX 1b] ✅ read-cosmetic-file handler restored (" + readNew.length + " chars)");
} else {
  console.log("[FIX 1b] ⚠️ Could not find read-cosmetic-file no-op. Checking current state...");
}

fs.writeFileSync(mainPath, mc, "utf8");
console.log("[FIX 1] ✅ main.js handlers restored");

// ======================================================================
// FIX 2: cosmeticsDownloader.ts — installCosmetic mit downloadManager
// ======================================================================
var downloaderPath = "src/services/cosmetics/cosmeticsDownloader.ts";
var dc = fs.readFileSync(downloaderPath, "utf8");

// Replace the entire installCosmetic stub with real implementation
var installStubStart = "export async function installCosmetic(";
var installStubEnd = "  return true;\n}";

var installNew = `export async function installCosmetic(
  entity: CosmeticEntity,
  options: {
    onProgress?: (progress: CosmeticDownloadProgress) => void;
    highPriority?: boolean;
  } = {}
): Promise<boolean> {
  console.log("[Cosmetics] installCosmetic: starting —", entity.slug);
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
  var priority = options.highPriority ? "high" : "normal";
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

  console.log("[Cosmetics] installCosmetic: done —", entity.slug);
  return true;
}`;

// Find the stub and replace it
var idx1 = dc.indexOf(installStubStart);
var idx2 = dc.indexOf(installStubEnd, idx1);
if (idx1 >= 0 && idx2 >= 0) {
  var stubEnd = idx2 + installStubEnd.length;
  dc = dc.substring(0, idx1) + installNew + "\n\n" + dc.substring(stubEnd);
  console.log("[FIX 2] ✅ installCosmetic rewritten with downloadManager (" + (stubEnd - idx1) + " chars replaced)");
} else {
  console.log("[FIX 2] ❌ Could not find installCosmetic boundaries");
}

// Add downloadAllMissing function before the uninstallCosmetic
var uninstallStart = dc.indexOf("export async function uninstallCosmetic(");
if (uninstallStart >= 0) {
  var downloadAll = `
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
`;
  dc = dc.substring(0, uninstallStart) + downloadAll + "\n" + dc.substring(uninstallStart);
  console.log("[FIX 2b] ✅ downloadAllMissingCosmetics function added");
}

fs.writeFileSync(downloaderPath, dc, "utf8");
console.log("[FIX 2] ✅ cosmeticsDownloader.ts updated");

// ======================================================================
// FIX 3: CosmeticsView.tsx — Auto-Download beim Tab-Öffnen
// ======================================================================
var viewPath = "src/components/CosmeticsView.tsx";
var vc = fs.readFileSync(viewPath, "utf8");

// Find a good insertion point for the auto-download useEffect
// Insert after the existing buildCards useEffect that runs on mount
var buildCardsEffectEnd = "  }, [loadingCosmetics, progressUpdateCounter]);";

var autoDownloadEffect = `
  // Auto-download all missing cosmetics when tab is opened
  useEffect(() => {
    var cancelled = false;
    (async function() {
      try {
        var { downloadAllMissingCosmetics } = await import("../services/cosmetics/cosmeticsDownloader");
        var result = await downloadAllMissingCosmetics();
        if (!cancelled) {
          console.log("[Cosmetics] Auto-download complete:", result.downloaded, "downloaded,", result.failed, "failed");
          buildCards();
        }
      } catch (e) {
        if (!cancelled) console.warn("[Cosmetics] Auto-download error:", e);
      }
    })();
    return function() { cancelled = true; };
  }, []); // Run once when component mounts (tab opens)
`;

var effectIdx = vc.indexOf(buildCardsEffectEnd);
if (effectIdx >= 0) {
  var insertPos = effectIdx + buildCardsEffectEnd.length;
  vc = vc.substring(0, insertPos) + autoDownloadEffect + vc.substring(insertPos);
  console.log("[FIX 3] ✅ Auto-download useEffect added");
} else {
  console.log("[FIX 3] ⚠️ Could not find insertion point, trying alt...");
  // Try finding any useEffect with loadingCosmetics
  var altSearch = "useEffect(() => {";
  // Add the effect at a safe location - before handleInstall
  var handleInstallStart = vc.indexOf("const handleInstall = useCallback");
  if (handleInstallStart >= 0) {
    vc = vc.substring(0, handleInstallStart) + autoDownloadEffect + "\n  " + vc.substring(handleInstallStart);
    console.log("[FIX 3] ✅ Auto-download useEffect added (alt position)");
  }
}

fs.writeFileSync(viewPath, vc, "utf8");
console.log("[FIX 3] ✅ CosmeticsView.tsx updated");

// ======================================================================
console.log("\n========================================");
console.log("BUILD COMPLETE");
console.log("3 files modified");
console.log("========================================");
