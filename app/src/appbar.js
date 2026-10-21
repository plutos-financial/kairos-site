// The header on the app pages (Savings, Draws): tabs, and the account menu once signed in.
import { $, state, short, signOutAll } from "./core.js";

/** Fills in the account menu. `admin` shows the team-only link. */
export function showAccount({ admin = false } = {}) {
  const signedIn = Boolean(state.address);
  $("acctMenu").hidden = !signedIn;
  const signIn = $("acctSignIn");
  if (signIn) signIn.hidden = signedIn;
  if (!signedIn) return;
  $("who").textContent = state.email || short(state.address);
  $("acctEmail").textContent = state.email ? "Signed in with email" : state.mode === "wallet" ? "Signed in with a browser wallet" : "Signed in";
  const a = $("acctAddr");
  a.textContent = `Account ${short(state.address)}`;
  if (state.explorer) {
    a.href = `${state.explorer}/address/${state.address}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  } else a.removeAttribute("href");
  $("hoodLink").hidden = !admin;
}

export function wireAccount() {
  $("signout").onclick = async () => {
    await signOutAll();
    location.href = "./app.html";
  };
  // close the menu when clicking anywhere else
  document.addEventListener("click", (e) => {
    const m = $("acctMenu");
    if (m.open && !m.contains(e.target)) m.open = false;
  });
  addEventListener("keydown", (e) => e.key === "Escape" && ($("acctMenu").open = false));
}
