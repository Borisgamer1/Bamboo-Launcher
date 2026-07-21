var fs = require("fs");

// ======================================================================
// FIX 1: Re-add /api/content/files/:fileId/download endpoint
// ======================================================================
var rc = fs.readFileSync("server/src/contentRoutes.js", "utf8");

var endpointCode = [
  "",
  '  // === GET /api/content/files/:fileId/download - Download content file ===',
  '  // ====================================================================',
  "  // Serves ANY content file directly from disk by its asset_files ID.",
  "  app.get('/api/content/files/:fileId/download', async (req, res) => {",
  "    try {",
  "      if (!dbState.connected) return res.status(503).json({ error: 'Database not available' });",
  "      const fileId = parseInt(req.params.fileId, 10);",
  "      if (isNaN(fileId)) return res.status(400).json({ error: 'Invalid file ID' });",
  "      const files = await pool.query('SELECT * FROM asset_files WHERE id = $1', [fileId]);",
  "      if (!files.rows.length) return res.status(404).json({ error: 'File not found in database' });",
  "      var frow = files.rows[0];",
  "      var diskPath = frow.disk_path || path.join(CONTENT_ROOT, frow.file_path);",
  "      if (!diskPath || !fs.existsSync(diskPath)) return res.status(404).json({ error: 'File not found on disk: ' + diskPath });",
  "      console.log('[content] Serving file download:', diskPath, '(' + (frow.file_name || 'unknown') + ')');",
  "      return res.sendFile(path.resolve(diskPath));",
  "    } catch (err) {",
  "      return res.status(500).json({ error: err.message });",
  "    }",
  "  });",
].join("\n");

var insertTarget = "// === GET /api/content/:type/:id/model \u2014 Serve 3D model file =======";
var idx = rc.indexOf(insertTarget);
if (idx >= 0) {
  rc = rc.substring(0, idx) + endpointCode + "\n\n  " + rc.substring(idx);
  console.log("FIX 1: File download endpoint re-added to contentRoutes.js");
} else {
  console.log("FIX 1: Could not find insertion point, trying simple match...");
  var altTarget = "// === GET /api/content/:type/:id/model";
  var altIdx = rc.indexOf(altTarget);
  if (altIdx >= 0) {
    rc = rc.substring(0, altIdx) + endpointCode + "\n\n  " + rc.substring(altIdx);
    console.log("FIX 1: Inserted via alt match");
  }
}

fs.writeFileSync("server/src/contentRoutes.js", rc, "utf8");

// ======================================================================
// FIX 2: Fix cancelledEarly reference in cosmeticsDownloader.ts
// ======================================================================
var dc = fs.readFileSync("src/services/cosmetics/cosmeticsDownloader.ts", "utf8");
dc = dc.replace(
  "      if (cancelledEarly) break;\n",
  "      // No cancellation in fallback loop\n"
);
fs.writeFileSync("src/services/cosmetics/cosmeticsDownloader.ts", dc, "utf8");
console.log("FIX 2: cancelledEarly reference fixed");

console.log("DONE");
