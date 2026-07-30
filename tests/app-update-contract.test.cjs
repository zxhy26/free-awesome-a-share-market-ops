const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("member desktop page exposes a non-membership GitHub update button", () => {
  const html = read("app/index.html");
  assert.match(html, /id="appUpdateButton"/);
  assert.match(html, /id="appUpdateButtonLabel">检查更新/);
  assert.match(html, /id="appVersion">版本 --/);
  const button = html.match(/<button[^>]+id="appUpdateButton"[\s\S]*?<\/button>/)?.[0] || "";
  assert.doesNotMatch(button, /data-member-feature/);
});

test("frontend checks, installs, and polls GitHub updates inside the app", () => {
  const api = read("app/assets/js/api.js");
  const app = read("app/assets/js/app.js");
  assert.match(api, /\/api\/v1\/app-update\/check/);
  assert.match(api, /\/api\/v1\/app-update\/install/);
  assert.match(app, /checkSoftwareUpdate/);
  assert.match(app, /handleAppUpdate/);
  assert.match(app, /更新至 \$\{status\.latestVersion\}/);
  assert.match(app, /30 \* 60 \* 1000/);
});

test("local service publishes the complete update API without membership protection", () => {
  const service = read("app/backend/复盘同步服务.js");
  assert.match(service, /\/api\/v1\/app-update\/status/);
  assert.match(service, /\/api\/v1\/app-update\/check/);
  assert.match(service, /\/api\/v1\/app-update\/install/);
  const membershipIndex = service.indexOf("if (await membership.handleRequest");
  const routeIndex = service.indexOf('url.pathname === "/api/v1/app-update/status"');
  assert.ok(routeIndex > membershipIndex);
  assert.doesNotMatch(service.slice(membershipIndex, routeIndex), /app-update.*protectedApiFeature/);
});
