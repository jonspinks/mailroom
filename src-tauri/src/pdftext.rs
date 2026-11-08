//! The text of PDF attachments, for Ask (2026-10-23): invoices and receipts
//! often carry their amounts only in a PDF. Read here, on this computer;
//! only the text goes to the assistant with the question.
//!
//! A PDF from mail is untrusted, so each is read in its own thread with a
//! time limit and a panic caught: a broken or hostile file costs that file,
//! never the app. Scanned PDFs have no text layer and come back unreadable.

use crate::{auth, graph};
use serde::Serialize;
use std::time::Duration;

const MAX_PDF_BYTES: i64 = 8 * 1024 * 1024;
const MAX_PER_MESSAGE: usize = 3;
const MAX_PDFS: usize = 60;
const MAX_TEXT: usize = 6000;
const READ_SECS: u64 = 10;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfText {
    pub message_id: String,
    pub name: String,
    pub text: String,
    /// No text could be read: scanned, encrypted, broken, or too large.
    pub unreadable: bool,
}

pub fn is_pdf(name: &str, content_type: &str) -> bool {
    content_type.to_ascii_lowercase().contains("pdf") || name.to_ascii_lowercase().ends_with(".pdf")
}

/// Plain text from PDF bytes, tidied: blank runs folded, capped.
pub fn text_of(bytes: Vec<u8>) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let out = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem(&bytes).ok()).ok().flatten();
        let _ = tx.send(out);
    });
    let raw = rx.recv_timeout(Duration::from_secs(READ_SECS)).ok().flatten()?;
    let mut out = String::new();
    let mut blank = 0;
    for line in raw.lines() {
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        out.push_str(&line);
        out.push('\n');
        if out.len() >= MAX_TEXT {
            break;
        }
    }
    let text: String = out.trim().chars().take(MAX_TEXT).collect();
    if text.chars().filter(|c| c.is_alphanumeric()).count() < 8 {
        return None;
    }
    Some(text)
}

/// The PDFs on these messages, read. At most three a message and sixty in
/// all; a message whose attachments can't be listed is skipped.
pub fn pdf_texts(email: &str, message_ids: &[String]) -> Result<Vec<PdfText>, String> {
    let google = auth::is_google(email);
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let mut out = Vec::new();
    for id in message_ids.iter().take(200) {
        if out.len() >= MAX_PDFS {
            break;
        }
        let listed = if google { crate::google::list_attachments(email, id) } else { graph::list_attachments(email, id) };
        let Ok(files) = listed else { continue };
        for file in files.iter().filter(|f| is_pdf(&f.name, &f.content_type)).take(MAX_PER_MESSAGE) {
            if out.len() >= MAX_PDFS {
                break;
            }
            let unreadable = |out: &mut Vec<PdfText>| out.push(PdfText { message_id: id.clone(), name: file.name.clone(), text: String::new(), unreadable: true });
            if file.size > MAX_PDF_BYTES {
                unreadable(&mut out);
                continue;
            }
            let bytes = if google {
                crate::google::attachment_bytes(email, id, &file.id).ok()
            } else {
                let Ok(url) = graph::attachment_value_url(id, &file.id) else { continue };
                graph::attachment_bytes(&client, &token, &url).ok()
            };
            match bytes.and_then(text_of) {
                Some(text) => out.push(PdfText { message_id: id.clone(), name: file.name.clone(), text, unreadable: false }),
                None => unreadable(&mut out),
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdfs_are_known_by_type_or_name() {
        assert!(is_pdf("Invoice 4411.PDF", "application/octet-stream"));
        assert!(is_pdf("x", "application/pdf"));
        assert!(!is_pdf("photo.jpg", "image/jpeg"));
    }

    #[test]
    fn junk_is_unreadable_not_a_crash() {
        assert_eq!(text_of(b"not a pdf at all".to_vec()), None);
        assert_eq!(text_of(b"%PDF-1.4\n%\xff\xff\n1 0 obj << /Type /Catalog >>".to_vec()), None);
    }
}

#[cfg(test)]
mod real_pdf {
    #[test]
    fn reads_a_printed_invoice_when_given_one() {
        let Ok(path) = std::env::var("MAILROOM_TEST_PDF") else { return };
        let text = super::text_of(std::fs::read(path).unwrap()).expect("text");
        eprintln!("---\n{text}\n---");
        assert!(text.contains("1,401.20"));
    }
}
