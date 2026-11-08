//! Creating, changing and removing calendar events on the server, including
//! repeating series.
//!
//! The page sends local wall-clock times with the computer's time zone, as
//! Outlook does, so a 9:00 meeting stays at 9:00 across daylight saving.

use crate::graph::SendGraph;
use crate::auth;
use crate::graph;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const ME: &str = "https://graph.microsoft.com/v1.0/me";

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub email: String,
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventFields {
    pub subject: String,
    #[serde(default)]
    pub location: String,
    /// "YYYY-MM-DDTHH:MM:SS" in `time_zone`, or a date for an all-day event.
    pub start: String,
    pub end: String,
    pub time_zone: String,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub show_as: String,
    /// Sent only when changed, so an HTML body written elsewhere (a Teams
    /// join block, say) is not flattened by an unrelated edit.
    #[serde(default)]
    pub notes: Option<String>,
    /// Sent only when changed, so an edit does not invite everyone again.
    #[serde(default)]
    pub attendees: Option<Vec<Person>>,
    /// A Graph patternedRecurrence, or null to stop repeating.
    #[serde(default)]
    pub recurrence: Option<Value>,
    /// Minutes before the start, or -1 for none. Left alone when absent.
    #[serde(default)]
    pub reminder: Option<i64>,
    /// Make it a Teams meeting. Left alone when absent.
    #[serde(default)]
    pub teams: Option<bool>,
}

/// A Graph request; a refusal comes back as (status, Microsoft's reason).
pub(crate) fn call(
    client: &reqwest::blocking::Client,
    token: &str,
    method: &str,
    url: &str,
    body: Option<&Value>,
) -> Result<Value, (u16, String)> {
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| (0, String::new()))?;
    let mut request = client
        .request(method, url)
        .bearer_auth(token)
        .header("Accept", "application/json")
        .header("Prefer", "outlook.timezone=\"UTC\"");
    request = match body {
        Some(body) => request.json(body),
        None => request.header("Content-Length", "0"),
    };
    let response = request.send_graph(token).map_err(|err| (0, err.to_string()))?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err((status.as_u16(), crate::compose::graph_reason(&text)));
    }
    Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
}

fn refusal((status, reason): (u16, String)) -> String {
    match status {
        401 | 403 => "Sign in again to change the calendar.".into(),
        404 => "That event is no longer on the calendar.".into(),
        0 => "Could not reach Microsoft. Try again.".into(),
        _ if !reason.is_empty() => format!("Microsoft did not save the event: {reason}"),
        _ => "Microsoft did not save the event.".into(),
    }
}

fn event_url(id: &str) -> String {
    format!("{ME}/events/{}", graph::path_segment(id.trim()))
}

fn valid_stamp(value: &str, all_day: bool) -> bool {
    let bytes = value.as_bytes();
    let date_ok = bytes.len() >= 10
        && bytes[..10].iter().enumerate().all(|(i, b)| if i == 4 || i == 7 { *b == b'-' } else { b.is_ascii_digit() });
    if !date_ok {
        return false;
    }
    if all_day {
        return value.len() == 10 || &value[10..] == "T00:00:00";
    }
    value.len() == 19
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && [11, 12, 14, 15, 17, 18].iter().all(|i| bytes[*i].is_ascii_digit())
}

pub fn zone_ok(zone: &str) -> bool {
    valid_zone(zone)
}

fn valid_zone(zone: &str) -> bool {
    !zone.is_empty()
        && zone.len() <= 64
        && zone.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '_' | '-' | '+' | ' ' | '.' | '(' | ')'))
}

const WEEKDAYS: [&str; 7] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const INDEXES: [&str; 5] = ["first", "second", "third", "fourth", "last"];

fn date_only(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    (text.len() == 10 && valid_stamp(text, true)).then(|| text.to_string())
}

/// Rebuild a recurrence from the page, keeping only what Graph accepts.
pub fn clean_recurrence(raw: &Value, zone: &str) -> Result<Value, String> {
    let bad = || "That repeat setting is not valid.".to_string();
    let pattern = &raw["pattern"];
    let range = &raw["range"];
    let kind = pattern["type"].as_str().ok_or_else(bad)?;
    let interval = pattern["interval"].as_u64().filter(|n| (1..=99).contains(n)).ok_or_else(bad)?;
    let mut out = json!({ "type": kind, "interval": interval });
    let days = || -> Result<Vec<String>, String> {
        let list: Vec<String> = pattern["daysOfWeek"]
            .as_array()
            .ok_or_else(bad)?
            .iter()
            .filter_map(|day| day.as_str())
            .filter(|day| WEEKDAYS.contains(day))
            .map(String::from)
            .collect();
        if list.is_empty() { Err(bad()) } else { Ok(list) }
    };
    let day_of_month = || pattern["dayOfMonth"].as_u64().filter(|n| (1..=31).contains(n)).ok_or_else(bad);
    let month = || pattern["month"].as_u64().filter(|n| (1..=12).contains(n)).ok_or_else(bad);
    let index = || pattern["index"].as_str().filter(|i| INDEXES.contains(i)).map(String::from).ok_or_else(bad);
    match kind {
        "daily" => {}
        "weekly" => {
            out["daysOfWeek"] = json!(days()?);
            out["firstDayOfWeek"] = json!("monday");
        }
        "absoluteMonthly" => out["dayOfMonth"] = json!(day_of_month()?),
        "relativeMonthly" => {
            out["daysOfWeek"] = json!(days()?);
            out["index"] = json!(index()?);
        }
        "absoluteYearly" => {
            out["dayOfMonth"] = json!(day_of_month()?);
            out["month"] = json!(month()?);
        }
        "relativeYearly" => {
            out["daysOfWeek"] = json!(days()?);
            out["index"] = json!(index()?);
            out["month"] = json!(month()?);
        }
        _ => return Err(bad()),
    }
    let start = date_only(&range["startDate"]).ok_or_else(bad)?;
    let mut clean_range = json!({ "startDate": start, "recurrenceTimeZone": zone });
    match range["type"].as_str().ok_or_else(bad)? {
        "noEnd" => clean_range["type"] = json!("noEnd"),
        "endDate" => {
            let end = date_only(&range["endDate"]).ok_or_else(bad)?;
            if end < start {
                return Err("The repeat must end after it starts.".into());
            }
            clean_range["type"] = json!("endDate");
            clean_range["endDate"] = json!(end);
        }
        "numbered" => {
            let count = range["numberOfOccurrences"].as_u64().filter(|n| (1..=999).contains(n)).ok_or_else(bad)?;
            clean_range["type"] = json!("numbered");
            clean_range["numberOfOccurrences"] = json!(count);
        }
        _ => return Err(bad()),
    }
    Ok(json!({ "pattern": out, "range": clean_range }))
}

/// The JSON Graph gets for an event.
pub fn event_body(fields: &EventFields) -> Result<Value, String> {
    let subject = fields.subject.trim();
    if subject.is_empty() {
        return Err("Enter a title.".into());
    }
    if subject.chars().count() > 255 {
        return Err("The title is too long.".into());
    }
    if !valid_zone(&fields.time_zone) {
        return Err("This computer's time zone could not be read.".into());
    }
    if !valid_stamp(&fields.start, fields.all_day) || !valid_stamp(&fields.end, fields.all_day) {
        return Err("Enter a date and time.".into());
    }
    let full = |stamp: &str| if stamp.len() == 10 { format!("{stamp}T00:00:00") } else { stamp.to_string() };
    let (start, end) = (full(&fields.start), full(&fields.end));
    if end <= start {
        return Err("End must be after the start.".into());
    }
    let show_as = match fields.show_as.trim() {
        "free" | "tentative" | "busy" | "oof" | "workingElsewhere" => fields.show_as.trim(),
        _ => "busy",
    };
    let mut body = json!({
        "subject": subject,
        "start": { "dateTime": start, "timeZone": fields.time_zone },
        "end": { "dateTime": end, "timeZone": fields.time_zone },
        "isAllDay": fields.all_day,
        "showAs": show_as,
        "location": { "displayName": fields.location.trim() }
    });
    if let Some(notes) = &fields.notes {
        let notes: String = notes.chars().take(30_000).collect();
        body["body"] = json!({ "contentType": "text", "content": notes });
    }
    if let Some(people) = &fields.attendees {
        let mut seen = std::collections::HashSet::new();
        let mut list = Vec::new();
        for person in people {
            let address = person.email.trim();
            if address.is_empty() || !address.contains('@') || address.len() > 320 || address.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
                return Err("Check the attendee addresses.".into());
            }
            if seen.insert(address.to_lowercase()) {
                list.push(json!({ "emailAddress": { "address": address, "name": person.name.trim() }, "type": "required" }));
            }
        }
        body["attendees"] = Value::Array(list);
    }
    if let Some(minutes) = fields.reminder {
        if minutes < 0 {
            body["isReminderOn"] = json!(false);
        } else {
            body["isReminderOn"] = json!(true);
            body["reminderMinutesBeforeStart"] = json!(minutes.min(40320));
        }
    }
    if fields.teams == Some(true) {
        body["isOnlineMeeting"] = json!(true);
        body["onlineMeetingProvider"] = json!("teamsForBusiness");
    }
    if let Some(recurrence) = &fields.recurrence {
        body["recurrence"] = if recurrence.is_null() { Value::Null } else { clean_recurrence(recurrence, &fields.time_zone)? };
    }
    Ok(body)
}

/// Create an event, or change one, and return its id.
pub fn save_event(email: &str, event_id: &str, calendar_id: &str, fields: &EventFields) -> Result<String, String> {
    let body = event_body(fields)?;
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let saved = if event_id.trim().is_empty() {
        let url = if calendar_id.trim().is_empty() {
            format!("{ME}/events")
        } else {
            format!("{ME}/calendars/{}/events", graph::path_segment(calendar_id.trim()))
        };
        call(&client, &token, "POST", &url, Some(&body)).map_err(refusal)?
    } else {
        call(&client, &token, "PATCH", &event_url(event_id), Some(&body)).map_err(refusal)?
    };
    Ok(saved["id"].as_str().unwrap_or(event_id).to_string())
}

/// How an event leaves the calendar: an organiser's meeting is cancelled
/// for everyone, an invitation is declined, anything else is deleted.
pub fn remove_url(event_id: &str, how: &str) -> Result<(String, &'static str, Option<Value>), String> {
    let id = event_id.trim();
    if id.is_empty() {
        return Err("That event is not on the server.".into());
    }
    Ok(match how {
        "cancel" => (format!("{}/cancel", event_url(id)), "POST", Some(json!({ "comment": "" }))),
        "decline" => (format!("{}/decline", event_url(id)), "POST", Some(json!({ "sendResponse": true, "comment": "" }))),
        _ => (event_url(id), "DELETE", None),
    })
}

pub fn remove_event(email: &str, event_id: &str, how: &str) -> Result<(), String> {
    let (url, method, body) = remove_url(event_id, how)?;
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    match call(&client, &token, method, &url, body.as_ref()) {
        Ok(_) => {}
        Err((404, _)) => {}
        Err(failure) => return Err(refusal(failure)),
    }
    // Declining leaves the event on the calendar; remove it as Outlook does.
    if how == "decline" {
        let _ = call(&client, &token, "DELETE", &event_url(event_id), None);
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub id: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub recurrence: Value,
}

/// The series an occurrence belongs to: its first start and its repeat.
pub fn series(email: &str, master_id: &str) -> Result<Series, String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let value = call(
        &client,
        &token,
        "GET",
        &format!("{}?$select=id,start,end,isAllDay,recurrence", event_url(master_id)),
        None,
    )
    .map_err(refusal)?;
    Ok(Series {
        id: value["id"].as_str().unwrap_or(master_id).to_string(),
        start: value["start"]["dateTime"].as_str().unwrap_or("").to_string(),
        end: value["end"]["dateTime"].as_str().unwrap_or("").to_string(),
        all_day: value["isAllDay"].as_bool().unwrap_or(false),
        recurrence: value["recurrence"].clone(),
    })
}

/// The day before a YYYY-MM-DD date.
pub fn day_before(date: &str) -> Option<String> {
    let year: i32 = date.get(0..4)?.parse().ok()?;
    let month: u32 = date.get(5..7)?.parse().ok()?;
    let day: u32 = date.get(8..10)?.parse().ok()?;
    let (y, m, d) = graph::previous_day(year, month, day)?;
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

/// A series' recurrence, ended the day before `date`.
pub fn ended_before(recurrence: &Value, date: &str) -> Option<Value> {
    let mut out = recurrence.clone();
    let last = day_before(date)?;
    let start = out["range"]["startDate"].as_str()?.to_string();
    if last < start {
        return None;
    }
    out["range"]["type"] = json!("endDate");
    out["range"]["endDate"] = json!(last);
    if let Some(range) = out["range"].as_object_mut() {
        range.remove("numberOfOccurrences");
    }
    Some(out)
}

/// End a series before an occurrence: "this and all following". Returns
/// false when the occurrence is the first one, so the whole series goes.
pub fn end_series_before(email: &str, master_id: &str, date: &str) -> Result<bool, String> {
    let current = series(email, master_id)?;
    let Some(ended) = ended_before(&current.recurrence, date) else {
        return Ok(false);
    };
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    call(&client, &token, "PATCH", &event_url(master_id), Some(&json!({ "recurrence": ended }))).map_err(refusal)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields() -> EventFields {
        EventFields {
            subject: "Kiln review".into(),
            location: "Studio".into(),
            start: "2026-10-22T09:00:00".into(),
            end: "2026-10-22T09:30:00".into(),
            time_zone: "America/Toronto".into(),
            all_day: false,
            show_as: "busy".into(),
            notes: None,
            attendees: None,
            recurrence: None,
            reminder: None,
            teams: None,
        }
    }

    #[test]
    fn reminders_and_teams_are_sent_only_when_set() {
        let plain = event_body(&fields()).unwrap();
        assert!(plain.get("isReminderOn").is_none() && plain.get("isOnlineMeeting").is_none());
        let mut f = fields();
        f.reminder = Some(10);
        f.teams = Some(true);
        let body = event_body(&f).unwrap();
        assert_eq!(body["reminderMinutesBeforeStart"], 10);
        assert_eq!(body["onlineMeetingProvider"], "teamsForBusiness");
        f.reminder = Some(-1);
        assert_eq!(event_body(&f).unwrap()["isReminderOn"], false);
    }

    #[test]
    fn an_event_keeps_local_time_and_only_sends_what_changed() {
        let body = event_body(&fields()).unwrap();
        assert_eq!(body["start"]["dateTime"], "2026-10-22T09:00:00");
        assert_eq!(body["start"]["timeZone"], "America/Toronto");
        assert!(body.get("body").is_none());
        assert!(body.get("attendees").is_none());
        assert!(body.get("recurrence").is_none());
        let mut all_day = fields();
        all_day.all_day = true;
        all_day.start = "2026-10-22".into();
        all_day.end = "2026-10-23".into();
        assert_eq!(event_body(&all_day).unwrap()["end"]["dateTime"], "2026-10-23T00:00:00");
    }

    #[test]
    fn bad_input_is_refused() {
        let mut f = fields();
        f.end = "2026-10-22T08:00:00".into();
        assert_eq!(event_body(&f).unwrap_err(), "End must be after the start.");
        let mut f = fields();
        f.subject = "  ".into();
        assert!(event_body(&f).is_err());
        let mut f = fields();
        f.time_zone = "x\"}".into();
        assert!(event_body(&f).is_err());
        let mut f = fields();
        f.attendees = Some(vec![Person { email: "not an address".into(), name: String::new() }]);
        assert!(event_body(&f).is_err());
        let mut f = fields();
        f.attendees = Some(vec![Person { email: "a@x.org".into(), name: "A".into() }, Person { email: "A@x.org".into(), name: String::new() }]);
        assert_eq!(event_body(&f).unwrap()["attendees"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn repeats_are_rebuilt_from_known_parts() {
        let weekly = clean_recurrence(
            &json!({ "pattern": { "type": "weekly", "interval": 2, "daysOfWeek": ["monday", "thursday", "funday"], "extra": 1 },
                     "range": { "type": "numbered", "startDate": "2026-10-22", "numberOfOccurrences": 10 } }),
            "America/Toronto",
        )
        .unwrap();
        assert_eq!(weekly["pattern"]["daysOfWeek"], json!(["monday", "thursday"]));
        assert!(weekly["pattern"].get("extra").is_none());
        assert_eq!(weekly["range"]["recurrenceTimeZone"], "America/Toronto");
        let second_tuesday = clean_recurrence(
            &json!({ "pattern": { "type": "relativeMonthly", "interval": 1, "daysOfWeek": ["tuesday"], "index": "second" },
                     "range": { "type": "noEnd", "startDate": "2026-10-13" } }),
            "UTC",
        )
        .unwrap();
        assert_eq!(second_tuesday["pattern"]["index"], "second");
        assert!(clean_recurrence(&json!({ "pattern": { "type": "hourly", "interval": 1 }, "range": { "type": "noEnd", "startDate": "2026-10-13" } }), "UTC").is_err());
        assert!(clean_recurrence(&json!({ "pattern": { "type": "daily", "interval": 0 }, "range": { "type": "noEnd", "startDate": "2026-10-13" } }), "UTC").is_err());
        assert!(clean_recurrence(&json!({ "pattern": { "type": "daily", "interval": 1 }, "range": { "type": "endDate", "startDate": "2026-10-13", "endDate": "2026-10-01" } }), "UTC").is_err());
        let mut f = fields();
        f.recurrence = Some(Value::Null);
        assert!(event_body(&f).unwrap()["recurrence"].is_null());
    }

    #[test]
    fn removing_cancels_declines_or_deletes() {
        assert_eq!(remove_url("e/1", "cancel").unwrap().1, "POST");
        assert!(remove_url("e/1", "cancel").unwrap().0.ends_with("/events/e%2F1/cancel"));
        assert!(remove_url("e", "decline").unwrap().0.ends_with("/decline"));
        assert_eq!(remove_url("e", "delete").unwrap().1, "DELETE");
        assert!(remove_url(" ", "delete").is_err());
    }

    #[test]
    fn this_and_following_ends_the_series_the_day_before() {
        assert_eq!(day_before("2026-03-01").unwrap(), "2026-02-28");
        assert_eq!(day_before("2024-03-01").unwrap(), "2024-02-29");
        assert_eq!(day_before("2026-01-01").unwrap(), "2025-12-31");
        let series = json!({ "pattern": { "type": "weekly" }, "range": { "type": "numbered", "startDate": "2026-10-01", "numberOfOccurrences": 20 } });
        let ended = ended_before(&series, "2026-11-05").unwrap();
        assert_eq!(ended["range"]["type"], "endDate");
        assert_eq!(ended["range"]["endDate"], "2026-11-04");
        assert!(ended["range"].get("numberOfOccurrences").is_none());
        assert!(ended_before(&series, "2026-10-01").is_none());
    }
}

// ---- Free/busy (2026-10-23): when booking a meeting, each person's day in
// 15-minute slots from Microsoft's getSchedule, as Outlook's Scheduling
// Assistant shows it. A person outside your organisation, or one who
// doesn't share, comes back with an error and is shown as unknown.

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FreeBusy {
    pub email: String,
    /// One digit per 15 minutes: 0 free, 1 tentative, 2 busy, 3 away,
    /// 4 working elsewhere. Empty when not known.
    pub view: String,
    pub error: String,
}

pub fn schedule_request(people: &[String], start_utc: &str, end_utc: &str) -> Result<Value, String> {
    let mut seen = std::collections::HashSet::new();
    let list: Vec<String> = people
        .iter()
        .map(|p| p.trim().to_lowercase())
        .filter(|p| p.contains('@') && p.len() <= 254 && !p.contains([' ', ',', ';', '<', '>']) && seen.insert(p.clone()))
        .take(20)
        .collect();
    if list.is_empty() {
        return Err("Add someone to see when they're free.".into());
    }
    let stamp = |s: &str| -> Result<String, String> {
        let t = s.trim();
        if t.len() >= 16 && t.as_bytes()[4] == b'-' && t.as_bytes()[10] == b'T' {
            Ok(t.trim_end_matches('Z').chars().take(19).collect())
        } else {
            Err("Choose a day.".into())
        }
    };
    Ok(json!({
        "schedules": list,
        "startTime": { "dateTime": stamp(start_utc)?, "timeZone": "UTC" },
        "endTime": { "dateTime": stamp(end_utc)?, "timeZone": "UTC" },
        "availabilityViewInterval": 15
    }))
}

pub fn read_schedule(value: &Value) -> Vec<FreeBusy> {
    value["value"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            let view: String = item["availabilityView"].as_str().unwrap_or("").chars().filter(|c| ('0'..='4').contains(c)).take(200).collect();
            let error = item["error"]["message"].as_str().unwrap_or("").chars().take(200).collect::<String>();
            FreeBusy { email: item["scheduleId"].as_str().unwrap_or("").to_lowercase(), view: if error.is_empty() { view } else { String::new() }, error }
        })
        .collect()
}

pub fn free_busy(email: &str, people: &[String], start_utc: &str, end_utc: &str) -> Result<Vec<FreeBusy>, String> {
    let body = schedule_request(people, start_utc, end_utc)?;
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let value = call(&client, &token, "POST", &format!("{ME}/calendar/getSchedule"), Some(&body))
        .map_err(|(status, text)| format!("Microsoft didn't say who is free ({status}). {}", text.chars().take(200).collect::<String>()))?;
    Ok(read_schedule(&value))
}

#[cfg(test)]
mod free_busy_tests {
    use super::*;

    #[test]
    fn the_request_names_each_person_once_for_the_day_in_utc() {
        let body = schedule_request(&["Ada@Example.org".into(), "ada@example.org".into(), "not an address".into(), "bo@example.org".into()], "2026-10-24T04:00:00.000Z", "2026-10-25T04:00:00Z").unwrap();
        assert_eq!(body["schedules"], json!(["ada@example.org", "bo@example.org"]));
        assert_eq!(body["startTime"]["dateTime"], "2026-10-24T04:00:00");
        assert_eq!(body["availabilityViewInterval"], 15);
        assert!(schedule_request(&[], "2026-10-24T04:00:00Z", "2026-10-25T04:00:00Z").is_err());
        assert!(schedule_request(&["a@b.co".into()], "tomorrow", "x").is_err());
    }

    #[test]
    fn the_answer_keeps_the_slots_or_says_why_not() {
        let got = read_schedule(&json!({ "value": [
            { "scheduleId": "Ada@example.org", "availabilityView": "0022x10" },
            { "scheduleId": "eve@other.example", "availabilityView": "000", "error": { "message": "Not found" } }
        ] }));
        assert_eq!(got[0], FreeBusy { email: "ada@example.org".into(), view: "002210".into(), error: String::new() });
        assert_eq!((got[1].view.as_str(), got[1].error.as_str()), ("", "Not found"));
    }
}
