// A stand-in backend. Records every call; returns one account's mail.
(() => {
  const iso = (mins) => new Date(Date.now() - mins * 60000).toISOString().replace(/\.\d+Z$/, "Z");
  const person = (name, email) => ({ name, email });
  const msg = (id, from, email, subject, mins, extra) => Object.assign({
    id, thread: "conv-" + id, subject, fromName: from, fromEmail: email, received: iso(mins),
    preview: subject + " preview", bodyHtml: "<p>" + subject + " body</p>", unread: true, flagged: false,
    hasAttachments: false, files: [], to: [person("Jon", "jon@example.com")], cc: [], bcc: []
  }, extra || {});
  const folders = [
    { id: "f-inbox", parentId: "", name: "Inbox", key: "inbox", unread: 3, total: 3, depth: 0 },
    { id: "f-drafts", parentId: "", name: "Drafts", key: "drafts", unread: 0, total: 0, depth: 0 },
    { id: "f-sent", parentId: "", name: "Sent Items", key: "sent", unread: 0, total: 0, depth: 0 },
    { id: "f-bin", parentId: "", name: "Deleted Items", key: "trash", unread: 0, total: 0, depth: 0 },
    { id: "f-jobs", parentId: "", name: "Jobs", key: "f-jobs", unread: 0, total: 0, depth: 0 },
    { id: "f-kiln", parentId: "f-jobs", name: "Kiln project", key: "f-kiln", unread: 0, total: 0, depth: 1 }
  ];
  window.__inbox = [
    msg("m1", "Ada Lovelace", "ada@example.org", "Kiln schedule", 30),
    msg("m2", "Maya Chen", "maya@example.org", "Pipeline review", 20),
    msg("m3", "Bob Stone", "bob@example.org", "Site plans", 10, { hasAttachments: true, files: [{ id: "a1", name: "plan.pdf", size: 1000, contentType: "application/pdf" }, { id: "a2", name: "old.xlsx", size: 1000, contentType: "application/vnd.ms-excel" }] })
  ];
  window.__calls = [];
  window.__draftSerial = 0;
  const answers = {
    account_status: () => window.__fresh && !window.__signedIn ? { configured: !!window.__clientId, googleConfigured: !!window.__googleClient, signedIn: false, email: "", name: "", accounts: [] } : ({ configured: true, googleConfigured: !!window.__google, signedIn: true, email: "jon@example.com", name: "Jon", accounts: [{ email: "jon@example.com", name: "Jon", provider: window.__google ? "google" : "microsoft" }] }),
    google_client_id: () => window.__googleClient || "",
    save_google_client: (a) => { if (!/\.apps\.googleusercontent\.com$/.test(a.id) || !a.secret) return Promise.reject("The Google client ID ends in .apps.googleusercontent.com."); window.__googleClient = a.id; return a.id; },
    client_id: () => window.__fresh ? (window.__clientId || "") : "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    save_client_id: (a) => { if (!/^[0-9a-f-]{36}$/.test(a.id)) return Promise.reject("That is not a client id."); window.__clientId = a.id; return a.id; },
    sign_in: (a) => { window.__signedIn = true; window.__google = a.provider === "google"; return { configured: true, signedIn: true, email: "jon@example.com", name: "Jon", accounts: [{ email: "jon@example.com", name: "Jon", provider: a.provider || "microsoft" }] }; },
    saved_inbox: () => ({ name: "Jon", email: "jon@example.com", messages: [], folders: [], fromCache: true }),
    sync_inbox: () => {
      if (window.__reachLeft) {
        window.__reachLeft -= 1;
        return Promise.reject("Could not reach Google.");
      }
      return window.__slowSync ? new Promise(r => setTimeout(() => r({ name: "Jon", email: "jon@example.com", messages: window.__inbox.map(m => Object.assign({}, m, { bodyHtml: "" })), folders, fromCache: false }), window.__slowSync)) : ({ name: "Jon", email: "jon@example.com", messages: window.__inbox.map(m => Object.assign({}, m, { bodyHtml: "" })), folders, fromCache: false });
    },
    backfill_mail: () => {
      const batches = window.__backfill || [];
      const total = window.__inbox.length + batches.reduce((n, b) => n + b.length, 0);
      const batch = batches.shift();
      if (!batch) return { added: 0, have: window.__inbox.length, total, remaining: 0 };
      // A test lets each batch land with window.__backfillNext().
      return new Promise(r => {
        window.__backfillNext = () => {
          window.__inbox.push(...batch);
          r({ added: batch.length, have: window.__inbox.length, total, remaining: total - window.__inbox.length });
        };
      });
    },
    cached_folder: (a) => (a.boxKey === "inbox" ? window.__inbox : []),
    search_cached: (a) => {
      const words = (a.words || []).map(word => String(word).toLowerCase()).filter(Boolean);
      const phrases = (a.phrases || []).map(word => String(word).toLowerCase()).filter(Boolean);
      const boxKey = a.boxKey || a.box_key || "";
      const files = a.files || "";
      const before = a.before || "";
      const beforeId = a.beforeId || a.before_id || "";
      let list = (window.__inbox || []).slice();
      if (boxKey) list = list.filter(m => (m.box || "inbox") === boxKey);
      list = list.filter(m => {
        const hay = [m.subject, m.fromName, m.fromEmail, m.preview, (m.files || []).map(file => file.name).join(" "), a.accountName || a.account_name || ""].join(" ").toLowerCase();
        if (words.some(word => !hay.includes(word))) return false;
        if (phrases.some(phrase => !hay.includes(phrase))) return false;
        if ((a.unreadOnly || a.unread_only) && !m.unread) return false;
        if ((a.readOnly || a.read_only) && m.unread) return false;
        if ((a.flaggedOnly || a.flagged_only) && !m.flagged) return false;
        if ((a.inviteOnly || a.invite_only) && !m.invite) return false;
        if (files === "yes" && !m.hasAttachments) return false;
        if (files === "no" && m.hasAttachments) return false;
        if (before && !(m.received < before || (m.received === before && m.id < beforeId))) return false;
        return true;
      });
      list.sort((x, y) => (x.received < y.received ? 1 : x.received > y.received ? -1 : (x.id < y.id ? 1 : x.id > y.id ? -1 : 0)));
      const limit = Number(a.limit) > 0 ? Number(a.limit) : 100;
      const more = list.length > limit;
      const messages = list.slice(0, limit).map(m => Object.assign({}, m, { bodyHtml: "" }));
      return { messages, boxes: messages.map(m => m.box || "inbox"), more };
    },
    cached_body: (a) => { const m = window.__inbox.find(x => x.id === a.messageId); return m ? m.bodyHtml : ""; },
    sync_folder: () => [],
    // Server search, 25 a page as Microsoft does; __search is every match.
    search_mail: (a) => {
      const all = window.__search || [];
      const start = a.nextLink ? Number(a.nextLink.split("=")[1]) : 0;
      return { messages: all.slice(start, start + 25), nextLink: start + 25 < all.length ? "skip=" + (start + 25) : "" };
    },
    set_focus: () => null,
    free_busy: (a) => (a.people || []).map(e => {
      const day = "0".repeat(96).split("");
      const busy = (from, to) => { for (let i = from; i < to; i++) day[i] = "2"; };
      if (e === "jon@example.com") busy(32, 40);
      if (e === "ada@example.org") busy(40, 44);
      return e.endsWith("@other.example") ? { email: e, view: "", error: "Not shared" } : { email: e, view: day.join(""), error: "" };
    }),
    attachment_preview: () => window.__preview || { contentType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" },
    inline_images: (a) => (window.__images || {})[a.messageId] || [],
    remote_image: (a) => (window.__remote || {})[a.url] || Promise.reject("The picture could not be fetched."),
    pdf_texts: (a) => (window.__pdfs || []).filter(t => (a.messageIds || []).includes(t.messageId)),
    ask_mail: () => ({ text: window.__answer || "Total $2,802.40" }),
    check_spelling: (a) => (window.__misspelt || []).filter(w => a.text.includes(w.word) && !(a.ignore || []).some(n => n.toLowerCase().includes(w.word.toLowerCase()))),
    unsubscribe_options: (a) => (window.__unsub || {})[a.messageId] || { oneClick: "", web: "", mailto: "", mailtoSubject: "" },
    unsubscribe: (a) => ((window.__unsub || {})[a.messageId] || {}).web && !((window.__unsub || {})[a.messageId] || {}).oneClick ? { how: "open", url: window.__unsub[a.messageId].web } : { how: "done", url: "" },
    spelling: () => ({ enabled: true, languages: ["en_US"], installed: window.__dicts || ["en_CA", "en_GB", "en_US", "en_AG"] }),
    set_spelling: (a) => ({ enabled: a.enabled, languages: a.languages, installed: ["en_GB", "en_US"] }),
    conversation_mail: (a) => ({ messages: (window.__thread || []).filter(m => m.thread === a.conversationId), nextLink: "" }),
    sync_contacts: () => [{ id: "c1", name: "Ada Lovelace", email: "ada@example.org", phone: "", title: "", company: "" }],
    update_contact: (a) => ({ id: a.contactId, name: a.name, email: a.address, phone: a.phone, title: a.title, company: a.company }), delete_contact: () => null,
    mark_folder_read: () => 3, empty_folder: () => 2,
    mail_categories: () => [{ name: "Jobs", color: "preset4" }, { name: "Urgent", color: "preset0" }], set_categories: () => null,
    mail_aliases: () => window.__aliases || [],
    list_search_folders: () => window.__searchFolders || [],
    save_search_folder: (a) => ({ id: "sf-1", name: a.name, filter: "contains(subject,'" + String(a.query || "").replace(/'/g, "''") + "')" }),
    delete_search_folder: () => null,
    mailbox_zone: () => window.__zone || "Pacific Standard Time",
    set_mailbox_zone: (a) => { window.__zone = a.zone; return null; },
    auto_reply: () => window.__autoReply || { status: "disabled", externalAudience: "none", start: "", end: "", internal: "", external: "" },
    set_auto_reply: (a) => { window.__autoReply = a.reply; return null; },
    ensure_folder: () => "f-snoozed",
    whats_new: () => window.__news || [
      { date: "2026-11-09", title: "Print a message", version: "1.1.0", pr: 20 },
      { date: "2026-11-08", title: "rand 0.10; no build warnings", version: "", pr: 12 },
      { date: "2026-11-08", title: "Mailroom 1.0.0", version: "", pr: 0 }
    ],
    check_update: () => window.__update || { current: "0.13.2", latest: "0.14.0", behind: 3, changes: ["Settings > Software", "Left-click the tray icon"], localChanges: false, repo: "/home/user/src/mailroom" },
    run_update: () => null, update_progress: () => window.__progress || { stage: "idle", detail: "", elapsed: 0, estimate: 0 }, update_log: () => window.__updateLog || "", restart_app: () => null,
    mail_rules: () => window.__rules || [], save_rule: (a) => Object.assign({ id: "r" + Math.random().toString(36).slice(2, 6), other: false }, a.rule), delete_rule: () => null,
    people: (a) => a.query ? (["wagstaffe", "wag", "wa"].some(q => a.query.toLowerCase().startsWith(q)) ? [{ name: "Wagstaffe, Jane", email: "jane.wagstaffe@timberworks.example" }] : []) : [{ name: "Priya Shah", email: "priya@timberworks.example" }],
    sync_calendar: () => {
      const d = new Date(); d.setDate(d.getDate() + 1);
      const day = d.toISOString().slice(0, 10);
      const at = (h, m) => { const x = new Date(d); x.setHours(h, m || 0, 0, 0); return x.toISOString().replace(/\.\d+Z$/, "Z"); };
      const ev = (id, extra) => Object.assign({ id, calendarId: "AAMkCal1", title: id, start: at(9), end: at(10), allDay: false, showAs: "busy", location: "", notes: "", organizerName: "", organizerEmail: "", attendees: [], response: "", isOrganizer: true, kind: "singleInstance", seriesMasterId: "" }, extra);
      const soon = new Date(Date.now() + 10 * 60000); soon.setSeconds(0, 0);
      const soonEnd = new Date(soon.getTime() + 30 * 60000);
      const z = d => d.toISOString().replace(/\.\d+Z$/, "Z");
      return { calendars: [{ id: "AAMkCal1", name: "Calendar", color: "auto", isDefault: true, teams: true, canEdit: true }].concat(window.__sharedCal ? [{ id: "AAMkShared", name: "Maya Chen", color: "auto", isDefault: false, teams: false, canEdit: false, owner: "maya@example.org", ownerName: "Maya Chen", isShared: true }] : []), events: [
        ev("Zoom call", { id: "zoom-1", start: at(12), end: at(12, 30), location: "https://us02web.zoom.us/j/8812345?pwd=abc" }),
        ev("Meet call", { id: "meet-1", start: at(13), end: at(13, 30), notes: "Join with Google Meet: https://meet.google.com/abc-defg-hij." }),
        ev("Standup soon", { id: "soon-1", start: z(soon), end: z(soonEnd), reminder: 15, joinUrl: "https://teams.microsoft.com/l/meetup-join/x" }),
        ev("Single", { start: at(9), end: at(10) }),
        ev("Weekly sync", { id: "occ-1", start: at(11), end: at(11, 30), kind: "occurrence", seriesMasterId: "ser-1" }),
        ev("Their meeting", { id: "inv-1", start: at(14), end: at(15), isOrganizer: false, organizerName: "Maya", organizerEmail: "maya@example.org", attendees: [{ name: "Jon", email: "jon@example.com", status: "none" }] }),
        ev("My meeting", { id: "own-1", start: at(16), end: at(17), isOrganizer: true, organizerName: "Jon", organizerEmail: "jon@example.com", attendees: [{ name: "Eve", email: "eve@example.org", status: "accepted" }] })
      ].concat(window.__allDay ? [ev("Halloween", { id: "hol-1", allDay: true, showAs: "free", start: day + "T00:00:00", end: new Date(d.getTime() + 86400000).toISOString().slice(0, 10) + "T00:00:00" })] : []).concat(window.__sharedCal ? [ev("Maya's 1:1s", { id: "shared-1", calendarId: "AAMkShared", start: at(9), end: at(9, 30), isOrganizer: false })] : []) };
    },
    event_series: () => ({ id: "ser-1", start: "2026-10-01T15:00:00", end: "2026-10-01T15:30:00", allDay: false, recurrence: { pattern: { type: "weekly", interval: 1, daysOfWeek: ["thursday"] }, range: { type: "noEnd", startDate: "2026-10-01" } } }),
    save_event: (a) => a.eventId || "new-ev", remove_event: () => null, end_series_before: () => true,
    ai_status: () => window.__ai || { grok: false, claude: false }, message_files: (a) => { const m = window.__inbox.find(x => x.id === a.messageId); return m ? m.files : []; },
    message_invite: (a) => a.messageId === "m2" ? window.__invite || { eventId: "ev-1", subject: "Pipeline review", start: "2026-10-22T15:00:00Z", end: "2026-10-22T15:30:00Z", allDay: false, location: "Room 2", response: "", cancelled: false, organizer: false } : null,
    respond_invite: () => null,
    save_draft: (a) => { const id = a.draftId || ("srv-draft-" + (++window.__draftSerial)); return window.__slowSave ? new Promise(r => setTimeout(() => r(id), 1200)) : id; },
    forget_mail: () => null,
    discard_draft: () => null, send_mail: () => (window.__failSend ? (window.__failSend--, Promise.reject("Microsoft refused that message while listing attachments: Could not find a property named 'contentId'.")) : null), apply_mail: () => (window.__applyFail ? Promise.reject(window.__applyFail) : []), notify_mail: () => null,
    stage_file: (a) => { window.__staged = (window.__staged || 0) + 1; const r = { id: String(window.__staged).padStart(32, "0"), size: Math.floor(a.data.length * 3 / 4) }; return window.__slowStage ? new Promise(ok => setTimeout(() => ok(r), 1500)) : r; },
    // Omarchy: __omarchy is the look on an Omarchy desktop; null elsewhere.
    omarchy_look: () => window.__omarchy || null,
    mail_app_status: () => window.__mailApp || { omarchy: !!window.__omarchy, mailto: false, keys: false, barWidget: false },
    make_mail_app: () => (window.__mailApp = Object.assign({ omarchy: true, barWidget: false }, window.__mailApp, { mailto: true, keys: true })),
    stop_mail_app: () => (window.__mailApp = Object.assign({ omarchy: true, barWidget: false }, window.__mailApp, { mailto: false, keys: false })),
    add_bar_widget: () => (window.__mailApp = Object.assign({ omarchy: true, mailto: false, keys: false }, window.__mailApp, { barWidget: true })),
    remove_bar_widget: () => (window.__mailApp = Object.assign({ omarchy: true, mailto: false, keys: false }, window.__mailApp, { barWidget: false })),
    report_unread: () => null,
    take_launch_request: () => { const r = window.__launch || null; window.__launch = null; return r; },
    "plugin:app|version": () => "0.13.2"
  };
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args) => {
      window.__calls.push([cmd, JSON.parse(JSON.stringify(args || {}))]);
      const answer = answers[cmd];
      return answer ? Promise.resolve(answer(args || {})) : Promise.resolve(null);
    },
    transformCallback: () => 0
  };
  try {
    localStorage.setItem("mailroom-send-delay", "0");
  } catch (e) {}
})();
