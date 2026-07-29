(function installInternalNavigation() {
  const script = document.currentScript;
  const rootUrl = new URL(
    globalThis.__A_SHARE_ROOT_URL__ || "../../",
    script?.src || location.href,
  );
  const detailPage = new URL("pages/content-detail.html", rootUrl);
  const storagePrefix = "a-share-internal-detail:";

  function externalSource(anchor) {
    const raw = anchor.dataset.internalSourceUrl || anchor.getAttribute("href") || "";
    if (!raw) return null;
    try {
      const url = new URL(raw, location.href);
      if (!["http:", "https:"].includes(url.protocol) || url.origin === location.origin) {
        return null;
      }
      return url;
    } catch (_) {
      return null;
    }
  }

  function linkTitle(anchor) {
    return String(
      anchor.getAttribute("aria-label")
      || anchor.textContent
      || anchor.getAttribute("title")
      || "内容详情",
    ).replace(/\s+/g, " ").trim() || "内容详情";
  }

  function internalUrl(title, key = "") {
    const url = new URL(detailPage);
    url.searchParams.set("title", title);
    if (key) url.searchParams.set("key", key);
    return url;
  }

  function prepareAnchor(anchor) {
    if (!(anchor instanceof HTMLAnchorElement) || anchor.dataset.internalDetailLink === "true") {
      return;
    }
    const source = externalSource(anchor);
    if (!source) return;
    const title = linkTitle(anchor);
    anchor.dataset.internalDetailLink = "true";
    anchor.dataset.internalSourceUrl = source.href;
    anchor.href = internalUrl(title).href;
    anchor.removeAttribute("target");
    anchor.removeAttribute("rel");
    anchor.title = `在软件内查看：${title}`;
  }

  function scanAnchors(root) {
    if (root instanceof HTMLAnchorElement) prepareAnchor(root);
    if (root?.querySelectorAll) {
      root.querySelectorAll("a[href]").forEach(prepareAnchor);
    }
  }

  function contextText(anchor) {
    const container = anchor.closest(
      "article, .policy-plan-card, .event-chain-card, .stock-news-item, .stock-event-card, .news-item, section",
    );
    const raw = String(container?.innerText || anchor.textContent || "");
    const lines = [];
    const seen = new Set();
    raw.split(/\r?\n/).forEach((line) => {
      const normalized = line.replace(/\s+/g, " ").trim();
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      lines.push(normalized);
    });
    return lines.join("\n").slice(0, 12000);
  }

  function savePayload(key, payload) {
    const serialized = JSON.stringify(payload);
    try {
      sessionStorage.setItem(`${storagePrefix}${key}`, serialized);
      return true;
    } catch (_) {
    }
    try {
      localStorage.setItem(`${storagePrefix}${key}`, serialized);
      return true;
    } catch (_) {
      return false;
    }
  }

  document.addEventListener("click", (event) => {
    const anchor = event.target.closest?.("a[data-internal-detail-link='true']");
    if (!anchor) return;
    const title = linkTitle(anchor);
    const source = externalSource(anchor);
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const payload = {
      title,
      buttonName: title,
      content: contextText(anchor),
      sourceHost: source?.hostname || "",
      sourceUrl: source?.href || "",
      returnUrl: location.href,
      createdAt: new Date().toISOString(),
    };
    const stored = savePayload(key, payload);
    const url = internalUrl(title, stored ? key : "");
    if (!stored && payload.content) {
      url.searchParams.set("excerpt", payload.content.slice(0, 1400));
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    location.assign(url);
  }, true);

  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      record.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) scanAnchors(node);
      });
    });
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      scanAnchors(document);
      observer.observe(document.documentElement, {childList: true, subtree: true});
    }, {once: true});
  } else {
    scanAnchors(document);
    observer.observe(document.documentElement, {childList: true, subtree: true});
  }
})();
