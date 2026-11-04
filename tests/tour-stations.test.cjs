/**
 * The tour walks the real launcher: steps that need a page change are gated by
 * the user clicking the highlighted control, view-only steps advance with a
 * button. The list is built from the current state, so a launcher that already
 * has instances does not teach creating the first one.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..");
const MODEL = pathToFileURL(path.join(ROOT, "src", "components", "onboarding", "onboardingCopy.ts")).href;

const targetsOf = (stations) => stations.map((station) => station.target);

test("tour: a fresh launcher is taught to create its first instance", async () => {
  const { buildTourStations } = await import(MODEL);
  const targets = targetsOf(buildTourStations({ hasInstances: false }));

  assert.ok(targets.includes('[data-tour="instance-create"]'));
  assert.ok(targets.includes('[data-tour="instance-create-confirm"]'));
});

test("tour: an existing instance skips the creation steps", async () => {
  const { buildTourStations } = await import(MODEL);
  const targets = targetsOf(buildTourStations({ hasInstances: true }));

  assert.ok(!targets.includes('[data-tour="instance-create"]'));
  assert.ok(!targets.includes('[data-tour="instance-create-confirm"]'));
  assert.ok(targets.includes('[data-tour="instance-card"]'));
});

test("tour: navigation and creation steps only advance by clicking", async () => {
  const { buildTourStations } = await import(MODEL);
  const clickGated = buildTourStations({ hasInstances: false })
    .filter((station) => station.advance === "click")
    .map((station) => station.target);

  assert.deepEqual(clickGated, [
    '[data-tour="nav-instances"]',
    '[data-tour="instance-create"]',
    '[data-tour="instance-create-confirm"]',
    '[data-tour="nav-mods"]',
    '[data-tour="nav-settings"]',
    '[data-tour="settings-tab-gameOptions"]',
    '[data-tour="settings-tab-keybinds"]',
    '[data-tour="settings-tab-appearance"]',
  ]);
});

test("tour: settings are walked one tab at a time", async () => {
  const { buildTourStations } = await import(MODEL);
  const targets = targetsOf(buildTourStations({ hasInstances: true }));
  const order = [
    "settings-tab-general",
    "settings-tab-gameOptions",
    "settings-tab-keybinds",
    "settings-tab-appearance",
  ].map((anchor) => targets.indexOf(`[data-tour="${anchor}"]`));

  assert.ok(order.every((index) => index >= 0), "every settings tab needs a station");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "settings tabs must be walked in order");
});

test("tour: every station is complete in both languages", async () => {
  const { buildTourStations } = await import(MODEL);

  for (const station of buildTourStations({ hasInstances: false })) {
    assert.ok(station.target.startsWith("[data-tour="), `${station.target} must be a tour anchor`);
    for (const lang of ["de", "en"]) {
      assert.ok(station.title[lang].length > 2, `${station.target} needs a ${lang} title`);
      assert.ok(station.body[lang].length > 10, `${station.target} needs a ${lang} body`);
    }
    if (station.advance === "click") {
      for (const lang of ["de", "en"]) {
        assert.ok(station.hint?.[lang], `${station.target} must tell the user what to click`);
      }
    }
  }
});
