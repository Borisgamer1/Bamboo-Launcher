/**
 * §3.5 dialogs: one primitive owns modality, and focus is decided once — at
 * open, from what is already mounted. The rendering proof lives in
 * screenshots/phase-16 and screenshots/phase-18 (headless Chrome over CDP).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..");
const MODEL = pathToFileURL(path.join(ROOT, "src", "lib", "dialogFocus.ts")).href;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const DIALOGS = [
  ["src/App.tsx", "exit-dialog-title"],
  ["src/components/InstancesView.tsx", "delete-dialog-title"],
  ["src/components/InstancesView.tsx", "create-dialog-title"],
  ["src/components/InstancesView.tsx", "rename-dialog-title"],
  ["src/components/InstancesView.tsx", "own-mods-warning-title"],
  ["src/components/ProfileImportModal.tsx", "import-dialog-title"],
  ["src/components/ProfileExportModal.tsx", "profile-export-dialog-title"],
];

const CALL_SITES = [
  "src/App.tsx",
  "src/components/InstancesView.tsx",
  "src/components/ProfileImportModal.tsx",
  "src/components/ProfileExportModal.tsx",
];

test("dialog focus: Tab wraps forward and Shift+Tab wraps backward", async () => {
  const { nextFocusIndex } = await import(MODEL);
  assert.equal(nextFocusIndex(0, 3, false), 1);
  assert.equal(nextFocusIndex(2, 3, false), 0);
  assert.equal(nextFocusIndex(0, 3, true), 2);
  assert.equal(nextFocusIndex(1, 3, true), 0);
});

test("dialog focus: focus outside the list enters at the correct edge", async () => {
  const { nextFocusIndex } = await import(MODEL);
  assert.equal(nextFocusIndex(-1, 4, false), 0);
  assert.equal(nextFocusIndex(-1, 4, true), 3);
});

test("dialog focus: an empty dialog keeps focus where it is", async () => {
  const { nextFocusIndex } = await import(MODEL);
  assert.equal(nextFocusIndex(0, 0, false), -1);
  assert.equal(nextFocusIndex(-1, 0, true), -1);
});

test("dialog focus: Escape closes and Tab is the only trapped key", async () => {
  const { resolveDialogKey } = await import(MODEL);
  assert.equal(resolveDialogKey({ key: "Escape" }), "close");
  assert.equal(resolveDialogKey({ key: "Tab" }), "tab");
  assert.equal(resolveDialogKey({ key: "Tab", shiftKey: true }), "tab");
  assert.equal(resolveDialogKey({ key: "Enter" }), "none");
  assert.equal(resolveDialogKey({ key: "a" }), "none");
});

test("dialog focus: nothing resolves without a DOM and the palette owns no focus state", async () => {
  const { captureReturnFocus, resolveReturnFocus } = await import(MODEL);
  assert.doesNotMatch(read("src/lib/dialogFocus.ts"), /pendingFocus|PENDING_TTL/);
  assert.doesNotMatch(read("src/components/CommandPalette.tsx"), /dialogFocus/);
  assert.equal(captureReturnFocus(null), null);
  assert.equal(resolveReturnFocus(null), null);
  assert.equal(resolveReturnFocus(null, () => null), null);
});

test("dialog focus: the last resort is a deliberate element, not the remembered one", async () => {
  const { defaultReturnFocus } = await import(MODEL);
  const source = read("src/lib/dialogFocus.ts");
  // Exported and callable without a DOM, so the chain always has a defined end.
  assert.equal(typeof defaultReturnFocus, "function");
  assert.equal(defaultReturnFocus(), null);
  // The terminal step is the main region: the memory answers "where did the
  // user come from", never "where should focus land".
  assert.match(source, /return defaultReturnFocus\(\);/);
  assert.match(source, /document\.querySelector<HTMLElement>\("main"\)/);
  assert.doesNotMatch(source, /lastOutsideFocus\)\) return lastOutsideFocus/);
  // The target has to accept focus at all, or the fallback lands on <body>.
  assert.match(read("src/App.tsx"), /<main tabIndex=\{-1\}/, "main must be focusable for the last resort");
});

test("dialog focus: focus is decided once, never observed and corrected", () => {
  const dialog = read("src/components/Dialog.tsx");
  assert.doesNotMatch(dialog, /MutationObserver/, "no observer may move focus after open");
  assert.doesNotMatch(dialog, /setTimeout\(/, "focus must not be deferred and re-decided");
  assert.match(dialog, /returnFocusFallback/, "a vanished trigger needs an explicit landing spot");
});

test("dialog focus: the create dialog's primary control is mounted, labelled and first", () => {
  const source = read("src/components/InstancesView.tsx");
  const labelled = source.indexOf('htmlFor="create-instance-name"');
  const field = source.indexOf('id="create-instance-name"');
  const loading = source.indexOf("loadingVersions ?");
  assert.ok(labelled > 0 && field > 0, "the name field has a real label target");
  assert.ok(labelled < field, "the label precedes its input");
  assert.ok(field < loading, "the field mounts before the version list can gate it");
  assert.ok(source.includes("returnFocusFallback={() => createTriggerRef.current}"), "delete names its fallback");
});

test("dialog props: what the primitive needs, it does not default", () => {
  const dialog = read("src/components/Dialog.tsx");
  assert.doesNotMatch(dialog, /closeLabel\s*=\s*["']/, "every caller names its close button, so no default");
  assert.doesNotMatch(dialog, /tone\s*=\s*["']/, "every caller picks a tone, so no default");
  assert.doesNotMatch(dialog, /neutral/, "no tone branch survives that no caller selects");
  assert.match(dialog, /closeLabel: string;/);
  assert.match(dialog, /tone: "accent" \| "danger" \| "info";/);
  const supplied = CALL_SITES.map((file) => read(file)).join("\n");
  assert.equal((supplied.match(/closeLabel=\{/g) || []).length, 7, "all seven call sites pass closeLabel");
  assert.equal((supplied.match(/tone="/g) || []).length, 7, "all seven call sites pass tone");
  assert.doesNotMatch(supplied, /tone="neutral"/, "no caller selects the removed tone");
});

test("every §3.5 dialog uses the primitive and names its panel", () => {
  for (const file of CALL_SITES) {
    const source = read(file);
    assert.match(source, /<Dialog\b/, `${file} must render the shared Dialog`);
    assert.doesNotMatch(source, /role="dialog"/, `${file} must not hand-roll a dialog panel`);
    assert.equal((source.match(/w-\[480px\]/g) || []).length, 0, `${file} repeats no panel width`);
  }
  for (const [file, titleId] of DIALOGS) {
    assert.ok(read(file).includes(`titleId="${titleId}"`), `${file} must label itself via ${titleId}`);
  }
  const shell = read("src/components/Dialog.tsx");
  for (const invariant of [/h-11/, /h-14/, /w-\[480px\]/, /rounded-2xl/, /role="dialog"/, /aria-modal="true"/, /aria-labelledby=\{titleId\}/, /aria-label=\{closeLabel\}/]) {
    assert.match(shell, invariant);
  }
  // The inert background lock moved to the non-component dialogSupport module.
  assert.match(read("src/components/dialogSupport.ts"), /setAttribute\('inert'/);
});
