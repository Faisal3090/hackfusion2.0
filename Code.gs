/**
 * HACKFUSION 2K27 - Registration backend (Google Apps Script Web App)
 *
 * TRUST MODEL
 *   Browser (index.html)   = UNTRUSTED
 *   This script            = validation + business logic
 *   Google Sheet           = data store
 *   Organizer              = the ONLY authority that can verify payment
 *
 * SETUP: run setupSheet() once, then Deploy > New deployment > Web app
 * (Execute as: Me, Who has access: Anyone). See SETUP.md.
 */

/* ================= CONFIGURATION (edit these) ================= */
const SPREADSHEET_ID = "1KktZjDbgWCfatgi_i7V7xzC04bQ4Ys2vpQolv_NpT1o";
const SHEET_NAME = "Registrations";

const REGISTRATION_OPEN = true;          // set false to stop accepting registrations
const REGISTRATION_FEE = 300;            // rupees per person. THE SERVER decides the amount, not the browser.
const ID_PREFIX = "HF27-";               // Registration IDs: HF27-0001, HF27-0002, ...
const TIMEZONE = "Asia/Kolkata";
const MAX_ADDITIONAL_MEMBERS = 4;        // team size max = 5 including the leader

// Must match the titles in the DOMAINS array in index.html.
const DOMAINS = ["AI & Machine Learning", "Web & Apps", "Cybersecurity", "IoT & Hardware", "Open Innovation"];

// ---- Confirmation email settings ----
const EVENT_NAME = "HackFusion 2K27";
const EVENT_WHEN_WHERE = "This October at VDIT";           // shown in the email
const ORGANIZER_EMAIL = "PASTE_ORGANIZER_REPLY_TO_EMAIL";   // replies from team leads go here (leave as is to skip)
const WHATSAPP_LINK = "PASTE_WHATSAPP_LINK_HERE";           // https:// invite link; button hidden if not set
const SEND_CONFIRMATION_EMAIL = true;                        // set false to turn emails off

const RATE = { perEmailMax: 5, perEmailWindowSec: 600, globalMax: 60, globalWindowSec: 60 };
const MAX_BODY_CHARS = 20000;
/* ============================================================== */

const HEADERS = [
  "Timestamp", "Registration ID", "Institute Name",
  "Team Leader Name", "Team Leader Email", "Team Leader Phone",
  "Additional Team Members", "Total Team Size",
  "Member 1 Name", "Member 1 Email", "Member 1 Phone",
  "Member 2 Name", "Member 2 Email", "Member 2 Phone",
  "Member 3 Name", "Member 3 Email", "Member 3 Phone",
  "Member 4 Name", "Member 4 Email", "Member 4 Phone",
  "Boys Count", "Girls Count",
  "Accommodation Required Previous Day", "Domain",
  "Payment Amount", "UTR Number", "Payment Date", "Payment Time", "Server Submission Timestamp",
  "Payment Status", "Registration Status",
  "Duplicate Flag", "Admin Notes", "Submission Token", "Confirmation Email"
];
const COL = {}; HEADERS.forEach(function (h, i) { COL[h] = i; });
const NUMERIC_COLS = ["Additional Team Members", "Total Team Size", "Boys Count", "Girls Count", "Payment Amount"];
const PAYMENT_STATUSES = ["PENDING", "VERIFIED", "REJECTED"];
const REGISTRATION_STATUSES = ["RECEIVED", "CONFIRMED", "WAITLISTED", "CANCELLED", "REJECTED"];

/* ================= WEB APP ENTRY POINTS ================= */

// Opening the URL in a browser shows nothing sensitive.
function doGet() {
  return reply_({ ok: true, service: "HackFusion 2K27 registration", open: REGISTRATION_OPEN });
}

function doPost(e) {
  var lock = null;
  try {
    if (!REGISTRATION_OPEN) return reply_({ ok: false, code: "CLOSED", message: "Registrations are closed." });

    var raw = e && e.postData && e.postData.contents;
    if (!raw || raw.length > MAX_BODY_CHARS) return reply_({ ok: false, code: "BAD_REQUEST", message: "Invalid request." });
    var p;
    try { p = JSON.parse(raw); } catch (err) { return reply_({ ok: false, code: "BAD_REQUEST", message: "Invalid request." }); }
    if (!p || typeof p !== "object" || Array.isArray(p)) return reply_({ ok: false, code: "BAD_REQUEST", message: "Invalid request." });

    // Honeypot: real users never see this field.
    if (str_(p.website_url) !== "") return reply_({ ok: false, code: "REJECTED", message: "Could not process this request." });

    var v = validate_(p);                       // server-side validation. Client values are never trusted.
    if (!v.ok) return reply_({ ok: false, code: "VALIDATION", message: v.message });
    var d = v.data;

    // One registration at a time: makes duplicate checks and ID generation race-free.
    lock = LockService.getScriptLock();
    lock.waitLock(25000);

    var sheet = getSheet_();
    var rows = readRows_(sheet);

    // 1) Idempotency: same token + same leader email => return the existing registration.
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i].v;
      if (r[COL["Submission Token"]] === d.token && lower_(r[COL["Team Leader Email"]]) === d.leaderEmail) {
        return reply_(successFrom_(r, true));
      }
    }

    // 2) Rate limiting (replays above are not counted).
    if (!rateOk_(d.leaderEmail)) return reply_({ ok: false, code: "RATE_LIMITED", message: "Too many attempts." });

    // 3) Duplicate team: same leader email or leader phone => reject.
    for (var j = 0; j < rows.length; j++) {
      var rr = rows[j].v;
      if (lower_(rr[COL["Team Leader Email"]]) === d.leaderEmail || phoneKey_(rr[COL["Team Leader Phone"]]) === d.leaderPhone) {
        return reply_({ ok: false, code: "DUPLICATE_TEAM", message: "Already registered." });
      }
    }

    // 4) Flags (never reject, never mark paid): duplicate UTR, member overlap, similar team.
    var flags = computeFlags_(d, rows);

    // 5) Build the row. Status columns are set by the SERVER only.
    var next = nextIdNumber_(rows);
    var regId = ID_PREFIX + Utilities.formatString("%04d", next);
    var ts = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm:ss");

    var row = new Array(HEADERS.length).fill("");
    row[COL["Timestamp"]] = ts;
    row[COL["Registration ID"]] = regId;
    row[COL["Institute Name"]] = d.institute;
    row[COL["Team Leader Name"]] = d.leaderName;
    row[COL["Team Leader Email"]] = d.leaderEmail;
    row[COL["Team Leader Phone"]] = d.leaderPhone;
    row[COL["Additional Team Members"]] = d.additional;
    row[COL["Total Team Size"]] = d.additional + 1;
    for (var m = 0; m < d.members.length; m++) {          // unused member columns stay blank
      row[COL["Member " + (m + 1) + " Name"]] = d.members[m].name;
      row[COL["Member " + (m + 1) + " Email"]] = d.members[m].email;
      row[COL["Member " + (m + 1) + " Phone"]] = d.members[m].phone;
    }
    row[COL["Boys Count"]] = d.boys;
    row[COL["Girls Count"]] = d.girls;
    row[COL["Accommodation Required Previous Day"]] = d.accommodation;
    row[COL["Domain"]] = d.domain;
    row[COL["Payment Amount"]] = REGISTRATION_FEE * (d.additional + 1);
    row[COL["UTR Number"]] = d.utr;
    row[COL["Payment Date"]] = d.paymentDate;
    row[COL["Payment Time"]] = d.paymentTime;
    row[COL["Server Submission Timestamp"]] = ts;
    row[COL["Payment Status"]] = "PENDING";
    row[COL["Registration Status"]] = "RECEIVED";
    row[COL["Duplicate Flag"]] = flags.join("; ");
    row[COL["Admin Notes"]] = "";
    row[COL["Submission Token"]] = d.token;

    var range = sheet.getRange(sheet.getLastRow() + 1, 1, 1, HEADERS.length);
    // Text format on every text cell: values like "=1+1" or "+91..." can never be treated as formulas.
    range.setNumberFormats([HEADERS.map(function (h) { return NUMERIC_COLS.indexOf(h) >= 0 ? "0" : "@"; })]);
    range.setValues([row]);
    SpreadsheetApp.flush();
    PropertiesService.getScriptProperties().setProperty("LAST_ID_NUMBER", String(next));

    // Release the lock BEFORE emailing so other registrations are never blocked by slow mail.
    lock.releaseLock(); lock = null;
    if (SEND_CONFIRMATION_EMAIL) trySendConfirmation_(sheet, range.getRow(), row);   // never breaks registration

    return reply_(successFrom_(row, false));
  } catch (err) {
    console.error("doPost failed: " + (err && err.message ? err.message : "unknown"));   // no personal data logged
    return reply_({ ok: false, code: "SERVER_ERROR", message: "Service unavailable." });
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e2) {} }
  }
}

/* ================= VALIDATION ================= */

function validate_(p) {
  function bad(m) { return { ok: false, message: m }; }
  var RE_EMAIL = /^[a-z0-9._%+\-]+@[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?)*\.[a-z]{2,}$/;
  var RE_NAME = /^[\p{L}][\p{L}\p{M} .'â€™\-]{1,79}$/u;

  var token = str_(p.token);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return bad("Invalid request. Please refresh the page and try again.");

  var institute = clean_(p.institute);
  if (institute.length < 3 || institute.length > 120 || !/\p{L}/u.test(institute) || /[<>]/.test(institute) || /^[=+\-@]/.test(institute)) return bad("Please enter a valid institute name.");

  var leaderEmail = lower_(p.leaderEmail);
  if (leaderEmail.length > 254 || !RE_EMAIL.test(leaderEmail) || leaderEmail.indexOf("..") >= 0) return bad("Please enter a valid team leader email.");

  var leaderName = clean_(p.leaderName);
  if (!RE_NAME.test(leaderName)) return bad("Please enter a valid team leader name.");

  var leaderPhone = normPhone_(p.leaderPhone);
  if (!leaderPhone) return bad("Please enter a valid team leader phone number.");

  var additional = int_(p.additionalMembers);
  if (isNaN(additional) || additional < 0 || additional > MAX_ADDITIONAL_MEMBERS) return bad("Additional members must be between 0 and " + MAX_ADDITIONAL_MEMBERS + ".");
  if (!Array.isArray(p.members) || p.members.length !== additional) return bad("Team member details do not match the team size.");

  var emails = [leaderEmail], phones = [leaderPhone], members = [];
  for (var i = 0; i < additional; i++) {
    var m = p.members[i];
    if (!m || typeof m !== "object") return bad("Team member " + (i + 1) + " details are invalid.");
    var mn = clean_(m.name), me = lower_(m.email), mp = normPhone_(m.phone);
    if (!RE_NAME.test(mn)) return bad("Please enter a valid name for team member " + (i + 1) + ".");
    if (me.length > 254 || !RE_EMAIL.test(me) || me.indexOf("..") >= 0) return bad("Please enter a valid email for team member " + (i + 1) + ".");
    if (!mp) return bad("Please enter a valid phone number for team member " + (i + 1) + ".");
    if (emails.indexOf(me) >= 0) return bad("Each team member needs a different email address.");
    if (phones.indexOf(mp) >= 0) return bad("Each team member needs a different phone number.");
    emails.push(me); phones.push(mp);
    members.push({ name: mn, email: me, phone: mp });
  }

  var total = additional + 1;
  var boys = int_(p.boys), girls = int_(p.girls);
  if (isNaN(boys) || isNaN(girls) || boys > total || girls > total) return bad("Invalid boy/girl counts.");
  if (boys + girls !== total) return bad("Boy + Girl count must equal total team size.");

  var accommodation = str_(p.accommodation);
  if (accommodation !== "Yes" && accommodation !== "No") return bad("Please choose the accommodation option.");

  var domain = str_(p.domain);
  if (DOMAINS.indexOf(domain) < 0) return bad("Please choose a valid domain.");

  var utr = str_(p.utr).replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9]{8,22}$/.test(utr)) return bad("Please enter a valid UTR number.");

  var pd = str_(p.paymentDate), pt = str_(p.paymentTime);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pd) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(pt)) return bad("Please enter a valid payment date and time.");
  var paidAt = new Date(pd + "T" + pt + ":00+05:30");
  if (isNaN(paidAt.getTime())) return bad("Please enter a valid payment date and time.");
  var now = Date.now();
  if (paidAt.getTime() > now + 15 * 60 * 1000) return bad("Payment date/time cannot be in the future.");
  if (paidAt.getTime() < now - 60 * 24 * 3600 * 1000) return bad("Payment date looks too old. Please check it.");

  return { ok: true, data: {
    token: token, institute: institute, leaderEmail: leaderEmail, leaderName: leaderName, leaderPhone: leaderPhone,
    additional: additional, members: members, boys: boys, girls: girls,
    accommodation: accommodation, domain: domain, utr: utr, paymentDate: pd, paymentTime: pt
  } };
}

/* ================= DUPLICATE FLAGS ================= */

function computeFlags_(d, rows) {
  var flags = [], utrIds = [], memberIds = [], teamIds = [];
  var myEmails = [d.leaderEmail], myPhones = [d.leaderPhone];
  d.members.forEach(function (m) { myEmails.push(m.email); myPhones.push(m.phone); });

  rows.forEach(function (row) {
    var r = row.v, id = r[COL["Registration ID"]];
    if (String(r[COL["UTR Number"]]).toUpperCase() === d.utr) utrIds.push(id);

    var theirEmails = [], theirPhones = [];
    ["Team Leader", "Member 1", "Member 2", "Member 3", "Member 4"].forEach(function (k) {
      var e = lower_(r[COL[k === "Team Leader" ? "Team Leader Email" : k + " Email"]]);
      var p = phoneKey_(r[COL[k === "Team Leader" ? "Team Leader Phone" : k + " Phone"]]);
      if (e) theirEmails.push(e); if (p) theirPhones.push(p);
    });
    var overlap = myEmails.some(function (e) { return theirEmails.indexOf(e) >= 0; }) ||
                  myPhones.some(function (p) { return theirPhones.indexOf(p) >= 0; });
    if (overlap) memberIds.push(id);

    if (lower_(r[COL["Institute Name"]]) === d.institute.toLowerCase() && lower_(r[COL["Team Leader Name"]]) === d.leaderName.toLowerCase()) teamIds.push(id);
  });

  if (utrIds.length) flags.push("POSSIBLE DUPLICATE UTR (" + utrIds.join(", ") + ")");
  if (memberIds.length) flags.push("POSSIBLE DUPLICATE MEMBER (" + memberIds.join(", ") + ")");
  if (teamIds.length) flags.push("POSSIBLE DUPLICATE TEAM (" + teamIds.join(", ") + ")");
  return flags;
}

/* ================= HELPERS ================= */

function successFrom_(r, replay) {
  return {
    ok: true,
    registrationId: String(r[COL["Registration ID"]]),
    leaderName: String(r[COL["Team Leader Name"]]),
    institute: String(r[COL["Institute Name"]]),
    domain: String(r[COL["Domain"]]),
    paymentStatus: String(r[COL["Payment Status"]] || "PENDING"),   // PENDING at creation; only an organizer changes it in the sheet
    replay: !!replay
  };
}

function nextIdNumber_(rows) {
  var max = 0, re = new RegExp("^" + ID_PREFIX + "(\\d+)$");
  rows.forEach(function (row) { var m = re.exec(String(row.v[COL["Registration ID"]])); if (m) max = Math.max(max, parseInt(m[1], 10)); });
  var stored = parseInt(PropertiesService.getScriptProperties().getProperty("LAST_ID_NUMBER") || "0", 10) || 0;
  return Math.max(max, stored) + 1;      // never reuses an ID, even if rows were deleted
}

function rateOk_(email) {
  var c = CacheService.getScriptCache();
  var g = "rl:g:" + Math.floor(Date.now() / (RATE.globalWindowSec * 1000));
  var k = "rl:e:" + hash_(email);
  var gc = parseInt(c.get(g) || "0", 10), ec = parseInt(c.get(k) || "0", 10);
  if (gc >= RATE.globalMax || ec >= RATE.perEmailMax) return false;
  c.put(g, String(gc + 1), RATE.globalWindowSec * 2);
  c.put(k, String(ec + 1), RATE.perEmailWindowSec);
  return true;
}
function hash_(s) { return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s)); }

function getSheet_() {
  var sh = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
  if (!sh) throw new Error("Sheet tab not found");
  var cur = sh.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  for (var i = 0; i < HEADERS.length; i++) if (cur[i] !== HEADERS[i]) throw new Error("Header row mismatch. Run setupSheet().");
  return sh;
}
function readRows_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, HEADERS.length).getDisplayValues().map(function (v, i) { return { rowNumber: i + 2, v: v }; });
}

function reply_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function str_(v) { return (typeof v === "string") ? v.trim() : (typeof v === "number" ? String(v) : ""); }
function clean_(v) { return str_(v).replace(/\s+/g, " "); }
function lower_(v) { return String(v == null ? "" : v).trim().toLowerCase(); }
function int_(v) { if (typeof v === "number" && isFinite(v) && Math.floor(v) === v) return v; if (typeof v === "string" && /^\d+$/.test(v.trim())) return parseInt(v, 10); return NaN; }
function normPhone_(v) { var s = str_(v).replace(/[\s\-()]/g, ""); return /^(?:\+91)?[6-9]\d{9}$/.test(s) ? "+91" + s.slice(-10) : ""; }
function phoneKey_(v) { return normPhone_(String(v == null ? "" : v)); }

/* ================= CONFIRMATION EMAILS ================= */

// Sends the email and records SENT / FAILED / SKIPPED in the "Confirmation Email" column.
// Any error is swallowed here on purpose: a mail problem must never undo a registration.
function trySendConfirmation_(sheet, rowNumber, rowValues) {
  var status;
  try {
    status = sendConfirmationEmail_(rowValues) ? "SENT " + Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd HH:mm") : "SKIPPED";
  } catch (err) {
    console.error("Confirmation email failed: " + (err && err.message ? err.message : "unknown"));
    status = "FAILED";
  }
  try { sheet.getRange(rowNumber, COL["Confirmation Email"] + 1).setValue(status); } catch (e2) {}
}

function h_(v) { return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }

// r = a row array indexed by COL[...]. Used for new rows and for resends.
function sendConfirmationEmail_(r) {
  var to = lower_(r[COL["Team Leader Email"]]);
  if (!to) return false;
  if (MailApp.getRemainingDailyQuota() < 1) throw new Error("Daily email quota exhausted");

  var regId = String(r[COL["Registration ID"]]), leader = String(r[COL["Team Leader Name"]]);
  var institute = String(r[COL["Institute Name"]]), domain = String(r[COL["Domain"]]);
  var size = String(r[COL["Total Team Size"]]), acc = String(r[COL["Accommodation Required Previous Day"]]);
  var utr = String(r[COL["UTR Number"]]), utrTail = utr.length > 4 ? "ending " + utr.slice(-4) : "";
  var first = leader.split(" ")[0];

  var roster = [leader + " (Team Leader)"];
  for (var k = 1; k <= MAX_ADDITIONAL_MEMBERS; k++) { var n = String(r[COL["Member " + k + " Name"]] || "").trim(); if (n) roster.push(n); }

  var waOk = /^https:\/\/(chat\.whatsapp\.com|wa\.me|(www\.)?whatsapp\.com)\//i.test(WHATSAPP_LINK);
  var replyTo = (ORGANIZER_EMAIL.indexOf("PASTE_") === 0) ? "" : ORGANIZER_EMAIL;

  var subject = "Welcome to " + EVENT_NAME + " - Registration Received (" + regId + ")";

  var text = "Hi " + first + ",\n\n" +
    "Welcome to " + EVENT_NAME + "! We are thrilled to have you and your team on board.\n\n" +
    "Your registration has been received.\n\n" +
    "Registration ID: " + regId + "\nInstitute: " + institute + "\nDomain: " + domain + "\nTeam size: " + size +
    "\nAccommodation on the previous day: " + acc + "\nPayment: Pending verification" + (utrTail ? " (UTR " + utrTail + ")" : "") + "\n\n" +
    "Your team:\n" + roster.map(function (x, i) { return (i + 1) + ". " + x; }).join("\n") + "\n\n" +
    "What happens next:\n- Our organizing team will verify your payment. We will email you once it is done.\n" +
    "- Keep your Registration ID handy and quote it in any message to us.\n" +
    (waOk ? "- Join the official WhatsApp channel for updates: " + WHATSAPP_LINK + "\n" : "") +
    "\n" + EVENT_WHEN_WHERE + ". Get your ideas ready!\n\nWarm regards,\nTeam " + EVENT_NAME;

  var rosterHtml = roster.map(function (x) { return '<li style="margin:4px 0">' + h_(x) + '</li>'; }).join("");
  function row(label, value) { return '<tr><td style="padding:8px 0;color:#9aa0c3;font-size:13px;width:42%">' + label + '</td><td style="padding:8px 0;color:#ffffff;font-weight:bold;font-size:15px">' + value + '</td></tr>'; }

  var html =
    '<div style="background:#0e0618;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">' +
    '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#1a0b2e;border:1px solid #3a1d63;border-radius:14px">' +
    '<tr><td style="padding:28px 24px 8px;text-align:center">' +
      '<div style="color:#ff2e97;font-size:12px;letter-spacing:3px">REGISTRATION RECEIVED</div>' +
      '<div style="color:#22e6ff;font-size:30px;font-weight:bold;margin-top:8px">' + h_(EVENT_NAME) + '</div></td></tr>' +
    '<tr><td style="padding:12px 24px;color:#e8e6f5;font-size:15px;line-height:1.6">' +
      'Hi <b>' + h_(first) + '</b>,<br><br>Welcome to <b>' + h_(EVENT_NAME) + '</b>! We are thrilled to have you and your team on board. ' +
      'Your registration has been received and your spot in the lineup is on its way to being locked in.</td></tr>' +
    '<tr><td style="padding:4px 24px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #3a1d63;border-bottom:1px solid #3a1d63">' +
      row("Registration ID", h_(regId)) + row("Institute", h_(institute)) + row("Domain", h_(domain)) +
      row("Team size", h_(size)) + row("Accommodation (previous day)", h_(acc)) +
      row("Payment", "Pending verification" + (utrTail ? ' <span style="color:#9aa0c3;font-weight:normal;font-size:12px">(UTR ' + h_(utrTail) + ')</span>' : "")) +
    '</table></td></tr>' +
    '<tr><td style="padding:16px 24px 4px;color:#22e6ff;font-size:13px;letter-spacing:2px">YOUR TEAM</td></tr>' +
    '<tr><td style="padding:0 24px 8px"><ol style="margin:6px 0 0 18px;padding:0;color:#e8e6f5;font-size:15px">' + rosterHtml + '</ol></td></tr>' +
    '<tr><td style="padding:12px 24px;color:#e8e6f5;font-size:14px;line-height:1.6"><b style="color:#ff2e97">What happens next</b><br>' +
      '&bull; Our organizing team will verify your payment and let you know.<br>' +
      '&bull; Keep your Registration ID handy and quote it in any message to us.<br>' +
      '&bull; Start shaping your idea. ' + h_(EVENT_WHEN_WHERE) + '!</td></tr>' +
    (waOk ? '<tr><td style="padding:8px 24px 20px;text-align:center"><a href="' + h_(WHATSAPP_LINK) + '" style="display:inline-block;background:#ff2e97;color:#ffffff;text-decoration:none;font-weight:bold;padding:13px 26px;border-radius:10px">Join the WhatsApp channel</a></td></tr>' : '') +
    '<tr><td style="padding:12px 24px 24px;color:#9aa0c3;font-size:12px;text-align:center">Warm regards,<br>Team ' + h_(EVENT_NAME) + (replyTo ? '<br>Questions? Just reply to this email.' : '') + '</td></tr>' +
    '</table></div>';

  var opts = { to: to, subject: subject, body: text, htmlBody: html, name: EVENT_NAME + " Organizing Team" };
  if (replyTo) opts.replyTo = replyTo;
  MailApp.sendEmail(opts);
  return true;
}

// Run from the editor (or the Sheet menu) to retry any row whose email is not marked SENT.
function resendFailedEmails() {
  var sheet = getSheet_(), rows = readRows_(sheet), sent = 0;
  rows.forEach(function (row) {
    var st = String(row.v[COL["Confirmation Email"]] || "");
    if (st.indexOf("SENT") === 0) return;
    trySendConfirmation_(sheet, row.rowNumber, row.v);
    sent++;
  });
  console.log("Resend attempted for " + sent + " row(s).");
}

// Run ONCE from the editor: sends a sample email to YOU and triggers the email permission prompt.
function testConfirmationEmail() {
  var me = Session.getEffectiveUser().getEmail(), r = new Array(HEADERS.length).fill("");
  r[COL["Team Leader Email"]] = me; r[COL["Registration ID"]] = ID_PREFIX + "0000"; r[COL["Team Leader Name"]] = "Test Leader";
  r[COL["Institute Name"]] = "Sample Institute"; r[COL["Domain"]] = DOMAINS[0]; r[COL["Total Team Size"]] = 3;
  r[COL["Accommodation Required Previous Day"]] = "Yes"; r[COL["UTR Number"]] = "412345678901";
  r[COL["Member 1 Name"]] = "Sample Member One"; r[COL["Member 2 Name"]] = "Sample Member Two";
  sendConfirmationEmail_(r);
  console.log("Test email sent to " + me);
}

// Adds a "HackFusion" menu in the Sheet (works because this script is bound to the Sheet).
function onOpen() {
  try { SpreadsheetApp.getUi().createMenu("HackFusion").addItem("Resend failed confirmation emails", "resendFailedEmails").addToUi(); } catch (e) {}
}

/* ================= ONE-TIME SETUP (run manually from the editor) ================= */

function setupSheet() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold").setBackground("#14061f").setFontColor("#ffffff");
  sh.setFrozenRows(1);
  sh.getRange(2, 1, sh.getMaxRows() - 1, HEADERS.length).setNumberFormats(
    Array.apply(null, Array(sh.getMaxRows() - 1)).map(function () { return HEADERS.map(function (h) { return NUMERIC_COLS.indexOf(h) >= 0 ? "0" : "@"; }); }));

  function colRange(name) { return sh.getRange(2, COL[name] + 1, sh.getMaxRows() - 1, 1); }
  colRange("Payment Status").setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(PAYMENT_STATUSES, true).setAllowInvalid(false).build());
  colRange("Registration Status").setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(REGISTRATION_STATUSES, true).setAllowInvalid(false).build());

  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$' + colLetter_("Duplicate Flag") + '2<>""').setBackground("#ffd9b3").setRanges([sh.getRange(2, 1, sh.getMaxRows() - 1, HEADERS.length)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("VERIFIED").setBackground("#c8f2dc").setRanges([colRange("Payment Status")]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo("REJECTED").setBackground("#f6c6c6").setRanges([colRange("Payment Status")]).build()
  ]);

  // Only the three organizer columns stay editable for other editors; everything else is owner-only.
  try {
    var prot = sh.protect().setDescription("Organizers may edit only Payment Status, Registration Status, Admin Notes");
    prot.setUnprotectedRanges([colRange("Payment Status"), colRange("Registration Status"), colRange("Admin Notes")]);
    var me = Session.getEffectiveUser();
    prot.addEditor(me);
    prot.removeEditors(prot.getEditors().filter(function (u) { return u.getEmail() !== me.getEmail(); }));
    if (prot.canDomainEdit()) prot.setDomainEdit(false);
  } catch (e) { console.warn("Could not apply sheet protection: " + e.message); }
  console.log("Sheet ready.");
}
function colLetter_(name) { var n = COL[name] + 1, s = ""; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }


