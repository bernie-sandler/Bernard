# bernard

A self-hosted Discord bot plus admin dashboard for **one private server**. Bot, API and dashboard run in a single Node process on SQLite.

> **Status: Phase 1 of 7 (Foundation).** Working now: config validation, the database and migrations, slash command registration, the custom permission system (`/permset`, `/permunset`, `/permlist`, `/permcheck`), `/help`, `/ping`, the `commands` log, `/healthz` and Docker. Moderation, logs, voice, tiers and the dashboard arrive in later phases.

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

| Intent | Privileged | Why |
|---|---|---|
| Guilds | no | Channels, roles, guild info |
| GuildMembers | **yes** | Joins/leaves, tenure backfill, permission role lookups |
| GuildMessages | no | Message logs, activity points |
| MessageContent | **yes** | Edit/delete log content |
| GuildVoiceStates | no | Voice logs, join-to-create, voice activity |
| GuildModeration | no | Ban events, audit log entries |

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

| Script | What it does |
|---|---|
| `pnpm dev` | Run with hot reload (tsx) |
| `pnpm build` / `pnpm start` | Compile to `dist/` and run |
| `pnpm test` | Unit tests (vitest) |
| `pnpm typecheck` | TypeScript, strict |
| `pnpm lint` / `pnpm format` | Biome |
| `pnpm db:generate` | Generate a migration after editing `src/db/schema.ts` |
| `pnpm invite-url` | Print the bot invite URL and the required permissions |

## Environment variables

See [.env.example](.env.example) for the full annotated list. The app validates everything with zod at startup and exits with a list of every problem if something is wrong.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DISCORD_TOKEN` | yes | | Bot token |
| `DISCORD_CLIENT_ID` | yes | | Application ID |
| `GUILD_ID` | yes | | The one server this bot serves |
| `DASHBOARD_ENABLED` | no | `true` | |
| `DISCORD_CLIENT_SECRET` | if dashboard | | OAuth2 client secret |
| `SESSION_SECRET` | if dashboard | | 32+ random characters |
| `PUBLIC_BASE_URL` | no | `http://localhost:3000` | Used for the OAuth redirect |
| `TRUST_PROXY` | no | `false` | `true`, a hop count, or proxy IPs/CIDRs |
| `SESSION_TTL_HOURS` | no | `168` | |
| `COOKIE_SECURE` | no | auto | `true` when the base URL is https |
| `DATABASE_PATH` | no | `/data/bernard.db` | |
| `HOST` / `PORT` | no | `0.0.0.0` / `3000` | |
| `LOG_LEVEL` / `LOG_PRETTY` | no | `info` / `false` | pino JSON logs |

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
