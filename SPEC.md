# Mailroom client spec

The screen is `index.html`. This file is the product scope for the Linux client. The mock can keep showing one-off events and the sample folders.

## Recurring meetings

A meeting can repeat. The event editor gains a Repeat control, set to Does not repeat until someone changes it.

The simple choices are Daily, Weekly, Monthly, and Yearly. Each one starts on the event’s date, repeats every one of that unit, and has no end. Weekly uses the weekday of the start. Monthly uses that day of the month. A month without that day has no occurrence, so a series that starts on the 31st skips February. Yearly uses the same month and day.

Custom repeat sets the interval, and how the series ends: never, on a date, or after a number of occurrences. Weekly custom can include more than one weekday. Monthly custom can be a day number, or a weekday in the month such as the second Tuesday. Times stay in the calendar’s local time. Each occurrence uses the series duration unless that occurrence has been changed.

The week and month grids show the occurrences, not a single block on the first day. All-day series work the same way.

Opening or deleting one occurrence asks which events are affected:

- This event
- This and all following events
- All events in the series

Changing one occurrence stores that change on that date. The rest of the series stays as it was. Deleting one occurrence removes that date and leaves the others.

A recurring invite is one series. The attendees belong to the series. A reply applies to the occurrence that was opened. Choosing all events applies the reply to the series.

The stored shape matches a Microsoft Graph series: one series master, a recurrence pattern and range, expanded instances, and exceptions for dates that differ. That is what lets a series round-trip with the server.

Reminders, Teams links, and free/busy lookup stay out of this decision.

## Mail folders

The client does not create, rename, or delete ordinary mail folders. A search can be saved as a search folder. A search folder holds no mail of its own: it lists messages that match, and it can be deleted. It is stored on the server, so it also appears in Outlook on the web.

It reads each account’s mail folders from the server, including folders beyond Inbox, Drafts, Sent, Archive, and Deleted Items. Nested folders are shown nested, in the order the server gives them. Opening a folder shows the messages stored there. Unread counts and read state come from the server. A folder the server removes disappears on the next sync. Search folders stay out of Move and out of the unread counts.

The sample mock only has the five fixed folders. A real mailbox may have more, and those are listed. Search across all folders includes them. A favourite can pin any folder the server returned, and a category or a search folder too.

Mail can be moved to any folder the server returned: Move to… in the toolbar and the right-click menu, or by dragging a message onto a folder. A move only takes the messages in the folder being viewed, so your replies in Sent stay where they are, and mail only moves within its own account. Rules that file mail are not part of this decision. Archive and delete still use the server’s Archive and Deleted Items folders.
