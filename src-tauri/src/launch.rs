//! What Mailroom was started with, beyond `--hidden`: a `mailto:` link (as
//! the desktop's mail app), a `mailroom://message/<account>/<id>` link to one
//! message, `--compose` for a new message, or `--check-mail`.
//!
//! A first launch keeps the request until the page asks for it. A second
//! launch hands its arguments to the running Mailroom (single instance),
//! which passes the request straight to the page.

use serde::Serialize;
use std::sync::Mutex;

const MAX_ADDRESSES: usize = 50;
const MAX_SUBJECT: usize = 1000;
const MAX_BODY: usize = 100_000;
/// A whole mailroom: link. A Microsoft 365 id is about 152 characters, a
/// Gmail id 16, an address at most 254; percent-encoding can triple them.
const MAX_LINK: usize = 2048;
const MAX_ACCOUNT: usize = 254;
const MAX_MESSAGE_ID: usize = 512;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    /// "compose", "check", "open" (a mailroom: link) or "badlink" (a
    /// mailroom: link that could not be read).
    pub kind: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    /// Plain text; the page turns it into the message body.
    pub body: String,
    /// "open": the account's address and the message id, both decoded.
    pub account: String,
    pub id: String,
    /// "ics": a calendar file opened in Mailroom, its name and its events.
    /// "badics" when it could not be read or held no events.
    pub file: String,
    pub events: Vec<crate::gcal::FileEvent>,
}

impl Request {
    pub fn checks_mail(&self) -> bool {
        self.kind == "check"
    }
}

static PENDING: Mutex<Option<Request>> = Mutex::new(None);

/// The request in a command line, if any. The first element is the program.
pub fn from_args(args: &[String]) -> Option<Request> {
    for arg in args.iter().skip(1) {
        let arg = arg.trim();
        if arg.get(..7).is_some_and(|scheme| scheme.eq_ignore_ascii_case("mailto:")) {
            return parse_mailto(arg);
        }
        if arg.get(..9).is_some_and(|scheme| scheme.eq_ignore_ascii_case("mailroom:")) {
            return Some(parse_mailroom(arg));
        }
        if let Some(path) = calendar_file(arg) {
            return Some(read_calendar_file(&path));
        }
        if arg == "--compose" {
            return Some(Request { kind: "compose".into(), ..Default::default() });
        }
        if arg == "--check-mail" {
            return Some(Request { kind: "check".into(), ..Default::default() });
        }
    }
    None
}

/// Calendar files are at most this big; a real one is a few kilobytes.
const MAX_ICS_BYTES: u64 = 2 * 1024 * 1024;

/// A .ics file named on the command line, as a path or a file:// URI (which
/// is what a file manager's "Open with" may pass).
fn calendar_file(arg: &str) -> Option<std::path::PathBuf> {
    let path = match arg.get(..7) {
        Some(scheme) if scheme.eq_ignore_ascii_case("file://") => {
            let raw = &arg[7..];
            let raw = raw.strip_prefix("localhost").unwrap_or(raw);
            percent_decoded(raw)?
        }
        _ => arg.to_string(),
    };
    let path = std::path::PathBuf::from(path);
    let ics = path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("ics") || ext.eq_ignore_ascii_case("ical") || ext.eq_ignore_ascii_case("ifb"));
    (ics && path.is_absolute()).then_some(path)
}

fn percent_decoded(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn read_calendar_file(path: &std::path::Path) -> Request {
    let file = path.file_name().map(|name| name.to_string_lossy().chars().take(200).collect()).unwrap_or_default();
    let bad = |file: String| Request { kind: "badics".into(), file, ..Default::default() };
    let Ok(meta) = std::fs::metadata(path) else { return bad(file) };
    if !meta.is_file() || meta.len() > MAX_ICS_BYTES {
        return bad(file);
    }
    let Ok(bytes) = std::fs::read(path) else { return bad(file) };
    let events = crate::gcal::file_events(&String::from_utf8_lossy(&bytes));
    if events.is_empty() {
        return bad(file);
    }
    Request { kind: "ics".into(), file, events, ..Default::default() }
}

pub fn stash(request: Option<Request>) {
    if let Ok(mut slot) = PENDING.lock() {
        *slot = request;
    }
}

pub fn take() -> Option<Request> {
    PENDING.lock().ok().and_then(|mut slot| slot.take())
}

/// The page function a request goes to, with the request as JSON data.
pub fn page_script(request: &Request) -> String {
    let json = serde_json::to_string(request).unwrap_or_else(|_| "null".into());
    format!("window.openLaunchRequest && window.openLaunchRequest({json});")
}

/// A mailto: link (RFC 6068) as a new message.
pub fn parse_mailto(link: &str) -> Option<Request> {
    let rest = link.get(7..)?;
    let (path, query) = match rest.split_once('?') {
        Some((path, query)) => (path, query),
        None => (rest, ""),
    };
    let mut request = Request { kind: "compose".into(), ..Default::default() };
    add_addresses(&mut request.to, &decode(path));
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else { continue };
        let value = decode(value);
        match decode(key).to_ascii_lowercase().as_str() {
            "to" => add_addresses(&mut request.to, &value),
            "cc" => add_addresses(&mut request.cc, &value),
            "bcc" => add_addresses(&mut request.bcc, &value),
            "subject" if request.subject.is_empty() => {
                request.subject = value.chars().filter(|c| !c.is_control()).take(MAX_SUBJECT).collect();
            }
            "body" if request.body.is_empty() => {
                request.body = value
                    .replace("\r\n", "\n")
                    .chars()
                    .filter(|c| *c == '\n' || *c == '\t' || !c.is_control())
                    .take(MAX_BODY)
                    .collect();
            }
            _ => {}
        }
    }
    Some(request)
}

/// A `mailroom://message/<account>/<id>` link: open that message, and only
/// open it. Both parts are percent-encoded. Anything else, or anything odd,
/// is a "badlink" request, which the page answers with a notice.
pub fn parse_mailroom(link: &str) -> Request {
    match mailroom_parts(link) {
        Some((account, id)) => Request { kind: "open".into(), account, id, ..Default::default() },
        None => Request { kind: "badlink".into(), ..Default::default() },
    }
}

fn mailroom_parts(link: &str) -> Option<(String, String)> {
    if link.len() > MAX_LINK {
        return None;
    }
    let scheme = link.get(..11)?;
    if !scheme.eq_ignore_ascii_case("mailroom://") {
        return None;
    }
    let rest = &link[11..];
    // Only characters a URI may carry: no query, fragment or spaces.
    if !rest.chars().all(|c| c.is_ascii_alphanumeric() || "-._~!$&'()*+,;=:@%/".contains(c)) {
        return None;
    }
    let parts: Vec<&str> = rest.split('/').collect();
    let [kind, account, id] = parts.as_slice() else { return None };
    if !kind.eq_ignore_ascii_case("message") {
        return None;
    }
    let account = strict_decode(account)?;
    let id = strict_decode(id)?;
    (plausible_account(&account) && plausible_message_id(&id)).then_some((account, id))
}

/// Percent-decoding that refuses a stray `%`, a bad hex pair, or bytes that
/// are not UTF-8. `+` stays a plus sign.
fn strict_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value.get(index + 1..index + 3)?;
            if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `local@domain`, as an account's address is shown.
fn plausible_account(address: &str) -> bool {
    let Some((local, domain)) = address.split_once('@') else { return false };
    address.len() <= MAX_ACCOUNT
        && !local.is_empty()
        && local.len() <= 64
        && local.chars().all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+/=?^_`{|}~.-".contains(c))
        && domain.contains('.')
        && !domain.starts_with(['.', '-'])
        && !domain.ends_with(['.', '-'])
        && domain.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// Graph ids are base64 (`-`, `_` and `=`, or `+` and `/` in the standard
/// alphabet); Gmail ids are hex. Nothing else reaches the page.
fn plausible_message_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_MESSAGE_ID && id.chars().all(|c| c.is_ascii_alphanumeric() || "-_=+/".contains(c))
}

/// Comma-separated addresses, each one `local@domain` with no spaces or
/// angle brackets; anything else is dropped.
fn add_addresses(into: &mut Vec<String>, raw: &str) {
    for part in raw.split(',') {
        let address = part.trim();
        let plausible = address.len() <= 254
            && address.contains('@')
            && !address.starts_with('@')
            && !address.ends_with('@')
            && !address.chars().any(|c| c.is_whitespace() || c.is_control() || matches!(c, '<' | '>' | '"' | ',' | ';'));
        if plausible && into.len() < MAX_ADDRESSES && !into.iter().any(|seen| seen.eq_ignore_ascii_case(address)) {
            into.push(address.to_string());
        }
    }
}

/// Percent-decoding as URIs have it: `+` stays a plus sign.
fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if let Some(byte) = value.get(index + 1..index + 3).and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_calendar_file_is_read_from_a_path_or_a_file_uri() {
        let dir = std::env::temp_dir().join(format!("mailroom-ics-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Kiln plan.ics");
        std::fs::write(&path, "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Kiln\nDTSTART:20261124T090000Z\nEND:VEVENT\nEND:VCALENDAR\n").unwrap();
        let args = |a: &str| vec!["mailroom".to_string(), a.to_string()];
        let got = from_args(&args(path.to_str().unwrap())).unwrap();
        assert_eq!((got.kind.as_str(), got.file.as_str(), got.events.len()), ("ics", "Kiln plan.ics", 1));
        let uri = format!("file://{}", path.to_str().unwrap().replace(' ', "%20"));
        assert_eq!(from_args(&args(&uri)).unwrap().events[0].summary, "Kiln");
        let empty = dir.join("empty.ics");
        std::fs::write(&empty, "nothing here").unwrap();
        assert_eq!(from_args(&args(empty.to_str().unwrap())).unwrap().kind, "badics");
        assert!(from_args(&args("relative.ics")).is_none(), "only absolute paths");
        assert!(from_args(&args("/tmp/notes.txt")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_mailto_link_becomes_a_new_message() {
        let got = parse_mailto("mailto:ada@example.com,bob@example.com?cc=cat%40example.com&subject=Site%20visit%20%2B%20numbers&body=Line%20one%0D%0ALine%20two").unwrap();
        assert_eq!(got.kind, "compose");
        assert_eq!(got.to, vec!["ada@example.com", "bob@example.com"]);
        assert_eq!(got.cc, vec!["cat@example.com"]);
        assert_eq!(got.subject, "Site visit + numbers");
        assert_eq!(got.body, "Line one\nLine two");
    }

    #[test]
    fn junk_addresses_and_controls_are_dropped() {
        let got = parse_mailto("MAILTO:?to=%3Cscript%3E@x,ok@example.com,ok@example.com,not-an-address&subject=a%0Ab&bcc=%40nope").unwrap();
        assert_eq!(got.to, vec!["ok@example.com"]);
        assert!(got.bcc.is_empty());
        assert_eq!(got.subject, "ab");
    }

    #[test]
    fn arguments_name_the_request() {
        assert_eq!(from_args(&args(&["mailroom"])), None);
        assert_eq!(from_args(&args(&["mailroom", "--hidden"])), None);
        assert_eq!(from_args(&args(&["mailroom", "--compose"])).unwrap().kind, "compose");
        assert!(from_args(&args(&["mailroom", "--check-mail"])).unwrap().checks_mail());
        assert_eq!(from_args(&args(&["mailroom", "mailto:ada@example.com"])).unwrap().to, vec!["ada@example.com"]);
    }

    #[test]
    fn the_request_reaches_the_page_as_data() {
        let request = Request { kind: "compose".into(), subject: "\");alert(1);(\"".into(), ..Default::default() };
        let script = page_script(&request);
        assert!(script.starts_with("window.openLaunchRequest && window.openLaunchRequest({"));
        assert!(script.contains("\\\");alert(1);(\\\""));
    }

    const GRAPH_ID: &str = "AAMkADc3YzM0ZTlkLWE5ZjAtNGE2Ni1hNWM0LTVmNjI1MmVmNTVkOABGAAAAAAB_x-Uq9aNgSKfF8wQ2hUkbBwBQ1i3pAAAAAAEMAAA=";

    fn encode(value: &str) -> String {
        value
            .bytes()
            .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
            .collect()
    }

    fn link(account: &str, id: &str) -> String {
        format!("mailroom://message/{}/{}", encode(account), encode(id))
    }

    #[test]
    fn a_mailroom_link_opens_one_message() {
        let got = from_args(&args(&["mailroom", &link("jon@timberworks.example", GRAPH_ID)])).unwrap();
        assert_eq!(got.kind, "open");
        assert_eq!(got.account, "jon@timberworks.example");
        assert_eq!(got.id, GRAPH_ID);
        assert!(!got.checks_mail());
        let gmail = parse_mailroom("MailRoom://MESSAGE/jon%40gmail.com/18c2f0a1b2c3d4e5");
        assert_eq!((gmail.kind.as_str(), gmail.account.as_str(), gmail.id.as_str()), ("open", "jon@gmail.com", "18c2f0a1b2c3d4e5"));
    }

    #[test]
    fn ids_round_trip_with_every_base64_character() {
        for id in [GRAPH_ID, "a-b_c=d", "AAMk+x/y==", "++//==", "-_-", "0123456789abcdef"] {
            for account in ["jon@timberworks.example", "first.last+tag@sub.example.co.uk"] {
                let got = parse_mailroom(&link(account, id));
                assert_eq!((got.kind.as_str(), got.account.as_str(), got.id.as_str()), ("open", account, id), "{id}");
            }
        }
        // A literal + or = needs no escape, nor does the @.
        let got = parse_mailroom("mailroom://message/jon@example.com/AAMk+x=");
        assert_eq!((got.kind.as_str(), got.id.as_str()), ("open", "AAMk+x="));
        // A / in an id must be %2F: a bare one is another segment.
        assert_eq!(parse_mailroom("mailroom://message/jon@example.com/AAMk/x=").kind, "badlink");
        assert_eq!(parse_mailroom("mailroom://message/jon@example.com/AAMk%2fx=").id, "AAMk/x=");
    }

    #[test]
    fn malformed_escapes_are_refused() {
        for bad in ["%", "%4", "%zz", "%G1", "abc%2", "%+1", "%C3%28", "%FF"] {
            assert_eq!(parse_mailroom(&format!("mailroom://message/jon%40example.com/{bad}")).kind, "badlink", "{bad}");
        }
        assert_eq!(parse_mailroom("mailroom://message/jon%4/abc").kind, "badlink");
    }

    #[test]
    fn the_shape_must_be_exact() {
        for bad in [
            "mailroom:",
            "mailroom:message/jon@example.com/abc",
            "mailroom://",
            "mailroom://message",
            "mailroom://message/jon@example.com",
            "mailroom://message/jon@example.com/",
            "mailroom://message//abc",
            "mailroom://message/jon@example.com/abc/",
            "mailroom://message/jon@example.com/abc/def",
            "mailroom:///message/jon@example.com/abc",
            "mailroom://compose/jon@example.com/abc",
            "mailroom://message/jon@example.com/abc?x=1",
            "mailroom://message/jon@example.com/abc#top",
            "mailroom://message/jon@example.com/a bc",
            "mailroom://message/not-an-address/abc",
            "mailroom://message/%40example.com/abc",
            "mailroom://message/jon%40/abc",
            "mailroom://message/jon%40localhost/abc",
            "mailroom://message/jon%40example.com/a%2Eb",
            "mailroom://message/jon%40example.com/a%20b",
            "mailroom://message/jon%40example.com/a%00b",
            "mailroom://message/jon%40example.com/%C3%A9",
        ] {
            assert_eq!(parse_mailroom(bad).kind, "badlink", "{bad}");
        }
        assert_eq!(from_args(&args(&["mailroom", "mailroom://nonsense"])).unwrap().kind, "badlink");
        assert_eq!(from_args(&args(&["mailroom", "MAILROOM:x"])).unwrap().kind, "badlink");
    }

    #[test]
    fn oversized_links_are_refused() {
        assert_eq!(parse_mailroom(&link("jon@example.com", &"A".repeat(MAX_MESSAGE_ID))).kind, "open");
        assert_eq!(parse_mailroom(&link("jon@example.com", &"A".repeat(MAX_MESSAGE_ID + 1))).kind, "badlink");
        assert_eq!(parse_mailroom(&link(&format!("{}@example.com", "a".repeat(65)), "abc")).kind, "badlink");
        let huge = format!("mailroom://message/jon%40example.com/{}", "A".repeat(MAX_LINK));
        assert_eq!(parse_mailroom(&huge).kind, "badlink");
    }

    #[test]
    fn an_injection_in_the_link_stays_inert_data() {
        // Script characters are not in an id, so this never reaches the page.
        let got = parse_mailroom(&link("jon@example.com", "\");alert(1);(\""));
        assert_eq!(got.kind, "badlink");
        assert!(got.id.is_empty() && got.account.is_empty());
        let got = parse_mailroom(&link("jon\"<script>@example.com", "abc"));
        assert_eq!(got.kind, "badlink");
        // What does reach the page is JSON data, never code.
        let request = Request { kind: "open".into(), account: "jon@example.com".into(), id: "\");alert(1);(\"</script>".into(), ..Default::default() };
        let script = page_script(&request);
        assert!(script.starts_with("window.openLaunchRequest && window.openLaunchRequest({"));
        assert!(script.contains(r#""id":"\");alert(1);(\"</script>""#), "{script}");
        assert!(script.ends_with("});"));
    }

    #[test]
    fn a_stashed_request_is_taken_once() {
        stash(Some(Request { kind: "compose".into(), ..Default::default() }));
        assert!(take().is_some());
        assert!(take().is_none());
    }
}
