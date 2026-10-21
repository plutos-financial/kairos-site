// Privacy page: the contact address is put together in the browser, so spam bots reading the page
// source don't find it.
import "./fresh.js";

document.querySelectorAll(".mail-to").forEach((el) => {
  const email = `${el.dataset.user}@${el.dataset.domain}`;
  const a = document.createElement("a");
  a.href = `mailto:${email}?subject=${encodeURIComponent("Delete my Plutos data")}`;
  a.textContent = email;
  el.replaceChildren(a);
});
