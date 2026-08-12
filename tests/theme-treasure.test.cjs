const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {createThemeTreasureService} = require("../app/backend/theme-treasure");
const modelPromise = import("../app/assets/js/theme-treasure-model.js");

const snapshot = {
  ok: true,
  active: true,
  tradeDate: "2026-08-07",
  sourceTime: "14:58:30",
  sourceTimestamp: 1786090710,
  source: "test-real-snapshot",
  groups: {
    concept: {
      rows: [
        {code: "BK1001", name: "机器人概念", amount: 28, changePct: 4.2, upCount: 82, downCount: 11, leaderName: "甲公司", leaderCode: "300001", leaderMarket: 0, leaderChangePct: 18},
        {code: "BK1002", name: "交换机", amount: 12, changePct: 2.1, upCount: 31, downCount: 14, leaderName: "乙公司", leaderCode: "600002", leaderMarket: 1, leaderChangePct: 10},
        {code: "BK1003", name: "医药商业", amount: -7, changePct: 0.8, upCount: 18, downCount: 21, leaderName: "丙公司", leaderCode: "000003", leaderMarket: 0, leaderChangePct: 5},
        {code: "BK1004", name: "光伏概念", amount: -16, changePct: -2.6, upCount: 9, downCount: 64, leaderName: "丁公司", leaderCode: "600004", leaderMarket: 1, leaderChangePct: 1},
        {code: "BK1005", name: "融资融券", amount: 120, changePct: 1.5, upCount: 2100, downCount: 1500, leaderName: "戊公司", leaderCode: "000005", leaderMarket: 0, leaderChangePct: 10},
        {code: "BK1006", name: "昨日炸板", amount: 80, changePct: 2.5, upCount: 50, downCount: 20, leaderName: "己公司", leaderCode: "000006", leaderMarket: 0, leaderChangePct: 10},
        {code: "BK1007", name: "上证50_", amount: 70, changePct: 1.2, upCount: 30, downCount: 20, leaderName: "庚公司", leaderCode: "600007", leaderMarket: 1, leaderChangePct: 8},
        {code: "BK1008", name: "ST股", amount: 1, changePct: 0, upCount: 0, downCount: 0, leaderName: "", leaderCode: "", leaderMarket: 0, leaderChangePct: null},
      ],
    },
  },
};

test("theme ranking keeps every Eastmoney concept and supports an explicit generic filter", async () => {
  const {buildThemeRanking} = await modelPromise;
  const comprehensive = buildThemeRanking(snapshot, {sort: "score", limit: 20});
  assert.equal(comprehensive.ok, true);
  assert.equal(comprehensive.total, 8);
  assert.equal(comprehensive.reportedTotal, 8);
  assert.equal(comprehensive.genericCount, 4);
  assert.equal(comprehensive.excludedGenericCount, 0);
  assert.match(comprehensive.methodology, /应用内排序指标/);
  assert.doesNotMatch(JSON.stringify(comprehensive), /政策利好|消息刺激|资金抢筹/);

  const flow = buildThemeRanking(snapshot, {sort: "flow", limit: 20});
  assert.deepEqual(flow.items.map((item) => item.name), ["融资融券", "昨日炸板", "上证50_", "机器人概念", "交换机", "ST股", "医药商业", "光伏概念"]);
  const filtered = buildThemeRanking(snapshot, {sort: "flow", limit: 20, includeGeneric: false});
  assert.equal(filtered.total, 4);
  assert.equal(filtered.excludedGenericCount, 4);
  const change = buildThemeRanking(snapshot, {sort: "change", query: "医药"});
  assert.equal(change.items.length, 1);
  assert.equal(change.items[0].code, "BK1003");
});

test("theme interpretation discloses divergence instead of inventing a cause", async () => {
  const {buildThemeRanking} = await modelPromise;
  const ranking = buildThemeRanking(snapshot, {sort: "score", limit: 20});
  const divergence = ranking.items.find((item) => item.code === "BK1003");
  assert.match(divergence.interpretation.headline, /分歧/);
  assert.ok(divergence.interpretation.evidence.every((item) => /%|亿元|上涨|下跌|领涨股/.test(item)));
});

test("theme graph assigns factual stock roles and keeps complete relation text", async () => {
  const {buildThemeDetail, buildThemeRanking} = await modelPromise;
  const theme = buildThemeRanking(snapshot, {sort: "score", limit: 20}).items[0];
  const detail = buildThemeDetail(theme, [
    {code: "300001", name: "甲公司", market: 0, changePct: 18, amount: 32, industry: "自动化设备"},
    {code: "600010", name: "核心公司", market: 1, changePct: 5.2, amount: 22, industry: "通用设备"},
    {code: "000011", name: "跟随公司", market: 0, changePct: 1.1, amount: 8, industry: "专用设备"},
    {code: "600012", name: "*ST分歧公司", market: 1, changePct: -2.4, amount: 6, industry: "自动化设备"},
  ]);
  assert.equal(detail.constituentCount, 4);
  assert.deepEqual(detail.groups.map((group) => group.role), ["领涨", "核心", "跟随", "分歧"]);
  detail.constituents.forEach((stock) => {
    assert.match(stock.relationReason, /公开成分股/);
    assert.doesNotMatch(stock.relationReason, /\.\.\.|…/);
  });
  assert.equal(detail.constituents.find((stock) => stock.code === "600012").riskFlag, true);
  assert.match(detail.constituents.find((stock) => stock.code === "600012").relationReason, /风险警示/);
});

test("theme constituent API paginates beyond the first 80 and returns the complete board", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    const target = new URL(String(url));
    const page = Number(target.searchParams.get("pn"));
    const pageSize = Number(target.searchParams.get("pz"));
    requests.push({page, pageSize});
    const start = (page - 1) * pageSize;
    const count = Math.max(0, Math.min(pageSize, 205 - start));
    return {
      ok: true,
      status: 200,
      json: async () => ({data: {
        total: 205,
        diff: Array.from({length: count}, (_, index) => {
          const sequence = start + index + 1;
          return {
            f12: String(sequence).padStart(6, "0"),
            f13: 0,
            f14: sequence === 205 ? "*ST样例公司205" : `样例公司${sequence}`,
            f2: 10,
            f3: sequence % 9,
            f6: 100000000 + sequence,
            f8: 1,
            f20: 100,
            f21: 90,
            f100: "测试行业",
            f103: "测试题材",
          };
        }),
      }}),
    };
  };
  const rows = await require("../app/backend/theme-treasure").fetchBoardConstituents(fetchImpl, "BK1002");
  assert.equal(rows.length, 205);
  assert.equal(rows.reportedTotal, 205);
  assert.equal(rows.pageCount, 3);
  assert.equal(rows.complete, true);
  assert.equal(rows.find((item) => item.code === "000205").riskFlag, true);
  assert.deepEqual(requests.map((item) => item.page), [1, 2, 3]);
  assert.ok(requests.every((item) => item.pageSize === 100));
});

test("theme graph keeps every verified constituent instead of capping role groups", async () => {
  const {buildThemeDetail, buildThemeRanking} = await modelPromise;
  const theme = buildThemeRanking(snapshot, {sort: "score", limit: 20}).items[0];
  const rows = Array.from({length: 135}, (_, index) => ({
    code: String(index + 1).padStart(6, "0"),
    name: `完整成分${index + 1}`,
    market: 0,
    changePct: (index % 15) - 5,
    amount: 200 - index,
    industry: "测试行业",
  }));
  const detail = buildThemeDetail(theme, rows, {
    reportedTotal: 138,
    excludedCount: 3,
    pageCount: 2,
    complete: true,
  });
  assert.equal(detail.constituentCount, 135);
  assert.equal(detail.reportedConstituentCount, 138);
  assert.equal(detail.excludedConstituentCount, 3);
  assert.equal(detail.constituents.length, 135);
  assert.equal(detail.groups.reduce((total, group) => total + group.items.length, 0), 135);
  assert.match(detail.interpretation.headline, /已完整核验135只东财公开成分股/);
});

test("company profile uses verified business text and direct topic evidence without invented claims", async () => {
  const {buildCompanyThemeProfile} = await modelPromise;
  const profile = buildCompanyThemeProfile(
    {code: "BK1002", name: "交换机"},
    {code: "000938", name: "紫光股份", role: "核心", changePct: 3.2, amount: 18, industry: "通信设备", concepts: ["交换机", "算力"]},
    {jbzl: {
      gsmc: "紫光股份有限公司",
      sshy: "电子信息",
      gsjj: "公司持续深耕信息通信领域。公司提供网络设备、服务器、存储产品和数字化解决方案。",
    }},
    {fetchedAt: "2026-08-10T10:00:00.000Z"},
  );
  assert.equal(profile.company.name, "紫光股份有限公司");
  assert.deepEqual(profile.matchingConcepts, ["交换机"]);
  assert.match(profile.relationReason, /公开概念标签中与该题材直接匹配的是“交换机”/);
  assert.match(profile.businessSummary, /网络设备/);
  assert.doesNotMatch(JSON.stringify(profile), /市占率|华为代工|\.\.\.|…/);
});

test("company profile API verifies membership and caches the F10 response", async (t) => {
  const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), "theme-treasure-company-"));
  t.after(() => fs.rmSync(temporaryData, {recursive: true, force: true}));
  let boardRequests = 0;
  let profileRequests = 0;
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes("/api/qt/clist/get")) {
      boardRequests += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({data: {diff: [
          {f12: "000938", f13: 0, f14: "紫光股份", f2: 31, f3: 3.2, f6: 1800000000, f8: 2.1, f20: 100, f21: 90, f100: "通信设备", f103: "交换机,算力"},
          {f12: "000977", f13: 0, f14: "浪潮信息", f2: 51, f3: 2.1, f6: 1500000000, f8: 3.2, f20: 100, f21: 90, f100: "计算机设备", f103: "交换机,算力"},
          {f12: "600498", f13: 1, f14: "烽火通信", f2: 22, f3: 1.1, f6: 900000000, f8: 1.8, f20: 100, f21: 90, f100: "通信设备", f103: "交换机,光通信"},
        ]}}),
      };
    }
    if (target.includes("CompanySurveyAjax")) {
      profileRequests += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({jbzl: {
          gsmc: "紫光股份有限公司",
          agjc: "紫光股份",
          sshy: "电子信息",
          gsjj: "公司提供网络设备、服务器、存储产品和数字化解决方案。",
        }}),
      };
    }
    throw new Error(`unexpected request: ${target}`);
  };
  const service = createThemeTreasureService({
    dataDir: temporaryData,
    fetchImpl,
    now: () => new Date("2026-08-10T10:00:00.000Z"),
    liveSectorFlow: {getSnapshot: async () => snapshot, forceRefresh: async () => snapshot},
  });
  const first = await service.company("BK1002", "000938");
  const second = await service.company("BK1002", "000938");
  assert.equal(first.company.name, "紫光股份有限公司");
  assert.match(first.relationReason, /交换机/);
  assert.equal(second.businessSummary, first.businessSummary);
  assert.equal(boardRequests, 1);
  assert.equal(profileRequests, 1);
  await assert.rejects(() => service.company("BK1002", "000001"), /不在当前题材已核验的成分股中/);
});

test("theme page is a full-width no-horizontal-scroll workspace", () => {
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "app", "pages", "theme-treasure.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "app", "assets", "css", "theme-treasure.css"), "utf8");
  const page = fs.readFileSync(path.join(root, "app", "assets", "js", "theme-treasure-page.js"), "utf8");
  assert.match(html, /题材榜单/);
  assert.match(html, /题材解读/);
  assert.match(html, /题材图谱/);
  assert.match(html, /id="themeCompanyDialog"/);
  assert.match(html, /与题材最相关的公司说明/);
  assert.match(html, /membership-guard\.js/);
  assert.match(css, /grid-template-columns:\s*minmax\(430px/);
  assert.match(css, /@media \(max-width: 920px\)/);
  assert.match(page, /state\.ranking\?\.active \? 3000 : 30000/);
  assert.match(page, /refreshThemeTreasure/);
  assert.match(page, /loadThemeStockProfile/);
  assert.match(page, /openCompanyProfile/);
  assert.match(page, /event\.stopPropagation\(\)/);
  assert.match(page, /event\.key === "Escape"/);
  assert.match(page, /openTdxStock/);
});

test("mobile theme treasure verifies membership before loading company profile", () => {
  const root = path.resolve(__dirname, "..");
  const shim = fs.readFileSync(path.join(root, "mobile", "mobile-api-shim.js"), "utf8");
  const live = fs.readFileSync(path.join(root, "mobile", "mobile-live.js"), "utf8");
  assert.match(shim, /\/api\/v1\/theme-treasure\/company/);
  assert.match(shim, /themeAccessResponse\(\)/);
  assert.match(shim, /该股票不在当前题材已核验的成分股中/);
  assert.match(shim, /buildCompanyThemeProfile/);
  assert.match(shim, /companySurveyCacheMs\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(live, /RPT_F10_BASIC_ORGINFO/);
  assert.match(live, /loadCompanySurvey/);
  assert.match(live, /ORG_PROFILE/);
  assert.match(live, /BUSINESS_SCOPE/);
  assert.match(live, /CONSTITUENT_PAGE_SIZE\s*=\s*100/);
  assert.match(live, /BOARD_PAGE_SIZE\s*=\s*100/);
  assert.match(live, /rows\.length !== reportedRows/);
  assert.match(live, /for \(let pageNumber = 2; pageNumber <= pageCount; pageNumber \+= 1\)/);
});
