# Mailroom and Outlook, feature by feature

What Mailroom does next to the new Outlook (Windows, web and Mac), area by
area. A weekly check ([outlook-parity.yml](.github/workflows/outlook-parity.yml))
reads Microsoft's own "What's new" pages and the Microsoft 365 roadmap,
compares them with this list, and opens an issue for anything new.

✅ works for every account · **M** Microsoft 365 and Outlook.com only ·
**G** Google only · ➖ not in Mailroom yet

## Accounts

| Outlook | Mailroom |
|---|---|
| Several accounts in one window | ✅ Microsoft 365, Outlook.com and Gmail together, each in its own colour |
| Switch between groups of accounts | ✅ Work, Personal, and Both (calendar) |
| Send as an alias | **M** aliases read from the server |
| Sign in with the provider's own page | ✅ OAuth with PKCE; tokens in the system keyring |

## Reading

| Outlook | Mailroom |
|---|---|
| Conversation view | ✅ newest first, with your replies from Sent |
| Focused Inbox | ✅ Focused and Other, Always move for a sender (Gmail: its inbox tabs) |
| Filters: unread, flagged, mentions… | ✅ Unread, Read, Flagged, Events |
| Group by date | ✅ Today, Yesterday, weekdays, Last week… |
| Dark mode for designed mail | ✅ recoloured colour by colour, sun button for the original |
| Quoted text folded | ✅ Outlook, Gmail and Apple replies; legal footers too |
| Attachment previews | ✅ PDF viewer, pictures; save one, some or all |
| Block remote pictures | ✅ never, always, or safe senders only |
| Unsubscribe | ✅ one-click (RFC 8058) or the sender's page |
| Invite clashes | ✅ an invite says what it clashes with |
| Print | ➖ |
| Translate | ➖ |
| Immersive reader | ➖ |

## Writing

| Outlook | Mailroom |
|---|---|
| Undo send | ✅ adjustable delay |
| Schedule send | **M** Tomorrow morning, Monday morning, or a time |
| Drafts on the server | ✅ saved while typing |
| Pop-out compose | ✅ keeps the original and its files |
| Reply with meeting | ✅ day, time and place read from the thread |
| Formatting, colour, highlight | ✅ |
| Pictures inline or attached | ✅ Small, Medium, Large or Original |
| Signatures | ✅ per account; pasted Outlook signatures keep their look |
| Templates (My Templates) | ✅ |
| Editor (spelling) | ✅ Hunspell dictionaries, checked before send |
| Importance, read receipt | ✅ |
| Recipient suggestions | ✅ people you mail, plus the directory (**M**) |
| Copilot drafting | ✅ "Help me write" with your own Claude or Grok key |
| Copilot summarise / ask | ✅ "Ask across mail", including PDF attachments |
| @mentions | ➖ |
| Loop components | ➖ |

## Organising

| Outlook | Mailroom |
|---|---|
| Archive, delete, move | ✅ with Undo |
| Multi-select | ✅ |
| Pin | ✅ (this computer) |
| Snooze | ✅ Later today, Tomorrow, This weekend, Next week |
| Follow-up reminders | ✅ only when nobody has answered |
| Flags | ✅ (Gmail: star) |
| Categories | **M** |
| Rules | **M** create from a message, turn off, delete |
| Automatic replies | **M** |
| Favourites | ✅ any folder, category or search folder |
| Search | ✅ mail, people and calendar in one box; dates in plain words |
| Search folders | **M** |
| Create, rename, delete folders | ➖ |
| Sweep | ➖ |

## Calendar

| Outlook | Mailroom |
|---|---|
| Work week, week, month | ✅ |
| Day view | ➖ |
| Several calendars, colours, show and hide | ✅ |
| Recurring events and exceptions | ✅ this event, this and following, or all |
| Drag to move | ✅ |
| Answer invites | ✅ Accept, Tentative, Decline |
| Join online meetings | ✅ Teams, Zoom, Google Meet and Webex |
| New Teams meeting | **M** |
| Scheduling assistant | **M** each person's day and times that suit everyone |
| Reminders | ✅ desktop notifications |
| Shared calendars | ✅ read-only ones stay read-only |
| Create a new calendar | ➖ |

## People

| Outlook | Mailroom |
|---|---|
| Contacts: add, edit, delete | **M** |
| Contact card | ✅ |
| Directory lookup | **M** |

## On the desktop

| Outlook | Mailroom |
|---|---|
| Notifications | ✅ once per message, Focused only |
| Works offline | ✅ local cache; Outbox survives a restart |
| Keyboard shortcuts | ✅ Outlook's (Ctrl+R, Ctrl+Shift+R, Insert, Ctrl+Q…) |
| Default mail app | ✅ mailto: links (Omarchy) |
| Follows the desktop theme | ✅ Omarchy colours, font and corners, live |
| Unread count in the bar | ✅ Omarchy bar widget |
| Global shortcut | ✅ Super+Shift+E (Omarchy) |
| Tray icon | ✅ |
