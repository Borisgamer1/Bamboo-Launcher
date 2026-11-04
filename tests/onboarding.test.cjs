/**
 * First run and "what's new" are stored state: a fresh launcher has not seen
 * either, a saved decision wins, and anything unreadable must fall back to
 * "show the tour" / "show the changelog" instead of silently hiding both.
 * The changelog itself ships with the build, so a released version without an
 * entry must fail here instead of shipping an empty dialog.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..");
const ONBOARDING = pathToFileURL(path.join(ROOT, "src", "lib", "onboarding.ts")).href;
const CHANGELOG = pathToFileURL(path.join(ROOT, "src", "lib", "changelog.ts")).href;

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

test("onboarding: a fresh launcher has seen nothing", async () => {
  const { normalizeOnboarding } = await import(ONBOARDING);

  assert.deepEqual(normalizeOnboarding(undefined), { tourDone: false, lastSeenVersion: "" });
  assert.deepEqual(normalizeOnboarding(null), { tourDone: false, lastSeenVersion: "" });
  assert.deepEqual(normalizeOnboarding({}), { tourDone: false, lastSeenVersion: "" });
});

test("onboarding: a saved decision wins", async () => {
  const { normalizeOnboarding } = await import(ONBOARDING);

  assert.deepEqual(normalizeOnboarding({ tourDone: true, lastSeenVersion: "0.2.2" }), {
    tourDone: true,
    lastSeenVersion: "0.2.2",
  });
});

test("onboarding: unreadable values fall back to not seen", async () => {
  const { normalizeOnboarding } = await import(ONBOARDING);

  assert.deepEqual(normalizeOnboarding({ tourDone: "yes", lastSeenVersion: 42 }), {
    tourDone: false,
    lastSeenVersion: "",
  });
  assert.deepEqual(normalizeOnboarding("done"), { tourDone: false, lastSeenVersion: "" });
});

test("onboarding: the tour runs until it is finished", async () => {
  const { normalizeOnboarding, shouldShowTour } = await import(ONBOARDING);

  assert.equal(shouldShowTour(normalizeOnboarding({})), true);
  assert.equal(shouldShowTour(normalizeOnboarding({ tourDone: true })), false);
});

test("onboarding: the changelog appears once per version", async () => {
  const { normalizeOnboarding, shouldShowChangelog } = await import(ONBOARDING);

  assert.equal(shouldShowChangelog(normalizeOnboarding({}), "0.2.2"), true);
  assert.equal(shouldShowChangelog(normalizeOnboarding({ lastSeenVersion: "0.2.2" }), "0.2.2"), false);
  assert.equal(shouldShowChangelog(normalizeOnboarding({ lastSeenVersion: "0.2.1" }), "0.2.2"), true);
});

const FIXTURE = [
  "# Changelog",
  "",
  "## 0.2.2 - 2026-10-31",
  "",
  "### Neu",
  "",
  "- Neun Themes.",
  "- Statistiken über alle Instanzen.",
  "",
  "### New",
  "",
  "- Nine themes.",
  "",
  "## 0.2.1 - 2026-10-30",
  "",
  "### Neu",
  "",
  "- Alte Sache.",
  "",
].join("\n");

test("changelog: only the asked version and language are returned", async () => {
  const { parseChangelog } = await import(CHANGELOG);

  const de = parseChangelog(FIXTURE, "0.2.2", "de");
  const en = parseChangelog(FIXTURE, "0.2.2", "en");

  assert.deepEqual(de, { version: "0.2.2", groups: [{ title: "Neu", items: ["Neun Themes.", "Statistiken über alle Instanzen."] }] });
  assert.deepEqual(en, { version: "0.2.2", groups: [{ title: "New", items: ["Nine themes."] }] });
});

test("changelog: an unknown version returns nothing", async () => {
  const { parseChangelog } = await import(CHANGELOG);

  assert.equal(parseChangelog(FIXTURE, "9.9.9", "de"), null);
});

test("changelog: headings outside the known groups are ignored", async () => {
  const { parseChangelog } = await import(CHANGELOG);
  const markdown = ["## 1.0.0", "### Notes", "- ignored", "### Behoben", "- Ein Fehler."].join("\n");

  assert.deepEqual(parseChangelog(markdown, "1.0.0", "de"), {
    version: "1.0.0",
    groups: [{ title: "Behoben", items: ["Ein Fehler."] }],
  });
});

test("changelog: the shipped file documents the version being built", async () => {
  const { parseChangelog } = await import(CHANGELOG);
  const markdown = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");

  for (const lang of ["de", "en"]) {
    const entry = parseChangelog(markdown, VERSION, lang);
    assert.ok(entry, `CHANGELOG.md needs a ${VERSION} section for ${lang}`);
    const items = entry.groups.flatMap((group) => group.items);
    assert.ok(items.length >= 4, `the ${lang} ${VERSION} entry needs real items`);
  }
});
