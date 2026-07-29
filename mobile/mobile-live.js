(function installMobileLiveData() {
  const JSONP_TIMEOUT_MS = 12000;
  const EASTMONEY_TOKEN = "bd1d9ddb04089700cf9c27f6f7426281";
  const INDEX_DEFINITIONS = [
    {key: "sh000001", code: "000001", symbol: "sh000001", name: "上证指数"},
    {key: "sz399001", code: "399001", symbol: "sz399001", name: "深证成指"},
    {key: "sz399006", code: "399006", symbol: "sz399006", name: "创业板指"},
    {key: "sh000688", code: "000688", symbol: "sh000688", name: "科创50"},
    {key: "sh000300", code: "000300", symbol: "sh000300", name: "沪深300"},
    {key: "sh000905", code: "000905", symbol: "sh000905", name: "中证500"},
    {key: "bj899050", code: "899050", symbol: "bj899050", name: "北证50"},
  ];

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function round(value, digits = 4) {
    const factor = 10 ** digits;
    return Math.round(Number(value) * factor) / factor;
  }

  function pad2(value) {
    return String(value).padStart(2, "0");
  }

  function shanghaiParts(date = new Date()) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const values = {};
    formatter.formatToParts(date).forEach((part) => {
      if (part.type !== "literal") values[part.type] = Number(part.value);
    });
    const day = new Date(Date.UTC(values.year, values.month - 1, values.day)).getUTCDay();
    return {...values, day};
  }

  function dateText(parts) {
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  }

  function timeText(parts) {
    return `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
  }

  function marketMinute(parts) {
    const minuteOfDay = parts.hour * 60 + parts.minute + parts.second / 60;
    if (minuteOfDay < 570) return 0;
    if (minuteOfDay <= 690) return Math.max(0, minuteOfDay - 570);
    if (minuteOfDay < 780) return 120;
    return Math.min(240, 120 + minuteOfDay - 780);
  }

  function marketPhase(parts) {
    if (parts.day === 0 || parts.day === 6) return "周末休市";
    const minute = parts.hour * 60 + parts.minute;
    if (minute < 570) return "开盘前";
    if (minute <= 690) return "上午交易";
    if (minute < 780) return "午间休市";
    if (minute <= 900) return "下午交易";
    return "已收盘";
  }

  function isTrading(parts) {
    const minute = parts.hour * 60 + parts.minute;
    return parts.day > 0 && parts.day < 6
      && ((minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900));
  }

  function timestampFromCompactText(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length < 12) return null;
    const timestamp = Date.parse(
      `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
      + `T${digits.slice(8, 10)}:${digits.slice(10, 12)}:${digits.slice(12, 14) || "00"}+08:00`,
    );
    return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
  }

  function jsonp(rawUrl, timeoutMs = JSONP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const callback = `__aShareMobileJsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const url = new URL(rawUrl);
      url.searchParams.set("cb", callback);
      const script = document.createElement("script");
      let settled = false;
      const cleanup = () => {
        delete globalThis[callback];
        script.remove();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error("公开行情接口读取超时"));
      }, timeoutMs);
      globalThis[callback] = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(payload);
      };
      script.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error("公开行情脚本加载失败"));
      };
      script.src = url.href;
      script.async = true;
      document.head.append(script);
    });
  }

  function loadExternalScript(url, timeoutMs = JSONP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const timer = setTimeout(() => {
        script.remove();
        reject(new Error("实时行情读取超时"));
      }, timeoutMs);
      script.onload = () => {
        clearTimeout(timer);
        script.remove();
        resolve();
      };
      script.onerror = () => {
        clearTimeout(timer);
        script.remove();
        reject(new Error("实时行情脚本加载失败"));
      };
      script.src = url;
      script.async = true;
      document.head.append(script);
    });
  }

  function normalizeBoardRows(diff, group) {
    const rows = [];
    for (const raw of Array.isArray(diff) ? diff : []) {
      const code = String(raw?.f12 || "").trim().toUpperCase();
      const name = String(raw?.f14 || "").trim();
      const amountYuan = finite(raw?.f62);
      if (!/^BK\d{4}$/.test(code) || !name || amountYuan === null) continue;
      rows.push({
        code,
        name,
        amount: round(amountYuan / 100000000),
        amountYuan: Math.round(amountYuan),
        changePct: finite(raw?.f3),
        sourceTimestamp: finite(raw?.f124),
      });
    }
    const minimum = group === "concept" ? 350 : 90;
    if (rows.length < minimum) {
      throw new Error(`${group === "concept" ? "概念" : "行业"}板块只返回${rows.length}行，未通过完整性校验`);
    }
    return rows;
  }

  async function loadBoardGroup(group) {
    const fsCode = group === "concept" ? "m:90+t:3" : "m:90+s:4";
    const url = new URL("https://push2.eastmoney.com/api/qt/clist/get");
    Object.entries({
      pn: "1",
      pz: "500",
      po: "1",
      np: "1",
      fltt: "2",
      invt: "2",
      fid: "f62",
      fs: fsCode,
      fields: "f12,f14,f3,f62,f124",
      ut: EASTMONEY_TOKEN,
      _: String(Date.now()),
    }).forEach(([key, value]) => url.searchParams.set(key, value));
    const payload = await jsonp(url);
    return normalizeBoardRows(payload?.data?.diff, group);
  }

  async function loadIndexQuotes() {
    const symbols = INDEX_DEFINITIONS.map((item) => item.symbol).join(",");
    await loadExternalScript(`https://qt.gtimg.cn/q=${encodeURIComponent(symbols)}&_=${Date.now()}`);
    const rows = [];
    for (const definition of INDEX_DEFINITIONS) {
      const raw = String(globalThis[`v_${definition.symbol}`] || "");
      const fields = raw.split("~");
      const price = finite(fields[3]);
      const preClose = finite(fields[4]);
      const sourceTimestamp = timestampFromCompactText(fields[30]);
      if (price === null || preClose === null || price <= 0 || preClose <= 0 || sourceTimestamp === null) continue;
      const parts = shanghaiParts(new Date(sourceTimestamp * 1000));
      rows.push({
        ...definition,
        price,
        preClose,
        change: finite(fields[31]) ?? round(price - preClose),
        changePct: finite(fields[32]) ?? round(((price - preClose) / preClose) * 100),
        amount: finite(fields[37]) === null ? null : Math.round(Number(fields[37]) * 10000),
        sourceTimestamp,
        minute: marketMinute(parts),
        source: "腾讯指数实时行情",
      });
      try {
        delete globalThis[`v_${definition.symbol}`];
      } catch (_) {
      }
    }
    return rows;
  }

  async function loadLiveSectorFlows(options = {}) {
    try {
      const [industryRows, conceptRows, indices] = await Promise.all([
        loadBoardGroup("industry"),
        loadBoardGroup("concept"),
        loadIndexQuotes().catch(() => []),
      ]);
      const sourceTimestamps = [...industryRows, ...conceptRows]
        .map((row) => finite(row.sourceTimestamp))
        .filter((value) => value && value > 1000000000);
      const sourceTimestamp = sourceTimestamps.length
        ? Math.max(...sourceTimestamps)
        : Math.floor(Date.now() / 1000);
      const sourceDate = new Date(sourceTimestamp * 1000);
      const parts = shanghaiParts(sourceDate);
      return {
        ok: true,
        active: isTrading(parts),
        marketPhase: marketPhase(parts),
        tradeDate: dateText(parts),
        sequence: Date.now(),
        fetchedAt: new Date().toISOString(),
        sourceTimestamp,
        sourceTime: timeText(parts),
        marketMinute: marketMinute(parts),
        sourceLatencyMs: Math.max(0, Date.now() - sourceTimestamp * 1000),
        groupTimestampSkewMs: 0,
        consecutiveErrors: 0,
        source: "东方财富板块资金与腾讯指数公开行情",
        methodology: "仅采用公开接口返回的真实快照；完整性不足时不覆盖上一份已验证数据。",
        groups: {
          industry: {key: "industry", title: "二级行业板块", rows: industryRows},
          concept: {key: "concept", title: "概念板块", rows: conceptRows},
        },
        indices,
      };
    } catch (error) {
      if (!options.fallbackUrl) throw error;
      const response = await fetch(options.fallbackUrl, {cache: "no-store"});
      if (!response.ok) throw error;
      const fallback = await response.json();
      return {
        ...fallback,
        active: false,
        marketPhase: fallback.marketPhase || "已验证快照",
        warning: error.message || String(error),
      };
    }
  }

  function minuteFromTime(value) {
    const match = String(value || "").match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const parts = {hour: Number(match[1]), minute: Number(match[2]), second: Number(match[3] || 0)};
    const raw = parts.hour * 60 + parts.minute + parts.second / 60;
    if (raw < 570 || raw > 900 || (raw > 690 && raw < 780)) return null;
    return raw <= 690 ? raw - 570 : 120 + raw - 780;
  }

  async function loadBoardTrend(code, name = "", requestedTradeDate = "") {
    const normalizedCode = String(code || "").trim().toUpperCase();
    if (!/^BK\d{4}$/.test(normalizedCode)) throw new Error("板块代码无效");
    const detailsUrl = new URL("https://push2.eastmoney.com/api/qt/stock/details/get");
    Object.entries({
      secid: `90.${normalizedCode}`,
      fields1: "f1,f2,f3,f4,f5",
      fields2: "f51,f52,f53,f54,f55",
      pos: "-10000",
      ut: EASTMONEY_TOKEN,
      _: String(Date.now()),
    }).forEach(([key, value]) => detailsUrl.searchParams.set(key, value));
    const quoteUrl = new URL("https://push2.eastmoney.com/api/qt/stock/get");
    Object.entries({
      secid: `90.${normalizedCode}`,
      fields: "f57,f58,f60,f86",
      ut: EASTMONEY_TOKEN,
      _: String(Date.now()),
    }).forEach(([key, value]) => quoteUrl.searchParams.set(key, value));
    const [payload, quote] = await Promise.all([jsonp(detailsUrl), jsonp(quoteUrl)]);
    const preClose = finite(payload?.data?.prePrice);
    const timestamp = finite(quote?.data?.f86);
    const sourceTradeDate = timestamp
      ? dateText(shanghaiParts(new Date(timestamp * 1000)))
      : requestedTradeDate;
    if (requestedTradeDate && sourceTradeDate && requestedTradeDate !== sourceTradeDate) {
      throw new Error(`公开行情最新交易日为${sourceTradeDate}，当前页面为${requestedTradeDate}`);
    }
    if (!preClose || !Array.isArray(payload?.data?.details)) throw new Error("板块指数分时没有返回有效样本");
    const points = payload.data.details.map((raw) => {
      const fields = String(raw || "").split(",");
      const minute = minuteFromTime(fields[0]);
      const price = finite(fields[1]);
      if (minute === null || price === null || price <= 0) return null;
      return {
        tradeDate: sourceTradeDate,
        minute: round(minute),
        time: String(fields[0] || ""),
        price: round(price),
        changePct: round(((price - preClose) / preClose) * 100),
        volume: finite(fields[2]),
        source: "东方财富板块指数逐笔分时",
      };
    }).filter(Boolean);
    if (!points.length) throw new Error("板块指数分时没有返回交易时段样本");
    return {
      ok: true,
      code: normalizedCode,
      name: name || quote?.data?.f58 || normalizedCode,
      tradeDate: sourceTradeDate,
      preClose: round(preClose),
      points,
      source: "东方财富板块指数逐笔分时",
      fetchedAt: new Date().toISOString(),
    };
  }

  function quoteSymbol(code, market) {
    const normalized = String(code || "").replace(/\D/g, "").slice(-6);
    if (!/^\d{6}$/.test(normalized)) return "";
    if (/^(4|8|92)/.test(normalized)) return `bj${normalized}`;
    if (String(market) === "1" || /^(5|6|9)/.test(normalized)) return `sh${normalized}`;
    return `sz${normalized}`;
  }

  async function loadStockQuote(code, market) {
    const symbol = quoteSymbol(code, market);
    if (!symbol) throw new Error("股票代码无效");
    await loadExternalScript(`https://qt.gtimg.cn/q=${symbol}&_=${Date.now()}`);
    const raw = String(globalThis[`v_${symbol}`] || "");
    const fields = raw.split("~");
    const price = finite(fields[3]);
    const previousClose = finite(fields[4]);
    if (price === null || previousClose === null) throw new Error("实时行情暂不可用");
    const sourceTimestamp = timestampFromCompactText(fields[30]);
    const date = sourceTimestamp ? dateText(shanghaiParts(new Date(sourceTimestamp * 1000))) : "";
    try {
      delete globalThis[`v_${symbol}`];
    } catch (_) {
    }
    return {
      price,
      previousClose,
      open: finite(fields[5]),
      volume: finite(fields[6]),
      high: finite(fields[33]),
      low: finite(fields[34]),
      change: finite(fields[31]) ?? round(price - previousClose),
      changePct: finite(fields[32]) ?? round(((price - previousClose) / previousClose) * 100),
      turnoverRate: finite(fields[38]),
      pe: finite(fields[39]),
      amount: finite(fields[37]) === null ? null : Math.round(Number(fields[37]) * 10000),
      date,
      source: "腾讯实时行情",
    };
  }

  function dailyKSecid(target = {}) {
    const boardCode = String(target.boardCode || "").trim().toUpperCase();
    const code = String(target.code || "").trim().toUpperCase();
    const market = String(target.market ?? "").trim().toLowerCase();
    const exactBoardCode = /^BK\d{4}$/.test(boardCode)
      ? boardCode
      : (/^BK\d{4}$/.test(code) ? code : "");
    if (market === "sector" || exactBoardCode || /^880\d{3}$/.test(code)) {
      if (!exactBoardCode) throw new Error("该板块缺少可核验的公开行情代码");
      return `90.${exactBoardCode}`;
    }
    if (!/^\d{6}$/.test(code)) throw new Error("股票代码无效");
    if (String(target.market) === "1" || /^(5|6|9)/.test(code)) return `1.${code}`;
    return `0.${code}`;
  }

  async function loadDailyK(target = {}) {
    const secid = dailyKSecid(target);
    const url = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
    Object.entries({
      secid,
      fields1: "f1,f2,f3,f4,f5,f6",
      fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
      klt: "101",
      fqt: "1",
      beg: "0",
      end: "20500101",
      lmt: String(Math.max(30, Math.min(240, Number(target.limit) || 160))),
      ut: EASTMONEY_TOKEN,
      _: String(Date.now()),
    }).forEach(([key, value]) => url.searchParams.set(key, value));
    const payload = await jsonp(url);
    const rows = Array.isArray(payload?.data?.klines) ? payload.data.klines : [];
    const items = rows.map((raw) => {
      const fields = String(raw || "").split(",");
      const open = finite(fields[1]);
      const close = finite(fields[2]);
      const high = finite(fields[3]);
      const low = finite(fields[4]);
      if (!fields[0] || [open, close, high, low].some((value) => value === null)) return null;
      return {
        date: fields[0],
        open,
        close,
        high,
        low,
        volume: finite(fields[5]),
        amount: finite(fields[6]),
        amplitude: finite(fields[7]),
        changePct: finite(fields[8]),
        change: finite(fields[9]),
        turnoverRate: finite(fields[10]),
      };
    }).filter(Boolean);
    if (items.length < 2) throw new Error("公开行情接口没有返回足够的真实日K样本");
    return {
      ok: true,
      code: String(payload?.data?.code || target.code || target.boardCode || ""),
      name: String(payload?.data?.name || target.name || ""),
      secid,
      items,
      source: "公开行情接口复权日K",
      fetchedAt: new Date().toISOString(),
    };
  }

  globalThis.AShareMobileLive = {
    loadLiveSectorFlows,
    loadBoardTrend,
    loadStockQuote,
    loadDailyK,
  };
})();
