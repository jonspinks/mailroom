use crate::graph::{LiveFile, LiveFolder, LiveMessage};
use rusqlite::{params, Connection};
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
    add_body_text(conn)?;
    repair_latin1_bodies(conn)?;
    // Newest-page reads are email + folder + received. The list asks for that
    // slice on every open, so keep it an index seek as the mailbox grows.
    conn.execute_batch(
        "create index if not exists folder_messages_by_received
         on folder_messages (email, folder_id, received desc, id desc);
         create index if not exists folder_messages_by_thread
         on folder_messages (email, thread);",
    )
    .map_err(|err| err.to_string())?;
    add_search_index(conn)?;
    // A new cache gets the unread index at once. One that already holds mail
    // gets it from catch_up, off the launch path: building it reads every row.
    let empty: bool = conn
        .query_row("select not exists (select 1 from folder_messages)", [], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    if empty {
        conn.execute_batch(UNREAD_INDEX).map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// Folder counts ask for the unread rows of one folder after every sync.
/// Without this each count read `unread` from the row itself, which sits
/// behind the body, so it walked every body in the folder.
const UNREAD_INDEX: &str = "create index if not exists folder_messages_unread
     on folder_messages (email, folder_id, unread) where unread != 0";

/// The text search looks through: the headers `SEARCH_HAY` reads, without the
/// account name, which is the reader's and not the message's.
macro_rules! search_head {
    () => {
        "coalesce(fm.subject,'') || ' ' || coalesce(fm.from_name,'') || ' ' || coalesce(fm.from_email,'') || ' ' || coalesce(fm.preview,'') || ' ' || coalesce(fm.to_json,'') || ' ' || coalesce(fm.cc_json,'') || ' ' || coalesce(fm.bcc_json,'') || ' ' || coalesce(fm.files,'')"
    };
}

/// What the search index holds for one message: its headers and its body text.
const SEARCH_INDEXED: &str = concat!(search_head!(), " || ' ' || coalesce(fm.body_text,'')");

/// The search index (2026-11). `message_search` maps every three-letter run
/// in a message's headers and body text to the row that has it, so a search
/// reads the few rows that could match instead of every body in the account.
/// It only narrows: the LIKE tests in `search_cached_on` still decide, so a
/// search finds exactly what it found before.
///
/// The triggers do not index. They note the row in `search_dirty`, and
/// `index_search_batch` indexes noted rows a few at a time. A search reads
/// noted rows as well as indexed ones, so it is right at any moment: just
/// after a write, half way through the first fill, or after a kill. An
/// existing cache starts with every row noted and is filled in behind the
/// window. The triggers name only plain tables, so a build from before the
/// index can still write this file.
///
/// Rows are known by rowid. `folder_messages` has no integer key of its own,
/// so VACUUM may renumber it: never VACUUM this file without emptying
/// `message_search` and noting every row again.
fn add_search_index(conn: &Connection) -> Result<(), String> {
    let have = |conn: &Connection| -> Result<bool, String> {
        conn.query_row(
            "select count(*) from sqlite_master where name in
             ('message_search', 'search_dirty', 'folder_messages_search_new', 'folder_messages_search_gone',
              'folder_messages_search_head', 'folder_messages_search_body')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count == 6)
        .map_err(|err| err.to_string())
    };
    if have(conn)? {
        return Ok(());
    }
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| err.to_string())?;
    if have(&tx)? {
        return Ok(());
    }
    let note = |row: &str| format!("insert into search_dirty (id) select {row}.rowid where not exists (select 1 from search_dirty where id = {row}.rowid);");
    let changed = ["subject", "from_name", "from_email", "preview", "to_json", "cc_json", "bcc_json", "files"]
        .map(|name| format!("old.{name} is not new.{name}"))
        .join(" or ");
    tx.execute_batch(&format!(
        "create virtual table if not exists message_search using fts5(
             text, content='', contentless_delete=1, detail=none, tokenize='trigram');
         create table if not exists search_dirty (id integer primary key);
         create trigger if not exists folder_messages_search_new after insert on folder_messages
         begin {new} end;
         create trigger if not exists folder_messages_search_gone after delete on folder_messages
         begin {old} end;
         create trigger if not exists folder_messages_search_head
         after update of subject, from_name, from_email, preview, to_json, cc_json, bcc_json, files on folder_messages
         when {changed}
         begin {new} end;
         create trigger if not exists folder_messages_search_body after update of body_text on folder_messages
         begin {new} end;
         delete from message_search;
         delete from search_dirty;
         insert into search_dirty (id) select rowid from folder_messages;",
        new = note("new"),
        old = note("old"),
    ))
    .map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())
}

/// Most rows one batch indexes, and about how long it may hold the write lock.
const SEARCH_BATCH_ROWS: usize = 400;
const SEARCH_BATCH_TIME: std::time::Duration = std::time::Duration::from_millis(25);

/// Index some of the rows the triggers noted. True when more are waiting.
/// One transaction: a row leaves `search_dirty` only with its index entry
/// written, so a kill half way loses nothing.
fn index_search_batch(conn: &mut Connection) -> Result<bool, String> {
    let waiting: bool = conn
        .prepare_cached("select exists (select 1 from search_dirty)")
        .and_then(|mut stmt| stmt.query_row([], |row| row.get(0)))
        .map_err(|err| err.to_string())?;
    if !waiting {
        return Ok(false);
    }
    let started = std::time::Instant::now();
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    let ids = {
        let mut stmt = tx
            .prepare_cached("select id from search_dirty order by id limit ?1")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([SEARCH_BATCH_ROWS as i64 + 1], |row| row.get::<_, i64>(0))
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())?
    };
    let mut more = ids.len() > SEARCH_BATCH_ROWS;
    {
        let mut forget = tx.prepare_cached("delete from message_search where rowid = ?1").map_err(|err| err.to_string())?;
        // Nothing is written for a row that has since been deleted.
        let mut index = tx
            .prepare_cached(&format!(
                "insert into message_search (rowid, text) select fm.rowid, {SEARCH_INDEXED} from folder_messages fm where fm.rowid = ?1"
            ))
            .map_err(|err| err.to_string())?;
        let mut done = tx.prepare_cached("delete from search_dirty where id = ?1").map_err(|err| err.to_string())?;
        for (n, id) in ids.iter().take(SEARCH_BATCH_ROWS).enumerate() {
            if n > 0 && started.elapsed() > SEARCH_BATCH_TIME {
                more = true;
                break;
            }
            forget.execute([id]).map_err(|err| err.to_string())?;
            index.execute([id]).map_err(|err| err.to_string())?;
            done.execute([id]).map_err(|err| err.to_string())?;
        }
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(more)
}

/// One step of the work that is kept off the launch path. True when there is more.
fn catch_up(conn: &mut Connection) -> Result<bool, String> {
    conn.execute_batch(UNREAD_INDEX).map_err(|err| err.to_string())?;
    index_search_batch(conn)
}

/// Gmail mail cached before 1.3.21 was decoded as Latin-1 when its bytes were
/// UTF-8, and the cache shows that copy rather than fetching again, so every
/// non-breaking space stayed "Â ". Put those back once (user_version 1).
fn repair_latin1_bodies(conn: &Connection) -> Result<(), String> {
    let done: i64 = conn.query_row("pragma user_version", [], |row| row.get(0)).map_err(|err| err.to_string())?;
    if done >= 1 {
        return Ok(());
    }
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| err.to_string())?;
    let done: i64 = tx.query_row("pragma user_version", [], |row| row.get(0)).map_err(|err| err.to_string())?;
    if done >= 1 {
        return Ok(());
    }
    // Â and Ã start the two-byte letters, â the quotes and dashes.
    let suspect = "(body_html like '%Â%' or body_html like '%Ã%' or body_html like '%â%')";
    for table in ["folder_messages", "messages"] {
        let rows = {
            let mut stmt = tx
                .prepare(&format!("select rowid, body_html, preview from {table} where {suspect}"))
                .map_err(|err| err.to_string())?;
            let found = stmt
                .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
                .map_err(|err| err.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|err| err.to_string())?;
            found
        };
        for (rowid, html, preview) in rows {
            let Some(fixed) = crate::google::undo_latin1(&html) else { continue };
            let preview = crate::google::undo_latin1(&preview).unwrap_or(preview);
            tx.execute(&format!("update {table} set body_html = ?1, preview = ?2 where rowid = ?3"), rusqlite::params![fixed, preview, rowid])
                .map_err(|err| err.to_string())?;
            if table == "folder_messages" {
                tx.execute("update folder_messages set body_text = ?1 where rowid = ?2", rusqlite::params![search_text(&fixed), rowid])
                    .map_err(|err| err.to_string())?;
            }
        }
    }
    tx.execute_batch("pragma user_version = 1").map_err(|err| err.to_string())?;
    tx.commit().map_err(|err| err.to_string())
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

/// The body as plain text, so search matches words in the mail and not in
/// its markup. Filled once for mail cached before the column existed.
fn add_body_text(conn: &Connection) -> Result<(), String> {
    let count: i64 = conn
        .query_row("select count(*) from pragma_table_info('folder_messages') where name = 'body_text'", [], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    if count > 0 {
        return Ok(());
    }
    // Take the write lock first and look again: another connection opening
    // at the same moment may have just added it.
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| err.to_string())?;
    let count: i64 = tx
        .query_row("select count(*) from pragma_table_info('folder_messages') where name = 'body_text'", [], |row| row.get(0))
        .map_err(|err| err.to_string())?;
    if count > 0 {
        return Ok(());
    }
    tx.execute("alter table folder_messages add column body_text text not null default ''", [])
        .map_err(|err| err.to_string())?;
    let bodies = {
        let mut stmt = tx
            .prepare("select email, id, body_html from folder_messages where body_html != ''")
            .map_err(|err| err.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
            .map_err(|err| err.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|err| err.to_string())?
    };
    {
        let mut update = tx
            .prepare("update folder_messages set body_text = ?3 where email = ?1 and id = ?2")
            .map_err(|err| err.to_string())?;
        for (email, id, html) in &bodies {
            update.execute(params![email, id, search_text(html)]).map_err(|err| err.to_string())?;
        }
    }
    tx.commit().map_err(|err| err.to_string())
}

/// Longest body text kept for search, in bytes.
const SEARCH_TEXT_MAX: usize = 100_000;

fn search_text(html: &str) -> String {
    if html.is_empty() {
        return String::new();
    }
    let text = crate::graph::html_to_text(html);
    let mut out = String::with_capacity(text.len().min(SEARCH_TEXT_MAX));
    for word in text.split_whitespace() {
        if out.len() + word.len() + 1 > SEARCH_TEXT_MAX {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
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

/// The connections to one cache file, opened once and kept for the life of
/// the app. Opening one per call meant parsing the schema, the pragmas and
/// the chmods every time, and closing the last one checkpointed the WAL.
///
/// Writes share one connection, so they queue here instead of on SQLite's
/// lock. Reads have their own (WAL lets them run beside a write), and search
/// has a third, so a slow search never holds up the message list.
struct Store {
    writer: std::sync::Mutex<Connection>,
    reader: std::sync::Mutex<Connection>,
    searcher: std::sync::Mutex<Connection>,
    /// Raised after a write, which may have left rows for the search index.
    stirred: std::sync::Mutex<bool>,
    bell: std::sync::Condvar,
}

/// One store per file. The path follows HOME, which tests point elsewhere.
static STORES: std::sync::Mutex<Vec<(std::path::PathBuf, &'static Store)>> = std::sync::Mutex::new(Vec::new());

/// A panic elsewhere while a connection was held does not spoil it: an
/// unfinished transaction rolled back as it unwound.
fn hold<T>(lock: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn store() -> Result<&'static Store, String> {
    store_at(db_path())
}

fn store_at(path: std::path::PathBuf) -> Result<&'static Store, String> {
    let mut stores = hold(&STORES);
    if let Some((_, found)) = stores.iter().find(|(known, _)| *known == path) {
        return Ok(found);
    }
    // The schema is checked here, once per file, with the list held: a second
    // caller waits for the first instead of racing it.
    let opened: &'static Store = Box::leak(Box::new(open_store(&path)?));
    stores.push((path, opened));
    let _ = std::thread::Builder::new().name("mail-cache".into()).spawn(move || tend(opened));
    Ok(opened)
}

fn open_store(path: &std::path::Path) -> Result<Store, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    let writer = Connection::open(path).map_err(|err| err.to_string())?;
    tune(&writer)?;
    // WAL: reads don't wait behind backfill writes, and a write is one
    // append instead of a journal plus the database. It stays set in the file.
    writer.query_row("pragma journal_mode = wal", [], |_| Ok(())).map_err(|err| err.to_string())?;
    ensure_schema(&writer)?;
    let reader = open_reader(path)?;
    let searcher = open_reader(path)?;
    keep_private(path);
    Ok(Store {
        writer: std::sync::Mutex::new(writer),
        reader: std::sync::Mutex::new(reader),
        searcher: std::sync::Mutex::new(searcher),
        stirred: std::sync::Mutex::new(true),
        bell: std::sync::Condvar::new(),
    })
}

fn open_reader(path: &std::path::Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|err| err.to_string())?;
    tune(&conn)?;
    conn.pragma_update(None, "query_only", true).map_err(|err| err.to_string())?;
    Ok(conn)
}

/// The write connection for one call. Dropping it wakes `tend`.
struct Writing {
    conn: std::sync::MutexGuard<'static, Connection>,
    store: &'static Store,
}

impl std::ops::Deref for Writing {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.conn
    }
}

impl std::ops::DerefMut for Writing {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }
}

impl Drop for Writing {
    fn drop(&mut self) {
        *hold(&self.store.stirred) = true;
        self.store.bell.notify_one();
    }
}

// None of these is held across a network call or another store call: every
// `pub fn` here takes one, does its SQL and lets go before it returns.
fn writing() -> Result<Writing, String> {
    Ok(writing_to(store()?))
}

fn writing_to(store: &'static Store) -> Writing {
    Writing { conn: hold(&store.writer), store }
}

fn reading() -> Result<std::sync::MutexGuard<'static, Connection>, String> {
    Ok(hold(&store()?.reader))
}

fn searching() -> Result<std::sync::MutexGuard<'static, Connection>, String> {
    Ok(hold(&store()?.searcher))
}

/// The cache's own thread. After a write it runs `catch_up` in short steps,
/// letting go of the write connection between them so a sync or a mail
/// action is never kept waiting for long. The one long step is building the
/// unread index on a cache from before it: that reads the whole file once,
/// and writes wait for it while reads carry on.
fn tend(store: &'static Store) {
    loop {
        {
            let mut stirred = hold(&store.stirred);
            while !*stirred {
                stirred = store.bell.wait(stirred).unwrap_or_else(|poisoned| poisoned.into_inner());
            }
            *stirred = false;
        }
        // An error waits for the next write rather than spinning on it.
        loop {
            let more = catch_up(&mut hold(&store.writer));
            if !matches!(more, Ok(true)) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
}

/// Per connection. NORMAL is safe with WAL: a power cut can lose the last
/// writes, never corrupt the file, and this cache refills from the server.
/// The timeout makes a second writer wait its turn instead of failing.
/// Sorts and search lists stay in memory, 8 MB of pages are kept, and up to
/// 64 MB of the file is read through the page cache without a copy.
fn tune(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|err| err.to_string())?;
    conn.pragma_update(None, "synchronous", "NORMAL").map_err(|err| err.to_string())?;
    conn.execute_batch("pragma temp_store = memory; pragma cache_size = -8000; pragma mmap_size = 67108864;")
        .map_err(|err| err.to_string())?;
    // The list, sync and search statements are kept prepared between calls.
    conn.set_prepared_statement_cache_capacity(64);
    Ok(())
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
    let mut conn = writing()?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    tx.execute("delete from messages", []).map_err(|err| err.to_string())?;
    for item in items {
        insert_legacy(&tx, item)?;
    }
    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

pub fn load_inbox() -> Result<Vec<LiveMessage>, String> {
    let conn = reading()?;
    load_legacy(&conn)
}

pub fn replace_folders(email: &str, folders: &[LiveFolder]) -> Result<(), String> {
    let mut conn = writing()?;
    replace_folders_on(&mut conn, email, folders)
}

pub fn replace_folder_messages(email: &str, folder_id: &str, items: &[LiveMessage]) -> Result<(), String> {
    let mut conn = writing()?;
    replace_folder_messages_on(&mut conn, email, folder_id, items)
}

pub fn record_mail_action(email: &str, kind: &str, ids: &[String]) -> Result<(), String> {
    let mut conn = writing()?;
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
    let mut conn = writing()?;
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

/// Everything cached for one account, for when it signs out. Nothing called
/// this before 2026-11, so a signed-out account's mail stayed in the file.
/// The old single-inbox table has no account column, so it loses the rows
/// this account also holds. The search index follows through its triggers.
/// The file does not shrink (see add_search_index on VACUUM); the freed
/// pages are used again.
#[allow(dead_code)]
pub fn forget_account(email: &str) -> Result<(), String> {
    let email = email.trim().to_lowercase();
    if email.is_empty() {
        return Ok(());
    }
    let mut conn = writing()?;
    forget_account_on(&mut conn, &email)
}

fn forget_account_on(conn: &mut Connection, email: &str) -> Result<(), String> {
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    tx.execute("delete from messages where id in (select id from folder_messages where email = ?1)", [email])
        .map_err(|err| err.to_string())?;
    for table in ["folder_messages", "folders", "folder_delta"] {
        tx.execute(&format!("delete from {table} where email = ?1"), [email]).map_err(|err| err.to_string())?;
    }
    tx.commit().map_err(|err| err.to_string())
}

/// Record a move to any folder. A folder this computer has not seen is
/// left to the next sync.
pub fn record_move(email: &str, folder_id: &str, ids: &[String]) -> Result<(), String> {
    let mut conn = writing()?;
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
    let mut conn = writing()?;
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
    let conn = reading()?;
    load_message_body_on(&conn, email, message_id)
}

pub fn cached_inbox_id(email: &str) -> Result<Option<String>, String> {
    let conn = reading()?;
    cached_inbox_id_on(&conn, email)
}

/// One cached message's header and the folder it is in, for a mailroom: link.
pub fn find_message(email: &str, message_id: &str) -> Result<Option<(LiveMessage, String)>, String> {
    let conn = reading()?;
    find_message_on(&conn, email, message_id)
}

fn find_message_on(conn: &Connection, email: &str, message_id: &str) -> Result<Option<(LiveMessage, String)>, String> {
    let email = email.trim().to_lowercase();
    let message_id = message_id.trim();
    if email.is_empty() || message_id.is_empty() {
        return Ok(None);
    }
    let mut stmt = conn
        .prepare(
            "select id, thread, subject, from_name, from_email, received, preview, '', unread, flagged, attached, files, to_json, cc_json, bcc_json, cats, extra, folder_id
             from folder_messages where email = ?1 and id = ?2 limit 1",
        )
        .map_err(|err| err.to_string())?;
    let mut rows = stmt.query(params![email, message_id]).map_err(|err| err.to_string())?;
    let Some(row) = rows.next().map_err(|err| err.to_string())? else { return Ok(None) };
    let message = message_row(row).map_err(|err| err.to_string())?;
    let folder: String = row.get(17).map_err(|err| err.to_string())?;
    Ok(Some((message, folder)))
}

pub fn folder_sync_state(email: &str, folder_id: &str) -> Result<FolderSyncState, String> {
    let conn = reading()?;
    folder_sync_state_on(&conn, email, folder_id)
}

pub fn load_delta_link(email: &str, folder_id: &str) -> Result<Option<String>, String> {
    let conn = reading()?;
    load_delta_link_on(&conn, email, folder_id)
}

pub fn save_delta_link(email: &str, folder_id: &str, link: &str) -> Result<(), String> {
    let mut conn = writing()?;
    save_delta_link_on(&mut conn, email, folder_id, link)
}

pub fn clear_delta_link(email: &str, folder_id: &str) -> Result<(), String> {
    let mut conn = writing()?;
    clear_delta_link_on(&mut conn, email, folder_id)
}

pub fn upsert_folder_messages(email: &str, folder_id: &str, items: &[LiveMessage]) -> Result<(), String> {
    let mut conn = writing()?;
    upsert_folder_messages_on(&mut conn, email, folder_id, items)
}

pub fn apply_delta(
    email: &str,
    folder_id: &str,
    removed: &[String],
    changed: &[LiveMessage],
    link: &str,
) -> Result<(), String> {
    let mut conn = writing()?;
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
    let mut conn = writing()?;
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
        let found = tx
            .prepare_cached(
                "select id, thread, subject, from_name, from_email, received, preview, '', unread, flagged, attached, files, to_json, cc_json, bcc_json, cats, extra
                 from folder_messages where email = ?1 and folder_id = ?2 and id = ?3",
            )
            .and_then(|mut stmt| stmt.query_row(params![email, folder_id, patch.id.trim()], message_row));
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
    let mut conn = writing()?;
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
    let mut conn = writing()?;
    let tx = conn.transaction().map_err(|err| err.to_string())?;
    refresh_counts_tx(&tx, &email, folder_id)?;
    tx.commit().map_err(|err| err.to_string())?;
    Ok(())
}

pub fn load_folder_headers(email: &str, folder_id: &str) -> Result<Vec<LiveMessage>, String> {
    let conn = reading()?;
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
    let conn = reading()?;
    Ok(load_folders_on(&conn, email.trim().to_lowercase().as_str())?.unwrap_or_default())
}

/// Newest inbox messages, plus the folder list. `None` when this account has no cached folders.
pub fn load_inbox_page(email: &str, limit: i64) -> Result<Option<(Vec<LiveFolder>, MessagePage)>, String> {
    let conn = reading()?;
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
    let conn = reading()?;
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
    let conn = reading()?;
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
    let mut insert = tx
        .prepare_cached(
            "insert or replace into folder_messages
             (email, folder_id, id, thread, subject, from_name, from_email, received, preview, body_html, unread, flagged, attached, files, to_json, cc_json, bcc_json, cats, extra, body_text)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        )
        .map_err(|err| err.to_string())?;
    for item in items {
        insert
            .execute(params![
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
                extra_text(item),
                search_text(&item.body_html)
            ])
            .map_err(|err| err.to_string())?;
    }
    drop(insert);
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
        .prepare_cached("select count(*) from folders where email = ?1")
        .and_then(|mut stmt| stmt.query_row([email], |row| row.get(0)))
        .map_err(|err| err.to_string())?;
    if count == 0 {
        return Ok(None);
    }
    let mut stmt = conn
        .prepare_cached(
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
        .prepare_cached("select count(*) from folder_messages where email = ?1 and folder_id = ?2")
        .and_then(|mut stmt| stmt.query_row(params![email, folder_id], |row| row.get(0)))
        .map_err(|err| err.to_string())?;
    let newest = optional_string(
        conn.prepare_cached(
            "select received from folder_messages
             where email = ?1 and folder_id = ?2 and received != ''
             order by received desc limit 1",
        )
        .and_then(|mut stmt| stmt.query_row(params![email, folder_id], |row| row.get(0))),
    )?;
    let delta_link = load_delta_link_on(conn, &email, folder_id)?;
    Ok(FolderSyncState { messages, newest, delta_link })
}

fn load_delta_link_on(conn: &Connection, email: &str, folder_id: &str) -> Result<Option<String>, String> {
    let email = email.trim().to_lowercase();
    let folder_id = folder_id.trim();
    if email.is_empty() || folder_id.is_empty() {
        return Ok(None);
    }
    optional_string(
        conn.prepare_cached("select delta_link from folder_delta where email = ?1 and folder_id = ?2")
            .and_then(|mut stmt| stmt.query_row(params![email, folder_id], |row| row.get(0))),
    )
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
    // The unread count is answered by UNREAD_INDEX, the total by
    // folder_messages_by_received: neither opens a message row.
    tx.prepare_cached(
        "update folders set
            unread = (select count(*) from folder_messages where email = ?1 and folder_id = ?2 and unread != 0),
            total = (select count(*) from folder_messages where email = ?1 and folder_id = ?2)
         where email = ?1 and id = ?2",
    )
    .and_then(|mut stmt| stmt.execute(params![email, folder_id]))
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn upsert_message_tx(tx: &rusqlite::Transaction, email: &str, folder_id: &str, item: &LiveMessage) -> Result<(), String> {
    // A change without a body keeps the cached one, so it does not name the
    // body columns at all: naming them would send the row back through the
    // search index on every sync (see add_search_index).
    let body = if item.body_html.is_empty() {
        ""
    } else {
        "body_html = excluded.body_html,
           body_text = excluded.body_text,"
    };
    tx.prepare_cached(&format!(
        "insert into folder_messages
         (email, folder_id, id, thread, subject, from_name, from_email, received, preview, body_html, unread, flagged, attached, files, to_json, cc_json, bcc_json, cats, extra, body_text)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
         on conflict(email, id) do update set
           {body}
           folder_id = excluded.folder_id,
           thread = case when excluded.thread = '' then folder_messages.thread else excluded.thread end,
           subject = case when excluded.subject = '' then folder_messages.subject else excluded.subject end,
           from_name = case when excluded.from_email = '' then folder_messages.from_name else excluded.from_name end,
           from_email = case when excluded.from_email = '' then folder_messages.from_email else excluded.from_email end,
           received = case when excluded.received = '' then folder_messages.received else excluded.received end,
           preview = case when excluded.preview = '' then folder_messages.preview else excluded.preview end,
           unread = excluded.unread,
           flagged = excluded.flagged,
           attached = case when excluded.files != '[]' then 1 when excluded.attached = 1 then 1 else 0 end,
           files = case when excluded.files != '[]' then excluded.files when excluded.attached = 1 then folder_messages.files else '[]' end,
           to_json = case when excluded.to_json = '[]' then folder_messages.to_json else excluded.to_json end,
           cc_json = case when excluded.cc_json = '[]' then folder_messages.cc_json else excluded.cc_json end,
           bcc_json = case when excluded.bcc_json = '[]' then folder_messages.bcc_json else excluded.bcc_json end,
           cats = excluded.cats,
           extra = case when excluded.extra = '{{}}' then folder_messages.extra else excluded.extra end"
    ))
    .and_then(|mut stmt| {
        stmt.execute(params![
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
            extra_text(item),
            search_text(&item.body_html)
        ])
    })
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
        .prepare_cached("select body_html from folder_messages where email = ?1 and id = ?2 limit 1")
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
    let text = search_text(html);
    let conn = writing()?;
    conn.prepare_cached("update folder_messages set body_html = ?3, body_text = ?4 where email = ?1 and id = ?2")
        .and_then(|mut stmt| stmt.execute(params![email, message_id, html, text]))
        .map_err(|err| err.to_string())?;
    Ok(())
}

fn folder_ids_for_box(conn: &Connection, email: &str, box_key: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare_cached("select id from folders where email = ?1 and box_key = ?2 order by position")
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
        .prepare_cached(&format!(
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
    let mut conn = writing()?;
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
    let mut conn = writing()?;
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

const SEARCH_HAY: &str = concat!("lower(", search_head!(), " || ' ' || :account)");

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

/// The words or phrases of a search as it compares them: lower case, at
/// most 80 letters, empty slots after the last one.
fn search_terms(values: &[String], slots: usize) -> Vec<String> {
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
        out[n] = word.chars().take(80).collect();
        n += 1;
    }
    out
}

/// Most three-letter runs one search asks the index for. Any of them narrow.
const SEARCH_RUNS_MAX: usize = 64;

/// The question for `message_search`: every three-letter run of every term,
/// all of which a matching message must hold. `None` when the index cannot
/// narrow this search and it reads the account as before: no term has three
/// letters, or the only long ones could be found in the account name, which
/// every message matches and the index does not hold.
fn search_match(terms: &[&String], account: &str) -> Option<String> {
    let mut runs: Vec<String> = Vec::new();
    for term in terms {
        // In the name, or running off the end of the headers into it.
        let in_account = account.contains(term.as_str())
            || term.match_indices(' ').any(|(at, _)| account.starts_with(&term[at + 1..]));
        if in_account {
            continue;
        }
        let letters: Vec<char> = term.chars().collect();
        for run in letters.windows(3) {
            if run.contains(&'\0') {
                continue;
            }
            let run: String = run.iter().collect();
            if !runs.contains(&run) {
                runs.push(run);
            }
        }
    }
    runs.truncate(SEARCH_RUNS_MAX);
    if runs.is_empty() {
        return None;
    }
    let quoted: Vec<String> = runs.iter().map(|run| format!("\"{}\"", run.replace('"', "\"\""))).collect();
    Some(quoted.join(" AND "))
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
    let conn = searching()?;
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
    let word_terms = search_terms(words, 8);
    let phrase_terms = search_terms(phrases, 4);
    let words: Vec<String> = word_terms.iter().map(|term| if term.is_empty() { String::new() } else { like_pattern(term) }).collect();
    let phrases: Vec<String> = phrase_terms.iter().map(|term| if term.is_empty() { String::new() } else { like_pattern(term) }).collect();
    let files = match files.trim() {
        "yes" | "no" => files.trim(),
        _ => "",
    };
    let offset = zone_offset.clamp(-14 * 60, 14 * 60);
    let zone = format!("{} minutes", -offset);
    let from_day = calendar_day(from_day);
    let to_day = calendar_day(to_day);
    let account = account_name.trim().to_lowercase();
    // Each word or phrase must be in one message: its headers or its body.
    // The page then lists the whole conversation, as Outlook does, so a reply
    // that only quotes the words still shows beside the one that has them.
    let has_text = words.iter().chain(phrases.iter()).any(|p| !p.is_empty());
    let terms: Vec<&String> = word_terms.iter().chain(phrase_terms.iter()).filter(|term| !term.is_empty()).collect();
    let matching = search_match(&terms, &account);
    // With the index, only the rows it names are read, plus those written
    // since it was last brought up to date. The LIKE tests below still decide.
    let mut hits = String::from(if matching.is_some() {
        "with hits as materialized (
           select fm.id, fm.thread
           from (select rowid as r from message_search where message_search match :match
                 union select id from search_dirty) near
           cross join folder_messages fm on fm.rowid = near.r
           where fm.email = :email"
    } else {
        "with hits as materialized (
           select fm.id, fm.thread from folder_messages fm
           where fm.email = :email"
    });
    for i in 0..8 {
        hits.push_str(&format!(" and (:w{i} = '' or {SEARCH_HAY} like :w{i} escape '\\' or fm.body_text like :w{i} escape '\\')"));
    }
    for i in 0..4 {
        hits.push_str(&format!(" and (:p{i} = '' or {SEARCH_HAY} like :p{i} escape '\\' or fm.body_text like :p{i} escape '\\')"));
    }
    hits.push_str(")\n");
    let mut sql = format!(
        "{hits}select fm.id, fm.thread, fm.subject, fm.from_name, fm.from_email, fm.received, fm.preview, '', fm.unread, fm.flagged, fm.attached, fm.files, fm.to_json, fm.cc_json, fm.bcc_json, fm.cats, fm.extra, f.box_key
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
           and (:invite = 0 or instr(fm.extra, '\"invite\":true') > 0)
           and (:text = 0
                or fm.id in (select id from hits)
                or (fm.thread != '' and fm.thread in (select thread from hits where thread != '')))"
    );
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
    let mut stmt = conn.prepare_cached(&sql).map_err(|err| err.to_string())?;
    let (before, before_id) = (before.trim(), before_id.trim());
    let (unread, read, flagged, invite, text) =
        (unread_only as i64, read_only as i64, flagged_only as i64, invite_only as i64, has_text as i64);
    let mut bound: Vec<(&str, &dyn rusqlite::ToSql)> = vec![
        (":email", &email),
        (":box", &box_key),
        (":before", &before),
        (":before_id", &before_id),
        (":from_day", &from_day),
        (":to_day", &to_day),
        (":zone", &zone),
        (":unread", &unread),
        (":read", &read),
        (":flagged", &flagged),
        (":invite", &invite),
        (":account", &account),
        (":files", &files),
        (":fetch", &fetch),
        (":text", &text),
    ];
    let names = [":w0", ":w1", ":w2", ":w3", ":w4", ":w5", ":w6", ":w7", ":p0", ":p1", ":p2", ":p3"];
    for (name, pattern) in names.into_iter().zip(words.iter().chain(phrases.iter())) {
        bound.push((name, pattern));
    }
    if let Some(matching) = &matching {
        bound.push((":match", matching));
    }
    let rows = stmt
        .query_map(&bound[..], |row| {
            let message = message_row(row)?;
            let box_key: String = row.get(17)?;
            Ok((message, box_key))
        })
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
    fn a_linked_message_is_found_in_its_own_account_with_its_folder() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        replace_folders_on(&mut conn, "jon@example.com", &[folder("in", "root", "inbox"), folder("jobs", "root", "jobs")]).unwrap();
        replace_folder_messages_on(&mut conn, "jon@example.com", "jobs", &[message("AAMk+x/y==")]).unwrap();
        let (found, folder_id) = find_message_on(&conn, "Jon@Example.com", "AAMk+x/y==").unwrap().unwrap();
        assert_eq!((found.id.as_str(), folder_id.as_str()), ("AAMk+x/y==", "jobs"));
        assert!(found.body_html.is_empty(), "a header only; the body loads when it opens");
        assert!(find_message_on(&conn, "other@example.com", "AAMk+x/y==").unwrap().is_none());
        assert!(find_message_on(&conn, "jon@example.com", "nope").unwrap().is_none());
        assert!(find_message_on(&conn, "jon@example.com", " ").unwrap().is_none());
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

        // The whole conversation comes back, not only the message that matched.
        let with_file = args(&["site"], &[], "inbox", "yes", 100, "", "");
        assert_eq!(ids(&with_file), vec!["p".to_string(), "f".to_string()]);

        let phrase = args(&[], &["kiln schedule"], "inbox", "", 100, "", "");
        assert_eq!(ids(&phrase), vec!["k".to_string()]);

        // Words in the body match too.
        assert_eq!(ids(&args(&["secret"], &[], "", "", 100, "", "")), vec!["k".to_string()]);

        let first = args(&[], &[], "", "", 1, "", "");
        assert_eq!(ids(&first), vec!["s".to_string()]);
        assert!(first.more);
        let next = args(&[], &[], "", "", 10, &first.messages[0].received, "s");
        assert_eq!(ids(&next), vec!["k".to_string(), "p".to_string(), "f".to_string()]);
        assert!(!next.more);
    }

    fn search_ids(conn: &Connection, words: &[&str]) -> Vec<String> {
        search_cached_on(
            conn,
            "jon@example.com",
            "",
            &words.iter().map(|word| (*word).to_string()).collect::<Vec<_>>(),
            &[],
            "Jon",
            "",
            "",
            0,
            "",
            false,
            false,
            false,
            false,
            100,
            "",
            "",
        )
        .unwrap()
        .messages
        .into_iter()
        .map(|item| item.id)
        .collect()
    }

    #[test]
    fn search_finds_words_split_between_preview_and_body_and_lists_the_thread() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        replace_folders_on(&mut conn, "jon@example.com", &[folder("in", "root", "inbox"), folder("out", "root", "sent")]).unwrap();
        let mut bill = message("bill");
        bill.thread = "bill".into();
        bill.subject = "A bill from the lawyers".into();
        bill.preview = "Total due".into();
        bill.received = "2026-10-13T14:00:00Z".into();
        let mut ask = message("ask");
        ask.thread = "bill".into();
        ask.subject = "Re: A bill from the lawyers".into();
        ask.preview = "Afternoon Cathie, can I pay this another way?".into();
        ask.received = "2026-10-13T19:54:00Z".into();
        let mut answer = message("answer");
        answer.thread = "bill".into();
        answer.subject = "Re: A bill from the lawyers".into();
        answer.from_name = "Catherine Dennis".into();
        answer.preview = "Good afternoon, The email address is".into();
        answer.body_html = "<div style=\"font-family: Calibri\"><p>Good afternoon,</p><p>The email address for <b>Interac</b> is pay@example.com</p><p>Cathie</p></div>".into();
        answer.received = "2026-10-13T19:58:00Z".into();
        let mut other = message("other");
        other.subject = "Unrelated".into();
        other.body_html = "<span style=\"color: red\">Lunch?</span>".into();
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &[bill, answer, other]).unwrap();
        replace_folder_messages_on(&mut conn, "jon@example.com", "out", &[ask]).unwrap();

        // "cathie" is in the preview and signature, "interac" only in the body.
        assert_eq!(search_ids(&conn, &["interac", "cathie"]), vec!["answer", "ask", "bill"]);
        // Markup is not text: style attributes and tag names don't match.
        assert!(search_ids(&conn, &["calibri"]).is_empty());
        assert!(search_ids(&conn, &["color"]).is_empty());
        assert!(search_ids(&conn, &["span"]).is_empty());
        assert_eq!(search_ids(&conn, &["lunch"]), vec!["other"]);
        // Both words must be in one message, not spread over the thread.
        assert!(search_ids(&conn, &["interac", "lunch"]).is_empty());
    }

    #[test]
    fn a_body_loaded_later_becomes_searchable() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        replace_folders_on(&mut conn, "jon@example.com", &[folder("in", "root", "inbox")]).unwrap();
        let mut bare = message("bare");
        bare.body_html = String::new();
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &[bare.clone()]).unwrap();
        assert!(search_ids(&conn, &["etransfer"]).is_empty());
        conn.execute(
            "update folder_messages set body_html = ?3, body_text = ?4 where email = ?1 and id = ?2",
            params!["jon@example.com", "bare", "<p>Send an etransfer</p>", search_text("<p>Send an etransfer</p>")],
        )
        .unwrap();
        assert_eq!(search_ids(&conn, &["etransfer"]), vec!["bare"]);
        // A later header-only sync keeps the body text.
        let tx = conn.transaction().unwrap();
        upsert_message_tx(&tx, "jon@example.com", "in", &bare).unwrap();
        tx.commit().unwrap();
        assert_eq!(search_ids(&conn, &["etransfer"]), vec!["bare"]);
    }

    #[test]
    fn mail_cached_before_body_search_is_filled_in_once() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        replace_folders_on(&mut conn, "jon@example.com", &[folder("in", "root", "inbox")]).unwrap();
        let mut old = message("old");
        old.body_html = "<p>Interac details</p>".into();
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &[old]).unwrap();
        // As a database from 1.3.1 had it: no body_text column.
        conn.execute_batch("alter table folder_messages drop column body_text").unwrap();
        ensure_schema(&conn).unwrap();
        assert_eq!(search_ids(&conn, &["interac"]), vec!["old"]);
        ensure_schema(&conn).unwrap();
        assert_eq!(search_ids(&conn, &["interac"]), vec!["old"]);
    }

    #[test]
    fn mail_cached_as_latin1_mojibake_is_put_back_once() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        let mut bad = message("bad");
        bad.body_html = "<p>project.\u{c2}\u{a0} I hope</p>".into();
        bad.preview = "project.\u{c2}\u{a0} I hope".into();
        let mut real = message("real");
        real.body_html = "<p>Café crème Â la carte</p>".into();
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &[bad, real]).unwrap();
        conn.execute_batch("pragma user_version = 0").unwrap();
        ensure_schema(&conn).unwrap();
        let body = |id: &str| -> (String, String) {
            conn.query_row("select body_html, preview from folder_messages where id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
        };
        assert_eq!(body("bad"), ("<p>project.\u{a0} I hope</p>".into(), "project.\u{a0} I hope".into()));
        assert_eq!(body("real").0, "<p>Café crème Â la carte</p>");
        let version: i64 = conn.query_row("pragma user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 1);
    }

    #[test]
    fn search_text_drops_markup_and_caps_its_size() {
        assert_eq!(search_text("<style>p{color:red}</style><p>Hi&nbsp;there</p>\n\n<p>Jon</p>"), "Hi there Jon");
        let huge = format!("<p>{}</p>", "word ".repeat(60_000));
        assert!(search_text(&huge).len() <= SEARCH_TEXT_MAX);
        assert_eq!(search_text(""), "");
    }

    /// Bring the search index and the unread index up to date, as `tend` does.
    fn caught_up(conn: &mut Connection) {
        while catch_up(conn).unwrap() {}
    }

    fn waiting(conn: &Connection) -> i64 {
        conn.query_row("select count(*) from search_dirty", [], |row| row.get(0)).unwrap()
    }

    /// Rows the index names for one question, before the LIKE tests.
    fn named(conn: &Connection, question: &str) -> i64 {
        conn.query_row("select count(*) from message_search where message_search match ?1", [question], |row| row.get(0))
            .unwrap()
    }

    fn mailbox(conn: &mut Connection) {
        replace_folders_on(conn, "jon@example.com", &[folder("in", "root", "inbox")]).unwrap();
        let mut bill = message("bill");
        bill.subject = "Kiln INVOICE".into();
        bill.body_html = "<p>Pay by etransfer, quoting \"K-12\"</p>".into();
        let mut note = message("note");
        note.subject = "Lunch".into();
        note.from_name = "Émile Zola".into();
        note.body_html = "<p>Soup at noon</p>".into();
        replace_folder_messages_on(conn, "jon@example.com", "in", &[bill, note]).unwrap();
    }

    #[test]
    fn the_search_index_finds_parts_of_words_as_the_old_search_did() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        mailbox(&mut conn);
        // Written a moment ago and not indexed yet: found all the same.
        assert_eq!(waiting(&conn), 2);
        assert_eq!(search_ids(&conn, &["voic"]), vec!["bill"]);
        caught_up(&mut conn);
        assert_eq!(waiting(&conn), 0);
        // The index names the one row, and only that one is read.
        assert_eq!(named(&conn, "\"voi\" AND \"oic\""), 1);
        assert_eq!(search_ids(&conn, &["voic"]), vec!["bill"]);
        assert_eq!(search_ids(&conn, &["VOICE", "transf"]), vec!["bill"]);
        assert_eq!(search_ids(&conn, &["\"k-12\""]), vec!["bill"]);
        assert_eq!(search_ids(&conn, &["soup", "invoice"]), Vec::<String>::new());
        assert_eq!(search_ids(&conn, &["zola"]), vec!["note"]);
        // Two letters are too few for the index. They are still searched for.
        assert_eq!(search_ids(&conn, &["ki"]), vec!["bill"]);
        assert_eq!(search_ids(&conn, &["ki", "voic"]), vec!["bill"]);
        // The account's own name is in no message, and matches them all.
        assert_eq!(search_ids(&conn, &["jon"]).len(), 2);
        assert_eq!(search_ids(&conn, &["jon", "soup"]), vec!["note"]);
        // LIKE folds only A to Z, so the result does too, whatever the index folds.
        assert_eq!(search_ids(&conn, &["émile"]), Vec::<String>::new());
        assert!(named(&conn, "\"émi\"") > 0);
    }

    #[test]
    fn the_search_index_follows_every_change_to_a_message() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        mailbox(&mut conn);
        caught_up(&mut conn);

        // Read state, flags and a header-only sync of the same mail change
        // nothing the index holds, so nothing is indexed again.
        record_mail_action_on(&mut conn, "jon@example.com", "read", &["bill".to_string()]).unwrap();
        let mut bare = message("bill");
        bare.subject = "Kiln INVOICE".into();
        bare.body_html = String::new();
        upsert_folder_messages_on(&mut conn, "jon@example.com", "in", &[bare.clone()]).unwrap();
        assert_eq!(waiting(&conn), 0);
        assert_eq!(search_ids(&conn, &["etransfer"]), vec!["bill"]);

        // A new subject, then a new body.
        bare.subject = "Kiln receipt".into();
        upsert_folder_messages_on(&mut conn, "jon@example.com", "in", &[bare.clone()]).unwrap();
        assert_eq!(waiting(&conn), 1);
        assert_eq!(search_ids(&conn, &["receipt"]), vec!["bill"]);
        assert_eq!(search_ids(&conn, &["invoice"]), Vec::<String>::new());
        caught_up(&mut conn);
        assert_eq!(search_ids(&conn, &["receipt"]), vec!["bill"]);
        assert_eq!(search_ids(&conn, &["invoice"]), Vec::<String>::new());
        assert_eq!(named(&conn, "\"voi\""), 0);
        bare.body_html = "<p>Paid by cheque</p>".into();
        upsert_folder_messages_on(&mut conn, "jon@example.com", "in", &[bare]).unwrap();
        caught_up(&mut conn);
        assert_eq!(search_ids(&conn, &["cheque"]), vec!["bill"]);
        assert_eq!(search_ids(&conn, &["etransfer"]), Vec::<String>::new());

        // A new id keeps its place in the index. A deleted message leaves it.
        rename_moved_on(&mut conn, "jon@example.com", &[crate::graph::MovedId { from: "bill".into(), to: "bill2".into() }]).unwrap();
        assert_eq!(search_ids(&conn, &["cheque"]), vec!["bill2"]);
        forget_messages_on(&mut conn, "jon@example.com", &["bill2".to_string()]).unwrap();
        assert_eq!(search_ids(&conn, &["cheque"]), Vec::<String>::new());
        caught_up(&mut conn);
        assert_eq!((waiting(&conn), named(&conn, "\"che\"")), (0, 0));

        // Replacing a folder's messages gives them new rows.
        let mut again = message("note");
        again.body_html = "<p>Stew at one</p>".into();
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &[again]).unwrap();
        assert_eq!(search_ids(&conn, &["stew"]), vec!["note"]);
        caught_up(&mut conn);
        assert_eq!(search_ids(&conn, &["stew"]), vec!["note"]);
        assert_eq!(search_ids(&conn, &["soup"]), Vec::<String>::new());
        assert_eq!(named(&conn, "\"sou\""), 0);
    }

    #[test]
    fn a_cache_from_before_the_search_index_is_indexed_in_steps() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        replace_folders_on(&mut conn, "jon@example.com", &[folder("in", "root", "inbox")]).unwrap();
        let many: Vec<LiveMessage> = (0..SEARCH_BATCH_ROWS + 50)
            .map(|n| {
                let mut item = message(&format!("m{n:04}"));
                item.unread = n % 2 == 0;
                item.body_html = format!("<p>parcel number{n:04}</p>");
                item
            })
            .collect();
        replace_folder_messages_on(&mut conn, "jon@example.com", "in", &many).unwrap();
        // As 1.4.4 left the file: no index, no triggers, no unread index.
        conn.execute_batch(
            "drop trigger folder_messages_search_new; drop trigger folder_messages_search_gone;
             drop trigger folder_messages_search_head; drop trigger folder_messages_search_body;
             drop table message_search; drop table search_dirty; drop index folder_messages_unread;",
        )
        .unwrap();

        ensure_schema(&conn).unwrap();
        let unread_index = |conn: &Connection| -> i64 {
            conn.query_row("select count(*) from sqlite_master where name = 'folder_messages_unread'", [], |row| row.get(0)).unwrap()
        };
        // Opening only notes the rows. Search is right before any are indexed.
        assert_eq!((waiting(&conn), unread_index(&conn)), (many.len() as i64, 0));
        assert_eq!(search_ids(&conn, &["number0007"]), vec!["m0007"]);
        // One step does one batch, and a second open starts nothing over.
        assert!(catch_up(&mut conn).unwrap());
        let left = waiting(&conn);
        assert!(left > 0 && left < many.len() as i64);
        assert_eq!(unread_index(&conn), 1);
        ensure_schema(&conn).unwrap();
        assert_eq!(waiting(&conn), left);
        assert_eq!(search_ids(&conn, &["number0007"]), vec!["m0007"]);
        assert_eq!(search_ids(&conn, &[&format!("number{:04}", many.len() - 1)]), vec![format!("m{:04}", many.len() - 1)]);
        caught_up(&mut conn);
        assert_eq!(waiting(&conn), 0);
        assert_eq!(named(&conn, "\"par\" AND \"arc\""), many.len() as i64);
        assert_eq!(search_ids(&conn, &["number0007"]), vec!["m0007"]);
        assert!(!catch_up(&mut conn).unwrap());
    }

    #[test]
    fn half_an_indexing_step_leaves_the_rows_waiting() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        mailbox(&mut conn);
        // The app is killed with a step under way: its transaction never commits.
        {
            let tx = conn.transaction().unwrap();
            tx.execute("insert into message_search (rowid, text) select rowid, subject from folder_messages", []).unwrap();
            tx.execute("delete from search_dirty", []).unwrap();
        }
        assert_eq!(waiting(&conn), 2);
        caught_up(&mut conn);
        assert_eq!(search_ids(&conn, &["etransfer"]), vec!["bill"]);
    }

    #[test]
    fn unread_counts_come_from_the_unread_index() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        mailbox(&mut conn);
        let plan: Vec<String> = conn
            .prepare("explain query plan select count(*) from folder_messages where email = ?1 and folder_id = ?2 and unread != 0")
            .unwrap()
            .query_map(params!["jon@example.com", "in"], |row| row.get::<_, String>(3))
            .unwrap()
            .flatten()
            .collect();
        assert!(plan.iter().any(|step| step.contains("COVERING INDEX folder_messages_unread")), "{plan:?}");
        record_mail_action_on(&mut conn, "jon@example.com", "read", &["bill".to_string()]).unwrap();
        let tx = conn.transaction().unwrap();
        refresh_counts_tx(&tx, "jon@example.com", "in").unwrap();
        tx.commit().unwrap();
        let folders = load_folders_on(&conn, "jon@example.com").unwrap().unwrap();
        assert_eq!((folders[0].unread, folders[0].total), (1, 2));
    }

    #[test]
    fn signing_out_forgets_that_account_everywhere() {
        let mut conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        mailbox(&mut conn);
        replace_folders_on(&mut conn, "ada@example.com", &[folder("in", "root", "inbox")]).unwrap();
        let mut hers = message("hers");
        hers.body_html = "<p>Her etransfer</p>".into();
        replace_folder_messages_on(&mut conn, "ada@example.com", "in", &[hers.clone()]).unwrap();
        for email in ["jon@example.com", "ada@example.com"] {
            conn.execute(
                "insert into folder_delta (email, folder_id, delta_link) values (?1, 'in', 'link')",
                [email],
            )
            .unwrap();
        }
        let tx = conn.transaction().unwrap();
        let mut bill = message("bill");
        bill.subject = "Kiln INVOICE".into();
        insert_legacy(&tx, &bill).unwrap();
        insert_legacy(&tx, &hers).unwrap();
        tx.commit().unwrap();
        caught_up(&mut conn);

        forget_account_on(&mut conn, "jon@example.com").unwrap();
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |row| row.get(0)).unwrap() };
        for table in ["folders", "folder_messages", "folder_delta"] {
            assert_eq!(count(&format!("select count(*) from {table} where email = 'jon@example.com'")), 0, "{table}");
            assert_eq!(count(&format!("select count(*) from {table} where email = 'ada@example.com'")), 1, "{table}");
        }
        assert_eq!(load_legacy(&conn).unwrap().into_iter().map(|item| item.id).collect::<Vec<_>>(), vec!["hers"]);
        caught_up(&mut conn);
        assert_eq!((waiting(&conn), named(&conn, "\"etr\"")), (0, 1));
        assert_eq!(search_ids(&conn, &["etransfer"]), Vec::<String>::new());
    }

    #[test]
    fn one_file_keeps_its_connections_and_stays_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("mailroom-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("mail.db");
        let store = open_store(&path).unwrap();
        {
            let mut writer = hold(&store.writer);
            mailbox(&mut writer);
        }
        // A read sees a finished write at once, on its own connection.
        let reader = hold(&store.reader);
        assert_eq!(load_folder_messages(&reader, "jon@example.com", "in", false).unwrap().len(), 2);
        assert_eq!(search_ids(&hold(&store.searcher), &["voic"]), vec!["bill"]);
        assert!(reader.execute("delete from folders", []).is_err());
        let mode: String = reader.query_row("pragma journal_mode", [], |row| row.get(0)).unwrap();
        assert_eq!(mode, "wal");
        for file in [path.clone(), dir.join("mail.db-wal")] {
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600, "{}", file.display());
        }
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        drop(reader);
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_write_wakes_the_indexing_behind_it() {
        let dir = std::env::temp_dir().join(format!("mailroom-store-tend-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("mail.db");
        let store = store_at(path.clone()).unwrap();
        // The same file is the same store, not a second set of connections.
        assert!(std::ptr::eq(store, store_at(path).unwrap()));
        mailbox(&mut writing_to(store));
        let mut left = -1;
        for _ in 0..500 {
            left = waiting(&hold(&store.reader));
            if left == 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(left, 0);
        assert_eq!(search_ids(&hold(&store.searcher), &["voic"]), vec!["bill"]);
        assert_eq!(named(&hold(&store.searcher), "\"voi\""), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
