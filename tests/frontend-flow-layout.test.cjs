const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(root, "app", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(root, "app", "assets", "js", "app.js"), "utf8");
const flowChartJs = fs.readFileSync(path.join(root, "app", "assets", "js", "sector-flow-chart.js"), "utf8");
const componentsCss = fs.readFileSync(path.join(root, "app", "assets", "css", "components.css"), "utf8");

test("industry and concept flows use four independent direction panels without toggles", () => {
  assert.equal((indexHtml.match(/class="sector-direction-pair"/g) || []).length, 2);
  assert.equal((indexHtml.match(/flow-direction-panel/g) || []).length, 4);
  [
    "industryInflowChart",
    "industryInflow",
    "industryOutflowChart",
    "industryOutflow",
    "conceptInflowChart",
    "conceptInflow",
    "conceptOutflowChart",
    "conceptOutflow",
  ].forEach((id) => assert.match(indexHtml, new RegExp(`id="${id}"`)));
  assert.doesNotMatch(indexHtml, /flow-direction-key/);
  assert.doesNotMatch(indexHtml, /data-flow-tabs|data-flow-view/);
  assert.doesNotMatch(appJs, /state\.flowView|syncFlowTabs/);
  assert.match(appJs, /renderFlowTable\(groupName, targets\.inflow, "inflow"/);
  assert.match(appJs, /renderFlowTable\(groupName, targets\.outflow, "outflow"/);
  assert.match(appJs, /state\.flowCharts\[groupName\]\.inflow\?\.render/);
  assert.match(appJs, /state\.flowCharts\[groupName\]\.outflow\?\.render/);
  assert.match(appJs, /view:\s*"inflow"/);
  assert.match(appJs, /view:\s*"outflow"/);
});

test("sector flow chart uses a signed dual-direction scale and percentage label", () => {
  assert.match(flowChartJs, /\["relative", "百分比"\]/);
  assert.doesNotMatch(flowChartJs, /\["relative", "相对"\]/);
  assert.match(flowChartJs, /view === "both" \? range \* \(1 - ratio \* 2\)/);
  assert.match(flowChartJs, /view === "outflow" \? -magnitude : magnitude/);
  assert.match(flowChartJs, /chooseDirectionRows\(group, "inflow", minute\)/);
  assert.match(flowChartJs, /chooseDirectionRows\(group, "outflow", minute\)/);
});

test("ranking outflow bars stay green and grow linearly from left to right", () => {
  assert.match(
    componentsCss,
    /\.flow-bar\s*\{[^}]*margin-left:\s*0;[^}]*transform-origin:\s*left center;[^}]*transition:\s*width 90ms linear;/s,
  );
  assert.match(
    componentsCss,
    /\.flow-row\.outflow \.flow-bar\s*\{[^}]*margin-left:\s*0;[^}]*background:\s*var\(--loss\);/s,
  );
  assert.doesNotMatch(
    componentsCss,
    /\.flow-row\.outflow \.flow-bar\s*\{[^}]*margin-left:\s*auto;/s,
  );
});
