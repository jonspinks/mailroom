//! Drafts kept on the server, replies and forwards that stay in their
//! conversation, and answers to meeting invites.
//!
//! A reply or forward starts from Microsoft's own draft (createReply,
//! createReplyAll, createForward). That draft carries the In-Reply-To and
//! References headers, and a forward carries the original attachments. The
//! app then writes its own subject, recipients and body over it and sends it.

use crate::graph::SendGraph;
use crate::attach::{self, StagedRef};
use crate::auth;
use crate::graph::{self, OutgoingMail};
use serde::Serialize;
use serde_json::{json, Value};

const ME: &str = "https://graph.microsoft.com/v1.0/me";
const SEND_AGAIN: &str = "Sign in again to send mail.";
const ANSWER_AGAIN: &str = "Sign in again to answer invites.";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    New,
    Reply,
    ReplyAll,
    Forward,
}

impl Mode {
    pub fn parse(raw: &str) -> Mode {
        match raw.trim().to_ascii_lowercase().as_str() {
            "reply" => Mode::Reply,
            "replyall" | "reply-all" | "all" => Mode::ReplyAll,
            "forward" => Mode::Forward,
            _ => Mode::New,
        }
    }
}

/// What a Graph call failed with. Status 0 means Microsoft could not be
/// reached. `detail` is Microsoft's own reason, when it gave one.
#[derive(Debug, Default)]
struct Failure {
    status: u16,
    detail: String,
    step: &'static str,
}

impl Failure {
    fn new(status: u16) -> Failure {
        Failure { status, ..Failure::default() }
    }

    fn gone(&self) -> bool {
        self.status == 404
    }

    /// The send itself got no clear answer: no reply, or a server error
    /// other than a throttle, so Microsoft may have sent the message.
    fn maybe_sent(&self) -> bool {
        self.step == "sending" && matches!(self.status, 0 | 500..=502 | 504..=599)
    }

    /// Name the step that failed, for the error and the log.
    fn at(mut self, step: &'static str) -> Failure {
        if self.step.is_empty() {
            self.step = step;
        }
        self
    }
}

/// Microsoft's reason from an error body, short and on one line.
pub fn graph_reason(body: &str) -> String {
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let text = value["error"]["message"].as_str().or_else(|| value["error"]["code"].as_str()).unwrap_or("");
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(200).collect()
}

/// One line per failed send in ~/.local/state/mailroom/mailroom.log: the
/// step, the status and Microsoft's reason. No addresses or message text.
fn log_failure(failure: &Failure) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let dir = std::path::PathBuf::from(home).join(".local").join("state").join("mailroom");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(dir.join("mailroom.log")) {
        let _ = writeln!(file, "{stamp} send failed at {}: status {} {}", failure.step, failure.status, failure.detail);
    }
}

fn call(
    client: &reqwest::blocking::Client,
    token: &str,
    method: &str,
    url: &str,
    body: Option<&Value>,
) -> Result<Value, Failure> {
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| Failure::new(0))?;
    let mut request = client
        .request(method, url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .header("Prefer", "outlook.timezone=\"UTC\"");
    request = match body {
        Some(body) => request.json(body),
        // Graph wants a length on an empty POST.
        None => request.header("Content-Length", "0"),
    };
    let response = request
        .send_graph(token)
        .map_err(|err| Failure { detail: err.to_string().chars().take(200).collect(), ..Failure::new(0) })?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(Failure { detail: graph_reason(&text), ..Failure::new(status.as_u16()) });
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn message_url(id: &str) -> String {
    format!("{ME}/messages/{}", graph::path_segment(id.trim()))
}

/// Where Microsoft makes the starting draft. A new message has no source.
pub fn create_url(mode: Mode, reply_to: &str) -> String {
    let source = reply_to.trim();
    let action = match mode {
        Mode::Reply => "createReply",
        Mode::ReplyAll => "createReplyAll",
        Mode::Forward => "createForward",
        Mode::New => return format!("{ME}/messages"),
    };
    if source.is_empty() {
        return format!("{ME}/messages");
    }
    format!("{}/{action}", message_url(source))
}

/// The parts of a draft the app owns. Recipients are optional while saving.
pub fn draft_fields(mail: &OutgoingMail, body_html: &str, need_recipient: bool) -> Result<Value, String> {
    let mut seen = std::collections::HashSet::new();
    let to = graph::mail_addresses(&mail.to, &mut seen)?;
    let cc = graph::mail_addresses(&mail.cc, &mut seen)?;
    let bcc = graph::mail_addresses(&mail.bcc, &mut seen)?;
    if need_recipient && to.is_empty() && cc.is_empty() && bcc.is_empty() {
        return Err("Add a recipient.".into());
    }
    let subject = mail.subject.trim();
    if subject.chars().count() > 255 {
        return Err("The subject is too long.".into());
    }
    if body_html.len() > 1_500_000 {
        return Err("That message is too large to send.".into());
    }
    let people = |list: Vec<String>| {
        list.into_iter()
            .map(|address| json!({ "emailAddress": { "address": address } }))
            .collect::<Vec<_>>()
    };
    let mut fields = json!({
        "subject": subject,
        "body": { "contentType": "HTML", "content": body_html },
        "toRecipients": people(to),
        "ccRecipients": people(cc),
        "bccRecipients": people(bcc)
    });
    graph::add_flags(&mut fields, mail);
    if let Some(from) = graph::sender_json(&mail.from_address)? {
        fields["from"] = from;
    }
    Ok(fields)
}

fn new_draft(client: &reqwest::blocking::Client, token: &str, mode: Mode, reply_to: &str) -> Result<String, Failure> {
    let made = call(client, token, "POST", &create_url(mode, reply_to), Some(&json!({})))?;
    match made.get("id").and_then(Value::as_str) {
        Some(id) if !id.trim().is_empty() => Ok(id.to_string()),
        _ => Err(Failure { detail: "Microsoft did not return a draft.".into(), ..Failure::new(0) }),
    }
}

/// Make the starting draft. If the original has gone (moved or deleted
/// since), start a plain new message instead so nothing is lost.
fn start_draft(client: &reqwest::blocking::Client, token: &str, mode: Mode, reply_to: &str) -> Result<String, Failure> {
    match new_draft(client, token, mode, reply_to) {
        Err(failure) if failure.gone() && mode != Mode::New => new_draft(client, token, Mode::New, ""),
        other => other,
    }
}

fn save_message(failure: Failure) -> String {
    match failure.status {
        401 | 403 => "Sign in again to save drafts.".into(),
        0 => "The draft could not reach Microsoft. It is kept on this computer.".into(),
        _ => "Microsoft did not save the draft. It is kept on this computer.".into(),
    }
}

/// Save a draft on the server and return its id. The id changes only when
/// the draft is new or was removed elsewhere.
pub fn save_draft(email: &str, draft_id: &str, reply_to: &str, mode: Mode, mail: &OutgoingMail) -> Result<String, String> {
    let fields = draft_fields(mail, &mail.body_html, false)?;
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let existing = draft_id.trim();
    if !existing.is_empty() {
        match call(&client, &token, "PATCH", &message_url(existing), Some(&fields)) {
            Ok(_) => return Ok(existing.to_string()),
            Err(failure) if failure.gone() => {}
            Err(failure) => return Err(save_message(failure)),
        }
    }
    let id = start_draft(&client, &token, mode, reply_to).map_err(save_message)?;
    call(&client, &token, "PATCH", &message_url(&id), Some(&fields)).map_err(save_message)?;
    Ok(id)
}

pub fn discard_draft(email: &str, draft_id: &str) -> Result<(), String> {
    let id = draft_id.trim();
    if id.is_empty() {
        return Ok(());
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    match call(&client, &token, "DELETE", &message_url(id), None) {
        Ok(_) => Ok(()),
        Err(failure) if failure.gone() => Ok(()),
        Err(_) => Err("The draft could not be removed from the server.".into()),
    }
}

fn send_message(failure: Failure) -> String {
    log_failure(&failure);
    let why = |base: &str| {
        let step = if failure.step.is_empty() { String::new() } else { format!(" while {}", failure.step) };
        if failure.detail.is_empty() { format!("{base}{step}.") } else { format!("{base}{step}: {}", failure.detail) }
    };
    match failure.status {
        401 | 403 => SEND_AGAIN.into(),
        410 => "An attached file is missing. Attach it again.".into(),
        400 | 413 => why("Microsoft refused that message"),
        // The send may have gone through before the answer was lost.
        _ if failure.maybe_sent() => {
            "Microsoft did not answer, so the message may have been sent. Look in Sent Items before sending it again.".into()
        }
        429 | 503 => "Microsoft is busy. The message is still in Outbox.".into(),
        _ => why("The message could not be sent"),
    }
}

/// Files up to this size go up in one request. Larger ones use an upload
/// session, as Graph requires above 3 MB.
const SMALL_FILE: usize = 3 * 1024 * 1024;
/// Upload session chunks must be a multiple of 320 KiB.
const CHUNK: usize = 320 * 1024 * 12;

/// An upload session URL comes back from Graph and carries its own
/// credentials. Only send file bytes to Microsoft's own mail hosts.
pub fn trusted_upload_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("").to_ascii_lowercase();
    if host.contains('@') || host.contains(':') {
        return false;
    }
    ["outlook.office.com", "outlook.office365.com", "graph.microsoft.com"]
        .iter()
        .any(|known| host == *known || host.ends_with(&format!(".{known}")))
}

/// Byte ranges for an upload session, as (start, end inclusive).
pub fn chunks(total: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0;
    while start < total {
        let end = (start + CHUNK).min(total) - 1;
        out.push((start, end));
        start = end + 1;
    }
    out
}

fn upload_file(
    client: &reqwest::blocking::Client,
    token: &str,
    message: &str,
    file: &StagedRef,
    bytes: &[u8],
) -> Result<(), Failure> {
    let name = attach::clean_name(&file.name);
    let content_type = if file.content_type.trim().is_empty() { "application/octet-stream" } else { file.content_type.trim() };
    if bytes.len() <= SMALL_FILE {
        use base64::Engine;
        call(
            client,
            token,
            "POST",
            &format!("{}/attachments", message_url(message)),
            Some(&json!({
                "@odata.type": "#microsoft.graph.fileAttachment",
                "name": name,
                "contentType": content_type,
                "contentBytes": base64::engine::general_purpose::STANDARD.encode(bytes),
                "isInline": false
            })),
        )?;
        return Ok(());
    }
    let session = call(
        client,
        token,
        "POST",
        &format!("{}/attachments/createUploadSession", message_url(message)),
        Some(&json!({ "AttachmentItem": { "attachmentType": "file", "name": name, "size": bytes.len(), "contentType": content_type } })),
    )?;
    let url = session["uploadUrl"].as_str().unwrap_or("");
    if !trusted_upload_url(url) {
        return Err(Failure::new(0));
    }
    let uploader = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|_| Failure::new(0))?;
    for (start, end) in chunks(bytes.len()) {
        // The session URL carries its own token. The Graph token is not sent.
        let response = uploader
            .put(url)
            .header("Content-Range", format!("bytes {start}-{end}/{}", bytes.len()))
            .header("Content-Type", "application/octet-stream")
            .body(bytes[start..=end].to_vec())
            .send()
            .map_err(|_| Failure::new(0))?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().unwrap_or_default();
            return Err(Failure { detail: graph_reason(&body), ..Failure::new(status) }.at("uploading a file"));
        }
    }
    Ok(())
}

/// Staged files not already on the draft, by name and size. A retry of a
/// send that failed half way does not attach a file twice.
pub fn files_to_upload<'a>(listed: &Value, files: &'a [StagedRef], sizes: &[u64]) -> Vec<&'a StagedRef> {
    let present: Vec<(String, u64)> = listed["value"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| !item["isInline"].as_bool().unwrap_or(false))
        .map(|item| (item["name"].as_str().unwrap_or("").to_string(), item["size"].as_u64().unwrap_or(0)))
        .collect();
    files
        .iter()
        .zip(sizes)
        .filter(|(file, size)| {
            let name = attach::clean_name(&file.name);
            // Graph reports a size a little above the file's own, so a
            // match is the same name within a few KB.
            !present.iter().any(|(have, have_size)| *have == name && have_size.abs_diff(**size) < 16 * 1024)
        })
        .map(|(file, _)| file)
        .collect()
}

/// A send-later time: "YYYY-MM-DDTHH:MM:SSZ" in UTC.
pub fn deferred_ok(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 20 && b[19] == b'Z' && b[4] == b'-' && b[7] == b'-' && b[10] == b'T' && b[13] == b':' && b[16] == b':'
        && b[..19].iter().enumerate().all(|(i, c)| [4, 7, 10, 13, 16].contains(&i) || c.is_ascii_digit())
}

/// Attachments a forward should drop: files the person removed from the
/// compose form, and inline pictures this send is about to add again.
pub fn attachments_to_drop(listed: &Value, keep: Option<&[String]>, readding: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for item in listed["value"].as_array().into_iter().flatten() {
        let Some(id) = item["id"].as_str() else { continue };
        let name = item["name"].as_str().unwrap_or("");
        let inline = item["isInline"].as_bool().unwrap_or(false);
        // Pictures this app adds use the file name as their content id.
        let content_id = item["contentId"].as_str().unwrap_or(name);
        let removed = !inline && keep.is_some_and(|keep| !keep.iter().any(|kept| kept == name));
        let repeated = inline && readding.iter().any(|again| again == content_id || again == name);
        if removed || repeated {
            out.push(id.to_string());
        }
    }
    out
}

/// Send mail. A reply or forward goes through Microsoft's own draft so it
/// threads; a saved draft is sent as itself so it leaves the Drafts folder.
pub fn send(
    email: &str,
    mail: &OutgoingMail,
    draft_id: &str,
    reply_to: &str,
    mode: Mode,
    keep_files: Option<&[String]>,
    files: &[StagedRef],
    send_at: &str,
) -> Result<(), String> {
    if email.trim().is_empty() {
        return Err("That account is not signed in.".into());
    }
    let mut sizes = Vec::new();
    for file in files {
        sizes.push(attach::size(&file.id).ok_or_else(|| "An attached file is missing. Attach it again.".to_string())?);
    }
    if sizes.iter().sum::<u64>() > attach::MAX_TOTAL_BYTES {
        return Err("The attachments are too large to send. Microsoft accepts up to 35 MB in one message.".into());
    }
    let saved = draft_id.trim();
    let later = send_at.trim();
    if !later.is_empty() && !deferred_ok(later) {
        return Err("Choose a time to send.".into());
    }
    if saved.is_empty() && files.is_empty() && later.is_empty() && (mode == Mode::New || reply_to.trim().is_empty()) {
        return graph::send_mail(email, mail);
    }
    let (body_html, images) = graph::embed_inline_images(&mail.body_html)?;
    let mut fields = draft_fields(mail, &body_html, true)?;
    if !later.is_empty() {
        // Exchange holds the message until then, even with Mailroom closed.
        fields["singleValueExtendedProperties"] = json!([{ "id": "SystemTime 0x3FEF", "value": later }]);
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;

    let (id, made_here) = if saved.is_empty() {
        (start_draft(&client, &token, mode, reply_to).map_err(|f| send_message(f.at("starting the message")))?, true)
    } else {
        (saved.to_string(), false)
    };
    let attempt = |id: &str| -> Result<(), Failure> {
        call(&client, &token, "PATCH", &message_url(id), Some(&fields)).map_err(|f| f.at("saving the message"))?;
        let names: Vec<String> = images.iter().map(|image| image.name.clone()).collect();
        let prune_files = if mode == Mode::Forward { keep_files } else { None };
        let mut upload: Vec<&StagedRef> = files.iter().collect();
        if prune_files.is_some() || !names.is_empty() || !files.is_empty() {
            let listed = call(
                &client,
                &token,
                "GET",
                &format!("{}/attachments?$select=id,name,isInline,size", message_url(id)),
                None,
            )
            .map_err(|f| f.at("listing attachments"))?;
            upload = files_to_upload(&listed, files, &sizes);
            for drop in attachments_to_drop(&listed, prune_files, &names) {
                call(
                    &client,
                    &token,
                    "DELETE",
                    &format!("{}/attachments/{}", message_url(id), graph::path_segment(&drop)),
                    None,
                )
                .map_err(|f| f.at("removing an attachment"))?;
            }
        }
        for image in &images {
            call(
                &client,
                &token,
                "POST",
                &format!("{}/attachments", message_url(id)),
                Some(&json!({
                    "@odata.type": "#microsoft.graph.fileAttachment",
                    "name": image.name,
                    "contentType": image.content_type,
                    "contentBytes": image.bytes_b64,
                    "contentId": image.name,
                    "isInline": true
                })),
            )
            .map_err(|f| f.at("adding a picture"))?;
        }
        for file in upload {
            let bytes = attach::read(&file.id).map_err(|_| Failure::new(410))?;
            upload_file(&client, &token, id, file, &bytes).map_err(|f| f.at("attaching a file"))?;
        }
        call(&client, &token, "POST", &format!("{}/send", message_url(id)), None).map_err(|f| f.at("sending"))?;
        Ok(())
    };
    let sent = |result: Result<(), String>| {
        if result.is_ok() {
            attach::forget(&files.iter().map(|file| file.id.clone()).collect::<Vec<_>>());
        }
        result
    };
    sent(match attempt(&id) {
        Ok(()) => Ok(()),
        // The saved draft was sent or removed elsewhere. Send a fresh one,
        // but only when the draft itself was missing, not some later part.
        Err(failure) if failure.gone() && failure.step == "saving the message" && !made_here => {
            let fresh = start_draft(&client, &token, mode, reply_to).map_err(|f| send_message(f.at("starting the message")))?;
            attempt(&fresh).map_err(|failure| {
                if !failure.maybe_sent() {
                    let _ = call(&client, &token, "DELETE", &message_url(&fresh), None);
                }
                send_message(failure)
            })
        }
        // A send that may have gone through keeps its draft: removing it
        // could take the message with it.
        Err(failure) => {
            if made_here && !failure.maybe_sent() {
                let _ = call(&client, &token, "DELETE", &message_url(&id), None);
            }
            Err(send_message(failure))
        }
    })
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub event_id: String,
    pub subject: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub location: String,
    pub response: String,
    pub cancelled: bool,
    pub organizer: bool,
}

/// Graph's answer word, in the app's three words. Anything else is no answer yet.
pub fn response_word(graph_word: &str) -> String {
    match graph_word.trim().to_ascii_lowercase().as_str() {
        "accepted" | "organizer" => "accepted".into(),
        "tentativelyaccepted" => "tentative".into(),
        "declined" => "declined".into(),
        _ => String::new(),
    }
}

fn utc_stamp(value: &Value) -> String {
    let raw = value["dateTime"].as_str().unwrap_or("").trim();
    if raw.is_empty() {
        return String::new();
    }
    let whole = raw.split('.').next().unwrap_or(raw);
    if whole.ends_with('Z') { whole.to_string() } else { format!("{whole}Z") }
}

pub fn parse_invite(value: &Value) -> Option<Invite> {
    let event = value.get("event")?;
    let event_id = event["id"].as_str()?.trim().to_string();
    if event_id.is_empty() {
        return None;
    }
    Some(Invite {
        event_id,
        subject: event["subject"].as_str().unwrap_or("").to_string(),
        start: utc_stamp(&event["start"]),
        end: utc_stamp(&event["end"]),
        all_day: event["isAllDay"].as_bool().unwrap_or(false),
        location: event["location"]["displayName"].as_str().unwrap_or("").to_string(),
        response: response_word(event["responseStatus"]["response"].as_str().unwrap_or("")),
        cancelled: event["isCancelled"].as_bool().unwrap_or(false),
        organizer: event["isOrganizer"].as_bool().unwrap_or(false),
    })
}

/// The meeting behind a message, if the message is an invite.
pub fn invite_for(email: &str, message_id: &str) -> Result<Option<Invite>, String> {
    if message_id.trim().is_empty() {
        return Ok(None);
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let url = format!(
        "{}?$select=subject&$expand=microsoft.graph.eventMessage/event($select=id,subject,start,end,isAllDay,location,responseStatus,isCancelled,isOrganizer)",
        message_url(message_id)
    );
    // A message that is not an invite has no event to expand. Treat any
    // refusal the same way: there is nothing to answer.
    match call(&client, &token, "GET", &url, None) {
        Ok(value) => Ok(parse_invite(&value)),
        Err(_) => Ok(None),
    }
}

pub fn respond_url(event_id: &str, response: &str) -> Result<String, String> {
    let action = match response.trim() {
        "accepted" => "accept",
        "tentative" => "tentativelyAccept",
        "declined" => "decline",
        _ => return Err("Choose Accept, Tentative or Decline.".into()),
    };
    let id = event_id.trim();
    if id.is_empty() {
        return Err("That meeting is not on the server.".into());
    }
    Ok(format!("{ME}/events/{}/{action}", graph::path_segment(id)))
}

/// Answer an invite and tell the organiser.
pub fn respond(email: &str, event_id: &str, response: &str, comment: &str) -> Result<(), String> {
    let url = respond_url(event_id, response)?;
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let comment: String = comment.trim().chars().take(2000).collect();
    let answer = |send: bool| call(&client, &token, "POST", &url, Some(&json!({ "sendResponse": send, "comment": comment })));
    let result = match answer(true) {
        // The organiser asked for no replies. Record the answer quietly.
        Err(failure) if failure.status == 400 => answer(false),
        other => other,
    };
    result.map(|_| ()).map_err(|failure| match failure.status {
        401 | 403 => ANSWER_AGAIN.into(),
        404 => "That meeting is no longer on the calendar.".into(),
        0 => "Could not reach Microsoft. Try again.".into(),
        _ => "Microsoft did not record the answer. Try again.".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mail(to: &str) -> OutgoingMail {
        OutgoingMail {
            subject: "Re: Kiln".into(),
            body_html: "<p>Yes</p>".into(),
            to: to.into(),
            cc: String::new(),
            bcc: String::new(),
            ..Default::default()
        }
    }

    #[test]
    fn replies_and_forwards_start_from_microsofts_draft() {
        assert!(create_url(Mode::Reply, "AAMk/1=").ends_with("/messages/AAMk%2F1%3D/createReply"));
        assert!(create_url(Mode::ReplyAll, "A").ends_with("/messages/A/createReplyAll"));
        assert!(create_url(Mode::Forward, "A").ends_with("/messages/A/createForward"));
        assert!(create_url(Mode::New, "A").ends_with("/me/messages"));
        assert!(create_url(Mode::Reply, "  ").ends_with("/me/messages"));
        assert_eq!(Mode::parse("forward"), Mode::Forward);
        assert_eq!(Mode::parse("reply-all"), Mode::ReplyAll);
        assert_eq!(Mode::parse("anything"), Mode::New);
    }

    #[test]
    fn a_draft_may_wait_for_recipients_but_a_send_may_not() {
        assert!(draft_fields(&mail(""), "<p>Hi</p>", false).is_ok());
        assert_eq!(draft_fields(&mail(""), "<p>Hi</p>", true).unwrap_err(), "Add a recipient.");
        let fields = draft_fields(&mail("ada@example.com; bob@example.com"), "<p>Hi</p>", true).unwrap();
        assert_eq!(fields["toRecipients"].as_array().unwrap().len(), 2);
        assert_eq!(fields["body"]["contentType"], "HTML");
    }

    #[test]
    fn a_forward_drops_removed_files_and_repeated_pictures() {
        let listed = json!({ "value": [
            { "id": "a1", "name": "plan.pdf", "isInline": false },
            { "id": "a2", "name": "old.xlsx", "isInline": false },
            { "id": "a3", "name": "image1.png", "isInline": true, "contentId": "image1.png" },
            { "id": "a4", "name": "logo.png", "isInline": true, "contentId": "logo" }
        ]});
        let keep = vec!["plan.pdf".to_string()];
        let again = vec!["image1.png".to_string()];
        assert_eq!(attachments_to_drop(&listed, Some(&keep), &again), vec!["a2", "a3"]);
        assert_eq!(attachments_to_drop(&listed, None, &[]), Vec::<String>::new());
    }

    #[test]
    fn a_refusal_says_why_and_where() {
        assert_eq!(graph_reason(r#"{"error":{"code":"BadRequest","message":"Could not find a property named 'contentId'."}}"#), "Could not find a property named 'contentId'.");
        assert_eq!(graph_reason("not json"), "");
        let failure = Failure { detail: "Too big.".into(), ..Failure::new(413) }.at("sending").at("ignored");
        assert_eq!(failure.step, "sending");
        let text = match failure.status {
            400 | 413 => "refused",
            _ => "other",
        };
        assert_eq!(text, "refused");
    }

    #[test]
    fn a_send_without_a_clear_answer_may_have_gone() {
        for status in [0, 500, 502, 504] {
            assert!(Failure::new(status).at("sending").maybe_sent(), "{status}");
        }
        // A throttle or a refusal means the send was not taken.
        for status in [400, 404, 429, 503] {
            assert!(!Failure::new(status).at("sending").maybe_sent(), "{status}");
        }
        assert!(!Failure::new(0).at("attaching a file").maybe_sent());
        assert!(!Failure::new(500).at("saving the message").maybe_sent());
    }

    #[test]
    fn send_later_takes_a_utc_time() {
        assert!(deferred_ok("2026-10-22T12:00:00Z"));
        assert!(!deferred_ok("2026-10-22T12:00:00"));
        assert!(!deferred_ok("tomorrow"));
        assert!(!deferred_ok("2026-10-22T12:00:00Z\"}"));
    }

    #[test]
    fn large_files_go_in_aligned_chunks() {
        assert_eq!(chunks(0), vec![]);
        assert_eq!(chunks(10), vec![(0, 9)]);
        let big = chunks(CHUNK * 2 + 5);
        assert_eq!(big, vec![(0, CHUNK - 1), (CHUNK, 2 * CHUNK - 1), (2 * CHUNK, 2 * CHUNK + 4)]);
        assert_eq!(CHUNK % (320 * 1024), 0);
    }

    #[test]
    fn file_bytes_only_go_to_microsoft() {
        assert!(trusted_upload_url("https://outlook.office.com/api/v2.0/Users('a')/Messages('b')/AttachmentSessions('c')?authtoken=x"));
        assert!(trusted_upload_url("https://eur.outlook.office365.com/api/x"));
        assert!(!trusted_upload_url("http://outlook.office.com/x"));
        assert!(!trusted_upload_url("https://outlook.office.com.evil.example/x"));
        assert!(!trusted_upload_url("https://evil.example/outlook.office.com"));
        assert!(!trusted_upload_url("https://user@outlook.office.com/x"));
    }

    #[test]
    fn a_retry_does_not_attach_twice() {
        let listed = json!({ "value": [
            { "name": "plan.pdf", "size": 120_500, "isInline": false },
            { "name": "logo.png", "size": 900, "isInline": true }
        ]});
        let files = vec![
            StagedRef { id: "a".repeat(32), name: "plan.pdf".into(), content_type: String::new() },
            StagedRef { id: "b".repeat(32), name: "logo.png".into(), content_type: String::new() },
            StagedRef { id: "c".repeat(32), name: "plan.pdf".into(), content_type: String::new() },
        ];
        let left = files_to_upload(&listed, &files, &[120_000, 900, 5_000_000]);
        assert_eq!(left.iter().map(|file| file.id.chars().next().unwrap()).collect::<String>(), "bc");
    }

    #[test]
    fn an_invite_reads_its_meeting() {
        let value = json!({
            "id": "msg",
            "event": {
                "id": "ev1",
                "subject": "Pipeline review",
                "start": { "dateTime": "2026-10-22T15:00:00.0000000", "timeZone": "UTC" },
                "end": { "dateTime": "2026-10-22T15:30:00.0000000", "timeZone": "UTC" },
                "isAllDay": false,
                "location": { "displayName": "Room 2" },
                "responseStatus": { "response": "tentativelyAccepted" },
                "isCancelled": false,
                "isOrganizer": false
            }
        });
        let invite = parse_invite(&value).unwrap();
        assert_eq!(invite.event_id, "ev1");
        assert_eq!(invite.start, "2026-10-22T15:00:00Z");
        assert_eq!(invite.response, "tentative");
        assert_eq!(invite.location, "Room 2");
        assert!(parse_invite(&json!({ "id": "plain" })).is_none());
        assert_eq!(response_word("notResponded"), "");
        assert_eq!(response_word("organizer"), "accepted");
    }

    #[test]
    fn answers_go_to_the_right_action() {
        assert!(respond_url("ev/1", "accepted").unwrap().ends_with("/events/ev%2F1/accept"));
        assert!(respond_url("ev", "tentative").unwrap().ends_with("/tentativelyAccept"));
        assert!(respond_url("ev", "declined").unwrap().ends_with("/decline"));
        assert!(respond_url("ev", "maybe").is_err());
        assert!(respond_url(" ", "accepted").is_err());
    }
}
