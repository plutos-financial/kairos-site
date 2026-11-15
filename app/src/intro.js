// The opening on the homepage: the phoenix and the name stand on black and burn away to ash on the black,
// then the black lifts off the page in one fade. public/intro-gate.js decides before the first paint whether
// it plays, by putting "intro-on" on <html>. It waits until the page is actually on screen, so a page the
// browser loaded in the background still shows it. People who ask for less motion get the same dissolve
// with the ash standing still: it fades where it is and nothing travels.
const root = document.documentElement;
const intro = document.getElementById("intro");
const HOLD = 2700; // ms the logo stands before it burns
const SWEEP = 700; // ms for the burn to cross the logo, left to right
const LIFT = SWEEP + 550; // ms into the burn when the black starts to lift: most of the ash has gone by then (home.css times the headline to it)

if (intro && root.classList.contains("intro-on")) {
  root.classList.add("intro-js"); // this script is running, so the CSS safety net stands down
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let timer;
  const done = () => {
    intro.remove();
    root.classList.remove("intro-on", "intro-js", "intro-go");
  };
  const fade = () => {
    const film = document.getElementById("film");
    if (film) film.currentTime = 0; // the page appears on the film's first frame
    intro.classList.add("fade");
    setTimeout(done, 600);
  };
  const go = () => {
    root.classList.add("intro-go"); // lets the logo's entrance run
    timer = setTimeout(() => burn(fade, calm ? 0 : 1).catch(fade), HOLD);
  };
  if (document.visibilityState === "visible") go();
  else {
    const seen = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", seen);
      go();
    };
    document.addEventListener("visibilitychange", seen);
  }
  // a tap or a key skips it
  const skip = () => {
    clearTimeout(timer);
    done();
  };
  intro.addEventListener("pointerdown", skip, { once: true });
  addEventListener("keydown", skip, { once: true });
}

// Redraws the logo on a canvas exactly where it stands, cuts it into specks, and lets them rise and fade
// (drift 1) or fade where they are (drift 0). Calls lift once the burn has crossed the logo.
async function burn(lift, drift) {
  if (!intro.isConnected) return;
  const bird = intro.querySelector(".intro-bird");
  const word = intro.querySelector(".intro-word");
  const cv = intro.querySelector(".intro-ash");
  const img = new Image();
  img.src = new URL("./media/plutos-phoenix-bold.svg", import.meta.url).href;
  await Promise.all([img.decode(), document.fonts.ready]);

  const dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = Math.round(innerWidth * dpr);
  cv.height = Math.round(innerHeight * dpr);
  const c = cv.getContext("2d", { willReadFrequently: true });
  c.scale(dpr, dpr);
  const b = bird.getBoundingClientRect();
  const w = word.getBoundingClientRect();
  const fit = Math.min(b.width / img.width, b.height / img.height);
  c.drawImage(img, b.left + (b.width - img.width * fit) / 2, b.top + (b.height - img.height * fit) / 2, img.width * fit, img.height * fit);
  const cs = getComputedStyle(word);
  c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  c.letterSpacing = cs.letterSpacing;
  c.textBaseline = "middle";
  c.fillText(word.textContent, w.left, w.top + w.height / 2);

  // one speck for every few pixels of ink
  const left = Math.floor(Math.min(b.left, w.left)) - 2;
  const top = Math.floor(Math.min(b.top, w.top)) - 2;
  const wide = Math.ceil(Math.max(b.right, w.right)) + 2 - left;
  const high = Math.ceil(Math.max(b.bottom, w.bottom)) + 2 - top;
  const px = c.getImageData(left * dpr, top * dpr, wide * dpr, high * dpr);
  const step = dpr > 1 ? 3 : 2;
  const specks = [];
  for (let y = 0; y < px.height; y += step) {
    for (let x = 0; x < px.width; x += step) {
      if (px.data[(y * px.width + x) * 4 + 3] < 110) continue;
      specks.push({
        x: left + x / dpr,
        y: top + y / dpr,
        at: (x / px.width) * SWEEP + Math.random() * 160, // when the burn reaches it
        life: 500 + Math.random() * 400,
        vx: (14 + Math.random() * 36) * drift,
        vy: -(26 + Math.random() * 64) * drift,
        sway: Math.random() * 6.28,
      });
    }
  }
  const colour = getComputedStyle(intro).color;
  const size = step / dpr;
  intro.classList.add("ash"); // hides the real logo; the specks now stand in for it

  const t0 = performance.now();
  let lifted = false;
  const frame = (now) => {
    if (!intro.isConnected) return; // lift() removes the opening when its fade ends, which stops this
    const t = now - t0;
    if (!lifted && t >= LIFT) {
      lifted = true;
      lift();
    }
    c.clearRect(0, 0, innerWidth, innerHeight);
    c.fillStyle = colour;
    for (const s of specks) {
      const age = t - s.at;
      if (age <= 0) {
        c.globalAlpha = 1;
        c.fillRect(s.x, s.y, size, size);
        continue;
      }
      if (age >= s.life) continue;
      const k = age / s.life;
      const sec = age / 1000;
      c.globalAlpha = (1 - k) * (1 - k);
      c.fillRect(s.x + (s.vx * sec + Math.sin(s.sway + sec * 5) * 5 * k) * drift, s.y + (s.vy * sec - 46 * sec * sec) * drift, size, size);
    }
    c.globalAlpha = 1;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
