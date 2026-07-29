const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = path.join(root, "app");
const read = (relativePath) => fs.readFileSync(path.join(app, relativePath), "utf8");

test("all quote actions use the in-app market detail page", () => {
  const api = read(path.join("assets", "js", "api.js"));
  assert.match(api, /pages\/market-detail\.html/);
  assert.match(api, /mode:\s*"internalMarketDetail"/);
  assert.match(api, /export async function openLocalStock\(stock\)\s*\{\s*return openExactQuote\(stock\);/s);
  assert.doesNotMatch(api, /quote\.eastmoney\.com|so\.eastmoney\.com|\/stock-open/);
});

test("external content links are intercepted and rendered inside the app", () => {
  const navigation = read(path.join("assets", "js", "internal-navigation.js"));
  assert.match(navigation, /pages\/content-detail\.html/);
  assert.match(navigation, /MutationObserver/);
  assert.match(navigation, /location\.assign\(url\)/);
  assert.match(navigation, /sourceUrl:/);
});

test("internal detail assets are shipped and cached", () => {
  const required = [
    path.join("pages", "market-detail.html"),
    path.join("pages", "content-detail.html"),
    path.join("assets", "css", "internal-detail.css"),
    path.join("assets", "js", "internal-navigation.js"),
    path.join("assets", "js", "mobile-live.js"),
    path.join("assets", "js", "internal-market-detail.js"),
    path.join("assets", "js", "internal-content-detail.js"),
  ];
  required.forEach((relativePath) => {
    assert.equal(fs.existsSync(path.join(app, relativePath)), true, `${relativePath} should exist`);
  });
  const serviceWorker = read("sw.js");
  required.forEach((relativePath) => {
    const url = `/app/${relativePath.replaceAll(path.sep, "/")}`;
    assert.match(serviceWorker, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("frontend navigation source contains no Eastmoney webpage destinations", () => {
  const roots = [
    path.join(app, "assets", "js"),
    path.join(app, "pages"),
  ];
  const files = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, {withFileTypes: true})) {
      const absolute = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (/\.(?:js|html)$/i.test(entry.name)) files.push(absolute);
    }
  };
  roots.forEach(walk);
  const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(source, /https?:\/\/(?:quote|so)\.eastmoney\.com/i);
});
