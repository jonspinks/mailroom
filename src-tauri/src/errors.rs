//! What the page shows when Microsoft or Google refuse a request.
//!
//! Inside the app, a refusal stays "Graph refused the request (502 Bad
//! Gateway). {json}": code below matches on that (a 404 is a gone message,
//! a 410 restarts a sync). Only on its way to the page, in `in_background`,
//! does it become a sentence a person can act on (2026-11-12: a 502 showed
//! its raw JSON). The service's own error code and request id go to
//! ~/.local/state/mailroom/mailroom.log instead, without any message text.

/// The page's sentence for `raw`, or `raw` itself when it isn't a refusal.
pub fn friendly(raw: &str) -> String {
    let Some(refusal) = Refusal::parse(raw) else { return raw.to_string() };
    log(&refusal);
    refusal.sentence()
}

struct Refusal {
    service: &'static str,
    status: u16,
    code: String,
    message: String,
    request_id: String,
}

impl Refusal {
    fn parse(raw: &str) -> Option<Refusal> {
        let (service, rest) = [("Graph refused the request (", "Microsoft"), ("Google refused the request (", "Google")]
            .iter()
            .find_map(|(prefix, name)| raw.strip_prefix(prefix).map(|rest| (*name, rest)))?;
        let status: u16 = rest.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
        let detail = rest.split_once(").").map(|(_, d)| d.trim()).unwrap_or("");
        let json: serde_json::Value = serde_json::from_str(detail).unwrap_or(serde_json::Value::Null);
        let error = &json["error"];
        let text = |v: &serde_json::Value| v.as_str().unwrap_or("").trim().to_string();
        let code = text(&error["code"]).chars().take(80).collect();
        let message = if error.is_object() {
            text(&error["message"])
        } else if json.is_null() {
            // Google's refusals carry a plain reason, not JSON.
            detail.to_string()
        } else {
            String::new()
        };
        let inner = &error["innerError"];
        let request_id = [&inner["request-id"], &inner["client-request-id"], &error["requestId"]]
            .iter()
            .map(|v| text(v))
            .find(|v| !v.is_empty())
            .unwrap_or_default()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .take(64)
            .collect();
        Some(Refusal { service, status, code, message, request_id })
    }

    /// A short, plain message from the service, when it gave one worth showing.
    fn reason(&self) -> Option<String> {
        let m = self.message.trim().trim_end_matches('.');
        let useless = m.is_empty()
            || m.len() > 160
            || m.contains('{')
            || m.eq_ignore_ascii_case("UnknownError")
            || m.eq_ignore_ascii_case(&self.code);
        (!useless).then(|| format!("{m}."))
    }

    fn sentence(&self) -> String {
        let who = self.service;
        match self.status {
            404 => "That item is no longer on the server. It may have been moved or deleted.".into(),
            409 | 412 => "That changed on the server in the meantime. Refresh, then try again.".into(),
            413 => format!("That is too large for {who}."),
            429 => format!("{who} is busy and asked Mailroom to slow down. Try again in a minute."),
            500..=599 => format!("{who} is having trouble right now ({}). Try again in a minute.", self.status),
            403 => match self.reason() {
                Some(why) => format!("{who} didn't allow that: {why}"),
                None => format!("{who} didn't allow that. Your account may not have permission."),
            },
            _ => match self.reason() {
                Some(why) => format!("{who} couldn't do that: {why}"),
                None => format!("{who} couldn't do that ({}).", self.status),
            },
        }
    }
}

fn log(r: &Refusal) {
    let mut line = format!("{} refused ({})", r.service, r.status);
    if !r.code.is_empty() {
        line.push_str(&format!(" {}", r.code.replace(char::is_whitespace, "")));
    }
    if !r.request_id.is_empty() {
        line.push_str(&format!(" request-id {}", r.request_id));
    }
    crate::google::log(&line);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sentence(raw: &str) -> String {
        Refusal::parse(raw).map(|r| r.sentence()).unwrap_or_else(|| raw.to_string())
    }

    #[test]
    fn a_bad_gateway_reads_as_trouble_at_microsoft() {
        let raw = r#"Graph refused the request (502 Bad Gateway). {"error":{"code":"UnknownError","message":"","innerError":{"date":"2026-11-12T20:36:34","request-id":"32e4b66e-1547-4fe3-a7f0-cd1f417ac3a4","client-request-id":"32e4b66e-1547-4fe3-a7f0-cd1f417ac3a4"}}}"#;
        assert_eq!(sentence(raw), "Microsoft is having trouble right now (502). Try again in a minute.");
        let r = Refusal::parse(raw).unwrap();
        assert_eq!((r.code.as_str(), r.request_id.as_str()), ("UnknownError", "32e4b66e-1547-4fe3-a7f0-cd1f417ac3a4"));
    }

    #[test]
    fn common_refusals_say_what_to_do() {
        assert_eq!(
            sentence(r#"Graph refused the request (404 Not Found). {"error":{"code":"ErrorItemNotFound","message":"The specified object was not found in the store."}}"#),
            "That item is no longer on the server. It may have been moved or deleted."
        );
        assert_eq!(sentence("Graph refused the request (429 Too Many Requests)."), "Microsoft is busy and asked Mailroom to slow down. Try again in a minute.");
        assert_eq!(sentence("Google refused the request (503)."), "Google is having trouble right now (503). Try again in a minute.");
        assert_eq!(sentence("Graph refused the request (412 Precondition Failed). {}"), "That changed on the server in the meantime. Refresh, then try again.");
    }

    #[test]
    fn a_plain_reason_is_kept_and_json_is_not() {
        assert_eq!(
            sentence(r#"Graph refused the request (400 Bad Request). {"error":{"code":"ErrorInvalidRecipients","message":"At least one recipient isn't valid."}}"#),
            "Microsoft couldn't do that: At least one recipient isn't valid."
        );
        assert_eq!(sentence("Graph refused the request (400 Bad Request). {\"error\":{\"code\":\"X\",\"message\":\"\"}}"), "Microsoft couldn't do that (400).");
        assert_eq!(sentence("Google refused the request (400). Invalid label"), "Google couldn't do that: Invalid label.");
        assert_eq!(sentence("Graph refused the request (403 Forbidden). {}"), "Microsoft didn't allow that. Your account may not have permission.");
    }

    #[test]
    fn anything_else_passes_through_unchanged() {
        for raw in ["Could not reach Microsoft Graph: dns error", "Sign in again to send mail.", "Choose a folder.", ""] {
            assert_eq!(friendly(raw), raw);
        }
    }
}
