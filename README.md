<p align="center">
  <img src="shared/assets/logo.png" alt="Bernard logo" width="300">
</p>

<h1 align="center">Bernard</h1>

<p align="center">
  <strong>A self-hosted Discord bot and admin dashboard for your server.</strong><br>
  <em>Thoughtful server management, without the bloat.</em>
</p>

<p align="center">
  <img alt="Project status: In Development" src="https://img.shields.io/badge/status-In%20Development-3178C6">
</p>

<p align="center">
  <img alt="Built with Node.js" src="https://img.shields.io/badge/Node.js-339933?logo=nodedotjs&logoColor=white">
  <img alt="Built with TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white">
  <img alt="Built with Discord.js" src="https://img.shields.io/badge/Discord.js-5865F2?logo=discord&logoColor=white">
  <img alt="Built with SQLite" src="https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white">
  <img alt="Built with Docker" src="https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white">
</p>

---

A self-hosted Discord bot plus admin dashboard for **one private server**. Bot, API and dashboard run in a single Node process on SQLite.

**What it does**

- **Permissions:** a role-based permission system layered on Discord, with wildcards (`admin:*`, `*`) and a `/permcheck` that shows which rule decided.
- **Moderation:** ban (including temporary bans), kick, timeout, warn, purge, slowmode, lock, roles, nicknames and announcements. Every action becomes a numbered mod case, including bans and kicks done in Discord's own UI.
- **Logs:** moderation, members, messages, voice, server and commands, each routed to its own channel and stored for searching.
- **Join-to-create voice:** public or private hubs, owner commands, and startup clean-up so a restart never leaves orphan channels.
- **Tenure and activity tiers:** up to 10 tiers that need both days in the server and recent activity, with stacking or highest-only modes and step-by-step demotion down to a floor.
- **Web dashboard:** Discord login, gated by the same permission nodes as the commands, with live updates. Pages: Overview, Members, Moderation, Logs, Command Runner, Permissions, Tiers, Voice hubs, Settings and Audit log.

## Requirements

- Node.js 22.12+ for local development (the Docker image uses Node 26 LTS)
- pnpm 10 (`npm i -g pnpm`)
- Docker (for deployment)

## Discord Developer Portal setup

1. Create an application at <https://discord.com/developers/applications>.
2. **General Information:** copy the **Application ID** into `DISCORD_CLIENT_ID`.
3. **Bot:**
   - Click **Reset Token** and put the token in `DISCORD_TOKEN`.
   - Under **Privileged Gateway Intents**, enable **Server Members Intent** (join tracking, tenure backfill, role resolution) and **Message Content Intent** (message edit/delete logs).
   - Turn **Public Bot** off so nobody else can invite it.
4. **OAuth2 (dashboard login):**
   - Copy the **Client Secret** into `DISCORD_CLIENT_SECRET`.
   - Under **Redirects**, add `${PUBLIC_BASE_URL}/api/auth/callback`, for example `https://bot.example.com/api/auth/callback`. It must match exactly.
5. In Discord, enable **Settings → Advanced → Developer Mode**. Then right-click your server, choose **Copy Server ID** and put it in `GUILD_ID`.
6. Generate the invite link and open it:

   ```bash
   pnpm invite-url
   ```
7. In **Server Settings → Roles**, drag the bot's role **above every role it should manage** (tier roles, roles granted with `/role add`). Discord won't let a bot manage roles at or above its own.

### Intents used

| Intent           | Privileged | Why                                                    |
| ---------------- | ---------- | ------------------------------------------------------ |
| Guilds           | no         | Channels, roles, guild info                            |
| GuildMembers     | **yes**    | Joins/leaves, tenure backfill, permission role lookups |
| GuildMessages    | no         | Message logs, activity points                          |
| MessageContent   | **yes**    | Edit/delete log content                                |
| GuildVoiceStates | no         | Voice logs, join-to-create, voice activity             |
| GuildModeration  | no         | Ban events, audit log entries                          |

### Bot permissions

`pnpm invite-url` prints the exact list and the permission integer: View Channels, Send Messages, Embed Links, Read Message History, Manage Messages, Manage Channels, Manage Roles, Kick Members, Ban Members, Moderate Members, Manage Nicknames, Move Members, Connect and View Audit Log. The scopes are `bot` and `applications.commands`.

## Local development

```bash
pnpm install
```

```bash
cp .env.example .env
```

Fill in `.env`, then start the bot in watch mode:

```bash
pnpm dev
```

The database is created at `DATABASE_PATH` (`./data/bernard.db` locally) and migrations run on startup.

| Script                      | What it does                                                                |
| --------------------------- | --------------------------------------------------------------------------- |
| `pnpm dev`                  | Run with hot reload (tsx)                                                   |
| `pnpm dev:web`              | Dashboard dev server with hot reload (port 5173)                            |
| `pnpm build` / `pnpm start` | Compile the server and dashboard to `dist/` and run                         |
| `pnpm demo`                 | Dashboard demo with fake data, no Discord needed (port 3100)                |
| `pnpm icons`                | Rebuild the dashboard favicons and login logo from `shared/assets/logo.png` |
| `pnpm test`                 | Unit tests (vitest)                                                         |
| `pnpm test:coverage`        | Tests with a coverage report (`coverage/index.html`)                        |
| `pnpm typecheck`            | TypeScript, strict                                                          |
| `pnpm lint` / `pnpm format` | Biome                                                                       |
| `pnpm db:generate`          | Generate a migration after editing `src/db/schema.ts`                       |
| `pnpm invite-url`           | Print the bot invite URL and the required permissions                       |

## Environment variables

See [.env.example](.env.example) for the full annotated list. The app validates everything with zod at startup and exits with a list of every problem if something is wrong.

| Variable                   | Required     | Default                 | Notes                                                        |
| -------------------------- | ------------ | ----------------------- | ------------------------------------------------------------ |
| `DISCORD_TOKEN`            | yes          |                         | Bot token                                                    |
| `DISCORD_CLIENT_ID`        | yes          |                         | Application ID                                               |
| `GUILD_ID`                 | yes          |                         | The one server this bot serves                               |
| `DASHBOARD_ENABLED`        | no           | `true`                  |                                                              |
| `DISCORD_CLIENT_SECRET`    | if dashboard |                         | OAuth2 client secret                                         |
| `SESSION_SECRET`           | if dashboard |                         | 32+ random characters                                        |
| `PUBLIC_BASE_URL`          | no           | `http://localhost:3000` | Used for the OAuth redirect                                  |
| `TRUST_PROXY`              | no           | `false`                 | `true`, a hop count, or proxy IPs/CIDRs                      |
| `SESSION_TTL_HOURS`        | no           | `168`                   |                                                              |
| `COOKIE_SECURE`            | no           | auto                    | `true` when the base URL is https                            |
| `DATABASE_PATH`            | no           | `/data/bernard.db`      |                                                              |
| `HOST` / `PORT`            | no           | `0.0.0.0` / `3000`      |                                                              |
| `LOG_LEVEL` / `LOG_PRETTY` | no           | `info` / `false`        | pino JSON logs                                               |
| `PUID` / `PGID`            | no           | `1000` / `1000`         | Docker only: user and group that run the app and own `/data` |
| `UMASK`                    | no           | `0022`                  | Docker only: file-creation mask                              |

## Deploying with Docker

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

The project's `./data` folder is mounted at `/data`, so the SQLite database is `./data/bernard.db` on the host. Health check: `GET /healthz`.

The container starts as root only long enough to give `PUID:PGID` (default `1000:1000`) ownership of `/data`, then runs the app as that user with `UMASK`. On a bind mount, set them to the owner you want on the host, for example `PUID=99` and `PGID=100` on Unraid. Starting the container with `--user` skips this and runs as that user, so `/data` must already be writable by it.

Behind Nginx Proxy Manager or Cloudflare, set `PUBLIC_BASE_URL` to the public https URL and `TRUST_PROXY` to your proxy (for example `TRUST_PROXY=1`).

## Backups

Everything lives in one SQLite file. Take a consistent online backup with SQLite's backup API:

```bash
docker compose exec bernard node -e "require('better-sqlite3')('/data/bernard.db').backup('/data/backup.db').then(()=>console.log('ok'))"
```

The backup appears on the host at `./data/backup.db`.

To restore or move to another machine: stop the container, delete `bernard.db`, `bernard.db-wal` and `bernard.db-shm` from `./data`, copy the backup in as `./data/bernard.db`, and start it again. Copy a backup made this way rather than a live `bernard.db`, which can leave recent changes behind in the `-wal` file.

## Commands

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
| `/logs set`, `/logs disable`, `/logs list`, `/logs config` | `config:logs`                      |                                                                                                                                          |

Commands that default to the current channel (`purge`, `slowmode`, `lock`, `unlock`) require a channel when run from the dashboard.

### Moderation behaviour

- Every action creates a numbered **mod case** with its source (`slash`, `dashboard`, `discord` or `system`) and posts it to the `moderation` log.
- **Hierarchy checks:** you can't act on yourself, the owner, the bot, or anyone whose highest role is at or above yours. The bot can't act on anyone at or above its own highest role either.
- **DMs:** the target gets a DM before a ban or kick, and after a timeout or warning. Turn this off with the `moderation.dmOnAction` setting. The bot's reply says when a DM couldn't be delivered.
- **Discord's audit log** shows the real moderator, because the bot puts `(by Name [id])` in the reason.
- **Actions done in Discord's own UI** (ban, unban, kick, timeout) are picked up from the audit log and recorded as cases with source `discord`. This needs the View Audit Log permission.

## Logs

| Type         | Events                                                                       |
| ------------ | ---------------------------------------------------------------------------- |
| `moderation` | Every mod case, warning removals                                             |
| `members`    | Joins (with account age and a new-account warning), leaves, nickname changes |
| `messages`   | Edits (before/after), deletes (content, attachment names), bulk deletes      |
| `voice`      | Joins, leaves and moves                                                      |
| `server`     | Role and channel create/delete/update, member role changes                   |
| `commands`   | Every command use: who, what, arguments, allowed/denied, slash or dashboard  |

- `/logs set` posts a test message first and refuses channels the bot can't write to.
- Entries are always **stored in the database**, even for types not routed to a channel, so the dashboard can search them. Stored entries are pruned after `retentionDays` (default 30), checked daily at 03:30 and at startup.
- Message content for edit/delete logs comes from a **bounded in-memory cache** (default 5000 messages, set with `/logs config cache_size`). Edits and deletes of messages sent before the bot started, or already evicted, are logged as "not cached". Discord doesn't report who deleted a message, so delete logs don't include that.
- Events in log channels themselves are ignored, and bot messages aren't logged.
- Create, delete and update events for temporary voice channels are left out of the `server` log. Joins, leaves and moves still appear in the `voice` log.

## Join-to-create voice

Members join a **hub** voice channel. The bot then creates a channel for them in the hub's category, makes them the owner and moves them in.

```
/voice hub add channel:#➕-join type:public category:#Temp Voice name_template:{user}'s Channel
/voice hub add channel:#🔒-private type:private category:#Temp Voice hide:false
/voice settings grace_seconds:10 cooldown_seconds:30 owner_leave:transfer
```

- **Public** hubs create channels anyone can join. **Private** hubs deny Connect for @everyone, and the channel stays visible unless `hide:true`. The owner, and anyone they `/vc invite`, can connect.
- Name templates support `{user}` (display name), `{username}` and `{count}` (the channel's number for that hub).
- An empty channel is deleted after `grace_seconds` (default 10). A reconnect within that window keeps it.
- When the owner leaves a channel that still has people in it:
  - with `owner_leave:transfer` (the default), the longest-present member becomes owner;
  - with `owner_leave:claim`, anyone inside can `/vc claim` it.
- **Abuse protection:** each member can create one channel per `cooldown_seconds` (default 30). Someone on cooldown is disconnected from the hub with a short notice in the hub's text chat, which deletes itself after 10 seconds.
- **On startup** the bot deletes empty tracked channels, forgets channels that no longer exist, fixes owners who left while it was offline, and creates channels for anyone already waiting in a hub. A restart leaves no orphan channels.
- If a hub channel is deleted, its hub configuration is removed too. Temporary channels count towards Discord's limit of 50 channels per category. When a category is full, the member gets a notice instead of a channel.

| Owner command            | Node                         | What it does                                                                                                 |
| ------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/vc lock`, `/vc unlock` | `voice:lock`, `voice:unlock` | Deny or allow Connect for @everyone. People already inside can still reconnect after a lock.                 |
| `/vc limit limit`        | `voice:limit`                | User limit, 0-99 (0 = unlimited).                                                                            |
| `/vc rename name`        | `voice:rename`               | Discord allows 2 renames per channel per 10 minutes. A blocked rename replies with how many minutes to wait. |
| `/vc invite user`        | `voice:invite`               | Allow a member to connect even when the channel is locked or private.                                        |
| `/vc kick user`          | `voice:kick`                 | Disconnect a member and block them from rejoining.                                                           |
| `/vc transfer user`      | `voice:transfer`             | Give ownership to someone in the channel.                                                                    |
| `/vc claim`              | `voice:claim`                | Take over a channel whose owner left.                                                                        |

`voice:*` is allowed for @everyone by default, but these commands only work for the owner of the temporary channel you're in. `/voice ...` needs `config:voice`.

## Tenure, activity and tiers

### Tenure

- **Tenure** is the number of days since the member joined.
- **Backfill:** at every startup the bot syncs the member list. New members are backfilled from Discord's join date, and anyone who left while the bot was offline is marked as gone.
- **First join:** Discord only reports the most recent join, so the first join from before the bot arrived can't be recovered. From then on, the bot keeps the earliest join it has seen.
- **Rejoins:** when someone leaves and rejoins, tenure restarts by default. Use `/activity settings reset_tenure_on_rejoin:false` to keep it. A newer join date seen at startup counts as a rejoin.

### Activity

- **No message content is stored.** The score is built from two numbers kept per member per day: messages that earned a point, and voice minutes.
- **Messages:** 1 point per message, at most once per `message_cooldown` seconds (default 60) per member, so spamming doesn't farm points.
- **Voice:** points per minute in voice (default 1).
  - AFK-channel time doesn't count, nor does time with no other human in the channel (bots don't count as company).
  - Self-deafened time doesn't count by default. Change this with `count_deafened`.
- **Rolling window:** the score used for tiers covers the last `window_days` (default 30). Weights are applied when scores are read, so changing them re-scores past activity too.
- **History:** daily rows are kept for 400 days, for the dashboard charts.

```
/activity settings message_cooldown:60 points_per_message:1 points_per_voice_minute:1 window_days:30
```

### Tiers

You can have up to 10 tiers. Each has a name, a role, a minimum tenure in days and a minimum activity score over the window. A member earns a tier when they meet **both** thresholds. Set either one to 0 to make a tenure-only or activity-only tier.

```
/tiers add name:Newcomer role:@Newcomer min_tenure_days:0 min_activity:0
/tiers add name:Regular role:@Regular min_tenure_days:30 min_activity:100
/tiers add name:Veteran role:@Veteran min_tenure_days:365 min_activity:0
/tiers settings mode:highest_only demotion:true grace_days:7 floor:Member sync_minutes:60
/tiers exclude role:@Staff
/tiers check
/tiers sync
```

| Command                                      | Node              | What it does                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tiers list`                                | `config:tiers`    | Tiers, member counts, settings, last sync and any problems                                                                                                                                                                                                                                                                                                                                                              |
| `/tiers add`, `/tiers edit`, `/tiers remove` | `config:tiers`    | Manage tiers. Position 1 is the lowest.                                                                                                                                                                                                                                                                                                                                                                                 |
| `/tiers check`                               | `config:tiers`    | Checks that tier roles exist, aren't managed, and sit below the bot's highest role. Also warns when a higher tier is no harder to reach than the one below it.                                                                                                                                                                                                                                                          |
| `/tiers sync`                                | `config:tiers`    | Re-evaluate every member now                                                                                                                                                                                                                                                                                                                                                                                            |
| `/tiers tenure-sync [preview]`               | `config:tiers`    | One-off placement by tenure alone. Ignores activity requirements and puts every member exactly in the tier their tenure earns, adding and removing tier roles (including higher ones they hold but haven't earned). `preview:true` lists how many members would gain or lose each tier without changing anything. Doesn't affect the regular sync schedule. Useful right after install, before activity history exists. |
| `/tiers settings`, `/tiers exclude`          | `config:tiers`    | Mode, demotion and grace period, demotion floor (`floor:none` clears it), sync interval, excluded roles                                                                                                                                                                                                                                                                                                                 |
| `/activity settings`                         | `config:activity` | Scoring weights, cooldown, window, tenure reset on rejoin                                                                                                                                                                                                                                                                                                                                                               |
| `/rank [user]`                               | `public:rank`     | Tenure, activity score and breakdown, leaderboard position, current tier and what's needed for the next one. The reply is public.                                                                                                                                                                                                                                                                                       |

- **Mode:** `highest_only` (the default) keeps just the highest earned tier role and removes lower ones. `stack` keeps every earned tier role.
- **Demotion** is on by default and goes **one tier at a time**. A member who falls below a tier they hold keeps it for `grace_days` (default 7), then drops one tier, and a fresh grace period starts. This repeats until they reach a tier they earn, so a long absence walks someone down slowly instead of dropping them to the bottom. With demotion off, held tiers are never removed.
- **Floor** (`/tiers settings floor:Member`): members who meet the floor tier's **tenure** requirement are never demoted below it. They're also placed in it without any activity, so long-standing members never end up as New Comers. Members short of that tenure follow the normal rules.
- **Excluded roles** (for example staff, or bots, which are always skipped) are left alone.
- **When tiers are evaluated:**
  - everyone, every `sync_minutes` (default 60);
  - a single member, a few seconds after their score crosses a tier threshold, and when they join (so a tier with 0 tenure and 0 activity applies straight away);
  - everyone, on demand with `/tiers sync`.
- Tier changes are posted to the `members` log.
- **The bot's role must sit above every tier role.** Tier roles it can't manage are skipped and reported by `/tiers check`, `/tiers list` and a warning at startup.

## Web dashboard

The dashboard is served by the same process on `PORT` (default 3000). Members sign in with Discord (`identify` scope only). The bot then checks that they're in the server and that their roles grant `dashboard:access`.

### Setup

1. In the Developer Portal → **OAuth2**, copy the Client Secret into `DISCORD_CLIENT_SECRET`. Then add the redirect `${PUBLIC_BASE_URL}/api/auth/callback`, for example `https://bot.example.com/api/auth/callback`.
2. Set `SESSION_SECRET` to 32+ random characters (`openssl rand -hex 32`).
3. Grant access, for example `/permset node:dashboard:access role:@Mod value:true`. The owner, and Administrators while admin bypass is on, always have access.

### What each page needs

| Page                                                   | Node(s)                                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview, Members, member detail                       | `dashboard:access`                                                                                                                                                                                                                                             |
| Member actions (warn, timeout, kick, ban, roles)       | The same node as the slash command: `admin:warn`, `admin:timeout`, `admin:untimeout`, `admin:kick`, `admin:ban`, `admin:role`. Buttons only appear for actions you're allowed to take.                                                                         |
| Moderation (all cases) and the history on member pages | `admin:case` (same as `/case`)                                                                                                                                                                                                                                 |
| Warning counts                                         | `admin:warnings`                                                                                                                                                                                                                                               |
| Logs                                                   | `dashboard:logs` (deleted message content shows up here, so it has its own node, denied by default)                                                                                                                                                            |
| Command Runner                                         | `dashboard:access` to open it. It lists only the commands you may run, and each run checks the command's own node.                                                                                                                                             |
| Permissions                                            | `config:permlist` to view. Setting a rule needs `config:permset`, unsetting needs `config:permunset`, and the check tool needs `config:permcheck`.                                                                                                             |
| Tiers                                                  | `config:tiers` (add, edit, reorder, delete, sync, tenure placement, tier settings)                                                                                                                                                                             |
| Voice hubs                                             | `config:voice` (hubs and voice settings)                                                                                                                                                                                                                       |
| Settings                                               | Each section needs its slash command's node: logs `config:logs`; activity and tenure `config:activity`. Moderation DMs and the Administrator bypass have no slash command and use the new `config:settings` node. Sections you can't edit are shown read-only. |
| Audit log                                              | `dashboard:audit` (denied by default)                                                                                                                                                                                                                          |

Everything you can configure with a slash command can also be configured on the dashboard.

- **Command Runner:** builds a form from the command's own option definitions, with member, role and channel pickers and autocomplete. It then runs the command through the same executor as Discord: same permission check, same validation, same `commands` log entry, with source `dashboard`. Options that default to the current channel in Discord (for example `/purge`'s channel) are required here.
- **Settings:** a new log channel gets a test message before it's saved, just like `/logs set`. Invalid values are rejected with the reason.
- **Audit log:** records every configuration change, whether from a slash command, the dashboard or the system, and every dashboard action (member actions, command runs, syncs, logins). Each entry has its before and after values.

Permissions are re-checked on **every request**, so removing someone's role takes effect immediately, without waiting for their session to expire. Dashboard actions call the same services as the slash commands. They create mod cases with `source = dashboard`, and each one is also recorded in the audit log.

### Security

- **Sessions** are stored server-side in SQLite, and only a SHA-256 of the session ID is kept. The cookie is signed, `httpOnly` and `SameSite=Lax`, and `Secure` when `PUBLIC_BASE_URL` is https. Sessions last `SESSION_TTL_HOURS` (default 7 days) and expired ones are cleaned up hourly.
- **CSRF:** every state-changing request needs the per-session `X-CSRF-Token` header. A request whose `Origin` doesn't match `PUBLIC_BASE_URL` is rejected.
- **OAuth:** the flow uses a signed, short-lived `state` cookie. The Discord access token is used once to identify the user and then revoked.
- **Headers:** a strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, and HSTS behind https.
- **Rate limits:** 300 requests per minute per IP, and 20 per minute on the login endpoints.

### Reverse proxy (Nginx Proxy Manager / Cloudflare)

- Set `PUBLIC_BASE_URL` to the public https URL and `TRUST_PROXY=1` (one proxy hop), or to your proxy's IP or CIDR. Behind Cloudflare plus Nginx Proxy Manager, use `TRUST_PROXY=2`.
- Proxy everything (`/`, `/api`, `/healthz`) to the container's port 3000. No WebSocket configuration is needed.
- Live updates use a long-lived HTTP response (Server-Sent Events). The bot sends `X-Accel-Buffering: no`, so Nginx Proxy Manager streams it without extra config. A heartbeat every 25 seconds keeps Cloudflare's idle timeout from cutting it off.

### Live updates

The dashboard keeps one event stream open per tab (`GET /api/events`). When something changes, the stream tells the dashboard which area changed, and the affected pages refetch through the normal permission-checked API. Changes include a member joining, a new mod case, someone entering a temporary voice channel, a tier sync, or a settings or permission edit. The stream itself never carries data, so it can't leak anything a page wouldn't show.

- The sidebar shows **Live**, **Reconnecting…** or **Offline**. After a reconnect the dashboard refreshes everything, in case it missed changes.
- The stream re-checks the session and `dashboard:access` with every heartbeat and closes once either is gone. Each user can have up to 10 open tabs.
- The Overview still refreshes once a minute for latency and uptime, which don't generate events.

### Development

Run the bot and API with `pnpm dev`, and the dashboard with hot reload with `pnpm dev:web`. Open <http://localhost:5173>. Set `PUBLIC_BASE_URL=http://localhost:5173` and add `http://localhost:5173/api/auth/callback` as a redirect in the Developer Portal, so login and the same-origin checks go through Vite's proxy.

To look around without a bot, run `pnpm build:web && pnpm demo` and open <http://localhost:3100>. This runs the real API and dashboard against in-memory fake data, and "Log in with Discord" signs you straight in as the owner.

### Notes

- The **online count** is Discord's approximate presence count. It's fetched without the privileged Presence intent and cached for a minute.
- The joins and leaves chart uses the stored `members` log, so it covers at most `retentionDays` (30 days).

## Permissions model

Nodes look like `category:command` (for example `admin:ban`), with wildcards `category:*` and `*`. Categories: `admin`, `config`, `public`, `voice`, `dashboard`.

1. The **server owner** always passes.
2. Members with Discord's **Administrator** permission pass, while the `adminBypass` setting is on (the default).
3. The **most specific** matching rule wins: `admin:ban`, then `admin:*`, then `*`.
4. At the same specificity, **named roles beat @everyone**, and between named roles **deny wins**.
5. With no matching rule, `public:*` and `voice:*` are allowed and everything else is denied.

Examples:

```
/permset node:admin:* role:@Mod value:true
/permset node:admin:ban role:@Mod value:false
/permcheck user:@someone node:admin:ban
```

Slash commands register without `default_member_permissions`, so Discord shows every command to everyone. The bot checks permissions when a command runs and replies privately when it denies one.

## Adding a command

1. Create or extend a file in `src/bot/commands/`:

   ```ts
   export const hello = defineCommand({
     name: 'hello',
     description: 'Say hello',
     node: 'public:hello',              // permission node checked before execute
     options: { who: opt.user({ description: 'Who to greet', required: true }) },
     async execute(ctx, input) {         // input is validated and typed
       return ok(`Hello <@${input.who}>!`);
     },
   });
   ```
2. Add it to `allCommands` in `src/bot/commands/index.ts`.
3. Put the real logic in a service under `src/services/`, so the dashboard can call the same function.
4. Restart. Commands re-register automatically when their definitions change.

The same definition drives the Discord registration JSON, the zod input validation and the dashboard Command Runner form, so a new command shows up in the Command Runner with no extra work. Both entry points go through `CommandExecutor`, which checks the permission, validates the input, runs the command and writes the `commands` log. If the command changes configuration, record it with `services.audit` so it appears in the Audit log and triggers live updates.

## Testing

```bash
pnpm test
```

```bash
pnpm test:coverage
```

- The tests use in-memory SQLite and fake Discord ports (`tests/helpers.ts`), so they need no bot token.
- **What's covered:**
  - the permission resolver (every precedence case);
  - tier qualification, demotion and the floor;
  - activity cooldowns and voice-minute rules;
  - the temporary voice channel lifecycle and startup reconcile;
  - moderation guards, purge and temporary bans;
  - log routing;
  - the OAuth flow, sessions, CSRF and per-route permission gates;
  - every dashboard endpoint;
  - the live event stream;
  - the job scheduler.
- `pnpm test:coverage` measures our own code and leaves out thin discord.js glue (adapters, gateway event handlers, startup wiring), which only a live gateway can exercise. An HTML report is written to `coverage/`.
- `pnpm demo` serves the real dashboard and API on fake data for hands-on checks.

## CI and releases

GitHub Actions run on every pull request to `main` and every push to `main` ([`ci.yml`](.github/workflows/ci.yml)): Biome lint, typecheck, tests with coverage on Node 22 and 26, the production build, and a Docker image build. A final **CI passed** job sums them up. Mark it as the required status check in the `main` branch protection rule so pull requests can only merge when everything is green.

[Dependabot](.github/dependabot.yml) opens weekly PRs (Mondays) for pnpm packages, GitHub Actions and the Docker base image, with minor and patch bumps grouped into one PR per category. [`dependabot-auto-merge.yml`](.github/workflows/dependabot-auto-merge.yml) queues patch and minor PRs to squash-merge once **CI passed** is green, and comments on major updates so you review them by hand. Auto-merge needs **Settings → General → Allow auto-merge** turned on.

To release ([`release.yml`](.github/workflows/release.yml)):

1. Bump `version` in `package.json` and merge it to `main`.
2. Tag that commit and push the tag:

   ```bash
   git tag v0.2.0
   ```

   ```bash
   git push origin v0.2.0
   ```

The release workflow checks that the tag matches `package.json` and is on `main`, runs the full CI suite again, publishes a multi-arch (amd64/arm64) image to `ghcr.io/bernie-sandler/bernard` tagged with the version, `major.minor` and `latest`, and creates a GitHub release with generated notes. A tag with a suffix, like `v0.2.0-rc.1`, becomes a prerelease and leaves `latest` alone.

## Troubleshooting

| Symptom                                                   | Fix                                                                                                                                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup says "Invalid environment configuration"          | Every problem is listed. Compare your `.env` with `.env.example`.                                                                                                                        |
| "Discord refused the privileged intents"                  | Developer Portal → Bot → enable **Server Members Intent** and **Message Content Intent**.                                                                                                |
| "The bot is not in GUILD_ID"                              | Invite it with `pnpm invite-url`, which is also printed in the log. Check that `GUILD_ID` is your server's ID.                                                                           |
| "I'm missing a Discord permission…" or tier roles skipped | Move the bot's role above every role it manages. `/tiers check` lists the problem roles.                                                                                                 |
| Admin commands say "You don't have permission"            | Only the owner (and Administrators with admin bypass) can use them until you `/permset`. Use `/permcheck` to see which rule decided.                                                     |
| Dashboard login loops back to the login page              | `PUBLIC_BASE_URL` must be exactly the URL in your browser, and the Developer Portal redirect must be `${PUBLIC_BASE_URL}/api/auth/callback`. Over plain http, set `COOKIE_SECURE=false`. |
| Dashboard says "Cross-origin request blocked"             | `PUBLIC_BASE_URL` doesn't match the address you're using (for example localhost vs 127.0.0.1, or a different port).                                                                      |
| Behind a proxy, all visitors share one rate limit or IP   | Set `TRUST_PROXY` (see Reverse proxy).                                                                                                                                                   |
| Sidebar stuck on "Reconnecting…"                          | Your proxy is buffering or timing out the event stream. Disable buffering for `/api/events`. The rest of the dashboard works without it.                                                 |
| Message delete logs say "not cached"                      | The message was sent before the bot started, or was evicted from the cache. Raise `/logs config cache_size` if needed.                                                                   |

## Project layout

```
src/
  config/     env + settings schemas (zod)
  db/         Drizzle schema, migrations, client
  shared/     types and helpers shared with the dashboard (option descriptors, permission nodes, API shapes)
  services/   all business logic: permissions, commands, moderation, logs, voice, members, activity,
              tiers, settings, audit, sessions, dashboard queries, live events
  discord/    narrow ports + discord.js adapters
  bot/        client, gateway events, slash command definitions, registration
  api/        Fastify server: auth, dashboard routes, management routes, live event stream
  jobs/       scheduled tasks (unbans, retention, voice minutes, tier sync, session cleanup)
web/          React dashboard (Vite + Tailwind), built into dist/web and served by the API
scripts/      invite URL generator, dashboard demo
tests/        vitest tests with in-memory SQLite and fake Discord ports
```
