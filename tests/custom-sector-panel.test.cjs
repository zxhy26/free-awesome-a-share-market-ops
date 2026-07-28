const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const indexHtml = read("app", "index.html");
const appSource = read("app", "assets", "js", "app.js");
const workspaceSource = read("app", "assets", "js", "custom-sector-workspace.js");
const chartsSource = read("app", "assets", "js", "charts.js");
const layoutSource = read("app", "assets", "css", "layout.css");
const membershipSource = read("app", "backend", "会员授权服务.js");
const serviceSource = read("app", "backend", "复盘同步服务.js");

test("custom sector workspace sits between index charts and contribution, with structure below contribution", () => {
  const indexPosition = indexHtml.indexOf('class="work-panel index-panel"');
  const customPosition = indexHtml.indexOf('class="work-panel custom-sector-panel"');
  const contributionPosition = indexHtml.indexOf('class="work-panel contribution-panel"');
  const structurePosition = indexHtml.indexOf('class="work-panel structure-panel"');
  assert.ok(indexPosition >= 0 && customPosition > indexPosition);
  assert.ok(contributionPosition > customPosition);
  assert.ok(structurePosition > contributionPosition);
  assert.match(indexHtml, /data-member-feature="自选板块分时"/);
  assert.match(indexHtml, /data-custom-sector-filter="industry"/);
  assert.match(indexHtml, /data-custom-sector-filter="concept"/);
});

test("custom sector workspace persists at most six real industry or concept timelines", () => {
  assert.match(workspaceSource, /MAX_CUSTOM_SECTORS = 6/);
  assert.match(workspaceSource, /a-share-review:custom-sectors:v1/);
  assert.match(workspaceSource, /eastmoney-live-board-ranking/);
  assert.match(workspaceSource, /最多只能添加六个板块/);
  assert.match(layoutSource, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(appSource, /loadBoardMinuteFlow/);
  assert.match(appSource, /customSectorWorkspace\?\.applyLiveSnapshot/);
  assert.match(serviceSource, /\/api\/v1\/sector-flow/);
  assert.match(membershipSource, /\/api\/v1\/sector-flow"\) return "自选板块分时"/);
});

test("index turning-point labels use both industry and concept candidates and persist after confirmation", () => {
  assert.match(appSource, /sectorKind:\s*"industry"/);
  assert.match(appSource, /sectorKind:\s*"concept"/);
  assert.match(chartsSource, /\["industry",\s*"concept"\]/);
  assert.match(chartsSource, /item\.sectorKind === "concept" \? "题" : "行"/);
  assert.match(chartsSource, /GENERIC_CONCEPT_PATTERN/);
  assert.match(chartsSource, /确认后持续保留/);
});
