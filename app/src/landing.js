// Landing page: odds calculator, founders' contact links, waitlist (Google Sheet).
import { $ } from "./core.js";
import built from "./site-config.json";


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

// ------------------------------------------------------------------ waitlist (Google Sheet)

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
    if (form["bot-field"]?.value) return; // filled in by a bot, not a person
    if (form.dataset.sent) return; // one sign-up per visit is plenty

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
      form.dataset.sent = "1";
      $("wlFirst").textContent = name.split(" ")[0];
      form.hidden = true;
      $("wlDone").hidden = false;
    } catch (x) {
      console.error(x);
      err("Couldn't save that just now. Please try again in a moment.");
    } finally {
      btn.disabled = false;
      btn.textContent = "Join the waitlist";
    }
  });
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

// ------------------------------------------------------------------ the brand film
// Muted and looping, and it only plays while it's on screen (and never downloads before that).
// People whose device asks for less motion, or to save data, see a still frame instead.
function film() {
  const v = $("film");
  if (!v) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || navigator.connection?.saveData === true) return;
  new IntersectionObserver(
    ([e]) => {
      if (e.isIntersecting) v.play().catch(() => {}); // blocked (e.g. Low Power Mode) = the still frame stays
      else v.pause();
    },
    { threshold: 0.2 }
  ).observe(v);
}

// The homepage nav sits on the page at first, then turns solid (and tightens up) once you scroll.
function navOverFilm() {
  const nav = document.querySelector(".nav-over");
  if (!nav) return;
  const update = () => nav.classList.toggle("solid", scrollY > 8);
  addEventListener("scroll", update, { passive: true });
  addEventListener("resize", update);
  update();
}

contacts();
calculator();
waitlist();
film();
navOverFilm();
