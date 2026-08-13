const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const dns = require("dns").promises;
const { execFile, execFileSync } = require("child_process");
const { TextDecoder } = require("util");
const { exportOptimizedAppData } = require("./导出复盘应用数据");
const { enhanceAppData } = require("./升级数据层");
const { buildSnapshotOnlyIndex } = require("./market-data-contract");
const { reconcileBoardFlowGroups } = require("./板块资金自动纠偏");
const {INDEX_CATALOG, DEFAULT_INDEX_KEYS} = require("./index-catalog");
const {compareLegacyArchives} = require("./history-quality");
const {
  collectClosedLimitDownRows,
  isHistoricalClosedLimit,
  reconcileLimitDownPool,
} = require("./market-extremes");
const {hydrateHistoryCacheFromStructuredArchive} = require("./recent-market-history");
const {resolveLegacyTemplatePath, runOptionalOutput} = require("./sync-output-policy");
const {
  CLS_INDEX_ANNOTATION_ENDPOINTS,
  fallbackClsAnnotationFeed,
  normalizeClsAnchorPayload,
} = require("./财联社指数标注");

const PORTABLE_ROOT = path.resolve(
  process.env.A_SHARE_REVIEW_PORTABLE_ROOT || path.join(__dirname, "..", "..", "..")
);
const PORTABLE_APP_DIR = path.join(PORTABLE_ROOT, "程序", "应用");
const PORTABLE_WORK_DIR = path.join(PORTABLE_APP_DIR, "backend");
const PORTABLE_OUTPUT_DIR = path.join(PORTABLE_ROOT, "生成文件");
const PORTABLE_CACHE_DIR = path.join(PORTABLE_ROOT, "缓存");
const PORTABLE_HISTORY_DIR = path.join(PORTABLE_ROOT, "数据历史");

const CONFIG = {
  baseDir: PORTABLE_ROOT,
  workDir: PORTABLE_WORK_DIR,
  outputPath: path.join(PORTABLE_OUTPUT_DIR, "A股三项同步复盘_最新.html"),
  legacyOutputPath: path.join(PORTABLE_OUTPUT_DIR, "A股分时板块资金田字格版_最新.html"),
  summaryPath: path.join(PORTABLE_OUTPUT_DIR, "A股市场强度总结_最新.html"),
  quantPath: path.join(PORTABLE_OUTPUT_DIR, "A股量化选股_最新.html"),
  limitUpDetailPath: path.join(PORTABLE_OUTPUT_DIR, "A股涨停个股_最新.html"),
  limitDownDetailPath: path.join(PORTABLE_OUTPUT_DIR, "A股跌停个股_最新.html"),
  yesterdayLimitDetailPath: path.join(PORTABLE_OUTPUT_DIR, "A股昨日涨停延续_最新.html"),
  yesterdayBrokenDetailPath: path.join(PORTABLE_OUTPUT_DIR, "A股昨日炸板修复_最新.html"),
  windowsPwaDir: path.join(PORTABLE_OUTPUT_DIR, "兼容页面"),
  optimizedAppDir: PORTABLE_APP_DIR,
  quantCachePath: path.join(PORTABLE_CACHE_DIR, "不使用量化缓存.json"),
  quantBusinessCachePath: path.join(PORTABLE_CACHE_DIR, "不使用公司业务缓存.json"),
  quantNewsCachePath: path.join(PORTABLE_CACHE_DIR, "不使用公司事件缓存.json"),
  policyNewsCachePath: path.join(PORTABLE_CACHE_DIR, "A股政策新闻缓存.json"),
  flowSeriesPath: path.join(PORTABLE_CACHE_DIR, "A股板块资金分时缓存.json"),
  flowHistoryDir: path.join(PORTABLE_CACHE_DIR, "板块资金分时历史"),
  marketBreadthCachePath: path.join(PORTABLE_CACHE_DIR, "A股市场广度实时缓存.json"),
  stockUniversePath: path.join(PORTABLE_CACHE_DIR, "全A基础代码表.json"),
  bundledStockUniversePath: path.join(PORTABLE_APP_DIR, "data", "a-share-stock-universe.json"),
  marketHistoryPath: path.join(PORTABLE_CACHE_DIR, "A股复盘历史库.json"),
  dailyArchiveDir: path.join(PORTABLE_HISTORY_DIR, "每日完整数据"),
  structuredHistoryDir: path.join(PORTABLE_HISTORY_DIR, "结构化复盘历史"),
  marketHistoryMaxDays: 60,
  seedPath: path.join(PORTABLE_CACHE_DIR, "页面模板.html"),
  compassExe: "",
  tdxBoardPath: "",
  tdxVipdocDir: String(process.env.A_SHARE_REVIEW_TDX_VIPDOC || "").trim(),
  maxWaitMinutes: 180,
  retryIntervalSeconds: 60,
  quantHistoryLimit: 180,
  quantConcurrency: 10,
};

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const force = args.has("--force");
const waitMode = args.has("--wait");
const startCompass = args.has("--start-compass");
const noCompass = args.has("--no-compass") || !startCompass;
const skipQuant = args.has("--skip-quant");
const intradayMode = args.has("--intraday");
const prepareAmvMode = args.has("--prepare-amv");
const selfTest = args.has("--self-test");
const dataTestMode = args.has("--data-test");
const quantSmoke = args.has("--quant-smoke");
const policyNewsSmoke = args.has("--policy-news-smoke");
const flowSmoke = args.has("--flow-smoke");
const policyNewsOnlyMode = args.has("--policy-news-only");
const policyNewsForce = args.has("--policy-news-force") || policyNewsSmoke;
const quantOnlyMode = args.has("--quant-only") || quantSmoke;
const injectButtonsOnly = args.has("--inject-buttons-only");
const quantLimitArg = process.argv.slice(2).find((arg) => arg.startsWith("--quant-limit="));
const quantLimit = quantLimitArg ? Math.max(0, Number(quantLimitArg.split("=")[1]) || 0) : 0;
const policyOutputArg = process.argv.slice(2).find((arg) => arg.startsWith("--policy-output="));
const policyOutputPath = policyOutputArg ? path.resolve(policyOutputArg.slice("--policy-output=".length)) : "";

const BOARD_FLOW_TIMELINE_LIMIT = 10;
const BOARD_FLOW_TIMELINE_REFRESH_MS = 2 * 60 * 1000;
const BOARD_FLOW_TIMELINE_CONCURRENCY = 5;
const EASTMONEY_PUSH2_HOST = "push2.eastmoney.com";
const EASTMONEY_PUSH2_FALLBACK_IPS = Object.freeze(["120.79.191.232"]);
const SHARED_FLOW_SERIES_PATH = process.env.A_SHARE_REVIEW_DISABLE_SHARED_FLOW_CACHE === "1"
  ? ""
  : String(process.env.A_SHARE_REVIEW_SHARED_FLOW_PATH || (
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "A股复盘软件运行文件", "定制版", "共享数据", "A股板块资金分时缓存.json")
      : ""
  )).trim();
let preferredPush2Ip = "";

const QUANT_RULES_VERSION = "通达信条件选股公式-2026-07-25-r2";
const QUANT_MIN_HISTORY = 114;
const QUANT_RULES = Object.freeze({
  trend: Object.freeze({ shortEma: 10, multiPeriods: Object.freeze([14, 28, 57, 114]) }),
  b1: Object.freeze({ jMax: 13, changeMin: -3, changeMax: 3, amplitudeMax: 7 }),
  b2: Object.freeze({ previousJMax: 13, currentJMax: 80, changeMin: 4 }),
  b3: Object.freeze({ previousChangeMin: 6, currentChangeMin: 0, currentChangeMax: 3, amplitudeMax: 7 }),
  needle: Object.freeze({ shortPeriod: 3, longPeriod: 21, shortMax: 30, longMin: 75 }),
  brick: Object.freeze({ lookback: 4, recoveryRatio: 2 / 3 }),
});

const POLICY_NEWS_CACHE_MS = 10 * 60 * 1000;
const POLICY_NEWS_RETENTION_DAYS = 45;
const POLICY_NEWS_MAX_AGE_MS = POLICY_NEWS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const POLICY_NEWS_MAX_ITEMS_PER_SCOPE = 60;
const POLICY_NEWS_FILTER_VERSION = 8;
const POLICY_PLAN_REFERENCES = Object.freeze([
  {
    id: "十五五",
    years: "2026-2030",
    status: "现行规划",
    title: "中华人民共和国国民经济和社会发展第十五个五年规划纲要",
    url: "https://www.ndrc.gov.cn/fggz/fzzlgh/gjfzgh/202603/U020260317369114704096.pdf",
    focus: "以先进制造业为骨干建设现代化产业体系，以科技自立自强引领新质生产力，同时扩内需、促绿色转型、强安全保障。",
    directions: [
      {label: "现代化产业体系", sectors: ["先进制造", "工业母机", "高端装备", "新材料", "船舶"]},
      {label: "科技自立与未来产业", sectors: ["半导体", "人工智能", "量子科技", "具身智能", "6G", "生物制造"]},
      {label: "数智化与绿色化", sectors: ["算力", "通信设备", "电力设备", "储能", "核电", "环保"]},
      {label: "内需与安全保障", sectors: ["消费", "汽车", "文旅", "农业", "军工", "网络安全"]},
    ],
  },
  {
    id: "十四五",
    years: "2021-2025",
    status: "完成评估",
    title: "中华人民共和国国民经济和社会发展第十四个五年规划和2035年远景目标纲要",
    url: "https://www.ndrc.gov.cn/xxgk/zcfb/ghwb/202103/t20210323_1270124_ext.html",
    focus: "突出科技自立自强、现代产业体系、数字中国、国内国际双循环和碳达峰碳中和。",
    directions: [
      {label: "关键核心技术攻关", sectors: ["集成电路", "人工智能", "量子信息", "生物医药", "航空航天"]},
      {label: "战略性新兴产业", sectors: ["新能源", "新能源汽车", "新材料", "高端装备", "医疗设备"]},
      {label: "数字中国", sectors: ["5G", "云计算", "大数据", "工业互联网", "网络安全"]},
      {label: "双循环与双碳", sectors: ["消费", "物流", "电力设备", "储能", "环保"]},
    ],
  },
  {
    id: "十三五",
    years: "2016-2020",
    status: "历史基准",
    title: "中华人民共和国国民经济和社会发展第十三个五年规划纲要",
    url: "https://www.npc.gov.cn/npc/c2434/c29274/c29334/201905/t20190521_265636.html",
    focus: "以创新驱动和供给侧结构性改革为主线，推进中国制造2025、战略性新兴产业、信息化和绿色发展。",
    directions: [
      {label: "中国制造2025", sectors: ["机器人", "高端数控机床", "航空航天", "轨交装备", "新能源汽车"]},
      {label: "战略性新兴产业", sectors: ["新一代信息技术", "生物医药", "新能源", "新材料", "节能环保"]},
      {label: "供给侧结构性改革", sectors: ["钢铁", "煤炭", "有色", "化工", "建材"]},
      {label: "信息化与开放", sectors: ["云计算", "大数据", "通信", "港口航运", "物流"]},
    ],
  },
]);

// 规划主题用于筛除与A股定价无关的泛新闻，并给出可核对的产业传导路径。
const POLICY_PLAN_THEMES = Object.freeze([
  {id: "科技自立", label: "科技自立", plans: ["十五五", "十四五", "十三五"], keywords: ["科技自立", "新质生产力", "人工智能", "算力", "集成电路", "半导体", "量子", "脑机接口", "6G", "低空经济", "商业航天", "机器人", "具身智能", "关键核心技术"], sectors: ["半导体", "通信设备", "计算机", "机器人", "军工"]},
  {id: "现代产业", label: "现代产业体系", plans: ["十五五", "十四五", "十三五"], keywords: ["现代化产业体系", "先进制造", "新型工业化", "产业链", "供应链", "专精特新", "设备更新", "智能制造", "高端装备", "首台套", "国产替代"], sectors: ["机械设备", "工业母机", "高端装备", "电子", "基础材料"]},
  {id: "扩大内需", label: "扩大内需", plans: ["十五五", "十四五", "十三五"], keywords: ["扩大内需", "扩大消费", "促消费", "以旧换新", "服务消费", "消费补贴", "国内大循环", "统一大市场", "居民消费"], sectors: ["食品饮料", "零售", "家电", "汽车", "文旅"]},
  {id: "金融改革", label: "金融与资本市场", plans: ["十五五", "十四五", "十三五"], keywords: ["资本市场", "金融支持", "科技金融", "绿色金融", "并购重组", "长期资金", "降准", "降息", "货币政策", "财政金融"], sectors: ["银行", "证券", "保险", "多元金融", "高股息"]},
  {id: "绿色能源", label: "绿色能源", plans: ["十五五", "十四五", "十三五"], keywords: ["双碳", "碳达峰", "碳中和", "绿色低碳", "新能源", "新型储能", "光伏", "风电", "氢能", "核电", "零碳", "节能降碳"], sectors: ["电力设备", "新能源", "储能", "环保", "有色金属"]},
  {id: "医药健康", label: "医药健康", plans: ["十五五", "十四五", "十三五"], keywords: ["健康中国", "创新药", "生物医药", "中医药", "医疗设备", "医保", "医疗服务", "生命健康", "养老服务"], sectors: ["创新药", "中药", "医疗器械", "医疗服务", "生物制品"]},
  {id: "农业安全", label: "农业与粮食安全", plans: ["十五五", "十四五", "十三五"], keywords: ["粮食安全", "乡村振兴", "种业振兴", "高标准农田", "生物育种", "农业现代化", "耕地保护", "农产品"], sectors: ["种植业", "种业", "养殖业", "农机", "化肥"]},
  {id: "基础设施", label: "基础设施与城市更新", plans: ["十五五", "十四五", "十三五"], keywords: ["新型基础设施", "城市更新", "现代化基础设施", "水网", "交通强国", "数据中心", "充电基础设施", "智慧城市", "重大工程"], sectors: ["建筑装饰", "工程机械", "通信设备", "数据中心", "轨交设备"]},
  {id: "开放贸易", label: "开放与贸易", plans: ["十五五", "十四五", "十三五"], keywords: ["高水平开放", "一带一路", "自由贸易", "外贸", "跨境电商", "出口", "进口", "关税", "反倾销", "国际合作"], sectors: ["港口航运", "物流", "出口制造", "跨境电商", "稀土"]},
  {id: "资源安全", label: "能源资源安全", plans: ["十五五", "十四五", "十三五"], keywords: ["能源安全", "石油储备", "天然气储备", "煤炭储备", "战略性矿产", "稀土", "有色金属", "油气勘探", "资源安全"], sectors: ["石油石化", "煤炭", "天然气", "有色金属", "稀土"]},
  {id: "国防安全", label: "国防与安全", plans: ["十五五", "十四五", "十三五"], keywords: ["国防", "军队现代化", "国家安全", "网络安全", "数据安全", "卫星", "航空航天", "无人装备"], sectors: ["国防军工", "航空装备", "航天装备", "网络安全", "卫星互联网"]},
]);

const POLICY_GLOBAL_THEMES = Object.freeze([
  {id: "全球利率", label: "全球利率", keywords: ["美联储", "欧洲央行", "日本央行", "利率决议", "加息", "降息", "通胀", "非农", "美债收益率"], sectors: ["成长风格", "银行", "黄金"], channel: "美元、美债收益率与全球风险偏好"},
  {id: "贸易关税", label: "贸易与关税", keywords: ["关税", "贸易战", "出口管制", "实体清单", "反倾销", "WTO", "制裁", "禁运"], sectors: ["出口制造", "电子", "汽车", "机械设备", "稀土"], channel: "出口订单、产业链成本与国产替代预期"},
  {id: "能源供给", label: "全球能源", keywords: ["OPEC", "欧佩克", "原油", "天然气", "减产", "增产", "能源供应", "霍尔木兹"], sectors: ["石油石化", "油服", "煤炭", "化工", "航运"], channel: "油气价格、通胀预期与运输成本"},
  {id: "地缘冲突", label: "地缘冲突", keywords: ["中东", "俄乌", "冲突", "停火", "战争", "袭击", "地缘", "红海", "台海"], sectors: ["军工", "黄金", "油气", "航运", "粮食"], channel: "避险情绪、能源运输与全球供应链"},
  {id: "科技规则", label: "全球科技规则", keywords: ["芯片出口", "AI芯片", "半导体限制", "技术封锁", "人工智能监管", "数据跨境", "先进制程"], sectors: ["半导体", "通信设备", "计算机", "电子化学品"], channel: "科技供应链、先进制程与国产替代"},
  {id: "全球需求", label: "全球增长", keywords: ["IMF", "世界银行", "OECD", "全球经济", "全球贸易", "制造业PMI", "经济衰退", "经济增长"], sectors: ["有色金属", "机械设备", "航运", "出口制造"], channel: "外需、商品价格与全球风险偏好"},
]);

const POLICY_NEWS_QUERIES = Object.freeze([
  {scope: "domestic", keyword: "十五五 规划纲要", plan: "十五五"},
  {scope: "domestic", keyword: "十四五 规划纲要", plan: "十四五"},
  {scope: "domestic", keyword: "十三五 规划纲要", plan: "十三五"},
  ...["国务院 政策", "发改委 产业政策", "央行 货币政策", "证监会 资本市场", "工信部 产业政策", "财政部 政策", "商务部 外贸"].map((keyword) => ({scope: "domestic", keyword})),
  ...["美联储 利率决议", "美国 关税", "欧洲央行 利率", "日本央行 利率", "芯片 出口管制", "中东 原油 冲突", "俄乌 制裁 停火", "OPEC 原油", "WTO 全球贸易", "IMF 全球经济"].map((keyword) => ({scope: "international", keyword})),
]);

const POLICY_PLAN_FOUNDATION_NEWS = Object.freeze([
  {
    title: "中华人民共和国国民经济和社会发展第十五个五年规划纲要",
    summary: "十五五规划纲要明确以现代化产业体系和高水平科技自立自强为先导任务，并部署强大国内市场、绿色转型和安全保障。",
    source: "国家发展改革委",
    url: "https://www.ndrc.gov.cn/fggz/fzzlgh/gjfzgh/202603/U020260317369114704096.pdf",
    publishedAt: "2026-03-13 00:00:00",
    plans: ["十五五"],
    themes: ["现代产业体系", "科技自立"],
    sectors: ["先进制造", "半导体", "人工智能", "高端装备", "电力设备", "消费"],
    reason: "十五五总纲是2026至2030年产业政策的长期基准，重点观察先进制造、未来产业、数字化绿色化和内需安全方向。",
  },
  {
    title: "未来五年新兴支柱产业和未来产业成为新动能",
    summary: "国家发展改革委解读十五五现代化产业体系部署，强调智能化、绿色化、融合化和新兴支柱产业、未来产业。",
    source: "国家发展改革委",
    url: "https://www.ndrc.gov.cn/wsdwhfz/202603/t20260324_1404328.html",
    publishedAt: "2026-03-24 00:00:00",
    plans: ["十五五"],
    themes: ["现代产业体系", "科技自立"],
    sectors: ["人工智能", "机器人", "量子科技", "生物制造", "氢能", "6G"],
    reason: "该权威解读把十五五产业主线进一步落到新兴支柱产业和未来产业，是跟踪政策落地顺序的重要基准。",
  },
  {
    title: "中华人民共和国国民经济和社会发展第十四个五年规划和2035年远景目标纲要",
    summary: "十四五纲要部署科技自立自强、现代产业体系、数字中国、双循环和绿色低碳转型。",
    source: "国家发展改革委",
    url: "https://www.ndrc.gov.cn/xxgk/zcfb/ghwb/202103/t20210323_1270124_ext.html",
    publishedAt: "2021-03-13 14:06:00",
    plans: ["十四五"],
    themes: ["科技自立", "现代产业体系", "绿色能源"],
    sectors: ["集成电路", "人工智能", "新能源", "高端装备", "工业互联网", "储能"],
    reason: "十四五总纲是判断2021至2025年产业政策连续性及向十五五衔接关系的官方基准。",
  },
  {
    title: "十四五规划纲要实施中期评估报告",
    summary: "全国人大公开的中期评估系统梳理十四五目标、重大战略任务和工程进展，并指出核心技术、消费和产业链安全等后续重点。",
    source: "中国人大网",
    url: "https://www.npc.gov.cn/npc/c2/c30834/202312/t20231227_433830.html",
    publishedAt: "2023-12-27 00:00:00",
    plans: ["十四五"],
    themes: ["科技自立", "扩大内需", "现代产业体系"],
    sectors: ["半导体", "高端装备", "新能源汽车", "生物医药", "消费", "数字经济"],
    reason: "中期评估用于区分十四五已兑现方向和仍需补短板方向，可作为十五五政策延续性的参照。",
  },
  {
    title: "中华人民共和国国民经济和社会发展第十三个五年规划纲要",
    summary: "十三五纲要以创新驱动和供给侧结构性改革为主线，部署中国制造2025、战略性新兴产业、信息化和绿色发展。",
    source: "中国人大网",
    url: "https://www.npc.gov.cn/npc/c2434/c29274/c29334/201905/t20190521_265636.html",
    publishedAt: "2016-03-18 09:07:00",
    plans: ["十三五"],
    themes: ["现代产业体系", "科技自立", "绿色能源"],
    sectors: ["机器人", "高端装备", "信息技术", "生物医药", "新能源", "新材料"],
    reason: "十三五总纲用于回看产业政策的起点和长期延续方向，特别是先进制造、战略新兴产业和供给侧改革。",
  },
  {
    title: "国务院印发十三五国家战略性新兴产业发展规划",
    summary: "专项规划明确网络经济、高端制造、生物经济、绿色低碳和数字创意五大领域，并前瞻布局空天海洋、信息网络和生物技术。",
    source: "中国政府网",
    url: "https://www.cac.gov.cn/2016-12/19/c_1120146605.htm",
    publishedAt: "2016-12-19 18:00:00",
    plans: ["十三五"],
    themes: ["现代产业体系", "科技自立"],
    sectors: ["新一代信息技术", "高端制造", "生物医药", "新能源", "新材料", "数字创意"],
    reason: "该专项规划把十三五总纲具体落到战略性新兴产业，是识别长期产业政策传承的重要历史基准。",
  },
]);

const MAJOR_INDEXES = DEFAULT_INDEX_KEYS
  .map((key) => INDEX_CATALOG.find((item) => item.key === key))
  .filter(Boolean)
  .map((item) => ({...item, tencent: item.symbol}));

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toLocalDateText(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function previousWeekdayDate(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  do {
    d.setDate(d.getDate() - 1);
  } while (d.getDay() === 0 || d.getDay() === 6);
  return d;
}

function expectedMarketDate() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  if (now.getDay() === 0 || now.getDay() === 6 || minutes < 9 * 60 + 15) {
    return toLocalDateText(previousWeekdayDate(now));
  }
  return todayLocal();
}

function nowText() {
  const d = new Date();
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function appendTextWithRetry(filePath, text, attempts = 8, delayMs = 80) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.appendFileSync(filePath, text, "utf8");
      return true;
    } catch (_) {
      if (attempt === attempts - 1) break;
      const end = Date.now() + delayMs * (attempt + 1);
      while (Date.now() < end) {
        // Another updater may be holding the shared log file for a moment.
      }
    }
  }
  try {
    fs.appendFileSync(`${filePath}.fallback`, text, "utf8");
  } catch (_) {
    return false;
  }
  return false;
}

function log(message) {
  ensureDir(CONFIG.workDir);
  const line = `[${nowText()}] ${message}`;
  appendTextWithRetry(path.join(CONFIG.workDir, "自动更新日志.txt"), `${line}\n`);
  console.log(line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runPowerShell(script, timeoutMs = 60000) {
  if (process.platform !== "win32") {
    throw new Error("当前系统不提供 Windows PowerShell 备用通道");
  }
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
  );
}

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

function prepareWritableFile(filePath) {
  return false;
}

function restoreHiddenFile(filePath, shouldHide) {
  return;
}

function clearWindowsFileAttributes(filePath) {
  if (process.platform !== "win32" || !fs.existsSync(filePath)) return;
  try {
    execFileSync("attrib.exe", ["-R", "-H", filePath], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
  } catch (_) {
    // If attrib is unavailable or the file is already writable, the retry below is enough.
  }
}

function writeUtf8File(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, content, "utf8");
    fs.renameSync(tempPath, filePath);
    return;
  } catch (firstError) {
    clearWindowsFileAttributes(filePath);
    try {
      if (fs.existsSync(tempPath)) {
        fs.copyFileSync(tempPath, filePath);
        fs.rmSync(tempPath, { force: true });
      } else {
        fs.writeFileSync(filePath, content, "utf8");
      }
      return;
    } catch (secondError) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch (_) {
        // The temporary file may already have been moved.
      }
      secondError.message = `${secondError.message}；首次写入错误：${firstError.message}`;
      throw secondError;
    }
  }
}

function fetchText(url, timeoutSec = 35) {
  const escaped = url.replace(/'/g, "''");
  const timeout = Math.max(6, Number(timeoutSec) || 20);
  const errors = [];
  const curlCommand = process.platform === "win32" ? "curl.exe" : "/usr/bin/curl";
  try {
    return execFileSync(
      curlCommand,
      ["-L", "--silent", "--show-error", "--max-time", String(timeout), "-H", "Referer: https://quote.eastmoney.com/ztb/", url],
      { encoding: "utf8", timeout: (timeout + 8) * 1000, maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    errors.push(error.message);
  }
  if (process.platform !== "win32") {
    throw new Error(`行情接口连续失败：${url}；${errors.at(-1) || "未知错误"}`);
  }
  const command =
    `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);` +
    `$ProgressPreference='SilentlyContinue';` +
    `$u='${escaped}';` +
    `(Invoke-WebRequest -UseBasicParsing -Headers @{Referer='https://quote.eastmoney.com/ztb/'} -Uri $u -TimeoutSec ${timeout}).Content`;
  try {
    return runPowerShell(command, (timeout + 8) * 1000);
  } catch (error) {
    errors.push(error.message);
  }
  throw new Error(`行情接口连续失败：${url}；${errors.at(-1) || "未知错误"}`);
}

function fetchJson(url, timeoutSec = 35) {
  const text = fetchText(url, timeoutSec).trim();
  const jsonText = /^[\w$]+\(/.test(text) ? text.replace(/^[\w$]+\(/, "").replace(/\);?$/, "") : text;
  return JSON.parse(jsonText);
}

function parseJsonResponse(text) {
  const source = String(text || "").trim();
  const jsonText = /^[\w$]+\(/.test(source) ? source.replace(/^[\w$]+\(/, "").replace(/\);?$/, "") : source;
  return JSON.parse(jsonText);
}

function fetchCurlTextAsync(url, options = {}) {
  const timeoutSec = Math.max(6, Number(options.timeoutSec) || 18);
  const resolveIp = String(options.resolveIp || "").trim();
  const parsed = new URL(url);
  const curlArgs = [
    "-L",
    "--silent",
    "--show-error",
    "--compressed",
    "--connect-timeout",
    String(Math.min(8, timeoutSec)),
    "--max-time",
    String(timeoutSec),
    "-H",
    "Referer: https://data.eastmoney.com/",
    "-H",
    "User-Agent: Mozilla/5.0",
  ];
  if (resolveIp) curlArgs.push("--resolve", `${parsed.hostname}:443:${resolveIp}`);
  curlArgs.push(url);
  return new Promise((resolve, reject) => {
    execFile(
      process.platform === "win32" ? "curl.exe" : "/usr/bin/curl",
      curlArgs,
      {
        encoding: "utf8",
        timeout: (timeoutSec + 5) * 1000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || "curl failed").trim()));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function resolvePush2Ips() {
  try {
    const addresses = await dns.resolve4(EASTMONEY_PUSH2_HOST);
    return addresses.filter((value) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(value)));
  } catch (_) {
    return [];
  }
}

async function fetchEastmoneyBoardMinuteJson(url, timeoutSec = 18) {
  const errors = [];
  const attempted = new Set();
  async function tryIps(ips) {
    for (const ip of [...new Set(ips.filter(Boolean))]) {
      if (attempted.has(ip)) continue;
      attempted.add(ip);
      try {
        const json = parseJsonResponse(await fetchCurlTextAsync(url, { timeoutSec, resolveIp: ip }));
        if (Number(json?.rc) !== 0 || !json?.data) throw new Error(`接口状态异常：${json?.rc}`);
        preferredPush2Ip = ip;
        return json;
      } catch (error) {
        errors.push(`${ip}: ${error.message}`);
        if (ip === preferredPush2Ip) preferredPush2Ip = "";
      }
    }
    return null;
  }
  const cachedResult = await tryIps([preferredPush2Ip, ...EASTMONEY_PUSH2_FALLBACK_IPS]);
  if (cachedResult) return cachedResult;
  const resolvedResult = await tryIps(await resolvePush2Ips());
  if (resolvedResult) return resolvedResult;
  try {
    const json = parseJsonResponse(await fetchCurlTextAsync(url, { timeoutSec }));
    if (Number(json?.rc) !== 0 || !json?.data) throw new Error(`接口状态异常：${json?.rc}`);
    return json;
  } catch (error) {
    errors.push(`系统解析: ${error.message}`);
  }
  throw new Error(`东方财富板块分钟资金接口不可用：${errors.at(-1) || "未知错误"}`);
}

function minuteToTime(minute) {
  const bounded = Math.max(0, Math.min(240, minute));
  const total = bounded <= 120 ? 570 + bounded : 780 + (bounded - 120);
  const totalSeconds = Math.round(total * 60);
  return `${pad2(Math.floor(totalSeconds / 3600))}:${pad2(Math.floor((totalSeconds % 3600) / 60))}:${pad2(totalSeconds % 60)}`;
}

function timeTextToMinute(time) {
  const [h, m] = time.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
  const total = h * 60 + m;
  if (total <= 9 * 60 + 30) return 0;
  if (total <= 11 * 60 + 30) return Math.max(0, total - (9 * 60 + 30));
  if (total < 13 * 60) return 120;
  return Math.min(240, 120 + total - 13 * 60);
}

function timeTextToIndexMinute(time, def = {}) {
  if (def.session === "us") {
    const [h, m] = time.split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
    const elapsed = h * 60 + m - (9 * 60 + 30);
    return Math.max(0, Math.min(240, Math.round((elapsed / 390) * 240)));
  }
  return timeTextToMinute(time);
}

function timeIntToText(value) {
  const h = Math.floor(value / 10000);
  const m = Math.floor((value % 10000) / 100);
  return `${pad2(h)}:${pad2(m)}`;
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function calculateBrokenBoardStats(limitUpCount, brokenCount) {
  const limitUp = limitUpCount === null || limitUpCount === undefined || limitUpCount === ""
    ? NaN
    : Number(limitUpCount);
  const broken = brokenCount === null || brokenCount === undefined || brokenCount === ""
    ? NaN
    : Number(brokenCount);
  if (!Number.isFinite(limitUp) || !Number.isFinite(broken) || limitUp < 0 || broken < 0) {
    return { touchedLimitCount: null, brokenRate: null };
  }
  const touchedLimitCount = limitUp + broken;
  return {
    touchedLimitCount,
    brokenRate: touchedLimitCount > 0 ? round1((broken / touchedLimitCount) * 100) : null,
  };
}


const BOARD_NAME_OVERRIDES = new Map(Object.entries({
  "医疗服务": "医疗保健",
  "自动化设备": "工业机械",
  "工业金属": "有色",
  "白色家电": "家用电器",
  "其他电源设备Ⅱ": "电气设备",
  "养殖业": "农林牧渔",
  "光伏设备": "光伏",
  "生物制品": "生物制药",
  "元件": "元器件",
  "光学光电子": "元器件",
  "消费电子": "消费电子概念",
  "通用设备": "通用机械",
  "汽车零部件": "汽车配件",
  "其他电子Ⅱ": "元器件",
  "工程咨询服务Ⅱ": "建筑工程",
  "AH股": "含H股",
  "医药医疗风格": "医药",
  "AI芯片": "芯片",
  "通信技术": "通信设备",
  "深股通": "陆股通重仓",
  "昨日高振幅": "昨日振荡",
  "华为概念": "华为海思",
  "科技风格": "量子科技",
  "趋势股": "板块趋势",
}));

let tdxBoardEntriesCache = null;

function readDefaultText(filePath) {
  if (!fs.existsSync(filePath)) return "";
  if (process.platform !== "win32") {
    return fs.readFileSync(filePath, "latin1");
  }
  const file = psQuote(filePath);
  return runPowerShell(
    `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);` +
      `$p='${file}';` +
      `Get-Content -LiteralPath $p -Encoding Default -Raw`,
    10000,
  );
}

function normalizeBoardName(value) {
  return String(value || "")
    .replace(/[ _-]/g, "")
    .replace(/[ⅡⅢ]/g, "")
    .replace(/概念|板块|风格|行业|服务|设备/g, "");
}

function loadTdxBoardEntries() {
  if (tdxBoardEntriesCache) return tdxBoardEntriesCache;
  const text = readDefaultText(CONFIG.tdxBoardPath);
  const entries = [];
  text.split(/\r?\n/).forEach((line) => {
    const parts = line.trim().split("|");
    if (parts.length >= 2 && /^\d{6}$/.test(parts[1])) {
      entries.push({ name: parts[0], code: parts[1], alias: parts.at(-1) || "" });
    }
  });
  const byName = new Map();
  const byAlias = new Map();
  const byNorm = new Map();
  entries.forEach((entry) => {
    byName.set(entry.name, entry);
    if (entry.alias) byAlias.set(entry.alias, entry);
    const normalized = normalizeBoardName(entry.name);
    if (normalized && !byNorm.has(normalized)) byNorm.set(normalized, entry);
  });
  tdxBoardEntriesCache = { entries, byName, byAlias, byNorm };
  return tdxBoardEntriesCache;
}

function resolveTdxBoard(name) {
  const original = String(name || "");
  const mappedName = BOARD_NAME_OVERRIDES.get(original) || original;
  const maps = loadTdxBoardEntries();
  const exact = maps.byName.get(mappedName) || maps.byAlias.get(mappedName);
  if (exact) return exact;
  const normalized = normalizeBoardName(mappedName);
  return maps.byNorm.get(normalized) || null;
}

function decorateBoardRows(rows) {
  return rows.map((row) => {
    const tdx = resolveTdxBoard(row.name);
    if (!tdx) return row;
    return { ...row, tdxName: tdx.name, tdxCode: tdx.code };
  });
}


const EASTMONEY_UT = "fa5fd1943c7b386f172d6893dbfba10b";
const ZTB_UT = "7eea3edcaed734bea9cbfc24409ed989";
const ZTB_DPT = "wz.ztzt";
const PUSH2_HOSTS = [
  "push2.eastmoney.com",
  "1.push2.eastmoney.com",
  "4.push2.eastmoney.com",
  "32.push2.eastmoney.com",
  "18.push2.eastmoney.com",
];
const PUSH2EX_HOSTS = ["push2ex.eastmoney.com"];
const QUOTE_FIELDS = "f12,f14,f2,f3,f4,f5,f6,f15,f16,f17,f18,f100,f103";
const STOCK_FIELDS = "f12,f13,f14,f2,f3,f4,f5,f6,f8,f15,f16,f17,f18,f20,f21,f26,f100,f103";
const STOCK_LIST_FS_GROUPS = [
  "m:1+t:2,m:1+t:23",
  "m:0+t:6,m:0+t:80",
  "m:0+t:81+s:2048",
];
const TURNOVER_FIELDS = "f12,f14,f5,f6";
const TURNOVER_SECIDS = "1.000001,0.399001";
const POOL_CONFIG = {
  limitUp: { endpoint: "getTopicZTPool", sort: "fbt:asc" },
  limitDown: { endpoint: "getTopicDTPool", sort: "fund:asc" },
  yesterdayLimitUp: { endpoint: "getYesterdayZTPool", sort: "zs:desc" },
  broken: { endpoint: "getTopicZBPool", sort: "fbt:asc" },
};

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function quoteUrl(host, query) {
  return `https://${host}/api/qt/clist/get?${query}`;
}

function fetchJsonFromUrls(urls, label, timeoutSec = 35) {
  const errors = [];
  for (const url of urls) {
    try {
      return fetchJson(url, timeoutSec);
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`${label} 接口连续失败：${errors.slice(-2).join("；")}`);
}

function fetchPush2Json(query, label, timeoutSec = 35) {
  const urls = PUSH2_HOSTS.map((host) => quoteUrl(host, query));
  return fetchJsonFromUrls(urls, label, timeoutSec);
}
function push2ExUrl(host, endpoint, query) {
  return `https://${host}/${endpoint}?${query}`;
}

function fetchPush2ExJson(endpoint, query, label) {
  const urls = PUSH2EX_HOSTS.map((host) => push2ExUrl(host, endpoint, query));
  return fetchJsonFromUrls(urls, label, intradayMode ? 8 : 15);
}

function fetchClist(fsCode, options = {}) {
  const rows = [];
  const pageSize = options.pageSize || 500;
  const maxPages = options.maxPages || 20;
  const fid = options.fid || "f3";
  const fields = options.fields || QUOTE_FIELDS;
  let total = Infinity;
  for (let page = 1; page <= maxPages && rows.length < total; page += 1) {
    const query =
      `ut=${EASTMONEY_UT}` +
      `&pn=${page}` +
      `&pz=${pageSize}` +
      "&po=1&np=1&fltt=2&invt=2" +
      `&fid=${encodeURIComponent(fid)}` +
      `&fs=${encodeURIComponent(fsCode)}` +
      `&fields=${fields}`;
    const json = fetchPush2Json(query, `行情列表 ${fsCode}`);
    const data = json.data || {};
    const diff = Array.isArray(data.diff) ? data.diff : [];
    total = Number(data.total || diff.length || 0);
    rows.push(...diff);
    if (!diff.length || rows.length >= total) break;
  }
  return rows;
}

function normalizeQuote(row) {
  return {
    code: String(row.f12 || row.c || ""),
    name: String(row.f14 || row.n || ""),
    price: finiteNumber(row.f2 ?? row.p),
    changePct: finiteNumber(row.f3 ?? row.zdp),
    volume: finiteNumber(row.f5),
    amount: finiteNumber(row.f6 ?? row.amount),
    high: finiteNumber(row.f15),
    low: finiteNumber(row.f16),
    open: finiteNumber(row.f17),
    preClose: finiteNumber(row.f18),
    sector: String(row.hybk || row.f100 || row.industry || "").trim(),
    concepts: String(row.f103 || row.cpt || "").split(/[，,]/).map((item) => item.trim()).filter(Boolean),
  };
}

function limitRateOf(quote) {
  const name = quote.name || "";
  const code = quote.code || "";
  if (/ST|\*ST/.test(name)) return 5;
  if (/^(688|689|300|301|302)/.test(code)) return 20;
  if (/^(8|4|9)/.test(code)) return 30;
  return 10;
}

function isLimitUp(quote) {
  const pct = quote.changePct;
  if (!Number.isFinite(pct)) return false;
  return pct >= limitRateOf(quote) - 0.25;
}

function isLimitDown(quote) {
  const pct = quote.changePct;
  if (!Number.isFinite(pct)) return false;
  return pct <= -limitRateOf(quote) + 0.25;
}

function topSectorStats(quotes, mode) {
  const groups = new Map();
  quotes.forEach((quote) => {
    const sector = quote.sector || "未分类";
    if (!groups.has(sector)) {
      groups.set(sector, { sector, count: 0, upCount: 0, limitUpCount: 0, changeSum: 0 });
    }
    const item = groups.get(sector);
    item.count += 1;
    item.changeSum += Number.isFinite(quote.changePct) ? quote.changePct : 0;
    if (quote.changePct > 0) item.upCount += 1;
    if (isLimitUp(quote)) item.limitUpCount += 1;
  });
  return [...groups.values()]
    .map((item) => ({
      ...item,
      avgChangePct: item.count ? round2(item.changeSum / item.count) : 0,
      mainCount: mode === "repair" ? item.upCount : item.limitUpCount,
    }))
    .filter((item) => item.mainCount > 0 || item.upCount > 0 || item.limitUpCount > 0)
    .sort((a, b) => b.mainCount - a.mainCount || b.limitUpCount - a.limitUpCount || b.upCount - a.upCount || b.avgChangePct - a.avgChangePct || b.count - a.count)
    .slice(0, 3);
}

function summarizeQuoteGroup(name, boardCode, rows, mode) {
  const quotes = rows.map(normalizeQuote).filter((quote) => Number.isFinite(quote.changePct));
  const count = quotes.length;
  const upCount = quotes.filter((quote) => quote.changePct > 0).length;
  const limitUpCount = quotes.filter(isLimitUp).length;
  const avgChangePct = count ? round2(quotes.reduce((sum, quote) => sum + quote.changePct, 0) / count) : 0;
  const positiveRate = count ? round1((upCount / count) * 100) : 0;
  const limitRate = count ? limitUpCount / count : 0;
  const score = avgChangePct + (positiveRate - 50) / 12 + limitRate * 18;
  let strength;
  if (!count) {
    strength = "无数据";
  } else if (mode === "repair") {
    strength = score >= 6 ? "修复强" : score >= 2 ? "修复中" : score >= 0 ? "修复弱" : "未修复";
  } else {
    strength = score >= 6 ? "延续强" : score >= 2 ? "延续中" : score >= 0 ? "延续弱" : "无延续";
  }
  return {
    name,
    boardCode,
    count,
    upCount,
    limitUpCount,
    positiveRate,
    avgChangePct,
    strength,
    topSectors: topSectorStats(quotes, mode),
    summary: count ? (mode === "repair"
      ? `炸板${count}家，今日红盘${upCount}家（${positiveRate.toFixed(1)}%），其中再涨停${limitUpCount}家，平均涨跌${avgChangePct.toFixed(2)}%`
      : `涨停${limitUpCount}/${count}，上涨${positiveRate.toFixed(1)}%，均涨${avgChangePct.toFixed(2)}%`) : "无成分股数据",
  };
}

function fetchZtbPool(kind, tradeDate, pageSize = 500) {
  const config = POOL_CONFIG[kind];
  if (!config) throw new Error(`未知涨停专题类型：${kind}`);
  const query =
    `ut=${ZTB_UT}` +
    `&dpt=${ZTB_DPT}` +
    "&Pageindex=0" +
    `&pagesize=${pageSize}` +
    `&sort=${encodeURIComponent(config.sort)}` +
    `&date=${tradeDate.replace(/-/g, "")}`;
  const json = fetchPush2ExJson(config.endpoint, query, `涨停专题 ${kind}`);
  const data = json.data || {};
  const rows = Array.isArray(data.pool) ? data.pool : [];
  return {
    rows,
    total: Math.max(Number.isFinite(Number(data.tc)) ? Number(data.tc) : 0, rows.length),
    qdate: data.qdate ? String(data.qdate).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3") : tradeDate,
  };
}

function safeZtbPool(kind, tradeDate) {
  try {
    return fetchZtbPool(kind, tradeDate);
  } catch (error) {
    log(`涨停专题 ${kind} 暂未取到：${error.message}`);
    return { rows: [], total: null, qdate: tradeDate };
  }
}


function poolRawPPrice(value) {
  const number = finiteNumber(value);
  return Number.isFinite(number) ? round2(number / 1000) : null;
}

function quoteRowPrice(value) {
  const number = finiteNumber(value);
  return Number.isFinite(number) ? round2(number) : null;
}

function poolMoneyYi(value) {
  const number = finiteNumber(value);
  return Number.isFinite(number) ? round2(number / 100000000) : null;
}

function poolTimeLabel(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "--";
  return timeIntToText(Math.trunc(number));
}

function poolStockMarket(row) {
  const market = Number(row?.m ?? row?.f13 ?? row?.market);
  if (Number.isFinite(market)) return market;
  const code = String(row?.c ?? row?.f12 ?? row?.code ?? "");
  return /^[69]/.test(code) ? 1 : 0;
}

function poolConcepts(row) {
  const text = String(row?.gn ?? row?.concept ?? row?.concepts ?? row?.f103 ?? "");
  return uniqueTextList(text.split(/[;,，；|/]/));
}

function uniqueTextList(values) {
  const result = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value ?? "").trim();
    if (!text || text === "--" || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function poolSector(row) {
  const candidates = uniqueTextList([row?.f100, row?.industry, row?.sector, row?.hybk]);
  candidates.sort((a, b) => b.length - a.length || a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" }));
  return candidates[0] || "--";
}

function normalizeLimitPoolStock(row, kind) {
  const code = String(row?.c ?? row?.f12 ?? row?.code ?? "").trim();
  const name = String(row?.n ?? row?.f14 ?? row?.name ?? "").trim();
  const streak = Number(row?.lbc ?? row?.zttj?.ct ?? row?.days);
  const openCount = Number(row?.zbc ?? row?.oc);
  const downDays = Number(row?.days);
  const sector = poolSector(row);
  return {
    code,
    name,
    market: poolStockMarket(row),
    sector,
    concepts: poolConcepts(row),
    price: row?.f2 !== undefined && row?.f2 !== null
      ? quoteRowPrice(row.f2)
      : row?.price !== undefined && row?.price !== null
        ? quoteRowPrice(row.price)
        : poolRawPPrice(row?.p),
    changePct: round2(row?.f3 ?? row?.changePct ?? row?.zdp),
    preClose: quoteRowPrice(row?.f18 ?? row?.preClose),
    quoteDate: parseCompactDate(row?.quoteDate),
    amountYi: poolMoneyYi(row?.amount ?? row?.f6),
    sealAmountYi: poolMoneyYi(row?.fund ?? row?.fba),
    turnoverRate: round2(row?.hs ?? row?.f8),
    firstLimitTime: poolTimeLabel(row?.fbt),
    lastLimitTime: poolTimeLabel(row?.lbt),
    streak: Number.isFinite(streak) ? streak : null,
    openCount: Number.isFinite(openCount) ? openCount : null,
    downDays: Number.isFinite(downDays) ? downDays : null,
    kind,
  };
}

function poolStockSecid(row) {
  const code = String(row?.code ?? row?.c ?? row?.f12 ?? "").trim();
  if (!/^\d{6}$/.test(code)) return "";
  const market = Number(row?.market ?? row?.m ?? row?.f13);
  const eastmoneyMarket = Number.isFinite(market) ? market : (/^[69]/.test(code) ? 1 : 0);
  return eastmoneyMarket + "." + code;
}

function fetchLimitBoardInfoMap(rows) {
  const secids = uniqueTextList((rows || []).map(poolStockSecid).filter(Boolean));
  const map = new Map();
  for (let i = 0; i < secids.length; i += 80) {
    const batch = secids.slice(i, i + 80);
    const query =
      "fltt=2&invt=2" +
      "&fields=f12,f14,f100,f103" +
      "&secids=" + encodeURIComponent(batch.join(",")) +
      `&ut=${EASTMONEY_UT}`;
    try {
      const json = fetchJsonFromUrls(PUSH2_HOSTS.map((host) => `https://${host}/api/qt/ulist.np/get?${query}`), "涨跌停个股板块补全", 15);
      const diff = Array.isArray(json.data?.diff) ? json.data.diff : [];
      diff.forEach((item) => {
        const code = String(item.f12 || "").trim();
        if (!/^\d{6}$/.test(code)) return;
        map.set(code, {
          sector: poolSector(item),
          concepts: poolConcepts(item),
        });
      });
    } catch (error) {
      log("涨跌停个股板块补全暂未取到：" + error.message);
    }
  }
  return map;
}

function enrichLimitRowsWithBoardInfo(rows, options = {}) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (!sourceRows.length) return sourceRows;
  const infoMap = options.intraday ? new Map() : fetchLimitBoardInfoMap(sourceRows);
  const localIndustryMap = loadLocalTdxIndustryMap();
  const localConceptMap = loadLocalTdxConceptMap();
  if (!infoMap.size && !localIndustryMap.size && !localConceptMap.size) {
    return sourceRows.map((row) => ({ ...row, sector: localSectorFallback(row.sector) }));
  }
  return sortLimitStocksBySector(sourceRows.map((row) => {
    const info = infoMap.get(row.code);
    const localSector = localIndustryMap.get(row.code);
    const localConcepts = localConceptMap.get(row.code) || [];
    if (!info && !localSector && !localConcepts.length) return { ...row, sector: localSectorFallback(row.sector) };
    return {
      ...row,
      sector: poolSector({ f100: info?.sector, industry: localSector, sector: localSectorFallback(row.sector) }),
      concepts: uniqueTextList([...(row.concepts || []), ...(info?.concepts || []), ...localConcepts]),
    };
  }));
}

function loadLocalTdxIndustryMap() {
  const map = new Map();
  const configuredT0002 = CONFIG.tdxVipdocDir ? path.join(path.dirname(CONFIG.tdxVipdocDir), "T0002") : "";
  const roots = uniqueTextList([configuredT0002, "D:\\股票\\T0002", "D:\\软件\\T0002", "D:\\软件\\股票\\T0002"]);
  const root = roots.find((item) =>
    fs.existsSync(path.join(item, "hq_cache", "tdxhy.cfg")) &&
    fs.existsSync(path.join(item, "cloud_cfg", "hy_tree.xml")),
  );
  if (!root) return map;
  const tdxHyPath = path.join(root, "hq_cache", "tdxhy.cfg");
  const tdxHyTreePath = path.join(root, "cloud_cfg", "hy_tree.xml");
  try {
    if (!fs.existsSync(tdxHyPath) || !fs.existsSync(tdxHyTreePath)) return map;
    const tree = new TextDecoder("gb18030").decode(fs.readFileSync(tdxHyTreePath));
    const blockNames = new Map();
    for (const match of tree.matchAll(/caption="([^"]+)"[^>]*blockid="([^"]+)"/g)) {
      blockNames.set(match[2], match[1]);
    }
    fs.readFileSync(tdxHyPath, "utf8").split(/\r?\n/).forEach((line) => {
      const parts = line.trim().split("|");
      const code = parts[1];
      const industryCode = parts[5];
      if (/^\d{6}$/.test(code) && industryCode && blockNames.has(industryCode)) {
        map.set(code, blockNames.get(industryCode));
      }
    });
  } catch (error) {
    log("通达信本地行业兜底暂不可用：" + error.message);
  }
  return map;
}

function loadLocalTdxConceptMap() {
  const map = new Map();
  const configuredT0002 = CONFIG.tdxVipdocDir ? path.join(path.dirname(CONFIG.tdxVipdocDir), "T0002") : "";
  const conceptPath = uniqueTextList([
    configuredT0002 ? path.join(configuredT0002, "hq_cache", "infoharbor_block.dat") : "",
    "D:\\股票\\T0002\\hq_cache\\infoharbor_block.dat",
    "D:\\软件\\T0002\\hq_cache\\infoharbor_block.dat",
    "D:\\软件\\股票\\T0002\\hq_cache\\infoharbor_block.dat",
  ]).find((item) => fs.existsSync(item));
  try {
    if (!conceptPath) return map;
    const text = new TextDecoder("gb18030").decode(fs.readFileSync(conceptPath));
    const blockPattern = /#([^\r\n,]+)[^\r\n]*\r?\n([\s\S]*?)(?=\r?\n#|$)/g;
    for (const block of text.matchAll(blockPattern)) {
      const name = String(block[1] || "").replace(/^GN[_-]?/, "").trim();
      if (!name || /^FG_|^ZS_/i.test(name) || name.length > 24) continue;
      for (const codeMatch of String(block[2] || "").matchAll(/[01]#(\d{6})/g)) {
        const code = codeMatch[1];
        const values = map.get(code) || [];
        if (!values.includes(name)) values.push(name);
        map.set(code, values);
      }
    }
  } catch (error) {
    log("通达信本地概念兜底暂不可用：" + error.message);
  }
  return map;
}

function loadLocalTdxNameMap() {
  const map = new Map();
  if (!CONFIG.tdxVipdocDir) return map;
  const t0002 = path.join(path.dirname(CONFIG.tdxVipdocDir), "T0002", "hq_cache");
  const files = ["shs.tnf", "szs.tnf", "bjs.tnf"];
  for (const fileName of files) {
    const filePath = path.join(t0002, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const buffer = fs.readFileSync(filePath);
      const decoder = new TextDecoder("gb18030");
      for (let offset = 50; offset + 360 <= buffer.length; offset += 360) {
        const code = buffer.subarray(offset, offset + 6).toString("ascii").replace(/\0/g, "").trim();
        if (!isAStockCode(code)) continue;
        const name = decoder.decode(buffer.subarray(offset + 31, offset + 63)).split("\0", 1)[0].trim();
        if (name) map.set(code, name);
      }
    } catch (error) {
      log(`通达信证券名称表读取失败（${fileName}）：${error.message}`);
    }
  }
  return map;
}

function localSectorFallback(sector) {
  const text = String(sector || "").trim();
  const known = {
    "计算机设": "计算机设备",
  };
  return known[text] || text;
}

function limitSectorSortKey(row) {
  const sector = String(row?.sector || "").trim();
  return sector && sector !== "--" ? sector : "未归类";
}

function sortLimitStocksBySector(rows) {
  const items = (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({ row, index, sector: limitSectorSortKey(row) }));
  const sectorCounts = new Map();
  items.forEach((item) => {
    sectorCounts.set(item.sector, (sectorCounts.get(item.sector) || 0) + 1);
  });
  return items
    .sort((a, b) => {
      const aMissing = a.sector === "未归类";
      const bMissing = b.sector === "未归类";
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      const countOrder = (sectorCounts.get(b.sector) || 0) - (sectorCounts.get(a.sector) || 0);
      if (countOrder) return countOrder;
      const sectorOrder = a.sector.localeCompare(b.sector, "zh-CN", { numeric: true, sensitivity: "base" });
      const codeOrder = String(a.row?.code || "").localeCompare(String(b.row?.code || ""), "zh-CN", { numeric: true, sensitivity: "base" });
      const nameOrder = String(a.row?.name || "").localeCompare(String(b.row?.name || ""), "zh-CN", { numeric: true, sensitivity: "base" });
      return sectorOrder || codeOrder || nameOrder || a.index - b.index;
    })
    .map((item) => ({
      ...item.row,
      sectorPeerCount: sectorCounts.get(item.sector) || 1,
    }));
}

function normalizeLimitPoolRows(pool, kind) {
  const byCode = new Map();
  (Array.isArray(pool?.rows) ? pool.rows : [])
    .map((row) => normalizeLimitPoolStock(row, kind))
    .filter((row) => row.code && row.name)
    .forEach((row) => {
      if (!byCode.has(row.code)) byCode.set(row.code, row);
    });
  return sortLimitStocksBySector(
    [...byCode.values()],
  );
}

function safeClistGroup(name, code, fsCode, mode) {
  try {
    return summarizeQuoteGroup(name, code, fetchClist(fsCode, { pageSize: 500, maxPages: 2, fid: "f3" }), mode);
  } catch (error) {
    log(`${name} 成分统计暂未取到：${error.message}`);
    return {
      name,
      boardCode: code,
      count: null,
      limitUpCount: null,
      upCount: null,
      positiveRate: null,
      avgChangePct: null,
      strength: "待更新",
      topSectors: [],
      summary: "接口暂未取到",
    };
  }
}

function previousWeekdayText(dateText) {
  const date = new Date(String(dateText).slice(0, 10) + "T00:00:00");
  if (Number.isNaN(date.getTime())) return "";
  return toLocalDateText(previousWeekdayDate(date));
}

const previousTradingDateCache = new Map();

function tencentIndexTradingDates(limit = 15) {
  const url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get" +
    `?param=sh000001,day,,,${Math.max(5, Number(limit) || 15)},qfq`;
  const json = fetchJson(url, 15);
  const block = json.data?.sh000001 || {};
  const rows = Array.isArray(block.qfqday) ? block.qfqday : Array.isArray(block.day) ? block.day : [];
  return rows.map((row) => String(Array.isArray(row) ? row[0] : ""))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
}

function previousTradingDateText(dateText) {
  const target = String(dateText || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return "";
  if (previousTradingDateCache.has(target)) return previousTradingDateCache.get(target);
  const candidates = [];
  try {
    tencentIndexTradingDates(15).forEach((date) => candidates.push(date));
  } catch (error) {
    log(`上一交易日腾讯日线校验暂不可用：${error.message}`);
  }
  if (!candidates.some((date) => date < target)) {
    try {
      fetchDailyIndexKline("1.000001", target, 15).forEach((row) => candidates.push(row.date));
    } catch (error) {
      log(`上一交易日东方财富日线校验暂不可用：${error.message}`);
    }
  }
  if (!candidates.some((date) => date < target) && CONFIG.tdxVipdocDir) {
    try {
      const localDates = readTdxDayHistory("000001", "sh").map((row) => row.date).filter(Boolean).sort();
      const localPrevious = localDates.filter((date) => date < target).at(-1) || "";
      if (localPrevious === previousWeekdayText(target)) candidates.push(localPrevious);
      else if (localPrevious) log(`本地指数日线停在 ${localPrevious}，不用于判定 ${target} 的上一交易日。`);
    } catch (error) {
      log(`上一交易日本地日线校验暂不可用：${error.message}`);
    }
  }
  const previous = uniqueTextList(candidates)
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date < target)
    .sort()
    .at(-1) || previousWeekdayText(target);
  previousTradingDateCache.set(target, previous);
  return previous;
}

function tencentStockSymbol(row) {
  const code = String(row.c || row.f12 || row.code || "");
  if (!/^\d{6}$/.test(code)) return "";
  if (Number(row.m) === 1 || /^6/.test(code)) return `sh${code}`;
  if (/^(8|4|9)/.test(code)) return `bj${code}`;
  return `sz${code}`;
}

function parseTencentQuoteLine(line) {
  const match = String(line || "").match(/="([^"]*)"/);
  if (!match) return null;
  const parts = match[1].split("~");
  const code = String(parts[2] || "");
  if (!/^\d{6}$/.test(code)) return null;
  const price = finiteNumber(parts[3]);
  const preClose = finiteNumber(parts[4]);
  let changePct = finiteNumber(parts[32]);
  if (!Number.isFinite(changePct) && Number.isFinite(price) && Number.isFinite(preClose) && preClose > 0) {
    changePct = ((price - preClose) / preClose) * 100;
  }
  const amountWan = finiteNumber(parts[37]);
  return {
    code,
    price,
    changePct,
    volume: finiteNumber(parts[6]),
    amount: Number.isFinite(amountWan) ? amountWan * 10000 : null,
    high: finiteNumber(parts[33]),
    low: finiteNumber(parts[34]),
    open: finiteNumber(parts[5]),
    preClose,
    quoteDate: parseCompactDate(String(parts[30] || "").slice(0, 8)),
  };
}

function fetchTencentStockQuotes(poolRows) {
  const symbols = uniqueTextList(poolRows.map(tencentStockSymbol).filter(Boolean));
  const byCode = new Map();
  for (let i = 0; i < symbols.length; i += 80) {
    const batch = symbols.slice(i, i + 80);
    if (!batch.length) continue;
    const url = `https://qt.gtimg.cn/q=${encodeURIComponent(batch.join(","))}`;
    const text = fetchText(url, 12);
    text.split(";").map(parseTencentQuoteLine).filter(Boolean).forEach((quote) => {
      byCode.set(quote.code, quote);
    });
  }
  return byCode;
}

function dedupePoolSourceRows(rows) {
  const byCode = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const code = String(row?.c ?? row?.f12 ?? row?.code ?? "").trim();
    if (!/^\d{6}$/.test(code) || byCode.has(code)) continue;
    byCode.set(code, row);
  }
  return [...byCode.values()];
}

function mergeFreshTencentQuotes(poolRows, tradeDate) {
  const sourceRows = dedupePoolSourceRows(poolRows);
  const quoteMap = fetchTencentStockQuotes(sourceRows);
  const missing = [];
  const rows = sourceRows.map((row) => {
    const code = String(row.c ?? row.f12 ?? row.code ?? "").trim();
    const quote = quoteMap.get(code);
    const fresh = quote && quote.quoteDate === tradeDate && Number.isFinite(quote.price) && quote.price > 0 &&
      Number.isFinite(quote.preClose) && quote.preClose > 0 && Number.isFinite(quote.changePct);
    if (!fresh) {
      missing.push(code);
      return null;
    }
    return {
      ...row,
      f12: code,
      f13: row.f13 ?? row.m ?? row.market,
      f14: row.f14 ?? row.n ?? row.name,
      f2: quote.price,
      f3: quote.changePct,
      f5: quote.volume,
      f6: quote.amount,
      f15: quote.high,
      f16: quote.low,
      f17: quote.open,
      f18: quote.preClose,
      quoteDate: quote.quoteDate,
    };
  }).filter(Boolean);
  if (!sourceRows.length) throw new Error("炸板池没有可识别的股票代码");
  if (missing.length) {
    throw new Error(`腾讯当日行情不完整：${rows.length}/${sourceRows.length}，缺少${missing.slice(0, 8).join("、")}`);
  }
  return rows;
}

function fetchYesterdayBrokenRepairByTopic(tradeDate) {
  const previous = previousTradingDateText(tradeDate);
  if (!previous) throw new Error("无法计算上一交易日");
  const pool = fetchZtbPool("broken", previous, 500);
  const poolRows = dedupePoolSourceRows(pool.rows);
  if (!poolRows.length) throw new Error(`${previous} 炸板池没有返回数据`);
  if (Number.isFinite(pool.total) && pool.total !== poolRows.length) {
    throw new Error(`炸板池返回不完整：${poolRows.length}/${pool.total}`);
  }
  const rows = mergeFreshTencentQuotes(poolRows.map((row) => ({
    ...row,
    f12: row.c,
    f14: row.n,
    f100: row.hybk,
    f103: row.gn || "",
  })), tradeDate);
  if (!rows.length) throw new Error("昨日炸板专题没有返回可展示成分");
  const summary = summarizeQuoteGroup("昨日炸板", "BK1631", rows, "repair");
  summary.stocks = enrichLimitRowsWithBoardInfo(normalizeLimitPoolRows({ rows }, "yesterdayBroken"), { intraday: true });
  const quotedCount = summary.count;
  summary.count = summary.stocks.length;
  summary.quotedCount = quotedCount;
  summary.previousTradeDate = previous;
  summary.poolQuoteDate = pool.qdate || tradeDate;
  summary.source = `上一交易日炸板池 ${previous} + 腾讯 ${tradeDate} 实时行情`;
  summary.summary = `炸板${summary.count}家，今日红盘${summary.upCount}家（${summary.positiveRate.toFixed(1)}%），其中再涨停${summary.limitUpCount}家，平均涨跌${summary.avgChangePct.toFixed(2)}%` +
    (quotedCount === summary.count ? "" : `；有效报价${quotedCount}/${summary.count}`);
  return summary;
}

function fetchYesterdayBrokenRepairByBoard(tradeDate, options = {}) {
  const boardRows = dedupePoolSourceRows(fetchClist("b:BK1631", { pageSize: 500, maxPages: 2, fid: "f3", fields: STOCK_FIELDS }));
  if (!boardRows.length) throw new Error("昨日炸板 BK1631 没有返回成分");
  const previous = previousTradingDateText(tradeDate);
  const topicByCode = new Map();
  if (previous) {
    try {
      const topic = fetchZtbPool("broken", previous, 500);
      (topic.rows || []).forEach((row) => topicByCode.set(String(row.c || ""), row));
    } catch (error) {
      log(`昨日炸板专题结构字段暂未补齐：${error.message}`);
    }
  }
  const mergedRows = boardRows.map((row) => {
    const topic = topicByCode.get(String(row.f12 || ""));
    if (!topic) return row;
    return {
      ...row,
      zbc: topic.zbc,
      fbt: topic.fbt,
      lbt: topic.lbt,
      f100: row.f100 || topic.hybk,
      f103: row.f103 || topic.gn || "",
    };
  });
  const freshRows = mergeFreshTencentQuotes(mergedRows, tradeDate);
  const summary = summarizeQuoteGroup("昨日炸板", "BK1631", freshRows, "repair");
  summary.stocks = enrichLimitRowsWithBoardInfo(
    normalizeLimitPoolRows({ rows: freshRows }, "yesterdayBroken"),
    { intraday: Boolean(options.intraday) },
  );
  const quotedCount = summary.count;
  summary.count = summary.stocks.length;
  summary.quotedCount = quotedCount;
  summary.previousTradeDate = previous;
  summary.source = `东方财富昨日炸板 BK1631 成分 + 腾讯 ${tradeDate} 实时行情`;
  summary.summary = `炸板${summary.count}家，今日红盘${summary.upCount}家（${summary.positiveRate.toFixed(1)}%），其中再涨停${summary.limitUpCount}家，平均涨跌${summary.avgChangePct.toFixed(2)}%` +
    (quotedCount === summary.count ? "" : `；有效报价${quotedCount}/${summary.count}`);
  return summary;
}

function safeYesterdayBrokenRepair(tradeDate, options = {}) {
  const cachedData = readCachedMarketData();
  const cached = cachedData?.market?.yesterdayBroken;
  const cachedComplete = cachedData?.market?.tradeDate === tradeDate &&
    cached && typeof cached === "object" && cached.name && Array.isArray(cached.stocks) &&
    cached.stocks.length && Number(cached.count) === cached.stocks.length &&
    cached.stocks.every((row) => row.quoteDate === tradeDate && Number(row.price) > 0 && Number(row.preClose) > 0);
  try {
    const result = fetchYesterdayBrokenRepairByTopic(tradeDate);
    log(`${options.intraday ? "盘中" : "收盘"}昨日炸板已按真实上一交易日炸板池与当日实时行情校验：${result.summary}`);
    return result;
  } catch (error) {
    log(`上一交易日炸板池与当日行情交叉校验暂未取到：${error.message}`);
  }
  log("上一交易日炸板池暂不可用，尝试 BK1631 成分与腾讯当日行情交叉校验。");
  try {
    const result = fetchYesterdayBrokenRepairByBoard(tradeDate, { intraday: Boolean(options.intraday) });
    log(`昨日炸板 BK1631 备用源校验完成：${result.summary}`);
    return result;
  } catch (error) {
    log(`昨日炸板 BK1631 备用源暂未取到：${error.message}`);
    if (cachedComplete) {
      log("昨日炸板实时接口暂不可用，沿用同交易日上一份完整真实快照。 ");
      return cached;
    }
    return emptyQuoteGroup("昨日炸板", "BK1631", "repair", error.message);
  }
}

function fetchTurnoverStats() {
  const query =
    "fltt=2&invt=2" +
    `&fields=${TURNOVER_FIELDS}` +
    `&secids=${TURNOVER_SECIDS}` +
    `&ut=${EASTMONEY_UT}`;
  const urls = PUSH2_HOSTS.map((host) => `https://${host}/api/qt/ulist.np/get?${query}`);
  const json = fetchJsonFromUrls(urls, "沪深成交额");
  const rows = Array.isArray(json.data?.diff) ? json.data.diff : [];
  const validAmount = rows.map((row) => finiteNumber(row.f6)).filter(Number.isFinite);
  const validVolume = rows.map((row) => finiteNumber(row.f5)).filter(Number.isFinite);
  return {
    totalAmountYi: validAmount.length ? round1(validAmount.reduce((sum, value) => sum + value, 0) / 100000000) : null,
    totalVolumeYiHands: validVolume.length ? round1(validVolume.reduce((sum, value) => sum + value, 0) / 100000000) : null,
  };
}

function safeTurnoverStats() {
  try {
    return fetchTurnoverStats();
  } catch (error) {
    log(`沪深成交额暂未取到：${error.message}`);
    return { totalAmountYi: null, totalVolumeYiHands: null };
  }
}

function lastFinitePointValue(points, field) {
  if (!Array.isArray(points)) return NaN;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const value = finiteNumber(points[i]?.[field]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return NaN;
}

function fallbackTurnoverFromIndexPoints(index, indices = []) {
  const byKey = new Map();
  [index, ...indices].forEach((item) => {
    if (item?.key && !byKey.has(item.key)) byKey.set(item.key, item);
  });
  const targets = ["sh000001", "sz399001"].map((key) => byKey.get(key)).filter(Boolean);
  const amounts = targets.map((item) => lastFinitePointValue(item.points, "amount")).filter(Number.isFinite);
  const volumes = targets.map((item) => lastFinitePointValue(item.points, "volume")).filter(Number.isFinite);
  return {
    totalAmountYi: amounts.length ? round1(amounts.reduce((sum, value) => sum + value, 0) / 100000000) : null,
    totalVolumeYiHands: volumes.length ? round1(volumes.reduce((sum, value) => sum + value, 0) / 100000000) : null,
  };
}

function hasPositiveNumber(value) {
  if (value === null || value === undefined || value === "") return false;
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function applyTurnoverFallback(market, index, indices = []) {
  if (!market) return market;
  const fallback = fallbackTurnoverFromIndexPoints(index, indices);
  let filled = false;
  if (!hasPositiveNumber(market.totalAmountYi) && hasPositiveNumber(fallback.totalAmountYi)) {
    market.totalAmountYi = fallback.totalAmountYi;
    filled = true;
  }
  if (!hasPositiveNumber(market.totalVolumeYiHands) && hasPositiveNumber(fallback.totalVolumeYiHands)) {
    market.totalVolumeYiHands = fallback.totalVolumeYiHands;
    filled = true;
  }
  if (filled) {
    market.turnoverSource = "指数分时累计金额兜底";
    const today = Array.isArray(market.recentDays)
      ? market.recentDays.find((day) => day.date === market.tradeDate)
      : null;
    if (today) {
      if (!hasPositiveNumber(today.totalAmountYi)) today.totalAmountYi = market.totalAmountYi;
      if (!hasPositiveNumber(today.totalVolumeYiHands)) today.totalVolumeYiHands = market.totalVolumeYiHands;
    }
    log(`成交额/量已用上证+深证分时兜底：${market.totalAmountYi ?? "--"}亿，${market.totalVolumeYiHands ?? "--"}亿手。`);
  }
  return market;
}


function formatCompactDate(dateText) {
  return String(dateText || "").replace(/-/g, "");
}

function formatDashedDate(compact) {
  const text = String(compact || "");
  return /^\d{8}$/.test(text) ? text.slice(0, 4) + "-" + text.slice(4, 6) + "-" + text.slice(6, 8) : text;
}

function addCalendarDays(dateText, offset) {
  const date = new Date(String(dateText).slice(0, 10) + "T00:00:00");
  date.setDate(date.getDate() + offset);
  return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
}

function recentWeekdayDates(tradeDate, count = 6) {
  const dates = [];
  let cursor = tradeDate;
  for (let guard = 0; dates.length < count && guard < 18; guard += 1) {
    const day = new Date(cursor + "T00:00:00").getDay();
    if (day !== 0 && day !== 6) dates.push(cursor);
    cursor = addCalendarDays(cursor, -1);
  }
  return dates;
}

function safeZtbTotal(kind, tradeDate) {
  try {
    return fetchZtbPool(kind, tradeDate, 1).total;
  } catch (error) {
    log("历史涨停专题 " + kind + " " + tradeDate + " 暂未取到：" + error.message);
    return null;
  }
}

function fetchDailyIndexKline(secid, endDate, limit) {
  const url =
    "https://push2his.eastmoney.com/api/qt/stock/kline/get" +
    "?secid=" + encodeURIComponent(secid) +
    "&fields1=f1,f2,f3,f4,f5,f6" +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
    "&klt=101&fqt=1&beg=0" +
    "&end=" + formatCompactDate(endDate) +
    "&lmt=" + limit;
  const json = fetchJson(url);
  const rows = Array.isArray(json.data?.klines) ? json.data.klines : [];
  return rows.map((line) => {
    const parts = String(line).split(",");
    return {
      date: parts[0],
      volumeYiHands: round1(Number(parts[5]) / 100000000),
      amountYi: round1(Number(parts[6]) / 100000000),
      changePct: Number(parts[8]),
    };
  }).filter((row) => row.date && Number.isFinite(row.amountYi));
}

function safeHistoricalTurnoverMap(tradeDate, limit) {
  const map = new Map();
  try {
    const sh = fetchDailyIndexKline("1.000001", tradeDate, limit);
    const sz = fetchDailyIndexKline("0.399001", tradeDate, limit);
    for (const row of sh) {
      map.set(row.date, { amountYi: row.amountYi, volumeYiHands: row.volumeYiHands, indexChangePct: row.changePct });
    }
    for (const row of sz) {
      const item = map.get(row.date) || { amountYi: 0, volumeYiHands: 0, indexChangePct: null };
      item.amountYi = round1((Number(item.amountYi) || 0) + row.amountYi);
      item.volumeYiHands = round1((Number(item.volumeYiHands) || 0) + row.volumeYiHands);
      map.set(row.date, item);
    }
  } catch (error) {
    log("历史成交额暂未取到：" + error.message);
  }
  return map;
}

function decodeTextBuffer(buffer, encoding = "utf8") {
  const normalized = String(encoding || "utf8").toLowerCase();
  if (normalized === "utf8" || normalized === "utf-8") return buffer.toString("utf8");
  try {
    return new TextDecoder(normalized).decode(buffer);
  } catch (_) {
    return buffer.toString("utf8");
  }
}

function fetchTextAsync(url, timeoutMs = 15000, redirectDepth = 0, encoding = "utf8") {
  return new Promise((resolve, reject) => {
    const client = /^http:\/\//i.test(url) ? http : https;
    const req = client.get(
      url,
      {
        headers: {
          Referer: "https://quote.eastmoney.com/",
          "User-Agent": "Mozilla/5.0 AShareReview/1.0",
        },
      },
      (res) => {
        const location = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && location && redirectDepth < 3) {
          res.resume();
          const redirected = new URL(location, url).toString();
          fetchTextAsync(redirected, timeoutMs, redirectDepth + 1, encoding).then(resolve, reject);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(decodeTextBuffer(Buffer.concat(chunks), encoding)));
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时 ${timeoutMs}ms`));
    });
    req.on("error", reject);
  });
}

async function fetchJsonAsync(url, label, timeoutMs = 15000) {
  const text = (await fetchTextAsync(url, timeoutMs)).trim();
  const jsonText = /^[\w$]+\(/.test(text) ? text.replace(/^[\w$]+\(/, "").replace(/\);?$/, "") : text;
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`${label} JSON解析失败：${error.message}`);
  }
}

async function fetchJsonAsyncFromUrls(urls, label, timeoutMs = 15000) {
  const errors = [];
  for (const url of urls) {
    try {
      return await fetchJsonAsync(url, label, timeoutMs);
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`${label} 接口连续失败：${errors.slice(-3).join("；")}`);
}

function readCachedClsIndexAnnotations() {
  const indicesPath = path.join(CONFIG.optimizedAppDir, "data", "indices.json");
  try {
    if (fs.existsSync(indicesPath)) {
      const annotations = JSON.parse(fs.readFileSync(indicesPath, "utf8"))?.annotations;
      if (annotations && Array.isArray(annotations.items)) return annotations;
    }
  } catch (_) {
    // Continue to the embedded market-data fallback.
  }
  return readCachedMarketData()?.indexAnnotations || null;
}

async function fetchClsIndexAnnotations(tradeDate, syncedAt) {
  const urls = CLS_INDEX_ANNOTATION_ENDPOINTS.map((baseUrl) => `${baseUrl}?cdate=${encodeURIComponent(tradeDate)}`);
  try {
    const payload = await fetchJsonAsyncFromUrls(urls, "财联社盯盘指数标注", 10000);
    const feed = normalizeClsAnchorPayload(payload, {tradeDate, syncedAt});
    log(`财联社盯盘标注：读取 ${feed.itemCount} 条原始行业/题材板块事件，已排除 ${feed.excludedStockCount || 0} 条个股事件。`);
    return feed;
  } catch (error) {
    const feed = fallbackClsAnnotationFeed(readCachedClsIndexAnnotations(), {
      tradeDate,
      syncedAt,
      error: error.message,
    });
    log(feed.status === "retained"
      ? `财联社盯盘暂不可用，保留同交易日 ${feed.itemCount} 条原始板块标注：${error.message}`
      : `财联社盯盘暂不可用，本轮不显示指数文字标注：${error.message}`);
    return feed;
  }
}

async function fetchJsonAsyncFromFastestUrl(urls, label, timeoutMs = 8000) {
  try {
    return await Promise.any(urls.map((url) => fetchJsonAsync(url, label, timeoutMs)));
  } catch (error) {
    const messages = Array.isArray(error?.errors) ? error.errors.map((item) => item?.message || String(item)) : [error?.message || String(error)];
    throw new Error(`${label} 并发接口全部失败：${messages.slice(-3).join("；")}`);
  }
}

function clistAsyncUrls(fsCode, options, page) {
  const pageSize = options.pageSize || 500;
  const fid = options.fid || "f3";
  const fields = options.fields || QUOTE_FIELDS;
  const query =
    `ut=${EASTMONEY_UT}` +
    `&pn=${page}` +
    `&pz=${pageSize}` +
    "&po=1&np=1&fltt=2&invt=2" +
    `&fid=${encodeURIComponent(fid)}` +
    `&fs=${encodeURIComponent(fsCode)}` +
    `&fields=${encodeURIComponent(fields)}`;
  return PUSH2_HOSTS.map((host) => quoteUrl(host, query));
}

async function fetchClistAsync(fsCode, options = {}) {
  const rows = [];
  const maxPages = options.maxPages || 20;
  const timeoutMs = options.timeoutMs || 15000;
  let total = Infinity;
  for (let page = 1; page <= maxPages && rows.length < total; page += 1) {
    const urls = clistAsyncUrls(fsCode, options, page);
    const json = options.raceHosts
      ? await fetchJsonAsyncFromFastestUrl(urls, `行情列表 ${fsCode}`, timeoutMs)
      : await fetchJsonAsyncFromUrls(urls, `行情列表 ${fsCode}`, timeoutMs);
    const data = json.data || {};
    const diff = Array.isArray(data.diff) ? data.diff : [];
    total = Number(data.total || diff.length || 0);
    rows.push(...diff);
    if (!diff.length || rows.length >= total) break;
  }
  return rows;
}

function parseCompactDate(value) {
  const text = String(value || "").replace(/[^\d]/g, "");
  if (text.length !== 8) return "";
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

function daysBetween(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const start = new Date(`${startDate}T00:00:00+08:00`);
  const end = new Date(`${endDate}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.floor((end - start) / 86400000);
}

function marketIdForCode(code, market) {
  const text = String(code || "");
  const raw = Number(market);
  if (raw === 0 || raw === 1) return raw;
  if (/^(6|9)/.test(text)) return 1;
  return 0;
}

function isAStockCode(code) {
  const text = String(code || "").trim();
  return /^(000|001|002|003|300|301|600|601|603|605|688|689|430|830|831|832|833|834|835|836|837|838|839|870|871|872|873|874|875|876|877|878|879|920)\d{3}$/.test(text);
}

function isAStockCodeForTdxPrefix(code, prefix) {
  const text = String(code || "").trim();
  if (prefix === "sh") return /^(600|601|603|605|688|689)\d{3}$/.test(text);
  if (prefix === "sz") return /^(000|001|002|003|300|301)\d{3}$/.test(text);
  if (prefix === "bj") return /^(430|83\d|87\d|920)\d{3}$/.test(text);
  return false;
}

function stockSecid(stock) {
  return `${marketIdForCode(stock.code, stock.market)}.${stock.code}`;
}

function normalizeStockQuote(row) {
  const code = String(row.f12 || "").trim();
  const concepts = String(row.f103 || "")
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    code,
    market: finiteNumber(row.f13),
    name: String(row.f14 || "").trim(),
    price: finiteNumber(row.f2),
    changePct: finiteNumber(row.f3),
    change: finiteNumber(row.f4),
    volume: finiteNumber(row.f5),
    amount: finiteNumber(row.f6),
    turnover: finiteNumber(row.f8),
    high: finiteNumber(row.f15),
    low: finiteNumber(row.f16),
    open: finiteNumber(row.f17),
    preClose: finiteNumber(row.f18),
    totalMarketValue: finiteNumber(row.f20),
    floatMarketValue: finiteNumber(row.f21),
    ipoDate: parseCompactDate(row.f26),
    sector: String(row.f100 || "").trim(),
    concepts,
  };
}

function stockExcludeReason(stock, tradeDate) {
  if (!/^\d{6}$/.test(stock.code)) return "非6位股票代码";
  if (!isAStockCode(stock.code)) return "非A股股票";
  if (/^(200|900)/.test(stock.code)) return "B股";
  if (/ST|\*ST|退市|退/.test(stock.name)) return "ST或退市整理";
  if (stock.localOnly && tradeDate && stock.quoteDate !== tradeDate) return "停牌或非当前交易日行情";
  if (!Number.isFinite(stock.price) || !Number.isFinite(stock.preClose)) return "停牌或价格缺失";
  if ((Number(stock.volume) || 0) <= 0 || (Number(stock.amount) || 0) <= 0) return "停牌或无成交";
  const listedDays = daysBetween(stock.ipoDate, tradeDate);
  if (listedDays !== null && listedDays < 60) return "上市不足60日";
  return "";
}

function loadLocalTdxStockQuotes() {
  const result = [];
  const localIndustryMap = loadLocalTdxIndustryMap();
  const localConceptMap = loadLocalTdxConceptMap();
  for (const prefix of ["sh", "sz", "bj"]) {
    const dir = path.join(CONFIG.tdxVipdocDir, prefix, "lday");
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      const match = file.match(/^(sh|sz|bj)(\d{6})\.day$/i);
      if (!match) continue;
      const code = match[2];
      if (!isAStockCodeForTdxPrefix(code, prefix)) continue;
      const history = readTdxDayHistory(code, prefix);
      if (history.length < 2) continue;
      const last = history.at(-1);
      const prev = history.at(-2);
      result.push({
        code,
        market: prefix === "sh" ? 1 : 0,
        name: code,
        price: last.close,
        changePct: round2(pctChange(last.close, prev.close)),
        change: round2(last.close - prev.close),
        volume: last.volume,
        amount: last.amount,
        high: last.high,
        low: last.low,
        open: last.open,
        preClose: prev.close,
        ipoDate: history[0].date,
        quoteDate: last.date,
        sector: localIndustryMap.get(code) || "未分类",
        concepts: localConceptMap.get(code) || [],
        localOnly: true,
      });
    }
  }
  return result;
}

function loadBundledAStockUniverse() {
  const candidates = [CONFIG.stockUniversePath, CONFIG.bundledStockUniversePath]
    .filter((filePath, index, values) => filePath && values.indexOf(filePath) === index);
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [];
      const byCode = new Map();
      for (const item of items) {
        const code = String(item?.code || "").trim();
        const prefix = String(item?.prefix || "").toLowerCase() || tencentSymbolForCode(code).slice(0, 2);
        if (!isAStockCodeForTdxPrefix(code, prefix)) continue;
        byCode.set(code, {
          code,
          market: prefix === "sh" ? 1 : 0,
          name: String(item?.name || code),
        });
      }
      if (byCode.size) return [...byCode.values()];
    } catch (error) {
      log(`全 A 基础代码表读取失败（${filePath}）：${error.message}`);
    }
  }
  return [];
}

function tencentSymbolForCode(code) {
  const text = String(code || "");
  if (/^(430|83[0-9]|87[0-9]|920)/.test(text)) return `bj${text}`;
  if (/^(6|9)/.test(text)) return `sh${text}`;
  return `sz${text}`;
}

function parseTencentQuote(line) {
  const match = String(line || "").match(/^v_[a-z]{2}(\d{6})="([^"]*)"/i);
  if (!match) return null;
  const fields = match[2].split("~");
  const code = fields[2] || match[1];
  if (!isAStockCode(code)) return null;
  const price = finiteNumber(fields[3]);
  const preClose = finiteNumber(fields[4]);
  if (!Number.isFinite(price) || !Number.isFinite(preClose) || price <= 0 || preClose <= 0) return null;
  const dateText = parseCompactDate(String(fields[30] || "").slice(0, 8));
  return {
    code,
    name: String(fields[1] || "").trim(),
    price,
    preClose,
    open: finiteNumber(fields[5]),
    high: finiteNumber(fields[33]),
    low: finiteNumber(fields[34]),
    change: finiteNumber(fields[31]),
    changePct: finiteNumber(fields[32]),
    volume: finiteNumber(fields[36]),
    amount: Number.isFinite(finiteNumber(fields[37])) ? round2(finiteNumber(fields[37]) * 10000) : NaN,
    quoteDate: dateText,
    quoteSource: "腾讯实时",
  };
}

async function enrichStocksWithTencentQuotes(stocks) {
  if (!Array.isArray(stocks) || !stocks.length) return stocks;
  const chunks = [];
  for (let i = 0; i < stocks.length; i += 80) chunks.push(stocks.slice(i, i + 80));
  const quoteMap = new Map();
  let errors = 0;
  await mapLimit(chunks, 4, async (chunk) => {
    const symbols = chunk.map((stock) => tencentSymbolForCode(stock.code)).join(",");
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const text = await fetchTextAsync(`https://qt.gtimg.cn/q=${symbols}`, attempt === 1 ? 12000 : 18000, 0, "gb18030");
        text.split(/;\s*/).map(parseTencentQuote).filter(Boolean).forEach((quote) => quoteMap.set(quote.code, quote));
        return;
      } catch (error) {
        if (attempt < 2) {
          await sleep(500);
          continue;
        }
        errors += 1;
        if (errors <= 3) log(`腾讯实时行情批量获取失败：${error.message}`);
      }
    }
  });
  if (!quoteMap.size) return stocks;
  log(`腾讯实时行情补齐：${quoteMap.size}/${stocks.length} 只。`);
  return stocks.map((stock) => {
    const quote = quoteMap.get(stock.code);
    if (!quote) return stock;
    return {
      ...stock,
      ...quote,
      name: quote.name || stock.name,
      sector: stock.sector,
      concepts: stock.concepts,
      ipoDate: stock.ipoDate,
      localOnly: stock.localOnly,
    };
  });
}

async function fetchAllAStockQuotes() {
  const local = loadLocalTdxStockQuotes();
  if (local.length >= MIN_COMPLETE_A_STOCK_COUNT) {
    log(`量化选股：优先使用完整通达信本地股票池 ${local.length} 只。`);
    return await enrichStocksWithTencentQuotes(local);
  }
  const map = new Map();
  const errors = [];
  for (const fsCode of STOCK_LIST_FS_GROUPS) {
    try {
      const rows = await fetchClistAsync(fsCode, { fields: STOCK_FIELDS, pageSize: 500, maxPages: 20, fid: "f3" });
      rows.map(normalizeStockQuote).forEach((stock) => {
        if (isAStockCode(stock.code) && !map.has(stock.code)) map.set(stock.code, stock);
      });
    } catch (error) {
      errors.push(`${fsCode}：${error.message}`);
    }
  }
  if (map.size < MIN_COMPLETE_A_STOCK_COUNT) {
    errors.push(`线上股票池仅取得 ${map.size} 只，低于全A完整性阈值 ${MIN_COMPLETE_A_STOCK_COUNT} 只`);
    if (local.length >= MIN_COMPLETE_A_STOCK_COUNT) {
      log("全A线上股票池不完整，改用完整通达信本地股票池：" + errors.join("；"));
      return await enrichStocksWithTencentQuotes(local);
    }
    const bundled = loadBundledAStockUniverse();
    if (bundled.length >= MIN_COMPLETE_A_STOCK_COUNT) {
      log(`全A线上股票池不完整，改用内置 ${bundled.length} 只代码表并补充腾讯实时行情。`);
      const enriched = await enrichStocksWithTencentQuotes(bundled);
      const quotedCount = enriched.filter((stock) => Number.isFinite(stock.price) && Number.isFinite(stock.preClose)).length;
      if (quotedCount >= MIN_COMPLETE_A_STOCK_COUNT) return enriched;
      errors.push(`内置代码表仅补齐 ${quotedCount} 只有效实时行情`);
    }
    throw new Error("全A股票列表不完整，已停止量化扫描：" + errors.join("；"));
  }
  if (errors.length) log("部分股票池接口暂未取到，但完整性校验已通过：" + errors.join("；"));
  return await enrichStocksWithTencentQuotes([...map.values()]);
}
const MIN_COMPLETE_A_STOCK_COUNT = 4000;

function summarizeMarketBreadth(rows, tradeDate, source) {
  const byCode = new Map();
  for (const row of rows || []) {
    const code = String(row?.code || row?.f12 || "").trim();
    const changePct = finiteNumber(row?.changePct ?? row?.f3);
    if (!isAStockCode(code) || !Number.isFinite(changePct)) continue;
    byCode.set(code, {
      ...row,
      code,
      name: String(row?.name || row?.f14 || "").trim(),
      changePct,
    });
  }
  if (byCode.size < MIN_COMPLETE_A_STOCK_COUNT) {
    throw new Error(`${source}仅取得${byCode.size}只有效 A 股，低于完整性阈值${MIN_COMPLETE_A_STOCK_COUNT}只`);
  }
  let upCount = 0;
  let downCount = 0;
  let flatCount = 0;
  for (const quote of byCode.values()) {
    const changePct = quote.changePct;
    if (changePct > 0) upCount += 1;
    else if (changePct < 0) downCount += 1;
    else flatCount += 1;
  }
  const quotes = [...byCode.values()];
  return {
    tradeDate,
    stockCount: byCode.size,
    upCount,
    downCount,
    flatCount,
    limitDownRows: collectClosedLimitDownRows(quotes, tradeDate),
    source,
  };
}

async function fetchMarketBreadthFromEastmoney(tradeDate) {
  const allAStockFs = STOCK_LIST_FS_GROUPS.join(",");
  const rows = await fetchClistAsync(allAStockFs, {
    fields: "f2,f3,f5,f6,f12,f13,f14,f15,f16,f17,f18,f26,f100,f103",
    pageSize: 6000,
    maxPages: 2,
    fid: "f3",
    timeoutMs: 6000,
    raceHosts: true,
  });
  return summarizeMarketBreadth(rows, tradeDate, "东方财富全 A 实时行情");
}

async function fetchTencentQuoteMapComplete(stocks) {
  const chunks = [];
  for (let index = 0; index < stocks.length; index += 80) chunks.push(stocks.slice(index, index + 80));
  const quoteMap = new Map();
  const failed = [];

  async function fetchChunk(chunk, attempts, retryDelayMs) {
    const symbols = chunk.map((stock) => tencentSymbolForCode(stock.code)).join(",");
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const text = await fetchTextAsync(`https://qt.gtimg.cn/q=${symbols}`, 8000, 0, "gb18030");
        const quotes = text.split(/;\s*/).map(parseTencentQuote).filter(Boolean);
        if (!quotes.length) throw new Error("返回内容中没有有效行情");
        quotes.forEach((quote) => quoteMap.set(quote.code, quote));
        return null;
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await sleep(retryDelayMs * attempt);
      }
    }
    return lastError || new Error("未知错误");
  }

  await mapLimit(chunks, 8, async (chunk, index) => {
    const error = await fetchChunk(chunk, 2, 600);
    if (error) failed.push({ chunk, index, error });
  });

  const finalErrors = [];
  if (failed.length) {
    await mapLimit(failed, 2, async ({ chunk, index }) => {
      const error = await fetchChunk(chunk, 3, 1200);
      if (error) finalErrors.push(`批次${index + 1}：${error.message}`);
    });
  }

  const minimumCoverage = Math.max(MIN_COMPLETE_A_STOCK_COUNT, Math.floor(stocks.length * 0.9));
  if (quoteMap.size < minimumCoverage) {
    const detail = finalErrors.length ? `；${finalErrors.slice(0, 3).join("；")}` : "";
    throw new Error(`腾讯全 A 报价仅取得${quoteMap.size}只，低于覆盖阈值${minimumCoverage}只${detail}`);
  }
  return quoteMap;
}

async function fetchMarketBreadthFromTencent(tradeDate) {
  const localQuotes = loadLocalTdxStockQuotes();
  const bundledUniverse = localQuotes.length >= MIN_COMPLETE_A_STOCK_COUNT ? [] : loadBundledAStockUniverse();
  const local = localQuotes.length >= MIN_COMPLETE_A_STOCK_COUNT ? localQuotes : bundledUniverse;
  if (local.length < MIN_COMPLETE_A_STOCK_COUNT) {
    throw new Error(`本地或内置 A 股基础名单仅${local.length}只，无法发起完整腾讯行情补采`);
  }
  const quoteMap = await fetchTencentQuoteMapComplete(local);
  const metadata = new Map(local.map((stock) => [stock.code, stock]));
  const rows = [...quoteMap.values()]
    .filter((quote) => quote.quoteDate === tradeDate)
    .map((quote) => {
      const stock = metadata.get(quote.code) || {};
      return {
        ...stock,
        ...quote,
        name: quote.name || stock.name || quote.code,
        sector: stock.sector || "",
        concepts: stock.concepts || [],
      };
    });
  const universeSource = localQuotes.length >= MIN_COMPLETE_A_STOCK_COUNT ? "通达信基础名单" : "内置全 A 基础名单";
  return summarizeMarketBreadth(rows, tradeDate, `腾讯全 A 实时行情（${universeSource}）`);
}

function saveMarketBreadthCache(result) {
  if (dryRun || !result) return;
  writeUtf8File(CONFIG.marketBreadthCachePath, JSON.stringify({ ...result, fetchedAt: nowText(), fetchedAtMs: Date.now() }));
}

function readFreshMarketBreadthCache(tradeDate) {
  try {
    if (!fs.existsSync(CONFIG.marketBreadthCachePath)) return null;
    const cached = JSON.parse(fs.readFileSync(CONFIG.marketBreadthCachePath, "utf8"));
    if (cached.tradeDate !== tradeDate) return null;
    const complete = [cached.stockCount, cached.upCount, cached.downCount, cached.flatCount].every((value) => Number.isFinite(Number(value))) &&
      Number(cached.stockCount) === Number(cached.upCount) + Number(cached.downCount) + Number(cached.flatCount);
    if (!complete) return null;
    const now = new Date();
    const minute = now.getHours() * 60 + now.getMinutes();
    const liveTrading = (minute >= 555 && minute <= 690) || (minute >= 780 && minute <= 900);
    const ageMs = Date.now() - Number(cached.fetchedAtMs || 0);
    if (liveTrading && ageMs > 90 * 1000) return null;
    return { ...cached, source: `${cached.source || "全 A 实时行情"}（同日最后真实快照 ${cached.fetchedAt || ""}）` };
  } catch (_) {
    return null;
  }
}

async function fetchMarketBreadth(tradeDate) {
  const errors = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await fetchMarketBreadthFromEastmoney(tradeDate);
      saveMarketBreadthCache(result);
      log(`全市场涨跌家数已补齐：上涨${result.upCount}、下跌${result.downCount}、平盘${result.flatCount}。`);
      return result;
    } catch (error) {
      errors.push(`东方财富第${attempt}次：${error.message}`);
      if (attempt < 2) await sleep(800);
    }
  }
  log(`东方财富全 A 市场广度暂不可用，切换腾讯补采：${errors.at(-1)}`);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await fetchMarketBreadthFromTencent(tradeDate);
      saveMarketBreadthCache(result);
      log(`腾讯全市场涨跌家数已补齐：上涨${result.upCount}、下跌${result.downCount}、平盘${result.flatCount}。`);
      return result;
    } catch (error) {
      errors.push(`腾讯第${attempt}次：${error.message}`);
      if (attempt < 3) await sleep(1200 * attempt);
    }
  }
  const cached = readFreshMarketBreadthCache(tradeDate);
  if (cached) {
    log(`实时行情接口暂时抖动，使用同交易日最后真实市场广度快照：${cached.fetchedAt}`);
    return cached;
  }
  throw new Error(`全市场涨跌家数补采失败：${errors.join("；")}`);
}

function loadQuantCache() {
  if (!fs.existsSync(CONFIG.quantCachePath)) {
    return { version: 1, updatedAt: "", histories: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG.quantCachePath, "utf8"));
    return {
      version: 1,
      updatedAt: parsed.updatedAt || "",
      histories: parsed.histories && typeof parsed.histories === "object" ? parsed.histories : {},
    };
  } catch (error) {
    log("量化日线缓存读取失败，将重新生成：" + error.message);
    return { version: 1, updatedAt: "", histories: {} };
  }
}

function saveQuantCache(cache) {
  if (dryRun) return;
  ensureDir(path.dirname(CONFIG.quantCachePath));
  cache.updatedAt = nowText();
  fs.writeFileSync(CONFIG.quantCachePath, JSON.stringify(cache), "utf8");
}


function loadQuantBusinessCache() {
  if (!fs.existsSync(CONFIG.quantBusinessCachePath)) {
    return { version: 1, updatedAt: "", items: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG.quantBusinessCachePath, "utf8"));
    return {
      version: 1,
      updatedAt: parsed.updatedAt || "",
      items: parsed.items && typeof parsed.items === "object" ? parsed.items : {},
    };
  } catch (error) {
    log("公司业务缓存读取失败，将重新生成：" + error.message);
    return { version: 1, updatedAt: "", items: {} };
  }
}

function saveQuantBusinessCache(cache) {
  if (dryRun) return;
  ensureDir(path.dirname(CONFIG.quantBusinessCachePath));
  cache.updatedAt = nowText();
  fs.writeFileSync(CONFIG.quantBusinessCachePath, JSON.stringify(cache), "utf8");
}

function loadQuantNewsCache() {
  if (!fs.existsSync(CONFIG.quantNewsCachePath)) {
    return { version: 1, updatedAt: "", items: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG.quantNewsCachePath, "utf8"));
    return {
      version: 1,
      updatedAt: parsed.updatedAt || "",
      items: parsed.items && typeof parsed.items === "object" ? parsed.items : {},
    };
  } catch (error) {
    log("公司最新事件缓存读取失败，将重新生成：" + error.message);
    return { version: 1, updatedAt: "", items: {} };
  }
}

function saveQuantNewsCache(cache) {
  if (dryRun) return;
  ensureDir(path.dirname(CONFIG.quantNewsCachePath));
  cache.updatedAt = nowText();
  fs.writeFileSync(CONFIG.quantNewsCachePath, JSON.stringify(cache), "utf8");
}

function compactNewsText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .replace(/　+/g, " ")
    .trim();
}

function loadPolicyNewsCache() {
  if (!fs.existsSync(CONFIG.policyNewsCachePath)) return {version: 1, fetchedAtMs: 0, data: null};
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG.policyNewsCachePath, "utf8"));
    return {
      version: 1,
      fetchedAtMs: Number(parsed?.fetchedAtMs) || 0,
      data: parsed?.data && typeof parsed.data === "object" ? parsed.data : null,
    };
  } catch (error) {
    log("政策新闻缓存读取失败，将重新生成：" + error.message);
    return {version: 1, fetchedAtMs: 0, data: null};
  }
}

function savePolicyNewsCache(cache) {
  if (dryRun) return;
  ensureDir(path.dirname(CONFIG.policyNewsCachePath));
  fs.writeFileSync(CONFIG.policyNewsCachePath, JSON.stringify(cache), "utf8");
}

function eastmoneyPolicyNewsUrl(keyword, pageSize = 20) {
  const param = {
    uid: "",
    keyword,
    type: ["cmsArticleWebOld"],
    client: "web",
    clientType: "web",
    clientVersion: "curr",
    param: {
      cmsArticleWebOld: {
        searchScope: "default",
        sort: "time",
        pageIndex: 1,
        pageSize,
        preTag: "",
        postTag: "",
      },
    },
  };
  return "https://search-api-web.eastmoney.com/search/jsonp?cb=jQueryPolicyNews&param=" +
    encodeURIComponent(JSON.stringify(param)) + "&_=" + Date.now();
}

async function fetchPolicyNewsRows(query) {
  const failures = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const json = await fetchJsonAsync(eastmoneyPolicyNewsUrl(query.keyword, 40), `政策新闻 ${query.keyword}`, 20000);
      return Array.isArray(json?.result?.cmsArticleWebOld) ? json.result.cmsArticleWebOld : [];
    } catch (error) {
      failures.push(error.message);
      if (attempt < 3) await sleep(350 * attempt);
    }
  }
  throw new Error(failures.slice(-2).join("；"));
}

function policyNewsTime(value) {
  const text = compactNewsText(value);
  if (!text) return null;
  const parsed = new Date(text.replace(/-/g, "/")).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function policyNewsSourceScore(source) {
  const value = compactNewsText(source);
  if (/中国政府网|国务院|发改委网站|人民银行|央行网站|证监会网站|财政部网站|商务部网站|工信部网站|国家统计局|新华社|新华网|人民日报|央视新闻|中国人大网/.test(value)) return 28;
  if (/中国证券报|中证金牛座|上海证券报|证券时报|证券日报|财联社|第一财经|经济日报|中国新闻网|每日经济新闻|21世纪经济报道|券商中国|路透|彭博/.test(value)) return 18;
  if (/证券|财经|金融|经济|财讯|财新/.test(value)) return 10;
  return 4;
}

function matchingPolicyThemes(text, themes) {
  return (themes || []).filter((theme) => theme.keywords.some((keyword) => text.includes(keyword)));
}

function concisePolicySummary(content, fallback) {
  const cleaned = compactNewsText(content);
  if (!cleaned) return compactNewsText(fallback);
  const firstSentence = (cleaned.match(/^[^。！？]+[。！？]?/) || [cleaned])[0].trim();
  if (firstSentence.length <= 220) return firstSentence.replace(/[；，,]$/, "。") || compactNewsText(fallback);
  const clauses = firstSentence.split(/[，,；;]/).map((item) => item.trim()).filter(Boolean);
  let selected = "";
  for (const clause of clauses) {
    const next = selected ? selected + "，" + clause : clause;
    if (next.length > 190) break;
    selected = next;
  }
  return (selected || compactNewsText(fallback)).replace(/[。！？]?$/, "。");
}

function policyImpact(text) {
  const positive = /支持|加快|扩大|增长|增持|降准|降息|减税|补贴|放宽|批复|落地|突破|上调|停火|达成|恢复/.test(text);
  const negative = /制裁|关税|加息|禁运|限制|收紧|冲突|袭击|中断|下调|衰退|风险|调查|反倾销/.test(text);
  if (positive && negative) return {label: "双向影响", tone: "mixed"};
  if (positive) return {label: "偏正向", tone: "positive"};
  if (negative) return {label: "偏负向", tone: "negative"};
  return {label: "待观察", tone: "watch"};
}

function policyNewsId(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `pn-${(hash >>> 0).toString(36)}`;
}

function policyFoundationItems() {
  return POLICY_PLAN_FOUNDATION_NEWS.map((item) => ({
    ...item,
    id: policyNewsId(item.url || item.title),
    scope: "domestic",
    publishedMs: policyNewsTime(item.publishedAt),
    impact: "规划基准",
    impactTone: "watch",
    score: 120,
    importance: 5,
    query: "官方规划基准",
    foundation: true,
  })).filter((item) => Number.isFinite(item.publishedMs));
}

function policyTitleFingerprint(value) {
  return compactNewsText(value)
    .replace(/重磅|最新|突发|利好来了|官方|权威|全文|解读|十大要点|梳理/g, "")
    .replace(/[\s，。！？；：、“”‘’（）()《》【】\-—_]/g, "")
    .toLowerCase();
}

function policyTitleBigrams(value) {
  const text = policyTitleFingerprint(value);
  const grams = new Set();
  for (let index = 0; index < text.length - 1; index += 1) grams.add(text.slice(index, index + 2));
  return grams;
}

function policyTitleSimilarity(left, right) {
  const a = policyTitleBigrams(left);
  const b = policyTitleBigrams(right);
  if (!a.size || !b.size) return policyTitleFingerprint(left) === policyTitleFingerprint(right) ? 1 : 0;
  let intersection = 0;
  a.forEach((item) => { if (b.has(item)) intersection += 1; });
  return intersection / (a.size + b.size - intersection);
}

function policyNewsNoiseSignals(titleValue, textValue) {
  const title = compactNewsText(titleValue);
  const text = compactNewsText(textValue || titleValue);
  return {
    opinionNoise: /机构看好|后市怎么走|下周怎么走|A股.*怎么走|局势突变|策略|研报|盘前|盘后|行情展望|投资机会|概念股|个股推荐|如何布局|如何交易|财报季|基金|高盛|小摩|中金|证券[:：]|券商|分析师|经济学家|业内称|何去何从|市场或|预警|警报|不容忽视|无后顾之忧|重磅|超级周|大变数|突传|研选日报|一文了解|央行圆桌汇|美联储喉舌|面临.*抉择|估值|盈利概率|狂飙|大火|利好齐袭|大消息|今夜看点|环球市场|窗口期|一夜变天|棘手难题|或将爆发/.test(title),
    marketNoise: /收评|复盘|盘点|午评|午报|早报|晚报|盘面|行情|涨停|跌停|ETF|个股|主力资金|资金逆势|交投活跃|投资舆情|三大指数|期指|纽约股市|环球财经|股指.*涨跌|板块.*(走强|拉升|爆发|调整|承压)|市场全线|全球市场.*震动|市场.*押注|美债.*走强|股市全线|股市.*跳水|港股|美股|金价.*(涨|跌)|油价.*(大涨|直线|回吐)|商品日报|债市观察/.test(title),
    companyNoise: /预计.*净利润|净利.*预增|归属于上市公司股东|业绩预告|业绩会|业绩说明会|投资者关系|机构调研|公司回应|董秘|财报解读|股东减持|股东增持|公司公告|龙虎榜|主力资金|股票交易异常波动|上市来首亏|增收不增利|出租率|亏损|临床.*成果|(?:集团|控股|股份|有限公司).*(?:业绩|收入|营收|利润|成果|亮相)|\b\d{6}\b/.test(text),
  };
}

function normalizePolicyNewsItem(item, query) {
  const title = compactNewsText(item?.title);
  const content = compactNewsText(item?.content);
  const source = compactNewsText(item?.mediaName || item?.source);
  const url = compactNewsText(item?.url);
  const publishedAt = compactNewsText(item?.date);
  const publishedMs = policyNewsTime(publishedAt);
  if (!title || !publishedMs || !/^https?:\/\//i.test(url)) return null;
  const ageMs = Date.now() - publishedMs;
  if (ageMs < -24 * 60 * 60 * 1000 || ageMs > POLICY_NEWS_MAX_AGE_MS) return null;
  const text = `${title} ${content} ${source}`;
  const {opinionNoise, marketNoise, companyNoise} = policyNewsNoiseSignals(title, text);
  const action = /发布|印发|批复|出台|通过|决定|审议|征求意见|修订|实施|启动|部署|签署|达成|上调|下调|降准|降息|加息|制裁|关税|禁运|停火|冲突|减产|增产|报告/.test(text);
  const titleAction = /发布|印发|批复|出台|通过|决定|审议|征求意见|修订|实施|启动|部署|签署|达成|上调|下调|降准|降息|加息|制裁|关税|禁运|停火|冲突|袭击|减产|增产|报告|数据|决议/.test(title);
  const recencyScore = ageMs <= 24 * 60 * 60 * 1000 ? 24 : ageMs <= 72 * 60 * 60 * 1000 ? 16 : 8;
  const sourceScore = policyNewsSourceScore(source);
  const impact = policyImpact(text);

  if (query.scope === "domestic") {
    const themes = matchingPolicyThemes(text, POLICY_PLAN_THEMES);
    const titleThemes = matchingPolicyThemes(title, POLICY_PLAN_THEMES);
    const authority = /国务院|国家发展改革委|发改委|中国人民银行|央行|证监会|财政部|商务部|工信部|国家统计局|全国人大|中央政治局|国常会/.test(text);
    const titleAuthority = /国务院|国家发展改革委|发改委|中国人民银行|央行|证监会|财政部|商务部|工信部|国家统计局|全国人大|中央政治局|国常会|\d+部门|多部门|部门联合/.test(title);
    const explicitPlans = POLICY_PLAN_REFERENCES.map((plan) => plan.id).filter((plan) => text.includes(plan));
    const titleExplicitPlans = POLICY_PLAN_REFERENCES.map((plan) => plan.id).filter((plan) => title.includes(plan));
    const namedPolicy = /《[^》]*(规划|意见|方案|办法|条例|措施|纲要)[^》]*》/.test(title);
    const titlePolicySignal = titleExplicitPlans.length || namedPolicy || (titleAuthority && titleAction);
    if (!themes.length || !titlePolicySignal || (!titleThemes.length && !explicitPlans.length && !titleAuthority) || (!action && !authority) || companyNoise || marketNoise || opinionNoise) return null;
    let score = recencyScore + sourceScore + Math.min(22, themes.length * 7) + (action ? 14 : 0) + (authority ? 12 : 0) + (explicitPlans.length ? 12 : 0) - (opinionNoise ? 28 : 0);
    if (score < 56) return null;
    const sectors = uniqueTextList(themes.flatMap((theme) => theme.sectors)).slice(0, 7);
    const plans = explicitPlans.length ? explicitPlans : query.plan ? [query.plan] : ["十五五"];
    const themeLabels = uniqueTextList(themes.map((theme) => theme.label));
    const reason = `命中${plans.join("、")}规划中的“${themeLabels.slice(0, 2).join("、")}”主线；可能通过政策投入、产业需求或监管规则影响${sectors.slice(0, 5).join("、")}。`;
    return {
      id: policyNewsId(url || title), scope: "domestic", title, summary: concisePolicySummary(content, title), source, url, publishedAt, publishedMs,
      plans, themes: themeLabels, sectors, reason, impact: impact.label, impactTone: impact.tone, score: round1(score), importance: score >= 90 ? 5 : score >= 76 ? 4 : 3,
      query: query.keyword,
    };
  }

  const themes = matchingPolicyThemes(text, POLICY_GLOBAL_THEMES);
  const titleThemes = matchingPolicyThemes(title, POLICY_GLOBAL_THEMES);
  const globalEntity = /美联储|欧洲央行|日本央行|美国政府|欧盟|OPEC|欧佩克|WTO|IMF|世界银行|俄罗斯|乌克兰|以色列|伊朗|中东/.test(text);
  const titleGlobalEntity = /美联储|欧洲央行|日本央行|美国政府|欧盟|OPEC|欧佩克|WTO|IMF|世界银行|俄罗斯|乌克兰|以色列|伊朗|中东|霍尔木兹|红海/.test(title);
  const eventSignal = titleAction || /爆炸|遇袭|封锁|中断|通胀|非农|PMI|收益率/.test(title);
  const requiresNamedEntity = titleThemes.some((theme) => ["全球利率", "贸易与关税", "全球科技规则", "全球增长"].includes(theme.label));
  if (!themes.length || !titleThemes.length || (requiresNamedEntity && !titleGlobalEntity) || (!eventSignal && !titleGlobalEntity) || (!action && !globalEntity) || companyNoise || marketNoise || opinionNoise) return null;
  let score = recencyScore + sourceScore + Math.min(24, themes.length * 9) + (action ? 14 : 0) + (globalEntity ? 10 : 0);
  if (score < 50) return null;
  const sectors = uniqueTextList(themes.flatMap((theme) => theme.sectors)).slice(0, 7);
  const themeLabels = uniqueTextList(themes.map((theme) => theme.label));
  const channels = uniqueTextList(themes.map((theme) => theme.channel)).slice(0, 2);
  const reason = `属于“${themeLabels.slice(0, 2).join("、")}”关键事件，可能通过${channels.join("及")}传导至${sectors.slice(0, 5).join("、")}。`;
  return {
    id: policyNewsId(url || title), scope: "international", title, summary: concisePolicySummary(content, title), source, url, publishedAt, publishedMs,
    plans: [], themes: themeLabels, sectors, reason, impact: impact.label, impactTone: impact.tone, score: round1(score), importance: score >= 86 ? 5 : score >= 72 ? 4 : 3,
    query: query.keyword,
  };
}

function dedupePolicyNewsItems(items, maximumPerScope = POLICY_NEWS_MAX_ITEMS_PER_SCOPE) {
  const result = [];
  const themeCounts = new Map();
  const ranked = [...(items || [])].filter(Boolean).sort((a, b) => Number(Boolean(b.foundation)) - Number(Boolean(a.foundation)) || b.score - a.score || b.publishedMs - a.publishedMs);
  for (const item of ranked) {
    const duplicate = result.some((existing) => {
      if (existing.url === item.url) return true;
      if (existing.scope !== item.scope || policyTitleSimilarity(existing.title, item.title) < .52) return false;
      return !(existing.foundation && item.foundation);
    });
    if (duplicate) continue;
    const primaryTheme = item.themes?.[0] || "其他";
    const themeKey = `${item.scope}:${primaryTheme}`;
    if (!item.foundation && (themeCounts.get(themeKey) || 0) >= 9) continue;
    if (result.filter((existing) => existing.scope === item.scope).length >= maximumPerScope) continue;
    result.push(item);
    if (!item.foundation) themeCounts.set(themeKey, (themeCounts.get(themeKey) || 0) + 1);
  }
  return result.sort((a, b) => b.publishedMs - a.publishedMs || b.importance - a.importance || b.score - a.score);
}

function reusablePolicyNewsItem(item) {
  if (!Number.isFinite(Number(item?.publishedMs))) return false;
  if (item.foundation) return true;
  if (Date.now() - Number(item.publishedMs) > POLICY_NEWS_MAX_AGE_MS) return false;
  const title = compactNewsText(item.title);
  const signals = policyNewsNoiseSignals(title, `${title} ${item.summary || ""} ${item.source || ""}`);
  if (signals.opinionNoise || signals.marketNoise || signals.companyNoise) return false;
  if (item.scope === "domestic") {
    const authority = /国务院|中国政府网|国家发展改革委|发改委|中国人民银行|央行|证监会|财政部|商务部|工信部|国家统计局|全国人大|中央政治局|国常会|\d+部门|多部门/.test(`${title} ${item.source || ""}`);
    const policyAction = /发布|印发|批复|出台|通过|决定|审议|征求意见|修订|实施|启动|部署|规划|纲要|条例|办法|方案|措施|报告/.test(title);
    return Boolean((item.themes || []).length && (authority || (item.plans || []).length) && policyAction);
  }
  const majorEntity = /美联储|欧洲央行|日本央行|美国政府|白宫|美国|欧盟|OPEC|欧佩克|WTO|IMF|世界银行|俄罗斯|乌克兰|以色列|伊朗|中东|霍尔木兹|红海|沙特|胡塞|俄乌/.test(title);
  const eventAction = /关税|制裁|禁运|停火|冲突|袭击|空袭|封锁|中断|减产|增产|原油|天然气|利率|通胀|非农|PMI|出口管制|贸易协议|决议|报告|数据/.test(title);
  return Boolean((item.themes || []).length && majorEntity && eventAction);
}

function emptyPolicyNewsData(error = "") {
  return {
    version: 1,
    filterVersion: POLICY_NEWS_FILTER_VERSION,
    generatedAt: nowText(),
    status: error ? "error" : "empty",
    error,
    refreshMinutes: 10,
    retentionDays: POLICY_NEWS_RETENTION_DAYS,
    sourceNote: `普通国内外关键新闻滚动保留${POLICY_NEWS_RETENTION_DAYS}天，十三五、十四五、十五五官方纲要及关键实施评估文件永久保留；新闻按发布时间排序，同一事件去重，不使用传闻、荐股观点、盘面复述或个股业绩噪声。`,
    planReferences: POLICY_PLAN_REFERENCES,
    stats: {rawCount: 0, domesticCount: 0, internationalCount: 0, foundationCount: 0, historicalCount: 0, dateCount: 0, oldestDate: "", latestDate: "", querySuccess: 0, queryErrors: POLICY_NEWS_QUERIES.length},
    items: [],
  };
}

async function buildPolicyNewsData(options = {}) {
  const cache = loadPolicyNewsCache();
  const forceRefresh = options.forceRefresh || policyNewsForce;
  if (!forceRefresh && cache.data?.filterVersion === POLICY_NEWS_FILTER_VERSION && Date.now() - cache.fetchedAtMs < POLICY_NEWS_CACHE_MS) {
    return {...cache.data, servedFromCache: true};
  }
  const rawItems = [];
  const errors = [];
  await mapLimit(POLICY_NEWS_QUERIES, 3, async (query) => {
    try {
      const rows = await fetchPolicyNewsRows(query);
      rows.forEach((item) => rawItems.push({item, query}));
    } catch (error) {
      errors.push(`${query.keyword}：${error.message}`);
    }
  });
  const freshItems = dedupePolicyNewsItems(rawItems.map(({item, query}) => normalizePolicyNewsItem(item, query)).filter(Boolean));
  const reusable = (cache.data?.items || []).filter(reusablePolicyNewsItem);
  const items = dedupePolicyNewsItems([...policyFoundationItems(), ...freshItems, ...reusable]);
  if (!items.length && cache.data) {
    return {...cache.data, status: "cached", servedFromCache: true, error: errors.slice(0, 3).join("；")};
  }
  const data = emptyPolicyNewsData();
  data.generatedAt = nowText();
  data.status = errors.length ? "partial" : "ok";
  data.error = errors.length ? `${errors.length}个检索词暂时失败，已保留其余有效结果。` : "";
  const newsDates = uniqueTextList(items.map((item) => String(item.publishedAt || "").slice(0, 10)).filter(Boolean)).sort();
  data.stats = {
    rawCount: rawItems.length,
    domesticCount: items.filter((item) => item.scope === "domestic").length,
    internationalCount: items.filter((item) => item.scope === "international").length,
    keyCount: items.filter((item) => item.importance >= 4).length,
    foundationCount: items.filter((item) => item.foundation).length,
    historicalCount: items.filter((item) => Date.now() - Number(item.publishedMs) > 24 * 60 * 60 * 1000).length,
    dateCount: newsDates.length,
    oldestDate: newsDates[0] || "",
    latestDate: newsDates.at(-1) || "",
    querySuccess: POLICY_NEWS_QUERIES.length - errors.length,
    queryErrors: errors.length,
  };
  data.items = items;
  if (options.persist !== false && items.length) savePolicyNewsCache({version: 1, fetchedAtMs: Date.now(), data});
  return data;
}

function eastmoneyCompanyNewsUrl(keyword, pageSize = 5) {
  const param = {
    uid: "",
    keyword,
    type: ["cmsArticleWebOld"],
    client: "web",
    clientType: "web",
    clientVersion: "curr",
    param: {
      cmsArticleWebOld: {
        searchScope: "default",
        sort: "default",
        pageIndex: 1,
        pageSize,
        preTag: "",
        postTag: "",
      },
    },
  };
  return "https://search-api-web.eastmoney.com/search/jsonp?cb=jQueryQuantNews&param=" +
    encodeURIComponent(JSON.stringify(param)) + "&_=" + Date.now();
}

function normalizeCompanyNewsItem(item) {
  const title = compactNewsText(item?.title);
  if (!title) return null;
  return {
    date: compactNewsText(item?.date),
    title,
    content: completeEventLead(compactNewsText(item?.content)),
    source: compactNewsText(item?.mediaName || item?.source),
    url: compactNewsText(item?.url),
  };
}

function companyNewsCacheKey(row) {
  return String(row?.code || "") + "|" + String(row?.name || "");
}

function companyNewsCacheFresh(cached) {
  const fetchedAtMs = Number(cached?.fetchedAtMs);
  return Array.isArray(cached?.events) && cached.events.length > 0 && Number.isFinite(fetchedAtMs) && Date.now() - fetchedAtMs < 20 * 60 * 1000;
}

async function fetchCompanyEvents(row, cache, stats = {}) {
  const key = companyNewsCacheKey(row);
  const cached = cache.items[key];
  if (companyNewsCacheFresh(cached)) {
    stats.companyEventCache = (stats.companyEventCache || 0) + 1;
    return Array.isArray(cached.events) ? cached.events : [];
  }
  const keywords = uniqueTextList([row?.name, row?.code]).filter(Boolean);
  const events = [];
  for (const keyword of keywords) {
    try {
      const json = await fetchJsonAsync(eastmoneyCompanyNewsUrl(keyword, 6), "公司最新事件 " + keyword, 12000);
      const list = Array.isArray(json?.result?.cmsArticleWebOld) ? json.result.cmsArticleWebOld : [];
      list.map(normalizeCompanyNewsItem).filter(Boolean).forEach((event) => {
        const text = event.title + " " + event.content;
        if (row?.name && !text.includes(row.name) && row?.code && !text.includes(row.code)) return;
        if (!events.some((existing) => existing.title === event.title && existing.date === event.date)) {
          events.push(event);
        }
      });
      if (events.length) break;
    } catch (error) {
      stats.companyEventErrors = (stats.companyEventErrors || 0) + 1;
      if ((stats.companyEventErrors || 0) <= 8) log(`公司最新事件获取失败 ${row.code} ${row.name}：${error.message}`);
    }
  }
  const picked = events.slice(0, 3);
  cache.items[key] = {
    code: row.code,
    name: row.name,
    events: picked,
    fetchedAt: nowText(),
    fetchedAtMs: Date.now(),
  };
  if (picked.length) stats.companyEventFetched = (stats.companyEventFetched || 0) + 1;
  else stats.companyEventMissing = (stats.companyEventMissing || 0) + 1;
  return picked;
}

async function enrichQuantCompanyEvents(rows, stats) {
  const selected = Array.isArray(rows) ? rows.filter((row) => row && row.code) : [];
  if (!selected.length) return;
  const cache = loadQuantNewsCache();
  const byCode = new Map();
  selected.forEach((row) => {
    if (!byCode.has(row.code)) byCode.set(row.code, row);
  });
  await mapLimit([...byCode.values()], 5, async (row) => {
    row.companyEvents = await fetchCompanyEvents(row, cache, stats);
  });
  selected.forEach((row) => {
    const primary = byCode.get(row.code);
    row.companyEvents = Array.isArray(primary?.companyEvents) ? primary.companyEvents : [];
  });
  saveQuantNewsCache(cache);
}

function f10MarketPrefix(stock) {
  const code = String(stock?.code || "");
  if (/^(430|83[0-9]|87[0-9]|920)/.test(code)) return "BJ";
  if (/^(6|9)/.test(code)) return "SH";
  return "SZ";
}

function f10Code(stock) {
  return f10MarketPrefix(stock) + String(stock?.code || "");
}

function companySurveyUrl(stock) {
  return "https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax?code=" + encodeURIComponent(f10Code(stock));
}

function compactBusinessText(value) {
  return String(value || "")
    .replace(/\s+/g, "")
    .replace(/公司简介[:：]?/g, "")
    .replace(/业务概览[:：]?/g, "")
    .trim();
}

function truncateBusinessIntro(value, maxLength = 96) {
  const text = compactBusinessText(value);
  if (!text) return "";
  return text.length > maxLength ? text.slice(0, maxLength - 1) + "…" : text;
}

function fallbackBusinessIntro(stock) {
  const sector = stock?.sector && stock.sector !== "本地通达信" ? stock.sector : "未分类";
  const concepts = Array.isArray(stock?.concepts) && stock.concepts.length ? "；相关概念：" + stock.concepts.slice(0, 3).join("、") : "";
  return "主营方向与" + sector + "相关" + concepts;
}

function pickBusinessIntro(json, stock) {
  const profile = json?.jbzl || {};
  const intro = truncateBusinessIntro(profile.gsjj, 110);
  if (intro) return intro;
  const scope = truncateBusinessIntro(profile.jyfw, 96);
  if (scope) return scope;
  return fallbackBusinessIntro(stock);
}

async function fetchBusinessIntro(stock, cache, stats) {
  const key = f10Code(stock);
  const cached = cache.items[key];
  if (cached && cached.businessIntro) {
    stats.businessIntroCache += 1;
    return cached.businessIntro;
  }
  try {
    const json = await fetchJsonAsync(companySurveyUrl(stock), "公司业务 " + stock.code, 12000);
    const businessIntro = pickBusinessIntro(json, stock);
    cache.items[key] = {
      code: stock.code,
      name: stock.name,
      businessIntro,
      fetchedAt: nowText(),
    };
    stats.businessIntroFetched += 1;
    return businessIntro;
  } catch (error) {
    stats.businessIntroFallback += 1;
    return fallbackBusinessIntro(stock);
  }
}

async function enrichQuantBusinessIntros(rows, stats) {
  const selected = Array.isArray(rows) ? rows.filter((row) => row && row.code) : [];
  if (!selected.length) return;
  const cache = loadQuantBusinessCache();
  const byCode = new Map();
  selected.forEach((row) => {
    if (!byCode.has(row.code)) byCode.set(row.code, row);
  });
  await mapLimit([...byCode.values()], 6, async (row) => {
    row.businessIntro = await fetchBusinessIntro(row, cache, stats);
  });
  selected.forEach((row) => {
    const primary = byCode.get(row.code);
    if (primary && primary.businessIntro) row.businessIntro = primary.businessIntro;
    if (!row.businessIntro) row.businessIntro = fallbackBusinessIntro(row);
  });
  saveQuantBusinessCache(cache);
}


function tdxDayPath(code) {
  const text = String(code || "");
  const prefix = /^(430|83[0-9]|87[0-9]|920)/.test(text) ? "bj" : /^(6|9)/.test(text) ? "sh" : "sz";
  return path.join(CONFIG.tdxVipdocDir, prefix, "lday", `${prefix}${code}.day`);
}

function readTdxDayHistory(code, preferredPrefix = "") {
  const safePrefix = /^(sh|sz|bj)$/.test(preferredPrefix) ? preferredPrefix : "";
  const filePath = safePrefix
    ? path.join(CONFIG.tdxVipdocDir, safePrefix, "lday", `${safePrefix}${code}.day`)
    : tdxDayPath(code);
  if (!fs.existsSync(filePath)) return [];
  const buf = fs.readFileSync(filePath);
  const rows = [];
  for (let offset = 0; offset + 32 <= buf.length; offset += 32) {
    const rawDate = String(buf.readInt32LE(offset));
    if (rawDate.length !== 8) continue;
    rows.push({
      date: parseCompactDate(rawDate),
      open: round2(buf.readInt32LE(offset + 4) / 100),
      high: round2(buf.readInt32LE(offset + 8) / 100),
      low: round2(buf.readInt32LE(offset + 12) / 100),
      close: round2(buf.readInt32LE(offset + 16) / 100),
      amount: Math.round(Number(buf.readFloatLE(offset + 20)) || 0),
      volume: buf.readInt32LE(offset + 24),
    });
  }
  return rows.filter((row) => row.date && row.close > 0);
}

function stockKlineUrl(stock, limit) {
  return (
    "https://push2his.eastmoney.com/api/qt/stock/kline/get" +
    "?secid=" + encodeURIComponent(stockSecid(stock)) +
    "&fields1=f1,f2,f3,f4,f5,f6" +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" +
    "&klt=101&fqt=1&beg=0&end=20500101" +
    "&lmt=" + encodeURIComponent(limit)
  );
}

function parseStockKlines(lines) {
  return lines.map((line) => {
    const parts = String(line).split(",");
    return {
      date: parts[0],
      open: Number(parts[1]),
      close: Number(parts[2]),
      high: Number(parts[3]),
      low: Number(parts[4]),
      volume: Number(parts[5]),
      amount: Number(parts[6]),
      amplitude: Number(parts[7]),
      changePct: Number(parts[8]),
      change: Number(parts[9]),
      turnover: Number(parts[10]),
    };
  }).filter((row) => row.date && Number.isFinite(row.close) && row.close > 0);
}

async function fetchOnlineStockHistory(stock) {
  const json = await fetchJsonAsync(stockKlineUrl(stock, CONFIG.quantHistoryLimit), `个股日K ${stock.code}`, 18000);
  const lines = Array.isArray(json.data?.klines) ? json.data.klines : [];
  return parseStockKlines(lines);
}

function latestHistoryDate(history) {
  return Array.isArray(history) && history.length ? history.at(-1).date : "";
}

function trimHistory(history) {
  return history.slice(-CONFIG.quantHistoryLimit).filter((row) => row.date && Number.isFinite(Number(row.close)));
}

function mergeQuoteIntoHistory(history, stock, tradeDate) {
  if (stock.localOnly && latestHistoryDate(history) < tradeDate && stock.quoteDate !== tradeDate) return trimHistory(history);
  if (!tradeDate || !Number.isFinite(stock.price) || !Number.isFinite(stock.preClose)) return trimHistory(history);
  const row = {
    date: tradeDate,
    open: Number.isFinite(stock.open) ? stock.open : stock.preClose,
    high: Number.isFinite(stock.high) ? stock.high : Math.max(stock.price, stock.preClose),
    low: Number.isFinite(stock.low) ? stock.low : Math.min(stock.price, stock.preClose),
    close: stock.price,
    volume: Number(stock.volume) || 0,
    amount: Number(stock.amount) || 0,
    amplitude: Number.isFinite(stock.high) && Number.isFinite(stock.low) && stock.preClose
      ? round2((stock.high - stock.low) / stock.preClose * 100)
      : null,
    changePct: Number.isFinite(stock.changePct) ? stock.changePct : round2((stock.price - stock.preClose) / stock.preClose * 100),
    change: Number.isFinite(stock.change) ? stock.change : round2(stock.price - stock.preClose),
    turnover: Number.isFinite(stock.turnover) ? stock.turnover : null,
  };
  const merged = history.filter((item) => item.date !== tradeDate);
  merged.push(row);
  merged.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return trimHistory(merged);
}

async function getQuantHistory(stock, tradeDate, cache, stats) {
  const local = trimHistory(readTdxDayHistory(stock.code));
  if (latestHistoryDate(local) >= tradeDate && local.length >= QUANT_MIN_HISTORY) {
    stats.localFresh += 1;
    return { history: local, source: "通达信本地" };
  }
  const localWithQuote = mergeQuoteIntoHistory(local, stock, tradeDate);
  if (latestHistoryDate(localWithQuote) >= tradeDate && localWithQuote.length >= QUANT_MIN_HISTORY) {
    stats.tencentFresh += 1;
    return { history: localWithQuote, source: "通达信本地+腾讯实时" };
  }
  const cached = trimHistory(cache.histories[stock.code] || []);
  if (latestHistoryDate(cached) >= tradeDate && cached.length >= QUANT_MIN_HISTORY) {
    stats.cacheFresh += 1;
    return { history: cached, source: "线上缓存" };
  }
  if (stats.onlineErrors < 80 || stats.onlineFresh > 0) {
    try {
      const online = mergeQuoteIntoHistory(await fetchOnlineStockHistory(stock), stock, tradeDate);
      if (online.length >= QUANT_MIN_HISTORY) {
        cache.histories[stock.code] = online;
        stats.onlineFresh += 1;
        return { history: online, source: local.length ? "线上补齐" : "线上日K" };
      }
    } catch (error) {
      stats.onlineErrors += 1;
      if (stats.onlineErrors <= 10) log(`量化日K补齐失败 ${stock.code} ${stock.name}：${error.message}`);
    }
  } else {
    stats.onlineSkipped += 1;
  }
  const fallback = mergeQuoteIntoHistory(cached.length >= local.length ? cached : local, stock, tradeDate);
  if (latestHistoryDate(fallback) >= tradeDate && fallback.length >= QUANT_MIN_HISTORY) {
    stats.fallbackFresh += 1;
    return { history: fallback, source: "缓存/本地回补" };
  }
  return { history: fallback, source: fallback.length ? "数据不足" : "无日线" };
}

function maAt(values, index, period) {
  if (index + 1 < period) return NaN;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i += 1) sum += values[i];
  return sum / period;
}

function avgLast(values, endIndex, period) {
  const start = Math.max(0, endIndex - period + 1);
  const slice = values.slice(start, endIndex + 1).filter((value) => Number.isFinite(value));
  return slice.length ? average(slice) : NaN;
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  values.forEach((value, index) => {
    out[index] = index === 0 ? value : value * k + out[index - 1] * (1 - k);
  });
  return out;
}

function tdxSmaSeries(values, period, weight = 1) {
  let previous = NaN;
  return values.map((rawValue) => {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return previous;
    previous = Number.isFinite(previous)
      ? (weight * value + (period - weight) * previous) / period
      : value;
    return previous;
  });
}

function macdSeries(closes) {
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const dif = closes.map((_, index) => ema12[index] - ema26[index]);
  const dea = emaSeries(dif, 9);
  const macd = dif.map((value, index) => (value - dea[index]) * 2);
  return { dif, dea, macd };
}

function kdjSeries(history, period = 9) {
  const rsv = history.map((row, index) => {
    const start = Math.max(0, index - period + 1);
    const part = history.slice(start, index + 1);
    const low = Math.min(...part.map((item) => item.low));
    const high = Math.max(...part.map((item) => item.high));
    return high === low ? 50 : (row.close - low) / (high - low) * 100;
  });
  const k = tdxSmaSeries(rsv, 3, 1);
  const d = tdxSmaSeries(k, 3, 1);
  return history.map((_, index) => ({
    k: k[index],
    d: d[index],
    j: 3 * k[index] - 2 * d[index],
  }));
}
function formulaPosition(history, index, period) {
  const start = Math.max(0, index - period + 1);
  const part = history.slice(start, index + 1);
  const lowestLow = Math.min(...part.map((row) => Number(row.low)));
  const highestClose = Math.max(...part.map((row) => Number(row.close)));
  const denominator = highestClose - lowestLow;
  return Number.isFinite(denominator) && denominator > 0
    ? 100 * (Number(history[index]?.close) - lowestLow) / denominator
    : NaN;
}

function brickSeries(history) {
  const var1a = [];
  const var3a = [];
  history.forEach((row, index) => {
    const start = Math.max(0, index - QUANT_RULES.brick.lookback + 1);
    const part = history.slice(start, index + 1);
    const highestHigh = Math.max(...part.map((item) => Number(item.high)));
    const lowestLow = Math.min(...part.map((item) => Number(item.low)));
    const denominator = highestHigh - lowestLow;
    var1a[index] = denominator > 0 ? (highestHigh - Number(row.close)) / denominator * 100 - 90 : NaN;
    var3a[index] = denominator > 0 ? (Number(row.close) - lowestLow) / denominator * 100 : NaN;
  });
  const var2a = tdxSmaSeries(var1a, 4, 1).map((value) => Number.isFinite(value) ? value + 100 : NaN);
  const var4a = tdxSmaSeries(var3a, 6, 1);
  const var5a = var4a.map((value) => Number.isFinite(value) ? value + 100 : NaN);
  return history.map((_, index) => {
    const var6a = var5a[index] - var2a[index];
    return Number.isFinite(var6a) ? Math.max(var6a - 4, 0) : NaN;
  });
}

function historyRange(history, index, period) {
  const start = Math.max(0, index - period + 1);
  const part = history.slice(start, index + 1);
  return {
    high: Math.max(...part.map((row) => row.high)),
    low: Math.min(...part.map((row) => row.low)),
  };
}

function pctChange(current, previous) {
  return Number.isFinite(current) && Number.isFinite(previous) && previous ? (current - previous) / previous * 100 : NaN;
}


function quantLimitPctForStock(stock) {
  const code = String(stock?.code || "");
  const name = String(stock?.name || "");
  if (/ST|退/.test(name)) return 5;
  if (/^(688|689|300|301|302)/.test(code)) return 20;
  if (/^(8|4|920)/.test(code)) return 30;
  return 10;
}

function limitDayState(history, index, limitPct) {
  const row = history[index];
  const prev = history[index - 1];
  if (!row || !prev || !Number.isFinite(Number(prev.close)) || prev.close <= 0) {
    return { touched: false, closed: false, broken: false };
  }
  const highPct = pctChange(row.high, prev.close);
  const closePct = pctChange(row.close, prev.close);
  const limitPrice = prev.close * (1 + limitPct / 100);
  const touched = row.high >= limitPrice * 0.995 || highPct >= limitPct - 0.45;
  const closed = row.close >= limitPrice * 0.995 || closePct >= limitPct - 0.45;
  return { touched, closed, broken: touched && !closed, highPct, closePct };
}

function buildLimitBreakRisk(history, index, stock) {
  const limitPct = quantLimitPctForStock(stock);
  const todayState = limitDayState(history, index, limitPct);
  const prevState = limitDayState(history, index - 1, limitPct);
  let break5 = 0;
  let break10 = 0;
  let closedLimit5 = 0;
  for (let i = Math.max(1, index - 9); i <= index; i += 1) {
    const state = limitDayState(history, i, limitPct);
    if (state.broken) {
      break10 += 1;
      if (i >= index - 4) break5 += 1;
    }
    if (state.closed && i >= index - 4) closedLimit5 += 1;
  }
  return {
    limitPct,
    todayTouched: todayState.touched,
    todayClosed: todayState.closed,
    todayBreak: todayState.broken,
    prevBreak: prevState.broken,
    break5,
    break10,
    closedLimit5,
  };
}



function maxFiniteWithIndex(values, start, end) {
  let value = -Infinity;
  let index = -1;
  for (let i = Math.max(0, start); i <= end && i < values.length; i += 1) {
    const current = Number(values[i]);
    if (Number.isFinite(current) && current > value) {
      value = current;
      index = i;
    }
  }
  return { value: Number.isFinite(value) ? value : NaN, index };
}

function buildMacdFastDivergence(history, difSeries, index) {
  if (index < 12) return { bearish: false, fastWeakWhilePriceUp: false };
  const last = history[index];
  const priorHigh = maxFiniteWithIndex(history.map((row) => row.high), index - 30, index - 1);
  const currentDif = Number(difSeries[index]);
  const prevDif = Number(difSeries[index - 1]);
  const priorDifAtHigh = Number(difSeries[priorHigh.index]);
  const madePriceHigh = Number.isFinite(priorHigh.value) && last.high >= priorHigh.value * 0.995;
  const difLower = Number.isFinite(currentDif) && Number.isFinite(priorDifAtHigh)
    ? currentDif < priorDifAtHigh - Math.max(Math.abs(priorDifAtHigh) * 0.08, 0.01)
    : false;
  const fastWeakWhilePriceUp = Number.isFinite(currentDif) && Number.isFinite(prevDif) && last.close > (history[index - 1]?.close || last.close) && currentDif < prevDif;
  return {
    bearish: madePriceHigh && difLower && currentDif < prevDif,
    fastWeakWhilePriceUp,
    priorHigh: Number.isFinite(priorHigh.value) ? round2(priorHigh.value) : null,
    currentDif: Number.isFinite(currentDif) ? round2(currentDif) : null,
    priorDifAtHigh: Number.isFinite(priorDifAtHigh) ? round2(priorDifAtHigh) : null,
  };
}

function buildVolumePriceDivergence(history, index, avgVol5, avgVol20, range20) {
  const last = history[index];
  const prev = history[index - 1] || last;
  const volume = Number(last.volume);
  const prevVolume = Number(prev.volume);
  const priceUp = last.close > prev.close;
  const upShrink = priceUp && Number.isFinite(volume) && Number.isFinite(prevVolume) && volume < prevVolume * 0.82;
  const highShrink = Number.isFinite(range20?.high) && last.high >= range20.high * 0.985 && Number.isFinite(volume) && Number.isFinite(avgVol20) && volume < avgVol20 * 0.72;
  const volumeSurgeNoPrice = Number.isFinite(volume) && Number.isFinite(avgVol20) && volume > avgVol20 * 1.7 && pctChange(last.close, prev.close) < 1.2;
  const shortVolumeDown = Number.isFinite(avgVol5) && Number.isFinite(avgVol20) && avgVol5 < avgVol20 * 0.75 && priceUp;
  return { upShrink, highShrink, volumeSurgeNoPrice, shortVolumeDown };
}


function candleShape(row = {}) {
  const open = Number(row.open);
  const close = Number(row.close);
  const high = Number(row.high);
  const low = Number(row.low);
  const upperShadow = high - Math.max(open, close);
  const lowerShadow = Math.min(open, close) - low;
  const realBody = Math.abs(close - open);
  const bodyBase = Math.max(realBody, Math.abs(close) * 0.004);
  return {
    upperShadow,
    lowerShadow,
    realBody,
    noUpperShadow: Number.isFinite(upperShadow) && upperShadow <= bodyBase * 0.35,
    longUpperShadow: Number.isFinite(upperShadow) && upperShadow > bodyBase * 0.8,
  };
}

function directionalAverageVolume(history, start, end, direction) {
  const values = [];
  for (let index = Math.max(1, start); index <= Math.min(end, history.length - 1); index += 1) {
    const isUp = Number(history[index].close) > Number(history[index - 1].close);
    const matches = direction === "up" ? isUp : !isUp;
    const volume = Number(history[index].volume);
    if (matches && Number.isFinite(volume) && volume > 0) values.push(volume);
  }
  return average(values);
}

function buildQuantPatternStructure(history, index, avgVol20, riskPos20, limitRisk, range20, amplitude) {
  const last = history[index];
  const prev = history[index - 1] || last;
  const searchStart = Math.max(1, index - 44);
  const lowSearchEnd = Math.max(searchStart, index - 8);
  let lowIndex = searchStart;
  for (let cursor = searchStart + 1; cursor <= lowSearchEnd; cursor += 1) {
    if (Number(history[cursor].low) < Number(history[lowIndex].low)) lowIndex = cursor;
  }
  let highIndex = Math.min(index - 1, lowIndex + 1);
  for (let cursor = lowIndex + 1; cursor <= index - 1; cursor += 1) {
    if (Number(history[cursor].high) > Number(history[highIndex].high)) highIndex = cursor;
  }
  const lowPrice = Number(history[lowIndex]?.low);
  const highPrice = Number(history[highIndex]?.high);
  const advancePct = pctChange(highPrice, lowPrice);
  const pullbackPct = pctChange(Number(last.close), highPrice);
  const heldHigherLow = Number.isFinite(lowPrice) && Number(last.low) > lowPrice * 1.03;
  const nShape = highIndex > lowIndex
    && Number.isFinite(advancePct) && advancePct >= 12
    && Number.isFinite(pullbackPct) && pullbackPct <= -2 && pullbackPct >= -25
    && heldHigherLow;
  const riseVolume = directionalAverageVolume(history, lowIndex + 1, highIndex, "up");
  const pullbackVolume = directionalAverageVolume(history, highIndex + 1, index, "down");
  const pullbackVolumeContracting = nShape
    && Number.isFinite(riseVolume) && riseVolume > 0
    && Number.isFinite(pullbackVolume) && pullbackVolume <= riseVolume * 0.85;
  const extremeShrinkSmallRange = Number(last.volume) <= Number(avgVol20) * 0.65
    && Number.isFinite(amplitude) && amplitude <= 3;
  const tenDayBase = Number(history[Math.max(0, index - 10)]?.close);
  const tenDayRisePct = pctChange(Number(last.close), tenDayBase);
  const sprintWaveRisk = riskPos20 >= 75
    && ((Number(limitRisk?.closedLimit5) || 0) >= 2 || (Number.isFinite(tenDayRisePct) && tenDayRisePct >= 25));
  let recentBigBull = false;
  for (let cursor = Math.max(1, index - 30); cursor < index; cursor += 1) {
    const change = pctChange(Number(history[cursor].close), Number(history[cursor - 1].close));
    if (change > 4 && Number(history[cursor].volume) > Number(history[cursor - 1].volume) * 1.2) {
      recentBigBull = true;
      break;
    }
  }
  const phase = sprintWaveRisk
    ? "冲刺波风险"
    : nShape && recentBigBull && riskPos20 <= 55
      ? "建仓波候选"
      : nShape && recentBigBull
        ? "拉升波回调"
        : nShape
          ? "N型回调"
          : "结构待确认";
  const currentShape = candleShape(last);
  const distributionRisk = riskPos20 >= 82
    && Number(last.volume) > Number(avgVol20) * 1.5
    && (Number(last.close) < Number(prev.close) || currentShape.longUpperShadow);
  const range20Pct = Number(range20?.low) > 0 ? pctChange(Number(range20.high), Number(range20.low)) : NaN;
  const brickContext = riskPos20 <= 35
    ? "相对底部"
    : Number.isFinite(range20Pct) && range20Pct <= 18 && riskPos20 <= 55
      ? "横盘区间底部"
      : "上升波段";
  return {
    lowIndex,
    highIndex,
    advancePct,
    pullbackPct,
    nShape,
    pullbackVolumeContracting,
    extremeShrinkSmallRange,
    sprintWaveRisk,
    recentBigBull,
    phase,
    distributionRisk,
    brickContext,
  };
}
function buildQuantMetrics(history, stock = {}) {
  const closes = history.map((row) => row.close);
  const volumes = history.map((row) => row.volume);
  const ema10 = emaSeries(closes, QUANT_RULES.trend.shortEma);
  const shortTrendSeries = emaSeries(ema10, QUANT_RULES.trend.shortEma);
  const multiTrendSeries = closes.map((_, currentIndex) => {
    const values = QUANT_RULES.trend.multiPeriods.map((period) => maAt(closes, currentIndex, period));
    return values.every(Number.isFinite) ? average(values) : NaN;
  });
  const kdj = kdjSeries(history);
  const macd = macdSeries(closes);
  const bricks = brickSeries(history);
  const index = history.length - 1;
  const last = history[index];
  const prev = history[index - 1] || last;
  const beforePrev = history[index - 2] || prev;
  const ma3 = maAt(closes, index, 3);
  const ma6 = maAt(closes, index, 6);
  const ma12 = maAt(closes, index, 12);
  const ma24 = maAt(closes, index, 24);
  const bbi = [ma3, ma6, ma12, ma24].every(Number.isFinite) ? (ma3 + ma6 + ma12 + ma24) / 4 : NaN;
  const range20 = historyRange(history, index, 20);
  const riskPos20 = range20.high === range20.low ? 50 : (last.close - range20.low) / (range20.high - range20.low) * 100;
  const singleShort = formulaPosition(history, index, QUANT_RULES.needle.shortPeriod);
  const singleLong = formulaPosition(history, index, QUANT_RULES.needle.longPeriod);
  const changePctValue = Number.isFinite(last.changePct) ? last.changePct : pctChange(last.close, prev.close);
  const prevChangePct = Number.isFinite(prev.changePct) ? prev.changePct : pctChange(prev.close, beforePrev.close);
  const amplitude = Number.isFinite(last.amplitude) ? last.amplitude : (prev.close ? (last.high - last.low) / prev.close * 100 : NaN);
  const prevAmplitude = Number.isFinite(prev.amplitude) ? prev.amplitude : (beforePrev.close ? (prev.high - prev.low) / beforePrev.close * 100 : NaN);
  const avgVol5 = avgLast(volumes, index, 5);
  const avgVol20 = avgLast(volumes, index, 20);
  const limitRisk = buildLimitBreakRisk(history, index, stock);
  const macdDivergence = buildMacdFastDivergence(history, macd.dif, index);
  const volumePriceDivergence = buildVolumePriceDivergence(history, index, avgVol5, avgVol20, range20);
  const currentKdj = kdj[index] || {};
  const previousKdj = kdj[index - 1] || {};
  const brick = Number(bricks[index]);
  const prevBrick = Number(bricks[index - 1]);
  const beforePrevBrick = Number(bricks[index - 2]);
  const brickRedHeight = brick - prevBrick;
  const brickGreenHeight = beforePrevBrick - prevBrick;
  const shortTrend = shortTrendSeries[index];
  const prevShortTrend = shortTrendSeries[index - 1];
  const multiTrend = multiTrendSeries[index];
  const prevMultiTrend = multiTrendSeries[index - 1];
  const currentCandle = candleShape(last);
  const previousCandle = candleShape(prev);
  const previousB1Qualified =
    previousKdj.j < QUANT_RULES.b1.jMax &&
    prevChangePct >= QUANT_RULES.b1.changeMin &&
    prevChangePct <= QUANT_RULES.b1.changeMax &&
    prevAmplitude <= QUANT_RULES.b1.amplitudeMax &&
    prevMultiTrend <= prevShortTrend &&
    prev.close >= prevMultiTrend;
  const pattern = buildQuantPatternStructure(history, index, avgVol20, riskPos20, limitRisk, range20, amplitude);
  return {
    index,
    last,
    prev,
    beforePrev,
    closes,
    volumes,
    changePct: changePctValue,
    prevChangePct,
    amplitude,
    prevAmplitude,
    avgVol5,
    avgVol20,
    bbi,
    ma5: maAt(closes, index, 5),
    ma10: maAt(closes, index, 10),
    ma20: maAt(closes, index, 20),
    ma60: maAt(closes, index, 60),
    shortTrend,
    prevShortTrend,
    multiTrend,
    prevMultiTrend,
    trendQualified: Number.isFinite(shortTrend) && Number.isFinite(multiTrend) && shortTrend > multiTrend && last.close > multiTrend,
    k: currentKdj.k,
    d: currentKdj.d,
    j: currentKdj.j,
    prevK: previousKdj.k,
    prevD: previousKdj.d,
    prevJ: previousKdj.j,
    kdjDeadCross: Number.isFinite(currentKdj.k) && Number.isFinite(currentKdj.d) && Number.isFinite(previousKdj.k) && Number.isFinite(previousKdj.d)
      ? previousKdj.k >= previousKdj.d && currentKdj.k < currentKdj.d
      : false,
    dif: macd.dif[index],
    dea: macd.dea[index],
    prevDif: macd.dif[index - 1],
    singleShort,
    singleLong,
    shortPos: singleShort,
    longPos: singleLong,
    riskPos20,
    brick,
    prevBrick,
    beforePrevBrick,
    brickRising: Number.isFinite(brick) && Number.isFinite(prevBrick) && prevBrick < brick,
    previousBrickFalling: Number.isFinite(beforePrevBrick) && Number.isFinite(prevBrick) && beforePrevBrick > prevBrick,
    brickRedHeight,
    brickGreenHeight,
    brickRecoveryRatio: brickGreenHeight > 0 ? brickRedHeight / brickGreenHeight : NaN,
    brickGreenMeaningful: brickGreenHeight >= Math.max(0.25, Math.abs(prevBrick) * 0.02),
    previousB1Qualified,
    currentCandle,
    previousCandle,
    pattern,
    limitRisk,
    macdDivergence,
    volumePriceDivergence,
  };
}
function quantSignals(metrics) {
  const { last, prev, beforePrev } = metrics;
  const currentCandle = metrics.currentCandle || candleShape(last);
  const previousCandle = metrics.previousCandle || candleShape(prev);
  const b1 =
    metrics.j < QUANT_RULES.b1.jMax &&
    metrics.changePct >= QUANT_RULES.b1.changeMin &&
    metrics.changePct <= QUANT_RULES.b1.changeMax &&
    metrics.amplitude <= QUANT_RULES.b1.amplitudeMax &&
    metrics.multiTrend <= metrics.shortTrend &&
    last.close >= metrics.multiTrend;
  const b2 =
    metrics.prevJ < QUANT_RULES.b2.previousJMax &&
    metrics.changePct > QUANT_RULES.b2.changeMin &&
    metrics.j < QUANT_RULES.b2.currentJMax &&
    last.volume > prev.volume &&
    metrics.shortTrend > metrics.multiTrend &&
    last.close >= metrics.multiTrend;
  const b3 =
    metrics.trendQualified &&
    prev.close > prev.open &&
    metrics.prevChangePct > QUANT_RULES.b3.previousChangeMin &&
    prev.volume > beforePrev.volume &&
    last.close > last.open &&
    last.volume < prev.volume &&
    metrics.changePct >= QUANT_RULES.b3.currentChangeMin &&
    metrics.changePct <= QUANT_RULES.b3.currentChangeMax &&
    metrics.amplitude <= QUANT_RULES.b3.amplitudeMax;
  const needle =
    metrics.trendQualified &&
    metrics.singleShort <= QUANT_RULES.needle.shortMax &&
    metrics.singleLong >= QUANT_RULES.needle.longMin;
  const brick =
    metrics.brickRising &&
    metrics.previousBrickFalling &&
    metrics.brickRedHeight >= QUANT_RULES.brick.recoveryRatio * metrics.brickGreenHeight &&
    last.close > metrics.shortTrend &&
    metrics.shortTrend > metrics.multiTrend;
  return {
    B1: b1,
    B2: b2,
    B3: b3,
    单针: needle,
    砖型图: brick,
    flags: {
      noUpperShadow: currentCandle.noUpperShadow,
      currentNoUpperShadow: currentCandle.noUpperShadow,
      currentLongUpperShadow: currentCandle.longUpperShadow,
      previousNoUpperShadow: previousCandle.noUpperShadow,
      previousLongUpperShadow: previousCandle.longUpperShadow,
      strongLowerShadow: currentCandle.lowerShadow > currentCandle.realBody,
    },
  };
}
function scoreQuant(metrics, signals) {
  let score = 20;
  const reasons = [];
  const risks = [];
  const add = (points, text) => {
    score += points;
    if (text) reasons.push(text);
  };
  const cut = (points, text) => {
    score -= points;
    if (text) risks.push(text);
  };
  const limitRisk = metrics.limitRisk || {};
  const pattern = metrics.pattern || {};
  if (limitRisk.todayBreak) cut(18, "当日涨停炸板");
  if (limitRisk.todayBreak && metrics.last.volume > metrics.avgVol20 * 1.4) cut(6, "炸板且放量");
  if ((limitRisk.break5 || 0) >= 2) cut(8, "近5日多次炸板");
  else if ((limitRisk.break5 || 0) >= 1 && !limitRisk.todayBreak) cut(5, "近5日出现炸板");
  if ((limitRisk.break10 || 0) >= 3) cut(8, "近10日反复炸板");
  else if ((limitRisk.break10 || 0) >= 2) cut(5, "近10日两次炸板");
  if (limitRisk.prevBreak && metrics.changePct < 1) cut(5, "昨日炸板后修复弱");
  if (signals.B1) add(16, "B1通达信公式命中");
  if (signals.B2) add(22, "B2通达信公式命中");
  if (signals.B3) add(18, "B3通达信公式命中");
  if (signals.单针) add(18, "单针通达信公式命中");
  if (signals.砖型图) add(20, "砖型图通达信公式命中");

  if (signals.B1) {
    if (pattern.nShape) add(8, "N型上涨回调结构");
    else cut(3, "N型结构尚不清晰");
    if (pattern.pullbackVolumeContracting) add(7, "上涨放量、回调缩量");
    if (pattern.extremeShrinkSmallRange) add(6, "极致缩量伴随小振幅");
    if (pattern.phase === "建仓波候选") add(4, "建仓波后的B1位置");
    else if (pattern.phase === "拉升波回调") add(3, "拉升波后的B1位置");
    if (pattern.sprintWaveRisk) cut(18, "冲刺波高斜率风险，按文档不做B1");
  }
  if (signals.B2) {
    if (metrics.previousB1Qualified) add(7, "前一日完整B1低位确认");
    else cut(2, "前一日仅J值进入B1区，完整B1结构未确认");
    if (signals.flags?.currentNoUpperShadow) add(4, "B2确认阳线上影线短");
    else if (signals.flags?.currentLongUpperShadow) cut(3, "B2确认阳线上影线偏长");
  }
  if (signals.B3) {
    if (signals.flags?.previousNoUpperShadow) add(5, "前一日放量大阳线上影线短");
    else if (signals.flags?.previousLongUpperShadow) cut(4, "前一日大阳线上影线偏长");
    if (metrics.last.volume <= metrics.prev.volume * 0.8) add(4, "中继日明显缩量");
    if (metrics.amplitude <= 3) add(4, "中继日小振幅");
  }
  if (signals.单针) {
    if (metrics.shortTrend > metrics.prevShortTrend && metrics.multiTrend > metrics.prevMultiTrend) add(6, "主升趋势线同步向上");
    if (pattern.distributionRisk) cut(15, "主升高位放量出货风险");
  }
  if (signals.砖型图) {
    if (metrics.brickRecoveryRatio >= 1) add(6, "红柱完全覆盖前一绿柱");
    else if (metrics.brickRecoveryRatio >= QUANT_RULES.brick.recoveryRatio) add(3, "红柱承接达到前一绿柱三分之二");
    if (pattern.brickContext === "相对底部") add(5, "相对底部绿转红");
    else if (pattern.brickContext === "横盘区间底部") add(4, "横盘区间底部绿转红");
    else add(3, "上升波段内绿转红");
    if (!metrics.brickGreenMeaningful) cut(3, "前一绿柱极小，转折参考价值较低");
  }

  if (metrics.last.close > metrics.bbi) add(6, "收盘在BBI上方");
  if (metrics.shortTrend > metrics.multiTrend) add(6, "短期趋势线强于多空线");
  if (metrics.shortTrend > metrics.prevShortTrend) add(4, "短期趋势线抬升");
  if (metrics.multiTrend > metrics.prevMultiTrend) add(4, "日线多空线保持向上");
  if (metrics.last.close > metrics.ma20) add(3, "收盘在20日线上方");
  if (metrics.changePct > 0) add(3, "阳线按收盘高于昨日收盘确认");
  if (signals.B2 && metrics.last.volume > metrics.prev.volume) add(4, "B2确认阳线放量");
  else if (!signals.B3 && metrics.last.volume > metrics.prev.volume && metrics.changePct > 0) add(2, "上涨放量");
  if (metrics.last.volume < metrics.avgVol20 * 0.75 && Math.abs(metrics.changePct) <= 3) {
    add(signals.B1 || signals.B3 ? 4 : 2, "缩量小波动");
  }
  if (metrics.kdjDeadCross) cut(6, "KDJ出现死叉");
  else add(3, "KDJ未出现死叉");
  if (metrics.dif > metrics.dea) add(4, "MACD快线在慢线上方");
  if (metrics.dif > metrics.prevDif && metrics.changePct >= 0) add(3, "MACD快线改善");
  if (metrics.macdDivergence?.bearish) cut(10, "日K MACD快线顶背离");
  else if (metrics.macdDivergence?.fastWeakWhilePriceUp) cut(5, "上涨但MACD快线走弱");
  const expectedStrategyShrink = signals.B3
    || (signals.B1 && Math.abs(metrics.changePct) <= 3 && metrics.amplitude <= QUANT_RULES.b1.amplitudeMax);
  if (metrics.volumePriceDivergence?.highShrink && !expectedStrategyShrink) cut(8, "价格近新高但量能不足");
  else if (metrics.volumePriceDivergence?.upShrink && !expectedStrategyShrink) cut(5, "上涨缩量，量价背离");
  if (metrics.volumePriceDivergence?.volumeSurgeNoPrice) cut(7, "放量滞涨，量价背离");
  if (metrics.volumePriceDivergence?.shortVolumeDown && !expectedStrategyShrink && metrics.riskPos20 >= 70) cut(4, "高位短期量能低于20日均量");
  if (metrics.last.close < metrics.multiTrend) cut(12, "收盘低于多空线");
  if (metrics.changePct < -6) cut(10, "当日跌幅偏大");
  if (metrics.amplitude > 10) cut(6, "振幅过大");
  if (metrics.changePct < 0 && metrics.last.volume > metrics.avgVol20 * 1.8) cut(12, "放量下跌");
  if (metrics.riskPos20 > 92 && metrics.last.volume > metrics.avgVol20 * 1.6) cut(8, "20日位置过高且放量");
  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons, risks };
}
function evaluateQuantStock(stock, historyInfo) {
  const history = trimHistory(historyInfo.history);
  if (history.length < QUANT_MIN_HISTORY) return null;
  const metrics = buildQuantMetrics(history, stock);
  if (![metrics.bbi, metrics.shortTrend, metrics.multiTrend, metrics.j].every(Number.isFinite)) return null;
  const signalState = quantSignals(metrics);
  const signalNames = Object.entries(signalState)
    .filter(([name, value]) => name !== "flags" && value)
    .map(([name]) => name);
  const scored = scoreQuant(metrics, signalState);
  const official = signalNames.length > 0;
  if (!official) return null;
  return {
    code: stock.code,
    market: marketIdForCode(stock.code, stock.market),
    name: stock.name,
    date: metrics.last.date,
    close: round2(metrics.last.close),
    changePct: round2(metrics.changePct),
    amplitude: round2(metrics.amplitude),
    score: scored.score,
    mode: "正式候选",
    official,
    ruleVersion: QUANT_RULES_VERSION,
    formulaBasis: "交易策略总览.docx中的通达信条件选股公式；B2当前J<80、单针长期位>=75按用户最终确认值执行；形态、量价与波段细节只用于同战法排序",
    signals: signalNames,
    signalText: signalNames.join("、"),
    sector: stock.sector || "未分类",
    concepts: uniqueTextList(stock.concepts),
    moveReason: "",
    businessIntro: "",
    source: historyInfo.source,
    reasons: scored.reasons.slice(0, 5),
    risks: scored.risks.slice(0, 4),
    metrics: {
      j: round2(metrics.j),
      prevJ: round2(metrics.prevJ),
      bbi: round2(metrics.bbi),
      shortTrend: round2(metrics.shortTrend),
      multiTrend: round2(metrics.multiTrend),
      trendQualified: metrics.trendQualified ? 1 : 0,
      shortPos: round1(metrics.singleShort),
      longPos: round1(metrics.singleLong),
      brick: round2(metrics.brick),
      brickRedHeight: round2(metrics.brickRedHeight),
      brickGreenHeight: round2(metrics.brickGreenHeight),
      volumeRatio: round2(metrics.avgVol20 ? metrics.last.volume / metrics.avgVol20 : NaN),
      previousB1Qualified: metrics.previousB1Qualified ? 1 : 0,
      nShape: metrics.pattern?.nShape ? 1 : 0,
      patternPhase: metrics.pattern?.phase || "",
      brickContext: metrics.pattern?.brickContext || "",
      brickRecoveryRatio: round2(metrics.brickRecoveryRatio),
      limitBreak5: metrics.limitRisk?.break5 ?? 0,
      limitBreak10: metrics.limitRisk?.break10 ?? 0,
      macdFastDivergence: metrics.macdDivergence?.bearish ? 1 : 0,
      volumePriceDivergence: Object.values(metrics.volumePriceDivergence || {}).some(Boolean) ? 1 : 0,
    },
    _history: history,
    _stock: { code: stock.code, market: stock.market, name: stock.name },
  };
}

const QUANT_BACKTEST_HORIZONS = [1, 3, 5, 10, 30];
const QUANT_BACKTEST_BASE_HORIZON = 10;

function medianNumber(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function buildStrategyBacktests(rows) {
  const buckets = new Map();
  for (const signal of QUANT_SIGNAL_ORDER) {
    for (const horizon of QUANT_BACKTEST_HORIZONS) buckets.set(`${signal}:${horizon}`, []);
  }
  for (const row of rows) {
    const history = Array.isArray(row._history) ? row._history : [];
    const firstIndex = Math.max(QUANT_MIN_HISTORY - 1, history.length - 70);
    const lastIndex = history.length - QUANT_BACKTEST_BASE_HORIZON - 1;
    for (let index = firstIndex; index <= lastIndex; index += 2) {
      const sample = history.slice(0, index + 1);
      const metrics = buildQuantMetrics(sample, row._stock || row);
      const signals = quantSignals(metrics);
      for (const signal of QUANT_SIGNAL_ORDER) {
        if (!signals[signal]) continue;
        for (const horizon of QUANT_BACKTEST_HORIZONS) {
          if (index + horizon >= history.length) continue;
          const entry = Number(history[index]?.close);
          const exit = Number(history[index + horizon]?.close);
          if (!(entry > 0) || !(exit > 0)) continue;
          const path = history.slice(index + 1, index + horizon + 1).map((item) => Number(item.close)).filter(Number.isFinite);
          const maxDrawdown = path.length ? Math.min(...path.map((price) => (price / entry - 1) * 100)) : 0;
          buckets.get(`${signal}:${horizon}`).push({
            returnPct: (exit / entry - 1) * 100,
            maxDrawdown,
          });
        }
      }
    }
  }
  const results = [];
  for (const signal of QUANT_SIGNAL_ORDER) {
    for (const horizon of QUANT_BACKTEST_HORIZONS) {
      const samples = buckets.get(`${signal}:${horizon}`) || [];
      const returns = samples.map((item) => item.returnPct);
      results.push({
        strategy: signal,
        horizon,
        samples: samples.length,
        winRate: samples.length ? round2(returns.filter((value) => value > 0).length / samples.length * 100) : null,
        avgReturn: samples.length ? round2(average(returns)) : null,
        medianReturn: samples.length ? round2(medianNumber(returns)) : null,
        maxDrawdown: samples.length ? round2(Math.min(...samples.map((item) => item.maxDrawdown))) : null,
      });
    }
  }
  rows.forEach((row) => {
    row.strategyBacktests = results.filter((item) => (row.signals || []).includes(item.strategy));
  });
  return results;
}

function buildAmvRegime(marketData) {
  const indexPct = changePct(marketData.index, "price");
  const state = indexPct >= 0.5 ? "偏多提示" : indexPct <= -0.5 ? "偏空提示" : "震荡提示";
  return {
    state,
    changePct: Number.isFinite(indexPct) ? round2(indexPct) : null,
    text: Number.isFinite(indexPct)
      ? `上证指数当前涨跌幅 ${reportPct(indexPct)}，仅作为市场环境提示，不直接过滤股票。`
      : "已按要求取消活跃市值，当前市场环境仅结合指数与量化结果提示。",
  };
}

function buildQuantRegime(marketData) {
  const market = marketData?.market || {};
  const hasCompositeData = [market.limitUpCount, market.limitDownCount, market.totalAmountYi]
    .some((value) => finiteValue(value) !== null);
  const indexPct = changePct(marketData.index, "price");
  const regime = hasCompositeData
    ? (() => {
        const diagnosis = buildDiagnosis(marketData);
        const broad = diagnosis.indexBreadth || {};
        const flow = diagnosis.flowBalance || {};
        const structure = diagnosis.marketStructure || {};
        const details = [
          "综合强度评分 " + reportNumber(diagnosis.score),
          "历史样本" + reportNumber(diagnosis.historyDaysUsed) + "个交易日",
          "涨停" + reportNumber(market.limitUpCount) + "家、跌停" + reportNumber(market.limitDownCount) + "家",
          "成交额" + reportYi(market.totalAmountYi),
          Number.isFinite(broad.averagePct) ? "主要宽基指数平均" + reportPct(broad.averagePct) : "",
          Number.isFinite(flow.ratio) ? "板块资金流入/流出比" + round2(flow.ratio) : "",
          Number.isFinite(indexPct) ? "上证" + reportPct(indexPct) : "",
          Array.isArray(structure.mainline) && structure.mainline.length ? "主线" + structure.mainline.map((item) => item.name).join("、") : "",
          Array.isArray(structure.subline) && structure.subline.length ? "支线" + structure.subline.map((item) => item.name).join("、") : "",
        ].filter(Boolean).join("；");
        const rotationText = structure.interSectorText ? "；" + structure.interSectorText : "";
        return {
          state: diagnosis.tone,
          changePct: Number.isFinite(indexPct) ? round2(indexPct) : null,
          score: diagnosis.score,
          text: details + "。与市场总结使用同一综合口径" + rotationText + "；" + diagnosis.action,
        };
      })()
    : buildAmvRegime(marketData);
  const indexWarning = marketData.index?.quantWarning || "";
  if (!indexWarning) return regime;
  return {
    ...regime,
    text: `${indexWarning}；${regime.text}`,
  };
}

function loadLatestMarketDataForQuant(index) {
  try {
    if (!fs.existsSync(CONFIG.outputPath)) return { index };
    const html = fs.readFileSync(CONFIG.outputPath, "utf8");
    const match = html.match(/const MARKET_DATA = (\{[\s\S]*?\});\s*const DAY_MINUTES/);
    if (!match) return { index };
    const snapshot = JSON.parse(match[1]);
    if (!snapshot?.index || snapshot.index.tradeDate !== index?.tradeDate) return { index };
    return { ...snapshot, index };
  } catch (error) {
    log("量化选股：市场综合快照读取失败，暂按指数兜底：" + error.message);
    return { index };
  }
}

async function mapLimit(items, limit, iterator) {
  const results = [];
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await iterator(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}


const QUANT_SIGNAL_ORDER = ["B1", "B2", "B3", "单针", "砖型图"];
const QUANT_FORMAL_LIMIT_PER_SIGNAL = 10;

function primaryQuantSignal(row) {
  const signals = Array.isArray(row?.signals) ? row.signals : [];
  return QUANT_SIGNAL_ORDER.find((name) => signals.includes(name)) || signals[0] || "";
}

function splitQuantCandidates(rows) {
  const sorted = [...rows].sort((a, b) => b.score - a.score || b.changePct - a.changePct);
  const selectedCodes = new Set();
  const slotStats = QUANT_SIGNAL_ORDER.map((signal) => {
    const matched = sorted.filter((row) => row.official && (row.signals || []).includes(signal));
    matched.slice(0, QUANT_FORMAL_LIMIT_PER_SIGNAL).forEach((row) => selectedCodes.add(`${row.market}:${row.code}`));
    return { signal, matched: matched.length, formal: Math.min(matched.length, QUANT_FORMAL_LIMIT_PER_SIGNAL), limit: QUANT_FORMAL_LIMIT_PER_SIGNAL };
  });
  const formal = sorted.filter((row) => selectedCodes.has(`${row.market}:${row.code}`));
  formal.forEach((row) => {
    row.primarySignal = primaryQuantSignal(row);
    row.mode = "正式候选";
  });
  return {
    rows: formal,
    formal,
    watch: [],
    slotStats,
  };
}


async function buildQuantSelection(marketData) {
  const tradeDate = marketData.index?.tradeDate || todayLocal();
  const allStocks = await fetchAllAStockQuotes();
  const stockPoolSource = allStocks.some((stock) => stock.localOnly) ? "通达信本地股票池+腾讯实时" : "线上全A";
  const excluded = new Map();
  const candidates = [];
  for (const stock of allStocks) {
    const reason = stockExcludeReason(stock, tradeDate);
    if (reason) {
      excluded.set(reason, (excluded.get(reason) || 0) + 1);
    } else {
      candidates.push(stock);
    }
  }
  const scanStocks = quantLimit ? candidates.slice(0, quantLimit) : candidates;
  log(`量化选股：股票池 ${allStocks.length} 只，排除 ${allStocks.length - candidates.length} 只，待扫描 ${scanStocks.length}${quantLimit ? "（测试限制）" : ""} 只。`);
  const cache = loadQuantCache();
  const stats = { localFresh: 0, tencentFresh: 0, cacheFresh: 0, onlineFresh: 0, fallbackFresh: 0, evaluatedHistory: 0, insufficientHistory: 0, missingHistory: 0, onlineErrors: 0, onlineSkipped: 0, moveReasonGenerated: 0, companyEventFetched: 0, companyEventCache: 0, companyEventMissing: 0, companyEventErrors: 0 };
  const rows = [];
  let processed = 0;
  await mapLimit(scanStocks, CONFIG.quantConcurrency, async (stock) => {
    const historyInfo = await getQuantHistory(stock, tradeDate, cache, stats);
    processed += 1;
    if (processed % 500 === 0) log(`量化选股扫描进度：${processed}/${scanStocks.length}`);
    if (!historyInfo.history || latestHistoryDate(historyInfo.history) < tradeDate) {
      stats.missingHistory += 1;
      return;
    }
    if (historyInfo.history.length < QUANT_MIN_HISTORY) {
      stats.insufficientHistory += 1;
      return;
    }
    stats.evaluatedHistory += 1;
    const item = evaluateQuantStock(stock, historyInfo);
    if (item) rows.push(item);
  });
  saveQuantCache(cache);
  const split = splitQuantCandidates(rows);
  const formal = split.formal;
  const watch = split.watch;
  const backtests = buildStrategyBacktests(split.rows);
  await enrichQuantCompanyEvents(split.rows, stats);
  assignQuantMoveReasons(split.rows, marketData, stats);
  split.rows.forEach((row) => {
    delete row._history;
    delete row._stock;
  });
  const marketRegime = buildQuantRegime(marketData);
  return {
    version: 5,
    ruleVersion: QUANT_RULES_VERSION,
    ruleBasis: "《交易策略总览》通达信硬公式及形态量价细节排序",
    ruleOverrides: { b2CurrentJMax: QUANT_RULES.b2.currentJMax, needleLongMin: QUANT_RULES.needle.longMin, amvDisabledByLaterInstruction: true },
    minimumHistoryDays: QUANT_MIN_HISTORY,
    tradeDate,
    fetchedAt: nowText(),
    marketRegime,
    amvRegime: marketRegime,
    stockPoolSource,
    universeCount: allStocks.length,
    excludedCount: allStocks.length - candidates.length,
    scannedCount: scanStocks.length,
    formalCount: formal.length,
    watchCount: watch.length,
    formalSlotStats: split.slotStats,
    backtestBasis: "当前正式候选股票的滚动历史回测；最近约70个交易日每2日取样，统计信号后1、3、5、10、30个交易日的胜率与平均收益，仅用于检验规则稳定性。",
    backtests,
    excludedReasons: [...excluded.entries()].map(([reason, count]) => ({ reason, count })),
    dataStats: stats,
    formal,
    watch,
    allRows: split.rows,
  };
}

function buildQuantErrorData(marketData, error) {
  const marketRegime = buildQuantRegime(marketData);
  return {
    version: 5,
    ruleVersion: QUANT_RULES_VERSION,
    ruleBasis: "《交易策略总览》通达信硬公式及形态量价细节排序",
    ruleOverrides: { b2CurrentJMax: QUANT_RULES.b2.currentJMax, needleLongMin: QUANT_RULES.needle.longMin, amvDisabledByLaterInstruction: true },
    minimumHistoryDays: QUANT_MIN_HISTORY,
    tradeDate: marketData.index?.tradeDate || todayLocal(),
    fetchedAt: nowText(),
    error: error.message,
    marketRegime,
    amvRegime: marketRegime,
    stockPoolSource: "不可用",
    universeCount: 0,
    excludedCount: 0,
    scannedCount: 0,
    formalCount: 0,
    watchCount: 0,
    excludedReasons: [],
    backtestBasis: "",
    backtests: [],
    dataStats: {},
    formal: [],
    watch: [],
    allRows: [],
  };
}

function buildRecentMarketDays(tradeDate, todayStats, options = {}) {
  if (options.intraday) {
    return [{
      date: tradeDate,
      compactDate: formatCompactDate(tradeDate),
      limitUpCount: todayStats.limitUpCount,
      limitDownCount: todayStats.limitDownCount,
      totalAmountYi: Number.isFinite(Number(todayStats.totalAmountYi)) ? round1(todayStats.totalAmountYi) : null,
      totalVolumeYiHands: Number.isFinite(Number(todayStats.totalVolumeYiHands)) ? round1(todayStats.totalVolumeYiHands) : null,
      indexChangePct: null,
    }];
  }
  let dates = [];
  try {
    dates = tencentIndexTradingDates(18)
      .filter((date) => date <= tradeDate)
      .sort((left, right) => right.localeCompare(left))
      .slice(0, 10);
  } catch (error) {
    log(`近期交易日日历暂未取到，使用工作日兜底：${error.message}`);
  }
  if (!dates.includes(tradeDate)) dates.unshift(tradeDate);
  dates = uniqueTextList([...dates, ...recentWeekdayDates(tradeDate, 10)])
    .sort((left, right) => right.localeCompare(left))
    .slice(0, 10);
  const turnoverMap = safeHistoricalTurnoverMap(tradeDate, 20);
  const days = [];
  for (const date of dates) {
    const isToday = date === tradeDate;
    const compact = formatCompactDate(date);
    const turnover = turnoverMap.get(date) || {};
    const limitUpCount = isToday ? todayStats.limitUpCount : safeZtbTotal("limitUp", date);
    const limitDownCount = isToday ? todayStats.limitDownCount : safeZtbTotal("limitDown", date);
    const totalAmountYi = isToday && Number.isFinite(Number(todayStats.totalAmountYi)) ? todayStats.totalAmountYi : turnover.amountYi;
    const totalVolumeYiHands = isToday && Number.isFinite(Number(todayStats.totalVolumeYiHands)) ? todayStats.totalVolumeYiHands : turnover.volumeYiHands;
    days.push({
      date,
      compactDate: compact,
      limitUpCount,
      limitDownCount,
      totalAmountYi: Number.isFinite(Number(totalAmountYi)) ? round1(totalAmountYi) : null,
      totalVolumeYiHands: Number.isFinite(Number(totalVolumeYiHands)) ? round1(totalVolumeYiHands) : null,
      indexChangePct: Number.isFinite(Number(turnover.indexChangePct)) ? round2(turnover.indexChangePct) : null,
    });
  }
  return days;
}

async function fetchMarketStats(tradeDate, options = {}) {
  const limitUpPool = safeZtbPool("limitUp", tradeDate);
  const topicLimitDownPool = safeZtbPool("limitDown", tradeDate);
  const brokenPool = safeZtbPool("broken", tradeDate);
  const yesterdayLimitPool = safeZtbPool("yesterdayLimitUp", tradeDate);
  const breadth = await fetchMarketBreadth(tradeDate);
  const limitDownPool = reconcileLimitDownPool(topicLimitDownPool, breadth.limitDownRows, tradeDate);
  const turnover = options.intraday ? { totalAmountYi: null, totalVolumeYiHands: null } : safeTurnoverStats();
  const limitUpStocks = enrichLimitRowsWithBoardInfo(normalizeLimitPoolRows(limitUpPool, "limitUp"), options);
  const limitDownStocks = enrichLimitRowsWithBoardInfo(normalizeLimitPoolRows(limitDownPool, "limitDown"), options);
  const brokenStocks = enrichLimitRowsWithBoardInfo(normalizeLimitPoolRows(brokenPool, "broken"), options);
  const yesterdayLimitStocks = enrichLimitRowsWithBoardInfo(normalizeLimitPoolRows(yesterdayLimitPool, "yesterdayLimit"), options);
  const yesterdayLimitSummary = summarizeQuoteGroup("昨日涨停", "BK0815", yesterdayLimitPool.rows, "continue");
  yesterdayLimitSummary.stocks = yesterdayLimitStocks;
  const yesterdayBrokenSummary = safeYesterdayBrokenRepair(tradeDate, options);
  const brokenStats = calculateBrokenBoardStats(limitUpPool.total, brokenPool.total);
  const todayStats = {
    limitUpCount: limitUpPool.total,
    limitDownCount: limitDownPool.total,
    brokenCount: brokenPool.total,
    touchedLimitCount: brokenStats.touchedLimitCount,
    brokenRate: brokenStats.brokenRate,
    totalAmountYi: turnover.totalAmountYi,
    totalVolumeYiHands: turnover.totalVolumeYiHands,
  };
  return {
    tradeDate,
    fetchedAt: nowText(),
    stockCount: breadth.stockCount,
    limitUpCount: limitUpPool.total,
    limitDownCount: limitDownPool.total,
    brokenCount: brokenPool.total,
    touchedLimitCount: brokenStats.touchedLimitCount,
    brokenRate: brokenStats.brokenRate,
    brokenQuoteDate: brokenPool.qdate,
    brokenSource: "东方财富涨停专题当日炸板池",
    limitDownSource: limitDownPool.source,
    limitDownCrossCheck: limitDownPool.crossCheck,
    limitUpStocks,
    limitDownStocks,
    brokenStocks,
    limitUpSub: "点开看个股",
    limitDownSub: "点开看个股",
    upCount: breadth.upCount,
    downCount: breadth.downCount,
    flatCount: breadth.flatCount,
    breadthSource: breadth.source,
    totalAmountYi: turnover.totalAmountYi,
    totalVolumeYiHands: turnover.totalVolumeYiHands,
    recentDays: buildRecentMarketDays(tradeDate, todayStats, options),
    yesterdayLimitUp: yesterdayLimitSummary,
    yesterdayBroken: yesterdayBrokenSummary,
  };
}

function emptyQuoteGroup(name, boardCode, mode, reason) {
  return {
    name,
    boardCode,
    count: null,
    upCount: null,
    limitUpCount: null,
    positiveRate: null,
    avgChangePct: null,
    strength: mode === "repair" ? "修复待更新" : "延续待更新",
    topSectors: [],
    stocks: [],
    summary: reason ? `暂未取到数据：${reason}` : "暂未取到数据",
  };
}

function fallbackMarketStats(tradeDate, reason) {
  return {
    tradeDate,
    fetchedAt: nowText(),
    stockCount: null,
    limitUpCount: null,
    limitDownCount: null,
    brokenCount: null,
    touchedLimitCount: null,
    brokenRate: null,
    brokenQuoteDate: tradeDate,
    brokenSource: reason ? `当日炸板池暂不可用：${reason}` : "当日炸板池暂不可用",
    limitUpStocks: [],
    limitDownStocks: [],
    brokenStocks: [],
    limitUpSub: "点开看个股",
    limitDownSub: "点开看个股",
    upCount: null,
    downCount: null,
    flatCount: null,
    totalAmountYi: null,
    totalVolumeYiHands: null,
    recentDays: [],
    yesterdayLimitUp: emptyQuoteGroup("昨日涨停", "BK0815", "continue", reason),
    yesterdayBroken: emptyQuoteGroup("昨日炸板", "BK1631", "repair", reason),
  };
}

async function safeMarketStats(tradeDate, options = {}) {
  try {
    return await fetchMarketStats(tradeDate, options);
  } catch (error) {
    log("市场强度统计未通过完整性要求，本轮不会发布：" + error.message);
    return fallbackMarketStats(tradeDate, error.message);
  }
}

function ensureCompassOpened() {
  log("已按要求取消活跃市值：不再启动指南针。");
}

function readCachedMarketData() {
  const cachePath = [CONFIG.outputPath, CONFIG.legacyOutputPath].find((filePath) => filePath && fs.existsSync(filePath));
  if (!cachePath) return null;
  const html = fs.readFileSync(cachePath, "utf8");
  const match = html.match(/const MARKET_DATA = (\{[\s\S]*?\});\s*const DAY_MINUTES/);
  if (!match) return null;
  try {
    return sanitizeLegacyStructureFields(JSON.parse(match[1]));
  } catch (_) {
    return null;
  }
}

const LEGACY_BOARD_INTERNAL_SWITCH_KEY = "high" + "Low" + "Switches";

function sanitizeLegacyStructureFields(value) {
  if (Array.isArray(value)) return value.map(sanitizeLegacyStructureFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== LEGACY_BOARD_INTERNAL_SWITCH_KEY)
      .map(([key, item]) => [key, sanitizeLegacyStructureFields(item)]),
  );
}

const GENERIC_STRUCTURE_BOARD_RE = /^(未分类|本地通达信|含可转债|融资融券|深股通|沪股通|昨日涨停|昨日连板|预盈预增|机构重仓|股权激励|基金重仓|破净股|高股息)$/;

function meaningfulStructureBoard(name) {
  const text = String(name || "").trim();
  return text && text !== "--" && !GENERIC_STRUCTURE_BOARD_RE.test(text);
}

function historyStockBoards(row) {
  return uniqueTextList([row?.sector, ...(Array.isArray(row?.concepts) ? row.concepts : [])])
    .filter(meaningfulStructureBoard);
}

function compactHistoryStock(row, options = {}) {
  return {
    code: String(row?.code || row?.f12 || ""),
    name: String(row?.name || row?.f14 || ""),
    sector: String(row?.sector || row?.f100 || "未分类"),
    concepts: uniqueTextList(row?.concepts || []),
    changePct: options.previousMembership ? null : finiteValue(row?.changePct),
    nextDayChangePct: options.previousMembership ? finiteValue(row?.changePct) : null,
    streak: finiteValue(row?.streak),
  };
}

function compactHistoryGroup(group) {
  return {
    count: finiteValue(group?.count),
    upCount: finiteValue(group?.upCount),
    limitUpCount: finiteValue(group?.limitUpCount),
    positiveRate: finiteValue(group?.positiveRate),
    avgChangePct: finiteValue(group?.avgChangePct),
    strength: String(group?.strength || ""),
    summary: String(group?.summary || ""),
    topSectors: Array.isArray(group?.topSectors) ? group.topSectors : [],
  };
}

function snapshotFlowRows(group) {
  return (Array.isArray(group?.rows) ? group.rows : [])
    .filter((row) => Number.isFinite(Number(row?.amount)))
    .map((row) => ({
      name: String(row?.tdxName || row?.name || "--"),
      amount: round2(Number(row.amount)),
    }));
}

function buildMarketHistorySnapshot(marketData, options = {}) {
  const market = marketData?.market || {};
  const tradeDate = market.tradeDate || marketData?.index?.tradeDate || "";
  const indices = (Array.isArray(marketData?.indices) ? marketData.indices : [])
    .filter((item) => item && item.session !== "us" && item.name !== "纳斯达克")
    .map((item) => ({ name: item.name, changePct: round2(changePct(item, "price")) }))
    .filter((item) => Number.isFinite(item.changePct));
  return {
    date: tradeDate,
    fetchedAt: market.fetchedAt || nowText(),
    source: options.source || "每日复盘自动快照",
    market: {
      stockCount: finiteValue(market.stockCount),
      limitUpCount: finiteValue(market.limitUpCount),
      limitDownCount: finiteValue(market.limitDownCount),
      upCount: finiteValue(market.upCount),
      downCount: finiteValue(market.downCount),
      flatCount: finiteValue(market.flatCount),
      totalAmountYi: finiteValue(market.totalAmountYi),
      totalVolumeYiHands: finiteValue(market.totalVolumeYiHands),
      limitUpStocks: (Array.isArray(market.limitUpStocks) ? market.limitUpStocks : []).map((row) => compactHistoryStock(row)),
      limitDownStocks: (Array.isArray(market.limitDownStocks) ? market.limitDownStocks : []).map((row) => compactHistoryStock(row)),
      yesterdayLimitUp: compactHistoryGroup(market.yesterdayLimitUp),
      yesterdayBroken: compactHistoryGroup(market.yesterdayBroken),
    },
    indices,
    flows: {
      industry: snapshotFlowRows(marketData?.industry),
      concept: snapshotFlowRows(marketData?.concept),
    },
    structure: options.structure || marketData?.marketStructure || null,
    diagnosis: options.diagnosis ? { score: options.diagnosis.score, tone: options.diagnosis.tone } : null,
  };
}

function loadMarketHistoryCache() {
  try {
    if (!fs.existsSync(CONFIG.marketHistoryPath)) return { version: 1, updatedAt: "", days: [] };
    const parsed = JSON.parse(fs.readFileSync(CONFIG.marketHistoryPath, "utf8"));
    return {
      version: 1,
      updatedAt: parsed.updatedAt || "",
      days: Array.isArray(parsed.days)
        ? parsed.days.filter((day) => day && day.date).map(sanitizeLegacyStructureFields)
        : [],
    };
  } catch (error) {
    log("复盘历史库读取失败，将重新建立：" + error.message);
    return { version: 1, updatedAt: "", days: [] };
  }
}

function upsertMarketHistoryDay(cache, snapshot) {
  if (!snapshot?.date) return;
  cache.days = (Array.isArray(cache.days) ? cache.days : []).filter((day) => day?.date !== snapshot.date);
  cache.days.push(snapshot);
  cache.days.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  cache.days = cache.days.slice(0, CONFIG.marketHistoryMaxDays);
}

function saveMarketHistoryCache(cache) {
  if (dryRun) return;
  ensureDir(path.dirname(CONFIG.marketHistoryPath));
  cache.updatedAt = nowText();
  writeUtf8File(CONFIG.marketHistoryPath, JSON.stringify(cache));
}

function repairHistoricalBreadthFromLocal(cache, currentDate) {
  const targets = new Set((cache.days || [])
    .filter((day) => day?.date && day.date < currentDate)
    .filter((day) => {
      const market = day.market || {};
      const missingBreadth = [market.stockCount, market.upCount, market.downCount, market.flatCount]
        .some((value) => finiteValue(value) === null);
      return missingBreadth || market.limitCountsSource !== "通达信本地日线逐股校验";
    })
    .map((day) => day.date));
  if (!targets.size || !CONFIG.tdxVipdocDir) return;

  const counts = new Map([...targets].map((date) => [date, {
    stockCount: 0,
    upCount: 0,
    downCount: 0,
    flatCount: 0,
    limitUpCount: 0,
    limitDownCount: 0,
  }]));
  const nameMap = loadLocalTdxNameMap();
  for (const prefix of ["sh", "sz", "bj"]) {
    const dir = path.join(CONFIG.tdxVipdocDir, prefix, "lday");
    if (!fs.existsSync(dir)) continue;
    for (const fileName of fs.readdirSync(dir)) {
      const match = fileName.match(/^(?:sh|sz|bj)(\d{6})\.day$/i);
      if (!match || !isAStockCodeForTdxPrefix(match[1], prefix)) continue;
      const code = match[1];
      const history = readTdxDayHistory(code, prefix);
      for (let index = 1; index < history.length; index += 1) {
        const row = history[index];
        if (!targets.has(row.date)) continue;
        const previous = history[index - 1];
        const item = counts.get(row.date);
        if (!previous?.close || !item) continue;
        const delta = row.close - previous.close;
        item.stockCount += 1;
        if (delta > 0.004) item.upCount += 1;
        else if (delta < -0.004) item.downCount += 1;
        else item.flatCount += 1;
        const limitQuote = {
          code,
          name: nameMap.get(code) || "",
          price: row.close,
          preClose: previous.close,
          high: row.high,
          low: row.low,
          listingIndex: index,
        };
        if (isHistoricalClosedLimit(limitQuote, "up")) item.limitUpCount += 1;
        if (isHistoricalClosedLimit(limitQuote, "down")) item.limitDownCount += 1;
      }
    }
  }

  for (const day of cache.days || []) {
    const item = counts.get(day.date);
    if (!item || item.stockCount < MIN_COMPLETE_A_STOCK_COUNT) {
      if (item) log(`历史市场广度 ${day.date} 仅回补${item.stockCount}只，未达到完整性阈值，保留待后续补采。`);
      continue;
    }
    day.market = day.market || {};
    Object.assign(day.market, item, {
      breadthSource: "通达信本地日线逐股回补",
      limitCountsSource: "通达信本地日线逐股校验",
    });
    day.source = `${day.source || "历史快照"}；全 A 涨跌与涨跌停家数已由通达信日线逐股回补`;
    log(`历史市场统计已修复 ${day.date}：上涨${item.upCount}、下跌${item.downCount}、涨停${item.limitUpCount}、跌停${item.limitDownCount}。`);
  }
}

function localHistoricalTurnoverMap() {
  const map = new Map();
  const sh = readTdxDayHistory("000001", "sh");
  const sz = readTdxDayHistory("399001", "sz");
  sh.forEach((row, index) => {
    const prev = sh[index - 1];
    map.set(row.date, {
      totalAmountYi: round1((Number(row.amount) || 0) / 100000000),
      totalVolumeYiHands: round1((Number(row.volume) || 0) / 100000000),
      indexChangePct: prev?.close ? round2(((row.close - prev.close) / prev.close) * 100) : null,
    });
  });
  sz.forEach((row) => {
    const item = map.get(row.date) || { totalAmountYi: 0, totalVolumeYiHands: 0, indexChangePct: null };
    item.totalAmountYi = round1((Number(item.totalAmountYi) || 0) + (Number(row.amount) || 0) / 100000000);
    item.totalVolumeYiHands = round1((Number(item.totalVolumeYiHands) || 0) + (Number(row.volume) || 0) / 100000000);
    map.set(row.date, item);
  });
  return map;
}

function bootstrapHistoryDays(cache, marketData) {
  const market = marketData?.market || {};
  const currentDate = market.tradeDate || marketData?.index?.tradeDate || "";
  const existing = new Set((cache.days || []).map((day) => day.date));
  const localTurnover = localHistoricalTurnoverMap();
  const recent = Array.isArray(market.recentDays) ? market.recentDays : [];
  recent.forEach((day) => {
    if (!day?.date || day.date === currentDate || existing.has(day.date)) return;
    const local = localTurnover.get(day.date) || {};
    upsertMarketHistoryDay(cache, {
      date: day.date,
      fetchedAt: nowText(),
      source: "历史统计接口与通达信日线回补",
      market: {
        limitUpCount: finiteValue(day.limitUpCount),
        limitDownCount: finiteValue(day.limitDownCount),
        totalAmountYi: finiteValue(day.totalAmountYi) ?? finiteValue(local.totalAmountYi),
        totalVolumeYiHands: finiteValue(day.totalVolumeYiHands) ?? finiteValue(local.totalVolumeYiHands),
        limitUpStocks: [],
        limitDownStocks: [],
      },
      indices: Number.isFinite(Number(day.indexChangePct ?? local.indexChangePct))
        ? [{ name: "上证指数", changePct: round2(day.indexChangePct ?? local.indexChangePct) }]
        : [],
      flows: { industry: [], concept: [] },
      structure: null,
      diagnosis: null,
    });
  });
  const previousDate = previousWeekdayText(currentDate);
  const previousLeaders = Array.isArray(market.yesterdayLimitUp?.stocks) ? market.yesterdayLimitUp.stocks : [];
  if (previousDate && !existing.has(previousDate) && previousLeaders.length) {
    const local = localTurnover.get(previousDate) || {};
    upsertMarketHistoryDay(cache, {
      date: previousDate,
      fetchedAt: nowText(),
      source: "由今日昨日涨停池回补",
      market: {
        limitUpCount: finiteValue(market.yesterdayLimitUp?.count),
        limitDownCount: null,
        totalAmountYi: finiteValue(local.totalAmountYi),
        totalVolumeYiHands: finiteValue(local.totalVolumeYiHands),
        limitUpStocks: previousLeaders.map((row) => compactHistoryStock(row, { previousMembership: true })),
        limitDownStocks: [],
      },
      indices: Number.isFinite(Number(local.indexChangePct)) ? [{ name: "上证指数", changePct: round2(local.indexChangePct) }] : [],
      flows: { industry: [], concept: [] },
      structure: null,
      diagnosis: null,
    });
  }
}

function mergeHistoryIntoRecentDays(marketData, cache) {
  const market = marketData.market || {};
  const online = Array.isArray(market.recentDays) ? market.recentDays : [];
  const byDate = new Map(online.filter((day) => day?.date).map((day) => [day.date, { ...day }]));
  (cache.days || []).forEach((day) => {
    const item = byDate.get(day.date) || { date: day.date, compactDate: formatCompactDate(day.date) };
    const stored = day.market || {};
    const verifiedLimitCounts = stored.limitCountsSource === "通达信本地日线逐股校验";
    if (finiteValue(stored.limitUpCount) !== null && (
      finiteValue(item.limitUpCount) === null || verifiedLimitCounts || (Number(item.limitUpCount) === 0 && Number(stored.limitUpCount) > 0)
    )) item.limitUpCount = stored.limitUpCount;
    if (finiteValue(stored.limitDownCount) !== null && (
      finiteValue(item.limitDownCount) === null || verifiedLimitCounts || (Number(item.limitDownCount) === 0 && Number(stored.limitDownCount) > 0)
    )) item.limitDownCount = stored.limitDownCount;
    if (finiteValue(item.totalAmountYi) === null && finiteValue(stored.totalAmountYi) !== null) item.totalAmountYi = stored.totalAmountYi;
    if (finiteValue(item.totalVolumeYiHands) === null && finiteValue(stored.totalVolumeYiHands) !== null) item.totalVolumeYiHands = stored.totalVolumeYiHands;
    const sh = Array.isArray(day.indices) ? day.indices.find((row) => row.name === "上证指数") : null;
    if (finiteValue(item.indexChangePct) === null && finiteValue(sh?.changePct) !== null) item.indexChangePct = sh.changePct;
    byDate.set(day.date, item);
  });
  market.recentDays = [...byDate.values()]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, CONFIG.marketHistoryMaxDays);
}

function structureBoardMap(marketData, historyDays) {
  const map = new Map();
  function ensure(name) {
    const text = String(name || "").trim();
    if (!meaningfulStructureBoard(text)) return null;
    if (!map.has(text)) {
      map.set(text, {
        name: text,
        flowAmount: null,
        flowGroup: "",
        flowPoints: 0,
        limitUpCodes: new Set(),
        limitDownCodes: new Set(),
        previousLeaderCodes: new Set(),
        continuingCodes: new Set(),
        positivePreviousCodes: new Set(),
        historyHits: 0,
      });
    }
    return map.get(text);
  }
  const flowGroups = [
    ["二级行业", marketData?.industry?.rows || []],
    ["概念板块", marketData?.concept?.rows || []],
  ];
  flowGroups.forEach(([group, rows]) => {
    const valid = rows.filter((row) => Number.isFinite(Number(row?.amount)));
    const positive = [...valid].filter((row) => Number(row.amount) > 0).sort((a, b) => Number(b.amount) - Number(a.amount));
    const negative = [...valid].filter((row) => Number(row.amount) < 0).sort((a, b) => Number(a.amount) - Number(b.amount));
    valid.forEach((row) => {
      const item = ensure(row.tdxName || row.name);
      if (!item) return;
      item.flowAmount = Number(row.amount);
      item.flowGroup = group;
    });
    positive.forEach((row, index) => {
      const item = ensure(row.tdxName || row.name);
      if (item) item.flowPoints = Math.max(item.flowPoints, index < 3 ? 4 - index : 1);
    });
    negative.forEach((row, index) => {
      const item = ensure(row.tdxName || row.name);
      if (item) item.flowPoints = Math.min(item.flowPoints, index < 3 ? -3 + index : -1);
    });
  });
  const market = marketData?.market || {};
  (market.limitUpStocks || []).forEach((row) => historyStockBoards(row).forEach((name) => ensure(name)?.limitUpCodes.add(row.code)));
  (market.limitDownStocks || []).forEach((row) => historyStockBoards(row).forEach((name) => ensure(name)?.limitDownCodes.add(row.code)));
  (market.yesterdayLimitUp?.stocks || []).forEach((row) => {
    historyStockBoards(row).forEach((name) => {
      const item = ensure(name);
      if (!item) return;
      item.previousLeaderCodes.add(row.code);
      if (isLimitUp(row)) item.continuingCodes.add(row.code);
      if (Number(row.changePct) > 0) item.positivePreviousCodes.add(row.code);
    });
  });
  [...map.values()].forEach((item) => {
    for (const day of historyDays.slice(0, 5)) {
      const flowRows = [...(day?.flows?.industry || []), ...(day?.flows?.concept || [])];
      const flow = flowRows.find((row) => row.name === item.name);
      const limitHit = (day?.market?.limitUpStocks || []).some((row) => historyStockBoards(row).includes(item.name));
      if ((flow && Number(flow.amount) > 0) || limitHit) item.historyHits += 1;
    }
  });
  return map;
}

function boardEvidence(item, previousCodeSet) {
  const newLimitCount = [...item.limitUpCodes].filter((code) => !previousCodeSet.has(code)).length;
  const parts = [];
  if (Number.isFinite(item.flowAmount)) parts.push((item.flowAmount >= 0 ? "净流入" : "净流出") + reportAmount(item.flowAmount));
  if (item.limitUpCodes.size) parts.push("涨停" + item.limitUpCodes.size + "只");
  if (item.continuingCodes.size) parts.push("昨日前排继续涨停" + item.continuingCodes.size + "只");
  if (newLimitCount) parts.push("新增涨停" + newLimitCount + "只");
  if (item.historyHits) parts.push("近5日有效延续" + item.historyHits + "日");
  return { text: parts.join("，") || "以当日相对强度入选", newLimitCount };
}

function analyzeMarketStructure(marketData) {
  const currentDate = marketData?.market?.tradeDate || marketData?.index?.tradeDate || "";
  const historyDays = (marketData?.marketHistory?.days || []).filter((day) => day.date !== currentDate);
  const previousCodeSet = new Set((marketData?.market?.yesterdayLimitUp?.stocks || []).map((row) => row.code));
  const map = structureBoardMap(marketData, historyDays);
  const ranked = [...map.values()].map((item) => {
    const evidence = boardEvidence(item, previousCodeSet);
    const score = item.flowPoints + Math.min(6, item.limitUpCodes.size * 1.5) +
      Math.min(3, item.continuingCodes.size * 1.5) + Math.min(3, item.historyHits) -
      Math.min(4, item.limitDownCodes.size * 2);
    return {
      name: item.name,
      score: round2(score),
      evidence: evidence.text,
      flowAmount: item.flowAmount,
      limitUpCount: item.limitUpCodes.size,
      limitDownCount: item.limitDownCodes.size,
      previousLeaderCount: item.previousLeaderCodes.size,
      continuingCount: item.continuingCodes.size,
      positivePreviousCount: item.positivePreviousCodes.size,
      newLimitCount: evidence.newLimitCount,
      historyHits: item.historyHits,
    };
  }).filter((item) => item.flowAmount > 0 || item.limitUpCount >= 1 || item.continuingCount >= 1)
    .sort((a, b) => b.score - a.score || b.limitUpCount - a.limitUpCount || (Number(b.flowAmount) || 0) - (Number(a.flowAmount) || 0));
  const topScore = ranked[0]?.score ?? -Infinity;
  const mainline = ranked.filter((item) => item.score >= 5 && item.score >= topScore - 1.5).slice(0, 2);
  const mainNames = new Set(mainline.map((item) => item.name));
  const subline = ranked.filter((item) => !mainNames.has(item.name) && item.score >= 3).slice(0, 3);
  const previousSnapshot = historyDays[0] || null;
  let previousMain = Array.isArray(previousSnapshot?.structure?.mainline)
    ? previousSnapshot.structure.mainline.map((item) => item.name).filter(Boolean)
    : [];
  if (!previousMain.length) {
    const counts = new Map();
    (marketData?.market?.yesterdayLimitUp?.stocks || []).forEach((row) =>
      historyStockBoards(row).forEach((name) => counts.set(name, (counts.get(name) || 0) + 1)),
    );
    previousMain = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name]) => name);
  }
  const currentMain = mainline.map((item) => item.name);
  const shared = currentMain.filter((name) => previousMain.includes(name));
  let interSectorText = "历史样本不足，暂不确认板块之间发生切换。";
  let interSectorSwitch = false;
  if (currentMain.length && previousMain.length) {
    if (shared.length) {
      interSectorText = "主线延续：" + shared.join("、") + "仍在当前主线中，板块间尚未发生明确切换。";
    } else {
      interSectorSwitch = true;
      interSectorText = "板块间切换：上一交易日强方向" + previousMain.join("、") +
        "让位于今日" + currentMain.join("、") + "，需要观察新方向次日能否继续获得资金和涨停集群确认。";
    }
  }
  return {
    historyDaysUsed: historyDays.length,
    mainline,
    subline,
    interSectorSwitch,
    interSectorText,
    summary: "主线：" + (mainline.map((item) => item.name).join("、") || "暂未形成") +
      "；支线：" + (subline.map((item) => item.name).join("、") || "暂未确认") + "。",
  };
}

function updateMarketHistory(marketData, options = {}) {
  const loadedCache = loadMarketHistoryCache();
  const initialDates = new Set((loadedCache.days || []).map((day) => day?.date).filter(Boolean));
  const hydrated = hydrateHistoryCacheFromStructuredArchive(
    loadedCache,
    CONFIG.structuredHistoryDir,
    CONFIG.marketHistoryMaxDays,
  );
  const cache = hydrated.cache;
  const recoveredCount = hydrated.recoveredDates.filter((date) => !initialDates.has(date)).length;
  if (recoveredCount) log(`已从结构化复盘归档恢复${recoveredCount}个缺失交易日。`);
  bootstrapHistoryDays(cache, marketData);
  repairHistoricalBreadthFromLocal(cache, marketData?.market?.tradeDate || marketData?.index?.tradeDate || "");
  upsertMarketHistoryDay(cache, buildMarketHistorySnapshot(marketData));
  marketData.marketHistory = { version: 1, updatedAt: nowText(), days: cache.days };
  mergeHistoryIntoRecentDays(marketData, cache);
  const structure = analyzeMarketStructure(marketData);
  marketData.marketStructure = structure;
  marketData.market.marketStructure = structure;
  const diagnosis = buildDiagnosis(marketData);
  upsertMarketHistoryDay(cache, buildMarketHistorySnapshot(marketData, { structure, diagnosis }));
  marketData.marketHistory = { version: 1, updatedAt: nowText(), days: cache.days };
  mergeHistoryIntoRecentDays(marketData, cache);
  if (options.persist !== false) saveMarketHistoryCache(cache);
  return options.returnCache ? { marketData, cache } : marketData;
}

function fetchIndexSnapshot(tradeDate, reason, def = MAJOR_INDEXES[0]) {
  if (!def.secid) throw new Error(`${def.name}没有东方财富快照代码`);
  const url =
    "https://push2.eastmoney.com/api/qt/stock/get" +
    `?secid=${encodeURIComponent(def.secid)}` +
    "&fields=f43,f44,f45,f46,f47,f48,f57,f58,f59,f60,f107,f170,f171";
  const json = fetchJson(url);
  const data = json.data || {};
  const divisor = Number(data.f59) === 2 ? 100 : 1;
  const price = Number(data.f43) / divisor;
  const preClose = Number(data.f60) / divisor;
  if (!Number.isFinite(price) || !Number.isFinite(preClose)) {
    throw new Error(`${def.name}备用快照没有返回有效价格`);
  }
  const now = new Date();
  const fallbackMinute = tradeDate === todayLocal()
    ? Math.max(0, Math.min(240, timeTextToMinute(`${pad2(now.getHours())}:${pad2(now.getMinutes())}`)))
    : 239;
  log(`${def.name}分时接口暂不可用，只展示当前真实快照，不补画历史轨迹：${reason}`);
  return buildSnapshotOnlyIndex({
    def,
    data,
    tradeDate,
    price,
    preClose,
    minute: fallbackMinute,
    time: minuteToTime(fallbackMinute),
    reason,
  });
}

function fetchTencentIndex(def = MAJOR_INDEXES[0]) {
  const minutePath = def.session === "us" ? "usMinute" : "minute";
  const url = `https://web.ifzq.gtimg.cn/appstock/app/${minutePath}/query?code=${encodeURIComponent(def.tencent)}`;
  const json = fetchJson(url, 20);
  const block = json.data?.[def.tencent]?.data || {};
  const rows = Array.isArray(block.data) ? block.data : [];
  const qt = json.data?.[def.tencent]?.qt?.[def.tencent] || [];
  const rawDate = String(block.date || "");
  const quoteDateText = String(qt[30] || "");
  const tradeDate = /^\d{8}$/.test(rawDate)
    ? `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`
    : quoteDateText.slice(0, 10);
  if (!rows.length || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    throw new Error(`腾讯${def.name}分时没有返回有效数据`);
  }
  const preClose = Number(qt[4]) || Number(rows[0].split(/\s+/)[1]);
  const points = rows.map((row) => {
    const parts = row.trim().split(/\s+/);
    const time = `${parts[0].slice(0, 2)}:${parts[0].slice(2, 4)}`;
    return {
      dateTime: `${tradeDate} ${time}`,
      time,
      price: Number(parts[1]),
      volume: Number(parts[2]) || 0,
      amount: Number(parts[3]) || 0,
      minute: timeTextToIndexMinute(time, def),
    };
  }).filter((point) => Number.isFinite(point.price));
  if (!points.length) throw new Error(`腾讯${def.name}分时价格无效`);
  return {
    key: def.key,
    name: def.name,
    code: def.code,
    preClose,
    tradeDate,
    points,
    source: "腾讯指数分时备用源",
  };
}

function fetchEastmoneyIndex(def = MAJOR_INDEXES[0]) {
  if (!def.secid) throw new Error(`${def.name}没有东方财富分时代码`);
  const url =
    "https://push2his.eastmoney.com/api/qt/stock/trends2/get" +
    `?secid=${encodeURIComponent(def.secid)}` +
    "&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13" +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58" +
    "&ut=bd1d9ddb04089700cf9c27f6f7426281" +
    "&ndays=1&iscr=0&iscca=0";
  const json = fetchJson(url);
  if (!json.data || !Array.isArray(json.data.trends)) {
    throw new Error(`${def.name}接口没有返回分时数据`);
  }
  const points = json.data.trends.map((item) => {
    const parts = item.split(",");
    const dateTime = parts[0];
    const time = dateTime.slice(11, 16);
    return {
      dateTime,
      time,
      price: Number(parts[2]),
      volume: Number(parts[5]),
      amount: Number(parts[6]),
      minute: timeTextToIndexMinute(time, def),
    };
  }).filter((point) => Number.isFinite(point.price));
  const tradeDate = points[0]?.dateTime.slice(0, 10);
  return {
    key: def.key,
    name: json.data.name || def.name,
    code: json.data.code || def.code,
    preClose: Number(json.data.preClose),
    tradeDate,
    points,
    source: "东方财富指数分时主源",
  };
}

function fetchIndexByDef(def = MAJOR_INDEXES[0], options = {}) {
  const expectedDate = force ? null : expectedMarketDate();
  if (options.preferTencent && def.tencent) {
    try {
      const tencentIndex = fetchTencentIndex(def);
      if (!expectedDate || tencentIndex.tradeDate === expectedDate || def.session === "us") {
        return tencentIndex;
      }
      log(`${def.name}腾讯优先分时日期为 ${tencentIndex.tradeDate}，目标交易日 ${expectedDate}。`);
    } catch (error) {
      log(`${def.name}腾讯优先分时暂不可用：${error.message}`);
    }
  }
  try {
    return fetchEastmoneyIndex(def);
  } catch (error) {
    try {
      const tencentIndex = fetchTencentIndex(def);
      if (!expectedDate || tencentIndex.tradeDate === expectedDate || def.session === "us") {
        log(`${def.name}分时接口暂不可用，改用腾讯备用分时 ${tencentIndex.tradeDate}。`);
        return tencentIndex;
      }
      log(`${def.name}腾讯备用分时日期为 ${tencentIndex.tradeDate}，目标交易日 ${expectedDate}。`);
    } catch (fallbackError) {
      log(`${def.name}腾讯备用分时暂不可用：${fallbackError.message}`);
    }
    if (options.allowCache) {
      const cachedData = readCachedMarketData();
      const cachedIndex = def.key === MAJOR_INDEXES[0].key
        ? cachedData?.index
        : (cachedData?.indices || []).find((item) => item.key === def.key || item.code === def.code);
      if (
        cachedIndex &&
        Array.isArray(cachedIndex.points) &&
        cachedIndex.points.length &&
        (!expectedDate || cachedIndex.tradeDate === expectedDate || def.session === "us")
      ) {
        log(`${def.name}分时接口暂不可用，沿用本地缓存 ${cachedIndex.tradeDate} 分时。`);
        return cachedIndex;
      }
      return fetchIndexSnapshot(expectedDate || todayLocal(), error.message, def);
    }
    throw error;
  }
}

async function fetchIndex(options = {}) {
  return fetchIndexByDef(MAJOR_INDEXES[0], { allowCache: true, preferTencent: options.preferTencent });
}

const CORE_INDEX_CROSSCHECK_KEYS = new Set(["sh000001", "sz399001", "sz399006"]);
const indexCrossCheckCache = new Map();

function indexLatestChangePct(index) {
  const latest = index?.points?.at(-1);
  const price = Number(latest?.price);
  const preClose = Number(index?.preClose);
  return price > 0 && preClose > 0 ? (price / preClose - 1) * 100 : null;
}

function buildIndexCrossCheck(primary, secondary) {
  const primaryPrice = Number(primary?.points?.at(-1)?.price);
  const secondaryPrice = Number(secondary?.points?.at(-1)?.price);
  const priceGapPct = primaryPrice > 0 && secondaryPrice > 0
    ? Math.abs(primaryPrice - secondaryPrice) / primaryPrice * 100
    : null;
  const primaryChange = indexLatestChangePct(primary);
  const secondaryChange = indexLatestChangePct(secondary);
  const changeGap = Number.isFinite(primaryChange) && Number.isFinite(secondaryChange)
    ? Math.abs(primaryChange - secondaryChange)
    : null;
  const sameDate = primary?.tradeDate === secondary?.tradeDate;
  const valid = sameDate && Number.isFinite(priceGapPct) && priceGapPct <= 0.25 && Number.isFinite(changeGap) && changeGap <= 0.2;
  return {
    status: valid ? "ok" : "warning",
    checkedAt: nowText(),
    primarySource: primary?.source || "主源",
    secondarySource: secondary?.source || "备用源",
    primaryDate: primary?.tradeDate || "",
    secondaryDate: secondary?.tradeDate || "",
    priceGapPct: Number.isFinite(priceGapPct) ? round2(priceGapPct) : null,
    changeGapPct: Number.isFinite(changeGap) ? round2(changeGap) : null,
    detail: valid
      ? `双源同日，最新点位偏差 ${round2(priceGapPct)}%，涨跌幅偏差 ${round2(changeGap)} 个百分点`
      : `双源校验需注意：日期${sameDate ? "一致" : "不一致"}，点位偏差${Number.isFinite(priceGapPct) ? round2(priceGapPct) + "%" : "不可计算"}，涨跌幅偏差${Number.isFinite(changeGap) ? round2(changeGap) + "个百分点" : "不可计算"}`,
  };
}

function attachIndexCrossCheck(index, def) {
  if (!CORE_INDEX_CROSSCHECK_KEYS.has(def.key)) {
    return {...index, crossCheck: {status: "single", checkedAt: nowText(), detail: "非核心指数保留单源实时分时"}};
  }
  const cacheKey = `${def.key}:${index.tradeDate}:${index.points?.at(-1)?.minute ?? ""}:${index.source || ""}`;
  const cached = indexCrossCheckCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < 120000) return {...index, crossCheck: cached.value};
  try {
    const secondary = String(index.source || "").includes("腾讯") ? fetchEastmoneyIndex(def) : fetchTencentIndex(def);
    const value = buildIndexCrossCheck(index, secondary);
    indexCrossCheckCache.clear();
    indexCrossCheckCache.set(cacheKey, {savedAt: Date.now(), value});
    return {...index, crossCheck: value};
  } catch (error) {
    return {
      ...index,
      crossCheck: {
        status: "warning",
        checkedAt: nowText(),
        primarySource: index.source || "主源",
        secondarySource: String(index.source || "").includes("腾讯") ? "东方财富指数分时主源" : "腾讯指数分时备用源",
        detail: `备用源暂不可用：${error.message}`,
      },
    };
  }
}

function fetchMajorIndices(primaryIndex, options = {}) {
  const cached = readCachedMarketData()?.indices || [];
  const results = [];
  for (const def of MAJOR_INDEXES) {
    if (def.key === MAJOR_INDEXES[0].key && primaryIndex) {
      results.push({ ...primaryIndex, key: def.key, name: primaryIndex.name || def.name, code: primaryIndex.code || def.code });
      continue;
    }
    try {
      results.push(fetchIndexByDef(def, { allowCache: false, preferTencent: options.preferTencent }));
    } catch (error) {
      const cachedIndex = cached.find((item) => (item.key === def.key || item.code === def.code) && (item.tradeDate === primaryIndex.tradeDate || def.session === "us"));
      if (cachedIndex) {
        log(`${def.name}暂未取到，沿用同日缓存。`);
        results.push(cachedIndex);
      } else {
        log(`${def.name}暂未取到，本次主要指数矩阵跳过：${error.message}`);
      }
    }
  }
  return results
    .filter((item) => item && Array.isArray(item.points) && item.points.length)
    .map((item) => attachIndexCrossCheck(item, MAJOR_INDEXES.find((def) => def.key === item.key || def.code === item.code) || MAJOR_INDEXES[0]));
}

async function fetchBoardRows(fsCode) {
  const primaryUrl =
    "https://data.eastmoney.com/dataapi/bkzj/getbkzj" +
    "?key=f62" +
    `&code=${encodeURIComponent(fsCode)}`;
  try {
    const json = fetchJson(primaryUrl);
    const diff = json.data?.diff;
    if (!Array.isArray(diff)) throw new Error(`板块主接口没有返回数据：${fsCode}`);
    return diff.map((row) => ({
      name: String(row.f14 || row.f12 || ""),
      code: String(row.f12 || ""),
      amount: round1(Number(row.f62) / 100000000),
      changePct: Number(row.f3),
      timestamp: Number(row.f124 || Date.now() / 1000),
    })).filter((row) => row.name && Number.isFinite(row.amount));
  } catch (error) {
    log(`板块主接口失败，改用备用接口：${error.message}`);
  }

  const fallbackUrl =
    "https://push2.eastmoney.com/api/qt/clist/get" +
    "?pn=1&pz=500&po=1&np=1&fltt=2&invt=2&fid=f62" +
    `&fs=${encodeURIComponent(fsCode)}` +
    "&fields=f12,f14,f3,f62,f124";
  const json = fetchJson(fallbackUrl, 12);
  const diff = json.data?.diff;
  if (!Array.isArray(diff)) throw new Error(`板块备用接口没有返回数据：${fsCode}`);
  return diff.map((row) => ({
    name: String(row.f14 || row.f12 || ""),
    code: String(row.f12 || ""),
    amount: round1(Number(row.f62) / 100000000),
    changePct: Number(row.f3),
    timestamp: Number(row.f124 || Date.now() / 1000),
  })).filter((row) => row.name && Number.isFinite(row.amount));
}

async function fetchBoardGroup(title, fsCode) {
  const rows = decorateBoardRows(await fetchBoardRows(fsCode));
  const inflow = [...rows].sort((a, b) => b.amount - a.amount).slice(0, 10);
  const outflow = [...rows].sort((a, b) => a.amount - b.amount).slice(0, 10);
  return { title, rows: [...inflow, ...outflow] };
}

function latestTradeMinuteFromIndex(index) {
  const points = Array.isArray(index?.points) ? index.points : [];
  const minutes = points.map((point) => Number(point.minute)).filter(Number.isFinite);
  if (!minutes.length) return 0;
  return Math.max(0, Math.min(240, Math.max(...minutes)));
}

function emptyFlowSeriesCache() {
  return { version: 3, tradeDate: "", groups: { industry: {}, concept: {} } };
}

function normalizeFlowSeriesCache(cache) {
  const normalized = cache && typeof cache === "object" ? cache : emptyFlowSeriesCache();
  normalized.version = Math.max(3, Number(normalized.version) || 0);
  normalized.groups = normalized.groups || {};
  normalized.groups.industry = normalized.groups.industry || {};
  normalized.groups.concept = normalized.groups.concept || {};
  return normalized;
}

function readFlowSeriesCacheFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return normalizeFlowSeriesCache(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch (error) {
    log(`忽略损坏的板块资金缓存：${filePath}；${error.message}`);
    return null;
  }
}

function flowSeriesCacheQuality(cache) {
  let pointCount = 0;
  let multiPointCount = 0;
  let validatedCount = 0;
  for (const groupKey of ["industry", "concept"]) {
    for (const entry of Object.values(cache?.groups?.[groupKey] || {})) {
      const count = Array.isArray(entry?.points) ? entry.points.length : 0;
      pointCount += count;
      if (count >= 2) multiPointCount += 1;
      if (entry?.flowValidated && count >= 2) validatedCount += 1;
    }
  }
  return validatedCount * 1000000 + multiPointCount * 10000 + pointCount;
}

function siblingFlowSeriesCachePaths() {
  const result = [];
  if (SHARED_FLOW_SERIES_PATH) result.push(SHARED_FLOW_SERIES_PATH);
  const runtimeFamily = path.dirname(CONFIG.baseDir);
  if (!/A股复盘软件运行文件[\\/]定制版$/i.test(runtimeFamily) || !fs.existsSync(runtimeFamily)) return result;
  for (const item of fs.readdirSync(runtimeFamily, {withFileTypes: true})) {
    if (!item.isDirectory() || !item.name.startsWith("版本_")) continue;
    const siblingRoot = path.join(runtimeFamily, item.name);
    result.push(
      path.join(siblingRoot, "缓存", "A股板块资金分时缓存.json"),
      path.join(siblingRoot, "A股复盘Windows量化同步版", "缓存", "A股板块资金分时缓存.json"),
    );
  }
  return [...new Set(result.map((item) => path.resolve(item)))]
    .filter((item) => item !== path.resolve(CONFIG.flowSeriesPath));
}

function mergeRecoveredFlowSeries(currentCache, recoveredCache, sourcePath) {
  let current = normalizeFlowSeriesCache(currentCache);
  const recovered = normalizeFlowSeriesCache(recoveredCache);
  const currentDate = String(current.tradeDate || "");
  const recoveredDate = String(recovered.tradeDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(recoveredDate)) return {cache: current, recoveredEntries: 0};
  if (!currentDate || recoveredDate > currentDate) {
    const replacement = JSON.parse(JSON.stringify(recovered));
    replacement.recoveredFrom = sourcePath;
    replacement.recoveredAt = nowText();
    return {
      cache: normalizeFlowSeriesCache(replacement),
      recoveredEntries: Object.values(replacement.groups.industry || {}).length
        + Object.values(replacement.groups.concept || {}).length,
    };
  }
  if (recoveredDate !== currentDate) return {cache: current, recoveredEntries: 0};

  let recoveredEntries = 0;
  for (const groupKey of ["industry", "concept"]) {
    for (const [code, recoveredEntry] of Object.entries(recovered.groups[groupKey] || {})) {
      const recoveredPoints = Array.isArray(recoveredEntry?.points) ? recoveredEntry.points : [];
      if (recoveredPoints.length < 2) continue;
      const currentEntry = current.groups[groupKey][code] || {};
      const currentPoints = Array.isArray(currentEntry?.points) ? currentEntry.points : [];
      const mergedPoints = mergeFlowPoints(recoveredPoints, currentPoints);
      const improvesSeries = mergedPoints.length > currentPoints.length;
      const improvesValidation = Boolean(recoveredEntry.flowValidated) && !currentEntry.flowValidated;
      if (!improvesSeries && !improvesValidation) continue;
      current.groups[groupKey][code] = {
        ...recoveredEntry,
        ...currentEntry,
        points: mergedPoints,
        flowSource: currentEntry.flowValidated
          ? currentEntry.flowSource
          : (recoveredEntry.flowSource || currentEntry.flowSource || "eastmoney-board-minute-flow"),
        flowValidated: Boolean(currentEntry.flowValidated || recoveredEntry.flowValidated),
        officialLatestMinute: Math.max(
          Number(currentEntry.officialLatestMinute) || 0,
          Number(recoveredEntry.officialLatestMinute) || 0,
          Number(mergedPoints.at(-1)?.minute) || 0,
        ),
      };
      recoveredEntries += 1;
    }
  }
  if (recoveredEntries) {
    current.recoveredFrom = sourcePath;
    current.recoveredAt = nowText();
  }
  return {cache: current, recoveredEntries};
}

function recoverFlowSeriesCache(cache) {
  let current = normalizeFlowSeriesCache(cache);
  let recoveredEntries = 0;
  let recoveredSource = "";
  const candidates = siblingFlowSeriesCachePaths()
    .map((filePath) => ({filePath, cache: readFlowSeriesCacheFile(filePath)}))
    .filter((item) => item.cache)
    .sort((a, b) => flowSeriesCacheQuality(b.cache) - flowSeriesCacheQuality(a.cache));
  for (const candidate of candidates) {
    const result = mergeRecoveredFlowSeries(current, candidate.cache, candidate.filePath);
    current = result.cache;
    if (result.recoveredEntries) {
      recoveredEntries += result.recoveredEntries;
      recoveredSource = candidate.filePath;
    }
  }
  if (recoveredEntries) {
    log(`已恢复跨版本真实板块资金序列：${recoveredEntries} 条；来源：${recoveredSource}`);
  }
  return current;
}

function readFlowSeriesCache() {
  try {
    const cache = readFlowSeriesCacheFile(CONFIG.flowSeriesPath) || emptyFlowSeriesCache();
    return recoverFlowSeriesCache(cache);
  } catch (error) {
    log("板块资金分时缓存读取失败，已重建：" + error.message);
    return recoverFlowSeriesCache(emptyFlowSeriesCache());
  }
}

function writeFlowSeriesCache(cache) {
  if (dryRun) return;
  writeUtf8File(CONFIG.flowSeriesPath, JSON.stringify(cache));
  if (SHARED_FLOW_SERIES_PATH && path.resolve(SHARED_FLOW_SERIES_PATH) !== path.resolve(CONFIG.flowSeriesPath)) {
    writeUtf8File(SHARED_FLOW_SERIES_PATH, JSON.stringify(cache));
  }
}

function archiveFlowSeriesCache(cache) {
  if (dryRun || !/^\d{4}-\d{2}-\d{2}$/.test(String(cache?.tradeDate || ""))) return;
  const hasSamples = ["industry", "concept"].some((key) =>
    Object.values(cache?.groups?.[key] || {}).some((entry) => Array.isArray(entry?.points) && entry.points.length),
  );
  if (!hasSamples) return;
  const archivePath = path.join(CONFIG.flowHistoryDir, `${cache.tradeDate}_板块资金分时.json`);
  writeUtf8File(archivePath, JSON.stringify(cache));
}

function normalizeFlowPoint(point) {
  const minute = Math.max(0, Math.min(240, Number(point.minute) || 0));
  const amount = round2(Number(point.amount) || 0);
  const rawChangePct = point.changePct === null || point.changePct === undefined || point.changePct === ""
    ? NaN
    : Number(point.changePct);
  const changePct = Number.isFinite(rawChangePct) ? round2(rawChangePct) : null;
  return {
    minute,
    time: minuteToTime(minute),
    amount,
    changePct,
    syncedAt: String(point.syncedAt || ""),
    source: String(point.source || "eastmoney-board-ranking"),
  };
}

function mergeFlowPoints(points, additions) {
  const map = new Map();
  for (const item of [...(Array.isArray(points) ? points : []), ...(Array.isArray(additions) ? additions : [])]) {
    if (!Number.isFinite(Number(item?.minute)) || !Number.isFinite(Number(item?.amount))) continue;
    const next = normalizeFlowPoint(item);
    const previous = map.get(next.minute);
    if (previous && next.changePct === null && previous.changePct !== null) next.changePct = previous.changePct;
    map.set(next.minute, next);
  }
  return [...map.values()].sort((a, b) => a.minute - b.minute).slice(-260);
}

function mergeFlowPoint(points, point) {
  return mergeFlowPoints(points, [point]);
}

function fillFlowPointsForDisplay(points, currentAmount, currentChangePct, sampleMinute, syncedAt) {
  const targetMinute = Math.max(0, Math.min(240, Number(sampleMinute) || 0));
  const map = new Map();
  for (const item of Array.isArray(points) ? points : []) {
    const next = normalizeFlowPoint(item);
    if (next.minute <= targetMinute) map.set(next.minute, next);
  }
  if (Number.isFinite(Number(currentAmount))) {
    const existing = map.get(targetMinute);
    if (!existing || Math.abs(Number(existing.amount) - Number(currentAmount)) > 0.005) {
      map.set(targetMinute, normalizeFlowPoint({
        minute: targetMinute,
        amount: currentAmount,
        changePct: currentChangePct,
        syncedAt,
        source: "eastmoney-board-ranking",
      }));
    }
  }
  return [...map.values()].sort((a, b) => a.minute - b.minute);
}

function updateFlowSeriesGroup(cache, groupKey, rows, minute, syncedAt) {
  const group = cache.groups[groupKey] || {};
  for (const row of rows || []) {
    const code = String(row.code || row.tdxCode || row.name || "").trim();
    if (!code || !Number.isFinite(Number(row.amount))) continue;
    const entry = group[code] || { code, name: row.name || code, tdxName: row.tdxName || "", tdxCode: row.tdxCode || "", points: [] };
    entry.name = row.name || entry.name || code;
    entry.tdxName = row.tdxName || entry.tdxName || "";
    entry.tdxCode = row.tdxCode || entry.tdxCode || "";
    entry.points = mergeFlowPoint(entry.points, {
      minute,
      amount: row.amount,
      changePct: row.changePct,
      syncedAt,
      source: "eastmoney-board-ranking",
    });
    group[code] = entry;
  }
  cache.groups[groupKey] = group;
}

function parseBoardFlowTimeline(klines, tradeDate, sampleMinute, syncedAt) {
  const targetMinute = Math.max(0, Math.min(240, Number(sampleMinute) || 0));
  const points = [];
  for (const line of Array.isArray(klines) ? klines : []) {
    const fields = String(line || "").split(",");
    const stamp = String(fields[0] || "").trim();
    const match = stamp.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
    const amountYuan = Number(fields[1]);
    if (!match || match[1] !== tradeDate || !Number.isFinite(amountYuan)) continue;
    const minute = timeTextToMinute(match[2]);
    if (minute < 0 || minute > targetMinute) continue;
    points.push(normalizeFlowPoint({
      minute,
      amount: amountYuan / 100000000,
      changePct: null,
      syncedAt,
      source: "eastmoney-board-minute-flow",
    }));
  }
  return mergeFlowPoints([], points);
}

function validateBoardFlowTimeline(data, row, tradeDate, sampleMinute, syncedAt) {
  const code = String(row?.code || "");
  if (String(data?.code || "") !== code) throw new Error(`板块代码不一致：${data?.code || "空"}/${code}`);
  const points = parseBoardFlowTimeline(data?.klines, tradeDate, sampleMinute, syncedAt);
  if (!points.length) throw new Error(`${code} 没有 ${tradeDate} 的分钟资金数据`);
  const targetMinute = Math.max(0, Math.min(240, Number(sampleMinute) || 0));
  const latest = points.at(-1);
  if (targetMinute >= 4 && latest.minute < targetMinute - 3) {
    throw new Error(`${code} 分钟资金只到 ${latest.time}，指数已到 ${minuteToTime(targetMinute)}`);
  }
  const currentAmount = Number(row?.amount);
  const endpointCheck = {
    checked: false,
    matched: false,
    rankingAmount: Number.isFinite(currentAmount) ? round2(currentAmount) : null,
    minuteAmount: round2(latest.amount),
    difference: null,
    tolerance: null,
  };
  if (Number.isFinite(currentAmount) && latest.minute >= targetMinute - 3) {
    const difference = Math.abs(latest.amount - currentAmount);
    const tolerance = targetMinute >= 238
      ? Math.max(1, Math.abs(currentAmount) * 0.015)
      : Math.max(5, Math.abs(currentAmount) * 0.08);
    endpointCheck.checked = true;
    endpointCheck.matched = difference <= tolerance;
    endpointCheck.difference = round2(difference);
    endpointCheck.tolerance = round2(tolerance);
  }
  return { points, endpointCheck };
}

async function fetchBoardFlowTimeline(row, tradeDate, sampleMinute, syncedAt) {
  const params = new URLSearchParams({
    lmt: "0",
    klt: "1",
    fields1: "f1,f2,f3,f7",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
    secid: `90.${row.code}`,
    ut: "b2884a393a59ad64002292a3e90d46a5",
  });
  const url = `https://${EASTMONEY_PUSH2_HOST}/api/qt/stock/fflow/kline/get?${params}`;
  const json = await fetchEastmoneyBoardMinuteJson(url);
  const validation = validateBoardFlowTimeline(json.data, row, tradeDate, sampleMinute, syncedAt);
  const points = validation.points;
  return {
    code: String(row.code),
    name: String(json.data?.name || row.name || row.code),
    points,
    latestMinute: points.at(-1)?.minute ?? 0,
    endpointCheck: validation.endpointCheck,
  };
}

function selectBoardTimelineTargets(rows) {
  const unique = new Map();
  for (const row of rows || []) {
    const code = String(row?.code || "").trim();
    if (/^BK\d{4}$/.test(code) && Number.isFinite(Number(row.amount))) unique.set(code, row);
  }
  const values = [...unique.values()];
  const inflow = values.filter((row) => Number(row.amount) > 0)
    .sort((a, b) => Number(b.amount) - Number(a.amount))
    .slice(0, BOARD_FLOW_TIMELINE_LIMIT);
  const outflow = values.filter((row) => Number(row.amount) < 0)
    .sort((a, b) => Number(a.amount) - Number(b.amount))
    .slice(0, BOARD_FLOW_TIMELINE_LIMIT);
  return [...inflow, ...outflow];
}

function boardTimelineNeedsRefresh(entry, sampleMinute, nowMs) {
  if (sampleMinute <= 0) return false;
  if (sampleMinute >= 238 && Number(entry?.officialLatestMinute) >= 238 && (entry?.points || []).length >= 180) return false;
  const lastAttempt = Math.max(Number(entry?.timelineFetchedAtMs) || 0, Number(entry?.timelineAttemptedAtMs) || 0);
  return !lastAttempt || nowMs - lastAttempt >= BOARD_FLOW_TIMELINE_REFRESH_MS;
}

async function backfillBoardFlowTimelines(cache, tradeDate, sampleMinute, syncedAt, groups) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(cache.sourceRouteIp || ""))) {
    preferredPush2Ip = cache.sourceRouteIp;
  }
  const nowMs = Date.now();
  const jobs = [];
  for (const groupKey of ["industry", "concept"]) {
    for (const row of selectBoardTimelineTargets(groups[groupKey]?.rows || [])) {
      const entry = cache.groups[groupKey]?.[row.code];
      if (boardTimelineNeedsRefresh(entry, sampleMinute, nowMs)) jobs.push({ groupKey, row });
    }
  }
  const results = await mapLimit(jobs, BOARD_FLOW_TIMELINE_CONCURRENCY, async (job) => {
    try {
      return { ...job, ok: true, timeline: await fetchBoardFlowTimeline(job.row, tradeDate, sampleMinute, syncedAt) };
    } catch (error) {
      return { ...job, ok: false, error: error.message };
    }
  });
  let updated = 0;
  const errors = [];
  for (const result of results) {
    const group = cache.groups[result.groupKey] || {};
    const code = String(result.row.code);
    const entry = group[code] || { code, name: result.row.name || code, points: [] };
    entry.timelineAttemptedAtMs = nowMs;
    if (result.ok) {
      entry.name = result.timeline.name || entry.name;
      entry.points = mergeFlowPoints(entry.points, result.timeline.points);
      entry.flowSource = "eastmoney-board-minute-flow";
      entry.flowValidated = true;
      entry.timelineFetchedAtMs = nowMs;
      entry.timelineFetchedAt = syncedAt;
      entry.officialLatestMinute = result.timeline.latestMinute;
      entry.timelineEndpointCheck = result.timeline.endpointCheck;
      delete entry.timelineError;
      updated += 1;
    } else {
      entry.timelineError = result.error;
      errors.push(`${result.groupKey}/${code}: ${result.error}`);
    }
    group[code] = entry;
    cache.groups[result.groupKey] = group;
  }
  if (preferredPush2Ip) cache.sourceRouteIp = preferredPush2Ip;
  cache.timelineStats = {
    requested: jobs.length,
    updated,
    failed: errors.length,
    updatedAt: syncedAt,
    source: "eastmoney-official-board-minute-flow",
  };
  if (errors.length) log(`板块分钟资金补齐：成功 ${updated}，失败 ${errors.length}；${errors.slice(0, 2).join("；")}`);
  else if (jobs.length) log(`板块分钟资金补齐：成功 ${updated}/${jobs.length}，官方分钟序列已校验。`);
  return cache.timelineStats;
}

function attachFlowSeriesToGroup(group, groupKey, cache) {
  const series = cache.groups?.[groupKey] || {};
  const sampleMinute = Math.max(0, Math.min(240, Number(cache.sampleMinute) || Number(group.flowSampleMinute) || 0));
  const syncedAt = group.fetchedAt || cache.updatedAt || "";
  const rows = (group.rows || []).map((row) => {
    const code = String(row.code || row.tdxCode || row.name || "").trim();
    const entry = series[code] || {};
    const points = fillFlowPointsForDisplay(entry.points || [], row.amount, row.changePct, sampleMinute, syncedAt);
    return {
      ...row,
      points,
      flowSource: entry.flowSource || "eastmoney-board-ranking",
      flowValidated: Boolean(entry.flowValidated),
      flowSampleCount: points.length,
      flowLatestTime: points.at(-1)?.time || minuteToTime(sampleMinute),
    };
  });
  const sampleCount = rows.reduce((sum, row) => sum + (Array.isArray(row.points) ? row.points.length : 0), 0);
  const timelineCount = rows.filter((row) => row.flowValidated && row.points.length >= 2).length;
  return {
    ...group,
    rows,
    flowMode: timelineCount ? "official-minute-series" : "real-samples",
    flowSampleCount: sampleCount,
    flowTimelineCount: timelineCount,
    flowSource: timelineCount ? "东方财富官方板块分钟资金" : "东方财富板块实时排名",
    flowUpdatedAt: cache.timelineStats?.updatedAt || cache.updatedAt || syncedAt,
    flowReconciliation: cache.reconciliationStats?.[groupKey] || null,
  };
}

function flowAttributionRows(cache, groupKey) {
  const sampleMinute = Math.max(0, Math.min(240, Number(cache?.sampleMinute) || 0));
  return Object.values(cache?.groups?.[groupKey] || {})
    .map((entry) => {
      const points = (entry?.points || [])
        .map(normalizeFlowPoint)
        .filter((point) => point.minute <= sampleMinute)
        .sort((a, b) => a.minute - b.minute);
      return {
        code: String(entry?.code || ""),
        name: String(entry?.name || entry?.code || ""),
        tdxName: String(entry?.tdxName || ""),
        tdxCode: String(entry?.tdxCode || ""),
        amount: points.at(-1)?.amount ?? null,
        points,
        flowSource: String(entry?.flowSource || "eastmoney-board-ranking"),
        flowValidated: Boolean(entry?.flowValidated),
      };
    })
    .filter((row) => row.name && row.points.length >= 2)
    .sort((a, b) => Math.abs(Number(b.amount) || 0) - Math.abs(Number(a.amount) || 0));
}

async function updateBoardFlowSeries(tradeDate, sampleMinute, syncedAt, groups) {
  const cache = readFlowSeriesCache();
  if (cache.tradeDate !== tradeDate) {
    archiveFlowSeriesCache(cache);
    cache.version = 3;
    cache.tradeDate = tradeDate;
    cache.groups = { industry: {}, concept: {} };
  }
  cache.version = 3;
  cache.updatedAt = syncedAt;
  cache.sampleMinute = sampleMinute;
  updateFlowSeriesGroup(cache, "industry", groups.industry?.rows || [], sampleMinute, syncedAt);
  updateFlowSeriesGroup(cache, "concept", groups.concept?.rows || [], sampleMinute, syncedAt);
  await backfillBoardFlowTimelines(cache, tradeDate, sampleMinute, syncedAt, groups);
  const reconciliation = reconcileBoardFlowGroups(cache, groups, sampleMinute, syncedAt);
  const corrected = Number(reconciliation.industry?.corrected || 0) + Number(reconciliation.concept?.corrected || 0);
  const checked = Number(reconciliation.industry?.checked || 0) + Number(reconciliation.concept?.checked || 0);
  if (corrected) {
    log(`板块资金自动纠偏：核对 ${checked} 个方向，修正 ${corrected} 个当前真实采样点；历史分钟点未改写。`);
  } else if (checked) {
    log(`板块资金自动纠偏：核对 ${checked} 个方向，当前末值均与实时排名一致。`);
  }
  writeFlowSeriesCache(cache);
  if (sampleMinute >= 238 || sampleMinute % 5 === 0) archiveFlowSeriesCache(cache);
  return cache;
}


function buildMarketData(index, industry, concept, market, syncedAt = nowText(), indices = null) {
  const majorIndices = Array.isArray(indices) && indices.length ? indices : [index];
  return {
    index,
    indices: majorIndices,
    industry,
    concept,
    market,
    syncedAt,
    sourceNote:
      `数据来源：东方财富公开行情接口和板块资金备用接口；同步时间 ${syncedAt}。` +
      "主要指数、二级行业、概念板块为同一轮刷新结果；主要指数优先使用真实分钟分时，分钟接口不可用时只展示同日当前真实快照点，不使用昨日快照合成走势；板块资金展示净流入前 10 与净流出前 10，行业和概念板块优先使用东方财富官方分钟资金序列，并以同轮实时排名末值逐项复核；分钟接口暂不可用时保留此前已验证轨迹并追加当前排名真实点，发现差异会自动修正当前真实采样点并重新排序，不改写此前分钟历史；指数分时文字标注直接采用财联社盯盘公开板块事件的原始名称、秒级时间和方向，并排除所有个股事件；事件只定位到同秒真实指数点，不生成原因、不补写标签、不用历史或收盘数据倒推；接口暂不可用时只保留同交易日已经取得的原始事件，否则不显示标注；自选板块分时最多保存 6 个行业或题材概念，直接使用后台分钟采样缓存与逐秒真实排名，不生成模拟点；相邻真实样本只做线性显示，不反向填充未知数据；09:15:00集合竞价起实时更新，午休停在11:30:00，13:00:00恢复，收盘停在15:00:00。前台保留通达信880板块代码，并同时携带原始板块名称供当前设备的其他股票软件检索；市场强度统计包含涨停/跌停专题、沪深成交额、昨日涨停延续性和昨日炸板修复力度。",
  };
}

function validateMarketData(marketData) {
  const market = marketData?.market || {};
  const errors = [];
  const warnings = [];
  const checks = {};
  const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const percent = (part, total) => finite(part) && finite(total) && Number(total) > 0
    ? round1((Number(part) / Number(total)) * 100)
    : null;
  const groups = [
    { key: "limitUp", label: "涨停", count: market.limitUpCount, rows: market.limitUpStocks },
    { key: "limitDown", label: "跌停", count: market.limitDownCount, rows: market.limitDownStocks },
    { key: "broken", label: "当日炸板", count: market.brokenCount, rows: market.brokenStocks },
    { key: "yesterdayLimitUp", label: "昨日涨停", count: market.yesterdayLimitUp?.count, rows: market.yesterdayLimitUp?.stocks },
    { key: "yesterdayBroken", label: "昨日炸板", count: market.yesterdayBroken?.count, rows: market.yesterdayBroken?.stocks },
  ];
  for (const group of groups) {
    const rows = Array.isArray(group.rows) ? group.rows : [];
    const reported = finite(group.count) ? Number(group.count) : null;
    checks[group.key] = { reported, displayed: rows.length, consistent: reported === null || reported === rows.length };
    if (reported === null) warnings.push(`${group.label}汇总数量缺失，当前明细${rows.length}只`);
    else if (reported !== rows.length) errors.push(`${group.label}统计共${reported}只，当前可展示${rows.length}只`);

    const codeCounts = new Map();
    let missingIdentity = 0;
    let missingQuote = 0;
    rows.forEach((row) => {
      const code = String(row?.code || "").trim();
      const name = String(row?.name || "").trim();
      if (!/^\d{6}$/.test(code) || !name) missingIdentity += 1;
      if (code) codeCounts.set(code, (codeCounts.get(code) || 0) + 1);
      if (!finite(row?.changePct) || !finite(row?.amountYi)) missingQuote += 1;
    });
    const duplicateCodes = [...codeCounts.entries()].filter(([, count]) => count > 1).map(([code]) => code);
    if (missingIdentity) errors.push(`${group.label}明细有${missingIdentity}条缺少有效代码或名称`);
    if (duplicateCodes.length) errors.push(`${group.label}明细存在重复代码：${duplicateCodes.slice(0, 8).join("、")}`);
    if (missingQuote) warnings.push(`${group.label}明细有${missingQuote}条缺少涨跌幅或成交额`);
  }

  const breadthValues = [market.stockCount, market.upCount, market.downCount, market.flatCount];
  if (breadthValues.every(finite)) {
    const breadthSum = Number(market.upCount) + Number(market.downCount) + Number(market.flatCount);
    checks.marketBreadth = { reported: Number(market.stockCount), calculated: breadthSum, consistent: breadthSum === Number(market.stockCount) };
    if (breadthSum !== Number(market.stockCount)) {
      errors.push(`上涨、下跌和平盘家数合计${breadthSum}，与全市场${market.stockCount}不一致`);
    }
  } else {
    checks.marketBreadth = { reported: finite(market.stockCount) ? Number(market.stockCount) : null, calculated: null, consistent: null };
    warnings.push("全市场上涨、下跌或平盘家数不完整，红盘率暂不可核验");
  }

  const marketLimitUp = finite(market.limitUpCount) ? Number(market.limitUpCount) : null;
  const structureRows = [
    ...(Array.isArray(marketData?.marketStructure?.mainline) ? marketData.marketStructure.mainline : []),
    ...(Array.isArray(marketData?.marketStructure?.subline) ? marketData.marketStructure.subline : []),
  ];
  if (marketLimitUp !== null) {
    structureRows.forEach((row) => {
      if (finite(row?.limitUpCount) && Number(row.limitUpCount) > marketLimitUp) {
        errors.push(`${row.name || "板块"}涨停${row.limitUpCount}只，超过全市场涨停${marketLimitUp}只`);
      }
    });
  }

  const tradeDate = market.tradeDate || marketData?.index?.tradeDate || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) errors.push("交易日期格式不正确");
  if (market.brokenQuoteDate && market.brokenQuoteDate !== tradeDate) {
    errors.push(`当日炸板池日期${market.brokenQuoteDate}与交易日${tradeDate}不一致`);
  }
  const calculatedBroken = calculateBrokenBoardStats(market.limitUpCount, market.brokenCount);
  const reportedTouched = finite(market.touchedLimitCount) ? Number(market.touchedLimitCount) : null;
  const reportedBrokenRate = finite(market.brokenRate) ? Number(market.brokenRate) : null;
  const touchedConsistent = calculatedBroken.touchedLimitCount !== null &&
    reportedTouched === calculatedBroken.touchedLimitCount;
  const rateConsistent = calculatedBroken.brokenRate !== null &&
    reportedBrokenRate !== null &&
    Math.abs(reportedBrokenRate - calculatedBroken.brokenRate) < 0.05;
  checks.brokenRate = {
    reportedCount: finite(market.brokenCount) ? Number(market.brokenCount) : null,
    touchedLimitCount: reportedTouched,
    calculatedTouchedLimitCount: calculatedBroken.touchedLimitCount,
    reportedRate: reportedBrokenRate,
    calculatedRate: calculatedBroken.brokenRate,
    consistent: touchedConsistent && rateConsistent,
  };
  if (calculatedBroken.touchedLimitCount === null || reportedTouched === null || reportedBrokenRate === null) {
    warnings.push("当日炸板数量、触及涨停数量或炸板率不完整");
  } else {
    if (!touchedConsistent) errors.push(`触及涨停数量应为${calculatedBroken.touchedLimitCount}，当前为${reportedTouched}`);
    if (!rateConsistent) errors.push(`炸板率应为${calculatedBroken.brokenRate.toFixed(1)}%，当前为${reportedBrokenRate.toFixed(1)}%`);
  }
  const breadthTotal = [market.upCount, market.downCount, market.flatCount].every(finite)
    ? Number(market.upCount) + Number(market.downCount) + Number(market.flatCount)
    : null;
  const metrics = {
    redRate: percent(market.upCount, breadthTotal),
    limitUpRate: percent(market.limitUpCount, breadthTotal),
    brokenRate: calculatedBroken.brokenRate,
    yesterdayLimitPositiveRate: finite(market.yesterdayLimitUp?.positiveRate) ? Number(market.yesterdayLimitUp.positiveRate) : null,
    yesterdayLimitPromotionRate: percent(market.yesterdayLimitUp?.limitUpCount, market.yesterdayLimitUp?.count),
    yesterdayBrokenPositiveRate: finite(market.yesterdayBroken?.positiveRate) ? Number(market.yesterdayBroken.positiveRate) : null,
    yesterdayBrokenLimitRate: percent(market.yesterdayBroken?.limitUpCount, market.yesterdayBroken?.count),
  };
  const status = errors.length ? "error" : warnings.length ? "partial" : "ok";
  const result = {
    status,
    label: status === "ok" ? "数据校验通过" : "部分数据异常",
    checkedAt: nowText(),
    errors,
    warnings,
    checks,
    metrics,
  };
  if (!selfTest) {
    errors.forEach((message) => log(`数据校验异常：${message}`));
    warnings.forEach((message) => log(`数据校验提示：${message}`));
  }
  return result;
}

function assertPublishableMarketData(validation) {
  if (validation?.status === "ok") return;
  const messages = [...(validation?.errors || []), ...(validation?.warnings || [])];
  throw new Error(`数据完整性校验未通过，拒绝发布并保留上一份完整数据：${messages.join("；") || "存在未补齐字段"}`);
}

function requireFreshData(index, industry, concept, expectedDate, options = {}) {
  if (!expectedDate) return;
  if (index.tradeDate !== expectedDate) {
    throw new Error(`上证指数日期不是今天：${index.tradeDate}，等待 ${expectedDate}`);
  }
  for (const group of [industry, concept]) {
    if (!group || !Array.isArray(group.rows) || !group.rows.length) {
      throw new Error(`${group?.title || "板块"}没有有效资金流数据`);
    }
    if (group.tradeDate && group.tradeDate !== index.tradeDate) {
      throw new Error(`${group.title}日期不是上证同日：${group.tradeDate}，上证 ${index.tradeDate}`);
    }
  }
  if (options.intraday) {
    if ((index.points.at(-1)?.minute ?? -1) < 0) {
      throw new Error("上证指数分时还没有有效盘中数据");
    }
    return;
  }
  if ((index.points.at(-1)?.minute ?? -1) < 238) {
    throw new Error("上证指数分时还没有接近收盘，继续等待");
  }
}



function reportNumber(value, digits = 0) {
  if (value === null || value === undefined || value === "") return "--";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "--";
}

function reportAmount(value) {
  if (value === null || value === undefined || value === "") return "--";
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  const sign = number > 0 ? "+" : number < 0 ? "-" : "";
  return sign + Math.abs(number).toFixed(1) + "亿";
}

function reportPct(value) {
  if (value === null || value === undefined || value === "") return "--";
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return (number > 0 ? "+" : "") + number.toFixed(2) + "%";
}

function reportYi(value) {
  if (value === null || value === undefined || value === "") return "--";
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return number >= 10000 ? (number / 10000).toFixed(2) + "万亿" : number.toFixed(0) + "亿";
}

function reportSignedRatio(value) {
  if (value === null || value === undefined || value === "") return "无可比基准";
  const number = Number(value);
  if (!Number.isFinite(number)) return "无可比基准";
  return (number > 0 ? "高" : "低") + Math.abs(number).toFixed(1) + "%";
}

function latestPoint(series, key) {
  const points = Array.isArray(series?.points) ? series.points : [];
  return Number(points.at(-1)?.[key]);
}

function changePct(series, key) {
  const last = latestPoint(series, key);
  const base = Number(series?.preClose);
  return Number.isFinite(last) && Number.isFinite(base) && base !== 0 ? ((last - base) / base) * 100 : NaN;
}

function finiteValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function average(values) {
  const valid = values.filter((value) => value !== null && value !== undefined && value !== "").map(Number).filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function recentPriorDays(marketData) {
  const market = marketData.market || {};
  const days = Array.isArray(market.recentDays) ? market.recentDays : [];
  return days.filter((day) => day.date !== market.tradeDate).slice(0, 10);
}

function metricCompare(current, avg) {
  const c = finiteValue(current);
  const a = finiteValue(avg);
  if (c === null || a === null || a === 0) return null;
  return ((c - a) / a) * 100;
}

function flowDisplayName(row) {
  const raw = row.name || "--";
  if (row.tdxName && row.tdxName !== raw) return row.tdxName + "（" + raw + "）";
  return row.tdxName || raw;
}

function collectFlows(marketData) {
  const groups = [
    ["二级行业", marketData.industry?.rows || []],
    ["概念板块", marketData.concept?.rows || []],
  ];
  return groups.flatMap(([group, rows]) =>
    rows
      .filter((row) => Number.isFinite(Number(row.amount)))
      .map((row) => ({
        group,
        name: flowDisplayName(row),
        amount: Number(row.amount),
      })),
  );
}

function topFlows(rows, direction) {
  return rows
    .filter((row) => (direction === "in" ? row.amount > 0 : row.amount < 0))
    .sort((a, b) => (direction === "in" ? b.amount - a.amount : a.amount - b.amount))
    .slice(0, 3);
}

function strengthValue(text) {
  if (/强/.test(text)) return 2;
  if (/中/.test(text)) return 1;
  if (/弱/.test(text)) return 0;
  if (/无延续|未修复/.test(text)) return -1;
  return 0;
}

function majorIndexBreadth(marketData) {
  const source = Array.isArray(marketData?.indices) ? marketData.indices : [];
  const domestic = source.filter((item) => item && item.session !== "us" && item.name !== "纳斯达克");
  const values = domestic
    .map((item) => changePct(item, "price"))
    .filter(Number.isFinite);
  if (!values.length) {
    const fallback = changePct(marketData?.index, "price");
    if (!Number.isFinite(fallback)) return { averagePct: null, upCount: 0, downCount: 0, flatCount: 0, total: 0 };
    return {
      averagePct: fallback,
      upCount: fallback > 0.2 ? 1 : 0,
      downCount: fallback < -0.2 ? 1 : 0,
      flatCount: Math.abs(fallback) <= 0.2 ? 1 : 0,
      total: 1,
    };
  }
  return {
    averagePct: average(values),
    upCount: values.filter((value) => value > 0.2).length,
    downCount: values.filter((value) => value < -0.2).length,
    flatCount: values.filter((value) => Math.abs(value) <= 0.2).length,
    total: values.length,
  };
}

function boardFlowBalance(marketData) {
  const flows = collectFlows(marketData);
  const inflowTotal = flows
    .filter((row) => row.amount > 0)
    .reduce((sum, row) => sum + row.amount, 0);
  const outflowTotal = Math.abs(flows
    .filter((row) => row.amount < 0)
    .reduce((sum, row) => sum + row.amount, 0));
  return {
    inflowTotal,
    outflowTotal,
    ratio: outflowTotal > 0 ? inflowTotal / outflowTotal : inflowTotal > 0 ? Infinity : null,
    sampleCount: flows.length,
  };
}

function buildDiagnosis(marketData) {
  const market = marketData.market || {};
  const prior = recentPriorDays(marketData);
  const avgLimitUp = average(prior.map((day) => day.limitUpCount));
  const avgLimitDown = average(prior.map((day) => day.limitDownCount));
  const avgAmount = average(prior.map((day) => day.totalAmountYi));
  const limitUp = finiteValue(market.limitUpCount);
  const limitDown = finiteValue(market.limitDownCount);
  const amount = finiteValue(market.totalAmountYi);
  const indexPct = changePct(marketData.index, "price");
  const indexBreadth = majorIndexBreadth(marketData);
  const flowBalance = boardFlowBalance(marketData);
  const upCompare = metricCompare(limitUp, avgLimitUp);
  const downCompare = metricCompare(limitDown, avgLimitDown);
  const amountCompare = metricCompare(amount, avgAmount);
  let score = 0;
  const reasons = [];
  const risks = [];
  function add(points, text) {
    score += points;
    if (points >= 0) reasons.push(text);
    else risks.push(text);
  }
  if (limitUp !== null) {
    if (limitUp >= 80) add(3, "涨停家数处于历史偏热区，短线情绪强。");
    else if (limitUp >= 50) add(2, "涨停家数达到活跃区，题材承接较好。");
    else if (limitUp >= 30) add(1, "涨停家数处于可参与区，情绪不弱。");
    else add(-1, "涨停家数偏少，赚钱效应不足。");
  }
  if (limitDown !== null) {
    if (limitDown <= 5) add(2, "跌停家数很少，亏钱效应可控。");
    else if (limitDown <= 15) add(1, "跌停家数不高，风险释放温和。");
    else add(-2, "跌停家数偏多，说明风险仍在扩散。");
  }
  if (upCompare !== null) {
    if (upCompare >= 20) add(1, "涨停家数明显高于近几日均值，情绪在升温。");
    else if (upCompare <= -20) add(-1, "涨停家数低于近几日均值，情绪有降温迹象。");
  }
  if (downCompare !== null && downCompare >= 30) add(-1, "跌停家数高于近几日均值，需防止弱势扩散。");
  if (amount !== null) {
    if (amount >= 12000 && Number.isFinite(indexBreadth.averagePct) && indexBreadth.averagePct <= -1) {
      add(-1, "成交额超过万二但主要宽基指数普跌，属于放量分歧而不是单纯增量进攻。");
    } else if (amount >= 12000) add(2, "成交额超过万二级别，增量资金参与充分。");
    else if (amount >= 10000) add(1, "成交额站上万亿，流动性支持轮动。");
    else if (amount < 8000) add(-1, "成交额低于八千亿，持续性容易打折。");
  }
  if (amountCompare !== null) {
    if (amountCompare >= 10) add(1, "成交额高于近几日均值，量能配合较好。");
    else if (amountCompare <= -10) add(-1, "成交额低于近几日均值，反弹持续性需观察。");
  }
  if (Number.isFinite(indexBreadth.averagePct)) {
    const avgPct = indexBreadth.averagePct;
    if (avgPct >= 2) add(3, "主要宽基指数平均上涨" + reportPct(avgPct) + "，指数形成全面进攻。");
    else if (avgPct >= 1) add(2, "主要宽基指数平均上涨" + reportPct(avgPct) + "，指数环境偏强。");
    else if (avgPct >= 0.5) add(1, "主要宽基指数平均上涨" + reportPct(avgPct) + "，指数提供正向支持。");
    else if (avgPct <= -2) add(-3, "主要宽基指数平均跌幅" + Math.abs(avgPct).toFixed(2) + "%" + "，指数层面风险较高。");
    else if (avgPct <= -1) add(-2, "主要宽基指数平均跌幅" + Math.abs(avgPct).toFixed(2) + "%" + "，指数环境明显偏弱。");
    else if (avgPct <= -0.5) add(-1, "主要宽基指数平均跌幅" + Math.abs(avgPct).toFixed(2) + "%" + "，指数形成拖累。");
    else add(0, "主要宽基指数平均涨跌幅为" + reportPct(avgPct) + "，整体接近平衡。");
    if (indexBreadth.total >= 3) {
      const downRatio = indexBreadth.downCount / indexBreadth.total;
      const upRatio = indexBreadth.upCount / indexBreadth.total;
      if (downRatio >= 0.7) add(-1, "主要宽基指数中" + indexBreadth.downCount + "/" + indexBreadth.total + "下跌，弱势覆盖面较广。");
      else if (upRatio >= 0.7) add(1, "主要宽基指数中" + indexBreadth.upCount + "/" + indexBreadth.total + "上涨，强势覆盖面较广。");
    }
  } else if (Number.isFinite(indexPct)) {
    add(indexPct >= 0.5 ? 1 : indexPct <= -0.5 ? -1 : 0, "上证指数涨跌幅为" + reportPct(indexPct) + "。");
  }
  if (Number.isFinite(flowBalance.ratio)) {
    const ratio = flowBalance.ratio;
    if (ratio >= 1.5) add(2, "行业与概念板块头部流入显著强于流出，资金方向积极。");
    else if (ratio >= 1.1) add(1, "行业与概念板块头部流入略强于流出，资金结构偏正面。");
    else if (ratio <= 0.35) add(-3, "行业与概念板块头部流入/流出比仅" + round2(ratio) + "，主动流出明显占优。");
    else if (ratio <= 0.65) add(-2, "行业与概念板块头部流入弱于流出，资金结构偏空。");
    else if (ratio < 0.9) add(-1, "行业与概念板块头部流出略占优势，资金承接不足。");
    else add(0, "行业与概念板块头部流入流出接近平衡。");
  }
  const marketUp = finiteValue(market.upCount);
  const marketDown = finiteValue(market.downCount);
  if (marketUp !== null && marketDown !== null && marketUp + marketDown > 0) {
    const positiveRate = marketUp / (marketUp + marketDown);
    if (positiveRate >= 0.65) add(1, "上涨家数占比达到" + round1(positiveRate * 100) + "%" + "，市场广度偏强。");
    else if (positiveRate <= 0.35) add(-1, "上涨家数占比仅" + round1(positiveRate * 100) + "%" + "，市场广度偏弱。");
  }
  const relayScore = strengthValue(market.yesterdayLimitUp?.strength);
  const repairScore = strengthValue(market.yesterdayBroken?.strength);
  if (relayScore > 0) add(relayScore, "昨日涨停延续为" + market.yesterdayLimitUp.strength + "，接力资金有表现。");
  else if (relayScore < 0) add(-1, "昨日涨停无延续，接力情绪偏弱。");
  if (repairScore > 0) add(repairScore, "昨日炸板修复为" + market.yesterdayBroken.strength + "，资金愿意修复分歧。");
  else if (repairScore < 0) add(-1, "昨日炸板未修复，分歧股承接不足。");
  const structure = marketData.marketStructure || market.marketStructure || {};
  const mainline = Array.isArray(structure.mainline) ? structure.mainline : [];
  if (mainline.length) {
    const sustained = mainline.some((item) => Number(item.historyHits) >= 2 || Number(item.continuingCount) >= 1);
    add(sustained ? 1 : 0, "当前主线为" + mainline.map((item) => item.name).join("、") +
      (sustained ? "，具有跨日资金或涨停延续。" : "，但跨日持续性仍需确认。"));
  }
  if (structure.interSectorSwitch) add(-1, structure.interSectorText || "板块之间发生切换，资金稳定性下降。");
  else if (structure.interSectorText) add(0, structure.interSectorText);
  const previousDiagnosisScores = (marketData?.marketHistory?.days || [])
    .filter((day) => day?.date !== market.tradeDate && Number.isFinite(Number(day?.diagnosis?.score)))
    .map((day) => Number(day.diagnosis.score));
  const previousDiagnosisAverage = average(previousDiagnosisScores);
  if (previousDiagnosisAverage !== null) {
    if (score >= previousDiagnosisAverage + 2) add(1, "综合强度较历史库前期均值明显改善。");
    else if (score <= previousDiagnosisAverage - 2) add(-1, "综合强度较历史库前期均值明显走弱。");
  }
  let tone;
  let action;
  const severeDivergence = limitUp !== null && limitUp >= 50 && limitDown !== null && limitDown <= 15 &&
    Number.isFinite(indexBreadth.averagePct) && indexBreadth.averagePct <= -1.5 &&
    Number.isFinite(flowBalance.ratio) && flowBalance.ratio <= 0.6;
  if (severeDivergence) {
    tone = "高波动分化";
    action = "涨停结构仍活跃，但主要指数和板块资金明显偏弱，需要观察少数强方向能否延续，不能按全面强势理解。";
  } else if (score >= 8) {
    tone = "强势进攻";
    action = "主线与前排方向保持活跃，同时需要观察后排扩散是否带来分化。";
  } else if (score >= 5) {
    tone = "修复偏强";
    action = "情绪处于修复区间，重点观察成交额和前排延续性是否继续改善。";
  } else if (score >= 2) {
    tone = "震荡可试错";
    action = "市场处于震荡和局部分化阶段，需要继续跟踪强弱方向的持续性。";
  } else if (score <= -4) {
    tone = "弱势防守";
    action = "跌停、成交额和接力修复仍是主要风险观察项，暂未确认市场回暖。";
  } else {
    tone = "分化谨慎";
    action = "强弱方向分化明显，需要观察弱分支是否继续扩散以及强方向是否保持承接。";
  }
  return {
    score,
    tone,
    action,
    conclusion: "结论：" + tone + "。观察重点：" + action,
    reasons: reasons.length ? reasons.slice(0, 5) : ["关键强度数据不足，暂以现有资金流和指数状态判断。"],
    risks: risks.slice(0, 4),
    averages: { limitUp: avgLimitUp, limitDown: avgLimitDown, amount: avgAmount },
    compares: { limitUp: upCompare, limitDown: downCompare, amount: amountCompare },
    indexBreadth: {
      averagePct: Number.isFinite(indexBreadth.averagePct) ? round2(indexBreadth.averagePct) : null,
      upCount: indexBreadth.upCount,
      downCount: indexBreadth.downCount,
      flatCount: indexBreadth.flatCount,
      total: indexBreadth.total,
    },
    flowBalance: {
      inflowTotal: round2(flowBalance.inflowTotal),
      outflowTotal: round2(flowBalance.outflowTotal),
      ratio: Number.isFinite(flowBalance.ratio) ? round2(flowBalance.ratio) : null,
      sampleCount: flowBalance.sampleCount,
    },
    historyDaysUsed: prior.length,
    previousDiagnosisAverage,
    marketStructure: structure,
  };
}

function marketTone(marketData) {
  return buildDiagnosis(marketData).tone;
}

function oneLineSummary(marketData) {
  const market = marketData.market || {};
  const diagnosis = buildDiagnosis(marketData);
  const limitText = "涨停" + reportNumber(market.limitUpCount) + "家、跌停" + reportNumber(market.limitDownCount) + "家";
  const amountText = "成交额" + reportYi(market.totalAmountYi);
  return diagnosis.conclusion + " 当前" + limitText + "，" + amountText + "；昨日涨停延续为" + (market.yesterdayLimitUp?.strength || "待更新") + "，昨日炸板修复为" + (market.yesterdayBroken?.strength || "待更新") + "。";
}

function escapeReportHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function flowListHtml(rows) {
  if (!rows.length) return "<li>暂无数据</li>";
  return rows
    .map((row, index) => "<li>" + (index + 1) + ". " + escapeReportHtml(row.name) + " " + escapeReportHtml(reportAmount(row.amount)) + "</li>")
    .join("");
}

const FLOW_DRIVER_RULES = [
  {
    keywords: ["半导体", "芯片", "存储", "光刻", "PCB", "消费电子", "电子", "CPO", "通信", "算力", "数据中心", "人工智能", "AI", "软件", "信创", "鸿蒙", "机器人", "自动化", "智能", "低空", "无人机", "卫星", "商业航天"],
    inPolicy: "政策面偏向数字经济、国产替代、算力基础设施和产业升级，容易吸引成长资金。",
    outPolicy: "如果政策预期短线兑现或缺少新增催化，科技成长方向容易出现获利回吐。",
    inNews: "消息面重点看大厂产业链、订单、产品发布、业绩预告和行业景气更新。",
    outNews: "消息面若没有持续订单或业绩确认，前期涨幅较大的题材容易被资金兑现。",
    macro: "宏观上对利率、流动性和风险偏好敏感，成交额放大时弹性更强。",
    geo: "地缘和外部科技限制会强化自主可控、供应链安全和国产替代交易。",
    micro: "微观验证看龙头成交额、中军承接、封板质量和同板块跟涨宽度。",
  },
  {
    keywords: ["证券", "券商", "银行", "保险", "金融", "多元金融", "互联金融"],
    inPolicy: "政策面通常受资本市场改革、活跃市场、稳增长和流动性预期影响。",
    outPolicy: "如果指数冲高回落或成交额不足，金融权重容易从护盘转为拖累。",
    inNews: "消息面关注降准降息预期、并购重组、交易制度和市场活跃度改善。",
    outNews: "消息面缺少增量政策时，金融板块容易跟随指数情绪回落。",
    macro: "宏观上与利率、信用扩张、成交额和指数趋势高度相关。",
    geo: "地缘扰动升温时，金融板块可能承担避险护盘，也可能受风险偏好下降压制。",
    micro: "微观验证看券商成交额弹性、银行保险权重稳定性和指数共振程度。",
  },
  {
    keywords: ["房地产", "地产", "建筑", "建材", "水泥", "钢铁", "家居", "装修", "工程", "基建"],
    inPolicy: "政策面主要看稳地产、城中村、基建投资、专项债和信用宽松预期。",
    outPolicy: "若地产链政策落地不及预期，或市场担心需求修复偏慢，资金容易流出。",
    inNews: "消息面关注地方地产政策、项目开工、融资支持和订单改善。",
    outNews: "消息面若出现销售、拿地、回款弱化，产业链承压会被放大。",
    macro: "宏观上受利率、居民信用、投资强度和经济修复节奏影响。",
    geo: "地缘影响相对间接，更多通过大宗商品价格和风险偏好传导。",
    micro: "微观验证看成交额能否持续、龙头是否先于板块稳住、产业链上下游是否同步。",
  },
  {
    keywords: ["锂", "电池", "光伏", "风电", "储能", "新能源", "充电", "稀土", "有色", "金属", "铜", "铝", "黄金", "煤炭", "石油", "化工", "资源"],
    inPolicy: "政策面关联新能源、双碳、能源安全、资源安全和产业链升级。",
    outPolicy: "若补贴、出口、价格或产能预期走弱，资源和新能源方向容易承压。",
    inNews: "消息面关注商品价格、订单、排产、出口、库存和行业价格拐点。",
    outNews: "消息面若出现价格下跌、库存累积或海外贸易摩擦，资金会先降低仓位。",
    macro: "宏观上受美元、利率、通胀预期、商品周期和全球需求影响较大。",
    geo: "地缘冲突、资源供应扰动和海外关税会直接影响能源金属与出口链情绪。",
    micro: "微观验证看期货价格、龙头毛利率、产能利用率和上下游同步性。",
  },
  {
    keywords: ["军工", "航天", "船舶", "航空", "卫星", "低空", "无人机", "雷达", "导航"],
    inPolicy: "政策面受国防建设、低空经济、商业航天和高端装备规划带动。",
    outPolicy: "如果订单或政策节点不明确，军工题材容易在短线拉升后分化。",
    inNews: "消息面关注军贸、装备订单、卫星发射、低空试点和产业会议。",
    outNews: "消息面缺少订单兑现时，资金可能从高弹性小票切回确定性方向。",
    macro: "宏观相关性弱于多数行业，但风险偏好上升时弹性更明显。",
    geo: "地缘安全事件会明显影响军工、航天和无人装备方向的情绪溢价。",
    micro: "微观验证看核心军工股成交、订单兑现、机构中军与题材小票是否共振。",
  },
  {
    keywords: ["医药", "医疗", "创新药", "中药", "生物", "器械", "CXO", "疫苗"],
    inPolicy: "政策面关注创新药支持、医保规则、医疗设备更新和中医药政策。",
    outPolicy: "若集采、医保控费或研发兑现不及预期，医药板块容易被资金回避。",
    inNews: "消息面关注临床数据、出海授权、产品获批、业绩修复和设备更新订单。",
    outNews: "消息面若缺少新药进展或出现监管压力，短线资金会转向其他题材。",
    macro: "宏观上兼具防御属性，弱势市场中可能获得避险资金。",
    geo: "地缘主要通过医药出海、海外审批和供应链扰动影响估值。",
    micro: "微观验证看核心品种管线、销售恢复、订单与机构持仓回补。",
  },
  {
    keywords: ["消费", "白酒", "食品", "饮料", "乳品", "零售", "旅游", "酒店", "餐饮", "家电", "服装", "宠物"],
    inPolicy: "政策面主要看促消费、以旧换新、服务消费和内需修复预期。",
    outPolicy: "若消费数据偏弱或促消费政策力度不足，资金容易降低消费仓位。",
    inNews: "消息面关注节假日数据、涨价、渠道库存、业绩预告和新品。",
    outNews: "消息面若显示需求弱、库存高或利润承压，板块容易流出。",
    macro: "宏观上与居民收入、通胀、消费信心和地产财富效应相关。",
    geo: "地缘影响相对间接，主要通过进口成本、汇率和风险偏好传导。",
    micro: "微观验证看龙头销售数据、毛利率、渠道库存和客流恢复。",
  },
  {
    keywords: ["农业", "种业", "养殖", "猪肉", "鸡肉", "粮食", "水产"],
    inPolicy: "政策面受粮食安全、种业振兴、乡村振兴和收储政策影响。",
    outPolicy: "若农产品价格回落或政策催化不足，农业方向容易回吐。",
    inNews: "消息面关注猪价、粮价、天气、疫病、收储和供需变化。",
    outNews: "消息面若价格周期下行或供给恢复，资金会降低周期弹性预期。",
    macro: "宏观上受通胀、消费需求和大宗农产品价格影响。",
    geo: "地缘冲突、贸易限制和极端天气会强化粮食安全交易。",
    micro: "微观验证看价格拐点、养殖利润、库存和龙头成本控制。",
  },
  {
    keywords: ["港口", "航运", "物流", "快递", "铁路", "公路", "航空机场", "机场", "交通"],
    inPolicy: "政策面关注物流降本、外贸稳增长、统一大市场和交通基建。",
    outPolicy: "若外需或运价预期走弱，交通运输方向容易被资金减配。",
    inNews: "消息面关注运价、吞吐量、油价、航线扰动和外贸数据。",
    outNews: "消息面若显示运价回落或货量下降，板块资金可能转弱。",
    macro: "宏观上与出口、制造业景气、油价和消费物流相关。",
    geo: "地缘冲突会通过航线安全、运价和能源价格影响航运物流。",
    micro: "微观验证看运价指数、货量、油价成本和龙头盈利弹性。",
  },
];

function boardReasonRule(name) {
  const text = String(name || "");
  return FLOW_DRIVER_RULES.find((rule) => rule.keywords.some((keyword) => text.includes(keyword))) || {
    inPolicy: "政策面暂无单一强催化，更多体现为资金对该方向景气或预期的阶段性选择。",
    outPolicy: "政策面缺少明确增量催化时，资金可能优先撤出弹性较弱或预期兑现方向。",
    inNews: "消息面需要继续核对公告、行业新闻和盘中异动原因。",
    outNews: "消息面若无新增利好或出现利空传闻，短线资金会倾向先卖出观察。",
    macro: "宏观上主要受市场风险偏好、成交额和资金轮动节奏影响。",
    geo: "地缘影响暂不明确，需结合具体产业链外需、资源和供应链暴露度判断。",
    micro: "微观验证看龙头是否放量、成分股是否扩散、尾盘是否回流。",
  };
}

function matchNewsHints(row, marketData) {
  const news = marketData?.market?.news || marketData?.news || [];
  if (!Array.isArray(news) || !news.length) return [];
  const name = String(row?.name || "").replace(/[（）()]/g, " ");
  const terms = uniqueTextList(name.split(/[\s、/，,]+/).filter((term) => term.length >= 2));
  return news
    .map((item) => typeof item === "string" ? item : (item.title || item.summary || ""))
    .filter((title) => terms.some((term) => String(title).includes(term)))
    .slice(0, 2);
}

function marketContextText(marketData, direction) {
  const market = marketData?.market || {};
  const pieces = [];
  const amount = finiteValue(market.totalAmountYi);
  if (amount !== null) {
    if (amount >= 12000) pieces.push("全市场成交额处于高位，资金轮动承载力较强");
    else if (amount >= 10000) pieces.push("成交额站上万亿，板块轮动仍有流动性支撑");
    else pieces.push("成交额不足万亿，资金更容易向少数方向集中或从弱势方向撤出");
  }
  const limitUp = finiteValue(market.limitUpCount);
  const limitDown = finiteValue(market.limitDownCount);
  if (limitUp !== null && limitDown !== null) {
    if (limitUp > limitDown * 2) pieces.push("涨停扩散强于跌停，风险偏好偏积极");
    else if (limitDown > limitUp) pieces.push("跌停压力高于涨停扩散，资金避险倾向更强");
    else pieces.push("涨跌停结构分化，资金更偏向局部抱团");
  }
  if (!pieces.length) pieces.push(direction === "in" ? "从资金方向看，该板块获得阶段性主动配置" : "从资金方向看，该板块遭遇阶段性主动减配");
  return pieces.join("；") + "。";
}

function flowReasonData(row, context = {}) {
  const direction = context.direction || (row.amount >= 0 ? "in" : "out");
  const marketData = context.marketData || {};
  const rule = boardReasonRule(row.name);
  const newsHints = matchNewsHints(row, marketData);
  const policy = direction === "in" ? rule.inPolicy : rule.outPolicy;
  const news = newsHints.length
    ? "匹配到公开消息线索：" + newsHints.join("；")
    : (direction === "in" ? rule.inNews : rule.outNews);
  const action = direction === "in"
    ? "净流入说明资金正在主动配置或回补仓位，重点看午后是否继续扩散。"
    : "净流出说明资金在兑现、避险或切换方向，重点看尾盘是否有回流。";
  const macroGeo = rule.macro + " " + rule.geo;
  const micro = rule.micro;
  return {
    name: row.tdxName || row.name || "--",
    amount: finiteValue(row.amount),
    behavior: action + " " + marketContextText(marketData, direction),
    policyNews: policy + " " + news,
    macroGeo,
    micro,
  };
}

function flowReasonHtml(row, context = {}) {
  const reason = flowReasonData(row, context);
  return [
    "<div class=\"flow-reason\">",
    "<div><strong>资金行为：</strong>" + escapeReportHtml(reason.behavior) + "</div>",
    "<div><strong>政策/消息：</strong>" + escapeReportHtml(reason.policyNews) + "</div>",
    "<div><strong>宏观/地缘：</strong>" + escapeReportHtml(reason.macroGeo) + "</div>",
    "<div><strong>微观验证：</strong>" + escapeReportHtml(reason.micro) + "</div>",
    "</div>",
  ].join("");
}

function optimizedFlowAnalysis(marketData) {
  const rows = collectFlows(marketData);
  const inflow = rows.filter((row) => row.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 3)
    .map((row) => flowReasonData(row, { marketData, direction: "in" }));
  const outflow = rows.filter((row) => row.amount < 0).sort((a, b) => a.amount - b.amount).slice(0, 3)
    .map((row) => flowReasonData(row, { marketData, direction: "out" }));
  return { inflow, outflow };
}

function flowListWithReasonsHtml(rows, context = {}) {
  if (!rows.length) return "<li>暂无数据</li>";
  return rows
    .map((row, index) =>
      "<li><div class=\"flow-head\"><span>" + (index + 1) + ". " + escapeReportHtml(row.name) + "</span><strong>" +
      escapeReportHtml(reportAmount(row.amount)) + "</strong></div>" + flowReasonHtml(row, context) + "</li>",
    )
    .join("");
}

function quantThemeName(row) {
  const concepts = Array.isArray(row?.concepts) ? row.concepts : [];
  return uniqueTextList([row?.sector, ...concepts, row?.name]).join(" ");
}

function quantTrendText(row) {
  const change = finiteValue(row?.changePct);
  if (change === null) return "涨跌幅暂缺，按量化结构观察。";
  if (change >= 10) return "当日涨幅较大，资金进攻意愿强，但需要防止一致性过热。";
  if (change >= 3) return "当日上涨明显，说明资金对该方向有主动定价。";
  if (change >= 0) return "当日小幅上涨，更多体现为趋势承接或低位修复。";
  if (change <= -5) return "当日跌幅偏大，说明资金分歧和卖压较强。";
  return "当日小幅回落，可能是弱分歧、洗盘或资金切换导致。";
}

function quantSignalReasonText(row) {
  const signal = String(row?.signalText || "");
  const reasons = Array.isArray(row?.reasons) ? row.reasons.slice(0, 3).join("；") : "";
  const risks = Array.isArray(row?.risks) && row.risks.length ? " 风险项：" + row.risks.slice(0, 2).join("；") + "。" : "";
  const signalText = signal ? "战法命中" + signal + "，" : "战法信号，";
  return signalText + (reasons || "趋势和量价结构进入观察区") + "。" + risks;
}

const COMPANY_POLICY_EVENT_RE = /政策|监管|证监会|工信部|发改委|国务院|央行|财政|补贴|集采|许可|批复|核准|试点|规划|指引|规则|退市|问询|减持|增持|回购|分红|重组|并购|定增|募资|处罚|立案|调查|诉讼|仲裁/;
const COMPANY_GEO_EVENT_RE = /美国|欧盟|日本|韩国|台湾|台海|中美|海外|出口管制|出口限制|出口|进口|关税|制裁|禁令|贸易摩擦|贸易战|地缘|军事冲突|武装冲突|中东|俄乌|供应链|外贸|国际化|全球市场|全球供应链|全球业务|美元|汇率/;
const COMPANY_PRICE_CAUSE_RE = /涨停|跌停|大涨|大跌|异动|龙虎榜|主力资金|净流入|净流出|中标|订单|合同|签约|回购|增持|减持|业绩|预告|盈利|亏损|收购|重组|处罚|立案|问询|产品|项目|投建|投产|扩产|交付|研发|突破|涨价|降价|补贴|出口|关税|制裁|合作|发布|获批|入选/;
const GENERIC_MARKET_LIST_RE = /资金流入榜|资金流出榜|每笔成交|换手率|龙虎榜数据|大宗交易|融资余额|融券余额|涨幅榜|跌幅榜|成交量增长|成交额创/;

function cleanEventSummaryText(value) {
  return String(value || "")
    .replace(/…+/g, "。")
    .replace(/\.{3,}/g, "。")
    .replace(/\s+/g, " ")
    .trim();
}

function completeEventLead(value) {
  const text = cleanEventSummaryText(value);
  if (!text) return "";
  const matches = [text.indexOf("。"), text.indexOf("！"), text.indexOf("？"), text.indexOf("；")]
    .filter((index) => index >= 0);
  if (!matches.length) return text;
  return text.slice(0, Math.min(...matches) + 1);
}

function companyEventSummaryText(event) {
  const date = event?.date ? String(event.date).slice(0, 16) + " " : "";
  const source = event?.source ? event.source + "：" : "";
  const title = cleanEventSummaryText(event?.title);
  const lead = completeEventLead(event?.content);
  const listLike = GENERIC_MARKET_LIST_RE.test(title) || /^\d{4,}(?:\.\d+)?\s/.test(lead) || /(?:\d+(?:\.\d+)?\s+){5,}/.test(lead);
  const content = listLike ? "" : lead;
  const detail = content && !title.includes(content) && !content.includes(title) ? "。" + content : "。";
  return date + source + "《" + title + "》" + detail;
}

function pickCompanyEvent(events, categoryRegex = null, companyName = "") {
  const source = Array.isArray(events) ? events : [];
  const matched = categoryRegex
    ? source.filter((event) => {
        const title = String(event?.title || "");
        const content = String(event?.content || "");
        if (!categoryRegex.test([title, content, event?.source].join(" "))) return false;
        if (GENERIC_MARKET_LIST_RE.test(title) && companyName && !title.includes(companyName)) return false;
        return true;
      })
    : source;
  return matched
    .map((event, index) => {
      const title = String(event?.title || "");
      const dateText = String(event?.date || "").replace(/\//g, "-").replace(" ", "T");
      const timestamp = Date.parse(dateText) || 0;
      const causeScore = COMPANY_PRICE_CAUSE_RE.test([event.title, event.content].join(" ")) ? 1 : 0;
      const directScore = companyName && title.includes(companyName) ? 1 : 0;
      return { event, index, directScore, causeScore, timestamp };
    })
    .sort((a, b) => b.directScore - a.directScore || b.causeScore - a.causeScore || b.timestamp - a.timestamp || a.index - b.index)[0]?.event || null;
}

function companyEventsLine(events, companyName) {
  const event = pickCompanyEvent(events, null, companyName);
  if (!event) return "消息面：暂无可核实的公司级近期事件，不使用传闻替代。";
  return "消息面：" + companyEventSummaryText(event);
}

function companyFilteredEventLine(events, regex, label, companyName) {
  const event = pickCompanyEvent(events, regex, companyName);
  if (!event) return label + "：暂无与该公司直接相关的近期事件，不作确定性归因。";
  return label + "：" + companyEventSummaryText(event);
}

function buildQuantMoveReason(row, marketData = {}) {
  const events = Array.isArray(row?.companyEvents) ? row.companyEvents : [];
  return [
    companyEventsLine(events, row?.name),
    companyFilteredEventLine(events, COMPANY_POLICY_EVENT_RE, "政策面", row?.name),
    companyFilteredEventLine(events, COMPANY_GEO_EVENT_RE, "地缘/宏观", row?.name),
    "盘面：" + quantTrendText(row) + " " + quantSignalReasonText(row),
  ].join("；");
}

function assignQuantMoveReasons(rows, marketData, stats = {}) {
  const selected = Array.isArray(rows) ? rows.filter((row) => row && row.code) : [];
  selected.forEach((row) => {
    row.moveReason = buildQuantMoveReason(row, marketData);
    row.businessIntro = row.moveReason;
  });
  stats.moveReasonGenerated = selected.length;
}


function reportPoolPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "--";
}

function reportPoolYi(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) + "亿" : "--";
}

function limitStockPerformanceLabel(row, mode) {
  const pct = Number(row?.changePct);
  if (!Number.isFinite(pct)) return "--";
  if (isLimitUp(row)) return mode === "repair" ? "修复涨停" : "今日涨停";
  if (pct > 0) return mode === "repair" ? "修复上涨" : "延续上涨";
  if (pct < 0) return mode === "repair" ? "修复失败" : "延续转弱";
  return "平盘";
}

function limitStockStructure(row, kind) {
  const parts = [];
  if (kind === "limitUp") {
    if (Number.isFinite(Number(row.streak))) parts.push(Number(row.streak) + "连板");
    if (Number.isFinite(Number(row.openCount))) parts.push("开板" + Number(row.openCount) + "次");
  } else if (kind === "limitDown") {
    if (Number.isFinite(Number(row.downDays))) parts.push(Number(row.downDays) + "连跌停");
    if (Number.isFinite(Number(row.openCount))) parts.push("打开" + Number(row.openCount) + "次");
  } else if (kind === "yesterdayLimit") {
    parts.push(limitStockPerformanceLabel(row, "continue"));
    if (Number.isFinite(Number(row.streak))) parts.push(Number(row.streak) + "连板基础");
    if (Number.isFinite(Number(row.openCount))) parts.push("昨日开板" + Number(row.openCount) + "次");
  } else if (kind === "yesterdayBroken") {
    parts.push(limitStockPerformanceLabel(row, "repair"));
    if (Number.isFinite(Number(row.openCount))) parts.push("昨日炸板" + Number(row.openCount) + "次");
  }
  return parts.length ? parts.join(" / ") : "--";
}

function limitStockTime(row, kind) {
  if (kind === "limitUp") {
    const first = row.firstLimitTime && row.firstLimitTime !== "--" ? "首次 " + row.firstLimitTime : "";
    const last = row.lastLimitTime && row.lastLimitTime !== "--" ? "最后 " + row.lastLimitTime : "";
    return [first, last].filter(Boolean).join("<br>") || "--";
  }
  if (kind === "yesterdayLimit" || kind === "yesterdayBroken") {
    const first = row.firstLimitTime && row.firstLimitTime !== "--" ? "昨日首次 " + row.firstLimitTime : "";
    const last = row.lastLimitTime && row.lastLimitTime !== "--" ? "昨日最后 " + row.lastLimitTime : "";
    return [first, last].filter(Boolean).join("<br>") || "--";
  }
  return row.lastLimitTime && row.lastLimitTime !== "--" ? row.lastLimitTime : "--";
}

function limitStockRowsHtml(rows, kind) {
  if (!Array.isArray(rows) || !rows.length) {
    return "<p class=\"muted\">当前没有取到个股明细；下一次同步会继续补齐。</p>";
  }
  return [
    "<div class=\"table-wrap\"><table>",
    "<thead><tr><th>排名</th><th>股票</th><th>所在板块</th><th>涨跌幅</th><th>现价</th><th>成交额</th><th>封单额</th><th>结构</th><th>时间</th><th>日K</th></tr></thead>",
    "<tbody>",
    rows.map((row, index) => {
      const tone = Number(row.changePct) >= 0 ? "pos" : "neg";
      const concepts = row.concepts && row.concepts.length ? "<br><span class=\"muted sector-concepts\">概念：" + row.concepts.map(escapeReportHtml).join("、") + "</span>" : "";
      const sectorPeerCount = Number.isFinite(Number(row.sectorPeerCount)) ? Number(row.sectorPeerCount) : 1;
      return [
        "<tr>",
        "<td>" + (index + 1) + "</td>",
        "<td><strong>" + escapeReportHtml(row.name) + "</strong><br><span class=\"muted\">" + escapeReportHtml(row.code) + "</span></td>",
        "<td class=\"sector-cell\"><strong>" + escapeReportHtml(row.sector || "--") + "</strong><span class=\"muted\">（同板块" + sectorPeerCount + "只）</span>" + concepts + "</td>",
        "<td class=\"" + tone + "\">" + escapeReportHtml(reportPct(row.changePct)) + "</td>",
        "<td>" + escapeReportHtml(reportPoolPrice(row.price)) + "</td>",
        "<td>" + escapeReportHtml(reportPoolYi(row.amountYi)) + "</td>",
        "<td>" + escapeReportHtml(reportPoolYi(row.sealAmountYi)) + "</td>",
        "<td>" + escapeReportHtml(limitStockStructure(row, kind)) + "</td>",
        "<td>" + limitStockTime(row, kind) + "</td>",
        "<td><a class=\"klink tdx-stock-link\" href=\"" + escapeReportHtml(quantStockKLocalUrl(row)) + "\" title=\"自动检索当前设备股票软件并打开 " + escapeReportHtml(row.name) + " 日K\">日K</a></td>",
        "</tr>",
      ].join("");
    }).join("\n"),
    "</tbody></table></div>",
  ].join("\n");
}

function buildLimitDetailHtml(marketData, kind) {
  const market = marketData.market || {};
  const detail =
    kind === "limitUp" ? {
      titleBase: "A股涨停个股",
      rows: market.limitUpStocks || [],
      count: market.limitUpCount,
      summary: market.limitUpSub || "点开看个股",
    } : kind === "limitDown" ? {
      titleBase: "A股跌停个股",
      rows: market.limitDownStocks || [],
      count: market.limitDownCount,
      summary: market.limitDownSub || "点开看个股",
    } : kind === "yesterdayLimit" ? {
      titleBase: "A股昨日涨停延续",
      rows: market.yesterdayLimitUp?.stocks || [],
      count: market.yesterdayLimitUp?.count,
      summary: [market.yesterdayLimitUp?.strength, market.yesterdayLimitUp?.summary].filter(Boolean).join("；") || "--",
    } : {
      titleBase: "A股昨日炸板修复",
      rows: market.yesterdayBroken?.stocks || [],
      count: market.yesterdayBroken?.count,
      summary: [market.yesterdayBroken?.strength, market.yesterdayBroken?.summary].filter(Boolean).join("；") || "--",
    };
  const rows = sortLimitStocksBySector(detail.rows);
  const count = detail.count;
  const reportedCount = Number.isFinite(Number(count)) ? Number(count) : null;
  const availabilityText = reportedCount !== null && reportedCount !== rows.length
    ? `统计共 ${reportedCount} 只，当前可展示 ${rows.length} 只。`
    : `当前展示 ${rows.length} 只。`;
  const availabilityClass = reportedCount !== null && reportedCount !== rows.length ? "data-warning" : "meta";
  const tradeDate = market.tradeDate || marketData.index?.tradeDate || "--";
  const fetchedAt = market.fetchedAt || nowText();
  const title = detail.titleBase + " " + tradeDate;
  const body = [
    "<h1>" + escapeReportHtml(title) + "</h1>",
    "<p class=\"meta\">统计时间：" + escapeReportHtml(fetchedAt) + "；" + escapeReportHtml(detail.summary) + "。</p>",
    "<p class=\"" + availabilityClass + "\">" + escapeReportHtml(availabilityText) + "</p>",
    limitStockRowsHtml(rows, kind),
    "<p class=\"note\">说明：个股池来自东方财富涨跌停专题接口，明细按同一板块个股数量由多到少排序，数量相同按板块名称排序，同板块内按股票代码固定排序；所在板块优先展示最完整的行业板块字段，并完整列出接口返回的概念板块；日K按钮调用本机同步服务，在当前后台通达信实例中打开。</p>",
    "<p><a href=\"" + escapeReportHtml(path.basename(CONFIG.outputPath)) + "\">返回主页面</a>　<a href=\"" + escapeReportHtml(path.basename(CONFIG.summaryPath)) + "\">市场总结</a></p>",
    "<p class=\"disclaimer\">本软件仅用于市场数据整理和复盘分析，不构成任何投资建议。市场有风险，决策需独立判断。</p>",
  ].join("\n");
  return [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "  <title>" + escapeReportHtml(title) + "</title>",
    "  <style>",
    "    :root{color-scheme:light;--bg:#d9dde2;--panel:#f7f8fa;--text:#1f2933;--muted:#667085;--line:#b9c1cc;--red:#d9413a;--green:#16825c}",
    "    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:\"Microsoft YaHei\",Arial,sans-serif;line-height:1.55}",
    "    main{max-width:1180px;margin:0 auto;padding:24px 18px 42px}h1{font-size:26px;margin:0 0 8px;font-weight:860}.meta,.muted,.note{color:var(--muted);font-size:12px}",
    "    .table-wrap{overflow:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel);margin-top:16px}table{width:100%;border-collapse:collapse;min-width:1180px}th,td{padding:9px 10px;border-bottom:1px solid #d7dde5;text-align:left;vertical-align:top;font-size:12px}th{position:sticky;top:0;background:#eef1f5;font-weight:820;white-space:nowrap}tr:last-child td{border-bottom:0}.sector-cell{min-width:260px;max-width:420px;white-space:normal;word-break:break-word}.sector-concepts{display:block;margin-top:3px;line-height:1.45}",
    "    .pos{color:var(--red);font-weight:800}.neg{color:var(--green);font-weight:800}.data-warning{padding:8px 10px;border:1px solid #b87916;background:#fff6df;color:#7a500e;font-size:13px;font-weight:750}.disclaimer{margin-top:24px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}.klink{display:inline-flex;height:26px;align-items:center;justify-content:center;padding:0 9px;border:1px solid var(--line);border-radius:5px;color:var(--text);text-decoration:none;background:#fff;font-weight:820}.klink:hover{background:var(--text);color:#fff}a{color:inherit;text-underline-offset:3px}",
    "    @media(max-width:760px){main{padding:18px 12px 32px}h1{font-size:22px}}",
    "  </style>",
    "</head>",
    "<body><main>",
    body,
    "<script>",
    "  document.addEventListener('click',function(event){",
    "    var link=event.target.closest&&event.target.closest('a.tdx-stock-link');",
    "    if(!link)return;",
    "    event.preventDefault();",
    "    var text=link.textContent;",
    "    link.textContent='打开中';",
    "    fetch(link.href,{method:'POST',cache:'no-store'}).then(function(res){return res.json().then(function(data){if(!res.ok||!data.ok)throw new Error(data.message||'本机股票软件接口未完成');return data;});}).then(function(data){link.textContent='已打开';link.title=data.message||'已自动检索当前设备的股票软件并打开日K';setTimeout(function(){link.textContent=text;},1400);}).catch(function(error){link.textContent='未打开';link.title=(error&&error.message)||'未检测到可自动操作的本机股票软件';setTimeout(function(){link.textContent=text;},2600);});",
    "  });",
    "</script>",
    "</main></body>",
    "</html>",
  ].join("\n");
}

function writeLimitDetailFile(filePath, html) {
  if (dryRun) {
    log("演练模式：不会写入 " + filePath);
    return;
  }
  const wasHidden = prepareWritableFile(filePath);
  try {
    writeUtf8File(filePath, html);
  } finally {
    restoreHiddenFile(filePath, wasHidden);
  }
  log("已更新：" + filePath);
}

function writeLimitDetailHtml(marketData) {
  writeLimitDetailFile(CONFIG.limitUpDetailPath, buildLimitDetailHtml(marketData, "limitUp"));
  writeLimitDetailFile(CONFIG.limitDownDetailPath, buildLimitDetailHtml(marketData, "limitDown"));
  writeLimitDetailFile(CONFIG.yesterdayLimitDetailPath, buildLimitDetailHtml(marketData, "yesterdayLimit"));
  writeLimitDetailFile(CONFIG.yesterdayBrokenDetailPath, buildLimitDetailHtml(marketData, "yesterdayBroken"));
}

function sectorStatsHtml(rows, mode) {
  if (!Array.isArray(rows) || !rows.length) return "<li>暂无板块统计</li>";
  return rows
    .map((row, index) => {
      const lead = mode === "repair" ? "修复" + reportNumber(row.upCount) + "只" : "涨停延续" + reportNumber(row.limitUpCount) + "只";
      return "<li>" + (index + 1) + ". " + escapeReportHtml(row.sector) + "：" + lead + "，上涨" + reportNumber(row.upCount) + "/" + reportNumber(row.count) + "，均涨" + reportPct(row.avgChangePct) + "</li>";
    })
    .join("");
}

function plainListHtml(rows) {
  return rows.map((row) => "<li>" + escapeReportHtml(row) + "</li>").join("");
}

function quantStockKLocalUrl(row) {
  return "/stock-open?code=" + encodeURIComponent(row.code || "") +
    "&market=" + encodeURIComponent(row.market ?? "") +
    "&name=" + encodeURIComponent(row.name || "");
}

function quantDataStatsHtml(data) {
  const stats = data.dataStats || {};
  const slotRows = Array.isArray(data.formalSlotStats) && data.formalSlotStats.length
    ? ["公式命中/展示：" + data.formalSlotStats.map((row) => row.signal + " " + reportNumber(row.matched) + "/" + reportNumber(row.formal)).join("；")]
    : [];
  const reasonRows = [
    "涨跌原因：已生成" + reportNumber(stats.moveReasonGenerated) + "条；公司事件接口" + reportNumber(stats.companyEventFetched) + "，缓存" + reportNumber(stats.companyEventCache) + "，未抓到" + reportNumber(stats.companyEventMissing) + "，失败" + reportNumber(stats.companyEventErrors),
  ];
  const rows = [
    "规则版本：" + (data.ruleVersion || QUANT_RULES_VERSION) + "；最少日线" + reportNumber(data.minimumHistoryDays || QUANT_MIN_HISTORY) + "日",
    ...slotRows,
    ...reasonRows,
    "本地通达信最新：" + reportNumber(stats.localFresh),
    "线上缓存最新：" + reportNumber(stats.cacheFresh),
    "线上补齐最新：" + reportNumber(stats.onlineFresh),
    "缓存/本地回补：" + reportNumber(stats.fallbackFresh),
    "满足公式历史长度：" + reportNumber(stats.evaluatedHistory),
    "上市后不足" + reportNumber(data.minimumHistoryDays || QUANT_MIN_HISTORY) + "根日线：" + reportNumber(stats.insufficientHistory),
    "日线未同步至交易日：" + reportNumber(stats.missingHistory),
    "补齐失败：" + reportNumber(stats.onlineErrors),
    "网络异常跳过补齐：" + reportNumber(stats.onlineSkipped),
  ];
  return "<ul>" + plainListHtml(rows) + "</ul>";
}

function quantExcludedHtml(data) {
  const rows = Array.isArray(data.excludedReasons) ? data.excludedReasons : [];
  if (!rows.length) return "<p class=\"muted\">没有触发默认排除项。</p>";
  return "<ul>" + rows.map((row) => "<li>" + escapeReportHtml(row.reason) + "：" + escapeReportHtml(reportNumber(row.count)) + "只</li>").join("") + "</ul>";
}

function splitQuantMoveReasonText(reason) {
  const text = String(reason || "--").trim();
  const labels = ["消息面", "政策面", "地缘/宏观", "盘面"];
  const positions = labels
    .map((label) => ({ label, index: text.indexOf(label + "：") }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index);
  if (!positions.length) return [{ label: "涨跌原因", body: text }];
  return positions.map((item, index) => {
    const nextIndex = positions[index + 1]?.index ?? text.length;
    const prefix = item.label + "：";
    const segment = text.slice(item.index, nextIndex).replace(/^；+/, "").trim();
    const body = segment.startsWith(prefix) ? segment.slice(prefix.length).replace(/^；+|；+$/g, "").trim() : segment.replace(/；+$/g, "");
    return { label: item.label, body: body || "--" };
  });
}

function quantMoveReasonHtml(row) {
  const reason = row?.moveReason || row?.businessIntro || "--";
  const sections = splitQuantMoveReasonText(reason);
  const defaults = {
    "消息面": "暂无可核实的公司级近期事件，不使用传闻替代。",
    "政策面": "暂无与该公司直接相关的近期事件，不作确定性归因。",
    "地缘/宏观": "暂无与该公司直接相关的近期事件，不作确定性归因。",
    "盘面": "按当日涨跌和量价结构观察。",
  };
  const ordered = ["消息面", "政策面", "地缘/宏观", "盘面"].map((label) => {
    const section = sections.find((item) => item.label === label);
    return { label, body: String(section?.body || defaults[label]).replace(/…+/g, "。").replace(/\.{3,}/g, "。") };
  });
  return "<div class=\"reason-list\">" + ordered.map((section) =>
    "<div class=\"reason-line\"><span class=\"reason-label\">" + escapeReportHtml(section.label) + "</span>" +
    "<span class=\"reason-text\">" + escapeReportHtml(section.body) + "</span></div>",
  ).join("") + "</div>";
}

function quantTableHtml(rows) {
  if (!rows || !rows.length) return "<p class=\"muted\">当前没有符合条件的股票。</p>";
  return [
    "<div class=\"quant-list\">",
    rows.map((row, index) => {
      const boards = uniqueTextList([row.sector, ...(Array.isArray(row.concepts) ? row.concepts : [])])
        .filter((item) => !["本地通达信", "未分类", "--"].includes(item));
      const boardText = boards.length ? boards.join("｜") : "未分类";
      const tone = row.changePct >= 0 ? "pos" : "neg";
      return [
        "<article class=\"quant-row\">",
        "<div class=\"rank\">" + (index + 1) + "</div>",
        "<div class=\"stock-cell\"><strong><span class=\"stock-name\">" + escapeReportHtml(row.name) + "</span><span class=\"stock-boards\">｜" + escapeReportHtml(boardText) + "</span></strong><span class=\"muted\">" + escapeReportHtml(row.code) + " / " + escapeReportHtml(row.source) + "</span></div>",
        "<div class=\"score-cell\"><div class=\"cell-label\">评分</div><span class=\"score\">" + escapeReportHtml(row.score) + "</span></div>",
        "<div class=\"signal-cell\"><div class=\"cell-label\">信号</div>" + escapeReportHtml(row.signalText) + "</div>",
        "<div class=\"change-cell\"><div class=\"cell-label\">涨跌幅</div><span class=\"" + tone + "\">" + escapeReportHtml(reportPct(row.changePct)) + "</span></div>",
        "<div class=\"kcell\"><a class=\"klink tdx-stock-link\" href=\"" + escapeReportHtml(quantStockKLocalUrl(row)) + "\" title=\"自动检索当前设备股票软件并打开 " + escapeReportHtml(row.name) + " 日K\">日K</a></div>",
        "<div class=\"move-reason\"><span class=\"cell-label\">近期涨跌原因</span>" + quantMoveReasonHtml(row) + "</div>",
        "</article>",
      ].join("");
    }).join("\n"),
    "</div>",
  ].join("\n");
}

function quantStrategySectionsHtml(rows) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  return QUANT_SIGNAL_ORDER.map((name) => {
    const groupRows = sourceRows
      .filter((row) => (row.signals || []).includes(name))
      .sort((a, b) => b.score - a.score || b.changePct - a.changePct)
      .slice(0, QUANT_FORMAL_LIMIT_PER_SIGNAL);
    const title = name + "（" + reportNumber(groupRows.length) + "）";
    return "<div class=\"strategy-block\"><h3>" + escapeReportHtml(title) + "</h3>" + quantTableHtml(groupRows) + "</div>";
  }).join("\n");
}

function buildQuantHtml(data) {
  const title = "A股量化选股 " + (data.tradeDate || "--");
  const formalRows = Array.isArray(data.formal) ? data.formal : [];
  const cards = [
    ["市场环境", data.amvRegime?.state || "--", data.amvRegime?.text || "--"],
    ["股票池", reportNumber(data.universeCount), (data.stockPoolSource || "线上全A") + "；排除 " + reportNumber(data.excludedCount) + " 只，扫描 " + reportNumber(data.scannedCount) + " 只"],
    ["战法候选", reportNumber(data.formalCount), "只显示真正命中战法的股票"],
    ["展示规则", "每类前十", "超过前十和未命中战法的股票均不显示"],
  ].map((card) => (
    "<div class=\"metric\"><div class=\"metric-label\">" + escapeReportHtml(card[0]) + "</div><div class=\"metric-value\">" + escapeReportHtml(card[1]) + "</div><div class=\"metric-sub\">" + escapeReportHtml(card[2]) + "</div></div>"
  )).join("\n");
  const body = [
    "<h1>" + escapeReportHtml(title) + "</h1>",
    "<p class=\"meta\">更新时间：" + escapeReportHtml(data.fetchedAt || nowText()) + "。市场环境只做提示，不会直接过滤股票。</p>",
    data.error ? "<p class=\"warn\">量化选股生成失败：" + escapeReportHtml(data.error) + "</p>" : "",
    "<section class=\"metric-grid\">" + cards + "</section>",
    "<section><h2>战法候选</h2>" + quantStrategySectionsHtml(formalRows) + "</section>",
    "<section><h2>数据状态</h2>" + quantDataStatsHtml(data) + "</section>",
    "<section><h2>默认排除项</h2>" + quantExcludedHtml(data) + "</section>",
    "<p class=\"note\">说明：硬筛选严格执行《交易策略总览》中的通达信条件选股公式，知行短期趋势线采用EMA(EMA(C,10),10)，知行多空线采用MA14/28/57/114的均值。B2按当前J&lt;80，单针按3日短期位&lt;=30且21日长期位&gt;=75；砖型图按原VAR/SMA柱体公式计算。N型结构、波段阶段、放量上涨缩量回调、上影线和出货风险只用于同战法排序，不会放入未命中公式的股票。B3要求的缩量中继不会被重复当作量价背离扣分。页面按B1/B2/B3/单针/砖型图分开展示，每种战法最多显示前十。</p>",
    "<p><a href=\"" + escapeReportHtml(path.basename(CONFIG.outputPath)) + "\">返回主页面</a>　<a href=\"" + escapeReportHtml(path.basename(CONFIG.summaryPath)) + "\">市场总结</a></p>",
  ].join("\n");
  return [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "  <title>" + escapeReportHtml(title) + "</title>",
    "  <style>",
    "    :root{color-scheme:light;--bg:#d9dde2;--panel:#f7f8fa;--text:#1f2933;--muted:#667085;--line:#b9c1cc;--red:#d9413a;--green:#16825c}",
    "    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:\"Microsoft YaHei\",Arial,sans-serif;line-height:1.55}",
    "    main{max-width:1280px;margin:0 auto;padding:24px 18px 42px}h1{font-size:26px;margin:0 0 8px;font-weight:860}h2{font-size:18px;margin:26px 0 10px;font-weight:840}h3{font-size:15px;margin:18px 0 8px;font-weight:820}",
    "    .meta,.muted,.note{color:var(--muted);font-size:12px}.warn{background:#fff1f0;border:1px solid #f0b8b3;padding:10px 12px;border-radius:6px;color:#9f1d17}",
    "    .metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:16px 0 8px}.metric{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px}.metric-label{font-size:12px;color:var(--muted);font-weight:760}.metric-value{font-size:22px;font-weight:880;margin-top:4px}.metric-sub{font-size:12px;color:var(--muted);margin-top:4px}",
    "    .strategy-block{margin:12px 0 18px}.strategy-block h3{display:flex;align-items:center;gap:8px}.quant-list{display:grid;gap:6px}.quant-row{display:grid;grid-template-columns:26px minmax(320px,1fr) 52px minmax(76px,.7fr) 68px 48px;gap:6px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:7px 8px;min-width:0}.quant-row>div{min-width:0;word-break:break-word}.rank{font-weight:860;color:var(--muted);font-size:12px}.stock-cell strong{display:flex;align-items:baseline;flex-wrap:wrap;gap:0;font-size:14px}.stock-name{flex:0 0 auto}.stock-boards{font-size:11px;line-height:1.45;color:#475467;font-weight:650}.stock-cell .muted{display:block;margin-top:1px}.cell-label{font-size:10px;color:var(--muted);font-weight:820;margin-bottom:1px}.move-reason{grid-column:1/-1;display:grid;grid-template-columns:76px minmax(0,1fr);align-items:start;gap:8px;color:#344054;background:#fff;border-top:1px solid #d7dde5;padding:6px 3px 1px}.move-reason>.cell-label{padding-top:2px}.reason-list{display:grid;gap:3px;min-width:0}.reason-line{display:grid;grid-template-columns:68px minmax(0,1fr);gap:6px;align-items:start;min-width:0;font-size:12px;line-height:1.5}.reason-label{font-size:11px;font-weight:850;color:#1f2933}.reason-text{min-width:0;white-space:normal;overflow:visible}.score{display:inline-flex;align-items:center;justify-content:center;min-width:34px;height:24px;border-radius:5px;background:#1f2933;color:#fff;font-weight:850}.pos{color:var(--red);font-weight:780}.neg{color:var(--green);font-weight:780}.klink{display:inline-flex;height:24px;align-items:center;justify-content:center;padding:0 8px;border:1px solid var(--line);border-radius:5px;color:var(--text);text-decoration:none;background:#fff;font-weight:820}.klink:hover{background:var(--text);color:#fff}",
    "    a{color:inherit;text-underline-offset:3px}ul{margin:8px 0 0;padding-left:22px}li{margin:5px 0}",
    "    @media(max-width:900px){main{padding:18px 12px 32px}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}h1{font-size:22px}.quant-row{grid-template-columns:26px minmax(180px,1fr) 48px 72px 64px 46px}.move-reason{grid-column:1/-1}}",
    "    @media(max-width:560px){.metric-grid{grid-template-columns:1fr}.metric-value{font-size:19px}.quant-row{grid-template-columns:24px minmax(0,1fr) 48px 58px 42px}.rank{grid-column:1}.stock-cell{grid-column:2/-1}.score-cell{grid-column:2}.signal-cell{grid-column:3}.change-cell{grid-column:4}.kcell{grid-column:5}.move-reason{grid-column:1/-1;display:block}.move-reason>.cell-label{display:block;margin-bottom:4px}.reason-line{grid-template-columns:62px minmax(0,1fr)}}",
    "  </style>",
    "</head>",
    "<body><main>",
    body,
    "<script>",
    "  document.addEventListener('click',function(event){",
    "    var link=event.target.closest&&event.target.closest('a.tdx-stock-link');",
    "    if(!link)return;",
    "    event.preventDefault();",
    "    var text=link.textContent;",
    "    link.textContent='打开中';",
    "    fetch(link.href,{method:'POST',cache:'no-store'}).then(function(res){return res.json().then(function(data){if(!res.ok||!data.ok)throw new Error(data.message||'本机股票软件接口未完成');return data;});}).then(function(data){link.textContent='已打开';link.title=data.message||'已自动检索当前设备的股票软件并打开日K';setTimeout(function(){link.textContent=text;},1400);}).catch(function(error){link.textContent='未打开';link.title=(error&&error.message)||'未检测到可自动操作的本机股票软件';setTimeout(function(){link.textContent=text;},2600);});",
    "  });",
    "</script>",
    "</main></body>",
    "</html>",
  ].join("\n");
}

function writeQuantHtml(quantData) {
  const html = buildQuantHtml(quantData);
  if (dryRun) {
    log("演练模式：不会写入 " + CONFIG.quantPath);
    return;
  }
  const allRowsCount = Array.isArray(quantData?.allRows) ? quantData.allRows.length : 0;
  const scannedCount = Number(quantData?.scannedCount) || 0;
  const missingHistory = Number(quantData?.dataStats?.missingHistory) || 0;
  const insufficientHistory = Number(quantData?.dataStats?.insufficientHistory) || 0;
  const unavailableHistory = missingHistory + insufficientHistory;
  const weakFallback = scannedCount > 0 && (scannedCount < 1000 || unavailableHistory > scannedCount * 0.7);
  if (!quantData?.error && allRowsCount === 0 && weakFallback && fs.existsSync(CONFIG.quantPath)) {
    log(`量化选股结果为空且数据源不完整（扫描 ${scannedCount}，不可计算 ${unavailableHistory}），保留已有页面：${CONFIG.quantPath}`);
    return;
  }
  const wasHidden = prepareWritableFile(CONFIG.quantPath);
  try {
    writeUtf8File(CONFIG.quantPath, html);
  } finally {
    restoreHiddenFile(CONFIG.quantPath, true || wasHidden);
  }
  log("已更新：" + CONFIG.quantPath);
}

function injectQuantButtonsOnly() {
  ensureDir(CONFIG.workDir);
  for (const filePath of [...new Set([CONFIG.seedPath, CONFIG.outputPath].filter(Boolean))]) {
    if (!fs.existsSync(filePath)) continue;
    const wasHidden = prepareWritableFile(filePath);
    try {
      writeUtf8File(filePath, ensureMainPageControls(fs.readFileSync(filePath, "utf8")));
    } finally {
      restoreHiddenFile(filePath, wasHidden);
    }
    log("已确认主页面控件：" + filePath);
  }
  if (!fs.existsSync(CONFIG.quantPath)) {
    writeQuantHtml({
      tradeDate: todayLocal(),
      fetchedAt: nowText(),
      error: "等待下一次收盘自动更新生成正式量化结果。",
      amvRegime: { state: "等待更新", text: "市场环境将在正式更新后显示。" },
      stockPoolSource: "等待自动更新",
      universeCount: 0,
      excludedCount: 0,
      scannedCount: 0,
      formalCount: 0,
      watchCount: 0,
      excludedReasons: [],
      dataStats: {},
      formal: [],
      watch: [],
      allRows: [],
    });
  }
}

function desktopAppRedirectHtml() {
  return [
    "<!doctype html>",
    "<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>A股复盘</title>",
    "<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#e6e8eb;color:#20252c;font-family:'Microsoft YaHei UI','Microsoft YaHei',sans-serif}.state{max-width:520px;padding:24px;text-align:center}.state h1{font-size:24px}.state p{color:#66707b;line-height:1.7}.state a{color:#165faf}</style></head>",
    "<body><main class=\"state\"><h1>A股复盘</h1><p id=\"stateText\">正在连接本地复盘服务…</p><p><a href=\"http://127.0.0.1:18765/app/\">打开复盘首页</a></p><p>本软件仅用于市场数据整理和复盘分析，不构成任何投资建议。</p></main>",
    "<script>(function(){var tries=0;var target='http://127.0.0.1:18765/app/';var text=document.getElementById('stateText');function connect(){tries+=1;fetch('http://127.0.0.1:18765/health',{cache:'no-store'}).then(function(response){if(!response.ok)throw new Error('service');return response.json();}).then(function(data){if(!data.ok)throw new Error('health');location.replace(target);}).catch(function(){if(tries<30){text.textContent='本地服务正在启动（'+tries+'/30）…';setTimeout(connect,350);}else{text.textContent='本地同步服务没有启动。请关闭后重新双击桌面上的 A股复盘软件。';}});}connect();})();</script></body></html>",
  ].join("\n");
}

function recentCompareHtml(marketData) {
  const market = marketData.market || {};
  const diagnosis = buildDiagnosis(marketData);
  const rows = [];
  const historyLabel = "历史库前" + reportNumber(diagnosis.historyDaysUsed) + "个有效交易日";
  rows.push("涨停家数：今日" + reportNumber(market.limitUpCount) + "家，" + historyLabel + "均值" + reportNumber(diagnosis.averages.limitUp, 1) + "家，较均值" + reportSignedRatio(diagnosis.compares.limitUp) + "。");
  rows.push("跌停家数：今日" + reportNumber(market.limitDownCount) + "家，" + historyLabel + "均值" + reportNumber(diagnosis.averages.limitDown, 1) + "家，较均值" + reportSignedRatio(diagnosis.compares.limitDown) + "。");
  rows.push("成交额：今日" + reportYi(market.totalAmountYi) + "，" + historyLabel + "均值" + reportYi(diagnosis.averages.amount) + "，较均值" + reportSignedRatio(diagnosis.compares.amount) + "。");
  const days = Array.isArray(market.recentDays) ? market.recentDays.slice(0, 10) : [];
  if (days.length) {
    rows.push("最近交易日序列：" + days.map((day) => day.date.slice(5) + " 涨停" + reportNumber(day.limitUpCount) + "/跌停" + reportNumber(day.limitDownCount) + "/成交" + reportYi(day.totalAmountYi)).join("；") + "。");
  } else {
    rows.push("最近交易日序列：历史接口暂未返回，当前先按当日强度判断。");
  }
  return "<ul>" + plainListHtml(rows) + "</ul>";
}

function marketStructureHtml(marketData) {
  const structure = marketData.marketStructure || marketData.market?.marketStructure || {};
  const mainline = Array.isArray(structure.mainline) ? structure.mainline : [];
  const subline = Array.isArray(structure.subline) ? structure.subline : [];
  const boardList = (rows) => rows.length
    ? "<ol>" + rows.map((item) => "<li><strong>" + escapeReportHtml(item.name) + "</strong>：" + escapeReportHtml(item.evidence) + "；结构分" + escapeReportHtml(reportNumber(item.score, 1)) + "。</li>").join("") + "</ol>"
    : "<p>暂未形成满足资金持续性和涨停宽度要求的方向。</p>";
  return [
    "<h3>主线</h3>",
    boardList(mainline),
    "<h3>支线</h3>",
    boardList(subline),
    "<h3>板块之间切换</h3>",
    "<p>" + escapeReportHtml(structure.interSectorText || "历史样本不足，暂不确认板块之间发生切换。") + "</p>",
    "<p class=\"note\">结构判断已使用本地历史库 " + escapeReportHtml(reportNumber(structure.historyDaysUsed)) + " 个此前交易日，并结合当日板块资金、涨停集群和昨日涨停成分。</p>",
  ].join("");
}

function buildSummaryHtml(marketData) {
  const market = marketData.market || {};
  const flows = collectFlows(marketData);
  const industryFlows = flows.filter((row) => row.group === "二级行业");
  const conceptFlows = flows.filter((row) => row.group === "概念板块");
  const industryInflow = topFlows(industryFlows, "in");
  const conceptInflow = topFlows(conceptFlows, "in");
  const industryOutflow = topFlows(industryFlows, "out");
  const conceptOutflow = topFlows(conceptFlows, "out");
  const diagnosis = buildDiagnosis(marketData);
  const tradeDate = market.tradeDate || marketData.index?.tradeDate || "--";
  const fetchedAt = market.fetchedAt || nowText();
  const title = "A股市场强度总结 " + tradeDate;
  const body = [
    "<h1>" + escapeReportHtml(title) + "</h1>",
    "<p class=\"meta\">统计时间：" + escapeReportHtml(fetchedAt) + "</p>",
    "<h2>最终结论</h2>",
    "<p>" + escapeReportHtml(diagnosis.conclusion) + "</p>",
    "<p>强度评分：" + escapeReportHtml(reportNumber(diagnosis.score, 0)) + "；市场状态：" + escapeReportHtml(diagnosis.tone) + "。</p>",
    "<h2>主线、支线与轮动</h2>",
    marketStructureHtml(marketData),
    "<h2>近期对比</h2>",
    recentCompareHtml(marketData),
    "<h2>判断依据</h2>",
    "<ul>" + plainListHtml(diagnosis.reasons) + "</ul>",
    diagnosis.risks.length ? "<h2>风险提示</h2><ul>" + plainListHtml(diagnosis.risks) + "</ul>" : "",
    "<h2>接力与修复</h2>",
    "<p>昨日涨停延续：" + escapeReportHtml(market.yesterdayLimitUp?.summary || "--") + "</p>",
    "<h3>延续数量前三板块</h3>",
    "<ol>" + sectorStatsHtml(market.yesterdayLimitUp?.topSectors || [], "continue") + "</ol>",
    "<p>昨日炸板修复：" + escapeReportHtml(market.yesterdayBroken?.summary || "--") + "</p>",
    "<h3>修复数量前三板块</h3>",
    "<ol>" + sectorStatsHtml(market.yesterdayBroken?.topSectors || [], "repair") + "</ol>",
    "<h2>资金净流入前三</h2>",
    "<h3>二级行业</h3>",
    "<ol class=\"flow-analysis-list\">" + flowListWithReasonsHtml(industryInflow, { marketData, direction: "in" }) + "</ol>",
    "<h3>概念板块</h3>",
    "<ol class=\"flow-analysis-list\">" + flowListWithReasonsHtml(conceptInflow, { marketData, direction: "in" }) + "</ol>",
    "<h2>资金净流出前三</h2>",
    "<h3>二级行业</h3>",
    "<ol class=\"flow-analysis-list\">" + flowListWithReasonsHtml(industryOutflow, { marketData, direction: "out" }) + "</ol>",
    "<h3>概念板块</h3>",
    "<ol class=\"flow-analysis-list\">" + flowListWithReasonsHtml(conceptOutflow, { marketData, direction: "out" }) + "</ol>",
    "<h2>后续观察</h2>",
    "<p>持续跟踪主要指数、成交额、涨跌停结构、主线延续性和板块轮动是否相互验证，不涉及具体个股操作。</p>",
    "<p class=\"note\">说明：综合判断使用最多60个本地历史交易日，结合主要指数、涨跌停结构、成交额、板块资金流入流出、昨日涨停延续、昨日炸板修复、主线持续性和板块轮动。主线要求资金、涨停集群和跨日延续同时领先；支线为强度次一级方向；板块间切换依据前一交易日强方向与今日主线变化识别。未匹配到可靠数据时明确标注样本不足，不使用传闻替代。</p>",
    "<p class=\"disclaimer\">本软件仅用于市场数据整理和复盘分析，不构成任何投资建议。市场有风险，决策需独立判断。</p>",
    "<p><a href=\"" + escapeReportHtml(path.basename(CONFIG.outputPath)) + "\">返回主页面</a></p>",
  ].join("\n");
  return [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "  <title>" + escapeReportHtml(title) + "</title>",
    "  <style>",
    "    :root{color-scheme:light;--bg:#d9dde2;--text:#1f2933;--muted:#667085;--line:#b9c1cc}",
    "    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:\"Microsoft YaHei\",Arial,sans-serif;line-height:1.7}",
    "    main{max-width:920px;margin:0 auto;padding:34px 22px 48px}",
    "    h1{font-size:26px;margin:0 0 8px;font-weight:850}h2{font-size:18px;margin:28px 0 8px;font-weight:820}h3{font-size:15px;margin:16px 0 4px;font-weight:820;color:#344054}",
    "    p{margin:8px 0}ul,ol{margin:8px 0 0;padding-left:24px}li{margin:6px 0}.meta,.note{color:var(--muted);font-size:13px}.disclaimer{margin-top:24px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}",
    "    .flow-analysis-list{padding-left:0;list-style:none}.flow-analysis-list>li{border-top:1px solid var(--line);padding:12px 0;margin:0}.flow-head{display:flex;align-items:center;justify-content:space-between;gap:12px;font-weight:820}.flow-reason{margin-top:6px;color:#344054;font-size:13px;line-height:1.65}.flow-reason div{margin:3px 0}",
    "    a{color:inherit;text-underline-offset:3px}",
    "    @media(max-width:640px){main{padding:24px 16px 36px}h1{font-size:22px}}",
    "  </style>",
    "</head>",
    "<body>",
    "  <main>",
    body,
    "  </main>",
    "</body>",
    "</html>",
  ].join("\n");
}

function writeSummaryHtml(marketData) {
  const html = buildSummaryHtml(marketData);
  if (dryRun) {
    log("演练模式：不会写入 " + CONFIG.summaryPath);
    return;
  }
  const wasHidden = prepareWritableFile(CONFIG.summaryPath);
  try {
    writeUtf8File(CONFIG.summaryPath, html);
  } finally {
    restoreHiddenFile(CONFIG.summaryPath, true || wasHidden);
  }
  log("已更新：" + CONFIG.summaryPath);
}

function buildMainPageRuntimeScript() {
  return `
    function indexList(){const list=Array.isArray(MARKET_DATA.indices)&&MARKET_DATA.indices.length?MARKET_DATA.indices:[MARKET_DATA.index];return list.filter(item=>item&&Array.isArray(item.points)&&item.points.length)}
    function latestMinute(){const mins=indexList().flatMap(item=>item.points.map(p=>p.minute||0));return mins.length?Math.max(0,Math.min(DAY_MINUTES,Math.max(...mins))):0}
    function maxPlayableMinute(){return latestMinute()}
    const state = { minute: latestMinute(), playing: false, speed: 5, lastTs: 0, lastRenderTs: 0, raf: 0 };
    const API_BASE = /^https?:$/.test(location.protocol) ? location.origin : "http://127.0.0.1:18765";
    let missingFlowSyncTimer=0, autoReloadTimer=0, reloadTimer=0, healthTimer=0, noticeTimer=0, progressPollTimer=0;
    let progressPollResolve=null, syncInFlight=false, serviceAvailable=false, disposed=false, resumePlaying=false;
    function isLiveMinute(minute){return Math.abs((Number(minute)||0)-maxPlayableMinute())<1}
    function requestFlowSample(minute){if(missingFlowSyncTimer||syncInFlight||!isLiveMinute(minute)||!inTradingWindow())return;missingFlowSyncTimer=setTimeout(()=>{missingFlowSyncTimer=0;if(typeof syncLatest==='function')syncLatest(true)},250)}
    const els = {
      playButton: document.getElementById("playButton"), playIcon: document.getElementById("playIcon"),
      speedSelect: document.getElementById("speedSelect"), syncMarketButton: document.getElementById("syncMarketButton"), manualRefreshButton: document.getElementById("manualRefreshButton"), clock: document.getElementById("clock"), timeRange: document.getElementById("timeRange"),
      indicesBody: document.getElementById("indicesBody"), indexMeta: document.getElementById("indexMeta"),
      industryAxis: document.getElementById("industryAxis"), industryRows: document.getElementById("industryRows"), conceptAxis: document.getElementById("conceptAxis"), conceptRows: document.getElementById("conceptRows"),
      sourceNote: document.getElementById("sourceNote"), dataAlert: document.getElementById("dataAlert"), statusNotice: document.getElementById("statusNotice"), statusNoticeText: document.getElementById("statusNoticeText"),
      limitUpCount: document.getElementById("limitUpCount"), limitUpSub: document.getElementById("limitUpSub"), limitDownCount: document.getElementById("limitDownCount"), limitDownSub: document.getElementById("limitDownSub"),
      marketAmount: document.getElementById("marketAmount"), marketVolume: document.getElementById("marketVolume"), yLimitStrength: document.getElementById("yLimitStrength"), yLimitSummary: document.getElementById("yLimitSummary"),
      yBrokenStrength: document.getElementById("yBrokenStrength"), yBrokenSummary: document.getElementById("yBrokenSummary"), marketDate: document.getElementById("marketDate"), marketFetchedAt: document.getElementById("marketFetchedAt")
    };
    function minuteToTime(minute){minute=Math.max(0,Math.min(DAY_MINUTES,minute));const total=minute<=120?570+minute:780+(minute-120);const seconds=Math.round(total*60),h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60),s=seconds%60;return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0")}
    function fmtAmount(v){const sign=v>0?"+":v<0?"-":"";return sign+Math.abs(v).toFixed(1)+"亿"}
    function fmtPct(v){const n=Number(v)||0;const sign=n>0?"+":"";return sign+n.toFixed(2)+"%"}
    function fmtPoint(v){const n=Number(v)||0;const sign=n>0?"+":n<0?"-":"";return sign+Math.abs(n).toFixed(2)}
    function fmtValue(v){return Number(v).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2})}
    function toneClass(v){return Number(v)>=0?"pos":"neg"}
    function smoothProgress(t, seed){const p=Math.max(0,Math.min(1,t)); const eased=p*p*(3-2*p); const wave=Math.sin(p*Math.PI*2.2+seed*.47)*.035*Math.sin(p*Math.PI); return Math.max(0,Math.min(1,eased+wave))}
    function flowValueAt(row, minute){const points=(Array.isArray(row.points)?row.points:[]).map(p=>({minute:Number(p.minute)||0,amount:Number(p.amount)||0})).filter(p=>Number.isFinite(p.amount)).sort((a,b)=>a.minute-b.minute);const fallback=Number(row&&row.amount);if(!points.length)return Number.isFinite(fallback)?fallback:null;const target=Math.max(0,Math.min(DAY_MINUTES,Number(minute)||0));let value=points[0].amount;for(const point of points){if(point.minute<=target)value=point.amount;else break}return Number.isFinite(value)?value:(Number.isFinite(fallback)?fallback:null)}
    function currentAmount(row, minute, seed){return flowValueAt(row,minute)}
    function escapeHtml(value){return String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[ch]))}
    function rowLabel(row){return row.tdxName||row.name||""}
function sectorSearchName(row){return row.name||row.tdxName||""}
function sectorKUrl(row){const tdx=String(row.tdxCode||"").toUpperCase();const board=String(row.code||"").toUpperCase();const code=/^880\\d{3}$/.test(tdx)?tdx:(/^BK\\d{4}$/.test(board)?board:"");const name=sectorSearchName(row);if(!code&&!name)return "";return "/stock-open?code="+encodeURIComponent(code)+"&market=sector&name="+encodeURIComponent(name)}
    function rowMaxAmount(row){const points=Array.isArray(row.points)?row.points:[];return Math.max(Math.abs(Number(row.amount)||0),...points.map(p=>Math.abs(Number(p.amount)||0)),1)}
    function axisMax(groups){const raw=Math.max(1,...groups.flatMap(group=>group.rows.map(row=>rowMaxAmount(row)))); const padded=raw*1.35; const step=padded>=1000?500:padded>=500?200:padded>=100?100:padded>=50?20:10; return Math.ceil(padded/step)*step}
    function renderAxis(el, max){el.innerHTML="";[-1,-.5,0,.5,1].forEach(step=>{const tick=document.createElement("div");tick.className="tick";tick.style.left=((step+1)*50)+"%";tick.textContent=String(Math.round(max*step));el.appendChild(tick)})}
function initBarRows(container, rows){container.innerHTML='<div class="zero"></div>';rows.forEach((row,index)=>{const rowEl=document.createElement("div");rowEl.className="bar-row";rowEl.dataset.index=index;const label=rowLabel(row);const safeName=escapeHtml(label);const original=row.name&&row.name!==label?" / 原："+escapeHtml(row.name):"";const url=sectorKUrl(row);const kHtml=url?'<a class="kbtn local-stock-link" href="'+url+'" title="自动检索当前设备的股票软件并打开 '+safeName+' 日K图'+original+'">日K</a>':'<span class="kbtn disabled" title="该板块缺少可搜索名称">无名称</span>';rowEl.innerHTML='<div class="name-cell"><div class="name" title="'+safeName+original+'">'+safeName+'</div>'+kHtml+'</div><div class="track"><div class="bar"></div><div class="amount"></div></div>';container.appendChild(rowEl)})}
document.addEventListener("click",event=>{const link=event.target.closest&&event.target.closest("a.local-stock-link");if(!link)return;event.preventDefault();const text=link.textContent;link.textContent="打开中";fetch(link.href,{method:"POST",cache:"no-store"}).then(response=>response.json().then(data=>{if(!response.ok||!data.ok)throw new Error(data.message||"本机股票软件接口未完成");return data})).then(data=>{link.textContent="已打开";link.title=data.message||"已自动检索当前设备的股票软件并打开日K";setTimeout(()=>{link.textContent=text},1400)}).catch(error=>{link.textContent="未打开";link.title=error&&error.message||"未检测到可自动操作的本机股票软件";setTimeout(()=>{link.textContent=text},2600)})})
    function updateBars(container, rows, max, minute){[...container.querySelectorAll(".bar-row")].forEach((rowEl,index)=>{const row=rows[index];let value=currentAmount(row,minute,index+1);const bar=rowEl.querySelector(".bar");const amount=rowEl.querySelector(".amount");if(value===null||!Number.isFinite(Number(value))){value=Number(row&&row.amount);if(!Number.isFinite(value))value=0;if(isLiveMinute(minute)&&inTradingWindow())requestFlowSample(minute)}const w=Math.min(42,Math.abs(value)/max*50);const tone=value>=0?"pos":"neg";bar.className="bar "+tone;bar.style.width=w+"%";amount.className="amount "+tone;amount.style.setProperty("--w",w+"%");amount.title="最近一次真实同步累计净流入";amount.textContent=fmtAmount(value)})}
    function interpolateSeries(points, minute, key){if(!points.length)return 0; let prev=points[0], next=points[points.length-1]; for(let i=0;i<points.length;i++){if(points[i].minute<=minute) prev=points[i]; if(points[i].minute>=minute){next=points[i]; break}} const span=Math.max(1,next.minute-prev.minute); const t=Math.max(0,Math.min(1,(minute-prev.minute)/span)); return prev[key]+(next[key]-prev[key])*t}
    function renderLine(svg, points, minute, key, baseline){const value=interpolateSeries(points,minute,key); const visible=points.filter(p=>p.minute<=minute); const base=Number(baseline)||Number(points[0]?.[key])||value; const all=points.map(p=>p[key]).concat([base]); const min=Math.min(...all), max=Math.max(...all); const pad=(max-min)*.16||1; const y=v=>148-((v-(min-pad))/(max-min+pad*2))*132; const x=m=>14+(m/DAY_MINUTES)*972; const changePct=base?((value-base)/base*100):0; let path=""; visible.forEach((p,i)=>{path+=(i?"L":"M")+x(p.minute).toFixed(2)+" "+y(p[key]).toFixed(2)}); if(visible.length){path+="L"+x(minute).toFixed(2)+" "+y(value).toFixed(2)} else {path="M14 "+y(value).toFixed(2)} const color=changePct>=0?"#d9413a":"#16825c"; const baseY=y(base); const grid='<line x1="14" x2="986" y1="'+baseY+'" y2="'+baseY+'" stroke="#a8b2bd" stroke-width="1" stroke-dasharray="4 5"/><line x1="500" x2="500" y1="10" y2="148" stroke="#dde3ea" stroke-width="1" stroke-dasharray="4 6"/>'; svg.innerHTML=grid+'<path d="'+path+'" fill="none" stroke="'+color+'" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/><circle cx="'+x(minute).toFixed(2)+'" cy="'+y(value).toFixed(2)+'" r="5" fill="'+color+'"/>'; return {value,changePct,pointChange:value-base}}
    function initIndexCards(){const list=indexList(); els.indicesBody.innerHTML=""; list.forEach((item,index)=>{const card=document.createElement("div");card.className="index-card";card.dataset.index=String(index);card.innerHTML='<div class="index-card-head"><div class="index-name">'+escapeHtml(item.name||item.code||"--")+'</div><div class="index-date">'+escapeHtml(item.tradeDate||"--")+'</div></div><div class="mini-svg-wrap"><svg viewBox="0 0 1000 160" preserveAspectRatio="none" aria-label="'+escapeHtml(item.name||"指数")+'分时图"></svg></div><div class="index-card-stats"><span class="idx-price">--</span><span class="idx-point">--</span><span class="idx-pct">--</span></div>';els.indicesBody.appendChild(card)}); if(els.indexMeta){els.indexMeta.textContent=list.length+" 个主要指数"}}
    function renderIndices(minute){const list=indexList(); [...els.indicesBody.querySelectorAll(".index-card")].forEach(card=>{const item=list[Number(card.dataset.index)||0]; if(!item)return; const current=renderLine(card.querySelector("svg"),item.points,minute,"price",item.preClose); const tone=toneClass(current.changePct); const price=card.querySelector(".idx-price"); const point=card.querySelector(".idx-point"); const pct=card.querySelector(".idx-pct"); price.textContent=fmtValue(current.value); point.textContent=fmtPoint(current.pointChange); pct.textContent=fmtPct(current.changePct); price.className="idx-price "+tone; point.className="idx-point "+tone; pct.className="idx-pct "+tone})}
    function fmtNumber(v){return Number.isFinite(Number(v))?Number(v).toLocaleString("zh-CN"):"--"}
    function fmtYi(v){const n=Number(v); if(!Number.isFinite(n))return "--"; return n>=10000?(n/10000).toFixed(2)+"万亿":n.toFixed(0)+"亿"}
    function fmtVolYi(v){const n=Number(v); return Number.isFinite(n)?n.toFixed(1)+"亿手":"--"}
    function strengthClass(text){return /强|延续中|修复中/.test(text)?"pos":/无延续|未修复/.test(text)?"neg":""}
    function countDetailLink(fileName,value,tone,title){return '<a class="count-link '+tone+'" href="'+escapeHtml(fileName)+'" target="_blank" rel="noopener" title="'+escapeHtml(title)+'">'+fmtNumber(value)+"</a>"}
    function strengthDetailLink(fileName,value,tone,title){return '<a class="count-link '+tone+'" href="'+escapeHtml(fileName)+'" target="_blank" rel="noopener" title="'+escapeHtml(title)+'">'+escapeHtml(value||"--")+"</a>"}
    function statSubText(value, fallback){return value&&value!=="涨停专题"&&value!=="跌停专题"?value:fallback}
    function renderMarketStats(){const m=MARKET_DATA.market||{}; const yLimit=m.yesterdayLimitUp||{}; const yBroken=m.yesterdayBroken||{}; const yLimitTone=strengthClass(yLimit.strength||""); const yBrokenTone=strengthClass(yBroken.strength||""); els.limitUpCount.innerHTML=countDetailLink("A股涨停个股_最新.html",m.limitUpCount,"pos","查看涨停个股和所在板块"); els.limitUpSub.textContent=statSubText(m.limitUpSub,"点开看个股"); els.limitDownCount.innerHTML=countDetailLink("A股跌停个股_最新.html",m.limitDownCount,"neg","查看跌停个股和所在板块"); els.limitDownSub.textContent=statSubText(m.limitDownSub,"点开看个股"); els.marketAmount.textContent=fmtYi(m.totalAmountYi); els.marketVolume.textContent="成交量 "+fmtVolYi(m.totalVolumeYiHands); els.yLimitStrength.innerHTML=strengthDetailLink("A股昨日涨停延续_最新.html",yLimit.strength||"--",yLimitTone,"查看昨日涨停延续个股和所在板块"); els.yLimitStrength.className="market-value "+yLimitTone; els.yLimitSummary.textContent=yLimit.summary||"--"; els.yBrokenStrength.innerHTML=countDetailLink("A股昨日炸板修复_最新.html",yBroken.count,yBrokenTone,"查看昨日炸板股票和今日修复情况"); els.yBrokenStrength.className="market-value "+yBrokenTone; els.yBrokenSummary.textContent=[yBroken.strength,yBroken.summary].filter(Boolean).join(" · ")||"--"; els.marketDate.textContent=m.tradeDate||"--"; els.marketFetchedAt.textContent=m.fetchedAt||"收盘后自动更新"}
    const industryMax=axisMax([MARKET_DATA.industry]); const conceptMax=axisMax([MARKET_DATA.concept]);
    renderAxis(els.industryAxis,industryMax); renderAxis(els.conceptAxis,conceptMax); initBarRows(els.industryRows,MARKET_DATA.industry.rows); initBarRows(els.conceptRows,MARKET_DATA.concept.rows); initIndexCards();
    els.sourceNote.textContent=MARKET_DATA.sourceNote; renderMarketStats();
    function render(){const max=maxPlayableMinute();if(els.timeRange){els.timeRange.max=String(max);if(state.minute>max)state.minute=max;els.timeRange.value=String(state.minute)}els.clock.textContent=minuteToTime(state.minute); renderIndices(state.minute); updateBars(els.industryRows,MARKET_DATA.industry.rows,industryMax,state.minute); updateBars(els.conceptRows,MARKET_DATA.concept.rows,conceptMax,state.minute)}
    function renderDataValidation(){const validation=MARKET_DATA.validation;if(!els.dataAlert||!validation||validation.status==="ok"){if(els.dataAlert)els.dataAlert.hidden=true;return}const messages=[...(validation.errors||[]),...(validation.warnings||[])];els.dataAlert.hidden=false;els.dataAlert.textContent="部分数据异常："+(messages[0]||"部分字段暂未补齐")+(messages.length>1?"（另有"+(messages.length-1)+"项，详见控制台）":"");console.warn("A股复盘数据校验",validation)}
    function showNotice(type,message,sticky){if(!els.statusNotice||!els.statusNoticeText)return;clearTimeout(noticeTimer);els.statusNotice.className="status-notice "+(type||"info");els.statusNoticeText.textContent=message;els.statusNotice.hidden=false;if(!sticky)noticeTimer=setTimeout(()=>{els.statusNotice.hidden=true},5000)}
    function hideNotice(){if(els.statusNotice)els.statusNotice.hidden=true;clearTimeout(noticeTimer)}
    async function requestJson(url,options,timeoutMs){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeoutMs||30000);try{const response=await fetch(url,{...(options||{}),cache:"no-store",signal:controller.signal});const data=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(data.message||("请求失败（"+response.status+"）"));error.data=data;error.status=response.status;throw error}return data}catch(error){if(error.name==="AbortError"){const timeoutError=new Error("网络请求超时");timeoutError.code="TIMEOUT";throw timeoutError}throw error}finally{clearTimeout(timer)}}
    function syncErrorMessage(error){const data=error&&error.data||{};const code=data.errorCode||error.code||"";if(code==="TIMEOUT")return "同步超时，后台任务可能仍在继续";if(code==="DATA_SOURCE_ERROR")return "市场数据接口异常，请稍后重试";if(code==="GENERATE_FAILED")return "复盘数据生成失败";if(code==="FILE_WRITE_FAILED")return "复盘文件写入失败";if(code==="SERVICE_UNAVAILABLE"||error instanceof TypeError)return "本地同步服务没有启动。请重新打开软件启动程序后再试。";return data.message||error.message||"同步失败"}
    function updateSyncButton(){if(!els.syncMarketButton)return;if(syncInFlight){els.syncMarketButton.disabled=true;els.syncMarketButton.textContent="正在同步";return}els.syncMarketButton.disabled=!serviceAvailable;els.syncMarketButton.textContent=serviceAvailable?"同步市场":"同步服务未启动"}
    async function checkServiceHealth(silent){try{const data=await requestJson(API_BASE+"/health",{},5000);serviceAvailable=Boolean(data&&data.ok);if(els.syncMarketButton)els.syncMarketButton.title=serviceAvailable?"同步服务 "+(data.version||"")+" 正常":"同步服务未启动";if(!silent&&serviceAvailable)showNotice("success","同步服务已连接",false);return serviceAvailable}catch(error){serviceAvailable=false;if(!silent)showNotice("error","本地同步服务没有启动。请重新打开软件启动程序后再试。",true);return false}finally{updateSyncButton()}}
    function clearProgressPoll(){if(progressPollTimer)clearTimeout(progressPollTimer);progressPollTimer=0;if(progressPollResolve){const resolve=progressPollResolve;progressPollResolve=null;resolve()}}
    function waitForProgress(ms){return new Promise(resolve=>{progressPollResolve=resolve;progressPollTimer=setTimeout(()=>{progressPollTimer=0;progressPollResolve=null;resolve()},ms)})}
    async function pollSyncResult(){const startedAt=Date.now();while(Date.now()-startedAt<5*60*1000){if(disposed||document.hidden){const error=new Error("页面已隐藏，同步状态轮询已暂停");error.code="PAUSED";throw error}const status=await requestJson(API_BASE+"/status",{},5000);if(status.running){const progress=status.progress||{};showNotice("info",progress.message||"正在同步最新盘面数据",true);await waitForProgress(1200);continue}if(status.lastResult){if(status.lastResult.ok)return status.lastResult;const error=new Error(status.lastResult.message||"同步失败");error.data=status.lastResult;throw error}await waitForProgress(800)}const timeoutError=new Error("同步结果等待超时");timeoutError.code="TIMEOUT";throw timeoutError}
    async function syncLatest(silent){if(syncInFlight||disposed)return;syncInFlight=true;updateSyncButton();if(!silent)showNotice("info","正在连接同步服务",true);try{if(!serviceAvailable&&!(await checkServiceHealth(true))){const error=new Error("同步服务未启动");error.code="SERVICE_UNAVAILABLE";throw error}const accepted=await requestJson(API_BASE+"/refresh?async=1",{method:"POST"},30000);if(!accepted.ok&&!accepted.running)throw Object.assign(new Error(accepted.message||"同步请求未被接受"),{data:accepted});showNotice("info",accepted.message||"正在获取指数",true);const result=await pollSyncResult();showNotice("success",result.message||"同步完成，正在刷新页面",true);if(els.syncMarketButton)els.syncMarketButton.textContent="同步成功";reloadTimer=setTimeout(()=>location.reload(),700)}catch(error){if(error.code!=="PAUSED")showNotice("error",syncErrorMessage(error),true);console.error("A股复盘同步失败",error)}finally{syncInFlight=false;updateSyncButton()}}
    function reloadLatest(){if(reloadTimer||disposed)return;showNotice("info","正在重新读取本地最新页面",true);reloadTimer=setTimeout(()=>location.reload(),80)}
    function inTradingWindow(){const d=new Date();const day=d.getDay();if(day===0||day===6)return false;const m=d.getHours()*60+d.getMinutes();return (m>=9*60+15&&m<=11*60+30)||(m>=13*60&&m<=15*60)}
    function shouldKeepAutoReloadCheck(){const d=new Date();const day=d.getDay();if(day===0||day===6)return false;const m=d.getHours()*60+d.getMinutes();return m>=9*60+15&&m<=15*60}
    function clearAutoReload(){if(autoReloadTimer)clearTimeout(autoReloadTimer);autoReloadTimer=0}
    function scheduleAutoReload(){clearAutoReload();if(disposed||document.hidden||!shouldKeepAutoReloadCheck())return;autoReloadTimer=setTimeout(()=>{autoReloadTimer=0;if(inTradingWindow())location.reload();else scheduleAutoReload()},20000)}
    function startHealthMonitor(){if(healthTimer)clearInterval(healthTimer);if(disposed||document.hidden)return;healthTimer=setInterval(()=>checkServiceHealth(true),30000)}
    function setIcon(){els.playButton.setAttribute("aria-label",state.playing?"暂停":"播放");els.playIcon.innerHTML=state.playing?'<path d="M7 5h4v14H7zM13 5h4v14h-4z"></path>':'<path d="M8 5v14l11-7z"></path>'}
    function tick(ts){if(!state.playing||disposed||document.hidden)return;if(!state.lastTs)state.lastTs=ts;const dt=(ts-state.lastTs)/1000;state.lastTs=ts;const max=maxPlayableMinute();state.minute+=dt*state.speed*2.4;if(state.minute>=max){state.minute=max;state.playing=false;setIcon();render();return}if(!state.lastRenderTs||ts-state.lastRenderTs>=66){state.lastRenderTs=ts;render()}state.raf=requestAnimationFrame(tick)}
    function pauseRuntime(){resumePlaying=state.playing;state.playing=false;state.lastTs=0;if(state.raf)cancelAnimationFrame(state.raf);state.raf=0;clearAutoReload();if(healthTimer)clearInterval(healthTimer);healthTimer=0;if(missingFlowSyncTimer)clearTimeout(missingFlowSyncTimer);missingFlowSyncTimer=0;clearProgressPoll();setIcon()}
    function resumeRuntime(){if(disposed)return;scheduleAutoReload();checkServiceHealth(true);startHealthMonitor();if(resumePlaying){resumePlaying=false;state.playing=true;state.lastTs=0;state.raf=requestAnimationFrame(tick)}setIcon()}
    function disposeRuntime(){disposed=true;pauseRuntime();if(reloadTimer)clearTimeout(reloadTimer);reloadTimer=0;clearTimeout(noticeTimer)}
    els.playButton.addEventListener("click",()=>{const max=maxPlayableMinute();state.playing=!state.playing;state.lastTs=0;state.lastRenderTs=0;setIcon();if(state.playing){if(state.minute>=max)state.minute=0;if(state.raf)cancelAnimationFrame(state.raf);state.raf=requestAnimationFrame(tick)}else if(state.raf){cancelAnimationFrame(state.raf);state.raf=0}});
    els.speedSelect.addEventListener("change",e=>{state.speed=Number(e.target.value)});
    els.timeRange.addEventListener("input",e=>{state.minute=Math.max(0,Math.min(maxPlayableMinute(),Number(e.target.value)||0));render()});
    if(els.syncMarketButton)els.syncMarketButton.addEventListener("click",()=>syncLatest(false));
    if(els.manualRefreshButton)els.manualRefreshButton.addEventListener("click",reloadLatest);
    document.addEventListener("visibilitychange",()=>{if(document.hidden)pauseRuntime();else resumeRuntime()});
    window.addEventListener("pagehide",disposeRuntime,{once:true});
    render();renderDataValidation();scheduleAutoReload();checkServiceHealth(true);startHealthMonitor();
`;
}

function ensureMajorIndexLayout(html) {
  html = html.replace(/<title>[^<]*<\/title>/, "<title>A股主要指数与板块同步复盘</title>");
  html = html.replace("<h1>A股三项同步复盘</h1>", "<h1>A股主要指数与板块同步复盘</h1>");
  html = html.replace("同步显示：上证指数、二级行业、概念板块。", "同步显示：主要指数、二级行业、概念板块。");
  if (!/\.indices-body\{/.test(html)) {
    html = html.replace(
      "    .line-body{display:grid;grid-template-columns:minmax(0,1fr) 132px;gap:8px;min-height:0}.svg-wrap{position:relative;min-height:0}",
      "    .indices-body{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:minmax(112px,1fr);gap:6px;min-height:0;overflow:hidden}.index-card{background:#f8fafc;border:1px solid var(--line);border-radius:7px;padding:6px;min-width:0;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;gap:4px}.index-card-head{display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0}.index-name{font-size:12px;font-weight:840;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.index-date{font-size:10px;color:var(--muted);font-weight:700;white-space:nowrap}.mini-svg-wrap{position:relative;min-height:0}.index-card-stats{display:grid;grid-template-columns:1.1fr .95fr .75fr;gap:5px;align-items:center;font-size:11px;font-weight:820;white-space:nowrap}.idx-price,.idx-point,.idx-pct{overflow:hidden;text-overflow:ellipsis}.idx-point,.idx-pct{text-align:right}\n    .line-body{display:grid;grid-template-columns:minmax(0,1fr) 132px;gap:8px;min-height:0}.svg-wrap{position:relative;min-height:0}",
    );
  }
  html = html.replace(
    /      <section class="panel panel-index">[\s\S]*?      <\/section>\s*      <section class="panel panel-industry">/,
    [
      "      <section class=\"panel panel-index\">",
      "        <div class=\"panel-head\"><div class=\"panel-title\">主要指数分时图</div><div class=\"panel-meta\" id=\"indexMeta\"></div></div>",
      "        <div class=\"indices-body\" id=\"indicesBody\"></div>",
      "      </section>",
      "      <section class=\"panel panel-industry\">",
    ].join("\n"),
  );
  html = html.replace(
    /const DAY_MINUTES = 240;[\s\S]*?<\/script>/,
    "const DAY_MINUTES = 240;\n" + buildMainPageRuntimeScript() + "  </script>",
  );
  return html;
}

function ensureMainPageControls(html) {
  html = ensureMajorIndexLayout(html);
  html = html.replace(
    "grid-template-rows:auto auto minmax(0,1fr) auto auto",
    "grid-template-rows:auto auto auto minmax(0,1fr) auto auto",
  );
  if (!/\.data-alert\{/.test(html)) {
    html = html.replace(
      "</style>",
      "    .data-alert{padding:7px 10px;border:1px solid #b87916;background:#fff6df;color:#7a500e;border-radius:6px;font-size:12px;font-weight:750}.data-alert[hidden]{display:none}.status-notice{position:fixed;right:14px;top:14px;z-index:12000;display:flex;align-items:center;gap:8px;max-width:min(460px,calc(100vw - 28px));padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--text);box-shadow:0 8px 24px rgba(22,32,42,.18);font-size:12px;font-weight:750}.status-notice[hidden]{display:none}.status-notice.success{border-color:#16825c}.status-notice.error{border-color:#d9413a}.status-notice.info{border-color:#b87916}.disclaimer{margin-top:3px;color:var(--muted);font-size:10.5px}.foot{white-space:normal}\n  </style>",
    );
  }
  if (!/id="dataAlert"/.test(html)) {
    html = html.replace(
      /<\/header>\s*<section class="market-strip"/,
      "</header>\n    <div class=\"data-alert\" id=\"dataAlert\" role=\"alert\" hidden></div>\n    <section class=\"market-strip\"",
    );
  }
  if (!/id="statusNotice"/.test(html)) {
    html = html.replace(
      "<body>",
      "<body>\n  <div class=\"status-notice info\" id=\"statusNotice\" role=\"status\" aria-live=\"polite\" hidden><span id=\"statusNoticeText\"></span></div>",
    );
  }
  html = html.replace(
    /<footer class="foot" id="sourceNote"><\/footer>/,
    "<footer class=\"foot\"><div id=\"sourceNote\"></div><div class=\"disclaimer\">本软件仅用于市场数据整理和复盘分析，不构成任何投资建议。市场有风险，决策需独立判断。</div></footer>",
  );
  if (!/\.count-link/.test(html)) {
    html = html.replace(
      "</style>",
      "    .count-link{display:inline-flex;align-items:center;justify-content:center;min-width:42px;height:24px;padding:0 7px;border:1px solid currentColor;border-radius:6px;text-decoration:none;background:#fff;font-weight:880;line-height:1}.count-link:hover{background:var(--text);border-color:var(--text);color:#fff}\n  </style>",
    );
  }
  if (!/button\.summary-btn/.test(html)) {
    html = html.replace(
      ".summary-btn:hover{background:var(--text);border-color:var(--text);color:white}",
      ".summary-btn:hover{background:var(--text);border-color:var(--text);color:white}button.summary-btn{cursor:pointer}",
    );
  }
  const quantEnabled = path.basename(CONFIG.quantPath) === "A股量化选股_最新.html";
  const button = "        <a class=\"summary-btn\" id=\"quantButton\" href=\"A股量化选股_最新.html\">量化选股</a>";
  if (!quantEnabled) {
    html = html.replace(/\s*<a class="summary-btn" id="quantButton"[\s\S]*?<\/a>/, "");
  } else if (!/id="quantButton"/.test(html) && /(\s*<a class="summary-btn" id="summaryButton"[\s\S]*?<\/a>)/.test(html)) {
    html = html.replace(/(\s*<a class="summary-btn" id="summaryButton"[\s\S]*?<\/a>)/, "$1\n" + button);
  } else if (!/id="quantButton"/.test(html)) {
    html = html.replace("</div>\n    </header>", button + "\n      </div>\n    </header>");
  }
  const syncButton = "        <button class=\"summary-btn\" id=\"syncMarketButton\" type=\"button\" title=\"立即同步最新市场数据\">同步市场</button>";
  const refreshButton = "        <button class=\"summary-btn\" id=\"manualRefreshButton\" type=\"button\" title=\"重新读取本地最新页面\">刷新页面</button>";
  if (!/id="syncMarketButton"/.test(html) && /<button class="summary-btn" id="manualRefreshButton"[\s\S]*?<\/button>/.test(html)) {
    html = html.replace(/<button class="summary-btn" id="manualRefreshButton"[\s\S]*?<\/button>/, syncButton.trim() + "\n" + refreshButton);
  } else if (!/id="syncMarketButton"/.test(html) && /(\s*<a class="summary-btn" id="quantButton"[\s\S]*?<\/a>)/.test(html)) {
    html = html.replace(/(\s*<a class="summary-btn" id="quantButton"[\s\S]*?<\/a>)/, "$1\n" + syncButton + "\n" + refreshButton);
  } else if (!/id="syncMarketButton"/.test(html) && /(\s*<a class="summary-btn" id="summaryButton"[\s\S]*?<\/a>)/.test(html)) {
    html = html.replace(/(\s*<a class="summary-btn" id="summaryButton"[\s\S]*?<\/a>)/, "$1\n" + syncButton + "\n" + refreshButton);
  } else if (!/id="manualRefreshButton"/.test(html) && /(\s*<button class="summary-btn" id="syncMarketButton"[\s\S]*?<\/button>)/.test(html)) {
    html = html.replace(/(\s*<button class="summary-btn" id="syncMarketButton"[\s\S]*?<\/button>)/, "$1\n" + refreshButton);
  } else if (/id="manualRefreshButton"/.test(html)) {
    html = html.replace(/<button class="summary-btn" id="manualRefreshButton" type="button" title="[^"]*">[^<]*<\/button>/, refreshButton.trim());
  }
  if (!/function latestMinute/.test(html)) {
    html = html.replace(
      "const state = { minute: 0, playing: false, speed: 5, lastTs: 0, raf: 0 };",
      "function latestMinute(){const a=(MARKET_DATA.index&&MARKET_DATA.index.points)||[];const mins=a.map(p=>p.minute||0);return mins.length?Math.max(0,Math.min(DAY_MINUTES,Math.max(...mins))):0}\n    const state = { minute: latestMinute(), playing: false, speed: 5, lastTs: 0, raf: 0 };",
    );
  }
  if (!/syncMarketButton:/.test(html)) {
    html = html.replace(
      "speedSelect: document.getElementById(\"speedSelect\"), clock: document.getElementById(\"clock\"), timeRange: document.getElementById(\"timeRange\"),",
      "speedSelect: document.getElementById(\"speedSelect\"), syncMarketButton: document.getElementById(\"syncMarketButton\"), manualRefreshButton: document.getElementById(\"manualRefreshButton\"), clock: document.getElementById(\"clock\"), timeRange: document.getElementById(\"timeRange\"),",
    );
    html = html.replace(
      "speedSelect: document.getElementById(\"speedSelect\"), manualRefreshButton: document.getElementById(\"manualRefreshButton\"), clock: document.getElementById(\"clock\"), timeRange: document.getElementById(\"timeRange\"),",
      "speedSelect: document.getElementById(\"speedSelect\"), syncMarketButton: document.getElementById(\"syncMarketButton\"), manualRefreshButton: document.getElementById(\"manualRefreshButton\"), clock: document.getElementById(\"clock\"), timeRange: document.getElementById(\"timeRange\"),",
    );
  }
  return html;
}

function syncOptimizedDesktopApp(marketData, quantData, policyNews) {
  const appDir = CONFIG.optimizedAppDir;
  if (!appDir || !fs.existsSync(path.join(appDir, "index.html"))) {
    log(`完整优化应用尚未部署，跳过结构化数据同步：${appDir}`);
    return null;
  }
  const result = exportOptimizedAppData({
    appDir,
    marketData,
    quantData,
    diagnosis: buildDiagnosis(marketData),
    structure: marketData.marketStructure,
    flowAnalysis: optimizedFlowAnalysis(marketData),
    policyNews,
    archiveDir: CONFIG.structuredHistoryDir,
    legacyArchiveDir: CONFIG.dailyArchiveDir,
  });
  if (result.quantOnly) {
    if (result.quantPreserved) {
      log(`量化数据源不完整，已保留上次有效结果：${appDir}`);
      throw new Error("量化数据源不完整，已保留上次有效结果，请稍后重试。");
    }
    log(`已同步量化选股数据：${appDir}；交易日 ${result.tradeDate}`);
  } else {
    if (result.quantPreserved) log(`本次量化数据源不完整，完整复盘已更新并保留上次有效量化结果：${appDir}`);
    log(`已同步完整优化应用：${appDir}；交易日 ${result.tradeDate}；数据校验 ${result.validation?.status || "未校验"}`);
  }
  return result;
}

function syncWindowsPwaPackage(marketData) {
  const appDir = CONFIG.windowsPwaDir;
  const indexPath = path.join(appDir, "index.html");
  if (!fs.existsSync(indexPath)) {
    log(`Windows PWA 同步跳过：找不到 ${indexPath}`);
    return;
  }
  let html = fs.readFileSync(indexPath, "utf8");
  const json = JSON.stringify(marketData).replace(/<\//g, "<\\/");
  const replaced = html.replace(
    /const MARKET_DATA = \{[\s\S]*?\};\s*const DAY_MINUTES/,
    `const MARKET_DATA = ${json};\n    const DAY_MINUTES`,
  );
  if (replaced === html) throw new Error("Windows PWA 首页没有找到 MARKET_DATA");
  html = replaced;
  if (fs.existsSync(CONFIG.summaryPath) && /const encoded="[^"]*";/.test(html)) {
    const encoded = Buffer.from(fs.readFileSync(CONFIG.summaryPath, "utf8"), "utf8").toString("base64");
    html = html.replace(/const encoded="[^"]*";/, `const encoded="${encoded}";`);
  }
  writeUtf8File(indexPath, html);
  const detailPaths = [
    CONFIG.summaryPath,
    CONFIG.limitUpDetailPath,
    CONFIG.limitDownDetailPath,
    CONFIG.yesterdayLimitDetailPath,
    CONFIG.yesterdayBrokenDetailPath,
  ];
  detailPaths.forEach((sourcePath) => {
    if (!fs.existsSync(sourcePath)) throw new Error(`Windows PWA 缺少待同步文件：${sourcePath}`);
    writeUtf8File(path.join(appDir, path.basename(sourcePath)), fs.readFileSync(sourcePath, "utf8"));
  });
  log(`已同步 Windows PWA：${appDir}`);
}

// Remove only obsolete distribution artifacts after a successful refresh.
// Keep the original desktop app, updater, and the current three platform folders.
function cleanupOldDistributions() {
  const root = path.resolve(path.dirname(CONFIG.outputPath));
  const oldNames = [
    "A股复盘三端直开单文件版",
    "A股复盘三端直开单文件版.html",
    "A股复盘三端直开单文件版.zip",
    "A股复盘微信发送包",
    "A股复盘微信发送包.zip",
    "A股复盘三端安装版_无量化选股",
    "A股复盘三端安装版_无量化选股.zip",
    "a-share-review.html",
  ];
  for (const name of oldNames) {
    const target = path.resolve(root, name);
    if (target === root || !target.startsWith(root + path.sep)) {
      throw new Error(`拒绝清理工作目录外的路径：${target}`);
    }
    if (!fs.existsSync(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
    log(`已清理旧版本：${target}`);
  }
}

function writeLegacyMainHtml(marketData) {
  const templatePath = resolveLegacyTemplatePath({
    outputPath: CONFIG.outputPath,
    seedPath: CONFIG.seedPath,
  });
  if (!templatePath) {
    log(`旧版单页模板不存在，已跳过兼容页面输出；结构化桌面应用继续更新：${CONFIG.seedPath}`);
    return false;
  }
  let html = fs.readFileSync(templatePath, "utf8");
  const json = JSON.stringify(marketData).replace(/<\//g, "<\\/");
  const replaced = html.replace(
    /const MARKET_DATA = \{[\s\S]*?\};\s*const DAY_MINUTES/,
    `const MARKET_DATA = ${json};\n    const DAY_MINUTES`,
  );
  if (replaced === html) throw new Error("页面模板中没有找到 MARKET_DATA");
  html = replaced;
  html = ensureMainPageControls(html);
  if (dryRun) {
    log(`演练模式：不会写入 ${CONFIG.outputPath}`);
    return true;
  }
  const wasHidden = prepareWritableFile(CONFIG.outputPath);
  try {
    writeUtf8File(CONFIG.outputPath, html);
  } finally {
    restoreHiddenFile(CONFIG.outputPath, wasHidden);
  }
  log(`已更新：${CONFIG.outputPath}`);
  if (CONFIG.legacyOutputPath && CONFIG.legacyOutputPath !== CONFIG.outputPath) {
    try {
      const legacyHidden = prepareWritableFile(CONFIG.legacyOutputPath);
      writeUtf8File(CONFIG.legacyOutputPath, desktopAppRedirectHtml());
      restoreHiddenFile(CONFIG.legacyOutputPath, legacyHidden);
      log(`已同步桌面 App 服务跳转入口：${CONFIG.legacyOutputPath}`);
    } catch (error) {
      log(`旧入口兼容文件同步跳过：${error.message}`);
    }
  }
  return true;
}

function writeHtml(marketData, quantData, policyNews) {
  // The structured desktop app is the primary product. Legacy single-file outputs
  // are best-effort and must never block a real market-data refresh.
  if (!dryRun) syncOptimizedDesktopApp(marketData, quantData, policyNews);
  runOptionalOutput("旧版单页复盘", () => writeLegacyMainHtml(marketData), log);
  runOptionalOutput("旧版市场总结", () => writeSummaryHtml(marketData), log);
  runOptionalOutput("旧版涨跌停明细", () => writeLimitDetailHtml(marketData), log);
  if (!skipQuant && quantData) {
    runOptionalOutput("旧版量化选股", () => writeQuantHtml(quantData), log);
  }
  if (!dryRun) runOptionalOutput("旧发行文件清理", cleanupOldDistributions, log);
}

function archiveCompleteMarketData(marketData) {
  if (dryRun) return;
  const tradeDate = marketData?.market?.tradeDate || marketData?.index?.tradeDate || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || marketData?.validation?.status !== "ok") return;
  const archivePath = path.join(CONFIG.dailyArchiveDir, `${tradeDate}_完整复盘数据.json`);
  if (fs.existsSync(archivePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(archivePath, "utf8"));
      if (compareLegacyArchives(existing, marketData, tradeDate) > 0) {
        log(`保留 ${tradeDate} 已有较完整归档，本轮低采样快照不覆盖历史数据。`);
        return;
      }
    } catch (error) {
      log(`已有归档读取失败，将用本轮已校验数据修复：${error.message}`);
    }
  }
  writeUtf8File(archivePath, JSON.stringify(sanitizeLegacyStructureFields(marketData)));
  log(`已归档完整交易日数据：${archivePath}`);
}

async function generateOnce() {
  const policyNewsPromise = buildPolicyNewsData().catch((error) => {
    log(`政策新闻更新失败，保留现有栏目数据：${error.message}`);
    return emptyPolicyNewsData(error.message);
  });
  const expectedDate = force ? null : expectedMarketDate();
  let [index, industry, concept] = await Promise.all([
    fetchIndex({ preferTencent: intradayMode }),
    fetchBoardGroup("二级行业板块", "m:90+s:4"),
    fetchBoardGroup("概念板块", "m:90+t:3"),
  ]);
  const syncedAt = nowText();
  index.fetchedAt = syncedAt;
  industry.tradeDate = index.tradeDate;
  industry.fetchedAt = syncedAt;
  concept.tradeDate = index.tradeDate;
  concept.fetchedAt = syncedAt;
  const sampleMinute = latestTradeMinuteFromIndex(index);
  const flowCache = await updateBoardFlowSeries(index.tradeDate, sampleMinute, syncedAt, { industry, concept });
  industry = attachFlowSeriesToGroup(industry, "industry", flowCache);
  concept = attachFlowSeriesToGroup(concept, "concept", flowCache);
  industry.attributionRows = flowAttributionRows(flowCache, "industry");
  concept.attributionRows = flowAttributionRows(flowCache, "concept");
  industry.flowSampleMinute = sampleMinute;
  concept.flowSampleMinute = sampleMinute;
  const indices = fetchMajorIndices(index, { preferTencent: intradayMode }).map((item) => ({ ...item, fetchedAt: syncedAt }));
  requireFreshData(index, industry, concept, expectedDate, { intraday: intradayMode });
  const [marketStats, indexAnnotations] = await Promise.all([
    safeMarketStats(index.tradeDate, { intraday: intradayMode }),
    fetchClsIndexAnnotations(index.tradeDate, syncedAt),
  ]);
  const market = applyTurnoverFallback(marketStats, index, indices);
  if (market && !market.fetchedAt) market.fetchedAt = syncedAt;
  const baseMarketData = buildMarketData(index, industry, concept, market, syncedAt, indices);
  baseMarketData.indexAnnotations = indexAnnotations;
  baseMarketData.validation = validateMarketData(baseMarketData);
  assertPublishableMarketData(baseMarketData.validation);
  const preparedHistory = updateMarketHistory(baseMarketData, { persist: false, returnCache: true });
  const marketData = preparedHistory.marketData;
  marketData.validation = validateMarketData(marketData);
  assertPublishableMarketData(marketData.validation);
  marketData.sourceNote += "板块资金动态图优先使用经排名末值校验的官方分钟序列，接口暂时异常时保留上一份已验证序列并继续追加真实排名样本；动画只在相邻真实样本之间线性显示，不会把后采样值反向伪填到早期分钟。指数分时已确认有效拐点按红色上涨箭头或绿色下跌箭头显示主要归因题材，悬停可核对证据窗口、资金变化、题材涨跌、相关性、置信度及备选题材；未达到双重证据门槛的候选不在图上发布。";
  let quantData = null;
  if (!skipQuant && !intradayMode) {
    try {
      quantData = await buildQuantSelection(marketData);
    } catch (error) {
      log("量化选股生成失败，主页面继续更新：" + error.message);
      quantData = buildQuantErrorData(marketData, error);
    }
  }
  const policyNews = await policyNewsPromise;
  writeHtml(marketData, quantData, policyNews);
  saveMarketHistoryCache(preparedHistory.cache);
  archiveCompleteMarketData(marketData);
  log(`完成：主要指数 ${indices.length} 个；上证 ${index.tradeDate} ${index.points.length} 点；二级行业 ${industry.rows.length} 行；概念板块 ${concept.rows.length} 行；同步时间 ${syncedAt}。`);
}

function runQuantSelfTest() {
  const currentBrokenStats = calculateBrokenBoardStats(40, 11);
  if (currentBrokenStats.touchedLimitCount !== 51 || currentBrokenStats.brokenRate !== 21.6) {
    throw new Error(`当日炸板公式自检失败：${JSON.stringify(currentBrokenStats)}`);
  }
  const brokenDisplaySample = summarizeQuoteGroup("昨日炸板", "BK1631", [
    { f12: "000001", f14: "红盘样例", f3: 2 },
    { f12: "000002", f14: "绿盘样例", f3: -1 },
  ], "repair");
  if (!brokenDisplaySample.summary.startsWith("炸板2家，今日红盘1家") || brokenDisplaySample.summary.includes("涨停0/2")) {
    throw new Error(`昨日炸板显示自检失败：${brokenDisplaySample.summary}`);
  }
  if (isAStockCodeForTdxPrefix("000300", "sh")) throw new Error("股票池自检失败：沪深300指数被识别成上海股票");
  if (!isAStockCodeForTdxPrefix("000001", "sz")) throw new Error("股票池自检失败：深市股票未识别");
  if (!isAStockCodeForTdxPrefix("600000", "sh")) throw new Error("股票池自检失败：沪市股票未识别");
  if (!isAStockCodeForTdxPrefix("920001", "bj")) throw new Error("股票池自检失败：北交所股票未识别");
  const quotePriceSample = normalizeLimitPoolStock({f12: "688333", f14: "价格样例", f2: 112, f3: 1, zdp: 9, f18: 110, quoteDate: "2026-07-16"}, "yesterdayBroken");
  if (quotePriceSample.price !== 112 || quotePriceSample.preClose !== 110 || quotePriceSample.changePct !== 1) {
    throw new Error("炸板行情自检失败：正常报价被错误缩放");
  }
  const poolPriceSample = normalizeLimitPoolStock({c: "688333", n: "池价格样例", p: 112000, zdp: 1}, "limitUp");
  if (poolPriceSample.price !== 112) throw new Error("涨停池自检失败：千倍价格字段换算错误");
  const attributionRows = flowAttributionRows({
    sampleMinute: 20,
    groups: { industry: {
      BKTEST: { code: "BKTEST", name: "归因样例", points: [
        { minute: 10, amount: 1, changePct: 0.2, syncedAt: "10:00" },
        { minute: 20, amount: 3, changePct: 0.8, syncedAt: "10:10" },
        { minute: 30, amount: 8, changePct: 1.2, syncedAt: "10:20" },
      ] },
    } },
  }, "industry");
  if (attributionRows.length !== 1 || attributionRows[0].points.length !== 2) {
    throw new Error("指数归因自检失败：使用了当前时间之后的板块资金样本");
  }
  if (attributionRows[0].points[1].changePct !== 0.8) throw new Error("指数归因自检失败：行业涨跌幅样本未保留");
  const officialFlowPoints = parseBoardFlowTimeline([
    "2026-07-14 09:31,247733648.0,-1,-1,-1,-1",
    "2026-07-14 11:30,1020000000.0,-1,-1,-1,-1",
    "2026-07-14 13:01,1080000000.0,-1,-1,-1,-1",
    "2026-07-14 15:00,14137114987.0,-1,-1,-1,-1",
    "2026-07-15 09:31,99999999999.0,-1,-1,-1,-1",
  ], "2026-07-14", 240, "自检");
  if (officialFlowPoints.length !== 4 || officialFlowPoints.map((point) => point.minute).join(",") !== "1,120,121,240") {
    throw new Error("板块分钟资金自检失败：交易日或午休时间映射不正确");
  }
  if (officialFlowPoints.at(-1).amount !== 141.37 || officialFlowPoints.at(-1).source !== "eastmoney-board-minute-flow") {
    throw new Error("板块分钟资金自检失败：主力净流入字段或亿元换算不正确");
  }
  const flowTargetSample = Array.from({length: 24}, (_, index) => ({
    code: `BK${String(1000 + index).padStart(4, "0")}`,
    amount: index < 12 ? 12 - index : -(index - 11),
  }));
  const selectedFlowTargets = selectBoardTimelineTargets(flowTargetSample);
  if (selectedFlowTargets.length !== 20
      || selectedFlowTargets.filter((row) => row.amount > 0).length !== 10
      || selectedFlowTargets.filter((row) => row.amount < 0).length !== 10) {
    throw new Error("板块分钟资金自检失败：流入或流出前十目标选择不完整");
  }
  const recoveredFlowSample = mergeRecoveredFlowSeries(
    {
      tradeDate: "2026-07-24",
      groups: {industry: {BKTEST: {code: "BKTEST", points: [{minute: 240, amount: 9}]}}, concept: {}},
    },
    {
      tradeDate: "2026-07-24",
      groups: {industry: {BKTEST: {
        code: "BKTEST",
        flowValidated: true,
        points: [{minute: 1, amount: 1}, {minute: 240, amount: 8}],
      }}, concept: {}},
    },
    "自检缓存",
  ).cache.groups.industry.BKTEST;
  if (recoveredFlowSample.points.length !== 2
      || recoveredFlowSample.points.at(-1).amount !== 9
      || !recoveredFlowSample.flowValidated) {
    throw new Error("板块分钟资金自检失败：跨版本真实序列未合并，或覆盖了当前末值");
  }
  const attributionSourceNote = buildMarketData({}, {}, {}, {}, "自检").sourceNote;
  if (!attributionSourceNote.includes("官方分钟资金序列") || !attributionSourceNote.includes("自动修正当前真实采样点") || !attributionSourceNote.includes("不改写此前分钟历史") || !attributionSourceNote.includes("直接采用财联社盯盘公开板块事件") || !attributionSourceNote.includes("排除所有个股事件") || !attributionSourceNote.includes("不生成原因、不补写标签") || !attributionSourceNote.includes("否则不显示标注")) {
    throw new Error("指数标注自检失败：真实拐点、题材双重证据或禁止虚构归因的口径不完整");
  }
  const baseMetrics = {
    last: { open: 10.02, high: 10.35, low: 9.85, close: 10.1, volume: 1000 },
    prev: { open: 9.9, high: 10.08, low: 9.75, close: 10, volume: 900 },
    beforePrev: { open: 9.75, high: 9.92, low: 9.6, close: 9.8, volume: 800 },
    j: 50,
    prevJ: 50,
    changePct: 1,
    prevChangePct: 2,
    amplitude: 5,
    avgVol20: 1000,
    bbi: 9.9,
    ma20: 9.8,
    shortTrend: 10.2,
    prevShortTrend: 10.1,
    multiTrend: 10,
    prevMultiTrend: 9.98,
    trendQualified: true,
    singleShort: 50,
    singleLong: 50,
    riskPos20: 50,
    brickRising: false,
    previousBrickFalling: false,
    brickRedHeight: 0,
    brickGreenHeight: 0,
    dif: 0.2,
    dea: 0.1,
    prevDif: 0.15,
    kdjDeadCross: false,
  };
  const metricsFor = (overrides = {}) => ({
    ...baseMetrics,
    ...overrides,
    last: { ...baseMetrics.last, ...(overrides.last || {}) },
    prev: { ...baseMetrics.prev, ...(overrides.prev || {}) },
    beforePrev: { ...baseMetrics.beforePrev, ...(overrides.beforePrev || {}) },
  });
  const b1State = quantSignals(metricsFor({ j: 12.99, changePct: -3, amplitude: 7 }));
  if (!b1State.B1 || quantSignals(metricsFor({ j: 13 })).B1) throw new Error("量化自检失败：B1通达信边界不正确");
  const b2State = quantSignals(metricsFor({ prevJ: 12.99, j: 79.99, changePct: 4.01, last: { volume: 1001 } }));
  if (!b2State.B2 || quantSignals(metricsFor({ prevJ: 13, j: 79, changePct: 5, last: { volume: 1001 } })).B2 || quantSignals(metricsFor({ prevJ: 12, j: 80, changePct: 5, last: { volume: 1001 } })).B2) {
    throw new Error("量化自检失败：B2的前一J/当前J边界不正确");
  }
  const b3State = quantSignals(metricsFor({
    prevChangePct: 6.01,
    changePct: 2,
    amplitude: 7,
    prev: { open: 9.4, close: 10, volume: 1200 },
    beforePrev: { close: 9.4, volume: 1000 },
    last: { open: 10.05, close: 10.2, volume: 1100 },
  }));
  if (!b3State.B3 || quantSignals(metricsFor({ prevChangePct: 6, prev: { open: 9.4, close: 10, volume: 1200 }, beforePrev: { close: 9.4, volume: 1000 }, last: { open: 10.05, close: 10.2, volume: 1100 } })).B3) {
    throw new Error("量化自检失败：B3通达信边界不正确");
  }
  if (!b3State.flags.previousNoUpperShadow || quantSignals(metricsFor({ prevChangePct: 6.01, changePct: 2, amplitude: 7, trendQualified: false, prev: { open: 9.4, close: 10, volume: 1200 }, beforePrev: { close: 9.4, volume: 1000 }, last: { open: 10.05, close: 10.2, volume: 1100 } })).B3) {
    throw new Error("量化自检失败：B3前一日上影线或全局趋势前提不正确");
  }
  const b3ShrinkMetrics = metricsFor({
    prevChangePct: 6.5,
    changePct: 1.2,
    amplitude: 2.5,
    prev: { open: 9.4, high: 10.02, close: 10, volume: 1200 },
    beforePrev: { close: 9.4, volume: 900 },
    last: { open: 10.02, close: 10.12, volume: 700 },
    volumePriceDivergence: { upShrink: true, highShrink: true, volumeSurgeNoPrice: false, shortVolumeDown: true },
  });
  const b3ShrinkScore = scoreQuant(b3ShrinkMetrics, quantSignals(b3ShrinkMetrics));
  if (b3ShrinkScore.risks.some((text) => /上涨缩量|价格近新高但量能不足|短期量能/.test(text))) {
    throw new Error("量化自检失败：B3所需缩量被误判为量价背离");
  }
  const needleState = quantSignals(metricsFor({ singleShort: 30, singleLong: 75 }));
  if (!needleState.单针 || quantSignals(metricsFor({ singleShort: 30.01, singleLong: 75 })).单针 || quantSignals(metricsFor({ singleShort: 30, singleLong: 74.99 })).单针) {
    throw new Error("量化自检失败：单针3日/21日边界不正确");
  }
  if (quantSignals(metricsFor({ singleShort: 30, singleLong: 75, trendQualified: false })).单针) {
    throw new Error("量化自检失败：单针未执行全局趋势先决条件");
  }
  const brickState = quantSignals(metricsFor({ brickRising: true, previousBrickFalling: true, brickRedHeight: 2, brickGreenHeight: 3, last: { close: 10.5 } }));
  if (!brickState.砖型图 || quantSignals(metricsFor({ brickRising: true, previousBrickFalling: true, brickRedHeight: 1.99, brickGreenHeight: 3, last: { close: 10.5 } })).砖型图) {
    throw new Error("量化自检失败：砖型图红绿柱高度边界不正确");
  }
  const formulaHistory = [];
  let formulaClose = 8;
  for (let i = 0; i < 130; i += 1) {
    formulaHistory.push({ date: `2026-01-${pad2((i % 28) + 1)}`, open: formulaClose * 0.998, high: formulaClose * 1.012, low: formulaClose * 0.988, close: formulaClose, volume: 1000 + i, amount: 10000000 });
    formulaClose *= 1.002;
  }
  const formulaMetrics = buildQuantMetrics(formulaHistory, { code: "000001", name: "公式校验" });
  const expectedShortTrend = emaSeries(emaSeries(formulaHistory.map((row) => row.close), 10), 10).at(-1);
  const expectedMultiTrend = average([14, 28, 57, 114].map((period) => maAt(formulaHistory.map((row) => row.close), formulaHistory.length - 1, period)));
  if (Math.abs(formulaMetrics.shortTrend - expectedShortTrend) > 1e-10 || Math.abs(formulaMetrics.multiTrend - expectedMultiTrend) > 1e-10) {
    throw new Error("量化自检失败：知行趋势线未按通达信公式计算");
  }
  const expectedBbi = average([3, 6, 12, 24].map((period) => maAt(formulaHistory.map((row) => row.close), formulaHistory.length - 1, period)));
  if (Math.abs(formulaMetrics.bbi - expectedBbi) > 1e-10) {
    throw new Error("量化自检失败：BBI未按MA3/6/12/24均值计算");
  }
  const kdjProbe = kdjSeries([{ open: 7, high: 10, low: 0, close: 8, volume: 1000 }]);
  if (Math.abs(kdjProbe[0].k - 80) > 1e-10 || Math.abs(kdjProbe[0].d - 80) > 1e-10 || Math.abs(kdjProbe[0].j - 80) > 1e-10) {
    throw new Error("量化自检失败：KDJ未按RSV后两次通达信SMA原式初始化");
  }
  const history = [];
  let close = 10;
  for (let i = 0; i < 125; i += 1) {
    history.push({ date: `2026-03-${pad2((i % 28) + 1)}`, open: close * 0.995, high: close * 1.01, low: close * 0.99, close, volume: 1000, amount: 10000000 });
    close *= 1.001;
  }
  const before = history.at(-1).close;
  history.push({ date: "2026-06-28", open: before, high: before * 1.075, low: before * 0.995, close: before * 1.065, volume: 1800, amount: 18000000 });
  const prevClose = history.at(-1).close;
  history.push({ date: "2026-06-29", open: prevClose * 1.002, high: prevClose * 1.025, low: prevClose * 0.998, close: prevClose * 1.018, volume: 1200, amount: 12000000 });
  const item = evaluateQuantStock({ code: "000001", market: 0, name: "测试股票", sector: "测试", concepts: [] }, { history, source: "自检" });
  if (!item || !item.signals.includes("B3") || item.ruleVersion !== QUANT_RULES_VERSION) throw new Error("量化自检失败：B3公式样例未命中");
  const sortedLimitSample = sortLimitStocksBySector([
    { code: "000009", name: "B板块样例", sector: "B板块" },
    { code: "000003", name: "A板块样例二", sector: "A板块" },
    { code: "000002", name: "C板块样例", sector: "C板块" },
    { code: "000001", name: "A板块样例一", sector: "A板块" },
  ]);
  if (sortedLimitSample.map((row) => row.code).join(",") !== "000001,000003,000009,000002" ||
      sortedLimitSample.map((row) => row.sectorPeerCount).join(",") !== "2,2,1,1") {
    throw new Error("涨跌停排序自检失败：未按同板块数量降序和固定次序排列");
  }
  const diagnosisSample = {
    index: { preClose: 100, points: [{ price: 99 }] },
    indices: [
      { name: "上证指数", preClose: 100, points: [{ price: 99 }] },
      { name: "深证成指", preClose: 100, points: [{ price: 97 }] },
      { name: "创业板指", preClose: 100, points: [{ price: 96 }] },
      { name: "科创50", preClose: 100, points: [{ price: 95 }] },
    ],
    industry: { rows: [{ name: "商业航天", amount: 100 }, { name: "旧主线", amount: -800 }] },
    concept: { rows: [{ name: "卫星互联网", amount: 80 }, { name: "旧题材", amount: -600 }] },
    market: {
      tradeDate: "2026-07-10",
      limitUpCount: 90,
      limitDownCount: 4,
      totalAmountYi: 20000,
      limitUpStocks: [
        { code: "000101", name: "新低位一", sector: "商业航天", concepts: ["卫星互联网"], changePct: 10 },
        { code: "000102", name: "新低位二", sector: "商业航天", concepts: ["卫星互联网"], changePct: 10 },
      ],
      limitDownStocks: [],
      recentDays: [],
      yesterdayLimitUp: {
        strength: "延续中",
        stocks: [
          { code: "000201", name: "昨日前排一", sector: "商业航天", concepts: ["卫星互联网"], changePct: 1 },
          { code: "000202", name: "昨日前排二", sector: "商业航天", concepts: ["卫星互联网"], changePct: -1 },
        ],
      },
      yesterdayBroken: { strength: "修复中" },
    },
    marketHistory: {
      days: [{
        date: "2026-07-09",
        market: { limitUpStocks: [{ code: "000301", name: "旧龙头", sector: "旧主线", concepts: [] }] },
        flows: { industry: [{ name: "旧主线", amount: 500 }], concept: [] },
        structure: { mainline: [{ name: "旧主线" }] },
        diagnosis: { score: 1, tone: "分化谨慎" },
      }],
    },
  };
  diagnosisSample.marketStructure = analyzeMarketStructure(diagnosisSample);
  diagnosisSample.market.marketStructure = diagnosisSample.marketStructure;
  const diagnosis = buildDiagnosis(diagnosisSample);
  const regime = buildQuantRegime(diagnosisSample);
  if (diagnosis.tone !== "高波动分化") throw new Error("综合诊断自检失败：极端分化样例未识别");
  if (regime.state !== diagnosis.tone) throw new Error("综合诊断自检失败：市场总结与量化环境不一致");
  if (!diagnosisSample.marketStructure.mainline.some((row) => row.name === "商业航天")) throw new Error("市场结构自检失败：主线未识别");
  if (!diagnosisSample.marketStructure.interSectorSwitch) throw new Error("市场结构自检失败：板块间切换未识别");
  const legacyKey = "high" + "Low" + "Switches";
  const sanitizedStructure = sanitizeLegacyStructureFields({
    structure: { mainline: [{ name: "保留主线" }], [legacyKey]: ["废弃数据"] },
  });
  if (legacyKey in sanitizedStructure.structure || sanitizedStructure.structure.mainline[0].name !== "保留主线") {
    throw new Error("市场结构自检失败：旧缓存字段未正确清理");
  }
  if (average([null, undefined, 10]) !== 10) throw new Error("历史均值自检失败：空值被错误计为0");
  const validRow = (code, name, changePct) => ({ code, name, changePct, amountYi: 1 });
  const validationSample = {
    index: { tradeDate: "2026-07-10" },
    market: {
      tradeDate: "2026-07-10",
      stockCount: 2,
      upCount: 1,
      downCount: 1,
      flatCount: 0,
      limitUpCount: 1,
      limitDownCount: 1,
      brokenCount: 1,
      touchedLimitCount: 2,
      brokenRate: 50,
      limitUpStocks: [validRow("000001", "涨停样例", 10)],
      limitDownStocks: [validRow("000002", "跌停样例", -10)],
      brokenStocks: [validRow("000005", "炸板样例", 3)],
      yesterdayLimitUp: { count: 1, limitUpCount: 1, positiveRate: 100, stocks: [validRow("000003", "延续样例", 10)] },
      yesterdayBroken: { count: 1, limitUpCount: 0, positiveRate: 100, stocks: [validRow("000004", "修复样例", 2)] },
    },
    marketStructure: { mainline: [{ name: "测试主线", limitUpCount: 1 }], subline: [] },
  };
  const validation = validateMarketData(validationSample);
  if (validation.status !== "ok") throw new Error("数据校验自检失败：完整样例未通过");
  validationSample.market.yesterdayBroken.count = 2;
  const mismatchValidation = validateMarketData(validationSample);
  if (!mismatchValidation.errors.some((message) => message.includes("昨日炸板统计共2只"))) {
    throw new Error("数据校验自检失败：昨日炸板数量差异未识别");
  }
  const policyDate = `${todayLocal()} 10:00:00`;
  const domesticPolicySample = normalizePolicyNewsItem({
    title: "国务院批复《扩大消费“十五五”规划》",
    content: "规划部署扩大内需和服务消费政策。",
    mediaName: "中国政府网",
    url: "https://example.com/domestic-policy",
    date: policyDate,
  }, {scope: "domestic", keyword: "十五五"});
  if (!domesticPolicySample || !domesticPolicySample.plans.includes("十五五")) throw new Error("政策新闻自检失败：权威规划政策未入选");
  const domesticNoiseSample = normalizePolicyNewsItem({
    title: "某公司发布业绩预告，预计净利润增长",
    content: "公司表示业务符合十五五人工智能规划方向。",
    mediaName: "财经资讯",
    url: "https://example.com/company-noise",
    date: policyDate,
  }, {scope: "domestic", keyword: "十五五"});
  if (domesticNoiseSample) throw new Error("政策新闻自检失败：公司业绩噪声未剔除");
  const globalPolicySample = normalizePolicyNewsItem({
    title: "美联储发布利率决议并宣布降息",
    content: "美联储发布最新利率决议。",
    mediaName: "新华社",
    url: "https://example.com/global-policy",
    date: policyDate,
  }, {scope: "international", keyword: "美联储 利率决议"});
  if (!globalPolicySample || !globalPolicySample.themes.includes("全球利率")) throw new Error("政策新闻自检失败：国际关键事件未入选");
  const globalOpinionSample = normalizePolicyNewsItem({
    title: "非农数据落地后，港股如何交易美国流动性变化？",
    content: "美联储利率预期出现变化。",
    mediaName: "财经资讯",
    url: "https://example.com/global-opinion",
    date: policyDate,
  }, {scope: "international", keyword: "美联储 利率决议"});
  if (globalOpinionSample) throw new Error("政策新闻自检失败：交易观点噪声未剔除");
  const emptyBacktests = buildStrategyBacktests([]);
  if (emptyBacktests.length !== QUANT_SIGNAL_ORDER.length * QUANT_BACKTEST_HORIZONS.length || emptyBacktests.some((item) => item.samples !== 0)) {
    throw new Error("量化回测自检失败：空样本矩阵结构不正确");
  }
  if (!emptyBacktests.some((item) => item.horizon === 30)) {
    throw new Error("量化回测自检失败：缺少30日均值周期");
  }
  const crossCheck = buildIndexCrossCheck(
    {tradeDate: "2026-07-15", preClose: 3000, source: "主源", points: [{price: 3030}]},
    {tradeDate: "2026-07-15", preClose: 3000, source: "备用源", points: [{price: 3030.6}]},
  );
  if (crossCheck.status !== "ok") throw new Error("指数双源自检失败：允许偏差内样本未通过");
  const runtime = buildMainPageRuntimeScript();
  const countMatches = (pattern) => (runtime.match(pattern) || []).length;
  if (/tdx:\/\/sector/i.test(runtime)) throw new Error("前端自检失败：仍存在依赖发送电脑注册协议的板块跳转");
  if (!runtime.includes("local-stock-link") || !runtime.includes('return "/stock-open?code="')) {
    throw new Error("前端自检失败：板块日K没有统一走接收设备本机服务");
  }
  if (countMatches(/timeRange\.addEventListener\("input"/g) !== 1) throw new Error("前端自检失败：时间轴监听不是唯一实例");
  if (countMatches(/syncMarketButton\.addEventListener/g) !== 1) throw new Error("前端自检失败：同步按钮监听不是唯一实例");
  if (countMatches(/function scheduleAutoReload/g) !== 1) throw new Error("前端自检失败：自动刷新函数不是唯一实例");
  console.log("自检通过：指数双源与财联社原始盘面标注、政策新闻事件链、涨跌停板块排序、A股股票池、五种通达信战法与历史回测矩阵、统一市场判断、结构化历史、数据一致性、请求锁与唯一计时器");
}

async function runQuantSmoke() {
  const expectedDate = force ? null : expectedMarketDate();
  if (startCompass) log("已取消活跃市值：量化选股不再启动或读取指南针。");
  let index = null;
  try {
    index = await fetchIndex();
  } catch (error) {
    if (!expectedDate) throw error;
    log(`量化选股：上证指数接口暂不可用，使用目标交易日 ${expectedDate} 继续扫描股票。`);
    index = {
      name: "上证指数",
      code: "000001",
      tradeDate: expectedDate,
      preClose: null,
      points: [{ time: "15:00", minute: 239, price: null }],
      fetchWarning: error.message,
    };
  }
  if (expectedDate && index.tradeDate !== expectedDate) {
    throw new Error(`上证指数日期不是今天：${index.tradeDate}，等待 ${expectedDate}`);
  }
  if (expectedDate && !index.fetchWarning && (index.points.at(-1)?.minute ?? -1) < 238) {
    const latestIndexTime = index.points.at(-1)?.time || "--";
    index.quantWarning = `上证指数分时仅到 ${latestIndexTime}，本次为盘中实时扫描结果，收盘后会自动补全。`;
    log(`量化选股：${index.quantWarning}`);
  }
  const marketData = loadLatestMarketDataForQuant(index);
  const data = await buildQuantSelection(marketData);
  log(`量化选股完成：股票池 ${data.universeCount}，扫描 ${data.scannedCount}，正式 ${data.formalCount}，观察 ${data.watchCount}`);
  if (!dryRun) {
    writeQuantHtml(data);
    syncOptimizedDesktopApp(marketData, data);
  }
}

async function runMarketDataTest() {
  const tradeDate = expectedMarketDate();
  const [currentBrokenPool, yesterdayBroken, breadth] = await Promise.all([
    Promise.resolve().then(() => safeZtbPool("broken", tradeDate)),
    Promise.resolve().then(() => safeYesterdayBrokenRepair(tradeDate, { intraday: true })),
    fetchMarketBreadth(tradeDate),
  ]);
  const currentBrokenStocks = normalizeLimitPoolRows(currentBrokenPool, "broken");
  if (!Number.isFinite(Number(currentBrokenPool.total)) || Number(currentBrokenPool.total) !== currentBrokenStocks.length) {
    throw new Error(`当日炸板数据测试失败：汇总${currentBrokenPool.total}只，详情${currentBrokenStocks.length}只`);
  }
  if (currentBrokenPool.qdate !== tradeDate) {
    throw new Error(`当日炸板数据测试失败：专题池日期${currentBrokenPool.qdate}，目标交易日${tradeDate}`);
  }
  const limitUpPool = safeZtbPool("limitUp", tradeDate);
  const currentBrokenStats = calculateBrokenBoardStats(limitUpPool.total, currentBrokenPool.total);
  if (currentBrokenStats.touchedLimitCount !== Number(limitUpPool.total) + Number(currentBrokenPool.total) ||
      currentBrokenStats.brokenRate !== round1((Number(currentBrokenPool.total) / currentBrokenStats.touchedLimitCount) * 100)) {
    throw new Error(`当日炸板公式测试失败：${JSON.stringify(currentBrokenStats)}`);
  }
  const detailCount = Array.isArray(yesterdayBroken.stocks) ? yesterdayBroken.stocks.length : 0;
  if (!detailCount || Number(yesterdayBroken.count) !== detailCount) {
    throw new Error(`昨日炸板数据测试失败：汇总${yesterdayBroken.count}只，详情${detailCount}只`);
  }
  if (!String(yesterdayBroken.summary || "").includes(`炸板${detailCount}家`) || /^涨停\d+\//.test(String(yesterdayBroken.summary || ""))) {
    throw new Error(`昨日炸板显示测试失败：摘要没有明确展示炸板总数，当前为“${yesterdayBroken.summary || "空"}”`);
  }
  const missingIdentity = yesterdayBroken.stocks.filter((row) => !/^\d{6}$/.test(String(row.code || "")) || !row.name).length;
  if (missingIdentity) throw new Error(`昨日炸板数据测试失败：${missingIdentity}条缺少代码或名称`);
  const uniqueCodes = new Set(yesterdayBroken.stocks.map((row) => String(row.code || "")));
  if (uniqueCodes.size !== detailCount) throw new Error(`昨日炸板数据测试失败：存在${detailCount - uniqueCodes.size}条重复代码`);
  const invalidQuotes = yesterdayBroken.stocks.filter((row) => !(Number(row.price) > 0) || !(Number(row.preClose) > 0) ||
    !Number.isFinite(Number(row.changePct)) || row.quoteDate !== tradeDate);
  if (invalidQuotes.length) throw new Error(`昨日炸板数据测试失败：${invalidQuotes.length}条不是${tradeDate}完整实时行情`);
  const inconsistentQuotes = yesterdayBroken.stocks.filter((row) =>
    Math.abs(((Number(row.price) - Number(row.preClose)) / Number(row.preClose)) * 100 - Number(row.changePct)) > 0.35);
  if (inconsistentQuotes.length) throw new Error(`昨日炸板数据测试失败：${inconsistentQuotes.length}条价格与涨跌幅不一致`);
  console.log(JSON.stringify({
    ok: true,
    tradeDate,
    currentBroken: {
      reportedCount: currentBrokenPool.total,
      detailCount: currentBrokenStocks.length,
      touchedLimitCount: currentBrokenStats.touchedLimitCount,
      brokenRate: currentBrokenStats.brokenRate,
      source: "东方财富涨停专题当日炸板池",
    },
    source: yesterdayBroken.source,
    reportedCount: yesterdayBroken.count,
    detailCount,
    quotedCount: yesterdayBroken.quotedCount,
    breadth,
  }));
}

async function runPolicyNewsSmoke() {
  const data = await buildPolicyNewsData({forceRefresh: true, persist: false});
  const domestic = data.items.filter((item) => item.scope === "domestic");
  const international = data.items.filter((item) => item.scope === "international");
  const excludedNoise = data.items.filter((item) => /业绩预告|归属于上市公司股东|个股推荐|如何布局|龙虎榜|主力资金/.test(`${item.title} ${item.summary}`));
  if (domestic.length < 4) throw new Error(`政策新闻自检失败：国内有效条目只有 ${domestic.length} 条`);
  if (international.length < 3) throw new Error(`政策新闻自检失败：国际有效条目只有 ${international.length} 条`);
  const missingPlans = POLICY_PLAN_REFERENCES.filter((plan) => !domestic.some((item) => item.foundation && item.plans.includes(plan.id)));
  if (missingPlans.length) throw new Error(`政策新闻自检失败：缺少${missingPlans.map((plan) => plan.id).join("、")}官方规划基准`);
  if (data.stats.foundationCount < POLICY_PLAN_FOUNDATION_NEWS.length) throw new Error(`政策新闻自检失败：官方规划基准只有 ${data.stats.foundationCount} 条`);
  if (data.items.some((item, index) => index > 0 && Number(data.items[index - 1].publishedMs) < Number(item.publishedMs))) throw new Error("政策新闻自检失败：未按发布时间从新到旧排序");
  if (excludedNoise.length) throw new Error(`政策新闻自检失败：仍有无效新闻 ${excludedNoise.map((item) => item.title).join("；")}`);
  if (policyOutputPath) writeUtf8File(policyOutputPath, JSON.stringify(data, null, 2));
  console.log(JSON.stringify({
    ok: true,
    generatedAt: data.generatedAt,
    status: data.status,
    stats: data.stats,
    domestic: domestic.map((item) => ({title: item.title, source: item.source, plans: item.plans, themes: item.themes, score: item.score})),
    international: international.map((item) => ({title: item.title, source: item.source, themes: item.themes, score: item.score})),
  }, null, 2));
}

async function runBoardFlowSmoke() {
  const tradeDate = expectedMarketDate();
  const rows = await fetchBoardRows("m:90+s:4");
  const row = rows.find((item) => item.code === "BK0459") || [...rows].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
  if (!row) throw new Error("板块分钟资金实测失败：没有取得行业板块排名");
  const index = await fetchIndex({ preferTencent: false });
  const sampleMinute = latestTradeMinuteFromIndex(index);
  if (index.tradeDate !== tradeDate) throw new Error(`板块分钟资金实测失败：指数日期 ${index.tradeDate}，目标日期 ${tradeDate}`);
  const timeline = await fetchBoardFlowTimeline(row, tradeDate, sampleMinute, nowText());
  const latest = timeline.points.at(-1);
  console.log(JSON.stringify({
    ok: true,
    tradeDate,
    code: row.code,
    name: row.name,
    rankingAmountYi: row.amount,
    minuteAmountYi: latest.amount,
    differenceYi: round2(Math.abs(latest.amount - row.amount)),
    pointCount: timeline.points.length,
    firstTime: timeline.points[0]?.time,
    latestTime: latest.time,
    source: "东方财富官方板块分钟资金",
    routeIp: preferredPush2Ip || "system",
  }, null, 2));
}

async function runPolicyNewsOnly() {
  const data = await buildPolicyNewsData({forceRefresh: policyNewsForce});
  if (!data.items.length) throw new Error("政策新闻没有通过筛选的有效条目，保留现有数据文件");
  const target = path.join(CONFIG.optimizedAppDir, "data", "policy-news.json");
  let eventCount = 0;
  if (!dryRun) {
    writeUtf8File(target, JSON.stringify(data));
    const upgraded = enhanceAppData({
      appDir: CONFIG.optimizedAppDir,
      archiveDir: CONFIG.structuredHistoryDir,
      legacyArchiveDir: CONFIG.dailyArchiveDir,
    });
    eventCount = upgraded.eventCount || 0;
  }
  log(`政策新闻更新完成：国内 ${data.stats.domesticCount} 条，国际 ${data.stats.internationalCount} 条，关键事件链 ${eventCount} 条；${target}`);
}

async function main() {
  if (selfTest) {
    runQuantSelfTest();
    return;
  }
  if (dataTestMode) {
    await runMarketDataTest();
    return;
  }
  if (policyNewsSmoke) {
    await runPolicyNewsSmoke();
    return;
  }
  if (flowSmoke) {
    await runBoardFlowSmoke();
    return;
  }
  if (policyNewsOnlyMode) {
    await runPolicyNewsOnly();
    return;
  }
  if (prepareAmvMode) {
    ensureDir(CONFIG.workDir);
    log("活跃市值已取消：无需准备 0AMV 数据源。");
    return;
  }
  if (quantOnlyMode) {
    await runQuantSmoke();
    return;
  }
  if (injectButtonsOnly) {
    injectQuantButtonsOnly();
    return;
  }
  ensureDir(CONFIG.workDir);
  log(`开始自动更新${intradayMode ? "（盘中）" : ""}${dryRun ? "（演练）" : ""}${force ? "（不校验今天日期）" : ""}`);
  if (!force) {
    const day = new Date().getDay();
    if (day === 0 || day === 6) {
      log("今天不是工作日，自动跳过。");
      return;
    }
  }
  if (startCompass) log("已忽略 --start-compass：当前策略禁止自动启动指南针。");
  const deadline = Date.now() + CONFIG.maxWaitMinutes * 60 * 1000;
  for (;;) {
    try {
      await generateOnce();
      return;
    } catch (error) {
      log(`本轮未完成：${error.message}`);
      if (!waitMode || Date.now() >= deadline) throw error;
      log(`等待 ${CONFIG.retryIntervalSeconds} 秒后重试。`);
      await sleep(CONFIG.retryIntervalSeconds * 1000);
    }
  }
}

main().catch((error) => {
  log(`自动更新失败：${error.stack || error.message}`);
  process.exitCode = 1;
});
