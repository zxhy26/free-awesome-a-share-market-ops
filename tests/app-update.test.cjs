const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  cleanupLauncherArtifacts,
  compareVersions,
  createAppUpdateService,
  createInstallerScript,
  normalizeVersion,
  readPortableExecutableVersion,
  releaseProfile,
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

test("portable executable version reader finds the version resource near the file tail", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "a-share-pe-version-"));
  const executablePath = path.join(directory, "launcher.exe");
  const body = Buffer.alloc(5 * 1024 * 1024, 0x41);
  const marker = Buffer.from("FileVersion\0\0 2.20.1.0\0", "utf16le");
  marker.copy(body, body.length - marker.length - 64);
  fs.writeFileSync(executablePath, body);
  try {
    assert.equal(readPortableExecutableVersion(executablePath), "2.20.1");
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
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
    assert.match(script, /Remove-OldLauncherArtifacts/);
    assert.match(script, /Installed update hash mismatch/);
    assert.doesNotMatch(script, /127\.0\.0\.1:18765\/api\/v1\/app-update\/status/);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("launcher cleanup migrates a legacy alias and removes only same-edition artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a-share-update-cleanup-"));
  try {
    const legacyPath = path.join(root, "大a后勤部-暗盘资金版.exe");
    const legacyBackup = `${legacyPath}.previous.exe`;
    const releaseDownload = path.join(root, "Da-A-Hou-Qin-Bu-v2.20.0.exe");
    const canonicalPath = path.join(root, "大a后勤部.exe");
    const unrelatedPath = path.join(root, "复盘软件基础版.exe");
    const metadataPath = path.join(root, ".launcher.json");
    fs.writeFileSync(legacyPath, "latest-member-launcher");
    fs.writeFileSync(legacyBackup, "old-member-launcher");
    fs.writeFileSync(releaseDownload, "downloaded-member-launcher");
    fs.writeFileSync(canonicalPath, "older-canonical-launcher");
    fs.writeFileSync(unrelatedPath, "basic-launcher");
    fs.writeFileSync(metadataPath, JSON.stringify({
      edition: "member",
      version: "2.20.1",
      launcherPath: legacyPath,
    }));

    const result = cleanupLauncherArtifacts({platform: "win32", metadataPath});
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    assert.equal(result.ok, true);
    assert.equal(result.edition, "member");
    assert.equal(fs.readFileSync(canonicalPath, "utf8"), "latest-member-launcher");
    assert.equal(fs.existsSync(legacyPath), false);
    assert.equal(fs.existsSync(legacyBackup), false);
    assert.equal(fs.existsSync(releaseDownload), false);
    assert.equal(fs.readFileSync(unrelatedPath, "utf8"), "basic-launcher");
    assert.equal(metadata.launcherPath, canonicalPath);
    assert.equal(metadata.releaseEdition, "member");
    assert.equal(metadata.canonicalLauncherName, "大a后勤部.exe");
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("launcher cleanup never replaces a newer canonical executable with an older alias", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a-share-update-no-downgrade-"));
  try {
    const legacyPath = path.join(root, "大a后勤部-旧版.exe");
    const canonicalPath = path.join(root, "大a后勤部.exe");
    const metadataPath = path.join(root, ".launcher.json");
    fs.writeFileSync(legacyPath, "older-alias");
    fs.writeFileSync(canonicalPath, "newer-canonical");
    fs.writeFileSync(metadataPath, JSON.stringify({
      edition: "member",
      version: "2.20.1",
      launcherPath: legacyPath,
    }));

    const result = cleanupLauncherArtifacts({
      platform: "win32",
      metadataPath,
      readExecutableVersion(filePath) {
        return filePath === canonicalPath ? "2.20.2" : "2.20.1";
      },
    });
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(canonicalPath, "utf8"), "newer-canonical");
    assert.equal(fs.existsSync(legacyPath), false);
    assert.equal(metadata.version, "2.20.2");
    assert.equal(metadata.launcherPath, canonicalPath);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("all desktop editions have a fixed canonical launcher name", () => {
  assert.equal(releaseProfile("member").canonicalName, "大a后勤部.exe");
  assert.equal(releaseProfile("basic").canonicalName, "复盘软件基础版.exe");
  assert.equal(releaseProfile("self").canonicalName, "复盘软件自用版.exe");
  assert.equal(releaseProfile("custom").canonicalName, "复盘软件定制版-短线模型V1.0.exe");
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
  assert.match(script, /Remove-OldLauncherArtifacts/);
  assert.match(script, /\.previous\.exe/);
});
