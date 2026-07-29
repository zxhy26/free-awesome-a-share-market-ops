(function installMobileTradingApp(root) {
  const STORAGE_KEY = "a-share-review:trading-app:v1";
  const APP_PROFILES = [
    {id: "eastmoney", name: "东方财富"},
    {id: "tonghuashun", name: "同花顺"},
    {id: "xueqiu", name: "雪球"},
    {id: "tongdaxin", name: "通达信"},
  ];

  function clean(value) {
    return String(value ?? "").trim();
  }

  function normalizeTarget(stock = {}) {
    const rawCode = clean(stock.code || stock.boardCode).toUpperCase();
    const market = clean(stock.market).toLowerCase();
    const isSector = market === "sector" || /^(?:880\d{3}|BK\d{4})$/.test(rawCode);
    const code = isSector ? rawCode : rawCode.replace(/\D/g, "");
    const name = clean(stock.name);
    if (!isSector && !/^\d{6}$/.test(code)) {
      throw new Error("股票代码无效，无法调用交易软件。");
    }
    if (isSector && !code && !name) {
      throw new Error("板块代码和名称均为空。");
    }
    const exchange = /^(?:5|6|9)/.test(code)
      ? "SH"
      : /^(?:4|8|92)/.test(code)
        ? "BJ"
        : "SZ";
    return {
      code,
      name,
      market: isSector ? "sector" : "stock",
      isSector,
      exchange,
      symbol: code ? `${exchange}${code}` : "",
      query: isSector ? (name || code) : code,
    };
  }

  function platformName(userAgent = root.navigator?.userAgent || "") {
    return /iPad|iPhone|iPod/i.test(userAgent) ? "ios" : "android";
  }

  function buildDeepLink(profileId, target, platform = platformName()) {
    const query = encodeURIComponent(target.query);
    if (profileId === "eastmoney") {
      if (target.isSector) {
        return platform === "ios"
          ? `eastmoney://page/search/keyword=${query}`
          : `dfcft://search?keyword=${query}`;
      }
      const token = `${target.exchange}|${target.code}`;
      return platform === "ios"
        ? `eastmoney://page/geguxiangqing/stockcode=${token}`
        : `dfcft://stock?stockcode=${token}`;
    }
    if (profileId === "tonghuashun") {
      return target.isSector
        ? `amihexin://search?keyword=${query}`
        : `amihexin://stock/detail?code=${encodeURIComponent(target.code)}`;
    }
    if (profileId === "xueqiu") {
      return target.isSector
        ? `xueqiu://search?keyword=${query}`
        : `xueqiu://stock/${encodeURIComponent(target.symbol)}`;
    }
    if (profileId === "tongdaxin") {
      return target.isSector
        ? `tdx://search?keyword=${query}`
        : `tdx://stock?code=${encodeURIComponent(target.code)}`;
    }
    return "";
  }

  function readPreference() {
    try {
      const id = root.localStorage?.getItem(STORAGE_KEY) || "";
      return APP_PROFILES.some((profile) => profile.id === id) ? id : "";
    } catch (_) {
      return "";
    }
  }

  function writePreference(id) {
    try {
      root.localStorage?.setItem(STORAGE_KEY, id);
    } catch (_) {
    }
  }

  async function copyQuery(target) {
    const value = target.query;
    if (!value) return;
    try {
      await root.navigator?.clipboard?.writeText(value);
      return;
    } catch (_) {
    }
    const document = root.document;
    if (!document?.body) return;
    const input = document.createElement("textarea");
    input.value = value;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    try {
      document.execCommand("copy");
    } catch (_) {
    }
    input.remove();
  }

  function profileById(id) {
    return APP_PROFILES.find((profile) => profile.id === id) || null;
  }

  function ensurePicker() {
    const document = root.document;
    if (!document?.body) return null;
    let picker = document.querySelector("[data-trading-app-picker]");
    if (picker) return picker;
    picker = document.createElement("div");
    picker.className = "trading-app-picker";
    picker.dataset.tradingAppPicker = "true";
    picker.hidden = true;
    picker.innerHTML = `
      <div class="trading-app-picker__dialog" role="dialog" aria-modal="true" aria-labelledby="tradingAppPickerTitle">
        <div class="trading-app-picker__head">
          <strong id="tradingAppPickerTitle">选择当前设备交易软件</strong>
          <button type="button" class="trading-app-picker__close" data-trading-app-close aria-label="关闭">×</button>
        </div>
        <p class="trading-app-picker__target" data-trading-app-target></p>
        <p class="trading-app-picker__status" data-trading-app-status>首次选择后，本设备将自动使用该软件。</p>
        <div class="trading-app-picker__actions">
          ${APP_PROFILES.map((profile) => `<button type="button" data-trading-app="${profile.id}">${profile.name}</button>`).join("")}
        </div>
      </div>`;
    document.body.appendChild(picker);
    return picker;
  }

  function chooseProfile(target, status = "") {
    const picker = ensurePicker();
    if (!picker) return Promise.reject(new Error("当前页面无法显示交易软件选择器。"));
    picker.querySelector("[data-trading-app-target]").textContent =
      `${target.isSector ? "板块" : "股票"}：${target.name || target.query} ${target.code || ""}`.trim();
    picker.querySelector("[data-trading-app-status]").textContent =
      status || "首次选择后，本设备将自动使用该软件。";
    picker.hidden = false;
    return new Promise((resolve, reject) => {
      const finish = (handler, value) => {
        picker.hidden = true;
        picker.removeEventListener("click", onClick);
        handler(value);
      };
      const onClick = (event) => {
        const appButton = event.target.closest("[data-trading-app]");
        if (appButton) {
          finish(resolve, appButton.dataset.tradingApp);
          return;
        }
        if (event.target.closest("[data-trading-app-close]") || event.target === picker) {
          finish(reject, new Error("已取消打开交易软件。"));
        }
      };
      picker.addEventListener("click", onClick);
    });
  }

  function launchAndDetect(profile, target) {
    const link = buildDeepLink(profile.id, target);
    if (!link) return Promise.reject(new Error(`${profile.name}缺少可用跳转协议。`));
    copyQuery(target);
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        root.document?.removeEventListener("visibilitychange", onVisibility);
        root.removeEventListener?.("pagehide", onPageHide);
        root.clearTimeout(timer);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        writePreference(profile.id);
        resolve({
          ok: true,
          mode: "mobileTradingApp",
          localApp: profile.name,
          query: target.query,
          targetUrlExact: !target.isSector,
          verifiedTarget: false,
          message: `已调用当前设备的${profile.name}打开${target.name || target.query}。`,
        });
      };
      const onVisibility = () => {
        if (root.document?.hidden) succeed();
      };
      const onPageHide = () => succeed();
      const timer = root.setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`未检测到可响应的${profile.name}，目标代码已复制。`));
      }, 1800);
      root.document?.addEventListener("visibilitychange", onVisibility);
      root.addEventListener?.("pagehide", onPageHide, {once: true});
      try {
        root.location.href = link;
      } catch (error) {
        settled = true;
        cleanup();
        reject(new Error(`${profile.name}跳转失败：${error.message}`));
      }
    });
  }

  async function open(stock = {}) {
    const target = normalizeTarget(stock);
    let preferred = readPreference();
    if (preferred) {
      const profile = profileById(preferred);
      try {
        return await launchAndDetect(profile, target);
      } catch (error) {
        preferred = await chooseProfile(target, error.message);
      }
    } else {
      preferred = await chooseProfile(target);
    }
    return launchAndDetect(profileById(preferred), target);
  }

  const api = {
    open,
    getPreference: readPreference,
    resetPreference() {
      try {
        root.localStorage?.removeItem(STORAGE_KEY);
      } catch (_) {
      }
    },
  };
  root.AShareTradingApp = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {APP_PROFILES, buildDeepLink, normalizeTarget, platformName};
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
