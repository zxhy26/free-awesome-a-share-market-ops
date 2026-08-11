const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("scheduled backend restores launcher edition identity before binding the port", () => {
  const startup = read("app/backend/启动复盘同步服务.ps1");
  assert.match(startup, /function Import-LauncherEnvironment/);
  assert.match(startup, /\.launcher\.json/);
  assert.match(startup, /A_SHARE_REVIEW_RELEASE_EDITION/);
  assert.ok(
    startup.indexOf("Import-LauncherEnvironment") < startup.indexOf("if (Test-ServicePort)"),
    "launcher metadata must be imported before an existing service is accepted or a new service is started",
  );
});

test("custom Windows host reuses exactly the canonical custom shortline service", () => {
  const outer = read("windows-launcher/single-file-launcher.cs");
  const host = read("windows-launcher/custom-review-host.cs");
  const assembly = read("scripts/assemble-release-payloads.ps1");

  assert.match(outer, /A_SHARE_REVIEW_LAUNCH_PORT", "18765"/);
  assert.match(host, /ExpectedCustomServiceReady/);
  assert.match(host, /releaseEdition\\\":\\\"custom/);
  assert.match(host, /PortAvailable\(port\)/);
  assert.match(host, /A_SHARE_REVIEW_HEADLESS_VERIFY/);
  assert.doesNotMatch(host, /localService\.Kill/);
  assert.match(assembly, /function Build-CustomReviewHost/);
  assert.match(assembly, /Build-CustomReviewHost \$Target/);
});

test("final launcher verification includes the real custom EXE runtime gate", () => {
  const verifier = read("scripts/verify-final-launchers.ps1");
  const runtimeGate = read("scripts/verify-custom-exe-runtime.ps1");
  assert.match(verifier, /verify-custom-exe-runtime\.ps1/);
  assert.match(runtimeGate, /exactly one is required/);
  assert.match(runtimeGate, /DefaultUiPort = 18765/);
  assert.match(runtimeGate, /Assert-WebSocketUpgrade/);
  assert.match(runtimeGate, /releaseEdition -eq "custom"/);
});
