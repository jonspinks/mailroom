//! A message's pictures (2026-10-23, Kai's "Update"): the inline images its
//! body shows by `cid:` (a signature's logo) and its image attachments, which
//! Outlook shows as thumbnails. Mailroom fetched neither. Each comes back as
//! a data URL — only raster image types the page allows, and capped; the
//! page puts a referenced one in place and shows the rest as thumbnails.

use crate::{auth, graph};
use base64::Engine;
use serde::Serialize;

pub const MAX_IMAGES: usize = 20;
// A phone photo is often 5-10 MB, and 3 MB dropped it without a trace
// (2026-11-09). 25 MB is the most Gmail lets a whole message carry.
pub const MAX_IMAGE_BYTES: i64 = 25 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: i64 = 40 * 1024 * 1024;

/// Whether one more picture of `size` bytes fits, after `total` so far.
pub fn fits(size: i64, total: i64) -> bool {
    size > 0 && size <= MAX_IMAGE_BYTES && total + size <= MAX_TOTAL_BYTES
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InlineImage {
    /// The attachment, to open it full size.
    pub id: String,
    pub name: String,
    /// As the body names it after "cid:", without angle brackets; '' if none.
    pub content_id: String,
    /// Marked inline by the sender. One the body doesn't show, and every
    /// ordinary image attachment, is shown as a thumbnail, as Outlook does.
    pub inline: bool,
    pub data_url: String,
}

/// image/png and friends; never SVG, which can carry script.
pub fn allowed_type(content_type: &str) -> Option<&'static str> {
    match content_type.trim().to_ascii_lowercase().split(';').next().unwrap_or("").trim() {
        "image/png" => Some("image/png"),
        "image/jpeg" | "image/jpg" | "image/pjpeg" => Some("image/jpeg"),
        "image/gif" => Some("image/gif"),
        "image/webp" => Some("image/webp"),
        "image/bmp" => Some("image/bmp"),
        _ => None,
    }
}

pub fn clean_content_id(raw: &str) -> String {
    raw.trim().trim_start_matches('<').trim_end_matches('>').trim().to_string()
}

/// One inline attachment's JSON, read: its content id and a data URL.
pub fn image_from(value: &serde_json::Value) -> Option<InlineImage> {
    let inline = value["isInline"].as_bool().unwrap_or(false);
    let content_id = clean_content_id(value["contentId"].as_str().unwrap_or(""));
    if content_id.len() > 300 || (inline && content_id.is_empty() && value["name"].as_str().unwrap_or("").is_empty()) {
        return None;
    }
    let kind = allowed_type(value["contentType"].as_str().unwrap_or(""))?;
    let b64 = value["contentBytes"].as_str()?.trim();
    // Decoded, to be sure it is base64 and within the cap.
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    if bytes.is_empty() || bytes.len() as i64 > MAX_IMAGE_BYTES {
        return None;
    }
    Some(InlineImage {
        id: value["id"].as_str().unwrap_or("").to_string(),
        name: value["name"].as_str().unwrap_or("image").chars().take(200).collect(),
        content_id,
        inline,
        data_url: format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)),
    })
}

pub fn inline_images(email: &str, message_id: &str) -> Result<Vec<InlineImage>, String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let listed = graph::graph_get_pub(&client, &token, &graph::attachments_url(message_id)?)?;
    let mut out = Vec::new();
    let mut total = 0i64;
    for item in listed["value"].as_array().into_iter().flatten() {
        if out.len() >= MAX_IMAGES {
            break;
        }
        if allowed_type(item["contentType"].as_str().unwrap_or("")).is_none() {
            continue;
        }
        let size = item["size"].as_i64().unwrap_or(0);
        if size > MAX_IMAGE_BYTES * 2 || total + size > MAX_TOTAL_BYTES * 2 {
            continue;
        }
        let Some(id) = item["id"].as_str() else { continue };
        let url = format!(
            "https://graph.microsoft.com/v1.0/me/messages/{}/attachments/{}",
            graph::path_segment(message_id.trim()),
            graph::path_segment(id)
        );
        let Ok(full) = graph::graph_get_pub(&client, &token, &url) else { continue };
        if let Some(image) = image_from(&full) {
            total += size;
            out.push(image);
        }
    }
    Ok(out)
}

/// An attachment for the in-app viewer (2026-10-23): a PDF or a picture,
/// as base64 with its type. Anything else is opened outside, as before.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub content_type: String,
    pub data: String,
}

const MAX_PREVIEW_BYTES: usize = 40 * 1024 * 1024;

pub fn preview_type(name: &str, content_type: &str, bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"%PDF-") {
        return Some("application/pdf");
    }
    if let Some(kind) = allowed_type(content_type) {
        return Some(kind);
    }
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".pdf") && bytes.windows(5).take(1024).any(|w| w == b"%PDF-") {
        return Some("application/pdf");
    }
    [(".png", "image/png"), (".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".gif", "image/gif"), (".webp", "image/webp")]
        .iter()
        .find(|(ext, _)| lower.ends_with(ext))
        .map(|(_, kind)| *kind)
}

pub fn preview(email: &str, message_id: &str, file_id: &str, name: &str, content_type: &str) -> Result<Preview, String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let url = graph::attachment_value_url(message_id, file_id)?;
    let bytes = graph::attachment_bytes(&client, &token, &url)?;
    preview_bytes(name, content_type, bytes)
}

/// A preview of a file already fetched: PDFs and pictures only.
pub fn preview_bytes(name: &str, content_type: &str, bytes: Vec<u8>) -> Result<Preview, String> {
    if bytes.len() > MAX_PREVIEW_BYTES {
        return Err("That file is too large to preview. Open it instead.".into());
    }
    let kind = preview_type(name, content_type, &bytes).ok_or("Mailroom can't preview that type of file. Open it instead.")?;
    Ok(Preview { content_type: kind.into(), data: base64::engine::general_purpose::STANDARD.encode(&bytes) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_phone_photo_in_the_body_is_not_dropped() {
        // The planters email: one 8.9 MB JPEG, referenced by cid:.
        assert!(fits(8_882_538, 0));
        assert!(fits(MAX_IMAGE_BYTES, 0));
        assert!(!fits(MAX_IMAGE_BYTES + 1, 0));
        assert!(!fits(0, 0));
        // Several big photos stop at the total, not the first one.
        assert!(fits(9_000_000, 30_000_000));
        assert!(!fits(9_000_000, 35_000_000));
    }

    #[test]
    fn previews_are_pdfs_and_pictures_only() {
        assert_eq!(preview_type("x.bin", "application/octet-stream", b"%PDF-1.7 ..."), Some("application/pdf"));
        assert_eq!(preview_type("photo.JPG", "application/octet-stream", b"\xff\xd8"), Some("image/jpeg"));
        assert_eq!(preview_type("a.png", "image/png", b"x"), Some("image/png"));
        assert_eq!(preview_type("logo.svg", "image/svg+xml", b"<svg/>"), None);
        assert_eq!(preview_type("notes.docx", "application/vnd.openxmlformats", b"PK"), None);
        assert_eq!(preview_type("fake.pdf", "application/pdf", b"<html>"), None);
    }

    #[test]
    fn an_inline_png_becomes_a_data_url_under_its_content_id() {
        let png = base64::engine::general_purpose::STANDARD.encode([0x89, b'P', b'N', b'G', 1, 2, 3]);
        let got = image_from(&json!({ "isInline": true, "contentId": "<image001.png@01DB2A3C.5E6F7A80>", "contentType": "image/png", "contentBytes": png })).unwrap();
        assert_eq!(got.content_id, "image001.png@01DB2A3C.5E6F7A80");
        assert!(got.data_url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn svg_attachments_and_junk_are_refused() {
        let b = base64::engine::general_purpose::STANDARD.encode(b"<svg onload=alert(1)>");
        assert!(image_from(&json!({ "isInline": true, "contentId": "x", "contentType": "image/svg+xml", "contentBytes": b })).is_none());
        let png = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]);
        let photo = image_from(&json!({ "id": "a1", "name": "render.png", "isInline": false, "contentType": "image/png", "contentBytes": png })).unwrap();
        assert_eq!((photo.id.as_str(), photo.name.as_str(), photo.inline, photo.content_id.as_str()), ("a1", "render.png", false, ""));
        assert!(image_from(&json!({ "isInline": true, "contentId": "", "contentType": "image/png", "contentBytes": b })).is_none());
        assert!(image_from(&json!({ "isInline": true, "contentId": "x", "contentType": "image/png", "contentBytes": "%%%not base64" })).is_none());
        assert_eq!(allowed_type("IMAGE/JPEG; name=a.jpg"), Some("image/jpeg"));
    }
}
