//! "Link…" on the right-click menu in text you are writing. The menu is
//! WebKitGTK's own, so the spelling suggestions stay; this appends one item
//! that hands over to the page's link dialog (`window.mailroomLinkFromMenu`
//! in app.js), which works on the word the right-click selected.

use tauri::{Runtime, WebviewWindow};

#[cfg(target_os = "linux")]
const RUN: &str = "window.mailroomLinkFromMenu && window.mailroomLinkFromMenu()";

/// Call once per window, when it is built: each call connects the signal again.
pub fn attach<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(target_os = "linux")]
    {
        let page = window.clone();
        let _ = window.with_webview(move |view| {
            use gtk::gio;
            use webkit2gtk::{ContextMenuExt, ContextMenuItem, HitTestResultContext, HitTestResultExt, WebViewExt};
            view.inner().connect_context_menu(move |_, menu, _, hit| {
                let context = hit.context();
                if context & HitTestResultContext::EDITABLE.bits() == 0 {
                    return false;
                }
                let on_link = context & HitTestResultContext::LINK.bits() != 0;
                let action = gio::SimpleAction::new("mailroom-link", None);
                let page = page.clone();
                action.connect_activate(move |_, _| {
                    let _ = page.eval(RUN);
                });
                menu.append(&ContextMenuItem::new_separator());
                menu.append(&ContextMenuItem::from_gaction(&action, if on_link { "Edit link…" } else { "Link…" }, None));
                false
            });
        });
    }
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}
