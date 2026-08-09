(function installMobileApiShim() {
  const originalFetch = globalThis.fetch.bind(globalThis);
  const rootUrl = new URL(globalThis.__A_SHARE_ROOT_URL__ || "../../", document.currentScript?.src || location.href);
  const edition = globalThis.__A_SHARE_EDITION__ === "self" ? "self" : "member";
  const storagePrefix = "a-share-mobile-v1:";
  const deviceSeedKey = `${storagePrefix}device-seed`;
  const licenseKey = `${storagePrefix}license`;
  const clockKey = `${storagePrefix}clock`;
  const activationPrefix = "AFRP1.";
  const plans = {
    month: {label: "月付会员", days: 30, price: 72},
    year: {label: "包年会员", days: 365, price: 699},
    lifetime: {label: "私人订制永久版", days: null, price: 1599, permanent: true},
  };
  let cachedDeviceCode = "";
  let publicKeyPromise = null;
  let stockDirectoryPromise = null;
  const themeDetailCache = new Map();
  const companySurveyCache = new Map();
  const themeDetailCacheMs = 60 * 1000;
  const companySurveyCacheMs = 24 * 60 * 60 * 1000;

  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  function bytesToHex(bytes) {
    return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  function randomSeed() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  }

  function base64UrlBytes(value) {
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(normalized + padding);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function canonicalize(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  async function deviceCode() {
    if (cachedDeviceCode) return cachedDeviceCode;
    let seed = localStorage.getItem(deviceSeedKey);
    if (!seed) {
      seed = randomSeed();
      localStorage.setItem(deviceSeedKey, seed);
    }
    const digest = new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`A股复盘会员设备-v1|${seed}`),
    ));
    const body = bytesToHex(digest).slice(0, 16).toUpperCase();
    cachedDeviceCode = `A5-${body.match(/.{1,4}/g).join("-")}`;
    return cachedDeviceCode;
  }

  function normalizeDeviceCode(value) {
    const compact = String(value || "").toUpperCase().replace(/[^A-F0-9]/g, "");
    const body = compact.startsWith("A5") && compact.length > 16 ? compact.slice(-16) : compact;
    return /^[A-F0-9]{16}$/.test(body) ? `A5-${body.match(/.{1,4}/g).join("-")}` : "";
  }

  async function publicKey() {
    if (publicKeyPromise) return publicKeyPromise;
    publicKeyPromise = (async () => {
      const response = await originalFetch(new URL("data/会员公钥.pem", rootUrl), {cache: "no-store"});
      if (!response.ok) throw new Error("授权公钥缺失，请重新下载手机版");
      const pem = await response.text();
      const der = Uint8Array.from(
        atob(pem.replace(/-----[^-]+-----|\s+/g, "")),
        (character) => character.charCodeAt(0),
      );
      return crypto.subtle.importKey(
        "spki",
        der,
        {name: "RSASSA-PKCS1-v1_5", hash: "SHA-256"},
        false,
        ["verify"],
      );
    })();
    return publicKeyPromise;
  }

  function parseActivationCode(value) {
    const compact = String(value || "").replace(/\s+/g, "");
    if (!compact.startsWith(activationPrefix)) throw new Error("激活码格式不正确");
    try {
      const envelope = JSON.parse(new TextDecoder().decode(base64UrlBytes(compact.slice(activationPrefix.length))));
      if (!envelope?.payload || !envelope?.signature) throw new Error();
      return envelope;
    } catch (_) {
      throw new Error("激活码内容无法识别");
    }
  }

  function parseDate(value) {
    const timestamp = Date.parse(String(value || ""));
    return Number.isFinite(timestamp) ? timestamp : NaN;
  }

  function checkClock() {
    const now = Date.now();
    const maxSeen = parseDate(localStorage.getItem(clockKey));
    if (Number.isFinite(maxSeen) && now + 12 * 60 * 60 * 1000 < maxSeen) {
      return {ok: false, code: "CLOCK_ROLLBACK", reason: "系统时间明显早于上次使用时间，请校准手机日期和时间。"};
    }
    if (!Number.isFinite(maxSeen) || now > maxSeen) localStorage.setItem(clockKey, new Date(now).toISOString());
    return {ok: true};
  }

  async function verifyEnvelope(envelope) {
    const payload = envelope?.payload;
    if (!payload || Number(payload.v) !== 1) return {ok: false, code: "LICENSE_VERSION", reason: "激活码版本不受支持。"};
    const validSignature = await crypto.subtle.verify(
      {name: "RSASSA-PKCS1-v1_5"},
      await publicKey(),
      base64UrlBytes(envelope.signature),
      new TextEncoder().encode(canonicalize(payload)),
    ).catch(() => false);
    if (!validSignature) return {ok: false, code: "BAD_SIGNATURE", reason: "激活码签名校验失败。"};
    if (normalizeDeviceCode(payload.deviceCode) !== await deviceCode()) {
      return {ok: false, code: "DEVICE_MISMATCH", reason: "激活码与当前手机不匹配。"};
    }
    const plan = plans[payload.plan];
    if (!plan) return {ok: false, code: "PLAN_INVALID", reason: "会员套餐无效。"};
    const issuedAt = parseDate(payload.issuedAt);
    const validFrom = parseDate(payload.validFrom);
    const permanent = plan.permanent === true;
    const expiresAt = permanent ? Number.POSITIVE_INFINITY : parseDate(payload.expiresAt);
    const now = Date.now();
    if (![issuedAt, validFrom].every(Number.isFinite)
      || (!permanent && (!Number.isFinite(expiresAt) || expiresAt <= validFrom))) {
      return {ok: false, code: "DATE_INVALID", reason: "激活码有效期无效。"};
    }
    if (permanent && payload.permanent !== true) {
      return {ok: false, code: "PERMANENT_FLAG_MISSING", reason: "私人订制永久版授权标记无效。"};
    }
    if (issuedAt > now + 24 * 60 * 60 * 1000) {
      return {ok: false, code: "ISSUED_IN_FUTURE", reason: "激活码签发时间异常。"};
    }
    if (now < validFrom) {
      return {ok: false, code: "NOT_YET_VALID", reason: `会员将在 ${new Date(validFrom).toLocaleString("zh-CN")} 生效。`};
    }
    if (!permanent && now >= expiresAt) {
      return {ok: false, code: "EXPIRED", reason: "会员已到期，请续费后输入新的激活码。"};
    }
    return {ok: true, payload, plan, permanent, expiresAt};
  }

  async function membershipStatus() {
    const currentDeviceCode = await deviceCode();
    if (edition === "self") {
      return {
        ok: true,
        edition: "self",
        active: true,
        deviceCode: currentDeviceCode,
        plan: "self",
        planLabel: "自用手机版",
        expiresAt: "",
        remainingDays: null,
        canIssueActivation: false,
        reason: "自用手机版全部复盘与量化功能已启用。",
        checkedAt: new Date().toISOString(),
      };
    }
    const clock = checkClock();
    if (!clock.ok) {
      return {
        ok: true,
        edition: "member",
        active: false,
        deviceCode: currentDeviceCode,
        planLabel: "授权不可用",
        statusCode: clock.code,
        reason: clock.reason,
        remainingDays: 0,
        checkedAt: new Date().toISOString(),
      };
    }
    let stored;
    try {
      stored = JSON.parse(localStorage.getItem(licenseKey) || "null");
    } catch (_) {
      stored = null;
    }
    if (!stored?.envelope) {
      return {
        ok: true,
        edition: "member",
        active: false,
        deviceCode: currentDeviceCode,
        planLabel: "未激活",
        statusCode: "NOT_ACTIVATED",
        reason: "当前手机尚未激活会员。",
        remainingDays: 0,
        checkedAt: new Date().toISOString(),
      };
    }
    const verification = await verifyEnvelope(stored.envelope);
    if (!verification.ok) {
      return {
        ok: true,
        edition: "member",
        active: false,
        deviceCode: currentDeviceCode,
        planLabel: "授权不可用",
        plan: stored.envelope?.payload?.plan || "",
        expiresAt: stored.envelope?.payload?.expiresAt || "",
        permanent: stored.envelope?.payload?.permanent === true,
        statusCode: verification.code,
        reason: verification.reason,
        remainingDays: 0,
        checkedAt: new Date().toISOString(),
      };
    }
    const payload = verification.payload;
    return {
      ok: true,
      edition: "member",
      active: true,
      deviceCode: currentDeviceCode,
      licenseId: payload.licenseId,
      plan: payload.plan,
      planLabel: verification.plan.label,
      issuedAt: payload.issuedAt,
      validFrom: payload.validFrom,
      expiresAt: payload.expiresAt,
      permanent: verification.permanent,
      remainingDays: verification.permanent
        ? null
        : Math.max(1, Math.ceil((verification.expiresAt - Date.now()) / 86400000)),
      customer: payload.customer || "",
      reason: verification.permanent ? "私人订制永久版授权有效，仅绑定当前手机。" : "会员授权有效。",
      checkedAt: new Date().toISOString(),
    };
  }

  async function activateMembership(activationCode) {
    if (edition === "self") return membershipStatus();
    const envelope = parseActivationCode(activationCode);
    const verification = await verifyEnvelope(envelope);
    if (!verification.ok) throw new Error(verification.reason);
    let current = null;
    try {
      current = JSON.parse(localStorage.getItem(licenseKey) || "null");
    } catch (_) {
    }
    if (current?.envelope) {
      const currentVerification = await verifyEnvelope(current.envelope);
      if (currentVerification.ok && verification.expiresAt < currentVerification.expiresAt) {
        throw new Error("新激活码的到期时间早于当前有效授权。");
      }
    }
    localStorage.setItem(licenseKey, JSON.stringify({
      envelope,
      activatedAt: new Date().toISOString(),
      deviceCode: await deviceCode(),
    }));
    return membershipStatus();
  }

  async function paymentConfig() {
    let config = {};
    try {
      const response = await originalFetch(new URL("data/会员支付配置.json", rootUrl), {cache: "no-store"});
      if (response.ok) config = await response.json();
    } catch (_) {
    }
    const qr = (path) => ({available: true, url: new URL(path, rootUrl).href});
    return {
      ok: true,
      mode: config.mode || "manual-qrcode",
      plans: Object.entries(plans).map(([key, value]) => ({key, ...value})),
      wechat: qr(config.wechatQr || "assets/payment/微信支付二维码.png"),
      alipay: qr(config.alipayQr || "assets/payment/支付宝支付二维码.png"),
      creatorWechat: qr(config.creatorWechatQr || "assets/payment/创作者微信二维码.png"),
      supportName: config.supportName || "官方客服",
      supportNote: config.supportNote || "付款后发送付款截图和设备码。",
      officialAdapter: {enabled: false, provider: "", pollSeconds: 3},
    };
  }

  async function staticJson(relativePath) {
    const response = await originalFetch(new URL(relativePath, rootUrl), {cache: "no-store"});
    if (!response.ok) return jsonResponse({ok: false, message: "移动端数据文件不存在"}, response.status);
    return response;
  }

  async function stockDirectory() {
    if (!stockDirectoryPromise) {
      stockDirectoryPromise = originalFetch(new URL("data/mobile-stock-directory.json", rootUrl), {cache: "no-store"})
        .then((response) => response.ok ? response.json() : {items: []})
        .catch(() => ({items: []}));
    }
    return stockDirectoryPromise;
  }

  async function searchStocks(query) {
    const normalized = String(query || "").trim().toLowerCase();
    const directory = await stockDirectory();
    const items = (directory.items || []).filter((item) => {
      if (!normalized) return false;
      return String(item.code || "").includes(normalized)
        || String(item.name || "").toLowerCase().includes(normalized)
        || String(item.pinyin || "").toLowerCase().includes(normalized);
    }).slice(0, 30);
    return {
      ok: true,
      query,
      count: items.length,
      items,
      index: {
        ready: true,
        count: Number(directory.count) || (directory.items || []).length,
        source: directory.source || "全A股票名称索引",
        updatedAt: directory.updatedAt || "",
      },
    };
  }

  async function analyzeStock(url) {
    const code = url.searchParams.get("code") || "";
    const name = url.searchParams.get("name") || code;
    const market = url.searchParams.get("market") || "";
    const quote = await globalThis.AShareMobileLive.loadStockQuote(code, market).catch(() => null);
    const unavailable = (label) => ({
      status: "unavailable",
      label: "数据有限",
      stance: "数据有限",
      tone: "watch",
      message: `${label}需要连接在线分析服务，当前移动包仅显示可核验的实时行情。`,
      summary: `${label}暂未生成，不使用不完整数据给出结论。`,
    });
    return {
      ok: true,
      code,
      name,
      market: Number(market) || 0,
      marketLabel: /^(5|6|9)/.test(code) ? "上交所" : /^(4|8|92)/.test(code) ? "北交所" : "深交所",
      fetchedAt: new Date().toLocaleString("zh-CN", {hour12: false}),
      quote,
      profile: {name, intro: ""},
      technical: unavailable("技术面"),
      fundamental: unavailable("基本面"),
      news: {
        ...unavailable("消息面"),
        judgement: {label: "数据有限", tone: "watch", text: "未取得完整公司事件，不做方向判断。"},
        announcements: [],
        items: [],
        policyEvents: [],
      },
      sourceStatus: {
        partial: true,
        errors: ["深度技术面、基本面和公司事件需连接在线分析服务"],
        sources: quote ? ["腾讯实时行情"] : [],
      },
    };
  }

  async function themeAccessResponse() {
    const status = await membershipStatus();
    if (status.active) return null;
    return jsonResponse({
      ok: false,
      errorCode: "MEMBERSHIP_REQUIRED",
      feature: "题材宝典",
      message: "题材宝典需要开通会员后使用。",
      membership: status,
    }, 402);
  }

  async function themeRanking(url, force = false) {
    const fallbackUrl = new URL("data/live-sector-flows.json", rootUrl);
    let snapshot;
    try {
      snapshot = await globalThis.AShareMobileLive.loadLiveSectorFlows({fallbackUrl});
    } catch (error) {
      const fallback = await originalFetch(new URL("data/theme-treasure.json", rootUrl), {cache: "no-store"});
      if (!fallback.ok) throw error;
      snapshot = await fallback.json();
    }
    const model = globalThis.AShareThemeTreasureModel;
    if (!model?.buildThemeRanking) throw new Error("题材排名模型缺失，请重新下载最新版");
    const result = model.buildThemeRanking(snapshot, {
      sort: url.searchParams.get("sort") || "score",
      query: url.searchParams.get("q") || "",
      limit: url.searchParams.get("limit") || 120,
    });
    if (!result.items?.length) throw new Error("题材榜单没有可用的真实行情快照");
    return {...result, refreshed: force};
  }

  async function themeDetail(url) {
    const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
    if (!/^BK\d{4}$/.test(code)) throw new Error("题材代码无效");
    const cached = themeDetailCache.get(code);
    if (cached && Date.now() - cached.savedAt < themeDetailCacheMs) return cached.value;
    const rankingUrl = new URL(url.href);
    rankingUrl.searchParams.set("sort", "score");
    rankingUrl.searchParams.set("limit", "600");
    const ranking = await themeRanking(rankingUrl);
    const theme = ranking.items.find((item) => item.code === code);
    if (!theme) throw new Error("当前题材快照中找不到该题材");
    const constituents = await globalThis.AShareMobileLive.loadBoardConstituents(code);
    const detail = globalThis.AShareThemeTreasureModel.buildThemeDetail(theme, constituents, {
      source: "东方财富概念板块成分股公开行情",
      fetchedAt: new Date().toISOString(),
    });
    themeDetailCache.set(code, {savedAt: Date.now(), value: detail});
    return detail;
  }

  async function themeCompany(url) {
    const themeCode = String(url.searchParams.get("theme") || "").trim().toUpperCase();
    const stockCode = String(url.searchParams.get("stock") || "").replace(/\D/g, "").slice(-6);
    if (!/^BK\d{4}$/.test(themeCode)) throw new Error("题材代码无效");
    if (!/^\d{6}$/.test(stockCode)) throw new Error("股票代码无效");
    const detailUrl = new URL(url.href);
    detailUrl.searchParams.set("code", themeCode);
    const detail = await themeDetail(detailUrl);
    const candidates = [
      ...(Array.isArray(detail.constituents) ? detail.constituents : []),
      ...(Array.isArray(detail.groups) ? detail.groups.flatMap((group) => group.items || []) : []),
    ];
    const stock = candidates.find((item) => String(item?.code || "") === stockCode);
    if (!stock) throw new Error("该股票不在当前题材已核验的成分股中");

    let profile = {};
    let warning = "";
    const cached = companySurveyCache.get(stockCode);
    if (cached && Date.now() - cached.savedAt < companySurveyCacheMs) {
      profile = cached.value;
    } else {
      try {
        profile = await globalThis.AShareMobileLive.loadCompanySurvey(stockCode);
        companySurveyCache.set(stockCode, {savedAt: Date.now(), value: profile});
      } catch (error) {
        warning = `公司F10资料暂未返回：${error.message || String(error)}`;
      }
    }
    return globalThis.AShareThemeTreasureModel.buildCompanyThemeProfile(
      detail.theme,
      stock,
      profile,
      {
        source: "东方财富F10公司资料与概念板块成分股公开行情",
        fetchedAt: new Date().toISOString(),
        warning,
      },
    );
  }

  async function routeFetch(input, init = {}) {
    const requestUrl = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
      location.href,
    );
    const path = requestUrl.pathname;
    const method = String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();

    if (path.endsWith("/api/v1/membership/status")) return jsonResponse(await membershipStatus());
    if (path.endsWith("/api/v1/membership/payment-config")) return jsonResponse(await paymentConfig());
    if (path.endsWith("/api/v1/membership/activate") && method === "POST") {
      try {
        const body = JSON.parse(String(init.body || "{}"));
        return jsonResponse({ok: true, membership: await activateMembership(body.activationCode)});
      } catch (error) {
        return jsonResponse({ok: false, message: error.message || "激活失败"}, 400);
      }
    }

    const moduleMatch = path.match(/\/api\/v1\/data\/([^/]+)$/);
    if (moduleMatch) return staticJson(`data/${moduleMatch[1]}.json`);
    if (path.endsWith("/api/v1/health") || path.endsWith("/health")) {
      const response = await staticJson("data/health.json");
      if (!response.ok) return response;
      const data = await response.json();
      return jsonResponse({...data, ok: true, version: "手机PWA", mode: "mobile"});
    }
    if (path.endsWith("/api/v1/history/dates")) return staticJson("data/history-index.json");
    const historyMatch = path.match(/\/api\/v1\/history\/(\d{4}-\d{2}-\d{2})$/);
    if (historyMatch) return staticJson(`data/history/${historyMatch[1]}.json`);

    if (path.endsWith("/api/v1/index-catalog")) {
      return jsonResponse(globalThis.AShareMobileLive.loadIndexCatalog());
    }
    if (path.endsWith("/api/v1/index-trend")) {
      try {
        return jsonResponse(await globalThis.AShareMobileLive.loadIndexTrend(
          requestUrl.searchParams.get("key"),
          requestUrl.searchParams.get("tradeDate"),
        ));
      } catch (error) {
        return jsonResponse({ok: false, message: error.message || "指数分时暂不可用"}, 502);
      }
    }
    if (path.endsWith("/api/v1/theme-treasure") && method === "GET") {
      const denied = await themeAccessResponse();
      if (denied) return denied;
      try {
        return jsonResponse(await themeRanking(requestUrl));
      } catch (error) {
        return jsonResponse({ok: false, message: error.message || "题材榜单暂不可用"}, 502);
      }
    }
    if (path.endsWith("/api/v1/theme-treasure/company") && method === "GET") {
      const denied = await themeAccessResponse();
      if (denied) return denied;
      try {
        return jsonResponse(await themeCompany(requestUrl));
      } catch (error) {
        return jsonResponse({ok: false, message: error.message || "公司题材简介暂不可用"}, 502);
      }
    }
    if (path.endsWith("/api/v1/theme-treasure/detail") && method === "GET") {
      const denied = await themeAccessResponse();
      if (denied) return denied;
      try {
        return jsonResponse(await themeDetail(requestUrl));
      } catch (error) {
        return jsonResponse({ok: false, message: error.message || "题材解读暂不可用"}, 502);
      }
    }
    if (path.endsWith("/api/v1/theme-treasure/refresh") && method === "POST") {
      const denied = await themeAccessResponse();
      if (denied) return denied;
      try {
        themeDetailCache.clear();
        return jsonResponse(await themeRanking(requestUrl, true));
      } catch (error) {
        return jsonResponse({ok: false, message: error.message || "题材更新失败"}, 502);
      }
    }
    if (path.endsWith("/api/v1/live/sector-flows") || path.endsWith("/api/v1/live/sector-flows/refresh")) {
      try {
        const result = await globalThis.AShareMobileLive.loadLiveSectorFlows({
          fallbackUrl: new URL("data/live-sector-flows.json", rootUrl),
        });
        return jsonResponse(result);
      } catch (error) {
        return jsonResponse({ok: false, message: error.message || "实时板块资金暂不可用"}, 502);
      }
    }
    if (path.endsWith("/api/v1/sector-trend")) {
      try {
        return jsonResponse(await globalThis.AShareMobileLive.loadBoardTrend(
          requestUrl.searchParams.get("code"),
          requestUrl.searchParams.get("name"),
          requestUrl.searchParams.get("tradeDate"),
        ));
      } catch (error) {
        return jsonResponse({ok: false, message: error.message || "板块分时暂不可用"}, 502);
      }
    }
    if (path.endsWith("/api/v1/stocks/search")) {
      return jsonResponse(await searchStocks(requestUrl.searchParams.get("q") || ""));
    }
    if (path.endsWith("/api/v1/stocks/analyze")) {
      return jsonResponse(await analyzeStock(requestUrl));
    }
    if (path.endsWith("/api/v1/app-update/status") || path.endsWith("/api/v1/app-update/check")) {
      return jsonResponse({
        ok: true,
        supported: false,
        currentVersion: "手机版",
        phase: "idle",
        message: "手机版由浏览器自动更新页面资源。",
      });
    }
    if (path.endsWith("/api/v1/app-update/install")) {
      return jsonResponse({ok: false, supported: false, message: "手机版由浏览器自动更新页面资源。"}, 409);
    }

    if (path.endsWith("/status") || path.endsWith("/api/v1/status")) {
      return jsonResponse({
        ok: true,
        running: false,
        version: "手机PWA",
        lastResult: {ok: true, message: "已读取发布端最新快照"},
        progress: {stage: "done", message: "移动端数据检查完成", percent: 100},
      });
    }
    if ((path.endsWith("/api/v1/sync") || path.endsWith("/refresh")) && method === "POST") {
      return jsonResponse({
        ok: true,
        accepted: true,
        running: false,
        message: "正在读取公开行情和发布端最新快照",
        progress: {stage: "done", message: "移动端数据检查完成", percent: 100},
      });
    }
    if (["/policy-refresh", "/next-week-events-refresh", "/derivatives-refresh", "/quant-refresh", "/api/v1/index-contribution/refresh"]
      .some((suffix) => path.endsWith(suffix))) {
      return jsonResponse({ok: true, running: false, message: "已读取发布端最新数据"});
    }

    return originalFetch(input, init);
  }

  globalThis.fetch = routeFetch;
  globalThis.AShareMobileMembership = {status: membershipStatus, activate: activateMembership};
})();
