//! A message's headers, fetched once for everything that reads them when it
//! opens (2.0, #104): the sender check (senderauth.rs) and the unsubscribe
//! offer (unsubscribe.rs) used to ask Graph or Gmail for the same headers
//! one after the other. The answer is kept for two minutes.

use crate::{auth, google, graph};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// What Gmail is asked for: its metadata answer carries only named headers.
pub const GMAIL_NAMES: [&str; 3] = ["Authentication-Results", "List-Unsubscribe", "List-Unsubscribe-Post"];

const KEEP: Duration = Duration::from_secs(120);
const MAX_KEPT: usize = 64;

type Headers = Arc<Vec<(String, String)>>;
static KEPT: Mutex<Option<HashMap<String, (Instant, Headers)>>> = Mutex::new(None);

fn kept(key: &str) -> Option<Headers> {
    let map = KEPT.lock().ok()?;
    let (at, headers) = map.as_ref()?.get(key)?;
    (at.elapsed() < KEEP).then(|| headers.clone())
}

fn keep(key: String, headers: Headers) {
    if let Ok(mut map) = KEPT.lock() {
        let map = map.get_or_insert_with(Default::default);
        map.retain(|_, (at, _)| at.elapsed() < KEEP);
        if map.len() >= MAX_KEPT {
            if let Some(oldest) = map.iter().min_by_key(|(_, (at, _))| *at).map(|(k, _)| k.clone()) {
                map.remove(&oldest);
            }
        }
        map.insert(key, (Instant::now(), headers));
    }
}

/// Name and value pairs from Graph's internetMessageHeaders.
pub fn pairs(list: &serde_json::Value) -> Vec<(String, String)> {
    list.as_array()
        .map(|items| items.iter().map(|h| (h["name"].as_str().unwrap_or("").to_string(), h["value"].as_str().unwrap_or("").to_string())).collect())
        .unwrap_or_default()
}

/// The first header of that name, any case.
pub fn first<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

pub fn of(email: &str, message_id: &str) -> Result<Headers, String> {
    let id = message_id.trim();
    if id.is_empty() || id.len() > 512 {
        return Err("Choose a message.".into());
    }
    let key = format!("{}\n{id}", email.trim().to_lowercase());
    if let Some(found) = kept(&key) {
        return Ok(found);
    }
    let list = if auth::is_google(email) {
        google::headers(email, id, &GMAIL_NAMES)?
    } else {
        let token = auth::access_token_for(email)?;
        let client = graph::http_client()?;
        let url = format!("https://graph.microsoft.com/v1.0/me/messages/{}?$select=internetMessageHeaders", graph::path_segment(id));
        pairs(&graph::graph_get_pub(&client, &token, &url)?["internetMessageHeaders"])
    };
    let headers = Arc::new(list);
    keep(key, headers.clone());
    Ok(headers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kept_answers_are_reused_then_expire_and_the_oldest_goes_first() {
        let h = |v: &str| Arc::new(vec![("List-Unsubscribe".to_string(), v.to_string())]);
        keep("a@x\n1".into(), h("one"));
        assert_eq!(first(&kept("a@x\n1").unwrap(), "list-unsubscribe"), Some("one"));
        for i in 0..MAX_KEPT + 5 {
            keep(format!("b@x\n{i}"), h("x"));
        }
        assert!(kept("a@x\n1").is_none(), "the oldest made room");
        assert!(KEPT.lock().unwrap().as_ref().unwrap().len() <= MAX_KEPT);
        assert_eq!(pairs(&serde_json::json!([{ "name": "A", "value": "1" }])), vec![("A".to_string(), "1".to_string())]);
    }
}
