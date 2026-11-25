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
| Choose when mail is marked as read | ✅ when opened, after 5 seconds, when you move on, or never (Settings > Mail) |
| Group by date | ✅ Today, Yesterday, weekdays, Last week… |
| Message preview lines | ✅ none, 1 line or 2 lines (Settings > Mail) |
| Density | ✅ Compact, Comfortable or Roomy (Settings > Mail) |
| Toolbar | ✅ Reply, Forward, Archive, Delete and Snooze by name; the rest under More; Archive, Flag, Pin and Delete on a row as you point at it |
| Sort by | ✅ Date, From, Subject, Size, Importance, Flag due date, Attachments, either way round, kept per folder; size and due date show on the row; sorts the mail on this computer |
| Dark mode for designed mail | ✅ recoloured colour by colour, sun button for the original |
| Quoted text folded | ✅ Outlook, Gmail and Apple replies; legal footers too |
| Attachment previews | ✅ PDF viewer, pictures; save one, some or all |
| Block remote pictures | ✅ never, always, or safe senders only; your accounts' domains, and gmail.com or microsoft.com while you have that kind of account, are always safe |
| Unsubscribe | ✅ one-click (RFC 8058) or the sender's page |
| Invite clashes | ✅ an invite says what it clashes with |
| Print | ✅ one message, or save it as a PDF (Ctrl+P) |
| Open in new window | ✅ double-click a message; reply, reply all, forward (the compose window replaces it), print |
| Translate | ➖ |
| Immersive reader | ➖ |

## Writing

| Outlook | Mailroom |
|---|---|
| Undo send | ✅ adjustable delay |
| Schedule send | ✅ Tomorrow morning, Monday morning, or a time; waits in Outbox, where it can be cancelled (Gmail: Mailroom holds it and has to be open at that time) |
| Drafts on the server | ✅ saved while typing |
| Pop-out compose | ✅ keeps the original and its files |
| Reply with meeting | ✅ day, time and place read from the thread |
| Share availability | ✅ pick free half hours from the next five working days (busy times shaded from your calendar); goes in as a list naming the time zone; working hours in Settings > Calendar; no booking link |
| Formatting, colour, highlight | ✅ 12pt Aptos by default, shown as it is sent; Outlook's ribbon order: undo, font, size, strikethrough, alignment, indents; none in an inline reply until Format text |
| Links | ✅ Link on the ribbon or right-click a word: address and text to display, edit or remove; email addresses become mailto: |
| Pictures inline or attached | ✅ Small, Medium, Large or Original |
| Signatures | ✅ per account; pasted Outlook signatures keep their look |
| Templates (My Templates) | ✅ |
| Editor (spelling) | ✅ Hunspell dictionaries, checked before send |
| Importance, read receipt | ✅ |
| Recipient suggestions | ✅ people you mail, plus the directory (**M**) |
| Recipients as chips | ✅ drag between To, Cc and Bcc; Ctrl+A, Backspace and double-click to change |
| Copilot drafting | ✅ "Help me write" with your own Claude or Grok key |
| Copilot summarise / ask | ✅ "Ask across mail", including PDF attachments |
| @mentions | ➖ |
| Loop components | ➖ |

## Organising

| Outlook | Mailroom |
|---|---|
| Archive, delete, move | ✅ with Undo |
| Report junk, Not junk | ✅ blocks or unblocks the sender (Gmail: Spam label), with Undo |
| Multi-select | ✅ |
| Pin | ✅ (this computer) |
| Snooze | ✅ Later today, Tomorrow, This weekend, Next week |
| Follow-up reminders | ✅ only when nobody has answered |
| Flags | ✅ (Gmail: star) |
| Categories | **M** |
| Rules | **M** create from a message, turn off, delete |
| Forwarding warning | **M** a banner while a rule that is on forwards mail elsewhere; Review rule or Dismiss |
| Automatic replies | **M** |
| Favourites | ✅ any folder, category or search folder |
| Search | ✅ mail, people and calendar in one box; dates in plain words; top results first; in Calendar the box lists matching events and Enter opens the nearest |
| Folder list | ✅ Short (the Inbox, the folder you are in, anything unread, Drafts and Outbox while something waits) or Full, as in Outlook (Settings > Mail) |
| Search folders | **M** |
| Create, rename, delete folders | ✅ from the folder right-click menu, subfolders too; Outlook's own folders stay put (Gmail: labels) |
| Sort subfolders A to Z | ✅ from a parent folder's right-click menu, with Undo |
| Collapse or expand all accounts | ✅ right-click an account heading, or Alt+click it |
| Sweep | ✅ delete a sender's mail in a folder: all, all and later ones (**M** rule), all but the latest, or older than 10 days; one Undo |

## Calendar

| Outlook | Mailroom |
|---|---|
| Work week, week, month | ✅ |
| Day view | ✅ also from a week's day heading |
| Events over several days | ✅ start and end dates in the editor; opens whole from any of its days |
| Date and time pickers | ✅ the date opens a month; times type freely or pick from half hours, the end list shows each length; moving the start carries the end along |
| Default meeting length | ✅ Settings > Calendar; 45 minutes unless changed |
| Open a .ics file | ✅ Open with Mailroom: pick the calendar, and its events are added at your local time |
| Several calendars, colours, show and hide | ✅ |
| Recurring events and exceptions | ✅ this event, this and following, or all |
| Drag to move | ✅ timed events to another time or day; all-day chips to another day; any event in Month; an event over several days moves as a whole; a repeating one asks this event or the series |
| Answer invites | ✅ Accept, Tentative, Decline, in the message or from its right-click menu in the list |
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
| Notifications | ✅ once per message, Focused only; a burst of 4 or more is one summary that opens the Inbox |
| Works offline | ✅ local cache; Outbox survives a restart; read, flag, archive, delete and move made offline wait (with a clock on the row) and reach the server in order when it can be reached, for up to seven days |
| Keyboard shortcuts | ✅ Outlook's (Ctrl+R, Ctrl+Shift+R, Insert, Ctrl+Q…) |
| Go to Folder (Ctrl+Y) | ✅ every folder in the profile, Favorites first, type to find |
| Search or run a command (Ctrl+K) | ✅ commands with their shortcuts, folders, events, people, or a search of your mail, from one box |
| Default mail app | ✅ mailto: links (Omarchy) |
| Links to a message | ✅ mailroom://message/… opens one message, even after it was moved; it only opens, and marks nothing read (Omarchy) |
| Follows the desktop theme | ✅ Omarchy colours, font and corners, live |
| Unread count in the bar | ✅ Omarchy bar widget |
| Global shortcut | ✅ Super+Shift+E (Omarchy) |
| Tray icon | ✅ |
