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

/// Why there is nothing to update here. A copy from a package (the AUR's
/// mailroom, in /usr/bin) is updated by the package manager, not by git.
fn not_a_clone() -> String {
    let packaged = std::env::current_exe().map(|exe| exe.starts_with("/usr/")).unwrap_or(false);
    if packaged {
        "Mailroom was installed as a package, so update it with your package manager (on Arch: yay -Syu).".into()
    } else {
        "Mailroom is not running from a copy it can update.".into()
    }
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
    let repo = repo_dir().ok_or_else(not_a_clone)?;
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

pub fn log_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".local/state/mailroom/update.log")
}

/// Start the update script on its own. It builds, then closes this copy and
/// starts the new one; if the build fails, this copy keeps running.
pub fn update() -> Result<(), String> {
    let repo = repo_dir().ok_or_else(not_a_clone)?;
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
