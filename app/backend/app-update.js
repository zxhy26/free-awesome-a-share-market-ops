const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const {spawn} = require("child_process");

const DEFAULT_MANIFEST_URL = "https://raw.githubusercontent.com/zxhy26/free-awesome-a-share-market-ops/main/updates/member.json";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_DOWNLOAD_BYTES = 160 * 1024 * 1024;
const ALLOWED_MANIFEST_HOSTS = new Set([
  "raw.githubusercontent.com",
  "api.github.com",
]);
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

function normalizeVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$/i);
  if (!match) return "";
  const parts = match.slice(1, 4).map((part) => Number(part || 0));
  if (match[4] && Number(match[4]) !== 0) parts.push(Number(match[4]));
  return parts.join(".");
}

function compareVersions(left, right) {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  if (!a || !b) throw new Error("版本号格式无效。");
  const aa = a.split(".").map(Number);
  const bb = b.split(".").map(Number);
  const length = Math.max(aa.length, bb.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (aa[index] || 0) - (bb[index] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function assertAllowedHttpsUrl(rawUrl, allowedHosts, label) {
  const url = new URL(String(rawUrl || ""));
  if (url.protocol !== "https:" || !allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error(`${label}不是允许的 GitHub HTTPS 地址。`);
  }
  return url;
}

function requestBuffer(rawUrl, options = {}, redirectCount = 0) {
  const allowedHosts = options.allowedHosts || ALLOWED_MANIFEST_HOSTS;
  const maxBytes = options.maxBytes || MAX_MANIFEST_BYTES;
  const url = assertAllowedHttpsUrl(rawUrl, allowedHosts, options.label || "请求地址");
  if (redirectCount > 6) return Promise.reject(new Error("GitHub 重定向次数过多。"));
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        Accept: options.accept || "application/json",
        "Cache-Control": "no-cache",
        "User-Agent": "Da-A-Hou-Qin-Bu-Updater",
      },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, url).href;
        requestBuffer(nextUrl, options, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GitHub 返回 ${response.statusCode || "未知状态"}。`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(new Error("GitHub 返回内容超过安全上限。"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.setTimeout(options.timeoutMs || 15000, () => request.destroy(new Error("连接 GitHub 超时。")));
    request.on("error", reject);
  });
}

async function fetchManifest(manifestUrl = DEFAULT_MANIFEST_URL) {
  const separator = manifestUrl.includes("?") ? "&" : "?";
  const buffer = await requestBuffer(`${manifestUrl}${separator}t=${Date.now()}`, {
    allowedHosts: ALLOWED_MANIFEST_HOSTS,
    maxBytes: MAX_MANIFEST_BYTES,
    label: "更新清单地址",
  });
  let payload;
  try {
    payload = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new Error(`GitHub 更新清单格式无效：${error.message}`);
  }
  if (payload && payload.encoding === "base64" && typeof payload.content === "string") {
    try {
      payload = JSON.parse(Buffer.from(payload.content.replace(/\s+/g, ""), "base64").toString("utf8"));
    } catch (error) {
      throw new Error(`GitHub 更新清单内容无效：${error.message}`);
    }
  }
  return validateManifest(payload);
}

function validateManifest(payload) {
  if (!payload || Number(payload.schemaVersion) !== 1) throw new Error("GitHub 更新清单版本不受支持。");
  if (String(payload.edition || "").toLowerCase() !== "member") throw new Error("GitHub 更新清单版本类型不匹配。");
  const version = normalizeVersion(payload.version);
  if (!version) throw new Error("GitHub 更新清单缺少有效版本号。");
  const downloadUrl = assertAllowedHttpsUrl(payload.downloadUrl, ALLOWED_DOWNLOAD_HOSTS, "更新下载地址").href;
  const sha256 = String(payload.sha256 || "").trim().toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(sha256)) throw new Error("GitHub 更新清单缺少有效 SHA-256。");
  const size = Number(payload.size);
  if (!Number.isSafeInteger(size) || size < 1024 * 1024 || size > MAX_DOWNLOAD_BYTES) {
    throw new Error("GitHub 更新文件大小不在安全范围内。");
  }
  const notes = Array.isArray(payload.notes)
    ? payload.notes.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12)
    : [];
  return {
    schemaVersion: 1,
    product: String(payload.product || "大a后勤部"),
    edition: "member",
    version,
    publishedAt: String(payload.publishedAt || ""),
    downloadUrl,
    sha256,
    size,
    releasePage: String(payload.releasePage || ""),
    notes,
  };
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
  });
}

function downloadFile(rawUrl, targetPath, options = {}, redirectCount = 0) {
  const url = assertAllowedHttpsUrl(rawUrl, ALLOWED_DOWNLOAD_HOSTS, "更新下载地址");
  if (redirectCount > 8) return Promise.reject(new Error("GitHub 下载重定向次数过多。"));
  return new Promise((resolve, reject) => {
    const temporaryPath = `${targetPath}.part`;
    let output = null;
    let delegated = false;
    let settled = false;
    const cleanupTemporaryFile = () => {
      try {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      } catch (_) {
      }
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      output?.destroy();
      cleanupTemporaryFile();
      reject(error);
    };
    const request = https.get(url, {
      headers: {
        Accept: "application/octet-stream",
        "Cache-Control": "no-cache",
        "User-Agent": "Da-A-Hou-Qin-Bu-Updater",
      },
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        delegated = true;
        const nextUrl = new URL(response.headers.location, url).href;
        downloadFile(nextUrl, targetPath, options, redirectCount + 1).then(resolve, fail);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error(`GitHub 下载返回 ${response.statusCode || "未知状态"}。`));
        return;
      }
      const expectedSize = Number(options.expectedSize) || 0;
      fs.mkdirSync(path.dirname(targetPath), {recursive: true});
      cleanupTemporaryFile();
      output = fs.createWriteStream(temporaryPath, {flags: "wx"});
      let received = 0;
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES || (expectedSize && received > expectedSize)) {
          request.destroy(new Error("GitHub 更新文件大小异常。"));
          return;
        }
        options.onProgress?.(received, expectedSize || Number(response.headers["content-length"]) || 0);
      });
      response.on("error", fail);
      output.on("error", fail);
      output.on("finish", () => {
        if (settled) return;
        settled = true;
        if (expectedSize && received !== expectedSize) {
          cleanupTemporaryFile();
          reject(new Error(`更新文件大小校验失败：${received}/${expectedSize}。`));
          return;
        }
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        fs.renameSync(temporaryPath, targetPath);
        resolve({bytes: received, path: targetPath});
      });
      response.pipe(output);
    });
    request.setTimeout(options.timeoutMs || 120000, () => request.destroy(new Error("从 GitHub 下载更新超时。")));
    request.on("error", (error) => {
      if (!delegated) fail(error);
    });
  });
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeTextAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, content, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function encodePowerShellValue(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function createInstallerScript(options) {
  const target = encodePowerShellValue(options.launcherPath);
  const staged = encodePowerShellValue(options.stagedPath);
  const runtimeRoot = encodePowerShellValue(options.runtimeRoot);
  const logPath = encodePowerShellValue(options.logPath);
  const version = encodePowerShellValue(options.version);
  return [
    '$ErrorActionPreference = "Stop"',
    'function Decode-Value([string]$value) { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) }',
    ` $target = Decode-Value "${target}"`.trimStart(),
    ` $staged = Decode-Value "${staged}"`.trimStart(),
    ` $runtimeRoot = Decode-Value "${runtimeRoot}"`.trimStart(),
    ` $logPath = Decode-Value "${logPath}"`.trimStart(),
    ` $expectedVersion = Decode-Value "${version}"`.trimStart(),
    ` $expectedHash = "${String(options.sha256 || "").toUpperCase()}"`.trimStart(),
    ` $servicePid = ${Number(options.servicePid) || 0}`.trimStart(),
    ` $appPid = ${Number(options.appPid) || 0}`.trimStart(),
    'function Write-UpdateLog([string]$message) {',
    '  try {',
    '    $directory = [IO.Path]::GetDirectoryName($logPath)',
    '    if ($directory) { [IO.Directory]::CreateDirectory($directory) | Out-Null }',
    '    Add-Content -LiteralPath $logPath -Encoding UTF8 -Value ("[{0}] {1}" -f (Get-Date -Format "yyyy/MM/dd HH:mm:ss"), $message)',
    '  } catch {}',
    '}',
    'function Stop-VerifiedProcess([int]$processId, [string]$expectedRoot) {',
    '  if ($processId -le 0) { return }',
    '  try {',
    '    $process = Get-Process -Id $processId -ErrorAction Stop',
    '    $processPath = [string]$process.Path',
    '    if ($processPath -and $processPath.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {',
    '      Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue',
    '    }',
    '  } catch {}',
    '}',
    'try {',
    '  Start-Sleep -Milliseconds 1200',
    '  Stop-VerifiedProcess $appPid $runtimeRoot',
    '  Stop-VerifiedProcess $servicePid $runtimeRoot',
    '  Start-Sleep -Milliseconds 700',
    '  if (-not [IO.File]::Exists($staged)) { throw "Downloaded update is missing." }',
    '  $actualHash = (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash.ToUpperInvariant()',
    '  if ($actualHash -ne $expectedHash) { throw "Downloaded update hash mismatch." }',
    '  $targetDirectory = [IO.Path]::GetDirectoryName($target)',
    '  if (-not $targetDirectory) { throw "Target directory is invalid." }',
    '  [IO.Directory]::CreateDirectory($targetDirectory) | Out-Null',
    '  $temporaryTarget = [IO.Path]::Combine($targetDirectory, (".da-a-update-" + [Guid]::NewGuid().ToString("N") + ".exe"))',
    '  $backupTarget = $target + ".previous.exe"',
    '  [IO.File]::Copy($staged, $temporaryTarget, $true)',
    '  if ((Get-FileHash -LiteralPath $temporaryTarget -Algorithm SHA256).Hash.ToUpperInvariant() -ne $expectedHash) {',
    '    throw "Copied update hash mismatch."',
    '  }',
    '  if ([IO.File]::Exists($backupTarget)) { [IO.File]::Delete($backupTarget) }',
    '  if ([IO.File]::Exists($target)) {',
    '    [IO.File]::Replace($temporaryTarget, $target, $backupTarget, $true)',
    '  } else {',
    '    [IO.File]::Move($temporaryTarget, $target)',
    '  }',
    '  Start-Process -FilePath $target -WorkingDirectory $targetDirectory',
    '  $verified = $false',
    '  for ($attempt = 0; $attempt -lt 75; $attempt++) {',
    '    Start-Sleep -Seconds 1',
    '    try {',
    '      $status = Invoke-RestMethod -Uri "http://127.0.0.1:18765/api/v1/app-update/status" -TimeoutSec 2',
    '      if ($status.currentVersion -eq $expectedVersion) { $verified = $true; break }',
    '    } catch {}',
    '  }',
    '  if ($verified) {',
    '    if ([IO.File]::Exists($backupTarget)) { [IO.File]::Delete($backupTarget) }',
    '    if ([IO.File]::Exists($staged)) { [IO.File]::Delete($staged) }',
    '    Write-UpdateLog ("Updated successfully to " + $expectedVersion)',
    '  } else {',
    '    try { [IO.File]::SetAttributes($backupTarget, [IO.FileAttributes]::Hidden) } catch {}',
    '    Write-UpdateLog ("Launcher replaced with " + $expectedVersion + "; startup verification timed out, backup retained.")',
    '  }',
    '  exit 0',
    '} catch {',
    '  Write-UpdateLog ("Update failed: " + $_.Exception.Message)',
    '  try {',
    '    $backupTarget = $target + ".previous.exe"',
    '    if ([IO.File]::Exists($backupTarget)) {',
    '      if ([IO.File]::Exists($target)) { [IO.File]::Delete($target) }',
    '      [IO.File]::Move($backupTarget, $target)',
    '      Start-Process -FilePath $target -WorkingDirectory ([IO.Path]::GetDirectoryName($target))',
    '    }',
    '  } catch {}',
    '  exit 1',
    '}',
    "",
  ].join("\r\n");
}

function createAppUpdateService(options = {}) {
  const edition = String(options.edition || "member").trim().toLowerCase();
  const appDir = path.resolve(options.appDir || path.join(__dirname, ".."));
  const runtimeRoot = path.resolve(options.runtimeRoot || path.join(appDir, "..", ".."));
  const workDir = path.resolve(options.workDir || __dirname);
  const manifestUrl = String(options.manifestUrl || process.env.A_SHARE_REVIEW_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_URL);
  const metadataPath = path.join(runtimeRoot, ".launcher.json");
  const updateDir = path.join(runtimeRoot, "缓存", "软件更新");
  const logPath = path.join(updateDir, "软件更新日志.txt");
  const fetchManifestImpl = options.fetchManifest || fetchManifest;
  const downloadFileImpl = options.downloadFile || downloadFile;
  const spawnImpl = options.spawn || spawn;
  const exitImpl = options.exit || ((code) => process.exit(code));
  const now = options.now || (() => new Date());
  const log = typeof options.log === "function" ? options.log : () => {};
  let installPromise = null;
  let lastManifest = null;
  let state = {
    phase: "idle",
    progress: 0,
    message: "尚未检查更新",
    checkedAt: "",
    error: "",
  };

  function launcherMetadata() {
    return readJson(metadataPath, {}) || {};
  }

  function packageVersion() {
    const candidates = [
      path.join(appDir, "..", "package.json"),
      path.join(appDir, "package.json"),
    ];
    for (const filePath of candidates) {
      const value = normalizeVersion(readJson(filePath, {})?.version);
      if (value) return value;
    }
    return "";
  }

  function currentVersion() {
    return normalizeVersion(launcherMetadata().version)
      || normalizeVersion(process.env.A_SHARE_REVIEW_LAUNCHER_VERSION)
      || packageVersion()
      || "0.0.0";
  }

  function launcherReady() {
    const metadata = launcherMetadata();
    const launcherPath = String(metadata.launcherPath || "");
    return edition === "member"
      && process.platform === "win32"
      && path.isAbsolute(launcherPath)
      && path.extname(launcherPath).toLowerCase() === ".exe"
      && fs.existsSync(launcherPath);
  }

  function publicStatus() {
    const current = currentVersion();
    const latest = lastManifest?.version || "";
    const available = Boolean(latest && compareVersions(latest, current) > 0);
    const supported = edition === "member" && process.platform === "win32";
    return {
      ok: state.phase !== "error",
      supported,
      launcherReady: launcherReady(),
      source: "GitHub",
      currentVersion: current,
      latestVersion: latest,
      updateAvailable: available,
      phase: state.phase,
      progress: state.progress,
      message: state.message,
      checkedAt: state.checkedAt,
      publishedAt: lastManifest?.publishedAt || "",
      releasePage: lastManifest?.releasePage || "",
      notes: lastManifest?.notes || [],
      error: state.error,
    };
  }

  async function checkForUpdates(options = {}) {
    if (edition !== "member" || process.platform !== "win32") {
      state = {...state, phase: "unsupported", message: "当前版本不使用会员版 GitHub 更新通道。", error: ""};
      return publicStatus();
    }
    if (!options.force && lastManifest && state.checkedAt && Date.now() - Date.parse(state.checkedAt) < 5 * 60 * 1000) {
      return publicStatus();
    }
    state = {...state, phase: "checking", progress: 0, message: "正在连接 GitHub 检查更新", error: ""};
    try {
      lastManifest = await fetchManifestImpl(manifestUrl);
      const status = publicStatus();
      state = {
        ...state,
        phase: status.updateAvailable ? "available" : "current",
        progress: status.updateAvailable ? 0 : 100,
        message: status.updateAvailable
          ? `发现 GitHub 新版本 ${lastManifest.version}`
          : `当前已是最新版 ${status.currentVersion}`,
        checkedAt: now().toISOString(),
        error: "",
      };
      return publicStatus();
    } catch (error) {
      state = {
        ...state,
        phase: "error",
        message: `GitHub 更新检查失败：${error.message}`,
        checkedAt: now().toISOString(),
        error: error.message,
      };
      log(state.message);
      return publicStatus();
    }
  }

  async function runInstall() {
    const checked = lastManifest ? publicStatus() : await checkForUpdates({force: true});
    if (!checked.updateAvailable || !lastManifest) throw new Error("没有可安装的新版本。");
    const metadata = launcherMetadata();
    const launcherPath = String(metadata.launcherPath || "");
    if (!launcherReady()) throw new Error("没有找到当前大a后勤部启动程序，请从收到的 exe 文件重新打开软件后再更新。");
    const stagedPath = path.join(updateDir, `大a后勤部-${lastManifest.version}.exe`);
    state = {...state, phase: "downloading", progress: 0, message: `正在从 GitHub 下载 ${lastManifest.version}`, error: ""};
    await downloadFileImpl(lastManifest.downloadUrl, stagedPath, {
      expectedSize: lastManifest.size,
      onProgress(received, total) {
        const progress = total > 0 ? Math.min(99, Math.floor(received / total * 100)) : 0;
        state = {...state, progress, message: `正在从 GitHub 下载 ${lastManifest.version} ${progress}%`};
      },
    });
    const stat = fs.statSync(stagedPath);
    if (stat.size !== lastManifest.size) throw new Error("下载文件大小校验失败。");
    const actualHash = await sha256File(stagedPath);
    if (actualHash !== lastManifest.sha256) throw new Error("下载文件 SHA-256 校验失败，已拒绝安装。");
    const header = Buffer.alloc(2);
    const descriptor = fs.openSync(stagedPath, "r");
    try {
      fs.readSync(descriptor, header, 0, 2, 0);
    } finally {
      fs.closeSync(descriptor);
    }
    if (header.toString("ascii") !== "MZ") throw new Error("下载内容不是有效的 Windows 程序。");

    state = {...state, phase: "preparing", progress: 100, message: "下载校验通过，正在准备替换并重启"};
    const scriptPath = path.join(updateDir, `应用更新-${lastManifest.version}.ps1`);
    writeTextAtomic(scriptPath, createInstallerScript({
      launcherPath,
      stagedPath,
      runtimeRoot,
      logPath,
      version: lastManifest.version,
      sha256: lastManifest.sha256,
      servicePid: process.pid,
      appPid: Number(metadata.appPid) || 0,
    }));
    const vbsPath = path.join(workDir, "静默运行PowerShell.vbs");
    if (!fs.existsSync(vbsPath)) throw new Error("静默更新组件缺失。");
    const child = spawnImpl(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe"), [
      vbsPath,
      scriptPath,
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref?.();
    state = {...state, phase: "restarting", progress: 100, message: "更新已下载并校验，软件正在自动重启"};
    if (!options.disableExit) {
      setTimeout(() => exitImpl(0), Number(options.exitDelayMs) || 1800).unref?.();
    }
    return publicStatus();
  }

  function startInstall() {
    if (installPromise) return {ok: true, accepted: false, running: true, ...publicStatus()};
    installPromise = runInstall()
      .catch((error) => {
        state = {...state, phase: "error", message: `软件更新失败：${error.message}`, error: error.message};
        log(state.message);
      })
      .finally(() => {
        installPromise = null;
      });
    return {ok: true, accepted: true, running: true, ...publicStatus()};
  }

  return {
    checkForUpdates,
    getStatus: publicStatus,
    startInstall,
  };
}

module.exports = {
  ALLOWED_DOWNLOAD_HOSTS,
  DEFAULT_MANIFEST_URL,
  compareVersions,
  createAppUpdateService,
  createInstallerScript,
  fetchManifest,
  normalizeVersion,
  validateManifest,
};
