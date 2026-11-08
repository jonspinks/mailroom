//! Files picked in the compose window, kept until the message is sent.
//!
//! The page hands over the bytes of a file the person picked and gets back
//! an id. Sending refers to files by that id only, so the page can never
//! name a path on disk.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;

/// Exchange Online's default limit for a whole message.
pub const MAX_TOTAL_BYTES: u64 = 35 * 1024 * 1024;
/// Staged files nobody sent are removed after two weeks.
const KEEP_SECS: u64 = 14 * 24 * 60 * 60;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    pub id: String,
    pub size: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StagedRef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub content_type: String,
}

fn dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".cache").join("mailroom").join("outgoing")
}

fn private_dir() -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let dir = dir();
    std::fs::create_dir_all(&dir).map_err(|_| "The file could not be kept for sending.".to_string())?;
    let meta = std::fs::symlink_metadata(&dir).map_err(|_| "The file could not be kept for sending.".to_string())?;
    if !meta.is_dir() {
        return Err("The file could not be kept for sending.".into());
    }
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|_| "The file could not be kept for sending.".to_string())?;
    Ok(dir)
}

/// Ids are 32 hex characters, so one can never point outside the folder.
pub fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn new_id() -> String {
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn too_large() -> String {
    "That file is too large to send. Microsoft accepts up to 35 MB in one message.".into()
}

pub fn stage(data_b64: &str) -> Result<Staged, String> {
    // Base64 is four characters for every three bytes.
    if (data_b64.len() as u64) / 4 * 3 > MAX_TOTAL_BYTES + 3 {
        return Err(too_large());
    }
    let bytes = STANDARD
        .decode(data_b64.trim())
        .map_err(|_| "That file could not be read.".to_string())?;
    if bytes.len() as u64 > MAX_TOTAL_BYTES {
        return Err(too_large());
    }
    let dir = private_dir()?;
    sweep(&dir);
    let id = new_id();
    write_private(&dir.join(&id), &bytes)?;
    Ok(Staged { id, size: bytes.len() as u64 })
}

fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| "The file could not be kept for sending.".to_string())?;
    file.write_all(bytes).map_err(|_| "The file could not be kept for sending.".to_string())
}

pub fn read(id: &str) -> Result<Vec<u8>, String> {
    if !valid_id(id) {
        return Err("An attached file is missing. Attach it again.".into());
    }
    std::fs::read(dir().join(id)).map_err(|_| "An attached file is missing. Attach it again.".to_string())
}

pub fn size(id: &str) -> Option<u64> {
    if !valid_id(id) {
        return None;
    }
    std::fs::metadata(dir().join(id)).ok().map(|meta| meta.len())
}

pub fn forget(ids: &[String]) {
    for id in ids {
        if valid_id(id) {
            let _ = std::fs::remove_file(dir().join(id));
        }
    }
}

fn sweep(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_id(&name) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|when| now.duration_since(when).ok())
            .is_some_and(|age| age.as_secs() > KEEP_SECS);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// A file name for the message, without path parts or control characters.
pub fn clean_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let kept: String = base.chars().filter(|ch| !ch.is_control()).take(200).collect();
    let kept = kept.trim();
    if kept.is_empty() { "attachment".into() } else { kept.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_cannot_leave_the_folder() {
        assert!(valid_id("0123456789abcdef0123456789abcdef"));
        assert!(!valid_id("../../../../etc/passwd"));
        assert!(!valid_id("0123456789ABCDEF0123456789ABCDEF"));
        assert!(!valid_id("0123456789abcdef0123456789abcde/"));
        assert!(!valid_id(""));
        assert!(read("../tokens.json").is_err());
        assert_eq!(size("../x"), None);
        assert!(valid_id(&new_id()));
    }

    #[test]
    fn names_lose_paths_and_controls() {
        assert_eq!(clean_name("../../plan.pdf"), "plan.pdf");
        assert_eq!(clean_name("C:\\docs\\a\u{7}b.txt"), "ab.txt");
        assert_eq!(clean_name("  "), "attachment");
    }

    #[test]
    fn staged_files_are_private_and_read_back() {
        let home = std::env::temp_dir().join(format!("mailroom-stage-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let dir = home.join("outgoing");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(new_id());
        write_private(&path, b"hello").unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(write_private(&path, b"again").is_err());
        let _ = std::fs::remove_dir_all(&home);
        assert!(stage("not base64!!").is_err());
    }
}
