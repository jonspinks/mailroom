//! Desktop notifications for new mail. Clicking one brings Mailroom forward
//! and opens the message.

use tauri::{AppHandle, Manager};

/// Notification servers such as mako read a little markup in the body, so
/// mail text is escaped before it is shown.
pub fn plain(text: &str, max: usize) -> String {
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut clipped: String = flat.chars().take(max).collect();
    if flat.chars().count() > max {
        clipped.push('…');
    }
    clipped.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The page function a click calls, with the message id as a JSON string.
pub fn open_script(message_id: &str) -> String {
    let id = serde_json::to_string(message_id).unwrap_or_else(|_| "\"\"".into());
    format!("window.openFromNotification && window.openFromNotification({id});")
}

/// The Mailroom logo, kept on disk so the notification server can show it.
const LOGO: &[u8] = include_bytes!("../icons/128x128.png");

fn logo_path() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let dir = std::path::PathBuf::from(home).join(".cache").join("mailroom");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("logo-128.png");
    let current = std::fs::read(&path).map(|bytes| bytes == LOGO).unwrap_or(false);
    if !current {
        std::fs::write(&path, LOGO).ok()?;
    }
    Some(path.to_string_lossy().into_owned())
}

pub fn new_mail(app: AppHandle, title: &str, body: &str, message_id: &str) -> Result<(), String> {
    let icon = logo_path().unwrap_or_else(|| crate::omarchy::APP_ID.into());
    let handle = notify_rust::Notification::new()
        .appname("Mailroom")
        .summary(&plain(title, 80))
        .body(&plain(body, 160))
        .icon(&icon)
        .hint(notify_rust::Hint::DesktopEntry(crate::omarchy::APP_ID.into()))
        .hint(notify_rust::Hint::Category("email.arrived".into()))
        .action("default", "Open")
        .show()
        .map_err(|_| "Notifications are not available on this desktop.".to_string())?;
    let message_id = message_id.to_string();
    std::thread::spawn(move || {
        handle.wait_for_action(|action| {
            if action != "default" {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                if !message_id.is_empty() {
                    let _ = window.eval(open_script(&message_id));
                }
            }
        });
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mail_text_cannot_mark_up_the_notification() {
        assert_eq!(plain("<b>Win</b> & more", 80), "&lt;b&gt;Win&lt;/b&gt; &amp; more");
        assert_eq!(plain("one\n\n two", 80), "one two");
        assert_eq!(plain("abcdef", 3), "abc…");
    }

    #[test]
    fn a_click_passes_the_id_as_data() {
        assert_eq!(open_script("AAMk\"); evil(\""), "window.openFromNotification && window.openFromNotification(\"AAMk\\\"); evil(\\\"\");");
    }
}
