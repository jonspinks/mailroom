const accounts = {
  timberworks: {
    name: "Timberworks",
    email: "jon@timberworks.example",
    cls: "work",
    yourName: "Jon",
    emails: [
      { id: "mail-timberworks", address: "jon@timberworks.example" }
    ],
    calendars: [
      { id: "cal-timberworks", name: "Calendar", cls: "work" },
      { id: "cal-timberworks-site", name: "Site", cls: "plum" }
    ],
    profile: "work"
  },
  personal: {
    name: "Personal",
    email: "jon@personal.example",
    cls: "personal",
    yourName: "Jon",
    emails: [
      { id: "mail-personal", address: "jon@personal.example" }
    ],
    calendars: [
      { id: "cal-personal", name: "Calendar", cls: "personal" },
      { id: "cal-personal-family", name: "Family", cls: "amber" }
    ],
    profile: "personal"
  }
};

let defaultEmailId = "mail-timberworks";
let defaultCalendarId = "cal-timberworks";

function allEmails() {
  const rows = [];
  Object.entries(accounts).forEach(([accountId, acct]) => {
    (acct.emails || []).forEach(item => rows.push({ accountId, acct, id: item.id, address: item.address }));
  });
  return rows;
}

function allCalendars() {
  const rows = [];
  Object.entries(accounts).forEach(([accountId, acct]) => {
    (acct.calendars || []).forEach(cal => {
      if (cal.canEdit === false && cal.id !== defaultCalendarId) return;
      rows.push({ accountId, acct, id: cal.id, name: cal.name, cls: cal.cls });
    });
  });
  return rows;
}

function activeDefaultEmail() {
  const rows = allEmails();
  return rows.find(item => item.id === defaultEmailId) || rows[0] || null;
}

function activeDefaultCalendar() {
  const rows = allCalendars();
  return rows.find(item => item.id === defaultCalendarId) || rows[0] || null;
}

function settleDefaults() {
  const email = activeDefaultEmail();
  defaultEmailId = email ? email.id : "";
  const cal = activeDefaultCalendar();
  defaultCalendarId = cal ? cal.id : "";
  Object.values(accounts).forEach(syncAccountEmail);
}

function readSavedDefaults() {
  if (!inDesktop()) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem("mailroom-defaults") || "null");
    if (!parsed || typeof parsed !== "object") return null;
    return {
      email: String(parsed.email || ""),
      calendar: String(parsed.calendar || "")
    };
  } catch (e) {
    return null;
  }
}

function rememberDefaults() {
  if (!inDesktop()) return;
  localStorage.setItem("mailroom-defaults", JSON.stringify({
    email: defaultEmailId || "",
    calendar: defaultCalendarId || ""
  }));
}

function adoptSavedDefaults() {
  if (!inDesktop()) return;
  const saved = readSavedDefaults();
  defaultEmailId = saved && saved.email ? saved.email : "";
  defaultCalendarId = saved && saved.calendar ? saved.calendar : "";
  settleDefaults();
}

function accountEmail(acctOrId) {
  const acct = typeof acctOrId === "string" ? accounts[acctOrId] : acctOrId;
  if (!acct) return "";
  const chosen = activeDefaultEmail();
  if (chosen && accounts[chosen.accountId] === acct) return chosen.address;
  const list = acct.emails || [];
  return (list[0] && list[0].address) || acct.email || "";
}

function syncAccountEmail(acct) {
  if (acct) acct.email = accountEmail(acct);
}

Object.values(accounts).forEach(syncAccountEmail);

function emailInUse(address, exceptAccountId) {
  const needle = String(address || "").trim().toLowerCase();
  return Object.entries(accounts).some(([id, acct]) => id !== exceptAccountId && (
    (acct.emails || []).some(item => item.address.toLowerCase() === needle)
    || (acct.email || "").toLowerCase() === needle
  ));
}

// A calendar someone shared with you can be read-only.
function calendarReadOnly(calId) {
  const cal = findCalendar(calId);
  return !!(cal && cal.canEdit === false);
}

function findCalendar(calId) {
  for (const acct of Object.values(accounts)) {
    const cal = (acct.calendars || []).find(item => item.id === calId);
    if (cal) return cal;
  }
  return null;
}

function accountForCalendar(calId) {
  return Object.entries(accounts).find(([, acct]) => (acct.calendars || []).some(cal => cal.id === calId)) || null;
}

function firstCalendar(acct) {
  const list = (acct && acct.calendars) || [];
  return list[0] || null;
}

function eventCalendar(ev) {
  return findCalendar(ev.calendar) || firstCalendar(accounts[ev.account]);
}

function eventCls(ev) {
  const cal = eventCalendar(ev);
  if (cal) return cal.cls;
  return (accounts[ev.account] && accounts[ev.account].cls) || "work";
}

function showAsOf(ev) {
  const value = ev && ev.showAs;
  return value === "free" || value === "oof" ? value : "busy";
}

function showAsLabel(value) {
  if (value === "free") return "Free";
  if (value === "oof") return "Out of office";
  return "Busy";
}

function showAsTag(ev) {
  const show = showAsOf(ev);
  if (show === "oof") return "OOO · ";
  if (show === "free") return "Free · ";
  return "";
}

function eventFace(ev) {
  const show = showAsOf(ev);
  return eventCls(ev) + (ev.tentative ? " tentative" : "") + (show === "busy" ? "" : " " + show);
}

function calendarShown(ev) {
  if (ev && ev.account && !calendarAccountVisible(ev.account)) return false;
  const cal = eventCalendar(ev);
  return cal ? !hiddenCal.has(cal.id) : true;
}

function calendarPillName(acct, cal) {
  if (!cal) return acct ? acct.name : "";
  if (cal.name === "Calendar") return acct.name;
  const same = Object.values(accounts).some(other => other !== acct && (other.calendars || []).some(item => item.name === cal.name));
  return same ? acct.name + " · " + cal.name : cal.name;
}

function calendarSelectOptions(selectedId) {
  const rows = calendarEntries();
  const listed = rows.some(([, acct]) => (acct.calendars || []).some(cal => cal.id === selectedId));
  const source = listed || !selectedId ? rows : Object.entries(accounts);
  return source.map(([, acct]) => (acct.calendars || []).filter(cal => cal.canEdit !== false || cal.id === selectedId).map(cal => {
    const label = acct.calendars.length > 1 ? acct.name + " · " + cal.name : acct.name;
    return `<option value="${esc(cal.id)}"${cal.id === selectedId ? " selected" : ""}>${esc(label)}</option>`;
  }).join("")).join("");
}

function preferredCalendarId() {
  const cal = activeDefaultCalendar();
  const owner = cal && accountForCalendar(cal.id);
  if (cal && owner && calendarAccountVisible(owner[0])) return cal.id;
  const rows = calendarRows().filter(item => item.canEdit !== false);
  return (rows[0] && rows[0].id) || "";
}

// The primary address keeps the account id as its value. An alias is
// account id, a tab, then the address, so older code that stored an account
// id still selects the mailbox.
function fromAccountId(value) {
  const raw = String(value || "");
  const cut = raw.indexOf("\t");
  const id = cut < 0 ? raw : raw.slice(0, cut);
  return accounts[id] ? id : "";
}

function fromAddress(value) {
  const raw = String(value || "");
  const cut = raw.indexOf("\t");
  return cut < 0 ? "" : raw.slice(cut + 1).trim();
}

function fromKey(accountId, address) {
  const acct = accounts[accountId];
  const primary = String(accountEmail(acct) || "").trim().toLowerCase();
  const addr = String(address || "").trim();
  if (!acct || !addr || addr.toLowerCase() === primary) return accountId;
  return accountId + "\t" + addr;
}

function sendFromAddress(value) {
  const id = fromAccountId(value);
  const addr = fromAddress(value);
  if (!id || !addr) return "";
  const primary = String(accountEmail(accounts[id]) || "").trim().toLowerCase();
  return addr.toLowerCase() === primary ? "" : addr;
}

function aliasList(acct) {
  const primary = String(accountEmail(acct) || "").trim().toLowerCase();
  const seen = new Set();
  const out = [];
  (Array.isArray(acct && acct.aliases) ? acct.aliases : []).forEach(item => {
    const addr = String(item || "").trim();
    const key = addr.toLowerCase();
    if (!addr || key === primary || seen.has(key) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return;
    seen.add(key);
    out.push(addr);
  });
  return out;
}

function microsoftPersonal(acct) {
  if (!acct || acct.provider === "google") return false;
  if (acct.profile === "personal") return true;
  return /@(outlook|hotmail|live|msn)\./i.test(String(acct.email || ""));
}

function wantsTypedFrom(acct) {
  return !!(inDesktop() && acct && acct.signedIn && microsoftPersonal(acct) && !aliasList(acct).length);
}

function fromOptions(fromId) {
  const wantedId = fromAccountId(fromId) || (accounts[fromId] ? fromId : "");
  const wantedAddr = fromAddress(fromId).toLowerCase();
  const rows = profileEntries();
  const list = rows.some(([id]) => id === wantedId) || !accounts[wantedId] ? rows : [[wantedId, accounts[wantedId]]].concat(rows);
  return list.map(([id, acct]) => {
    const aliases = aliasList(acct);
    const primaryOn = id === wantedId && !wantedAddr;
    let html = `<option value="${esc(id)}"${primaryOn ? " selected" : ""}>${esc(acct.name)} · ${esc(accountEmail(acct))}</option>`;
    aliases.forEach(addr => {
      const on = id === wantedId && addr.toLowerCase() === wantedAddr;
      html += `<option value="${esc(id + "\t" + addr)}"${on ? " selected" : ""}>${esc(acct.name)} · ${esc(addr)}</option>`;
    });
    if (wantsTypedFrom(acct)) {
      const typed = id === wantedId && !!wantedAddr && !aliases.some(addr => addr.toLowerCase() === wantedAddr);
      html += `<option value="${esc(id + "\t")}"${typed ? " selected" : ""}>${esc(acct.name)} · Another address…</option>`;
    }
    return html;
  }).join("");
}

function composeFromKey(preferred) {
  const id = fromAccountId(preferred);
  if (id && accountInProfile(id)) return fromAddress(preferred) ? fromKey(id, fromAddress(preferred)) : id;
  return defaultAccountId();
}

// The typed "Another address" lives in its own field. The select value is
// only the account id and a tab until that field is read.
function formFromValue(form) {
  if (!form) return "";
  const select = form.querySelector("#compose-from");
  if (!select) return "";
  const input = form.querySelector("#compose-alias");
  if (input && !input.hidden) return fromAccountId(select.value) + "\t" + input.value.trim();
  return select.value;
}

function defaultAccountId() {
  const chosen = activeDefaultEmail();
  if (chosen && accountInProfile(chosen.accountId)) return chosen.accountId;
  return profileAccountIds()[0] || "";
}

function composeAccountId(preferred) {
  if (preferred && accountInProfile(preferred)) return preferred;
  return defaultAccountId();
}

function toggleCalendar(id) {
  if (hiddenCal.has(id)) hiddenCal.delete(id);
  else hiddenCal.add(id);
  render();
}

// Show more folds a long calendar list. It does not change which calendars
// are drawn: the coloured dot is the only control for that.
let moreCalendarsOpen = false;
try { moreCalendarsOpen = localStorage.getItem("mailroom-more-calendars") === "1"; } catch (e) {}

function calendarIsShared(acct, cal) {
  if (!cal) return false;
  const owner = String(cal.owner || "").trim().toLowerCase();
  if (owner.includes("@")) {
    const mine = [accountEmail(acct)].concat((acct && acct.emails || []).map(item => item.address), acct && acct.aliases || []);
    return !mine.some(item => String(item || "").trim().toLowerCase() === owner);
  }
  return cal.isShared === true;
}

function calendarOwnerLabel(cal) {
  const name = String((cal && (cal.ownerName || cal.owner)) || "").trim();
  return name;
}

function calendarListParts() {
  const own = [];
  const shared = [];
  calendarEntries().forEach(([, acct]) => {
    (acct.calendars || []).forEach(cal => {
      (calendarIsShared(acct, cal) ? shared : own).push({ acct, cal });
    });
  });
  return { own, shared };
}

function foldedCalendarIds() {
  const keep = new Set();
  calendarEntries().forEach(([, acct]) => {
    const first = (acct.calendars || []).find(cal => !calendarIsShared(acct, cal));
    if (first) keep.add(first.id);
  });
  return keep;
}

function calendarListLong() {
  const { own, shared } = calendarListParts();
  const keep = foldedCalendarIds();
  return shared.length > 0 || own.some(row => !keep.has(row.cal.id));
}

function toggleMoreCalendars() {
  moreCalendarsOpen = !moreCalendarsOpen;
  try { localStorage.setItem("mailroom-more-calendars", moreCalendarsOpen ? "1" : "0"); } catch (e) {}
  renderFolders();
}

function defaultCalendarAccountId() {
  const cal = activeDefaultCalendar();
  const owner = cal && accountForCalendar(cal.id);
  if (owner && calendarAccountVisible(owner[0])) return owner[0];
  return (calendarEntries()[0] && calendarEntries()[0][0]) || "";
}

function nextCalendarColor(accountId) {
  const acct = accounts[accountId];
  const used = new Set(((acct && acct.calendars) || []).map(cal => cal.cls));
  const free = calendarPalette.find(([cls]) => !used.has(cls));
  return free ? free[0] : calendarPalette[0][0];
}

const addCalSources = [
  ["blank", "Create blank calendar"],
  ["birthdays", "Birthdays"],
  ["holidays", "Holidays"],
  ["directory", "Add from directory"],
  ["web", "Subscribe from web"],
  ["file", "Upload from file"]
];

const addCalNotes = {
  birthdays: "Birthday calendars come from a Microsoft account. They are not added on this page.",
  holidays: "Holiday calendars come from a Microsoft account. They are not added on this page.",
  directory: "Calendars from a directory stay on the Microsoft account.",
  web: "Subscribing from a web address stays on the Microsoft account.",
  file: "Uploading a calendar file stays on the Microsoft account."
};

let addCalKey = null;

function openAddCalendar() {
  const ids = calendarEntries().map(([id]) => id);
  if (!ids.length) return;
  if (addCalKey) document.removeEventListener("keydown", addCalKey);
  let page = "blank";
  let accountId = defaultCalendarAccountId();
  if (!accounts[accountId]) accountId = ids[0];
  let colourTouched = false;
  let colour = nextCalendarColor(accountId);
  let name = "";
  function closeAddCalendar() {
    if (addCalKey) document.removeEventListener("keydown", addCalKey);
    addCalKey = null;
    closePop();
  }
  addCalKey = (ev) => {
    if (ev.key !== "Escape") return;
    closeAddCalendar();
  };
  popRoot.innerHTML = `
    <div class="backdrop dim" id="backdrop"></div>
    <div class="dialog add-cal-dialog" role="dialog" aria-modal="true" aria-label="Add calendar">
      <div class="add-cal-head">
        <h2>Add calendar</h2>
        <button class="icon-btn" type="button" id="cancel" aria-label="Close" title="Close"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
      </div>
      <div class="add-cal-body">
        <nav class="add-cal-nav" aria-label="Calendar sources">
          ${addCalSources.map(([id, label]) => `<button type="button" data-add-cal-page="${id}" aria-current="false">${esc(label)}</button>`).join("")}
        </nav>
        <div class="add-cal-pane" id="add-cal-pane"></div>
      </div>
    </div>`;
  document.getElementById("backdrop").onclick = closeAddCalendar;
  document.getElementById("cancel").onclick = closeAddCalendar;
  document.addEventListener("keydown", addCalKey);
  function paint() {
    popRoot.querySelectorAll("[data-add-cal-page]").forEach(btn => {
      btn.setAttribute("aria-current", btn.dataset.addCalPage === page ? "true" : "false");
    });
    const pane = document.getElementById("add-cal-pane");
    if (page !== "blank") {
      pane.innerHTML = `<p class="add-cal-note">${esc(addCalNotes[page] || "")}</p>`;
      return;
    }
    const many = ids.length > 1;
    const picked = calendarPalette.some(([cls]) => cls === colour) ? colour : nextCalendarColor(accountId);
    colour = picked;
    pane.innerHTML = `
      <form id="add-cal-form" novalidate>
        <input class="add-cal-title" name="name" value="${esc(name)}" placeholder="Calendar name" aria-label="Calendar name" autocomplete="off">
        <div class="field">Colour
          <div class="swatches" role="radiogroup" aria-label="Colour">
            ${calendarPalette.map(([cls, label]) => `
              <button class="swatch ${cls}" type="button" role="radio" aria-checked="${cls === colour ? "true" : "false"}" aria-label="${label}" data-color="${cls}"></button>
            `).join("")}
          </div>
        </div>
        <label class="field"${many ? "" : " hidden"}>Add to
          <select name="account" aria-label="Add to">${ids.map(id => `<option value="${esc(id)}"${id === accountId ? " selected" : ""}>${esc(accounts[id].name)}</option>`).join("")}</select>
        </label>
        <p class="form-error" id="add-cal-error" hidden></p>
        <div class="dialog-actions">
          <button class="primary" type="submit">Save</button>
        </div>
      </form>`;
    const form = pane.querySelector("#add-cal-form");
    const nameInput = form.querySelector("[name=name]");
    nameInput.addEventListener("input", () => { name = nameInput.value; });
    form.querySelectorAll(".swatch").forEach(btn => {
      btn.onclick = () => {
        colourTouched = true;
        colour = btn.dataset.color;
        form.querySelectorAll(".swatch").forEach(el => el.setAttribute("aria-checked", el === btn ? "true" : "false"));
      };
    });
    const accountSelect = form.querySelector("[name=account]");
    accountSelect.onchange = () => {
      accountId = accountSelect.value;
      if (!colourTouched) {
        colour = nextCalendarColor(accountId);
        form.querySelectorAll(".swatch").forEach(el => el.setAttribute("aria-checked", el.dataset.color === colour ? "true" : "false"));
      }
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const note = document.getElementById("add-cal-error");
      const fail = (text) => { note.hidden = false; note.textContent = text; };
      const trimmed = name.trim();
      const acct = accounts[accountId];
      if (!trimmed) return fail("Enter a calendar name.");
      if (!acct) return fail("Choose an account.");
      const cls = calendarPalette.some(([item]) => item === colour) ? colour : nextCalendarColor(accountId);
      const id = "cal-" + Date.now();
      acct.calendars.push({ id, name: trimmed, cls, colourChosen: true });
      hiddenCal.delete(id);
      closeAddCalendar();
      toast("Calendar added");
      render();
    };
    nameInput.focus();
  }
  popRoot.querySelectorAll("[data-add-cal-page]").forEach(btn => {
    btn.onclick = () => {
      page = btn.dataset.addCalPage;
      paint();
    };
  });
  paint();
}

const accountPalette = [
  ["work", "Blue"],
  ["personal", "Green"],
  ["plum", "Plum"],
  ["amber", "Amber"],
  ["clay", "Clay"]
];

const calendarPalette = accountPalette.concat([
  ["leaf", "Leaf"],
  ["orange", "Orange"],
  ["pink", "Pink"],
  ["red", "Red"],
  ["gold", "Gold"],
  ["navy", "Navy"],
  ["slate", "Slate"],
  ["magenta", "Magenta"]
]);

let signatures = [
  {
    id: "sig-timberworks",
    name: "Timberworks",
    account: "timberworks",
    scope: "new",
    body: "<p><strong>Jon</strong><br>Timberworks<br><a href=\"mailto:jon@timberworks.example\">jon@timberworks.example</a></p>"
  },
  {
    id: "sig-personal",
    name: "Personal",
    account: "personal",
    scope: "all",
    body: "<p>Jon<br><a href=\"mailto:jon@personal.example\">jon@personal.example</a></p>"
  }
];
let settingsPage = "accounts";
let settingsSigId = "";
let settingsAccountId = "";

function appliedSignature(accountId, kind) {
  const setting = signatures.find(item => item.account === accountId && String(item.body || "").trim() && (item.scope === "all" || kind === "new"));
  return setting ? signatureSource(setting.body) : "";
}

function scopeLabel(scope) {
  return scope === "all" ? "All emails" : "New messages only";
}

function ensureWriteArea(body) {
  if (body.querySelector(".body-write")) return;
  const write = document.createElement("div");
  write.className = "body-write";
  const nodes = [...body.childNodes];
  body.prepend(write);
  nodes.forEach(node => {
    if (node.nodeType === 1 && node.dataset && node.dataset.sig) return;
    write.appendChild(node);
  });
  if (!write.childNodes.length) write.innerHTML = "<p><br></p>";
}

function paintComposeSignature(form, replace) {
  const body = form.querySelector("#compose-body");
  if (!body) return;
  ensureWriteArea(body);
  const html = appliedSignature(fromAccountId(form.querySelector("#compose-from").value), form.dataset.kind);
  let sig = body.querySelector("[data-sig]");
  if (!html) {
    if (sig) sig.remove();
    return;
  }
  if (!sig) {
    sig = document.createElement("div");
    sig.className = "body-sig";
    sig.dataset.sig = "1";
    // Typing inside the signature would vanish: it is drawn separately and
    // replaced from its saved copy when the message is sent.
    sig.contentEditable = "false";
    body.appendChild(sig);
    mountSignature(sig, html);
    return;
  }
  if (replace) mountSignature(sig, html);
}

function signatureSource(raw) {
  // A received message can carry its own data-sig-src, so this is as
  // untrusted as any mail body.
  return sanitizeMailHtml(raw, true);
}

const colourSamples = new Map();
function colourSample(value) {
  const raw = String(value || "").trim();
  if (!raw || /^(transparent|none|inherit|initial|unset|currentcolor)$/i.test(raw)) return null;
  if (colourSamples.has(raw)) return colourSamples.get(raw);
  const found = sampleColour(raw);
  if (colourSamples.size > 500) colourSamples.clear();
  colourSamples.set(raw, found);
  return found;
}

function sampleColour(raw) {
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;left:-9999px;top:0";
  probe.style.backgroundColor = raw;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const match = computed.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/);
  if (!match) return null;
  return { r: +match[1], g: +match[2], b: +match[3], a: match[4] == null ? 1 : +match[4] };
}

function isPaperColour(value) {
  const sample = colourSample(value);
  if (!sample || sample.a < 0.35) return false;
  const max = Math.max(sample.r, sample.g, sample.b);
  const min = Math.min(sample.r, sample.g, sample.b);
  const light = (max + min) / 510;
  const sat = max === min ? 0 : (max - min) / max;
  return light >= 0.86 && sat <= 0.22;
}

function isDarkInk(value) {
  const sample = colourSample(value);
  if (!sample || sample.a < 0.35) return false;
  const max = Math.max(sample.r, sample.g, sample.b);
  const min = Math.min(sample.r, sample.g, sample.b);
  return (max + min) / 510 < 0.62;
}

function hasVisibleBorder(style) {
  return ["Top", "Right", "Bottom", "Left"].some(side => {
    const width = parseFloat(style["border" + side + "Width"]);
    const kind = style["border" + side + "Style"];
    return width > 0 && kind && kind !== "none" && kind !== "hidden";
  });
}

function msoBorderToCss(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const match = text.match(/^(solid|dashed|dotted|double|inset|outset)\s+(\S+)\s+([\d.]+)\s*(px|pt)$/i);
  if (!match) return "";
  return match[3] + match[4] + " " + match[1].toLowerCase() + " " + match[2];
}

function visibleBorderValue(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text || text === "none" || text === "hidden" || text === "0" || text === "0px" || text === "0pt") return false;
  return !/^(0(px|pt)?\s+)?(none|hidden)\b/.test(text);
}

function promoteMsoBorders(raw) {
  const order = [];
  const map = new Map();
  String(raw || "").split(";").forEach(part => {
    const index = part.indexOf(":");
    if (index < 0) return;
    const key = part.slice(0, index).trim().toLowerCase();
    const val = part.slice(index + 1).trim();
    if (!key || !val) return;
    if (!map.has(key)) order.push(key);
    map.set(key, val);
  });
  let changed = false;
  const setBorder = (key, css) => {
    if (!css || visibleBorderValue(map.get(key))) return;
    map.set(key, css);
    if (!order.includes(key)) order.push(key);
    changed = true;
  };
  setBorder("border", msoBorderToCss(map.get("mso-border-alt")));
  ["top", "right", "bottom", "left"].forEach(side => {
    setBorder("border-" + side, msoBorderToCss(map.get("mso-border-" + side + "-alt")));
  });
  if (!changed) return raw;
  return order.map(key => key + ":" + map.get(key)).join(";");
}

function buttonLike(node) {
  const tag = node.tagName || "";
  if (!/^(A|SPAN|TD|P|DIV)$/.test(tag)) return false;
  const text = (node.textContent || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > 48) return false;
  if (tag !== "A" && tag !== "SPAN" && [...node.querySelectorAll("a,span")].some(el => (el.textContent || "").replace(/\s+/g, " ").trim() === text)) return false;
  const style = node.style;
  const pad = ["Top", "Right", "Bottom", "Left"].some(side => parseFloat(style["padding" + side]) >= 4);
  const radius = parseFloat(style.borderRadius) > 0;
  const block = style.display === "inline-block" || style.display === "block";
  return radius || (pad && (block || tag === "A" || tag === "TD"));
}

function ensureFillBorder(node) {
  if (!buttonLike(node)) return;
  const attr = node.getAttribute("bgcolor") || "";
  if (attr && !node.style.backgroundColor && !isPaperColour(attr)) node.style.backgroundColor = attr;
  const bg = node.style.backgroundColor;
  if (!bg || isPaperColour(bg)) return;
  if (hasVisibleBorder(node.style)) return;
  node.style.border = "1px solid " + bg;
}

function vmlAttr(text, name) {
  const match = String(text || "").match(new RegExp(name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
  return match ? (match[1] || match[2] || match[3] || "") : "";
}

function liftVmlButtons(doc) {
  const comments = [];
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach(comment => {
    const text = comment.nodeValue || "";
    if (!/<\s*v:(?:round)?rect\b/i.test(text)) return;
    const center = text.match(/<center[^>]*>([\s\S]*?)<\/center>/i);
    const label = (center ? center[1] : text).replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
    if (!label || label.length > 48) return;
    const exists = [...doc.body.querySelectorAll("a,span,td,p,div")].some(el => (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === label.toLowerCase());
    if (exists) return;
    const fill = vmlAttr(text, "fillcolor");
    const stroke = vmlAttr(text, "strokecolor");
    const href = vmlAttr(text, "href").trim();
    const link = href && !/^\s*javascript:/i.test(href);
    const el = doc.createElement(link ? "a" : "span");
    if (link) el.setAttribute("href", href);
    el.textContent = label;
    const bg = fill && !/^none$/i.test(fill) && !isPaperColour(fill) ? fill : "";
    const edge = stroke && !/^none$/i.test(stroke) ? stroke : (bg || "#8a8886");
    const bits = ["display:inline-block", "padding:8px 16px", "text-decoration:none", "border-radius:4px", "border:1px solid " + edge];
    if (bg) bits.push("background-color:" + bg, "color:#ffffff");
    el.setAttribute("style", bits.join(";"));
    const parent = comment.parentNode;
    if (parent && parent.nodeType === 1) parent.insertBefore(el, comment);
    else doc.body.appendChild(el);
  });
}

function restoreSignatureBoxes(doc) {
  if (!doc || !doc.body) return;
  liftVmlButtons(doc);
  doc.body.querySelectorAll("[style]").forEach(node => {
    const raw = node.getAttribute("style") || "";
    const next = promoteMsoBorders(raw);
    if (next !== raw) node.setAttribute("style", next);
  });
  doc.body.querySelectorAll("*").forEach(ensureFillBorder);
}

function signatureFromClipboard(raw) {
  const full = String(raw || "");
  const styles = full.match(/<style[\s\S]*?<\/style>/gi) || [];
  let body = htmlFragment(full);
  styles.forEach(tag => {
    if (!body.includes(tag)) body = tag + body;
  });
  const doc = new DOMParser().parseFromString(signatureSource(body), "text/html");
  restoreSignatureBoxes(doc);
  const styleHtml = [...doc.querySelectorAll("style")].map(node => {
    const html = node.outerHTML;
    node.remove();
    return html;
  }).join("");
  return styleHtml + doc.body.innerHTML;
}

function signatureDark() {
  const theme = document.documentElement.dataset.theme || "dark";
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function signatureCss(css, dark) {
  if (typeof CSSStyleSheet !== "function" || typeof CSSRule === "undefined") return "";
  const safe = String(css || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!--|-->/g, "")
    .replace(/@import[^;]+;/gi, "");
  let sheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(safe);
  } catch (e) {
    return "";
  }
  const write = rules => [...rules].map(rule => {
    if (rule.type === CSSRule.STYLE_RULE) {
      if (dark) {
        const style = rule.style;
        const bg = style.getPropertyValue("background-color");
        const shorthand = style.getPropertyValue("background");
        if ((bg && isPaperColour(bg)) || (shorthand && isPaperColour(shorthand))) {
          style.removeProperty("background");
          style.removeProperty("background-color");
          style.removeProperty("background-image");
        }
        const kept = style.getPropertyValue("background-color") && !isPaperColour(style.getPropertyValue("background-color"));
        const ink = style.getPropertyValue("color");
        if (ink && isDarkInk(ink) && !kept && !hasVisibleBorder(style)) style.removeProperty("color");
        if (!style.length) return "";
      }
      [...rule.style].forEach(prop => {
        const value = rule.style.getPropertyValue(prop);
        if (/url\(/i.test(value) && stripRemoteStyle(prop + ":" + value).blocked) rule.style.removeProperty(prop);
      });
      if (!rule.style.length) return "";
      const sel = String(rule.selectorText || "").trim();
      if (!sel || /[{}]/.test(sel)) return "";
      return sel + "{" + rule.style.cssText + "}";
    }
    if (rule.type === CSSRule.MEDIA_RULE) return "@media " + rule.conditionText + "{" + write(rule.cssRules) + "}";
    if (rule.type === CSSRule.SUPPORTS_RULE) return "@supports " + rule.conditionText + "{" + write(rule.cssRules) + "}";
    if (rule.type === CSSRule.FONT_FACE_RULE) return rule.cssText;
    return "";
  }).join("");
  return write(sheet.cssRules);
}

// Style blocks removed on the parsed tree, never by pattern: a regex over
// markup can cut a comment open and bring what it hid back to life.
function signatureSendable(raw) {
  const doc = new DOMParser().parseFromString(signatureSource(raw), "text/html");
  doc.querySelectorAll("style").forEach(node => node.remove());
  return doc.body ? doc.body.innerHTML : "";
}

function paintMountedSignature(el) {
  const raw = el._mailSig || "";
  const dark = signatureDark();
  if (!String(raw).trim()) {
    delete el.dataset.sigSrc;
    el.innerHTML = "";
    el.classList.add("empty");
    const root = el.shadowRoot || el.attachShadow({ mode: "open" });
    root.innerHTML = "<style>:host{color:inherit}</style>Nothing to preview";
    return;
  }
  el.classList.remove("empty");
  el.dataset.sigSrc = encodeURIComponent(raw);
  el.innerHTML = signatureSendable(raw);
  const root = el.shadowRoot || el.attachShadow({ mode: "open" });
  const doc = new DOMParser().parseFromString(signatureSource(raw), "text/html");
  restoreSignatureBoxes(doc);
  const css = [...doc.querySelectorAll("style")].map(node => node.textContent || "").join("\n");
  doc.querySelectorAll("script, style, iframe, object, embed, link, meta, base").forEach(node => node.remove());
  doc.querySelectorAll("*").forEach(node => {
    [...node.attributes].forEach(attr => {
      if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      if ((attr.name === "href" || attr.name === "src") && /^\s*javascript:/i.test(attr.value)) node.removeAttribute(attr.name);
    });
  });
  if (dark) adaptSignatureForDark(doc);
  const scoped = signatureCss(css, dark);
  // "<" as a CSS escape: one pass of removing "</style" can leave another.
  const block = scoped ? "<style>" + scoped.replace(/</g, "\\3c ") + "</style>" : "";
  const frame = "<style>:host{display:block;max-width:100%}table{max-width:100%}img{max-width:100%;height:auto}</style>";
  const ink = dark ? "<style>:host{color:#fff}a{color:#9cccf5}</style>" : "";
  root.innerHTML = frame + block + doc.body.innerHTML + ink;
}

function adaptSignatureForDark(doc) {
  const walk = (node, onFill) => {
    if (!node || node.nodeType !== 1) return;
    const style = node.style;
    const bgAttr = node.getAttribute("bgcolor") || "";
    const fill = style.backgroundColor || bgAttr;
    const paper = fill && isPaperColour(fill);
    const solid = fill && !paper && colourSample(fill) && colourSample(fill).a >= 0.35;
    if (paper) {
      style.removeProperty("background");
      style.removeProperty("background-color");
      style.removeProperty("background-image");
    }
    if (bgAttr && isPaperColour(bgAttr)) node.removeAttribute("bgcolor");
    if (node.hasAttribute("background")) node.removeAttribute("background");
    const keepInk = onFill || !!solid || hasVisibleBorder(style);
    if (!keepInk && style.color && isDarkInk(style.color)) style.removeProperty("color");
    if (!String(node.getAttribute("style") || "").trim()) node.removeAttribute("style");
    [...node.children].forEach(child => walk(child, onFill || !!solid));
  };
  if (doc.body) walk(doc.body, false);
}

function mountSignature(el, raw) {
  el._mailSig = String(raw || "");
  paintMountedSignature(el);
}

function storedSignatureSource(el) {
  const encoded = el.getAttribute("data-sig-src") || "";
  if (!encoded) return el._mailSig || "";
  try { return decodeURIComponent(encoded); } catch (e) { return el._mailSig || ""; }
}

function mountReadSignatures(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll(".body-sig[data-sig-src]").forEach(el => {
    if (el.closest("#compose-body")) return;
    // Only your own unsent mail carries a signature to draw. In received
    // mail the attribute is the sender's, and drawing it would load their
    // pictures past the remote-content block.
    const card = el.closest("[data-pick]");
    const owner = card && messages.find(m => m.id === card.dataset.pick);
    if (!owner || !(owner.draft || owner.pendingSend || messageBox(owner) === "drafts" || messageBox(owner) === "outbox")) return;
    const raw = storedSignatureSource(el);
    if (!raw || (el.shadowRoot && el._mailSig === raw)) return;
    mountSignature(el, raw);
  });
}

function inSignature(node) {
  return !!(node && node.closest && node.closest(".body-sig"));
}

// A signature drawn live (compose, or a received data-sig-src) styles itself
// in a shadow root. One that arrived as plain mail HTML, like your own in
// Sent Items, takes the message's stylesheet like the rest of the mail.
function inMountedSignature(node) {
  const sig = node && node.closest && node.closest(".body-sig");
  return !!(sig && (sig.shadowRoot || sig._mailSig != null));
}

function refreshSignatures() {
  document.querySelectorAll(".sig-live, .body-sig").forEach(el => {
    if (el._mailSig != null) paintMountedSignature(el);
  });
  // A theme change turns designed mail over, or back (turnMailOver).
  const reading = document.getElementById("reading");
  if (reading && typeof fitWideMail === "function") fitWideMail(reading);
}

const messages = [
  {
    id: "pipe-old",
    thread: "pipeline",
    seq: 10,
    account: "timberworks",
    from: "Maya Chen",
    email: "maya.chen@timberworks.example",
    initials: "MC",
    color: "#0f6cbd",
    subject: "Pipeline review on Thursday",
    preview: "Thursday is in the diary for 11:00, unless the kiln delivery makes that tight.",
    time: "Monday",
    unread: false,
    body: "Thursday's pipeline review is in the diary for 11:00. Shout if the kiln delivery makes that tight."
  },
  {
    id: "meet",
    thread: "pipeline",
    seq: 90,
    account: "timberworks",
    from: "Maya Chen",
    email: "maya.chen@timberworks.example",
    initials: "MC",
    color: "#0f6cbd",
    subject: "Pipeline review moved to 10:00",
    preview: "Can you still make Thursday if we pull it forward an hour?",
    time: "08:14",
    unread: true,
    cc: ["owen.price@timberworks.example", "leah.okonkwo@timberworks.example"],
    meeting: { title: "Pipeline review", when: "Thursday 15 October, 10:00–11:00", where: "Studio · Teams" },
    body: "I had a clash with the kiln install, so I moved pipeline review to 10:00. Agenda is the same: open quotes, then the two jobs that slipped."
  },
  {
    id: "receipt",
    thread: "receipt",
    seq: 80,
    account: "personal",
    from: "Northline Rail",
    email: "tickets@northline.example",
    initials: "NR",
    color: "#0e7c66",
    subject: "Tickets for Saturday",
    preview: "Your booking reference is NL-20418. Departs 09:12.",
    time: "07:41",
    unread: true,
    body: "Two adult returns, London to York, Saturday 17 October. Tickets are attached. The 09:12 is the quieter train."
  },
  {
    id: "kiln-ask",
    thread: "kiln",
    seq: 20,
    account: "timberworks",
    from: "Owen Price",
    email: "owen.price@timberworks.example",
    initials: "OP",
    color: "#3a5f8a",
    cc: ["leah.okonkwo@timberworks.example"],
    subject: "kiln schedule",
    preview: "Can Wednesday morning still work for delivery?",
    time: "Monday",
    unread: false,
    body: "The yard can bring the kiln Wednesday morning. I need to know the road is open before I book them."
  },
  {
    id: "kiln-road",
    thread: "kiln",
    seq: 30,
    account: "timberworks",
    from: "Leah Okonkwo",
    email: "leah.okonkwo@timberworks.example",
    initials: "LO",
    color: "#5b3d8a",
    cc: ["owen.price@timberworks.example"],
    subject: "Re: kiln schedule",
    preview: "The lane is clear from 7 if they use the side gate.",
    time: "Monday",
    unread: false,
    body: "The lane is clear from 7 if they use the side gate. I'll be on site to meet them."
  },
  {
    id: "kiln",
    thread: "kiln",
    seq: 70,
    account: "timberworks",
    from: "Owen Price",
    email: "owen.price@timberworks.example",
    initials: "OP",
    color: "#3a5f8a",
    cc: ["leah.okonkwo@timberworks.example"],
    subject: "Re: kiln schedule",
    preview: "Site can take delivery Wednesday morning if the road is clear.",
    time: "Yesterday",
    unread: false,
    body: "Site can take delivery Wednesday morning if the road is clear. I'll confirm with the yard before lunch and send the booking reference."
  },
  {
    id: "dentist",
    thread: "dentist",
    seq: 40,
    account: "personal",
    from: "Harbour Dental",
    email: "appointments@harbourdental.example",
    initials: "HD",
    color: "#0b5c4c",
    subject: "Appointment confirmed",
    preview: "Tuesday 13 October at 11:00. Reply if you need to move it.",
    time: "Monday",
    unread: false,
    flagged: true,
    body: "This confirms your checkup on Tuesday 13 October at 11:00. Arrive a few minutes early if your details have changed.",
    bodyHtml: "<p>This confirms your checkup on Tuesday 13 October at 11:00. Arrive a few minutes early if your details have changed.</p><p><img src=\"https://images.example.test/harbour.png\" alt=\"Harbour Dental\"></p>"
  },
  {
    id: "notes",
    thread: "notes",
    seq: 50,
    account: "timberworks",
    from: "Leah Okonkwo",
    email: "leah.okonkwo@timberworks.example",
    initials: "LO",
    color: "#5b3d8a",
    cc: ["sam.adeyemi@timberworks.example"],
    subject: "Notes from design review",
    preview: "Three decisions, and one question still open on the glaze.",
    time: "Monday",
    unread: false,
    body: "We settled the handle, the foot ring, and the box stamp. The glaze question is whether the second firing stays at cone 6 or we test a run at cone 7."
  },
  {
    id: "notes-sam",
    thread: "notes",
    seq: 60,
    account: "timberworks",
    from: "Sam Adeyemi",
    email: "sam.adeyemi@timberworks.example",
    initials: "SA",
    color: "#1a4f7a",
    cc: ["leah.okonkwo@timberworks.example"],
    subject: "Re: Notes from design review",
    preview: "Keep the first batch at cone 6. We can test cone 7 on the offcuts.",
    time: "Monday",
    unread: false,
    body: "Keep the first batch at cone 6. We can test cone 7 on the offcuts without holding the order."
  },
  {
    id: "quote",
    thread: "quote",
    seq: 5,
    box: "archive",
    account: "timberworks",
    from: "Sam Adeyemi",
    email: "sam.adeyemi@timberworks.example",
    initials: "SA",
    color: "#1a4f7a",
    subject: "Showroom quote",
    preview: "The revised quote is filed. Nothing else needed from you.",
    time: "Last week",
    unread: false,
    body: "The revised quote is filed. Nothing else needed from you on the showroom install."
  },
  {
    id: "sent-kiln",
    thread: "sent-kiln",
    seq: 75,
    box: "sent",
    account: "timberworks",
    from: "Jon",
    email: "jon@timberworks.example",
    initials: "J",
    color: "#394146",
    subject: "Re: kiln schedule",
    preview: "Book Wednesday morning. I'll meet the lorry at the side gate.",
    time: "Yesterday",
    unread: false,
    to: "owen.price@timberworks.example",
    toName: "Owen Price",
    cc: ["leah.okonkwo@timberworks.example"],
    body: "Book Wednesday morning. I'll meet the lorry at the side gate."
  },
  {
    id: "reminder",
    thread: "reminder",
    seq: 15,
    box: "trash",
    previousBox: "inbox",
    account: "personal",
    from: "Harbour Dental",
    email: "appointments@harbourdental.example",
    initials: "HD",
    color: "#0b5c4c",
    subject: "Checkup reminder",
    preview: "This is an extra reminder for Tuesday.",
    time: "Monday",
    unread: false,
    body: "This is an extra reminder for Tuesday. You already have the confirmation."
  },
  {
    id: "clay-ask",
    thread: "clay",
    seq: 55,
    account: "timberworks",
    from: "Kit Romero",
    email: "kit.romero@clayworks.example",
    initials: "KR",
    color: "#8a5a00",
    subject: "Stoneware clay",
    preview: "I can send a sample box of the new stoneware on Friday.",
    time: "Monday",
    unread: false,
    body: "I can send a sample box of the new stoneware on Friday. Say if you want the grogged batch."
  },
  {
    id: "draft-glaze",
    thread: "notes",
    seq: 85,
    box: "drafts",
    draft: true,
    account: "timberworks",
    from: "Jon",
    email: "jon@timberworks.example",
    initials: "J",
    color: "#394146",
    subject: "Re: Notes from design review",
    preview: "Cone 6 for the first batch.",
    time: "Draft",
    unread: false,
    to: "leah.okonkwo@timberworks.example",
    toName: "Leah Okonkwo",
    body: "Cone 6 for the first batch.",
    bodyHtml: "<p>Cone 6 for the first batch.</p>"
  }
];

messages.forEach(m => {
  const day = { "08:14": "2026-10-15", "07:41": "2026-10-15", "Yesterday": "2026-10-14", "Monday": "2026-10-12", "Last week": "2026-10-08", "Draft": "2026-10-15", "Now": "2026-10-15" };
  if (!m.date) m.date = day[m.time] || "2026-10-15";
  if (!m.attachments) {
    const files = { receipt: ["Tickets-NL-20418.pdf"], quote: ["Showroom-quote.pdf"], notes: ["Design-review.pdf"], "sent-kiln": ["Booking.pdf"] };
    m.attachments = files[m.id] || [];
  }
});

let events = [
  { id: "stand", account: "timberworks", calendar: "cal-timberworks", day: 0, start: 9 * 60, end: 9 * 60 + 30, title: "Standup" },
  { id: "dentist", account: "personal", calendar: "cal-personal", day: 1, start: 11 * 60, end: 12 * 60, title: "Dentist", showAs: "oof" },
  { id: "design", account: "timberworks", calendar: "cal-timberworks", day: 2, start: 14 * 60, end: 15 * 60 + 30, title: "Design review" },
  { id: "pipeline", account: "timberworks", calendar: "cal-timberworks", day: 3, start: 10 * 60, end: 11 * 60, title: "Pipeline review", where: "Studio · Teams", notes: "Walk the Q4 forecast. Site photos are in the deck.", tentative: true, organizer: { name: "Maya Chen", email: "maya.chen@timberworks.example" }, attendees: [
    { email: "maya.chen@timberworks.example", name: "Maya Chen", status: "accepted" },
    { email: "owen.price@timberworks.example", name: "Owen Price", status: "tentative" },
    { email: "leah.okonkwo@timberworks.example", name: "Leah Okonkwo", status: "none" }
  ] },
  { id: "pickup", account: "personal", calendar: "cal-personal-family", day: 3, start: 15 * 60 + 30, end: 16 * 60 + 15, title: "School pickup", showAs: "free" },
  { id: "allhands", account: "timberworks", calendar: "cal-timberworks", day: 4, start: 9 * 60 + 30, end: 10 * 60 + 30, title: "All hands" }
];
const allday = [
  { id: "offsite", account: "timberworks", calendar: "cal-timberworks-site", day: 4, title: "Showroom install", notes: "Access from the yard gate. Finish before 4.", showAs: "oof" }
];

const sampleAccountIds = new Set(["timberworks", "personal"]);
const sampleEmails = new Set(["jon@timberworks.example", "jon@personal.example"]);

function isSampleEmail(email) {
  return sampleEmails.has(String(email || "").toLowerCase());
}

const contacts = [
  { id: "maya", account: "timberworks", name: "Maya Chen", email: "maya.chen@timberworks.example", phone: "020 7946 0101", title: "Studio lead", company: "Timberworks", initials: "MC", color: "#0f6cbd" },
  { id: "owen", account: "timberworks", name: "Owen Price", email: "owen.price@timberworks.example", phone: "020 7946 0144", title: "Site manager", company: "Timberworks", initials: "OP", color: "#3a5f8a" },
  { id: "leah", account: "timberworks", name: "Leah Okonkwo", email: "leah.okonkwo@timberworks.example", phone: "020 7946 0188", title: "Designer", company: "Timberworks", initials: "LO", color: "#5b3d8a" },
  { id: "sam", account: "timberworks", name: "Sam Adeyemi", email: "sam.adeyemi@timberworks.example", phone: "020 7946 0112", title: "Accounts", company: "Timberworks", initials: "SA", color: "#1a4f7a" },
  { id: "northline", account: "personal", name: "Northline Rail", email: "tickets@northline.example", phone: "0333 000 2041", title: "Bookings", company: "Northline Rail", initials: "NR", color: "#0e7c66" },
  { id: "harbour", account: "personal", name: "Harbour Dental", email: "appointments@harbourdental.example", phone: "01632 960 412", title: "Reception", company: "Harbour Dental", initials: "HD", color: "#0b5c4c" },
  { id: "priya", account: "personal", name: "Priya Shah", email: "priya.shah@personal.example", phone: "07700 900 218", title: "", company: "", initials: "PS", color: "#0e7c66" }
];
const sampleMessageIds = new Set(messages.map(message => message.id));
const sampleEventIds = new Set(events.map(event => event.id).concat(allday.map(event => event.id)));
const sampleContactIds = new Set(contacts.map(person => person.id));

function savedAccountRecords() {
  try {
    const parsed = JSON.parse(localStorage.getItem("mailroom-accounts") || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function rememberAccount(id) {
  if (!inDesktop() || !accounts[id] || isSampleEmail(accounts[id].email)) return;
  const acct = accounts[id];
  const email = String(acct.email || "").toLowerCase();
  const rows = savedAccountRecords().filter(item => item.id !== id && String(item.email || "").toLowerCase() !== email);
  rows.push({
    id,
    name: acct.name,
    email: acct.email,
    yourName: acct.yourName || "Jon",
    cls: acct.cls,
    emails: acct.emails,
    calendars: acct.calendars,
    provider: acct.provider === "google" ? "google" : "microsoft",
    profile: acct.profile === "personal" || acct.profile === "work" ? acct.profile : "",
    aliases: aliasList(acct)
  });
  localStorage.setItem("mailroom-accounts", JSON.stringify(rows));
}

function forgetAccount(id, email) {
  if (!inDesktop()) return;
  const address = String(email || "").toLowerCase();
  const rows = savedAccountRecords().filter(item => item.id !== id && String(item.email || "").toLowerCase() !== address);
  localStorage.setItem("mailroom-accounts", JSON.stringify(rows));
}

function rememberFavorites() {
  if (!inDesktop()) return;
  const rows = favorites.filter(item => {
    const acct = accounts[item.account];
    return acct && item.box && !isSampleEmail(acct.email);
  }).map(item => ({
    account: item.account,
    box: item.box,
    name: item.name || boxLabel(item.box, item.account)
  }));
  localStorage.setItem("mailroom-favourites", JSON.stringify(rows));
}

function restoreFavorites() {
  if (!inDesktop()) return;
  let rows = [];
  try {
    const parsed = JSON.parse(localStorage.getItem("mailroom-favourites") || "[]");
    if (Array.isArray(parsed)) rows = parsed;
  } catch (e) {
    rows = [];
  }
  favorites = [];
  rows.forEach(item => {
    const accountId = String(item && item.account || "");
    const box = String(item && item.box || "");
    const acct = accounts[accountId];
    if (!acct || !box || isSampleEmail(acct.email)) return;
    if (favorites.some(entry => entry.account === accountId && entry.box === box)) return;
    favorites.push({ account: accountId, box, name: String(item.name || "") });
  });
}

function installAccount(record) {
  if (!record || !record.id || accounts[record.id] || isSampleEmail(record.email)) return;
  const cls = record.cls || "work";
  accounts[record.id] = {
    name: record.name || "Account",
    email: record.email || "",
    cls,
    yourName: record.yourName || "Jon",
    emails: record.emails || [{ id: "mail-" + record.id, address: record.email || "" }],
    calendars: record.calendars || [{ id: "cal-" + record.id, name: "Calendar", cls }],
    provider: record.provider === "google" ? "google" : "microsoft",
    profile: record.profile === "personal" || record.profile === "work" ? record.profile : "",
    aliases: Array.isArray(record.aliases) ? record.aliases : []
  };
}

// Work and Personal are separate, as on Outlook mobile. A Microsoft account
// starts in Work and a Google account in Personal, unless the account card
// says otherwise. All accounts means the accounts in the profile on screen.
let activeProfile = (() => {
  try {
    const saved = localStorage.getItem("mailroom-profile");
    if (saved === "personal" || saved === "work") return saved;
  } catch (e) {}
  return "work";
})();

function rememberActiveProfile() {
  try { localStorage.setItem("mailroom-profile", activeProfile); } catch (e) {}
}

function accountProfile(id) {
  const acct = accounts[id];
  if (!acct) return "work";
  if (acct.profile === "personal" || acct.profile === "work") return acct.profile;
  if (acct.provider === "google" || id === "personal") return "personal";
  return "work";
}

function accountInProfile(id, profile) {
  return !!accounts[id] && accountProfile(id) === (profile || activeProfile);
}

function profileAccountIds(profile) {
  const want = profile || activeProfile;
  return Object.keys(accounts).filter(id => accountProfile(id) === want);
}

function profileEntries(profile) {
  return profileAccountIds(profile).map(id => [id, accounts[id]]);
}

function profileCalendars() {
  return calendarRows();
}

// Both puts Work and Personal on one calendar. Mail and People stay on the
// open profile. The choice is remembered.
let calendarBoth = false;
try { calendarBoth = localStorage.getItem("mailroom-calendar-both") === "1"; } catch (e) {}

function rememberCalendarBoth() {
  try { localStorage.setItem("mailroom-calendar-both", calendarBoth ? "1" : "0"); } catch (e) {}
}

function calendarProfilesBoth() {
  return calendarBoth && profileAccountIds("work").length > 0 && profileAccountIds("personal").length > 0;
}

function calendarAccountVisible(id) {
  if (!id || !accounts[id]) return true;
  if (calendarProfilesBoth()) return true;
  return accountInProfile(id);
}

function calendarEntries() {
  if (!calendarProfilesBoth()) return profileEntries();
  return Object.keys(accounts).filter(id => accounts[id]).map(id => [id, accounts[id]]);
}

function calendarRows() {
  const rows = [];
  calendarEntries().forEach(([accountId, acct]) => {
    (acct.calendars || []).forEach(cal => rows.push({
      accountId, acct, id: cal.id, name: cal.name, cls: cal.cls, canEdit: cal.canEdit
    }));
  });
  return rows;
}

function profileLabel(profile) {
  return profile === "personal" ? "Personal" : "Work";
}

function profileUnread(profile) {
  return profileAccountIds(profile).reduce((sum, id) => {
    const acct = accounts[id];
    const inbox = acct && (acct.liveFolders || []).find(folder => folder.key === "inbox");
    if (acct && acct.signedIn && inbox && Number.isFinite(Number(inbox.unread))) return sum + (Number(inbox.unread) || 0);
    return sum + unreadCount(id);
  }, 0);
}

function messageInAccountView(acct, messageAccount) {
  if (acct === "all") return accountInProfile(messageAccount);
  return messageAccount === acct;
}

function profileSwitchHtml() {
  const showBoth = view === "calendar" && profileAccountIds("work").length > 0 && profileAccountIds("personal").length > 0;
  const button = (profile) => {
    const on = activeProfile === profile && !(showBoth && calendarBoth);
    const n = on ? 0 : profileUnread(profile);
    const badge = n ? `<span class="profile-badge">${n > 99 ? "99+" : n}</span>` : "";
    return `<button type="button" data-set-profile="${profile}" aria-pressed="${on}">${profileLabel(profile)}${badge}</button>`;
  };
  const both = showBoth ? `<button type="button" data-set-calendar="both" aria-pressed="${calendarBoth}">Both</button>` : "";
  return `<div class="seg profile-switch" role="group" aria-label="${showBoth ? "Calendars" : "Profile"}">${button("work")}${button("personal")}${both}</div>`;
}

function bindProfileSwitch(root) {
  (root || document).querySelectorAll("[data-set-profile]").forEach(btn => {
    btn.onclick = () => {
      const next = btn.dataset.setProfile;
      const wasBoth = view === "calendar" && calendarBoth;
      if (wasBoth) {
        calendarBoth = false;
        rememberCalendarBoth();
      }
      if (next === activeProfile) {
        if (wasBoth) render();
        return;
      }
      setActiveProfile(next);
    };
  });
  (root || document).querySelectorAll("[data-set-calendar]").forEach(btn => {
    btn.onclick = () => {
      if (calendarBoth) return;
      calendarBoth = true;
      rememberCalendarBoth();
      render();
    };
  });
}

function settleProfileSelection() {
  if (account !== "all" && accounts[account] && !accountInProfile(account)) {
    activeProfile = accountProfile(account);
    rememberActiveProfile();
  } else {
    const open = selected && messages.find(m => m.id === selected);
    if (open && accounts[open.account] && !accountInProfile(open.account)) {
      activeProfile = accountProfile(open.account);
      rememberActiveProfile();
      account = open.account;
      const nextBox = messageBox(open);
      if (boxNames[nextBox]) box = nextBox;
    }
  }
  if (!profileAccountIds().length) {
    const other = activeProfile === "personal" ? "work" : "personal";
    if (profileAccountIds(other).length) {
      activeProfile = other;
      rememberActiveProfile();
    }
  }
  const ids = profileAccountIds();
  if (account !== "all" && !accountInProfile(account)) {
    account = ids.length > 1 ? "all" : (ids[0] || "all");
    folderPick = "folder";
  }
  if (account === "all" && ids.length === 1) {
    account = ids[0];
    folderPick = "folder";
  }
  if (contactAccount !== "all" && !accountInProfile(contactAccount)) {
    contactAccount = ids.length > 1 ? "all" : (ids[0] || "all");
  }
  if (contactAccount === "all" && ids.length === 1) contactAccount = ids[0];
  if (searchAccount && !accountInProfile(searchAccount)) searchAccount = "";
  if (selected) {
    const open = messages.find(m => m.id === selected);
    if (!open || !accountInProfile(open.account)) selected = (conversations()[0] && conversations()[0].latest.id) || null;
  }
}

function setActiveProfile(next) {
  if ((next !== "work" && next !== "personal") || next === activeProfile) return;
  capturePaneCompose();
  activeProfile = next;
  rememberActiveProfile();
  const ids = profileAccountIds();
  if (!ids.includes(account)) {
    account = ids.length > 1 ? "all" : (ids[0] || "all");
    folderPick = "folder";
    box = "inbox";
  } else if (account === "all" && ids.length === 1) {
    account = ids[0];
    folderPick = "folder";
  }
  if (!ids.includes(contactAccount)) {
    contactAccount = ids.length > 1 ? "all" : (ids[0] || "all");
  } else if (contactAccount === "all" && ids.length === 1) {
    contactAccount = ids[0];
  }
  if (searchAccount && !ids.includes(searchAccount)) searchAccount = "";
  const open = selected && messages.find(m => m.id === selected);
  if (!open || !ids.includes(open.account)) selected = (conversations()[0] && conversations()[0].latest.id) || null;
  expanded.clear();
  folded.clear();
  const people = filteredContacts();
  if (!people.some(c => c.id === selectedContact)) selectedContact = (people[0] && people[0].id) || null;
  if (typeof directoryPeople !== "undefined") {
    directoryPeople.clear();
    directorySearched.clear();
    loadDirectory();
  }
  render();
  if (view === "mail" && inDesktop()) {
    if (account === "all") ensureUnifiedFolder(box);
    else if (accounts[account]) ensureFolderMessages(account, box);
  }
}

function setAccountProfile(id, next) {
  const acct = accounts[id];
  if (!acct || (next !== "work" && next !== "personal") || accountProfile(id) === next) return;
  acct.profile = next;
  rememberAccount(id);
  settleProfileSelection();
  const people = filteredContacts();
  if (!people.some(c => c.id === selectedContact)) selectedContact = (people[0] && people[0].id) || null;
  toast(acct.name + " is in " + profileLabel(next));
  render();
}

// Google accounts (Gmail and Google Calendar) do mail, folders and the
// calendar; Outlook's categories, rules, automatic replies, send later,
// contacts and who's free are Microsoft's for now.
function isGoogleAccount(accountId) {
  return !!(accounts[accountId] && accounts[accountId].provider === "google");
}

function providerName(accountId) {
  return isGoogleAccount(accountId) ? "Google" : "Microsoft";
}

function dropSampleRows(accountId) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].account === accountId && sampleMessageIds.has(messages[i].id)) messages.splice(i, 1);
  }
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].account === accountId && sampleEventIds.has(events[i].id)) events.splice(i, 1);
  }
  for (let i = allday.length - 1; i >= 0; i--) {
    if (allday[i].account === accountId && sampleEventIds.has(allday[i].id)) allday.splice(i, 1);
  }
  for (let i = contacts.length - 1; i >= 0; i--) {
    if (contacts[i].account === accountId && sampleContactIds.has(contacts[i].id)) contacts.splice(i, 1);
  }
}

function clearSampleAccounts() {
  sampleAccountIds.forEach(id => {
    dropWhere(messages, id);
    dropWhere(events, id);
    dropWhere(allday, id);
    dropWhere(contacts, id);
    signatures = signatures.filter(item => item.account !== id);
    favorites = favorites.filter(item => item.account !== id);
    delete accounts[id];
  });
  if (!messages.some(message => message.id === selected)) selected = null;
  if (!contacts.some(person => person.id === selectedContact)) selectedContact = null;
  if (account !== "all" && !accounts[account]) account = "all";
  if (contactAccount !== "all" && !accounts[contactAccount]) contactAccount = "all";
  settleDefaults();
}

function prepareDesktopAccounts() {
  if (!inDesktop()) return;
  clearSampleAccounts();
  const rows = savedAccountRecords().filter(item => item && item.id && !isSampleEmail(item.email));
  localStorage.setItem("mailroom-accounts", JSON.stringify(rows));
  rows.forEach(installAccount);
  adoptSavedDefaults();
}

const params = new URLSearchParams(location.search);
const popCompose = params.get("compose") === "reply" || params.get("compose") === "new";
if (popCompose) document.body.dataset.compose = "pop";
const assistWindow = params.get("assist") === "1";
if (assistWindow) {
  document.body.dataset.assist = "window";
  try { localStorage.setItem("mailroom-assist-pop", params.get("owner") === "compose" ? "compose" : "main"); } catch (e) {}
  window.addEventListener("pagehide", () => {
    try { localStorage.removeItem("mailroom-assist-pop"); } catch (err) {}
  });
} else if (!popCompose) {
  try { localStorage.removeItem("mailroom-assist-pop"); } catch (e) {}
}
let view = ["calendar", "people", "settings"].includes(params.get("view")) ? params.get("view") : "mail";
let calView = "work";
let calFocus = inDesktop() ? new Date() : new Date(2026, 9, 15);
let account = params.get("account") || "all";
const boxNames = { inbox: "Inbox", drafts: "Drafts", outbox: "Outbox", sent: "Sent items", archive: "Archive", trash: "Trash" };
let box = boxNames[params.get("box")] ? params.get("box") : "inbox";
let folderPick = "folder";
const collapsedSections = new Set();
const collapsedFolders = new Set();

let calColourMenu = null;
let calColourAnchor = null;
let contactAccount = "all";
let query = "";
let searchScope = "";
let searchAccount = "";
let searchFiles = "";
let searchFrom = "";
let searchTo = "";
let selected = params.get("msg") || "meet";
let revealReading = false;
let mailFilter = ["read", "unread", "flagged", "events"].includes(params.get("filter")) ? params.get("filter") : "";
let replyDraft = null;
let replyView = "reply";
let paneCompose = null;
let focusReply = false;
let selectedContact = params.get("contact") || "maya";
let rsvp = params.get("rsvp") || null;
if (rsvp === "accepted" || rsvp === "tentative" || rsvp === "declined") {
  const ev = events.find(e => e.id === "pipeline");
  if (ev) applyEventResponse(ev, rsvp);
}

const folders = document.getElementById("folder-nav");
const rows = document.getElementById("rows");
const reading = document.getElementById("reading");
const listTitle = document.getElementById("list-title");
const popRoot = document.getElementById("pop-root");

function messageBox(m) {
  return m.box || "inbox";
}

function unreadCount(acct) {
  return messages.filter(m => messageInAccountView(acct, m.account) && messageBox(m) === "inbox" && m.unread).length;
}

function folderCount(acct, folder) {
  return messages.filter(m => messageInAccountView(acct, m.account) && messageBox(m) === folder).length;
}

function accountFolderKeys(id) {
  const acct = accounts[id];
  if (acct && acct.signedIn && acct.liveFolders && acct.liveFolders.length) {
    const keys = acct.liveFolders.map(folder => folder.key);
    if (!keys.includes("outbox")) keys.push("outbox");
    return keys;
  }
  return ["inbox", "drafts", "outbox", "sent", "archive", "trash"];
}

function isCategoryBox(folder) {
  return String(folder || "").startsWith("cat:");
}

function categoryNameOf(folder) {
  return String(folder || "").slice(4);
}

function isSearchBox(folder) {
  return String(folder || "").startsWith("search:");
}

function searchFolderOf(acct, folder) {
  return ((accounts[acct] && accounts[acct].searchFolders) || []).find(item => item.key === folder || item.id === folder) || null;
}

function knownFolder(acct, folder) {
  if (isCategoryBox(folder)) {
    const name = categoryNameOf(folder);
    return !!((accounts[acct] && accounts[acct].categories) || []).some(item => item.name === name);
  }
  if (isSearchBox(folder)) return !!searchFolderOf(acct, folder);
  return accountFolderKeys(acct).includes(folder);
}

function boxLabel(folder, acct) {
  if (isCategoryBox(folder)) return categoryNameOf(folder);
  if (acct && acct !== "all") {
    const search = searchFolderOf(acct, folder);
    if (search && search.name) return search.name;
    const found = ((accounts[acct] && accounts[acct].liveFolders) || []).find(item => item.key === folder);
    if (found && found.name) return found.name;
  }
  if (boxNames[folder]) return boxNames[folder];
  for (const [, item] of profileEntries()) {
    const found = (item.liveFolders || []).find(entry => entry.key === folder);
    if (found && found.name) return found.name;
  }
  return "Folder";
}

function pendingOutboxCount(acct) {
  return messages.filter(m => m.pendingSend && messageInAccountView(acct, m.account)).length;
}

// Unread or total count, per folder (2026-10-28), as Outlook's folder menu
// offers: the Inbox shows unread and other folders their total until chosen.
function readFolderCountModes() {
  try { const v = JSON.parse(localStorage.getItem("mailroom-folder-counts") || "{}"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; }
}
let folderCountModes = readFolderCountModes();

function folderCountMode(acct, folder) {
  const v = folderCountModes[acct + "\n" + folder];
  if (v === "unread" || v === "total") return v;
  return folder === "inbox" ? "unread" : "total";
}

function setFolderCountMode(acct, folder, mode) {
  const key = acct + "\n" + folder;
  const fallback = folder === "inbox" ? "unread" : "total";
  if (mode === fallback) delete folderCountModes[key];
  else folderCountModes[key] = mode;
  try { localStorage.setItem("mailroom-folder-counts", JSON.stringify(folderCountModes)); } catch (e) {}
  render();
}

function folderBadge(acct, folder) {
  if (isCategoryBox(folder)) {
    const name = categoryNameOf(folder);
    const unread = folderCountMode(acct, folder) === "unread";
    return messages.filter(m => messageInAccountView(acct, m.account) && (m.categories || []).includes(name) && messageBox(m) !== "drafts" && messageBox(m) !== "outbox" && (!unread || m.unread)).length;
  }
  if (isSearchBox(folder)) return 0;
  const pending = folder === "outbox" ? pendingOutboxCount(acct) : 0;
  const unread = folderCountMode(acct, folder) === "unread";
  if (acct === "all") {
    const rows = profileEntries().map(([, item]) => (item.liveFolders || []).find(entry => entry.key === folder)).filter(Boolean);
    if (rows.length) {
      return rows.reduce((sum, entry) => sum + (unread ? (Number(entry.unread) || 0) : (Number(entry.total) || 0)), 0) + pending;
    }
  }
  const live = accounts[acct] && accounts[acct].signedIn && accounts[acct].liveFolders;
  if (live && live.length) {
    const found = live.find(item => item.key === folder);
    if (found) return (unread ? found.unread : found.total) + pending;
  }
  if (unread) return messages.filter(m => messageInAccountView(acct, m.account) && messageBox(m) === folder && m.unread).length;
  return folderCount(acct, folder);
}

let favorites = [];

function favoriteIndex(acct, folder) {
  return favorites.findIndex(item => item.account === acct && item.box === folder);
}

function isFavorite(acct, folder) {
  return favoriteIndex(acct, folder) >= 0;
}

function addFavorite(acct, folder) {
  if (!accounts[acct] || !knownFolder(acct, folder) || isFavorite(acct, folder)) return;
  favorites.push({ account: acct, box: folder, name: boxLabel(folder, acct) });
  rememberFavorites();
  toast("Added to favorites");
  render();
}

function removeFavorite(acct, folder) {
  const index = favoriteIndex(acct, folder);
  if (index < 0) return;
  favorites.splice(index, 1);
  if (folderPick === "fav" && account === acct && box === folder) folderPick = "folder";
  rememberFavorites();
  toast("Removed from favorites");
  render();
}

function favoriteVisible(item) {
  if (!item || !accountInProfile(item.account)) return false;
  if (isCategoryBox(item.box) || isSearchBox(item.box)) return knownFolder(item.account, item.box) || !accounts[item.account].signedIn;
  if (knownFolder(item.account, item.box)) return true;
  return !accounts[item.account].signedIn;
}

function sectionOpen(key) {
  return !collapsedSections.has(key);
}

function sectionChevron() {
  return `<svg class="section-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.2 2.2L8 6 4.2 9.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function sectionHead(key, labelHtml, name) {
  const open = sectionOpen(key);
  return `<button class="acct-label section" type="button" data-section="${esc(key)}" aria-expanded="${open}" aria-label="${esc((open ? "Collapse " : "Expand ") + name)}">${sectionChevron()}${labelHtml}</button>`;
}

function liveFolder(id, key) {
  return ((accounts[id] && accounts[id].liveFolders) || []).find(item => item.key === key);
}

function folderHasChildren(id, folder) {
  if (!folder || !folder.id) return false;
  return ((accounts[id] && accounts[id].liveFolders) || []).some(item => item.parentId && item.parentId === folder.id);
}

function folderHidden(id, key) {
  const folders = (accounts[id] && accounts[id].liveFolders) || [];
  const byId = new Map(folders.map(item => [item.id, item]));
  let current = liveFolder(id, key);
  const seen = new Set();
  while (current && current.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    if (collapsedFolders.has(id + "\n" + parent.key)) return true;
    current = parent;
  }
  return false;
}

function visibleAccountFolders(id) {
  return orderedFolderKeys(id).filter(folder => !folderHidden(id, folder));
}

const CORE_FOLDERS = new Set(["inbox", "drafts", "sent", "archive", "trash", "outbox"]);
const moreFoldersOpen = new Set((() => { try { return JSON.parse(localStorage.getItem("mailroom-more-folders") || "[]"); } catch (e) { return []; } })());

// Everyday folders first; the rest wait under "More folders".
function splitAccountFolders(id) {
  const all = visibleAccountFolders(id);
  const core = all.filter(folder => CORE_FOLDERS.has(folder) || folderKind(folder, id) === "junk" || (account === id && box === folder));
  const extra = all.filter(folder => !core.includes(folder));
  return { core, extra };
}

function accountFoldersHtml(id) {
  const { core, extra } = splitAccountFolders(id);
  const open = moreFoldersOpen.has(id);
  const toggle = extra.length
    ? `<button class="acct-item folder-sub more-folders" type="button" data-more-folders="${esc(id)}" aria-expanded="${open}">${sectionChevron()}<span class="folder-name">${open ? "Fewer folders" : "More folders"}</span><span class="count">${open ? "" : extra.length}</span></button>`
    : "";
  return core.map(folder => folderButton(id, folder)).join("") + toggle + (open ? extra.map(folder => folderButton(id, folder)).join("") : "");
}

function categoryButton(id, cat) {
  const folder = "cat:" + cat.name;
  const current = account === id && box === folder;
  const on = isFavorite(id, folder);
  const name = accounts[id] ? accounts[id].name : "";
  const verb = on ? "Remove from favorites" : "Add to favorites";
  const colour = CATEGORY_COLOURS[cat.color] || "#8a8886";
  return `<div class="folder-row">
    <button class="acct-item folder-sub" type="button" data-acct="${esc(id)}" data-box="${esc(folder)}" data-cat-name="${esc(cat.name)}" aria-current="${current}">
      <span class="folder-ico"><span class="cat-dot" style="background:${colour}"></span></span><span class="folder-name">${esc(cat.name)}</span><span class="count">${folderBadge(id, folder) || ""}</span>
    </button>
    <button class="fav-pin" type="button" data-pin="${esc(id)}" data-pin-box="${esc(folder)}" aria-pressed="${on}" aria-label="${esc(verb + ": " + name + " " + cat.name)}" title="${esc(verb)}"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l1.7 3.6 4 .5-2.9 2.7.7 3.9L8 10.6 4.5 12.5l.7-3.9L2.3 5.9l4-.5L8 1.8z" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg></button>
  </div>`;
}

function categoryFoldersHtml(id) {
  const cats = (accounts[id] && accounts[id].categories) || [];
  if (!cats.length || isGoogleAccount(id)) return "";
  return `<div class="acct-label quiet">Categories</div>` + cats.map(cat => categoryButton(id, cat)).join("");
}

function searchFolderButton(id, item) {
  const current = account === id && box === item.key;
  const on = isFavorite(id, item.key);
  const name = accounts[id] ? accounts[id].name : "";
  const verb = on ? "Remove from favorites" : "Add to favorites";
  return `<div class="folder-row">
    <button class="acct-item folder-sub" type="button" data-acct="${esc(id)}" data-box="${esc(item.key)}" data-folder-id="${esc(item.id)}" data-search-folder="1" aria-current="${current}">
      ${folderIcon("folder", id)}<span class="folder-name">${esc(item.name)}</span><span class="count"></span>
    </button>
    <button class="fav-pin" type="button" data-pin="${esc(id)}" data-pin-box="${esc(item.key)}" aria-pressed="${on}" aria-label="${esc(verb + ": " + name + " " + item.name)}" title="${esc(verb)}"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l1.7 3.6 4 .5-2.9 2.7.7 3.9L8 10.6 4.5 12.5l.7-3.9L2.3 5.9l4-.5L8 1.8z" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg></button>
  </div>`;
}

function searchFoldersHtml(id) {
  const list = (accounts[id] && accounts[id].searchFolders) || [];
  if (!list.length || isGoogleAccount(id)) return "";
  return `<div class="acct-label quiet">Search folders</div>` + list.map(item => searchFolderButton(id, item)).join("");
}

let folderOrder = {};
let folderDrag = null;
let suppressFolderClick = false;

function loadFolderOrder() {
  try {
    const parsed = JSON.parse(localStorage.getItem("mailroom-folder-order") || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) folderOrder = parsed;
  } catch (e) {}
}

function loadMailCollapse() {
  try {
    const parsed = JSON.parse(localStorage.getItem("mailroom-mail-collapse") || "{}");
    const sections = Array.isArray(parsed.sections) ? parsed.sections : [];
    const folders = Array.isArray(parsed.folders) ? parsed.folders : [];
    sections.forEach(key => {
      const id = String(key || "");
      if (id) collapsedSections.add(id);
    });
    folders.forEach(key => {
      const id = String(key || "");
      if (id.includes("\n")) collapsedFolders.add(id);
    });
  } catch (e) {}
}

function rememberMailCollapse() {
  if (!inDesktop()) return;
  const sections = [...collapsedSections].filter(key => {
    if (key === "fav" || key === "all") return true;
    const acct = accounts[key];
    return !!(acct && !isSampleEmail(acct.email));
  });
  const folders = [...collapsedFolders].filter(key => {
    const id = String(key).split("\n")[0];
    const acct = accounts[id];
    return !!(acct && !isSampleEmail(acct.email));
  });
  try { localStorage.setItem("mailroom-mail-collapse", JSON.stringify({ sections, folders })); } catch (e) {}
}

function rememberFolderOrder() {
  if (!inDesktop()) return;
  const rows = {};
  Object.entries(folderOrder).forEach(([id, groups]) => {
    const acct = accounts[id];
    if (!acct || isSampleEmail(acct.email) || !groups || typeof groups !== "object") return;
    const clean = {};
    Object.entries(groups).forEach(([parent, keys]) => {
      if (!Array.isArray(keys)) return;
      clean[parent] = keys.map(key => String(key || "")).filter(Boolean);
    });
    rows[id] = clean;
  });
  try { localStorage.setItem("mailroom-folder-order", JSON.stringify(rows)); } catch (e) {}
}

loadFolderOrder();
loadMailCollapse();

function siblingKey(id, key) {
  const folder = liveFolder(id, key);
  if (!folder || !folder.parentId) return "";
  const parent = ((accounts[id] && accounts[id].liveFolders) || []).find(item => item.id === folder.parentId);
  return parent ? parent.key : "";
}

function orderedFolderKeys(id) {
  const keys = accountFolderKeys(id);
  const groups = new Map();
  keys.forEach(key => {
    const parent = siblingKey(id, key);
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(key);
  });
  const saved = folderOrder[id] || {};
  groups.forEach((list, parent) => {
    const rank = new Map((saved[parent] || []).map((key, index) => [key, index]));
    list.sort((a, b) => {
      const ar = rank.has(a) ? rank.get(a) : 100000;
      const br = rank.has(b) ? rank.get(b) : 100000;
      if (ar !== br) return ar - br;
      return keys.indexOf(a) - keys.indexOf(b);
    });
  });
  const out = [];
  const seen = new Set();
  const walk = (parent) => {
    (groups.get(parent) || []).forEach(key => {
      if (seen.has(key)) return;
      seen.add(key);
      out.push(key);
      walk(key);
    });
  };
  walk("");
  keys.forEach(key => { if (!seen.has(key)) out.push(key); });
  return out;
}

function moveFolder(acct, key, targetKey, before) {
  if (!key || !targetKey || key === targetKey) return;
  if (siblingKey(acct, key) !== siblingKey(acct, targetKey)) return;
  const parent = siblingKey(acct, key);
  const current = orderedFolderKeys(acct).filter(item => siblingKey(acct, item) === parent);
  const next = current.filter(item => item !== key);
  let index = next.indexOf(targetKey);
  if (index < 0) return;
  if (!before) index += 1;
  next.splice(index, 0, key);
  if (!folderOrder[acct] || typeof folderOrder[acct] !== "object" || Array.isArray(folderOrder[acct])) folderOrder[acct] = {};
  folderOrder[acct][parent] = next;
  rememberFolderOrder();
  render();
}

function folderDescendant(acct, key, ancestor) {
  let cursor = key;
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = siblingKey(acct, cursor);
    if (!parent) return false;
    if (parent === ancestor) return true;
    cursor = parent;
  }
  return false;
}

function folderSiblingAt(acct, key, parentKey) {
  let cursor = key;
  const seen = new Set();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    if (siblingKey(acct, cursor) === parentKey) return cursor;
    const parent = siblingKey(acct, cursor);
    if (!parent) return "";
    cursor = parent;
  }
  return "";
}

function clearFolderDropMarks() {
  document.querySelectorAll(".folder-row.drop-before, .folder-row.drop-after").forEach(row => {
    row.classList.remove("drop-before", "drop-after");
  });
}

function folderGroupEnd(acct, key) {
  const rows = [...folders.querySelectorAll(".folder-row")];
  const start = rows.findIndex(row => {
    const btn = row.querySelector("[data-box]");
    return btn && btn.dataset.acct === acct && btn.dataset.box === key;
  });
  if (start < 0) return null;
  let end = rows[start];
  for (let i = start + 1; i < rows.length; i++) {
    const btn = rows[i].querySelector("[data-box]");
    if (!btn || btn.dataset.acct !== acct || !folderDescendant(acct, btn.dataset.box, key)) break;
    end = rows[i];
  }
  return end;
}

function bindFolderDrag() {
  folders.querySelectorAll(".folder-row").forEach(row => {
    row.addEventListener("pointerdown", onFolderPointerDown);
  });
}

function endFolderDrag(commit) {
  const drag = folderDrag;
  if (!drag) return;
  folderDrag = null;
  document.removeEventListener("pointermove", onFolderPointerMove);
  document.removeEventListener("pointerup", onFolderPointerUp);
  document.removeEventListener("pointercancel", onFolderPointerUp);
  clearFolderDropMarks();
  if (drag.row) drag.row.classList.remove("is-dragging");
  document.body.classList.remove("is-folder-drag");
  if (!commit || !drag.moved) return;
  suppressFolderClick = true;
  setTimeout(() => { suppressFolderClick = false; }, 0);
  if (drag.targetKey) moveFolder(drag.acct, drag.key, drag.targetKey, drag.before);
}

function onFolderPointerDown(ev) {
  if (ev.button !== 0 || folderDrag) return;
  if (ev.target.closest(".folder-twist, .fav-pin")) return;
  const btn = ev.currentTarget.querySelector("[data-box]");
  if (!btn || !btn.dataset.acct || btn.dataset.acct === "all") return;
  suppressFolderClick = false;
  folderDrag = {
    acct: btn.dataset.acct,
    key: btn.dataset.box,
    parent: siblingKey(btn.dataset.acct, btn.dataset.box),
    x: ev.clientX,
    y: ev.clientY,
    moved: false,
    row: ev.currentTarget,
    targetKey: "",
    before: false
  };
  document.addEventListener("pointermove", onFolderPointerMove);
  document.addEventListener("pointerup", onFolderPointerUp);
  document.addEventListener("pointercancel", onFolderPointerUp);
}

function onFolderPointerMove(ev) {
  const drag = folderDrag;
  if (!drag) return;
  if (!drag.moved) {
    if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 4) return;
    drag.moved = true;
    drag.row.classList.add("is-dragging");
    document.body.classList.add("is-folder-drag");
  }
  clearFolderDropMarks();
  drag.targetKey = "";
  const hit = document.elementFromPoint(ev.clientX, ev.clientY);
  const row = hit && hit.closest ? hit.closest(".folder-row") : null;
  const btn = row && row.querySelector("[data-box]");
  if (!btn || btn.dataset.acct !== drag.acct) return;
  const sibling = folderSiblingAt(drag.acct, btn.dataset.box, drag.parent);
  if (!sibling || sibling === drag.key) return;
  const direct = siblingKey(drag.acct, btn.dataset.box) === drag.parent;
  const rect = row.getBoundingClientRect();
  const before = direct && ev.clientY < rect.top + rect.height / 2;
  drag.targetKey = sibling;
  drag.before = before;
  const line = before ? row : (folderGroupEnd(drag.acct, sibling) || row);
  line.classList.add(before ? "drop-before" : "drop-after");
}

function onFolderPointerUp() {
  endFolderDrag(true);
}

window.addEventListener("blur", () => endFolderDrag(false));

function folderKind(folder, acct) {
  const key = String(folder || "");
  if (key === "inbox" || key === "drafts" || key === "outbox" || key === "sent" || key === "archive" || key === "trash") return key;
  const name = boxLabel(key, acct).trim().toLowerCase();
  if (name === "junk email" || name === "junk" || name === "spam") return "junk";
  if (name === "conversation history") return "chat";
  if (name === "rss feeds" || name === "rss subscriptions") return "rss";
  return "folder";
}

function folderIconSvg(kind) {
  const pen = `fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"`;
  const paths = {
    inbox: `<path ${pen} d="M2.3 6.6 4.4 3.3h7.2l2.1 3.3v5.6c0 .5-.4.9-.9.9H3.2c-.5 0-.9-.4-.9-.9V6.6z"/><path ${pen} d="M2.3 6.6h3l.8 1.6h3.8l.8-1.6h3"/>`,
    drafts: `<path ${pen} d="M4.2 2.3h4.8L12 5.3v8c0 .4-.3.7-.8.7H4.2c-.4 0-.8-.3-.8-.7V3c0-.4.4-.7.8-.7z"/><path ${pen} d="M8.8 2.5V5.2H12M5.3 8h5M5.3 10.3h3.2"/>`,
    outbox: `<path ${pen} d="M8 1.8v5.2M5.8 4 8 1.8 10.2 4"/><path ${pen} d="M3.2 8h2.4l.8 1.5h3.2l.8-1.5h2.4v4.6c0 .5-.4.8-.9.8H4.1c-.5 0-.9-.3-.9-.8V8z"/>`,
    sent: `<path ${pen} d="M2.3 8.2 13.5 2.8 8.7 13.5 7.3 8.8 2.3 8.2z"/><path ${pen} d="M7.3 8.8 13.5 2.8"/>`,
    archive: `<path ${pen} d="M2.2 3.1h11.6v2.3H2.2z"/><path ${pen} d="M3.3 5.4v7.1h9.4V5.4M6.2 8.3h3.6"/>`,
    trash: `<path ${pen} d="M3.1 4.3h9.8M6.2 4.2V2.8h3.6v1.4M4.4 4.3l.6 8.5h6l.6-8.5"/>`,
    junk: `<circle ${pen} cx="8" cy="8" r="5.2"/><path ${pen} d="M4.4 11.6 11.6 4.4"/>`,
    chat: `<path ${pen} d="M2.6 3.2h7.4c.4 0 .8.3.8.8v3.8c0 .4-.4.8-.8.8H6.4L4 11.2V8.6h-.6c-.4 0-.8-.4-.8-.8V4c0-.5.4-.8.8-.8z"/>`,
    rss: `<circle cx="4.1" cy="11.6" r="1.15" fill="currentColor"/><path ${pen} d="M3.2 7.2a5.2 5.2 0 0 1 5.2 5.2M3.2 4.2a8.2 8.2 0 0 1 8.2 8.2"/>`,
    folder: `<path ${pen} d="M2.2 4.4c0-.5.4-.8.9-.8h3l1.2 1.3h5.6c.5 0 .9.3.9.8v6.2c0 .5-.4.9-.9.9H3.1c-.5 0-.9-.4-.9-.9V4.4z"/>`
  };
  return `<svg class="folder-glyph" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">${paths[kind] || paths.folder}</svg>`;
}

function folderIcon(folder, acct) {
  return `<span class="folder-ico">${folderIconSvg(folderKind(folder, acct))}</span>`;
}

function folderButton(acct, folder) {
  const current = folderPick !== "fav" && account === acct && box === folder;
  const count = folderBadge(acct, folder);
  const label = acct === "all" && folder === "inbox" ? "All inboxes" : boxLabel(folder, acct);
  const live = acct !== "all" && accounts[acct] && (accounts[acct].liveFolders || []).find(item => item.key === folder);
  const depth = live && live.depth ? Number(live.depth) : 0;
  const cls = acct === "all" ? "nav-item" : "acct-item folder-sub";
  const depthAttr = depth > 0 ? ` data-depth="${depth}"` : "";
  const folderIdAttr = live && live.id ? ` data-folder-id="${esc(live.id)}"` : "";
  const button = `<button class="${cls}" type="button" data-acct="${esc(acct)}" data-box="${esc(folder)}"${depthAttr}${folderIdAttr} aria-current="${current}">
    ${folderIcon(folder, acct)}<span class="folder-name">${esc(label)}</span><span class="count">${count || ""}</span>
  </button>`;
  if (acct === "all") return button;
  const twist = folderHasChildren(acct, live)
    ? `<button class="folder-twist" type="button" data-fold="${esc(acct)}" data-fold-box="${esc(folder)}" aria-expanded="${!collapsedFolders.has(acct + "\n" + folder)}" aria-label="${esc((collapsedFolders.has(acct + "\n" + folder) ? "Expand " : "Collapse ") + label)}">${sectionChevron()}</button>`
    : "";
  const on = isFavorite(acct, folder);
  const name = accounts[acct] ? accounts[acct].name : "";
  const verb = on ? "Remove from favorites" : "Add to favorites";
  const rowDepth = live ? ` data-depth="${depth}"` : "";
  return `<div class="folder-row"${rowDepth}>${twist}${button}<button class="fav-pin" type="button" data-pin="${esc(acct)}" data-pin-box="${esc(folder)}" aria-pressed="${on}" aria-label="${esc(verb + ": " + name + " " + label)}" title="${esc(verb)}"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l1.7 3.6 4 .5-2.9 2.7.7 3.9L8 10.6 4.5 12.5l.7-3.9L2.3 5.9l4-.5L8 1.8z" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg></button></div>`;
}

function favoriteButton(acct, folder) {
  const acctObj = accounts[acct];
  if (!acctObj) return "";
  const current = folderPick === "fav" && account === acct && box === folder;
  const count = folderBadge(acct, folder);
  const saved = favorites.find(item => item.account === acct && item.box === folder);
  let label = boxLabel(folder, acct);
  if (label === "Folder" && saved && saved.name) label = saved.name;
  const live = (acctObj.liveFolders || []).find(item => item.key === folder);
  const search = searchFolderOf(acct, folder);
  const folderId = search ? search.id : (live && live.id);
  const folderIdAttr = folderId ? ` data-folder-id="${esc(folderId)}"` : "";
  const catAttr = isCategoryBox(folder) ? ` data-cat-name="${esc(categoryNameOf(folder))}"` : "";
  return `<button class="nav-item fav" type="button" data-acct="${esc(acct)}" data-box="${esc(folder)}"${folderIdAttr}${catAttr} aria-current="${current}" title="${esc(acctObj.name)} ${esc(label)}">
    ${folderIcon(folder, acct)}
    <span class="fav-copy"><span class="fav-name">${esc(label)}</span><span class="meta">${esc(acctObj.name)}</span></span>
    <span class="count">${count || ""}</span>
  </button>`;
}

const hiddenCal = new Set();
const dismissedLive = new Set();

function nextAccountColor() {
  const used = new Set(Object.values(accounts).map(acct => acct.cls));
  const free = accountPalette.find(([cls]) => !used.has(cls));
  return free ? free[0] : "plum";
}

function accountIdFor(name) {
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "account";
  const base = id;
  let n = 2;
  while (accounts[id]) {
    id = base + "-" + n;
    n += 1;
  }
  return id;
}

function syncAccountChoices() {
  const select = document.getElementById("search-account");
  if (!select) return;
  if (searchAccount && !accountInProfile(searchAccount)) searchAccount = "";
  const current = searchAccount;
  select.innerHTML = `<option value="">Any account</option>` + profileEntries().map(([id, acct]) =>
    `<option value="${esc(id)}"${id === current ? " selected" : ""}>${esc(acct.name)}</option>`
  ).join("");
}

function addAccount(fields) {
  const yourName = String(fields.yourName || "").trim();
  const email = String(fields.email || "").trim();
  let name = String(fields.name || "").trim();
  let cls = fields.cls;
  if (!yourName) return "Enter your name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter an email address.";
  if (!name) name = email;
  if (emailInUse(email)) return "That email is already on an account.";
  if (!accountPalette.some(([id]) => id === cls)) cls = nextAccountColor();
  const id = accountIdFor(name);
  const emailId = "mail-" + id;
  const calId = "cal-" + id;
  accounts[id] = {
    name,
    email,
    cls,
    yourName,
    emails: [{ id: emailId, address: email }],
    calendars: [{ id: calId, name: "Calendar", cls }]
  };
  syncAccountChoices();
  return { id };
}

function dropWhere(list, id) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].account === id) list.splice(i, 1);
  }
}

function removeAccount(id) {
  const acct = accounts[id];
  if (!acct) return;
  if (acct.signedIn) {
    authProblem = "";
    const job = tauriInvoke("sign_out", { email: acct.email });
    if (job && job.catch) job.catch(() => {});
  }
  consentAgain.delete(id);
  delete directorySync[id];
  forgetAccount(id, acct.email);
  (acct.calendars || []).forEach(cal => hiddenCal.delete(cal.id));
  hiddenCal.delete(id);
  delete accounts[id];
  collapsedSections.delete(id);
  [...collapsedFolders].forEach(key => {
    if (String(key).startsWith(id + "\n")) collapsedFolders.delete(key);
  });
  rememberMailCollapse();
  signatures = signatures.filter(item => item.account !== id);
  rememberSignatures();
  dropWhere(messages, id);
  // Its queued mail goes with it: a later account given the same id must
  // never send it.
  rememberOutbox();
  saveFollowUps(loadFollowUps().filter(item => item.account !== id));
  dropWhere(events, id);
  dropWhere(allday, id);
  dropWhere(contacts, id);
  favorites = favorites.filter(item => item.account !== id);
  rememberFavorites();
  if (folderPick === "fav" && account === id) folderPick = "folder";
  if (account === id) account = "all";
  if (contactAccount === id) contactAccount = "all";
  if (searchAccount === id) searchAccount = "";
  if (replyDraft && !messages.some(m => m.id === replyDraft.draftId || m.id === replyDraft.msgId)) replyDraft = null;
  const visible = conversations();
  if (!visible.some(c => c.messages.some(m => m.id === selected))) {
    selected = visible[0]?.latest.id || null;
    expanded.clear();
      folded.clear();
  }
  if (!contacts.some(c => c.id === selectedContact)) selectedContact = contacts[0]?.id || null;
  settleDefaults();
  rememberDefaults();
  syncAccountChoices();
  refreshAuthBanner();
  toast(acct.name + " removed");
  render();
  if (!Object.keys(accounts).length) openAddAccountPopup();
}

function confirmRemoveAccount(id) {
  const acct = accounts[id];
  if (!acct) return;
  popRoot.innerHTML = `
    <div class="backdrop" id="backdrop"></div>
    <form class="dialog" id="remove-account">
      <h2>Remove ${esc(acct.name)}?</h2>
      <p class="dialog-note">Mail, calendars, and contacts on this account are removed with it.</p>
      <div class="dialog-actions">
        <button class="ghost" type="button" id="cancel">Cancel</button>
        <button class="primary danger" type="submit">Remove</button>
      </div>
    </form>`;
  document.getElementById("backdrop").onclick = closePop;
  document.getElementById("cancel").onclick = closePop;
  document.getElementById("remove-account").onsubmit = (e) => {
    e.preventDefault();
    closePop();
    removeAccount(id);
  };
}

function showSettings(page) {
  settingsPage = page;
  setView("settings");
}

function signatureRecord(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || "").trim();
  const name = String(item.name || "").trim();
  const account = String(item.account || "").trim();
  const body = signatureSource(String(item.body || ""));
  if (!id || !name || !account || !body.trim()) return null;
  if (id.length > 80 || name.length > 80 || account.length > 80 || body.length > 500000) return null;
  if (inDesktop() && sampleAccountIds.has(account)) return null;
  return { id, name, account, scope: item.scope === "all" ? "all" : "new", body };
}

function writeSignatures(list) {
  const rows = list.map(signatureRecord).filter(Boolean);
  try {
    localStorage.setItem("mailroom-signatures", JSON.stringify(rows));
    return "";
  } catch (e) {
    return "That signature is too large to keep on this computer.";
  }
}

function rememberSignatures() {
  return writeSignatures(signatures);
}

function restoreSignatures() {
  let raw = null;
  try { raw = localStorage.getItem("mailroom-signatures"); } catch (e) { return; }
  if (raw == null) return;
  let parsed = [];
  try { parsed = JSON.parse(raw); } catch (e) { return; }
  if (!Array.isArray(parsed)) return;
  const rows = [];
  parsed.forEach(item => {
    const next = signatureRecord(item);
    if (!next || rows.some(entry => entry.id === next.id)) return;
    rows.push(next);
  });
  signatures = rows;
}

function saveSignature(sig) {
  const name = String(sig.name || "").trim();
  const accountId = sig.account;
  const scope = sig.scope === "all" ? "all" : "new";
  const body = signatureSource(String(sig.body || ""));
  if (!name) return "Enter a name.";
  if (!accounts[accountId]) return "Choose an account.";
  if (!body.trim()) return "Enter the signature.";
  const clash = signatures.some(item => item.id !== sig.id && item.account === accountId && item.name.toLowerCase() === name.toLowerCase());
  if (clash) return "That account already has a signature with this name.";
  const next = { name, account: accountId, scope, body };
  const nextList = signatures.map(item => ({ id: item.id, name: item.name, account: item.account, scope: item.scope, body: item.body }));
  const existing = sig.id && nextList.find(item => item.id === sig.id);
  if (existing) Object.assign(existing, next);
  else nextList.push({ id: "sig-" + Date.now(), ...next });
  const problem = writeSignatures(nextList);
  if (problem) return problem;
  signatures = nextList;
  document.querySelectorAll("#compose-form").forEach(form => paintComposeSignature(form, true));
  return "";
}

function removeSignature(id) {
  const index = signatures.findIndex(item => item.id === id);
  if (index < 0) return;
  const nextList = signatures.filter(item => item.id !== id);
  const problem = writeSignatures(nextList);
  if (problem) {
    toast(problem);
    return;
  }
  signatures = nextList;
  document.querySelectorAll("#compose-form").forEach(form => paintComposeSignature(form, true));
  toast("Signature removed");
  settingsPage = "signatures";
  render();
}

function bindSignatureField(layer) {
  const body = layer.querySelector("#sig-body");
  const live = layer.querySelector("#sig-live");
  function paint() {
    const html = body.value.trim();
    mountSignature(live, html);
    live.classList.toggle("empty", !html);
  }
  body.addEventListener("input", paint);
  body.addEventListener("paste", (e) => {
    const data = e.clipboardData;
    if (!data) return;
    const html = data.getData("text/html");
    const text = data.getData("text/plain");
    if (!html || /<[a-z!/]/i.test(text)) return;
    e.preventDefault();
    const fragment = signatureFromClipboard(html);
    const start = body.selectionStart;
    const end = body.selectionEnd;
    body.value = body.value.slice(0, start) + fragment + body.value.slice(end);
    body.selectionStart = body.selectionEnd = start + fragment.length;
    paint();
  });
  paint();
}

function renderSettings() {
  const body = document.getElementById("settings-body");
  const title = document.getElementById("settings-title");
  const accountTitle = accounts[settingsAccountId] ? accounts[settingsAccountId].name : "Account";
  const titles = { accounts: "Accounts", "add-account": "Add an account", account: accountTitle, mail: "Mail", calendar: "Calendar", assistants: "Assistants", signatures: "Signatures", signature: settingsSigId ? "Edit signature" : "New signature", "safe-senders": "Safe senders", "auto-reply": "Automatic replies", rules: "Rules", software: "Software", templates: "Templates", omarchy: "Omarchy" };
  if (title) title.textContent = titles[settingsPage] || "Accounts";
  if (settingsPage === "add-account") renderAddAccount(body);
  else if (settingsPage === "account") renderAccountSettings(body);
  else if (settingsPage === "mail") renderMailSettings(body);
  else if (settingsPage === "calendar") renderCalendarSettings(body);
  else if (settingsPage === "assistants") renderAssistants(body);
  else if (settingsPage === "templates") renderTemplates(body);
  else if (settingsPage === "signatures") renderSignatureList(body);
  else if (settingsPage === "signature") renderSignatureForm(body);
  else if (settingsPage === "safe-senders") renderSafeSenders(body);
  else if (settingsPage === "auto-reply") renderAutoReplies(body);
  else if (settingsPage === "rules") renderRules(body);
  else if (settingsPage === "software") renderSoftware(body);
  else if (settingsPage === "omarchy") renderOmarchySettings(body);
  else renderAccountList(body);
}

const MAILBOX_ZONES = [
  ["Pacific Time (British Columbia)", "Pacific Time (British Columbia)"],
  ["Mountain Time (Alberta)", "Mountain Time (Alberta)"],
  ["Manitoba", "Manitoba"]
];

function renderCalendarSettings(body) {
  const computer = calendarZone();
  const rows = Object.entries(accounts).filter(([, acct]) => acct.signedIn && acct.email && acct.provider !== "google");
  body.innerHTML = `
    <p class="field-hint">This computer is set to ${esc(computer)}. New events use that zone. British Columbia and Alberta need tzdata 2026b or later.</p>
    ${rows.length ? rows.map(([id, acct]) => `
      <div class="acct-card zone-card" data-zone-account="${esc(id)}">
        <span class="acct-copy"><span class="who">${esc(acct.name)}</span><span class="meta" data-zone-now>Reading the mailbox time zone…</span></span>
        <label class="acct-default">Mailbox time zone
          <select data-zone-pick aria-label="Mailbox time zone for ${esc(acct.name)}"></select>
        </label>
        <button class="ghost" type="button" data-zone-computer hidden>Use this computer's time zone</button>
      </div>`).join("") : `<p class="empty-accounts">Sign in to a Microsoft account to set its mailbox time zone.</p>`}
  `;
  rows.forEach(([id, acct]) => {
    const card = body.querySelector(`[data-zone-account="${CSS.escape(id)}"]`);
    if (!card) return;
    const note = card.querySelector("[data-zone-now]");
    const pick = card.querySelector("[data-zone-pick]");
    const use = card.querySelector("[data-zone-computer]");
    const paint = zone => {
      const current = String(zone || "").trim();
      const options = MAILBOX_ZONES.slice();
      if (current && !options.some(item => item[0] === current)) options.unshift([current, current]);
      if (computer && !options.some(item => item[0] === computer)) options.push([computer, computer + " (this computer)"]);
      pick.innerHTML = options.map(([value, label]) => `<option value="${esc(value)}"${value === current ? " selected" : ""}>${esc(label)}</option>`).join("");
      pick.dataset.zone = current;
      note.textContent = current ? "Mailbox time zone: " + current : "No mailbox time zone is set.";
      use.hidden = !current || current === computer;
    };
    pick.onchange = async () => {
      const previous = pick.dataset.zone || "";
      try {
        await tauriInvoke("set_mailbox_zone", { email: acct.email, zone: pick.value });
        paint(pick.value);
        toast("Mailbox time zone updated");
      } catch (err) {
        paint(previous);
        toast(String(err && err.message || err || "The time zone could not be saved."));
      }
    };
    use.onclick = async () => {
      pick.value = [...pick.options].some(opt => opt.value === computer) ? computer : pick.value;
      if (![...pick.options].some(opt => opt.value === computer)) return;
      pick.onchange();
    };
    if (!inDesktop()) {
      note.textContent = "The mailbox time zone is available once Mailroom is signed in.";
      pick.disabled = true;
      return;
    }
    tauriInvoke("mailbox_zone", { email: acct.email }).then(zone => {
      if (settingsPage === "calendar") paint(zone);
    }).catch(err => {
      if (settingsPage === "calendar") note.textContent = String(err && err.message || err || "The time zone could not be read.");
    });
  });
}

function renderAccountList(body) {
  const several = Object.keys(accounts).length > 1;
  const email = activeDefaultEmail();
  const calendar = activeDefaultCalendar();
  body.innerHTML = `
    <div class="acct-defaults client-id-block" id="client-id-block" hidden>
      <label class="acct-default" for="client-id">Client id</label>
      <span class="client-id-row">
        <input id="client-id" autocomplete="off" spellcheck="false" aria-label="Client id">
        <button class="ghost" type="button" id="save-client-id" disabled>Save</button>
      </span>
      <span class="field-hint">The Entra application id for this computer. Not a secret.</span>
      <p class="form-error" id="client-id-error" hidden></p>
    </div>
    <div class="acct-defaults client-id-block" id="google-client-block" hidden>
      <label class="acct-default" for="google-client-id">Google client</label>
      <span class="client-id-row">
        <input id="google-client-id" autocomplete="off" spellcheck="false" aria-label="Google client ID" placeholder="Client ID">
        <input id="google-client-secret" autocomplete="off" spellcheck="false" aria-label="Google client secret" placeholder="Client secret">
        <button class="ghost" type="button" id="save-google-client" disabled>Save</button>
      </span>
      <span class="field-hint">Google accounts sign in through your own OAuth client in Google Cloud, of the Desktop app type. Paste its client ID and secret, or paste the whole JSON file Google lets you download into the Client ID box.</span>
      <p class="form-error" id="google-client-error" hidden></p>
    </div>
    ${several ? `
      <div class="acct-defaults global-defaults">
        <label class="acct-default">Default email
          <select id="default-email">
            ${allEmails().map(row => `<option value="${esc(row.id)}"${email && row.id === email.id ? " selected" : ""}>${esc(row.acct.name)} · ${esc(row.address)}</option>`).join("")}
          </select>
          <span class="field-hint">Used for new mail.</span>
        </label>
        <label class="acct-default">Default calendar
          <select id="default-calendar">
            ${allCalendars().map(row => `<option value="${esc(row.id)}"${calendar && row.id === calendar.id ? " selected" : ""}>${esc(row.acct.name)} · ${esc(row.name)}</option>`).join("")}
          </select>
          <span class="field-hint">New events and invites go here.</span>
        </label>
        <div class="dialog-actions defaults-actions">
          <button class="ghost" type="button" id="defaults-discard" disabled>Discard</button>
          <button class="primary" type="button" id="defaults-save" disabled>Save</button>
        </div>
      </div>` : ""}
    <div class="settings-actions">
      <button class="primary" type="button" id="add-account-page">Add account</button>
    </div>
    <div class="acct-cards">
      ${Object.keys(accounts).length ? "" : `<p class="empty-accounts">No accounts.</p>`}
      ${Object.entries(accounts).map(([id, acct]) => `
        <div class="acct-card account-card">
          <button class="acct-open" type="button" data-open-account="${esc(id)}">
            <span class="dot ${acct.cls}" aria-hidden="true"></span>
            <span class="acct-copy">
              <span class="who">${esc(acct.name)}</span>
              <span class="meta">${esc(acct.yourName || "Jon")}</span>
              <span class="meta">${esc((acct.emails && acct.emails[0] && acct.emails[0].address) || acct.email || "")}</span>
            </span>
          </button>
          <div class="seg profile-seg" role="group" aria-label="Profile for ${esc(acct.name)}">
            <button type="button" data-account-profile="${esc(id)}" data-profile="work" aria-pressed="${accountProfile(id) === "work"}">Work</button>
            <button type="button" data-account-profile="${esc(id)}" data-profile="personal" aria-pressed="${accountProfile(id) === "personal"}">Personal</button>
          </div>
          <span class="acct-actions">
            ${accountNeedsSignIn(id) ? `<button class="primary" type="button" data-sign-in="${esc(id)}">Sign in</button>` : ""}
            <button class="ghost" type="button" data-remove="${esc(id)}">Remove</button>
          </span>
        </div>
      `).join("")}
    </div>`;
  body.querySelector("#add-account-page").onclick = () => { settingsPage = "add-account"; render(); };
  body.querySelectorAll("[data-open-account]").forEach(btn => {
    btn.onclick = () => openAccount(btn.dataset.openAccount);
  });
  body.querySelectorAll("[data-sign-in]").forEach(btn => {
    btn.onclick = () => signInAccount(btn.dataset.signIn);
  });
  body.querySelectorAll("[data-remove]").forEach(btn => {
    btn.onclick = () => confirmRemoveAccount(btn.dataset.remove);
  });
  body.querySelectorAll("[data-account-profile]").forEach(btn => {
    btn.onclick = () => setAccountProfile(btn.dataset.accountProfile, btn.dataset.profile);
  });
  const emailSelect = body.querySelector("#default-email");
  const calendarSelect = body.querySelector("#default-calendar");
  const saveDefaults = body.querySelector("#defaults-save");
  const discardDefaults = body.querySelector("#defaults-discard");
  if (emailSelect && calendarSelect && saveDefaults && discardDefaults) {
    const paintDefaults = () => {
      const dirty = emailSelect.value !== defaultEmailId || calendarSelect.value !== defaultCalendarId;
      saveDefaults.disabled = !dirty;
      discardDefaults.disabled = !dirty;
    };
    emailSelect.onchange = paintDefaults;
    calendarSelect.onchange = paintDefaults;
    discardDefaults.onclick = () => {
      emailSelect.value = defaultEmailId;
      calendarSelect.value = defaultCalendarId;
      paintDefaults();
    };
    saveDefaults.onclick = () => {
      defaultEmailId = emailSelect.value;
      defaultCalendarId = calendarSelect.value;
      settleDefaults();
      rememberDefaults();
      emailSelect.value = defaultEmailId;
      calendarSelect.value = defaultCalendarId;
      paintDefaults();
      toast("Defaults saved");
    };
    paintDefaults();
  }
  bindClientId(body);
}

function bindGoogleClient(body) {
  const block = body.querySelector("#google-client-block");
  if (!block || !inDesktop()) return;
  block.hidden = false;
  const id = body.querySelector("#google-client-id");
  const secret = body.querySelector("#google-client-secret");
  const note = body.querySelector("#google-client-error");
  const button = body.querySelector("#save-google-client");
  let accepted = "";
  const paint = () => {
    const same = id.value.trim() === accepted && !secret.value.trim();
    button.disabled = same || !id.value.trim();
    button.textContent = same && accepted ? "Saved" : "Save";
  };
  id.addEventListener("input", paint);
  secret.addEventListener("input", paint);
  Promise.resolve(tauriInvoke("google_client_id")).then(saved => {
    if (!document.body.contains(id)) return;
    accepted = saved || "";
    id.value = accepted;
    paint();
  }).catch(() => {});
  button.onclick = async () => {
    note.hidden = true;
    button.disabled = true;
    try {
      accepted = await tauriInvoke("save_google_client", { id: id.value.trim(), secret: secret.value.trim() }) || id.value.trim();
      if (!document.body.contains(id)) return;
      id.value = accepted;
      secret.value = "";
      toast("Google client saved");
    } catch (err) {
      if (!document.body.contains(note)) return;
      note.hidden = false;
      note.textContent = String(err && err.message || err);
    } finally {
      if (document.body.contains(button)) paint();
    }
  };
}

function bindClientId(body) {
  bindGoogleClient(body);
  const block = body.querySelector("#client-id-block");
  if (!block || !inDesktop()) return;
  block.hidden = false;
  const input = body.querySelector("#client-id");
  const note = body.querySelector("#client-id-error");
  const button = body.querySelector("#save-client-id");
  let accepted = "";
  function paintSave() {
    const same = input.value.trim() === accepted && accepted !== "";
    button.disabled = same;
    button.textContent = same ? "Saved" : "Save";
  }
  input.addEventListener("input", paintSave);
  const loaded = tauriInvoke("client_id");
  if (loaded && loaded.then) {
    loaded.then(id => {
      if (!document.body.contains(input)) return;
      accepted = id || "";
      input.value = accepted;
      paintSave();
    }).catch(() => { if (document.body.contains(button)) paintSave(); });
  }
  button.onclick = async () => {
    note.hidden = true;
    button.disabled = true;
    try {
      const saved = await tauriInvoke("save_client_id", { id: input.value.trim() });
      if (!document.body.contains(input)) return;
      accepted = saved || input.value.trim();
      input.value = accepted;
      if (authProblem === "Microsoft sign-in is not set up on this computer yet.") {
        authProblem = "";
        refreshAuthBanner();
      }
      toast("Client id saved");
    } catch (err) {
      if (!document.body.contains(note)) return;
      note.hidden = false;
      note.textContent = String(err && err.message || err);
    } finally {
      if (document.body.contains(button)) paintSave();
    }
  };
}

function addAccountFormHtml() {
  const picked = nextAccountColor();
  return `
    <form class="add-account" id="add-account" novalidate data-provider="microsoft">
      <div class="field">Account type
        <div class="seg provider-seg" role="group" aria-label="Account type">
          <button type="button" data-provider="microsoft" aria-pressed="true">Microsoft 365 or Outlook.com</button>
          <button type="button" data-provider="google" aria-pressed="false">Google</button>
        </div>
      </div>
      <label class="field">Your name
        <input name="yourName" value="Jon" autocomplete="name">
        <span class="field-hint">The name on mail you send.</span>
      </label>
      <label class="field">Email address
        <input name="email" type="email" autocomplete="off">
      </label>
      <label class="field">Account name
        <input name="name" autocomplete="off">
        <span class="field-hint">Shown in the folder list. Leave this blank to use the email address.</span>
      </label>
      <div class="field">Colour
        <div class="swatches" role="radiogroup" aria-label="Colour">
          ${accountPalette.map(([cls, label]) => `
            <button class="swatch ${cls}" type="button" role="radio" aria-checked="${cls === picked ? "true" : "false"}" aria-label="${label}" data-color="${cls}"></button>
          `).join("")}
        </div>
      </div>
      <p class="form-error" id="account-error" hidden></p>
      <div class="dialog-actions">
        <button class="ghost" type="button" id="account-cancel">Cancel</button>
        <button class="primary" type="submit">Sign in</button>
      </div>
    </form>`;
}

function bindAddAccountForm(root, opts) {
  opts = opts || {};
  root.querySelectorAll(".swatch").forEach(btn => {
    btn.onclick = () => {
      root.querySelectorAll(".swatch").forEach(el => el.setAttribute("aria-checked", el === btn ? "true" : "false"));
    };
  });
  const cancel = root.querySelector("#account-cancel");
  if (cancel) cancel.onclick = () => {
    if (opts.onCancel) opts.onCancel();
    else { settingsPage = "accounts"; render(); }
  };
  const form = root.querySelector("#add-account");
  if (!form) return;
  // Sign-in needs your own app's client id: an Entra app for Microsoft, a
  // Google Cloud OAuth client for Google. On a new install, ask for it first,
  // in the same form.
  const offerClientStep = () => {
    if (!inDesktop()) return;
    const google = form.dataset.provider === "google";
    const existing = form.querySelector("#client-id-step");
    if (existing) existing.remove();
    Promise.resolve(tauriInvoke(google ? "google_client_id" : "client_id")).then(id => {
      if (String(id || "").trim() || form.querySelector("#client-id-step") || !document.body.contains(form)) return;
      if ((form.dataset.provider === "google") !== google) return;
      const anchor = form.querySelector(".provider-seg").closest(".field");
      anchor.insertAdjacentHTML("afterend", google ? `<div class="client-id-step" id="client-id-step" data-provider="google">
        <label class="field">Google client ID
          <input name="clientId" id="first-client-id" autocomplete="off" spellcheck="false" placeholder="1234-abc.apps.googleusercontent.com">
        </label>
        <label class="field">Client secret
          <input name="clientSecret" id="first-client-secret" autocomplete="off" spellcheck="false" placeholder="GOCSPX-…">
          <span class="field-hint">First, the one-time setup: Mailroom signs in through an OAuth client of the Desktop app kind that you make in Google Cloud, with the Gmail and Calendar APIs turned on. Paste its client ID and secret, or paste the whole downloaded JSON file into the first box. The About page has the steps.</span>
        </label>
      </div>` : `<div class="client-id-step" id="client-id-step" data-provider="microsoft">
        <label class="field">Microsoft app (client) ID
          <input name="clientId" id="first-client-id" autocomplete="off" spellcheck="false" placeholder="00000000-0000-0000-0000-000000000000">
          <span class="field-hint">First, the one-time setup: Mailroom signs in through an app you register in Microsoft Entra, with no secret. Paste its Application (client) ID. The About page has the steps.</span>
        </label>
      </div>`);
    }).catch(() => {});
  };
  form.querySelectorAll(".provider-seg [data-provider]").forEach(btn => {
    btn.onclick = () => {
      form.dataset.provider = btn.dataset.provider;
      form.querySelectorAll(".provider-seg [data-provider]").forEach(other => other.setAttribute("aria-pressed", other === btn ? "true" : "false"));
      offerClientStep();
    };
  });
  offerClientStep();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    const color = root.querySelector(".swatch[aria-checked='true']").dataset.color;
    const fields = {
      yourName: data.get("yourName"),
      name: data.get("name"),
      email: data.get("email"),
      cls: color
    };
    const note = root.querySelector("#account-error");
    const showError = (text) => {
      if (!note) return;
      note.hidden = false;
      note.textContent = text;
    };
    if (note) note.hidden = true;
    const desktop = !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
    if (!desktop) {
      const result = addAccount(fields);
      if (typeof result === "string") {
        showError(result);
        return;
      }
      toast("Account added");
      if (opts.onAdded) opts.onAdded(result.id);
      else openAccount(result.id);
      return;
    }
    const yourName = String(fields.yourName || "").trim();
    const email = String(fields.email || "").trim();
    if (!yourName) { showError("Enter your name."); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showError("Enter an email address."); return; }
    if (emailInUse(email)) { showError("That email is already on an account."); return; }
    const provider = form.dataset.provider === "google" ? "google" : "microsoft";
    const step = form.querySelector("#client-id-step");
    if (step) {
      const raw = String(form.querySelector("#first-client-id").value || "").trim();
      if (!raw) { showError("Paste your app's client ID first."); form.querySelector("#first-client-id").focus(); return; }
      try {
        if (provider === "google") {
          const secret = String((form.querySelector("#first-client-secret") || {}).value || "").trim();
          await tauriInvoke("save_google_client", { id: raw, secret });
        } else {
          await tauriInvoke("save_client_id", { id: raw });
        }
      } catch (err) {
        showError(String(err && err.message || err || "That client ID could not be saved."));
        return;
      }
      step.remove();
    }
    const submit = e.target.querySelector("[type=submit]");
    submit.disabled = true;
    submit.textContent = provider === "google" ? "Waiting for Google…" : "Waiting for Microsoft…";
    try {
      const status = await tauriInvoke("sign_in", { loginHint: String(fields.email || "").trim(), provider });
      if (!status || !status.signedIn) throw new Error("The sign-in could not be saved on this computer.");
      // Sign-in is done; the first sync can take a while, so say so.
      submit.textContent = "Signed in. Loading your mail…";
      const signedEmail = (status && status.email) || fields.email;
      const inbox = await tauriInvoke("sync_inbox", { email: signedEmail, since: syncSinceIso() });
      const mailbox = (inbox && inbox.email) || signedEmail;
      const result = addAccount({ ...fields, email: mailbox });
      if (typeof result !== "string" && accounts[result.id]) {
        accounts[result.id].provider = provider;
        accounts[result.id].profile = provider === "google" ? "personal" : "work";
      }
      if (typeof result === "string") {
        authProblem = "";
        const job = tauriInvoke("sign_out", { email: mailbox });
        if (job && job.catch) job.catch(() => {});
        refreshAuthBanner();
        showError(result);
        return;
      }
      authProblem = "";
      accounts[result.id].signedIn = true;
      applySignIn(status);
      rememberAccount(result.id);
      refreshAuthBanner();
      fillAccountMail(result.id, inbox);
      await loadCachedDrafts(result.id);
      // The address book fills in behind; the mail is ready now.
      Promise.resolve(syncAccountDirectory(result.id, false)).catch(() => {});
      toast("Account added");
      activeProfile = accountProfile(result.id);
      rememberActiveProfile();
      account = result.id;
      box = "inbox";
      folderPick = "folder";
      selected = messages.find(item => item.account === result.id)?.id || null;
      if (opts.onAdded) opts.onAdded(result.id);
      else setView("mail");
    } catch (err) {
      const message = String(err && err.message || err);
      if (Object.keys(accounts).length) {
        authProblem = message;
        refreshAuthBanner();
      }
      showError(message);
    } finally {
      if (document.body.contains(submit)) {
        submit.disabled = false;
        submit.textContent = "Sign in";
      }
    }
  };
}

function renderAddAccount(body) {
  body.innerHTML = addAccountFormHtml();
  bindAddAccountForm(body);
}

let addAccountKey = null;

function closeAddAccountPopup() {
  if (addAccountKey) document.removeEventListener("keydown", addAccountKey);
  addAccountKey = null;
  if (popRoot.querySelector("#add-account-popup")) closePop();
}

function openAddAccountPopup() {
  if (!inDesktop() || popCompose || assistWindow || Object.keys(accounts).length) return;
  if (popRoot.querySelector("#add-account-popup")) return;
  if (addAccountKey) document.removeEventListener("keydown", addAccountKey);
  popRoot.innerHTML = `
    <div class="backdrop dim" id="backdrop"></div>
    <div class="dialog add-account-dialog" id="add-account-popup" role="dialog" aria-modal="true" aria-labelledby="add-account-title">
      <h2 id="add-account-title">Add an account</h2>
      ${addAccountFormHtml()}
    </div>`;
  addAccountKey = (ev) => {
    if (ev.key === "Escape") closeAddAccountPopup();
  };
  document.addEventListener("keydown", addAccountKey);
  document.getElementById("backdrop").onclick = closeAddAccountPopup;
  bindAddAccountForm(popRoot, {
    onCancel: closeAddAccountPopup,
    onAdded: () => {
      closeAddAccountPopup();
      setView("mail");
    }
  });
  const email = popRoot.querySelector("[name=email]");
  if (email) email.focus();
}

function openAccount(id) {
  if (!accounts[id]) {
    settingsPage = "accounts";
    render();
    return;
  }
  settingsAccountId = id;
  settingsPage = "account";
  render();
}

function accountDraft(acct) {
  return {
    yourName: acct.yourName || "",
    name: acct.name || "",
    cls: acct.cls,
    emailId: (acct.emails && acct.emails[0] && acct.emails[0].id) || "",
    email: (acct.emails && acct.emails[0] && acct.emails[0].address) || acct.email || "",
    calendars: (acct.calendars || []).map(cal => ({ id: cal.id, name: cal.name, cls: cal.cls }))
  };
}

function readAccountDraft(form) {
  const email = form.email;
  return {
    yourName: form.yourName.value,
    name: form.name.value,
    cls: form.querySelector("[data-account-colour] .swatch[aria-checked='true']").dataset.color,
    emailId: email.dataset.emailId,
    email: email.value,
    calendars: [...form.querySelectorAll("[data-cal-row]")].map(row => ({
      id: row.dataset.calId,
      name: row.querySelector("input").value,
      cls: row.querySelector(".swatch[aria-checked='true']").dataset.color
    }))
  };
}

function saveAccount(id, draft) {
  const acct = accounts[id];
  if (!acct) return "That account is gone.";
  const yourName = String(draft.yourName || "").trim();
  let name = String(draft.name || "").trim();
  if (!yourName) return "Enter your name.";
  if (!accountPalette.some(([cls]) => cls === draft.cls)) draft.cls = acct.cls;
  const address = String(draft.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return "Enter an email address.";
  if (!name) name = address;
  if (emailInUse(address, id)) return "That email is already on an account.";
  const emailId = draft.emailId || ((acct.emails[0] && acct.emails[0].id) || "mail-" + id);
  const calendars = (draft.calendars || []).map((cal, index) => {
    const previous = String(cal.id || "");
    const nextId = previous.startsWith("new-") ? "cal-" + id + "-" + Date.now() + "-" + index : previous;
    if (nextId !== previous && hiddenCal.has(previous)) {
      hiddenCal.delete(previous);
      hiddenCal.add(nextId);
    }
    return {
      id: nextId,
      name: String(cal.name || "").trim(),
      cls: calendarPalette.some(([cls]) => cls === cal.cls) ? cal.cls : nextCalendarColor(id),
      colourChosen: true
    };
  });
  if (!calendars.length) return "Add a calendar.";
  for (const cal of calendars) {
    if (!cal.name) return "Enter a calendar name.";
  }
  acct.yourName = yourName;
  acct.name = name;
  acct.cls = draft.cls;
  acct.emails = [{ id: emailId, address }];
  acct.calendars = calendars;
  settleDefaults();
  rememberDefaults();
  syncAccountChoices();
  rememberAccount(id);
  return "";
}

function renderAccountSettings(body, draft) {
  const acct = accounts[settingsAccountId];
  if (!acct) {
    settingsPage = "accounts";
    renderAccountList(body);
    return;
  }
  const current = draft || accountDraft(acct);
  const colour = accountPalette.some(([cls]) => cls === current.cls) ? current.cls : acct.cls;
  body.innerHTML = `
    <form class="add-account account-form" id="account-form">
      <label class="field">Your name
        <input name="yourName" value="${esc(current.yourName)}" autocomplete="name">
        <span class="field-hint">The name on mail you send.</span>
      </label>
      <label class="field">Email address
        <input name="email" type="email" data-email-id="${esc(current.emailId)}" value="${esc(current.email)}" autocomplete="off">
      </label>
      <label class="field">Account name
        <input name="name" value="${esc(current.name)}" autocomplete="off">
        <span class="field-hint">Shown in the folder list. Leave this blank to use the email address.</span>
      </label>
      <div class="field">Colour
        <div class="swatches" role="radiogroup" aria-label="Colour" data-account-colour>
          ${accountPalette.map(([cls, label]) => `
            <button class="swatch ${cls}" type="button" role="radio" aria-checked="${cls === colour ? "true" : "false"}" aria-label="${label}" data-color="${cls}"></button>
          `).join("")}
        </div>
      </div>
      <h2>Calendars</h2>
      <p class="field-hint cal-hint">Hide a calendar to take it off the week. Its events stay.</p>
      ${current.calendars.map(cal => {
        const shown = !hiddenCal.has(cal.id);
        return `
        <div class="stack-row cal-row${shown ? "" : " is-hidden"}" data-cal-row data-cal-id="${esc(cal.id)}">
          <input value="${esc(cal.name)}" aria-label="Calendar name" autocomplete="off">
          <div class="swatches" role="radiogroup" aria-label="Calendar colour">
            ${calendarPalette.map(([cls, label]) => `
              <button class="swatch ${cls}" type="button" role="radio" aria-checked="${cls === cal.cls ? "true" : "false"}" aria-label="${label}" data-color="${cls}"></button>
            `).join("")}
          </div>
          <button class="ghost cal-vis" type="button" data-cal-vis aria-pressed="${shown ? "true" : "false"}"><span class="vis-hide">Hide</span><span class="vis-show">Show</span></button>
        </div>`;
      }).join("")}
      <button class="ghost" type="button" id="add-calendar">Add calendar</button>
      <p class="form-error" id="account-error" hidden></p>
      <div class="dialog-actions">
        ${accountNeedsSignIn(settingsAccountId) ? `<button class="primary" type="button" id="account-sign-in">Sign in</button>` : ""}
        <button class="ghost" type="button" id="account-cancel">Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>`;
  body.querySelectorAll("[role=radiogroup]").forEach(group => {
    group.querySelectorAll(".swatch").forEach(btn => {
      btn.onclick = () => {
        group.querySelectorAll(".swatch").forEach(el => el.setAttribute("aria-checked", el === btn ? "true" : "false"));
      };
    });
  });
  body.querySelector("#account-cancel").onclick = () => { settingsPage = "accounts"; render(); };
  const accountSignIn = body.querySelector("#account-sign-in");
  if (accountSignIn) accountSignIn.onclick = () => signInAccount(settingsAccountId);
  body.querySelector("#add-calendar").onclick = () => {
    const next = readAccountDraft(body.querySelector("#account-form"));
    const used = new Set(next.calendars.map(cal => cal.cls));
    const free = calendarPalette.find(([cls]) => !used.has(cls));
    next.calendars.push({ id: "new-cal-" + Date.now(), name: "", cls: free ? free[0] : "plum", colourChosen: true });
    renderAccountSettings(body, next);
  };
  body.querySelectorAll("[data-cal-vis]").forEach(btn => {
    btn.onclick = () => {
      const row = btn.closest("[data-cal-row]");
      const calId = row.dataset.calId;
      if (hiddenCal.has(calId)) hiddenCal.delete(calId);
      else hiddenCal.add(calId);
      const shown = !hiddenCal.has(calId);
      btn.setAttribute("aria-pressed", shown ? "true" : "false");
      row.classList.toggle("is-hidden", !shown);
    };
  });
  body.querySelector("#account-form").onsubmit = (e) => {
    e.preventDefault();
    const error = saveAccount(settingsAccountId, readAccountDraft(e.target));
    const note = document.getElementById("account-error");
    if (error) {
      note.hidden = false;
      note.textContent = error;
      return;
    }
    toast("Account saved");
    settingsPage = "accounts";
    render();
  };
}

function renderSignatureList(body) {
  const cards = signatures.map(item => {
    const acct = accounts[item.account];
    return `
      <div class="acct-card sig-card">
        <div class="sig-head">
          <span class="acct-copy">
            <span class="who">${esc(item.name)}</span>
            <span class="meta">${esc(acct ? acct.name : "Account")} · ${esc(scopeLabel(item.scope))}</span>
          </span>
          <div class="sig-actions">
            <button class="ghost" type="button" data-edit-sig="${esc(item.id)}">Edit</button>
            <button class="ghost" type="button" data-remove-sig="${esc(item.id)}">Remove</button>
          </div>
        </div>
        <div class="sig-live" data-sig-preview="${esc(item.id)}"></div>
      </div>`;
  }).join("");
  body.innerHTML = `
    ${signatures.length ? `<div class="acct-cards">${cards}</div>` : `<p class="empty-accounts">No signatures.</p>`}
    <div class="settings-actions">
      <button class="primary" type="button" id="add-signature">Add signature</button>
    </div>`;
  body.querySelectorAll("[data-sig-preview]").forEach(el => {
    const item = signatures.find(sig => sig.id === el.dataset.sigPreview);
    if (item) mountSignature(el, item.body);
  });
  body.querySelector("#add-signature").onclick = () => {
    settingsSigId = "";
    settingsPage = "signature";
    render();
  };
  body.querySelectorAll("[data-edit-sig]").forEach(btn => {
    btn.onclick = () => {
      settingsSigId = btn.dataset.editSig;
      settingsPage = "signature";
      render();
    };
  });
  body.querySelectorAll("[data-remove-sig]").forEach(btn => {
    btn.onclick = () => removeSignature(btn.dataset.removeSig);
  });
}

function renderSignatureForm(body) {
  const current = signatures.find(item => item.id === settingsSigId) || { name: "", account: Object.keys(accounts)[0] || "", scope: "new", body: "" };
  body.innerHTML = `
    <form class="add-account" id="sig-form">
      <label class="field">Name
        <input id="sig-name" value="${esc(current.name)}" autocomplete="off">
      </label>
      <label class="field">Account
        <select id="sig-account">${Object.entries(accounts).map(([id, acct]) =>
          `<option value="${esc(id)}"${id === current.account ? " selected" : ""}>${esc(acct.name)}</option>`
        ).join("")}</select>
      </label>
      <label class="field">Use on
        <select id="sig-scope">
          <option value="new"${current.scope === "all" ? "" : " selected"}>New messages only</option>
          <option value="all"${current.scope === "all" ? " selected" : ""}>All emails</option>
        </select>
      </label>
      <label class="field">HTML
        <textarea id="sig-body" rows="6" spellcheck="false">${esc(current.body)}</textarea>
      </label>
      <div class="sig-live empty" id="sig-live"></div>
      <p class="form-error" id="signature-error" hidden></p>
      <div class="dialog-actions">
        <button class="ghost" type="button" id="sig-cancel">Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>`;
  bindSignatureField(body);
  body.querySelector("#sig-cancel").onclick = () => { settingsPage = "signatures"; render(); };
  body.querySelector("#sig-form").onsubmit = (e) => {
    e.preventDefault();
    const error = saveSignature({
      id: settingsSigId,
      name: body.querySelector("#sig-name").value,
      account: body.querySelector("#sig-account").value,
      scope: body.querySelector("#sig-scope").value,
      body: body.querySelector("#sig-body").value
    });
    const note = document.getElementById("signature-error");
    if (error) {
      note.hidden = false;
      note.textContent = error;
      return;
    }
    toast("Signature saved");
    settingsSigId = "";
    settingsPage = "signatures";
    render();
  };
}

function shownDateKey(date) {
  return date.getFullYear() + "-" + date.getMonth() + "-" + date.getDate();
}

function miniRange() {
  if (calView !== "month") return visibleDates();
  const start = startOfWeek(calFocus);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function miniCalendarMarkup() {
  const year = calFocus.getFullYear();
  const month = calFocus.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const cursor = startOfWeek(first);
  const range = new Set(miniRange().map(shownDateKey));
  const days = [];
  while (days.length < 42) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
    if (days.length % 7 === 0 && cursor > last) break;
  }
  const heads = ["M", "T", "W", "T", "F", "S", "S"].map(ch => `<div class="mini-dow">${ch}</div>`).join("");
  const cells = days.map((date, i) => {
    const key = shownDateKey(date);
    const outside = date.getMonth() !== month;
    const inRange = range.has(key);
    const prev = i > 0 && range.has(shownDateKey(days[i - 1]));
    const next = i < days.length - 1 && range.has(shownDateKey(days[i + 1]));
    const today = isToday(date);
    const cls = ["mini-day", outside ? "outside" : "", inRange ? "in-range" : "", inRange && !prev ? "range-start" : "", inRange && !next ? "range-end" : ""].filter(Boolean).join(" ");
    const iso = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
    const label = dowLong[date.getDay()] + " " + date.getDate() + " " + monthNames[date.getMonth()] + " " + date.getFullYear();
    return `<button class="${cls}" type="button" data-mini="${iso}" aria-label="${label}"${today ? ' aria-current="date"' : ""}${inRange ? ' aria-pressed="true"' : ""}><span class="n">${date.getDate()}</span></button>`;
  }).join("");
  return `<div class="mini-cal">
    <div class="mini-head">
      <span class="label">${monthNames[month]} ${year}</span>
      <button type="button" id="mini-prev" aria-label="Previous month"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5L5.5 8 10 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button type="button" id="mini-next" aria-label="Next month"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </div>
    <div class="mini-grid" aria-label="${monthNames[month]} ${year}">${heads}${cells}</div>
  </div>`;
}

function shiftMini(dir) {
  const d = new Date(calFocus.getFullYear(), calFocus.getMonth(), calFocus.getDate());
  d.setMonth(d.getMonth() + dir);
  calFocus = d;
  render();
}

function calendarToggleHtml(acct, cal) {
  const shown = !hiddenCal.has(cal.id);
  const label = calendarPillName(acct, cal);
  const owner = calendarIsShared(acct, cal) ? calendarOwnerLabel(cal) : "";
  const ownerBit = owner && owner !== label ? ` <span class="cal-owner">· ${esc(owner)}</span>` : "";
  const sharedTitle = cal.canEdit === false ? "Shared with you" + (owner ? " by " + owner : "") + " · read-only · " : (owner ? "Shared by " + owner + " · " : "");
  const lock = cal.canEdit === false ? `<span class="cal-ro" aria-label="Read-only"><svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><rect x="2.5" y="5.2" width="7" height="5.3" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4 5.2V3.9a2 2 0 014 0v1.3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></span>` : "";
  return `
    <div class="acct-item cal-toggle" data-cal="${esc(cal.id)}" aria-pressed="${shown ? "true" : "false"}">
      <button class="cal-dot" type="button" data-cal-dot="${esc(cal.id)}" aria-pressed="${shown ? "true" : "false"}" aria-label="${shown ? "Hide" : "Show"} ${esc(label)}"><span class="dot ${cal.cls}"></span></button>
      <button class="cal-name" type="button" data-cal-colour="${esc(cal.id)}" aria-haspopup="dialog" title="${esc(sharedTitle)}Change colour">${esc(label)}${ownerBit}${lock}</button>
    </div>`;
}

function calendarSidebarHtml() {
  const { own, shared } = calendarListParts();
  const keep = foldedCalendarIds();
  const listed = moreCalendarsOpen ? own : own.filter(row => keep.has(row.cal.id));
  const ownHtml = listed.map(row => calendarToggleHtml(row.acct, row.cal)).join("");
  const sharedHtml = moreCalendarsOpen && shared.length
    ? `<div class="acct-label quiet">Shared calendars</div>` + shared.map(row => calendarToggleHtml(row.acct, row.cal)).join("")
    : "";
  return ownHtml + sharedHtml;
}

function renderFolders() {
  if (view === "settings") {
    folders.innerHTML = `
      <div class="acct-label">Settings</div>
      <button class="nav-item" type="button" id="settings-accounts" aria-current="${settingsPage === "accounts" || settingsPage === "add-account" || settingsPage === "account"}">Accounts</button>
      <button class="nav-item" type="button" id="settings-mail" aria-current="${settingsPage === "mail"}">Mail</button>
      <button class="nav-item" type="button" id="settings-calendar" aria-current="${settingsPage === "calendar"}">Calendar</button>
      <button class="nav-item" type="button" id="settings-assistants" aria-current="${settingsPage === "assistants"}">Assistants</button>
      <button class="nav-item" type="button" id="settings-signatures" aria-current="${settingsPage === "signatures" || settingsPage === "signature"}">Signatures</button>
      <button class="nav-item" type="button" id="settings-templates" aria-current="${settingsPage === "templates"}">Templates</button>
      <button class="nav-item" type="button" id="settings-safe-senders" aria-current="${settingsPage === "safe-senders"}">Safe senders</button>
      <button class="nav-item" type="button" id="settings-auto-reply" aria-current="${settingsPage === "auto-reply"}">Automatic replies</button>
      <button class="nav-item" type="button" id="settings-rules" aria-current="${settingsPage === "rules"}">Rules</button>
      <button class="nav-item" type="button" id="settings-software" aria-current="${settingsPage === "software"}">Software${updateWaiting ? ' <span class="update-dot" title="An update is available"></span>' : ""}</button>
      ${omarchyLook ? `<button class="nav-item" type="button" id="settings-omarchy" aria-current="${settingsPage === "omarchy"}">Omarchy</button>` : ""}
    `;
    const omarchyNav = folders.querySelector("#settings-omarchy");
    if (omarchyNav) omarchyNav.onclick = () => { settingsPage = "omarchy"; render(); };
    folders.querySelector("#settings-software").onclick = () => { settingsPage = "software"; render(); };
    folders.querySelector("#settings-rules").onclick = () => { settingsPage = "rules"; render(); };
    folders.querySelector("#settings-auto-reply").onclick = () => { settingsPage = "auto-reply"; render(); };
    folders.querySelector("#settings-accounts").onclick = () => { settingsPage = "accounts"; render(); };
    folders.querySelector("#settings-mail").onclick = () => { settingsPage = "mail"; render(); };
    folders.querySelector("#settings-calendar").onclick = () => { settingsPage = "calendar"; render(); };
    folders.querySelector("#settings-assistants").onclick = () => { settingsPage = "assistants"; render(); };
    folders.querySelector("#settings-templates").onclick = () => { settingsPage = "templates"; render(); };
    folders.querySelector("#settings-signatures").onclick = () => { settingsPage = "signatures"; render(); };
    folders.querySelector("#settings-safe-senders").onclick = () => { settingsPage = "safe-senders"; render(); };
    return;
  }
  if (view === "people") {
    const peopleIds = profileEntries();
    const count = (id) => contacts.filter(c => accountInProfile(c.account) && (id === "all" || c.account === id)).length;
    folders.innerHTML = `
      ${profileSwitchHtml()}
      <button class="new-mail" type="button" id="new-contact">New contact</button>
      <div class="acct-label">Contacts</div>
      ${peopleIds.length > 1 ? `<button class="nav-item" type="button" data-people="all" aria-current="${contactAccount === "all"}">
        All contacts <span class="count">${count("all")}</span>
      </button>` : ""}
      ${peopleIds.map(([id, acct]) => `
        <button class="acct-item" type="button" data-people="${id}" aria-current="${contactAccount === id}">
          <span class="dot ${acct.cls}"></span>${esc(acct.name)} <span class="count">${count(id)}</span>
        </button>
      `).join("")}
    `;
    folders.querySelector("#new-contact").onclick = () => openContactForm();
    bindProfileSwitch(folders);
    folders.querySelectorAll("[data-people]").forEach(btn => {
      btn.onclick = () => {
        contactAccount = btn.dataset.people;
        const list = filteredContacts();
        if (!list.some(c => c.id === selectedContact)) selectedContact = list[0]?.id || null;
        render();
      };
    });
    return;
  }
  if (view === "calendar") {
    const folderScroll = folders.scrollTop;
    folders.innerHTML = `
      ${profileSwitchHtml()}
      <button class="new-mail" type="button" id="compose">New event</button>
      ${miniCalendarMarkup()}
      <div class="acct-label">Calendars</div>
      ${calendarSidebarHtml()}
      ${calendarListLong() ? `<button class="show-all" type="button" id="show-all-cals">${moreCalendarsOpen ? "Show less" : "Show more"}</button>` : ""}
      ${calendarEntries().length ? `<button class="show-all add-cal" type="button" id="add-cal-menu"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>Add calendar</button>` : ""}
    `;
    folders.scrollTop = folderScroll;
    folders.querySelector("#compose").onclick = () => openEventForm();
    bindProfileSwitch(folders);
    folders.querySelector("#mini-prev").onclick = () => shiftMini(-1);
    folders.querySelector("#mini-next").onclick = () => shiftMini(1);
    folders.querySelectorAll("[data-mini]").forEach(btn => {
      btn.onclick = () => {
        const parts = btn.dataset.mini.split("-").map(Number);
        calFocus = new Date(parts[0], parts[1] - 1, parts[2]);
        render();
        refreshLiveCalendar();
      };
    });
    folders.querySelectorAll("[data-cal-dot]").forEach(btn => {
      btn.onclick = () => toggleCalendar(btn.dataset.calDot);
    });
    folders.querySelectorAll("[data-cal-colour]").forEach(btn => {
      btn.onclick = () => {
        if (calColourMenu && calColourAnchor === btn) closeCalendarColour();
        else openCalendarColour(btn.dataset.calColour, btn);
      };
    });
    const showAll = folders.querySelector("#show-all-cals");
    if (showAll) showAll.onclick = () => toggleMoreCalendars();
    const addCal = folders.querySelector("#add-cal-menu");
    if (addCal) addCal.onclick = openAddCalendar;
    return;
  }
  const mailBoxes = ["inbox", "drafts", "outbox", "sent", "archive", "trash"];
  const mailIds = profileEntries();
  const hasAccounts = mailIds.length > 0;
  const favs = favorites.filter(favoriteVisible);
  const folderScroll = folders.scrollTop;
  folders.innerHTML = `
    ${profileSwitchHtml()}
    ${hasAccounts ? `<button class="new-mail" type="button" id="compose">New mail</button>` : ""}
    ${hasAccounts && favs.length ? `${sectionHead("fav", "Favorites", "Favorites")}${sectionOpen("fav") ? favs.map(item => favoriteButton(item.account, item.box)).join("") : ""}` : ""}
    ${mailIds.length > 1 ? `${sectionHead("all", "All accounts", "All accounts")}${sectionOpen("all") ? mailBoxes.map(folder => folderButton("all", folder)).join("") : ""}` : ""}
    ${mailIds.map(([id, acct]) => `
      ${sectionHead(id, esc(acct.name), acct.name)}
      ${sectionOpen(id) ? accountFoldersHtml(id) + categoryFoldersHtml(id) + searchFoldersHtml(id) : ""}
    `).join("")}
  `;
  folders.scrollTop = folderScroll;
  const compose = folders.querySelector("#compose");
  if (compose) compose.onclick = openCompose;
  bindProfileSwitch(folders);
  folders.querySelectorAll("[data-more-folders]").forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.moreFolders;
      if (moreFoldersOpen.has(id)) moreFoldersOpen.delete(id); else moreFoldersOpen.add(id);
      try { localStorage.setItem("mailroom-more-folders", JSON.stringify([...moreFoldersOpen])); } catch (e) {}
      renderFolders();
    };
  });
  folders.querySelectorAll("[data-section]").forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.section;
      if (collapsedSections.has(key)) collapsedSections.delete(key);
      else collapsedSections.add(key);
      rememberMailCollapse();
      render();
    };
  });
  folders.querySelectorAll("[data-fold]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const key = btn.dataset.fold + "\n" + btn.dataset.foldBox;
      if (collapsedFolders.has(key)) collapsedFolders.delete(key);
      else collapsedFolders.add(key);
      rememberMailCollapse();
      render();
    };
  });
  bindFolderDrag();
  folders.querySelectorAll("[data-box]").forEach(btn => {
    btn.onclick = () => {
      if (suppressFolderClick) {
        suppressFolderClick = false;
        return;
      }
      account = btn.dataset.acct;
      box = btn.dataset.box;
      folderPick = btn.classList.contains("fav") ? "fav" : "folder";
      selected = conversations()[0]?.latest.id || null;
      expanded.clear();
      folded.clear();
      const picked = messages.find(m => m.id === selected);
      if (picked && picked.draft) focusReply = true;
      const categoryView = isCategoryBox(box);
      if (!categoryView) {
        if (account === "all") profileAccountIds().forEach(id => rememberFolderBusy(id, box));
        else rememberFolderBusy(account, box);
      }
      render();
      if (categoryView) return;
      if (account === "all") ensureUnifiedFolder(box);
      else ensureFolderMessages(account, box, btn.dataset.folderId || "");
    };
  });
  folders.querySelectorAll(".folder-row, .fav").forEach(el => {
    el.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      const btn = el.matches("[data-box]") ? el : el.querySelector("[data-box]");
      showFolderMenu(ev.clientX, ev.clientY, btn.dataset.acct, btn.dataset.box);
    });
  });
  folders.querySelectorAll("[data-pin]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const acct = btn.dataset.pin;
      const folder = btn.dataset.pinBox;
      if (isFavorite(acct, folder)) removeFavorite(acct, folder);
      else addFavorite(acct, folder);
    };
  });
}

function searchActive() {
  return !!(query.trim() || searchScope === "all" || searchAccount || searchFiles || searchFrom || searchTo);
}

function messageFiles(m) {
  if (!m) return [];
  const list = (m.files && m.files.length) ? m.files : (m.attachments || []);
  return list.map(item => {
    if (typeof item === "string") return { name: item, id: "", type: "", size: 0 };
    if (!item || typeof item !== "object") return null;
    return {
      id: item.id || "",
      name: item.name || "",
      type: item.contentType || item.type || "",
      size: Number(item.size) || 0
    };
  }).filter(item => item && item.name);
}

function messageHasFile(m) {
  return !!m.hasAttachment || messageFiles(m).length > 0;
}

function attachmentNames(m) {
  return messageFiles(m).map(file => file.name).join(" ");
}

function fileKind(file) {
  const name = String(file.name || "").toLowerCase();
  const type = String(file.type || file.contentType || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1) : "";
  if (ext === "pdf" || type === "application/pdf") return { kind: "pdf", label: "PDF" };
  if (ext === "doc" || ext === "docx" || ext === "odt" || ext === "rtf" || type.includes("wordprocessing") || type.includes("msword") || type === "application/rtf" || type.includes("opendocument.text")) return { kind: "doc", label: "DOC" };
  if (ext === "xls" || ext === "xlsx" || ext === "csv" || type.includes("spreadsheet") || type.includes("ms-excel") || type === "text/csv") return { kind: "xls", label: "XLS" };
  if (ext === "ppt" || ext === "pptx" || type.includes("presentation")) return { kind: "ppt", label: "PPT" };
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "gif" || ext === "webp" || type.startsWith("image/")) return { kind: "img", label: "IMG" };
  if (ext === "zip" || ext === "rar" || ext === "7z" || type.includes("zip") || type.includes("compressed")) return { kind: "zip", label: "ZIP" };
  const label = (ext || "file").replace(/[^a-z0-9]/g, "").slice(0, 4).toUpperCase() || "FILE";
  return { kind: "", label };
}

function fileSizeLabel(size) {
  const n = Number(size) || 0;
  if (n < 1) return "";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
  const mb = n / (1024 * 1024);
  const text = mb >= 10 ? String(Math.round(mb)) : String(Math.round(mb * 10) / 10);
  return text + " MB";
}

function attachmentClipSvg() {
  return `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 8.4l3.1-3.1a1.9 1.9 0 012.7 2.7L7.8 12.2a3 3 0 01-4.2-4.2L8 3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
}

function fileTypeMark(file) {
  if (file.unknown) return `<span class="file-type clip-type" aria-hidden="true">${attachmentClipSvg()}</span>`;
  const kind = fileKind(file);
  return `<span class="file-type${kind.kind ? " " + kind.kind : ""}">${esc(kind.label)}</span>`;
}

function fileChipButton(file, messageId, compact) {
  const size = compact ? "" : fileSizeLabel(file.size);
  const label = file.name || "Attachment";
  return `<button type="button" class="file-chip${compact ? " compact" : ""}" data-open-mail-file="1" data-file-msg="${esc(messageId)}" data-file-id="${esc(file.id || "")}" data-file-name="${esc(label)}" data-file-unknown="${file.unknown ? "1" : "0"}" title="${esc(label)}">${fileTypeMark(file)}<span class="file-copy"><span class="file-name">${esc(label)}</span>${size ? `<span class="file-size">${esc(size)}</span>` : ""}</span></button>`;
}

function attachmentOwner(list) {
  const ordered = (list || []).slice().reverse();
  for (const item of ordered) {
    const files = messageFiles(item);
    if (files.length) return { message: item, files };
  }
  const any = ordered.find(messageHasFile);
  if (!any) return null;
  return { message: any, files: [{ name: "Attachment", id: "", type: "", size: 0, unknown: true }] };
}

// A folded message in the open conversation says it has attachments: a
// paperclip and how many, the names on hover (2026-10-23).
function foldClip(m) {
  if (m.draft || !messageHasFile(m)) return "";
  const files = messageFiles(m);
  const label = files.length ? (files.length === 1 ? "1 attachment: " : files.length + " attachments: ") + files.map(f => f.name).join(", ") : "Has attachments";
  return `<span class="fold-clip" title="${esc(label)}" aria-label="${esc(label)}"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 8.4l3.1-3.1a1.9 1.9 0 012.7 2.7L7.8 12.2a3 3 0 01-4.2-4.2L8 3.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>${files.length > 1 ? `<span class="fold-clip-n">${files.length}</span>` : ""}</span>`;
}

function rowFilesHtml(owner) {
  if (!owner || !owner.files.length) return "";
  const more = owner.files.length - 1;
  const extra = more > 0
    ? `<button type="button" class="file-more" data-file-more="1" data-file-msg="${esc(owner.message.id)}" title="${more} more">+${more}</button>`
    : "";
  return `<span class="row-files">${fileChipButton(owner.files[0], owner.message.id, true)}${extra}</span>`;
}

// Meeting invites, updates and cancellations: the Events filter.
function isInviteMessage(m) {
  return !!(m && (m.invite || m.liveInvite || m.meeting));
}

function importanceMark(m) {
  if (m.importance === "high") return `<span class="imp-high" title="High importance" aria-label="High importance">!</span>`;
  if (m.importance === "low") return `<span class="imp-low" title="Low importance" aria-label="Low importance">↓</span>`;
  return "";
}

function thumbCard(img, messageId) {
  return `<button type="button" class="file-thumb" data-open-mail-file="1" data-file-msg="${esc(messageId)}" data-file-id="${esc(img.id)}" data-file-name="${esc(img.name)}" data-file-unknown="0" title="${esc(img.name)}"><img src="${img.url}" alt="${esc(img.name)}"><span class="file-thumb-name">${esc(img.name)}</span></button>`;
}

function messageFileRow(m) {
  // Pictures as thumbnails (2026-10-23), the other files as chips.
  const thumbs = thumbnailImages(m);
  const thumbIds = new Set(thumbs.map(t => t.id));
  const files = messageFiles(m).filter(file => !thumbIds.has(file.id));
  const thumbRow = thumbs.length ? `<div class="mail-thumbs">${thumbs.map(t => thumbCard(t, m.id)).join("")}</div>` : "";
  if (files.length || thumbs.length) {
    return `<div class="mail-attach">${thumbRow}<div class="mail-files">${files.map(file => fileChipButton(file, m.id, false)).join("")}</div><div class="file-downloads"><button type="button" class="linkish" data-download-pick="${esc(m.id)}">Download</button><button type="button" class="linkish" data-download-all="${esc(m.id)}">Download all</button></div></div>`;
  }
  if (m.hasAttachment) return `<div class="mail-files">${fileChipButton({ name: "Attachment", id: "", type: "", size: 0, unknown: true }, m.id, false)}</div>`;
  return "";
}

const searchMonthNumbers = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

function searchDayIso(year, month, day) {
  const date = new Date(Number(year), month - 1, day);
  if (date.getFullYear() !== Number(year) || date.getMonth() !== month - 1 || date.getDate() !== day) return "";
  return year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

function searchYearFor(month, day) {
  const today = todayDate();
  let year = today.getFullYear();
  const candidate = new Date(year, month - 1, day);
  if (candidate.getMonth() !== month - 1 || candidate.getDate() !== day) return "";
  if (candidate > today) year -= 1;
  const iso = searchDayIso(String(year), month, day);
  return iso ? String(year) : "";
}

function searchDateOrder(first, second) {
  if (first > 12 && second <= 12) return { month: second, day: first };
  if (second > 12 && first <= 12) return { month: first, day: second };
  if (first > 12 || second > 12) return null;
  const american = String(navigator.language || "").toLowerCase().startsWith("en-us");
  return american ? { month: first, day: second } : { month: second, day: first };
}

function searchQueryParts(raw) {
  const text = String(raw || "");
  const hits = [];
  const addHit = (iso, start, end) => {
    if (!iso) return;
    hits.push({ iso, start, end });
  };
  const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
  let match;
  while ((match = numeric.exec(text))) {
    const order = searchDateOrder(Number(match[1]), Number(match[2]));
    if (!order) continue;
    let year = match[3] || "";
    if (year.length === 2) year = String(2000 + Number(year));
    if (!year) year = searchYearFor(order.month, order.day);
    addHit(searchDayIso(year, order.month, order.day), match.index, match.index + match[0].length);
  }
  const monthWord = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const named = new RegExp("\\b(" + monthWord + ")\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b", "gi");
  while ((match = named.exec(text))) {
    const month = searchMonthNumbers[match[1].toLowerCase()];
    const day = Number(match[2]);
    const year = match[3] || searchYearFor(month, day);
    addHit(searchDayIso(year, month, day), match.index, match.index + match[0].length);
  }
  const dayFirst = new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(" + monthWord + ")(?:\\s+(\\d{4}))?\\b", "gi");
  while ((match = dayFirst.exec(text))) {
    const month = searchMonthNumbers[match[2].toLowerCase()];
    const day = Number(match[1]);
    const year = match[3] || searchYearFor(month, day);
    addHit(searchDayIso(year, month, day), match.index, match.index + match[0].length);
  }
  hits.sort((a, b) => b.start - a.start);
  let cleaned = text;
  let cursor = text.length;
  const days = [];
  hits.forEach(hit => {
    if (hit.end > cursor) return;
    cleaned = cleaned.slice(0, hit.start) + " " + cleaned.slice(hit.end);
    cursor = hit.start;
    days.push(hit.iso);
  });
  const phrases = [];
  cleaned = cleaned.replace(/"([^"]+)"/g, (_, inner) => {
    const phrase = inner.trim().toLowerCase();
    if (phrase) phrases.push(phrase);
    return " ";
  });
  const words = [];
  cleaned.toLowerCase().split(/[^a-z0-9@.+']+/).forEach(word => {
    if (word) words.push(word);
  });
  return {
    words,
    phrases,
    from: days.length ? days.reduce((a, b) => a < b ? a : b) : "",
    to: days.length ? days.reduce((a, b) => a > b ? a : b) : ""
  };
}

let searchPartsKey = "";
let searchPartsCache = null;

function currentSearchParts() {
  const key = [query, searchFrom, searchTo].join("\n");
  if (searchPartsCache && searchPartsKey === key) return searchPartsCache;
  const parsed = searchQueryParts(query);
  let from = searchFrom;
  let to = searchTo;
  if (parsed.from && (!from || parsed.from > from)) from = parsed.from;
  if (parsed.to && (!to || parsed.to < to)) to = parsed.to;
  searchPartsKey = key;
  searchPartsCache = {
    words: parsed.words,
    phrases: parsed.phrases,
    from,
    to,
    queryFrom: parsed.from,
    queryTo: parsed.to
  };
  return searchPartsCache;
}

function kqlDay(iso) {
  const [year, month, day] = String(iso || "").split("-");
  if (!year || !month || !day) return "";
  return month + "/" + day + "/" + year;
}

function serverSearchQuery() {
  const parts = currentSearchParts();
  const bits = [];
  if (parts.words.length) bits.push(parts.words.join(" "));
  parts.phrases.forEach(phrase => bits.push('"' + phrase + '"'));
  const start = kqlDay(parts.queryFrom);
  const end = kqlDay(parts.queryTo);
  if (start && start === end) bits.push("received:" + start);
  else {
    if (start) bits.push("received>=" + start);
    if (end) bits.push("received<=" + end);
  }
  return bits.join(" AND ");
}

function searchHaystack(m) {
  const people = [];
  ["toPeople", "ccPeople", "bccPeople"].forEach(key => {
    (m[key] || []).forEach(person => {
      if (!person) return;
      people.push(person.name || "", person.email || "");
    });
  });
  const body = String(m.bodyHtml || m.body || "").replace(/<[^>]+>/g, " ");
  const acct = accounts[m.account];
  return [
    m.from, m.email, m.to, m.toName, m.cc, m.bcc, people.join(" "),
    m.subject, m.preview, body, attachmentNames(m), acct ? acct.name : ""
  ].join(" ").toLowerCase();
}

function messageMatchesText(m, parts) {
  if (m.searchOnly) return true;
  const hay = searchHaystack(m);
  if (parts.phrases.some(phrase => !hay.includes(phrase))) return false;
  if (parts.words.some(word => !hay.includes(word))) return false;
  return true;
}

function inSearchScope(m) {
  if (m.searchOnly && !query.trim()) return false;
  const acct = searchAccount || account;
  const range = currentSearchParts();
  if (!accountInProfile(m.account)) return false;
  if (searchScope !== "all" && messageBox(m) !== box) return false;
  if (acct !== "all" && m.account !== acct) return false;
  if (range.from && m.date < range.from) return false;
  if (range.to && m.date > range.to) return false;
  return true;
}

// The list keeps a window of the newest mail. Older rows stay in SQLite until
// the reader reaches the bottom or opens Older mail. Search asks SQLite for one page.
const MAIL_PAGE_SIZE = 100;
const folderPage = new Map();
const searchFoldersLoaded = new Set();
let fillingShort = false;

function asMailPayload(raw) {
  if (Array.isArray(raw)) return { messages: raw, removed: [], merged: false, more: false };
  const obj = raw && typeof raw === "object" ? raw : {};
  return {
    messages: Array.isArray(obj.messages) ? obj.messages : [],
    removed: Array.isArray(obj.removed) ? obj.removed : [],
    merged: obj.merged === true,
    more: obj.more === true
  };
}

function oldestCursor(items) {
  let before = "";
  let beforeId = "";
  (items || []).forEach(item => {
    const received = String((item && item.received) || "");
    const id = String((item && item.id) || "");
    if (!received || !id) return;
    if (!before || received < before || (received === before && id < beforeId)) {
      before = received;
      beforeId = id;
    }
  });
  return { before, beforeId };
}

function pageState(accountId, boxKey) {
  return folderPage.get(folderMark(accountId, boxKey)) || null;
}

function rememberFolderPage(accountId, boxKey, items, more) {
  const cursor = oldestCursor(items);
  folderPage.set(folderMark(accountId, boxKey), {
    before: cursor.before,
    beforeId: cursor.beforeId,
    more: !!more && !!cursor.before,
    loading: false
  });
}

function cursorIsOlder(nextBefore, nextId, prevBefore, prevId) {
  if (!nextBefore) return false;
  if (!prevBefore) return true;
  if (nextBefore !== prevBefore) return nextBefore < prevBefore;
  return String(nextId || "") < String(prevId || "");
}

// Messages past the loaded cursor stay in memory for search, and out of the list.
function inLoadedWindow(m) {
  if (!m || m.pendingSend || m.searchOnly) return true;
  if (searchActive()) return true;
  const state = pageState(m.account, messageBox(m));
  if (!state || !state.before) return true;
  const received = String(m.received || "");
  if (!received) return true;
  if (received > state.before) return true;
  if (received === state.before && String(m.id || "") >= String(state.beforeId || "")) return true;
  return false;
}

// Mail read while the Unread filter is on stays listed, as in Outlook,
// until the filter, folder, account or profile changes (2026-10-26): a message you
// open, or mark read, does not vanish from under you. (var: render can run
// before this line has.)
var keptRead = null;
function keptReadIds() {
  const key = [activeProfile, account, box, mailFilter].join("\n");
  if (!keptRead || keptRead.key !== key) keptRead = { key, ids: new Set() };
  return keptRead.ids;
}

function searchHitKey(accountId, id) {
  return accountId + "\n" + id;
}

function filtered() {
  const q = query.trim().toLowerCase();
  const parts = currentSearchParts();
  const cache = searchFromCache && inDesktop() && searchActive();
  const scoped = messages.filter(m => {
    if (!inSearchScope(m)) return false;
    if (cache) {
      if (m.searchOnly) return true;
      return searchResultIds.has(searchHitKey(m.account, m.id));
    }
    return inLoadedWindow(m);
  });
  const threadHasFile = new Map();
  scoped.forEach(m => {
    threadHasFile.set(m.thread, threadHasFile.get(m.thread) || messageHasFile(m));
  });
  return scoped.filter(m => {
    const hit = cache && searchResultIds.has(searchHitKey(m.account, m.id));
    if (!hit) {
      if (searchFiles === "yes" && !threadHasFile.get(m.thread)) return false;
      if (searchFiles === "no" && threadHasFile.get(m.thread)) return false;
    }
    if (mailFilter === "unread" && !m.unread && !keptReadIds().has(m.id)) return false;
    // Unread across all folders means new mail: the inboxes, not mail that
    // was filed, sent, binned or caught as junk.
    if (mailFilter === "unread" && searchScope === "all" && messageBox(m) !== "inbox") return false;
    if (mailFilter === "read" && m.unread) return false;
    if (mailFilter === "flagged" && !m.flagged) return false;
    if (mailFilter === "events" && !isInviteMessage(m)) return false;
    if (hit) return true;
    if (!q) return true;
    return messageMatchesText(m, parts);
  });
}

function cleanSubject(s) {
  let out = String(s).trim();
  let prev;
  do {
    prev = out;
    out = out.replace(/^(re|fwd|fw):\s*/i, "");
  } while (out !== prev);
  return out;
}

const expanded = new Set();
const folded = new Set();
const openThreads = new Set();
const collapsedMailGroups = new Set();
let pinnedOrder = [];

function loadPins() {
  try {
    const parsed = JSON.parse(localStorage.getItem("mailroom-pins") || "[]");
    if (Array.isArray(parsed)) pinnedOrder = parsed.map(id => String(id || "")).filter(Boolean);
  } catch (e) {}
}

function rememberPins() {
  try { localStorage.setItem("mailroom-pins", JSON.stringify(pinnedOrder)); } catch (e) {}
}

loadPins();

function isPinned(threadId) {
  return pinnedOrder.includes(threadId);
}

function togglePin(threadId) {
  if (!threadId) return;
  if (isPinned(threadId)) pinnedOrder = pinnedOrder.filter(id => id !== threadId);
  else pinnedOrder.unshift(threadId);
  rememberPins();
  toast(isPinned(threadId) ? "Pinned" : "Unpinned");
  render();
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, count) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + count);
  return next;
}

function startOfWeek(date) {
  const day = startOfDay(date);
  const monday = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - monday);
  return day;
}

function messageDay(m) {
  if (m.date && /^\d{4}-\d{2}-\d{2}$/.test(m.date)) {
    const parts = m.date.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  const stamp = Number(m.seq) || 0;
  if (stamp > 0) {
    const date = new Date(stamp);
    if (!Number.isNaN(date.getTime())) return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }
  return startOfDay(todayDate());
}

function mailGroupFor(m) {
  const day = startOfDay(messageDay(m));
  const now = startOfDay(todayDate());
  const diff = Math.round((now.getTime() - day.getTime()) / 86400000);
  if (diff < 0) return { id: "later", label: "Later" };
  if (diff === 0) return { id: "today", label: "Today" };
  if (diff === 1) return { id: "yesterday", label: "Yesterday" };
  const week = startOfWeek(now);
  if (day >= week) {
    const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return { id: "day-" + day.getFullYear() + "-" + (day.getMonth() + 1) + "-" + day.getDate(), label: names[day.getDay()] };
  }
  if (day >= addDays(week, -7)) return { id: "last-week", label: "Last week" };
  if (day >= addDays(week, -14)) return { id: "two-weeks", label: "Two weeks ago" };
  if (day >= addDays(week, -21)) return { id: "three-weeks", label: "Three weeks ago" };
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  if (day >= monthStart) return { id: "earlier-month", label: "Earlier this month" };
  if (day >= lastMonthStart) return { id: "last-month", label: "Last month" };
  return { id: "older", label: "Older" };
}

// ---- Focused Inbox (2026-10-23): Microsoft sorts the Inbox into Focused
// and Other; Mailroom shows the two as tabs, as Outlook does. A message it
// hasn't sorted counts as Focused. Off in Settings > Mail.
let focusedInbox = (() => { try { return localStorage.getItem("mailroom-focused") !== "off"; } catch (e) { return true; } })();
let focusTab = "focused";
const focusOf = m => (m && m.focus === "other" ? "other" : "focused");
function focusApplies() {
  return focusedInbox && box === "inbox" && !searchActive();
}

function paintFocusTabs() {
  const tabs = document.getElementById("focus-tabs");
  if (!tabs) return;
  tabs.hidden = !focusApplies();
  if (tabs.hidden) return;
  tabs.querySelectorAll("[data-focus-tab]").forEach(btn => btn.setAttribute("aria-selected", btn.dataset.focusTab === focusTab ? "true" : "false"));
  const unreadOther = messages.filter(m => messageBox(m) === "inbox" && messageInAccountView(account, m.account) && m.unread && focusOf(m) === "other" && inLoadedWindow(m)).length;
  const count = document.getElementById("focus-other-count");
  if (count) count.textContent = unreadOther ? " " + unreadOther : "";
}

async function moveFocus(list, to, always) {
  const live = list.filter(m => serverMessage(m) && messageBox(m) === "inbox");
  if (!live.length) return;
  const before = live.map(m => m.focus);
  live.forEach(m => { m.focus = to; });
  render();
  const label = to === "other" ? "Other" : "Focused";
  const byAccount = new Map();
  live.forEach(m => { if (!byAccount.has(m.account)) byAccount.set(m.account, []); byAccount.get(m.account).push(m); });
  try {
    for (const [acctId, items] of byAccount) {
      const sender = always ? String(items[0].email || "").toLowerCase() : "";
      await tauriInvoke("set_focus", { email: accounts[acctId].email, messageIds: items.map(m => m.id), message_ids: items.map(m => m.id), focus: to, alwaysSender: sender, always_sender: sender });
      if (always && sender) messages.forEach(m => { if (m.account === acctId && messageBox(m) === "inbox" && String(m.email || "").toLowerCase() === sender) m.focus = to; });
    }
    toast(always ? "Mail from " + (live[0].from || live[0].email) + " goes to " + label + " from now on." : "Moved to " + label + ".");
    render();
  } catch (err) {
    live.forEach((m, i) => { m.focus = before[i]; });
    render();
    toast(String(err && err.message || err || "That didn't move."));
  }
}

const savedSearchHits = new Map();

function conversations() {
  const hits = filtered();
  const threads = new Set(hits.map(m => m.thread));
  const grouped = new Map();
  const active = searchActive() || !!mailFilter;
  const shadowed = shadowedServerDrafts();
  (active ? hits : messages).forEach(m => {
    if (!threads.has(m.thread)) return;
    if (m.live && shadowed.has(m.id)) return;
    if (!accountInProfile(m.account)) return;
    if (!active && !inLoadedWindow(m)) return;
    if (!active) {
      if (isCategoryBox(box)) {
        if (account !== "all" && m.account !== account) return;
        if (!(m.categories || []).includes(categoryNameOf(box))) return;
        if (messageBox(m) === "drafts" || messageBox(m) === "outbox") return;
      } else if (isSearchBox(box)) {
        if (account !== "all" && m.account !== account) return;
        const hits = savedSearchHits.get(m.account + "\n" + box);
        if (hits) { if (!hits.has(m.id)) return; }
        else if (messageBox(m) !== box) return;
      } else {
        if (messageBox(m) !== box) return;
        if (account !== "all" && m.account !== account) return;
      }
    }
    if (!grouped.has(m.thread)) grouped.set(m.thread, []);
    grouped.get(m.thread).push(m);
  });
  const focus = focusApplies();
  return [...grouped.values()].map(list => {
    const ordered = list.slice().sort((a, b) => a.seq - b.seq);
    const latest = ordered[ordered.length - 1];
    return { id: latest.thread, messages: ordered, latest, topic: cleanSubject(latest.subject) };
  }).filter(c => !focus || focusOf(c.latest) === focusTab).sort((a, b) => b.latest.seq - a.latest.seq);
}

function conversationFor(id) {
  const msg = messages.find(m => m.id === id);
  if (!msg) return null;
  const visible = conversations().find(c => c.id === msg.thread);
  if (visible) return visible;
  const list = messages.filter(m => m.thread === msg.thread && messageBox(m) === messageBox(msg) && accountInProfile(m.account));
  if (!list.some(m => m.id === msg.id)) return null;
  const ordered = list.slice().sort((a, b) => a.seq - b.seq);
  const latest = ordered[ordered.length - 1];
  return { id: latest.thread, messages: ordered, latest, topic: cleanSubject(latest.subject) };
}

function sameThreadDraft(conv) {
  if (!conv) return null;
  const accountsInThread = new Set(conv.messages.map(m => m.account));
  let best = null;
  const shadowed = shadowedServerDrafts();
  messages.forEach(m => {
    if (!m.draft || messageBox(m) !== "drafts") return;
    if (m.live && shadowed.has(m.id)) return;
    if (m.thread !== conv.id || !accountsInThread.has(m.account)) return;
    if (conv.messages.some(item => item.id === m.id)) return;
    if (!best || (m.seq || 0) > (best.seq || 0)) best = m;
  });
  return best;
}

// Replies you sent sit in Sent Items, so a thread opened from another folder
// pulls them in, as Outlook does.
function threadSent(conv) {
  if (!conv || !conv.latest || messageBox(conv.latest) === "sent") return [];
  const accountsInThread = new Set(conv.messages.map(m => m.account));
  const own = new Set(conv.messages.map(m => m.id));
  return messages.filter(m => m.thread === conv.id && messageBox(m) === "sent" && accountsInThread.has(m.account) && !own.has(m.id) && !m.pendingSend);
}

// When each conversation last asked Microsoft for its Sent Items. Opened
// again a minute later, or after you send, it asks again.
const threadFetched = new Map();
const THREAD_REFETCH_MS = 60000;

async function loadThreadSent(conv) {
  if (!inDesktop() || !conv || !conv.latest || messageBox(conv.latest) === "sent") return;
  const accountId = conv.latest.account;
  const acct = accounts[accountId];
  const mark = accountId + "\n" + conv.id;
  const last = threadFetched.get(mark);
  if (!acct || !acct.signedIn || !conv.latest.live || (last && Date.now() - last < THREAD_REFETCH_MS)) return;
  threadFetched.set(mark, Date.now());
  try {
    const page = await tauriInvoke("conversation_mail", { email: acct.email, conversationId: conv.id, conversation_id: conv.id });
    const folders = acct.liveFolders || [];
    const sent = folders.find(folder => folder.key === "sent");
    let added = false;
    ((page && page.messages) || []).forEach(item => {
      if (!item || !item.id || messages.some(m => m.id === item.id)) return;
      const parent = item.parentFolderId || item.parent_folder_id || "";
      if (!sent || parent !== sent.id) return;
      const message = liveMessage(accountId, item, "sent");
      message.threadOnly = true;
      messages.push(message);
      added = true;
    });
    // Microsoft's copy replaces the one kept here while it was sending.
    if (added) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.thread === conv.id && m.account === accountId && String(m.id).startsWith("out-") && messageBox(m) === "sent" && !m.pendingSend) messages.splice(i, 1);
      }
    }
    if (added && view === "mail" && conversationFor(selected) && conversationFor(selected).id === conv.id) renderReading();
  } catch (err) {
    threadFetched.delete(mark);
  }
}

function threadShown(conv) {
  const draft = sameThreadDraft(conv);
  const list = conv.messages.concat(threadSent(conv), draft ? [draft] : []);
  list.sort((a, b) => (a.seq || 0) - (b.seq || 0));
  return list;
}

function threadHead(conv) {
  const shown = threadShown(conv);
  return shown[shown.length - 1] || conv.latest;
}

function listSummary(conv) {
  const shown = threadShown(conv);
  const own = new Set(conv.messages.map(m => m.id));
  const summary = [...shown].reverse().find(m => own.has(m.id)) || shown[shown.length - 1];
  return { shown, summary };
}

function draftState(draft) {
  return {
    draftId: draft.id,
    msgId: draft.replyTo || draft.id,
    to: draft.to || "",
    cc: draft.cc || "",
    bcc: draft.bcc || "",
    attachments: draft.attachments || [],
    from: draft.sendFrom ? fromKey(draft.account, draft.sendFrom) : draft.account,
    subject: subjectFieldValue(draft.subject),
    bodyHtml: draft.bodyHtml || "<p><br></p>",
    meeting: draft.meeting || null,
    compose: draft.compose || "",
    staged: draft.staged || {},
    serverDraftId: draft.live ? draft.id : (draft.serverDraftId || ""),
    serverDraftMode: draft.live ? "saved" : (draft.serverDraftMode || "")
  };
}

function filteredContacts() {
  const q = query.trim().toLowerCase();
  return contacts.filter(c => {
    if (!accountInProfile(c.account)) return false;
    if (contactAccount !== "all" && c.account !== contactAccount) return false;
    if (!q) return true;
    return (c.name + c.email + c.company + c.title + accounts[c.account].name).toLowerCase().includes(q);
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function renderContacts() {
  const items = filteredContacts();
  if (!items.some(c => c.id === selectedContact)) selectedContact = items[0]?.id || null;
  listTitle.textContent = contactAccount === "all" ? "All contacts" : accounts[contactAccount].name + " contacts";
  const summary = document.getElementById("search-summary");
  if (summary) { summary.hidden = true; summary.textContent = ""; }
  document.querySelector(".list").setAttribute("aria-label", "Contacts");
  if (!items.length) {
    rows.innerHTML = `<div class="empty">${query.trim() ? "No contacts match." : "No contacts."}</div>`;
    return;
  }
  let letter = "";
  rows.innerHTML = items.map(c => {
    const initial = c.name[0].toUpperCase();
    const head = initial === letter ? "" : `<div class="alpha">${initial}</div>`;
    letter = initial;
    return head + `
      <button class="row" type="button" data-contact="${c.id}" aria-current="${c.id === selectedContact}">
        <span class="avatar" style="background:${esc(c.color)}">${esc(c.initials)}</span>
        <span>
          <span class="who-line"><span class="who">${esc(c.name)}</span><span class="pill ${accounts[c.account].cls}">${esc(accounts[c.account].name)}</span></span>
          <span class="preview">${esc(c.email)}</span>
        </span>
      </button>`;
  }).join("");
  rows.querySelectorAll("[data-contact]").forEach(btn => {
    btn.onclick = () => {
      selectedContact = btn.dataset.contact;
      document.body.dataset.open = "1";
      render();
    };
  });
}

const contactColors = {
  work: "#0f6cbd",
  personal: "#0e7c66",
  plum: "#5b3d8a",
  amber: "#8a5a00",
  clay: "#a33b32"
};

function contactInitials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function contactAccountDefault() {
  if (accountInProfile(contactAccount)) return contactAccount;
  const email = activeDefaultEmail();
  if (email && accountInProfile(email.accountId)) return email.accountId;
  return profileAccountIds()[0] || "";
}

function openContactForm(existing) {
  const ids = profileAccountIds();
  if (!ids.length) return;
  const chosen = existing ? existing.account : contactAccountDefault();
  const many = ids.length > 1 && !existing;
  popRoot.innerHTML = `
    <div class="backdrop" id="backdrop"></div>
    <form class="dialog" id="contact-form" novalidate>
      <h2>${existing ? "Edit contact" : "New contact"}</h2>
      <p class="form-error" id="contact-error" hidden></p>
      <label class="field"${many ? "" : " hidden"}>Account
        <select name="account">${ids.map(id => `<option value="${esc(id)}"${id === chosen ? " selected" : ""}>${esc(accounts[id].name)}</option>`).join("")}</select>
      </label>
      <label class="field">Name<input name="name" placeholder="Add a name" autocomplete="off" value="${esc(existing ? existing.name : "")}"></label>
      <label class="field">Email<input name="email" type="email" placeholder="name@example.com" autocomplete="off" value="${esc(existing ? existing.email : "")}"></label>
      <label class="field">Phone<input name="phone" type="tel" autocomplete="off" value="${esc(existing ? existing.phone || "" : "")}"></label>
      <label class="field">Title<input name="title" autocomplete="off" value="${esc(existing ? existing.title || "" : "")}"></label>
      <label class="field">Company<input name="company" autocomplete="off" value="${esc(existing ? existing.company || "" : "")}"></label>
      <div class="dialog-actions">
        <button class="ghost" type="button" id="cancel">Cancel</button>
        <button class="primary" type="submit">Save</button>
      </div>
    </form>`;
  document.getElementById("backdrop").onclick = closePop;
  document.getElementById("cancel").onclick = closePop;
  const form = document.getElementById("contact-form");
  const nameInput = form.querySelector("[name=name]");
  nameInput.focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const note = document.getElementById("contact-error");
    const fail = (text) => { note.hidden = false; note.textContent = text; };
    const name = String(data.get("name") || "").trim();
    const email = String(data.get("email") || "").trim();
    const accountId = accounts[data.get("account")] ? data.get("account") : chosen;
    if (!name) return fail("Enter a name.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail("Enter an email address.");
    if (contacts.some(c => c !== existing && String(c.email || "").toLowerCase() === email.toLowerCase())) return fail("That email is already a contact.");
    if (existing) return saveContactEdit(existing, { name, email, phone: String(data.get("phone") || "").trim(), title: String(data.get("title") || "").trim(), company: String(data.get("company") || "").trim() }, form, fail);
    const person = {
      id: "contact-" + Date.now(),
      account: accountId,
      name,
      email,
      phone: String(data.get("phone") || "").trim(),
      title: String(data.get("title") || "").trim(),
      company: String(data.get("company") || "").trim(),
      initials: contactInitials(name),
      color: contactColors[accounts[accountId].cls] || "#0f6cbd"
    };
    if (inDesktop() && !accounts[accountId].signedIn) return fail("That account is not signed in.");
    if (inDesktop()) {
      const submit = form.querySelector("[type=submit]");
      submit.disabled = true;
      submit.textContent = "Saving…";
      try {
        const saved = await tauriInvoke("create_contact", {
          email: accounts[accountId].email,
          name,
          address: email,
          phone: person.phone,
          title: person.title,
          company: person.company
        });
        if (saved && saved.id) person.id = saved.id;
        person.live = true;
        if (saved && saved.name) person.name = saved.name;
      } catch (err) {
        submit.disabled = false;
        submit.textContent = "Save";
        return fail(String(err && err.message || err));
      }
    }
    contacts.push(person);
    selectedContact = person.id;
    if (contactAccount !== "all" && contactAccount !== person.account) contactAccount = person.account;
    const q = query.trim().toLowerCase();
    const blob = (person.name + person.email + person.company + person.title + accounts[person.account].name).toLowerCase();
    if (q && !blob.includes(q)) {
      query = "";
      const box = document.getElementById("q");
      if (box) box.value = "";
    }
    closePop();
    setView("people");
    toast("Contact added");
  };
}

async function saveContactEdit(person, next, form, fail) {
  const submit = form.querySelector("[type=submit]");
  if (inDesktop() && person.live) {
    const acct = accounts[person.account];
    if (!acct || !acct.signedIn) return fail("That account is not signed in.");
    submit.disabled = true;
    submit.textContent = "Saving…";
    try {
      await tauriInvoke("update_contact", { email: acct.email, contactId: person.id, name: next.name, address: next.email, phone: next.phone, title: next.title, company: next.company });
    } catch (err) {
      submit.disabled = false;
      submit.textContent = "Save";
      return fail(String(err && err.message || err));
    }
  }
  Object.assign(person, next, { initials: contactInitials(next.name) });
  closePop();
  render();
  toast("Contact saved");
}

async function deleteContact(person) {
  const sure = await chooseDialog("Delete " + person.name + "?", "The contact is removed from " + (accounts[person.account] ? accounts[person.account].name : "this account") + ".", [{ value: "yes", label: "Delete", danger: true }]);
  if (sure !== "yes") return;
  if (inDesktop() && person.live) {
    const acct = accounts[person.account];
    try {
      await tauriInvoke("delete_contact", { email: acct.email, contactId: person.id });
    } catch (err) {
      return toast(String(err && err.message || err));
    }
  }
  const at = contacts.indexOf(person);
  if (at >= 0) contacts.splice(at, 1);
  selectedContact = null;
  render();
  toast("Contact deleted");
}

function renderContact() {
  const person = contacts.find(c => c.id === selectedContact);
  if (!person || !filteredContacts().some(c => c.id === person.id)) {
    reading.innerHTML = `<div class="empty">Select a contact.</div>`;
    return;
  }
  const rowsFor = [
    ["Email", `<a href="mailto:${esc(person.email)}">${esc(person.email)}</a>`],
    ["Phone", person.phone ? esc(person.phone) : ""],
    ["Title", person.title ? esc(person.title) : ""],
    ["Company", person.company ? esc(person.company) : ""],
    ["Saved in", esc(accounts[person.account].name)]
  ].filter(([, value]) => value);
  reading.innerHTML = `
    <div class="read-head">
      <div class="toolbar">
        ${person.email ? `<button class="icon-btn" type="button" id="mail-contact" title="Mail" aria-label="Mail">${mailIcon}</button>` : ""}
        <button class="icon-btn" type="button" id="edit-contact" title="Edit" aria-label="Edit"><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 13.8V16h2.2l7.6-7.6-2.2-2.2L4 13.8zM12.6 5.2l2.2 2.2 1.1-1.1a1 1 0 000-1.4l-.8-.8a1 1 0 00-1.4 0l-1.1 1.1z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></button>
        <button class="icon-btn" type="button" id="delete-contact" title="Delete" aria-label="Delete"><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6.5h11M8 6.4V4.8h4v1.6M7.2 6.5l.5 8.8h4.6l.5-8.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      </div>
    </div>
    <div class="read-body">
      <div class="from">
        <span class="avatar" style="background:${esc(person.color)}">${esc(person.initials)}</span>
        <div>
          <strong>${esc(person.name)}</strong>
          <span class="pill ${accounts[person.account].cls}">${esc(accounts[person.account].name)}</span>
        </div>
      </div>
      <dl class="card">
        ${rowsFor.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}
      </dl>
    </div>
  `;
  const mailContact = document.getElementById("mail-contact");
  if (mailContact) mailContact.onclick = () => openCompose({ account: person.account, email: person.email });
  const editContact = document.getElementById("edit-contact");
  if (editContact) editContact.onclick = () => openContactForm(person);
  const deleteBtn = document.getElementById("delete-contact");
  if (deleteBtn) deleteBtn.onclick = () => deleteContact(person);
}

function prettyDate(iso) {
  if (!iso) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const [y, m, d] = iso.split("-").map(Number);
  return d + " " + months[m - 1] + " " + y;
}

function searchSummary() {
  if (!searchActive()) return "";
  const bits = [];
  if (query.trim()) bits.push(query.trim());
  if (searchScope === "all") bits.push("All folders");
  if (searchAccount) bits.push(accounts[searchAccount].name);
  if (searchFiles === "yes") bits.push("Has attachments");
  if (searchFiles === "no") bits.push("No attachments");
  if (searchFrom && searchTo) bits.push(prettyDate(searchFrom) + " – " + prettyDate(searchTo));
  else if (searchFrom) bits.push("From " + prettyDate(searchFrom));
  else if (searchTo) bits.push("To " + prettyDate(searchTo));
  else if (query.trim()) {
    const parts = currentSearchParts();
    if (parts.queryFrom && parts.queryTo) {
      bits.push(parts.queryFrom === parts.queryTo
        ? prettyDate(parts.queryFrom)
        : prettyDate(parts.queryFrom) + " – " + prettyDate(parts.queryTo));
    }
  }
  return bits.join(" · ");
}

function accountsNeedingSignIn() {
  if (!inDesktop()) return [];
  const ids = account === "all" ? profileAccountIds() : (accountInProfile(account) ? [account] : []);
  if (!ids.length || ids.some(id => accounts[id] && accounts[id].signedIn)) return [];
  return ids.filter(id => accounts[id] && !accounts[id].signedIn);
}

let deeperSerial = 0;
let deeper = { key: "", next: {}, exhausted: false, busy: false, ran: false };

function deeperPrompt(state) {
  if (state.busy) return { text: "Searching the server…", button: "" };
  if (state.ran && state.exhausted) return { text: "No more messages on the server.", button: "" };
  if (state.ran) return { text: "Showing mail from the server.", button: "Search deeper" };
  return { text: "Showing mail already on this computer.", button: "Search deeper" };
}

function syncDeeperKey() {
  const key = [query.trim(), searchScope, searchAccount || "", account, searchScope === "all" ? "*" : box, searchFiles, searchFrom, searchTo].join("\n");
  if (deeper.key === key) return;
  deeperSerial += 1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].searchOnly) messages.splice(i, 1);
  }
  deeper = { key, next: {}, exhausted: false, busy: false, ran: false };
}

function deeperTargets() {
  if (!inDesktop() || !query.trim()) return [];
  const ids = searchAccount ? (accountInProfile(searchAccount) ? [searchAccount] : []) : (account === "all" ? profileAccountIds() : (accountInProfile(account) ? [account] : []));
  const targets = [];
  ids.forEach(id => {
    const acct = accounts[id];
    if (!acct || !acct.signedIn || !acct.email) return;
    let folderId = "";
    if (searchScope !== "all") {
      const folder = (acct.liveFolders || []).find(item => item.key === box);
      folderId = graphFolderId(folder);
      if (!folderId) return;
    }
    targets.push({ id, email: acct.email, folderId });
  });
  return targets;
}

function searchSaveTargets() {
  if (!inDesktop() || !query.trim()) return [];
  const ids = searchAccount ? (accountInProfile(searchAccount) ? [searchAccount] : []) : (account === "all" ? profileAccountIds() : (accountInProfile(account) ? [account] : []));
  return ids.filter(id => {
    const acct = accounts[id];
    return acct && acct.signedIn && acct.email && !isGoogleAccount(id);
  });
}

function deeperBarHtml() {
  const targets = deeperTargets();
  const canSave = searchSaveTargets().length > 0;
  if (!targets.length && !canSave) return "";
  const prompt = targets.length ? deeperPrompt(deeper) : { text: "Save this search as a folder.", button: "" };
  const button = prompt.button
    ? `<button type="button" id="search-deeper"${deeper.busy ? " disabled" : ""}>${esc(prompt.button)}</button>`
    : "";
  const save = canSave ? `<button type="button" id="save-search">Save this search</button>` : "";
  return `<div class="deeper" id="search-deeper-bar"><p>${esc(prompt.text)}</p>${button}${save}</div>`;
}

function paintDeeper() {
  const old = document.getElementById("search-deeper-bar");
  if (old) old.remove();
  const html = deeperBarHtml();
  if (!html) return;
  const summary = document.getElementById("search-summary");
  if (summary) summary.insertAdjacentHTML("afterend", html);
  const btn = document.getElementById("search-deeper");
  if (btn) btn.onclick = () => searchDeeper();
  const save = document.getElementById("save-search");
  if (save) save.onclick = () => saveThisSearch();
}

function searchSourceIds(acct) {
  const folders = (acct && acct.liveFolders) || [];
  if (searchScope !== "all") {
    const folder = folders.find(item => item.key === box);
    const id = graphFolderId(folder);
    return id ? [id] : [];
  }
  return folders.filter(item => item.id && (!item.parentId || !item.depth)).map(item => item.id).slice(0, 40);
}

async function saveThisSearch() {
  const text = query.trim();
  const ids = searchSaveTargets();
  if (!text || !ids.length) return;
  const name = window.prompt("Name this search", text);
  if (!name || !name.trim()) return;
  let saved = 0;
  let problem = "";
  for (const id of ids) {
    const acct = accounts[id];
    const sources = searchSourceIds(acct);
    if (!sources.length) {
      problem = "Choose a folder to search.";
      continue;
    }
    try {
      await tauriInvoke("save_search_folder", {
        email: acct.email,
        name: name.trim(),
        query: text,
        sourceIds: sources,
        source_ids: sources
      });
      saved += 1;
      await loadSearchFolders(id);
    } catch (err) {
      problem = String(err && err.message || err || "The search could not be saved.");
    }
  }
  if (view === "mail") render();
  if (saved) toast(saved === 1 ? "Saved search folder" : "Saved " + saved + " search folders");
  else if (problem) toast(problem);
}

async function deleteSearchFolder(accountId, folder) {
  const acct = accounts[accountId];
  const item = searchFolderOf(accountId, folder);
  if (!acct || !acct.email || !item) return;
  try {
    await tauriInvoke("delete_search_folder", { email: acct.email, folderId: item.id, folder_id: item.id });
  } catch (err) {
    return toast(String(err && err.message || err || "The search folder could not be deleted."));
  }
  savedSearchHits.delete(accountId + "\n" + item.key);
  if (account === accountId && box === item.key) {
    box = "inbox";
    folderPick = "folder";
  }
  const fav = favoriteIndex(accountId, item.key);
  if (fav >= 0) {
    favorites.splice(fav, 1);
    rememberFavorites();
  }
  await loadSearchFolders(accountId);
  if (view === "mail") render();
  toast("Deleted search folder");
}

function addDeeperMessages(accountId, items) {
  (items || []).forEach(item => {
    if (!item || !item.id || messages.some(message => message.id === item.id)) return;
    const parent = item.parentFolderId || item.parent_folder_id || "";
    const folders = (accounts[accountId] && accounts[accountId].liveFolders) || [];
    const found = folders.find(folder => folder.id === parent);
    const boxKey = found ? found.key : (searchScope === "all" ? (parent || "inbox") : box);
    const message = liveMessage(accountId, item, boxKey);
    message.searchOnly = true;
    messages.push(message);
  });
}

async function searchDeeper() {
  const q = serverSearchQuery();
  const targets = deeperTargets().filter(target => !deeper.ran || deeper.next[target.id]);
  if (!q || !targets.length || deeper.busy || deeper.exhausted) return;
  const serial = ++deeperSerial;
  deeper.busy = true;
  renderList();
  let anyNext = false;
  try {
    for (const target of targets) {
      const page = await tauriInvoke("search_mail", {
        email: target.email,
        query: q,
        folderId: target.folderId,
        folder_id: target.folderId,
        from: searchFrom,
        to: searchTo,
        files: searchFiles,
        nextLink: deeper.next[target.id] || "",
        next_link: deeper.next[target.id] || ""
      });
      if (serial !== deeperSerial) return;
      addDeeperMessages(target.id, page && page.messages);
      const next = String((page && (page.nextLink || page.next_link)) || "");
      if (next) {
        deeper.next[target.id] = next;
        anyNext = true;
      } else {
        delete deeper.next[target.id];
      }
    }
    if (serial !== deeperSerial) return;
    deeper.ran = true;
    deeper.exhausted = !anyNext;
  } catch (err) {
    if (serial !== deeperSerial) return;
    toast(String((err && (err.message || err)) || "The server search did not finish."));
  } finally {
    if (serial === deeperSerial) {
      deeper.busy = false;
      if (view === "mail") render();
    }
  }
}

function listHeading() {
  if (searchActive()) return "Search results";
  const acct = accounts[account];
  if (isCategoryBox(box)) {
    const name = categoryNameOf(box);
    if (!acct || account === "all") return name;
    return acct.name + " " + name;
  }
  if (isSearchBox(box)) {
    const name = boxLabel(box, account);
    if (!acct || account === "all") return name;
    return acct.name + " " + name;
  }
  const label = boxLabel(box, account);
  if (!profileAccountIds().length) return profileLabel(activeProfile);
  if (account === "all" && box === "inbox") return "All inboxes";
  if (account === "all" || !acct) return label;
  // The account's name, then the folder as the server names it: "Timberworks Inbox".
  return acct.name + " " + label;
}

function moreListMail() {
  if (view !== "mail" || !inDesktop()) return false;
  if (searchActive()) return !!(searchFromCache && searchCursor.more);
  const ids = account === "all" ? profileAccountIds() : (accountInProfile(account) ? [account] : []);
  return ids.some(id => {
    const state = pageState(id, box);
    return !!(state && state.more && state.before);
  });
}

function bindListOlder() {
  const btn = document.getElementById("list-older");
  if (!btn) return;
  btn.onclick = () => {
    if (searchActive()) loadOlderSearch();
    else loadOlderPages();
  };
}

function renderList() {
  const listEl = document.querySelector(".list");
  const keepScroll = listEl ? listEl.scrollTop : 0;
  ensureSearchCache();
  maybeFillShortList();
  prunePicked();
  syncDeeperKey();
  syncAskQuery();
  paintDeeper();
  const items = conversations();
  listTitle.textContent = listHeading();
  listTitle.title = listTitle.textContent;
  paintFocusTabs();
  const summary = document.getElementById("search-summary");
  const summaryText = searchSummary();
  if (summary) {
    summary.hidden = !summaryText;
    summary.textContent = summaryText;
  }
  paintAsk();
  const head = document.querySelector(".list-head");
  if (head) document.querySelector(".list").style.setProperty("--list-head-h", head.offsetHeight + "px");
  document.querySelector(".list").setAttribute("aria-label", "Messages");
  if (!items.length) {
    const empty = {
      inbox: "Nothing in this inbox.",
      drafts: "No drafts.",
      outbox: "Outbox is empty.",
      sent: "No sent items.",
      archive: "Nothing archived.",
      trash: "Trash is empty."
    };
    const filterEmpty = { unread: "No unread messages.", read: "No read messages.", flagged: "No flagged messages.", events: "No meeting invites." };
    if (!Object.keys(accounts).length && inDesktop()) {
      rows.innerHTML = `<div class="empty"><button class="auth-link" type="button" id="sign-in-empty">Sign in to see your mail.</button></div>`;
      document.getElementById("sign-in-empty").onclick = () => openAddAccountPopup();
      return;
    }
    if (!profileAccountIds().length) {
      const label = profileLabel(activeProfile);
      rows.innerHTML = `<div class="empty"><button class="auth-link" type="button" id="add-profile-account">Add an account to ${esc(label)}.</button></div>`;
      document.getElementById("add-profile-account").onclick = () => { settingsPage = "add-account"; setView("settings"); };
      return;
    }
    if (syncNote) {
      rows.innerHTML = `<div class="empty">${esc(syncNote)}</div>`;
      return;
    }
    const pendingSignIn = accountsNeedingSignIn();
    if (pendingSignIn.length) {
      rows.innerHTML = `<div class="empty">${pendingSignIn.map(id =>
        `<button class="auth-link" type="button" data-sign-in="${esc(id)}">Sign in to see ${esc(accounts[id].name)} mail.</button>`
      ).join("")}</div>`;
      rows.querySelectorAll("[data-sign-in]").forEach(btn => {
        btn.onclick = () => signInAccount(btn.dataset.signIn);
      });
      return;
    }
    const text = folderBusyForView() || (searchActive() && inDesktop() && searchCacheLoad && !searchFromCache)
      ? "Loading…"
      : (searchActive() ? "No messages match." : (isCategoryBox(box) ? "No messages in this category." : (filterEmpty[mailFilter] || empty[box] || "Nothing in this folder.")));
    rows.innerHTML = `<div class="empty">${text}</div>${moreListMail() ? `<button class="list-more" type="button" id="list-older">Older mail</button>` : ""}`;
    bindListOlder();
    return;
  }
  const flagSvg = `<span class="flag" title="Flagged" aria-label="Flagged"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.8 1.2v9.2M2.8 1.6h6.4L7.2 4.2 9.2 6.8H2.8" fill="currentColor"/></svg></span>`;
  const rowClipIcon = `<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 8.4l3.1-3.1a1.9 1.9 0 012.7 2.7L7.8 12.2a3 3 0 01-4.2-4.2L8 3.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  const rowFlagIcon = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 2.2v11.6M4.2 2.8h7.2L9.2 5.6l2.2 2.8H4.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  const rowPinIcon = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.2h4l-.7 3.4 2.2 2.2H4.5l2.2-2.2L6 2.2zM8 7.8v6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  const rowTrashIcon = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 4.6h9.6M6.2 4.5V3.2h3.6v1.3M5.6 4.6l.4 8h4l.4-8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const rowHtml = (m, opts) => {
    const who = (m.draft || m.pendingSend) ? "To: " + (m.toName || m.to || "someone") : m.from;
    const when = m.draft && !m.pendingSend ? "Draft" : m.time;
    const folderPill = searchScope === "all" ? `<span class="pill">${esc(boxLabel(messageBox(m), m.account))}</span>` : "";
    const count = opts.count > 1 ? `<span class="thread-n">${opts.count}</span>` : "";
    const flag = opts.flagged ? flagSvg : "";
    const subject = opts.topic || m.subject;
    const draftPill = (opts.draft || m.draft) ? `<span class="pill draft-pill">Draft</span>` : "";
    const subjectLine = opts.child
      ? (m.draft ? `<span class="sub-line">${draftPill}</span>` : "")
      : `<span class="sub-line"><span class="subject">${esc(subject)}</span>${draftPill}${count}</span>`;
    const pinned = isPinned(opts.thread);
    const flagLabel = m.flagged ? "Remove flag" : "Flag";
    const pinLabel = pinned ? "Unpin" : "Pin";
    const actions = `<span class="row-actions">
      <button type="button" class="row-act" data-row-flag="${esc(m.id)}" aria-pressed="${m.flagged ? "true" : "false"}" title="${esc(flagLabel)}" aria-label="${esc(flagLabel)}">${rowFlagIcon}</button>
      <button type="button" class="row-act pin" data-row-pin="${esc(opts.thread)}" aria-pressed="${pinned ? "true" : "false"}" title="${esc(pinLabel)}" aria-label="${esc(pinLabel)}">${rowPinIcon}</button>
      <button type="button" class="row-act" data-row-delete="${esc(m.id)}" data-row-only="${opts.child ? "1" : ""}" title="Delete" aria-label="Delete">${rowTrashIcon}</button>
    </span>`;
    return `<div class="row-wrap">
      <button class="row${opts.child ? " child" : ""}${opts.unread ? " unread" : ""}${!opts.child && picked.has(opts.thread) ? " picked" : ""}" type="button" data-thread="${opts.thread}" data-id="${m.id}" aria-current="${opts.current ? "true" : "false"}"${!opts.child && picked.size ? ` aria-selected="${picked.has(opts.thread)}"` : ""}>
        <span class="avatar" style="background:${esc(m.color)}">${esc(m.initials)}</span>
        <span>
          <span class="who-line"><span class="who"><span class="who-name">${esc(who)}</span><span class="pill acct-pill ${accounts[m.account].cls}">${esc(accounts[m.account].name)}</span></span>${externalPill(m)}${folderPill}${importanceMark(m)}${categoryDots(m)}${flag}${opts.shortcut ? `<span class="row-clip" title="Has attachments" aria-label="Has attachments">${rowClipIcon}</span>` : ""}<span class="when${when === "Draft" ? " draft-when" : ""}">${esc(when)}</span></span>
          ${subjectLine}
          <span class="preview">${esc(m.preview)}</span>
        </span>
      </button>
      ${actions}
      ${rowFilesHtml(opts.shortcut)}
    </div>`;
  };
  const orderedItems = items.slice().sort((a, b) => {
    const ap = isPinned(a.id);
    const bp = isPinned(b.id);
    if (ap !== bp) return ap ? -1 : 1;
    if (ap && bp) return pinnedOrder.indexOf(a.id) - pinnedOrder.indexOf(b.id);
    const aHead = listSummary(a).summary;
    const bHead = listSummary(b).summary;
    const byDay = messageDay(bHead) - messageDay(aHead);
    if (byDay) return byDay;
    return (bHead.seq || 0) - (aHead.seq || 0);
  });
  let lastGroup = "";
  rows.innerHTML = orderedItems.map(c => {
    const listed = listSummary(c);
    const shown = listed.shown;
    const head = listed.summary;
    const many = shown.length > 1;
    const open = many && openThreads.has(c.id);
    const group = isPinned(c.id) ? { id: "pinned", label: "Pinned" } : mailGroupFor(head);
    const hidden = collapsedMailGroups.has(group.id);
    const heading = group.id === lastGroup ? "" : `<button class="date-group" type="button" data-mail-group="${esc(group.id)}" aria-expanded="${hidden ? "false" : "true"}" aria-label="${esc((hidden ? "Expand " : "Collapse ") + group.label)}">${sectionChevron()}${esc(group.label)}</button>`;
    lastGroup = group.id;
    if (hidden) return heading;
    const twist = many
      ? `<button class="twist" type="button" data-twist="${c.id}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} conversation"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.2 2.2L8 6 4.2 9.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
      : `<span class="twist-gap"></span>`;
    const kids = open
      ? `<div class="conv-kids">${shown.slice().sort((a, b) => (b.seq || 0) - (a.seq || 0)).map(m => rowHtml(m, {
          thread: c.id,
          child: true,
          unread: !!m.unread,
          flagged: !!m.flagged,
          current: selected === m.id,
          shortcut: attachmentOwner([m])
        })).join("")}</div>`
      : "";
    // Opened, a conversation is a subject line over every message in it,
    // newest first, as in Outlook.
    const title = open
      ? `<button class="conv-title${shown.some(m => m.unread) ? " unread" : ""}${picked.has(c.id) ? " picked" : ""}" type="button" data-thread="${c.id}" data-id="${head.id}"><span class="conv-subject">${esc(c.topic || "(No subject)")}</span><span class="conv-count">${shown.length}</span></button>`
      : "";
    return heading + `<div class="conv${open ? " open" : ""}">
      <div class="conv-line">
        ${twist}
        ${open ? title : rowHtml(head, {
          thread: c.id,
          unread: open ? !!head.unread : shown.some(item => item.unread),
          flagged: open ? !!head.flagged : shown.some(item => item.flagged),
          current: open ? selected === head.id : shown.some(item => item.id === selected),
          count: shown.length,
          topic: c.topic,
          draft: box !== "drafts" && shown.some(item => item.draft),
          shortcut: open ? attachmentOwner([head]) : attachmentOwner(shown)
        })}
      </div>
      ${kids}
    </div>`;
  }).join("") + (moreListMail() ? `<button class="list-more" type="button" id="list-older">Older mail</button>` : "");
  if (listEl && keepScroll) listEl.scrollTop = keepScroll;
  bindListOlder();
  rows.querySelectorAll("[data-row-flag]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      toggleFlag(btn.dataset.rowFlag);
    };
  });
  rows.querySelectorAll("[data-row-pin]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      togglePin(btn.dataset.rowPin);
    };
  });
  rows.querySelectorAll("[data-row-delete]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      deleteListed(btn.dataset.rowDelete, btn.dataset.rowOnly === "1");
    };
  });
  rows.querySelectorAll("[data-mail-group]").forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.mailGroup;
      const opening = collapsedMailGroups.has(id);
      if (opening) collapsedMailGroups.delete(id);
      else collapsedMailGroups.add(id);
      renderList();
      if (opening && id === "older") {
        if (searchActive()) loadOlderSearch();
        else loadOlderPages();
      }
    };
  });
  rows.querySelectorAll(".twist").forEach(btn => {
    btn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const id = btn.dataset.twist;
      if (openThreads.has(id)) openThreads.delete(id);
      else openThreads.add(id);
      renderList();
    };
  });
  rows.querySelectorAll("[data-open-mail-file]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const id = btn.dataset.fileMsg;
      const unknown = btn.dataset.fileUnknown === "1";
      selectListedMessage(id);
      if (unknown) return;
      const msg = messages.find(m => m.id === id);
      if (msg) openAttachment(msg, { id: btn.dataset.fileId || "", name: btn.dataset.fileName || "" });
    };
  });
  rows.querySelectorAll("[data-file-more]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      selectListedMessage(btn.dataset.fileMsg);
    };
  });
  rows.querySelectorAll(".conv-title[data-id]").forEach(btn => {
    btn.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      showRowMenu(ev.clientX, ev.clientY, btn.dataset.id, false);
    });
    btn.onclick = (ev) => {
      if (ev.ctrlKey || ev.metaKey) return togglePick(btn.dataset.thread);
      if (ev.shiftKey) return pickRange(btn.dataset.thread);
      if (picked.size) { picked.clear(); pickAnchor = null; }
      selectListedMessage(btn.dataset.id);
    };
  });
  rows.querySelectorAll(".row[data-id]").forEach(btn => {
    btn.draggable = true;
    btn.addEventListener("dragstart", (ev) => {
      draggedMail = { id: btn.dataset.id, child: btn.classList.contains("child") };
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", "");
      startMailGhost(btn, ev);
    });
    btn.addEventListener("dragend", () => {
      draggedMail = null;
      endMailGhost();
      folders.querySelectorAll(".drop-into").forEach(el => el.classList.remove("drop-into"));
    });
    btn.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      showRowMenu(ev.clientX, ev.clientY, btn.dataset.id, btn.classList.contains("child"));
    });
    btn.onclick = (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && !btn.classList.contains("child")) return togglePick(btn.dataset.thread);
      if (ev.shiftKey && !btn.classList.contains("child")) return pickRange(btn.dataset.thread);
      if (picked.size) { picked.clear(); pickAnchor = null; }
      selectListedMessage(btn.dataset.id);
    };
  });
}

// ---- Several conversations at once ----
const picked = new Set();
let pickAnchor = null;

// The conversation lines in list order: a message row, or the subject
// line of an opened conversation.
function threadLines() {
  return [...rows.querySelectorAll(".row[data-thread]:not(.child), .conv-title[data-thread]")];
}

function listedThreads() {
  return threadLines().map(el => el.dataset.thread);
}

function prunePicked() {
  if (!picked.size) return;
  const shown = new Set(conversations().map(c => c.id));
  [...picked].forEach(id => { if (!shown.has(id)) picked.delete(id); });
}

function togglePick(thread) {
  // The open conversation joins the selection, as in Outlook.
  if (!picked.size && selected) {
    const current = messages.find(m => m.id === selected);
    if (current && current.thread !== thread) picked.add(current.thread);
  }
  if (picked.has(thread)) picked.delete(thread); else picked.add(thread);
  pickAnchor = thread;
  render();
}

function pickRange(thread) {
  const order = listedThreads();
  const fromThread = pickAnchor || (messages.find(m => m.id === selected) || {}).thread || thread;
  const a = order.indexOf(fromThread), b = order.indexOf(thread);
  if (a < 0 || b < 0) return togglePick(thread);
  picked.clear();
  order.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(id => picked.add(id));
  pickAnchor = fromThread;
  render();
}

function pickAll() {
  listedThreads().forEach(id => picked.add(id));
  render();
}

// The messages in the picked conversations, as listed in this folder.
function pickedMessages() {
  const convs = conversations().filter(c => picked.has(c.id));
  return convs.flatMap(c => c.messages.filter(m => !m.pendingSend));
}

function bulkPanelHtml() {
  const list = pickedMessages();
  const where = list[0] ? messageBox(list[0]) : box;
  const btn = (act, text) => `<button type="button" class="ghost" data-bulk="${act}">${text}</button>`;
  return `<div class="bulk-panel" role="region" aria-label="Selected conversations">
    <p class="bulk-count">${picked.size} conversations selected</p>
    <div class="bulk-actions">
      ${btn("read", "Mark as read")}${btn("unread", "Mark as unread")}${btn("flag", "Flag")}
      ${where !== "archive" && where !== "trash" ? btn("archive", "Archive") : ""}
      ${btn("move", "Move to…")}${where !== "trash" ? btn("delete", "Delete") : ""}
    </div>
    <button type="button" class="linkish" data-bulk="clear">Clear selection</button>
  </div>`;
}

function bindBulkPanel() {
  reading.querySelectorAll("[data-bulk]").forEach(btn => {
    btn.onclick = () => bulkAction(btn.dataset.bulk);
  });
}

function bulkAction(act) {
  const list = pickedMessages();
  if (act === "clear" || !list.length) {
    picked.clear();
    render();
    return;
  }
  const done = () => { picked.clear(); pickAnchor = null; render(); };
  if (act === "read" || act === "unread") {
    setUnread(list, act === "unread", true);
    return done();
  }
  if (act === "flag") {
    const flagging = list.filter(m => !m.flagged);
    const prior = rememberMessages(flagging);
    flagging.forEach(m => { m.flagged = true; });
    pushMailAction(flagging, "flag", () => prior.forEach(item => { const m = messages.find(x => x.id === item.id); if (m) m.flagged = item.flagged; }), prior);
    toast("Flagged " + picked.size + " conversations");
    return done();
  }
  if (act === "move") {
    const accountsIn = new Set(list.map(m => m.account));
    if (accountsIn.size > 1) return toast("Move to works on one account at a time.");
    picked.clear();
    showMoveDialog(list);
    return;
  }
  const next = act === "archive" ? "archive" : "trash";
  const count = picked.size;
  // One move per account, so each goes to its own account's folder.
  const from = new Map(list.map(m => [m, messageBox(m)]));
  const byAccount = new Map();
  list.forEach(m => { if (!byAccount.has(m.account)) byAccount.set(m.account, []); byAccount.get(m.account).push(m); });
  const pending = [];
  byAccount.forEach(group => pending.push(moveConversation({ messages: group }, next)));
  // One undo for the lot.
  lastMove = { at: Date.now(), pending: Promise.all(pending), items: list.map(message => ({ message, box: from.get(message) })) };
  done();
  toastMove((next === "archive" ? "Archived " : "Deleted ") + count + " conversations");
}

// ---- Software: version, updates, restart ----
let updateWaiting = null;
// An update this copy started is still building.
let updateRunning = false;

// Quietly look for a newer version; say so once per version.
async function checkForUpdate(quiet) {
  if (!inDesktop() || popCompose || assistWindow) return null;
  let status;
  try {
    status = await tauriInvoke("check_update");
  } catch (err) {
    if (!quiet) throw err;
    return null;
  }
  updateWaiting = status && status.behind > 0 ? status : null;
  if (updateWaiting && quiet) {
    let told = "";
    try { told = localStorage.getItem("mailroom-update-told") || ""; } catch (e) {}
    if (told !== status.latest) {
      toast("Mailroom " + status.latest + " is available · Settings → Software", { label: "Open", run: () => showSettings("software") });
      try { localStorage.setItem("mailroom-update-told", status.latest); } catch (e) {}
    }
  }
  if (view === "settings") renderFolders();
  return status;
}

function renderSoftware(body) {
  const version = appVersion || APP_VERSION;
  if (!inDesktop()) {
    body.innerHTML = `<p class="field-hint">Mailroom ${esc(version)}.</p>`;
    return;
  }
  body.innerHTML = `
    <section class="software">
      <div class="software-head">
        <span class="mark">${document.querySelector(".brand .mark") ? document.querySelector(".brand .mark").innerHTML : ""}</span>
        <div><h2>Mailroom ${esc(version)}</h2><p class="field-hint" id="software-repo"></p></div>
      </div>
      <div class="software-status" id="software-status"><p class="field-hint">Checking for updates…</p></div>
      <div class="dialog-actions software-actions">
        <button class="ghost" type="button" id="software-check">Check for updates</button>
        <button class="ghost" type="button" id="software-restart">Restart Mailroom</button>
        <button class="primary" type="button" id="software-update" hidden>Update and restart</button>
      </div>
      <details class="software-log" id="software-log" hidden><summary>Last update</summary><pre id="software-log-text"></pre></details>
    </section>`;
  const statusBox = body.querySelector("#software-status");
  const updateBtn = body.querySelector("#software-update");
  const paint = (status) => {
    body.querySelector("#software-repo").textContent = status ? "Installed from " + status.repo.replace(/^\/home\/[^/]+/, "~") : "";
    if (!status) return;
    updateBtn.hidden = !status.behind;
    if (!status.behind) {
      statusBox.innerHTML = `<p class="software-ok">You have the latest version.</p>`;
      return;
    }
    statusBox.innerHTML = `
      <p class="software-new">Mailroom ${esc(status.latest)} is available${status.behind === 1 ? "" : " (" + status.behind + " changes)"}.</p>
      ${status.changes.length ? `<ul class="software-changes">${status.changes.map(c => `<li>${esc(c)}</li>`).join("")}</ul>` : ""}
      ${status.localChanges ? `<p class="form-error">The copy in ${esc(status.repo)} has changes of its own, so the update may stop. The log below will say.</p>` : ""}
      <p class="field-hint">Updating builds the new version, which takes about a minute, then restarts Mailroom. If the build fails, this version keeps running.</p>`;
  };
  const run = async (quiet) => {
    statusBox.innerHTML = `<p class="field-hint">Checking for updates…</p>`;
    try {
      paint(await checkForUpdate(false));
    } catch (err) {
      statusBox.innerHTML = `<p class="form-error">${esc(String(err && err.message || err))}</p>`;
    }
  };
  body.querySelector("#software-check").onclick = () => run(false);
  body.querySelector("#software-restart").onclick = async () => {
    const sure = await chooseDialog("Restart Mailroom?", "Anything still in Outbox goes out after the restart.", [{ value: "yes", label: "Restart", primary: true }]);
    if (sure === "yes") tauriInvoke("restart_app").catch(err => toast(String(err && err.message || err)));
  };
  const showLog = (log, open) => {
    const box = body.querySelector("#software-log");
    if (!box || !log) return;
    box.hidden = false;
    box.open = open;
    body.querySelector("#software-log-text").textContent = log;
  };
  // Follow the update until Mailroom restarts, or say why it stopped.
  const follow = () => {
    const checkBtn = body.querySelector("#software-check");
    checkBtn.disabled = true;
    updateBtn.hidden = false;
    updateBtn.disabled = true;
    updateBtn.textContent = "Updating…";
    statusBox.querySelector(".update-progress-block")?.remove();
    statusBox.insertAdjacentHTML("beforeend", `
      <div class="update-progress-block">
        <div class="update-progress" role="progressbar" aria-label="Update progress" aria-valuemin="0" aria-valuemax="100"><span></span></div>
        <p class="field-hint update-progress-text">Starting the update…</p>
      </div>`);
    const bar = statusBox.querySelector(".update-progress");
    const text = statusBox.querySelector(".update-progress-text");
    const tick = async () => {
      if (!document.body.contains(bar)) return;
      let now;
      try { now = await tauriInvoke("update_progress"); } catch (err) { now = null; }
      if (!document.body.contains(bar)) return;
      if (now && (now.stage === "idle" || now.stage === "failed" || now.stage === "done")) checkBtn.disabled = false;
      if (!now || now.stage === "idle" || now.stage === "failed") {
        updateRunning = false;
        bar.closest(".update-progress-block").remove();
        updateBtn.disabled = false;
        updateBtn.textContent = "Update and restart";
        if (now && now.stage === "failed") {
          statusBox.insertAdjacentHTML("beforeend", `<p class="form-error update-progress-block">The update stopped, so this version keeps running. The log below says why.</p>`);
          showLog(await tauriInvoke("update_log").catch(() => ""), true);
        }
        return;
      }
      if (now.stage === "done") {
        updateRunning = false;
        bar.closest(".update-progress-block").innerHTML = `<p class="software-ok">Updated. Restart Mailroom to use the new version.</p>`;
        updateBtn.hidden = true;
        return;
      }
      const guess = now.estimate > 0;
      const share = !guess ? null : now.stage === "fetch" ? 3 : now.stage === "restart" ? 100 : Math.min(95, 5 + 90 * now.elapsed / now.estimate);
      bar.classList.toggle("unknown", share === null);
      bar.firstElementChild.style.width = share === null ? "" : share + "%";
      if (share === null) bar.removeAttribute("aria-valuenow"); else bar.setAttribute("aria-valuenow", String(Math.round(share)));
      const left = guess ? now.estimate - now.elapsed : 0;
      text.textContent = now.stage === "fetch" ? "Getting the new version…"
        : now.stage === "restart" ? "Restarting Mailroom…"
        : "Building the new version" + (now.detail ? " · " + now.detail : "") + (!guess ? "…" : left > 5 ? " · about " + (left >= 90 ? Math.round(left / 60) + " min" : left + " s") + " left" : " · almost done");
      setTimeout(tick, 1000);
    };
    tick();
  };
  updateBtn.onclick = async () => {
    const sure = await chooseDialog("Update Mailroom?", "Mailroom builds the new version, then restarts. Keep working meanwhile.", [{ value: "yes", label: "Update and restart", primary: true }]);
    if (sure !== "yes") return;
    try {
      await tauriInvoke("run_update");
    } catch (err) {
      return toast(String(err && err.message || err));
    }
    updateRunning = true;
    body.querySelector("#software-log").hidden = true;
    statusBox.querySelector(".form-error.update-progress-block")?.remove();
    follow();
  };
  tauriInvoke("update_log").then(log => showLog(log, false)).catch(() => {});
  if (updateRunning) {
    statusBox.innerHTML = "";
    follow();
  } else {
    run(true);
  }
}

// ---- Inbox rules ----
let ruleDraft = null;

function ruleFolders(accountId) {
  return ((accounts[accountId] && accounts[accountId].liveFolders) || []).filter(f => f.key !== "drafts" && f.key !== "outbox" && f.key !== "inbox");
}

function ruleSummary(rule, accountId) {
  const when = [rule.from.length ? "from " + rule.from.join(", ") : "", rule.subject.length ? "subject has “" + rule.subject.join("”, “") + "”" : ""].filter(Boolean).join(" and ");
  const folder = ruleFolders(accountId).find(f => f.id === rule.moveTo);
  const what = [rule.moveTo ? "move to " + (folder ? folder.name : "a folder") : "", rule.markRead ? "mark as read" : "", rule.delete ? "delete" : ""].filter(Boolean).join(", ");
  return "When mail is " + (when || "anything") + ": " + (what || "nothing") + (rule.stop ? ". Then stop." : ".") + (rule.other ? " (Has more set in Outlook.)" : "");
}

function renderRules(body) {
  const signed = Object.entries(accounts).filter(([id, a]) => a.signedIn && a.email && !isGoogleAccount(id));
  if (!inDesktop() || !signed.length) {
    const google = Object.keys(accounts).some(isGoogleAccount);
    body.innerHTML = `<p class="field-hint">${google ? "Rules here are for Microsoft accounts. For a Google account, use filters in Gmail's settings." : "Sign in to an account to manage its rules."}</p>`;
    return;
  }
  const draft = ruleDraft;
  ruleDraft = null;
  const chosen = draft && accounts[draft.account] ? draft.account : signed[0][0];
  body.innerHTML = `
    <p class="field-hint">Rules run on Microsoft's servers as mail arrives, so they work with Mailroom closed, and Outlook shows the same rules.</p>
    <label class="field"${signed.length > 1 ? "" : " hidden"}>Account
      <select id="rule-account">${signed.map(([id, a]) => `<option value="${esc(id)}"${id === chosen ? " selected" : ""}>${esc(a.name)} · ${esc(a.email)}</option>`).join("")}</select>
    </label>
    <div class="rule-list" id="rule-list"><p class="field-hint">Loading…</p></div>
    <form class="rule-form" id="rule-form">
      <h2>New rule</h2>
      <label class="field">Name<input name="name" autocomplete="off" value="${esc(draft && draft.name || "")}"></label>
      <label class="field">When it is from<input name="from" autocomplete="off" placeholder="name@example.com; another@example.com" value="${esc(draft && draft.from ? draft.from.join("; ") : "")}"></label>
      <label class="field">Or the subject has<input name="subject" autocomplete="off" placeholder="Words, separated by ;"></label>
      <label class="field">Move it to<select name="moveTo"><option value="">Do not move</option></select></label>
      <label class="check-row"><input type="checkbox" name="markRead"> Mark it as read</label>
      <label class="check-row"><input type="checkbox" name="delete"> Delete it</label>
      <label class="check-row"><input type="checkbox" name="stop" checked> Stop processing more rules</label>
      <p class="form-error" id="rule-error" hidden></p>
      <div class="dialog-actions"><button class="primary" type="submit" id="rule-save">Save rule</button></div>
    </form>`;
  const accountSelect = body.querySelector("#rule-account");
  const list = body.querySelector("#rule-list");
  const form = body.querySelector("#rule-form");
  const email = () => accounts[accountSelect.value].email;
  let current = [];
  const paintFolders = () => {
    form.querySelector("[name=moveTo]").innerHTML = `<option value="">Do not move</option>` + ruleFolders(accountSelect.value).map(f => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("");
  };
  const paintList = () => {
    list.innerHTML = current.length
      ? current.map((r, i) => `<div class="rule-item"><label class="rule-on"><input type="checkbox" data-rule-on="${i}"${r.enabled ? " checked" : ""} aria-label="On"></label><div class="rule-text"><b>${esc(r.name)}</b><small>${esc(ruleSummary(r, accountSelect.value))}</small></div><button type="button" class="ghost" data-rule-delete="${i}">Delete</button></div>`).join("")
      : `<p class="field-hint">No rules yet.</p>`;
    list.querySelectorAll("[data-rule-on]").forEach(box => {
      box.onchange = async () => {
        const rule = Object.assign({}, current[Number(box.dataset.ruleOn)], { enabled: box.checked });
        try { current[Number(box.dataset.ruleOn)] = await tauriInvoke("save_rule", { email: email(), rule }); toast(rule.enabled ? "Rule on" : "Rule off"); }
        catch (err) { box.checked = !box.checked; toast(String(err && err.message || err)); }
      };
    });
    list.querySelectorAll("[data-rule-delete]").forEach(btn => {
      btn.onclick = async () => {
        const rule = current[Number(btn.dataset.ruleDelete)];
        const sure = await chooseDialog("Delete the rule " + rule.name + "?", "", [{ value: "yes", label: "Delete", danger: true }]);
        if (sure !== "yes") return;
        try { await tauriInvoke("delete_rule", { email: email(), id: rule.id }); current = current.filter(r => r !== rule); paintList(); toast("Rule deleted"); }
        catch (err) { toast(String(err && err.message || err)); }
      };
    });
  };
  const load = async () => {
    paintFolders();
    list.innerHTML = `<p class="field-hint">Loading…</p>`;
    try { current = await tauriInvoke("mail_rules", { email: email() }); paintList(); }
    catch (err) { list.innerHTML = `<p class="form-error">${esc(String(err && err.message || err))}</p>`; }
  };
  accountSelect.onchange = load;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const words = v => String(v || "").split(/[;,]/).map(x => x.trim()).filter(Boolean);
    const rule = {
      name: String(data.get("name") || "").trim(),
      enabled: true,
      from: words(data.get("from")).map(addressEmail),
      subject: String(data.get("subject") || "").split(";").map(x => x.trim()).filter(Boolean),
      moveTo: String(data.get("moveTo") || ""),
      markRead: !!data.get("markRead"),
      delete: !!data.get("delete"),
      stop: !!data.get("stop")
    };
    const note = form.querySelector("#rule-error");
    try {
      current.push(await tauriInvoke("save_rule", { email: email(), rule }));
    } catch (err) {
      note.hidden = false;
      note.textContent = String(err && err.message || err);
      return;
    }
    note.hidden = true;
    form.reset();
    paintList();
    toast("Rule saved");
  };
  load();
}

// A rule for mail from this sender, ready to finish in Settings.
function createRuleFrom(id) {
  const msg = messages.find(m => m.id === id);
  if (!msg || !msg.email) return;
  ruleDraft = { account: msg.account, from: [msg.email], name: "From " + (msg.from || msg.email) };
  showSettings("rules");
}

// ---- Automatic replies (out of office) ----
const autoRepliesOn = new Map();

function textToHtml(text) {
  return esc(String(text || "")).replace(/\r?\n/g, "<br>");
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(String(html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div)>/gi, "\n"), "text/html");
  return (doc.body ? doc.body.textContent : "").replace(/\n{3,}/g, "\n\n").trim();
}

function replyActive(reply) {
  if (!reply || reply.status === "disabled") return false;
  if (reply.status !== "scheduled") return true;
  const now = Date.now();
  return Date.parse(reply.start + "Z") <= now && now < Date.parse(reply.end + "Z");
}

async function checkAutoReplies() {
  for (const [id, acct] of Object.entries(accounts)) {
    if (!acct.signedIn || !acct.email || isGoogleAccount(id)) continue;
    try {
      const reply = await tauriInvoke("auto_reply", { email: acct.email });
      if (replyActive(reply)) autoRepliesOn.set(id, reply); else autoRepliesOn.delete(id);
    } catch (err) {}
  }
  paintAutoReplyBanner();
}

function paintAutoReplyBanner() {
  let banner = document.getElementById("ooo-banner");
  if (!autoRepliesOn.size) { if (banner) banner.remove(); return; }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "ooo-banner";
    banner.className = "ooo-banner";
    rows.parentElement.insertBefore(banner, rows);
  }
  const names = [...autoRepliesOn.keys()].map(id => accounts[id] ? accounts[id].name : id).join(", ");
  banner.innerHTML = `<span>Automatic replies are on for ${esc(names)}.</span><button type="button" class="linkish" id="ooo-off">Turn off</button>`;
  banner.querySelector("#ooo-off").onclick = async () => {
    for (const [id, reply] of [...autoRepliesOn]) {
      try {
        await tauriInvoke("set_auto_reply", { email: accounts[id].email, reply: Object.assign({}, reply, { status: "disabled" }) });
        autoRepliesOn.delete(id);
      } catch (err) { toast(String(err && err.message || err)); }
    }
    paintAutoReplyBanner();
    if (!autoRepliesOn.size) toast("Automatic replies are off");
  };
}

function renderAutoReplies(body) {
  const signed = Object.entries(accounts).filter(([id, a]) => a.signedIn && a.email && !isGoogleAccount(id));
  if (!inDesktop() || !signed.length) {
    const google = Object.keys(accounts).some(isGoogleAccount);
    body.innerHTML = `<p class="field-hint">${google ? "Automatic replies here are for Microsoft accounts. For a Google account, use the vacation responder in Gmail's settings." : "Sign in to an account to set automatic replies."}</p>`;
    return;
  }
  const local = stamp => { if (!stamp) return ""; const d = new Date(stamp + "Z"); const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); };
  const utc = value => value ? new Date(value).toISOString().slice(0, 19) : "";
  body.innerHTML = `
    <form id="auto-reply-form" class="auto-reply">
      <label class="field"${signed.length > 1 ? "" : " hidden"}>Account
        <select name="account">${signed.map(([id, a]) => `<option value="${esc(id)}">${esc(a.name)} · ${esc(a.email)}</option>`).join("")}</select>
      </label>
      <fieldset class="auto-status">
        <label><input type="radio" name="status" value="disabled" checked> Off</label>
        <label><input type="radio" name="status" value="alwaysEnabled"> On</label>
        <label><input type="radio" name="status" value="scheduled"> Only between</label>
      </fieldset>
      <div class="auto-when" id="auto-when" hidden>
        <label class="field">Start<input type="datetime-local" name="start"></label>
        <label class="field">End<input type="datetime-local" name="end"></label>
      </div>
      <label class="field">Reply to people in your organisation<textarea name="internal" rows="5"></textarea></label>
      <label class="check-row"><input type="checkbox" name="externalOn"> Also reply to people outside it</label>
      <div id="auto-external" hidden>
        <label class="field">Who<select name="audience"><option value="contactsOnly">Only my contacts</option><option value="all">Everyone</option></select></label>
        <label class="field">Reply outside your organisation<textarea name="external" rows="5"></textarea></label>
      </div>
      <p class="form-error" id="auto-error" hidden></p>
      <div class="dialog-actions"><button class="primary" type="submit" id="auto-save">Save</button></div>
    </form>`;
  const form = body.querySelector("#auto-reply-form");
  const paint = () => {
    const status = form.querySelector("[name=status]:checked").value;
    form.querySelector("#auto-when").hidden = status !== "scheduled";
    form.querySelector("#auto-external").hidden = !form.querySelector("[name=externalOn]").checked;
  };
  form.addEventListener("change", paint);
  const fill = async () => {
    const id = form.querySelector("[name=account]").value;
    const note = form.querySelector("#auto-error");
    note.hidden = true;
    try {
      const reply = await tauriInvoke("auto_reply", { email: accounts[id].email });
      form.querySelector(`[name=status][value="${reply.status}"]`).checked = true;
      form.querySelector("[name=start]").value = local(reply.start);
      form.querySelector("[name=end]").value = local(reply.end);
      form.querySelector("[name=internal]").value = htmlToText(reply.internal);
      form.querySelector("[name=externalOn]").checked = reply.externalAudience !== "none";
      form.querySelector("[name=audience]").value = reply.externalAudience === "all" ? "all" : "contactsOnly";
      form.querySelector("[name=external]").value = htmlToText(reply.external);
    } catch (err) {
      note.hidden = false;
      note.textContent = String(err && err.message || err);
    }
    paint();
  };
  form.querySelector("[name=account]").onchange = fill;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const id = form.querySelector("[name=account]").value;
    const data = new FormData(form);
    const reply = {
      status: data.get("status"),
      externalAudience: data.get("externalOn") ? data.get("audience") : "none",
      start: utc(data.get("start")),
      end: utc(data.get("end")),
      internal: textToHtml(data.get("internal")),
      external: textToHtml(data.get("external"))
    };
    const note = form.querySelector("#auto-error");
    const save = form.querySelector("#auto-save");
    save.disabled = true;
    try {
      await tauriInvoke("set_auto_reply", { email: accounts[id].email, reply });
    } catch (err) {
      save.disabled = false;
      note.hidden = false;
      note.textContent = String(err && err.message || err);
      return;
    }
    save.disabled = false;
    if (replyActive(reply)) autoRepliesOn.set(id, reply); else autoRepliesOn.delete(id);
    paintAutoReplyBanner();
    toast(reply.status === "disabled" ? "Automatic replies are off" : "Automatic replies saved");
  };
  paint();
  fill();
}

// After answering an invite in Mail, move the invite to Deleted Items.
let tidyInvites = (() => { try { return localStorage.getItem("mailroom-tidy-invites") !== "off"; } catch (e) { return true; } })();

// ---- Joining online meetings: Teams, Zoom, Google Meet, Webex ----
const MEETING_LINKS = [
  ["Zoom", /^https:\/\/([\w-]+\.)*(zoom\.us|zoomgov\.com)\/(j|my|w|wc|s)\//i],
  ["Google Meet", /^https:\/\/meet\.google\.com\/[a-z0-9-]+/i],
  ["Teams", /^https:\/\/(teams\.microsoft\.com\/(l\/meetup-join|meet)|teams\.live\.com\/meet)\//i],
  ["Webex", /^https:\/\/([\w-]+\.)*webex\.com\/(meet|join|[\w-]+\/j\.php|wbxmjs)/i]
];

function meetingProvider(url) {
  const found = MEETING_LINKS.find(([, re]) => re.test(url));
  return found ? found[0] : "";
}

// The link to join an event: Microsoft's own online meeting first, then a
// Zoom, Meet, Teams or Webex link in the location or notes.
function meetingLink(ev) {
  if (!ev) return null;
  if (ev.joinUrl && /^https:\/\//i.test(ev.joinUrl)) return { url: ev.joinUrl, provider: meetingProvider(ev.joinUrl) || "Teams" };
  const text = String(ev.where || "") + " " + String(ev.notes || "");
  const urls = text.match(/https:\/\/[^\s<>"'()]+/gi) || [];
  for (const [provider, re] of MEETING_LINKS) {
    const hit = urls.map(u => u.replace(/[.,;:!?]+$/, "")).find(u => re.test(u));
    if (hit) return { url: hit, provider };
  }
  return null;
}

// ---- Meeting reminders ----
const REMINDER_CHOICES = [[-1, "None"], [0, "At the start"], [5, "5 minutes before"], [10, "10 minutes before"], [15, "15 minutes before"], [30, "30 minutes before"], [60, "1 hour before"], [1440, "1 day before"]];

function remindedKeys() {
  try { const v = JSON.parse(localStorage.getItem("mailroom-reminded") || "{}"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; }
}

function eventStart(ev) {
  const day = dateFromDay(ev.day);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(ev.start / 60), ev.start % 60).getTime();
}

// Raise a reminder once for each meeting, from its reminder time until it
// has been under way for five minutes.
function checkReminders() {
  if (!inDesktop() || popCompose || assistWindow) return;
  const now = Date.now();
  const shown = remindedKeys();
  let changed = false;
  events.forEach(ev => {
    if (!ev.live || !Number.isInteger(ev.reminder) || ev.reminder < 0 || ev.hidden || ev.response === "declined") return;
    if (String(ev.id).includes("@") && !String(ev.id).endsWith("@" + isoFromDay(ev.day))) return;
    const start = eventStart(ev);
    if (now < start - ev.reminder * 60000 || now > start + 5 * 60000) return;
    const key = String(ev.eventId || ev.id) + "|" + start;
    if (shown[key]) return;
    shown[key] = now;
    changed = true;
    const minutes = Math.round((start - now) / 60000);
    const when = minutes > 0 ? "In " + minutes + " min" : "Now";
    const link = meetingLink(ev);
    const body = [when + " · " + fmt(ev.start) + "–" + fmt(ev.end), link ? "" : (ev.where || ""), link ? link.provider + " meeting" : ""].filter(Boolean).join(" · ");
    const call = tauriInvoke("notify_mail", { title: ev.title, body, messageId: "event:" + ev.id });
    if (call && call.catch) call.catch(() => {});
    if (!document.hidden && document.hasFocus()) toast(ev.title + " · " + when);
  });
  if (changed) {
    // Keep a fortnight of marks.
    Object.keys(shown).forEach(k => { if (now - shown[k] > 14 * 86400000) delete shown[k]; });
    try { localStorage.setItem("mailroom-reminded", JSON.stringify(shown)); } catch (e) {}
  }
}

// ---- Follow-up: remind me if nobody answers a message I sent ----
// Kept in localStorage as {id, account, subject, to, thread, sentAt, due,
// shown}. A reply is mail from anyone it went to, after it went, in its
// conversation or under its subject. Until it is due only the mail on hand
// is looked at; when due, the server is searched before reminding.
function loadFollowUps() {
  try { const list = JSON.parse(localStorage.getItem("mailroom-followups") || "[]"); return Array.isArray(list) ? list.filter(item => item && item.id && Array.isArray(item.to)) : []; } catch (e) { return []; }
}

function saveFollowUps(list) {
  try { localStorage.setItem("mailroom-followups", JSON.stringify(list)); } catch (e) {}
}

function followUpPresets() {
  return [
    { label: "Tomorrow", when: at(1, 9) },
    { label: "In 3 days", when: at(3, 9) },
    { label: "Next week", when: nextWeekday(1, 9) }
  ];
}

function followUpWhen(ms) {
  return new Date(ms).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function watchForReply(message) {
  const due = Number(message.followUp) || 0;
  const to = parseAddresses([message.to, message.cc].filter(Boolean).join("; ")).map(e => e.toLowerCase());
  if (!due || !to.length) return;
  const sentAt = message.sendLater ? (new Date(message.sendLater).getTime() || Date.now()) : Date.now();
  const list = loadFollowUps().filter(item => item.id !== message.id);
  list.push({ id: message.id, account: message.account, subject: message.subject || "", to, thread: message.thread || "", sentAt, due: Math.max(due, sentAt), shown: 0 });
  saveFollowUps(list);
}

function isReplyTo(item, m) {
  if (!m || m.account !== item.account || m.pendingSend || m.draft) return false;
  if (["sent", "drafts", "outbox"].includes(m.box)) return false;
  if ((Number(m.seq) || 0) <= item.sentAt) return false;
  if (!item.to.includes(String(m.email || "").toLowerCase())) return false;
  if (item.thread && m.thread === item.thread) return true;
  const subject = cleanSubject(item.subject || "").toLowerCase();
  return !!subject && subject !== "(no subject)" && cleanSubject(m.subject || "").toLowerCase() === subject;
}

async function answeredOnServer(item) {
  const acct = accounts[item.account];
  const subject = cleanSubject(item.subject || "");
  if (!acct || !acct.email || !subject || subject === "(No subject)") return false;
  const page = await tauriInvoke("search_mail", { email: acct.email, query: subject.replace(/"/g, ""), folderId: "", folder_id: "", from: "", to: "", files: "", nextLink: "", next_link: "" });
  return ((page && page.messages) || []).some(hit => isReplyTo(item, {
    account: item.account,
    box: "inbox",
    seq: Date.parse(hit.received) || 0,
    email: hit.fromEmail || "",
    thread: hit.thread || "",
    subject: hit.subject || ""
  }));
}

let checkingFollowUps = false;
async function checkFollowUps() {
  if (checkingFollowUps || !inDesktop() || popCompose || assistWindow) return;
  checkingFollowUps = true;
  try {
    const now = Date.now();
    let list = loadFollowUps();
    const answered = new Set(list.filter(item => messages.some(m => isReplyTo(item, m))).map(item => item.id));
    for (const item of list) {
      if (answered.has(item.id) || item.due > now || item.shown) continue;
      try {
        if (await answeredOnServer(item)) { answered.add(item.id); continue; }
      } catch (err) {
        continue; // Offline or signed out: ask again next time.
      }
      item.shown = now;
      if (accountInProfile(item.account)) {
        const names = item.to.map(email => (contacts.find(c => c.email.toLowerCase() === email) || {}).name || email);
        const call = tauriInvoke("notify_mail", { title: "No reply yet · " + (item.subject || "(No subject)"), body: "Sent to " + names.join(", ") + " " + new Date(item.sentAt).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }), messageId: "followup:" + item.id });
        if (call && call.catch) call.catch(() => {});
      }
    }
    // Saved against a fresh read: a pop-out may have added one meanwhile.
    const kept = new Map(list.map(item => [item.id, item]));
    list = loadFollowUps().filter(item => !answered.has(item.id)).map(item => kept.get(item.id) || item);
    saveFollowUps(list);
  } finally {
    checkingFollowUps = false;
  }
  paintFollowUps();
}

// ---- Search anything: people and events that match, above the mail ----
function searchEvents(q, limit) {
  const needle = String(q || "").trim().toLowerCase();
  if (needle.length < 2) return [];
  const soon = Date.now() - 86400000;
  const seen = new Set();
  return events
    .filter(ev => ev && !ev.hidden && (!ev.account || accountInProfile(ev.account)) && [ev.title, ev.where, ev.organizer, ev.notes].filter(Boolean).join(" ").toLowerCase().includes(needle))
    .map(ev => ({ ev, at: dateFromDay(ev.day).getTime() + (Number(ev.start) || 0) * 60000 }))
    // Coming up first, nearest first; then the past, latest first.
    .sort((a, b) => {
      const ua = a.at >= soon, ub = b.at >= soon;
      if (ua !== ub) return ua ? -1 : 1;
      return ua ? a.at - b.at : b.at - a.at;
    })
    // A repeating series once, at its nearest date.
    .filter(({ ev }) => {
      const key = String(ev.eventId || ev.id).split("@")[0] + "|" + ev.title;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit || 4).map(item => item.ev);
}

function paintSearchExtras() {
  const bar = document.getElementById("search-extras");
  if (!bar) return;
  const q = view === "mail" ? query.trim() : "";
  const people = q ? peopleMatches(q, 4) : [];
  const found = q ? searchEvents(q, 4) : [];
  bar.hidden = !people.length && !found.length;
  if (bar.hidden) { bar.innerHTML = ""; return; }
  const personChip = person => `<button type="button" class="extra-chip" data-extra-person="${esc(person.email)}" title="${esc(person.email)}"><span class="extra-initials" aria-hidden="true">${esc(initialsFor(person.name || person.email))}</span><span class="extra-text">${esc(person.name || person.email)}</span></button>`;
  const eventChip = ev => `<button type="button" class="extra-chip" data-extra-event="${esc(ev.id)}" title="${esc(eventWhen(ev, ev.start == null ? "all" : "timed"))}"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg><span class="extra-text">${esc(ev.title || "(No title)")}</span><small>${esc(formatDayLong(ev.day))}</small></button>`;
  bar.innerHTML = (people.length ? `<div class="extra-row"><span class="extra-label">People</span>${people.map(personChip).join("")}</div>` : "")
    + (found.length ? `<div class="extra-row"><span class="extra-label">Calendar</span>${found.map(eventChip).join("")}</div>` : "");
}

document.addEventListener("click", (ev) => {
  const person = ev.target.closest("[data-extra-person]");
  if (person) {
    const email = person.dataset.extraPerson.toLowerCase();
    const contact = contacts.find(c => String(c.email || "").toLowerCase() === email);
    query = contact ? "" : email;
    document.getElementById("q").value = query;
    if (contact) {
      selectedContact = contact.id;
      if (!accountInProfile(contact.account)) {
        activeProfile = accountProfile(contact.account);
        rememberActiveProfile();
      }
      const ids = profileAccountIds();
      contactAccount = ids.length > 1 ? "all" : (contact.account || ids[0] || "all");
      setView("people");
    } else applySearch(); // Not a contact: their mail.
    return;
  }
  const item = ev.target.closest("[data-extra-event]");
  if (item) openFromNotification("event:" + item.dataset.extraEvent);
});

function paintFollowUps() {
  const bar = document.getElementById("followup-bar");
  if (!bar) return;
  const due = view === "mail" ? loadFollowUps().filter(item => item.shown && accountInProfile(item.account) && (account === "all" || account === item.account)) : [];
  bar.hidden = !due.length;
  if (!due.length) { bar.innerHTML = ""; return; }
  bar.innerHTML = due.slice(0, 3).map(item => {
    const first = item.to[0] || "";
    const who = (contacts.find(c => c.email.toLowerCase() === first) || {}).name || first;
    const more = item.to.length > 1 ? " and " + (item.to.length - 1) + " more" : "";
    return `<div class="followup-item" data-followup="${esc(item.id)}"><span class="followup-icon" aria-hidden="true">⏰</span><span class="followup-text">No reply from <strong>${esc(who)}</strong>${esc(more)} to “${esc(item.subject || "(No subject)")}”</span><button type="button" class="link-btn" data-followup-open>Open</button><button type="button" class="link-btn" data-followup-dismiss>Dismiss</button></div>`;
  }).join("") + (due.length > 3 ? `<div class="followup-more">${due.length - 3} more waiting</div>` : "");
}

document.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-followup-open], [data-followup-dismiss]");
  if (!btn) return;
  const id = btn.closest("[data-followup]").dataset.followup;
  const item = loadFollowUps().find(f => f.id === id);
  if (btn.hasAttribute("data-followup-dismiss") || !item) {
    saveFollowUps(loadFollowUps().filter(f => f.id !== id));
    paintFollowUps();
    return;
  }
  const subject = cleanSubject(item.subject || "");
  searchPick = "";
  query = subject;
  document.getElementById("q").value = subject;
  searchScope = "all";
  const scope = document.getElementById("search-scope");
  if (scope) scope.value = "all";
  if (view !== "mail") setView("mail");
  else applySearch();
});

// ---- Snooze: mail leaves the Inbox and comes back, unread, when due ----
function loadSnoozes() {
  try { const list = JSON.parse(localStorage.getItem("mailroom-snoozed") || "[]"); return Array.isArray(list) ? list : []; } catch (e) { return []; }
}

function saveSnoozes(list) {
  try { localStorage.setItem("mailroom-snoozed", JSON.stringify(list)); } catch (e) {}
}

async function snoozeMessages(targets) {
  const list = (targets || []).filter(m => !m.pendingSend && !m.draft);
  const first = list[0];
  if (!first) return;
  if (!serverMessage(first)) return toast("Snooze needs a signed-in account.");
  if (list.some(m => m.account !== first.account)) return toast("Snooze works on one account at a time.");
  const when = await pickTime("Snooze until", "The mail goes to a Snoozed folder and comes back to the Inbox, unread. Mailroom brings it back while it is open, or as soon as it next opens.", snoozePresets(), "Snooze");
  if (!when) return;
  const acct = accounts[first.account];
  let folderId;
  try {
    folderId = await tauriInvoke("ensure_folder", { email: acct.email, name: "Snoozed" });
  } catch (err) {
    return toast(String(err && err.message || err));
  }
  acct.liveFolders = acct.liveFolders || [];
  if (!acct.liveFolders.some(f => f.id === folderId)) acct.liveFolders.push({ id: folderId, parentId: "", name: "Snoozed", key: folderId, unread: 0, total: 0, depth: 0 });
  const key = (acct.liveFolders.find(f => f.id === folderId) || {}).key || folderId;
  moveToFolder(list, key);
  const move = lastMove;
  toastMove("Snoozed until " + when.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
  try { await (move && move.pending); } catch (e) {}
  const snoozes = loadSnoozes();
  snoozes.push({ account: first.account, email: acct.email, ids: list.map(m => m.id), until: when.getTime() });
  saveSnoozes(snoozes);
}

let checkingSnoozes = false;

async function checkSnoozes() {
  if (checkingSnoozes || !inDesktop()) return;
  const all = loadSnoozes();
  const due = all.filter(item => item.until <= Date.now());
  if (!due.length) return;
  checkingSnoozes = true;
  let back = 0;
  try {
    for (const item of due) {
      try {
        const moved = await tauriInvoke("apply_mail", { kind: "inbox", messageIds: item.ids, email: item.email });
        const ids = item.ids.map(id => ((moved || []).find(pair => pair.from === id) || { to: id }).to);
        await tauriInvoke("apply_mail", { kind: "unread", messageIds: ids, email: item.email });
        back += ids.length;
      } catch (err) {
        // Moved or deleted since; nothing to bring back.
      }
    }
  } finally {
    saveSnoozes(loadSnoozes().filter(item => item.until > Date.now()));
    checkingSnoozes = false;
  }
  if (back) {
    toast(back === 1 ? "A snoozed message is back in the Inbox" : back + " snoozed messages are back in the Inbox");
    pollMail();
  }
}

// ---- Categories ----
const CATEGORY_COLOURS = {
  preset0: "#e74856", preset1: "#ff8c00", preset2: "#ab620d", preset3: "#fff100", preset4: "#47d041",
  preset5: "#30c6cc", preset6: "#73aa24", preset7: "#4cb5ff", preset8: "#a700ae", preset9: "#ee5fb7",
  preset10: "#647687", preset11: "#4b5a6a", preset12: "#8a8886", preset13: "#57585a", preset14: "#323130",
  preset15: "#a4262c", preset16: "#c75c00", preset17: "#7d5a00", preset18: "#b5a800", preset19: "#0b6a0b",
  preset20: "#038387", preset21: "#498205", preset22: "#004e8c", preset23: "#5c2e91", preset24: "#ac0060"
};

function categoryColour(accountId, name) {
  const list = (accounts[accountId] && accounts[accountId].categories) || [];
  const found = list.find(c => c.name === name);
  return CATEGORY_COLOURS[found && found.color] || "#8a8886";
}

function categoryPills(m) {
  return (m.categories || []).map(name => `<span class="cat-pill" title="${esc(name)}"><span class="cat-dot" style="background:${categoryColour(m.account, name)}"></span>${esc(name)}</span>`).join("");
}

function categoryDots(m) {
  const cats = m.categories || [];
  if (!cats.length) return "";
  return `<span class="cat-dots" title="${esc(cats.join(", "))}">${cats.slice(0, 3).map(name => `<span class="cat-dot" style="background:${categoryColour(m.account, name)}"></span>`).join("")}</span>`;
}

async function loadCategories(accountId) {
  const acct = accounts[accountId];
  if (!acct || !acct.signedIn || !acct.email || !inDesktop() || isGoogleAccount(accountId)) return;
  try {
    const rows = await tauriInvoke("mail_categories", { email: acct.email });
    if (!Array.isArray(rows)) return;
    acct.categories = rows;
    const names = new Set(rows.map(item => item && item.name).filter(Boolean));
    const before = favorites.length;
    favorites = favorites.filter(item => item.account !== accountId || !isCategoryBox(item.box) || names.has(categoryNameOf(item.box)));
    if (favorites.length !== before) rememberFavorites();
  } catch (err) {
    acct.categories = acct.categories || [];
  }
}

async function loadAliases(accountId) {
  const acct = accounts[accountId];
  if (!acct || !acct.signedIn || !acct.email || !inDesktop() || isGoogleAccount(accountId)) return;
  try {
    const rows = await tauriInvoke("mail_aliases", { email: acct.email });
    if (!Array.isArray(rows)) return;
    acct.aliases = rows;
    rememberAccount(accountId);
  } catch (err) {
    acct.aliases = acct.aliases || [];
  }
}

async function loadSearchFolders(accountId) {
  const acct = accounts[accountId];
  if (!acct || !acct.signedIn || !acct.email || !inDesktop() || isGoogleAccount(accountId)) return;
  try {
    const rows = await tauriInvoke("list_search_folders", { email: acct.email });
    if (!Array.isArray(rows)) return;
    acct.searchFolders = rows.filter(item => item && item.id).map(item => ({
      id: String(item.id),
      name: String(item.name || "Search"),
      key: "search:" + item.id,
      filter: String(item.filter || "")
    }));
    const keys = new Set(acct.searchFolders.map(item => item.key));
    const before = favorites.length;
    favorites = favorites.filter(item => item.account !== accountId || !isSearchBox(item.box) || keys.has(item.box));
    if (favorites.length !== before) rememberFavorites();
    if (account === accountId && isSearchBox(box) && !keys.has(box)) {
      box = "inbox";
      folderPick = "folder";
    }
  } catch (err) {
    acct.searchFolders = acct.searchFolders || [];
  }
}

let categoryTargets = [];

// Every attachment in the open thread, newest message first.
async function showFilesMenu(x, y, list) {
  const owners = (list || []).slice().reverse().filter(m => !m.draft && (messageFiles(m).length || m.hasAttachment));
  if (!owners.length) return;
  hideThemeMenu();
  await new Promise(r => setTimeout(r, 0));
  const menu = document.getElementById("row-menu");
  const many = owners.length > 1;
  menu.innerHTML = owners.map(m => {
    const files = messageFiles(m);
    const shownFiles = files.length ? files : [{ name: "Attachment", id: "", size: 0, unknown: true }];
    const head = many ? `<p class="menu-note files-from">${esc(m.from)} · ${esc(messageStamp(m))}</p>` : "";
    const items = shownFiles.map(file => `<button type="button" role="menuitem" class="file-item" data-file-msg="${esc(m.id)}" data-file-id="${esc(file.id || "")}" data-file-name="${esc(file.name || "Attachment")}" data-file-unknown="${file.unknown ? "1" : "0"}">${fileTypeMark(file)}<span class="file-item-name">${esc(file.name || "Attachment")}</span><span class="file-size">${esc(fileSizeLabel(file.size))}</span></button>`).join("");
    const all = files.length > 1 ? `<button type="button" role="menuitem" data-files-all="${esc(m.id)}">Download all (${files.length})</button>` : "";
    return head + items + all;
  }).join("");
  menu.dataset.menu = "files";
  menu.dataset.id = "";
  menu.setAttribute("aria-label", "Attachments");
  placeMenu(menu, x, y);
}

async function showCategoryMenu(x, y, targets) {
  const list = (targets || []).filter(m => !m.pendingSend);
  if (!list.length) return;
  const accountId = list[0].account;
  if (list.some(m => m.account !== accountId)) return toast("Categories work on one account at a time.");
  if (!accounts[accountId].categories) await loadCategories(accountId);
  const cats = accounts[accountId].categories || [];
  categoryTargets = list;
  hideThemeMenu();
  // Wait for the click that opened this to finish, or its page handler
  // would close the menu again.
  await new Promise(r => setTimeout(r, 0));
  const menu = document.getElementById("row-menu");
  menu.innerHTML = cats.length
    ? cats.map(c => {
        const on = list.every(m => (m.categories || []).includes(c.name));
        return `<button type="button" role="menuitemcheckbox" data-cat="${esc(c.name)}" aria-checked="${on}"><span class="cat-dot" style="background:${CATEGORY_COLOURS[c.color] || "#8a8886"}"></span>${esc(c.name)}</button>`;
      }).join("")
    : `<p class="menu-note">No categories yet. Add them in Outlook; they appear here.</p>`;
  menu.dataset.menu = "category";
  menu.dataset.id = "";
  menu.setAttribute("aria-label", "Categorize");
  placeMenu(menu, x, y);
}

async function toggleCategory(name) {
  const list = categoryTargets;
  if (!list.length) return;
  const adding = !list.every(m => (m.categories || []).includes(name));
  const before = list.map(m => (m.categories || []).slice());
  list.forEach(m => {
    const cats = (m.categories || []).filter(c => c !== name);
    if (adding) cats.push(name);
    m.categories = cats;
  });
  render();
  const groups = new Map();
  list.forEach(m => { if (!serverMessage(m)) return; const k = JSON.stringify(m.categories); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m.id); });
  try {
    for (const [k, ids] of groups) {
      await tauriInvoke("set_categories", { email: accounts[list[0].account].email, messageIds: ids, categories: JSON.parse(k) });
    }
  } catch (err) {
    list.forEach((m, i) => { m.categories = before[i]; });
    render();
    return toast(String(err && err.message || err));
  }
  toast((adding ? "Added " : "Removed ") + name);
}

async function addCategories(list, name) {
  const targets = (list || []).filter(m => m && !m.pendingSend && !(m.categories || []).includes(name));
  if (!targets.length || targets.some(m => m.account !== targets[0].account)) return;
  const before = targets.map(m => (m.categories || []).slice());
  targets.forEach(m => { m.categories = (m.categories || []).concat(name); });
  render();
  const groups = new Map();
  targets.forEach(m => {
    if (!serverMessage(m)) return;
    const k = JSON.stringify(m.categories);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m.id);
  });
  try {
    for (const [k, ids] of groups) {
      await tauriInvoke("set_categories", { email: accounts[targets[0].account].email, messageIds: ids, categories: JSON.parse(k) });
    }
  } catch (err) {
    targets.forEach((m, i) => { m.categories = before[i]; });
    render();
    return toast(String(err && err.message || err));
  }
  toast("Added " + name);
}

// ---- Keyboard shortcuts, after Outlook on the web ----
const SHORTCUTS = [
  ["Ctrl+N", "New message, or new event in Calendar"],
  ["Ctrl+R", "Reply"], ["Ctrl+Shift+R", "Reply all"], ["Ctrl+Shift+F", "Forward"],
  ["Ctrl+Enter", "Send, while writing"],
  ["Delete", "Delete"], ["E", "Archive"], ["V", "Move to a folder"],
  ["Ctrl+Q", "Mark as read"], ["Ctrl+U", "Mark as unread"], ["Insert", "Flag or unflag"],
  ["↓ or J", "Next conversation"], ["↑ or K", "Previous conversation"],
  ["Ctrl+A", "Select every conversation in the list"], ["Ctrl+Z", "Undo the last move"],
  ["Escape", "Clear the selection"], ["F5", "Check for new mail"], ["/", "Search"], ["?", "This list"]
];

function typingIn(el) {
  return !!(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

function currentConversation() {
  return selected ? conversationFor(selected) : null;
}

function stepConversation(dir) {
  const order = listedThreads();
  if (!order.length) return;
  const current = messages.find(m => m.id === selected);
  let at = current ? order.indexOf(current.thread) : -1;
  at = at < 0 ? (dir > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + dir));
  const row = threadLines().find(el => el.dataset.thread === order[at]);
  if (!row) return;
  picked.clear();
  selectListedMessage(row.dataset.id);
  const again = threadLines().find(el => el.dataset.thread === order[at]);
  if (again) again.scrollIntoView({ block: "nearest" });
}

function showShortcuts() {
  popRoot.innerHTML = `<div class="backdrop" id="backdrop"></div>
    <div class="dialog shortcuts-dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <h2>Keyboard shortcuts</h2>
      <dl>${SHORTCUTS.map(([k, d]) => `<dt><kbd>${esc(k)}</kbd></dt><dd>${esc(d)}</dd>`).join("")}</dl>
      <p class="field-hint">Enter never sends a message. In To, Cc and Bcc it picks a suggestion.</p>
      <div class="dialog-actions"><button class="primary" type="button" id="shortcuts-close">Close</button></div>
    </div>`;
  popRoot.querySelector("#backdrop").onclick = closePop;
  popRoot.querySelector("#shortcuts-close").onclick = closePop;
}

document.addEventListener("keydown", (ev) => {
  // The PDF viewer owns the keyboard while it is open. Escape and Ctrl+A
  // are handled as it opens; everything else, including copy, stays with
  // the page text.
  if (document.getElementById("viewer")) return;
  const ctrl = ev.ctrlKey || ev.metaKey;
  const key = ev.key;
  if (key === "F5" && !popCompose && !assistWindow) {
    // F5 checks for mail rather than reloading the window.
    ev.preventDefault();
    if (view === "mail") checkMailNow();
    else if (view === "calendar") syncCalendars(null, true).then(() => { if (view === "calendar") render(); });
    return;
  }
  // Ctrl+Enter sends from any compose form; plain Enter never does.
  if (ctrl && key === "Enter") {
    const form = ev.target.closest && ev.target.closest("#compose-form");
    if (form) {
      ev.preventDefault();
      form.requestSubmit();
    }
    return;
  }
  if (popCompose || assistWindow) return;
  if (typingIn(ev.target) || ev.altKey) return;
  if (document.getElementById("choose-layer") || document.getElementById("discard-confirm")) return;
  if (popRoot.firstElementChild) {
    // Only the shortcuts list closes here; a compose dialog keeps its text.
    if (key === "Escape" && popRoot.querySelector(".shortcuts-dialog")) closePop();
    return;
  }
  if (key === "?") { ev.preventDefault(); return showShortcuts(); }
  if (key === "/") { ev.preventDefault(); const q = document.getElementById("q"); if (q) q.focus(); return; }
  if (ctrl && (key === "n" || key === "N")) {
    const btn = document.getElementById("compose");
    if (btn) { ev.preventDefault(); btn.click(); }
    return;
  }
  if (view !== "mail") return;
  const conv = currentConversation();
  const several = picked.size > 1;
  const lower = key.length === 1 ? key.toLowerCase() : key;
  if (ctrl && lower === "z") { ev.preventDefault(); undoLastMove(); return; }
  if (ctrl && lower === "a") { ev.preventDefault(); pickAll(); return; }
  if (key === "Escape" && picked.size) { picked.clear(); render(); return; }
  if (key === "ArrowDown" || (!ctrl && lower === "j")) { ev.preventDefault(); stepConversation(1); return; }
  if (key === "ArrowUp" || (!ctrl && lower === "k")) { ev.preventDefault(); stepConversation(-1); return; }
  if (several) {
    const bulk = { Delete: "delete", e: "archive", v: "move" }[key === "Delete" ? "Delete" : lower];
    if (bulk && !ctrl) { ev.preventDefault(); bulkAction(bulk); }
    else if (ctrl && lower === "q") { ev.preventDefault(); bulkAction("read"); }
    else if (ctrl && lower === "u") { ev.preventDefault(); bulkAction("unread"); }
    return;
  }
  if (!conv) return;
  const latest = conv.latest;
  if (ctrl && lower === "r") { ev.preventDefault(); startReply(latest, ev.shiftKey); return; }
  if (ctrl && ev.shiftKey && lower === "f") { ev.preventDefault(); startForward(latest); return; }
  if (ctrl && lower === "q") { ev.preventDefault(); setUnread(conv.messages, false, true); return; }
  if (ctrl && lower === "u") { ev.preventDefault(); setUnread([latest], true, true); return; }
  if (ctrl) return;
  if (key === "Delete") {
    ev.preventDefault();
    if (messageBox(latest) === "trash") return;
    moveConversation(conv, "trash");
    toastMove("Moved to Trash");
  } else if (lower === "e") {
    const where = messageBox(latest);
    if (where === "archive" || where === "trash" || latest.draft) return;
    ev.preventDefault();
    moveConversation(conv, "archive");
    toastMove("Archived");
  } else if (lower === "v") {
    ev.preventDefault();
    showMoveDialog(conv.messages.filter(m => messageBox(m) === messageBox(latest)));
  } else if (key === "Insert") {
    ev.preventDefault();
    toggleFlag(latest.id);
  }
});

let draggedMail = null;

// WebKitGTK draws the native drag image at device pixels, so on a scaled
// display the row grows by the scale. Hide it and move a copy of the row,
// at its real size, with the pointer instead.
let mailGhost = null;
const blankDragImage = document.createElement("span");
blankDragImage.className = "drag-blank";

function startMailGhost(row, ev) {
  endMailGhost();
  const rect = row.getBoundingClientRect();
  const ghost = row.cloneNode(true);
  ghost.removeAttribute("id");
  ghost.querySelectorAll("[id]").forEach(el => el.removeAttribute("id"));
  ghost.classList.add("mail-ghost");
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.width = rect.width + "px";
  mailGhost = { el: ghost, dx: ev.clientX - rect.left, dy: ev.clientY - rect.top };
  moveMailGhost(ev.clientX, ev.clientY);
  document.body.append(ghost, blankDragImage);
  ev.dataTransfer.setDragImage(blankDragImage, 0, 0);
}

function moveMailGhost(x, y) {
  if (!mailGhost) return;
  mailGhost.el.style.transform = `translate(${x - mailGhost.dx}px, ${y - mailGhost.dy}px)`;
}

function endMailGhost() {
  if (mailGhost) mailGhost.el.remove();
  mailGhost = null;
  blankDragImage.remove();
}

document.addEventListener("dragover", (ev) => {
  if (mailGhost && (ev.clientX || ev.clientY)) moveMailGhost(ev.clientX, ev.clientY);
}, true);

// The folder a dragged message would land in, in its own account.
function dropFolder(el) {
  if (!draggedMail || !el) return "";
  const msg = messages.find(m => m.id === draggedMail.id);
  if (!msg) return "";
  const acct = el.dataset.acct;
  const key = el.dataset.box;
  if (acct !== "all" && acct !== msg.account) return "";
  if (isCategoryBox(key) || isSearchBox(key)) return "";
  if (!knownFolder(msg.account, key) || key === "drafts" || key === "outbox" || key === messageBox(msg)) return "";
  return key;
}

function dropCategory(el) {
  if (!draggedMail || !el || !el.dataset.catName) return "";
  const msg = messages.find(m => m.id === draggedMail.id);
  if (!msg || msg.pendingSend) return "";
  if (el.dataset.acct !== "all" && el.dataset.acct !== msg.account) return "";
  if ((msg.categories || []).includes(el.dataset.catName)) return "";
  return el.dataset.catName;
}

folders.addEventListener("dragover", (ev) => {
  const cat = ev.target.closest("[data-cat-name]");
  const el = ev.target.closest("[data-box][data-acct]");
  folders.querySelectorAll(".drop-into").forEach(item => { if (item !== el && item !== cat) item.classList.remove("drop-into"); });
  if (cat && dropCategory(cat)) {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    cat.classList.add("drop-into");
    return;
  }
  if (!dropFolder(el)) return;
  ev.preventDefault();
  ev.dataTransfer.dropEffect = "move";
  el.classList.add("drop-into");
});
folders.addEventListener("dragleave", (ev) => {
  const el = ev.target.closest("[data-box][data-acct], [data-cat-name]");
  if (el && !el.contains(ev.relatedTarget)) el.classList.remove("drop-into");
});
folders.addEventListener("drop", (ev) => {
  const cat = ev.target.closest("[data-cat-name]");
  const catName = dropCategory(cat);
  const el = ev.target.closest("[data-box][data-acct]");
  const key = dropFolder(el);
  folders.querySelectorAll(".drop-into").forEach(item => item.classList.remove("drop-into"));
  if (!draggedMail) return;
  if (catName) {
    ev.preventDefault();
    const targets = rowTargets(draggedMail.id, draggedMail.child);
    draggedMail = null;
    endMailGhost();
    addCategories(targets, catName);
    return;
  }
  if (!key) return;
  ev.preventDefault();
  const targets = rowTargets(draggedMail.id, draggedMail.child);
  draggedMail = null;
  endMailGhost();
  moveToFolder(targets, key);
});

function selectListedMessage(id) {
  const msg = messages.find(m => m.id === id);
  if (!msg) return;
  const conv = conversations().find(c => c.id === msg.thread);
  if (!conv) return;
  const current = messages.find(m => m.id === selected);
  if (!current || current.thread !== conv.id) {
    expanded.clear();
    folded.clear();
  }
  selected = msg.id;
  folded.delete(msg.id);
  expanded.add(msg.id);
  revealReading = true;
  if (msg.draft) focusReply = true;
  document.body.dataset.open = "1";
  const targets = conv.latest.id === msg.id
    ? conv.messages.filter(m => m.account === msg.account && messageBox(m) === messageBox(msg))
    : [msg];
  if (targets.some(m => m.unread)) setUnread(targets, false, false);
  else render();
}

const replyIcon = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M8 5.4L3.6 9.6 8 13.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.4 9.6h7.2a4.4 4.4 0 014.4 4.4V16.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const replyAllIcon = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M7.4 5L3.4 8.8 7.4 12.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.6 5L7.6 8.8 11.6 12.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.2 8.8h4.4a3.8 3.8 0 013.8 3.8V16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const forwardIcon = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M12 5.4L16.4 9.6 12 13.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.6 9.6H8.4A4.4 4.4 0 004 14V16.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const replyInviteIcon = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 8.4L3.6 11.6 7 14.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.4 11.6h5a3.2 3.2 0 013.2 3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><rect x="11.2" y="2.6" width="6.4" height="5.6" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M11.2 4.6h6.4M13 1.8v1.6M16 1.8v1.6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
const mailIcon = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3.2 6.2h13.6v9.2H3.2V6.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M3.6 6.6L10 11.4l6.4-4.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

function messageInstant(m) {
  if (m.received) {
    const parsed = new Date(m.received);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (m.date && /^\d{4}-\d{2}-\d{2}$/.test(m.date)) {
    const [year, month, day] = m.date.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    const clock = /^(\d{1,2}):(\d{2})$/.exec(String(m.time || ""));
    if (clock) date.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    return date;
  }
  return null;
}

function messageHasClock(m) {
  if (m.received && !Number.isNaN(new Date(m.received).getTime())) return true;
  return /^(\d{1,2}):(\d{2})$/.test(String(m.time || ""));
}

function messageStamp(m) {
  const status = String(m.time || "");
  if (/^(Draft|Sending|Outbox|Now)$/.test(status)) return status;
  const date = messageInstant(m);
  if (!date) return status;
  const weekday = date.toLocaleDateString([], { weekday: "short" });
  const numeric = date.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" });
  if (!messageHasClock(m)) return weekday + " " + numeric;
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return weekday + " " + numeric + " " + time;
}

function senderMail(m) {
  const email = String(m.email || "").trim();
  if (!email) return "";
  if (email.toLowerCase() === String(m.from || "").trim().toLowerCase()) return "";
  return email;
}

// A work Microsoft mailbox marks mail from outside its own domains.
function senderExternal(m) {
  if (!m || !accounts[m.account]) return false;
  if (messageBox(m) === "sent" || messageBox(m) === "drafts" || messageBox(m) === "outbox") return false;
  const acct = accounts[m.account];
  if (acct.provider === "google" || accountProfile(m.account) !== "work") return false;
  const email = String(m.email || "").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  const domain = email.slice(at + 1);
  const mine = new Set();
  const add = value => {
    const addr = String(value || "").trim().toLowerCase();
    const cut = addr.lastIndexOf("@");
    if (cut > 0) mine.add(addr.slice(cut + 1));
  };
  add(acct.email);
  (acct.emails || []).forEach(item => add(item.address));
  (acct.aliases || []).forEach(add);
  return !mine.has(domain);
}

function externalPill(m) {
  return senderExternal(m) ? `<span class="pill external">External</span>` : "";
}

function messageBlock(m, open, many) {
  const chevron = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.2 2.2L8 6 4.2 9.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const stamp = messageStamp(m);
  const whenClass = stamp === "Draft" ? "when draft-when" : "when";
  if (!open) {
    return `<button class="thread-card folded" type="button" data-fold="${m.id}" aria-expanded="false">
      <span class="thread-chevron" aria-hidden="true">${chevron}</span>
      <span class="avatar" style="background:${esc(m.color)}">${esc(m.initials)}</span>
      <span class="fold-copy"><span class="who">${esc(m.from)}</span><span class="preview">${esc(m.preview)}</span></span>
      <span class="fold-side">${foldClip(m)}<span class="${whenClass}">${esc(stamp)}</span></span>
    </button>`;
  }
  const outgoing = !!m.meeting && (messageBox(m) === "sent" || ownAddresses().has((m.email || "").toLowerCase()));
  const answered = m.liveInvite ? m.liveInvite.response : rsvp;
  const closed = m.liveInvite && (m.liveInvite.cancelled || m.liveInvite.organizer);
  const invite = m.meeting ? `
    <div class="invite">
      <div class="when-block">${esc(m.meeting.title)}</div>
      <div>${esc(m.meeting.when)}</div>
      ${m.meeting.where ? `<div>${esc(m.meeting.where)}</div>` : ""}
      ${outgoing || closed ? "" : inviteClashHtml(m)}
      ${outgoing ? `<div class="invite-note">Invite sent</div>` : closed ? `<div class="invite-note">${m.liveInvite.cancelled ? "This meeting was cancelled." : "You organise this meeting."}</div>` : `
      <div class="rsvp" role="group" aria-label="Respond" data-rsvp-msg="${esc(m.id)}">
        ${["accepted", "tentative", "declined"].map(key => `
          <button type="button" data-rsvp="${key}" aria-pressed="${answered === key}">${label(key)}</button>
        `).join("")}
      </div>`}
    </div>` : "";
  const collapse = many
    ? `<button class="thread-chevron" type="button" data-collapse="${m.id}" aria-expanded="true" title="Collapse" aria-label="Collapse">${chevron}</button>`
    : "";
  const flagged = m.flagged ? `<span class="flag" title="Flagged" aria-label="Flagged"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.8 1.2v9.2M2.8 1.6h6.4L7.2 4.2 9.2 6.8H2.8" fill="currentColor"/></svg></span>` : "";
  return `<article class="thread-card${m.id === selected ? " on" : ""}" data-pick="${m.id}">
    <header class="thread-head${many ? " has-chevron" : ""}">
      ${collapse}
      <span class="avatar" style="background:${esc(m.color)}">${esc(m.initials)}</span>
      <div class="thread-id">
        <div class="who-line"><button class="party-name" type="button" data-party="${esc(m.id)}" data-party-role="from"><span class="who-name">${esc(m.from)}</span>${senderMail(m) ? `<span class="sender-mail">${esc(senderMail(m))}</span>` : ""}</button><span class="pill ${accounts[m.account].cls}">${esc(accounts[m.account].name)}</span>${externalPill(m)}${flagged}${messageBox(m) === "sent" && box !== "sent" ? `<span class="from-folder">Sent Items</span>` : ""}${categoryPills(m)}</div>
        <button class="party-line" type="button" data-party="${esc(m.id)}" data-party-role="to">${esc(audience(m))}</button>
      </div>
      <div class="thread-side">
        <span class="${whenClass}">${esc(stamp)}</span>
        <button class="icon-btn light-toggle" type="button" data-light-view="${esc(m.id)}" aria-pressed="${lightView.has(m.id)}" title="${lightView.has(m.id) ? "Show in dark mode" : "Show with a light background"}" aria-label="${lightView.has(m.id) ? "Show in dark mode" : "Show with a light background"}"><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="3.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 2.6v2M10 15.4v2M2.6 10h2M15.4 10h2M4.8 4.8l1.4 1.4M13.8 13.8l1.4 1.4M15.2 4.8l-1.4 1.4M6.2 13.8l-1.4 1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
        <div class="thread-actions"${many ? "" : " hidden"}>
          <button class="icon-btn" type="button" data-reply="${m.id}" title="Reply" aria-label="Reply">${replyIcon}</button>
          <button class="icon-btn" type="button" data-reply-all="${m.id}" title="Reply all" aria-label="Reply all">${replyAllIcon}</button>
          <button class="icon-btn" type="button" data-forward="${m.id}" title="Forward" aria-label="Forward">${forwardIcon}</button>
        </div>
      </div>
    </header>
    ${unsubscribeBar(m)}
    ${m.importance === "high" ? `<p class="importance-note high">This message was sent with High importance.</p>` : m.importance === "low" ? `<p class="importance-note">This message was sent with Low importance.</p>` : ""}
    ${messageFileRow(m)}
    ${invite}
    ${remoteBar(m)}
    <div class="letter${m.bodyHtml ? " mail-fit" : ""}${lightView.has(m.id) ? " light-view" : ""}">${m.bodyHtml ? `<div class="letter-fit">${letterHtml(m)}</div>` : letterHtml(m)}</div>
  </article>`;
}

function selfAddress(id) {
  return (accounts[id] && accounts[id].email) || "jon@timberworks.example";
}

function initialsFor(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map(part => part[0]).join("").toUpperCase() || "J";
}

function ownAddresses() {
  const set = new Set();
  Object.values(accounts).forEach(acct => {
    (acct.emails || []).forEach(item => {
      if (item.address) set.add(item.address.toLowerCase());
    });
    if (acct.email) set.add(acct.email.toLowerCase());
  });
  return set;
}

function recipientLabel(email) {
  const person = knownPeople().find(item => item.email.toLowerCase() === String(email).toLowerCase());
  return person ? person.name : email;
}

function addressText(value) {
  return Array.isArray(value) ? value.join(" ") : String(value || "");
}

function knownPeople() {
  const own = ownAddresses();
  const byEmail = new Map();
  function add(email, name, source) {
    const trimmed = String(email || "").trim();
    const key = trimmed.toLowerCase();
    if (!key || own.has(key) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) return;
    // A display name is only a name: brackets and quotes in one could pass
    // for an address when it is written back into a recipient field.
    const clean = String(name || "").replace(/[<>"]/g, "").replace(/\s+/g, " ").trim();
    const named = clean && clean.toLowerCase() !== key;
    const existing = byEmail.get(key);
    if (!existing) {
      byEmail.set(key, { email: trimmed, name: named ? clean : "", contact: source === "contact", mail: source === "mail" || source === "sent", directory: source === "directory", sent: source === "sent" });
      return;
    }
    if (source === "contact") existing.contact = true;
    if (source === "directory") existing.directory = true;
    if (source === "mail" || source === "sent") existing.mail = true;
    if (source === "sent") existing.sent = true;
    if (source === "contact" && named) existing.name = clean;
    else if (!existing.name && named) existing.name = clean;
  }
  contacts.forEach(person => { if (accountInProfile(person.account)) add(person.email, person.name, "contact"); });
  directoryPeople.forEach(person => add(person.email, person.name, "directory"));
  messages.forEach(msg => {
    if (!accountInProfile(msg.account)) return;
    const box = messageBox(msg);
    // Junk teaches nothing. People you wrote to rank above people who only
    // wrote to you (or were copied by a stranger).
    if (folderKind(box, msg.account) === "junk") return;
    const source = box === "sent" || box === "outbox" || box === "drafts" ? "sent" : "mail";
    add(msg.email, msg.from, "mail");
    const to = String(msg.to || "").split(/[;,]/).map(part => part.trim()).filter(Boolean);
    to.forEach(email => add(email, to.length === 1 ? msg.toName : "", source));
    String(addressText(msg.cc)).split(/[;,]/).forEach(part => add(part.trim(), "", source));
    String(addressText(msg.bcc)).split(/[;,]/).forEach(part => add(part.trim(), "", source));
    ["toPeople", "ccPeople", "bccPeople"].forEach(key => {
      (msg[key] || []).forEach(person => add(person.email, person.name, source));
    });
  });
  return [...byEmail.values()].map(person => ({
    email: person.email,
    name: person.name || person.email,
    contact: person.contact,
    directory: person.directory,
    sent: person.sent,
    mail: person.mail
  }));
}

// People Microsoft ranks for each account, and directory search results.
const directoryPeople = new Map();
const directorySearched = new Set();

function addDirectory(list) {
  (list || []).forEach(person => {
    const key = String(person.email || "").toLowerCase();
    if (key && !directoryPeople.has(key)) directoryPeople.set(key, { name: person.name || "", email: person.email });
  });
}

async function loadDirectory() {
  for (const id of profileAccountIds()) {
    const acct = accounts[id];
    if (!acct || !acct.signedIn || !acct.email) continue;
    try { addDirectory(await tauriInvoke("people", { email: acct.email, query: "" })); } catch (e) {}
  }
}

// Search the directory for what is being typed, once per query.
async function searchDirectory(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!inDesktop() || q.length < 2 || directorySearched.has(q)) return false;
  directorySearched.add(q);
  let found = false;
  for (const id of profileAccountIds()) {
    const acct = accounts[id];
    if (!acct || !acct.signedIn || !acct.email) continue;
    try {
      const list = await tauriInvoke("people", { email: acct.email, query: q });
      if (list && list.length) { addDirectory(list); found = true; }
    } catch (e) {}
  }
  return found;
}

function peopleMatches(query, limit) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [];
  return knownPeople().filter(person => (person.name + " " + person.email).toLowerCase().includes(needle)).sort((a, b) => {
    const rank = (person) => {
      const start = person.name.toLowerCase().startsWith(needle) || person.email.toLowerCase().startsWith(needle) ? 0 : 1;
      // Saved contacts, then colleagues in the directory, then people you
      // have written to; someone known only from received mail comes last.
      const source = person.contact ? 0 : person.directory ? 1 : person.sent ? 2 : 3;
      return start * 10 + source;
    };
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  }).slice(0, limit || 6);
}

function personSuggestHtml(hits) {
  return hits.map(person => {
    const note = person.contact ? person.email : person.directory ? person.email + " · Directory" : person.mail ? person.email + " · In your mail" : person.email + " · Directory";
    return `<button type="button" data-email="${esc(person.email)}" data-name="${esc(person.name)}"><span>${esc(person.name)}</span><small>${esc(note)}</small></button>`;
  }).join("");
}

function addressParts(raw) {
  const text = String(raw || "");
  const out = [];
  const re = /(?:"[^"]*"|[^"<,;])*?<[^>]*>|[^,;]+/g;
  let match;
  while ((match = re.exec(text))) {
    const part = match[0].trim();
    if (part) out.push(part);
  }
  // "Wagstaffe, Jane <jane@x.org>": a name with a comma is one address.
  // Rejoin a piece with no @ to the "<address>" piece that follows it.
  const joined = [];
  const bare = part => !part.includes("@") && !/[<>]/.test(part);
  const named = part => /^[^<@]*<[^>]+@[^>]+>$/.test(part);
  for (let i = 0; i < out.length; i++) {
    if (bare(out[i])) {
      // A run of name pieces ("Smith", "Ann", "Jr <ann@x>") is one address.
      let j = i + 1;
      while (j < out.length && bare(out[j])) j++;
      if (j < out.length && named(out[j])) {
        joined.push(out.slice(i, j + 1).join(", "));
        i = j;
        continue;
      }
    }
    joined.push(out[i]);
  }
  return joined;
}

// The address is the last <…> outside quotes: "Kai, <a@x>" <b@y> is b@y.
function addressEmail(part) {
  const text = String(part || "").trim().replace(/^mailto:/i, "");
  const all = [...text.replace(/"[^"]*"/g, "").matchAll(/<([^<>]+)>/g)];
  const wrapped = all.length ? all[all.length - 1] : null;
  const inner = (wrapped ? wrapped[1] : text).trim();
  if (!wrapped) return inner;
  const found = inner.match(/[^\s<>"']+@[^\s<>"']+/);
  return found ? found[0] : inner;
}

function parseAddresses(value) {
  const seen = new Set();
  const out = [];
  addressParts(value).forEach(part => {
    const email = addressEmail(part);
    const key = email.toLowerCase();
    if (!email || seen.has(key)) return;
    seen.add(key);
    out.push(email);
  });
  return out;
}

function addressList(...groups) {
  const own = ownAddresses();
  const seen = new Set();
  const out = [];
  groups.flat().forEach(raw => {
    parseAddresses(raw).forEach(email => {
      const key = email.toLowerCase();
      if (!email || seen.has(key) || own.has(key)) return;
      seen.add(key);
      out.push(email);
    });
  });
  return out;
}

function recipientFieldValue(value) {
  return parseAddresses(value).map(email => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
    const name = String(recipientLabel(email) || "").replace(/[<>"]/g, "").trim();
    if (!name || name.toLowerCase() === email.toLowerCase()) return email;
    // Quote a name with a comma or semicolon so it stays one address.
    const shown = /[,;]/.test(name) ? '"' + name + '"' : name;
    return shown + " <" + email + ">";
  }).join("; ");
}

function recipientBits(email) {
  const name = recipientLabel(email);
  const showName = name && name.toLowerCase() !== String(email).toLowerCase();
  if (!showName) return `<span class="recip-mail">${esc(email)}</span>`;
  return `<span class="recip-name">${esc(name)}</span> <span class="recip-mail">${esc(email)}</span>`;
}

function replyRecipients(msg, all) {
  const own = ownAddresses();
  const fromSelf = own.has((msg.email || "").toLowerCase());
  const sender = fromSelf ? "" : (msg.email || "");
  const list = all ? addressList(sender, msg.to) : addressList(sender || msg.to);
  return list.join("; ");
}

// Reply all keeps the original Cc on Cc, without anyone already on To.
function replyCcRecipients(msg, to) {
  const onTo = new Set(parseAddresses(to).map(e => e.toLowerCase()));
  return addressList(msg.cc).filter(e => !onTo.has(e.toLowerCase())).join("; ");
}

function partyPeople(msg, key) {
  const rich = msg[key + "People"];
  if (Array.isArray(rich) && rich.length) {
    return rich.filter(person => person && String(person.email || "").trim()).map(person => ({
      name: String(person.name || "").trim(),
      email: String(person.email || "").trim()
    }));
  }
  const raw = msg[key];
  if (Array.isArray(raw)) {
    return raw.map(item => {
      if (item && typeof item === "object") return { name: String(item.name || "").trim(), email: String(item.email || "").trim() };
      return { name: "", email: String(item || "").trim() };
    }).filter(person => person.email);
  }
  return String(raw || "").split(/[;,]/).map(part => part.trim()).filter(Boolean).map(email => ({ name: "", email }));
}

function messageParties(msg) {
  const from = { name: String(msg.from || "").trim(), email: String(msg.email || "").trim() };
  const own = ownAddresses();
  const to = partyPeople(msg, "to");
  const cc = partyPeople(msg, "cc");
  const bcc = partyPeople(msg, "bcc");
  const listed = new Set([...to, ...cc, ...bcc].map(person => person.email.toLowerCase()));
  const fromSelf = own.has(from.email.toLowerCase()) || messageBox(msg) === "sent" || messageBox(msg) === "outbox";
  if (!fromSelf && ![...listed].some(email => own.has(email))) {
    const acct = accounts[msg.account];
    const mine = acct && String(acct.email || "").trim();
    if (mine) to.unshift({ name: acct.yourName || acct.name || "", email: mine });
  }
  return { from, to, cc, bcc };
}

function partyDisplayName(person) {
  const named = String(person.name || "").trim();
  if (named && named.toLowerCase() !== person.email.toLowerCase()) return named;
  const label = recipientLabel(person.email);
  if (label && label.toLowerCase() !== String(person.email || "").toLowerCase()) return label;
  return named || person.email;
}

function partyRow(person) {
  const email = String(person.email || "").trim();
  if (!email) return "";
  const name = partyDisplayName(person);
  return `<div class="party-row">
    <div class="party-copy"><strong>${esc(name)}</strong><span class="party-mail">${esc(email)}</span></div>
    <button type="button" data-copy="${esc(email)}">Copy</button>
  </div>`;
}

function partyCardHtml(msg) {
  const parties = messageParties(msg);
  const section = (label, people) => {
    const rows = people.map(partyRow).join("");
    if (!rows) return "";
    return `<h3>${label}</h3>${rows}`;
  };
  const from = partyRow(parties.from);
  return `${from ? `<h3>From</h3>${from}` : ""}${section("To", parties.to)}${section("Cc", parties.cc)}${section("Bcc", parties.bcc)}`;
}

function hidePartyCard() {
  const card = document.getElementById("party-card");
  if (card) card.remove();
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-1000px";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) {}
  area.remove();
  return ok;
}

function showPartyCard(msg, anchor) {
  const open = document.getElementById("party-card");
  const role = anchor.dataset.partyRole || "";
  if (open && open.dataset.id === msg.id && open.dataset.role === role) {
    hidePartyCard();
    return;
  }
  hidePartyCard();
  const card = document.createElement("div");
  card.id = "party-card";
  card.className = "party-card";
  card.dataset.id = msg.id;
  card.dataset.role = role;
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Email addresses");
  card.innerHTML = partyCardHtml(msg);
  document.body.appendChild(card);
  const rect = anchor.getBoundingClientRect();
  const box = card.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 6;
  if (top + box.height > innerHeight - 8) top = Math.max(8, rect.top - box.height - 6);
  if (left + box.width > innerWidth - 8) left = innerWidth - box.width - 8;
  card.style.left = Math.max(8, left) + "px";
  card.style.top = Math.max(8, top) + "px";
  card.querySelectorAll("[data-copy]").forEach(btn => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const email = btn.dataset.copy || "";
      if (!email) return;
      const ok = await copyText(email);
      toast(ok ? "Copied" : "Could not copy");
    };
  });
  card.querySelectorAll(".party-mail").forEach(mail => {
    mail.onclick = () => {
      const range = document.createRange();
      range.selectNodeContents(mail);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    };
  });
}

function audience(msg) {
  const own = ownAddresses();
  const fromSelf = own.has((msg.email || "").toLowerCase()) || messageBox(msg) === "sent";
  const to = addressList(msg.to).map(recipientLabel);
  const cc = addressList(msg.cc).map(recipientLabel);
  const bcc = addressList(msg.bcc).map(recipientLabel);
  const parts = [];
  if (fromSelf) parts.push("To: " + (to.join(", ") || "someone"));
  else parts.push("To: " + ["me", ...to].join(", "));
  if (cc.length) parts.push("Cc: " + cc.join(", "));
  if (fromSelf && bcc.length) parts.push("Bcc: " + bcc.join(", "));
  return parts.join("; ");
}

// Parsed in an inert document: an <img> made in the live one starts loading
// at once, before the remote-picture block has had its say.
function plainFromHtml(html) {
  const doc = new DOMParser().parseFromString(htmlFor(html || ""), "text/html");
  return (doc.body ? doc.body.textContent : "").replace(/\s+/g, " ").trim();
}

function subjectLabel(value) {
  const text = String(value || "").trim();
  return text && text !== "(No subject)" ? text : "(No subject)";
}

function subjectFieldValue(value) {
  const text = String(value || "").trim();
  return text === "(No subject)" ? "" : text;
}

function paintOpenSubject(message) {
  const conv = conversationFor(message.id);
  if (!conv || conv.latest.id !== message.id) return;
  const topic = cleanSubject(message.subject) || "(No subject)";
  const heading = reading.querySelector(".read-subject h2");
  if (heading) heading.textContent = topic;
  document.querySelectorAll(".row").forEach(row => {
    if (row.dataset.thread !== message.thread || row.classList.contains("child")) return;
    const slot = row.querySelector(".subject");
    if (slot) slot.textContent = topic;
  });
}

function syncDraftMessage() {
  if (!replyDraft || !replyDraft.draftId) return;
  const draft = messages.find(m => m.id === replyDraft.draftId);
  if (!draft) return;
  draft.account = fromAccountId(replyDraft.from) || draft.account;
  draft.sendFrom = sendFromAddress(replyDraft.from);
  draft.to = replyDraft.to;
  draft.cc = replyDraft.cc || "";
  draft.bcc = replyDraft.bcc || "";
  draft.attachments = replyDraft.attachments || [];
  draft.subject = subjectLabel(replyDraft.subject);
  draft.bodyHtml = replyDraft.bodyHtml;
  draft.body = plainFromHtml(replyDraft.bodyHtml);
  draft.meeting = replyDraft.meeting || null;
  draft.compose = replyDraft.compose || "";
  draft.staged = replyDraft.staged || {};
  if (!draft.live && replyDraft.serverDraftId) {
    draft.serverDraftId = replyDraft.serverDraftId;
    draft.serverDraftMode = replyDraft.serverDraftMode || "";
  }
  draft.preview = draft.body.slice(0, 90) || (draft.meeting ? describeSlot(draft.meeting) : "Draft");
  const person = contacts.find(c => c.email === draft.to);
  draft.toName = person ? person.name : (draft.to || "");
  paintOpenSubject(draft);
}

function captureReplyDraft() {
  const form = reading.querySelector("#compose-form");
  if (!form || !replyDraft || form.dataset.msg !== replyDraft.msgId) return;
  replyDraft.to = parseAddresses(form.querySelector("#compose-to").value).join("; ");
  replyDraft.cc = parseAddresses(form.querySelector("#compose-cc").value).join("; ");
  replyDraft.bcc = parseAddresses(form.querySelector("#compose-bcc").value).join("; ");
  replyDraft.attachments = [...form.querySelectorAll("#compose-files [data-name]")].map(el => el.dataset.name);
  replyDraft.from = formFromValue(form);
  replyDraft.subject = form.querySelector("#compose-subject").value;
  replyDraft.bodyHtml = form.querySelector("#compose-body").innerHTML;
  if (form.querySelector("#compose-invite")) replyDraft.meeting = readInvite(form);
  syncDraftMessage();
}

function removeDraft(id) {
  const i = messages.findIndex(m => m.id === id);
  if (i >= 0) messages.splice(i, 1);
  if (selected === id) selected = conversations()[0]?.latest.id || null;
}

function localDateKey(date) {
  const day = date || todayDate();
  return day.getFullYear() + "-" + String(day.getMonth() + 1).padStart(2, "0") + "-" + String(day.getDate()).padStart(2, "0");
}

function recordSent(fields) {
  return queueOutgoing(fields, 0);
}

function queueOutgoing(fields, delay) {
  const accountId = fromAccountId(fields && fields.from);
  if (!fields || !accountId) return null;
  // A scheduled message goes to the server now; Microsoft holds it.
  const wait = fields.sendAt ? 0 : (Number.isInteger(delay) && delay >= 0 && delay <= SEND_DELAY_MAX ? delay : sendDelay);
  const text = plainFromHtml(fields.bodyHtml);
  const person = contacts.find(c => c.email === fields.to);
  const now = Date.now();
  const fromName = (accounts[accountId] && accounts[accountId].yourName) || "Jon";
  const sentFrom = sendFromAddress(fields.from);
  // A reply belongs to the conversation it answers, from the moment it is sent.
  const answering = fields.replyTo ? messages.find(m => m.id === fields.replyTo) : null;
  const serial = (queueOutgoing.serial = (queueOutgoing.serial || 0) + 1);
  const message = {
    id: "out-" + now + "-" + serial,
    thread: answering && answering.thread && answering.account === accountId ? answering.thread : "out-" + now + "-" + serial,
    seq: now,
    box: wait > 0 ? "outbox" : "sent",
    pendingSend: wait > 0,
    sendAt: wait > 0 ? now + wait * 1000 : 0,
    account: accountId,
    from: fromName,
    email: sentFrom || selfAddress(accountId),
    sendFrom: sentFrom,
    initials: initialsFor(fromName),
    color: "#394146",
    subject: fields.subject || "(No subject)",
    preview: text.slice(0, 90) || (fields.meeting ? describeSlot(fields.meeting) : (wait > 0 ? "Sending" : "Sent")),
    time: wait > 0 ? delayPhrase(wait) : "Now",
    date: localDateKey(todayDate()),
    attachments: fields.attachments || [],
    unread: false,
    to: fields.to,
    cc: fields.cc || "",
    bcc: fields.bcc || "",
    toName: person ? person.name : (fields.to || ""),
    body: text || "(No message)",
    bodyHtml: fields.bodyHtml || "",
    draftHtml: fields.draftHtml || fields.bodyHtml || "",
    replyTo: fields.replyTo || "",
    replyMode: fields.replyMode || "",
    serverDraftId: fields.serverDraftId || "",
    sendLater: fields.sendAt || "",
    importance: fields.importance || "",
    readReceipt: !!fields.readReceipt,
    followUp: Number(fields.followUp) || 0,
    files: Array.isArray(fields.files) ? fields.files : [],
    invite: wait > 0 ? (fields.meeting || null) : null,
    meeting: fields.meeting ? {
      title: fields.meeting.title,
      when: describeSlot(fields.meeting),
      where: fields.meeting.where || ""
    } : null
  };
  if (fields.draftId) removeDraft(fields.draftId);
  messages.push(message);
  if (wait > 0) {
    rememberOutbox();
    armPendingTimer();
  } else if (inDesktop()) {
    message.pendingSend = true;
    message.box = "outbox";
    message.invite = fields.meeting || null;
    message.sending = false;
    rememberOutbox();
    deliverPending(message);
  } else if (fields.meeting) fileInvite(fields);
  return message;
}

function pendingLeft(message) {
  if (!message || !message.sendAt) return 0;
  return Math.max(0, Math.ceil((message.sendAt - Date.now()) / 1000));
}

function pendingHoldHtml(message) {
  if (message.sendError) {
    // A failed send says why, and offers to try again or to edit it.
    return `<p class="send-hold send-failed" id="send-hold" role="alert"><span id="send-hold-text">Not sent. ${esc(message.sendError)}</span><button type="button" id="retry-send">Send again</button><button type="button" id="undo-send">Edit</button></p>`;
  }
  if (message.sending) {
    return `<p class="send-hold" id="send-hold" role="status"><span id="send-hold-text">Sending…</span></p>`;
  }
  const left = pendingLeft(message);
  return `<p class="send-hold" id="send-hold" role="status"><span id="send-hold-text">Sending in ${delayPhrase(left)}.</span><button type="button" id="undo-send">Undo</button></p>`;
}

function retryPending(id) {
  const message = messages.find(m => m.id === id && m.pendingSend);
  if (!message || message.sending) return;
  if (message.sendError === SEND_AGAIN && accountNeedsSignIn(message.account)) {
    toast(SEND_AGAIN);
    return;
  }
  message.sendError = "";
  message.sendAt = Date.now();
  message.time = "Sending";
  message.preview = plainFromHtml(message.bodyHtml || "").slice(0, 90) || "Sending";
  rememberOutbox();
  armPendingTimer();
  render();
  deliverPending(message);
}

let pendingTimer = 0;

function armPendingTimer() {
  if (pendingTimer) return;
  pendingTimer = setInterval(tickPendingSends, 1000);
}

function stopPendingTimerIfIdle() {
  if (messages.some(m => m.pendingSend && !m.sendError)) return;
  if (!pendingTimer) return;
  clearInterval(pendingTimer);
  pendingTimer = 0;
}

function bodyForSend(message) {
  const html = String(message && message.bodyHtml || "");
  if (!html.includes("data-sig-src")) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(".body-sig[data-sig-src]").forEach(el => {
    const raw = storedSignatureSource(el);
    el.removeAttribute("data-sig-src");
    // The source may have come in a received mail: send only its clean form.
    if (raw) el.innerHTML = signatureSendable(raw);
    el.querySelectorAll("p").forEach(para => { if (!/margin/i.test(para.getAttribute("style") || "")) para.setAttribute("style", ((para.getAttribute("style") || "") + " margin: 0;").trim()); });
  });
  return doc.body.innerHTML;
}

// The Outbox belongs to the main window. A pop-out that restored it too
// would send the same mail again, or save over the main window's list.
function ownsOutbox() {
  return inDesktop() && !popCompose && !assistWindow;
}

function rememberOutbox() {
  if (!ownsOutbox()) return;
  const rows = messages.filter(m => m.pendingSend && String(m.id || "").startsWith("out-")).map(m => ({
    id: m.id,
    account: m.account,
    // The mailbox it was written for. An id is made from an account's name,
    // so a different mailbox can come to have it.
    accountEmail: String(m.accountEmail || (accounts[m.account] || {}).email || "").toLowerCase(),
    subject: m.subject || "",
    bodyHtml: m.bodyHtml || "",
    to: m.to || "",
    cc: m.cc || "",
    bcc: m.bcc || "",
    sendAt: m.sendAt || 0,
    sendError: m.sendError || "",
    meeting: m.meeting || null,
    invite: m.invite || null,
    attachments: m.attachments || [],
    replyTo: m.replyTo || "",
    replyMode: m.replyMode || "",
    serverDraftId: m.serverDraftId || "",
    sendLater: m.sendLater || "",
    importance: m.importance || "",
    readReceipt: !!m.readReceipt,
    followUp: Number(m.followUp) || 0,
    files: m.files || [],
    sendFrom: m.sendFrom || ""
  }));
  try { localStorage.setItem("mailroom-outbox", JSON.stringify(rows)); } catch (e) {}
}

function restoreOutbox() {
  if (!ownsOutbox()) return;
  let rows = [];
  try { rows = JSON.parse(localStorage.getItem("mailroom-outbox") || "[]"); } catch (e) { return; }
  if (!Array.isArray(rows)) return;
  rows.forEach(row => {
    if (!row || !row.id || !accounts[row.account] || messages.some(m => m.id === row.id)) return;
    const mailbox = String(accounts[row.account].email || "").toLowerCase();
    // Written for another mailbox: never send it from this one.
    if (row.accountEmail && mailbox && row.accountEmail !== mailbox) return;
    // Saved before the mailbox was recorded: keep it, but held until you
    // send it again yourself.
    if (!row.accountEmail) row.sendError = row.sendError || "Check the account, then send it again.";
    const fromName = (accounts[row.account] && accounts[row.account].yourName) || "You";
    messages.push({
      id: row.id,
      thread: row.id,
      seq: Date.now(),
      box: "outbox",
      pendingSend: true,
      sendAt: Number(row.sendAt) || Date.now(),
      sendError: row.sendError || "",
      account: row.account,
      accountEmail: row.accountEmail || "",
      from: fromName,
      email: selfAddress(row.account),
      initials: initialsFor(fromName),
      color: "#394146",
      subject: row.subject || "(No subject)",
      preview: row.sendError || "Sending",
      time: row.sendError ? "Outbox" : "Sending",
      date: localDateKey(todayDate()),
      attachments: Array.isArray(row.attachments) ? row.attachments : [],
      replyTo: row.replyTo || "",
      replyMode: row.replyMode || "",
      serverDraftId: row.serverDraftId || "",
      sendLater: row.sendLater || "",
      importance: row.importance || "",
      readReceipt: !!row.readReceipt,
      followUp: Number(row.followUp) || 0,
      files: Array.isArray(row.files) ? row.files : [],
      unread: false,
      to: row.to || "",
      cc: row.cc || "",
      bcc: row.bcc || "",
      toName: row.to || "",
      body: plainFromHtml(row.bodyHtml || ""),
      bodyHtml: row.bodyHtml || "",
      draftHtml: row.bodyHtml || "",
      meeting: row.meeting || null,
      invite: row.invite || null,
      sendFrom: row.sendFrom || ""
    });
    if (row.sendError === SEND_AGAIN) sendConsent.add(row.account);
  });
  if (messages.some(m => m.pendingSend)) {
    armPendingTimer();
    refreshAuthBanner();
  }
}

function finishLocalSend(message) {
  if (message.serverDraftId) {
    // The server draft was sent as this message. Drop its Drafts copy.
    const copy = messages.findIndex(m => m.live && m.id === message.serverDraftId);
    if (copy >= 0) messages.splice(copy, 1);
    message.serverDraftId = "";
  }
  message.pendingSend = false;
  message.sending = false;
  message.sendError = "";
  message.sendAt = 0;
  message.box = "sent";
  threadFetched.delete(message.account + "\n" + message.thread);
  message.time = "Now";
  if (message.invite) {
    fileInvite({ meeting: message.invite, to: message.to, from: message.account });
    message.invite = null;
  }
  rememberOutbox();
  if (message.followUp) {
    watchForReply(message);
    message.followUp = 0;
  }
  const name = (accounts[message.account] && accounts[message.account].name) || "";
  if (message.sendLater) {
    message.time = "Scheduled";
    toast("Scheduled for " + new Date(message.sendLater).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
  } else toast(message.meeting ? "Invite sent · " + message.meeting.title : "Sent from " + name);
  loadedLiveFolders.delete(message.account + "\nsent");
  if (box === "outbox" && selected === message.id) box = "sent";
  if (view === "mail") {
    const visible = conversations();
    if (!visible.some(c => c.messages.some(m => m.id === selected))) selected = visible[0]?.latest.id || null;
    render();
    if (account === "all" && box === "sent") ensureUnifiedFolder("sent");
    else if (box === "sent") ensureFolderMessages(message.account, "sent");
  }
}

function deliverPending(message) {
  if (!message || !message.pendingSend || message.sending || message.sendError) return;
  if (!inDesktop()) {
    finishLocalSend(message);
    return;
  }
  const acct = accounts[message.account];
  const wrongMailbox = acct && acct.email && message.accountEmail && String(acct.email).toLowerCase() !== message.accountEmail;
  if (!acct || !acct.email || wrongMailbox) {
    message.sendError = wrongMailbox ? "This was written from another account." : "That account is not signed in.";
    message.time = "Outbox";
    rememberOutbox();
    toast(message.sendError);
    return;
  }
  message.sending = true;
  message.time = "Sending";
  const when = document.querySelector('.row[data-id="' + CSS.escape(message.id) + '"] .when');
  if (when) when.textContent = "Sending";
  const holdText = document.getElementById("send-hold-text");
  if (holdText && selected === message.id) {
    holdText.textContent = "Sending…";
    const undoBtn = document.getElementById("undo-send");
    if (undoBtn) undoBtn.hidden = true;
  }
  const original = message.replyTo ? messages.find(m => m.id === message.replyTo) : null;
  const threaded = !!(original && serverMessage(original) && original.account === message.account);
  const mode = threaded ? (message.replyMode || "reply") : "";
  tauriInvoke("send_mail", {
    email: acct.email,
    subject: message.subject === "(No subject)" ? "" : (message.subject || ""),
    bodyHtml: bodyForSend(message),
    to: message.to || "",
    cc: message.cc || "",
    bcc: message.bcc || "",
    draftId: message.serverDraftId || null,
    replyTo: threaded ? original.id : null,
    mode: mode || null,
    keepFiles: mode === "forward" ? (message.attachments || []) : null,
    files: message.files || [],
    sendAt: message.sendLater || null,
    importance: message.importance || "",
    readReceipt: !!message.readReceipt,
    fromAddress: message.sendFrom || null
  }).then(() => {
    if (!message.pendingSend) return;
    finishLocalSend(message);
    stopPendingTimerIfIdle();
  }).catch(err => {
    message.sending = false;
    const text = String(err && err.message || err || "The message could not be sent. It is still in Outbox.");
    if (text.indexOf("Microsoft is busy") === 0 || text.indexOf("Gmail is busy") === 0) {
      message.sendAt = Date.now() + 30000;
      message.time = "Sending";
      rememberOutbox();
      toast(text);
      return;
    }
    message.sendError = text;
    message.time = "Outbox";
    message.preview = text.slice(0, 90);
    if (text === SEND_AGAIN) {
      sendConsent.add(message.account);
      authProblem = SEND_AGAIN;
      refreshAuthBanner();
    }
    rememberOutbox();
    toast(text);
    if (view === "mail") render();
    stopPendingTimerIfIdle();
  });
}

function releasePending(message) {
  if (!message || !message.pendingSend) return;
  if (inDesktop()) deliverPending(message);
  else finishLocalSend(message);
}

function tickPendingSends() {
  const now = Date.now();
  const releasedIds = [];
  messages.forEach(message => {
    if (!message.pendingSend) return;
    if (messageBox(message) !== "outbox") {
      message.pendingSend = false;
      message.sendAt = 0;
      message.invite = null;
      message.sending = false;
      return;
    }
    if (message.sending || message.sendError) return;
    const left = Math.max(0, Math.ceil((message.sendAt - now) / 1000));
    message.time = left > 0 ? delayPhrase(left) : "Sending";
    const label = document.getElementById("send-hold-text");
    if (label && selected === message.id) label.textContent = "Sending in " + delayPhrase(left) + ".";
    const when = document.querySelector('.row[data-id="' + CSS.escape(message.id) + '"] .when');
    if (when) when.textContent = message.time;
    if (now >= message.sendAt) {
      if (inDesktop()) deliverPending(message);
      else {
        finishLocalSend(message);
        releasedIds.push(message.id);
      }
    }
  });
  stopPendingTimerIfIdle();
  if (!releasedIds.length || view !== "mail") return;
  const visible = conversations();
  if (!visible.some(c => c.messages.some(m => m.id === selected))) selected = visible[0]?.latest.id || null;
  render();
}

function undoPending(id) {
  const message = messages.find(m => m.id === id && m.pendingSend);
  if (!message || message.sending) return;
  message.pendingSend = false;
  message.sendAt = 0;
  message.invite = null;
  message.box = "drafts";
  message.draft = true;
  message.compose = message.replyMode || "";
  message.staged = stagedMap(message.files);
  message.time = "Draft";
  message.bodyHtml = message.draftHtml || message.bodyHtml;
  message.preview = (message.body || "").slice(0, 90) || "Draft";
  account = message.account;
  box = "drafts";
  folderPick = "folder";
  selected = message.id;
  replyDraft = null;
  replyView = "reply";
  document.body.dataset.open = "1";
  stopPendingTimerIfIdle();
  rememberOutbox();
  toast("Send undone");
  render();
}

function ensureDraftMessage(replyTo) {
  const id = "draft-" + replyTo.id;
  let draft = messages.find(m => m.id === id);
  if (draft) {
    draft.box = "drafts";
    draft.draft = true;
    return draft;
  }
  if (!draft) {
    draft = {
      id,
      thread: id,
      seq: Date.now(),
      box: "drafts",
      draft: true,
      replyTo: replyTo.id,
      account: replyTo.account,
      from: "Jon",
      email: selfAddress(replyTo.account),
      initials: "J",
      color: "#394146",
      subject: "Re: " + cleanSubject(replyTo.subject),
      preview: "Draft",
      time: "Draft",
      date: "2026-10-15",
      attachments: [],
      unread: false,
      to: replyTo.email,
      toName: replyTo.from,
      body: "",
      bodyHtml: "<p><br></p>"
    };
    messages.push(draft);
  }
  return draft;
}

// A written date wins over a weekday. "Thursday 15 October" is that October
// day, not this week's Thursday. A weekday on its own is that day in the
// week that contains today (Monday first). "next Thursday" is seven days on.
// A date with no year that is more than a month ago is next year.
const DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const MONTH_NAMES = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";

function monthIndex(name) {
  const n = String(name || "").toLowerCase();
  const full = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const hit = full.indexOf(n);
  if (hit >= 0) return hit;
  if (n === "sept") return 8;
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(n);
}

function datedDay(year, month, dayNum, yearGiven) {
  if (month < 0 || dayNum < 1 || dayNum > 31) return null;
  let date = new Date(year, month, dayNum);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== dayNum) return null;
  if (!yearGiven) {
    const today = todayDate();
    const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    cutoff.setDate(cutoff.getDate() - 31);
    if (date < cutoff) {
      const next = new Date(year + 1, month, dayNum);
      if (next.getMonth() === month && next.getDate() === dayNum) date = next;
    }
  }
  return dayFromDate(date);
}

function explicitDayFromText(text) {
  const lower = String(text || "").toLowerCase();
  let picked = null;
  const take = (match, year, month, day, yearGiven) => {
    if (!match) return;
    if (picked && picked.at <= match.index) return;
    const given = year != null && year !== "";
    picked = {
      at: match.index,
      year: given ? Number(year) : todayDate().getFullYear(),
      month,
      day: Number(day),
      yearGiven: !!yearGiven && given
    };
  };
  const iso = lower.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  take(iso, iso && iso[1], iso ? Number(iso[2]) - 1 : -1, iso && iso[3], true);
  const dmy = lower.match(new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(" + MONTH_NAMES + ")(?:\\s+(20\\d{2}))?\\b"));
  take(dmy, dmy && dmy[3], dmy ? monthIndex(dmy[2]) : -1, dmy && dmy[1], true);
  const mdy = lower.match(new RegExp("\\b(" + MONTH_NAMES + ")\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?(?:\\s+(20\\d{2}))?\\b"));
  take(mdy, mdy && mdy[3], mdy ? monthIndex(mdy[1]) : -1, mdy && mdy[2], true);
  if (!picked) return null;
  return datedDay(picked.year, picked.month, picked.day, picked.yearGiven);
}

function weekdayFromText(text) {
  const lower = String(text || "").toLowerCase();
  const next = lower.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  let name = next ? next[1] : "";
  const extra = next ? 7 : 0;
  if (!name) {
    for (let i = 0; i < DAY_NAMES.length; i++) {
      if (lower.includes(DAY_NAMES[i])) { name = DAY_NAMES[i]; break; }
    }
  }
  if (!name) return null;
  const week = startOfWeek(todayDate());
  const date = new Date(week.getFullYear(), week.getMonth(), week.getDate() + DAY_NAMES.indexOf(name) + extra);
  return dayFromDate(date);
}

function dayFromText(text) {
  const named = explicitDayFromText(text);
  if (named != null) return named;
  return weekdayFromText(text);
}

function timeFromText(text) {
  const range = String(text || "").match(/\b(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})\b/);
  if (range) {
    const start = Number(range[1]) * 60 + Number(range[2]);
    const end = Number(range[3]) * 60 + Number(range[4]);
    return { start, end: end > start ? end : start + 60 };
  }
  const clock = String(text || "").match(/\b(\d{1,2}):(\d{2})\b/);
  if (clock) {
    const start = Number(clock[1]) * 60 + Number(clock[2]);
    return { start, end: start + 60 };
  }
  const loose = String(text || "").match(/\b(?:at|from)\s+(\d{1,2})(?::(\d{2}))?\b/i);
  if (loose) {
    const start = Number(loose[1]) * 60 + Number(loose[2] || 0);
    return { start, end: start + 60 };
  }
  if (/\bmorning\b/i.test(text)) return { start: 9 * 60, end: 10 * 60 };
  if (/\bafternoon\b/i.test(text)) return { start: 14 * 60, end: 15 * 60 };
  return null;
}

function whereFromText(text) {
  const lower = String(text || "").toLowerCase();
  if (lower.includes("side gate")) return "Side gate";
  const studio = lower.includes("studio");
  const teams = lower.includes("teams");
  if (studio && teams) return "Studio · Teams";
  if (studio) return "Studio";
  if (teams) return "Teams";
  return "";
}

function slotFree(day, start, end) {
  return !events.some(e => e.day === day && !e.hidden && e.start < end && e.end > start);
}

function freeSlot(preferDay) {
  const monday = dayFromDate(startOfWeek(todayDate()));
  const thursday = monday + 3;
  const order = preferDay == null ? [thursday, monday + 4, monday + 2, monday + 1, monday] : [preferDay];
  for (let i = 0; i < order.length; i++) {
    const day = order[i];
    for (let hour = 9; hour <= 15; hour++) {
      if (hour === 12) continue;
      const start = hour * 60;
      if (slotFree(day, start, start + 60)) return { day, start, end: start + 60 };
    }
  }
  return { day: preferDay == null ? thursday : preferDay, start: 16 * 60, end: 17 * 60 };
}

function meetingFromThread(msg) {
  const thread = messages.filter(m => m.thread === msg.thread).sort((a, b) => b.seq - a.seq);
  const titled = thread.find(m => m.meeting && m.meeting.when);
  if (titled) {
    const when = titled.meeting.when;
    const timed = timeFromText(when) || { start: 10 * 60, end: 11 * 60 };
    let day = dayFromText(when);
    if (day == null || day < 0) day = 3;
    return {
      title: titled.meeting.title || cleanSubject(msg.subject),
      where: titled.meeting.where || whereFromText(when),
      day,
      start: timed.start,
      end: timed.end,
      source: "thread"
    };
  }
  let day = null;
  let start = null;
  let end = null;
  let where = "";
  thread.forEach(m => {
    const text = m.subject + " " + m.body;
    if (day == null) {
      const found = dayFromText(text);
      if (found != null && found >= 0) day = found;
    }
    if (start == null) {
      const timed = timeFromText(text);
      if (timed) { start = timed.start; end = timed.end; }
    }
    if (!where) where = whereFromText(text);
  });
  const inferred = day != null || start != null;
  if (day == null || start == null) {
    const slot = freeSlot(day == null ? null : day);
    if (day == null) day = slot.day;
    if (start == null) { start = slot.start; end = slot.end; }
  }
  if (end == null || end <= start) end = start + 60;
  const title = cleanSubject(thread[0].subject);
  return {
    title: title ? title.charAt(0).toUpperCase() + title.slice(1) : "Meeting",
    where,
    day,
    start,
    end,
    source: inferred ? "thread" : "free"
  };
}

function describeSlot(meeting) {
  return formatDayLong(meeting.day) + ", " + fmt(meeting.start) + "–" + fmt(meeting.end);
}

function parseClock(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function readInvite(form) {
  const card = form.querySelector("#compose-invite");
  if (!card) return null;
  const start = parseClock(card.querySelector("#invite-start").value);
  let end = parseClock(card.querySelector("#invite-end").value);
  const begin = start == null ? 10 * 60 : start;
  if (end == null || end <= begin) end = begin + 60;
  return {
    title: card.querySelector("#invite-title").value.trim() || "Meeting",
    where: card.querySelector("#invite-where").value.trim(),
    day: Number(card.querySelector("#invite-day").value),
    start: begin,
    end,
    source: card.dataset.source === "free" ? "free" : "thread"
  };
}

function fileInvite(fields) {
  const meeting = fields.meeting;
  if (!meeting || meeting.day == null || Number.isNaN(Number(meeting.day))) return;
  const emails = addressList(fields.to);
  const people = emails.map(recipientLabel).join(", ");
  const picked = activeDefaultCalendar();
  const accountId = picked ? picked.accountId : fromAccountId(fields.from);
  const cal = picked ? findCalendar(picked.id) : null;
  if (picked) hiddenCal.delete(picked.id);
  const same = events.find(e => e.account === accountId && e.day === meeting.day && e.start === meeting.start && e.title === meeting.title);
  if (same) {
    same.end = meeting.end;
    if (meeting.where) same.where = meeting.where;
    if (emails.length) {
      same.with = people;
      same.attendees = mergeAttendees(same.attendees, emails.map(email => ({ email, name: recipientLabel(email), status: "none" })));
    }
    if (!same.calendar && cal) same.calendar = cal.id;
    return;
  }
  events.push({
    id: "event-" + Date.now(),
    account: accountId,
    calendar: picked ? picked.id : "",
    day: meeting.day,
    start: meeting.start,
    end: meeting.end,
    title: meeting.title,
    where: meeting.where || "",
    with: people,
    attendees: emails.map(email => ({ email, name: recipientLabel(email), status: "none" }))
  });
}

function mirrorComposeDraft() {
  const form = reading.querySelector("#compose-form");
  if (!form || !replyDraft || form.dataset.msg !== replyDraft.msgId) return;
  const set = (sel, value) => {
    const el = form.querySelector(sel);
    if (el) el.value = value;
  };
  set("#compose-to", recipientFieldValue(replyDraft.to || ""));
  set("#compose-cc", recipientFieldValue(replyDraft.cc || ""));
  set("#compose-bcc", recipientFieldValue(replyDraft.bcc || ""));
  set("#compose-subject", replyDraft.subject || "");
  const files = form.querySelector("#compose-files");
  if (files) files.innerHTML = fileChips(replyDraft.attachments || []);
  if (!replyDraft.meeting) {
    const card = form.querySelector("#compose-invite");
    if (card) card.remove();
  }
}

function actionSubject(msg, mode, previous, draft) {
  const next = (mode === "forward" ? "FW: " : "Re: ") + cleanSubject(msg.subject);
  if (previous && previous.msgId === msg.id) {
    const prior = previous.compose === "forward" ? "forward" : "reply";
    const wanted = mode === "forward" ? "forward" : "reply";
    if (prior === wanted) return previous.subject || (draft && draft.subject) || next;
    const priorDefault = (prior === "forward" ? "FW: " : "Re: ") + cleanSubject(msg.subject);
    if ((previous.subject || "") === priorDefault) return next;
    return previous.subject || next;
  }
  if (mode === "forward") return next;
  return (draft && draft.subject) || next;
}

function replyFromKey(msg) {
  const acct = msg && accounts[msg.account];
  if (!acct) return msg ? msg.account : "";
  const aliases = aliasList(acct);
  if (!aliases.length) return msg.account;
  const mine = new Set();
  const add = value => String(value || "").split(/[;,]/).forEach(part => {
    const addr = part.trim().toLowerCase();
    if (addr) mine.add(addr);
  });
  add(msg.to);
  add(msg.cc);
  (msg.toPeople || []).forEach(person => add(person && person.email));
  (msg.ccPeople || []).forEach(person => add(person && person.email));
  const hit = aliases.find(addr => mine.has(addr.toLowerCase()));
  return hit ? fromKey(msg.account, hit) : msg.account;
}

function startReply(msg, all) {
  captureReplyDraft();
  const draft = ensureDraftMessage(msg);
  const to = replyRecipients(msg, !!all);
  const previous = replyDraft && replyDraft.msgId === msg.id ? replyDraft : null;
  const fromForward = previous && previous.compose === "forward";
  const keptMeeting = fromForward ? null : (previous ? previous.meeting : null);
  const subject = actionSubject(msg, "reply", previous, draft);
  draft.to = to;
  draft.toName = recipientLabel(to.split(/[;,]/)[0].trim());
  draft.subject = subject;
  replyView = "reply";
  replyDraft = {
    draftId: draft.id,
    msgId: msg.id,
    to,
    cc: previous && previous.compose === (all ? "replyAll" : "reply") ? previous.cc || "" : (all ? replyCcRecipients(msg, to) : ""),
    bcc: fromForward ? "" : (previous ? previous.bcc || "" : ""),
    attachments: previous ? previous.attachments || [] : [],
    from: previous && previous.from ? previous.from : replyFromKey(msg),
    subject,
    bodyHtml: draft.bodyHtml || "<p><br></p>",
    meeting: keptMeeting || null,
    compose: all ? "replyAll" : "reply",
    staged: previous ? previous.staged || {} : (draft.staged || {}),
    serverDraftId: previous ? previous.serverDraftId || "" : (draft.serverDraftId || ""),
    serverDraftMode: previous ? previous.serverDraftMode || "" : (draft.serverDraftMode || "")
  };
  mirrorComposeDraft();
  syncDraftMessage();
  folded.delete(msg.id);
  expanded.add(msg.id);
  selected = msg.id;
  focusReply = true;
  render();
}

function messagePlain(m) {
  const body = String(m.body || "").trim();
  if (body) return body;
  if (m.bodyHtml) {
    const text = plainFromHtml(m.bodyHtml);
    if (text) return text;
  }
  return String(m.preview || "").trim();
}

function threadNotes(msg) {
  const blocks = messages
    .filter(m => m.thread === msg.thread && !m.draft)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0))
    .map(m => {
      const head = [historyWhen(m), historyAddress(m.email, m.from)].filter(Boolean).join(" · ");
      const text = messagePlain(m);
      return [head, text].filter(Boolean).join("\n");
    })
    .filter(Boolean);
  return blocks.join("\n\n").slice(0, 30000);
}

function inviteAttendees(msg) {
  const own = ownAddresses();
  const seen = new Set();
  const people = [];
  const add = person => {
    const email = String(person && person.email || "").trim();
    const key = email.toLowerCase();
    if (!key || own.has(key) || seen.has(key)) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) return;
    seen.add(key);
    const name = String(person.name || "").trim();
    people.push({
      email,
      name: name && name.toLowerCase() !== key ? name : recipientLabel(email),
      status: "none"
    });
  };
  messages.filter(m => m.thread === msg.thread && !m.draft).sort((a, b) => (a.seq || 0) - (b.seq || 0)).forEach(m => {
    if (m.email) add({ email: m.email, name: m.from });
    partyPeople(m, "to").forEach(add);
    partyPeople(m, "cc").forEach(add);
  });
  return people;
}

function accountCalendarId(accountId) {
  const acct = accounts[accountId];
  if (!acct) return preferredCalendarId();
  const saved = activeDefaultCalendar();
  const savedOwner = saved && accountForCalendar(saved.id);
  if (saved && savedOwner && savedOwner[0] === accountId && !calendarReadOnly(saved.id)) return saved.id;
  const own = (acct.calendars || []).find(cal => cal.canEdit !== false);
  return own ? own.id : preferredCalendarId();
}

function startReplyWithInvite(msg) {
  captureReplyDraft();
  const slot = meetingFromThread(msg);
  openEventForm({
    title: slot.title,
    where: slot.where,
    day: slot.day,
    start: slot.start,
    end: slot.end,
    notes: threadNotes(msg),
    attendees: inviteAttendees(msg),
    calendar: accountCalendarId(msg.account)
  });
}

function startForward(msg) {
  captureReplyDraft();
  const draft = ensureDraftMessage(msg);
  const previous = replyDraft && replyDraft.msgId === msg.id ? replyDraft : null;
  const subject = actionSubject(msg, "forward", previous, draft);
  const files = previous && previous.compose === "forward"
    ? (previous.attachments || [])
    : messageFiles(msg).map(file => file.name);
  draft.to = "";
  draft.toName = "";
  draft.cc = "";
  draft.bcc = "";
  draft.subject = subject;
  draft.attachments = files;
  draft.meeting = null;
  replyView = "reply";
  replyDraft = {
    draftId: draft.id,
    msgId: msg.id,
    to: "",
    cc: "",
    bcc: "",
    attachments: files,
    from: draft.account,
    subject,
    bodyHtml: draft.bodyHtml || "<p><br></p>",
    meeting: null,
    compose: "forward",
    staged: previous ? previous.staged || {} : (draft.staged || {}),
    serverDraftId: previous ? previous.serverDraftId || "" : (draft.serverDraftId || ""),
    serverDraftMode: previous ? previous.serverDraftMode || "" : (draft.serverDraftMode || "")
  };
  mirrorComposeDraft();
  syncDraftMessage();
  folded.delete(msg.id);
  expanded.add(msg.id);
  selected = msg.id;
  focusReply = true;
  render();
}

function toggleFlag(id) {
  const msg = messages.find(m => m.id === id);
  if (!msg) return;
  const prior = rememberMessages([msg]);
  msg.flagged = !msg.flagged;
  toast(msg.flagged ? "Flagged" : "Flag removed");
  render();
  pushMailAction([msg], msg.flagged ? "flag" : "unflag", () => {
    msg.flagged = prior[0].flagged;
  }, prior);
}

function deleteListed(id, onlyOne) {
  const msg = messages.find(m => m.id === id);
  const conv = conversationFor(id);
  if (!msg || !conv) return;
  const single = onlyOne && conv.messages.length > 1;
  const removing = new Set((single ? [msg] : conv.messages).map(item => item.id));
  const keepId = removing.has(selected)
    ? (single ? (conv.messages.find(item => item.id !== id && messageBox(item) === messageBox(msg)) || {}).id : null)
    : selected;
  if (single) moveConversation({ messages: [msg] }, "trash");
  else moveConversation(conv, "trash");
  if (keepId && messages.some(item => item.id === keepId && messageBox(item) !== "trash")) {
    selected = keepId;
    render();
  }
  toastMove("Moved to Trash");
}

// Only messages sitting in Deleted Items, Archive or Junk go back to the
// Inbox. A reply of yours in Sent Items stays where it is.
function canMoveToInbox(m) {
  const where = messageBox(m);
  return where === "trash" || where === "archive" || folderKind(where, m.account) === "junk";
}

function moveToInbox(targets) {
  const list = (targets || []).filter(canMoveToInbox);
  if (!list.length) return false;
  moveConversation({ messages: list }, "inbox");
  toastMove(list.length === 1 ? "Moved to Inbox" : "Moved " + list.length + " messages to Inbox");
  return true;
}

// Folders a message can be moved to: not Drafts or Outbox, not where it is.
function moveChoices(accountId, from) {
  const acct = accounts[accountId];
  const live = (acct && acct.liveFolders) || [];
  return accountFolderKeys(accountId)
    .filter(key => key !== from && key !== "drafts" && key !== "outbox")
    .map(key => {
      const found = live.find(item => item.key === key);
      return { key, label: boxLabel(key, accountId), depth: found ? Number(found.depth) || 0 : 0 };
    });
}

// Move the messages that sit in one folder. Your replies elsewhere in the
// thread stay put. Messages only move within their own account.
function moveToFolder(targets, key) {
  const first = (targets || [])[0];
  if (!first || !key) return false;
  const from = messageBox(first);
  const list = targets.filter(m => m.account === first.account && messageBox(m) === from && !m.pendingSend && !m.draft);
  if (!list.length || from === key) return false;
  moveConversation({ messages: list }, key);
  noteMove(first.account, key);
  const label = boxLabel(key, first.account);
  toastMove(list.length === 1 ? "Moved to " + label : "Moved " + list.length + " messages to " + label);
  return true;
}

function moveRecent() {
  try {
    const parsed = JSON.parse(localStorage.getItem("mailroom-move-recent") || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    return {};
  }
}

function noteMove(accountId, key) {
  if (!accountId || !key || isCategoryBox(key) || isSearchBox(key)) return;
  const all = moveRecent();
  const acct = all[accountId] && typeof all[accountId] === "object" ? all[accountId] : {};
  const now = Date.now();
  const row = acct[key] && typeof acct[key] === "object" ? acct[key] : { score: 0, at: now };
  const days = Math.max(0, (now - (Number(row.at) || now)) / 86400000);
  acct[key] = { score: (Number(row.score) || 0) * Math.pow(0.5, days / 14) + 1, at: now };
  all[accountId] = acct;
  try { localStorage.setItem("mailroom-move-recent", JSON.stringify(all)); } catch (e) {}
}

function suggestedMoves(accountId, choices) {
  const recent = moveRecent()[accountId] || {};
  return choices
    .map(item => ({ item, score: recent[item.key] && Number(recent[item.key].score) || 0 }))
    .filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(row => row.item);
}

function showMoveDialog(targets) {
  const first = (targets || [])[0];
  if (!first) return;
  const choices = moveChoices(first.account, messageBox(first));
  if (!choices.length) return;
  const acctName = (accounts[first.account] && accounts[first.account].name) || "";
  popRoot.innerHTML = `<div class="backdrop" id="backdrop"></div>
    <div class="dialog move-dialog" role="dialog" aria-modal="true" aria-labelledby="move-title">
      <h2 id="move-title">Move to</h2>
      <p class="field-hint">${esc(acctName)}</p>
      <input id="move-filter" placeholder="Find a folder" autocomplete="off" spellcheck="false" aria-label="Find a folder">
      <div class="move-list" id="move-list" role="listbox" aria-label="Folders"></div>
      <div class="dialog-actions"><button class="ghost" type="button" id="move-cancel">Cancel</button></div>
    </div>`;
  const list = popRoot.querySelector("#move-list");
  const filter = popRoot.querySelector("#move-filter");
  function paint() {
    const q = filter.value.trim().toLowerCase();
    const shown = choices.filter(item => !q || item.label.toLowerCase().includes(q));
    if (!shown.length) {
      list.innerHTML = `<p class="field-hint">No folder matches.</p>`;
      return;
    }
    let n = 0;
    const button = (item, pad) => {
      const html = `<button type="button" role="option" class="move-choice" data-key="${esc(item.key)}" style="padding-left:${12 + pad}px"${n === 0 ? ' aria-selected="true"' : ""}>${folderIcon(item.key, first.account)}<span>${esc(item.label)}</span></button>`;
      n += 1;
      return html;
    };
    const suggested = q ? [] : suggestedMoves(first.account, shown);
    const sug = suggested.length ? `<p class="move-group">Suggested</p>` + suggested.map(item => button(item, 0)).join("") + `<p class="move-group">Folders</p>` : "";
    list.innerHTML = sug + shown.map(item => button(item, q ? 0 : item.depth * 16)).join("");
  }
  const choose = key => { closePop(); moveToFolder(targets, key); };
  list.addEventListener("click", ev => {
    const btn = ev.target.closest("[data-key]");
    if (btn) choose(btn.dataset.key);
  });
  filter.addEventListener("input", paint);
  filter.addEventListener("keydown", ev => {
    if (ev.key === "Enter") {
      const firstChoice = list.querySelector("[data-key]");
      if (firstChoice) choose(firstChoice.dataset.key);
    }
    if (ev.key === "Escape") closePop();
  });
  popRoot.querySelector("#backdrop").onclick = closePop;
  popRoot.querySelector("#move-cancel").onclick = closePop;
  paint();
  filter.focus();
}

function rowTargets(id, child) {
  const msg = messages.find(m => m.id === id);
  if (!msg) return [];
  if (child) return [msg];
  return messages.filter(m => m.thread === msg.thread && messageBox(m) === messageBox(msg) && m.account === msg.account);
}

function moveConversation(conv, next) {
  const prior = rememberMessages(conv.messages);
  const fromBox = new Map(conv.messages.map(m => [m, messageBox(m)]));
  conv.messages.forEach(m => {
    const onServer = serverMessage(m);
    if (m.pendingSend && next !== "outbox") {
      m.pendingSend = false;
      m.sendAt = 0;
      m.invite = null;
    }
    if (next === "trash" && messageBox(m) !== "trash") m.previousBox = messageBox(m);
    if (next === "inbox" && m.previousBox && !onServer) m.box = m.previousBox;
    else m.box = next;
    if (next === "inbox") m.previousBox = "";
    if (next === "trash" || next === "archive") m.unread = false;
  });
  if (replyDraft && conv.messages.some(m => m.id === replyDraft.draftId)) replyDraft = null;
  stopPendingTimerIfIdle();
  selected = conversations()[0]?.latest.id || null;
  expanded.clear();
      folded.clear();
  render();
  const kind = next === "trash" || next === "archive" || next === "inbox" ? next : "move";
  const owner = conv.messages[0] && accounts[conv.messages[0].account];
  const folder = owner && (owner.liveFolders || []).find(item => item.key === next);
  const moving = conv.messages.slice();
  const pending = pushMailAction(conv.messages, kind, () => {
    prior.forEach(item => {
      const msg = messages.find(m => m.id === item.id);
      if (!msg) return;
      msg.box = item.box;
      msg.previousBox = item.previousBox;
      msg.unread = item.unread;
    });
  }, prior, kind === "move" ? { id: folder ? folder.id : next, key: next } : null);
  if (!undoing) {
    lastMove = { at: Date.now(), pending, items: moving.map(message => ({ message, box: fromBox.get(message) || "inbox" })) };
  }
  return pending;
}

function capturePaneCompose() {
  if (!paneCompose) return;
  const form = reading.querySelector("form.pane-compose");
  if (!form) return;
  paneCompose.from = formFromValue(form);
  paneCompose.to = parseAddresses(form.querySelector("#compose-to").value).join("; ");
  paneCompose.cc = parseAddresses(form.querySelector("#compose-cc").value).join("; ");
  paneCompose.bcc = parseAddresses(form.querySelector("#compose-bcc").value).join("; ");
  paneCompose.attachments = [...form.querySelectorAll("#compose-files [data-name]")].map(el => el.dataset.name);
  paneCompose.subject = form.querySelector("#compose-subject").value;
  paneCompose.bodyHtml = form.querySelector("#compose-body").innerHTML;
}

function paintPaneCompose() {
  reading.innerHTML = composeMarkup({
    mode: "pane",
    title: "New message",
    fromId: paneCompose.from,
    to: paneCompose.to,
    cc: paneCompose.cc,
    bcc: paneCompose.bcc,
    attachments: paneCompose.attachments,
    subject: paneCompose.subject,
    bodyHtml: paneCompose.bodyHtml,
    kind: "new"
  });
  bindCompose(reading, { mode: "pane", kind: "new", draft: paneCompose });
}

function discardInlineReply() {
  const id = replyDraft && replyDraft.draftId;
  const draft = id && messages.find(m => m.id === id);
  replyDraft = null;
  replyView = "reply";
  if (draft) {
    draft.previousBox = "drafts";
    draft.box = "trash";
    if (selected === id) selected = (conversations()[0] && conversations()[0].latest.id) || null;
  }
  render();
  toast("Draft discarded");
}

function replyTabsHtml(conv, msg) {
  const messageLabel = conv.topic || (msg && msg.subject) || "Message";
  const forwarding = replyDraft && replyDraft.compose === "forward";
  const replyLabel = (replyDraft && replyDraft.subject) || (forwarding ? "Forward" : "Reply");
  const onReply = replyView !== "message";
  const mailIcon = `<svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d="M3.2 6.2h13.6v9.2H3.2V6.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M3.6 6.6L10 11.4l6.4-4.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
  const replyMark = forwarding
    ? `<svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d="M12 5.4L16.4 9.6 12 13.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.6 9.6H8.4A4.4 4.4 0 004 14V16.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><path d="M8 5.4L3.6 9.6 8 13.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.4 9.6h7.2a4.4 4.4 0 014.4 4.4V16.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  const close = `<button type="button" class="read-tab-x" data-reply-close title="Close" aria-label="${forwarding ? "Close forward" : "Close reply"}"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3L3 9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>`;
  const tab = (id, label, icon, on, extra) => `<div class="read-tab${on ? " on" : ""}" role="tab" aria-selected="${on ? "true" : "false"}">
      <button type="button" class="read-tab-main" data-reply-tab="${id}">${icon}<span class="read-tab-label">${esc(label)}</span></button>
      ${extra || ""}
    </div>`;
  return `<div class="read-tabs" role="tablist" aria-label="Open items">${tab("message", messageLabel, mailIcon, !onReply)}${tab("reply", replyLabel, replyMark, onReply, close)}</div>`;
}

function bindReplyTabs() {
  reading.querySelectorAll("[data-reply-tab]").forEach(btn => {
    btn.onclick = () => {
      const next = btn.dataset.replyTab === "message" ? "message" : "reply";
      if (next === replyView) return;
      captureReplyDraft();
      replyView = next;
      if (next === "reply") focusReply = true;
      render();
    };
  });
  reading.querySelectorAll("[data-reply-close]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      confirmDiscard(() => discardInlineReply());
    };
  });
}

function composeDraftStamp(draft) {
  if (!draft) return "";
  const files = (draft.attachments || []).map(item => typeof item === "string" ? item : ((item && item.name) || "")).join(",");
  return [
    draft.msgId || "", draft.draftId || "", draft.from || "", draft.to || "", draft.cc || "", draft.bcc || "",
    draft.subject || "", stampText(draft.bodyHtml), files, draft.compose || "", draft.meeting ? "1" : ""
  ].join("\t");
}

function messagePaintStamp(m, open) {
  const files = messageFiles(m).map(file => [file.id, file.name, file.size].join(":")).join(",");
  const images = inlineImagesFor.get(m.id);
  const invite = m.liveInvite;
  const meeting = m.meeting;
  const acct = accounts[m.account];
  return [
    m.id,
    open ? "1" : "0",
    m.unread ? "1" : "0",
    m.flagged ? "1" : "0",
    m.needsBody ? "1" : "0",
    m.subject || "",
    m.from || "",
    m.email || "",
    m.preview || "",
    m.importance || "",
    (m.categories || []).join(","),
    files,
    stampText(m.bodyHtml),
    allowRemoteFor(m) ? "1" : "0",
    lightView.has(m.id) ? "1" : "0",
    images && images.list ? String(images.list.length) : "0",
    unsubscribeFor.get(m.id) ? "1" : "0",
    meeting ? [meeting.title || "", meeting.when || "", meeting.where || ""].join(":") : "",
    invite ? [invite.response || "", invite.cancelled ? "1" : "0", invite.organizer ? "1" : "0", invite.eventId || ""].join(":") : "",
    acct ? acct.name : ""
  ].join("\t");
}

function readingThreadKey(conv, ordered, openMessage, where, held, showReply, showDraftCard, folderDraft) {
  const lines = [
    "thread",
    view,
    conv.id,
    selected || "",
    box,
    signatureDark() ? "1" : "0",
    document.documentElement.dataset.theme || "",
    readSize,
    where,
    held ? held.id : "",
    stampText(askAnswer),
    showReply ? "1" : "0",
    showDraftCard ? "1" : "0",
    folderDraft ? folderDraft.id : "",
    replyView || "",
    (showReply || showDraftCard || folderDraft) ? composeDraftStamp(replyDraft) : ""
  ];
  (folderDraft ? conv.messages : ordered).forEach(m => lines.push(messagePaintStamp(m, folderDraft ? true : openMessage(m))));
  return lines.join("\n");
}

function warmOpenReading(conv, ordered, openMessage, folderDraft, showDraftCard, threadDraft) {
  if (conv && !folderDraft) loadThreadSent(conv);
  (ordered || []).forEach(m => {
    if (!openMessage(m)) return;
    ensureMessageFiles(m);
    ensureInvite(m);
    ensureUnsubscribe(m);
    ensureInlineImages(m);
    if (m.needsBody) ensureMessageBody(m);
  });
  if (revealReading) {
    revealReading = false;
    const draftIsHead = !!(threadDraft && threadHead(conv).id === threadDraft.id);
    if (showDraftCard && threadDraft && (selected === threadDraft.id || (draftIsHead && selected === conv.latest.id))) revealThreadDraft();
    else revealSelectedMessage();
  }
  bindAskCard();
}

function renderReading() {
  hidePartyCard();
  captureReplyDraft();
  capturePaneCompose();
  if (view === "mail" && picked.size > 1 && !paneCompose) {
    const key = "bulk\n" + [...picked].sort().join("\n");
    if (reading.dataset.paint === key) return;
    reading.innerHTML = bulkPanelHtml();
    bindBulkPanel();
    reading.dataset.paint = key;
    return;
  }
  if (paneCompose && view === "mail" && (!paneCompose.from || accountInProfile(fromAccountId(paneCompose.from) || paneCompose.from))) {
    const key = "compose\n" + composeDraftStamp(paneCompose);
    if (reading.dataset.paint === key) return;
    paintPaneCompose();
    reading.dataset.paint = key;
    return;
  }
  const conv = conversationFor(selected);
  if (!conv) {
    const key = "empty\n" + stampText(askAnswer) + "\n" + (syncNote || "");
    if (reading.dataset.paint === key) {
      bindAskCard();
      return;
    }
    reading.innerHTML = askAnswer
      ? `<div class="read-body">${askCardHtml()}</div>`
      : (syncNote ? `<div class="empty">${esc(syncNote)}</div>` : emptyReadingHtml());
    bindAskCard();
    reading.dataset.paint = key;
    return;
  }
  const folderDraft = box === "drafts" && conv.latest.draft ? conv.latest : null;
  const threadDraft = folderDraft ? null : sameThreadDraft(conv);
  const shownDraft = folderDraft || threadDraft;
  if (shownDraft && shownDraft.needsBody) ensureMessageBody(shownDraft);
  const answering = replyDraft && conv.messages.some(m => m.id === replyDraft.msgId) && (!shownDraft || replyDraft.draftId !== shownDraft.id);
  if (shownDraft && !answering && (!replyDraft || replyDraft.draftId !== shownDraft.id)) {
    replyDraft = draftState(shownDraft);
  }
  const usingDraft = !!(shownDraft && replyDraft && replyDraft.draftId === shownDraft.id);
  const replyMsg = !folderDraft && replyDraft && conv.messages.find(m => m.id === replyDraft.msgId);
  const showReply = !!replyMsg && replyView !== "message";
  const showDraftCard = usingDraft && !replyMsg && !folderDraft;
  const shown = folderDraft ? conv.messages : threadShown(conv);
  const ordered = folderDraft ? [] : shown.slice().reverse();
  const replyOrder = replyMsg ? [replyMsg, ...ordered.filter(m => m.id !== replyMsg.id)] : ordered;
  const many = ordered.length > 1;
  const newest = shown.filter(m => !m.draft).pop() || conv.latest;
  const openMessage = (m) => !folded.has(m.id) && (m.id === conv.latest.id || m.id === newest.id || m.id === selected || expanded.has(m.id) || (replyMsg && replyMsg.id === m.id));
  const where = messageBox(conv.latest);
  const held = conv.latest.pendingSend ? conv.latest : null;
  const paintKey = readingThreadKey(conv, ordered, openMessage, where, held, showReply, showDraftCard, folderDraft);
  if (reading.dataset.paint === paintKey) {
    warmOpenReading(conv, ordered, openMessage, folderDraft, showDraftCard, threadDraft);
    return;
  }
  const forwarding = !!(replyDraft && replyDraft.compose === "forward");
  const composeKind = usingDraft && shownDraft && !shownDraft.replyTo ? "new" : "reply";
  const composer = (folderDraft || replyMsg || showDraftCard) ? composeMarkup({
    mode: "inline",
    title: replyMsg ? (forwarding ? "Forward" : "Reply to " + replyMsg.from) : "",
    msgId: replyDraft.msgId,
    fromId: replyDraft.from,
    to: replyDraft.to,
    cc: replyDraft.cc,
    bcc: replyDraft.bcc,
    attachments: replyDraft.attachments,
    subject: replyDraft.subject,
    bodyHtml: replyDraft.bodyHtml,
    meeting: replyDraft.meeting,
    kind: composeKind,
    hideAddress: !!replyMsg && !forwarding,
    includeHistory: showReply || !replyMsg,
    openHistory: true,
    bare: !!replyMsg
  }) : "";
  const threadBlocks = replyOrder.map(m => {
    if (showDraftCard && threadDraft && m.id === threadDraft.id) {
      return `<div class="thread-draft" data-draft="${esc(m.id)}"><div class="thread-draft-label">Draft</div>${composer}</div>`;
    }
    return messageBlock(m, openMessage(m), many);
  }).join("");
  const icon = (id, label, path) => `<button class="icon-btn" type="button" id="${id}" title="${label}" aria-label="${label}">${path}</button>`;
  const readIcon = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.8 8.2L10 13l7.2-4.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M3.2 7.6V15h13.6V7.6L10 3.2 3.2 7.6z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
  const unreadIcon = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="5" width="14" height="10" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.8 6.2L10 11l6.2-4.8" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="15.2" cy="5.2" r="2.1" fill="var(--blue)" stroke="none"/></svg>`;
  const archiveIcon = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3.2 4.5h13.6v2.8H3.2V4.5zM4.4 7.3V15.5h11.2V7.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 11.2h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  const deleteIcon = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6.5h11M8 6.4V4.8h4v1.6M7.2 6.5l.5 8.8h4.6l.5-8.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const flagIcon = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3.2v13.4M6 4h8l-2.2 3.2L14 10.4H6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  const restoreIcon = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5.5H4.2V2.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.6 6a6 6 0 11.4 6.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
  const tagIcon = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3.6 4.6v4.6l7 7 5.2-5.2-7-7H4.4a.8.8 0 0 0-.8.6z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="7" cy="7.2" r="1.1" fill="currentColor"/></svg>`;
  const snoozeIcon = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10.8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8.2 8.6h3.6l-3.6 4.2h3.6M4.4 3.6 2.8 5.2M15.6 3.6l1.6 1.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const moveIcon = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.8 5.3c0-.6.4-1 1-1h3.6l1.5 1.6h7.3c.6 0 1 .4 1 1v8c0 .6-.4 1-1 1H3.8c-.6 0-1-.4-1-1V5.3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M7.5 11h5M10.8 8.8 13 11l-2.2 2.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const inboxIcon = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 11.2h14l-1.8 4.6H4.8L3 11.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M10 3.2v7M7.4 7.6L10 10.2l2.6-2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const clipIcon = `<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M13.6 6.2 7.9 11.9a1.6 1.6 0 0 0 2.3 2.3l5.9-5.9a3 3 0 0 0-4.3-4.3l-6 6a4.4 4.4 0 0 0 6.2 6.2l5.2-5.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  // While you write a reply the paperclip would read as yours; it lists
  // the thread's files, so it waits until you are reading again.
  const fileTotal = folderDraft || showReply ? 0 : shown.reduce((n, m) => n + (messageFiles(m).length || (m.hasAttachment ? 1 : 0)), 0);
  const tools = (folderDraft || held)
    ? icon("delete", "Delete", deleteIcon)
    : `${icon("reply", "Reply", replyIcon)}
        ${icon("reply-all", "Reply all", replyAllIcon)}
        ${icon("forward", "Forward", forwardIcon)}
        ${icon("reply-invite", "Reply with invite", replyInviteIcon)}
        ${fileTotal ? `<button class="icon-btn files-btn" type="button" id="thread-files" title="Attachments (${fileTotal})" aria-label="Attachments (${fileTotal})" aria-haspopup="menu">${clipIcon}<span class="files-count">${fileTotal}</span></button>` : ""}
        ${icon("mark-read", "Mark as read", readIcon)}
        ${icon("mark-unread", "Mark as unread", unreadIcon)}
        ${where === "trash" ? icon("restore", "Restore", restoreIcon) : ""}
        ${where === "archive" || folderKind(where, conv.latest.account) === "junk" ? icon("to-inbox", "Move to inbox", inboxIcon) : ""}
        ${where !== "trash" && where !== "archive" ? icon("archive", "Archive", archiveIcon) : ""}
        ${where !== "drafts" && where !== "outbox" ? icon("move-to", "Move to…", moveIcon) : ""}
        ${where !== "drafts" && where !== "outbox" && !isGoogleAccount(conv.latest.account) ? icon("categorize", "Categorize", tagIcon) : ""}
        ${where === "inbox" || where === "archive" ? icon("snooze", "Snooze", snoozeIcon) : ""}
        ${where !== "trash" ? icon("delete", "Delete", deleteIcon) : ""}
        ${icon("flag", "Flag", flagIcon)}`;
  const subjectLine = conv.topic;
  const threadCount = shown.length;
  reading.innerHTML = `
    <div class="read-head">
      <div class="toolbar">${tools}</div>
    </div>
    <div class="read-subject">
      <h2>${esc(subjectLine)}${!folderDraft && threadCount > 1 ? `<span class="thread-meta">${threadCount} messages</span>` : ""}</h2>
    </div>
    <div class="read-body${showReply ? " reply-pane" : ""}">
      ${askCardHtml()}
      ${held ? pendingHoldHtml(held) : ""}
      ${showReply ? composer : ""}
      ${folderDraft ? composer : (showReply ? "" : `<div class="thread">${threadBlocks}</div>`)}
    </div>
    ${replyMsg ? replyTabsHtml(conv, replyMsg) : ""}
  `;
  if (!folderDraft) loadThreadSent(conv);
  if ((folderDraft || showReply || showDraftCard) && reading.querySelector("#compose-form")) bindCompose(reading, { mode: "inline", kind: composeKind, draft: replyDraft });
  if (replyMsg) bindReplyTabs();
  const undo = document.getElementById("undo-send");
  if (undo && held) undo.onclick = () => undoPending(held.id);
  const retry = document.getElementById("retry-send");
  if (retry && held) retry.onclick = () => retryPending(held.id);
  if (focusReply) {
    focusReply = false;
    const forwardTo = replyDraft && replyDraft.compose === "forward" ? document.getElementById("compose-to") : null;
    if (forwardTo) {
      forwardTo.focus();
      const pane = forwardTo.closest(".read-body");
      if (pane) pane.scrollTop = 0;
    }
    const body = document.getElementById("compose-body");
    if (!forwardTo && body) {
      const write = body.querySelector(".body-write") || body;
      body.focus();
      const range = document.createRange();
      range.selectNodeContents(write);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      const pane = body.closest(".read-body");
      if (pane) pane.scrollTop = 0;
      const canvas = body.closest(".compose-canvas");
      if (canvas) canvas.scrollTop = 0;
    }
  }
  const reply = document.getElementById("reply");
  const replyAll = document.getElementById("reply-all");
  const archive = document.getElementById("archive");
  const flag = document.getElementById("flag");
  const replyTarget = conv.messages.find(m => m.id === selected) || conv.latest;
  if (reply) reply.onclick = () => startReply(replyTarget, false);
  if (replyAll) replyAll.onclick = () => startReply(replyTarget, true);
  const replyInvite = document.getElementById("reply-invite");
  if (replyInvite) replyInvite.onclick = () => startReplyWithInvite(replyTarget);
  const forward = document.getElementById("forward");
  if (forward) forward.onclick = () => startForward(replyTarget);
  reading.querySelectorAll("[data-party]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const msg = messages.find(item => item.id === btn.dataset.party);
      if (msg) showPartyCard(msg, btn);
    };
  });
  reading.querySelectorAll("[data-person]").forEach(btn => {
    btn.onclick = () => {
      selectedContact = btn.dataset.person;
      contactAccount = "all";
      document.body.dataset.open = "1";
      setView("people");
    };
  });
  reading.querySelectorAll("[data-fold]").forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.fold;
      folded.delete(id);
      expanded.add(id);
      selected = id;
      revealReading = true;
      const msg = messages.find(m => m.id === id);
      if (msg && msg.unread) setUnread([msg], false, false);
      else render();
    };
  });
  reading.querySelectorAll("[data-collapse]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      folded.add(btn.dataset.collapse);
      expanded.delete(btn.dataset.collapse);
      renderReading();
    };
  });
  reading.querySelectorAll("[data-pick]").forEach(card => {
    card.addEventListener("click", (ev) => {
      if (ev.target.closest("a, button, input, textarea, select, .html-body")) return;
      if (selected === card.dataset.pick) return;
      selected = card.dataset.pick;
      revealReading = true;
      const msg = messages.find(m => m.id === selected);
      if (msg && msg.unread) setUnread([msg], false, false);
      else render();
    });
  });
  reading.querySelectorAll("[data-show-remote]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      shownRemote.add(btn.dataset.showRemote);
      renderReading();
    };
  });
  reading.querySelectorAll("[data-trust-sender]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const msg = messages.find(item => item.id === btn.dataset.trustSender);
      const domain = msg && organisationalDomain(msg.email);
      if (!domain || !addSafeSender(domain)) return;
      toast("Added " + domain + " to Safe senders");
      renderReading();
    };
  });
  reading.querySelectorAll("[data-open-mail-file]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const msg = messages.find(m => m.id === btn.dataset.fileMsg);
      if (!msg) return;
      openAttachment(msg, {
        id: btn.dataset.fileId || "",
        name: btn.dataset.fileName || "",
        unknown: btn.dataset.fileUnknown === "1"
      });
    };
  });
  reading.querySelectorAll("[data-download-pick]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const msg = messages.find(m => m.id === btn.dataset.downloadPick);
      if (msg) openDownloadPicker(msg);
    };
  });
  reading.querySelectorAll("[data-light-view]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.lightView;
      if (lightView.has(id)) lightView.delete(id); else lightView.add(id);
      renderReading();
    };
  });
  reading.querySelectorAll("[data-unsubscribe]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const msg = messages.find(m => m.id === btn.dataset.unsubscribe);
      if (msg) unsubscribeFrom(msg);
    };
  });
  reading.querySelectorAll("[data-download-all]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const msg = messages.find(m => m.id === btn.dataset.downloadAll);
      if (msg) startDownloadAll(msg);
    };
  });
  reading.querySelectorAll("[data-reply]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const msg = messages.find(m => m.id === btn.dataset.reply);
      if (msg) startReply(msg, false);
    };
  });
  reading.querySelectorAll("[data-reply-all]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const msg = messages.find(m => m.id === btn.dataset.replyAll);
      if (msg) startReply(msg, true);
    };
  });
  reading.querySelectorAll("[data-forward]").forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const msg = messages.find(m => m.id === btn.dataset.forward);
      if (msg) startForward(msg);
    };
  });
  const trash = document.getElementById("delete");
  const restore = document.getElementById("restore");
  const toInbox = document.getElementById("to-inbox");
  if (archive) archive.onclick = () => { moveConversation(conv, "archive"); toastMove("Archived"); };
  if (trash) trash.onclick = () => { moveConversation(conv, "trash"); toastMove("Moved to Trash"); };
  if (restore) restore.onclick = () => moveToInbox(conv.messages);
  if (toInbox) toInbox.onclick = () => moveToInbox(conv.messages);
  const filesBtn = document.getElementById("thread-files");
  if (filesBtn) filesBtn.onclick = () => { const r = filesBtn.getBoundingClientRect(); showFilesMenu(r.left, r.bottom + 4, threadShown(conv)); };
  const catBtn = document.getElementById("categorize");
  if (catBtn) catBtn.onclick = () => { const r = catBtn.getBoundingClientRect(); showCategoryMenu(r.left, r.bottom + 4, conv.messages.filter(m => messageBox(m) === where)); };
  const snoozeBtn = document.getElementById("snooze");
  if (snoozeBtn) snoozeBtn.onclick = () => snoozeMessages(conv.messages.filter(m => messageBox(m) === where));
  const moveTo = document.getElementById("move-to");
  if (moveTo) moveTo.onclick = () => showMoveDialog(conv.messages.filter(m => messageBox(m) === where));
  const markReadBtn = document.getElementById("mark-read");
  const markUnreadBtn = document.getElementById("mark-unread");
  if (markReadBtn) markReadBtn.onclick = () => markRead(selected, true);
  if (markUnreadBtn) markUnreadBtn.onclick = () => markUnread(selected);
  if (flag) {
    const msg = messages.find(m => m.id === selected) || conv.latest;
    flag.setAttribute("aria-pressed", msg && msg.flagged ? "true" : "false");
    flag.onclick = () => { if (msg) toggleFlag(msg.id); };
  }
  reading.querySelectorAll("[data-clash-day]").forEach(btn => {
    btn.onclick = () => {
      calFocus = dateFromDay(Number(btn.dataset.clashDay));
      setView("calendar");
      refreshLiveCalendar();
    };
  });
  reading.querySelectorAll("[data-rsvp]").forEach(btn => {
    btn.onclick = () => {
      const group = btn.closest("[data-rsvp-msg]");
      const msg = group ? messages.find(m => m.id === group.dataset.rsvpMsg) : null;
      if (msg && msg.liveInvite) {
        btn.closest(".rsvp").querySelectorAll("button").forEach(b => { b.disabled = true; });
        const title = msg.liveInvite.subject || msg.subject;
        const answer = btn.dataset.rsvp;
        answerLiveMeeting(msg.account, msg.liveInvite.eventId, answer, title).then(done => {
          // As in Outlook: the meeting is on the calendar now, so the invite
          // goes to Deleted Items (with Undo).
          if (!done || !tidyInvites || messageBox(msg) === "trash") return;
          moveConversation({ messages: [msg] }, "trash");
          toastMove(label(answer) + " · " + title + ". The invite is in Deleted Items.");
        }).finally(() => { if (view === "mail") renderReading(); });
        return;
      }
      const ev = events.find(e => e.id === "pipeline");
      if (ev) applyEventResponse(ev, btn.dataset.rsvp);
      else rsvp = btn.dataset.rsvp;
      toast(label(btn.dataset.rsvp) + " · Pipeline review");
      render();
    };
  });
  fitWideMail(reading);
  reading.dataset.paint = paintKey;
  warmOpenReading(conv, ordered, openMessage, folderDraft, showDraftCard, threadDraft);
}

function revealThreadDraft() {
  const body = reading.querySelector(".read-body");
  const card = body && body.querySelector(".thread-draft");
  if (!body || !card) return;
  const top = card.getBoundingClientRect().top - body.getBoundingClientRect().top;
  if (top >= -1 && top <= 20) return;
  body.scrollTop += top - 8;
}

function revealSelectedMessage() {
  const body = reading.querySelector(".read-body");
  if (!body || !selected) return;
  const card = [...body.querySelectorAll("[data-pick], [data-fold]")].find(el => (el.dataset.pick || el.dataset.fold) === selected);
  if (!card) return;
  const nearTop = () => {
    const top = card.getBoundingClientRect().top - body.getBoundingClientRect().top;
    return top >= -1 && top <= 20;
  };
  if (nearTop()) return;
  const thread = body.querySelector(".thread");
  if (thread) {
    const room = body.clientHeight - Math.min(card.offsetHeight, body.clientHeight) - 16;
    if (room > 0) thread.style.paddingBottom = room + "px";
  }
  const top = card.getBoundingClientRect().top - body.getBoundingClientRect().top;
  body.scrollTop += top - 8;
}

const filesLoaded = new Set();
const filesLoading = new Set();

function downloadableFiles(msg) {
  return messageFiles(msg).filter(file => file && file.name && !file.unknown);
}

function toastDownloadUnavailable(msg) {
  toast(serverMessage(msg) ? "That attachment could not be downloaded from here." : "This sample file is not on this computer.");
}

function openDownloadPicker(msg) {
  const files = downloadableFiles(msg);
  if (!files.length) {
    toastDownloadUnavailable(msg);
    return;
  }
  popRoot.innerHTML = `
    <div class="backdrop dim" id="backdrop"></div>
    <form class="dialog" id="download-dialog" role="dialog" aria-modal="true" aria-label="Download attachments">
      <h2>Download</h2>
      <p class="dialog-note">Select the attachments to download.</p>
      <ul class="download-list">
        ${files.map((file, index) => `<li><label><input type="checkbox" data-download-file="${index}" checked>${fileTypeMark(file)}<span class="file-copy"><span class="file-name">${esc(file.name)}</span>${fileSizeLabel(file.size) ? `<span class="file-size">${esc(fileSizeLabel(file.size))}</span>` : ""}</span></label></li>`).join("")}
      </ul>
      <div class="dialog-actions">
        <button class="ghost" type="button" id="cancel">Cancel</button>
        <button class="primary" type="submit" id="download-go">Download</button>
      </div>
    </form>`;
  const form = document.getElementById("download-dialog");
  const go = document.getElementById("download-go");
  const sync = () => {
    go.disabled = ![...form.querySelectorAll("[data-download-file]")].some(box => box.checked);
  };
  form.querySelectorAll("[data-download-file]").forEach(box => { box.onchange = sync; });
  document.getElementById("backdrop").onclick = closePop;
  document.getElementById("cancel").onclick = closePop;
  form.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    closePop();
  });
  form.onsubmit = (ev) => {
    ev.preventDefault();
    const chosen = [...form.querySelectorAll("[data-download-file]")]
      .filter(box => box.checked)
      .map(box => files[Number(box.dataset.downloadFile)])
      .filter(Boolean);
    closePop();
    if (!chosen.length) {
      toast("Select an attachment.");
      return;
    }
    saveChosenAttachments(msg, chosen);
  };
  go.focus();
}

function startDownloadAll(msg) {
  const files = downloadableFiles(msg);
  if (!files.length) {
    toastDownloadUnavailable(msg);
    return;
  }
  saveChosenAttachments(msg, files);
}

async function saveChosenAttachments(msg, files) {
  if (!serverMessage(msg) || files.some(file => !file.id)) {
    toastDownloadUnavailable(msg);
    return;
  }
  const email = String((accounts[msg.account] && accounts[msg.account].email) || "");
  let directory = "";
  try {
    directory = await tauriInvoke("pick_download_folder");
  } catch (err) {
    toast(String(err && err.message || err || "The folder picker could not be opened."));
    return;
  }
  if (!directory) return;
  try {
    const count = await tauriInvoke("save_attachments", {
      email,
      messageId: msg.id,
      message_id: msg.id,
      directory,
      files: files.map(file => ({ id: file.id, name: file.name }))
    });
    const n = Number(count) || files.length;
    toast(n === 1 ? "Downloaded 1 attachment." : "Downloaded " + n + " attachments.");
  } catch (err) {
    toast(String(err && err.message || err || "That attachment could not be downloaded."));
  }
}

// ---- The attachment viewer (2026-10-23): PDFs and pictures open here,
// as in Outlook, with Download and Open in another app. pdf.js is vendored
// (vendor/pdfjs) and given the bytes, so it fetches nothing. The PDF's own
// words are drawn on top of the page, transparent, so they can be
// highlighted and copied.
function previewable(file) {
  const name = String(file && file.name || "").toLowerCase();
  const type = String(file && (file.type || file.contentType) || "").toLowerCase();
  return /\.(pdf|png|jpe?g|gif|webp)$/.test(name) || type === "application/pdf" || /^image\/(png|jpe?g|gif|webp)$/.test(type);
}

let viewerSerial = 0;
let pdfLib = null;
let viewerDoc = null;
let viewerWatch = null;

function closeViewer() {
  viewerSerial += 1;
  // pdf.js keeps a document, its pages and fonts until its loading task is
  // destroyed (6.x has no destroy() on the document itself).
  if (viewerWatch) { viewerWatch.disconnect(); viewerWatch = null; }
  if (viewerDoc) { viewerDoc.loadingTask.destroy(); viewerDoc = null; }
  const layer = document.getElementById("viewer");
  if (layer) layer.remove();
  document.removeEventListener("keydown", viewerKeys, true);
}

function viewerKeys(ev) {
  if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeViewer(); return; }
  // Select the page text, not the message list behind the viewer.
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a") {
    const body = document.getElementById("viewer-body");
    if (!body) return;
    ev.preventDefault();
    ev.stopPropagation();
    const range = document.createRange();
    range.selectNodeContents(body);
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

async function openViewer(msg, file) {
  closeViewer();
  const serial = ++viewerSerial;
  const layer = document.createElement("div");
  layer.id = "viewer";
  layer.setAttribute("role", "dialog");
  layer.setAttribute("aria-modal", "true");
  layer.setAttribute("aria-label", file.name);
  layer.innerHTML = `<div class="viewer-bar">
      <span class="viewer-name" title="${esc(file.name)}">${esc(file.name)}</span>
      <span class="viewer-pages" id="viewer-pages"></span>
      <span class="viewer-spacer"></span>
      <button type="button" class="icon-btn" id="viewer-out" title="Zoom out" aria-label="Zoom out" hidden>−</button>
      <button type="button" class="icon-btn" id="viewer-in" title="Zoom in" aria-label="Zoom in" hidden>+</button>
      <button type="button" class="linkish" id="viewer-download">Download</button>
      <button type="button" class="linkish" id="viewer-open">Open in another app</button>
      <button type="button" class="icon-btn" id="viewer-close" title="Close" aria-label="Close"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
    </div>
    <div class="viewer-body" id="viewer-body"><p class="viewer-note">Opening…</p></div>`;
  document.body.appendChild(layer);
  document.addEventListener("keydown", viewerKeys, true);
  layer.querySelector("#viewer-close").onclick = closeViewer;
  layer.querySelector("#viewer-open").onclick = () => { closeViewer(); openAttachmentOutside(msg, file); };
  layer.querySelector("#viewer-download").onclick = () => saveChosenAttachments(msg, [file]);
  const body = layer.querySelector("#viewer-body");
  const email = String((accounts[msg.account] && accounts[msg.account].email) || "");
  let got;
  try {
    got = await tauriInvoke("attachment_preview", { email, messageId: msg.id, message_id: msg.id, fileId: file.id, file_id: file.id, name: file.name, contentType: file.type || "", content_type: file.type || "" });
  } catch (err) {
    if (serial !== viewerSerial) return;
    body.innerHTML = `<p class="viewer-note">${esc(String(err && err.message || err || "That file could not be previewed."))}</p>`;
    return;
  }
  if (serial !== viewerSerial || !got) return;
  const type = String(got.contentType || got.content_type || "");
  const data = String(got.data || "");
  if (/^image\/(png|jpeg|gif|webp|bmp)$/.test(type) && /^[A-Za-z0-9+/=]+$/.test(data)) {
    body.innerHTML = "";
    const img = document.createElement("img");
    img.className = "viewer-image";
    img.alt = file.name;
    img.src = "data:" + type + ";base64," + data;
    body.appendChild(img);
    return;
  }
  if (type !== "application/pdf") {
    body.innerHTML = `<p class="viewer-note">Mailroom can't preview that type of file. Open it instead.</p>`;
    return;
  }
  try {
    if (!pdfLib) {
      pdfLib = await import("./vendor/pdfjs/pdf.min.mjs");
      pdfLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";
    }
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // The scan decoders (JBIG2/CCITT, JPEG 2000) live beside pdf.js, in
    // their JavaScript builds: the CSP allows no WebAssembly. Without them
    // pdf.js drops those images, which hold the text of most copier scans.
    const wasmUrl = new URL("./vendor/pdfjs/", location.href).href;
    const doc = await pdfLib.getDocument({ data: bytes, isEvalSupported: false, enableXfa: false, disableFontFace: false, useWasm: false, wasmUrl }).promise;
    if (serial !== viewerSerial) { doc.loadingTask.destroy(); return; }
    viewerDoc = doc;
    let zoom = 1;
    const pages = Math.min(doc.numPages, 300);
    layer.querySelector("#viewer-pages").textContent = doc.numPages === 1 ? "1 page" : doc.numPages + " pages";
    // A page drawn at full resolution is tens of MB on a 2x screen, so only
    // the pages near the view are drawn; one scrolled well away gives its
    // picture and text back, and is drawn again on the way back.
    const release = (sheet) => {
      const st = sheet._pdf;
      if (!st || !st.drawn) return;
      st.drawn = false;
      st.serial += 1;
      if (st.task) { st.task.cancel(); st.task = null; }
      const canvas = sheet.querySelector(".viewer-page");
      canvas.width = canvas.height = 0;
      sheet.querySelector(".textLayer").textContent = "";
      st.page.cleanup();
    };
    const paint = async (sheet) => {
      const st = sheet._pdf;
      if (st.drawn) return;
      st.drawn = true;
      const mine = ++st.serial;
      const canvas = sheet.querySelector(".viewer-page");
      canvas.width = Math.floor(st.pixelView.width);
      canvas.height = Math.floor(st.pixelView.height);
      const textLayer = new pdfLib.TextLayer({
        textContentSource: st.page.streamTextContent({ includeMarkedContent: true }),
        container: sheet.querySelector(".textLayer"),
        viewport: st.cssView
      });
      st.task = st.page.render({ canvasContext: canvas.getContext("2d"), viewport: st.pixelView });
      try {
        await Promise.all([st.task.promise, textLayer.render()]);
      } catch (err) {
        if (mine === st.serial && viewerDoc === doc && !(err && err.name === "RenderingCancelledException")) throw err;
      }
      if (mine === st.serial) st.task = null;
    };
    const draw = async () => {
      const mine = ++viewerSerial;
      if (viewerWatch) viewerWatch.disconnect();
      body.querySelectorAll(".viewer-sheet").forEach(release);
      body.innerHTML = "";
      const width = Math.min(body.clientWidth - 48, 1100);
      const ratio = window.devicePixelRatio || 1;
      viewerWatch = new IntersectionObserver(seen => seen.forEach(entry => {
        if (entry.isIntersecting) paint(entry.target).catch(err => console.error(err));
        else release(entry.target);
      }), { root: body, rootMargin: "150% 0px" });
      for (let n = 1; n <= pages; n++) {
        const page = await doc.getPage(n);
        if (mine !== viewerSerial) return;
        const base = page.getViewport({ scale: 1 });
        const scale = (width / base.width) * zoom;
        const cssView = page.getViewport({ scale });
        const sheet = document.createElement("div");
        sheet.className = "viewer-sheet";
        sheet.style.setProperty("--scale-factor", String(cssView.scale));
        const canvas = document.createElement("canvas");
        canvas.className = "viewer-page";
        canvas.width = canvas.height = 0;
        canvas.style.width = Math.floor(cssView.width) + "px";
        canvas.style.height = Math.floor(cssView.height) + "px";
        const textLayerDiv = document.createElement("div");
        textLayerDiv.className = "textLayer";
        sheet.append(canvas, textLayerDiv);
        sheet._pdf = { page, cssView, pixelView: page.getViewport({ scale: scale * ratio }), drawn: false, serial: 0, task: null };
        body.appendChild(sheet);
        viewerWatch.observe(sheet);
      }
      if (doc.numPages > pages) body.insertAdjacentHTML("beforeend", `<p class="viewer-note">The first ${pages} pages. Open it to see the rest.</p>`);
    };
    const zoomBy = (f) => { zoom = Math.min(3, Math.max(0.5, zoom * f)); draw(); };
    const out = layer.querySelector("#viewer-out"), into = layer.querySelector("#viewer-in");
    out.hidden = into.hidden = false;
    out.onclick = () => zoomBy(1 / 1.25);
    into.onclick = () => zoomBy(1.25);
    await draw();
  } catch (err) {
    if (serial !== viewerSerial && !document.getElementById("viewer")) return;
    console.error(err);
    body.innerHTML = `<p class="viewer-note">That PDF could not be shown here. Open it instead.</p>`;
  }
}

function openAttachment(msg, file) {
  if (inDesktop() && msg && file && file.id && !file.unknown && serverMessage(msg) && previewable(file)) {
    openViewer(msg, file);
    return;
  }
  openAttachmentOutside(msg, file);
}

function openAttachmentOutside(msg, file) {
  if (!msg || !file || file.unknown || !file.name) {
    toast("That attachment could not be opened from here.");
    return;
  }
  if (!serverMessage(msg) || !file.id) {
    toast(serverMessage(msg) ? "That attachment could not be opened from here." : "This sample file is not on this computer.");
    return;
  }
  const email = String((accounts[msg.account] && accounts[msg.account].email) || "");
  const pending = tauriInvoke("open_attachment", {
    email,
    messageId: msg.id,
    message_id: msg.id,
    fileId: file.id,
    file_id: file.id,
    name: file.name
  });
  if (pending && pending.then) {
    pending.catch(err => toast(String(err && err.message || err || "That file could not be opened.")));
  }
}

function applyMessageFiles(messageId, files) {
  const current = messages.find(item => item.id === messageId);
  if (!current) return;
  const list = (Array.isArray(files) ? files : []).map(item => ({
    id: item.id || "",
    name: item.name || "",
    type: item.contentType || item.type || "",
    size: Number(item.size) || 0
  })).filter(item => item.name);
  current.files = list;
  current.attachments = list.map(item => item.name);
  if (list.length) current.hasAttachment = true;
}

// Messages shown with a light background in dark mode, as Outlook's sun
// button does; for this session.
const lightView = new Set();

// ---- Inline images (2026-10-23): a body's cid: pictures — a signature's
// logo, a pasted screenshot — fetched once per message and put in place as
// data URLs, as Outlook shows them. Until they arrive the cid: link stays,
// and a message without any never asks.
const inlineImagesFor = new Map();
const inlineLoading = new Set();

function withInlineImages(m, html) {
  const got = m && inlineImagesFor.get(m.id);
  const found = got && got.byCid;
  if (!found || !found.size || !/cid:/i.test(html || "")) return html;
  return String(html).replace(/(\b(?:src|background)\s*=\s*)(["']?)cid:([^"'\s>]+)\2/gi, (all, attr, quote, raw) => {
    let id = raw;
    try { id = decodeURIComponent(raw); } catch (e) {}
    const url = found.get(id) || found.get(id.toLowerCase());
    return url ? attr + '"' + url + '"' : all;
  });
}

// The cid: names a body shows.
function bodyCids(html) {
  const out = new Set();
  String(html || "").replace(/cid:([^"'\s>)]+)/gi, (all, raw) => {
    let id = raw;
    try { id = decodeURIComponent(raw); } catch (e) {}
    out.add(id.toLowerCase());
    return all;
  });
  return out;
}

// Images to show as thumbnails: image attachments, and inline images the
// body doesn't show, as Outlook does.
function thumbnailImages(m) {
  const got = m && inlineImagesFor.get(m.id);
  if (!got) return [];
  const shown = bodyCids(m.bodyHtml);
  return got.list.filter(img => !img.inline || !img.contentId || !shown.has(img.contentId.toLowerCase()));
}

function ensureInlineImages(m) {
  if (!m || !serverMessage(m) || inlineImagesFor.has(m.id) || inlineLoading.has(m.id)) return;
  if (!/cid:/i.test(m.bodyHtml || "") && !m.hasAttachment) return;
  const acct = accounts[m.account];
  if (!acct || !acct.email) return;
  inlineLoading.add(m.id);
  Promise.resolve(tauriInvoke("inline_images", { email: acct.email, messageId: m.id, message_id: m.id })).then(list => {
    const map = new Map();
    const kept = [];
    (list || []).forEach(img => {
      const id = String(img.contentId || img.content_id || "");
      const url = String(img.dataUrl || img.data_url || "");
      if (!/^data:image\/(png|gif|jpeg|webp|bmp);base64,[A-Za-z0-9+/=]+$/.test(url)) return;
      if (id) { map.set(id, url); map.set(id.toLowerCase(), url); }
      kept.push({ id: String(img.id || ""), name: String(img.name || "image"), contentId: id, inline: !!img.inline, url });
    });
    inlineImagesFor.set(m.id, { byCid: map, list: kept });
    if (kept.length && view === "mail") renderReading();
  }).catch(() => {}).finally(() => inlineLoading.delete(m.id));
}

// A picture the webview refuses once the reader has allowed pictures (a
// server's Cross-Origin-Resource-Policy lets only its own pages show it) is
// fetched by the app instead (remoteimg.rs), once per address. Errors don't
// bubble, so the reading pane listens while they pass down.
const fetchedPictures = new Map();
reading.addEventListener("error", (ev) => {
  const img = ev.target;
  if (!img || img.tagName !== "IMG" || img.dataset.refetched || !inDesktop()) return;
  const url = img.getAttribute("src") || "";
  if (!/^https:\/\//i.test(url)) return;
  img.dataset.refetched = "1";
  if (!fetchedPictures.has(url)) {
    fetchedPictures.set(url, Promise.resolve(tauriInvoke("remote_image", { url })).catch(() => ""));
  }
  fetchedPictures.get(url).then(data => {
    if (/^data:image\/(png|gif|jpeg|webp|bmp);base64,[A-Za-z0-9+/=]+$/.test(String(data || "")) && img.getAttribute("src") === url) img.src = data;
  });
}, true);

function ensureMessageFiles(m) {
  if (!serverMessage(m) || !m.hasAttachment) return;
  if (messageFiles(m).length || filesLoaded.has(m.id) || filesLoading.has(m.id)) return;
  filesLoading.add(m.id);
  const email = String((accounts[m.account] && accounts[m.account].email) || "");
  const pending = tauriInvoke("message_files", { email, messageId: m.id, message_id: m.id });
  if (!pending || !pending.then) {
    filesLoading.delete(m.id);
    filesLoaded.add(m.id);
    return;
  }
  pending.then(files => applyMessageFiles(m.id, files)).catch(() => {}).finally(() => {
    filesLoading.delete(m.id);
    filesLoaded.add(m.id);
    if (view === "mail") render();
  });
}

const inviteChecked = new Set();

// What a meeting invite clashes with on your own calendar (2026-10-28), as
// Outlook flags it: meetings, all-day events and out-of-office time that
// overlap it, leaving out free time, declined meetings and the invite's own
// tentative copy. Only days the calendar has loaded are checked; otherwise
// nothing is said rather than a wrong "no conflicts".
function inviteClashes(m) {
  const inv = m && m.liveInvite;
  if (!inv || inv.cancelled || inv.organizer) return null;
  const allDayInvite = !!inv.allDay;
  const from = allDayInvite ? new Date(String(inv.start || "").slice(0, 10) + "T00:00:00") : new Date(inv.start);
  let to = allDayInvite ? new Date(String(inv.end || "").slice(0, 10) + "T00:00:00") : new Date(inv.end);
  if (isNaN(from)) return null;
  if (isNaN(to) || to <= from) to = new Date(from.getTime() + (allDayInvite ? 86400000 : 1800000));
  const mark = calendarSynced.get(m.account);
  if (!mark || from < new Date(mark.start) || to > new Date(mark.end)) return null;
  const same = ev => (inv.eventId && (ev.eventId === inv.eventId || ev.seriesMasterId === inv.eventId))
    || (String(ev.title || "") === String(inv.subject || m.subject || "") && ev.tentative);
  const counts = ev => ev.account === m.account && !ev.hidden && ev.response !== "declined" && showAsOf(ev) !== "free" && !same(ev);
  const firstDay = dayFromDate(from);
  const lastDay = dayFromDate(new Date(to.getTime() - 1));
  const found = [];
  const seen = new Set();
  allday.forEach(ev => {
    if (ev.day < firstDay || ev.day > lastDay || !counts(ev)) return;
    const key = ev.eventId || ev.id;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ title: ev.title, day: ev.day, allDay: true, oof: showAsOf(ev) === "oof" });
  });
  events.forEach(ev => {
    if (ev.day < firstDay || ev.day > lastDay || ev.start == null || !counts(ev)) return;
    const date = dateFromDay(ev.day);
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, ev.start).getTime();
    const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, ev.end).getTime();
    if (!(start < to.getTime() && end > from.getTime())) return;
    const key = ev.eventId || ev.id;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ title: ev.title, day: ev.day, allDay: false, oof: showAsOf(ev) === "oof" });
  });
  return { day: firstDay, items: found };
}

function inviteClashHtml(m) {
  const clash = inviteClashes(m);
  if (!clash) return "";
  if (!clash.items.length) return `<div class="invite-note invite-clear">No conflicts</div>`;
  const first = clash.items[0];
  const tags = [first.allDay ? "all day" : "", first.oof ? "out of office" : ""].filter(Boolean).join(", ");
  const more = clash.items.length > 1 ? ` and ${clash.items.length - 1} more` : "";
  const text = `Conflicts with ${first.title}${tags ? " (" + tags + ")" : ""}${more}`;
  return `<button type="button" class="invite-note invite-clash linkish" data-clash-day="${clash.day}" title="Open the calendar on that day">${esc(text)}</button>`;
}

function inviteWhen(invite) {
  if (invite.allDay) {
    const day = new Date(String(invite.start || "").slice(0, 10) + "T12:00:00");
    return isNaN(day) ? "" : day.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) + ", all day";
  }
  const start = new Date(invite.start);
  const end = new Date(invite.end);
  if (isNaN(start)) return "";
  const time = d => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return start.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) + ", " + time(start) + (isNaN(end) ? "" : "–" + time(end));
}

// ---- Unsubscribe, from the sender's List-Unsubscribe headers ----
const unsubscribeFor = new Map();

async function ensureUnsubscribe(m) {
  if (!serverMessage(m) || unsubscribeFor.has(m.id)) return;
  const where = messageBox(m);
  if (where === "sent" || where === "drafts" || where === "outbox") return;
  if (ownAddresses().has(String(m.email || "").toLowerCase())) return;
  unsubscribeFor.set(m.id, null);
  const acct = accounts[m.account];
  try {
    const found = await tauriInvoke("unsubscribe_options", { email: acct.email, messageId: m.id });
    if (found && (found.oneClick || found.web || found.mailto)) {
      unsubscribeFor.set(m.id, found);
      if (view === "mail") renderReading();
    }
  } catch (err) {
    unsubscribeFor.delete(m.id);
  }
}

function unsubscribeBar(m) {
  if (!unsubscribeFor.get(m.id)) return "";
  return `<p class="unsub-bar"><span>Getting too much mail from ${esc(m.from)}?</span><button type="button" class="linkish" data-unsubscribe="${esc(m.id)}">Unsubscribe</button></p>`;
}

async function unsubscribeFrom(m) {
  const found = unsubscribeFor.get(m.id);
  if (!found) return;
  const how = found.oneClick
    ? "Mailroom asks " + m.from + " to take you off their list."
    : found.mailto
      ? "Mailroom sends an unsubscribe message to " + found.mailto + " from your account."
      : "The sender's unsubscribe page opens in your browser.";
  const choice = await chooseDialog("Unsubscribe", how, [{ value: "go", label: "Unsubscribe", primary: true }]);
  if (choice !== "go") return;
  const acct = accounts[m.account];
  try {
    const done = await tauriInvoke("unsubscribe", { email: acct.email, messageId: m.id });
    if (done && done.how === "open" && done.url) {
      openNoteLink(done.url);
      toast("Finish unsubscribing on the sender's page.");
    } else {
      toast("Unsubscribed from " + m.from + ".");
      unsubscribeFor.set(m.id, null);
      if (view === "mail") renderReading();
    }
  } catch (err) {
    toast(String(err && err.message || err || "That did not work. Try again later."));
  }
}

async function ensureInvite(m) {
  if (!serverMessage(m) || inviteChecked.has(m.id)) return;
  const where = messageBox(m);
  if (where === "sent" || where === "drafts" || where === "outbox") return;
  // Nothing in Junk is treated as a meeting.
  if (folderKind(where, m.account) === "junk") return;
  if (ownAddresses().has(String(m.email || "").toLowerCase())) return;
  inviteChecked.add(m.id);
  const acct = accounts[m.account];
  let invite = null;
  try {
    invite = await tauriInvoke("message_invite", { email: acct.email, messageId: m.id });
  } catch (err) {
    inviteChecked.delete(m.id);
    toast(String(err && err.message || err || "That invite could not be opened."));
    return;
  }
  if (!invite || !invite.eventId) return;
  m.liveInvite = invite;
  m.invite = true;
  m.meeting = { title: invite.subject || m.subject, when: inviteWhen(invite), where: invite.location || "" };
  if (view === "mail") renderReading();
}

// Answer a meeting on the server, then show the answer everywhere it appears.
async function answerLiveMeeting(accountId, eventId, response, title) {
  const acct = accounts[accountId];
  if (!acct || !acct.email || !eventId) return false;
  try {
    await tauriInvoke("respond_invite", { email: acct.email, eventId, response });
  } catch (err) {
    const text = String(err && err.message || err || "Microsoft did not record the answer.");
    if (text === ANSWER_AGAIN) {
      answerConsent.add(accountId);
      authProblem = ANSWER_AGAIN;
      refreshAuthBanner();
    }
    toast(text);
    return false;
  }
  messages.forEach(m => {
    if (!m.liveInvite || m.liveInvite.eventId !== eventId) return;
    m.liveInvite.response = response;
    // A Gmail invite answered for the first time is on the calendar now:
    // look it up again next time to get its calendar id.
    if (String(eventId).startsWith("ics:")) inviteChecked.delete(m.id);
  });
  [...events, ...allday].forEach(ev => {
    if (ev.live && String(ev.eventId || ev.id).split("@")[0] === eventId) applyEventResponse(ev, response);
  });
  toast(label(response) + " · " + (title || "Meeting"));
  render();
  return true;
}

function serverMessage(message) {
  return !!(message && message.live && accounts[message.account] && accounts[message.account].signedIn && inDesktop());
}

function rememberMessages(list) {
  return (list || []).map(message => ({
    id: message.id,
    account: message.account,
    box: messageBox(message),
    previousBox: message.previousBox || "",
    unread: !!message.unread,
    flagged: !!message.flagged,
    live: !!message.live
  }));
}

function shiftFolderCount(accountId, key, totalDelta, unreadDelta) {
  const acct = accounts[accountId];
  const folder = acct && acct.liveFolders && acct.liveFolders.find(item => item.key === key);
  if (!folder) return;
  folder.total = Math.max(0, (Number(folder.total) || 0) + totalDelta);
  folder.unread = Math.max(0, (Number(folder.unread) || 0) + unreadDelta);
}

function applyMailShifts(prior, kind, destKey) {
  (prior || []).filter(item => item.live && accounts[item.account] && accounts[item.account].signedIn).forEach(item => {
    if (kind === "read" && item.unread) shiftFolderCount(item.account, item.box, 0, -1);
    if (kind === "unread" && !item.unread) shiftFolderCount(item.account, item.box, 0, 1);
    if (kind === "archive" || kind === "trash" || kind === "inbox" || (kind === "move" && destKey)) {
      const dest = kind === "move" ? destKey : kind;
      if (dest === item.box) return;
      shiftFolderCount(item.account, item.box, -1, item.unread ? -1 : 0);
      shiftFolderCount(item.account, dest, 1, (dest === "inbox" || kind === "move") && item.unread ? 1 : 0);
    }
  });
}

function followMovedIds(moved) {
  (Array.isArray(moved) ? moved : []).forEach(pair => {
    const from = pair && pair.from;
    const to = pair && pair.to;
    if (!from || !to || from === to) return;
    messages.forEach(m => { if (m.id === from) m.id = to; });
    if (selected === from) selected = to;
  });
}

async function pushMailAction(targets, kind, revert, prior, destination) {
  const live = (targets || []).filter(serverMessage);
  if (!live.length) return;
  const snapshot = prior || rememberMessages(live);
  try {
    // A Gmail move takes the label of the folder the mail was in, so send
    // that folder along; Microsoft ignores it.
    const before = new Map((snapshot || []).map(item => [item.id, item.box]));
    const groups = new Map();
    live.forEach(message => {
      const acct = accounts[message.account];
      const email = String((acct && acct.email) || "");
      const fromBox = before.get(message.id) || messageBox(message);
      const folder = acct && acct.liveFolders && acct.liveFolders.find(item => item.key === fromBox);
      const source = folder ? folder.id : "";
      const key = email + "\n" + source;
      if (!groups.has(key)) groups.set(key, { email, source, messageIds: [] });
      groups.get(key).messageIds.push(message.id);
    });
    for (const { email, source, messageIds } of groups.values()) {
      const moved = await tauriInvoke("apply_mail", { kind, messageIds, email, destination: destination ? destination.id : null, source: source || null });
      followMovedIds(moved);
    }
    applyMailShifts(snapshot, kind, destination ? destination.key : "");
    if (view === "mail") render();
  } catch (err) {
    const text = String(err && err.message || err);
    // Gone from the server — moved or deleted in Outlook, on a phone, or by
    // a rule: drop it here and catch up, rather than show Graph's error
    // (2026-10-26, "New Submission" under the Unread filter).
    if (mailItemGone(text)) {
      if (live.length === 1) dropGoneMessage(live[0]);
      toast(live.length === 1 ? "That message was moved or deleted elsewhere" : "Some of those messages were moved or deleted elsewhere");
      render();
      pollMail();
      return;
    }
    if (revert) revert();
    if (mailServerBusy(text)) {
      toast("The mail server is busy · try again in a moment");
      render();
      return;
    }
    authProblem = text;
    refreshAuthBanner();
    toast("Could not update the server");
    render();
  }
}

function mailItemGone(text) {
  return /ErrorItemNotFound|\(404\b/.test(String(text || ""));
}

// Throttled or busy even after the backend's own retries: worth a toast,
// not the sign-in banner.
function mailServerBusy(text) {
  return /\((429|503)\b|ApplicationThrottled|MailboxConcurrency/.test(String(text || ""));
}

function dropGoneMessage(message) {
  const i = messages.indexOf(message);
  if (i >= 0) messages.splice(i, 1);
  if (selected === message.id) selected = null;
  // Out of the cache too, or the stale copy is back, unread, on the next
  // start (2026-10-27: an accepted invite Exchange had moved away).
  const acct = accounts[message.account];
  const email = String((acct && acct.email) || "");
  if (email && inDesktop()) {
    try {
      const pending = tauriInvoke("forget_mail", { email, messageIds: [message.id], message_ids: [message.id] });
      if (pending && pending.catch) pending.catch(() => {});
    } catch (e) {}
  }
}

function setUnread(targets, unread, announce) {
  const changed = (targets || []).filter(message => !!message.unread !== unread);
  if (!changed.length) return;
  const prior = rememberMessages(changed);
  if (!unread && mailFilter === "unread") changed.forEach(message => keptReadIds().add(message.id));
  changed.forEach(message => { message.unread = unread; });
  if (announce) toast(unread ? "Marked as unread" : "Marked as read");
  render();
  pushMailAction(changed, unread ? "unread" : "read", () => {
    prior.forEach(item => {
      const msg = messages.find(message => message.id === item.id);
      if (msg) msg.unread = item.unread;
    });
  }, prior);
}

function markUnread(id) {
  const msg = messages.find(m => m.id === id);
  if (msg) setUnread([msg], true, true);
}

function markRead(id, whole) {
  const msg = messages.find(m => m.id === id);
  if (!msg) return;
  const targets = whole
    ? messages.filter(m => m.thread === msg.thread && messageBox(m) === messageBox(msg) && m.account === msg.account)
    : [msg];
  setUnread(targets, false, true);
}

function themeChoice() {
  if (document.documentElement.dataset.look === "omarchy") return "omarchy";
  const theme = document.documentElement.dataset.theme;
  return theme === "light" || theme === "dark" ? theme : "system";
}

function syncThemeControl() {
  const theme = themeChoice();
  const names = { system: "System", light: "Light", dark: "Dark", omarchy: "Omarchy" };
  const btn = document.getElementById("theme-btn");
  const label = "Theme: " + names[theme];
  btn.title = label;
  btn.setAttribute("aria-label", label);
  document.querySelectorAll("#theme-menu [data-theme]").forEach((el) => {
    el.setAttribute("aria-checked", el.dataset.theme === theme ? "true" : "false");
  });
}

function hideThemeMenu() {
  document.getElementById("theme-menu").hidden = true;
  document.getElementById("theme-btn").setAttribute("aria-expanded", "false");
}

function showThemeMenu() {
  hideRowMenu();
  const menu = document.getElementById("theme-menu");
  const btn = document.getElementById("theme-btn");
  menu.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  const rect = btn.getBoundingClientRect();
  menu.style.top = (rect.bottom + 6) + "px";
  menu.style.left = "0px";
  const box = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(rect.right - box.width, innerWidth - box.width - 8)) + "px";
}

function setTheme(theme) {
  const next = theme === "light" || theme === "dark" || (theme === "omarchy" && omarchyLook) ? theme : "system";
  try { localStorage.setItem("mailroom-theme", next); } catch (e) {}
  if (next === "omarchy") paintOmarchyColours();
  else {
    clearOmarchyColours();
    document.documentElement.dataset.theme = next;
  }
  paintOmarchyChrome();
  syncThemeControl();
  refreshSignatures();
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if ((document.documentElement.dataset.theme || "dark") === "system") refreshSignatures();
});

// ---- Omarchy -------------------------------------------------------------
// Only on Omarchy: omarchy_look answers null everywhere else, and then none
// of this changes anything. On Omarchy the chrome takes the system monospace
// font and Hyprland's corners, the theme menu can follow the Omarchy theme's
// colours (live, as the theme changes), and Settings > Omarchy can make
// Mailroom the mail app and put the unread count in the bar.

let omarchyLook = null;
const OMARCHY_HEX = /^#[0-9a-f]{6}$/;

// Mailroom's colour tokens from an Omarchy palette. Every value is one of
// the palette's hex colours or a color-mix() of them.
function omarchyVars(look) {
  const c = (look && look.colors) || {};
  const pick = (...keys) => { for (const key of keys) if (OMARCHY_HEX.test(c[key] || "")) return c[key]; return ""; };
  const bg = pick("background");
  const fg = pick("foreground");
  if (!bg || !fg) return null;
  const light = look.mode === "light";
  const mix = (a, b, share) => `color-mix(in srgb, ${a} ${share}%, ${b})`;
  const accent = pick("accent", "blue") || fg;
  const hue = (...keys) => pick(...keys) || accent;
  const soft = (colour) => mix(colour, bg, light ? 14 : 22);
  const ink = (colour) => mix(colour, fg, light ? 62 : 58);
  const lifted = pick("lighter_background") || mix(fg, bg, 8);
  const sunk = pick("dark_background") || bg;
  const edge = pick("muted") || mix(fg, bg, 35);
  const vars = {
    "--bg": bg, "--panel": bg, "--side": bg, "--rail": sunk, "--seam": sunk,
    "--ink": fg, "--muted": mix(fg, bg, 74), "--faint": mix(fg, bg, 55),
    // Plain mail text in dark mode, white in Mailroom's own dark.
    "--mail-ink": pick("bright_foreground", "light_foreground") || fg,
    "--line": mix(edge, bg, 55), "--line-strong": edge,
    "--hover": lifted, "--selected": pick("selection") || mix(accent, bg, 25), "--row-on": pick("selection") || lifted,
    "--search": lifted, "--field": bg, "--soft": lifted, "--seg": sunk, "--seg-on": lifted,
    "--hour-line": mix(edge, bg, 35), "--day-line": mix(edge, bg, 22),
    "--blue": accent, "--blue-ink": mix(accent, fg, 82), "--work": accent, "--work-soft": soft(accent),
    "--on-accent": bg, "--search-icon": mix(fg, bg, 70), "--toast-bg": fg, "--toast-ink": bg,
    "--danger": hue("red"), "--flag": hue("red"),
    "--shadow": light ? "0 8px 24px rgba(0, 0, 0, .16)" : "0 8px 24px rgba(0, 0, 0, .45)",
    "--seam-shade": "none", "--card-shadow": "none", "--chip-shadow": "none",
    "--stripe": light ? "rgba(255, 255, 255, .55)" : "rgba(255, 255, 255, .12)"
  };
  // Account and category colours, each with its soft fill and its ink.
  const hues = {
    personal: hue("cyan", "green"), plum: hue("magenta"), amber: hue("yellow"), clay: mix(hue("red"), hue("brown", "orange"), 55),
    leaf: hue("green"), orange: hue("orange", "yellow"), pink: mix(hue("red"), hue("magenta"), 50), red: hue("red"),
    gold: hue("bright_yellow", "yellow"), navy: hue("blue"), slate: mix(fg, bg, 60), magenta: hue("bright_magenta", "magenta")
  };
  for (const [name, colour] of Object.entries(hues)) {
    vars["--" + name] = colour;
    vars["--" + name + "-soft"] = soft(colour);
    vars["--" + name + "-ink"] = ink(colour);
  }
  return vars;
}

function omarchyColourKeys() {
  let cached = {};
  try { cached = JSON.parse(localStorage.getItem("mailroom-omarchy-vars") || "{}") || {}; } catch (e) { cached = {}; }
  const sample = omarchyVars({ mode: "dark", colors: { background: "#000000", foreground: "#ffffff" } }) || {};
  return new Set([...Object.keys(sample), ...Object.keys(cached)]);
}

function clearOmarchyColours() {
  const root = document.documentElement;
  omarchyColourKeys().forEach(key => root.style.removeProperty(key));
  delete root.dataset.look;
}

// Omarchy's monospace font and window corners go with its theme. Mailroom's
// own theme has Mailroom's own font and corners, at once (2026-10-25).
function paintOmarchyChrome() {
  const root = document.documentElement;
  const look = omarchyLook;
  const font = look && /^[A-Za-z0-9 ._-]{1,80}$/.test(look.font || "") ? `"${look.font}", ui-monospace, monospace` : "";
  if (look && savedTheme() === "omarchy") {
    if (font) root.style.setProperty("--font", font);
    else root.style.removeProperty("--font");
    root.style.setProperty("--r-max", Math.max(0, Math.min(24, Math.round(Number(look.rounding) || 0))) + "px");
  } else {
    root.style.removeProperty("--font");
    root.style.removeProperty("--r-max");
  }
}

function paintOmarchyColours() {
  const vars = omarchyVars(omarchyLook);
  if (!vars) return;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
  root.dataset.theme = omarchyLook.mode === "light" ? "light" : "dark";
  root.dataset.look = "omarchy";
  try {
    localStorage.setItem("mailroom-omarchy-vars", JSON.stringify(vars));
    localStorage.setItem("mailroom-omarchy-mode", root.dataset.theme);
  } catch (e) {}
}

function savedTheme() {
  try { return localStorage.getItem("mailroom-theme") || ""; } catch (e) { return ""; }
}

// Called at start and by the backend whenever the theme, the monospace font
// or Hyprland's corners change.
function applyOmarchyLook(look) {
  if (!look || typeof look !== "object" || !omarchyVars(look)) return;
  const first = !omarchyLook;
  omarchyLook = look;
  const root = document.documentElement;
  root.dataset.omarchy = "1";
  const item = document.getElementById("theme-omarchy");
  if (item) {
    item.hidden = false;
    item.textContent = "Omarchy (" + String(look.theme || "theme").slice(0, 40) + ")";
  }
  // The first time Mailroom meets Omarchy, it follows the theme; after that
  // the theme menu decides.
  let adopted = true;
  try { adopted = localStorage.getItem("mailroom-omarchy-adopted") === "1"; } catch (e) {}
  if (!adopted && !popCompose && !assistWindow) {
    try { localStorage.setItem("mailroom-omarchy-adopted", "1"); } catch (e) {}
    if (savedTheme() !== "omarchy") {
      try { localStorage.setItem("mailroom-theme", "omarchy"); } catch (e) {}
      toast("Following your Omarchy theme · change it from the theme menu");
    }
  }
  if (savedTheme() === "omarchy") paintOmarchyColours();
  paintOmarchyChrome();
  syncThemeControl();
  if (!first) refreshSignatures();
  if (view === "settings") renderFolders();
  if (view === "settings" && settingsPage === "omarchy") renderSettings();
  reportUnread(true);
}

async function initOmarchy() {
  if (!inDesktop()) return;
  let look = null;
  try { look = await tauriInvoke("omarchy_look"); } catch (e) { look = null; }
  if (look && typeof look === "object") {
    applyOmarchyLook(look);
    return;
  }
  // Not Omarchy (any more): drop colours the page head painted from cache.
  if (document.documentElement.dataset.look === "omarchy") {
    clearOmarchyColours();
    document.documentElement.dataset.theme = "dark";
    syncThemeControl();
  }
}

// The unread count for the Omarchy bar widget.
let reportedUnread = -1;
let unreadReportTimer = 0;
function reportUnread(force) {
  if (!omarchyLook || popCompose || assistWindow) return;
  clearTimeout(unreadReportTimer);
  unreadReportTimer = setTimeout(() => {
    const count = messages.filter(m => m.live && m.unread && messageBox(m) === "inbox" && accountInProfile(m.account)).length;
    if (!force && count === reportedUnread) return;
    reportedUnread = count;
    const call = tauriInvoke("report_unread", { count });
    if (call && call.catch) call.catch(() => {});
  }, 400);
}

// A mailto: link, --compose or --check-mail that Mailroom was started with.
function openLaunchRequest(request) {
  if (!request || typeof request !== "object" || popCompose || assistWindow) return;
  if (request.kind === "check") {
    checkMailNow();
    return;
  }
  if (request.kind !== "compose") return;
  const list = (value) => (Array.isArray(value) ? value : []).filter(item => typeof item === "string").slice(0, 50).join("; ");
  const text = typeof request.body === "string" ? request.body.slice(0, 100000) : "";
  const bodyHtml = text ? text.split("\n").map(line => "<p>" + (esc(line) || "<br>") + "</p>").join("") : "<p><br></p>";
  openCompose({ fields: { to: list(request.to), cc: list(request.cc), bcc: list(request.bcc), subject: String(request.subject || "").slice(0, 1000), bodyHtml } });
}

async function takeLaunchRequest() {
  if (!inDesktop() || popCompose || assistWindow) return;
  let request = null;
  try { request = await tauriInvoke("take_launch_request"); } catch (e) { request = null; }
  if (request) openLaunchRequest(request);
}

function renderOmarchySettings(body) {
  if (!omarchyLook) {
    body.innerHTML = `<p class="field-hint">These settings are for Omarchy.</p>`;
    return;
  }
  const following = themeChoice() === "omarchy";
  const theme = esc(String(omarchyLook.theme || "Omarchy"));
  body.innerHTML = `
    <section class="omarchy-settings">
      <div class="omarchy-card">
        <h3>Theme</h3>
        <p class="field-hint">Following ${theme}, Mailroom takes its colours, Omarchy's monospace font and its window corners, and changes when the theme does. Mailroom's own keeps Mailroom's colours, font and corners. Messages keep a reading font either way.</p>
        <div class="seg" role="group" aria-label="Colours">
          <button type="button" id="omarchy-theme-follow" aria-pressed="${following}">${theme}</button>
          <button type="button" id="omarchy-theme-own" aria-pressed="${!following}">Mailroom's own</button>
        </div>
      </div>
      <div class="omarchy-card">
        <h3>Mail app</h3>
        <div class="omarchy-state" id="omarchy-mail-state">Checking…</div>
        <p class="field-hint"><kbd>Super</kbd> <kbd>Shift</kbd> <kbd>E</kbd> opens Mailroom and <kbd>Super</kbd> <kbd>Shift</kbd> <kbd>Alt</kbd> <kbd>E</kbd> starts a new message, in place of HEY. Email links open a new message here. The keys are two lines Mailroom adds to ~/.config/hypr/bindings.lua.</p>
        <div class="dialog-actions">
          <button class="primary" type="button" id="omarchy-mail-on" hidden>Make Mailroom the mail app</button>
          <button class="ghost" type="button" id="omarchy-mail-off" hidden>Stop being the mail app</button>
        </div>
      </div>
      <div class="omarchy-card">
        <h3>Bar</h3>
        <div class="omarchy-state" id="omarchy-bar-state">Checking…</div>
        <p class="field-hint">An envelope in Omarchy's bar with your unread count. Click it to open Mailroom; right-click to check for new mail.</p>
        <div class="dialog-actions">
          <button class="primary" type="button" id="omarchy-bar-on" hidden>Add to the bar</button>
          <button class="ghost" type="button" id="omarchy-bar-off" hidden>Remove from the bar</button>
        </div>
      </div>
    </section>`;
  body.querySelector("#omarchy-theme-follow").onclick = () => { setTheme("omarchy"); renderSettings(); };
  body.querySelector("#omarchy-theme-own").onclick = () => { setTheme("dark"); renderSettings(); };
  const paint = (status) => {
    if (!document.body.contains(body.querySelector("#omarchy-mail-state"))) return;
    const mail = !!(status && status.mailto && status.keys);
    const partly = !!(status && (status.mailto || status.keys)) && !mail;
    const mailState = body.querySelector("#omarchy-mail-state");
    mailState.textContent = mail ? "Mailroom is the mail app" : partly ? "Partly set up" : "Not the mail app";
    mailState.classList.toggle("on", mail);
    body.querySelector("#omarchy-mail-on").hidden = mail;
    body.querySelector("#omarchy-mail-on").textContent = partly ? "Finish setting up" : "Make Mailroom the mail app";
    body.querySelector("#omarchy-mail-off").hidden = !(mail || partly);
    const bar = !!(status && status.barWidget);
    const barState = body.querySelector("#omarchy-bar-state");
    barState.textContent = bar ? "In the bar" : "Not in the bar";
    barState.classList.toggle("on", bar);
    body.querySelector("#omarchy-bar-on").hidden = bar;
    body.querySelector("#omarchy-bar-off").hidden = !bar;
  };
  const act = (selector, command, done) => {
    const btn = body.querySelector(selector);
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const status = await tauriInvoke(command);
        paint(status);
        toast(done);
        if (command === "add_bar_widget") reportUnread(true);
      } catch (err) {
        toast(String(err && err.message || err));
      } finally {
        btn.disabled = false;
      }
    };
  };
  act("#omarchy-mail-on", "make_mail_app", "Mailroom is now the mail app");
  act("#omarchy-mail-off", "stop_mail_app", "Mailroom is no longer the mail app");
  act("#omarchy-bar-on", "add_bar_widget", "Added to the bar");
  act("#omarchy-bar-off", "remove_bar_widget", "Removed from the bar");
  Promise.resolve(tauriInvoke("mail_app_status")).then(paint).catch(() => paint(null));
}

function placeMenu(menu, x, y) {
  menu.hidden = false;
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, innerWidth - rect.width - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, innerHeight - rect.height - 8)) + "px";
}

function liveFolderId(acct, folder) {
  const found = ((accounts[acct] && accounts[acct].liveFolders) || []).find(item => item.key === folder);
  return found ? found.id : "";
}

async function markFolderRead(acct, folder) {
  const local = messages.filter(m => m.account === acct && messageBox(m) === folder && m.unread);
  if (inDesktop() && accounts[acct] && accounts[acct].signedIn && liveFolderId(acct, folder)) {
    try {
      await tauriInvoke("mark_folder_read", { email: accounts[acct].email, folderId: liveFolderId(acct, folder) });
    } catch (err) {
      return toast(String(err && err.message || err));
    }
    const live = (accounts[acct].liveFolders || []).find(item => item.key === folder);
    if (live) live.unread = 0;
  }
  local.forEach(m => { m.unread = false; });
  render();
  toast("Marked all as read · " + boxLabel(folder, acct));
}

async function emptyFolder(acct, folder) {
  const label = boxLabel(folder, acct);
  const sure = await chooseDialog("Empty " + label + "?", "Everything in " + label + " is deleted for good.", [{ value: "yes", label: "Empty", danger: true }]);
  if (sure !== "yes") return;
  if (inDesktop() && accounts[acct] && accounts[acct].signedIn && liveFolderId(acct, folder)) {
    try {
      await tauriInvoke("empty_folder", { email: accounts[acct].email, folderId: liveFolderId(acct, folder) });
    } catch (err) {
      return toast(String(err && err.message || err));
    }
    const live = (accounts[acct].liveFolders || []).find(item => item.key === folder);
    if (live) { live.unread = 0; live.total = 0; }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].account === acct && messageBox(messages[i]) === folder) messages.splice(i, 1);
  }
  selected = null;
  render();
  toast(label + " is empty");
}

function showFolderMenu(x, y, acct, folder) {
  hideThemeMenu();
  const on = isFavorite(acct, folder);
  const menu = document.getElementById("row-menu");
  if (isCategoryBox(folder) || isSearchBox(folder)) {
    const remove = isSearchBox(folder) ? `<button type="button" role="menuitem" data-act="delete-search">Delete search folder</button>` : "";
    menu.innerHTML = `<button type="button" role="menuitem" data-act="${on ? "unfav" : "fav"}">${on ? "Remove from favorites" : "Add to favorites"}</button>${remove}`;
    menu.dataset.id = acct;
    menu.dataset.kind = folder;
    menu.dataset.child = "";
    menu.dataset.menu = "folder";
    menu.setAttribute("aria-label", "Mailbox");
    placeMenu(menu, x, y);
    return;
  }
  const kind = acct === "all" ? folder : folderKind(folder, acct);
  const markable = acct !== "all" && folder !== "outbox" && folder !== "drafts";
  const emptiable = acct !== "all" && (kind === "trash" || kind === "junk");
  const counting = folder === "outbox" ? "" : folderCountMode(acct, folder) === "unread"
    ? `<button type="button" role="menuitem" data-act="count-total">Show total number of items</button>`
    : `<button type="button" role="menuitem" data-act="count-unread">Show unread messages count</button>`;
  menu.innerHTML = `<button type="button" role="menuitem" data-act="${on ? "unfav" : "fav"}">${on ? "Remove from favorites" : "Add to favorites"}</button>${counting}${markable ? `
    <button type="button" role="menuitem" data-act="readall">Mark all as read</button>` : ""}${emptiable ? `
    <div class="menu-rule"></div>
    <button type="button" role="menuitem" data-act="empty">Empty ${esc(boxLabel(folder, acct))}</button>` : ""}`;
  menu.dataset.id = acct;
  menu.dataset.kind = folder;
  menu.dataset.child = "";
  menu.dataset.menu = "folder";
  menu.setAttribute("aria-label", "Mailbox");
  placeMenu(menu, x, y);
}

function showRowMenu(x, y, id, child) {
  hideThemeMenu();
  const menu = document.getElementById("row-menu");
  const back = rowTargets(id, child).some(canMoveToInbox);
  const google = rowTargets(id, child).some(m => isGoogleAccount(m.account));
  menu.innerHTML = `
    <button type="button" role="menuitem" data-act="unread">Mark as unread</button>
    <button type="button" role="menuitem" data-act="read">Mark as read</button>
    <button type="button" role="menuitem" data-act="move">Move to…</button>
    ${google ? "" : `<button type="button" role="menuitem" data-act="categorize">Categorize…</button>`}
    <button type="button" role="menuitem" data-act="snooze">Snooze…</button>
    ${google ? "" : `<button type="button" role="menuitem" data-act="rule">Create rule…</button>`}${focusedInbox && !google && rowTargets(id, child).some(m => serverMessage(m) && messageBox(m) === "inbox") ? (() => {
      const to = rowTargets(id, child).every(m => focusOf(m) === "other") ? "focused" : "other";
      const label = to === "other" ? "Other" : "Focused";
      return `
    <div class="menu-rule"></div>
    <button type="button" role="menuitem" data-act="focus-${to}">Move to ${label}</button>
    <button type="button" role="menuitem" data-act="focus-always-${to}">Always move to ${label}</button>`;
    })() : ""}${back ? `
    <div class="menu-rule"></div>
    <button type="button" role="menuitem" data-act="to-inbox">Move to Inbox</button>` : ""}`;
  menu.dataset.id = id;
  menu.dataset.child = child ? "1" : "";
  menu.dataset.menu = "mail";
  menu.dataset.x = String(x);
  menu.dataset.y = String(y);
  menu.dataset.kind = "";
  menu.setAttribute("aria-label", "Message");
  placeMenu(menu, x, y);
}

function showEventMenu(x, y, id, kind) {
  hideThemeMenu();
  const ev = findCalendarEvent(id, kind);
  if (!ev) return;
  // A live meeting shows the server's answer, which may be none yet.
  const current = ev.live ? (ev.response || "") : (ev.response || (ev.tentative ? "tentative" : "accepted"));
  const item = (act, text) => `<button type="button" role="menuitemradio" data-act="${act}" aria-checked="${act === current ? "true" : "false"}">${text}</button>`;
  const answerable = !(ev.live && ev.isOrganizer);
  const menu = document.getElementById("row-menu");
  menu.innerHTML = `${answerable ? `
    ${item("accepted", "Accept")}
    ${item("declined", "Decline")}
    ${item("tentative", "Maybe")}
    <div class="menu-rule"></div>` : ""}
    <button type="button" role="menuitem" data-act="reply">Reply</button>
    <button type="button" role="menuitem" data-act="reply-all">Reply all</button>
    <button type="button" role="menuitem" data-act="forward">Forward</button>
    <button type="button" role="menuitem" data-act="delete">Delete</button>`;
  menu.dataset.id = id;
  menu.dataset.kind = kind || "timed";
  menu.dataset.child = "";
  menu.dataset.menu = "event";
  menu.setAttribute("aria-label", ev.title);
  placeMenu(menu, x, y);
}

function hideRowMenu() {
  const menu = document.getElementById("row-menu");
  if (menu) menu.hidden = true;
}

document.getElementById("row-menu").onclick = (ev) => {
  const btn = ev.target.closest("button");
  const menu = document.getElementById("row-menu");
  const id = menu.dataset.id;
  const child = menu.dataset.child === "1";
  const menuKind = menu.dataset.menu;
  const eventKind = menu.dataset.kind;
  hideRowMenu();
  if (!btn) return;
  if (menuKind === "category") {
    if (btn.dataset.cat) toggleCategory(btn.dataset.cat);
    return;
  }
  if (menuKind === "files") {
    const msg = messages.find(m => m.id === (btn.dataset.fileMsg || btn.dataset.filesAll));
    if (!msg) return;
    if (btn.dataset.filesAll) startDownloadAll(msg);
    else openAttachment(msg, { id: btn.dataset.fileId || "", name: btn.dataset.fileName || "", unknown: btn.dataset.fileUnknown === "1" });
    return;
  }
  if (menuKind === "folder") {
    if (btn.dataset.act === "readall") markFolderRead(id, eventKind);
    else if (btn.dataset.act === "count-total") setFolderCountMode(id, eventKind, "total");
    else if (btn.dataset.act === "count-unread") setFolderCountMode(id, eventKind, "unread");
    else if (btn.dataset.act === "empty") emptyFolder(id, eventKind);
    else if (btn.dataset.act === "unfav") removeFavorite(id, eventKind);
    else if (btn.dataset.act === "delete-search") deleteSearchFolder(id, eventKind);
    else if (btn.dataset.act === "fav") addFavorite(id, eventKind);
    return;
  }
  if (menuKind === "event") {
    const meeting = findCalendarEvent(id, eventKind);
    const act = btn.dataset.act;
    if (act === "delete") deleteCalendarEvent(id, eventKind);
    else if (act === "reply" && meeting) openMeetingMail(meeting, eventKind, "reply");
    else if (act === "reply-all" && meeting) openMeetingMail(meeting, eventKind, "all");
    else if (act === "forward" && meeting) forwardEvent(meeting, eventKind);
    else if (meeting && meeting.live && (act === "accepted" || act === "tentative" || act === "declined")) {
      answerLiveMeeting(meeting.account, String(meeting.eventId || meeting.id).split("@")[0], act, meeting.title);
    }
    else if (meeting && (act === "accepted" || act === "tentative" || act === "declined")) {
      applyEventResponse(meeting, act);
      const word = { accepted: "Accepted", tentative: "Maybe", declined: "Declined" }[act];
      toast(word + " · " + meeting.title);
      render();
    }
    return;
  }
  const focusAct = /^focus-(always-)?(focused|other)$/.exec(btn.dataset.act || "");
  if (focusAct) { moveFocus(rowTargets(id, child), focusAct[2], !!focusAct[1]); return; }
  if (btn.dataset.act === "to-inbox") moveToInbox(rowTargets(id, child));
  else if (btn.dataset.act === "move") showMoveDialog(rowTargets(id, child));
  else if (btn.dataset.act === "snooze") snoozeMessages(rowTargets(id, child));
  else if (btn.dataset.act === "rule") createRuleFrom(id);
  else if (btn.dataset.act === "categorize") showCategoryMenu(Number(menu.dataset.x) || 200, Number(menu.dataset.y) || 200, rowTargets(id, child));
  else if (btn.dataset.act === "unread") markUnread(id);
  else markRead(id, !child);
};
document.getElementById("theme-btn").onclick = (ev) => {
  ev.stopPropagation();
  if (document.getElementById("theme-menu").hidden) showThemeMenu();
  else hideThemeMenu();
};
document.getElementById("theme-menu").onclick = (ev) => {
  ev.stopPropagation();
  const choice = ev.target.closest("[data-theme]");
  if (!choice) return;
  setTheme(choice.dataset.theme);
  hideThemeMenu();
};
syncThemeControl();
document.addEventListener("click", (ev) => {
  if (!ev.target.closest("#row-menu")) hideRowMenu();
  if (!ev.target.closest("#party-card")) hidePartyCard();
  if (!ev.target.closest("#theme-menu") && !ev.target.closest("#theme-btn")) hideThemeMenu();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    hideRowMenu();
    hidePartyCard();
    hideThemeMenu();
    const found = document.getElementById("q-suggest");
    if (found) { found.hidden = true; found.innerHTML = ""; }
    if (document.body.dataset.assist === "open" && !document.getElementById("discard-confirm") && !document.querySelector(".dialog, .event-editor")) closeAssist();
  }
});
document.addEventListener("scroll", () => { hideRowMenu(); hidePartyCard(); hideThemeMenu(); }, true);

function label(key) {
  return { accepted: "Accept", tentative: "Tentative", declined: "Decline" }[key];
}

// The working day the scheduling view shows, in minutes.
const WORK_FROM = 8 * 60;
const WORK_TO = 18 * 60;

// Start times (minutes, on the half hour) when every view is free — free
// (0) or working elsewhere (4) — for `length` minutes, from `earliest`.
// views: getSchedule's availabilityView strings, 15 minutes a digit.
function suggestSlots(views, from, to, length, earliest, count) {
  const out = [];
  const freeAt = (m) => views.every(v => { const c = v[Math.floor(m / 15)]; return c === undefined || c === "0" || c === "4"; });
  let m = Math.max(from, Math.ceil((earliest || 0) / 30) * 30);
  for (; m + length <= to && out.length < count; m += 30) {
    let ok = true;
    for (let t = m; t < m + length; t += 15) if (!freeAt(t)) { ok = false; break; }
    if (ok) out.push(m);
  }
  return out;
}

function fmt(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dowLong = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dowShort = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const mockToday = new Date(2026, 9, 15);

function todayDate() {
  return inDesktop() ? new Date() : mockToday;
}

function isToday(date) {
  const today = todayDate();
  return date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
}

function dateFromDay(day) {
  const d = new Date(2026, 9, 12);
  d.setDate(d.getDate() + Number(day));
  return d;
}

function dayFromDate(date) {
  const anchor = new Date(2026, 9, 12);
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((d.getTime() - anchor.getTime()) / 86400000);
}

function formatDayLong(day) {
  const d = dateFromDay(day);
  return dowLong[d.getDay()] + " " + d.getDate() + " " + monthNames[d.getMonth()];
}

function isoFromDay(day) {
  const d = dateFromDay(day);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function dayFromIso(iso) {
  const match = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return dayFromDate(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

function visibleDates() {
  if (calView === "month") {
    const first = new Date(calFocus.getFullYear(), calFocus.getMonth(), 1);
    const last = new Date(calFocus.getFullYear(), calFocus.getMonth() + 1, 0);
    const cursor = startOfWeek(first);
    const dates = [];
    while (dates.length < 42) {
      dates.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
      if (dates.length % 7 === 0 && cursor > last) break;
    }
    return dates;
  }
  const start = startOfWeek(calFocus);
  const count = calView === "week" ? 7 : 5;
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

function rangeTitle(dates) {
  if (calView === "month") return monthNames[calFocus.getMonth()] + " " + calFocus.getFullYear();
  const a = dates[0];
  const b = dates[dates.length - 1];
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) {
    return a.getDate() + "–" + b.getDate() + " " + monthNames[a.getMonth()] + " " + a.getFullYear();
  }
  if (a.getFullYear() === b.getFullYear()) {
    return a.getDate() + " " + monthNames[a.getMonth()] + " – " + b.getDate() + " " + monthNames[b.getMonth()] + " " + a.getFullYear();
  }
  return a.getDate() + " " + monthNames[a.getMonth()] + " " + a.getFullYear() + " – " + b.getDate() + " " + monthNames[b.getMonth()] + " " + b.getFullYear();
}

function shiftCalendar(dir) {
  const d = new Date(calFocus.getFullYear(), calFocus.getMonth(), calFocus.getDate());
  if (calView === "month") d.setMonth(d.getMonth() + dir);
  else d.setDate(d.getDate() + 7 * dir);
  calFocus = d;
  render();
  refreshLiveCalendar();
}

function eventsOn(day) {
  const timed = events.filter(e => e.day === day && !e.hidden && calendarShown(e) && e.start != null);
  const whole = allday.filter(e => e.day === day && !e.hidden && calendarShown(e));
  return { timed, whole };
}

// ---- Drag on the week grid: create, move and resize ----
const SNAP = 15;
let calDragged = false;

function minuteAt(col, clientY) {
  const rect = col.getBoundingClientRect();
  const raw = ((clientY - rect.top) / rect.height) * 24 * 60;
  return Math.max(0, Math.min(24 * 60, Math.round(raw / SNAP) * SNAP));
}

function columnAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el && el.closest ? el.closest('.daycol[data-slot="time"]') : null;
}

function paintGhost(col, start, end, face, text) {
  let ghost = document.getElementById("cal-ghost");
  if (!ghost) {
    ghost = document.createElement("div");
    ghost.id = "cal-ghost";
  }
  ghost.className = "event cal-ghost " + (face || "");
  ghost.style.top = (start / 1440 * 100) + "%";
  ghost.style.height = (Math.max(SNAP, end - start) / 1440 * 100) + "%";
  ghost.textContent = (text ? text + " · " : "") + fmt(start) + "–" + fmt(end);
  if (ghost.parentElement !== col) col.appendChild(ghost);
}

function clearGhost() {
  const ghost = document.getElementById("cal-ghost");
  if (ghost) ghost.remove();
}

function endDrag() {
  clearGhost();
  document.body.classList.remove("is-cal-drag");
  // The click that follows a drag must not open anything.
  setTimeout(() => { calDragged = false; }, 0);
}

function bindCalendarDrag(root) {
  // Drag on empty space to create.
  root.querySelectorAll('.daycol[data-slot="time"]').forEach(col => {
    col.addEventListener("pointerdown", (down) => {
      if (down.button !== 0 || down.target.closest("[data-event]")) return;
      const from = minuteAt(col, down.clientY);
      let to = from, moved = false;
      const move = (ev) => {
        if (!moved && Math.abs(ev.clientY - down.clientY) < 6) return;
        moved = calDragged = true;
        document.body.classList.add("is-cal-drag");
        to = minuteAt(col, ev.clientY);
        const [a, b] = to >= from ? [from, Math.max(to, from + SNAP)] : [to, from];
        paintGhost(col, a, b, "", "New event");
      };
      const up = () => {
        col.removeEventListener("pointermove", move);
        col.removeEventListener("pointerup", up);
        if (!moved) return;
        const [a, b] = to >= from ? [from, Math.max(to, from + SNAP)] : [to, from];
        endDrag();
        openEventForm({ day: Number(col.dataset.day), start: a, end: Math.min(b, 24 * 60) });
      };
      col.setPointerCapture(down.pointerId);
      col.addEventListener("pointermove", move);
      col.addEventListener("pointerup", up);
    });
  });
  // Drag an event to move it; drag its bottom edge to change its length.
  root.querySelectorAll('.event[data-event][data-kind="timed"]').forEach(btn => {
    btn.addEventListener("pointerdown", (down) => {
      if (down.button !== 0 || down.target.closest("a")) return;
      const ev = findCalendarEvent(btn.dataset.event, "timed");
      if (!ev) return;
      // A read-only event can't move. Mark the drag, so the click that ends
      // it on empty space doesn't start a new event either.
      if (calendarReadOnly(ev.calendar)) {
        let dragged = false;
        const move = (pm) => {
          if (Math.abs(pm.clientY - down.clientY) < 6 && Math.abs(pm.clientX - down.clientX) < 6) return;
          dragged = calDragged = true;
        };
        const up = () => {
          btn.removeEventListener("pointermove", move);
          btn.removeEventListener("pointerup", up);
          if (!dragged) return;
          endDrag();
          toast("This calendar is read-only.");
        };
        btn.setPointerCapture(down.pointerId);
        btn.addEventListener("pointermove", move);
        btn.addEventListener("pointerup", up);
        return;
      }
      const resizing = !!down.target.closest("[data-resize]");
      const col = btn.closest(".daycol");
      const grab = minuteAt(col, down.clientY) - ev.start;
      const length = ev.end - ev.start;
      let target = null, moved = false;
      const move = (pm) => {
        if (!moved && Math.abs(pm.clientY - down.clientY) < 6 && Math.abs(pm.clientX - down.clientX) < 6) return;
        moved = calDragged = true;
        document.body.classList.add("is-cal-drag");
        btn.classList.add("dragging");
        if (resizing) {
          const end = Math.max(ev.start + SNAP, minuteAt(col, pm.clientY));
          target = { day: ev.day, start: ev.start, end: Math.min(end, 24 * 60) };
          paintGhost(col, target.start, target.end, eventFace(ev), ev.title);
          return;
        }
        const over = columnAt(pm.clientX, pm.clientY) || col;
        let start = minuteAt(over, pm.clientY) - grab;
        start = Math.max(0, Math.min(24 * 60 - length, Math.round(start / SNAP) * SNAP));
        target = { day: Number(over.dataset.day), start, end: start + length };
        paintGhost(over, target.start, target.end, eventFace(ev), ev.title);
      };
      const up = () => {
        btn.removeEventListener("pointermove", move);
        btn.removeEventListener("pointerup", up);
        btn.classList.remove("dragging");
        if (!moved) return;
        endDrag();
        if (target && (target.day !== ev.day || target.start !== ev.start || target.end !== ev.end)) moveCalendarEvent(ev, target);
      };
      btn.setPointerCapture(down.pointerId);
      btn.addEventListener("pointermove", move);
      btn.addEventListener("pointerup", up);
    });
  });
}

// Give an event a new day and time, on the server for a server calendar.
async function moveCalendarEvent(ev, target) {
  if (calendarReadOnly(ev.calendar)) {
    render();
    return toast("This calendar is read-only.");
  }
  if (String(ev.id).includes("@")) return toast("An event over several days is moved in its editor.");
  const live = ev.live && serverCalendar(ev.calendar);
  if (live && ev.organizer && !ev.isOrganizer && !youOrganize(ev) && (ev.attendees || []).length) {
    render();
    return toast("Only the organiser can move this meeting.");
  }
  const before = { day: ev.day, start: ev.start, end: ev.end };
  Object.assign(ev, target);
  render();
  if (!live) return toast("Moved · " + ev.title);
  const acct = accounts[ev.account];
  const iso = isoFromDay(target.day);
  try {
    await tauriInvoke("save_event", {
      email: acct.email,
      eventId: String(ev.eventId || ev.id).split("@")[0],
      calendarId: null,
      fields: {
        subject: ev.title,
        location: ev.where || "",
        start: localStamp(iso, target.start),
        end: target.end >= 24 * 60 ? nextDayIso(iso) + "T00:00:00" : localStamp(iso, target.end),
        timeZone: calendarZone(),
        allDay: false,
        showAs: showAsOf(ev)
      }
    });
  } catch (err) {
    Object.assign(ev, before);
    render();
    return toast(String(err && err.message || err || "The event could not be moved."));
  }
  toast("Moved · " + ev.title);
  await syncCalendars(ev.account, true);
  if (view === "calendar") render();
}

function bindCalendarClicks(root) {
  bindNoteLinks(root);
  root.querySelectorAll("[data-event]").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const link = ev.target.closest("a.note-link");
      if (link) {
        ev.preventDefault();
        openNoteLink(link.getAttribute("href"));
        return;
      }
      if (ev.detail > 1 || calDragged) return;
      openEventEditor(btn.dataset.event, btn.dataset.kind);
    });
    btn.addEventListener("keydown", (ev) => {
      const link = ev.target.closest("a.note-link");
      if (!link || (ev.key !== "Enter" && ev.key !== " ")) return;
      ev.preventDefault();
      ev.stopPropagation();
      openNoteLink(link.getAttribute("href"));
    });
    btn.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showEventMenu(ev.clientX, ev.clientY, btn.dataset.event, btn.dataset.kind);
    });
  });
  bindCalendarDrag(root);
  root.querySelectorAll("[data-slot]").forEach(cell => {
    cell.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-event]") || calDragged) return;
      const day = Number(cell.dataset.day);
      if (cell.dataset.slot === "all") {
        openEventForm({ day, allDay: true });
        return;
      }
      if (cell.dataset.slot === "month") {
        openEventForm({ day, start: 9 * 60, end: 10 * 60 });
        return;
      }
      const rect = cell.getBoundingClientRect();
      let minutes = ((ev.clientY - rect.top) / rect.height) * (24 * 60);
      minutes = Math.round(minutes / 30) * 30;
      minutes = Math.max(0, Math.min(23 * 60, minutes));
      openEventForm({ day, start: minutes, end: minutes + 60 });
    });
  });
}

function renderCalendar() {
  const kept = shownHour();
  if (kept != null) calTopHour = kept;
  const dates = visibleDates();
  const title = document.getElementById("cal-title");
  if (title) title.textContent = rangeTitle(dates);
  const step = calView === "month" ? "month" : "week";
  const prev = document.getElementById("cal-prev");
  const next = document.getElementById("cal-next");
  if (prev) {
    prev.title = "Previous " + step;
    prev.setAttribute("aria-label", "Previous " + step);
  }
  if (next) {
    next.title = "Next " + step;
    next.setAttribute("aria-label", "Next " + step);
  }
  document.querySelectorAll("[data-cal-view]").forEach(btn => {
    btn.setAttribute("aria-pressed", btn.dataset.calView === calView ? "true" : "false");
  });
  const cal = document.getElementById("cal");
  document.querySelector(".calendar").style.setProperty("--cal-days", String(calView === "week" ? 7 : 5));
  if (calView === "month") {
    const heads = dowShort.slice(1).concat(dowShort[0]).map(name => `<div class="month-dow">${name}</div>`).join("");
    const cells = dates.map(date => {
      const day = dayFromDate(date);
      const outside = date.getMonth() !== calFocus.getMonth();
      const today = isToday(date);
      const on = eventsOn(day);
      const chips = on.whole.map(e =>
        `<button class="chip ${eventFace(e)}" type="button" data-event="${e.id}" data-kind="all">${esc(showAsTag(e) + e.title)}</button>`
      ).concat(on.timed.slice().sort((a, b) => a.start - b.start).map(e =>
        `<button class="chip ${eventFace(e)}" type="button" data-event="${e.id}" data-kind="timed">${esc(fmt(e.start) + " " + showAsTag(e) + e.title)}</button>`
      )).join("");
      return `<div class="month-day${outside ? " outside" : ""}${today ? " today" : ""}" data-slot="month" data-day="${day}"><span class="num">${date.getDate()}</span>${chips}</div>`;
    }).join("");
    document.querySelector(".calendar").style.setProperty("--month-weeks", String(dates.length / 7));
    cal.innerHTML = `<div class="month">${heads}${cells}</div>`;
    bindCalendarClicks(cal);
    return;
  }
  const start = 0;
  const span = 24 * 60;
  const heads = dates.map(date => {
    const today = isToday(date);
    return `<div class="dayhead${today ? " today" : ""}"><span class="dow">${dowShort[date.getDay()]}</span><span class="num">${date.getDate()}</span></div>`;
  }).join("");
  const allCells = dates.map(date => {
    const day = dayFromDate(date);
    const chips = eventsOn(day).whole.map(e =>
      `<button class="chip ${eventFace(e)}" type="button" data-event="${e.id}" data-kind="all">${esc(showAsTag(e) + e.title)}</button>`
    ).join("");
    return `<div class="allday-cell" data-slot="all" data-day="${day}">${chips}</div>`;
  }).join("");
  const times = Array.from({ length: 24 }, (_, i) => `<div class="gutter">${i}:00</div>`).join("");
  const dayCols = dates.map(date => {
    const day = dayFromDate(date);
    const today = isToday(date);
    const laid = layout(eventsOn(day).timed.filter(e => e.end > start && e.start < start + span));
    const blocks = laid.map(e => {
      const top = ((Math.max(e.start, start) - start) / span) * 100;
      const minutes = Math.min(e.end, start + span) - Math.max(e.start, start);
      const height = (Math.max(minutes, 15) / span) * 100;
      const width = 100 / e.cols;
      const left = e.col * width;
      const short = e.end - e.start < 40;
      const guests = !short && attendeeSummary(e.attendees);
      const show = showAsOf(e);
      const mark = show === "busy" ? "" : `<span class="event-show">${show === "oof" ? "OOO" : "Free"}</span>`;
      const when = short ? "" : `<span class="event-time">${esc(fmt(e.start) + "–" + fmt(e.end))}</span>`;
      const place = !short && e.where ? `<span class="event-where">${esc(e.where)}</span>` : "";
      const notes = short ? "" : meetingNotes(e.notes);
      const body = notes ? `<span class="event-body">${noteHtml(notes)}</span>` : "";
      return `<button class="event ${eventFace(e)}${short ? " compact" : ""}" type="button" data-event="${e.id}" data-kind="timed"
        style="top:${top}%;height:${height}%;left:calc(${left}% + 2px);width:calc(${width}% - 4px)">
        <strong>${esc(e.title)}</strong>${when}${place}${body}${mark}${guests ? `<span class="event-people">${esc(guests)}</span>` : ""}<span class="event-resize" data-resize aria-hidden="true"></span>
      </button>`;
    }).join("");
    const lines = Array.from({ length: 24 }, (_, i) => `<div class="hour-line" style="top:${(i / 24) * 100}%"></div>`).join("");
    const now = today ? `<div class="now" style="top:${(clockMinutes() - start) / span * 100}%"></div>` : "";
    return `<div class="daycol" data-slot="time" data-day="${day}">${lines}${now}${blocks}</div>`;
  }).join("");
  cal.innerHTML = `
    <div class="cal-sticky">
      <div class="week"><div class="dayhead"></div>${heads}</div>
      <div class="allday"><div class="gutter" style="height:auto"></div>${allCells}</div>
    </div>
    <div class="week timegrid"><div class="times">${times}</div>${dayCols}</div>
  `;
  bindCalendarClicks(cal);
  applyHourScale();
}

let calTopHour = null;
let calendarPinHour = null;

function clockMinutes() {
  if (!inDesktop()) return 11 * 60 + 20;
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function defaultCalendarHour() {
  return Math.floor(clockMinutes() / 60);
}

function calendarPad(pinHour, hourPx, available) {
  return Math.max(0, pinHour * hourPx + available - 24 * hourPx);
}

function shownHour() {
  const scroll = document.getElementById("cal");
  if (!scroll || !scroll.querySelector(".timegrid")) return null;
  const hour = parseFloat(getComputedStyle(document.querySelector(".calendar")).getPropertyValue("--hour"));
  if (!hour) return null;
  return scroll.scrollTop / hour;
}

function applyHourScale() {
  if (view !== "calendar" || calView === "month") return;
  const scroll = document.getElementById("cal");
  const sticky = scroll.querySelector(".cal-sticky");
  if (!sticky) return;
  const available = scroll.clientHeight - sticky.offsetHeight;
  if (available <= 0) return;
  const hour = Math.max(36, available / 12);
  document.querySelector(".calendar").style.setProperty("--hour", hour + "px");
  if (calTopHour == null) calTopHour = defaultCalendarHour();
  if (calendarPinHour == null) calendarPinHour = calTopHour;
  const pin = Math.max(calTopHour, calendarPinHour);
  const pad = calendarPad(pin, hour, available);
  let spacer = scroll.querySelector(".cal-pad");
  if (pad > 0) {
    if (!spacer) {
      spacer = document.createElement("div");
      spacer.className = "cal-pad";
      scroll.appendChild(spacer);
    }
    spacer.style.height = pad + "px";
  } else if (spacer) spacer.remove();
  const maxTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
  scroll.scrollTop = Math.min(calTopHour * hour, maxTop);
}

function layout(items) {
  const sorted = items.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const cols = [];
  sorted.forEach(e => {
    let c = cols.findIndex(end => end <= e.start);
    if (c < 0) { c = cols.length; cols.push(e.end); }
    else cols[c] = e.end;
    e.col = c;
  });
  sorted.forEach(e => { e.cols = Math.max(1, cols.length); });
  return sorted;
}

function findCalendarEvent(id, kind) {
  const source = kind === "all" ? allday : events;
  return source.find(e => e.id === id);
}

function eventWhen(ev, kind) {
  const date = formatDayLong(ev.day);
  if (kind === "all" || ev.start == null) return date + ", all day";
  return date + ", " + fmt(ev.start) + "–" + fmt(ev.end);
}

function applyEventResponse(ev, response) {
  ev.response = response;
  ev.tentative = response === "tentative";
  ev.hidden = response === "declined";
  if (ev.id === "pipeline") rsvp = response;
}

function deleteCalendarEvent(id, kind) {
  const live = findCalendarEvent(id, kind);
  if (live && live.live && serverCalendar(live.calendar)) {
    deleteLiveEvent(live);
    return;
  }
  const source = kind === "all" ? allday : events;
  const index = source.findIndex(e => e.id === id);
  if (index < 0) return;
  const title = source[index].title;
  if (source[index].live) dismissedLive.add(String(source[index].id).split("@")[0]);
  source.splice(index, 1);
  toast("Deleted · " + title);
  render();
}

function meetingRecipients(ev, all) {
  const own = ownAddresses();
  const seen = new Set();
  const out = [];
  function add(email, name) {
    const trimmed = String(email || "").trim();
    const key = trimmed.toLowerCase();
    if (!key || own.has(key) || seen.has(key)) return;
    seen.add(key);
    out.push({ email: trimmed, name: name || recipientLabel(trimmed) });
  }
  const organizer = ev && ev.organizer;
  const yours = organizer && own.has(String(organizer.email || "").toLowerCase());
  if (!all) {
    if (organizer && !yours) add(organizer.email, organizer.name);
    return out;
  }
  if (organizer) add(organizer.email, organizer.name);
  ((ev && ev.attendees) || []).forEach(person => add(person.email, person.name));
  return out;
}

// ---- Calendar on the server ----

function serverCalendar(calId) {
  const owner = accountForCalendar(calId);
  const acct = owner && accounts[owner[0]];
  return !!(inDesktop() && acct && acct.signedIn && acct.email && calId && !/^cal-/.test(String(calId)));
}

function inRecurringSeries(ev) {
  return !!(ev && ev.live && ev.seriesMasterId && (ev.kind === "occurrence" || ev.kind === "exception"));
}

// A small choice dialog that sits above the event editor. Resolves to the
// chosen value, or null when dismissed.
function chooseDialog(title, note, choices) {
  return new Promise(resolve => {
    const layer = document.createElement("div");
    layer.id = "choose-layer";
    layer.innerHTML = `
      <div class="backdrop dim" data-choose-dismiss></div>
      <div class="dialog choose-dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h2>${esc(title)}</h2>
        ${note ? `<p class="dialog-note">${esc(note)}</p>` : ""}
        <div class="choose-list">${choices.map(c => `<button type="button" class="${c.danger ? "primary danger" : c.primary ? "primary" : "ghost"}" data-choose="${esc(c.value)}">${esc(c.label)}</button>`).join("")}</div>
        <div class="dialog-actions"><button class="ghost" type="button" data-choose-dismiss>Cancel</button></div>
      </div>`;
    document.body.appendChild(layer);
    const done = (value) => {
      document.removeEventListener("keydown", onKey, true);
      layer.remove();
      resolve(value);
    };
    function onKey(ev) {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      done(null);
    }
    document.addEventListener("keydown", onKey, true);
    layer.addEventListener("click", ev => {
      const pick = ev.target.closest("[data-choose]");
      if (pick) return done(pick.dataset.choose);
      if (ev.target.closest("[data-choose-dismiss]")) done(null);
    });
    const first = layer.querySelector("[data-choose]");
    if (first) first.focus();
  });
}

function utcStamp(date) {
  return date.toISOString().replace(/\.\d+Z$/, "Z");
}

function at(dayOffset, hour, base) {
  const d = new Date(base || Date.now());
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function nextWeekday(target, hour) {
  const now = new Date();
  const ahead = (target - now.getDay() + 7) % 7 || 7;
  return at(ahead, hour);
}

function sendLaterPresets() {
  return [
    { label: "Tomorrow morning", when: at(1, 8) },
    { label: "Monday morning", when: nextWeekday(1, 8) }
  ];
}

function snoozePresets() {
  const later = new Date(Date.now() + 3 * 3600 * 1000);
  later.setMinutes(0, 0, 0);
  const presets = [
    { label: "Tomorrow", when: at(1, 8) },
    { label: "This weekend", when: nextWeekday(6, 9) },
    { label: "Next week", when: nextWeekday(1, 8) }
  ];
  if (later.getDate() === new Date().getDate() && later.getHours() <= 20) presets.unshift({ label: "Later today", when: later });
  return presets;
}

// Presets plus a date and time of your own. Resolves to a Date, or null.
function pickTime(title, note, presets, verb) {
  return new Promise(resolve => {
    const fmtWhen = d => d.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const local = d => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 16); };
    const layer = document.createElement("div");
    layer.id = "choose-layer";
    layer.innerHTML = `
      <div class="backdrop dim" data-choose-dismiss></div>
      <div class="dialog choose-dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h2>${esc(title)}</h2>
        ${note ? `<p class="dialog-note">${esc(note)}</p>` : ""}
        <div class="choose-list">${presets.map((p, i) => `<button type="button" class="ghost time-preset" data-preset="${i}"><span>${esc(p.label)}</span><small>${esc(fmtWhen(p.when))}</small></button>`).join("")}</div>
        <label class="field">Or choose<input type="datetime-local" id="pick-when" value="${local(presets[0] ? presets[0].when : new Date(Date.now() + 3600000))}"></label>
        <p class="form-error" id="pick-error" hidden></p>
        <div class="dialog-actions"><button class="ghost" type="button" data-choose-dismiss>Cancel</button><button class="primary" type="button" id="pick-ok">${esc(verb || "OK")}</button></div>
      </div>`;
    document.body.appendChild(layer);
    const done = value => { document.removeEventListener("keydown", onKey, true); layer.remove(); resolve(value); };
    function onKey(ev) { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); done(null); } }
    document.addEventListener("keydown", onKey, true);
    layer.addEventListener("click", ev => {
      const preset = ev.target.closest("[data-preset]");
      if (preset) return done(presets[Number(preset.dataset.preset)].when);
      if (ev.target.closest("[data-choose-dismiss]")) return done(null);
      if (ev.target.closest("#pick-ok")) {
        const value = new Date(layer.querySelector("#pick-when").value);
        if (isNaN(value) || value.getTime() < Date.now() + 60000) {
          const note = layer.querySelector("#pick-error");
          note.hidden = false;
          note.textContent = "Choose a time in the future.";
          return;
        }
        done(value);
      }
    });
  });
}

function chooseSeriesScope(action, title) {
  return chooseDialog(action + " a repeating event", title || "", [
    { value: "this", label: "This event", primary: true },
    { value: "following", label: "This and all following events" },
    { value: "all", label: "All events in the series" }
  ]);
}

function liveDayIso(ev) {
  return isoFromDay(ev.day);
}

async function deleteLiveEvent(ev) {
  const acct = accounts[ev.account];
  if (!acct || !acct.email) return;
  let scope = "this";
  if (inRecurringSeries(ev)) {
    scope = await chooseSeriesScope("Delete", ev.title);
    if (!scope) return;
  }
  const attendees = (ev.attendees || []).length > 0;
  const theirs = !!(ev.organizer && !ev.isOrganizer && !youOrganize(ev));
  const how = theirs ? "decline" : (ev.isOrganizer && attendees ? "cancel" : "delete");
  if (how !== "delete") {
    const sure = await chooseDialog(
      how === "cancel" ? "Cancel this meeting?" : "Decline and remove?",
      how === "cancel" ? "Everyone invited will be told it is cancelled." : "The organiser will be told you declined.",
      [{ value: "yes", label: how === "cancel" ? "Cancel meeting" : "Decline", danger: true }]
    );
    if (sure !== "yes") return;
  }
  const instance = String(ev.eventId || ev.id).split("@")[0];
  try {
    if (scope === "this") {
      await tauriInvoke("remove_event", { email: acct.email, eventId: instance, how });
    } else if (scope === "all") {
      await tauriInvoke("remove_event", { email: acct.email, eventId: ev.seriesMasterId, how });
    } else {
      const ended = await tauriInvoke("end_series_before", { email: acct.email, masterId: ev.seriesMasterId, date: liveDayIso(ev) });
      if (!ended) await tauriInvoke("remove_event", { email: acct.email, eventId: ev.seriesMasterId, how });
    }
  } catch (err) {
    toast(String(err && err.message || err || "The event could not be removed."));
    return;
  }
  toast(how === "cancel" ? "Meeting cancelled · " + ev.title : how === "decline" ? "Declined · " + ev.title : "Deleted · " + ev.title);
  await syncCalendars(ev.account, true);
  if (view === "calendar") render();
}

// ---- Repeat ----
const WEEKDAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const NTH_KEYS = ["first", "second", "third", "fourth", "last"];

function dateParts(iso) {
  const [y, m, d] = String(iso || "").split("-").map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const nth = d + 7 > daysInMonth ? 4 : Math.floor((d - 1) / 7);
  return { y, m, d, weekday: date.getDay(), nth, isLast: d + 7 > daysInMonth };
}

function repeatLabels(iso) {
  const p = dateParts(iso);
  const month = new Date(p.y, p.m - 1, 1).toLocaleDateString("en-GB", { month: "long" });
  return {
    none: "Does not repeat",
    daily: "Every day",
    weekly: "Every week on " + WEEKDAY_NAMES[p.weekday],
    monthly: "Every month on day " + p.d,
    yearly: "Every year on " + p.d + " " + month,
    custom: "Custom…"
  };
}

function repeatMarkup(iso) {
  const labels = repeatLabels(iso);
  const p = dateParts(iso);
  const days = WEEKDAY_NAMES.map((name, i) => `<button type="button" class="repeat-day" data-repeat-day="${WEEKDAY_KEYS[i]}" aria-pressed="${i === p.weekday}" title="${name}">${name.slice(0, 1)}</button>`).join("");
  return `<div class="event-row repeat-row" id="repeat-row" hidden>
        <span class="event-ico" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 6.2A5 5 0 0 1 12.4 4.6M13 9.8A5 5 0 0 1 3.6 11.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M12.6 2.4v2.4h-2.4M3.4 13.6v-2.4h2.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <div class="event-row-body">
          <select name="repeat" id="repeat" aria-label="Repeat">
            ${Object.entries(labels).map(([key, text]) => `<option value="${key}">${esc(text)}</option>`).join("")}
          </select>
          <div class="repeat-custom" id="repeat-custom" hidden>
            <label class="repeat-every">Every <input name="repeatEvery" type="number" min="1" max="99" value="1" aria-label="Repeat every">
              <select name="repeatUnit" aria-label="Unit"><option value="day">day</option><option value="week">week</option><option value="month">month</option><option value="year">year</option></select>
            </label>
            <div class="repeat-days" id="repeat-days" hidden>${days}</div>
            <div class="repeat-month" id="repeat-month" hidden>
              <label><input type="radio" name="repeatMonthly" value="day" checked> On day <span id="repeat-dom">${p.d}</span></label>
              <label><input type="radio" name="repeatMonthly" value="nth"> On the <span id="repeat-nth"></span></label>
            </div>
            <div class="repeat-end">
              <label><input type="radio" name="repeatEnd" value="never" checked> Never ends</label>
              <label><input type="radio" name="repeatEnd" value="date"> Ends on <input name="repeatUntil" type="date" aria-label="Ends on"></label>
              <label><input type="radio" name="repeatEnd" value="count"> Ends after <input name="repeatCount" type="number" min="1" max="999" value="10" aria-label="Number of times"> times</label>
            </div>
          </div>
        </div>
      </div>`;
}

function nthText(iso) {
  const p = dateParts(iso);
  const which = p.isLast && p.nth === 4 ? "last" : NTH_KEYS[Math.min(p.nth, 3)];
  return which + " " + WEEKDAY_NAMES[p.weekday];
}

// The repeat in the form, as a Graph recurrence, or null.
function recurrenceFromForm(form, iso) {
  const choice = form.querySelector("[name=repeat]").value;
  if (choice === "none") return null;
  const p = dateParts(iso);
  const range = { type: "noEnd", startDate: iso };
  if (choice !== "custom") {
    const pattern = {
      daily: { type: "daily", interval: 1 },
      weekly: { type: "weekly", interval: 1, daysOfWeek: [WEEKDAY_KEYS[p.weekday]] },
      monthly: { type: "absoluteMonthly", interval: 1, dayOfMonth: p.d },
      yearly: { type: "absoluteYearly", interval: 1, dayOfMonth: p.d, month: p.m }
    }[choice];
    return { pattern, range };
  }
  const every = Math.max(1, Math.min(99, parseInt(form.querySelector("[name=repeatEvery]").value, 10) || 1));
  const unit = form.querySelector("[name=repeatUnit]").value;
  let pattern;
  if (unit === "day") pattern = { type: "daily", interval: every };
  else if (unit === "week") {
    const days = [...form.querySelectorAll("[data-repeat-day][aria-pressed=true]")].map(b => b.dataset.repeatDay);
    pattern = { type: "weekly", interval: every, daysOfWeek: days.length ? days : [WEEKDAY_KEYS[p.weekday]] };
  } else if (unit === "month") {
    const nth = form.querySelector("[name=repeatMonthly]:checked").value === "nth";
    pattern = nth
      ? { type: "relativeMonthly", interval: every, daysOfWeek: [WEEKDAY_KEYS[p.weekday]], index: p.isLast && p.nth === 4 ? "last" : NTH_KEYS[Math.min(p.nth, 3)] }
      : { type: "absoluteMonthly", interval: every, dayOfMonth: p.d };
  } else pattern = { type: "absoluteYearly", interval: every, dayOfMonth: p.d, month: p.m };
  const end = form.querySelector("[name=repeatEnd]:checked").value;
  if (end === "date") {
    const until = form.querySelector("[name=repeatUntil]").value;
    if (until) Object.assign(range, { type: "endDate", endDate: until });
  } else if (end === "count") {
    const count = Math.max(1, Math.min(999, parseInt(form.querySelector("[name=repeatCount]").value, 10) || 1));
    Object.assign(range, { type: "numbered", numberOfOccurrences: count });
  }
  return { pattern, range };
}

// Show an existing series' repeat in the form.
function recurrenceToForm(form, rec, iso) {
  const select = form.querySelector("[name=repeat]");
  if (!rec || !rec.pattern) { select.value = "none"; return; }
  const pt = rec.pattern, rg = rec.range || {};
  const p = dateParts(iso);
  const plain = (pt.interval || 1) === 1 && (rg.type || "noEnd") === "noEnd";
  const one = (pt.daysOfWeek || []).length === 1 && pt.daysOfWeek[0] === WEEKDAY_KEYS[p.weekday];
  if (plain && pt.type === "daily") select.value = "daily";
  else if (plain && pt.type === "weekly" && one) select.value = "weekly";
  else if (plain && pt.type === "absoluteMonthly" && pt.dayOfMonth === p.d) select.value = "monthly";
  else if (plain && pt.type === "absoluteYearly" && pt.dayOfMonth === p.d && pt.month === p.m) select.value = "yearly";
  else {
    select.value = "custom";
    form.querySelector("[name=repeatEvery]").value = pt.interval || 1;
    const unit = { daily: "day", weekly: "week", absoluteMonthly: "month", relativeMonthly: "month", absoluteYearly: "year", relativeYearly: "year" }[pt.type] || "week";
    form.querySelector("[name=repeatUnit]").value = unit;
    form.querySelectorAll("[data-repeat-day]").forEach(b => b.setAttribute("aria-pressed", (pt.daysOfWeek || []).includes(b.dataset.repeatDay) ? "true" : "false"));
    if (pt.type === "relativeMonthly") form.querySelector('[name=repeatMonthly][value="nth"]').checked = true;
    if (rg.type === "endDate") {
      form.querySelector('[name=repeatEnd][value="date"]').checked = true;
      form.querySelector("[name=repeatUntil]").value = rg.endDate || "";
    } else if (rg.type === "numbered") {
      form.querySelector('[name=repeatEnd][value="count"]').checked = true;
      form.querySelector("[name=repeatCount]").value = rg.numberOfOccurrences || 1;
    }
  }
}

function bindRepeat(form, dateInput) {
  const select = form.querySelector("[name=repeat]");
  const custom = document.getElementById("repeat-custom");
  const unit = form.querySelector("[name=repeatUnit]");
  const days = document.getElementById("repeat-days");
  const month = document.getElementById("repeat-month");
  const paint = () => {
    const iso = dateInput.value;
    const labels = repeatLabels(iso);
    [...select.options].forEach(opt => { opt.textContent = labels[opt.value]; });
    document.getElementById("repeat-dom").textContent = dateParts(iso).d;
    document.getElementById("repeat-nth").textContent = nthText(iso);
    custom.hidden = select.value !== "custom";
    days.hidden = unit.value !== "week";
    month.hidden = unit.value !== "month";
  };
  select.onchange = paint;
  unit.onchange = paint;
  dateInput.addEventListener("change", paint);
  form.querySelectorAll("[data-repeat-day]").forEach(btn => {
    btn.onclick = () => btn.setAttribute("aria-pressed", btn.getAttribute("aria-pressed") === "true" ? "false" : "true");
  });
  paint();
}

// British Columbia, Alberta and Manitoba keep the names Exchange learned in
// November 2026. Other computers send the name the system already uses.
function calendarZone() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (zone === "America/Vancouver") return "Pacific Time (British Columbia)";
  if (zone === "America/Edmonton") return "Mountain Time (Alberta)";
  if (zone === "America/Winnipeg") return "Manitoba";
  return zone;
}

// Local wall-clock times for Graph, in this computer's time zone.
function localStamp(iso, minutes) {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return iso + "T" + h + ":" + m + ":00";
}

function nextDayIso(iso) {
  const p = dateParts(iso);
  const next = new Date(p.y, p.m - 1, p.d + 1);
  return next.getFullYear() + "-" + String(next.getMonth() + 1).padStart(2, "0") + "-" + String(next.getDate()).padStart(2, "0");
}

// A UTC stamp from Graph as a local day and minutes.
function localFromUtc(stamp, allDay) {
  if (!stamp) return null;
  if (allDay) return { iso: String(stamp).slice(0, 10), minutes: 0 };
  const when = new Date(String(stamp).replace(/\.\d+$/, "") + "Z");
  if (isNaN(when)) return null;
  const iso = when.getFullYear() + "-" + String(when.getMonth() + 1).padStart(2, "0") + "-" + String(when.getDate()).padStart(2, "0");
  return { iso, minutes: when.getHours() * 60 + when.getMinutes() };
}

async function saveLiveEvent(job) {
  const { form, seed, owner, calId, title, dayNum, whole, begin, finish, people, reply, invite, fail } = job;
  const acct = accounts[owner];
  const iso = isoFromDay(dayNum);
  const zone = calendarZone();
  const data = new FormData(form);
  const fields = {
    subject: title,
    location: String(data.get("where") || "").trim(),
    start: whole ? iso : localStamp(iso, begin),
    end: whole ? nextDayIso(iso) : localStamp(iso, finish),
    timeZone: zone,
    allDay: whole,
    showAs: showAsOf({ showAs: data.get("showas") })
  };
  const notes = String(data.get("notes") || "").trim();
  const editing = !!seed.id;
  if (!editing || notes !== String(seed.notes || "").trim()) fields.notes = notes;
  const emails = list => list.map(p => String(p.email).toLowerCase()).sort().join(",");
  if (!editing ? people.length : emails(people) !== emails(seed.attendees || [])) {
    fields.attendees = people.map(p => ({ email: p.email, name: p.name }));
  }
  const repeatRow = document.getElementById("repeat-row");
  const repeating = repeatRow && !repeatRow.hidden ? recurrenceFromForm(form, iso) : undefined;
  const reminderPick = Number(form.querySelector("[name=reminder]").value);
  if (!editing || reminderPick !== seed.reminder) fields.reminder = reminderPick;
  const teamsBox = form.querySelector("[name=teams]");
  if (teamsBox && !document.getElementById("teams-row").hidden && teamsBox.checked) fields.teams = true;
  const save = form.querySelector('button[type="submit"]');
  if (save) save.disabled = true;
  const call = (eventId, calendarId, extra) => tauriInvoke("save_event", {
    email: acct.email,
    eventId: eventId || null,
    calendarId: calendarId || null,
    fields: Object.assign({}, fields, extra || {})
  });
  try {
    if (!editing) {
      await call(null, calId, repeating ? { recurrence: repeating } : {});
    } else if (seed.scope === "all") {
      await call(seed.seriesMasterId, null, { recurrence: repeating === undefined ? null : repeating });
    } else if (seed.scope === "following") {
      const ended = await tauriInvoke("end_series_before", { email: acct.email, masterId: seed.seriesMasterId, date: isoFromDay(seed.day) });
      if (ended) {
        // The rest of the series becomes a new series from this date.
        const all = Object.assign({}, fields, { notes, attendees: people.map(p => ({ email: p.email, name: p.name })) });
        await tauriInvoke("save_event", { email: acct.email, eventId: null, calendarId: calId, fields: Object.assign(all, repeating ? { recurrence: repeating } : {}) });
      } else {
        await call(seed.seriesMasterId, null, { recurrence: repeating === undefined ? null : repeating });
      }
    } else {
      const id = String(seed.eventId || seed.id).split("@")[0];
      const extra = !seed.seriesMasterId && repeating !== undefined && repeating ? { recurrence: repeating } : {};
      await call(id, null, extra);
    }
    if (invite && reply && reply !== (seed.response || "")) {
      await answerLiveMeeting(owner, String(seed.eventId || seed.id).split("@")[0], reply, title);
    }
  } catch (err) {
    if (save) save.disabled = false;
    fail(String(err && err.message || err || "The event could not be saved."));
    return;
  }
  closePop();
  const shown = dateFromDay(dayNum);
  calFocus = calView === "month" ? new Date(shown.getFullYear(), shown.getMonth(), 1) : shown;
  setView("calendar");
  toast(editing ? "Event updated" : "Event added");
  await syncCalendars(owner, true);
  if (view === "calendar") render();
}

function youOrganize(ev) {
  if (!ev || !ev.organizer || !ev.organizer.email) return true;
  return ownAddresses().has(String(ev.organizer.email).toLowerCase());
}

function openMeetingMail(ev, kind, mode) {
  const people = mode === "forward" ? [] : meetingRecipients(ev, mode === "all");
  const to = people.map(person => person.email).join("; ");
  const lines = ["<strong>" + esc(ev.title) + "</strong>", esc(eventWhen(ev, kind))];
  if (ev.where) lines.push(esc(ev.where));
  if (ev.organizer && ev.organizer.name && !youOrganize(ev)) lines.push("Organizer: " + esc(ev.organizer.name));
  const fromId = calendarAccountVisible(ev.account) ? ev.account : defaultAccountId();
  const bodyHtml = "<p><br></p><p>" + lines.join("<br>") + "</p>";
  const prefix = mode === "forward" ? "FW: " : "RE: ";
  const titles = { forward: "Forward", all: "Reply all", reply: "Reply" };
  const draft = { to, from: fromId, subject: prefix + ev.title, bodyHtml };
  popRoot.innerHTML = `<div class="backdrop" id="backdrop"></div>` + composeMarkup({
    mode: "dialog",
    title: titles[mode] || "Reply",
    fromId,
    to,
    subject: draft.subject,
    bodyHtml,
    kind: "new"
  });
  bindCompose(popRoot, { mode: "dialog", kind: "new", draft });
  document.getElementById("backdrop").onclick = closePop;
}

function forwardEvent(ev, kind) {
  openMeetingMail(ev, kind, "forward");
}

function attendeeStatusLabel(status) {
  return { accepted: "Accepted", tentative: "Tentative", declined: "Declined" }[status] || "No response";
}

function attendeeSummary(list) {
  if (!list || !list.length) return "";
  const order = ["accepted", "tentative", "declined", "none"];
  const word = { accepted: "accepted", tentative: "tentative", declined: "declined", none: "no response" };
  const counts = {};
  list.forEach(person => {
    const key = order.includes(person.status) ? person.status : "none";
    counts[key] = (counts[key] || 0) + 1;
  });
  return order.filter(key => counts[key]).map(key => counts[key] + " " + word[key]).join(", ");
}

function mergeAttendees(previous, next) {
  const prior = new Map((previous || []).map(person => [String(person.email || "").toLowerCase(), person.status]));
  return next.map(person => {
    const email = String(person.email || "").trim();
    const status = prior.get(email.toLowerCase());
    return {
      email,
      name: person.name || recipientLabel(email),
      status: ["accepted", "tentative", "declined", "none"].includes(status) ? status : (person.status || "none")
    };
  });
}

async function openEventEditor(id, kind) {
  const ev = findCalendarEvent(id, kind);
  if (!ev) return;
  const options = {};
  if (inRecurringSeries(ev)) {
    const scope = await chooseSeriesScope("Open", ev.title);
    if (!scope) return;
    options.scope = scope;
    if (scope !== "this") {
      try {
        options.series = await tauriInvoke("event_series", { email: accounts[ev.account].email, masterId: ev.seriesMasterId });
      } catch (err) {
        toast(String(err && err.message || err || "The series could not be read."));
        return;
      }
    }
  }
  openEventForm({
    id: ev.id,
    calendar: ev.calendar,
    title: ev.title,
    where: ev.where || "",
    notes: ev.notes || "",
    day: ev.day,
    start: ev.start,
    end: ev.end,
    allDay: kind === "all" || ev.start == null,
    showAs: ev.showAs,
    response: ev.response || "",
    tentative: !!ev.tentative,
    hidden: !!ev.hidden,
    organizer: ev.organizer || null,
    live: !!ev.live,
    account: ev.account,
    eventId: ev.eventId || "",
    kind: ev.kind || "",
    seriesMasterId: ev.seriesMasterId || "",
    isOrganizer: !!ev.isOrganizer,
    reminder: Number.isInteger(ev.reminder) ? ev.reminder : -1,
    joinUrl: ev.joinUrl || "",
    scope: options && options.scope,
    series: options && options.series,
    attendees: (ev.attendees || []).map(person => ({ email: person.email, name: person.name, status: person.status || "none" }))
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function decodeBasicEntities(text) {
  return String(text || "")
    .replace(/&#(\d+);/g, (all, n) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    })
    .replace(/&#x([0-9a-f]+);/gi, (all, n) => {
      const code = parseInt(n, 16);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function safeNoteUrl(raw) {
  const text = decodeBasicEntities(raw).trim();
  if (!text || text.length > 2000) return "";
  if (/[\u0000-\u001f\u007f\s<>"'`\\]/.test(text)) return "";
  const lower = text.toLowerCase();
  if (lower.startsWith("https://") || lower.startsWith("http://")) {
    try {
      const url = new URL(text);
      if (url.protocol !== "http:" && url.protocol !== "https:") return "";
      if (!url.hostname || url.username || url.password) return "";
      return url.href;
    } catch (e) {
      return "";
    }
  }
  if (lower.startsWith("mailto:")) {
    const addr = text.slice(7).split("?")[0];
    if (!addr || !addr.includes("@") || addr.startsWith("@") || addr.endsWith("@")) return "";
    return text;
  }
  return "";
}

function trimUrlTail(url) {
  let end = url.length;
  while (end > 0 && ".,;:!?".includes(url[end - 1])) end -= 1;
  while (end > 0 && url[end - 1] === ")") {
    const head = url.slice(0, end);
    const open = (head.match(/\(/g) || []).length;
    const close = (head.match(/\)/g) || []).length;
    if (close <= open) break;
    end -= 1;
  }
  return url.slice(0, end);
}

function linkTag(href, label) {
  return `<a class="note-link" href="${esc(href)}">${esc(label)}</a>`;
}

function linkifyText(text) {
  const src = String(text || "");
  const re = /(?:https?:\/\/|mailto:)[^\s<>"']+/gi;
  let out = "";
  let last = 0;
  let match;
  while ((match = re.exec(src))) {
    const raw = match[0];
    const trimmed = trimUrlTail(raw);
    const href = safeNoteUrl(trimmed);
    out += esc(src.slice(last, match.index));
    if (href) {
      out += linkTag(href, trimmed);
      out += esc(raw.slice(trimmed.length));
    } else {
      out += esc(raw);
    }
    last = match.index + raw.length;
  }
  out += esc(src.slice(last));
  return out;
}

function stripTags(text) {
  return String(text || "").replace(/<\/?[a-zA-Z][^>]*>/g, "");
}

// Teams and Outlook fence the join details with lines of underscores. Each
// becomes one thin rule, with the blank lines around it dropped, and notes
// that are nothing but such lines are no notes.
const NOTE_RULE = /(^|\n)[ \t]*_{10,}[ \t]*(?=\r?\n|$)/g;

function meetingNotes(text) {
  const src = String(text || "").trim();
  return src.replace(NOTE_RULE, "$1").trim() ? src : "";
}

function noteHtml(text) {
  const src = String(text || "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n").replace(NOTE_RULE, "$1\u0000");
  let out = "";
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const lower = rest.toLowerCase();
    if (lower.startsWith("<a") && (rest.length === 2 || /[\s>/]/.test(rest[2]))) {
      const end = rest.indexOf(">");
      const close = lower.indexOf("</a>");
      if (end !== -1 && close !== -1 && close > end) {
        const tag = rest.slice(0, end + 1);
        const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
        const inner = rest.slice(end + 1, close);
        if (hrefMatch) {
          const href = safeNoteUrl(hrefMatch[1] != null ? hrefMatch[1] : hrefMatch[2]);
          if (href) {
            const label = stripTags(inner).replace(/\s+/g, " ").trim() || href;
            out += linkTag(href, label);
          } else {
            out += linkifyText(stripTags(inner));
          }
          i += close + 4;
          continue;
        }
      }
    }
    const next = lower.indexOf("<a", 1);
    const chunkEnd = next === -1 ? src.length : i + next;
    out += linkifyText(src.slice(i, chunkEnd));
    if (next === -1) break;
    i = chunkEnd;
  }
  return out.replace(/\s*\u0000\s*/g, '<span class="note-rule"></span>');
}

function noteHasLink(text) {
  return noteHtml(text).indexOf('class="note-link"') !== -1;
}

function openNoteLink(href) {
  const safe = safeNoteUrl(href);
  if (!safe) return;
  if (inDesktop()) {
    const pending = tauriInvoke("open_link", { url: safe });
    if (pending && pending.catch) pending.catch(() => {});
    return;
  }
  window.open(safe, "_blank", "noopener,noreferrer");
}

// A link inside a message must never move this window. Open it in the
// browser instead, through the same check as calendar note links.
document.addEventListener("click", (ev) => {
  if (ev.defaultPrevented) return;
  const path = ev.composedPath ? ev.composedPath() : [ev.target];
  const link = path.find(node => node && node.localName === "a" && node.hasAttribute && node.hasAttribute("href"));
  if (!link) return;
  const inMail = path.some(node => node && node.classList && (node.classList.contains("letter") || node.classList.contains("history-body") || node.classList.contains("body-sig")));
  if (!inMail) return;
  ev.preventDefault();
  if (path.some(node => node && node.id === "compose-body")) return;
  const href = String(link.getAttribute("href") || "").trim();
  if (!href || href.startsWith("#")) return;
  openNoteLink(href);
}, true);

function bindNoteLinks(root) {
  if (!root) return;
  root.querySelectorAll("a.note-link").forEach(link => {
    if (link.dataset.noteBound) return;
    link.dataset.noteBound = "1";
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openNoteLink(link.getAttribute("href"));
    });
    link.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      ev.stopPropagation();
      openNoteLink(link.getAttribute("href"));
    });
  });
}

// Mail HTML comes from strangers. It is parsed in an inert document, then
// only safe markup is kept: no scripts or embedded frames, no event handler
// attributes, and no links or sources outside a short list of schemes.
const MAIL_DROP_TAGS = new Set("script iframe frame frameset object embed applet noscript noembed noframes template meta base link svg math input textarea select option video audio source track portal title plaintext xmp listing".split(" "));
const MAIL_UNWRAP_TAGS = new Set(["form", "button"]);
const MAIL_URL_ATTRS = new Set(["href", "src", "background", "poster", "action", "formaction", "cite", "longdesc", "lowsrc", "dynsrc", "data", "codebase", "xlink:href"]);
const MAIL_DROP_ATTRS = new Set(["id", "name", "form", "srcdoc", "ping", "formaction", "action", "http-equiv", "is", "autofocus", "contenteditable", "tabindex"]);
const MAIL_APP_ATTRS = new Set(["data-mail-style", "data-dark-ink", "data-mark-bg"]);
const MAIL_MEDIA_ATTRS = new Set(["src", "background", "poster", "lowsrc", "dynsrc"]);
// Outlook marks where quoted history begins with one of these ids.
const QUOTE_MARKER_IDS = /^(x_)?(divRplyFwdMsg|appendonsend|mail-editor-reference-message-container|OLK_SRC_BODY_SECTION)$/i;

function safeMailUrl(value, media) {
  const raw = String(value || "").trim();
  if (!raw) return true;
  // Browsers skip tabs, newlines and other controls inside a scheme.
  const squashed = raw.replace(/[\u0000- \u007f-\u009f]/g, "").toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(squashed);
  if (!scheme) return !squashed.startsWith("//") || media;
  const name = scheme[1];
  if (name === "http" || name === "https") return true;
  if (media) {
    if (name === "cid") return true;
    return name === "data" && /^data:image\/(png|gif|jpe?g|webp|bmp)[;,]/.test(squashed);
  }
  return name === "mailto" || name === "tel";
}

function safeMailStyle(value) {
  return !/expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:/i.test(String(value || ""));
}

function cleanMailNode(node, keepStyle) {
  [...node.children].forEach(child => {
    const tag = child.localName;
    if (MAIL_DROP_TAGS.has(tag) || (tag === "style" && !keepStyle)) {
      child.remove();
      return;
    }
    cleanMailNode(child, keepStyle);
    if (tag === "style") return;
    [...child.attributes].forEach(attr => {
      const name = attr.name.toLowerCase();
      if (name === "id" && QUOTE_MARKER_IDS.test(attr.value)) child.setAttribute("data-quote-start", "");
      // Markers the reading pane writes for itself. From a sender they would
      // be trusted as the app's own (data-mail-style once restored a style
      // that never went through the remote-picture block).
      if (name.startsWith("on") || MAIL_DROP_ATTRS.has(name) || MAIL_APP_ATTRS.has(name)) {
        child.removeAttribute(attr.name);
        return;
      }
      if (MAIL_URL_ATTRS.has(name) && !safeMailUrl(attr.value, MAIL_MEDIA_ATTRS.has(name))) {
        child.removeAttribute(attr.name);
        return;
      }
      if (name === "srcset" && !attr.value.split(",").every(part => safeMailUrl(part.trim().split(/\s+/)[0], true))) {
        child.removeAttribute(attr.name);
        return;
      }
      if (name === "style" && !safeMailStyle(attr.value)) {
        child.removeAttribute(attr.name);
        return;
      }
      // Mail stays inside its letter: nothing pinned over the rest of the app.
      if (name === "style" && /position\s*:\s*(fixed|sticky)/i.test(attr.value)) {
        child.style.removeProperty("position");
        if (/position\s*:\s*(fixed|sticky)/i.test(child.getAttribute("style") || "")) child.removeAttribute("style");
      }
    });
    if (MAIL_UNWRAP_TAGS.has(tag)) child.replaceWith(...child.childNodes);
  });
}

function sanitizeMailHtml(html, keepStyle) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  if (!doc.body) return "";
  cleanMailNode(doc.body, keepStyle);
  if (!keepStyle) return doc.body.innerHTML;
  // A style block before the body lands in <head>. Keep it with the body.
  const styles = [...doc.head.querySelectorAll("style")]
    .filter(node => safeMailStyle(node.textContent))
    .map(node => "<style>" + node.textContent.replace(/</g, "\\3c ") + "</style>")
    .join("");
  return styles + doc.body.innerHTML;
}

function htmlFor(s) {
  return sanitizeMailHtml(s, false);
}

const shownRemote = new Set();
const MULTI_SUFFIXES = new Set("co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk sch.uk com.au net.au org.au edu.au gov.au asn.au id.au co.nz org.nz net.nz ac.nz govt.nz co.za org.za web.za net.za gov.za com.br com.mx co.jp ne.jp or.jp ac.jp go.jp com.sg com.hk com.tw co.in firm.in net.in org.in com.cn net.cn org.cn gov.cn com.tr co.kr com.ar com.pl com.pt com.es co.il org.il net.il ac.il com.ua co.id web.id my.id or.id go.id ac.id com.my com.ph com.vn co.th com.pk com.ng com.eg com.sa".split(" "));
let safeSenders = loadSafeSenders();
// Mail providers anyone can sign up to. An account there makes only its own
// address safe, never the whole domain, or every sender there would load
// tracking pictures.
const PUBLIC_MAIL = /^(gmail|googlemail|outlook|hotmail|live|msn|passport|windowslive|yahoo|ymail|rocketmail|aol|aim|icloud|me|mac|gmx|yandex|ya|mail|inbox|zoho|zohomail|proton|protonmail|pm|tutanota|tuta|tutamail|fastmail|hey|duck|qq|163|126|yeah|sina|naver|daum|hanmail|rediffmail|web|t-online|freenet|orange|wanadoo|free|laposte|sfr|libero|virgilio|tiscali|alice|seznam|wp|o2|onet|interia|btinternet|sky|virginmedia|talktalk|ntlworld|comcast|verizon|att|sbcglobal|bellsouth|cox|charter|earthlink|juno|optonline|rogers|sympatico|shaw|telus|bell|videotron|cogeco|bigpond|optusnet|xtra)\.[a-z]{2,}(\.[a-z]{2})?$/;

function isPublicMailDomain(domain) {
  return PUBLIC_MAIL.test(String(domain || ""));
}

// The domains of the accounts you have signed in. Always safe, and not
// removable: they come from the accounts, not the saved list.
function accountSafeSenders() {
  const keys = new Set();
  ownAddresses().forEach(address => {
    const domain = organisationalDomain(address);
    if (domain && !isPublicMailDomain(domain)) keys.add("@" + domain);
  });
  return [...keys].sort();
}

function publicAccountDomains() {
  const found = new Set();
  ownAddresses().forEach(address => {
    const domain = organisationalDomain(address);
    if (domain && isPublicMailDomain(domain)) found.add(domain);
  });
  return [...found].sort();
}

// Countries that register names under com., edu., gov. and the like:
// school.edu.sg is the domain, not edu.sg, whether or not it is listed above.
const REGISTRY_LABELS = new Set("ac co com edu gov govt gob gouv go mil net nic or org sch ltd plc".split(" "));

function registrySuffix(labels) {
  return /^[a-z]{2}$/.test(labels[labels.length - 1]) && REGISTRY_LABELS.has(labels[labels.length - 2]);
}

function organisationalDomain(value) {
  const text = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  const at = text.lastIndexOf("@");
  const host = (at >= 0 ? text.slice(at + 1) : text).replace(/^@/, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return "";
  if (labels.some(label => !/^[a-z0-9-]+$/.test(label) || label.startsWith("-") || label.endsWith("-"))) return "";
  const take = MULTI_SUFFIXES.has(labels.slice(-2).join(".")) || registrySuffix(labels) ? 3 : 2;
  // A bare public suffix (edu.sg) is never a sender's own domain.
  if (labels.length < take) return "";
  const domain = labels.slice(-take).join(".");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : "";
}

function safeSenderKey(value) {
  const domain = organisationalDomain(value);
  return domain ? "@" + domain : "";
}

function loadSafeSenders() {
  try {
    const raw = localStorage.getItem("mailroom-safe-senders") || "[]";
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const next = [...new Set(parsed.map(safeSenderKey).filter(Boolean))].sort();
    if (JSON.stringify(next) !== raw) {
      try { localStorage.setItem("mailroom-safe-senders", JSON.stringify(next)); } catch (e) {}
    }
    return next;
  } catch (e) {
    return [];
  }
}

function rememberSafeSenders() {
  try {
    localStorage.setItem("mailroom-safe-senders", JSON.stringify(safeSenders));
  } catch (e) { /* the list stays in memory for this session */ }
}

function senderIsSafe(email) {
  const key = String(email || "").trim().toLowerCase();
  if (!key || !key.includes("@")) return false;
  if (ownAddresses().has(key)) return true;
  const domain = organisationalDomain(key);
  return !!domain && (safeSenders.includes("@" + domain) || accountSafeSenders().includes("@" + domain));
}

function safeSenderListed(key) {
  return !!key && (safeSenders.includes(key) || accountSafeSenders().includes(key));
}

function addSafeSender(value) {
  const key = safeSenderKey(value);
  if (!key || safeSenderListed(key)) return false;
  safeSenders.push(key);
  safeSenders.sort();
  rememberSafeSenders();
  return true;
}

function removeSafeSender(value) {
  const key = String(value || "").trim().toLowerCase();
  if (accountSafeSenders().includes(key)) return;
  safeSenders = safeSenders.filter(item => item !== key);
  rememberSafeSenders();
}

function remotePictureMode() {
  try {
    const mode = localStorage.getItem("mailroom-remote-pictures");
    if (mode === "never" || mode === "always" || mode === "safe") return mode;
  } catch (e) {}
  return "safe";
}

function setRemotePictureMode(mode) {
  if (mode !== "never" && mode !== "always" && mode !== "safe") return;
  try { localStorage.setItem("mailroom-remote-pictures", mode); } catch (e) {}
  render();
}

function allowRemoteFor(message) {
  if (!message) return false;
  if (shownRemote.has(message.id)) return true;
  // Mail you sent: its pictures are your own signature and attachments.
  if (messageBox(message) === "sent" || ownAddresses().has(String(message.email || "").toLowerCase())) return true;
  const mode = remotePictureMode();
  if (mode === "always") return true;
  if (mode === "never") return false;
  return senderIsSafe(message.email);
}

function isRemoteUrl(value) {
  // Read it as the browser does: CSS escapes resolved, and tabs, newlines
  // and other controls dropped. Then only known local schemes are local.
  const url = String(value || "")
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (all, hex) => { try { return String.fromCodePoint(parseInt(hex, 16)); } catch (e) { return ""; } })
    .replace(/\\(.)/g, "$1")
    .replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
  if (!url || url.startsWith("#")) return false;
  return !/^(data|cid|blob|mailto):/i.test(url);
}

// The browser's own reading of a style: escapes resolved, and
// image-set("…") written as image-set(url("…")), so one check covers them.
function normalisedStyle(style) {
  const probe = document.implementation.createHTMLDocument("").createElement("div");
  probe.setAttribute("style", String(style || ""));
  return probe.style.cssText;
}

// Custom properties are substituted when the style is computed, so a URL
// in one never shows here as url(…). With pictures blocked, drop them.
const CSS_VARIABLE = /var\(|(^|[;\s])--/i;

function stripRemoteStyle(style) {
  let blocked = false;
  let changed = false;
  let text = normalisedStyle(style);
  if (CSS_VARIABLE.test(text)) {
    const probe = document.implementation.createHTMLDocument("").createElement("div");
    probe.setAttribute("style", text);
    [...probe.style].forEach(name => {
      const value = probe.style.getPropertyValue(name);
      if (!name.startsWith("--") && !/var\(/i.test(value)) return;
      // A custom property can hold an escaped url(…) that only the
      // substitution reveals: count every one as a blocked picture.
      if (name.startsWith("--")) blocked = true;
      probe.style.removeProperty(name);
    });
    text = probe.style.cssText;
    // A shorthand built from var() can survive as pending values: drop it all.
    if (CSS_VARIABLE.test(text)) text = "";
    changed = true;
  }
  const next = text.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (all, quote, url) => {
    if (!isRemoteUrl(url)) return all;
    blocked = true;
    return "none";
  });
  return { style: next, blocked, changed: changed || blocked };
}

function remoteMailHtml(html, allow) {
  const clean = htmlFor(html);
  if (allow) return { html: clean, blocked: false };
  const doc = new DOMParser().parseFromString(clean, "text/html");
  let blocked = false;
  doc.body.querySelectorAll("*").forEach(el => {
    ["src", "poster", "background"].forEach(name => {
      if (!isRemoteUrl(el.getAttribute(name))) return;
      el.removeAttribute(name);
      if (name === "src" && el.tagName === "IMG") el.classList.add("blocked-picture");
      blocked = true;
    });
    if (el.tagName === "OBJECT" && isRemoteUrl(el.getAttribute("data"))) {
      el.removeAttribute("data");
      blocked = true;
    }
    if (el.tagName === "LINK" && isRemoteUrl(el.getAttribute("href"))) {
      el.removeAttribute("href");
      blocked = true;
    }
    const srcset = el.getAttribute("srcset");
    if (srcset && srcset.split(",").some(part => isRemoteUrl(part.trim().split(/\s+/)[0]))) {
      el.removeAttribute("srcset");
      if (el.tagName === "IMG") el.classList.add("blocked-picture");
      blocked = true;
    }
    if (el.hasAttribute("style")) {
      const stripped = stripRemoteStyle(el.getAttribute("style"));
      if (stripped.changed) el.setAttribute("style", stripped.style);
      if (stripped.blocked) blocked = true;
    }
  });
  return { html: doc.body.innerHTML, blocked };
}

function mailStyleText(html) {
  const parts = [];
  String(html || "").replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
    parts.push(css);
    return "";
  });
  return parts.join("\n").replace(/<!--/g, "").replace(/-->/g, "");
}

// ---- Quoted history: shown behind a "…" button, as Outlook does ----
const openQuotes = new Set();
// Mail classes carry the m- prefix by the time quotes are looked for.
const QUOTE_SELECTORS = '[data-quote-start], .m-gmail_quote, blockquote[type="cite"], .m-yahoo_quoted, .m-moz-cite-prefix, .m-protonmail_quote';
const QUOTE_FROM = /^(From|Von|De|Da|Van|Från|Fra|Od)\s*:/i;
const QUOTE_SENT = /\b(Sent|Date|Gesendet|Datum|Envoyé|Enviado|Inviato|Verzonden|Skickat|Sendt|Wysłano)\s*:/i;
const QUOTE_SUBJECT = /\b(Subject|Betreff|Objet|Asunto|Oggetto|Onderwerp|Ämne|Emne|Temat)\s*:/i;
const BLOCK_TAGS = new Set(["P", "DIV", "TD", "LI", "BLOCKQUOTE", "SECTION", "TABLE", "TR", "TBODY"]);

// Text with a space where each <br> was, so "Jon<br>Subject:" stays two words.
function textWithBreaks(el) {
  const copy = el.cloneNode(true);
  copy.querySelectorAll("br").forEach(br => br.replaceWith(" "));
  return copy.textContent;
}

function blockOf(node, body) {
  let el = node.nodeType === 1 ? node : node.parentElement;
  while (el && el !== body && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
  return el && el !== body ? el : null;
}

// A "From: … Sent: … Subject:" header, as Outlook and others write it.
function textQuoteStart(body) {
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(text)) return blockOf(node, body);
    if (!QUOTE_FROM.test(text)) continue;
    const block = blockOf(node, body);
    if (!block) continue;
    // The header can be one block with line breaks, or several short ones.
    let around = textWithBreaks(block);
    let next = block.nextElementSibling;
    for (let i = 0; i < 4 && next && around.length < 800; i++, next = next.nextElementSibling) around += " " + textWithBreaks(next);
    if (QUOTE_SENT.test(around) && QUOTE_SUBJECT.test(around)) return block;
  }
  return null;
}

function hasTextBefore(el, parent) {
  const range = parent.ownerDocument.createRange();
  range.setStart(parent, 0);
  range.setEndBefore(el);
  return range.toString().trim().length > 0 || !!range.cloneContents().querySelector?.("img");
}

function quoteStart(body) {
  const marked = body.querySelector(QUOTE_SELECTORS);
  const written = textQuoteStart(body);
  let start = marked && written
    ? (marked.compareDocumentPosition(written) & Node.DOCUMENT_POSITION_PRECEDING ? written : marked)
    : (marked || written);
  if (!start) return null;
  // "On <date>, <name> wrote:" just before a quote belongs to it.
  const before = start.previousElementSibling;
  if (before && /wrote:\s*$/i.test(before.textContent.trim()) && before.textContent.length < 300) start = before;
  // Take the wrapper the header sits in, such as Outlook's top-border div.
  while (start.parentElement && start.parentElement !== body && !hasTextBefore(start, start.parentElement)) start = start.parentElement;
  // And the rule drawn just above it.
  let prior = start.previousElementSibling;
  while (prior && prior.tagName !== "HR" && !prior.textContent.trim() && !prior.querySelector("img") && prior.previousElementSibling) prior = prior.previousElementSibling;
  if (prior && prior.tagName === "HR") start = prior;
  return start;
}

// Put quoted history behind a toggle. A message that is only a quote, such
// as a forward with nothing added, is left whole.
function foldQuotedHtml(html, id) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const body = doc.body;
  if (!body) return html;
  const start = quoteStart(body);
  if (!start || !hasTextBefore(start, body)) return html;
  const range = doc.createRange();
  range.setStartBefore(start);
  range.setEndAfter(body.lastChild);
  const quoted = range.extractContents();
  const open = openQuotes.has(id);
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.className = "quote-toggle";
  toggle.dataset.quoteToggle = id;
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.title = open ? "Hide quoted text" : "Show quoted text";
  toggle.setAttribute("aria-label", toggle.title);
  toggle.textContent = "…";
  const wrap = doc.createElement("div");
  wrap.className = "mail-quote";
  if (!open) wrap.hidden = true;
  wrap.appendChild(quoted);
  body.appendChild(toggle);
  body.appendChild(wrap);
  return body.innerHTML;
}

// ---- Legal footers: one short line until opened ----
const LEGAL_PHRASES = [
  /confidential/i, /privileged/i, /intended (solely |only )?for the (use of the )?(addressee|recipient|individual|person)/i,
  /received (this|the) (e-?mail|message|communication|transmission)? ?in error/i, /not the intended recipient/i,
  /unauthori[sz]ed (use|review|disclosure|distribution|copying)/i, /(delete|destroy) (it|this|all|any)( copies)?/i,
  /legally protected/i, /disclaimer/i, /do not (copy|disclose|distribute|forward)/i
];

function looksLegal(text) {
  if (text.length < 150 || text.length > 2500) return false;
  return LEGAL_PHRASES.filter(re => re.test(text)).length >= 2;
}

function makeToggle(doc, id, label, open) {
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.className = "quote-toggle legal-toggle";
  toggle.dataset.quoteToggle = id;
  toggle.dataset.label = label;
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.title = (open ? "Hide " : "Show ") + label.toLowerCase();
  toggle.setAttribute("aria-label", toggle.title);
  toggle.textContent = label;
  return toggle;
}

function foldLegalHtml(html, id) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const body = doc.body;
  if (!body) return html;
  // The innermost blocks that read as a legal notice, outside the quote.
  const blocks = [...body.querySelectorAll("p, div, td, span, font, small")].filter(el =>
    !el.closest(".mail-quote") &&
    looksLegal(el.textContent.replace(/\s+/g, " ").trim()) &&
    ![...el.querySelectorAll("p, div, td, span, font, small")].some(inner => looksLegal(inner.textContent.replace(/\s+/g, " ").trim()))
  );
  if (!blocks.length) return html;
  blocks.forEach((block, i) => {
    const key = id + ":legal" + i;
    const open = openQuotes.has(key);
    const wrap = doc.createElement(block.tagName === "TD" ? "div" : "div");
    wrap.className = "mail-quote mail-legal";
    if (!open) wrap.hidden = true;
    if (block.tagName === "TD") {
      // Keep table cells in place; fold their contents.
      while (block.firstChild) wrap.appendChild(block.firstChild);
      block.appendChild(makeToggle(doc, key, "Legal notice", open));
      block.appendChild(wrap);
    } else {
      block.replaceWith(makeToggle(doc, key, "Legal notice", open));
      const toggle = body.querySelector('[data-quote-toggle="' + CSS.escape(key) + '"]');
      wrap.appendChild(block);
      toggle.after(wrap);
    }
  });
  return body.innerHTML;
}

document.addEventListener("click", (ev) => {
  const btn = ev.target.closest && ev.target.closest("[data-quote-toggle]");
  if (!btn) return;
  ev.preventDefault();
  ev.stopPropagation();
  const id = btn.dataset.quoteToggle;
  const quote = btn.nextElementSibling;
  if (!quote || !quote.classList.contains("mail-quote")) return;
  const open = quote.hidden;
  quote.hidden = !open;
  if (open) openQuotes.add(id); else openQuotes.delete(id);
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  const what = btn.dataset.label ? btn.dataset.label.toLowerCase() : "quoted text";
  btn.title = (open ? "Hide " : "Show ") + what;
  btn.setAttribute("aria-label", btn.title);
  if (open) fitWideMail(btn.closest(".letter") || reading);
}, true);

// ---- Keep mail's class names apart from the app's ----
// A message's classes are renamed with an m- prefix, and so are the
// selectors in its own <style>, so it keeps its styling but can never pick
// up the app's (Slack's class="card" took the contact card's grid layout).
const MAIL_OWN_CLASSES = new Set(["body-write", "body-sig"]);

function mailClass(name) {
  return MAIL_OWN_CLASSES.has(name) ? name : "m-" + name;
}

function prefixMailClasses(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  if (!doc.body) return html;
  doc.body.querySelectorAll("[class]").forEach(el => {
    el.setAttribute("class", el.getAttribute("class").split(/\s+/).filter(Boolean).map(mailClass).join(" "));
  });
  return doc.body.innerHTML;
}

function prefixSelector(selector) {
  return selector.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (all, name) => "." + mailClass(name))
    .replace(/\[class(\s*[~|^$*]?=\s*)(["']?)([^"'\]]+)\2\]/g, (all, op, q, value) => `[class${op}"${value.split(/\s+/).map(mailClass).join(" ")}"]`);
}

function fittedMailHtml(html, allow, foldId, keepQuoted) {
  // As text, so nothing in the CSS can close the template and become markup.
  const css = esc(mailStyleText(html));
  const shown = prefixMailClasses(remoteMailHtml(html, allow).html);
  const body = foldId ? foldLegalHtml(keepQuoted ? shown : foldQuotedHtml(shown, foldId), foldId) : shown;
  if (!css.trim()) return body;
  return `<template class="mail-css">${css}</template>${body}`;
}

function stampText(value) {
  const text = String(value == null ? "" : value);
  const len = text.length;
  if (!len) return "0";
  const step = Math.max(1, Math.floor(len / 24));
  let hash = len;
  for (let i = 0; i < len; i += step) hash = Math.imul(hash, 31) + text.charCodeAt(i);
  return len.toString(36) + "." + (hash >>> 0).toString(36);
}

const letterHtmlCache = new Map();

function letterCacheKey(message) {
  const images = inlineImagesFor.get(message.id);
  return [
    message.id,
    stampText(message.bodyHtml),
    allowRemoteFor(message) ? "1" : "0",
    isForwardMail(message) ? "1" : "0",
    images && images.list ? String(images.list.length) : "0"
  ].join("\n");
}

function letterHtml(message) {
  if (message && message.needsBody) return `<p>${esc(message.preview || message.body || "")}</p>`;
  if (!message || !message.bodyHtml) return `<p>${esc((message && message.body) || "")}</p>`;
  const key = letterCacheKey(message);
  const hit = letterHtmlCache.get(key);
  if (hit != null) {
    letterHtmlCache.delete(key);
    letterHtmlCache.set(key, hit);
    return hit;
  }
  const html = fittedMailHtml(withInlineImages(message, message.bodyHtml), allowRemoteFor(message), message.id, isForwardMail(message));
  letterHtmlCache.set(key, html);
  while (letterHtmlCache.size > 12) letterHtmlCache.delete(letterHtmlCache.keys().next().value);
  return html;
}

// A forward is sent for what it carries, so the forwarded part stays open
// (2026-10-27). Replies still fold their quoted history; "RE: FW:" is a reply.
function isForwardMail(message) {
  return /^\s*(fwd?|fw)\s*:/i.test(String((message && message.subject) || ""));
}

function isNeutralRule(value) {
  const sample = colourSample(value);
  if (!sample || sample.a < 0.35) return false;
  if (isPaperColour(value)) return true;
  const max = Math.max(sample.r, sample.g, sample.b);
  const min = Math.min(sample.r, sample.g, sample.b);
  const sat = max === min ? 0 : (max - min) / max;
  const light = (max + min) / 510;
  return sat <= 0.12 && light <= 0.2;
}

function hairlinePaint(el) {
  const style = el.getAttribute("style") || "";
  const declared = style.match(/(?:^|;)\s*background-color\s*:\s*([^;]+)/i)
    || style.match(/(?:^|;)\s*background\s*:\s*([^;]+)/i);
  const raw = (declared ? declared[1] : (el.getAttribute("bgcolor") || "")).trim();
  if (!raw || /url\(/i.test(raw)) return false;
  if (!isNeutralRule(raw)) return false;
  const height = parseFloat(el.getAttribute("height") || el.style.height);
  return Number.isFinite(height) && height > 0 && height <= 4;
}

// Dark mode turns a designed (or paper) mail over, as Outlook does: each
// colour is worked out here with the sum CSS invert(1) hue-rotate(180deg)
// does, and set on its element, so pictures stay as they are. It was a
// filter on the whole letter, but WebKitGTK's GPU compositing drops a
// filtered layer that large: on a tall mail on a high-DPI screen everything
// but the pictures vanished a moment after opening (2026-10-26, PetSmart).
const TURN_OVER = [[-0.574, 1.43, 0.144], [0.426, 0.43, 0.144], [0.426, 1.43, -0.856]];
const TURN_PROPS = ["color", "background-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color"];
const TURN_SKIP = new Set(["IMG", "VIDEO", "PICTURE", "SOURCE", "BR", "WBR", "STYLE", "TEMPLATE"]);

function rgbOf(value) {
  const match = String(value || "").match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/);
  if (!match) return null;
  const alpha = match[4] == null ? 1 : (match[4].endsWith("%") ? parseFloat(match[4]) / 100 : +match[4]);
  return { r: +match[1], g: +match[2], b: +match[3], a: alpha };
}

function turnedOver(sample) {
  const c = [1 - sample.r / 255, 1 - sample.g / 255, 1 - sample.b / 255];
  const out = TURN_OVER.map(row => Math.round(Math.min(1, Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2])) * 255));
  return sample.a < 1 ? `rgba(${out.join(", ")}, ${sample.a})` : `rgb(${out.join(", ")})`;
}

function turnMailOver(root) {
  turnMailBack(root);
  // Read every colour first: a parent's new colour would otherwise be
  // inherited, read, and turned over a second time.
  const plan = [];
  [root, ...root.querySelectorAll("*")].forEach(node => {
    if (TURN_SKIP.has(node.tagName) || inMountedSignature(node)) return;
    const style = getComputedStyle(node);
    TURN_PROPS.forEach(prop => {
      if (prop.startsWith("border-") && !(parseFloat(style.getPropertyValue(prop.replace("-color", "-width"))) > 0)) return;
      const sample = rgbOf(style.getPropertyValue(prop));
      if (!sample || (prop !== "color" && sample.a === 0)) return;
      plan.push([node, prop, turnedOver(sample)]);
    });
  });
  root._turned = plan.map(([node, prop]) => [node, prop, node.style.getPropertyValue(prop), node.style.getPropertyPriority(prop)]);
  plan.forEach(([node, prop, value]) => node.style.setProperty(prop, value, "important"));
}

// Undo turnMailOver, before the mail's own styles are laid on again.
function turnMailBack(root) {
  const turned = root && root._turned;
  if (!turned) return;
  for (let i = turned.length - 1; i >= 0; i--) {
    const [node, prop, value, priority] = turned[i];
    if (value) node.style.setProperty(prop, value, priority);
    else node.style.removeProperty(prop);
  }
  root._turned = null;
}

function mailDesigned(root) {
  for (const el of root.querySelectorAll("[bgcolor], [style*='background']")) {
    if (inSignature(el)) continue;
    if (highlightOf(el)) continue;
    const style = el.getAttribute("style") || "";
    const fill = el.getAttribute("bgcolor") || ((style.match(/background(?:-color)?\s*:\s*([^;]+)/i) || [])[1] || "");
    const bare = fill.replace(/!important/i, "").trim();
    if (!bare || /^(transparent|none|inherit|initial|unset)$/i.test(bare)) continue;
    if (/url\(/i.test(bare)) return true;
    const sample = colourSample(bare);
    if (sample && sample.a >= 0.35 && !isPaperColour(bare)) return true;
  }
  return false;
}

function mailPaperStructure(root) {
  if (root.querySelector(".st-Background, .st-Wrapper, .st-Email")) return false;
  let rules = 0;
  const nodes = root.querySelectorAll("td, th, div, table, span, p");
  for (const el of nodes) {
    if (inSignature(el) || !hairlinePaint(el)) continue;
    rules += 1;
    if (rules >= 2) return true;
  }
  return false;
}

const MAIL_LAYOUT = new Set("width max-width min-width height min-height max-height display font-size line-height padding padding-top padding-right padding-bottom padding-left margin margin-top margin-right margin-bottom margin-left float box-sizing vertical-align text-align border-spacing border-collapse".split(" "));

function mediaFitsPane(prelude, pane) {
  const query = prelude.replace(/@media/i, "").toLowerCase();
  if (query.includes("prefers-color-scheme") || query.includes("print")) return false;
  const max = query.match(/max-width\s*:\s*([\d.]+)px/);
  const min = query.match(/min-width\s*:\s*([\d.]+)px/);
  if (!max && !min) return false;
  if (max && pane > parseFloat(max[1])) return false;
  if (min && pane < parseFloat(min[1])) return false;
  return true;
}

function selectorFitsMail(selector) {
  const text = selector.trim();
  if (!text || text.length > 300) return false;
  if (/hover|active|focus|visited|:root|\bhtml\b|\bbody\b/i.test(text)) return false;
  return true;
}

// Looks a message's own stylesheet may set, beyond layout. Never images.
const MAIL_LOOK = new Set("color background-color border border-top border-right border-bottom border-left border-color border-style border-width border-radius font-weight font-style font-family text-decoration text-transform letter-spacing white-space".split(" "));

// An element's style as the mail set it, before its stylesheet was applied.
// Kept off the DOM, so nothing in a message can claim to be a saved style.
const savedMailStyle = new WeakMap();

// What the message set directly on an element wins over its stylesheet.
function ownInline(el) {
  if (!el._ownInline) {
    const probe = document.createElement("span");
    probe.setAttribute("style", savedMailStyle.has(el) ? savedMailStyle.get(el) : (el.getAttribute("style") || ""));
    el._ownInline = probe.style;
  }
  return el._ownInline;
}

function applyMailDeclarations(el, body, topLevel) {
  body.split(";").forEach(part => {
    const index = part.indexOf(":");
    if (index < 0) return;
    const name = part.slice(0, index).trim().toLowerCase();
    const raw = part.slice(index + 1).trim();
    if (!/^[a-z-]+$/.test(name) || !raw || raw.length > 80) return;
    if (!MAIL_LAYOUT.has(name) && !(topLevel && MAIL_LOOK.has(name))) return;
    if (/url\(|image-set|image\(|cross-fade|element\(|\\|expression\(|javascript:|@import|-moz-binding/i.test(raw)) return;
    const important = /!important\s*$/i.test(raw);
    const clean = raw.replace(/!important\s*$/i, "").trim();
    if (!clean) return;
    // The element's own style wins, as in CSS: always over a plain rule,
    // and over an !important rule when it is !important itself.
    const own = ownInline(el);
    if (own.getPropertyValue(name) && (!important || own.getPropertyPriority(name) === "important")) return;
    if (!savedMailStyle.has(el)) savedMailStyle.set(el, el.getAttribute("style") || "");
    el.style.setProperty(name, clean, important ? "important" : "");
  });
}

function applyMailRuleList(root, css, pane, applyRules) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--/g, "").replace(/-->/g, "");
  let i = 0;
  const skipSpace = () => { while (i < text.length && /\s/.test(text[i])) i += 1; };
  const readBlock = () => {
    if (text[i] !== "{") return "";
    i += 1;
    let depth = 1;
    const start = i;
    while (i < text.length && depth) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") depth -= 1;
      if (depth) i += 1;
    }
    const body = text.slice(start, i);
    if (text[i] === "}") i += 1;
    return body;
  };
  while (i < text.length) {
    skipSpace();
    if (i >= text.length) break;
    if (text.startsWith("@", i)) {
      const brace = text.indexOf("{", i);
      if (brace < 0) break;
      const prelude = text.slice(i, brace);
      i = brace;
      const body = readBlock();
      if (/^@media/i.test(prelude) && mediaFitsPane(prelude, pane)) applyMailRuleList(root, body, pane, "media");
      continue;
    }
    const brace = text.indexOf("{", i);
    if (brace < 0) break;
    const selector = text.slice(i, brace);
    i = brace;
    const body = readBlock();
    if (!applyRules) continue;
    selector.split(",").forEach(part => {
      const one = part.trim();
      if (!selectorFitsMail(one)) return;
      let nodes = [];
      try { nodes = [...root.querySelectorAll(prefixSelector(one))]; } catch (e) { return; }
      nodes.forEach(node => { if (!inMountedSignature(node)) applyMailDeclarations(node, body, applyRules === "top"); });
    });
  }
}

function applyMailStyles(root, css, pane) {
  root.querySelectorAll("*").forEach(node => {
    if (!savedMailStyle.has(node)) return;
    const saved = savedMailStyle.get(node);
    if (saved) node.setAttribute("style", saved);
    else node.removeAttribute("style");
  });
  try { applyMailRuleList(root, css, pane, "top"); } catch (e) { /* a broken stylesheet leaves the message readable */ }
}

// Dark mode keeps a plain mail's own text colours, as Outlook does
// (2026-10-23, Kai's signature: orange "T:" labels, a grey name): each
// keeps its hue and is lightened enough to read on the dark pane. Black and
// greys turn light. The colour rides in --dark-ink; light view ignores it.
const darkInkCache = new Map();
function darkInkFor(value) {
  const key = String(value || "").trim().toLowerCase();
  if (darkInkCache.has(key)) return darkInkCache.get(key);
  const sample = colourSample(key);
  let out = "";
  if (sample && sample.a >= 0.35) {
    const r = sample.r / 255, g = sample.g / 255, b = sample.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const l = (max + min) / 2;
    const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = Math.round(((h * 60) + 360) % 360);
    const light = sat < 0.15
      ? Math.min(0.92, Math.max(0.6, 1 - l))
      : (l >= 0.6 ? l : Math.min(0.8, Math.max(0.6, 1 - l * 0.8)));
    out = `hsl(${h} ${Math.round(sat * 100)}% ${Math.round(light * 100)}%)`;
  }
  darkInkCache.set(key, out);
  return out;
}

// Inline elements with a fill are highlights (2026-10-23): kept as they
// are in dark mode, with dark text on them.
const MARK_TAGS = new Set(["SPAN", "FONT", "MARK", "B", "STRONG", "I", "EM", "U", "A", "SUB", "SUP", "S", "CODE"]);
function highlightOf(node) {
  if (!node || !node.style || !MARK_TAGS.has(node.tagName)) return "";
  const fill = node.style.backgroundColor || "";
  const sample = fill && colourSample(fill);
  return sample && sample.a >= 0.35 ? fill : "";
}

function markDarkInks(root) {
  root.querySelectorAll("*").forEach(node => {
    if (inMountedSignature(node)) return;
    const fill = highlightOf(node);
    if (fill) {
      node.style.setProperty("--mark-bg", fill);
      node.setAttribute("data-mark-bg", "");
    } else if (node.hasAttribute("data-mark-bg")) {
      node.style.removeProperty("--mark-bg");
      node.removeAttribute("data-mark-bg");
    }
    const own = (node.style && node.style.color) || (node.tagName === "FONT" && node.getAttribute("color")) || "";
    // On a highlight the sender's own colour reads as it is.
    const onMark = !!(node.closest && node.closest("[data-mark-bg]"));
    const ink = own ? (onMark ? own : darkInkFor(own)) : "";
    if (ink) {
      node.style.setProperty("--dark-ink", ink);
      node.setAttribute("data-dark-ink", "");
    } else if (node.hasAttribute("data-dark-ink")) {
      node.style.removeProperty("--dark-ink");
      node.removeAttribute("data-dark-ink");
    }
  });
}

function capLargeMailType(el) {
  el.querySelectorAll("*").forEach(node => {
    if (inSignature(node)) return;
    const size = parseFloat(getComputedStyle(node).fontSize);
    if (!(size > 22)) return;
    node.style.setProperty("font-size", "22px", "important");
    const leading = parseFloat(getComputedStyle(node).lineHeight);
    if (Number.isFinite(leading) && leading > 22 * 1.5) node.style.setProperty("line-height", "1.35", "important");
  });
}

function fitWideMail(root) {
  const scope = root || document;
  if (!scope.querySelectorAll) return;
  mountReadSignatures(scope);
  scope.querySelectorAll(".letter-fit").forEach(el => {
    if (el.closest("[hidden]")) return;
    el.style.zoom = "";
    const pane = el.clientWidth;
    if (pane < 40) return;
    el._fitGen = (el._fitGen || 0) + 1;
    const gen = el._fitGen;
    if (el._mailCss == null) {
      const cssNode = el.querySelector("template.mail-css");
      el._mailCss = cssNode ? (cssNode.content.textContent || "") : "";
      if (cssNode) cssNode.remove();
    }
    turnMailBack(el);
    if (el._mailCss) applyMailStyles(el, el._mailCss, pane);
    const paper = mailPaperStructure(el);
    const host = el.closest(".letter, .history-body");
    if (host) host.classList.toggle("mail-paper", paper);
    // A designed mail — coloured blocks, a logo tile — is turned dark as a
    // whole in dark mode, as Outlook does, rather than having its colours
    // stripped (2026-10-23).
    if (host) host.classList.toggle("mail-designed", !paper && mailDesigned(el));
    if (!paper) markDarkInks(el);
    if (host && (paper || host.classList.contains("mail-designed")) && !host.classList.contains("light-view") && signatureDark()) turnMailOver(el);
    if (el.scrollWidth > pane + 1) loosenWideMail(el, pane);
    if (paper) return;
    const nodes = [...el.querySelectorAll("*")].filter(node => !inSignature(node));
    const sizes = [];
    const finish = () => {
      if (!el.isConnected || el._fitGen !== gen) return;
      raiseSmallMailType(el, nodes, sizes);
      shareMailColumns(el);
      if (pane <= 657) capLargeMailType(el);
    };
    if (nodes.length <= 160) {
      readMailType(nodes, 0, nodes.length, sizes);
      finish();
      return;
    }
    let index = 0;
    const step = () => {
      if (!el.isConnected || el._fitGen !== gen) return;
      readMailType(nodes, index, index + 40, sizes);
      index += 40;
      if (index < nodes.length) requestAnimationFrame(step);
      else finish();
    };
    requestAnimationFrame(step);
  });
}

// Message list: Comfortable shows a preview line and the first attachment;
// Compact is two lines a message, with a paperclip for attachments.
let listDensity = (() => { try { return localStorage.getItem("mailroom-list-density") === "compact" ? "compact" : "comfortable"; } catch (e) { return "comfortable"; } })();
document.body.dataset.listDensity = listDensity;

// Reading text: Comfortable lifts small mail text to 16 px, Compact to 14 px.
let readSize = (() => { try { return localStorage.getItem("mailroom-read-size") === "compact" ? "compact" : "comfortable"; } catch (e) { return "comfortable"; } })();
document.body.dataset.readSize = readSize;

function mailTextFloor() {
  return readSize === "compact" ? 14 : 16;
}

// Small mail type is enlarged in proportion, as Outlook zooms it: the body
// text comes up to the floor and everything else by the same factor, so a
// signature written smaller than the body stays smaller (2026-10-23,
// Kai's T:/C:/E: lines had all been raised to the body's size). Sizes are
// all read before any is written, so nothing is scaled twice.
function readMailType(nodes, start, end, sizes) {
  for (let i = start; i < end && i < nodes.length; i++) {
    const node = nodes[i];
    const style = getComputedStyle(node);
    let text = 0;
    // Quoted history and a legal footer are not the message. A long one in
    // small type must not decide the size of the words being read, whether
    // it is folded away or open.
    if (!(node.closest && node.closest(".mail-quote"))) {
      node.childNodes.forEach(child => { if (child.nodeType === 3) text += child.textContent.trim().length; });
    }
    sizes[i] = { size: parseFloat(style.fontSize), leading: style.lineHeight, text };
  }
}

function raiseSmallMailType(root, nodes, sizes) {
  const floor = mailTextFloor();
  // The body's size: the one most of the text is set in.
  const weight = new Map();
  sizes.forEach(item => { if (item && item.text && item.size >= 6) weight.set(item.size, (weight.get(item.size) || 0) + item.text); });
  let body = 0, most = 0;
  weight.forEach((count, size) => { if (count > most) { most = count; body = size; } });
  if (!body || body >= floor) {
    // Body already large enough: only lift what is too small to read.
    nodes.forEach((node, i) => { const item = sizes[i]; if (item && item.size >= 8 && item.size < 11) node.style.setProperty("font-size", "11px", "important"); });
    return;
  }
  const factor = Math.min(floor / body, 2);
  const rootSize = parseFloat(getComputedStyle(root).fontSize);
  const index = new Map(nodes.map((node, i) => [node, i]));
  nodes.forEach((node, i) => {
    const item = sizes[i];
    if (!item || !(item.size >= 6)) return;
    // Only where the size changes; the rest inherits the scaled size.
    const j = index.get(node.parentElement);
    const inherited = j != null && sizes[j] ? sizes[j].size : rootSize;
    if (Math.abs(item.size - inherited) < 0.01) return;
    const size = Math.round(item.size * factor * 10) / 10;
    node.style.setProperty("font-size", size + "px", "important");
    if (/px$/.test(item.leading)) node.style.setProperty("line-height", Math.round(parseFloat(item.leading) * factor * 10) / 10 + "px", "important");
  });
}

function mailAuthorWidth(cell) {
  if (!cell.dataset.mailW) cell.dataset.mailW = (cell.style.width || "").trim();
  return cell.dataset.mailW;
}

function shareMailColumns(el) {
  el.querySelectorAll("table").forEach(table => {
    if (inSignature(table)) return;
    const row = [...table.rows].find(r => r.cells.length > 1);
    if (!row) return;
    const described = [...row.cells].map(cell => {
      const text = (cell.innerText || "").replace(/\s+/g, " ").trim();
      const declared = mailAuthorWidth(cell);
      const px = /px$/.test(declared) ? parseFloat(declared) : NaN;
      const chrome = !text && Number.isFinite(px) && px <= 32;
      return { cell, text, px, chrome };
    });
    const content = described.filter(item => !item.chrome);
    if (content.length < 2) return;
    const starved = content.some(item => {
      const w = item.cell.getBoundingClientRect().width;
      if (Number.isFinite(item.px) && item.px >= 24 && w + 1 < item.px * 0.8) return true;
      return item.text.length > 0 && item.text.length <= 20 && item.cell.scrollWidth > item.cell.clientWidth + 1;
    });
    if (!starved && table.dataset.mailShared !== "1") return;
    const host = table.parentElement ? table.parentElement.clientWidth : el.clientWidth;
    if (host < 40) return;
    table.dataset.mailShared = "1";
    table.style.setProperty("width", "100%", "important");
    table.style.setProperty("max-width", "100%", "important");
    table.style.setProperty("table-layout", "fixed", "important");
    table.style.setProperty("min-width", "0", "important");
    const chromePx = described.filter(item => item.chrome).reduce((sum, item) => sum + item.px, 0);
    const share = Math.max(32, (host - chromePx) / content.length);
    described.forEach(item => {
      const width = item.chrome ? item.px : share;
      item.cell.style.setProperty("width", width + "px", "important");
      item.cell.style.setProperty("max-width", width + "px", "important");
      item.cell.style.setProperty("min-width", "0", "important");
    });
    content.forEach(item => {
      const nodes = [item.cell, ...item.cell.querySelectorAll("span, a, p, div, font, td, th")];
      let size = share < 96 ? Math.max(11, Math.round(share / 6)) : 16;
      const apply = px => nodes.forEach(node => node.style.setProperty("font-size", px + "px", "important"));
      apply(size);
      item.cell.querySelectorAll("table").forEach(inner => {
        inner.style.setProperty("width", "100%", "important");
        inner.style.setProperty("max-width", "100%", "important");
        inner.style.setProperty("table-layout", "fixed", "important");
      });
      const single = item.text.length > 0 && item.text.length <= 20;
      while (single && size > 11 && item.cell.scrollWidth > item.cell.clientWidth + 1) {
        size -= 1;
        apply(size);
      }
    });
  });
}

function loosenWideMail(el, pane) {
  el.querySelectorAll("table, td, th, img, video, div, center, p").forEach(node => {
    if (inSignature(node)) return;
    const attr = parseFloat(node.getAttribute("width"));
    const styled = (node.style.width || "").trim();
    const minW = (node.style.minWidth || "").trim();
    const tooWide = (attr > pane) || (styled.endsWith("px") && parseFloat(styled) > pane);
    if (tooWide) {
      node.style.setProperty("width", node.tagName === "TABLE" ? "100%" : "auto", "important");
      node.style.setProperty("max-width", "100%", "important");
      if (node.tagName === "IMG" || node.tagName === "VIDEO") {
        node.style.setProperty("height", "auto", "important");
      }
      if (node.tagName === "TABLE") node.style.setProperty("table-layout", "fixed", "important");
    }
    if (minW.endsWith("px") && parseFloat(minW) > pane) {
      node.style.setProperty("min-width", "0", "important");
    }
  });
}

function remoteBar(message) {
  if (!message || !message.bodyHtml || allowRemoteFor(message)) return "";
  if (!remoteMailHtml(message.bodyHtml, false).blocked) return "";
  const domain = organisationalDomain(message.email);
  const trust = domain
    ? `<button type="button" data-trust-sender="${esc(message.id)}">Add ${esc(domain)} to Safe senders</button>`
    : "";
  return `<div class="remote-bar" role="status">
    <p>Some content in this message was blocked.</p>
    <button type="button" data-show-remote="${esc(message.id)}" title="This message only">Show blocked content</button>
    ${trust}
  </div>`;
}

const SEND_DELAY_DEFAULT = 10;
const SEND_DELAY_MAX = 120;
let sendDelay = loadSendDelay();

function loadSendDelay() {
  try {
    const raw = localStorage.getItem("mailroom-send-delay");
    if (raw == null || raw === "") return SEND_DELAY_DEFAULT;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > SEND_DELAY_MAX) return SEND_DELAY_DEFAULT;
    return n;
  } catch (e) {
    return SEND_DELAY_DEFAULT;
  }
}

function sendDelayError(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return "Enter a number of seconds.";
  if (!/^\d+$/.test(text)) return "Enter a whole number from 0 to 120.";
  const n = Number(text);
  if (n > SEND_DELAY_MAX) return "Enter a whole number from 0 to 120.";
  return "";
}

function rememberSendDelay(seconds) {
  sendDelay = seconds;
  try { localStorage.setItem("mailroom-send-delay", String(seconds)); } catch (e) {}
}

function delayPhrase(seconds) {
  return seconds === 1 ? "1 second" : seconds + " seconds";
}

const MAIL_SYNC_DEFAULT = 365;
const CAL_SYNC_BACK_DEFAULT = 183;
const CAL_SYNC_AHEAD_DEFAULT = 365;
const SYNC_DAYS_MAX = 3650;

function loadSyncDays(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > SYNC_DAYS_MAX) return fallback;
    return n;
  } catch (e) {
    return fallback;
  }
}

let mailSyncDays = loadSyncDays("mailroom-mail-sync-days", MAIL_SYNC_DEFAULT);
let calSyncBack = loadSyncDays("mailroom-cal-sync-back", CAL_SYNC_BACK_DEFAULT);
let calSyncAhead = loadSyncDays("mailroom-cal-sync-ahead", CAL_SYNC_AHEAD_DEFAULT);

function syncDaysError(value) {
  const text = String(value == null ? "" : value).trim();
  if (!/^\d+$/.test(text)) return "Enter a whole number from 1 to 3650.";
  const n = Number(text);
  if (n < 1 || n > SYNC_DAYS_MAX) return "Enter a whole number from 1 to 3650.";
  return "";
}

function syncSinceIso(days) {
  const count = Number.isInteger(days) ? days : mailSyncDays;
  const today = todayDate();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  start.setDate(start.getDate() - count);
  return start.toISOString();
}

function rememberSyncWindow(mailDays, backDays, aheadDays) {
  mailSyncDays = mailDays;
  calSyncBack = backDays;
  calSyncAhead = aheadDays;
  try {
    localStorage.setItem("mailroom-mail-sync-days", String(mailDays));
    localStorage.setItem("mailroom-cal-sync-back", String(backDays));
    localStorage.setItem("mailroom-cal-sync-ahead", String(aheadDays));
  } catch (e) {}
  folderSyncToken += 1;
  calendarSyncToken += 1;
  loadedLiveFolders.clear();
  folderPage.clear();
  searchFoldersLoaded.clear();
  calendarSynced.clear();
  searchPrimed = false;
  invalidateSearchHits();
  if (!inDesktop()) return;
  if (view === "mail") {
    if (account === "all") ensureUnifiedFolder(box);
    else ensureFolderMessages(account, box);
    if (searchActive()) ensureSearchCache();
  } else if (view === "calendar") refreshLiveCalendar();
}

// ---- Spelling: WebKit's checker, with the dictionaries on this computer ----
function spellingPref() {
  try {
    const saved = JSON.parse(localStorage.getItem("mailroom-spelling") || "null");
    if (saved && typeof saved === "object") return { enabled: saved.enabled !== false, beforeSend: saved.beforeSend !== false, languages: Array.isArray(saved.languages) ? saved.languages.map(String).slice(0, 4) : [] };
  } catch (e) {}
  return { enabled: true, beforeSend: true, languages: [] };
}

async function applySpelling(pref) {
  if (!inDesktop()) return null;
  try {
    return await tauriInvoke("set_spelling", { enabled: !!pref.enabled, languages: pref.languages || [] });
  } catch (e) {
    return null;
  }
}

function spellLanguageName(code) {
  try {
    // "English (Canada)", not "Canadian English", so variants sort together.
    const name = new Intl.DisplayNames([navigator.language || "en"], { type: "language", languageDisplay: "standard" }).of(code.replace("_", "-"));
    return name && name !== code ? name : code;
  } catch (e) {
    return code;
  }
}

// The words you wrote: the subject and your part of the body, without the
// signature or the message you are answering.
function writtenText(form) {
  const body = form.querySelector("#compose-body");
  const copy = (body.querySelector(".body-write") || body).cloneNode(true);
  copy.querySelectorAll(".body-sig, .mail-quote, [data-quote-start], #divRplyFwdMsg, blockquote, #appendonsend ~ *").forEach(el => el.remove());
  copy.querySelectorAll("br").forEach(br => br.replaceWith(" "));
  copy.querySelectorAll("p, div, li").forEach(el => el.append(" "));
  const subject = form.querySelector("#compose-subject");
  return ((subject ? subject.value : "") + "\n" + copy.textContent).trim();
}

// Names to leave alone: the people you are writing to, and you.
function spellingIgnore(form, fromId) {
  const names = [];
  ["#compose-to", "#compose-cc", "#compose-bcc"].forEach(sel => {
    const field = form.querySelector(sel);
    if (!field) return;
    parseAddresses(field.value).forEach(email => {
      names.push(email.split("@")[0]);
      const label = recipientLabel(email);
      if (label) names.push(label);
    });
  });
  const acct = accounts[fromAccountId(fromId) || fromId];
  if (acct) names.push(acct.yourName || "", acct.name || "");
  return names.filter(Boolean).slice(0, 60);
}

// A suggestion keeps the capital when the word you typed has one.
function suggestionCase(word, suggestion) {
  const first = String(word || "").charAt(0);
  const repl = String(suggestion || "");
  if (first && first !== first.toLowerCase() && first === first.toUpperCase() && repl.charAt(0) === repl.charAt(0).toLowerCase()) {
    return repl.charAt(0).toUpperCase() + repl.slice(1);
  }
  return repl;
}

// Replace one checked word, and not a longer word, an address, or a link.
function replaceSpellingWord(text, word, suggestion) {
  const repl = suggestionCase(word, suggestion);
  if (!text || !word || !repl || word === repl) return text;
  const pattern = "(^|[^\\p{L}\\p{N}'])(" + String(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")(?=$|[^\\p{L}\\p{N}'])";
  return String(text).split(/(\s+)/).map(part => {
    if (!part || /^\s+$/.test(part)) return part;
    const lower = part.toLowerCase();
    if (lower.includes("@") || lower.includes("://") || lower.startsWith("www.")) return part;
    return part.replace(new RegExp(pattern, "gu"), (match, lead) => lead + repl);
  }).join("");
}

function spellingWriteRoot(form) {
  const body = form.querySelector("#compose-body");
  if (!body) return null;
  return body.querySelector(".body-write") || body;
}

function spellingSkipped(node, root) {
  const el = node.parentElement;
  if (!el) return false;
  if (el.closest(".body-sig, .mail-quote, blockquote, [data-quote-start], #divRplyFwdMsg")) return true;
  const marker = root.querySelector("#appendonsend");
  return !!(marker && (marker.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
}

// Fix and send writes the first suggestion into the subject and the words
// you typed. The signature and the message you are answering stay as they are.
function applySpellingFixes(form, wrong) {
  const fixes = (wrong || []).filter(w => w && w.word && w.suggestions && w.suggestions[0]);
  if (!fixes.length) return false;
  let changed = false;
  const subject = form.querySelector("#compose-subject");
  if (subject) {
    let next = subject.value;
    fixes.forEach(w => { next = replaceSpellingWord(next, w.word, w.suggestions[0]); });
    if (next !== subject.value) {
      subject.value = next;
      subject.dispatchEvent(new Event("input", { bubbles: true }));
      changed = true;
    }
  }
  const root = spellingWriteRoot(form);
  if (root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return spellingSkipped(node, root) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(node => {
      let next = node.nodeValue;
      fixes.forEach(w => { next = replaceSpellingWord(next, w.word, w.suggestions[0]); });
      if (next !== node.nodeValue) {
        node.nodeValue = next;
        changed = true;
      }
    });
    if (changed) {
      const body = form.querySelector("#compose-body");
      if (body) body.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }
  return changed;
}

function spellingFixNote(wrong) {
  const shown = wrong.slice(0, 8).map(w => {
    const suggestion = w.suggestions && w.suggestions[0];
    if (!suggestion) return w.word;
    const rest = w.suggestions.slice(1, 3);
    return w.word + " → " + suggestion + (rest.length ? " (or " + rest.join(", ") + ")" : "");
  }).join(" · ");
  return shown + (wrong.length > 8 ? " and " + (wrong.length - 8) + " more" : "");
}

// Before Send: say which words look wrong, as Outlook's check does.
async function spellingAllowsSend(form, fromId) {
  const pref = spellingPref();
  if (!inDesktop() || !pref.enabled || !pref.beforeSend) return true;
  const text = writtenText(form);
  if (!text) return true;
  let wrong = [];
  try {
    wrong = await tauriInvoke("check_spelling", { text, ignore: spellingIgnore(form, fromId) });
  } catch (e) {
    return true;
  }
  if (!wrong || !wrong.length) return true;
  const canFix = wrong.some(w => w.suggestions && w.suggestions.length);
  const title = wrong.length === 1 ? "1 word may be misspelt" : wrong.length + " words may be misspelt";
  const choice = await chooseDialog(title, spellingFixNote(wrong), [
    { value: "fix-send", label: "Fix and send", primary: canFix },
    { value: "edit", label: "Go back and edit", primary: !canFix },
    { value: "send", label: "Send anyway" }
  ]);
  if (choice === "send") return true;
  if (choice !== "fix-send") return false;
  if (!applySpellingFixes(form, wrong)) {
    toast("No suggestion to apply.");
    return false;
  }
  return true;
}

async function bindSpellingSetting(body) {
  const box = body.querySelector("#spell-on");
  const select = body.querySelector("#spell-lang");
  const note = body.querySelector("#spell-note");
  if (!box || !select) return;
  const state = inDesktop() ? await tauriInvoke("spelling").catch(() => null) : null;
  if (!body.contains(select)) return;
  const installed = (state && state.installed) || [];
  if (!installed.length) {
    select.innerHTML = `<option value="">No dictionaries</option>`;
    select.disabled = true;
    box.disabled = !inDesktop();
    note.textContent = inDesktop()
      ? "No spelling dictionaries are installed. Install hunspell-en_ca, then restart Mailroom."
      : "Spell check works in the desktop app.";
    return;
  }
  const chosen = (state.languages && state.languages[0]) || installed[0];
  const named = installed.map(code => [code, spellLanguageName(code)]).sort((a, b) => a[1].localeCompare(b[1]));
  select.innerHTML = named.map(([code, label]) => `<option value="${esc(code)}"${code === chosen ? " selected" : ""}>${esc(label)}</option>`).join("");
  select.disabled = !box.checked;
  const sendBox = body.querySelector("#spell-send");
  const save = async () => {
    const pref = { enabled: box.checked, beforeSend: !sendBox || sendBox.checked, languages: [select.value] };
    try { localStorage.setItem("mailroom-spelling", JSON.stringify(pref)); } catch (e) {}
    select.disabled = !box.checked;
    await applySpelling(pref);
  };
  box.onchange = save;
  select.onchange = save;
  if (sendBox) sendBox.onchange = save;
}

setTimeout(() => { applySpelling(spellingPref()); }, 0);

// ---- Templates (2026-10-23): saved messages to drop into any compose, as
// Outlook's My templates. On this computer, shared by every window.
function loadTemplates() {
  try {
    const list = JSON.parse(localStorage.getItem("mailroom-templates") || "[]");
    return Array.isArray(list) ? list.filter(t => t && t.id && typeof t.name === "string" && typeof t.html === "string").slice(0, 100) : [];
  } catch (e) { return []; }
}
function saveTemplates(list) {
  try { localStorage.setItem("mailroom-templates", JSON.stringify(list.slice(0, 100))); return true; }
  catch (e) { toast("Templates couldn't be saved on this computer."); return false; }
}
function upsertTemplate(t) {
  const list = loadTemplates().filter(x => x.id !== t.id);
  list.push({ id: t.id || "tpl-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: String(t.name || "").trim().slice(0, 80) || "Template", subject: String(t.subject || "").slice(0, 200), html: htmlFor(String(t.html || "")) });
  list.sort((a, b) => a.name.localeCompare(b.name));
  return saveTemplates(list) ? list : null;
}

let editingTemplate = null;
function renderTemplates(body) {
  const list = loadTemplates();
  const edit = editingTemplate;
  if (edit) {
    body.innerHTML = `<form id="template-form" class="template-form">
      <label class="field">Name<input name="name" value="${esc(edit.name || "")}" maxlength="80" autocomplete="off" placeholder="Site visit follow-up"></label>
      <label class="field">Subject <span class="field-hint">(used when the message has none yet)</span><input name="subject" value="${esc(edit.subject || "")}" maxlength="200" autocomplete="off"></label>
      <div class="field">Message<div class="html-body template-body" id="template-body" contenteditable="true" role="textbox" aria-multiline="true">${htmlFor(edit.html || "<p><br></p>")}</div></div>
      <div class="dialog-actions"><button class="ghost" type="button" id="template-cancel">Cancel</button><button class="primary" type="submit">Save</button></div>
    </form>`;
    body.querySelector("#template-cancel").onclick = () => { editingTemplate = null; render(); };
    body.querySelector("#template-form").onsubmit = (e) => {
      e.preventDefault();
      const data = new FormData(e.target);
      const name = String(data.get("name") || "").trim();
      if (!name) return toast("Give the template a name.");
      if (upsertTemplate({ id: edit.id, name, subject: data.get("subject"), html: body.querySelector("#template-body").innerHTML })) {
        editingTemplate = null;
        toast("Saved — " + name);
        render();
      }
    };
    body.querySelector("[name=name]").focus();
    return;
  }
  body.innerHTML = `<p class="field-hint">Saved messages you can drop into any email from the Templates button when writing. They stay on this computer.</p>
    <div class="template-list">${list.length ? list.map(t => `<div class="template-item"><div><strong>${esc(t.name)}</strong><span class="field-hint">${esc(plainFromHtml(t.html).slice(0, 90))}</span></div><button type="button" class="linkish" data-edit-template="${esc(t.id)}">Edit</button><button type="button" class="linkish" data-drop-template="${esc(t.id)}">Delete</button></div>`).join("") : `<p class="field-hint">No templates yet.</p>`}</div>
    <button type="button" class="ghost" id="template-new">New template</button>`;
  body.querySelector("#template-new").onclick = () => { editingTemplate = { id: "", name: "", subject: "", html: "" }; render(); };
  body.querySelectorAll("[data-edit-template]").forEach(btn => { btn.onclick = () => { editingTemplate = list.find(t => t.id === btn.dataset.editTemplate) || null; render(); }; });
  body.querySelectorAll("[data-drop-template]").forEach(btn => {
    btn.onclick = () => {
      const t = list.find(x => x.id === btn.dataset.dropTemplate);
      if (!t || !window.confirm("Delete the template " + t.name + "?")) return;
      saveTemplates(list.filter(x => x.id !== t.id));
      render();
    };
  });
}

function renderMailSettings(body) {
  body.innerHTML = `
    <p class="field-hint">After Send, the message waits in Outbox. Undo brings it back as a draft. When the delay ends, it is sent and filed in Sent. Set this to 0 to send straight away. The delay stays on this computer.</p>
    <form id="send-delay-form">
      <label class="field">Send delay
        <span class="client-id-row">
          <input id="send-delay" name="delay" inputmode="numeric" aria-label="Send delay in seconds" autocomplete="off" spellcheck="false" value="${sendDelay}">
          <button class="ghost" type="submit" id="save-send-delay">Save</button>
        </span>
        <span class="field-hint">Seconds.</span>
      </label>
      <p class="form-error" id="send-delay-error" hidden></p>
    </form>
    <section class="notify-setting">
      <h2>Meeting invites</h2>
      <label class="check-row"><input type="checkbox" id="tidy-invites"${tidyInvites ? " checked" : ""}> After answering an invite, move it to Deleted Items</label>
      <p class="field-hint">As Outlook does. The meeting stays on your calendar.</p>
    </section>
    <section class="notify-setting">
      <h2>Focused Inbox</h2>
      <label class="check-row"><input type="checkbox" id="focused-on"${focusedInbox ? " checked" : ""}> Sort my Inbox into Focused and Other</label>
      <p class="field-hint">Microsoft sorts it, as in Outlook; for a Google account, Other is Gmail's Promotions, Social, Updates and Forums tabs. New-mail alerts are for Focused only.</p>
    </section>
    <section class="notify-setting" id="spelling-setting">
      <h2>Spelling</h2>
      <label class="check-row"><input type="checkbox" id="spell-on"${spellingPref().enabled ? " checked" : ""}> Check spelling as I type</label>
      <label class="check-row"><input type="checkbox" id="spell-send"${spellingPref().beforeSend ? " checked" : ""}> Check spelling before sending</label>
      <label class="field">Language
        <select id="spell-lang" aria-label="Spelling language"><option>Loading…</option></select>
      </label>
      <p class="field-hint" id="spell-note">Right-click a word underlined in red to choose a correction.</p>
    </section>
    <section class="notify-setting">
      <h2>Message list</h2>
      <label class="field">Density
        <select id="list-density">
          <option value="comfortable"${listDensity === "comfortable" ? " selected" : ""}>Comfortable</option>
          <option value="compact"${listDensity === "compact" ? " selected" : ""}>Compact</option>
        </select>
        <span class="field-hint">Compact shows two lines a message and a paperclip for attachments, so about twice as many fit.</span>
      </label>
    </section>
    <section class="notify-setting">
      <h2>Reading text</h2>
      <label class="field">Size
        <select id="read-size">
          <option value="comfortable"${readSize === "comfortable" ? " selected" : ""}>Comfortable</option>
          <option value="compact"${readSize === "compact" ? " selected" : ""}>Compact</option>
        </select>
        <span class="field-hint">Compact shows mail text at 14 px, close to Outlook, so more fits on screen.</span>
      </label>
    </section>
    <section class="notify-setting">
      <h2>New mail</h2>
      <label class="field">Check for new mail
        <select id="poll-minutes">${POLL_CHOICES.map(n => `<option value="${n}"${n === pollMinutes ? " selected" : ""}>${pollLabel(n)}</option>`).join("")}</select>
        <span class="field-hint">While Mailroom is open. The refresh button above the message list, or F5, checks straight away.</span>
      </label>
      <label class="check-row"><input type="checkbox" id="notify-new-mail"${notifyNewMail ? " checked" : ""}> Show a desktop notification for new mail in the Inbox</label>
      <p class="field-hint">Notifications appear only when the window is not in front.</p>
    </section>
    <section class="sync-window">
      <h2>Sync</h2>
      <p class="field-hint">How much is kept on this computer. Search deeper still finds older mail on the server.</p>
      <form id="sync-window-form">
        <label class="field">Mail to keep
          <input id="mail-sync-days" name="mailDays" inputmode="numeric" aria-label="Days of mail to keep" autocomplete="off" spellcheck="false" value="${mailSyncDays}">
          <span class="field-hint">Days of mail. 365 is a year. A busy folder keeps its newest 1,000 messages.</span>
        </label>
        <label class="field">Calendar back
          <input id="cal-sync-back" name="calBack" inputmode="numeric" aria-label="Days of past calendar to keep" autocomplete="off" spellcheck="false" value="${calSyncBack}">
          <span class="field-hint">Days of past events.</span>
        </label>
        <label class="field">Calendar ahead
          <span class="client-id-row">
            <input id="cal-sync-ahead" name="calAhead" inputmode="numeric" aria-label="Days of future calendar to keep" autocomplete="off" spellcheck="false" value="${calSyncAhead}">
            <button class="ghost" type="submit" id="save-sync-window">Save</button>
          </span>
          <span class="field-hint">Days of future events.</span>
        </label>
        <p class="form-error" id="sync-window-error" hidden></p>
      </form>
    </section>
  `;
  bindSpellingSetting(body);
  const focusBox = body.querySelector("#focused-on");
  if (focusBox) focusBox.onchange = () => {
    focusedInbox = focusBox.checked;
    try { localStorage.setItem("mailroom-focused", focusedInbox ? "on" : "off"); } catch (e) {}
    focusTab = "focused";
  };
  const tidyBox = body.querySelector("#tidy-invites");
  tidyBox.onchange = () => {
    tidyInvites = tidyBox.checked;
    try { localStorage.setItem("mailroom-tidy-invites", tidyInvites ? "on" : "off"); } catch (e) {}
  };
  const densitySelect = body.querySelector("#list-density");
  densitySelect.onchange = () => {
    listDensity = densitySelect.value === "compact" ? "compact" : "comfortable";
    document.body.dataset.listDensity = listDensity;
    try { localStorage.setItem("mailroom-list-density", listDensity); } catch (e) {}
    toast(listDensity === "compact" ? "Compact message list" : "Comfortable message list");
  };
  const readSelect = body.querySelector("#read-size");
  readSelect.onchange = () => {
    readSize = readSelect.value === "compact" ? "compact" : "comfortable";
    document.body.dataset.readSize = readSize;
    try { localStorage.setItem("mailroom-read-size", readSize); } catch (e) {}
    toast(readSize === "compact" ? "Compact reading text" : "Comfortable reading text");
  };
  const pollSelect = body.querySelector("#poll-minutes");
  pollSelect.onchange = () => {
    pollMinutes = Number(pollSelect.value);
    try { localStorage.setItem("mailroom-poll-minutes", String(pollMinutes)); } catch (e) {}
    if (inDesktop() && !popCompose && !assistWindow) armMailPolling();
    toast(pollLabel(pollMinutes));
  };
  const notifyBox = body.querySelector("#notify-new-mail");
  notifyBox.onchange = () => {
    notifyNewMail = notifyBox.checked;
    try { localStorage.setItem("mailroom-notify", notifyNewMail ? "on" : "off"); } catch (e) {}
    toast(notifyNewMail ? "Notifications on" : "Notifications off");
  };
  const input = body.querySelector("#send-delay");
  const button = body.querySelector("#save-send-delay");
  const note = body.querySelector("#send-delay-error");
  function paint() {
    const same = input.value.trim() === String(sendDelay) && !sendDelayError(input.value);
    button.disabled = same;
    button.textContent = same ? "Saved" : "Save";
  }
  input.addEventListener("input", () => {
    note.hidden = true;
    paint();
  });
  paint();
  body.querySelector("#send-delay-form").onsubmit = (e) => {
    e.preventDefault();
    const problem = sendDelayError(input.value);
    if (problem) {
      note.hidden = false;
      note.textContent = problem;
      button.disabled = false;
      button.textContent = "Save";
      return;
    }
    rememberSendDelay(Number(input.value.trim()));
    input.value = String(sendDelay);
    note.hidden = true;
    paint();
    toast("Send delay saved");
  };
  const mailDays = body.querySelector("#mail-sync-days");
  const backDays = body.querySelector("#cal-sync-back");
  const aheadDays = body.querySelector("#cal-sync-ahead");
  const saveWindow = body.querySelector("#save-sync-window");
  const windowNote = body.querySelector("#sync-window-error");
  function paintWindow() {
    const mail = syncDaysError(mailDays.value) ? null : Number(mailDays.value.trim());
    const back = syncDaysError(backDays.value) ? null : Number(backDays.value.trim());
    const ahead = syncDaysError(aheadDays.value) ? null : Number(aheadDays.value.trim());
    const same = mail === mailSyncDays && back === calSyncBack && ahead === calSyncAhead;
    saveWindow.disabled = same;
    saveWindow.textContent = same ? "Saved" : "Save";
  }
  [mailDays, backDays, aheadDays].forEach(field => {
    field.addEventListener("input", () => {
      windowNote.hidden = true;
      paintWindow();
    });
  });
  paintWindow();
  body.querySelector("#sync-window-form").onsubmit = (e) => {
    e.preventDefault();
    const problem = syncDaysError(mailDays.value) || syncDaysError(backDays.value) || syncDaysError(aheadDays.value);
    if (problem) {
      windowNote.hidden = false;
      windowNote.textContent = problem;
      saveWindow.disabled = false;
      saveWindow.textContent = "Save";
      return;
    }
    rememberSyncWindow(Number(mailDays.value.trim()), Number(backDays.value.trim()), Number(aheadDays.value.trim()));
    mailDays.value = String(mailSyncDays);
    backDays.value = String(calSyncBack);
    aheadDays.value = String(calSyncAhead);
    windowNote.hidden = true;
    paintWindow();
    toast("Sync window saved");
  };
}

let aiKeys = { grok: false, claude: false, grokAdded: "", claudeAdded: "" };

function applyAiStatus(status) {
  if (!status) return;
  aiKeys = {
    grok: !!status.grok,
    claude: !!status.claude,
    grokAdded: status.grok && status.grokAdded ? String(status.grokAdded) : "",
    claudeAdded: status.claude && status.claudeAdded ? String(status.claudeAdded) : ""
  };
  // With only one assistant set up, that is the one to use.
  if (!aiKeys[aiProvider] && aiKeys[aiProvider === "claude" ? "grok" : "claude"]) aiProvider = aiProvider === "claude" ? "grok" : "claude";
  paintAssistantButtons();
}

// The assistant's buttons — the main window's top bar, the compose
// formatting bar and the short reply's bar — show once a key is saved.
function aiConfigured() {
  return inDesktop() && !!(aiKeys.grok || aiKeys.claude);
}

function assistantButtonHtml(extraClass) {
  return `<button class="assistant-btn${extraClass ? " " + extraClass : ""}" type="button" id="help-write" data-assistant-btn${aiConfigured() ? "" : " hidden"} tabindex="-1" title="Help me write" aria-expanded="${document.body.dataset.assist === "open" ? "true" : "false"}" aria-label="Help me write with ${assistantName(aiProvider)}">${assistantLogo(aiProvider)}</button>`;
}

function paintAssistantButtons() {
  const on = aiConfigured();
  document.querySelectorAll("[data-assistant-btn]").forEach(btn => {
    btn.hidden = !on;
    btn.setAttribute("aria-label", "Help me write with " + assistantName(aiProvider));
    btn.title = "Help me write with " + assistantName(aiProvider);
    btn.innerHTML = assistantLogo(aiProvider);
  });
}

function assistantAddedText(iso) {
  const date = new Date(iso || "");
  if (!iso || Number.isNaN(date.getTime())) return "";
  const hm = String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
  return "Added " + date.getDate() + " " + monthNames[date.getMonth()] + " " + date.getFullYear() + " at " + hm;
}

function assistantSavedCopy(provider) {
  const iso = provider === "claude" ? aiKeys.claudeAdded : aiKeys.grokAdded;
  return assistantAddedText(iso) || "Saved on this computer.";
}
let aiProvider = "grok";
let askAnswer = "";
// Ask across mail (2026-10-23): the question, kept apart from the search
// words, and what the ask is doing while it gathers.
let askQuestion = "";
let askStatus = "";
const ASK_LIMIT = 100;
let askBusy = false;
let askSerial = 0;
let askedQuery = "";
let assistTurns = [];
let assistBusy = false;
let assistSerial = 0;

function loadAiProvider() {
  try {
    const saved = localStorage.getItem("mailroom-ai-provider");
    if (saved === "claude" || saved === "grok") aiProvider = saved;
  } catch (e) {}
}
loadAiProvider();

function rememberAiProvider(provider) {
  if (provider !== "grok" && provider !== "claude") return;
  aiProvider = provider;
  try { localStorage.setItem("mailroom-ai-provider", provider); } catch (e) {}
  // Every button and the panel's title show the one now chosen.
  paintAssistantButtons();
  const title = document.getElementById("assist-title");
  if (title && document.body.dataset.assist === "open") title.innerHTML = assistantLogo(aiProvider) + "<span>" + esc(assistantName(aiProvider)) + "</span>";
}

function assistantName(provider) {
  return provider === "claude" ? "Claude" : "Grok";
}

function grokLogo(size) {
  const n = size || 16;
  return `<svg width="${n}" height="${n}" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"/></svg>`;
}

function claudeLogo(size) {
  const n = size || 16;
  return `<svg width="${n}" height="${n}" viewBox="0 0 24 24" aria-hidden="true"><path fill="#D97757" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>`;
}

function assistantLogo(provider, size) {
  return provider === "claude" ? claudeLogo(size) : grokLogo(size);
}

function plainMail(m, max) {
  const raw = String(m.body || "").trim();
  const html = raw && !raw.includes("<") ? "" : String(m.bodyHtml || m.body || "");
  const text = html
    ? html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
    : raw;
  return (text || String(m.preview || "").trim()).slice(0, max || 1500);
}

function mailExcerpt(m) {
  return {
    from: m.from || "",
    email: m.email || "",
    date: [m.date, m.time].filter(Boolean).join(" "),
    subject: m.subject || "",
    body: plainMail(m)
  };
}

function plainToParagraphs(text) {
  const parts = String(text || "").trim().split(/\n{2,}/).filter(part => part.trim());
  if (!parts.length) return "<p><br></p>";
  return parts.map(part => "<p>" + esc(part).replace(/\n/g, "<br>") + "</p>").join("");
}

function askSources() {
  const matched = filtered().filter(m => !m.draft && !m.pendingSend);
  const pool = matched.length ? matched : messages.filter(m => inSearchScope(m) && !m.draft && !m.pendingSend);
  return pool.slice().sort((a, b) => (b.seq || 0) - (a.seq || 0)).slice(0, 20);
}

// The empty reading pane: an outline envelope in the muted text colour.
const EMPTY_MARK = `<svg class="empty-mark" aria-hidden="true" viewBox="0 0 64 64">
<rect x="8" y="16" width="48" height="34" rx="5" fill="none" stroke="currentColor" stroke-width="2.5"/>
<path d="M10 19 L32 36 L54 19" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function emptyReadingHtml() {
  return `<div class="empty empty-reading">${EMPTY_MARK}<p class="empty-title">Select a message to read</p></div>`;
}

function askCardHtml() {
  if (!askAnswer) return "";
  return `<div class="ask-card" id="ask-card"><div class="ask-card-bar"><span>Answer</span><button type="button" class="linkish" id="ask-dismiss">Close</button></div><div class="ask-copy">${esc(askAnswer)}</div></div>`;
}

function bindAskCard() {
  const btn = document.getElementById("ask-dismiss");
  if (btn) btn.onclick = () => { askAnswer = ""; render(); };
}

function syncAskQuery() {
  const next = query.trim();
  if (next === askedQuery) return;
  askedQuery = next;
  askSerial += 1;
  askBusy = false;
  askAnswer = "";
}

function askBarHtml() {
  if (!query.trim()) return "";
  const wide = deeperTargets().length > 0;
  const note = askBusy ? (askStatus || "Asking…")
    : wide ? "Ask about everything that matches in every folder, on Microsoft's server too, with the text of PDF attachments."
    : "Ask about the mail already on this computer.";
  const pick = provider => aiKeys[provider] || !(aiKeys.grok || aiKeys.claude);
  const options = ["claude", "grok"].filter(pick).map(p => `<option value="${p}"${aiProvider === p ? " selected" : ""}>${assistantName(p)}</option>`).join("");
  return `<div class="deeper ask-bar" id="ask-bar"><p id="ask-note">${esc(note)}</p><div class="ask-row"><input id="ask-question" type="text" autocomplete="off" placeholder="Your question — e.g. How much did I spend in total?" value="${esc(askQuestion)}"${askBusy ? " disabled" : ""} aria-label="Question about these results"><select id="ask-provider" aria-label="Assistant"${askBusy ? " disabled" : ""}>${options}</select><button type="button" id="ask-mail"${askBusy ? " disabled" : ""}>Ask</button></div></div>`;
}

function paintAsk() {
  const old = document.getElementById("ask-bar");
  if (old) old.remove();
  const html = askBarHtml();
  if (!html) return;
  const anchor = document.getElementById("search-deeper-bar") || document.getElementById("search-summary");
  if (anchor) anchor.insertAdjacentHTML("afterend", html);
  const select = document.getElementById("ask-provider");
  if (select) select.onchange = () => rememberAiProvider(select.value);
  const btn = document.getElementById("ask-mail");
  if (btn) btn.onclick = () => askAboutMail();
  const field = document.getElementById("ask-question");
  if (field) {
    field.oninput = () => { askQuestion = field.value; };
    field.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); askAboutMail(); } };
  }
}

function setAskStatus(text) {
  askStatus = text;
  const note = document.getElementById("ask-note");
  if (note) note.textContent = text;
}

// Everything that matches the search, from Microsoft's search (bodies
// included, every folder in scope, older mail too), newest first, up to the
// limit; then matches on this computer the server didn't return. With the
// count of what was left out.
async function gatherAskMail(serial) {
  const seen = new Set();
  const found = [];
  let more = false;
  const q = serverSearchQuery();
  // Every folder of the accounts in scope: "all my mail with them" means
  // Inbox, Archive and the rest, whichever folder is open.
  const seenAccounts = new Set();
  const everywhere = deeperTargets().filter(t => !seenAccounts.has(t.id) && seenAccounts.add(t.id)).map(t => ({ ...t, folderId: "" }));
  for (const target of everywhere) {
    let next = "";
    do {
      const page = await tauriInvoke("search_mail", {
        email: target.email, query: q, folderId: target.folderId, folder_id: target.folderId,
        from: searchFrom, to: searchTo, files: searchFiles, nextLink: next, next_link: next
      });
      if (serial !== askSerial) return null;
      ((page && page.messages) || []).forEach(item => {
        if (!item || !item.id || seen.has(item.id)) return;
        seen.add(item.id);
        found.push({ account: target.id, email: target.email, item });
      });
      next = String((page && (page.nextLink || page.next_link)) || "");
      setAskStatus("Searching… " + found.length + " found");
      if (found.length >= ASK_LIMIT && next) more = true;
    } while (next && found.length < ASK_LIMIT * 2);
  }
  const local = filtered().filter(m => !m.draft && !m.pendingSend && !seen.has(m.id) && (m.bodyHtml || m.body));
  const rows = found.map(f => ({
    id: f.item.id, account: f.account, email: f.email, hasFiles: !!f.item.hasAttachments,
    seq: Date.parse(f.item.received) || 0,
    note: { from: f.item.fromName || "", email: f.item.fromEmail || "", date: String(f.item.received || "").slice(0, 10), subject: f.item.subject || "", body: plainMail({ body: "", bodyHtml: f.item.bodyHtml || "", preview: f.item.preview || "" }, 60000) }
  })).concat(local.map(m => ({
    id: m.id, account: m.account, email: (accounts[m.account] || {}).email || "", hasFiles: messageHasFile(m) && serverMessage(m),
    seq: m.seq || 0,
    note: { from: m.from || "", email: m.email || "", date: [m.date, m.time].filter(Boolean).join(" "), subject: m.subject || "", body: plainMail(m, 60000) }
  })));
  rows.sort((a, b) => b.seq - a.seq);
  const kept = rows.slice(0, ASK_LIMIT);
  return { rows: kept, omitted: Math.max(0, rows.length - kept.length), more };
}

// The text of the PDFs on the gathered messages, read on this computer.
async function readAskPdfs(rows, serial) {
  const byEmail = new Map();
  rows.filter(r => r.hasFiles && r.email).forEach(r => {
    if (!byEmail.has(r.email)) byEmail.set(r.email, []);
    byEmail.get(r.email).push(r.id);
  });
  if (!byEmail.size) return { read: 0, unreadable: 0 };
  let read = 0, unreadable = 0;
  setAskStatus("Reading PDF attachments…");
  for (const [email, ids] of byEmail) {
    let texts = [];
    try { texts = await tauriInvoke("pdf_texts", { email, messageIds: ids, message_ids: ids }) || []; } catch (e) { texts = []; }
    if (serial !== askSerial) return null;
    texts.forEach(t => {
      const row = rows.find(r => r.id === (t.messageId || t.message_id));
      if (!row) return;
      if (t.unreadable) { unreadable += 1; return; }
      read += 1;
      row.note.attachments = (row.note.attachments ? row.note.attachments + "\n" : "") + "[" + (t.name || "PDF") + "]\n" + t.text;
    });
  }
  return { read, unreadable };
}

async function refreshAiKeys() {
  if (!inDesktop()) return;
  try {
    const status = await tauriInvoke("ai_status");
    applyAiStatus(status);
  } catch (e) {}
}

async function askAboutMail() {
  if (!query.trim()) return;
  if (!inDesktop()) {
    toast("Ask works in the desktop app.");
    return;
  }
  const provider = document.getElementById("ask-provider") ? document.getElementById("ask-provider").value : aiProvider;
  rememberAiProvider(provider);
  const serial = ++askSerial;
  askBusy = true;
  askAnswer = "";
  renderList();
  try {
    const status = await tauriInvoke("ai_status");
    if (serial !== askSerial) return;
    applyAiStatus(status);
    if (!aiKeys[provider]) {
      toast(provider === "claude" ? "Save a Claude key in Settings." : "Save a Grok key in Settings.");
      return;
    }
    const question = (askQuestion.trim() || query.trim());
    let notes, omitted = 0, pdfs = { read: 0, unreadable: 0 };
    if (deeperTargets().length) {
      const gathered = await gatherAskMail(serial);
      if (!gathered || serial !== askSerial) return;
      if (!gathered.rows.length) {
        toast("Nothing matched that search.");
        return;
      }
      pdfs = await readAskPdfs(gathered.rows, serial);
      if (!pdfs || serial !== askSerial) return;
      notes = gathered.rows.map(r => r.note);
      omitted = gathered.omitted;
    } else {
      const sources = askSources();
      if (!sources.length) {
        toast("There is no mail on this computer to ask about.");
        return;
      }
      notes = sources.map(mailExcerpt);
    }
    setAskStatus("Asking " + assistantName(provider) + " about " + notes.length + (notes.length === 1 ? " message" : " messages") + "…");
    const result = await tauriInvoke("ask_mail", { provider, question, messages: notes, omitted });
    if (serial !== askSerial) return;
    const text = String(result && result.text || "").trim();
    const bits = [notes.length + (notes.length === 1 ? " message" : " messages")];
    if (pdfs.read) bits.push(pdfs.read + (pdfs.read === 1 ? " PDF" : " PDFs"));
    if (pdfs.unreadable) bits.push(pdfs.unreadable + " PDF" + (pdfs.unreadable === 1 ? "" : "s") + " couldn't be read (scanned or locked)");
    if (omitted) bits.push(omitted + " older matches not read (" + ASK_LIMIT + " at most)");
    askAnswer = text ? text + "\n\nFrom " + bits.join(" · ") + "." : "";
    if (!askAnswer) toast("No answer came back.");
  } catch (err) {
    if (serial !== askSerial) return;
    toast(String(err && (err.message || err) || "Ask did not finish."));
  } finally {
    if (serial === askSerial) {
      askBusy = false;
      askStatus = "";
      if (view === "mail") render();
    }
  }
}

function assistOwner() {
  if (assistWindow) return params.get("owner") === "compose" ? "compose" : "main";
  return document.body.dataset.compose === "pop" ? "compose" : "main";
}

function assistPopped() {
  try { return !!localStorage.getItem("mailroom-assist-pop"); } catch (e) { return false; }
}

function loadAssistTurns() {
  assistTurns = [];
  try {
    const saved = JSON.parse(localStorage.getItem("mailroom-assist") || "");
    if (!saved || !Array.isArray(saved.turns)) return;
    assistTurns = saved.turns.filter(turn => turn && (turn.role === "user" || turn.role === "assistant") && String(turn.text || "").trim()).slice(-24).map(turn => ({
      role: turn.role,
      text: String(turn.text)
    }));
  } catch (e) {}
}

function saveAssistTurns() {
  try { localStorage.setItem("mailroom-assist", JSON.stringify({ turns: assistTurns.slice(-24) })); } catch (e) {}
}

function readFormContext(form) {
  const body = form.querySelector("#compose-body");
  let draft = "";
  if (body) {
    ensureWriteArea(body);
    const write = body.querySelector(".body-write") || body;
    draft = String(write.innerText || "").replace(/\u00a0/g, " ").trim();
  }
  const subject = (form.querySelector("#compose-subject") || {}).value || "";
  const to = (form.querySelector("#compose-to") || {}).value || "";
  const thread = form.dataset.kind === "reply" ? historyMessages(form.dataset.msg || "").slice(0, 20).map(mailExcerpt) : [];
  return { to: String(to).trim(), subject: String(subject).trim(), draft, thread };
}

function assistContext() {
  if (assistWindow) {
    try {
      const saved = JSON.parse(localStorage.getItem("mailroom-assist-context") || "");
      if (saved && saved.owner === assistOwner()) {
        return {
          to: String(saved.to || ""),
          subject: String(saved.subject || ""),
          draft: String(saved.draft || ""),
          thread: Array.isArray(saved.thread) ? saved.thread : []
        };
      }
    } catch (e) {}
    return { to: "", subject: "", draft: "", thread: [] };
  }
  const form = document.getElementById("compose-form");
  if (!form) return { to: "", subject: "", draft: "", thread: [] };
  return readFormContext(form);
}

function publishAssistContext() {
  if (assistWindow) return;
  const form = document.getElementById("compose-form");
  if (!form) return;
  const ctx = readFormContext(form);
  ctx.owner = assistOwner();
  try { localStorage.setItem("mailroom-assist-context", JSON.stringify(ctx)); } catch (e) {}
}

function assistLogHtml() {
  if (!assistTurns.length && !assistBusy) {
    return `<div class="assist-empty"><p>What do you need help with?</p><p>Ask for a draft, a rewrite, or a shorter reply. Nothing is sent until you press Send on the message.</p></div>`;
  }
  const turns = assistTurns.map((turn, index) => {
    if (turn.role === "user") return `<div class="assist-turn user">${esc(turn.text)}</div>`;
    return `<div class="assist-turn assistant"><div>${esc(turn.text)}</div><button type="button" class="assist-insert" data-assist-insert="${index}">Insert</button></div>`;
  }).join("");
  return turns + (assistBusy ? `<div class="assist-turn assistant pending">Writing…</div>` : "");
}

function paintAssistChrome() {
  const title = document.getElementById("assist-title");
  if (title) title.innerHTML = assistantLogo(aiProvider) + "<span>" + esc(assistantName(aiProvider)) + "</span>";
  const pop = document.getElementById("assist-pop");
  if (pop) pop.hidden = !!assistWindow;
  const panel = document.getElementById("assist");
  if (panel) panel.setAttribute("aria-busy", assistBusy ? "true" : "false");
  const send = document.getElementById("assist-send");
  if (send) send.disabled = assistBusy;
}

function paintAssistLog() {
  const log = document.getElementById("assist-log");
  if (!log) return;
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.innerHTML = assistLogHtml();
  if (stick) log.scrollTop = log.scrollHeight;
}

function paintAssist() {
  paintAssistChrome();
  paintAssistLog();
}

function markHelpExpanded(open) {
  document.querySelectorAll("#help-write, #assist-top").forEach(btn => btn.setAttribute("aria-expanded", open ? "true" : "false"));
}

function closeAssist() {
  if (assistWindow) return;
  delete document.body.dataset.assist;
  markHelpExpanded(false);
}

function assistQuery() {
  return "assist=1&owner=" + assistOwner() + "&d=" + Date.now();
}

async function focusAssistWindow() {
  publishAssistContext();
  const query = assistQuery();
  if (inDesktop()) {
    try {
      const pending = tauriInvoke("pop_assist", { query });
      if (!pending || !pending.then) {
        try { localStorage.removeItem("mailroom-assist-pop"); } catch (err) {}
        toast("Could not pop out");
        return;
      }
      await pending;
    } catch (e) {
      try { localStorage.removeItem("mailroom-assist-pop"); } catch (err) {}
      toast("Could not pop out");
    }
    return;
  }
  const base = location.href.split("?")[0];
  const child = window.open(base + "?" + query, "mailroom-assist", "popup=yes,width=420,height=720");
  if (child) child.focus();
  else {
    try { localStorage.removeItem("mailroom-assist-pop"); } catch (err) {}
    toast("Could not pop out");
  }
}

async function popAssist() {
  if (assistWindow) return;
  publishAssistContext();
  saveAssistTurns();
  const owner = assistOwner();
  try { localStorage.setItem("mailroom-assist-pop", owner); } catch (e) {}
  const query = assistQuery();
  if (inDesktop()) {
    try {
      const pending = tauriInvoke("pop_assist", { query });
      if (!pending || !pending.then) {
        try { localStorage.removeItem("mailroom-assist-pop"); } catch (err) {}
        toast("Could not pop out");
        return;
      }
      await pending;
    } catch (e) {
      try { localStorage.removeItem("mailroom-assist-pop"); } catch (err) {}
      toast("Could not pop out");
      return;
    }
  } else {
    const base = location.href.split("?")[0];
    const child = window.open(base + "?" + query, "mailroom-assist", "popup=yes,width=420,height=720");
    if (!child) {
      try { localStorage.removeItem("mailroom-assist-pop"); } catch (err) {}
      toast("Could not pop out");
      return;
    }
  }
  closeAssist();
}

{
  const topAssist = document.getElementById("assist-top");
  if (topAssist) topAssist.onclick = () => openAssist();
}

function openAssist() {
  if (assistWindow) {
    const input = document.getElementById("assist-input");
    if (input) input.focus();
    return;
  }
  if (assistPopped()) {
    focusAssistWindow();
    return;
  }
  if (document.body.dataset.assist === "open") {
    closeAssist();
    return;
  }
  document.body.dataset.assist = "open";
  markHelpExpanded(true);
  paintAssist();
  publishAssistContext();
  const input = document.getElementById("assist-input");
  if (input) input.focus();
}

function insertAssistText(text, quiet) {
  const clean = String(text || "").trim();
  if (!clean) return false;
  const form = document.getElementById("compose-form");
  if (!form) {
    if (!quiet) toast("Open a message to insert this.");
    return false;
  }
  const body = form.querySelector("#compose-body");
  if (!body) return false;
  ensureWriteArea(body);
  const write = body.querySelector(".body-write") || body;
  write.innerHTML = plainToParagraphs(clean);
  body.dispatchEvent(new Event("input", { bubbles: true }));
  if (!quiet) toast("Inserted into the message.");
  return true;
}

function requestAssistInsert(text) {
  const clean = String(text || "").trim();
  if (!clean) return;
  if (!assistWindow) {
    insertAssistText(clean, false);
    return;
  }
  const stamp = Date.now();
  try {
    localStorage.setItem("mailroom-assist-insert", JSON.stringify({ text: clean, owner: assistOwner(), stamp }));
  } catch (e) {
    toast("Open a message to insert this.");
    return;
  }
  let settled = false;
  const finish = (ok) => {
    if (settled) return;
    settled = true;
    window.removeEventListener("storage", wait);
    toast(ok ? "Inserted into the message." : "Open a message to insert this.");
  };
  function wait(ev) {
    if (!ev || ev.key !== "mailroom-assist-insert-result") return;
    let payload;
    try { payload = JSON.parse(ev.newValue || ""); } catch (err) { return; }
    if (!payload || payload.stamp !== stamp) return;
    finish(!!payload.ok);
  }
  window.addEventListener("storage", wait);
  setTimeout(() => finish(false), 800);
}

function onAssistInsert(raw) {
  if (assistWindow) return;
  let payload;
  try { payload = JSON.parse(raw || ""); } catch (e) { return; }
  if (!payload || payload.owner !== assistOwner()) return;
  const ok = insertAssistText(payload.text, true);
  try {
    localStorage.setItem("mailroom-assist-insert-result", JSON.stringify({ stamp: payload.stamp, ok: !!ok }));
  } catch (e) {}
}

async function sendAssistTurn(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || assistBusy) return;
  if (!inDesktop()) {
    toast("Help me write works in the desktop app.");
    return;
  }
  const provider = aiProvider === "claude" ? "claude" : "grok";
  const serial = ++assistSerial;
  assistBusy = true;
  paintAssist();
  try {
    const status = await tauriInvoke("ai_status");
    if (serial !== assistSerial) return;
    applyAiStatus(status);
    if (!aiKeys[provider]) {
      toast(provider === "claude" ? "Save a Claude key in Settings." : "Save a Grok key in Settings.");
      return;
    }
    assistTurns.push({ role: "user", text: trimmed });
    if (assistTurns.length > 24) assistTurns = assistTurns.slice(-24);
    saveAssistTurns();
    const field = document.getElementById("assist-input");
    if (field) field.value = "";
    paintAssist();
    publishAssistContext();
    const ctx = assistContext();
    const result = await tauriInvoke("assist_mail", {
      provider,
      turns: assistTurns.map(turn => ({ role: turn.role, text: turn.text })),
      to: ctx.to || "",
      subject: ctx.subject || "",
      draft: ctx.draft || "",
      thread: Array.isArray(ctx.thread) ? ctx.thread : []
    });
    if (serial !== assistSerial) return;
    const reply = String(result && result.text || "").trim();
    if (!reply) {
      toast("No answer came back.");
      return;
    }
    assistTurns.push({ role: "assistant", text: reply });
    if (assistTurns.length > 24) assistTurns = assistTurns.slice(-24);
    saveAssistTurns();
  } catch (err) {
    if (serial !== assistSerial) return;
    toast(String(err && (err.message || err) || "Help me write did not finish."));
  } finally {
    if (serial === assistSerial) {
      assistBusy = false;
      paintAssist();
    }
  }
}

function bindAssist() {
  loadAssistTurns();
  paintAssist();
  const form = document.getElementById("assist-form");
  const input = document.getElementById("assist-input");
  const pop = document.getElementById("assist-pop");
  const close = document.getElementById("assist-close");
  if (pop) pop.onclick = () => popAssist();
  if (close) close.onclick = () => {
    if (assistWindow) closeComposeWindow();
    else closeAssist();
  };
  if (form) form.onsubmit = (ev) => {
    ev.preventDefault();
    const field = document.getElementById("assist-input");
    sendAssistTurn(field ? field.value : "");
  };
  if (input) input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      if (form) form.requestSubmit();
    }
  });
  const log = document.getElementById("assist-log");
  if (log) log.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-assist-insert]");
    if (!btn) return;
    const turn = assistTurns[Number(btn.dataset.assistInsert)];
    if (turn && turn.role === "assistant") requestAssistInsert(turn.text);
  });
  if (assistWindow && input) input.focus();
}

function assistantField(provider, label, hint) {
  const saved = !!aiKeys[provider];
  return `<form id="${provider}-key-form">
      <label class="field">${label}
        <span class="client-id-row">
          <input id="${provider}-key" type="password" autocomplete="off" spellcheck="false" aria-label="${label} key">
          <button class="ghost" type="submit" id="save-${provider}-key">Save</button>
        </span>
        <span class="field-hint">${hint}</span>
      </label>
      <p class="form-error" id="${provider}-key-error" hidden></p>
    </form>
    <div class="key-added" id="${provider}-key-added"${saved ? "" : " hidden"}>
      <span id="${provider}-key-state">${esc(saved ? assistantSavedCopy(provider) : "")}</span>
      <button class="ghost" type="button" id="clear-${provider}-key">Remove</button>
    </div>
    <span class="field-hint" id="${provider}-key-missing"${saved ? " hidden" : ""}>Not saved.</span>`;
}

function paintAssistantState() {
  ["grok", "claude"].forEach(provider => {
    const saved = !!aiKeys[provider];
    const line = document.getElementById(provider + "-key-added");
    const state = document.getElementById(provider + "-key-state");
    const missing = document.getElementById(provider + "-key-missing");
    const input = document.getElementById(provider + "-key");
    const button = document.getElementById("save-" + provider + "-key");
    if (state) state.textContent = saved ? assistantSavedCopy(provider) : "";
    if (line) line.hidden = !saved;
    if (missing) missing.hidden = saved;
    if (button && input) button.disabled = !input.value.trim();
  });
}

function bindAssistantKey(provider, label) {
  const form = document.getElementById(provider + "-key-form");
  const input = document.getElementById(provider + "-key");
  const button = document.getElementById("save-" + provider + "-key");
  const note = document.getElementById(provider + "-key-error");
  const clear = document.getElementById("clear-" + provider + "-key");
  if (!form || !input) return;
  input.addEventListener("input", () => {
    if (note) note.hidden = true;
    if (button) button.disabled = !input.value.trim();
  });
  if (button) button.disabled = true;
  form.onsubmit = async (event) => {
    event.preventDefault();
    const key = input.value.trim();
    if (!key) {
      if (note) {
        note.hidden = false;
        note.textContent = "Enter a key.";
      }
      return;
    }
    if (!inDesktop()) {
      input.value = "";
      if (button) button.disabled = true;
      toast("API keys are saved in the desktop app.");
      return;
    }
    if (button) button.disabled = true;
    try {
      const status = await tauriInvoke("save_ai_key", { provider, key });
      input.value = "";
      applyAiStatus(status);
      if (note) note.hidden = true;
      paintAssistantState();
      toast(label + " key saved");
    } catch (err) {
      if (note) {
        note.hidden = false;
        note.textContent = String(err && (err.message || err) || "That key could not be saved.");
      }
      if (button) button.disabled = !input.value.trim();
    }
  };
  if (clear) clear.onclick = async () => {
    if (!confirm("Remove the " + label + " key from this computer?")) return;
    if (!inDesktop()) return;
    try {
      const status = await tauriInvoke("clear_ai_key", { provider });
      applyAiStatus(status);
      paintAssistantState();
      toast(label + " key removed");
    } catch (err) {
      toast(String(err && (err.message || err) || "That key could not be removed."));
    }
  };
}

function renderAssistants(body) {
  const pick = provider => `<button class="assistant-pick" type="button" data-ai="${provider}" aria-pressed="${aiProvider === provider}" aria-label="${assistantName(provider)}">${assistantLogo(provider, 18)}<span>${assistantName(provider)}</span></button>`;
  body.innerHTML = `
    <p class="field-hint">Help me write fills in a message for you to edit. Ask answers questions about mail already on this computer. Both send what they need to the provider you choose, xAI for Grok or Anthropic for Claude: your question or draft, and short excerpts of the messages involved. Nothing is sent until you use one. A key stays on this computer and is not shown again.</p>
    <div class="assistant-picks" role="radiogroup" aria-label="Assistant">
      ${pick("grok")}
      ${pick("claude")}
    </div>
    ${assistantField("grok", "Grok", "Paste a key from the xAI console. Uses grok-4.7.")}
    ${assistantField("claude", "Claude", "Paste a key from the Claude console. Uses claude-opus-5-5.")}
  `;
  body.querySelectorAll("[data-ai]").forEach(btn => {
    btn.onclick = () => {
      rememberAiProvider(btn.dataset.ai);
      body.querySelectorAll("[data-ai]").forEach(item => {
        item.setAttribute("aria-pressed", item === btn ? "true" : "false");
      });
    };
  });
  bindAssistantKey("grok", "Grok");
  bindAssistantKey("claude", "Claude");
  if (inDesktop()) {
    refreshAiKeys().then(() => {
      if (settingsPage === "assistants") paintAssistantState();
    });
  }
}

function renderSafeSenders(body) {
  const fixed = accountSafeSenders();
  const shared = publicAccountDomains();
  const rows = fixed.map(entry => `
    <div class="acct-card" data-account-sender="${esc(entry)}">
      <span class="acct-copy"><span class="who">${esc(String(entry).replace(/^@/, ""))}</span><span class="meta">Your account. Always safe.</span></span>
    </div>`).join("") + safeSenders.filter(entry => !fixed.includes(entry)).map(entry => `
    <div class="acct-card">
      <span class="acct-copy"><span class="who">${esc(String(entry).replace(/^@/, ""))}</span></span>
      <button class="ghost" type="button" data-remove-sender="${esc(entry)}">Remove</button>
    </div>`).join("");
  const sharedList = shared.length > 1 ? shared.slice(0, -1).join(", ") + " and " + shared[shared.length - 1] : shared[0] || "";
  const sharedNote = shared.length
    ? `<p class="field-hint" id="safe-sender-shared">${shared.length > 1 ? "Your own addresses at " + esc(sharedList) + " are" : "Your own address at " + esc(sharedList) + " is"} always safe. Other senders there are not, as anyone can have an address there.</p>`
    : "";
  const pictures = remotePictureMode();
  body.innerHTML = `
    <fieldset class="picture-choice">
      <legend>Pictures in messages</legend>
      <label><input type="radio" name="remote-pictures" value="never"${pictures === "never" ? " checked" : ""}> Never</label>
      <label><input type="radio" name="remote-pictures" value="safe"${pictures === "safe" ? " checked" : ""}> Safe senders only</label>
      <label><input type="radio" name="remote-pictures" value="always"${pictures === "always" ? " checked" : ""}> Always</label>
      <p class="field-hint">This computer only. A message can still show its pictures once.</p>
    </fieldset>
    <p class="field-hint">Remote content downloads automatically for these domains. Your accounts' domains are always on the list.</p>
    ${sharedNote}
    <form id="safe-sender-form" class="stack-row">
      <input id="safe-sender-input" name="sender" aria-label="Safe sender domain" placeholder="anthropic.com" autocomplete="off" spellcheck="false">
      <button class="primary" type="submit">Add</button>
    </form>
    <p class="form-error" id="safe-sender-error" hidden></p>
    ${rows ? `<div class="acct-cards">${rows}</div>` : `<p class="empty-accounts">No safe senders.</p>`}
  `;
  body.querySelectorAll("[name=remote-pictures]").forEach(input => {
    input.onchange = () => { if (input.checked) setRemotePictureMode(input.value); };
  });
  body.querySelector("#safe-sender-form").onsubmit = (ev) => {
    ev.preventDefault();
    const input = body.querySelector("#safe-sender-input");
    const key = input.value.trim().toLowerCase();
    const note = body.querySelector("#safe-sender-error");
    const stored = safeSenderKey(key);
    if (!addSafeSender(key)) {
      note.hidden = false;
      note.textContent = stored && accountSafeSenders().includes(stored) ? "That is one of your accounts, so it is always safe."
        : stored && safeSenders.includes(stored) ? "That domain is already listed." : "Enter a domain like anthropic.com.";
      return;
    }
    render();
  };
  body.querySelectorAll("[data-remove-sender]").forEach(btn => {
    btn.onclick = () => {
      removeSafeSender(btn.dataset.removeSender);
      render();
    };
  });
}

function htmlFragment(raw) {
  const marked = String(raw).match(/<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/i);
  if (marked) return marked[1].trim();
  const body = String(raw).match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return (body ? body[1] : String(raw)).trim();
}

function inviteMarkup(meeting, to) {
  if (!meeting) return "";
  const labels = ["Monday 12 October", "Tuesday 13 October", "Wednesday 14 October", "Thursday 15 October", "Friday 16 October", "Saturday 17 October", "Sunday 18 October"];
  const options = [0, 1, 2, 3, 4];
  if (meeting.day > 4 && meeting.day < labels.length) options.push(meeting.day);
  const who = addressList(to).map(recipientLabel);
  const note = meeting.source === "free"
    ? "Nothing in the thread names a time, so this is a free hour"
    : "Taken from this thread";
  return `<div class="invite compose-invite" id="compose-invite" data-source="${meeting.source === "free" ? "free" : "thread"}">
      <div class="invite-head"><span>Calendar invite</span><button type="button" class="linkish" id="invite-remove">Remove</button></div>
      <label class="field">Title<input id="invite-title" value="${esc(meeting.title || "")}"></label>
      <div class="invite-when">
        <label>Day<select id="invite-day">${options.map(d => `<option value="${d}"${Number(meeting.day) === d ? " selected" : ""}>${labels[d]}</option>`).join("")}</select></label>
        <label>Start<input id="invite-start" value="${fmt(meeting.start)}" inputmode="numeric" autocomplete="off"></label>
        <label>End<input id="invite-end" value="${fmt(meeting.end)}" inputmode="numeric" autocomplete="off"></label>
      </div>
      <label class="field">Where<input id="invite-where" value="${esc(meeting.where || "")}" placeholder="Add a place"></label>
      <p class="invite-who">${esc(note)}${who.length ? " · with " + who.join(", ") : ""}</p>
    </div>`;
}

// ---- Pictures: inline or attached, at Small, Medium, Large or Original ----
// Inline sizes are how wide the picture shows in the message; the pixels
// kept are twice that, so it stays sharp. Attached sizes are the longest edge.
const PICTURE_SIZES = {
  small: { label: "Small", inline: 240, attach: 640 },
  medium: { label: "Medium", inline: 480, attach: 1280 },
  large: { label: "Large", inline: 800, attach: 1920 },
  original: { label: "Original", inline: 0, attach: 0 }
};
// Microsoft takes about 3 MB of pictures in the message itself.
const INLINE_PICTURE_LIMIT = 2900000;
const pictureOriginals = new Map();

function isResizablePicture(type) {
  return /^image\/(jpeg|png|webp|bmp)$/i.test(String(type || ""));
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("That picture could not be read."));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function loadPicture(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("That picture could not be opened."));
    img.src = url;
  });
}

// A data URL of the picture with its longest edge at most `longest` pixels.
// PNG stays PNG (screenshots, transparency); everything else becomes JPEG.
async function scaledPicture(original, longest) {
  const img = await loadPicture(original.url);
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!isResizablePicture(original.type)) return { url: original.url, width: w, height: h, type: original.type };
  const scale = longest && Math.max(w, h) > longest ? longest / Math.max(w, h) : 1;
  if (scale === 1 && /^image\/(jpeg|png)$/i.test(original.type)) return { url: original.url, width: w, height: h, type: original.type };
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const pen = canvas.getContext("2d");
  const png = /png/i.test(original.type);
  if (!png) { pen.fillStyle = "#ffffff"; pen.fillRect(0, 0, canvas.width, canvas.height); }
  pen.imageSmoothingQuality = "high";
  pen.drawImage(img, 0, 0, canvas.width, canvas.height);
  const type = png ? "image/png" : "image/jpeg";
  return { url: canvas.toDataURL(type, 0.86), width: canvas.width, height: canvas.height, type };
}

function dataUrlBytes(url) {
  const text = String(url || "");
  const b64 = text.slice(text.indexOf(",") + 1);
  return Math.floor(b64.length * 3 / 4);
}

function dataUrlFile(url, name, type) {
  const b64 = url.slice(url.indexOf(",") + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  let fileName = name;
  if (type === "image/jpeg" && !/\.jpe?g$/i.test(name)) fileName = name.replace(/\.[^.]+$/, "") + ".jpg";
  return new File([bytes], fileName, { type });
}

function inlinePictureBytes(body) {
  return [...body.querySelectorAll("img")].reduce((sum, img) => sum + (/^data:/i.test(img.getAttribute("src") || "") ? dataUrlBytes(img.getAttribute("src")) : 0), 0);
}

// Redraw an inline picture at a size. Returns false if it would not fit.
async function sizeInlinePicture(img, size, body) {
  const id = img.dataset.pictureId;
  const original = pictureOriginals.get(id) || { url: img.getAttribute("src"), type: (img.getAttribute("src").match(/^data:([^;,]+)/) || [])[1] || "image/png" };
  const spec = PICTURE_SIZES[size] || PICTURE_SIZES.medium;
  const scaled = await scaledPicture(original, spec.inline * 2);
  const others = inlinePictureBytes(body) - (body.contains(img) ? dataUrlBytes(img.getAttribute("src")) : 0);
  if (others + dataUrlBytes(scaled.url) > INLINE_PICTURE_LIMIT) return false;
  img.src = scaled.url;
  img.dataset.size = size;
  const shown = spec.inline ? Math.min(spec.inline, scaled.width) : 0;
  if (shown) img.setAttribute("width", String(shown)); else img.removeAttribute("width");
  img.style.maxWidth = "100%";
  img.style.height = "auto";
  return true;
}

function pictureSizeBar(current, inline) {
  return `<div class="pic-size" role="group" aria-label="Picture size">${Object.entries(PICTURE_SIZES).map(([key, spec]) =>
    `<button type="button" data-pic-size="${key}" aria-pressed="${key === current}">${spec.label}</button>`).join("")}${inline ? `<button type="button" data-pic-remove title="Remove picture" aria-label="Remove picture">×</button>` : ""}</div>`;
}

function fileChips(names) {
  return (names || []).map(name => `<span class="file" data-name="${esc(name)}">${esc(name)}<button class="drop-file" type="button" data-drop-file aria-label="Remove ${esc(name)}">×</button></span>`).join("");
}

function historyMessages(msgId) {
  const msg = messages.find(m => m.id === msgId);
  if (!msg) return [];
  const target = msg.draft && msg.replyTo ? messages.find(m => m.id === msg.replyTo) : msg;
  if (!target || target.draft) return [];
  return messages
    .filter(item => item.thread === target.thread && !item.draft && item.seq <= target.seq)
    .sort((a, b) => b.seq - a.seq);
}

function historyWhen(m) {
  if (m.date && /^\d{4}-\d{2}-\d{2}$/.test(m.date)) {
    const parts = m.date.split("-").map(Number);
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const date = parts[2] + " " + months[parts[1] - 1] + " " + parts[0];
    if (m.time && /^\d/.test(m.time)) return date + " " + m.time;
    return m.time ? date + " · " + m.time : date;
  }
  return m.time || "";
}

function historyAddress(email, name) {
  const mail = String(email || "").trim();
  const label = String(name || "").trim();
  if (mail && label && label.toLowerCase() !== mail.toLowerCase()) return label + " <" + mail + ">";
  return mail || label;
}

function historyTo(m) {
  const own = ownAddresses();
  const fromSelf = own.has((m.email || "").toLowerCase()) || messageBox(m) === "sent";
  const others = addressList(m.to, m.cc).map(email => historyAddress(email, recipientLabel(email)));
  if (fromSelf) return others.join(", ") || "someone";
  const acct = accounts[m.account];
  const me = historyAddress(acct && acct.email, acct && (acct.yourName || acct.name)) || "me";
  return [me, ...others].join(", ");
}

function historyBlock(m, allowRemote) {
  const allow = allowRemote === true ? true : allowRemoteFor(m);
  const body = m.bodyHtml ? fittedMailHtml(withInlineImages(m, m.bodyHtml), allow) : `<p>${esc(m.body || m.preview || "")}</p>`;
  const shown = m.bodyHtml && allowRemote !== true;
  const from = esc(m.from) + (m.email ? " &lt;" + esc(m.email) + "&gt;" : "");
  return `<article class="history-item">
    <div class="history-head">
      <div><b>From</b> ${from}</div>
      <div><b>Sent</b> ${esc(historyWhen(m))}</div>
      <div><b>To</b> ${esc(historyTo(m))}</div>
      <div><b>Subject</b> ${esc(m.subject || "")}</div>
    </div>
    <div class="history-body${shown ? " mail-fit" : ""}">${shown ? `<div class="letter-fit">${body}</div>` : body}</div>
  </article>`;
}

function historyMarkup(msgId, open) {
  const items = historyMessages(msgId);
  if (!items.length) return "";
  const expanded = open === true;
  const label = expanded ? "Hide message history" : "Show message history";
  return `<button class="history-toggle" type="button" id="show-history" aria-expanded="${expanded ? "true" : "false"}" title="${label}" aria-label="${label}"><svg width="20" height="8" viewBox="0 0 20 8" aria-hidden="true"><circle cx="3" cy="4" r="1.35" fill="currentColor"/><circle cx="10" cy="4" r="1.35" fill="currentColor"/><circle cx="17" cy="4" r="1.35" fill="currentColor"/></svg></button>
    <div class="message-history" id="message-history"${expanded ? "" : " hidden"}>${historyBlock(items[0])}</div>`;
}

// Mail apps add their own gaps to bare paragraphs, so the spacing typed
// here is written into the message itself.
const OUT_FONT = "font-family: Aptos, Calibri, 'Segoe UI', Arial, sans-serif; font-size: 11pt; line-height: 1.4;";

// Colours that only mean "the screen was dark": a near-black grey
// background and near-white grey text. They come with text copied from a
// dark window, and sent on they make a black box (2026-10-23). The
// signature and any other colour are left as written.
function stripThemeColours(root) {
  const tone = value => {
    const c = colourSample(value);
    if (!c || c.a < 0.35) return null;
    const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
    return { light: (max + min) / 510, sat: max === min ? 0 : (max - min) / max };
  };
  root.querySelectorAll("[style], font[color]").forEach(el => {
    if (el.closest(".body-sig")) return;
    const style = el.style;
    const fill = style.backgroundColor || (/^\s*(#|rgb|hsl)/i.test(style.background || "") ? style.background : "");
    const bg = fill && tone(fill);
    if (bg && bg.sat < 0.15 && bg.light < 0.35) {
      style.removeProperty("background");
      style.removeProperty("background-color");
    }
    const ink = style.color && tone(style.color);
    if (ink && ink.sat < 0.15 && ink.light > 0.75) style.removeProperty("color");
    const fontInk = el.tagName === "FONT" && tone(el.getAttribute("color"));
    if (fontInk && fontInk.sat < 0.15 && fontInk.light > 0.75) el.removeAttribute("color");
    if (el.hasAttribute("style") && !String(el.getAttribute("style")).trim()) el.removeAttribute("style");
  });
}

function applyColour(body, kind, colour) {
  const write = body.querySelector(".body-write") || body;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !write.contains(sel.anchorNode)) { body.focus(); return false; }
  document.execCommand("styleWithCSS", false, true);
  if (kind === "hilite") document.execCommand("hiliteColor", false, colour || "transparent");
  else document.execCommand("foreColor", false, colour || "inherit");
  // "No highlight" and "Automatic" leave no trace in the mail.
  if (!colour) {
    write.querySelectorAll("[style]").forEach(el => {
      if (kind === "hilite" && /^(transparent|rgba\(0, 0, 0, 0\))$/.test(el.style.backgroundColor)) el.style.removeProperty("background-color");
      if (kind === "fore" && el.style.color === "inherit") el.style.removeProperty("color");
      if (!String(el.getAttribute("style") || "").trim()) el.removeAttribute("style");
    });
  }
  markDarkInks(body);
  return true;
}

function bindColourButtons(form, body, changed) {
  form.querySelectorAll(".format-bar [data-colour], .format-bar [data-colour-menu]").forEach(btn => btn.addEventListener("mousedown", e => e.preventDefault()));
  form.querySelectorAll(".format-bar [data-colour]").forEach(btn => {
    btn.onclick = () => { if (applyColour(body, btn.dataset.colour, lastColour(btn.dataset.colour))) changed(); };
  });
  form.querySelectorAll(".format-bar [data-colour-menu]").forEach(btn => {
    btn.onclick = () => {
      const kind = btn.dataset.colourMenu;
      let menu = document.getElementById("colour-menu");
      if (menu && menu.dataset.kind === kind) { menu.remove(); return; }
      if (menu) menu.remove();
      menu = document.createElement("div");
      menu.id = "colour-menu";
      menu.className = "colour-menu";
      menu.dataset.kind = kind;
      menu.setAttribute("role", "menu");
      menu.innerHTML = colourMenuHtml(kind);
      document.body.appendChild(menu);
      const at = btn.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(at.left - 30, innerWidth - menu.offsetWidth - 8)) + "px";
      menu.style.top = (at.bottom + 4) + "px";
      const close = () => { menu.remove(); document.removeEventListener("mousedown", outside, true); };
      function outside(ev) { if (!menu.contains(ev.target) && ev.target !== btn) close(); }
      document.addEventListener("mousedown", outside, true);
      menu.addEventListener("mousedown", e => e.preventDefault());
      menu.addEventListener("click", ev => {
        const pick = ev.target.closest("[data-pick-colour]");
        if (!pick) return;
        const colour = pick.dataset.pickColour;
        if (colour) {
          try { localStorage.setItem("mailroom-colour-" + kind, colour); } catch (e) {}
          const apply = form.querySelector(`[data-colour="${kind}"]`);
          if (apply) apply.style.setProperty("--swatch", colour);
        }
        close();
        if (applyColour(body, kind, colour)) changed();
      });
    };
  });
}

function outgoingHtml(html) {
  const doc = new DOMParser().parseFromString("<div>" + String(html || "") + "</div>", "text/html");
  const root = doc.body.firstElementChild;
  stripThemeColours(root);
  root.querySelectorAll("[data-dark-ink], [data-mark-bg]").forEach(el => {
    el.removeAttribute("data-dark-ink");
    el.removeAttribute("data-mark-bg");
    el.style.removeProperty("--dark-ink");
    el.style.removeProperty("--mark-bg");
    if (!String(el.getAttribute("style") || "").trim()) el.removeAttribute("style");
  });
  root.querySelectorAll(".body-write p, .body-write div, .body-sig p, .body-write li, :scope > p").forEach(el => {
    const style = el.getAttribute("style") || "";
    if (!/margin/i.test(style)) el.setAttribute("style", (style ? style.replace(/;?\s*$/, ";") + " " : "") + "margin: 0;");
  });
  root.querySelectorAll("img[data-picture-id], img[data-size]").forEach(img => {
    img.removeAttribute("data-picture-id");
    img.removeAttribute("data-size");
  });
  root.querySelectorAll(".body-sig").forEach(el => {
    el.removeAttribute("contenteditable");
    if (!el.getAttribute("style")) el.setAttribute("style", "margin-top: 8px;");
  });
  return '<div style="' + OUT_FONT + '">' + root.innerHTML + "</div>";
}

// Quoted mail is someone else's: any signature source it carries is theirs,
// and must not be redrawn (or sent) as if it were yours.
function quotedBodyHtml(html) {
  const doc = new DOMParser().parseFromString(sanitizeMailHtml(html, false), "text/html");
  doc.querySelectorAll("[data-sig-src]").forEach(el => el.removeAttribute("data-sig-src"));
  return doc.body ? doc.body.innerHTML : "";
}

// The message being answered, quoted the way Outlook quotes it, so other
// mail apps (and Mailroom) recognise it and can fold it away.
function quotedForSend(m) {
  const from = esc(m.from) + (m.email ? " &lt;" + esc(m.email) + "&gt;" : "");
  const body = m.bodyHtml ? quotedBodyHtml(m.bodyHtml) : `<p>${esc(m.body || m.preview || "")}</p>`;
  return `<div id="appendonsend"></div><p style="margin: 0;"><br></p><hr style="display: inline-block; width: 98%;" tabindex="-1">`
    + `<div id="divRplyFwdMsg" dir="ltr" style="${OUT_FONT}"><b>From:</b> ${from}<br><b>Sent:</b> ${esc(historyWhen(m))}<br><b>To:</b> ${esc(historyTo(m))}<br><b>Subject:</b> ${esc(m.subject || "")}</div>`
    + `<p style="margin: 0;"><br></p><div style="${OUT_FONT}">${body}</div>`;
}

function sentBody(form) {
  const written = outgoingHtml(form.querySelector("#compose-body").innerHTML);
  if (form.dataset.kind !== "reply") return written;
  const target = historyMessages(form.dataset.msg || "")[0];
  if (!target) return written;
  return written + quotedForSend(target);
}

function recipientChip(email) {
  const name = recipientLabel(email);
  const shown = name && name.toLowerCase() !== String(email).toLowerCase() ? name : email;
  return `<span class="recip-chip" title="${esc(email)}">${esc(shown)}</span>`;
}

function composeWhoHtml(to, cc, bcc, actions) {
  const line = (label, value) => {
    const people = addressList(value);
    if (!people.length) return "";
    return `<div class="who-line-row"><b>${label}</b><span class="recip-chips">${people.map(recipientChip).join("")}</span></div>`;
  };
  const toLine = line("To", to) || `<div class="who-line-row"><b>To</b><span class="recip-chips"><span class="recip-chip empty">someone</span></span></div>`;
  const head = actions ? `<div class="who-row">${toLine}${actions}</div>` : toLine;
  return `<div class="compose-who">${head}${line("Cc", cc)}${line("Bcc", bcc)}</div>`;
}

// Font colour and highlight (2026-10-23), with Outlook's colours. The last
// one used is on the button.
const FORE_COLOURS = [["Black", "#000000"], ["Grey", "#7f7f7f"], ["Dark red", "#c00000"], ["Red", "#ff0000"], ["Orange", "#ed7d31"], ["Gold", "#ffc000"], ["Green", "#00b050"], ["Light green", "#70ad47"], ["Blue", "#0070c0"], ["Dark blue", "#002060"], ["Purple", "#7030a0"], ["Pink", "#e3008c"]];
const HILITE_COLOURS = [["Yellow", "#ffff00"], ["Bright green", "#00ff00"], ["Turquoise", "#00ffff"], ["Pink", "#ff00ff"], ["Orange", "#ffc000"], ["Grey", "#c0c0c0"]];
function lastColour(kind) {
  const fallback = kind === "hilite" ? "#ffff00" : "#c00000";
  try { return localStorage.getItem("mailroom-colour-" + kind) || fallback; } catch (e) { return fallback; }
}

function colourMenuHtml(kind) {
  const list = kind === "hilite" ? HILITE_COLOURS : FORE_COLOURS;
  const none = kind === "hilite" ? "No highlight" : "Automatic";
  return `<div class="colour-grid">${list.map(([name, hex]) => `<button type="button" role="menuitem" class="colour-swatch" data-pick-colour="${hex}" title="${esc(name)}" aria-label="${esc(name)}" style="background:${hex}"></button>`).join("")}</div><button type="button" role="menuitem" class="colour-none" data-pick-colour="">${none}</button>`;
}

function formatBarHtml() {
  const skip = ` tabindex="-1"`;
  return `<div class="format-bar" aria-label="Formatting">
          <button class="attach-btn" type="button" id="add-file"${skip} title="Attach" aria-label="Attach"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 8.4l3.1-3.1a1.9 1.9 0 012.7 2.7L7.8 12.2a3 3 0 01-4.2-4.2L8 3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>
          <input class="file-picker" id="compose-file-picker" type="file" multiple tabindex="-1" aria-hidden="true">
          <button type="button" data-cmd="bold"${skip} title="Bold"><b>B</b></button>
          <button type="button" data-cmd="italic"${skip} title="Italic"><i>I</i></button>
          <button type="button" data-cmd="underline"${skip} title="Underline"><u>U</u></button>
          <span class="colour-split"><button type="button" class="colour-apply" data-colour="fore"${skip} title="Font colour" aria-label="Font colour" style="--swatch:${esc(lastColour("fore"))}"><span class="colour-a">A</span><span class="colour-bar"></span></button><button type="button" class="colour-more" data-colour-menu="fore"${skip} title="Font colours" aria-label="Font colours" aria-haspopup="menu">▾</button></span>
          <span class="colour-split"><button type="button" class="colour-apply" data-colour="hilite"${skip} title="Highlight" aria-label="Highlight" style="--swatch:${esc(lastColour("hilite"))}"><svg width="14" height="12" viewBox="0 0 16 14" aria-hidden="true"><path d="M3.5 9.5l6.8-6.8 2.5 2.5-6.8 6.8H3.5V9.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg><span class="colour-bar"></span></button><button type="button" class="colour-more" data-colour-menu="hilite"${skip} title="Highlight colours" aria-label="Highlight colours" aria-haspopup="menu">▾</button></span>
          <button type="button" class="format-icon" data-cmd="insertUnorderedList"${skip} title="Bullets" aria-label="Bullets"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="4" r="1.2" fill="currentColor"/><circle cx="3" cy="8" r="1.2" fill="currentColor"/><circle cx="3" cy="12" r="1.2" fill="currentColor"/><path d="M6.5 4h7M6.5 8h7M6.5 12h7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>
          <button type="button" class="format-icon" data-cmd="insertOrderedList"${skip} title="Numbers" aria-label="Numbers"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 2.9l1.1-.6v3.4M2.1 7.6c.3-.5 1.9-.6 1.9.4 0 .7-1.9 1.6-1.9 2.2h2M2.2 11.9c.4-.4 1.8-.4 1.8.4 0 .5-.5.7-1 .7.6 0 1.1.2 1.1.8 0 .9-1.5.9-2 .4" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.5 4h7M6.5 8.6h7M6.5 13h7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>
          <button type="button" class="format-icon" data-cmd="link"${skip} title="Link" aria-label="Link"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.9 9.1a2.5 2.5 0 003.5 0l2.3-2.3a2.5 2.5 0 00-3.5-3.5l-.9.9M9.1 6.9a2.5 2.5 0 00-3.5 0L3.3 9.2a2.5 2.5 0 003.5 3.5l.9-.9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          ${assistantButtonHtml()}
        </div>`;
}

function composeMarkup({ mode, title, msgId, fromId, to, cc, bcc, attachments, subject, bodyHtml, meeting, kind, hideAddress, includeHistory, openHistory, bare }) {
  // In the compact reply, chips show Cc and Bcc; the fields open on demand.
  const ccOn = !hideAddress && !!String(cc || "").trim();
  const bccOn = !hideAddress && !!String(bcc || "").trim();
  const discardButton = `<button class="icon-btn" type="button" id="cancel" title="Discard" aria-label="Discard"><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6.5h11M8 6.4V4.8h4v1.6M7.2 6.5l.5 8.8h4.6l.5-8.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  const formatBar = formatBarHtml();
  const sendLater = inDesktop() ? `<button class="icon-btn send-later" type="button" id="send-later" title="Send later" aria-label="Send later"><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10.5" r="6.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10 7.2v3.5l2.4 1.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : "";
  // Importance and a read receipt, as Outlook's message options.
  const templatesButton = `<button class="icon-btn templates-btn" type="button" id="compose-templates" title="Templates" aria-label="Templates" aria-haspopup="menu"><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="2.8" width="12" height="14.4" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7 7h6M7 10h6M7 13h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>`;
  const sendOptions = `<button class="icon-btn send-options" type="button" id="send-options" title="Message options" aria-label="Message options" aria-haspopup="menu"><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.5v8.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="15.3" r="1.2" fill="currentColor"/></svg></button>`;
  if (mode === "pop") {
    return `<form class="pop-form" id="compose-form" data-msg="${esc(msgId || "")}" data-kind="${esc(kind || "new")}">
      <div class="compose-bar">
        <button class="primary" type="submit">Send</button>${sendLater}${sendOptions}${templatesButton}
        <span class="compose-spacer"></span>
        ${discardButton}
      </div>
      <label class="pop-row">
        <span class="pop-label">From</span>
        <select name="from" id="compose-from">${fromOptions(fromId)}</select>
        <input id="compose-alias" class="alias-entry" hidden autocomplete="off" spellcheck="false" placeholder="name@example.com" aria-label="Send from this address">
      </label>
      ${formatBar}
      <div class="pop-row pop-to">
        <label class="pop-label" for="compose-to">To</label>
        <input name="to" id="compose-to" value="${esc(recipientFieldValue(to || ""))}" autocomplete="off">
        <div class="suggest" id="to-suggest" hidden></div>
        <span class="pop-cc">
          <button type="button" class="linkish" id="show-cc" tabindex="-1"${ccOn ? " hidden" : ""}>Cc</button>
          <button type="button" class="linkish" id="show-bcc" tabindex="-1"${bccOn ? " hidden" : ""}>Bcc</button>
        </span>
      </div>
      <label class="pop-row" id="cc-field"${ccOn ? "" : " hidden"}>
        <span class="pop-label">Cc</span>
        <input name="cc" id="compose-cc" value="${esc(recipientFieldValue(cc || ""))}" autocomplete="off">
        <div class="suggest" id="cc-suggest" hidden></div>
      </label>
      <label class="pop-row" id="bcc-field"${bccOn ? "" : " hidden"}>
        <span class="pop-label">Bcc</span>
        <input name="bcc" id="compose-bcc" value="${esc(recipientFieldValue(bcc || ""))}" autocomplete="off">
        <div class="suggest" id="bcc-suggest" hidden></div>
      </label>
      <label class="pop-row pop-subject">
        <input name="subject" id="compose-subject" value="${esc(subject || "")}" placeholder="Add a subject">
      </label>
      <div class="files" id="compose-files">${fileChips(attachments)}</div>
      ${inviteMarkup(meeting, to)}
      <div class="compose-canvas">
        <div id="compose-body" class="html-body" contenteditable="true" role="textbox" aria-multiline="true">${htmlFor(bodyHtml || "<p><br></p>")}</div>
        ${kind === "reply" && includeHistory !== false ? historyMarkup(msgId, openHistory) : ""}
      </div>
    </form>`;
  }
  const cls = mode === "inline" ? "inline-reply" : mode === "pop" ? "pop-form" : mode === "pane" ? "pane-compose" : "dialog compose";
  const popOutButton = `<button class="icon-btn" type="button" id="pop-out" title="Pop out" aria-label="Pop out"><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M8.2 4.6H4.8v10.6h10.6V11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M10.6 9.4L15.6 4.4M12.2 4.4h3.4V7.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
  const commandBar = `<div class="compose-bar">
        <button class="primary" type="submit">Send</button>${sendLater}${sendOptions}${templatesButton}
        <span class="compose-spacer"></span>
        ${discardButton}
        ${popOutButton}
      </div>`;
  const bar = mode === "inline" || mode === "pane"
    ? commandBar
    : mode === "dialog"
      ? `<div class="compose-bar"><h2>${esc(title)}</h2><span class="compose-spacer"></span>${popOutButton}</div>`
      : `<div class="compose-bar"><h2>${esc(title)}</h2></div>`;
  const footer = mode === "inline" || mode === "pane" ? "" : `
      <div class="dialog-actions">
        <button class="ghost" type="button" id="cancel">Discard</button>
        <button class="primary" type="submit">Send</button>${sendLater}${sendOptions}${templatesButton}
      </div>`;
  const address = `<label class="field">
        <span class="compose-label">From</span>
        <select name="from" id="compose-from">${fromOptions(fromId)}</select>
        <input id="compose-alias" class="alias-entry" hidden autocomplete="off" spellcheck="false" placeholder="name@example.com" aria-label="Send from this address">
      </label>
      <div class="field">
        <label class="compose-label" for="compose-to">To</label>
        <input name="to" id="compose-to" value="${esc(recipientFieldValue(to || ""))}" autocomplete="off">
        <div class="suggest" id="to-suggest" hidden></div>
        ${hideAddress ? "" : `<span class="cc-links">
          <button type="button" class="linkish" id="show-cc" tabindex="-1"${ccOn ? " hidden" : ""}>Cc</button>
          <button type="button" class="linkish" id="show-bcc" tabindex="-1"${bccOn ? " hidden" : ""}>Bcc</button>
        </span>`}
      </div>
      <label class="field" id="cc-field"${ccOn ? "" : " hidden"}>
        <span class="compose-label">Cc</span>
        <input name="cc" id="compose-cc" value="${esc(recipientFieldValue(cc || ""))}" autocomplete="off">
        <div class="suggest" id="cc-suggest" hidden></div>
      </label>
      <label class="field" id="bcc-field"${bccOn ? "" : " hidden"}>
        <span class="compose-label">Bcc</span>
        <input name="bcc" id="compose-bcc" value="${esc(recipientFieldValue(bcc || ""))}" autocomplete="off">
        <div class="suggest" id="bcc-suggest" hidden></div>
      </label>
      <label class="field compose-subject">
        <span class="compose-label">Subject</span>
        <input name="subject" id="compose-subject" value="${esc(subject || "")}" placeholder="Add a subject">
      </label>`;
  const addressBlock = hideAddress ? `<div class="compose-address">${address}</div>` : address;
  const ccButtons = `<span class="who-cc"><button type="button" class="linkish" id="show-cc" tabindex="-1"${ccOn ? " hidden" : ""}>Cc</button><button type="button" class="linkish" id="show-bcc" tabindex="-1"${bccOn ? " hidden" : ""}>Bcc</button></span>`;
  const who = hideAddress ? composeWhoHtml(to, cc, bcc, ccButtons) : "";
  const inlineReply = mode === "inline" && !!bare;
  // The short reply has no formatting bar, so Attach sits by Send.
  const replyAttach = inlineReply ? assistantButtonHtml("icon-btn reply-assist") + `<button class="icon-btn attach-btn" type="button" id="add-file" title="Attach" aria-label="Attach"><svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 8.4l3.1-3.1a1.9 1.9 0 012.7 2.7L7.8 12.2a3 3 0 01-4.2-4.2L8 3.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button><input class="file-picker" id="compose-file-picker" type="file" multiple tabindex="-1" aria-hidden="true">` : "";
  return `<form class="${cls}" id="compose-form" data-msg="${esc(msgId || "")}" data-kind="${esc(kind || "new")}">
      ${inlineReply ? bar.replace('<span class="compose-spacer"></span>', replyAttach + '<span class="compose-spacer"></span>') : bar}
      ${who}
      ${addressBlock}
      <div class="files" id="compose-files">${fileChips(attachments)}</div>
      ${inviteMarkup(meeting, to)}
      <div class="field compose-message">${mode === "pane" || bare ? "" : "Message"}
        ${inlineReply ? "" : formatBar}
        <div class="compose-canvas">
          <div id="compose-body" class="html-body" contenteditable="true" role="textbox" aria-multiline="true">${htmlFor(bodyHtml || "<p><br></p>")}</div>
          ${kind === "reply" && includeHistory !== false ? historyMarkup(msgId, openHistory) : ""}
        </div>
      </div>
      ${footer}
    </form>`;
}

function placeCaretEnd(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Pasted text takes the message's own paragraphs (2026-10-27), like
// Outlook's "merge formatting": bold, italic, underline, links and lists
// stay; fonts, sizes, colours and spacing go. Text copied from a terminal or
// an editor arrives as one block that keeps its lines with white-space: pre,
// which Bullets and Numbers can't see as lines, so each line becomes its own
// paragraph. Pictures and tables paste as before (null).
const PASTE_BLOCKS = /^(P|DIV|H[1-6]|PRE|BLOCKQUOTE|SECTION|ARTICLE|HEADER|FOOTER|MAIN|ASIDE|NAV|LI|DT|DD|FIGCAPTION|ADDRESS|HR)$/;
const PASTE_SKIP = /^(SCRIPT|STYLE|META|TITLE|HEAD|LINK|TEMPLATE|NOSCRIPT|IFRAME|OBJECT|BUTTON|INPUT|SELECT|TEXTAREA)$/;
const PASTE_INLINE = { B: "b", STRONG: "b", I: "i", EM: "i", U: "u", A: "a" };

function cleanPastedHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const root = doc.body;
  if (!root || root.querySelector("img, table, svg, video, canvas, picture")) return null;
  const out = document.createElement("div");
  let para = null, inline = null, item = null;
  const open = () => {
    if (!para) {
      para = document.createElement("p");
      (item || out).appendChild(para);
      inline = para;
    }
    return inline;
  };
  const close = () => { para = null; inline = null; };
  const pre = el => el.tagName === "PRE" || /white-space\s*:\s*pre/i.test(el.getAttribute("style") || "");
  const text = (value, keepLines) => {
    if (!keepLines) {
      const flat = value.replace(/\s+/g, " ");
      if (flat.trim() || para) open().appendChild(document.createTextNode(flat));
      return;
    }
    value.split(/\r?\n/).forEach((part, i) => {
      if (i) {
        if (!para) open().appendChild(document.createElement("br"));
        close();
      }
      if (part) open().appendChild(document.createTextNode(part));
    });
  };
  const walk = (node, keepLines) => {
    if (node.nodeType === 3) { text(node.data, keepLines); return; }
    if (node.nodeType !== 1 || PASTE_SKIP.test(node.tagName)) return;
    const tag = node.tagName;
    const lines = keepLines || pre(node);
    const kids = () => [...node.childNodes].forEach(child => walk(child, lines));
    if (tag === "BR") { if (!para) open().appendChild(document.createElement("br")); close(); return; }
    if (tag === "UL" || tag === "OL") {
      close();
      const list = document.createElement(tag.toLowerCase());
      (item || out).appendChild(list);
      const outer = item;
      [...node.childNodes].forEach(child => {
        if (child.nodeType !== 1 || child.tagName !== "LI") return;
        item = document.createElement("li");
        list.appendChild(item);
        close();
        [...child.childNodes].forEach(grand => walk(grand, lines));
        // An item is its own paragraph; unwrap a lone one.
        if (item.children.length === 1 && item.firstElementChild.tagName === "P" && item.childNodes.length === 1) item.firstElementChild.replaceWith(...item.firstElementChild.childNodes);
        close();
      });
      item = outer;
      if (!list.children.length) list.remove();
      return;
    }
    if (PASTE_BLOCKS.test(tag)) { close(); kids(); close(); return; }
    const keep = PASTE_INLINE[tag];
    if (keep) {
      const el = document.createElement(keep);
      if (keep === "a") {
        const href = String(node.getAttribute("href") || "").trim();
        if (!/^(https?:|mailto:|tel:)/i.test(href)) { kids(); return; }
        el.setAttribute("href", href);
      }
      open().appendChild(el);
      const prevPara = para, prevInline = inline;
      inline = el;
      kids();
      if (para === prevPara) inline = prevInline;
      return;
    }
    kids();
  };
  [...root.childNodes].forEach(node => walk(node, false));
  out.querySelectorAll("b, i, u, a").forEach(el => { if (!el.textContent) el.remove(); });
  out.querySelectorAll("p").forEach(p => {
    // Edge spaces left by the source's indentation.
    const first = p.firstChild, last = p.lastChild;
    if (first && first.nodeType === 3) first.data = first.data.replace(/^ +/, "");
    if (last && last.nodeType === 3) last.data = last.data.replace(/ +$/, "");
    if (!p.childNodes.length || (p.childNodes.length === 1 && p.firstChild.nodeType === 3 && !p.firstChild.data)) p.innerHTML = "<br>";
  });
  // Blank paragraphs at the ends come from the source's wrappers.
  while (out.firstElementChild && out.firstElementChild.tagName === "P" && out.firstElementChild.innerHTML === "<br>") out.firstElementChild.remove();
  while (out.lastElementChild && out.lastElementChild.tagName === "P" && out.lastElementChild.innerHTML === "<br>") out.lastElementChild.remove();
  return out.innerHTML || null;
}

function pasteIntoCompose(e) {
  const data = e.clipboardData;
  if (!data) return;
  if ([...(data.items || [])].some(entry => entry.kind === "file")) return;
  const html = data.getData("text/html");
  if (!html) return;
  const clean = cleanPastedHtml(html);
  if (!clean) return;
  e.preventDefault();
  document.execCommand("insertHTML", false, clean);
}

function tidyLists(write) {
  write.querySelectorAll("p").forEach(p => {
    const list = [...p.children].find(el => el.tagName === "UL" || el.tagName === "OL");
    if (!list || p.parentElement !== write) return;
    const only = [...p.childNodes].every(node => node === list || (node.nodeType === 3 && !node.textContent.trim()));
    if (only) p.replaceWith(list);
  });
}

function liftList(list) {
  const items = [...list.children];
  const sel = window.getSelection();
  const host = sel && sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
  const current = host && host.closest("li");
  const index = Math.max(0, items.indexOf(current));
  const blocks = items.map(li => {
    if (li.children.length === 1 && li.firstElementChild.tagName === "P") return li.firstElementChild;
    const p = document.createElement("p");
    while (li.firstChild) p.appendChild(li.firstChild);
    if (!p.childNodes.length) p.innerHTML = "<br>";
    return p;
  });
  list.replaceWith(...blocks);
  if (blocks.length) placeCaretEnd(blocks[index] || blocks[0]);
}

function applyList(write, ordered) {
  const sel = window.getSelection();
  const host = sel && sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
  const item = host && host.closest && write.contains(host) ? host.closest("li") : null;
  const list = item && item.parentElement;
  const want = ordered ? "OL" : "UL";
  if (list && (list.tagName === "UL" || list.tagName === "OL") && write.contains(list)) {
    if (list.tagName === want) liftList(list);
    else {
      const next = document.createElement(want);
      while (list.firstChild) next.appendChild(list.firstChild);
      list.replaceWith(next);
      placeCaretEnd(item);
    }
    return;
  }
  document.execCommand(want === "OL" ? "insertOrderedList" : "insertUnorderedList", false, null);
  tidyLists(write);
  const current = window.getSelection();
  if (!current || !current.isCollapsed || !current.rangeCount || !current.anchorNode) return;
  const from = current.anchorNode.nodeType === 1 ? current.anchorNode : current.anchorNode.parentElement;
  const made = from && from.closest("li");
  if (!made) return;
  const at = current.getRangeAt(0);
  const probe = at.cloneRange();
  probe.selectNodeContents(made);
  probe.setEnd(at.startContainer, at.startOffset);
  if (!probe.toString()) placeCaretEnd(made);
}

const POP_ORIGINAL_FIELDS = ["id", "thread", "seq", "box", "account", "live", "from", "email", "initials", "color", "subject", "preview", "time", "received", "date", "to", "cc", "toName", "body", "bodyHtml", "files", "attachments", "hasAttachment", "replyTo", "draft", "allowRemote"];
function popOriginals(msgId) {
  const msg = msgId ? messages.find(m => m.id === msgId) : null;
  if (!msg) return [];
  const target = msg.draft && msg.replyTo ? messages.find(m => m.id === msg.replyTo) : null;
  return [msg, target].filter(Boolean).map(m => {
    const copy = {};
    POP_ORIGINAL_FIELDS.forEach(key => { if (m[key] !== undefined) copy[key] = m[key]; });
    return copy;
  });
}

function adoptPopOriginals(list) {
  (Array.isArray(list) ? list : []).forEach(m => {
    if (m && m.id && !messages.some(item => item.id === m.id)) messages.push(Object.assign({}, m, { popCopy: true }));
  });
}

function popQuery(snapshot) {
  const kind = snapshot.kind === "reply" ? "reply" : "new";
  const parts = ["compose=" + kind];
  if (kind === "reply" && snapshot.msgId) parts.push("msg=" + encodeURIComponent(snapshot.msgId));
  parts.push("d=" + Date.now());
  return parts.join("&");
}

function closeComposeWindow() {
  if (inDesktop()) {
    const pending = tauriInvoke("plugin:window|close");
    if (pending && pending.then) return;
  }
  window.close();
}

async function popOutCompose(form, ctx) {
  if (ctx && ctx.mode === "inline") captureReplyDraft();
  const snapshot = {
    kind: form.dataset.kind === "reply" ? "reply" : "new",
    msgId: (ctx && ctx.draft && ctx.draft.msgId) || form.dataset.msg || "",
    draftId: (ctx && ctx.draft && ctx.draft.draftId) || "",
    from: form.querySelector(".compose-address[hidden]")
      ? (defaultAccountId() || formFromValue(form))
      : formFromValue(form),
    to: parseAddresses(form.querySelector("#compose-to").value).join("; "),
    cc: parseAddresses(form.querySelector("#compose-cc").value).join("; "),
    bcc: parseAddresses(form.querySelector("#compose-bcc").value).join("; "),
    subject: form.querySelector("#compose-subject").value,
    bodyHtml: form.querySelector("#compose-body").innerHTML,
    attachments: [...form.querySelectorAll("#compose-files [data-name]")].map(el => el.dataset.name),
    meeting: form.querySelector("#compose-invite") ? readInvite(form) : null,
    compose: (ctx && ctx.draft && ctx.draft.compose) || "",
    serverDraftId: (ctx && ctx.draft && ctx.draft.serverDraftId) || "",
    serverDraftMode: (ctx && ctx.draft && ctx.draft.serverDraftMode) || "",
    serverDraftAccount: (ctx && ctx.draft && ctx.draft.serverDraftAccount) || "",
    staged: (ctx && ctx.draft && ctx.draft.staged) || {}
  };
  // The pop-out window does not load the mailbox, so it is handed the
  // message being answered or forwarded: its history shows, and it goes as
  // a real reply or forward with the original (2026-10-23).
  snapshot.originals = popOriginals(snapshot.msgId);
  try {
    localStorage.setItem("outlook-mock-compose", JSON.stringify(snapshot));
    if (snapshot.kind === "reply" && ctx && ctx.draft) {
      localStorage.setItem("outlook-mock-reply", JSON.stringify(ctx.draft));
    }
  } catch (e) {
    toast("Could not pop out");
    return;
  }
  const query = popQuery(snapshot);
  if (inDesktop()) {
    try {
      const pending = tauriInvoke("pop_compose", { query });
      if (!pending || !pending.then) {
        toast("Could not pop out");
        return;
      }
      await pending;
    } catch (e) {
      toast("Could not pop out");
      return;
    }
  } else {
    const base = location.href.split("?")[0];
    const child = window.open(base + "?" + query, "outlook-mock-compose", "popup=yes,width=760,height=740");
    if (!child) {
      toast("Could not pop out");
      return;
    }
  }
  if (ctx && ctx.mode === "inline") {
    replyDraft = null;
    renderReading();
    return;
  }
  if (ctx && ctx.mode === "pane") {
    paneCompose = null;
    renderReading();
    return;
  }
  closePop();
}

const ATTACH_LIMIT = 35 * 1024 * 1024;

function stageComposeFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("That file could not be read."));
    reader.onload = () => {
      const url = String(reader.result || "");
      const data = url.slice(url.indexOf(",") + 1);
      tauriInvoke("stage_file", { data })
        .then(result => resolve({ id: result.id, size: result.size, type: file.type || "" }))
        .catch(reject);
    };
    reader.readAsDataURL(file);
  });
}

// Files picked on this computer that are still attached in the form.
function stagedFilesFor(form, staged) {
  const map = staged || {};
  return [...form.querySelectorAll("#compose-files [data-name]")]
    .map(el => el.dataset.name)
    .filter(name => map[name] && map[name].id)
    .map(name => ({ id: map[name].id, name: map[name].sendName || name, contentType: map[name].type || "" }));
}

function stagedMap(files) {
  const map = {};
  (files || []).forEach(file => { if (file && file.id && file.name) map[file.name] = { id: file.id, size: 0, type: file.contentType || "" }; });
  return map;
}

const ADDRESS_SHAPE = /^[^\s@<>()\[\],;:"]+@[^\s@<>()\[\],;:"]+\.[^\s@<>()\[\],;:"]{2,}$/;

// The first recipient problem in a compose form, or null when it can send.
function recipientProblem(form) {
  const fields = ["#compose-to", "#compose-cc", "#compose-bcc"].map(sel => form.querySelector(sel)).filter(Boolean);
  let count = 0;
  for (const field of fields) {
    for (const part of addressParts(field.value)) {
      const email = addressEmail(part);
      if (!email || !ADDRESS_SHAPE.test(email)) {
        return { field, text: "“" + part.slice(0, 60) + "” is not a complete email address. Pick a suggestion or finish the address." };
      }
      count += 1;
    }
  }
  if (!count) return { field: fields[0], text: "Add at least one recipient." };
  return null;
}

// Reply, replyAll, forward, or new. A server draft that already exists is
// simply saved again, whatever started it.
function composeMode(form, ctx) {
  if (form.dataset.kind !== "reply") return "new";
  const mode = ctx.draft && ctx.draft.compose;
  return mode === "forward" || mode === "replyAll" ? mode : "reply";
}

// Server ids of drafts that are open or kept on this computer. Their server
// copy is not listed a second time.
function shadowedServerDrafts() {
  const ids = new Set();
  [replyDraft, paneCompose].forEach(d => { if (d && d.serverDraftId && d.draftId !== d.serverDraftId) ids.add(d.serverDraftId); });
  messages.forEach(m => { if (!m.live && m.serverDraftId) ids.add(m.serverDraftId); });
  return ids;
}

// Autosave runs only after someone types, so any content at all counts.
function draftWorthSaving(fields) {
  const text = plainFromHtml(fields.bodyHtml || "").trim();
  const subject = String(fields.subject || "").replace(/^\s*(re|fw|fwd):\s*/i, "").trim();
  return !!(text || subject || String(fields.to || "").trim() || String(fields.cc || "").trim() || String(fields.bcc || "").trim());
}

// Write 2.5s after the last change. Typing without a pause still writes at
// least every 15s, measured from the first unsaved change. Tests pass
// window.__draftPauseMs and window.__draftKeepMs, in milliseconds.
const DRAFT_PAUSE_MS = 2500;
const DRAFT_KEEP_MS = 15000;
let draftSavers = [];
// Kept off the draft object. A draft is copied into localStorage when it
// pops out, and a link back to the form would loop.
const draftSaves = new WeakMap();

function draftPauseMs() {
  const n = Number(window.__draftPauseMs);
  return Number.isFinite(n) && n >= 0 ? n : DRAFT_PAUSE_MS;
}

function draftKeepMs() {
  const n = Number(window.__draftKeepMs);
  return Number.isFinite(n) && n >= 0 ? n : DRAFT_KEEP_MS;
}

function queueDraftSave(d, wait) {
  clearTimeout(d._saveTimer);
  d._saveTimer = setTimeout(() => {
    d._saveTimer = 0;
    const entry = draftSaves.get(d);
    if (!entry || d._closed || !entry.form.isConnected) return;
    const fields = entry.payload();
    d._lastFields = fields;
    saveServerDraft(entry.ctx, fields);
  }, wait);
}

function noteDraftEdit(d) {
  if (!d || d._closed) return;
  d._rev = (d._rev || 0) + 1;
  if (!d._dirtySince) d._dirtySince = Date.now();
  const keepLeft = draftKeepMs() - (Date.now() - d._dirtySince);
  queueDraftSave(d, Math.max(0, Math.min(draftPauseMs(), keepLeft)));
}

function bindDraftAutosave(ctx, form, payload) {
  if (!ctx.draft || !inDesktop()) return;
  const d = ctx.draft;
  const entry = { ctx, form, payload };
  draftSavers = draftSavers.filter(item => item.form.isConnected && item.ctx.draft !== d);
  draftSavers.push(entry);
  draftSaves.set(d, entry);
  const later = () => noteDraftEdit(d);
  form.addEventListener("input", later);
  form.addEventListener("change", later);
  // A new form for the same draft keeps the 15s deadline already running.
  if (d._dirtySince && !d._closed) {
    const keepLeft = draftKeepMs() - (Date.now() - d._dirtySince);
    queueDraftSave(d, Math.max(0, Math.min(draftPauseMs(), keepLeft)));
  }
}

async function flushOpenDrafts() {
  const jobs = draftSavers.filter(entry => entry.form.isConnected && entry.ctx.draft && !entry.ctx.draft._closed && entry.ctx.draft._dirtySince);
  await Promise.all(jobs.map(async entry => {
    const d = entry.ctx.draft;
    clearTimeout(d._saveTimer);
    d._saveTimer = 0;
    try {
      const fields = entry.payload();
      d._lastFields = fields;
      await saveServerDraft(entry.ctx, fields);
    } catch (err) {}
  }));
}
window.flushOpenDrafts = flushOpenDrafts;
window.addEventListener("pagehide", () => { flushOpenDrafts(); });

async function saveServerDraft(ctx, fields) {
  const d = ctx.draft;
  const accountId = fromAccountId(fields && fields.from);
  if (!d || !inDesktop() || !accountId) return;
  const acct = accounts[accountId];
  if (!acct.signedIn || !acct.email) return;
  if (d._closed) return;
  if (!d.serverDraftId && !draftWorthSaving(fields)) {
    d._dirtySince = 0;
    return;
  }
  d._lastFields = fields;
  if (d._saving) {
    d._saveAgain = true;
    return d._saveChain;
  }
  d._saveChain = performDraftSave(ctx, fields);
  return d._saveChain;
}

async function performDraftSave(ctx, fields) {
  const d = ctx.draft;
  if (!d || d._closed) {
    if (d) d._saving = false;
    return;
  }
  const accountId = fromAccountId(fields && fields.from);
  const acct = accountId && accounts[accountId];
  if (!acct || !acct.signedIn || !acct.email) {
    d._saving = false;
    return;
  }
  d._saving = true;
  const rev = d._rev || 0;
  let failed = false;
  try {
    // A draft started in another account, or as a reply that became a
    // forward, is replaced rather than edited.
    const mode = fields.replyMode || "new";
    const moved = d.serverDraftId && ((d.serverDraftAccount && d.serverDraftAccount !== accountId) || (d.serverDraftMode && d.serverDraftMode !== "saved" && d.serverDraftMode !== mode));
    if (moved) {
      const old = accounts[d.serverDraftAccount] || acct;
      tauriInvoke("discard_draft", { email: old.email, draftId: d.serverDraftId }).catch(() => {});
      d.serverDraftId = "";
    }
    const original = fields.replyTo ? messages.find(m => m.id === fields.replyTo) : null;
    const threaded = !!(original && serverMessage(original) && original.account === accountId);
    const id = await tauriInvoke("save_draft", {
      email: acct.email,
      subject: fields.subject || "",
      bodyHtml: fields.bodyHtml || "",
      to: fields.to || "",
      cc: fields.cc || "",
      bcc: fields.bcc || "",
      draftId: d.serverDraftId || null,
      replyTo: threaded ? original.id : null,
      mode: threaded ? mode : "new",
      importance: fields.importance || "",
      readReceipt: !!fields.readReceipt,
      fromAddress: sendFromAddress(fields.from) || null
    });
    if (id && d._closed) {
      // Sent or discarded while this save was on its way. A draft the send
      // did not use is not left behind on the server.
      if (id !== d._sentWith) tauriInvoke("discard_draft", { email: acct.email, draftId: id }).catch(() => {});
    } else if (id) {
      d.serverDraftId = id;
      d.serverDraftAccount = accountId;
      if (!d.serverDraftMode || moved) d.serverDraftMode = mode;
      const local = d.draftId ? messages.find(m => m.id === d.draftId && !m.live) : null;
      if (local) {
        local.serverDraftId = id;
        local.serverDraftMode = d.serverDraftMode;
      }
    }
  } catch (err) {
    // The draft stays on this computer. A later pause, the 15s keep, or
    // closing the window tries again.
    failed = true;
  }
  if (d._saveAgain && d._lastFields && !d._closed) {
    const next = d._lastFields;
    d._saveAgain = false;
    await performDraftSave(ctx, next);
    return;
  }
  d._saving = false;
  if (d._closed) return;
  if (!failed && (d._rev || 0) === rev) {
    d._dirtySince = 0;
    return;
  }
  if (failed && d._dirtySince && !d._saveTimer) queueDraftSave(d, draftKeepMs());
}

function discardServerDraft(draft) {
  if (!draft || !draft.serverDraftId || !inDesktop()) return;
  const acct = accounts[draft.serverDraftAccount || fromAccountId(draft.from)];
  if (!acct || !acct.email) return;
  const id = draft.serverDraftId;
  draft.serverDraftId = "";
  messages.forEach(m => { if (m.serverDraftId === id) m.serverDraftId = ""; });
  const live = messages.findIndex(m => m.live && m.id === id);
  if (live >= 0) messages.splice(live, 1);
  tauriInvoke("discard_draft", { email: acct.email, draftId: id }).catch(() => {});
}

function bindCompose(root, ctx) {
  const form = root.querySelector("#compose-form");
  const fromSelect = form.querySelector("#compose-from");
  const toInput = form.querySelector("#compose-to");
  const subjectInput = form.querySelector("#compose-subject");
  const body = form.querySelector("#compose-body");
  function chosenFrom() {
    const input = form.querySelector("#compose-alias");
    if (input && !input.hidden) return fromAccountId(fromSelect.value) + "\t" + input.value.trim();
    return fromSelect.value;
  }
  function syncAliasEntry() {
    const input = form.querySelector("#compose-alias");
    if (!input) return;
    const typed = String(fromSelect.value || "").endsWith("\t");
    input.hidden = !typed;
    if (typed && ctx.draft && !input.value) input.value = fromAddress(ctx.draft.from);
  }
  fromSelect.onchange = () => {
    syncAliasEntry();
    if (ctx.draft) ctx.draft.from = chosenFrom();
    paintComposeSignature(form, true);
  };
  const aliasEntry = form.querySelector("#compose-alias");
  if (aliasEntry) aliasEntry.addEventListener("input", () => { if (ctx.draft) ctx.draft.from = chosenFrom(); });
  syncAliasEntry();
  paintComposeSignature(form);
  function bindRecipientSuggest(input, box, assign) {
    // Only the address after the last separator is being typed.
    const split = () => {
      const value = input.value;
      const cut = Math.max(value.lastIndexOf(";"), value.lastIndexOf(","));
      return { before: cut >= 0 ? value.slice(0, cut) : "", typing: value.slice(cut + 1).trim() };
    };
    const close = () => { box.hidden = true; box.innerHTML = ""; };
    function choose(btn) {
      const { before } = split();
      const kept = recipientFieldValue(before);
      input.value = (kept ? kept + "; " : "") + recipientFieldValue(btn.dataset.email) + "; ";
      input.removeAttribute("aria-invalid");
      assign(input.value);
      close();
      input.focus();
    }
    let searchTimer = 0;
    function paint(fromSearch) {
      const q = split().typing.toLowerCase();
      if (!fromSearch && q.length >= 2) {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          searchDirectory(q).then(found => { if (found && split().typing.toLowerCase() === q && document.activeElement === input) paint(true); });
        }, 250);
      }
      const hits = q ? peopleMatches(q, 6).filter(person => person.email.toLowerCase() !== q) : [];
      if (!hits.length) return close();
      box.hidden = false;
      box.innerHTML = personSuggestHtml(hits);
      box.querySelectorAll("button").forEach((btn, i) => {
        if (i === 0) btn.classList.add("on");
        btn.addEventListener("mousedown", (e) => e.preventDefault());
        btn.onclick = () => choose(btn);
      });
    }
    input.addEventListener("input", () => {
      input.removeAttribute("aria-invalid");
      assign(input.value);
      paint();
    });
    input.addEventListener("keydown", (e) => {
      const open = !box.hidden && box.querySelector("button");
      if (e.key === "Enter") {
        // Enter picks a suggestion. It never sends the message.
        e.preventDefault();
        if (open) choose(box.querySelector("button.on") || box.querySelector("button"));
        return;
      }
      if (!open) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...box.querySelectorAll("button")];
        const at = Math.max(0, items.findIndex(b => b.classList.contains("on")));
        const next = (at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        items.forEach((b, i) => b.classList.toggle("on", i === next));
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
  }
  // Enter in any single-line field never sends. Only the Send button does.
  form.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement && e.target.type !== "submit" && e.target.type !== "button") e.preventDefault();
  });
  bindRecipientSuggest(toInput, form.querySelector("#to-suggest"), (value) => { if (ctx.draft) ctx.draft.to = parseAddresses(value).join("; "); });
  bindRecipientSuggest(form.querySelector("#compose-cc"), form.querySelector("#cc-suggest"), (value) => { if (ctx.draft) ctx.draft.cc = parseAddresses(value).join("; "); });
  bindRecipientSuggest(form.querySelector("#compose-bcc"), form.querySelector("#bcc-suggest"), (value) => { if (ctx.draft) ctx.draft.bcc = parseAddresses(value).join("; "); });
  subjectInput.addEventListener("input", () => {
    if (!ctx.draft) return;
    ctx.draft.subject = subjectInput.value;
    if (ctx.draft === replyDraft) syncDraftMessage();
  });
  const focusBody = () => {
    const write = body.querySelector(".body-write") || body;
    write.focus();
    const range = document.createRange();
    range.selectNodeContents(write);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };
  subjectInput.addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab" || ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    ev.preventDefault();
    focusBody();
  });
  // Tab from To skips the Cc and Bcc buttons (2026-10-23): to the subject
  // when it is empty, else straight into the message. An open Cc or Bcc
  // field is next as usual.
  toInput.addEventListener("keydown", (ev) => {
    if (ev.key !== "Tab" || ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const open = ["#cc-field", "#bcc-field"].some(sel => { const f = form.querySelector(sel); return f && !f.hidden; });
    if (open) return;
    ev.preventDefault();
    if (!subjectInput.value.trim()) subjectInput.focus();
    else focusBody();
  });
  function reveal(buttonId, fieldId) {
    const btn = form.querySelector(buttonId);
    const field = form.querySelector(fieldId);
    btn.onclick = () => {
      field.hidden = false;
      btn.hidden = true;
      field.querySelector("input").focus();
    };
  }
  reveal("#show-cc", "#cc-field");
  reveal("#show-bcc", "#bcc-field");
  const fileList = form.querySelector("#compose-files");
  const picker = form.querySelector("#compose-file-picker");
  const addFile = form.querySelector("#add-file");
  function rememberFiles() {
    if (ctx.draft) ctx.draft.attachments = [...fileList.querySelectorAll("[data-name]")].map(el => el.dataset.name);
  }
  const staged = ctx.draft ? (ctx.draft.staged = ctx.draft.staged || {}) : (form._staged = form._staged || {});
  const pictureFiles = form._pictureFiles = form._pictureFiles || {};
  // Where the caret was in the message, so a picture lands there after the
  // file picker has taken focus.
  let pictureRange = null;
  const keepCaret = () => {
    const sel = window.getSelection();
    const write = body.querySelector(".body-write") || body;
    if (sel && sel.rangeCount && write.contains(sel.anchorNode)) pictureRange = sel.getRangeAt(0).cloneRange();
  };
  ["keyup", "mouseup", "input"].forEach(name => body.addEventListener(name, keepCaret));
  const changed = () => body.dispatchEvent(new Event("input", { bubbles: true }));
  async function insertPictures(files) {
    const write = body.querySelector(".body-write") || body;
    for (const file of files) {
      let url;
      try { url = await readDataUrl(file); } catch (err) { toast(err.message); continue; }
      const id = "pic" + Math.random().toString(36).slice(2, 10);
      pictureOriginals.set(id, { url, type: file.type || "image/png" });
      const img = document.createElement("img");
      img.alt = file.name;
      img.dataset.pictureId = id;
      img.src = url;
      let fits = false;
      try { fits = await sizeInlinePicture(img, isResizablePicture(file.type) ? "medium" : "original", body); } catch (err) { fits = false; }
      if (!fits) {
        toast("That picture is too large to put in the message. Attach it instead, or pick a smaller size.");
        continue;
      }
      let range = pictureRange && write.contains(pictureRange.startContainer) ? pictureRange : null;
      if (!range) {
        const last = write.lastElementChild && /^(P|DIV)$/.test(write.lastElementChild.tagName) ? write.lastElementChild : write;
        range = document.createRange();
        range.selectNodeContents(last);
        range.collapse(false);
      }
      range.deleteContents();
      range.insertNode(img);
      range.setStartAfter(img);
      range.collapse(true);
      pictureRange = range.cloneRange();
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    }
    changed();
  }
  // The size bar for a picture in the message.
  const picBar = document.createElement("div");
  picBar.className = "pic-size-float";
  picBar.hidden = true;
  form.appendChild(picBar);
  let barFor = null;
  const hideBar = () => { picBar.hidden = true; barFor = null; };
  const showBar = (img) => {
    barFor = img;
    picBar.innerHTML = pictureSizeBar(img.dataset.size || "original", true);
    picBar.hidden = false;
    const at = img.getBoundingClientRect();
    const box = form.getBoundingClientRect();
    picBar.style.left = Math.max(0, at.left - box.left) + "px";
    picBar.style.top = (at.bottom - box.top + 4) + "px";
  };
  body.addEventListener("click", (e) => {
    const img = e.target.closest && e.target.closest("img");
    if (img && !img.closest(".body-sig") && (img.closest(".body-write") || !body.querySelector(".body-write"))) showBar(img);
    else hideBar();
  });
  body.addEventListener("keydown", () => hideBar());
  picBar.addEventListener("mousedown", (e) => e.preventDefault());
  picBar.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    const img = barFor;
    if (!btn || !img) return;
    if (btn.hasAttribute("data-pic-remove")) {
      img.remove();
      hideBar();
      changed();
      return;
    }
    const size = btn.dataset.picSize;
    const fits = await sizeInlinePicture(img, size, body).catch(() => false);
    if (!fits) toast("At that size the pictures are too large for the message. Pick a smaller size, or attach it.");
    if (img.isConnected) showBar(img);
    changed();
  });
  // An attached picture can be sent smaller.
  async function resizeAttached(chip, size) {
    const name = chip.dataset.name;
    const file = pictureFiles[name];
    if (!file) return;
    let next = file;
    if (size !== "original") {
      const scaled = await scaledPicture({ url: await readDataUrl(file), type: file.type }, PICTURE_SIZES[size].attach);
      next = dataUrlFile(scaled.url, name, scaled.type);
    }
    chip.dataset.size = size;
    if (!inDesktop()) return;
    chip.dataset.staging = "1";
    try {
      const item = await stageComposeFile(next);
      if (chip.isConnected) staged[name] = Object.assign(item, { type: next.type, sendName: next.name });
    } catch (err) {
      toast(String(err && err.message || err || "That picture could not be resized."));
    } finally {
      delete chip.dataset.staging;
    }
  }
  fileList.addEventListener("change", (e) => {
    const select = e.target.closest && e.target.closest("select[data-attach-size]");
    const chip = select && select.closest(".file");
    if (chip) resizeAttached(chip, select.value);
  });
  function askPictures(pictures) {
    const old = form.querySelector(".pic-choice");
    if (old) old.remove();
    const bar = document.createElement("div");
    bar.className = "pic-choice";
    bar.setAttribute("role", "group");
    const many = pictures.length > 1;
    bar.innerHTML = `<span>${many ? "Add " + pictures.length + " pictures" : "Add " + esc(pictures[0].name)}</span><button type="button" data-pic-choice="inline">In the message</button><button type="button" data-pic-choice="attach">As ${many ? "attachments" : "an attachment"}</button><button type="button" class="linkish" data-pic-choice="cancel">Cancel</button>`;
    fileList.insertAdjacentElement("beforebegin", bar);
    bar.querySelector("[data-pic-choice=inline]").focus();
    bar.onclick = (e) => {
      const btn = e.target.closest("[data-pic-choice]");
      if (!btn) return;
      bar.remove();
      if (btn.dataset.picChoice === "inline") insertPictures(pictures);
      else if (btn.dataset.picChoice === "attach") attachPicked(pictures);
    };
  }
  if (addFile && picker) {
    addFile.onclick = () => { keepCaret(); picker.click(); };
    picker.addEventListener("change", () => {
      const have = new Set([...fileList.querySelectorAll("[data-name]")].map(el => el.dataset.name));
      const picked = [...picker.files].filter(file => file.name && !have.has(file.name));
      picker.value = "";
      if (!picked.length) return;
      const pictures = picked.filter(file => /^image\//i.test(file.type || ""));
      const rest = picked.filter(file => !pictures.includes(file));
      if (rest.length) attachPicked(rest);
      if (pictures.length) askPictures(pictures);
    });
  }
  function attachPicked(picked) {
    {
      if (inDesktop()) {
        const already = Object.values(staged).reduce((sum, item) => sum + (Number(item.size) || 0), 0);
        const adding = picked.reduce((sum, file) => sum + file.size, 0);
        if (already + adding > ATTACH_LIMIT) {
          toast("That is too much to attach. Microsoft accepts up to 35 MB in one message.");
          return;
        }
      }
      fileList.insertAdjacentHTML("beforeend", fileChips(picked.map(file => file.name)));
      picked.forEach(file => {
        if (!isResizablePicture(file.type)) return;
        pictureFiles[file.name] = file;
        const chip = [...fileList.querySelectorAll("[data-name]")].find(el => el.dataset.name === file.name);
        if (chip) chip.querySelector(".drop-file").insertAdjacentHTML("beforebegin", `<select class="attach-size" data-attach-size aria-label="Size of ${esc(file.name)}">${Object.entries(PICTURE_SIZES).reverse().map(([key, spec]) => `<option value="${key}">${spec.label}</option>`).join("")}</select>`);
      });
      rememberFiles();
      if (!inDesktop()) return;
      picked.forEach(file => {
        const chip = [...fileList.querySelectorAll("[data-name]")].find(el => el.dataset.name === file.name);
        if (chip) chip.dataset.staging = "1";
        stageComposeFile(file).then(item => {
          if (!chip || chip.dataset.size === undefined) staged[file.name] = item;
          if (chip) delete chip.dataset.staging;
        }).catch(err => {
          if (chip) chip.remove();
          rememberFiles();
          toast(String(err && err.message || err || "That file could not be attached."));
        });
      });
    }
  }
  fileList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-drop-file]");
    if (!btn) return;
    const chip = btn.closest(".file");
    if (chip && chip.dataset.name) delete staged[chip.dataset.name];
    chip.remove();
    if (ctx.draft) ctx.draft.attachments = [...fileList.querySelectorAll("[data-name]")].map(el => el.dataset.name);
  });
  body.addEventListener("input", (ev) => {
    // Text copied from Mailroom in dark mode carries the dark pane's
    // background and white text; it is not sent that way (2026-10-23).
    if (ev && ev.inputType === "insertFromPaste") stripThemeColours(body);
    // Typing on after coloured text makes new coloured spans.
    if (body.querySelector("[style*='color']")) markDarkInks(body);
    if (ctx.draft) ctx.draft.bodyHtml = body.innerHTML;
  });
  // Whatever is clicked inside the message box, text goes into the message
  // itself, never below or inside the signature.
  const caretHome = () => {
    const write = body.querySelector(".body-write");
    const sel = window.getSelection();
    if (!write || !sel || (sel.rangeCount && !sel.isCollapsed)) return;
    if (sel.rangeCount && write.contains(sel.anchorNode)) return;
    const last = write.lastElementChild && /^(P|DIV)$/.test(write.lastElementChild.tagName) ? write.lastElementChild : write;
    const range = document.createRange();
    range.selectNodeContents(last);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  };
  body.addEventListener("mouseup", () => setTimeout(caretHome, 0));
  body.addEventListener("focus", () => setTimeout(caretHome, 0));
  body.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.length === 1 || e.key === "Enter" || e.key === "Backspace" || e.key === "Delete" || e.key === "Tab") caretHome();
  });
  const historyBtn = form.querySelector("#show-history");
  const history = form.querySelector("#message-history");
  if (historyBtn && history) {
    historyBtn.onclick = () => {
      const open = history.hidden;
      history.hidden = !open;
      historyBtn.setAttribute("aria-expanded", open ? "true" : "false");
      const label = open ? "Hide message history" : "Show message history";
      historyBtn.title = label;
      historyBtn.setAttribute("aria-label", label);
      if (open) {
        fitWideMail(history);
        history.scrollIntoView({ block: "nearest" });
      }
    };
  }
  const inviteCard = form.querySelector("#compose-invite");
  if (inviteCard) {
    inviteCard.addEventListener("input", () => {
      if (ctx.draft) ctx.draft.meeting = readInvite(form);
    });
    inviteCard.addEventListener("change", () => {
      if (ctx.draft) ctx.draft.meeting = readInvite(form);
    });
    form.querySelector("#invite-remove").onclick = () => {
      if (ctx.draft) ctx.draft.meeting = null;
      inviteCard.remove();
    };
  }
  toInput.addEventListener("input", () => {
    const who = form.querySelector(".invite-who");
    if (!who || !ctx.draft || !ctx.draft.meeting) return;
    const names = addressList(toInput.value).map(recipientLabel);
    const note = ctx.draft.meeting.source === "free"
      ? "Nothing in the thread names a time, so this is a free hour"
      : "Taken from this thread";
    who.textContent = note + (names.length ? " · with " + names.join(", ") : "");
  });
  const helpButton = form.querySelector("#help-write");
  if (helpButton) {
    helpButton.setAttribute("aria-expanded", document.body.dataset.assist === "open" ? "true" : "false");
    helpButton.onclick = () => openAssist();
  }
  form.addEventListener("input", () => {
    if (document.body.dataset.assist === "open" || assistPopped()) publishAssistContext();
  });
  bindColourButtons(form, body, () => { if (ctx.draft) ctx.draft.bodyHtml = body.innerHTML; });
  markDarkInks(body);
  body.addEventListener("paste", pasteIntoCompose);
  form.querySelectorAll(".format-bar [data-cmd]").forEach(btn => {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.onclick = () => {
      const write = body.querySelector(".body-write") || body;
      body.focus();
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !sel.anchorNode || !write.contains(sel.anchorNode)) {
        const range = document.createRange();
        range.selectNodeContents(write);
        range.collapse(false);
        const next = window.getSelection();
        next.removeAllRanges();
        next.addRange(range);
      }
      if (btn.dataset.cmd === "link") {
        const url = window.prompt("Link address", "https://");
        if (url) document.execCommand("createLink", false, url);
      } else if (btn.dataset.cmd === "insertUnorderedList" || btn.dataset.cmd === "insertOrderedList") {
        applyList(write, btn.dataset.cmd === "insertOrderedList");
      } else {
        document.execCommand(btn.dataset.cmd, false, null);
      }
      [...body.childNodes].forEach(node => {
        if (node === write) return;
        if (node.nodeType === 1 && node.dataset && node.dataset.sig) return;
        write.appendChild(node);
      });
      tidyLists(write);
      if (ctx.draft) ctx.draft.bodyHtml = body.innerHTML;
    };
  });
  function payload() {
    const meeting = readInvite(form);
    if (ctx.draft) ctx.draft.meeting = meeting;
    return {
      from: chosenFrom(),
      to: parseAddresses(toInput.value).join("; "),
      cc: parseAddresses(form.querySelector("#compose-cc").value).join("; "),
      bcc: parseAddresses(form.querySelector("#compose-bcc").value).join("; "),
      attachments: [...form.querySelectorAll("#compose-files [data-name]")].map(el => el.dataset.name),
      subject: subjectInput.value,
      bodyHtml: sentBody(form),
      draftHtml: (form.querySelector(".body-write") || body).innerHTML,
      meeting,
      draftId: ctx.draft && ctx.draft.draftId,
      replyTo: form.dataset.kind === "reply" ? (form.dataset.msg || "") : "",
      replyMode: composeMode(form, ctx),
      sendAt: form.dataset.sendAt || "",
      importance: form.dataset.importance || "",
      readReceipt: form.dataset.receipt === "1",
      followUp: Number(form.dataset.followUp) || 0,
      serverDraftId: (ctx.draft && ctx.draft.serverDraftId) || "",
      files: stagedFilesFor(form, ctx.draft ? ctx.draft.staged : form._staged)
    };
  }
  form.querySelector("#cancel").onclick = () => {
    confirmDiscard(() => {
      if (ctx.draft) {
        clearTimeout(ctx.draft._saveTimer);
        ctx.draft._closed = true;
        ctx.draft._sentWith = "";
      }
      discardServerDraft(ctx.draft);
      if (ctx.mode === "pop") {
        localStorage.setItem("outlook-mock-mail-event", JSON.stringify({ type: "discard", draftId: ctx.draft && ctx.draft.draftId }));
        localStorage.removeItem("outlook-mock-reply");
        closeComposeWindow();
        return;
      }
      if (ctx.mode === "pane") {
        paneCompose = null;
        render();
        return;
      }
      if (ctx.mode === "inline") {
        discardInlineReply();
        return;
      }
      closePop();
    });
  };
  bindDraftAutosave(ctx, form, payload);
  const popOut = form.querySelector("#pop-out");
  if (popOut) popOut.onclick = () => { popOutCompose(form, ctx); };
  // Message options: importance and a read receipt.
  const optionsBtn = form.querySelector("#send-options");
  if (ctx.draft && ctx.draft.importance) form.dataset.importance = ctx.draft.importance;
  if (ctx.draft && ctx.draft.readReceipt) form.dataset.receipt = "1";
  if (ctx.draft && ctx.draft.followUp > Date.now()) form.dataset.followUp = String(ctx.draft.followUp);
  const paintOptions = () => {
    if (!optionsBtn) return;
    const level = form.dataset.importance || "";
    optionsBtn.dataset.importance = level;
    const followUp = Number(form.dataset.followUp) || 0;
    optionsBtn.classList.toggle("on", !!level || form.dataset.receipt === "1" || !!followUp);
    const bits = [level === "high" ? "High importance" : level === "low" ? "Low importance" : "", form.dataset.receipt === "1" ? "Read receipt" : "", followUp ? "Follow up " + followUpWhen(followUp) : ""].filter(Boolean);
    optionsBtn.title = bits.length ? "Message options: " + bits.join(", ") : "Message options";
    let tag = form.querySelector(".importance-tag");
    if (!tag) {
      tag = document.createElement("span");
      tag.className = "importance-tag";
      const subject = form.querySelector("#compose-subject");
      if (subject) subject.insertAdjacentElement("afterend", tag);
    }
    tag.hidden = !bits.length;
    tag.textContent = bits.join(" · ");
    if (ctx.draft) { ctx.draft.importance = level; ctx.draft.readReceipt = form.dataset.receipt === "1"; ctx.draft.followUp = followUp; }
  };
  paintOptions();
  if (optionsBtn) {
    const menu = document.createElement("div");
    menu.className = "send-options-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;
    optionsBtn.insertAdjacentElement("afterend", menu);
    const paintMenu = () => {
      const level = form.dataset.importance || "";
      menu.innerHTML = `<button type="button" role="menuitemcheckbox" data-opt="high" aria-checked="${level === "high"}"><span class="imp-high" aria-hidden="true">!</span>High importance</button><button type="button" role="menuitemcheckbox" data-opt="low" aria-checked="${level === "low"}"><span class="imp-low" aria-hidden="true">↓</span>Low importance</button><button type="button" role="menuitemcheckbox" data-opt="receipt" aria-checked="${form.dataset.receipt === "1"}"><span aria-hidden="true">✓</span>Request a read receipt</button><button type="button" role="menuitemcheckbox" data-opt="followup" aria-checked="${!!Number(form.dataset.followUp)}"><span aria-hidden="true">⏰</span>Remind me if no reply…</button>`;
    };
    const closeMenu = () => { menu.hidden = true; document.removeEventListener("mousedown", outside, true); };
    function outside(ev) { if (!menu.contains(ev.target) && ev.target !== optionsBtn && !optionsBtn.contains(ev.target)) closeMenu(); }
    optionsBtn.onclick = () => {
      if (!menu.hidden) return closeMenu();
      paintMenu();
      menu.hidden = false;
      const at = optionsBtn.getBoundingClientRect();
      menu.style.left = Math.max(8, Math.min(at.left, innerWidth - menu.offsetWidth - 8)) + "px";
      menu.style.top = (at.bottom + 4) + "px";
      document.addEventListener("mousedown", outside, true);
    };
    menu.addEventListener("click", async (ev) => {
      const btn = ev.target.closest("[data-opt]");
      if (!btn) return;
      const opt = btn.dataset.opt;
      if (opt === "followup") {
        if (Number(form.dataset.followUp)) delete form.dataset.followUp;
        else {
          closeMenu();
          const when = await pickTime("Remind me if no reply", "If nobody you sent this to has answered by then, Mailroom reminds you. It checks while it is open.", followUpPresets(), "Remind me");
          if (!when) return;
          form.dataset.followUp = String(when.getTime());
        }
      } else if (opt === "receipt") {
        if (form.dataset.receipt === "1") delete form.dataset.receipt; else form.dataset.receipt = "1";
      } else if (form.dataset.importance === opt) delete form.dataset.importance;
      else form.dataset.importance = opt;
      paintOptions();
      paintMenu();
      body.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  // Templates: insert one at the caret, or save this message as one.
  const templatesBtn = form.querySelector("#compose-templates");
  if (templatesBtn) {
    const tmenu = document.createElement("div");
    tmenu.className = "send-options-menu templates-menu";
    tmenu.setAttribute("role", "menu");
    tmenu.hidden = true;
    templatesBtn.insertAdjacentElement("afterend", tmenu);
    let savedRange = null;
    const keep = () => {
      const sel = window.getSelection();
      const write = body.querySelector(".body-write") || body;
      if (sel && sel.rangeCount && write.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
    };
    ["keyup", "mouseup", "input"].forEach(n => body.addEventListener(n, keep));
    const closeT = () => { tmenu.hidden = true; document.removeEventListener("mousedown", outsideT, true); };
    function outsideT(ev) { if (!tmenu.contains(ev.target) && !templatesBtn.contains(ev.target)) closeT(); }
    templatesBtn.onclick = () => {
      if (!tmenu.hidden) return closeT();
      keep();
      const list = loadTemplates();
      tmenu.innerHTML = (list.length ? list.map(t => `<button type="button" role="menuitem" data-use-template="${esc(t.id)}"><span></span>${esc(t.name)}</button>`).join("") : `<p class="menu-note">No templates yet.</p>`)
        + `<div class="menu-rule"></div><button type="button" role="menuitem" data-template-save><span></span>Save this message as a template</button><button type="button" role="menuitem" data-template-manage><span></span>Manage templates</button>`;
      tmenu.hidden = false;
      const at = templatesBtn.getBoundingClientRect();
      tmenu.style.left = Math.max(8, Math.min(at.left, innerWidth - tmenu.offsetWidth - 8)) + "px";
      tmenu.style.top = (at.bottom + 4) + "px";
      document.addEventListener("mousedown", outsideT, true);
    };
    tmenu.addEventListener("mousedown", (ev) => ev.preventDefault());
    tmenu.addEventListener("click", (ev) => {
      const use = ev.target.closest("[data-use-template]");
      if (use) {
        const t = loadTemplates().find(x => x.id === use.dataset.useTemplate);
        closeT();
        if (!t) return;
        const write = body.querySelector(".body-write") || body;
        let range = savedRange && write.contains(savedRange.startContainer) ? savedRange : null;
        if (!range) {
          range = document.createRange();
          const first = write.firstElementChild;
          // An empty message: replace the blank first line.
          if (first && !write.textContent.trim() && !write.querySelector("img")) range.selectNodeContents(write);
          else { range.selectNodeContents(write); range.collapse(false); }
        }
        const holder = document.createElement("template");
        holder.innerHTML = htmlFor(t.html);
        range.deleteContents();
        range.insertNode(holder.content);
        const subject = form.querySelector("#compose-subject");
        if (subject && !subject.value.trim() && t.subject) subject.value = t.subject;
        body.dispatchEvent(new Event("input", { bubbles: true }));
        toast("Inserted — " + t.name);
        return;
      }
      if (ev.target.closest("[data-template-save]")) {
        closeT();
        const write = body.querySelector(".body-write") || body;
        if (!plainFromHtml(write.innerHTML).trim()) return toast("Write the message first, then save it as a template.");
        const name = window.prompt("Name this template", (form.querySelector("#compose-subject") || {}).value || "");
        if (!name || !name.trim()) return;
        if (upsertTemplate({ name, subject: (form.querySelector("#compose-subject") || {}).value || "", html: write.innerHTML })) toast("Saved as a template — " + name.trim());
        return;
      }
      if (ev.target.closest("[data-template-manage]")) {
        closeT();
        settingsPage = "templates";
        editingTemplate = null;
        if (popCompose) { toast("Templates are in Settings in the main window."); return; }
        setView("settings");
      }
    });
  }
  const laterBtn = form.querySelector("#send-later");
  if (laterBtn) laterBtn.onclick = async () => {
    const fromPick = form.querySelector("#compose-from");
    if (fromPick && isGoogleAccount(fromAccountId(fromPick.value))) return toast("Gmail can't hold a message to send later from Mailroom. Send it now instead.");
    const problem = recipientProblem(form);
    if (problem) { problem.field.setAttribute("aria-invalid", "true"); problem.field.focus(); return toast(problem.text); }
    const when = await pickTime("Send later", "The message waits on Microsoft's server, so Mailroom does not need to be open.", sendLaterPresets(), "Schedule");
    if (!when) return;
    form.dataset.sendAt = utcStamp(when);
    form.requestSubmit();
    delete form.dataset.sendAt;
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (form.querySelector("#compose-files [data-staging]")) {
      toast("Wait a moment. A file is still being attached.");
      return;
    }
    // Send later sets this just for the submit; keep it across the check.
    const sendAtChosen = form.dataset.sendAt || "";
    const problem = recipientProblem(form);
    if (problem) {
      problem.field.setAttribute("aria-invalid", "true");
      const box = problem.field.closest(".field, label");
      if (box && box.hidden) box.hidden = false;
      problem.field.focus();
      toast(problem.text);
      return;
    }
    if (form.dataset.checking) return;
    form.dataset.checking = "1";
    let go = true;
    try {
      go = await spellingAllowsSend(form, fromSelect.value);
      // A draft save on its way could land between the send's own save
      // and the send, and send older text: let it finish first.
      while (go && ctx.draft && ctx.draft._saving) await new Promise(r => setTimeout(r, 100));
    } finally { delete form.dataset.checking; }
    if (!go) {
      const write = form.querySelector(".body-write") || form.querySelector("#compose-body");
      if (write) write.focus();
      return;
    }
    if (sendAtChosen) form.dataset.sendAt = sendAtChosen;
    if (ctx.draft) clearTimeout(ctx.draft._saveTimer);
    const fields = payload();
    delete form.dataset.sendAt;
    const closeDraft = () => {
      if (!ctx.draft) return;
      ctx.draft._closed = true;
      ctx.draft._sentWith = fields.serverDraftId || "";
    };
    if (ctx.mode === "pop") {
      closeDraft();
      localStorage.setItem("outlook-mock-mail-event", JSON.stringify({ type: "queued", delay: sendDelay, ...fields }));
      localStorage.removeItem("outlook-mock-reply");
      closeComposeWindow();
      return;
    }
    const message = queueOutgoing(fields, sendDelay);
    if (!message) return;
    closeDraft();
    if (ctx.mode === "inline") replyDraft = null;
    else if (ctx.mode === "pane") paneCompose = null;
    else closePop();
    if (message.pendingSend && !fields.sendAt) toastPending(message);
    else if (!fields.sendAt) toast(fields.meeting ? "Invite sent · " + fields.meeting.title : "Sent from " + (accounts[fromAccountId(fields.from)] || {}).name);
    setView("mail");
  };
}

function openCompose(msg) {
  if (msg && msg.id) {
    startReply(msg);
    return;
  }
  const preferred = activeDefaultEmail();
  const fromId = (msg && accountInProfile(msg.account)) ? msg.account : composeAccountId(preferred && preferred.accountId);
  // A mailto: link arrives as fields: to, cc, bcc, subject and bodyHtml.
  const fields = (msg && msg.fields) || {};
  paneCompose = {
    to: fields.to || ((msg && msg.email) ? msg.email : ""),
    from: fromId,
    cc: fields.cc || "",
    bcc: fields.bcc || "",
    attachments: [],
    subject: fields.subject || "",
    bodyHtml: fields.bodyHtml || "<p><br></p>"
  };
  document.body.dataset.open = "1";
  // Words typed so far live in the form, not in the draft, so a second New
  // mail has the same stamp as the first paint. The reading pane would skip
  // the redraw and leave the form that was just removed.
  const openForm = reading.querySelector("form.pane-compose");
  if (openForm) openForm.remove();
  reading.dataset.paint = "";
  if (view !== "mail") setView("mail");
  else renderReading();
  const to = document.getElementById("compose-to");
  if (to && !to.value) to.focus();
  else {
    const subject = document.getElementById("compose-subject");
    if (subject) subject.focus();
  }
}

function readStoredCompose(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { return null; }
}

function openPopCompose() {
  const kind = params.get("compose") === "reply" ? "reply" : "new";
  const msgId = params.get("msg") || "";
  const saved = readStoredCompose("outlook-mock-compose");
  const legacy = readStoredCompose("outlook-mock-reply");
  let draft = null;
  if (saved && saved.kind === kind && (!msgId || !saved.msgId || saved.msgId === msgId)) draft = saved;
  else if (kind === "reply" && legacy && (!msgId || legacy.msgId === msgId)) draft = Object.assign({ kind: "reply" }, legacy);
  if (saved && (!msgId || saved.msgId === msgId)) adoptPopOriginals(saved.originals);
  if (!draft && kind === "reply") {
    const msg = messages.find(m => m.id === msgId);
    if (!msg) {
      popRoot.innerHTML = `<div class="pop-compose"><p>That message is not in this mock.</p></div>`;
      return;
    }
    draft = {
      kind: "reply",
      msgId: msg.id,
      to: msg.email,
      from: msg.account,
      subject: "Re: " + cleanSubject(msg.subject),
      bodyHtml: "<p><br></p>"
    };
  }
  if (!draft) {
    const preferred = activeDefaultEmail();
    draft = {
      kind: "new",
      from: composeAccountId(preferred && preferred.accountId),
      to: "",
      subject: "",
      bodyHtml: "<p><br></p>"
    };
  }
  popRoot.innerHTML = `<div class="pop-compose">${composeMarkup({
    mode: "pop",
    title: kind === "reply" ? "Reply" : "New message",
    msgId: draft.msgId || msgId,
    fromId: composeFromKey(draft.from),
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    attachments: draft.attachments,
    subject: draft.subject,
    bodyHtml: draft.bodyHtml,
    meeting: draft.meeting,
    kind,
    openHistory: true
  })}</div>`;
  bindCompose(popRoot, { mode: "pop", kind, draft });
  const toField = document.getElementById("compose-to");
  if (toField && !toField.value.trim()) toField.focus();
  else {
    const write = document.querySelector("#compose-body .body-write") || document.getElementById("compose-body");
    if (write) write.focus();
  }
}

function refreshOpenComposeFrom() {
  if (!popCompose || !Object.keys(accounts).length) return;
  const select = document.getElementById("compose-from");
  if (!select) return;
  const saved = readStoredCompose("outlook-mock-compose");
  const wanted = composeFromKey(saved && saved.from);
  select.innerHTML = fromOptions(wanted);
  if (!wanted) return;
  select.value = wanted;
  select.dispatchEvent(new Event("change"));
}

function closePop() { popRoot.innerHTML = ""; }

function confirmDiscard(done) {
  if (document.getElementById("discard-confirm")) return;
  const layer = document.createElement("div");
  layer.id = "discard-confirm";
  layer.innerHTML = `
    <div class="backdrop dim" data-discard-dismiss></div>
    <form class="dialog" role="dialog" aria-modal="true" aria-label="Discard message">
      <h2>Discard this message?</h2>
      <p class="dialog-note">This draft will be discarded.</p>
      <div class="dialog-actions">
        <button class="ghost" type="button" data-discard-dismiss>Cancel</button>
        <button class="primary danger" type="submit">Discard</button>
      </div>
    </form>`;
  document.body.appendChild(layer);
  const close = () => {
    document.removeEventListener("keydown", onKey);
    layer.remove();
  };
  function onKey(ev) {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    close();
  }
  document.addEventListener("keydown", onKey);
  layer.querySelectorAll("[data-discard-dismiss]").forEach(el => {
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      close();
    });
  });
  layer.querySelector("form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    close();
    done();
  });
  layer.querySelector(".primary").focus();
}

let toastTimer;
function toast(text, action) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.onclick = () => { el.remove(); action.run(); };
    el.appendChild(btn);
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), action ? 6000 : 2200);
}

// The last move, so it can be undone: the messages and where each was.
let lastMove = null;
let undoing = false;

function toastMove(text) {
  toast(text, lastMove ? { label: "Undo", run: undoLastMove } : null);
}

async function undoLastMove() {
  const move = lastMove;
  if (!move || Date.now() - move.at > 5 * 60 * 1000) return;
  lastMove = null;
  // A server move must finish first: it gives the message a new id.
  try { await move.pending; } catch (e) {}
  const byBox = new Map();
  move.items.forEach(({ message, box: from }) => {
    if (!messages.includes(message) || messageBox(message) === from) return;
    if (!byBox.has(from)) byBox.set(from, []);
    byBox.get(from).push(message);
  });
  undoing = true;
  try {
    byBox.forEach((list, from) => {
      const byAccount = new Map();
      list.forEach(m => { if (!byAccount.has(m.account)) byAccount.set(m.account, []); byAccount.get(m.account).push(m); });
      byAccount.forEach(group => moveConversation({ messages: group }, from));
    });
  } finally {
    undoing = false;
  }
  toast("Undone");
}

function toastPending(message) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.replaceChildren();
  const label = document.createElement("span");
  label.textContent = "Sending";
  const undo = document.createElement("button");
  undo.type = "button";
  undo.id = "toast-undo";
  undo.textContent = "Undo";
  undo.onclick = () => undoPending(message.id);
  el.append(label, undo);
  clearTimeout(toastTimer);
  const left = Math.max(0, (message.sendAt || Date.now()) - Date.now());
  toastTimer = setTimeout(() => { if (el.isConnected) el.remove(); }, left + 400);
}

function setView(next) {
  view = next;
  document.body.dataset.view = view;
  document.getElementById("rail-mail").setAttribute("aria-pressed", view === "mail");
  document.getElementById("rail-cal").setAttribute("aria-pressed", view === "calendar");
  document.getElementById("rail-people").setAttribute("aria-pressed", view === "people");
  document.getElementById("rail-settings").setAttribute("aria-pressed", view === "settings");
  // One box for everything (2026-10-25): it no longer changes with the view.
  const split = document.getElementById("pane-split");
  if (split) split.setAttribute("aria-label", view === "people" ? "Resize the contact list" : "Resize the message list");
  render();
}

function applyMailEvent() {
  // Only the main window takes a queued send; a pop-out taking it first
  // would lose it when closed.
  if (popCompose || assistWindow) return;
  const raw = localStorage.getItem("outlook-mock-mail-event");
  if (!raw) return;
  localStorage.removeItem("outlook-mock-mail-event");
  let ev;
  try { ev = JSON.parse(raw); } catch (e) { return; }
  if (ev.type === "discard" && ev.draftId) {
    const draft = messages.find(m => m.id === ev.draftId);
    if (draft) {
      draft.previousBox = "drafts";
      draft.box = "trash";
    }
  }
  if (ev.type === "queued" || ev.type === "sent") {
    const message = queueOutgoing(ev, ev.type === "sent" ? 0 : Number(ev.delay));
    if (message && message.pendingSend) toastPending(message);
    else if (message) {
      toast(ev.meeting ? "Invite sent · " + ev.meeting.title : "Sent from " + accounts[ev.from].name);
    }
    setView("mail");
    return;
  }
  render();
}

function render() {
  closeCalendarColour();
  capturePaneCompose();
  if (view === "mail") captureReplyDraft();
  document.body.dataset.view = view;
  renderFolders();
  reportUnread(false);
  if (view === "settings") {
    renderSettings();
    return;
  }
  if (view === "people") {
    renderContacts();
    renderContact();
  } else {
    renderList();
    renderReading();
  }
  if (view === "calendar") renderCalendar();
  paintFollowUps();
  paintSearchExtras();
}

const mailFilterEl = document.getElementById("mail-filter");
mailFilterEl.value = mailFilter;
document.querySelectorAll("[data-focus-tab]").forEach(btn => {
  btn.onclick = () => {
    focusTab = btn.dataset.focusTab === "other" ? "other" : "focused";
    selected = null;
    render();
  };
});

mailFilterEl.onchange = () => {
  mailFilter = mailFilterEl.value;
  keptRead = null;
  render();
};
let folderScopeChosen = false;
let searchScopeAuto = false;
let searchCacheLoad = null;
let searchFromCache = false;
let searchCacheMiss = false;
let searchCacheStale = false;
let searchCacheKey = "";
let searchCursor = { before: "", beforeId: "", more: false };
const searchResultIds = new Set();

function searchAccountIds() {
  if (searchAccount) return accountInProfile(searchAccount) ? [searchAccount] : [];
  if (account === "all") return profileAccountIds();
  return accountInProfile(account) ? [account] : [];
}

function currentSearchKey() {
  const parts = currentSearchParts();
  const ids = searchAccountIds().filter(id => accounts[id] && accounts[id].signedIn && accounts[id].email);
  return [
    activeProfile,
    ids.map(id => id + "\t" + (accounts[id].name || "") + "\t" + accounts[id].email).join(","),
    searchScope === "all" ? "*" : box,
    searchFiles || "",
    mailFilter || "",
    parts.words.slice(0, 8).join(" "),
    parts.phrases.slice(0, 4).join("|"),
    parts.from || "",
    parts.to || "",
    String(new Date().getTimezoneOffset())
  ].join("\n");
}

function dropSearchCachedMessages() {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].searchCached) messages.splice(i, 1);
  }
}

function invalidateSearchHits() {
  searchFromCache = false;
  searchCacheMiss = false;
  searchCacheStale = false;
  searchCacheKey = "";
  searchCursor = { before: "", beforeId: "", more: false };
  searchResultIds.clear();
  dropSearchCachedMessages();
}

function takeSearchHit(accountId, item, boxKey) {
  if (!item || !item.id) return;
  searchResultIds.add(searchHitKey(accountId, item.id));
  const existing = messages.find(m => m.account === accountId && m.id === item.id);
  if (existing) return;
  const message = liveMessage(accountId, item, boxKey || "inbox");
  message.searchCached = true;
  messages.push(message);
}

function mergeSearchRows(pages) {
  const rows = [];
  pages.forEach(entry => {
    const list = entry.page.messages || [];
    const boxes = entry.page.boxes || [];
    list.forEach((item, index) => rows.push({ accountId: entry.id, item, box: boxes[index] || "inbox" }));
  });
  rows.sort((a, b) => {
    const ar = String(a.item.received || "");
    const br = String(b.item.received || "");
    if (ar !== br) return ar < br ? 1 : -1;
    const ai = String(a.item.id || "");
    const bi = String(b.item.id || "");
    return ai < bi ? 1 : ai > bi ? -1 : 0;
  });
  const more = pages.some(entry => entry.page.more) || rows.length > MAIL_PAGE_SIZE;
  return { shown: rows.slice(0, MAIL_PAGE_SIZE), more };
}

async function runSearchQuery(key, before, beforeId) {
  const parts = currentSearchParts();
  const zone = new Date().getTimezoneOffset();
  const boxKey = searchScope === "all" ? "" : box;
  const pages = await Promise.all(searchAccountIds().map(async id => {
    const acct = accounts[id];
    if (!acct || !acct.signedIn || !acct.email) return null;
    try {
      const page = await tauriInvoke("search_cached", {
        email: acct.email,
        boxKey,
        box_key: boxKey,
        words: parts.words.slice(0, 8),
        phrases: parts.phrases.slice(0, 4),
        accountName: acct.name || "",
        account_name: acct.name || "",
        fromDay: parts.from || "",
        from_day: parts.from || "",
        toDay: parts.to || "",
        to_day: parts.to || "",
        zoneOffset: zone,
        zone_offset: zone,
        files: searchFiles === "yes" || searchFiles === "no" ? searchFiles : "",
        unreadOnly: mailFilter === "unread",
        unread_only: mailFilter === "unread",
        readOnly: mailFilter === "read",
        read_only: mailFilter === "read",
        flaggedOnly: mailFilter === "flagged",
        flagged_only: mailFilter === "flagged",
        inviteOnly: mailFilter === "events",
        invite_only: mailFilter === "events",
        limit: MAIL_PAGE_SIZE,
        before: before || "",
        beforeId: beforeId || "",
        before_id: beforeId || ""
      });
      if (!page || !Array.isArray(page.messages)) return { id, error: true };
      return { id, page };
    } catch (err) {
      return { id, error: true };
    }
  }));
  if (!searchActive() || searchCacheKey !== key) return;
  const rows = pages.filter(item => item && item.page);
  const errors = pages.filter(item => item && item.error);
  const tried = pages.filter(Boolean);
  if (!rows.length && errors.length && errors.length === tried.length) {
    if (!before) {
      searchCacheMiss = true;
      searchFromCache = false;
    }
    return;
  }
  const merged = mergeSearchRows(rows);
  if (!before) {
    searchResultIds.clear();
    dropSearchCachedMessages();
  }
  merged.shown.forEach(row => takeSearchHit(row.accountId, row.item, row.box));
  const cursor = oldestCursor(merged.shown.map(row => row.item));
  if (before) {
    const older = cursor.before && (cursor.before < before || (cursor.before === before && String(cursor.beforeId || "") < String(beforeId || "")));
    searchCursor = {
      before: cursor.before || searchCursor.before,
      beforeId: cursor.before ? cursor.beforeId : searchCursor.beforeId,
      more: !!(merged.more && older)
    };
  } else {
    searchCursor = { before: cursor.before, beforeId: cursor.beforeId, more: !!(merged.more && cursor.before) };
    searchFromCache = true;
    searchCacheMiss = false;
    const visible = conversations();
    if (!visible.some(c => c.messages.some(m => m.id === selected))) {
      selected = (visible[0] && visible[0].latest.id) || null;
      expanded.clear();
      folded.clear();
    }
  }
  if (view === "mail") render();
}

function ensureSearchCache() {
  if (!inDesktop() || !searchActive()) {
    if (searchFromCache || searchCacheKey || searchResultIds.size) invalidateSearchHits();
    return null;
  }
  const key = currentSearchKey();
  if (key === searchCacheKey && (searchFromCache || searchCacheLoad || searchCacheMiss)) {
    if (searchFromCache && searchCacheStale && !searchCacheLoad) {
      searchCacheStale = false;
      const job = runSearchQuery(key, "", "");
      searchCacheLoad = job;
      job.finally(() => { if (searchCacheLoad === job) searchCacheLoad = null; });
      return job;
    }
    return searchCacheLoad;
  }
  searchFromCache = false;
  searchCacheMiss = false;
  searchCacheStale = false;
  searchCursor = { before: "", beforeId: "", more: false };
  searchResultIds.clear();
  dropSearchCachedMessages();
  searchCacheKey = key;
  const job = runSearchQuery(key, "", "");
  searchCacheLoad = job;
  job.finally(() => { if (searchCacheLoad === job) searchCacheLoad = null; });
  return job;
}

function loadOlderSearch() {
  if (!inDesktop() || !searchActive() || !searchFromCache || !searchCursor.more || !searchCursor.before || searchCacheLoad) return Promise.resolve();
  const key = searchCacheKey;
  const before = searchCursor.before;
  const beforeId = searchCursor.beforeId || "";
  const job = runSearchQuery(key, before, beforeId);
  searchCacheLoad = job;
  job.finally(() => { if (searchCacheLoad === job) searchCacheLoad = null; });
  return job;
}

function widenSearchScope() {
  if (folderScopeChosen || !query.trim() || searchScope === "all") return;
  searchScope = "all";
  searchScopeAuto = true;
  const scope = document.getElementById("search-scope");
  if (scope) scope.value = "all";
}

function restoreSearchScope() {
  if (!searchScopeAuto || query.trim()) return;
  searchScope = "";
  searchScopeAuto = false;
  const scope = document.getElementById("search-scope");
  if (scope) scope.value = "";
}

function applySearch() {
  if (view === "people") {
    renderContacts();
    renderContact();
    return;
  }
  if (query.trim()) widenSearchScope();
  else restoreSearchScope();
  if (view === "mail") ensureSearchCache();
  const visible = conversations();
  if (!visible.some(c => c.messages.some(m => m.id === selected))) {
    selected = visible[0]?.latest.id || null;
    expanded.clear();
      folded.clear();
  }
  renderList();
  paintSearchExtras();
  if (view === "mail") renderReading();
}
function readSearchControls() {
  searchScope = document.getElementById("search-scope").value;
  searchAccount = document.getElementById("search-account").value;
  searchFiles = document.getElementById("search-files").value;
  searchFrom = document.getElementById("search-from").value;
  searchTo = document.getElementById("search-to").value;
  const on = !!(searchScope === "all" || searchAccount || searchFiles || searchFrom || searchTo);
  document.getElementById("search-toggle").dataset.on = on ? "true" : "false";
  applySearch();
}
let searchPick = "";
function paintSearchSuggest() {
  const box = document.getElementById("q-suggest");
  const q = (document.getElementById("q").value || "").trim();
  if (!box || !q || q === searchPick || !document.getElementById("search-panel").hidden) {
    if (box) { box.hidden = true; box.innerHTML = ""; }
    return;
  }
  const hits = peopleMatches(q, 6);
  if (!hits.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML = personSuggestHtml(hits);
  box.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.onclick = () => {
      const email = btn.dataset.email.toLowerCase();
      const contact = contacts.find(person => person.email.toLowerCase() === email);
      box.hidden = true;
      if (view === "people" && contact) {
        if (contactAccount !== "all" && contactAccount !== contact.account) contactAccount = contact.account;
        selectedContact = contact.id;
        searchPick = "";
        query = "";
        document.getElementById("q").value = "";
        render();
        return;
      }
      searchPick = btn.dataset.name;
      query = btn.dataset.name;
      document.getElementById("q").value = btn.dataset.name;
      searchScope = "all";
      const scope = document.getElementById("search-scope");
      if (scope) scope.value = "all";
      document.getElementById("search-toggle").dataset.on = "true";
      if (view !== "mail") setView("mail");
      else applySearch();
    };
  });
}
// Mail is searched when Enter is pressed, not on every key (2026-10-23).
// Clearing the box shows the folder again at once; contacts still filter
// as you type.
document.getElementById("q").addEventListener("input", (e) => {
  searchPick = "";
  const value = e.target.value;
  if (view === "people" || (!value.trim() && query.trim())) {
    query = value;
    applySearch();
  }
  paintSearchSuggest();
});
document.getElementById("q").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  e.preventDefault();
  searchPick = "";
  query = e.target.value;
  const box = document.getElementById("q-suggest");
  if (box) { box.hidden = true; box.innerHTML = ""; }
  applySearch();
});
const searchPanel = document.getElementById("search-panel");
document.getElementById("search-toggle").onclick = (e) => {
  e.preventDefault();
  e.stopPropagation();
  searchPanel.hidden = !searchPanel.hidden;
  document.getElementById("search-toggle").setAttribute("aria-expanded", searchPanel.hidden ? "false" : "true");
  paintSearchSuggest();
};
["search-scope", "search-account", "search-files", "search-from", "search-to"].forEach(id => {
  document.getElementById(id).addEventListener("change", () => {
    if (id === "search-scope") {
      folderScopeChosen = true;
      searchScopeAuto = false;
    }
    readSearchControls();
  });
});
document.getElementById("search-clear").onclick = () => {
  folderScopeChosen = false;
  searchScopeAuto = false;
  document.getElementById("search-scope").value = "";
  document.getElementById("search-account").value = "";
  document.getElementById("search-files").value = "";
  document.getElementById("search-from").value = "";
  document.getElementById("search-to").value = "";
  readSearchControls();
};
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search-wrap")) {
    searchPanel.hidden = true;
    const found = document.getElementById("q-suggest");
    if (found) { found.hidden = true; found.innerHTML = ""; }
  }
});
document.getElementById("rail-mail").onclick = () => setView("mail");
document.getElementById("rail-cal").onclick = () => setView("calendar");
document.getElementById("rail-people").onclick = () => setView("people");
document.getElementById("rail-settings").onclick = () => showSettings("accounts");
document.getElementById("hide-folders").onclick = () => setFoldersOpen(document.body.dataset.folders === "closed");
document.getElementById("check-mail").onclick = () => checkMailNow();
document.getElementById("show-cal-folders").onclick = () => setFoldersOpen(true);
document.getElementById("show-mail-folders").onclick = () => setFoldersOpen(true);
function setFoldersOpen(open) {
  document.body.dataset.folders = open ? "open" : "closed";
  const btn = document.getElementById("hide-folders");
  const label = open ? "Hide folders" : "Show folders";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}
setFoldersOpen(true);

const LIST_WIDTH_DEFAULT = 360;
const LIST_WIDTH_MIN = 280;
const READING_MIN = 320;
let preferredListWidth = LIST_WIDTH_DEFAULT;
try {
  const savedListWidth = parseInt(localStorage.getItem("mailroom-list-width"), 10);
  if (savedListWidth >= LIST_WIDTH_MIN && savedListWidth <= 1600) preferredListWidth = savedListWidth;
} catch (e) {}

function maxListWidth() {
  const shell = document.querySelector(".shell");
  if (!shell || shell.clientWidth < 480) return 1600;
  const folders = document.getElementById("folders");
  const split = document.getElementById("pane-split");
  const folderWidth = folders ? folders.getBoundingClientRect().width : 220;
  const splitWidth = split && getComputedStyle(split).display !== "none" ? split.getBoundingClientRect().width : 8;
  return Math.max(LIST_WIDTH_MIN, Math.floor(shell.clientWidth - 48 - folderWidth - splitWidth - READING_MIN));
}

function applyListWidth(preferred, save) {
  preferredListWidth = Math.round(Math.min(1600, Math.max(LIST_WIDTH_MIN, preferred)));
  const width = Math.min(maxListWidth(), preferredListWidth);
  document.documentElement.style.setProperty("--list-width", width + "px");
  const split = document.getElementById("pane-split");
  if (split) {
    split.setAttribute("aria-valuenow", String(width));
    split.setAttribute("aria-valuemin", String(LIST_WIDTH_MIN));
    split.setAttribute("aria-valuemax", String(maxListWidth()));
  }
  if (save) {
    try { localStorage.setItem("mailroom-list-width", String(preferredListWidth)); } catch (e) {}
  }
  const readingPane = document.getElementById("reading");
  if (readingPane) fitWideMail(readingPane);
  return width;
}

// The folder pane's width, dragged at its edge and remembered (2026-10-23).
const FOLDERS_WIDTH = { min: 180, max: 420, start: 220 };
function applyFoldersWidth(width, save) {
  const w = Math.round(Math.min(FOLDERS_WIDTH.max, Math.max(FOLDERS_WIDTH.min, Number(width) || FOLDERS_WIDTH.start)));
  document.documentElement.style.setProperty("--folders-width", w + "px");
  if (save) { try { localStorage.setItem("mailroom-folders-width", String(w)); } catch (e) {} }
  const handle = document.getElementById("folders-split");
  if (handle) handle.setAttribute("aria-valuenow", String(w));
  return w;
}

function bindFoldersSplit() {
  const split = document.getElementById("folders-split");
  if (!split) return;
  try { const saved = Number(localStorage.getItem("mailroom-folders-width")); if (saved) applyFoldersWidth(saved, false); } catch (e) {}
  split.setAttribute("aria-valuemin", String(FOLDERS_WIDTH.min));
  split.setAttribute("aria-valuemax", String(FOLDERS_WIDTH.max));
  let dragging = false, startX = 0, startWidth = FOLDERS_WIDTH.start;
  const current = () => { const pane = document.getElementById("folders"); return pane ? pane.getBoundingClientRect().width : FOLDERS_WIDTH.start; };
  split.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    startX = ev.clientX;
    startWidth = current();
    split.classList.add("is-dragging");
    document.body.classList.add("is-col-drag");
    try { split.setPointerCapture(ev.pointerId); } catch (e) {}
    ev.preventDefault();
  });
  split.addEventListener("pointermove", (ev) => {
    if (dragging) applyFoldersWidth(startWidth + (ev.clientX - startX), false);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    split.classList.remove("is-dragging");
    document.body.classList.remove("is-col-drag");
    applyFoldersWidth(current(), true);
  };
  split.addEventListener("pointerup", end);
  split.addEventListener("pointercancel", end);
  split.addEventListener("dblclick", () => applyFoldersWidth(FOLDERS_WIDTH.start, true));
  split.addEventListener("keydown", (ev) => {
    const step = ev.key === "ArrowLeft" ? -20 : ev.key === "ArrowRight" ? 20 : 0;
    if (!step) return;
    ev.preventDefault();
    applyFoldersWidth(current() + step, true);
  });
}
bindFoldersSplit();

function bindPaneSplit() {
  const split = document.getElementById("pane-split");
  if (!split) return;
  let dragging = false;
  let startX = 0;
  let startWidth = preferredListWidth;
  split.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    if (window.matchMedia("(max-width: 980px)").matches) return;
    dragging = true;
    startX = ev.clientX;
    const list = document.querySelector(".shell .list");
    startWidth = list ? list.getBoundingClientRect().width : preferredListWidth;
    split.classList.add("is-dragging");
    document.body.classList.add("is-col-drag");
    try { split.setPointerCapture(ev.pointerId); } catch (e) {}
    ev.preventDefault();
  });
  split.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const next = startWidth + (ev.clientX - startX);
    applyListWidth(Math.min(maxListWidth(), Math.max(LIST_WIDTH_MIN, next)), false);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    split.classList.remove("is-dragging");
    document.body.classList.remove("is-col-drag");
    applyListWidth(preferredListWidth, true);
  };
  split.addEventListener("pointerup", endDrag);
  // Double-click puts the list back to its starting width.
  split.addEventListener("dblclick", () => applyListWidth(LIST_WIDTH_DEFAULT, true));
  split.addEventListener("pointercancel", endDrag);
  split.addEventListener("keydown", (ev) => {
    if (window.matchMedia("(max-width: 980px)").matches) return;
    const step = ev.key === "ArrowLeft" ? -24 : ev.key === "ArrowRight" ? 24 : 0;
    if (step) {
      applyListWidth(Math.min(maxListWidth(), Math.max(LIST_WIDTH_MIN, preferredListWidth + step)), true);
      ev.preventDefault();
    } else if (ev.key === "Home") {
      applyListWidth(LIST_WIDTH_MIN, true);
      ev.preventDefault();
    } else if (ev.key === "End") {
      applyListWidth(maxListWidth(), true);
      ev.preventDefault();
    }
  });
  window.addEventListener("resize", () => applyListWidth(preferredListWidth, false));
  applyListWidth(preferredListWidth, false);
}
bindPaneSplit();
function removeStoredEvent(id) {
  let found = null;
  [events, allday].forEach(list => {
    const index = list.findIndex(item => item.id === id);
    if (index >= 0) found = list.splice(index, 1)[0];
  });
  return found;
}

function seedResponse(seed) {
  if (seed.hidden || seed.response === "declined") return "declined";
  if (seed.response === "accepted" || seed.response === "tentative") return seed.response;
  if (seed.tentative) return "tentative";
  return "";
}

function openEventForm(seed) {
  seed = seed || {};
  const editing = !!seed.id;
  if (!editing && !calendarRows().length) return;
  const invite = editing && (seed.attendees || []).length > 0;
  let reply = invite ? seedResponse(seed) : "";
  const showReply = editing;
  const showReplyAll = editing;
  const replyTo = !youOrganize(seed) && seed.organizer && seed.organizer.name ? seed.organizer.name : "";
  const organizerLine = editing && seed.organizer && !youOrganize(seed)
    ? `<p class="event-organizer"><span>Organizer</span> ${esc(seed.organizer.name)}</p>`
    : "";
  let day = seed.day == null ? dayFromDate(todayDate()) : seed.day;
  const allDay = !!seed.allDay;
  let start = seed.start == null ? 13 * 60 : seed.start;
  let end = seed.end == null ? start + 60 : seed.end;
  if (seed.scope === "all" && seed.series) {
    const first = localFromUtc(seed.series.start, seed.series.allDay);
    const last = localFromUtc(seed.series.end, seed.series.allDay);
    if (first && dayFromIso(first.iso) != null) day = dayFromIso(first.iso);
    if (first && last && !allDay) { start = first.minutes; end = last.minutes || 24 * 60; }
  }
  // Someone else's meeting: only the answer can change here.
  const sharedReadOnly = !!(editing && calendarReadOnly(seed.calendar));
  const readOnly = sharedReadOnly || !!(editing && seed.live && seed.organizer && !seed.isOrganizer && !youOrganize(seed) && (seed.attendees || []).length);
  const ico = (path) => `<span class="event-ico" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16">${path}</svg></span>`;
  popRoot.innerHTML = `
    <div class="backdrop dim" id="backdrop"></div>
    <form class="dialog event-editor" id="event-form" aria-label="${editing ? "Edit event" : "New event"}">
      <div class="event-bar">
        <button class="primary" type="submit">Save</button>
        ${showReply ? `<button class="icon-btn" type="button" id="event-reply" title="${replyTo ? "Reply to " + esc(replyTo) : "Reply"}" aria-label="${replyTo ? "Reply to " + esc(replyTo) : "Reply"}">${replyIcon}</button>` : ""}
        ${showReplyAll ? `<button class="icon-btn" type="button" id="event-reply-all" title="Reply to all members" aria-label="Reply to all members">${replyAllIcon}</button>` : ""}
        ${editing ? `<button class="icon-btn" type="button" id="event-forward" title="Forward" aria-label="Forward">${forwardIcon}</button>` : ""}
        ${editing ? `<button class="icon-btn" type="button" id="event-delete" title="Delete" aria-label="Delete"><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6.5h11M8 6.4V4.8h4v1.6M7.2 6.5l.5 8.8h4.6l.5-8.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : ""}
        <span class="compose-spacer"></span>
        <button class="icon-btn" type="button" id="cancel" aria-label="Close" title="Close"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
      </div>
      <p class="form-error" id="event-error" hidden></p>
      <div class="event-title-row">
        <input class="event-title" name="title" value="${esc(seed.title || "")}" placeholder="Add a title" aria-label="Title" autocomplete="off">
        <label class="event-cal">
          <span class="dot" id="event-cal-dot"></span>
          <select name="calendar" aria-label="Calendar">${calendarSelectOptions(seed.calendar || preferredCalendarId())}</select>
        </label>
      </div>
      ${organizerLine}
      ${invite ? `<div class="response-box" role="group" aria-label="Response">
        <span class="response-label">Response</span>
        <div class="rsvp">
          ${["accepted", "tentative", "declined"].map(key => `
            <button type="button" data-response="${key}" aria-pressed="${reply === key ? "true" : "false"}">${label(key)}</button>
          `).join("")}
        </div>
      </div>` : ""}
      <div class="event-row">
        ${ico(`<circle cx="8" cy="5.2" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3.2 13.2c.6-2.2 2.4-3.4 4.8-3.4s4.2 1.2 4.8 3.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`)}
        <div class="event-row-body">
          <input class="event-line" id="event-invite" placeholder="Invite attendees" aria-label="Invite attendees" autocomplete="off">
          <div class="suggest" id="event-suggest" hidden></div>
          <div class="attendees" id="event-people" hidden></div>
          <div class="schedule" id="event-schedule" hidden></div>
        </div>
      </div>
      <div class="event-row">
        ${ico(`<rect x="2.2" y="3.2" width="11.6" height="10.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.2 6.4h11.6M5.2 2.2v2.2M10.8 2.2v2.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`)}
        <div class="event-row-body event-when">
          <input class="event-line" name="date" type="date" value="${isoFromDay(day)}" aria-label="Date">
          <div id="event-times"${allDay ? " hidden" : ""}>
            <input class="event-line" name="start" value="${fmt(start)}" aria-label="Start" inputmode="numeric" autocomplete="off">
            <span class="event-to">to</span>
            <input class="event-line" name="end" value="${fmt(end)}" aria-label="End" inputmode="numeric" autocomplete="off">
          </div>
          <label class="event-allday">All day<input name="allday" type="checkbox" aria-label="All day"${allDay ? " checked" : ""}></label>
        </div>
      </div>
      ${repeatMarkup(isoFromDay(day))}
      <div class="event-row reminder-row" id="reminder-row" hidden>
        <span class="event-ico" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 2.4a4 4 0 0 1 4 4v2.4l1.2 1.8H2.8L4 8.8V6.4a4 4 0 0 1 4-4zM6.6 12.6a1.5 1.5 0 0 0 2.8 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></span>
        <label class="event-show">Reminder
          <select name="reminder" aria-label="Reminder">${REMINDER_CHOICES.map(([m, text]) => `<option value="${m}"${m === (editing && seed.live ? seed.reminder : 15) ? " selected" : ""}>${text}</option>`).join("")}</select>
        </label>
        <label class="event-teams" id="teams-row" hidden>Teams meeting<input type="checkbox" name="teams" aria-label="Teams meeting"></label>
        ${meetingLink(seed) ? `<button class="primary join-btn" type="button" id="event-join" title="${esc(meetingLink(seed).url)}">Join ${esc(meetingLink(seed).provider)}</button>` : ""}
      </div>
      ${sharedReadOnly ? `<p class="field-hint event-readonly">This calendar is shared with you to read. Only its owner can change it.</p>` : readOnly ? `<p class="field-hint event-readonly">Only the organiser can change this meeting. Your answer is sent straight away.</p>` : ""}
      <div class="event-row">
        ${ico(`<path d="M8 14.2s4.2-3.6 4.2-6.6a4.2 4.2 0 10-8.4 0c0 3 4.2 6.6 4.2 6.6z" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="7.4" r="1.3" fill="none" stroke="currentColor" stroke-width="1.3"/>`)}
        <input class="event-line" name="where" value="${esc(seed.where || "")}" placeholder="Add a location" aria-label="Location" autocomplete="off">
      </div>
      <div class="event-row">
        ${ico(`<rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.7 8.2h10.6v3.6a1 1 0 0 1-1 1H3.7a1 1 0 0 1-1-1V8.2z" fill="currentColor"/>`)}
        <label class="event-show">Show as
          <select name="showas" aria-label="Show as">
            ${["free", "busy", "oof"].map(value => `<option value="${value}"${showAsOf(seed) === value ? " selected" : ""}>${showAsLabel(value)}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="event-row notes-row">
        ${ico(`<rect x="3" y="2.2" width="10" height="11.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.2 5.4h5.6M5.2 8h5.6M5.2 10.6h3.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`)}
        <div class="event-notes-view" hidden></div>
        <textarea class="event-notes" name="notes" placeholder="Add notes" aria-label="Notes">${esc(seed.notes || "")}</textarea>
      </div>
    </form>`;
  document.getElementById("backdrop").onclick = closePop;
  document.getElementById("cancel").onclick = closePop;
  const storedMeeting = () => events.find(item => item.id === seed.id) || allday.find(item => item.id === seed.id);
  const mailMode = (mode) => {
    const ev = storedMeeting();
    if (!ev) return;
    openMeetingMail(ev, ev.start == null ? "all" : "timed", mode);
  };
  const replyBtn = document.getElementById("event-reply");
  const replyAllBtn = document.getElementById("event-reply-all");
  const forwardBtn = document.getElementById("event-forward");
  if (replyBtn) replyBtn.onclick = () => mailMode("reply");
  if (replyAllBtn) replyAllBtn.onclick = () => mailMode("all");
  if (forwardBtn) forwardBtn.onclick = () => mailMode("forward");
  const form = document.getElementById("event-form");
  const notesField = form.querySelector("[name=notes]");
  const notesView = form.querySelector(".event-notes-view");
  function paintNotesView() {
    const text = notesField.value;
    if (!noteHasLink(text)) {
      notesView.hidden = true;
      notesView.innerHTML = "";
      notesField.hidden = false;
      return;
    }
    notesView.innerHTML = noteHtml(text.trim());
    bindNoteLinks(notesView);
    notesView.hidden = false;
    notesField.hidden = true;
  }
  notesView.addEventListener("click", (ev) => {
    if (ev.target.closest("a.note-link")) return;
    notesView.hidden = true;
    notesField.hidden = false;
    notesField.focus();
  });
  notesField.addEventListener("blur", () => paintNotesView());
  paintNotesView();
  const times = document.getElementById("event-times");
  const inviteInput = document.getElementById("event-invite");
  const suggest = document.getElementById("event-suggest");
  const peopleBox = document.getElementById("event-people");
  let people = (seed.attendees || []).map(person => ({
    email: person.email,
    name: person.name || recipientLabel(person.email),
    status: ["accepted", "tentative", "declined", "none"].includes(person.status) ? person.status : "none"
  }));
  function paintPeople() {
    if (typeof paintSchedule === "function") paintSchedule();
    peopleBox.hidden = !people.length;
    peopleBox.innerHTML = people.map(person => {
      const status = ["accepted", "tentative", "declined"].includes(person.status) ? person.status : "none";
      return `<div class="attendee"><span class="event-avatar" aria-hidden="true">${esc(contactInitials(person.name))}</span><span>${esc(person.name)}</span><span class="attendee-status ${status}">${attendeeStatusLabel(status)}</span><button class="drop-person" type="button" data-drop-person="${esc(person.email)}" aria-label="Remove ${esc(person.name)}">×</button></div>`;
    }).join("");
    peopleBox.querySelectorAll("[data-drop-person]").forEach(btn => {
      btn.onclick = () => {
        people = people.filter(person => person.email.toLowerCase() !== btn.dataset.dropPerson.toLowerCase());
        paintPeople();
        paintSuggest();
      };
    });
  }
  // Who is free (2026-10-23): each person's day, and times that suit all.
  let scheduleTimer = 0;
  let scheduleSerial = 0;
  function paintSchedule() {
    clearTimeout(scheduleTimer);
    scheduleTimer = setTimeout(drawSchedule, 250);
  }
  async function drawSchedule() {
    const box = document.getElementById("event-schedule");
    if (!box) return;
    const allDayBox = form.querySelector("[name=allday]");
    const calId = (form.querySelector("[name=calendar]") || {}).value;
    const owner = calId ? accountForCalendar(calId) : null;
    const acct = owner ? owner[1] : null;
    const iso = (form.querySelector("[name=date]") || {}).value;
    if (!inDesktop() || !people.length || (allDayBox && allDayBox.checked) || !acct || !acct.signedIn || !acct.email || !/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) {
      box.hidden = true;
      return;
    }
    const serial = ++scheduleSerial;
    const day = new Date(iso + "T00:00:00");
    const next = new Date(day.getTime() + 86400000);
    const emails = [acct.email, ...people.map(p => p.email)];
    let rows = [];
    try {
      rows = await tauriInvoke("free_busy", { email: acct.email, people: emails, start: day.toISOString(), end: next.toISOString() }) || [];
    } catch (err) {
      if (serial !== scheduleSerial) return;
      box.hidden = false;
      box.innerHTML = `<p class="field-hint">${esc(String(err && err.message || err || "Microsoft didn't say who is free."))}</p>`;
      return;
    }
    if (serial !== scheduleSerial) return;
    const views = new Map(rows.map(r => [String(r.email || "").toLowerCase(), r]));
    const begin = parseClock((form.querySelector("[name=start]") || {}).value);
    const finish = parseClock((form.querySelector("[name=end]") || {}).value);
    const length = begin != null && finish != null && finish > begin ? finish - begin : 30;
    const earliest = iso === isoFromDay(dayFromDate(todayDate())) ? new Date().getHours() * 60 + new Date().getMinutes() : 0;
    const known = emails.map(e => (views.get(e.toLowerCase()) || {}).view || "").filter(Boolean);
    const picks = suggestSlots(known, WORK_FROM, WORK_TO, length, earliest, 3);
    const label = (email, i) => i === 0 ? "You" : ((people.find(p => p.email.toLowerCase() === email.toLowerCase()) || {}).name || email);
    const cells = view => {
      let out = "";
      for (let m = WORK_FROM; m < WORK_TO; m += 15) {
        const c = view ? view[m / 15] || "0" : "?";
        const inMeeting = begin != null && finish != null && m >= begin && m < finish;
        out += `<span class="slot s${c}${inMeeting ? " mine" : ""}"></span>`;
      }
      return out;
    };
    const hours = [];
    for (let h = WORK_FROM / 60; h < WORK_TO / 60; h += 2) hours.push(`<span>${String(h).padStart(2, "0")}</span>`);
    box.hidden = false;
    box.innerHTML = `<div class="schedule-head"><span>Who's free</span><span class="schedule-hours">${hours.join("")}</span></div>`
      + emails.map((email, i) => {
        const row = views.get(email.toLowerCase());
        return `<div class="schedule-row" data-schedule="${esc(email)}"><span class="schedule-name" title="${esc(email)}">${esc(label(email, i))}</span><span class="schedule-bar">${cells(row && row.view)}</span>${row && row.error ? `<span class="schedule-unknown" title="${esc(row.error)}">?</span>` : ""}</div>`;
      }).join("")
      + (picks.length
        ? `<div class="schedule-picks"><span>Everyone is free</span>${picks.map(m => `<button type="button" class="pick" data-pick-time="${m}">${fmt(m)}–${fmt(m + length)}</button>`).join("")}</div>`
        : `<p class="field-hint">No time between ${fmt(WORK_FROM)} and ${fmt(WORK_TO)} suits everyone on this day.</p>`);
    box.querySelectorAll("[data-pick-time]").forEach(btn => {
      btn.onclick = () => {
        const m = Number(btn.dataset.pickTime);
        const startField = form.querySelector("[name=start]"), endField = form.querySelector("[name=end]");
        startField.value = fmt(m);
        endField.value = fmt(m + length);
        startField.dispatchEvent(new Event("input", { bubbles: true }));
        endField.dispatchEvent(new Event("input", { bubbles: true }));
        paintSchedule();
      };
    });
  }
  ["date", "start", "end", "allday", "calendar"].forEach(name => {
    const field = form.querySelector(`[name=${name}]`);
    if (field) { field.addEventListener("change", paintSchedule); field.addEventListener("input", paintSchedule); }
  });
  function inviteHits(q) {
    const invited = new Set(people.map(item => item.email.toLowerCase()));
    return peopleMatches(q, 6).filter(person => !invited.has(person.email.toLowerCase()));
  }
  function paintSuggest() {
    const hits = inviteHits(inviteInput.value);
    if (!hits.length) {
      suggest.hidden = true;
      suggest.innerHTML = "";
      return;
    }
    suggest.hidden = false;
    suggest.innerHTML = personSuggestHtml(hits);
    suggest.querySelectorAll("button").forEach(btn => {
      btn.addEventListener("mousedown", (ev) => ev.preventDefault());
      btn.onclick = () => addPerson(btn.dataset.email, btn.dataset.name);
    });
  }
  function addPerson(email, name) {
    const note = document.getElementById("event-error");
    const fail = (text) => { note.hidden = false; note.textContent = text; };
    const trimmed = String(email || "").trim();
    const key = trimmed.toLowerCase();
    if (!key) return;
    if (ownAddresses().has(key)) return fail("That's your address.");
    if (people.some(person => person.email.toLowerCase() === key)) return fail("Already invited.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return fail("Choose a person, or enter an email address.");
    note.hidden = true;
    people.push({ email: trimmed, name: name || recipientLabel(trimmed), status: "none" });
    inviteInput.value = "";
    paintPeople();
    paintSuggest();
  }
  function addFromInput() {
    const q = inviteInput.value.trim();
    if (!q) return;
    const key = q.toLowerCase();
    const exact = knownPeople().filter(person => person.name.toLowerCase() === key || person.email.toLowerCase() === key);
    if (exact.length === 1) return addPerson(exact[0].email, exact[0].name);
    const hits = inviteHits(q);
    if (hits.length === 1) return addPerson(hits[0].email, hits[0].name);
    addPerson(q);
  }
  inviteInput.addEventListener("input", paintSuggest);
  inviteInput.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    addFromInput();
  });
  form.addEventListener("click", (ev) => {
    if (!ev.target.closest("#event-invite") && !ev.target.closest("#event-suggest")) suggest.hidden = true;
  });
  paintPeople();
  form.querySelectorAll("[data-response]").forEach(btn => {
    btn.onclick = () => {
      reply = btn.dataset.response;
      form.querySelectorAll("[data-response]").forEach(el => el.setAttribute("aria-pressed", el === btn ? "true" : "false"));
    };
  });
  const calSelect = form.querySelector("[name=calendar]");
  const calDot = document.getElementById("event-cal-dot");
  const paintCalDot = () => {
    const cal = findCalendar(calSelect.value);
    calDot.className = "dot " + (cal && cal.cls ? cal.cls : "work");
  };
  calSelect.onchange = paintCalDot;
  paintCalDot();
  form.querySelector("[name=allday]").onchange = (e) => { times.hidden = e.target.checked; };
  const dateInput = form.querySelector("[name=date]");
  const repeatRow = document.getElementById("repeat-row");
  bindRepeat(form, dateInput);
  if (seed.series && seed.series.recurrence) recurrenceToForm(form, seed.series.recurrence, dateInput.value);
  form.querySelector("[name=repeat]").dispatchEvent(new Event("change"));
  // Repeat applies to new events and to whole series on the server.
  const paintRepeatRow = () => {
    repeatRow.hidden = !serverCalendar(calSelect.value) || seed.scope === "this" || readOnly;
  };
  calSelect.addEventListener("change", paintRepeatRow);
  paintRepeatRow();
  // Reminders and Teams belong to server calendars.
  const reminderRow = document.getElementById("reminder-row");
  const teamsRow = document.getElementById("teams-row");
  const paintReminderRow = () => {
    const live = serverCalendar(calSelect.value);
    reminderRow.hidden = !live;
    const cal = findCalendar(calSelect.value);
    teamsRow.hidden = !(live && cal && cal.teams && !meetingLink(seed) && !readOnly && (!editing || seed.isOrganizer));
  };
  calSelect.addEventListener("change", paintReminderRow);
  paintReminderRow();
  const joinBtn = document.getElementById("event-join");
  if (joinBtn) joinBtn.onclick = () => openNoteLink(meetingLink(seed).url);
  if (editing && seed.live) calSelect.disabled = true;
  if (readOnly) {
    form.querySelectorAll("input, textarea, select").forEach(el => { el.disabled = true; });
    const save = form.querySelector('button[type="submit"]');
    if (save) save.hidden = true;
    form.querySelectorAll("[data-response]").forEach(btn => {
      btn.addEventListener("click", () => {
        answerLiveMeeting(seed.account, String(seed.eventId || seed.id).split("@")[0], btn.dataset.response, seed.title);
      });
    });
  }
  const deleteBtn = document.getElementById("event-delete");
  if (deleteBtn && sharedReadOnly) deleteBtn.hidden = true;
  if (deleteBtn) deleteBtn.onclick = () => {
    const ev = storedMeeting();
    if (!ev) return closePop();
    closePop();
    deleteCalendarEvent(ev.id, ev.start == null ? "all" : "timed");
  };
  if (!editing) form.querySelector("[name=title]").focus();
  form.onsubmit = (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const note = document.getElementById("event-error");
    const title = String(data.get("title") || "").trim();
    const dayNum = dayFromIso(data.get("date"));
    // Read the picker itself: a disabled field is left out of FormData.
    const calChoice = form.querySelector("[name=calendar]").value;
    const picked = findCalendar(calChoice);
    const owner = accountForCalendar(calChoice);
    const fail = (text) => { note.hidden = false; note.textContent = text; };
    if (!title) return fail("Enter a title.");
    if (dayNum == null) return fail("Enter a date.");
    if (!picked || !owner) return;
    const whole = form.querySelector("[name=allday]").checked;
    let begin = parseClock(data.get("start"));
    let finish = parseClock(data.get("end"));
    if (!whole) {
      if (begin == null) begin = 13 * 60;
      if (finish == null || finish <= begin) return fail("End must be after the start.");
    }
    if (serverCalendar(picked.id)) {
      saveLiveEvent({ form, seed, owner: owner[0], calId: picked.id, title, dayNum, whole, begin, finish, people, reply, invite, fail });
      return;
    }
    const previous = editing ? removeStoredEvent(seed.id) : null;
    hiddenCal.delete(picked.id);
    const base = {
      id: previous ? previous.id : "event-" + Date.now(),
      account: owner[0],
      calendar: picked.id,
      day: dayNum,
      title,
      where: String(data.get("where") || "").trim(),
      notes: String(data.get("notes") || "").trim(),
      tentative: invite ? reply === "tentative" : (previous ? !!previous.tentative : false),
      response: invite ? reply : (previous ? previous.response || "" : ""),
      hidden: invite ? reply === "declined" : (previous ? !!previous.hidden : false),
      with: people.map(person => person.name).join(", "),
      attendees: people.map(person => ({ email: person.email, name: person.name, status: person.status || "none" })),
      showAs: showAsOf({ showAs: data.get("showas") })
    };
    const keptOrganizer = previous && previous.organizer ? previous.organizer : seed.organizer;
    if (keptOrganizer) base.organizer = keptOrganizer;
    if (previous && previous.live) base.live = true;
    if (whole) allday.push(base);
    else events.push(Object.assign({}, base, { start: begin, end: finish }));
    if (invite && base.id === "pipeline") rsvp = reply || null;
    closePop();
    const shown = dateFromDay(dayNum);
    calFocus = calView === "month" ? new Date(shown.getFullYear(), shown.getMonth(), 1) : shown;
    setView("calendar");
    toast(editing ? "Event updated" : "Event added");
  };
}

window.addEventListener("resize", () => {
  const kept = shownHour();
  if (kept != null) calTopHour = kept;
  applyHourScale();
});
document.getElementById("cal-today").onclick = () => { calFocus = new Date(todayDate()); render(); refreshLiveCalendar(); };
document.getElementById("cal-prev").onclick = () => shiftCalendar(-1);
document.getElementById("cal-next").onclick = () => shiftCalendar(1);
document.querySelectorAll("[data-cal-view]").forEach(btn => {
  btn.onclick = () => { calView = btn.dataset.calView; render(); refreshLiveCalendar(); };
});

window.addEventListener("storage", (e) => {
  if (e.key === "outlook-mock-mail-event") applyMailEvent();
  if (e.key === "mailroom-ai-provider") {
    loadAiProvider();
    paintAssistChrome();
  }
  if (e.key === "mailroom-assist" && !assistBusy) {
    loadAssistTurns();
    paintAssistLog();
  }
  if (e.key === "mailroom-assist-insert") onAssistInsert(e.newValue);
});
const folderBusy = new Set();
let syncNote = "";
const folderRun = new Map();
const bodyLoads = new Set();
const APP_VERSION = "1.0.7";
let appVersion = APP_VERSION;

prepareDesktopAccounts();
settleProfileSelection();
restoreSignatures();
syncAccountChoices();
if (popCompose) openPopCompose();
else if (!assistWindow) setView(view);

const sampleMessages = messages.map(message => Object.assign({}, message));

function tauriInvoke(cmd, args) {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || !internals.invoke) return null;
  return internals.invoke(cmd, args || {});
}

function liveInitials(name, email) {
  const parts = String(name || email || "?").replace(/@.*/, "").split(/[\s.]+/).filter(Boolean);
  return ((parts[0] || "?").slice(0, 1) + (parts[1] || "").slice(0, 1)).toUpperCase();
}

function liveDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return date.getFullYear() + "-" + month + "-" + day;
}

function liveWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
}

const loadedLiveFolders = new Set();
let folderSyncToken = 0;
let olderLoad = null;
let searchPreload = null;
let searchPrimed = false;

function folderMark(accountId, key) {
  return accountId + "\n" + key;
}

function startFolderRun(mark) {
  const n = (folderRun.get(mark) || 0) + 1;
  folderRun.set(mark, n);
  return n;
}

function folderRunLive(mark, n) {
  return folderRun.get(mark) === n;
}

function stopFolderBusy(mark, n) {
  if (!folderRunLive(mark, n)) return;
  folderBusy.delete(mark);
}

function rememberFolderBusy(accountId, key) {
  const acct = accounts[accountId];
  if (!acct || !acct.signedIn || !inDesktop()) return;
  const mark = folderMark(accountId, key);
  if (loadedLiveFolders.has(mark)) return;
  folderBusy.add(mark);
}

function folderBusyForView() {
  if (view !== "mail") return false;
  if (account === "all") return profileAccountIds().some(id => folderBusy.has(folderMark(id, box)));
  return folderBusy.has(folderMark(account, box));
}

function viewingMailFolder(accountId, key) {
  if (view !== "mail" || box !== key) return false;
  return (account === "all" && accountInProfile(accountId)) || account === accountId;
}

function settleOpenFolder() {
  const visible = conversations();
  if (!visible.some(c => c.messages.some(m => m.id === selected))) {
    selected = (visible[0] && visible[0].latest.id) || null;
    expanded.clear();
    folded.clear();
    const picked = messages.find(m => m.id === selected);
    if (picked && picked.draft) focusReply = true;
  }
}

function mergeFolderMessages(accountId, boxKey, items, removed) {
  const drop = new Set((removed || []).filter(Boolean));
  if (drop.size) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.account === accountId && messageBox(message) === boxKey && drop.has(message.id)) messages.splice(i, 1);
    }
  }
  const state = pageState(accountId, boxKey);
  const cursor = state && state.before ? state.before : "";
  const cursorId = state && state.beforeId ? state.beforeId : "";
  const fully = !state || state.more === false;
  const indexById = new Map();
  messages.forEach((message, index) => {
    if (message.account === accountId && messageBox(message) === boxKey) indexById.set(message.id, index);
  });
  (items || []).forEach(item => {
    if (!item || !item.id) return;
    const at = indexById.get(item.id);
    if (at != null) {
      const prev = messages[at];
      if (prev && prev.pendingSend) return;
      const next = liveMessage(accountId, item, boxKey);
      if (next.needsBody && prev && prev.bodyHtml && !prev.needsBody) {
        next.bodyHtml = prev.bodyHtml;
        next.needsBody = false;
      }
      messages[at] = next;
      return;
    }
    const received = String(item.received || "");
    const inWindow = fully || !cursor || received > cursor || (received === cursor && String(item.id) >= cursorId);
    if (!inWindow) return;
    messages.push(liveMessage(accountId, item, boxKey));
    indexById.set(item.id, messages.length - 1);
  });
}

function appendFolderMessages(accountId, boxKey, items, more) {
  const mark = folderMark(accountId, boxKey);
  const state = folderPage.get(mark) || { before: "", beforeId: "", more: true, loading: false };
  const have = new Set();
  messages.forEach(message => {
    if (message.account === accountId && messageBox(message) === boxKey) have.add(message.id);
  });
  (items || []).forEach(item => {
    if (!item || !item.id || have.has(item.id)) return;
    messages.push(liveMessage(accountId, item, boxKey));
    have.add(item.id);
  });
  if (!items || !items.length) {
    folderPage.set(mark, { before: state.before, beforeId: state.beforeId, more: false, loading: false });
    return;
  }
  const cursor = oldestCursor(items);
  let nextMore = !!more && !!cursor.before;
  if (state.before && !cursorIsOlder(cursor.before, cursor.beforeId, state.before, state.beforeId)) nextMore = false;
  folderPage.set(mark, {
    before: cursor.before || state.before,
    beforeId: cursor.before ? cursor.beforeId : state.beforeId,
    more: nextMore,
    loading: false
  });
}

function applySavedSearch(accountId, key, raw) {
  const page = asMailPayload(raw);
  const ids = new Set();
  const have = new Set(messages.filter(m => m.account === accountId).map(m => m.id));
  (page.messages || []).forEach(item => {
    if (!item || !item.id) return;
    ids.add(item.id);
    if (have.has(item.id)) return;
    messages.push(liveMessage(accountId, item, key));
    have.add(item.id);
  });
  savedSearchHits.set(accountId + "\n" + key, ids);
}

function applyFolderPayload(accountId, boxKey, raw) {
  const page = asMailPayload(raw);
  if (page.merged) mergeFolderMessages(accountId, boxKey, page.messages, page.removed);
  else {
    replaceFolderMessages(accountId, boxKey, page.messages);
    rememberFolderPage(accountId, boxKey, page.messages, page.more);
  }
  return page;
}

function absorbFolderMessages(accountId, boxKey, items) {
  const have = new Set();
  messages.forEach(message => {
    if (message.account === accountId && messageBox(message) === boxKey) have.add(message.id);
  });
  (items || []).forEach(item => {
    if (!item || !item.id || have.has(item.id)) return;
    messages.push(liveMessage(accountId, item, boxKey));
    have.add(item.id);
  });
}

function listIsShort() {
  const list = document.querySelector(".list");
  if (!inDesktop() || !list || view !== "mail" || searchActive()) return false;
  return list.scrollHeight <= list.clientHeight + 80;
}

// A short list is already at the bottom. Read a few more pages, then leave
// Older mail for the rest, so Focused Inbox does not pull thousands of headers.
async function fillShortList() {
  for (let round = 0; round < 4; round++) {
    if (!listIsShort()) return;
    const ids = account === "all" ? profileAccountIds() : (accountInProfile(account) ? [account] : []);
    const pending = ids.some(id => {
      const state = pageState(id, box);
      return !!(state && state.more && state.before && !state.loading);
    });
    if (!pending) return;
    await loadOlderPages();
  }
}

function maybeFillShortList() {
  if (fillingShort) return;
  requestAnimationFrame(() => {
    if (fillingShort || !listIsShort()) return;
    fillingShort = true;
    fillShortList().catch(err => console.error(err)).finally(() => { fillingShort = false; });
  });
}

function loadOlderPages() {
  if (olderLoad) return olderLoad;
  if (!inDesktop() || view !== "mail" || searchActive()) return Promise.resolve();
  const ids = account === "all" ? profileAccountIds() : (accountInProfile(account) ? [account] : []);
  const jobs = [];
  ids.forEach(id => {
    const state = pageState(id, box);
    if (!state || !state.more || state.loading || !state.before) return;
    const acct = accounts[id];
    if (!acct || !acct.email) return;
    state.loading = true;
    jobs.push({ id, email: acct.email, before: state.before, beforeId: state.beforeId || "" });
  });
  if (!jobs.length) return Promise.resolve();
  olderLoad = (async () => {
    await Promise.all(jobs.map(async job => {
      const mark = folderMark(job.id, box);
      try {
        const raw = await tauriInvoke("cached_folder", {
          email: job.email,
          boxKey: box,
          includeBody: false,
          limit: MAIL_PAGE_SIZE,
          before: job.before,
          beforeId: job.beforeId
        });
        const page = asMailPayload(raw);
        appendFolderMessages(job.id, box, page.messages, page.more);
      } catch (err) {
        const state = folderPage.get(mark);
        if (state) state.loading = false;
      }
    }));
    if (view === "mail") render();
  })().catch(err => console.error(err)).finally(() => { olderLoad = null; });
  return olderLoad;
}

function bindMailPaging() {
  const list = document.querySelector(".list");
  if (!list || list.dataset.mailPage) return;
  list.dataset.mailPage = "1";
  list.addEventListener("scroll", () => {
    if (list.scrollTop + list.clientHeight < list.scrollHeight - 80) return;
    if (searchActive()) loadOlderSearch();
    else loadOlderPages();
  });
}

async function paintCachedFolder(accountId, key, live) {
  const mark = folderMark(accountId, key);
  if (loadedLiveFolders.has(mark)) return;
  const acct = accounts[accountId];
  if (!acct || !acct.email || !inDesktop()) return;
  let raw = null;
  try {
    raw = await tauriInvoke("cached_folder", { email: acct.email, boxKey: key, includeBody: false, limit: MAIL_PAGE_SIZE });
  } catch (err) {
    return;
  }
  if (!live() || loadedLiveFolders.has(mark)) return;
  const page = asMailPayload(raw);
  if (!page.messages.length) return;
  replaceFolderMessages(accountId, key, page.messages);
  rememberFolderPage(accountId, key, page.messages, page.more);
  if (viewingMailFolder(accountId, key)) {
    settleOpenFolder();
    render();
  }
}

function readingShowsMessage(message) {
  if (!message || view !== "mail") return false;
  const conv = conversationFor(selected);
  if (!conv) return false;
  if (conv.messages.some(m => m.id === message.id)) return true;
  const draft = sameThreadDraft(conv);
  return !!(draft && draft.id === message.id);
}

async function ensureMessageBody(message) {
  if (!inDesktop() || !message || !message.needsBody || !message.live || !message.id) return;
  if (bodyLoads.has(message.id)) return;
  const acct = accounts[message.account];
  const email = acct && acct.email;
  if (!email) return;
  const id = message.id;
  const accountId = message.account;
  bodyLoads.add(id);
  let html = "";
  try {
    html = await tauriInvoke("cached_body", { email, messageId: id });
  } catch (err) {
    bodyLoads.delete(id);
    return;
  }
  bodyLoads.delete(id);
  const current = messages.find(m => m.id === id && m.account === accountId);
  if (!current || !current.needsBody) return;
  current.bodyHtml = html || "<p></p>";
  current.needsBody = false;
  if (readingShowsMessage(current)) renderReading();
}

function recipientRows(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => ({
    name: String((item && item.name) || "").trim(),
    email: String((item && item.email) || "").trim()
  })).filter(item => item.email);
}

function liveMessage(accountId, item, boxKey) {
  const from = item.fromName || item.fromEmail || "Unknown";
  const files = messageFiles({ files: item.files });
  const toPeople = recipientRows(item.to);
  const ccPeople = recipientRows(item.cc);
  const bccPeople = recipientRows(item.bcc);
  return {
    id: item.id,
    thread: item.thread || item.id,
    seq: Date.parse(item.received) || 0,
    account: accountId,
    box: boxKey,
    from,
    email: item.fromEmail || "",
    initials: liveInitials(from, item.fromEmail),
    color: "#0f6cbd",
    subject: item.subject || "(No subject)",
    preview: item.preview || "",
    time: liveWhen(item.received),
    received: item.received || "",
    unread: !!item.unread,
    flagged: !!item.flagged,
    hasAttachment: !!item.hasAttachments || files.length > 0,
    date: liveDate(item.received),
    files,
    attachments: files.map(file => file.name),
    to: toPeople.map(person => person.email).join("; "),
    cc: ccPeople.map(person => person.email).join("; "),
    bcc: bccPeople.map(person => person.email).join("; "),
    toPeople,
    ccPeople,
    bccPeople,
    live: true,
    categories: Array.isArray(item.categories) ? item.categories : [],
    importance: item.importance === "high" || item.importance === "low" ? item.importance : "",
    invite: !!item.invite,
    focus: item.focus === "other" ? "other" : item.focus === "focused" ? "focused" : "",
    draft: boxKey === "drafts",
    bodyHtml: item.bodyHtml || "",
    needsBody: !item.bodyHtml
  };
}

async function loadCachedDrafts(accountId) {
  if (!inDesktop()) return;
  const acct = accounts[accountId];
  if (!acct || !acct.email) return;
  const mark = accountId + "\ndrafts";
  if (loadedLiveFolders.has(mark)) return;
  let raw = null;
  try {
    raw = await tauriInvoke("cached_folder", { email: acct.email, boxKey: "drafts", box_key: "drafts", includeBody: false, include_body: false });
  } catch (err) {
    return;
  }
  if (loadedLiveFolders.has(mark)) return;
  const have = new Set(messages.filter(m => m.account === accountId).map(m => m.id));
  asMailPayload(raw).messages.forEach(item => {
    if (!item || !item.id || have.has(item.id)) return;
    messages.push(liveMessage(accountId, item, "drafts"));
  });
}

function replaceFolderMessages(accountId, boxKey, items) {
  const keptBodies = new Map();
  messages.forEach(message => {
    if (message.account !== accountId || messageBox(message) !== boxKey) return;
    if (message.bodyHtml && !message.needsBody) keptBodies.set(message.id, message.bodyHtml);
  });
  const incoming = new Set((items || []).map(item => item && item.id).filter(Boolean));
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.account !== accountId || messageBox(message) !== boxKey) continue;
    if (message.pendingSend && !incoming.has(message.id)) continue;
    if ((message.searchOnly || message.threadOnly) && !incoming.has(message.id)) continue;
    messages.splice(i, 1);
  }
  (items || []).forEach(item => {
    const message = liveMessage(accountId, item, boxKey);
    const kept = keptBodies.get(message.id);
    if (message.needsBody && kept) {
      message.bodyHtml = kept;
      message.needsBody = false;
    }
    messages.push(message);
  });
}

function fillAccountMail(accountId, result) {
  dropSampleRows(accountId);
  const acct = accounts[accountId];
  const folders = Array.isArray(result && result.folders) ? result.folders : [];
  if (acct && folders.length) {
    const next = folders.map(folder => ({
      id: String((folder && (folder.id || folder.folderId || folder.folder_id)) || "").trim(),
      parentId: String(folder.parentId || ""),
      name: String(folder.name || "Folder"),
      key: String(folder.key || folder.id || folder.folderId || "").trim(),
      unread: Number(folder.unread) || 0,
      total: Number(folder.total) || 0,
      depth: Number(folder.depth) || 0
    })).filter(folder => folder.id && folder.key);
    const prevKeys = (acct.liveFolders || []).map(folder => folder.key).join("\n");
    const nextKeys = next.map(folder => folder.key);
    const keep = new Set(nextKeys);
    for (let i = messages.length - 1; i >= 0; i--) {
      const where = messageBox(messages[i]);
      if (messages[i].account === accountId && !messages[i].pendingSend && !keep.has(where) && !isSearchBox(where)) messages.splice(i, 1);
    }
    favorites = favorites.filter(item => item.account !== accountId || keep.has(item.box) || isCategoryBox(item.box) || isSearchBox(item.box));
    rememberFavorites();
    const staying = isCategoryBox(box) || isSearchBox(box);
    if (folderPick === "fav" && account === accountId && !keep.has(box) && !staying) folderPick = "folder";
    if (account === accountId && !keep.has(box) && !staying) box = "inbox";
    const dropGone = store => {
      const tokens = store instanceof Map ? [...store.keys()] : [...store];
      tokens.forEach(token => {
        const split = String(token).indexOf("\n");
        if (split < 0) return;
        const rest = token.slice(split + 1);
        if (token.slice(0, split) === accountId && !keep.has(rest) && !isSearchBox(rest)) store.delete(token);
      });
    };
    dropGone(loadedLiveFolders);
    dropGone(folderPage);
    dropGone(searchFoldersLoaded);
    if (prevKeys !== nextKeys.join("\n")) searchPrimed = false;
    acct.liveFolders = next;
  }
  applyFolderPayload(accountId, "inbox", result);
  loadedLiveFolders.add(accountId + "\ninbox");
}

function graphFolderId(folder) {
  if (!folder || typeof folder !== "object") return "";
  const raw = folder.id || folder.folderId || folder.folder_id || "";
  const id = String(raw).trim();
  if (id) return id;
  const key = String(folder.key || "").trim();
  if (key && !boxNames[key]) return key;
  return "";
}

async function pullFolderMessages(accountId, folder) {
  const folderId = graphFolderId(folder);
  if (!folderId) return null;
  const email = accounts[accountId] && accounts[accountId].email;
  const token = folderSyncToken;
  const items = await tauriInvoke("sync_folder", {
    folderId: folderId,
    folder_id: folderId,
    email,
    since: syncSinceIso()
  });
  if (token !== folderSyncToken) return null;
  return items;
}

let unifiedSerial = 0;

async function ensureUnifiedFolder(key) {
  if (!inDesktop()) return;
  const serial = ++unifiedSerial;
  const jobs = [];
  let clearedBusy = false;
  for (const id of profileAccountIds()) {
    const mark = folderMark(id, key);
    if (loadedLiveFolders.has(mark)) continue;
    const acct = accounts[id];
    const folder = acct && (acct.liveFolders || []).find(item => item.key === key);
    if (!acct || !acct.signedIn || !graphFolderId(folder)) {
      if (folderBusy.delete(mark)) clearedBusy = true;
      continue;
    }
    const run = startFolderRun(mark);
    rememberFolderBusy(id, key);
    jobs.push({ id, folder, mark, run });
  }
  if (serial !== unifiedSerial) return;
  if (!jobs.length) {
    if (clearedBusy && viewingMailFolder("all", key)) render();
    return;
  }
  const liveJob = job => serial === unifiedSerial && folderRunLive(job.mark, job.run);
  await Promise.all(jobs.map(job => paintCachedFolder(job.id, key, () => liveJob(job))));
  if (serial !== unifiedSerial) {
    jobs.forEach(job => stopFolderBusy(job.mark, job.run));
    return;
  }
  await Promise.all(jobs.map(async job => {
    try {
      if (!liveJob(job)) return;
      const raw = await pullFolderMessages(job.id, job.folder);
      if (!liveJob(job) || !raw) return;
      applyFolderPayload(job.id, key, raw);
      loadedLiveFolders.add(job.mark);
    } catch (err) {
      if (liveJob(job) && !noteUnreachable(err)) {
        authProblem = String(err && err.message || err);
        refreshAuthBanner();
      }
    } finally {
      stopFolderBusy(job.mark, job.run);
    }
  }));
  if (serial !== unifiedSerial) return;
  if (viewingMailFolder("all", key)) {
    settleOpenFolder();
    render();
  }
}

async function ensureFolderMessages(accountId, key, explicitId) {
  const mark = folderMark(accountId, key);
  const acct = accounts[accountId];
  if (loadedLiveFolders.has(mark)) return;
  if (!acct || !acct.signedIn || !inDesktop()) {
    if (folderBusy.delete(mark) && viewingMailFolder(accountId, key)) render();
    return;
  }
  const folder = (acct.liveFolders || []).find(item => item.key === key);
  const folderId = graphFolderId(folder) || String(explicitId || "").trim();
  if (!folderId) {
    if (folderBusy.delete(mark) && viewingMailFolder(accountId, key)) render();
    return;
  }
  const savedSearch = isSearchBox(key);
  const run = startFolderRun(mark);
  rememberFolderBusy(accountId, key);
  const live = () => folderRunLive(mark, run);
  try {
    if (!savedSearch) await paintCachedFolder(accountId, key, live);
    if (!live()) return;
    const raw = await pullFolderMessages(accountId, folder && graphFolderId(folder) ? folder : { id: folderId, key: key });
    if (!live() || !raw) return;
    if (savedSearch) applySavedSearch(accountId, key, raw);
    else applyFolderPayload(accountId, key, raw);
    loadedLiveFolders.add(mark);
    if (viewingMailFolder(accountId, key)) {
      settleOpenFolder();
      render();
    }
    if (key !== "inbox" && !savedSearch) backfillFolder(accountId, key);
  } catch (err) {
    if (live() && !noteUnreachable(err)) {
      authProblem = String(err && err.message || err);
      refreshAuthBanner();
    }
  } finally {
    stopFolderBusy(mark, run);
  }
}

let authProblem = "";
let signingIn = false;
const CONSENT_AGAIN = "Sign in again to read the calendar and contacts.";
const SEND_AGAIN = "Sign in again to send mail.";
const ANSWER_AGAIN = "Sign in again to answer invites.";
const consentAgain = new Set();
const sendConsent = new Set();
const answerConsent = new Set();
const directorySync = {};

function accountNeedsSignIn(id) {
  const acct = accounts[id];
  return !!(inDesktop() && acct && (!acct.signedIn || consentAgain.has(id) || sendConsent.has(id) || answerConsent.has(id)));
}

function recordDirectory(accountId, kind, err) {
  if (!accountId) return;
  const before = consentAgain.has(accountId);
  if (!directorySync[accountId]) directorySync[accountId] = {};
  if (!err) directorySync[accountId][kind] = "ok";
  else {
    const message = String(err && err.message || err);
    noteSyncProblem(err);
    directorySync[accountId][kind] = message === CONSENT_AGAIN ? "consent" : "error";
  }
  const state = directorySync[accountId];
  const values = [state.contacts, state.calendar];
  if (values.some(value => value === "consent")) consentAgain.add(accountId);
  else if (state.contacts === "ok" && state.calendar === "ok") consentAgain.delete(accountId);
  if (authProblem === CONSENT_AGAIN && consentAgain.size === 0) authProblem = "";
  refreshAuthBanner();
  if (before !== consentAgain.has(accountId) && view === "settings" && settingsPage === "accounts") render();
}

function accountByEmail(email) {
  const key = String(email || "").toLowerCase();
  if (!key) return null;
  return Object.entries(accounts).find(([, acct]) => String(acct.email || "").toLowerCase() === key) || null;
}

function signedAccountsFrom(status) {
  if (status && Array.isArray(status.accounts) && status.accounts.length) return status.accounts;
  if (status && status.email) return [{ email: status.email, name: status.name || "" }];
  return [];
}

function applySignIn(status) {
  signedAccountsFrom(status).forEach(item => {
    const match = accountByEmail(item.email);
    if (match) {
      match[1].signedIn = true;
      if (item.provider) match[1].provider = item.provider === "google" ? "google" : "microsoft";
    }
  });
}

function applySavedSignIns(status) {
  const signed = new Map(signedAccountsFrom(status).map(item => [String(item.email || "").toLowerCase(), item]).filter(([email]) => email));
  Object.values(accounts).forEach(acct => {
    const item = signed.get(String(acct.email || "").toLowerCase());
    acct.signedIn = !!item;
    if (item && item.provider) acct.provider = item.provider === "google" ? "google" : "microsoft";
  });
}

async function signInAccount(id) {
  if (signingIn || !inDesktop()) return;
  const acct = accounts[id];
  if (!acct || (acct.signedIn && !consentAgain.has(id) && !sendConsent.has(id) && !answerConsent.has(id))) return;
  const hint = String(acct.email || "").trim();
  if (!hint) return;
  signingIn = true;
  document.querySelectorAll("[data-sign-in], #account-sign-in").forEach(btn => {
    btn.disabled = true;
    if (btn.dataset.signIn === id || btn.id === "account-sign-in") btn.textContent = "Waiting for " + providerName(id) + "…";
  });
  let status = null;
  try {
    status = await tauriInvoke("sign_in", { loginHint: hint, provider: isGoogleAccount(id) ? "google" : "microsoft" });
    if (!status || !status.signedIn) throw new Error("The sign-in could not be saved on this computer.");
    document.querySelectorAll("[data-sign-in], #account-sign-in").forEach(btn => {
      if (btn.dataset.signIn === id || btn.id === "account-sign-in") btn.textContent = "Signed in. Loading mail…";
    });
    const inbox = await tauriInvoke("sync_inbox", { email: String(status.email || hint), since: syncSinceIso() });
    const email = String((inbox && inbox.email) || status.email || hint);
    let match = accountByEmail(email);
    if (!match) {
      const created = addAccount({
        yourName: (status && status.name) || acct.yourName || "Jon",
        name: acct.name || (status && status.name) || email,
        email,
        cls: acct.cls || "work"
      });
      if (typeof created === "string") throw new Error(created);
      rememberAccount(created.id);
      match = accountByEmail(email);
    }
    if (!match) throw new Error("That mailbox is not on this computer.");
    applySignIn(status);
    authProblem = "";
    sendConsent.delete(match[0]);
    answerConsent.delete(match[0]);
    messages.forEach(item => {
      if (item.account !== match[0] || !item.pendingSend) return;
      item.sendError = "";
      item.sending = false;
      item.sendAt = Date.now();
      item.time = "Sending";
    });
    rememberOutbox();
    if (messages.some(item => item.pendingSend)) armPendingTimer();
    match[1].signedIn = true;
    fillAccountMail(match[0], inbox);
    await loadCachedDrafts(match[0]);
    await syncAccountDirectory(match[0], false);
    account = match[0];
    box = "inbox";
    folderPick = "folder";
    selected = messages.find(item => item.account === match[0])?.id || null;
    expanded.clear();
    folded.clear();
    refreshAuthBanner();
    toast("Signed in");
    tickPendingSends();
    setView("mail");
  } catch (err) {
    if (status && status.signedIn) applySignIn(status);
    authProblem = String(err && err.message || err);
    refreshAuthBanner();
    render();
  } finally {
    signingIn = false;
  }
}

function inDesktop() {
  return !!(window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke);
}

function unsignedAccountLabel(pending) {
  const names = pending.map(acct => acct.name || "Account");
  if (names.length === 1) return names[0] + " is not signed in.";
  if (names.length === 2) return names[0] + " and " + names[1] + " are not signed in.";
  return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1] + " are not signed in.";
}

function authBannerState() {
  const pending = Object.values(accounts).filter(acct => !acct.signedIn);
  const needsConsent = [...consentAgain].some(id => accounts[id] && accounts[id].signedIn);
  const hasAccounts = Object.keys(accounts).length > 0;
  if (sendConsent.size) return { text: SEND_AGAIN, problem: true, link: true };
  if (answerConsent.size) return { text: ANSWER_AGAIN, problem: true, link: true };
  if (hasAccounts && authProblem && authProblem !== CONSENT_AGAIN && authProblem !== SEND_AGAIN && authProblem !== ANSWER_AGAIN) return { text: authProblem, problem: true, link: false };
  if (pending.length) return { text: unsignedAccountLabel(pending), problem: false, link: true };
  if (needsConsent) return { text: CONSENT_AGAIN, problem: true, link: true };
  return { text: "", problem: false, link: false };
}

function refreshAuthBanner() {
  const banner = document.getElementById("auth-banner");
  if (!banner) return;
  const state = inDesktop() ? authBannerState() : { text: "", problem: false, link: false };
  banner.hidden = !state.text;
  banner.classList.toggle("problem", !!state.problem);
  banner.replaceChildren();
  if (state.text && state.link) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "auth-link";
    link.textContent = state.text;
    link.onclick = () => showSettings("accounts");
    banner.appendChild(link);
  } else if (state.text) {
    banner.textContent = state.text;
  }
  document.body.classList.toggle("has-auth-banner", !!state.text);
}

let calendarSyncToken = 0;
const calendarSynced = new Map();

function closeCalendarColour() {
  if (calColourMenu) calColourMenu.remove();
  calColourMenu = null;
  calColourAnchor = null;
  document.removeEventListener("pointerdown", onCalendarColourPointer, true);
  document.removeEventListener("keydown", onCalendarColourKey);
}

function onCalendarColourKey(ev) {
  if (ev.key === "Escape") closeCalendarColour();
}

function onCalendarColourPointer(ev) {
  if (calColourMenu && calColourMenu.contains(ev.target)) return;
  if (calColourAnchor && calColourAnchor.contains(ev.target)) return;
  closeCalendarColour();
}

function openCalendarColour(id, anchor) {
  const owner = accountForCalendar(id);
  const cal = findCalendar(id);
  if (!owner || !cal || !anchor) return;
  closeCalendarColour();
  const menu = document.createElement("div");
  menu.className = "cal-colour-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "Colour for " + cal.name);
  menu.innerHTML = `<div class="swatches" role="radiogroup" aria-label="Colour">${calendarPalette.map(([cls, label]) => `
    <button class="swatch ${cls}" type="button" role="radio" aria-checked="${cls === cal.cls ? "true" : "false"}" aria-label="${esc(label)}" data-color="${cls}"></button>
  `).join("")}</div>`;
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  let top = rect.bottom + 4;
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 4);
  menu.style.left = left + "px";
  menu.style.top = top + "px";
  calColourMenu = menu;
  calColourAnchor = anchor;
  menu.querySelectorAll(".swatch").forEach(btn => {
    btn.onclick = () => {
      cal.cls = btn.dataset.color;
      cal.colourChosen = true;
      rememberAccount(owner[0]);
      closeCalendarColour();
      render();
    };
  });
  document.addEventListener("pointerdown", onCalendarColourPointer, true);
  document.addEventListener("keydown", onCalendarColourKey);
}

function colourFromGraph(color) {
  return {
    lightBlue: "work",
    lightTeal: "personal",
    lightGreen: "leaf",
    lightYellow: "gold",
    lightOrange: "orange",
    lightPink: "pink",
    lightRed: "red",
    lightBrown: "clay",
    lightPurple: "plum",
    lightGray: "slate"
  }[color] || "";
}

function paintCalendarColours(accountId, list) {
  const acct = accounts[accountId];
  const previous = new Map(((acct && acct.calendars) || []).map(cal => [cal.id, cal]));
  const used = new Set();
  const rows = list.map(cal => {
    const prior = previous.get(cal.id);
    const name = cal.name || "Calendar";
    if (prior && prior.colourChosen && calendarPalette.some(([cls]) => cls === prior.cls)) {
      used.add(prior.cls);
      return { id: cal.id, name, cls: prior.cls, colourChosen: true, teams: !!cal.teams };
    }
    const mapped = colourFromGraph(cal.color);
    if (mapped && !used.has(mapped)) {
      used.add(mapped);
      return { id: cal.id, name, cls: mapped, colourChosen: false, teams: !!cal.teams };
    }
    return { id: cal.id, name, cls: "", colourChosen: false, teams: !!cal.teams };
  });
  rows.forEach((row, index) => {
    row.canEdit = list[index].canEdit !== false;
    row.owner = String(list[index].owner || "");
    row.ownerName = String(list[index].ownerName || list[index].owner_name || "");
    row.isShared = !!(list[index].isShared || list[index].is_shared);
  });
  rows.forEach((row, index) => {
    if (row.cls) return;
    let cls = "";
    for (let step = 0; step < calendarPalette.length; step++) {
      const candidate = calendarPalette[(index + step) % calendarPalette.length][0];
      if (!used.has(candidate)) {
        cls = candidate;
        break;
      }
    }
    row.cls = cls || calendarPalette[index % calendarPalette.length][0];
    used.add(row.cls);
  });
  return rows;
}

function calendarRangeIso() {
  const dates = visibleDates();
  const start = new Date(dates[0].getFullYear(), dates[0].getMonth(), dates[0].getDate());
  const end = new Date(dates[dates.length - 1].getFullYear(), dates[dates.length - 1].getMonth(), dates[dates.length - 1].getDate());
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function calendarFetchBounds(visibleStart, visibleEnd, today, backDays, aheadDays) {
  const back = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  back.setDate(back.getDate() - backDays);
  const ahead = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  ahead.setDate(ahead.getDate() + aheadDays + 1);
  const windowStart = back.toISOString();
  const windowEnd = ahead.toISOString();
  return {
    start: visibleStart < windowStart ? visibleStart : windowStart,
    end: visibleEnd > windowEnd ? visibleEnd : windowEnd
  };
}

function calendarSyncRange() {
  const visible = calendarRangeIso();
  return calendarFetchBounds(visible.start, visible.end, todayDate(), calSyncBack, calSyncAhead);
}

function accountCalendarCovers(id, visible) {
  const mark = calendarSynced.get(id);
  return !!(mark && visible.start >= mark.start && visible.end <= mark.end);
}

function applyLiveCalendars(accountId, list) {
  const acct = accounts[accountId];
  if (!acct || !Array.isArray(list) || !list.length) return;
  const serverIds = new Set(list.map(cal => cal.id));
  const local = (acct.calendars || []).filter(cal => !serverIds.has(cal.id) && /^cal-\d+$/.test(String(cal.id)));
  acct.calendars = paintCalendarColours(accountId, list).concat(local);
  if (!acct.calendars.some(cal => cal.id === defaultCalendarId)) {
    const preferred = list.find(cal => cal.isDefault) || list[0];
    if (preferred) defaultCalendarId = preferred.id;
  }
  rememberAccount(accountId);
}

function installLiveEvents(accountId, items) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].account === accountId && events[i].live) events.splice(i, 1);
  }
  for (let i = allday.length - 1; i >= 0; i--) {
    if (allday[i].account === accountId && allday[i].live) allday.splice(i, 1);
  }
  (items || []).forEach(item => {
    if (!item || !item.id || dismissedLive.has(String(item.id))) return;
    const showAs = item.showAs === "free" || item.showAs === "oof" ? item.showAs : "busy";
    const organizer = item.organizerEmail ? { name: item.organizerName || item.organizerEmail, email: item.organizerEmail } : null;
    const shared = {
      live: true,
      account: accountId,
      calendar: item.calendarId,
      title: item.title || "(No title)",
      where: item.location || "",
      notes: item.notes || "",
      showAs,
      tentative: item.response === "tentative" || item.showAs === "tentative",
      response: item.response || "",
      isOrganizer: !!item.isOrganizer,
      eventId: item.id,
      kind: item.kind || "singleInstance",
      seriesMasterId: item.seriesMasterId || "",
      reminder: Number.isInteger(item.reminder) ? item.reminder : -1,
      joinUrl: item.joinUrl || "",
      organizer,
      attendees: Array.isArray(item.attendees) ? item.attendees : []
    };
    if (item.allDay) {
      const start = dayFromIso(String(item.start || "").slice(0, 10));
      const end = dayFromIso(String(item.end || "").slice(0, 10));
      if (start == null || end == null || end <= start) return;
      for (let day = start; day < end; day++) {
        const id = end - start > 1 ? item.id + "@" + isoFromDay(day) : item.id;
        allday.push(Object.assign({}, shared, { id, day }));
      }
      return;
    }
    const start = new Date(item.start);
    const end = new Date(item.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return;
    const slices = [];
    let cursor = new Date(start);
    while (cursor < end) {
      const next = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
      const sliceEnd = end < next ? end : next;
      const startMin = cursor.getHours() * 60 + cursor.getMinutes();
      const endMin = sliceEnd.getTime() === next.getTime() ? 24 * 60 : sliceEnd.getHours() * 60 + sliceEnd.getMinutes();
      if (endMin > startMin) slices.push({ day: dayFromDate(cursor), start: startMin, end: endMin });
      cursor = next;
    }
    slices.forEach(slice => {
      const id = slices.length > 1 ? item.id + "@" + isoFromDay(slice.day) : item.id;
      events.push(Object.assign({}, shared, slice, { id }));
    });
  });
}

function installLiveContacts(accountId, items) {
  for (let i = contacts.length - 1; i >= 0; i--) {
    if (contacts[i].account === accountId && contacts[i].live) contacts.splice(i, 1);
  }
  const acct = accounts[accountId];
  const color = contactColors[(acct && acct.cls) || "work"] || "#0f6cbd";
  (items || []).forEach(item => {
    if (!item || !item.id || !item.name) return;
    contacts.push({
      id: item.id,
      live: true,
      account: accountId,
      name: item.name,
      email: item.email || "",
      phone: item.phone || "",
      title: item.title || "",
      company: item.company || "",
      initials: contactInitials(item.name),
      color
    });
  });
  if (!contacts.some(person => person.id === selectedContact)) {
    const list = filteredContacts();
    selectedContact = list[0] ? list[0].id : null;
  }
}

function noteSyncProblem(err) {
  if (mailServerBusy(err && err.message || err)) return;
  if (noteUnreachable(err)) return;
  if (!authProblem) authProblem = String(err && err.message || err);
}

// The network is often still down in the first seconds after login. A sync
// that fails then used to leave "Could not reach Google." up for the rest of
// the session. Try again a few times first, and only then show the banner.
// A later check that gets through takes the banner down.
let reachProblem = "";
let reachSeen = 0;
let reachRetryTimer = 0;
let reachRetryAttempt = 0;
let reachGaveUp = false;
// Tests pass window.__reachWaits, in seconds, so they need not wait the real pauses.
const REACH_WAITS = Array.isArray(window.__reachWaits) && window.__reachWaits.length ? window.__reachWaits.map(Number) : [5, 10, 20, 40, 60];
const REACH_NOTE = "Waiting for the network…";

function couldNotReach(err) {
  return String(err && err.message || err || "").startsWith("Could not reach ");
}

function stopReachRetry() {
  clearTimeout(reachRetryTimer);
  reachRetryTimer = 0;
  reachRetryAttempt = 0;
  reachGaveUp = false;
  reachProblem = "";
}

function clearReachProblem() {
  const showing = couldNotReach(authProblem);
  stopReachRetry();
  if (showing) {
    authProblem = "";
    refreshAuthBanner();
  }
  if (syncNote === REACH_NOTE) setSyncNote("");
}

function giveUpReach() {
  reachGaveUp = true;
  clearTimeout(reachRetryTimer);
  reachRetryTimer = 0;
  if (reachProblem && (!authProblem || couldNotReach(authProblem))) {
    authProblem = reachProblem;
    refreshAuthBanner();
  }
  if (syncNote === REACH_NOTE) setSyncNote("");
}

function scheduleReachRetry() {
  if (reachRetryTimer || reachGaveUp) return;
  if (reachRetryAttempt >= REACH_WAITS.length) {
    giveUpReach();
    return;
  }
  const seconds = REACH_WAITS[reachRetryAttempt];
  reachRetryAttempt += 1;
  showStartupSync(REACH_NOTE);
  reachRetryTimer = setTimeout(() => {
    reachRetryTimer = 0;
    retryReach();
  }, seconds * 1000);
}

// True when this failure is a dropped connection, and a retry is armed.
function noteUnreachable(err) {
  const text = String(err && err.message || err || "");
  if (!couldNotReach(text)) return false;
  reachProblem = text;
  reachSeen += 1;
  scheduleReachRetry();
  return true;
}

async function retryReach() {
  if (!reachProblem || reachGaveUp) return;
  if (mailPolling) {
    reachRetryTimer = setTimeout(() => {
      reachRetryTimer = 0;
      retryReach();
    }, 1000);
    return;
  }
  mailPolling = true;
  let missed = "";
  const seen = reachSeen;
  try {
    for (const [id, acct] of Object.entries(accounts)) {
      if (!acct.signedIn || !acct.email || accountNeedsSignIn(id)) continue;
      try {
        const inbox = await tauriInvoke("sync_inbox", { email: acct.email, since: syncSinceIso() });
        fillAccountMail(id, inbox);
        noteNewMail(id);
        await loadCachedDrafts(id);
      } catch (err) {
        if (couldNotReach(err)) missed = String(err && err.message || err);
      }
    }
    if (!missed) await syncCalendars(null, view === "calendar");
  } finally {
    mailPolling = false;
  }
  if (reachSeen !== seen) return;
  if (missed) {
    reachProblem = missed;
    scheduleReachRetry();
    return;
  }
  clearReachProblem();
  if (view === "mail") {
    render();
    if (account === "all") ensureUnifiedFolder(box);
    else ensureFolderMessages(account, box);
  } else if (view === "calendar") {
    render();
  }
}

async function syncContacts(accountId) {
  if (!inDesktop()) return;
  const ids = accountId ? [accountId] : Object.keys(accounts);
  for (const id of ids) {
    const acct = accounts[id];
    if (!acct || !acct.signedIn) continue;
    try {
      const people = await tauriInvoke("sync_contacts", { email: acct.email });
      installLiveContacts(id, people || []);
      recordDirectory(id, "contacts", null);
    } catch (err) {
      recordDirectory(id, "contacts", err);
    }
  }
}

async function syncCalendars(accountId, paint) {
  if (!inDesktop()) return;
  const token = ++calendarSyncToken;
  const range = calendarSyncRange();
  const ids = accountId ? [accountId] : Object.keys(accounts);
  for (const id of ids) {
    if (token !== calendarSyncToken) return;
    const acct = accounts[id];
    if (!acct || !acct.signedIn) continue;
    try {
      const result = await tauriInvoke("sync_calendar", {
        email: acct.email,
        start: range.start,
        end: range.end
      });
      if (token !== calendarSyncToken) return;
      applyLiveCalendars(id, result && result.calendars);
      installLiveEvents(id, result && result.events);
      calendarSynced.set(id, { start: range.start, end: range.end });
      recordDirectory(id, "calendar", null);
    } catch (err) {
      recordDirectory(id, "calendar", err);
    }
  }
  if (token !== calendarSyncToken) return;
  refreshAuthBanner();
  if (paint && view === "calendar") render();
}

function refreshLiveCalendar() {
  const visible = calendarRangeIso();
  const pending = Object.keys(accounts).some(id => {
    const acct = accounts[id];
    return acct && acct.signedIn && !accountCalendarCovers(id, visible);
  });
  if (!pending) return;
  const job = syncCalendars(null, true);
  if (job && job.catch) job.catch(() => {});
}

async function syncAccountDirectory(accountId, paint) {
  await syncContacts(accountId);
  await syncCalendars(accountId, paint);
  if (paint && view === "people") render();
}

function syncLabel(acct) {
  const name = acct && acct.name;
  return name ? "Syncing " + name + "…" : "Syncing your mail…";
}

function setSyncNote(text) {
  syncNote = text || "";
  let el = document.getElementById("sync-note");
  if (!syncNote) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = "sync-note";
    el.className = "sync-note";
    el.setAttribute("role", "status");
    el.innerHTML = `<span class="sync-spin" aria-hidden="true"></span><span class="sync-note-text"></span>`;
    // A status line at the foot of the folder pane (see .sync-note), so the
    // mail stays usable while a long first sync runs.
    document.body.appendChild(el);
  }
  el.querySelector(".sync-note-text").textContent = syncNote;
  el.title = syncNote;
}

// A fresh Gmail folder first shows its newest messages. This fills the rest
// into the local cache a batch at a time. The list reads those older rows
// when the reader reaches the bottom. Microsoft folders come whole.
const backfilling = new Set();

async function backfillFolder(accountId, key) {
  const acct = accounts[accountId];
  if (!acct || !acct.signedIn || !acct.email || !inDesktop() || popCompose || assistWindow) return;
  const folder = (acct.liveFolders || []).find(item => item.key === key);
  const folderId = graphFolderId(folder);
  const mark = folderMark(accountId, key);
  if (!folderId || backfilling.has(mark)) return;
  backfilling.add(mark);
  let note = "";
  const say = text => {
    if (syncNote && syncNote !== note) return;
    note = text;
    setSyncNote(text);
  };
  try {
    for (let round = 0; round < 50; round++) {
      const r = await tauriInvoke("backfill_mail", { email: acct.email, folderId, folder_id: folderId, since: syncSinceIso() });
      if (!r || !r.added) break;
      const state = folderPage.get(mark) || { before: "", beforeId: "", more: false, loading: false };
      if (state.before) state.more = true;
      state.loading = false;
      folderPage.set(mark, state);
      // A short list is already at the bottom, so it keeps reading. A full page waits for a scroll.
      if (viewingMailFolder(accountId, key)) maybeFillShortList();
      if (!r.remaining) break;
      say("Syncing " + acct.name + " " + (folder.name || "mail") + "… " + r.have + " of " + r.total);
    }
  } catch (err) {
    // The next sync carries on from what is cached.
  } finally {
    backfilling.delete(mark);
    if (note && syncNote === note) setSyncNote("");
  }
}

async function backfillInboxes() {
  for (const id of Object.keys(accounts)) {
    if (accounts[id] && accounts[id].signedIn) await backfillFolder(id, "inbox");
  }
}

function showStartupSync(text) {
  if (popCompose || assistWindow) return;
  setSyncNote(text || "Syncing your mail…");
  if (view === "mail") render();
}

async function bootLiveMail() {
  if (!inDesktop()) return;
  if (assistWindow) {
    refreshAiKeys();
    return;
  }
  refreshAuthBanner();
  refreshAiKeys();
  if (Object.keys(accounts).length) showStartupSync("Syncing your mail…");
  try {
    const status = await tauriInvoke("account_status");
    if (!status || !status.signedIn) {
      setSyncNote("");
      authProblem = "";
      refreshAuthBanner();
      openAddAccountPopup();
      return;
    }
    savedAccountRecords().forEach(installAccount);
    restoreFavorites();
    for (const item of signedAccountsFrom(status)) {
      const email = String(item.email || "");
      if (!email || accountByEmail(email)) continue;
      const created = addAccount({
        yourName: item.name || "Jon",
        name: item.name || email.split("@")[0] || "Account",
        email,
        cls: "work"
      });
      if (typeof created !== "string") rememberAccount(created.id);
    }
    applySavedSignIns(status);
    adoptSavedDefaults();
    settleProfileSelection();
    restoreOutbox();
    refreshOpenComposeFrom();
    authProblem = "";
    refreshAuthBanner();
    // This webview shares the WebKit process with the main window. A mailbox sync here freezes the app.
    if (popCompose) {
      setSyncNote("");
      return;
    }
    let paintedCache = false;
    for (const [id, acct] of Object.entries(accounts)) {
      if (!acct.signedIn || !acct.email) continue;
      try {
        const cached = await tauriInvoke("saved_inbox", { email: acct.email });
        if (cached && Array.isArray(cached.folders) && cached.folders.length) {
          fillAccountMail(id, cached);
          await loadCachedDrafts(id);
          paintedCache = true;
          if (view === "mail") render();
        }
      } catch (err) {}
    }
    if (paintedCache) setSyncNote("");
    else showStartupSync("Syncing your mail…");
    const syncing = Object.entries(accounts).filter(([, acct]) => acct.signedIn);
    await Promise.all(syncing.map(async ([id, acct]) => {
      if (!(acct.liveFolders && acct.liveFolders.length)) {
        setSyncNote(syncLabel(acct));
        if (view === "mail") render();
      }
      try {
        const inbox = await tauriInvoke("sync_inbox", { email: acct.email, since: syncSinceIso() });
        fillAccountMail(id, inbox);
        noteNewMail(id);
        await loadCachedDrafts(id);
        if (view === "mail") render();
      } catch (err) {
        if (!noteUnreachable(err)) authProblem = String(err && err.message || err);
      }
    }));
    if (!reachProblem || reachGaveUp) setSyncNote("");
    refreshAuthBanner();
    if (view === "mail") {
      render();
      if (account === "all") ensureUnifiedFolder(box);
      else ensureFolderMessages(account, box);
    }
    backfillInboxes();
    await syncAccountDirectory(null, true);
    refreshAuthBanner();
  } catch (err) {
    if (noteUnreachable(err)) {
      if (view === "mail" && Object.keys(accounts).length) render();
      return;
    }
    setSyncNote("");
    authProblem = String(err && err.message || err);
    refreshAuthBanner();
    if (popCompose) return;
    if (Object.keys(accounts).length) {
      if (view === "mail") render();
      return;
    }
    openAddAccountPopup();
    const note = document.querySelector("#add-account-popup #account-error");
    if (note) {
      note.hidden = false;
      note.textContent = authProblem;
    }
  }
}

function paintAppVersion(version) {
  const text = String(version || "").trim();
  if (text) appVersion = text;
  const brand = document.getElementById("app-version");
  if (brand) brand.textContent = appVersion;
  const settings = document.getElementById("settings-version");
  if (settings) settings.textContent = appVersion;
}

async function loadAppVersion() {
  paintAppVersion(APP_VERSION);
  if (!inDesktop()) return;
  try {
    const version = await tauriInvoke("plugin:app|version");
    if (version) paintAppVersion(version);
  } catch (e) {}
}

// ---- New mail: a check every two minutes, and notifications ----
const POLL_CHOICES = [1, 2, 5, 10, 15, 30, 0];
let pollMinutes = (() => { try { const n = Number(localStorage.getItem("mailroom-poll-minutes")); return POLL_CHOICES.includes(n) && localStorage.getItem("mailroom-poll-minutes") !== null ? n : 2; } catch (e) { return 2; } })();
let pollTimer = 0;

function armMailPolling() {
  clearInterval(pollTimer);
  pollTimer = pollMinutes ? setInterval(pollMail, pollMinutes * 60 * 1000) : 0;
}

function pollLabel(n) {
  return n === 0 ? "Only when I press Check for new mail" : n === 1 ? "Every minute" : "Every " + n + " minutes";
}
let notifyNewMail = (() => { try { return localStorage.getItem("mailroom-notify") !== "off"; } catch (e) { return true; } })();
let mailPolling = false;
let lastMailPoll = 0;

function notifiedMarks() {
  try {
    const marks = JSON.parse(localStorage.getItem("mailroom-notified") || "{}");
    return marks && typeof marks === "object" ? marks : {};
  } catch (e) {
    return {};
  }
}

// Notify about unread Inbox mail newer than the last mail seen for this
// account. The first look at an account only sets the mark.
function noteNewMail(accountId) {
  const own = ownAddresses();
  const inbox = messages.filter(m => m.live && m.account === accountId && messageBox(m) === "inbox" && m.received);
  if (!inbox.length) return;
  const marks = notifiedMarks();
  const mark = marks[accountId] || "";
  const newest = inbox.reduce((top, m) => (m.received > top ? m.received : top), mark);
  marks[accountId] = newest;
  try { localStorage.setItem("mailroom-notified", JSON.stringify(marks)); } catch (e) {}
  if (!mark || !accountInProfile(accountId)) return;
  const fresh = inbox
    .filter(m => m.unread && m.received > mark && !own.has(String(m.email || "").toLowerCase()) && (!focusedInbox || focusOf(m) === "focused"))
    .sort((a, b) => (a.received < b.received ? 1 : -1));
  if (!fresh.length || !notifyNewMail || (!document.hidden && document.hasFocus())) return;
  const shown = fresh.length > 3 ? [] : fresh;
  shown.forEach(m => {
    const call = tauriInvoke("notify_mail", { title: m.from || m.email || "New mail", body: m.subject + (m.preview ? " — " + m.preview : ""), messageId: m.id });
    if (call && call.catch) call.catch(() => {});
  });
  if (!shown.length) {
    const names = [...new Set(fresh.map(m => m.from || m.email))].slice(0, 4).join(", ");
    const call = tauriInvoke("notify_mail", { title: fresh.length + " new messages", body: names, messageId: fresh[0].id });
    if (call && call.catch) call.catch(() => {});
  }
}

// A click on a notification opens the message, or the meeting.
function openFromNotification(id) {
  if (String(id).startsWith("event:")) {
    const ev = events.find(e => e.id === String(id).slice(6)) || allday.find(e => e.id === String(id).slice(6));
    if (!ev) return setView("calendar");
    if (accounts[ev.account] && !calendarAccountVisible(ev.account)) {
      calendarBoth = false;
      rememberCalendarBoth();
      activeProfile = accountProfile(ev.account);
      rememberActiveProfile();
    }
    const shown = dateFromDay(ev.day);
    calFocus = calView === "month" ? new Date(shown.getFullYear(), shown.getMonth(), 1) : shown;
    setView("calendar");
    openEventEditor(ev.id, "timed");
    return;
  }
  const msg = messages.find(m => m.id === id);
  if (!msg) return;
  if (accounts[msg.account] && !accountInProfile(msg.account)) {
    activeProfile = accountProfile(msg.account);
    rememberActiveProfile();
  }
  view = "mail";
  account = msg.account;
  box = messageBox(msg);
  folderPick = "folder";
  selected = msg.id;
  folded.delete(msg.id);
  expanded.add(msg.id);
  render();
  if (msg.unread) setUnread([msg], false, false);
}

async function pollMail() {
  if (mailPolling) return;
  mailPolling = true;
  lastMailPoll = Date.now();
  let missed = "";
  try {
    for (const [id, acct] of Object.entries(accounts)) {
      if (!acct.signedIn || !acct.email || accountNeedsSignIn(id)) continue;
      try {
        const inbox = await tauriInvoke("sync_inbox", { email: acct.email, since: syncSinceIso() });
        fillAccountMail(id, inbox);
        noteNewMail(id);
      } catch (err) {
        // A failed check waits for the next one. A dropped connection is
        // tried again shortly. Sign-in problems show in the banner.
        if (couldNotReach(err)) missed = String(err && err.message || err);
      }
    }
    // Leave the reading pane alone, so a reply being typed is not touched.
    // An open search is asked again, without clearing the rows already shown.
    if (searchActive()) searchCacheStale = true;
    renderFolders();
    reportUnread(false);
    if (view === "mail") renderList();
  } finally {
    mailPolling = false;
  }
  if (missed) noteUnreachable(missed);
  else if (reachProblem || couldNotReach(authProblem)) clearReachProblem();
}

// Check every account now, from the button or F5.
async function checkMailNow() {
  const btn = document.getElementById("check-mail");
  if (!inDesktop()) return toast("Checking for mail needs a signed-in account.");
  if (mailPolling || (btn && btn.classList.contains("spinning"))) return;
  const before = new Set(messages.filter(m => m.live && messageBox(m) === "inbox").map(m => m.id));
  if (btn) { btn.classList.add("spinning"); btn.disabled = true; }
  try {
    await pollMail();
    await checkSnoozes();
  } finally {
    if (btn) { btn.classList.remove("spinning"); btn.disabled = false; }
  }
  const fresh = messages.filter(m => m.live && messageBox(m) === "inbox" && !before.has(m.id) && accountInProfile(m.account)).length;
  toast(fresh ? (fresh === 1 ? "1 new message" : fresh + " new messages") : "Up to date");
}

function startMailPolling() {
  if (!inDesktop() || popCompose || assistWindow) return;
  armMailPolling();
  setInterval(checkSnoozes, 60 * 1000);
  checkSnoozes();
  setInterval(checkReminders, 30 * 1000);
  setTimeout(checkReminders, 5000);
  setInterval(checkFollowUps, 60 * 1000);
  setTimeout(checkFollowUps, 8000);
  // New meetings need to be on hand to be reminded about.
  setInterval(() => { syncCalendars(null, false).then(() => { if (view === "calendar") render(); }); }, 15 * 60 * 1000);
  Object.keys(accounts).forEach(id => {
    loadCategories(id).then(() => { if (view === "mail") render(); });
    loadAliases(id).then(() => { if (view === "mail") render(); });
    loadSearchFolders(id).then(() => { if (view === "mail") render(); });
  });
  checkAutoReplies();
  loadDirectory();
  setTimeout(() => checkForUpdate(true), 30 * 1000);
  setInterval(() => checkForUpdate(true), 6 * 3600 * 1000);
  window.addEventListener("focus", () => {
    if (Date.now() - lastMailPoll > 60 * 1000) pollMail();
  });
}

bindAssist();
loadAppVersion();
initOmarchy();
bindMailPaging();
Promise.resolve(bootLiveMail()).finally(() => {
  startMailPolling();
  takeLaunchRequest();
});
