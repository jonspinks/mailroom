//! Whether a message's provider vouched for its sender.
//!
//! Safe senders (and mail from your own addresses) load remote pictures.
//! The From line is easy to forge, so that trust needs proof: the receiving
//! provider's own `Authentication-Results`, the top one, which Microsoft and
//! Google add above everything the sender wrote. A sender passes when DMARC
//! passed for the From domain, or (no DMARC policy) DKIM signed for it; on
//! Microsoft accounts also when Exchange stamped the mail as internal to the
//! organisation (`X-MS-Exchange-Organization-AuthAs: Internal`, a header
//! Exchange sets itself and never takes from outside).
//!
//! Asked only for a message that would otherwise show remote content: one
//! small request, for the headers alone.

use crate::{auth, google, graph};

/// One `method=result` part of an Authentication-Results header, with its
/// `ptype.property=value` pairs (`header.from`, `header.d`, ...).
#[derive(Debug, PartialEq)]
struct Method {
    name: String,
    result: String,
    props: Vec<(String, String)>,
}

impl Method {
    fn prop(&self, key: &str) -> Option<&str> {
        self.props.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

/// Comments in parentheses go; they can hold ';' and '='.
fn without_comments(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut depth = 0usize;
    let mut escaped = false;
    for ch in value.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' if depth > 0 => escaped = true,
            '(' => depth += 1,
            ')' if depth > 0 => depth -= 1,
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}

/// The authserv-id (empty when the header starts with a method, as
/// Exchange's does for mail inside a tenant) and the methods.
fn parse(value: &str) -> (String, Vec<Method>) {
    let clean = without_comments(value);
    let mut parts = clean.split(';').map(str::trim).filter(|p| !p.is_empty()).peekable();
    let mut server = String::new();
    if let Some(first) = parts.peek() {
        let head = first.split_whitespace().next().unwrap_or("");
        if !head.contains('=') {
            server = head.to_ascii_lowercase();
            parts.next();
        }
    }
    let mut methods = Vec::new();
    for part in parts {
        let mut tokens = part.split_whitespace();
        let Some((name, result)) = tokens.next().and_then(|t| t.split_once('=')) else { continue };
        let props = tokens
            .filter_map(|t| t.split_once('='))
            .map(|(k, v)| (k.to_ascii_lowercase(), v.trim_matches('"').trim_start_matches('@').to_ascii_lowercase()))
            .collect();
        methods.push(Method { name: name.to_ascii_lowercase(), result: result.to_ascii_lowercase(), props });
    }
    (server, methods)
}

fn domain_of(email: &str) -> Option<String> {
    let domain = email.trim().rsplit_once('@')?.1.trim_end_matches('>').trim().to_ascii_lowercase();
    if domain.is_empty() || !domain.contains('.') {
        return None;
    }
    Some(domain)
}

/// `d` signs for `from`: the same domain, or a parent of it (relaxed alignment).
fn aligned(from: &str, d: &str) -> bool {
    !d.is_empty() && (from == d || from.ends_with(&format!(".{d}")))
}

fn passes(methods: &[Method], from: &str, microsoft: bool) -> bool {
    let dmarc_ok = |m: &Method| m.result == "pass" || (microsoft && m.result == "bestguesspass");
    let dmarc_from = methods.iter().find(|m| m.name == "dmarc").and_then(|m| m.prop("header.from").map(str::to_string));
    for m in methods {
        if m.name == "dmarc" && dmarc_ok(m) && m.prop("header.from") == Some(from) {
            return true;
        }
        // Microsoft's composite verdict, for the domain DMARC looked at.
        if microsoft && m.name == "compauth" && m.result == "pass" && dmarc_from.as_deref() == Some(from) {
            return true;
        }
        if m.name == "dkim" && m.result == "pass" {
            let d = m.prop("header.d").or_else(|| m.prop("header.i").map(|i| i.rsplit('@').next().unwrap_or(i)));
            if d.is_some_and(|d| aligned(from, d)) {
                return true;
            }
        }
    }
    false
}

fn first<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

/// A Microsoft 365 / Outlook.com message's headers, top first.
fn microsoft_verdict(headers: &[(String, String)], from_email: &str) -> bool {
    let Some(from) = domain_of(from_email) else { return false };
    if first(headers, "X-MS-Exchange-Organization-AuthAs").is_some_and(|v| v.trim().eq_ignore_ascii_case("internal")) {
        return true;
    }
    let Some(value) = first(headers, "Authentication-Results") else { return false };
    let (server, methods) = parse(value);
    if !(server.is_empty() || server == "mx.microsoft.com") {
        return false;
    }
    passes(&methods, &from, true)
}

/// A Gmail message's headers, top first.
fn gmail_verdict(headers: &[(String, String)], from_email: &str) -> bool {
    let Some(from) = domain_of(from_email) else { return false };
    let Some(value) = first(headers, "Authentication-Results") else { return false };
    let (server, methods) = parse(value);
    server == "mx.google.com" && passes(&methods, &from, false)
}

fn pairs(list: &serde_json::Value) -> Vec<(String, String)> {
    list.as_array()
        .map(|items| {
            items
                .iter()
                .map(|h| {
                    (h["name"].as_str().unwrap_or("").to_string(), h["value"].as_str().unwrap_or("").to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Whether `message_id` in `account`'s mailbox, said to be from `from_email`,
/// passed its provider's sender checks.
pub fn verified(account: &str, message_id: &str, from_email: &str) -> Result<bool, String> {
    let id = message_id.trim();
    if id.is_empty() || id.len() > 512 {
        return Err("Choose a message.".into());
    }
    if auth::is_google(account) {
        // Gmail lists a message's headers top first; this keeps the first.
        let headers = google::headers(account, id, &["Authentication-Results"])?;
        return Ok(gmail_verdict(&headers, from_email));
    }
    let token = auth::access_token_for(account)?;
    let client = graph::http_client()?;
    let url = format!(
        "https://graph.microsoft.com/v1.0/me/messages/{}?$select=internetMessageHeaders",
        graph::path_segment(id)
    );
    let value = graph::graph_get_pub(&client, &token, &url)?;
    Ok(microsoft_verdict(&pairs(&value["internetMessageHeaders"]), from_email))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect()
    }

    // As Exchange Online writes them (2026-11-11, an outside sender and an internal one).
    const MS_OUTSIDE: &str = "mx.microsoft.com 1; spf=pass (sender IP is 2a00:1450:4864:36::11) smtp.mailfrom=lawfirm.example; dkim=pass (signature was verified) header.d=lawfirm.example;dmarc=bestguesspass action=none header.from=lawfirm.example;compauth=pass reason=109";
    const MS_INTERNAL: &str = "dkim=none (message not signed) header.d=none;dmarc=none action=none header.from=company.example;";
    const GOOGLE: &str = "mx.google.com;       dkim=pass header.i=@gmail.com header.s=20251104 header.b=dcAVgaiV;       arc=pass (i=1);       spf=pass (google.com: domain of friend@gmail.com designates 209.85.220.41 as permitted sender) smtp.mailfrom=friend@gmail.com;       dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=gmail.com";

    #[test]
    fn microsoft_passes_an_outside_sender_its_checks_vouch_for() {
        let headers = h(&[
            ("ARC-Authentication-Results", "i=1; mx.google.com; arc=none"),
            ("Authentication-Results", MS_OUTSIDE),
            ("X-MS-Exchange-Organization-AuthAs", "Anonymous"),
        ]);
        assert!(microsoft_verdict(&headers, "Partner@LawFirm.example"));
        // The same checks don't vouch for a different From domain.
        assert!(!microsoft_verdict(&headers, "jon@plan2.example"));
    }

    #[test]
    fn microsoft_passes_mail_from_inside_the_organisation() {
        let headers = h(&[("Authentication-Results", MS_INTERNAL), ("X-MS-Exchange-Organization-AuthAs", "Internal")]);
        assert!(microsoft_verdict(&headers, "colleague@company.example"));
        let outside = h(&[("Authentication-Results", MS_INTERNAL), ("X-MS-Exchange-Organization-AuthAs", "Anonymous")]);
        assert!(!microsoft_verdict(&outside, "colleague@company.example"), "dmarc=none from outside is not proof");
    }

    #[test]
    fn a_forged_own_address_fails() {
        // Spoofed "from you": DMARC failed, and the forger's own pass sits lower down.
        let headers = h(&[
            ("Authentication-Results", "mx.microsoft.com 1; spf=fail smtp.mailfrom=evil.example; dkim=none header.d=none;dmarc=fail action=quarantine header.from=plan2.example;compauth=fail reason=000"),
            ("Authentication-Results", "mx.microsoft.com 1; dmarc=pass header.from=plan2.example"),
        ]);
        assert!(!microsoft_verdict(&headers, "jon@plan2.example"));
        // A DKIM pass for another domain is no help.
        let other = h(&[("Authentication-Results", "mx.microsoft.com 1; dkim=pass header.d=evil.example; dmarc=none header.from=plan2.example")]);
        assert!(!microsoft_verdict(&other, "jon@plan2.example"));
    }

    #[test]
    fn only_the_providers_own_header_counts() {
        let planted = h(&[("Authentication-Results", "attacker.example; dmarc=pass header.from=plan2.example")]);
        assert!(!microsoft_verdict(&planted, "jon@plan2.example"));
        assert!(!gmail_verdict(&planted, "jon@plan2.example"));
        assert!(!microsoft_verdict(&[], "jon@plan2.example"), "no header, no proof");
    }

    #[test]
    fn gmail_passes_dmarc_for_the_from_domain() {
        let headers = h(&[("ARC-Authentication-Results", "i=2; mx.google.com; dmarc=pass header.from=gmail.com"), ("Authentication-Results", GOOGLE)]);
        assert!(gmail_verdict(&headers, "friend@gmail.com"));
        assert!(!gmail_verdict(&headers, "friend@yahoo.example"));
        // bestguesspass is Microsoft's; Gmail never writes it.
        let guess = h(&[("Authentication-Results", "mx.google.com; dmarc=bestguesspass header.from=gmail.com")]);
        assert!(!gmail_verdict(&guess, "friend@gmail.com"));
    }

    #[test]
    fn aligned_dkim_passes_when_there_is_no_dmarc_policy() {
        let headers = h(&[("Authentication-Results", "mx.google.com; dkim=pass header.i=@news.shop.example; spf=pass smtp.mailfrom=bounce.example; dmarc=none header.from=news.shop.example")]);
        assert!(gmail_verdict(&headers, "deals@news.shop.example"));
        let parent = h(&[("Authentication-Results", "mx.google.com; dkim=pass header.d=shop.example; dmarc=none header.from=news.shop.example")]);
        assert!(gmail_verdict(&parent, "deals@news.shop.example"));
        let unrelated = h(&[("Authentication-Results", "mx.google.com; dkim=pass header.d=notshop.example; dmarc=none header.from=shop.example")]);
        assert!(!gmail_verdict(&unrelated, "deals@shop.example"));
    }

    #[test]
    fn comments_cannot_smuggle_results() {
        let headers = h(&[("Authentication-Results", "mx.google.com; dmarc=fail (dmarc=pass header.from=gmail.com; x) header.from=gmail.com")]);
        assert!(!gmail_verdict(&headers, "friend@gmail.com"));
    }

    #[test]
    fn no_usable_from_address_fails() {
        let headers = h(&[("Authentication-Results", GOOGLE)]);
        assert!(!gmail_verdict(&headers, ""));
        assert!(!gmail_verdict(&headers, "not-an-address"));
    }
}

