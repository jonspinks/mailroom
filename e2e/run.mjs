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
  same(await page(), { fixed: ["example.com"], removable: [], shared: "" }, "your account's domain is listed, with no Remove");
  await p.type("#safe-sender-input", "Example.com");
  await p.click('#safe-sender-form button[type="submit"]'); await wait(100);
  same(await p.$eval("#safe-sender-error", el => el.textContent), "That is one of your accounts, so it is always safe.", "adding it again explains why");
  same(await p.evaluate(() => { removeSafeSender("@example.com"); return [senderIsSafe("priya@example.com"), JSON.parse(localStorage.getItem("mailroom-safe-senders") || "[]")]; }),
    [true, []], "removing it does nothing, and it is not stored");

  await p.evaluate(() => { installAccount({ id: "acct-gmail", email: "me@gmail.com", name: "Gmail", provider: "google" }); render(); });
  await wait(200);
  const got = await page();
  same(got.fixed, ["example.com"], "a Gmail account does not make gmail.com safe");
  same(got.shared, "Your own address at gmail.com is always safe. Other senders there are not, as anyone can have an address there.", "and says why");
  same(await p.evaluate(() => [senderIsSafe("me@gmail.com"), senderIsSafe("someone@gmail.com"), senderIsSafe("me@hotmail.co.uk"), isPublicMailDomain("timberworks.example")]),
    [true, false, false, false], "your own address is safe; the rest of a public provider is not");

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

test("narrow and reading a message: hover Mail for the list, click Mail or Escape to go back", { fake: false }, async ({ p }) => {
  const vp = p.viewport();
  const shown = sel => p.evaluate(s => { const el = document.querySelector(s); return !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0; }, sel);
  try {
    await p.setViewport({ width: 900, height: 800 }); await wait(150);
    await p.click(".list .row"); await wait(300);
    same(await p.evaluate(() => document.body.dataset.open), "1", "a message is open");
    same([await shown(".shell > .list"), await shown(".reading")], [false, true], "one pane: the message, no list");

    await p.hover("#rail-mail"); await wait(100);
    same([await shown(".shell > .list"), await shown(".shell > .folders")], [true, true], "hovering Mail brings out the list and the folders");
    // Moving from the button onto the list keeps it out.
    const second = await p.evaluate(() => (document.querySelectorAll(".shell > .list .row")[1] || {}).dataset?.id || "");
    expect(second !== "", "there was a second message to pick");
    const row = `.shell > .list .row[data-id="${second}"]`;
    await p.hover(row); await wait(600);
    same(await shown(".shell > .list"), true, "it stays while the pointer is on it");
    await p.click(row); await wait(300);
    same(await p.evaluate(() => document.body.dataset.peek || ""), "", "picking a message puts the list away");
    same(await shown(".reading"), true, "and shows that message");

    await p.hover(".reading"); await wait(600);
    same(await shown(".shell > .list"), false, "away from it, the list hides again");

    await p.click("#rail-mail"); await wait(200);
    same([await shown(".shell > .list"), await p.evaluate(() => document.body.dataset.open)], [true, "0"], "clicking Mail goes back to the list");

    await p.click(".list .row"); await wait(300);
    await p.keyboard.press("Escape"); await wait(200);
    same(await shown(".shell > .list"), true, "Escape goes back to the list too");

    // Settings while a message is open: settings fill the window, no message beside them.
    await p.click(".list .row"); await wait(300);
    await p.click("#rail-settings"); await wait(300);
    same([await shown(".reading"), await shown(".settings")], [false, true], "narrow Settings: the settings, not the open message");
    const box = await p.evaluate(() => { const r = document.querySelector(".settings").getBoundingClientRect(); return [Math.round(r.top), Math.round(r.width)]; });
    expect(box[0] < 200 && box[1] > 400, "settings sit at the top with room to read", JSON.stringify(box));
    await p.click("#rail-mail"); await wait(300);

    await p.setViewport({ width: 1400, height: 800 }); await wait(150);
    await p.hover("#rail-mail"); await wait(100);
    same(await p.evaluate(() => document.body.dataset.peek || ""), "", "wide: no pop-out, everything is already showing");
  } finally {
    if (vp) await p.setViewport(vp);
    await p.evaluate(() => { delete document.body.dataset.peek; });
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
  same([kiln.start, kiln.end], ["09:00", "10:00"], "morning");
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
    banner: document.getElementById("auth-banner").hidden ? "" : document.getElementById("auth-banner").textContent,
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

test("compose: Bullets, Numbers and Link are icons", { fake: true }, async ({ p }) => {
  await p.click("#compose"); await wait(300);
  for (const [cmd, name] of [["insertUnorderedList", "Bullets"], ["insertOrderedList", "Numbers"], ["link", "Link"]]) {
    const b = await p.$eval(`#compose-form .format-bar [data-cmd="${cmd}"]`, e => ({ text: e.textContent.trim(), svg: !!e.querySelector("svg"), label: e.getAttribute("aria-label") }));
    same(b, { text: "", svg: true, label: name }, name + " is an icon with its name for screen readers");
  }
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
  expect(await p.$eval(".rail", e => getComputedStyle(e).borderRightWidth === "1px"), "a hairline by the apps");
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
  await clear();
  await p.click("#software-update"); await wait(150);
  await p.click('#choose-layer [data-choose="yes"]'); await wait(300);
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
  await p.click("#software-update"); await wait(150);
  await p.click('#choose-layer [data-choose="yes"]'); await wait(400);
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
    item: document.getElementById("theme-omarchy").hidden,
    rmax: getComputedStyle(document.documentElement).getPropertyValue("--r-max").trim(),
    font: getComputedStyle(document.body).fontFamily
  }));
  same(look.omarchy, "", "no Omarchy flag");
  same(look.item, true, "no Omarchy theme choice");
  same(look.rmax, "999px", "corners unchanged");
  expect(look.font.includes("Segoe UI"), "own font", look.font);
  same((await calls("report_unread")).length, 0, "no bar count");
  await p.click("#rail-settings"); await wait(200);
  same(await p.$("#settings-omarchy"), null, "no Omarchy settings");
});

test("on Omarchy: theme colours, font and corners follow, and change live", { fake: true, setup: `window.__omarchy = ${JSON.stringify(TOKYO)};` }, async ({ p, toast }) => {
  const read = () => p.evaluate(() => {
    const root = document.documentElement;
    const css = getComputedStyle(root);
    const letter = document.createElement("div"); letter.className = "letter"; document.body.appendChild(letter);
    const out = { omarchy: root.dataset.omarchy || "", look: root.dataset.look || "", theme: root.dataset.theme, bg: css.getPropertyValue("--bg").trim(),
      rmax: css.getPropertyValue("--r-max").trim(), chrome: getComputedStyle(document.body).fontFamily, reading: getComputedStyle(letter).fontFamily,
      item: document.getElementById("theme-omarchy").hidden ? "" : document.getElementById("theme-omarchy").textContent };
    letter.remove();
    return out;
  });
  let got = await read();
  same([got.omarchy, got.look, got.theme, got.bg, got.rmax], ["1", "omarchy", "dark", "#1a1b26", "0px"], "follows Tokyo Night, sharp corners");
  expect(got.chrome.includes("JetBrainsMono Nerd Font"), "chrome in the Omarchy font", got.chrome);
  expect(got.reading.includes("Segoe UI"), "messages keep a reading font", got.reading);
  same(got.item, "Omarchy (Tokyo Night)", "theme menu names the theme");
  expect((await toast()).includes("Following your Omarchy theme"), "says it follows", await toast());
  await p.evaluate(() => applyOmarchyLook({ theme: "Catppuccin Latte", mode: "light", font: "CaskaydiaMono Nerd Font", rounding: 6,
    colors: { background: "#eff1f5", foreground: "#4c4f69", accent: "#1e66f5", red: "#d20f39", green: "#40a02b" } }));
  got = await read();
  same([got.theme, got.bg, got.rmax], ["light", "#eff1f5", "6px"], "a theme switch arrives live");
  expect(got.chrome.includes("CaskaydiaMono"), "font switch arrives live", got.chrome);
  await p.click("#theme-btn"); await wait(100);
  await p.click('#theme-menu [data-theme="dark"]'); await wait(100);
  got = await read();
  same([got.look, got.theme, got.bg, got.rmax], ["", "dark", "#1b1a19", "999px"], "Dark is Mailroom's own dark again, with its own corners");
  expect(got.chrome.includes("Segoe UI") && !got.chrome.includes("CaskaydiaMono"), "and its own font, at once", got.chrome);
  await p.click("#theme-btn"); await wait(100);
  await p.click('#theme-menu [data-theme="omarchy"]'); await wait(100);
  got = await read();
  expect(got.chrome.includes("CaskaydiaMono") && got.rmax === "6px", "following again brings Omarchy's font and corners back", got);
  await p.click("#theme-btn"); await wait(100);
  await p.click('#theme-menu [data-theme="dark"]'); await wait(100);
  const kept = await p.evaluate(look => { applyOmarchyLook(look); return [localStorage.getItem("mailroom-theme"), document.documentElement.dataset.look || ""]; }, TOKYO);
  same(kept, ["dark", ""], "the choice is kept; a theme change does not take it back");
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

// ---------------------------------------------------------------- runner

const { server, url } = await serve();
const browser = await puppeteer.launch({ executablePath: chromePath(), args: ["--no-sandbox"], env: { ...process.env, TZ: "America/Toronto" } });
let passed = 0, failed = 0;
for (const t of tests.filter(t => t.name.includes(filter))) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
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
  if (t.opts.fake) await page.evaluateOnNewDocument(FAKE);
  if (t.opts.setup) await page.evaluateOnNewDocument(t.opts.setup);
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
