// The opening (the phoenix and the name on black) plays once per visit, and never for people who ask
// for less motion. Runs before the first paint; src/intro.js does the rest.
try {
  if (!sessionStorage.getItem("plutos.intro") && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.documentElement.classList.add("intro-on");
  }
} catch (e) {
  /* no storage: no opening */
}
