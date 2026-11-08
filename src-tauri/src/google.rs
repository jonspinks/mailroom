//! Gmail, for Google accounts: folders, mail, search, changes, sending and
//! drafts, through the Gmail API. Google Calendar is in gcal.rs.
//!
//! Gmail has labels where Outlook has folders. Mailroom shows each label as a
//! folder, and gives every message one home folder so the folder model holds:
//! Trash, Spam and Drafts first, then the Inbox, then the message's own label
//! (the first by id when it has several), then Sent, and otherwise Archive,
//! which is archived mail with no label of its own. So mail that is in the
//! Inbox shows there, and moves to its label's folder when it is archived;
//! Move to a folder files it under that label and out of the folder it was in.
//!
//! Changes come from Gmail's history, kept per folder as `gmail-history:<id>`
//! where Microsoft keeps a delta link.

use crate::attach::{self, StagedRef};
use crate::auth;
use crate::compose::Mode;
use crate::graph::{self, LiveFile, LiveFolder, LiveMessage, LivePerson, MailDelta, MailSearchHit, MailSearchPage, MovedId, OutgoingMail};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

const GMAIL: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD: &str = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
/// The folder for archived mail with no label: Gmail's All Mail, less the rest.
pub const ARCHIVE: &str = "ARCHIVE";
const ARCHIVE_QUERY: &str = "-in:inbox -in:spam -in:trash -in:drafts -in:sent -in:chats";
const HISTORY: &str = "gmail-history:";
const PAGE: &str = "gmail-page:";
/// Messages fetched at once.
const WORKERS: usize = 8;
/// Tries after Google says "too fast" before giving up (about a minute in all).
const RETRIES: u32 = 6;
/// Messages kept for one folder's first sync.
const MAIL_CAP: usize = 600;
/// A fresh Gmail folder shows its newest messages first, then fills in
/// the rest (see `backfill`) so mail appears within seconds.
const FIRST_BATCH: usize = 50;
const BACKFILL_BATCH: usize = 100;
const SEARCH_PAGE: usize = 25;
const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
/// Gmail's limit for the attachments on one message.
const MAX_SEND_BYTES: u64 = 25 * 1024 * 1024;
const OTHER_CATEGORIES: [&str; 4] = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"];

// ---- Requests --------------------------------------------------------------

/// A Gmail or Calendar request; a refusal comes back as (status, Google's
/// reason). Status 0 means Google could not be reached.
pub(crate) fn call(
    client: &reqwest::blocking::Client,
    token: &str,
    method: &str,
    url: &str,
    body: Option<&Value>,
) -> Result<Value, (u16, String)> {
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| (0, String::new()))?;
    let mut request = client.request(method.clone(), url).bearer_auth(token).header("Accept", "application/json");
    request = match body {
        Some(body) => request.json(body),
        None => request.header("Content-Length", "0"),
    };
    let gmail = url.starts_with(GMAIL) || url.starts_with(UPLOAD);
    let mut attempt = 0;
    loop {
        if gmail {
            pace(units(&method, url));
        }
        let response = request
            .try_clone()
            .ok_or((0, String::new()))?
            .send()
            .map_err(|err| (0, err.to_string()))?;
        let status = response.status();
        let retry_after = response
            .headers()
            .get("Retry-After")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok());
        let text = response.text().unwrap_or_default();
        if status.is_success() {
            return Ok(serde_json::from_str(&text).unwrap_or(Value::Null));
        }
        match backoff(status.as_u16(), &text, retry_after, attempt) {
            Some(wait) => {
                // Hold back every Gmail request, not just this one, so the
                // minute's budget can recover.
                if gmail {
                    hold_off(wait, status.as_u16(), &reason(&text));
                } else {
                    std::thread::sleep(wait);
                }
                attempt += 1;
            }
            None => {
                if gmail && attempt > 0 {
                    log(&format!("gmail gave up after {attempt} retries ({}). {}", status.as_u16(), reason(&text)));
                }
                return Err((status.as_u16(), reason(&text)));
            }
        }
    }
}

// ---- Gmail's per-minute budget ----------------------------------------------

/// Gmail allows 15,000 quota units a minute per user (250 a second). Every
/// Gmail request draws from one bucket that refills at well under that, so
/// a first sync of several folders, eight messages at a time, stays inside
/// it instead of being refused part way through.
const UNITS_PER_SEC: f64 = 150.0;
const BURST: f64 = 300.0;
/// After a refusal the pace halves, down to this floor...
const SLOWEST: f64 = 20.0;
/// ...and climbs back by this many units/s for every second without one.
const RECOVER: f64 = 1.0;

struct Bucket {
    units: f64,
    rate: f64,
    at: Option<std::time::Instant>,
    paused_until: Option<std::time::Instant>,
}

static BUCKET: Mutex<Bucket> = Mutex::new(Bucket::new());

impl Bucket {
    const fn new() -> Bucket {
        Bucket { units: BURST, rate: UNITS_PER_SEC, at: None, paused_until: None }
    }

    /// Take `cost` units at `now`, or say how long to wait first.
    fn take(&mut self, now: std::time::Instant, cost: f64) -> Option<std::time::Duration> {
        if let Some(until) = self.paused_until {
            if until > now {
                return Some(until - now);
            }
            self.paused_until = None;
        }
        if let Some(at) = self.at {
            let seconds = now.saturating_duration_since(at).as_secs_f64();
            self.units = (self.units + seconds * self.rate).min(BURST);
            self.rate = (self.rate + seconds * RECOVER).min(UNITS_PER_SEC);
        }
        self.at = Some(now);
        let cost = cost.min(BURST);
        // A hair of slack so rounding can never ask for a zero-length wait.
        if self.units + 1e-6 >= cost {
            self.units = (self.units - cost).max(0.0);
            return None;
        }
        let wait = std::time::Duration::from_secs_f64((cost - self.units) / self.rate);
        Some(wait.max(std::time::Duration::from_millis(1)))
    }

    /// Google said "too fast": nothing goes out until `until`, then the
    /// bucket starts empty and refills at half the pace it had.
    fn pause(&mut self, until: std::time::Instant) {
        self.paused_until = Some(self.paused_until.map_or(until, |old| old.max(until)));
        self.units = 0.0;
        self.rate = (self.rate / 2.0).max(SLOWEST);
        self.at = Some(until);
    }
}

/// Wait until a request costing `cost` units fits Gmail's budget.
fn pace(cost: f64) {
    loop {
        let wait = match BUCKET.lock() {
            Ok(mut bucket) => bucket.take(std::time::Instant::now(), cost),
            Err(_) => None,
        };
        match wait {
            Some(wait) => std::thread::sleep(wait),
            None => return,
        }
    }
}

fn hold_off(wait: std::time::Duration, status: u16, why: &str) {
    let rate = match BUCKET.lock() {
        Ok(mut bucket) => {
            bucket.pause(std::time::Instant::now() + wait);
            bucket.rate
        }
        Err(_) => return,
    };
    log(&format!("gmail refused ({status}), waiting {:.1}s, then {rate:.0} units/s. {why}", wait.as_secs_f64()));
}

/// A line in ~/.local/state/mailroom/mailroom.log. No addresses or mail.
pub(crate) fn log(line: &str) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let dir = std::path::PathBuf::from(home).join(".local").join("state").join("mailroom");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(dir.join("mailroom.log")) {
        let _ = writeln!(file, "{stamp} {line}");
    }
}

/// Gmail's published quota cost of a request.
fn units(method: &reqwest::Method, url: &str) -> f64 {
    let path = url.split('?').next().unwrap_or("");
    let path = path.strip_prefix(GMAIL).or_else(|| path.strip_prefix(UPLOAD)).unwrap_or(path);
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    let get = method == reqwest::Method::GET;
    match parts.as_slice() {
        ["profile"] | ["labels"] | ["labels", _] if get => 1.0,
        ["history"] => 2.0,
        ["threads", _] if get => 10.0,
        ["messages", "batchModify"] | ["messages", "batchDelete"] => 50.0,
        ["messages", "send"] | ["drafts", "send"] => 100.0,
        ["drafts"] if !get => 10.0,
        ["drafts", _] if method == reqwest::Method::PUT => 15.0,
        ["drafts", _] if method == reqwest::Method::DELETE => 10.0,
        ["messages", _] if method == reqwest::Method::DELETE => 10.0,
        _ => 5.0,
    }
}

/// How long to wait before trying again when Google says we are going too
/// fast. Gmail allows 15,000 units a minute per user and a first sync of
/// several folders at once goes over it; that limit clears within a minute,
/// so wait and retry. Daily limits and other refusals are not retried.
fn backoff(status: u16, body: &str, retry_after: Option<u64>, attempt: u32) -> Option<std::time::Duration> {
    if attempt >= RETRIES {
        return None;
    }
    let too_fast = match status {
        429 => true,
        403 => {
            let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
            let reasons: Vec<&str> = value["error"]["errors"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item["reason"].as_str())
                .collect();
            let message = value["error"]["message"].as_str().unwrap_or("");
            reasons.iter().any(|r| matches!(*r, "rateLimitExceeded" | "userRateLimitExceeded"))
                || (message.contains("Quota exceeded") && message.contains("per minute"))
        }
        _ => false,
    };
    if !too_fast {
        return None;
    }
    // 2, 4, 8, 16, 32 s (capped at 60), plus up to a second of jitter so
    // parallel workers do not all come back at the same moment.
    let base = retry_after.unwrap_or(2u64 << attempt).min(60);
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_millis() as u64)
        .unwrap_or(0);
    Some(std::time::Duration::from_millis(base * 1000 + jitter))
}

/// Google's reason from an error body, short and on one line.
pub(crate) fn reason(body: &str) -> String {
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let text = value["error"]["message"]
        .as_str()
        .or_else(|| value["error_description"].as_str())
        .or_else(|| value["error"].as_str())
        .unwrap_or("");
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(200).collect()
}

fn refused((status, why): (u16, String)) -> String {
    match status {
        0 => "Could not reach Google.".into(),
        401 => "Sign in to Google again.".into(),
        _ if why.is_empty() => format!("Google refused the request ({status})."),
        _ => format!("Google refused the request ({status}). {why}"),
    }
}

fn get(client: &reqwest::blocking::Client, token: &str, url: &str) -> Result<Value, String> {
    call(client, token, "GET", url, None).map_err(refused)
}

fn seg(value: &str) -> String {
    graph::path_segment(value.trim())
}

/// Work on several items at once, keeping their order.
fn parallel<T: Sync, R: Send>(items: &[T], work: impl Fn(&T) -> R + Sync) -> Vec<R> {
    if items.len() <= 1 {
        return items.iter().map(&work).collect();
    }
    let next = AtomicUsize::new(0);
    let slots: Mutex<Vec<Option<R>>> = Mutex::new((0..items.len()).map(|_| None).collect());
    std::thread::scope(|scope| {
        for _ in 0..WORKERS.min(items.len()) {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::SeqCst);
                if index >= items.len() {
                    break;
                }
                let result = work(&items[index]);
                if let Ok(mut slots) = slots.lock() {
                    slots[index] = Some(result);
                }
            });
        }
    });
    slots.into_inner().unwrap_or_default().into_iter().flatten().collect()
}

// ---- Dates -----------------------------------------------------------------

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let mp = (month as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// `YYYY-MM-DDTHH:MM:SSZ` for a time in seconds since 1970.
pub(crate) fn iso_from_secs(secs: i64) -> String {
    let days = secs.div_euclid(86400);
    let rest = secs.rem_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// Seconds since 1970 for `YYYY-MM-DDTHH:MM:SS` followed by `Z`, an offset
/// such as `-04:00`, or nothing (taken as UTC). Fractions are ignored.
pub(crate) fn secs_from_iso(stamp: &str) -> Option<i64> {
    let s = stamp.trim();
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut secs = days_from_civil(year, month, day) * 86400;
    if s.len() == 10 {
        return Some(secs);
    }
    if s.as_bytes().get(10) != Some(&b'T') {
        return None;
    }
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19).and_then(|v| v.parse().ok()).unwrap_or(0);
    secs += hour * 3600 + minute * 60 + second;
    let mut rest = s.get(19..).unwrap_or("");
    if let Some(after) = rest.strip_prefix('.') {
        rest = after.trim_start_matches(|c: char| c.is_ascii_digit());
    }
    if rest.is_empty() || rest == "Z" {
        return Some(secs);
    }
    let sign = match rest.as_bytes()[0] {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let oh: i64 = rest.get(1..3)?.parse().ok()?;
    let om: i64 = rest.get(4..6).and_then(|v| v.parse().ok()).unwrap_or(0);
    Some(secs - sign * (oh * 3600 + om * 60))
}

/// The date after a `YYYY-MM-DD`.
fn next_day(date: &str) -> Option<String> {
    let secs = secs_from_iso(date)? + 86400;
    Some(iso_from_secs(secs)[..10].to_string())
}

/// An RFC 2822 date, for the Date header.
fn rfc2822_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86400);
    let (y, m, d) = civil_from_days(days);
    let weekday = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"][days.rem_euclid(7) as usize];
    let month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(m - 1) as usize];
    let rest = secs.rem_euclid(86400);
    format!("{weekday}, {d} {month} {y} {:02}:{:02}:{:02} +0000", rest / 3600, rest % 3600 / 60, rest % 60)
}

// ---- Folders ---------------------------------------------------------------

/// The folder a message lives in, from its labels (see the top of the file).
pub fn home_folder(labels: &[String]) -> String {
    let has = |label: &str| labels.iter().any(|item| item == label);
    for label in ["TRASH", "SPAM", "DRAFT", "INBOX"] {
        if has(label) {
            return label.into();
        }
    }
    if let Some(user) = labels.iter().filter(|label| label.starts_with("Label_")).min() {
        return user.clone();
    }
    if has("SENT") { "SENT".into() } else { ARCHIVE.into() }
}

fn system_folders() -> [(&'static str, &'static str, &'static str); 6] {
    [
        ("INBOX", "inbox", "Inbox"),
        ("DRAFT", "drafts", "Drafts"),
        ("SENT", "sent", "Sent"),
        (ARCHIVE, "archive", "Archive"),
        ("SPAM", "SPAM", "Spam"),
        ("TRASH", "trash", "Trash"),
    ]
}

/// Labels as folders: the system ones first, then the person's own labels
/// in name order, nested where a name has slashes ("Clients/Acme").
pub fn folders_from(labels: &Value, counts: &HashMap<String, (i64, i64)>) -> Vec<LiveFolder> {
    let count = |id: &str| counts.get(id).copied().unwrap_or((0, 0));
    let mut out: Vec<LiveFolder> = system_folders()
        .iter()
        .map(|(id, key, name)| {
            let (unread, total) = count(id);
            LiveFolder { id: (*id).into(), parent_id: String::new(), name: (*name).into(), key: (*key).into(), unread, total, depth: 0 }
        })
        .collect();
    let mut user: Vec<(String, String)> = labels["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|label| label["type"].as_str() == Some("user") && label["labelListVisibility"].as_str() != Some("labelHide"))
        .filter_map(|label| {
            let id = label["id"].as_str()?.trim();
            let name = label["name"].as_str()?.trim();
            (!id.is_empty() && !name.is_empty()).then(|| (id.to_string(), name.to_string()))
        })
        .collect();
    user.sort_by_key(|(_, name)| name.to_lowercase());
    let by_name: HashMap<String, String> = user.iter().map(|(id, name)| (name.clone(), id.clone())).collect();
    for (id, name) in &user {
        let parent = name.rsplit_once('/').and_then(|(head, _)| by_name.get(head)).cloned().unwrap_or_default();
        let shown = if parent.is_empty() { name.clone() } else { name.rsplit('/').next().unwrap_or(name).to_string() };
        let mut depth = 0;
        let mut walk = name.as_str();
        while let Some((head, _)) = walk.rsplit_once('/') {
            if !by_name.contains_key(head) {
                break;
            }
            depth += 1;
            walk = head;
        }
        let (unread, total) = count(id);
        out.push(LiveFolder { id: id.clone(), parent_id: parent, name: shown, key: id.clone(), unread, total, depth: depth.min(4) });
    }
    out
}

fn list_folders(client: &reqwest::blocking::Client, token: &str) -> Result<Vec<LiveFolder>, String> {
    let labels = get(client, token, &format!("{GMAIL}/labels"))?;
    let mut ids: Vec<String> = ["INBOX", "DRAFT", "SENT", "SPAM", "TRASH"].iter().map(|id| id.to_string()).collect();
    for label in labels["labels"].as_array().into_iter().flatten() {
        if label["type"].as_str() == Some("user") {
            if let Some(id) = label["id"].as_str() {
                ids.push(id.to_string());
            }
        }
    }
    ids.truncate(200);
    let counted = parallel(&ids, |id| {
        call(client, token, "GET", &format!("{GMAIL}/labels/{}", seg(id)), None)
            .ok()
            .map(|value| (id.clone(), (value["messagesUnread"].as_i64().unwrap_or(0), value["messagesTotal"].as_i64().unwrap_or(0))))
    });
    let counts: HashMap<String, (i64, i64)> = counted.into_iter().flatten().collect();
    Ok(folders_from(&labels, &counts))
}

// ---- Messages --------------------------------------------------------------

fn header<'a>(part: &'a Value, name: &str) -> &'a str {
    part["headers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|item| item["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)))
        .and_then(|item| item["value"].as_str())
        .unwrap_or("")
}

/// A header parameter, such as the charset in Content-Type.
fn param(value: &str, name: &str) -> String {
    for piece in value.split(';').skip(1) {
        if let Some((key, raw)) = piece.split_once('=') {
            if key.trim().eq_ignore_ascii_case(name) {
                return raw.trim().trim_matches('"').to_string();
            }
        }
    }
    String::new()
}

fn decode_b64url(data: &str) -> Vec<u8> {
    let clean: String = data.chars().filter(|c| !c.is_whitespace() && *c != '=').collect();
    URL_SAFE_NO_PAD.decode(clean.as_bytes()).unwrap_or_default()
}

const CP1252: [char; 32] = [
    '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜',
    '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
];

/// Text in its charset. UTF-8 and ASCII as they are, Latin-1 and Windows-1252
/// byte by byte; anything else is read as UTF-8, mending what isn't.
pub(crate) fn decode_text(bytes: &[u8], charset: &str) -> String {
    match charset.trim().to_ascii_lowercase().as_str() {
        "iso-8859-1" | "iso8859-1" | "latin1" | "latin-1" | "l1" | "windows-1252" | "cp1252" | "iso-8859-15" => {
            bytes
                .iter()
                .map(|b| match *b {
                    0x80..=0x9f => CP1252[(*b - 0x80) as usize],
                    other => other as char,
                })
                .collect()
        }
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// Encoded words (RFC 2047) left in a header, decoded.
pub(crate) fn decode_words(value: &str) -> String {
    if !value.contains("=?") {
        return value.to_string();
    }
    let mut out = String::new();
    let mut rest = value;
    let mut last_was_word = false;
    while let Some(start) = rest.find("=?") {
        let before = &rest[..start];
        if !(last_was_word && before.trim().is_empty()) {
            out.push_str(before);
        }
        let after = &rest[start + 2..];
        let decoded = (|| {
            let (charset, after) = after.split_once('?')?;
            let (kind, after) = after.split_once('?')?;
            let end = after.find("?=")?;
            let text = &after[..end];
            let bytes = match kind.to_ascii_uppercase().as_str() {
                "B" => base64::engine::general_purpose::STANDARD_NO_PAD.decode(text.trim_end_matches('=')).ok()?,
                "Q" => {
                    let raw = text.as_bytes();
                    let mut bytes = Vec::new();
                    let mut i = 0;
                    while i < raw.len() {
                        match raw[i] {
                            b'_' => bytes.push(b' '),
                            b'=' if i + 2 < raw.len() => {
                                bytes.push(u8::from_str_radix(std::str::from_utf8(&raw[i + 1..i + 3]).ok()?, 16).ok()?);
                                i += 2;
                            }
                            other => bytes.push(other),
                        }
                        i += 1;
                    }
                    bytes
                }
                _ => return None,
            };
            Some((decode_text(&bytes, charset.split('*').next().unwrap_or(charset)), start + 2 + charset.len() + 1 + kind.len() + 1 + end + 2))
        })();
        match decoded {
            Some((text, used)) => {
                out.push_str(&text);
                rest = &rest[used..];
                last_was_word = true;
            }
            None => {
                out.push_str("=?");
                rest = after;
                last_was_word = false;
            }
        }
    }
    out.push_str(rest);
    out
}

/// "Ada <ada@example.org>, \"Stone, Bob\" <bob@example.org>, cat@example.org"
pub(crate) fn people(value: &str) -> Vec<LivePerson> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut angle = false;
    let mut pieces = Vec::new();
    for ch in value.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                current.push(ch);
            }
            '<' if !quoted => {
                angle = true;
                current.push(ch);
            }
            '>' if !quoted => {
                angle = false;
                current.push(ch);
            }
            ',' if !quoted && !angle => pieces.push(std::mem::take(&mut current)),
            _ => current.push(ch),
        }
    }
    pieces.push(current);
    for piece in pieces {
        let piece = piece.trim();
        if piece.is_empty() {
            continue;
        }
        let (name, email) = match (piece.rfind('<'), piece.rfind('>')) {
            (Some(open), Some(close)) if close > open => (piece[..open].trim(), piece[open + 1..close].trim()),
            _ => ("", piece),
        };
        if !email.contains('@') {
            continue;
        }
        let name = decode_words(name.trim().trim_matches('"').trim()).replace("\\\"", "\"");
        out.push(LivePerson { name, email: email.to_string() });
        if out.len() >= 200 {
            break;
        }
    }
    out
}

/// What a message's MIME parts hold.
#[derive(Default)]
struct Bodies {
    html: Option<String>,
    text: Option<String>,
    files: Vec<LiveFile>,
    calendar: bool,
    /// A body too large to come inline: (attachmentId, mime type, charset).
    pending: Option<(String, String, String)>,
}

fn walk(part: &Value, out: &mut Bodies, depth: usize) {
    if depth > 12 {
        return;
    }
    let mime = part["mimeType"].as_str().unwrap_or("").to_ascii_lowercase();
    if mime.starts_with("multipart/") {
        for child in part["parts"].as_array().into_iter().flatten() {
            walk(child, out, depth + 1);
        }
        return;
    }
    let filename = part["filename"].as_str().unwrap_or("").trim();
    let disposition = header(part, "Content-Disposition").to_ascii_lowercase();
    let content_id = header(part, "Content-ID");
    let body = &part["body"];
    let charset = param(header(part, "Content-Type"), "charset");
    let is_body_text = (mime == "text/html" || mime == "text/plain") && filename.is_empty() && !disposition.starts_with("attachment");
    if is_body_text {
        let slot = if mime == "text/html" { &mut out.html } else { &mut out.text };
        if slot.is_some() {
            return;
        }
        match body["data"].as_str() {
            Some(data) => *slot = Some(decode_text(&decode_b64url(data), &charset)),
            None => {
                if let Some(id) = body["attachmentId"].as_str() {
                    if out.pending.is_none() || mime == "text/html" {
                        out.pending = Some((id.to_string(), mime.clone(), charset));
                    }
                }
            }
        }
        return;
    }
    // A meeting invite, update or cancellation. text/calendar is the iTIP
    // part; a loose .ics file is the same thing attached by name.
    let calendar_part = mime == "text/calendar" || mime == "application/ics" || filename.to_ascii_lowercase().ends_with(".ics");
    if calendar_part {
        out.calendar = true;
    }
    if filename.is_empty() {
        return;
    }
    // Pictures in the message itself are drawn, not listed.
    let inline_picture = mime.starts_with("image/") && !content_id.is_empty() && !disposition.starts_with("attachment");
    if inline_picture {
        return;
    }
    let id = part["partId"].as_str().unwrap_or("").to_string();
    if id.is_empty() {
        return;
    }
    out.files.push(LiveFile {
        id,
        name: decode_words(filename).chars().take(255).collect(),
        content_type: mime,
        size: body["size"].as_i64().unwrap_or(0),
    });
}

struct CalendarPiece {
    data: String,
    attachment_id: String,
    charset: String,
    /// Lower is a better part. The inline text/calendar part is the invite.
    rank: u8,
}

fn consider_calendar(part: &Value, depth: usize, best: &mut Option<CalendarPiece>) {
    if depth > 12 {
        return;
    }
    let mime = part["mimeType"].as_str().unwrap_or("").to_ascii_lowercase();
    if mime.starts_with("multipart/") {
        for child in part["parts"].as_array().into_iter().flatten() {
            consider_calendar(child, depth + 1, best);
        }
        return;
    }
    let filename = part["filename"].as_str().unwrap_or("").trim();
    let is_cal = mime == "text/calendar" || mime == "application/ics" || filename.to_ascii_lowercase().ends_with(".ics");
    if !is_cal {
        return;
    }
    let data = part["body"]["data"].as_str().unwrap_or("").to_string();
    let attachment_id = part["body"]["attachmentId"].as_str().unwrap_or("").to_string();
    if data.is_empty() && attachment_id.is_empty() {
        return;
    }
    let rank = match (mime.as_str(), data.is_empty()) {
        ("text/calendar", false) => 0,
        ("text/calendar", true) => 1,
        (_, false) => 2,
        _ => 3,
    };
    let replace = match best {
        None => true,
        Some(have) => rank < have.rank,
    };
    if replace {
        *best = Some(CalendarPiece {
            data,
            attachment_id,
            charset: param(header(part, "Content-Type"), "charset"),
            rank,
        });
    }
}

fn best_calendar(payload: &Value) -> Option<CalendarPiece> {
    let mut best = None;
    consider_calendar(payload, 0, &mut best);
    best
}

/// The iCalendar text on a Gmail message, if it is a meeting invite.
/// A message that is not an invite, or that Gmail will not return, is
/// `None`. The bytes are capped: an invite is a short calendar part.
pub(crate) fn message_calendar(email: &str, message_id: &str) -> Result<Option<String>, String> {
    let id = message_id.trim();
    if id.is_empty() || id.len() > 128 || id.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Ok(None);
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let value = match call(&client, &token, "GET", &format!("{GMAIL}/messages/{}?format=full", seg(id)), None) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let Some(piece) = best_calendar(&value["payload"]) else { return Ok(None) };
    let bytes = if !piece.data.is_empty() {
        decode_b64url(&piece.data)
    } else if !piece.attachment_id.is_empty() {
        let url = format!("{GMAIL}/messages/{}/attachments/{}", seg(id), seg(&piece.attachment_id));
        match call(&client, &token, "GET", &url, None) {
            Ok(data) => decode_b64url(data["data"].as_str().unwrap_or("")),
            Err(_) => return Ok(None),
        }
    } else {
        return Ok(None);
    };
    if bytes.is_empty() || bytes.len() > 1_000_000 {
        return Ok(None);
    }
    let text = decode_text(&bytes, &piece.charset);
    if text.to_ascii_uppercase().contains("BEGIN:VEVENT") { Ok(Some(text)) } else { Ok(None) }
}

/// A snippet with Gmail's entities turned back into text.
fn unescape(text: &str) -> String {
    text.replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

fn labels_of(value: &Value) -> Vec<String> {
    value["labelIds"].as_array().into_iter().flatten().filter_map(|l| l.as_str()).map(String::from).collect()
}

/// A message from Gmail's `format=full` answer, with its labels.
pub fn parse_message(value: &Value) -> Option<(LiveMessage, Vec<String>)> {
    let id = value["id"].as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let labels = labels_of(value);
    if labels.iter().any(|l| l == "CHAT") {
        return None;
    }
    let payload = &value["payload"];
    let mut bodies = Bodies::default();
    walk(payload, &mut bodies, 0);
    let body_html = match (&bodies.html, &bodies.text) {
        (Some(html), _) => html.clone(),
        (None, Some(text)) => graph::text_to_html(text),
        _ => String::new(),
    };
    let from = people(header(payload, "From")).into_iter().next().unwrap_or_default();
    let received = value["internalDate"]
        .as_str()
        .and_then(|ms| ms.parse::<i64>().ok())
        .map(|ms| iso_from_secs(ms / 1000))
        .unwrap_or_default();
    let subject = decode_words(header(payload, "Subject").trim());
    let importance = header(payload, "Importance").trim().to_ascii_lowercase();
    let priority = header(payload, "X-Priority").trim().chars().next().unwrap_or('3');
    let in_inbox = labels.iter().any(|l| l == "INBOX");
    let focus = if !in_inbox {
        String::new()
    } else if labels.iter().any(|l| OTHER_CATEGORIES.contains(&l.as_str())) {
        "other".into()
    } else if labels.iter().any(|l| l == "CATEGORY_PERSONAL") {
        "focused".into()
    } else {
        String::new()
    };
    let has_files = !bodies.files.is_empty();
    let message = LiveMessage {
        id: id.to_string(),
        thread: value["threadId"].as_str().unwrap_or(id).to_string(),
        subject: if subject.is_empty() { "(No subject)".into() } else { subject },
        from_name: from.name,
        from_email: from.email,
        received,
        preview: unescape(value["snippet"].as_str().unwrap_or("")),
        body_html,
        unread: labels.iter().any(|l| l == "UNREAD"),
        flagged: labels.iter().any(|l| l == "STARRED"),
        has_attachments: has_files,
        files: bodies.files,
        to: people(header(payload, "To")),
        cc: people(header(payload, "Cc")),
        bcc: people(header(payload, "Bcc")),
        categories: Vec::new(),
        importance: if importance == "high" || priority == '1' || priority == '2' {
            "high".into()
        } else if importance == "low" || priority == '4' || priority == '5' {
            "low".into()
        } else {
            String::new()
        },
        invite: bodies.calendar,
        focus,
    };
    Some((message, labels))
}

/// How far a folder fill walks the MIME tree for file names. A file nested
/// deeper than this is still fetched with the letter when it is opened.
const LIST_PART_DEPTH: usize = 5;

fn mime_part_fields(depth: usize) -> String {
    let here = "partId,mimeType,filename,headers,body(size,attachmentId)";
    if depth == 0 {
        return here.to_string();
    }
    format!("{here},parts({})", mime_part_fields(depth - 1))
}

/// Headers and attachment names for a folder fill. `body.data` is left out
/// of `fields`, so the HTML is not downloaded with the list.
fn list_message_url(id: &str) -> String {
    let fields = format!(
        "id,threadId,labelIds,snippet,internalDate,payload(mimeType,filename,headers,body(size,attachmentId),parts({}))",
        mime_part_fields(LIST_PART_DEPTH)
    );
    format!("{GMAIL}/messages/{}?format=full&fields={}", seg(id), seg(&fields))
}

/// The same parse as a full message, with the letter dropped. A folder fill
/// keeps the preview and the file names and stores no HTML.
fn listed_message(value: &Value) -> Option<(LiveMessage, Vec<String>)> {
    let (mut message, labels) = parse_message(value)?;
    message.body_html.clear();
    Some((message, labels))
}

fn fetch_listed(client: &reqwest::blocking::Client, token: &str, id: &str) -> Result<(LiveMessage, Vec<String>), (u16, String)> {
    let value = call(client, token, "GET", &list_message_url(id), None)?;
    listed_message(&value).ok_or((404, String::new()))
}

/// One message in full. A body Gmail kept apart (a large one) is fetched too.
fn fetch_full(client: &reqwest::blocking::Client, token: &str, id: &str) -> Result<(LiveMessage, Vec<String>), (u16, String)> {
    let value = call(client, token, "GET", &format!("{GMAIL}/messages/{}?format=full", seg(id)), None)?;
    let (mut message, labels) = parse_message(&value).ok_or((404, String::new()))?;
    if message.body_html.is_empty() {
        let mut bodies = Bodies::default();
        walk(&value["payload"], &mut bodies, 0);
        if let Some((attachment, mime, charset)) = bodies.pending {
            let url = format!("{GMAIL}/messages/{}/attachments/{}", seg(id), seg(&attachment));
            if let Ok(data) = call(client, token, "GET", &url, None) {
                let text = decode_text(&decode_b64url(data["data"].as_str().unwrap_or("")), &charset);
                message.body_html = if mime == "text/html" { text } else { graph::text_to_html(&text) };
            }
        }
    }
    Ok((message, labels))
}

/// The HTML of one message, when the cache has only its header.
pub fn message_html(email: &str, id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("That message is not there.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let (message, _) = fetch_full(&client, &token, id).map_err(refused)?;
    Ok(message.body_html)
}

/// Message ids for a folder or a search, newest first, up to `cap`.
fn list_ids(
    client: &reqwest::blocking::Client,
    token: &str,
    label: &str,
    query: &str,
    cap: usize,
    page_token: &str,
) -> Result<(Vec<String>, String), String> {
    let mut ids = Vec::new();
    let mut token_next = page_token.to_string();
    loop {
        let mut url = format!("{GMAIL}/messages?maxResults={}", (cap - ids.len()).clamp(1, 500));
        if !label.is_empty() {
            url.push_str(&format!("&labelIds={}", seg(label)));
        }
        if !query.trim().is_empty() {
            url.push_str(&format!("&q={}", seg(query.trim())));
        }
        if !token_next.is_empty() {
            url.push_str(&format!("&pageToken={}", seg(&token_next)));
        }
        let page = get(client, token, &url)?;
        for item in page["messages"].as_array().into_iter().flatten() {
            if let Some(id) = item["id"].as_str() {
                ids.push(id.to_string());
            }
        }
        token_next = page["nextPageToken"].as_str().unwrap_or("").to_string();
        if token_next.is_empty() || ids.len() >= cap {
            break;
        }
    }
    ids.truncate(cap);
    Ok((ids, token_next))
}

/// `after:` for Mailroom's sync window (`YYYY-MM-DDTHH:MM:SSZ`).
fn since_query(since: &str) -> String {
    match secs_from_iso(since) {
        Some(secs) if !since.trim().is_empty() => format!("after:{secs}"),
        _ => String::new(),
    }
}

fn folder_query(folder_id: &str, since: &str) -> (String, String) {
    let window = since_query(since);
    if folder_id == ARCHIVE {
        (String::new(), format!("{ARCHIVE_QUERY} {window}").trim().to_string())
    } else {
        (folder_id.to_string(), window)
    }
}

fn messages_in(client: &reqwest::blocking::Client, token: &str, folder_id: &str, since: &str, cap: usize) -> Result<Vec<LiveMessage>, String> {
    let (label, query) = folder_query(folder_id, since);
    let (ids, _) = list_ids(client, token, &label, &query, cap, "")?;
    fetch_home(client, token, folder_id, &ids)
}

/// Fetch messages for a folder fill, keeping those whose home is `folder_id`.
/// The letter is left out; opening it fetches the HTML. File names stay.
fn fetch_home(client: &reqwest::blocking::Client, token: &str, folder_id: &str, ids: &[String]) -> Result<Vec<LiveMessage>, String> {
    let fetched = parallel(ids, |id| fetch_listed(client, token, id));
    let mut out = Vec::new();
    for item in fetched {
        match item {
            Ok((message, labels)) if home_folder(&labels) == folder_id => out.push(message),
            Ok(_) | Err((404, _)) => {}
            Err(failure) => return Err(refused(failure)),
        }
    }
    out.sort_by(|a, b| b.received.cmp(&a.received));
    Ok(out)
}

/// The account's name and address, its folders and its Inbox.
pub fn fetch_mailbox(email: &str, since: &str) -> Result<(String, String, Vec<LiveFolder>, Vec<LiveMessage>), String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let profile = get(&client, &token, &format!("{GMAIL}/profile"))?;
    let address = profile["emailAddress"].as_str().filter(|a| !a.is_empty()).unwrap_or(email).to_string();
    let folders = list_folders(&client, &token)?;
    let messages = messages_in(&client, &token, "INBOX", since, FIRST_BATCH)?;
    Ok((auth::account_name(email), address, folders, messages))
}

pub fn fetch_folder(email: &str, folder_id: &str, since: &str) -> Result<Vec<LiveMessage>, String> {
    let id = folder_id.trim();
    if id.is_empty() {
        return Err("Choose a folder.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    messages_in(&client, &token, id, since, MAIL_CAP)
}

/// A folder's newest messages only, for one not cached yet; `backfill`
/// fetches the rest.
pub fn fetch_folder_first(email: &str, folder_id: &str, since: &str) -> Result<Vec<LiveMessage>, String> {
    let id = folder_id.trim();
    if id.is_empty() {
        return Err("Choose a folder.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    messages_in(&client, &token, id, since, FIRST_BATCH)
}

/// The next batch of a folder's messages that are not cached yet, within
/// the sync window: (messages, still missing after this batch, in window).
pub fn backfill(email: &str, folder_id: &str, since: &str, have: &BTreeSet<String>) -> Result<(Vec<LiveMessage>, usize, usize), String> {
    let id = folder_id.trim();
    if id.is_empty() {
        return Err("Choose a folder.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let (label, query) = folder_query(id, since);
    let (ids, _) = list_ids(&client, &token, &label, &query, MAIL_CAP, "")?;
    let missing: Vec<String> = ids.iter().filter(|item| !have.contains(*item)).cloned().collect();
    let batch: Vec<String> = missing.iter().take(BACKFILL_BATCH).cloned().collect();
    let messages = fetch_home(&client, &token, id, &batch)?;
    Ok((messages, missing.len() - batch.len(), ids.len()))
}

// ---- Changes ---------------------------------------------------------------

pub fn trusted_history_link(link: &str) -> bool {
    link.strip_prefix(HISTORY)
        .is_some_and(|id| !id.is_empty() && id.len() <= 24 && id.bytes().all(|b| b.is_ascii_digit()))
}

/// Gmail forgets history after about a week; then the folder syncs afresh.
pub fn history_gone(err: &str) -> bool {
    err.contains("(404")
}

/// Where a folder's changes start from now. Archive has no label of its own,
/// so it has no history and catches up by date instead.
pub fn anchor(email: &str, folder_id: &str) -> Result<String, String> {
    if folder_id == ARCHIVE {
        return Err("Archive catches up by date.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let profile = get(&client, &token, &format!("{GMAIL}/profile"))?;
    let id = profile["historyId"].as_str().unwrap_or("");
    let link = format!("{HISTORY}{id}");
    if trusted_history_link(&link) { Ok(link) } else { Err("Gmail did not say where its history is.".into()) }
}

/// What changed in a folder since its history link.
pub fn pull(email: &str, folder_id: &str, link: &str) -> Result<MailDelta, String> {
    if !trusted_history_link(link) || folder_id == ARCHIVE {
        return Err("The mail sync link was not accepted.".into());
    }
    let start = &link[HISTORY.len()..];
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let mut touched = BTreeSet::new();
    let mut deleted = BTreeSet::new();
    let mut latest = start.to_string();
    let mut page_token = String::new();
    for _ in 0..20 {
        let mut url = format!("{GMAIL}/history?startHistoryId={start}&labelId={}&maxResults=500", seg(folder_id));
        if !page_token.is_empty() {
            url.push_str(&format!("&pageToken={}", seg(&page_token)));
        }
        let page = call(&client, &token, "GET", &url, None).map_err(refused)?;
        for record in page["history"].as_array().into_iter().flatten() {
            for item in record["messagesDeleted"].as_array().into_iter().flatten() {
                if let Some(id) = item["message"]["id"].as_str() {
                    deleted.insert(id.to_string());
                }
            }
            for key in ["messagesAdded", "labelsAdded", "labelsRemoved"] {
                for item in record[key].as_array().into_iter().flatten() {
                    if let Some(id) = item["message"]["id"].as_str() {
                        touched.insert(id.to_string());
                    }
                }
            }
        }
        if let Some(id) = page["historyId"].as_str() {
            latest = id.to_string();
        }
        page_token = page["nextPageToken"].as_str().unwrap_or("").to_string();
        if page_token.is_empty() {
            break;
        }
    }
    let ids: Vec<String> = touched.difference(&deleted).take(MAIL_CAP).cloned().collect();
    let fetched = parallel(&ids, |id| fetch_full(&client, &token, id));
    let mut removed: Vec<String> = deleted.into_iter().collect();
    let mut changed = Vec::new();
    for (id, item) in ids.iter().zip(fetched) {
        match item {
            Ok((message, labels)) if home_folder(&labels) == folder_id => changed.push(message),
            Ok(_) | Err((404, _)) => removed.push(id.clone()),
            Err(failure) => return Err(refused(failure)),
        }
    }
    Ok(MailDelta { removed, changed, patched: Vec::new(), link: format!("{HISTORY}{latest}") })
}

/// The ids Gmail has in a folder within the sync window, to find messages
/// that left it in a way its history did not tell. None when the window
/// holds more than one sync takes, or for Archive.
pub fn ids_in_window(email: &str, folder_id: &str, since: &str) -> Result<Option<BTreeSet<String>>, String> {
    if folder_id == ARCHIVE || since_query(since).is_empty() {
        return Ok(None);
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let (label, query) = folder_query(folder_id, since);
    let (ids, next) = list_ids(&client, &token, &label, &query, MAIL_CAP, "")?;
    if !next.is_empty() || ids.len() >= MAIL_CAP {
        return Ok(None);
    }
    Ok(Some(ids.into_iter().collect()))
}

/// Cached messages in the window that Gmail no longer has in the folder.
pub fn missing_from(cached: &[LiveMessage], server: &BTreeSet<String>, since: &str) -> Vec<String> {
    let Some(cut) = secs_from_iso(since) else { return Vec::new() };
    cached
        .iter()
        .filter(|m| secs_from_iso(&m.received).is_some_and(|at| at >= cut) && !server.contains(&m.id))
        .map(|m| m.id.clone())
        .collect()
}

// ---- Search ----------------------------------------------------------------

fn iso_day(value: &str) -> Option<String> {
    let text = value.trim();
    (text.len() == 10 && secs_from_iso(text).is_some()).then(|| text.to_string())
}

/// Gmail's search words: the person's own text, so Gmail's operators
/// (from:, has:attachment) work, then the date range and the files filter.
pub fn search_query(query: &str, from: &str, to: &str, files: &str) -> Result<String, String> {
    let text: String = query.chars().filter(|c| !c.is_control()).collect();
    let text = text.trim();
    if text.is_empty() {
        return Err("Enter a search.".into());
    }
    if text.chars().count() > 200 {
        return Err("That search is too long.".into());
    }
    let mut q = text.to_string();
    if let Some(day) = iso_day(from) {
        q.push_str(&format!(" after:{}", day.replace('-', "/")));
    }
    if let Some(day) = iso_day(to).and_then(|day| next_day(&day)) {
        q.push_str(&format!(" before:{}", day.replace('-', "/")));
    }
    match files.trim() {
        "yes" => q.push_str(" has:attachment"),
        "no" => q.push_str(" -has:attachment"),
        _ => {}
    }
    Ok(q)
}

fn hits(fetched: Vec<Result<(LiveMessage, Vec<String>), (u16, String)>>) -> Result<Vec<MailSearchHit>, String> {
    let mut out = Vec::new();
    for item in fetched {
        match item {
            Ok((message, labels)) => out.push(MailSearchHit { parent_folder_id: home_folder(&labels), message }),
            Err((404, _)) => {}
            Err(failure) => return Err(refused(failure)),
        }
    }
    Ok(out)
}

pub fn search_mail(email: &str, folder_id: &str, query: &str, from: &str, to: &str, files: &str, next_link: &str) -> Result<MailSearchPage, String> {
    let mut q = search_query(query, from, to, files)?;
    let folder = folder_id.trim();
    let label = if folder == ARCHIVE {
        q = format!("{q} {ARCHIVE_QUERY}");
        ""
    } else {
        folder
    };
    let page_token = match next_link.trim() {
        "" => String::new(),
        link => {
            let token = link.strip_prefix(PAGE).unwrap_or("");
            if token.is_empty() || token.len() > 400 || !token.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
                return Err("That search could not be continued.".into());
            }
            token.to_string()
        }
    };
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let (ids, next) = list_ids(&client, &token, label, &q, SEARCH_PAGE, &page_token)?;
    let messages = hits(parallel(&ids, |id| fetch_full(&client, &token, id)))?;
    Ok(MailSearchPage { messages, next_link: if next.is_empty() { String::new() } else { format!("{PAGE}{next}") } })
}

/// Every message in a Gmail thread, from any folder.
pub fn conversation_mail(email: &str, thread_id: &str) -> Result<MailSearchPage, String> {
    let id = thread_id.trim();
    if id.is_empty() || id.len() > 100 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Choose a conversation.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let thread = get(&client, &token, &format!("{GMAIL}/threads/{}?format=full", seg(id)))?;
    let messages = thread["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|value| parse_message(value).map(|(message, labels)| MailSearchHit { parent_folder_id: home_folder(&labels), message }))
        .collect();
    Ok(MailSearchPage { messages, next_link: String::new() })
}

// ---- Changing mail ---------------------------------------------------------

fn valid_ids(ids: &[String]) -> Result<Vec<String>, String> {
    if ids.is_empty() {
        return Err("Choose a message.".into());
    }
    if ids.len() > 1000 {
        return Err("Choose fewer messages.".into());
    }
    ids.iter()
        .map(|id| {
            let id = id.trim();
            if id.is_empty() || id.len() > 100 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
                Err("Choose a message.".to_string())
            } else {
                Ok(id.to_string())
            }
        })
        .collect()
}

fn is_user_label(id: &str) -> bool {
    id.starts_with("Label_")
}

/// The labels a move adds and removes, from the folder the mail was in to
/// the one it goes to. Trash and back out of Trash have endpoints of their own.
pub fn move_labels(destination: &str, source: &str) -> Result<(Vec<String>, Vec<String>), String> {
    let source_label = |list: &mut Vec<String>| {
        if is_user_label(source) && source != destination {
            list.push(source.to_string());
        }
    };
    let mut add = Vec::new();
    let mut remove = Vec::new();
    match destination {
        "INBOX" => {
            add.push("INBOX".into());
            remove.push("SPAM".into());
        }
        "SPAM" => {
            add.push("SPAM".into());
            remove.push("INBOX".into());
        }
        ARCHIVE => {
            remove.push("INBOX".into());
            remove.push("SPAM".into());
            source_label(&mut remove);
        }
        label if is_user_label(label) => {
            add.push(label.to_string());
            remove.push("INBOX".into());
            remove.push("SPAM".into());
            source_label(&mut remove);
        }
        _ => return Err("Mail can't be moved there.".into()),
    }
    Ok((add, remove))
}

fn modify(client: &reqwest::blocking::Client, token: &str, ids: &[String], add: &[String], remove: &[String]) -> Result<(), String> {
    for chunk in ids.chunks(1000) {
        let body = json!({ "ids": chunk, "addLabelIds": add, "removeLabelIds": remove });
        call(client, token, "POST", &format!("{GMAIL}/messages/batchModify"), Some(&body)).map_err(refused)?;
    }
    Ok(())
}

fn each(client: &reqwest::blocking::Client, token: &str, ids: &[String], action: &str) -> Result<(), String> {
    for id in ids {
        match call(client, token, "POST", &format!("{GMAIL}/messages/{}/{action}", seg(id)), None) {
            Ok(_) | Err((404, _)) => {}
            Err(failure) => return Err(refused(failure)),
        }
    }
    Ok(())
}

/// Read, unread, flag (star), unflag, archive, trash, back to the inbox, or
/// move to a folder. Gmail keeps a message's id when its labels change.
pub fn apply_mail(email: &str, kind: &str, message_ids: &[String], destination: &str, source: &str) -> Result<Vec<MovedId>, String> {
    let ids = valid_ids(message_ids)?;
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let strings = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    match kind {
        "read" => modify(&client, &token, &ids, &[], &strings(&["UNREAD"]))?,
        "unread" => modify(&client, &token, &ids, &strings(&["UNREAD"]), &[])?,
        "flag" => modify(&client, &token, &ids, &strings(&["STARRED"]), &[])?,
        "unflag" => modify(&client, &token, &ids, &[], &strings(&["STARRED"]))?,
        "archive" => {
            let (add, remove) = move_labels(ARCHIVE, source.trim())?;
            modify(&client, &token, &ids, &add, &remove)?;
        }
        "trash" => each(&client, &token, &ids, "trash")?,
        "inbox" => {
            each(&client, &token, &ids, "untrash")?;
            modify(&client, &token, &ids, &strings(&["INBOX"]), &strings(&["SPAM"]))?;
        }
        "move" => match destination.trim() {
            "TRASH" => each(&client, &token, &ids, "trash")?,
            to => {
                let (add, remove) = move_labels(to, source.trim())?;
                if source.trim() == "TRASH" {
                    each(&client, &token, &ids, "untrash")?;
                }
                modify(&client, &token, &ids, &add, &remove)?;
            }
        },
        _ => return Err("That mail action is not available.".into()),
    }
    Ok(Vec::new())
}

/// Mark everything unread in a folder as read; returns how many.
pub fn mark_folder_read(email: &str, folder_id: &str) -> Result<usize, String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let (label, query) = folder_query(folder_id.trim(), "");
    let (ids, _) = list_ids(&client, &token, &label, &format!("is:unread {query}"), 5000, "")?;
    if !ids.is_empty() {
        modify(&client, &token, &ids, &[], &["UNREAD".to_string()])?;
    }
    Ok(ids.len())
}

/// A label by name, made if it is missing; returns its id.
pub fn ensure_folder(email: &str, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 225 || name.chars().any(|c| c.is_control()) {
        return Err("Enter a folder name.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let labels = get(&client, &token, &format!("{GMAIL}/labels"))?;
    for label in labels["labels"].as_array().into_iter().flatten() {
        if label["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)) {
            if let Some(id) = label["id"].as_str() {
                return Ok(id.to_string());
            }
        }
    }
    let made = call(
        &client,
        &token,
        "POST",
        &format!("{GMAIL}/labels"),
        Some(&json!({ "name": name, "labelListVisibility": "labelShow", "messageListVisibility": "show" })),
    )
    .map_err(refused)?;
    made["id"].as_str().map(String::from).ok_or_else(|| "Gmail did not make the folder.".into())
}

/// Some headers of a message, for unsubscribing.
pub fn headers(email: &str, message_id: &str, names: &[&str]) -> Result<Vec<(String, String)>, String> {
    let id = message_id.trim();
    if id.is_empty() {
        return Err("Choose a message.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let mut url = format!("{GMAIL}/messages/{}?format=metadata", seg(id));
    for name in names {
        url.push_str(&format!("&metadataHeaders={}", seg(name)));
    }
    let value = get(&client, &token, &url)?;
    Ok(names.iter().map(|name| (name.to_string(), header(&value["payload"], name).to_string())).collect())
}

// ---- Attachments -----------------------------------------------------------

fn find_part<'a>(part: &'a Value, part_id: &str, depth: usize) -> Option<&'a Value> {
    if depth > 12 {
        return None;
    }
    if part["partId"].as_str() == Some(part_id) {
        return Some(part);
    }
    part["parts"].as_array().into_iter().flatten().find_map(|child| find_part(child, part_id, depth + 1))
}

fn part_bytes(client: &reqwest::blocking::Client, token: &str, message_id: &str, part: &Value) -> Result<Vec<u8>, String> {
    let body = &part["body"];
    if body["size"].as_u64().unwrap_or(0) as usize > MAX_FILE_BYTES {
        return Err("That file is too large.".into());
    }
    if let Some(data) = body["data"].as_str() {
        return Ok(decode_b64url(data));
    }
    let attachment = body["attachmentId"].as_str().ok_or("That file is no longer there.")?;
    let value = get(client, token, &format!("{GMAIL}/messages/{}/attachments/{}", seg(message_id), seg(attachment)))?;
    let bytes = decode_b64url(value["data"].as_str().unwrap_or(""));
    if bytes.len() > MAX_FILE_BYTES {
        return Err("That file is too large.".into());
    }
    Ok(bytes)
}

fn full_message(client: &reqwest::blocking::Client, token: &str, message_id: &str) -> Result<Value, String> {
    let id = message_id.trim();
    if id.is_empty() {
        return Err("Choose a message.".into());
    }
    get(client, token, &format!("{GMAIL}/messages/{}?format=full", seg(id)))
}

pub fn list_attachments(email: &str, message_id: &str) -> Result<Vec<LiveFile>, String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let value = full_message(&client, &token, message_id)?;
    let mut bodies = Bodies::default();
    walk(&value["payload"], &mut bodies, 0);
    Ok(bodies.files)
}

/// A file's bytes. Files are named by their MIME part, which, unlike Gmail's
/// attachment ids, stays the same from one fetch to the next.
pub fn attachment_bytes(email: &str, message_id: &str, part_id: &str) -> Result<Vec<u8>, String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let value = full_message(&client, &token, message_id)?;
    let part = find_part(&value["payload"], part_id.trim(), 0).ok_or("That file is no longer there.")?;
    part_bytes(&client, &token, message_id, part)
}

pub fn open_attachment(email: &str, message_id: &str, part_id: &str, name: &str) -> Result<(), String> {
    if graph::launchable(name) {
        return Err("Mailroom does not open this type of file. Download it, then open it yourself if you trust it.".into());
    }
    let bytes = attachment_bytes(email, message_id, part_id)?;
    graph::open_downloaded(name, &bytes)
}

pub fn save_attachments(email: &str, message_id: &str, files: &[(String, String)], directory: &str) -> Result<usize, String> {
    let root = graph::prepare_download(directory, files)?;
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let value = full_message(&client, &token, message_id)?;
    let mut saved = 0;
    for (id, name) in files {
        let part = find_part(&value["payload"], id.trim(), 0).ok_or("That file is no longer there.")?;
        let bytes = part_bytes(&client, &token, message_id, part)?;
        graph::write_download(&root, name, &bytes)?;
        saved += 1;
    }
    Ok(saved)
}

pub fn preview(email: &str, message_id: &str, part_id: &str, name: &str, content_type: &str) -> Result<crate::inline::Preview, String> {
    let bytes = attachment_bytes(email, message_id, part_id)?;
    crate::inline::preview_bytes(name, content_type, bytes)
}

/// The pictures in a message, for `cid:` references and thumbnails.
pub fn inline_images(email: &str, message_id: &str) -> Result<Vec<crate::inline::InlineImage>, String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let value = full_message(&client, &token, message_id)?;
    let mut parts = Vec::new();
    collect_images(&value["payload"], &mut parts, 0);
    let mut out = Vec::new();
    let mut total = 0usize;
    for part in parts.into_iter().take(20) {
        let Ok(bytes) = part_bytes(&client, &token, message_id, part) else { continue };
        if bytes.is_empty() || bytes.len() > 3 * 1024 * 1024 || total + bytes.len() > 12 * 1024 * 1024 {
            continue;
        }
        let Some(kind) = crate::inline::allowed_type(part["mimeType"].as_str().unwrap_or("")) else { continue };
        let content_id = crate::inline::clean_content_id(header(part, "Content-ID"));
        let disposition = header(part, "Content-Disposition").to_ascii_lowercase();
        total += bytes.len();
        out.push(crate::inline::InlineImage {
            id: part["partId"].as_str().unwrap_or("").to_string(),
            name: decode_words(part["filename"].as_str().unwrap_or("image")).chars().take(200).collect(),
            inline: !content_id.is_empty() && !disposition.starts_with("attachment"),
            content_id,
            data_url: format!("data:{kind};base64,{}", STANDARD.encode(&bytes)),
        });
    }
    Ok(out)
}

fn collect_images<'a>(part: &'a Value, out: &mut Vec<&'a Value>, depth: usize) {
    if depth > 12 {
        return;
    }
    let mime = part["mimeType"].as_str().unwrap_or("");
    if crate::inline::allowed_type(mime).is_some() && part["partId"].as_str().is_some() {
        out.push(part);
    }
    for child in part["parts"].as_array().into_iter().flatten() {
        collect_images(child, out, depth + 1);
    }
}

// ---- Writing mail ----------------------------------------------------------

/// A header value, as RFC 2047 encoded words when it is not plain ASCII.
pub(crate) fn encode_header(text: &str) -> String {
    let clean: String = text.chars().filter(|c| !c.is_control()).collect();
    if clean.is_ascii() {
        return clean;
    }
    let mut words = Vec::new();
    let mut chunk = String::new();
    for ch in clean.chars() {
        if chunk.len() + ch.len_utf8() > 45 {
            words.push(format!("=?UTF-8?B?{}?=", STANDARD.encode(chunk.as_bytes())));
            chunk.clear();
        }
        chunk.push(ch);
    }
    if !chunk.is_empty() {
        words.push(format!("=?UTF-8?B?{}?=", STANDARD.encode(chunk.as_bytes())));
    }
    words.join("\r\n ")
}

fn mailbox(name: &str, email: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        return email.to_string();
    }
    if name.is_ascii() {
        format!("\"{}\" <{email}>", name.replace(['"', '\\'], ""))
    } else {
        format!("{} <{email}>", encode_header(name))
    }
}

fn base64_lines(bytes: &[u8]) -> String {
    let encoded = STANDARD.encode(bytes);
    let mut out = String::with_capacity(encoded.len() + encoded.len() / 76 * 2 + 2);
    for (index, ch) in encoded.chars().enumerate() {
        if index > 0 && index % 76 == 0 {
            out.push_str("\r\n");
        }
        out.push(ch);
    }
    out
}

fn boundary() -> String {
    let mut bytes = [0u8; 12];
    crate::auth::system_random(&mut bytes);
    format!("mailroom-{}", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// A MIME type safe to put in a header, or a guess from the file name.
pub(crate) fn content_type_for(name: &str, given: &str) -> String {
    let given = given.trim().to_ascii_lowercase();
    if !given.is_empty() && given.len() <= 100 && given.contains('/') && given.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '+' | '.' | '-')) {
        return given;
    }
    let lower = name.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "ics" => "text/calendar",
        _ => "application/octet-stream",
    }
    .into()
}

/// A file name for headers: plain ASCII in `filename`, the real name in
/// `filename*` (RFC 2231).
fn file_params(name: &str) -> String {
    let clean: String = name.chars().filter(|c| !c.is_control() && *c != '"' && *c != '\\').collect();
    let clean = if clean.trim().is_empty() { "attachment".to_string() } else { clean };
    let ascii: String = clean.chars().map(|c| if c.is_ascii() { c } else { '_' }).collect();
    let mut encoded = String::new();
    for byte in clean.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

/// The headers a reply needs to stay in its thread.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Threading {
    pub thread_id: String,
    pub in_reply_to: String,
    pub references: String,
}

pub struct Attachment {
    pub name: String,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

/// The whole message as RFC 5322 text: HTML with a plain-text twin, inline
/// pictures, then attached files.
pub fn build_mime(
    from: &str,
    mail: &OutgoingMail,
    body_html: &str,
    images: &[graph::InlineImage],
    files: &[Attachment],
    threading: &Threading,
    need_recipient: bool,
) -> Result<Vec<u8>, String> {
    let mut seen = std::collections::HashSet::new();
    let to = graph::mail_addresses(&mail.to, &mut seen)?;
    let cc = graph::mail_addresses(&mail.cc, &mut seen)?;
    let bcc = graph::mail_addresses(&mail.bcc, &mut seen)?;
    if need_recipient && to.is_empty() && cc.is_empty() && bcc.is_empty() {
        return Err("Add a recipient.".into());
    }
    let subject = mail.subject.trim();
    if subject.chars().count() > 255 {
        return Err("The subject is too long.".into());
    }
    if body_html.len() > 1_500_000 {
        return Err("That message is too large to send.".into());
    }
    let mut out = String::new();
    let mut head = |name: &str, value: &str| {
        if !value.trim().is_empty() {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
    };
    head("From", from);
    head("To", &to.join(", "));
    head("Cc", &cc.join(", "));
    head("Bcc", &bcc.join(", "));
    head("Subject", &encode_header(subject));
    head("Date", &rfc2822_now());
    head("MIME-Version", "1.0");
    let clean_id = |value: &str| value.chars().filter(|c| !c.is_control()).collect::<String>();
    head("In-Reply-To", &clean_id(&threading.in_reply_to));
    head("References", &clean_id(&threading.references));
    match mail.importance.trim().to_ascii_lowercase().as_str() {
        "high" => {
            head("Importance", "High");
            head("X-Priority", "1");
        }
        "low" => {
            head("Importance", "Low");
            head("X-Priority", "5");
        }
        _ => {}
    }
    if mail.read_receipt {
        let address = from.rsplit_once('<').map(|(_, rest)| rest.trim_end_matches('>')).unwrap_or(from);
        head("Disposition-Notification-To", address);
    }

    let text = graph::html_to_text(body_html);
    let alternative = boundary();
    let mut alt = format!("Content-Type: multipart/alternative; boundary=\"{alternative}\"\r\n\r\n");
    alt.push_str(&format!(
        "--{alternative}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n",
        base64_lines(text.as_bytes())
    ));
    alt.push_str(&format!(
        "--{alternative}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n",
        base64_lines(body_html.as_bytes())
    ));
    alt.push_str(&format!("--{alternative}--\r\n"));

    let mut body = alt;
    if !images.is_empty() {
        let related = boundary();
        let mut part = format!("Content-Type: multipart/related; boundary=\"{related}\"\r\n\r\n--{related}\r\n{body}");
        for image in images {
            let kind = content_type_for(&image.name, &image.content_type);
            let name: String = image.name.chars().filter(|c| c.is_ascii_graphic() && *c != '"' && *c != '<' && *c != '>').collect();
            part.push_str(&format!(
                "--{related}\r\nContent-Type: {kind}; name=\"{name}\"\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <{name}>\r\nContent-Disposition: inline; filename=\"{name}\"\r\n\r\n"
            ));
            let bytes = STANDARD.decode(image.bytes_b64.as_bytes()).map_err(|_| "A picture in the message could not be read.".to_string())?;
            part.push_str(&base64_lines(&bytes));
            part.push_str("\r\n");
        }
        part.push_str(&format!("--{related}--\r\n"));
        body = part;
    }
    if !files.is_empty() {
        let mixed = boundary();
        let mut part = format!("Content-Type: multipart/mixed; boundary=\"{mixed}\"\r\n\r\n--{mixed}\r\n{body}");
        for file in files {
            let kind = content_type_for(&file.name, &file.content_type);
            let params = file_params(&file.name);
            part.push_str(&format!(
                "--{mixed}\r\nContent-Type: {kind}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; {params}\r\n\r\n{}\r\n",
                base64_lines(&file.bytes)
            ));
        }
        part.push_str(&format!("--{mixed}--\r\n"));
        body = part;
    }
    out.push_str(&body);
    Ok(out.into_bytes())
}

fn from_line(email: &str) -> String {
    mailbox(&auth::account_name(email), email.trim())
}

/// The original's Message-ID and References, so a reply joins its thread.
fn threading_for(client: &reqwest::blocking::Client, token: &str, mode: Mode, reply_to: &str) -> Threading {
    let id = reply_to.trim();
    if mode == Mode::New || id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Threading::default();
    }
    let url = format!("{GMAIL}/messages/{}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References", seg(id));
    let Ok(value) = call(client, token, "GET", &url, None) else { return Threading::default() };
    let message_id = header(&value["payload"], "Message-ID").trim().to_string();
    let references = header(&value["payload"], "References").trim().to_string();
    Threading {
        thread_id: value["threadId"].as_str().unwrap_or("").to_string(),
        references: [references, message_id.clone()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" "),
        in_reply_to: message_id,
    }
}

/// The original's files a forward keeps: all of them, or those named.
fn forwarded_files(client: &reqwest::blocking::Client, token: &str, reply_to: &str, keep: Option<&[String]>) -> Result<Vec<Attachment>, String> {
    let value = full_message(client, token, reply_to)?;
    let mut bodies = Bodies::default();
    walk(&value["payload"], &mut bodies, 0);
    let mut out = Vec::new();
    for file in bodies.files {
        if keep.is_some_and(|list| !list.iter().any(|id| id == &file.id)) {
            continue;
        }
        let Some(part) = find_part(&value["payload"], &file.id, 0) else { continue };
        let bytes = part_bytes(client, token, reply_to, part)?;
        out.push(Attachment { name: file.name, content_type: file.content_type, bytes });
    }
    Ok(out)
}

fn send_refusal((status, why): (u16, String)) -> String {
    match status {
        401 | 403 => "Sign in again to send mail.".into(),
        400 | 413 if !why.is_empty() => format!("Google refused that message: {why}"),
        400 | 413 => "Google refused that message.".into(),
        429 | 503 => "Gmail is busy. The message is still in Outbox.".into(),
        // Any other server error may come after Gmail took the message.
        0 | 500..=599 => "Google did not answer, so the message may have been sent. Look in Sent before sending it again.".into(),
        _ => "The message could not be sent. It is still in Outbox.".into(),
    }
}

/// Send a whole message with its thread, through Gmail's upload endpoint,
/// which takes messages up to 35 MB.
fn upload_send(client: &reqwest::blocking::Client, token: &str, raw: &[u8], thread_id: &str) -> Result<(), (u16, String)> {
    let mark = boundary();
    let meta = if thread_id.is_empty() { json!({}) } else { json!({ "threadId": thread_id }) };
    let mut body = format!("--{mark}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{mark}\r\nContent-Type: message/rfc822\r\n\r\n").into_bytes();
    body.extend_from_slice(raw);
    body.extend_from_slice(format!("\r\n--{mark}--\r\n").as_bytes());
    let response = client
        .post(format!("{UPLOAD}/messages/send?uploadType=multipart"))
        .bearer_auth(token)
        .header("Content-Type", format!("multipart/related; boundary={mark}"))
        .body(body)
        .send()
        .map_err(|err| (0, err.to_string()))?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    Err((status.as_u16(), reason(&response.text().unwrap_or_default())))
}

#[allow(clippy::too_many_arguments)]
pub fn send(
    email: &str,
    mail: &OutgoingMail,
    draft_id: &str,
    reply_to: &str,
    mode: Mode,
    keep_files: Option<&[String]>,
    files: &[StagedRef],
    send_at: &str,
) -> Result<(), String> {
    if email.trim().is_empty() {
        return Err("That account is not signed in.".into());
    }
    if !send_at.trim().is_empty() {
        return Err("Gmail can't hold a message to send later from Mailroom. Send it now instead.".into());
    }
    let mut total = 0u64;
    for file in files {
        total += attach::size(&file.id).ok_or_else(|| "An attached file is missing. Attach it again.".to_string())?;
    }
    if total > MAX_SEND_BYTES {
        return Err("The attachments are too large to send. Gmail accepts up to 25 MB in one message.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let threading = threading_for(&client, &token, mode, reply_to);
    let mut attached = if mode == Mode::Forward && !reply_to.trim().is_empty() {
        forwarded_files(&client, &token, reply_to, keep_files).unwrap_or_default()
    } else {
        Vec::new()
    };
    for file in files {
        let bytes = attach::read(&file.id).map_err(|_| "An attached file is missing. Attach it again.".to_string())?;
        attached.push(Attachment { name: attach::clean_name(&file.name), content_type: file.content_type.clone(), bytes });
    }
    if attached.iter().map(|f| f.bytes.len() as u64).sum::<u64>() > MAX_SEND_BYTES {
        return Err("The attachments are too large to send. Gmail accepts up to 25 MB in one message.".into());
    }
    let (body_html, images) = graph::embed_inline_images(&mail.body_html)?;
    let raw = build_mime(&from_line(email), mail, &body_html, &images, &attached, &threading, true)?;
    upload_send(&client, &token, &raw, &threading.thread_id).map_err(send_refusal)?;
    if !draft_id.trim().is_empty() {
        if let Some(draft) = resolve_draft(&client, &token, draft_id) {
            let _ = call(&client, &token, "DELETE", &format!("{GMAIL}/drafts/{}", seg(&draft)), None);
        }
    }
    attach::forget(&files.iter().map(|file| file.id.clone()).collect::<Vec<_>>());
    Ok(())
}

/// A Gmail draft id from either a draft id or the id of the draft's message,
/// which is what the Drafts folder lists.
fn resolve_draft(client: &reqwest::blocking::Client, token: &str, id: &str) -> Option<String> {
    let id = id.trim();
    if id.is_empty() || id.len() > 100 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return None;
    }
    if call(client, token, "GET", &format!("{GMAIL}/drafts/{}?format=minimal", seg(id)), None).is_ok() {
        return Some(id.to_string());
    }
    let listed = call(client, token, "GET", &format!("{GMAIL}/drafts?maxResults=500"), None).ok()?;
    listed["drafts"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|draft| draft["message"]["id"].as_str() == Some(id))
        .and_then(|draft| draft["id"].as_str())
        .map(String::from)
}

fn draft_refusal((status, _): (u16, String)) -> String {
    match status {
        401 | 403 => "Sign in again to save drafts.".into(),
        0 => "The draft could not reach Google. It is kept on this computer.".into(),
        _ => "Gmail did not save the draft. It is kept on this computer.".into(),
    }
}

/// Save a draft in Gmail and return its id.
pub fn save_draft(email: &str, draft_id: &str, reply_to: &str, mode: Mode, mail: &OutgoingMail) -> Result<String, String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let threading = threading_for(&client, &token, mode, reply_to);
    let (body_html, images) = graph::embed_inline_images(&mail.body_html)?;
    let raw = build_mime(&from_line(email), mail, &body_html, &images, &[], &threading, false)?;
    let mut message = json!({ "raw": URL_SAFE_NO_PAD.encode(&raw) });
    if !threading.thread_id.is_empty() {
        message["threadId"] = json!(threading.thread_id);
    }
    let body = json!({ "message": message });
    if let Some(existing) = resolve_draft(&client, &token, draft_id) {
        match call(&client, &token, "PUT", &format!("{GMAIL}/drafts/{}", seg(&existing)), Some(&body)) {
            Ok(saved) => return Ok(saved["id"].as_str().unwrap_or(&existing).to_string()),
            Err((404, _)) => {}
            Err(failure) => return Err(draft_refusal(failure)),
        }
    }
    let made = call(&client, &token, "POST", &format!("{GMAIL}/drafts"), Some(&body)).map_err(draft_refusal)?;
    made["id"].as_str().map(String::from).ok_or_else(|| "Gmail did not save the draft. It is kept on this computer.".into())
}

pub fn discard_draft(email: &str, draft_id: &str) -> Result<(), String> {
    if draft_id.trim().is_empty() {
        return Ok(());
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let Some(draft) = resolve_draft(&client, &token, draft_id) else { return Ok(()) };
    match call(&client, &token, "DELETE", &format!("{GMAIL}/drafts/{}", seg(&draft)), None) {
        Ok(_) | Err((404, _)) => Ok(()),
        Err(_) => Err("The draft could not be removed from the server.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(text: &str) -> String {
        URL_SAFE_NO_PAD.encode(text.as_bytes())
    }

    fn sample() -> Value {
        json!({
            "id": "18f2a", "threadId": "18f20", "labelIds": ["INBOX", "UNREAD", "CATEGORY_PERSONAL", "Label_7"],
            "snippet": "Here&#39;s the plan &amp; the numbers", "internalDate": "1792800000000",
            "payload": {
                "mimeType": "multipart/mixed",
                "headers": [
                    { "name": "From", "value": "\"Stone, Bob\" <bob@example.org>" },
                    { "name": "To", "value": "Jon <jon@gmail.com>, ada@example.org" },
                    { "name": "Subject", "value": "=?UTF-8?B?U2l0ZSBwbGFucyDinJM=?=" },
                    { "name": "X-Priority", "value": "1 (Highest)" }
                ],
                "parts": [
                    { "partId": "0", "mimeType": "multipart/alternative", "filename": "", "parts": [
                        { "partId": "0.0", "mimeType": "text/plain", "filename": "", "headers": [{ "name": "Content-Type", "value": "text/plain; charset=UTF-8" }], "body": { "size": 5, "data": b64("plain") } },
                        { "partId": "0.1", "mimeType": "text/html", "filename": "", "headers": [{ "name": "Content-Type", "value": "text/html; charset=\"UTF-8\"" }], "body": { "size": 12, "data": b64("<p>Plans</p>") } }
                    ]},
                    { "partId": "1", "mimeType": "image/png", "filename": "logo.png", "headers": [{ "name": "Content-ID", "value": "<logo@x>" }, { "name": "Content-Disposition", "value": "inline" }], "body": { "size": 99, "attachmentId": "ANGj" } },
                    { "partId": "2", "mimeType": "application/pdf", "filename": "plan.pdf", "headers": [{ "name": "Content-Disposition", "value": "attachment; filename=\"plan.pdf\"" }], "body": { "size": 1000, "attachmentId": "ANGk" } }
                ]
            }
        })
    }

    #[test]
    fn a_gmail_message_becomes_a_live_message() {
        let (m, labels) = parse_message(&sample()).unwrap();
        assert_eq!(m.id, "18f2a");
        assert_eq!(m.thread, "18f20");
        assert_eq!(m.subject, "Site plans ✓");
        assert_eq!((m.from_name.as_str(), m.from_email.as_str()), ("Stone, Bob", "bob@example.org"));
        assert_eq!(m.to.len(), 2);
        assert_eq!(m.to[1].email, "ada@example.org");
        assert_eq!(m.preview, "Here's the plan & the numbers");
        assert_eq!(m.body_html, "<p>Plans</p>");
        assert_eq!(m.received, "2026-10-24T00:00:00Z");
        assert!(m.unread && !m.flagged);
        assert_eq!(m.importance, "high");
        assert_eq!(m.focus, "focused");
        assert_eq!(m.files.len(), 1, "the inline logo is drawn, not listed");
        assert_eq!((m.files[0].id.as_str(), m.files[0].name.as_str(), m.files[0].size), ("2", "plan.pdf", 1000));
        assert_eq!(home_folder(&labels), "INBOX");
    }

    #[test]
    fn a_folder_fill_keeps_the_file_name_and_drops_the_letter() {
        let url = list_message_url("18f2a");
        assert!(url.contains("format=full"));
        assert!(url.contains("fields="));
        assert!(!url.to_ascii_lowercase().contains("data"));
        let (m, labels) = listed_message(&sample()).unwrap();
        assert!(m.body_html.is_empty());
        assert_eq!(m.preview, "Here's the plan & the numbers");
        assert_eq!(m.files.len(), 1);
        assert_eq!(m.files[0].name, "plan.pdf");
        assert!(!m.invite);
        assert_eq!(home_folder(&labels), "INBOX");
    }

    #[test]
    fn a_calendar_part_marks_the_message_as_an_invite() {
        let mut value = sample();
        let ics = b64("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc@google.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
        value["payload"]["parts"].as_array_mut().unwrap().push(json!({
            "partId": "3",
            "mimeType": "text/calendar",
            "filename": "invite.ics",
            "headers": [{ "name": "Content-Type", "value": "text/calendar; charset=UTF-8; method=REQUEST" }],
            "body": { "size": 80, "data": ics }
        }));
        let (m, _) = parse_message(&value).unwrap();
        assert!(m.invite);
        let piece = best_calendar(&value["payload"]).unwrap();
        assert_eq!(piece.rank, 0);
        assert_eq!(piece.charset, "UTF-8");
        let text = decode_text(&decode_b64url(&piece.data), &piece.charset);
        assert!(text.contains("UID:abc@google.com"));
    }

    #[test]
    fn each_message_has_one_home_folder() {
        let l = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(home_folder(&l(&["INBOX", "Label_9", "Label_3"])), "INBOX");
        assert_eq!(home_folder(&l(&["Label_9", "Label_3", "IMPORTANT"])), "Label_3");
        assert_eq!(home_folder(&l(&["SENT"])), "SENT");
        assert_eq!(home_folder(&l(&["TRASH", "INBOX"])), "TRASH");
        assert_eq!(home_folder(&l(&["CATEGORY_UPDATES"])), ARCHIVE);
    }

    #[test]
    fn labels_become_folders_with_nesting() {
        let labels = json!({ "labels": [
            { "id": "INBOX", "name": "INBOX", "type": "system" },
            { "id": "Label_2", "name": "Clients/Acme", "type": "user" },
            { "id": "Label_1", "name": "Clients", "type": "user" },
            { "id": "Label_3", "name": "Old/Thing", "type": "user" },
            { "id": "Label_4", "name": "Hidden", "type": "user", "labelListVisibility": "labelHide" }
        ]});
        let mut counts = HashMap::new();
        counts.insert("INBOX".to_string(), (3, 40));
        let folders = folders_from(&labels, &counts);
        let keys: Vec<&str> = folders.iter().map(|f| f.key.as_str()).collect();
        assert_eq!(&keys[..6], &["inbox", "drafts", "sent", "archive", "SPAM", "trash"]);
        assert_eq!((folders[0].unread, folders[0].total), (3, 40));
        let acme = folders.iter().find(|f| f.id == "Label_2").unwrap();
        assert_eq!((acme.name.as_str(), acme.parent_id.as_str(), acme.depth), ("Acme", "Label_1", 1));
        let thing = folders.iter().find(|f| f.id == "Label_3").unwrap();
        assert_eq!((thing.name.as_str(), thing.depth), ("Old/Thing", 0), "no Old label, so it stays whole");
        assert!(folders.iter().all(|f| f.id != "Label_4"));
    }

    #[test]
    fn a_move_swaps_the_folder_label() {
        let (add, remove) = move_labels("Label_2", "INBOX").unwrap();
        assert_eq!((add, remove), (vec!["Label_2".to_string()], vec!["INBOX".to_string(), "SPAM".to_string()]));
        let (add, remove) = move_labels("Label_2", "Label_1").unwrap();
        assert_eq!(add, vec!["Label_2"]);
        assert!(remove.contains(&"Label_1".to_string()));
        let (add, remove) = move_labels(ARCHIVE, "Label_1").unwrap();
        assert!(add.is_empty() && remove.contains(&"Label_1".to_string()) && remove.contains(&"INBOX".to_string()));
        assert!(move_labels("SENT", "INBOX").is_err());
        assert!(move_labels("DRAFT", "INBOX").is_err());
    }

    #[test]
    fn dates_round_trip() {
        assert_eq!(iso_from_secs(0), "1970-01-01T00:00:00Z");
        assert_eq!(secs_from_iso("2026-10-24T00:00:00Z"), Some(1792800000));
        assert_eq!(secs_from_iso("2026-10-24T09:30:00-04:00"), secs_from_iso("2026-10-24T13:30:00Z"));
        assert_eq!(secs_from_iso("2026-10-24T13:30:00.1234567Z"), secs_from_iso("2026-10-24T13:30:00Z"));
        assert_eq!(next_day("2026-12-31").as_deref(), Some("2027-01-01"));
        assert_eq!(next_day("2028-02-28").as_deref(), Some("2028-02-29"));
        assert_eq!(since_query("2026-10-24T00:00:00Z"), "after:1792800000");
        assert_eq!(since_query(""), "");
    }

    #[test]
    fn messages_gone_from_gmail_are_found_only_inside_the_window() {
        let at = |id: &str, received: &str| LiveMessage {
            id: id.into(), thread: id.into(), subject: String::new(), from_name: String::new(), from_email: String::new(),
            received: received.into(), preview: String::new(), body_html: String::new(), unread: false, flagged: false,
            has_attachments: false, files: Vec::new(), to: Vec::new(), cc: Vec::new(), bcc: Vec::new(), categories: Vec::new(),
            importance: String::new(), invite: false, focus: String::new(),
        };
        let cached = vec![at("kept", "2026-10-20T10:00:00Z"), at("archived", "2026-10-21T10:00:00Z"), at("old", "2026-01-01T10:00:00Z")];
        let server: BTreeSet<String> = ["kept".to_string()].into_iter().collect();
        assert_eq!(missing_from(&cached, &server, "2026-09-24T04:00:00.000Z"), vec!["archived".to_string()]);
    }

    #[test]
    fn searches_keep_gmail_operators_and_add_the_filters() {
        assert_eq!(search_query("from:bob invoice", "2026-10-01", "2026-10-31", "yes").unwrap(), "from:bob invoice after:2026/10/01 before:2026/11/01 has:attachment");
        assert!(search_query("  ", "", "", "").is_err());
    }

    #[test]
    fn the_bucket_keeps_gmail_under_its_budget() {
        let start = std::time::Instant::now();
        let mut bucket = Bucket::new();
        // A burst goes straight out, then requests are paced.
        let mut sent = 0.0;
        while bucket.take(start, 5.0).is_none() {
            sent += 5.0;
        }
        assert_eq!(sent, BURST);
        let wait = bucket.take(start, 5.0).unwrap();
        assert!((wait.as_secs_f64() - 5.0 / UNITS_PER_SEC).abs() < 1e-3);
        // Over a minute it never passes Gmail's 15,000 units.
        let mut used = BURST;
        let mut now = start;
        while now < start + std::time::Duration::from_secs(60) {
            match bucket.take(now, 5.0) {
                None => used += 5.0,
                Some(wait) => now += wait,
            }
        }
        assert!(used < 15_000.0, "{used}");
        // A refusal holds everything back for the wait Google asked for,
        // then goes at half the pace, climbing back while all is well.
        bucket.pause(now + std::time::Duration::from_secs(10));
        assert!(bucket.take(now, 1.0).unwrap() >= std::time::Duration::from_secs(10));
        assert_eq!(bucket.rate, UNITS_PER_SEC / 2.0);
        for _ in 0..10 {
            bucket.pause(now + std::time::Duration::from_secs(10));
        }
        assert_eq!(bucket.rate, SLOWEST);
        let later = now + std::time::Duration::from_secs(10 + 30);
        let _ = bucket.take(later, 1.0);
        assert!((bucket.rate - (SLOWEST + 30.0 * RECOVER)).abs() < 1e-6);
    }

    #[test]
    fn requests_cost_what_gmail_charges() {
        use reqwest::Method;
        assert_eq!(units(&Method::GET, &format!("{GMAIL}/messages/abc?format=full")), 5.0);
        assert_eq!(units(&Method::GET, &format!("{GMAIL}/messages?maxResults=500")), 5.0);
        assert_eq!(units(&Method::GET, &format!("{GMAIL}/labels/INBOX")), 1.0);
        assert_eq!(units(&Method::GET, &format!("{GMAIL}/history?startHistoryId=1")), 2.0);
        assert_eq!(units(&Method::GET, &format!("{GMAIL}/threads/t1?format=full")), 10.0);
        assert_eq!(units(&Method::POST, &format!("{GMAIL}/messages/batchModify")), 50.0);
        assert_eq!(units(&Method::POST, &format!("{UPLOAD}/messages/send?uploadType=multipart")), 100.0);
    }

    #[test]
    fn per_minute_quota_is_retried_but_daily_is_not() {
        let minute = r#"{"error":{"code":403,"message":"Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'","errors":[{"reason":"rateLimitExceeded"}]}}"#;
        let daily = r#"{"error":{"code":403,"message":"Quota exceeded for quota metric 'Queries' and limit 'Queries per day'","errors":[{"reason":"dailyLimitExceeded"}]}}"#;
        let denied = r#"{"error":{"code":403,"message":"Request had insufficient authentication scopes."}}"#;
        assert!(backoff(403, minute, None, 0).is_some());
        assert!(backoff(429, "", None, 0).is_some());
        assert!(backoff(403, daily, None, 0).is_none());
        assert!(backoff(403, denied, None, 0).is_none());
        assert!(backoff(500, "", None, 0).is_none());
        assert!(backoff(403, minute, None, RETRIES).is_none());
        assert!(backoff(429, "", Some(7), 0).unwrap().as_secs() == 7);
    }

    #[test]
    fn history_links_are_digits() {
        assert!(trusted_history_link("gmail-history:123456"));
        assert!(!trusted_history_link("gmail-history:"));
        assert!(!trusted_history_link("https://graph.microsoft.com/v1.0/me/mailFolders/x/messages/delta"));
        assert!(!trusted_history_link("gmail-history:12&evil=1"));
    }

    #[test]
    fn headers_and_text_decode() {
        assert_eq!(decode_words("=?ISO-8859-1?Q?Caf=E9_cr=E8me?="), "Café crème");
        assert_eq!(decode_words("=?UTF-8?B?w6k=?= =?UTF-8?B?w6k=?="), "éé", "the space between encoded words goes");
        assert_eq!(decode_words("plain"), "plain");
        assert_eq!(decode_text(&[0x93, b'h', b'i', 0x94], "windows-1252"), "“hi”");
        assert_eq!(decode_text("é".as_bytes(), "utf-8"), "é");
        let found: Vec<(String, String)> = people("a@x.org, \"Doe, J\" <j@x.org>, nobody").into_iter().map(|p| (p.name, p.email)).collect();
        assert_eq!(found, vec![(String::new(), "a@x.org".to_string()), ("Doe, J".to_string(), "j@x.org".to_string())]);
    }

    #[test]
    fn a_message_is_written_as_mime_with_its_thread() {
        let mail = OutgoingMail {
            subject: "Café plans".into(),
            body_html: String::new(),
            to: "ada@example.org; bob@example.org".into(),
            cc: String::new(),
            bcc: "boss@example.org".into(),
            importance: "high".into(),
            read_receipt: false,
            from_address: String::new(),
        };
        let threading = Threading { thread_id: "t1".into(), in_reply_to: "<m1@x>".into(), references: "<m0@x> <m1@x>".into() };
        let files = vec![Attachment { name: "Plan ✓.pdf".into(), content_type: String::new(), bytes: b"%PDF-1.7".to_vec() }];
        let raw = String::from_utf8(build_mime("\"Jon\" <jon@gmail.com>", &mail, "<p>Hi<br>there</p>", &[], &files, &threading, true).unwrap()).unwrap();
        assert!(raw.contains("To: ada@example.org, bob@example.org\r\n"));
        assert!(raw.contains("Bcc: boss@example.org\r\n"));
        assert!(raw.contains("Subject: =?UTF-8?B?"));
        assert!(raw.contains("In-Reply-To: <m1@x>\r\nReferences: <m0@x> <m1@x>\r\n"));
        assert!(raw.contains("X-Priority: 1\r\n"));
        assert!(raw.contains("multipart/mixed") && raw.contains("multipart/alternative"));
        assert!(raw.contains("Content-Type: application/pdf\r\n"));
        assert!(raw.contains("filename*=UTF-8''Plan%20%E2%9C%93.pdf"));
        assert!(!raw.contains("Cc:"), "no empty headers");
        let no_one = OutgoingMail { to: String::new(), bcc: String::new(), ..mail };
        assert!(build_mime("jon@gmail.com", &no_one, "<p>x</p>", &[], &[], &Threading::default(), true).is_err());
        assert!(build_mime("jon@gmail.com", &no_one, "<p>x</p>", &[], &[], &Threading::default(), false).is_ok(), "a draft needs no recipient");
    }

    #[test]
    fn header_injection_is_impossible() {
        assert_eq!(encode_header("Hi\r\nBcc: evil@x"), "HiBcc: evil@x");
        assert_eq!(content_type_for("x.bin", "text/html\r\nX-Evil: 1"), "application/octet-stream");
        assert!(!file_params("a\"\r\nb.txt").contains('\n'));
    }

    #[test]
    fn work_runs_in_parallel_and_keeps_order() {
        let items: Vec<u32> = (0..50).collect();
        let doubled = parallel(&items, |n| n * 2);
        assert_eq!(doubled, items.iter().map(|n| n * 2).collect::<Vec<_>>());
    }
}
