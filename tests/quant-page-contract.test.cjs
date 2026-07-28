const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const apiSource = fs.readFileSync(
  path.join(__dirname, "..", "app", "assets", "js", "api.js"),
  "utf8",
);

test("quant page API contract exports data loading and refresh functions", () => {
  assert.match(apiSource, /export function loadQuantData\s*\(/);
  assert.match(apiSource, /return loadDataModule\("quant",\s*"量化选股"/);
  assert.match(apiSource, /export function requestQuantRefresh\s*\(/);
  assert.match(apiSource, /fetchJson\(`\$\{SERVICE_ORIGIN\}\/quant-refresh`/);
});
