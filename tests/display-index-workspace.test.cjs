const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const html = read("app", "index.html");
const app = read("app", "assets", "js", "app.js");
const charts = read("app", "assets", "js", "charts.js");
const workspace = read("app", "assets", "js", "index-workspace.js");
const display = read("app", "assets", "js", "display-settings.js");
const layout = read("app", "assets", "css", "layout.css");
const components = read("app", "assets", "css", "components.css");
const responsive = read("app", "assets", "css", "responsive.css");
const service = read("app", "backend", "复盘同步服务.js");
const serviceWorker = read("app", "sw.js");

test("main index workspace is user-selectable, persistent, and capped at eight", () => {
  assert.match(html, /id="indexAdd"/);
  assert.match(html, /id="indexPicker"/);
  assert.match(html, /id="indexSearch"/);
  assert.match(html, /id="indexOptions"/);
  assert.match(html, /id="indexCount">8\/8/);
  assert.match(workspace, /MAX_SELECTED_INDICES = 8/);
  assert.match(workspace, /MIN_SELECTED_INDICES = 1/);
  assert.match(workspace, /a-share-review:selected-indices:v1/);
  assert.match(workspace, /最多添加八个/);
  assert.match(app, /loadIndexCatalog/);
  assert.match(app, /loadIndexTrend/);
  assert.match(app, /createIndexWorkspace/);
  assert.match(charts, /options\.onRemove\?\.\(index\.key \|\| index\.code\)/);
});

test("index workspace automatically maps one through eight selections to balanced grids", () => {
  assert.match(workspace, /normalized === 1[^\n]+columns:\s*1,\s*rows:\s*1/);
  assert.match(workspace, /normalized === 2[^\n]+columns:\s*2,\s*rows:\s*1/);
  assert.match(workspace, /normalized === 3[^\n]+columns:\s*3,\s*rows:\s*1/);
  assert.match(workspace, /normalized === 4[^\n]+columns:\s*2,\s*rows:\s*2/);
  assert.match(workspace, /normalized <= 6[^\n]+columns:\s*3,\s*rows:\s*2/);
  assert.match(workspace, /columns:\s*4,\s*rows:\s*2/);
  assert.match(app, /dataset\.indexCount = String\(layout\.count\)/);
  assert.match(app, /dataset\.indexColumns = String\(layout\.columns\)/);
  assert.match(app, /dataset\.indexRows = String\(layout\.rows\)/);
  assert.match(layout, /data-index-columns="2"[^\n]+repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(layout, /data-index-columns="3"[^\n]+repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(layout, /data-index-columns="4"[^\n]+repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(responsive, /data-index-columns[\s\S]*grid-auto-rows:\s*216px/);
  assert.match(responsive, /\.index-options/);
});

test("Word-style display controls persist 70-130 percent zoom and four global font sizes", () => {
  assert.match(html, /id="zoomRange"[^>]+min="70"[^>]+max="130"[^>]+step="5"/);
  assert.match(html, /id="fontSizeButton"/);
  assert.equal((html.match(/data-font-size=/g) || []).length, 4);
  assert.match(display, /MIN_ZOOM = 70/);
  assert.match(display, /MAX_ZOOM = 130/);
  assert.match(display, /ZOOM_STEP = 5/);
  assert.match(display, /a-share-review:page-zoom:v1/);
  assert.match(display, /a-share-review:font-size:v1/);
  assert.match(display, /--app-font-unit/);
  assert.match(components, /\.zoom-control/);
  assert.match(components, /font-size:\s*calc\(\d+\s*\*\s*var\(--app-font-unit\)\)/);
});

test("index APIs and new modules are available offline without membership gating", () => {
  assert.match(service, /\/api\/v1\/index-catalog/);
  assert.match(service, /\/api\/v1\/index-trend/);
  const membershipIndex = service.indexOf("if (await membership.handleRequest");
  const catalogIndex = service.indexOf('url.pathname === "/api/v1/index-catalog"');
  assert.ok(catalogIndex > membershipIndex);
  assert.match(serviceWorker, /display-settings\.js/);
  assert.match(serviceWorker, /index-workspace\.js/);
  assert.match(serviceWorker, /persistent-settings\.js/);
  assert.match(serviceWorker, /a-share-review-v101-cls-watch-direct/);
});
