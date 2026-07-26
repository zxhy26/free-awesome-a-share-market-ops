function focusableElements(dialog) {
  return [...dialog.querySelectorAll("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")]
    .filter((element) => !element.hidden && element.offsetParent !== null);
}

function downloadText(filename, text) {
  const blob = new Blob([text], {type: "text/plain;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function createSummaryDialog(options) {
  const {backdrop, dialog, openButton, closeButton, copyButton, exportButton, printButton, getText, getFilename} = options;
  let returnFocus = null;

  function open() {
    returnFocus = document.activeElement;
    backdrop.hidden = false;
    document.body.classList.add("summary-open");
    dialog.focus();
  }

  function close() {
    backdrop.hidden = true;
    document.body.classList.remove("summary-open");
    returnFocus?.focus?.();
  }

  openButton.addEventListener("click", open);
  closeButton.addEventListener("click", close);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key !== "Tab") return;
    const focusable = focusableElements(dialog);
    if (!focusable.length) { event.preventDefault(); dialog.focus(); return; }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      copyButton.title = "已复制";
    } catch (_) {
      const area = document.createElement("textarea");
      area.value = getText();
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
  });
  exportButton.addEventListener("click", () => downloadText(getFilename(), getText()));
  printButton.addEventListener("click", () => window.print());
  return {open, close};
}
