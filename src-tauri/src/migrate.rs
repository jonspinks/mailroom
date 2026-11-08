//! Moving an install from its old name. Up to 0.35 this app was Nowtlook:
//! its folders, keyring items and webview data carried that name. Up to
//! 0.36 its id was com.engrained.mailroom, which named the webview data. The first
//! Mailroom to start moves them across, before the webview opens (it reads
//! its saved settings from the data folder). Each step only runs while the
//! old thing exists and the new one does not, so it is safe on every start.

use std::path::{Path, PathBuf};

pub const OLD_NAME: &str = "nowtlook";
const NEW_NAME: &str = "mailroom";
/// The Tauri identifier names the webview's folders: Nowtlook's, then
/// Mailroom's first, then this one.
const OLD_IDS: [&str; 2] = ["com.engrained.mailroom", "com.engrained.nowtlook"];
const NEW_ID: &str = "io.github.jonspinks.mailroom";

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
}

fn data_home() -> PathBuf {
    match std::env::var("XDG_DATA_HOME") {
        Ok(dir) if dir.starts_with('/') => PathBuf::from(dir),
        _ => home().join(".local").join("share"),
    }
}

/// Folder pairs to move: the app's own, then the webview's (named after the
/// Tauri identifier).
fn folder_pairs(home: &Path, data: &Path) -> Vec<(PathBuf, PathBuf)> {
    let mut pairs = Vec::new();
    for base in [home.join(".config"), home.join(".local").join("state"), home.join(".cache")] {
        pairs.push((base.join(OLD_NAME), base.join(NEW_NAME)));
    }
    // The newer old id first: where both exist, it holds the newer data.
    for old_id in OLD_IDS {
        pairs.push((data.join(old_id), data.join(NEW_ID)));
        pairs.push((home.join(".cache").join(old_id), home.join(".cache").join(NEW_ID)));
    }
    pairs
}

/// Move each old folder to its new name when only the old one exists. A
/// rename on the same filesystem is atomic, so mail.db and its journal move
/// together. Returns what moved, for the log.
fn move_folders(pairs: &[(PathBuf, PathBuf)]) -> Vec<String> {
    let mut moved = Vec::new();
    for (old, new) in pairs {
        if old.is_dir() && !new.exists() && std::fs::rename(old, new).is_ok() {
            moved.push(format!("{} -> {}", old.display(), new.display()));
        }
    }
    moved
}

/// A copy of the old app still running would keep writing to the old
/// folders (and mail.db) while we move them. Leave everything for next time.
fn old_app_running() -> bool {
    let me = std::process::id().to_string();
    let Ok(procs) = std::fs::read_dir("/proc") else { return false };
    procs.flatten().any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        name.chars().all(|c| c.is_ascii_digit())
            && name != me
            && std::fs::read_to_string(entry.path().join("comm")).map(|comm| comm.trim() == OLD_NAME).unwrap_or(false)
    })
}

/// Copy each secret saved under the old service name to the new one, check
/// it reads back, then delete the old item. Where the new one already
/// exists it wins and the old item just goes.
#[cfg(target_os = "linux")]
fn move_keyring(old_name: &str, new_name: &str) -> usize {
    use dbus_secret_service::{EncryptionType, SecretService};
    use std::collections::HashMap;
    let Ok(service) = SecretService::connect(EncryptionType::Plain) else { return 0 };
    let Ok(found) = service.search_items(HashMap::from([("service", old_name)])) else { return 0 };
    let mut moved = 0;
    // A locked item is left for a start when the keyring is open.
    for item in found.unlocked.iter() {
        let Ok(attrs) = item.get_attributes() else { continue };
        let Some(user) = attrs.get("username") else { continue };
        let Ok(new) = keyring::Entry::new(new_name, user) else { continue };
        if new.get_password().is_err() {
            let Ok(secret) = item.get_secret() else { continue };
            let Ok(secret) = String::from_utf8(secret) else { continue };
            if new.set_password(&secret).is_err() {
                continue;
            }
            let Ok(again) = keyring::Entry::new(new_name, user) else { continue };
            if again.get_password().ok().as_deref() != Some(secret.as_str()) {
                continue;
            }
        }
        if item.delete().is_ok() {
            moved += 1;
        }
    }
    moved
}

#[cfg(not(target_os = "linux"))]
fn move_keyring(_old_name: &str, _new_name: &str) -> usize {
    0
}

/// Everything that has to happen before the webview starts.
pub fn before_start() {
    if old_app_running() {
        eprintln!("mailroom: Nowtlook is still running, so its settings were not moved yet");
        return;
    }
    let moved = move_folders(&folder_pairs(&home(), &data_home()));
    let secrets = move_keyring(OLD_NAME, NEW_NAME);
    if !moved.is_empty() || secrets > 0 {
        let note = format!("moved from Nowtlook: {}; {} keyring item(s)", moved.join(", "), secrets);
        eprintln!("mailroom: {note}");
        log(&note);
    }
}

/// A line in ~/.local/state/mailroom/mailroom.log, which the old name's log
/// becomes.
fn log(note: &str) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let dir = home().join(".local").join("state").join(NEW_NAME);
    let old_log = dir.join(format!("{OLD_NAME}.log"));
    let new_log = dir.join(format!("{NEW_NAME}.log"));
    if old_log.is_file() && !new_log.exists() {
        let _ = std::fs::rename(&old_log, &new_log);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if std::fs::create_dir_all(&dir).is_ok() {
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(new_log) {
            let _ = writeln!(file, "{stamp} {note}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_move_once_and_never_over_new_ones() {
        let root = std::env::temp_dir().join(format!("mailroom-migrate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let data = home.join(".local/share");
        std::fs::create_dir_all(home.join(".config/nowtlook")).unwrap();
        std::fs::write(home.join(".config/nowtlook/mail.db"), "db").unwrap();
        std::fs::create_dir_all(data.join("com.engrained.nowtlook/localstorage")).unwrap();
        // Both names in state: the new one is kept as it is.
        std::fs::create_dir_all(home.join(".local/state/nowtlook")).unwrap();
        std::fs::create_dir_all(home.join(".local/state/mailroom")).unwrap();
        std::fs::write(home.join(".local/state/mailroom/keep"), "new").unwrap();

        let pairs = folder_pairs(&home, &data);
        let moved = move_folders(&pairs);
        assert_eq!(moved.len(), 2, "{moved:?}");
        assert_eq!(std::fs::read_to_string(home.join(".config/mailroom/mail.db")).unwrap(), "db");
        assert!(!home.join(".config/nowtlook").exists());
        assert!(data.join("io.github.jonspinks.mailroom/localstorage").is_dir());
        assert!(home.join(".local/state/nowtlook").is_dir(), "old state left beside a new one");
        assert_eq!(std::fs::read_to_string(home.join(".local/state/mailroom/keep")).unwrap(), "new");
        assert!(move_folders(&pairs).is_empty(), "nothing moves twice");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_first_mailroom_id_moves_to_the_new_one() {
        let root = std::env::temp_dir().join(format!("mailroom-migrate-id-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let data = home.join(".local/share");
        std::fs::create_dir_all(data.join("com.engrained.mailroom/localstorage")).unwrap();
        std::fs::write(data.join("com.engrained.mailroom/localstorage/keep"), "0.36").unwrap();
        // An older Nowtlook folder left behind never wins over it.
        std::fs::create_dir_all(data.join("com.engrained.nowtlook/localstorage")).unwrap();
        move_folders(&folder_pairs(&home, &data));
        assert_eq!(std::fs::read_to_string(data.join("io.github.jonspinks.mailroom/localstorage/keep")).unwrap(), "0.36");
        assert!(!data.join("com.engrained.mailroom").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Needs the session keyring, so not run by default:
    ///   cargo test keyring_items_move -- --ignored
    #[test]
    #[ignore]
    fn keyring_items_move() {
        let (old, new) = ("mailroom-test-old", "mailroom-test-new");
        keyring::Entry::new(old, "tokens").unwrap().set_password("secret-1").unwrap();
        keyring::Entry::new(old, "both").unwrap().set_password("stale").unwrap();
        keyring::Entry::new(new, "both").unwrap().set_password("current").unwrap();
        assert_eq!(move_keyring(old, new), 2);
        assert_eq!(keyring::Entry::new(new, "tokens").unwrap().get_password().unwrap(), "secret-1");
        assert_eq!(keyring::Entry::new(new, "both").unwrap().get_password().unwrap(), "current");
        assert!(keyring::Entry::new(old, "tokens").unwrap().get_password().is_err());
        assert!(keyring::Entry::new(old, "both").unwrap().get_password().is_err());
        assert_eq!(move_keyring(old, new), 0);
        let _ = keyring::Entry::new(new, "tokens").unwrap().delete_credential();
        let _ = keyring::Entry::new(new, "both").unwrap().delete_credential();
    }
}
