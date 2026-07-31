const CACHE_VERSION = "a-share-review-v85-cls-plates-persistent-settings";
const CORE_CACHE = `${CACHE_VERSION}-core`;
const DATA_CACHE = `${CACHE_VERSION}-data`;
const CORE_ASSETS = [
  "/app/",
  "/app/index.html",
  "/app/pages/limit-up.html",
  "/app/pages/limit-down.html",
  "/app/pages/yesterday-limit.html",
  "/app/pages/yesterday-broken.html",
  "/app/pages/content-detail.html",
  "/app/assets/css/variables.css",
  "/app/assets/css/layout.css",
  "/app/assets/css/components.css",
  "/app/assets/css/table.css",
  "/app/assets/css/responsive.css",
  "/app/assets/css/stock-search.css",
  "/app/assets/css/policy-news.css",
  "/app/assets/css/next-week-events.css",
  "/app/assets/css/derivatives-page.css",
  "/app/assets/css/upgrade.css",
  "/app/assets/css/membership.css",
  "/app/assets/css/internal-detail.css",
  "/app/assets/js/api.js",
  "/app/assets/js/internal-navigation.js",
  "/app/assets/js/mobile-live.js",
  "/app/assets/js/internal-content-detail.js",
  "/app/assets/js/theme.js",
  "/app/assets/js/analysis.js",
  "/app/assets/js/charts.js",
  "/app/assets/js/sector-flow-chart.js",
  "/app/assets/js/custom-sector-workspace.js",
  "/app/assets/js/display-settings.js",
  "/app/assets/js/index-workspace.js",
  "/app/assets/js/persistent-settings.js",
  "/app/assets/js/dialog.js",
  "/app/assets/js/pwa.js",
  "/app/assets/js/app.js",
  "/app/assets/js/table.js",
  "/app/assets/js/detail-page.js",
  "/app/assets/js/stock-search-page.js",
  "/app/assets/js/policy-news-page.js",
  "/app/assets/js/next-week-events-page.js",
  "/app/assets/js/derivatives-page.js",
  "/app/assets/js/market-session.js",
  "/app/assets/js/data-health-page.js",
  "/app/assets/js/history-page.js",
  "/app/assets/js/membership.js",
  "/app/assets/js/membership-guard.js",
  "/app/data/market.json",
  "/app/data/indices.json",
  "/app/data/sectors.json",
  "/app/data/stocks.json",
  "/app/data/analysis.json",
  "/app/data/health.json",
  "/app/data/config.json",
  "/app/data/会员支付配置.json",
  "/app/assets/payment/微信支付二维码.png",
  "/app/assets/payment/支付宝支付二维码.png",
  "/app/assets/payment/创作者微信二维码.png",
  "/app/assets/icons/favicon-32.png",
  "/app/assets/icons/icon-192.png",
  "/app/assets/icons/icon-512.png",
  "/app/manifest.webmanifest"
];

const PROTECTED_PATHS = new Set([
  "/app/pages/policy-news.html",
  "/app/pages/next-week-events.html",
  "/app/pages/derivatives.html",
  "/app/pages/history.html",
  "/app/pages/stock-search.html",
  "/app/data/policy-news.json",
  "/app/data/next-week-events.json",
  "/app/data/derivatives.json",
  "/app/data/history-index.json",
  "/app/data/index-contribution.json",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CORE_CACHE).then((cache) => cache.addAll(CORE_ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(CACHE_VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (_) {
    const cached = await cache.match(request) || await cache.match(request, {ignoreSearch: true});
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    return new Response("离线状态下没有该页面的缓存。", {status: 503, headers: {"Content-Type": "text/plain; charset=utf-8"}});
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CORE_CACHE);
  const cached = await cache.match(request);
  const update = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  if (cached) {
    update.catch(() => null);
    return cached;
  }
  const fresh = await update;
  return fresh || new Response("资源暂不可用", {status: 503});
}

self.addEventListener("fetch", (event) => {
  const {request} = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/app/")) return;
  if (PROTECTED_PATHS.has(url.pathname)) return;
  if (url.pathname.startsWith("/app/data/") || url.pathname.endsWith(".json")) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }
  if (request.mode === "navigate") {
    const isHome = url.pathname === "/app/" || url.pathname === "/app/index.html";
    event.respondWith(networkFirst(request, CORE_CACHE, isHome ? "/app/index.html" : null));
    return;
  }
  if (/\.(?:js|css|webmanifest)$/.test(url.pathname)) {
    event.respondWith(networkFirst(request, CORE_CACHE));
    return;
  }
  if (/\.(?:png|ico|svg)$/.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
