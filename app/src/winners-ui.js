// Shared pieces for showing who won: friendly names, avatars, a podium, and draw loading.
import { fmt, read } from "./core.js";

/** "You" for the signed-in saver, otherwise "Saver 74E9" (last 4 of the account). */
export function saverName(addr, me) {
  if (me && addr.toLowerCase() === me.toLowerCase()) return "You";
  return "Saver " + addr.slice(-4).toUpperCase();
}

/** A small round avatar whose colors come from the account, so the same saver always looks the same. */
export function avatar(addr, size = "") {
  const h = parseInt(addr.slice(2, 10), 16) >>> 0;
  const a = h % 360;
  const b = (a + 50 + ((h >>> 9) % 90)) % 360;
  return `<span class="av ${size}" aria-hidden="true" style="background:linear-gradient(140deg,hsl(${a} 72% 64%),hsl(${b} 68% 42%))"></span>`;
}

/** Adds up every prize per winner (one saver can win several prizes), biggest first. */
export function groupWinners(winners, amounts) {
  const by = new Map();
  winners.forEach((w, j) => {
    const k = w.toLowerCase();
    const cur = by.get(k) || { addr: w, amount: 0n, count: 0 };
    cur.amount += amounts[j];
    cur.count++;
    by.set(k, cur);
  });
  return [...by.values()].sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0));
}

const cache = new Map(); // finished draws never change
async function getDraw(id) {
  if (cache.has(id)) return cache.get(id);
  const [d, winners, amounts, entrants] = await read("vault", "getDraw", [id]);
  const row = { id, d, winners, amounts, entrants };
  if (d.awarded) cache.set(id, row);
  return row;
}

/** The most recent draws, newest first. */
export async function loadDraws(count = 12) {
  const cur = await read("vault", "currentDrawId");
  const ids = [];
  for (let id = cur - 1n; id >= 1n && ids.length < count; id--) ids.push(id);
  return { cur, draws: await Promise.all(ids.map(getDraw)) };
}

/** Newest draw that actually has winners. */
export const latestWithWinners = (draws) => draws.find((x) => x.d.awarded && x.winners.length);

export const drawTotal = (x) => x.amounts.reduce((a, b) => a + b, 0n);

export function drawWhen(x) {
  return new Date(Number(x.d.closeTime) * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const PLACE = ["1st", "2nd", "3rd"];

/** Podium for the top three winners of a draw, plus a list of everyone else who won. */
export function podiumHTML(x, me) {
  const g = groupWinners(x.winners, x.amounts);
  const top = g.slice(0, 3);
  const steps = top
    .map((w, i) => {
      const mine = me && w.addr.toLowerCase() === me.toLowerCase();
      return `<div class="pod p${i + 1}${mine ? " me" : ""}">
        ${avatar(w.addr, "lg")}
        <p class="pod-name">${saverName(w.addr, me)}</p>
        <p class="pod-amt">${fmt(w.amount)}</p>
        <p class="pod-sub">${w.count > 1 ? `${w.count} prizes` : "&nbsp;"}</p>
        <div class="pod-step"><span>${PLACE[i]}</span></div>
      </div>`;
    })
    .join("");
  const rest = g.slice(3);
  const restHTML = rest.length
    ? `<div class="pod-rest">${rest
        .map((w, i) => {
          const mine = me && w.addr.toLowerCase() === me.toLowerCase();
          return `<div class="rest-row${mine ? " me" : ""}"><span class="rest-n">${i + 4}</span>${avatar(w.addr)}<span class="rest-name">${saverName(w.addr, me)}${w.count > 1 ? ` <span class="tiny">${w.count} prizes</span>` : ""}</span><b>${fmt(w.amount)}</b></div>`;
        })
        .join("")}</div>`
    : "";
  return `<div class="podium n${top.length}">${steps}</div>${restHTML}`;
}

/** What the signed-in saver won in a draw (0n if nothing). */
export function myWin(x, me) {
  if (!me) return 0n;
  let t = 0n;
  x.winners.forEach((w, j) => w.toLowerCase() === me.toLowerCase() && (t += x.amounts[j]));
  return t;
}
