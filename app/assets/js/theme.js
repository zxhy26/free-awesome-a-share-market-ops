const STORAGE_KEY = "a-share-review-theme";
const VALID_THEMES = new Set(["system", "light", "dark"]);

export function currentTheme() {
  const saved = localStorage.getItem(STORAGE_KEY);
  return VALID_THEMES.has(saved) ? saved : "system";
}

export function applyTheme(theme) {
  const selected = VALID_THEMES.has(theme) ? theme : "system";
  document.documentElement.dataset.theme = selected;
  localStorage.setItem(STORAGE_KEY, selected);
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === selected));
  });
  return selected;
}

export function initializeTheme() {
  applyTheme(currentTheme());
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.addEventListener("click", () => applyTheme(button.dataset.themeChoice));
  });
}

applyTheme(currentTheme());
