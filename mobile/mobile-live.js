(function installMobileLiveData() {
  const JSONP_TIMEOUT_MS = 12000;
  const EASTMONEY_TOKEN = "bd1d9ddb04089700cf9c27f6f7426281";
  const BOARD_PAGE_SIZE = 100;
  const MAX_BOARD_PAGES = 10;
  const CONSTITUENT_PAGE_SIZE = 100;
  const MAX_CONSTITUENT_PAGES = 60;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const INDEX_DEFINITIONS = [
    {key: "sh000001", name: "上证指数", code: "000001", symbol: "sh000001", group: "shanghai"},
    {key: "sh000016", name: "上证50", code: "000016", symbol: "sh000016", group: "shanghai"},
    {key: "sh000010", name: "上证180", code: "000010", symbol: "sh000010", group: "shanghai"},
    {key: "sh000688", name: "科创50", code: "000688", symbol: "sh000688", group: "shanghai"},
    {key: "sh000698", name: "科创100", code: "000698", symbol: "sh000698", group: "shanghai"},
    {key: "sz399001", name: "深证成指", code: "399001", symbol: "sz399001", group: "shenzhen"},
    {key: "sz399330", name: "深证100", code: "399330", symbol: "sz399330", group: "shenzhen"},
    {key: "sz399006", name: "创业板指", code: "399006", symbol: "sz399006", group: "shenzhen"},
    {key: "sz399673", name: "创业板50", code: "399673", symbol: "sz399673", group: "shenzhen"},
    {key: "sz399303", name: "国证2000", code: "399303", symbol: "sz399303", group: "shenzhen"},
    {key: "sh000300", name: "沪深300", code: "000300", symbol: "sh000300", group: "csi"},
    {key: "sh000903", name: "中证A100", code: "000903", symbol: "sh000903", group: "csi"},
    {key: "sh000905", name: "中证500", code: "000905", symbol: "sh000905", group: "csi"},
    {key: "sh000906", name: "中证800", code: "000906", symbol: "sh000906", group: "csi"},
    {key: "sh000852", name: "中证1000", code: "000852", symbol: "sh000852", group: "csi"},
    {key: "sh000985", name: "中证全指", code: "000985", symbol: "sh000985", group: "csi"},
    {key: "sh000510", name: "中证A500", code: "000510", symbol: "sh000510", group: "csi"},
    {key: "bj899050", name: "北证50", code: "899050", symbol: "bj899050", group: "beijing"},
    {key: "usIXIC", name: "纳斯达克", code: "IXIC", symbol: "usIXIC", group: "overseas", session: "us"},
  ];
  const DEFAULT_INDEX_KEYS = [
    "sh000001",
    "sz399001",
    "sz399006",
    "sh000688",
    "sh000300",
    "sh000905",
    "bj899050",
    "usIXIC",
  ];
  const INDEX_BY_KEY = new Map(INDEX_DEFINITIONS.map((item) => [item.key.toLowerCase(), item]));

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

  function regularMarketMinute(time) {
    const match = String(time || "").match(/^(\d{2}):(\d{2})/);
    if (!match) return null;
    const total = Number(match[1]) * 60 + Number(match[2]);
    if (total < 570 || total > 900 || (total > 690 && total < 780)) return null;
    return total <= 690 ? total - 570 : 120 + total - 780;
  }

  function indexMinute(time, definition) {
    if (definition.session !== "us") return regularMarketMinute(time);
    const match = String(time || "").match(/^(\d{2}):(\d{2})/);
    if (!match) return null;
    const elapsed = Number(match[1]) * 60 + Number(match[2]) - 570;
    if (elapsed < 0 || elapsed > 390) return null;
    return round((elapsed / 390) * 240, 4);
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

  function parseTencentIndexPayload(payload, definition) {
    const block = payload?.data?.[definition.symbol]?.data || {};
    const rows = Array.isArray(block.data) ? block.data : [];
    const quote = payload?.data?.[definition.symbol]?.qt?.[definition.symbol] || [];
    const rawDate = String(block.date || "");
    const quoteDate = String(quote[30] || "");
    const tradeDate = /^\d{8}$/.test(rawDate)
      ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
      : quoteDate.slice(0, 10);
    const firstRow = String(rows[0] || "").trim().split(/\s+/);
    const preClose = finite(quote[4]) ?? finite(firstRow[1]);
    if (!rows.length || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || preClose === null || preClose <= 0) {
      throw new Error(`${definition.name}分时没有返回有效数据`);
    }
    const byMinute = new Map();
    for (const row of rows) {
      const fields = String(row || "").trim().split(/\s+/);
      const compactTime = String(fields[0] || "");
      if (!/^\d{4}$/.test(compactTime)) continue;
      const shortTime = `${compactTime.slice(0, 2)}:${compactTime.slice(2, 4)}`;
      const minute = indexMinute(shortTime, definition);
      const price = finite(fields[1]);
      if (minute === null || price === null || price <= 0) continue;
      byMinute.set(minute, {
        dateTime: `${tradeDate} ${shortTime}`,
        tradeDate,
        time: `${shortTime}:00`,
        minute,
        price: round(price),
        volume: finite(fields[2]) ?? 0,
        amount: finite(fields[3]),
        source: "tencent-index-minute",
      });
    }
    const points = [...byMinute.values()].sort((left, right) => left.minute - right.minute);
    if (!points.length) throw new Error(`${definition.name}分时没有交易时段样本`);
    return {
      key: definition.key,
      name: definition.name,
      code: definition.code,
      group: definition.group,
      session: definition.session || "cn",
      preClose: round(preClose),
      tradeDate,
      points,
      latestMinute: points.at(-1).minute,
      latestPrice: points.at(-1).price,
    };
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
        upCount: finite(raw?.f104),
        downCount: finite(raw?.f105),
        leaderName: String(raw?.f128 || "").trim(),
        leaderCode: String(raw?.f140 || "").trim(),
        leaderMarket: finite(raw?.f141),
        leaderChangePct: finite(raw?.f136),
        sourceTimestamp: finite(raw?.f124),
      });
    }
    return rows;
  }

  async function loadBoardGroupPage(group, pageNumber, preferredHost = "") {
    const fsCode = group === "concept" ? "m:90+t:3" : "m:90+s:4";
    const hosts = ["https://push2.eastmoney.com", "https://push2delay.eastmoney.com"];
    const orderedHosts = preferredHost
      ? [preferredHost, ...hosts.filter((host) => host !== preferredHost)]
      : hosts;
    const errors = [];
    for (const host of orderedHosts) {
      const url = new URL("/api/qt/clist/get", host);
      Object.entries({
        pn: String(pageNumber),
        pz: String(BOARD_PAGE_SIZE),
        po: "1",
        np: "1",
        fltt: "2",
        invt: "2",
        fid: "f62",
        fs: fsCode,
        fields: "f12,f14,f3,f62,f104,f105,f128,f136,f140,f141,f124",
        ut: EASTMONEY_TOKEN,
        _: String(Date.now()),
      }).forEach(([key, value]) => url.searchParams.set(key, value));
      try {
        const payload = await jsonp(url);
        const rows = normalizeBoardRows(payload?.data?.diff, group);
        if (!rows.length) throw new Error("返回空页");
        return {host, payload, rows};
      } catch (error) {
        errors.push(`${host}: 第${pageNumber}页${error.message || String(error)}`);
      }
    }
    throw new Error(errors.join("；"));
  }

  async function loadBoardGroup(group) {
    const firstPage = await loadBoardGroupPage(group, 1);
    const reportedRows = Math.max(0, Math.trunc(finite(firstPage.payload?.data?.total) || 0));
    const pageCount = Math.max(1, Math.ceil(reportedRows / BOARD_PAGE_SIZE));
    const minimum = group === "concept" ? 400 : 100;
    if (reportedRows < minimum || pageCount > MAX_BOARD_PAGES) {
      throw new Error(`${group === "concept" ? "概念" : "行业"}板块公开总数${reportedRows || "未知"}，无法完整读取`);
    }
    const remaining = await Promise.all(
      Array.from({length: pageCount - 1}, (_, index) => loadBoardGroupPage(group, index + 2, firstPage.host)),
    );
    const rows = [...new Map(
      [firstPage, ...remaining].flatMap((page) => page.rows).map((row) => [row.code, row]),
    ).values()];
    if (rows.length !== reportedRows) {
      throw new Error(`${group === "concept" ? "概念" : "行业"}板块完整分页后为${rows.length}/${reportedRows}行，拒绝使用不完整目录`);
    }
    Object.defineProperties(rows, {
      reportedRows: {value: reportedRows, enumerable: false},
      pageCount: {value: pageCount, enumerable: false},
      coveragePct: {value: 100, enumerable: false},
    });
    return rows;
  }

  async function loadIndexQuotes() {
    const domesticDefinitions = INDEX_DEFINITIONS.filter((item) => item.session !== "us");
    const symbols = domesticDefinitions.map((item) => item.symbol).join(",");
    await loadExternalScript(`https://qt.gtimg.cn/q=${encodeURIComponent(symbols)}&_=${Date.now()}`);
    const rows = [];
    for (const definition of domesticDefinitions) {
      const raw = String(globalThis[`v_${definition.symbol}`] || "");
      const fields = raw.split("~");
      const price = finite(fields[3]);
      const preClose = finite(fields[4]);
      const sourceTimestamp = timestampFromCompactText(fields[30]);
      if (price === null || preClose === null || price <= 0 || preClose <= 0 || sourceTimestamp === null) continue;
      const parts = shanghaiParts(new Date(sourceTimestamp * 1000));
      rows.push({
        ...definition,
        session: definition.session || "cn",
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

  function loadIndexCatalog() {
    return {
      ok: true,
      maxSelected: 8,
      defaultSelected: [...DEFAULT_INDEX_KEYS],
      items: INDEX_DEFINITIONS.map(({key, name, code, group, session = "cn"}) => ({
        key,
        name,
        code,
        group,
        session,
        selectedByDefault: DEFAULT_INDEX_KEYS.includes(key),
      })),
    };
  }

  async function loadIndexTrend(key, requestedTradeDate = "") {
    const definition = INDEX_BY_KEY.get(String(key || "").trim().toLowerCase());
    if (!definition) throw new Error("指数选项无效");
    const endpoint = definition.session === "us" ? "usMinute" : "minute";
    const url = new URL(`https://web.ifzq.gtimg.cn/appstock/${"app"}/${endpoint}/query`);
    url.searchParams.set("code", definition.symbol);
    url.searchParams.set("_", String(Date.now()));
    const response = await nativeFetch(url, {
      cache: "no-store",
      headers: {Accept: "application/json,text/plain,*/*"},
    });
    if (!response.ok) throw new Error(`${definition.name}分时读取失败（${response.status}）`);
    const timeline = parseTencentIndexPayload(await response.json(), definition);
    const dateMismatch = Boolean(
      requestedTradeDate
      && timeline.tradeDate !== requestedTradeDate
      && definition.session !== "us"
    );
    return {
      ok: true,
      ...timeline,
      source: "腾讯指数真实分时",
      methodology: "按所选指数读取真实分钟分时，并由同一轮逐秒指数报价追加当前真实点；不生成模拟轨迹。",
      fetchedAt: new Date().toISOString(),
      cached: false,
      dateMismatch,
      warning: dateMismatch
        ? `指数行情源最新交易日为${timeline.tradeDate}，主面板基础数据为${requestedTradeDate}；已优先展示最新真实分时。`
        : "",
    };
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
          industry: {key: "industry", title: "二级行业板块", rows: industryRows, reportedRows: industryRows.reportedRows, pageCount: industryRows.pageCount, coveragePct: 100},
          concept: {key: "concept", title: "概念板块", rows: conceptRows, reportedRows: conceptRows.reportedRows, pageCount: conceptRows.pageCount, coveragePct: 100},
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

  async function loadBoardConstituents(code) {
    const normalizedCode = String(code || "").trim().toUpperCase();
    if (!/^BK\d{4}$/.test(normalizedCode)) throw new Error("题材代码无效");
    const hosts = ["https://push2delay.eastmoney.com", "https://push2.eastmoney.com"];
    const loadPage = async (pageNumber, preferredHost = "") => {
      const errors = [];
      const orderedHosts = preferredHost ? [preferredHost, ...hosts.filter((host) => host !== preferredHost)] : hosts;
      for (const host of orderedHosts) {
      const url = new URL("/api/qt/clist/get", host);
      Object.entries({
        pn: String(pageNumber),
        pz: String(CONSTITUENT_PAGE_SIZE),
        po: "1",
        np: "1",
        fltt: "2",
        invt: "2",
        fid: "f6",
        fs: `b:${normalizedCode}`,
        fields: "f12,f13,f14,f2,f3,f6,f8,f20,f21,f100,f103",
        ut: EASTMONEY_TOKEN,
        _: String(Date.now()),
      }).forEach(([key, value]) => url.searchParams.set(key, value));
      try {
        const payload = await jsonp(url);
          const rows = Array.isArray(payload?.data?.diff) ? payload.data.diff : [];
          if (!rows.length) throw new Error("返回空页");
          return {host, payload, rows};
        } catch (error) {
          errors.push(`${host}: 第${pageNumber}页 ${error.message || String(error)}`);
        }
      }
      throw new Error(errors.join("；"));
    };

    try {
      const firstPage = await loadPage(1);
      const reportedTotal = Math.max(0, Math.trunc(finite(firstPage.payload?.data?.total) || 0));
      const pageCount = Math.max(1, Math.ceil(reportedTotal / CONSTITUENT_PAGE_SIZE));
      if (pageCount > MAX_CONSTITUENT_PAGES) throw new Error(`公开成分股${reportedTotal}只，超过完整读取上限`);
      const rawRows = [...firstPage.rows];
      for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
        const page = await loadPage(pageNumber, firstPage.host);
        rawRows.push(...page.rows);
      }
      const uniqueRows = [...new Map(rawRows.map((row) => [String(row?.f12 || "").trim(), row])).values()];
      const rows = uniqueRows.map((row) => {
          const stockCode = String(row?.f12 || "").trim();
          const name = String(row?.f14 || "").trim();
          if (!/^\d{6}$/.test(stockCode) || !name) return null;
          return {
            code: stockCode,
            name,
            riskFlag: /^(ST|\*ST)|退市/u.test(name),
            market: finite(row?.f13),
            price: finite(row?.f2),
            changePct: finite(row?.f3),
            amount: finite(row?.f6) === null ? null : round(Number(row.f6) / 100000000, 4),
            turnoverRate: finite(row?.f8),
            totalMarketCap: finite(row?.f20),
            floatMarketCap: finite(row?.f21),
            industry: String(row?.f100 || "").trim(),
            concepts: String(row?.f103 || "").split(/[，,、;]/u).map((item) => item.trim()).filter(Boolean),
          };
      }).filter(Boolean);
      if (rows.length < 3) throw new Error(`只返回${rows.length}只有效成分股`);
      const expectedTotal = reportedTotal || uniqueRows.length;
      if (rows.length !== expectedTotal) throw new Error(`东财公开成分股${expectedTotal}只，完整分页后仅核验${rows.length}只`);
      Object.defineProperties(rows, {
        reportedTotal: {value: expectedTotal, enumerable: false},
        excludedCount: {value: Math.max(0, uniqueRows.length - rows.length), enumerable: false},
        pageCount: {value: pageCount, enumerable: false},
        complete: {value: true, enumerable: false},
      });
      return rows;
    } catch (error) {
      throw new Error(`题材成分股读取失败：${error.message || String(error)}`);
    }
  }

  function companySecurityCode(code) {
    const normalized = String(code || "").replace(/\D/g, "").slice(-6);
    if (!/^\d{6}$/.test(normalized)) return "";
    if (/^(430|83|87|920)/.test(normalized)) return `${normalized}.BJ`;
    if (/^(5|6|9)/.test(normalized)) return `${normalized}.SH`;
    return `${normalized}.SZ`;
  }

  async function loadCompanySurvey(code) {
    const securityCode = companySecurityCode(code);
    if (!securityCode) throw new Error("股票代码无效");
    const url = new URL("https://datacenter.eastmoney.com/securities/api/data/v1/get");
    Object.entries({
      reportName: "RPT_F10_BASIC_ORGINFO",
      columns: "ALL",
      filter: `(SECUCODE=\"${securityCode}\")`,
      pageNumber: "1",
      pageSize: "1",
      source: "WEB",
      client: "WEB",
    }).forEach(([key, value]) => url.searchParams.set(key, value));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JSONP_TIMEOUT_MS);
    try {
      const response = await nativeFetch(url, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`公司资料接口返回 HTTP ${response.status}`);
      const payload = await response.json();
      const row = Array.isArray(payload?.result?.data) ? payload.result.data[0] : null;
      if (!row) throw new Error("公司资料接口未返回有效记录");
      return {
        companyName: String(row.ORG_NAME || "").trim(),
        stockName: String(row.SECURITY_NAME_ABBR || "").trim(),
        listingMarket: String(row.TRADE_MARKET || row.SECURITY_TYPE || "").trim(),
        industry: String(row.BOARD_NAME_LEVEL || row.EM2016 || row.INDUSTRYCSRC1 || "").trim(),
        businessIntro: String(row.ORG_PROFILE || "").trim(),
        businessScope: String(row.BUSINESS_SCOPE || "").trim(),
        website: String(row.ORG_WEB || "").trim(),
      };
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("公司资料读取超时");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
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
    loadBoardConstituents,
    loadCompanySurvey,
    loadDailyK,
    loadIndexCatalog,
    loadIndexTrend,
  };
})();
