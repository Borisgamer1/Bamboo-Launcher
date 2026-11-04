/**
 * §3.1 keyboard contract, unit-tested against the pure model the palette uses.
 *
 * The end-to-end pass sends real keys through CDP against the dev server
 * (screenshots/phase-13); this file pins the decision table so a refactor
 * cannot silently change what Tab, Enter or 1…9 mean.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");

const MODEL = pathToFileURL(
  path.join(__dirname, "..", "src", "lib", "paletteKeys.ts")
).href;

const state = (overrides = {}) => ({
  query: "",
  selected: 0,
  count: 4,
  panelOpen: false,
  ...overrides,
});

test("palette model: 1…9 jumps to and runs row n while the query is empty", async () => {
  const { resolvePaletteKey } = await import(MODEL);
  assert.deepEqual(resolvePaletteKey({ key: "2" }, state()), { type: "digit", index: 1 });
  assert.deepEqual(resolvePaletteKey({ key: "9" }, state({ count: 9 })), { type: "digit", index: 8 });
  // beyond the visible rows: nothing to run, the key is ignored
  assert.deepEqual(resolvePaletteKey({ key: "9" }, state({ count: 4 })), { type: "none" });
  // with a query the digit must type, otherwise "1.21" cannot be searched
  assert.deepEqual(resolvePaletteKey({ key: "2" }, state({ query: "1" })), { type: "none" });
  // Ctrl+1 is not part of the contract and stays inert
  assert.deepEqual(resolvePaletteKey({ key: "1", ctrlKey: true }, state()), { type: "none" });
  // while the action panel is open the list is not addressable
  assert.deepEqual(resolvePaletteKey({ key: "1" }, state({ panelOpen: true })), { type: "none" });
});

test("palette model: Tab opens the action panel and closes it again", async () => {
  const { resolvePaletteKey } = await import(MODEL);
  assert.deepEqual(resolvePaletteKey({ key: "Tab" }, state()), { type: "open-panel" });
  assert.deepEqual(resolvePaletteKey({ key: "Tab" }, state({ panelOpen: true })), {
    type: "close-panel",
  });
  assert.deepEqual(resolvePaletteKey({ key: "Tab", shiftKey: true }, state()), {
    type: "open-panel",
  });
});

test("palette model: arrows move in the list or in the open panel", async () => {
  const { resolvePaletteKey } = await import(MODEL);
  assert.deepEqual(resolvePaletteKey({ key: "ArrowDown" }, state()), { type: "move", delta: 1 });
  assert.deepEqual(resolvePaletteKey({ key: "ArrowUp" }, state()), { type: "move", delta: -1 });
  assert.deepEqual(resolvePaletteKey({ key: "ArrowDown" }, state({ panelOpen: true })), {
    type: "move-panel",
    delta: 1,
  });
  assert.deepEqual(resolvePaletteKey({ key: "ArrowUp" }, state({ panelOpen: true })), {
    type: "move-panel",
    delta: -1,
  });
});

test("palette model: Enter runs, Ctrl+Enter runs the secondary action", async () => {
  const { resolvePaletteKey } = await import(MODEL);
  assert.deepEqual(resolvePaletteKey({ key: "Enter" }, state()), { type: "run" });
  assert.deepEqual(resolvePaletteKey({ key: "Enter", ctrlKey: true }, state()), {
    type: "run-secondary",
  });
  assert.deepEqual(resolvePaletteKey({ key: "Enter", metaKey: true }, state()), {
    type: "run-secondary",
  });
  // inside the panel the highlighted action is what Enter runs
  assert.deepEqual(resolvePaletteKey({ key: "Enter" }, state({ panelOpen: true })), { type: "run" });
});

test("palette model: Escape closes the panel first, then the palette", async () => {
  const { resolvePaletteKey } = await import(MODEL);
  assert.deepEqual(resolvePaletteKey({ key: "Escape" }, state({ panelOpen: true })), {
    type: "close-panel",
  });
  assert.deepEqual(resolvePaletteKey({ key: "Escape" }, state()), { type: "close" });
});

test("palette model: Ctrl+, opens settings, Ctrl+K stays with the global handler", async () => {
  const { resolvePaletteKey } = await import(MODEL);
  assert.deepEqual(resolvePaletteKey({ key: ",", ctrlKey: true }, state()), { type: "settings" });
  assert.deepEqual(resolvePaletteKey({ key: "k", ctrlKey: true }, state()), { type: "none" });
  assert.deepEqual(resolvePaletteKey({ key: "a" }, state()), { type: "none" });
  assert.deepEqual(resolvePaletteKey({ key: " " }, state()), { type: "none" });
});

test("palette model: highlight wraps in both directions and survives an empty list", async () => {
  const { wrapIndex } = await import(MODEL);
  assert.equal(wrapIndex(0, -1, 4), 3);
  assert.equal(wrapIndex(3, 1, 4), 0);
  assert.equal(wrapIndex(1, 1, 4), 2);
  assert.equal(wrapIndex(0, 1, 0), 0);
});

test("palette model: the component routes every key through the model", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "components", "CommandPalette.tsx"),
    "utf8"
  );
  assert.match(source, /resolvePaletteKey\(/, "CommandPalette must use the shared model");
  assert.match(source, /run-secondary/, "secondary action must be wired");
  assert.match(source, /open-panel/, "Tab must open the action panel");
  assert.match(source, /"digit"/, "1…9 must jump");
});
