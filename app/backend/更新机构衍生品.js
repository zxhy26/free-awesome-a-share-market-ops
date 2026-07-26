const fs = require("fs");
const path = require("path");

const APP_DIR = path.resolve(__dirname, "..");
const PORTABLE_ROOT = process.env.A_SHARE_REVIEW_PORTABLE_ROOT
  ? path.resolve(process.env.A_SHARE_REVIEW_PORTABLE_ROOT)
  : path.resolve(__dirname, "..", "..", "..");
const DATA_PATH = path.join(APP_DIR, "data", "derivatives.json");
const MARKET_PATH = path.join(APP_DIR, "data", "market.json");
const CACHE_DIR = path.join(PORTABLE_ROOT, "缓存");
const STATUS_PATH = path.join(CACHE_DIR, "机构衍生品更新状态.json");
const HISTORY_PATH = path.join(CACHE_DIR, "机构衍生品持仓历史.json");
const LOCK_PATH = path.join(CACHE_DIR, "机构衍生品更新运行中.lock");
const BASE_URL = "http://www.cffex.com.cn/sj/ccpm";
const FORCE = process.argv.includes("--force");
const COOLDOWN_MS = 20 * 60 * 1000;

const PRODUCTS = [
  {code: "IF", name: "沪深300股指期货", shortName: "沪深300", type: "futures"},
  {code: "IH", name: "上证50股指期货", shortName: "上证50", type: "futures"},
  {code: "IC", name: "中证500股指期货", shortName: "中证500", type: "futures"},
  {code: "IM", name: "中证1000股指期货", shortName: "中证1000", type: "futures"},
  {code: "IO", name: "沪深300股指期权", shortName: "沪深300期权", type: "options"},
  {code: "HO", name: "上证50股指期权", shortName: "上证50期权", type: "options"},
  {code: "MO", name: "中证1000股指期权", shortName: "中证1000期权", type: "options"},
];

const REQUIRED_MEMBERS = ["中信期货", "中金期货"];
const PREFERRED_MEMBERS = [
  "中信期货",
  "中金期货",
  "国泰君安",
  "华泰期货",
  "东证期货",
  "海通期货",
  "广发期货",
  "银河期货",
  "中信建投",
  "摩根大通",
  "瑞银期货",
];

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, {force: true});
    fs.renameSync(tempPath, filePath);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return "";
}

function compactDate(value) {
  return normalizeDate(value).replaceAll("-", "");
}

function previousCandidateDates(targetDate, count = 15) {
  const normalized = normalizeDate(targetDate);
  const seed = normalized ? new Date(`${normalized}T12:00:00+08:00`) : new Date();
  const result = [];
  for (let offset = 0; offset < count; offset += 1) {
    const current = new Date(seed);
    current.setDate(seed.getDate() - offset);
    const day = current.getDay();
    if (day === 0 || day === 6) continue;
    const date = [
      current.getFullYear(),
      String(current.getMonth() + 1).padStart(2, "0"),
      String(current.getDate()).padStart(2, "0"),
    ].join("-");
    result.push(date);
  }
  return result;
}

function targetTradeDate() {
  const market = readJson(MARKET_PATH, {});
  const fromMarket = normalizeDate(market.tradeDate || market.market?.tradeDate);
  if (fromMarket) return fromMarket;
  return previousCandidateDates("", 1)[0] || "";
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function numberValue(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeMember(value) {
  return String(value || "")
    .replace(/[（(]代客[）)]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function parseRankCsv(text, product, expectedDate) {
  if (!text.includes("交易日") || !text.includes("持买单量排名") || !text.includes("持卖单量排名")) {
    throw new Error(`${product.code}返回内容不是成交持仓排名`);
  }
  const expectedCompact = compactDate(expectedDate);
  const records = [];
  for (const line of text.split(/\r?\n/).slice(2)) {
    if (!line.trim()) continue;
    const columns = parseCsvLine(line);
    const tradeDate = String(columns[0] || "").trim();
    const contract = String(columns[1] || "").trim();
    if (tradeDate !== expectedCompact || !contract.startsWith(product.code)) continue;
    records.push({
      tradeDate: normalizeDate(tradeDate),
      contract,
      rank: numberValue(columns[2]),
      volumeMember: normalizeMember(columns[3]),
      volume: numberValue(columns[4]),
      volumeChange: numberValue(columns[5]),
      longMember: normalizeMember(columns[6]),
      longPosition: numberValue(columns[7]),
      longChange: numberValue(columns[8]),
      shortMember: normalizeMember(columns[9]),
      shortPosition: numberValue(columns[10]),
      shortChange: numberValue(columns[11]),
    });
  }
  if (!records.length) throw new Error(`${product.code}在${expectedDate}没有有效排名记录`);
  return records;
}

async function fetchText(url, timeoutMs = 16000) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150 Safari/537.36",
          referer: "http://www.cffex.com.cn/",
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 100) throw new Error(`响应过短：${bytes.length}字节`);
      return new TextDecoder("gbk").decode(bytes);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("请求失败");
}

async function fetchProduct(date, product) {
  const compact = compactDate(date);
  const url = `${BASE_URL}/${compact.slice(0, 6)}/${compact.slice(6, 8)}/${product.code}_1.csv`;
  const text = await fetchText(url);
  return {product, url, records: parseRankCsv(text, product, date)};
}

async function findPublishedDate(targetDate) {
  const probe = PRODUCTS.find((product) => product.code === "IF");
  const errors = [];
  for (const date of previousCandidateDates(targetDate)) {
    try {
      const result = await fetchProduct(date, probe);
      return {date, probe: result, errors};
    } catch (error) {
      errors.push(`${date}：${error.message}`);
    }
  }
  throw new Error(`最近交易日均未取得中金所排名；${errors.slice(0, 3).join("；")}`);
}

function emptyBucket() {
  return {
    longPosition: 0,
    longChange: 0,
    shortPosition: 0,
    shortChange: 0,
    contracts: new Set(),
    products: {},
  };
}

function ensureProductBucket(bucket, product) {
  if (!bucket.products[product.code]) {
    bucket.products[product.code] = {
      code: product.code,
      name: product.name,
      shortName: product.shortName,
      longPosition: 0,
      longChange: 0,
      shortPosition: 0,
      shortChange: 0,
      contracts: new Set(),
    };
  }
  return bucket.products[product.code];
}

function addMemberSide(memberMap, memberName, product, side, position, change, contract) {
  if (!memberName) return;
  if (!memberMap.has(memberName)) {
    memberMap.set(memberName, {
      member: memberName,
      futures: emptyBucket(),
      options: emptyBucket(),
    });
  }
  const record = memberMap.get(memberName);
  const bucket = record[product.type];
  const productBucket = ensureProductBucket(bucket, product);
  const positionKey = side === "long" ? "longPosition" : "shortPosition";
  const changeKey = side === "long" ? "longChange" : "shortChange";
  bucket[positionKey] += position;
  bucket[changeKey] += change;
  bucket.contracts.add(contract);
  productBucket[positionKey] += position;
  productBucket[changeKey] += change;
  productBucket.contracts.add(contract);
}

function classifyFuturesChange(netChange, activity) {
  if (activity < 300) return "样本不足";
  const ratio = netChange / Math.max(activity, 1);
  if (netChange >= 500 && ratio >= 0.08) return "偏多";
  if (netChange <= -500 && ratio <= -0.08) return "偏空";
  return "中性";
}

function serializeBucket(bucket, type) {
  const products = Object.values(bucket.products).map((product) => {
    const netChange = product.longChange - product.shortChange;
    const activity = Math.abs(product.longChange) + Math.abs(product.shortChange);
    return {
      ...product,
      contracts: [...product.contracts].sort(),
      netPosition: product.longPosition - product.shortPosition,
      netChange,
      stance: type === "futures" ? classifyFuturesChange(netChange, activity) : "",
    };
  }).sort((a, b) => a.code.localeCompare(b.code));
  const netChange = bucket.longChange - bucket.shortChange;
  const activity = Math.abs(bucket.longChange) + Math.abs(bucket.shortChange);
  return {
    longPosition: bucket.longPosition,
    longChange: bucket.longChange,
    shortPosition: bucket.shortPosition,
    shortChange: bucket.shortChange,
    netPosition: bucket.longPosition - bucket.shortPosition,
    netChange,
    activity,
    contracts: [...bucket.contracts].sort(),
    appearanceCount: bucket.contracts.size,
    stance: type === "futures" ? classifyFuturesChange(netChange, activity) : "",
    products,
  };
}

function signed(value) {
  const number = Number(value) || 0;
  return `${number > 0 ? "+" : ""}${number.toLocaleString("zh-CN")}`;
}

function memberSentence(record) {
  if (!record || !record.futures.appearanceCount) {
    return `${record?.member || "该席位"}未进入当日股指期货可披露榜单，不能据此推断其持仓为零。`;
  }
  return `${record.member}榜单可见多单变动${signed(record.futures.longChange)}手、空单变动${signed(record.futures.shortChange)}手，净方向变化${signed(record.futures.netChange)}手，信号为${record.futures.stance}。`;
}

function buildAnalysis(institutions, products) {
  const active = institutions.filter((row) => row.futures.appearanceCount > 0);
  const futuresLongChange = active.reduce((sum, row) => sum + row.futures.longChange, 0);
  const futuresShortChange = active.reduce((sum, row) => sum + row.futures.shortChange, 0);
  const futuresNetChange = futuresLongChange - futuresShortChange;
  const futuresActivity = Math.abs(futuresLongChange) + Math.abs(futuresShortChange);
  const score = Math.round(Math.max(-100, Math.min(100, futuresNetChange / Math.max(futuresActivity, 1) * 100)));
  const positiveCount = active.filter((row) => row.futures.stance === "偏多").length;
  const negativeCount = active.filter((row) => row.futures.stance === "偏空").length;
  const neutralCount = Math.max(0, active.length - positiveCount - negativeCount);
  let stance = "中性";
  if (score >= 10 && positiveCount >= negativeCount) stance = "偏多";
  else if (score <= -10 && negativeCount >= positiveCount) stance = "偏空";
  const directionalCount = positiveCount + negativeCount;
  const consensus = directionalCount ? Math.max(positiveCount, negativeCount) / directionalCount : 0;
  const confidence = Math.abs(score) >= 25 && consensus >= 0.65 ? "较高" : Math.abs(score) >= 12 ? "中等" : "较低";

  const optionActive = institutions.filter((row) => row.options.appearanceCount > 0);
  const optionLongChange = optionActive.reduce((sum, row) => sum + row.options.longChange, 0);
  const optionShortChange = optionActive.reduce((sum, row) => sum + row.options.shortChange, 0);
  const optionBalanceChange = optionLongChange - optionShortChange;
  const optionTone = Math.abs(optionBalanceChange) < 300
    ? "期权买卖双方变化接近"
    : optionBalanceChange > 0
      ? "期权买方持仓增加更明显"
      : "期权卖方持仓增加更明显";

  const futuresProducts = products.filter((product) => product.type === "futures").map((product) => {
    const rows = active.map((row) => row.futures.products.find((item) => item.code === product.code)).filter(Boolean);
    const longChange = rows.reduce((sum, row) => sum + row.longChange, 0);
    const shortChange = rows.reduce((sum, row) => sum + row.shortChange, 0);
    const netChange = longChange - shortChange;
    return {
      code: product.code,
      name: product.name,
      shortName: product.shortName,
      longChange,
      shortChange,
      netChange,
      stance: classifyFuturesChange(netChange, Math.abs(longChange) + Math.abs(shortChange)),
    };
  });
  const optionProducts = products.filter((product) => product.type === "options").map((product) => {
    const rows = optionActive.map((row) => row.options.products.find((item) => item.code === product.code)).filter(Boolean);
    const longChange = rows.reduce((sum, row) => sum + row.longChange, 0);
    const shortChange = rows.reduce((sum, row) => sum + row.shortChange, 0);
    return {
      code: product.code,
      name: product.name,
      shortName: product.shortName,
      longChange,
      shortChange,
      balanceChange: longChange - shortChange,
    };
  });

  const citic = institutions.find((row) => row.member === "中信期货");
  const cicc = institutions.find((row) => row.member === "中金期货");
  const strongProducts = futuresProducts.filter((row) => row.stance !== "中性" && row.stance !== "样本不足");
  const productText = strongProducts.length
    ? strongProducts.map((row) => `${row.shortName}${row.stance}(${signed(row.netChange)}手)`).join("、")
    : "四类股指期货暂未形成一致的明显方向";
  const conclusion = stance === "偏多"
    ? "主要席位的期货净变化偏向多头，但仍需与指数、成交额和板块资金共同确认。"
    : stance === "偏空"
      ? "主要席位的期货净变化偏向空头，短线风险对冲或看空需求更强。"
      : "主要席位多空变化接近，衍生品暂未给出清晰单边信号。";

  return {
    stance,
    score,
    confidence,
    futuresLongChange,
    futuresShortChange,
    futuresNetChange,
    positiveCount,
    negativeCount,
    neutralCount,
    optionLongChange,
    optionShortChange,
    optionBalanceChange,
    optionTone,
    futuresProducts,
    optionProducts,
    headline: `主要席位期货净方向变化${signed(futuresNetChange)}手，综合判断${stance}，置信度${confidence}。`,
    paragraphs: [
      `主要机构席位榜单可见多单日变动${signed(futuresLongChange)}手、空单日变动${signed(futuresShortChange)}手，净方向变化${signed(futuresNetChange)}手；${productText}。`,
      `${memberSentence(citic)}${memberSentence(cicc)}`,
      `期权榜单可见买方持仓变动${signed(optionLongChange)}手、卖方持仓变动${signed(optionShortChange)}手，${optionTone}。期权买方同时包含看涨和看跌，卖方也包含两类合约，因此该项只反映期权参与和风险偏好，不直接判定涨跌方向。`,
      conclusion,
    ],
  };
}

function buildPayload(targetDate, publishedDate, results) {
  const memberMap = new Map();
  const productSummaries = [];
  for (const result of results) {
    const memberNames = new Set();
    let visibleLongPosition = 0;
    let visibleLongChange = 0;
    let visibleShortPosition = 0;
    let visibleShortChange = 0;
    const contracts = new Set();
    for (const row of result.records) {
      contracts.add(row.contract);
      memberNames.add(row.longMember);
      memberNames.add(row.shortMember);
      visibleLongPosition += row.longPosition;
      visibleLongChange += row.longChange;
      visibleShortPosition += row.shortPosition;
      visibleShortChange += row.shortChange;
      addMemberSide(memberMap, row.longMember, result.product, "long", row.longPosition, row.longChange, row.contract);
      addMemberSide(memberMap, row.shortMember, result.product, "short", row.shortPosition, row.shortChange, row.contract);
    }
    productSummaries.push({
      code: result.product.code,
      name: result.product.name,
      shortName: result.product.shortName,
      type: result.product.type,
      contractCount: contracts.size,
      rowCount: result.records.length,
      memberCount: [...memberNames].filter(Boolean).length,
      visibleLongPosition,
      visibleLongChange,
      visibleShortPosition,
      visibleShortChange,
      sourceUrl: result.url,
    });
  }

  const serialized = [...memberMap.values()].map((record) => ({
    member: record.member,
    futures: serializeBucket(record.futures, "futures"),
    options: serializeBucket(record.options, "options"),
  }));
  const selectedNames = [];
  for (const name of REQUIRED_MEMBERS) if (!selectedNames.includes(name)) selectedNames.push(name);
  for (const name of PREFERRED_MEMBERS) {
    if (selectedNames.length >= 10) break;
    if (memberMap.has(name) && !selectedNames.includes(name)) selectedNames.push(name);
  }
  for (const record of serialized.sort((a, b) => (b.futures.activity + b.options.activity) - (a.futures.activity + a.options.activity))) {
    if (selectedNames.length >= 10) break;
    if (!selectedNames.includes(record.member)) selectedNames.push(record.member);
  }
  const institutions = selectedNames.map((name) => {
    const existing = serialized.find((record) => record.member === name);
    return existing || {
      member: name,
      futures: serializeBucket(emptyBucket(), "futures"),
      options: serializeBucket(emptyBucket(), "options"),
    };
  }).map((record) => ({
    ...record,
    required: REQUIRED_MEMBERS.includes(record.member),
    stance: record.futures.stance || "样本不足",
  }));
  const analysis = buildAnalysis(institutions, productSummaries);
  const fetchedAt = nowIso();
  return {
    version: 1,
    tradeDate: publishedDate,
    targetTradeDate: targetDate,
    fetchedAt,
    status: publishedDate === targetDate ? "ok" : "stale",
    stale: publishedDate !== targetDate,
    staleReason: publishedDate === targetDate ? "" : `中金所尚未发布${targetDate}排名，当前展示最近有效交易日${publishedDate}。`,
    source: {
      name: "中国金融期货交易所成交持仓排名",
      home: "http://www.cffex.com.cn/ccpm/",
      urls: productSummaries.map((row) => row.sourceUrl),
      dataScope: "达到交易所披露条件的合约及前20名期货公司结算会员榜单可见数据",
      disclosure: "期货公司当前无自营业务，交易所披露的是前20名期货公司结算会员经纪业务代客持仓榜单；榜单可见持仓不等于会员全部客户持仓，也不等于机构自营观点。",
    },
    methodology: {
      futures: "期货净方向变化=榜单可见多单日增减-榜单可见空单日增减。",
      options: "期权买方和卖方变化用于观察期权参与度；因同时包含看涨与看跌合约，不直接映射指数方向。",
      missing: "席位未进入榜单时保留为未披露，不按零持仓解释。",
    },
    products: productSummaries,
    institutions,
    analysis,
  };
}

function saveHistory(payload) {
  const history = readJson(HISTORY_PATH, {version: 1, updatedAt: "", days: []});
  const days = Array.isArray(history.days) ? history.days.filter((item) => item.tradeDate !== payload.tradeDate) : [];
  days.push({
    tradeDate: payload.tradeDate,
    fetchedAt: payload.fetchedAt,
    status: payload.status,
    analysis: payload.analysis,
    institutions: payload.institutions,
    products: payload.products,
  });
  days.sort((a, b) => String(b.tradeDate).localeCompare(String(a.tradeDate)));
  atomicWriteJson(HISTORY_PATH, {version: 1, updatedAt: nowIso(), days: days.slice(0, 120)});
}

async function main() {
  fs.mkdirSync(CACHE_DIR, {recursive: true});
  let lock = null;
  try {
    lock = fs.openSync(LOCK_PATH, "wx");
  } catch (_) {
    console.log("机构衍生品更新已有任务在运行，本次跳过。");
    return;
  }
  const targetDate = targetTradeDate();
  const previousStatus = readJson(STATUS_PATH, {});
  const previousData = readJson(DATA_PATH, null);
  try {
    const lastAttemptMs = Date.parse(previousStatus.lastAttemptAt || "");
    if (!FORCE && Number.isFinite(lastAttemptMs) && Date.now() - lastAttemptMs < COOLDOWN_MS) {
      console.log(`机构衍生品更新处于冷却期，继续使用${previousData?.tradeDate || "现有"}数据。`);
      return;
    }
    if (!FORCE && previousData?.tradeDate === targetDate && previousData?.status === "ok") {
      atomicWriteJson(STATUS_PATH, {
        ...previousStatus,
        lastAttemptAt: nowIso(),
        lastSuccessDate: previousData.tradeDate,
        ok: true,
        message: "目标交易日数据已经存在",
      });
      console.log(`机构衍生品${targetDate}数据已经存在。`);
      return;
    }
    atomicWriteJson(STATUS_PATH, {
      ...previousStatus,
      targetDate,
      lastAttemptAt: nowIso(),
      ok: false,
      message: "正在读取中金所成交持仓排名",
    });
    const published = await findPublishedDate(targetDate);
    const results = [];
    for (const product of PRODUCTS) {
      if (product.code === published.probe.product.code) {
        results.push(published.probe);
      } else {
        results.push(await fetchProduct(published.date, product));
      }
    }
    const payload = buildPayload(targetDate, published.date, results);
    atomicWriteJson(DATA_PATH, payload);
    saveHistory(payload);
    atomicWriteJson(STATUS_PATH, {
      targetDate,
      lastAttemptAt: payload.fetchedAt,
      lastSuccessAt: payload.fetchedAt,
      lastSuccessDate: payload.tradeDate,
      ok: true,
      stale: payload.stale,
      message: payload.stale ? payload.staleReason : "中金所成交持仓排名更新成功",
    });
    console.log(JSON.stringify({
      ok: true,
      tradeDate: payload.tradeDate,
      targetTradeDate: payload.targetTradeDate,
      stale: payload.stale,
      stance: payload.analysis.stance,
      score: payload.analysis.score,
      institutionCount: payload.institutions.length,
      productCount: payload.products.length,
    }));
  } catch (error) {
    const failure = {
      targetDate,
      lastAttemptAt: nowIso(),
      lastSuccessDate: previousData?.tradeDate || previousStatus.lastSuccessDate || "",
      ok: false,
      message: error.message,
    };
    atomicWriteJson(STATUS_PATH, failure);
    if (previousData) {
      atomicWriteJson(DATA_PATH, {
        ...previousData,
        status: "stale",
        stale: true,
        staleReason: `本次更新失败，保留${previousData.tradeDate || "最近"}有效数据：${error.message}`,
        lastAttemptAt: failure.lastAttemptAt,
      });
      console.warn(failure.message);
      return;
    }
    throw error;
  } finally {
    if (lock !== null) fs.closeSync(lock);
    fs.rmSync(LOCK_PATH, {force: true});
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
