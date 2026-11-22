#!/usr/bin/env node
// Prüft ein veröffentlichtes Release gegen seine eigenen Angaben:
// latest.json, Download-URLs, Updater-Signaturen und SHA256SUMS.txt.
//
//   node scripts/verify-release.mjs            # Version aus tauri.conf.json
//   node scripts/verify-release.mjs v0.2.9
//   node scripts/verify-release.mjs v0.2.9 --skip-checksums
//
// Exit-Code 1 bei jedem Fund. Ohne --skip-checksums werden alle Pakete
// heruntergeladen und nachgerechnet (rund 450 MB).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const REPO = "Borisgamer1/Bamboo-Launcher";
const PLATFORM_ASSETS = {
  "windows-x86_64": "x64-setup.exe",
  "darwin-aarch64": "aarch64.app.tar.gz",
  "darwin-x86_64": "x64.app.tar.gz",
  "linux-x86_64": "amd64.AppImage",
};

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const tagArg = args.find((arg) => !arg.startsWith("--"));

const config = JSON.parse(readFileSync(new URL("../tauri.conf.json", import.meta.url), "utf8"));
const version = config.version;
const tag = tagArg || `v${version}`;
const base = `https://github.com/${REPO}/releases/download/${tag}`;

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function pass(message) {
  notes.push(message);
}

function keyIdOf(signatureBase64) {
  const text = Buffer.from(signatureBase64, "base64").toString("utf8");
  const line = text.split("\n")[1] || "";
  return Buffer.from(line, "base64").subarray(2, 10).toString("hex");
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} für ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  const pubkeyText = Buffer.from(config.plugins.updater.pubkey, "base64").toString("utf8");
  const pubkeyId = Buffer.from(pubkeyText.split("\n")[1] || "", "base64")
    .subarray(2, 10)
    .toString("hex");

  const feed = JSON.parse((await download(`${base}/latest.json`)).toString("utf8"));
  if (feed.version !== version) fail(`latest.json meldet ${feed.version}, erwartet ${version}`);
  else pass(`latest.json: ${feed.version}`);

  for (const [platform, suffix] of Object.entries(PLATFORM_ASSETS)) {
    const entry = feed.platforms?.[platform];
    if (!entry) {
      fail(`latest.json: Plattform ${platform} fehlt`);
      continue;
    }
    if (!entry.url?.endsWith(suffix)) {
      fail(`latest.json/${platform}: URL endet nicht auf ${suffix} (${entry.url})`);
    } else {
      pass(`${platform}: ${entry.url.split("/").pop()}`);
    }
    let signature = "";
    try {
      signature = keyIdOf(entry.signature || "");
    } catch {
      fail(`latest.json/${platform}: Signatur nicht lesbar`);
      continue;
    }
    if (signature !== pubkeyId) fail(`${platform}: Signatur passt nicht zum Updater-Key`);
    else pass(`${platform}: Signatur passt zum Updater-Key`);
  }

  for (const platform of Object.keys(PLATFORM_ASSETS)) {
    const url = feed.platforms?.[platform]?.url;
    if (!url) continue;
    const head = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (!head.ok) fail(`${platform}: Download antwortet mit HTTP ${head.status}`);
  }

  const sums = (await download(`${base}/SHA256SUMS.txt`)).toString("utf8");
  const entries = sums
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^([0-9a-f]{64})\s{1,2}(.+)$/i.exec(line);
      return match ? { hash: match[1].toLowerCase(), name: match[2] } : null;
    })
    .filter(Boolean);

  if (entries.length === 0) fail("SHA256SUMS.txt enthält keine gültigen Zeilen");
  else pass(`SHA256SUMS.txt: ${entries.length} Einträge`);

  if (flags.has("--skip-checksums")) {
    pass("Prüfsummen übersprungen (--skip-checksums)");
  } else {
    for (const entry of entries) {
      const data = await download(`${base}/${encodeURIComponent(entry.name)}`);
      const hash = createHash("sha256").update(data).digest("hex");
      if (hash !== entry.hash) fail(`${entry.name}: Prüfsumme weicht ab`);
      else pass(`${entry.name}: Prüfsumme ok`);
    }
  }

  for (const line of notes) console.log(`ok   ${line}`);
  for (const line of failures) console.error(`FEHL ${line}`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} Problem(e) am Release ${tag}.`);
    process.exit(1);
  }
  console.log(`\nRelease ${tag} ist vollständig und stimmt mit tauri.conf.json überein.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
