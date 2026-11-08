use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const GROK_URL: &str = "https://api.x.ai/v1/responses";
const GROK_MODEL: &str = "grok-4.7";
const CLAUDE_URL: &str = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL: &str = "claude-opus-5-5";
const CLAUDE_VERSION: &str = "2023-06-01";
const MAX_FIELD: usize = 200;
const MAX_BODY: usize = 1500;
const MAX_QUESTION: usize = 2000;
const MAX_DRAFT: usize = 8000;
const MAX_NOTES: usize = 20;
const MAX_PROMPT: usize = 28_000;
const MAX_TURN: usize = 4_000;
const MAX_TURNS: usize = 12;
const ASSIST_RESERVE: usize = 12_000;
// Ask across mail (2026-10-23): up to a hundred messages, with the text of
// their PDF attachments, for questions like "how much did I spend with X".
const ASK_NOTES: usize = 100;
const ASK_BODY: usize = 4_000;
const ASK_FILES: usize = 6_000;
const ASK_PROMPT: usize = 240_000;
const ASK_ANSWER_TOKENS: u32 = 3_000;
const ASK_SECS: u64 = 240;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub grok: bool,
    pub claude: bool,
    pub grok_added: String,
    pub claude_added: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiText {
    pub text: String,
}

#[derive(Clone, Deserialize)]
pub struct AssistTurn {
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub text: String,
}

#[derive(Clone, Deserialize)]
pub struct MailNote {
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub body: String,
    /// The text of its PDF attachments, read on this computer (Ask only).
    #[serde(default)]
    pub attachments: String,
}

struct Excerpt {
    from: String,
    email: String,
    date: String,
    subject: String,
    body: String,
}

pub(crate) struct AiRequest {
    pub url: &'static str,
    pub headers: Vec<(&'static str, String)>,
    pub body: Value,
}

pub fn status() -> AiStatus {
    let grok = key_present("grok-api-key");
    let claude = key_present("claude-api-key");
    AiStatus {
        grok,
        claude,
        grok_added: provider_added(grok, "grok", "grok-api-key"),
        claude_added: provider_added(claude, "claude", "claude-api-key"),
    }
}

pub fn save_key(provider: &str, key: &str) -> Result<(), String> {
    let id = provider_id(provider)?;
    let user = provider_user(provider)?;
    let key = normalise_key(key)?;
    let path = key_file(user);
    if keyring_saves(user, &key) {
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
    } else {
        if let Ok(entry) = keyring::Entry::new("mailroom", user) {
            let _ = entry.delete_credential();
        }
        write_key_file(&path, &key)?;
    }
    if let Some(stamp) = now_rfc3339() {
        let _ = store_added(&added_file(), id, &stamp);
    }
    Ok(())
}

pub fn clear_key(provider: &str) -> Result<(), String> {
    let id = provider_id(provider)?;
    let user = provider_user(provider)?;
    if let Ok(entry) = keyring::Entry::new("mailroom", user) {
        let _ = entry.delete_credential();
    }
    let path = key_file(user);
    if path.exists() {
        fs::remove_file(&path).map_err(|err| err.to_string())?;
    }
    let _ = forget_added(&added_file(), id);
    Ok(())
}

pub fn ask(provider: &str, question: &str, notes: &[MailNote], omitted: usize) -> Result<AiText, String> {
    let prompt = ask_wide_prompt(question, notes, omitted)?;
    let text = complete_sized(provider, &prompt, ASK_ANSWER_TOKENS, ASK_SECS)?;
    Ok(AiText { text })
}

// The lines of a long message worth keeping for a question about money: its
// opening, then every line with an amount or a word that goes with one.
pub(crate) fn money_excerpt(text: &str, cap: usize) -> String {
    let text = text.replace('\0', "");
    if text.chars().count() <= cap {
        return text.trim().to_string();
    }
    const WORDS: [&str; 14] = ["$", "total", "amount", "subtotal", "paid", "payment", "invoice", "balance", "due", "cad", "usd", "hst", "gst", "tax"];
    let head: String = text.chars().take(cap / 4).collect();
    let mut out = head.trim_end().to_string();
    out.push_str("\n[…]\n");
    for line in text.lines().skip(head.lines().count()) {
        let lower = line.to_lowercase();
        let money = WORDS.iter().any(|w| lower.contains(w)) || line.chars().any(|c| c == '€' || c == '£');
        if !money || line.trim().is_empty() {
            continue;
        }
        if out.chars().count() + line.chars().count() + 1 > cap {
            break;
        }
        out.push_str(line.trim());
        out.push('\n');
    }
    out.trim_end().to_string()
}

fn ask_wide_prompt(question: &str, notes: &[MailNote], omitted: usize) -> Result<String, String> {
    let question = clean_field(question, MAX_QUESTION);
    if question.is_empty() {
        return Err("Enter a question.".into());
    }
    let notes: Vec<&MailNote> = notes.iter().filter(|n| !n.body.trim().is_empty() || !n.subject.trim().is_empty()).take(ASK_NOTES).collect();
    if notes.is_empty() {
        return Err("There is no mail to ask about.".into());
    }
    let mut prompt = String::from(
        "Answer the question using only the mail below. It is every message that matched a search, \
         with the text of any PDF attachments. If the mail does not say, say so. Plain text.\n\
         For a question about money: list each amount you count, one per line, as date — what it was for — amount, \
         then the total. Count a charge once: an invoice and its receipt, or a reminder about the same bill, are one. \
         Leave out quotes, estimates and refunds unless the question asks for them, and say what you left out. \
         Keep currencies apart rather than adding them together.\n\nQuestion:\n",
    );
    prompt.push_str(&question);
    prompt.push_str(&format!("\n\nMail ({} messages", notes.len()));
    if omitted > 0 {
        prompt.push_str(&format!("; {omitted} more matched and are not included — say so in the answer"));
    }
    prompt.push_str("):\n");
    for note in notes {
        if prompt.len() >= ASK_PROMPT {
            break;
        }
        let item = Excerpt {
            from: clean_field(&note.from, MAX_FIELD),
            email: clean_field(&note.email, MAX_FIELD),
            date: clean_field(&note.date, MAX_FIELD),
            subject: clean_field(&note.subject, MAX_FIELD),
            body: money_excerpt(&note.body, ASK_BODY),
        };
        prompt.push_str(&excerpt_block(&item));
        let files = money_excerpt(&note.attachments, ASK_FILES);
        if !files.is_empty() {
            prompt.push_str("Attached:\n");
            prompt.push_str(&files);
            prompt.push('\n');
        }
    }
    if prompt.len() > ASK_PROMPT {
        let mut end = ASK_PROMPT;
        while end > 0 && !prompt.is_char_boundary(end) {
            end -= 1;
        }
        prompt.truncate(end);
    }
    Ok(prompt)
}

pub fn draft(provider: &str, to: &str, subject: &str, draft: &str, notes: &[MailNote]) -> Result<AiText, String> {
    let prompt = draft_prompt(to, subject, draft, &excerpts(notes))?;
    let text = complete(provider, &prompt)?;
    Ok(AiText { text })
}

pub fn assist(
    provider: &str,
    turns: &[AssistTurn],
    to: &str,
    subject: &str,
    draft: &str,
    notes: &[MailNote],
) -> Result<AiText, String> {
    let prompt = assist_prompt(turns, to, subject, draft, &excerpts(notes))?;
    let text = complete(provider, &prompt)?;
    Ok(AiText { text })
}

fn complete(provider: &str, prompt: &str) -> Result<String, String> {
    complete_sized(provider, prompt, 1200, 60)
}

fn complete_sized(provider: &str, prompt: &str, max_tokens: u32, secs: u64) -> Result<String, String> {
    let user = provider_user(provider)?;
    let key = load_key(user, provider)?;
    let mut request = match user {
        "claude-api-key" => claude_request(&key, prompt),
        _ => grok_request(&key, prompt),
    };
    if user == "claude-api-key" {
        request.body["max_tokens"] = serde_json::json!(max_tokens);
    }
    let value = post_ai_for(&request, &key, secs)?;
    let text = if user == "claude-api-key" {
        claude_text(&value)?
    } else {
        grok_text(&value)?
    };
    let text = text.trim();
    if text.is_empty() {
        return Err("No answer came back.".into());
    }
    Ok(text.to_string())
}

fn provider_id(name: &str) -> Result<&'static str, String> {
    match name.trim().to_ascii_lowercase().as_str() {
        "grok" => Ok("grok"),
        "claude" => Ok("claude"),
        _ => Err("Choose Grok or Claude.".into()),
    }
}

fn provider_user(name: &str) -> Result<&'static str, String> {
    match provider_id(name)? {
        "claude" => Ok("claude-api-key"),
        _ => Ok("grok-api-key"),
    }
}

fn provider_label(name: &str) -> &'static str {
    if name.trim().eq_ignore_ascii_case("claude") {
        "Claude"
    } else {
        "Grok"
    }
}

pub(crate) fn normalise_key(raw: &str) -> Result<String, String> {
    let mut text = raw.trim();
    if text.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("bearer ")) {
        text = text[7..].trim();
    }
    if text.is_empty() {
        return Err("Enter a key.".into());
    }
    if text.chars().any(|ch| ch.is_whitespace() || ch.is_control()) || text.chars().count() < 8 || text.chars().count() > 400 {
        return Err("That key does not look valid.".into());
    }
    Ok(text.to_string())
}

fn config_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("mailroom")
}

fn key_file(user: &str) -> PathBuf {
    config_dir().join(user)
}

fn added_file() -> PathBuf {
    config_dir().join("ai-added.json")
}

fn provider_added(present: bool, id: &str, user: &str) -> String {
    if !present {
        return String::new();
    }
    let path = added_file();
    if let Some(saved) = stored_added(&path, id) {
        return saved;
    }
    let found = file_mtime_rfc3339(&key_file(user)).or_else(|| keyring_created(user));
    if let Some(stamp) = &found {
        let _ = store_added(&path, id, stamp);
    }
    found.unwrap_or_default()
}

fn valid_stamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 20
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'Z'
        && bytes.iter().enumerate().all(|(index, byte)| matches!(index, 4 | 7 | 10 | 13 | 16 | 19) || byte.is_ascii_digit())
}

fn read_added_map(path: &Path) -> std::collections::BTreeMap<String, String> {
    let text = fs::read_to_string(path).unwrap_or_default();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return std::collections::BTreeMap::new();
    };
    let Some(obj) = value.as_object() else {
        return std::collections::BTreeMap::new();
    };
    let mut map = std::collections::BTreeMap::new();
    for id in ["grok", "claude"] {
        if let Some(stamp) = obj.get(id).and_then(|item| item.as_str()) {
            if valid_stamp(stamp) {
                map.insert(id.to_string(), stamp.to_string());
            }
        }
    }
    map
}

fn write_added_map(path: &Path, map: &std::collections::BTreeMap<String, String>) -> Result<(), String> {
    if map.is_empty() {
        if path.exists() {
            fs::remove_file(path).map_err(|err| err.to_string())?;
        }
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    let text = serde_json::to_string(map).map_err(|err| err.to_string())?;
    fs::write(path, text).map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub(crate) fn stored_added(path: &Path, id: &str) -> Option<String> {
    read_added_map(path).remove(id)
}

pub(crate) fn store_added(path: &Path, id: &str, stamp: &str) -> Result<(), String> {
    if id != "grok" && id != "claude" {
        return Err("Choose Grok or Claude.".into());
    }
    if !valid_stamp(stamp) {
        return Err("That date could not be saved.".into());
    }
    let mut map = read_added_map(path);
    map.insert(id.to_string(), stamp.to_string());
    write_added_map(path, &map)
}

pub(crate) fn forget_added(path: &Path, id: &str) -> Result<(), String> {
    let mut map = read_added_map(path);
    map.remove(id);
    write_added_map(path, &map)
}

fn now_rfc3339() -> Option<String> {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    unix_to_rfc3339(secs)
}

fn file_mtime_rfc3339(path: &Path) -> Option<String> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    let secs = modified.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    unix_to_rfc3339(secs)
}

fn unix_to_rfc3339(secs: u64) -> Option<String> {
    let secs = i64::try_from(secs).ok()?;
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400) as u32;
    let (year, month, day) = civil_from_days(days)?;
    let hour = tod / 3600;
    let minute = (tod % 3600) / 60;
    let second = tod % 60;
    Some(format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"))
}

fn civil_from_days(days: i64) -> Option<(i32, u32, u32)> {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let mut year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    if !(1970..=9999).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year as i32, month as u32, day as u32))
}

#[cfg(target_os = "linux")]
fn keyring_created(user: &str) -> Option<String> {
    use dbus_secret_service::{EncryptionType, SecretService};
    use std::collections::HashMap;
    let service = SecretService::connect(EncryptionType::Plain).ok()?;
    let found = service
        .search_items(HashMap::from([("service", "mailroom"), ("username", user)]))
        .ok()?;
    let mut newest = 0u64;
    for item in found.unlocked.iter().chain(found.locked.iter()) {
        if let Ok(created) = item.get_created() {
            if created > newest {
                newest = created;
            }
        }
    }
    if newest == 0 {
        return None;
    }
    unix_to_rfc3339(newest)
}

#[cfg(not(target_os = "linux"))]
fn keyring_created(_user: &str) -> Option<String> {
    None
}

fn key_present(user: &str) -> bool {
    if let Ok(entry) = keyring::Entry::new("mailroom", user) {
        if let Ok(saved) = entry.get_password() {
            if normalise_key(&saved).is_ok() {
                return true;
            }
        }
    }
    read_key_file(&key_file(user)).is_some()
}

fn load_key(user: &str, provider: &str) -> Result<String, String> {
    if let Ok(entry) = keyring::Entry::new("mailroom", user) {
        if let Ok(saved) = entry.get_password() {
            if let Ok(key) = normalise_key(&saved) {
                return Ok(key);
            }
        }
    }
    if let Some(key) = read_key_file(&key_file(user)) {
        return Ok(key);
    }
    Err(format!("Save a {} key in Settings.", provider_label(provider)))
}

fn keyring_saves(user: &str, secret: &str) -> bool {
    let Ok(entry) = keyring::Entry::new("mailroom", user) else {
        return false;
    };
    if entry.set_password(secret).is_err() {
        return false;
    }
    let Ok(again) = keyring::Entry::new("mailroom", user) else {
        return false;
    };
    match again.get_password() {
        Ok(saved) if saved == secret => true,
        _ => {
            let _ = entry.delete_credential();
            false
        }
    }
}

pub(crate) fn write_key_file(path: &Path, secret: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    crate::auth::write_secret(path, secret.as_bytes())
}

pub(crate) fn read_key_file(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    normalise_key(&text).ok()
}

fn clean_field(value: &str, max: usize) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch == '\0' {
            continue;
        }
        if out.chars().count() >= max {
            break;
        }
        out.push(ch);
    }
    out.trim().to_string()
}

fn excerpts(notes: &[MailNote]) -> Vec<Excerpt> {
    notes
        .iter()
        .take(MAX_NOTES)
        .filter_map(|note| {
            let body = clean_field(&note.body, MAX_BODY);
            let subject = clean_field(&note.subject, MAX_FIELD);
            if body.is_empty() && subject.is_empty() {
                return None;
            }
            Some(Excerpt {
                from: clean_field(&note.from, MAX_FIELD),
                email: clean_field(&note.email, MAX_FIELD),
                date: clean_field(&note.date, MAX_FIELD),
                subject,
                body,
            })
        })
        .collect()
}

fn excerpt_block(item: &Excerpt) -> String {
    let who = if item.email.is_empty() {
        item.from.clone()
    } else if item.from.is_empty() {
        item.email.clone()
    } else {
        format!("{} <{}>", item.from, item.email)
    };
    format!(
        "---\nFrom: {who}\nDate: {date}\nSubject: {subject}\n{body}\n",
        date = item.date,
        subject = item.subject,
        body = item.body
    )
}


fn draft_prompt(to: &str, subject: &str, draft: &str, notes: &[Excerpt]) -> Result<String, String> {
    let to = clean_field(to, MAX_FIELD);
    let subject = clean_field(subject, MAX_FIELD);
    let draft = clean_field(draft, MAX_DRAFT);
    if to.is_empty() && subject.is_empty() && draft.is_empty() && notes.is_empty() {
        return Err("Add a subject or a few words first.".into());
    }
    let mut prompt = String::from(
        "Write the email the user will send. Return only the message text. Plain sentences. No subject line. No signature.\n\n",
    );
    prompt.push_str("To: ");
    prompt.push_str(if to.is_empty() { "(not set)" } else { &to });
    prompt.push_str("\nSubject: ");
    prompt.push_str(if subject.is_empty() { "(not set)" } else { &subject });
    prompt.push_str("\n\nDraft so far:\n");
    prompt.push_str(if draft.is_empty() { "(empty)" } else { &draft });
    if !notes.is_empty() {
        prompt.push_str("\n\nEarlier messages, newest first:\n");
        for item in notes.iter().take(MAX_NOTES) {
            if prompt.len() >= MAX_PROMPT {
                break;
            }
            prompt.push_str(&excerpt_block(item));
        }
    }
    cap_prompt(&mut prompt);
    Ok(prompt)
}

fn assist_prompt(turns: &[AssistTurn], to: &str, subject: &str, draft: &str, notes: &[Excerpt]) -> Result<String, String> {
    let mut kept = Vec::new();
    for turn in turns {
        let role = turn.role.trim().to_ascii_lowercase();
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = clean_field(&turn.text, MAX_TURN);
        if text.is_empty() {
            continue;
        }
        kept.push((role, text));
    }
    if kept.len() > MAX_TURNS {
        kept = kept.split_off(kept.len() - MAX_TURNS);
    }
    if !kept.iter().any(|(role, _)| role == "user") {
        return Err("Say what you need help with.".into());
    }
    let to = clean_field(to, MAX_FIELD);
    let subject = clean_field(subject, MAX_FIELD);
    let draft = clean_field(draft, MAX_DRAFT);
    let mut prompt = String::from(
        "You are helping the user write an email. Have a short conversation about what they need. Ask a question when the request is vague. When they ask you to write the message, return only that message text. Plain text. No subject line. No signature.\n\n",
    );
    prompt.push_str("To: ");
    prompt.push_str(if to.is_empty() { "(not set)" } else { &to });
    prompt.push_str("\nSubject: ");
    prompt.push_str(if subject.is_empty() { "(not set)" } else { &subject });
    prompt.push_str("\n\nDraft so far:\n");
    prompt.push_str(if draft.is_empty() { "(empty)" } else { &draft });
    let note_limit = MAX_PROMPT.saturating_sub(ASSIST_RESERVE);
    if !notes.is_empty() {
        prompt.push_str("\n\nEarlier messages, newest first:\n");
        for item in notes.iter().take(MAX_NOTES) {
            let block = excerpt_block(item);
            if prompt.len() + block.len() > note_limit {
                break;
            }
            prompt.push_str(&block);
        }
    }
    let mut lines = Vec::new();
    for (role, text) in &kept {
        let label = if role == "assistant" { "Assistant" } else { "User" };
        lines.push(format!("{label}: {text}\n"));
    }
    let tail = "\nReply to the latest user message.\n";
    while lines.len() > 1 && prompt.len() + lines.iter().map(String::len).sum::<usize>() + tail.len() + 16 > MAX_PROMPT {
        lines.remove(0);
    }
    prompt.push_str("\n\nConversation:\n");
    for line in &lines {
        prompt.push_str(line);
    }
    prompt.push_str(tail);
    cap_prompt(&mut prompt);
    Ok(prompt)
}

fn cap_prompt(prompt: &mut String) {
    if prompt.len() <= MAX_PROMPT {
        return;
    }
    let mut end = MAX_PROMPT;
    while end > 0 && !prompt.is_char_boundary(end) {
        end -= 1;
    }
    prompt.truncate(end);
}

pub(crate) fn grok_request(key: &str, prompt: &str) -> AiRequest {
    AiRequest {
        url: GROK_URL,
        headers: vec![("Authorization", format!("Bearer {key}"))],
        body: serde_json::json!({
            "model": GROK_MODEL,
            "input": prompt,
            "store": false,
            "reasoning": { "effort": "low" }
        }),
    }
}

pub(crate) fn claude_request(key: &str, prompt: &str) -> AiRequest {
    AiRequest {
        url: CLAUDE_URL,
        headers: vec![
            ("x-api-key", key.to_string()),
            ("anthropic-version", CLAUDE_VERSION.to_string()),
        ],
        body: serde_json::json!({
            "model": CLAUDE_MODEL,
            "max_tokens": 1200,
            "messages": [{ "role": "user", "content": prompt }]
        }),
    }
}

pub(crate) fn grok_text(value: &Value) -> Result<String, String> {
    if let Some(text) = value.get("output_text").and_then(|item| item.as_str()) {
        let text = text.trim();
        if !text.is_empty() {
            return Ok(text.to_string());
        }
    }
    let mut parts = Vec::new();
    if let Some(output) = value.get("output").and_then(|item| item.as_array()) {
        for item in output {
            let Some(content) = item.get("content").and_then(|block| block.as_array()) else {
                continue;
            };
            for block in content {
                if block.get("type").and_then(|kind| kind.as_str()) != Some("output_text") {
                    continue;
                }
                if let Some(text) = block.get("text").and_then(|item| item.as_str()) {
                    let text = text.trim();
                    if !text.is_empty() {
                        parts.push(text.to_string());
                    }
                }
            }
        }
    }
    if parts.is_empty() {
        return Err("Grok did not return any text.".into());
    }
    Ok(parts.join("\n"))
}

pub(crate) fn claude_text(value: &Value) -> Result<String, String> {
    let mut parts = Vec::new();
    if let Some(blocks) = value.get("content").and_then(|item| item.as_array()) {
        for block in blocks {
            if block.get("type").and_then(|kind| kind.as_str()) != Some("text") {
                continue;
            }
            if let Some(text) = block.get("text").and_then(|item| item.as_str()) {
                let text = text.trim();
                if !text.is_empty() {
                    parts.push(text.to_string());
                }
            }
        }
    }
    if parts.is_empty() {
        return Err("Claude did not return any text.".into());
    }
    Ok(parts.join("\n"))
}

pub(crate) fn failure_message(status: u16, body: &str, key: &str, claude: bool) -> String {
    if status == 401 || status == 403 {
        return "That key was refused. Save a new one in Settings.".into();
    }
    let who = if claude { "Claude" } else { "Grok" };
    let detail = scrub(&error_detail(body), key);
    let detail = clip(&detail);
    if detail.is_empty() {
        format!("{who} refused the request ({status}).")
    } else {
        format!("{who} refused the request ({status}). {detail}")
    }
}

fn error_detail(body: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return String::new();
    };
    if let Some(message) = value.get("error").and_then(|item| item.get("message")).and_then(|item| item.as_str()) {
        return message.to_string();
    }
    if let Some(message) = value.get("error").and_then(|item| item.as_str()) {
        return message.to_string();
    }
    String::new()
}

fn scrub(text: &str, key: &str) -> String {
    if key.is_empty() {
        return text.to_string();
    }
    text.replace(key, "…")
}

fn clip(text: &str) -> String {
    let trimmed = text.trim();
    let count = trimmed.chars().count();
    if count <= 180 {
        return trimmed.to_string();
    }
    trimmed.chars().take(180).collect::<String>() + "…"
}

#[allow(dead_code)]
fn post_ai(request: &AiRequest, key: &str) -> Result<Value, String> {
    post_ai_for(request, key, 60)
}

fn post_ai_for(request: &AiRequest, key: &str, secs: u64) -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(secs))
        .build()
        .map_err(|err| scrub(&err.to_string(), key))?;
    let mut builder = client.post(request.url);
    for (name, value) in &request.headers {
        builder = builder.header(*name, value);
    }
    let response = builder.json(&request.body).send().map_err(|err| {
        let who = if request.url.contains("anthropic") { "Claude" } else { "Grok" };
        format!("Could not reach {who}. {}", scrub(&err.to_string(), key))
    })?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(failure_message(status.as_u16(), &text, key, request.url.contains("anthropic")));
    }
    serde_json::from_str(&scrub(&text, key)).map_err(|_| "The assistant sent an unreadable response.".into())
}

#[cfg(test)]
mod wide_tests {
    use super::*;

    fn note(subject: &str, body: &str, files: &str) -> MailNote {
        MailNote { from: "Auto Eclectic".into(), email: "shop@ae.example".into(), date: "2026-09-12".into(), subject: subject.into(), body: body.into(), attachments: files.into() }
    }

    #[test]
    fn a_long_message_keeps_its_opening_and_every_line_with_money() {
        let filler = "Thanks for choosing us. ".repeat(400);
        let body = format!("Hi Jon,\n{filler}\nBrake service $1,240.00\nHST $161.20\nWe value you.\nTotal $1,401.20 CAD\n");
        let out = money_excerpt(&body, 1000);
        assert!(out.chars().count() <= 1000, "{}", out.len());
        assert!(out.starts_with("Hi Jon,"));
        assert!(out.contains("Brake service $1,240.00") && out.contains("Total $1,401.20 CAD"));
        assert!(!out.contains("We value you."));
        assert_eq!(money_excerpt("short $5", 100), "short $5");
    }

    #[test]
    fn the_wide_prompt_carries_the_pdf_text_the_count_and_what_was_left_out() {
        let notes = vec![note("Invoice 4411", "See attached.", "Total $1,401.20 CAD"), note("", "", "")];
        let p = ask_wide_prompt("How much did I spend?", &notes, 7).unwrap();
        assert!(p.contains("Mail (1 messages; 7 more matched"));
        assert!(p.contains("Attached:\nTotal $1,401.20 CAD"));
        assert!(p.contains("Count a charge once"));
        assert!(ask_wide_prompt("  ", &notes, 0).is_err());
        assert!(ask_wide_prompt("Q", &[note("", "", "")], 0).is_err());
    }

    #[test]
    fn a_hundred_long_messages_stay_under_the_cap() {
        let big = "$1 ".repeat(20_000);
        let notes: Vec<MailNote> = (0..150).map(|i| note(&format!("S{i}"), &big, &big)).collect();
        let p = ask_wide_prompt("Total?", &notes, 50).unwrap();
        assert!(p.len() <= ASK_PROMPT);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        assist_prompt, claude_request, claude_text, draft_prompt, excerpts, failure_message, file_mtime_rfc3339, forget_added,
        grok_request, grok_text, normalise_key, read_key_file, store_added, stored_added, unix_to_rfc3339, write_key_file, AssistTurn,
        MailNote,
    };

    #[test]
    fn a_key_with_wide_characters_up_front_is_not_a_panic() {
        assert_eq!(normalise_key("abcde\u{e9}\u{e9}xyz").unwrap(), "abcde\u{e9}\u{e9}xyz");
        assert_eq!(normalise_key("Bearer abcdefghij").unwrap(), "abcdefghij");
    }
    use serde_json::json;
    use std::fs;

    fn note(body: &str) -> super::Excerpt {
        super::Excerpt {
            from: "Maya Chen".into(),
            email: "maya.chen@timberworks.example".into(),
            date: "2026-10-15".into(),
            subject: "Kiln".into(),
            body: body.into(),
        }
    }

    #[test]
    fn empty_and_messy_keys_are_refused() {
        assert_eq!(normalise_key("  ").unwrap_err(), "Enter a key.");
        assert!(normalise_key("short").is_err());
        assert!(normalise_key("has a space inside the key").is_err());
        assert_eq!(normalise_key("Bearer test-key-value").unwrap(), "test-key-value");
    }

    #[test]
    fn grok_request_uses_the_responses_api() {
        let request = grok_request("test-key-value", "Hello");
        assert_eq!(request.url, "https://api.x.ai/v1/responses");
        assert_eq!(request.body["model"], "grok-4.7");
        assert_eq!(request.body["input"], "Hello");
        assert_eq!(request.body["store"], false);
        assert_eq!(request.body["reasoning"]["effort"], "low");
        assert!(request.headers.iter().any(|(name, value)| *name == "Authorization" && value == "Bearer test-key-value"));
        assert!(!request.body.to_string().contains("test-key-value"));
    }

    #[test]
    fn claude_request_uses_the_messages_api() {
        let request = claude_request("test-key-value", "Hello");
        assert_eq!(request.url, "https://api.anthropic.com/v1/messages");
        assert_eq!(request.body["model"], "claude-opus-5-5");
        assert_eq!(request.body["max_tokens"], 1200);
        assert_eq!(request.body["messages"][0]["role"], "user");
        assert_eq!(request.body["messages"][0]["content"], "Hello");
        assert!(request.headers.iter().any(|(name, value)| *name == "x-api-key" && value == "test-key-value"));
        assert!(request
            .headers
            .iter()
            .any(|(name, value)| *name == "anthropic-version" && value == "2023-06-01"));
        assert!(!request.body.to_string().contains("test-key-value"));
    }

    #[test]
    fn grok_text_reads_output_text_and_output_items() {
        assert_eq!(grok_text(&json!({"output_text": " Hello "})).unwrap(), "Hello");
        let nested = json!({
            "output": [
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking"}]},
                {"type": "message", "content": [{"type": "output_text", "text": "The kiln is Thursday."}]}
            ]
        });
        assert_eq!(grok_text(&nested).unwrap(), "The kiln is Thursday.");
        assert!(grok_text(&json!({"output": []})).is_err());
    }

    #[test]
    fn claude_text_reads_text_blocks() {
        let value = json!({
            "content": [
                {"type": "thinking", "thinking": "hidden"},
                {"type": "text", "text": "Thursday."}
            ]
        });
        assert_eq!(claude_text(&value).unwrap(), "Thursday.");
        assert!(claude_text(&json!({"content": []})).is_err());
    }

    #[test]
    fn failure_text_hides_the_key() {
        let message = failure_message(400, r#"{"error":{"message":"bad test-key-value"}}"#, "test-key-value", false);
        assert!(!message.contains("test-key-value"));
        assert!(message.contains("bad …"));
        assert_eq!(
            failure_message(401, "test-key-value", "test-key-value", true),
            "That key was refused. Save a new one in Settings."
        );
    }

    #[test]
    fn prompts_keep_the_question_and_drop_the_overflow() {
        let mut notes = vec![MailNote {
            from: "Maya Chen".into(),
            email: "maya.chen@timberworks.example".into(),
            date: "2026-10-15".into(),
            subject: "Kiln".into(),
            body: "A".repeat(5000),
            attachments: String::new(),
        }];
        for index in 0..25 {
            notes.push(MailNote {
                from: format!("Person {index}"),
                email: String::new(),
                date: String::new(),
                subject: "Note".into(),
                body: "short".into(),
                attachments: String::new(),
            });
        }
        let cleaned = excerpts(&notes);
        assert_eq!(cleaned.len(), 20);
        assert!(cleaned[0].body.chars().count() <= 1500);
        let draft = draft_prompt("Owen", "Kiln", "Thanks", &[note("The slot is Thursday.")]).unwrap();
        assert!(draft.contains("Thanks"));
        assert!(draft.contains("The slot is Thursday."));
        assert!(draft.contains("No signature"));
        assert!(draft_prompt("", "", "", &[]).is_err());
        let empty = MailNote {
            from: String::new(),
            email: String::new(),
            date: String::new(),
            subject: String::new(),
            body: String::new(),
            attachments: String::new(),
        };
        assert!(excerpts(&[empty]).is_empty());
    }

    #[test]
    fn assist_prompt_keeps_the_latest_turn_without_a_draft() {
        let turns = vec![
            AssistTurn { role: "user".into(), text: "Make this shorter".into() },
            AssistTurn { role: "note".into(), text: "ignore me".into() },
            AssistTurn { role: "assistant".into(), text: "Shorter how?".into() },
            AssistTurn { role: "USER".into(), text: "Half the length".into() },
        ];
        let prompt = assist_prompt(&turns, "Maya", "Kiln", "", &[note("The slot is Thursday.")]).unwrap();
        assert!(prompt.contains("Make this shorter"));
        assert!(prompt.contains("Half the length"));
        assert!(prompt.contains("Shorter how?"));
        assert!(!prompt.contains("ignore me"));
        assert!(prompt.contains("Maya"));
        assert!(prompt.contains("(empty)"));
        assert!(prompt.contains("The slot is Thursday."));
        assert!(prompt.contains("No signature"));
        assert!(prompt.len() <= 28_000);
        assert!(assist_prompt(&[], "", "", "", &[]).is_err());
        let blank = AssistTurn { role: "user".into(), text: "   ".into() };
        assert!(assist_prompt(&[blank], "", "", "", &[]).is_err());
        let only = AssistTurn { role: "assistant".into(), text: "Hello".into() };
        assert!(assist_prompt(&[only], "", "", "Draft text", &[]).is_err());
        let mut many = Vec::new();
        for index in 0..20 {
            many.push(AssistTurn {
                role: "user".into(),
                text: format!("turn {index} ") + &"x".repeat(5000),
            });
        }
        let capped = assist_prompt(&many, "", "", "", &[]).unwrap();
        assert!(capped.contains("turn 19"));
        assert!(!capped.contains("turn 0 "));
        assert!(!capped.contains(&"x".repeat(4500)));
        assert!(capped.len() <= 28_000);
        let mut notes = Vec::new();
        for _ in 0..20 {
            notes.push(note(&"n".repeat(1500)));
        }
        let with_notes = assist_prompt(
            &[AssistTurn { role: "user".into(), text: "Keep this question".into() }],
            "",
            "",
            "",
            &notes,
        )
        .unwrap();
        assert!(with_notes.contains("Keep this question"));
        assert!(with_notes.len() <= 28_000);
    }

    #[test]
    fn added_stamp_is_a_date_and_not_a_secret() {
        assert_eq!(unix_to_rfc3339(0).as_deref(), Some("1970-01-01T00:00:00Z"));
        assert_eq!(unix_to_rfc3339(1_792_514_918).as_deref(), Some("2026-10-20T16:48:38Z"));
        assert!(unix_to_rfc3339(u64::MAX).is_none() || unix_to_rfc3339(u64::MAX).as_deref() != Some("2026-10-20T16:48:38Z"));
        let dir = std::env::temp_dir().join(format!("mailroom-ai-added-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ai-added.json");
        store_added(&path, "grok", "2026-10-20T16:48:38Z").unwrap();
        assert_eq!(stored_added(&path, "grok").as_deref(), Some("2026-10-20T16:48:38Z"));
        assert!(stored_added(&path, "claude").is_none());
        assert!(store_added(&path, "grok", "yesterday").is_err());
        assert_eq!(stored_added(&path, "grok").as_deref(), Some("2026-10-20T16:48:38Z"));
        fs::write(&path, r#"{"grok":"not-a-date","claude":"2026-10-18T09:00:00Z","secret":"test-key-value"}"#).unwrap();
        assert!(stored_added(&path, "grok").is_none());
        assert_eq!(stored_added(&path, "claude").as_deref(), Some("2026-10-18T09:00:00Z"));
        store_added(&path, "grok", "2026-10-20T16:48:38Z").unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("2026-10-20T16:48:38Z"));
        assert!(!text.contains("test-key-value"));
        assert!(!text.contains("not-a-date"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        forget_added(&path, "grok").unwrap();
        forget_added(&path, "claude").unwrap();
        assert!(!path.exists());
        let touched = dir.join("saved-key");
        fs::write(&touched, "not-read").unwrap();
        let stamp = file_mtime_rfc3339(&touched).unwrap();
        assert_eq!(stamp.len(), 20);
        assert!(stamp.ends_with('Z'));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn key_file_is_private_and_round_trips() {
        let dir = std::env::temp_dir().join(format!("mailroom-ai-key-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("grok-api-key");
        write_key_file(&path, "test-key-value").unwrap();
        assert_eq!(read_key_file(&path).as_deref(), Some("test-key-value"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
