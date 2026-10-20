function doPost(e) {
  var p = (e && e.parameter) || {};
  if (p["bot-field"]) return ok();
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Waitlist") || ss.insertSheet("Waitlist");
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["Signed up", "Name", "Email", "Phone", "Would start with", "OK to text"]);
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([new Date(), clean(p.name), clean(p.email), clean(p.phone), clean(p.amount), p.texts === "yes" ? "yes" : ""]);
  } finally {
    lock.releaseLock();
  }
  return ok();
}

function clean(v) {
  var s = String(v || "").slice(0, 200).trim();
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function ok() {
  return ContentService.createTextOutput("ok");
}
