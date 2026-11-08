// The README's screenshots, from made-up mail and meetings, in Omarchy's
// Tokyo Night theme. Nothing here comes from a real mailbox.
//   cd e2e && node screenshots.mjs        # writes ../screenshots/*.png
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { serve } from "./server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "screenshots");
fs.mkdirSync(out, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
const chrome = process.env.CHROME || ["/usr/bin/chromium", "/usr/bin/google-chrome"].find(p => fs.existsSync(p));

const TOKYO = { theme: "Tokyo Night", mode: "dark", font: "JetBrainsMono Nerd Font", rounding: 0, colors: {
  accent: "#7aa2f7", selection: "#292e42", muted: "#414868", background: "#1a1b26", dark_background: "#13141c", lighter_background: "#24283b",
  foreground: "#a9b1d6", dark_foreground: "#565f89", red: "#f7768e", yellow: "#e0af68", orange: "#eb927b", green: "#9ece6a", cyan: "#449dab",
  blue: "#7aa2f7", magenta: "#ad8ee6", brown: "#75493d", bright_yellow: "#ff9e64", bright_magenta: "#bb9af7" } };

// Runs in the page: swap the built-in sample for the demo cast.
function stage(look) {
  localStorage.setItem("mailroom-omarchy-adopted", "1");
  localStorage.setItem("mailroom-theme", "omarchy");
  accounts.timberworks.name = "Timberworks";
  accounts.timberworks.email = "sam@timberworks.example";
  accounts.timberworks.yourName = "Sam";
  accounts.timberworks.emails = [{ id: "mail-timberworks", address: "sam@timberworks.example" }];
  accounts.timberworks.calendars[0].name = "Timberworks";
  // A second work account: two employers (or a client) side by side.
  accounts.maplehill = {
    name: "Maplehill", email: "sam@maplehill.example", cls: "work", yourName: "Sam", profile: "work",
    emails: [{ id: "mail-maplehill", address: "sam@maplehill.example" }],
    calendars: [{ id: "cal-maplehill", name: "Maplehill", cls: "plum" }]
  };
  accounts.personal.email = "sam.rivers@example.com";
  accounts.personal.yourName = "Sam";
  accounts.personal.emails = [{ id: "mail-personal", address: "sam.rivers@example.com" }];
  const p = (id, thread, seq, account, from, email, color, subject, preview, time, more) => Object.assign({
    id, thread, seq, account, from, email, color, subject, preview, time, unread: false,
    initials: from.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase(), body: preview
  }, more || {});
  const team = n => n.toLowerCase().replace(" ", ".") + "@timberworks.example";
  const maple = n => n.toLowerCase().replace(" ", ".") + "@maplehill.example";
  messages.length = 0;
  messages.push(
    p("launch-1", "launch", 10, "timberworks", "Priya Shah", team("Priya Shah"), "#7aa2f7", "Launch plan for the Hartley site", "First draft of the launch plan is in the deck. Can we walk it on Thursday?", "Monday",
      { body: "First draft of the launch plan is in the deck. Can we walk it on Thursday? I've left the budget slide rough on purpose." }),
    p("launch-2", "launch", 95, "timberworks", "Priya Shah", team("Priya Shah"), "#7aa2f7", "Launch review moved to 10:00", "Can you still make Thursday if we pull it forward an hour?", "08:14",
      { unread: true, cc: [team("Tom Becker"), team("Ines Moreau")],
        meeting: { title: "Launch review", when: "Thursday 15 October, 10:00–11:00", where: "Studio · Teams" },
        body: "Tom has a clash in the afternoon, so I've moved the launch review to 10:00. Same agenda: the timeline, then the two open risks. Bring the site photos if you have them." }),
    p("photos", "photos", 90, "timberworks", "Tom Becker", team("Tom Becker"), "#9ece6a", "Site photos from this morning", "Twelve from the walk-round, and the drone shots of the roof.", "07:52",
      { unread: true, attachments: [{ name: "Hartley-roof.pdf", size: "4.2 MB", type: "pdf" }] }),
    p("invoice", "invoice", 85, "timberworks", "Northgate Supplies", "accounts@northgate.example", "#e0af68", "Invoice INV-4471 is ready", "£2,340.00 due 30 October. Pay online or by bank transfer.", "Yesterday",
      { external: true }),
    p("brief", "brief", 88, "maplehill", "Ana Ruiz", maple("Ana Ruiz"), "#bb9af7", "Brief for the spring catalogue", "Here's the brief and the shot list. Can you have a first layout by Friday?", "Yesterday",
      { unread: true, attachments: [{ name: "Spring-brief.docx", size: "220 KB", type: "doc" }] }),
    p("tickets", "tickets", 80, "personal", "Coastline Rail", "tickets@coastline.example", "#449dab", "Your tickets for Saturday", "Booking reference CR-20418. Departs 09:12 from platform 4.", "Yesterday",
      { unread: true }),
    p("climb", "climb", 70, "personal", "Jess Okafor", "jess.okafor@example.com", "#bb9af7", "Climbing on Sunday?", "The wall's open till 6. Bring the spare harness if you still have it.", "Monday"),
    p("rates", "rates", 65, "maplehill", "Leo Hart", maple("Leo Hart"), "#e0af68", "Day rates for next quarter", "Same as this quarter is fine by us. I'll send the PO on Monday.", "Monday"),
    p("draft", "notes", 60, "timberworks", "Ines Moreau", team("Ines Moreau"), "#ff9e64", "Notes from the design crit", "Keep the timber cladding. We'll test the darker stain next week.", "Monday",
      { attachments: [{ name: "Design-crit.pdf", size: "1.1 MB", type: "pdf" }] }),
    p("news", "news", 50, "personal", "The Weekend Edit", "hello@weekendedit.example", "#f7768e", "Ten walks within an hour of the city", "Plus: the best new bakeries, and what's on this month.", "Sunday",
      { other: true, unsubscribe: "https://weekendedit.example/u" })
  );
  const when = { "launch-1": "2026-10-12", "launch-2": "2026-10-15", photos: "2026-10-15", brief: "2026-10-14", rates: "2026-10-12", invoice: "2026-10-14", tickets: "2026-10-14", climb: "2026-10-12", draft: "2026-10-12", news: "2026-10-09" };
  messages.forEach(m => { m.date = when[m.id]; });
  const d = i => dayFromDate(new Date(2026, 9, 12 + i));
  const tw = { account: "timberworks", calendar: "cal-timberworks" };
  const home = { account: "personal", calendar: "cal-personal" };
  const mh = { account: "maplehill", calendar: "cal-maplehill" };
  const people = [
    { email: team("Priya Shah"), name: "Priya Shah", status: "accepted" },
    { email: team("Tom Becker"), name: "Tom Becker", status: "tentative" },
    { email: team("Ines Moreau"), name: "Ines Moreau", status: "none" }
  ];
  events = [
    ...[0, 1, 2, 3, 4].map(i => Object.assign({ id: "stand-" + i, day: d(i), start: 9 * 60, end: 9 * 60 + 15, title: "Standup", where: "Teams" }, tw)),
    Object.assign({ id: "crit", day: d(0), start: 14 * 60, end: 15 * 60 + 30, title: "Design crit", where: "Studio" }, tw),
    Object.assign({ id: "dentist", day: d(1), start: 11 * 60, end: 12 * 60, title: "Dentist", showAs: "oof" }, home),
    Object.assign({ id: "client", day: d(1), start: 13 * 60 + 30, end: 14 * 60 + 30, title: "Hartley client call", where: "Zoom" }, tw),
    Object.assign({ id: "kickoff", day: d(0), start: 16 * 60, end: 16 * 60 + 45, title: "Maplehill catalogue kickoff", where: "Teams" }, mh),
    Object.assign({ id: "layout", day: d(4), start: 14 * 60, end: 15 * 60, title: "Layout review", where: "Teams" }, mh),
    Object.assign({ id: "focus", day: d(2), start: 10 * 60, end: 12 * 60, title: "Focus: launch deck", showAs: "free" }, tw),
    Object.assign({ id: "lunch", day: d(2), start: 12 * 60 + 30, end: 13 * 60 + 30, title: "Lunch with Jess", showAs: "free" }, home),
    Object.assign({ id: "launch", day: d(3), start: 10 * 60, end: 11 * 60, title: "Launch review", where: "Studio · Teams", tentative: true,
      notes: "Timeline, then the two open risks.", organizer: { name: "Priya Shah", email: team("Priya Shah") }, attendees: people }, tw),
    Object.assign({ id: "supplier", day: d(3), start: 15 * 60, end: 15 * 60 + 45, title: "Northgate supplier sync", where: "Google Meet" }, tw),
    Object.assign({ id: "pickup", day: d(3), start: 16 * 60 + 30, end: 17 * 60, title: "School pickup", showAs: "free" }, home),
    Object.assign({ id: "allhands", day: d(4), start: 11 * 60, end: 12 * 60, title: "All hands", where: "Teams" }, tw)
  ];
  allday.length = 0;
  allday.push(Object.assign({ id: "site", day: d(4), title: "Hartley site visit", showAs: "oof" }, tw));
  selected = "launch-2";
  applyOmarchyLook(look);
}

const { server, url } = await serve();
const browser = await puppeteer.launch({ executablePath: chrome, args: ["--no-sandbox"], env: { ...process.env, TZ: "Europe/London" } });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 860, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: "load" });
await wait(800);
await page.evaluate(stage, TOKYO);
await page.evaluate(() => render());
await wait(500);

const shoot = async (name, fn) => {
  if (fn) { await page.evaluate(fn); await wait(500); }
  await page.screenshot({ path: path.join(out, name + ".png") });
  console.log("wrote screenshots/" + name + ".png");
};

await shoot("1-mail");
// The same inbox in Mailroom's own Outlook-like look, beside Omarchy's.
await shoot("default-look", () => { setView("mail"); selected = "launch-2"; setTheme("light"); render(); });
await page.evaluate(() => { setTheme("omarchy"); render(); });
await shoot("2-calendar", () => { setView("calendar"); calView = "work"; calendarBoth = true; render(); calTopHour = 8; calendarPinHour = 8; applyHourScale(); });
await shoot("3-ask", () => {
  setView("mail");
  selected = "launch-2"; askAnswer = "The launch review is now Thursday 15 October at 10:00 in the Studio, on Teams (Priya moved it from 11:00 because Tom has a clash). The agenda is the timeline, then the two open risks. Priya asked everyone to bring the site photos; Tom sent the roof photos this morning (Hartley-roof.pdf)."; render();
});
await shoot("4-reply", () => {
  askAnswer = ""; setView("mail"); selected = "launch-2"; render();
  startReply(messages.find(m => m.id === "launch-2"), true);
  const body = document.querySelector("#compose-body");
  if (body) body.innerHTML = "<p>10:00 works. I'll bring the roof photos and the revised timeline.</p><p>Sam</p>";
});
await shoot("5-omarchy", () => { setView("settings"); settingsPage = "omarchy"; render(); });
execFileSync("magick", [
  path.join(out, "default-look.png"), "-bordercolor", "white", "-border", "0x0",
  "(", "-size", "48x1720", "xc:none", ")",
  path.join(out, "1-mail.png"), "+append", "-resize", "2880x", path.join(out, "6-looks.png")
]);
fs.unlinkSync(path.join(out, "default-look.png"));
console.log("wrote screenshots/6-looks.png");

await browser.close();
server.close();
