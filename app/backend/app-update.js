const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const {spawn} = require("child_process");

const DEFAULT_MANIFEST_URL = "https://raw.githubusercontent.com/zxhy26/free-awesome-a-share-market-ops/main/updates/member.json";
const BASIC_MANIFEST_URL = "https://raw.githubusercontent.com/zxhy26/free-awesome-a-share-market-ops/main/updates/basic.json";
const CUSTOM_MANIFEST_URL = "https://raw.githubusercontent.com/zxhy26/free-awesome-a-share-market-ops/main/updates/custom.json";
const UPDATE_RELEASE_EDITIONS = new Set(["member", "basic", "custom"]);
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
const RELEASE_PROFILES = Object.freeze({
  member: Object.freeze({
    canonicalName: "大a后勤部.exe",
    artifactPrefixes: Object.freeze(["大a后勤部", "Da-A-Hou-Qin-Bu-v"]),
    manifestUrl: DEFAULT_MANIFEST_URL,
  }),
  basic: Object.freeze({
    canonicalName: "复盘软件基础版.exe",
    artifactPrefixes: Object.freeze(["复盘软件基础版", "A-Share-Review-Basic-v"]),
    manifestUrl: BASIC_MANIFEST_URL,
  }),
  self: Object.freeze({
    canonicalName: "复盘软件自用版.exe",
    artifactPrefixes: Object.freeze(["复盘软件自用版"]),
  }),
  custom: Object.freeze({
    canonicalName: "复盘软件定制版-短线模型V1.0.exe",
    artifactPrefixes: Object.freeze(["复盘软件定制版"]),
    manifestUrl: CUSTOM_MANIFEST_URL,
  }),
});

function resolveReleaseEdition(value, launcherPath = "") {
  const filename = path.basename(String(launcherPath || "")).toLowerCase();
  if (filename.startsWith("大a后勤部") || filename.startsWith("da-a-hou-qin-bu-v")) return "member";
  if (filename.startsWith("复盘软件自用版")) return "self";
  if (filename.startsWith("复盘软件定制版")) return "custom";
  if (filename.startsWith("复盘软件基础版")) return "basic";
  const normalized = String(value || "").trim().toLowerCase();
  if (RELEASE_PROFILES[normalized]) return normalized;
  return "";
}

function releaseProfile(value, launcherPath = "") {
  const edition = resolveReleaseEdition(value, launcherPath);
  return edition ? {edition, ...RELEASE_PROFILES[edition]} : null;
}

function isManagedLauncherArtifact(filename, profile) {
  const value = String(filename || "");
  if (!/\.exe(?:\.previous\.exe)?$/i.test(value)) return false;
  const normalized = value.toLowerCase();
  return profile.artifactPrefixes.some((prefix) => normalized.startsWith(prefix.toLowerCase()));
}

function readPortableExecutableVersion(filePath) {
  if (!fs.existsSync(filePath)) return "";
  let descriptor = null;
  try {
    descriptor = fs.openSync(filePath, "r");
    const size = fs.fstatSync(descriptor).size;
    const chunkBytes = Math.min(size, 4 * 1024 * 1024);
    const chunkStarts = size > chunkBytes ? [0, size - chunkBytes] : [0];
    const key = Buffer.from("FileVersion\0", "utf16le");
    for (const start of chunkStarts) {
      const buffer = Buffer.alloc(chunkBytes);
      const bytesRead = fs.readSync(descriptor, buffer, 0, chunkBytes, start);
      const content = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
      let offset = content.indexOf(key);
      while (offset >= 0) {
        const valueText = content
          .subarray(offset + key.length, Math.min(content.length, offset + key.length + 160))
          .toString("utf16le");
        const match = valueText.match(/^[\u0000\s]*v?(\d+\.\d+\.\d+(?:\.\d+)?)/i);
        const version = normalizeVersion(match?.[1]);
        if (version) return version;
        offset = content.indexOf(key, offset + key.length);
      }
    }
  } catch (_) {
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  return "";
}

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

async function fetchManifest(manifestUrl = DEFAULT_MANIFEST_URL, expectedEdition = "member") {
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
  return validateManifest(payload, expectedEdition);
}

function validateManifest(payload, expectedEdition = "member") {
  if (!payload || Number(payload.schemaVersion) !== 1) throw new Error("GitHub 更新清单版本不受支持。");
  const normalizedExpectedEdition = String(expectedEdition || "member").trim().toLowerCase();
  if (!UPDATE_RELEASE_EDITIONS.has(normalizedExpectedEdition)) throw new Error("当前版本没有独立的软件更新通道。");
  const manifestEdition = String(payload.edition || "").trim().toLowerCase();
  if (manifestEdition !== normalizedExpectedEdition) throw new Error("GitHub 更新清单版本类型不匹配。");
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
    edition: manifestEdition,
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
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  fs.renameSync(temporaryPath, filePath);
}

function sha256FileSync(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function cleanupLauncherArtifacts(options = {}) {
  const platform = String(options.platform || process.platform).toLowerCase();
  if (platform !== "win32") return {ok: true, supported: false, deleted: [], pending: []};

  const metadataPath = path.resolve(String(options.metadataPath || ""));
  const metadata = options.metadata || readJson(metadataPath, {}) || {};
  const launcherPath = path.resolve(String(options.launcherPath || metadata.launcherPath || ""));
  const profile = releaseProfile(
    options.releaseEdition || metadata.releaseEdition || metadata.edition,
    launcherPath,
  );
  if (!profile || !path.isAbsolute(launcherPath) || !fs.existsSync(launcherPath)) {
    return {ok: true, supported: false, deleted: [], pending: []};
  }
  if (!isManagedLauncherArtifact(path.basename(launcherPath), profile)) {
    return {ok: true, supported: false, deleted: [], pending: []};
  }

  const launcherDirectory = path.dirname(launcherPath);
  const canonicalPath = path.join(launcherDirectory, profile.canonicalName);
  const deleted = [];
  const pending = [];
  let selectedVersion = normalizeVersion(metadata.version);
  if (path.normalize(launcherPath).toLowerCase() !== path.normalize(canonicalPath).toLowerCase()) {
    const readExecutableVersion = options.readExecutableVersion || readPortableExecutableVersion;
    const currentVersion = selectedVersion || readExecutableVersion(launcherPath);
    const canonicalVersion = readExecutableVersion(canonicalPath);
    const keepNewerCanonical = Boolean(
      currentVersion && canonicalVersion && compareVersions(canonicalVersion, currentVersion) > 0,
    );
    if (keepNewerCanonical) {
      selectedVersion = canonicalVersion;
    } else {
      const temporaryPath = path.join(
        launcherDirectory,
        `.a-share-canonical-${process.pid}-${Date.now()}.exe`,
      );
      try {
        fs.copyFileSync(launcherPath, temporaryPath);
        if (sha256FileSync(temporaryPath) !== sha256FileSync(launcherPath)) {
          throw new Error("标准文件名迁移校验失败。");
        }
        if (fs.existsSync(canonicalPath)) fs.unlinkSync(canonicalPath);
        fs.renameSync(temporaryPath, canonicalPath);
      } finally {
        try {
          if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
        } catch (_) {
        }
      }
    }
  }

  const nextMetadata = {
    ...metadata,
    version: selectedVersion || metadata.version,
    launcherPath: canonicalPath,
    releaseEdition: profile.edition,
    canonicalLauncherName: profile.canonicalName,
  };
  writeTextAtomic(metadataPath, `${JSON.stringify(nextMetadata, null, 2)}\n`);

  for (const filename of fs.readdirSync(launcherDirectory)) {
    if (!isManagedLauncherArtifact(filename, profile)) continue;
    const filePath = path.join(launcherDirectory, filename);
    if (path.normalize(filePath).toLowerCase() === path.normalize(canonicalPath).toLowerCase()) continue;
    try {
      fs.unlinkSync(filePath);
      deleted.push(filePath);
    } catch (error) {
      pending.push({path: filePath, message: error.message});
    }
  }

  return {
    ok: pending.length === 0,
    supported: true,
    edition: profile.edition,
    canonicalPath,
    deleted,
    pending,
  };
}

function encodePowerShellValue(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function createInstallerScript(options) {
  const profile = releaseProfile(options.releaseEdition || "member", options.launcherPath);
  if (!profile) throw new Error("软件更新版本类型无效。");
  const originalTarget = encodePowerShellValue(options.launcherPath);
  const staged = encodePowerShellValue(options.stagedPath);
  const runtimeRoot = encodePowerShellValue(options.runtimeRoot);
  const logPath = encodePowerShellValue(options.logPath);
  const version = encodePowerShellValue(options.version);
  const canonicalName = encodePowerShellValue(profile.canonicalName);
  const artifactPrefixes = encodePowerShellValue(profile.artifactPrefixes.join("\n"));
  return [
    '$ErrorActionPreference = "Stop"',
    'function Decode-Value([string]$value) { return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value)) }',
    ` $originalTarget = Decode-Value "${originalTarget}"`.trimStart(),
    ` $staged = Decode-Value "${staged}"`.trimStart(),
    ` $runtimeRoot = Decode-Value "${runtimeRoot}"`.trimStart(),
    ` $logPath = Decode-Value "${logPath}"`.trimStart(),
    ` $expectedVersion = Decode-Value "${version}"`.trimStart(),
    ` $canonicalName = Decode-Value "${canonicalName}"`.trimStart(),
    ` $artifactPrefixes = (Decode-Value "${artifactPrefixes}") -split [char]10`.trimStart(),
    ` $expectedHash = "${String(options.sha256 || "").toUpperCase()}"`.trimStart(),
    ` $servicePid = ${Number(options.servicePid) || 0}`.trimStart(),
    ` $appPid = ${Number(options.appPid) || 0}`.trimStart(),
    '$target = ""',
    '$backupTarget = ""',
    '$targetExisted = $false',
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
    'function Test-ManagedLauncherArtifact([string]$name) {',
    '  $isExecutable = $name.EndsWith(".exe", [StringComparison]::OrdinalIgnoreCase) -or $name.EndsWith(".exe.previous.exe", [StringComparison]::OrdinalIgnoreCase)',
    '  if (-not $isExecutable) { return $false }',
    '  foreach ($prefix in $artifactPrefixes) {',
    '    if ($prefix -and $name.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }',
    '  }',
    '  return $false',
    '}',
    'function Remove-OldLauncherArtifacts([string]$directory, [string]$keepPath) {',
    '  $deleted = 0',
    '  foreach ($candidate in [IO.Directory]::GetFiles($directory)) {',
    '    if ($candidate.Equals($keepPath, [StringComparison]::OrdinalIgnoreCase)) { continue }',
    '    if (-not (Test-ManagedLauncherArtifact ([IO.Path]::GetFileName($candidate)))) { continue }',
    '    try {',
    '      [IO.File]::Delete($candidate)',
    '      $deleted++',
    '    } catch {',
    '      Write-UpdateLog ("Old launcher cleanup pending: " + $candidate)',
    '    }',
    '  }',
    '  return $deleted',
    '}',
    'try {',
    '  Start-Sleep -Milliseconds 1200',
    '  Stop-VerifiedProcess $appPid $runtimeRoot',
    '  Stop-VerifiedProcess $servicePid $runtimeRoot',
    '  Start-Sleep -Milliseconds 700',
    '  if (-not [IO.File]::Exists($staged)) { throw "Downloaded update is missing." }',
    '  $actualHash = (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash.ToUpperInvariant()',
    '  if ($actualHash -ne $expectedHash) { throw "Downloaded update hash mismatch." }',
    '  $targetDirectory = [IO.Path]::GetDirectoryName($originalTarget)',
    '  if (-not $targetDirectory) { throw "Target directory is invalid." }',
    '  [IO.Directory]::CreateDirectory($targetDirectory) | Out-Null',
    '  $target = [IO.Path]::Combine($targetDirectory, $canonicalName)',
    '  $temporaryTarget = [IO.Path]::Combine($targetDirectory, (".da-a-update-" + [Guid]::NewGuid().ToString("N") + ".exe"))',
    '  $backupTarget = $target + ".previous.exe"',
    '  $targetExisted = [IO.File]::Exists($target)',
    '  [IO.File]::Copy($staged, $temporaryTarget, $true)',
    '  if ((Get-FileHash -LiteralPath $temporaryTarget -Algorithm SHA256).Hash.ToUpperInvariant() -ne $expectedHash) {',
    '    throw "Copied update hash mismatch."',
    '  }',
    '  if ([IO.File]::Exists($backupTarget)) { [IO.File]::Delete($backupTarget) }',
    '  if ($targetExisted) {',
    '    [IO.File]::Replace($temporaryTarget, $target, $backupTarget, $true)',
    '  } else {',
    '    [IO.File]::Move($temporaryTarget, $target)',
    '  }',
    '  $launcherProcess = Start-Process -FilePath $target -WorkingDirectory $targetDirectory -PassThru',
    '  if ($null -eq $launcherProcess) { throw "Updated launcher did not start." }',
    '  Start-Sleep -Milliseconds 1200',
    '  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToUpperInvariant() -ne $expectedHash) { throw "Installed update hash mismatch." }',
    '  if ([IO.File]::Exists($backupTarget)) { [IO.File]::Delete($backupTarget) }',
    '  $deleted = Remove-OldLauncherArtifacts $targetDirectory $target',
    '  if ([IO.File]::Exists($staged)) { [IO.File]::Delete($staged) }',
    '  Write-UpdateLog ("Updated successfully to " + $expectedVersion + "; removed old launchers: " + $deleted)',
    '  exit 0',
    '} catch {',
    '  Write-UpdateLog ("Update failed: " + $_.Exception.Message)',
    '  try {',
    '    if ($backupTarget -and [IO.File]::Exists($backupTarget)) {',
    '      if ([IO.File]::Exists($target)) { [IO.File]::Delete($target) }',
    '      [IO.File]::Move($backupTarget, $target)',
    '    } elseif (-not $targetExisted -and $target -and [IO.File]::Exists($target)) {',
    '      [IO.File]::Delete($target)',
    '    }',
    '    $recoveryTarget = if ([IO.File]::Exists($originalTarget)) { $originalTarget } else { $target }',
    '    if ($recoveryTarget -and [IO.File]::Exists($recoveryTarget)) { Start-Process -FilePath $recoveryTarget -WorkingDirectory ([IO.Path]::GetDirectoryName($recoveryTarget)) }',
    '  } catch {}',
    '  exit 1',
    '}',
    "",
  ].join("\r\n");
}

function createAppUpdateService(options = {}) {
  const edition = String(options.edition || "member").trim().toLowerCase();
  const configuredReleaseEdition = String(
    options.releaseEdition || process.env.A_SHARE_REVIEW_RELEASE_EDITION || "",
  ).trim().toLowerCase();
  const platform = String(options.platform || process.platform).toLowerCase();
  const appDir = path.resolve(options.appDir || path.join(__dirname, ".."));
  const runtimeRoot = path.resolve(options.runtimeRoot || path.join(appDir, "..", ".."));
  const workDir = path.resolve(options.workDir || __dirname);
  const configuredManifestUrl = String(
    options.manifestUrl || process.env.A_SHARE_REVIEW_UPDATE_MANIFEST_URL || "",
  ).trim();
  const metadataPath = path.join(runtimeRoot, ".launcher.json");
  const updateDir = path.join(runtimeRoot, "缓存", "软件更新");
  const logPath = path.join(updateDir, "软件更新日志.txt");
  const fetchManifestImpl = options.fetchManifest || fetchManifest;
  const downloadFileImpl = options.downloadFile || downloadFile;
  const cleanupLauncherArtifactsImpl = options.cleanupLauncherArtifacts || cleanupLauncherArtifacts;
  const spawnImpl = options.spawn || spawn;
  const exitImpl = options.exit || ((code) => process.exit(code));
  const now = options.now || (() => new Date());
  const log = typeof options.log === "function" ? options.log : () => {};
  let installPromise = null;
  let cleanupTimer = null;
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

  function currentReleaseProfile() {
    const metadata = launcherMetadata();
    return releaseProfile(
      configuredReleaseEdition || metadata.releaseEdition || metadata.edition || edition,
      metadata.launcherPath,
    );
  }

  function currentManifestUrl(profile = currentReleaseProfile()) {
    const metadata = launcherMetadata();
    return configuredManifestUrl
      || String(metadata.manifestUrl || "").trim()
      || profile?.manifestUrl
      || DEFAULT_MANIFEST_URL;
  }

  function updaterSupported(profile = currentReleaseProfile()) {
    return platform === "win32" && Boolean(profile && UPDATE_RELEASE_EDITIONS.has(profile.edition));
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
    const profile = currentReleaseProfile();
    return updaterSupported(profile)
      && path.isAbsolute(launcherPath)
      && path.extname(launcherPath).toLowerCase() === ".exe"
      && fs.existsSync(launcherPath);
  }

  function publicStatus() {
    const current = currentVersion();
    const latest = lastManifest?.version || "";
    const available = Boolean(latest && compareVersions(latest, current) > 0);
    const profile = currentReleaseProfile();
    const supported = updaterSupported(profile);
    return {
      ok: state.phase !== "error",
      supported,
      launcherReady: launcherReady(),
      source: "GitHub",
      releaseEdition: profile?.edition || "",
      canonicalLauncherName: profile?.canonicalName || "",
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
    const profile = currentReleaseProfile();
    if (!updaterSupported(profile)) {
      state = {...state, phase: "unsupported", message: "当前版本未启用独立的软件更新通道。", error: ""};
      return publicStatus();
    }
    if (!options.force && lastManifest && state.checkedAt && Date.now() - Date.parse(state.checkedAt) < 5 * 60 * 1000) {
      return publicStatus();
    }
    state = {...state, phase: "checking", progress: 0, message: "正在连接 GitHub 检查更新", error: ""};
    try {
      const fetchedManifest = await fetchManifestImpl(currentManifestUrl(profile), profile.edition);
      lastManifest = validateManifest(fetchedManifest, profile.edition);
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

  function cleanupLegacyLaunchers() {
    const metadata = launcherMetadata();
    const profile = currentReleaseProfile();
    const result = cleanupLauncherArtifactsImpl({
      platform,
      metadataPath,
      metadata,
      launcherPath: metadata.launcherPath,
      releaseEdition: profile?.edition || configuredReleaseEdition || edition,
    });
    if (result.deleted?.length) {
      log(`已清理 ${result.deleted.length} 个同版本旧启动文件，只保留 ${path.basename(result.canonicalPath)}。`);
    }
    if (result.pending?.length) {
      log(`仍有 ${result.pending.length} 个旧启动文件被占用，稍后自动重试。`);
    }
    return result;
  }

  function scheduleLauncherCleanup(scheduleOptions = {}) {
    if (platform !== "win32") return false;
    if (cleanupTimer) clearTimeout(cleanupTimer);
    const delayMs = Math.max(0, Number(scheduleOptions.delayMs) || 6000);
    const retryDelayMs = Math.max(1000, Number(scheduleOptions.retryDelayMs) || 4000);
    const maxAttempts = Math.max(1, Number(scheduleOptions.maxAttempts) || 6);
    let attempts = 0;
    const run = () => {
      cleanupTimer = null;
      attempts += 1;
      try {
        const result = cleanupLegacyLaunchers();
        if (result.pending?.length && attempts < maxAttempts) {
          cleanupTimer = setTimeout(run, retryDelayMs);
          cleanupTimer.unref?.();
        }
      } catch (error) {
        log(`旧版本自动清理失败：${error.message}`);
        if (attempts < maxAttempts) {
          cleanupTimer = setTimeout(run, retryDelayMs);
          cleanupTimer.unref?.();
        }
      }
    };
    cleanupTimer = setTimeout(run, delayMs);
    cleanupTimer.unref?.();
    return true;
  }

  async function runInstall() {
    const checked = lastManifest ? publicStatus() : await checkForUpdates({force: true});
    if (!checked.updateAvailable || !lastManifest) throw new Error("没有可安装的新版本。");
    const metadata = launcherMetadata();
    const launcherPath = String(metadata.launcherPath || "");
    const profile = currentReleaseProfile();
    if (!launcherReady()) throw new Error("没有找到当前版本的启动程序，请从收到的 exe 文件重新打开软件后再更新。");
    if (!profile) throw new Error("无法确定当前软件的标准文件名。");
    const stagedPath = path.join(
      updateDir,
      `${path.parse(profile.canonicalName).name}-${lastManifest.version}.exe`,
    );
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
      releaseEdition: profile.edition,
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
    cleanupLegacyLaunchers,
    getStatus: publicStatus,
    scheduleLauncherCleanup,
    startInstall,
  };
}

module.exports = {
  ALLOWED_DOWNLOAD_HOSTS,
  CUSTOM_MANIFEST_URL,
  DEFAULT_MANIFEST_URL,
  compareVersions,
  cleanupLauncherArtifacts,
  createAppUpdateService,
  createInstallerScript,
  fetchManifest,
  normalizeVersion,
  readPortableExecutableVersion,
  releaseProfile,
  resolveReleaseEdition,
  validateManifest,
};
