/**
 * The launcher font is a stored preference: normal is the guaranteed default,
 * a saved "minecraft" choice must survive, and anything unreadable or unknown
 * must never leave the launcher in a broken state.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");

const ROOT = path.join(__dirname, "..");
const MODEL = pathToFileURL(path.join(ROOT, "src", "lib", "launcherFont.ts")).href;

test("launcher font: normal is the default for empty and unknown values", async () => {
  const { DEFAULT_LAUNCHER_FONT, normalizeLauncherFont } = await import(MODEL);

  assert.equal(DEFAULT_LAUNCHER_FONT, "normal");
  assert.equal(normalizeLauncherFont(undefined), "normal");
  assert.equal(normalizeLauncherFont(null), "normal");
  assert.equal(normalizeLauncherFont(""), "normal");
  assert.equal(normalizeLauncherFont("comic-sans"), "normal");
  // Stored values are lowercase; a differently cased value is unknown.
  assert.equal(normalizeLauncherFont("Minecraft"), "normal");
});

test("launcher font: a saved minecraft choice wins", async () => {
  const { LAUNCHER_FONT_STORAGE_KEY, readLauncherFont } = await import(MODEL);

  const storage = {
    getItem: (key) => (key === LAUNCHER_FONT_STORAGE_KEY ? "minecraft" : null),
  };

  assert.equal(readLauncherFont(storage), "minecraft");
});

test("launcher font: an unknown saved value falls back to normal", async () => {
  const { readLauncherFont } = await import(MODEL);

  assert.equal(readLauncherFont({ getItem: () => "serif" }), "normal");
  assert.equal(readLauncherFont({ getItem: () => null }), "normal");
});

test("launcher font: storage failures do not break the default", async () => {
  const { readLauncherFont } = await import(MODEL);

  assert.equal(
    readLauncherFont({
      getItem: () => {
        throw new Error("storage blocked");
      },
    }),
    "normal",
  );
});

test("launcher font: choosing minecraft writes the stored value", async () => {
  const { LAUNCHER_FONT_STORAGE_KEY, saveLauncherFont } = await import(MODEL);
  const writes = [];

  saveLauncherFont("minecraft", {
    getItem: () => null,
    setItem: (key, value) => writes.push([key, value]),
  });

  assert.deepEqual(writes, [[LAUNCHER_FONT_STORAGE_KEY, "minecraft"]]);
});

test("launcher font: applying without a document is a safe no-op", async () => {
  const { applyLauncherFont } = await import(MODEL);

  assert.doesNotThrow(() => applyLauncherFont("minecraft"));
});

test("launcher font: the minecraft option ships its own Monocraft face", () => {
  const fontFile = path.join(ROOT, "src", "assets", "fonts", "Monocraft.ttf");
  const css = fs.readFileSync(path.join(ROOT, "src", "index.css"), "utf8");

  assert.ok(fs.statSync(fontFile).size > 100_000, "the bundled font must be a real file");
  assert.ok(fs.existsSync(path.join(ROOT, "public", "fonts", "Monocraft-OFL.txt")));
  assert.match(css, /@font-face\s*\{[^}]*font-family:\s*"Monocraft"[^}]*Monocraft\.ttf/s);
  assert.match(css, /--font-pixel:\s*"Monocraft"/);
});
