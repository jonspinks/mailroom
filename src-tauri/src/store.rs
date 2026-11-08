use crate::graph::{LiveFile, LiveFolder, LiveMessage};
use rusqlite::{named_params, params, Connection};
use serde::Serialize;

const SCHEMA: &str = "
create table if not exists messages (
    id text primary key,
    thread text not null,
    subject text not null,
    from_name text not null,
    from_email text not null,
    received text not null,
    preview text not null,
    body_html text not null,
    unread integer not null,
    flagged integer not null default 0,
    attached integer not null default 0,
    files text not null default '[]'
);
create table if not exists folders (
    email text not null,
    id text not null,
    parent_id text not null,
    name text not null,
    box_key text not null,
    unread integer not null,
    total integer not null,
    position integer not null,
    primary key (email, id)
);
create table if not exists folder_messages (
    email text not null,
    folder_id text not null,
    id text not null,
    thread text not null,
    subject text not null,
    from_name text not null,
    from_email text not null,
    received text not null,
    preview text not null,
    body_html text not null,
    unread integer not null,
    flagged integer not null default 0,
    attached integer not null default 0,
    files text not null default '[]',
    primary key (email, id)
);
create table if not exists folder_delta (
    email text not null,
    folder_id text not null,
    delta_link text not null,
    primary key (email, folder_id)
);
";

fn db_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(home).join(".config").join("mailroom").join("mail.db")
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(SCHEMA).map_err(|err| err.to_string())?;
    add_flagged(conn, "messages")?;
    add_flagged(conn, "folder_messages")?;
    add_attached(conn, "messages")?;
    add_attached(conn, "folder_messages")?;
    add_files(conn, "messages")?;
    add_files(conn, "folder_messages")?;
    add_cats(conn, "messages")?;
    add_cats(conn, "folder_messages")?;
    add_people(conn, "messages")?;
    add_people(conn, "folder_messages")?;
    add_extra(conn, "messages")?;
    add_extra(conn, "folder_messages")?;
    // Newest-page reads are email + folder + received. The list asks for that
    // slice on every open, so keep it an index seek as the mailbox grows.
    conn.execute_batch(
        "create index if not exists folder_messages_by_received
         on folder_messages (email, folder_id, received desc, id desc);",
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn add_people(conn: &Connection, table: &str) -> Result<(), String> {
    for name in ["to_json", "cc_json", "bcc_json"] {
        let count: i64 = conn
            .query_row(
                &format!("select count(*) from pragma_table_info('{table}') where name = '{name}'"),
                [],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        if count == 0 {
            conn.execute(
                &format!("alter table {table} add column {name} text not null default '[]'"),
                [],
            )
            .map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

/// Smaller message facts (importance, meeting invite) as one JSON column,
/// so a new one needs no new column.
fn add_extra(conn: &Connection, table: &str) -> Result<(), String> {
    let count: i64 = conn
        .query_row(&format!("select count(*) from pragma_table_info('{table}') where name = 'extra'"), [], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    if count == 0 {
        conn.execute(&format!("alter table {table} add column extra text not null default '{{}}'"), [])
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn extra_text(item: &LiveMessage) -> String {
    let mut extra = serde_json::Map::new();
    if !item.importance.is_empty() {
        extra.insert("importance".into(), item.importance.clone().into());
    }
    if item.invite {
        extra.insert("invite".into(), true.into());
    }
    if !item.focus.is_empty() {
        extra.insert("focus".into(), item.focus.clone().into());
    }
    serde_json::Value::Object(extra).to_string()
}

fn apply_extra(item: &mut LiveMessage, text: &str) {
    let extra: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
    item.importance = match extra["importance"].as_str() {
        Some("high") => "high".into(),
        Some("low") => "low".into(),
        _ => String::new(),
    };
    item.invite = extra["invite"].as_bool().unwrap_or(false);
    item.focus = match extra["focus"].as_str() {
        Some("focused") => "focused".into(),
        Some("other") => "other".into(),
        _ => String::new(),
    };
}

fn add_cats(conn: &Connection, table: &str) -> Result<(), String> {
    let count: i64 = conn
        .query_row(&format!("select count(*) from pragma_table_info('{table}') where name = 'cats'"), [], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    if count == 0 {
        conn.execute(&format!("alter table {table} add column cats text not null default '[]'"), [])
            .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn add_files(conn: &Connection, table: &str) -> Result<(), String> {
    let count: i64 = conn
        .query_row(
            &format!("select count(*) from pragma_table_info('{table}') where name = 'files'"),
            [],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if count == 0 {
        conn.execute(
            &format!("alter table {table} add column files text not null default '[]'"),
            [],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn add_attached(conn: &Connection, table: &str) -> Result<(), String> {
    let count: i64 = conn
        .query_row(
            &format!("select count(*) from pragma_table_info('{table}') where name = 'attached'"),
            [],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if count == 0 {
        conn.execute(
            &format!("alter table {table} add column attached integer not null default 0"),
            [],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn add_flagged(conn: &Connection, table: &str) -> Result<(), String> {
    let count: i64 = conn
        .query_row(
            &format!("select count(*) from pragma_table_info('{table}') where name = 'flagged'"),
            [],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if count == 0 {
        conn.execute(
            &format!("alter table {table} add column flagged integer not null default 0"),
            [],
        )
        .map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// Set once the schema has been checked in this run. Every store call opens
/// its own connection, and the check is about fifteen queries, so it runs on
/// the first open only.
static SCHEMA_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn open() -> Result<Connection, String> {
    let path = db_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    let conn = Connection::open(&path).map_err(|err| err.to_string())?;
    tune(&conn)?;
    if !SCHEMA_READY.load(std::sync::atomic::Ordering::Acquire) {
        // WAL: reads don't wait behind backfill writes, and a write is one
        // append instead of a journal plus the database. It stays set in the file.
        conn.query_row("pragma journal_mode = wal", [], |_| Ok(())).map_err(|err| err.to_string())?;
        ensure_schema(&conn)?;
        SCHEMA_READY.store(true, std::sync::atomic::Ordering::Release);
    }
    keep_private(&path);
    Ok(conn)
}

/// Per connection. NORMAL is safe with WAL: a power cut can lose the last
/// writes, never corrupt the file, and this cache refills from the server.
/// The timeout makes a second writer wait its turn instead of failing.
fn tune(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|err| err.to_string())?;
    conn.pragma_update(None, "synchronous", "NORMAL").map_err(|err| err.to_string())
}

/// The cache holds whole mailboxes. Only this user may read it.
fn keep_private(db: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Some(dir) = db.parent() {
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let file = std::path::PathBuf::from(format!("{}{suffix}", db.display()));
        if file.exists() {
            let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
        }
    }
}

pub fn replace_inbox(items: &[LiveMessage]) -> Result<(), String> {
    let mut conn = open()?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    tx.execute("delete from messages", []).map_err(|err| err.to_string())?;
    for item in items {
        insert_legacy(&tx, item)?;
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

pub fn load_inbox() -> Result<Vec<LiveMessage>, String> {
    let conn = open()?;
    load_legacy(&conn)
}

pub fn replace_folders(email: &str, folders: &[LiveFolder]) -> Result<(), String> {
    let mut conn = open()?;
    replace_folders_on(&mut conn, email, folders)
}

pub fn replace_folder_messages(email: &str, folder_id: &str, items: &[LiveMessage]) -> Result<(), String> {
    let mut conn = open()?;
    replace_folder_messages_on(&mut conn, email, folder_id, items)
}

pub fn record_mail_action(email: &str, kind: &str, ids: &[String]) -> Result<(), String> {
    let mut conn = open()?;
    record_mail_action_on(&mut conn, email, kind, ids)
}

fn record_mail_action_on(conn: &mut Connection, email: &str, kind: &str, ids: &[String]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    for id in ids {
        match kind {
            "read" | "unread" => {
                let unread: i64 = if kind == "unread" { 1 } else { 0 };
                tx.execute("update messages set unread = ?1 where id = ?2", params![unread, id])
                    .map_err(|err| err.to_string())?;
                tx.execute(
                    "update folder_messages set unread = ?1 where email = ?2 and id = ?3",
                    params![unread, email, id],
                )
                .map_err(|err| err.to_string())?;
            }
            "flag" | "unflag" => {
                let flagged: i64 = if kind == "flag" { 1 } else { 0 };
                tx.execute("update messages set flagged = ?1 where id = ?2", params![flagged, id])
                    .map_err(|err| err.to_string())?;
                tx.execute(
                    "update folder_messages set flagged = ?1 where email = ?2 and id = ?3",
                    params![flagged, email, id],
                )
                .map_err(|err| err.to_string())?;
            }
            "archive" | "trash" | "inbox" => {
                let key = match kind {
                    "archive" => "archive",
                    "trash" => "trash",
                    _ => "inbox",
                };
                let dest: Option<String> = tx
                    .query_row(
                        "select id from folders where email = ?1 and box_key = ?2 order by position limit 1",
                        params![email, key],
                        |row| row.get(0),
                    )
                    .ok();
                if let Some(dest) = dest {
                    tx.execute(
                        "update folder_messages set folder_id = ?1, unread = case when ?2 = 'inbox' then unread else 0 end where email = ?3 and id = ?4",
                        params![dest, kind, email, id],
                    )
                    .map_err(|err| err.to_string())?;
                } else {
                    tx.execute("delete from folder_messages where email = ?1 and id = ?2", params![email, id])
                        .map_err(|err| err.to_string())?;
                }
                if kind != "inbox" {
                    tx.execute("delete from messages where id = ?1", [id]).map_err(|err| err.to_string())?;
                }
            }
            _ => return Err("That mail action is not available.".into()),
        }
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

/// Messages the server no longer has: moved or deleted in Outlook, on a
/// phone, or by Exchange (an accepted invite goes to Deleted Items). Drop
/// them from every cached folder of the account, so a stale copy can't come
/// back on the next start (2026-10-27, "Jon and Nick Sync").
pub fn forget_messages(email: &str, ids: &[String]) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    let mut conn = open()?;
    let folders = forget_messages_on(&mut conn, &email, ids)?;
    drop(conn);
    for folder in folders {
        let _ = refresh_folder_counts(&email, &folder);
    }
    Ok(())
}

fn forget_messages_on(conn: &mut Connection, email: &str, ids: &[String]) -> Result<Vec<String>, String> {
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let mut folders = Vec::new();
    for id in ids.iter().map(|id| id.trim()).filter(|id| !id.is_empty()) {
        {
            let mut stmt = tx
                .prepare("select distinct folder_id from folder_messages where email = ?1 and id = ?2")
                .map_err(|err| err.to_string())?;
            let rows = stmt
                .query_map(params![email, id], |row| row.get::<_, String>(0))
                .map_err(|err| err.to_string())?;
            for folder in rows.flatten() {
                if !folders.contains(&folder) {
                    folders.push(folder);
                }
            }
        }
        tx.execute("delete from folder_messages where email = ?1 and id = ?2", params![email, id])
            .map_err(|err| err.to_string())?;
        tx.execute("delete from messages where id = ?1", [id]).map_err(|err| err.to_string())?;
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(folders)
}

/// Record a move to any folder. A folder this computer has not seen is
/// left to the next sync.
pub fn record_move(email: &str, folder_id: &str, ids: &[String]) -> Result<(), String> {
    let mut conn = open()?;
    record_move_on(&mut conn, &email.trim().to_lowercase(), folder_id.trim(), ids)
}

fn record_move_on(conn: &mut Connection, email: &str, folder_id: &str, ids: &[String]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let (known, key): (bool, String) = tx
        .query_row(
            "select box_key from folders where email = ?1 and id = ?2",
            params![email, folder_id],
            |row| row.get::<_, String>(0),
        )
        .map(|key| (true, key))
        .unwrap_or((false, String::new()));
    for id in ids {
        if known {
            tx.execute(
                "update folder_messages set folder_id = ?1 where email = ?2 and id = ?3",
                params![folder_id, email, id],
            )
            .map_err(|err| err.to_string())?;
        } else {
            tx.execute("delete from folder_messages where email = ?1 and id = ?2", params![email, id])
                .map_err(|err| err.to_string())?;
        }
        if key != "inbox" {
            tx.execute("delete from messages where id = ?1", [id]).map_err(|err| err.to_string())?;
        }
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

/// Give cached messages the ids the server assigned when it moved them. If a
/// sync already stored the new id, the old row is dropped instead.
pub fn rename_moved(email: &str, moved: &[crate::graph::MovedId]) -> Result<(), String> {
    if moved.is_empty() {
        return Ok(());
    }
    let mut conn = open()?;
    rename_moved_on(&mut conn, &email.trim().to_lowercase(), moved)
}

fn rename_moved_on(conn: &mut Connection, email: &str, moved: &[crate::graph::MovedId]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    for pair in moved {
        let have: i64 = tx
            .query_row(
                "select count(*) from folder_messages where email = ?1 and id = ?2",
                params![email, pair.to],
                |row| row.get(0),
            )
            .map_err(|err| err.to_string())?;
        if have > 0 {
            tx.execute("delete from folder_messages where email = ?1 and id = ?2", params![email, pair.from])
                .map_err(|err| err.to_string())?;
        } else {
            tx.execute(
                "update folder_messages set id = ?1 where email = ?2 and id = ?3",
                params![pair.to, email, pair.from],
            )
            .map_err(|err| err.to_string())?;
        }
        tx.execute("delete from messages where id = ?1", params![pair.to])
            .map_err(|err| err.to_string())?;
        tx.execute("update messages set id = ?1 where id = ?2", params![pair.to, pair.from])
            .map_err(|err| err.to_string())?;
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

pub fn load_message_body(email: &str, message_id: &str) -> Result<String, String> {
    let conn = open()?;
    load_message_body_on(&conn, email, message_id)
}

pub fn cached_inbox_id(email: &str) -> Result<Option<String>, String> {
    let conn = open()?;
    cached_inbox_id_on(&conn, email)
}

pub fn folder_sync_state(email: &str, folder_id: &str) -> Result<FolderSyncState, String> {
    let conn = open()?;
    folder_sync_state_on(&conn, email, folder_id)
}

pub fn load_delta_link(email: &str, folder_id: &str) -> Result<Option<String>, String> {
    let conn = open()?;
    load_delta_link_on(&conn, email, folder_id)
}

pub fn save_delta_link(email: &str, folder_id: &str, link: &str) -> Result<(), String> {
    let mut conn = open()?;
    save_delta_link_on(&mut conn, email, folder_id, link)
}

pub fn clear_delta_link(email: &str, folder_id: &str) -> Result<(), String> {
    let mut conn = open()?;
    clear_delta_link_on(&mut conn, email, folder_id)
}

pub fn upsert_folder_messages(email: &str, folder_id: &str, items: &[LiveMessage]) -> Result<(), String> {
    let mut conn = open()?;
    upsert_folder_messages_on(&mut conn, email, folder_id, items)
}

pub fn apply_delta(
    email: &str,
    folder_id: &str,
    removed: &[String],
    changed: &[LiveMessage],
    link: &str,
) -> Result<(), String> {
    let mut conn = open()?;
    apply_delta_on(&mut conn, email, folder_id, removed, changed, link)
}

/// Apply mail-delta changes that carry only some fields, and return the
/// merged rows (without bodies) for the list. Patches for messages the cache
/// doesn't hold (outside the sync window) are dropped.
pub fn patch_messages(
    email: &str,
    folder_id: &str,
    patches: &[crate::graph::MessagePatch],
) -> Result<Vec<LiveMessage>, String> {
    let mut conn = open()?;
    patch_messages_on(&mut conn, email, folder_id, patches)
}

fn patch_messages_on(
    conn: &mut Connection,
    email: &str,
    folder_id: &str,
    patches: &[crate::graph::MessagePatch],
) -> Result<Vec<LiveMessage>, String> {
    let email = email.trim().to_lowercase();
    let folder_id = folder_id.trim();
    if email.is_empty() || folder_id.is_empty() || patches.is_empty() {
        return Ok(Vec::new());
    }
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let mut merged = Vec::new();
    for patch in patches {
        let found = tx.query_row(
            "select id, thread, subject, from_name, from_email, received, preview, '', unread, flagged, attached, files, to_json, cc_json, bcc_json, cats, extra
             from folder_messages where email = ?1 and folder_id = ?2 and id = ?3",
            params![email, folder_id, patch.id.trim()],
            message_row,
        );
        let mut item = match found {
            Ok(item) => item,
            Err(rusqlite::Error::QueryReturnedNoRows) => continue,
            Err(err) => return Err(err.to_string()),
        };
        if let Some(subject) = &patch.subject {
            item.subject = subject.clone();
        }
        if let Some(unread) = patch.unread {
            item.unread = unread;
        }
        if let Some(flagged) = patch.flagged {
            item.flagged = flagged;
        }
        if let Some(categories) = &patch.categories {
            item.categories = categories.clone();
        }
        if let Some(importance) = &patch.importance {
            item.importance = importance.clone();
        }
        if let Some(focus) = &patch.focus {
            item.focus = focus.clone();
        }
        tx.execute(
            "update folder_messages set subject = ?4, unread = ?5, flagged = ?6, cats = ?7, extra = ?8
             where email = ?1 and folder_id = ?2 and id = ?3",
            params![
                email,
                folder_id,
                item.id,
                item.subject,
                item.unread as i64,
                item.flagged as i64,
                cats_text(&item.categories),
                extra_text(&item)
            ],
        )
        .map_err(|err| err.to_string())?;
        merged.push(item);
    }
    refresh_counts_tx(&tx, &email, folder_id)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(merged)
}

/// A folder was marked read, or emptied, on the server.
pub fn folder_changed(email: &str, folder_id: &str, emptied: bool) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    let mut conn = open()?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    if emptied {
        tx.execute("delete from folder_messages where email = ?1 and folder_id = ?2", params![email, folder_id.trim()])
            .map_err(|err| err.to_string())?;
    } else {
        tx.execute("update folder_messages set unread = 0 where email = ?1 and folder_id = ?2", params![email, folder_id.trim()])
            .map_err(|err| err.to_string())?;
    }
    refresh_counts_tx(&tx, &email, folder_id.trim())?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

pub fn refresh_folder_counts(email: &str, folder_id: &str) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    let folder_id = folder_id.trim();
    if email.is_empty() || folder_id.is_empty() {
        return Ok(());
    }
    let mut conn = open()?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    refresh_counts_tx(&tx, &email, folder_id)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

pub fn load_folder_headers(email: &str, folder_id: &str) -> Result<Vec<LiveMessage>, String> {
    let conn = open()?;
    load_folder_messages(&conn, email.trim().to_lowercase().as_str(), folder_id.trim(), false)
}

/// One slice of a folder, newest first. `limit` of 0 or less is the whole folder.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub messages: Vec<LiveMessage>,
    pub more: bool,
}

pub fn load_folders(email: &str) -> Result<Vec<LiveFolder>, String> {
    let conn = open()?;
    Ok(load_folders_on(&conn, email.trim().to_lowercase().as_str())?.unwrap_or_default())
}

/// Newest inbox messages, plus the folder list. `None` when this account has no cached folders.
pub fn load_inbox_page(email: &str, limit: i64) -> Result<Option<(Vec<LiveFolder>, MessagePage)>, String> {
    let conn = open()?;
    let email = email.trim().to_lowercase();
    let Some(folders) = load_folders_on(&conn, &email)? else {
        return Ok(None);
    };
    let page = if let Some(inbox) = folders.iter().find(|folder| folder.key == "inbox") {
        load_folder_page_on(&conn, &email, &inbox.id, false, limit, "", "")?
    } else {
        MessagePage { messages: Vec::new(), more: false }
    };
    Ok(Some((folders, page)))
}

pub fn load_folder_page(
    email: &str,
    folder_id: &str,
    include_body: bool,
    limit: i64,
    before: &str,
    before_id: &str,
) -> Result<MessagePage, String> {
    let conn = open()?;
    load_folder_page_on(&conn, email, folder_id, include_body, limit, before, before_id)
}

pub fn load_box_page(
    email: &str,
    box_key: &str,
    include_body: bool,
    limit: i64,
    before: &str,
    before_id: &str,
) -> Result<MessagePage, String> {
    let conn = open()?;
    load_box_page_on(&conn, email, box_key, include_body, limit, before, before_id)
}

#[derive(Clone, Debug)]
pub struct FolderSyncState {
    pub messages: i64,
    pub newest: Option<String>,
    pub delta_link: Option<String>,
}

fn replace_folders_on(conn: &mut Connection, email: &str, folders: &[LiveFolder]) -> Result<(), String> {
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    tx.execute("delete from folders where email = ?1", [email])
        .map_err(|err| err.to_string())?;
    for (position, folder) in folders.iter().enumerate() {
        tx.execute(
            "insert into folders (email, id, parent_id, name, box_key, unread, total, position)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                email,
                folder.id,
                folder.parent_id,
                folder.name,
                folder.key,
                folder.unread,
                folder.total,
                position as i64
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    tx.execute(
        "delete from folder_messages
         where email = ?1
           and folder_id not in (select id from folders where email = ?1)",
        [email],
    )
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

fn replace_folder_messages_on(
    conn: &mut Connection,
    email: &str,
    folder_id: &str,
    items: &[LiveMessage],
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    tx.execute(
        "delete from folder_messages where email = ?1 and folder_id = ?2",
        params![email, folder_id],
    )
    .map_err(|err| err.to_string())?;
    for item in items {
        tx.execute(
            "insert or replace into folder_messages
             (email, folder_id, id, thread, subject, from_name, from_email, received, preview, body_html, unread, flagged, attached, files, to_json, cc_json, bcc_json, cats, extra)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
            params![
                email,
                folder_id,
                item.id,
                item.thread,
                item.subject,
                item.from_name,
                item.from_email,
                item.received,
                item.preview,
                item.body_html,
                item.unread as i64,
                item.flagged as i64,
                item.has_attachments as i64,
                files_text(&item.files),
                people_text(&item.to),
                people_text(&item.cc),
                people_text(&item.bcc),
                cats_text(&item.categories),
                extra_text(item)
            ],
        )
        .map_err(|err| err.to_string())?;
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

// Tests load a whole mailbox through this, including message bodies.
#[cfg_attr(not(test), allow(dead_code))]
fn load_mailbox_on(conn: &Connection, email: &str) -> Result<Option<(Vec<LiveFolder>, Vec<LiveMessage>)>, String> {
    load_mailbox_view(conn, email, true)
}

fn load_folders_on(conn: &Connection, email: &str) -> Result<Option<Vec<LiveFolder>>, String> {
    let count: i64 = conn
        .query_row("select count(*) from folders where email = ?1", [email], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    if count == 0 {
        return Ok(None);
    }
    let mut stmt = conn
        .prepare(
            "select id, parent_id, name, box_key, unread, total
             from folders where email = ?1 order by position",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([email], |row| {
            Ok(LiveFolder {
                id: row.get(0)?,
                parent_id: row.get(1)?,
                name: row.get(2)?,
                key: row.get(3)?,
                unread: row.get(4)?,
                total: row.get(5)?,
                depth: 0,
            })
        })
        .map_err(|err| err.to_string())?;
    let mut folders = Vec::new();
    for row in rows {
        folders.push(row.map_err(|err| err.to_string())?);
    }
    assign_depth(&mut folders);
    Ok(Some(folders))
}

#[cfg_attr(not(test), allow(dead_code))]
fn load_mailbox_view(
    conn: &Connection,
    email: &str,
    include_body: bool,
) -> Result<Option<(Vec<LiveFolder>, Vec<LiveMessage>)>, String> {
    let Some(folders) = load_folders_on(conn, email)? else {
        return Ok(None);
    };
    let messages = if let Some(inbox) = folders.iter().find(|folder| folder.key == "inbox") {
        load_folder_messages(conn, email, &inbox.id, include_body)?
    } else if include_body {
        load_legacy(conn)?
    } else {
        Vec::new()
    };
    Ok(Some((folders, messages)))
}

fn cached_inbox_id_on(conn: &Connection, email: &str) -> Result<Option<String>, String> {
    let email = email.trim().to_lowercase();
    if email.is_empty() {
        return Ok(None);
    }
    optional_string(conn.query_row(
        "select id from folders where email = ?1 and box_key = 'inbox' order by position limit 1",
        [email.as_str()],
        |row| row.get(0),
    ))
}

fn folder_sync_state_on(conn: &Connection, email: &str, folder_id: &str) -> Result<FolderSyncState, String> {
    let email = email.trim().to_lowercase();
    let folder_id = folder_id.trim();
    if email.is_empty() || folder_id.is_empty() {
        return Ok(FolderSyncState { messages: 0, newest: None, delta_link: None });
    }
    let messages: i64 = conn
        .query_row(
            "select count(*) from folder_messages where email = ?1 and folder_id = ?2",
            params![email, folder_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let newest = optional_string(conn.query_row(
        "select received from folder_messages
         where email = ?1 and folder_id = ?2 and received != ''
         order by received desc limit 1",
        params![email, folder_id],
        |row| row.get(0),
    ))?;
    let delta_link = load_delta_link_on(conn, &email, folder_id)?;
    Ok(FolderSyncState { messages, newest, delta_link })
}

fn load_delta_link_on(conn: &Connection, email: &str, folder_id: &str) -> Result<Option<String>, String> {
    let email = email.trim().to_lowercase();
    let folder_id = folder_id.trim();
    if email.is_empty() || folder_id.is_empty() {
        return Ok(None);
    }
    optional_string(conn.query_row(
        "select delta_link from folder_delta where email = ?1 and folder_id = ?2",
        params![email, folder_id],
        |row| row.get(0),
    ))
}

fn save_delta_link_on(conn: &mut Connection, email: &str, folder_id: &str, link: &str) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    let folder_id = folder_id.trim();
    let link = link.trim();
    if email.is_empty() || folder_id.is_empty() || link.is_empty() || !(crate::graph::trusted_delta_link(link) || crate::google::trusted_history_link(link)) {
        return Err("The mail sync link was not accepted.".into());
    }
    conn.execute(
        "insert or replace into folder_delta (email, folder_id, delta_link) values (?1, ?2, ?3)",
        params![email, folder_id, link],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn clear_delta_link_on(conn: &mut Connection, email: &str, folder_id: &str) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    let folder_id = folder_id.trim();
    conn.execute(
        "delete from folder_delta where email = ?1 and folder_id = ?2",
        params![email, folder_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn upsert_folder_messages_on(
    conn: &mut Connection,
    email: &str,
    folder_id: &str,
    items: &[LiveMessage],
) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    let folder_id = folder_id.trim();
    if email.is_empty() || folder_id.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    for item in items {
        upsert_message_tx(&tx, &email, folder_id, item)?;
    }
    refresh_counts_tx(&tx, &email, folder_id)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

fn apply_delta_on(
    conn: &mut Connection,
    email: &str,
    folder_id: &str,
    removed: &[String],
    changed: &[LiveMessage],
    link: &str,
) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    let folder_id = folder_id.trim();
    if email.is_empty() || folder_id.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    for id in removed {
        let id = id.trim();
        if id.is_empty() {
            continue;
        }
        // Only from this folder: a Gmail message that left this label for
        // the Inbox must keep its Inbox row.
        let gone = tx
            .execute("delete from folder_messages where email = ?1 and id = ?2 and folder_id = ?3", params![email, id, folder_id])
            .map_err(|err| err.to_string())?;
        if gone > 0 {
            tx.execute("delete from messages where id = ?1", [id])
                .map_err(|err| err.to_string())?;
        }
    }
    for item in changed {
        upsert_message_tx(&tx, &email, folder_id, item)?;
    }
    let link = link.trim();
    if !link.is_empty() && (crate::graph::trusted_delta_link(link) || crate::google::trusted_history_link(link)) {
        tx.execute(
            "insert or replace into folder_delta (email, folder_id, delta_link) values (?1, ?2, ?3)",
            params![email, folder_id, link],
        )
        .map_err(|err| err.to_string())?;
    }
    refresh_counts_tx(&tx, &email, folder_id)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

fn refresh_counts_tx(tx: &rusqlite::Transaction, email: &str, folder_id: &str) -> Result<(), String> {
    tx.execute(
        "update folders set
            unread = (select count(*) from folder_messages where email = ?1 and folder_id = ?2 and unread != 0),
            total = (select count(*) from folder_messages where email = ?1 and folder_id = ?2)
         where email = ?1 and id = ?2",
        params![email, folder_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn upsert_message_tx(tx: &rusqlite::Transaction, email: &str, folder_id: &str, item: &LiveMessage) -> Result<(), String> {
    tx.execute(
        "insert into folder_messages
         (email, folder_id, id, thread, subject, from_name, from_email, received, preview, body_html, unread, flagged, attached, files, to_json, cc_json, bcc_json, cats, extra)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
         on conflict(email, id) do update set
           folder_id = excluded.folder_id,
           thread = case when excluded.thread = '' then folder_messages.thread else excluded.thread end,
           subject = case when excluded.subject = '' then folder_messages.subject else excluded.subject end,
           from_name = case when excluded.from_email = '' then folder_messages.from_name else excluded.from_name end,
           from_email = case when excluded.from_email = '' then folder_messages.from_email else excluded.from_email end,
           received = case when excluded.received = '' then folder_messages.received else excluded.received end,
           preview = case when excluded.preview = '' then folder_messages.preview else excluded.preview end,
           body_html = case when excluded.body_html = '' then folder_messages.body_html else excluded.body_html end,
           unread = excluded.unread,
           flagged = excluded.flagged,
           attached = case when excluded.files != '[]' then 1 when excluded.attached = 1 then 1 else 0 end,
           files = case when excluded.files != '[]' then excluded.files when excluded.attached = 1 then folder_messages.files else '[]' end,
           to_json = case when excluded.to_json = '[]' then folder_messages.to_json else excluded.to_json end,
           cc_json = case when excluded.cc_json = '[]' then folder_messages.cc_json else excluded.cc_json end,
           bcc_json = case when excluded.bcc_json = '[]' then folder_messages.bcc_json else excluded.bcc_json end,
           cats = excluded.cats,
           extra = case when excluded.extra = '{}' then folder_messages.extra else excluded.extra end",
        params![
            email,
            folder_id,
            item.id,
            item.thread,
            item.subject,
            item.from_name,
            item.from_email,
            item.received,
            item.preview,
            item.body_html,
            item.unread as i64,
            item.flagged as i64,
            item.has_attachments as i64,
            files_text(&item.files),
            people_text(&item.to),
            people_text(&item.cc),
            people_text(&item.bcc),
            cats_text(&item.categories),
            extra_text(item)
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn optional_string(result: Result<String, rusqlite::Error>) -> Result<Option<String>, String> {
    match result {
        Ok(value) => Ok(Some(value).filter(|item| !item.is_empty())),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

fn assign_depth(folders: &mut [LiveFolder]) {
    let ids: Vec<(String, String)> = folders
        .iter()
        .map(|folder| (folder.id.clone(), folder.parent_id.clone()))
        .collect();
    for folder in folders.iter_mut() {
        let mut depth = 0i64;
        let mut parent = folder.parent_id.clone();
        let mut guard = 0;
        while ids.iter().any(|(id, _)| id == &parent) {
            depth += 1;
            parent = ids
                .iter()
                .find(|(id, _)| id == &parent)
                .map(|(_, next)| next.clone())
                .unwrap_or_default();
            guard += 1;
            if guard > 8 {
                break;
            }
        }
        folder.depth = depth.min(4);
    }
}

fn load_message_body_on(conn: &Connection, email: &str, message_id: &str) -> Result<String, String> {
    let email = email.trim().to_lowercase();
    let message_id = message_id.trim();
    if email.is_empty() || message_id.is_empty() {
        return Ok(String::new());
    }
    let mut stmt = conn
        .prepare("select body_html from folder_messages where email = ?1 and id = ?2 limit 1")
        .map_err(|err| err.to_string())?;
    let mut rows = stmt.query(params![email, message_id]).map_err(|err| err.to_string())?;
    if let Some(row) = rows.next().map_err(|err| err.to_string())? {
        return row.get(0).map_err(|err| err.to_string());
    }
    Ok(String::new())
}

pub fn save_message_body(email: &str, message_id: &str, html: &str) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    let message_id = message_id.trim();
    if email.is_empty() || message_id.is_empty() {
        return Ok(());
    }
    let conn = open()?;
    conn.execute(
        "update folder_messages set body_html = ?3 where email = ?1 and id = ?2",
        params![email, message_id, html],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn folder_ids_for_box(conn: &Connection, email: &str, box_key: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("select id from folders where email = ?1 and box_key = ?2 order by position")
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![email, box_key], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(|err| err.to_string())?);
    }
    Ok(ids)
}

fn load_box_page_on(
    conn: &Connection,
    email: &str,
    box_key: &str,
    include_body: bool,
    limit: i64,
    before: &str,
    before_id: &str,
) -> Result<MessagePage, String> {
    let email = email.trim().to_lowercase();
    let box_key = box_key.trim();
    if email.is_empty() || box_key.is_empty() {
        return Ok(MessagePage { messages: Vec::new(), more: false });
    }
    if limit <= 0 {
        return Ok(MessagePage {
            messages: load_box_messages_on(conn, &email, box_key, include_body)?,
            more: false,
        });
    }
    let ids = folder_ids_for_box(conn, &email, box_key)?;
    if ids.is_empty() {
        return Ok(MessagePage { messages: Vec::new(), more: false });
    }
    if ids.len() == 1 {
        return load_folder_page_on(conn, &email, &ids[0], include_body, limit, before, before_id);
    }
    // Two folders sharing a box key is rare. The newest page is among each folder's newest page.
    let mut all = Vec::new();
    let mut any_more = false;
    for id in &ids {
        let page = load_folder_page_on(conn, &email, id, include_body, limit, before, before_id)?;
        any_more = any_more || page.more;
        all.extend(page.messages);
    }
    all.sort_by(|a, b| b.received.cmp(&a.received).then_with(|| b.id.cmp(&a.id)));
    let more = any_more || all.len() > limit as usize;
    all.truncate(limit as usize);
    Ok(MessagePage { messages: all, more })
}

fn load_folder_page_on(
    conn: &Connection,
    email: &str,
    folder_id: &str,
    include_body: bool,
    limit: i64,
    before: &str,
    before_id: &str,
) -> Result<MessagePage, String> {
    let email = email.trim().to_lowercase();
    let folder_id = folder_id.trim();
    if email.is_empty() || folder_id.is_empty() {
        return Ok(MessagePage { messages: Vec::new(), more: false });
    }
    if limit <= 0 {
        return Ok(MessagePage {
            messages: load_folder_messages(conn, &email, folder_id, include_body)?,
            more: false,
        });
    }
    let body = if include_body { "body_html" } else { "''" };
    let fetch = limit.saturating_add(1);
    let mut stmt = conn
        .prepare(&format!(
            "select id, thread, subject, from_name, from_email, received, preview, {body}, unread, flagged, attached, files, to_json, cc_json, bcc_json, cats, extra
             from folder_messages
             where email = ?1 and folder_id = ?2
               and (?3 = '' or received < ?3 or (received = ?3 and id < ?4))
             order by received desc, id desc
             limit ?5"
        ))
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![email, folder_id, before, before_id, fetch], message_row)
        .map_err(|err| err.to_string())?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|err| err.to_string())?);
    }
    let more = items.len() > limit as usize;
    if more {
        items.truncate(limit as usize);
    }
    Ok(MessagePage { messages: items, more })
}

fn load_box_messages_on(
    conn: &Connection,
    email: &str,
    box_key: &str,
    include_body: bool,
) -> Result<Vec<LiveMessage>, String> {
    let email = email.trim().to_lowercase();
    let box_key = box_key.trim();
    if email.is_empty() || box_key.is_empty() {
        return Ok(Vec::new());
    }
    let sql = if include_body {
        "select fm.id, fm.thread, fm.subject, fm.from_name, fm.from_email, fm.received, fm.preview, fm.body_html, fm.unread, fm.flagged, fm.attached, fm.files, fm.to_json, fm.cc_json, fm.bcc_json, fm.cats, fm.extra
         from folder_messages fm
         join folders f on f.email = fm.email and f.id = fm.folder_id
         where fm.email = ?1 and f.box_key = ?2"
    } else {
        "select fm.id, fm.thread, fm.subject, fm.from_name, fm.from_email, fm.received, fm.preview, '', fm.unread, fm.flagged, fm.attached, fm.files, fm.to_json, fm.cc_json, fm.bcc_json, fm.cats, fm.extra
         from folder_messages fm
         join folders f on f.email = fm.email and f.id = fm.folder_id
         where fm.email = ?1 and f.box_key = ?2"
    };
    let mut stmt = conn.prepare(sql).map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![email, box_key], message_row)
        .map_err(|err| err.to_string())?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|err| err.to_string())?);
    }
    Ok(items)
}

fn load_folder_messages(
    conn: &Connection,
    email: &str,
    folder_id: &str,
    include_body: bool,
) -> Result<Vec<LiveMessage>, String> {
    let body = if include_body { "body_html" } else { "''" };
    let mut stmt = conn
        .prepare(&format!(
            "select id, thread, subject, from_name, from_email, received, preview, {body}, unread, flagged, attached, files, to_json, cc_json, bcc_json, cats, extra
             from folder_messages where email = ?1 and folder_id = ?2"
        ))
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(params![email, folder_id], message_row)
        .map_err(|err| err.to_string())?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|err| err.to_string())?);
    }
    Ok(items)
}

fn load_legacy(conn: &Connection) -> Result<Vec<LiveMessage>, String> {
    let mut stmt = conn
        .prepare("select id, thread, subject, from_name, from_email, received, preview, body_html, unread, flagged, attached, files, to_json, cc_json, bcc_json, cats, extra from messages")
        .map_err(|err| err.to_string())?;
    let rows = stmt.query_map([], message_row).map_err(|err| err.to_string())?;
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|err| err.to_string())?);
    }
    Ok(items)
}

fn message_row(row: &rusqlite::Row) -> rusqlite::Result<LiveMessage> {
    let mut item = message_fields(row)?;
    apply_extra(&mut item, &row.get::<_, Option<String>>(16).ok().flatten().unwrap_or_default());
    Ok(item)
}

fn message_fields(row: &rusqlite::Row) -> rusqlite::Result<LiveMessage> {
    Ok(LiveMessage {
        id: row.get(0)?,
        thread: row.get(1)?,
        subject: row.get(2)?,
        from_name: row.get(3)?,
        from_email: row.get(4)?,
        received: row.get(5)?,
        preview: row.get(6)?,
        body_html: row.get(7)?,
        unread: row.get::<_, i64>(8)? != 0,
        flagged: row.get::<_, i64>(9).unwrap_or(0) != 0,
        has_attachments: row.get::<_, i64>(10).unwrap_or(0) != 0,
        files: files_from_text(row.get::<_, Option<String>>(11)?.unwrap_or_default()),
        to: people_from_text(row.get::<_, Option<String>>(12)?.unwrap_or_default()),
        cc: people_from_text(row.get::<_, Option<String>>(13)?.unwrap_or_default()),
        bcc: people_from_text(row.get::<_, Option<String>>(14)?.unwrap_or_default()),
        categories: cats_from_text(row.get::<_, Option<String>>(15).ok().flatten().unwrap_or_default()),
        importance: String::new(),
        invite: false,
        focus: String::new(),
    })
}

fn cats_text(cats: &[String]) -> String {
    serde_json::to_string(cats).unwrap_or_else(|_| "[]".into())
}

fn cats_from_text(text: String) -> Vec<String> {
    serde_json::from_str(text.trim()).unwrap_or_default()
}

/// Record the categories now on some messages.
pub fn set_categories(email: &str, ids: &[String], cats: &[String]) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    let text = cats_text(cats);
    let mut conn = open()?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    for id in ids {
        tx.execute("update folder_messages set cats = ?1 where email = ?2 and id = ?3", params![text, email, id])
            .map_err(|err| err.to_string())?;
        tx.execute("update messages set cats = ?1 where id = ?2", params![text, id]).map_err(|err| err.to_string())?;
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

fn people_text(people: &[crate::graph::LivePerson]) -> String {
    serde_json::to_string(people).unwrap_or_else(|_| "[]".into())
}

fn people_from_text(text: String) -> Vec<crate::graph::LivePerson> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    serde_json::from_str(text).unwrap_or_default()
}

fn files_text(files: &[LiveFile]) -> String {
    serde_json::to_string(files).unwrap_or_else(|_| "[]".into())
}

fn files_from_text(text: String) -> Vec<LiveFile> {
    let text = text.trim();
    if text.is_empty() {
        return Vec::new();
    }
    serde_json::from_str(text).unwrap_or_default()
}

pub fn save_message_files(email: &str, message_id: &str, files: &[LiveFile]) -> Result<(), String> {
    let mut conn = open()?;
    save_message_files_on(&mut conn, email, message_id, files)
}

fn save_message_files_on(conn: &mut Connection, email: &str, message_id: &str, files: &[LiveFile]) -> Result<(), String> {
    let text = files_text(files);
    let attached: i64 = if files.is_empty() { 0 } else { 1 };
    conn.execute(
        "update messages set files = ?1, attached = case when ?2 = 1 then 1 else attached end where id = ?3",
        params![text, attached, message_id],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "update folder_messages set files = ?1, attached = case when ?2 = 1 then 1 else attached end where email = ?3 and id = ?4",
        params![text, attached, email, message_id],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn insert_legacy(tx: &rusqlite::Transaction, item: &LiveMessage) -> Result<(), String> {
    tx.execute(
        "insert into messages (id, thread, subject, from_name, from_email, received, preview, body_html, unread, flagged, attached, files, to_json, cc_json, bcc_json, cats, extra)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        params![
            item.id,
            item.thread,
            item.subject,
            item.from_name,
            item.from_email,
            item.received,
            item.preview,
            item.body_html,
            item.unread as i64,
            item.flagged as i64,
            item.has_attachments as i64,
            files_text(&item.files),
            people_text(&item.to),
            people_text(&item.cc),
            people_text(&item.bcc),
            cats_text(&item.categories),
            extra_text(item)
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

/// One page of cached headers matching a local search. Bodies stay in the table.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedSearchPage {
    pub messages: Vec<LiveMessage>,
    pub boxes: Vec<String>,
    pub more: bool,
}

const SEARCH_HAY: &str = "lower(coalesce(fm.subject,'') || ' ' || coalesce(fm.from_name,'') || ' ' || coalesce(fm.from_email,'') || ' ' || coalesce(fm.preview,'') || ' ' || coalesce(fm.to_json,'') || ' ' || coalesce(fm.cc_json,'') || ' ' || coalesce(fm.bcc_json,'') || ' ' || coalesce(fm.files,'') || ' ' || :account)";

fn like_pattern(word: &str) -> String {
    let mut out = String::from("%");
    for ch in word.chars().take(80) {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('%');
    out
}

fn search_patterns(values: &[String], slots: usize) -> Vec<String> {
    let mut out = vec![String::new(); slots];
    let mut n = 0;
    for value in values {
        if n >= slots {
            break;
        }
        let word = value.trim().to_lowercase();
        if word.is_empty() {
            continue;
        }
        out[n] = like_pattern(&word);
        n += 1;
    }
    out
}

fn calendar_day(value: &str) -> String {
    let value = value.trim();
    let bytes = value.as_bytes();
    if value.len() == 10
        && bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && bytes.iter().all(|b| b.is_ascii_digit() || *b == b'-')
    {
        return value.to_string();
    }
    String::new()
}

/// Headers in one account whose subject, people, preview or file names match.
/// `box_key` empty searches every folder. `zone_offset` is JavaScript's
/// `getTimezoneOffset` (minutes to add to local time to get UTC).
pub fn search_cached(
    email: &str,
    box_key: &str,
    words: &[String],
    phrases: &[String],
    account_name: &str,
    from_day: &str,
    to_day: &str,
    zone_offset: i64,
    files: &str,
    unread_only: bool,
    read_only: bool,
    flagged_only: bool,
    invite_only: bool,
    limit: i64,
    before: &str,
    before_id: &str,
) -> Result<CachedSearchPage, String> {
    let conn = open()?;
    search_cached_on(
        &conn,
        email,
        box_key,
        words,
        phrases,
        account_name,
        from_day,
        to_day,
        zone_offset,
        files,
        unread_only,
        read_only,
        flagged_only,
        invite_only,
        limit,
        before,
        before_id,
    )
}

fn search_cached_on(
    conn: &Connection,
    email: &str,
    box_key: &str,
    words: &[String],
    phrases: &[String],
    account_name: &str,
    from_day: &str,
    to_day: &str,
    zone_offset: i64,
    files: &str,
    unread_only: bool,
    read_only: bool,
    flagged_only: bool,
    invite_only: bool,
    limit: i64,
    before: &str,
    before_id: &str,
) -> Result<CachedSearchPage, String> {
    let email = email.trim().to_lowercase();
    let box_key = box_key.trim();
    if email.is_empty() {
        return Ok(CachedSearchPage { messages: Vec::new(), boxes: Vec::new(), more: false });
    }
    let limit = if limit <= 0 { 100 } else { limit.min(200) };
    let fetch = limit + 1;
    let words = search_patterns(words, 8);
    let phrases = search_patterns(phrases, 4);
    let files = match files.trim() {
        "yes" | "no" => files.trim(),
        _ => "",
    };
    let offset = zone_offset.clamp(-14 * 60, 14 * 60);
    let zone = format!("{} minutes", -offset);
    let from_day = calendar_day(from_day);
    let to_day = calendar_day(to_day);
    let account = account_name.trim().to_lowercase();
    let mut sql = format!(
        "select fm.id, fm.thread, fm.subject, fm.from_name, fm.from_email, fm.received, fm.preview, '', fm.unread, fm.flagged, fm.attached, fm.files, fm.to_json, fm.cc_json, fm.bcc_json, fm.cats, fm.extra, f.box_key
         from folder_messages fm
         join folders f on f.email = fm.email and f.id = fm.folder_id
         where fm.email = :email
           and (:box = '' or f.box_key = :box)
           and (:before = '' or fm.received < :before or (fm.received = :before and fm.id < :before_id))
           and (:from_day = '' or date(fm.received, :zone) >= :from_day)
           and (:to_day = '' or date(fm.received, :zone) <= :to_day)
           and (:unread = 0 or fm.unread != 0)
           and (:read = 0 or fm.unread = 0)
           and (:flagged = 0 or fm.flagged != 0)
           and (:invite = 0 or instr(fm.extra, '\"invite\":true') > 0)"
    );
    for i in 0..8 {
        sql.push_str(&format!(" and (:w{i} = '' or {SEARCH_HAY} like :w{i} escape '\\')"));
    }
    for i in 0..4 {
        sql.push_str(&format!(" and (:p{i} = '' or {SEARCH_HAY} like :p{i} escape '\\')"));
    }
    sql.push_str(
        " and (
            :files = ''
            or (:files = 'yes' and exists (
                select 1 from folder_messages sib
                join folders sf on sf.email = sib.email and sf.id = sib.folder_id
                where sib.email = fm.email and sib.thread = fm.thread and sib.attached != 0
                  and (:box = '' or sf.box_key = :box)))
            or (:files = 'no' and not exists (
                select 1 from folder_messages sib
                join folders sf on sf.email = sib.email and sf.id = sib.folder_id
                where sib.email = fm.email and sib.thread = fm.thread and sib.attached != 0
                  and (:box = '' or sf.box_key = :box))))
          order by fm.received desc, fm.id desc
          limit :fetch",
    );
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map(
            named_params! {
                ":email": email,
                ":box": box_key,
                ":before": before.trim(),
                ":before_id": before_id.trim(),
                ":from_day": from_day,
                ":to_day": to_day,
                ":zone": zone,
                ":unread": unread_only as i64,
                ":read": read_only as i64,
                ":flagged": flagged_only as i64,
                ":invite": invite_only as i64,
                ":account": account,
                ":files": files,
                ":fetch": fetch,
                ":w0": &words[0], ":w1": &words[1], ":w2": &words[2], ":w3": &words[3],
                ":w4": &words[4], ":w5": &words[5], ":w6": &words[6], ":w7": &words[7],
                ":p0": &phrases[0], ":p1": &phrases[1], ":p2": &phrases[2], ":p3": &phrases[3],
            },
            |row| {
                let message = message_row(row)?;
                let box_key: String = row.get(17)?;
                Ok((message, box_key))
            },
        )
        .map_err(|err| err.to_string())?;
    let mut messages = Vec::new();
    let mut boxes = Vec::new();
    for row in rows {
        let (message, box_key) = row.map_err(|err| err.to_string())?;
        messages.push(message);
        boxes.push(box_key);
    }
    let more = messages.len() > limit as usize;
    if more {
        messages.truncate(limit as usize);
        boxes.truncate(limit as usize);
    }
    Ok(CachedSearchPage { messages, boxes, more })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connections_wait_and_sync_lightly() {
        let conn = Connection::open_in_memory().unwrap();
        tune(&conn).unwrap();
        let sync: i64 = conn.query_row("pragma synchronous", [], |row| row.get(0)).unwrap();
        let wait: i64 = conn.query_row("pragma busy_timeout", [], |row| row.get(0)).unwrap();
        assert_eq!((sync, wait), (1, 5000));
    }

    fn message(id: &str) -> LiveMessage {
        LiveMessage {
            id: id.into(),
            thread: id.into(),
            subject: "Subject".into(),
            from_name: "Ada".into(),
            from_email: "ada@example.com".into(),
            received: "2026-10-15T09:00:00Z".into(),
            preview: "Hi".into(),
            body_html: "<p>Hi</p>".into(),
            unread: true,
            flagged: false,
            has_attachments: true,
            files: vec![],
            to: vec![crate::graph::LivePerson { name: "Bea".into(), email: "bea@example.com".into() }],
            cc: vec![],
            bcc: vec![],
            categories: vec![],
            importance: String::new(),
            invite: false,
            focus: String::new(),
        }
    }

    #[test]
    fn a_sparse_delta_change_keeps_the_cached_subject_and_sender() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        let mut cached = message("keep");
        cached.focus = "focused".into();
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &[cached]).unwrap();

        let read = crate::graph::MessagePatch { id: "keep".into(), unread: Some(false), ..Default::default() };
        let stray = crate::graph::MessagePatch { id: "elsewhere".into(), unread: Some(false), ..Default::default() };
        let merged = patch_messages_on(&mut conn, "jon@example.com", "in", &[read, stray]).unwrap();
        assert_eq!(merged.len(), 1);
        let row = &merged[0];
        assert_eq!(row.subject, "Subject");
        assert_eq!(row.from_name, "Ada");
        assert_eq!(row.received, "2026-10-15T09:00:00Z");
        assert_eq!(row.focus, "focused");
        assert!(!row.unread);
        assert!(row.body_html.is_empty());

        let flag = crate::graph::MessagePatch {
            id: "keep".into(),
            flagged: Some(true),
            categories: Some(vec!["Blue".into()]),
            ..Default::default()
        };
        patch_messages_on(&mut conn, "jon@example.com", "in", &[flag]).unwrap();
        let rows = load_folder_messages(&conn, "jon@example.com", "in", true).unwrap();
        assert_eq!(rows[0].subject, "Subject");
        assert_eq!(rows[0].body_html, "<p>Hi</p>");
        assert!(!rows[0].unread, "a flag change must not undo the read state");
        assert!(rows[0].flagged);
        assert_eq!(rows[0].categories, vec!["Blue".to_string()]);
        assert_eq!(rows[0].focus, "focused");
    }

    fn folder(id: &str, parent: &str, key: &str) -> LiveFolder {
        LiveFolder {
            id: id.into(),
            parent_id: parent.into(),
            name: id.into(),
            key: key.into(),
            unread: 2,
            total: 5,
            depth: 0,
        }
    }

    #[test]
    fn importance_and_invites_survive_the_cache() {
        let mut item = message("x1");
        item.importance = "high".into();
        item.invite = true;
        let text = extra_text(&item);
        let mut back = message("x1");
        apply_extra(&mut back, &text);
        assert_eq!((back.importance.as_str(), back.invite), ("high", true));
        apply_extra(&mut back, "{}");
        assert_eq!((back.importance.as_str(), back.invite), ("", false));
    }

    #[test]
    fn forgotten_messages_leave_every_folder_of_that_account_only() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        replace_folders_on(&mut conn, "jon@example.com", &[folder("in", "root", "inbox")]).unwrap();
        replace_folders_on(&mut conn, "other@example.com", &[folder("in2", "root", "inbox")]).unwrap();
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &[message("invite"), message("keep")]).unwrap();
        replace_folder_messages_on(&mut conn, "other@example.com", "in2", &[message("invite")]).unwrap();
        let folders = forget_messages_on(&mut conn, "jon@example.com", &["invite".into(), " ".into()]).unwrap();
        assert_eq!(folders, vec!["in".to_string()]);
        let left = |email: &str| -> Vec<String> {
            let mut stmt = conn.prepare("select id from folder_messages where email = ?1 order by id").unwrap();
            stmt.query_map([email], |row| row.get(0)).unwrap().flatten().collect()
        };
        assert_eq!(left("jon@example.com"), vec!["keep".to_string()]);
        assert_eq!(left("other@example.com"), vec!["invite".to_string()]);
    }

    #[test]
    fn removed_folders_drop_only_their_cached_messages() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute(
            "insert into messages (id, thread, subject, from_name, from_email, received, preview, body_html, unread)
             values ('legacy', 'legacy', 'Keep', 'Ada', 'ada@example.com', '', '', '<p></p>', 0)",
            [],
        )
        .unwrap();
        replace_folders_on(
            &mut conn,
            "jon@example.com",
            &[folder("in", "root", "inbox"), folder("old", "root", "old")],
        )
        .unwrap();
        replace_folders_on(&mut conn, "other@example.com", &[folder("other", "root", "inbox")]).unwrap();
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &[message("keep")]).unwrap();
        replace_folder_messages_on(&mut conn, "jon@example.com", "old", &[message("gone")]).unwrap();
        replace_folder_messages_on(&mut conn, "other@example.com", "other", &[message("other")]).unwrap();

        replace_folders_on(&mut conn, "jon@example.com", &[folder("in", "root", "inbox"), folder("nest", "in", "nest")]).unwrap();

        let (folders, messages) = load_mailbox_on(&conn, "jon@example.com").unwrap().unwrap();
        let ids: Vec<_> = folders.iter().map(|item| item.id.clone()).collect();
        assert_eq!(ids, vec!["in", "nest"]);
        assert_eq!(folders[1].depth, 1);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, "keep");
        assert!(messages[0].has_attachments);
        assert_eq!(messages[0].to.len(), 1);
        assert_eq!(messages[0].to[0].email, "bea@example.com");
        let gone: i64 = conn
            .query_row(
                "select count(*) from folder_messages where id = 'gone'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(gone, 0);
        let other: i64 = conn
            .query_row(
                "select count(*) from folder_messages where email = 'other@example.com'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(other, 1);
        let legacy = load_legacy(&conn).unwrap();
        assert_eq!(legacy.len(), 1);
        assert_eq!(legacy[0].id, "legacy");
    }

    #[test]
    fn mail_actions_update_the_cached_row() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        replace_folders_on(
            &mut conn,
            "jon@example.com",
            &[folder("in", "root", "inbox"), folder("ar", "root", "archive"), folder("bin", "root", "trash")],
        )
        .unwrap();
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &[message("keep")]).unwrap();
        conn.execute(
            "insert into messages (id, thread, subject, from_name, from_email, received, preview, body_html, unread, flagged)
             values ('keep', 'keep', 'Subject', 'Ada', 'ada@example.com', '', '', '<p>Hi</p>', 1, 0)",
            [],
        )
        .unwrap();

        record_mail_action_on(&mut conn, "jon@example.com", "read", &["keep".into()]).unwrap();
        let (_, read) = load_mailbox_on(&conn, "jon@example.com").unwrap().unwrap();
        assert!(!read[0].unread);

        record_mail_action_on(&mut conn, "jon@example.com", "flag", &["keep".into()]).unwrap();
        let flagged: i64 = conn
            .query_row("select flagged from folder_messages where id = 'keep'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(flagged, 1);

        record_mail_action_on(&mut conn, "jon@example.com", "archive", &["keep".into()]).unwrap();
        let folder_id: String = conn
            .query_row("select folder_id from folder_messages where id = 'keep'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(folder_id, "ar");
        let legacy: i64 = conn
            .query_row("select count(*) from messages where id = 'keep'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(legacy, 0);

        record_mail_action_on(&mut conn, "jon@example.com", "trash", &["keep".into()]).unwrap();
        let trashed: String = conn
            .query_row("select folder_id from folder_messages where id = 'keep'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(trashed, "bin");
    }

    #[test]
    fn a_move_files_the_cached_row_and_keeps_it_unread() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        replace_folders_on(
            &mut conn,
            "jon@example.com",
            &[folder("in", "root", "inbox"), folder("jobs", "root", "jobs")],
        )
        .unwrap();
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &[message("keep"), message("gone")]).unwrap();
        record_move_on(&mut conn, "jon@example.com", "jobs", &["keep".into()]).unwrap();
        let folder_id: String = conn
            .query_row("select folder_id from folder_messages where id = 'keep'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(folder_id, "jobs");
        record_move_on(&mut conn, "jon@example.com", "not-synced-yet", &["gone".into()]).unwrap();
        let left: i64 = conn
            .query_row("select count(*) from folder_messages where id = 'gone'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn restoring_from_deleted_items_follows_the_new_id() {
        use crate::graph::MovedId;
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        replace_folders_on(
            &mut conn,
            "jon@example.com",
            &[folder("in", "root", "inbox"), folder("bin", "root", "trash")],
        )
        .unwrap();
        replace_folder_messages_on(&mut conn, "jon@example.com", "bin", &[message("old"), message("twice")]).unwrap();

        record_mail_action_on(&mut conn, "jon@example.com", "inbox", &["old".into()]).unwrap();
        rename_moved_on(&mut conn, "jon@example.com", &[MovedId { from: "old".into(), to: "new".into() }]).unwrap();
        let (folder_id, count): (String, i64) = conn
            .query_row(
                "select folder_id, (select count(*) from folder_messages where id = 'old') from folder_messages where id = 'new'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(folder_id, "in");
        assert_eq!(count, 0);

        // A sync that already stored the new id leaves one row, not two.
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &[message("new"), message("twice-new")]).unwrap();
        rename_moved_on(&mut conn, "jon@example.com", &[MovedId { from: "twice".into(), to: "twice-new".into() }]).unwrap();
        let rows: i64 = conn
            .query_row("select count(*) from folder_messages where id in ('twice', 'twice-new')", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    #[test]
    fn attachment_names_round_trip_and_survive_a_flag() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        replace_folders_on(&mut conn, "jon@example.com", &[folder("in", "root", "inbox")]).unwrap();
        let mut item = message("keep");
        item.files = vec![LiveFile {
            id: "f1".into(),
            name: "Tickets.pdf".into(),
            content_type: "application/pdf".into(),
            size: 1200,
        }];
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &[item]).unwrap();
        let (_, loaded) = load_mailbox_on(&conn, "jon@example.com").unwrap().unwrap();
        assert_eq!(loaded[0].files.len(), 1);
        assert_eq!(loaded[0].files[0].name, "Tickets.pdf");
        assert_eq!(loaded[0].files[0].content_type, "application/pdf");
        assert_eq!(loaded[0].files[0].size, 1200);
        record_mail_action_on(&mut conn, "jon@example.com", "flag", &["keep".into()]).unwrap();
        let (_, flagged) = load_mailbox_on(&conn, "jon@example.com").unwrap().unwrap();
        assert!(flagged[0].flagged);
        assert_eq!(flagged[0].files[0].name, "Tickets.pdf");
        save_message_files_on(&mut conn, "jon@example.com", "keep", &[]).unwrap();
        let (_, cleared) = load_mailbox_on(&conn, "jon@example.com").unwrap().unwrap();
        assert!(cleared[0].has_attachments);
        assert!(cleared[0].files.is_empty());
        save_message_files_on(
            &mut conn,
            "jon@example.com",
            "keep",
            &[LiveFile {
                id: "f2".into(),
                name: "Booking.pdf".into(),
                content_type: "application/pdf".into(),
                size: 8,
            }],
        )
        .unwrap();
        let (_, named) = load_mailbox_on(&conn, "jon@example.com").unwrap().unwrap();
        assert_eq!(named[0].files[0].name, "Booking.pdf");
        assert!(named[0].has_attachments);
    }

    #[test]
    fn cached_drafts_stay_out_of_the_inbox_load() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        replace_folders_on(
            &mut conn,
            "jon@example.com",
            &[folder("in", "root", "inbox"), folder("dr", "root", "drafts")],
        )
        .unwrap();
        let mut inbox = message("in-mail");
        inbox.thread = "paint".into();
        let mut draft = message("draft-mail");
        draft.thread = "paint".into();
        draft.subject = "Re: Paint".into();
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &[inbox]).unwrap();
        replace_folder_messages_on(&mut conn, "jon@example.com", "dr", &[draft]).unwrap();
        let (_, inbox_only) = load_mailbox_on(&conn, "jon@example.com").unwrap().unwrap();
        assert_eq!(inbox_only.len(), 1);
        assert_eq!(inbox_only[0].id, "in-mail");
        let drafts = load_box_messages_on(&conn, "Jon@Example.com", "drafts", true).unwrap();
        assert_eq!(drafts.len(), 1);
        assert_eq!(drafts[0].id, "draft-mail");
        assert_eq!(drafts[0].thread, "paint");
        assert!(!drafts[0].body_html.is_empty());
        let listed = load_box_messages_on(&conn, "jon@example.com", "drafts", false).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].body_html.is_empty());
        assert_eq!(
            load_message_body_on(&conn, "jon@example.com", "draft-mail").unwrap(),
            drafts[0].body_html
        );
        assert!(load_box_messages_on(&conn, "jon@example.com", "sent", false).unwrap().is_empty());
    }

    #[test]
    fn incremental_sync_keeps_cached_bodies_and_the_rest_of_the_folder() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        replace_folders_on(
            &mut conn,
            "jon@example.com",
            &[folder("in", "root", "inbox"), folder("sent", "root", "sent")],
        )
        .unwrap();
        let mut kept = message("keep");
        kept.files = vec![LiveFile {
            id: "f1".into(),
            name: "Plan.pdf".into(),
            content_type: "application/pdf".into(),
            size: 40,
        }];
        kept.received = "2026-10-20T15:00:00Z".into();
        let mut older = message("older");
        older.received = "2026-09-01T15:00:00Z".into();
        older.unread = false;
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &[kept, older]).unwrap();
        replace_folder_messages_on(&mut conn, "jon@example.com", "sent", &[message("sent-one")]).unwrap();

        assert_eq!(cached_inbox_id_on(&conn, "Jon@Example.com").unwrap().as_deref(), Some("in"));
        assert_eq!(cached_inbox_id_on(&conn, "other@example.com").unwrap(), None);
        let state = folder_sync_state_on(&conn, "jon@example.com", "in").unwrap();
        assert_eq!(state.messages, 2);
        assert_eq!(state.newest.as_deref(), Some("2026-10-20T15:00:00Z"));
        assert_eq!(state.delta_link, None);

        let mut changed = message("keep");
        changed.body_html.clear();
        changed.preview = "Updated".into();
        changed.unread = false;
        changed.files.clear();
        changed.has_attachments = true;
        changed.to.clear();
        let mut arrived = message("new");
        arrived.received = "2026-10-20T16:00:00Z".into();
        arrived.body_html = "<p>New</p>".into();
        let link = "https://graph.microsoft.com/v1.0/me/mailFolders/in/messages/delta?$deltatoken=abc";
        apply_delta_on(&mut conn, "jon@example.com", "in", &["missing".into()], &[changed, arrived], link).unwrap();

        let (_, full) = load_mailbox_on(&conn, "jon@example.com").unwrap().unwrap();
        let keep = full.iter().find(|item| item.id == "keep").unwrap();
        assert_eq!(keep.body_html, "<p>Hi</p>");
        assert_eq!(keep.preview, "Updated");
        assert!(!keep.unread);
        assert_eq!(keep.files.len(), 1);
        assert_eq!(keep.files[0].name, "Plan.pdf");
        assert_eq!(keep.to.len(), 1);
        assert!(full.iter().any(|item| item.id == "older"));
        let arrived = full.iter().find(|item| item.id == "new").unwrap();
        assert_eq!(arrived.body_html, "<p>New</p>");
        let (_, headers) = load_mailbox_view(&conn, "jon@example.com", false).unwrap().unwrap();
        assert!(headers.iter().all(|item| item.body_html.is_empty()));
        assert_eq!(headers.len(), 3);
        let sent = load_folder_messages(&conn, "jon@example.com", "sent", true).unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(load_delta_link_on(&conn, "jon@example.com", "in").unwrap().as_deref(), Some(link));

        let mut cleared = message("keep");
        cleared.has_attachments = false;
        cleared.files.clear();
        cleared.body_html = "<p>Next</p>".into();
        upsert_folder_messages_on(&mut conn, "jon@example.com", "in", &[cleared]).unwrap();
        let (_, next) = load_mailbox_on(&conn, "jon@example.com").unwrap().unwrap();
        let keep = next.iter().find(|item| item.id == "keep").unwrap();
        assert_eq!(keep.body_html, "<p>Next</p>");
        assert!(keep.files.is_empty());
        assert!(!keep.has_attachments);

        apply_delta_on(&mut conn, "jon@example.com", "in", &["older".into()], &[], "").unwrap();
        let (_, left) = load_mailbox_on(&conn, "jon@example.com").unwrap().unwrap();
        assert!(left.iter().all(|item| item.id != "older"));
        assert_eq!(load_delta_link_on(&conn, "jon@example.com", "in").unwrap().as_deref(), Some(link));
        let unread: i64 = conn
            .query_row("select unread from folders where email = 'jon@example.com' and id = 'in'", [], |row| row.get(0))
            .unwrap();
        let total: i64 = conn
            .query_row("select total from folders where email = 'jon@example.com' and id = 'in'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(total, 2);
        assert_eq!(unread, left.iter().filter(|item| item.unread).count() as i64);

        let bad = save_delta_link_on(
            &mut conn,
            "jon@example.com",
            "in",
            "https://evil.example/messages/delta?$deltatoken=abc",
        );
        assert!(bad.is_err());
        assert_eq!(load_delta_link_on(&conn, "jon@example.com", "in").unwrap().as_deref(), Some(link));
        clear_delta_link_on(&mut conn, "jon@example.com", "in").unwrap();
        assert_eq!(load_delta_link_on(&conn, "jon@example.com", "in").unwrap(), None);
        let other = folder_sync_state_on(&conn, "other@example.com", "in").unwrap();
        assert_eq!(other.messages, 0);
        assert_eq!(other.delta_link, None);
    }

    #[test]
    fn newest_page_is_received_desc_and_the_next_page_follows_the_cursor() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        replace_folders_on(&mut conn, "jon@example.com", &[folder("in", "root", "inbox")]).unwrap();
        let mut oldest = message("a");
        oldest.received = "2026-10-01T00:00:00Z".into();
        let mut middle = message("b");
        middle.received = "2026-10-02T00:00:00Z".into();
        let mut newest = message("c");
        newest.received = "2026-10-03T00:00:00Z".into();
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &[oldest, middle, newest]).unwrap();

        let page = load_box_page_on(&conn, "Jon@Example.com", "inbox", false, 2, "", "").unwrap();
        assert_eq!(page.messages.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), vec!["c", "b"]);
        assert!(page.more);
        assert!(page.messages.iter().all(|item| item.body_html.is_empty()));

        let cursor = &page.messages[1];
        let next = load_folder_page_on(&conn, "jon@example.com", "in", true, 2, &cursor.received, &cursor.id).unwrap();
        assert_eq!(next.messages.len(), 1);
        assert_eq!(next.messages[0].id, "a");
        assert!(!next.messages[0].body_html.is_empty());
        assert!(!next.more);

        let whole = load_folder_page_on(&conn, "jon@example.com", "in", false, 0, "", "").unwrap();
        assert_eq!(whole.messages.len(), 3);
        assert!(!whole.more);

        let index: String = conn
            .query_row(
                "select sql from sqlite_master where type = 'index' and name = 'folder_messages_by_received'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(index.to_lowercase().contains("received"));
    }

    #[test]
    fn cached_search_matches_headers_and_pages() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        replace_folders_on(
            &mut conn,
            "jon@example.com",
            &[folder("in", "root", "inbox"), folder("out", "root", "sent")],
        )
        .unwrap();
        let mut kiln = message("k");
        kiln.subject = "Kiln schedule".into();
        kiln.received = "2026-10-03T12:00:00Z".into();
        kiln.has_attachments = false;
        kiln.body_html = "<p>secret kiln body words</p>".into();
        let mut plans = message("p");
        plans.subject = "Site plans".into();
        plans.thread = "plans".into();
        plans.received = "2026-10-02T12:00:00Z".into();
        plans.has_attachments = false;
        let mut file = message("f");
        file.subject = "See attached".into();
        file.thread = "plans".into();
        file.received = "2026-10-01T12:00:00Z".into();
        file.has_attachments = true;
        file.files = vec![LiveFile {
            id: "a".into(),
            name: "drawing.pdf".into(),
            content_type: "application/pdf".into(),
            size: 10,
        }];
        let mut sent = message("s");
        sent.subject = "Kiln invoice".into();
        sent.received = "2026-10-04T12:00:00Z".into();
        sent.has_attachments = false;
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &[kiln, plans, file]).unwrap();
        replace_folder_messages_on(&mut conn, "jon@example.com", "out", &[sent]).unwrap();

        let args = |words: &[&str], phrases: &[&str], box_key: &str, files: &str, limit: i64, before: &str, before_id: &str| {
            search_cached_on(
                &conn,
                "Jon@Example.com",
                box_key,
                &words.iter().map(|word| (*word).to_string()).collect::<Vec<_>>(),
                &phrases.iter().map(|word| (*word).to_string()).collect::<Vec<_>>(),
                "Jon",
                "",
                "",
                0,
                files,
                false,
                false,
                false,
                false,
                limit,
                before,
                before_id,
            )
            .unwrap()
        };
        let ids = |page: &CachedSearchPage| -> Vec<String> {
            page.messages.iter().map(|item| item.id.clone()).collect()
        };

        let kiln_inbox = args(&["kiln"], &[], "inbox", "", 100, "", "");
        assert_eq!(ids(&kiln_inbox), vec!["k".to_string()]);
        assert!(kiln_inbox.messages[0].body_html.is_empty());
        assert_eq!(kiln_inbox.boxes, vec!["inbox".to_string()]);

        let kiln_all = args(&["kiln"], &[], "", "", 100, "", "");
        assert_eq!(ids(&kiln_all), vec!["s".to_string(), "k".to_string()]);

        let with_file = args(&["site"], &[], "inbox", "yes", 100, "", "");
        assert_eq!(ids(&with_file), vec!["p".to_string()]);

        let phrase = args(&[], &["kiln schedule"], "inbox", "", 100, "", "");
        assert_eq!(ids(&phrase), vec!["k".to_string()]);

        assert!(ids(&args(&["secret"], &[], "", "", 100, "", "")).is_empty());

        let first = args(&[], &[], "", "", 1, "", "");
        assert_eq!(ids(&first), vec!["s".to_string()]);
        assert!(first.more);
        let next = args(&[], &[], "", "", 10, &first.messages[0].received, "s");
        assert_eq!(ids(&next), vec!["k".to_string(), "p".to_string(), "f".to_string()]);
        assert!(!next.more);
    }
}
