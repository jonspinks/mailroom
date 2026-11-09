//! Google Calendar, for Google accounts: calendars, events, changes,
//! repeating series and answers to invitations.
//!
//! Google keeps events per calendar, and changing one needs both ids. The
//! page knows an event by one id, so a Google event's id is the calendar id
//! (base64url, which has no `@` or `~`) and the event id, joined by `~`.
//!
//! The page speaks Microsoft's shapes, so a repeat is turned into an RRULE
//! on the way out and back into a Graph patternedRecurrence on the way in.

use crate::auth;
use crate::calendar::{self, EventFields, Series};
use crate::compose;
use crate::google::{self, call};
use crate::graph::{self, LiveAttendee, LiveCalendar, LiveEvent};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};

const CAL: &str = "https://www.googleapis.com/calendar/v3";
const WEEKDAYS: [(&str, &str); 7] = [
    ("sunday", "SU"),
    ("monday", "MO"),
    ("tuesday", "TU"),
    ("wednesday", "WE"),
    ("thursday", "TH"),
    ("friday", "FR"),
    ("saturday", "SA"),
];
const INDEXES: [(&str, i32); 5] = [("first", 1), ("second", 2), ("third", 3), ("fourth", 4), ("last", -1)];

fn seg(value: &str) -> String {
    graph::path_segment(value.trim())
}

/// The page's id for a Google event.
pub fn event_key(calendar_id: &str, event_id: &str) -> String {
    format!("{}~{}", URL_SAFE_NO_PAD.encode(calendar_id.as_bytes()), event_id)
}

/// (calendar id, event id) from the page's id. A bare id is on the primary
/// calendar.
pub fn split_key(key: &str) -> Result<(String, String), String> {
    let key = key.trim();
    let bad = || "That event is not on the server.".to_string();
    let (calendar, event) = match key.split_once('~') {
        Some((encoded, event)) => {
            let bytes = URL_SAFE_NO_PAD.decode(encoded.as_bytes()).map_err(|_| bad())?;
            (String::from_utf8(bytes).map_err(|_| bad())?, event.to_string())
        }
        None => ("primary".to_string(), key.to_string()),
    };
    let ok_event = !event.is_empty() && event.len() <= 1024 && event.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
    let ok_calendar = !calendar.is_empty() && calendar.len() <= 256 && !calendar.chars().any(|c| c.is_control() || c.is_whitespace());
    if ok_event && ok_calendar { Ok((calendar, event)) } else { Err(bad()) }
}

fn refusal((status, why): (u16, String)) -> String {
    match status {
        401 | 403 => "Sign in again to change the calendar.".into(),
        404 | 410 => "That event is no longer on the calendar.".into(),
        0 => "Could not reach Google. Try again.".into(),
        _ if !why.is_empty() => format!("Google did not save the event: {why}"),
        _ => "Google did not save the event.".into(),
    }
}

fn utc(stamp: &str) -> Option<String> {
    google::secs_from_iso(stamp).map(google::iso_from_secs)
}

// ---- Reading ---------------------------------------------------------------

fn calendar_from(value: &Value) -> Option<LiveCalendar> {
    let id = value["id"].as_str()?.trim();
    if id.is_empty() || value["hidden"].as_bool().unwrap_or(false) || value["deleted"].as_bool().unwrap_or(false) {
        return None;
    }
    let name = value["summaryOverride"].as_str().or_else(|| value["summary"].as_str()).unwrap_or("").trim();
    let role = value["accessRole"].as_str().unwrap_or("reader");
    let primary = value["primary"].as_bool().unwrap_or(false);
    let owner = if primary || role == "owner" || !id.contains('@') || id.ends_with("calendar.google.com") {
        String::new()
    } else {
        id.to_string()
    };
    Some(LiveCalendar {
        id: id.to_string(),
        name: if name.is_empty() { "Calendar".into() } else { name.to_string() },
        color: colour_name(value["backgroundColor"].as_str().unwrap_or("")).to_string(),
        is_default: primary,
        teams: false,
        can_edit: role == "owner" || role == "writer",
        owner_name: String::new(),
        is_shared: !owner.is_empty(),
        owner,
    })
}

/// Google's calendar colour as the nearest of Outlook's colour names, which
/// the page maps onto its own palette.
pub fn colour_name(hex: &str) -> &'static str {
    let digits = hex.trim().trim_start_matches('#');
    let channel = |i: usize| digits.get(i..i + 2).and_then(|d| u8::from_str_radix(d, 16).ok()).map(|v| v as f64 / 255.0);
    let (Some(r), Some(g), Some(b)) = (channel(0), channel(2), channel(4)) else { return "" };
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let light = (max + min) / 2.0;
    let delta = max - min;
    if delta < 0.08 {
        return "lightGray";
    }
    let hue = if max == r {
        60.0 * (((g - b) / delta).rem_euclid(6.0))
    } else if max == g {
        60.0 * ((b - r) / delta + 2.0)
    } else {
        60.0 * ((r - g) / delta + 4.0)
    };
    match hue {
        h if !(15.0..345.0).contains(&h) => "lightRed",
        h if h < 40.0 => if light < 0.45 { "lightBrown" } else { "lightOrange" },
        h if h < 70.0 => "lightYellow",
        h if h < 160.0 => "lightGreen",
        h if h < 195.0 => "lightTeal",
        h if h < 255.0 => "lightBlue",
        h if h < 300.0 => "lightPurple",
        _ => "lightPink",
    }
}

fn default_reminder(value: &Value) -> i64 {
    value["defaultReminders"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["method"].as_str() == Some("popup"))
        .filter_map(|r| r["minutes"].as_i64())
        .min()
        .unwrap_or(-1)
}

fn status_word(raw: &str) -> String {
    match raw {
        "accepted" => "accepted",
        "tentative" => "tentative",
        "declined" => "declined",
        _ => "none",
    }
    .into()
}

/// An event from Google, in the page's shape. `fallback_reminder` is the
/// calendar's own default, for events that use it.
pub fn event_from(value: &Value, calendar_id: &str, fallback_reminder: i64) -> Option<LiveEvent> {
    if value["status"].as_str() == Some("cancelled") {
        return None;
    }
    let id = value["id"].as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let all_day = value["start"]["date"].is_string();
    let (start, end) = if all_day {
        (value["start"]["date"].as_str()?.to_string(), value["end"]["date"].as_str()?.to_string())
    } else {
        (utc(value["start"]["dateTime"].as_str()?)?, utc(value["end"]["dateTime"].as_str()?)?)
    };
    let attendees_raw: Vec<&Value> = value["attendees"].as_array().into_iter().flatten().filter(|a| !a["resource"].as_bool().unwrap_or(false)).collect();
    let me = attendees_raw.iter().find(|a| a["self"].as_bool().unwrap_or(false));
    let response = match me.and_then(|a| a["responseStatus"].as_str()) {
        Some("accepted") => "accepted",
        Some("tentative") => "tentative",
        Some("declined") => "declined",
        _ => "",
    };
    let attendees = attendees_raw
        .iter()
        .filter_map(|a| {
            let email = a["email"].as_str()?.trim();
            if email.is_empty() {
                return None;
            }
            let name = a["displayName"].as_str().unwrap_or("").trim();
            Some(LiveAttendee {
                name: if name.is_empty() { email.to_string() } else { name.to_string() },
                email: email.to_string(),
                status: status_word(a["responseStatus"].as_str().unwrap_or("")),
            })
        })
        .collect();
    let description = value["description"].as_str().unwrap_or("");
    let notes = if description.contains('<') { graph::html_to_text(description) } else { description.to_string() };
    let reminders = &value["reminders"];
    let reminder = if reminders["useDefault"].as_bool().unwrap_or(true) {
        fallback_reminder
    } else {
        reminders["overrides"].as_array().into_iter().flatten().filter_map(|r| r["minutes"].as_i64()).min().unwrap_or(-1)
    };
    let video = value["conferenceData"]["entryPoints"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["entryPointType"].as_str() == Some("video"))
        .and_then(|p| p["uri"].as_str());
    let join_url = value["hangoutLink"].as_str().or(video).filter(|url| url.starts_with("https://")).unwrap_or("").to_string();
    let master = value["recurringEventId"].as_str().unwrap_or("");
    let title = value["summary"].as_str().unwrap_or("").trim();
    Some(LiveEvent {
        id: event_key(calendar_id, id),
        calendar_id: calendar_id.to_string(),
        title: if title.is_empty() { "(No title)".into() } else { title.to_string() },
        start,
        end,
        all_day,
        show_as: if value["transparency"].as_str() == Some("transparent") {
            "free".into()
        } else if response == "tentative" {
            "tentative".into()
        } else {
            "busy".into()
        },
        location: value["location"].as_str().unwrap_or("").trim().to_string(),
        notes: notes.trim().chars().take(4000).collect(),
        organizer_name: value["organizer"]["displayName"].as_str().unwrap_or("").trim().to_string(),
        organizer_email: value["organizer"]["email"].as_str().unwrap_or("").trim().to_string(),
        attendees,
        response: response.into(),
        is_organizer: value["organizer"]["self"].as_bool().unwrap_or(attendees_raw.is_empty()),
        kind: if master.is_empty() { "singleInstance".into() } else { "occurrence".into() },
        series_master_id: if master.is_empty() { String::new() } else { event_key(calendar_id, master) },
        reminder: reminder.clamp(-1, 40320),
        join_url,
    })
}

fn pages(client: &reqwest::blocking::Client, token: &str, first: &str, key: &str, max_pages: usize) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let mut page_token = String::new();
    for _ in 0..max_pages {
        let url = if page_token.is_empty() { first.to_string() } else { format!("{first}&pageToken={}", seg(&page_token)) };
        let page = call(client, token, "GET", &url, None).map_err(|failure| match failure.0 {
            401 | 403 => "Sign in again to see the calendar.".to_string(),
            0 => "Could not reach Google.".to_string(),
            status => format!("Google refused the request ({status}). {}", failure.1),
        })?;
        out.extend(page[key].as_array().cloned().unwrap_or_default());
        page_token = page["nextPageToken"].as_str().unwrap_or("").to_string();
        if page_token.is_empty() {
            break;
        }
    }
    Ok(out)
}

pub fn fetch_calendar(email: &str, start: &str, end: &str) -> Result<(Vec<LiveCalendar>, Vec<LiveEvent>), String> {
    let (from, to) = (utc(start).ok_or("Choose a date.")?, utc(end).ok_or("Choose a date.")?);
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let listed = pages(&client, &token, &format!("{CAL}/users/me/calendarList?maxResults=250"), "items", 4)?;
    let mut entries: Vec<(LiveCalendar, i64)> = listed.iter().filter_map(|value| calendar_from(value).map(|c| (c, default_reminder(value)))).collect();
    entries.sort_by(|a, b| b.0.is_default.cmp(&a.0.is_default).then(a.0.name.to_lowercase().cmp(&b.0.name.to_lowercase())));
    entries.truncate(24);
    let mut events = Vec::new();
    for (calendar, fallback) in &entries {
        let url = format!(
            "{CAL}/calendars/{}/events?singleEvents=true&orderBy=startTime&maxResults=2500&timeMin={}&timeMax={}",
            seg(&calendar.id),
            seg(&from),
            seg(&to)
        );
        // A calendar shared with you can refuse its events; show the others.
        let Ok(items) = pages(&client, &token, &url, "items", 20) else { continue };
        events.extend(items.iter().filter_map(|item| event_from(item, &calendar.id, *fallback)));
    }
    Ok((entries.into_iter().map(|(calendar, _)| calendar).collect(), events))
}

// ---- Repeats ---------------------------------------------------------------

fn byday(name: &str) -> Option<&'static str> {
    WEEKDAYS.iter().find(|(long, _)| *long == name).map(|(_, short)| *short)
}

/// A Graph patternedRecurrence, already checked by calendar::clean_recurrence,
/// as Google's RRULE.
pub fn rrule_from(recurrence: &Value) -> Result<String, String> {
    let bad = || "That repeat setting is not valid.".to_string();
    let pattern = &recurrence["pattern"];
    let range = &recurrence["range"];
    let interval = pattern["interval"].as_u64().unwrap_or(1).clamp(1, 99);
    let days = || -> Result<String, String> {
        let list: Vec<&str> = pattern["daysOfWeek"].as_array().ok_or_else(bad)?.iter().filter_map(|d| d.as_str()).filter_map(byday).collect();
        if list.is_empty() { Err(bad()) } else { Ok(list.join(",")) }
    };
    let index = || -> Result<i32, String> {
        let name = pattern["index"].as_str().ok_or_else(bad)?;
        INDEXES.iter().find(|(n, _)| *n == name).map(|(_, i)| *i).ok_or_else(bad)
    };
    let mut rule = match pattern["type"].as_str().ok_or_else(bad)? {
        "daily" => format!("FREQ=DAILY;INTERVAL={interval}"),
        "weekly" => format!("FREQ=WEEKLY;INTERVAL={interval};BYDAY={}", days()?),
        "absoluteMonthly" => format!("FREQ=MONTHLY;INTERVAL={interval};BYMONTHDAY={}", pattern["dayOfMonth"].as_u64().ok_or_else(bad)?),
        "relativeMonthly" => format!("FREQ=MONTHLY;INTERVAL={interval};BYDAY={};BYSETPOS={}", days()?, index()?),
        "absoluteYearly" => format!(
            "FREQ=YEARLY;INTERVAL={interval};BYMONTH={};BYMONTHDAY={}",
            pattern["month"].as_u64().ok_or_else(bad)?,
            pattern["dayOfMonth"].as_u64().ok_or_else(bad)?
        ),
        "relativeYearly" => format!(
            "FREQ=YEARLY;INTERVAL={interval};BYMONTH={};BYDAY={};BYSETPOS={}",
            pattern["month"].as_u64().ok_or_else(bad)?,
            days()?,
            index()?
        ),
        _ => return Err(bad()),
    };
    match range["type"].as_str().unwrap_or("noEnd") {
        "endDate" => {
            let end = range["endDate"].as_str().filter(|d| d.len() == 10).ok_or_else(bad)?;
            rule.push_str(&format!(";UNTIL={}", end.replace('-', "")));
        }
        "numbered" => rule.push_str(&format!(";COUNT={}", range["numberOfOccurrences"].as_u64().ok_or_else(bad)?)),
        _ => {}
    }
    Ok(format!("RRULE:{rule}"))
}

fn weekday_of(date: &str) -> &'static str {
    let secs = google::secs_from_iso(date.get(..10).unwrap_or(date)).unwrap_or(0);
    let days = secs.div_euclid(86400);
    WEEKDAYS[(days + 4).rem_euclid(7) as usize].0
}

/// Google's RRULE back as a Graph patternedRecurrence, starting on the
/// series' first (local) date.
pub fn recurrence_from(rules: &[Value], start_date: &str) -> Value {
    let Some(rule) = rules.iter().filter_map(|r| r.as_str()).find_map(|r| r.strip_prefix("RRULE:")) else {
        return Value::Null;
    };
    let mut parts = std::collections::HashMap::new();
    for piece in rule.split(';') {
        if let Some((key, value)) = piece.split_once('=') {
            parts.insert(key.to_ascii_uppercase(), value.to_string());
        }
    }
    let get = |key: &str| parts.get(key).cloned().unwrap_or_default();
    let interval: u64 = get("INTERVAL").parse().unwrap_or(1);
    let mut set_pos: Option<i32> = get("BYSETPOS").parse().ok();
    let mut days = Vec::new();
    for day in get("BYDAY").split(',').filter(|d| !d.is_empty()) {
        // The weekday is the last two letters; a cut inside a non-ASCII
        // character is not a day Google writes.
        let cut = day.len().saturating_sub(2);
        let (Some(number), Some(short)) = (day.get(..cut), day.get(cut..)) else { continue };
        if let Ok(n) = number.parse::<i32>() {
            set_pos = Some(n);
        }
        if let Some((long, _)) = WEEKDAYS.iter().find(|(_, s)| *s == short) {
            days.push(*long);
        }
    }
    let index = set_pos.and_then(|n| INDEXES.iter().find(|(_, i)| *i == n).map(|(name, _)| *name));
    let start_day: u64 = start_date.get(8..10).and_then(|d| d.parse().ok()).unwrap_or(1);
    let start_month: u64 = start_date.get(5..7).and_then(|d| d.parse().ok()).unwrap_or(1);
    let day_of_month: u64 = get("BYMONTHDAY").parse().unwrap_or(start_day);
    let month: u64 = get("BYMONTH").parse().unwrap_or(start_month);
    let pattern = match get("FREQ").as_str() {
        "DAILY" => json!({ "type": "daily", "interval": interval }),
        "WEEKLY" => {
            let list = if days.is_empty() { vec![weekday_of(start_date)] } else { days.clone() };
            json!({ "type": "weekly", "interval": interval, "daysOfWeek": list, "firstDayOfWeek": "monday" })
        }
        "MONTHLY" => match index {
            Some(index) if !days.is_empty() => json!({ "type": "relativeMonthly", "interval": interval, "daysOfWeek": days, "index": index }),
            _ => json!({ "type": "absoluteMonthly", "interval": interval, "dayOfMonth": day_of_month }),
        },
        "YEARLY" => match index {
            Some(index) if !days.is_empty() => json!({ "type": "relativeYearly", "interval": interval, "daysOfWeek": days, "index": index, "month": month }),
            _ => json!({ "type": "absoluteYearly", "interval": interval, "dayOfMonth": day_of_month, "month": month }),
        },
        _ => return Value::Null,
    };
    let start = start_date.get(..10).unwrap_or(start_date);
    let until = get("UNTIL");
    let range = if let Ok(count) = get("COUNT").parse::<u64>() {
        json!({ "type": "numbered", "startDate": start, "numberOfOccurrences": count })
    } else if let (Some(y), Some(m), Some(d)) = (until.get(0..4), until.get(4..6), until.get(6..8)) {
        json!({ "type": "endDate", "startDate": start, "endDate": format!("{y}-{m}-{d}") })
    } else {
        json!({ "type": "noEnd", "startDate": start })
    };
    json!({ "pattern": pattern, "range": range })
}

// ---- Writing ---------------------------------------------------------------

/// The JSON Google gets for an event. Only what the page sent is set, as
/// for Microsoft, so an edit doesn't invite everyone again.
pub fn event_body(fields: &EventFields) -> Result<Value, String> {
    // The same checks as for Microsoft: title, times, attendees, repeat.
    let graph_body = calendar::event_body(fields)?;
    let when = |stamp: &str| {
        if fields.all_day {
            json!({ "date": &stamp[..10] })
        } else {
            json!({ "dateTime": stamp, "timeZone": fields.time_zone })
        }
    };
    let mut body = json!({
        "summary": fields.subject.trim(),
        "location": fields.location.trim(),
        "start": when(&fields.start),
        "end": when(&fields.end),
        "transparency": if fields.show_as.trim() == "free" { "transparent" } else { "opaque" },
    });
    if let Some(notes) = &fields.notes {
        body["description"] = json!(notes.chars().take(30_000).collect::<String>());
    }
    if let Some(people) = &fields.attendees {
        body["attendees"] = Value::Array(
            people
                .iter()
                .filter(|p| !p.email.trim().is_empty())
                .map(|p| {
                    let mut item = json!({ "email": p.email.trim() });
                    if !p.name.trim().is_empty() {
                        item["displayName"] = json!(p.name.trim());
                    }
                    item
                })
                .collect(),
        );
    }
    if let Some(minutes) = fields.reminder {
        body["reminders"] = if minutes < 0 {
            json!({ "useDefault": false, "overrides": [] })
        } else {
            json!({ "useDefault": false, "overrides": [{ "method": "popup", "minutes": minutes.min(40320) }] })
        };
    }
    if fields.recurrence.is_some() {
        body["recurrence"] = match &graph_body["recurrence"] {
            Value::Null => json!([]),
            cleaned => json!([rrule_from(cleaned)?]),
        };
    }
    Ok(body)
}

/// Create an event, or change one, and return the page's id for it.
pub fn save_event(email: &str, event_id: &str, calendar_id: &str, fields: &EventFields) -> Result<String, String> {
    let body = event_body(fields)?;
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    if event_id.trim().is_empty() {
        let calendar = if calendar_id.trim().is_empty() { "primary".to_string() } else { calendar_id.trim().to_string() };
        let url = format!("{CAL}/calendars/{}/events?sendUpdates=all", seg(&calendar));
        let saved = call(&client, &token, "POST", &url, Some(&body)).map_err(refusal)?;
        let id = saved["id"].as_str().ok_or("Google did not return the event.")?;
        return Ok(event_key(&calendar, id));
    }
    let (calendar, id) = split_key(event_id)?;
    let url = format!("{CAL}/calendars/{}/events/{}?sendUpdates=all", seg(&calendar), seg(&id));
    call(&client, &token, "PATCH", &url, Some(&body)).map_err(refusal)?;
    Ok(event_key(&calendar, &id))
}

/// Answer an invitation: accepted, tentative or declined.
pub fn respond(email: &str, event_id: &str, response: &str) -> Result<(), String> {
    let status = match response.trim() {
        "accepted" => "accepted",
        "tentative" => "tentative",
        "declined" => "declined",
        _ => return Err("Choose Accept, Tentative or Decline.".into()),
    };
    let (calendar, id) = split_key(event_id)?;
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let url = format!("{CAL}/calendars/{}/events/{}", seg(&calendar), seg(&id));
    let event = call(&client, &token, "GET", &url, None).map_err(answer_refusal)?;
    let mut attendees = event["attendees"].as_array().cloned().unwrap_or_default();
    let mut found = false;
    for attendee in attendees.iter_mut() {
        let mine = attendee["self"].as_bool().unwrap_or(false) || attendee["email"].as_str().is_some_and(|a| a.eq_ignore_ascii_case(email.trim()));
        if mine {
            attendee["responseStatus"] = json!(status);
            found = true;
        }
    }
    if !found {
        return Err("You are not on that meeting's guest list.".into());
    }
    let mine_email = attendees
        .iter()
        .find(|attendee| is_self(attendee, email))
        .and_then(|attendee| attendee["email"].as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let organizer = event["organizer"]["self"].as_bool().unwrap_or(false);
    let patch = |body: &Value| call(&client, &token, "PATCH", &format!("{url}?sendUpdates=all"), Some(body));
    // Guests are allowed to change their own answer. Sending every guest is
    // refused for them, and sending only themselves would drop the others
    // from an event they organise, so the organiser keeps the whole list.
    let full = json!({ "attendees": attendees });
    match patch(&full) {
        Ok(_) => Ok(()),
        Err((400 | 403, _)) if !organizer && !mine_email.is_empty() => {
            let only = json!({ "attendees": [{ "email": mine_email, "responseStatus": status }] });
            patch(&only).map(|_| ()).map_err(answer_refusal)
        }
        Err(failure) => Err(answer_refusal(failure)),
    }
}

fn is_self(attendee: &Value, email: &str) -> bool {
    attendee["self"].as_bool().unwrap_or(false) || attendee["email"].as_str().is_some_and(|a| a.eq_ignore_ascii_case(email.trim()))
}

fn answer_refusal(failure: (u16, String)) -> String {
    match failure.0 {
        401 | 403 => "Sign in again to answer invites.".into(),
        404 | 410 => "That meeting is no longer on the calendar.".into(),
        0 => "Could not reach Google. Try again.".into(),
        _ => "Google did not take the answer. Try again.".into(),
    }
}

// ---- Invites opened from Gmail ---------------------------------------------

/// One time from an iCalendar property.
#[derive(Clone, Debug, PartialEq)]
enum IcsWhen {
    /// `YYYY-MM-DD`. The end date is exclusive, as in both iCalendar and Google.
    Date(String),
    /// `YYYY-MM-DDTHH:MM:SSZ`.
    Utc(String),
    /// A local clock time plus the TZID, which Google accepts as `timeZone`.
    Zoned { local: String, tz: String },
}

struct ParsedIcs {
    method: String,
    uid: String,
    summary: String,
    location: String,
    status: String,
    start: Option<IcsWhen>,
    end: Option<IcsWhen>,
    recurrence_id: Option<IcsWhen>,
    rrule: String,
    organizer: String,
    /// (email, PARTSTAT). PARTSTAT is whatever the invite wrote, often empty.
    attendees: Vec<(String, String)>,
}

fn unfold_ics(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' && chars.peek() == Some(&'\n') {
            chars.next();
            if matches!(chars.peek(), Some(' ' | '\t')) {
                chars.next();
                continue;
            }
            out.push('\n');
            continue;
        }
        if c == '\n' && matches!(chars.peek(), Some(' ' | '\t')) {
            chars.next();
            continue;
        }
        out.push(c);
    }
    out
}

fn unescape_ics(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n' | 'N') => out.push('\n'),
                Some(other) => out.push(other),
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

struct IcsProp {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

fn parse_ics_line(line: &str) -> Option<IcsProp> {
    let mut quoted = false;
    let mut cut = None;
    for (i, c) in line.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ':' if !quoted => {
                cut = Some(i);
                break;
            }
            _ => {}
        }
    }
    let cut = cut?;
    let left = &line[..cut];
    let value = unescape_ics(line[cut + 1..].trim());
    let mut pieces = Vec::new();
    let mut current = String::new();
    quoted = false;
    for c in left.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                current.push(c);
            }
            ';' if !quoted => pieces.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    pieces.push(current);
    let name = pieces.first()?.trim().to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    let mut params = Vec::new();
    for piece in pieces.iter().skip(1) {
        let Some((key, raw)) = piece.split_once('=') else { continue };
        let raw = raw.trim();
        let raw = raw.strip_prefix('"').and_then(|r| r.strip_suffix('"')).unwrap_or(raw);
        params.push((key.trim().to_ascii_uppercase(), unescape_ics(raw)));
    }
    Some(IcsProp { name, params, value })
}

fn ics_param<'a>(params: &'a [(String, String)], name: &str) -> &'a str {
    params.iter().find(|(key, _)| key == name).map(|(_, value)| value.as_str()).unwrap_or("")
}

fn ics_email(value: &str) -> String {
    let value = value.trim();
    // `get`, not `[..7]`: an invite's address can be any text, and a
    // multi-byte character across byte 7 must not panic.
    let rest = match value.get(..7) {
        Some(head) if head.eq_ignore_ascii_case("mailto:") => &value[7..],
        _ => value,
    };
    let email = rest.trim();
    if email.len() > 320 || !email.contains('@') || email.chars().any(|c| c.is_control() || c.is_whitespace()) {
        String::new()
    } else {
        email.to_string()
    }
}

fn basic_date(value: &str) -> Option<String> {
    let value = value.trim();
    if value.len() < 8 || !value.as_bytes()[..8].iter().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(format!("{}-{}-{}", &value[0..4], &value[4..6], &value[6..8]))
}

fn basic_clock(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches('Z');
    // The first 15 bytes must be ASCII before they are sliced: an invite's
    // DTSTART is untrusted text, and a multi-byte character would panic.
    if !value.get(..15).is_some_and(|head| head.is_ascii()) || value.as_bytes()[8] != b'T' {
        return None;
    }
    let seconds = &value[13..15];
    let parts = [&value[0..4], &value[4..6], &value[6..8], &value[9..11], &value[11..13], seconds];
    if parts.iter().any(|part| !part.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    Some(format!("{}-{}-{}T{}:{}:{seconds}", &value[0..4], &value[4..6], &value[6..8], &value[9..11], &value[11..13]))
}

fn when_from(params: &[(String, String)], value: &str) -> Option<IcsWhen> {
    let value = value.trim();
    let date_only = ics_param(params, "VALUE").eq_ignore_ascii_case("DATE") || (value.len() == 8 && value.bytes().all(|b| b.is_ascii_digit()));
    if date_only {
        return Some(IcsWhen::Date(basic_date(value)?));
    }
    let local = basic_clock(value)?;
    if value.ends_with('Z') {
        return Some(IcsWhen::Utc(format!("{local}Z")));
    }
    let tz = ics_param(params, "TZID");
    if tz.is_empty() {
        Some(IcsWhen::Utc(format!("{local}Z")))
    } else {
        Some(IcsWhen::Zoned { local, tz: tz.to_string() })
    }
}

fn day_shift(date: &str, days: i64) -> Option<String> {
    let secs = google::secs_from_iso(date)? + days * 86400;
    Some(google::iso_from_secs(secs)[..10].to_string())
}

/// A reply to an invite, or a request to refresh one, is not something to answer.
fn actionable_method(method: &str) -> bool {
    !matches!(method.trim().to_ascii_uppercase().as_str(), "REPLY" | "COUNTER" | "REFRESH")
}

fn parse_ics(raw: &str) -> Option<ParsedIcs> {
    let unfolded = unfold_ics(raw);
    let mut method = String::new();
    let mut uid = String::new();
    let mut summary = String::new();
    let mut location = String::new();
    let mut status = String::new();
    let mut start = None;
    let mut end = None;
    let mut recurrence_id = None;
    let mut rrule = String::new();
    let mut organizer = String::new();
    let mut attendees = Vec::new();
    let mut skip = 0_u32;
    let mut in_event = false;
    let mut saw_event = false;
    for line in unfolded.lines() {
        let line = line.trim_end_matches('\r').trim_end();
        if line.is_empty() {
            continue;
        }
        let Some(prop) = parse_ics_line(line) else { continue };
        if skip > 0 {
            if prop.name == "BEGIN" {
                skip += 1;
            } else if prop.name == "END" {
                skip -= 1;
            }
            continue;
        }
        if prop.name == "BEGIN" {
            match prop.value.to_ascii_uppercase().as_str() {
                "VEVENT" if !saw_event => {
                    in_event = true;
                    saw_event = true;
                }
                "VCALENDAR" => {}
                _ => skip = 1,
            }
            continue;
        }
        if prop.name == "END" {
            if prop.value.eq_ignore_ascii_case("VEVENT") {
                in_event = false;
            }
            continue;
        }
        if !in_event {
            if prop.name == "METHOD" {
                method = prop.value;
            }
            continue;
        }
        match prop.name.as_str() {
            "UID" => {
                let clean = prop.value.trim();
                if !clean.is_empty() && clean.len() <= 1024 && !clean.chars().any(|c| c.is_control() || c.is_whitespace()) {
                    uid = clean.to_string();
                }
            }
            "SUMMARY" => summary = prop.value.chars().take(500).collect(),
            "LOCATION" => location = prop.value.chars().take(500).collect(),
            "STATUS" => status = prop.value,
            "RRULE" => rrule = prop.value.chars().take(500).collect(),
            "DTSTART" => start = when_from(&prop.params, &prop.value),
            "DTEND" => end = when_from(&prop.params, &prop.value),
            "RECURRENCE-ID" => recurrence_id = when_from(&prop.params, &prop.value),
            "ORGANIZER" => organizer = ics_email(&prop.value),
            "ATTENDEE" => {
                let email = ics_email(&prop.value);
                if !email.is_empty() {
                    attendees.push((email, ics_param(&prop.params, "PARTSTAT").to_string()));
                }
            }
            _ => {}
        }
    }
    if uid.is_empty() {
        return None;
    }
    Some(ParsedIcs { method, uid, summary, location, status, start, end, recurrence_id, rrule, organizer, attendees })
}

fn when_text(when: &IcsWhen) -> String {
    match when {
        IcsWhen::Date(date) | IcsWhen::Utc(date) => date.clone(),
        // No zone conversion. The page reads a zone-less stamp as local time,
        // which is the clock the invite stated.
        IcsWhen::Zoned { local, .. } => local.clone(),
    }
}

fn google_partstat(partstat: &str) -> &'static str {
    match partstat.trim().to_ascii_uppercase().as_str() {
        "ACCEPTED" => "accepted",
        "TENTATIVE" => "tentative",
        "DECLINED" => "declined",
        _ => "needsAction",
    }
}

fn app_partstat(partstat: &str) -> &'static str {
    match partstat.trim().to_ascii_uppercase().as_str() {
        "ACCEPTED" => "accepted",
        "TENTATIVE" => "tentative",
        "DECLINED" => "declined",
        _ => "",
    }
}

fn lookup_refusal(failure: (u16, String)) -> String {
    match failure.0 {
        401 | 403 => "Sign in again to answer invites.".into(),
        0 => "Could not reach Google. Try again.".into(),
        _ => "Google did not open that invite. Try again.".into(),
    }
}

fn google_response(raw: &str) -> &'static str {
    match raw {
        "accepted" => "accepted",
        "tentative" => "tentative",
        "declined" => "declined",
        _ => "",
    }
}

fn google_when(when: &IcsWhen) -> Value {
    match when {
        IcsWhen::Date(date) => json!({ "date": date }),
        IcsWhen::Utc(stamp) => json!({ "dateTime": stamp }),
        IcsWhen::Zoned { local, tz } => json!({ "dateTime": local, "timeZone": tz }),
    }
}

fn default_end(start: &IcsWhen) -> IcsWhen {
    match start {
        IcsWhen::Date(date) => IcsWhen::Date(day_shift(date, 1).unwrap_or_else(|| date.clone())),
        IcsWhen::Utc(stamp) => {
            let next = google::secs_from_iso(stamp).map(|secs| google::iso_from_secs(secs + 3600)).unwrap_or_else(|| stamp.clone());
            IcsWhen::Utc(next)
        }
        IcsWhen::Zoned { local, tz } => {
            let next = google::secs_from_iso(local)
                .map(|secs| google::iso_from_secs(secs + 3600).trim_end_matches('Z').to_string())
                .unwrap_or_else(|| local.clone());
            IcsWhen::Zoned { local: next, tz: tz.clone() }
        }
    }
}

/// An id the page can hold when the meeting is not on the calendar (a
/// cancellation that was never added). It is not a Google event id.
fn fallback_event_id(uid: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(uid.as_bytes());
    let id: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    event_key("primary", &id)
}

fn invite_from_ics(parsed: &ParsedIcs, email: &str) -> compose::Invite {
    let (start, end, all_day) = match &parsed.start {
        Some(IcsWhen::Date(date)) => {
            let end = match &parsed.end {
                Some(IcsWhen::Date(end)) => end.clone(),
                _ => day_shift(date, 1).unwrap_or_else(|| date.clone()),
            };
            (date.clone(), end, true)
        }
        Some(when) => {
            let end = parsed.end.as_ref().map(when_text).unwrap_or_else(|| when_text(when));
            (when_text(when), end, false)
        }
        None => (String::new(), String::new(), false),
    };
    let response = parsed
        .attendees
        .iter()
        .find(|(addr, _)| addr.eq_ignore_ascii_case(email.trim()))
        .map(|(_, partstat)| app_partstat(partstat))
        .unwrap_or("");
    compose::Invite {
        event_id: fallback_event_id(&parsed.uid),
        subject: if parsed.summary.is_empty() { "(No title)".into() } else { parsed.summary.clone() },
        start,
        end,
        all_day,
        location: parsed.location.clone(),
        response: response.into(),
        cancelled: parsed.method.eq_ignore_ascii_case("CANCEL") || parsed.status.eq_ignore_ascii_case("CANCELLED"),
        organizer: !parsed.organizer.is_empty() && parsed.organizer.eq_ignore_ascii_case(email.trim()),
    }
}

fn invite_from_google(value: &Value, calendar_id: &str, email: &str) -> Option<compose::Invite> {
    let id = value["id"].as_str()?.trim();
    if id.is_empty() {
        return None;
    }
    let cancelled = value["status"].as_str() == Some("cancelled");
    let all_day = value["start"]["date"].is_string();
    let (start, end) = if all_day {
        (value["start"]["date"].as_str().unwrap_or("").to_string(), value["end"]["date"].as_str().unwrap_or("").to_string())
    } else {
        match (value["start"]["dateTime"].as_str().and_then(utc), value["end"]["dateTime"].as_str().and_then(utc)) {
            (Some(start), Some(end)) => (start, end),
            _ if cancelled => (String::new(), String::new()),
            _ => return None,
        }
    };
    let me = value["attendees"].as_array().into_iter().flatten().find(|attendee| is_self(attendee, email));
    let response = google_response(me.and_then(|attendee| attendee["responseStatus"].as_str()).unwrap_or(""));
    let organizer = value["organizer"]["self"].as_bool().unwrap_or(false)
        || value["organizer"]["email"].as_str().is_some_and(|addr| addr.eq_ignore_ascii_case(email.trim()));
    let title = value["summary"].as_str().unwrap_or("").trim();
    Some(compose::Invite {
        event_id: event_key(calendar_id, id),
        subject: if title.is_empty() { "(No title)".into() } else { title.to_string() },
        start,
        end,
        all_day,
        location: value["location"].as_str().unwrap_or("").trim().to_string(),
        response: response.into(),
        cancelled,
        organizer,
    })
}

fn list_by_uid(client: &reqwest::blocking::Client, token: &str, calendar_id: &str, uid: &str) -> Result<Option<Value>, String> {
    let url = format!(
        "{CAL}/calendars/{}/events?iCalUID={}&showDeleted=true&showHiddenInvitations=true&maxResults=20",
        seg(calendar_id),
        seg(uid)
    );
    let page = match call(client, token, "GET", &url, None) {
        Ok(page) => page,
        Err((404 | 410, _)) => return Ok(None),
        Err(failure) => return Err(lookup_refusal(failure)),
    };
    let items = page["items"].as_array().cloned().unwrap_or_default();
    let master = |value: &Value| value["recurringEventId"].as_str().unwrap_or("").is_empty();
    let live = |value: &Value| value["status"].as_str() != Some("cancelled");
    Ok(items
        .iter()
        .find(|value| master(value) && live(value))
        .or_else(|| items.iter().find(|value| live(value)))
        .or_else(|| items.first())
        .cloned())
}

fn writable_calendars(client: &reqwest::blocking::Client, token: &str) -> Result<Vec<String>, String> {
    let url = format!("{CAL}/users/me/calendarList?maxResults=250&minAccessRole=writer");
    let page = match call(client, token, "GET", &url, None) {
        Ok(page) => page,
        Err((401 | 403, _)) => return Err("Sign in again to answer invites.".into()),
        Err((0, _)) => return Err("Could not reach Google. Try again.".into()),
        Err(_) => return Ok(Vec::new()),
    };
    let mut ids = Vec::new();
    for item in page["items"].as_array().into_iter().flatten() {
        if item["primary"].as_bool().unwrap_or(false) {
            continue;
        }
        let Some(id) = item["id"].as_str().map(str::trim).filter(|id| !id.is_empty()) else { continue };
        ids.push(id.to_string());
        if ids.len() == 8 {
            break;
        }
    }
    Ok(ids)
}

fn find_invite(client: &reqwest::blocking::Client, token: &str, uid: &str) -> Result<Option<(String, Value)>, String> {
    if let Some(event) = list_by_uid(client, token, "primary", uid)? {
        return Ok(Some(("primary".into(), event)));
    }
    for calendar_id in writable_calendars(client, token)? {
        if let Some(event) = list_by_uid(client, token, &calendar_id, uid)? {
            return Ok(Some((calendar_id, event)));
        }
    }
    Ok(None)
}

/// `{master}_{YYYYMMDDTHHMMSSZ}` or `{master}_{YYYYMMDD}`, which is how
/// Google names one occurrence. A zoned recurrence id has no UTC suffix here.
fn instance_suffix(when: &IcsWhen) -> Option<String> {
    match when {
        IcsWhen::Utc(stamp) if stamp.len() >= 20 => {
            Some(format!("{}{}{}T{}{}{}Z", &stamp[0..4], &stamp[5..7], &stamp[8..10], &stamp[11..13], &stamp[14..16], &stamp[17..19]))
        }
        IcsWhen::Date(date) if date.len() >= 10 => Some(format!("{}{}{}", &date[0..4], &date[5..7], &date[8..10])),
        _ => None,
    }
}

fn same_when(event: &Value, when: &IcsWhen) -> bool {
    let start = if event["originalStartTime"].is_object() { &event["originalStartTime"] } else { &event["start"] };
    match when {
        IcsWhen::Date(date) => start["date"].as_str() == Some(date.as_str()),
        IcsWhen::Utc(stamp) => start["dateTime"].as_str().and_then(google::secs_from_iso) == google::secs_from_iso(stamp),
        IcsWhen::Zoned { local, tz } => {
            let zone_ok = start["timeZone"].as_str().map(|zone| zone == tz).unwrap_or(true);
            let clock = start["dateTime"].as_str().unwrap_or("");
            zone_ok && (clock.starts_with(local.as_str()) || google::secs_from_iso(clock) == google::secs_from_iso(local))
        }
    }
}

fn instance_window(when: &IcsWhen) -> Option<(String, String)> {
    let day = match when {
        IcsWhen::Date(date) => date.clone(),
        IcsWhen::Utc(stamp) | IcsWhen::Zoned { local: stamp, .. } => stamp.get(..10)?.to_string(),
    };
    let from = day_shift(&day, -1)?;
    let to = day_shift(&day, 2)?;
    Some((format!("{from}T00:00:00Z"), format!("{to}T00:00:00Z")))
}

fn resolve_instance(client: &reqwest::blocking::Client, token: &str, calendar_id: &str, event: Value, parsed: &ParsedIcs) -> Result<Value, String> {
    let Some(when) = &parsed.recurrence_id else { return Ok(event) };
    if event["recurringEventId"].is_string() && same_when(&event, when) {
        return Ok(event);
    }
    let master = event["recurringEventId"].as_str().filter(|id| !id.is_empty()).or_else(|| event["id"].as_str()).unwrap_or("");
    if master.is_empty() {
        return Ok(event);
    }
    if let Some(suffix) = instance_suffix(when) {
        let url = format!("{CAL}/calendars/{}/events/{}", seg(calendar_id), seg(&format!("{master}_{suffix}")));
        match call(client, token, "GET", &url, None) {
            Ok(value) if value["id"].as_str().is_some() => return Ok(value),
            Err((404 | 410, _)) => {}
            Err(failure) => return Err(lookup_refusal(failure)),
            Ok(_) => {}
        }
    }
    if let Some((from, to)) = instance_window(when) {
        let url = format!(
            "{CAL}/calendars/{}/events/{}/instances?timeMin={}&timeMax={}&showDeleted=true&maxResults=20",
            seg(calendar_id),
            seg(master),
            seg(&from),
            seg(&to)
        );
        if let Ok(page) = call(client, token, "GET", &url, None) {
            if let Some(found) = page["items"].as_array().and_then(|items| items.iter().find(|item| same_when(item, when)).cloned()) {
                return Ok(found);
            }
        }
    }
    // The occurrence could not be picked out, so the answer goes to the series.
    Ok(event)
}

fn import_refusal(failure: (u16, String)) -> String {
    match failure.0 {
        401 | 403 => "Sign in again to answer invites.".into(),
        0 => "Could not reach Google. Try again.".into(),
        409 => "That meeting is already on your calendar, but Mailroom could not match it.".into(),
        _ => "Google did not add that meeting to your calendar.".into(),
    }
}

/// Put a copy of the invite on the primary calendar so the answer has an
/// event to land on. Import sends no mail; Accept sends the reply.
fn import_invite(client: &reqwest::blocking::Client, token: &str, email: &str, parsed: &ParsedIcs) -> Result<Value, String> {
    let Some(start) = &parsed.start else {
        return Err("That invite has no time, so it cannot be added to the calendar.".into());
    };
    // Without an organiser the copy would be yours to organise, and later
    // changes would go to the guests the sender listed.
    if parsed.organizer.trim().is_empty() || parsed.organizer.eq_ignore_ascii_case(email.trim()) {
        return Err("That invite has no organiser, so it cannot be answered from here.".into());
    }
    let end = parsed.end.clone().unwrap_or_else(|| default_end(start));
    let mut attendees = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for (addr, partstat) in &parsed.attendees {
        if !seen.insert(addr.to_ascii_lowercase()) {
            continue;
        }
        attendees.push(json!({ "email": addr, "responseStatus": google_partstat(partstat) }));
    }
    let me = email.trim();
    if !me.is_empty() && seen.insert(me.to_ascii_lowercase()) {
        attendees.push(json!({ "email": me, "responseStatus": "needsAction" }));
    }
    let summary: &str = if parsed.summary.is_empty() { "(No title)" } else { &parsed.summary };
    let mut body = json!({
        "iCalUID": parsed.uid,
        "summary": summary,
        "location": parsed.location,
        "start": google_when(start),
        "end": google_when(&end),
        "attendees": attendees,
        "status": if parsed.status.eq_ignore_ascii_case("CANCELLED") { "cancelled" } else { "confirmed" },
    });
    if !parsed.organizer.is_empty() {
        body["organizer"] = json!({ "email": parsed.organizer });
    }
    if parsed.recurrence_id.is_none() && !parsed.rrule.is_empty() {
        let rule = parsed.rrule.trim().trim_start_matches("RRULE:");
        body["recurrence"] = json!([format!("RRULE:{rule}")]);
    }
    let url = format!("{CAL}/calendars/primary/events/import");
    match call(client, token, "POST", &url, Some(&body)) {
        Ok(value) => Ok(value),
        // Organiser or repeat lines from another calendar are sometimes refused.
        // The meeting itself is enough to record an answer. Without the
        // organiser the copy is yours, so it keeps no one else's address:
        // a later change must not mail the sender's guest list.
        Err((400, _)) => {
            if let Some(obj) = body.as_object_mut() {
                obj.remove("organizer");
                obj.remove("recurrence");
                obj.insert("attendees".into(), json!([{ "email": me, "responseStatus": "needsAction" }]));
            }
            call(client, token, "POST", &url, Some(&body)).map_err(import_refusal)
        }
        Err(failure) => Err(import_refusal(failure)),
    }
}

/// The meeting behind a Gmail message, when the message is an invite.
/// The event id is the page's id, so Accept goes through `respond`.
pub fn invite_for(email: &str, message_id: &str) -> Result<Option<compose::Invite>, String> {
    let Some(ics) = google::message_calendar(email, message_id)? else { return Ok(None) };
    let Some(parsed) = parse_ics(&ics) else { return Ok(None) };
    if !actionable_method(&parsed.method) {
        return Ok(None);
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    if let Some((calendar_id, event)) = find_invite(&client, &token, &parsed.uid)? {
        let event = resolve_instance(&client, &token, &calendar_id, event, &parsed)?;
        return Ok(invite_from_google(&event, &calendar_id, email));
    }
    // Not on the calendar yet. Show it, but write nothing until you answer:
    // anyone can send an invite, and looking at mail must not add events.
    let mut invite = invite_from_ics(&parsed, email);
    if !invite.cancelled {
        invite.event_id = pending_key(message_id);
    }
    Ok(Some(invite))
}

/// The event id given to an invite that is only in a message so far.
/// `split_key` refuses it, so nothing can act on it as a calendar event.
fn pending_key(message_id: &str) -> String {
    format!("{PENDING}{message_id}")
}

const PENDING: &str = "ics:";

pub fn is_pending(event_id: &str) -> bool {
    event_id.trim().starts_with(PENDING)
}

/// Answer an invite that is not on the calendar yet: you chose to, so add
/// it to the primary calendar now, then record the answer.
pub fn respond_pending(email: &str, event_id: &str, response: &str) -> Result<(), String> {
    let message_id = event_id.trim().strip_prefix(PENDING).unwrap_or_default();
    let missing = || "That invite is no longer in the message.".to_string();
    let Some(ics) = google::message_calendar(email, message_id)? else { return Err(missing()) };
    let Some(parsed) = parse_ics(&ics) else { return Err(missing()) };
    if !actionable_method(&parsed.method) || parsed.method.eq_ignore_ascii_case("CANCEL") || parsed.status.eq_ignore_ascii_case("CANCELLED") {
        return Err("That meeting was cancelled.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let key = if let Some((calendar_id, event)) = find_invite(&client, &token, &parsed.uid)? {
        let event = resolve_instance(&client, &token, &calendar_id, event, &parsed)?;
        invite_from_google(&event, &calendar_id, email).map(|invite| invite.event_id)
    } else {
        let event = import_invite(&client, &token, email, &parsed)?;
        invite_from_google(&event, "primary", email).map(|invite| invite.event_id)
    };
    let key = key.ok_or_else(|| "Google did not add that meeting to your calendar.".to_string())?;
    respond(email, &key, response)
}

/// Cancel your meeting for everyone, decline an invitation, or delete.
pub fn remove_event(email: &str, event_id: &str, how: &str) -> Result<(), String> {
    let (calendar, id) = split_key(event_id)?;
    if how == "decline" {
        respond(email, event_id, "declined")?;
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let tell = if how == "cancel" { "all" } else { "none" };
    let url = format!("{CAL}/calendars/{}/events/{}?sendUpdates={tell}", seg(&calendar), seg(&id));
    match call(&client, &token, "DELETE", &url, None) {
        Ok(_) | Err((404, _)) | Err((410, _)) => Ok(()),
        // An invitation you declined may not be yours to delete; it stays, declined.
        Err((403, _)) if how == "decline" => Ok(()),
        Err(failure) => Err(refusal(failure)),
    }
}

fn series_value(email: &str, master_id: &str) -> Result<(String, String, Value), String> {
    let (calendar, id) = split_key(master_id)?;
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let url = format!("{CAL}/calendars/{}/events/{}", seg(&calendar), seg(&id));
    let value = call(&client, &token, "GET", &url, None).map_err(refusal)?;
    Ok((calendar, id, value))
}

fn series_of(master_id: &str, value: &Value) -> Series {
    let all_day = value["start"]["date"].is_string();
    let (start, end, local_start) = if all_day {
        let start = value["start"]["date"].as_str().unwrap_or("").to_string();
        let end = value["end"]["date"].as_str().unwrap_or("").to_string();
        (format!("{start}T00:00:00"), format!("{end}T00:00:00"), start)
    } else {
        let start = value["start"]["dateTime"].as_str().unwrap_or("");
        let end = value["end"]["dateTime"].as_str().unwrap_or("");
        let plain = |stamp: &str| utc(stamp).map(|z| z.trim_end_matches('Z').to_string()).unwrap_or_default();
        (plain(start), plain(end), start.get(..10).unwrap_or("").to_string())
    };
    Series {
        id: master_id.to_string(),
        start,
        end,
        all_day,
        recurrence: recurrence_from(value["recurrence"].as_array().map(Vec::as_slice).unwrap_or(&[]), &local_start),
    }
}

/// The series an occurrence belongs to, as the page knows series.
pub fn series(email: &str, master_id: &str) -> Result<Series, String> {
    let (_, _, value) = series_value(email, master_id)?;
    Ok(series_of(master_id, &value))
}

/// End a series the day before `date`. False when that would leave nothing.
pub fn end_series_before(email: &str, master_id: &str, date: &str) -> Result<bool, String> {
    let (calendar, id, value) = series_value(email, master_id)?;
    let current = series_of(master_id, &value);
    let Some(ended) = calendar::ended_before(&current.recurrence, date) else {
        return Ok(false);
    };
    let mut rules: Vec<Value> = value["recurrence"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|line| line.as_str().is_some_and(|l| !l.starts_with("RRULE:")))
        .cloned()
        .collect();
    rules.insert(0, json!(rrule_from(&ended)?));
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let url = format!("{CAL}/calendars/{}/events/{}?sendUpdates=all", seg(&calendar), seg(&id));
    call(&client, &token, "PATCH", &url, Some(&json!({ "recurrence": rules }))).map_err(refusal)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_text_with_wide_characters_does_not_panic() {
        // Byte 7 of the address and bytes 0..15 of the time fall inside
        // multi-byte characters: these are refused or kept, never a panic.
        assert_eq!(ics_email("mailtö:ada@example.org"), "mailtö:ada@example.org");
        assert_eq!(ics_email("日本語@example.org"), "日本語@example.org");
        assert_eq!(ics_email("MAILTO:ada@example.org"), "ada@example.org");
        assert!(basic_clock("2026€1024T090000").is_none());
        assert!(basic_clock("20261024T€90000Z").is_none());
        assert!(basic_clock("20261024T0900€0").is_none());
        assert_eq!(basic_clock("20261024T090000Z").as_deref(), Some("2026-10-24T09:00:00"));
        let raw = "BEGIN:VEVENT\nUID:wide@example.org\nDTSTART:20261024T€90000Z\nDTEND:20261024T100000Z\nORGANIZER:mailtö:x@example.org\nSUMMARY:Wide\nEND:VEVENT\n";
        let _ = parse_ics(raw);
    }

    #[test]
    fn event_keys_carry_the_calendar_and_have_no_at_sign() {
        let key = event_key("jon@gmail.com", "abc123_20261024T130000Z");
        assert!(!key.contains('@'), "the page splits ids at @");
        assert_eq!(split_key(&key).unwrap(), ("jon@gmail.com".to_string(), "abc123_20261024T130000Z".to_string()));
        assert_eq!(split_key("plainid").unwrap().0, "primary");
        assert!(split_key("x~not base64!").is_err());
        assert!(split_key(&event_key("jon@gmail.com", "../../etc")).is_err());
    }

    #[test]
    fn a_google_event_reads_like_an_outlook_one() {
        let value = json!({
            "id": "abc_20261024T130000Z", "status": "confirmed", "summary": "Kiln review",
            "start": { "dateTime": "2026-10-24T09:00:00-04:00" }, "end": { "dateTime": "2026-10-24T09:30:00-04:00" },
            "recurringEventId": "abc", "hangoutLink": "https://meet.google.com/abc-defg-hij",
            "organizer": { "email": "maya@example.org", "displayName": "Maya" },
            "attendees": [
                { "email": "jon@gmail.com", "self": true, "responseStatus": "tentative" },
                { "email": "room@resource.calendar.google.com", "resource": true },
                { "email": "maya@example.org", "organizer": true, "responseStatus": "accepted", "displayName": "Maya" }
            ],
            "reminders": { "useDefault": true },
            "description": "<b>Agenda</b><br>Numbers"
        });
        let ev = event_from(&value, "jon@gmail.com", 10).unwrap();
        assert_eq!((ev.start.as_str(), ev.end.as_str()), ("2026-10-24T13:00:00Z", "2026-10-24T13:30:00Z"));
        assert_eq!(ev.kind, "occurrence");
        assert_eq!(split_key(&ev.series_master_id).unwrap().1, "abc");
        assert_eq!(ev.response, "tentative");
        assert_eq!(ev.show_as, "tentative");
        assert!(!ev.is_organizer);
        assert_eq!(ev.attendees.len(), 2, "rooms are not people");
        assert_eq!(ev.reminder, 10, "the calendar's default");
        assert_eq!(ev.join_url, "https://meet.google.com/abc-defg-hij");
        assert!(ev.notes.contains("Agenda") && !ev.notes.contains('<'));
        let all_day = json!({ "id": "d1", "summary": "Holiday", "start": { "date": "2026-12-25" }, "end": { "date": "2026-12-26" }, "transparency": "transparent" });
        let day = event_from(&all_day, "primary", -1).unwrap();
        assert!(day.all_day && day.show_as == "free" && day.is_organizer);
        assert_eq!((day.start.as_str(), day.end.as_str()), ("2026-12-25", "2026-12-26"));
        assert!(event_from(&json!({ "id": "x", "status": "cancelled" }), "primary", -1).is_none());
    }

    #[test]
    fn google_colours_become_outlook_colour_names() {
        assert_eq!(colour_name("#4285f4"), "lightBlue");
        assert_eq!(colour_name("#0b8043"), "lightGreen");
        assert_eq!(colour_name("#d50000"), "lightRed");
        assert_eq!(colour_name("#f6bf26"), "lightYellow");
        assert_eq!(colour_name("#8e24aa"), "lightPurple");
        assert_eq!(colour_name("#616161"), "lightGray");
        assert_eq!(colour_name("nonsense"), "");
    }

    #[test]
    fn repeats_turn_into_rrules_and_back() {
        let cases = [
            json!({ "pattern": { "type": "weekly", "interval": 2, "daysOfWeek": ["monday", "thursday"] }, "range": { "type": "noEnd", "startDate": "2026-10-05" } }),
            json!({ "pattern": { "type": "relativeMonthly", "interval": 1, "daysOfWeek": ["tuesday"], "index": "second" }, "range": { "type": "numbered", "startDate": "2026-10-13", "numberOfOccurrences": 6 } }),
            json!({ "pattern": { "type": "absoluteYearly", "interval": 1, "dayOfMonth": 24, "month": 10 }, "range": { "type": "endDate", "startDate": "2026-10-24", "endDate": "2030-10-24" } }),
            json!({ "pattern": { "type": "relativeYearly", "interval": 1, "daysOfWeek": ["friday"], "index": "last", "month": 11 }, "range": { "type": "noEnd", "startDate": "2026-11-27" } }),
        ];
        assert_eq!(rrule_from(&cases[0]).unwrap(), "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH");
        assert_eq!(rrule_from(&cases[1]).unwrap(), "RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=TU;BYSETPOS=2;COUNT=6");
        assert_eq!(rrule_from(&cases[2]).unwrap(), "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=10;BYMONTHDAY=24;UNTIL=20301024");
        for case in &cases {
            let rule = rrule_from(case).unwrap();
            let back = recurrence_from(&[json!(rule)], case["range"]["startDate"].as_str().unwrap());
            assert_eq!(back["pattern"]["type"], case["pattern"]["type"]);
            assert_eq!(back["range"]["type"], case["range"]["type"]);
            assert_eq!(rrule_from(&back).unwrap(), rule, "round trip");
        }
        let google_style = recurrence_from(&[json!("RRULE:FREQ=MONTHLY;BYDAY=-1FR")], "2026-10-30");
        assert_eq!(google_style["pattern"]["index"], "last");
        assert_eq!(google_style["pattern"]["daysOfWeek"], json!(["friday"]));
        let weekly_bare = recurrence_from(&[json!("RRULE:FREQ=WEEKLY")], "2026-10-24");
        assert_eq!(weekly_bare["pattern"]["daysOfWeek"], json!(["saturday"]));
        // Odd text from the server is skipped, not cut mid-character.
        let odd = recurrence_from(&[json!("RRULE:FREQ=WEEKLY;BYDAY=éA,MO;UNTIL=202é1024")], "2026-10-24");
        assert_eq!(odd["pattern"]["daysOfWeek"], json!(["monday"]));
        assert_eq!(odd["range"]["type"], "noEnd");
    }

    #[test]
    fn an_event_body_sends_only_what_changed() {
        let mut fields = EventFields {
            subject: "Kiln review".into(),
            location: "Studio".into(),
            start: "2026-10-22T09:00:00".into(),
            end: "2026-10-22T09:30:00".into(),
            time_zone: "America/Toronto".into(),
            all_day: false,
            show_as: "free".into(),
            notes: None,
            attendees: None,
            recurrence: None,
            reminder: None,
            teams: None,
        };
        let body = event_body(&fields).unwrap();
        assert_eq!(body["start"], json!({ "dateTime": "2026-10-22T09:00:00", "timeZone": "America/Toronto" }));
        assert_eq!(body["transparency"], "transparent");
        assert!(body.get("attendees").is_none() && body.get("recurrence").is_none() && body.get("reminders").is_none());
        fields.recurrence = Some(Value::Null);
        fields.reminder = Some(-1);
        let stopped = event_body(&fields).unwrap();
        assert_eq!(stopped["recurrence"], json!([]));
        assert_eq!(stopped["reminders"]["overrides"], json!([]));
        fields.all_day = true;
        fields.start = "2026-10-22".into();
        fields.end = "2026-10-23".into();
        assert_eq!(event_body(&fields).unwrap()["start"], json!({ "date": "2026-10-22" }));
    }

    fn sample_invite() -> &'static str {
        "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nBEGIN:STANDARD\r\nTZOFFSETTO:-0500\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:abc123@google.com\r\nDTSTART:20261024T130000Z\r\nDTEND:20261024T140000Z\r\nSUMMARY:Plan\\, review\r\nLOCATION:Room 2\r\nORGANIZER;CN=Maya:mailto:maya@example.org\r\nATTENDEE;CUTYPE=INDIVIDUAL;PARTSTAT=NEEDS-ACTION;RSVP=\r\n TRUE:mailto:jon@gmail.com\r\nSTATUS:CONFIRMED\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    }

    #[test]
    fn an_invite_reads_its_time_its_guest_and_its_title() {
        let parsed = parse_ics(sample_invite()).unwrap();
        assert_eq!(parsed.method, "REQUEST");
        assert!(actionable_method(&parsed.method));
        assert_eq!(parsed.uid, "abc123@google.com");
        assert_eq!(parsed.summary, "Plan, review");
        assert_eq!(parsed.location, "Room 2");
        assert_eq!(parsed.organizer, "maya@example.org");
        assert_eq!(parsed.attendees, vec![("jon@gmail.com".into(), "NEEDS-ACTION".into())]);
        assert_eq!(parsed.start, Some(IcsWhen::Utc("2026-10-24T13:00:00Z".into())));
        assert_eq!(parsed.end, Some(IcsWhen::Utc("2026-10-24T14:00:00Z".into())));
        assert!(parsed.recurrence_id.is_none());
        let shown = invite_from_ics(&parsed, "jon@gmail.com");
        assert!(!shown.cancelled && !shown.organizer && shown.response.is_empty());
        assert!(!shown.event_id.contains('@'));
        assert!(split_key(&shown.event_id).is_ok());
    }

    #[test]
    fn a_reply_or_a_cancellation_is_not_an_accept_button() {
        let reply = "BEGIN:VCALENDAR\nMETHOD:REPLY\nBEGIN:VEVENT\nUID:abc@google.com\nDTSTART:20261024T130000Z\nDTEND:20261024T140000Z\nEND:VEVENT\nEND:VCALENDAR\n";
        let parsed = parse_ics(reply).unwrap();
        assert!(!actionable_method(&parsed.method));
        let cancel = "BEGIN:VCALENDAR\nMETHOD:CANCEL\nBEGIN:VEVENT\nUID:abc@google.com\nDTSTART;VALUE=DATE:20261024\nDTEND;VALUE=DATE:20261025\nSUMMARY:Site day\nSTATUS:CANCELLED\nORGANIZER:mailto:jon@gmail.com\nEND:VEVENT\nEND:VCALENDAR\n";
        let parsed = parse_ics(cancel).unwrap();
        assert!(actionable_method(&parsed.method));
        assert_eq!(parsed.start, Some(IcsWhen::Date("2026-10-24".into())));
        let shown = invite_from_ics(&parsed, "jon@gmail.com");
        assert!(shown.cancelled && shown.organizer && shown.all_day);
        assert_eq!((shown.start.as_str(), shown.end.as_str()), ("2026-10-24", "2026-10-25"));
    }

    #[test]
    fn one_occurrence_is_named_the_way_google_names_it() {
        let when = IcsWhen::Utc("2026-10-24T13:00:00Z".into());
        assert_eq!(instance_suffix(&when).as_deref(), Some("20261024T130000Z"));
        assert_eq!(instance_suffix(&IcsWhen::Date("2026-10-24".into())).as_deref(), Some("20261024"));
        assert!(instance_suffix(&IcsWhen::Zoned { local: "2026-10-24T09:00:00".into(), tz: "America/New_York".into() }).is_none());
        let zoned = parse_ics("BEGIN:VEVENT\nUID:series@example.org\nRECURRENCE-ID;TZID=America/New_York:20261024T090000\nDTSTART;TZID=America/New_York:20261024T090000\nDTEND;TZID=America/New_York:20261024T100000\nSUMMARY:Standup\nEND:VEVENT\n").unwrap();
        assert_eq!(zoned.recurrence_id, Some(IcsWhen::Zoned { local: "2026-10-24T09:00:00".into(), tz: "America/New_York".into() }));
        let event = json!({
            "id": "abc_20261024T130000Z",
            "originalStartTime": { "dateTime": "2026-10-24T13:00:00Z" }
        });
        assert!(same_when(&event, &when));
        assert!(!same_when(&event, &IcsWhen::Utc("2026-10-24T14:00:00Z".into())));
    }

    #[test]
    fn a_google_event_becomes_the_invite_card() {
        let value = json!({
            "id": "abc_20261024T130000Z",
            "status": "confirmed",
            "summary": "Kiln review",
            "location": "Studio",
            "start": { "dateTime": "2026-10-24T13:00:00Z" },
            "end": { "dateTime": "2026-10-24T13:30:00Z" },
            "organizer": { "email": "maya@example.org" },
            "attendees": [
                { "email": "jon@gmail.com", "self": true, "responseStatus": "tentative" },
                { "email": "maya@example.org", "organizer": true, "responseStatus": "accepted" }
            ]
        });
        let invite = invite_from_google(&value, "jon@gmail.com", "jon@gmail.com").unwrap();
        assert_eq!(split_key(&invite.event_id).unwrap(), ("jon@gmail.com".into(), "abc_20261024T130000Z".into()));
        assert!(!invite.event_id.contains('@'));
        assert_eq!(invite.response, "tentative");
        assert!(!invite.organizer && !invite.cancelled && !invite.all_day);
        assert_eq!(invite.subject, "Kiln review");
        assert_eq!(invite.start, "2026-10-24T13:00:00Z");
    }
}
