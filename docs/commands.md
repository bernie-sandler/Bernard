# Commands and moderation

Every command checks a permission node before it runs (see [Permissions](permissions.md)). Commands for specific features are listed on their own pages: [voice](voice.md), [tiers and activity](tiers.md), [status](status.md), [role panels](role-panels.md) and [issue reports](issue-reports.md).

| Command                                                    | Node                               | Notes                                                                                                                                    |
| ---------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/help`, `/ping`, `/userinfo [user]`, `/serverinfo`        | `public:*`                         | Open to everyone by default. `/help` lists only commands you can use.                                                                    |
| `/permset`, `/permunset`, `/permlist`, `/permcheck`        | `config:perm*`                     | Manage the permission rules.                                                                                                             |
| `/ban user [reason] [duration] [delete_days]`              | `admin:ban`                        | With `duration` (e.g. `7d`, max 365d) it's a temporary ban, lifted automatically.                                                        |
| `/unban`, `/kick`                                          | `admin:unban`, `admin:kick`        |                                                                                                                                          |
| `/timeout user duration [reason]`, `/untimeout`            | `admin:timeout`, `admin:untimeout` | Max 28 days (a Discord limit). Members with Administrator can't be timed out.                                                            |
| `/warn user reason`                                        | `admin:warn`                       |                                                                                                                                          |
| `/warnings list user`, `/warnings remove case`             | `admin:warnings`                   | Removing a warning keeps it in history and marks it removed.                                                                             |
| `/purge amount [user] [channel]`                           | `admin:purge`                      | 1-100 messages. With `user` it scans up to 500 recent messages. Skips pinned messages and anything older than 14 days, and reports both. |
| `/slowmode seconds [channel]`                              | `admin:slowmode`                   | 0 turns it off.                                                                                                                          |
| `/lock [channel]`, `/unlock [channel]`                     | `admin:lock`, `admin:unlock`       | Lock denies sending for @everyone. Unlock restores the previous overwrite.                                                               |
| `/role add`, `/role remove`                                | `admin:role`                       | Refuses roles at or above the bot's or your highest role, plus managed roles.                                                            |
| `/nick user [nickname]`                                    | `admin:nick`                       | Leave `nickname` empty to reset it.                                                                                                      |
| `/announce channel message [embed] [title]`                | `admin:announce`                   | Write `\n` in `message` to start a new line. User and role mentions ping; @everyone never does.                                          |
| `/case id`                                                 | `admin:case`                       |                                                                                                                                          |
| `/logs set`, `/logs disable`, `/logs list`, `/logs config` | `config:logs`                      | See [Logs](logs.md).                                                                                                                     |
| `/thatscrazy user`                                         | `public:thatscrazy`                | Vote on someone who said something crazy. See [That's crazy](thats-crazy.md).                                                            |
| `/crazy strikes user`, `/crazy reset user`                 | `admin:crazy`                      | See [That's crazy](thats-crazy.md).                                                                                                      |

Commands that default to the current channel (`purge`, `slowmode`, `lock`, `unlock`) require a channel when run from the dashboard.

## Moderation behaviour

- Every action creates a numbered **mod case** with its source (`slash`, `dashboard`, `discord` or `system`) and posts it to the `moderation` log.
- **Hierarchy checks:** you can't act on yourself, the owner, the bot, or anyone whose highest role is at or above yours. The bot can't act on anyone at or above its own highest role either.
- **DMs:** the target gets a DM before a ban or kick, and after a timeout or warning. Turn this off with the `moderation.dmOnAction` setting. The bot's reply says when a DM couldn't be delivered.
- **Discord's audit log** shows the real moderator, because the bot puts `(by Name [id])` in the reason.
- **Actions done in Discord's own UI** (ban, unban, kick, timeout) are picked up from the audit log and recorded as cases with source `discord`. This needs the View Audit Log permission.
