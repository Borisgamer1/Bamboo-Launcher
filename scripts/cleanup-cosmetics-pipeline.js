// ============================================================
// CLEANUP: Remove all broken cosmetics pipeline code
// ============================================================
var fs = require("fs");

var filesModified = [];

// ======================================================================
// FIX 1: cosmeticsDownloader.ts — simplify installCosmetic to stub
// ======================================================================
var downloaderPath = "src/services/cosmetics/cosmeticsDownloader.ts";
var dc = fs.readFileSync(downloaderPath, "utf8");

// 1a) Remove API_BASE import
dc = dc.replace('import { API_BASE, getLauncherHeaders } from "../api";\n', "");

// 1b) Replace entire installCosmetic function with stub
var installStub = `export async function installCosmetic(
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
}`;

// Find the installCosmetic function start and end
var installStartIdx = dc.indexOf("export async function installCosmetic(");
var installEndIdx = dc.indexOf("export async function uninstallCosmetic(");

if (installStartIdx >= 0 && installEndIdx > installStartIdx) {
  var before = dc.substring(0, installStartIdx);
  var after = dc.substring(installEndIdx);
  dc = before + installStub + "\n\n" + after;
  console.log("[FIX 1] ✅ installCosmetic simplified, removed", (installEndIdx - installStartIdx), "chars");
} else {
  console.log("[FIX 1] ❌ Could not find installCosmetic boundaries");
}

fs.writeFileSync(downloaderPath, dc, "utf8");
filesModified.push(downloaderPath);

// ======================================================================
// FIX 2: CosmeticsView.tsx — remove NON_MODEL_TYPES + simplify loadBlockbenchModel
// ======================================================================
var viewPath = "src/components/CosmeticsView.tsx";
var vc = fs.readFileSync(viewPath, "utf8");

// 2a) Remove the NON_MODEL_TYPES if-else block in useEffect
// Pattern: the comment "// Load Blockbench model from disk" through the end of the else block
var nonModelPattern = "// Load Blockbench model from disk or server (only for types that have 3D models)";
var nonModelIdx = vc.indexOf(nonModelPattern);
if (nonModelIdx >= 0) {
  // Find the end: look for "clearBlockbenchModel(viewer, blockbenchGroupRef);" after the pattern
  var afterNonModel = vc.substring(nonModelIdx);
  var clearBlockbenchEnd = afterNonModel.indexOf("clearBlockbenchModel(viewer, blockbenchGroupRef);");
  if (clearBlockbenchEnd >= 0) {
    // Find the close of this block: })
    var blockEnd = afterNonModel.indexOf("    }", clearBlockbenchEnd + 50);
    if (blockEnd >= 0) blockEnd += 5; // include the "    }"
    
    var simplifiedBlock = `    // Try loading Blockbench 3D model from server
    blockbenchCancelledRef.current = false;
    loadBlockbenchModel(slug, viewer, blockbenchGroupRef, blockbenchCancelledRef, loadedBlockbenchRef, 0).catch(function(err) {
      console.warn('[Cosmetics] Blockbench model load failed:', err);
    });`;
    
    vc = vc.substring(0, nonModelIdx) + simplifiedBlock + vc.substring(nonModelIdx + blockEnd);
    console.log("[FIX 2a] ✅ NON_MODEL_TYPES check removed");
  }
}

// 2b) Simplify loadBlockbenchModel — remove Step 1 manifest reading, simplify to direct server fetch
// Find "// Step 1: Read manifest.json to find the REAL model filename"
var step1Pattern = "// Step 1: Read manifest.json to find the REAL model filename";
var step1Idx = vc.indexOf(step1Pattern);
if (step1Idx >= 0) {
  // Find "// Step 2: Load model JSON" or "if (realModelFile)" whichever comes first after Step 1
  var afterStep1 = vc.substring(step1Idx);
  var step2Idx = afterStep1.indexOf("// Step 2:");
  if (step2Idx < 0) step2Idx = afterStep1.indexOf("if (realModelFile)");
  if (step2Idx < 0) step2Idx = afterStep1.indexOf("if (!jsonContent)");
  
  if (step2Idx >= 0) {
    var step1Content = afterStep1.substring(0, step2Idx);
    var simpleStep1 = `// Step 1: Load model JSON directly from server API
    console.log('[Cosmetics] loadBlockbenchModel: Step 1 — fetching model from server for slug =', slug);
    var jsonContent = '';`;
    
    vc = vc.substring(0, step1Idx) + simpleStep1 + vc.substring(step1Idx + step1Content.length);
    console.log("[FIX 2b] ✅ Step 1 manifest reading removed (" + step1Content.length + " chars)");
  }
}

// 2c) Remove Step 2 disk-loading block (if (realModelFile) { ... })
// After removing Step 1, look for the disk-load block that follows
var diskBlockStart = "if (realModelFile) {";
var diskBlockIdx = vc.indexOf(diskBlockStart);
if (diskBlockIdx >= 0) {
  // Find the end of this block: the line with "}" that closes this if
  var afterDiskBlock = vc.substring(diskBlockIdx);
  // Look for "clearBlockbenchModel(viewer, blockbenchGroupRef);" inside the block
  var clearBbsIdx = afterDiskBlock.indexOf("clearBlockbenchModel(viewer, blockbenchGroupRef);");
  if (clearBbsIdx >= 0) {
    // Find the next two closing braces after this line
    var searchFrom = clearBbsIdx + 50;
    var firstClose = afterDiskBlock.indexOf("}\n", searchFrom);
    var secondClose = firstClose >= 0 ? afterDiskBlock.indexOf("}\n", firstClose + 2) : -1;
    var blockEndPos = secondClose >= 0 ? secondClose + 2 : afterDiskBlock.indexOf("}\n", searchFrom) + 2;
    
    vc = vc.substring(0, diskBlockIdx) + vc.substring(diskBlockIdx + blockEndPos);
    console.log("[FIX 2c] ✅ Disk-loading realModelFile block removed");
  }
}

// 2d) Clean up any orphan realModelFile/realTextureFiles references
// Remove "var realModelFile = null;" and "var realTextureFiles = [];" and related comments
vc = vc.replace(/var realModelFile = null;.*\n/g, "var realModelFile = null;\n");
vc = vc.replace(/var realTextureFiles = \[\];\n/g, "");

fs.writeFileSync(viewPath, vc, "utf8");
filesModified.push(viewPath);
console.log("[FIX 2] ✅ CosmeticsView.tsx cleaned");

// ======================================================================
// FIX 3: contentRoutes.js — remove /api/content/files/:fileId/download
// ======================================================================
var routesPath = "server/src/contentRoutes.js";
var rc = fs.readFileSync(routesPath, "utf8");

// Find the comment line that starts the endpoint
var endpointComment = "// === GET /api/content/files/:fileId/download — Generic file download =";
var endpointIdx = rc.indexOf(endpointComment);
if (endpointIdx >= 0) {
  // Find where the handler ends: look for "return res.sendFile(path.resolve(diskPath));" and then two closing braces
  var afterEndpoint = rc.substring(endpointIdx);
  var sendFileLine = afterEndpoint.indexOf("return res.sendFile(path.resolve(diskPath));");
  if (sendFileLine >= 0) {
    var handlerEnd = sendFileLine + 52; // length of that line
    // Find the }); that closes the app.get
    var closeBrace = afterEndpoint.indexOf("});", handlerEnd);
    if (closeBrace >= 0) handlerEnd = closeBrace + 3;
    // Include the newline after })
    if (afterEndpoint.charAt(handlerEnd) === "\n") handlerEnd++;
    
    vc = rc.substring(0, endpointIdx) + rc.substring(endpointIdx + handlerEnd);
    rc = vc;
    // Clean up blank lines
    rc = rc.replace(/\n{3,}/g, "\n\n");
    console.log("[FIX 3] ✅ /api/content/files/:fileId/download endpoint removed (" + handlerEnd + " chars)");
  } else {
    console.log("[FIX 3] ❌ Could not find 'return res.sendFile' in handler");
  }
} else {
  console.log("[FIX 3] ⚠️ Endpoint not found, checking alt pattern...");
  var altComment = "// === GET /api/content/files/:fileId/download";
  var altIdx = rc.indexOf(altComment);
  if (altIdx >= 0) {
    // Find next app.get or router.get
    var afterAlt = rc.substring(altIdx);
    var nextGet = afterAlt.indexOf("\napp.get(");
    if (nextGet < 0) nextGet = afterAlt.indexOf("\nrouter.get(");
    if (nextGet < 0) nextGet = afterAlt.length;
    
    rc = rc.substring(0, altIdx) + when_get_null;
    rc = rc.replace(/\n{3,}/g, "\n\n");
    console.log("[FIX 3] ✅ Endpoint removed via alt pattern, removed " + nextGet + " chars");
  } else {
    console.log("[FIX 3] ⚠️ Endpoint already removed or not found");
  }
}

fs.writeFileSync(routesPath, rc, "utf8");
filesModified.push(routesPath);

// ======================================================================
// FIX 4: main.js — replace save-cosmetic-files + read-cosmetic-file with no-ops
// ======================================================================
var mainPath = "main.js";
var mc = fs.readFileSync(mainPath, "utf8");

// 4a) Replace save-cosmetic-files handler
var saveHandlerStart = "ipcMain.handle('save-cosmetic-files', async (_event, { slug, files }) => {";
var saveIdx = mc.indexOf(saveHandlerStart);
if (saveIdx >= 0) {
  // Find the closing line: "});" with a newline before next section
  var afterSave = mc.substring(saveIdx);
  // Find the }) that closes the handler
  var closeHandler = afterSave.indexOf("});");
  if (closeHandler >= 0) {
    // Extend to include the closing and newline
    var handlerEnd = closeHandler + 3;
    if (afterSave.charAt(handlerEnd) === "\n") handlerEnd++;
    
    var saveNoop = "ipcMain.handle('save-cosmetic-files', async (_event, data) => {\n  console.log('[cosmetics] save-cosmetic-files: pipeline removed, no-op');\n  return { success: true, path: '', fileCount: 0 };\n});\n";
    
    mc = mc.substring(0, saveIdx) + saveNoop + mc.substring(saveIdx + handlerEnd);
    console.log("[FIX 4a] ✅ save-cosmetic-files replaced with no-op, removed " + handlerEnd + " chars");
  }
}

// 4b) Replace read-cosmetic-file handler
var readHandlerStart = "ipcMain.handle('read-cosmetic-file', async (_event, filePath) => {";
var readIdx = mc.indexOf(readHandlerStart);
if (readIdx >= 0) {
  var afterRead = mc.substring(readIdx);
  var closeHandler = afterRead.indexOf("});");
  var nextAfterClose = closeHandler >= 0 ? closeHandler + 3 : afterRead.length;
  
  var readNoop = "ipcMain.handle('read-cosmetic-file', async (_event, filePath) => {\n  console.log('[cosmetics] read-cosmetic-file: pipeline removed, no-op');\n  return { success: false, error: 'Pipeline removed' };\n});\n";
  
  mc = mc.substring(0, readIdx) + readNoop + mc.substring(readIdx + nextAfterClose);
  console.log("[FIX 4b] ✅ read-cosmetic-file replaced with no-op");
}

fs.writeFileSync(mainPath, mc, "utf8");
filesModified.push(mainPath);

// ======================================================================
console.log("\n========================================");
console.log("CLEANUP COMPLETE —", filesModified.length, "files modified");
filesModified.forEach(function(f) { console.log("  ✔ " + f); });
console.log("========================================");
