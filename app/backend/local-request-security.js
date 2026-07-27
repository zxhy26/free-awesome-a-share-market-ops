const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function parseHostHeader(value) {
  const text = String(value || "").trim();
  if (!text || /[\s/@\\]/.test(text)) return null;
  try {
    const parsed = new URL(`http://${text}`);
    return {
      hostname: parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
      port: parsed.port,
    };
  } catch (_) {
    return null;
  }
}

function isLoopbackHostname(value) {
  return LOOPBACK_HOSTS.has(String(value || "").replace(/^\[|\]$/g, "").toLowerCase());
}

function isAllowedHostHeader(value, port, allowRemote = false) {
  const parsed = parseHostHeader(value);
  if (!parsed) return false;
  if (!allowRemote && !isLoopbackHostname(parsed.hostname)) return false;
  return !parsed.port || parsed.port === String(port);
}

function parseOrigin(value) {
  const text = String(value || "").trim();
  if (!text || text === "null") return null;
  try {
    const parsed = new URL(text);
    return {
      protocol: parsed.protocol,
      hostname: parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase(),
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
      origin: parsed.origin,
    };
  } catch (_) {
    return null;
  }
}

function isAllowedOrigin(value, port, allowRemote = false) {
  const parsed = parseOrigin(value);
  if (!parsed || !["http:", "https:"].includes(parsed.protocol)) return false;
  if (!allowRemote && !isLoopbackHostname(parsed.hostname)) return false;
  return parsed.port === String(port);
}

function validateLocalRequest(req, options = {}) {
  const port = Number(options.port) || 18765;
  const allowRemote = options.allowRemote === true;
  if (!isAllowedHostHeader(req.headers?.host, port, allowRemote)) {
    return {ok: false, statusCode: 403, code: "INVALID_HOST", message: "拒绝非本机服务地址。"};
  }

  const origin = String(req.headers?.origin || "").trim();
  if (origin && !isAllowedOrigin(origin, port, allowRemote)) {
    return {ok: false, statusCode: 403, code: "INVALID_ORIGIN", message: "拒绝跨站请求。"};
  }

  const method = String(req.method || "GET").toUpperCase();
  const stateChanging = !["GET", "HEAD", "OPTIONS"].includes(method);
  const fetchSite = String(req.headers?.["sec-fetch-site"] || "").toLowerCase();
  if (stateChanging && fetchSite === "cross-site") {
    return {ok: false, statusCode: 403, code: "CROSS_SITE_WRITE", message: "拒绝跨站写操作。"};
  }

  return {ok: true, corsOrigin: origin && isAllowedOrigin(origin, port, allowRemote) ? origin : ""};
}

function applyLocalResponseHeaders(res, requestOrigin = "") {
  if (requestOrigin) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
}

module.exports = {
  applyLocalResponseHeaders,
  isAllowedHostHeader,
  isAllowedOrigin,
  isLoopbackHostname,
  parseHostHeader,
  validateLocalRequest,
};
