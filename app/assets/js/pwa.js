export function initializePwa() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  const toast = document.querySelector("#updateToast");
  const applyButton = document.querySelector("#applyUpdate");
  let waitingWorker = null;
  let reloading = false;
  const applyUpdate = (worker) => {
    if (!worker) return;
    waitingWorker = worker;
    if (toast) toast.hidden = true;
    worker.postMessage({type: "SKIP_WAITING"});
  };
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register("/app/sw.js").then((registration) => {
    const showUpdate = (worker) => {
      waitingWorker = worker;
      applyUpdate(worker);
    };
    if (registration.waiting) showUpdate(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed" && navigator.serviceWorker.controller) showUpdate(worker);
      });
    });
    applyButton?.addEventListener("click", () => {
      if (!waitingWorker) return location.reload();
      applyUpdate(waitingWorker);
    });
    registration.update().catch(() => null);
  }).catch((error) => console.error("[PWA] Service Worker 注册失败", error));
}
