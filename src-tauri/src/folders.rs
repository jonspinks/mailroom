//! Whole-folder actions: mark everything read, and empty Deleted Items or Junk.

use crate::auth;
use crate::calendar::call;
use crate::graph;
use serde_json::{json, Value};

const ME: &str = "https://graph.microsoft.com/v1.0/me";
/// Graph takes up to 20 requests in one $batch.
const BATCH: usize = 20;
/// A folder is worked through at most this many pages of 100.
const PAGES: usize = 50;

fn folder_url(folder_id: &str) -> String {
    format!("{ME}/mailFolders/{}", graph::path_segment(folder_id.trim()))
}

/// The $batch bodies for one change to many messages.
pub fn batches(ids: &[String], method: &str, body: Option<&Value>) -> Vec<Value> {
    ids.chunks(BATCH)
        .map(|chunk| {
            let requests: Vec<Value> = chunk
                .iter()
                .enumerate()
                .map(|(i, id)| {
                    let mut request = json!({
                        "id": i.to_string(),
                        "method": method,
                        "url": format!("/me/messages/{}", graph::path_segment(id))
                    });
                    if let Some(body) = body {
                        request["body"] = body.clone();
                        request["headers"] = json!({ "Content-Type": "application/json" });
                    }
                    request
                })
                .collect();
            json!({ "requests": requests })
        })
        .collect()
}

fn ids_in(email: &str, folder_id: &str, filter: &str) -> Result<(String, reqwest::blocking::Client, Vec<String>), String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let mut url = format!("{}/messages?$select=id&$top=100", folder_url(folder_id));
    if !filter.is_empty() {
        url.push_str("&$filter=");
        url.push_str(filter);
    }
    let items = graph::graph_pages(&client, &token, &url, PAGES)?;
    let ids = items.iter().filter_map(|item| item["id"].as_str().map(String::from)).collect();
    Ok((token, client, ids))
}

fn run(client: &reqwest::blocking::Client, token: &str, bodies: Vec<Value>) -> Result<usize, String> {
    let mut done = 0;
    for body in bodies {
        let reply = call(client, token, "POST", "https://graph.microsoft.com/v1.0/$batch", Some(&body))
            .map_err(|(status, _)| if status == 401 || status == 403 { "Sign in again to change this folder.".to_string() } else { "Microsoft did not finish. Try again.".to_string() })?;
        done += reply["responses"]
            .as_array()
            .map(|list| list.iter().filter(|r| r["status"].as_u64().is_some_and(|s| (200..300).contains(&s))).count())
            .unwrap_or(0);
    }
    Ok(done)
}

/// Mark every unread message in a folder read. Returns how many.
pub fn mark_folder_read(email: &str, folder_id: &str) -> Result<usize, String> {
    let (token, client, ids) = ids_in(email, folder_id, "isRead%20eq%20false")?;
    run(&client, &token, batches(&ids, "PATCH", Some(&json!({ "isRead": true }))))
}

/// Delete everything in Deleted Items or Junk. Any other folder is refused,
/// whatever the page asks.
pub fn empty_folder(email: &str, folder_id: &str) -> Result<usize, String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let wanted = folder_id.trim();
    let mut allowed = false;
    for name in ["deleteditems", "junkemail"] {
        if let Ok(found) = call(&client, &token, "GET", &format!("{ME}/mailFolders/{name}?$select=id"), None) {
            if found["id"].as_str() == Some(wanted) {
                allowed = true;
            }
        }
    }
    if !allowed {
        return Err("Only Deleted Items and Junk can be emptied.".into());
    }
    let (token, client, ids) = ids_in(email, wanted, "")?;
    run(&client, &token, batches(&ids, "DELETE", None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_go_in_batches_of_twenty() {
        let ids: Vec<String> = (0..45).map(|i| format!("m{i}/x")).collect();
        let reads = batches(&ids, "PATCH", Some(&json!({ "isRead": true })));
        assert_eq!(reads.len(), 3);
        assert_eq!(reads[0]["requests"].as_array().unwrap().len(), 20);
        assert_eq!(reads[2]["requests"].as_array().unwrap().len(), 5);
        assert_eq!(reads[0]["requests"][1]["url"], "/me/messages/m1%2Fx");
        assert_eq!(reads[0]["requests"][0]["body"]["isRead"], true);
        let deletes = batches(&ids[..2], "DELETE", None);
        assert!(deletes[0]["requests"][0].get("body").is_none());
        assert_eq!(deletes[0]["requests"][0]["method"], "DELETE");
    }
}
