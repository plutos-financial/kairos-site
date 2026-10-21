// GitHub Pages lets browsers keep a page for 10 minutes, so right after an update people can get the
// old version. If version.json says a newer build is out, load it once (the ?v= makes it a fresh URL).
export {};
if (import.meta.env.VITE_EDITION === "beta") document.documentElement.dataset.edition = "beta";

// Plutos never runs inside another site's frame, so nobody can lay a fake page over its buttons
// (click-jacking). GitHub Pages can't send the header that normally does this, so it's done here.
if (window.top !== window.self) {
  document.documentElement.style.display = "none";
  try {
    window.top.location.replace(location.href);
  } catch {}
}
(function loadNewestVersion() {
  try {
    const u = new URL(location.href);
    if (u.searchParams.has("v")) {
      if (u.searchParams.get("v") === __BUILD_ID__) {
        u.searchParams.delete("v");
        history.replaceState(history.state, "", u);
      }
      return; // never redirect twice
    }
    fetch("./version.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j?.build || j.build === __BUILD_ID__) return;
        u.searchParams.set("v", j.build);
        location.replace(u.toString());
      })
      .catch(() => {});
  } catch {}
})();
