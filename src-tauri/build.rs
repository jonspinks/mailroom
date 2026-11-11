/// The page is index.html, styles.css and app.js at the repository root.
/// Copy them into dist/ on every build, so a build never ships a stale page.
fn copy_page() {
    let root = std::path::Path::new("..");
    let dist = root.join("dist");
    std::fs::create_dir_all(&dist).expect("make dist/");
    for name in ["index.html", "styles.css", "app.js"] {
        let from = root.join(name);
        println!("cargo:rerun-if-changed=../{name}");
        std::fs::copy(&from, dist.join(name)).unwrap_or_else(|err| panic!("copy {name} into dist/: {err}"));
    }
    // pdf.js for the attachment viewer (vendor/pdfjs, Apache-2.0), with the
    // JavaScript builds of its JBIG2/CCITT and JPEG 2000 decoders (BSD), which
    // scanned PDFs need. The CSP allows no WebAssembly, so pdf.js uses these.
    let vendor = root.join("vendor/pdfjs");
    let out = dist.join("vendor/pdfjs");
    std::fs::create_dir_all(&out).expect("make dist/vendor/pdfjs");
    for name in [
        "pdf.min.mjs",
        "pdf.worker.min.mjs",
        "LICENSE",
        "jbig2_nowasm_fallback.js",
        "openjpeg_nowasm_fallback.js",
        "LICENSE_JBIG2",
        "LICENSE_OPENJPEG",
        "LICENSE_PDFJS_JBIG2",
        "LICENSE_PDFJS_OPENJPEG",
    ] {
        let from = vendor.join(name);
        println!("cargo:rerun-if-changed={}", from.display());
        std::fs::copy(&from, out.join(name)).unwrap_or_else(|err| panic!("copy vendor/pdfjs/{name}: {err}"));
    }
}

fn main() {
    copy_page();
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "account_status",
            "client_id",
            "save_client_id",
            "sign_in",
            "sign_out",
            "sync_inbox",
            "backfill_mail",
            "cached_folder",
            "cached_body",
            "sync_folder",
            "search_mail",
            "search_cached",
            "conversation_mail",
            "spelling",
            "pdf_texts",
            "inline_images",
            "remote_image",
            "save_picture",
            "copy_picture",
            "sender_verified",
            "attachment_preview",
            "free_busy",
            "set_focus",
            "check_spelling",
            "unsubscribe_options",
            "unsubscribe",
            "set_spelling",
            "message_files",
            "open_attachment",
            "open_link",
            "print_page",
            "pick_download_folder",
            "save_attachments",
            "send_mail",
            "apply_mail",
            "pop_compose",
            "saved_inbox",
            "sync_calendar",
            "sync_contacts",
            "create_contact",
            "ai_status",
            "save_ai_key",
            "clear_ai_key",
            "ask_mail",
            "draft_mail",
            "pop_assist",
            "assist_mail",
            "finish_quit",
            "save_draft",
            "discard_draft",
            "message_invite",
            "respond_invite",
            "notify_mail",
            "stage_file",
            "save_event",
            "remove_event",
            "event_series",
            "end_series_before",
            "update_contact",
            "delete_contact",
            "mark_folder_read",
            "empty_folder",
            "mail_categories",
            "set_categories",
            "mail_aliases",
            "list_search_folders",
            "save_search_folder",
            "delete_search_folder",
            "mailbox_zone",
            "set_mailbox_zone",
            "forget_mail",
            "auto_reply",
            "set_auto_reply",
            "ensure_folder",
            "people",
            "mail_rules",
            "save_rule",
            "delete_rule",
            "check_update",
            "whats_new",
            "run_update",
            "update_progress",
            "update_log",
            "restart_app",
            "google_client_id",
            "save_google_client",
            "omarchy_look",
            "mail_app_status",
            "make_mail_app",
            "stop_mail_app",
            "add_bar_widget",
            "remove_bar_widget",
            "report_unread",
            "take_launch_request",
        ]),
    );
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
