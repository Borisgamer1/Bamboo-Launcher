/**
 * The launcher only updates itself from the newest published GitHub release,
 * and only if that release carries the installer, its blockmap and latest.yml.
 * v0.2.1 shipped without latest.yml, which silently disabled updates for every
 * installed copy; these checks make that state impossible to publish unnoticed.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..");
const FEED = require(path.join(ROOT, "scripts", "updateFeed.cjs")).evaluateRelease;
const PARSE = require(path.join(ROOT, "scripts", "updateFeed.cjs")).parseLatestVersion;

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

const complete = {
  version: VERSION,
  tag: `v${VERSION}`,
  assets: [
    `Bamboo-Launcher-Setup-${VERSION}.exe`,
    `Bamboo-Launcher-Setup-${VERSION}.exe.blockmap`,
    "latest.yml",
  ],
  latestYmlVersion: VERSION,
  draft: false,
  prerelease: false,
};

test("release feed: a complete release passes", () => {
  assert.deepEqual(FEED(complete), { ok: true, problems: [], warnings: [] });
});

test("release feed: a release without latest.yml cannot update anyone", () => {
  const result = FEED({ ...complete, assets: [`Bamboo-Launcher-Setup-${VERSION}.exe`], latestYmlVersion: null });

  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("latest.yml")));
});

test("release feed: a missing blockmap only costs the delta download", () => {
  const result = FEED({
    ...complete,
    assets: [`Bamboo-Launcher-Setup-${VERSION}.exe`, "latest.yml"],
  });

  assert.equal(result.ok, true, "updates still work without a blockmap");
  assert.ok(result.warnings.some((warning) => warning.includes("blockmap")));
});

test("release feed: a stale latest.yml version is reported", () => {
  const result = FEED({ ...complete, latestYmlVersion: "0.2.1" });

  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("0.2.1")));
});

test("release feed: drafts and pre-releases are invisible to the updater", () => {
  assert.equal(FEED({ ...complete, draft: true }).ok, false);
  assert.equal(FEED({ ...complete, prerelease: true }).ok, false);
});

test("release feed: the tag has to match the built version", () => {
  const result = FEED({ ...complete, tag: "v0.2.1" });

  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes("v0.2.1")));
});

test("release feed: latest.yml is parsed regardless of quoting and line endings", () => {
  assert.equal(PARSE("version: 0.2.2\r\npath: x.exe\r\n"), "0.2.2");
  assert.equal(PARSE("version: '0.2.2'\n"), "0.2.2");
  assert.equal(PARSE("no version here"), null);
});

test("release feed: the embedded launcher version matches package.json", () => {
  const args = fs.readFileSync(path.join(ROOT, "electron", "launch", "args.ts"), "utf8");
  const match = /LAUNCHER_VERSION\s*=\s*'([^']+)'/.exec(args);

  assert.ok(match, "electron/launch/args.ts must export LAUNCHER_VERSION");
  assert.equal(match[1], VERSION, "ship the version from package.json in launch metadata");
});
