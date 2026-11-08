//! Unsubscribe, as Outlook offers it: from the List-Unsubscribe headers
//! the sender put on the message (RFC 2369), with one-click (RFC 8058)
//! when the sender supports it. The headers are read here from Microsoft,
//! never taken from the page.

use crate::{auth, graph};
use serde::Serialize;

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// An https address that takes a one-click POST.
    pub one_click: String,
    /// An http(s) page to open in the browser.
    pub web: String,
    /// An address to mail, with the subject the sender asked for.
    pub mailto: String,
    pub mailto_subject: String,
}

#[cfg(test)]
impl Options {
    pub fn any(&self) -> bool {
        !self.one_click.is_empty() || !self.web.is_empty() || !self.mailto.is_empty()
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let Some(byte) = text.get(i + 1..i + 3).and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A one-click POST goes out from this computer, so it may only go to a
/// public host: never to this machine or the local network.
pub(crate) fn public_host(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']').trim_end_matches('.').to_ascii_lowercase();
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return public_ip(ip);
    }
    host.contains('.') && !host.ends_with(".localhost") && !host.ends_with(".local") && !host.ends_with(".internal")
}

pub(crate) fn public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || a == 0
                || a >= 240
                || (a == 100 && b & 0xc0 == 64)
                || (a == 192 && b == 0 && v4.octets()[2] == 0)
                || (a == 198 && b & 0xfe == 18))
        }
        std::net::IpAddr::V6(v6) => {
            let s = v6.segments();
            // An IPv4 address carried inside IPv6 is judged as IPv4: mapped
            // (::ffff:a.b.c.d), NAT64 (64:ff9b::a.b.c.d) and 6to4 (2002:ab:cd::).
            let embedded = if let Some(v4) = v6.to_ipv4_mapped() {
                Some(v4)
            } else if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                Some(std::net::Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8))
            } else if s[0] == 0x2002 {
                Some(std::net::Ipv4Addr::new((s[1] >> 8) as u8, s[1] as u8, (s[2] >> 8) as u8, s[2] as u8))
            } else {
                None
            };
            match embedded {
                Some(v4) => public_ip(std::net::IpAddr::V4(v4)),
                None => !(v6.is_loopback()
                    || v6.is_unspecified()
                    || v6.is_multicast()
                    || s[0] & 0xfe00 == 0xfc00
                    || s[0] & 0xffc0 == 0xfe80
                    || s[0] & 0xffc0 == 0xfec0),
            }
        }
    }
}

/// Read List-Unsubscribe and List-Unsubscribe-Post header values.
pub fn parse(list: &str, post: &str) -> Options {
    let mut options = Options::default();
    let one_click = post.split(';').any(|part| part.trim().eq_ignore_ascii_case("List-Unsubscribe=One-Click"));
    for part in list.split(',') {
        let item = part.trim();
        let Some(inner) = item.strip_prefix('<').and_then(|rest| rest.strip_suffix('>')) else { continue };
        let target: String = inner.chars().filter(|ch| !ch.is_whitespace()).collect();
        if target.len() > 2000 {
            continue;
        }
        let lower = target.to_ascii_lowercase();
        if lower.starts_with("https://") || lower.starts_with("http://") {
            if !graph::allowed_link(&target) {
                continue;
            }
            if one_click && lower.starts_with("https://") && options.one_click.is_empty() && reqwest::Url::parse(&target).is_ok_and(|url| public_host(&url)) {
                options.one_click = target.clone();
            }
            if options.web.is_empty() {
                options.web = target;
            }
        } else if let Some(rest) = target.strip_prefix("mailto:").or_else(|| target.strip_prefix("MAILTO:")) {
            if !options.mailto.is_empty() {
                continue;
            }
            let (addr, query) = rest.split_once('?').unwrap_or((rest, ""));
            let addr = percent_decode(addr);
            if addr.contains('@') && !addr.contains([',', ';', '<', '>', ' ']) && addr.len() <= 254 {
                options.mailto = addr;
                options.mailto_subject = query
                    .split('&')
                    .find_map(|pair| pair.split_once('=').filter(|(key, _)| key.eq_ignore_ascii_case("subject")).map(|(_, value)| percent_decode(&value.replace('+', " "))))
                    .unwrap_or_default()
                    .chars()
                    .filter(|ch| !ch.is_control())
                    .take(200)
                    .collect();
            }
        }
    }
    options
}

fn header<'a>(headers: &'a serde_json::Value, name: &str) -> &'a str {
    headers
        .as_array()
        .into_iter()
        .flatten()
        .find(|item| item["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)))
        .and_then(|item| item["value"].as_str())
        .unwrap_or("")
}

pub fn options(email: &str, message_id: &str) -> Result<Options, String> {
    let id = message_id.trim();
    if id.is_empty() {
        return Err("Choose a message.".into());
    }
    if auth::is_google(email) {
        let found = crate::google::headers(email, id, &["List-Unsubscribe", "List-Unsubscribe-Post"])?;
        return Ok(parse(&found[0].1, &found[1].1));
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let url = format!(
        "https://graph.microsoft.com/v1.0/me/messages/{}?$select=internetMessageHeaders",
        graph::path_segment(id)
    );
    let response = client
        .get(&url)
        .bearer_auth(&token)
        .header("Accept", "application/json")
        .send()
        .map_err(|err| format!("Could not reach Microsoft Graph: {err}"))?;
    if !response.status().is_success() {
        return Ok(Options::default());
    }
    let value: serde_json::Value = response.json().map_err(|_| "Graph sent an unreadable response.".to_string())?;
    let headers = &value["internetMessageHeaders"];
    Ok(parse(header(headers, "List-Unsubscribe"), header(headers, "List-Unsubscribe-Post")))
}

/// What happened: "done" (one-click or mailed), or "open" with a page to show.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub how: String,
    pub url: String,
}

/// The RFC 8058 POST: no cookies and no Graph token. Every hop's host is
/// resolved, checked to be public and pinned, as for remote pictures, so a
/// name that points at this machine or the local network is refused too.
fn one_click_post(target: &str) -> bool {
    let Ok(mut url) = reqwest::Url::parse(target) else { return false };
    for _ in 0..=3 {
        let Ok((host, addr)) = crate::remoteimg::public_target(&url) else { return false };
        let Ok(client) = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .resolve(&host, addr)
            .build()
        else {
            return false;
        };
        let Ok(response) = client
            .post(url.clone())
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body("List-Unsubscribe=One-Click")
            .send()
        else {
            return false;
        };
        if response.status().is_redirection() {
            // A redirect keeps the POST, so it is held to the same rule.
            let next = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| url.join(value).ok());
            match next {
                Some(next) => url = next,
                None => return false,
            }
            continue;
        }
        return response.status().is_success();
    }
    false
}

pub fn unsubscribe(email: &str, message_id: &str) -> Result<Outcome, String> {
    let found = options(email, message_id)?;
    if !found.one_click.is_empty() {
        if one_click_post(&found.one_click) {
            return Ok(Outcome { how: "done".into(), url: String::new() });
        }
        // The sender's server did not take it. Mail is never sent in its
        // place: you were told a request would be made, not a message sent.
        if !found.web.is_empty() {
            return Ok(Outcome { how: "open".into(), url: found.web });
        }
        return Err("The sender's server did not take the request. Try again later.".into());
    }
    if !found.mailto.is_empty() {
        let subject = if found.mailto_subject.trim().is_empty() { "unsubscribe".to_string() } else { found.mailto_subject.clone() };
        let mail = graph::OutgoingMail { subject, body_html: "<p>unsubscribe</p>".into(), to: found.mailto.clone(), ..Default::default() };
        if auth::is_google(email) {
            crate::google::send(email, &mail, "", "", crate::compose::Mode::New, None, &[], "")?;
        } else {
            graph::send_mail(email, &mail)?;
        }
        return Ok(Outcome { how: "done".into(), url: String::new() });
    }
    if !found.web.is_empty() {
        return Ok(Outcome { how: "open".into(), url: found.web });
    }
    Err("This sender did not say how to unsubscribe.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_click_web_and_mail_are_read_from_the_headers() {
        let found = parse(
            "<mailto:leave-123@lists.example.com?subject=Unsubscribe%20me>, <https://news.example.com/u?id=1>",
            "List-Unsubscribe=One-Click",
        );
        assert_eq!(found.one_click, "https://news.example.com/u?id=1");
        assert_eq!(found.web, "https://news.example.com/u?id=1");
        assert_eq!(found.mailto, "leave-123@lists.example.com");
        assert_eq!(found.mailto_subject, "Unsubscribe me");
    }

    #[test]
    fn without_the_post_header_a_link_only_opens() {
        let found = parse("<https://news.example.com/u>", "");
        assert!(found.one_click.is_empty());
        assert_eq!(found.web, "https://news.example.com/u");
    }

    #[test]
    fn bad_targets_are_refused() {
        let found = parse("<javascript:alert(1)>, <file:///etc/passwd>, <https://user:pw@x.example/u>, <mailto:a@b.com,c@d.com>, nobrackets@example.com", "List-Unsubscribe=One-Click");
        assert!(!found.any(), "{found:?}");
        assert!(!parse("<http://news.example.com/u>", "List-Unsubscribe=One-Click").one_click.starts_with("http:"));
    }

    #[test]
    fn the_post_is_refused_before_connecting_to_a_private_or_plain_target() {
        for target in ["https://127.0.0.1/u", "https://[::1]/u", "https://10.0.0.8/u", "http://news.example.com/u", "https://printer.local/u", "not a url"] {
            assert!(!one_click_post(target), "{target}");
        }
    }

    #[test]
    fn one_click_never_posts_to_this_machine_or_the_local_network() {
        for target in ["https://127.0.0.1/u", "https://10.0.0.1/u", "https://192.168.1.1/u", "https://[::1]/u", "https://[::ffff:127.0.0.1]/u", "https://localhost/u", "https://router.local/u", "https://169.254.169.254/u", "https://100.64.0.1/u"] {
            let found = parse(&format!("<{target}>"), "List-Unsubscribe=One-Click");
            assert!(found.one_click.is_empty(), "{target}");
        }
        assert!(public_host(&reqwest::Url::parse("https://news.example.com/u").unwrap()));
        assert!(public_host(&reqwest::Url::parse("https://8.8.8.8/u").unwrap()));
    }
}
