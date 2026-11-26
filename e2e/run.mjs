// Browser tests for Mailroom. Each test gets a fresh page with either the
// app's own sample mailbox (no backend) or a fake backend that records every
// call. Nothing here touches a real account.
//
//   cd e2e && npm install && node run.mjs [filter]
//
// CHROME may point at a Chrome or Chromium binary.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { serve } from "./server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = fs.readFileSync(path.join(here, "fake.js"), "utf8");
const FILES = path.join(here, "files");
const filter = process.argv[2] || "";

function chromePath() {
  const candidates = [process.env.CHROME, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
  const found = candidates.find(c => c && fs.existsSync(c));
  if (!found) throw new Error("No Chrome or Chromium found. Set CHROME.");
  return found;
}

const tests = [];
const test = (name, opts, fn) => tests.push({ name, opts, fn });
const wait = ms => new Promise(r => setTimeout(r, ms));

class Failure extends Error {}
function expect(ok, what, got) {
  if (!ok) throw new Failure(what + (got === undefined ? "" : " (got " + JSON.stringify(got) + ")"));
}
const same = (got, want, what) => expect(JSON.stringify(got) === JSON.stringify(want), what + ": want " + JSON.stringify(want), got);

function helpers(p) {
  return {
    p,
    calls: cmd => p.evaluate(c => window.__calls.filter(x => x[0] === c).map(x => x[1]), cmd),
    clear: () => p.evaluate(() => { window.__calls = []; }),
    boxOf: id => p.evaluate(id => (messages.find(m => m.id === id) || {}).box, id),
    toast: () => p.$eval("#toast", t => t.textContent).catch(() => ""),
    rightClick: async sel => { const el = await p.$(sel); const b = await el.boundingBox(); await p.mouse.click(b.x + 40, b.y + 10, { button: "right" }); await wait(150); },
    menu: () => p.$$eval("#row-menu:not([hidden]) button", bs => bs.map(b => b.textContent.trim()))
  };
}

// ---------------------------------------------------------------- security

test("a message body is parsed once for its classes and folds; colours read the same off a canvas (#105)", { fake: true }, async ({ p }) => {
  const got = await p.evaluate(() => {
    const legal = "This email and any attachments are confidential and may be privileged. If you are not the intended recipient, please delete it and notify the sender. Any unauthorised use, disclosure or copying is prohibited.";
    const html = `<div class="x"><p>Hi Jon,</p><p>See below.</p></div><div><p>${legal}</p></div><div id="divRplyFwdMsg"><p>From: Ada</p><p>OLD TEXT</p></div>`;
    let parses = 0;
    const real = DOMParser.prototype.parseFromString;
    DOMParser.prototype.parseFromString = function (...args) { parses++; return real.apply(this, args); };
    remoteMailMemo.clear();
    remoteMailHtml(html, false);
    const before = parses;
    const out = fittedMailHtml(html, false, "t105", false);
    const after = parses - before;
    DOMParser.prototype.parseFromString = real;
    const d = document.createElement("div");
    d.innerHTML = out;
    // Innermost legal block only, even when its parents read as legal too.
    const nested = document.createElement("div");
    nested.innerHTML = `<div><div><p>${legal}</p></div></div>`;
    const blocks = legalBlocks(nested);
    const colours = ["#336699", "rgb(10, 20, 30)", "rgba(10,20,30,0.5)", "white", "hsl(120, 100%, 25%)", "not-a-colour"].map(c => {
      const viaCanvas = sampleColour(c);
      const probe = document.createElement("span"); probe.style.backgroundColor = c; document.body.appendChild(probe);
      const m = getComputedStyle(probe).backgroundColor.match(/[\d.]+/g).map(Number); probe.remove();
      return JSON.stringify(viaCanvas) === JSON.stringify({ r: m[0], g: m[1], b: m[2], a: m[3] == null ? 1 : m[3] });
    });
    return { after, classes: !!d.querySelector(".m-x"), quote: !!d.querySelector(".mail-quote:not(.mail-legal)"), legal: !!d.querySelector(".mail-legal"), blocks: blocks.map(b => b.tagName), colours };
  });
  same(got.after, 1, "one parse after the cached remote step");
  same([got.classes, got.quote, got.legal], [true, true, true], "classes prefixed, quote and legal notice folded");
  same(got.blocks, ["P"], "the innermost legal block");
  same(got.colours, [true, true, true, true, true, true], "canvas and page agree on every colour");
});

test("offline: archive and read are kept, stay shown through a sync, and reach the server in order later (#67)", { fake: true }, async ({ p, calls, clear }) => {
  await wait(400);
  await p.evaluate(() => { window.__applyFail = "Could not reach Microsoft Graph: error sending request"; });
  await p.evaluate(() => moveConversation({ messages: [messages.find(m => m.id === "m1")] }, "archive")); await wait(300);
  expect(/^Offline · this change goes to the server/.test(await p.$eval("#toast", t => t.textContent)), "says it will go later", await p.$eval("#toast", t => t.textContent));
  await p.evaluate(() => setUnread([messages.find(m => m.id === "m2")], false, true)); await wait(300);
  const queued = await p.evaluate(() => JSON.parse(localStorage.getItem("mailroom-action-queue")).map(e => [e.kind, e.messageIds]));
  same(queued, [["archive", ["m1"]], ["read", ["m2"]]], "both kept, in order");
  // A sync brings the server's old state back; the list keeps the changes.
  await p.evaluate(() => pollMail()); await wait(600);
  same(await p.evaluate(() => [!!document.querySelector('#rows .row[data-id="m1"]'), document.querySelector('#rows .row[data-id="m2"]').classList.contains("unread"), !!document.querySelector('#rows .row[data-id="m2"] .pending-mark')]), [false, false, true], "m1 still archived, m2 still read, with a clock");
  same((await p.evaluate(() => JSON.parse(localStorage.getItem("mailroom-action-queue")))).length, 2, "still waiting while offline");
  // Back online: the next check sends them, oldest first.
  await p.evaluate(() => { window.__applyFail = null; });
  await clear();
  await p.evaluate(() => pollMail()); await wait(800);
  same((await calls("apply_mail")).map(c => [c.kind, c.messageIds]), [["archive", ["m1"]], ["read", ["m2"]]], "sent in order");
  same(await p.evaluate(() => localStorage.getItem("mailroom-action-queue")), null, "nothing left waiting");
  expect(/2 changes made offline reached the server/.test(await p.$eval("#toast", t => t.textContent)), "and says so");
  same(await p.evaluate(() => !!document.querySelector("#rows .pending-mark")), false, "no clocks left");
  // A change that waited more than a week is dropped.
  await p.evaluate(() => { actionQueue.push({ at: Date.now() - 8 * 86400000, kind: "flag", email: "jon@example.com", account: Object.keys(accounts)[0], source: "", destination: null, messageIds: ["m3"], prior: [] }); });
  await clear();
  await p.evaluate(() => replayQueuedActions()); await wait(400);
  same([(await calls("apply_mail")).length, await p.evaluate(() => actionQueue.length)], [0, 0], "not sent, and gone");
  expect(/could not be made on the server/.test(await p.$eval("#toast", t => t.textContent)), "says it was given up");
});

test("mail HTML cannot run code, through the real reading pane", { fake: true, setup: () => {
  const payload = [
    `<p>Hello</p><img src=x onerror="window.__pwned='img'">`,
    `<img/src=x/onerror=window.__pwned='slash'>`,
    `<svg><script>window.__pwned='svg'</script></svg>`,
    `<a href="javascript:window.__pwned='js'">x</a>`,
    `<iframe srcdoc="<script>parent.__pwned='frame'</script>"></iframe>`,
    `<details open ontoggle="window.__pwned='toggle'">d</details>`,
    `<div class="body-sig" data-sig-src="%3Cimg%2Fsrc%3Dx%2Fonerror%3Dwindow.__pwned%3D'sig'%3E">s</div>`,
    `<meta http-equiv="refresh" content="0;url=https://evil.example">`
  ].join("");
  window.__inbox.push({ id: "evil", thread: "conv-evil", subject: "Invoice", fromName: "Mallory", fromEmail: "m@evil.example", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Invoice", bodyHtml: payload, unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
} }, async ({ p }) => {
  await p.click('.row[data-id="evil"]');
  await wait(1200);
  const left = await p.evaluate(() => document.querySelectorAll("#reading [onerror], #reading [ontoggle], #reading script, #reading iframe, #reading meta, #reading a[href^=javascript]").length);
  same(left, 0, "dangerous markup left in the reading pane");
  same(await p.evaluate(() => window.__pwned || null), null, "injected code ran");
  expect(await p.evaluate(() => document.querySelector("#reading").textContent.includes("Hello")), "the safe part of the message shows");
});

test("remote pictures stay blocked: CSS tricks and a sender's signature", { fake: true, setup: () => {
  const sig = encodeURIComponent(`<img src="https://tracker.example/sig.gif"><style>.x{background:url(https://tracker.example/sigcss.gif)}</style><p class="x">Mallory</p>`);
  const body = `<p>Hello</p>`
    + `<div style="width:20px;height:20px;background-image:image-set(&quot;https://tracker.example/imageset.gif&quot; 1x)">a</div>`
    + `<div style="width:20px;height:20px;background-image:\\75 rl(https://tracker.example/escaped.gif)">b</div>`
    + `<style>.t{background-image:image-set("https://tracker.example/sheet.gif" 1x)} .u{background:\\75 rl(https://tracker.example/sheet2.gif)}</style><div class="t" style="width:20px;height:20px">c</div><div class="u" style="width:20px;height:20px">d</div>`
    + `<div class="body-sig" data-sig-src="${sig}">sig</div>`;
  window.__inbox.push({ id: "track", thread: "conv-track", subject: "Pixels", fromName: "Mallory", fromEmail: "m@evil.example", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Pixels", bodyHtml: body, unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
} }, async ({ p }) => {
  const asked = [];
  p.on("request", r => { if (r.url().includes("tracker.example")) asked.push(r.url()); });
  await p.click('.row[data-id="track"]');
  await wait(1500);
  same(asked, [], "no request reached the tracker");
  expect(await p.evaluate(() => document.querySelector("#reading").textContent.includes("Hello")), "the message shows");
});

test("a picture whose server refuses other sites (CORP) is fetched by the app, once allowed", { fake: true, setup: () => {
  const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  window.__inbox.push({ id: "logo", thread: "conv-logo", subject: "Your receipt", fromName: "Priya", fromEmail: "priya@example.com", received: at, preview: "Receipt", bodyHtml: '<p>Receipt</p><img id="corp" src="https://pics.example/corp.png" alt=""><img id="gone" src="https://pics.example/gone.png" alt="">', unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
  window.__remote = { "https://pics.example/corp.png": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" };
} }, async ({ p, calls }) => {
  await p.setRequestInterception(true);
  p.on("request", r => {
    // As WebKit treats a same-origin CORP reply (a made-up response skips the check).
    if (r.url().endsWith("/corp.png")) r.abort("blockedbyresponse");
    else if (r.url().endsWith("/gone.png")) r.respond({ status: 404, body: "" });
    else r.continue();
  });
  await p.click('.row[data-id="logo"]'); await wait(1200);
  const got = await p.evaluate(() => [...document.querySelectorAll("#reading img")].filter(i => /corp|gone|^data:/.test(i.getAttribute("src") || "")).map(i => [i.getAttribute("src").slice(0, 22), i.naturalWidth]));
  same(got, [["data:image/png;base64,", 1], ["https://pics.example/g", 0]], "the refused picture shows from the app; a missing one stays missing");
  same((await calls("remote_image")).map(a => a.url).sort(), ["https://pics.example/corp.png", "https://pics.example/gone.png"], "each failed picture asked for once");
});

test("safe senders: your accounts' domains are always on the list and cannot be removed", { fake: true, setup: () => {
  const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const msg = (id, email, name) => ({ id, thread: "conv-" + id, subject: "Pictures from " + name, fromName: name, fromEmail: email, received: at, preview: "Pictures", bodyHtml: `<p>Hello</p><img src="https://pics.example/${id}.png" alt="">`, unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
  window.__inbox.push(msg("colleague", "priya@example.com", "Priya"), msg("stranger", "someone@gmail.com", "Someone"));
} }, async ({ p }) => {
  const asked = [];
  p.on("request", r => { if (r.url().includes("pics.example")) asked.push(r.url().split("/").pop()); });
  const open = async id => { await p.click(`.row[data-id="${id}"]`); await wait(900); return p.evaluate(() => !!document.querySelector("#reading .remote-bar")); };
  same(await open("colleague"), false, "a colleague at your account's domain: pictures show");
  same(await open("stranger"), true, "anyone else: pictures blocked");
  same(asked, ["colleague.png"], "only the colleague's picture was fetched");

  await p.click("#rail-settings"); await wait(200);
  await p.click("#settings-safe-senders"); await wait(200);
  const page = () => p.evaluate(() => ({
    fixed: [...document.querySelectorAll("[data-account-sender] .who")].map(el => el.textContent),
    removable: [...document.querySelectorAll("[data-remove-sender]")].map(el => el.dataset.removeSender),
    shared: (document.getElementById("safe-sender-shared") || {}).textContent || ""
  }));
  same(await page(), { fixed: ["example.com", "microsoft.com"], removable: [], shared: "" }, "your account's domain, and microsoft.com for a Microsoft account, are listed with no Remove (#115)");
  same(await p.evaluate(() => [senderIsSafe("account-security-noreply@accountprotection.microsoft.com"), senderIsSafe("news@outlook.com"), senderIsSafe("x@hotmail.com")]),
    [true, false, false], "a Microsoft account makes microsoft.com safe, not outlook.com or hotmail.com");
  await p.type("#safe-sender-input", "Example.com");
  await p.click('#safe-sender-form button[type="submit"]'); await wait(100);
  same(await p.$eval("#safe-sender-error", el => el.textContent), "That is one of your accounts, so it is always safe.", "adding it again explains why");
  same(await p.evaluate(() => { removeSafeSender("@example.com"); return [senderIsSafe("priya@example.com"), JSON.parse(localStorage.getItem("mailroom-safe-senders") || "[]")]; }),
    [true, []], "removing it does nothing, and it is not stored");

  await p.evaluate(() => { installAccount({ id: "acct-gmail", email: "me@gmail.com", name: "Gmail", provider: "google" }); render(); });
  await wait(200);
  const got = await page();
  same(got.fixed, ["example.com", "gmail.com", "microsoft.com"], "a Gmail account makes gmail.com safe (#115)");
  same(got.shared, "", "so Settings no longer says other gmail.com senders are not safe");
  same(await p.evaluate(() => [senderIsSafe("me@gmail.com"), senderIsSafe("someone@gmail.com"), senderIsSafe("me@hotmail.co.uk"), isPublicMailDomain("timberworks.example"), JSON.parse(localStorage.getItem("mailroom-safe-senders") || "[]")]),
    [true, true, false, false, []], "gmail.com is safe and not stored; other public hosts are not");
  await p.evaluate(() => { installAccount({ id: "acct-gm2", email: "me@googlemail.com", name: "Old Gmail", provider: "google" }); render(); });
  await wait(200);
  same((await page()).fixed, ["example.com", "gmail.com", "microsoft.com"], "a googlemail.com sign-in adds gmail.com, not googlemail.com");
  same((await page()).shared, "Your own address at googlemail.com is always safe. Other senders there are not, as anyone can have an address there.", "and googlemail.com is still only your own address");
  await p.evaluate(() => { delete accounts["acct-gm2"]; delete accounts["acct-gmail"]; render(); });
  await wait(200);
  same((await page()).fixed, ["example.com", "microsoft.com"], "gmail.com goes with the last Google account");

  await p.$eval("#safe-sender-input", el => { el.value = ""; });
  await p.type("#safe-sender-input", "partner.org");
  await p.click('#safe-sender-form button[type="submit"]'); await wait(150);
  same((await page()).removable, ["@partner.org"], "a domain you add can be removed");
  await p.click('[data-remove-sender="@partner.org"]'); await wait(150);
  same((await page()).removable, [], "and is gone");
});

// Security audit run-1 (2026-11-08): each finding's payload, kept as a regression.
test("audit: a sender's own markers, var() and custom properties never load a blocked picture", { fake: true, setup: () => {
  const body = `<p>Hello</p>`
    + `<style>.q{width:30px}</style>`
    + `<div class="q" data-mail-style="width:20px;height:20px;background:url(https://tracker.example/marker.gif)">m</div>`
    + `<div style="--p:url(https://tracker.example/var.gif);background-image:var(--p);width:20px;height:20px">v</div>`
    + `<div style="--q:url(https://tracker.example/inherit.gif)"><div style="background-image:var(--q);width:20px;height:20px">w</div></div>`
    + `<div style="--r:u\\72 l(https://tracker.example/escaped-var.gif)"><div style="background:var(--r);width:20px;height:20px">e</div></div>`
    + `<div data-dark-ink style="--dark-ink:url(https://tracker.example/ink.gif)">i</div>`;
  window.__inbox.push({ id: "markers", thread: "conv-markers", subject: "Markers", fromName: "Mallory", fromEmail: "m@evil.example", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Markers", bodyHtml: body, unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
} }, async ({ p }) => {
  const asked = [];
  p.on("request", r => { if (r.url().includes("tracker.example")) asked.push(r.url()); });
  await p.click('.row[data-id="markers"]');
  await wait(1500);
  same(asked, [], "no request reached the tracker");
  same(await p.evaluate(() => document.querySelectorAll("#reading [data-mail-style], #reading [data-mark-bg]").length), 0, "a sender's app markers are dropped");
  expect(await p.evaluate(() => !!document.querySelector("#reading .remote-bar")), "the blocked-pictures bar shows");
});

test("audit: mail cannot cover the message list, search box or reading header", { fake: true, setup: () => {
  const body = `<p>Hello</p>`
    + `<div style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;background:rgba(255,0,0,.3)">cover</div>`
    + `<div style="position:absolute;top:-2000px;left:-2000px;width:5000px;height:5000px;z-index:2147483647">cover 2</div>`;
  window.__inbox.push({ id: "cover", thread: "conv-cover", subject: "Cover", fromName: "Mallory", fromEmail: "m@evil.example", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Cover", bodyHtml: body, unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
} }, async ({ p }) => {
  await p.click('.row[data-id="cover"]');
  await wait(1200);
  const hits = await p.evaluate(() => ["#q", '.row[data-id="cover"]', "#reading h1, #reading .subject, #reading header"].map(sel => {
    const el = document.querySelector(sel);
    if (!el) return "missing " + sel;
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + Math.min(10, r.width / 2), r.top + Math.min(8, r.height / 2));
    return !!(top && top.closest(".letter"));
  }));
  same(hits.filter(h => h !== false), [], "nothing outside the letter is under mail");
});

test("audit: text taken from mail, quoted mail and signatures stays inert", { fake: true }, async ({ p }) => {
  const asked = [];
  p.on("request", r => { if (r.url().includes("tracker.example")) asked.push(r.url()); });
  same(await p.evaluate(() => plainFromHtml('<p>Hi</p><img src="https://tracker.example/plain.gif">')), "Hi", "plain text");
  const sig = await p.evaluate(() => {
    const out = signatureSendable('<stylex><!--</style><img id="x" src="https://tracker.example/sig.gif" onerror="window.__pwned=1">--></stylex><p>Sig</p>');
    const doc = new DOMParser().parseFromString(out, "text/html");
    return doc.querySelectorAll("img, [onerror], #x").length;
  });
  same(sig, 0, "a comment-hidden image stays hidden in the signature");
  const quoted = await p.evaluate(() => quotedBodyHtml('<div class="body-sig" data-sig-src="%3Cimg%20src%3Dhttps%3A%2F%2Ftracker.example%2Fq.gif%3E">s</div>'));
  expect(!quoted.includes("data-sig-src"), "quoted mail carries no signature source", quoted);
  await wait(500);
  same(asked, [], "no request reached the tracker");
  same(await p.evaluate(() => window.__pwned || null), null, "no code ran");
});

test("audit: a display name cannot carry an address into a reply or autocomplete", { fake: true, setup: () => {
  const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  window.__inbox.push({ id: "spoof", thread: "conv-spoof", subject: "Hi", fromName: "Mallory", fromEmail: "m@evil.example", received: at, preview: "Hi", bodyHtml: "<p>Hi</p>", unread: true, flagged: false, hasAttachments: false, files: [], to: [], categories: [],
    cc: [{ name: "Kai Ito, <m@evil.example>", email: "kai@timberworks.example" }], bcc: [] });
  window.__inbox.push({ id: "lookalike", thread: "conv-lookalike", subject: "Hello", fromName: "Priya Shah", fromEmail: "priya.shah@evil.example", received: at, preview: "Hello", bodyHtml: "<p>Hello</p>", unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
} }, async ({ p }) => {
  await p.click('.row[data-id="spoof"]'); await wait(600);
  same(await p.evaluate(() => {
    messages.forEach(m => { if (m.id === "spoof") m.ccPeople = [{ name: "Kai Ito, <m@evil.example>", email: "kai@timberworks.example" }]; });
    return parseAddresses(recipientFieldValue("kai@timberworks.example"));
  }), ["kai@timberworks.example"], "the colleague's address survives the field");
  same(await p.evaluate(() => [addressEmail('"Kai, <m@evil.example>" <kai@timberworks.example>'), addressEmail("Ann <ann@maplehill.example>"), addressEmail("bob@maplehill.example")]),
    ["kai@timberworks.example", "ann@maplehill.example", "bob@maplehill.example"], "the address is the last one outside quotes");
  same(await p.evaluate(() => {
    addDirectory([{ name: "Priya Shah", email: "priya@timberworks.example" }]);
    return peopleMatches("priya", 6).map(person => person.email);
  }).then(list => list[0]), "priya@timberworks.example", "a directory colleague ranks above a look-alike who only wrote in");
});

test("adding a sender's domain to Safe senders shows its pictures", { fake: true, setup: () => {
  const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  window.__inbox.push({ id: "vendor", thread: "conv-vendor", subject: "Quote", fromName: "Arsalan", fromEmail: "arsalan@vendor.example", received: at, preview: "Quote", bodyHtml: '<p>Quote</p><img src="https://pics.example/logo.png" alt="">', unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
} }, async ({ p, calls }) => {
  await p.click('.row[data-id="vendor"]'); await wait(900);
  expect(await p.evaluate(() => !!document.querySelector("#reading [data-trust-sender]")), "the bar offers to trust the domain");
  await p.click("#reading [data-trust-sender]"); await wait(900);
  same(await p.evaluate(() => safeSenders.includes("@vendor.example")), true, "the domain is on the list");
  same((await calls("sender_verified")).map(a => a.messageId), ["vendor"], "the sender is checked");
  same(await p.evaluate(() => !!document.querySelector("#reading .remote-bar")), false, "the bar goes away");
  same(await p.evaluate(() => [...document.querySelectorAll("#reading img")].some(i => /pics\.example/.test(i.getAttribute("src") || ""))), true, "the picture is in the letter");
});

test("a forged safe sender or own address does not load pictures", { fake: true, setup: () => {
  const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const msg = (id, email, name) => ({ id, thread: "conv-" + id, subject: "Pictures from " + name, fromName: name, fromEmail: email, received: at, preview: "Pictures", bodyHtml: `<p>Hello</p><img src="https://pics.example/${id}.png" alt="">`, unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
  window.__inbox.push(msg("real", "priya@example.com", "Priya"), msg("forged", "priya@example.com", "Priya"), msg("me", "jon@example.com", "Jon"));
  window.__unverified = ["forged", "me"];
} }, async ({ p, calls }) => {
  const asked = [];
  p.on("request", r => { if (r.url().includes("pics.example")) asked.push(r.url().split("/").pop()); });
  const open = async id => { await p.click(`.row[data-id="${id}"]`); await wait(900); return p.evaluate(() => (document.querySelector("#reading .remote-bar p") || {}).textContent || ""); };
  same(await open("real"), "", "a colleague whose mail passed its checks: pictures show");
  const forged = await open("forged");
  expect(/didn't pass its sender checks/.test(forged), "a forged colleague: blocked, and the bar says why", forged);
  same(await p.evaluate(() => !!document.querySelector("#reading [data-trust-sender]")), false, "no offer to trust a sender already trusted");
  expect(/didn't pass its sender checks/.test(await open("me")), "mail forged as from you: blocked");
  same(asked, ["real.png"], "only the verified message's picture was fetched");
  same((await calls("sender_verified")).map(a => a.messageId).sort(), ["forged", "me", "real"], "each message checked once");
  await open("real"); await open("forged");
  same((await calls("sender_verified")).length, 3, "answers are remembered");
});

test("audit: safe senders never widen to a public suffix", { fake: true }, async ({ p }) => {
  same(await p.evaluate(() => [organisationalDomain("x@school.edu.sg"), organisationalDomain("x@edu.sg"), organisationalDomain("a@mail.timberworks.co.uk"), organisationalDomain("a@maplehill.com")]),
    ["school.edu.sg", "", "timberworks.co.uk", "maplehill.com"], "registrable domains");
});

test("audit: queued mail is sent only from the mailbox it was written in", { fake: true }, async ({ p }) => {
  same(await p.evaluate(() => {
    const id = Object.keys(accounts)[0];
    const row = (rid, accountEmail) => ({ id: rid, account: id, accountEmail, subject: "Queued", bodyHtml: "<p>x</p>", to: "a@maplehill.example", sendAt: Date.now() + 3600000 });
    localStorage.setItem("mailroom-outbox", JSON.stringify([row("out-other", "someone@else.example"), row("out-mine", String(accounts[id].email).toLowerCase()), row("out-old")]));
    restoreOutbox();
    const got = rid => { const m = messages.find(x => x.id === rid); return m ? (m.sendError ? "held" : "queued") : "dropped"; };
    return [got("out-other"), got("out-mine"), got("out-old")];
  }), ["dropped", "queued", "held"], "another mailbox's mail is dropped; old rows wait for you");
});

test("a send that may have gone through is held, never resent on its own (#78)", { fake: true }, async ({ p, calls, clear }) => {
  const queue = (rid, extra) => p.evaluate((rid, extra) => {
    const id = Object.keys(accounts)[0];
    const rows = JSON.parse(localStorage.getItem("mailroom-outbox") || "[]");
    rows.push(Object.assign({ id: rid, account: id, accountEmail: String(accounts[id].email).toLowerCase(), subject: "Quote " + rid, bodyHtml: "<p>x</p>", to: "a@maplehill.example", sendAt: Date.now() - 1000 }, extra || {}));
    localStorage.setItem("mailroom-outbox", JSON.stringify(rows));
    restoreOutbox();
  }, rid, extra || {});
  const state = rid => p.evaluate(rid => { const m = messages.find(x => x.id === rid); return m ? { error: m.sendError, sending: !!m.sending, box: messageBox(m) } : null; }, rid);
  await clear();
  // 1. Mailroom closed while it was sending.
  await queue("out-quit", { sendStarted: Date.now() - 60000 });
  await p.evaluate(() => tickPendingSends()); await wait(300);
  expect(/may have been sent/.test((await state("out-quit")).error), "a mid-send quit is held as maybe sent", await state("out-quit"));
  same(await calls("send_mail"), [], "and not sent again on start");
  // 2. The server answers 503 to the send itself.
  await p.evaluate(() => { window.__sendError = "Microsoft did not answer, so the message may have been sent. Look in Sent Items before sending it again."; });
  await queue("out-503");
  await p.evaluate(() => tickPendingSends()); await wait(300);
  same((await calls("send_mail")).length, 1, "sent once");
  await p.evaluate(() => { const m = messages.find(x => x.id === "out-503"); m.sendAt = 0; tickPendingSends(); }); await wait(300);
  same((await calls("send_mail")).length, 1, "and never again on its own");
  // 3. A throttle (429) was refused outright, so it is tried again.
  await clear();
  await p.evaluate(() => { window.__sendError = "Microsoft is busy. The message is still in Outbox."; });
  await queue("out-429");
  await p.evaluate(() => tickPendingSends()); await wait(300);
  const busy = await state("out-429");
  same([busy.error, busy.box], ["", "outbox"], "a throttled send waits to go again");
  // 4. The held one reads as maybe sent, and Send again asks first.
  await p.evaluate(() => { window.__sendError = null; account = messages.find(x => x.id === "out-503").account; box = "outbox"; selected = "out-503"; render(); }); await wait(300);
  const hold = await p.$eval("#send-hold-text", e => e.textContent);
  expect(!hold.startsWith("Not sent") && /may have been sent/.test(hold), "it says it may have been sent", hold);
  await clear();
  await p.click("#retry-send"); await wait(300);
  expect(await p.$("#choose-layer"), "Send again asks first");
  await p.keyboard.press("Escape"); await wait(300);
  same(await calls("send_mail"), [], "cancelled, nothing is sent");
  // 5. While a send is out, the Outbox row records it.
  await p.evaluate(() => { window.__sendHang = true; });
  await queue("out-live");
  await p.evaluate(() => tickPendingSends()); await wait(300);
  const row = await p.evaluate(() => JSON.parse(localStorage.getItem("mailroom-outbox")).find(r => r.id === "out-live"));
  expect(row && row.sendStarted > 0, "the in-flight mark is saved before the call", row);
});

test("a forward whose original is gone still forwards by id, or says so and waits (#79)", { fake: true }, async ({ p, calls, clear }) => {
  await clear();
  // Forward m3 (with files), queue it, then the original leaves the loaded mail.
  const queued = await p.evaluate(() => {
    const m3 = messages.find(m => m.id === "m3");
    queueOutgoing({ to: "a@maplehill.example", subject: "FW: Site plans", bodyHtml: "<p>see below</p>", replyTo: "m3", replyMode: "forward", attachments: ["plan.pdf"], from: m3.account }, 60);
    messages.splice(messages.findIndex(m => m.id === "m3"), 1);
    const out = messages.find(m => m.pendingSend);
    out.sendAt = 0;
    return out && { id: out.id, server: out.replyServerId };
  });
  same(queued && queued.server, "m3", "the original's server id is kept with the queued forward");
  // The server says the original is gone: it waits, and says so.
  await p.evaluate(() => { window.__sendError = "The original has been moved or deleted, so its attachments could not be forwarded. The message is still in Outbox: Send again sends it without them, or Edit it to attach them yourself."; });
  await p.evaluate(() => tickPendingSends()); await wait(300);
  const first = (await calls("send_mail"))[0];
  same([first.replyTo, first.mode, first.keepFiles], ["m3", "forward", ["plan.pdf"]], "sent by id, so the server forwards it with its files");
  const held = await p.evaluate(id => messages.find(x => x.id === id).sendError, queued.id);
  expect(/^The original has been moved or deleted/.test(held), "held with the reason", held);
  await clear();
  // Send again sends it as a new message, without the original.
  await clear();
  await p.evaluate(id => { window.__sendError = null; retryPending(id); }, queued.id); await wait(300);
  await p.evaluate(() => tickPendingSends()); await wait(300);
  const again = (await calls("send_mail"))[0];
  same([again && again.replyTo, again && again.mode], [null, null], "Send again sends it without the original");
});

test("a draft's remote pictures are parked in the editor but sent as they were (#72)", { fake: true }, async ({ p, calls, clear }) => {
  const tracker = "https://tracker.example/p.gif";
  const hits = [];
  p.on("request", req => { if (req.url().startsWith("https://tracker.example/")) hits.push(req.url()); });
  await p.click('.row[data-id="m1"]'); await wait(400);
  await p.click("#reply"); await wait(400);
  await p.evaluate(src => {
    document.querySelector("#reading #compose-form").remove();
    replyDraft.bodyHtml = '<p>Thanks</p><blockquote><p>Quoted</p><img id="trk" src="' + src + '" width="1" height="1"><div style="background-image: url(' + src + ')">x</div></blockquote>';
    reading.dataset.paint = ""; render();
  }, tracker); await wait(600);
  const shown = await p.evaluate(() => { const img = document.querySelector("#compose-body img"); const div = document.querySelector("#compose-body div[data-mr-style]"); return { src: img && img.getAttribute("src"), parked: img && img.getAttribute("data-mr-src"), style: div && div.getAttribute("style") }; });
  same(shown.src, null, "the picture has no address while on screen");
  same(shown.parked, tracker, "it is parked on the element");
  expect(!/tracker/.test(shown.style || ""), "a background picture is parked too", shown.style);
  same(hits, [], "and nothing was fetched from the tracker");
  // Saved to the server and sent: exactly as it was.
  await clear();
  await p.evaluate(() => { const f = document.querySelector("#reading #compose-form"); f.querySelector("#compose-body").dispatchEvent(new Event("input", { bubbles: true })); });
  await wait(2500);
  const saved = (await calls("save_draft")).pop();
  expect(!!saved, "the draft was saved to the server");
  if (saved) expect(saved.bodyHtml.includes('src="' + tracker + '"') && !saved.bodyHtml.includes("data-mr-"), "the server draft keeps the address", saved.bodyHtml);
  const out = await p.evaluate(() => { const f = document.querySelector("#reading #compose-form"); return bodyForSend({ bodyHtml: sentBody(f) }); });
  expect(out.includes('src="' + tracker + '"') && out.includes("background-image") && !out.includes("data-mr-"), "the sent mail keeps every picture", out);
  // With remote pictures always allowed, the editor shows them.
  await p.evaluate(() => { localStorage.setItem("mailroom-remote-pictures", "always"); captureReplyDraft(); document.querySelector("#reading #compose-form").remove(); reading.dataset.paint = ""; render(); }); await wait(400);
  same(await p.$eval("#compose-body img", e => e.getAttribute("src")), tracker, "allowed, the picture loads in the editor");
});

test("parked-picture attributes in someone else's mail are cleaned, not restored", { fake: true }, async ({ p }) => {
  const got = await p.evaluate(() => {
    const hostile = '<div data-mr-parked="" data-mr-style="position:fixed;inset:0;z-index:99999">cover</div><img data-mr-parked="" data-mr-src="javascript:alert(1)">';
    const read = htmlFor(hostile);
    const holder = document.createElement("div");
    holder.innerHTML = editorHtml(hostile);
    const div = holder.querySelector("div");
    const img = holder.querySelector("img");
    return { read, style: div && (div.getAttribute("style") || ""), parkedStyle: div && div.getAttribute("data-mr-style"), src: img && img.getAttribute("src"), parkedSrc: img && img.getAttribute("data-mr-src") };
  });
  expect(!/data-mr-/.test(got.read), "the reading pane drops parked attributes", got.read);
  expect(!/fixed/.test(got.style) && !/fixed/.test(got.parkedStyle || ""), "a pinned overlay is cleaned before the editor shows it", got);
  expect(!/javascript/i.test(got.src || "") && !/javascript/i.test(got.parkedSrc || ""), "an unsafe address is cleaned too", got);
});

test("a thread shows the replies you sent, from Sent Items", { fake: true, setup: () => {
  const at = mins => new Date(Date.now() - mins * 60000).toISOString().replace(/\.\d+Z$/, "Z");
  window.__thread = [
    { id: "s1", thread: "conv-m1", parentFolderId: "f-sent", subject: "RE: Kiln schedule", fromName: "Jon", fromEmail: "jon@example.com", received: at(5), preview: "Tuesday works", bodyHtml: "<p>Tuesday works for me.</p>", unread: false, flagged: false, hasAttachments: false, files: [], to: [{ name: "Ada", email: "ada@example.org" }], cc: [], bcc: [] },
    { id: "x9", thread: "conv-m1", parentFolderId: "f-bin", subject: "RE: Kiln schedule", fromName: "Jon", fromEmail: "jon@example.com", received: at(4), preview: "binned", bodyHtml: "<p>binned</p>", unread: false, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [] }
  ];
} }, async ({ p, calls }) => {
  await p.click('.row[data-id="m1"]');
  await wait(1200);
  same(await calls("conversation_mail"), [{ email: "jon@example.com", conversationId: "conv-m1", conversation_id: "conv-m1" }], "asked for the whole conversation");
  const r = await p.evaluate(() => ({
    cards: document.querySelectorAll("#reading .thread-card").length,
    sent: [...document.querySelectorAll("#reading .from-folder")].map(el => el.textContent),
    text: document.querySelector("#reading").textContent
  }));
  same(r.cards, 2, "the inbox message and the sent reply");
  same(r.sent, ["Sent Items"], "the reply is marked as from Sent Items");
  expect(r.text.includes("Tuesday works for me."), "the newest message, the reply, is open");
  expect(!r.text.includes("binned"), "only Sent Items joins the thread");
});

test("the toolbar paperclip lists a thread's attachments", { fake: true }, async ({ p, calls }) => {
  await p.click('.row[data-id="m1"]'); await wait(600);
  same(await p.$("#thread-files"), null, "no paperclip without attachments");
  await p.click('.row[data-id="m3"]'); await wait(800);
  same(await p.$eval("#thread-files .files-count", el => el.textContent), "2", "the paperclip counts the files");
  await p.click("#thread-files"); await wait(300);
  const items = await p.$$eval('#row-menu[data-menu="files"] .file-item-name', els => els.map(el => el.textContent));
  same(items, ["plan.pdf", "old.xlsx"], "the menu lists each file");
  expect(await p.$('#row-menu [data-files-all="m3"]'), "Download all is offered");
  await p.evaluate(() => [...document.querySelectorAll("#row-menu .file-item")][0].click()); await wait(500);
  same((await calls("attachment_preview")).map(a => a.name), ["plan.pdf"], "the picked file opens in the viewer");
  await p.evaluate(() => closeViewer());
  expect(await p.$eval("#row-menu", el => el.hidden), "the menu closes after a pick");
});

test("quoted history folds for Outlook, Gmail and Apple replies", { fake: false }, async ({ p }) => {
  const cases = {
    outlook: [`<p>Thanks.</p><div style="border-top:solid 1pt"><p><b>From:</b> Ada<br><b>Sent:</b> Thu<br><b>To:</b> Jon<br><b>Subject:</b> Kiln</p></div><p>OLD</p>`, true],
    owa: [`<div>Fine.</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> A<br><b>Sent:</b> T<br><b>Subject:</b> K</div><div>OLD</div>`, true],
    gmail: [`<div>Yes.</div><div class="gmail_quote"><div class="gmail_attr">On Thu, Ada wrote:</div><blockquote>OLD</blockquote></div>`, true],
    apple: [`<div>Will do.</div><blockquote type="cite"><div>OLD</div></blockquote>`, true],
    forwardOnly: [`<p><b>From:</b> A<br><b>Sent:</b> T<br><b>Subject:</b> K</p><p>OLD</p>`, false],
    plain: [`<p>From: our side, the kiln is ready.</p><p>The subject is closed.</p>`, false]
  };
  for (const [name, [html, folds]] of Object.entries(cases)) {
    const r = await p.evaluate(h => { const d = document.createElement("div"); d.innerHTML = foldQuotedHtml(prefixMailClasses(sanitizeMailHtml(h, false)), "x"); const q = d.querySelector(".mail-quote"); return { folded: !!q, hidesOld: !!q && q.textContent.includes("OLD") }; }, html);
    same(r.folded, folds, name + " folding");
    if (folds) expect(r.hidesOld, name + " hides the old message");
  }
});

test("search leads with Top results: the flagged boiler quote beats newer mentions", { fake: true, setup: () => {
  const at = mins => new Date(Date.now() - mins * 60000).toISOString().replace(/\.\d+Z$/, "Z");
  const row = (id, from, email, subject, preview, mins, extra) => Object.assign({ id, thread: "conv-" + id, subject, fromName: from, fromEmail: email, received: at(mins), preview, bodyHtml: "<p>" + preview + "</p>", unread: false, flagged: false, hasAttachments: false, files: [], to: [{ name: "Jon", email: "jon@example.com" }], cc: [], bcc: [] }, extra || {});
  // Six newer messages only mention the word in passing.
  for (let i = 1; i <= 6; i++) window.__inbox.push(row("b" + i, "Neighbour " + i, "n" + i + "@example.org", "Street news " + i, "the boiler next door was loud", 60 * i));
  // Older, but the word is in the subject and it is flagged.
  window.__inbox.push(row("quote", "Warm Homes", "quotes@warmhomes.example", "Boiler service quote", "Your annual service", 60 * 24 * 3, { flagged: true }));
} }, async ({ p }) => {
  await wait(800);
  await p.click("#q"); await p.keyboard.type("boiler"); await p.keyboard.press("Enter"); await wait(800);
  const list = await p.evaluate(() => ({
    groups: [...document.querySelectorAll("#rows .date-group")].map(g => g.textContent.trim()),
    first: (document.querySelector("#rows .row") || {}).dataset?.id,
    quoteRows: document.querySelectorAll('#rows .row[data-id="quote"]').length
  }));
  same(list.groups[0], "Top results", "the first heading is Top results");
  same(list.first, "quote", "the flagged subject match leads");
  same(list.quoteRows, 1, "it is not repeated further down");
  await p.click("#q", { clickCount: 3 }); await p.keyboard.type("Kiln"); await p.keyboard.press("Enter"); await wait(800);
  const short = await p.$$eval("#rows .date-group", gs => gs.map(g => g.textContent.trim()));
  expect(!short.includes("Top results"), "a short result list stays in date order", short);
});

test("Print puts one message on white paper, from the toolbar or Ctrl+P", { fake: true }, async ({ p, calls, clear }) => {
  await p.click('.row[data-id="m1"]');
  await wait(800);
  expect(!!(await p.$("#reading #print")), "the reading toolbar has Print");
  await clear();
  await p.click("#reading #print");
  await wait(200);
  same((await calls("print_page")).length, 1, "the toolbar button asks the app to print");
  const sheet = await p.$eval("#print-sheet", s => s.textContent.replace(/\s+/g, " "));
  expect(sheet.includes("Kiln schedule") && sheet.includes("From") && sheet.includes("Ada Lovelace") && sheet.includes("Kiln schedule body"), "the sheet has the subject, sender and body", sheet);
  same(await p.$eval("#print-sheet", s => getComputedStyle(s).display), "none", "the sheet is hidden on screen");
  await p.emulateMediaType("print");
  const printed = await p.evaluate(() => ({ sheet: getComputedStyle(document.getElementById("print-sheet")).display, shell: getComputedStyle(document.querySelector(".shell")).display, top: getComputedStyle(document.querySelector("header.top")).display }));
  same(printed, { sheet: "block", shell: "none", top: "none" }, "on paper only the sheet shows");
  await p.emulateMediaType("screen");
  await clear();
  await p.click('.row[data-id="m2"]');
  await wait(600);
  await p.keyboard.down("Control"); await p.keyboard.press("p"); await p.keyboard.up("Control");
  await wait(200);
  same((await calls("print_page")).length, 1, "Ctrl+P prints too");
  expect((await p.$eval("#print-sheet", s => s.textContent)).includes("Pipeline review"), "Ctrl+P prints the open message");
});

test("a forward with a note keeps what it forwards open; a reply still folds", { fake: true, setup: () => {
  const body = '<div>FYI</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> Eternity<br><b>Sent:</b> Mon<br><b>Subject:</b> You are invited</div><div>THE INVITE</div>';
  const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  window.__inbox.push({ id: "fw", thread: "conv-fw", subject: "Fw:  You're Invited - Bowling", fromName: "Jordan", fromEmail: "j@timberworks.example", received: at, preview: "FYI", bodyHtml: body, unread: false, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
  window.__inbox.push({ id: "refw", thread: "conv-refw", subject: "RE: FW: Bowling", fromName: "Jordan", fromEmail: "j@timberworks.example", received: at, preview: "FYI", bodyHtml: body, unread: false, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
} }, async ({ p }) => {
  const shown = () => p.evaluate(() => { const L = document.querySelector("#reading .letter"); const q = L.querySelector(".mail-quote"); return { folded: !!q && q.hidden, text: L.innerText.includes("THE INVITE") }; });
  await p.click('.row[data-id="fw"]'); await wait(800);
  same(await shown(), { folded: false, text: true }, "the forwarded invite shows");
  await p.click('.row[data-id="refw"]'); await wait(800);
  same(await shown(), { folded: true, text: false }, "a reply to it folds the history");
});

test("mail with the app's class names keeps its own layout", { fake: true, setup: () => {
  // Like Slack's receipts: a table class="card" with text in divs.
  const body = `<style>.card {background:#f4f4f4}</style><table class="card" style="width:100%"><tr><td style="width:546px"><div style="max-width:600px"><div class="lg_margin_left_right" style="margin:0 50px"><h1>You're all set!</h1><p class="row avatar pill">Paid</p></div></div></td></tr></table>`;
  window.__inbox.push({ id: "card", thread: "conv-card", subject: "Renewed", fromName: "Slack", fromEmail: "f@slack.com", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Renewed", bodyHtml: body, unread: false, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
} }, async ({ p }) => {
  await p.click('.row[data-id="card"]'); await wait(1000);
  const r = await p.evaluate(() => {
    const h1 = document.querySelector("#reading h1");
    return { width: Math.round(h1.getBoundingClientRect().width), lines: Math.round(h1.getBoundingClientRect().height / parseFloat(getComputedStyle(h1).lineHeight || 30)), classes: document.querySelector("#reading table").className };
  });
  expect(r.width > 300, "heading keeps its width", r);
  same(r.classes, "m-card", "mail classes are renamed");
});

test("legal footers fold, ordinary text stays", { fake: false }, async ({ p }) => {
  const legal = "This email is confidential and may be legally privileged. If you have received this transmission in error, please notify us immediately and then delete or destroy any copies of this message. Thank you.";
  const r = await p.evaluate(l => [
    foldLegalHtml(sanitizeMailHtml(`<p>Hi.</p><p>${l}</p>`, false), "x").includes("legal-toggle"),
    foldLegalHtml(sanitizeMailHtml(`<p>Please keep the attached pricing confidential until Monday, when the board has signed it off and we can share it more widely.</p>`, false), "x").includes("legal-toggle")
  ], legal);
  same(r, [true, false], "legal folding");
});

// ---------------------------------------------------------------- compose

test("Enter picks a suggestion and never sends; bad addresses block Send", { fake: true }, async ({ p, calls, clear, toast }) => {
  await p.evaluate(() => { sendDelay = 0; });
  await p.click("#compose"); await wait(300);
  await p.click("#compose-to"); await p.keyboard.type("ad"); await wait(150);
  await p.keyboard.press("Enter"); await wait(150);
  same(await p.$eval("#compose-to", e => e.value), "Ada Lovelace <ada@example.org>; ", "Enter picked Ada");
  await p.keyboard.type("ma"); await wait(150); await p.keyboard.press("Escape");
  await clear();
  await p.click('#compose-form button[type="submit"]'); await wait(300);
  same((await calls("send_mail")).length, 0, "send with a half address");
  expect((await toast()).includes("not a complete email address"), "names the bad address", await toast());
});

test("recipient suggestions include the directory", { fake: true }, async ({ p, calls }) => {
  await p.click("#compose"); await wait(300);
  await p.click("#compose-to"); await p.keyboard.type("pri"); await wait(200);
  expect((await p.$$eval("#to-suggest button", b => b.map(x => x.dataset.email))).includes("priya@timberworks.example"), "people loaded at start are suggested");
  await p.keyboard.press("Escape");
  await p.$eval("#compose-to", e => { e.value = ""; });
  await p.keyboard.type("wag"); await wait(700);
  const hits = await p.$$eval("#to-suggest button", b => b.map(x => x.textContent));
  expect(hits.some(h => h.includes("Wagstaffe, Jane") && h.includes("Directory")), "directory search result shown", hits);
  await p.keyboard.press("Enter"); await wait(150);
  same(await p.$eval("#compose-to", e => parseAddresses(e.value)), ["jane.wagstaffe@timberworks.example"], "picked as one address");
});

test("names with commas stay one address", { fake: false }, async ({ p }) => {
  const r = await p.evaluate(() => [
    parseAddresses("Wagstaffe, Jane <jane@w.example>"),
    parseAddresses("Smith, Ann, Jr <ann@x.example>; ada@example.org"),
    parseAddresses("Wagstaffe")
  ]);
  same(r, [["jane@w.example"], ["ann@x.example", "ada@example.org"], ["Wagstaffe"]], "comma names");
});

test("typing below the signature lands in the message", { fake: false }, async ({ p }) => {
  await p.click("#compose"); await wait(300);
  const body = await p.$("#compose-body"); const b = await body.boundingBox();
  await p.mouse.click(b.x + b.width / 2, b.y + b.height - 20);
  await p.keyboard.type("Kept text");
  const sent = await p.evaluate(() => sentBody(document.getElementById("compose-form")));
  expect(sent.includes("Kept text"), "typed text is in what is sent");
  expect(/margin: 0/.test(sent), "lines carry their spacing");
});

test("a deleted signature comes back from the Signature button, inline, in a reply and popped out", { fake: false }, async ({ p }) => {
  const putBack = async (where) => {
    const sigText = () => p.evaluate(() => { const s = document.querySelector("#compose-body [data-sig]"); return s ? s.textContent.trim() : ""; });
    const had = await sigText();
    expect(had, where + ": starts with a signature");
    await p.evaluate(() => document.querySelector("#compose-body [data-sig]").remove());
    await p.click("#compose-form #compose-signature"); await wait(200);
    const items = await p.$$eval(".signature-menu:not([hidden]) [data-use-signature]", bs => bs.map(b => b.getAttribute("aria-checked")));
    expect(items.length >= 1 && items.every(c => c === "false"), where + ": menu lists the signature, none in place", items);
    await p.click(".signature-menu:not([hidden]) [data-use-signature]"); await wait(300);
    same(await sigText(), had, where + ": signature back");
    const sent = await p.evaluate(() => sentBody(document.getElementById("compose-form")));
    expect(sent.includes("body-sig") && !sent.includes("data-sig-id"), where + ": sent with it, without the editing id");
    await p.click("#compose-form #compose-signature"); await wait(200);
    same(await p.$eval(".signature-menu:not([hidden]) [data-use-signature]", b => b.getAttribute("aria-checked")), "true", where + ": ticked once in place");
    await p.click(".signature-menu:not([hidden]) [data-signature-remove]"); await wait(200);
    same(await sigText(), "", where + ": Remove signature takes it out");
  };
  await p.click("#compose"); await wait(300);
  await putBack("new message");
  await p.goto(p.url().split(/[?#]/)[0], { waitUntil: "load" }); await wait(1200);
  await p.evaluate(() => { const c = conversations()[0]; selected = c.latest.id; render(); document.querySelector("#reply").click(); });
  await wait(400);
  await p.evaluate(() => { const form = document.getElementById("compose-form"); form.dataset.kind = "new"; paintComposeSignature(form, true); });
  await putBack("reply");
  await p.goto(p.url().split(/[?#]/)[0] + "?compose=new", { waitUntil: "load" }); await wait(1500);
  await putBack("pop-out");
});

test("a web address becomes a link when Space or Enter follows it, typed or pasted", { fake: false }, async ({ p }) => {
  await p.click("#compose"); await wait(300);
  await p.click("#compose-body");
  const links = () => p.$$eval("#compose-body .body-write a", as => as.map(a => [a.getAttribute("href"), a.textContent]));
  const text = () => p.$eval("#compose-body .body-write", w => w.textContent.replace(/\u00a0/g, " "));
  await p.keyboard.type("See https://example.com/a?b=1 ");
  same(await links(), [["https://example.com/a?b=1", "https://example.com/a?b=1"]], "typed, then Space");
  await p.keyboard.type("next");
  expect((await text()).endsWith("https://example.com/a?b=1 next"), "typing after it stays outside the link", await text());
  same((await links()).length, 1, "the next word is not linked");
  await p.keyboard.type(" and https://example.org/x. ");
  same((await links())[1], ["https://example.org/x", "https://example.org/x"], "a full stop after it is left out");
  expect((await text()).endsWith("https://example.org/x. "), "and stays in the text", await text());
  await p.evaluate(() => document.execCommand("insertText", false, "https://pasted.example/doc"));
  await p.keyboard.press("Enter");
  same((await links())[2], ["https://pasted.example/doc", "https://pasted.example/doc"], "pasted, then Enter");
  await p.keyboard.type("www.example.net ");
  same((await links())[3], ["https://www.example.net/", "www.example.net"], "www. gets https://");
  await p.keyboard.type("javascript:alert(1) ftp://x.example ");
  same((await links()).length, 4, "nothing else is linked");
  await p.keyboard.type("https://undo.example ");
  same((await links()).length, 5, "linked");
  await p.keyboard.down("Control"); await p.keyboard.press("z"); await p.keyboard.up("Control"); await wait(100);
  await p.keyboard.down("Control"); await p.keyboard.press("z"); await p.keyboard.up("Control"); await wait(100);
  same((await links()).length, 4, "Ctrl+Z takes the link back off");
});

test("reply all: To and Cc as Outlook, quote in Outlook form", { fake: false }, async ({ p }) => {
  const r = await p.evaluate(async () => {
    const c = conversations().find(c => c.messages.length > 1);
    selected = c.latest.id; render();
    document.querySelector("#reply-all").click();
    await new Promise(r => setTimeout(r, 200));
    const form = document.getElementById("compose-form");
    return {
      to: parseAddresses(form.querySelector("#compose-to").value).length,
      cc: parseAddresses(form.querySelector("#compose-cc").value).length,
      chips: document.querySelectorAll(".recip-chip").length,
      historyShown: !document.getElementById("message-history").hidden,
      quote: /divRplyFwdMsg[\s\S]*<b>From:<\/b>[\s\S]*<b>Subject:<\/b>/.test(sentBody(form))
    };
  });
  same(r.to, 1, "To has the sender");
  same(r.cc, 2, "Cc keeps the original Cc");
  expect(r.chips >= 3, "recipients shown as chips", r.chips);
  expect(r.historyShown, "message being answered is shown");
  expect(r.quote, "quote uses From:/Sent:/Subject:");
});

test("inline reply: clicking the names opens To and Cc for editing", { fake: false }, async ({ p }) => {
  await p.evaluate(() => {
    const c = conversations().find(c => c.messages.length > 1);
    selected = c.latest.id; render();
    document.querySelector("#reply-all").click();
  });
  await wait(200);
  const shown = (sel) => { const el = document.querySelector(sel); return !!el && el.getClientRects().length > 0; };
  const before = await p.evaluate((f) => eval(f)("#compose-to"), shown.toString());
  expect(!before, "To starts as names");
  await p.click(".compose-who [data-edit-recipients]");
  await wait(100);
  const r = await p.evaluate((f) => {
    const vis = eval(f);
    return { to: vis("#compose-to"), cc: vis("#compose-cc"), focused: document.activeElement && document.activeElement.id, names: vis(".compose-who .who-line-row") };
  }, shown.toString());
  expect(r.to, "To field shows");
  expect(r.cc, "Cc field shows, since reply all has Cc");
  same(r.focused, "compose-to", "To has the caret");
  expect(!r.names, "names give way to the fields");
  await p.focus("#compose-to");
  await p.keyboard.down("Control"); await p.keyboard.press("KeyA"); await p.keyboard.up("Control");
  await p.keyboard.type("someone@else.example");
  const to = await p.evaluate(() => parseAddresses(document.getElementById("compose-to").value));
  same(to, ["someone@else.example"], "recipient can be changed inline");
});

test("recipients are chips that drag between To, Cc and Bcc", { fake: false }, async ({ p }) => {
  await p.click("#compose"); await wait(300);
  await p.click("#compose-to");
  await p.keyboard.type("ann@one.example; bob@two.example, carl@thr");
  const chips = sel => p.$$eval(sel + " .recip-token", els => els.map(e => e.dataset.email));
  same(await chips("#to-field"), ["ann@one.example", "bob@two.example"], "finished addresses become chips");
  same(await p.$eval("#compose-to", e => HTMLInputElement.prototype.__lookupGetter__("value").call(e)), "carl@thr", "the unfinished one stays as text");
  await p.keyboard.type("ee.example");
  await p.click("#compose-subject"); await wait(300);
  same(await chips("#to-field"), ["ann@one.example", "bob@two.example", "carl@three.example"], "leaving the field finishes the last one");
  same(await p.$eval("#compose-to", e => parseAddresses(e.value)), ["ann@one.example", "bob@two.example", "carl@three.example"], "value is still the whole list");
  expect(await p.$eval("#cc-field", e => e.hidden), "Cc starts closed");

  const drag = async (from, to, dx = 0) => {
    const a = await (await p.$(from)).boundingBox();
    await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await p.mouse.down();
    await p.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 3 });
    await wait(50);
    const b = await (await p.$(to)).boundingBox();
    await p.mouse.move(b.x + (dx >= 0 ? b.width - 4 + dx : 2), b.y + b.height / 2, { steps: 5 });
    await p.mouse.up(); await wait(100);
  };
  // While a chip moves, Cc and Bcc open to take it.
  const a = await (await p.$('#to-field .recip-token[data-email="bob@two.example"]')).boundingBox();
  await p.mouse.move(a.x + 10, a.y + a.height / 2); await p.mouse.down();
  await p.mouse.move(a.x + 30, a.y + 20, { steps: 3 }); await wait(50);
  expect(await p.$eval("#cc-field", e => !e.hidden) && await p.$eval("#bcc-field", e => !e.hidden), "Cc and Bcc open while dragging");
  const c = await (await p.$("#compose-cc")).boundingBox();
  await p.mouse.move(c.x + c.width / 2, c.y + c.height / 2, { steps: 5 });
  expect(await p.$eval("#cc-field .recip-box", e => e.classList.contains("drop-into")), "Cc shows it will take the chip");
  await p.mouse.up(); await wait(100);
  same(await chips("#to-field"), ["ann@one.example", "carl@three.example"], "bob left To");
  same(await chips("#cc-field"), ["bob@two.example"], "bob is on Cc");
  expect(await p.$eval("#bcc-field", e => e.hidden), "the empty Bcc closes again");
  expect(await p.$eval("#show-bcc", e => !e.hidden) && await p.$eval("#show-cc", e => e.hidden), "Cc/Bcc buttons follow");

  // Onto a chip: before it when dropped on its left half.
  await drag('#to-field .recip-token[data-email="carl@three.example"]', '#to-field .recip-token[data-email="ann@one.example"]', -1);
  same(await chips("#to-field"), ["carl@three.example", "ann@one.example"], "reordered within To");
  await drag('#cc-field .recip-token', '#to-field .recip-token[data-email="carl@three.example"]');
  same(await chips("#to-field"), ["carl@three.example", "bob@two.example", "ann@one.example"], "back to To, after carl");
  expect(await p.$eval("#cc-field", e => !e.hidden), "Cc that was open before stays open");

  // A click that doesn't move is not a drag; ✕ removes; Backspace takes the last chip back.
  await p.click('#to-field .recip-token[data-email="ann@one.example"] .recip-token-x');
  same(await chips("#to-field"), ["carl@three.example", "bob@two.example"], "✕ removes the chip");
  await p.click("#compose-to"); await p.keyboard.press("Backspace");
  same(await chips("#to-field"), ["carl@three.example"], "Backspace takes the last chip off");
  same(await p.$eval("#compose-to", e => e.value), "carl@three.example; bob@two.example", "… back into the text to change");
  await p.keyboard.down("Control"); await p.keyboard.press("KeyA"); await p.keyboard.up("Control");
  await p.keyboard.type("dee@four.example");
  same(await p.$eval("#compose-to", e => parseAddresses(e.value)), ["dee@four.example"], "Ctrl+A and typing replaces every recipient");
});


test("a narrow window folds the folders away and brings them back", { fake: false }, async ({ p }) => {
  const state = () => p.evaluate(() => document.body.dataset.folders);
  const vp = p.viewport();
  try {
    await p.setViewport({ width: 1400, height: 800 }); await wait(150);
    same(await state(), "open", "wide: folders open");
    await p.setViewport({ width: 900, height: 800 }); await wait(150);
    same(await state(), "closed", "narrow: folders fold away");
    await p.click("#show-mail-folders"); await wait(50);
    same(await state(), "open", "the burger still opens them while narrow");
    await p.setViewport({ width: 1400, height: 800 }); await wait(150);
    same(await state(), "open", "wide again: open");
    await p.click("#hide-folders"); await wait(50);
    same(await state(), "closed", "burger closes them");
    await p.setViewport({ width: 900, height: 800 }); await wait(150);
    await p.setViewport({ width: 1400, height: 800 }); await wait(150);
    same(await state(), "closed", "your own choice comes back, not open");
    await p.click("#show-mail-folders"); await wait(50);
  } finally {
    if (vp) await p.setViewport(vp);
  }
});

test("narrow and reading a message: the close button, Mail or Escape go back to the list", { fake: false }, async ({ p }) => {
  const vp = p.viewport();
  const shown = sel => p.evaluate(s => { const el = document.querySelector(s); return !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0; }, sel);
  try {
    await p.setViewport({ width: 1400, height: 800 }); await wait(150);
    await p.click(".list .row"); await wait(300);
    same(await shown("#close-message"), false, "wide: no close button, the list is beside the message");

    await p.setViewport({ width: 900, height: 800 }); await wait(150);
    same([await shown(".shell > .list"), await shown(".reading"), await shown("#close-message")], [false, true, true], "one pane: the message, with a close button");
    await p.hover("#rail-mail"); await wait(200);
    same(await shown(".shell > .list"), false, "hovering Mail pops nothing out");
    const box = await p.evaluate(() => { const b = document.getElementById("close-message").getBoundingClientRect(); const h = document.querySelector(".read-subject h2").getBoundingClientRect(); return [b.left < h.left + 40, b.top < h.bottom]; });
    same(box, [true, true], "the close button sits before the subject");
    await p.click("#close-message"); await wait(200);
    same([await shown(".shell > .list"), await p.evaluate(() => document.body.dataset.open)], [true, "0"], "the close button goes back to the list");

    await p.click(".list .row"); await wait(300);
    await p.click("#rail-mail"); await wait(200);
    same(await shown(".shell > .list"), true, "clicking Mail goes back too");

    await p.click(".list .row"); await wait(300);
    await p.keyboard.press("Escape"); await wait(200);
    same(await shown(".shell > .list"), true, "and Escape");

    // Settings while a message is open: settings fill the window, no message beside them.
    await p.click(".list .row"); await wait(300);
    await p.click("#rail-settings"); await wait(300);
    same([await shown(".reading"), await shown(".settings")], [false, true], "narrow Settings: the settings, not the open message");
    await p.click("#rail-mail"); await wait(300);
  } finally {
    if (vp) await p.setViewport(vp);
  }
});

test("a small window folds a crowded all-day row to two a day, with more and less", { fake: true, tz: true }, async ({ p }) => {
  const vp = p.viewport();
  const row = () => p.evaluate(() => {
    const cells = [...document.querySelectorAll(".allday-cell")];
    const busy = cells.find(c => c.dataset.day === String(window.__busyDay));
    return {
      chips: busy ? busy.querySelectorAll("[data-event]").length : -1,
      more: busy && busy.querySelector(".allday-more") ? busy.querySelector(".allday-more").textContent : "",
      toggle: !!document.querySelector(".allday-toggle"),
      height: Math.round(document.querySelector(".allday").getBoundingClientRect().height)
    };
  });
  try {
    await p.setViewport({ width: 900, height: 800 }); await wait(200);
    await p.evaluate(() => {
      localStorage.removeItem("mailroom-allday-open"); allDayOpen = false;
      calFocus = new Date(); setView("calendar"); calView = "week"; render();
      const first = Math.min(...[...document.querySelectorAll(".allday-cell")].map(c => +c.dataset.day));
      window.__busyDay = first + 2;
      for (let i = 0; i < 6; i++) allday.push({ id: "busy-" + i, account: "timberworks", calendar: "cal-timberworks-site", day: first + 2, title: "All day " + i, showAs: "free" });
      render();
    }); await wait(400);
    same(await row().then(r => [r.chips, r.more, r.toggle]), [2, "+4 more", true], "small window: two a day, and +4 more");
    await p.click(".allday-more"); await wait(200);
    same(await row().then(r => [r.chips, r.more]), [6, ""], "+4 more shows them all");
    await p.click(".allday-toggle"); await wait(200);
    same(await row().then(r => r.chips), 2, "the toggle shows fewer again");
    same(await p.evaluate(() => localStorage.getItem("mailroom-allday-open")), "0", "and is remembered");
    const before = await p.evaluate(() => document.querySelectorAll(".event-form, .event-editor, .dialog").length);
    same(before, 0, "clicking more or less never opened a new event");

    await p.setViewport({ width: 1400, height: 2400 }); await wait(500);
    same(await row().then(r => [r.chips, r.toggle]), [6, false], "with room for them, every all-day event shows");
  } finally {
    await p.evaluate(() => { allday.splice(0, allday.length, ...allday.filter(e => !String(e.id).startsWith("busy-"))); localStorage.removeItem("mailroom-allday-open"); allDayOpen = false; });
    if (vp) await p.setViewport(vp);
  }
});

test("Settings fold their menu in a small window, like Mail and Calendar", { fake: false }, async ({ p }) => {
  const vp = p.viewport();
  const state = () => p.evaluate(() => ({
    folders: document.body.dataset.folders,
    nav: (() => { const n = document.getElementById("folder-nav"); return !!n && getComputedStyle(n).display !== "none" && n.getBoundingClientRect().width > 0; })(),
    burger: (() => { const b = document.getElementById("show-settings-folders"); return !!b && getComputedStyle(b).display !== "none"; })()
  }));
  try {
    await p.setViewport({ width: 900, height: 800 }); await wait(150);
    await p.click("#rail-settings"); await wait(300);
    same(await state(), { folders: "closed", nav: false, burger: true }, "small: the settings menu folds away, with a menu button in the header");
    const width = await p.evaluate(() => Math.round(document.querySelector(".settings").getBoundingClientRect().width));
    expect(width > 800, "the settings page gets the room", width);
    await p.click("#show-settings-folders"); await wait(150);
    same(await state().then(s => [s.folders, s.nav]), ["open", true], "the menu button brings the menu back");
    await p.setViewport({ width: 1400, height: 800 }); await wait(150);
    same(await state().then(s => [s.folders, s.burger]), ["open", false], "wide: the menu is open and the button gone");
    await p.click("#rail-mail"); await wait(200);
  } finally {
    if (vp) await p.setViewport(vp);
  }
});

test("right-click on a picture or link in a message: Mailroom's own menu, and Save works", { fake: true, setup: () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  window.__inbox.push({ id: "pic", thread: "conv-pic", subject: "Laser marking demo", fromName: "Rep", fromEmail: "rep@vendor.example", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Demo", bodyHtml: `<p>See the sample:</p><img id="sample" alt="marking sample" src="${png}" width="40" height="40"><p><a id="lnk" href="https://vendor.example/demo">Book a demo</a></p>`, unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
} }, async ({ p, calls }) => {
  await p.click('.row[data-id="pic"]'); await wait(900);
  const menu = () => p.evaluate(() => { const m = document.getElementById("row-menu"); return m && !m.hidden && getComputedStyle(m).display !== "none" ? [...m.querySelectorAll("button")].map(b => b.textContent) : []; });
  const prevented = await p.evaluate(() => {
    const img = document.querySelector("#reading img[alt='marking sample']");
    const r = img.getBoundingClientRect();
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 5, clientY: r.top + 5 });
    img.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  same(prevented, true, "the web view's own menu is replaced");
  same(await menu(), ["Save picture…", "Copy picture"], "a picture: Save and Copy");
  await p.evaluate(() => [...document.querySelectorAll("#row-menu button")].find(b => b.textContent === "Save picture…").click()); await wait(300);
  const saved = await calls("save_picture");
  same(saved.length, 1, "Save picked a folder and saved");
  same([saved[0].directory, saved[0].name], ["/home/jon/Downloads", "marking sample"], "into the picked folder, named from the picture");
  expect(saved[0].data.startsWith("iVBORw0KGgo"), "the picture's own bytes went to the app", saved[0].data.slice(0, 12));
  same(await p.evaluate(() => (document.querySelector(".toast") || {}).textContent || ""), "Saved marking sample.png.", "and says where");

  await p.evaluate(() => { const img = document.querySelector("#reading img[alt='marking sample']"); const r = img.getBoundingClientRect(); img.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 5, clientY: r.top + 5 })); });
  await p.evaluate(() => [...document.querySelectorAll("#row-menu button")].find(b => b.textContent === "Copy picture").click()); await wait(200);
  same((await calls("copy_picture")).length, 1, "Copy picture hands the bytes to the app");

  await p.evaluate(() => { const a = document.querySelector("#reading a[href='https://vendor.example/demo']"); const r = a.getBoundingClientRect(); a.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 2, clientY: r.top + 2 })); });
  same(await menu(), ["Open link", "Copy link address"], "a link: Open and Copy address");
  await p.evaluate(() => [...document.querySelectorAll("#row-menu button")].find(b => b.textContent === "Open link").click()); await wait(200);
  same((await calls("open_link")).map(a => a.url), ["https://vendor.example/demo"], "Open link goes through the app's link check");

  await p.evaluate(() => { window.__pickFolder = null; });
  await p.evaluate(() => { const img = document.querySelector("#reading img[alt='marking sample']"); const r = img.getBoundingClientRect(); img.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: r.left + 5, clientY: r.top + 5 })); });
  await p.evaluate(() => [...document.querySelectorAll("#row-menu button")].find(b => b.textContent === "Save picture…").click()); await wait(300);
  same((await calls("save_picture")).length, 1, "cancelling the folder picker saves nothing");
  await p.evaluate(() => { delete window.__pickFolder; });
});

test("right-click on a word selects it, so Learn Spelling is available", { fake: false }, async ({ p }) => {
  await p.click("#compose"); await wait(300);
  const r = await p.evaluate(() => {
    const body = document.getElementById("compose-body");
    body.innerHTML = "<p>Hello Omarchyy world</p>";
    const text = body.querySelector("p").firstChild;
    const at = (offset) => { const r = document.createRange(); r.setStart(text, offset); r.setEnd(text, offset + 1); return r.getBoundingClientRect(); };
    const box = at(9);
    const sel = window.getSelection();
    sel.removeAllRanges(); const caret = document.createRange(); caret.setStart(text, 0); sel.addRange(caret);
    body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }));
    const picked = String(window.getSelection());
    const subject = document.getElementById("compose-subject");
    subject.value = "Quarterly reprot draft"; subject.setSelectionRange(0, 0);
    const sb = subject.getBoundingClientRect();
    const fake = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: sb.left + 4, clientY: sb.top + sb.height / 2 });
    subject.dispatchEvent(fake);
    return { picked, subject: subject.value.slice(subject.selectionStart, subject.selectionEnd) };
  });
  same(r.picked, "Omarchyy", "the word under the pointer is selected");
  expect(r.subject.length > 0 && !/\s/.test(r.subject), "a word in a plain field is selected too", r.subject);
});

test("undo send: the reply and the message it answers stay on screen in Drafts", { fake: false }, async ({ p }) => {
  await p.evaluate(() => { sendDelay = 30; });
  await p.evaluate(() => {
    const c = conversations().find(c => c.messages.length > 1);
    selected = c.latest.id;
    render();
  });
  await wait(200);
  await p.click("#reply-all");
  await wait(200);
  await p.click("#compose-body");
  await p.keyboard.type("Thanks everyone");
  await p.click('#compose-form button[type="submit"]');
  await wait(300);
  await p.click("#toast-undo");
  await wait(300);
  const place = await p.evaluate(() => {
    const canvas = document.querySelector("#reading .compose-canvas");
    const hist = document.getElementById("message-history");
    const body = document.getElementById("compose-body");
    const cr = canvas.getBoundingClientRect();
    const hr = hist.getBoundingClientRect();
    const br = body.getBoundingClientRect();
    return {
      box,
      kind: document.getElementById("compose-form").dataset.kind,
      wrote: body.innerText.includes("Thanks everyone"),
      historyHidden: hist.hidden,
      quote: hist.innerText.includes("pipeline review"),
      bodyInView: br.top >= cr.top - 1 && br.top < cr.bottom,
      historyInView: hr.top >= cr.top - 1 && hr.top < cr.bottom - 8
    };
  });
  same(place.box, "drafts", "undo opens the message in Drafts");
  same(place.kind, "reply", "it is still a reply");
  expect(place.wrote, "the words you typed are in the draft");
  expect(!place.historyHidden && place.quote, "the message being answered is in the draft", place);
  expect(place.bodyInView && place.historyInView, "both sit in the pane, without popping out", place);
});

test("reply with invite opens the new event form", { fake: false }, async ({ p, toast }) => {
  const days = await p.evaluate(() => ({
    named: isoFromDay(dayFromText("Thursday 15 October, 10:00–11:00")),
    november: isoFromDay(dayFromText("Thursday 5 November")),
    weekday: isoFromDay(dayFromText("Thursday")),
    next: isoFromDay(dayFromText("next Thursday")),
    old: isoFromDay(dayFromText("2 January")),
    wednesday: isoFromDay(dayFromText("Wednesday morning"))
  }));
  same(days, {
    named: "2026-10-15",
    november: "2026-11-05",
    weekday: "2026-10-15",
    next: "2026-10-22",
    old: "2027-01-02",
    wednesday: "2026-10-14"
  }, "a written date wins, and a weekday is this week");

  const draftsBefore = await p.evaluate(() => messages.filter(m => m.draft).length);
  await p.evaluate(() => { selected = "meet"; render(); });
  await wait(300);
  await p.click("#reply-invite");
  await wait(200);
  const form = await p.evaluate(() => {
    const f = document.getElementById("event-form");
    if (!f) return null;
    return {
      label: f.getAttribute("aria-label"),
      invite: !!document.getElementById("compose-invite"),
      compose: !!document.getElementById("compose-form"),
      title: f.querySelector("[name=title]").value,
      date: f.querySelector("[name=date]").value,
      start: f.querySelector("[name=start]").value,
      end: f.querySelector("[name=end]").value,
      where: f.querySelector("[name=where]").value,
      calendar: f.querySelector("[name=calendar]").value,
      people: [...f.querySelectorAll("#event-people .attendee")].map(el => el.textContent),
      notes: f.querySelector("[name=notes]").value,
      drafts: messages.filter(m => m.draft).length
    };
  });
  expect(form, "the new event form is open");
  same(form.label, "New event", "it is a new event");
  same(form.invite, false, "no invite card on a reply");
  same(form.compose, false, "no mail reply");
  same(form.title, "Pipeline review", "title from the thread");
  same(form.date, "2026-10-15", "Thursday 15 October");
  same([form.start, form.end], ["10:00", "11:00"], "the time named in the thread");
  same(form.where, "Studio · Teams", "the place named in the thread");
  same(form.calendar, "cal-timberworks", "the message's calendar");
  expect(form.people.some(t => t.includes("Maya Chen")) && form.people.some(t => t.includes("Owen Price")) && form.people.some(t => t.includes("Leah Okonkwo")), "attendees from the thread", form.people);
  expect(!form.people.some(t => /jon@/i.test(t)), "you are not an attendee", form.people);
  expect(form.notes.includes("Thursday's pipeline review") && form.notes.includes("moved pipeline review to 10:00"), "the thread is in the notes", form.notes);
  expect(form.notes.indexOf("Thursday's pipeline review") < form.notes.indexOf("moved pipeline review to 10:00"), "older mail comes first");
  same(form.drafts, draftsBefore, "no mail draft is started");

  const before = await p.evaluate(() => events.length);
  await p.click('#event-form button[type="submit"]');
  await wait(300);
  const saved = await p.evaluate(() => {
    const ev = events.find(e => e.title === "Pipeline review" && String(e.notes || "").includes("moved pipeline review to 10:00"));
    return ev && {
      day: ev.day,
      start: ev.start,
      end: ev.end,
      where: ev.where,
      calendar: ev.calendar,
      account: ev.account,
      people: (ev.attendees || []).map(a => a.name),
      view: document.body.dataset.view,
      form: !!document.getElementById("event-form")
    };
  });
  expect(saved, "saving uses the new event");
  same(saved.view, "calendar", "the calendar opens");
  same(saved.form, false, "the form closes");
  same([saved.day, saved.start, saved.end, saved.where, saved.calendar, saved.account], [3, 600, 660, "Studio · Teams", "cal-timberworks", "timberworks"], "the suggested slot is what gets saved");
  same(saved.people, ["Maya Chen", "Owen Price", "Leah Okonkwo"], "the attendees are saved");
  same(await p.evaluate(() => events.length), before + 1, "one event is added");
  expect((await toast()).includes("Event added"), "the usual confirmation", await toast());

  await p.evaluate(() => { setView("mail"); selected = "kiln"; render(); });
  await wait(300);
  await p.click("#reply-invite");
  await wait(200);
  const kiln = await p.evaluate(() => {
    const f = document.getElementById("event-form");
    return {
      title: f.querySelector("[name=title]").value,
      date: f.querySelector("[name=date]").value,
      start: f.querySelector("[name=start]").value,
      end: f.querySelector("[name=end]").value,
      where: f.querySelector("[name=where]").value,
      calendar: f.querySelector("[name=calendar]").value,
      people: [...f.querySelectorAll("#event-people .attendee")].map(el => el.textContent),
      notes: f.querySelector("[name=notes]").value,
      compose: !!document.getElementById("compose-form")
    };
  });
  same(kiln.title, "Kiln schedule", "title from the subject");
  same(kiln.date, "2026-10-14", "Wednesday of this week");
  same([kiln.start, kiln.end], ["09:00", "09:45"], "morning, at the default meeting length");
  same(kiln.where, "Side gate", "the place named in the thread");
  same(kiln.calendar, "cal-timberworks", "the message's calendar");
  same(kiln.compose, false, "still not a mail reply");
  expect(kiln.people.filter(t => t.includes("Owen Price")).length === 1 && kiln.people.some(t => t.includes("Leah Okonkwo")), "each person once", kiln.people);
  expect(kiln.notes.includes("side gate") && kiln.notes.includes("Wednesday morning"), "the thread is in the notes", kiln.notes);
});

test("replies and forwards go through Microsoft's draft; drafts autosave", { fake: true }, async ({ p, calls, clear }) => {
  await p.evaluate(() => { sendDelay = 0; });
  await p.click('.row[data-id="m1"]'); await wait(300);
  await p.click("#reply"); await wait(300);
  await clear();
  await p.click("#compose-body"); await p.keyboard.type("Thanks");
  await wait(3200);
  const saves = await calls("save_draft");
  same(saves.map(a => [a.mode, a.replyTo]), [["reply", "m1"]], "autosave as a reply");
  await clear();
  await p.click('#compose-form button[type="submit"]'); await wait(600);
  same((await calls("send_mail")).map(a => [a.draftId, a.mode, a.replyTo]), [["srv-draft-1", "reply", "m1"]], "sent as the saved draft");
  await p.click('.row[data-id="m3"]'); await wait(300);
  await p.click("#forward"); await wait(300);
  await p.click("#compose-to"); await p.keyboard.type("eve@example.org");
  await p.click('#compose-files .file[data-name="old.xlsx"] [data-drop-file]');
  await clear();
  await p.click('#compose-form button[type="submit"]'); await wait(600);
  same((await calls("send_mail")).map(a => [a.mode, a.keepFiles]), [["forward", ["plan.pdf"]]], "forward keeps only kept files");
});

test("a draft is saved while typing and when the window closes", { fake: true }, async ({ p, calls, clear }) => {
  await p.click('.row[data-id="m1"]'); await wait(300);
  await p.click("#reply"); await wait(300);
  await p.evaluate(() => { window.__draftPauseMs = 1200; window.__draftKeepMs = 20000; });
  await clear();
  await p.click("#compose-body"); await p.keyboard.type("Hi");
  await wait(400);
  same((await calls("save_draft")).length, 0, "inside the pause");
  await wait(1100);
  let saves = await calls("save_draft");
  same(saves.length, 1, "saved after the pause");
  expect(String(saves[0].bodyHtml).includes("Hi"), "pause save has the body", saves[0].bodyHtml);
  await clear();
  await p.evaluate(() => { window.__draftPauseMs = 30000; window.__draftKeepMs = 700; });
  await p.keyboard.type(" more");
  await wait(250);
  await p.keyboard.type(" words");
  await wait(700);
  saves = await calls("save_draft");
  expect(saves.length >= 1, "saved while still typing", saves.length);
  expect(saves.some(a => String(a.bodyHtml).includes("more") && String(a.bodyHtml).includes("words")), "kept text is in the draft", saves.map(a => a.bodyHtml));
  await clear();
  await p.keyboard.type(" tail");
  await p.evaluate(() => window.flushOpenDrafts());
  saves = await calls("save_draft");
  same(saves.length, 1, "closing writes the draft");
  expect(String(saves[0].bodyHtml).includes("tail"), "the last words are in the draft", saves[0].bodyHtml);
});

test("attachments are staged and sent; Send waits for them", { fake: true }, async ({ p, calls, clear }) => {
  await p.evaluate(() => { sendDelay = 0; });
  await p.click("#compose"); await wait(300);
  await p.click("#compose-to"); await p.keyboard.type("eve@example.org");
  await (await p.$("#compose-file-picker")).uploadFile(path.join(FILES, "quote.txt"), path.join(FILES, "photo.jpg"));
  await wait(300);
  await p.click('[data-pic-choice="attach"]');
  await wait(600);
  await clear();
  await p.click('#compose-form button[type="submit"]'); await wait(600);
  same((await calls("send_mail")).map(a => a.files.map(f => f.name)), [["quote.txt", "photo.jpg"]], "files sent by id");
});

test("pictures go in the message or attach, at Small, Medium, Large or Original", { fake: true }, async ({ p, calls, clear }) => {
  await p.evaluate(() => { sendDelay = 0; });
  await p.click("#compose"); await wait(300);
  await p.click("#compose-to"); await p.keyboard.type("eve@example.org");
  await p.click("#compose-body"); await p.keyboard.type("Before ");
  const picker = await p.$("#compose-file-picker");
  await picker.uploadFile(path.join(FILES, "wide.png")); await wait(300);
  expect(await p.$(".pic-choice"), "asked inline or attached");
  await p.click('[data-pic-choice="inline"]'); await wait(800);
  const pic = () => p.evaluate(() => { const img = document.querySelector("#compose-body img"); return img && { width: img.getAttribute("width"), natural: img.naturalWidth, data: img.src.startsWith("data:image/png"), size: img.dataset.size }; });
  same(await pic(), { width: "480", natural: 960, data: true, size: "medium" }, "inline at Medium");
  expect(await p.evaluate(() => document.querySelector("#compose-body").textContent.includes("Before")), "typed text kept");
  await p.click("#compose-body img"); await wait(200);
  await p.click('.pic-size-float [data-pic-size="small"]'); await wait(600);
  same(await pic(), { width: "240", natural: 480, data: true, size: "small" }, "Small");
  await p.click('.pic-size-float [data-pic-size="original"]'); await wait(600);
  same(await pic(), { width: null, natural: 2400, data: true, size: "original" }, "Original");
  await p.click('.pic-size-float [data-pic-size="large"]'); await wait(600);
  same((await pic()).width, "800", "Large");
  // The same picture as an attachment, sent at Small.
  await picker.uploadFile(path.join(FILES, "wide.png")); await wait(300);
  await p.click('[data-pic-choice="attach"]'); await wait(600);
  const before = await p.evaluate(() => window.__staged || 0);
  await p.select('#compose-files [data-name="wide.png"] select', "small"); await wait(800);
  expect(await p.evaluate(() => window.__staged || 0) === before + 1, "restaged at the new size");
  await clear();
  await p.click('#compose-form button[type="submit"]'); await wait(800);
  const sent = await calls("send_mail");
  same(sent.map(a => a.files.map(f => f.name)), [["wide.png"]], "attached once");
  same(sent[0].files[0].id, String(before + 1).padStart(32, "0"), "the Small copy is sent");
  const html = JSON.stringify(sent[0]);
  expect(html.includes("data:image/png"), "the inline picture goes with the message");
  expect(!html.includes("data-picture-id") && !html.includes("pic-size"), "no editing bits are sent");
});

test("a pasted picture goes in at Large, and every size can be picked after it", { fake: true }, async ({ p }) => {
  await p.click("#compose"); await wait(300);
  await p.click("#compose-body"); await p.keyboard.type("Look ");
  const png = fs.readFileSync(path.join(FILES, "wide.png")).toString("base64");
  await p.evaluate(b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "", { type: "image/png" }));
    document.querySelector("#compose-body").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, png);
  await wait(800);
  const pic = () => p.evaluate(() => { const imgs = document.querySelectorAll("#compose-body img"); const img = imgs[0]; return img && { count: imgs.length, width: img.getAttribute("width"), natural: img.naturalWidth, size: img.dataset.size }; });
  same(await pic(), { count: 1, width: "800", natural: 1600, size: "large" }, "pasted at Large");
  await p.click("#compose-body img"); await wait(200);
  same(await p.$eval('.pic-size-float [aria-pressed="true"]', b => b.dataset.picSize), "large", "the bar shows Large");
  const want = { small: ["240", 480], medium: ["480", 960], large: ["800", 1600], original: [null, 2400] };
  for (const size of ["small", "medium", "large", "original", "small", "large"]) {
    await p.click(`.pic-size-float [data-pic-size="${size}"]`); await wait(600);
    same(await pic(), { count: 1, width: want[size][0], natural: want[size][1], size }, size);
  }
});

test("a picture already in the message can go back up after Small", { fake: true }, async ({ p }) => {
  await p.click("#compose"); await wait(300);
  const png = fs.readFileSync(path.join(FILES, "wide.png")).toString("base64");
  await p.evaluate(b64 => {
    const write = document.querySelector("#compose-body .body-write") || document.querySelector("#compose-body");
    write.insertAdjacentHTML("afterbegin", `<p><img src="data:image/png;base64,${b64}" style="max-width:100%;height:auto"></p>`);
  }, png);
  await wait(300);
  const pic = () => p.evaluate(() => { const img = document.querySelector("#compose-body img"); return { width: img.getAttribute("width"), natural: img.naturalWidth }; });
  await p.click("#compose-body img"); await wait(200);
  await p.click('.pic-size-float [data-pic-size="small"]'); await wait(600);
  same(await pic(), { width: "240", natural: 480 }, "Small");
  await p.click('.pic-size-float [data-pic-size="large"]'); await wait(600);
  same(await pic(), { width: "800", natural: 1600 }, "Large again, from the full picture");
});

test("send later passes a UTC time", { fake: true }, async ({ p, calls, clear }) => {
  await p.evaluate(() => { sendDelay = 0; });
  await p.click("#compose"); await wait(300);
  await p.click("#compose-to"); await p.keyboard.type("eve@example.org");
  await clear();
  await p.click("#send-later"); await wait(200);
  await p.click('[data-preset="0"]'); await wait(600);
  const at = (await calls("send_mail")).map(a => a.sendAt);
  expect(at.length === 1 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(at[0]), "sendAt set", at);
});

test("a failed send says why and can be sent again", { fake: true }, async ({ p, calls }) => {
  await p.evaluate(() => { window.__failSend = 1; sendDelay = 1; });
  await p.click("#compose"); await wait(300);
  await p.click("#compose-to"); await p.keyboard.type("eve@example.org");
  await p.click('#compose-form button[type="submit"]'); await wait(2500);
  await p.evaluate(() => { const m = messages.find(x => x.pendingSend); view = "mail"; account = m.account; box = "outbox"; selected = m.id; render(); });
  await wait(200);
  expect((await p.$eval("#send-hold", e => e.textContent)).startsWith("Not sent."), "says Not sent");
  await p.click("#retry-send"); await wait(600);
  same((await calls("send_mail")).length, 2, "sent again");
});

// ---------------------------------------------------------------- mail actions

test("move to a folder, Undo, and Move to Inbox", { fake: true }, async ({ p, calls, clear, boxOf }) => {
  await p.click('.row[data-id="m1"]'); await wait(300);
  await p.click("#move-to"); await wait(200);
  await p.type("#move-filter", "kiln"); await p.keyboard.press("Enter"); await wait(500);
  same(await boxOf("m1"), "f-kiln", "moved to Kiln project");
  same((await calls("apply_mail")).filter(a => a.kind === "move").map(a => a.destination), ["f-kiln"], "server move");
  await clear();
  await p.click("#toast .toast-action"); await wait(600);
  same(await boxOf("m1"), "inbox", "Undo brought it back");
});

test("multi-select, bulk delete and keyboard shortcuts", { fake: true }, async ({ p, calls, clear, boxOf }) => {
  await p.click('.row[data-id="m3"]'); await wait(150);
  await p.keyboard.down("Shift"); await p.click('.row[data-id="m1"]'); await p.keyboard.up("Shift"); await wait(200);
  same(await p.evaluate(() => picked.size), 3, "Shift-click range");
  await clear();
  await p.click('[data-bulk="delete"]'); await wait(500);
  same([await boxOf("m1"), await boxOf("m2"), await boxOf("m3")], ["trash", "trash", "trash"], "bulk delete");
  same((await calls("apply_mail")).map(a => [a.kind, a.messageIds.length]), [["trash", 3]], "one server call");
  await p.keyboard.down("Control"); await p.keyboard.press("z"); await p.keyboard.up("Control"); await wait(600);
  same(await boxOf("m2"), "inbox", "Ctrl+Z undoes");
  await p.evaluate(() => { box = "inbox"; render(); });
  await p.click('.row[data-id="m2"]'); await wait(200);
  await p.keyboard.press("e"); await wait(300);
  same(await boxOf("m2"), "archive", "E archives");
  await p.keyboard.press("?"); await wait(150);
  expect(await p.$(".shortcuts-dialog"), "? shows the shortcuts");
});

test("All shows every account's mail beside Work and Personal, with account dots, and is kept (#134)", { fake: false }, async ({ p }) => {
  const names = () => p.$$eval("#folder-nav .acct-label.section", bs => bs.map(b => b.textContent.replace(/\s+/g, " ").trim()));
  const subjects = () => p.evaluate(() => [...document.querySelectorAll("#rows .subject")].map(s => s.textContent));
  same(await p.$$eval(".profile-switch [data-set-profile]", bs => bs.map(b => b.dataset.setProfile)), ["all", "work", "personal"], "All, Work and Personal");
  await p.click('[data-set-profile="all"]'); await wait(300);
  const sections = await names();
  expect(sections.includes("Timberworks") && sections.some(n => n === "Personal") && sections.some(n => n.includes("All accounts")), "every account, under All accounts", sections);
  await p.click('#folder-nav [data-acct="all"][data-box="inbox"]'); await wait(300);
  const all = await subjects();
  expect(all.includes("Tickets for Saturday") && all.includes("Pipeline review moved to 10:00"), "All inboxes spans both profiles", all);
  expect(await p.$$eval("#rows .acct-dot", d => d.length) > 0, "each line says whose it is");
  const mark = await p.$eval("#rows .acct-dot", d => { const r = d.getBoundingClientRect(), row = d.closest(".row").getBoundingClientRect(), dot = d.closest(".row").querySelector(".unread-dot, .dot"); return { edge: Math.round(r.left - row.left), tall: r.height > r.width * 4, round: getComputedStyle(d).borderTopLeftRadius }; });
  same([mark.edge, mark.tall, mark.round], [0, true, "0px"], "the account is a bar on the row's edge, not a dot like unread");
  same(await p.evaluate(() => defaultAccountId()), await p.evaluate(() => (activeDefaultEmail() || {}).accountId || Object.keys(accounts)[0]), "new mail starts from the default account");
  await p.reload({ waitUntil: "load" }); await wait(1500);
  same(await p.$eval('[data-set-profile="all"]', b => b.getAttribute("aria-pressed")), "true", "All is kept after a reload");
  await p.evaluate(() => setView("calendar")); await wait(400);
  same(await p.$('[data-set-profile="all"]'), null, "Calendar keeps Work, Personal and Both");
  same(await p.$eval('[data-set-calendar="both"]', b => b.getAttribute("aria-pressed")), "true", "with All chosen, Calendar shows both");
  await p.evaluate(() => setView("mail")); await wait(300);
  await p.click('[data-set-profile="work"]'); await wait(300);
  expect(!(await subjects()).includes("Tickets for Saturday"), "Work still filters");
});

test("Flagged and Snoozed lead Favorites, span folders, and their row actions work (#135)", { fake: true }, async ({ p, calls, clear }) => {
  const tasks = () => p.$$eval("#folder-nav .task-fav", bs => bs.map(b => b.querySelector(".folder-name").textContent + " " + b.querySelector(".count").textContent));
  await p.evaluate(() => {
    const id = Object.keys(accounts).find(k => accounts[k].signedIn);
    window.__acct = id;
    messages.filter(m => m.account === id).forEach(m => { m.flagged = false; });
    // A flagged message in a folder that is not open, only in the cache.
    window.__inbox.push({ id: "flag-old", thread: "conv-flag-old", subject: "Quote to chase", fromName: "Rita", fromEmail: "rita@example.org", received: "2026-06-01T09:00:00Z", preview: "Old one", bodyHtml: "", unread: false, flagged: true, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [], box: "archive" });
    // A snoozed message in the account's Snoozed folder.
    accounts[id].liveFolders.push({ id: "f-snoozed", parentId: "", name: "Snoozed", key: "f-snoozed", unread: 0, total: 1, depth: 0 });
    const item = { id: "snz-1", thread: "conv-snz", subject: "Read on Monday", fromName: "Ola", fromEmail: "ola@example.org", received: "2026-11-20T09:00:00Z", preview: "Later", bodyHtml: "", unread: false, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] };
    window.__folderMail = { "f-snoozed": [item] };
    saveSnoozes([{ account: id, email: accounts[id].email, ids: ["snz-1"], until: new Date(2030, 0, 7, 9, 0).getTime() }]);
  });
  await p.evaluate(() => loadTaskBoxes()); await wait(400);
  let got = await tasks();
  expect(got.includes("Flagged 1") && got.includes("Snoozed 1"), "Flagged and Snoozed show with counts", got);
  same(await p.evaluate(() => { const fav = document.querySelector("#folder-nav .task-fav"); const own = document.querySelector("#folder-nav .fav"); return !own || !!(fav.compareDocumentPosition(own) & Node.DOCUMENT_POSITION_FOLLOWING); }), true, "above your own favorites");
  await p.click('#folder-nav .task-fav[data-box="task:flagged"]'); await wait(400);
  same(await p.$eval(".list-head h1", h => h.textContent.trim()), "Flagged", "the list is Flagged");
  same(await p.$$eval("#rows .subject", s => s.map(x => x.textContent)), ["Quote to chase"], "flagged mail from a folder that was not open");
  await clear();
  await p.evaluate(() => document.querySelector('#rows [data-row-flag]').click()); await wait(400);
  same((await calls("apply_mail")).map(a => a.kind), ["unflag"], "unflag from the list");
  expect(!(await tasks()).some(t => t.startsWith("Flagged")), "Flagged hides once empty", await tasks());
  await p.click('#folder-nav .task-fav[data-box="task:snoozed"]'); await wait(400);
  same(await p.$$eval("#rows .subject", s => s.map(x => x.textContent)), ["Read on Monday"], "snoozed mail");
  expect((await p.$eval("#rows .when", w => w.textContent)).startsWith("Back "), "with when it comes back");
  await clear();
  await p.evaluate(() => document.querySelector('#rows [data-row-unsnooze]').click()); await wait(400);
  same((await calls("apply_mail")).map(a => a.kind), ["inbox"], "brought back to the Inbox");
  same(await p.evaluate(() => loadSnoozes().length), 0, "and no longer waits to wake");
});

test("the rest of the 1.8 review: Reply all leads, one place per action, recipients, account marks, folders per view, short events (#140)", { fake: false }, async ({ p }) => {
  // Account names carry their colour mark when several are in view.
  await p.click('[data-set-profile="all"]'); await wait(300);
  expect(await p.$$eval("#folder-nav .acct-label.section .acct-mark", m => m.length) >= 2, "each account heading has its mark");
  // A thread: the newest message has no reply arrows of its own; earlier ones show theirs on hover.
  const threadId = await p.evaluate(() => { const c = conversations().find(c => c.messages.length > 1); return c && c.latest.id; });
  expect(threadId, "a thread to read");
  await p.evaluate(id => { selected = id; render(); }, threadId); await wait(400);
  const arrows = await p.evaluate((id) => [...document.querySelectorAll("#reading .thread-card")].filter(card => card.querySelector(".thread-actions")).map(card => [card.dataset.pick === id, card.querySelector(".thread-actions").hidden]), threadId);
  same(arrows.filter(([latest]) => latest).map(([, h]) => h), [true], "the newest message's arrows are left to the toolbar");
  expect(arrows.filter(([latest]) => !latest).every(([, h]) => h === false), "earlier messages keep theirs", arrows);
  const vis = await p.evaluate(() => { const a = document.querySelector("#reading .thread-card .thread-actions:not([hidden])"); return a ? getComputedStyle(a).visibility : "hidden"; });
  same(vis, "hidden", "until the pointer is over them");
  // Recipients read as one line.
  const line = await p.$eval("#reading .party-line", b => b.textContent);
  expect(/^to (you|.+)( and .+)?$/.test(line) && !line.includes("Cc:"), "one line, as people say it", line);
  // Reply all leads when it is on the bar.
  const lead = await p.evaluate(() => { const r = document.getElementById("reply"), ra = document.querySelector(".tool-btn#reply-all"); return ra ? [getComputedStyle(ra).fontWeight, getComputedStyle(r).fontWeight] : null; });
  if (lead) expect(Number(lead[0]) > Number(lead[1]), "Reply all is the bold one", lead);
  // The folder pane remembers its state per view.
  await p.click("#hide-folders"); await wait(200);
  await p.click("#rail-cal"); await wait(300);
  same(await p.evaluate(() => document.body.dataset.folders), "open", "Calendar keeps its own choice");
  await p.click("#rail-mail"); await wait(300);
  same(await p.evaluate(() => document.body.dataset.folders), "closed", "Mail is still closed");
  same(await p.evaluate(() => JSON.parse(localStorage.getItem("mailroom-folders-open")).mail), false, "and it is saved");
  // Under about 1100px Mail folds the folders away by itself.
  await p.evaluate(() => setFoldersOpen(true)); await wait(100);
  await p.setViewport({ width: 1050, height: 800 }); await wait(400);
  same(await p.evaluate(() => document.body.dataset.folders), "closed", "folded at 1050px");
  await p.setViewport({ width: 1400, height: 900 }); await wait(400);
  same(await p.evaluate(() => document.body.dataset.folders), "open", "back at 1400px");
});

test("a short event shows its start time beside the title (#140)", { fake: true, tz: true }, async ({ p }) => {
  await p.evaluate(() => { calFocus = new Date(Date.now() + 86400000); setView("calendar"); calView = "day"; render(); }); await wait(1000);
  const got = await p.evaluate(() => { const b = document.querySelector('.event.compact[data-event="zoom-1"]'); return b && [b.querySelector("strong").textContent, (b.querySelector(".event-start") || {}).textContent]; });
  same(got, ["Zoom call", "12:00"], "title, then its start");
});

test("Work and Personal keep their mail apart", { fake: false }, async ({ p }) => {
  const names = () => p.$$eval("#folder-nav .acct-label.section", bs => bs.map(b => b.textContent.replace(/\s+/g, " ").trim()));
  const subjects = () => p.evaluate(() => [...document.querySelectorAll("#rows .subject")].map(s => s.textContent));
  const sections = await names();
  expect(sections.includes("Timberworks"), "work shows Timberworks", sections);
  expect(!sections.some(n => n === "Personal"), "work hides the personal account", sections);
  expect(!sections.some(n => n.includes("All accounts")), "one work account has no All accounts", sections);
  expect(!(await subjects()).includes("Tickets for Saturday"), "personal mail stays out of Work");
  const badge = await p.$eval('[data-set-profile="personal"] .profile-badge', e => e.textContent).catch(() => "");
  expect(badge, "Personal shows its unread count", badge);
  await p.evaluate(() => setView("calendar")); await wait(500);
  same(await p.$$eval(".profile-switch .profile-badge", bs => bs.length), 0, "Calendar shows no unread counts");
  await p.evaluate(() => setView("mail")); await wait(300);
  await p.click('[data-set-profile="personal"]'); await wait(250);
  const personal = await names();
  expect(personal.some(n => n === "Personal"), "Personal shows its account", personal);
  expect(!personal.includes("Timberworks"), "Personal hides Timberworks", personal);
  expect((await subjects()).includes("Tickets for Saturday"), "personal mail is there");
  await p.click("#rail-settings"); await wait(200);
  const cards = await p.evaluate(() => [...document.querySelectorAll(".account-card")].map(card => ({
    name: card.querySelector(".who").textContent,
    profile: card.querySelector("[data-profile][aria-pressed='true']").dataset.profile
  })));
  same(cards.map(c => [c.name, c.profile]), [["Timberworks", "work"], ["Personal", "personal"]], "settings lists both profiles");
  await p.click('.account-card [data-account-profile="timberworks"][data-profile="personal"]'); await wait(250);
  await p.click("#rail-mail"); await wait(250);
  const both = await names();
  expect(both.some(n => n.includes("All accounts")), "two accounts in Personal share All accounts", both);
  expect(both.includes("Timberworks") && both.some(n => n === "Personal"), "both accounts sit under Personal", both);
  await p.click('#folder-nav [data-acct="all"][data-box="inbox"]'); await wait(200);
  const unified = await subjects();
  expect(unified.includes("Tickets for Saturday"), "All accounts includes personal mail", unified);
  expect(unified.includes("Pipeline review moved to 10:00"), "All accounts includes the account moved into Personal", unified);
  await p.click('[data-set-profile="work"]'); await wait(200);
  const work = await names();
  expect(!work.includes("Timberworks") && !work.some(n => n === "Personal"), "Work has no accounts", work);
  expect(!(await subjects()).includes("Tickets for Saturday") && !(await subjects()).includes("Pipeline review moved to 10:00"), "Work does not show that mail");
  same(await p.evaluate(() => {
    const hold = { profile: accounts.timberworks.profile, provider: accounts.timberworks.provider };
    accounts.timberworks.profile = "";
    accounts.timberworks.provider = "google";
    const google = accountProfile("timberworks");
    accounts.timberworks.provider = "microsoft";
    const microsoft = accountProfile("timberworks");
    accounts.timberworks.profile = "personal";
    const chosen = accountProfile("timberworks");
    accounts.timberworks.profile = hold.profile;
    accounts.timberworks.provider = hold.provider;
    return [google, microsoft, chosen];
  }), ["personal", "work", "personal"], "Google starts in Personal, Microsoft in Work, and a saved choice wins");
});

test("Deleted Items: Move to Inbox from the right-click menu", { fake: false }, async ({ p, rightClick, menu, boxOf }) => {
  await p.evaluate(() => { setActiveProfile("personal"); box = "trash"; render(); });
  await wait(200);
  await rightClick('.row[data-id="reminder"]');
  expect((await menu()).includes("Move to Inbox"), "menu offers Move to Inbox");
  await p.click('#row-menu [data-act="to-inbox"]'); await wait(200);
  same(await boxOf("reminder"), "inbox", "moved back");
});

test("an opened thread is a subject line over every message, newest first", { fake: false }, async ({ p }) => {
  const r = await p.evaluate(async () => {
    const c = conversations().find(c => c.messages.length > 2);
    openThreads.add(c.id); render();
    await new Promise(r => setTimeout(r, 100));
    const conv = [...document.querySelectorAll(".conv.open")][0];
    const rows = [...conv.querySelectorAll(".conv-kids .row")].map(r => messages.find(m => m.id === r.dataset.id).seq);
    return { title: !!conv.querySelector(".conv-title"), count: rows.length, total: c.messages.length, newestFirst: rows.every((s, i) => i === 0 || rows[i - 1] >= s) };
  });
  expect(r.title, "subject line");
  same(r.count, r.total, "every message listed");
  expect(r.newestFirst, "newest first");
});

test("check for new mail: button and F5", { fake: true }, async ({ p, calls, clear, toast }) => {
  await clear();
  await p.click("#check-mail"); await wait(600);
  same((await calls("sync_inbox")).length, 1, "button checks");
  await p.evaluate(() => { window.__inbox.push(Object.assign({}, window.__inbox[0], { id: "m9", received: new Date().toISOString().replace(/\.\d+Z$/, "Z") })); });
  await p.keyboard.press("F5"); await wait(600);
  same(await toast(), "1 new message", "F5 finds the new message");
});

test("a server that is not up yet is tried again, and the banner stays down", { fake: true, setup: () => {
  window.__reachLeft = 2;
  window.__reachWaits = [0.4, 0.4, 0.4, 0.4, 0.4];
} }, async ({ p }) => {
  await wait(2000);
  const state = await p.evaluate(() => ({
    banner: document.getElementById("auth-banner").hidden ? "" : document.getElementById("auth-banner").textContent,
    note: (document.querySelector(".sync-note-text") || {}).textContent || "",
    syncs: window.__calls.filter(call => call[0] === "sync_inbox").length,
    mail: messages.some(m => m.id === "m1")
  }));
  same(state.banner, "", "no banner once the server answers");
  same(state.note, "", "the waiting line is gone");
  expect(state.syncs >= 3, "the first try and two more", state.syncs);
  expect(state.mail, "the mail arrived", state);
});

test("the banner shows only after the retries give up", { fake: true, setup: () => {
  window.__reachLeft = 20;
  window.__reachWaits = [0.2, 0.2, 0.2];
} }, async ({ p }) => {
  await wait(1500);
  const state = await p.evaluate(() => ({
    banner: document.getElementById("auth-banner").hidden ? "" : document.querySelector("#auth-banner .auth-text").textContent,
    note: (document.querySelector(".sync-note-text") || {}).textContent || ""
  }));
  same(state.banner, "Could not reach Google.", "the banner says Google could not be reached");
  same(state.note, "", "it stops waiting");
});

// ---------------------------------------------------------------- invites, notifications

test("an invite says what it clashes with on your calendar", { fake: true, setup: () => {
  const d = new Date(); d.setDate(d.getDate() + 1);
  const at = (h, m) => { const x = new Date(d); x.setHours(h, m || 0, 0, 0); return x.toISOString().replace(/\.\d+Z$/, "Z"); };
  window.__invite = { eventId: "ev-new", subject: "Budget chat", start: at(9, 30), end: at(9, 45), allDay: false, location: "", response: "", cancelled: false, organizer: false };
} }, async ({ p }) => {
  await p.evaluate(() => syncCalendars(null, false)); await wait(600);
  await p.click('.row[data-id="m2"]'); await wait(900);
  const note = await p.$eval("#reading .invite-clash", e => e.textContent.trim()).catch(() => "");
  same(note, "Conflicts with Single", "the overlapping busy meeting is named");
  await p.click("#reading .invite-clash"); await wait(400);
  same(await p.evaluate(() => [view, dayFromDate(calFocus) === dayFromDate(new Date(Date.now() + 86400000))]), ["calendar", true], "clicking opens the calendar on that day");
  // A time with nothing booked says so; free time doesn't count.
  await p.evaluate(() => {
    const d = new Date(); d.setDate(d.getDate() + 1);
    const at = (h, m) => { const x = new Date(d); x.setHours(h, m || 0, 0, 0); return x.toISOString().replace(/\.\d+Z$/, "Z"); };
    const m = messages.find(x => x.id === "m2");
    m.liveInvite = Object.assign({}, m.liveInvite, { start: at(7), end: at(7, 30) });
    events.push({ id: "free-1", live: true, account: m.account, day: dayFromDate(d), start: 7 * 60, end: 8 * 60, title: "Gym", showAs: "free" });
    setView("mail");
  });
  await p.click('.row[data-id="m2"]'); await wait(600);
  same(await p.$eval("#reading .invite .invite-clear", e => e.textContent.trim()).catch(() => ""), "No conflicts", "free time is not a conflict");
});

test("a folder can show its unread or its total count", { fake: true }, async ({ p }) => {
  const count = () => p.$eval('.acct-item[data-box="inbox"] .count', e => e.textContent.trim());
  await p.evaluate(() => { Object.values(accounts).forEach(a => (a.liveFolders || []).forEach(f => { if (f.key === "inbox") f.total = 7; })); render(); }); await wait(200);
  const unread = await count();
  await p.click('.acct-item[data-box="inbox"]', { button: "right" }); await wait(200);
  same(await p.$$eval("#row-menu button", bs => bs.map(b => b.textContent.trim())).then(l => l.includes("Show total number of items")), true, "the Inbox offers its total");
  await p.click('#row-menu [data-act="count-total"]'); await wait(300);
  const total = await count();
  expect(Number(total) > Number(unread || 0), "the Inbox now shows its total", { unread, total });
  same(await p.evaluate(() => JSON.parse(localStorage.getItem("mailroom-folder-counts"))), { [await p.evaluate(() => document.querySelector('.acct-item[data-box="inbox"]').dataset.acct + "\ninbox")]: "total" }, "remembered");
  await p.click('.acct-item[data-box="inbox"]', { button: "right" }); await wait(200);
  await p.click('#row-menu [data-act="count-unread"]'); await wait(300);
  same(await count(), unread, "and back to unread");
  same(await p.evaluate(() => localStorage.getItem("mailroom-folder-counts")), "{}", "the default needs no setting");
});

test("invites answer the organiser", { fake: true }, async ({ p, calls, clear }) => {
  await clear();
  await p.click('.row[data-id="m2"]'); await wait(800);
  await p.click('[data-rsvp-msg] button[data-rsvp="accepted"]'); await wait(500);
  same((await calls("respond_invite")).map(a => [a.eventId, a.response]), [["ev-1", "accepted"]], "answer sent");
  same(await p.evaluate(() => messages.find(m => m.id === "m2").box), "trash", "invite moved to Deleted Items");
  same((await calls("apply_mail")).filter(a => a.kind === "trash").map(a => a.messageIds), [["m2"]], "moved on the server");
  expect((await p.$eval("#toast", e => e.textContent)).includes("Undo"), "with Undo");
});

test("invites stay put when the setting is off", { fake: true, setup: () => { localStorage.setItem("mailroom-tidy-invites", "off"); } }, async ({ p, clear }) => {
  await clear();
  await p.click('.row[data-id="m2"]'); await wait(800);
  await p.click('[data-rsvp-msg] button[data-rsvp="declined"]'); await wait(500);
  same(await p.evaluate(() => messages.find(m => m.id === "m2").box), "inbox", "invite stays in the Inbox");
});

test("an invite is answered from the message list's right-click menu", { fake: true }, async ({ p, calls, clear, rightClick, menu }) => {
  await clear();
  await p.evaluate(() => { messages.find(m => m.id === "m2").invite = true; render(); }); await wait(200);
  await rightClick('.row[data-id="m1"]');
  expect(!(await menu()).includes("Accept"), "an ordinary message offers no answers", await menu());
  await p.keyboard.press("Escape"); await p.evaluate(() => hideRowMenu());
  await rightClick('.row[data-id="m2"]');
  const items = await menu();
  same(items.slice(0, 4), ["Open in new window", "Accept", "Tentative", "Decline"], "the invite row offers the three answers, after Open in new window");
  await p.click('#row-menu [data-act="rsvp-tentative"]'); await wait(800);
  same((await calls("message_invite")).map(a => a.messageId)[0], "m2", "the invite is looked up first, unopened");
  same((await calls("respond_invite")).map(a => [a.eventId, a.response]), [["ev-1", "tentative"]], "the answer goes to the organiser");
  same(await p.evaluate(() => messages.find(m => m.id === "m2").box), "trash", "and the invite goes to Deleted Items, as from the reading pane");
  expect((await p.$eval("#toast", e => e.textContent)).includes("Undo"), "with Undo");
});

test("a cancelled meeting's row offers no answers", { fake: true, setup: () => {
  window.__invite = { eventId: "ev-1", subject: "Pipeline review", start: "2026-10-22T15:00:00Z", end: "2026-10-22T15:30:00Z", allDay: false, location: "", response: "", cancelled: true, organizer: false };
} }, async ({ p, calls, clear, rightClick, menu }) => {
  await p.click('.row[data-id="m2"]'); await wait(800);
  await clear();
  await rightClick('.row[data-id="m2"]');
  expect(!(await menu()).includes("Accept"), "once known to be cancelled, nothing to answer", await menu());
  same(await calls("respond_invite"), [], "and nothing is sent");
});

test("Forward and Reply on your own reply from Sent Items, inside the thread", { fake: true, setup: () => {
  const at = n => new Date(Date.now() - n * 60000).toISOString().replace(/\.\d+Z$/, "Z");
  const base = { thread: "conv-pump", subject: "Pump order", fromName: "Kai", fromEmail: "kai@example.org", unread: false, flagged: false, cc: [], bcc: [], to: [], categories: [], hasAttachments: false, files: [] };
  ["pump-1", "pump-2"].forEach((id, i) => window.__inbox.push(Object.assign({}, base, { id, received: at(90 - i * 30), preview: id, bodyHtml: "<p>" + id + "</p>" })));
} }, async ({ p }) => {
  await p.click('.row[data-id="pump-2"]'); await wait(500);
  // A reply of yours, with an attachment, that the thread pulls in from Sent Items.
  await p.evaluate(() => {
    const head = messages.find(m => m.id === "pump-2");
    messages.push(Object.assign({}, head, { id: "pump-sent", box: "sent", seq: head.seq - 1, from: "Jon", fromName: "Jon", email: "jon@example.com", preview: "Here it is", bodyHtml: "<p>Here it is</p>", received: new Date(Date.now() - 45 * 60000).toISOString().replace(/\.\d+Z$/, "Z"), hasAttachment: true, files: [{ id: "q1", name: "quote.pdf", size: 1000, contentType: "application/pdf" }], attachments: ["quote.pdf"] }));
    render();
  }); await wait(400);
  await p.click('#reading [data-fold="pump-sent"]'); await wait(400);
  await p.click('#reading [data-forward="pump-sent"]'); await wait(600);
  const fw = await p.evaluate(() => ({ form: !!document.querySelector('#reading form#compose-form[data-msg="pump-sent"]'), subject: replyDraft.subject, files: replyDraft.attachments }));
  same(fw, { form: true, subject: "FW: Pump order", files: ["quote.pdf"] }, "Forward opens a forward of it, with its attachment");
  await p.evaluate(() => { replyDraft = null; render(); }); await wait(300);
  if (await p.$('#reading [data-fold="pump-sent"]')) { await p.click('#reading [data-fold="pump-sent"]'); await wait(400); }
  await p.click('#reading [data-reply="pump-sent"]'); await wait(600);
  same(await p.evaluate(() => [!!document.querySelector('#reading form#compose-form[data-msg="pump-sent"]'), replyDraft.compose || "reply"]), [true, "reply"], "and Reply opens a reply");
});

test("new mail notifies once, escaped", { fake: true }, async ({ p, calls, clear }) => {
  await clear();
  await p.evaluate(() => {
    window.__inbox.push({ id: "m4", thread: "conv-m4", subject: "Delivery <b>today</b>", fromName: "Eve", fromEmail: "eve@example.org", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Lorry", bodyHtml: "<p>x</p>", unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
    document.hasFocus = () => false;
  });
  await p.evaluate(() => pollMail()); await wait(400);
  await p.evaluate(() => pollMail()); await wait(400);
  same((await calls("notify_mail")).map(a => a.title), ["Eve"], "one notification");
});

test("a burst of new mail is one notification naming the account; a click opens its Inbox", { fake: true }, async ({ p, calls, clear }) => {
  await clear();
  await p.evaluate(() => {
    const now = Date.now();
    ["Eve", "Finn", "Gus", "Eve", "Hal", "Ivy"].forEach((name, i) => window.__inbox.push({ id: "burst-" + i, thread: "conv-burst-" + i, subject: "Note " + i, fromName: name, fromEmail: name.toLowerCase() + "@example.org", received: new Date(now - i * 1000).toISOString().replace(/\.\d+Z$/, "Z"), preview: "x", bodyHtml: "<p>x</p>", unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] }));
    document.hasFocus = () => false;
  });
  await p.evaluate(() => pollMail()); await wait(400);
  const sent = await calls("notify_mail");
  same(sent.length, 1, "six new messages make one notification", sent.map(n => n.title));
  const acct = await p.evaluate(() => messages.find(m => m.id === "burst-0").account);
  const name = await p.evaluate(a => accounts[a].name, acct);
  same(sent[0].title, "6 new messages · " + name, "saying how many, and for which account");
  same(sent[0].body, "Eve, Finn, Gus and 2 others", "newest senders first, each once");
  same(sent[0].messageId, "inbox:" + acct, "pointing at that account's Inbox");
  await p.evaluate(() => { setView("calendar"); box = "sent"; }); await wait(200);
  await p.evaluate(id => openFromNotification(id), sent[0].messageId); await wait(300);
  same(await p.evaluate(() => [view, account, box]), ["mail", acct, "inbox"], "a click opens that Inbox");
});

test("two or three new messages still notify one by one", { fake: true }, async ({ p, calls, clear }) => {
  await clear();
  await p.evaluate(() => {
    const now = Date.now();
    ["Eve", "Finn"].forEach((name, i) => window.__inbox.push({ id: "pair-" + i, thread: "conv-pair-" + i, subject: "Note " + i, fromName: name, fromEmail: name.toLowerCase() + "@example.org", received: new Date(now - i * 1000).toISOString().replace(/\.\d+Z$/, "Z"), preview: "x", bodyHtml: "<p>x</p>", unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] }));
    document.hasFocus = () => false;
  });
  await p.evaluate(() => pollMail()); await wait(400);
  same((await calls("notify_mail")).map(n => [n.title, n.messageId]), [["Eve", "pair-0"], ["Finn", "pair-1"]], "one each, opening the message");
});

test("a rule that forwards mail elsewhere shows a warning until it is off or dismissed", { fake: true, setup: () => {
  window.__rules = [
    { id: "r-tidy", name: "Tidy", enabled: true, from: ["news@example.org"], subject: [], moveTo: "", markRead: true, delete: false, stop: true, other: false, forwardsTo: [] },
    { id: "r-out", name: "Copy out", enabled: true, from: [], subject: ["invoice"], moveTo: "", markRead: false, delete: false, stop: false, other: true, forwardsTo: ["drop@elsewhere.example"] },
    { id: "r-old", name: "Old forward", enabled: false, from: [], subject: ["x"], moveTo: "", markRead: false, delete: false, stop: false, other: true, forwardsTo: ["old@elsewhere.example"] }
  ];
} }, async ({ p, calls }) => {
  await wait(600);
  const banner = () => p.evaluate(() => { const b = document.getElementById("forward-banner"); return b ? b.textContent : ""; });
  const text = await banner();
  expect(/is forwarded to drop@elsewhere\.example by the rule “Copy out”/.test(text), "the banner names the address and the rule", text);
  expect(!text.includes("old@elsewhere"), "a rule that is off is not warned about", text);
  await p.click("#forward-review"); await wait(600);
  same(await p.evaluate(() => [view, settingsPage]), ["settings", "rules"], "Review rule opens the rules");
  const summary = await p.$$eval(".rule-item small", e => e.map(x => x.textContent));
  expect(summary.some(t => t.includes("forward to drop@elsewhere.example")), "and the rule says where it forwards", summary);
  // Turning it off there clears the warning.
  await p.click('[data-rule-on="1"]'); await wait(400);
  same(await banner(), "", "turned off, the warning goes");
  await p.click('[data-rule-on="1"]'); await wait(400);
  expect((await banner()).includes("Copy out"), "turned back on, it returns");
  await p.evaluate(() => setView("mail")); await wait(300);
  await p.click("#forward-dismiss"); await wait(200);
  same(await banner(), "", "Dismiss hides it");
  await p.reload(); await wait(1500);
  same(await banner(), "", "and it stays dismissed after a restart");
  // The same rule sending somewhere new warns again.
  await p.evaluate(() => { window.__rules[1].forwardsTo = ["new@elsewhere.example"]; checkForwardRules(); }); await wait(400);
  expect((await banner()).includes("new@elsewhere.example"), "a changed address warns again", await banner());
});

test("Sort subfolders A to Z, with Undo; collapse or expand all accounts (#119)", { fake: true, setup: () => {
  window.__folders.push(
    { id: "f-zeta", parentId: "f-jobs", name: "Zeta", key: "f-zeta", unread: 0, total: 0, depth: 1 },
    { id: "f-alpha", parentId: "f-jobs", name: "alpha", key: "f-alpha", unread: 0, total: 0, depth: 1 }
  );
} }, async ({ p, menu }) => {
  await wait(400);
  const acct = await p.evaluate(() => Object.keys(accounts)[0]);
  const folderMenu = async key => { await p.evaluate((a, k) => showFolderMenu(100, 100, a, k), acct, key); await wait(150); return menu(); };
  const shown = () => p.evaluate(a => orderedFolderKeys(a).filter(k => ["f-kiln", "f-zeta", "f-alpha"].includes(k)), acct);
  same(await shown(), ["f-kiln", "f-zeta", "f-alpha"], "the server's order at first");
  expect(!(await folderMenu("f-kiln")).includes("Sort subfolders A to Z"), "not offered on a folder with nothing inside");
  await p.evaluate(() => hideRowMenu());
  expect((await folderMenu("f-jobs")).includes("Sort subfolders A to Z"), "offered on a folder with subfolders");
  await p.click('#row-menu [data-act="sort-subfolders"]'); await wait(300);
  same(await shown(), ["f-alpha", "f-kiln", "f-zeta"], "A to Z, ignoring case");
  same(await p.evaluate(a => JSON.parse(localStorage.getItem("mailroom-folder-order"))[a]["f-jobs"], acct), ["f-alpha", "f-kiln", "f-zeta"], "kept like a dragged order");
  await p.click("#toast .toast-action"); await wait(300);
  same(await shown(), ["f-kiln", "f-zeta", "f-alpha"], "Undo puts the old order back");
  // Account headings: right-click for all of them; Alt+click does the same.
  const head = `#folders [data-section="${acct}"]`;
  await p.click(head, { button: "right" }); await wait(150);
  same(await menu(), ["Collapse all accounts", "Expand all accounts"], "the account heading's menu");
  same(await p.$eval('#row-menu [data-act="expand-all"]', b => b.disabled), true, "Expand is off when all are open");
  await p.click('#row-menu [data-act="collapse-all"]'); await wait(200);
  same(await p.$eval(head, b => b.getAttribute("aria-expanded")), "false", "collapsed");
  same(JSON.parse(await p.evaluate(() => localStorage.getItem("mailroom-mail-collapse"))).sections.includes(acct), true, "and remembered");
  await p.keyboard.down("Alt"); await p.click(head); await p.keyboard.up("Alt"); await wait(200);
  same(await p.$eval(head, b => b.getAttribute("aria-expanded")), "true", "Alt+click opens them all again");
});

test("folders can be made, renamed and deleted from the folder menu; Outlook's own cannot (#59)", { fake: true }, async ({ p, calls, clear, menu }) => {
  await wait(400);
  const acct = await p.evaluate(() => Object.keys(accounts)[0]);
  const folderMenu = async key => { await p.evaluate((a, k) => showFolderMenu(100, 100, a, k), acct, key); await wait(150); return menu(); };
  const names = () => p.evaluate(a => accounts[a].liveFolders.map(f => "  ".repeat(f.depth) + f.name), acct);
  const inbox = await folderMenu("inbox");
  expect(inbox.includes("New folder") && inbox.includes("New subfolder"), "Inbox can hold folders", inbox);
  expect(!inbox.includes("Rename…") && !inbox.includes("Delete folder"), "but Inbox can't be renamed or deleted", inbox);
  await p.evaluate(() => hideRowMenu());
  const jobs = await folderMenu("f-jobs");
  expect(jobs.includes("Rename…") && jobs.includes("Delete folder"), "a folder you made can", jobs);
  await p.evaluate(() => hideRowMenu());
  // A new subfolder of Jobs lands inside Jobs, after Kiln project.
  await clear();
  await folderMenu("f-jobs");
  await p.click('#row-menu [data-act="new-subfolder"]'); await wait(200);
  expect((await p.$eval(".name-dialog h2", e => e.textContent)) === "New folder in Jobs", "the dialog names the parent");
  await p.type("#name-dialog-input", "Quotes");
  await p.keyboard.press("Enter"); await wait(400);
  same((await calls("create_folder")).map(c => [c.name, c.parentId]), [["Quotes", "f-jobs"]], "made inside Jobs on the server");
  const after = await names();
  same(after.slice(after.indexOf("Jobs"), after.indexOf("Jobs") + 3), ["Jobs", "  Kiln project", "  Quotes"], "and shown there straight away");
  // Rename it.
  await clear();
  await folderMenu("f-new-quotes");
  await p.click('#row-menu [data-act="rename-folder"]'); await wait(200);
  same(await p.$eval("#name-dialog-input", e => e.value), "Quotes", "the old name to edit");
  await p.evaluate(() => { document.querySelector("#name-dialog-input").value = "Quotes 2026"; });
  await p.click(".name-dialog button[type=submit]"); await wait(400);
  same((await calls("rename_folder")).map(c => [c.folderId, c.name]), [["f-new-quotes", "Quotes 2026"]], "renamed on the server");
  expect((await names()).includes("  Quotes 2026"), "and in the list");
  // Delete Jobs: it goes with what is inside it, and leaves Favorites too.
  await p.evaluate(a => { addFavorite(a, "f-kiln"); openFolder(a, "f-kiln", "f-kiln", "folder"); }, acct); await wait(300);
  await clear();
  await folderMenu("f-jobs");
  await p.click('#row-menu [data-act="delete-folder"]'); await wait(200);
  const note = await p.$eval(".choose-dialog .dialog-note", e => e.textContent);
  expect(/Deleted Items/.test(note) && /2 folders inside it/.test(note), "the warning says where it goes and what goes with it", note);
  await p.click('.choose-dialog [data-choose="yes"]'); await wait(400);
  same((await calls("delete_folder")).map(c => c.folderId), ["f-jobs"], "deleted on the server");
  const left = await names();
  expect(!left.some(n => /Jobs|Kiln|Quotes/.test(n)), "Jobs and its subfolders leave the list", left);
  same(await p.evaluate(a => [box, favorites.some(f => f.account === a && f.box === "f-kiln")], acct), ["inbox", false], "the open folder falls back to Inbox, and the favorite goes");
  // A refusal is shown, and nothing changes.
  await p.evaluate(() => { window.__folderError = "There is already a folder with that name there."; });
  await folderMenu("inbox");
  await p.click('#row-menu [data-act="new-folder"]'); await wait(200);
  await p.type("#name-dialog-input", "Archive");
  await p.keyboard.press("Enter"); await wait(400);
  expect((await p.$eval("#toast", e => e.textContent)).includes("already a folder"), "the reason is shown");
  same(await names(), left, "and the list is unchanged");
});

test("Sweep clears a sender's mail from the folder, once or for good (#60)", { fake: true, setup: () => {
  const at = days => new Date(Date.now() - days * 86400000 - 60000).toISOString().replace(/\.\d+Z$/, "Z");
  [["news-0", 0], ["news-12", 12], ["news-20", 20]].forEach(([id, days]) => window.__inbox.push({ id, thread: "conv-" + id, subject: "Deals " + id, fromName: "Deals", fromEmail: "deals@list.example", received: at(days), preview: "Offers", bodyHtml: "<p>Offers</p>", unread: false, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] }));
} }, async ({ p, calls, clear, rightClick, menu }) => {
  await p.evaluate(() => { mailSyncDays = 60; }); await wait(300);
  const inTrash = () => p.evaluate(() => messages.filter(m => /^news-/.test(m.id) && messageBox(m) === "trash").map(m => m.id).sort());
  await rightClick('.row[data-id="news-0"]');
  expect((await menu()).includes("Sweep…"), "the row menu offers Sweep", await menu());
  await p.click('#row-menu [data-act="sweep"]'); await wait(300);
  const offered = await p.$$eval(".choose-dialog [data-choose]", e => e.map(x => x.textContent));
  same(offered, ["Delete all 3 messages", "Delete all, and any that come later", "Keep only the latest, delete 2 messages", "Delete the 2 messages older than 10 days"], "the four sweeps, with counts");
  expect((await p.$eval(".choose-dialog h2", e => e.textContent)).includes("deals@list.example"), "naming the sender");
  // Older than 10 days: two go, with one Undo for both.
  await clear();
  await p.click('.choose-dialog [data-choose="older"]'); await wait(400);
  same(await inTrash(), ["news-12", "news-20"], "the two old ones go to Deleted Items");
  same((await calls("apply_mail")).filter(a => a.kind === "trash").map(a => a.messageIds.slice().sort()), [["news-12", "news-20"]], "in one server call");
  await p.evaluate(() => undoLastMove()); await wait(400);
  same(await inTrash(), [], "and one Undo brings both back");
  // Keep only the latest.
  await p.evaluate(() => { sweep(messages.find(m => m.id === "news-0")); }); await wait(300);
  await p.click('.choose-dialog [data-choose="latest"]'); await wait(400);
  same(await inTrash(), ["news-12", "news-20"], "keeping only the newest");
  await p.evaluate(() => undoLastMove()); await wait(400);
  // And future ones: an inbox rule first, then the sweep.
  await clear();
  await p.evaluate(() => { sweep(messages.find(m => m.id === "news-0")); }); await wait(300);
  await p.click('.choose-dialog [data-choose="future"]'); await wait(500);
  const rule = (await calls("save_rule"))[0];
  same(rule && [rule.rule.from, rule.rule.delete, rule.rule.enabled], [["deals@list.example"], true, true], "a rule deletes their later mail on the server");
  same(await inTrash(), ["news-0", "news-12", "news-20"], "and every one here goes now");
  // Nothing to sweep from your own mail.
  same(await p.evaluate(() => sweepSource([{ email: "jon@example.com", box: "inbox", account: Object.keys(accounts)[0] }])), null, "your own messages are never swept");
});

test("sent mail carries the recipients' display names (#70)", { fake: true }, async ({ p, calls, clear }) => {
  await p.click('.row[data-id="m1"]'); await wait(400);
  // Ada (m1's sender) is known by name; the second address is not.
  await clear();
  await p.evaluate(() => {
    const id = Object.keys(accounts)[0];
    queueOutgoing({ to: "ADA@example.org; stranger@elsewhere.example", cc: "maya@example.org", subject: "Kiln", bodyHtml: "<p>Tuesday</p>", from: id }, 0);
  }); await wait(600);
  const sent = (await calls("send_mail"))[0];
  same(sent && sent.names, { "ada@example.org": "Ada Lovelace", "maya@example.org": "Maya Chen" }, "names for the people Mailroom knows, keyed by address; none made up");
});

test("scheduled mail waits in Outbox with Cancel send, which keeps it as a draft (#68)", { fake: true, setup: () => {
  window.__scheduled = [{ id: "sched-1", subject: "Quarterly report", to: ["ada@example.org"], sendAt: "2026-12-01T08:00:00Z" }];
} }, async ({ p, calls, clear }) => {
  await wait(600);
  const acct = await p.evaluate(() => Object.keys(accounts)[0]);
  same(await p.$("#scheduled-panel"), null, "not shown outside Outbox");
  await p.evaluate(a => openFolder(a, "outbox", "", "folder"), acct); await wait(300);
  const text = await p.$eval("#scheduled-panel", e => e.textContent);
  expect(text.includes("Quarterly report") && text.includes("Ada Lovelace") && /Goes .*Dec/.test(text), "Outbox lists it with who and when", text);
  // A refusal leaves it scheduled and says why.
  await p.evaluate(() => { window.__cancelError = "It has already been sent."; });
  await p.click("[data-cancel-scheduled]"); await wait(400);
  expect((await p.$eval("#toast", e => e.textContent)).includes("already been sent"), "the reason is shown");
  await p.evaluate(() => { window.__cancelError = null; });
  // Cancel send: it goes back to Drafts, which opens. A slow answer, a
  // redraw of the panel and a second click still cancel it once.
  await clear();
  await p.evaluate(() => { window.__delays = { cancel_scheduled: 400 }; });
  await p.click("[data-cancel-scheduled]"); await wait(50);
  await p.evaluate(() => paintScheduledPanel());
  same(await p.$eval("[data-cancel-scheduled]", e => e.disabled), true, "the redrawn button stays off while the cancel is out");
  await p.evaluate(() => document.querySelector("[data-cancel-scheduled]").click());
  await wait(800);
  await p.evaluate(() => { window.__delays = {}; });
  same((await calls("cancel_scheduled")).map(c => c.id), ["sched-1"], "cancelled on the server");
  same(await p.evaluate(() => box), "drafts", "Drafts opens, to edit or schedule again");
  same(await p.$("#scheduled-panel"), null, "and nothing is left scheduled");
  // Scheduling something new lists it there, not as a sent message.
  await clear();
  await p.evaluate(a => { window.__scheduled = [{ id: "sched-2", subject: "Later", to: [], sendAt: "2026-12-02T09:00:00Z" }]; queueOutgoing({ to: "a@maplehill.example", subject: "Later", bodyHtml: "<p>x</p>", from: a, sendAt: "2026-12-02T09:00:00Z" }, 0); }, acct); await wait(600);
  same((await calls("send_mail")).map(c => c.sendAt), ["2026-12-02T09:00:00Z"], "handed to Microsoft to hold");
  expect((await calls("scheduled_sends")).length >= 1, "and the scheduled list is read again");
  same(await p.evaluate(() => messages.filter(m => m.subject === "Later").map(m => messageBox(m))), [], "no copy pretends to be in Sent");
  await p.evaluate(a => openFolder(a, "outbox", "", "folder"), acct); await wait(300);
  expect((await p.$eval("#scheduled-panel", e => e.textContent)).includes("Later"), "it is in Outbox's Scheduled list");
});

test("mail shortcuts are off while writing, even when a compose button has focus", { fake: true }, async ({ p, calls, clear }) => {
  await p.click('.row[data-id="m3"]'); await wait(400);
  await p.click("#reply"); await wait(500);
  // Focus a button in the reply (as after clicking Bold), not the text.
  const focused = await p.evaluate(() => { const b = document.querySelector("#reading #compose-form button:not([type=submit])"); if (!b) return ""; b.focus(); return document.activeElement === b ? b.id || b.className : ""; });
  expect(focused, "a compose button has focus", focused);
  await clear();
  for (const key of ["e", "Delete", "v", "j", "Insert"]) { await p.keyboard.press(key); await wait(150); }
  await p.keyboard.down("Control"); await p.keyboard.press("z"); await p.keyboard.up("Control"); await wait(200);
  same(await p.evaluate(() => messageBox(messages.find(m => m.id === "m3"))), "inbox", "E and Delete did not move the conversation");
  same(await p.evaluate(() => [selected, !!messages.find(m => m.id === "m3").flagged, !!document.querySelector(".move-dialog")]), ["m3", false, false], "J, Insert and V did nothing either");
  same((await calls("apply_mail")).length, 0, "nothing reached the server");
  // Keys that land nowhere while the reply is open are ignored too.
  await p.evaluate(() => document.activeElement.blur()); await p.keyboard.press("e"); await wait(200);
  same(await p.evaluate(() => messageBox(messages.find(m => m.id === "m3"))), "inbox", "a stray key with the reply open does nothing");
  // With the reply gone, the shortcuts are back.
  await p.evaluate(() => { replyDraft = null; reading.dataset.paint = ""; render(); document.activeElement.blur(); }); await wait(300);
  same(await p.$("#reading #compose-form"), null, "the reply is closed");
  await p.keyboard.press("e"); await wait(300);
  same(await p.evaluate(() => messageBox(messages.find(m => m.id === "m3"))), "archive", "E archives again when you're not writing");
});

test("undoing a Gmail archive from a view that isn't a label puts the Inbox label back", { fake: true, setup: () => { window.__google = true; } }, async ({ p, calls, clear }) => {
  await wait(600);
  await clear();
  await p.evaluate(() => {
    const m = messages.find(x => x.id === "m1");
    m.box = "starred";
    moveConversation({ messages: [m] }, "archive");
  }); await wait(400);
  await p.evaluate(() => undoLastMove()); await wait(500);
  const kinds = (await calls("apply_mail")).map(a => a.kind);
  same(kinds, ["archive", "inbox"], "the undo asks Gmail for the Inbox label back, not a move to Starred");
  same(await p.evaluate(() => messageBox(messages.find(x => x.id === "m1"))), "starred", "and it shows where it was");
});

test("Send later on Gmail: Mailroom holds it in Outbox until the time (#69)", { fake: true, setup: () => { window.__google = true; } }, async ({ p, calls, clear }) => {
  await wait(600);
  const acct = await p.evaluate(() => Object.keys(accounts)[0]);
  same(await p.evaluate(a => isGoogleAccount(a), acct), true, "a Gmail account");
  await clear();
  const due = await p.evaluate(a => {
    const at = new Date(Date.now() + 3 * 3600 * 1000);
    queueOutgoing({ to: "a@maplehill.example", subject: "Gmail later", bodyHtml: "<p>x</p>", from: a, sendAt: utcStamp(at) }, 0);
    return at.getTime();
  }, acct); await wait(300);
  await p.evaluate(() => tickPendingSends()); await wait(300);
  const held = await p.evaluate(() => { const m = messages.find(x => x.subject === "Gmail later"); return m && { box: messageBox(m), time: m.time, heldUntil: m.heldUntil, sendLater: m.sendLater }; });
  same([held.box, held.time, held.sendLater], ["outbox", "Scheduled", ""], "held in Outbox as Scheduled, not handed to Gmail");
  expect(Math.abs(held.heldUntil - due) < 2000, "until the chosen time", held);
  same(await calls("send_mail"), [], "nothing sent yet");
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem("mailroom-outbox")).find(r => r.subject === "Gmail later"));
  expect(saved && saved.heldUntil > 0, "kept across a restart", saved);
  // Open it: the hold bar says when, and offers Cancel send.
  await p.evaluate(() => { const m = messages.find(x => x.subject === "Gmail later"); box = "outbox"; selected = m.id; render(); }); await wait(300);
  const bar = await p.$eval("#send-hold", e => e.textContent);
  expect(/Scheduled for .*Mailroom sends it then/.test(bar) && bar.includes("Cancel send"), "the bar says when, and how to stop it", bar);
  // When the time comes it goes, as a plain send.
  await p.evaluate(() => { const m = messages.find(x => x.subject === "Gmail later"); m.sendAt = Date.now() - 1000; tickPendingSends(); }); await wait(400);
  const sent = (await calls("send_mail"))[0];
  same(sent && [sent.subject, sent.sendAt], ["Gmail later", null], "sent at its time, with no server-side schedule");
});

test("opening a message repaints once for its answers, not once per answer (#74)", { fake: true, setup: () => {
  // As live: each answer lands a little after the last.
  window.__delays = { cached_body: 5, message_files: 15, inline_images: 25, sender_verified: 35, unsubscribe_options: 45 };
  window.__unsub = { m3: { oneClick: "https://list.example/u", web: "", mailto: "", mailtoSubject: "" } };
} }, async ({ p }) => {
  await wait(500);
  await p.evaluate(() => { window.__paints = 0; new MutationObserver(() => { window.__paints++; }).observe(document.getElementById("reading"), { childList: true }); });
  await p.click('.row[data-id="m3"]'); await wait(1200);
  const paints = await p.evaluate(() => window.__paints);
  expect(paints <= 2, "the open and one gathered paint (it was 4)", paints);
  const shown = await p.evaluate(() => ({ body: document.querySelector("#reading").textContent.includes("Site plans body"), unsub: !!document.querySelector("#reading [data-unsub], #reading .unsubscribe-bar, #reading .unsub-bar"), files: document.querySelector("#reading").textContent.includes("plan.pdf") }));
  same(shown, { body: true, unsub: true, files: true }, "and every answer is on screen");
});

test("sanitised mail is reused, and settings read on paint stay current (#77)", { fake: true }, async ({ p }) => {
  const r = await p.evaluate(() => {
    let parses = 0;
    const real = window.htmlFor;
    window.htmlFor = s => { parses++; return real(s); };
    const html = '<p>Hello <img src="https://t.example/p.gif"></p>';
    const a = remoteMailHtml(html, false);
    const b = remoteMailHtml(html, false);
    const c = remoteMailHtml(html, true);
    window.htmlFor = real;
    return { parses, same: a.html === b.html && a.blocked === b.blocked, blocked: a.blocked, allowed: !c.blocked };
  });
  same(r, { parses: 2, same: true, blocked: true, allowed: true }, "the same body is sanitised once per picture setting");
  const modes = await p.evaluate(() => {
    const out = [remotePictureMode()];
    localStorage.setItem("mailroom-remote-pictures", "always"); out.push(remotePictureMode());
    localStorage.removeItem("mailroom-remote-pictures"); out.push(remotePictureMode());
    window.dispatchEvent(new StorageEvent("storage", { key: "mailroom-assist-pop" }));
    return out;
  });
  same(modes, ["safe", "always", "safe"], "a change to the setting is seen straight away");
});

// ---------------------------------------------------------------- calendar

test("calendar: new repeating event, edit sends only changes, series and invites", { fake: true, tz: true }, async ({ p, calls, clear }) => {
  await p.evaluate(() => setView("calendar")); await wait(1000);
  await clear();
  await p.evaluate(() => openEventForm({ day: dayFromDate(todayDate()) + 2, start: 600, end: 660 })); await wait(200);
  await p.type("[name=title]", "Glaze test");
  await p.select("[name=repeat]", "weekly");
  await p.click('#event-form button[type="submit"]'); await wait(600);
  const made = (await calls("save_event"))[0];
  expect(made && made.fields.recurrence && made.fields.recurrence.pattern.type === "weekly", "weekly repeat sent", made);
  expect(made && /T10:00:00$/.test(made.fields.start), "local wall-clock start", made && made.fields.start);
  const idOf = t => p.evaluate(t => (events.find(e => e.title === t) || {}).id, t);
  await clear();
  await p.evaluate(id => openEventEditor(id, "timed"), await idOf("Single")); await wait(300);
  await p.$eval("[name=title]", e => { e.value = "Single moved"; });
  await p.click('#event-form button[type="submit"]'); await wait(600);
  const edit = (await calls("save_event"))[0];
  expect(edit && !("notes" in edit.fields) && !("attendees" in edit.fields), "edit sends only what changed", edit);
  await clear();
  p.evaluate(id => openEventEditor(id, "timed"), await idOf("Weekly sync")); await wait(300);
  await p.click('#choose-layer [data-choose="following"]'); await wait(500);
  await p.click('#event-form button[type="submit"]'); await wait(700);
  same((await calls("end_series_before")).map(a => a.masterId), ["ser-1"], "series ended before this one");
  await clear();
  await p.evaluate(id => openEventEditor(id, "timed"), await idOf("Their meeting")); await wait(300);
  expect(await p.$eval("[name=title]", e => e.disabled), "someone else's meeting is read-only");
});

test("calendar: drag moves an event and refuses someone else's", { fake: true, tz: true }, async ({ p, calls, clear }) => {
  // The events are tomorrow, which on a Sunday is next week: show its week.
  await p.evaluate(() => { calFocus = new Date(Date.now() + 86400000); setView("calendar"); calView = "week"; render(); }); await wait(1000);
  const hourPx = await p.evaluate(() => document.querySelector('.daycol[data-slot="time"]').getBoundingClientRect().height / 24);
  const boxOfEvent = t => p.evaluate(t => { const ev = events.find(e => e.title === t); const el = document.querySelector('.event[data-event="' + CSS.escape(ev.id) + '"]'); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.top + 8 }; }, t);
  const drag = async (b, dy) => { await p.mouse.move(b.x, b.y); await p.mouse.down(); for (let i = 1; i <= 6; i++) await p.mouse.move(b.x, b.y + dy * i / 6); await p.mouse.up(); await wait(400); };
  await clear();
  await drag(await boxOfEvent("Single"), hourPx);
  same((await calls("save_event")).map(a => a.fields.start.slice(11)), ["10:00:00"], "moved an hour");
  await clear();
  await drag(await boxOfEvent("Their meeting"), hourPx);
  same((await calls("save_event")).length, 0, "someone else's meeting not moved");
});

test("calendar: Join shows on an online meeting from ten minutes before, opens it without the editor, and drag still works (#136)", { fake: true, tz: true }, async ({ p, calls, clear }) => {
  await p.evaluate(() => { calFocus = new Date(Date.now() + 86400000); setView("calendar"); calView = "week"; render(); }); await wait(1000);
  const url = "https://teams.microsoft.com/l/meetup-join/abc";
  const setClock = (minutesBefore) => p.evaluate((m) => {
    const ev = events.find(e => e.title === "Single");
    const at = eventStart(ev) - m * 60000;
    window.__realNow = window.__realNow || Date.now;
    Date.now = () => at;
    refreshJoinable(); renderCalendar();
  }, minutesBefore);
  await p.evaluate((url) => { events.find(e => e.title === "Single").joinUrl = url; window.__edited = 0; const real = openEventEditor; window.openEventEditor = (...a) => { window.__edited++; return real(...a); }; }, url);
  const joins = () => p.evaluate(() => [...document.querySelectorAll(".event .event-join")].map(j => events.find(e => e.id === j.closest(".event").dataset.event).title));
  await setClock(11);
  same(await joins(), [], "no Join eleven minutes before");
  await setClock(5);
  same(await joins(), ["Single"], "Join five minutes before, on the online meeting only");
  const titleClear = await p.evaluate(() => {
    const block = document.querySelector(".event .event-join").closest(".event");
    const t = block.querySelector("strong").getBoundingClientRect(), j = block.querySelector(".event-join").getBoundingClientRect();
    return j.top >= t.bottom - 0.5 || j.left >= t.right - 0.5;
  });
  expect(titleClear, "Join never covers the title");
  await clear();
  await p.evaluate(() => document.querySelector(".event .event-join").scrollIntoView({ block: "center" }));
  await p.click(".event .event-join"); await wait(300);
  same((await calls("open_link")).map(a => a.url), [url], "the meeting opens through open_link");
  same(await p.evaluate(() => window.__edited), 0, "the editor does not open");
  const hourPx = await p.evaluate(() => document.querySelector('.daycol[data-slot="time"]').getBoundingClientRect().height / 24);
  const b = await p.evaluate(() => { const el = document.querySelector(".event .event-join").closest(".event"); const r = el.getBoundingClientRect(); return { x: r.x + 12, y: r.top + 8 }; });
  await clear();
  await p.mouse.move(b.x, b.y); await p.mouse.down(); for (let i = 1; i <= 6; i++) await p.mouse.move(b.x, b.y + hourPx * i / 6); await p.mouse.up(); await wait(400);
  same((await calls("save_event")).length, 1, "dragging the event still moves it");
  await setClock(-200);
  expect(!(await joins()).includes("Single"), "no Join once it has ended", await joins());
  await p.evaluate((url) => { const ev = events.find(e => e.title === "Single"); ev.day = dayFromDate(new Date(Date.now())); ev.start = 600; ev.end = 660; ev.joinUrl = url; }, url);
  await p.evaluate(() => { const ev = events.find(e => e.title === "Single"); const at = eventStart(ev) - 3 * 60000; Date.now = () => at; selected = null; setView("mail"); render(); });
  await wait(300);
  const empty = await p.evaluate(() => { const j = document.querySelector("#reading .empty-join"); return j ? document.querySelector("#reading .empty-next").textContent : null; });
  expect(empty && empty.startsWith("Next: Single"), "the empty reading pane offers Join beside the next meeting", empty);
  await clear();
  await p.click("#reading .empty-join"); await wait(200);
  same((await calls("open_link")).map(a => a.url), [url], "and it opens the meeting");
  await p.evaluate(() => { Date.now = window.__realNow; });
});

test("calendar search reaches the server: a match outside the loaded range opens on its day (#138)", { fake: true, tz: true, setup: () => {
  const far = new Date(Date.now() + 500 * 86400000); far.setHours(14, 0, 0, 0);
  const end = new Date(far.getTime() + 3600000);
  const z = d => d.toISOString().replace(/\.\d+Z$/, "Z");
  window.__farEvent = { id: "far-1", title: "Board retreat", start: z(far), end: z(end), location: "Lakeside" };
  window.__serverHits = [Object.assign({ calendarId: "AAMkCal1", allDay: false, showAs: "busy", notes: "", organizerName: "", organizerEmail: "", attendees: [], response: "", isOrganizer: true, kind: "singleInstance", seriesMasterId: "" }, window.__farEvent),
    { id: "Single", calendarId: "AAMkCal1", title: "Single board prep", start: z(new Date()), end: z(new Date(Date.now() + 3600000)), allDay: false, kind: "singleInstance" }];
} }, async ({ p, calls }) => {
  await p.evaluate(() => { setView("calendar"); render(); }); await wait(1000);
  same(await p.evaluate(() => events.some(e => e.title === "Board retreat")), false, "the far event is not loaded");
  await p.click("#q"); await p.type("#q", "board"); await wait(100);
  expect(await p.$eval("#q-suggest", b => b.textContent.includes("Searching the server")), "says it is asking the server");
  await wait(700);
  const rows = await p.$$eval("#q-suggest button", bs => bs.map(b => b.textContent.trim()));
  expect(rows.some(r => r.startsWith("Board retreat") && r.includes("Lakeside")), "the server's match is listed", rows);
  expect(rows[rows.length - 1].startsWith("Search mail for"), "the last line searches mail", rows);
  same((await calls("search_events")).map(a => a.text), ["board"], "asked once, after a pause");
  // Arrow keys move through the list; Enter takes the chosen line.
  const at = rows.findIndex(r => r.startsWith("Board retreat"));
  for (let i = 0; i <= at; i++) await p.keyboard.press("ArrowDown");
  same(await p.$eval("#q-suggest button.active", b => b.textContent.trim().slice(0, 13)), "Board retreat", "Down reaches it");
  await p.keyboard.press("Enter"); await wait(1500);
  const opened = await p.evaluate(() => ({ focus: dayFromDate(calFocus), loaded: events.some(e => e.title === "Board retreat"), editor: !!document.querySelector(".event-editor:not([hidden]), #event-editor:not([hidden])") }));
  same(opened.focus, await p.evaluate(() => dayFromDate(new Date(window.__farEvent.start))), "the calendar moved to its day");
  expect(opened.loaded, "its range was synced");
  expect(opened.editor, "and the event is open", opened);
});

test("calendar: drag an all-day chip to another day; Month moves a timed one, keeping its time (#101)", { fake: true, tz: true, setup: () => { window.__allDay = true; } }, async ({ p, calls, clear }) => {
  await p.evaluate(() => { calFocus = new Date(Date.now() + 86400000); setView("calendar"); calView = "week"; render(); }); await wait(1000);
  const dragTo = async (from, to) => {
    const a = await (await p.$(from)).boundingBox();
    const b = await (await p.$(to)).boundingBox();
    await p.mouse.move(a.x + 8, a.y + a.height / 2); await p.mouse.down();
    for (let i = 1; i <= 8; i++) await p.mouse.move(a.x + 8 + (b.x + b.width / 2 - a.x - 8) * i / 8, a.y + a.height / 2 + (b.y + b.height / 2 - a.y - a.height / 2) * i / 8);
    await p.mouse.up(); await wait(500);
  };
  const home = await p.$eval('.chip[data-event="hol-1"]', c => Number(c.closest("[data-day]").dataset.day));
  const other = await p.evaluate(h => [...document.querySelectorAll(".allday-cell[data-day]")].map(c => Number(c.dataset.day)).find(d => d !== h), home);
  await clear();
  await dragTo('.chip[data-event="hol-1"]', `.allday-cell[data-day="${other}"]`);
  const saved = await calls("save_event");
  same(saved.map(a => [a.eventId, a.fields.allDay, a.fields.start, a.fields.end]),
    [["hol-1", true, await p.evaluate(d => isoFromDay(d) + "T00:00:00", other), await p.evaluate(d => isoFromDay(d + 1) + "T00:00:00", other)]], "moved to that day, still all day");
  same((await calls("event_series")).length, 0, "a one-off does not ask about a series");
  // Month: a timed chip keeps its time on the new day.
  await p.evaluate(() => { calView = "month"; render(); }); await wait(600);
  const single = await p.evaluate(() => events.find(e => e.title === "Single" && e.live).id);
  const day = await p.$eval(`.chip[data-event="${single}"]`, c => Number(c.closest("[data-day]").dataset.day));
  const next = await p.evaluate(d => document.querySelector(`.month-day[data-day="${d + 1}"]`) ? d + 1 : d - 1, day);
  await clear();
  await dragTo(`.chip[data-event="${single}"]`, `.month-day[data-day="${next}"]`);
  same((await calls("save_event")).map(a => [a.fields.start, a.fields.end]), [[await p.evaluate(d => isoFromDay(d) + "T09:00:00", next), await p.evaluate(d => isoFromDay(d) + "T10:00:00", next)]], "same hour, the next day");
});

test("calendar: an event over two days moves as a whole; a series occurrence asks this one or all (#101)", { fake: true, tz: true, setup: () => { window.__span = true; } }, async ({ p, calls, clear }) => {
  await p.evaluate(() => { calFocus = new Date(Date.now() + 86400000); setView("calendar"); calView = "week"; render(); }); await wait(1000);
  const hourPx = await p.evaluate(() => document.querySelector('.daycol[data-slot="time"]').getBoundingClientRect().height / 24);
  const boxOf = id => p.evaluate(id => { const el = document.querySelector('.event[data-event="' + CSS.escape(id) + '"]'); el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.top + 8 }; }, id);
  const drag = async (b, dy) => { await p.mouse.move(b.x, b.y); await p.mouse.down(); for (let i = 1; i <= 6; i++) await p.mouse.move(b.x, b.y + dy * i / 6); await p.mouse.up(); await wait(500); };
  const piece = await p.evaluate(() => events.find(e => e.eventId === "span-1" && e.start === 22 * 60).id);
  expect(piece.includes("@"), "the event shows as a piece a day", piece);
  await clear();
  await drag(await boxOf(piece), -hourPx);
  const tomorrow = await p.evaluate(() => isoFromDay(dayFromDate(new Date(Date.now() + 86400000))));
  const after = await p.evaluate(() => isoFromDay(dayFromDate(new Date(Date.now() + 2 * 86400000))));
  same((await calls("save_event")).map(a => [a.eventId, a.fields.start, a.fields.end]), [["span-1", tomorrow + "T21:00:00", after + "T01:00:00"]], "both ends moved an hour earlier");
  // A weekly occurrence: All events moves the series master an hour.
  await clear();
  await drag(await boxOf("occ-1"), hourPx);
  expect(await p.$(".choose-dialog"), "asks this one or the series");
  same(await p.$$eval(".choose-dialog [data-choose]", bs => bs.map(b => b.textContent.trim())), ["This event", "All events in the series"], "the two choices");
  await p.click('.choose-dialog [data-choose="all"]'); await wait(600);
  const series = await calls("save_event");
  same(series.map(a => [a.eventId, a.fields.start, a.fields.end, a.fields.recurrence && a.fields.recurrence.pattern.daysOfWeek]), [["ser-1", "2026-10-01T16:00:00", "2026-10-01T16:30:00", ["thursday"]]], "the series, an hour later, same weekday");
  await clear();
  await drag(await boxOf("occ-1"), hourPx);
  await p.click('.choose-dialog [data-choose="this"]'); await wait(600);
  same((await calls("save_event")).map(a => [a.eventId, a.fields.recurrence]), [["occ-1", undefined]], "This event moves only the occurrence");
  // A weekly series moved a day keeps its weekday in step.
  same(await p.evaluate(() => shiftedRecurrence({ pattern: { type: "weekly", interval: 1, daysOfWeek: ["thursday", "saturday"] }, range: { type: "noEnd", startDate: "2026-10-01" } }, 1)),
    { pattern: { type: "weekly", interval: 1, daysOfWeek: ["friday", "sunday"] }, range: { type: "noEnd", startDate: "2026-10-02" } }, "Thursday and Saturday become Friday and Sunday");
  same(await p.evaluate(() => shiftedRecurrence({ pattern: { type: "absoluteMonthly", dayOfMonth: 3 }, range: {} }, 1)), undefined, "a monthly series is left to the editor");
});

test("Teams' underscore lines in event notes are one thin rule, and notes of only rules are none", { fake: true, tz: true }, async ({ p }) => {
  await p.evaluate(() => { calFocus = new Date(Date.now() + 86400000); setView("calendar"); calView = "week"; render(); }); await wait(1000);
  const line = "_".repeat(80);
  const body = await p.evaluate((line) => {
    events.find(e => e.title === "Single").notes = `Microsoft Teams meeting\r\n\r\n${line}\r\n\r\nJoin: https://teams.microsoft.com/l/meetup-join/x\r\n\r\n${line}`;
    events.find(e => e.title === "Their meeting").notes = `\n${line}\n\n${line}\n`;
    render();
    const of = t => document.querySelector('.event[data-event="' + CSS.escape(events.find(e => e.title === t).id) + '"] .event-body');
    const one = of("Single");
    return { rules: one.querySelectorAll(".note-rule").length, text: one.innerText, link: !!one.querySelector("a.note-link"), empty: of("Their meeting") };
  }, line);
  same(body.rules, 2, "each underscore line is a rule");
  expect(!body.text.includes("___"), "no underscores left", body.text);
  same(body.text.trim().split("\n").filter(Boolean), ["Microsoft Teams meeting", "Join: https://teams.microsoft.com/l/meetup-join/x"], "no blank lines around the rules");
  expect(body.link, "the join link still works");
  same(body.empty, null, "notes of only rules show nothing");
});

test("event notes end on a whole line at every hour height (#139)", { fake: true, tz: true }, async ({ p }) => {
  await p.evaluate(() => { calFocus = new Date(Date.now() + 86400000); setView("calendar"); calView = "week"; render(); }); await wait(1000);
  await p.evaluate(() => {
    events.find(e => e.title === "Single").notes = Array.from({ length: 30 }, (_, i) => "Agenda line " + (i + 1) + " with a few words").join("\n");
    render();
  }); await wait(300);
  const cutLines = () => p.evaluate(() => {
    const body = document.querySelector('.event[data-event="' + CSS.escape(events.find(e => e.title === "Single").id) + '"] .event-body');
    if (!body || getComputedStyle(body).display === "none") return { shown: false };
    const box = body.getBoundingClientRect();
    const block = body.closest(".event").getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(body);
    const straddle = [...range.getClientRects()].filter(r => r.height > 0 && r.top < box.bottom - 0.5 && r.bottom > box.bottom + 0.5).length;
    return { shown: true, straddle, inside: box.bottom <= block.bottom + 0.5, lines: Math.round(box.height / 16) };
  });
  const seen = [];
  for (const h of [600, 700, 820, 1000, 1300]) {
    await p.setViewport({ width: 1400, height: h }); await wait(400);
    const got = await cutLines();
    seen.push(got.shown ? got.lines : 0);
    if (got.shown) {
      same(got.straddle, 0, "no line cut through at height " + h);
      expect(got.inside, "the notes stay inside the block at height " + h);
    }
  }
  expect(seen.some(n => n > 0), "the notes show at some height", seen);
});

test("an all-day event fills its day", { fake: true, tz: true, setup: () => { window.__allDay = true; } }, async ({ p }) => {
  await p.evaluate(() => { calFocus = new Date(Date.now() + 86400000); setView("calendar"); calView = "week"; render(); }); await wait(1000);
  const [chip, cell] = await p.evaluate(() => { const c = document.querySelector('.chip[data-event="hol-1"]'); return [c.getBoundingClientRect().width, c.parentElement.clientWidth]; });
  expect(chip >= cell - 10, "chip as wide as the day", chip + " of " + cell);
});

test("all-day chips stay under their day, however long the title", { fake: true, tz: true }, async ({ p }) => {
  await p.evaluate(() => {
    calFocus = new Date(); setView("calendar"); calView = "week"; render();
    const first = Math.min(...[...document.querySelectorAll(".allday-cell")].map(c => +c.dataset.day));
    allday.push({ id: "long-1", account: "timberworks", calendar: "cal-timberworks-site", day: first + 1, title: "A really rather long all-day event title that will not fit", showAs: "free" });
    allday.push({ id: "short-1", account: "timberworks", calendar: "cal-timberworks-site", day: first + 2, title: "Short", showAs: "free" });
    render();
  }); await wait(500);
  const cols = await p.evaluate(() => {
    const heads = [...document.querySelectorAll(".cal-sticky .week .dayhead")].slice(1).map(h => h.getBoundingClientRect());
    const cells = [...document.querySelectorAll(".allday-cell")].map(c => c.getBoundingClientRect());
    const days = [...document.querySelectorAll(".daycol")].map(c => c.getBoundingClientRect());
    return heads.map((h, i) => [Math.round(h.left), Math.round(cells[i].left), Math.round(days[i].left), Math.round(h.width), Math.round(cells[i].width)]);
  });
  cols.forEach(([head, cell, day, hw, cw], i) => {
    expect(Math.abs(head - cell) <= 1 && Math.abs(head - day) <= 1, "day " + i + " lines up across header, all-day row and grid", [head, cell, day]);
    expect(Math.abs(hw - cw) <= 1, "day " + i + " all-day cell as wide as its header", [hw, cw]);
  });
});

test("meeting reminders, Teams and Join", { fake: true, tz: true }, async ({ p, calls, clear }) => {
  await p.evaluate(() => setView("calendar")); await wait(1000);
  await clear();
  await p.evaluate(() => checkReminders()); await wait(200);
  await p.evaluate(() => checkReminders()); await wait(200);
  const n = await calls("notify_mail");
  same(n.map(a => [a.title, a.messageId.startsWith("event:")]), [["Standup soon", true]], "one reminder for the meeting");
  expect(/Teams meeting/.test(n[0].body), "reminder mentions Teams", n[0].body);
  await p.evaluate(() => openEventEditor("soon-1", "timed")); await wait(300);
  expect(await p.$("#event-join"), "Join button on a Teams meeting");
  same(await p.$eval("[name=reminder]", e => e.value), "15", "reminder shown");
  await p.evaluate(() => closePop());
  await clear();
  await p.evaluate(() => openEventForm({ day: dayFromDate(todayDate()) + 3, start: 540, end: 600 })); await wait(200);
  await p.type("[name=title]", "Planning");
  await p.select("[name=reminder]", "30");
  same(await p.$eval("[name=teams]", e => [getComputedStyle(e).appearance, e.offsetWidth]), ["none", 36], "Teams is a switch, like All day");
  await p.click("[name=teams]");
  await p.click('#event-form button[type="submit"]'); await wait(600);
  same((await calls("save_event")).map(a => [a.fields.reminder, a.fields.teams]), [[30, true]], "reminder and Teams sent");
});

test("Join for Zoom, Google Meet, Teams and Webex", { fake: true, tz: true }, async ({ p }) => {
  const kinds = await p.evaluate(() => [
    meetingLink({ where: "https://us02web.zoom.us/j/8812345?pwd=abc" }),
    meetingLink({ notes: "Join: https://meet.google.com/abc-defg-hij." }),
    meetingLink({ joinUrl: "https://teams.microsoft.com/l/meetup-join/x" }),
    meetingLink({ notes: "https://acme.webex.com/meet/jon" }),
    meetingLink({ notes: "See https://example.com/agenda" })
  ].map(l => l && [l.provider, l.url]));
  same(kinds, [["Zoom", "https://us02web.zoom.us/j/8812345?pwd=abc"], ["Google Meet", "https://meet.google.com/abc-defg-hij"], ["Teams", "https://teams.microsoft.com/l/meetup-join/x"], ["Webex", "https://acme.webex.com/meet/jon"], null], "links found");
  await p.evaluate(() => setView("calendar")); await wait(1000);
  await p.evaluate(() => openEventEditor("zoom-1", "timed")); await wait(300);
  same(await p.$eval("#event-join", e => e.textContent), "Join Zoom", "Zoom button");
  await p.evaluate(() => { closePop(); openEventEditor("meet-1", "timed"); }); await wait(300);
  same(await p.$eval("#event-join", e => e.textContent), "Join Google Meet", "Meet button");
});

// ---------------------------------------------------------------- people, folders, settings

test("contacts edit and delete; folders mark read and empty", { fake: true }, async ({ p, calls, rightClick }) => {
  await p.evaluate(() => { setView("people"); selectedContact = "c1"; render(); window.__calls = []; }); await wait(300);
  await p.click("#edit-contact"); await wait(150);
  await p.$eval("[name=title]", e => { e.value = "Engineer"; });
  await p.click("#contact-form [type=submit]"); await wait(300);
  same((await calls("update_contact")).map(a => a.title), ["Engineer"], "contact saved");
  await p.evaluate(() => setView("mail")); await wait(300);
  await rightClick('#folder-nav [data-acct]:not([data-acct="all"])[data-box="trash"]');
  await p.click('#row-menu [data-act="empty"]'); await wait(200);
  await p.click('#choose-layer [data-choose="yes"]'); await wait(400);
  same((await calls("empty_folder")).map(a => a.folderId), ["f-bin"], "Deleted Items emptied");
});

test("categories, snooze and automatic replies", { fake: true }, async ({ p, calls, clear, rightClick }) => {
  await clear();
  await rightClick('.row[data-id="m1"]');
  await p.click('#row-menu [data-act="categorize"]'); await wait(300);
  await p.click('#row-menu [data-cat="Jobs"]'); await wait(400);
  same((await calls("set_categories")).map(a => a.categories), [["Jobs"]], "category set");
  await clear();
  await p.click('.row[data-id="m2"]'); await wait(300);
  await p.click("#snooze"); await wait(200);
  await p.click('[data-preset="0"]'); await wait(700);
  same((await calls("apply_mail")).filter(a => a.kind === "move").map(a => a.destination), ["f-snoozed"], "snoozed");
  await clear();
  await p.evaluate(() => { const l = loadSnoozes(); l.forEach(s => s.until = 0); saveSnoozes(l); return checkSnoozes(); }); await wait(400);
  same((await calls("apply_mail")).map(a => a.kind), ["inbox", "unread"], "snooze returns unread");
  await p.evaluate(() => showSettings("auto-reply")); await wait(400);
  await p.click('[name=status][value="alwaysEnabled"]');
  await clear();
  await p.click("#auto-save"); await wait(400);
  same((await calls("set_auto_reply")).map(a => a.reply.status), ["alwaysEnabled"], "automatic replies on");
});

test("the Categories heading collapses and stays collapsed", { fake: true }, async ({ p }) => {
  const head = '[data-section^="cats:"]';
  await p.waitForSelector(head, { timeout: 3000 });
  const shown = () => p.$$eval("#folders [data-cat-name]", bs => bs.map(b => b.dataset.catName));
  same(await shown(), ["Jobs", "Urgent"], "categories listed");
  await p.click(head); await wait(200);
  same(await shown(), [], "categories hidden");
  same(await p.$eval(head, b => b.getAttribute("aria-expanded")), "false", "heading says collapsed");
  const saved = await p.evaluate(() => JSON.parse(localStorage.getItem("mailroom-mail-collapse") || "{}").sections || []);
  expect(saved.some(k => k.startsWith("cats:")), "collapse remembered", saved);
  await p.click(head); await wait(200);
  same(await shown(), ["Jobs", "Urgent"], "categories back");
});

test("Report junk and Not junk: the server blocks or unblocks the sender, from the toolbar, the row menu and the selection", { fake: true, setup: () => {
  window.__folders.push({ id: "f-junk", parentId: "", name: "Junk Email", key: "f-junk", unread: 0, total: 0, depth: 0 });
} }, async ({ p, calls, clear, rightClick, boxOf }) => {
  await clear();
  await p.click('.row[data-id="m1"]'); await wait(400);
  await p.click("#report-junk"); await wait(500);
  same((await calls("apply_mail")).filter(a => a.kind !== "read").map(a => [a.kind, a.messageIds, a.destination]), [["junk", ["m1"], "f-junk"]], "toolbar: Report junk");
  same(await boxOf("m1"), "f-junk", "the message is in Junk");
  expect((await p.$eval("#toast", t => t.textContent)).includes("Reported as junk"), "toast says so");
  // Undo back to the Inbox is Not junk, so the sender comes off the list.
  await clear();
  await p.click("#toast button"); await wait(500);
  same((await calls("apply_mail")).filter(a => a.kind !== "read").map(a => a.kind), ["notjunk"], "Undo unblocks the sender");
  same(await boxOf("m1"), "inbox", "and the message is back");
  // The row menu.
  await clear();
  await rightClick('.row[data-id="m2"]');
  expect((await p.$$eval("#row-menu button", b => b.map(x => x.textContent.trim()))).includes("Report junk"), "row menu offers Report junk");
  await p.click('#row-menu [data-act="report-junk"]'); await wait(500);
  same((await calls("apply_mail")).filter(a => a.kind !== "read").map(a => a.kind), ["junk"], "row menu: Report junk");
  // In Junk: Not junk, in place of Move to inbox.
  await p.evaluate(() => { box = "f-junk"; selected = "m2"; render(); }); await wait(400);
  expect(await p.$("#not-junk"), "Junk shows Not junk");
  expect(!(await p.$("#to-inbox")) && !(await p.$("#report-junk")), "not Move to inbox or Report junk");
  await clear();
  await p.click("#not-junk"); await wait(500);
  same((await calls("apply_mail")).filter(a => a.kind !== "read").map(a => a.kind), ["notjunk"], "Not junk");
  same(await boxOf("m2"), "inbox", "back in the Inbox");
  // The selection bar.
  await p.evaluate(() => { box = "inbox"; selected = null; render(); }); await wait(300);
  await p.evaluate(() => { ["m1", "m3"].forEach(id => picked.add(conversations().find(c => c.messages.some(m => m.id === id)).id)); render(); }); await wait(300);
  await clear();
  await p.click('[data-bulk="report-junk"]'); await wait(500);
  same((await calls("apply_mail")).filter(a => a.kind !== "read").map(a => [a.kind, [...a.messageIds].sort()]), [["junk", ["m1", "m3"]]], "selection: Report junk, both in one call");
});

test("rules: create from a message, list, turn off", { fake: true }, async ({ p, calls, clear, rightClick }) => {
  await rightClick('.row[data-id="m1"]');
  await p.click('#row-menu [data-act="rule"]'); await wait(500);
  same(await p.$eval("#rule-form [name=from]", e => e.value), "ada@example.org", "sender prefilled");
  await p.select("#rule-form [name=moveTo]", "f-jobs");
  await clear();
  await p.click("#rule-save"); await wait(400);
  const saved = (await calls("save_rule"))[0];
  expect(saved && saved.rule.moveTo === "f-jobs" && saved.rule.from[0] === "ada@example.org", "rule saved", saved);
  expect((await p.$eval("#rule-list", e => e.textContent)).includes("move to Jobs"), "listed with a summary");
  await clear();
  await p.click("[data-rule-on]"); await wait(300);
  same((await calls("save_rule")).map(a => a.rule.enabled), [false], "turned off");
});

test("spelling: on by default, pick a language, turn it off", { fake: true }, async ({ p, calls, clear }) => {
  same((await calls("set_spelling")).map(a => a.enabled), [true], "turned on at start");
  await clear();
  await p.evaluate(() => showSettings("mail")); await wait(500);
  same(await p.$$eval("#spell-lang option", o => o.map(x => x.textContent)), ["English (Antigua & Barbuda)", "English (Canada)", "English (United Kingdom)", "English (United States)"], "installed dictionaries, by name");
  same(await p.$eval("#spell-lang", e => e.value), "en_US", "the current language is chosen");
  await p.select("#spell-lang", "en_GB"); await wait(200);
  same((await calls("set_spelling")).map(a => [a.enabled, a.languages]), [[true, ["en_GB"]]], "language sent");
  await clear();
  await p.click("#spell-on"); await wait(200);
  same((await calls("set_spelling")).map(a => [a.enabled, a.languages]), [[false, ["en_GB"]]], "turned off");
  same(await p.evaluate(() => JSON.parse(localStorage.getItem("mailroom-spelling"))), { enabled: false, beforeSend: true, languages: ["en_GB"] }, "remembered");
  expect(await p.$eval("#spell-lang", e => e.disabled), "language greyed while off");
  expect(await p.$eval("#compose-body, body", () => !document.querySelector('#compose-body[spellcheck="false"]')), "compose is not opted out");
});

test("spelling: says how to get a dictionary when there is none", { fake: true, setup: () => { window.__dicts = []; } }, async ({ p }) => {
  await p.evaluate(() => showSettings("mail")); await wait(500);
  expect((await p.$eval("#spell-note", e => e.textContent)).includes("hunspell-en_ca"), "install hint");
  expect(await p.$eval("#spell-lang", e => e.disabled), "no language to pick");
});

test("importance and a read receipt: set when writing, shown when read", { fake: true, setup: () => {
  window.__inbox.push({ id: "imp", thread: "conv-imp", subject: "Server down", fromName: "Ops", fromEmail: "ops@example.org", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Now", bodyHtml: "<p>Now</p>", unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [], importance: "high" });
} }, async ({ p, calls, clear }) => {
  expect(await p.$('.row[data-id="imp"] .imp-high'), "a red ! in the list");
  expect(!(await p.$('.row[data-id="m1"] .imp-high')), "only on that message");
  await p.click('.row[data-id="imp"]'); await wait(600);
  expect((await p.$eval("#reading", e => e.textContent)).includes("sent with High importance"), "noted in the reading pane");
  await p.evaluate(() => { sendDelay = 0; });
  await p.click("#compose"); await wait(300);
  await p.click("#compose-to"); await p.keyboard.type("eve@example.org");
  await p.click("#send-options"); await wait(100);
  await p.click('[data-opt="high"]'); await p.click('[data-opt="receipt"]'); await wait(100);
  same(await p.$eval(".importance-tag", e => e.textContent), "High importance · Read receipt", "shown by the subject");
  await clear();
  await p.click("#send-options"); await wait(100);
  same(await p.$eval(".send-options-menu", e => e.hidden), true, "the menu closes");
  await p.click('#compose-form button[type="submit"]'); await wait(600);
  same((await calls("send_mail")).map(a => [a.importance, a.readReceipt]), [["high", true]], "sent with them");
});

test("follow-up: reminds when nobody answers, not when someone has", { fake: true }, async ({ p, calls, clear }) => {
  // Only follow-up notifications: the fake calendar's "Standup soon" meeting
  // reminder fires on its own timer and can land in any window (CI 2026-10-28).
  const followUpNotes = async () => (await calls("notify_mail")).filter(n => String(n.messageId || "").startsWith("followup:"));
  await p.evaluate(() => { sendDelay = 0; localStorage.removeItem("mailroom-followups"); });
  await p.click("#compose"); await wait(300);
  await p.click("#compose-to"); await p.keyboard.type("eve@example.org");
  await p.click("#compose-subject"); await p.keyboard.type("Quote for the kiln");
  await p.click("#send-options"); await wait(100);
  await p.click('[data-opt="followup"]'); await wait(300);
  await p.click('[data-preset="0"]'); await wait(300);
  expect((await p.$eval(".importance-tag", e => e.textContent)).startsWith("Follow up "), "shown by the subject");
  await p.click('#compose-form button[type="submit"]'); await wait(700);
  let list = await p.evaluate(() => JSON.parse(localStorage.getItem("mailroom-followups") || "[]"));
  same(list.map(f => [f.subject, f.to]), [["Quote for the kiln", ["eve@example.org"]]], "watched once sent");
  expect(list[0].due > Date.now() + 3600000, "due when picked");
  await clear();
  await p.evaluate(() => checkFollowUps()); await wait(300);
  same(await calls("search_mail"), [], "not due: the server is not asked");
  // Due, and nobody has answered.
  await p.evaluate(() => { const l = loadFollowUps(); l[0].due = Date.now() - 1000; saveFollowUps(l); window.__search = []; });
  await p.evaluate(() => checkFollowUps()); await wait(300);
  same((await followUpNotes()).length, 1, "a notification");
  expect((await p.$eval("#followup-bar", e => e.hidden ? "" : e.textContent)).includes("Quote for the kiln"), "the bar names it");
  await clear();
  await p.evaluate(() => checkFollowUps()); await wait(300);
  same(await followUpNotes(), [], "only once");
  await p.click("[data-followup-open]"); await wait(400);
  same(await p.$eval("#q", e => e.value), "Quote for the kiln", "Open searches for it");
  await p.click("[data-followup-dismiss]"); await wait(200);
  same(await p.$eval("#followup-bar", e => e.hidden), true, "Dismiss clears it");
  same(await p.evaluate(() => loadFollowUps().length), 0, "and forgets it");
  // Another, answered on the server by the time it is due.
  await p.evaluate(() => {
    saveFollowUps([{ id: "out-x", account: Object.keys(accounts)[0], subject: "Glaze order", to: ["eve@example.org"], thread: "out-x", sentAt: Date.now() - 86400000, due: Date.now() - 1000, shown: 0 }]);
    window.__search = [{ id: "r1", thread: "conv-r1", subject: "RE: Glaze order", fromName: "Eve", fromEmail: "Eve@example.org", received: new Date().toISOString(), preview: "", bodyHtml: "", unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [], parentFolderId: "inbox" }];
  });
  await clear();
  await p.evaluate(() => checkFollowUps()); await wait(300);
  same(await followUpNotes(), [], "answered: no reminder");
  same(await p.evaluate(() => loadFollowUps().length), 0, "and no longer watched");
});

test("Events filter shows only meeting invites", { fake: true, setup: () => {
  window.__inbox.push({ id: "inv", thread: "conv-inv", subject: "Kiln review", fromName: "Maya", fromEmail: "maya@example.org", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Invite", bodyHtml: "<p>Invite</p>", unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [], invite: true });
} }, async ({ p }) => {
  await p.select("#mail-filter", "events"); await wait(400);
  same(await p.$$eval(".row[data-id]", r => r.map(x => x.dataset.id)), ["inv"], "only the invite");
});

test("Both shows work and personal on one calendar", { fake: false }, async ({ p }) => {
  await p.evaluate(() => { setView("calendar"); calView = "week"; calFocus = new Date(2026, 9, 15); calendarBoth = false; render(); });
  await wait(300);
  same(await p.$('[data-event="dentist"]'), null, "Personal stays off the Work calendar");
  expect(!(await p.evaluate(() => calendarSelectOptions(""))).includes("cal-personal"), "a new event stays on Work");
  expect(await p.$('[data-set-calendar="both"]'), "Both is on the calendar switch");
  same(await p.$('[data-set-calendar="both"]') && await p.evaluate(() => document.querySelector("[data-set-profile='work']").getAttribute("aria-pressed")), "true", "Work is the calendar in view");
  await p.click('[data-set-calendar="both"]'); await wait(300);
  expect(await p.$('[data-event="dentist"]'), "Dentist joins the week");
  expect(await p.$('[data-event="stand"]'), "Standup stays");
  expect(await p.$('[data-cal="cal-personal"]'), "the Personal calendar is listed");
  expect((await p.evaluate(() => calendarSelectOptions(""))).includes("cal-personal"), "a new event can go on Personal");
  same(await p.evaluate(() => localStorage.getItem("mailroom-calendar-both")), "1", "the choice is remembered");
  await p.evaluate(() => setView("mail")); await wait(200);
  expect(!(await p.$('[data-set-calendar="both"]')), "mail keeps Work and Personal");
  same(await p.evaluate(() => document.querySelector("[data-set-profile='work']").getAttribute("aria-pressed")), "true", "mail stays on Work");
  expect(!(await p.evaluate(() => [...document.querySelectorAll("#rows .subject")].some(s => s.textContent.includes("Tickets for Saturday")))), "Personal mail stays out of Work");
  await p.evaluate(() => setView("calendar")); await wait(200);
  expect(await p.$('[data-event="dentist"]'), "Both is still on");
  await p.click('[data-set-profile="work"]'); await wait(200);
  same(await p.$('[data-event="dentist"]'), null, "Work hides Personal again");
  same(await p.evaluate(() => calendarBoth), false, "Both is off");
});

test("show more only folds the calendar list", { fake: false }, async ({ p }) => {
  await p.evaluate(() => { setView("calendar"); calView = "week"; calFocus = new Date(2026, 9, 15); render(); });
  await wait(400);
  same(await p.$('[data-cal="cal-timberworks-site"]'), null, "Site waits behind Show more");
  expect(await p.$('[data-event="offsite"]'), "Showroom install stays on the grid");
  same(await p.evaluate(() => hiddenCal.has("cal-timberworks-site")), false, "the calendar stays selected");
  await p.click("#show-all-cals"); await wait(200);
  expect(await p.$('[data-cal="cal-timberworks-site"]'), "Show more lists Site");
  same(await p.$eval("#show-all-cals", e => e.textContent), "Show less", "the control now folds the list");
  same(await p.evaluate(() => hiddenCal.has("cal-timberworks-site")), false, "opening the list does not change what is shown");
  await p.click("#show-all-cals"); await wait(200);
  same(await p.$('[data-cal="cal-timberworks-site"]'), null, "Show less folds the list again");
  expect(await p.$('[data-event="offsite"]'), "the event is still on the grid");
});

test("a calendar shared to read stays read-only", { fake: true, setup: () => { window.__sharedCal = true; } }, async ({ p, calls, clear }) => {
  // The event is tomorrow, which may be a weekend: show that whole week.
  await p.evaluate(() => { calView = "week"; calFocus = new Date(Date.now() + 86400000); setView("calendar"); }); await wait(1200);
  const ev = await p.$('.event[data-event="shared-1"]');
  expect(ev, "its event shows while the list is folded");
  if (!(await p.$('[data-cal="AAMkShared"]'))) {
    await p.click("#show-all-cals"); await wait(200);
  }
  expect(await p.$('[data-cal="AAMkShared"] .cal-ro'), "marked read-only in the list");
  expect((await p.$eval("#folder-nav", e => e.textContent)).includes("Shared calendars"), "grouped with shared calendars");
  // Clear of the sticky day header whatever the hour (the grid scrolls to now).
  await ev.evaluate(el => el.scrollIntoView({ block: "center" }));
  await clear();
  const box = await ev.boundingBox();
  await p.mouse.move(box.x + 10, box.y + 5); await p.mouse.down(); await p.mouse.move(box.x + 10, box.y + 120, { steps: 6 }); await p.mouse.up(); await wait(500);
  same(await calls("save_event"), [], "dragging does not move it");
  same(await p.$eval("#pop-root", e => e.textContent.trim()), "", "nor start a new event");
  await p.$eval('.event[data-event="shared-1"]', el => el.scrollIntoView({ block: "center" }));
  await p.click('.event[data-event="shared-1"]'); await wait(500);
  expect((await p.$eval("#pop-root", e => e.textContent)).includes("shared with you to read"), "the editor says why", await p.evaluate(() => document.querySelector("#pop-root").textContent.replace(/\s+/g, " ").slice(0, 300)));
  expect(await p.$eval('#pop-root [name="title"]', e => e.disabled), "fields are locked");
  await p.evaluate(() => closePop());
  const options = await p.evaluate(() => calendarSelectOptions(""));
  expect(!options.includes("AAMkShared"), "not offered for new events");
});

test("Unsubscribe from a newsletter, by one-click or the sender's page", { fake: true, setup: () => {
  window.__unsub = { m1: { oneClick: "https://news.example.org/u", web: "https://news.example.org/u", mailto: "", mailtoSubject: "" }, m2: { oneClick: "", web: "https://news.example.org/page", mailto: "", mailtoSubject: "" } };
} }, async ({ p, calls, clear }) => {
  await p.click('.row[data-id="m1"]'); await wait(700);
  expect(await p.$('[data-unsubscribe="m1"]'), "offered");
  await clear();
  await p.click('[data-unsubscribe="m1"]'); await wait(200);
  await p.click('[data-choose="go"]'); await wait(400);
  same((await calls("unsubscribe")).map(a => a.messageId), ["m1"], "asked the backend");
  expect((await p.$eval("#toast", e => e.textContent)).includes("Unsubscribed"), "confirmed");
  same(await p.$('[data-unsubscribe="m1"]'), null, "bar gone");
  await p.click('.row[data-id="m2"]'); await wait(700);
  await clear();
  await p.click('[data-unsubscribe="m2"]'); await wait(200);
  await p.click('[data-choose="go"]'); await wait(400);
  same((await calls("open_link")).map(a => a.url), ["https://news.example.org/page"], "the page opens");
  await p.click('.row[data-id="m3"]'); await wait(700);
  same(await p.$('[data-unsubscribe="m3"]'), null, "not offered without headers");
});

test("spelling is checked before sending", { fake: true, setup: () => {
  window.__misspelt = [{ word: "teh", suggestions: ["the", "tech"] }, { word: "Wagstaffe", suggestions: [] }];
} }, async ({ p, calls, clear }) => {
  await p.evaluate(() => { sendDelay = 0; });
  await p.click("#compose"); await wait(300);
  await p.click("#compose-to"); await p.keyboard.type("wagstaffe@example.org");
  await p.click("#compose-body"); await p.keyboard.type("Hi Wagstaffe, teh kiln is ready.");
  await clear();
  await p.click('#compose-form button[type="submit"]'); await wait(500);
  const said = await p.$eval(".choose-dialog", e => e.textContent);
  expect(said.includes("1 word may be misspelt") && said.includes("teh → the (or tech)"), "names the word and the fix, not the recipient", said);
  same(await p.$$eval(".choose-list button", b => b.map(x => x.textContent)), ["Fix and send", "Go back and edit", "Send anyway"], "the three choices");
  same((await calls("check_spelling")).length, 1, "checked once");
  same(await calls("send_mail"), [], "not sent yet");
  await p.click('[data-choose="edit"]'); await wait(300);
  same(await calls("send_mail"), [], "Go back keeps it");
  expect((await p.$eval("#compose-body", e => e.textContent)).includes("teh kiln"), "the word is still there");
  await p.click('#compose-form button[type="submit"]'); await wait(500);
  await p.click('[data-choose="send"]'); await wait(600);
  const sent = (await calls("send_mail"))[0];
  same(sent ? 1 : 0, 1, "Send anyway sends");
  expect(String(sent.bodyHtml).includes("teh kiln"), "sent with the word as typed", sent && sent.bodyHtml);
});

test("spelling: Fix and send writes the suggestion, then sends", { fake: true, setup: () => {
  window.__misspelt = [{ word: "Teh", suggestions: ["the"] }, { word: "recieve", suggestions: ["receive"] }, { word: "teh", suggestions: ["the", "tech"] }];
} }, async ({ p, calls }) => {
  await p.evaluate(() => { sendDelay = 0; });
  await p.click("#compose"); await wait(300);
  await p.click("#compose-to"); await p.keyboard.type("eve@example.org");
  await p.click("#compose-subject"); await p.keyboard.type("Teh kiln");
  await p.click("#compose-body"); await p.keyboard.type("Please recieve teh crate. teeth stay. mail me@teh.example.");
  await p.click('#compose-form button[type="submit"]'); await wait(500);
  await p.click('[data-choose="fix-send"]'); await wait(700);
  const sent = (await calls("send_mail"))[0];
  expect(sent && sent.subject === "The kiln", "the subject is corrected, keeping the capital", sent && sent.subject);
  const body = String(sent && sent.bodyHtml || "");
  expect(body.includes("Please receive the crate."), "the message uses the suggestions", body);
  expect(body.includes("teeth stay."), "a longer word is left alone", body);
  expect(body.includes("me@teh.example"), "an address is left alone", body);
});

test("a reply you send joins its conversation; the reply has its own Attach", { fake: true }, async ({ p, calls, clear }) => {
  await p.evaluate(() => { sendDelay = 0; });
  await p.click('.row[data-id="m3"]'); await wait(700);
  expect(await p.$("#thread-files"), "the thread's paperclip while reading");
  await p.click("#reply"); await wait(500);
  same(await p.$("#thread-files"), null, "hidden while you reply");
  expect(await p.$('#compose-form #add-file'), "Attach in the reply");
  await p.click("#compose-body"); await p.keyboard.type("Thanks, got it.");
  await clear();
  await p.click('#compose-form button[type="submit"]'); await wait(900);
  same((await calls("send_mail")).length, 1, "sent");
  await p.click('.row[data-id="m3"]'); await wait(900);
  const r = await p.evaluate(() => ({ cards: document.querySelectorAll("#reading .thread-card").length, text: document.querySelector("#reading").textContent }));
  expect(r.cards === 2 && r.text.includes("Thanks, got it."), "the sent reply shows in the thread", r.cards);
  same((await calls("conversation_mail")).length, 1, "and Sent Items is asked again after sending");
});

test("fresh install: the client ID comes first, then sign-in says it is loading", { fake: true, setup: () => { window.__fresh = true; window.__slowSync = 1500; } }, async ({ p, calls }) => {
  await wait(400);
  expect(await p.$("#add-account-popup #first-client-id"), "asked for the client ID in Add account");
  await p.type('#add-account-popup [name="email"]', "jon@example.com");
  await p.click('#add-account-popup [type="submit"]'); await wait(200);
  expect((await p.$eval("#account-error", e => e.textContent)).includes("client ID"), "can't skip it");
  same(await calls("sign_in"), [], "no sign-in without it");
  await p.type("#first-client-id", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  await p.click('#add-account-popup [type="submit"]'); await wait(400);
  same((await calls("save_client_id")).map(a => a.id), ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"], "saved first");
  same((await calls("sign_in")).length, 1, "then signs in");
  same(await p.$eval('#add-account-popup [type="submit"]', e => e.textContent), "Signed in. Loading your mail…", "says what it is doing");
  await wait(1800);
  same(await p.$("#add-account-popup"), null, "closes when the mail is in");
});

test("a long sync shows in a status line, not over the mail", { fake: true, setup: () => { window.__slowSync = 2500; } }, async ({ p }) => {
  await wait(500);
  const during = await p.evaluate(() => {
    const note = document.getElementById("sync-note");
    if (!note) return null;
    const n = note.getBoundingClientRect(), f = document.getElementById("folders").getBoundingClientRect();
    const list = document.querySelector(".list").getBoundingClientRect();
    const middle = document.elementFromPoint(list.left + list.width / 2, list.top + list.height / 2);
    return { text: note.textContent, inPane: n.left >= f.left - 1 && n.right <= f.right + 1, atFoot: Math.abs(n.bottom - window.innerHeight) < 2, coversList: note.contains(middle) };
  });
  expect(during, "the sync status shows");
  expect(during.text.includes("Syncing"), "says it is syncing", during.text);
  expect(during.inPane && during.atFoot, "at the foot of the folder pane", during);
  same(during.coversList, false, "the message list is not covered");
  await p.click("#hide-folders"); await wait(200);
  const pill = await p.$eval("#sync-note", e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left < 120; });
  expect(pill, "still shows, bottom left, with the folders hidden");
  await p.evaluate(() => setFoldersOpen(true)); await wait(2800);
  same(await p.$("#sync-note"), null, "gone when the sync is done");
});

test("the list title has the top row to itself, so an account's inbox name fits", { fake: true }, async ({ p }) => {
  await wait(800);
  await p.evaluate(() => { accounts.jon.name = "Maplehill"; focusedInbox = true; document.documentElement.style.setProperty("--list-width", "280px"); });
  for (const name of ["inbox", "sent"]) {
    await p.evaluate(b => { account = "jon"; box = b; render(); }, name); await wait(300);
    const r = await p.$eval("#list-title", e => ({ text: e.textContent, cut: e.scrollWidth > e.clientWidth + 1, title: e.title }));
    same(r.cut, false, "not cut short: " + r.text);
    if (name === "inbox") same(r.text, "Maplehill Inbox", "the account's name and the folder's");
    same(r.title, r.text, "and the full name is its tooltip");
  }
  const rows = await p.evaluate(() => {
    const top = el => Math.round(document.querySelector(el).getBoundingClientRect().top);
    return { title: top("#list-title"), check: top("#check-mail"), filter: top(".list-filter") };
  });
  expect(rows.filter > rows.title && Math.abs(rows.check - rows.title) < 12, "Check mail beside the title, the filter below", rows);
});

test("a fresh Gmail inbox fills in batch by batch, counting in the status line", { fake: true, setup: () => {
  const one = (i) => ({ id: "b" + i, subject: "Backfilled " + i, fromName: "Old Sender", fromEmail: "old" + i + "@example.com", received: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), preview: "older mail", bodyHtml: "", unread: false, flagged: false, attached: false });
  window.__backfill = [[0, 1, 2, 3].map(one), [4, 5, 6, 7].map(one)];
} }, async ({ p, calls }) => {
  const subjects = () => p.evaluate(() => [...document.querySelectorAll("#rows .row")].map(r => r.textContent).join(" "));
  expect((await subjects()).includes("Kiln schedule"), "the newest show first");
  same((await subjects()).includes("Backfilled"), false, "before the rest");
  await p.evaluate(() => window.__backfillNext()); await wait(300);
  expect((await subjects()).includes("Backfilled 3"), "the first batch shows when it lands");
  const note = await p.$eval("#sync-note", e => e.textContent).catch(() => "");
  same(note, "Syncing Jon Inbox… 7 of 11", "the status line counts");
  await p.evaluate(() => window.__backfillNext()); await wait(300);
  expect((await subjects()).includes("Backfilled 7"), "then the next");
  same(await p.$("#sync-note"), null, "the status line goes when it is done");
  same((await calls("backfill_mail")).length, 2, "asked batch by batch");
});

test("the assistant's buttons hide until a key is saved", { fake: true }, async ({ p }) => {
  same(await p.$eval("#assist-top", e => e.hidden), true, "not in the top bar");
  await p.click('.row[data-id="m1"]'); await wait(500);
  await p.click("#reply"); await wait(400);
  same(await p.$eval("#compose-form #help-write", e => e.hidden), true, "not in the reply");
});

test("with a key, the assistant is in the top bar, the reply and the pop-out compose", { fake: true, setup: () => { window.__ai = { grok: false, claude: true }; } }, async ({ p }) => {
  same(await p.$eval("#assist-top", e => e.hidden), false, "in the top bar");
  same(await p.$eval("#assist-top", e => e.getAttribute("aria-label")), "Help me write with Claude", "the one with a key");
  await p.click("#assist-top"); await wait(300);
  same(await p.evaluate(() => document.body.dataset.assist), "open", "opens the panel");
  same(await p.$eval("#assist-top", e => e.getAttribute("aria-expanded")), "true", "and says so");
  await p.click("#assist-top"); await wait(300);
  expect(await p.evaluate(() => document.body.dataset.assist !== "open"), "closes again");
  await p.click('.row[data-id="m1"]'); await wait(500);
  await p.click("#reply"); await wait(400);
  same(await p.$eval("#compose-form #help-write", e => e.hidden), false, "in the short reply, by Attach");
  // Choosing Grok in Settings changes the buttons at once.
  await p.evaluate(() => showSettings("assistants")); await wait(400);
  await p.click('[data-ai="grok"]'); await wait(200);
  same(await p.$eval("#assist-top", e => e.getAttribute("aria-label")), "Help me write with Grok", "the top button follows the choice");
  await p.evaluate(() => closePop && closePop());
  await p.goto(p.url().split(/[?#]/)[0] + "?compose=new", { waitUntil: "load" }); await wait(1500);
  expect(await p.$("#compose-form"), "the pop-out compose opened");
  same(await p.$eval("#compose-form #help-write", e => e.hidden), false, "in the pop-out compose");
  await p.click("#compose-form #help-write"); await wait(300);
  same(await p.evaluate(() => document.body.dataset.assist), "open", "opens the panel there too");
});

test("Ask across mail: every match from the server, with PDFs, a separate question, and what was left out", { fake: true, setup: () => {
  window.__ai = { grok: false, claude: true };
  const at = i => new Date(Date.UTC(2026, 9, 20, 12) - i * 3600000).toISOString().replace(/\.\d+Z$/, "Z");
  window.__search = Array.from({ length: 120 }, (_, i) => ({
    id: "ae" + i, thread: "t-ae" + i, subject: "Invoice " + (4400 + i), fromName: "Auto Eclectic Motorsports", fromEmail: "shop@autoeclectic.example",
    received: at(i), preview: "Invoice", bodyHtml: "<p>Thanks for your business.</p><p>Total $" + (100 + i) + ".00</p>", unread: false, flagged: false,
    hasAttachments: i < 2, files: [], to: [], cc: [], bcc: [], categories: [], parentFolderId: "f-inbox"
  }));
  window.__pdfs = [
    { messageId: "ae0", name: "INV-4400.pdf", text: "Brake service $1,240.00\nTotal $1,401.20 CAD", unreadable: false },
    { messageId: "ae1", name: "scan.pdf", text: "", unreadable: true }
  ];
} }, async ({ p, calls, clear }) => {
  await p.click("#q"); await p.keyboard.type("Auto Eclectic"); await wait(500);
  expect(!(await p.$("#ask-note")), "typing alone does not search");
  await p.keyboard.press("Enter"); await wait(800);
  expect((await p.$eval("#ask-note", e => e.textContent)).includes("every folder"), "says it reaches every folder");
  const lay = await p.evaluate(() => {
    const r = s => document.querySelector(s).getBoundingClientRect();
    const title = r("#list-title"), filter = r(".list-filter"), deeper = r("#search-deeper-bar"), ask = r("#ask-bar"), head = r(".list-head");
    return { stacked: title.bottom <= filter.top + 1 && filter.bottom <= deeper.top + 1 && deeper.bottom <= ask.top + 1, wide: deeper.width > head.width * 0.8 && ask.width > head.width * 0.8 };
  });
  same(lay, { stacked: true, wide: true }, "title, filter, Search deeper and Ask stack in the header, full width");
  await p.click("#ask-question"); await p.keyboard.type("How much did I spend in total?");
  await clear();
  await p.click("#ask-mail"); await wait(1500);
  const searches = await calls("search_mail");
  expect(searches.length >= 4 && searches.every(c => c.folderId === "" && c.query.toLowerCase().includes("auto eclectic")), "server search, every folder, paged", JSON.stringify(searches.map(c => [c.folderId, c.query, c.nextLink])));
  same((await calls("pdf_texts")).map(c => c.messageIds), [["ae0", "ae1"]], "PDFs read only where there are attachments");
  const ask = (await calls("ask_mail"))[0];
  same(ask.question, "How much did I spend in total?", "the question, not the search words");
  same(ask.messages.length, 100, "a hundred at most");
  same(ask.omitted, 20, "says how many were left out");
  same(ask.provider, "claude", "the assistant with a key");
  expect(ask.messages[0].body.includes("Total $"), "bodies go in full");
  expect(ask.messages.some(m => (m.attachments || "").includes("Total $1,401.20 CAD")), "the PDF's text goes with its message");
  const card = await p.$eval("#ask-card", e => e.textContent);
  expect(card.includes("Total $2,802.40") && card.includes("From 100 messages · 1 PDF · 1 PDF couldn't be read") && card.includes("20 older matches not read"), "answer says what it read", card);
});

test("pictures: a signature's cid: logo is drawn; image attachments and unused inline images are thumbnails", { fake: true, setup: () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  window.__inbox.push({ id: "kai", thread: "conv-kai", subject: "Update", fromName: "Kai Ito", fromEmail: "kai@ridgeline.example", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Hi", bodyHtml: '<p>Hi,</p><p><b>Kai Ito</b></p><p><img src="cid:image001.png@01DB2A3C" alt="logo"></p>', unread: true, flagged: false, hasAttachments: true, files: [{ id: "r1", name: "render.png", size: 90000, contentType: "image/png" }, { id: "p1", name: "scheme.pdf", size: 5000, contentType: "application/pdf" }], to: [], cc: [], bcc: [], categories: [] });
  window.__images = { kai: [
    { id: "i1", name: "image.png", contentId: "image001.png@01DB2A3C", inline: true, dataUrl: png },
    { id: "i2", name: "image.png", contentId: "image002.png@01DB2A3C", inline: true, dataUrl: png },
    { id: "r1", name: "render.png", contentId: "", inline: false, dataUrl: png },
  ] };
} }, async ({ p, calls, clear }) => {
  await p.click('.row[data-id="kai"]'); await wait(1200);
  same((await calls("inline_images")).map(c => c.messageId), ["kai"], "asked for the pictures once");
  const r = await p.evaluate(() => ({
    logo: (document.querySelector('#reading .letter img[alt="logo"]') || {}).src || "",
    thumbs: [...document.querySelectorAll("#reading .file-thumb")].map(b => b.dataset.fileId),
    chips: [...document.querySelectorAll("#reading .mail-files .file-chip")].map(b => b.dataset.fileName),
  }));
  expect(r.logo.startsWith("data:image/png;base64,"), "the logo is drawn in the signature", r.logo.slice(0, 40));
  same(r.thumbs, ["i2", "r1"], "the unused inline image and the image attachment are thumbnails");
  same(r.chips, ["scheme.pdf"], "the PDF stays a chip");
  await clear();
  await p.click('#reading .file-thumb[data-file-id="r1"]'); await wait(300);
  same((await calls("attachment_preview")).map(c => c.name), ["render.png"], "a thumbnail opens the picture in the viewer");
  expect(await p.$("#viewer .viewer-image"), "shown as a picture");
  await p.click("#viewer-open"); await wait(200);
  same((await calls("open_attachment")).map(c => c.name), ["render.png"], "Open in another app still opens it outside");
});

test("dark mode: a designed mail turns dark; the sun button shows it light", { fake: true, setup: () => {
  localStorage.setItem("mailroom-theme", "dark");
  window.__inbox.push({ id: "rcpt", thread: "conv-rcpt", subject: "Receipt", fromName: "Anthropic", fromEmail: "invoice@stripe.example", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Receipt", bodyHtml: '<table width="100%" style="background:#f6f9fc"><tr><td><div style="width:48px;height:48px;background:#d97757"></div><p>Paid $20.00</p></td></tr></table>', unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
} }, async ({ p }) => {
  await p.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await p.click('.row[data-id="rcpt"]'); await wait(800);
  const dark = await p.evaluate(() => { const l = document.querySelector("#reading .letter"); return { cls: l.className, bg: getComputedStyle(l).backgroundColor }; });
  expect(dark.cls.includes("mail-designed") && dark.bg === "rgb(19, 19, 19)", "designed and turned dark", dark);
  expect(await p.$eval('[data-light-view="rcpt"]', b => getComputedStyle(b).display !== "none"), "the sun button shows in dark mode");
  await p.click('[data-light-view="rcpt"]'); await wait(300);
  const light = await p.evaluate(() => { const l = document.querySelector("#reading .letter"); return { cls: l.className, filter: getComputedStyle(l).filter, bg: getComputedStyle(l).backgroundColor }; });
  expect(light.cls.includes("light-view") && light.filter === "none" && light.bg === "rgb(255, 255, 255)", "shown on a light background", light);
  same(await p.$eval('[data-light-view="rcpt"]', b => b.getAttribute("aria-pressed")), "true", "the button says so");
  await p.click('.row[data-id="m1"]'); await wait(400);
  await p.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  expect(await p.$eval("#reading .light-toggle", b => getComputedStyle(b).display === "none"), "no sun button in light mode");
});

test("dark mode: a plain mail keeps its own text colours, lightened", { fake: true, setup: () => {
  localStorage.setItem("mailroom-theme", "dark");
  window.__inbox.push({ id: "sig", thread: "conv-sig", subject: "Update", fromName: "Kai", fromEmail: "kai@example.org", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Received", bodyHtml: '<p id="t-body">Received.</p><p><b><span id="t-name" style="color:#7f7f7f">Kai Ito</span></b></p><p><span id="t-label" style="color:#e36c0a"><b id="t-bold">T:</b></span> <span id="t-black" style="color:#000000">555.010.0101</span></p><p><font id="t-font" color="#e36c0a">C:</font> <a id="t-link" href="mailto:a@example.org" style="color:#0563c1">a@example.org</a></p>', unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
} }, async ({ p }) => {
  await p.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await p.click('.row[data-id="sig"]'); await wait(800);
  // The cleaner drops ids: find each by its text, innermost first.
  const ink = () => p.evaluate(() => {
    const all = [...document.querySelectorAll("#reading .letter *")].reverse();
    const by = text => all.find(e => e.textContent.trim() === text);
    const pick = { "t-body": by("Received."), "t-name": by("Kai Ito"), "t-bold": by("T:"), "t-black": by("555.010.0101"), "t-font": by("C:"), "t-link": by("a@example.org") };
    pick["t-label"] = pick["t-bold"].parentElement;
    return Object.fromEntries(Object.entries(pick).map(([k, e]) => [k, getComputedStyle(e).color.match(/[\d.]+/g).map(Number).slice(0, 3)]));
  });
  const dark = await ink();
  const orange = c => c[0] > 200 && c[1] > 100 && c[1] < 200 && c[2] < 140;
  same(dark["t-body"], [255, 255, 255], "unstyled text is white");
  expect(orange(dark["t-label"]), "the orange label stays orange", dark["t-label"]);
  expect(orange(dark["t-bold"]), "and what is inside it", dark["t-bold"]);
  expect(orange(dark["t-font"]), "a <font color> too", dark["t-font"]);
  const grey = dark["t-name"];
  expect(grey[0] === grey[1] && grey[0] > 140 && grey[0] < 220, "the grey name is a lighter grey", grey);
  expect(dark["t-black"][0] > 220, "black text turns light", dark["t-black"]);
  const link = dark["t-link"];
  expect(link[2] > link[0] && link[2] > 180, "the link stays blue, lighter", link);
  await p.click('[data-light-view="sig"]'); await wait(300);
  const light = await ink();
  same(light["t-label"], [227, 108, 10], "light view shows the sender's own colour");
  same(light["t-black"], [0, 0, 0], "and black as black");
  await p.evaluate(() => { document.documentElement.dataset.theme = "light"; });
});

test("small mail type is enlarged in proportion, so a smaller signature stays smaller", { fake: true, setup: () => {
  const mail = (id, body, sig) => window.__inbox.push({ id, thread: "conv-" + id, subject: "Sizes " + id, fromName: "Kai", fromEmail: "kai@example.org", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Hi", bodyHtml: `<div style="font-size:${body}"><p>Received, thanks for this.</p><p>We will be using our standard paint spec for industrial use.</p><p><span style="font-size:${sig}">T: 555.010.0101</span></p></div>`, unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
  mail("small", "11pt", "9pt");
  mail("big", "12pt", "9pt");
} }, async ({ p }) => {
  const sizes = () => p.evaluate(() => {
    const all = [...document.querySelectorAll("#reading .letter *")].reverse();
    const by = t => all.find(e => e.textContent.trim().startsWith(t));
    return [parseFloat(getComputedStyle(by("Received")).fontSize), parseFloat(getComputedStyle(by("T: 555")).fontSize)];
  });
  await p.click('.row[data-id="small"]'); await wait(800);
  let [body, sig] = await sizes();
  expect(body >= 15.9 && sig > 12 && sig < body - 2, "an 11pt body comes up to the floor; the 9pt line by the same factor", [body, sig]);
  await p.click('.row[data-id="big"]'); await wait(800);
  [body, sig] = await sizes();
  expect(body === 16 && sig === 12, "a 12pt body is left alone, and its 9pt signature too", [body, sig]);
});

test("a long legal footer does not enlarge the message", { fake: true, setup: () => {
  const legal = "This email is confidential and may be legally privileged. If you have received this transmission in error, please notify the sender immediately and then delete or destroy any copies of this message. Unauthorised review, use, disclosure or distribution is prohibited. This notice is the long part of the message on purpose.";
  const body = `<p style="font-size:12pt">RESTRICTED</p><div style="font-size:11pt"><p>Hello there, the rings can be red.</p></div><p style="font-family:Helvetica,sans-serif;font-size:80%">${legal}</p>`;
  window.__inbox.push({ id: "legal-size", thread: "conv-legal-size", subject: "Red rings", fromName: "Michael", fromEmail: "michael@example.org", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Hello", bodyHtml: body, unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
} }, async ({ p }) => {
  const sizes = () => p.evaluate(() => {
    const all = [...document.querySelectorAll("#reading .letter *")].reverse();
    const by = t => all.find(e => (e.innerText || e.textContent || "").trim().startsWith(t));
    return {
      body: parseFloat(getComputedStyle(by("Hello there")).fontSize),
      banner: parseFloat(getComputedStyle(by("RESTRICTED")).fontSize)
    };
  });
  await p.click('.row[data-id="legal-size"]'); await wait(800);
  let got = await sizes();
  expect(got.body >= 15.5 && got.body <= 17, "the note stays at the reading size", got);
  expect(got.banner > got.body && got.banner < 20, "a larger line stays a little larger", got);
  await p.click("#reading .legal-toggle"); await wait(400);
  got = await sizes();
  expect(got.body >= 15.5 && got.body <= 17, "opening the notice does not resize the note", got);
  const fine = await p.evaluate(() => {
    const node = [...document.querySelectorAll("#reading .mail-legal *")].reverse().find(e => e.textContent.includes("confidential"));
    return node ? parseFloat(getComputedStyle(node).fontSize) : 0;
  });
  expect(fine > 0 && fine < got.body - 2, "the notice stays smaller than the note", fine);
});

test("safe senders with a country domain survive a restart", { fake: true, setup: () => {
  localStorage.setItem("mailroom-safe-senders", JSON.stringify(["@akhurst.ca", "@anthropic.com", "@school.edu.sg"]));
} }, async ({ p }) => {
  same(await p.evaluate(() => safeSenders), ["@akhurst.ca", "@anthropic.com", "@school.edu.sg"], "the saved list loads whole");
  same(await p.evaluate(() => JSON.parse(localStorage.getItem("mailroom-safe-senders"))), ["@akhurst.ca", "@anthropic.com", "@school.edu.sg"], "and is not written over");
});

test("a forward with only a signature above it keeps the forwarded mail's size", { fake: true, setup: () => {
  const sig = '<table role="presentation"><tr><td style="width:52px"></td><td><div style="font-size:19px">Jordan Hart</div><div style="font-size:13px">289 218 8526</div><div style="font-size:13px">jordan@example.org</div><div style="font-size:11px">ENGINEERED TO BUILD BETTER.</div></td></tr></table>';
  const fwd = '<div id="divRplyFwdMsg"><b>From:</b> Bill<br><b>Subject:</b> Quotes</div><div><p style="font-size:12pt">Sorry for the delay in sending. We just got Outlook up and running an hour ago.</p><p style="font-size:10pt">Account Representative</p><p style="font-size:8pt">This e-mail message is confidential, may be privileged or otherwise protected by law and is intended for the exclusive use of the addressee. Any other person is strictly prohibited from disclosing it.</p></div>';
  window.__inbox.push({ id: "fwd-size", thread: "conv-fwd-size", subject: "Fw: Quotes", fromName: "Jordan", fromEmail: "jordan@example.org", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Jordan", bodyHtml: sig + fwd, unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
} }, async ({ p }) => {
  await p.click('.row[data-id="fwd-size"]'); await wait(800);
  const open = await p.$("#reading .mail-quote-toggle, #reading .quote-toggle");
  if (open) { await open.click(); await wait(400); }
  const got = await p.evaluate(() => {
    const all = [...document.querySelectorAll("#reading .letter *")].reverse();
    const by = t => { const e = all.find(e => (e.textContent || "").trim().startsWith(t)); return e ? parseFloat(getComputedStyle(e).fontSize) : 0; };
    return { note: by("Sorry for the delay"), name: by("Jordan Hart"), phone: by("289 218") };
  });
  same(got, { note: 16, name: 19, phone: 13 }, "nothing is enlarged by the forwarder's signature");
});

test("Mark as read on a folded conversation marks every message in it", { fake: true, setup: () => {
  const at = n => new Date(Date.now() - n * 60000).toISOString().replace(/\.\d+Z$/, "Z");
  const base = { thread: "conv-fold", subject: "Quote", fromName: "Kai", fromEmail: "kai@example.org", unread: true, flagged: false, cc: [], bcc: [], to: [], categories: [], hasAttachments: false, files: [] };
  ["fold-1", "fold-2", "fold-3"].forEach((id, i) => window.__inbox.push(Object.assign({}, base, { id, received: at(90 - i * 30), preview: id, bodyHtml: "<p>" + id + "</p>" })));
} }, async ({ p, calls, clear, rightClick }) => {
  await clear();
  // A reply of yours in Sent Items that Exchange left unread keeps the row bold.
  await p.evaluate(() => {
    const head = messages.find(m => m.id === "fold-3");
    messages.push(Object.assign({}, head, { id: "fold-sent", box: "sent", seq: head.seq + 1, unread: true, fromName: "Me", preview: "Thanks" }));
    render();
  }); await wait(200);
  const row = await p.evaluate(() => { const r = document.querySelector('.row[data-thread="conv-fold"], .conv-title[data-thread="conv-fold"]'); return r && [r.className, r.dataset.id]; });
  expect(row, "the folded conversation is listed", row);
  await rightClick(`[data-id="${row[1]}"]`);
  await p.evaluate(() => [...document.querySelectorAll("#row-menu button")].find(b => b.textContent.trim() === "Mark as read").click()); await wait(500);
  same(await p.evaluate(() => messages.filter(m => m.thread === "conv-fold").map(m => [m.id, m.unread]).sort()), [["fold-1", false], ["fold-2", false], ["fold-3", false], ["fold-sent", false]], "every message is read, the Sent reply too");
  same(await p.$$eval('[data-thread="conv-fold"].unread, [data-thread="conv-fold"] .unread', e => e.length), 0, "the row no longer shows unread");
});

test("an open conversation marks the folded messages that have attachments", { fake: true, setup: () => {
  const at = n => new Date(Date.now() - n * 60000).toISOString().replace(/\.\d+Z$/, "Z");
  const base = { thread: "conv-clip", subject: "Update", fromName: "Kai", fromEmail: "kai@example.org", unread: false, flagged: false, cc: [], bcc: [], to: [], categories: [] };
  window.__inbox.push(Object.assign({}, base, { id: "clip-1", received: at(90), preview: "Here you go", bodyHtml: "<p>Here you go</p>", hasAttachments: true, files: [{ id: "f1", name: "render.png", contentType: "image/png", size: 1000 }, { id: "f2", name: "spec.pdf", contentType: "application/pdf", size: 2000 }] }));
  window.__inbox.push(Object.assign({}, base, { id: "clip-2", received: at(60), preview: "Thanks", bodyHtml: "<p>Thanks</p>", hasAttachments: false, files: [] }));
  window.__inbox.push(Object.assign({}, base, { id: "clip-3", received: at(30), preview: "Received", bodyHtml: "<p>Received</p>", hasAttachments: false, files: [] }));
} }, async ({ p }) => {
  await p.click('.row[data-id="clip-3"]'); await wait(800);
  const clip = await p.$eval('[data-fold="clip-1"]', b => { const c = b.querySelector(".fold-clip"); return c && [c.getAttribute("title"), c.textContent.trim()]; });
  same(clip, ["2 attachments: render.png, spec.pdf", "2"], "a paperclip and the count on the one with files");
  same(await p.$eval('[data-fold="clip-2"]', b => !!b.querySelector(".fold-clip")), false, "none on the one without");
});

test("a reply popped out shows the message it answers, open", { fake: true }, async ({ p, calls }) => {
  await p.click('.row[data-id="m3"]'); await wait(400);
  await p.click("#reply"); await wait(400);
  await p.click("#pop-out"); await wait(400);
  const query = (await calls("pop_compose"))[0].query;
  await p.goto(p.url().split(/[?#]/)[0] + "?" + query, { waitUntil: "load" }); await wait(1500);
  same(await p.$eval("#compose-form #show-history", e => e.getAttribute("aria-expanded")), "true", "the history toggle is open");
  expect(await p.$eval("#message-history", e => !e.hidden && e.textContent.trim().length > 20), "the original shows without a click");
  const top = await p.$eval("#message-history", e => Math.round(e.getBoundingClientRect().top));
  expect(top < 500, "and in view, under a short reply, not below an empty window", top);
  await p.click("#show-history"); await wait(200);
  const tall = await p.$eval("#compose-body", e => Math.round(e.getBoundingClientRect().height));
  expect(tall > 500, "folded away, the reply fills the window again", tall);
});

test("list rows keep their element when selected or read, and rows off screen are not laid out (#80)", { fake: true }, async ({ p }) => {
  await wait(400);
  await p.evaluate(() => { window.__row = document.querySelector('.row[data-id="m1"]'); window.__wrap = window.__row.closest(".conv"); });
  await p.click('.row[data-id="m1"]'); await wait(400);
  await p.click('.row[data-id="m2"]'); await wait(400);
  same(await p.evaluate(() => [window.__row === document.querySelector('.row[data-id="m1"]'), window.__wrap.isConnected]), [true, true], "the same element after selecting and reading");
  same(await p.evaluate(() => [document.querySelector('.row[data-id="m1"]').classList.contains("unread"), document.querySelector('.row[data-id="m1"]').getAttribute("aria-current"), document.querySelector('.row[data-id="m2"]').getAttribute("aria-current")]), [false, "false", "true"], "but showing the new state");
  same(await p.evaluate(() => getComputedStyle(document.querySelector("#rows > .conv")).contentVisibility), "auto", "skipped while off screen");
  same(await p.evaluate(() => [document.querySelector('.row[data-id="m3"]').closest(".row-wrap").classList.contains("has-files"), document.querySelector('.row[data-id="m1"]').closest(".row-wrap").classList.contains("has-files")]), [true, false], "a class, not :has(), marks rows with files");
});

test("a double-clicked message opens in a window of its own; a single click still reads it here", { fake: true }, async ({ p, calls, rightClick, menu }) => {
  await p.click('.row[data-id="m2"]'); await wait(400);
  same(await calls("pop_message"), [], "one click opens no window");
  expect(await p.$eval("#reading", e => e.textContent.includes("Pipeline review")), "and reads it in the pane");
  await p.click('.row[data-id="m3"]', { count: 2 }); await wait(500);
  const popped = await calls("pop_message");
  same(popped.length, 1, "a double-click opens one window");
  expect(/^read=1&msg=m3&d=\d+$/.test(popped[0].query), "for that message, with a query the backend accepts", popped[0].query);
  same(popped[0].title, "Site plans", "titled with its subject");
  same(await p.evaluate(() => messages.find(m => m.id === "m3").unread), false, "marked read, as opening it here would");
  expect((await calls("apply_mail")).some(a => a.kind === "read" && a.messageIds.includes("m3")), "and on the server");
  const handed = await p.evaluate(() => JSON.parse(localStorage.getItem("mailroom-read-pop")));
  same(handed.msgId, "m3", "the message is handed to the window");
  expect(handed.messages.some(m => m.id === "m3" && /Site plans body/.test(m.bodyHtml)), "with its body", handed.messages.map(m => m.id));
  await rightClick('.row[data-id="m1"]');
  same((await menu())[0], "Open in new window", "the right-click menu offers it first");
  await p.click('#row-menu [data-act="open-window"]'); await wait(500);
  const fromMenu = await calls("pop_message");
  same(fromMenu.length, 2, "Open in new window opens one too");
  expect(/^read=1&msg=m1&d=\d+$/.test(fromMenu[1].query) && fromMenu[1].title === "Kiln schedule", "for the row's message, as a double-click does", fromMenu[1]);
  same(await p.evaluate(() => messages.find(m => m.id === "m1").unread), false, "and marks it read");
  same(await p.evaluate(() => JSON.parse(localStorage.getItem("mailroom-read-pop")).msgId), "m1", "handing it over");
});

test("the message window shows just that message, polls nothing, and answers in the compose window", { fake: true }, async ({ p, calls }) => {
  await p.click('.row[data-id="m3"]', { count: 2 }); await wait(500);
  const query = (await calls("pop_message"))[0].query;
  // A body the main window had not loaded yet comes from the cache there.
  await p.evaluate(() => {
    const handed = JSON.parse(localStorage.getItem("mailroom-read-pop"));
    handed.messages.forEach(m => { if (m.id === "m3") { m.bodyHtml = ""; m.needsBody = true; } });
    localStorage.setItem("mailroom-read-pop", JSON.stringify(handed));
  });
  await p.goto(p.url().split(/[?#]/)[0] + "?" + query, { waitUntil: "load" }); await wait(1600);
  expect(await p.$eval("#reading", e => e.textContent.includes("Site plans body")), "the message body shows");
  same((await calls("cached_body")).map(a => a.messageId), ["m3"], "loaded from the cache");
  const shown = await p.evaluate(() => ({
    list: !!document.querySelector(".list") && getComputedStyle(document.querySelector(".list")).display,
    folders: getComputedStyle(document.querySelector("#folders")).display,
    top: getComputedStyle(document.querySelector(".top")).display,
    reading: Math.round(document.querySelector("#reading").getBoundingClientRect().width) === innerWidth
  }));
  same(shown, { list: "none", folders: "none", top: "none", reading: true }, "only the reading pane, the window's width");
  same(await p.$$eval("#reading .toolbar button", bs => bs.map(b => b.id)), ["reply", "reply-all", "forward", "thread-files", "print"], "only actions that leave the mailbox alone");
  same(await p.evaluate(() => localStorage.getItem("mailroom-read-pop")), null, "the hand-off is not left in storage");
  await wait(1500);
  for (const cmd of ["sync_inbox", "saved_inbox", "backfill_mail", "sync_folder", "sync_calendar", "check_update", "take_launch_request", "report_unread", "apply_mail"]) {
    same((await calls(cmd)).length, 0, "no " + cmd + " from the message window");
  }
  same(await p.evaluate(() => [ownsOutbox(), pollTimer]), [false, 0], "no Outbox and no polling timer");
  await p.click("#reply"); await wait(600);
  const composed = await calls("pop_compose");
  same(composed.length, 1, "Reply opens the compose window");
  expect(/^compose=reply&msg=m3&d=\d+$/.test(composed[0].query), "as a reply to this message", composed[0].query);
  const snap = await p.evaluate(() => JSON.parse(localStorage.getItem("outlook-mock-compose")));
  same([snap.to, snap.subject], ["bob@example.org", "Re: Site plans"], "addressed and titled as a reply");
  expect(snap.originals.some(m => m.id === "m3"), "with the message it answers");
  same(await p.evaluate(() => !!document.querySelector("#reading #compose-form")), false, "no reply pane left in the message window");
  same((await calls("plugin:window|close")).length, 1, "and the message window closes: the compose window takes its place");
  await p.click("#forward"); await wait(600);
  const forward = await p.evaluate(() => JSON.parse(localStorage.getItem("outlook-mock-compose")));
  same([forward.subject, forward.to, (await calls("pop_compose")).length], ["FW: Site plans", "", 2], "Forward too");
  same((await calls("plugin:window|close")).length, 2, "and closes the message window too");
  // A compose window that could not open leaves the message where it was.
  await p.evaluate(() => { window.__popFail = true; });
  await p.click("#reply"); await wait(600);
  same((await calls("plugin:window|close")).length, 2, "no close when the compose window did not open");
  expect(await p.$eval("#reading", e => e.textContent.includes("Site plans body")), "the message still shows");
  await p.evaluate(() => { window.__popFail = false; });
  // The compose window takes the reply from here, as from the main window.
  await p.goto(p.url().split(/[?#]/)[0] + "?" + composed[0].query, { waitUntil: "load" }); await wait(1200);
  expect(await p.$eval("#message-history", e => e.textContent.includes("Site plans body")), "the compose window shows the original");
});

test("Escape closes the message window", { fake: true }, async ({ p, calls }) => {
  await p.click('.row[data-id="m1"]', { count: 2 }); await wait(500);
  const query = (await calls("pop_message"))[0].query;
  await p.goto(p.url().split(/[?#]/)[0] + "?" + query, { waitUntil: "load" }); await wait(1200);
  expect(await p.$eval("#reading", e => e.textContent.includes("Kiln schedule body")), "the message shows");
  await p.keyboard.press("Escape"); await wait(200);
  same((await calls("plugin:window|close")).length, 1, "the window closes");
});

test("lists in mail are spaced and indented as Outlook draws them", { fake: true, setup: () => {
  const body = '<div style="font-family: Aptos, Calibri, sans-serif; font-size: 11pt; line-height: 1.4;"><p style="margin: 0;">A few questions:</p><ol><li style="margin: 0;">Where?</li><li style="margin: 0;">When?</li></ol><p style="margin: 0;">Thanks,</p><ul style="margin-top: 0; margin-bottom: 0;"><li>own margins</li></ul></div>';
  window.__inbox.push({ id: "lists", thread: "conv-lists", subject: "Re: Laser marking", fromName: "Jon", fromEmail: "jon@timberworks.example", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "A few questions", bodyHtml: body, unread: false, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
} }, async ({ p }) => {
  await p.click('.row[data-id="lists"]'); await wait(1200);
  const got = await p.evaluate(() => {
    const L = document.querySelector("#reading .letter");
    const c = e => getComputedStyle(e);
    const ol = L.querySelector("ol"), ul = L.querySelector("ul");
    return { olTop: c(ol).marginTop === c(ol).fontSize, olBottom: c(ol).marginBottom === c(ol).fontSize, olIndent: c(ol).paddingLeft, ulTop: c(ul).marginTop };
  });
  same(got, { olTop: true, olBottom: true, olIndent: "40px", ulTop: "0px" }, "1em around, 40px in, and a list's own margins kept");
  await p.click("#compose"); await wait(300);
  await p.click("#compose-body"); await p.click('#compose-form .format-bar [data-cmd="insertOrderedList"]'); await wait(200);
  const typed = await p.$eval("#compose-body ol", e => getComputedStyle(e).paddingLeft);
  same(typed, "40px", "a list typed in the editor is indented the same");
});

test("Share availability: busy times shaded, pick free ones, the list goes in with the time zone (#120)", { fake: true }, async ({ p, calls }) => {
  await p.click("#compose"); await wait(300);
  await p.click("#compose-body"); await p.keyboard.type("Hi Andre,"); await p.keyboard.press("Enter");
  await p.click('#compose-form .format-bar [data-cmd="availability"]'); await wait(500);
  expect(await p.$(".avail-dialog"), "the dialog opens");
  expect((await calls("sync_calendar")).length >= 1, "the sender's calendar is loaded for it");
  const grid = await p.evaluate(() => {
    const cells = [...document.querySelectorAll("[data-avail]")];
    const days = [...new Set(cells.map(c => c.dataset.avail.split("|")[0]))];
    return { days: days.length, rows: cells.length / days.length, lastDay: days[days.length - 1] };
  });
  same([grid.days, grid.rows], [5, 16], "five working days of 9 to 5 in half hours");
  // The fake calendar has a 9:00 to 10:00 meeting tomorrow.
  const tomorrow = await p.evaluate(() => dayFromDate(addDays(new Date(), 1)));
  const nine = await p.$(`[data-avail="${tomorrow}|540"]`);
  if (nine) same(await p.$eval(`[data-avail="${tomorrow}|540"]`, b => [b.disabled, b.classList.contains("busy")]), [true, true], "a meeting's time is busy");
  same(await p.$eval(".avail-dialog button[type=submit]", b => b.disabled), true, "nothing to insert yet");
  // Drag from 10:00 to 10:30 on the last day: one hour.
  const a = await (await p.$(`[data-avail="${grid.lastDay}|600"]`)).boundingBox();
  const b = await (await p.$(`[data-avail="${grid.lastDay}|630"]`)).boundingBox();
  await p.mouse.move(a.x + 5, a.y + 5); await p.mouse.down();
  await p.mouse.move(b.x + 5, b.y + 5, { steps: 4 }); await p.mouse.up(); await wait(100);
  same(await p.$eval(".avail-count", e => e.textContent), "1 hour picked", "the drag picked both half hours");
  await p.click(".avail-dialog button[type=submit]"); await wait(300);
  same(await p.$(".avail-dialog"), null, "the dialog closes");
  const text = await p.$eval("#compose-body", e => e.innerText);
  expect(/Here are some times I'm free \(Eastern (Standard|Daylight) Time\)/.test(text), "names the time zone", text);
  expect(/10:00\sAM to 11:00\sAM/.test(text), "the hour, joined into one span", text);
  expect(text.indexOf("Hi Andre,") < text.indexOf("Here are some times"), "where the caret was, after the greeting", text);
});

test("Settings > Calendar: working hours are kept, and must end after they start (#120)", { fake: true }, async ({ p }) => {
  await p.evaluate(() => showSettings("calendar")); await wait(300);
  await p.select("#work-start", "480"); await wait(100);
  same(await p.evaluate(() => workHours()), { start: 480, end: 1020 }, "8:00 start kept");
  await p.select("#work-end", "450"); await wait(100);
  same(await p.evaluate(() => workHours()), { start: 480, end: 1020 }, "an end before the start is refused");
  expect(/end after it starts/.test(await p.$eval("#toast", t => t.textContent)), "and says why");
});

test("compose bar follows Outlook: full ribbon in a new message, none in an inline reply until Format text", { fake: true }, async ({ p }) => {
  await p.click("#compose"); await wait(300);
  const order = await p.$$eval("#compose-form .format-bar > *", els => els.map(e => e.matches("select") ? e.getAttribute("aria-label") : (e.getAttribute("aria-label") || e.getAttribute("title") || e.className)).filter(x => x && x !== "fmt-sep" && !/file-picker/.test(x)));
  same(order.slice(0, 11), ["Undo", "Redo", "Font", "Font size", "Bold", "Italic", "Underline", "Strikethrough", "colour-split", "colour-split", "Bullets"], "Outlook's order");
  same(order.slice(11, 15), ["Numbers", "More formatting", "Attach", "Link"], "then More, Attach, Link");
  const write = "#compose-body .body-write";
  await p.click("#compose-body"); await p.keyboard.type("Hello world");
  const selectWord = (word) => p.evaluate((w) => {
    const write = document.querySelector("#compose-body .body-write");
    const walker = document.createTreeWalker(write, NodeFilter.SHOW_TEXT);
    let n; while ((n = walker.nextNode())) { const i = n.data.indexOf(w); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + w.length); getSelection().removeAllRanges(); getSelection().addRange(r); break; } }
    document.querySelector("#compose-body").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, word);
  await selectWord("world");
  await p.select("#compose-form [data-font-face]", "Georgia, serif"); await wait(150);
  await p.select("#compose-form [data-font-size]", "14"); await wait(150);
  const styled = await p.$eval(write, w => { const t = [...w.querySelectorAll("*")].filter(e => e.textContent === "world"); return { face: t.some(e => /Georgia/.test(e.style.fontFamily)), size: t.some(e => e.style.fontSize === "14pt"), font: !!w.querySelector("font") }; });
  same(styled, { face: true, size: true, font: false }, "Georgia 14pt on the selection, as styles");
  await selectWord("Hello");
  same(await p.$eval("#compose-form [data-font-size]", s => s.value), "12", "the picker shows the default where nothing is set");
  await selectWord("world");
  same(await p.$eval("#compose-form [data-font-size]", s => s.value), "14", "and 14 on the styled word");
  // A size picked with nothing selected applies to what is typed next.
  await p.evaluate(() => {
    const w = document.querySelector("#compose-body .body-write");
    const texts = []; const tw = document.createTreeWalker(w, NodeFilter.SHOW_TEXT); let n; while ((n = tw.nextNode())) texts.push(n);
    const last = texts[texts.length - 1]; const r = document.createRange(); r.setStart(last, last.data.length); r.collapse(true);
    getSelection().removeAllRanges(); getSelection().addRange(r);
    document.querySelector("#compose-body").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await p.select("#compose-form [data-font-size]", "20"); await wait(150);
  await p.keyboard.type(" big");
  same(await p.$eval(write, w => [...w.querySelectorAll("span")].some(e => e.style.fontSize === "20pt" && e.textContent.includes("big")) && !w.querySelector('font[size="7"]')), true, "typed text at 20pt");
  await selectWord("Hello");
  await p.click('#compose-form [data-cmd="strikeThrough"]'); await wait(100);
  same(await p.$eval(write, w => !!w.querySelector("strike, s") || [...w.querySelectorAll("[style]")].some(e => /line-through/.test(e.style.textDecoration))), true, "Strikethrough");
  await p.click("#compose-form [data-format-more]"); await wait(150);
  same(await p.$$eval("#format-more-menu [data-more-cmd]", b => b.map(x => x.textContent.trim())), ["Align left", "Centre", "Align right", "Decrease indent", "Increase indent", "Superscript", "Subscript", "Clear formatting"], "More formatting");
  await p.click('#format-more-menu [data-more-cmd="justifyCenter"]'); await wait(150);
  same(await p.$eval(write, w => [...w.querySelectorAll("p, div")].some(e => e.style.textAlign === "center")), true, "Centre as a style");
  await p.click('#compose-form [data-cmd="undo"]'); await wait(100);
  same(await p.$eval(write, w => [...w.querySelectorAll("p, div")].some(e => e.style.textAlign === "center")), false, "Undo");
  const sent = await p.evaluate(() => sentBody(document.getElementById("compose-form")));
  expect(/font-size:\s*14pt/.test(sent) && /Georgia/.test(sent), "font and size are sent", sent.slice(0, 300));
  // An inline reply: no bar until Format text, which is remembered.
  await p.goto(p.url().split(/[?#]/)[0], { waitUntil: "load" }); await wait(1200);
  await p.evaluate(() => { try { localStorage.removeItem("mailroom-format-bar"); } catch (e) {} });
  await p.click('.row[data-id="m1"]'); await wait(500);
  await p.click("#reply"); await wait(400);
  same(await p.$eval("#compose-form .format-bar", b => b.hidden), true, "inline reply: no formatting bar");
  expect(await p.$("#compose-form .compose-bar #add-file"), "Attach by Send");
  await p.click("#compose-form #format-toggle"); await wait(150);
  same(await p.$eval("#compose-form .format-bar", b => b.hidden), false, "Format text shows it");
  same(await p.$eval("#compose-form #format-toggle", b => b.getAttribute("aria-pressed")), "true", "the button shows it is on");
  same(await p.$$eval("#compose-form #add-file, #compose-form #help-write", e => e.length), (await p.$("#compose-form #help-write")) ? 2 : 1, "Attach and the assistant once each");
  same(await p.evaluate(() => localStorage.getItem("mailroom-format-bar")), "1", "remembered");
});

test("compose: what you type shows at the size it is sent, 12pt as Outlook", { fake: true }, async ({ p }) => {
  await p.click("#compose"); await wait(300);
  await p.click("#compose-body"); await wait(100);
  await p.keyboard.type("Hello Sam");
  const shown = await p.evaluate(() => { const n = getSelection().anchorNode; const e = n.nodeType === 1 ? n : n.parentElement; const c = getComputedStyle(e); return [c.fontSize, c.fontFamily.split(",")[0].trim()]; });
  same(shown, ["16px", "Aptos"], "typed text is 12pt Aptos on screen");
  const sent = await p.evaluate(() => sentBody(document.getElementById("compose-form")));
  expect(/font-size:\s*12pt/.test(sent), "and goes out at 12pt", sent.slice(0, 200));
});

test("compose: Bullets, Numbers and Link are icons", { fake: true }, async ({ p }) => {
  await p.click("#compose"); await wait(300);
  for (const [cmd, name] of [["insertUnorderedList", "Bullets"], ["insertOrderedList", "Numbers"], ["link", "Link"]]) {
    const b = await p.$eval(`#compose-form .format-bar [data-cmd="${cmd}"]`, e => ({ text: e.textContent.trim(), svg: !!e.querySelector("svg"), label: e.getAttribute("aria-label") }));
    same(b, { text: "", svg: true, label: name }, name + " is an icon with its name for screen readers");
  }
});

test("compose: Link inserts, edits and removes a link on a word, as from the right-click menu", { fake: true }, async ({ p }) => {
  await p.click("#compose"); await wait(300);
  const write = "#compose-body";
  await p.click(write); await wait(100);
  await p.keyboard.type("See the drawings today");
  const pick = (word) => p.evaluate((sel, word) => {
    const w = document.querySelector(sel);
    const walk = document.createTreeWalker(w, NodeFilter.SHOW_TEXT);
    for (let n; (n = walk.nextNode());) {
      const at = n.data.indexOf(word);
      if (at < 0) continue;
      const r = document.createRange(); r.setStart(n, at); r.setEnd(n, at + word.length);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return true;
    }
    return false;
  }, write, word);
  // What the menu item runs.
  same(await pick("drawings"), true, "the word is found");
  await p.evaluate(() => window.mailroomLinkFromMenu()); await wait(150);
  same(await p.$eval(".link-dialog h2", e => e.textContent), "Insert link", "the dialog opens");
  same(await p.$eval('.link-dialog [name="text"]', e => e.value), "drawings", "the word is the text to display");
  await p.type('.link-dialog [name="href"]', "notaurl");
  await p.click('.link-dialog [type="submit"]'); await wait(100);
  same(await p.$eval(".link-dialog .form-error", e => e.hidden), false, "a non-address is refused");
  await p.$eval('.link-dialog [name="href"]', e => { e.value = "example.com/plans"; });
  await p.click('.link-dialog [type="submit"]'); await wait(150);
  same(await p.$eval(write, w => [...w.querySelectorAll("a")].map(a => [a.textContent, a.getAttribute("href")])), [["drawings", "https://example.com/plans"]], "the word is linked, https:// added");
  // On the link again: Edit, with Remove link.
  await pick("draw");
  await p.evaluate(() => window.mailroomLinkFromMenu()); await wait(150);
  same(await p.$eval(".link-dialog h2", e => e.textContent), "Edit link", "editing an existing link");
  same(await p.$eval('.link-dialog [name="href"]', e => e.value), "https://example.com/plans", "its address is filled in");
  await p.$eval('.link-dialog [name="href"]', e => { e.value = "jordan@example.com"; });
  await p.click('.link-dialog [type="submit"]'); await wait(150);
  same(await p.$eval(write + " a", a => a.getAttribute("href")), "mailto:jordan@example.com", "an email address becomes mailto:");
  await pick("drawings");
  await p.evaluate(() => window.mailroomLinkFromMenu()); await wait(150);
  await p.click(".link-dialog [data-link-remove]"); await wait(150);
  same(await p.$$eval(write + " a", a => a.length), 0, "Remove link");
  same(await p.$eval(write, w => w.textContent.includes("See the drawings today")), true, "the text stays");
  // Escape cancels, and leaves the compose window open.
  await pick("today");
  await p.evaluate(() => window.mailroomLinkFromMenu()); await wait(150);
  await p.keyboard.press("Escape"); await wait(150);
  same([await p.$(".link-dialog"), !!(await p.$("#compose-form"))], [null, true], "Escape closes only the dialog");
});

test("compose: pasted lines become paragraphs, so Numbers lists them all", { fake: true }, async ({ p }) => {
  await p.click("#compose"); await wait(300);
  await p.click("#compose-body"); await wait(100);
  const lines = ["Where would you suggest the panel sits?", "Could the press flag panel complete?", "What would you recommend leaving in place?"];
  // A terminal or editor copy: one block, lines kept by white-space: pre-wrap,
  // in a monospace font with its own spacing.
  await p.evaluate(lines => {
    const write = document.querySelector("#compose-body .body-write") || document.getElementById("compose-body");
    write.focus();
    const dt = new DataTransfer();
    dt.setData("text/html", '<meta charset="utf-8"><span style="white-space: pre-wrap; font-family: monospace; line-height: 2">Afternoon <b>Kai</b>,\n' + lines.join("\n") + '\n<a href="https://example.org/x">Thanks</a></span>');
    dt.setData("text/plain", lines.join("\n"));
    write.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, lines);
  await wait(200);
  const write = "#compose-body .body-write";
  const paras = await p.$$eval(write + " > p", ps => ps.map(x => x.textContent));
  same(paras.filter(t => t.trim()), ["Afternoon Kai,", ...lines, "Thanks"], "each line is its own paragraph");
  same(await p.$eval(write, e => !!e.querySelector("[style]") || /monospace/.test(e.innerHTML)), false, "the source's font and spacing are gone");
  same(await p.$eval(write, e => [e.querySelector("b") && e.querySelector("b").textContent, e.querySelector("a") && e.querySelector("a").getAttribute("href")]), ["Kai", "https://example.org/x"], "bold and links stay");
  // Select the three questions and click Numbers once.
  await p.evaluate(() => {
    const ps = [...document.querySelectorAll("#compose-body .body-write > p")];
    const a = ps.find(x => x.textContent.startsWith("Where")), b = ps.find(x => x.textContent.startsWith("What"));
    const r = document.createRange(); r.setStart(a.firstChild, 0); r.setEnd(b.lastChild, b.lastChild.length);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await p.click('#compose-form .format-bar [data-cmd="insertOrderedList"]'); await wait(200);
  same(await p.$$eval(write + " ol li", li => li.map(x => x.textContent.trim())), lines, "one click numbers all three");
});

test("a forward popped out keeps the original: its history, its files, and goes as a forward", { fake: true }, async ({ p, calls, clear }) => {
  await p.click('.row[data-id="m3"]'); await wait(400);
  await p.click("#forward"); await wait(400);
  await p.click("#compose-to"); await p.keyboard.type("eve@example.org");
  await p.click("#pop-out"); await wait(400);
  const query = (await calls("pop_compose"))[0].query;
  await p.goto(p.url().split(/[?#]/)[0] + "?" + query, { waitUntil: "load" }); await wait(1500);
  expect(await p.$("#compose-form #show-history"), "the forwarded message is there to show");
  await p.click("#show-history"); await wait(200);
  const history = await p.$eval("#message-history", e => e.textContent.replace(/\s+/g, " "));
  expect(history.includes("Subject"), "with its header and body", history.slice(0, 200));
  expect(await p.$('#compose-files .file[data-name="plan.pdf"]'), "its files come too");
  // The pop-out hands the send to the main window, which has the original.
  await p.click('#compose-form button[type="submit"]'); await wait(800);
  const handed = await p.evaluate(() => JSON.parse(localStorage.getItem("outlook-mock-mail-event") || "{}"));
  same([handed.type, handed.replyMode, handed.replyTo, handed.to], ["queued", "forward", "m3", "eve@example.org"], "handed back as a forward of the original");
});

test("text pasted from dark mode is not sent as a black box", { fake: true }, async ({ p, calls, clear }) => {
  await p.evaluate(() => { sendDelay = 0; });
  await p.click("#compose"); await wait(300);
  await p.click("#compose-to"); await p.keyboard.type("eve@example.org");
  await p.click("#compose-subject"); await p.keyboard.type("Wire");
  // What WebKit puts in when text is copied from the dark reading pane.
  await p.evaluate(() => {
    const write = document.querySelector("#compose-body .body-write") || document.getElementById("compose-body");
    write.innerHTML = '<div style="background-color: rgb(32, 32, 32); color: rgb(255, 255, 255);"><span style="color: rgb(250, 250, 250);">Afternoon all,</span> <span style="color: rgb(227, 108, 10);">wire</span></div>';
    document.getElementById("compose-body").dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
  });
  const shown = await p.$eval("#compose-body", e => e.innerHTML);
  expect(!/32, 32, 32|255, 255, 255|250, 250, 250/.test(shown), "cleaned as it is pasted", shown);
  expect(shown.includes("227, 108, 10"), "a real colour stays", shown);
  // And again at send, whatever got in.
  await p.evaluate(() => {
    const write = document.querySelector("#compose-body .body-write") || document.getElementById("compose-body");
    write.insertAdjacentHTML("beforeend", '<p style="background: rgb(20, 20, 20)"><font color="#ffffff">Thanks!</font></p>');
  });
  await clear();
  await p.click('#compose-form button[type="submit"]'); await wait(700);
  const sent = (await calls("send_mail"))[0].bodyHtml;
  expect(!/rgb\(20, 20, 20\)|#ffffff|32, 32, 32/i.test(sent), "nothing dark is sent", sent);
  expect(sent.includes("Thanks!") && sent.includes("Afternoon all"), "the words are", sent);
});

test("Tab from To skips Cc and Bcc: to the subject, or into the message", { fake: true }, async ({ p }) => {
  await p.click("#compose"); await wait(300);
  await p.click("#compose-to"); await p.keyboard.type("eve@example.org");
  await p.keyboard.press("Tab");
  same(await p.evaluate(() => document.activeElement.id), "compose-subject", "a new message: the subject");
  await p.keyboard.type("Hello");
  await p.click("#compose-to"); await p.keyboard.press("Tab");
  same(await p.evaluate(() => !!document.activeElement.closest("#compose-body")), true, "with a subject: the message");
});

test("font colour and highlight: picked, shown in dark mode, sent as written", { fake: true, setup: () => {
  localStorage.setItem("mailroom-theme", "dark");
  window.__inbox.push({ id: "hl", thread: "conv-hl", subject: "Marked", fromName: "Ada", fromEmail: "ada@example.org", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Marked", bodyHtml: '<p>Plain and <span style="background-color: #ffff00">copied bit</span> here.</p>', unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
} }, async ({ p, calls, clear }) => {
  await p.evaluate(() => { document.documentElement.dataset.theme = "dark"; sendDelay = 0; });
  // A highlight in received mail stays a highlight, and the mail is not turned over.
  await p.click('.row[data-id="hl"]'); await wait(800);
  const read = await p.evaluate(() => {
    const span = [...document.querySelectorAll("#reading .letter span")].find(e => e.textContent === "copied bit");
    return { designed: document.querySelector("#reading .letter").classList.contains("mail-designed"), bg: getComputedStyle(span).backgroundColor, ink: getComputedStyle(span).color };
  });
  same([read.designed, read.bg, read.ink], [false, "rgb(255, 255, 0)", "rgb(36, 36, 36)"], "yellow behind dark text");
  await p.click("#compose"); await wait(300);
  await p.click("#compose-to"); await p.keyboard.type("eve@example.org");
  await p.click("#compose-subject"); await p.keyboard.type("Copied");
  await p.click("#compose-body"); await p.keyboard.type("This was copied");
  // Select "copied".
  await p.evaluate(() => {
    const write = document.querySelector("#compose-body .body-write") || document.getElementById("compose-body");
    const walker = document.createTreeWalker(write, NodeFilter.SHOW_TEXT);
    let node; while ((node = walker.nextNode()) && !node.textContent.includes("copied"));
    const at = node.textContent.indexOf("copied");
    const r = document.createRange(); r.setStart(node, at); r.setEnd(node, at + 6);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  });
  await p.click('[data-colour-menu="fore"]'); await wait(200);
  expect(await p.$("#colour-menu .colour-swatch"), "a palette opens");
  await p.click('#colour-menu [title="Blue"]'); await wait(200);
  same(await p.$("#colour-menu"), null, "and closes once picked");
  await p.click('[data-colour="hilite"]'); await wait(200);
  const shown = await p.evaluate(() => {
    const el = [...document.querySelectorAll("#compose-body *")].reverse().find(e => e.textContent === "copied");
    return { ink: getComputedStyle(el).color, bg: getComputedStyle(el.closest("[data-mark-bg]") || el).backgroundColor };
  });
  same(shown.bg, "rgb(255, 255, 0)", "highlighted while writing, in dark mode");
  same(shown.ink, "rgb(0, 112, 192)", "the blue reads as blue on it");
  same(await p.$eval('[data-colour="fore"]', b => b.style.getPropertyValue("--swatch")), "#0070c0", "the button remembers blue");
  await clear();
  await p.click('#compose-form button[type="submit"]'); await wait(700);
  const sent = (await calls("send_mail"))[0].bodyHtml;
  expect(/color: rgb\(0, 112, 192\)/.test(sent) && /background-color: rgb\(255, 255, 0\)/.test(sent), "sent with the colour and highlight", sent);
  expect(!/data-dark-ink|data-mark-bg|--dark-ink|--mark-bg/.test(sent), "and nothing of Mailroom's own", sent);
  await p.evaluate(() => { document.documentElement.dataset.theme = "light"; });
});

test("the folder pane resizes from its edge, and remembers", { fake: true }, async ({ p }) => {
  const width = () => p.$eval("#folders", e => Math.round(e.getBoundingClientRect().width));
  same(await width(), 220, "starts at 220");
  const h = await (await p.$("#folders-split")).boundingBox();
  await p.mouse.move(h.x + 3, h.y + 200); await p.mouse.down(); await p.mouse.move(h.x + 83, h.y + 200, { steps: 6 }); await p.mouse.up(); await wait(200);
  same(await width(), 300, "dragged wider");
  same(await p.evaluate(() => localStorage.getItem("mailroom-folders-width")), "300", "remembered");
  await p.mouse.move(h.x + 83, h.y + 200); await p.mouse.down(); await p.mouse.move(h.x - 300, h.y + 200, { steps: 6 }); await p.mouse.up(); await wait(200);
  same(await width(), 180, "never narrower than 180");
  await p.click("#folders-split", { count: 2 }); await wait(200);
  same(await width(), 220, "double-click resets");
  expect(await p.$eval(".rail", e => !!e.closest("#folders")), "the view tabs sit in the folder pane");
});

test("Mail, Calendar and People are tabs at the top of the folder pane, with no rail column", { fake: true }, async ({ p }) => {
  const layout = () => p.evaluate(() => {
    const box = id => { const r = document.getElementById(id).getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { x: Math.round(r.x), y: Math.round(r.y) } : null; };
    return {
      folders: Math.round(document.getElementById("folders").getBoundingClientRect().left),
      tabs: ["rail-mail", "rail-cal", "rail-people", "rail-settings"].map(box),
      labels: [...document.querySelectorAll(".rail .tab-label")].map(e => getComputedStyle(e).display !== "none")
    };
  });
  let l = await layout();
  same(l.folders, 0, "the folder pane starts at the window's left edge");
  expect(l.tabs.every(Boolean), "all four buttons are shown with the pane open");
  same(new Set(l.tabs.map(t => t.y)).size, 1, "in one row");
  same(l.labels, [true, false, false], "the open view's tab is named at the default width");
  same(await p.evaluate(() => { const b = document.getElementById("rail-mail"); const i = b.querySelector("svg").getBoundingClientRect(), t = b.querySelector(".tab-label").getBoundingClientRect(); return Math.abs((i.top + i.bottom) / 2 - (t.top + t.bottom) / 2) < 3 && t.left > i.left; }), true, "the label sits beside its icon, not under it");
  same(await p.evaluate(() => { const n = document.querySelector(".rail"); return n.scrollWidth <= n.clientWidth; }), true, "the row fits without overflowing");
  await p.evaluate(() => applyFoldersWidth(320, false)); await wait(200);
  same((await layout()).labels, [true, true, true], "every tab is named in a wide pane");
  same(await p.evaluate(() => { const n = document.querySelector(".rail"); return n.scrollWidth <= n.clientWidth; }), true, "and still fits");
  const overflowAt = [];
  for (let w = 180; w <= 420; w += 4) {
    await p.evaluate(w => applyFoldersWidth(w, false), w); await wait(30);
    if (await p.evaluate(() => { const n = document.querySelector(".rail"); return n.scrollWidth > n.clientWidth; })) overflowAt.push(w);
  }
  same(overflowAt, [], "the row fits at every pane width");
  await p.evaluate(() => applyFoldersWidth(220, false)); await wait(200);
  await p.click("#rail-cal"); await wait(300);
  same(await p.evaluate(() => document.body.dataset.view), "calendar", "Calendar opens");
  await p.click("#rail-mail"); await wait(300);
  await p.click("#hide-folders"); await wait(300);
  l = await layout();
  expect(l.tabs.every(Boolean), "all four buttons are still reachable with the pane closed");
  same(new Set(l.tabs.map(t => t.x)).size, 1, "stacked in a slim column");
  same(await p.$eval("#folders", e => Math.round(e.getBoundingClientRect().width)), 48, "the slim column is 48px");
  await p.click("#rail-people"); await wait(300);
  same(await p.evaluate(() => document.body.dataset.view), "people", "People opens from the slim column");
  await p.click("#rail-settings"); await wait(300);
  same(await p.evaluate(() => document.body.dataset.view), "settings", "Settings opens from the slim column");
  await p.setViewport({ width: 900, height: 800 }); await wait(400);
  l = await layout();
  expect(l.tabs.every(Boolean), "all four buttons are reachable in the one-pane layout");
});

test("viewer: a scanned PDF (CCITT fax images) is drawn, not left blank", { fake: true }, async ({ p }) => {
  // Office copiers save the page as CCITT or JBIG2 images. pdf.js decodes
  // those with a separate module; without it the page came out empty.
  const pdf = fs.readFileSync(path.join(FILES, "scan.pdf")).toString("base64");
  await p.evaluate(b => { window.__preview = { contentType: "application/pdf", data: b }; }, pdf);
  await p.click('.row[data-id="m3"]'); await wait(700);
  await p.click('#reading [data-open-mail-file][data-file-name="plan.pdf"]'); await wait(2500);
  same(await p.$eval("#viewer-pages", e => e.textContent), "1 page", "pdf.js read it");
  const dark = await p.$eval("#viewer .viewer-page", c => {
    const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < data.length; i += 16) if (data[i] < 128) n++;
    return n;
  });
  expect(dark > 1000, "the scanned image is painted", dark);
  await p.evaluate(() => closeViewer());
});

// A PDF of `n` pages, each saying its number. pdf.js rebuilds the
// cross-reference table, so none is written.
const manyPagePdf = (n) => {
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids = [];
  for (let i = 1; i <= n; i++) {
    const text = `BT /F1 36 Tf 72 700 Td (Page ${i}) Tj ET`;
    objs.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objs.length} 0 R >>`);
    kids.push(`${objs.length} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${n} >>`;
  return "%PDF-1.4\n" + objs.map((o, i) => `${i + 1} 0 obj\n${o}\nendobj\n`).join("") + "trailer\n<< /Root 1 0 R /Size " + (objs.length + 1) + " >>\n%%EOF\n";
};

test("viewer: a long PDF draws only the pages near the view, and is freed on close", { fake: true }, async ({ p }) => {
  await p.evaluate(b => { window.__preview = { contentType: "application/pdf", data: b }; }, Buffer.from(manyPagePdf(40), "latin1").toString("base64"));
  await p.click('.row[data-id="m3"]'); await wait(700);
  await p.click('#reading [data-open-mail-file][data-file-name="plan.pdf"]'); await wait(2500);
  same(await p.$eval("#viewer-pages", e => e.textContent), "40 pages", "pdf.js read it");
  const drawn = () => p.$$eval("#viewer .viewer-page", cs => cs.map((c, i) => c.width > 0 ? i + 1 : 0).filter(Boolean));
  const first = await drawn();
  expect(first[0] === 1 && first.length <= 6, "only the first few pages drawn", first);
  same(await p.$$eval("#viewer .viewer-sheet", s => s.length), 40, "every page has its place");
  await p.$eval("#viewer-body", b => { b.scrollTop = b.scrollHeight; }); await wait(1500);
  const last = await drawn();
  expect(last.includes(40) && !last.includes(1) && last.length <= 6, "the end drawn, the start given back", last);
  expect((await p.$eval("#viewer .viewer-sheet:last-child .textLayer", e => e.textContent)).includes("Page 40"), "its words are there");
  await p.evaluate(() => { window.__pdfTask = viewerDoc.loadingTask; closeViewer(); }); await wait(300);
  same(await p.evaluate(() => [window.__pdfTask.destroyed, viewerDoc]), [true, null], "closing destroys the PDF");
});

test("viewer: a PDF attachment opens inside Mailroom, zooms, downloads, and Esc closes it", { fake: true }, async ({ p, calls, clear }) => {
  const pdf = fs.readFileSync(path.join(FILES, "sample.pdf")).toString("base64");
  await p.evaluate(b => { window.__preview = { contentType: "application/pdf", data: b }; }, pdf);
  await p.click('.row[data-id="m3"]'); await wait(700);
  await clear();
  await p.click('#reading [data-open-mail-file][data-file-name="plan.pdf"]'); await wait(2500);
  same((await calls("attachment_preview")).map(c => c.name), ["plan.pdf"], "fetched for the viewer");
  same(await calls("open_attachment"), [], "not opened in another app");
  same(await p.$eval("#viewer-pages", e => e.textContent), "1 page", "pdf.js read it");
  const w1 = await p.$eval("#viewer .viewer-page", c => c.getBoundingClientRect().width);
  expect(w1 > 300, "the page is drawn", w1);
  const painted = await p.$eval("#viewer .viewer-page", c => {
    const data = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 16) if (data[i] < 250) dark++;
    return dark;
  });
  expect(painted > 20, "the page is painted", painted);
  const words = await p.$eval("#viewer .textLayer", e => e.innerText.replace(/\s+/g, " ").trim());
  expect(words.includes("Colour scheme") && words.includes("Page one of the DLT press."), "the PDF's words are on the page", words);
  same(await p.$eval("#viewer .textLayer span", s => getComputedStyle(s).userSelect), "text", "the words can be highlighted");
  const box = await p.evaluate(() => {
    const span = [...document.querySelectorAll("#viewer .textLayer span")].find(s => s.textContent.trim() && s.getBoundingClientRect().height > 1);
    if (!span) return null;
    const r = span.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, text: span.textContent };
  });
  expect(!!box && box.height > 1, "a word has a place on the page", box);
  await p.mouse.move(box.x + 2, box.y + box.height / 2);
  await p.mouse.down();
  await p.mouse.move(box.x + Math.max(8, box.width - 2), box.y + box.height / 2, { steps: 6 });
  await p.mouse.up();
  const dragged = await p.evaluate(() => getSelection().toString());
  expect(dragged.length > 0, "dragging highlights some text", dragged);
  await p.keyboard.down("Control");
  await p.keyboard.press("a");
  await p.keyboard.up("Control");
  const picked = await p.evaluate(() => {
    const sel = getSelection();
    const node = sel.anchorNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return { text: sel.toString().replace(/\s+/g, " ").trim(), inViewer: !!(el && el.closest("#viewer")) };
  });
  expect(picked.inViewer && picked.text.includes("Colour scheme") && picked.text.includes("DLT press"), "Ctrl+A selects the page", picked);
  const copied = await p.evaluate(() => document.execCommand("copy"));
  expect(copied, "the highlight can be copied");
  await p.click("#viewer-in"); await wait(1500);
  const w2 = await p.$eval("#viewer .viewer-page", c => c.getBoundingClientRect().width);
  expect(w2 > w1 * 1.2, "zoom in makes it bigger", [w1, w2]);
  await p.keyboard.press("Escape"); await wait(200);
  same(await p.$("#viewer"), null, "Esc closes it");
  await p.evaluate(() => { window.__preview = { contentType: "application/zip", data: "UEsDBA==" }; });
  await p.click('#reading [data-open-mail-file][data-file-name="plan.pdf"]'); await wait(600);
  expect((await p.$eval("#viewer-body", e => e.textContent)).includes("can't preview"), "says when it can't preview");
  await p.evaluate(() => closeViewer());
});

test("meeting date and time pickers, as Outlook has them", { fake: true, tz: true }, async ({ p }) => {
  await p.evaluate(() => { localStorage.removeItem("mailroom-meeting-length"); setView("calendar"); }); await wait(800);
  const form = () => p.evaluate(() => { const f = document.getElementById("event-form"); const v = n => f.querySelector("[name=" + n + "]").value; return [v("date"), v("start"), v("enddate"), v("end")]; });
  await p.evaluate(() => openEventForm({ day: dayFromIso("2026-11-24"), start: 13 * 60 })); await wait(300);
  same(await form(), ["2026-11-24", "13:00", "2026-11-24", "13:45"], "a new meeting is 45 minutes by default");
  // Clicking a time opens a list of half hours.
  await p.click("#event-form [name=start]"); await wait(150);
  const starts = await p.$$eval(".time-popup .time-opt", els => els.map(e => e.textContent));
  same([starts.length, starts[0], starts[26], starts[47]], [48, "00:00", "13:00", "23:30"], "the start list is every half hour");
  same(await p.$eval(".time-popup .time-opt.active", e => e.textContent), "13:00", "with the current time picked out");
  await p.evaluate(() => [...document.querySelectorAll(".time-popup .time-opt")].find(e => e.textContent === "14:00").click()); await wait(150);
  same(await p.$(".time-popup"), null, "picking closes the list");
  same(await form(), ["2026-11-24", "14:00", "2026-11-24", "14:45"], "a later start carries the end along");
  // The end list says how long the meeting would be.
  await p.click("#event-form [name=end]"); await wait(150);
  const ends = await p.$$eval(".time-popup .time-opt", els => els.slice(0, 5).map(e => e.textContent));
  same(ends, ["14:15(15 mins)", "14:30(30 mins)", "14:45(45 mins)", "15:00(1 hr)", "15:30(1.5 hrs)"], "the end list shows lengths");
  await p.evaluate(() => [...document.querySelectorAll(".time-popup .time-opt")].find(e => e.textContent.startsWith("15:30")).click()); await wait(150);
  same(await form(), ["2026-11-24", "14:00", "2026-11-24", "15:30"], "picking an end leaves the start alone");
  // The date opens a month; a week on moves the end date too.
  await p.click("#event-form .date-btn"); await wait(150);
  expect(!!(await p.$(".date-popup")), "the date opens a month");
  same(await p.$eval(".date-popup .mini-day.picked", e => e.dataset.pickDate), "2026-11-24", "with the date picked out");
  await p.click('.date-popup [data-pick-date="2026-12-01"]'); await wait(150);
  same(await form(), ["2026-12-01", "14:00", "2026-12-01", "15:30"], "a new start date moves the end date with it");
  same(await p.$eval("#event-form .date-btn", e => e.textContent), "Tue 1 Dec 2026", "and the button shows it");
  // Typed times are read the way people write them.
  await p.click("#event-form [name=start]"); await p.keyboard.press("Escape");
  await p.keyboard.down("Control"); await p.keyboard.press("a"); await p.keyboard.up("Control");
  await p.keyboard.type("3pm");
  await p.click("#event-form [name=title]"); await wait(150);
  same(await form(), ["2026-12-01", "15:00", "2026-12-01", "16:30"], "3pm is 15:00, and the end keeps the length");
  await p.click("#event-form [name=start]"); await p.keyboard.press("Escape");
  await p.keyboard.down("Control"); await p.keyboard.press("a"); await p.keyboard.up("Control");
  await p.keyboard.type("2330");
  await p.click("#event-form [name=title]"); await wait(150);
  same(await form(), ["2026-12-01", "23:30", "2026-12-02", "01:00"], "past midnight the end goes to the next day");
  await p.evaluate(() => closePop());
  // Settings > Calendar sets the length.
  await p.click("#rail-settings"); await wait(200);
  await p.click("#settings-calendar"); await wait(200);
  same(await p.$eval("#meeting-length", e => e.value), "45", "Settings shows 45 minutes");
  await p.select("#meeting-length", "60"); await wait(100);
  await p.evaluate(() => { setView("calendar"); openEventForm({ day: dayFromIso("2026-11-24"), start: 9 * 60 }); }); await wait(300);
  same((await form())[3], "10:00", "a new meeting then lasts an hour");
  await p.evaluate(() => { closePop(); localStorage.removeItem("mailroom-meeting-length"); });
});

test("who's free: each person's day, and times that suit everyone", { fake: true }, async ({ p, calls }) => {
  same(await p.evaluate(() => suggestSlots(["0".repeat(32) + "2".repeat(8) + "0".repeat(56), "0".repeat(40) + "2222" + "0".repeat(52)], 480, 1080, 60, 0, 3)), [660, 690, 720], "free hours after both are busy");
  same(await p.evaluate(() => suggestSlots(["0".repeat(96)], 480, 1080, 30, 615, 2)), [630, 660], "not before now, on the half hour");
  await p.evaluate(() => setView("calendar")); await wait(1000);
  await p.evaluate(() => openEventForm({ day: dayFromDate(todayDate()) + 2, start: 540, end: 600 })); await wait(300);
  same(await p.$eval("#event-schedule", e => e.hidden), true, "hidden with nobody invited");
  await p.type("#event-invite", "Ada"); await wait(200);
  await p.click("#event-suggest button"); await wait(800);
  const req = (await calls("free_busy")).pop();
  same(req.people, ["jon@example.com", "ada@example.org"], "asks for you and Ada");
  const rows = await p.$$eval("#event-schedule .schedule-row", r => r.map(x => x.querySelector(".schedule-name").textContent));
  same(rows, ["You", "Ada Lovelace"], "a row each");
  same(await p.$$eval("#event-schedule .pick", b => b.map(x => x.textContent)), ["11:00–12:00", "11:30–12:30", "12:00–13:00"], "times that suit both");
  await p.click("#event-schedule .pick"); await wait(500);
  same([await p.$eval("[name=start]", e => e.value), await p.$eval("[name=end]", e => e.value)], ["11:00", "12:00"], "a pick sets the time");
  await p.evaluate(() => closePop());
});

test("Focused Inbox: Focused and Other tabs, moves, and always for a sender", { fake: true, setup: () => {
  window.__inbox.push({ id: "news", thread: "conv-news", subject: "Weekly deals", fromName: "Shop", fromEmail: "deals@shop.example", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Deals", bodyHtml: "<p>Deals</p>", unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [], focus: "other" });
} }, async ({ p, calls, clear, rightClick, menu }) => {
  const ids = () => p.$$eval(".row[data-id]", r => r.map(x => x.dataset.id));
  expect(await p.$eval("#focus-tabs", e => !e.hidden), "tabs on the Inbox");
  expect(!(await ids()).includes("news"), "Other mail isn't in Focused");
  same(await p.$eval("#focus-other-count", e => e.textContent.trim()), "1", "Other's unread count");
  await p.click('[data-focus-tab="other"]'); await wait(300);
  same(await ids(), ["news"], "Other shows only it");
  await clear();
  await rightClick('.row[data-id="news"]');
  expect((await menu()).includes("Move to Focused") && (await menu()).includes("Always move to Focused"), "menu offers Focused", await menu());
  await p.click('#row-menu [data-act="focus-focused"]'); await wait(400);
  same((await calls("set_focus")).map(c => [c.messageIds, c.focus, c.alwaysSender]), [[["news"], "focused", ""]], "moved on the server");
  same(await ids(), [], "gone from Other");
  await p.click('[data-focus-tab="focused"]'); await wait(300);
  expect((await ids()).includes("news"), "now in Focused");
  await clear();
  await rightClick('.row[data-id="news"]');
  await p.click('#row-menu [data-act="focus-always-other"]'); await wait(400);
  same((await calls("set_focus")).map(c => [c.focus, c.alwaysSender]), [["other", "deals@shop.example"]], "the sender is sorted to Other from now on");
  await p.evaluate(() => { setView("mail"); showSettings && showSettings("mail"); }); await wait(300);
  await p.click("#focused-on"); await wait(100);
  await p.evaluate(() => setView("mail")); await wait(300);
  expect(await p.$eval("#focus-tabs", e => e.hidden), "turned off: no tabs");
  expect((await ids()).includes("news"), "and everything in one list");
});

test("templates: save one from a message, insert it, edit and delete it in Settings", { fake: true }, async ({ p }) => {
  await p.click("#compose"); await wait(300);
  await p.type("#compose-subject", "Site visit");
  await p.click("#compose-body"); await p.keyboard.type("Thanks for having us on site today.");
  p.once("dialog", d => d.accept("Site visit thanks"));
  await p.click("#compose-templates"); await wait(150);
  await p.click("[data-template-save]"); await wait(300);
  const saved = await p.evaluate(() => loadTemplates());
  same(saved.map(t => [t.name, t.subject]), [["Site visit thanks", "Site visit"]], "saved with its subject");
  expect(saved[0].html.includes("Thanks for having us on site today."), "and its words");
  // A new message: insert it.
  await p.evaluate(() => closePop && closePop());
  await p.click("#compose"); await wait(300);
  await p.click("#compose-templates"); await wait(150);
  await p.click("[data-use-template]"); await wait(300);
  expect((await p.$eval("#compose-body", e => e.textContent)).includes("Thanks for having us on site today."), "inserted into the message");
  same(await p.$eval("#compose-subject", e => e.value), "Site visit", "and fills an empty subject");
  // Settings: edit, then delete.
  await p.evaluate(() => { settingsPage = "templates"; setView("settings"); }); await wait(300);
  await p.click("[data-edit-template]"); await wait(200);
  await p.$eval("[name=name]", e => { e.value = "Site visit follow-up"; });
  await p.click('#template-form button[type="submit"]'); await wait(200);
  same((await p.evaluate(() => loadTemplates())).map(t => t.name), ["Site visit follow-up"], "renamed");
  p.once("dialog", d => d.accept());
  await p.click("[data-drop-template]"); await wait(200);
  same(await p.evaluate(() => loadTemplates()), [], "deleted");
});

test("software: What's new lists this copy's latest changes, each linked to its PR", { fake: true }, async ({ p, calls, clear }) => {
  await p.evaluate(() => showSettings("software")); await wait(600);
  expect(!(await p.$eval("#software-news", e => e.hidden)), "the section shows");
  const rows = await p.$$eval("#software-history li", l => l.map(li => ({ title: li.querySelector(".news-title").textContent.trim(), meta: li.querySelector(".news-meta").textContent.replace(/\s+/g, " ").trim() })));
  same(rows.map(r => r.title), ["Print a message", "rand 0.10; no build warnings", "Mailroom 1.0.0"], "newest first, titles only");
  expect(rows[0].meta.includes("1.1.0") && rows[0].meta.includes("#20"), "version and PR number beside it", rows[0].meta);
  same(await p.$$eval("#software-history [data-news-pr]", b => b.length), 2, "a link only where there is a PR");
  await clear();
  await p.click('#software-history [data-news-pr="20"]'); await wait(200);
  same(await calls("open_link"), [{ url: "https://github.com/jonspinks/mailroom/pull/20" }], "the number opens the pull request");
  // More than eight: the rest fold under Earlier changes.
  await p.evaluate(() => { window.__news = Array.from({ length: 12 }, (_, i) => ({ date: "2026-11-0" + (1 + (i % 9)), title: "Change " + i, version: "", pr: 0 })); showSettings("software"); }); await wait(600);
  same(await p.$$eval("#software-news > #software-history li", l => l.length), 8, "eight shown");
  same(await p.$$eval(".software-earlier li", l => l.length), 4, "four under Earlier changes");
});

test("software: shows an update, updates and restarts", { fake: true }, async ({ p, calls, clear }) => {
  await p.evaluate(() => showSettings("software")); await wait(500);
  expect((await p.$eval("#software-status", e => e.textContent)).includes("0.14.0 is available"), "update shown");
  same(await p.$$eval(".software-changes li", l => l.map(x => x.textContent)), ["Settings > Software", "Left-click the tray icon"], "what's new");
  expect(await p.$eval("#settings-software", e => !!e.querySelector(".update-dot")), "dot on Software");
  // The confirm is Mailroom's native dialog (#73): the page asks nothing itself.
  await clear();
  await p.evaluate(() => { window.__updateDeclined = true; });
  await p.click("#software-update"); await wait(300);
  same(await p.$("#choose-layer"), null, "no page dialog to click through");
  same((await calls("run_update")).length, 1, "the backend is asked");
  expect(await p.$eval("#software-update", e => !e.hidden), "Cancel in the native dialog leaves things as they were");
  await clear();
  await p.evaluate(() => { window.__updateDeclined = false; });
  await p.click("#software-update"); await wait(300);
  same((await calls("run_update")).length, 1, "update started");
  await p.click("#software-restart"); await wait(150);
  await p.click('#choose-layer [data-choose="yes"]'); await wait(300);
  same((await calls("restart_app")).length, 1, "restart asked for");
  await p.evaluate(() => { window.__update = { current: "0.14.0", latest: "0.14.0", behind: 0, changes: [], localChanges: false, repo: "/x" }; });
  await p.click("#software-check"); await wait(400);
  expect((await p.$eval("#software-status", e => e.textContent)).includes("latest version"), "up to date");
});

test("software: a progress bar follows the update", { fake: true }, async ({ p }) => {
  await p.evaluate(() => { window.__progress = { stage: "fetch", detail: "", elapsed: 1, estimate: 60 }; showSettings("software"); }); await wait(500);
  await p.click("#software-update"); await wait(550);
  expect(await p.$(".update-progress"), "bar shown");
  expect((await p.$eval(".update-progress-text", e => e.textContent)).includes("Getting the new version"), "fetching");
  expect(await p.$eval("#software-update", e => e.disabled), "update button off while running");
  await p.evaluate(() => { window.__progress = { stage: "build", detail: "mailroom", elapsed: 30, estimate: 60 }; }); await wait(1200);
  same(await p.$eval(".update-progress", e => e.getAttribute("aria-valuenow")), "50", "halfway through the build");
  expect((await p.$eval(".update-progress-text", e => e.textContent)).includes("mailroom · about 30 s left"), "crate and time left");
  await p.evaluate(() => showSettings("software")); await wait(300);
  expect(await p.$(".update-progress"), "bar comes back after leaving the page");
  await p.evaluate(() => { window.__progress = { stage: "build", detail: "", elapsed: 5, estimate: 0 }; }); await wait(1200);
  expect(await p.$eval(".update-progress", e => e.classList.contains("unknown")), "no estimate: sliding bar");
  await p.evaluate(() => { window.__progress = { stage: "failed", detail: "", elapsed: 9, estimate: 0 }; window.__updateLog = "error[E0308]: mismatched types"; }); await wait(1200);
  expect(!(await p.$(".update-progress")), "bar gone");
  expect((await p.$eval("#software-status", e => e.textContent)).includes("The update stopped"), "says it stopped");
  expect(await p.$eval("#software-log", e => !e.hidden && e.open), "log opened");
  expect(await p.$eval("#software-update", e => !e.disabled), "can try again");
});

test("a dragged message stays the size of its row", { fake: false }, async ({ p }) => {
  const r = await p.evaluate(() => {
    const row = document.querySelector("#rows .row[data-id]");
    const rect = row.getBoundingClientRect();
    const dt = new DataTransfer();
    row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt, clientX: rect.left + 20, clientY: rect.top + 10 }));
    const ghost = document.querySelector(".mail-ghost");
    const size = ghost && ghost.getBoundingClientRect();
    document.body.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt, clientX: 300, clientY: 400 }));
    const moved = ghost && ghost.getBoundingClientRect();
    row.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    return { want: [Math.round(rect.width), Math.round(rect.height)], got: size && [Math.round(size.width), Math.round(size.height)], at: moved && [Math.round(moved.left), Math.round(moved.top)], left: !!document.querySelector(".mail-ghost") };
  });
  same(r.got, r.want, "ghost is the row's size");
  same(r.at, [280, 390], "ghost follows the pointer, held where it was grabbed");
  expect(!r.left, "ghost gone after the drop");
});

test("settings saved by Nowtlook carry over to Mailroom", { fake: true, setup: () => {
  localStorage.setItem("nowtlook-list-density", "compact");
  localStorage.setItem("nowtlook-theme", "light");
  localStorage.setItem("mailroom-theme", "dark");
} }, async ({ p }) => {
  const r = await p.evaluate(() => ({
    density: listDensity,
    dataDensity: document.body.dataset.listDensity,
    theme: localStorage.getItem("mailroom-theme"),
    left: Object.keys(localStorage).filter(k => k.startsWith("nowtlook-"))
  }));
  same(r.density, "compact", "an old setting is read under its new name");
  same(r.theme, "dark", "a setting already saved under the new name wins");
  same(r.left, [], "no old keys left");
});

test("the empty reading pane shows an envelope", { fake: false }, async ({ p }) => {
  await p.evaluate(() => { selected = null; render(); });
  expect(await p.$(".empty-reading .empty-mark"), "envelope shown");
});

// ---------------------------------------------------------------- Google accounts

test("Google: Add account asks for the Google client, then signs in with Google", { fake: true, setup: () => { window.__fresh = true; } }, async ({ p, calls }) => {
  await wait(400);
  expect(await p.$("#add-account-popup #first-client-id"), "the Microsoft client ID comes first by default");
  await p.click('#add-account-popup .provider-seg [data-provider="google"]'); await wait(300);
  expect(await p.$('#add-account-popup #client-id-step[data-provider="google"] #first-client-secret'), "Google asks for its client ID and secret");
  await p.type('#add-account-popup [name="email"]', "jon@example.com");
  await p.type("#first-client-id", "1234-abc.apps.googleusercontent.com");
  await p.click('#add-account-popup [type="submit"]'); await wait(300);
  expect((await p.$eval("#account-error", e => e.textContent)).includes("googleusercontent"), "a missing secret is refused", await p.$eval("#account-error", e => e.textContent));
  same(await calls("sign_in"), [], "no sign-in yet");
  await p.type("#first-client-secret", "GOCSPX-secret");
  await p.click('#add-account-popup [type="submit"]'); await wait(800);
  same((await calls("save_google_client")).map(a => [a.id, a.secret]).pop(), ["1234-abc.apps.googleusercontent.com", "GOCSPX-secret"], "saved the client");
  same((await calls("save_client_id")).length, 0, "not as a Microsoft client");
  same((await calls("sign_in")).map(a => a.provider), ["google"], "signs in with Google");
  await wait(600);
  same(await p.evaluate(() => Object.values(accounts).map(a => a.provider)), ["google"], "the account knows it is Google");
});

test("Google: Outlook-only actions stay out of the way", { fake: true, setup: () => { window.__google = true; } }, async ({ p, calls, rightClick, menu }) => {
  same(await p.evaluate(() => Object.values(accounts).map(a => a.provider)), ["google"], "the account is Google");
  await p.click('.row[data-id="m1"]'); await wait(300);
  same(await p.$("#categorize"), null, "no Categorize button");
  await rightClick('.row[data-id="m2"]');
  const items = await menu();
  expect(!items.includes("Categorize…") && !items.includes("Create rule…"), "no Categorize or Create rule", items);
  expect(items.includes("Move to…") && items.includes("Snooze…"), "moving and snoozing stay", items);
  await p.keyboard.press("Escape");
  same((await calls("auto_reply")).length, 0, "no automatic replies check");
  await p.click("#rail-settings"); await wait(200);
  await p.click("#settings-rules"); await wait(200);
  expect((await p.$eval("#settings-body", e => e.textContent)).includes("filters in Gmail"), "rules point to Gmail");
});

test("Google: a move says which folder the mail came from", { fake: true, setup: () => { window.__google = true; } }, async ({ p, calls, boxOf }) => {
  await p.click('.row[data-id="m1"]'); await wait(300);
  await p.click("#move-to"); await wait(200);
  await p.type("#move-filter", "kiln"); await p.keyboard.press("Enter"); await wait(500);
  same(await boxOf("m1"), "f-kiln", "moved");
  same((await calls("apply_mail")).filter(a => a.kind === "move").map(a => [a.destination, a.source]), [["f-kiln", "f-inbox"]], "from the Inbox to Kiln project");
});

test("search anything: people and calendar above the mail, on Enter", { fake: true }, async ({ p }) => {
  same(await p.$eval("#q", e => e.placeholder), "Search mail, people and calendar", "one box for everything");
  await p.evaluate(() => {
    const day = dayFromDate(new Date(Date.now() + 2 * 86400000));
    events.push({ id: "ev-ada-1", title: "Kiln review with Ada", day, start: 600, end: 660, where: "" });
    events.push({ id: "ev-old", title: "Ada intro call", day: day - 30, start: 540, end: 570, where: "" });
    if (!contacts.some(c => c.email === "ada@example.org")) contacts.push({ id: "c-ada", account: Object.keys(accounts)[0], name: "Ada Lovelace", email: "ada@example.org", phone: "", title: "", company: "" });
  });
  await p.click("#q"); await p.keyboard.type("ada"); await wait(300);
  same(await p.$eval("#search-extras", e => e.hidden), true, "nothing until Enter");
  await p.keyboard.press("Enter"); await wait(500);
  const strip = await p.evaluate(() => ({
    people: [...document.querySelectorAll("[data-extra-person]")].map(b => b.dataset.extraPerson),
    events: [...document.querySelectorAll("[data-extra-event]")].map(b => b.dataset.extraEvent)
  }));
  expect(strip.people.includes("ada@example.org"), "the person", strip);
  same(strip.events, ["ev-ada-1", "ev-old"], "coming up first, then past");
  await p.click('[data-extra-event="ev-ada-1"]'); await wait(600);
  same(await p.evaluate(() => view), "calendar", "an event opens the calendar");
  await p.evaluate(() => { closePop && closePop(); setView("mail"); }); await wait(300);
  await p.click('[data-extra-person="ada@example.org"]'); await wait(500);
  same(await p.evaluate(() => [view, contacts.find(c => c.id === selectedContact)?.email]), ["people", "ada@example.org"], "a person opens their contact");
  same(await p.$eval("#q", e => e.placeholder), "Search mail, people and calendar", "the box does not change with the view");
});

test("hostile mail: no markup out of its CSS, no hidden pixels, nothing raw sent on", { fake: true }, async ({ p }) => {
  const r = await p.evaluate(() => {
    const box = document.createElement("div");
    box.innerHTML = fittedMailHtml(`<html><head><style><a title='</style></head><body><p>Hi</p><!--'></template><img id=pwn1 src="https://evil.example/t.gif">--></body></html>`, false, null);
    const kept = sanitizeMailHtml(`<html><head><style></</stylestyle><img id=pwn2 src=x></style></head><body>x</body></html>`, true);
    const pixels = remoteMailHtml(`<img src="ht&#9;tps://evil.example/a.gif"><img src="\\\\evil.example/b.gif"><div style="background:url(ht\\9 tps://evil.example/c.gif)">y</div>`, false).html;
    const sent = bodyForSend({ bodyHtml: `<p>hi</p><div class="body-sig" data-sig-src="${encodeURIComponent("<script>x()</script><form action='https://evil.example/'><p>sig</p></form>")}">x</div>` });
    const plain = sanitizeMailHtml("<p>a</p><plaintext><b>b</b>", false);
    return { css: box.querySelector("template.mail-css")?.content.textContent || "", pwn1: !!box.querySelector("#pwn1"), pwn2: kept.includes("<img"), pixels, sent, plain };
  });
  expect(!r.pwn1, "CSS text cannot close its template");
  expect(r.css.includes("<a title='"), "and the CSS itself is kept", r.css);
  expect(!r.pwn2, "a split </style> cannot open markup", r);
  expect(!/evil\.example/.test(r.pixels), "tabs and backslashes do not slip a remote picture past blocking", r.pixels);
  expect(!/<script|<form/.test(r.sent) && r.sent.includes("sig"), "a sender's signature source is cleaned before it is sent on", r.sent);
  same(r.plain, "<p>a</p>", "plaintext cannot swallow the page");
});

// ---------------------------------------------------------------- Unread filter and Graph errors

const unreadPair = () => {
  const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const one = (id, subject) => ({ id, thread: "conv-" + id, subject, fromName: "Forms", fromEmail: "forms@example.org", received: at, preview: subject, bodyHtml: "<p>" + subject + "</p>", unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
  window.__inbox.push(one("u1", "New Submission"), one("u2", "Another Submission"));
};

test("Unread filter: a message you read stays listed until the filter changes, as in Outlook", { fake: true, setup: unreadPair }, async ({ p }) => {
  await p.select("#mail-filter", "unread"); await wait(300);
  await p.click('.row[data-id="u1"]'); await wait(500);
  await p.click('.row[data-id="u2"]'); await wait(500);
  const r = await p.evaluate(() => ({ listed: !!document.querySelector('.row[data-id="u1"]'), read: !messages.find(m => m.id === "u1").unread }));
  expect(r.read, "the first message is marked read", r);
  expect(r.listed, "and is still in the list", r);
  await p.select("#mail-filter", ""); await wait(300);
  await p.select("#mail-filter", "unread"); await wait(300);
  expect(!(await p.$('.row[data-id="u1"]')), "choosing Unread again leaves it out");
});

test("Unread in all folders lists the inboxes only, not Sent, Deleted or filed mail", { fake: true, setup: unreadPair }, async ({ p }) => {
  await p.evaluate(() => {
    const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const account = messages.find(m => m.id === "u1").account;
    ["sent", "trash", "archive"].forEach(box => {
      const row = { id: "x-" + box, thread: "t-" + box, account, box,
        subject: "Unread in " + box, fromName: "Forms", fromEmail: "forms@example.org", date: Date.now(), received: at, preview: "", bodyHtml: "", unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], cats: [], categories: [] };
      messages.push(row);
      window.__inbox.push(row);
    });
  });
  await p.click("#search-toggle"); await wait(200);
  await p.select("#search-scope", "all"); await wait(300);
  const all = await p.$$eval(".row[data-id]", rows => rows.map(r => r.dataset.id));
  expect(all.includes("x-archive"), "All folders shows mail outside the inbox", all);
  await p.select("#mail-filter", "unread"); await wait(300);
  const unread = await p.$$eval(".row[data-id]", rows => rows.map(r => r.dataset.id));
  expect(unread.includes("u1") && unread.includes("u2"), "the inbox's unread mail is listed", unread);
  same(unread.filter(id => id.startsWith("x-")), [], "nothing from Sent, Deleted or Archive");
});

test("a message gone from the server is dropped quietly, not shown as a Graph error", { fake: true, setup: unreadPair }, async ({ p, toast, calls }) => {
  // Moved elsewhere: gone from the server's inbox too.
  await p.evaluate(() => { window.__inbox.splice(window.__inbox.findIndex(m => m.id === "u1"), 1); window.__applyFail = 'Graph refused the request (404 Not Found). {"error":{"code":"ErrorItemNotFound","message":"The specified object was not found in the store."}}'; });
  await p.click('.row[data-id="u1"]'); await wait(400);
  await p.click('.row[data-id="u2"]'); await wait(800);
  const r = await p.evaluate(() => ({ banner: document.getElementById("auth-banner").textContent, kept: messages.some(m => m.id === "u1") }));
  expect(!/Graph refused/.test(r.banner), "no raw Graph error in the banner", r.banner);
  expect(!r.kept, "the gone message is dropped", r);
  expect(/moved or deleted elsewhere/.test(await toast()), "and says why", await toast());
  same((await calls("forget_mail")).map(c => c.messageIds)[0], ["u1"], "and dropped from the cache, so it can't come back");
});

test("a throttled server is a toast, not the sign-in banner", { fake: true, setup: unreadPair }, async ({ p, toast }) => {
  await p.evaluate(() => { window.__applyFail = 'Graph refused the request (429 Too Many Requests). {"error":{"code":"ApplicationThrottled","message":"Application is over its MailboxConcurrency limit."}}'; });
  await p.click('.row[data-id="u1"]'); await wait(400);
  await p.click('.row[data-id="u2"]'); await wait(800);
  const r = await p.evaluate(() => ({ banner: document.getElementById("auth-banner").textContent, unread: messages.find(m => m.id === "u1").unread }));
  expect(!/Graph refused|Throttled/.test(r.banner), "no raw Graph error in the banner", r.banner);
  expect(r.unread, "the read mark is put back", r);
  expect(/busy/.test(await toast()), "says the server is busy", await toast());
});

test("the main window stays the main window whatever its URL says", { fake: true, label: "main" }, async ({ p, calls }) => {
  await p.goto(p.url().split(/[?#]/)[0] + "?read=1&msg=m3", { waitUntil: "load" }); await wait(1600);
  const r = await p.evaluate(() => ({ read: document.body.dataset.read || "", side: sideWindow, list: !!document.querySelector('.row[data-id="m1"]') }));
  same(r, { read: "", side: false, list: true }, "a made-up ?read=1 does not turn it into a reading window");
  expect((await calls("sync_inbox")).length > 0, "and it still syncs the mailbox");
});

test("an error banner can be closed; a sign-in banner cannot", { fake: true, setup: unreadPair }, async ({ p }) => {
  await p.evaluate(() => { window.__applyFail = "Microsoft couldn't do that (401)."; });
  await p.click('.row[data-id="u1"]'); await wait(400);
  await p.click('.row[data-id="u2"]'); await wait(800);
  const shown = await p.evaluate(() => ({ hidden: document.getElementById("auth-banner").hidden, text: (document.querySelector("#auth-banner .auth-text") || {}).textContent, close: !!document.querySelector("#auth-banner .auth-close") }));
  same(shown, { hidden: false, text: "Microsoft couldn't do that (401).", close: true }, "the refusal shows, with a close button");
  await p.click("#auth-banner .auth-close"); await wait(200);
  same(await p.evaluate(() => document.getElementById("auth-banner").hidden), true, "closing it clears the banner");
  await p.evaluate(() => { const id = Object.keys(accounts)[0]; accounts[id].signedIn = false; refreshAuthBanner(); });
  same(await p.evaluate(() => [!!document.querySelector("#auth-banner .auth-link"), !!document.querySelector("#auth-banner .auth-close")]), [true, false], "a sign-in prompt has no close button");
});

test("dark mode turns a designed mail over colour by colour, with no filter on the letter", { fake: true, setup: () => {
  // A tall designed mail: a filter on a letter this size vanished in
  // WebKitGTK's GPU compositing (2026-10-26, PetSmart).
  const rows = Array.from({ length: 60 }, (_, i) => `<tr><td style="padding:12px">Line ${i}</td></tr>`).join("");
  const body = `<html><head><style>.hero { background-color: #dc2b34; color: #ffffff; }</style></head><body><table width="600" style="background:#ffffff"><tr><td class="hero" title="hero">Hi Jon</td></tr>${rows}</table><img title="pic" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10"></body></html>`;
  window.__inbox.push({ id: "designed", thread: "conv-designed", subject: "Autoship", fromName: "PetSmart", fromEmail: "p@petsmart.example", received: new Date().toISOString().replace(/\.\d+Z$/, "Z"), preview: "Autoship", bodyHtml: body, unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], categories: [] });
} }, async ({ p }) => {
  await p.evaluate(() => setTheme("dark")); await wait(200);
  await p.click('.row[data-id="designed"]'); await wait(1000);
  const look = () => p.evaluate(() => {
    const letter = document.querySelector("#reading .letter");
    const hero = document.querySelector("#reading [title=hero]");
    const pic = document.querySelector("#reading img[title=pic]");
    return { designed: letter.classList.contains("mail-designed"), filter: getComputedStyle(letter).filter, bg: getComputedStyle(hero).backgroundColor, ink: getComputedStyle(hero).color, picFilter: getComputedStyle(pic).filter };
  });
  const dark = await look();
  expect(dark.designed, "the mail counts as designed", dark);
  same(dark.filter, "none", "no filter on the letter");
  same(dark.picFilter, "none", "pictures are not filtered either");
  same(dark.bg, "rgb(255, 135, 144)", "the red block is turned over as the old filter did");
  same(dark.ink, "rgb(0, 0, 0)", "and its white text with it");
  await p.click("[data-light-view]"); await wait(400);
  const light = await look();
  same([light.bg, light.ink], ["rgb(220, 43, 52)", "rgb(255, 255, 255)"], "the sun shows the mail's own colours");
  await p.click("[data-light-view]"); await wait(400);
  await p.evaluate(() => setTheme("light")); await wait(400);
  const lightTheme = await look();
  same([lightTheme.bg, lightTheme.ink], ["rgb(220, 43, 52)", "rgb(255, 255, 255)"], "the light theme puts them back");
  await p.evaluate(() => setTheme("dark")); await wait(400);
  same((await look()).bg, "rgb(255, 135, 144)", "and dark turns them over again");
});

// ---------------------------------------------------------------- Omarchy

const TOKYO = { theme: "Tokyo Night", mode: "dark", font: "JetBrainsMono Nerd Font", rounding: 0, colors: {
  accent: "#7aa2f7", selection: "#292e42", muted: "#414868", background: "#1a1b26", dark_background: "#13141c", lighter_background: "#24283b",
  foreground: "#a9b1d6", dark_foreground: "#565f89", red: "#f7768e", yellow: "#e0af68", orange: "#eb927b", green: "#9ece6a", cyan: "#449dab",
  blue: "#7aa2f7", magenta: "#ad8ee6", brown: "#75493d", bright_yellow: "#ff9e64", bright_magenta: "#bb9af7" } };

test("off Omarchy, nothing Omarchy shows or changes", { fake: true }, async ({ p, calls }) => {
  const look = await p.evaluate(() => ({
    omarchy: document.documentElement.dataset.omarchy || "",
    rmax: getComputedStyle(document.documentElement).getPropertyValue("--r-max").trim(),
    font: getComputedStyle(document.body).fontFamily
  }));
  same(look.omarchy, "", "no Omarchy flag");
  same(look.rmax, "999px", "corners unchanged");
  expect(look.font.includes("Segoe UI"), "own font", look.font);
  same((await calls("report_unread")).length, 0, "no bar count");
  await p.click("#rail-settings"); await wait(200);
  same(await p.$("#settings-omarchy"), null, "no Omarchy settings");
  await p.click("#settings-appearance"); await wait(200);
  same(await p.$$eval("#theme-choice option", o => o.map(x => x.value)), ["system", "light", "dark"], "no Omarchy theme choice");
});

test("on Omarchy: theme colours, font and corners follow, and change live", { fake: true, setup: `window.__omarchy = ${JSON.stringify(TOKYO)};` }, async ({ p, toast }) => {
  const read = () => p.evaluate(() => {
    const root = document.documentElement;
    const css = getComputedStyle(root);
    const letter = document.createElement("div"); letter.className = "letter"; document.body.appendChild(letter);
    const out = { omarchy: root.dataset.omarchy || "", look: root.dataset.look || "", theme: root.dataset.theme, bg: css.getPropertyValue("--bg").trim(),
      rmax: css.getPropertyValue("--r-max").trim(), chrome: getComputedStyle(document.body).fontFamily, reading: getComputedStyle(letter).fontFamily,
      item: themeNames().omarchy || "" };
    letter.remove();
    return out;
  });
  let got = await read();
  same([got.omarchy, got.look, got.theme, got.bg, got.rmax], ["1", "omarchy", "dark", "#1a1b26", "0px"], "follows Tokyo Night, sharp corners");
  expect(got.chrome.includes("JetBrainsMono Nerd Font"), "chrome in the Omarchy font", got.chrome);
  expect(got.reading.includes("Segoe UI"), "messages keep a reading font", got.reading);
  same(got.item, "Omarchy (Tokyo Night)", "the theme choice names the theme");
  await p.evaluate(() => showSettings("appearance")); await wait(200);
  same(await p.$eval('#theme-choice option[value="omarchy"]', o => o.textContent), "Omarchy (Tokyo Night)", "Settings > Appearance offers it");
  expect((await toast()).includes("Following your Omarchy theme"), "says it follows", await toast());
  await p.evaluate(() => applyOmarchyLook({ theme: "Catppuccin Latte", mode: "light", font: "CaskaydiaMono Nerd Font", rounding: 6,
    colors: { background: "#eff1f5", foreground: "#4c4f69", accent: "#1e66f5", red: "#d20f39", green: "#40a02b" } }));
  got = await read();
  same([got.theme, got.bg, got.rmax], ["light", "#eff1f5", "6px"], "a theme switch arrives live");
  expect(got.chrome.includes("CaskaydiaMono"), "font switch arrives live", got.chrome);
  await p.evaluate(() => showSettings("appearance")); await wait(200);
  await p.select("#theme-choice", "dark"); await wait(100);
  got = await read();
  same([got.look, got.theme, got.bg, got.rmax], ["", "dark", "#1b1a19", "999px"], "Dark is Mailroom's own dark again, with its own corners");
  expect(got.chrome.includes("Segoe UI") && !got.chrome.includes("CaskaydiaMono"), "and its own font, at once", got.chrome);
  await p.select("#theme-choice", "omarchy"); await wait(100);
  got = await read();
  expect(got.chrome.includes("CaskaydiaMono") && got.rmax === "6px", "following again brings Omarchy's font and corners back", got);
  await p.evaluate(() => showSettings("appearance")); await wait(200);
  await p.select("#theme-choice", "dark"); await wait(100);
  const kept = await p.evaluate(look => { applyOmarchyLook(look); return [localStorage.getItem("mailroom-theme"), document.documentElement.dataset.look || ""]; }, TOKYO);
  same(kept, ["dark", ""], "the choice is kept; a theme change does not take it back");
});

test("on Omarchy: the message list can take a proportional font, and keeps it (#137)", { fake: true, setup: `window.__omarchy = ${JSON.stringify(TOKYO)};` }, async ({ p }) => {
  const fonts = () => p.evaluate(() => ({ rows: getComputedStyle(document.getElementById("rows")).fontFamily, folders: getComputedStyle(document.getElementById("folders")).fontFamily, when: (() => { const w = document.querySelector("#rows .when"); return w ? getComputedStyle(w).fontVariantNumeric : ""; })() }));
  let f = await fonts();
  expect(f.rows.includes("JetBrainsMono"), "monospace by default", f.rows);
  await p.evaluate(() => showSettings("omarchy")); await wait(300);
  same(await p.$eval("#omarchy-list-font", e => e.checked), false, "off by default");
  await p.click("#omarchy-list-font"); await wait(100);
  await p.evaluate(() => setView("mail")); await wait(300);
  f = await fonts();
  expect(f.rows.includes("Segoe UI") && !f.rows.includes("JetBrainsMono"), "the list takes the reading font", f.rows);
  expect(f.folders.includes("JetBrainsMono"), "the folder pane keeps the monospace font", f.folders);
  same(f.when, "tabular-nums", "times keep even figures");
  await p.reload({ waitUntil: "load" }); await wait(1200);
  f = await fonts();
  expect(f.rows.includes("Segoe UI"), "kept after a reload", f.rows);
});

test("on Omarchy: Settings makes Mailroom the mail app and puts unread in the bar", { fake: true, setup: `window.__omarchy = ${JSON.stringify(TOKYO)};` }, async ({ p, calls, clear }) => {
  const unread = await calls("report_unread");
  expect(unread.length >= 1 && unread[unread.length - 1].count === 3, "reports the inbox's unread count", unread);
  await p.click("#rail-settings"); await wait(200);
  await p.click("#settings-omarchy"); await wait(300);
  const state = () => p.evaluate(() => ({ mail: document.getElementById("omarchy-mail-state").textContent, bar: document.getElementById("omarchy-bar-state").textContent,
    on: !document.getElementById("omarchy-mail-on").hidden, off: !document.getElementById("omarchy-mail-off").hidden }));
  same(await state(), { mail: "Not the mail app", bar: "Not in the bar", on: true, off: false }, "starts as not the mail app");
  await clear();
  await p.click("#omarchy-mail-on"); await wait(200);
  await p.click("#omarchy-bar-on"); await wait(600);
  same((await calls("make_mail_app")).length, 1, "asks to be the mail app");
  same((await calls("add_bar_widget")).length, 1, "asks for the bar widget");
  same(await state(), { mail: "Mailroom is the mail app", bar: "In the bar", on: false, off: true }, "now Mailroom's");
  expect((await calls("report_unread")).length >= 1, "the bar gets a count straight away");
  await p.click("#omarchy-mail-off"); await wait(200);
  same((await state()).mail, "Not the mail app", "can hand mail back");
});

test("a mailto: link opens a filled-in message; --check-mail checks", { fake: true, setup: () => {
  window.__launch = { kind: "compose", to: ["ada@example.org"], cc: ["bob@example.org"], bcc: [], subject: "Site visit", body: "Line one\n<b>Line</b> two" };
} }, async ({ p, calls, clear }) => {
  const form = await p.evaluate(() => {
    const f = document.querySelector("form.pane-compose") || document.getElementById("compose-form");
    return f && { to: f.querySelector("#compose-to").value, cc: f.querySelector("#compose-cc").value, subject: f.querySelector("#compose-subject").value, body: f.querySelector("#compose-body").innerHTML };
  });
  expect(form, "a message is open");
  expect(form.to.includes("ada@example.org") && form.cc.includes("bob@example.org"), "addresses filled in", form);
  same(form.subject, "Site visit", "subject filled in");
  expect(form.body.includes("<p>Line one</p>") && form.body.includes("&lt;b&gt;Line&lt;/b&gt; two"), "body as text, escaped", form.body);
  await clear();
  await p.evaluate(() => openLaunchRequest({ kind: "check" })); await wait(600);
  same((await calls("sync_inbox")).length, 1, "checks for mail");
});

test("Mark as read: when opened is still the default", { fake: true }, async ({ p, calls }) => {
  await p.click('.row[data-id="m2"]'); await wait(400);
  same(await p.evaluate(() => messages.find(m => m.id === "m2").unread), false, "opening it marks it read straight away");
  expect((await calls("apply_mail")).some(a => a.kind === "read" && a.messageIds.includes("m2")), "and on the server");
});

test("Mark as read after 5 seconds: skimming past leaves mail unread", { fake: true, setup: () => { localStorage.setItem("mailroom-mark-read", "delay"); } }, async ({ p }) => {
  const unread = id => p.evaluate(id => messages.find(m => m.id === id).unread, id);
  await p.click('.row[data-id="m1"]'); await wait(1500);
  same(await unread("m1"), true, "not yet read after a second and a half");
  await p.click('.row[data-id="m2"]'); await wait(4500);
  same(await unread("m1"), true, "moving on before 5 seconds leaves it unread");
  await wait(1500);
  same(await unread("m2"), false, "the one left open for 5 seconds is read");
});

test("Mark as read when I move to another message, or never", { fake: true, setup: () => { localStorage.setItem("mailroom-mark-read", "leave"); } }, async ({ p, calls }) => {
  const unread = id => p.evaluate(id => messages.find(m => m.id === id).unread, id);
  await p.click('.row[data-id="m1"]'); await wait(600);
  same(await unread("m1"), true, "still unread while it is open");
  await p.click('.row[data-id="m2"]'); await wait(400);
  same(await unread("m1"), false, "read once the selection moves on");
  same(await unread("m2"), true, "and the new one waits its turn");
  await p.evaluate(() => { markReadWhen = "never"; pendingRead = null; }); // as the Settings choice does
  await p.click('.row[data-id="m3"]'); await wait(400);
  await p.click('.row[data-id="m2"]'); await wait(400);
  same([await unread("m2"), await unread("m3")], [true, true], "never: opening and leaving marks nothing");
  await p.keyboard.down("Control"); await p.keyboard.press("q"); await p.keyboard.up("Control"); await wait(300);
  same(await unread("m2"), false, "Ctrl+Q still marks it read");
});

test("Sort the list: size with its bands and value, from, due date, kept per folder (#121)", { fake: true, setup: () => {
  const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  Object.assign(window.__inbox[0], { flagged: true, due: day(30) });
  Object.assign(window.__inbox[1], { flagged: true, due: day(-1) });
  window.__sizes = [["m1", 2 * 1024 * 1024], ["m2", 6 * 1024 * 1024]];
} }, async ({ p, calls, menu }) => {
  await wait(400);
  const order = () => p.$$eval("#rows .conv-line > .row-wrap > .row", rs => rs.map(r => r.dataset.id));
  const groups = () => p.$$eval("#rows .date-group", gs => gs.map(g => g.textContent.trim()));
  const pick = async sel => { await p.click("#list-sort"); await wait(150); await p.click("#row-menu " + sel); await wait(400); };
  same(await order(), ["m3", "m2", "m1"], "newest first to start with");
  await p.click("#list-sort"); await wait(150);
  same(await menu(), ["Date", "From", "Subject", "Size", "Importance", "Flag due date", "Attachments", "Newest on top", "Oldest on top"], "the Sort by menu");
  await p.evaluate(() => hideRowMenu());
  await pick('[data-sort="size"]');
  expect((await calls("fetch_sizes")).some(c => c.folderId === "f-inbox"), "sizes are asked for", await calls("fetch_sizes"));
  same(await order(), ["m2", "m1", "m3"], "largest on top; no size yet goes last");
  same(await groups(), ["Enormous (over 5 MB)", "Huge (1 to 5 MB)", "Size not known yet"], "size bands, not dates");
  same(await p.$eval('.row[data-id="m2"] .when', e => e.textContent), "6 MB", "the size shows where the time was");
  expect(/Sorted by Size, largest on top, from the 3 messages on this computer/.test(await p.$eval(".list-note", e => e.textContent)), "the footer says what it sorted");
  same((await calls("fetch_sizes")).length, 1, "asked once, not on every paint");
  await pick('[data-sort-way="1"]');
  same(await order(), ["m1", "m2", "m3"], "smallest on top; unknown still last");
  await pick('[data-sort="from"]');
  same(await order(), ["m1", "m3", "m2"], "From: A to Z (Ada, Bob, Maya), as From's own first way");
  same(await groups(), ["A", "B", "M"], "grouped by initial");
  await pick('[data-sort="due"]');
  same(await order(), ["m2", "m1", "m3"], "overdue, then later, then not flagged");
  same(await groups(), ["Overdue", "Due later", "Not flagged"], "grouped by when it's due");
  expect(/^Due /.test(await p.$eval('.row[data-id="m2"] .when', e => e.textContent)), "the due date shows on the row");
  same(await p.evaluate(() => JSON.parse(localStorage.getItem("mailroom-list-sort")).inbox), { by: "due", reverse: false }, "kept for Inbox");
  await p.evaluate(() => openFolder(Object.keys(accounts)[0], "sent", "f-sent", "folder")); await wait(300);
  same(await p.$eval("#list-sort", b => b.title), "Sorted by Date, newest on top", "Sent keeps its own sort");
  await p.evaluate(() => openFolder(Object.keys(accounts)[0], "inbox", "f-inbox", "folder")); await wait(300);
  await pick('[data-sort="date"]');
  same([await order(), await p.evaluate(() => localStorage.getItem("mailroom-list-sort"))], [["m3", "m2", "m1"], "{}"], "back to Date, and nothing kept");
});

test("Settings > Mail: preview text none, 1 line or 2 lines, kept (#122)", { fake: true, setup: () => {
  window.__inbox[2].preview = "A long preview that goes on and on about the site plans, the drawings, the revisions, the schedule, the budget and every other thing a project manager might want to know before the meeting on Thursday";
} }, async ({ p }) => {
  const lines = () => p.$eval('.conv .row[data-id="m3"] .preview', e => {
    const cs = getComputedStyle(e);
    if (cs.display === "none") return 0;
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    return Math.round(e.getBoundingClientRect().height / line);
  });
  await wait(300);
  same(await lines(), 1, "one line by default");
  await p.evaluate(() => showSettings("appearance")); await wait(300);
  await p.select("#list-preview", "2"); await wait(100);
  same(await p.evaluate(() => [listPreview, localStorage.getItem("mailroom-list-preview"), document.body.dataset.listPreview]), ["2", "2", "2"], "picked and stored");
  await p.evaluate(() => setView("mail")); await wait(300);
  same(await lines(), 2, "two lines, cut off after the second");
  await p.evaluate(() => showSettings("appearance")); await wait(300);
  await p.select("#list-preview", "none"); await wait(100);
  await p.evaluate(() => setView("mail")); await wait(300);
  same(await lines(), 0, "none hides it");
});

test("Settings > Appearance holds the theme, density, preview, folder list and reading size; the title bar keeps only the assistant", { fake: true }, async ({ p }) => {
  same(await p.$("#theme-btn"), null, "no theme button in the title bar");
  same(await p.$$eval(".top-actions > *", els => els.map(e => e.id)), ["assist-top"], "the title bar's right side holds only the assistant button");
  await p.click("#rail-settings"); await wait(200);
  await p.click("#settings-appearance"); await wait(200);
  same(await p.$$eval("#settings select", els => els.map(e => e.id)), ["theme-choice", "folder-list", "list-density", "list-preview", "read-size"], "every appearance choice on one page");
  await p.select("#theme-choice", "light"); await wait(100);
  same(await p.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem("mailroom-theme")]), ["light", "light"], "the theme changes and is kept");
  await p.select("#list-density", "compact"); await wait(100);
  same(await p.evaluate(() => document.body.dataset.listDensity), "compact", "density applies");
  await p.evaluate(() => showSettings("mail")); await wait(200);
  same(await p.$("#list-density"), null, "density has left the Mail page");
  await p.evaluate(() => setTheme("dark")); await wait(100);
  await p.evaluate(() => showSettings("appearance")); await wait(200);
  same(await p.$eval("#theme-choice", e => e.value), "dark", "a change from the command bar shows on the page");
  expect(await p.evaluate(() => typeof commandChoices === "function"), "the command bar is there");
});

test("the Settings list has a heading that reads as a title, not a page", { fake: true }, async ({ p }) => {
  await p.evaluate(() => showSettings("mail")); await wait(300);
  const got = await p.evaluate(() => {
    const h = document.querySelector("#folders .settings-nav-title");
    const item = document.querySelector("#folders .nav-item");
    const px = el => parseFloat(getComputedStyle(el).fontSize);
    return { tag: h && h.tagName, text: h && h.textContent, bigger: px(h) > px(item), rule: getComputedStyle(h).borderBottomStyle };
  });
  same(got, { tag: "H2", text: "Settings", bigger: true, rule: "solid" }, "a heading, larger than the pages, with a rule under it");
});

test("Settings > Mail has the Mark as read choice, and it is kept", { fake: true }, async ({ p }) => {
  await p.evaluate(() => showSettings("mail")); await wait(300);
  expect(await p.$("#mark-read-when"), "the choice is on the Mail page");
  await p.select("#mark-read-when", "leave"); await wait(100);
  same(await p.evaluate(() => [markReadWhen, localStorage.getItem("mailroom-mark-read")]), ["leave", "leave"], "picked and stored");
});

test("Sent Items catches up on mail sent elsewhere: on going back, and on each mail check", { fake: true }, async ({ p, calls, clear }) => {
  const acct = await p.evaluate(() => Object.keys(accounts)[0]);
  await p.evaluate(a => openFolder(a, "sent", "f-sent", "folder"), acct); await wait(400);
  same(await p.$$eval(".list .row", r => r.length), 0, "Sent starts empty");
  await p.evaluate(a => openFolder(a, "inbox", "f-inbox", "folder"), acct); await wait(300);
  // Sent from Outlook on the web while Mailroom was open.
  await p.evaluate(() => {
    const at = new Date(Date.now() - 60000).toISOString().replace(/\.\d+Z$/, "Z");
    window.__folderMail = { "f-sent": [{ id: "owa-1", thread: "conv-owa-1", subject: "Agenda for tomorrow", fromName: "Jon", fromEmail: "jon@example.com", received: at, preview: "Agenda", bodyHtml: "", unread: false, flagged: false, hasAttachments: false, files: [], to: [{ name: "Andre", email: "andre@example.org" }], cc: [], bcc: [] }] };
  });
  await clear();
  await p.evaluate(a => openFolder(a, "sent", "f-sent", "folder"), acct); await wait(400);
  expect((await calls("sync_folder")).some(c => c.folderId === "f-sent"), "going back asks the server again");
  same(await p.$$eval(".list .row", r => r.map(x => x.dataset.id)), ["owa-1"], "the message sent elsewhere shows");
  // Left open: the regular check brings the next one, once the gap has passed.
  await p.evaluate(() => {
    folderRefreshAt.clear();
    const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    window.__folderMail["f-sent"] = [{ id: "owa-2", thread: "conv-owa-2", subject: "Draft - Functional spec", fromName: "Jon", fromEmail: "jon@example.com", received: at, preview: "Spec", bodyHtml: "", unread: false, flagged: false, hasAttachments: true, files: [], to: [{ name: "Andre", email: "andre@example.org" }], cc: [], bcc: [] }];
  });
  await p.evaluate(() => pollMail()); await wait(500);
  same(await p.$$eval(".list .row", r => r.map(x => x.dataset.id)), ["owa-2", "owa-1"], "a mail check refreshes the open folder");
  // Back and forth quickly: one request, not one per click.
  await clear();
  await p.evaluate(a => { openFolder(a, "inbox", "f-inbox", "folder"); openFolder(a, "sent", "f-sent", "folder"); }, acct); await wait(300);
  same((await calls("sync_folder")).filter(c => c.folderId === "f-sent").length, 0, "no second request inside the gap");
});

test("Ctrl+Y opens Go to folder: type, arrow, Enter; it works from Calendar too", { fake: true }, async ({ p, calls }) => {
  await p.keyboard.down("Control"); await p.keyboard.press("y"); await p.keyboard.up("Control"); await wait(200);
  expect(await p.$(".goto-dialog"), "Ctrl+Y opens the dialog");
  const labels = await p.$$eval(".goto-dialog .goto-name", e => e.map(x => x.textContent));
  expect(labels.includes("Inbox") && labels.includes("Kiln project"), "every folder is listed, subfolders too", labels);
  await p.type("#goto-filter", "kil"); await wait(100);
  same(await p.$$eval(".goto-dialog .goto-name", e => e.map(x => x.textContent)), ["Kiln project"], "typing filters the list");
  await p.keyboard.press("Enter"); await wait(400);
  same(await p.evaluate(() => [box, folderPick, !!document.querySelector(".goto-dialog")]), ["f-kiln", "folder", false], "Enter opens it and closes the dialog");
  const fetched = [...await calls("cached_folder"), ...await calls("sync_folder")];
  expect(fetched.some(c => JSON.stringify(c).includes("f-kiln")), "and fetches the folder", fetched);
  await p.evaluate(() => setView("calendar")); await wait(200);
  await p.keyboard.down("Control"); await p.keyboard.press("y"); await p.keyboard.up("Control"); await wait(200);
  await p.type("#goto-filter", "box"); await wait(100);
  await p.keyboard.press("ArrowDown"); await p.keyboard.press("ArrowUp"); await p.keyboard.press("ArrowUp"); await wait(100);
  const picked = await p.$eval('.goto-dialog [aria-selected="true"] .goto-name', e => e.textContent);
  await p.keyboard.press("Enter"); await wait(400);
  same(await p.evaluate(() => view), "mail", "from Calendar it goes back to Mail");
  same(await p.evaluate(() => boxLabel(box, account)), picked, "the highlighted folder opens, after wrapping round");
  await p.keyboard.down("Control"); await p.keyboard.press("y"); await p.keyboard.up("Control"); await wait(200);
  await p.keyboard.press("Escape"); await wait(100);
  same(await p.$(".goto-dialog"), null, "Escape closes it");
  await p.keyboard.press("?"); await wait(200);
  expect(await p.$eval(".shortcuts-dialog", e => e.textContent.includes("Ctrl+Y")), "and it is on the shortcuts list");
});

test("a mailroom: link opens a cached message, at start and while running, and marks nothing read", { fake: true, setup: () => {
  window.__launch = { kind: "open", account: "jon@example.com", id: "m1" };
} }, async ({ p, calls, clear }) => {
  const state = () => p.evaluate(() => ({ view, box, selected, unread: messages.find(m => m.id === selected)?.unread, reading: document.querySelector("#reading").textContent.includes("Kiln schedule") }));
  let got = await state();
  same([got.view, got.box, got.selected, got.unread, got.reading], ["mail", "inbox", "m1", true, true], "cold start: the linked message is open and still unread");
  same((await calls("link_message")).length, 0, "a cached message needs no server call");
  // Already running: somewhere else, then the link arrives.
  await p.evaluate(() => { setView("calendar"); });
  await wait(200);
  await clear();
  await p.evaluate(() => openLaunchRequest({ kind: "open", account: "JON@example.com", id: "m2" })); await wait(500);
  got = await state();
  same([got.view, got.box, got.selected, got.unread], ["mail", "inbox", "m2", true], "running: the second link opens its message");
  expect(await p.evaluate(() => document.querySelector("#reading").textContent.includes("Pipeline review")), "its conversation shows");
  expect(await p.evaluate(() => [...document.querySelectorAll("#reading [data-pick]")].some(c => c.dataset.pick === "m2")), "the message is expanded");
  same((await calls("apply_mail")).length, 0, "nothing is sent to the server: no read, move or flag");
  same((await calls("forget_mail")).length + (await calls("send_mail")).length, 0, "nothing deleted or sent");
});

test("a mailroom: link finds a moved message on the server, or lands in Inbox with a notice", { fake: true, setup: () => {
  const at = new Date(Date.now() - 3 * 86400000).toISOString().replace(/\.\d+Z$/, "Z");
  window.__server = {
    "AAMk+moved/x==": { id: "AAMk+moved/x==", thread: "conv-moved", subject: "Filed quote", fromName: "Ada Lovelace", fromEmail: "ada@example.org", received: at, preview: "Filed", bodyHtml: "", unread: true, flagged: false, hasAttachments: false, files: [], to: [], cc: [], bcc: [], parentFolderId: "f-jobs" }
  };
} }, async ({ p, calls, clear }) => {
  await p.evaluate(() => { box = "sent"; render(); });
  await p.evaluate(() => openLaunchRequest({ kind: "open", account: "jon@example.com", id: "AAMk+moved/x==" })); await wait(600);
  same(await p.evaluate(() => [box, selected, messages.find(m => m.id === selected)?.unread]), ["f-jobs", "AAMk+moved/x==", true], "opened in the folder the server says, still unread");
  same((await calls("link_message")).map(a => a.messageId), ["AAMk+moved/x=="], "asked the server for it by id");
  expect(await p.evaluate(() => document.querySelector("#reading").textContent.includes("Filed quote")), "its conversation shows");

  await p.evaluate(() => { box = "sent"; selected = null; render(); });
  await clear();
  await p.evaluate(() => openLaunchRequest({ kind: "open", account: "jon@example.com", id: "AAMkGone=" })); await wait(600);
  same(await p.evaluate(() => [view, box]), ["mail", "inbox"], "not found: that account's Inbox");
  same(await p.$eval("#toast", t => t.textContent).catch(() => ""), "That message couldn't be found. It may have been deleted or moved.", "and a notice says why");
  same((await calls("apply_mail")).length, 0, "nothing changed on the server");

  await p.evaluate(() => openLaunchRequest({ kind: "badlink", account: "", id: "" })); await wait(200);
  same(await p.$eval("#toast", t => t.textContent).catch(() => ""), "That Mailroom link isn't one Mailroom can open.", "a malformed link is a notice");
  await p.evaluate(() => openLaunchRequest({ kind: "open", account: "someone@else.example", id: "m1" })); await wait(200);
  same(await p.$eval("#toast", t => t.textContent).catch(() => ""), "That link is for an account that isn't in Mailroom.", "another account's link is a notice");
  await p.evaluate(() => openLaunchRequest({ kind: "open", account: "jon@example.com", id: "\");alert(1);(\"<img src=x onerror=window.__pwned=1>" })); await wait(200);
  same(await p.evaluate(() => window.__pwned || null), null, "an id with markup is refused, never run");
  same((await calls("link_message")).length, 1, "and never sent on");
});

test("a snooze that can't be woken is kept and tried again; one that is gone is dropped", { fake: true }, async ({ p, calls, clear }) => {
  await p.evaluate(() => saveSnoozes([{ email: "jon@example.com", ids: ["m1"], until: 1 }]));
  await p.evaluate(() => { window.__applyFail = "Could not reach Microsoft."; return checkSnoozes(); }); await wait(200);
  same(await p.evaluate(() => loadSnoozes().length), 1, "offline: the snooze is still there");
  await p.evaluate(() => { window.__applyFail = "That item is no longer on the server. It may have been moved or deleted."; return checkSnoozes(); }); await wait(200);
  same(await p.evaluate(() => loadSnoozes().length), 0, "moved or deleted elsewhere: nothing left to wake");
  await p.evaluate(() => { window.__applyFail = ""; saveSnoozes([{ email: "jon@example.com", ids: ["m1"], until: 1 }]); });
  await clear();
  await p.evaluate(() => checkSnoozes()); await wait(200);
  same((await calls("apply_mail")).map(a => a.kind), ["inbox", "unread"], "back online it returns, unread");
  same(await p.evaluate(() => loadSnoozes().length), 0, "and is forgotten once back");
});

test("replies answer Reply-To and leave out your own aliases", { fake: true, setup: () => {
  window.__aliases = ["jon.alias@example.com"];
} }, async ({ p }) => {
  await wait(300);
  const r = await p.evaluate(async () => {
    await loadAliases(Object.keys(accounts)[0]);
    const m = messages.find(x => x.id === "m1");
    const plain = replyRecipients(m, false);
    m.replyAddr = "desk@example.org";
    m.to = "jon.alias@example.com; kim@example.org";
    return { plain, one: replyRecipients(m, false), all: replyRecipients(m, true) };
  });
  same(r.plain, "ada@example.org", "no Reply-To: the sender");
  same(r.one, "desk@example.org", "Reply-To wins over From");
  same(r.all, "desk@example.org; kim@example.org", "reply all drops the alias the mail was sent to");
});

test("a large selection goes to the server forty at a time", { fake: true }, async ({ p, calls, clear }) => {
  await clear();
  await p.evaluate(() => {
    const base = messages.find(x => x.id === "m1");
    const many = Array.from({ length: 95 }, (_, i) => Object.assign({}, base, { id: "bulk" + i, thread: "bulk-conv" + i }));
    messages.push(...many);
    return pushMailAction(many, "read");
  }); await wait(200);
  same((await calls("apply_mail")).map(a => a.messageIds.length), [40, 40, 15], "three calls, none over forty");
});

test("mail can't plant the reading pane's buttons, pin itself with a disguised style, or keep stray data- attributes", { fake: true }, async ({ p }) => {
  const out = await p.evaluate(() => htmlFor('<p data-show-remote="m1" data-rsvp="accepted" data-quote-start data-sig="1">x</p><div style="position:/**/fixed;top:0">y</div><div style="pos\\69tion:sticky">z</div>'));
  expect(!/data-show-remote|data-rsvp/.test(out), "the app's button markers are stripped", out);
  expect(/data-quote-start/.test(out) && /data-sig/.test(out), "Mailroom's own body markers stay", out);
  expect(!/fixed|sticky/.test(out), "a commented or escaped position is still removed", out);
});

test("events can span days: the editor has an end date, and opens a spanning event whole (#71)", { fake: true, tz: true }, async ({ p, calls, clear }) => {
  await p.evaluate(() => setView("calendar")); await wait(800);
  const acct = await p.evaluate(() => Object.keys(accounts)[0]);
  // Saving re-reads the calendar from the fake server, which doesn't have
  // these, so they are put back before each open.
  const install = () => p.evaluate(a => installLiveEvents(a, [
    { id: "trip", calendarId: "AAMkCal1", title: "Trip", start: "2026-11-24T22:00:00", end: "2026-11-26T09:30:00", allDay: false, showAs: "busy", isOrganizer: true, attendees: [] },
    { id: "fair", calendarId: "AAMkCal1", title: "Fair", start: "2026-11-24", end: "2026-11-27", allDay: true, showAs: "busy", isOrganizer: true, attendees: [] },
    { id: "late", calendarId: "AAMkCal1", title: "Late", start: "2026-11-24T22:00:00", end: "2026-11-25T00:00:00", allDay: false, showAs: "busy", isOrganizer: true, attendees: [] }
  ]), acct);
  const form = () => p.evaluate(() => { const f = document.getElementById("event-form"); const v = n => f.querySelector("[name=" + n + "]").value; return [v("date"), v("start"), v("enddate"), v("end"), f.querySelector("[name=allday]").checked]; });
  // Opened the way a click opens it, through openEventEditor.
  const open = async id => { await install(); await p.evaluate(id => { const timed = events.some(e => e.id === id); openEventEditor(id, timed ? "timed" : "all"); }, id); };
  const save = async () => { await clear(); await p.click('#event-form button[type="submit"]'); await wait(500); const got = (await calls("save_event"))[0]; return got; };
  // A timed event, opened on its middle day, shows from its first day to its last.
  await open("trip@2026-11-25"); await wait(200);
  same(await form(), ["2026-11-24", "22:00", "2026-11-26", "09:30", false], "both ends of the trip, whichever day was opened");
  let saved = await save();
  same([saved.fields.start, saved.fields.end], ["2026-11-24T22:00:00", "2026-11-26T09:30:00"], "saved unchanged, it keeps its length");
  // Lengthen it by a day.
  await open("trip@2026-11-25"); await wait(200);
  await p.$eval("#event-form [name=enddate]", e => { e.value = "2026-11-27"; });
  saved = await save();
  same(saved.fields.end, "2026-11-27T09:30:00", "a later end date lengthens it");
  // All day: the end date is the last day, inclusive.
  await open("fair@2026-11-25"); await wait(200);
  const fair = await form();
  same([fair[0], fair[2], fair[4]], ["2026-11-24", "2026-11-26", true], "an all-day event shows its last day, not the day after");
  saved = await save();
  same([saved.fields.start, saved.fields.end, saved.fields.allDay], ["2026-11-24", "2026-11-27", true], "and saves Graph's exclusive end");
  // An end at midnight shows as 24:00 that day and is saved as 00:00 the next.
  await open("late"); await wait(200);
  saved = await save();
  same(saved.fields.end, "2026-11-25T00:00:00", "midnight is written as the next day's 00:00");
  // An end date before the start is refused.
  await open("trip@2026-11-25"); await wait(200);
  await p.$eval("#event-form [name=enddate]", e => { e.value = "2026-11-23"; });
  await clear();
  await p.click('#event-form button[type="submit"]'); await wait(300);
  expect((await p.$eval("#event-error", e => e.textContent)).includes("before the start"), "an end before the start is refused");
  same(await calls("save_event"), [], "and nothing is saved");
});

test("Day view: one day, a day at a time, and a week's day heading opens it (#71)", { fake: true, tz: true }, async ({ p }) => {
  await p.evaluate(() => { setView("calendar"); calView = "work"; calFocus = new Date(2026, 10, 25); render(); }); await wait(500);
  await p.click('.dayhead[data-open-day="' + (await p.evaluate(() => dayFromDate(new Date(2026, 10, 26)))) + '"]'); await wait(400);
  const got = await p.evaluate(() => ({ view: calView, cols: document.querySelectorAll(".dayhead .num").length, days: getComputedStyle(document.querySelector(".calendar")).getPropertyValue("--cal-days").trim(), title: document.querySelector("#cal-range, .cal-range, .range-title") ? (document.querySelector("#cal-range, .cal-range, .range-title").textContent) : rangeTitle(visibleDates()), pressed: document.querySelector('[data-cal-view="day"]').getAttribute("aria-pressed") }));
  same([got.view, got.cols, got.days, got.pressed], ["day", 1, "1", "true"], "Day view shows one column, and its button is on");
  same(got.title, "Thursday 26 November 2026", "titled with the whole date");
  await p.click("#cal-next"); await wait(300);
  same(await p.evaluate(() => rangeTitle(visibleDates())), "Friday 27 November 2026", "next goes a day on");
  await p.click("#cal-prev"); await p.click("#cal-prev"); await wait(300);
  same(await p.evaluate(() => rangeTitle(visibleDates())), "Wednesday 25 November 2026", "and back a day at a time");
  same(await p.$('.dayhead[data-open-day]'), null, "in Day view the heading opens nothing");
  await p.click('[data-cal-view="week"]'); await wait(300);
  same(await p.evaluate(() => [calView, document.querySelectorAll(".dayhead .num").length]), ["week", 7], "the Week button goes back to seven days");
});

test("Work week on a Sunday shows the week ahead; events only share width where they overlap", { fake: true, tz: true }, async ({ p }) => {
  const range = when => p.evaluate(w => { setView("calendar"); calView = "work"; calFocus = new Date(w); render(); const d = visibleDates(); return [d[0].toDateString(), d[d.length - 1].toDateString()]; }, when);
  same(await range("2026-11-22T12:00:00"), ["Mon Nov 23 2026", "Fri Nov 27 2026"], "Sunday 22nd: the coming work week");
  same(await range("2026-11-21T12:00:00"), ["Mon Nov 16 2026", "Fri Nov 20 2026"], "Saturday: still the week just ending");
  same(await range("2026-11-25T12:00:00"), ["Mon Nov 23 2026", "Fri Nov 27 2026"], "a weekday: its own week");
  same(await p.evaluate(() => { calView = "week"; calFocus = new Date("2026-11-22T12:00:00"); return visibleDates()[0].toDateString(); }), "Mon Nov 16 2026", "the full Week view is unchanged");
  // Widths: a meeting alone in the morning keeps the full width though two clash at noon.
  const laid = await p.evaluate(() => layout([
    { id: "zoom", start: 360, end: 420 },
    { id: "a", start: 720, end: 780 },
    { id: "b", start: 750, end: 810 },
    { id: "c", start: 900, end: 960 }
  ]).map(e => [e.id, e.col, e.cols]));
  same(laid, [["zoom", 0, 1], ["a", 0, 2], ["b", 1, 2], ["c", 0, 1]], "only the clashing pair goes side by side");
});

test("Send later: one Monday-morning choice on a Sunday, and names on one line", { fake: true, tz: true }, async ({ p }) => {
  const presets = when => p.evaluate(w => {
    const Real = Date;
    const fixed = Real.parse(w);
    window.Date = class extends Real { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed; } };
    try { return sendLaterPresets().map(x => x.label); } finally { window.Date = Real; }
  }, when);
  same(await presets("2026-11-22T10:00:00"), ["Tomorrow morning"], "Sunday: tomorrow morning is Monday morning, offered once");
  same(await presets("2026-11-25T10:00:00"), ["Tomorrow morning", "Monday morning"], "a Wednesday: both");
  await p.setViewport({ width: 560, height: 800 });
  // A wide monospace theme font, as in the report, where the name wrapped.
  await p.addStyleTag({ content: ".choose-dialog, .choose-dialog * { font-family: monospace !important; font-size: 18px !important; }" });
  await p.evaluate(() => { pickTime("Send later", "The message waits on Microsoft's server, so Mailroom does not need to be open. Until then it is in Outbox, where you can cancel it.", [{ label: "Tomorrow morning", when: new Date(2026, 10, 24, 8) }, { label: "Monday morning", when: new Date(2026, 10, 30, 8) }], "Schedule"); }); await wait(300);
  const lines = await p.$$eval(".time-preset span", els => els.map(e => e.getBoundingClientRect().height > parseFloat(getComputedStyle(e).fontSize) * 1.8 ? 2 : 1));
  same(lines, [1, 1], "each choice's name on one line");
  await p.keyboard.press("Escape");
});

test("hidden calendars stay hidden after a restart", { fake: true }, async ({ p }) => {
  await p.evaluate(() => setView("calendar")); await wait(800);
  const hidden = () => p.evaluate(() => [...hiddenCal]);
  same(await hidden(), [], "nothing hidden to start with");
  await p.evaluate(() => { hiddenCal.add("AAMkCal1"); render(); }); await wait(200);
  same(JSON.parse(await p.evaluate(() => localStorage.getItem("mailroom-hidden-calendars"))), ["AAMkCal1"], "saved as it is hidden");
  await p.reload(); await wait(1500);
  same(await hidden(), ["AAMkCal1"], "still hidden after a restart");
  await p.evaluate(() => { hiddenCal.delete("AAMkCal1"); }); await wait(100);
  await p.reload(); await wait(1500);
  same(await hidden(), [], "and shown again once turned back on");
});

test("opening a .ics file adds its events to the calendar you pick, at the right local time", { fake: true, tz: true }, async ({ p, calls, clear }) => {
  await p.evaluate(() => setView("calendar")); await wait(900);
  await clear();
  await p.evaluate(() => openLaunchRequest({ kind: "ics", file: "trip.ics", events: [
    { summary: "Dubai meeting", location: "DIFC", notes: "Bring deck", allDay: false, start: "2026-11-24T09:00:00", end: "2026-11-24T10:00:00", zone: "Arabian Standard Time", repeats: false },
    { summary: "Call", location: "", notes: "", allDay: false, start: "2026-11-25T15:00:00", end: "2026-11-25T15:45:00", zone: "UTC", repeats: false },
    { summary: "Fair", location: "", notes: "", allDay: true, start: "2026-12-01", end: "2026-12-04", zone: "", repeats: true },
    { summary: "Odd zone", location: "", notes: "", allDay: false, start: "2026-11-26T08:00:00", end: "2026-11-26T09:00:00", zone: "Somewhere/Made Up", repeats: false }
  ] })); await wait(300);
  const shown = await p.evaluate(() => ({ title: document.querySelector("#ics-title")?.textContent, items: [...document.querySelectorAll(".ics-event")].map(e => e.textContent.replace(/\s+/g, " ").trim()), cals: [...document.querySelectorAll("#ics-calendar option")].map(o => o.value) }));
  same(shown.title, "Add to calendar", "the dialog opens");
  expect(shown.items[0].includes("00:00–01:00") && shown.items[0].includes("DIFC"), "Dubai 09:00 shows as 00:00 in Toronto", shown.items[0]);
  expect(shown.items[1].includes("10:00–10:45"), "15:00 UTC shows as 10:00", shown.items[1]);
  expect(shown.items[2].includes("1 Dec") && shown.items[2].includes("3 Dec") && shown.items[2].includes("first one"), "an all-day span to its last day, and the repeat said", shown.items[2]);
  expect(shown.items[3].includes("isn't one Mailroom knows"), "an unknown zone is said, not guessed", shown.items[3]);
  expect(shown.cals.includes("AAMkCal1"), "writable calendars to pick from", shown.cals);
  // Leave out the odd one, pick the calendar, add.
  await p.click('[data-ics="3"]');
  await p.select("#ics-calendar", "AAMkCal1");
  await p.click("#ics-add"); await wait(600);
  const saved = (await calls("save_event")).map(c => [c.calendarId, c.fields.subject, c.fields.start, c.fields.end, c.fields.allDay]);
  same(saved, [
    ["AAMkCal1", "Dubai meeting", "2026-11-24T00:00:00", "2026-11-24T01:00:00", false],
    ["AAMkCal1", "Call", "2026-11-25T10:00:00", "2026-11-25T10:45:00", false],
    ["AAMkCal1", "Fair", "2026-12-01", "2026-12-04", true]
  ], "the three chosen, in local time, to that calendar");
  same(await p.evaluate(() => [view, !!document.querySelector(".ics-dialog")]), ["calendar", false], "and Calendar shows them");
  await p.evaluate(() => openLaunchRequest({ kind: "badics", file: "notes.ics", events: [] })); await wait(200);
  expect((await p.$eval("#toast", e => e.textContent)).includes("no events"), "a file with no events says so");
});

// ---- 1.9: quieter chrome ----

test("the short folder list shows the Inbox and what has something in it; the rest wait under More folders", { fake: true, folders: "short" }, async ({ p }) => {
  const shown = () => p.$$eval("#folder-nav [data-acct][data-box], #folders [data-acct][data-box]", els => [...new Set(els.map(e => e.dataset.box))]);
  const first = await shown();
  expect(first.includes("inbox"), "the Inbox is always there", first);
  expect(!first.includes("sent") && !first.includes("trash") && !first.includes("f-jobs"), "empty and read folders are put away", first);
  await p.click("[data-more-folders]"); await wait(200);
  const all = await shown();
  expect(all.includes("sent") && all.includes("trash") && all.includes("f-jobs"), "More folders brings them back", all);
  await p.click('[data-acct][data-box="sent"]'); await wait(400);
  await p.click("[data-more-folders]"); await wait(200);
  expect((await shown()).includes("sent"), "the folder you are in stays in view when the rest fold away");
  await p.evaluate(() => showSettings("appearance")); await wait(300);
  await p.select("#folder-list", "full"); await wait(200);
  await p.evaluate(() => setView("mail")); await wait(300);
  expect((await shown()).includes("trash"), "Settings > Mail switches back to the full list");
});

test("the reading pane's main actions have words; the rest are under More", { fake: true }, async ({ p, calls, clear }) => {
  await p.click('.row[data-id="m2"]'); await wait(500);
  const labels = await p.$$eval(".read-head .toolbar > .tool-btn .tool-label", els => els.map(e => e.textContent));
  same(labels, ["Reply", "Forward", "Archive", "Delete", "Snooze"], "five labelled actions for mail sent to you alone");
  expect(await p.$eval("#more-menu", e => e.hidden), "More starts closed");
  await clear();
  await p.click("#flag"); await wait(400);
  same((await calls("apply_mail")).map(a => a.kind), ["flag"], "an action under More still works, reached through More");
  expect(await p.$eval("#more-menu", e => e.hidden).catch(() => true), "and choosing it closes the menu");
  await p.evaluate(() => { const m = messages.find(x => x.id === "m1"); m.cc = "kim@example.org"; m.ccPeople = [{ name: "Kim", email: "kim@example.org" }]; });
  await p.click('.row[data-id="m1"]'); await wait(500);
  const wide = await p.$$eval(".read-head .toolbar > .tool-btn .tool-label", els => els.map(e => e.textContent));
  expect(wide.includes("Reply all"), "Reply all joins the bar when there is someone else to answer", wide);
});

test("the list marks unread with a dot, keeps initials out of it, and shows whose mail a line is", { fake: false }, async ({ p }) => {
  const r = await p.evaluate(() => {
    activeProfile = "work"; account = "all"; box = "inbox"; render();
    const one = { dots: document.querySelectorAll("#rows .acct-dot").length };
    accounts.second = { name: "Second", email: "second@example.org", cls: "plum", profile: "work", yourName: "Jon", emails: [], calendars: [] };
    render();
    return {
      one,
      avatars: document.querySelectorAll("#rows .avatar").length,
      unreadDots: [...document.querySelectorAll("#rows .row.unread .unread-dot")].every(d => getComputedStyle(d).visibility === "visible"),
      readDots: [...document.querySelectorAll("#rows .row:not(.unread) .unread-dot")].every(d => getComputedStyle(d).visibility === "hidden"),
      dots: document.querySelectorAll("#rows .acct-dot").length,
      rows: document.querySelectorAll("#rows .row").length
    };
  });
  same(r.avatars, 0, "no initials in the list");
  expect(r.unreadDots && r.readDots, "a dot for unread, none for read");
  same(r.one.dots, 0, "one account: no account dots");
  expect(r.dots > 0 && r.dots === r.rows, "several accounts in view: every line carries its account's dot", r);
});

test("small grey text reaches 4.5:1 on an Omarchy theme, on the background and on a selected row", { fake: false }, async ({ p }) => {
  const r = await p.evaluate(() => {
    const themes = [["#a9b1d6", "#1a1b26", "#292e42"], ["#4c4f69", "#eff1f5", "#ccd0da"], ["#ebdbb2", "#282828", "#504945"], ["#657b83", "#fdf6e3", "#eee8d5"]];
    return themes.map(([fg, bg, sel]) => { const faint = readableFaint(fg, bg, sel); return [Math.min(hexContrast(faint, bg), hexContrast(faint, sel)) >= 4.5 || faint === fg, faint]; });
  });
  expect(r.every(x => x[0]), "every theme tried gets readable faint text, or the foreground itself", r);
});

test("Ctrl+K opens the command bar: commands, folders and events in one box", { fake: true }, async ({ p }) => {
  await p.keyboard.down("Control"); await p.keyboard.press("k"); await p.keyboard.up("Control"); await wait(200);
  expect(await p.$("#command-input"), "the bar opens");
  expect(await p.$$eval("#command-list [data-command]", els => els.length > 3), "with commands to start from");
  await p.type("#command-input", "calendar"); await wait(150);
  await p.keyboard.press("Enter"); await wait(400);
  same(await p.evaluate(() => view), "calendar", "Enter runs the first match: Go to Calendar");
  await p.click("#command-open"); await wait(200);
  await p.type("#command-input", "jobs"); await wait(150);
  const groups = await p.$$eval("#command-list .move-group", els => els.map(e => e.textContent));
  expect(groups.includes("Folders"), "a folder name finds the folder", groups);
  await p.keyboard.press("Enter"); await wait(500);
  same(await p.evaluate(() => [view, box]), ["mail", "f-jobs"], "and Enter goes there");
  await p.click("#command-open"); await wait(200);
  await p.type("#command-input", "kiln"); await wait(150);
  const last = await p.$$eval("#command-list [data-command]", els => els[els.length - 1].textContent);
  expect(last.includes("Search mail for"), "the last line searches mail for what was typed", last);
  await p.keyboard.press("Escape"); await wait(150);
  expect(!(await p.$("#command-input")), "Escape closes it");
});

test("in Calendar the search box finds events, and Enter opens the nearest", { fake: false }, async ({ p }) => {
  await p.click("#rail-cal"); await wait(400);
  await p.type("#q", "review"); await wait(300);
  const found = await p.$$eval("#q-suggest [data-suggest-event] span", els => els.map(e => e.textContent));
  expect(found.length >= 1 && found.every(t => /review/i.test(t)), "matching events are listed", found);
  same(await p.evaluate(() => [view, query]), ["calendar", ""], "the calendar stays, and mail is not searched");
  await p.click("#q-suggest [data-suggest-event]"); await wait(500);
  expect(await p.$("#pop-root .dialog, #pop-root form"), "choosing one opens the event");
  await p.keyboard.press("Escape"); await wait(200);
  await p.evaluate(() => closePop());
  await p.click("#q"); await p.type("#q", "zzzz"); await wait(300);
  same(await p.$eval("#q-suggest .suggest-none", e => e.textContent.trim()), "No events match.", "nothing found says so");
  expect(await p.$eval("#q-suggest", e => e.textContent.includes("Search mail for")), "and offers to search mail");
});

test("dates read the way people say them, with the whole date on the tooltip", { fake: false }, async ({ p }) => {
  const r = await p.evaluate(() => {
    const at = (days, h) => { const d = new Date(todayDate()); d.setDate(d.getDate() - days); d.setHours(h, 5, 0, 0); return d; };
    const msg = (d) => ({ seq: d.getTime(), time: "x", received: d.toISOString(), date: "" });
    return [messageStamp(msg(at(0, 9))), messageStamp(msg(at(1, 9))), messageStamp(msg(at(5, 9))), messageStampFull(msg(at(5, 9)))];
  });
  expect(/^Today 09:05$/.test(r[0]), "today", r[0]);
  expect(/^Yesterday 09:05$/.test(r[1]), "yesterday", r[1]);
  expect(/, 09:05$/.test(r[2]) && !/\d{4}/.test(r[2]), "this year: no year", r[2]);
  expect(/\d{4}/.test(r[3]), "the tooltip has the year", r[3]);
});

// ---------------------------------------------------------------- runner

const { server, url } = await serve();
const browser = await puppeteer.launch({ executablePath: chromePath(), args: ["--no-sandbox"], env: { ...process.env, TZ: "America/Toronto" } });
let passed = 0, failed = 0;
for (const t of tests.filter(t => t.name.includes(filter))) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  // An action kept under the toolbar's More is reached the way a person
  // reaches it: open More, then choose it.
  const rawClick = page.click.bind(page);
  page.click = async (selector, options) => {
    const under = await page.evaluate((sel) => {
      try { const el = document.querySelector(sel); const menu = el && el.closest("#more-menu"); return !!(menu && menu.hidden); } catch (e) { return false; }
    }, selector).catch(() => false);
    if (under) { await rawClick("#more-actions"); await wait(60); }
    return rawClick(selector, options);
  };
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  // A CSP block names the element that tried, so a failure says where.
  // The sanitiser parses mail in an inert DOMParser document; Chrome can
  // report a blocked handler there (target: that document). Nothing runs, so
  // only blocks on this page count.
  await page.evaluateOnNewDocument(() => {
    document.addEventListener("securitypolicyviolation", e => {
      const t = e.target;
      if (e.violatedDirective === "script-src-attr" && !(t && t.nodeType === 1)) return;
      const where = t && t.nodeType === 1 ? t.outerHTML.slice(0, 160) + " in " + [...(function* (n) { while (n && n.nodeType === 1) { yield n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (n.className && typeof n.className === "string" ? "." + n.className.split(" ")[0] : ""); n = n.parentNode; } })(t)].slice(0, 6).join(" < ") + (t.isConnected ? "" : " (detached)") : String(t);
      (window.__csp = window.__csp || []).push(e.violatedDirective + " " + (e.sample || "") + " · " + where);
    }, true);
  });
  // Each test starts with empty storage; tests share one browser.
  await page.evaluateOnNewDocument(() => {
    if (!sessionStorage.getItem("__fresh")) { localStorage.clear(); sessionStorage.setItem("__fresh", "1"); }
  });
  // Tests reach folders by name, so they start with the full folder list
  // unless they ask for the short one (opts.folders: "short").
  await page.evaluateOnNewDocument((kind) => {
    if (!localStorage.getItem("mailroom-folder-list")) localStorage.setItem("mailroom-folder-list", kind);
  }, t.opts.folders || "full");
  if (t.opts.fake) await page.evaluateOnNewDocument(FAKE);
  if (t.opts.setup) await page.evaluateOnNewDocument(t.opts.setup);
  // Tauri tells the page which window it is in, by the label Rust gave it;
  // the app trusts that, not the URL. Here the URL stands in for Rust.
  await page.evaluateOnNewDocument((forced) => {
    const q = new URLSearchParams(location.search);
    const label = forced || (q.get("compose") ? "compose" : q.get("assist") === "1" ? "assist" : q.get("read") === "1" ? "read" : "main");
    window.__TAURI_INTERNALS__ = Object.assign(window.__TAURI_INTERNALS__ || {}, { metadata: { currentWindow: { label }, currentWebview: { label } } });
  }, t.opts.label || "");
  try {
    await page.goto(url, { waitUntil: "load" });
    await wait(t.opts.fake ? 1600 : 700);
    await t.fn(helpers(page));
    const blocked = await page.evaluate(() => window.__csp || []).catch(() => []);
    expect(!errors.length && !blocked.length, "no page errors", { errors: errors.slice(0, 3), blocked: blocked.slice(0, 5) });
    passed += 1;
    console.log("  ok    " + t.name);
  } catch (err) {
    failed += 1;
    console.log("  FAIL  " + t.name + "\n        " + (err instanceof Failure ? err.message : err.stack));
  }
  await page.close();
}
await browser.close();
server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
