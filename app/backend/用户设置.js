"use strict";

const fs = require("fs");
const path = require("path");

const MAX_SELECTED_INDICES = 8;
const MAX_SELECTED_SECTORS = 6;
const FONT_CHOICES = new Set(["small", "standard", "large", "xlarge"]);

function normalizeIndexKeys(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const key = String(value || "").trim();
    if (!/^(?:sh|sz|bj|us)[A-Za-z0-9]+$/.test(key) || result.includes(key)) continue;
    result.push(key);
    if (result.length >= MAX_SELECTED_INDICES) break;
  }
  return result;
}

function normalizeSectorSelections(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const code = String(value?.code || "").trim().toUpperCase();
    if (!/^BK\d{4}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    result.push({
      code,
      name: String(value?.name || code).trim().slice(0, 40) || code,
      group: value?.group === "concept" ? "concept" : "industry",
    });
    if (result.length >= MAX_SELECTED_SECTORS) break;
  }
  return result;
}

function normalizeZoom(value) {
  const bounded = Math.max(70, Math.min(130, Number(value) || 100));
  return Math.round(bounded / 5) * 5;
}

function normalizeUserPreferences(value = {}) {
  const input = value?.settings && typeof value.settings === "object" ? value.settings : value;
  const fontSize = String(input?.fontSize || "standard");
  return {
    selectedIndices: normalizeIndexKeys(input?.selectedIndices),
    selectedSectors: normalizeSectorSelections(input?.selectedSectors),
    zoom: normalizeZoom(input?.zoom),
    fontSize: FONT_CHOICES.has(fontSize) ? fontSize : "standard",
  };
}

function readJsonBody(req, limit = 32768) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        reject(Object.assign(new Error("设置内容过大"), {statusCode: 413}));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (_) {
        reject(Object.assign(new Error("设置内容格式无效"), {statusCode: 400}));
      }
    });
    req.on("error", reject);
  });
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function createUserPreferencesStore(options = {}) {
  const filePath = path.resolve(String(options.filePath || ""));
  if (!options.filePath) throw new Error("用户设置文件路径不能为空");
  const now = typeof options.now === "function" ? options.now : () => new Date();

  function read() {
    try {
      if (!fs.existsSync(filePath)) return {found: false, settings: {}};
      const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return {
        found: true,
        updatedAt: String(value?.updatedAt || ""),
        settings: normalizeUserPreferences(value),
      };
    } catch (_) {
      return {found: false, settings: {}};
    }
  }

  function save(value) {
    const existing = read();
    const input = value?.settings && typeof value.settings === "object" ? value.settings : value;
    const settings = normalizeUserPreferences({...existing.settings, ...input});
    const payload = {
      schemaVersion: 1,
      updatedAt: now().toISOString(),
      settings,
    };
    writeJsonAtomic(filePath, payload);
    return {found: true, updatedAt: payload.updatedAt, settings};
  }

  return {filePath, read, save};
}

function sendJson(res, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function createUserPreferencesService(options = {}) {
  const store = createUserPreferencesStore(options);
  return {
    store,
    async handleRequest(req, res, url) {
      if (url.pathname !== "/api/v1/preferences") return false;
      if (req.method === "GET") {
        sendJson(res, 200, {ok: true, ...store.read()});
        return true;
      }
      if (req.method === "POST") {
        try {
          const body = await readJsonBody(req);
          sendJson(res, 200, {ok: true, ...store.save(body)});
        } catch (error) {
          sendJson(res, error.statusCode || 500, {ok: false, message: error.message || "用户设置保存失败"});
        }
        return true;
      }
      sendJson(res, 405, {ok: false, message: "请求方法不支持"});
      return true;
    },
  };
}

module.exports = {
  createUserPreferencesService,
  createUserPreferencesStore,
  normalizeUserPreferences,
};
