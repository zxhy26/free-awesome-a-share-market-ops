const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("every built-in independent page loads the shared display preference synchronizer", () => {
  const pagesRoot = path.join(root, "app", "pages");
  const pages = fs.readdirSync(pagesRoot).filter((name) => name.endsWith(".html"));
  assert.ok(pages.length >= 11);
  for (const page of pages) {
    assert.match(read("app", "pages", page), /display-page-sync\.js/, page);
  }

  const index = read("app", "index.html");
  const topPageLinks = [...index.matchAll(/href="\/app\/pages\/([^"]+\.html)"/g)].map((match) => match[1]);
  assert.ok(topPageLinks.length >= 6);
  for (const page of topPageLinks) {
    assert.ok(pages.includes(page), `首页按钮目标缺少页面：${page}`);
  }
});

test("page display synchronizer reuses main settings and reacts across browsing contexts", () => {
  const display = read("app", "assets", "js", "display-settings.js");
  const pageSync = read("app", "assets", "js", "display-page-sync.js");
  const worker = read("app", "sw.js");
  assert.match(display, /a-share-review:page-zoom:v1/);
  assert.match(display, /a-share-review:font-size:v1/);
  assert.match(display, /a-share-review:display-preferences:v1/);
  assert.match(display, /BroadcastChannel/);
  assert.match(display, /addEventListener\("storage"/);
  assert.match(display, /viewport\.style\.zoom/);
  assert.match(display, /--app-font-unit/);
  assert.match(pageSync, /createPageDisplaySync\(\)/);
  assert.match(worker, /display-page-sync\.js/);
  assert.match(worker, /a-share-review-v96-market-sync-reliability/);
});

test("independent-page styles scale through the global font unit", () => {
  const cssRoot = path.join(root, "app", "assets", "css");
  for (const file of fs.readdirSync(cssRoot).filter((name) => name.endsWith(".css"))) {
    const source = fs.readFileSync(path.join(cssRoot, file), "utf8");
    assert.doesNotMatch(source, /font-size:\s*\d+(?:\.\d+)?px/, `${file} 仍有固定字号`);
    assert.doesNotMatch(source, /font:\s*[^;{}]*\d+(?:\.\d+)?px/, `${file} 的 font 简写仍有固定字号`);
  }
});

test("edition packaging injects display sync into retained quant and administration pages", () => {
  const patcher = read("scripts", "apply-display-index-to-extracted-editions.mjs");
  assert.match(patcher, /function ensureDisplaySyncScript/);
  assert.match(patcher, /patchEditionPages\(path\.join\(targetApp, "pages"\)\)/);
  assert.match(patcher, /patchFixedFontSizes\(path\.join\(targetApp, "assets", "css"\)\)/);
});
