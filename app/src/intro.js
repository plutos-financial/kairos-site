// The opening on the homepage: the phoenix and the name stand on black, then burn away to ash while the
// page appears behind them. public/intro-gate.js decides before the first paint whether it plays, by
// putting "intro-on" on <html>. It waits until the page is actually on screen, so a page the browser
// loaded in the background still shows it. People who ask for less motion get the logo and a plain fade.
const root = document.documentElement;
const intro = document.getElementById("intro");
const HOLD = 2700; // ms the logo stands before it burns
const SWEEP = 520; // ms for the burn to cross the logo, left to right

if (intro && root.classList.contains("intro-on")) {
  root.classList.add("intro-js"); // this script is running, so the CSS safety net stands down
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let timer;
  const done = () => {
    intro.remove();
    root.classList.remove("intro-on", "intro-js", "intro-go");
  };
  const fade = () => {
    intro.classList.add("fade");
    setTimeout(done, 600);
  };
  const go = () => {
    root.classList.add("intro-go"); // lets the logo's entrance run
    timer = setTimeout(() => (calm ? fade() : burn(done).catch(done)), HOLD);
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

// Redraws the logo on a canvas exactly where it stands, cuts it into specks, and lets them rise and fade.
async function burn(done) {
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
        life: 600 + Math.random() * 380,
        vx: 14 + Math.random() * 36,
        vy: -(26 + Math.random() * 64),
        sway: Math.random() * 6.28,
      });
    }
  }
  const colour = getComputedStyle(intro).color;
  const size = step / dpr;
  const end = SWEEP + 160 + 980;
  intro.classList.add("ash"); // hides the real logo and lets the black fade

  const t0 = performance.now();
  const frame = (now) => {
    if (!intro.isConnected) return;
    const t = now - t0;
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
      c.fillRect(s.x + s.vx * sec + Math.sin(s.sway + sec * 5) * 5 * k, s.y + s.vy * sec - 46 * sec * sec, size, size);
    }
    c.globalAlpha = 1;
    if (t < end) requestAnimationFrame(frame);
    else done();
  };
  requestAnimationFrame(frame);
}
