//! Omarchy, when Mailroom finds itself running on it.
//!
//! Nothing here changes Mailroom anywhere else. Omarchy is detected by its
//! state folder holding a current theme; without one, `look()` is `None`, the
//! watcher never starts, and the page keeps its own look.
//!
//! On Omarchy, Mailroom follows the theme's colours, the system monospace
//! font and Hyprland's window corners, and can make itself the desktop's mail
//! app (the mailto handler and the Super+Shift+E bindings) and put an unread
//! count in the Omarchy bar.

use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// The app's id: the Tauri identifier, the icon's name and the desktop
/// entry's, which is also what mimeapps.list names.
pub const APP_ID: &str = "io.github.jonspinks.mailroom";
pub const DESKTOP_ID: &str = "io.github.jonspinks.mailroom.desktop";
/// The Omarchy shell plugin that shows unread mail in the bar.
pub const PLUGIN_ID: &str = "blacksheep.mailroom";

const BINDINGS_START: &str = "-- Mailroom: begin (added by Mailroom > Settings > Omarchy; remove this block to undo)";
const BINDINGS_END: &str = "-- Mailroom: end";
// What the app wrote under its old names: Nowtlook up to 0.35, then
// Mailroom with its first id up to 0.36. (icon and desktop id, bar plugin,
// the line that marked the desktop entry as the app's own)
const OLD_SETUPS: [(&str, &str, &str); 2] = [
    ("com.engrained.nowtlook", "engrained.nowtlook", "X-Nowtlook-Managed=true"),
    ("com.engrained.mailroom", "engrained.mailroom", "X-Mailroom-Managed=true"),
];
const OLD_BINDINGS_BEGIN: &str = "-- Nowtlook: begin";
const OLD_BINDINGS_END: &str = "-- Nowtlook: end";

/// The palette keys the page maps onto its colours, as Omarchy's
/// colors.toml names them.
const PALETTE_KEYS: [&str; 25] = [
    "accent",
    "selection",
    "muted",
    "background",
    "dark_background",
    "darker_background",
    "lighter_background",
    "foreground",
    "dark_foreground",
    "light_foreground",
    "bright_foreground",
    "red",
    "yellow",
    "orange",
    "green",
    "cyan",
    "blue",
    "magenta",
    "brown",
    "bright_red",
    "bright_yellow",
    "bright_green",
    "bright_cyan",
    "bright_blue",
    "bright_magenta",
];

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Look {
    /// The theme's name for people, such as "Tokyo Night".
    pub theme: String,
    /// "dark" or "light".
    pub mode: String,
    /// Palette key to `#rrggbb`. Only hex colours are passed on.
    pub colors: BTreeMap<String, String>,
    /// The system monospace family, or empty when fontconfig would not say.
    pub font: String,
    /// Hyprland's window corner radius in pixels.
    pub rounding: i64,
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
}

fn state_home() -> PathBuf {
    match std::env::var("XDG_STATE_HOME") {
        Ok(dir) if dir.starts_with('/') => PathBuf::from(dir),
        _ => home().join(".local").join("state"),
    }
}

fn data_home() -> PathBuf {
    match std::env::var("XDG_DATA_HOME") {
        Ok(dir) if dir.starts_with('/') => PathBuf::from(dir),
        _ => home().join(".local").join("share"),
    }
}

fn config_home() -> PathBuf {
    match std::env::var("XDG_CONFIG_HOME") {
        Ok(dir) if dir.starts_with('/') => PathBuf::from(dir),
        _ => home().join(".config"),
    }
}

fn current_dir() -> PathBuf {
    state_home().join("omarchy").join("current")
}

fn colors_file() -> PathBuf {
    current_dir().join("theme").join("colors.toml")
}

/// True on Omarchy: its state folder has a current theme.
pub fn detected() -> bool {
    colors_file().is_file()
}

/// What Mailroom should look like on this Omarchy, or None off Omarchy.
pub fn look() -> Option<Look> {
    if !detected() {
        return None;
    }
    let (mode, colors) = palette();
    if colors.get("background").is_none() {
        return None;
    }
    Some(Look {
        theme: theme_name(),
        mode,
        colors,
        font: monospace_font(),
        rounding: rounding(),
    })
}

/// The resolved palette. `omarchy-theme-color --all` applies the same
/// fallbacks Omarchy's own templates do, so Mailroom matches the terminal
/// and the bar; reading colors.toml directly is the fallback.
fn palette() -> (String, BTreeMap<String, String>) {
    let resolved = Command::new("omarchy-theme-color")
        .arg("--all")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned());
    let (mode, colors) = match resolved {
        Some(text) => parse_resolved(&text),
        None => (String::new(), BTreeMap::new()),
    };
    if colors.contains_key("background") && colors.contains_key("foreground") {
        let mode = if mode.is_empty() { mode_from(&colors) } else { mode };
        return (mode, colors);
    }
    let text = fs::read_to_string(colors_file()).unwrap_or_default();
    let (declared, mut colors) = parse_colors_toml(&text);
    fill_gaps(&mut colors);
    let mode = if declared.is_empty() { mode_from(&colors) } else { declared };
    (mode, colors)
}

/// `key<TAB>value` lines, as `omarchy-theme-color --all` prints them.
fn parse_resolved(text: &str) -> (String, BTreeMap<String, String>) {
    let mut mode = String::new();
    let mut colors = BTreeMap::new();
    for line in text.lines() {
        let Some((key, value)) = line.split_once('\t') else { continue };
        let key = key.trim();
        let value = value.trim();
        if key == "mode" {
            mode = clean_mode(value);
        } else if PALETTE_KEYS.contains(&key) {
            if let Some(hex) = hex_color(value) {
                colors.insert(key.to_string(), hex);
            }
        }
    }
    (mode, colors)
}

/// The flat `key = "value"` lines of a theme's colors.toml.
fn parse_colors_toml(text: &str) -> (String, BTreeMap<String, String>) {
    let mut mode = String::new();
    let mut colors = BTreeMap::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('[') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim().trim_matches(|c| c == '"' || c == '\'');
        let value = value.trim();
        let value = if let Some(rest) = value.strip_prefix('"') {
            rest.split('"').next().unwrap_or("")
        } else if let Some(rest) = value.strip_prefix('\'') {
            rest.split('\'').next().unwrap_or("")
        } else {
            value.split_whitespace().next().unwrap_or("")
        };
        if key == "mode" || key == "theme_type" {
            if mode.is_empty() {
                mode = clean_mode(value);
            }
        } else if PALETTE_KEYS.contains(&key) {
            if let Some(hex) = hex_color(value) {
                colors.insert(key.to_string(), hex);
            }
        }
    }
    (mode, colors)
}

/// The fallbacks that matter when only colors.toml could be read.
fn fill_gaps(colors: &mut BTreeMap<String, String>) {
    let pairs = [
        ("lighter_background", "background"),
        ("dark_background", "background"),
        ("darker_background", "background"),
        ("selection", "lighter_background"),
        ("muted", "dark_foreground"),
        ("dark_foreground", "foreground"),
        ("muted", "foreground"),
        ("accent", "blue"),
        ("orange", "yellow"),
        ("bright_magenta", "magenta"),
        ("bright_yellow", "yellow"),
    ];
    for (key, from) in pairs {
        if !colors.contains_key(key) {
            if let Some(value) = colors.get(from).cloned() {
                colors.insert(key.to_string(), value);
            }
        }
    }
}

fn clean_mode(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "light" => "light".into(),
        "dark" => "dark".into(),
        _ => String::new(),
    }
}

/// Light when the background is pale, as Omarchy decides for themes that do
/// not say.
fn mode_from(colors: &BTreeMap<String, String>) -> String {
    let Some(bg) = colors.get("background") else { return "dark".into() };
    let sum: u32 = (0..3)
        .filter_map(|i| u8::from_str_radix(&bg[1 + i * 2..3 + i * 2], 16).ok())
        .map(u32::from)
        .sum();
    if sum > 382 { "light".into() } else { "dark".into() }
}

/// `#rrggbb` in lower case, from `#rrggbb` or `0xrrggbb`; anything else is
/// refused, so nothing but a colour reaches the page's styles.
fn hex_color(value: &str) -> Option<String> {
    let value = value.trim();
    let digits = value.strip_prefix('#').or_else(|| value.strip_prefix("0x"))?;
    if digits.len() == 6 && digits.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(format!("#{}", digits.to_ascii_lowercase()))
    } else {
        None
    }
}

/// "tokyo-night" becomes "Tokyo Night".
fn theme_name() -> String {
    let raw = fs::read_to_string(current_dir().join("theme.name")).unwrap_or_default();
    pretty_theme(&raw)
}

fn pretty_theme(raw: &str) -> String {
    let name = raw.lines().next().unwrap_or("").trim();
    if name.is_empty() {
        return "Omarchy".into();
    }
    if name.chars().any(|c| c.is_uppercase()) || name.contains(' ') {
        return clip_name(name);
    }
    let words: Vec<String> = name
        .split(['-', '_'])
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect();
    clip_name(&words.join(" "))
}

fn clip_name(name: &str) -> String {
    name.chars().filter(|c| !c.is_control()).take(40).collect()
}

/// The system monospace family, which Omarchy's `font set` writes through
/// fontconfig and its shell and terminals all use.
fn monospace_font() -> String {
    let out = Command::new("fc-match")
        .args(["monospace", "-f", "%{family}\n"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        .unwrap_or_default();
    clean_family(&out)
}

/// The first family of fontconfig's list, kept to characters that are safe
/// inside a quoted CSS family name.
fn clean_family(raw: &str) -> String {
    let first = raw.lines().next().unwrap_or("").split(',').next().unwrap_or("").trim();
    if first.is_empty() || first.len() > 80 {
        return String::new();
    }
    if first.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.')) {
        first.to_string()
    } else {
        String::new()
    }
}

/// Hyprland's corner radius. Asked of Hyprland itself, so a theme's own
/// rounding counts; Omarchy's corner toggles are the fallback.
fn rounding() -> i64 {
    let asked = Command::new("hyprctl")
        .args(["getoption", "decoration:rounding", "-j"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| serde_json::from_slice::<serde_json::Value>(&out.stdout).ok())
        .and_then(|value| value.get("int").and_then(|n| n.as_i64()));
    if let Some(radius) = asked {
        return radius.clamp(0, 24);
    }
    let toggles = state_home().join("omarchy").join("toggles").join("hypr");
    if toggles.join("corners-rounded.lua").is_file() { 6 } else { 0 }
}

/// Changes to the theme, the font or the corners, as one string that is
/// cheap to read every couple of seconds.
fn fingerprint() -> String {
    let stamp = |path: PathBuf| -> String {
        fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis().to_string())
            .unwrap_or_default()
    };
    let generation = fs::read_to_string(current_dir().join("theme.generation")).unwrap_or_default();
    let toggles = state_home().join("omarchy").join("toggles").join("hypr");
    format!(
        "{}|{}|{}|{}|{}",
        generation.trim(),
        stamp(colors_file()),
        stamp(config_home().join("fontconfig").join("fonts.conf")),
        stamp(toggles.join("corners-sharp.lua")),
        stamp(toggles.join("corners-rounded.lua")),
    )
}

/// The page function that takes a new look, with the look as JSON data.
pub fn look_script(look: &Look) -> String {
    let json = serde_json::to_string(look).unwrap_or_else(|_| "null".into());
    format!("window.applyOmarchyLook && window.applyOmarchyLook({json});")
}

/// Follow theme, font and corner changes into every open window. Only
/// started on Omarchy.
pub fn watch(app: AppHandle) {
    if !detected() {
        return;
    }
    std::thread::spawn(move || {
        let mut last = fingerprint();
        loop {
            std::thread::sleep(Duration::from_secs(2));
            let now = fingerprint();
            if now == last {
                continue;
            }
            last = now;
            // Omarchy writes the theme in several steps; let it finish.
            std::thread::sleep(Duration::from_millis(400));
            let Some(look) = look() else { continue };
            let script = look_script(&look);
            for window in app.webview_windows().values() {
                let _ = window.eval(&script);
            }
        }
    });
}

// ---- Being Omarchy's mail app -------------------------------------------

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MailAppStatus {
    pub omarchy: bool,
    /// Mailroom opens mailto: links.
    pub mailto: bool,
    /// Super+Shift+E opens Mailroom.
    pub keys: bool,
    /// The unread count is in the Omarchy bar.
    pub bar_widget: bool,
}

pub fn mail_app_status() -> MailAppStatus {
    if !detected() {
        return MailAppStatus::default();
    }
    MailAppStatus {
        omarchy: true,
        mailto: mailto_default().as_deref() == Some(DESKTOP_ID),
        keys: fs::read_to_string(bindings_file()).map(|text| text.contains(BINDINGS_START)).unwrap_or(false),
        bar_widget: plugin_dir().join("manifest.json").is_file(),
    }
}

fn mailto_default() -> Option<String> {
    let out = Command::new("xdg-mime")
        .args(["query", "default", "x-scheme-handler/mailto"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

fn exe_path() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|_| "Mailroom could not find itself.".to_string())?;
    let path = exe.to_string_lossy().into_owned();
    // A deleted binary (rebuilt while running) reads back with this suffix.
    let path = path.strip_suffix(" (deleted)").unwrap_or(&path).to_string();
    if path.is_empty() || path.chars().any(|c| c.is_control()) {
        return Err("Mailroom is installed in a folder it cannot name.".into());
    }
    Ok(path)
}

/// Make Mailroom the mail app: a desktop entry and icon, the mailto handler,
/// and Super+Shift+E (Super+Shift+Alt+E for a new message).
pub fn make_mail_app() -> Result<MailAppStatus, String> {
    if !detected() {
        return Err("This is not Omarchy.".into());
    }
    let exe = exe_path()?;
    install_desktop_entry(&exe)?;
    let set = Command::new("xdg-mime")
        .args(["default", DESKTOP_ID, "x-scheme-handler/mailto"])
        .status()
        .map_err(|_| "xdg-mime is not installed.".to_string())?;
    if !set.success() {
        return Err("xdg-mime could not make Mailroom the mail app.".into());
    }
    // Say so rather than look as if nothing happened.
    if let Some(other) = mailto_default().filter(|id| id != DESKTOP_ID) {
        return Err(format!("Email links still open {} after setting Mailroom as the mail app.", other.trim_end_matches(".desktop")));
    }
    let path = bindings_file();
    let text = fs::read_to_string(&path)
        .map_err(|_| format!("Omarchy's key bindings file is missing ({}).", tilde(&path)))?;
    write_keeping_mode(&path, &with_bindings(&text, &exe))?;
    reload_hyprland();
    // If Hyprland now reports an error in the bindings file, put it back as
    // it was rather than leave the desktop config broken.
    if let Some(problem) = bindings_error() {
        let _ = write_keeping_mode(&path, &text);
        reload_hyprland();
        return Err(format!("Hyprland did not accept the key bindings, so they were taken back out: {problem}"));
    }
    Ok(mail_app_status())
}

/// Hand mail back: drop the bindings and the mailto default. The desktop
/// entry stays, as the launcher still uses it.
pub fn stop_mail_app() -> Result<MailAppStatus, String> {
    if !detected() {
        return Err("This is not Omarchy.".into());
    }
    let path = bindings_file();
    if let Ok(text) = fs::read_to_string(&path) {
        let cleaned = without_bindings(&text);
        if cleaned != text {
            write_keeping_mode(&path, &cleaned)?;
            reload_hyprland();
        }
    }
    let mimeapps = config_home().join("mimeapps.list");
    if let Ok(text) = fs::read_to_string(&mimeapps) {
        let cleaned = without_mailto_default(&text);
        if cleaned != text {
            write_keeping_mode(&mimeapps, &cleaned)?;
        }
    }
    Ok(mail_app_status())
}

fn bindings_file() -> PathBuf {
    config_home().join("hypr").join("bindings.lua")
}

fn reload_hyprland() {
    let _ = Command::new("hyprctl").arg("reload").output();
}

/// Hyprland's config error, if one names the bindings file.
fn bindings_error() -> Option<String> {
    let out = Command::new("hyprctl").arg("configerrors").output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .map(str::trim)
        .find(|line| line.contains("bindings.lua"))
        .map(|line| line.chars().take(240).collect())
}

fn tilde(path: &Path) -> String {
    let home = home();
    match path.strip_prefix(&home) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

/// A Lua string literal holding a shell word for the binary.
fn lua_launch(exe: &str, extra: &str) -> String {
    let shell = format!("'{}'", exe.replace('\'', "'\\''"));
    let command = if extra.is_empty() { shell } else { format!("{shell} {extra}") };
    format!("\"{}\"", command.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The user's bindings with Mailroom's block at the end, replacing any
/// earlier one.
fn with_bindings(text: &str, exe: &str) -> String {
    let mut out = without_bindings(text);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    if !out.is_empty() && !out.ends_with("\n\n") {
        out.push('\n');
    }
    out.push_str(BINDINGS_START);
    out.push('\n');
    // Omarchy has no o.rebind; its documented way is unbind, then bind
    // (Omarchy 4.0.6, 2026-10-25).
    out.push_str("hl.unbind(\"SUPER + SHIFT + E\")\n");
    out.push_str(&format!(
        "o.bind(\"SUPER + SHIFT + E\", \"Email\", {{ launch = {} }})\n",
        lua_launch(exe, "")
    ));
    out.push_str("hl.unbind(\"SUPER + SHIFT + ALT + E\")\n");
    out.push_str(&format!(
        "o.bind(\"SUPER + SHIFT + ALT + E\", \"New email\", {{ launch = {} }})\n",
        lua_launch(exe, "--compose")
    ));
    out.push_str(BINDINGS_END);
    out.push('\n');
    out
}

fn without_bindings(text: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    let mut removed = false;
    for line in text.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\n', '\r']);
        let begins = bare.trim_start();
        if !inside && (begins.starts_with("-- Mailroom: begin") || begins.starts_with(OLD_BINDINGS_BEGIN)) {
            inside = true;
            removed = true;
            continue;
        }
        if inside {
            if bare.trim() == BINDINGS_END || bare.trim() == OLD_BINDINGS_END {
                inside = false;
            }
            continue;
        }
        out.push_str(line);
    }
    // The blank line that separated the block goes with it.
    while removed && out.ends_with("\n\n") {
        out.pop();
    }
    out
}

/// mimeapps.list without Mailroom as the mailto default.
fn without_mailto_default(text: &str) -> String {
    let mut out = String::new();
    let mut section = String::new();
    for line in text.split_inclusive('\n') {
        let bare = line.trim();
        if bare.starts_with('[') {
            section = bare.to_string();
        }
        let ours = section == "[Default Applications]"
            && bare
                .split_once('=')
                .map(|(key, value)| key.trim() == "x-scheme-handler/mailto" && value.split(';').any(|id| id.trim() == DESKTOP_ID))
                .unwrap_or(false);
        if !ours {
            out.push_str(line);
        }
    }
    out
}

/// Desktop Entry Exec quoting: the path in double quotes with `"`, `` ` ``,
/// `$` and `\` escaped, and `%` doubled. A plain path is left bare:
/// xdg-mime takes a quoted Exec's quotes as part of the program name, finds
/// no such program and skips the entry, so the mailto default never showed
/// as Mailroom (2026-10-25).
fn exec_quote(path: &str) -> String {
    if !path.is_empty() && path.chars().all(|ch| ch.is_ascii_alphanumeric() || "/._-+".contains(ch)) {
        return path.to_string();
    }
    let mut out = String::from("\"");
    for ch in path.chars() {
        match ch {
            '"' | '`' | '$' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            '%' => out.push_str("%%"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn desktop_entry(exe: &str) -> String {
    let exec = exec_quote(exe);
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Mailroom\n\
         GenericName=Mail\n\
         Comment=Unified mail and calendar for Microsoft 365, Outlook.com and Gmail\n\
         Exec={exec} %u\n\
         Icon=io.github.jonspinks.mailroom\n\
         Terminal=false\n\
         Categories=Network;Email;Office;\n\
         MimeType=x-scheme-handler/mailto;\n\
         StartupWMClass=mailroom\n\
         Actions=compose;\n\
         X-Mailroom-Managed=true\n\
         \n\
         [Desktop Action compose]\n\
         Name=New message\n\
         Exec={exec} --compose\n"
    )
}

/// The launcher entry and its icon. An entry of the same name that someone
/// wrote by hand is kept beside it as `.bak`.
fn install_desktop_entry(exe: &str) -> Result<(), String> {
    let apps = data_home().join("applications");
    fs::create_dir_all(&apps).map_err(|err| err.to_string())?;
    let path = apps.join(DESKTOP_ID);
    if let Ok(old) = fs::read_to_string(&path) {
        if !old.contains("X-Mailroom-Managed=true") {
            let _ = fs::write(apps.join(format!("{DESKTOP_ID}.bak")), old);
        }
    }
    fs::write(&path, desktop_entry(exe)).map_err(|err| err.to_string())?;
    let icons = data_home().join("icons").join("hicolor");
    let svg = icons.join("scalable").join("apps");
    let png = icons.join("128x128").join("apps");
    fs::create_dir_all(&svg).map_err(|err| err.to_string())?;
    fs::create_dir_all(&png).map_err(|err| err.to_string())?;
    fs::write(svg.join(format!("{APP_ID}.svg")), include_bytes!("../icons/icon.svg")).map_err(|err| err.to_string())?;
    fs::write(png.join(format!("{APP_ID}.png")), include_bytes!("../icons/128x128.png")).map_err(|err| err.to_string())?;
    let _ = Command::new("update-desktop-database").arg(&apps).output();
    Ok(())
}

/// Replace a file's contents, keeping its permissions. A symlinked dotfile
/// is written where it points, so the link stays. Each write has its own
/// temporary file, so two at once cannot swap in a half-written one.
fn write_keeping_mode(path: &Path, text: &str) -> Result<(), String> {
    static WRITES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let path = &fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let n = WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("mailroom-{}-{n}.tmp", std::process::id()));
    // Made new (O_CREAT|O_EXCL): never through a link or over a file someone
    // left there.
    let written = (|| -> std::io::Result<()> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        if let Ok(meta) = fs::metadata(path) {
            file.set_permissions(meta.permissions())?;
        }
        Ok(())
    })();
    if let Err(err) = written {
        let _ = fs::remove_file(&tmp);
        return Err(err.to_string());
    }
    fs::rename(&tmp, path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        err.to_string()
    })
}


// ---- The unread count in the Omarchy bar --------------------------------

fn plugin_dir() -> PathBuf {
    config_home().join("omarchy").join("plugins").join(PLUGIN_ID)
}

fn bar_state_file() -> PathBuf {
    state_home().join("mailroom").join("bar.json")
}

const PLUGIN_MANIFEST: &str = include_str!("../../omarchy/plugin/manifest.json");
const PLUGIN_WIDGET: &str = include_str!("../../omarchy/plugin/BarWidget.qml");

/// The folder, inside the plugin, that holds this build's BarWidget.qml. The
/// running shell keeps whatever it once loaded from a path, a failed load
/// included, until it restarts: its reload asks for Qt.clearComponentCache(),
/// which QML does not have (2026-10-25). So each version of the widget gets a
/// path of its own. The file keeps its name; the shell refuses others.
fn widget_folder() -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    PLUGIN_WIDGET.hash(&mut hasher);
    format!("w{:016x}", hasher.finish())
}

/// The plugin's manifest, pointing at this build's widget.
fn plugin_manifest() -> Result<String, String> {
    let mut manifest: serde_json::Value = serde_json::from_str(PLUGIN_MANIFEST).map_err(|err| err.to_string())?;
    manifest["entryPoints"]["barWidget"] = serde_json::json!(format!("{}/BarWidget.qml", widget_folder()));
    serde_json::to_string_pretty(&manifest).map_err(|err| err.to_string())
}

/// Write the bar plugin into Omarchy's plugins folder and turn it on.
pub fn add_bar_widget() -> Result<MailAppStatus, String> {
    if !detected() {
        return Err("This is not Omarchy.".into());
    }
    let dir = plugin_dir();
    let folder = widget_folder();
    fs::create_dir_all(dir.join(&folder)).map_err(|err| err.to_string())?;
    fs::write(dir.join(&folder).join("BarWidget.qml"), PLUGIN_WIDGET).map_err(|err| err.to_string())?;
    fs::write(dir.join("manifest.json"), plugin_manifest()?).map_err(|err| err.to_string())?;
    // Widgets an earlier Mailroom wrote, including the BarWidget.qml that
    // once sat beside the manifest.
    for entry in fs::read_dir(&dir).map_err(|err| err.to_string())?.flatten() {
        let name = entry.file_name();
        if name == "manifest.json" || name == folder.as_str() {
            continue;
        }
        let path = entry.path();
        let _ = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
    }
    write_bar_state(None)?;
    // The same checks and rescan `omarchy plugin add` does before enabling.
    if let Ok(out) = Command::new("omarchy-plugin-validate").arg(&dir).output() {
        if !out.status.success() {
            let why = String::from_utf8_lossy(&out.stderr).trim().chars().take(240).collect::<String>();
            return Err(if why.is_empty() { "Omarchy did not accept the bar widget.".into() } else { why });
        }
    }
    // The shell rescans in the background, so the first enable can find the
    // plugin not known yet (2026-10-25). Rescan and try again for a few
    // seconds.
    let mut out;
    let mut tries = 0;
    loop {
        let _ = Command::new("omarchy-shell").args(["shell", "rescanPlugins"]).output();
        out = Command::new("omarchy-plugin-enable")
            .args([PLUGIN_ID, "--section", "right"])
            .output()
            .map_err(|_| "omarchy-plugin-enable is not installed.".to_string())?;
        tries += 1;
        let unknown = String::from_utf8_lossy(&out.stderr).contains("is not known");
        if out.status.success() || !unknown || tries >= 12 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
    }
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr).trim().chars().take(240).collect::<String>();
        return Err(if why.is_empty() { "Omarchy would not turn the bar widget on.".into() } else { why });
    }
    Ok(mail_app_status())
}

/// Turn the bar plugin off and take its files away.
pub fn remove_bar_widget() -> Result<MailAppStatus, String> {
    if !detected() {
        return Err("This is not Omarchy.".into());
    }
    let _ = Command::new("omarchy-plugin-disable").arg(PLUGIN_ID).output();
    let dir = plugin_dir();
    if dir.join("manifest.json").is_file() {
        fs::remove_dir_all(&dir).map_err(|err| err.to_string())?;
    }
    Ok(mail_app_status())
}

/// The unread count the bar widget shows. Only written on Omarchy.
pub fn report_unread(count: u32) -> Result<(), String> {
    if !detected() {
        return Ok(());
    }
    write_bar_state(Some(count))
}

fn write_bar_state(count: Option<u32>) -> Result<(), String> {
    let path = bar_state_file();
    let previous = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get("unread").and_then(|n| n.as_u64()))
        .unwrap_or(0) as u32;
    let state = serde_json::json!({
        "unread": count.unwrap_or(previous),
        "app": exe_path()?,
    });
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    }
    write_keeping_mode(&path, &state.to_string())
}

// ---- Moving the old name's desktop setup ----------------------------------

/// Up to 0.35 this app was Nowtlook, and up to 0.36 Mailroom had another
/// id. Where an old version made itself the mail app, put this one in its
/// place: the launcher entry and icon, the mailto default, the key bindings
/// block and the bar widget. Only what the old app marked as its own is
/// touched, and only once.
pub fn migrate_from_nowtlook() {
    if !detected() {
        return;
    }
    let Ok(exe) = exe_path() else { return };
    let apps = data_home().join("applications");
    for (old_id, old_plugin_id, old_managed) in OLD_SETUPS {
        let old_desktop = format!("{old_id}.desktop");
        let old_entry = apps.join(&old_desktop);
        let was_ours = fs::read_to_string(&old_entry).map(|text| text.contains(old_managed)).unwrap_or(false);
        if was_ours && install_desktop_entry(&exe).is_ok() {
            if mailto_default().as_deref() == Some(old_desktop.as_str()) {
                let _ = Command::new("xdg-mime").args(["default", DESKTOP_ID, "x-scheme-handler/mailto"]).status();
            }
            let _ = fs::remove_file(&old_entry);
            let _ = fs::remove_file(apps.join(format!("{old_desktop}.bak")));
            let icons = data_home().join("icons").join("hicolor");
            let _ = fs::remove_file(icons.join("scalable").join("apps").join(format!("{old_id}.svg")));
            let _ = fs::remove_file(icons.join("128x128").join("apps").join(format!("{old_id}.png")));
            let _ = Command::new("update-desktop-database").arg(&apps).output();
        }
        let old_plugin = config_home().join("omarchy").join("plugins").join(old_plugin_id);
        if old_plugin.join("manifest.json").is_file() && add_bar_widget().is_ok() {
            let _ = Command::new("omarchy-plugin-disable").arg(old_plugin_id).output();
            let _ = fs::remove_dir_all(&old_plugin);
        }
    }
    let path = bindings_file();
    if let Ok(text) = fs::read_to_string(&path) {
        let old_block = text.lines().any(|line| line.trim_start().starts_with(OLD_BINDINGS_BEGIN));
        if old_block && write_keeping_mode(&path, &with_bindings(&text, &exe)).is_ok() {
            reload_hyprland();
            if bindings_error().is_some() {
                let _ = write_keeping_mode(&path, &text);
                reload_hyprland();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_old_bindings_block_is_replaced_not_doubled() {
        let old = "o.bind(\"SUPER + A\", \"A\", { launch = \"a\" })\n\n-- Nowtlook: begin (added by Nowtlook > Settings > Omarchy; remove this block to undo)\nhl.unbind(\"SUPER + SHIFT + E\")\no.bind(\"SUPER + SHIFT + E\", \"Email\", { launch = \"'/opt/nowtlook'\" })\n-- Nowtlook: end\n";
        let new = with_bindings(old, "/opt/mailroom");
        assert!(!new.contains("Nowtlook"), "{new}");
        assert!(new.contains("'/opt/mailroom'"));
        assert_eq!(new.matches(BINDINGS_START).count(), 1);
        assert!(new.starts_with("o.bind(\"SUPER + A\""));
        assert_eq!(without_bindings(old), "o.bind(\"SUPER + A\", \"A\", { launch = \"a\" })\n");
    }

    #[test]
    fn manifest_points_at_this_builds_widget() {
        let manifest: serde_json::Value = serde_json::from_str(&plugin_manifest().unwrap()).unwrap();
        let entry = manifest["entryPoints"]["barWidget"].as_str().unwrap();
        assert_eq!(entry, format!("{}/BarWidget.qml", widget_folder()));
        assert_eq!(widget_folder(), widget_folder(), "the same widget keeps its folder");
        assert_eq!(manifest["id"], PLUGIN_ID);
    }

    #[test]
    fn resolved_palette_keeps_only_hex_colours() {
        let (mode, colors) = parse_resolved("accent\t#7AA2F7\nbackground\t#1a1b26\nforeground\t#a9b1d6\nmode\tdark\nred\trgb(1,2,3)\nshell_gradient\t#ffffff\n");
        assert_eq!(mode, "dark");
        assert_eq!(colors.get("accent").map(String::as_str), Some("#7aa2f7"));
        assert_eq!(colors.get("background").map(String::as_str), Some("#1a1b26"));
        assert!(!colors.contains_key("red"), "not a hex colour");
        assert!(!colors.contains_key("shell_gradient"), "not a palette key");
    }

    #[test]
    fn colors_toml_reads_quotes_comments_and_0x() {
        let (mode, mut colors) = parse_colors_toml(
            "mode = \"light\"\n# a comment\naccent = \"#BE3F50\" # trailing\nbackground = '0xfafafa'\nforeground = #333333\n[colors.extra]\nmuted = \"not a colour\"\n",
        );
        assert_eq!(mode, "light");
        assert_eq!(colors.get("accent").map(String::as_str), Some("#be3f50"));
        assert_eq!(colors.get("background").map(String::as_str), Some("#fafafa"));
        assert_eq!(colors.get("foreground").map(String::as_str), Some("#333333"));
        assert!(!colors.contains_key("muted"));
        fill_gaps(&mut colors);
        assert_eq!(colors.get("lighter_background").map(String::as_str), Some("#fafafa"));
        assert_eq!(colors.get("muted").map(String::as_str), Some("#333333"));
    }

    #[test]
    fn mode_comes_from_the_background_when_unsaid() {
        let mut colors = BTreeMap::new();
        colors.insert("background".to_string(), "#fafafa".to_string());
        assert_eq!(mode_from(&colors), "light");
        colors.insert("background".to_string(), "#1a1b26".to_string());
        assert_eq!(mode_from(&colors), "dark");
    }

    #[test]
    fn theme_names_read_like_names() {
        assert_eq!(pretty_theme("tokyo-night\n"), "Tokyo Night");
        assert_eq!(pretty_theme("catppuccin-latte"), "Catppuccin Latte");
        assert_eq!(pretty_theme("Matte Black"), "Matte Black");
        assert_eq!(pretty_theme(""), "Omarchy");
    }

    #[test]
    fn font_family_is_safe_for_css() {
        assert_eq!(clean_family("JetBrainsMono Nerd Font,JetBrainsMono NF\n"), "JetBrainsMono Nerd Font");
        assert_eq!(clean_family("Evil\"; } body { x: \"y"), "");
        assert_eq!(clean_family(""), "");
    }

    #[test]
    fn bindings_block_is_added_once_and_removed_cleanly() {
        let original = "-- my bindings\no.bind(\"SUPER + SHIFT + R\", \"SSH\", \"alacritty -e ssh box\")\n";
        let once = with_bindings(original, "/home/user/.local/opt/mailroom/src-tauri/target/release/mailroom");
        assert!(once.starts_with(original));
        assert!(once.contains("hl.unbind(\"SUPER + SHIFT + E\")\no.bind(\"SUPER + SHIFT + E\", \"Email\", { launch = \"'/home/user/.local/opt/mailroom/src-tauri/target/release/mailroom'\" })"));
        assert!(once.contains("hl.unbind(\"SUPER + SHIFT + ALT + E\")\no.bind(\"SUPER + SHIFT + ALT + E\""));
        assert!(!once.contains("rebind"));
        assert!(once.contains("--compose\" })"));
        let twice = with_bindings(&once, "/opt/mailroom");
        assert_eq!(twice.matches(BINDINGS_START).count(), 1);
        assert!(twice.contains("'/opt/mailroom'"));
        assert_eq!(without_bindings(&twice), original);
    }

    #[test]
    fn odd_paths_stay_one_shell_word_in_lua() {
        assert_eq!(lua_launch("/a b/it's", ""), "\"'/a b/it'\\\\''s'\"");
        assert_eq!(lua_launch("/x\"y", "--compose"), "\"'/x\\\"y' --compose\"");
    }

    #[test]
    fn mailto_default_is_removed_only_when_it_is_mailroom() {
        let text = "[Default Applications]\nx-scheme-handler/mailto=io.github.jonspinks.mailroom.desktop\ntext/html=chromium.desktop\n[Added Associations]\nx-scheme-handler/mailto=io.github.jonspinks.mailroom.desktop;\n";
        let cleaned = without_mailto_default(text);
        assert_eq!(cleaned, "[Default Applications]\ntext/html=chromium.desktop\n[Added Associations]\nx-scheme-handler/mailto=io.github.jonspinks.mailroom.desktop;\n");
        let other = "[Default Applications]\nx-scheme-handler/mailto=thunderbird.desktop\n";
        assert_eq!(without_mailto_default(other), other);
    }

    #[test]
    fn desktop_entry_quotes_the_path_only_when_needed() {
        assert_eq!(exec_quote("/opt/now tlook/$x%"), "\"/opt/now tlook/\\$x%%\"");
        assert_eq!(exec_quote("/home/user/.local/opt/mailroom/src-tauri/target/release/mailroom"), "/home/user/.local/opt/mailroom/src-tauri/target/release/mailroom");
        let entry = desktop_entry("/opt/mailroom");
        assert!(entry.contains("Exec=/opt/mailroom %u\n"));
        assert!(entry.contains("Exec=/opt/mailroom --compose\n"));
        assert!(desktop_entry("/opt/now tlook").contains("Exec=\"/opt/now tlook\" %u\n"));
        assert!(entry.contains("MimeType=x-scheme-handler/mailto;"));
    }

    #[test]
    fn the_look_reaches_the_page_as_data() {
        let look = Look {
            theme: "A</script>".into(),
            mode: "dark".into(),
            colors: BTreeMap::new(),
            font: String::new(),
            rounding: 0,
        };
        let script = look_script(&look);
        assert!(script.starts_with("window.applyOmarchyLook && window.applyOmarchyLook({"));
        assert!(script.contains("\"theme\":\"A</script>\""));
    }
}
