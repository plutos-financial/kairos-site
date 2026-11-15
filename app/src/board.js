// The film behind the first screen, drawn in code instead of shot: a draw board.
// Seven savers, their entries and their share of the draw (the same sample as the draw further down the
// page). Every few seconds the flaps spin, settle, and one row wins, picked in proportion to its entries.
const SAVERS = [["4F2A", 9000], ["91C0", 5000], ["YOU", 6000], ["07DE", 12000], ["B3A9", 4000], ["5E1C", 8000], ["D84F", 3000]];
const TOTAL = SAVERS.reduce((a, [, n]) => a + n, 0);
const LINES = SAVERS.map(([name, n]) => name.padEnd(5) + String(n).padStart(5) + String(Math.round((n / TOTAL) * 100)).padStart(4));
const COLS = LINES[0].length;
const LOOP = 160; // frames in one loop: spin (0-50), hold, winner lit (90-150)
const any = (chars) => chars[Math.floor(Math.random() * chars.length)];

export function pickWinner(x = Math.random() * TOTAL) {
  return SAVERS.findIndex(([, n]) => (x -= n) < 0);
}

export function board(canvas) {
  const ctx = canvas.getContext("2d");
  const cw = canvas.width / COLS;
  const ch = canvas.height / LINES.length;
  let frame = 0;
  let winner = 3;
  let timer = 0;

  const draw = () => {
    const t = frame % LOOP;
    if (t === 0) winner = pickWinner();
    const won = t >= 90 && t < 150;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = `600 ${ch * 0.68}px "Geist Variable", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    LINES.forEach((line, r) => {
      const lit = won && r === winner;
      [...line].forEach((c, i) => {
        // each flap spins until its turn to settle: left to right, top row first
        if (c !== " " && t < 10 + i * 2 + r * 2) c = /\d/.test(c) ? any("0123456789") : any("ABCDEFGHJKLMNPRSTUVWXYZ");
        const x = i * cw;
        const y = r * ch;
        ctx.fillStyle = lit ? "#fff" : "#1b1b1b";
        ctx.fillRect(x + 3, y + 3, cw - 6, ch - 6);
        ctx.fillStyle = lit ? "#000" : won ? "#6d6d6d" : "#f2f2f2";
        ctx.fillText(c, x + cw / 2, y + ch * 0.53);
        ctx.fillStyle = "#000"; // the hinge across the middle of each flap
        ctx.fillRect(x + 3, y + ch / 2 - 1, cw - 6, 2);
      });
    });
    frame++;
  };

  return {
    // 12 frames a second: slow enough to read as film, and nearly free to draw
    play: () => (timer ||= setInterval(draw, 80)),
    pause: () => (timer = clearInterval(timer) || 0),
    // one settled frame with a winner lit, for people who have motion turned down
    still: () => ((frame = 100), draw()),
  };
}
