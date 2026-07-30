const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  compareVersions,
  createAppUpdateService,
  createInstallerScript,
  normalizeVersion,
  validateManifest,
} = require("../app/backend/app-update");

function validManifest(overrides = {}) {
  return validateManifest({
    schemaVersion: 1,
    product: "大a后勤部",
    edition: "member",
    version: "2.18.1",
    publishedAt: "2026-07-30T03:00:00.000Z",
    downloadUrl: "https://github.com/zxhy26/free-awesome-a-share-market-ops/releases/download/v2.18.1/Da-A-Hou-Qin-Bu-v2.18.1.exe",
    sha256: "A".repeat(64),
    size: 2 * 1024 * 1024,
    notes: ["测试更新"],
    ...overrides,
  });
}

test("version comparison handles normal and v-prefixed semantic versions", () => {
  assert.equal(normalizeVersion("v2.18.0"), "2.18.0");
  assert.equal(compareVersions("2.18.1", "2.18.0"), 1);
  assert.equal(compareVersions("2.18.0", "2.18.0.0"), 0);
  assert.equal(compareVersions("2.17.10", "2.18.0"), -1);
});

test("manifest accepts only the member GitHub HTTPS update channel", () => {
  assert.equal(validManifest().version, "2.18.1");
  assert.throws(() => validManifest({downloadUrl: "http://github.com/file.exe"}), /GitHub HTTPS/);
  assert.throws(() => validManifest({downloadUrl: "https://example.com/file.exe"}), /GitHub HTTPS/);
  assert.throws(() => validManifest({sha256: "1234"}), /SHA-256/);
});

test("member updater reports an available GitHub version from launcher metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a-share-update-status-"));
  try {
    const appDir = path.join(root, "程序", "应用");
    fs.mkdirSync(appDir, {recursive: true});
    const launcherPath = path.join(root, "大a后勤部.exe");
    fs.writeFileSync(launcherPath, "old");
    fs.writeFileSync(path.join(root, ".launcher.json"), JSON.stringify({
      version: "2.18.0",
      launcherPath,
      appPid: 0,
    }));
    const service = createAppUpdateService({
      edition: "member",
      appDir,
      runtimeRoot: root,
      fetchManifest: async () => validManifest(),
      disableExit: true,
    });
    const status = await service.checkForUpdates({force: true});
    assert.equal(status.supported, true);
    assert.equal(status.launcherReady, true);
    assert.equal(status.currentVersion, "2.18.0");
    assert.equal(status.latestVersion, "2.18.1");
    assert.equal(status.updateAvailable, true);
    assert.equal(status.phase, "available");
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("downloaded executable is size and hash checked before the hidden installer starts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a-share-update-install-"));
  try {
    const appDir = path.join(root, "程序", "应用");
    const workDir = path.join(appDir, "backend");
    fs.mkdirSync(workDir, {recursive: true});
    fs.writeFileSync(path.join(workDir, "静默运行PowerShell.vbs"), "WScript.Quit 0");
    const launcherPath = path.join(root, "大a后勤部.exe");
    fs.writeFileSync(launcherPath, "old");
    fs.writeFileSync(path.join(root, ".launcher.json"), JSON.stringify({
      version: "2.18.0",
      launcherPath,
      appPid: 0,
    }));
    const executable = Buffer.alloc(1024 * 1024 + 16, 0);
    executable.write("MZ", 0, "ascii");
    const hash = crypto.createHash("sha256").update(executable).digest("hex").toUpperCase();
    const manifest = validManifest({size: executable.length, sha256: hash});
    const spawns = [];
    const service = createAppUpdateService({
      edition: "member",
      appDir,
      runtimeRoot: root,
      workDir,
      fetchManifest: async () => manifest,
      downloadFile: async (_url, targetPath, options) => {
        fs.mkdirSync(path.dirname(targetPath), {recursive: true});
        fs.writeFileSync(targetPath, executable);
        options.onProgress(executable.length, executable.length);
        return {bytes: executable.length, path: targetPath};
      },
      spawn(command, args, options) {
        spawns.push({command, args, options});
        return {unref() {}};
      },
      disableExit: true,
    });
    await service.checkForUpdates({force: true});
    const accepted = service.startInstall();
    assert.equal(accepted.accepted, true);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && service.getStatus().phase !== "restarting") {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const status = service.getStatus();
    assert.equal(status.phase, "restarting");
    assert.equal(status.progress, 100);
    assert.equal(spawns.length, 1);
    assert.match(spawns[0].command, /wscript\.exe$/i);
    assert.equal(spawns[0].options.windowsHide, true);
    const scriptPath = spawns[0].args[1];
    const script = fs.readFileSync(scriptPath, "utf8");
    assert.match(script, /Get-FileHash/);
    assert.match(script, /127\.0\.0\.1:18765\/api\/v1\/app-update\/status/);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("installer script encodes paths instead of interpolating executable input", () => {
  const script = createInstallerScript({
    launcherPath: "D:\\发送目录\\大a后勤部.exe",
    stagedPath: "C:\\缓存\\新版.exe",
    runtimeRoot: "C:\\运行目录",
    logPath: "C:\\日志\\更新.txt",
    version: "2.18.1",
    sha256: "A".repeat(64),
    servicePid: 123,
    appPid: 456,
  });
  assert.doesNotMatch(script, /发送目录|大a后勤部/);
  assert.match(script, /FromBase64String/);
  assert.match(script, /\$servicePid = 123/);
});
