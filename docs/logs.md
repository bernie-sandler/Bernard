# Logs

| Type         | Events                                                                       |
| ------------ | ---------------------------------------------------------------------------- |
| `moderation` | Every mod case, warning removals                                             |
| `members`    | Joins (with account age and a new-account warning), leaves, nickname changes |
| `messages`   | Edits (before/after), deletes (content, attachment names), bulk deletes      |
| `voice`      | Joins, leaves and moves                                                      |
| `server`     | Role and channel create/delete/update, member role changes                   |
| `commands`   | Every command use: who, what, arguments, allowed/denied, slash or dashboard  |

Route each type to a channel with `/logs set` (node `config:logs`), or on the dashboard's Settings page.

- `/logs set` posts a test message first and refuses channels the bot can't write to.
- Entries are always **stored in the database**, even for types not routed to a channel, so the dashboard can search them. Stored entries are pruned after `retentionDays` (default 30), checked daily at 03:30 and at startup.
- Message content for edit/delete logs comes from a **bounded in-memory cache** (default 5000 messages, set with `/logs config cache_size`). Edits and deletes of messages sent before the bot started, or already evicted, are logged as "not cached". Discord doesn't report who deleted a message, so delete logs don't include that.
- Events in log channels themselves are ignored, and bot messages aren't logged.
- Create, delete and update events for temporary voice channels are left out of the `server` log. Joins, leaves and moves still appear in the `voice` log.
