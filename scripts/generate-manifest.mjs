// ============================================================
// Manifest Generator v1.0.0
// Scans the content repo directory and generates manifest.json
// with SHA-256 hashes for all tracked files.
//
// Usage: node scripts/generate-manifest.mjs [--dry-run]
// ============================================================

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.resolve(__dirname, "..", "..", "BambooContent");
const MANIFEST_PATH = path.join(CONTENT_DIR, "manifest.json");

// Directories / patterns to exclude
const EXCLUDE_PATTERNS = [
  ".git",
  "node_modules",
  "manifest.json",
  ".DS_Store",
  "Thumbs.db",
  "*.md",
];

function shouldExclude(filePath) {
  const name = path.basename(filePath);
  for (const pattern of EXCLUDE_PATTERNS) {
    if (pattern.includes("*")) {
      if (name.endsWith(pattern.replace("*", ""))) return true;
    } else if (name === pattern) {
      return true;
    }
  }
  return false;
}

function computeHash(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function walkDir(dir, baseDir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

    if (shouldExclude(entry.name)) continue;

    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, baseDir));
    } else if (entry.isFile()) {
      const stat = fs.statSync(fullPath);
      const hash = computeHash(fullPath);
      results.push({
        path: relativePath,
        hash,
        size: stat.size,
      });
    }
  }

  return results;
}

function generateManifest(dryRun = false) {
  console.log(`[ManifestGen] Scanning: ${CONTENT_DIR}`);

  if (!fs.existsSync(CONTENT_DIR)) {
    console.error(`[ManifestGen] ERROR: Content dir not found: ${CONTENT_DIR}`);
    process.exit(1);
  }

  const files = walkDir(CONTENT_DIR, CONTENT_DIR);

  // Sort by path for consistency
  files.sort((a, b) => a.path.localeCompare(b.path));

  // Read existing manifest to increment version
  let version = 1;
  if (fs.existsSync(MANIFEST_PATH)) {
    try {
      const existing = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
      const oldFiles = new Map(existing.files.map((f) => [f.path, f.hash]));
      const newFiles = new Map(files.map((f) => [f.path, f.hash]));

      // Check if any file changed (added, removed, or hash changed)
      let hasChanges = oldFiles.size !== newFiles.size;
      if (!hasChanges) {
        for (const [p, h] of newFiles) {
          if (oldFiles.get(p) !== h) {
            hasChanges = true;
            break;
          }
        }
      }

      if (hasChanges) {
        version = (existing.version || 0) + 1;
      } else {
        version = existing.version || 1;
      }
    } catch {
      // Invalid existing manifest, start fresh
    }
  }

  const manifest = {
    schemaVersion: 1,
    version,
    updatedAt: new Date().toISOString(),
    files,
  };

  if (dryRun) {
    console.log(`[ManifestGen] DRY RUN - Would generate v${version} with ${files.length} files`);
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  console.log(`[ManifestGen] Generated v${version} with ${files.length} files`);
  console.log(`[ManifestGen] Written to: ${MANIFEST_PATH}`);
}

// Run
const dryRun = process.argv.includes("--dry-run");
generateManifest(dryRun);
