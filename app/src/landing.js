// Landing page: odds calculator, waitlist (Google Sheet), brand film.
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

// ------------------------------------------------------------------ the brand film
// Muted and looping, and it only plays while it's on screen (and never downloads before that).
// Paused for people who ask for less motion or to save data; the corner button plays or pauses it.
function film() {
  const v = $("film");
  const btn = $("filmToggle");
  if (!v || !btn) return;
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches || navigator.connection?.saveData === true;
  let wanted = !calm; // what the visitor wants: playing or not
  let inView = false;
  const show = () => {
    const playing = !v.paused;
    btn.dataset.state = playing ? "playing" : "paused";
    btn.setAttribute("aria-label", playing ? "Pause the video" : "Play the video");
  };
  const play = () => v.play().catch(() => {}).finally(show); // blocked (e.g. Low Power Mode) = the poster stays
  new IntersectionObserver(
    ([e]) => {
      inView = e.isIntersecting;
      if (inView && wanted) play();
      else if (!inView && !v.paused) v.pause();
    },
    { threshold: 0.2 }
  ).observe(v.closest(".film"));
  btn.onclick = () => {
    wanted = v.paused;
    if (wanted) play();
    else v.pause();
  };
  v.addEventListener("play", show);
  v.addEventListener("pause", show);
  show();
}

// The homepage nav floats over the film, and turns solid once the film has scrolled away.
function navOverFilm() {
  const nav = document.querySelector(".nav-over");
  const f = document.querySelector(".film");
  if (!nav || !f) return;
  const update = () => nav.classList.toggle("solid", f.getBoundingClientRect().bottom < nav.offsetHeight + 8);
  addEventListener("scroll", update, { passive: true });
  addEventListener("resize", update);
  update();
}

calculator();
waitlist();
film();
navOverFilm();
