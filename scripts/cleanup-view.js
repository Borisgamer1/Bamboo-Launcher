var fs = require("fs");
var vc = fs.readFileSync("src/components/CosmeticsView.tsx", "utf8");

// 1. Remove the disk-loading block between Step 1 and server fetch
var step2Comment = "// Step 2: Load model JSON \u2014 use REAL filename from manifest if available, else skip disk attempt";
var idx = vc.indexOf(step2Comment);
if (idx >= 0) {
  var serverFetchComment = "// If not on disk, try fetching from server API";
  var serverIdx = vc.indexOf(serverFetchComment, idx);
  if (serverIdx > idx) {
    vc = vc.substring(0, idx) + vc.substring(serverIdx);
    console.log("1. Removed Step 2 disk block");
  }
}

// 2. Remove loadedFromDisk references
vc = vc.replace(/loadedFromDisk = true;\n/g, "");
vc = vc.replace(/var loadedFromDisk = .*;\n/g, "");

// 3. Clean up server fetch comment
vc = vc.replace("// If not on disk, try fetching from server API", "// Fetch model JSON from server API");

// 4. Remove realTextureFiles console.log
vc = vc.replace(
  "console.log('[Cosmetics] loadBlockbenchModel: loading', textures.length, 'textures. realTextureFiles from manifest:', JSON.stringify(realTextureFiles));\n",
  "console.log('[Cosmetics] loadBlockbenchModel: loading', textures.length, 'textures');\n"
);

// 5. Replace the realTextureFiles.find block with simple direct source name usage
var findStart = "        // Match: exact filename or subdirectory path\n        var matchedFile = realTextureFiles.find(function(f) {\n          var fn = f.replace(/\\\\/g, \"/\");\n          return fn === sourceName || fn.endsWith(\"/\" + sourceName);\n        });\n";
var findReplace = "        var matchedFile = null;\n";
if (vc.indexOf(findStart) >= 0) {
  vc = vc.replace(findStart, findReplace);
  console.log("5. Replaced realTextureFiles.find with null");
}

// 6. Replace texPath construction to just use sourceName directly
var texPathOld = "var texPath = matchedFile ? ('cosmetics/' + slug + '/' + matchedFile) : ('cosmetics/' + slug + '/' + sourceName);\n";
var texPathNew = "var texPath = 'cosmetics/' + slug + '/' + sourceName;\n";
vc = vc.replace(texPathOld, texPathNew);
console.log("6. Simplified texPath construction");

// 7. Remove var realModelFile
vc = vc.replace(/var realModelFile = null;\n/g, "");
console.log("7. Removed realModelFile declaration");

// 8. Remove realTextureFiles array
vc = vc.replace(/var realTextureFiles = \[\];\n/g, "");
console.log("8. Removed realTextureFiles declaration");

fs.writeFileSync("src/components/CosmeticsView.tsx", vc, "utf8");
console.log("DONE");
