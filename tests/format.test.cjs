/** Locale formatting is shared by the counter, dates and playtime. */
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");

const MODEL = pathToFileURL(path.join(__dirname, "..", "src", "lib", "translations.ts")).href;

test("formatNumber follows the active language", async () => {
  const { formatNumber } = await import(MODEL);
  assert.deepEqual(
    [formatNumber(163610, "de"), formatNumber(163610, "en")],
    ["163.610", "163,610"],
  );
});

test("formatCompactNumber abbreviates downloads with one decimal", async () => {
  const { formatCompactNumber } = await import(MODEL);
  assert.deepEqual(
    [
      formatCompactNumber(999, "de"),
      formatCompactNumber(16_700_000, "de"),
      formatCompactNumber(1_250_000, "de"),
      formatCompactNumber(16_700_000, "en"),
    ],
    ["999", "16,7 Mio.", "1,3 Mio.", "16.7M"],
  );
});
