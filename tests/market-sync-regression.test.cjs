const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {spawn, spawnSync} = require("node:child_process");
const {
  resolveLegacyTemplatePath,
  runOptionalOutput,
} = require("../app/backend/sync-output-policy");

const root = path.resolve(__dirname, "..");
const updater = fs.readFileSync(path.join(root, "app", "backend", "自动更新A股田字格.js"), "utf8");
const refreshScript = fs.readFileSync(path.join(root, "app", "backend", "盘中实时更新.ps1"), "utf8");
const api = fs.readFileSync(path.join(root, "app", "assets", "js", "api.js"), "utf8");
const releaseAssembly = fs.readFileSync(path.join(root, "scripts", "assemble-release-payloads.ps1"), "utf8");

function collectProcess(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => resolve({code, stdout, stderr}));
  });
}

test("missing legacy page template cannot block structured desktop synchronization", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "a-share-sync-output-"));
  try {
    const outputPath = path.join(tempRoot, "生成文件", "旧版.html");
    const seedPath = path.join(tempRoot, "缓存", "页面模板.html");
    assert.equal(resolveLegacyTemplatePath({outputPath, seedPath}), "");

    const messages = [];
    const result = runOptionalOutput("旧版单页复盘", () => {
      throw new Error("模板不存在");
    }, (message) => messages.push(message));
    assert.equal(result.ok, false);
    assert.match(messages[0], /旧版单页复盘跳过：模板不存在/);

    fs.mkdirSync(path.dirname(seedPath), {recursive: true});
    fs.writeFileSync(seedPath, "seed");
    assert.equal(resolveLegacyTemplatePath({outputPath, seedPath}), seedPath);
  } finally {
    fs.rmSync(tempRoot, {recursive: true, force: true});
  }
});

test("primary app data is written before all optional legacy artifacts", () => {
  const primaryIndex = updater.indexOf("if (!dryRun) syncOptimizedDesktopApp(marketData, quantData, policyNews)");
  const legacyIndex = updater.indexOf("runOptionalOutput(\"旧版单页复盘\"");
  assert.ok(primaryIndex >= 0);
  assert.ok(legacyIndex > primaryIndex);
  assert.doesNotMatch(updater, /throw new Error\(`找不到页面模板/);
  assert.match(updater, /旧版单页模板不存在，已跳过兼容页面输出；结构化桌面应用继续更新/);
});

test("manual synchronization waits for the active lock and never reports a skipped run as success", () => {
  assert.match(refreshScript, /while \(-not \$lockStream\)/);
  assert.match(refreshScript, /if \(-not \$Force\)[\s\S]*A_SHARE_REVIEW_SYNC_BUSY[\s\S]*exit 75/);
  assert.match(refreshScript, /A_SHARE_REVIEW_SYNC_LOCK_WAIT_SECONDS/);
  assert.match(refreshScript, /手动同步等待已有任务超时/);
  assert.match(api, /SYNC_BUSY: "后台已有同步任务/);
  assert.match(api, /pollSync\(onProgress, 11 \* 60 \* 1000\)/);
});

test("release assembly overlays the latest public history for every edition", () => {
  assert.match(releaseAssembly, /function Overlay-LatestHistory/);
  assert.match(releaseAssembly, /Join-Path \$SelfBase "数据历史"/);
  assert.match(releaseAssembly, /Overlay-LatestRuntimeData \$Target[\s\S]*Overlay-LatestHistory \$Target[\s\S]*Set-EditionBoundary/);
});

test("forced synchronization returns an error when an external lock cannot be acquired", {
  skip: process.platform !== "win32" || process.env.A_SHARE_REVIEW_RUN_LOCK_INTEGRATION !== "1",
  timeout: 60000,
}, async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "a-share-sync-lock-"));
  const scriptPath = path.join(tempRoot, "盘中实时更新.ps1");
  const lockPath = path.join(tempRoot, "盘中实时更新.lock");
  const readyPath = path.join(tempRoot, "lock-ready.txt");
  const holderSource = path.join(tempRoot, "lock-holder.cs");
  const holderExe = path.join(tempRoot, "lock-holder.exe");
  fs.copyFileSync(path.join(root, "app", "backend", "盘中实时更新.ps1"), scriptPath);
  fs.writeFileSync(holderSource, [
    "using System.IO;",
    "using System.Threading;",
    "internal static class LockHolder {",
    "  private static int Main(string[] args) {",
    "    using (var stream = new FileStream(args[0], FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {",
    "      File.WriteAllText(args[1], \"ready\");",
    "      Thread.Sleep(60000);",
    "    }",
    "    return 0;",
    "  }",
    "}",
  ].join("\n"));
  const windowsRoot = process.env.WINDIR || "C:\\Windows";
  const csc = [
    path.join(windowsRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windowsRoot, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ].find((candidate) => fs.existsSync(candidate));
  assert.ok(csc, "Windows C# compiler is unavailable");
  const compilation = spawnSync(csc, ["/nologo", "/target:exe", `/out:${holderExe}`, holderSource], {
    windowsHide: true,
    encoding: "utf8",
  });
  assert.equal(compilation.status, 0, compilation.stderr || compilation.stdout);
  const holder = spawn(holderExe, [lockPath, readyPath], {windowsHide: true, stdio: ["ignore", "pipe", "pipe"]});
  try {
    const readyDeadline = Date.now() + 20000;
    while (!fs.existsSync(readyPath) && Date.now() < readyDeadline) {
      if (holder.exitCode !== null) throw new Error(`lock holder exited with code ${holder.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(fs.existsSync(readyPath), true, "lock holder did not create its ready marker");
    const startedAt = Date.now();
    const runner = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      scriptPath,
      "-Force",
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {...process.env, A_SHARE_REVIEW_SYNC_LOCK_WAIT_SECONDS: "1"},
    });
    const result = await collectProcess(runner);
    assert.notEqual(result.code, 0);
    assert.ok(Date.now() - startedAt >= 900);
    assert.match(result.stdout, /正在等待已有同步任务结束/);
    assert.match(fs.readFileSync(path.join(tempRoot, "自动更新日志.txt"), "utf8"), /手动同步等待已有任务超时/);
  } finally {
    if (holder.exitCode === null) holder.kill();
    await Promise.race([
      new Promise((resolve) => holder.once("close", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        fs.rmSync(tempRoot, {recursive: true, force: true});
        break;
      } catch (error) {
        if (attempt === 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
      }
    }
  }
});
