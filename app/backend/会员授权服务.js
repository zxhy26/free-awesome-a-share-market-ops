const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ACTIVATION_PREFIX = "AFRP1.";
const CLOCK_ROLLBACK_TOLERANCE_MS = 12 * 60 * 60 * 1000;
const TRIAL_DURATION_MS = 3 * 24 * 60 * 60 * 1000;
const TRIAL_RECORD_SCHEMA_VERSION = 1;
const PAYMENT_ADAPTER_TIMEOUT_MS = 12 * 1000;
const PAYMENT_RESPONSE_LIMIT = 256 * 1024;
const PAYMENT_ORDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const PAYMENT_ORDER_STATUSES = new Set(["pending", "paid", "closed", "expired", "failed"]);
const PLAN_DEFINITIONS = {
  month: { label: "月付会员", days: 30, price: 72 },
  year: { label: "包年会员", days: 365, price: 699 },
  lifetime: { label: "私人订制永久版", days: null, price: 1599, permanent: true },
};

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + padding, "base64");
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, maxLength);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function parseDate(value) {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : NaN;
}

function normalizeDeviceCode(value) {
  const compact = String(value || "").toUpperCase().replace(/[^A-F0-9]/g, "");
  const body = compact.startsWith("A5") && compact.length > 16 ? compact.slice(-16) : compact;
  if (!/^[A-F0-9]{16}$/.test(body)) return "";
  return `A5-${body.match(/.{1,4}/g).join("-")}`;
}

function readMachineGuid() {
  if (process.platform !== "win32") return "";
  const regPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
  try {
    const output = execFileSync(regPath, [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
      "/v",
      "MachineGuid",
    ], { encoding: "utf8", windowsHide: true, timeout: 4000 });
    const match = output.match(/MachineGuid\s+REG_\w+\s+([^\r\n]+)/i);
    return match ? match[1].trim() : "";
  } catch (_) {
    return "";
  }
}

function readRequestJson(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("请求内容过大"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolve(text ? JSON.parse(text) : {});
      } catch (_) {
        reject(Object.assign(new Error("请求格式无效"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function createMembershipService(options = {}) {
  const requestedEdition = String(options.edition || "").trim().toLowerCase();
  const edition = ["member", "basic", "self"].includes(requestedEdition)
    ? requestedEdition
    : "member";
  const appDir = path.resolve(options.appDir || path.join(__dirname, ".."));
  const dataDir = path.resolve(options.dataDir || path.join(appDir, "data"));
  const keyDir = path.resolve(options.keyDir || __dirname);
  const localAppData = process.env.LOCALAPPDATA
    || (process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : path.join(os.homedir(), "AppData", "Local"));
  const editionDirectory = {
    member: "会员版",
    basic: "基础版",
    self: "自用版",
  }[edition];
  const stateDir = path.resolve(
    process.env.A_SHARE_REVIEW_MEMBER_DATA_DIR
      || path.join(localAppData, "A股复盘软件运行文件", editionDirectory),
  );
  const licensePath = path.join(stateDir, "会员授权.json");
  const clockPath = path.join(stateDir, "时间校验.json");
  const trialPath = path.join(stateDir, "免费试用记录.json");
  const fallbackDevicePath = path.join(stateDir, "设备标识.json");
  const historyPath = path.join(stateDir, "会员激活记录.json");
  const publicKeyPath = path.join(keyDir, "会员公钥.pem");
  const privateKeyPath = path.join(keyDir, "会员私钥.pem");
  let cachedDeviceCode = "";

  function getDeviceCode() {
    if (cachedDeviceCode) return cachedDeviceCode;
    fs.mkdirSync(stateDir, { recursive: true });
    let seed = readMachineGuid();
    if (!seed) {
      const stored = readJson(fallbackDevicePath, {});
      seed = stored.id;
      if (!seed) {
        seed = crypto.randomBytes(24).toString("hex");
        writeJsonAtomic(fallbackDevicePath, { id: seed, createdAt: new Date().toISOString() });
      }
    }
    const digest = crypto.createHash("sha256")
      .update(`A股复盘会员设备-v1|${seed}`, "utf8")
      .digest("hex")
      .slice(0, 16)
      .toUpperCase();
    cachedDeviceCode = `A5-${digest.match(/.{1,4}/g).join("-")}`;
    return cachedDeviceCode;
  }

  function checkClock(now = Date.now()) {
    if (process.env.A_SHARE_REVIEW_SKIP_CLOCK_CHECK === "1") return { ok: true };
    const state = readJson(clockPath, {});
    const maxSeenAt = parseDate(state.maxSeenAt);
    if (Number.isFinite(maxSeenAt) && now + CLOCK_ROLLBACK_TOLERANCE_MS < maxSeenAt) {
      return {
        ok: false,
        code: "CLOCK_ROLLBACK",
        reason: "系统时间明显早于上次使用时间，请校准电脑日期和时间。",
      };
    }
    if (!Number.isFinite(maxSeenAt) || now > maxSeenAt) {
      writeJsonAtomic(clockPath, { maxSeenAt: new Date(now).toISOString() });
    }
    return { ok: true };
  }

  function readTrialState(now = Date.now()) {
    const exists = fs.existsSync(trialPath);
    if (!exists) {
      return {
        used: false,
        available: edition === "member",
        active: false,
        startedAt: "",
        expiresAt: "",
        statusCode: "TRIAL_AVAILABLE",
      };
    }

    const stored = readJson(trialPath, null);
    const startedAt = parseDate(stored?.startedAt);
    const expiresAt = parseDate(stored?.expiresAt);
    const deviceMatches = normalizeDeviceCode(stored?.deviceCode) === getDeviceCode();
    const durationMatches = Number.isFinite(startedAt)
      && Number.isFinite(expiresAt)
      && Math.abs((expiresAt - startedAt) - TRIAL_DURATION_MS) <= 1000;
    const valid = Number(stored?.schemaVersion) === TRIAL_RECORD_SCHEMA_VERSION
      && deviceMatches
      && durationMatches;
    const active = valid && now >= startedAt && now < expiresAt;
    return {
      used: true,
      available: false,
      active,
      startedAt: Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : "",
      expiresAt: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : "",
      statusCode: !valid ? "TRIAL_RECORD_INVALID" : active ? "TRIAL_ACTIVE" : "TRIAL_EXPIRED",
    };
  }

  function parseActivationCode(activationCode) {
    const compact = String(activationCode || "").replace(/\s+/g, "");
    if (!compact.startsWith(ACTIVATION_PREFIX)) throw new Error("激活码格式不正确");
    let envelope;
    try {
      envelope = JSON.parse(base64UrlDecode(compact.slice(ACTIVATION_PREFIX.length)).toString("utf8"));
    } catch (_) {
      throw new Error("激活码内容无法识别");
    }
    if (!envelope || typeof envelope !== "object" || !envelope.payload || !envelope.signature) {
      throw new Error("激活码内容不完整");
    }
    return envelope;
  }

  function verifyEnvelope(envelope, options = {}) {
    if (!fs.existsSync(publicKeyPath)) {
      return { ok: false, code: "PUBLIC_KEY_MISSING", reason: "授权公钥缺失，请重新安装会员版。" };
    }
    const payload = envelope?.payload;
    if (!payload || Number(payload.v) !== 1) {
      return { ok: false, code: "LICENSE_VERSION", reason: "激活码版本不受支持。" };
    }
    let signatureValid = false;
    try {
      signatureValid = crypto.verify(
        "RSA-SHA256",
        Buffer.from(canonicalize(payload), "utf8"),
        fs.readFileSync(publicKeyPath, "utf8"),
        base64UrlDecode(envelope.signature),
      );
    } catch (_) {
      signatureValid = false;
    }
    if (!signatureValid) return { ok: false, code: "BAD_SIGNATURE", reason: "激活码签名校验失败。" };

    const deviceCode = normalizeDeviceCode(payload.deviceCode);
    if (!deviceCode || (!options.ignoreDevice && deviceCode !== getDeviceCode())) {
      return { ok: false, code: "DEVICE_MISMATCH", reason: "激活码与当前电脑不匹配。" };
    }
    const planDefinition = PLAN_DEFINITIONS[payload.plan];
    if (!planDefinition) {
      return { ok: false, code: "PLAN_INVALID", reason: "会员套餐无效。" };
    }
    const issuedAt = parseDate(payload.issuedAt);
    const validFrom = parseDate(payload.validFrom);
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    if (![issuedAt, validFrom].every(Number.isFinite)) {
      return { ok: false, code: "DATE_INVALID", reason: "激活码有效期无效。" };
    }
    const permanent = planDefinition.permanent === true;
    const expiresAt = permanent ? Number.POSITIVE_INFINITY : parseDate(payload.expiresAt);
    if (permanent && payload.permanent !== true) {
      return { ok: false, code: "PERMANENT_FLAG_MISSING", reason: "私人订制永久版授权标记无效。" };
    }
    if (!permanent && (!Number.isFinite(expiresAt) || expiresAt <= validFrom)) {
      return { ok: false, code: "DATE_INVALID", reason: "激活码有效期无效。" };
    }
    if (issuedAt > now + 24 * 60 * 60 * 1000) {
      return { ok: false, code: "ISSUED_IN_FUTURE", reason: "激活码签发时间异常。" };
    }
    if (now < validFrom) {
      return { ok: false, code: "NOT_YET_VALID", reason: `会员将在 ${new Date(validFrom).toLocaleString("zh-CN")} 生效。` };
    }
    if (!permanent && now >= expiresAt) {
      return { ok: false, code: "EXPIRED", reason: "会员已到期，请续费后输入新的激活码。" };
    }
    return { ok: true, payload, expiresAt, permanent };
  }

  function memberStatus() {
    const deviceCode = getDeviceCode();
    const checkedAt = new Date().toISOString();
    const noTrial = {
      trialAvailable: false,
      trialUsed: false,
      trialActive: false,
      trialStartedAt: "",
      trialExpiresAt: "",
    };
    if (edition === "self" || edition === "basic") {
      const isSelf = edition === "self";
      return {
        ok: true,
        edition,
        active: true,
        deviceCode,
        plan: isSelf ? "self" : "basic",
        planLabel: isSelf ? "自用版" : "基础版",
        expiresAt: "",
        remainingDays: null,
        canIssueActivation: isSelf,
        reason: isSelf
          ? "自用版全部功能及激活码签发权限已启用。"
          : "基础版全部复盘和量化功能已启用，不含激活码签发权限。",
        checkedAt,
        ...noTrial,
      };
    }

    const clock = checkClock();
    const trial = readTrialState();
    const trialFields = {
      trialAvailable: clock.ok && trial.available,
      trialUsed: trial.used,
      trialActive: clock.ok && trial.active,
      trialStartedAt: trial.startedAt,
      trialExpiresAt: trial.expiresAt,
    };
    if (!clock.ok) {
      return {
        ok: true,
        edition,
        active: false,
        deviceCode,
        plan: "",
        planLabel: "未激活",
        expiresAt: "",
        remainingDays: 0,
        statusCode: clock.code,
        reason: clock.reason,
        checkedAt,
        ...trialFields,
      };
    }

    const stored = readJson(licensePath, null);
    const verification = stored?.envelope ? verifyEnvelope(stored.envelope) : null;
    if (verification?.ok) {
      const payload = verification.payload;
      return {
        ok: true,
        edition,
        active: true,
        deviceCode,
        licenseId: payload.licenseId,
        plan: payload.plan,
        planLabel: PLAN_DEFINITIONS[payload.plan].label,
        issuedAt: payload.issuedAt,
        validFrom: payload.validFrom,
        expiresAt: payload.expiresAt,
        permanent: verification.permanent,
        remainingDays: verification.permanent
          ? null
          : Math.max(1, Math.ceil((verification.expiresAt - Date.now()) / (24 * 60 * 60 * 1000))),
        customer: payload.customer || "",
        reason: verification.permanent ? "私人订制永久版授权有效，仅绑定当前设备。" : "会员授权有效。",
        checkedAt,
        ...trialFields,
      };
    }

    if (trial.active) {
      const trialExpiry = parseDate(trial.expiresAt);
      return {
        ok: true,
        edition,
        active: true,
        deviceCode,
        plan: "trial",
        planLabel: "三天免费试用",
        issuedAt: trial.startedAt,
        validFrom: trial.startedAt,
        expiresAt: trial.expiresAt,
        permanent: false,
        remainingDays: Math.max(1, Math.ceil((trialExpiry - Date.now()) / (24 * 60 * 60 * 1000))),
        reason: "三天免费试用已生效；每台设备仅可领取一次。",
        checkedAt,
        ...trialFields,
      };
    }

    if (verification && !verification.ok) {
      return {
        ok: true,
        edition,
        active: false,
        deviceCode,
        plan: stored.envelope?.payload?.plan || "",
        planLabel: "授权不可用",
        expiresAt: stored.envelope?.payload?.expiresAt || "",
        permanent: stored.envelope?.payload?.permanent === true,
        remainingDays: 0,
        statusCode: verification.code,
        reason: verification.reason,
        checkedAt,
        ...trialFields,
      };
    }

    if (trial.used) {
      return {
        ok: true,
        edition,
        active: false,
        deviceCode,
        plan: "trial",
        planLabel: "免费试用已结束",
        expiresAt: trial.expiresAt,
        permanent: false,
        remainingDays: 0,
        statusCode: trial.statusCode,
        reason: trial.statusCode === "TRIAL_EXPIRED"
          ? "三天免费试用已结束；每台设备不能重复领取。"
          : "免费试用记录不可用；每台设备不能重复领取。",
        checkedAt,
        ...trialFields,
      };
    }

    return {
      ok: true,
      edition,
      active: false,
      deviceCode,
      plan: "",
      planLabel: "未激活",
      expiresAt: "",
      remainingDays: 0,
      statusCode: "NOT_ACTIVATED",
      reason: "当前电脑尚未激活会员，可领取一次三天免费试用。",
      checkedAt,
      ...trialFields,
    };
  }

  function hasAccess() {
    return memberStatus().active;
  }

  function claimTrial() {
    if (edition !== "member") {
      throw Object.assign(new Error("当前版本不提供会员试用。"), {
        statusCode: 403,
        code: "TRIAL_EDITION_UNAVAILABLE",
      });
    }
    const clock = checkClock();
    if (!clock.ok) throw Object.assign(new Error(clock.reason), { statusCode: 409, code: clock.code });
    const trial = readTrialState();
    if (trial.used) {
      throw Object.assign(new Error("本机已经领取过三天免费试用，不能重复领取。"), {
        statusCode: 409,
        code: "TRIAL_ALREADY_USED",
      });
    }
    if (memberStatus().active) {
      throw Object.assign(new Error("当前会员授权已生效，无需领取免费试用。"), {
        statusCode: 409,
        code: "MEMBERSHIP_ALREADY_ACTIVE",
      });
    }
    const startedAt = Date.now();
    const expiresAt = startedAt + TRIAL_DURATION_MS;
    writeJsonAtomic(trialPath, {
      schemaVersion: TRIAL_RECORD_SCHEMA_VERSION,
      deviceCode: getDeviceCode(),
      startedAt: new Date(startedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    });
    return memberStatus();
  }

  function activate(activationCode) {
    if (edition !== "member") return memberStatus();
    const clock = checkClock();
    if (!clock.ok) throw Object.assign(new Error(clock.reason), { statusCode: 409, code: clock.code });
    const envelope = parseActivationCode(activationCode);
    const verification = verifyEnvelope(envelope);
    if (!verification.ok) {
      throw Object.assign(new Error(verification.reason), { statusCode: 400, code: verification.code });
    }
    const current = readJson(licensePath, null);
    if (current?.envelope) {
      const currentVerification = verifyEnvelope(current.envelope);
      if (currentVerification.ok && verification.expiresAt < currentVerification.expiresAt) {
        throw Object.assign(new Error("新激活码的到期时间早于当前有效授权。"), {
          statusCode: 409,
          code: "OLDER_LICENSE",
        });
      }
    }
    writeJsonAtomic(licensePath, {
      envelope,
      activatedAt: new Date().toISOString(),
      deviceCode: getDeviceCode(),
    });
    return memberStatus();
  }

  function createActivation(body) {
    if (edition !== "self") {
      throw Object.assign(new Error("当前版本没有激活码签发权限。"), { statusCode: 403 });
    }
    if (!fs.existsSync(privateKeyPath)) {
      throw Object.assign(new Error("签发私钥缺失。"), { statusCode: 500 });
    }
    const deviceCode = normalizeDeviceCode(body.deviceCode);
    if (!deviceCode) throw Object.assign(new Error("请输入有效的 16 位设备码。"), { statusCode: 400 });
    const plan = PLAN_DEFINITIONS[body.plan] ? body.plan : "";
    if (!plan) throw Object.assign(new Error("请选择月付、包年或私人订制永久版套餐。"), { statusCode: 400 });

    const now = Date.now();
    const planDefinition = PLAN_DEFINITIONS[plan];
    const permanent = planDefinition.permanent === true;
    const requestedBase = parseDate(body.baseExpiry);
    const validFrom = !permanent && Number.isFinite(requestedBase) && requestedBase > now ? requestedBase : now;
    const expiresAt = permanent ? null : validFrom + planDefinition.days * 24 * 60 * 60 * 1000;
    const payload = {
      v: 1,
      licenseId: crypto.randomBytes(9).toString("hex").toUpperCase(),
      deviceCode,
      plan,
      permanent,
      issuedAt: new Date(now).toISOString(),
      validFrom: new Date(validFrom).toISOString(),
      expiresAt: permanent ? "" : new Date(expiresAt).toISOString(),
      customer: cleanText(body.customer, 80),
      orderNote: cleanText(body.orderNote, 120),
    };
    const signature = crypto.sign(
      "RSA-SHA256",
      Buffer.from(canonicalize(payload), "utf8"),
      fs.readFileSync(privateKeyPath, "utf8"),
    );
    const envelope = { payload, signature: base64UrlEncode(signature) };
    const activationCode = ACTIVATION_PREFIX + base64UrlEncode(Buffer.from(JSON.stringify(envelope), "utf8"));

    const history = readJson(historyPath, { items: [] });
    const items = Array.isArray(history.items) ? history.items : [];
    items.unshift({
      licenseId: payload.licenseId,
      deviceCode,
      plan,
      planLabel: PLAN_DEFINITIONS[plan].label,
      price: PLAN_DEFINITIONS[plan].price,
      issuedAt: payload.issuedAt,
      validFrom: payload.validFrom,
      expiresAt: payload.expiresAt,
      permanent,
      customer: payload.customer,
      orderNote: payload.orderNote,
      activationCode,
    });
    writeJsonAtomic(historyPath, { updatedAt: new Date().toISOString(), items: items.slice(0, 500) });
    return { ok: true, activationCode, payload, price: PLAN_DEFINITIONS[plan].price };
  }

  function adminHistory() {
    if (edition !== "self") return { ok: false, items: [] };
    const history = readJson(historyPath, { items: [] });
    return {
      ok: true,
      updatedAt: history.updatedAt || "",
      items: Array.isArray(history.items) ? history.items : [],
    };
  }

  function paymentAdapterSettings(raw) {
    const provider = cleanText(raw?.officialAdapter?.provider, 32) || "wechatpay-v3";
    const pollSeconds = Math.min(10, Math.max(2, Number(raw?.officialAdapter?.pollSeconds) || 3));
    const testEndpoint = process.env.A_SHARE_REVIEW_PAYMENT_TEST_MODE === "1"
      ? cleanText(process.env.A_SHARE_REVIEW_PAYMENT_ADAPTER_ENDPOINT, 2048)
      : "";
    let endpoint = "";
    try {
      const candidate = new URL(testEndpoint || cleanText(raw?.officialAdapter?.endpoint, 2048));
      const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(candidate.hostname);
      const allowTestEndpoint = process.env.A_SHARE_REVIEW_PAYMENT_TEST_MODE === "1" && isLoopback;
      if (candidate.protocol === "https:" || (allowTestEndpoint && candidate.protocol === "http:")) {
        candidate.hash = "";
        candidate.search = "";
        if (!candidate.pathname.endsWith("/")) candidate.pathname += "/";
        endpoint = candidate.toString();
      }
    } catch (_) {
      endpoint = "";
    }
    return {
      enabled: (raw?.officialAdapter?.enabled === true || Boolean(testEndpoint)) && Boolean(endpoint),
      provider,
      endpoint,
      pollSeconds,
    };
  }

  async function requestPaymentAdapter(relativePath, requestOptions = {}) {
    const raw = readJson(path.join(dataDir, "会员支付配置.json"), {});
    const adapter = paymentAdapterSettings(raw);
    if (!adapter.enabled) {
      throw Object.assign(new Error("自动到账尚未配置，请使用当前人工核验方式。"), {
        statusCode: 503,
        code: "AUTO_PAYMENT_NOT_CONFIGURED",
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAYMENT_ADAPTER_TIMEOUT_MS);
    try {
      const response = await fetch(new URL(relativePath, adapter.endpoint), {
        ...requestOptions,
        headers: {
          Accept: "application/json",
          ...(requestOptions.body ? { "Content-Type": "application/json" } : {}),
          ...(requestOptions.headers || {}),
        },
        signal: controller.signal,
      });
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > PAYMENT_RESPONSE_LIMIT) {
        throw Object.assign(new Error("支付服务响应内容过大。"), {
          statusCode: 502,
          code: "PAYMENT_RESPONSE_TOO_LARGE",
        });
      }
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch (_) {
        throw Object.assign(new Error("支付服务返回了无法识别的数据。"), {
          statusCode: 502,
          code: "PAYMENT_RESPONSE_INVALID",
        });
      }
      if (!response.ok) {
        throw Object.assign(new Error(cleanText(body.message, 160) || "支付服务暂时不可用。"), {
          statusCode: 502,
          code: cleanText(body.errorCode, 48) || "PAYMENT_ADAPTER_ERROR",
        });
      }
      return { adapter, body };
    } catch (error) {
      if (error.name === "AbortError") {
        throw Object.assign(new Error("支付服务连接超时，请稍后重试。"), {
          statusCode: 504,
          code: "PAYMENT_ADAPTER_TIMEOUT",
        });
      }
      if (error.statusCode) throw error;
      throw Object.assign(new Error("无法连接支付服务，请稍后重试。"), {
        statusCode: 502,
        code: "PAYMENT_ADAPTER_UNREACHABLE",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  function normalizePaymentQr(value, adapterEndpoint) {
    const text = String(value || "").trim();
    if (/^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/i.test(text) && text.length <= 1400000) {
      return text;
    }
    try {
      const candidate = new URL(text, adapterEndpoint);
      const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(candidate.hostname);
      const allowTestEndpoint = process.env.A_SHARE_REVIEW_PAYMENT_TEST_MODE === "1" && isLoopback;
      if (candidate.protocol === "https:" || (allowTestEndpoint && candidate.protocol === "http:")) {
        return candidate.toString();
      }
    } catch (_) {
    }
    return "";
  }

  async function createPaymentOrder(body) {
    if (edition !== "member") {
      throw Object.assign(new Error(`${edition === "basic" ? "基础版" : "自用版"}无需购买会员。`), {
        statusCode: 400,
        code: edition === "basic" ? "BASIC_EDITION" : "SELF_EDITION",
      });
    }
    const plan = PLAN_DEFINITIONS[body.plan] ? body.plan : "";
    if (!plan) throw Object.assign(new Error("请选择月付、包年或私人订制永久版套餐。"), { statusCode: 400 });
    const current = memberStatus();
    const requestId = crypto.randomBytes(12).toString("hex").toUpperCase();
    const result = await requestPaymentAdapter("orders", {
      method: "POST",
      body: JSON.stringify({
        requestId,
        deviceCode: getDeviceCode(),
        plan,
        amount: PLAN_DEFINITIONS[plan].price,
        days: PLAN_DEFINITIONS[plan].days,
        permanent: PLAN_DEFINITIONS[plan].permanent === true,
        currentExpiresAt: current.active ? current.expiresAt : "",
        edition: "member",
      }),
    });
    const orderId = cleanText(result.body.orderId, 64);
    const qrImageUrl = normalizePaymentQr(
      result.body.qrImageDataUrl || result.body.qrImageUrl,
      result.adapter.endpoint,
    );
    const expiresAt = cleanText(result.body.expiresAt, 64);
    if (!PAYMENT_ORDER_ID_PATTERN.test(orderId) || !qrImageUrl || !Number.isFinite(parseDate(expiresAt))) {
      throw Object.assign(new Error("支付服务返回的订单信息不完整。"), {
        statusCode: 502,
        code: "PAYMENT_ORDER_INVALID",
      });
    }
    return {
      ok: true,
      orderId,
      status: "pending",
      plan,
      planLabel: PLAN_DEFINITIONS[plan].label,
      amount: PLAN_DEFINITIONS[plan].price,
      qrImageUrl,
      expiresAt,
      pollSeconds: result.adapter.pollSeconds,
      message: cleanText(result.body.message, 160) || "请使用微信扫描本机专属付款码。",
    };
  }

  async function queryPaymentOrder(orderId) {
    if (!PAYMENT_ORDER_ID_PATTERN.test(orderId)) {
      throw Object.assign(new Error("支付订单号无效。"), { statusCode: 400, code: "PAYMENT_ORDER_INVALID" });
    }
    const deviceCode = getDeviceCode();
    const result = await requestPaymentAdapter(
      `orders/${encodeURIComponent(orderId)}?deviceCode=${encodeURIComponent(deviceCode)}`,
    );
    const status = cleanText(result.body.status, 16).toLowerCase();
    if (!PAYMENT_ORDER_STATUSES.has(status)) {
      throw Object.assign(new Error("支付服务返回的订单状态无效。"), {
        statusCode: 502,
        code: "PAYMENT_STATUS_INVALID",
      });
    }
    if (status !== "paid") {
      return {
        ok: true,
        orderId,
        status,
        message: cleanText(result.body.message, 160),
      };
    }
    const activationCode = String(result.body.activationCode || "").trim();
    if (!activationCode) {
      throw Object.assign(new Error("订单已支付，但授权签名尚未生成，请稍后重试。"), {
        statusCode: 502,
        code: "PAYMENT_LICENSE_PENDING",
      });
    }
    const membership = activate(activationCode);
    return {
      ok: true,
      orderId,
      status,
      message: "支付已确认，会员已自动开通。",
      membership,
    };
  }

  function paymentConfig() {
    const raw = readJson(path.join(dataDir, "会员支付配置.json"), {});
    const adapter = paymentAdapterSettings(raw);
    const safeAsset = (relativePath) => {
      const normalized = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
      if (!normalized) return { available: false, url: "" };
      const filePath = path.resolve(appDir, normalized);
      if (filePath !== appDir && !filePath.startsWith(appDir + path.sep)) {
        return { available: false, url: "" };
      }
      return {
        available: fs.existsSync(filePath) && fs.statSync(filePath).isFile(),
        url: `/app/${normalized}`,
      };
    };
    const wechat = safeAsset(raw.wechatQr);
    const alipay = safeAsset(raw.alipayQr);
    const creatorWechat = safeAsset(raw.creatorWechatQr);
    return {
      ok: true,
      mode: adapter.enabled ? "official-auto" : "manual-qrcode",
      plans: Object.entries(PLAN_DEFINITIONS).map(([key, value]) => ({ key, ...value })),
      wechat,
      alipay,
      creatorWechat,
      supportName: cleanText(raw.supportName, 40),
      supportNote: cleanText(raw.supportNote, 160),
      officialAdapter: {
        enabled: adapter.enabled,
        provider: adapter.provider,
        pollSeconds: adapter.pollSeconds,
      },
    };
  }

  function protectedFeatureForPath(pathname) {
    const features = {
      "/app/pages/policy-news.html": "政策新闻",
      "/app/pages/next-week-events.html": "下周大事件",
      "/app/data/next-week-events.json": "下周大事件",
      "/app/pages/derivatives.html": "机构动向",
      "/app/pages/history.html": "历史回放",
      "/app/pages/stock-search.html": "个股搜索",
      "/app/pages/theme-treasure.html": "题材宝典",
      "/app/data/policy-news.json": "政策新闻",
      "/app/data/next-week-events.json": "下周大事件",
      "/app/data/derivatives.json": "机构动向",
      "/app/data/history-index.json": "历史回放",
      "/app/data/index-contribution.json": "指数贡献",
      "/app/data/theme-treasure.json": "题材宝典",
    };
    return features[pathname] || "";
  }

  function protectedFeatureForApi(pathname, method) {
    if (pathname === "/policy-refresh") return "政策新闻更新";
    if (pathname === "/next-week-events-refresh") return "下周大事件更新";
    if (pathname === "/api/v1/data/policy-news") return "政策新闻";
    if (pathname === "/api/v1/data/next-week-events") return "下周大事件";
    if (pathname === "/api/v1/data/derivatives") return "机构动向";
    if (pathname === "/api/v1/history/dates" || pathname.startsWith("/api/v1/history/")) return "历史回放";
    if (pathname === "/derivatives-refresh") return "机构动向更新";
    if (pathname === "/api/v1/stocks/search" || pathname === "/api/v1/stocks/analyze") return "个股搜索";
    if (pathname === "/api/v1/theme-treasure" || pathname === "/api/v1/theme-treasure/detail" || pathname === "/api/v1/theme-treasure/company" || pathname === "/api/v1/data/theme-treasure") return "题材宝典";
    if (pathname === "/api/v1/theme-treasure/refresh") return "题材宝典更新";
    if (pathname === "/api/v1/sector-flow" || pathname === "/api/v1/sector-trend") return "自选板块分时";
    if (pathname === "/api/v1/data/index-contribution" || pathname === "/api/v1/index-contribution/refresh") return "指数贡献";
    return "";
  }

  function sendPaymentRequired(res, feature) {
    sendJson(res, 402, {
      ok: false,
      errorCode: "MEMBERSHIP_REQUIRED",
      feature,
      message: `${feature || "该功能"}需要开通会员后使用。`,
      membership: memberStatus(),
    });
  }

  async function handleRequest(req, res, url) {
    try {
      if (url.pathname === "/api/v1/membership/status" && req.method === "GET") {
        sendJson(res, 200, memberStatus());
        return true;
      }
      if (url.pathname === "/api/v1/membership/payment-config" && req.method === "GET") {
        sendJson(res, 200, paymentConfig());
        return true;
      }
      if (url.pathname === "/api/v1/membership/trial" && req.method === "POST") {
        const status = claimTrial();
        sendJson(res, 200, { ok: true, message: "三天免费试用已开通", membership: status });
        return true;
      }
      if (url.pathname === "/api/v1/membership/activate" && req.method === "POST") {
        const body = await readRequestJson(req);
        const status = activate(body.activationCode);
        sendJson(res, 200, { ok: true, message: "激活成功", membership: status });
        return true;
      }
      if (url.pathname === "/api/v1/membership/payment/order" && req.method === "POST") {
        const body = await readRequestJson(req);
        sendJson(res, 200, await createPaymentOrder(body));
        return true;
      }
      const paymentOrderMatch = url.pathname.match(/^\/api\/v1\/membership\/payment\/order\/([A-Za-z0-9_-]+)$/);
      if (paymentOrderMatch && req.method === "GET") {
        sendJson(res, 200, await queryPaymentOrder(paymentOrderMatch[1]));
        return true;
      }
      if (url.pathname === "/api/v1/membership/admin/generate" && req.method === "POST") {
        const body = await readRequestJson(req);
        sendJson(res, 200, createActivation(body));
        return true;
      }
      if (url.pathname === "/api/v1/membership/admin/history" && req.method === "GET") {
        if (edition !== "self") {
          sendJson(res, 403, { ok: false, message: "当前版本没有管理权限。" });
          return true;
        }
        sendJson(res, 200, adminHistory());
        return true;
      }
      return false;
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        ok: false,
        errorCode: error.code || "MEMBERSHIP_ERROR",
        message: error.message || "会员授权处理失败",
      });
      return true;
    }
  }

  return {
    edition,
    claimTrial,
    handleRequest,
    hasAccess,
    memberStatus,
    paymentConfig,
    protectedFeatureForApi,
    protectedFeatureForPath,
    sendPaymentRequired,
  };
}

module.exports = { createMembershipService };
