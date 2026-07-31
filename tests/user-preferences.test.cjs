const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createUserPreferencesStore,
  normalizeUserPreferences,
} = require("../app/backend/用户设置");

test("user preferences validate indices, sectors, zoom and font size", () => {
  const preferences = normalizeUserPreferences({
    selectedIndices: ["sh000001", "bad", "sz399001", "sh000001"],
    selectedSectors: [
      {code: "bk0475", name: "银行Ⅱ", group: "industry"},
      {code: "stock", name: "个股", group: "concept"},
    ],
    zoom: 127,
    fontSize: "large",
  });
  assert.deepEqual(preferences.selectedIndices, ["sh000001", "sz399001"]);
  assert.deepEqual(preferences.selectedSectors, [{code: "BK0475", name: "银行Ⅱ", group: "industry"}]);
  assert.equal(preferences.zoom, 125);
  assert.equal(preferences.fontSize, "large");
});

test("desktop preference file survives reload and preserves partial updates", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(process.cwd(), ".tmp-user-preferences-"));
  try {
    const filePath = path.join(temporaryRoot, "用户设置.json");
    const store = createUserPreferencesStore({
      filePath,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    assert.equal(store.read().found, false);
    store.save({settings: {
      selectedIndices: ["sh000001", "sz399006"],
      selectedSectors: [{code: "BK0475", name: "银行Ⅱ", group: "industry"}],
      zoom: 110,
      fontSize: "xlarge",
    }});
    const reloaded = createUserPreferencesStore({filePath}).read();
    assert.equal(reloaded.found, true);
    assert.deepEqual(reloaded.settings.selectedIndices, ["sh000001", "sz399006"]);
    assert.deepEqual(reloaded.settings.selectedSectors, [{code: "BK0475", name: "银行Ⅱ", group: "industry"}]);
    assert.equal(reloaded.settings.zoom, 110);
    assert.equal(reloaded.settings.fontSize, "xlarge");

    store.save({settings: {zoom: 90}});
    const updated = store.read().settings;
    assert.equal(updated.zoom, 90);
    assert.equal(updated.fontSize, "xlarge");
    assert.deepEqual(updated.selectedIndices, ["sh000001", "sz399006"]);
  } finally {
    fs.rmSync(temporaryRoot, {recursive: true, force: true});
  }
});

test("frontend hydrates and flushes tracked settings through the local service", () => {
  const client = fs.readFileSync(path.join(process.cwd(), "app", "assets", "js", "persistent-settings.js"), "utf8");
  const app = fs.readFileSync(path.join(process.cwd(), "app", "assets", "js", "app.js"), "utf8");
  const service = fs.readFileSync(path.join(process.cwd(), "app", "backend", "复盘同步服务.js"), "utf8");
  const launcher = fs.readFileSync(path.join(process.cwd(), "windows-launcher", "single-file-launcher.cs"), "utf8");
  assert.match(client, /a-share-review:selected-indices:v1/);
  assert.match(client, /a-share-review:custom-sectors:v1/);
  assert.match(client, /a-share-review:page-zoom:v1/);
  assert.match(client, /a-share-review:font-size:v1/);
  assert.match(client, /\/api\/v1\/preferences/);
  assert.match(client, /sendBeacon/);
  assert.match(app, /createPersistentSettingsStorage/);
  assert.match(app, /pagehide[\s\S]*flush\(\{beacon: true/);
  assert.match(service, /createUserPreferencesService/);
  assert.match(service, /await userPreferences\.handleRequest/);
  assert.match(launcher, /MergePreservedDirectory\(preservedRoot, temporaryRoot, "\\u6570\\u636e\\u5386\\u53f2"\)/);
});
