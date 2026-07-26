async function enforceMembership() {
  try {
    const response = await fetch("/api/v1/membership/status", { cache: "no-store" });
    const membership = await response.json();
    if (response.ok && membership.active) return;
  } catch (_) {
    // A failed local authorization check remains locked.
  }
  const feature = document.title.split("｜")[0] || "该功能";
  location.replace(`/app/?member=required&feature=${encodeURIComponent(feature)}`);
}

enforceMembership();
