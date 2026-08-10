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
  assert.match(service, /appUpdate\.scheduleLauncherCleanup\(\)/);
});

test("desktop launcher metadata carries canonical edition cleanup identity", () => {
  const launcher = read("windows-launcher/single-file-launcher.cs");
  assert.match(launcher, /A_SHARE_REVIEW_RELEASE_EDITION/);
  assert.match(launcher, /canonicalLauncherName/);
  assert.match(launcher, /CanonicalLauncherName = "大a后勤部\.exe"/);
  assert.match(launcher, /CanonicalLauncherName = "复盘软件基础版\.exe"/);
  assert.match(launcher, /CanonicalLauncherName = "复盘软件自用版\.exe"/);
  assert.match(launcher, /CanonicalLauncherName = "复盘软件定制版-短线模型V1\.0\.exe"/);
  assert.match(launcher, /CUSTOM_EDITION[\s\S]*updates\/custom\.json/u);
  assert.match(launcher, /BASIC_EDITION[\s\S]*updates\/basic\.json/u);
  assert.match(launcher, /A_SHARE_REVIEW_UPDATE_MANIFEST_URL/u);
});

test("update service enables member, basic and custom channels but keeps their manifests isolated", () => {
  const updater = read("app/backend/app-update.js");
  assert.match(updater, /UPDATE_RELEASE_EDITIONS = new Set\(\["member", "basic", "custom"\]\)/u);
  assert.match(updater, /BASIC_MANIFEST_URL[\s\S]*updates\/basic\.json/u);
  assert.match(updater, /CUSTOM_MANIFEST_URL[\s\S]*updates\/custom\.json/u);
  assert.match(updater, /validateManifest\(fetchedManifest, profile\.edition\)/u);
  assert.match(updater, /metadata\.manifestUrl/u);
  assert.match(updater, /currentManifestUrl\(profile\)/u);
});
