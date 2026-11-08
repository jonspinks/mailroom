//! Every command the page can call must be registered, listed in build.rs's
//! app manifest, and allowed in the window's capability. A command missing
//! from either list is refused at run time, which the e2e fake backend never
//! sees (2026-10-29: remote_image shipped in 0.35.4 and was always denied).

use std::collections::BTreeSet;

fn read(path: &str) -> String {
    std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/").to_string() + path).unwrap()
}

fn between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
    let from = text.find(start).unwrap_or_else(|| panic!("no {start}")) + start.len();
    &text[from..from + text[from..].find(end).unwrap()]
}

fn quoted(text: &str) -> BTreeSet<String> {
    text.split('"').skip(1).step_by(2).map(str::to_string).collect()
}

#[test]
fn every_command_is_in_the_manifest_and_allowed() {
    let lib = read("src/lib.rs");
    let registered: BTreeSet<String> = between(&lib, "generate_handler![", "]")
        .split(',')
        .map(|name| name.trim().rsplit("::").next().unwrap().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    let manifest = quoted(between(&read("build.rs"), ".commands(&[", "])"));
    let allowed: BTreeSet<String> = quoted(between(&read("capabilities/default.json"), "\"permissions\"", "]"))
        .into_iter()
        .filter_map(|p| p.strip_prefix("allow-").map(|name| name.replace('-', "_")))
        .collect();
    let page = read("../app.js");
    let called: BTreeSet<String> = page
        .split("tauriInvoke(\"")
        .skip(1)
        .map(|rest| rest[..rest.find('"').unwrap()].to_string())
        .filter(|name| !name.starts_with("plugin:")) // core:default covers these
        .collect();

    assert!(registered.contains("remote_image"), "the handler list didn't parse");
    let missing = |set: &BTreeSet<String>| registered.difference(set).cloned().collect::<Vec<_>>();
    assert_eq!(missing(&manifest), Vec::<String>::new(), "registered but not in build.rs's manifest");
    assert_eq!(missing(&allowed), Vec::<String>::new(), "registered but not allowed in capabilities/default.json");
    let unknown: Vec<_> = called.difference(&registered).cloned().collect();
    assert_eq!(unknown, Vec::<String>::new(), "app.js calls commands that aren't registered");
}
