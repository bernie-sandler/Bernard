# Web dashboard

The dashboard is served by the same process on `PORT` (default 3000). Members sign in with Discord (`identify` scope only). The bot then checks that they're in the server and that their roles grant `dashboard:access`.

## Setup

1. In the Developer Portal → **OAuth2**, copy the Client Secret into `DISCORD_CLIENT_SECRET`. Then add the redirect `${PUBLIC_BASE_URL}/api/auth/callback`, for example `https://bot.example.com/api/auth/callback`.
2. Set `SESSION_SECRET` to 32+ random characters (`openssl rand -hex 32`).
3. Grant access, for example `/permset node:dashboard:access role:@Mod value:true`. The owner, and Administrators while admin bypass is on, always have access.

Behind a reverse proxy, see [Reverse proxy](setup.md#reverse-proxy-nginx-proxy-manager--cloudflare).

## What each page needs

| Page                                                   | Node(s)                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview, Members, member detail                       | `dashboard:access`                                                                                                                                                                                                                                                          |
| Member actions (warn, timeout, kick, ban, roles)       | The same node as the slash command: `admin:warn`, `admin:timeout`, `admin:untimeout`, `admin:kick`, `admin:ban`, `admin:role`. Buttons only appear for actions you're allowed to take.                                                                                      |
| Moderation (all cases) and the history on member pages | `admin:case` (same as `/case`)                                                                                                                                                                                                                                              |
| Warning counts                                         | `admin:warnings`                                                                                                                                                                                                                                                            |
| Logs                                                   | `dashboard:logs` (deleted message content shows up here, so it has its own node, denied by default)                                                                                                                                                                         |
| Command Runner                                         | `dashboard:access` to open it. It lists only the commands you may run, and each run checks the command's own node.                                                                                                                                                          |
| Permissions                                            | `config:permlist` to view. Setting a rule needs `config:permset`, unsetting needs `config:permunset`, and the check tool needs `config:permcheck`.                                                                                                                          |
| Tiers                                                  | `config:tiers` (add, edit, reorder, delete, sync, tenure placement, tier settings)                                                                                                                                                                                          |
| Voice hubs                                             | `config:voice` (hubs and voice settings)                                                                                                                                                                                                                                    |
| Status                                                 | `config:status` (Uptime Kuma connection, embed channel, alerts and ping roles)                                                                                                                                                                                              |
| Role panels                                            | `config:rolepanels` (create, edit, post and delete panels)                                                                                                                                                                                                                  |
| Issue reports                                          | `config:belltower` (Belltower connection test, report settings, whether the panel files tickets or opens Belltower's submit page, report panel, open and closed reports or submit-page tickets)                                                                             |
| Settings                                               | Each section needs its slash command's node: logs `config:logs`; activity and tenure `config:activity`. Moderation DMs, the Administrator bypass and That's crazy have no settings command and use the `config:settings` node. Sections you can't edit are shown read-only. |
| Audit log                                              | `dashboard:audit` (denied by default)                                                                                                                                                                                                                                       |

Everything you can configure with a slash command can also be configured on the dashboard.

- **Command Runner:** builds a form from the command's own option definitions, with member, role and channel pickers and autocomplete. It then runs the command through the same executor as Discord: same permission check, same validation, same `commands` log entry, with source `dashboard`. Options that default to the current channel in Discord (for example `/purge`'s channel) are required here.
- **Settings:** a new log channel gets a test message before it's saved, just like `/logs set`. Invalid values are rejected with the reason.
- **Audit log:** records every configuration change, whether from a slash command, the dashboard or the system, and every dashboard action (member actions, command runs, syncs, logins). Each entry has its before and after values.

Permissions are re-checked on **every request**, so removing someone's role takes effect immediately, without waiting for their session to expire. Dashboard actions call the same services as the slash commands. They create mod cases with `source = dashboard`, and each one is also recorded in the audit log.

## Security

- **Sessions** are stored server-side in SQLite, and only a SHA-256 of the session ID is kept. The cookie is signed, `httpOnly` and `SameSite=Lax`, and `Secure` when `PUBLIC_BASE_URL` is https. Sessions last `SESSION_TTL_HOURS` (default 7 days) and expired ones are cleaned up hourly.
- **CSRF:** every state-changing request needs the per-session `X-CSRF-Token` header. A request whose `Origin` doesn't match `PUBLIC_BASE_URL` is rejected.
- **OAuth:** the flow uses a signed, short-lived `state` cookie. The Discord access token is used once to identify the user and then revoked.
- **Headers:** a strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, and HSTS behind https.
- **Rate limits:** 300 requests per minute per IP, and 20 per minute on the login endpoints.

## Live updates

The dashboard keeps one event stream open per tab (`GET /api/events`). When something changes, the stream tells the dashboard which area changed, and the affected pages refetch through the normal permission-checked API. Changes include a member joining, a new mod case, someone entering a temporary voice channel, a tier sync, or a settings or permission edit. The stream itself never carries data, so it can't leak anything a page wouldn't show.

- The sidebar shows **Live**, **Reconnecting…** or **Offline**. After a reconnect the dashboard refreshes everything, in case it missed changes.
- The stream re-checks the session and `dashboard:access` with every heartbeat and closes once either is gone. Each user can have up to 10 open tabs.
- The Overview still refreshes once a minute for latency and uptime, which don't generate events.

## Notes

- The **online count** is Discord's approximate presence count. It's fetched without the privileged Presence intent and cached for a minute.
- The joins and leaves chart uses the stored `members` log, so it covers at most `retentionDays` (30 days).
