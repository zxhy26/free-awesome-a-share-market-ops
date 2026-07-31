const fs = require("fs");
const path = require("path");

const DATASET_FILES = Object.freeze({
  market: "market.json",
  indices: "indices.json",
  sectors: "sectors.json",
  stocks: "stocks.json",
  analysis: "analysis.json",
  policyNews: "policy-news.json",
});

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum = 0, maximum = 100) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function round(value, digits = 1) {
  const number = finite(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function unique(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function compactDetail(value, maximum = 220) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  text = text.split(/；Command failed:|Command failed:|Invoke-WebRequest\s*:/)[0].trim();
  text = text.replace(/https?:\/\/\S+/g, "备用接口");
  if (text.length > maximum) text = `${text.slice(0, maximum).replace(/[；，,\s]+$/g, "")}。`;
  return text;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (_) {
    fs.copyFileSync(temporaryPath, filePath);
    fs.unlinkSync(temporaryPath);
  }
}

function latestMinute(points) {
  const values = (points || []).map((point) => finite(point?.minute)).filter((value) => value !== null);
  return values.length ? Math.max(0, Math.min(240, Math.max(...values))) : 0;
}

function minuteText(minute) {
  const bounded = Math.max(0, Math.min(240, Number(minute) || 0));
  const minuteOfDay = bounded <= 120 ? 570 + bounded : 780 + bounded - 120;
  const totalSeconds = Math.round(minuteOfDay * 60);
  const hour = Math.floor(totalSeconds / 3600);
  const minutePart = Math.floor((totalSeconds % 3600) / 60);
  const secondPart = totalSeconds % 60;
  return `${String(hour).padStart(2, "0")}:${String(minutePart).padStart(2, "0")}:${String(secondPart).padStart(2, "0")}`;
}

function marketPhase(tradeDate, minute, now = new Date()) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (tradeDate !== today) return "历史数据";
  const current = now.getHours() * 60 + now.getMinutes();
  if (current < 555) return "盘前";
  if (current < 570) return "集合竞价";
  if (current <= 690) return "上午交易";
  if (current < 780) return "午间休市";
  if (current <= 900) return "下午交易";
  return minute >= 240 ? "已收盘" : "收盘数据待确认";
}

function moduleResult(key, label, completeness, details = {}) {
  const warnings = unique(details.warnings);
  const errors = unique(details.errors);
  const status = errors.length ? "error" : warnings.length ? "warning" : completeness >= 98 ? "ok" : "warning";
  return {
    key,
    label,
    status,
    completeness: round(clamp(completeness), 1),
    tradeDate: details.tradeDate || "",
    syncedAt: details.syncedAt || "",
    sources: unique(details.sources),
    sample: details.sample || {},
    checks: details.checks || [],
    warnings,
    errors,
  };
}

function crossCheckResult(key, label, status, detail, values = {}) {
  return {key, label, status, detail: compactDetail(detail), values};
}

function boardTimelineHealth(group, expectedMinute) {
  const rows = Array.isArray(group?.rows) ? group.rows : [];
  const withSeries = rows.filter((row) => Array.isArray(row.points) && row.points.length);
  const current = withSeries.filter((row) => latestMinute(row.points) >= Math.max(0, expectedMinute - 3));
  const early = withSeries.filter((row) => {
    const first = finite(row.points?.[0]?.minute);
    return first !== null && first <= 5;
  });
  const validated = rows.filter((row) => row.flowValidated === true);
  const rankingMatches = rows.filter((row) => {
    const last = row.points?.at?.(-1);
    const amount = finite(row.amount);
    const lastAmount = finite(last?.amount);
    if (amount === null || lastAmount === null) return false;
    const tolerance = expectedMinute >= 238 ? Math.max(1, Math.abs(amount) * .015) : Math.max(5, Math.abs(amount) * .08);
    return Math.abs(amount - lastAmount) <= tolerance;
  });
  const reconciliation = group?.flowReconciliation && typeof group.flowReconciliation === "object"
    ? group.flowReconciliation
    : {};
  const reconciliationChecked = Math.max(0, Number(reconciliation.checked) || 0);
  const reconciliationCorrected = Math.max(0, Number(reconciliation.corrected) || 0);
  const reconciliationMatchedAfter = Math.max(0, Number(reconciliation.matchedAfter) || 0);
  const coverage = rows.length ? ((current.length + early.length + rankingMatches.length) / (rows.length * 3)) * 100 : 0;
  return {
    rows,
    withSeries,
    current,
    early,
    validated,
    rankingMatches,
    reconciliation,
    reconciliationChecked,
    reconciliationCorrected,
    reconciliationMatchedAfter,
    coverage,
  };
}

function buildUnifiedRegime(data) {
  const diagnosis = data.analysis?.diagnosis || {};
  const structure = data.analysis?.structure || {};
  const market = data.market?.market || {};
  const indexBreadth = diagnosis.indexBreadth || {};
  const flowBalance = diagnosis.flowBalance || {};
  const mainline = (structure.mainline || []).map((item) => item.name).filter(Boolean);
  const subline = (structure.subline || []).map((item) => item.name).filter(Boolean);
  const basis = [
    `涨停${finite(market.limitUpCount) ?? "--"}家、跌停${finite(market.limitDownCount) ?? "--"}家`,
    finite(market.totalAmountYi) === null ? "成交额待同步" : `成交额${round(market.totalAmountYi, 1)}亿元`,
    finite(indexBreadth.averagePct) === null ? "宽基指数数据不足" : `主要宽基平均${round(indexBreadth.averagePct, 2)}%`,
    finite(flowBalance.ratio) === null ? "资金流入流出比待确认" : `板块资金流入/流出比${round(flowBalance.ratio, 2)}`,
    mainline.length ? `主线${mainline.join("、")}` : "主线待确认",
    subline.length ? `支线${subline.join("、")}` : "支线待确认",
  ];
  return {
    version: 1,
    tradeDate: data.analysis?.tradeDate || data.market?.tradeDate || "",
    generatedAt: data.analysis?.syncedAt || data.market?.syncedAt || "",
    state: diagnosis.tone || "数据不足",
    score: finite(diagnosis.score),
    observation: diagnosis.observation || "关键数据不足，暂不确认市场阶段。",
    historyDaysUsed: finite(diagnosis.historyDaysUsed) || finite(structure.historyDaysUsed) || 0,
    mainline,
    subline,
    interSectorSwitch: Boolean(structure.interSectorSwitch),
    interSectorText: structure.interSectorText || "",
    basis,
    text: `${diagnosis.tone || "数据不足"}：${basis.join("；")}。${diagnosis.observation || ""}`.trim(),
  };
}

function newsEventType(item) {
  if (item.foundation) return "规划基准";
  if (item.scope === "international") return "国际与地缘";
  if ((item.plans || []).length) return "国内政策";
  return "国内消息";
}

function newsConfidence(item) {
  const official = /国务院|中国政府网|新华社|国家发展改革委|中国人民银行|财政部|商务部|证监会|全国人大/.test(`${item.source || ""}${item.url || ""}`);
  const score = clamp(40 + (finite(item.importance) || 0) * 8 + (official ? 16 : 0) + (item.url ? 4 : 0));
  return {score: round(score, 0), label: score >= 82 ? "高" : score >= 64 ? "中" : "待核验"};
}

function eventExpiry(item) {
  if (item.foundation) return {expiresAt: "长期基准", impactWindowDays: 3650};
  const type = newsEventType(item);
  const days = type === "国内政策" ? 30 : type === "国际与地缘" ? 5 : 7;
  const published = Date.parse(String(item.publishedAt || "").replace(" ", "T") + "+08:00");
  if (!Number.isFinite(published)) return {expiresAt: "待确认", impactWindowDays: days};
  return {expiresAt: new Date(published + days * 86400000).toISOString().slice(0, 10), impactWindowDays: days};
}

function termsMatch(left, right) {
  const a = String(left || "").replace(/[ⅡⅢIV\s]/g, "").toLowerCase();
  const b = String(right || "").replace(/[ⅡⅢIV\s]/g, "").toLowerCase();
  return a && b && (a.includes(b) || b.includes(a));
}

function linkedStocksForEvent(item, quantRows) {
  const eventTerms = unique([...(item.sectors || []), ...(item.themes || [])]);
  return (quantRows || []).filter((row) => {
    const stockTerms = unique([row.sector, ...(row.concepts || [])]);
    return eventTerms.some((eventTerm) => stockTerms.some((stockTerm) => termsMatch(eventTerm, stockTerm)));
  }).slice(0, 8).map((row) => ({code: row.code, market: row.market, name: row.name, sector: row.sector, signals: row.signals || []}));
}

const EVENT_CHAIN_PROFILES = Object.freeze([
  {
    key: "全球利率",
    pattern: /全球利率|美联储|欧洲央行|日本央行|利率决议|通胀|非农|美债收益率/,
    directVariable: "政策利率预期先影响美元指数、美债收益率和全球流动性定价",
    industryImpact: "贴现率、人民币汇率和跨市场风险偏好变化，随后影响成长估值、银行息差预期与黄金定价",
    positivePath: "降息或收益率回落时，成长估值和黄金通常更容易获得边际支撑",
    negativePath: "加息预期或收益率上行时，高估值方向承压，汇率与外资风险偏好需要同步观察",
    verification: ["美元指数与美国10年期国债收益率同向确认", "人民币汇率和A股成长/价值风格强弱切换", "相关板块资金排名至少连续两个观察时点改善"],
    invalidation: "后续通胀、就业数据或央行指引反向修正当前利率路径",
  },
  {
    key: "贸易与关税",
    pattern: /贸易与关税|开放与贸易|关税|出口管制|反倾销|实体清单|WTO|外贸/,
    directVariable: "关税税率、管制范围和豁免清单直接改变出口价格、订单可得性与进口成本",
    industryImpact: "企业利润率和供应链布局先调整，再传导至出口订单、国产替代、跨境物流和稀缺资源议价",
    positivePath: "豁免、撤销限制或贸易协议落地，有利于订单和风险溢价修复；国产替代方向仍需订单验证",
    negativePath: "加征关税、扩大管制或制裁升级，会压低受限产品订单并抬高供应链重构成本",
    verification: ["海关订单、企业排产或行业出口数据出现变化", "人民币汇率、集装箱运价和出口链板块资金同步", "受影响公司公告披露客户、区域收入或替代订单变化"],
    invalidation: "措施未正式生效、覆盖范围显著收窄，或企业通过转口和本地化生产消化影响",
  },
  {
    key: "全球能源",
    pattern: /全球能源|能源资源安全|OPEC|欧佩克|原油|天然气|霍尔木兹|油气|煤炭/,
    directVariable: "产量政策、运输安全和库存变化先作用于原油、天然气及煤炭价格",
    industryImpact: "上游盈利、油服资本开支、炼化价差、航运费率和下游原料成本依次重估，并影响通胀预期",
    positivePath: "供给收紧或运输受阻时，上游资源和部分运输环节可能受益于价格及运价上行",
    negativePath: "能源成本快速上升会挤压航空、化工下游、制造业和消费环节利润；供给恢复则压低上游溢价",
    verification: ["布伦特原油、天然气和相关期货价格持续而非脉冲波动", "油服订单、炼化价差、港口库存和航运费率同步变化", "石油石化、煤炭、化工和航运板块资金出现方向分化"],
    invalidation: "产量执行不及预期、库存快速回补、运输通道恢复或需求端明显走弱",
  },
  {
    key: "地缘冲突",
    pattern: /地缘冲突|中东|俄乌|冲突|停火|袭击|红海|战争|制裁/,
    directVariable: "冲突升级或缓和先改变避险溢价、能源运输安全和国际贸易路径",
    industryImpact: "黄金与油气价格、保险和航运费率先反应，再影响军工预期、输入性成本和全球风险偏好",
    positivePath: "局势升级通常强化黄金、油气、军工和部分航运的风险溢价；停火则有利于风险偏好与成本回落",
    negativePath: "升级会压制高风险资产并抬高进口和运输成本；缓和会使纯避险交易快速退潮",
    verification: ["黄金、原油、航运费率与全球波动率是否共同确认", "事件是否由官方或多方权威来源交叉确认", "A股相关板块资金与期货价格方向是否一致"],
    invalidation: "停火协议落实、运输恢复，或市场价格没有对事件升级作出持续反应",
  },
  {
    key: "全球科技规则",
    pattern: /全球科技规则|科技规则|芯片出口|AI芯片|半导体限制|先进制程|数据跨境/,
    directVariable: "许可、禁售和技术标准先改变高端芯片、设备、材料及软件工具的可获得性",
    industryImpact: "受限环节库存和交付周期变化，继而影响国产替代采购、研发投入和下游算力建设节奏",
    positivePath: "限制放松有利于供应恢复；限制加码时，具备真实替代能力和新增订单的本土环节可能获得机会",
    negativePath: "关键设备或芯片断供会推迟扩产和交付，仅有题材但没有验证订单的公司风险更高",
    verification: ["管制文本、产品清单和生效日期得到官方确认", "设备招标、晶圆厂资本开支和算力项目采购出现对应变化", "半导体设备、材料、算力板块资金与订单公告相互验证"],
    invalidation: "许可证获得豁免、库存足以跨越限制期，或国产替代没有形成可量化订单",
  },
  {
    key: "全球增长",
    pattern: /全球增长|全球经济|全球贸易|制造业PMI|经济衰退|IMF|世界银行|OECD/,
    directVariable: "增长预测和PMI先改变外需、库存周期与大宗商品需求预期",
    industryImpact: "出口订单、工业品价格和国际货量变化，再传导至有色、机械、航运和出口制造盈利",
    positivePath: "增长或PMI上修时，顺周期、出口和运输需求预期可能改善",
    negativePath: "增长下修或新订单收缩时，周期品价格和出口企业排产容易承压",
    verification: ["主要经济体PMI新订单、工业生产和零售数据连续确认", "铜等工业品价格、BDI或集运价格与事件方向一致", "A股周期和出口板块成交额及资金排名同步改善"],
    invalidation: "后续高频数据与预测相反，或政策刺激迅速改变需求预期",
  },
  {
    key: "金融与资本市场",
    pattern: /金融与资本市场|资本市场|货币政策|降准|降息|并购重组|长期资金|财政金融/,
    directVariable: "货币、财政或资本市场规则先改变资金成本、信用供给和风险偏好",
    industryImpact: "银行负债与息差、券商成交和投行业务、保险资产端及高股息估值随后重估",
    positivePath: "流动性改善、长期资金入市或交易制度优化，有利于成交活跃和金融板块预期修复",
    negativePath: "信用需求不足、监管收紧或利差继续压缩，可能削弱政策对金融盈利的实际传导",
    verification: ["资金利率、信贷社融和人民币汇率是否配合", "全市场成交额、两融和金融板块资金是否连续改善", "政策细则、实施日期及机构业务数据是否落地"],
    invalidation: "政策只有表态而无资金或制度细则，或信用和成交数据继续走弱",
  },
  {
    key: "扩大内需",
    pattern: /扩大内需|扩大消费|促消费|以旧换新|服务消费|消费补贴|统一大市场/,
    directVariable: "补贴额度、适用范围和消费限制调整先改变居民购买成本与消费意愿",
    industryImpact: "终端销量和客流改善后，依次传导至渠道库存、企业排产、零部件订单和品牌利润率",
    positivePath: "补贴兑现、覆盖扩围且终端销量改善时，家电、汽车、零售和服务消费更可能受益",
    negativePath: "需求被提前透支、补贴到账慢或价格战加剧，会削弱收入和利润的实际改善",
    verification: ["补贴资金、申领规则和地方执行细则明确", "零售额、乘用车/家电销量及渠道库存改善", "消费板块资金、龙头成交和盈利预期同步上修"],
    invalidation: "销量仅短期冲高、渠道继续去库存，或企业以降价完全抵消补贴效果",
  },
  {
    key: "科技自立",
    pattern: /科技自立|新质生产力|人工智能|算力|集成电路|半导体|量子|机器人|6G|低空经济/,
    directVariable: "专项规划、财政资金、标准和采购目录先确定技术路线与投入节奏",
    industryImpact: "研发投入和基础设施建设形成设备、芯片、软件与应用订单，再传导至收入和产能利用率",
    positivePath: "资金、项目和采购清单同步落地时，具备产品交付和订单能力的核心环节更容易兑现",
    negativePath: "只有概念规划而缺少预算、订单或商业化场景时，估值可能先行后回落",
    verification: ["预算、招标、项目清单和产业标准出现明确增量", "核心公司订单、合同负债、资本开支或产能利用率改善", "科技板块资金扩散与成交持续性优于单日脉冲"],
    invalidation: "项目延期、预算下调、技术路线变化，或订单和收入连续未兑现",
  },
  {
    key: "现代产业体系",
    pattern: /现代产业体系|先进制造|新型工业化|设备更新|智能制造|高端装备|国产替代/,
    directVariable: "设备更新、国产化率和产业升级目标先改变制造企业资本开支计划",
    industryImpact: "项目招标和设备订单传导至机床、自动化、关键零部件、电子和基础材料需求",
    positivePath: "补贴、贷款和首台套采购形成真实招标时，设备及零部件订单有望改善",
    negativePath: "制造业需求弱、企业现金流不足或更新周期延后，会造成政策到订单的传导折损",
    verification: ["设备更新资金、贴息和采购目录正式落地", "制造业固定资产投资、机床产量和企业订单改善", "机械设备及关键零部件板块资金和成交同步"],
    invalidation: "企业资本开支没有增加、招标持续延期，或进口替代率未改善",
  },
  {
    key: "绿色能源",
    pattern: /绿色能源|双碳|碳达峰|碳中和|储能|光伏|风电|氢能|核电|绿色低碳/,
    directVariable: "装机目标、消纳规则、电价机制和补贴政策先改变项目收益率",
    industryImpact: "项目收益率决定开工和招标，随后传导至设备订单、材料需求、产能利用率与库存",
    positivePath: "收益机制改善且招标放量时，设备、储能、电网和资源材料环节可能受益",
    negativePath: "产能过剩、价格战、消纳受限或补贴拖欠会抵消装机增长对利润的贡献",
    verification: ["新增装机、招标量、利用小时和电网投资同步改善", "产业链价格与库存止跌，龙头排产上修", "相关板块资金从单一环节向产业链扩散"],
    invalidation: "项目内部收益率下降、并网消纳受限，或招标增长但价格和利润继续下滑",
  },
  {
    key: "医药健康",
    pattern: /医药健康|健康中国|创新药|生物医药|中医药|医疗器械|医保|医疗服务/,
    directVariable: "审批、医保支付、集采规则和研发支持先改变产品准入与商业化回报",
    industryImpact: "研发进度和支付条件传导至获批节奏、院内放量、器械采购及企业现金流",
    positivePath: "审批提速、支付改善和采购放量，有利于具备管线、产品和渠道优势的企业",
    negativePath: "集采降价、研发失败、支付约束或合规收紧会压低盈利和估值",
    verification: ["正式政策条款、适用品种和执行时间明确", "受理获批、医保谈判、医院采购或销售数据出现增量", "医药细分板块资金与公司公告交叉确认"],
    invalidation: "政策覆盖范围有限、产品未进入目录，或销量增长不足以抵消价格下降",
  },
  {
    key: "农业与粮食安全",
    pattern: /农业与粮食安全|粮食安全|乡村振兴|种业|高标准农田|生物育种|农产品/,
    directVariable: "种植补贴、品种审定、耕地建设和收储政策先改变面积、单产与农户收益预期",
    industryImpact: "种植计划传导至种子、农机、化肥和养殖成本，农产品价格再影响产业链利润",
    positivePath: "补贴扩围、品种放量或农产品价格改善，有利于种业、种植和农资需求",
    negativePath: "极端天气、疫病、成本上升或产品价格下跌会压缩种养殖利润",
    verification: ["中央和地方实施细则、审定目录或收储价格落地", "播种面积、种子销量、农产品价格和库存变化", "农业板块资金与期货价格、公司销量公告一致"],
    invalidation: "政策执行弱于预期、价格回落，或实际种植面积和销量没有增长",
  },
  {
    key: "基础设施与城市更新",
    pattern: /基础设施与城市更新|新型基础设施|城市更新|水网|交通强国|数据中心|重大工程/,
    directVariable: "专项债、中央预算和项目清单先决定工程开工及资金到位速度",
    industryImpact: "开工传导至设计施工、工程机械、建材、轨交或通信设备订单和回款",
    positivePath: "资金和项目同时落地时，施工、设备与材料需求有望形成连续订单",
    negativePath: "项目资本金不足、地方回款慢或开工延后，会削弱订单到利润的兑现",
    verification: ["专项债投向、项目批复、招标和开工数据连续增加", "工程机械销量、水泥钢材需求或通信设备订单改善", "基建链板块资金与企业合同、回款公告同步"],
    invalidation: "资金未到位、项目停留在规划阶段，或新增订单没有带来现金流改善",
  },
  {
    key: "能源资源安全",
    pattern: /能源资源安全|战略性矿产|稀土|资源安全|油气勘探|石油储备/,
    directVariable: "储备、勘探、开采配额和进出口规则先影响资源供给与价格预期",
    industryImpact: "资源价格和供给稳定性传导至上游资本开支、加工利润及下游材料成本",
    positivePath: "勘探投入、收储或供给约束可能改善上游资源企业订单和议价",
    negativePath: "价格管控、需求走弱或新增供给释放，会压缩资源品溢价并影响下游库存",
    verification: ["配额、收储、矿权和进出口政策文件落地", "现货期货价格、库存和开工率共同确认", "资源板块资金与企业产量、资本开支变化一致"],
    invalidation: "供给约束未执行、库存持续累积，或下游需求不足以支撑价格",
  },
  {
    key: "国防与安全",
    pattern: /国防与安全|国防|军队现代化|国家安全|网络安全|数据安全|卫星|航空航天|无人装备/,
    directVariable: "安全战略、采购规划和技术标准先决定装备及信息化投入方向",
    industryImpact: "预算和型号进度传导至主机厂、核心配套、电子元器件和网络安全订单",
    positivePath: "预算、采购和型号节点明确时，具备定型产品与交付能力的环节更可能兑现",
    negativePath: "采购节奏推迟、应收回款慢或只有主题催化而无订单，会削弱盈利传导",
    verification: ["预算、采购公告、型号节点或合同负债出现增量", "主机与配套企业交付、回款和产能利用率改善", "军工或安全板块资金具备持续性而非单日异动"],
    invalidation: "采购延期、订单未确认，或板块上涨没有成交与基本面数据配合",
  },
]);

const DEFAULT_EVENT_CHAIN_PROFILE = Object.freeze({
  key: "综合政策事件",
  directVariable: "事件先改变政策预期、产业需求或市场风险偏好",
  industryImpact: "预期需要经过项目、订单、价格、产量或监管执行，才能传导至企业收入和利润",
  positivePath: "执行细则和高频数据确认后，相关行业的盈利预期可能改善",
  negativePath: "只有表态而无执行，或成本与需求反向变化，可能使预期交易快速回落",
  verification: ["核对正式文件、权威来源和明确生效时间", "核对行业价格、订单、产量或资金流是否同向", "核对代表公司公告和经营数据是否出现实质变化"],
  invalidation: "缺少正式落地文件，或后续行业与公司数据持续背离事件方向",
});

function eventChainProfile(item) {
  const title = String(item.title || "");
  const titlePriorities = [
    ["贸易与关税", /贸易与关税|开放与贸易|关税|出口管制|反倾销|实体清单|WTO|外贸/],
    ["全球科技规则", /全球科技规则|科技规则|芯片出口|AI芯片|半导体限制|先进制程|数据跨境/],
    ["全球利率", /全球利率|美联储|欧洲央行|日本央行|利率决议|通胀|非农|美债收益率/],
    ["全球增长", /全球增长|全球经济|全球贸易|制造业PMI|经济衰退|IMF|世界银行|OECD/],
    ["全球能源", /全球能源|OPEC|欧佩克|原油|天然气|LNG|霍尔木兹|能源通道|能源合作|海峡通行/],
    ["地缘冲突", /地缘冲突|俄乌|冲突|停火|空袭|袭击|封锁|战争|交火/],
  ];
  const preferred = titlePriorities.find(([, pattern]) => pattern.test(title));
  if (preferred) return EVENT_CHAIN_PROFILES.find((profile) => profile.key === preferred[0]) || DEFAULT_EVENT_CHAIN_PROFILE;
  const themeProfile = unique(item.themes).map((theme) => EVENT_CHAIN_PROFILES.find((profile) => profile.key === theme)).find(Boolean);
  if (themeProfile) return themeProfile;
  const subject = unique([title, item.summary, ...(item.themes || [])]).join(" ");
  const haystack = unique([subject, ...(item.sectors || [])]).join(" ");
  return EVENT_CHAIN_PROFILES.find((profile) => profile.pattern.test(haystack)) || DEFAULT_EVENT_CHAIN_PROFILE;
}

function eventTrigger(item) {
  const title = compactDetail(item.title, 110);
  const summary = compactDetail(item.summary, 150);
  if (!summary || summary === title || summary.startsWith(title)) return title || "事件内容待核对";
  return summary;
}

function eventImpactWindowText(item, expiry) {
  if (item.foundation) return "长期政策基准；以专项规划、预算、项目和订单的后续落地为确认点";
  const text = `${item.title || ""} ${item.summary || ""}`;
  if (/数据|PMI|非农|通胀|利率决议|库存/.test(text)) return "短线1至3个交易日定价，后续数据发布时重新评估";
  if (item.scope === "international") return "短线1至5个交易日，事件持续升级时滚动延长";
  if ((item.plans || []).length) return `政策预期约2至4周；${expiry.expiresAt === "待确认" ? "订单和业绩需继续跟踪" : `当前跟踪至${expiry.expiresAt}`}`;
  return `事件观察约3至10个交易日；${expiry.expiresAt === "待确认" ? "以执行进展为准" : `当前跟踪至${expiry.expiresAt}`}`;
}

function eventDirectionPaths(item, profile) {
  const text = `${item.title || ""} ${item.summary || ""}`;
  if (profile.key === "地缘冲突") {
    if (/停火|缓和|和谈|撤军|恢复通行|和平协议/.test(text)) {
      return {
        primaryLabel: "当前偏向",
        primaryPath: "局势缓和有助于降低油运和避险溢价、修复风险偏好；黄金、军工和油气的纯事件溢价可能回落",
        counterLabel: "反向风险",
        counterPath: "协议执行失败或冲突再升级，会使能源、航运和避险资产重新获得风险溢价",
      };
    }
    if (/空袭|袭击|封锁|战争|交火|升级|受阻|中断/.test(text)) {
      return {
        primaryLabel: "当前偏向",
        primaryPath: "局势升级抬高黄金、油气、军工和部分航运的风险溢价，同时压制高风险资产并推升进口成本",
        counterLabel: "缓和条件",
        counterPath: "停火、撤军或运输恢复会降低避险溢价，并使事件驱动交易快速降温",
      };
    }
  }
  if (profile.key === "全球能源") {
    if (/恢复|增产|释放储备|库存回升|通行恢复/.test(text)) {
      return {
        primaryLabel: "当前偏向",
        primaryPath: "供应或运输恢复有助于压低能源与通胀溢价，利好下游成本，但可能削弱上游资源品价格弹性",
        counterLabel: "反向风险",
        counterPath: "恢复不及预期、库存继续下降或通道再次受阻，会重新推高油气价格和运价",
      };
    }
    if (/减产|受阻|封锁|袭击|中断|库存下降|供应收紧/.test(text)) {
      return {
        primaryLabel: "当前偏向",
        primaryPath: "供应收紧或运输受阻会抬高油气价格、上游盈利和部分航运费率，同时增加下游制造成本",
        counterLabel: "缓和条件",
        counterPath: "增产、库存回补或运输恢复会压低上游溢价，并缓解下游成本压力",
      };
    }
  }
  if (profile.key === "全球利率") {
    if (/降息|通胀回落|就业走弱|收益率下降/.test(text)) {
      return {
        primaryLabel: "当前偏向",
        primaryPath: "宽松预期有助于降低贴现率、支撑成长估值与黄金，并缓解全球流动性压力",
        counterLabel: "反向风险",
        counterPath: "通胀或就业重新走强会推迟宽松路径，使美元和美债收益率反弹",
      };
    }
    if (/加息|通胀上升|就业.*(强|好)|收益率上行/.test(text)) {
      return {
        primaryLabel: "当前偏向",
        primaryPath: "紧缩预期抬高贴现率和美元强度，高估值方向与汇率风险偏好更易承压",
        counterLabel: "缓和条件",
        counterPath: "后续通胀或就业降温、央行指引转鸽，会降低加息概率并修复风险偏好",
      };
    }
  }
  if (item.impactTone === "positive") {
    return {primaryLabel: "当前偏向", primaryPath: profile.positivePath, counterLabel: "反向风险", counterPath: profile.negativePath};
  }
  if (item.impactTone === "negative") {
    return {primaryLabel: "当前偏向", primaryPath: profile.negativePath, counterLabel: "缓和条件", counterPath: profile.positivePath};
  }
  return {primaryLabel: "正向路径", primaryPath: profile.positivePath, counterLabel: "负向路径", counterPath: profile.negativePath};
}

function buildEventChains(policyNews, quant) {
  const quantRows = quant?.formal || [];
  return (policyNews?.items || []).map((item) => {
    const confidence = newsConfidence(item);
    const expiry = eventExpiry(item);
    const sectors = unique(item.sectors);
    const themes = unique(item.themes);
    const profile = eventChainProfile(item);
    const eventType = item.foundation
      ? "规划基准"
      : item.scope === "international"
        ? `国际·${profile.key}`
        : (item.plans || []).length
          ? `政策·${profile.key}`
          : `国内·${profile.key}`;
    const trigger = eventTrigger(item);
    const sectorText = sectors.slice(0, 7).join("、") || "相关行业";
    const verificationPoints = unique(profile.verification).slice(0, 3);
    const impactWindowText = eventImpactWindowText(item, expiry);
    const directions = eventDirectionPaths(item, profile);
    const transmissionSteps = [
      {stage: "事件触发", content: trigger},
      {stage: "直接变量", content: profile.directVariable},
      {stage: "产业传导", content: profile.industryImpact},
      {stage: "A股映射", content: `${sectorText}；当前事件定性为“${item.impact || "待观察"}”`},
      {stage: "盘面确认", content: verificationPoints.join("；")},
    ];
    const channel = transmissionSteps.slice(1, 4).map((step) => step.content).join(" → ");
    return {
      id: `event-${item.id || Math.abs(String(item.title || "").split("").reduce((sum, char) => sum + char.charCodeAt(0), 0))}`,
      newsId: item.id || "",
      eventType,
      profileKey: profile.key,
      title: item.title || "",
      summary: item.summary || "",
      source: item.source || "",
      url: item.url || "",
      publishedAt: item.publishedAt || "",
      scope: item.scope || "domestic",
      plans: unique(item.plans),
      themes,
      sectors,
      impact: item.impact || "待观察",
      impactTone: item.impactTone || "watch",
      importance: finite(item.importance) || 3,
      foundation: Boolean(item.foundation),
      confidence,
      ...expiry,
      impactWindowText,
      trigger,
      channel,
      transmissionSteps,
      ...directions,
      verificationPoints,
      verification: verificationPoints.join("；"),
      invalidation: profile.invalidation,
      chainSummary: `${trigger} → ${profile.directVariable} → ${profile.industryImpact} → ${sectorText}。`,
      linkedStocks: linkedStocksForEvent(item, quantRows),
    };
  }).sort((left, right) => String(right.publishedAt).localeCompare(String(left.publishedAt)) || right.confidence.score - left.confidence.score);
}

function attachEventChains(policyNews, quant) {
  if (!policyNews) return [];
  const chains = buildEventChains(policyNews, quant);
  policyNews.eventChainVersion = 2;
  policyNews.eventChains = chains;
  policyNews.items = (policyNews.items || []).map((item) => {
    const chain = chains.find((entry) => entry.newsId === item.id);
    return chain ? {
      ...item,
      eventType: chain.eventType,
      confidence: chain.confidence,
      expiresAt: chain.expiresAt,
      impactWindowText: chain.impactWindowText,
      chainSummary: chain.chainSummary,
    } : item;
  });
  if (!quant || !Array.isArray(quant.formal)) return chains;
  quant.formal = quant.formal.map((row) => {
    const stockTerms = unique([row.sector, ...(row.concepts || [])]);
    const linkedEvents = chains.filter((event) => {
      const eventTerms = unique([...(event.sectors || []), ...(event.themes || [])]);
      return eventTerms.some((eventTerm) => stockTerms.some((stockTerm) => termsMatch(eventTerm, stockTerm)));
    }).slice(0, 3).map((event) => ({
      id: event.id,
      eventType: event.eventType,
      title: event.title,
      source: event.source,
      publishedAt: event.publishedAt,
      impact: event.impact,
      confidence: event.confidence,
      channel: event.channel,
    }));
    return {...row, linkedEvents};
  });
  return chains;
}

function buildHealth(data, archiveCount = 0) {
  const dates = unique([
    data.market?.tradeDate,
    data.market?.market?.tradeDate,
    data.indices?.tradeDate,
    data.sectors?.tradeDate,
    data.stocks?.tradeDate,
    data.analysis?.tradeDate,
    data.quant?.tradeDate,
  ]);
  const shanghai = (data.indices?.items || []).find((item) => item.name === "上证指数") || data.indices?.items?.[0];
  const currentMinute = latestMinute(shanghai?.points);
  const modules = [];
  const marketValidation = data.market?.validation || data.analysis?.validation || {};
  modules.push(moduleResult("market", "市场总览", marketValidation.status === "ok" ? 100 : 72, {
    tradeDate: data.market?.tradeDate,
    syncedAt: data.market?.syncedAt,
    sources: ["东方财富市场统计", "本地历史对比"],
    sample: {stockCount: data.market?.market?.stockCount, latestTime: minuteText(currentMinute)},
    checks: Object.values(marketValidation.checks || {}).map((check) => ({status: check.consistent === false ? "error" : "ok", detail: check})),
    warnings: marketValidation.warnings,
    errors: marketValidation.errors,
  }));

  const indexItems = data.indices?.items || [];
  const ashareItems = indexItems.filter((item) => item.session !== "us");
  const snapshotOnlyItems = ashareItems.filter((item) => item.snapshotOnly === true);
  const indexAnnotations = data.indices?.annotations || {};
  const indexCoverage = ashareItems.length ? ashareItems.reduce((sum, item) => {
    const uniqueMinutes = new Set((item.points || []).map((point) => finite(point.minute)).filter((value) => value !== null && value <= currentMinute));
    return sum + clamp((uniqueMinutes.size / Math.max(1, currentMinute)) * 100);
  }, 0) / ashareItems.length : 0;
  const crossChecked = ashareItems.filter((item) => item.crossCheck?.status === "ok").length;
  modules.push(moduleResult("indices", "主要指数", (indexCoverage * .75) + clamp(indexItems.length / 8 * 100) * .25, {
    tradeDate: data.indices?.tradeDate,
    syncedAt: data.indices?.syncedAt,
    sources: [
      ...indexItems.flatMap((item) => [item.source, ...(item.crossCheck?.sources || [])]),
      indexAnnotations.source,
    ],
    sample: {
      indexCount: indexItems.length,
      latestMinute: currentMinute,
      latestTime: minuteText(currentMinute),
      crossChecked,
      annotationCount: Number(indexAnnotations.itemCount) || 0,
      annotationStatus: indexAnnotations.status || "unavailable",
    },
    checks: [
      ...ashareItems.map((item) => ({name: item.name, status: item.crossCheck?.status || "pending", detail: compactDetail(item.crossCheck?.detail || "等待下一轮双源核对")})),
      {
        name: "指数文字标注",
        status: indexAnnotations.status === "ok" ? "ok" : indexAnnotations.status === "retained" ? "warning" : "pending",
        detail: indexAnnotations.status === "ok"
          ? `财联社盘面直播原始事件${Number(indexAnnotations.itemCount) || 0}条`
          : indexAnnotations.status === "retained"
            ? `财联社接口暂时异常，保留同交易日原始事件${Number(indexAnnotations.itemCount) || 0}条`
            : "财联社盘面直播暂无可显示事件，不使用本地生成标注",
      },
    ],
    warnings: [
      ...(indexItems.length < 8 ? [`主要指数仅${indexItems.length}/8个`] : []),
      ...(snapshotOnlyItems.length ? [`${snapshotOnlyItems.map((item) => item.name).join("、")}当前只有真实快照点，未补画分钟轨迹`] : []),
      ...(indexAnnotations.status === "retained" ? ["财联社盘面直播本轮读取失败，当前沿用同交易日上一份原始标注"] : []),
    ],
  }));

  for (const [key, label] of [["industry", "二级行业"], ["concept", "概念板块"]]) {
    const timeline = boardTimelineHealth(data.sectors?.[key], currentMinute);
    modules.push(moduleResult(key, label, timeline.coverage, {
      tradeDate: data.sectors?.tradeDate,
      syncedAt: data.sectors?.syncedAt,
      sources: timeline.rows.flatMap((row) => [row.flowSource, ...(row.points || []).map((point) => point.source)]),
      sample: {
        rowCount: timeline.rows.length,
        realSeries: timeline.withSeries.length,
        fromOpen: timeline.early.length,
        current: timeline.current.length,
        rankingMatched: timeline.rankingMatches.length,
        reconciliationChecked: timeline.reconciliationChecked,
        autoCorrected: timeline.reconciliationCorrected,
        reconciliationMatchedAfter: timeline.reconciliationMatchedAfter,
        latestTime: minuteText(currentMinute),
      },
      checks: [{
        status: timeline.validated.length >= 6 && timeline.reconciliationMatchedAfter >= timeline.rows.length ? "ok" : "warning",
        detail: `官方分钟序列验证${timeline.validated.length}个，排名末值核对${timeline.rankingMatches.length}个，自动修正${timeline.reconciliationCorrected}个当前点`,
      }],
      warnings: [
        ...(timeline.rows.length < 20 ? [`仅展示${timeline.rows.length}/20个资金方向`] : []),
        ...(timeline.reconciliationChecked < timeline.rows.length
          ? [`${timeline.rows.length - timeline.reconciliationChecked}个方向尚未完成自动纠偏核对`]
          : []),
        ...(timeline.reconciliationMatchedAfter < timeline.reconciliationChecked
          ? [`${timeline.reconciliationChecked - timeline.reconciliationMatchedAfter}个方向自动纠偏后仍不一致`]
          : []),
      ],
    }));
  }

  const groups = data.stocks?.groups || {};
  const stockRows = Object.values(groups).reduce((sum, group) => sum + (group?.rows?.length || 0), 0);
  modules.push(moduleResult("stocks", "涨跌停与延续", stockRows ? 100 : 0, {
    tradeDate: data.stocks?.tradeDate,
    syncedAt: data.stocks?.syncedAt,
    sources: ["东方财富涨跌停明细", "行业概念映射"],
    sample: {groupCount: Object.keys(groups).length, rowCount: stockRows},
    errors: stockRows ? [] : ["专题个股明细为空"],
  }));

  const newsStats = data.policyNews?.stats || {};
  const policyItemCount = data.policyNews?.items?.length || 0;
  const policyEventCount = data.policyNews?.eventChains?.length || 0;
  const newsCompleteness = finite(newsStats.querySuccess) === null ? 70 : (newsStats.querySuccess / Math.max(1, newsStats.querySuccess + (newsStats.queryErrors || 0))) * 100;
  const policyCompleteness = policyItemCount
    ? Math.min(newsCompleteness, policyEventCount ? 100 : 82)
    : 0;
  modules.push(moduleResult("policyNews", "政策与国际新闻", policyCompleteness, {
    tradeDate: data.analysis?.tradeDate,
    syncedAt: data.policyNews?.generatedAt,
    sources: (data.policyNews?.items || []).map((item) => item.source),
    sample: {itemCount: policyItemCount, eventCount: policyEventCount, dateCount: newsStats.dateCount || 0},
    warnings: [
      ...(data.policyNews?.error ? [data.policyNews.error] : []),
      ...(policyItemCount && !policyEventCount ? ["已有新闻条目，但关键事件传导链尚未生成"] : []),
    ],
    errors: policyItemCount ? [] : ["政策与国际新闻条目为空"],
  }));

  const historyTarget = 30;
  modules.push(moduleResult("history", "历史仓库", clamp(archiveCount / historyTarget * 100), {
    tradeDate: data.analysis?.tradeDate,
    syncedAt: data.analysis?.syncedAt,
    sources: ["每日完整复盘归档", "结构化快照"],
    sample: {archiveCount, targetCount: historyTarget},
    warnings: archiveCount >= historyTarget
      ? []
      : [archiveCount ? `历史归档为${archiveCount}/${historyTarget}个交易日，30日比较样本仍在自动积累` : "尚未发现可回放交易日"],
  }));

  const crossChecks = [];
  crossChecks.push(crossCheckResult("trade-date", "模块交易日", dates.length === 1 ? "ok" : "error", dates.length === 1 ? `全部模块为${dates[0]}` : `交易日不一致：${dates.join(" / ")}`, {dates}));
  const indexPoint = finite(shanghai?.points?.at?.(-1)?.price);
  crossChecks.push(crossCheckResult("shanghai-timeline", "上证分时完整性", indexPoint !== null && currentMinute > 0 ? "ok" : "warning", indexPoint === null ? "缺少有效指数点位" : `最新点位${round(indexPoint, 2)}，最新样本${minuteText(currentMinute)}`, {indexPoint, latestMinute: currentMinute}));
  for (const item of ashareItems.filter((entry) => entry.crossCheck)) {
    crossChecks.push(crossCheckResult(`index-${item.key || item.code}`, `${item.name}双源`, item.crossCheck.status || "warning", item.crossCheck.detail || "", {
      status: item.crossCheck.status,
      checkedAt: item.crossCheck.checkedAt,
      primarySource: item.crossCheck.primarySource,
      secondarySource: item.crossCheck.secondarySource,
      priceGapPct: item.crossCheck.priceGapPct,
      changeGapPct: item.crossCheck.changeGapPct,
    }));
  }
  for (const key of ["industry", "concept"]) {
    const timeline = boardTimelineHealth(data.sectors?.[key], currentMinute);
    const status = timeline.rankingMatches.length >= Math.min(10, timeline.rows.length) ? "ok" : "warning";
    crossChecks.push(crossCheckResult(
      `flow-${key}`,
      key === "industry" ? "行业分钟末值与排名" : "概念分钟末值与排名",
      status,
      `${timeline.rankingMatches.length}/${timeline.rows.length}个方向通过末值核对，已自动修正${timeline.reconciliationCorrected}个当前点`,
      {
        matched: timeline.rankingMatches.length,
        total: timeline.rows.length,
        reconciliationChecked: timeline.reconciliationChecked,
        autoCorrected: timeline.reconciliationCorrected,
        matchedAfter: timeline.reconciliationMatchedAfter,
        policy: timeline.reconciliation?.policy || "",
      },
    ));
  }

  const errorCount = modules.filter((item) => item.status === "error").length + crossChecks.filter((item) => item.status === "error").length;
  const warningCount = modules.filter((item) => item.status === "warning").length + crossChecks.filter((item) => item.status === "warning").length;
  const baseScore = modules.reduce((sum, item) => sum + item.completeness, 0) / Math.max(1, modules.length);
  const overallScore = round(clamp(baseScore - warningCount * 2 - errorCount * 8), 1);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    tradeDate: dates[0] || "",
    overall: {status: errorCount ? "error" : warningCount ? "warning" : "ok", score: overallScore, errorCount, warningCount},
    session: {phase: marketPhase(dates[0] || "", currentMinute), latestMinute: currentMinute, latestTime: minuteText(currentMinute), samplePolicy: "只使用真实样本；仅在前后两个真实样本之间线性显示；午休冻结在11:30:00，收盘冻结在15:00:00。"},
    modules,
    crossChecks,
  };
}

function archiveDates(archiveDir, legacyArchiveDir) {
  const map = new Map();
  if (archiveDir && fs.existsSync(archiveDir)) {
    for (const entry of fs.readdirSync(archiveDir, {withFileTypes: true})) {
      if (entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)) map.set(entry.name, {date: entry.name, type: "structured"});
    }
  }
  if (legacyArchiveDir && fs.existsSync(legacyArchiveDir)) {
    for (const name of fs.readdirSync(legacyArchiveDir)) {
      const match = name.match(/^(\d{4}-\d{2}-\d{2})_完整复盘数据\.json$/);
      if (match && !map.has(match[1])) map.set(match[1], {date: match[1], type: "legacy"});
    }
  }
  return [...map.values()].sort((left, right) => right.date.localeCompare(left.date));
}

function writeStructuredArchive(data, health, options) {
  const tradeDate = data.analysis?.tradeDate || data.market?.tradeDate || "";
  if (!options.archiveDir || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) return null;
  const validation = data.analysis?.validation || data.market?.validation || {};
  if (validation.status === "error") return null;
  const targetDir = path.join(options.archiveDir, tradeDate);
  fs.mkdirSync(targetDir, {recursive: true});
  for (const [key, filename] of Object.entries(DATASET_FILES)) {
    if (data[key]) atomicWrite(path.join(targetDir, filename), data[key]);
  }
  atomicWrite(path.join(targetDir, "health.json"), health);
  atomicWrite(path.join(targetDir, "manifest.json"), {
    version: 1,
    tradeDate,
    syncedAt: data.analysis?.syncedAt || data.market?.syncedAt || "",
    files: [...Object.values(DATASET_FILES), "health.json"],
    latestMinute: health.session.latestMinute,
    status: health.overall.status,
  });
  return targetDir;
}

function loadAppData(appDir) {
  const dataDir = path.join(appDir, "data");
  const data = Object.fromEntries(Object.entries(DATASET_FILES).map(([key, filename]) => [key, readJson(path.join(dataDir, filename), {})]));
  data.quant = readJson(path.join(dataDir, "quant.json"), {});
  return data;
}

function enhanceAppData(options = {}) {
  const appDir = path.resolve(options.appDir || path.resolve(__dirname, ".."));
  const dataDir = path.join(appDir, "data");
  const data = loadAppData(appDir);
  const regime = buildUnifiedRegime(data);
  data.analysis.marketRegime = regime;
  attachEventChains(data.policyNews, data.quant);
  const datesBefore = archiveDates(options.archiveDir, options.legacyArchiveDir);
  let health = buildHealth(data, Math.max(1, datesBefore.length));
  atomicWrite(path.join(dataDir, DATASET_FILES.analysis), data.analysis);
  atomicWrite(path.join(dataDir, DATASET_FILES.policyNews), data.policyNews);
  const archivePath = writeStructuredArchive(data, health, options);
  const dates = archiveDates(options.archiveDir, options.legacyArchiveDir);
  health = buildHealth(data, dates.length);
  atomicWrite(path.join(dataDir, "health.json"), health);
  if (archivePath) atomicWrite(path.join(archivePath, "health.json"), health);
  const historyIndex = {
    version: 1,
    generatedAt: health.generatedAt,
    latestDate: dates[0]?.date || "",
    count: dates.length,
    dates,
  };
  atomicWrite(path.join(dataDir, "history-index.json"), historyIndex);
  if (options.archiveDir) atomicWrite(path.join(options.archiveDir, "index.json"), historyIndex);
  return {appDir, health, historyIndex, archivePath, eventCount: data.policyNews.eventChains?.length || 0};
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = (name) => args.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1) || "";
  const result = enhanceAppData({
    appDir: value("--app-dir") || path.resolve(__dirname, ".."),
    archiveDir: value("--archive-dir"),
    legacyArchiveDir: value("--legacy-dir"),
  });
  console.log(JSON.stringify({
    ok: true,
    tradeDate: result.health.tradeDate,
    health: result.health.overall,
    historyCount: result.historyIndex.count,
    eventCount: result.eventCount,
  }, null, 2));
}

module.exports = {buildEventChains, buildHealth, buildUnifiedRegime, enhanceAppData};
