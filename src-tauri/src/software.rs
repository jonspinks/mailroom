//! Settings > Software: the installed version, checking GitHub for a newer
//! one, updating with scripts/mailroom-update, and restarting.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Instant;

/// The update script this copy started, and when.
static RUNNING: Mutex<Option<(Child, Instant)>> = Mutex::new(None);

/// The clone Mailroom runs from: the binary is src-tauri/target/<profile>/
/// inside it.
pub fn repo_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|dir| dir.join(".git").exists() && dir.join("scripts").join("mailroom-update").exists())
        .map(Path::to_path_buf)
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "git could not be run.".to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.lines().last().unwrap_or("git failed.").trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// "version": "x.y.z" from a tauri.conf.json.
pub fn version_in(conf: &str) -> String {
    serde_json::from_str::<serde_json::Value>(conf)
        .ok()
        .and_then(|v| v["version"].as_str().map(String::from))
        .unwrap_or_default()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub latest: String,
    /// Changes on GitHub not yet here.
    pub behind: usize,
    /// Their titles, newest first.
    pub changes: Vec<String>,
    /// Edits in the clone would stop a clean update.
    pub local_changes: bool,
    pub repo: String,
}

pub fn check(current: &str) -> Result<UpdateStatus, String> {
    let repo = repo_dir().ok_or("Mailroom is not running from a copy it can update.")?;
    git(&repo, &["fetch", "--quiet", "origin"]).map_err(|e| format!("Could not reach GitHub: {e}"))?;
    let upstream = git(&repo, &["rev-parse", "--abbrev-ref", "@{upstream}"]).unwrap_or_else(|_| "origin/main".into());
    let behind: usize = git(&repo, &["rev-list", "--count", &format!("HEAD..{upstream}")])?.parse().unwrap_or(0);
    let changes = if behind > 0 {
        git(&repo, &["log", "--format=%s", "-n", "15", &format!("HEAD..{upstream}")])?
            .lines()
            .filter(|l| !l.starts_with("Mark version"))
            .map(String::from)
            .collect()
    } else {
        Vec::new()
    };
    let latest = version_in(&git(&repo, &["show", &format!("{upstream}:src-tauri/tauri.conf.json")]).unwrap_or_default());
    let local_changes = !git(&repo, &["status", "--porcelain", "--untracked-files=no"])?.is_empty();
    Ok(UpdateStatus {
        current: current.to_string(),
        latest: if latest.is_empty() { current.to_string() } else { latest },
        behind,
        changes,
        local_changes,
        repo: repo.display().to_string(),
    })
}

/// One change already in this copy, for "What's new" (2026-11-09).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// The day it landed, YYYY-MM-DD.
    pub date: String,
    pub title: String,
    /// The version its title names, as in "Print a message (1.1.0)".
    pub version: String,
    /// Its pull request on GitHub; 0 if none.
    pub pr: u32,
}

/// The newest changes on this copy's branch, newest first. Each pull
/// request is one squashed commit whose title ends "(x.y.z) (#n)".
pub fn whats_new(limit: usize) -> Result<Vec<Change>, String> {
    let repo = repo_dir().ok_or("Mailroom is not running from a copy with its history.")?;
    let log = git(&repo, &["log", "--first-parent", "-n", &limit.to_string(), "--format=%cs%x09%s", "HEAD"])?;
    Ok(log.lines().filter_map(change_from).collect())
}

fn change_from(line: &str) -> Option<Change> {
    let (date, subject) = line.split_once('\t')?;
    let subject = subject.trim();
    if subject.is_empty() || subject.starts_with("Merge ") || subject.starts_with("Mark version") {
        return None;
    }
    let (rest, pr) = match subject.rsplit_once(" (#") {
        Some((rest, tail)) if tail.ends_with(')') => match tail[..tail.len() - 1].parse::<u32>() {
            Ok(n) => (rest.trim_end(), n),
            Err(_) => (subject, 0),
        },
        _ => (subject, 0),
    };
    let (title, version) = match rest.rsplit_once(" (") {
        Some((head, tail)) if tail.ends_with(')') && is_version(&tail[..tail.len() - 1]) => (head.trim_end(), tail[..tail.len() - 1].to_string()),
        _ => (rest, String::new()),
    };
    Some(Change { date: date.trim().to_string(), title: title.to_string(), version, pr })
}

fn is_version(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

pub fn log_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".local/state/mailroom/update.log")
}

/// Start the update script on its own. It builds, then closes this copy and
/// starts the new one; if the build fails, this copy keeps running.
pub fn update() -> Result<(), String> {
    let repo = repo_dir().ok_or("Mailroom is not running from a copy it can update.")?;
    let log = log_path();
    if let Some(dir) = log.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Check first: a second click must not empty the running update's log.
    let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((child, _)) = running.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return Err("An update is already running.".into());
        }
    }
    let out = std::fs::File::create(&log).map_err(|_| "The update log could not be written.".to_string())?;
    let err = out.try_clone().map_err(|_| "The update log could not be written.".to_string())?;
    let child = Command::new("setsid")
        .arg(repo.join("scripts").join("mailroom-update"))
        .env("MAILROOM_DIR", &repo)
        // The script stops exactly this process, after checking its program file.
        .env("MAILROOM_PID", std::process::id().to_string())
        .current_dir(&repo)
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .spawn()
        .map_err(|_| "The update could not be started.".to_string())?;
    *running = Some((child, Instant::now()));
    Ok(())
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    /// "idle", "fetch", "build", "restart", "done" or "failed".
    pub stage: String,
    /// The crate being compiled, when building.
    pub detail: String,
    pub elapsed: u64,
    /// How long the last update took to build, in seconds; 0 when unknown.
    pub estimate: u64,
}

/// Where the running update has got to, read from its log.
pub fn progress() -> UpdateProgress {
    let mut running = RUNNING.lock().unwrap_or_else(|e| e.into_inner());
    let Some((child, started)) = running.as_mut() else {
        return UpdateProgress { stage: "idle".into(), ..Default::default() };
    };
    let exited = child.try_wait().ok().flatten();
    let log = std::fs::read_to_string(log_path()).unwrap_or_default();
    let estimate = std::fs::read_to_string(log_path().with_file_name("update-seconds"))
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let (stage, detail) = progress_in(&log, exited.map(|s| s.success()));
    UpdateProgress { stage, detail, elapsed: started.elapsed().as_secs(), estimate }
}

/// The stage and current crate from the script's log; `exited` is whether it
/// finished cleanly, once it has.
fn progress_in(log: &str, exited: Option<bool>) -> (String, String) {
    if exited == Some(false) {
        return ("failed".into(), String::new());
    }
    let mut stage = "fetch";
    let mut detail = String::new();
    for line in log.lines().map(str::trim) {
        if line.starts_with("Building Mailroom") {
            stage = "build";
        } else if line.starts_with("Restarting Mailroom") {
            stage = "restart";
        } else if let Some(rest) = line.strip_prefix("Compiling ") {
            detail = rest.split_whitespace().next().unwrap_or("").to_string();
        }
    }
    if exited == Some(true) {
        stage = "done";
    }
    (stage.into(), if stage == "build" { detail } else { String::new() })
}

/// The end of the last update's log, to show what went wrong.
pub fn update_log() -> String {
    let text = std::fs::read_to_string(log_path()).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(20)..].join("\n")
}

/// Start a fresh copy once this one has exited, then exit.
pub fn restart(app: &tauri::AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|_| "Mailroom could not find itself.".to_string())?;
    let pid = std::process::id().to_string();
    Command::new("setsid")
        .args(["sh", "-c", "while kill -0 \"$1\" 2>/dev/null; do sleep 0.2; done; exec \"$2\"", "mailroom-restart", &pid])
        .arg(&exe)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Mailroom could not restart.".to_string())?;
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{change_from, Change};

    #[test]
    fn whats_new_reads_squashed_pull_request_titles() {
        let c = |date: &str, title: &str, version: &str, pr| Change { date: date.into(), title: title.into(), version: version.into(), pr };
        assert_eq!(change_from("2026-11-09\tPrint a message (1.1.0) (#20)"), Some(c("2026-11-09", "Print a message", "1.1.0", 20)));
        assert_eq!(change_from("2026-11-08\trand 0.10; no build warnings (#12)"), Some(c("2026-11-08", "rand 0.10; no build warnings", "", 12)));
        assert_eq!(change_from("2026-11-08\tMailroom 1.0.0"), Some(c("2026-11-08", "Mailroom 1.0.0", "", 0)));
        // A bracket that is not a version stays in the title.
        assert_eq!(change_from("2026-11-08\tDependencies: tauri (Linux) (#14)"), Some(c("2026-11-08", "Dependencies: tauri (Linux)", "", 14)));
        assert_eq!(change_from("2026-11-08\tMerge branch 'x'"), None);
        assert_eq!(change_from("no tab here"), None);
    }

    #[test]
    fn version_comes_from_the_config() {
        assert_eq!(super::version_in(r#"{ "productName": "Mailroom", "version": "0.14.0" }"#), "0.14.0");
        assert_eq!(super::version_in("not json"), "");
    }

    #[test]
    fn progress_follows_the_log() {
        let log = "2026-10-23 mailroom-update\nFetching the new version…\n";
        assert_eq!(super::progress_in(log, None), ("fetch".into(), "".into()));
        let log = format!("{log}Building Mailroom 0.26.0 (release)…\n   Compiling serde v1.0.0\n   Compiling mailroom v0.26.0 (/x)\n");
        assert_eq!(super::progress_in(&log, None), ("build".into(), "mailroom".into()));
        assert_eq!(super::progress_in(&log, Some(false)).0, "failed");
        let log = format!("{log}    Finished `release` profile\nRestarting Mailroom…\n");
        assert_eq!(super::progress_in(&log, None), ("restart".into(), "".into()));
        assert_eq!(super::progress_in(&log, Some(true)).0, "done");
    }
}
