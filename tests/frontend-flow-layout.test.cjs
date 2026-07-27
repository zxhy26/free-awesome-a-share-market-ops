const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const indexHtml = fs.readFileSync(path.join(root, "app", "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(root, "app", "assets", "js", "app.js"), "utf8");
const flowChartJs = fs.readFileSync(path.join(root, "app", "assets", "js", "sector-flow-chart.js"), "utf8");

test("industry and concept flows render inflow and outflow without direction toggles", () => {
  assert.equal((indexHtml.match(/class="flow-direction-key"/g) || []).length, 2);
  assert.doesNotMatch(indexHtml, /data-flow-tabs|data-flow-view/);
  assert.doesNotMatch(appJs, /state\.flowView|syncFlowTabs/);
  assert.match(appJs, /renderFlowSection\(groupName, target, "inflow"/);
  assert.match(appJs, /renderFlowSection\(groupName, target, "outflow"/);
  assert.match(appJs, /view:\s*"both"/);
});

test("sector flow chart uses a signed dual-direction scale and percentage label", () => {
  assert.match(flowChartJs, /\["relative", "百分比"\]/);
  assert.doesNotMatch(flowChartJs, /\["relative", "相对"\]/);
  assert.match(flowChartJs, /view === "both" \? range \* \(1 - ratio \* 2\)/);
  assert.match(flowChartJs, /chooseDirectionRows\(group, "inflow", minute\)/);
  assert.match(flowChartJs, /chooseDirectionRows\(group, "outflow", minute\)/);
});
