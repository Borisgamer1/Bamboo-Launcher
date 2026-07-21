var fs = require("fs");
var dc = fs.readFileSync("src/services/cosmetics/cosmeticsDownloader.ts", "utf8");

// Fix 1: installingSlugs cleanup before the guard (stale lock cleanup)
dc = dc.replace(
  "  installingSlugs.delete(entity.slug); // Clean up any stale lock\n  if (installingSlugs.has(entity.slug)) {",
  "  if (installingSlugs.has(entity.slug)) {"
);
dc = dc.replace(
  "  if (installingSlugs.has(entity.slug)) {\n    console.log(\"[Cosmetics] installCosmetic: already installing, skipping \u2014\", entity.slug);\n    return false;\n  }",
  "  installingSlugs.delete(entity.slug); // Clean up any stale lock from a previous crash\n  if (installingSlugs.has(entity.slug)) {\n    console.log(\"[Cosmetics] installCosmetic: already installing, skipping \u2014\", entity.slug);\n    return false;\n  }"
);

// Fix 2: Add server API fallback after GitHub CDN fails
var checkResultsStart = "  // Check results";
var idx = dc.indexOf(checkResultsStart);
if (idx >= 0) {
  var fallbackSection = `
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
          console.log("[Cosmetics] installCosmetic: fallback fetch \u2014", url);
          var resp = await fetch(url, { headers: getHeaders() });
          if (resp.ok) {
            var buf = await resp.arrayBuffer();
            await storeData(fileRef.filePath, buf);
            console.log("[Cosmetics] installCosmetic: \u2714 fallback downloaded", fileRef.fileName);
          } else {
            console.log("[Cosmetics] installCosmetic: \u2716 fallback HTTP", resp.status, "for", fileRef.fileName);
            fallbackOk = false;
          }
        } catch (e) {
          console.log("[Cosmetics] installCosmetic: \u2716 fallback error", e.message);
          fallbackOk = false;
        }
      }

      if (fallbackOk) {
        allOk = true;
        console.log("[Cosmetics] installCosmetic: \u2714 fallback successful \u2014 all files from server");
      } else {
        console.log("[Cosmetics] installCosmetic: \u2716 fallback also failed");
      }
    } catch (e) {
      console.log("[Cosmetics] installCosmetic: fallback import error", e.message);
    }
  }
`;

  dc = dc.substring(0, idx) + fallbackSection + "\n\n  " + dc.substring(idx);
  console.log("Added server API fallback after GitHub CDN check");
}

fs.writeFileSync("src/services/cosmetics/cosmeticsDownloader.ts", dc, "utf8");
console.log("DONE");
