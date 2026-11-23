use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const LEGACY_SCOPES: &str = "offline_access User.Read Mail.Read Mail.ReadWrite Calendars.Read Contacts.Read Contacts.ReadWrite";
pub const SCOPES: &str = "offline_access User.Read Mail.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Contacts.Read Contacts.ReadWrite MailboxSettings.ReadWrite People.Read";
const AUTH: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";

/// Every account's tokens live in one saved store. A change reads the whole
/// store and writes it back, so changes take turns: two accounts refreshing
/// at once, or a refresh during a sign-in, must not undo each other.
///
/// The lock also holds the store as last read or written, so a command asks
/// the keyring once, not every time. Nothing slow happens under it: a token
/// refresh talks to the network outside, behind its own account's guard.
static STORE: Mutex<Option<TokenFile>> = Mutex::new(None);

type Turn = std::sync::MutexGuard<'static, Option<TokenFile>>;

fn store_turn() -> Turn {
    STORE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One guard per account, held while its tokens are refreshed, so two
/// commands don't both spend the same refresh token. Other accounts go on.
static REFRESHING: Mutex<BTreeMap<String, Arc<Mutex<()>>>> = Mutex::new(BTreeMap::new());

fn refresh_guard(key: &str) -> Arc<Mutex<()>> {
    let mut guards = REFRESHING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    guards.entry(key.to_string()).or_default().clone()
}

/// How long sign-in waits for the browser to come back.
const SIGN_IN_WAIT: Duration = Duration::from_secs(300);
const TOKEN: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

/// Google accounts: Gmail (read, label, send; never permanent deletion) and
/// Google Calendar events, signed in through the person's own OAuth client.
pub const GOOGLE_SCOPES: &str = "openid email profile https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const GOOGLE_AUTH: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN: &str = "https://oauth2.googleapis.com/token";

/// Which service an account signs in to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Provider {
    Microsoft,
    Google,
}

impl Provider {
    pub fn parse(raw: &str) -> Provider {
        if raw.trim().eq_ignore_ascii_case("google") { Provider::Google } else { Provider::Microsoft }
    }

    pub fn name(self) -> &'static str {
        match self {
            Provider::Microsoft => "microsoft",
            Provider::Google => "google",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedAccount {
    pub email: String,
    pub name: String,
    /// "microsoft" or "google".
    pub provider: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub configured: bool,
    /// A Google OAuth client is saved, so Google accounts can sign in.
    pub google_configured: bool,
    pub signed_in: bool,
    pub email: String,
    pub name: String,
    pub accounts: Vec<SignedAccount>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Tokens {
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    #[serde(default)]
    scopes: String,
    /// Empty for sign-ins saved before Google accounts, which are Microsoft.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    provider: String,
    /// Google's access tokens say nothing about the account, so its address
    /// and name are kept from the sign-in's id token.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    email: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    name: String,
}

impl Tokens {
    fn provider(&self) -> Provider {
        Provider::parse(&self.provider)
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct TokenFile {
    accounts: BTreeMap<String, Tokens>,
}

/// The signed-in accounts. Sign-ins that are saved but can't be read just
/// now (a keyring still locked after login) show as signed out here.
pub fn account_status() -> AccountStatus {
    account_status_checked().unwrap_or_else(|_| status_from(&TokenFile::default(), "", ""))
}

/// The same, with saved sign-ins that could not be read told apart from
/// there being none: the first is an error, to be asked again later.
pub fn account_status_checked() -> Result<AccountStatus, String> {
    let store = stored(&mut store_turn())?;
    Ok(status_from(&store, "", ""))
}

fn status_from(store: &TokenFile, preferred_email: &str, preferred_name: &str) -> AccountStatus {
    let accounts = signed_accounts(store);
    let preferred = preferred_email.trim();
    let current = accounts.iter().find(|item| item.email.eq_ignore_ascii_case(preferred));
    let email = current
        .map(|item| item.email.clone())
        .or_else(|| {
            if preferred.is_empty() {
                None
            } else {
                Some(preferred.to_string())
            }
        })
        .or_else(|| accounts.first().map(|item| item.email.clone()))
        .unwrap_or_default();
    let name = if !preferred_name.trim().is_empty() && current.is_some() {
        preferred_name.trim().to_string()
    } else {
        current
            .or_else(|| accounts.first())
            .map(|item| item.name.clone())
            .unwrap_or_default()
    };
    AccountStatus {
        configured: client_id().is_ok(),
        google_configured: google_client().is_ok(),
        signed_in: !accounts.is_empty(),
        email,
        name,
        accounts,
    }
}

pub fn sign_in(login_hint: Option<String>, provider: Provider) -> Result<AccountStatus, String> {
    if provider == Provider::Google {
        return sign_in_google(login_hint);
    }
    let client_id = client_id()?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|err| err.to_string())?;
    let port = listener.local_addr().map_err(|err| err.to_string())?.port();
    let redirect = format!("http://localhost:{port}");
    let verifier = random_token(64);
    let challenge = pkce_challenge(&verifier);
    let state = random_token(32);
    let url = format!(
        "{AUTH}?client_id={}&response_type=code&redirect_uri={}&response_mode=query&scope={}&code_challenge={}&code_challenge_method=S256&state={}&prompt=select_account",
        form_encode(&client_id),
        form_encode(&redirect),
        form_encode(SCOPES),
        form_encode(&challenge),
        form_encode(&state),
    );
    let url = if let Some(hint) = login_hint.as_deref().map(str::trim).filter(|hint| !hint.is_empty()) {
        format!("{url}&login_hint={}", form_encode(hint))
    } else {
        url
    };
    std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map_err(|_| "Could not open a browser. xdg-open failed.".to_string())?;
    let (mut stream, code) = wait_for_code(&listener, &state, SIGN_IN_WAIT)?;
    let tokens = match exchange_code(&client_id, &redirect, &verifier, &code) {
        Ok(tokens) => tokens,
        Err(err) => {
            finish_browser(&mut stream, "Sign-in did not finish. You can close this window.");
            return Err(err);
        }
    };
    let mut turn = store_turn();
    let mut store = match stored_to_change(&mut turn) {
        Ok(store) => store,
        Err(err) => {
            finish_browser(&mut stream, "Sign-in did not finish. You can close this window.");
            return Err(err);
        }
    };
    let saved_email = match upsert_account(&mut store, tokens) {
        Ok(email) => email,
        Err(err) => {
            finish_browser(&mut stream, "Sign-in did not finish. You can close this window.");
            return Err(err);
        }
    };
    if let Err(err) = keep(&mut turn, &store) {
        finish_browser(&mut stream, "Sign-in did not finish. You can close this window.");
        return Err(err);
    }
    drop(turn);
    let (email, name) = decode_account(&store.accounts.get(&saved_email).map(|item| item.access_token.clone()).unwrap_or_default());
    let status = status_from(&store, &email, &name);
    if !status.signed_in {
        finish_browser(&mut stream, "Sign-in did not finish. You can close this window.");
        return Err("The sign-in could not be saved on this computer.".into());
    }
    finish_browser(&mut stream, "Signed in to Mailroom. You can close this window.");
    Ok(status)
}

pub fn sign_out() -> Result<(), String> {
    let mut turn = store_turn();
    keep(&mut turn, &TokenFile::default())
}

pub fn sign_out_account(email: &str) -> Result<(), String> {
    let mut turn = store_turn();
    let mut store = stored_to_change(&mut turn)?;
    drop_account(&mut store, email);
    keep(&mut turn, &store)
}

/// An access token is used until a minute before it runs out.
fn fresh(tokens: &Tokens, now: u64) -> bool {
    tokens.expires_at > now + 60
}

pub fn access_token_for(email: &str) -> Result<String, String> {
    let not_signed_in = || "That account is not signed in.".to_string();
    let store = load_store()?;
    let key = resolve_key(&store, email)?;
    let current = store.accounts.get(&key).ok_or_else(not_signed_in)?;
    if fresh(current, unix_now()) {
        return Ok(current.access_token.clone());
    }
    // One refresh per account at a time. Whoever waited here reads the store
    // again and usually finds the token the other command just fetched.
    let guard = refresh_guard(&key);
    let _refreshing = guard.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let current = load_store()?.accounts.get(&key).cloned().ok_or_else(not_signed_in)?;
    if fresh(&current, unix_now()) {
        return Ok(current.access_token);
    }
    // The network call holds no store lock, so other accounts carry on.
    let refreshed = match current.provider() {
        Provider::Google => refresh_google(&google_client()?, &current)?,
        Provider::Microsoft => refresh(&client_id()?, &current)?,
    };
    let mut turn = store_turn();
    let mut store = stored(&mut turn)?;
    if settle_refresh(&mut store, &key, &current, refreshed)? {
        if let Err(err) = keep(&mut turn, &store) {
            // The service may have replaced the refresh token; the new one
            // is the only good one, so it stays in memory for the next save.
            *turn = Some(store);
            return Err(err);
        }
    }
    store.accounts.get(&key).map(|item| item.access_token.clone()).ok_or_else(not_signed_in)
}

/// Put refreshed tokens into the store, which may have changed while the
/// refresh was away. An account signed out meanwhile stays out, and one
/// signed in again keeps its newer tokens. Says whether the store changed.
fn settle_refresh(store: &mut TokenFile, key: &str, used: &Tokens, mut refreshed: Tokens) -> Result<bool, String> {
    let Some(saved) = store.accounts.get(key) else {
        return Err("That account is not signed in.".into());
    };
    if saved.refresh_token != used.refresh_token || saved.access_token != used.access_token {
        return Ok(false);
    }
    // A service that rotates refresh tokens sends the next one; otherwise
    // the one in use stays.
    if refreshed.refresh_token.is_empty() {
        refreshed.refresh_token = used.refresh_token.clone();
    }
    refreshed.provider = used.provider.clone();
    refreshed.email = used.email.clone();
    refreshed.name = used.name.clone();
    store.accounts.insert(key.to_string(), refreshed);
    Ok(true)
}

fn exchange_code(client_id: &str, redirect: &str, verifier: &str, code: &str) -> Result<Tokens, String> {
    let body = format!(
        "client_id={}&grant_type=authorization_code&code={}&redirect_uri={}&code_verifier={}",
        form_encode(client_id),
        form_encode(code),
        form_encode(redirect),
        form_encode(verifier),
    );
    token_request(TOKEN, "Microsoft", &body, SCOPES)
}

fn refresh_scopes(current: &Tokens) -> &str {
    let saved = current.scopes.trim();
    if saved.is_empty() { LEGACY_SCOPES } else { saved }
}

fn refresh(client_id: &str, current: &Tokens) -> Result<Tokens, String> {
    let scopes = refresh_scopes(current);
    let body = format!(
        "client_id={}&grant_type=refresh_token&refresh_token={}&scope={}",
        form_encode(client_id),
        form_encode(&current.refresh_token),
        form_encode(scopes),
    );
    let mut tokens = token_request(TOKEN, "Microsoft", &body, scopes)?;
    if tokens.refresh_token.is_empty() {
        tokens.refresh_token = current.refresh_token.clone();
    }
    Ok(tokens)
}

fn token_request(url: &str, who: &str, body: &str, scopes: &str) -> Result<Tokens, String> {
    let value = token_json(url, who, body)?;
    let access_token = value["access_token"].as_str().unwrap_or("").to_string();
    let refresh_token = value["refresh_token"].as_str().unwrap_or("").to_string();
    let expires_in = value["expires_in"].as_u64().unwrap_or(3600);
    if access_token.is_empty() {
        return Err(format!("{who} did not return an access token."));
    }
    Ok(Tokens {
        access_token,
        refresh_token,
        expires_at: unix_now().saturating_add(expires_in),
        scopes: scopes.to_string(),
        provider: String::new(),
        email: String::new(),
        name: String::new(),
    })
}

fn token_json(url: &str, who: &str, body: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|err| err.to_string())?;
    let response = client
        .post(url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body.to_string())
        .send()
        .map_err(|err| format!("Could not reach {who}: {err}"))?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("{who} refused the sign-in ({status}). {}", clip(&text)));
    }
    serde_json::from_str(&text).map_err(|_| format!("{who} sent an unreadable token response."))
}

// ---- Google -----------------------------------------------------------------

/// A Google OAuth client of the "Desktop app" kind. Google calls its secret a
/// secret, but for installed apps it is not one: it ships with the app and
/// only works together with the loopback redirect and PKCE.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleClient {
    pub client_id: String,
    pub client_secret: String,
}

fn google_client_file() -> PathBuf {
    config_dir().join("google-client.json")
}

fn google_client() -> Result<GoogleClient, String> {
    let path = google_client_file();
    if path.exists() {
        let text = fs::read_to_string(&path).map_err(|err| err.to_string())?;
        let saved: GoogleClient = serde_json::from_str(&text).map_err(|_| "The saved Google client could not be read. Save it again.".to_string())?;
        return parse_google_client(&saved.client_id, &saved.client_secret);
    }
    if let (Ok(id), Ok(secret)) = (std::env::var("MAILROOM_GOOGLE_CLIENT_ID"), std::env::var("MAILROOM_GOOGLE_CLIENT_SECRET")) {
        if let Ok(client) = parse_google_client(&id, &secret) {
            return Ok(client);
        }
    }
    Err("Google sign-in is not set up on this computer yet.".into())
}

/// The saved Google client id, or empty. The secret stays on this side.
pub fn current_google_client_id() -> String {
    google_client().map(|client| client.client_id).unwrap_or_default()
}

/// Save the Google client. `raw_id` may also be the whole JSON file Google
/// offers to download, in which case `raw_secret` can be empty.
pub fn save_google_client(raw_id: &str, raw_secret: &str) -> Result<String, String> {
    let client = match google_client_from_json(raw_id) {
        Some(client) => client,
        None => parse_google_client(raw_id, raw_secret)?,
    };
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let json = serde_json::to_string(&client).map_err(|err| err.to_string())?;
    write_secret(&google_client_file(), json.as_bytes())?;
    Ok(client.client_id)
}

fn google_client_from_json(raw: &str) -> Option<GoogleClient> {
    let value: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    let block = value.get("installed").or_else(|| value.get("web")).unwrap_or(&value);
    let id = block.get("client_id")?.as_str()?;
    let secret = block.get("client_secret")?.as_str()?;
    parse_google_client(id, secret).ok()
}

fn parse_google_client(raw_id: &str, raw_secret: &str) -> Result<GoogleClient, String> {
    let id = raw_id.trim();
    let secret = raw_secret.trim();
    let id_ok = id.len() <= 200
        && id.ends_with(".apps.googleusercontent.com")
        && id.len() > ".apps.googleusercontent.com".len()
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'));
    if !id_ok {
        return Err("The Google client ID ends in .apps.googleusercontent.com.".into());
    }
    if secret.is_empty() || secret.len() > 200 || secret.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Paste the client secret from the same Google client.".into());
    }
    Ok(GoogleClient { client_id: id.to_string(), client_secret: secret.to_string() })
}

fn sign_in_google(login_hint: Option<String>) -> Result<AccountStatus, String> {
    let client = google_client()?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|err| err.to_string())?;
    let port = listener.local_addr().map_err(|err| err.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let verifier = random_token(64);
    let challenge = pkce_challenge(&verifier);
    let state = random_token(32);
    let mut url = format!(
        "{GOOGLE_AUTH}?client_id={}&response_type=code&redirect_uri={}&scope={}&code_challenge={}&code_challenge_method=S256&state={}&access_type=offline&prompt=consent&include_granted_scopes=true",
        form_encode(&client.client_id),
        form_encode(&redirect),
        form_encode(GOOGLE_SCOPES),
        form_encode(&challenge),
        form_encode(&state),
    );
    if let Some(hint) = login_hint.as_deref().map(str::trim).filter(|hint| !hint.is_empty()) {
        url.push_str(&format!("&login_hint={}", form_encode(hint)));
    }
    std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map_err(|_| "Could not open a browser. xdg-open failed.".to_string())?;
    let (mut stream, code) = wait_for_code(&listener, &state, SIGN_IN_WAIT)?;
    let body = format!(
        "client_id={}&client_secret={}&grant_type=authorization_code&code={}&redirect_uri={}&code_verifier={}",
        form_encode(&client.client_id),
        form_encode(&client.client_secret),
        form_encode(&code),
        form_encode(&redirect),
        form_encode(&verifier),
    );
    let tokens = match token_json(GOOGLE_TOKEN, "Google", &body).and_then(|value| google_tokens(&value)) {
        Ok(tokens) => tokens,
        Err(err) => {
            finish_browser(&mut stream, "Sign-in did not finish. You can close this window.");
            return Err(err);
        }
    };
    if !granted_all(&tokens.scopes) {
        finish_browser(&mut stream, "Mailroom needs every permission on that page. Sign in again and leave them all ticked.");
        return Err("Google did not grant mail and calendar access. Sign in again and leave every box ticked.".into());
    }
    let mut turn = store_turn();
    let mut store = match stored_to_change(&mut turn) {
        Ok(store) => store,
        Err(err) => {
            drop(turn);
            finish_browser(&mut stream, "Sign-in did not finish. You can close this window.");
            return Err(err);
        }
    };
    let saved = upsert_account(&mut store, tokens).and_then(|key| keep(&mut turn, &store).map(|_| key));
    drop(turn);
    let key = match saved {
        Ok(key) => key,
        Err(err) => {
            finish_browser(&mut stream, "Sign-in did not finish. You can close this window.");
            return Err(err);
        }
    };
    let name = store.accounts.get(&key).map(|item| item.name.clone()).unwrap_or_default();
    let status = status_from(&store, &key, &name);
    finish_browser(&mut stream, "Signed in to Mailroom. You can close this window.");
    Ok(status)
}

/// Tokens from Google's token answer, with the account read from the id token.
fn google_tokens(value: &serde_json::Value) -> Result<Tokens, String> {
    let access_token = value["access_token"].as_str().unwrap_or("").to_string();
    if access_token.is_empty() {
        return Err("Google did not return an access token.".into());
    }
    let (email, name) = decode_account(value["id_token"].as_str().unwrap_or(""));
    if email.trim().is_empty() || !email.contains('@') {
        return Err("Google did not say which account signed in.".into());
    }
    Ok(Tokens {
        access_token,
        refresh_token: value["refresh_token"].as_str().unwrap_or("").to_string(),
        expires_at: unix_now().saturating_add(value["expires_in"].as_u64().unwrap_or(3600)),
        scopes: value["scope"].as_str().unwrap_or(GOOGLE_SCOPES).to_string(),
        provider: Provider::Google.name().into(),
        email: email.trim().to_string(),
        name: name.trim().to_string(),
    })
}

/// Google lets people untick permissions on its consent page.
fn granted_all(scopes: &str) -> bool {
    let granted: Vec<&str> = scopes.split_whitespace().collect();
    ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/calendar.events"]
        .iter()
        .all(|needed| granted.contains(needed))
}

fn refresh_google(client: &GoogleClient, current: &Tokens) -> Result<Tokens, String> {
    let body = format!(
        "client_id={}&client_secret={}&grant_type=refresh_token&refresh_token={}",
        form_encode(&client.client_id),
        form_encode(&client.client_secret),
        form_encode(&current.refresh_token),
    );
    let value = token_json(GOOGLE_TOKEN, "Google", &body).map_err(|err| {
        if err.contains("invalid_grant") {
            "Google signed this account out. Sign in again.".to_string()
        } else {
            err
        }
    })?;
    let access_token = value["access_token"].as_str().unwrap_or("").to_string();
    if access_token.is_empty() {
        return Err("Google did not return an access token.".into());
    }
    Ok(Tokens {
        access_token,
        // Google keeps the refresh token; it only sends a new one rarely.
        refresh_token: value["refresh_token"].as_str().unwrap_or("").to_string(),
        expires_at: unix_now().saturating_add(value["expires_in"].as_u64().unwrap_or(3600)),
        scopes: value["scope"].as_str().map(str::to_string).unwrap_or_else(|| current.scopes.clone()),
        provider: current.provider.clone(),
        email: current.email.clone(),
        name: current.name.clone(),
    })
}

/// Which service an account signs in to. An unknown account is Microsoft,
/// as every account was before Google.
pub fn provider_of(email: &str) -> Provider {
    let Ok(store) = stored(&mut store_turn()) else { return Provider::Microsoft };
    resolve_key(&store, email)
        .ok()
        .and_then(|key| store.accounts.get(&key).map(Tokens::provider))
        .unwrap_or(Provider::Microsoft)
}

pub fn is_google(email: &str) -> bool {
    provider_of(email) == Provider::Google
}

/// The account's name as it signed in, for the From line.
pub fn account_name(email: &str) -> String {
    let Ok(store) = stored(&mut store_turn()) else { return String::new() };
    let Ok(key) = resolve_key(&store, email) else { return String::new() };
    store
        .accounts
        .get(&key)
        .map(|tokens| if tokens.name.is_empty() { decode_account(&tokens.access_token).1 } else { tokens.name.clone() })
        .unwrap_or_default()
}

/// What a request to the sign-in port turned out to be.
#[derive(Debug, PartialEq)]
enum Callback {
    /// The browser coming back from this sign-in, with its code.
    Code(String),
    /// The browser coming back from this sign-in without one, and why.
    Refused(String),
    /// Anything else: another program, or a page from some other sign-in.
    Stray,
}

/// Only a request carrying this sign-in's `state` is the browser coming
/// back; the port is open to every program on the computer.
fn read_callback(request: &str, expected_state: &str) -> Callback {
    let line = request.lines().next().unwrap_or("");
    let path = line.split_whitespace().nth(1).unwrap_or("");
    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut code = String::new();
    let mut state = String::new();
    let mut error = String::new();
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else { continue };
        let value = form_decode(value);
        match key {
            "code" => code = value,
            "state" => state = value,
            "error_description" => error = value,
            "error" if error.is_empty() => error = value,
            _ => {}
        }
    }
    if expected_state.is_empty() || state != expected_state {
        return Callback::Stray;
    }
    if !code.is_empty() {
        return Callback::Code(code);
    }
    Callback::Refused(if error.is_empty() {
        "Microsoft did not return a sign-in code.".to_string()
    } else {
        clip(&error.replace('+', " "))
    })
}

/// One request's head from a connection, as far as it came in time.
fn read_request(stream: &mut TcpStream, wait: Duration) -> String {
    // The browser sends its one request at once. A whole-request deadline,
    // not just a per-read timeout, so nothing that connects here can hold
    // sign-in open by sending a byte at a time.
    let deadline = Instant::now() + wait;
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    while buf.len() < 65536 {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || stream.set_read_timeout(Some(left)).is_err() {
            break;
        }
        let n = match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        buf.extend_from_slice(&tmp[..n]);
        if buf.windows(4).any(|mark| mark == b"\r\n\r\n") {
            break;
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// Wait for the browser to come back with this sign-in's code. Anything else
/// that connects is turned away and the wait goes on, until `wait` is up:
/// a closed browser tab must not leave sign-in waiting for ever.
fn wait_for_code(listener: &TcpListener, state: &str, wait: Duration) -> Result<(TcpStream, String), String> {
    listener.set_nonblocking(true).map_err(|err| err.to_string())?;
    let deadline = Instant::now() + wait;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err("Sign-in timed out before the browser came back.".into());
        }
        // Nothing waiting, or a connection that went away again.
        let Ok((mut stream, _)) = listener.accept() else {
            std::thread::sleep(Duration::from_millis(100).min(left));
            continue;
        };
        if stream.set_nonblocking(false).is_err() {
            continue;
        }
        // Short, so a connection that says nothing (browsers open spare
        // ones) does not keep the real one waiting long.
        let request = read_request(&mut stream, Duration::from_secs(5).min(left));
        match read_callback(&request, state) {
            Callback::Code(code) => return Ok((stream, code)),
            Callback::Refused(why) => {
                finish_browser(&mut stream, "Sign-in did not finish. You can close this window.");
                return Err(why);
            }
            Callback::Stray => turn_away(&mut stream),
        }
    }
}

fn turn_away(stream: &mut TcpStream) {
    let html = "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n<!doctype html><title>Mailroom</title><p>This is not the sign-in Mailroom is waiting for. You can close this window.</p>";
    let _ = stream.write_all(html.as_bytes());
}

fn finish_browser(stream: &mut TcpStream, page: &str) {
    let html = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n<!doctype html><title>Mailroom</title><p>{}</p>",
        page
    );
    let _ = stream.write_all(html.as_bytes());
}

fn client_id() -> Result<String, String> {
    let path = config_dir().join("client-id");
    if path.exists() {
        let text = fs::read_to_string(&path).map_err(|err| err.to_string())?;
        return parse_client_id(&text);
    }
    if let Ok(value) = std::env::var("MAILROOM_CLIENT_ID") {
        if let Ok(id) = parse_client_id(&value) {
            return Ok(id);
        }
    }
    Err("Microsoft sign-in is not set up on this computer yet.".into())
}

pub fn current_client_id() -> String {
    client_id().unwrap_or_default()
}

pub fn save_client_id(raw: &str) -> Result<String, String> {
    if raw.trim().is_empty() {
        return Err("Enter the client id.".into());
    }
    let id = parse_client_id(raw)?;
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let path = dir.join("client-id");
    fs::write(&path, format!("{id}\n")).map_err(|err| err.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(|err| err.to_string())?;
    Ok(id)
}

fn parse_client_id(raw: &str) -> Result<String, String> {
    let id = raw.trim();
    let guid = id.len() == 36
        && id.as_bytes().iter().enumerate().all(|(index, byte)| {
            if index == 8 || index == 13 || index == 18 || index == 23 {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        });
    if guid {
        Ok(id.to_string())
    } else {
        Err("The application id must be the Entra client id, a GUID. Do not paste a secret.".into())
    }
}

fn config_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("mailroom")
}

fn token_file() -> PathBuf {
    config_dir().join("tokens.json")
}

fn forget_store() -> Result<(), String> {
    let _ = keyring::Entry::new("mailroom", "microsoft-tokens")
        .and_then(|entry| entry.delete_credential());
    let path = token_file();
    if path.exists() {
        fs::remove_file(&path).map_err(|err| err.to_string())?;
    }
    Ok(())
}

fn save_store(store: &TokenFile) -> Result<(), String> {
    if store.accounts.is_empty() {
        return forget_store();
    }
    let json = serde_json::to_string(store).map_err(|err| err.to_string())?;
    if keyring_stores(&json) {
        let path = token_file();
        if path.exists() {
            let _ = fs::remove_file(path);
        }
        return Ok(());
    }
    if let Ok(entry) = keyring::Entry::new("mailroom", "microsoft-tokens") {
        let _ = entry.delete_credential();
    }
    let dir = config_dir();
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let path = token_file();
    write_secret(&path, json.as_bytes())
}

/// Write a file only this user can read, before any secret is in it: a new
/// file is made 0600 and an old one is made 0600 and emptied first.
pub(crate) fn write_secret(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|err| err.to_string())?;
    file.set_permissions(fs::Permissions::from_mode(0o600)).map_err(|err| err.to_string())?;
    file.write_all(bytes).map_err(|err| err.to_string())
}

fn keyring_stores(json: &str) -> bool {
    let Ok(entry) = keyring::Entry::new("mailroom", "microsoft-tokens") else {
        return false;
    };
    if entry.set_password(json).is_err() {
        return false;
    }
    let Ok(again) = keyring::Entry::new("mailroom", "microsoft-tokens") else {
        return false;
    };
    match again.get_password() {
        Ok(saved) if saved == json => true,
        _ => {
            let _ = entry.delete_credential();
            false
        }
    }
}

/// What reading the saved store found.
enum Saved {
    Store(TokenFile),
    /// The keyring answered that it holds nothing, and there is no file.
    Nothing,
    /// No keyring to ask and no file: signed out, as far as can be told now.
    Unreachable,
    /// There may be sign-ins, but they can't be read, with why.
    Unreadable(String),
    /// The keyring is there but locked: the sign-ins are there, unread.
    Locked(String),
}

fn read_saved() -> Saved {
    let from_keyring = match keyring::Entry::new("mailroom", "microsoft-tokens").and_then(|entry| entry.get_password()) {
        Ok(json) => match parse_store(&json) {
            Ok(store) if !store.accounts.is_empty() => return Saved::Store(store),
            Ok(_) => Saved::Nothing,
            Err(err) => Saved::Unreadable(err),
        },
        Err(keyring::Error::NoEntry) => Saved::Nothing,
        // A keyring that is there but locked, as it can be just after login.
        Err(keyring::Error::NoStorageAccess(_)) => Saved::Locked("The keyring is locked, so the saved sign-in can't be read. Unlock it and try again.".into()),
        Err(_) => Saved::Unreachable,
    };
    let path = token_file();
    if !path.exists() {
        return from_keyring;
    }
    match fs::read_to_string(path).map_err(|err| err.to_string()).and_then(|json| parse_store(&json)) {
        Ok(store) if !store.accounts.is_empty() => Saved::Store(store),
        Ok(_) => from_keyring,
        Err(err) => Saved::Unreadable(err),
    }
}

/// The store, from memory once it has been read. No accounts is an answer
/// too. Only a real answer is remembered: when the saved store could not be
/// read, or there was no keyring to ask, the next call asks again.
fn stored(slot: &mut Option<TokenFile>) -> Result<TokenFile, String> {
    stored_with(slot, read_saved)
}

/// The store, to change and save back. A locked keyring stops the change:
/// saving over sign-ins that could not be read would lose them. A store that
/// is there but can't be parsed is started again, so signing in still works.
fn stored_to_change(slot: &mut Option<TokenFile>) -> Result<TokenFile, String> {
    stored_to_change_with(slot, read_saved)
}

fn stored_to_change_with(slot: &mut Option<TokenFile>, read: impl FnOnce() -> Saved) -> Result<TokenFile, String> {
    stored_with(slot, || match read() {
        Saved::Unreadable(_) => Saved::Unreachable,
        other => other,
    })
}

fn stored_with(slot: &mut Option<TokenFile>, read: impl FnOnce() -> Saved) -> Result<TokenFile, String> {
    if let Some(store) = slot.as_ref() {
        return Ok(store.clone());
    }
    match read() {
        Saved::Store(store) => {
            *slot = Some(store.clone());
            Ok(store)
        }
        Saved::Nothing => {
            *slot = Some(TokenFile::default());
            Ok(TokenFile::default())
        }
        Saved::Unreachable => Ok(TokenFile::default()),
        Saved::Unreadable(why) | Saved::Locked(why) => Err(why),
    }
}

/// Save the store and remember it. After a failed save what is on disk is
/// anyone's guess, so it is read again next time.
fn keep(slot: &mut Option<TokenFile>, store: &TokenFile) -> Result<(), String> {
    keep_with(slot, store, save_store)
}

fn keep_with(slot: &mut Option<TokenFile>, store: &TokenFile, save: impl FnOnce(&TokenFile) -> Result<(), String>) -> Result<(), String> {
    match save(store) {
        Ok(()) => {
            *slot = Some(store.clone());
            Ok(())
        }
        Err(err) => {
            *slot = None;
            Err(err)
        }
    }
}

/// The store of a signed-in person; with no accounts there is nothing to use.
fn load_store() -> Result<TokenFile, String> {
    let store = stored(&mut store_turn())?;
    if store.accounts.is_empty() {
        return Err("Sign in first.".into());
    }
    Ok(store)
}

fn parse_store(json: &str) -> Result<TokenFile, String> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|_| "The saved sign-in could not be read. Sign in again.".to_string())?;
    if value.get("accounts").and_then(|item| item.as_object()).is_some() {
        return serde_json::from_value(value).map_err(|_| "The saved sign-in could not be read. Sign in again.".to_string());
    }
    if value.get("access_token").and_then(|item| item.as_str()).is_some() {
        let tokens: Tokens = serde_json::from_value(value).map_err(|_| "The saved sign-in could not be read. Sign in again.".to_string())?;
        let mut store = TokenFile::default();
        upsert_account(&mut store, tokens)?;
        return Ok(store);
    }
    Err("The saved sign-in could not be read. Sign in again.".into())
}

fn signed_accounts(store: &TokenFile) -> Vec<SignedAccount> {
    store
        .accounts
        .iter()
        .map(|(email, tokens)| {
            let (decoded, name) = if tokens.email.is_empty() {
                decode_account(&tokens.access_token)
            } else {
                (tokens.email.clone(), tokens.name.clone())
            };
            SignedAccount {
                email: if decoded.trim().is_empty() { email.clone() } else { decoded },
                name,
                provider: tokens.provider().name().into(),
            }
        })
        .collect()
}

fn upsert_account(store: &mut TokenFile, tokens: Tokens) -> Result<String, String> {
    let email = if tokens.email.is_empty() { decode_account(&tokens.access_token).0 } else { tokens.email.clone() };
    let key = email.trim().to_lowercase();
    if key.is_empty() || !key.contains('@') {
        return Err("Microsoft did not say which account signed in.".into());
    }
    store.accounts.insert(key.clone(), tokens);
    Ok(key)
}

fn drop_account(store: &mut TokenFile, email: &str) {
    let key = email.trim().to_lowercase();
    store.accounts.retain(|saved, _| saved != &key);
}

fn resolve_key(store: &TokenFile, email: &str) -> Result<String, String> {
    let want = email.trim().to_lowercase();
    if !want.is_empty() {
        if store.accounts.contains_key(&want) {
            return Ok(want);
        }
        return Err("That account is not signed in.".into());
    }
    match store.accounts.len() {
        0 => Err("Sign in first.".into()),
        1 => Ok(store.accounts.keys().next().cloned().unwrap_or_default()),
        _ => Err("Choose an account.".into()),
    }
}

fn decode_account(access_token: &str) -> (String, String) {
    let Some(payload) = access_token.split('.').nth(1) else {
        return (String::new(), String::new());
    };
    let bytes = URL_SAFE_NO_PAD.decode(payload).unwrap_or_default();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    let email = value["preferred_username"]
        .as_str()
        .or_else(|| value["upn"].as_str())
        .or_else(|| value["email"].as_str())
        .unwrap_or("")
        .to_string();
    let name = value["name"].as_str().unwrap_or("").to_string();
    (email, name)
}

fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

/// Bytes from the operating system's random source. There is no safe
/// fallback for state, PKCE verifiers or ids, so a failure stops here, as
/// rand's OsRng did before 0.10.
pub(crate) fn system_random(bytes: &mut [u8]) {
    use rand::TryRng;
    rand::rngs::SysRng.try_fill_bytes(bytes).expect("the system random source failed");
}

fn random_token(len: usize) -> String {
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    // Only bytes below a multiple of the alphabet's size, so every
    // character is equally likely.
    let limit = (256 / CHARSET.len() * CHARSET.len()) as u8;
    let mut out = String::with_capacity(len);
    let mut bytes = [0u8; 64];
    while out.len() < len {
        system_random(&mut bytes);
        for &byte in bytes.iter().filter(|&&byte| byte < limit) {
            if out.len() == len {
                break;
            }
            out.push(CHARSET[byte as usize % CHARSET.len()] as char);
        }
    }
    out
}

fn form_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn form_decode(value: &str) -> String {
    let mut out = Vec::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Some(byte) = value.get(index + 1..index + 3).and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        if bytes[index] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[index]);
        }
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn clip(text: &str) -> String {
    let flat = text.replace(['\n', '\r'], " ");
    flat.chars().take(280).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_tokens_use_only_the_pkce_alphabet() {
        let token = random_token(128);
        assert_eq!(token.len(), 128);
        assert!(token.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b)), "{token}");
        assert_ne!(random_token(43), random_token(43));
    }

    #[test]
    fn form_decode_survives_a_percent_before_a_wide_character() {
        assert_eq!(form_decode("%1\u{e9}x"), "%1\u{e9}x");
        assert_eq!(form_decode("a%20b+c"), "a b c");
    }

    #[test]
    fn challenge_is_url_safe() {
        let challenge = pkce_challenge("abc");
        assert_eq!(challenge.len(), 43);
        assert!(challenge.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn client_id_rejects_a_secret() {
        assert!(parse_client_id("not-a-guid").is_err());
        assert!(parse_client_id("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").is_ok());
    }

    fn fake_jwt(email: &str, name: &str) -> String {
        let payload = serde_json::json!({ "preferred_username": email, "name": name });
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        format!("e30.{body}.sig")
    }

    fn token_for(email: &str, name: &str) -> Tokens {
        Tokens {
            access_token: fake_jwt(email, name),
            refresh_token: format!("refresh-{email}"),
            expires_at: 9_999_999_999,
            scopes: String::new(),
            provider: String::new(),
            email: String::new(),
            name: String::new(),
        }
    }

    #[test]
    fn a_google_sign_in_names_its_account_from_the_id_token() {
        let id_token = {
            let payload = serde_json::json!({ "email": "someone@gmail.com", "name": "Sam R" });
            format!("e30.{}.sig", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap()))
        };
        let answer = serde_json::json!({ "access_token": "ya29.opaque", "refresh_token": "1//r", "expires_in": 3599, "id_token": id_token, "scope": GOOGLE_SCOPES });
        let tokens = google_tokens(&answer).unwrap();
        assert_eq!(tokens.provider(), Provider::Google);
        let mut store = TokenFile::default();
        store.accounts.insert("ms@example.com".into(), token_for("ms@example.com", "MS"));
        let key = upsert_account(&mut store, tokens).unwrap();
        assert_eq!(key, "someone@gmail.com");
        let listed = signed_accounts(&store);
        let google = listed.iter().find(|a| a.email == "someone@gmail.com").unwrap();
        assert_eq!((google.name.as_str(), google.provider.as_str()), ("Sam R", "google"));
        assert_eq!(listed.iter().find(|a| a.email == "ms@example.com").unwrap().provider, "microsoft");
        let json = serde_json::to_string(&store).unwrap();
        assert!(!json.contains("\"provider\":\"\""), "old sign-ins are saved as before");
        assert_eq!(parse_store(&json).unwrap().accounts["someone@gmail.com"].provider(), Provider::Google);
    }

    #[test]
    fn google_must_grant_mail_and_calendar() {
        assert!(granted_all(GOOGLE_SCOPES));
        assert!(!granted_all("openid email https://www.googleapis.com/auth/gmail.modify"));
    }

    #[test]
    fn a_google_client_is_an_id_and_its_secret_or_the_downloaded_file() {
        assert!(parse_google_client("123-abc.apps.googleusercontent.com", "GOCSPX-x").is_ok());
        assert!(parse_google_client("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "x").is_err(), "an Entra id is not a Google client");
        assert!(parse_google_client("123-abc.apps.googleusercontent.com", "").is_err());
        let file = r#"{"installed":{"client_id":"9-z.apps.googleusercontent.com","client_secret":"GOCSPX-s","redirect_uris":["http://localhost"]}}"#;
        assert_eq!(google_client_from_json(file).unwrap().client_secret, "GOCSPX-s");
        assert!(google_client_from_json("not json").is_none());
    }

    #[test]
    fn refresh_keeps_the_granted_scopes() {
        assert_eq!(refresh_scopes(&token_for("one@example.com", "One")), LEGACY_SCOPES);
        let mut granted = token_for("one@example.com", "One");
        granted.scopes = SCOPES.to_string();
        assert_eq!(refresh_scopes(&granted), SCOPES);
        assert!(SCOPES.contains("Mail.Send"));
        assert!(!LEGACY_SCOPES.contains("Mail.Send"));
    }

    #[test]
    fn legacy_sign_in_is_one_account() {
        let tokens = token_for("one@example.com", "One");
        let json = serde_json::to_string(&tokens).unwrap();
        let store = parse_store(&json).expect("legacy");
        assert_eq!(store.accounts.len(), 1);
        assert!(store.accounts.contains_key("one@example.com"));
        assert_eq!(signed_accounts(&store)[0].name, "One");
    }

    #[test]
    fn saved_sign_ins_keep_each_account() {
        let mut store = TokenFile::default();
        upsert_account(&mut store, token_for("one@example.com", "One")).unwrap();
        upsert_account(&mut store, token_for("two@example.com", "Two")).unwrap();
        let again = token_for("one@example.com", "One Again");
        upsert_account(&mut store, again).unwrap();
        assert_eq!(store.accounts.len(), 2);
        assert_eq!(signed_accounts(&store).len(), 2);
        assert_eq!(resolve_key(&store, "TWO@example.com").unwrap(), "two@example.com");
        drop_account(&mut store, "one@example.com");
        assert_eq!(store.accounts.len(), 1);
        assert!(store.accounts.contains_key("two@example.com"));
        let json = serde_json::to_string(&store).unwrap();
        let loaded = parse_store(&json).unwrap();
        assert_eq!(loaded.accounts.len(), 1);
        assert!(resolve_key(&loaded, "").is_ok());
        assert!(resolve_key(&TokenFile::default(), "").is_err());
    }

    #[test]
    fn the_store_is_read_once_and_a_failed_read_is_asked_again() {
        let mut one = TokenFile::default();
        upsert_account(&mut one, token_for("one@example.com", "One")).unwrap();

        // A locked keyring is an error, and is not remembered as signed out.
        let mut slot = None;
        assert!(stored_with(&mut slot, || Saved::Locked("locked".into())).is_err());
        assert!(slot.is_none());
        assert!(stored_with(&mut slot, || Saved::Unreadable("bad".into())).is_err());
        assert!(slot.is_none());
        // Changing the store: a locked keyring stops it, so the sign-ins in it
        // are not saved over; an unparseable store is started again.
        assert!(stored_to_change_with(&mut slot, || Saved::Locked("locked".into())).is_err());
        assert!(slot.is_none());
        assert!(stored_to_change_with(&mut slot, || Saved::Unreadable("bad".into())).unwrap().accounts.is_empty());
        assert!(slot.is_none());
        // No keyring at all reads as signed out, and is asked again too.
        assert!(stored_with(&mut slot, || Saved::Unreachable).unwrap().accounts.is_empty());
        assert!(slot.is_none());
        // Once it answers, the answer is kept and nothing is read again.
        let saved = one.clone();
        assert_eq!(stored_with(&mut slot, move || Saved::Store(saved)).unwrap().accounts.len(), 1);
        assert_eq!(stored_with(&mut slot, || panic!("read twice")).unwrap().accounts.len(), 1);

        // "No accounts" from a keyring that answered is kept as well.
        let mut slot = None;
        assert!(stored_with(&mut slot, || Saved::Nothing).unwrap().accounts.is_empty());
        assert!(stored_with(&mut slot, || panic!("read twice")).unwrap().accounts.is_empty());

        // A save goes through to memory; a failed one is forgotten.
        assert!(keep_with(&mut slot, &one, |_| Ok(())).is_ok());
        assert!(slot.as_ref().unwrap().accounts.contains_key("one@example.com"));
        assert!(keep_with(&mut slot, &TokenFile::default(), |_| Err("disk".into())).is_err());
        assert!(slot.is_none());
    }

    #[test]
    fn a_refresh_keeps_the_newest_refresh_token() {
        let mut store = TokenFile::default();
        let mut used = token_for("one@example.com", "One");
        used.expires_at = 0;
        used.scopes = SCOPES.into();
        upsert_account(&mut store, used.clone()).unwrap();
        let answer = |refresh: &str| Tokens { access_token: "new-access".into(), refresh_token: refresh.into(), expires_at: 5_000_000_000, ..token_for("x@example.com", "X") };

        // A rotated refresh token replaces the old one.
        let mut rotated = store.clone();
        assert!(settle_refresh(&mut rotated, "one@example.com", &used, answer("rotated")).unwrap());
        let saved = &rotated.accounts["one@example.com"];
        assert_eq!((saved.access_token.as_str(), saved.refresh_token.as_str()), ("new-access", "rotated"));
        assert!(fresh(saved, unix_now()));

        // No new refresh token: the one in use stays.
        let mut same = store.clone();
        assert!(settle_refresh(&mut same, "one@example.com", &used, answer("")).unwrap());
        assert_eq!(same.accounts["one@example.com"].refresh_token, "refresh-one@example.com");

        // Signed in again while the refresh was away: the newer sign-in wins.
        let mut again = store.clone();
        let mut newer = token_for("one@example.com", "One");
        newer.refresh_token = "from-sign-in".into();
        upsert_account(&mut again, newer).unwrap();
        assert!(!settle_refresh(&mut again, "one@example.com", &used, answer("rotated")).unwrap());
        assert_eq!(again.accounts["one@example.com"].refresh_token, "from-sign-in");

        // Signed out while the refresh was away: it stays signed out.
        let mut gone = TokenFile::default();
        assert!(settle_refresh(&mut gone, "one@example.com", &used, answer("rotated")).is_err());
        assert!(gone.accounts.is_empty());
    }

    #[test]
    fn only_a_request_with_this_sign_ins_state_counts() {
        assert_eq!(read_callback("GET /?code=abc&state=s1 HTTP/1.1\r\n\r\n", "s1"), Callback::Code("abc".into()));
        assert_eq!(read_callback("GET /?code=abc&state=other HTTP/1.1\r\n\r\n", "s1"), Callback::Stray);
        assert_eq!(read_callback("GET /?code=abc HTTP/1.1\r\n\r\n", "s1"), Callback::Stray);
        assert_eq!(read_callback("GET /favicon.ico HTTP/1.1\r\n\r\n", "s1"), Callback::Stray);
        assert_eq!(read_callback("", "s1"), Callback::Stray);
        assert_eq!(read_callback("GET /?code=abc&state= HTTP/1.1\r\n\r\n", ""), Callback::Stray);
        assert_eq!(
            read_callback("GET /?error=access_denied&error_description=You+said+no&state=s1 HTTP/1.1\r\n\r\n", "s1"),
            Callback::Refused("You said no".into())
        );
        // A refusal without the state is not this sign-in's either.
        assert_eq!(read_callback("GET /?error=access_denied HTTP/1.1\r\n\r\n", "s1"), Callback::Stray);
    }

    #[test]
    fn sign_in_waits_past_strangers_for_its_own_browser() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let browser = std::thread::spawn(move || {
            let mut answers = Vec::new();
            for request in ["GET /?code=stolen&state=guess HTTP/1.1\r\n\r\n", "GET /?code=real&state=mine HTTP/1.1\r\n\r\n"] {
                let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
                stream.write_all(request.as_bytes()).unwrap();
                if request.contains("guess") {
                    let mut answer = String::new();
                    let _ = stream.read_to_string(&mut answer);
                    answers.push(answer);
                }
            }
            answers
        });
        let (_stream, code) = wait_for_code(&listener, "mine", Duration::from_secs(20)).unwrap();
        assert_eq!(code, "real");
        let answers = browser.join().unwrap();
        assert!(answers[0].starts_with("HTTP/1.1 400"), "{answers:?}");
    }

    #[test]
    fn sign_in_gives_up_when_the_browser_never_comes_back() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let started = Instant::now();
        let err = wait_for_code(&listener, "mine", Duration::from_millis(300)).unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn keyring_keeps_a_secret_for_a_new_entry() {
        let entry = keyring::Entry::new("mailroom-probe", "probe").expect("entry");
        // No Secret Service (a CI machine, say): nothing to test here.
        if entry.set_password("probe").is_err() {
            eprintln!("skipped: no keyring on this machine");
            return;
        }
        let again = keyring::Entry::new("mailroom-probe", "probe").expect("again");
        let got = again.get_password().expect("get");
        let _ = entry.delete_credential();
        assert_eq!(got, "probe");
    }
}
