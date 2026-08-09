const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createMembershipService } = require("../app/backend/会员授权服务");

function read(...parts) {
  return fs.readFileSync(path.join(__dirname, "..", ...parts), "utf8");
}

test("index contribution is membership-only while market summary remains free", () => {
  const indexHtml = read("app", "index.html");
  const summaryTag = indexHtml.match(/<button[^>]*id="summaryButton"[^>]*>/)?.[0] || "";
  const contributionTag = indexHtml.match(/<section[^>]*class="work-panel contribution-panel"[^>]*>/)?.[0] || "";

  assert.ok(summaryTag);
  assert.doesNotMatch(summaryTag, /data-member-feature/);
  assert.match(contributionTag, /data-member-feature="指数贡献"/);
});

test("index contribution data routes require membership access", () => {
  const service = createMembershipService({
    edition: "member",
    appDir: path.join(__dirname, "..", "app"),
    dataDir: path.join(__dirname, "..", "app", "data"),
    keyDir: path.join(__dirname, "..", "app", "backend"),
  });

  assert.equal(service.protectedFeatureForPath("/app/data/index-contribution.json"), "指数贡献");
  assert.equal(service.protectedFeatureForApi("/api/v1/data/index-contribution", "GET"), "指数贡献");
  assert.equal(service.protectedFeatureForApi("/api/v1/index-contribution/refresh", "POST"), "指数贡献");
});

test("theme treasure is membership-only in the member edition", () => {
  const indexHtml = read("app", "index.html");
  const service = createMembershipService({
    edition: "member",
    appDir: path.join(__dirname, "..", "app"),
    dataDir: path.join(__dirname, "..", "app", "data"),
    keyDir: path.join(__dirname, "..", "app", "backend"),
  });

  assert.match(indexHtml, /href="\/app\/pages\/theme-treasure\.html"[^>]*data-member-feature="题材宝典"/);
  assert.equal(service.protectedFeatureForPath("/app/pages/theme-treasure.html"), "题材宝典");
  assert.equal(service.protectedFeatureForPath("/app/data/theme-treasure.json"), "题材宝典");
  assert.equal(service.protectedFeatureForApi("/api/v1/theme-treasure", "GET"), "题材宝典");
  assert.equal(service.protectedFeatureForApi("/api/v1/theme-treasure/detail", "GET"), "题材宝典");
  assert.equal(service.protectedFeatureForApi("/api/v1/theme-treasure/refresh", "POST"), "题材宝典更新");
});

test("core dashboard loads without protected contribution data", () => {
  const apiSource = read("app", "assets", "js", "api.js");
  const appSource = read("app", "assets", "js", "app.js");
  const serviceWorker = read("app", "sw.js");
  const componentsCss = read("app", "assets", "css", "components.css");
  const coreLoader = apiSource.match(/export async function loadCoreData\(\)[\s\S]*?\n}\n\nfunction latestAshareMinute/)?.[0] || "";

  assert.ok(coreLoader);
  assert.doesNotMatch(coreLoader, /"indexContribution"/);
  assert.match(apiSource, /export async function loadIndexContributionData\(\)/);
  assert.match(apiSource, /allowSnapshot:\s*false/);
  assert.match(appSource, /a-share-membership-change/);
  assert.match(serviceWorker, /"\/app\/data\/index-contribution\.json"/);
  assert.match(componentsCss, /\.contribution-panel\.member-locked::after/);
});
