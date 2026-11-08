//! Mailbox-wide settings and helpers: categories, automatic replies, and a
//! folder made on demand (Snoozed).

use crate::auth;
use crate::calendar::call;
use crate::graph;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const ME: &str = "https://graph.microsoft.com/v1.0/me";

fn refusal(what: &str) -> impl Fn((u16, String)) -> String + '_ {
    move |(status, reason)| match status {
        401 | 403 => format!("Sign in again to change {what}."),
        0 => "Could not reach Microsoft. Try again.".into(),
        _ if !reason.is_empty() => format!("Microsoft did not save {what}: {reason}"),
        _ => format!("Microsoft did not save {what}."),
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Category {
    pub name: String,
    pub color: String,
}

pub fn parse_categories(value: &Value) -> Vec<Category> {
    value["value"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let name = item["displayName"].as_str()?.trim();
            (!name.is_empty()).then(|| Category {
                name: name.to_string(),
                color: item["color"].as_str().unwrap_or("none").to_string(),
            })
        })
        .collect()
}

/// The mailbox time zone Outlook on the web uses. A Windows name, such as
/// "Pacific Time (British Columbia)".
pub fn read_zone(email: &str) -> Result<String, String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let value = call(&client, &token, "GET", &format!("{ME}/mailboxSettings?$select=timeZone"), None)
        .map_err(refusal("the time zone"))?;
    Ok(value["timeZone"].as_str().unwrap_or("").trim().to_string())
}

pub fn write_zone(email: &str, zone: &str) -> Result<(), String> {
    let zone = zone.trim();
    if !crate::calendar::zone_ok(zone) {
        return Err("Choose a time zone.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    call(
        &client,
        &token,
        "PATCH",
        &format!("{ME}/mailboxSettings"),
        Some(&json!({ "timeZone": zone })),
    )
    .map_err(refusal("the time zone"))?;
    Ok(())
}

/// The account's Outlook categories, with their colours.
pub fn categories(email: &str) -> Result<Vec<Category>, String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let value = call(&client, &token, "GET", &format!("{ME}/outlook/masterCategories"), None).map_err(refusal("categories"))?;
    Ok(parse_categories(&value))
}

/// Put exactly these categories on some messages.
pub fn set_categories(email: &str, ids: &[String], names: &[String]) -> Result<(), String> {
    if ids.is_empty() || ids.len() > 200 {
        return Err("Choose up to 200 messages.".into());
    }
    let clean: Vec<String> = names.iter().map(|n| n.trim().to_string()).filter(|n| !n.is_empty() && n.len() <= 255).take(25).collect();
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    for body in crate::folders::batches(ids, "PATCH", Some(&json!({ "categories": clean }))) {
        call(&client, &token, "POST", "https://graph.microsoft.com/v1.0/$batch", Some(&body)).map_err(refusal("categories"))?;
    }
    Ok(())
}

// ---- Focused Inbox (2026-10-23): move messages between Focused and Other,
// and, for "always", tell Microsoft to sort a sender that way from now on
// (an inferenceClassification override, which Outlook on the web follows too).

pub fn focus_value(value: &str) -> Result<&'static str, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "focused" => Ok("focused"),
        "other" => Ok("other"),
        _ => Err("Choose Focused or Other.".into()),
    }
}

pub fn set_focus(email: &str, ids: &[String], value: &str, always_sender: &str) -> Result<(), String> {
    let classify = focus_value(value)?;
    if ids.is_empty() || ids.len() > 200 {
        return Err("Choose up to 200 messages.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    for body in crate::folders::batches(ids, "PATCH", Some(&json!({ "inferenceClassification": classify }))) {
        call(&client, &token, "POST", "https://graph.microsoft.com/v1.0/$batch", Some(&body)).map_err(refusal("Focused Inbox"))?;
    }
    let sender = always_sender.trim().to_lowercase();
    if sender.is_empty() {
        return Ok(());
    }
    if !sender.contains('@') || sender.len() > 254 || sender.contains([' ', ',', ';', '<', '>']) {
        return Err("That sender's address can't be used.".into());
    }
    let overrides = format!("{ME}/inferenceClassification/overrides");
    let listed = call(&client, &token, "GET", &overrides, None).map_err(refusal("Focused Inbox"))?;
    let existing = listed["value"].as_array().into_iter().flatten().find(|o| {
        o["senderEmailAddress"]["address"].as_str().is_some_and(|a| a.eq_ignore_ascii_case(&sender))
    });
    match existing.and_then(|o| o["id"].as_str()) {
        Some(id) => {
            call(&client, &token, "PATCH", &format!("{overrides}/{}", graph::path_segment(id)), Some(&json!({ "classifyAs": classify })))
                .map_err(refusal("Focused Inbox"))?;
        }
        None => {
            call(&client, &token, "POST", &overrides, Some(&json!({ "classifyAs": classify, "senderEmailAddress": { "address": sender } })))
                .map_err(refusal("Focused Inbox"))?;
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutoReply {
    /// disabled, alwaysEnabled or scheduled.
    pub status: String,
    /// none, contactsOnly or all.
    pub external_audience: String,
    /// UTC, "YYYY-MM-DDTHH:MM:SS".
    #[serde(default)]
    pub start: String,
    #[serde(default)]
    pub end: String,
    #[serde(default)]
    pub internal: String,
    #[serde(default)]
    pub external: String,
}

pub fn parse_auto_reply(value: &Value) -> AutoReply {
    let stamp = |v: &Value| v["dateTime"].as_str().unwrap_or("").split('.').next().unwrap_or("").to_string();
    AutoReply {
        status: value["status"].as_str().unwrap_or("disabled").to_string(),
        external_audience: value["externalAudience"].as_str().unwrap_or("none").to_string(),
        start: stamp(&value["scheduledStartDateTime"]),
        end: stamp(&value["scheduledEndDateTime"]),
        internal: value["internalReplyMessage"].as_str().unwrap_or("").to_string(),
        external: value["externalReplyMessage"].as_str().unwrap_or("").to_string(),
    }
}

pub fn auto_reply(email: &str) -> Result<AutoReply, String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let value = call(&client, &token, "GET", &format!("{ME}/mailboxSettings/automaticRepliesSetting"), None)
        .map_err(refusal("automatic replies"))?;
    Ok(parse_auto_reply(&value))
}

fn utc_stamp_ok(text: &str) -> bool {
    let b = text.as_bytes();
    b.len() == 19 && b[4] == b'-' && b[7] == b'-' && b[10] == b'T' && b[13] == b':' && b[16] == b':'
        && b.iter().enumerate().all(|(i, c)| [4, 7, 10, 13, 16].contains(&i) || c.is_ascii_digit())
}

/// The automaticRepliesSetting Graph gets, from known values only.
pub fn auto_reply_body(reply: &AutoReply) -> Result<Value, String> {
    let status = match reply.status.as_str() {
        "disabled" | "alwaysEnabled" | "scheduled" => reply.status.as_str(),
        _ => return Err("Choose Off, On, or a time range.".into()),
    };
    let audience = match reply.external_audience.as_str() {
        "none" | "contactsOnly" | "all" => reply.external_audience.as_str(),
        _ => "none",
    };
    let mut body = json!({
        "status": status,
        "externalAudience": audience,
        "internalReplyMessage": reply.internal.chars().take(8000).collect::<String>(),
        "externalReplyMessage": reply.external.chars().take(8000).collect::<String>()
    });
    if status == "scheduled" {
        if !utc_stamp_ok(&reply.start) || !utc_stamp_ok(&reply.end) {
            return Err("Choose a start and an end.".into());
        }
        if reply.end <= reply.start {
            return Err("The end must be after the start.".into());
        }
        body["scheduledStartDateTime"] = json!({ "dateTime": reply.start, "timeZone": "UTC" });
        body["scheduledEndDateTime"] = json!({ "dateTime": reply.end, "timeZone": "UTC" });
    }
    Ok(body)
}

pub fn set_auto_reply(email: &str, reply: &AutoReply) -> Result<(), String> {
    let body = auto_reply_body(reply)?;
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    call(&client, &token, "PATCH", &format!("{ME}/mailboxSettings"), Some(&json!({ "automaticRepliesSetting": body })))
        .map_err(refusal("automatic replies"))?;
    Ok(())
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Person {
    pub name: String,
    pub email: String,
}

pub fn parse_people(value: &Value) -> Vec<Person> {
    value["value"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let email = item["scoredEmailAddresses"].as_array()?.first()?["address"].as_str()?.trim();
            if !email.contains('@') {
                return None;
            }
            Some(Person { name: item["displayName"].as_str().unwrap_or("").trim().to_string(), email: email.to_string() })
        })
        .collect()
}

/// People you work with, ranked by Microsoft; or those matching a search,
/// including your organisation's directory.
pub fn people(email: &str, query: &str) -> Result<Vec<Person>, String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let q = query.trim();
    let url = if q.is_empty() {
        format!("{ME}/people?$top=100&$select=displayName,scoredEmailAddresses")
    } else {
        let clean: String = q.chars().filter(|c| !c.is_control() && *c != '"').take(60).collect();
        format!("{ME}/people?$top=15&$select=displayName,scoredEmailAddresses&$search=%22{}%22", graph::path_segment(&clean))
    };
    let value = call(&client, &token, "GET", &url, None).map_err(refusal("people"))?;
    Ok(parse_people(&value))
}

/// An Inbox rule, in the few parts Mailroom offers. Outlook keeps it on the
/// server, so it runs with Mailroom closed.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub from: Vec<String>,
    #[serde(default)]
    pub subject: Vec<String>,
    /// A folder id to move to, or empty.
    #[serde(default)]
    pub move_to: String,
    #[serde(default)]
    pub mark_read: bool,
    #[serde(default)]
    pub delete: bool,
    #[serde(default)]
    pub stop: bool,
    /// The rule also has conditions or actions Mailroom does not show.
    #[serde(default)]
    pub other: bool,
}

const SHOWN_CONDITIONS: [&str; 2] = ["fromAddresses", "subjectContains"];
const SHOWN_ACTIONS: [&str; 4] = ["moveToFolder", "markAsRead", "delete", "stopProcessingRules"];

pub fn parse_rule(item: &Value) -> Rule {
    let conditions = &item["conditions"];
    let actions = &item["actions"];
    let other = conditions.as_object().is_some_and(|c| c.iter().any(|(k, v)| !v.is_null() && !SHOWN_CONDITIONS.contains(&k.as_str())))
        || actions.as_object().is_some_and(|a| a.iter().any(|(k, v)| !v.is_null() && v != &json!(false) && !SHOWN_ACTIONS.contains(&k.as_str())));
    Rule {
        id: item["id"].as_str().unwrap_or("").to_string(),
        name: item["displayName"].as_str().unwrap_or("").to_string(),
        enabled: item["isEnabled"].as_bool().unwrap_or(false),
        from: conditions["fromAddresses"].as_array().into_iter().flatten().filter_map(|r| r["emailAddress"]["address"].as_str().map(String::from)).collect(),
        subject: conditions["subjectContains"].as_array().into_iter().flatten().filter_map(|s| s.as_str().map(String::from)).collect(),
        move_to: actions["moveToFolder"].as_str().unwrap_or("").to_string(),
        mark_read: actions["markAsRead"].as_bool().unwrap_or(false),
        delete: actions["delete"].as_bool().unwrap_or(false),
        stop: actions["stopProcessingRules"].as_bool().unwrap_or(false),
        other,
    }
}

/// The whole change sent when an existing rule is turned on or off.
pub fn toggle_body(rule: &Rule) -> Value {
    json!({ "isEnabled": rule.enabled })
}

pub fn rule_body(rule: &Rule, sequence: i64) -> Result<Value, String> {
    let name = rule.name.trim();
    if name.is_empty() || name.len() > 255 {
        return Err("Give the rule a name.".into());
    }
    let from: Vec<&str> = rule.from.iter().map(|a| a.trim()).filter(|a| !a.is_empty()).collect();
    if from.iter().any(|a| !a.contains('@') || a.chars().any(|c| c.is_whitespace() || c.is_control())) {
        return Err("Check the From addresses.".into());
    }
    let subject: Vec<&str> = rule.subject.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    if from.is_empty() && subject.is_empty() {
        return Err("Choose who it is from or words in the subject.".into());
    }
    if rule.move_to.trim().is_empty() && !rule.mark_read && !rule.delete {
        return Err("Choose what the rule does.".into());
    }
    let mut conditions = json!({});
    if !from.is_empty() {
        conditions["fromAddresses"] = json!(from.iter().map(|a| json!({ "emailAddress": { "address": a } })).collect::<Vec<_>>());
    }
    if !subject.is_empty() {
        conditions["subjectContains"] = json!(subject);
    }
    let mut actions = json!({ "stopProcessingRules": rule.stop });
    if !rule.move_to.trim().is_empty() {
        actions["moveToFolder"] = json!(rule.move_to.trim());
    }
    if rule.mark_read {
        actions["markAsRead"] = json!(true);
    }
    if rule.delete {
        actions["delete"] = json!(true);
    }
    Ok(json!({ "displayName": name, "sequence": sequence, "isEnabled": rule.enabled, "conditions": conditions, "actions": actions }))
}

const RULES: &str = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messageRules";

pub fn rules(email: &str) -> Result<Vec<Rule>, String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let value = call(&client, &token, "GET", RULES, None).map_err(refusal("rules"))?;
    let mut list: Vec<(i64, Rule)> = value["value"].as_array().into_iter().flatten().map(|item| (item["sequence"].as_i64().unwrap_or(0), parse_rule(item))).collect();
    list.sort_by_key(|(seq, _)| *seq);
    Ok(list.into_iter().map(|(_, rule)| rule).collect())
}

pub fn save_rule(email: &str, rule: &Rule) -> Result<Rule, String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let saved = if rule.id.trim().is_empty() {
        let count = call(&client, &token, "GET", RULES, None).ok().and_then(|v| v["value"].as_array().map(|a| a.len() as i64)).unwrap_or(0);
        call(&client, &token, "POST", RULES, Some(&rule_body(rule, count + 1)?)).map_err(refusal("the rule"))?
    } else {
        // An existing rule is only switched on or off here. Writing back
        // Mailroom's reduced copy would drop conditions it does not show
        // (and could widen a rule that deletes or moves mail).
        let url = format!("{RULES}/{}", graph::path_segment(rule.id.trim()));
        call(&client, &token, "PATCH", &url, Some(&toggle_body(rule))).map_err(refusal("the rule"))?
    };
    Ok(parse_rule(&saved))
}

pub fn delete_rule(email: &str, id: &str) -> Result<(), String> {
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    match call(&client, &token, "DELETE", &format!("{RULES}/{}", graph::path_segment(id.trim())), None) {
        Ok(_) | Err((404, _)) => Ok(()),
        Err(failure) => Err(refusal("the rule")(failure)),
    }
}

/// A top-level folder by name, made if it is not there yet. Returns its id.
pub fn ensure_folder(email: &str, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 100 || name.contains('\'') {
        return Err("That folder name is not allowed.".into());
    }
    let token = auth::access_token_for(email)?;
    let client = graph::http_client()?;
    let filter = graph::path_segment(&format!("displayName eq '{name}'"));
    let found = call(&client, &token, "GET", &format!("{ME}/mailFolders?$filter={filter}&$select=id"), None)
        .map_err(refusal("the folder"))?;
    if let Some(id) = found["value"].as_array().and_then(|list| list.first()).and_then(|f| f["id"].as_str()) {
        return Ok(id.to_string());
    }
    let made = call(&client, &token, "POST", &format!("{ME}/mailFolders"), Some(&json!({ "displayName": name })))
        .map_err(refusal("the folder"))?;
    made["id"].as_str().map(String::from).ok_or_else(|| "Microsoft did not make the folder.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turning_a_rule_on_or_off_sends_only_that() {
        let item = json!({ "id": "r9", "displayName": "Invoices", "isEnabled": true,
            "conditions": { "fromAddresses": [{ "emailAddress": { "address": "a@x.example" } }], "bodyContains": ["invoice"] },
            "actions": { "delete": true } });
        let mut rule = parse_rule(&item);
        assert!(rule.other);
        rule.enabled = false;
        assert_eq!(toggle_body(&rule), json!({ "isEnabled": false }));
    }

    #[test]
    fn focus_takes_only_focused_or_other() {
        assert_eq!(focus_value(" Other "), Ok("other"));
        assert_eq!(focus_value("FOCUSED"), Ok("focused"));
        assert!(focus_value("junk").is_err());
    }

    #[test]
    fn folder_filter_is_encoded() {
        let filter = graph::path_segment("displayName eq 'R&D C++'");
        assert_eq!(filter, "displayName%20eq%20%27R%26D%20C%2B%2B%27");
    }

    #[test]
    fn rules_round_trip_in_known_parts() {
        let rule = Rule { name: "Slack".into(), enabled: true, from: vec!["feedback@slack.com".into()], move_to: "f-receipts".into(), mark_read: true, stop: true, ..Default::default() };
        let body = rule_body(&rule, 3).unwrap();
        assert_eq!(body["conditions"]["fromAddresses"][0]["emailAddress"]["address"], "feedback@slack.com");
        assert_eq!(body["actions"]["moveToFolder"], "f-receipts");
        assert_eq!(body["sequence"], 3);
        let back = parse_rule(&json!({ "id": "r1", "displayName": "Slack", "isEnabled": true, "conditions": body["conditions"], "actions": body["actions"] }));
        assert_eq!(back.from, vec!["feedback@slack.com"]);
        assert!(back.mark_read && back.stop && !back.other);
        assert!(rule_body(&Rule { name: "x".into(), ..Default::default() }, 1).is_err());
        assert!(rule_body(&Rule { name: "x".into(), from: vec!["a@b.c".into()], ..Default::default() }, 1).is_err());
        let fancy = parse_rule(&json!({ "conditions": { "importance": "high" }, "actions": { "forwardTo": [{}] } }));
        assert!(fancy.other);
    }

    #[test]
    fn people_come_with_an_address() {
        let listed = json!({ "value": [
            { "displayName": "Ada Lovelace", "scoredEmailAddresses": [{ "address": "ada@x.org" }] },
            { "displayName": "Room 2", "scoredEmailAddresses": [] },
            { "displayName": "No address" }
        ]});
        assert_eq!(parse_people(&listed), vec![Person { name: "Ada Lovelace".into(), email: "ada@x.org".into() }]);
    }

    #[test]
    fn categories_keep_their_colours() {
        let listed = json!({ "value": [ { "displayName": "Jobs", "color": "preset4" }, { "displayName": " ", "color": "preset1" }, { "displayName": "Home" } ] });
        assert_eq!(parse_categories(&listed), vec![
            Category { name: "Jobs".into(), color: "preset4".into() },
            Category { name: "Home".into(), color: "none".into() },
        ]);
    }

    #[test]
    fn automatic_replies_are_checked() {
        let on = AutoReply { status: "alwaysEnabled".into(), external_audience: "contactsOnly".into(), internal: "Away".into(), ..Default::default() };
        let body = auto_reply_body(&on).unwrap();
        assert_eq!(body["status"], "alwaysEnabled");
        assert!(body.get("scheduledStartDateTime").is_none());
        let mut timed = on.clone();
        timed.status = "scheduled".into();
        assert!(auto_reply_body(&timed).is_err());
        timed.start = "2026-10-24T13:00:00".into();
        timed.end = "2026-10-31T13:00:00".into();
        assert_eq!(auto_reply_body(&timed).unwrap()["scheduledEndDateTime"]["timeZone"], "UTC");
        timed.end = "2026-10-20T13:00:00".into();
        assert!(auto_reply_body(&timed).is_err());
        let mut odd = on.clone();
        odd.status = "sometimes".into();
        assert!(auto_reply_body(&odd).is_err());
        let read = parse_auto_reply(&json!({ "status": "scheduled", "externalAudience": "all", "scheduledStartDateTime": { "dateTime": "2026-10-24T13:00:00.0000000", "timeZone": "UTC" } }));
        assert_eq!(read.start, "2026-10-24T13:00:00");
        assert_eq!(read.external_audience, "all");
    }
}
