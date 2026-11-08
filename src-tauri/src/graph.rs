use crate::auth;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};

const MESSAGE_SELECT: &str = "id,conversationId,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,bodyPreview,isRead,flag,body,hasAttachments,categories,importance,inferenceClassification";
/// A folder fill. The letter is fetched when it is opened. `bodyPreview` is
/// the list line, and the attachment expand still names the files.
const LIST_SELECT: &str = "id,conversationId,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,bodyPreview,isRead,flag,hasAttachments,categories,importance,inferenceClassification";
/// The anchor walk only wants the delta link. Graph keeps `$select` on that
/// link, but the pages themselves are thrown away, so they omit the body.
const ANCHOR_SELECT: &str = LIST_SELECT;
const ATTACHMENT_SELECT: &str = "id,name,contentType,size,isInline";
const MAX_ATTACHMENT_BYTES: usize = 32 * 1024 * 1024;
const FOLDER_SELECT: &str =
    "id,displayName,parentFolderId,childFolderCount,unreadItemCount,totalItemCount,isHidden";
const WELL_KNOWN_FOLDERS: [&str; 6] = ["inbox", "drafts", "outbox", "sentitems", "archive", "deleteditems"];
const MAX_FOLDER_DEPTH: i64 = 4;
const MAX_FOLDER_PAGES: usize = 8;
const MAIL_PAGE: usize = 40;
const MAIL_SYNC_PAGES: usize = 25;
const CALENDAR_LIST_PAGES: usize = 4;
const CALENDAR_EVENT_PAGES: usize = 20;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveFile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub content_type: String,
    #[serde(default)]
    pub size: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LivePerson {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub email: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveMessage {
    pub id: String,
    pub thread: String,
    pub subject: String,
    pub from_name: String,
    pub from_email: String,
    pub received: String,
    pub preview: String,
    pub body_html: String,
    pub unread: bool,
    pub flagged: bool,
    pub has_attachments: bool,
    #[serde(default)]
    pub files: Vec<LiveFile>,
    #[serde(default)]
    pub to: Vec<LivePerson>,
    #[serde(default)]
    pub cc: Vec<LivePerson>,
    #[serde(default)]
    pub bcc: Vec<LivePerson>,
    /// Outlook category names on the message.
    #[serde(default)]
    pub categories: Vec<String>,
    /// "high" or "low"; empty when normal.
    #[serde(default)]
    pub importance: String,
    /// A meeting invite, update or cancellation.
    #[serde(default)]
    pub invite: bool,
    /// Focused Inbox: "focused" or "other"; empty when not said.
    #[serde(default)]
    pub focus: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSearchHit {
    #[serde(flatten)]
    pub message: LiveMessage,
    pub parent_folder_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailSearchPage {
    pub messages: Vec<MailSearchHit>,
    pub next_link: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveFolder {
    pub id: String,
    pub parent_id: String,
    pub name: String,
    pub key: String,
    pub unread: i64,
    pub total: i64,
    pub depth: i64,
}

pub fn folder_key(well_known: &str, id: &str) -> String {
    match well_known.trim().to_ascii_lowercase().as_str() {
        "inbox" => "inbox".into(),
        "drafts" => "drafts".into(),
        "outbox" => "outbox".into(),
        "sentitems" => "sent".into(),
        "archive" => "archive".into(),
        "deleteditems" => "trash".into(),
        _ => id.to_string(),
    }
}

pub fn fetch_mailbox(email: &str, since: &str) -> Result<(String, String, Vec<LiveFolder>, Vec<LiveMessage>), String> {
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let me = graph_get(
        &client,
        &token,
        "https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName",
    )?;
    let name = me["displayName"].as_str().unwrap_or("").to_string();
    let email = me["mail"]
        .as_str()
        .filter(|value| !value.is_empty())
        .or_else(|| me["userPrincipalName"].as_str())
        .unwrap_or("")
        .to_string();
    let folders = list_folders(&client, &token)?;
    let inbox_id = folders
        .iter()
        .find(|folder| folder.key == "inbox")
        .map(|folder| folder.id.as_str())
        .unwrap_or("inbox");
    let messages = messages_in(&client, &token, inbox_id, since)?;
    Ok((name, email, folders, messages))
}

pub fn fetch_folder(email: &str, folder_id: &str, since: &str) -> Result<Vec<LiveMessage>, String> {
    let id = folder_id.trim();
    if id.is_empty() {
        return Err("Choose a folder.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    messages_in(&client, &token, id, since)
}

/// Microsoft lets an app have only four requests in flight on one mailbox
/// and answers the rest 429 "MailboxConcurrency" (2026-10-26: clicking down
/// an Unread list fires several reads per message). Every Graph call goes
/// out through here: at most three at once per signed-in token, and a
/// throttled or busy (429/503) call waits as Graph's Retry-After says, up to
/// 10 s, and tries again, twice.
pub(crate) trait SendGraph {
    fn send_graph(self, token: &str) -> reqwest::Result<reqwest::blocking::Response>;
}

impl SendGraph for reqwest::blocking::RequestBuilder {
    fn send_graph(self, token: &str) -> reqwest::Result<reqwest::blocking::Response> {
        let _slot = MailboxSlot::take(token);
        // A 429 was refused before Graph did anything, so any call may go
        // again. A 503 may come after the work was done (send_mail treats a
        // 5xx as "may have been sent"), so only a call that is safe to repeat
        // goes again on one: never a POST, which could send a message or
        // create an event twice.
        let repeatable = self
            .try_clone()
            .and_then(|copy| copy.build().ok())
            .is_some_and(|built| repeatable_method(built.method()));
        let mut request = self;
        let mut attempt = 0;
        loop {
            let again = request.try_clone();
            let response = request.send()?;
            let status = response.status().as_u16();
            let throttled = status == 429 || (status == 503 && repeatable);
            match again {
                Some(next) if throttled && attempt < 2 => {
                    let wait = retry_after(response.headers()).unwrap_or(1 << attempt).min(10);
                    drop(response);
                    std::thread::sleep(std::time::Duration::from_secs(wait));
                    request = next;
                    attempt += 1;
                }
                _ => return Ok(response),
            }
        }
    }
}

const MAILBOX_SLOTS: usize = 3;

static SLOTS: std::sync::Mutex<Option<HashMap<String, usize>>> = std::sync::Mutex::new(None);
static SLOT_FREED: std::sync::Condvar = std::sync::Condvar::new();

/// One of a mailbox's request slots, given back when dropped.
struct MailboxSlot(String);

impl MailboxSlot {
    fn take(token: &str) -> MailboxSlot {
        let key = token.to_string();
        let mut slots = SLOTS.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            let busy = slots.get_or_insert_with(HashMap::new).get(&key).copied().unwrap_or(0);
            if busy < MAILBOX_SLOTS {
                slots.get_or_insert_with(HashMap::new).insert(key.clone(), busy + 1);
                return MailboxSlot(key);
            }
            slots = SLOT_FREED.wait(slots).unwrap_or_else(|e| e.into_inner());
        }
    }
}

impl Drop for MailboxSlot {
    fn drop(&mut self) {
        let mut slots = SLOTS.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(map) = slots.as_mut() {
            match map.get(&self.0).copied() {
                Some(n) if n > 1 => {
                    map.insert(self.0.clone(), n - 1);
                }
                _ => {
                    map.remove(&self.0);
                }
            }
        }
        SLOT_FREED.notify_all();
    }
}

fn repeatable_method(method: &reqwest::Method) -> bool {
    use reqwest::Method;
    [Method::GET, Method::HEAD, Method::PUT, Method::DELETE, Method::OPTIONS].contains(method)
}

/// Graph's Retry-After, in whole seconds.
fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?.trim().parse().ok()
}

pub(crate) fn http_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|err| err.to_string())
}

fn list_folders(client: &reqwest::blocking::Client, token: &str) -> Result<Vec<LiveFolder>, String> {
    let known = well_known_ids(client, token)?;
    let start = format!("https://graph.microsoft.com/v1.0/me/mailFolders?$top=50&$select={FOLDER_SELECT}");
    let mut folders = collect_tree(
        |url| graph_get(client, token, url),
        &start,
        |id| {
            format!(
                "https://graph.microsoft.com/v1.0/me/mailFolders/{}/childFolders?$top=50&$select={FOLDER_SELECT}",
                path_segment(id)
            )
        },
    )?;
    apply_well_known_keys(&mut folders, &known);
    Ok(folders)
}

fn well_known_url(name: &str) -> String {
    format!("https://graph.microsoft.com/v1.0/me/mailFolders/{name}?$select=id")
}

fn well_known_ids(
    client: &reqwest::blocking::Client,
    token: &str,
) -> Result<HashMap<String, String>, String> {
    let mut known = HashMap::new();
    for name in WELL_KNOWN_FOLDERS {
        match graph_get(client, token, &well_known_url(name)) {
            Ok(value) => remember_well_known(&mut known, name, &value),
            Err(err) if folder_is_missing(&err) => {}
            Err(err) => return Err(err),
        }
    }
    Ok(known)
}

fn folder_is_missing(err: &str) -> bool {
    err.starts_with("Graph refused the request (404")
}

fn remember_well_known(known: &mut HashMap<String, String>, name: &str, value: &serde_json::Value) {
    let Some(id) = value.get("id").and_then(|item| item.as_str()).map(str::trim) else {
        return;
    };
    if id.is_empty() {
        return;
    }
    known.insert(id.to_string(), name.to_string());
}

fn apply_well_known_keys(folders: &mut [LiveFolder], known: &HashMap<String, String>) {
    for folder in folders {
        if let Some(name) = known.get(&folder.id) {
            folder.key = folder_key(name, &folder.id);
        }
    }
}

pub fn messages_url(folder_id: &str, since: &str) -> Result<String, String> {
    let stamp = sync_stamp(since)?;
    let mut url = format!(
        "https://graph.microsoft.com/v1.0/me/mailFolders/{}/messages?$top={MAIL_PAGE}&$select={LIST_SELECT}",
        path_segment(folder_id)
    );
    if let Some(stamp) = stamp {
        url.push_str("&$orderby=receivedDateTime%20desc&$filter=");
        url.push_str(&path_segment(&format!("receivedDateTime ge {stamp}")));
    }
    url.push_str("&$expand=attachments($select=");
    url.push_str(ATTACHMENT_SELECT);
    url.push(')');
    Ok(url)
}

fn sync_stamp(since: &str) -> Result<Option<&str>, String> {
    let since = since.trim();
    if since.is_empty() {
        return Ok(None);
    }
    if !valid_sync_stamp(since) {
        return Err("Choose a sync window.".into());
    }
    Ok(Some(since))
}

fn valid_sync_stamp(since: &str) -> bool {
    let bytes = since.as_bytes();
    if bytes.len() < 20 || bytes.len() > 32 || !since.ends_with('Z') {
        return false;
    }
    bytes.iter().all(|byte| byte.is_ascii_digit() || matches!(byte, b'-' | b'T' | b':' | b'.' | b'Z'))
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.get(10) == Some(&b'T')
        && bytes.get(13) == Some(&b':')
        && bytes.get(16) == Some(&b':')
}

fn message_in_window(received: &str, stamp: &str) -> bool {
    let stamp = stamp.trim();
    if stamp.is_empty() {
        return true;
    }
    let got: String = received.chars().take(19).collect();
    let cut: String = stamp.chars().take(19).collect();
    got.len() >= 19 && cut.len() >= 19 && got >= cut
}

fn trusted_mail_link(url: &str) -> bool {
    if url.len() > 4096 || url.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        return false;
    }
    let folder = url.starts_with("https://graph.microsoft.com/v1.0/me/mailFolders/")
        || url.starts_with("https://graph.microsoft.com/v1.0/me/mailFolders(");
    if !folder {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    lower.contains("/messages") && !lower.contains("contentbytes")
}

fn messages_in(
    client: &reqwest::blocking::Client,
    token: &str,
    folder_id: &str,
    since: &str,
) -> Result<Vec<LiveMessage>, String> {
    let stamp = sync_stamp(since)?.unwrap_or("").to_string();
    let mut url = messages_url(folder_id, &stamp)?;
    let cap = MAIL_PAGE * MAIL_SYNC_PAGES;
    let mut out = Vec::new();
    let mut pages = 0usize;
    loop {
        if pages >= MAIL_SYNC_PAGES || out.len() >= cap {
            break;
        }
        if pages > 0 && !trusted_mail_link(&url) {
            break;
        }
        pages += 1;
        let page = graph_get(client, token, &url)?;
        let items = page["value"].as_array().cloned().unwrap_or_default();
        let mut older = false;
        for item in items {
            let Some(message) = parse_message(item) else { continue };
            if !message_in_window(&message.received, &stamp) {
                older = true;
                continue;
            }
            out.push(message);
            if out.len() >= cap {
                break;
            }
        }
        if older || out.len() >= cap {
            break;
        }
        let Some(next) = page.get("@odata.nextLink").and_then(|value| value.as_str()).filter(|next| !next.is_empty()) else {
            break;
        };
        url = next.to_string();
    }
    Ok(out)
}

fn collect_tree<F>(
    mut fetch: F,
    start: &str,
    mut child_url: impl FnMut(&str) -> String,
) -> Result<Vec<LiveFolder>, String>
where
    F: FnMut(&str) -> Result<serde_json::Value, String>,
{
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    walk(&mut fetch, &mut child_url, start, 0, &mut out, &mut seen)?;
    Ok(out)
}

fn walk<F>(
    fetch: &mut F,
    child_url: &mut dyn FnMut(&str) -> String,
    url: &str,
    depth: i64,
    out: &mut Vec<LiveFolder>,
    seen: &mut HashSet<String>,
) -> Result<(), String>
where
    F: FnMut(&str) -> Result<serde_json::Value, String>,
{
    if depth > MAX_FOLDER_DEPTH {
        return Ok(());
    }
    let mut next = Some(url.to_string());
    let mut pages = 0usize;
    while let Some(page_url) = next.take() {
        if pages >= MAX_FOLDER_PAGES {
            break;
        }
        pages += 1;
        let page = fetch(&page_url)?;
        let items = page.get("value").and_then(|value| value.as_array()).cloned().unwrap_or_default();
        for item in items {
            if item.get("isHidden").and_then(|value| value.as_bool()).unwrap_or(false) {
                continue;
            }
            let Some(folder) = folder_from_value(&item, depth) else {
                continue;
            };
            if !seen.insert(folder.id.clone()) {
                continue;
            }
            let has_children = item.get("childFolderCount").and_then(|value| value.as_i64()).unwrap_or(0) > 0;
            let id = folder.id.clone();
            out.push(folder);
            if has_children && depth < MAX_FOLDER_DEPTH {
                let nested = child_url(&id);
                walk(fetch, child_url, &nested, depth + 1, out, seen)?;
            }
        }
        next = page.get("@odata.nextLink").and_then(|value| value.as_str()).map(str::to_string);
    }
    Ok(())
}

fn folder_from_value(value: &serde_json::Value, depth: i64) -> Option<LiveFolder> {
    let id = value.get("id")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let id = id.to_string();
    let well = value.get("wellKnownName").and_then(|item| item.as_str()).unwrap_or("");
    let name = value.get("displayName").and_then(|item| item.as_str()).unwrap_or("").trim();
    let name = if name.is_empty() { "Folder".to_string() } else { name.to_string() };
    Some(LiveFolder {
        parent_id: value.get("parentFolderId").and_then(|item| item.as_str()).unwrap_or("").to_string(),
        name,
        key: folder_key(well, &id),
        unread: value.get("unreadItemCount").and_then(|item| item.as_i64()).unwrap_or(0),
        total: value.get("totalItemCount").and_then(|item| item.as_i64()).unwrap_or(0),
        depth,
        id,
    })
}

pub(crate) fn path_segment(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub(crate) fn graph_get_pub(client: &reqwest::blocking::Client, token: &str, url: &str) -> Result<serde_json::Value, String> {
    graph_get(client, token, url)
}

fn graph_get(client: &reqwest::blocking::Client, token: &str, url: &str) -> Result<serde_json::Value, String> {
    graph_get_paged(client, token, url, None)
}

/// With a page size: Graph's delta pages are 10 messages unless asked.
fn graph_get_paged(client: &reqwest::blocking::Client, token: &str, url: &str, page_size: Option<usize>) -> Result<serde_json::Value, String> {
    let mut request = client.get(url).bearer_auth(token).header("Accept", "application/json");
    if let Some(size) = page_size {
        request = request.header("Prefer", format!("odata.maxpagesize={size}"));
    }
    let response = request
        .send_graph(token)
        .map_err(|err| format!("Could not reach Microsoft Graph: {err}"))?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Graph refused the request ({status}). {}", clip(&text)));
    }
    serde_json::from_str(&text).map_err(|_| "Graph sent an unreadable response.".into())
}

fn parse_message(value: serde_json::Value) -> Option<LiveMessage> {
    let id = value["id"].as_str()?.to_string();
    let thread = value["conversationId"].as_str().unwrap_or(&id).to_string();
    let subject = value["subject"].as_str().unwrap_or("(No subject)").to_string();
    let from_name = value["from"]["emailAddress"]["name"].as_str().unwrap_or("").to_string();
    let from_email = value["from"]["emailAddress"]["address"].as_str().unwrap_or("").to_string();
    let received = value["receivedDateTime"].as_str().unwrap_or("").to_string();
    let preview = value["bodyPreview"].as_str().unwrap_or("").to_string();
    let content = value["body"]["content"].as_str().unwrap_or("").to_string();
    let kind = value["body"]["contentType"].as_str().unwrap_or("html");
    let body_html = if kind.eq_ignore_ascii_case("text") {
        text_to_html(&content)
    } else {
        content
    };
    let unread = !value["isRead"].as_bool().unwrap_or(true);
    let flag_status = value["flag"]["flagStatus"].as_str().unwrap_or("");
    let flagged = flag_status.eq_ignore_ascii_case("flagged");
    let files = value
        .get("attachments")
        .map(files_from_value)
        .unwrap_or_default();
    let has_attachments = value["hasAttachments"].as_bool().unwrap_or(false) || !files.is_empty();
    Some(LiveMessage {
        id,
        thread,
        subject,
        from_name,
        from_email,
        received,
        preview,
        body_html,
        unread,
        flagged,
        has_attachments,
        files,
        to: people_from(&value, "toRecipients"),
        cc: people_from(&value, "ccRecipients"),
        bcc: people_from(&value, "bccRecipients"),
        categories: value["categories"]
            .as_array()
            .map(|list| list.iter().filter_map(|c| c.as_str()).take(25).map(String::from).collect())
            .unwrap_or_default(),
        importance: match value["importance"].as_str().unwrap_or("").to_ascii_lowercase().as_str() {
            "high" => "high".into(),
            "low" => "low".into(),
            _ => String::new(),
        },
        invite: value["@odata.type"].as_str().is_some_and(|kind| kind.starts_with("#microsoft.graph.eventMessage")),
        focus: match value["inferenceClassification"].as_str().unwrap_or("").to_ascii_lowercase().as_str() {
            "focused" => "focused".into(),
            "other" => "other".into(),
            _ => String::new(),
        },
    })
}

#[derive(Clone)]
pub struct MailDelta {
    pub removed: Vec<String>,
    pub changed: Vec<LiveMessage>,
    /// Changes Graph sent as only the fields that moved.
    pub patched: Vec<MessagePatch>,
    pub link: String,
}

/// A message change from mail delta that carries only some fields (a read,
/// flag or category change). Graph does this once the delta has a
/// receivedDateTime filter. Each field is set only when Graph sent it, so the
/// cache keeps the rest.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MessagePatch {
    pub id: String,
    pub subject: Option<String>,
    pub unread: Option<bool>,
    pub flagged: Option<bool>,
    pub categories: Option<Vec<String>>,
    pub importance: Option<String>,
    pub focus: Option<String>,
}

#[derive(Clone)]
pub struct DeltaPage {
    pub removed: Vec<String>,
    pub changed: Vec<LiveMessage>,
    pub patched: Vec<MessagePatch>,
    pub next_link: String,
    pub delta_link: String,
}

pub fn latest_delta_url(folder_id: &str) -> Result<String, String> {
    let id = folder_id.trim();
    if id.is_empty() {
        return Err("Choose a folder.".into());
    }
    Ok(format!(
        "https://graph.microsoft.com/v1.0/me/mailFolders/{}/messages/delta?$deltatoken=latest&$select={MESSAGE_SELECT}",
        path_segment(id)
    ))
}

/// A delta over the sync window: mail received since `since`. Graph's mail
/// delta takes only this filter, and the link it ends with keeps it, so the
/// first round walks the cached window (about the cached count), not years
/// of a busy Inbox. With no window, from now on.
pub fn window_delta_url(folder_id: &str, since: &str) -> Result<String, String> {
    delta_url(folder_id, since, MESSAGE_SELECT)
}

/// Same window as `window_delta_url`, without message bodies. Used only to
/// obtain a delta link. Later syncs still store a body when the message is
/// opened, or when a delta row already carries one.
pub fn anchor_delta_url(folder_id: &str, since: &str) -> Result<String, String> {
    delta_url(folder_id, since, ANCHOR_SELECT)
}

fn delta_url(folder_id: &str, since: &str, select: &str) -> Result<String, String> {
    let Some(stamp) = sync_stamp(since)? else {
        let id = folder_id.trim();
        if id.is_empty() {
            return Err("Choose a folder.".into());
        }
        return Ok(format!(
            "https://graph.microsoft.com/v1.0/me/mailFolders/{}/messages/delta?$deltatoken=latest&$select={select}",
            path_segment(id)
        ));
    };
    let id = folder_id.trim();
    if id.is_empty() {
        return Err("Choose a folder.".into());
    }
    Ok(format!(
        "https://graph.microsoft.com/v1.0/me/mailFolders/{}/messages/delta?$filter={}&$select={select}",
        path_segment(id),
        path_segment(&format!("receivedDateTime ge {stamp}"))
    ))
}

/// The HTML of one message. Used when the cache has the header but not the body.
pub fn fetch_message_body(token: &str, id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("That message is not there.".into());
    }
    let url = format!(
        "https://graph.microsoft.com/v1.0/me/messages/{}?$select=body",
        path_segment(id)
    );
    let client = http_client()?;
    let value = graph_get(&client, token, &url)?;
    let content = value["body"]["content"].as_str().unwrap_or("").to_string();
    let kind = value["body"]["contentType"].as_str().unwrap_or("html");
    if kind.eq_ignore_ascii_case("text") {
        Ok(text_to_html(&content))
    } else {
        Ok(content)
    }
}

pub fn trusted_delta_link(url: &str) -> bool {
    const MAX_LEN: usize = 16384;
    if url.len() > MAX_LEN || url.len() < 16 {
        return false;
    }
    if url.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        return false;
    }
    if !url.starts_with("https://graph.microsoft.com/") {
        return false;
    }
    let path = url.split('?').next().unwrap_or(url);
    let lower_path = path.to_ascii_lowercase();
    if !lower_path.contains("/messages/delta") {
        return false;
    }
    !url.to_ascii_lowercase().contains("contentbytes")
}

pub fn overlap_stamp(received: &str) -> Option<String> {
    let received = received.trim();
    let year: i32 = received.get(0..4)?.parse().ok()?;
    let month: u32 = received.get(5..7)?.parse().ok()?;
    let day: u32 = received.get(8..10)?.parse().ok()?;
    if year < 1 || received.as_bytes().get(4) != Some(&b'-') || received.as_bytes().get(7) != Some(&b'-') {
        return None;
    }
    if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    let rest = received.get(10..)?;
    if !rest.starts_with('T') {
        return None;
    }
    let (year, month, day) = previous_day(year, month, day)?;
    let stamp = format!("{year:04}-{month:02}-{day:02}{rest}");
    if valid_sync_stamp(&stamp) { Some(stamp) } else { None }
}

pub(crate) fn previous_day(year: i32, month: u32, day: u32) -> Option<(i32, u32, u32)> {
    if day > 1 {
        return Some((year, month, day - 1));
    }
    if month > 1 {
        let month = month - 1;
        return Some((year, month, days_in_month(year, month)));
    }
    if year <= 1 {
        return None;
    }
    Some((year - 1, 12, 31))
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

pub fn parse_delta_page(value: &serde_json::Value) -> DeltaPage {
    let mut removed = Vec::new();
    let mut changed = Vec::new();
    let mut patched = Vec::new();
    if let Some(items) = value.get("value").and_then(|item| item.as_array()) {
        for item in items {
            if item.get("@removed").is_some() {
                if let Some(id) = item.get("id").and_then(|id| id.as_str()).map(str::trim).filter(|id| !id.is_empty()) {
                    removed.push(id.to_string());
                }
                continue;
            }
            // Every full row has receivedDateTime (it is selected and never
            // changes); a row without it is only the fields that moved.
            if item.get("receivedDateTime").is_none() {
                if let Some(patch) = parse_patch(item) {
                    patched.push(patch);
                }
                continue;
            }
            if let Some(message) = parse_message(item.clone()) {
                changed.push(message);
            }
        }
    }
    let next_link = value.get("@odata.nextLink").and_then(|item| item.as_str()).unwrap_or("");
    let delta_link = value.get("@odata.deltaLink").and_then(|item| item.as_str()).unwrap_or("");
    DeltaPage {
        removed,
        changed,
        patched,
        next_link: if trusted_delta_link(next_link) { next_link.to_string() } else { String::new() },
        delta_link: if trusted_delta_link(delta_link) { delta_link.to_string() } else { String::new() },
    }
}

fn parse_patch(value: &serde_json::Value) -> Option<MessagePatch> {
    let id = value.get("id")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let level = |text: &str, keep: [&str; 2]| {
        let text = text.to_ascii_lowercase();
        if keep.contains(&text.as_str()) { text } else { String::new() }
    };
    Some(MessagePatch {
        id: id.to_string(),
        subject: value.get("subject").map(|s| s.as_str().unwrap_or("").to_string())
            .map(|s| if s.is_empty() { "(No subject)".into() } else { s }),
        unread: value.get("isRead").and_then(|v| v.as_bool()).map(|read| !read),
        flagged: value.get("flag").map(|f| f["flagStatus"].as_str().unwrap_or("").eq_ignore_ascii_case("flagged")),
        categories: value.get("categories").map(|list| {
            list.as_array()
                .map(|list| list.iter().filter_map(|c| c.as_str()).take(25).map(String::from).collect())
                .unwrap_or_default()
        }),
        importance: value.get("importance").map(|v| level(v.as_str().unwrap_or(""), ["high", "low"])),
        focus: value.get("inferenceClassification").map(|v| level(v.as_str().unwrap_or(""), ["focused", "other"])),
    })
}

pub fn delta_gone(err: &str) -> bool {
    err.contains("(410")
}

fn delta_error(err: String) -> String {
    const REFUSED: &str = "Graph refused the request (";
    if let Some(start) = err.find(REFUSED) {
        let rest = &err[start..];
        if let Some(end) = rest.find(')') {
            let mut head = rest[..=end].to_string();
            if !head.ends_with('.') {
                head.push('.');
            }
            return head;
        }
    }
    if err.starts_with("Could not reach Microsoft Graph") {
        return "Could not reach Microsoft Graph.".into();
    }
    if err.starts_with("Graph sent an unreadable") {
        return "Graph sent an unreadable response.".into();
    }
    "Could not catch up on mail.".into()
}

pub fn pull_mail_delta(token: &str, start: &str) -> Result<MailDelta, String> {
    if !trusted_delta_link(start) {
        return Err("The mail sync link was not accepted.".into());
    }
    let client = http_client()?;
    let cap = MAIL_PAGE * MAIL_SYNC_PAGES;
    let mut url = start.to_string();
    let mut removed = Vec::new();
    let mut changed = Vec::new();
    let mut patched = Vec::new();
    let mut pages = 0usize;
    loop {
        if pages >= MAIL_SYNC_PAGES {
            return Ok(MailDelta { removed, changed, patched, link: url });
        }
        if pages > 0 && !trusted_delta_link(&url) {
            return Ok(MailDelta { removed, changed, patched, link: String::new() });
        }
        pages += 1;
        let page = graph_get(&client, token, &url).map_err(delta_error)?;
        let parsed = parse_delta_page(&page);
        removed.extend(parsed.removed);
        changed.extend(parsed.changed);
        patched.extend(parsed.patched);
        if !parsed.delta_link.is_empty() {
            return Ok(MailDelta { removed, changed, patched, link: parsed.delta_link });
        }
        if removed.len() + changed.len() + patched.len() >= cap {
            return Ok(MailDelta { removed, changed, patched, link: parsed.next_link });
        }
        if !parsed.next_link.is_empty() {
            url = parsed.next_link;
            continue;
        }
        return Ok(MailDelta { removed, changed, patched, link: String::new() });
    }
}

/// Pages of ANCHOR_PAGE_SIZE an anchor may walk: 6,000 messages.
const ANCHOR_PAGES: usize = 60;
const ANCHOR_PAGE_SIZE: usize = 100;

/// A delta link for a folder (2026-10-27). For mail, Graph doesn't honour
/// `$deltatoken=latest`: it lists the whole folder first, ten messages a page
/// unless asked. Busy folders (Inbox, Sent Items, Deleted Items) ran out of
/// pages and never got a link, so mail moved or deleted elsewhere stayed in
/// the cache. Start from the sync window, ask for big pages, and walk them;
/// what they list is already merged by the caller's catch-up.
pub fn anchor_mail_delta(token: &str, folder_id: &str, since: &str) -> Result<String, String> {
    let mut url = anchor_delta_url(folder_id, since)?;
    let client = http_client()?;
    let mut seen = 0usize;
    for page_no in 0..ANCHOR_PAGES {
        if page_no > 0 && !trusted_delta_link(&url) {
            return Err(format!("Graph sent an unexpected next link after {page_no} pages."));
        }
        let page = graph_get_paged(&client, token, &url, Some(ANCHOR_PAGE_SIZE)).map_err(delta_error)?;
        let parsed = parse_delta_page(&page);
        seen += parsed.changed.len() + parsed.removed.len() + parsed.patched.len();
        if !parsed.delta_link.is_empty() {
            return Ok(parsed.delta_link);
        }
        if parsed.next_link.is_empty() {
            return Err(format!("Graph ended without a delta link after {} pages, {seen} messages.", page_no + 1));
        }
        url = parsed.next_link;
    }
    Err(format!("Graph did not return a delta link within {ANCHOR_PAGES} pages, {seen} messages."))
}

fn people_from(value: &serde_json::Value, key: &str) -> Vec<LivePerson> {
    let Some(rows) = value.get(key).and_then(|item| item.as_array()) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let email = row["emailAddress"]["address"]
                .as_str()
                .unwrap_or("")
                .trim()
                .to_string();
            if email.is_empty() {
                return None;
            }
            let name = row["emailAddress"]["name"].as_str().unwrap_or("").trim().to_string();
            Some(LivePerson { name, email })
        })
        .collect()
}

pub fn attachments_url(message_id: &str) -> Result<String, String> {
    let id = message_id.trim();
    if id.is_empty() {
        return Err("Choose a message.".into());
    }
    Ok(format!(
        "https://graph.microsoft.com/v1.0/me/messages/{}/attachments?$select={ATTACHMENT_SELECT}",
        path_segment(id)
    ))
}

pub fn attachment_value_url(message_id: &str, file_id: &str) -> Result<String, String> {
    let message = message_id.trim();
    let file = file_id.trim();
    if message.is_empty() || file.is_empty() {
        return Err("Choose a file.".into());
    }
    Ok(format!(
        "https://graph.microsoft.com/v1.0/me/messages/{}/attachments/{}/$value",
        path_segment(message),
        path_segment(file)
    ))
}

fn files_from_value(value: &serde_json::Value) -> Vec<LiveFile> {
    let items = if let Some(list) = value.as_array() {
        list
    } else if let Some(list) = value.get("value").and_then(|item| item.as_array()) {
        list
    } else if let Some(list) = value.get("attachments").and_then(|item| item.as_array()) {
        list
    } else if let Some(list) = value
        .get("attachments")
        .and_then(|item| item.get("value"))
        .and_then(|item| item.as_array())
    {
        list
    } else {
        return Vec::new();
    };
    items.iter().filter_map(file_from_item).collect()
}

fn file_from_item(value: &serde_json::Value) -> Option<LiveFile> {
    if value.get("isInline").and_then(|item| item.as_bool()).unwrap_or(false) {
        return None;
    }
    let name = value.get("name").and_then(|item| item.as_str()).unwrap_or("").trim();
    if name.is_empty() {
        return None;
    }
    Some(LiveFile {
        id: value.get("id").and_then(|item| item.as_str()).unwrap_or("").to_string(),
        name: name.to_string(),
        content_type: value.get("contentType").and_then(|item| item.as_str()).unwrap_or("").to_string(),
        size: value.get("size").and_then(|item| item.as_i64()).unwrap_or(0),
    })
}

pub fn list_attachments(email: &str, message_id: &str) -> Result<Vec<LiveFile>, String> {
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let value = graph_get(&client, &token, &attachments_url(message_id)?)?;
    Ok(files_from_value(&value))
}

/// An attachment's bytes, for reading on this computer (pdftext.rs).
pub(crate) fn attachment_bytes(client: &reqwest::blocking::Client, token: &str, url: &str) -> Result<Vec<u8>, String> {
    graph_bytes(client, token, url, "That file is too large.")
}

fn graph_bytes(
    client: &reqwest::blocking::Client,
    token: &str,
    url: &str,
    too_large: &str,
) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .bearer_auth(token)
        .send_graph(token)
        .map_err(|err| format!("Could not reach Microsoft Graph: {err}"))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().unwrap_or_default();
        return Err(format!("Graph refused the request ({status}). {}", clip(&text)));
    }
    if response.content_length().unwrap_or(0) > MAX_ATTACHMENT_BYTES as u64 {
        return Err(too_large.to_string());
    }
    let mut body = response.take(MAX_ATTACHMENT_BYTES as u64 + 1);
    let mut bytes = Vec::new();
    body.read_to_end(&mut bytes)
        .map_err(|_| "Could not read that file.".to_string())?;
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(too_large.to_string());
    }
    Ok(bytes)
}

pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mut out = String::new();
    for ch in base.chars() {
        if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
            out.push(ch);
        }
    }
    let trimmed: String = out.trim_matches('.').chars().take(80).collect();
    let trimmed = trimmed.trim_matches('.').to_string();
    if trimmed.is_empty() { "attachment".into() } else { trimmed }
}

/// http, https, and mailto only. No whitespace, controls, or credentials.
pub fn allowed_link(url: &str) -> bool {
    if url.is_empty() || url.len() > 2000 {
        return false;
    }
    if url.chars().any(|ch| ch.is_whitespace() || ch.is_control() || matches!(ch, '<' | '>' | '"' | '\'' | '\\' | '`')) {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")) {
        if rest.is_empty() || rest.starts_with('/') || rest.starts_with('.') {
            return false;
        }
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        if host.is_empty() || host.contains('@') {
            return false;
        }
        return true;
    }
    if let Some(rest) = lower.strip_prefix("mailto:") {
        let (addr, query) = rest.split_once('?').unwrap_or((rest, ""));
        // Only these fields: some mail programs take attach= to add a local
        // file to the message.
        let fields_ok = query.is_empty()
            || query.split('&').all(|pair| {
                let key = pair.split('=').next().unwrap_or("");
                matches!(key, "subject" | "body" | "cc" | "bcc" | "to")
            });
        return fields_ok && !addr.is_empty() && addr.contains('@') && !addr.starts_with('@') && !addr.ends_with('@');
    }
    false
}

pub fn open_link(url: &str) -> Result<(), String> {
    let url = url.trim();
    if !allowed_link(url) {
        return Err("That link cannot be opened.".into());
    }
    let mut child = std::process::Command::new("xdg-open")
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "That link could not be opened.".to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// File types that run code or launch something when opened. These can still
/// be downloaded, but Open will not hand them to the desktop.
const LAUNCHABLE: &[&str] = &[
    "desktop", "sh", "bash", "zsh", "fish", "csh", "ksh", "run", "bin", "appimage", "flatpakref",
    "flatpakrepo", "snap", "deb", "rpm", "jar", "jnlp", "py", "pyc", "pyw", "pl", "rb", "php", "js",
    "mjs", "cjs", "exe", "msi", "com", "bat", "cmd", "ps1", "vbs", "vbe", "wsf", "scr", "lnk", "reg",
    "html", "htm", "xhtml", "shtml", "svg", "hta", "url", "webloc", "service", "timer", "command",
    "elf", "so", "ko", "xht", "xhtm", "mht", "mhtml", "svgz", "xml", "xsl", "xslt", "shtm",
];

pub fn launchable(name: &str) -> bool {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim().trim_end_matches('.');
    match base.rsplit_once('.') {
        Some((_, ext)) => LAUNCHABLE.contains(&ext.to_ascii_lowercase().as_str()),
        None => false,
    }
}

/// The desktop can recognise a launcher or program by its first bytes even
/// when the name gives no hint, so look at those too.
pub fn launchable_bytes(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(512)];
    let text = String::from_utf8_lossy(head).to_ascii_lowercase();
    let trimmed = text.trim_start_matches('\u{feff}').trim_start();
    // A browser sniffs HTML from tags anywhere near the start, after a
    // comment or a few lines of text, not only from a leading doctype.
    const MARKUP: &[&str] = &[
        "<!doctype html", "<html", "<head", "<body", "<script", "<iframe", "<title", "<style", "<svg", "<!--", "<?xml",
        "<frameset", "<object", "<embed", "<meta", "<a ", "<img", "<div", "<table", "<p>", "<br",
    ];
    head.starts_with(b"\x7fELF")
        || head.starts_with(b"MZ")
        || trimmed.starts_with("#!")
        || trimmed.contains("[desktop entry]")
        || MARKUP.iter().any(|mark| text.contains(mark))
}

/// A file with no extension is opened only when its first bytes show a
/// plain document type; otherwise the desktop guesses, and may guess HTML.
fn plain_document_bytes(bytes: &[u8]) -> bool {
    const MAGIC: &[&[u8]] = &[b"%PDF-", b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a", b"PK\x03\x04", b"\xd0\xcf\x11\xe0"];
    MAGIC.iter().any(|magic| bytes.starts_with(magic))
        || (bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
}

fn has_extension(name: &str) -> bool {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim().trim_end_matches('.');
    base.rsplit_once('.').is_some_and(|(stem, ext)| !stem.is_empty() && !ext.is_empty())
}

/// A folder only this user can read, for files opened from mail.
fn private_open_dir() -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .filter(|dir| dir.is_absolute() && dir.is_dir())
        .unwrap_or_else(|| {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            std::path::PathBuf::from(home).join(".cache")
        });
    let dir = base.join("mailroom-files");
    std::fs::create_dir_all(&dir).map_err(|_| "That file could not be saved.".to_string())?;
    let meta = std::fs::symlink_metadata(&dir).map_err(|_| "That file could not be saved.".to_string())?;
    if !meta.is_dir() {
        return Err("That file could not be saved.".into());
    }
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| "That file could not be saved.".to_string())?;
    Ok(dir)
}

pub fn open_attachment(email: &str, message_id: &str, file_id: &str, name: &str) -> Result<(), String> {
    if launchable(name) {
        return Err("Mailroom does not open this type of file. Download it, then open it yourself if you trust it.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let bytes = graph_bytes(
        &client,
        &token,
        &attachment_value_url(message_id, file_id)?,
        "That file is too large to open from here.",
    )?;
    open_downloaded(name, &bytes)
}

/// Open a fetched attachment with the desktop's app for it, from a private
/// folder. Programs and scripts are refused, by name and by content.
pub(crate) fn open_downloaded(name: &str, bytes: &[u8]) -> Result<(), String> {
    let saved_name = safe_file_name(name);
    let unnamed = !has_extension(&saved_name) && !plain_document_bytes(bytes);
    if launchable(name) || launchable(&saved_name) || launchable_bytes(bytes) || unnamed {
        return Err("Mailroom does not open this type of file. Download it, then open it yourself if you trust it.".into());
    }
    let dir = private_open_dir()?;
    let path = write_download(&dir, &saved_name, bytes)?;
    let mut child = std::process::Command::new("xdg-open")
        .arg(&path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "That file could not be opened.".to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

const MAX_DOWNLOAD_FILES: usize = 100;

pub fn download_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let mut out = String::new();
    for ch in base.chars() {
        if ch.is_control() || ch == '/' || ch == '\\' {
            continue;
        }
        out.push(ch);
    }
    let trimmed = out.trim().trim_matches('.').trim();
    let mut kept = String::new();
    for ch in trimmed.chars() {
        if kept.len() + ch.len_utf8() > 180 {
            break;
        }
        kept.push(ch);
    }
    let kept = kept.trim().trim_matches('.').trim();
    if kept.is_empty() || kept == "." || kept == ".." {
        "attachment".into()
    } else {
        kept.to_string()
    }
}

fn numbered_download_name(file_name: &str, index: usize) -> String {
    if index == 0 {
        return file_name.to_string();
    }
    let mark = index + 1;
    match file_name.rfind('.') {
        Some(dot) if dot > 0 && !file_name[dot + 1..].is_empty() => {
            format!("{} ({}){}", &file_name[..dot], mark, &file_name[dot..])
        }
        _ => format!("{file_name} ({mark})"),
    }
}

pub fn prepare_download(directory: &str, files: &[(String, String)]) -> Result<std::path::PathBuf, String> {
    if files.is_empty() {
        return Err("Select an attachment.".into());
    }
    if files.len() > MAX_DOWNLOAD_FILES {
        return Err("Too many attachments.".into());
    }
    if files.iter().any(|(id, _)| id.trim().is_empty()) {
        return Err("Choose a file.".into());
    }
    if directory.trim().is_empty() || directory.contains('\0') {
        return Err("Choose a folder.".into());
    }
    let root = std::path::Path::new(directory)
        .canonicalize()
        .map_err(|_| "Choose a folder.".to_string())?;
    if !root.is_dir() {
        return Err("Choose a folder.".into());
    }
    Ok(root)
}

pub fn write_download(dir: &std::path::Path, name: &str, bytes: &[u8]) -> Result<std::path::PathBuf, String> {
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err("That file is too large to download from here.".into());
    }
    let root = dir.canonicalize().map_err(|_| "Choose a folder.".to_string())?;
    if !root.is_dir() {
        return Err("Choose a folder.".into());
    }
    let file_name = download_file_name(name);
    for index in 0..MAX_DOWNLOAD_FILES {
        let candidate = numbered_download_name(&file_name, index);
        let path = root.join(&candidate);
        if path.parent() != Some(root.as_path()) {
            return Err("That file could not be saved.".into());
        }
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(bytes)
                    .map_err(|_| "That file could not be saved.".to_string())?;
                return Ok(path);
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err("That file could not be saved.".into()),
        }
    }
    Err("That file could not be saved.".into())
}

pub fn save_attachments(
    email: &str,
    message_id: &str,
    files: &[(String, String)],
    directory: &str,
) -> Result<usize, String> {
    let root = prepare_download(directory, files)?;
    if message_id.trim().is_empty() {
        return Err("Choose a message.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let mut saved = 0;
    for (id, name) in files {
        let bytes = graph_bytes(
            &client,
            &token,
            &attachment_value_url(message_id, id)?,
            "That file is too large to download from here.",
        )?;
        write_download(&root, name, &bytes)?;
        saved += 1;
    }
    Ok(saved)
}

const SEARCH_PAGE: &str = "25";

pub fn mail_search_url(folder_id: &str, query: &str, from: &str, to: &str, files: &str) -> Result<String, String> {
    let term = search_expression(query, from, to, files)?;
    let base = if folder_id.trim().is_empty() {
        "https://graph.microsoft.com/v1.0/me/messages".to_string()
    } else {
        format!(
            "https://graph.microsoft.com/v1.0/me/mailFolders/{}/messages",
            path_segment(folder_id.trim())
        )
    };
    Ok(format!(
        "{base}?$top={SEARCH_PAGE}&$select={MESSAGE_SELECT},parentFolderId&$search={term}"
    ))
}

fn search_expression(query: &str, from: &str, to: &str, files: &str) -> Result<String, String> {
    let text = query.trim();
    if text.is_empty() {
        return Err("Enter a search.".into());
    }
    if text.chars().count() > 200 {
        return Err("That search is too long.".into());
    }
    let mut words = String::new();
    for ch in text.chars() {
        if ch.is_control() {
            continue;
        }
        if ch == '\\' || ch == '"' {
            words.push('\\');
        }
        words.push(ch);
    }
    if words.trim().is_empty() {
        return Err("Enter a search.".into());
    }
    let mut kql = format!("\"{words}\"");
    if let Some(day) = iso_day(from) {
        kql.push_str(" AND received>=");
        kql.push_str(&day);
    }
    if let Some(day) = iso_day(to) {
        kql.push_str(" AND received<=");
        kql.push_str(&day);
    }
    match files.trim() {
        "yes" => kql.push_str(" AND hasAttachments:true"),
        "no" => kql.push_str(" AND hasAttachments:false"),
        _ => {}
    }
    Ok(path_segment(&kql))
}

fn iso_day(value: &str) -> Option<String> {
    let text = value.trim();
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if !bytes.iter().enumerate().all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit()) {
        return None;
    }
    Some(text.to_string())
}

pub fn trusted_search_link(url: &str) -> Result<String, String> {
    let url = url.trim();
    if url.is_empty()
        || url.len() > 2048
        || url.chars().any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err("That search could not be continued.".into());
    }
    let rest = url
        .strip_prefix("https://graph.microsoft.com/v1.0/me/")
        .ok_or("That search could not be continued.")?;
    if !rest.starts_with("messages?") && !rest.starts_with("mailFolders/") {
        return Err("That search could not be continued.".into());
    }
    let folded = rest.to_ascii_lowercase();
    if !folded.contains("search=") || folded.contains("contentbytes") {
        return Err("That search could not be continued.".into());
    }
    Ok(url.to_string())
}

fn graph_search_get(client: &reqwest::blocking::Client, token: &str, url: &str) -> Result<serde_json::Value, String> {
    let response = client
        .get(url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .header("ConsistencyLevel", "eventual")
        .send_graph(token)
        .map_err(|err| format!("Could not reach Microsoft Graph: {err}"))?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Graph refused the request ({status}). {}", clip(&text)));
    }
    serde_json::from_str(&text).map_err(|_| "Graph sent an unreadable response.".into())
}

fn parse_search_page(value: serde_json::Value) -> MailSearchPage {
    let hits = value["value"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let parent_folder_id = item
                .get("parentFolderId")
                .and_then(|entry| entry.as_str())
                .unwrap_or("")
                .to_string();
            Some(MailSearchHit {
                message: parse_message(item)?,
                parent_folder_id,
            })
        })
        .collect();
    let next_link = value
        .get("@odata.nextLink")
        .and_then(|entry| entry.as_str())
        .and_then(|link| trusted_search_link(link).ok())
        .unwrap_or_default();
    MailSearchPage {
        messages: hits,
        next_link,
    }
}

pub fn search_mail(
    email: &str,
    folder_id: &str,
    query: &str,
    from: &str,
    to: &str,
    files: &str,
    next_link: &str,
) -> Result<MailSearchPage, String> {
    let url = if next_link.trim().is_empty() {
        mail_search_url(folder_id, query, from, to, files)?
    } else {
        trusted_search_link(next_link)?
    };
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let page = graph_search_get(&client, &token, &url)?;
    Ok(parse_search_page(page))
}

/// Every message in a conversation, from any folder, so a thread can show
/// the replies that sit in Sent Items.
pub fn conversation_url(conversation_id: &str) -> Result<String, String> {
    let id = conversation_id.trim();
    if id.is_empty() || id.len() > 400 || id.chars().any(|ch| ch.is_control()) {
        return Err("Choose a conversation.".into());
    }
    let filter = format!("conversationId eq '{}'", id.replace('\'', "''"));
    Ok(format!(
        "https://graph.microsoft.com/v1.0/me/messages?$top=50&$select={MESSAGE_SELECT},parentFolderId&$filter={}",
        path_segment(&filter)
    ))
}

pub fn conversation_mail(email: &str, conversation_id: &str) -> Result<MailSearchPage, String> {
    let url = conversation_url(conversation_id)?;
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let mut page = parse_search_page(graph_get(&client, &token, &url)?);
    page.next_link = String::new();
    Ok(page)
}

pub(crate) fn text_to_html(text: &str) -> String {
    let escaped = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!("<p>{}</p>", escaped.replace('\n', "<br>"))
}

fn clip(text: &str) -> String {
    text.replace(['\n', '\r'], " ").chars().take(280).collect()
}

#[derive(Debug, PartialEq)]
pub struct MailRequest {
    pub method: String,
    pub url: String,
    pub body: serde_json::Value,
}

pub fn mail_action_request(kind: &str, message_id: &str) -> Result<MailRequest, String> {
    let id = message_id.trim();
    if id.is_empty() {
        return Err("Choose a message.".into());
    }
    let message = format!("https://graph.microsoft.com/v1.0/me/messages/{}", path_segment(id));
    let (method, url, body) = match kind {
        "read" => ("PATCH", message, serde_json::json!({ "isRead": true })),
        "unread" => ("PATCH", message, serde_json::json!({ "isRead": false })),
        "flag" => ("PATCH", message, serde_json::json!({ "flag": { "flagStatus": "flagged" } })),
        "unflag" => ("PATCH", message, serde_json::json!({ "flag": { "flagStatus": "notFlagged" } })),
        "archive" => ("POST", format!("{message}/move"), serde_json::json!({ "destinationId": "archive" })),
        "trash" => ("POST", format!("{message}/move"), serde_json::json!({ "destinationId": "deleteditems" })),
        "inbox" => ("POST", format!("{message}/move"), serde_json::json!({ "destinationId": "inbox" })),
        _ => return Err("That mail action is not available.".into()),
    };
    Ok(MailRequest {
        method: method.into(),
        url,
        body,
    })
}

/// Move a message to any folder, by the folder's server id.
pub fn move_request(message_id: &str, folder_id: &str) -> Result<MailRequest, String> {
    let id = message_id.trim();
    let folder = folder_id.trim();
    if id.is_empty() {
        return Err("Choose a message.".into());
    }
    if folder.is_empty() || folder.len() > 400 || folder.chars().any(|ch| ch.is_control()) {
        return Err("Choose a folder.".into());
    }
    Ok(MailRequest {
        method: "POST".into(),
        url: format!("https://graph.microsoft.com/v1.0/me/messages/{}/move", path_segment(id)),
        body: serde_json::json!({ "destinationId": folder }),
    })
}

#[derive(Default)]
pub struct OutgoingMail {
    pub subject: String,
    pub body_html: String,
    pub to: String,
    pub cc: String,
    pub bcc: String,
    /// "high" or "low"; anything else is normal.
    pub importance: String,
    pub read_receipt: bool,
    /// An alias to send as. Empty sends from the mailbox itself.
    pub from_address: String,
}

/// Importance and a read receipt, as Graph message fields.
pub fn add_flags(message: &mut serde_json::Value, mail: &OutgoingMail) {
    match mail.importance.trim().to_ascii_lowercase().as_str() {
        "high" => message["importance"] = serde_json::json!("high"),
        "low" => message["importance"] = serde_json::json!("low"),
        _ => message["importance"] = serde_json::json!("normal"),
    }
    message["isReadReceiptRequested"] = serde_json::json!(mail.read_receipt);
}

pub(crate) struct InlineImage {
    pub(crate) name: String,
    pub(crate) content_type: String,
    pub(crate) bytes_b64: String,
}

fn is_img_tag(html: &str, index: usize) -> bool {
    let bytes = html.as_bytes();
    if index + 4 > bytes.len() {
        return false;
    }
    let img = bytes[index + 1].eq_ignore_ascii_case(&b'i')
        && bytes[index + 2].eq_ignore_ascii_case(&b'm')
        && bytes[index + 3].eq_ignore_ascii_case(&b'g');
    if !img {
        return false;
    }
    matches!(bytes.get(index + 4).copied().unwrap_or(b'>'), b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r')
}

fn tag_end(html: &str, start: usize) -> Option<usize> {
    let bytes = html.as_bytes();
    let mut quote = 0u8;
    let mut index = start + 1;
    while index < bytes.len() {
        let byte = bytes[index];
        if quote != 0 {
            if byte == quote {
                quote = 0;
            }
        } else if byte == b'"' || byte == b'\'' {
            quote = byte;
        } else if byte == b'>' {
            return Some(index + 1);
        }
        index += 1;
    }
    None
}

fn src_value_range(tag: &str) -> Option<(usize, usize)> {
    let lower = tag.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut index = 0;
    while index + 4 < bytes.len() {
        let boundary = index == 0 || bytes[index - 1].is_ascii_whitespace() || bytes[index - 1] == b'<';
        if boundary && &bytes[index..index + 3] == b"src" {
            let mut cursor = index + 3;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if cursor < bytes.len() && bytes[cursor] == b'=' {
                cursor += 1;
                while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                    cursor += 1;
                }
                if cursor >= tag.len() {
                    return None;
                }
                let quote = tag.as_bytes()[cursor];
                if quote == b'"' || quote == b'\'' {
                    let start = cursor + 1;
                    let end = tag[start..].find(quote as char)? + start;
                    return Some((start, end));
                }
                let start = cursor;
                let rest = tag[start..].find(|ch: char| ch.is_ascii_whitespace() || ch == '>').unwrap_or(tag.len() - start);
                return Some((start, start + rest));
            }
        }
        index += 1;
    }
    None
}

fn data_image(value: &str) -> Result<Option<(String, &'static str, String)>, String> {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    if !lower.starts_with("data:image/") {
        return Ok(None);
    }
    let meta = &trimmed[5..];
    let lower_meta = &lower[5..];
    let Some(mime_end) = lower_meta.find([';', ',']) else {
        return Ok(None);
    };
    let mime = &lower_meta[..mime_end];
    let (content_type, ext) = match mime {
        "image/png" => ("image/png", "png"),
        "image/jpeg" | "image/jpg" => ("image/jpeg", "jpg"),
        "image/gif" => ("image/gif", "gif"),
        "image/webp" => ("image/webp", "webp"),
        "image/bmp" => ("image/bmp", "bmp"),
        _ => return Ok(None),
    };
    let Some(marker) = lower_meta.find(";base64,") else {
        return Ok(None);
    };
    let payload = &meta[marker + 8..];
    let cleaned: String = payload.chars().filter(|ch| !ch.is_whitespace()).collect();
    if cleaned.len() > 2_000_000 {
        return Err("That message is too large to send.".into());
    }
    if cleaned.is_empty() {
        return Ok(None);
    }
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&cleaned)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(&cleaned));
    let Ok(decoded) = decoded else {
        return Ok(None);
    };
    if decoded.is_empty() {
        return Ok(None);
    }
    if decoded.len() > 1_500_000 {
        return Err("That message is too large to send.".into());
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(decoded);
    Ok(Some((content_type.to_string(), ext, encoded)))
}

pub(crate) fn embed_inline_images(html: &str) -> Result<(String, Vec<InlineImage>), String> {
    let mut out = String::with_capacity(html.len());
    let mut images = Vec::new();
    let mut seen: HashMap<String, String> = HashMap::new();
    let mut total = 0usize;
    let mut index = 0;
    while index < html.len() {
        if html.as_bytes()[index] == b'<' && is_img_tag(html, index) {
            let Some(end) = tag_end(html, index) else {
                out.push_str(&html[index..]);
                break;
            };
            let tag = &html[index..end];
            if let Some((start, stop)) = src_value_range(tag) {
                if let Some((content_type, ext, b64)) = data_image(&tag[start..stop])? {
                    if total.saturating_add(b64.len()) > 3_000_000 {
                        return Err("That message is too large to send.".into());
                    }
                    let cid = if let Some(existing) = seen.get(&b64) {
                        existing.clone()
                    } else {
                        if images.len() >= 20 {
                            return Err("That message is too large to send.".into());
                        }
                        let name = format!("image{:03}.{}", images.len() + 1, ext);
                        total += b64.len();
                        seen.insert(b64.clone(), name.clone());
                        images.push(InlineImage {
                            name: name.clone(),
                            content_type,
                            bytes_b64: b64,
                        });
                        name
                    };
                    out.push_str(&tag[..start]);
                    out.push_str("cid:");
                    out.push_str(&cid);
                    out.push_str(&tag[stop..]);
                    index = end;
                    continue;
                }
            }
            out.push_str(tag);
            index = end;
        } else {
            let ch = html[index..].chars().next().unwrap_or('\u{FFFD}');
            out.push(ch);
            index += ch.len_utf8();
        }
    }
    Ok((out, images))
}

pub fn outgoing_request(mail: &OutgoingMail) -> Result<MailRequest, String> {
    let mut seen = std::collections::HashSet::new();
    let to = mail_addresses(&mail.to, &mut seen)?;
    let cc = mail_addresses(&mail.cc, &mut seen)?;
    let bcc = mail_addresses(&mail.bcc, &mut seen)?;
    if to.is_empty() && cc.is_empty() && bcc.is_empty() {
        return Err("Add a recipient.".into());
    }
    let subject = mail.subject.trim();
    if subject.chars().count() > 255 {
        return Err("The subject is too long.".into());
    }
    let (body_html, images) = embed_inline_images(&mail.body_html)?;
    if body_html.len() > 1_500_000 {
        return Err("That message is too large to send.".into());
    }
    let recipients = |list: Vec<String>| {
        list.into_iter()
            .map(|address| serde_json::json!({ "emailAddress": { "address": address } }))
            .collect::<Vec<_>>()
    };
    let mut message = serde_json::json!({
        "subject": subject,
        "body": { "contentType": "HTML", "content": body_html },
        "toRecipients": recipients(to),
        "ccRecipients": recipients(cc),
        "bccRecipients": recipients(bcc)
    });
    add_flags(&mut message, mail);
    if let Some(from) = sender_json(&mail.from_address)? {
        message["from"] = from;
    }
    if !images.is_empty() {
        message["attachments"] = serde_json::Value::Array(
            images
                .iter()
                .map(|image| {
                    serde_json::json!({
                        "@odata.type": "#microsoft.graph.fileAttachment",
                        "name": image.name,
                        "contentType": image.content_type,
                        "contentBytes": image.bytes_b64,
                        "contentId": image.name,
                        "isInline": true
                    })
                })
                .collect(),
        );
    }
    Ok(MailRequest {
        method: "POST".into(),
        url: "https://graph.microsoft.com/v1.0/me/sendMail".into(),
        body: serde_json::json!({
            "message": message,
            "saveToSentItems": true
        }),
    })
}

pub(crate) fn mail_addresses(raw: &str, seen: &mut std::collections::HashSet<String>) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for part in raw.split([',', ';']) {
        let text = part.trim();
        if text.is_empty() {
            continue;
        }
        let address = one_address(text)?;
        if seen.insert(address.to_lowercase()) {
            out.push(address);
        }
    }
    if out.len() > 200 {
        return Err("Too many recipients.".into());
    }
    Ok(out)
}

fn one_address(text: &str) -> Result<String, String> {
    let bad = "Check the To, Cc, and Bcc addresses.";
    if text.len() > 254 || text.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        return Err(bad.into());
    }
    let Some((local, domain)) = text.split_once('@') else {
        return Err(bad.into());
    };
    if text.matches('@').count() != 1
        || local.is_empty()
        || domain.len() < 3
        || !domain.contains('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
        || local.chars().any(|ch| matches!(ch, '<' | '>' | '"' | '\\' | '/' | '(' | ')'))
    {
        return Err(bad.into());
    }
    Ok(text.to_string())
}

/// `from.emailAddress` for a send-as alias. Empty means the mailbox itself.
pub fn sender_json(from: &str) -> Result<Option<serde_json::Value>, String> {
    let address = from.trim();
    if address.is_empty() {
        return Ok(None);
    }
    let address = one_address(address)?;
    Ok(Some(serde_json::json!({ "emailAddress": { "address": address } })))
}

const MAYBE_SENT: &str = "Microsoft did not answer, so the message may have been sent. Look in Sent Items before sending it again.";

pub fn send_mail(email: &str, mail: &OutgoingMail) -> Result<(), String> {
    if email.trim().is_empty() {
        return Err("That account is not signed in.".into());
    }
    let request = outgoing_request(mail)?;
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|_| "That mail action is not available.".to_string())?;
    let response = client
        .request(method, &request.url)
        .bearer_auth(&token)
        .header("Accept", "application/json")
        .json(&request.body)
        .send_graph(&token)
        .map_err(|err| {
            // Once connected, the send may have gone through before the answer was lost.
            if err.is_connect() { format!("Could not reach Microsoft Graph: {err}") } else { MAYBE_SENT.into() }
        })?;
    let status = response.status();
    if status.is_success() {
        return Ok(());
    }
    let reason = crate::compose::graph_reason(&response.text().unwrap_or_default());
    Err(match status.as_u16() {
        401 | 403 => "Sign in again to send mail.".into(),
        400 | 413 if !reason.is_empty() => format!("Microsoft refused that message: {reason}"),
        400 | 413 => "Microsoft refused that message.".into(),
        429 | 503 => "Microsoft is busy. The message is still in Outbox.".into(),
        500..=599 => MAYBE_SENT.into(),
        _ => "The message could not be sent. It is still in Outbox.".into(),
    })
}

/// A moved message gets a new id on the server.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct MovedId {
    pub from: String,
    pub to: String,
}

fn moved_id(from: &str, reply: &serde_json::Value) -> Option<MovedId> {
    let to = reply.get("id").and_then(|value| value.as_str())?.trim();
    if to.is_empty() || to == from {
        return None;
    }
    Some(MovedId { from: from.to_string(), to: to.to_string() })
}

pub fn apply_mail(email: &str, kind: &str, message_ids: &[String], destination: &str) -> Result<Vec<MovedId>, String> {
    if message_ids.is_empty() {
        return Err("Choose a message.".into());
    }
    if message_ids.len() > 40 {
        return Err("Choose fewer messages.".into());
    }
    let requests = message_ids
        .iter()
        .map(|id| if kind == "move" { move_request(id, destination) } else { mail_action_request(kind, id) })
        .collect::<Result<Vec<_>, _>>()?;
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let mut moved = Vec::new();
    for (id, request) in message_ids.iter().zip(&requests) {
        let reply = graph_send(&client, &token, request)?;
        if request.url.ends_with("/move") {
            moved.extend(moved_id(id.trim(), &reply));
        }
    }
    Ok(moved)
}

const EVENT_SELECT: &str = "id,subject,start,end,isAllDay,showAs,location,body,bodyPreview,organizer,attendees,isCancelled,responseStatus,isOrganizer,type,seriesMasterId,isReminderOn,reminderMinutesBeforeStart,onlineMeeting";
const CONTACT_SELECT: &str = "id,displayName,emailAddresses,businessPhones,mobilePhone,homePhones,jobTitle,companyName";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveCalendar {
    pub id: String,
    pub name: String,
    pub color: String,
    pub is_default: bool,
    /// The calendar can make Teams meetings (work and school accounts).
    pub teams: bool,
    /// You can add and change events on it. A calendar shared with you may
    /// be read-only.
    pub can_edit: bool,
    /// Whose calendar it is, when someone shared it with you.
    pub owner: String,
    /// The owner's display name, when Graph sent one.
    pub owner_name: String,
    /// The owner's address is someone else. Graph has no isSharedWithMe on a calendar.
    pub is_shared: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAttendee {
    pub name: String,
    pub email: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveEvent {
    pub id: String,
    pub calendar_id: String,
    pub title: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub show_as: String,
    pub location: String,
    pub notes: String,
    pub organizer_name: String,
    pub organizer_email: String,
    pub attendees: Vec<LiveAttendee>,
    /// accepted, tentative, declined, or empty when not answered yet.
    pub response: String,
    pub is_organizer: bool,
    /// singleInstance, occurrence, exception or seriesMaster.
    pub kind: String,
    pub series_master_id: String,
    /// Minutes before the start, or -1 for no reminder.
    pub reminder: i64,
    /// The Teams (or other) link to join, when there is one.
    pub join_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveContact {
    pub id: String,
    pub name: String,
    pub email: String,
    pub phone: String,
    pub title: String,
    pub company: String,
}

pub fn calendar_view_url(calendar_id: &str, start: &str, end: &str) -> Result<String, String> {
    let id = calendar_id.trim();
    if id.is_empty() {
        return Err("Choose a calendar.".into());
    }
    if start.trim().len() < 10 || end.trim().len() < 10 {
        return Err("Choose a date.".into());
    }
    Ok(format!(
        "https://graph.microsoft.com/v1.0/me/calendars/{}/calendarView?startDateTime={}&endDateTime={}&$top=50&$select={EVENT_SELECT}",
        path_segment(id),
        path_segment(start.trim()),
        path_segment(end.trim())
    ))
}

pub fn contact_body(name: &str, address: &str, phone: &str, title: &str, company: &str) -> Result<serde_json::Value, String> {
    let name = name.trim();
    let address = address.trim();
    if name.is_empty() {
        return Err("Enter a name.".into());
    }
    if !address.contains('@') || address.contains(' ') || address.starts_with('@') || address.ends_with('@') {
        return Err("Enter an email address.".into());
    }
    let mut body = serde_json::json!({
        "displayName": name,
        "emailAddresses": [{ "address": address, "name": name }]
    });
    if !phone.trim().is_empty() {
        body["businessPhones"] = serde_json::json!([phone.trim()]);
    }
    if !title.trim().is_empty() {
        body["jobTitle"] = serde_json::json!(title.trim());
    }
    if !company.trim().is_empty() {
        body["companyName"] = serde_json::json!(company.trim());
    }
    Ok(body)
}

pub fn fetch_calendar(email: &str, start: &str, end: &str) -> Result<(Vec<LiveCalendar>, Vec<LiveEvent>), String> {
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let listed = graph_pages(
        &client,
        &token,
        "https://graph.microsoft.com/v1.0/me/calendars?$top=50&$select=id,name,color,isDefaultCalendar,allowedOnlineMeetingProviders,canEdit,owner",
        CALENDAR_LIST_PAGES,
    )?;
    let mut calendars = listed.iter().filter_map(|item| calendar_from_value(item, email)).collect::<Vec<_>>();
    calendars.sort_by(|left, right| right.is_default.cmp(&left.is_default).then(left.name.cmp(&right.name)));
    let mut events = Vec::new();
    for calendar in calendars.iter().take(24) {
        let url = calendar_view_url(&calendar.id, start, end)?;
        for item in graph_pages(&client, &token, &url, CALENDAR_EVENT_PAGES)? {
            if let Some(event) = event_from_value(&item, &calendar.id) {
                events.push(event);
            }
        }
    }
    Ok((calendars, events))
}

pub fn fetch_contacts(email: &str) -> Result<Vec<LiveContact>, String> {
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let url = format!("https://graph.microsoft.com/v1.0/me/contacts?$top=100&$select={CONTACT_SELECT}");
    let listed = graph_pages(&client, &token, &url, 10)?;
    let mut people = listed.iter().filter_map(contact_from_value).collect::<Vec<_>>();
    people.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(people)
}

pub fn create_contact(
    email: &str,
    name: &str,
    address: &str,
    phone: &str,
    title: &str,
    company: &str,
) -> Result<LiveContact, String> {
    let body = contact_body(name, address, phone, title, company)?;
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let saved = graph_post(&client, &token, "https://graph.microsoft.com/v1.0/me/contacts", &body)?;
    contact_from_value(&saved).ok_or_else(|| "Microsoft did not return the contact.".into())
}

pub fn update_contact(
    email: &str,
    contact_id: &str,
    name: &str,
    address: &str,
    phone: &str,
    title: &str,
    company: &str,
) -> Result<LiveContact, String> {
    let id = contact_id.trim();
    if id.is_empty() {
        return Err("That contact is not on the server.".into());
    }
    let body = contact_body(name, address, phone, title, company)?;
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let url = format!("https://graph.microsoft.com/v1.0/me/contacts/{}", path_segment(id));
    let saved = crate::calendar::call(&client, &token, "PATCH", &url, Some(&body))
        .map_err(|(status, reason)| contact_refusal(status, &reason))?;
    contact_from_value(&saved).ok_or_else(|| "Microsoft did not return the contact.".into())
}

pub fn delete_contact(email: &str, contact_id: &str) -> Result<(), String> {
    let id = contact_id.trim();
    if id.is_empty() {
        return Err("That contact is not on the server.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let url = format!("https://graph.microsoft.com/v1.0/me/contacts/{}", path_segment(id));
    match crate::calendar::call(&client, &token, "DELETE", &url, None) {
        Ok(_) | Err((404, _)) => Ok(()),
        Err((status, reason)) => Err(contact_refusal(status, &reason)),
    }
}

fn contact_refusal(status: u16, reason: &str) -> String {
    match status {
        401 | 403 => "Sign in again to change contacts.".into(),
        404 => "That contact is no longer there.".into(),
        _ if !reason.is_empty() => format!("Microsoft did not save the contact: {reason}"),
        _ => "Microsoft did not save the contact.".into(),
    }
}

fn calendar_owner(value: &serde_json::Value) -> (String, String) {
    let owner = &value["owner"];
    let address = owner["address"]
        .as_str()
        .or_else(|| owner["emailAddress"]["address"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let name = owner["name"]
        .as_str()
        .or_else(|| owner["emailAddress"]["name"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    (address, name)
}

fn calendar_from_value(value: &serde_json::Value, mailbox: &str) -> Option<LiveCalendar> {
    let id = value.get("id")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let name = value.get("name").and_then(|item| item.as_str()).unwrap_or("").trim();
    let (owner, owner_name) = calendar_owner(value);
    let mine = mailbox.trim();
    let is_shared = owner.contains('@') && !owner.eq_ignore_ascii_case(mine);
    Some(LiveCalendar {
        id: id.to_string(),
        name: if name.is_empty() { "Calendar".into() } else { name.to_string() },
        color: value.get("color").and_then(|item| item.as_str()).unwrap_or("").to_string(),
        is_default: value.get("isDefaultCalendar").and_then(|item| item.as_bool()).unwrap_or(false),
        teams: value["allowedOnlineMeetingProviders"]
            .as_array()
            .is_some_and(|list| list.iter().any(|p| p.as_str() == Some("teamsForBusiness"))),
        can_edit: value.get("canEdit").and_then(|item| item.as_bool()).unwrap_or(true),
        owner,
        owner_name,
        is_shared,
    })
}

fn event_from_value(value: &serde_json::Value, calendar_id: &str) -> Option<LiveEvent> {
    if value.get("isCancelled").and_then(|item| item.as_bool()).unwrap_or(false) {
        return None;
    }
    let id = value.get("id")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let all_day = value.get("isAllDay").and_then(|item| item.as_bool()).unwrap_or(false);
    let (start, end) = if all_day {
        (event_date(value.get("start")?)?, event_date(value.get("end")?)?)
    } else {
        (event_instant(value.get("start")?)?, event_instant(value.get("end")?)?)
    };
    let title = value.get("subject").and_then(|item| item.as_str()).unwrap_or("").trim();
    let show_as = show_as_of(value.get("showAs").and_then(|item| item.as_str()).unwrap_or(""));
    let notes = event_notes(value);
    let organizer_name = value["organizer"]["emailAddress"]["name"].as_str().unwrap_or("").trim().to_string();
    let organizer_email = value["organizer"]["emailAddress"]["address"].as_str().unwrap_or("").trim().to_string();
    let attendees = value
        .get("attendees")
        .and_then(|item| item.as_array())
        .map(|list| list.iter().filter_map(attendee_from_value).collect())
        .unwrap_or_default();
    Some(LiveEvent {
        id: id.to_string(),
        calendar_id: calendar_id.to_string(),
        title: if title.is_empty() { "(No title)".into() } else { title.to_string() },
        start,
        end,
        all_day,
        show_as,
        location: value["location"]["displayName"].as_str().unwrap_or("").trim().to_string(),
        notes,
        organizer_name,
        organizer_email,
        attendees,
        response: crate::compose::response_word(value["responseStatus"]["response"].as_str().unwrap_or("")),
        is_organizer: value["isOrganizer"].as_bool().unwrap_or(false),
        kind: value["type"].as_str().unwrap_or("singleInstance").to_string(),
        series_master_id: value["seriesMasterId"].as_str().unwrap_or("").to_string(),
        reminder: if value["isReminderOn"].as_bool().unwrap_or(false) {
            value["reminderMinutesBeforeStart"].as_i64().unwrap_or(15).clamp(0, 40320)
        } else {
            -1
        },
        join_url: value["onlineMeeting"]["joinUrl"]
            .as_str()
            .filter(|url| url.starts_with("https://"))
            .unwrap_or("")
            .to_string(),
    })
}

fn attendee_from_value(value: &serde_json::Value) -> Option<LiveAttendee> {
    let email = value["emailAddress"]["address"].as_str().unwrap_or("").trim();
    if email.is_empty() {
        return None;
    }
    let name = value["emailAddress"]["name"].as_str().unwrap_or("").trim();
    Some(LiveAttendee {
        name: if name.is_empty() { email.to_string() } else { name.to_string() },
        email: email.to_string(),
        status: attendee_status(value["status"]["response"].as_str().unwrap_or("")),
    })
}

fn contact_from_value(value: &serde_json::Value) -> Option<LiveContact> {
    let id = value.get("id")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let email = value
        .get("emailAddresses")
        .and_then(|item| item.as_array())
        .and_then(|list| {
            list.iter().find_map(|item| {
                item.get("address").and_then(|part| part.as_str()).map(str::trim).filter(|part| !part.is_empty())
            })
        })
        .unwrap_or("")
        .to_string();
    let mut name = value.get("displayName").and_then(|item| item.as_str()).unwrap_or("").trim().to_string();
    if name.is_empty() {
        name = email.clone();
    }
    if name.is_empty() {
        return None;
    }
    let phone = first_phone(value, "businessPhones")
        .or_else(|| text_field(value, "mobilePhone"))
        .or_else(|| first_phone(value, "homePhones"))
        .unwrap_or_default();
    Some(LiveContact {
        id: id.to_string(),
        name,
        email,
        phone,
        title: value.get("jobTitle").and_then(|item| item.as_str()).unwrap_or("").trim().to_string(),
        company: value.get("companyName").and_then(|item| item.as_str()).unwrap_or("").trim().to_string(),
    })
}

fn first_phone(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key).and_then(|item| item.as_array()).and_then(|list| {
        list.iter().find_map(|item| item.as_str().map(str::trim).filter(|part| !part.is_empty()).map(str::to_string))
    })
}

fn text_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key).and_then(|item| item.as_str()).map(str::trim).filter(|part| !part.is_empty()).map(str::to_string)
}

fn event_date(value: &serde_json::Value) -> Option<String> {
    let date_time = value.get("dateTime")?.as_str()?.trim();
    let date = date_time.get(0..10)?;
    if date.len() == 10 && date.as_bytes().get(4) == Some(&b'-') && date.as_bytes().get(7) == Some(&b'-') {
        Some(date.to_string())
    } else {
        None
    }
}

fn stamp_has_offset(stamp: &str) -> bool {
    if stamp.ends_with('Z') || stamp.ends_with('z') {
        return true;
    }
    let Some(tee) = stamp.find('T') else {
        return false;
    };
    let clock = &stamp[tee + 1..];
    clock.contains('+') || clock.contains('-')
}

fn event_instant(value: &serde_json::Value) -> Option<String> {
    let date_time = value.get("dateTime")?.as_str()?.trim();
    if date_time.is_empty() {
        return None;
    }
    if stamp_has_offset(date_time) {
        return Some(date_time.to_string());
    }
    let zone = value.get("timeZone").and_then(|item| item.as_str()).unwrap_or("");
    if zone.is_empty() || zone.eq_ignore_ascii_case("UTC") || zone.eq_ignore_ascii_case("tzone://Microsoft/Utc") {
        return Some(format!("{date_time}Z"));
    }
    match windows_to_utc(zone, date_time) {
        Some(utc) => Some(utc),
        None => Some(date_time.to_string()),
    }
}

/// Minutes east of UTC for a Windows zone at this civil time. `None` when
/// the name is not one this client converts.
fn windows_offset_minutes(zone: &str, year: i32, month: u32, day: u32, hour: u32, minute: u32) -> Option<i32> {
    let seasonal = |standard: i32, daylight: i32| {
        if north_american_dst(year, month, day, hour, minute) { daylight } else { standard }
    };
    let settled = |year_at: i32, month_at: u32, day_at: u32, hour_at: u32, fixed: i32, standard: i32, daylight: i32| {
        let on = (year, month, day, hour, minute) >= (year_at, month_at, day_at, hour_at, 0);
        if on { fixed } else { seasonal(standard, daylight) }
    };
    match zone.trim().to_ascii_lowercase().as_str() {
        // BC, Alberta and Manitoba stopped the autumn change on 1 November 2026
        // (tzdata 2026b). The new Windows names stay on the daylight offset.
        "pacific time (british columbia)" => Some(settled(2026, 11, 1, 2, -7 * 60, -8 * 60, -7 * 60)),
        "mountain time (alberta)" => Some(settled(2026, 11, 1, 2, -6 * 60, -7 * 60, -6 * 60)),
        "manitoba" => Some(settled(2026, 11, 1, 2, -5 * 60, -6 * 60, -5 * 60)),
        "pacific standard time" => Some(seasonal(-8 * 60, -7 * 60)),
        "mountain standard time" => Some(seasonal(-7 * 60, -6 * 60)),
        "us mountain standard time" => Some(-7 * 60),
        "central standard time" => Some(seasonal(-6 * 60, -5 * 60)),
        "canada central standard time" => Some(-6 * 60),
        "eastern standard time" => Some(seasonal(-5 * 60, -4 * 60)),
        "atlantic standard time" => Some(seasonal(-4 * 60, -3 * 60)),
        "yukon standard time" => Some(-7 * 60),
        "hawaiian standard time" => Some(-10 * 60),
        _ => None,
    }
}

/// Second Sunday in March at 02:00, through the first Sunday in November at 02:00.
fn north_american_dst(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> bool {
    let start = nth_weekday(year, 3, 0, 2);
    let end = nth_weekday(year, 11, 0, 1);
    let at = (month, day, hour, minute);
    at >= (3, start, 2, 0) && at < (11, end, 2, 0)
}

/// `n`th `weekday` of a month. Weekday 0 is Sunday.
fn nth_weekday(year: i32, month: u32, weekday: u32, n: u32) -> u32 {
    let first = civil_weekday(year, month, 1);
    let delta = (weekday + 7 - first) % 7;
    1 + delta + (n - 1) * 7
}

fn civil_weekday(year: i32, month: u32, day: u32) -> u32 {
    let days = civil_days(year, month, day);
    ((days + 4).rem_euclid(7)) as u32
}

fn civil_days(year: i32, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year } as i64;
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * mp as u64 + 2) / 5 + day as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe as i64 - 719468
}

fn days_to_civil(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

fn civil_parts(stamp: &str) -> Option<(i32, u32, u32, u32, u32, u32)> {
    let stamp = stamp.trim();
    let bytes = stamp.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let piece = |at: usize, len: usize| stamp.get(at..at + len)?.parse::<u32>().ok();
    if bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') || bytes.get(10) != Some(&b'T') {
        return None;
    }
    if bytes.get(13) != Some(&b':') || bytes.get(16) != Some(&b':') {
        return None;
    }
    let year: i32 = stamp.get(0..4)?.parse().ok()?;
    let month = piece(5, 2)?;
    let day = piece(8, 2)?;
    let hour = piece(11, 2)?;
    let minute = piece(14, 2)?;
    let second = piece(17, 2)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    Some((year, month, day, hour, minute, second))
}

/// A Windows-zone wall clock as a UTC stamp. Unknown names stay unconverted.
fn windows_to_utc(zone: &str, stamp: &str) -> Option<String> {
    let (year, month, day, hour, minute, second) = civil_parts(stamp)?;
    let offset = windows_offset_minutes(zone, year, month, day, hour, minute)?;
    let mut mins = hour as i32 * 60 + minute as i32 - offset;
    let mut days = civil_days(year, month, day);
    while mins < 0 {
        mins += 24 * 60;
        days -= 1;
    }
    while mins >= 24 * 60 {
        mins -= 24 * 60;
        days += 1;
    }
    let (y, m, d) = days_to_civil(days);
    Some(format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{second:02}Z", mins / 60, mins % 60))
}

fn show_as_of(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "free" => "free",
        "tentative" => "tentative",
        "oof" => "oof",
        _ => "busy",
    }
    .into()
}

fn attendee_status(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "accepted" => "accepted",
        "tentativelyaccepted" => "tentative",
        "declined" => "declined",
        _ => "none",
    }
    .into()
}

fn clip_len(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn event_notes(value: &serde_json::Value) -> String {
    let body = value.get("body");
    let content = body
        .and_then(|item| item.get("content"))
        .and_then(|item| item.as_str())
        .unwrap_or("");
    let kind = body
        .and_then(|item| item.get("contentType"))
        .and_then(|item| item.as_str())
        .unwrap_or("");
    let text = if content.trim().is_empty() {
        String::new()
    } else if kind.eq_ignore_ascii_case("html") {
        html_to_text(content)
    } else {
        content.to_string()
    };
    let text = tidy_plain(&text);
    if text.is_empty() {
        return clip_len(
            value
                .get("bodyPreview")
                .and_then(|item| item.as_str())
                .unwrap_or("")
                .trim(),
            4000,
        );
    }
    clip_len(&text, 4000)
}

struct OpenAnchor {
    href_raw: String,
    start: usize,
}

fn anchor_href(tag: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find("href") {
        let abs = from + rel;
        let boundary = abs == 0 || lower.as_bytes()[abs - 1].is_ascii_whitespace();
        from = abs + 4;
        if !boundary {
            continue;
        }
        let after = tag[from..].trim_start();
        let Some(after) = after.strip_prefix('=') else {
            continue;
        };
        let after = after.trim_start();
        let mut chars = after.chars();
        let quote = chars.next()?;
        if quote != '"' && quote != '\'' {
            return None;
        }
        let rest = chars.as_str();
        let end = rest.find(quote)?;
        return Some(rest[..end].to_string());
    }
    None
}

fn finish_anchor(out: &mut String, anchor: OpenAnchor) {
    let href = decode_basic_entities(&anchor.href_raw);
    if !allowed_link(&href) {
        return;
    }
    let visible = decode_basic_entities(&out[anchor.start..]);
    if visible.contains(&href) {
        return;
    }
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&anchor.href_raw);
}

pub(crate) fn html_to_text(html: &str) -> String {
    let mut out = String::new();
    let mut anchor: Option<OpenAnchor> = None;
    let mut no_more_tags = false;
    let mut i = 0;
    while i < html.len() {
        let rest = &html[i..];
        if rest.as_bytes()[0] == b'<' && !no_more_tags {
            let starts = |prefix: &str| rest.get(..prefix.len()).is_some_and(|p| p.eq_ignore_ascii_case(prefix));
            if starts("<script") || starts("<style") {
                let end = if starts("<script") { "</script>" } else { "</style>" };
                i += find_ascii_ci(rest, end).map(|pos| pos + end.len()).unwrap_or(rest.len());
                continue;
            }
            // With no '>' left, no later '<' starts a tag either; looking
            // again at every '<' would take time in the square of the size.
            let found = rest.find('>');
            no_more_tags = found.is_none();
            if let Some(end) = found {
                let tag = rest[1..end].trim();
                let closing = tag.starts_with('/');
                let name = tag
                    .trim_start_matches('/')
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .trim_end_matches('/')
                    .to_ascii_lowercase();
                if name == "a" && !closing {
                    if let Some(prev) = anchor.take() {
                        finish_anchor(&mut out, prev);
                    }
                    if let Some(href) = anchor_href(tag) {
                        let opened = OpenAnchor { href_raw: href, start: out.len() };
                        if tag.trim_end().ends_with('/') {
                            finish_anchor(&mut out, opened);
                        } else {
                            anchor = Some(opened);
                        }
                    }
                } else if closing && name == "a" {
                    if let Some(prev) = anchor.take() {
                        finish_anchor(&mut out, prev);
                    }
                } else if name == "br" || (closing && matches!(name.as_str(), "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote")) {
                    out.push('\n');
                }
                i += end + 1;
                continue;
            }
        }
        let ch = rest.chars().next().unwrap_or('\u{FFFD}');
        out.push(ch);
        i += ch.len_utf8();
    }
    if let Some(prev) = anchor.take() {
        finish_anchor(&mut out, prev);
    }
    decode_basic_entities(&out)
}

/// Where `needle` (ASCII) first occurs in `hay`, ignoring ASCII case.
fn find_ascii_ci(hay: &str, needle: &str) -> Option<usize> {
    let needle = needle.as_bytes();
    hay.as_bytes().windows(needle.len()).position(|w| w.eq_ignore_ascii_case(needle))
}

fn decode_basic_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        // No entity is longer than "#x10FFFF"; looking further for ';' at
        // every '&' would take time in the square of the size.
        let Some(end) = after.bytes().take(12).position(|b| b == b';') else {
            out.push('&');
            rest = after;
            continue;
        };
        let entity = &after[..end];
        if let Some(ch) = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => None,
        } {
            out.push(ch);
        } else if let Some(num) = entity.strip_prefix("#x").or_else(|| entity.strip_prefix("#X")) {
            if let Some(ch) = u32::from_str_radix(num, 16).ok().and_then(char::from_u32) {
                out.push(ch);
            }
        } else if let Some(num) = entity.strip_prefix('#') {
            if let Some(ch) = num.parse::<u32>().ok().and_then(char::from_u32) {
                out.push(ch);
            }
        } else {
            out.push('&');
            rest = after;
            continue;
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

fn tidy_plain(text: &str) -> String {
    let mut lines = Vec::new();
    for line in text.split('\n') {
        let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if collapsed.is_empty() {
            if lines.last().is_some_and(|item: &String| !item.is_empty()) {
                lines.push(String::new());
            }
        } else {
            lines.push(collapsed);
        }
    }
    while lines.last().is_some_and(|item| item.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}

pub(crate) fn graph_pages(
    client: &reqwest::blocking::Client,
    token: &str,
    start: &str,
    limit: usize,
) -> Result<Vec<serde_json::Value>, String> {
    let mut out = Vec::new();
    let mut next = Some(start.to_string());
    let mut pages = 0usize;
    while let Some(url) = next.take() {
        if pages >= limit {
            break;
        }
        pages += 1;
        let page = graph_get(client, token, &url).map_err(|err| consent_message(&err))?;
        if let Some(items) = page.get("value").and_then(|value| value.as_array()) {
            out.extend(items.iter().cloned());
        }
        next = page.get("@odata.nextLink").and_then(|value| value.as_str()).map(str::to_string);
    }
    Ok(out)
}

fn graph_post(
    client: &reqwest::blocking::Client,
    token: &str,
    url: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let response = client
        .post(url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .json(body)
        .send_graph(token)
        .map_err(|err| format!("Could not reach Microsoft Graph: {err}"))?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(consent_message(&format!("Graph refused the request ({status}). {}", clip(&text))));
    }
    if text.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(&text).map_err(|_| "Graph sent an unreadable response.".into())
}

fn consent_message(err: &str) -> String {
    if err.contains("(403") {
        "Sign in again to read the calendar and contacts.".into()
    } else {
        err.to_string()
    }
}

fn graph_send(client: &reqwest::blocking::Client, token: &str, request: &MailRequest) -> Result<serde_json::Value, String> {
    let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|_| "That mail action is not available.".to_string())?;
    let response = client
        .request(method, &request.url)
        .bearer_auth(&token)
        .header("Accept", "application/json")
        .json(&request.body)
        .send_graph(&token)
        .map_err(|err| format!("Could not reach Microsoft Graph: {err}"))?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Graph refused the request ({status}). {}", clip(&text)));
    }
    Ok(serde_json::from_str(&text).unwrap_or(serde_json::Value::Null))
}

/// smtp: and SMTP: proxy addresses, primary (SMTP) first, without the prefix.
pub fn smtp_aliases(value: &serde_json::Value) -> Vec<String> {
    let mut primary = Vec::new();
    let mut other = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let Some(list) = value.get("proxyAddresses").and_then(|item| item.as_array()) else {
        return Vec::new();
    };
    for item in list {
        let Some(raw) = item.as_str() else { continue };
        let Some((kind, addr)) = raw.split_once(':') else { continue };
        if !kind.eq_ignore_ascii_case("smtp") {
            continue;
        }
        let addr = addr.trim();
        if one_address(addr).is_err() {
            continue;
        }
        if !seen.insert(addr.to_lowercase()) {
            continue;
        }
        if kind.bytes().all(|byte| !byte.is_ascii_lowercase()) {
            primary.push(addr.to_string());
        } else {
            other.push(addr.to_string());
        }
    }
    primary.append(&mut other);
    primary
}

pub fn aliases(email: &str) -> Result<Vec<String>, String> {
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let me = graph_get(
        &client,
        &token,
        "https://graph.microsoft.com/v1.0/me?$select=proxyAddresses,mail,userPrincipalName",
    )?;
    Ok(smtp_aliases(&me))
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchFolder {
    pub id: String,
    pub name: String,
    pub filter: String,
}

/// A search folder matches the words in the subject. Quotes are escaped.
pub fn search_filter_query(query: &str) -> Result<String, String> {
    let text = query.trim();
    if text.is_empty() {
        return Err("Enter a search.".into());
    }
    if text.chars().count() > 180 || text.chars().any(|ch| ch.is_control()) {
        return Err("That search cannot be saved.".into());
    }
    Ok(format!("contains(subject,'{}')", text.replace('\'', "''")))
}

pub fn search_folder_body(name: &str, query: &str, sources: &[String]) -> Result<serde_json::Value, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Enter a name.".into());
    }
    if name.chars().count() > 120 || name.chars().any(|ch| ch.is_control()) {
        return Err("That name cannot be used.".into());
    }
    if sources.is_empty() || sources.len() > 40 {
        return Err("Choose a folder to search.".into());
    }
    let mut ids = Vec::new();
    for id in sources {
        let id = id.trim();
        if id.is_empty() || id.len() > 400 || id.chars().any(|ch| ch.is_control()) {
            return Err("Choose a folder to search.".into());
        }
        ids.push(id.to_string());
    }
    Ok(serde_json::json!({
        "@odata.type": "microsoft.graph.mailSearchFolder",
        "displayName": name,
        "includeNestedFolders": true,
        "sourceFolderIds": ids,
        "filterQuery": search_filter_query(query)?
    }))
}

fn search_folder_from(value: &serde_json::Value) -> Option<SearchFolder> {
    let id = value.get("id")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let name = value.get("displayName").and_then(|item| item.as_str()).unwrap_or("").trim();
    Some(SearchFolder {
        id: id.to_string(),
        name: if name.is_empty() { "Search".into() } else { name.to_string() },
        filter: value.get("filterQuery").and_then(|item| item.as_str()).unwrap_or("").to_string(),
    })
}

pub fn list_search_folders(email: &str) -> Result<Vec<SearchFolder>, String> {
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let listed = graph_pages(
        &client,
        &token,
        "https://graph.microsoft.com/v1.0/me/mailFolders/searchfolders/childFolders?$top=50&$select=id,displayName,filterQuery",
        4,
    )?;
    Ok(listed.iter().filter_map(search_folder_from).collect())
}

pub fn create_search_folder(email: &str, name: &str, query: &str, sources: &[String]) -> Result<SearchFolder, String> {
    let body = search_folder_body(name, query, sources)?;
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let saved = graph_post(
        &client,
        &token,
        "https://graph.microsoft.com/v1.0/me/mailFolders/searchfolders/childFolders",
        &body,
    )?;
    search_folder_from(&saved).ok_or_else(|| "Microsoft did not return the search folder.".into())
}

pub fn delete_search_folder(email: &str, folder_id: &str) -> Result<(), String> {
    let id = folder_id.trim();
    if id.is_empty() {
        return Err("That search folder is not on the server.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = http_client()?;
    let url = format!("https://graph.microsoft.com/v1.0/me/mailFolders/{}", path_segment(id));
    match crate::calendar::call(&client, &token, "DELETE", &url, None) {
        Ok(_) | Err((404, _)) => Ok(()),
        Err((401 | 403, _)) => Err("Sign in again to change folders.".into()),
        Err((_, reason)) if !reason.is_empty() => Err(format!("Microsoft did not remove the search folder: {reason}")),
        Err(_) => Err("Microsoft did not remove the search folder.".into()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_mailbox_never_has_more_than_three_calls_in_flight() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let now = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..10)
            .map(|_| {
                let (now, most) = (now.clone(), most.clone());
                std::thread::spawn(move || {
                    let _slot = MailboxSlot::take("token-a");
                    let n = now.fetch_add(1, Ordering::SeqCst) + 1;
                    most.fetch_max(n, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    now.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        // Another mailbox is not held up by the first.
        let other = MailboxSlot::take("token-b");
        drop(other);
        threads.into_iter().for_each(|t| t.join().unwrap());
        assert_eq!(most.load(Ordering::SeqCst), MAILBOX_SLOTS);
        let slots = SLOTS.lock().unwrap();
        assert!(slots.as_ref().map_or(true, |map| !map.contains_key("token-a") && !map.contains_key("token-b")), "slots are given back");
    }

    #[test]
    fn a_busy_post_is_not_sent_twice() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/me/sendMail", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = stream.read(&mut buf);
            stream
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .unwrap();
            // No second request may follow.
            listener.set_nonblocking(true).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(300));
            listener.accept().is_err()
        });
        let response = http_client().unwrap().post(&url).json(&serde_json::json!({})).send_graph("token-d").unwrap();
        assert_eq!(response.status().as_u16(), 503);
        assert!(server.join().unwrap(), "a 503 on a POST was sent again");
    }

    #[test]
    fn a_throttled_call_waits_and_tries_again() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/me/messages", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let answers = [
                "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
            ];
            for answer in answers {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                stream.write_all(answer.as_bytes()).unwrap();
            }
        });
        let response = http_client().unwrap().get(&url).send_graph("token-c").unwrap();
        assert_eq!(response.status().as_u16(), 200);
        server.join().unwrap();
        assert!(repeatable_method(&reqwest::Method::GET));
        assert!(!repeatable_method(&reqwest::Method::POST));
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(reqwest::header::RETRY_AFTER, "7".parse().unwrap());
        assert_eq!(retry_after(&headers), Some(7));
    }

    use super::*;

    #[test]
    fn event_html_to_text_is_linear_on_hostile_bodies() {
        let start = std::time::Instant::now();
        for body in ["<b>x".repeat(300_000), "<".repeat(1_000_000), "&".repeat(1_000_000) + ";", "<sCrIpT>".repeat(200_000)] {
            html_to_text(&body);
        }
        assert!(start.elapsed() < std::time::Duration::from_secs(5), "{:?}", start.elapsed());
        assert_eq!(html_to_text("<p>A &amp; B</p><SCRIPT>x</Script>C &bogus; &#65;"), "A & B\nC &bogus; A");
        assert_eq!(html_to_text("1 < 2 & 3"), "1 < 2 & 3");
    }

    #[test]
    fn open_refuses_launchers_and_programs() {
        for name in ["run.desktop", "x.SH", "setup.AppImage", "page.html", "a/b/evil.exe", "trail.desktop."] {
            assert!(launchable(name), "{name}");
        }
        for name in ["invoice.pdf", "photo.JPG", "notes.txt", "README", "sheet.xlsx"] {
            assert!(!launchable(name), "{name}");
        }
        assert!(launchable_bytes(b"[Desktop Entry]\nExec=sh -c id\n"));
        assert!(launchable_bytes(b"\n  #!/bin/sh\nid\n"));
        assert!(launchable_bytes(b"\x7fELF\x02\x01"));
        assert!(launchable_bytes(b"<!DOCTYPE html><script>"));
        assert!(!launchable_bytes(b"%PDF-1.7\n"));
        assert!(!launchable_bytes(b"Plain notes about the kiln."));
        // Audit run-1: XHTML and HTML a browser sniffs past a comment or text.
        for name in ["statement.xht", "page.XHTM", "saved.mhtml", "feed.xml", "style.xslt"] {
            assert!(launchable(name), "{name}");
        }
        assert!(launchable_bytes(b"<!-- x --><html><script>alert(1)</script>"));
        assert!(launchable_bytes(b"<script>alert(1)</script>"));
        assert!(launchable_bytes(b"Dear customer,\n<a href=x>statement</a>"));
        assert!(!has_extension("statement"));
        assert!(!has_extension(".bashrc"));
        assert!(has_extension("invoice.pdf"));
        assert!(plain_document_bytes(b"%PDF-1.7\n"));
        assert!(!plain_document_bytes(b"<b>hello</b>"));
        assert!(!plain_document_bytes(b"Plain notes"));
    }

    #[test]
    fn a_message_moves_to_any_folder() {
        let request = move_request("AAMk/1", "AQMkFolder==").unwrap();
        assert!(request.url.ends_with("/messages/AAMk%2F1/move"));
        assert_eq!(request.body["destinationId"], "AQMkFolder==");
        assert!(move_request("m", "").is_err());
        assert!(move_request("m", "bad\u{0}id").is_err());
        assert!(move_request("", "f").is_err());
    }

    #[test]
    fn a_move_reports_the_new_id() {
        let reply = serde_json::json!({ "id": "AAMk-new", "subject": "Hi" });
        assert_eq!(moved_id("AAMk-old", &reply), Some(MovedId { from: "AAMk-old".into(), to: "AAMk-new".into() }));
        assert_eq!(moved_id("same", &serde_json::json!({ "id": "same" })), None);
        assert_eq!(moved_id("old", &serde_json::Value::Null), None);
        let back = mail_action_request("inbox", "AAMk-old").unwrap();
        assert!(back.url.ends_with("/move"));
        assert_eq!(back.body["destinationId"], "inbox");
    }

    #[test]
    fn opened_files_never_replace_an_existing_file() {
        let dir = std::env::temp_dir().join(format!("mailroom-open-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = write_download(&dir, "note.txt", b"one").unwrap();
        let second = write_download(&dir, "note.txt", b"two").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&first).unwrap(), b"one");
        let _ = std::fs::remove_dir_all(&dir);
    }
    use std::collections::HashMap;

    fn folder_page(items: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "value": items })
    }

    #[test]
    fn importance_and_read_receipts_go_with_the_message() {
        let request = outgoing_request(&OutgoingMail {
            subject: "Hi".into(),
            body_html: "<p>Hi</p>".into(),
            to: "one@example.com".into(),
            importance: "High".into(),
            read_receipt: true,
            ..Default::default()
        })
        .unwrap();
        assert_eq!(request.body["message"]["importance"], "high");
        assert_eq!(request.body["message"]["isReadReceiptRequested"], true);
        let plain = outgoing_request(&OutgoingMail { to: "one@example.com".into(), ..Default::default() }).unwrap();
        assert_eq!(plain.body["message"]["importance"], "normal");
        assert_eq!(plain.body["message"]["isReadReceiptRequested"], false);
    }

    #[test]
    fn a_shared_calendar_says_whose_it_is_and_if_it_can_change() {
        let cal = calendar_from_value(&serde_json::json!({ "id": "c1", "name": "Maya", "canEdit": false, "owner": { "name": "Maya Chen", "address": "maya@example.org" } }), "jon@timberworks.example").unwrap();
        assert!(!cal.can_edit);
        assert!(cal.is_shared);
        assert_eq!(cal.owner, "maya@example.org");
        assert_eq!(cal.owner_name, "Maya Chen");
        let own = calendar_from_value(&serde_json::json!({ "id": "c2", "name": "Calendar", "owner": { "name": "Jon", "address": "Jon@Timberworks.example" } }), "jon@timberworks.example").unwrap();
        assert!(own.can_edit);
        assert!(!own.is_shared);
        let bare = calendar_from_value(&serde_json::json!({ "id": "c3", "name": "Calendar" }), "jon@timberworks.example").unwrap();
        assert!(!bare.is_shared);
    }

    #[test]
    fn canadian_windows_zones_become_utc() {
        let at = |zone: &str, stamp: &str| {
            event_instant(&serde_json::json!({ "dateTime": stamp, "timeZone": zone })).unwrap()
        };
        // After 1 November 2026 the new names stay on the daylight offset.
        assert_eq!(at("Pacific Time (British Columbia)", "2026-11-03T10:00:00"), "2026-11-03T17:00:00Z");
        assert_eq!(at("Mountain Time (Alberta)", "2026-11-03T10:00:00"), "2026-11-03T16:00:00Z");
        assert_eq!(at("Manitoba", "2026-11-03T10:00:00"), "2026-11-03T15:00:00Z");
        // Before that morning they still changed with the season.
        assert_eq!(at("Pacific Time (British Columbia)", "2026-01-15T10:00:00"), "2026-01-15T18:00:00Z");
        assert_eq!(at("Manitoba", "2026-01-15T10:00:00"), "2026-01-15T16:00:00Z");
        assert_eq!(at("Manitoba", "2026-07-01T10:00:00"), "2026-07-01T15:00:00Z");
        // The old Pacific name still falls back in November. US rules.
        assert_eq!(at("Pacific Standard Time", "2026-11-03T10:00:00"), "2026-11-03T18:00:00Z");
        assert_eq!(at("Pacific Standard Time", "2026-07-01T10:00:00"), "2026-07-01T17:00:00Z");
        assert_eq!(at("Canada Central Standard Time", "2026-07-01T10:00:00"), "2026-07-01T16:00:00Z");
        // A stamp that already says UTC is left alone. An unknown zone is not guessed.
        assert_eq!(at("UTC", "2026-11-03T10:00:00"), "2026-11-03T10:00:00Z");
        assert_eq!(at("Somewhere Standard Time", "2026-11-03T10:00:00"), "2026-11-03T10:00:00");
        assert_eq!(
            event_instant(&serde_json::json!({ "dateTime": "2026-11-03T10:00:00Z", "timeZone": "Manitoba" })).unwrap(),
            "2026-11-03T10:00:00Z"
        );
    }

    #[test]
    fn proxy_addresses_keep_smtp_aliases() {
        let me = serde_json::json!({
            "proxyAddresses": ["SMTP:jon@timberworks.example", "smtp:studio@timberworks.example", "smtp:jon@timberworks.example", "SIP:jon@timberworks.example", "smtp:not an address"]
        });
        assert_eq!(smtp_aliases(&me), vec!["jon@timberworks.example".to_string(), "studio@timberworks.example".to_string()]);
        assert!(smtp_aliases(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn a_search_folder_is_a_mail_search_folder() {
        let body = search_folder_body("Weekly digests", "weekly digest", &["inbox-id".into()]).unwrap();
        assert_eq!(body["@odata.type"], "microsoft.graph.mailSearchFolder");
        assert_eq!(body["displayName"], "Weekly digests");
        assert_eq!(body["includeNestedFolders"], true);
        assert_eq!(body["sourceFolderIds"][0], "inbox-id");
        assert_eq!(body["filterQuery"], "contains(subject,'weekly digest')");
        let quoted = search_folder_body("Quotes", "o'brien", &["in".into()]).unwrap();
        assert_eq!(quoted["filterQuery"], "contains(subject,'o''brien')");
        assert!(search_folder_body("", "x", &["in".into()]).is_err());
        assert!(search_folder_body("Name", "", &["in".into()]).is_err());
        assert!(search_folder_body("Name", "x", &[]).is_err());
    }

    #[test]
    fn an_alias_is_the_from_address() {
        let request = outgoing_request(&OutgoingMail {
            to: "one@example.com".into(),
            from_address: "studio@timberworks.example".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(request.body["message"]["from"]["emailAddress"]["address"], "studio@timberworks.example");
        let plain = outgoing_request(&OutgoingMail { to: "one@example.com".into(), ..Default::default() }).unwrap();
        assert!(plain.body["message"].get("from").is_none());
        assert!(outgoing_request(&OutgoingMail {
            to: "one@example.com".into(),
            from_address: "not an address".into(),
            ..Default::default()
        })
        .is_err());
    }

    #[test]
    fn outgoing_mail_is_a_send_request() {
        let request = outgoing_request(&OutgoingMail {
            subject: " Hello ".into(),
            body_html: "<p>Hi</p>".into(),
            to: "one@example.com; two@example.com".into(),
            cc: "one@example.com, three@example.com".into(),
            bcc: " hidden@example.com ".into(),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.url, "https://graph.microsoft.com/v1.0/me/sendMail");
        assert_eq!(request.body["saveToSentItems"], true);
        assert_eq!(request.body["message"]["subject"], "Hello");
        assert_eq!(request.body["message"]["body"]["contentType"], "HTML");
        assert_eq!(request.body["message"]["body"]["content"], "<p>Hi</p>");
        assert_eq!(request.body["message"]["toRecipients"].as_array().unwrap().len(), 2);
        assert_eq!(request.body["message"]["ccRecipients"].as_array().unwrap().len(), 1);
        assert_eq!(
            request.body["message"]["bccRecipients"][0]["emailAddress"]["address"],
            "hidden@example.com"
        );
        assert!(outgoing_request(&OutgoingMail {
            subject: String::new(),
            body_html: String::new(),
            to: String::new(),
            cc: String::new(),
            bcc: String::new(),
            ..Default::default()
        })
        .is_err());
        assert!(outgoing_request(&OutgoingMail {
            subject: String::new(),
            body_html: String::new(),
            to: "not-an-email".into(),
            cc: String::new(),
            bcc: String::new(),
            ..Default::default()
        })
        .is_err());
        assert!(request.body["message"].get("attachments").is_none());
    }

    #[test]
    fn outgoing_mail_embeds_a_data_image() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let html = format!(
            "<p>Hello</p><img alt=\"e\" src=\"data:image/png;base64,{png}\"><img src='data:image/png;base64,{png}'><img src=\"https://images.example.test/keep.png\"><img src=\"data:text/html;base64,PGh0bWw+\">"
        );
        let request = outgoing_request(&OutgoingMail {
            subject: "Logo".into(),
            body_html: html,
            to: "one@example.com".into(),
            cc: String::new(),
            bcc: String::new(),
            ..Default::default()
        })
        .unwrap();
        let content = request.body["message"]["body"]["content"].as_str().unwrap();
        assert!(content.contains("src=\"cid:image001.png\""));
        assert!(content.contains("src='cid:image001.png'"));
        assert!(content.contains("https://images.example.test/keep.png"));
        assert!(!content.contains("data:image"));
        assert!(content.contains("data:text/html"));
        let files = request.body["message"]["attachments"].as_array().unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0]["name"], "image001.png");
        assert_eq!(files[0]["contentType"], "image/png");
        assert_eq!(files[0]["contentId"], "image001.png");
        assert_eq!(files[0]["isInline"], true);
        assert_eq!(files[0]["contentBytes"], png);
        assert_eq!(files[0]["@odata.type"], "#microsoft.graph.fileAttachment");
    }

    #[test]
    fn well_known_folders_use_stable_keys() {
        assert_eq!(folder_key("inbox", "long"), "inbox");
        assert_eq!(folder_key("Drafts", "long"), "drafts");
        assert_eq!(folder_key("outbox", "long"), "outbox");
        assert_eq!(folder_key("sentitems", "long"), "sent");
        assert_eq!(folder_key("archive", "long"), "archive");
        assert_eq!(folder_key("deleteditems", "long"), "trash");
        assert_eq!(folder_key("", "AAMk+id/="), "AAMk+id/=");
        assert_eq!(folder_key("junkemail", "junk-id"), "junk-id");
        assert!(!FOLDER_SELECT.split(',').any(|part| part == "wellKnownName"));
        assert_eq!(
            well_known_url("deleteditems"),
            "https://graph.microsoft.com/v1.0/me/mailFolders/deleteditems?$select=id"
        );
    }

    #[test]
    fn well_known_ids_rename_folders_and_a_missing_folder_is_skipped() {
        let mut known = HashMap::new();
        remember_well_known(&mut known, "inbox", &serde_json::json!({"id": " AAMk-in "}));
        remember_well_known(&mut known, "drafts", &serde_json::json!({"id": ""}));
        remember_well_known(&mut known, "sentitems", &serde_json::json!({"displayName": "Sent"}));
        remember_well_known(&mut known, "deleteditems", &serde_json::json!({"id": "AAMk-bin"}));
        assert!(folder_is_missing(
            "Graph refused the request (404 Not Found). {\"error\":{\"code\":\"ErrorItemNotFound\"}}"
        ));
        assert!(!folder_is_missing(
            "Graph refused the request (400 Bad Request). wellKnownName"
        ));
        let mut folders = vec![
            LiveFolder {
                id: "AAMk-in".into(),
                parent_id: "root".into(),
                name: "Inbox".into(),
                key: "AAMk-in".into(),
                unread: 1,
                total: 2,
                depth: 0,
            },
            LiveFolder {
                id: "AAMk-bin".into(),
                parent_id: "root".into(),
                name: "Deleted Items".into(),
                key: "AAMk-bin".into(),
                unread: 0,
                total: 1,
                depth: 0,
            },
            LiveFolder {
                id: "AAMk-custom".into(),
                parent_id: "root".into(),
                name: "Customers".into(),
                key: "AAMk-custom".into(),
                unread: 0,
                total: 0,
                depth: 0,
            },
        ];
        apply_well_known_keys(&mut folders, &known);
        assert_eq!(folders[0].key, "inbox");
        assert_eq!(folders[1].key, "trash");
        assert_eq!(folders[2].key, "AAMk-custom");
        assert!(!known.contains_key(""));
    }

    #[test]
    fn a_conversation_filter_is_quoted_and_encoded() {
        let url = conversation_url("AAQk'x=/+").unwrap();
        assert!(url.starts_with("https://graph.microsoft.com/v1.0/me/messages?"));
        assert!(url.contains("$filter=conversationId%20eq%20%27AAQk%27%27x%3D%2F%2B%27"));
        assert!(conversation_url("  ").is_err());
        assert!(conversation_url("a\nb").is_err());
    }

    #[test]
    fn folder_ids_are_encoded_in_the_path() {
        assert_eq!(path_segment("AAMk+id/="), "AAMk%2Bid%2F%3D");
        assert_eq!(path_segment("inbox"), "inbox");
    }

    #[test]
    fn folders_keep_server_order_and_skip_hidden() {
        let root = folder_page(serde_json::json!([
            {"id":"in","displayName":"Inbox","wellKnownName":"inbox","parentFolderId":"root","childFolderCount":1,"unreadItemCount":3,"totalItemCount":10},
            {"id":"hid","displayName":"Hidden","isHidden":true,"parentFolderId":"root","childFolderCount":1},
            {"id":"dr","displayName":"Drafts","wellKnownName":"drafts","parentFolderId":"root","childFolderCount":0,"unreadItemCount":1,"totalItemCount":1}
        ]));
        let page2 = folder_page(serde_json::json!([
            {"id":"in","displayName":"Inbox","wellKnownName":"inbox","childFolderCount":0},
            {"id":"proj","displayName":"Projects","parentFolderId":"root","childFolderCount":1,"unreadItemCount":0,"totalItemCount":4}
        ]));
        let customers = folder_page(serde_json::json!([
            {"id":"cust","displayName":"Customers","parentFolderId":"in","childFolderCount":0,"unreadItemCount":2,"totalItemCount":2}
        ]));
        let quarter = folder_page(serde_json::json!([
            {"id":"q4","displayName":"Q4","parentFolderId":"proj","childFolderCount":0,"totalItemCount":1}
        ]));
        let mut asked = Vec::new();
        let folders = collect_tree(
            |url| {
                asked.push(url.to_string());
                Ok(match url {
                    "root" => {
                        let mut page = root.clone();
                        page["@odata.nextLink"] = serde_json::json!("page2");
                        page
                    }
                    "page2" => page2.clone(),
                    "child:in" => customers.clone(),
                    "child:proj" => quarter.clone(),
                    "child:hid" => return Err("hidden folder was walked".into()),
                    _ => return Err(format!("unexpected {url}")),
                })
            },
            "root",
            |id| format!("child:{id}"),
        )
        .unwrap();
        let keys: Vec<_> = folders.iter().map(|folder| folder.key.clone()).collect();
        assert_eq!(keys, vec!["inbox", "cust", "drafts", "proj", "q4"]);
        assert_eq!(folders[0].unread, 3);
        assert_eq!(folders[1].depth, 1);
        assert_eq!(folders[1].name, "Customers");
        assert_eq!(folders[3].key, "proj");
        assert_eq!(folders[4].depth, 1);
        assert!(!asked.iter().any(|url| url == "child:hid"));
    }

    #[test]
    fn folder_walk_stops_at_the_depth_cap() {
        let folders = collect_tree(
            |url| {
                let current = if url == "root" {
                    -1
                } else {
                    url.strip_prefix("child:").unwrap()[1..].parse::<i32>().unwrap()
                };
                let id = format!("n{}", current + 1);
                Ok(folder_page(serde_json::json!([{
                    "id": id,
                    "displayName": id,
                    "childFolderCount": 1,
                    "parentFolderId": "p"
                }])))
            },
            "root",
            |id| format!("child:{id}"),
        )
        .unwrap();
        let ids: Vec<_> = folders.iter().map(|folder| folder.id.clone()).collect();
        assert_eq!(ids, vec!["n0", "n1", "n2", "n3", "n4"]);
        assert_eq!(folders.last().unwrap().depth, 4);
    }

    #[test]
    fn mail_actions_target_read_flag_archive_and_deleted_items() {
        let encoded = mail_action_request("read", "AAMk+id/=").unwrap();
        assert_eq!(encoded.method, "PATCH");
        assert_eq!(encoded.url, "https://graph.microsoft.com/v1.0/me/messages/AAMk%2Bid%2F%3D");
        assert_eq!(encoded.body["isRead"], true);

        assert_eq!(mail_action_request("unread", "m").unwrap().body["isRead"], false);
        assert_eq!(
            mail_action_request("flag", "m").unwrap().body["flag"]["flagStatus"],
            "flagged"
        );
        assert_eq!(
            mail_action_request("unflag", "m").unwrap().body["flag"]["flagStatus"],
            "notFlagged"
        );
        let archived = mail_action_request("archive", "m").unwrap();
        assert_eq!(archived.method, "POST");
        assert_eq!(archived.url, "https://graph.microsoft.com/v1.0/me/messages/m/move");
        assert_eq!(archived.body["destinationId"], "archive");
        assert_eq!(mail_action_request("trash", "m").unwrap().body["destinationId"], "deleteditems");
        assert_eq!(mail_action_request("inbox", "m").unwrap().body["destinationId"], "inbox");
        assert!(mail_action_request("send", "m").is_err());
        assert!(mail_action_request("read", "  ").is_err());
    }

    #[test]
    fn graph_flag_and_read_state_are_kept() {
        let flagged = parse_message(serde_json::json!({
            "id": "m",
            "isRead": false,
            "flag": { "flagStatus": "flagged" },
            "body": { "contentType": "text", "content": "Hi" }
        }))
        .unwrap();
        assert!(flagged.unread);
        assert!(flagged.flagged);
        assert!(!flagged.has_attachments);
        assert!(flagged.files.is_empty());
        assert_eq!(flagged.body_html, "<p>Hi</p>");
        let clear = parse_message(serde_json::json!({
            "id": "m",
            "isRead": true,
            "hasAttachments": true,
            "flag": { "flagStatus": "notFlagged" }
        }))
        .unwrap();
        assert!(!clear.unread);
        assert!(!clear.flagged);
        assert!(clear.has_attachments);
        assert!(clear.files.is_empty());
        let mixed = parse_message(serde_json::json!({
            "id": "m",
            "hasAttachments": false,
            "attachments": [
                { "id": "img", "name": "logo.png", "contentType": "image/png", "size": 12, "isInline": true },
                { "id": "pdf", "name": "Tickets.pdf", "contentType": "application/pdf", "size": 99, "isInline": false },
                { "id": "blank", "name": "  ", "contentType": "text/plain", "size": 1 }
            ]
        }))
        .unwrap();
        assert!(mixed.has_attachments);
        assert_eq!(mixed.files.len(), 1);
        let addressed = parse_message(serde_json::json!({
            "id": "m",
            "from": { "emailAddress": { "name": "Ada", "address": "ada@example.com" } },
            "toRecipients": [{ "emailAddress": { "name": "Bea", "address": "bea@example.com" } }],
            "ccRecipients": [{ "emailAddress": { "address": "cy@example.com" } }, { "emailAddress": { "address": "  " } }],
            "bccRecipients": []
        }))
        .unwrap();
        assert_eq!(addressed.from_email, "ada@example.com");
        assert_eq!(addressed.to.len(), 1);
        assert_eq!(addressed.to[0].name, "Bea");
        assert_eq!(addressed.to[0].email, "bea@example.com");
        assert_eq!(addressed.cc.len(), 1);
        assert_eq!(addressed.cc[0].email, "cy@example.com");
        assert!(addressed.bcc.is_empty());
        assert_eq!(mixed.files[0].id, "pdf");
        assert_eq!(mixed.files[0].name, "Tickets.pdf");
        assert_eq!(mixed.files[0].content_type, "application/pdf");
        assert_eq!(mixed.files[0].size, 99);
        let wrapped = files_from_value(&serde_json::json!({
            "value": [{ "id": "a", "name": "Notes.docx", "contentType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "size": 4 }]
        }));
        assert_eq!(wrapped.len(), 1);
        assert_eq!(wrapped[0].name, "Notes.docx");
    }

    #[test]
    fn attachment_urls_select_metadata_and_skip_file_bytes() {
        let folder = messages_url("in/box", "").unwrap();
        assert!(folder.contains("/mailFolders/in%2Fbox/messages?"));
        assert!(folder.contains("$top=40"));
        assert!(folder.contains("$expand=attachments($select=id,name,contentType,size,isInline)"));
        assert!(!folder.contains("$filter"));
        assert!(!folder.contains("contentBytes"));
        let list = attachments_url("AAMk+id/=").unwrap();
        assert!(list.starts_with("https://graph.microsoft.com/v1.0/me/messages/AAMk%2Bid%2F%3D/attachments?"));
        assert!(list.contains("$select=id,name,contentType,size,isInline"));
        assert!(!list.contains("contentBytes"));
        assert_eq!(
            attachment_value_url("m", "f/1").unwrap(),
            "https://graph.microsoft.com/v1.0/me/messages/m/attachments/f%2F1/$value"
        );
        assert!(attachments_url(" ").is_err());
        assert!(attachment_value_url("m", " ").is_err());
        assert_eq!(safe_file_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_file_name(".."), "attachment");
        assert_eq!(safe_file_name("Tickets NL (1).pdf"), "TicketsNL1.pdf");
        assert_eq!(download_file_name("Tickets NL (1).pdf"), "Tickets NL (1).pdf");
        assert_eq!(download_file_name("../../etc/passwd"), "passwd");
        assert_eq!(download_file_name("..\\..\\secret"), "secret");
        assert_eq!(download_file_name(".."), "attachment");
        assert_eq!(download_file_name("a\u{0}b.pdf"), "ab.pdf");
        assert!(download_file_name(&"a".repeat(400)).len() <= 180);
        let err = save_attachments(
            "person@example.com",
            "m",
            &[("f".into(), "a.pdf".into())],
            "/no/such/mailroom-folder",
        )
        .unwrap_err();
        assert_eq!(err, "Choose a folder.");
        assert_eq!(
            save_attachments("person@example.com", "m", &[], "/tmp").unwrap_err(),
            "Select an attachment."
        );
        assert_eq!(
            prepare_download("/tmp", &[("".into(), "a.pdf".into())]).unwrap_err(),
            "Choose a file."
        );
        let root = std::env::temp_dir().join(format!("mailroom-download-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let first = write_download(&root, "Tickets NL (1).pdf", b"one").unwrap();
        let canon = root.canonicalize().unwrap();
        assert_eq!(first.parent().unwrap(), canon);
        assert_eq!(std::fs::read(&first).unwrap(), b"one");
        let second = write_download(&root, "Tickets NL (1).pdf", b"two").unwrap();
        assert_eq!(second.file_name().unwrap().to_string_lossy(), "Tickets NL (1) (2).pdf");
        assert_eq!(std::fs::read(&second).unwrap(), b"two");
        let nested = write_download(&root, "../../outside.txt", b"no").unwrap();
        assert_eq!(nested.parent().unwrap(), canon);
        assert_eq!(nested.file_name().unwrap().to_string_lossy(), "outside.txt");
        let _ = std::fs::remove_dir_all(&root);
        assert!(safe_file_name(&"a".repeat(200)).len() <= 80);
        assert!(!safe_file_name(&"a".repeat(200)).contains(".."));
    }

    #[test]
    fn mail_search_asks_the_server_without_file_bytes() {
        let url = mail_search_url("in/box", "kiln schedule", "2026-01-01", "2026-10-20", "yes").unwrap();
        assert!(url.starts_with("https://graph.microsoft.com/v1.0/me/mailFolders/in%2Fbox/messages?"));
        assert!(url.contains("$top=25"));
        assert!(url.contains("parentFolderId"));
        assert!(url.contains("$search=%22kiln%20schedule%22"));
        assert!(url.contains("received%3E%3D2026-01-01"));
        assert!(url.contains("received%3C%3D2026-10-20"));
        assert!(url.contains("hasAttachments%3Atrue"));
        assert!(!url.contains("contentBytes"));
        assert!(mail_search_url("", "  ", "", "", "").is_err());
        assert!(mail_search_url("", &"a".repeat(201), "", "", "").is_err());
        let mailbox = mail_search_url("", "quote", "yesterday", "", "no").unwrap();
        assert!(mailbox.starts_with("https://graph.microsoft.com/v1.0/me/messages?"));
        assert!(mailbox.contains("hasAttachments%3Afalse"));
        assert!(!mailbox.contains("yesterday"));
        let next = "https://graph.microsoft.com/v1.0/me/messages?$search=%22kiln%22&$skiptoken=abc";
        assert_eq!(trusted_search_link(next).unwrap(), next);
        assert!(trusted_search_link("https://evil.example/v1.0/me/messages?$search=kiln").is_err());
        assert!(trusted_search_link("https://graph.microsoft.com/v1.0/me/messages?$select=contentBytes").is_err());
        let page = parse_search_page(serde_json::json!({
            "value": [{
                "id": "m",
                "subject": "Kiln",
                "parentFolderId": "folder-1",
                "hasAttachments": false
            }],
            "@odata.nextLink": next
        }));
        assert_eq!(page.messages.len(), 1);
        assert_eq!(page.messages[0].message.subject, "Kiln");
        assert_eq!(page.messages[0].parent_folder_id, "folder-1");
        assert_eq!(page.next_link, next);
    }

    #[test]
    fn calendar_view_names_the_calendar_and_the_range() {
        let url = calendar_view_url("cal/id", "2026-10-19T07:00:00.000Z", "2026-10-26T07:00:00.000Z").unwrap();
        assert!(url.contains("/me/calendars/cal%2Fid/calendarView?"));
        assert!(url.contains("startDateTime=2026-10-19T07%3A00%3A00.000Z"));
        assert!(url.contains("endDateTime=2026-10-26T07%3A00%3A00.000Z"));
        assert!(calendar_view_url("  ", "2026-10-19T00:00:00Z", "2026-10-20T00:00:00Z").is_err());
        assert!(calendar_view_url("cal", "today", "2026-10-20T00:00:00Z").is_err());
        assert_eq!(CALENDAR_LIST_PAGES, 4);
        assert_eq!(CALENDAR_EVENT_PAGES, 20);
    }

    #[test]
    fn a_delta_anchor_covers_the_sync_window_only() {
        let url = window_delta_url("in/box", "2026-07-17T00:00:00.000Z").unwrap();
        assert!(url.contains("/mailFolders/in%2Fbox/messages/delta?"));
        assert!(url.contains("$filter=receivedDateTime%20ge%202026-07-17T00%3A00%3A00.000Z"));
        assert!(!url.contains("deltatoken"));
        assert!(trusted_delta_link(&url));
        let latest = window_delta_url("box", "").unwrap();
        assert!(latest.contains("$deltatoken=latest"));
        assert!(window_delta_url("box", "not-a-date").is_err());
        let anchor = anchor_delta_url("in/box", "2026-07-17T00:00:00.000Z").unwrap();
        assert!(anchor.contains("bodyPreview"));
        assert!(!anchor.contains(",body,") && !anchor.contains(",body&"));
        assert!(!anchor.contains("attachments"));
        assert!(anchor_delta_url("box", "not-a-date").is_err());
    }

    #[test]
    fn messages_url_keeps_a_sync_window_and_rejects_a_bad_stamp() {
        let window = messages_url("in/box", "2026-07-17T00:00:00.000Z").unwrap();
        assert!(window.contains("/mailFolders/in%2Fbox/messages?"));
        assert!(window.contains("$top=40"));
        assert!(window.contains("$orderby=receivedDateTime%20desc"));
        assert!(window.contains("$filter=receivedDateTime%20ge%202026-07-17T00%3A00%3A00.000Z"));
        assert!(window.contains("$expand=attachments($select=id,name,contentType,size,isInline)"));
        assert!(window.contains("bodyPreview"));
        assert!(!window.contains(",body,") && !window.contains(",body&"));
        assert!(!window.contains("contentBytes"));
        assert!(messages_url("box", " 2026-07-17T00:00:00Z ").is_ok());
        assert!(messages_url("box", "not-a-date").is_err());
        assert!(messages_url("box", "2026-07-17T00:00:00.000Z&$select=contentBytes").is_err());
        assert!(messages_url("box", "2026-07-17").is_err());
        assert!(message_in_window("2026-07-17T00:00:00.0000000Z", "2026-07-17T00:00:00.000Z"));
        assert!(message_in_window("2026-10-20T12:00:00Z", "2026-07-17T00:00:00.000Z"));
        assert!(!message_in_window("2026-07-16T23:59:59Z", "2026-07-17T00:00:00.000Z"));
        assert!(!message_in_window("", "2026-07-17T00:00:00.000Z"));
        assert!(message_in_window("2026-01-01T00:00:00Z", ""));
        assert!(trusted_mail_link(
            "https://graph.microsoft.com/v1.0/me/mailFolders/abc/messages?$skiptoken=1"
        ));
        assert!(trusted_mail_link(
            "https://graph.microsoft.com/v1.0/me/mailFolders('abc')/messages?$skiptoken=1"
        ));
        assert!(!trusted_mail_link("https://graph.microsoft.com/v1.0/me/messages?$search=kiln"));
        assert!(!trusted_mail_link(
            "https://graph.microsoft.com/v1.0/me/mailFolders/abc/messages?$select=contentBytes"
        ));
        assert!(!trusted_mail_link("https://evil.example/v1.0/me/mailFolders/abc/messages"));
        assert_eq!(MAIL_PAGE, 40);
        assert_eq!(MAIL_SYNC_PAGES, 25);
    }

    #[test]
    fn events_keep_time_show_as_and_skip_cancelled() {
        let timed = event_from_value(
            &serde_json::json!({
                "id": "evt",
                "subject": "Board",
                "isAllDay": false,
                "showAs": "tentative",
                "location": { "displayName": "Studio" },
                "bodyPreview": "Bring the drawings",
                "start": { "dateTime": "2026-10-20T17:00:00.0000000", "timeZone": "UTC" },
                "end": { "dateTime": "2026-10-20T18:00:00.0000000", "timeZone": "UTC" },
                "organizer": { "emailAddress": { "name": "Maya", "address": "maya@example.com" } },
                "attendees": [{
                    "emailAddress": { "name": "Owen", "address": "owen@example.com" },
                    "status": { "response": "tentativelyAccepted" }
                }]
            }),
            "cal-1",
        )
        .unwrap();
        assert_eq!(timed.calendar_id, "cal-1");
        assert_eq!(timed.title, "Board");
        assert_eq!(timed.start, "2026-10-20T17:00:00.0000000Z");
        assert_eq!(timed.end, "2026-10-20T18:00:00.0000000Z");
        assert!(!timed.all_day);
        assert_eq!(timed.show_as, "tentative");
        assert_eq!(timed.location, "Studio");
        assert_eq!(timed.notes, "Bring the drawings");
        assert_eq!(timed.organizer_email, "maya@example.com");
        assert_eq!(timed.attendees.len(), 1);
        assert_eq!(timed.attendees[0].status, "tentative");

        let whole = event_from_value(
            &serde_json::json!({
                "id": "day",
                "subject": "",
                "isAllDay": true,
                "showAs": "oof",
                "start": { "dateTime": "2026-10-21T00:00:00.0000000", "timeZone": "UTC" },
                "end": { "dateTime": "2026-10-23T00:00:00.0000000", "timeZone": "UTC" }
            }),
            "cal-1",
        )
        .unwrap();
        assert!(whole.all_day);
        assert_eq!(whole.start, "2026-10-21");
        assert_eq!(whole.end, "2026-10-23");
        assert_eq!(whole.title, "(No title)");
        assert_eq!(whole.show_as, "oof");
        assert!(event_from_value(&serde_json::json!({ "id": "gone", "isCancelled": true }), "cal-1").is_none());

        let html = event_from_value(
            &serde_json::json!({
                "id": "html",
                "subject": "Intro",
                "showAs": "busy",
                "bodyPreview": "Agenda",
                "body": {
                    "contentType": "html",
                    "content": "<p>Agenda</p><div>Walk the site &amp; the numbers.</div><a href=\"https://example.com/join\">Join the meeting</a><a href=\"https://example.com/already\">https://example.com/already</a><a href=\"https://example.com/q?a=1&amp;b=2\">Details</a><a href=\"mailto:ada@example.com\">Email</a><a href=\"javascript:alert(1)\">Skip</a><a href=\"file:///tmp/secret\">Local</a><script>secret()</script><style>p{color:red}</style>"
                },
                "start": { "dateTime": "2026-10-20T17:00:00.0000000", "timeZone": "UTC" },
                "end": { "dateTime": "2026-10-20T17:30:00.0000000", "timeZone": "UTC" }
            }),
            "cal-1",
        )
        .unwrap();
        assert!(html.notes.contains("Agenda"));
        assert!(html.notes.contains("Walk the site & the numbers."));
        assert!(html.notes.contains("Join the meeting"));
        assert!(html.notes.contains("Email"));
        assert!(html.notes.contains("Skip"));
        assert!(html.notes.contains("Local"));
        assert_eq!(html.notes.matches("https://example.com/join").count(), 1);
        assert_eq!(html.notes.matches("https://example.com/already").count(), 1);
        assert_eq!(html.notes.matches("https://example.com/q?a=1&b=2").count(), 1);
        assert_eq!(html.notes.matches("mailto:ada@example.com").count(), 1);
        assert!(!html.notes.to_ascii_lowercase().contains("javascript"));
        assert!(!html.notes.contains("file:"));
        assert!(!html.notes.contains("/tmp/secret"));
        assert!(!html.notes.contains("secret"));
        assert!(!html.notes.contains("color:red"));
        assert!(!html.notes.contains('<'));
    }

    #[test]
    fn allowed_links_are_http_https_or_mailto() {
        assert!(allowed_link("https://example.com/join"));
        assert!(allowed_link("http://example.com/join"));
        assert!(allowed_link("mailto:ada@example.com"));
        assert!(allowed_link("mailto:ada@example.com?subject=Hello"));
        assert!(allowed_link("mailto:ada@example.com?subject=Hi&cc=bo@example.com&body=x"));
        assert!(!allowed_link("mailto:ada@example.com?attach=/home/ada/.ssh/id_rsa"));
        assert!(!allowed_link("mailto:ada@example.com?subject=Hi&Attachment=%2Fetc%2Fpasswd"));
        assert!(!allowed_link("mailto:ada@example.com?subject=Hi&%61ttach=/etc/passwd"));
        assert!(!allowed_link("javascript:alert(1)"));
        assert!(!allowed_link("file:///tmp/secret"));
        assert!(!allowed_link("https://user:pass@example.com/join"));
        assert!(!allowed_link("/relative"));
        assert!(!allowed_link("https://example.com/a b"));
        assert!(!allowed_link("https://example.com/\n"));
        assert!(!allowed_link(""));
        assert!(!allowed_link(&format!("https://example.com/{}", "a".repeat(2000))));
    }

    #[test]
    fn contacts_round_trip_the_fields_the_page_shows() {
        let person = contact_from_value(&serde_json::json!({
            "id": "c1",
            "displayName": "Ada Lovelace",
            "emailAddresses": [{ "address": "ada@example.com", "name": "Ada" }],
            "businessPhones": ["020 7946 0000"],
            "mobilePhone": "07700 900 000",
            "jobTitle": "Lead",
            "companyName": "Timberworks"
        }))
        .unwrap();
        assert_eq!(person.email, "ada@example.com");
        assert_eq!(person.phone, "020 7946 0000");
        assert_eq!(person.title, "Lead");
        assert_eq!(person.company, "Timberworks");
        let body = contact_body("Ada Lovelace", "ada@example.com", "020", "Lead", "Timberworks").unwrap();
        assert_eq!(body["displayName"], "Ada Lovelace");
        assert_eq!(body["emailAddresses"][0]["address"], "ada@example.com");
        assert_eq!(body["businessPhones"][0], "020");
        assert_eq!(body["jobTitle"], "Lead");
        assert!(contact_body("", "ada@example.com", "", "", "").is_err());
        assert!(contact_body("Ada", "not-an-email", "", "", "").is_err());
        assert!(contact_from_value(&serde_json::json!({ "id": "c2" })).is_none());
    }

    #[test]
    fn calendar_consent_asks_for_another_sign_in() {
        let denied = consent_message("Graph refused the request (403 Forbidden). Access denied");
        assert_eq!(denied, "Sign in again to read the calendar and contacts.");
        let other = consent_message("Graph refused the request (400 Bad Request).");
        assert!(other.contains("400"));
    }

    #[test]
    fn delta_links_cover_one_overlapping_day_and_ignore_removed_rows() {
        let url = latest_delta_url("in/box").unwrap();
        assert!(url.contains("/mailFolders/in%2Fbox/messages/delta?"));
        assert!(url.contains("$deltatoken=latest"));
        assert!(url.contains("$select=id,conversationId"));
        assert!(!url.contains("$expand"));
        assert!(!url.contains("contentBytes"));
        assert!(latest_delta_url(" ").is_err());

        let delta = "https://graph.microsoft.com/v1.0/me/mailFolders/in/messages/delta?$deltatoken=abc";
        let next = "https://graph.microsoft.com/v1.0/me/mailFolders/in/messages/delta?$skiptoken=abc";
        assert!(trusted_delta_link(delta));
        assert!(trusted_delta_link(next));
        assert!(trusted_delta_link(
            "https://graph.microsoft.com/v1.0/me/mailfolders('inbox')/messages/delta?$deltatoken=abc"
        ));
        assert!(!trusted_delta_link("https://evil.example/v1.0/me/mailFolders/in/messages/delta?$deltatoken=abc"));
        assert!(!trusted_delta_link("http://graph.microsoft.com/v1.0/me/mailFolders/in/messages/delta?$deltatoken=abc"));
        assert!(!trusted_delta_link("https://graph.microsoft.com/v1.0/me/mailFolders/in/messages?$skiptoken=abc"));
        assert!(!trusted_delta_link(&format!("{delta}&$select=contentBytes")));
        assert!(!trusted_delta_link(&format!("{delta} token")));
        assert!(!trusted_delta_link(&format!("{delta}{}", "a".repeat(20_000))));

        assert_eq!(overlap_stamp("2026-10-20T15:00:00Z").as_deref(), Some("2026-10-19T15:00:00Z"));
        assert_eq!(overlap_stamp("2026-03-01T00:00:00Z").as_deref(), Some("2026-02-28T00:00:00Z"));
        assert_eq!(overlap_stamp("2024-03-01T00:00:00Z").as_deref(), Some("2024-02-29T00:00:00Z"));
        assert_eq!(overlap_stamp("2026-01-01T08:30:00Z").as_deref(), Some("2025-12-31T08:30:00Z"));
        assert_eq!(
            overlap_stamp("2026-10-20T15:00:00.0000000Z").as_deref(),
            Some("2026-10-19T15:00:00.0000000Z")
        );
        let stamp = overlap_stamp("2026-10-20T15:00:00Z").unwrap();
        assert!(messages_url("inbox", &stamp).unwrap().contains("2026-10-19T15%3A00%3A00Z"));
        assert!(overlap_stamp("not-a-date").is_none());
        assert!(overlap_stamp("2026-02-30T00:00:00Z").is_none());
        assert!(overlap_stamp("2026-10-20T15:00:00+00:00").is_none());
        assert!(overlap_stamp("").is_none());

        let page = parse_delta_page(&serde_json::json!({
            "value": [
                { "id": "gone", "subject": "Leave this out", "@removed": { "reason": "deleted" } },
                { "id": " ", "@removed": { "reason": "deleted" } },
                { "id": "stay", "subject": "Hello", "isRead": false, "receivedDateTime": "2026-10-20T15:00:00Z" }
            ],
            "@odata.deltaLink": delta,
            "@odata.nextLink": next
        }));
        assert_eq!(page.removed, vec!["gone".to_string()]);
        assert_eq!(page.changed.len(), 1);
        assert_eq!(page.changed[0].id, "stay");
        assert_eq!(page.changed[0].subject, "Hello");
        assert!(page.changed[0].unread);
        assert!(page.patched.is_empty());
        assert_eq!(page.delta_link, delta);

        // A filtered delta sends a read or flag change as only those fields.
        let sparse = parse_delta_page(&serde_json::json!({
            "value": [
                { "id": "read", "isRead": true },
                { "id": "flag", "flag": { "flagStatus": "flagged" }, "categories": ["Blue"] },
                { "id": "renamed", "subject": "" }
            ]
        }));
        assert!(sparse.changed.is_empty());
        assert_eq!(sparse.patched.len(), 3);
        assert_eq!(sparse.patched[0], MessagePatch { id: "read".into(), unread: Some(false), ..Default::default() });
        assert_eq!(sparse.patched[1].flagged, Some(true));
        assert_eq!(sparse.patched[1].unread, None);
        assert_eq!(sparse.patched[1].subject, None);
        assert_eq!(sparse.patched[1].categories.as_deref(), Some(&["Blue".to_string()][..]));
        assert_eq!(sparse.patched[2].subject.as_deref(), Some("(No subject)"));
        assert_eq!(page.next_link, next);
        let rejected = parse_delta_page(&serde_json::json!({
            "@odata.deltaLink": "https://evil.example/messages/delta?$deltatoken=abc"
        }));
        assert!(rejected.delta_link.is_empty());

        let refused = delta_error(format!("Graph refused the request (410 Gone). {delta}"));
        assert_eq!(refused, "Graph refused the request (410 Gone).");
        assert!(!refused.contains("deltatoken"));
        assert!(delta_gone(&refused));
        let reach = delta_error(format!("Could not reach Microsoft Graph: error sending request for url ({delta})"));
        assert_eq!(reach, "Could not reach Microsoft Graph.");
        assert!(!reach.contains("deltatoken"));
        assert!(!delta_gone("Graph refused the request (404)."));
    }
}
