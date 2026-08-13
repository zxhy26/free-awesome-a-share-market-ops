const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const indexHtml = read("app", "index.html");
const appSource = read("app", "assets", "js", "app.js");
const workspaceSource = read("app", "assets", "js", "custom-sector-workspace.js");
const turningSource = read("app", "assets", "js", "concept-turning-annotations.js");
const chartsSource = read("app", "assets", "js", "charts.js");
const clsInjectionSource = read("scripts", "inject-cls-index-annotations.mjs");
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

test("custom sector workspace persists at most six real industry or concept index timelines", () => {
  assert.match(workspaceSource, /MAX_CUSTOM_SECTORS = 6/);
  assert.match(workspaceSource, /a-share-review:custom-sectors:v1/);
  assert.match(workspaceSource, /eastmoney-live-board-quote/);
  assert.match(workspaceSource, /changePct/);
  assert.match(workspaceSource, /最多只能添加六个板块/);
  assert.match(layoutSource, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(appSource, /loadBoardIntradayTrend/);
  assert.match(appSource, /customSectorWorkspace\?\.applyLiveSnapshot/);
  assert.match(serviceSource, /\/api\/v1\/sector-trend/);
  assert.match(serviceSource, /isPublicIndexAttributionProbe/);
  assert.match(serviceSource, /url\.searchParams\.get\("mode"\) === "attribution-minute"/);
  assert.match(membershipSource, /\/api\/v1\/sector-trend/);
});

test("main index labels directly use original CLS watch plate events", () => {
  assert.match(indexHtml, /财联社盯盘原始板块事件/);
  assert.match(appSource, /state\.data\.indices\?\.annotations/);
  assert.match(appSource, /buildClsIndexAnnotationEvents\(index, indexAnnotationFeed\(\)\)/);
  assert.match(appSource, /snapshot\.clsWatch/);
  assert.doesNotMatch(appSource, /buildConceptTurningAnnotations|loadBoardAttributionTrend|indexAttribution\.priceSeries/);
  assert.match(chartsSource, /annotationEventsForIndex/);
  assert.match(chartsSource, /item\.displayLabel \|\| item\.label/);
  assert.match(chartsSource, /buildClsIndexAnnotationEvents\(index, annotationFeed\)/);
  assert.match(chartsSource, /sourceType === "plate"/);
  assert.match(chartsSource, /stock_detail/);
  assert.match(chartsSource, /sourceMode:\s*"direct-cls-watch"/);
  assert.match(chartsSource, /来源：财联社盯盘/);
  assert.match(chartsSource, /item\?\.resolved !== false/);
  assert.match(clsInjectionSource, /排除所有个股事件/);
  assert.match(clsInjectionSource, /财联社盯盘/);
  const createIndexChartsSource = chartsSource.slice(chartsSource.indexOf("export function createIndexCharts"));
  assert.doesNotMatch(createIndexChartsSource, /buildSectorAttributionCandidates|buildPersistentSectorAttributions/);
});

test("custom sector turns keep persistent labels from real concept-board flow only", () => {
  assert.match(workspaceSource, /concept-turning-annotations\.js/);
  assert.match(workspaceSource, /class="custom-sector-annotations"/);
  assert.match(workspaceSource, /conceptSeries:\s*new Map\(\)/);
  assert.match(workspaceSource, /selectVisibleConceptAnnotations/);
  assert.match(workspaceSource, /selectSignificantConceptAnnotations/);
  assert.match(appSource, /loadBoardMinuteFlow/);
  assert.match(workspaceSource, /loadFlowTimeline/);
  assert.match(workspaceSource, /selectConceptHistoryCandidates/);
  assert.match(workspaceSource, /MAX_CONCEPT_HISTORY_CONCURRENCY\s*=\s*6/);
  assert.match(workspaceSource, /result\.tradeDate\s*!==\s*task\.tradeDate/);
  assert.match(appSource, /tradeDate:\s*state\.data\.sectors\?\.tradeDate/);
  assert.match(workspaceSource, /groups\?\.tradeDate\s*\|\|\s*groups\?\.industry\?\.tradeDate/);
  assert.match(workspaceSource, /tradeDate:\s*snapshot\.tradeDate\s*\|\|\s*state\.tradeDate/);
  assert.match(turningSource, /buildIndexTurningPoints/);
  assert.match(turningSource, /group === "concept"/);
  assert.match(turningSource, /GENERIC_CONCEPT_PATTERN/);
  assert.match(turningSource, /end\.minute > start\.minute/);
  assert.match(turningSource, /不使用个股、收盘倒推或未来样本/);
});

test("desktop index layout supports automatic one-row and two-row grids while the flow column fills its stack", () => {
  assert.match(layoutSource, /data-index-columns="2"[^\n]+repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(layoutSource, /data-index-columns="3"[^\n]+repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(layoutSource, /data-index-columns="4"[^\n]+repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(layoutSource, /data-index-rows="1"[\s\S]*grid-template-rows:\s*minmax\(216px,\s*1fr\)/);
  assert.match(layoutSource, /data-index-rows="2"[\s\S]*repeat\(2,\s*minmax\(216px,\s*1fr\)\)/);
  assert.match(layoutSource, /\.sector-stack[\s\S]*height:\s*100%/);
  assert.match(layoutSource, /\.sector-stack[\s\S]*contain:\s*size/);
});
