# bernard

A self-hosted Discord bot plus admin dashboard for **one private server**. Bot, API and dashboard run in a single Node process on SQLite.

> **Status: Phase 3 of 7 (Voice).** Working now: config validation, the database and migrations, the custom permission system, all moderation commands with mod cases, temporary bans, recording of bans/kicks/timeouts done in Discord itself, all six log types (routed to channels and stored in the database with retention), join-to-create voice hubs with owner commands and startup reconciliation, `/userinfo`, `/serverinfo`, `/healthz` and Docker. Tenure and activity tiers, and the dashboard, arrive in later phases.

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

| Script                      | What it does                                          |
| --------------------------- | ----------------------------------------------------- |
| `pnpm dev`                  | Run with hot reload (tsx)                             |
| `pnpm build` / `pnpm start` | Compile to `dist/` and run                            |
| `pnpm test`                 | Unit tests (vitest)                                   |
| `pnpm typecheck`            | TypeScript, strict                                    |
| `pnpm lint` / `pnpm format` | Biome                                                 |
| `pnpm db:generate`          | Generate a migration after editing `src/db/schema.ts` |
| `pnpm invite-url`           | Print the bot invite URL and the required permissions |

## Environment variables

See [.env.example](.env.example) for the full annotated list. The app validates everything with zod at startup and exits with a list of every problem if something is wrong.

| Variable                   | Required     | Default                 | Notes                                   |
| -------------------------- | ------------ | ----------------------- | --------------------------------------- |
| `DISCORD_TOKEN`            | yes          |                         | Bot token                               |
| `DISCORD_CLIENT_ID`        | yes          |                         | Application ID                          |
| `GUILD_ID`                 | yes          |                         | The one server this bot serves          |
| `DASHBOARD_ENABLED`        | no           | `true`                  |                                         |
| `DISCORD_CLIENT_SECRET`    | if dashboard |                         | OAuth2 client secret                    |
| `SESSION_SECRET`           | if dashboard |                         | 32+ random characters                   |
| `PUBLIC_BASE_URL`          | no           | `http://localhost:3000` | Used for the OAuth redirect             |
| `TRUST_PROXY`              | no           | `false`                 | `true`, a hop count, or proxy IPs/CIDRs |
| `SESSION_TTL_HOURS`        | no           | `168`                   |                                         |
| `COOKIE_SECURE`            | no           | auto                    | `true` when the base URL is https       |
| `DATABASE_PATH`            | no           | `/data/bernard.db`      |                                         |
| `HOST` / `PORT`            | no           | `0.0.0.0` / `3000`      |                                         |
| `LOG_LEVEL` / `LOG_PRETTY` | no           | `info` / `false`        | pino JSON logs                          |

## Deploying with Docker

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

The SQLite database lives in the `bernard-data` volume at `/data/bernard.db`. Health check: `GET /healthz`.

Behind Nginx Proxy Manager or Cloudflare, set `PUBLIC_BASE_URL` to the public https URL and `TRUST_PROXY` to your proxy (for example `TRUST_PROXY=1`).

## Backups

Everything lives in one SQLite file. Take a consistent online backup with SQLite's backup API:

```bash
docker compose exec bernard node -e "require('better-sqlite3')('/data/bernard.db').backup('/data/backup.db').then(()=>console.log('ok'))"
```

```bash
docker compose cp bernard:/data/backup.db ./bernard-backup.db
```

To restore: stop the container, copy the file back to `/data/bernard.db`, and start it again.

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

The same definition drives the Discord registration JSON, the zod input validation and (from Phase 6) the dashboard Command Runner form. Both entry points go through `CommandExecutor`, which checks the permission, validates the input, runs the command and writes the `commands` log.

## Project layout

```
src/
  config/     env + settings schemas (zod)
  db/         Drizzle schema, migrations, client
  shared/     code shared with the dashboard (option descriptors, permission nodes, result types)
  services/   all business logic (permissions, commands, settings, audit, logs, ...)
  discord/    narrow ports + discord.js adapters
  bot/        client, events, slash command definitions, registration
  api/        Fastify server
  jobs/       scheduled tasks (later phases)
tests/        vitest unit tests with in-memory SQLite and fake Discord ports
```
