const AShareThemeTreasureModel = (function createThemeTreasureModel() {
  "use strict";

  const GENERIC_TOPIC_RE = /^(融资融券|沪股通|深股通|标准普尔|MSCI中国|富时罗素|机构重仓|证金持股|社保重仓|QFII重仓|基金重仓|昨日涨停|昨日连板|昨日触板|昨日炸板|昨日高振幅|ST股|百元股|低价股|小盘股|中盘股|大盘股|小盘成长|中盘成长|大盘成长|小盘价值|中盘价值|大盘价值|先进制造风格|科技风格|医药医疗风格|高市净率|低市净率|高市盈率|低市盈率|上证\d+_?|HS\d+_?|沪深\d+_?|中证\d+_?|题材股|趋势股|东方财富热股|转债标的|AH股|股权激励)$/u;
  const SORT_KEYS = new Set(["score", "change", "flow", "breadth"]);

  function finite(value) {
    if (value === null || value === undefined || value === "" || value === "-") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function round(value, digits = 2) {
    const number = finite(value);
    if (number === null) return null;
    const factor = 10 ** digits;
    return Math.round(number * factor) / factor;
  }

  function clamp(value, minimum = 0, maximum = 100) {
    return Math.max(minimum, Math.min(maximum, Number(value) || 0));
  }

  function cleanText(value, maximum = 80) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
  }

  function cleanLongText(value, maximum = 6000) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
  }

  function marketFromCode(code, explicitMarket = null) {
    const normalized = String(code || "").replace(/\D/g, "").slice(-6);
    const market = finite(explicitMarket);
    if (market !== null) return market;
    return /^(5|6|9)/.test(normalized) ? 1 : 0;
  }

  function normalizeThemeRow(raw) {
    const code = cleanText(raw?.code || raw?.f12, 16).toUpperCase();
    const name = cleanText(raw?.name || raw?.f14, 40);
    const amount = finite(raw?.amount) ?? (finite(raw?.amountYuan ?? raw?.f62) === null
      ? null
      : Number(raw?.amountYuan ?? raw?.f62) / 100000000);
    const changePct = finite(raw?.changePct ?? raw?.f3);
    const upCount = finite(raw?.upCount ?? raw?.f104);
    const downCount = finite(raw?.downCount ?? raw?.f105);
    const leaderCode = cleanText(raw?.leaderCode || raw?.leader?.code || raw?.f140, 12);
    const leaderName = cleanText(raw?.leaderName || raw?.leader?.name || raw?.f128, 40);
    const leaderChangePct = finite(raw?.leaderChangePct ?? raw?.leader?.changePct ?? raw?.f136);
    const covered = (upCount || 0) + (downCount || 0);
    return {
      code,
      name,
      amount: round(amount, 4),
      amountYuan: amount === null ? null : Math.round(amount * 100000000),
      changePct: round(changePct, 4),
      upCount: upCount === null ? null : Math.max(0, Math.round(upCount)),
      downCount: downCount === null ? null : Math.max(0, Math.round(downCount)),
      breadthPct: covered > 0 ? round((Number(upCount || 0) / covered) * 100, 2) : null,
      leader: leaderCode || leaderName ? {
        code: leaderCode,
        name: leaderName || leaderCode,
        market: marketFromCode(leaderCode, raw?.leaderMarket ?? raw?.leader?.market ?? raw?.f141),
        changePct: round(leaderChangePct, 2),
      } : null,
      sourceTimestamp: finite(raw?.sourceTimestamp ?? raw?.f124),
      generic: GENERIC_TOPIC_RE.test(name),
    };
  }

  function percentileBy(rows, selector) {
    const valid = rows
      .map((row) => ({code: row.code, value: finite(selector(row))}))
      .filter((item) => item.value !== null)
      .sort((left, right) => left.value - right.value);
    const result = new Map();
    if (!valid.length) return result;
    valid.forEach((item, index) => {
      result.set(item.code, valid.length === 1 ? 50 : round((index / (valid.length - 1)) * 100, 3));
    });
    return result;
  }

  function interpretationFor(row) {
    const change = finite(row.changePct) ?? 0;
    const flow = finite(row.amount) ?? 0;
    const breadth = finite(row.breadthPct);
    let headline = "题材涨幅与资金处于平衡状态，方向尚未形成明显一致。";
    let tone = "neutral";
    if (change >= 1 && flow > 0 && (breadth === null || breadth >= 55)) {
      headline = "题材涨幅、主力净流入与上涨家数同向，盘面呈现强势扩散。";
      tone = "positive";
    } else if (change > 0 && flow < 0) {
      headline = "题材指数上涨但主力资金净流出，价格与资金出现分歧。";
      tone = "watch";
    } else if (change < 0 && flow > 0) {
      headline = "主力资金净流入但题材指数仍回落，存在承接，尚未形成一致上攻。";
      tone = "watch";
    } else if (change <= -1 && flow < 0) {
      headline = "题材跌幅与主力净流出同向，当前以风险释放为主。";
      tone = "negative";
    } else if (change > 0 && (breadth === null || breadth >= 50)) {
      headline = "题材维持上涨，资金确认度一般，需继续观察后续增量。";
      tone = "positive";
    } else if (change < 0) {
      headline = "题材整体偏弱，尚未出现足够的资金与上涨家数共振。";
      tone = "negative";
    }
    const evidence = [
      `题材指数当日${change >= 0 ? "上涨" : "下跌"}${Math.abs(change).toFixed(2)}%。`,
      `主力资金${flow >= 0 ? "净流入" : "净流出"}${Math.abs(flow).toFixed(2)}亿元。`,
    ];
    if (row.upCount !== null && row.downCount !== null && breadth !== null) {
      evidence.push(`上涨${row.upCount}家、下跌${row.downCount}家，上涨占比${row.breadthPct.toFixed(1)}%。`);
    } else if (row.upCount !== null && row.downCount !== null) {
      evidence.push(`上涨${row.upCount}家、下跌${row.downCount}家，当前没有可计算的上涨占比。`);
    }
    if (row.leader?.name) {
      evidence.push(`当前领涨股为${row.leader.name}${row.leader.changePct === null ? "" : `，涨幅${row.leader.changePct.toFixed(2)}%`}。`);
    }
    const risks = [];
    if (change > 0 && flow < 0) risks.push("上涨与资金背离");
    if (breadth !== null && breadth < 45) risks.push("上涨家数覆盖不足");
    if (change < 0 && flow < 0) risks.push("价格与资金同步走弱");
    if (!risks.length) risks.push("留意领涨股回落与资金方向反转");
    return {headline, tone, evidence, risks};
  }

  function decorateRows(rows) {
    const flowPercentile = percentileBy(rows, (row) => row.amount);
    const changePercentile = percentileBy(rows, (row) => row.changePct);
    return rows.map((row) => {
      const breadthScore = finite(row.breadthPct) ?? 50;
      const leaderScore = row.leader?.changePct === null || row.leader?.changePct === undefined
        ? 50
        : clamp((Number(row.leader.changePct) + 2) / 14 * 100);
      const score = round(
        (changePercentile.get(row.code) ?? 50) * 0.42
        + (flowPercentile.get(row.code) ?? 50) * 0.33
        + breadthScore * 0.17
        + leaderScore * 0.08,
        1,
      );
      return {...row, score, interpretation: interpretationFor(row)};
    });
  }

  function rankMap(rows, selector) {
    return new Map([...rows]
      .sort((left, right) => (finite(selector(right)) ?? -Infinity) - (finite(selector(left)) ?? -Infinity) || left.name.localeCompare(right.name, "zh-CN"))
      .map((row, index) => [row.code, index + 1]));
  }

  function sortRows(rows, sort) {
    const selectors = {
      score: (row) => row.score,
      change: (row) => row.changePct,
      flow: (row) => row.amount,
      breadth: (row) => row.breadthPct,
    };
    const selector = selectors[sort] || selectors.score;
    return [...rows].sort((left, right) => {
      const difference = (finite(selector(right)) ?? -Infinity) - (finite(selector(left)) ?? -Infinity);
      if (difference) return difference;
      return (finite(right.amount) ?? -Infinity) - (finite(left.amount) ?? -Infinity) || left.name.localeCompare(right.name, "zh-CN");
    });
  }

  function buildThemeRanking(snapshot, options = {}) {
    const rawRows = Array.isArray(snapshot?.groups?.concept?.rows)
      ? snapshot.groups.concept.rows
      : Array.isArray(snapshot?.items) ? snapshot.items : [];
    const allRows = rawRows
      .map(normalizeThemeRow)
      .filter((row) => /^BK\d{4}$/.test(row.code) && row.name && row.amount !== null && row.changePct !== null);
    const rankedUniverse = decorateRows(
      options.includeGeneric === false ? allRows.filter((row) => !row.generic) : allRows,
    );
    const ranks = {
      score: rankMap(rankedUniverse, (row) => row.score),
      change: rankMap(rankedUniverse, (row) => row.changePct),
      flow: rankMap(rankedUniverse, (row) => row.amount),
      breadth: rankMap(rankedUniverse, (row) => row.breadthPct),
    };
    const query = cleanText(options.query || options.q, 40).toLowerCase();
    const sort = SORT_KEYS.has(options.sort) ? options.sort : "score";
    const filtered = rankedUniverse
      .filter((row) => !query || row.name.toLowerCase().includes(query) || row.code.toLowerCase().includes(query))
      .map((row) => ({
        ...row,
        ranks: {
          score: ranks.score.get(row.code),
          change: ranks.change.get(row.code),
          flow: ranks.flow.get(row.code),
          breadth: ranks.breadth.get(row.code),
        },
      }));
    const limit = Math.max(1, Math.min(600, Number(options.limit) || 120));
    const items = sortRows(filtered, sort).slice(0, limit).map((row, index) => ({...row, rank: index + 1}));
    return {
      ok: Boolean(items.length),
      version: 1,
      tradeDate: cleanText(snapshot?.tradeDate, 20),
      sourceTime: cleanText(snapshot?.sourceTime, 20),
      sourceTimestamp: finite(snapshot?.sourceTimestamp),
      fetchedAt: cleanText(snapshot?.fetchedAt || new Date().toISOString(), 40),
      active: Boolean(snapshot?.active),
      marketPhase: cleanText(snapshot?.marketPhase, 20),
      source: cleanText(snapshot?.source || "东方财富概念板块公开行情", 160),
      methodology: "系统综合分由题材涨幅42%、主力净流入排名33%、上涨家数占比17%、领涨股强度8%构成；该分数为应用内排序指标，不是交易所或行情源官方评级。",
      sort,
      query,
      total: rankedUniverse.length,
      reportedTotal: Math.max(
        rankedUniverse.length,
        Math.trunc(finite(snapshot?.groups?.concept?.reportedRows ?? snapshot?.reportedTotal ?? snapshot?.total) || 0),
      ),
      count: items.length,
      items,
      excludedGenericCount: allRows.length - rankedUniverse.length,
      genericCount: allRows.filter((row) => row.generic).length,
      coverageComplete: Math.trunc(finite(snapshot?.groups?.concept?.reportedRows) || rankedUniverse.length) === rankedUniverse.length,
    };
  }

  function normalizeConstituent(raw) {
    const code = cleanText(raw?.code || raw?.f12, 12);
    const name = cleanText(raw?.name || raw?.f14, 40);
    const concepts = Array.isArray(raw?.concepts)
      ? raw.concepts.map((item) => cleanText(item, 30)).filter(Boolean)
      : cleanText(raw?.concepts || raw?.f103, 400).split(/[，,、;]/u).map((item) => item.trim()).filter(Boolean);
    return {
      code,
      name,
      riskFlag: Boolean(raw?.riskFlag) || /^(ST|\*ST)|退市/u.test(name),
      market: marketFromCode(code, raw?.market ?? raw?.f13),
      price: round(raw?.price ?? raw?.f2, 3),
      changePct: round(raw?.changePct ?? raw?.f3, 2),
      amount: round(raw?.amount ?? (finite(raw?.f6) === null ? null : Number(raw.f6) / 100000000), 3),
      turnoverRate: round(raw?.turnoverRate ?? raw?.f8, 2),
      totalMarketCap: finite(raw?.totalMarketCap ?? raw?.f20),
      floatMarketCap: finite(raw?.floatMarketCap ?? raw?.f21),
      industry: cleanText(raw?.industry || raw?.f100, 60),
      concepts,
    };
  }

  function normalizeCompanyProfile(raw) {
    const profile = raw?.jbzl || raw || {};
    return {
      companyName: cleanText(profile.companyName || profile.gsmc, 120),
      stockName: cleanText(profile.stockName || profile.agjc, 40),
      listingMarket: cleanText(profile.listingMarket || profile.ssjys || profile.zqlb, 80),
      industry: cleanText(profile.industry || profile.sshy || profile.sszjhhy, 120),
      businessIntro: cleanLongText(profile.businessIntro || profile.gsjj, 6000),
      businessScope: cleanLongText(profile.businessScope || profile.jyfw, 6000),
      website: cleanText(profile.website || profile.gswz, 160),
    };
  }

  function canonicalTopic(value) {
    return String(value || "")
      .replace(/[\s·・\-—_（）()]/gu, "")
      .replace(/(概念板块|概念|题材|板块|产业链)$/u, "")
      .toLowerCase();
  }

  function topicMatches(left, right) {
    const first = canonicalTopic(left);
    const second = canonicalTopic(right);
    if (!first || !second) return false;
    if (first === second) return true;
    if (Math.min(first.length, second.length) < 3) return false;
    return first.includes(second) || second.includes(first);
  }

  function sentences(value) {
    return cleanLongText(value, 6000)
      .match(/[^。！？；]+[。！？；]?/gu)
      ?.map((item) => item.trim())
      .filter(Boolean) || [];
  }

  function selectBusinessSummary(theme, stock, profile) {
    const source = profile.businessIntro || profile.businessScope;
    const parts = sentences(source);
    if (!parts.length) return {text: "", themeMatched: false};
    const themeName = cleanText(theme?.name, 40);
    const relatedConcepts = (stock?.concepts || []).filter((item) => topicMatches(item, themeName));
    const topicKeywords = [themeName, ...relatedConcepts]
      .map(canonicalTopic)
      .filter((item, index, rows) => item.length >= 2 && rows.indexOf(item) === index);
    const industryKeyword = canonicalTopic(stock?.industry || profile.industry);
    const ranked = parts.map((text, index) => {
      const normalized = canonicalTopic(text);
      const topicHits = topicKeywords.filter((keyword) => normalized.includes(keyword)).length;
      const industryHit = industryKeyword.length >= 3 && normalized.includes(industryKeyword) ? 1 : 0;
      const businessHit = /(主营|业务|产品|服务|研发|生产|制造|提供|布局|解决方案)/u.test(text) ? 1 : 0;
      return {text, index, topicHits, score: topicHits * 10 + industryHit * 3 + businessHit};
    }).sort((left, right) => right.score - left.score || left.index - right.index);
    const selected = ranked.slice(0, Math.min(2, ranked.length)).sort((left, right) => left.index - right.index);
    return {
      text: selected.map((item) => item.text).join(""),
      themeMatched: selected.some((item) => item.topicHits > 0),
    };
  }

  function buildCompanyThemeProfile(themeInput, stockInput, profileInput, options = {}) {
    const theme = themeInput?.code ? themeInput : normalizeThemeRow(themeInput || {});
    const stock = {...normalizeConstituent(stockInput || {}), role: cleanText(stockInput?.role, 20)};
    const profile = normalizeCompanyProfile(profileInput);
    const matchingConcepts = stock.concepts.filter((item) => topicMatches(item, theme?.name));
    const relevantConcepts = [...matchingConcepts, ...stock.concepts]
      .filter((item, index, rows) => item && rows.indexOf(item) === index)
      .slice(0, 8);
    const summary = selectBusinessSummary(theme, stock, profile);
    const membershipSentence = matchingConcepts.length
      ? `${stock.name}已由公开板块成分接口核验为“${theme.name}”成分股，公开概念标签中与该题材直接匹配的是“${matchingConcepts.join("、")}”。`
      : `${stock.name}已由公开板块成分接口核验为“${theme.name}”成分股。`;
    let relationReason = membershipSentence;
    if (summary.text) {
      relationReason += summary.themeMatched
        ? "公司公开主营资料中包含与该题材直接相关的业务表述，具体业务简介见下方。"
        : "公司公开主营资料未出现与题材同名的业务表述，当前仅按公开成分关系展示。";
    } else {
      relationReason += "公司主营资料当前未返回，因此不补写未经公开资料验证的业务关系。";
    }
    const evidence = [`题材成分：${theme.name}`];
    if (matchingConcepts.length) evidence.push(`直接匹配概念：${matchingConcepts.join("、")}`);
    if (stock.industry || profile.industry) evidence.push(`所属行业：${stock.industry || profile.industry}`);
    if (stock.role) evidence.push(`盘面角色：${stock.role}`);
    if (stock.changePct !== null) evidence.push(`当日涨跌：${stock.changePct > 0 ? "+" : ""}${stock.changePct.toFixed(2)}%`);
    if (stock.amount !== null) evidence.push(`成交额：${stock.amount.toFixed(2)}亿元`);
    return {
      ok: true,
      version: 1,
      theme: {code: cleanText(theme?.code, 16), name: cleanText(theme?.name, 40)},
      stock,
      company: {
        name: profile.companyName || stock.name,
        stockName: profile.stockName || stock.name,
        listingMarket: profile.listingMarket,
        industry: profile.industry || stock.industry,
        website: profile.website,
      },
      businessSummary: summary.text || "暂无可核验的公司主营简介。",
      relationReason,
      matchingConcepts,
      relevantConcepts,
      evidence,
      source: cleanText(options.source || "东方财富F10公司资料与概念板块成分股公开行情", 180),
      fetchedAt: cleanText(options.fetchedAt || new Date().toISOString(), 40),
      warning: cleanText(options.warning, 240),
      disclaimer: "题材关联仅依据公开板块成分关系、公开概念标签和公司主营资料整理；客户、订单、份额等信息仅在公开资料明确披露时展示。",
    };
  }

  function constituentRole(stock, theme, index) {
    if (stock.code && stock.code === theme?.leader?.code) return "领涨";
    if ((finite(stock.changePct) ?? -Infinity) >= 9.5) return "领涨";
    if (index < 2 || (finite(stock.changePct) ?? -Infinity) >= 3) return "核心";
    if ((finite(stock.changePct) ?? 0) > 0) return "跟随";
    return "分歧";
  }

  function buildThemeDetail(themeInput, constituentRows, options = {}) {
    const theme = themeInput?.code ? themeInput : normalizeThemeRow(themeInput || {});
    const stocks = (Array.isArray(constituentRows) ? constituentRows : [])
      .map(normalizeConstituent)
      .filter((stock) => /^\d{6}$/.test(stock.code) && stock.name)
      .sort((left, right) => (finite(right.amount) ?? -Infinity) - (finite(left.amount) ?? -Infinity));
    const roleOrder = {"领涨": 0, "核心": 1, "跟随": 2, "分歧": 3};
    const items = stocks.map((stock, index) => {
      const role = constituentRole(stock, theme, index);
      const facts = ["该股属于本题材公开成分股"];
      if (stock.riskFlag) facts.push("股票名称含风险警示标识");
      if (stock.changePct !== null) facts.push(`当日涨跌幅${stock.changePct > 0 ? "+" : ""}${stock.changePct.toFixed(2)}%`);
      if (stock.amount !== null) facts.push(`成交额${stock.amount.toFixed(2)}亿元`);
      if (stock.industry) facts.push(`所属行业：${stock.industry}`);
      return {...stock, role, relationReason: facts.join("；") + "。"};
    }).sort((left, right) => roleOrder[left.role] - roleOrder[right.role]
      || (finite(right.changePct) ?? -Infinity) - (finite(left.changePct) ?? -Infinity)
      || (finite(right.amount) ?? -Infinity) - (finite(left.amount) ?? -Infinity));
    const positive = items.filter((stock) => (finite(stock.changePct) ?? 0) > 0).length;
    const negative = items.filter((stock) => (finite(stock.changePct) ?? 0) < 0).length;
    const strong = items.filter((stock) => (finite(stock.changePct) ?? 0) >= 3).length;
    const limitLike = items.filter((stock) => (finite(stock.changePct) ?? 0) >= 9.5).length;
    const groups = ["领涨", "核心", "跟随", "分歧"].map((role) => ({
      role,
      items: items.filter((stock) => stock.role === role),
    })).filter((group) => group.items.length);
    const base = theme.interpretation || interpretationFor(theme);
    const reportedTotal = Math.max(items.length, Math.trunc(finite(options.reportedTotal) || 0));
    const excludedCount = Math.max(0, Math.trunc(finite(options.excludedCount) || 0));
    const complete = options.complete !== false;
    const breadthSentence = items.length
      ? `${complete ? "已完整核验" : "已核验"}${items.length}只东财公开成分股${reportedTotal > items.length ? `（东财总数${reportedTotal}只，本次缺少无效记录${excludedCount}只）` : ""}，其中上涨${positive}只、下跌${negative}只、涨幅不低于3%的有${strong}只${limitLike ? `、涨幅不低于9.5%的有${limitLike}只` : ""}。`
      : "成分股接口暂未返回足够样本，不对题材内部扩散程度下结论。";
    return {
      ok: true,
      version: 1,
      theme,
      constituentCount: items.length,
      reportedConstituentCount: reportedTotal,
      excludedConstituentCount: excludedCount,
      constituentPageCount: Math.max(1, Math.trunc(finite(options.pageCount) || 1)),
      constituentCoverageComplete: complete,
      constituents: items,
      groups,
      interpretation: {
        ...base,
        headline: `${base.headline}${breadthSentence}`,
        evidence: [...base.evidence, breadthSentence],
      },
      source: cleanText(options.source || "东方财富板块成分股公开行情", 160),
      fetchedAt: cleanText(options.fetchedAt || new Date().toISOString(), 40),
      warning: cleanText(options.warning, 200),
    };
  }

  return {
    GENERIC_TOPIC_RE,
    buildCompanyThemeProfile,
    buildThemeDetail,
    buildThemeRanking,
    interpretationFor,
    normalizeCompanyProfile,
    normalizeConstituent,
    normalizeThemeRow,
  };
})();

globalThis.AShareThemeTreasureModel = AShareThemeTreasureModel;

export const {
  GENERIC_TOPIC_RE,
  buildCompanyThemeProfile,
  buildThemeDetail,
  buildThemeRanking,
  interpretationFor,
  normalizeCompanyProfile,
  normalizeConstituent,
  normalizeThemeRow,
} = AShareThemeTreasureModel;
