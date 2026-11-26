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
    /// image/png and friends (allowed_type).
    pub content_type: String,
    /// The picture itself. It goes to the page as bytes after the list, not
    /// as base64 inside JSON (2.0, #75; see pack_images).
    #[serde(skip)]
    pub bytes: Vec<u8>,
}

/// The list for the page, as one binary answer: a 4-byte big-endian length,
/// that many bytes of JSON (each picture's details and `length`), then the
/// pictures' bytes one after another in the same order.
pub fn pack_images(list: &[InlineImage]) -> Vec<u8> {
    let meta: Vec<serde_json::Value> = list
        .iter()
        .map(|img| serde_json::json!({ "id": img.id, "name": img.name, "contentId": img.content_id, "inline": img.inline, "contentType": img.content_type, "length": img.bytes.len() }))
        .collect();
    let json = serde_json::to_vec(&meta).unwrap_or_else(|_| b"[]".to_vec());
    let mut out = Vec::with_capacity(4 + json.len() + list.iter().map(|img| img.bytes.len()).sum::<usize>());
    out.extend_from_slice(&(json.len() as u32).to_be_bytes());
    out.extend_from_slice(&json);
    for img in list {
        out.extend_from_slice(&img.bytes);
    }
    out
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
        content_type: kind.to_string(),
        bytes,
    })
}

pub fn inline_images(email: &str, message_id: &str) -> Result<Vec<InlineImage>, String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let listed = graph::graph_get_pub(&client, &token, &graph::attachments_url(message_id)?)?;
    let empty = Vec::new();
    let items = listed["value"].as_array().unwrap_or(&empty);
    let mut out = Vec::new();
    let mut total = 0i64;
    let mut from = 0usize;
    // Normally one round. Another only when a picture could not be fetched
    // or read and there are more listed to take its place.
    loop {
        let (picked, next) = pick_images(items, from, out.len(), total);
        if picked.is_empty() {
            break;
        }
        from = next;
        let fetched = in_order(&picked, FETCHERS, |(id, _)| {
            let url = format!(
                "https://graph.microsoft.com/v1.0/me/messages/{}/attachments/{}",
                graph::path_segment(message_id.trim()),
                graph::path_segment(id)
            );
            image_from(&graph::graph_get_pub(&client, &token, &url).ok()?)
        });
        for ((_, size), image) in picked.iter().zip(fetched) {
            if let Some(image) = image {
                total += size;
                out.push(image);
            }
        }
    }
    Ok(out)
}

/// Pictures fetched at once. Graph calls wait for one of the mailbox's three
/// request slots anyway, so more threads would only queue.
const FETCHERS: usize = 3;

/// The next pictures to fetch, as (attachment id, listed size), from item
/// `from` on, and where the round after it starts: as many as still fit the
/// count and the size caps after `have` pictures of `total` bytes, in the
/// listed order.
fn pick_images(items: &[serde_json::Value], from: usize, have: usize, total: i64) -> (Vec<(String, i64)>, usize) {
    let mut picked = Vec::new();
    let mut planned = total;
    let mut next = items.len();
    for (index, item) in items.iter().enumerate().skip(from) {
        if have + picked.len() >= MAX_IMAGES {
            next = index;
            break;
        }
        if allowed_type(item["contentType"].as_str().unwrap_or("")).is_none() {
            continue;
        }
        let size = item["size"].as_i64().unwrap_or(0);
        if size > MAX_IMAGE_BYTES * 2 || planned + size > MAX_TOTAL_BYTES * 2 {
            continue;
        }
        let Some(id) = item["id"].as_str() else { continue };
        planned += size;
        picked.push((id.to_string(), size));
    }
    (picked, next)
}

/// `work` on every job, a few at a time, with the answers in the jobs' order.
fn in_order<J: Sync, R: Send>(jobs: &[J], workers: usize, work: impl Fn(&J) -> Option<R> + Sync) -> Vec<Option<R>> {
    let next = std::sync::atomic::AtomicUsize::new(0);
    let done = std::sync::Mutex::new((0..jobs.len()).map(|_| None).collect::<Vec<Option<R>>>());
    std::thread::scope(|scope| {
        for _ in 0..workers.min(jobs.len()) {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(job) = jobs.get(index) else { break };
                let answer = work(job);
                done.lock().unwrap_or_else(|e| e.into_inner())[index] = answer;
            });
        }
    });
    done.into_inner().unwrap_or_else(|e| e.into_inner())
}

/// An attachment for the in-app viewer (2026-10-23): a PDF or a picture,
/// with its type. Anything else is opened outside, as before. Since 2.0
/// (#75) it reaches the page as bytes (pack), not 40 MB of base64 in JSON.
#[derive(Debug)]
pub struct Preview {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

impl Preview {
    /// The type, a newline, then the file.
    pub fn pack(self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.content_type.len() + 1 + self.bytes.len());
        out.extend_from_slice(self.content_type.as_bytes());
        out.push(b'\n');
        out.extend(self.bytes);
        out
    }
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
    Ok(Preview { content_type: kind.into(), bytes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pictures_fetched_together_keep_their_order() {
        // The first job answers last; the answers still come in job order.
        let jobs: Vec<u64> = vec![30, 0, 10, 0, 20, 0, 0];
        let seen = std::sync::Mutex::new(Vec::new());
        let got = in_order(&jobs, 3, |wait| {
            std::thread::sleep(std::time::Duration::from_millis(*wait));
            seen.lock().unwrap().push(*wait);
            (*wait != 10).then_some(*wait)
        });
        assert_eq!(got, vec![Some(30), Some(0), None, Some(0), Some(20), Some(0), Some(0)]);
        assert_eq!(seen.lock().unwrap().len(), jobs.len(), "every job ran once");
        assert!(in_order(&Vec::<u64>::new(), 3, |n| Some(*n)).is_empty());
    }

    #[test]
    fn the_caps_choose_which_pictures_are_fetched() {
        let item = |id: &str, kind: &str, size: i64| json!({ "id": id, "contentType": kind, "size": size });
        let items = vec![
            item("a", "image/png", 1000),
            item("doc", "application/pdf", 1000),
            item("huge", "image/jpeg", MAX_IMAGE_BYTES * 2 + 1),
            item("b", "image/jpeg", 2000),
            json!({ "contentType": "image/png", "size": 5 }),
        ];
        let (picked, next) = pick_images(&items, 0, 0, 0);
        assert_eq!(picked, vec![("a".to_string(), 1000), ("b".to_string(), 2000)]);
        assert_eq!(next, items.len());
        // What is already held counts against the total.
        let (picked, _) = pick_images(&items, 0, 0, MAX_TOTAL_BYTES * 2 - 1500);
        assert_eq!(picked, vec![("a".to_string(), 1000)]);
        // No more than MAX_IMAGES in all; the next round starts where this stopped.
        let many: Vec<_> = (0..MAX_IMAGES + 5).map(|n| item(&format!("p{n}"), "image/png", 10)).collect();
        let (picked, next) = pick_images(&many, 0, 0, 0);
        assert_eq!((picked.len(), next), (MAX_IMAGES, MAX_IMAGES));
        let (more, end) = pick_images(&many, next, MAX_IMAGES - 2, 0);
        assert_eq!(more.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["p20", "p21"]);
        assert_eq!(end, MAX_IMAGES + 2);
        assert!(pick_images(&many, next, MAX_IMAGES, 0).0.is_empty());
    }

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
        assert_eq!((got.content_type.as_str(), got.bytes.as_slice()), ("image/png", &[0x89, b'P', b'N', b'G', 1, 2, 3][..]));
    }

    #[test]
    fn pictures_and_previews_pack_as_bytes() {
        let img = |id: &str, bytes: &[u8]| InlineImage { id: id.into(), name: "a.png".into(), content_id: "c".into(), inline: true, content_type: "image/png".into(), bytes: bytes.to_vec() };
        let packed = pack_images(&[img("1", b"abc"), img("2", b"de")]);
        let len = u32::from_be_bytes([packed[0], packed[1], packed[2], packed[3]]) as usize;
        let meta: serde_json::Value = serde_json::from_slice(&packed[4..4 + len]).unwrap();
        assert_eq!(meta[0]["length"], 3);
        assert_eq!(meta[1]["contentType"], "image/png");
        assert_eq!(&packed[4 + len..], b"abcde");
        assert_eq!(pack_images(&[]), [0, 0, 0, 2, b'[', b']']);
        let preview = Preview { content_type: "application/pdf".into(), bytes: b"%PDF-1".to_vec() };
        assert_eq!(preview.pack(), b"application/pdf\n%PDF-1");
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
