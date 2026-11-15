// Homepage: the phone preview, the sample draw, the chances calculator, the questions, the waitlist
// (Google Sheet) and the film behind the first screen.
import { $ } from "./core.js";
import built from "./site-config.json";
import { phone } from "./phone.js";

const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
const wait = (ms) => (calm ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));
const money = (n) => "$" + n.toLocaleString("en-US");
const dollars = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = (n) => n.toLocaleString("en-US");

// ------------------------------------------------------------------ numbers that pop when they change
// (transitions.dev "number pop-in": only the digits that changed swap; the rest hold still)

function digits(group) {
  let current = group.textContent.replace(/\s+/g, "");
  return (str) => {
    if (str === current) return;
    if (calm) {
      group.textContent = current = str;
      return;
    }
    let same = 0;
    while (same < current.length && same < str.length && current[same] === str[same]) same++;
    group.classList.remove("is-animating");
    group.replaceChildren();
    [...str].forEach((ch, i) => {
      const fresh = document.createElement("span");
      fresh.className = "t-digit";
      fresh.textContent = ch;
      if (i < same || !/\d/.test(ch)) {
        fresh.dataset.same = "";
        group.appendChild(fresh);
        return;
      }
      const slot = document.createElement("span");
      slot.className = "t-digit-slot";
      const fromEnd = str.length - 1 - i;
      if (fromEnd === 1) slot.dataset.stagger = "1";
      else if (fromEnd === 0) slot.dataset.stagger = "2";
      const oldCh = current[current.length - (str.length - i)];
      if (oldCh && /\d/.test(oldCh)) {
        const old = document.createElement("span");
        old.className = "t-digit-old";
        old.setAttribute("aria-hidden", "true");
        old.textContent = oldCh;
        slot.appendChild(old);
      }
      slot.appendChild(fresh);
      group.appendChild(slot);
    });
    current = str;
    void group.offsetHeight; // start the animation from the top
    group.classList.add("is-animating");
  };
}

// ------------------------------------------------------------------ chances calculator

const STEPS = [10, 25, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7500, 10000];
const times = (x) => (x >= 10 ? Math.round(x) : Number(x.toFixed(x < 1 ? 2 : 1))).toLocaleString("en-US") + "×";

function calculator() {
  const range = $("calcRange");
  range.max = String(STEPS.length - 1);
  const setAmt = digits($("calcAmt"));
  const setEntries = digits($("calcEntries"));
  const setBoost = digits($("calcBoost"));
  const bar = $("kept");
  const pill = bar.querySelector(".t-tabs-pill");
  const choices = [...bar.querySelectorAll(".t-tab")];
  let kept = 1; // how much each dollar counts for, by how long it has stayed in

  // the sliding pill behind the chosen length of time (transitions.dev "tabs sliding")
  const movePill = (tab, animate) => {
    const prev = pill.style.transition;
    if (!animate) pill.style.transition = "none";
    pill.style.transform = `translateX(${tab.offsetLeft}px)`;
    pill.style.width = `${tab.offsetWidth}px`;
    if (!animate) {
      void pill.offsetWidth;
      pill.style.transition = prev;
    }
  };
  const chosen = () => choices.find((b) => Number(b.dataset.x) === kept) || choices[0];

  const render = () => {
    const amt = STEPS[Number(range.value)];
    const entries = amt * kept;
    setAmt(money(amt));
    setEntries(count(entries));
    setBoost(times(entries / 100));
    range.style.setProperty("--fill", `${(Number(range.value) / (STEPS.length - 1)) * 100}%`);
    range.setAttribute("aria-valuetext", money(amt));
    choices.forEach((b) => {
      const on = Number(b.dataset.x) === kept;
      b.setAttribute("aria-checked", String(on));
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  };
  range.addEventListener("input", render);
  bar.addEventListener("click", (e) => {
    const b = e.target.closest(".t-tab");
    if (!b) return;
    kept = Number(b.dataset.x);
    render();
    movePill(b, true);
  });
  // arrow keys move between the choices, like any radio group
  bar.addEventListener("keydown", (e) => {
    const i = choices.indexOf(document.activeElement);
    if (i < 0 || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const next = choices[(i + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? choices.length - 1 : 1)) % choices.length];
    next.focus();
    next.click();
  });
  render();
  requestAnimationFrame(() => movePill(chosen(), false));
  addEventListener("resize", () => movePill(chosen(), false));
  document.fonts?.ready.then(() => movePill(chosen(), false));
}

// ------------------------------------------------------------------ the small pictures in "how it works"
// Each plays once when it comes on screen, and again when you point at its card.

function pictures() {
  const cards = [...document.querySelectorAll("[data-play]")];
  const interest = $("billsInterest");
  const target = 36.4;
  const countUp = () => {
    if (calm) return;
    const t0 = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 1800);
      interest.textContent = dollars(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const play = (card) => {
    if (card.dataset.busy) return;
    card.dataset.busy = "1";
    card.classList.remove("play");
    void card.offsetWidth;
    card.classList.add("play");
    if (card.contains(interest)) countUp();
    setTimeout(() => delete card.dataset.busy, 2600);
  };
  if (!("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        play(e.target);
        io.unobserve(e.target);
      }
    },
    { threshold: 0.45 }
  );
  cards.forEach((c) => {
    io.observe(c);
    c.addEventListener("pointerenter", () => play(c));
  });
}

// ------------------------------------------------------------------ a sample draw
// The real steps in miniature: lock the entries, publish their fingerprint (a real SHA-256 of them),
// take a random number (made up by the browser here; drand in a real draw), and let it point at one entry.

const SAVERS = [
  ["Saver 4F2A", 9000],
  ["Saver 91C0", 5000],
  ["You", 6000],
  ["Saver 07DE", 12000],
  ["Saver B3A9", 4000],
  ["Saver 5E1C", 8000],
  ["Saver D84F", 3000],
];
const TOTAL = SAVERS.reduce((a, [, n]) => a + n, 0);
const PRIZE = 1000;
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const short = (h) => `${h.slice(0, 12)}…${h.slice(-8)}`;

async function fingerprint() {
  const text = new TextEncoder().encode(JSON.stringify(SAVERS));
  if (!crypto.subtle) return hex(crypto.getRandomValues(new Uint8Array(32))); // not a secure page: no hashing
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", text)));
}

function draw() {
  const go = $("drawGo");
  const steps = [...$("drawSteps").children];
  const track = $("drawTrack");
  const pin = $("drawPin");
  const text = $("drawText");
  const check = $("drawCheck");
  const out = { print: $("drawPrint"), number: $("drawNumber"), sum: $("drawSum") };
  const state = (i, s) => steps[i].setAttribute("data-state", s);
  let running = false;
  let at = 0; // where the pin is, as a share of the line

  // Where an entry sits on the line, measured from the segment it belongs to.
  const place = (entry) => {
    let before = 0;
    for (let i = 0; i < SAVERS.length; i++) {
      const size = SAVERS[i][1];
      if (entry <= before + size) {
        const seg = track.children[i];
        const x = seg.offsetLeft + ((entry - before - 0.5) / size) * seg.offsetWidth;
        return { i, share: x / track.offsetWidth };
      }
      before += size;
    }
    return { i: SAVERS.length - 1, share: 1 };
  };

  const sweep = (to) =>
    new Promise((done) => {
      if (calm) {
        pin.style.left = `${to * 100}%`;
        return done();
      }
      const from = at;
      const dist = 1 - from + 1 + to; // to the end, once right round, then on to the spot
      const t0 = performance.now();
      const step = (t) => {
        const p = Math.min(1, (t - t0) / 2600);
        pin.style.left = `${((from + dist * (1 - Math.pow(1 - p, 3))) % 1) * 100}%`;
        if (p < 1) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });

  go.addEventListener("click", async () => {
    if (running) return;
    running = true;
    go.disabled = true;
    go.classList.add("is-busy");
    go.innerHTML = `<span class="spinner"></span>Drawing`;
    check.setAttribute("data-state", "out");
    [...track.children].forEach((s) => s.classList.remove("hit"));
    steps.forEach((_, i) => state(i, "idle"));
    Object.values(out).forEach((el) => (el.hidden = true));
    text.textContent = "The draw is running.";

    state(0, "active");
    await wait(500);
    state(0, "done");

    state(1, "active");
    const print = await fingerprint();
    await wait(500);
    out.print.textContent = short(print);
    out.print.hidden = false;
    state(1, "done");

    state(2, "active");
    out.number.innerHTML = `<span class="t-shimmer" data-text="Waiting for the number">Waiting for the number</span>`;
    out.number.hidden = false;
    await wait(1400);
    const number = hex(crypto.getRandomValues(new Uint8Array(32)));
    out.number.textContent = short(number);
    state(2, "done");

    state(3, "active");
    const entry = Number(BigInt("0x" + number) % BigInt(TOTAL)) + 1;
    const { i, share } = place(entry);
    await sweep(share);
    at = share;
    track.children[i].classList.add("hit");
    out.sum.textContent = `number mod ${count(TOTAL)} + 1 = entry ${count(entry)}`;
    out.sum.hidden = false;
    state(3, "done");

    const [name] = SAVERS[i];
    text.innerHTML =
      name === "You"
        ? `It landed on entry ${count(entry)}, one of yours. <b>You would win ${dollars(PRIZE)}</b>, paid straight into your savings.`
        : `It landed on entry ${count(entry)}, which belongs to ${name}. They win ${dollars(PRIZE)}. Your savings stay exactly where they are, and are entered again next month.`;
    void check.offsetWidth;
    check.setAttribute("data-state", "in");
    go.textContent = "Run it again";
    go.classList.remove("is-busy");
    go.disabled = false;
    running = false;
  });
}

// ------------------------------------------------------------------ questions
// (transitions.dev "accordion": the panel grows by grid rows, the chevron flips)

function questions() {
  document.querySelectorAll(".faq .t-acc").forEach((acc) => {
    const head = acc.querySelector(".t-acc-head");
    head.addEventListener("click", () => {
      const open = acc.getAttribute("data-open") === "true";
      acc.setAttribute("data-open", String(!open));
      head.setAttribute("aria-expanded", String(!open));
    });
  });
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
  const failed = (m) => ($("wlError").textContent = m || "");
  const rules = [
    ["wlName", (v) => v.length >= 2],
    ["wlEmail", (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)],
    ["wlPhone", (v) => v.replace(/\D/g, "").length >= 10],
  ];

  // An answer that won't do: its field turns red, shakes once and says why, until it is typed in again.
  // (transitions.dev "error state shake")
  const flag = (input) => {
    const wrap = input.closest(".t-input-wrap");
    const box = input.closest(".t-input");
    wrap.classList.add("is-error");
    box.classList.add("is-error");
    input.setAttribute("aria-invalid", "true");
    box.classList.remove("is-shaking");
    void box.offsetWidth;
    box.classList.add("is-shaking");
    setTimeout(() => box.classList.remove("is-shaking"), 320);
  };
  rules.forEach(([id]) => {
    const input = $(id);
    input.addEventListener("input", () => {
      input.closest(".t-input-wrap").classList.remove("is-error");
      input.closest(".t-input").classList.remove("is-error");
      input.removeAttribute("aria-invalid");
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    failed("");
    const bad = rules.filter(([id, ok]) => !ok($(id).value.trim())).map(([id]) => $(id));
    bad.forEach(flag);
    if (bad.length) return bad[0].focus();
    if (form["bot-field"]?.value) return; // filled in by a bot, not a person
    if (form.dataset.sent) return; // one sign-up per visit is plenty

    const name = form.name.value.trim();
    const btn = $("wlSubmit");
    const busy = (on) => {
      btn.disabled = on;
      btn.querySelector(".spinner").hidden = !on;
      $("wlSubmitText").textContent = on ? "Adding you" : "Join the waitlist";
    };
    busy(true);
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
      $("wlCheck").setAttribute("data-state", "in");
      $("wlDoneTitle").focus({ preventScroll: true });
    } catch (x) {
      console.error(x);
      failed("That didn't send. Please try again in a moment.");
    } finally {
      busy(false);
    }
  });
}

// ------------------------------------------------------------------ the film behind the first screen
// Muted and looping, it plays only while it's on screen (and never downloads before that), and it can
// be paused. People who ask for less motion or to save data get the still picture instead.
function film() {
  const v = $("film");
  const toggle = $("filmToggle");
  if (!v || calm || navigator.connection?.saveData === true) return;
  let stopped = false; // paused by the visitor
  let onScreen = false;
  const sync = () => {
    if (onScreen && !stopped) v.play().catch(() => {}); // blocked (e.g. Low Power Mode) = the picture stays
    else if (!v.paused) v.pause();
  };
  new IntersectionObserver(
    ([e]) => {
      onScreen = e.isIntersecting;
      sync();
    },
    { threshold: 0.15 }
  ).observe(v.closest(".hero"));
  toggle.hidden = false;
  toggle.addEventListener("click", () => {
    stopped = !stopped;
    toggle.setAttribute("aria-pressed", String(stopped));
    $("filmToggleText").textContent = stopped ? "Play film" : "Pause film";
    sync();
  });
}

// The nav is clear over the top of the film and turns solid as soon as the page moves.
function nav() {
  const bar = $("nav");
  const update = () => bar.classList.toggle("solid", scrollY > 24);
  addEventListener("scroll", update, { passive: true });
  update();
}

phone();
calculator();
pictures();
draw();
questions();
waitlist();
film();
nav();
