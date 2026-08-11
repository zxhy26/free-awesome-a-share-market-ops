"use strict";

const fs = require("fs");

function resolveLegacyTemplatePath({outputPath = "", seedPath = "", existsSync = fs.existsSync} = {}) {
  for (const candidate of [outputPath, seedPath]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "";
}

function runOptionalOutput(label, action, logger = () => {}) {
  try {
    return {ok: true, value: action()};
  } catch (error) {
    const message = error?.message || String(error);
    logger(`${label}跳过：${message}`);
    return {ok: false, error: message};
  }
}

module.exports = {
  resolveLegacyTemplatePath,
  runOptionalOutput,
};
