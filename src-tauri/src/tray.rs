//! The tray icon, and keeping Mailroom running when its window is closed,
//! so new-mail checks, notifications, reminders and snooze carry on.
//!
//! The tray speaks StatusNotifierItem directly (ksni), so a left click opens
//! Mailroom and a right click shows the menu. libappindicator, which Tauri's
//! own tray uses on Linux, only ever shows the menu.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

/// Set once the tray icon exists. Without one, closing the window quits,
/// so Mailroom can never be left running with no way back to it.
pub static READY: AtomicBool = AtomicBool::new(false);

pub fn ready() -> bool {
    READY.load(Ordering::SeqCst)
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// RGBA pixels to the ARGB32 (network order) a tray icon takes.
pub fn argb(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4).flat_map(|p| [p[3], p[0], p[1], p[2]]).collect()
}

struct MailTray {
    app: AppHandle,
    icon: Vec<ksni::Icon>,
}

impl ksni::Tray for MailTray {
    fn id(&self) -> String {
        "mailroom".into()
    }

    fn title(&self) -> String {
        "Mailroom".into()
    }

    fn icon_name(&self) -> String {
        crate::omarchy::APP_ID.into()
    }

    fn icon_pixmap(&self) -> Vec<ksni::Icon> {
        self.icon.clone()
    }

    fn tool_tip(&self) -> ksni::ToolTip {
        ksni::ToolTip { title: "Mailroom".into(), ..Default::default() }
    }

    /// A left click opens Mailroom.
    fn activate(&mut self, _x: i32, _y: i32) {
        show_main(&self.app);
    }

    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        use ksni::menu::StandardItem;
        vec![
            StandardItem { label: "Open Mailroom".into(), activate: Box::new(|t: &mut Self| show_main(&t.app)), ..Default::default() }.into(),
            StandardItem {
                label: "Check for new mail".into(),
                activate: Box::new(|t: &mut Self| {
                    if let Some(window) = t.app.get_webview_window("main") {
                        let _ = window.eval("window.checkMailNow && window.checkMailNow();");
                    }
                }),
                ..Default::default()
            }
            .into(),
            ksni::MenuItem::Separator,
            StandardItem { label: "Quit Mailroom".into(), activate: Box::new(|t: &mut Self| t.app.exit(0)), ..Default::default() }.into(),
        ]
    }
}

pub fn install(app: &AppHandle) -> Result<(), String> {
    use ksni::blocking::TrayMethods;
    let icon = app
        .default_window_icon()
        .map(|image| vec![ksni::Icon { width: image.width() as i32, height: image.height() as i32, data: argb(image.rgba()) }])
        .unwrap_or_default();
    let tray = MailTray { app: app.clone(), icon };
    // Fails when nothing on the desktop shows tray icons; then closing quits.
    let handle = tray.spawn().map_err(|err| err.to_string())?;
    std::mem::forget(handle);
    READY.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn pixels_become_argb() {
        assert_eq!(super::argb(&[1, 2, 3, 4, 5, 6, 7, 8]), vec![4, 1, 2, 3, 8, 5, 6, 7]);
    }
}
