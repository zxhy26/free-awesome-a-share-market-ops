"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SOURCE_NAME = "东方财富财经日历";
const SOURCE_URL = "https://data.eastmoney.com/cjrl/default.html";
const CALENDAR_API = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const BOARD_API_HOSTS = Object.freeze([
  "https://push2delay.eastmoney.com",
  "https://push2.eastmoney.com",
]);
const REFRESH_WINDOW_MS = 4 * 60 * 60 * 1000;
const COMPANY_PROFILE_CACHE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 36;
const MAX_RELATED_STOCKS = 4;
const A_SHARE_CODE_RE = /^(000|001|002|003|300|301|600|601|603|605|688|689|430|830|831|832|833|834|835|836|837|838|839|870|871|872|873|874|875|876|877|878|879|920)\d{3}$/;
const REQUEST_HEADERS = Object.freeze({
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
  "Accept": "application/json,text/plain,*/*",
  "Referer": SOURCE_URL,
});

const CATEGORY_LABELS = Object.freeze({
  policy: "政策会议",
  macro: "宏观数据",
  market: "市场日历",
  industry: "产业事件",
  geopolitics: "国际与地缘",
});

const CRITICAL_EVENT_RE = /中共中央政治局|中央经济工作会议|全国两会|全国人大|国务院常务会议|国新办.*发布会|中国人民银行.*(利率|降准|LPR|MLF)|美联储|FOMC|欧洲央行.*利率|日本央行.*利率|非农|消费者物价指数|CPI|PCE|国内生产总值|GDP|采购经理指数|PMI|进出口|工业企业.*利润|利润.*工业企业|关税|制裁|停火|冲突|OPEC|APEC.*部长/iu;
const IMPORTANT_EVENT_RE = /利率决议|央行|部长级会议|峰会|国事访问|发布会|听证会|财报|新股申购|限售股解禁|股东大会|行业大会|世界.*大会|论坛|博览会|展览会/iu;
const MAJOR_MACRO_RE = /工业企业.*利润|利润.*工业企业|PMI|采购经理指数|GDP|国内生产总值|CPI|消费者物价|PPI|生产者价格|PCE|非农|失业率|零售销售|工业增加值|进出口|贸易差额|耐用品订单|利率|LPR|MLF|货币供应|社会融资|新增贷款|房价|Ifo商业景气/iu;
const DOMESTIC_RE = /中国|香港|澳门|台湾|国务院|国新办|人民银行|证监会|发改委|工信部|财政部|商务部|国家统计局|上交所|深交所|北交所|A股|新股/iu;
const GEOPOLITICS_RE = /总统|总理|元首|国事访问|峰会|关税|制裁|停火|冲突|战争|海峡|中东|北约|欧盟|OPEC|APEC/iu;
const MARKET_RE = /新股申购|中签|上市|限售股解禁|股东大会|财报|分红|期货|期权|交割/iu;
const INDUSTRY_RE = /人工智能|\bAI\b|数字经济|算力|半导体|芯片|集成电路|机器人|低空|航空|航天|军工|卫星|汽车|电池|储能|新能源|光伏|风电|电力|核电|石油|天然气|煤炭|有色|稀土|黄金|医药|医疗|创新药|农业|种业|消费电子|通信|软件|网络安全|工业母机|高端装备|物流|航运|林业/iu;

const SECTOR_RULES = Object.freeze([
  {re: /人工智能|\bAI\b|数字经济|算力|数据中心/iu, sectors: ["计算机", "通信设备", "半导体"]},
  {re: /半导体|芯片|集成电路/iu, sectors: ["半导体", "电子化学品", "专用设备"]},
  {re: /机器人|工业母机|高端装备|机械/iu, sectors: ["自动化设备", "通用设备", "专用设备"]},
  {re: /汽车|车展|智能网联|无人驾驶/iu, sectors: ["汽车整车", "汽车零部件", "电池"]},
  {re: /电池|储能|新能源|光伏|风电|电力|核电/iu, sectors: ["电池", "光伏设备", "电力设备"]},
  {re: /石油|天然气|原油|OPEC/iu, sectors: ["油气开采", "石油加工", "航运港口"]},
  {re: /煤炭/iu, sectors: ["煤炭开采", "电力"]},
  {re: /有色|稀土|黄金|金属/iu, sectors: ["工业金属", "小金属", "贵金属"]},
  {re: /农业|种业|育种|林业/iu, sectors: ["种植业", "农产品加工", "林业"]},
  {re: /医药|医疗|创新药|生物/iu, sectors: ["化学制药", "生物制品", "医疗器械"]},
  {re: /军工|航空|航天|卫星|国防/iu, sectors: ["航空装备", "航天装备", "军工电子"]},
  {re: /通信|网络安全|软件/iu, sectors: ["通信设备", "软件开发", "IT服务"]},
  {re: /PMI|工业企业.*利润|利润.*工业企业|工业增加值|GDP|国内生产总值/iu, sectors: ["工业金属", "基础化工", "银行"]},
  {re: /CPI|PCE|通胀|利率|美联储|央行|LPR|MLF/iu, sectors: ["银行", "保险", "贵金属"]},
  {re: /进出口|贸易差额|关税/iu, sectors: ["航运港口", "物流", "跨境贸易"]},
  {re: /新股申购|上市/iu, sectors: ["证券", "多元金融"]},
]);

const BOARD_ALIASES = Object.freeze({
  "计算机": ["计算机设备", "IT服务", "软件开发"],
  "跨境贸易": ["跨境电商", "贸易行业"],
  "基础化工": ["化学原料", "化学制品"],
  "工业金属": ["铜", "铝", "铅锌"],
  "专用设备": ["专用设备"],
  "自动化设备": ["自动化设备"],
  "军工电子": ["军工电子"],
  "油气开采": ["油气开采及服务"],
  "石油加工": ["炼化及贸易"],
});

const SECTOR_TRANSMISSION = Object.freeze({
  "计算机": "数字化投入、软件订单和人工智能应用预期",
  "计算机设备": "政企数字化采购、智能硬件需求和算力基础设施投入",
  "IT服务": "政企信息化支出、云服务需求和项目订单",
  "软件开发": "软件采购、订阅收入和国产替代预期",
  "通信设备": "运营商资本开支、网络建设和算力互联需求",
  "半导体": "芯片需求、国产替代、产能利用率和设备材料投入",
  "电子化学品": "晶圆制造扩产、材料国产化和产品价格",
  "专用设备": "制造业资本开支、设备更新和新增订单",
  "自动化设备": "工业自动化投入、机器人渗透率和制造业订单",
  "通用设备": "制造业景气、设备更新和固定资产投资",
  "汽车整车": "汽车消费、车型销量、价格策略和出口需求",
  "汽车零部件": "整车产销量、配套定点和单车价值量",
  "电池": "新能源汽车销量、装机量、储能需求和材料成本",
  "光伏设备": "新增装机、产业链价格、出口需求和资本开支",
  "电力设备": "电网投资、新能源建设和设备招标订单",
  "电力": "用电需求、电价政策、燃料成本和装机利用率",
  "油气开采": "国际油价、产量政策和上游资本开支",
  "石油加工": "原油成本、成品油价差和炼化开工率",
  "航运港口": "进出口货量、运价、港口吞吐量和贸易政策",
  "物流": "货运需求、快递件量、运价和跨境贸易活跃度",
  "跨境贸易": "出口订单、关税、汇率和海外消费需求",
  "煤炭开采": "煤价、供需平衡、进口量和电力需求",
  "工业金属": "制造业需求、库存、商品价格和全球增长预期",
  "小金属": "新能源需求、供给约束、库存和产品价格",
  "贵金属": "实际利率、美元走势、避险需求和金价",
  "基础化工": "工业需求、原料成本、产品价差和开工率",
  "化学原料": "原料价格、下游需求和产品价差",
  "化学制品": "终端需求、产品价格、出口和新增产能",
  "化学制药": "药品审批、研发进展、集采政策和终端需求",
  "生物制品": "研发审批、疫苗及生物药需求和医保政策",
  "医疗器械": "医院采购、设备更新、集采政策和出海订单",
  "种植业": "种业政策、农产品价格、种植面积和单产预期",
  "农产品加工": "农产品价格、消费需求和加工价差",
  "林业": "林业政策、木材供需、生态项目和土地资源价值",
  "航空装备": "国防投入、装备采购和民航产业订单",
  "航天装备": "航天任务、卫星发射和装备采购订单",
  "军工电子": "国防信息化投入、装备采购和元器件订单",
  "银行": "利率、净息差、信贷需求和资产质量预期",
  "保险": "利率、权益市场表现、保费增长和投资收益",
  "证券": "市场成交、股权融资、两融和风险偏好",
  "多元金融": "资本市场活跃度、融资需求和资产价格",
});

const SECTOR_COMPANY_FACTORS = Object.freeze({
  "计算机": {link: "事件先影响政企数字化预算、人工智能项目立项和软硬件采购，再传到公司的项目签约与收入确认", metrics: "新签订单、合同负债、项目验收和回款"},
  "计算机设备": {link: "事件先影响服务器、智能终端和政企硬件采购，再传到公司的设备出货与订单交付", metrics: "设备销量、在手订单、毛利率和存货"},
  "IT服务": {link: "事件先影响政企信息化预算与项目招标，再传到公司的服务订单和项目验收", metrics: "新签合同、合同负债、项目验收和经营现金流"},
  "软件开发": {link: "事件先影响软件采购、国产替代和订阅需求，再传到公司的授权、订阅和实施收入", metrics: "订阅收入、新签订单、合同负债和销售回款"},
  "通信设备": {link: "事件先影响运营商资本开支、数据中心互联和网络建设，再传到公司的通信设备订单", metrics: "运营商集采份额、在手订单、交付节奏和毛利率"},
  "半导体": {link: "事件先影响芯片需求、国产替代和晶圆产能利用率，再传到公司的出货、代工或设计订单", metrics: "晶圆出货、产能利用率、平均售价和在手订单"},
  "电子化学品": {link: "事件先影响晶圆厂扩产和材料国产化验证，再传到公司的客户导入与材料销量", metrics: "客户验证、销量、产品价格和毛利率"},
  "专用设备": {link: "事件先影响制造业扩产和设备更新预算，再传到公司的招标、中标与交付", metrics: "新增订单、合同负债、交付周期和回款"},
  "自动化设备": {link: "事件先影响机器人和工业自动化投资，再传到公司的控制、伺服或整机订单", metrics: "订单增速、出货量、合同负债和毛利率"},
  "通用设备": {link: "事件先影响制造业资本开支和设备更新，再传到公司的设备订单与产能利用率", metrics: "新增订单、产量、产能利用率和回款"},
  "汽车整车": {link: "事件先影响新车曝光、终端订单和购车政策，再传到公司的车型销量与价格策略", metrics: "新增订单、交付量、单车售价和渠道库存"},
  "汽车零部件": {link: "事件先影响整车销量和新车型定点，再传到公司的配套量与单车价值量", metrics: "客户定点、配套销量、单车价值量和毛利率"},
  "电池": {link: "事件先影响新能源车和储能装机，再传到公司的电池出货及产能利用率", metrics: "电池出货、装机份额、材料成本和产能利用率"},
  "光伏设备": {link: "事件先影响新增装机、产业链价格与扩产计划，再传到公司的设备或组件订单", metrics: "新增订单、产品价格、开工率和库存"},
  "电力设备": {link: "事件先影响电网投资、新能源建设和设备招标，再传到公司的中标与交付", metrics: "电网中标、在手订单、交付节奏和回款"},
  "电力": {link: "事件先影响用电需求、电价和燃料成本，再传到公司的发电量与度电利润", metrics: "发电量、利用小时、电价和燃料成本"},
  "油气开采": {link: "事件先影响原油供给预期与国际油价，再传到公司的产量、售价和资本开支", metrics: "油气产量、实现价格、桶油成本和资本开支"},
  "石油加工": {link: "事件先影响原油成本和成品油价差，再传到公司的炼化开工与产品盈利", metrics: "炼化开工率、成品油价差、库存和单吨利润"},
  "航运港口": {link: "事件先影响进出口货量、航线运价和港口吞吐，再传到公司的运量与费率", metrics: "运价指数、货运量、港口吞吐量和舱位利用率"},
  "物流": {link: "事件先影响货运、快递和跨境件量，再传到公司的业务量与单票收入", metrics: "业务量、单票收入、运力利用率和成本"},
  "跨境贸易": {link: "事件先影响关税、汇率和海外订单，再传到公司的出口收入与履约成本", metrics: "出口订单、海外收入、汇兑损益和履约成本"},
  "煤炭开采": {link: "事件先影响煤炭供需与价格，再传到公司的销量和吨煤利润", metrics: "煤价、产销量、单位成本和库存"},
  "工业金属": {link: "事件先影响制造业需求、库存和金属价格，再传到公司的产销量与冶炼利润", metrics: "金属价格、产销量、加工费和库存"},
  "小金属": {link: "事件先影响新能源需求和供给约束，再传到公司的产品价格与销量", metrics: "产品价格、产销量、库存和扩产进度"},
  "贵金属": {link: "事件先影响实际利率、美元和避险需求，再传到公司的黄金售价与资源盈利", metrics: "金价、矿产金产量、单位成本和套保损益"},
  "基础化工": {link: "事件先影响工业需求、原料成本和产品价差，再传到公司的开工与盈利", metrics: "产品价差、开工率、库存和毛利率"},
  "化学原料": {link: "事件先影响原料供需和产品价格，再传到公司的销量与单吨利润", metrics: "产品价格、价差、开工率和库存"},
  "化学制品": {link: "事件先影响终端需求、出口和新增产能，再传到公司的订单与产品盈利", metrics: "订单、产品价格、开工率和毛利率"},
  "化学制药": {link: "事件先影响药品审批、集采和临床需求，再传到公司的产品放量与研发兑现", metrics: "获批进度、医院准入、销售额和研发费用"},
  "生物制品": {link: "事件先影响生物药审批、医保准入和终端需求，再传到公司的产品销售", metrics: "临床与获批节点、医保准入、销量和研发投入"},
  "医疗器械": {link: "事件先影响医院采购、设备更新和集采规则，再传到公司的招标与装机", metrics: "中标份额、装机量、订单和回款"},
  "种植业": {link: "事件先影响种业政策、品种审定和农产品价格，再传到公司的种植收益或种子推广", metrics: "品种审定、推广面积、单产和农产品价格"},
  "农产品加工": {link: "事件先影响农产品成本和消费需求，再传到公司的加工量与产品价差", metrics: "原料成本、销量、加工价差和库存"},
  "林业": {link: "事件先影响森林经营、生态项目和木材供需，再传到公司的资源开发与项目订单", metrics: "项目落地、采伐或种植规模、木材价格和资产利用率"},
  "航空装备": {link: "事件先影响国防和民航装备采购，再传到公司的型号订单与交付", metrics: "定型节点、在手订单、交付量和合同负债"},
  "航天装备": {link: "事件先影响卫星与航天任务安排，再传到公司的配套订单和产品交付", metrics: "发射计划、配套订单、交付进度和回款"},
  "军工电子": {link: "事件先影响国防信息化和装备采购，再传到公司的元器件订单", metrics: "军品订单、合同负债、交付节奏和回款"},
  "银行": {link: "事件先影响贷款需求、资产质量和资金价格，再传到公司的净息差与信贷投放", metrics: "新增贷款、净息差、不良生成率和存款成本"},
  "保险": {link: "事件先影响利率、权益市场和保费需求，再传到公司的投资收益与新业务价值", metrics: "新单保费、新业务价值、投资收益率和偿付能力"},
  "证券": {link: "事件先影响发行承销、市场成交和风险偏好，再传到公司的投行、经纪与两融业务", metrics: "承销规模、市场成交额、两融余额和经纪份额"},
  "多元金融": {link: "事件先影响融资需求和资产价格，再传到公司的租赁、信托或投资业务", metrics: "新增投放、资产收益率、风险成本和融资成本"},
});

const BUSINESS_SECTOR_GROUPS = Object.freeze([
  {sectors: /计算机|计算机设备|IT服务|软件开发|通信设备|半导体|电子化学品/iu, terms: /人工智能|物联网|大数据|软件|信息技术|数字化|视频|安防|通信|网络|宽带|IDC|云计算|晶圆|芯片|集成电路|半导体/iu},
  {sectors: /汽车整车|汽车零部件|电池|光伏设备|电力设备/iu, terms: /汽车|整车|零部件|发动机|动力系统|电池|储能|光伏|逆变器|电力设备|充电/iu},
  {sectors: /工业金属|小金属|贵金属|煤炭开采|油气开采|石油加工/iu, terms: /矿产|采选|冶炼|金矿|铜矿|钼|黄金|煤炭|油气|原油|天然气|炼化/iu},
  {sectors: /基础化工|化学原料|化学制品/iu, terms: /化工|聚氨酯|石化|化学品|材料|原料|农药|化肥/iu},
  {sectors: /银行|保险|证券|多元金融/iu, terms: /银行|贷款|存款|证券|承销|经纪|基金|期货|保险|信托|租赁|投资银行|资产管理/iu},
  {sectors: /航运港口|物流|跨境贸易/iu, terms: /航运|港口|集装箱|物流|快递|货物运输|供应链|跨境|海外销售|进出口/iu},
  {sectors: /种植业|农产品加工|林业/iu, terms: /种植|种子|育种|农业|农产品|粮油|油籽|林业|木材|橡胶/iu},
  {sectors: /化学制药|生物制品|医疗器械/iu, terms: /药品|制药|生物药|疫苗|医疗|器械|临床|诊断|研发服务/iu},
  {sectors: /航空装备|航天装备|军工电子|专用设备|自动化设备|通用设备/iu, terms: /航空|航天|军工|装备|设备|机器人|自动化|伺服|控制系统|机械/iu},
  {sectors: /电力|林业/iu, terms: /发电|电力|电网|能源|森林|生态项目/iu},
]);

const CATEGORY_TRANSMISSION = Object.freeze({
  macro: "宏观数据可能改变增长、通胀、利率或终端需求预期",
  policy: "政策会议可能改变产业支持方向、资本开支和估值预期",
  market: "市场日历事件可能改变短期资金供需、交易活跃度和风险偏好",
  industry: "产业事件可能带来政策、技术、产品和订单预期变化",
  geopolitics: "国际与地缘事件可能通过汇率、商品价格、贸易和风险偏好传导",
});

function eventTransmissionPath(event) {
  const combined = `${cleanText(event?.title)} ${cleanText(event?.content)}`;
  if (/美联储|FOMC|央行|利率决议|LPR|MLF|降准|降息|加息/iu.test(combined)) {
    return "利率与流动性预期可能通过资金成本、汇率、资产估值和风险偏好传导";
  }
  if (/CPI|PPI|PCE|通胀|消费者物价|生产者价格/iu.test(combined)) {
    return "通胀数据可能改变利率路径、成本压力、终端需求和资产估值预期";
  }
  if (/PMI|工业企业.*利润|利润.*工业企业|GDP|国内生产总值|工业增加值/iu.test(combined)) {
    return "增长与企业盈利数据可能改变需求、库存、产品价格和资本开支预期";
  }
  if (/进出口|贸易差额|关税|制裁|跨境/iu.test(combined)) {
    return "贸易数据与政策可能通过出口订单、关税、汇率、货量和运价传导";
  }
  if (/人工智能|\bAI\b|数字经济|算力|数据中心/iu.test(combined)) {
    return "数字与人工智能议题可能改变算力建设、政企采购、技术投入和应用订单预期";
  }
  if (/汽车|车展|智能驾驶|新能源车/iu.test(combined)) {
    return "汽车产业事件可能改变新车关注度、终端销量、配套订单和新能源装机预期";
  }
  if (/农业|种业|育种|林业/iu.test(combined)) {
    return "农业与林业议题可能改变产业政策、品种推广、农产品供需和生态项目预期";
  }
  if (/医药|医疗|创新药|生物技术/iu.test(combined)) {
    return "医药产业事件可能改变研发审批、临床进展、采购政策和产品需求预期";
  }
  if (/石油|天然气|原油|OPEC|煤炭|能源/iu.test(combined)) {
    return "能源事件可能通过供给政策、商品价格、库存和下游成本传导";
  }
  if (/新股申购|上市|限售股解禁|股东大会/iu.test(combined)) {
    return "市场日历事件可能改变短期资金供需、交易活跃度和资本市场业务预期";
  }
  return CATEGORY_TRANSMISSION[event?.category] || "该事件可能改变行业需求、成本、订单或风险偏好";
}

function eventDateLabel(event) {
  const matched = cleanText(event?.date).match(/^\d{4}-(\d{2})-(\d{2})$/);
  const date = matched ? `${Number(matched[1])}月${Number(matched[2])}日` : cleanText(event?.date);
  return `${date || "目标周"}${event?.time ? ` ${cleanText(event.time)}` : ""}`;
}

function usefulContentClause(value) {
  const text = cleanText(value);
  if (!text) return "";
  const sentences = text.split(/[。！？]/u).map((item) => cleanText(item)).filter(Boolean);
  const signalScore = (item) => {
    let score = 0;
    if (/围绕|主题为|政策对话|形成的共识|具体议题|发布|展示|新品|新技术|审议|决定/iu.test(item)) score += 8;
    if (/政策|技术|合作|订单|投资|人工智能|数字经济|算力|育种|生态|绿色发展|消费|利率|关税|项目|议题/iu.test(item)) score += 6;
    if (/将|公布|签署|申购|解禁|投产|开幕|举行/iu.test(item)) score += 2;
    if (/将于.*(举办|举行|召开)/iu.test(item) && !/围绕|主题为|政策对话|形成的共识|发布|展示|新品|新技术|审议|决定/iu.test(item)) score -= 5;
    return score;
  };
  const sentence = sentences
    .map((item, index) => ({item, index, score: signalScore(item)}))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.item || "";
  if (sentence.length <= 150) return sentence;
  const clauses = sentence.split(/[，,；;]/u).map((item) => cleanText(item)).filter(Boolean);
  const focusIndex = clauses
    .map((item, index) => ({index, score: signalScore(item)}))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.index ?? 0;
  return clauses.slice(focusIndex, focusIndex + 3).join("，") || clauses.slice(0, 2).join("，") || sentence;
}

function eventSpecificCause(event) {
  const title = cleanText(event?.title) || "该事件";
  const combined = `${title} ${cleanText(event?.content)} ${(event?.originalTitles || []).join(" ")}`;
  const timing = eventDateLabel(event);
  if (/工业企业.*利润|利润.*工业企业/iu.test(combined)) {
    return `“${title}”排期于${timing}公布，直接变量是规模以上工业企业利润增速；数据将检验制造业需求、产品价差和企业现金流是否改善。`;
  }
  if (/PMI|采购经理指数/iu.test(combined)) {
    return `“${title}”排期于${timing}公布，新订单、生产和原材料库存分项将直接检验制造业景气与补库存强度。`;
  }
  if (/GDP|国内生产总值/iu.test(combined)) {
    return `“${title}”排期于${timing}公布，增长速度及消费、投资和出口分项将重估总需求与企业盈利预期。`;
  }
  if (/CPI|PPI|PCE|通胀|消费者物价|生产者价格/iu.test(combined)) {
    return `“${title}”排期于${timing}公布，核心价格增速将直接改变利率路径、企业成本和终端需求判断。`;
  }
  if (/美联储|FOMC|央行|利率决议|LPR|MLF|降准|降息|加息/iu.test(combined)) {
    return `“${title}”排期于${timing}，政策利率与会后指引会直接重定价美元、美债收益率、人民币汇率和全球资金成本。`;
  }
  if (/进出口|贸易差额|关税|制裁|跨境/iu.test(combined)) {
    return `“${title}”排期于${timing}，关税、出口订单、汇率或货量变化是直接变量，将影响外需企业收入与跨境物流价格。`;
  }
  if (/新股申购/iu.test(combined)) {
    return `“${title}”在${timing}进入申购，发行承销规模、网上申购倍数和打新资金占用是当日可核对的直接变量。`;
  }
  if (/限售股解禁/iu.test(combined)) {
    return `“${title}”在${timing}进入解禁窗口，实际可流通市值和股东减持意愿会直接改变短期股票供给。`;
  }
  const contentClause = usefulContentClause(event?.content);
  if (contentClause) {
    return `“${title}”排期于${timing}；公开议程的具体触发点是${contentClause}。`;
  }
  return `“${title}”排期于${timing}；市场将根据公开结果重新定价${eventTransmissionPath(event).replace(/可能/gu, "")}。`;
}

function compactBusinessClause(value, stock = {}) {
  const text = cleanText(value);
  if (!text) return "";
  const sentences = text.split(/[。；]/u).map((item) => cleanText(item)).filter(Boolean);
  const strongBusinessMarker = /主营业务|主要业务|业务主要|主要从事|主要产品|核心产品|业务涵盖|业务范围|业务横跨/iu;
  const businessMarker = /主营业务|主要业务|业务主要|主要从事|专注于|致力于|主要产品|核心产品|业务涵盖|业务范围|业务横跨|提供[^，。；]{0,30}服务/iu;
  let selected = sentences.find((item) => strongBusinessMarker.test(item));
  selected ||= sentences.find((item) => businessMarker.test(item));
  selected ||= sentences.find((item) => /研发|生产|制造|销售|服务|运营|开采|种植|银行|证券|保险/iu.test(item));
  selected ||= sentences[0] || "";
  if (selected.length <= 110) return selected.replace(/[。；]+$/u, "");
  let clauses = selected.split(/[，,；;]/u).map((item) => cleanText(item)).filter(Boolean);
  if (clauses.length === 1 && clauses[0].length > 110 && clauses[0].includes("、")) {
    clauses = clauses[0].split("、").map((item) => cleanText(item)).filter(Boolean);
  }
  const sector = cleanText(stock?.sector || stock?.boardName);
  const sectorGroup = BUSINESS_SECTOR_GROUPS.find((item) => item.sectors.test(sector));
  const sectorClauses = sectorGroup ? clauses.filter((item) => sectorGroup.terms.test(item)).slice(0, 4) : [];
  if (sectorClauses.length) {
    const focused = sectorClauses.join("，");
    if (focused) return focused.replace(/[。；]+$/u, "");
  }
  const focusIndex = clauses.findIndex((item) => businessMarker.test(item));
  if (focusIndex >= 0) {
    const focused = clauses.slice(focusIndex, focusIndex + 3).join("，");
    if (focused) return focused.replace(/[。；]+$/u, "");
  }
  const kept = [];
  for (const clause of clauses) {
    kept.push(clause);
    if (kept.join("，").length >= 85 || kept.length >= 4) break;
  }
  return kept.join("，").replace(/[。；]+$/u, "");
}

function businessClauseScore(value, stock, profile) {
  const text = cleanText(value);
  if (!text || /^[-—无暂无]+$/u.test(text)) return -100;
  let score = 0;
  if (/主营业务|主要业务|业务主要|主要从事|主要产品|核心产品|业务涵盖|业务范围|业务横跨/iu.test(text)) score += 30;
  if (/研发|生产|制造|销售|运营|开采|采选|冶炼|种植|加工|运输|快递|贷款|存款|承销|经纪|保险|通信|云计算|晶圆|芯片|电池|汽车/iu.test(text)) score += 18;
  if (/产品|服务|客户|订单|项目|产能|牌照|网点|矿山|资源/iu.test(text)) score += 7;
  const sector = cleanText(stock?.sector || stock?.boardName || profile?.industry);
  const sectorGroup = BUSINESS_SECTOR_GROUPS.find((item) => item.sectors.test(sector));
  if (sectorGroup?.terms.test(text)) score += 25;
  if (/使命|愿景|价值观|携手共进|美好生活|受益|备受尊重|世界一流|第一核心竞争力/iu.test(text)) score -= 18;
  if (/成立于|挂牌上市|证券代码|更名|总部位于|注册资本/iu.test(text)) score -= 12;
  if (/依法须经批准|许可项目|一般项目|经营活动/iu.test(text)) score -= 35;
  return score;
}

function finalizeBusinessSummary(value, stock) {
  let text = cleanText(value)
    .replace(/[，,；;](?:并)?(?:致力于|旨在|努力|力争|以[^，,；;]{0,40}为使命)[^。]*$/iu, "")
    .trim();
  const transition = text.match(/主营业务由[^，,。；;]+到([^，,。；;]+)的转型/iu);
  if (transition) text = `${cleanText(stock?.name) || "该公司"}当前主营业务为${cleanText(transition[1])}`;
  if (text.length > 110 && text.includes("、")) {
    text = text.split("、").map((item) => cleanText(item)).filter(Boolean).slice(0, 6).join("、");
  }
  return text;
}

function companyBusinessSummary(stock, profile = {}) {
  const clause = [compactBusinessClause(profile.intro, stock), compactBusinessClause(profile.businessScope, stock)]
    .filter(Boolean)
    .sort((left, right) => businessClauseScore(right, stock, profile) - businessClauseScore(left, stock, profile) || left.length - right.length)[0];
  if (clause) return finalizeBusinessSummary(clause, stock);
  const industry = cleanText(profile.industry || stock?.sector || stock?.boardName);
  return `${cleanText(stock?.name) || "该公司"}的公开公司资料将其归入${industry || "相关"}行业，本次仅按公开板块成分建立观察关系`;
}

function companyEventLink(event, stock) {
  const sector = cleanText(stock?.sector || stock?.boardName) || "相关行业";
  const combined = `${cleanText(event?.title)} ${cleanText(event?.content)}`;
  if (/工业企业.*利润|利润.*工业企业/iu.test(combined) && sector === "银行") {
    return "工业企业利润会先改变企业还款能力与新增融资需求，再映射到该行的对公贷款、不良生成和净息差";
  }
  if (/工业企业.*利润|利润.*工业企业/iu.test(combined) && /工业金属|基础化工|化学原料|化学制品/iu.test(sector)) {
    return "工业企业利润数据会检验下游需求和产品价差，再映射到公司的销量、库存与单位盈利";
  }
  if (/新股申购/iu.test(combined) && /证券|多元金融/iu.test(sector)) {
    return "本次申购会形成实际承销和打新交易场景，再映射到公司的投行承销、经纪活跃度或金融投资业务";
  }
  if (/美联储|FOMC|利率决议|LPR|MLF|降准|降息|加息/iu.test(combined) && /银行|保险|贵金属/iu.test(sector)) {
    return `${cleanText(event?.title)}会先改变利率、汇率和资产价格，再映射到公司的资金成本、投资收益或资源售价`;
  }
  if (/车展|汽车|智能网联|新能源车/iu.test(combined) && /汽车整车|汽车零部件|电池/iu.test(sector)) {
    return "本次汽车事件包含车型发布、消费触达或技术展示，会先影响订单与车型热度，再映射到公司的交付、配套或电池装机";
  }
  if (/人工智能|\bAI\b|数字经济|算力|数据中心/iu.test(combined) && /计算机|计算机设备|IT服务|软件开发|通信设备|半导体/iu.test(sector)) {
    return "本次数字与人工智能议题会先影响政策合作、项目立项和算力建设，再映射到公司的产品采购、项目订单或产能利用";
  }
  if (/农业|种业|育种|林业/iu.test(combined) && /种植业|农产品加工|林业/iu.test(sector)) {
    return "本次农业或林业议题会先影响品种推广、生态项目和资源经营规则，再映射到公司的种植、加工或项目收益";
  }
  return SECTOR_COMPANY_FACTORS[sector]?.link || `事件会先改变${SECTOR_TRANSMISSION[sector] || `${sector}的需求、成本与订单`}，再映射到公司的实际经营数据`;
}

function stockRelationDetails(event, stock, profile = {}) {
  const sector = cleanText(stock?.sector || stock?.boardName) || "相关行业";
  const factors = SECTOR_COMPANY_FACTORS[sector] || {};
  const eventCause = eventSpecificCause(event);
  const companyBusiness = companyBusinessSummary(stock, profile);
  const companyLink = companyEventLink(event, stock);
  const watchPoint = factors.metrics || `${sector}价格、订单、销量、利润和现金流`;
  return {
    eventCause,
    companyBusiness,
    companyLink,
    watchPoint,
    relationReason: `事件成因：${eventCause} 公司关联：${companyBusiness}；${companyLink}。验证点：${watchPoint}。`,
  };
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(items) {
  return Array.from(new Set((items || []).filter(Boolean)));
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  const number = finite(value);
  if (number === null) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

async function mapLimit(items, concurrency, worker) {
  const source = Array.from(items || []);
  const output = new Array(source.length);
  let cursor = 0;
  async function run() {
    while (cursor < source.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(source[index], index);
    }
  }
  await Promise.all(Array.from({length: Math.min(Math.max(1, concurrency), source.length || 1)}, run));
  return output;
}

function localDateText(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function addDays(date, days) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function targetWeekBounds(reference = new Date()) {
  const day = reference.getDay();
  let delta;
  if (day === 0) delta = 1;
  else if (day === 6) delta = 2;
  else if (day === 5 && reference.getHours() >= 15) delta = 3;
  else delta = 1 - day;
  const start = addDays(reference, delta);
  const endExclusive = addDays(start, 7);
  return {
    start,
    endExclusive,
    weekStart: localDateText(start),
    weekEnd: localDateText(addDays(start, 6)),
  };
}

function parseSourceDate(value) {
  const matched = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!matched) return null;
  return new Date(
    Number(matched[1]),
    Number(matched[2]) - 1,
    Number(matched[3]),
    Number(matched[4] || 0),
    Number(matched[5] || 0),
    0,
    0,
  );
}

function weekdayLabel(value) {
  const date = parseSourceDate(value);
  return date ? `周${"日一二三四五六"[date.getDay()]}` : "日期待核对";
}

function timeLabel(value) {
  const matched = String(value || "").match(/[ T](\d{2}):(\d{2})/);
  return !matched || `${matched[1]}:${matched[2]}` === "00:00" ? "" : `${matched[1]}:${matched[2]}`;
}

function periodLabel(title) {
  const matched = title.match(/报告期[:：](\d{4})年(\d{2})月/);
  if (!matched) return "";
  return `${matched[1]}年${Number(matched[2])}月`;
}

function countryLabel(title) {
  const matched = title.match(/^(中国香港|中国台湾|中国|美国|欧元区|德国|法国|英国|日本|韩国|加拿大|澳大利亚)[:：]/);
  return matched ? matched[1] : "";
}

function macroFamily(title) {
  const families = [
    ["工业企业利润", /工业企业.*利润|利润总额.*工业企业/iu],
    ["采购经理指数", /PMI|采购经理指数/iu],
    ["国内生产总值", /GDP|国内生产总值/iu],
    ["居民消费价格", /CPI|消费者物价|居民消费价格/iu],
    ["生产者价格", /PPI|生产者价格/iu],
    ["个人消费支出价格", /PCE|个人消费支出价格/iu],
    ["非农就业", /非农/iu],
    ["就业与失业", /失业率|就业人数|初请失业金/iu],
    ["利率决议", /利率决议|政策利率|联邦基金利率|LPR|MLF/iu],
    ["货币供应", /M1|M2|M3|货币供应/iu],
    ["社会融资与信贷", /社会融资|新增贷款|信贷/iu],
    ["进出口与贸易", /进出口|出口|进口|贸易差额/iu],
    ["工业增加值", /工业增加值/iu],
    ["零售销售", /零售销售|社会消费品零售/iu],
    ["耐用品订单", /耐用品.*订单/iu],
    ["房价", /房价|住宅销售价格/iu],
    ["Ifo商业景气", /Ifo商业景气/iu],
  ];
  return families.find(([, expression]) => expression.test(title))?.[0] || "";
}

function humanizeTitle(row) {
  const raw = cleanText(row.FE_NAME);
  if (cleanText(row.FE_TYPE) !== "经济数据") return raw;
  const country = countryLabel(raw);
  const family = macroFamily(raw);
  const period = periodLabel(raw);
  if (family) return `${country || "全球"}${period}${family}数据公布`;
  return raw.replace(/\(报告期:[^)]+\)/g, "").replace(/:季调|:非季调|:累计值|:当月值|:同比|:环比/gu, "").trim();
}

function eventCategory(row, combined) {
  if (MARKET_RE.test(combined)) return "market";
  if (GEOPOLITICS_RE.test(combined)) return "geopolitics";
  if (cleanText(row.FE_TYPE) === "经济数据") return "macro";
  if (cleanText(row.FE_TYPE) === "行业会议" || INDUSTRY_RE.test(combined)) return "industry";
  return "policy";
}

function eventImportance(row, combined) {
  let score = 1;
  if (CRITICAL_EVENT_RE.test(combined)) score = 5;
  else if (IMPORTANT_EVENT_RE.test(combined)) score = 4;
  if (cleanText(row.FE_TYPE) === "经济数据" && MAJOR_MACRO_RE.test(combined)) {
    score = Math.max(score, DOMESTIC_RE.test(combined) || /美国|美联储/iu.test(combined) ? 5 : 4);
  }
  if (cleanText(row.FE_TYPE) === "行业会议" && INDUSTRY_RE.test(combined)) score = Math.max(score, 4);
  if (MARKET_RE.test(combined)) score = Math.max(score, 3);
  return Math.min(5, score);
}

function relatedSectors(combined) {
  const sectors = [];
  SECTOR_RULES.forEach((rule) => {
    if (rule.re.test(combined)) sectors.push(...rule.sectors);
  });
  return unique(sectors).slice(0, 6);
}

function eventReason(category, sectors, combined) {
  const sectorText = sectors.length ? `重点核对${sectors.join("、")}的资金与成交承接` : "重点核对主要指数、成交额和风险偏好的同步变化";
  if (category === "macro") return `宏观数据可能改变增长、通胀或流动性预期，${sectorText}。`;
  if (category === "policy") return `政策会议可能影响产业预期与资金配置方向，${sectorText}。`;
  if (category === "market") return `市场日历事件可能影响短期资金供需和风险偏好，${sectorText}。`;
  if (category === "industry") return `产业会议可能带来政策、订单或技术进展信息，${sectorText}。`;
  if (/关税|制裁|冲突|战争|停火/iu.test(combined)) return `地缘与贸易事件可能影响风险偏好、商品价格和外需预期，${sectorText}。`;
  return `国际事件可能通过汇率、利率或风险偏好传导至A股，${sectorText}。`;
}

function eventScope(combined) {
  return DOMESTIC_RE.test(combined) ? "domestic" : "international";
}

function eventKey(event) {
  if (event.category === "macro") {
    const family = macroFamily(event.originalTitles.join(" "));
    const country = countryLabel(event.originalTitles.join(" "));
    if (family) return `${event.startAt.slice(0, 16)}|${country}|${family}`;
  }
  return `${event.startAt.slice(0, 16)}|${event.title.replace(/\s+/g, "")}`;
}

function normalizeCalendarRow(row, bounds) {
  const startAt = cleanText(row.START_DATE);
  const endAt = cleanText(row.END_DATE || row.END_DATE_NEW || row.START_DATE);
  const sourceTitle = cleanText(row.FE_NAME);
  const content = cleanText(row.CONTENT);
  const sponsor = cleanText(row.SPONSOR_NAME);
  const city = cleanText(row.CITY);
  const combined = [sourceTitle, content, sponsor, city, row.FE_TYPE].join(" ");
  const category = eventCategory(row, combined);
  const importance = eventImportance(row, combined);
  const sectors = relatedSectors(combined);
  if (!sourceTitle) return null;
  if (category === "macro" && importance < 4) return null;
  if (category === "industry" && importance < 4 && !sectors.length) return null;
  if (!["macro", "industry"].includes(category) && importance < 3) return null;
  const startDate = parseSourceDate(startAt);
  const endDate = parseSourceDate(endAt);
  if (!startDate || !endDate || endDate < bounds.start || startDate >= bounds.endExclusive) return null;
  const title = humanizeTitle(row);
  const scope = eventScope(combined);
  return {
    id: "",
    startAt,
    endAt,
    date: localDateText(startDate < bounds.start ? bounds.start : startDate),
    weekday: weekdayLabel(startDate < bounds.start ? `${bounds.weekStart} 00:00:00` : startAt),
    time: timeLabel(startAt),
    title,
    originalTitles: [sourceTitle],
    category,
    categoryLabel: CATEGORY_LABELS[category],
    scope,
    scopeLabel: scope === "domestic" ? "国内" : "国际",
    importance,
    importanceLabel: importance >= 5 ? "核心" : importance >= 4 ? "重要" : "关注",
    content,
    sponsor,
    city,
    sectors,
    reason: eventReason(category, sectors, combined),
    ongoing: startDate < bounds.start,
    source: SOURCE_NAME,
    sourceUrl: SOURCE_URL,
  };
}

function mergeEvents(rows, bounds) {
  const merged = new Map();
  rows.map((row) => normalizeCalendarRow(row, bounds)).filter(Boolean).forEach((event) => {
    const key = eventKey(event);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, event);
      return;
    }
    existing.originalTitles = unique([...existing.originalTitles, ...event.originalTitles]);
    existing.sectors = unique([...existing.sectors, ...event.sectors]).slice(0, 6);
    existing.importance = Math.max(existing.importance, event.importance);
    existing.importanceLabel = existing.importance >= 5 ? "核心" : existing.importance >= 4 ? "重要" : "关注";
    existing.content = unique([existing.content, event.content]).filter(Boolean).join(" ");
    existing.sponsor = unique([existing.sponsor, event.sponsor]).filter(Boolean).join("、");
  });
  const candidates = Array.from(merged.values());
  const selected = candidates
    .sort((left, right) => right.importance - left.importance || left.startAt.localeCompare(right.startAt))
    .slice(0, MAX_EVENTS)
    .sort((left, right) => left.startAt.localeCompare(right.startAt) || right.importance - left.importance);
  return selected.map((event) => ({
    ...event,
    id: crypto.createHash("sha1").update(`${event.startAt}|${event.title}`, "utf8").digest("hex").slice(0, 16),
  }));
}

function buildOutput(rows, bounds, generatedAt = new Date().toISOString()) {
  const events = mergeEvents(rows, bounds);
  if (!events.length) throw new Error("公开财经日历没有返回符合筛选规则的下周关键事件");
  const coreEvents = events
    .filter((event) => event.importance >= 5)
    .sort((left, right) => left.startAt.localeCompare(right.startAt));
  const categories = Object.fromEntries(Object.keys(CATEGORY_LABELS).map((key) => [
    key,
    events.filter((event) => event.category === key).length,
  ]));
  return {
    version: 4,
    status: "ok",
    generatedAt,
    weekStart: bounds.weekStart,
    weekEnd: bounds.weekEnd,
    title: "下周大事件",
    summary: `目标周共筛出${events.length}项关键事件，其中核心事件${coreEvents.length}项；按时间顺序核对宏观、政策、市场、产业和国际地缘因素。`,
    stats: {
      total: events.length,
      core: coreEvents.length,
      domestic: events.filter((event) => event.scope === "domestic").length,
      international: events.filter((event) => event.scope === "international").length,
      categories,
    },
    coreFocus: coreEvents.slice(0, 8).map((event) => ({
      id: event.id,
      date: event.date,
      time: event.time,
      title: event.title,
      sectors: event.sectors,
      relatedStocks: [],
    })),
    events: events.map((event) => ({...event, relatedStocks: []})),
    relatedStocksStatus: {
      status: "pending",
      coveredEvents: 0,
      targetEvents: events.filter((event) => event.sectors.length).length,
      stockCount: 0,
      profileCovered: 0,
      source: "东方财富板块成分股与F10公司资料",
      generatedAt: "",
    },
    source: {
      name: SOURCE_NAME,
      url: SOURCE_URL,
      fetchedRows: rows.length,
      constituentSource: "东方财富行业/概念板块成分股与F10公司资料",
      filter: `事件与目标周 ${bounds.weekStart} 至 ${bounds.weekEnd} 有日期交集，并通过A股相关性和重要程度筛选。`,
    },
    warnings: [
      "日历事件的时间和议程可能临时调整，页面更新时重新核对公开来源。",
      "影响板块只表示需要观察的传导方向，不代表涨跌预测。",
      "关联个股按公开板块成分和总市值排序选取；理由逐项列明事件触发因素、公司主营环节和验证指标，不等同于公司已披露直接事项。",
    ],
  };
}

async function fetchBoardApi(pathname, parameters, options = {}) {
  let lastError = null;
  for (const host of BOARD_API_HOSTS) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) || 16000);
      try {
        const query = new URLSearchParams(parameters);
        const response = await fetch(`${host}${pathname}?${query}`, {
          headers: {
            ...REQUEST_HEADERS,
            "Referer": "https://quote.eastmoney.com/center/boardlist.html",
          },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        if (!json?.data) throw new Error("接口没有返回有效板块数据");
        return json;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 260 * attempt));
      } finally {
        clearTimeout(timer);
      }
    }
  }
  throw new Error(lastError?.name === "AbortError" ? "板块接口请求超时" : lastError?.message || "板块接口请求失败");
}

async function fetchBoardDirectory(boardType) {
  const rows = [];
  for (let page = 1; page <= 7; page += 1) {
    const json = await fetchBoardApi("/api/qt/clist/get", {
      pn: String(page),
      pz: "100",
      po: "1",
      np: "1",
      fltt: "2",
      invt: "2",
      fid: "f20",
      fs: `m:90+t:${boardType}`,
      fields: "f12,f14,f3,f20",
    });
    const batch = Array.isArray(json?.data?.diff) ? json.data.diff : [];
    rows.push(...batch.map((row) => ({
      code: cleanText(row?.f12),
      name: cleanText(row?.f14),
      type: boardType === 2 ? "industry" : "concept",
      changePct: finite(row?.f3),
      totalMarketCap: finite(row?.f20),
    })).filter((row) => /^BK\d{4}$/i.test(row.code) && row.name));
    if (batch.length < 100 || rows.length >= Number(json?.data?.total || 0)) break;
  }
  return rows;
}

function boardMatchScore(sector, board) {
  const target = cleanText(sector);
  const name = cleanText(board?.name);
  if (!target || !name) return -1;
  if (name === target) return 100 + (board.type === "industry" ? 4 : 0);
  const aliases = BOARD_ALIASES[target] || [];
  const aliasIndex = aliases.indexOf(name);
  if (aliasIndex >= 0) return 92 - aliasIndex + (board.type === "industry" ? 3 : 0);
  if (name.includes(target) || target.includes(name)) return 76 + (board.type === "industry" ? 3 : 0);
  const partialAliasIndex = aliases.findIndex((alias) => name.includes(alias) || alias.includes(name));
  return partialAliasIndex >= 0 ? 66 - partialAliasIndex + (board.type === "industry" ? 2 : 0) : -1;
}

function matchingBoards(sector, directory) {
  return (directory || [])
    .map((board) => ({board, score: boardMatchScore(sector, board)}))
    .filter((item) => item.score >= 0)
    .sort((left, right) => right.score - left.score || Number(right.board.totalMarketCap || 0) - Number(left.board.totalMarketCap || 0))
    .slice(0, 2)
    .map((item) => item.board);
}

function stockMarket(code) {
  if (/^(430|83\d|87\d|920)/.test(code)) return {market: 0, marketLabel: "北交所"};
  if (/^(6|9)/.test(code)) return {market: 1, marketLabel: "上交所"};
  return {market: 0, marketLabel: "深交所"};
}

function f10Code(code) {
  const text = cleanText(code);
  if (/^(430|83\d|87\d|920)/.test(text)) return `BJ${text}`;
  if (/^(6|9)/.test(text)) return `SH${text}`;
  return `SZ${text}`;
}

function usableCompanyProfile(profile) {
  return Boolean(cleanText(profile?.intro || profile?.businessScope));
}

async function fetchCompanyProfile(stock) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const url = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax?code=${encodeURIComponent(f10Code(stock.code))}`;
    const response = await fetch(url, {
      headers: {
        ...REQUEST_HEADERS,
        "Referer": `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/Index?type=web&code=${encodeURIComponent(f10Code(stock.code))}`,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const row = (await response.json())?.jbzl || {};
    const profile = {
      code: cleanText(stock.code),
      name: cleanText(row.agjc || stock.name),
      fullName: cleanText(row.gsmc),
      industry: cleanText(row.sshy || row.sszjhhy || stock.sector),
      intro: cleanText(row.gsjj),
      businessScope: cleanText(row.jyfw),
      source: "东方财富F10公司资料",
      fetchedAt: new Date().toISOString(),
    };
    if (!usableCompanyProfile(profile)) throw new Error("F10公司资料缺少主营介绍");
    return profile;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("F10公司资料请求超时");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCompanyProfiles(stocks, options = {}) {
  const uniqueStocks = unique((stocks || []).map((stock) => cleanText(stock?.code)))
    .map((code) => (stocks || []).find((stock) => cleanText(stock?.code) === code))
    .filter(Boolean);
  const profiles = new Map();
  const errors = [];
  if (typeof options.profileResolver === "function") {
    await mapLimit(uniqueStocks, 5, async (stock) => {
      try {
        const profile = await options.profileResolver(stock);
        if (usableCompanyProfile(profile)) profiles.set(stock.code, profile);
        else errors.push(`${stock.name}(${stock.code})：公司资料不完整`);
      } catch (error) {
        errors.push(`${stock.name}(${stock.code})：${error.message}`);
      }
    });
    return {profiles, errors};
  }

  const cachePath = path.resolve(options.profileCachePath || defaultProfileCachePath());
  const existing = readJson(cachePath);
  const cache = existing && typeof existing === "object" && existing.profiles
    ? existing
    : {version: 1, generatedAt: "", profiles: {}};
  let changed = false;
  await mapLimit(uniqueStocks, 6, async (stock) => {
    const cached = cache.profiles?.[stock.code];
    const cachedMs = Date.parse(cached?.fetchedAt || "");
    if (usableCompanyProfile(cached) && Number.isFinite(cachedMs) && Date.now() - cachedMs < COMPANY_PROFILE_CACHE_MS) {
      profiles.set(stock.code, cached);
      return;
    }
    try {
      const profile = await fetchCompanyProfile(stock);
      profiles.set(stock.code, profile);
      cache.profiles[stock.code] = profile;
      changed = true;
    } catch (error) {
      if (usableCompanyProfile(cached)) profiles.set(stock.code, cached);
      else errors.push(`${stock.name}(${stock.code})：${error.message}`);
    }
  });
  if (changed || !existing) {
    cache.generatedAt = new Date().toISOString();
    writeJsonAtomic(cachePath, cache);
  }
  return {profiles, errors};
}

async function fetchBoardConstituents(board, sector) {
  const json = await fetchBoardApi("/api/qt/clist/get", {
    pn: "1",
    pz: "16",
    po: "1",
    np: "1",
    fltt: "2",
    invt: "2",
    fid: "f20",
    fs: `b:${board.code}`,
    fields: "f12,f14,f2,f3,f6,f20,f21",
  });
  const rows = Array.isArray(json?.data?.diff) ? json.data.diff : [];
  return rows.map((row) => {
    const code = cleanText(row?.f12);
    const name = cleanText(row?.f14);
    if (!A_SHARE_CODE_RE.test(code) || !name || /退市|退整理|N[A-Z]/u.test(name) || finite(row?.f20) === null) return null;
    return {
      code,
      name,
      ...stockMarket(code),
      sector,
      boardCode: board.code,
      boardName: board.name,
      boardType: board.type,
      price: finite(row?.f2),
      changePct: finite(row?.f3),
      amount: finite(row?.f6),
      totalMarketCap: finite(row?.f20),
      floatMarketCap: finite(row?.f21),
      source: "东方财富板块成分股",
    };
  }).filter(Boolean)
    .sort((left, right) => Number(right.totalMarketCap || 0) - Number(left.totalMarketCap || 0));
}

async function createSectorStocksResolver() {
  const directoryRows = await Promise.all([
    fetchBoardDirectory(2),
    fetchBoardDirectory(3),
  ]);
  const directory = directoryRows.flat();
  const boardCache = new Map();
  return async (sector) => {
    const boards = matchingBoards(sector, directory);
    if (!boards.length) return [];
    const stockGroups = await mapLimit(boards, 2, async (board) => {
      if (!boardCache.has(board.code)) {
        boardCache.set(board.code, fetchBoardConstituents(board, sector).catch(() => []));
      }
      return boardCache.get(board.code);
    });
    const stocks = [];
    stockGroups.flat().forEach((stock) => {
      if (!stocks.some((item) => item.code === stock.code)) stocks.push({...stock, sector});
    });
    return stocks
      .sort((left, right) => Number(right.totalMarketCap || 0) - Number(left.totalMarketCap || 0))
      .slice(0, 10);
  };
}

function selectEventStocks(event, sectorStocks) {
  const selected = [];
  const sectors = (event.sectors || []).slice(0, 4);
  sectors.forEach((sector) => {
    const candidate = (sectorStocks.get(sector) || []).find((stock) => !selected.some((item) => item.code === stock.code));
    if (candidate) selected.push(candidate);
  });
  let depth = 1;
  while (selected.length < MAX_RELATED_STOCKS && depth < 10) {
    let added = false;
    sectors.forEach((sector) => {
      const candidate = (sectorStocks.get(sector) || [])[depth];
      if (candidate && !selected.some((item) => item.code === candidate.code) && selected.length < MAX_RELATED_STOCKS) {
        selected.push(candidate);
        added = true;
      }
    });
    if (!added && depth >= 9) break;
    depth += 1;
  }
  return selected.slice(0, MAX_RELATED_STOCKS);
}

function stockRelationReason(event, stock, profile = {}) {
  return stockRelationDetails(event, stock, profile).relationReason;
}

async function attachRelatedStocks(data, options = {}) {
  const existingById = new Map((options.existing?.events || []).map((event) => [event.id, event.relatedStocks || []]));
  const existingByTitle = new Map((options.existing?.events || []).map((event) => [event.title, event.relatedStocks || []]));
  const sectors = unique((data.events || []).flatMap((event) => event.sectors || []));
  let resolver = options.sectorStocksResolver;
  const errors = [];
  if (typeof resolver !== "function") {
    try {
      resolver = await createSectorStocksResolver();
    } catch (error) {
      errors.push(`板块目录：${error.message}`);
    }
  }
  const sectorStocks = new Map();
  if (typeof resolver === "function") {
    await mapLimit(sectors, 5, async (sector) => {
      try {
        sectorStocks.set(sector, await resolver(sector));
      } catch (error) {
        sectorStocks.set(sector, []);
        errors.push(`${sector}：${error.message}`);
      }
    });
  }
  const eventsWithStocks = (data.events || []).map((event) => {
    const liveRows = selectEventStocks(event, sectorStocks);
    const retainedRows = existingById.get(event.id) || existingByTitle.get(event.title) || [];
    const selectedRows = liveRows.length ? liveRows : retainedRows.slice(0, MAX_RELATED_STOCKS);
    return {
      ...event,
      relatedStocks: selectedRows,
    };
  });
  const uniqueStocks = [];
  eventsWithStocks.flatMap((event) => event.relatedStocks || []).forEach((stock) => {
    if (!uniqueStocks.some((item) => item.code === stock.code)) uniqueStocks.push(stock);
  });
  const profileState = await resolveCompanyProfiles(uniqueStocks, {
    profileResolver: options.profileResolver,
    profileCachePath: options.profileCachePath,
  });
  errors.push(...profileState.errors.map((error) => `公司资料：${error}`));
  data.events = eventsWithStocks.map((event) => ({
    ...event,
    relatedStocks: (event.relatedStocks || []).map((stock) => {
      const profile = profileState.profiles.get(stock.code) || stock.companyProfile || {};
      const details = stockRelationDetails(event, stock, profile);
      return {
        ...stock,
        relationType: "具体事件与公司业务传导",
        eventCause: details.eventCause,
        companyBusiness: details.companyBusiness,
        companyLink: details.companyLink,
        watchPoint: details.watchPoint,
        relationReason: details.relationReason,
        relationDisclaimer: "公司主营资料来自东方财富F10；事件传导用于复盘验证，不代表公司已披露直接事项。",
        companyProfile: {
          fullName: cleanText(profile.fullName),
          industry: cleanText(profile.industry || stock.sector),
          businessIntro: details.companyBusiness,
          source: cleanText(profile.source) || "东方财富F10公司资料",
          fetchedAt: cleanText(profile.fetchedAt),
        },
      };
    }),
  }));
  const byId = new Map(data.events.map((event) => [event.id, event]));
  data.coreFocus = (data.coreFocus || []).map((item) => ({
    ...item,
    relatedStocks: (byId.get(item.id)?.relatedStocks || []).slice(0, 2),
  }));
  const targetEvents = data.events.filter((event) => event.sectors?.length);
  const coveredEvents = targetEvents.filter((event) => event.relatedStocks?.length);
  const uniqueStockCodes = new Set(data.events.flatMap((event) => (event.relatedStocks || []).map((stock) => stock.code)));
  data.relatedStocksStatus = {
    status: coveredEvents.length === targetEvents.length ? "ok" : coveredEvents.length ? "partial" : "error",
    coveredEvents: coveredEvents.length,
    targetEvents: targetEvents.length,
    stockCount: uniqueStockCodes.size,
    profileCovered: profileState.profiles.size,
    source: "东方财富行业/概念板块成分股与F10公司资料",
    generatedAt: new Date().toISOString(),
    errors: errors.slice(0, 8),
  };
  if (coveredEvents.length < targetEvents.length) {
    data.warnings = unique([
      ...(data.warnings || []),
      `关联个股已覆盖${coveredEvents.length}/${targetEvents.length}项含行业事件；未覆盖项不使用推测个股补足。`,
    ]);
  }
  return data;
}

async function fetchCalendarRows(bounds) {
  const filter = `(END_DATE>='${bounds.weekStart}')(START_DATE<'${localDateText(bounds.endExclusive)}')`;
  const params = new URLSearchParams({
    reportName: "RPT_CPH_FECALENDAR",
    pageNumber: "1",
    pageSize: "500",
    sortColumns: "START_DATE",
    sortTypes: "1",
    filter,
    source: "WEB",
    client: "WEB",
    columns: "ALL",
  });
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`${CALENDAR_API}?${params}`, {
        headers: REQUEST_HEADERS,
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      const rows = Array.isArray(json?.result?.data) ? json.result.data : [];
      if (!json?.success || !rows.length) throw new Error(json?.message || "接口没有返回日历事件");
      return rows;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError?.name === "AbortError" ? "财经日历接口请求超时" : lastError?.message || "财经日历接口请求失败");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), "utf8");
  fs.rmSync(filePath, {force: true});
  fs.renameSync(temporary, filePath);
}

function argumentValue(prefix) {
  const match = process.argv.find((value) => value.startsWith(`${prefix}=`));
  return match ? match.slice(prefix.length + 1) : "";
}

function defaultOutputPath() {
  return path.resolve(__dirname, "..", "data", "next-week-events.json");
}

function defaultProfileCachePath() {
  return path.resolve(__dirname, "..", "data", "next-week-company-profiles.json");
}

async function update(options = {}) {
  const outputPath = path.resolve(options.outputPath || defaultOutputPath());
  const bounds = targetWeekBounds(options.reference || new Date());
  const existing = readJson(outputPath);
  const generatedMs = Date.parse(existing?.generatedAt || "");
  if (!options.force && existing?.weekStart === bounds.weekStart && Number.isFinite(generatedMs) && Date.now() - generatedMs < REFRESH_WINDOW_MS) {
    return {ok: true, skipped: true, outputPath, data: existing};
  }
  const rows = await fetchCalendarRows(bounds);
  const data = await attachRelatedStocks(buildOutput(rows, bounds), {
    existing,
    profileCachePath: options.profileCachePath || path.join(path.dirname(outputPath), "next-week-company-profiles.json"),
  });
  writeJsonAtomic(outputPath, data);
  return {ok: true, skipped: false, outputPath, data};
}

async function runSelfTest() {
  const reference = new Date(2026, 6, 26, 12, 0, 0);
  const bounds = targetWeekBounds(reference);
  const rows = [
    {START_DATE: "2026-07-27 09:30:00", END_DATE: "2026-07-27 09:30:00", FE_NAME: "中国:利润总额:规模以上工业企业:累计值(报告期:2026年06月)", FE_TYPE: "经济数据", CONTENT: ""},
    {START_DATE: "2026-07-27 09:30:00", END_DATE: "2026-07-27 09:30:00", FE_NAME: "中国:利润总额:规模以上工业企业:累计同比(报告期:2026年06月)", FE_TYPE: "经济数据", CONTENT: ""},
    {START_DATE: "2026-07-29 02:00:00", END_DATE: "2026-07-29 02:00:00", FE_NAME: "美联储公布利率决议", FE_TYPE: "其他", CONTENT: ""},
    {START_DATE: "2026-07-30 00:00:00", END_DATE: "2026-07-31 00:00:00", FE_NAME: "世界人工智能产业大会", FE_TYPE: "行业会议", CONTENT: "展示算力、芯片和机器人进展"},
    {START_DATE: "2026-07-30 10:00:00", END_DATE: "2026-07-30 10:00:00", FE_NAME: "小型国家一般库存数据", FE_TYPE: "经济数据", CONTENT: ""},
  ];
  const data = buildOutput(rows, bounds, "2026-07-26T04:00:00.000Z");
  if (bounds.weekStart !== "2026-07-27" || bounds.weekEnd !== "2026-08-02") throw new Error("目标周计算自检失败");
  if (data.events.length !== 3) throw new Error(`事件筛选或去重自检失败：${data.events.length}；${data.events.map((event) => event.title).join("；")}`);
  if (!data.events.some((event) => event.title.includes("工业企业利润"))) throw new Error("宏观标题归一化自检失败");
  if (!data.events.some((event) => event.sectors.includes("半导体"))) throw new Error("产业板块映射自检失败");
  await attachRelatedStocks(data, {
    sectorStocksResolver: async (sector) => [{
      code: sector === "半导体" ? "688981" : "600000",
      name: sector === "半导体" ? "中芯国际" : "浦发银行",
      ...stockMarket(sector === "半导体" ? "688981" : "600000"),
      sector,
      totalMarketCap: 100000000000,
      source: "自检样本",
    }],
    profileResolver: async (stock) => ({
      code: stock.code,
      name: stock.name,
      industry: stock.sector,
      intro: stock.code === "688981"
        ? "公司主要从事集成电路晶圆代工，并提供不同技术节点的晶圆制造服务。"
        : "公司主要从事商业银行业务，包括公司贷款、个人金融和资金业务。",
      businessScope: "",
      source: "自检公司资料",
      fetchedAt: new Date().toISOString(),
    }),
  });
  if (!data.events.every((event) => !event.sectors.length || event.relatedStocks.length)) throw new Error("事件关联个股自检失败");
  if (!data.events.some((event) => event.relatedStocks.some((stock) => stock.code === "688981" && stock.sector === "半导体"))) {
    throw new Error("关联个股行业映射自检失败");
  }
  if (!data.events.every((event) => (event.relatedStocks || []).every((stock) =>
    stock.eventCause?.includes(event.title) &&
    stock.companyBusiness?.includes("主要从事") &&
    stock.companyLink &&
    stock.watchPoint &&
    stock.relationReason?.includes("事件成因") &&
    stock.relationReason?.includes("公司关联") &&
    stock.relationReason?.includes("验证点") &&
    !stock.relationReason?.includes("板块依据") &&
    stock.relationDisclaimer?.includes("不代表公司已披露")
  ))) {
    throw new Error("关联个股理由自检失败");
  }
  process.stdout.write("下周大事件更新服务自检通过\n");
}

module.exports = {
  attachRelatedStocks,
  buildOutput,
  mergeEvents,
  stockRelationReason,
  targetWeekBounds,
  update,
};

if (require.main === module) {
  if (process.argv.includes("--self-test")) {
    runSelfTest().catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
  } else {
    update({
      force: process.argv.includes("--force"),
      outputPath: argumentValue("--output") || defaultOutputPath(),
    }).then((result) => {
      process.stdout.write(JSON.stringify({
        ok: true,
        skipped: result.skipped,
        outputPath: result.outputPath,
        weekStart: result.data.weekStart,
        weekEnd: result.data.weekEnd,
        eventCount: result.data.events.length,
        coreCount: result.data.stats.core,
        generatedAt: result.data.generatedAt,
      }) + "\n");
    }).catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
  }
}
