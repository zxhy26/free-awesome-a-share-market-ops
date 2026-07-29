(function initializeMobileRuntime() {
  const script = document.currentScript;
  const edition = String(script?.dataset?.edition || "member").trim().toLowerCase();
  const rootUrl = new URL("../../", script?.src || location.href);

  globalThis.__A_SHARE_MOBILE__ = true;
  globalThis.__A_SHARE_EDITION__ = edition === "self" ? "self" : "member";
  globalThis.__A_SHARE_ROOT_URL__ = rootUrl.href;

  document.documentElement.classList.add("mobile-pwa");
  document.documentElement.dataset.edition = globalThis.__A_SHARE_EDITION__;
})();
