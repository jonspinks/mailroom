mod ai;
mod attach;
mod auth;
mod calendar;
mod compose;
mod errors;
mod folders;
mod gcal;
mod google;
mod graph;
mod inline;
mod launch;
mod mailbox;
mod migrate;
mod notify;
mod omarchy;
mod pdftext;
mod remoteimg;
mod senderauth;
mod software;
mod spell;
mod store;
mod unsubscribe;
mod tray;

use auth::AccountStatus;
use graph::{LiveCalendar, LiveContact, LiveEvent, LiveFile, LiveFolder, LiveMessage, MailSearchPage};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Mutex;
use tauri::Manager;

/// Quit is held until open drafts are written, then this code is used.
static QUIT_AFTER_DRAFTS: AtomicBool = AtomicBool::new(false);
static QUIT_CODE: AtomicI32 = AtomicI32::new(0);

/// The folder the person chose in the last folder picker. Saving attachments
/// only writes there, so the page cannot name a folder on its own.
static PICKED_FOLDER: Mutex<Option<PathBuf>> = Mutex::new(None);

fn remember_picked_folder(chosen: &Option<String>) {
    let picked = chosen
        .as_deref()
        .and_then(|path| std::path::Path::new(path).canonicalize().ok());
    if let Ok(mut slot) = PICKED_FOLDER.lock() {
        *slot = picked;
    }
}

/// Take the picked folder if it matches the one the page asks for.
fn take_picked_folder(directory: &str) -> Result<PathBuf, String> {
    let asked = std::path::Path::new(directory.trim())
        .canonicalize()
        .map_err(|_| "Choose a folder.".to_string())?;
    let mut slot = PICKED_FOLDER.lock().map_err(|_| "Choose a folder.".to_string())?;
    match slot.take() {
        Some(picked) if picked == asked => Ok(picked),
        _ => Err("Choose a folder.".into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InboxResult {
    name: String,
    email: String,
    messages: Vec<LiveMessage>,
    folders: Vec<LiveFolder>,
    from_cache: bool,
    /// Ids that left this folder in a merge. Empty when `merged` is false.
    removed: Vec<String>,
    /// True when `messages` is only what changed, and the page already on screen stays.
    merged: bool,
    /// True when older messages are still in the local cache, past this page.
    more: bool,
}

/// How many messages the list paints before the reader asks for older ones.
const LIST_PAGE: i64 = 100;

struct FolderCatchUp {
    removed: Vec<String>,
    changed: Vec<LiveMessage>,
    /// The folder was empty, so this sync replaced it. The list should paint the newest page.
    replaced: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderDelta {
    messages: Vec<LiveMessage>,
    removed: Vec<String>,
    merged: bool,
    more: bool,
}

/// Mail, calendar, and sign-in use blocking I/O. Run that on Tokio's blocking
/// pool so the window thread stays responsive and the blocking HTTP client is
/// not called from inside the async runtime.
async fn in_background<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    // A refusal from Microsoft or Google reaches the page as a sentence,
    // not its raw JSON (see errors.rs).
    match tauri::async_runtime::spawn_blocking(work).await {
        Ok(result) => result.map_err(|err| errors::friendly(&err)),
        Err(_) => Err("That step stopped before it finished.".into()),
    }
}

#[tauri::command]
async fn account_status() -> Result<AccountStatus, String> {
    in_background(|| Ok(auth::account_status())).await
}

#[tauri::command]
async fn client_id() -> Result<String, String> {
    in_background(|| Ok(auth::current_client_id())).await
}

#[tauri::command]
async fn save_client_id(id: String) -> Result<String, String> {
    in_background(move || auth::save_client_id(&id)).await
}

#[tauri::command]
async fn sign_in(login_hint: Option<String>, provider: Option<String>) -> Result<AccountStatus, String> {
    let provider = auth::Provider::parse(provider.as_deref().unwrap_or(""));
    in_background(move || auth::sign_in(login_hint, provider)).await
}

#[tauri::command]
async fn google_client_id() -> Result<String, String> {
    in_background(|| Ok(auth::current_google_client_id())).await
}

#[tauri::command]
async fn save_google_client(id: String, secret: Option<String>) -> Result<String, String> {
    in_background(move || auth::save_google_client(&id, secret.as_deref().unwrap_or(""))).await
}

/// What Gmail and Google Calendar accounts don't do in Mailroom yet.
fn not_for_google(what: &str) -> String {
    format!("{what} isn't available for Google accounts in Mailroom yet.")
}

#[tauri::command]
async fn sign_out(email: Option<String>) -> Result<AccountStatus, String> {
    in_background(move || {
        match email.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            Some(email) => auth::sign_out_account(email)?,
            None => auth::sign_out()?,
        }
        Ok(auth::account_status())
    })
    .await
}

/// The address a mailbox reports is the tenant's to set. It never stands for
/// a different signed-in account: that one's cache (and sign-in) is its own.
fn reported_email(graph_email: &str, requested: &str, signed_in: &[String]) -> String {
    let graph = graph_email.trim();
    let asked = requested.trim();
    if asked.is_empty() || graph.eq_ignore_ascii_case(asked) {
        return graph.to_string();
    }
    if graph.is_empty() || signed_in.iter().any(|other| other.trim().eq_ignore_ascii_case(graph)) {
        return asked.to_string();
    }
    graph.to_string()
}

fn signed_in_emails() -> Vec<String> {
    auth::account_status().accounts.into_iter().map(|item| item.email).collect()
}

fn cache_keys(graph_email: &str, requested: &str) -> Vec<String> {
    let mut keys = Vec::new();
    for raw in [graph_email, requested] {
        let key = raw.trim().to_lowercase();
        if !key.is_empty() && !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

fn anchor_folder(email: &str, folder_id: &str, since: &str) {
    if auth::is_google(email) {
        if let Ok(link) = google::anchor(email, folder_id) {
            let _ = store::save_delta_link(email, folder_id, &link);
        }
        return;
    }
    let Ok(token) = auth::access_token_for(email) else {
        return;
    };
    anchor_graph(email, folder_id, since, &token);
}

/// When a folder's anchor last failed. Walking a folder for a delta link is
/// many requests, so after a failure the next try waits six hours rather
/// than come round with every two-minute sync (2026-10-27).
static ANCHOR_FAILED: std::sync::Mutex<Option<std::collections::HashMap<String, std::time::Instant>>> = std::sync::Mutex::new(None);
const ANCHOR_RETRY: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

fn anchor_graph(email: &str, folder_id: &str, since: &str, token: &str) {
    let key = format!("{email}\n{folder_id}");
    if let Ok(failed) = ANCHOR_FAILED.lock() {
        if failed.as_ref().and_then(|map| map.get(&key)).is_some_and(|at| at.elapsed() < ANCHOR_RETRY) {
            return;
        }
    }
    match graph::anchor_mail_delta(token, folder_id, since) {
        Ok(link) => {
            let _ = store::save_delta_link(email, folder_id, &link);
            if let Ok(mut failed) = ANCHOR_FAILED.lock() {
                if let Some(map) = failed.as_mut() {
                    map.remove(&key);
                }
            }
        }
        Err(err) => {
            google::log(&format!("mail sync point not saved for a folder of {email}: {err}"));
            if let Ok(mut failed) = ANCHOR_FAILED.lock() {
                failed.get_or_insert_with(Default::default).insert(key, std::time::Instant::now());
            }
        }
    }
}

/// A cached folder stays on disk. Pull its delta link when one is stored.
/// Otherwise merge about one day before the newest cached message, then ask
/// for a delta link. An empty folder still uses the full sync window once.
/// The returned delta is what the list should merge. A full replace is flagged
/// so the list paints the newest page instead of the whole folder.
fn catch_up_folder(email: &str, folder_id: &str, full_since: &str) -> Result<FolderCatchUp, String> {
    if auth::is_google(email) {
        return catch_up_gmail(email, folder_id, full_since);
    }
    let token = auth::access_token_for(email)?;
    if let Some(link) = store::load_delta_link(email, folder_id)? {
        if graph::trusted_delta_link(&link) {
            match graph::pull_mail_delta(&token, &link) {
                Ok(delta) => {
                    // Patches first: the delta link moves on in apply_delta.
                    let patched = store::patch_messages(email, folder_id, &delta.patched)?;
                    store::apply_delta(email, folder_id, &delta.removed, &delta.changed, &delta.link)?;
                    let mut changed = delta.changed;
                    changed.extend(patched);
                    return Ok(FolderCatchUp {
                        removed: delta.removed,
                        changed,
                        replaced: false,
                    });
                }
                Err(err) if graph::delta_gone(&err) => {
                    store::clear_delta_link(email, folder_id)?;
                }
                Err(err) => return Err(err),
            }
        } else {
            store::clear_delta_link(email, folder_id)?;
        }
    }
    let state = store::folder_sync_state(email, folder_id)?;
    let mut changed = Vec::new();
    let mut replaced = false;
    if let Some(stamp) = state.newest.as_deref().and_then(graph::overlap_stamp) {
        changed = graph::fetch_folder(email, folder_id, &stamp)?;
        store::upsert_folder_messages(email, folder_id, &changed)?;
    } else if state.messages == 0 {
        changed = graph::fetch_folder(email, folder_id, full_since)?;
        store::replace_folder_messages(email, folder_id, &changed)?;
        store::refresh_folder_counts(email, folder_id)?;
        replaced = true;
    }
    let token = auth::access_token_for(email).unwrap_or(token);
    anchor_graph(email, folder_id, full_since, &token);
    Ok(FolderCatchUp { removed: Vec::new(), changed, replaced })
}

/// The same catching up for a Gmail folder, from its history.
fn catch_up_gmail(email: &str, folder_id: &str, full_since: &str) -> Result<FolderCatchUp, String> {
    if let Some(link) = store::load_delta_link(email, folder_id)? {
        if google::trusted_history_link(&link) {
            match google::pull(email, folder_id, &link) {
                Ok(delta) => {
                    store::apply_delta(email, folder_id, &delta.removed, &delta.changed, &delta.link)?;
                    let mut removed = delta.removed;
                    removed.extend(reconcile_gmail_if_due(email, folder_id, full_since));
                    return Ok(FolderCatchUp { removed, changed: delta.changed, replaced: false });
                }
                Err(err) if google::history_gone(&err) => store::clear_delta_link(email, folder_id)?,
                Err(err) => return Err(err),
            }
        } else {
            store::clear_delta_link(email, folder_id)?;
        }
    }
    let state = store::folder_sync_state(email, folder_id)?;
    if let Some(stamp) = state.newest.as_deref().and_then(graph::overlap_stamp) {
        let changed = google::fetch_folder(email, folder_id, &stamp)?;
        store::upsert_folder_messages(email, folder_id, &changed)?;
        let removed = reconcile_gmail_if_due(email, folder_id, full_since);
        anchor_folder(email, folder_id, full_since);
        return Ok(FolderCatchUp { removed, changed, replaced: false });
    }
    if state.messages == 0 {
        let changed = google::fetch_folder_first(email, folder_id, full_since)?;
        store::replace_folder_messages(email, folder_id, &changed)?;
        store::refresh_folder_counts(email, folder_id)?;
        anchor_folder(email, folder_id, full_since);
        return Ok(FolderCatchUp { removed: Vec::new(), changed, replaced: true });
    }
    anchor_folder(email, folder_id, full_since);
    Ok(FolderCatchUp { removed: Vec::new(), changed: Vec::new(), replaced: false })
}

/// Drop cached Gmail messages that have left a folder, within the sync
/// window: one cheap listing that catches what history may not say.
/// Returns the ids it removed.
fn reconcile_gmail(email: &str, folder_id: &str, since: &str) -> Vec<String> {
    let Ok(Some(server)) = google::ids_in_window(email, folder_id, since) else {
        return Vec::new();
    };
    let Ok(cached) = store::load_folder_headers(email, folder_id) else {
        return Vec::new();
    };
    let gone = google::missing_from(&cached, &server, since);
    if !gone.is_empty() {
        let _ = store::apply_delta(email, folder_id, &gone, &[], "");
    }
    gone
}

/// A quiet poll is the history request. Listing the window and diffing every
/// cached header runs about once an hour per folder, including the first poll
/// after a start. A failed listing still counts, so it does not retry every
/// two minutes.
const RECONCILE_EVERY: std::time::Duration = std::time::Duration::from_secs(60 * 60);
static RECONCILE_AT: Mutex<Option<std::collections::HashMap<String, std::time::Instant>>> = Mutex::new(None);

fn reconcile_is_due(last: Option<std::time::Instant>, now: std::time::Instant) -> bool {
    match last {
        None => true,
        Some(then) => now.saturating_duration_since(then) >= RECONCILE_EVERY,
    }
}

fn reconcile_gmail_if_due(email: &str, folder_id: &str, since: &str) -> Vec<String> {
    let key = format!("{}\n{}", email.trim().to_lowercase(), folder_id.trim());
    let now = std::time::Instant::now();
    let due = RECONCILE_AT
        .lock()
        .map(|clock| reconcile_is_due(clock.as_ref().and_then(|map| map.get(&key).copied()), now))
        .unwrap_or(true);
    if !due {
        return Vec::new();
    }
    if let Ok(mut clock) = RECONCILE_AT.lock() {
        clock.get_or_insert_with(Default::default).insert(key, now);
    }
    reconcile_gmail(email, folder_id, since)
}

fn newest_page(messages: &mut Vec<LiveMessage>) -> bool {
    messages.sort_by(|a, b| b.received.cmp(&a.received).then_with(|| b.id.cmp(&a.id)));
    let more = messages.len() > LIST_PAGE as usize;
    messages.truncate(LIST_PAGE as usize);
    more
}

fn page_delta(email: &str, folder_id: &str) -> Result<FolderDelta, String> {
    let page = store::load_folder_page(email, folder_id, false, LIST_PAGE, "", "")?;
    Ok(FolderDelta { messages: page.messages, removed: Vec::new(), merged: false, more: page.more })
}

fn list_delta(email: &str, folder_id: &str, mut catchup: FolderCatchUp) -> Result<FolderDelta, String> {
    if catchup.replaced {
        if let Ok(delta) = page_delta(email, folder_id) {
            return Ok(delta);
        }
        omit_message_bodies(&mut catchup.changed);
        let more = newest_page(&mut catchup.changed);
        return Ok(FolderDelta { messages: catchup.changed, removed: Vec::new(), merged: false, more });
    }
    omit_message_bodies(&mut catchup.changed);
    Ok(FolderDelta {
        messages: catchup.changed,
        removed: catchup.removed,
        merged: true,
        more: false,
    })
}

#[tauri::command]
async fn sync_inbox(email: Option<String>, since: Option<String>) -> Result<InboxResult, String> {
    in_background(move || {
        let requested = email.unwrap_or_default();
        let since = since.unwrap_or_default();
        let key = requested.trim().to_lowercase();
        let shown = if requested.trim().is_empty() { key.clone() } else { requested.trim().to_string() };
        if let Some(inbox_id) = store::cached_inbox_id(&key)? {
            let catchup = catch_up_folder(&key, &inbox_id, since.trim())?;
            let folders = store::load_folders(&key)?;
            let delta = list_delta(&key, &inbox_id, catchup)?;
            return Ok(InboxResult {
                name: String::new(),
                email: shown,
                messages: delta.messages,
                folders,
                from_cache: false,
                removed: delta.removed,
                merged: delta.merged,
                more: delta.more,
            });
        }
        let (name, email, folders, mut messages) = if auth::is_google(requested.trim()) {
            google::fetch_mailbox(requested.trim(), since.trim())?
        } else {
            graph::fetch_mailbox(requested.trim(), since.trim())?
        };
        let email = reported_email(&email, &requested, &signed_in_emails());
        store::replace_inbox(&messages)?;
        if let Some(inbox) = folders.iter().find(|folder| folder.key == "inbox") {
            let inbox_id = inbox.id.clone();
            for key in cache_keys(&email, requested.trim()) {
                store::replace_folders(&key, &folders)?;
                store::replace_folder_messages(&key, &inbox_id, &messages)?;
                anchor_folder(&key, &inbox_id, since.trim());
            }
            if let Ok(page) = store::load_folder_page(email.trim(), &inbox_id, false, LIST_PAGE, "", "") {
                return Ok(InboxResult {
                    name,
                    email,
                    messages: page.messages,
                    folders,
                    from_cache: false,
                    removed: Vec::new(),
                    merged: false,
                    more: page.more,
                });
            }
        } else {
            for key in cache_keys(&email, requested.trim()) {
                store::replace_folders(&key, &folders)?;
            }
        }
        omit_message_bodies(&mut messages);
        let more = newest_page(&mut messages);
        Ok(InboxResult {
            name,
            email,
            messages,
            folders,
            from_cache: false,
            removed: Vec::new(),
            merged: false,
            more,
        })
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackfillResult {
    /// Messages saved by this call.
    added: usize,
    /// Messages now cached in the folder.
    have: usize,
    /// Messages in the folder within the sync window (up to the cap).
    total: usize,
    /// Messages still to fetch; 0 when the folder is complete.
    remaining: usize,
}

/// Fill in the next batch of a Gmail folder that was first shown with only
/// its newest messages. It keeps no state, so after a restart it carries on
/// where it stopped. Microsoft folders arrive whole, so there is nothing to do.
#[tauri::command]
async fn backfill_mail(email: String, folder_id: String, since: Option<String>) -> Result<BackfillResult, String> {
    in_background(move || {
        let key = email.trim().to_lowercase();
        let folder = folder_id.trim().to_string();
        let since = since.unwrap_or_default();
        let cached = store::load_folder_headers(&key, &folder)?;
        let done = BackfillResult { added: 0, have: cached.len(), total: cached.len(), remaining: 0 };
        if key.is_empty() || folder.is_empty() || !auth::is_google(&key) {
            return Ok(done);
        }
        let have: std::collections::BTreeSet<String> = cached.iter().map(|m| m.id.clone()).collect();
        let (messages, remaining, total) = google::backfill(&key, &folder, since.trim(), &have)?;
        if !messages.is_empty() {
            store::upsert_folder_messages(&key, &folder, &messages)?;
            store::refresh_folder_counts(&key, &folder)?;
        }
        let have = store::load_folder_headers(&key, &folder)?.len();
        google::log(&format!("gmail backfill {folder}: +{} ({have} of {total}, {remaining} to go)", messages.len()));
        Ok(BackfillResult { added: messages.len(), have, total, remaining })
    })
    .await
}

#[cfg(test)]
fn text_from_body(value: &serde_json::Value, keys: &[&str]) -> String {
    for key in keys {
        let Some(text) = value.get(*key).and_then(|item| item.as_str()) else {
            continue;
        };
        let text = text.trim();
        if !text.is_empty() {
            return text.to_string();
        }
    }
    String::new()
}

#[cfg(test)]
fn folder_id_from_body(value: &serde_json::Value) -> String {
    text_from_body(value, &["folderId", "folder_id"])
}

#[cfg(test)]
fn message_id_from_body(value: &serde_json::Value) -> String {
    text_from_body(value, &["messageId", "message_id"])
}

#[cfg(test)]
fn file_id_from_body(value: &serde_json::Value) -> String {
    text_from_body(value, &["fileId", "file_id"])
}

#[tauri::command]
async fn cached_folder(
    email: Option<String>,
    box_key: Option<String>,
    include_body: Option<bool>,
    limit: Option<i64>,
    before: Option<String>,
    before_id: Option<String>,
) -> Result<store::MessagePage, String> {
    in_background(move || {
        let email = email.unwrap_or_default();
        let box_key = box_key.unwrap_or_default();
        if email.trim().is_empty() || box_key.trim().is_empty() {
            return Ok(store::MessagePage { messages: Vec::new(), more: false });
        }
        // No limit is the whole folder. Drafts still read every header. Search uses search_cached.
        store::load_box_page(
            email.trim(),
            box_key.trim(),
            include_body.unwrap_or(false),
            limit.unwrap_or(0),
            before.as_deref().unwrap_or("").trim(),
            before_id.as_deref().unwrap_or("").trim(),
        )
    })
    .await
}

#[tauri::command]
async fn cached_body(email: Option<String>, message_id: Option<String>) -> Result<String, String> {
    in_background(move || {
        let email = email.unwrap_or_default();
        let message_id = message_id.unwrap_or_default();
        let cached = store::load_message_body(&email, &message_id)?;
        if !cached.trim().is_empty() {
            return Ok(cached);
        }
        // A folder fill and a header-only delta store mail without a body.
        // Fill it when the letter opens. An empty body is saved so the next
        // open does not ask again. A network failure leaves the row empty so
        // the page retries.
        if email.trim().is_empty() || message_id.trim().is_empty() {
            return Ok(cached);
        }
        let fetched = if auth::is_google(email.trim()) {
            google::message_html(email.trim(), message_id.trim())
        } else {
            let token = auth::access_token_for(email.trim())?;
            graph::fetch_message_body(&token, message_id.trim())
        };
        match fetched {
            Ok(html) => {
                let stored = if html.trim().is_empty() { "<p></p>".to_string() } else { html };
                let _ = store::save_message_body(email.trim(), message_id.trim(), &stored);
                Ok(stored)
            }
            Err(err) => {
                if !cached.is_empty() {
                    Ok(cached)
                } else {
                    Err(err)
                }
            }
        }
    })
    .await
}

fn omit_message_bodies(messages: &mut [LiveMessage]) {
    for message in messages {
        message.body_html.clear();
    }
}

#[tauri::command]
async fn sync_folder(folder_id: Option<String>, email: Option<String>, since: Option<String>) -> Result<FolderDelta, String> {
    in_background(move || {
        let status = auth::account_status();
        if !status.signed_in {
            return Err("Accounts are not signed in.".into());
        }
        let folder_id = folder_id.unwrap_or_default();
        let email = email.unwrap_or_default();
        let since = since.unwrap_or_default();
        if folder_id.is_empty() {
            return Err("Choose a folder.".into());
        }
        let key = if email.trim().is_empty() {
            status.email.trim().to_lowercase()
        } else {
            email.trim().to_lowercase()
        };
        if key.is_empty() {
            return Err("Accounts are not signed in.".into());
        }
        let folder_id = folder_id.trim();
        let state = store::folder_sync_state(&key, folder_id)?;
        if state.messages > 0 || state.delta_link.is_some() {
            let catchup = catch_up_folder(&key, folder_id, since.trim())?;
            return list_delta(&key, folder_id, catchup);
        }
        let mut messages = if auth::is_google(&key) {
            google::fetch_folder_first(&key, &folder_id, since.trim())?
        } else {
            graph::fetch_folder(email.trim(), folder_id, since.trim())?
        };
        store::replace_folder_messages(&key, folder_id, &messages)?;
        anchor_folder(&key, folder_id, since.trim());
        match store::load_folder_page(&key, folder_id, false, LIST_PAGE, "", "") {
            Ok(page) => Ok(FolderDelta { messages: page.messages, removed: Vec::new(), merged: false, more: page.more }),
            Err(_) => {
                omit_message_bodies(&mut messages);
                let more = newest_page(&mut messages);
                Ok(FolderDelta { messages, removed: Vec::new(), merged: false, more })
            }
        }
    })
    .await
}

#[tauri::command]
async fn unsubscribe_options(email: String, message_id: String) -> Result<unsubscribe::Options, String> {
    in_background(move || unsubscribe::options(email.trim(), &message_id)).await
}

#[tauri::command]
async fn unsubscribe(email: String, message_id: String) -> Result<unsubscribe::Outcome, String> {
    in_background(move || unsubscribe::unsubscribe(email.trim(), &message_id)).await
}

#[tauri::command]
async fn check_spelling(text: String, ignore: Option<Vec<String>>) -> Result<Vec<spell::Misspelt>, String> {
    if text.len() > 400_000 {
        return Ok(Vec::new());
    }
    in_background(move || Ok(spell::check(&text, &ignore.unwrap_or_default()))).await
}

#[tauri::command]
fn spelling() -> spell::Spelling {
    spell::status()
}

#[tauri::command]
fn set_spelling(app: tauri::AppHandle, enabled: bool, languages: Vec<String>) -> spell::Spelling {
    spell::set(&app, enabled, languages)
}

#[tauri::command]
async fn conversation_mail(email: Option<String>, conversation_id: Option<String>) -> Result<MailSearchPage, String> {
    in_background(move || {
        let email = email.unwrap_or_default();
        if email.trim().is_empty() {
            return Err("Accounts are not signed in.".into());
        }
        if auth::is_google(email.trim()) {
            return google::conversation_mail(email.trim(), &conversation_id.unwrap_or_default());
        }
        graph::conversation_mail(email.trim(), &conversation_id.unwrap_or_default())
    })
    .await
}

#[tauri::command]
async fn search_mail(
    email: Option<String>,
    query: Option<String>,
    folder_id: Option<String>,
    from: Option<String>,
    to: Option<String>,
    files: Option<String>,
    next_link: Option<String>,
) -> Result<MailSearchPage, String> {
    in_background(move || {
        let status = auth::account_status();
        if !status.signed_in {
            return Err("Accounts are not signed in.".into());
        }
        let email = email.unwrap_or_default();
        let query = query.unwrap_or_default();
        let folder_id = folder_id.unwrap_or_default();
        let from = from.unwrap_or_default();
        let to = to.unwrap_or_default();
        let files = files.unwrap_or_default();
        let next_link = next_link.unwrap_or_default();
        let mailbox = if email.trim().is_empty() {
            status.email.trim()
        } else {
            email.trim()
        };
        if auth::is_google(mailbox) {
            return google::search_mail(mailbox, &folder_id, &query, &from, &to, &files, &next_link);
        }
        graph::search_mail(mailbox, &folder_id, &query, &from, &to, &files, &next_link)
    })
    .await
}

/// One page of cached headers. The page searches each account and merges.
#[tauri::command]
async fn search_cached(
    email: Option<String>,
    box_key: Option<String>,
    words: Option<Vec<String>>,
    phrases: Option<Vec<String>>,
    account_name: Option<String>,
    from_day: Option<String>,
    to_day: Option<String>,
    zone_offset: Option<i64>,
    files: Option<String>,
    unread_only: Option<bool>,
    read_only: Option<bool>,
    flagged_only: Option<bool>,
    invite_only: Option<bool>,
    limit: Option<i64>,
    before: Option<String>,
    before_id: Option<String>,
) -> Result<store::CachedSearchPage, String> {
    in_background(move || {
        store::search_cached(
            &email.unwrap_or_default(),
            &box_key.unwrap_or_default(),
            &words.unwrap_or_default(),
            &phrases.unwrap_or_default(),
            &account_name.unwrap_or_default(),
            &from_day.unwrap_or_default(),
            &to_day.unwrap_or_default(),
            zone_offset.unwrap_or(0),
            &files.unwrap_or_default(),
            unread_only.unwrap_or(false),
            read_only.unwrap_or(false),
            flagged_only.unwrap_or(false),
            invite_only.unwrap_or(false),
            limit.unwrap_or(100),
            &before.unwrap_or_default(),
            &before_id.unwrap_or_default(),
        )
    })
    .await
}

#[tauri::command]
async fn message_files(message_id: Option<String>, email: Option<String>) -> Result<Vec<LiveFile>, String> {
    in_background(move || {
        let status = auth::account_status();
        if !status.signed_in {
            return Err("Accounts are not signed in.".into());
        }
        let message_id = message_id.unwrap_or_default();
        let email = email.unwrap_or_default();
        if message_id.is_empty() {
            return Err("Choose a message.".into());
        }
        let mailbox = if email.trim().is_empty() {
            status.email.trim().to_string()
        } else {
            email.trim().to_string()
        };
        let files = if auth::is_google(mailbox.trim()) {
            google::list_attachments(mailbox.trim(), &message_id)?
        } else {
            graph::list_attachments(mailbox.trim(), &message_id)?
        };
        if !mailbox.trim().is_empty() {
            let _ = store::save_message_files(&mailbox.trim().to_lowercase(), &message_id, &files);
        }
        Ok(files)
    })
    .await
}

#[tauri::command]
async fn open_attachment(
    message_id: Option<String>,
    file_id: Option<String>,
    name: Option<String>,
    email: Option<String>,
) -> Result<(), String> {
    in_background(move || {
        let status = auth::account_status();
        if !status.signed_in {
            return Err("Accounts are not signed in.".into());
        }
        let message_id = message_id.unwrap_or_default();
        let file_id = file_id.unwrap_or_default();
        let name = name.unwrap_or_default();
        let email = email.unwrap_or_default();
        if message_id.is_empty() || file_id.is_empty() {
            return Err("Choose a file.".into());
        }
        let mailbox = if email.trim().is_empty() {
            status.email.trim()
        } else {
            email.trim()
        };
        if auth::is_google(mailbox) {
            return google::open_attachment(mailbox, &message_id, &file_id, &name);
        }
        graph::open_attachment(mailbox, &message_id, &file_id, &name)
    })
    .await
}

#[tauri::command]
async fn open_link(url: String) -> Result<(), String> {
    in_background(move || graph::open_link(&url)).await
}

/// Print (2026-11-09): the page puts one message in #print-sheet, which
/// only print styles show, and the webview's own dialog prints it or
/// saves it as a PDF.
#[tauri::command]
async fn print_page(webview: tauri::Webview) -> Result<(), String> {
    webview.print().map_err(|err| format!("Could not print: {err}"))
}

#[derive(Deserialize)]
struct NamedFile {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
}

/// The folder picker belongs to the Mailroom window that asked for it. With
/// no parent, GTK's own chooser came up as an ordinary window that Hyprland
/// tiled beside Mailroom, squeezed (2026-11-11). A child of Mailroom's
/// window floats, centred over it, as Omarchy's own dialogs do.
#[cfg(target_os = "linux")]
fn show_folder_picker(parent: Option<&gtk::ApplicationWindow>) -> Result<Option<String>, String> {
    use gtk::prelude::*;
    if !gtk::is_initialized() {
        gtk::init().map_err(|_| "The folder picker could not be opened.".to_string())?;
    }
    let dialog = gtk::FileChooserNative::new(
        Some("Save attachments"),
        parent,
        gtk::FileChooserAction::SelectFolder,
        Some("Select"),
        Some("Cancel"),
    );
    dialog.set_modal(true);
    let response = dialog.run();
    let chosen = if response == gtk::ResponseType::Accept {
        dialog.filename().map(|path| path.to_string_lossy().into_owned())
    } else {
        None
    };
    dialog.destroy();
    Ok(chosen)
}

#[cfg(not(target_os = "linux"))]
fn show_folder_picker(_parent: Option<&()>) -> Result<Option<String>, String> {
    Err("The folder picker could not be opened.".into())
}

#[tauri::command]
async fn pick_download_folder(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    in_background(move || {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        app.run_on_main_thread(move || {
            #[cfg(target_os = "linux")]
            let parent = window.gtk_window().ok();
            #[cfg(target_os = "linux")]
            let _ = tx.send(show_folder_picker(parent.as_ref()));
            #[cfg(not(target_os = "linux"))]
            let _ = (window, tx.send(show_folder_picker(None)));
        })
        .map_err(|_| "The folder picker could not be opened.".to_string())?;
        let chosen = rx
            .recv()
            .unwrap_or_else(|_| Err("The folder picker could not be opened.".into()))?;
        remember_picked_folder(&chosen);
        Ok(chosen)
    })
    .await
}

/// A picture from a message, as the page holds it (base64), if it really
/// is one: only raster pictures, known by their first bytes, and not huge.
fn picture_bytes(data: &str) -> Result<(Vec<u8>, &'static str), String> {
    use base64::Engine;
    if data.len() > 48 * 1024 * 1024 {
        return Err("That picture is too large.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| "That picture could not be read.".to_string())?;
    let kind = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "image/gif"
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.starts_with(b"BM") {
        "image/bmp"
    } else {
        return Err("That isn't a picture Mailroom can save.".into());
    };
    Ok((bytes, kind))
}

/// Save a picture from a message into the folder just picked
/// (pick_download_folder); never over an existing file.
#[tauri::command]
async fn save_picture(directory: String, name: String, data: String) -> Result<String, String> {
    in_background(move || {
        let directory = take_picked_folder(&directory)?;
        let (bytes, kind) = picture_bytes(&data)?;
        let ext = match kind {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            _ => "bmp",
        };
        let base = graph::safe_file_name(name.trim());
        let stem = base.rsplit_once('.').map(|(s, _)| s).unwrap_or(&base);
        let stem = if stem.trim().is_empty() { "picture" } else { stem };
        let path = graph::write_download(&directory, &format!("{stem}.{ext}"), &bytes)?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
}

/// Copy a picture from a message to the clipboard, through wl-copy.
#[tauri::command]
async fn copy_picture(data: String) -> Result<(), String> {
    in_background(move || {
        use std::io::Write;
        let (bytes, kind) = picture_bytes(&data)?;
        let mut child = std::process::Command::new("wl-copy")
            .args(["--type", kind])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|_| "The picture could not be copied (wl-copy is missing).".to_string())?;
        child
            .stdin
            .take()
            .ok_or_else(|| "The picture could not be copied.".to_string())?
            .write_all(&bytes)
            .map_err(|_| "The picture could not be copied.".to_string())?;
        // wl-copy stays behind to serve the clipboard; don't wait for it.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    })
    .await
}

#[tauri::command]
async fn save_attachments(
    message_id: Option<String>,
    email: Option<String>,
    directory: Option<String>,
    files: Option<Vec<NamedFile>>,
) -> Result<usize, String> {
    in_background(move || {
        let status = auth::account_status();
        if !status.signed_in {
            return Err("Accounts are not signed in.".into());
        }
        let message_id = message_id.unwrap_or_default();
        let email = email.unwrap_or_default();
        let directory = directory.unwrap_or_default();
        let files: Vec<(String, String)> = files
            .unwrap_or_default()
            .into_iter()
            .map(|file| (file.id, file.name))
            .collect();
        if message_id.is_empty() {
            return Err("Choose a message.".into());
        }
        let directory = take_picked_folder(&directory)?;
        let mailbox = if email.trim().is_empty() {
            status.email.trim()
        } else {
            email.trim()
        };
        if auth::is_google(mailbox) {
            return google::save_attachments(mailbox, &message_id, &files, &directory.to_string_lossy());
        }
        graph::save_attachments(mailbox, &message_id, &files, &directory.to_string_lossy())
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn send_mail(
    email: String,
    subject: String,
    body_html: String,
    to: String,
    cc: String,
    bcc: String,
    draft_id: Option<String>,
    reply_to: Option<String>,
    mode: Option<String>,
    keep_files: Option<Vec<String>>,
    files: Option<Vec<attach::StagedRef>>,
    send_at: Option<String>,
    importance: Option<String>,
    read_receipt: Option<bool>,
    from_address: Option<String>,
) -> Result<(), String> {
    in_background(move || {
        let send = if auth::is_google(email.trim()) { google::send } else { compose::send };
        send(
            email.trim(),
            &graph::OutgoingMail {
                subject,
                body_html,
                to,
                cc,
                bcc,
                importance: importance.unwrap_or_default(),
                read_receipt: read_receipt.unwrap_or(false),
                from_address: from_address.unwrap_or_default(),
            },
            draft_id.as_deref().unwrap_or(""),
            reply_to.as_deref().unwrap_or(""),
            compose::Mode::parse(mode.as_deref().unwrap_or("")),
            keep_files.as_deref(),
            files.as_deref().unwrap_or(&[]),
            send_at.as_deref().unwrap_or(""),
        )
    })
    .await
}

#[tauri::command]
async fn save_event(
    email: String,
    event_id: Option<String>,
    calendar_id: Option<String>,
    fields: calendar::EventFields,
) -> Result<String, String> {
    in_background(move || {
        let save = if auth::is_google(email.trim()) { gcal::save_event } else { calendar::save_event };
        save(
            email.trim(),
            event_id.as_deref().unwrap_or(""),
            calendar_id.as_deref().unwrap_or(""),
            &fields,
        )
    })
    .await
}

#[tauri::command]
async fn remove_event(email: String, event_id: String, how: String) -> Result<(), String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return gcal::remove_event(email.trim(), &event_id, &how);
        }
        calendar::remove_event(email.trim(), &event_id, &how)
    })
    .await
}

#[tauri::command]
async fn event_series(email: String, master_id: String) -> Result<calendar::Series, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return gcal::series(email.trim(), &master_id);
        }
        calendar::series(email.trim(), &master_id)
    })
    .await
}

#[tauri::command]
async fn end_series_before(email: String, master_id: String, date: String) -> Result<bool, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return gcal::end_series_before(email.trim(), &master_id, &date);
        }
        calendar::end_series_before(email.trim(), &master_id, &date)
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn update_contact(
    email: String,
    contact_id: String,
    name: String,
    address: String,
    phone: String,
    title: String,
    company: String,
) -> Result<LiveContact, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Err(not_for_google("Contacts"));
        }
        graph::update_contact(email.trim(), &contact_id, &name, &address, &phone, &title, &company)
    })
    .await
}

#[tauri::command]
async fn delete_contact(email: String, contact_id: String) -> Result<(), String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Err(not_for_google("Contacts"));
        }
        graph::delete_contact(email.trim(), &contact_id)
    })
    .await
}

#[tauri::command]
async fn mark_folder_read(email: String, folder_id: String) -> Result<usize, String> {
    in_background(move || {
        let count = if auth::is_google(email.trim()) {
            google::mark_folder_read(email.trim(), &folder_id)?
        } else {
            folders::mark_folder_read(email.trim(), &folder_id)?
        };
        let _ = store::folder_changed(&email, &folder_id, false);
        Ok(count)
    })
    .await
}

#[tauri::command]
async fn empty_folder(email: String, folder_id: String) -> Result<usize, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Err("Gmail empties Trash and Spam by itself after 30 days.".into());
        }
        let count = folders::empty_folder(email.trim(), &folder_id)?;
        let _ = store::folder_changed(&email, &folder_id, true);
        Ok(count)
    })
    .await
}

#[tauri::command]
async fn mail_categories(email: String) -> Result<Vec<mailbox::Category>, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Ok(Vec::new());
        }
        mailbox::categories(email.trim())
    })
    .await
}

#[tauri::command]
async fn set_categories(email: String, message_ids: Vec<String>, categories: Vec<String>) -> Result<(), String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Err(not_for_google("Categories"));
        }
        mailbox::set_categories(email.trim(), &message_ids, &categories)?;
        let _ = store::set_categories(&email, &message_ids, &categories);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn mail_aliases(email: String) -> Result<Vec<String>, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Ok(Vec::new());
        }
        graph::aliases(email.trim())
    })
    .await
}

#[tauri::command]
async fn list_search_folders(email: String) -> Result<Vec<graph::SearchFolder>, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Ok(Vec::new());
        }
        graph::list_search_folders(email.trim())
    })
    .await
}

#[tauri::command]
async fn save_search_folder(
    email: String,
    name: String,
    query: String,
    source_ids: Vec<String>,
) -> Result<graph::SearchFolder, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Err(not_for_google("Search folders"));
        }
        graph::create_search_folder(email.trim(), &name, &query, &source_ids)
    })
    .await
}

#[tauri::command]
async fn delete_search_folder(email: String, folder_id: String) -> Result<(), String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Err(not_for_google("Search folders"));
        }
        graph::delete_search_folder(email.trim(), &folder_id)
    })
    .await
}

#[tauri::command]
async fn mailbox_zone(email: String) -> Result<String, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Err(not_for_google("The mailbox time zone"));
        }
        mailbox::read_zone(email.trim())
    })
    .await
}

#[tauri::command]
async fn set_mailbox_zone(email: String, zone: String) -> Result<(), String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Err(not_for_google("The mailbox time zone"));
        }
        mailbox::write_zone(email.trim(), &zone)
    })
    .await
}

#[tauri::command]
async fn auto_reply(email: String) -> Result<mailbox::AutoReply, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Err(not_for_google("Automatic replies"));
        }
        mailbox::auto_reply(email.trim())
    })
    .await
}

#[tauri::command]
async fn set_auto_reply(email: String, reply: mailbox::AutoReply) -> Result<(), String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Err(not_for_google("Automatic replies"));
        }
        mailbox::set_auto_reply(email.trim(), &reply)
    })
    .await
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<software::UpdateStatus, String> {
    let current = app.package_info().version.to_string();
    in_background(move || software::check(&current)).await
}

/// Settings > Software > What's new: this copy's latest changes.
#[tauri::command]
async fn whats_new() -> Result<Vec<software::Change>, String> {
    in_background(|| software::whats_new(30)).await
}

#[tauri::command]
async fn run_update() -> Result<(), String> {
    in_background(software::update).await
}

#[tauri::command]
async fn update_progress() -> Result<software::UpdateProgress, String> {
    in_background(|| Ok(software::progress())).await
}

#[tauri::command]
async fn update_log() -> Result<String, String> {
    in_background(|| Ok(software::update_log())).await
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    software::restart(&app)
}

#[tauri::command]
async fn mail_rules(email: String) -> Result<Vec<mailbox::Rule>, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Ok(Vec::new());
        }
        mailbox::rules(email.trim())
    })
    .await
}

#[tauri::command]
async fn save_rule(email: String, rule: mailbox::Rule) -> Result<mailbox::Rule, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Err(not_for_google("Rules"));
        }
        mailbox::save_rule(email.trim(), &rule)
    })
    .await
}

#[tauri::command]
async fn delete_rule(email: String, id: String) -> Result<(), String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Err(not_for_google("Rules"));
        }
        mailbox::delete_rule(email.trim(), &id)
    })
    .await
}

#[tauri::command]
async fn people(email: String, query: Option<String>) -> Result<Vec<mailbox::Person>, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Ok(Vec::new());
        }
        mailbox::people(email.trim(), query.as_deref().unwrap_or(""))
    })
    .await
}

#[tauri::command]
async fn ensure_folder(email: String, name: String) -> Result<String, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return google::ensure_folder(email.trim(), &name);
        }
        mailbox::ensure_folder(email.trim(), &name)
    })
    .await
}

/// Keep a picked file until its message is sent. The page gets an id back.
#[tauri::command]
async fn stage_file(data: String) -> Result<attach::Staged, String> {
    in_background(move || attach::stage(&data)).await
}

/// The page calls this after a quit has finished writing open drafts.
#[tauri::command]
fn finish_quit(app: tauri::AppHandle) {
    app.exit(QUIT_CODE.load(Ordering::SeqCst));
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn save_draft(
    email: String,
    subject: String,
    body_html: String,
    to: String,
    cc: String,
    bcc: String,
    draft_id: Option<String>,
    reply_to: Option<String>,
    mode: Option<String>,
    importance: Option<String>,
    read_receipt: Option<bool>,
    from_address: Option<String>,
) -> Result<String, String> {
    in_background(move || {
        let save = if auth::is_google(email.trim()) { google::save_draft } else { compose::save_draft };
        save(
            email.trim(),
            draft_id.as_deref().unwrap_or(""),
            reply_to.as_deref().unwrap_or(""),
            compose::Mode::parse(mode.as_deref().unwrap_or("")),
            &graph::OutgoingMail {
                subject,
                body_html,
                to,
                cc,
                bcc,
                importance: importance.unwrap_or_default(),
                read_receipt: read_receipt.unwrap_or(false),
                from_address: from_address.unwrap_or_default(),
            },
        )
    })
    .await
}

#[tauri::command]
async fn discard_draft(email: String, draft_id: String) -> Result<(), String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return google::discard_draft(email.trim(), &draft_id);
        }
        compose::discard_draft(email.trim(), &draft_id)
    })
    .await
}

#[tauri::command]
async fn message_invite(email: String, message_id: String) -> Result<Option<compose::Invite>, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return gcal::invite_for(email.trim(), &message_id);
        }
        compose::invite_for(email.trim(), &message_id)
    })
    .await
}

#[tauri::command]
async fn respond_invite(email: String, event_id: String, response: String, comment: Option<String>) -> Result<(), String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            if gcal::is_pending(&event_id) {
                return gcal::respond_pending(email.trim(), &event_id, &response);
            }
            return gcal::respond(email.trim(), &event_id, &response);
        }
        compose::respond(email.trim(), &event_id, &response, comment.as_deref().unwrap_or(""))
    })
    .await
}

#[tauri::command]
async fn notify_mail(app: tauri::AppHandle, title: String, body: String, message_id: Option<String>) -> Result<(), String> {
    in_background(move || notify::new_mail(app, &title, &body, message_id.as_deref().unwrap_or(""))).await
}

#[tauri::command]
async fn apply_mail(
    kind: String,
    message_ids: Vec<String>,
    email: Option<String>,
    destination: Option<String>,
    source: Option<String>,
) -> Result<Vec<graph::MovedId>, String> {
    in_background(move || {
        let status = auth::account_status();
        if !status.signed_in {
            return Err("Accounts are not signed in.".into());
        }
        let requested = email.unwrap_or_default();
        let destination = destination.unwrap_or_default();
        let moved = if auth::is_google(requested.trim()) {
            // A Gmail move takes the label of the folder the mail was in.
            google::apply_mail(requested.trim(), &kind, &message_ids, &destination, source.as_deref().unwrap_or(""))?
        } else {
            graph::apply_mail(requested.trim(), &kind, &message_ids, &destination)?
        };
        let email = if requested.trim().is_empty() {
            status.email.trim().to_lowercase()
        } else {
            requested.trim().to_lowercase()
        };
        if !email.is_empty() {
            if kind == "move" {
                store::record_move(&email, &destination, &message_ids)?;
            } else {
                store::record_mail_action(&email, &kind, &message_ids)?;
            }
            store::rename_moved(&email, &moved)?;
        }
        Ok(moved)
    })
    .await
}

fn compose_window_query(raw: &str) -> Result<String, String> {
    let raw = raw.trim().trim_start_matches('?');
    if raw.is_empty()
        || raw.len() > 512
        || raw.contains("://")
        || raw.contains("..")
        || raw.contains('\\')
        || raw.contains('\0')
    {
        return Err("That compose window is not available.".into());
    }
    let mut compose = None;
    let mut msg = None;
    let mut stamp = None;
    for part in raw.split('&') {
        if part.is_empty() {
            continue;
        }
        let (key, value) = part.split_once('=').unwrap_or((part, ""));
        match key {
            "compose" if compose.is_none() && (value == "new" || value == "reply") => {
                compose = Some(value.to_string());
            }
            "msg" if msg.is_none() => {
                let decoded = percent_decode_token(value)?;
                if !valid_msg_token(&decoded) {
                    return Err("That compose window is not available.".into());
                }
                msg = Some(percent_encode_token(&decoded));
            }
            "d"
                if stamp.is_none()
                    && !value.is_empty()
                    && value.len() <= 20
                    && value.bytes().all(|byte| byte.is_ascii_digit()) =>
            {
                stamp = Some(value.to_string());
            }
            _ => return Err("That compose window is not available.".into()),
        }
    }
    let Some(compose) = compose else {
        return Err("That compose window is not available.".into());
    };
    let mut out = format!("compose={compose}");
    if let Some(msg) = msg {
        out.push_str("&msg=");
        out.push_str(&msg);
    }
    if let Some(stamp) = stamp {
        out.push_str("&d=");
        out.push_str(&stamp);
    }
    Ok(out)
}

fn valid_msg_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 180
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '+' | '/' | '='))
}

fn percent_decode_token(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut out = String::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("That compose window is not available.".into());
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                .map_err(|_| "That compose window is not available.".to_string())?;
            let byte = u8::from_str_radix(hex, 16)
                .map_err(|_| "That compose window is not available.".to_string())?;
            if !byte.is_ascii() || byte.is_ascii_control() {
                return Err("That compose window is not available.".into());
            }
            out.push(byte as char);
            index += 3;
        } else {
            out.push(bytes[index] as char);
            index += 1;
        }
    }
    Ok(out)
}

fn percent_encode_token(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn assist_window_query(raw: &str) -> Result<String, String> {
    let raw = raw.trim().trim_start_matches('?');
    if raw.is_empty()
        || raw.len() > 128
        || raw.contains("://")
        || raw.contains("..")
        || raw.contains('\\')
        || raw.contains('\0')
    {
        return Err("That assistant window is not available.".into());
    }
    let mut assist = false;
    let mut owner = None;
    let mut stamp = None;
    for part in raw.split('&') {
        if part.is_empty() {
            continue;
        }
        let (key, value) = part.split_once('=').unwrap_or((part, ""));
        match key {
            "assist" if !assist && value == "1" => assist = true,
            "owner" if owner.is_none() && (value == "main" || value == "compose") => owner = Some(value),
            "d"
                if stamp.is_none()
                    && !value.is_empty()
                    && value.len() <= 20
                    && value.bytes().all(|byte| byte.is_ascii_digit()) =>
            {
                stamp = Some(value);
            }
            _ => return Err("That assistant window is not available.".into()),
        }
    }
    let Some(owner) = owner else {
        return Err("That assistant window is not available.".into());
    };
    if !assist {
        return Err("That assistant window is not available.".into());
    }
    let mut out = format!("assist=1&owner={owner}");
    if let Some(stamp) = stamp {
        out.push_str("&d=");
        out.push_str(stamp);
    }
    Ok(out)
}

fn compose_page(current: &tauri::Url, query: &str) -> tauri::Url {
    let mut next = current.clone();
    if next.path() == "/" || next.path().is_empty() {
        next.set_path("/index.html");
    }
    next.set_query(Some(query));
    next
}

#[tauri::command(async)]
async fn pop_compose(app: tauri::AppHandle, query: String) -> Result<(), String> {
    let query = compose_window_query(&query)?;
    if let Some(window) = app.get_webview_window("compose") {
        let current = window.url().map_err(|err| err.to_string())?;
        window
            .navigate(compose_page(&current, &query))
            .map_err(|err| err.to_string())?;
        let _ = window.unminimize();
        window.show().map_err(|err| err.to_string())?;
        window.set_focus().map_err(|err| err.to_string())?;
        return Ok(());
    }
    let url = tauri::WebviewUrl::App(format!("index.html?{query}").into());
    let on_omarchy = omarchy::detected();
    let mut builder = tauri::WebviewWindowBuilder::new(&app, "compose", url)
        .title(if on_omarchy { "New message" } else { "Mailroom" })
        .decorations(!on_omarchy)
        .inner_size(760.0, 740.0);
    // A child of Mailroom's window floats over it, centred, instead of being
    // tiled beside it. From the "New email" shortcut with Mailroom hidden in
    // the tray, it is a window of its own.
    if let Some(main) = app.get_webview_window("main") {
        if main.is_visible().unwrap_or(false) {
            builder = builder.parent(&main).map_err(|err| err.to_string())?;
        }
    }
    let window = builder.build().map_err(|err| err.to_string())?;
    spell::apply(&window);
    Ok(())
}

#[tauri::command(async)]
async fn pop_assist(app: tauri::AppHandle, query: String) -> Result<(), String> {
    let query = assist_window_query(&query)?;
    if let Some(window) = app.get_webview_window("assist") {
        let current = window.url().map_err(|err| err.to_string())?;
        window
            .navigate(compose_page(&current, &query))
            .map_err(|err| err.to_string())?;
        let _ = window.unminimize();
        window.show().map_err(|err| err.to_string())?;
        window.set_focus().map_err(|err| err.to_string())?;
        return Ok(());
    }
    let url = tauri::WebviewUrl::App(format!("index.html?{query}").into());
    let on_omarchy = omarchy::detected();
    let window = tauri::WebviewWindowBuilder::new(&app, "assist", url)
        .title(if on_omarchy { "Assistant" } else { "Mailroom" })
        .decorations(!on_omarchy)
        .inner_size(420.0, 720.0)
        .build()
        .map_err(|err| err.to_string())?;
    spell::apply(&window);
    Ok(())
}

/// The Omarchy theme, font and corners, or null when this is not Omarchy.
#[tauri::command]
async fn omarchy_look() -> Result<Option<omarchy::Look>, String> {
    in_background(|| Ok(omarchy::look())).await
}

#[tauri::command]
async fn mail_app_status() -> Result<omarchy::MailAppStatus, String> {
    in_background(|| Ok(omarchy::mail_app_status())).await
}

#[tauri::command]
async fn make_mail_app() -> Result<omarchy::MailAppStatus, String> {
    in_background(omarchy::make_mail_app).await
}

#[tauri::command]
async fn stop_mail_app() -> Result<omarchy::MailAppStatus, String> {
    in_background(omarchy::stop_mail_app).await
}

#[tauri::command]
async fn add_bar_widget() -> Result<omarchy::MailAppStatus, String> {
    in_background(omarchy::add_bar_widget).await
}

#[tauri::command]
async fn remove_bar_widget() -> Result<omarchy::MailAppStatus, String> {
    in_background(omarchy::remove_bar_widget).await
}

/// The unread count for the Omarchy bar widget. Does nothing elsewhere.
#[tauri::command]
async fn report_unread(count: u32) -> Result<(), String> {
    in_background(move || omarchy::report_unread(count)).await
}

/// What Mailroom was started with (a mailto: link, --compose), taken once.
#[tauri::command]
fn take_launch_request() -> Option<launch::Request> {
    launch::take()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CalendarResult {
    calendars: Vec<LiveCalendar>,
    events: Vec<LiveEvent>,
}

#[tauri::command]
async fn sync_calendar(email: Option<String>, start: String, end: String) -> Result<CalendarResult, String> {
    in_background(move || {
        let email = email.unwrap_or_default();
        let (calendars, events) = if auth::is_google(email.trim()) {
            gcal::fetch_calendar(email.trim(), start.trim(), end.trim())?
        } else {
            graph::fetch_calendar(email.trim(), start.trim(), end.trim())?
        };
        Ok(CalendarResult { calendars, events })
    })
    .await
}

#[tauri::command]
async fn sync_contacts(email: Option<String>) -> Result<Vec<LiveContact>, String> {
    in_background(move || {
        let email = email.unwrap_or_default();
        if auth::is_google(email.trim()) {
            return Ok(Vec::new());
        }
        graph::fetch_contacts(email.trim())
    })
    .await
}

#[tauri::command]
async fn create_contact(
    email: String,
    name: String,
    address: String,
    phone: String,
    title: String,
    company: String,
) -> Result<LiveContact, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Err(not_for_google("Contacts"));
        }
        graph::create_contact(email.trim(), &name, &address, &phone, &title, &company)
    })
    .await
}

#[tauri::command]
async fn ai_status() -> Result<ai::AiStatus, String> {
    in_background(|| Ok(ai::status())).await
}

#[tauri::command]
async fn save_ai_key(provider: String, key: String) -> Result<ai::AiStatus, String> {
    in_background(move || {
        ai::save_key(&provider, &key)?;
        Ok(ai::status())
    })
    .await
}

#[tauri::command]
async fn clear_ai_key(provider: String) -> Result<ai::AiStatus, String> {
    in_background(move || {
        ai::clear_key(&provider)?;
        Ok(ai::status())
    })
    .await
}

#[tauri::command]
async fn ask_mail(provider: String, question: String, messages: Vec<ai::MailNote>, omitted: Option<usize>) -> Result<ai::AiText, String> {
    in_background(move || ai::ask(&provider, &question, &messages, omitted.unwrap_or(0))).await
}

// A message's inline images, as data URLs by content id (inline.rs).
#[tauri::command]
async fn inline_images(email: String, message_id: String) -> Result<Vec<inline::InlineImage>, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return google::inline_images(email.trim(), &message_id);
        }
        inline::inline_images(email.trim(), &message_id)
    })
    .await
}

// A mail picture the webview refused, fetched by the app (remoteimg.rs).
/// Whether a message's provider vouched for its sender (see senderauth).
#[tauri::command]
async fn sender_verified(email: String, message_id: String, from: String) -> Result<bool, String> {
    in_background(move || senderauth::verified(email.trim(), &message_id, &from)).await
}

#[tauri::command]
async fn remote_image(url: String) -> Result<String, String> {
    in_background(move || remoteimg::fetch(&url)).await
}

// Focused Inbox: move messages, and maybe their sender, to Focused or Other.
#[tauri::command]
async fn set_focus(email: String, message_ids: Vec<String>, focus: String, always_sender: Option<String>) -> Result<(), String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Err("Gmail sorts Focused and Other by its own inbox tabs. Change them in Gmail.".into());
        }
        mailbox::set_focus(email.trim(), &message_ids, &focus, &always_sender.unwrap_or_default())
    })
    .await
}

// Who is free when, for the meeting editor (calendar.rs).
#[tauri::command]
async fn free_busy(email: String, people: Vec<String>, start: String, end: String) -> Result<Vec<calendar::FreeBusy>, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return Err(not_for_google("Seeing who's free"));
        }
        calendar::free_busy(email.trim(), &people, &start, &end)
    })
    .await
}

// Messages the server says are gone: out of the cache too (store.rs).
#[tauri::command]
async fn forget_mail(email: String, message_ids: Vec<String>) -> Result<(), String> {
    in_background(move || store::forget_messages(email.trim(), &message_ids)).await
}

// An attachment for the in-app viewer: a PDF or a picture (inline.rs).
#[tauri::command]
async fn attachment_preview(email: String, message_id: String, file_id: String, name: Option<String>, content_type: Option<String>) -> Result<inline::Preview, String> {
    in_background(move || {
        if auth::is_google(email.trim()) {
            return google::preview(email.trim(), &message_id, &file_id, &name.unwrap_or_default(), &content_type.unwrap_or_default());
        }
        inline::preview(email.trim(), &message_id, &file_id, &name.unwrap_or_default(), &content_type.unwrap_or_default())
    })
    .await
}

// The text of the PDFs on these messages, for Ask (pdftext.rs).
#[tauri::command]
async fn pdf_texts(email: String, message_ids: Vec<String>) -> Result<Vec<pdftext::PdfText>, String> {
    in_background(move || pdftext::pdf_texts(email.trim(), &message_ids)).await
}

#[tauri::command]
async fn draft_mail(
    provider: String,
    to: String,
    subject: String,
    draft: String,
    thread: Vec<ai::MailNote>,
) -> Result<ai::AiText, String> {
    in_background(move || ai::draft(&provider, &to, &subject, &draft, &thread)).await
}

#[tauri::command]
async fn assist_mail(
    provider: String,
    turns: Vec<ai::AssistTurn>,
    to: String,
    subject: String,
    draft: String,
    thread: Vec<ai::MailNote>,
) -> Result<ai::AiText, String> {
    in_background(move || ai::assist(&provider, &turns, &to, &subject, &draft, &thread)).await
}

#[tauri::command]
async fn saved_inbox(email: Option<String>) -> Result<InboxResult, String> {
    in_background(move || {
        let requested = email.unwrap_or_default();
        let trimmed = requested.trim();
        if !trimmed.is_empty() {
            let key = trimmed.to_lowercase();
            if let Some((folders, page)) = store::load_inbox_page(&key, LIST_PAGE)? {
                return Ok(InboxResult {
                    name: String::new(),
                    email: trimmed.to_string(),
                    messages: page.messages,
                    folders,
                    from_cache: true,
                    removed: Vec::new(),
                    merged: false,
                    more: page.more,
                });
            }
            return Ok(InboxResult {
                name: String::new(),
                email: trimmed.to_string(),
                messages: Vec::new(),
                folders: Vec::new(),
                from_cache: true,
                removed: Vec::new(),
                merged: false,
                more: false,
            });
        }
        let status = auth::account_status();
        if let Some((folders, page)) = store::load_inbox_page(&status.email.to_lowercase(), LIST_PAGE)? {
            return Ok(InboxResult {
                name: status.name,
                email: status.email,
                messages: page.messages,
                folders,
                from_cache: true,
                removed: Vec::new(),
                merged: false,
                more: page.more,
            });
        }
        let mut messages = store::load_inbox()?;
        omit_message_bodies(&mut messages);
        let more = newest_page(&mut messages);
        Ok(InboxResult {
            name: status.name,
            email: status.email,
            messages,
            folders: Vec::new(),
            from_cache: true,
            removed: Vec::new(),
            merged: false,
            more,
        })
    })
    .await
}

/// The app's own pages load from tauri://localhost (or http://tauri.localhost).
fn app_page(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" => true,
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// No window may leave the app. A link that tries is opened in the browser.
fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|_webview, url| {
            if app_page(url) {
                return true;
            }
            let _ = graph::open_link(url.as_str());
            false
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    migrate::before_start();
    tauri::Builder::default()
        // A second launch brings the running Mailroom forward instead.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| match launch::from_args(&args) {
            // A right click on the Omarchy bar widget: check, but stay put.
            Some(request) if request.checks_mail() => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval("window.checkMailNow && window.checkMailNow();");
                }
            }
            Some(request) => {
                tray::show_main(app);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.eval(launch::page_script(&request));
                }
            }
            None => tray::show_main(app),
        }))
        .plugin(navigation_guard())
        .setup(|app| {
            if let Some(main) = app.get_webview_window("main") {
                spell::apply(&main);
                // Omarchy draws its own titlebars where windows float; a GTK
                // one as well would make two.
                if omarchy::detected() {
                    let _ = main.set_decorations(false);
                }
            }
            omarchy::watch(app.handle().clone());
            std::thread::spawn(omarchy::migrate_from_nowtlook);
            if let Err(err) = tray::install(app.handle()) {
                eprintln!("mailroom: no tray icon ({err}); closing the window will quit");
            }
            let args: Vec<String> = std::env::args().collect();
            let request = launch::from_args(&args);
            let check_only = request.as_ref().is_some_and(|r| r.checks_mail());
            if !check_only {
                launch::stash(request);
            }
            // --hidden (used at login) starts in the tray, if there is one,
            // and so does --check-mail when Mailroom was not running yet.
            let hidden = (args.iter().any(|arg| arg == "--hidden") || check_only) && tray::ready();
            if !hidden {
                tray::show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match draft_close(window.label(), tray::ready()) {
                    // The main window hides to the tray and keeps running, so
                    // the draft timer would still fire. Write now as well, in
                    // case Quit follows straight away.
                    DraftClose::Hide => {
                        api.prevent_close();
                        let _ = window.hide();
                        flush_window_drafts(window, "");
                    }
                    DraftClose::FlushThenDestroy => {
                        api.prevent_close();
                        flush_window_drafts(window, "plugin:window|destroy");
                    }
                    DraftClose::Leave => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            account_status,
            client_id,
            save_client_id,
            sign_in,
            sign_out,
            sync_inbox,
            backfill_mail,
            cached_folder,
            cached_body,
            sync_folder,
            conversation_mail,
            spelling,
            pdf_texts,
            inline_images,
            remote_image,
            save_picture,
            copy_picture,
            sender_verified,
            attachment_preview,
            free_busy,
            set_focus,
            check_spelling,
            unsubscribe_options,
            unsubscribe,
            set_spelling,
            search_mail,
            search_cached,
            message_files,
            open_attachment,
            open_link,
            print_page,
            pick_download_folder,
            save_attachments,
            send_mail,
            apply_mail,
            pop_compose,
            pop_assist,
            saved_inbox,
            sync_calendar,
            sync_contacts,
            create_contact,
            ai_status,
            save_ai_key,
            clear_ai_key,
            ask_mail,
            draft_mail,
            assist_mail,
            finish_quit,
            save_draft,
            discard_draft,
            message_invite,
            respond_invite,
            notify_mail,
            stage_file,
            save_event,
            remove_event,
            event_series,
            end_series_before,
            update_contact,
            delete_contact,
            mark_folder_read,
            empty_folder,
            mail_categories,
            set_categories,
            mail_aliases,
            list_search_folders,
            save_search_folder,
            delete_search_folder,
            mailbox_zone,
            set_mailbox_zone,
            forget_mail,
            auto_reply,
            set_auto_reply,
            ensure_folder,
            people,
            mail_rules,
            save_rule,
            delete_rule,
            check_update,
            whats_new,
            run_update,
            update_progress,
            update_log,
            restart_app,
            google_client_id,
            save_google_client,
            omarchy_look,
            mail_app_status,
            make_mail_app,
            stop_mail_app,
            add_bar_widget,
            remove_bar_widget,
            report_unread,
            take_launch_request
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // finish_quit and the timeout below ask to exit again. Let
                // that one through. The first request waits for open drafts.
                if QUIT_AFTER_DRAFTS.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_exit();
                request_quit_after_drafts(app, code.unwrap_or(0));
            }
        });
}

#[derive(Debug, PartialEq)]
enum DraftClose {
    Hide,
    FlushThenDestroy,
    Leave,
}

fn draft_close(label: &str, tray_ready: bool) -> DraftClose {
    if label == "main" && tray_ready {
        DraftClose::Hide
    } else if label == "main" || label == "compose" {
        DraftClose::FlushThenDestroy
    } else {
        DraftClose::Leave
    }
}

/// Ask the page to write open drafts, then optionally invoke a command.
/// A command is invoked once, or after 12s if the save does not finish.
fn flush_drafts_script(then_command: &str) -> String {
    let arm = !then_command.is_empty();
    let invoke = if arm {
        format!("internals.invoke({then_command:?});")
    } else {
        String::new()
    };
    let timeout = if arm { "setTimeout(finish,12000);" } else { "" };
    format!(
        "(function(){{if(window.__draftShutdown)return;if({arm})window.__draftShutdown=true;\
         var pending=(window.flushOpenDrafts&&window.flushOpenDrafts())||Promise.resolve();\
         var ran=false;var finish=function(){{if(ran)return;ran=true;var internals=window.__TAURI_INTERNALS__;\
         if(!internals||!internals.invoke)return;{invoke}}};\
         Promise.resolve(pending).then(finish,finish);{timeout}}})();"
    )
}

fn flush_window_drafts(window: &tauri::Window, then_command: &str) {
    let label = window.label().to_string();
    if let Some(page) = window.get_webview_window(&label) {
        let _ = page.eval(flush_drafts_script(then_command));
    }
}

fn request_quit_after_drafts(app: &tauri::AppHandle, code: i32) {
    QUIT_CODE.store(code, Ordering::SeqCst);
    if QUIT_AFTER_DRAFTS.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let script = flush_drafts_script("finish_quit");
        let windows = app.webview_windows();
        if windows.is_empty() {
            app.exit(QUIT_CODE.load(Ordering::SeqCst));
            return;
        }
        for window in windows.values() {
            let _ = window.eval(&script);
        }
        // The page calls finish_quit when the save returns. If it never
        // does, quit anyway so a stuck draft cannot trap the process.
        std::thread::sleep(std::time::Duration::from_secs(15));
        app.exit(QUIT_CODE.load(Ordering::SeqCst));
    });
}

#[cfg(test)]
mod tests {
    use super::{
        app_page, remember_picked_folder, take_picked_folder,
        assist_window_query, compose_window_query, draft_close, file_id_from_body, flush_drafts_script, folder_id_from_body, message_id_from_body,
        omit_message_bodies, reconcile_is_due, reported_email, DraftClose,
    };

    #[test]
    fn a_mailbox_cannot_claim_another_signed_in_account() {
        let signed = vec!["kai@timberworks.example".to_string(), "new@maplehill.example".to_string()];
        // The tenant says its new mailbox is Kai's: Kai's cache stays Kai's.
        assert_eq!(reported_email("Kai@Timberworks.example", "new@maplehill.example", &signed), "new@maplehill.example");
        // A real primary address that differs from the sign-in name is kept.
        assert_eq!(reported_email("ann@maplehill.example", "a.smith@maplehill.example", &signed), "ann@maplehill.example");
        assert_eq!(reported_email("", "new@maplehill.example", &signed), "new@maplehill.example");
        assert_eq!(reported_email("x@y.example", "", &signed), "x@y.example");
    }
    use crate::graph::LiveMessage;

    #[test]
    fn gmail_reconcile_waits_an_hour() {
        let now = std::time::Instant::now();
        let recent = now.checked_sub(std::time::Duration::from_secs(59 * 60)).unwrap();
        let hour = now.checked_sub(std::time::Duration::from_secs(60 * 60)).unwrap();
        assert!(reconcile_is_due(None, now));
        assert!(!reconcile_is_due(Some(now), now));
        assert!(!reconcile_is_due(Some(recent), now));
        assert!(reconcile_is_due(Some(hour), now));
    }

    #[test]
    fn closing_writes_the_open_draft_before_the_window_goes() {
        assert_eq!(draft_close("main", true), DraftClose::Hide);
        assert_eq!(draft_close("main", false), DraftClose::FlushThenDestroy);
        assert_eq!(draft_close("compose", true), DraftClose::FlushThenDestroy);
        assert_eq!(draft_close("assist", false), DraftClose::Leave);
        let hide = flush_drafts_script("");
        assert!(hide.contains("flushOpenDrafts"), "{hide}");
        assert!(!hide.contains("internals.invoke("), "{hide}");
        assert!(!hide.contains("setTimeout"), "{hide}");
        let close = flush_drafts_script("plugin:window|destroy");
        assert!(close.contains("internals.invoke(\"plugin:window|destroy\")"), "{close}");
        assert!(close.contains("setTimeout(finish,12000)"), "{close}");
        let quit = flush_drafts_script("finish_quit");
        assert!(quit.contains("internals.invoke(\"finish_quit\")"), "{quit}");
    }

    #[test]
    fn compose_window_query_accepts_new_and_reply() {
        assert_eq!(compose_window_query("compose=new").unwrap(), "compose=new");
        assert_eq!(
            compose_window_query("compose=reply&msg=AAMk%2Bid%2F%3D&d=99").unwrap(),
            "compose=reply&msg=AAMk%2Bid%2F%3D&d=99"
        );
        assert!(compose_window_query("compose=send").is_err());
        assert!(compose_window_query("compose=new&next=1").is_err());
        assert!(compose_window_query("http://evil").is_err());
        assert!(compose_window_query("compose=new&msg=../secret").is_err());
        assert!(compose_window_query("").is_err());
    }

    #[test]
    fn assist_window_query_accepts_only_the_chat() {
        assert_eq!(assist_window_query("assist=1&owner=main").unwrap(), "assist=1&owner=main");
        assert_eq!(
            assist_window_query("?assist=1&owner=compose&d=99").unwrap(),
            "assist=1&owner=compose&d=99"
        );
        assert!(assist_window_query("assist=1").is_err());
        assert!(assist_window_query("assist=1&owner=other").is_err());
        assert!(assist_window_query("assist=1&owner=main&next=1").is_err());
        assert!(assist_window_query("http://evil").is_err());
        assert!(assist_window_query("").is_err());
    }

    #[test]
    fn folder_id_accepts_either_argument_name() {
        let camel = serde_json::json!({"folderId": "abc"});
        let snake = serde_json::json!({"folder_id": "abc"});
        let both = serde_json::json!({"folderId": "camel", "folder_id": "snake"});
        let blank = serde_json::json!({"folderId": "  ", "folder_id": "kept"});
        let missing = serde_json::json!({});
        assert_eq!(folder_id_from_body(&camel), "abc");
        let file = serde_json::json!({"messageId": "m", "fileId": "f", "message_id": "other", "file_id": "other"});
        assert_eq!(message_id_from_body(&file), "m");
        assert_eq!(file_id_from_body(&file), "f");
        let file_snake = serde_json::json!({"message_id": "m2", "file_id": "f2"});
        assert_eq!(message_id_from_body(&file_snake), "m2");
        assert_eq!(file_id_from_body(&file_snake), "f2");
        assert_eq!(folder_id_from_body(&snake), "abc");
        assert_eq!(folder_id_from_body(&both), "camel");
        assert_eq!(folder_id_from_body(&blank), "kept");
        assert_eq!(folder_id_from_body(&missing), "");
    }

    #[test]
    fn only_app_pages_stay_in_the_window() {
        assert!(app_page(&"tauri://localhost/index.html".parse().unwrap()));
        assert!(app_page(&"http://tauri.localhost/index.html?compose=new".parse().unwrap()));
        assert!(!app_page(&"https://evil.example/login".parse().unwrap()));
        assert!(!app_page(&"http://tauri.localhost.evil.example/".parse().unwrap()));
        assert!(!app_page(&"file:///etc/passwd".parse().unwrap()));
    }

    #[test]
    fn attachments_save_only_to_the_picked_folder() {
        let picked = std::env::temp_dir().join(format!("mailroom-pick-{}", std::process::id()));
        std::fs::create_dir_all(&picked).unwrap();
        let other = std::env::temp_dir();
        remember_picked_folder(&Some(picked.to_string_lossy().into_owned()));
        assert!(take_picked_folder(&other.to_string_lossy()).is_err());
        // A wrong guess spends the pick, so the page cannot keep trying.
        assert!(take_picked_folder(&picked.to_string_lossy()).is_err());
        remember_picked_folder(&Some(picked.to_string_lossy().into_owned()));
        assert!(take_picked_folder(&picked.to_string_lossy()).is_ok());
        assert!(take_picked_folder(&picked.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir(&picked);
    }

    #[test]
    fn folder_results_leave_the_message_body_behind() {
        let mut messages = vec![LiveMessage {
            id: "m".into(),
            thread: "t".into(),
            subject: "Sent note".into(),
            from_name: "Ada".into(),
            from_email: "ada@example.com".into(),
            received: "2026-10-20T12:00:00Z".into(),
            preview: "Hello".into(),
            body_html: "<p>Hello</p>".into(),
            unread: false,
            flagged: false,
            has_attachments: false,
            files: vec![],
            to: vec![],
            cc: vec![],
            bcc: vec![],
            categories: vec![],
            importance: String::new(),
            invite: false,
            focus: String::new(),
        }];
        omit_message_bodies(&mut messages);
        assert!(messages[0].body_html.is_empty());
        assert_eq!(messages[0].subject, "Sent note");
        assert_eq!(messages[0].preview, "Hello");
    }

    #[test]
    fn blocking_http_is_safe_on_the_background_pool() {
        let joined = tauri::async_runtime::block_on(async {
            tauri::async_runtime::spawn_blocking(|| {
                reqwest::blocking::Client::builder()
                    .timeout(std::time::Duration::from_millis(300))
                    .connect_timeout(std::time::Duration::from_millis(300))
                    .build()
                    .expect("client")
                    .get("http://127.0.0.1:9")
                    .send()
            })
            .await
        });
        let response = joined.expect("background http panicked");
        assert!(response.is_err());
    }
}

#[cfg(test)]
mod picture_tests {
    use super::picture_bytes;
    use base64::Engine;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn only_real_pictures_are_saved_or_copied() {
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
        assert_eq!(picture_bytes(&b64(png)).unwrap().1, "image/png");
        assert_eq!(picture_bytes(&b64(b"\xff\xd8\xff\xe0JFIF")).unwrap().1, "image/jpeg");
        assert_eq!(picture_bytes(&b64(b"GIF89a....")).unwrap().1, "image/gif");
        assert_eq!(picture_bytes(&b64(b"RIFF\0\0\0\0WEBPVP8 ")).unwrap().1, "image/webp");
        // Markup, scripts and programs are not pictures, whatever the page says.
        for bad in [&b"<svg onload=alert(1)>"[..], b"#!/bin/sh\nrm -rf ~", b"\x7fELF\x02\x01", b"<html>"] {
            assert!(picture_bytes(&b64(bad)).is_err());
        }
        assert!(picture_bytes("not base64!").is_err());
        assert!(picture_bytes(&"A".repeat(49 * 1024 * 1024)).is_err(), "too large");
    }
}
