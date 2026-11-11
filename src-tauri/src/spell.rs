//! Spell check in every Mailroom window. WebKitGTK has a checker (through
//! enchant) but it is off until the app turns it on and names languages.

use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

static CHOICE: Mutex<Option<(bool, Vec<String>)>> = Mutex::new(None);

const DICT_DIRS: [&str; 3] = ["/usr/share/hunspell", "/usr/share/myspell/dicts", "/usr/share/myspell"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spelling {
    pub enabled: bool,
    pub languages: Vec<String>,
    pub installed: Vec<String>,
}

fn language_code(name: &str) -> bool {
    let (lang, region) = name.split_once('_').unwrap_or((name, ""));
    (2..=3).contains(&lang.len())
        && lang.bytes().all(|b| b.is_ascii_lowercase())
        && (region.is_empty() || (region.len() == 2 && region.bytes().all(|b| b.is_ascii_uppercase())))
}

/// Dictionaries in these folders: a name.dic with its name.aff.
pub fn installed_in(dirs: &[&Path]) -> Vec<String> {
    let mut out = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("dic") {
                continue;
            }
            let Some(name) = path.file_stem().and_then(|s| s.to_str()) else { continue };
            if language_code(name) && path.with_extension("aff").exists() {
                out.push(name.to_string());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

pub fn installed() -> Vec<String> {
    let mut dirs: Vec<std::path::PathBuf> = DICT_DIRS.iter().map(std::path::PathBuf::from).collect();
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(Path::new(&home).join(".local/share/hunspell"));
        dirs.push(Path::new(&home).join(".config/enchant/hunspell"));
    }
    let refs: Vec<&Path> = dirs.iter().map(|d| d.as_path()).collect();
    installed_in(&refs)
}

/// The locale's language when its dictionary is here, else the nearest.
pub fn default_for(locale: &str, have: &[String]) -> Vec<String> {
    let code = locale.split(['.', '@']).next().unwrap_or("").to_string();
    if have.contains(&code) {
        return vec![code];
    }
    let lang = code.split('_').next().unwrap_or("");
    if let Some(near) = have.iter().find(|name| !lang.is_empty() && name.split('_').next() == Some(lang)) {
        return vec![near.clone()];
    }
    have.first().cloned().into_iter().collect()
}

fn current() -> (bool, Vec<String>) {
    let mut choice = CHOICE.lock().unwrap_or_else(|e| e.into_inner());
    choice
        .get_or_insert_with(|| {
            let locale = std::env::var("LC_ALL").ok().filter(|v| !v.is_empty()).or_else(|| std::env::var("LANG").ok()).unwrap_or_default();
            (true, default_for(&locale, &installed()))
        })
        .clone()
}

pub fn status() -> Spelling {
    let (enabled, languages) = current();
    Spelling { enabled, languages, installed: installed() }
}

pub fn apply<R: Runtime>(window: &WebviewWindow<R>) {
    let (enabled, languages) = current();
    let _ = window.with_webview(move |view| {
        #[cfg(target_os = "linux")]
        {
            use webkit2gtk::{WebContextExt, WebViewExt};
            if let Some(context) = view.inner().context() {
                let names: Vec<&str> = languages.iter().map(String::as_str).collect();
                context.set_spell_checking_languages(&names);
                context.set_spell_checking_enabled(enabled && !names.is_empty());
            }
        }
        #[cfg(not(target_os = "linux"))]
        let _ = (view, enabled, languages);
    });
}

/// Choose languages from those installed; an empty choice keeps the default.
pub fn set<R: Runtime>(app: &AppHandle<R>, enabled: bool, languages: Vec<String>) -> Spelling {
    let have = installed();
    let mut chosen: Vec<String> = languages.into_iter().filter(|name| have.contains(name)).take(4).collect();
    chosen.dedup();
    if chosen.is_empty() {
        chosen = current().1;
    }
    *CHOICE.lock().unwrap_or_else(|e| e.into_inner()) = Some((enabled, chosen));
    for window in app.webview_windows().values() {
        apply(window);
    }
    status()
}

// ---- Checking before Send: WebKit does not tell the page which words it
// underlined, so the same dictionaries are read here. ----

type Loaded = std::collections::HashMap<String, std::sync::Arc<spellbook::Dictionary>>;
static LOADED: Mutex<Option<Loaded>> = Mutex::new(None);

fn dictionary_files(code: &str) -> Option<(String, String)> {
    let mut dirs: Vec<std::path::PathBuf> = DICT_DIRS.iter().map(std::path::PathBuf::from).collect();
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(Path::new(&home).join(".local/share/hunspell"));
        dirs.push(Path::new(&home).join(".config/enchant/hunspell"));
    }
    for dir in dirs {
        let aff = dir.join(format!("{code}.aff"));
        let dic = dir.join(format!("{code}.dic"));
        if let (Ok(aff), Ok(dic)) = (std::fs::read(&aff), std::fs::read(&dic)) {
            return Some((String::from_utf8_lossy(&aff).into_owned(), String::from_utf8_lossy(&dic).into_owned()));
        }
    }
    None
}

fn dictionary(code: &str) -> Option<std::sync::Arc<spellbook::Dictionary>> {
    if !language_code(code) {
        return None;
    }
    let mut loaded = LOADED.lock().unwrap_or_else(|e| e.into_inner());
    let map = loaded.get_or_insert_with(Default::default);
    if let Some(found) = map.get(code) {
        return Some(found.clone());
    }
    let (aff, dic) = dictionary_files(code)?;
    let parsed = std::sync::Arc::new(spellbook::Dictionary::new(&aff, &dic).ok()?);
    map.insert(code.to_string(), parsed.clone());
    Some(parsed)
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Misspelt {
    pub word: String,
    pub suggestions: Vec<String>,
}

/// Words worth checking: letters with inner apostrophes or hyphens. Links,
/// addresses, words with digits and ALL CAPS are left alone, as are the
/// words in `ignore` (names of the people you are writing to).
pub fn words(text: &str, ignore: &[String]) -> Vec<String> {
    let skip: std::collections::HashSet<String> = ignore.iter().flat_map(|name| name.split(|c: char| !c.is_alphabetic()).map(str::to_lowercase).collect::<Vec<_>>()).collect();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for chunk in text.split_whitespace() {
        let lower = chunk.to_lowercase();
        if lower.contains('@') || lower.contains("://") || lower.starts_with("www.") {
            continue;
        }
        for raw in chunk.replace('\u{2019}', "'").split(|c: char| !(c.is_alphanumeric() || c == '\'' || c == '-')) {
            for piece in raw.split('-') {
                let word = piece.trim_matches('\'');
                if word.chars().count() < 2 || word.chars().any(|c| c.is_numeric()) {
                    continue;
                }
                let stem = word.strip_suffix("'s").or_else(|| word.strip_suffix("'S")).unwrap_or(word);
                if stem.chars().filter(|c| c.is_alphabetic()).all(|c| c.is_uppercase()) {
                    continue;
                }
                if skip.contains(&stem.to_lowercase()) || !seen.insert(word.to_string()) {
                    continue;
                }
                out.push(word.to_string());
            }
        }
    }
    out
}

/// Words added with Learn Spelling. WebKit hands them to enchant, which keeps
/// one word per line in ~/.config/enchant/<language>.dic.
fn personal_words(languages: &[String]) -> std::collections::HashSet<String> {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| Path::new(&home).join(".config")));
    let Some(base) = base else { return Default::default() };
    let mut out = std::collections::HashSet::new();
    for code in languages.iter().filter(|code| language_code(code)) {
        if let Ok(text) = std::fs::read_to_string(base.join("enchant").join(format!("{code}.dic"))) {
            out.extend(learned_words(&text));
        }
    }
    out
}

pub fn learned_words(text: &str) -> Vec<String> {
    text.lines()
        .map(|line| line.trim_start_matches('\u{feff}').trim())
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect()
}

/// A learned word also passes with a capital first letter, as at the start
/// of a sentence.
pub fn learned(word: &str, personal: &std::collections::HashSet<String>) -> bool {
    if personal.contains(word) {
        return true;
    }
    let mut chars = word.chars();
    let Some(first) = chars.next() else { return false };
    let lowered: String = first.to_lowercase().chain(chars).collect();
    lowered != word && personal.contains(&lowered)
}

pub fn check(text: &str, ignore: &[String]) -> Vec<Misspelt> {
    let (enabled, languages) = current();
    let dictionaries: Vec<_> = languages.iter().filter_map(|code| dictionary(code)).collect();
    if !enabled || dictionaries.is_empty() {
        return Vec::new();
    }
    let personal = personal_words(&languages);
    let mut out = Vec::new();
    for word in words(text, ignore) {
        if learned(&word, &personal) || dictionaries.iter().any(|dict| dict.check(&word)) {
            continue;
        }
        let mut suggestions = Vec::new();
        if out.len() < 20 {
            dictionaries[0].suggest(&word, &mut suggestions);
            suggestions.truncate(3);
        }
        out.push(Misspelt { word, suggestions });
        if out.len() >= 50 {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_dictionaries_load_and_check_when_installed() {
        let Some(dict) = dictionary("en_US") else { return };
        let started = std::time::Instant::now();
        assert!(dict.check("Hello") && dict.check("isn't") && dict.check("Thursday"));
        assert!(!dict.check("teh") && !dict.check("recieve"));
        let mut out = Vec::new();
        dict.suggest("recieve", &mut out);
        assert!(out.iter().any(|w| w == "receive"), "{out:?}");
        eprintln!("checked in {:?}", started.elapsed());
    }

    #[test]
    fn learned_words_pass_the_send_check() {
        let personal: std::collections::HashSet<String> = learned_words("\u{feff}Omarchy\n# note\n\nmailroom\n").into_iter().collect();
        assert!(learned("Omarchy", &personal));
        assert!(learned("mailroom", &personal) && learned("Mailroom", &personal));
        assert!(!learned("omarchy", &personal), "a learned capital stays a capital");
        assert!(!learned("note", &personal) && !learned("# note", &personal));
    }

    #[test]
    fn only_real_words_are_checked() {
        let found = words("Hi Jane, see https://x.example/a or mail me@x.example. NASA's 3rd re-run isn't Wagstaffe’s teh teh", &["Wagstaffe, Jane".into()]);
        assert_eq!(found, vec!["Hi", "see", "or", "mail", "re", "run", "isn't", "teh"]);
    }

    #[test]
    fn misspelt_words_come_with_suggestions() {
        let aff = "SET UTF-8\nTRY esianrtolcdugmphbyfvkwz\n";
        let dic = "3\nhello\nworld\nthere\n";
        let dict = spellbook::Dictionary::new(aff, dic).unwrap();
        assert!(dict.check("hello"));
        assert!(!dict.check("helo"));
        let mut out = Vec::new();
        dict.suggest("helo", &mut out);
        assert!(out.contains(&"hello".to_string()), "{out:?}");
    }

    #[test]
    fn dictionaries_are_found_by_their_files() {
        let dir = std::env::temp_dir().join(format!("mailroom-dicts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["en_GB.dic", "en_GB.aff", "en_US.dic", "de_DE.aff", "hyph_en.dic", "hyph_en.aff", "../x.dic"] {
            let _ = std::fs::write(dir.join(name), "");
        }
        assert_eq!(installed_in(&[dir.as_path()]), vec!["en_GB".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_default_follows_the_locale() {
        let have = vec!["de_DE".to_string(), "en_GB".to_string(), "en_US".to_string()];
        assert_eq!(default_for("en_US.UTF-8", &have), vec!["en_US"]);
        assert_eq!(default_for("en_CA.UTF-8", &have), vec!["en_GB"]);
        assert_eq!(default_for("fr_FR.UTF-8", &have), vec!["de_DE"]);
        assert!(default_for("en_US.UTF-8", &[]).is_empty());
    }
}
