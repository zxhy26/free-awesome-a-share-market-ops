"use strict";

const INDEX_CATALOG = Object.freeze([
  Object.freeze({key: "sh000001", name: "上证指数", code: "000001", symbol: "sh000001", secid: "1.000001", group: "shanghai"}),
  Object.freeze({key: "sh000016", name: "上证50", code: "000016", symbol: "sh000016", secid: "1.000016", group: "shanghai"}),
  Object.freeze({key: "sh000010", name: "上证180", code: "000010", symbol: "sh000010", secid: "1.000010", group: "shanghai"}),
  Object.freeze({key: "sh000688", name: "科创50", code: "000688", symbol: "sh000688", secid: "1.000688", group: "shanghai"}),
  Object.freeze({key: "sh000698", name: "科创100", code: "000698", symbol: "sh000698", secid: "1.000698", group: "shanghai"}),
  Object.freeze({key: "sz399001", name: "深证成指", code: "399001", symbol: "sz399001", secid: "0.399001", group: "shenzhen"}),
  Object.freeze({key: "sz399330", name: "深证100", code: "399330", symbol: "sz399330", secid: "0.399330", group: "shenzhen"}),
  Object.freeze({key: "sz399006", name: "创业板指", code: "399006", symbol: "sz399006", secid: "0.399006", group: "shenzhen"}),
  Object.freeze({key: "sz399673", name: "创业板50", code: "399673", symbol: "sz399673", secid: "0.399673", group: "shenzhen"}),
  Object.freeze({key: "sz399303", name: "国证2000", code: "399303", symbol: "sz399303", secid: "0.399303", group: "shenzhen"}),
  Object.freeze({key: "sh000300", name: "沪深300", code: "000300", symbol: "sh000300", secid: "1.000300", group: "csi"}),
  Object.freeze({key: "sh000903", name: "中证A100", code: "000903", symbol: "sh000903", secid: "1.000903", group: "csi"}),
  Object.freeze({key: "sh000905", name: "中证500", code: "000905", symbol: "sh000905", secid: "1.000905", group: "csi"}),
  Object.freeze({key: "sh000906", name: "中证800", code: "000906", symbol: "sh000906", secid: "1.000906", group: "csi"}),
  Object.freeze({key: "sh000852", name: "中证1000", code: "000852", symbol: "sh000852", secid: "1.000852", group: "csi"}),
  Object.freeze({key: "sh000985", name: "中证全指", code: "000985", symbol: "sh000985", secid: "1.000985", group: "csi"}),
  Object.freeze({key: "sh000510", name: "中证A500", code: "000510", symbol: "sh000510", secid: "1.000510", group: "csi"}),
  Object.freeze({key: "bj899050", name: "北证50", code: "899050", symbol: "bj899050", secid: "0.899050", group: "beijing"}),
  Object.freeze({key: "usIXIC", name: "纳斯达克", code: "IXIC", symbol: "usIXIC", secid: "", group: "overseas", session: "us"}),
]);

const DEFAULT_INDEX_KEYS = Object.freeze([
  "sh000001",
  "sz399001",
  "sz399006",
  "sh000688",
  "sh000300",
  "sh000905",
  "bj899050",
  "usIXIC",
]);

const INDEX_BY_KEY = new Map(INDEX_CATALOG.map((item) => [item.key.toLowerCase(), item]));
const INDEX_BY_CODE = new Map(INDEX_CATALOG.map((item) => [item.code.toLowerCase(), item]));

function findIndexDefinition(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return INDEX_BY_KEY.get(normalized) || INDEX_BY_CODE.get(normalized) || null;
}

function publicIndexCatalog() {
  return INDEX_CATALOG.map(({key, name, code, group, session = "cn"}) => ({
    key,
    name,
    code,
    group,
    session,
    selectedByDefault: DEFAULT_INDEX_KEYS.includes(key),
  }));
}

module.exports = {
  DEFAULT_INDEX_KEYS,
  INDEX_CATALOG,
  findIndexDefinition,
  publicIndexCatalog,
};
