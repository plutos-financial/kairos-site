// Content rises into place as it scrolls into view, a beat apart for things side by side.
// Only what starts below the fold is hidden, so nothing on the first screen waits; people who ask
// for less motion, and browsers without IntersectionObserver, see everything at once.
const SELECTORS = [
  // homepage
  ".hero-copy", ".hero-visual", ".rails-grid > div", ".sec-head", ".step", ".table-wrap", ".tile",
  ".calc", ".why-num", ".why-cap", ".why-copy", ".faq details", ".wl-copy", ".wl-form",
  // explainer pages
  ".ex-sec .sec-n", ".ex-sec h2", ".ex-sec > p", ".flow li", ".receipt", ".stat-strip > div", ".promise",
  ".finding", ".arch-row", ".gas", ".odds-mini", ".qa", ".ex-end > *",
].join(",");

export function reveal() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
  const fold = innerHeight * 0.92;
  const els = [...document.querySelectorAll(SELECTORS)].filter((el) => el.getBoundingClientRect().top > fold);
  const order = new Map(); // place among siblings that rise together
  for (const el of els) {
    const n = order.get(el.parentElement) || 0;
    order.set(el.parentElement, n + 1);
    el.style.setProperty("--rv-d", `${Math.min(n, 4) * 0.09}s`);
    el.classList.add("rv");
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("rv-in");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" }
  );
  els.forEach((el) => io.observe(el));
}
