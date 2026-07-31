const PREFERENCE_KEYS = Object.freeze({
  selectedIndices: "a-share-review:selected-indices:v1",
  selectedSectors: "a-share-review:custom-sectors:v1",
  zoom: "a-share-review:page-zoom:v1",
  fontSize: "a-share-review:font-size:v1",
});

const TRACKED_KEYS = new Set(Object.values(PREFERENCE_KEYS));

function parseArray(storage, key) {
  try {
    const value = JSON.parse(storage?.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}

function snapshotSettings(storage) {
  return {
    selectedIndices: parseArray(storage, PREFERENCE_KEYS.selectedIndices),
    selectedSectors: parseArray(storage, PREFERENCE_KEYS.selectedSectors),
    zoom: Number(storage?.getItem(PREFERENCE_KEYS.zoom)) || 100,
    fontSize: String(storage?.getItem(PREFERENCE_KEYS.fontSize) || "standard"),
  };
}

function applySettings(storage, settings = {}) {
  if (Array.isArray(settings.selectedIndices)) {
    storage?.setItem(PREFERENCE_KEYS.selectedIndices, JSON.stringify(settings.selectedIndices));
  }
  if (Array.isArray(settings.selectedSectors)) {
    storage?.setItem(PREFERENCE_KEYS.selectedSectors, JSON.stringify(settings.selectedSectors));
  }
  if (Number.isFinite(Number(settings.zoom))) {
    storage?.setItem(PREFERENCE_KEYS.zoom, String(settings.zoom));
  }
  if (["small", "standard", "large", "xlarge"].includes(settings.fontSize)) {
    storage?.setItem(PREFERENCE_KEYS.fontSize, settings.fontSize);
  }
}

function hasStoredPreferences(storage) {
  return [...TRACKED_KEYS].some((key) => storage?.getItem(key) !== null);
}

async function requestPreferences(fetchImpl, endpoint, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 1600);
  try {
    const response = await fetchImpl(endpoint, {
      method: options.method || "GET",
      cache: "no-store",
      headers: {Accept: "application/json", ...(options.headers || {})},
      body: options.body,
      keepalive: Boolean(options.keepalive),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function createPersistentSettingsStorage(options = {}) {
  const baseStorage = options.storage || globalThis.localStorage;
  const fetchImpl = options.fetch || globalThis.fetch?.bind(globalThis);
  const endpoint = options.endpoint || "/api/v1/preferences";
  const mobile = options.mobile ?? (globalThis.__A_SHARE_MOBILE__ === true || globalThis.location?.protocol === "file:");
  let saveTimer = 0;
  let dirty = false;
  let lastSavedSignature = "";

  async function saveNow(saveOptions = {}) {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (mobile || !fetchImpl || !dirty) return false;
    const settings = snapshotSettings(baseStorage);
    const signature = JSON.stringify(settings);
    if (signature === lastSavedSignature) {
      dirty = false;
      return true;
    }
    const body = JSON.stringify({settings});
    if (saveOptions.beacon && globalThis.navigator?.sendBeacon) {
      const accepted = globalThis.navigator.sendBeacon(endpoint, new Blob([body], {type: "application/json"}));
      if (accepted) {
        lastSavedSignature = signature;
        dirty = false;
      }
      return accepted;
    }
    try {
      await requestPreferences(fetchImpl, endpoint, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body,
        keepalive: Boolean(saveOptions.keepalive),
        timeoutMs: saveOptions.keepalive ? 2500 : 4000,
      });
      lastSavedSignature = signature;
      dirty = false;
      return true;
    } catch (_) {
      dirty = true;
      return false;
    }
  }

  function scheduleSave() {
    if (mobile || !fetchImpl) return;
    clearTimeout(saveTimer);
    saveTimer = globalThis.setTimeout(() => saveNow(), 120);
  }

  const storage = {
    getItem: (key) => baseStorage?.getItem(key) ?? null,
    setItem(key, value) {
      const serialized = String(value);
      if (baseStorage?.getItem(key) === serialized) return;
      baseStorage?.setItem(key, serialized);
      if (TRACKED_KEYS.has(key)) {
        dirty = true;
        scheduleSave();
      }
    },
    removeItem(key) {
      if (baseStorage?.getItem(key) === null) return;
      baseStorage?.removeItem(key);
      if (TRACKED_KEYS.has(key)) {
        dirty = true;
        scheduleSave();
      }
    },
  };

  let hydratedFrom = "local";
  if (!mobile && fetchImpl) {
    try {
      const remote = await requestPreferences(fetchImpl, endpoint);
      if (remote?.found && remote?.settings) {
        applySettings(baseStorage, remote.settings);
        lastSavedSignature = JSON.stringify(snapshotSettings(baseStorage));
        hydratedFrom = "file";
      } else if (hasStoredPreferences(baseStorage)) {
        dirty = true;
        await saveNow();
        hydratedFrom = "local-imported";
      }
    } catch (_) {
      hydratedFrom = "local";
    }
  }

  return {
    storage,
    hydratedFrom,
    flush: (flushOptions = {}) => saveNow(flushOptions),
    getSettings: () => snapshotSettings(baseStorage),
  };
}

export {
  PREFERENCE_KEYS,
  applySettings,
  createPersistentSettingsStorage,
  snapshotSettings,
};
