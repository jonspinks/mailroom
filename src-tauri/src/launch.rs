//! What Mailroom was started with, beyond `--hidden`: a `mailto:` link (as
//! the desktop's mail app), `--compose` for a new message, or `--check-mail`.
//!
//! A first launch keeps the request until the page asks for it. A second
//! launch hands its arguments to the running Mailroom (single instance),
//! which passes the request straight to the page.

use serde::Serialize;
use std::sync::Mutex;

const MAX_ADDRESSES: usize = 50;
const MAX_SUBJECT: usize = 1000;
const MAX_BODY: usize = 100_000;

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    /// "compose" or "check".
    pub kind: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    /// Plain text; the page turns it into the message body.
    pub body: String,
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
        if arg == "--compose" {
            return Some(Request { kind: "compose".into(), ..Default::default() });
        }
        if arg == "--check-mail" {
            return Some(Request { kind: "check".into(), ..Default::default() });
        }
    }
    None
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

    #[test]
    fn a_stashed_request_is_taken_once() {
        stash(Some(Request { kind: "compose".into(), ..Default::default() }));
        assert!(take().is_some());
        assert!(take().is_none());
    }
}
