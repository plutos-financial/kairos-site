// Decides before the first paint whether the opening (the phoenix and the name on black) plays:
// on a fresh visit or a refresh, but not when moving between Plutos pages or going back.
// src/intro.js does the rest.
try {
  var nav = performance.getEntriesByType("navigation")[0];
  var type = nav ? nav.type : "navigate";
  var inside = !!document.referrer && new URL(document.referrer).origin === location.origin;
  if (type !== "back_forward" && (type === "reload" || !inside)) document.documentElement.classList.add("intro-on");
} catch (e) {
  document.documentElement.classList.add("intro-on");
}
