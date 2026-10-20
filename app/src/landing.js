// Landing page: scroll-driven bullet train, lottery counter, odds calculator, waitlist (Netlify Forms).
import { $ } from "./core.js";
import built from "./site-config.json";

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ the train scene

const W = 1600;
let seed = 11;
const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);

function strip(id, h, inner) {
  const svg = `<svg width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
  $(id).innerHTML = svg + svg + svg; // three copies: seamless loop, and wide monitors never see the end
}

function buildScene() {
  // far skyline with a few lit windows
  let far = "";
  for (let x = 0; x < W; ) {
    const w = 44 + rand() * 90;
    const h = 50 + rand() * 170;
    far += `<rect x="${x}" y="${240 - h}" width="${w - 5}" height="${h}" fill="#0c0d10"/>`;
    for (let wy = 240 - h + 14; wy < 228; wy += 18)
      for (let wx = x + 9; wx < x + w - 14; wx += 14)
        if (rand() > 0.86) far += `<rect x="${wx}" y="${wy}" width="4" height="6" fill="${rand() > 0.7 ? "#f4c24f" : "#fffcf7"}" opacity="${0.18 + rand() * 0.3}"/>`;
    x += w;
  }
  strip("farStrip", 240, far);

  let d = `M0 160`;
  for (let x = 0; x <= W; x += W / 8) d += ` Q${x + W / 16} ${104 + rand() * 36} ${x + W / 8} 160`;
  strip("midStrip", 170, `<path d="${d} V170 H0 Z" fill="#070809"/>`);

  let p = "";
  for (let x = 120; x < W; x += 400) {
    p += `<line x1="${x}" y1="18" x2="${x}" y2="210" stroke="#1a1b1f" stroke-width="8"/>`;
    p += `<line x1="${x - 38}" y1="30" x2="${x + 38}" y2="30" stroke="#1a1b1f" stroke-width="5"/>`;
    p += `<path d="M${x} 34 Q${x + 200} 62 ${x + 400} 34" stroke="#1a1b1f" stroke-width="2" fill="none"/>`;
  }
  strip("poleStrip", 210, p);

  let g = `<rect x="0" y="0" width="${W}" height="72" fill="#000"/><rect x="0" y="4" width="${W}" height="3" fill="#2eb5e0" opacity="0.9"/><rect x="0" y="9" width="${W}" height="1" fill="#2eb5e0" opacity="0.25"/>`;
  for (let x = 0; x < W; x += 50) g += `<rect x="${x}" y="22" width="28" height="6" rx="1" fill="#141518"/>`;
  strip("groundStrip", 72, g);

  let s = "";
  for (let i = 0; i < 18; i++) {
    const y = 18 + rand() * 170, len = 90 + rand() * 300, x = rand() * W;
    s += `<line x1="${x}" y1="${y}" x2="${x + len}" y2="${y}" stroke="#f4f4f1" stroke-width="${1 + rand() * 1.6}" stroke-linecap="round" opacity="${0.04 + rand() * 0.12}"/>`;
  }
  strip("streakStrip", 200, s);

  $("train").innerHTML = `<svg viewBox="0 0 1200 222" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Kairos bullet train">
    <defs>
      <linearGradient id="tb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d9dad6"/></linearGradient>
    </defs>
    <path d="M130 60 H880 C1010 60 1130 95 1192 150 C1172 182 1100 200 1010 202 H130 C80 202 40 178 40 140 C40 96 80 60 130 60 Z" fill="url(#tb)"/>
    <path d="M115 92 H900 C990 92 1068 106 1118 130 C1086 138 1010 142 940 142 H115 C96 142 84 130 84 117 C84 103 96 92 115 92 Z" fill="#050506"/>
    <g stroke="#e9eae6" stroke-width="6">
      <line x1="250" y1="92" x2="250" y2="142"/><line x1="390" y1="92" x2="390" y2="142"/>
      <line x1="530" y1="92" x2="530" y2="142"/><line x1="670" y1="92" x2="670" y2="142"/><line x1="810" y1="92" x2="810" y2="142"/>
    </g>
    <path d="M46 168 H1150 C1126 186 1076 200 1010 202 H130 C92 202 62 190 46 168 Z" fill="#2eb5e0"/>
    <rect x="60" y="156" width="1040" height="4" fill="#050506" opacity="0.85"/>
    <text x="150" y="82" font-family="Funnel Display Variable, Arial, sans-serif" font-weight="700" font-size="24" fill="#050506" letter-spacing="-0.5">kairos</text>
    <g fill="#111214"><rect x="120" y="202" width="150" height="16" rx="6"/><rect x="520" y="202" width="150" height="16" rx="6"/><rect x="860" y="202" width="150" height="16" rx="6"/></g>
  </svg>`;
}

// The train glides across as the section scrolls through the screen; nearer layers drift more.
function rideScroll() {
  const sec = $("ride");
  const wrap = $("trainWrap");
  const layers = [...sec.querySelectorAll("[data-depth]")];
  if (reduceMotion) return;
  let ticking = false;
  const update = () => {
    ticking = false;
    const r = sec.getBoundingClientRect();
    const vh = innerHeight;
    if (r.bottom < 0 || r.top > vh) return;
    const p = Math.min(1, Math.max(0, (vh - r.top) / (vh + r.height)));
    wrap.style.setProperty("--tx", `${((p - 0.55) * 150).toFixed(2)}vw`);
    for (const l of layers) l.style.transform = `translateY(${((p - 0.5) * Number(l.dataset.depth) * 90).toFixed(1)}px)`;
  };
  addEventListener("scroll", () => !ticking && (ticking = true) && requestAnimationFrame(update), { passive: true });
  addEventListener("resize", update);
  update();
}

// ------------------------------------------------------------------ odds calculator

const STEPS = [10, 25, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000];
const RUNGS = [100, 200, 500, 1000];
const money = (n) => "$" + n.toLocaleString("en-US");
const times = (x) => (x >= 10 ? Math.round(x) : Number(x.toFixed(x < 1 ? 2 : 1))).toLocaleString("en-US") + "×";

function calculator() {
  const range = $("calcRange");
  range.max = String(STEPS.length - 1);
  $("ladder").innerHTML = RUNGS.map((r) => `<button type="button" class="rung" data-v="${r}">${money(r)} <b>${times(r / 100)}</b></button>`).join("");
  const render = () => {
    const amt = STEPS[Number(range.value)];
    $("calcAmt").textContent = money(amt);
    $("calcEntries").textContent = amt.toLocaleString("en-US");
    $("calcBoost").textContent = times(amt / 100);
    range.style.setProperty("--fill", `${(Number(range.value) / (STEPS.length - 1)) * 100}%`);
    document.querySelectorAll(".rung").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === amt));
  };
  range.addEventListener("input", render);
  $("ladder").addEventListener("click", (e) => {
    const b = e.target.closest(".rung");
    if (!b) return;
    range.value = String(STEPS.indexOf(Number(b.dataset.v)));
    render();
  });
  render();
}

// ------------------------------------------------------------------ waitlist (Netlify Forms)

// If kairos-settings.json has a "waitlistUrl", sign-ups go there (a Google Sheet). Otherwise Netlify Forms.
let settingsPromise;
async function waitlistUrl() {
  settingsPromise ||= fetch("./kairos-settings.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const url = String((await settingsPromise).waitlistUrl || built.settings?.waitlistUrl || "").trim();
  return /^https:\/\//.test(url) ? url : "";
}

function waitlist() {
  const form = $("waitlistForm");
  const err = (m) => ($("wlError").textContent = m || "");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err("");
    const name = form.name.value.trim();
    const email = form.email.value.trim();
    const phone = form.phone.value.trim();
    if (name.length < 2) return err("Please enter your name.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("Please enter a valid email.");
    if (phone.replace(/\D/g, "").length < 10) return err("Please enter a phone number with area code.");

    const btn = $("wlSubmit");
    btn.disabled = true;
    btn.textContent = "Adding you…";
    try {
      const body = new URLSearchParams(new FormData(form)).toString();
      const headers = { "Content-Type": "application/x-www-form-urlencoded" };
      const url = await waitlistUrl();
      if (url) {
        // Anywhere (GitHub Pages, your own domain): send to the Google Sheet's web app.
        // Google doesn't let the page read the reply, so a sent request counts as success.
        await fetch(url, { method: "POST", mode: "no-cors", headers, body });
      } else {
        // On Netlify: Netlify Forms catches this.
        const r = await fetch("/", { method: "POST", headers, body });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      }
      $("wlFirst").textContent = name.split(" ")[0];
      form.hidden = true;
      $("wlDone").hidden = false;
    } catch (x) {
      console.error(x);
      err("Couldn't save that just now. Please try again in a moment.");
    } finally {
      btn.disabled = false;
      btn.textContent = "Put me on the list";
    }
  });
}

// ------------------------------------------------------------------ lottery spending counter

function lottoCounter() {
  const perSecond = 109.38e9 / (365 * 24 * 3600); // 2025 U.S. lottery sales (NASPL), about $3,468 a second
  const t0 = performance.now();
  const el = $("lotto");
  let last = "";
  const tick = () => {
    const v = "$" + Math.floor(((performance.now() - t0) / 1000) * perSecond).toLocaleString("en-US");
    if (v !== last) el.textContent = last = v;
    requestAnimationFrame(tick);
  };
  tick();
}

// ------------------------------------------------------------------ founders' contact links
// Assembled in the browser so the addresses aren't sitting in the page source for spam bots.
function contacts() {
  const mail = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v12H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
  const phone = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 3.5h3l1.5 4-2 1.3a11 11 0 0 0 6.1 6.1l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
  document.querySelectorAll(".p-contact").forEach((el) => {
    const email = `${el.dataset.user}@${el.dataset.domain}`;
    const digits = el.dataset.tel.replace(/\D/g, "");
    const pretty = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    el.innerHTML = `<a href="mailto:${email}">${mail}${email}</a><a href="tel:+1${digits}">${phone}${pretty}</a>`;
  });
}

buildScene();
contacts();
lottoCounter();
calculator();
rideScroll();
waitlist();
