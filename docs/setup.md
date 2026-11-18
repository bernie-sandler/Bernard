# Setup and deployment

## Requirements

- Docker (for deployment)
- Node.js 22.12+ and pnpm 10 (`npm i -g pnpm`) for local development. The Docker image uses Node 26 LTS.

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

7. In **Server Settings → Roles**, drag the bot's role **above every role it should manage** (tier roles, roles granted with `/role add`, role panel roles). Discord won't let a bot manage roles at or above its own.

### Intents used

| Intent                | Privileged | Why                                                    |
| --------------------- | ---------- | ------------------------------------------------------ |
| Guilds                | no         | Channels, roles, guild info                            |
| GuildMembers          | **yes**    | Joins/leaves, tenure backfill, permission role lookups |
| GuildMessages         | no         | Message logs, activity points                          |
| GuildMessageReactions | no         | Reaction activity points                               |
| MessageContent        | **yes**    | Edit/delete log content, link activity points          |
| GuildVoiceStates      | no         | Voice logs, join-to-create, voice activity             |
| GuildModeration       | no         | Ban events, audit log entries                          |

### Bot permissions

`pnpm invite-url` prints the exact list and the permission integer: View Channels, Send Messages, Embed Links, Read Message History, Manage Messages, Pin Messages, Manage Channels, Manage Roles, Kick Members, Ban Members, Moderate Members, Manage Nicknames, Move Members, Mute Members, Deafen Members, Connect and View Audit Log. The scopes are `bot` and `applications.commands`.

## Environment variables

See [.env.example](../.env.example) for the full annotated list. The app validates everything with zod at startup and exits with a list of every problem if something is wrong.

| Variable                   | Required     | Default                 | Notes                                                           |
| -------------------------- | ------------ | ----------------------- | --------------------------------------------------------------- |
| `DISCORD_TOKEN`            | yes          |                         | Bot token                                                       |
| `DISCORD_CLIENT_ID`        | yes          |                         | Application ID                                                  |
| `GUILD_ID`                 | yes          |                         | The one server this bot serves                                  |
| `DASHBOARD_ENABLED`        | no           | `true`                  |                                                                 |
| `DISCORD_CLIENT_SECRET`    | if dashboard |                         | OAuth2 client secret                                            |
| `SESSION_SECRET`           | if dashboard |                         | 32+ random characters                                           |
| `PUBLIC_BASE_URL`          | no           | `http://localhost:3000` | Used for the OAuth redirect                                     |
| `TRUST_PROXY`              | no           | `false`                 | `true`, a hop count, or proxy IPs/CIDRs                         |
| `SESSION_TTL_HOURS`        | no           | `168`                   |                                                                 |
| `COOKIE_SECURE`            | no           | auto                    | `true` when the base URL is https                               |
| `BELLTOWER_URL`            | no           |                         | Belltower's address; turns on [issue reports](issue-reports.md) |
| `BELLTOWER_TOKEN`          | with URL     |                         | A full Belltower API token (`tt_…`)                             |
| `DATABASE_PATH`            | no           | `/data/bernard.db`      |                                                                 |
| `HOST` / `PORT`            | no           | `0.0.0.0` / `3000`      |                                                                 |
| `LOG_LEVEL` / `LOG_PRETTY` | no           | `info` / `false`        | pino JSON logs                                                  |
| `PUID` / `PGID`            | no           | `1000` / `1000`         | Docker only: user and group that run the app and own `/data`    |
| `UMASK`                    | no           | `0022`                  | Docker only: file-creation mask                                 |

## Deploying with Docker

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

The project's `./data` folder is mounted at `/data`, so the SQLite database is `./data/bernard.db` on the host. Health check: `GET /healthz`. Migrations run automatically at startup.

To run a published image instead of building, use `ghcr.io/bernie-sandler/bernard` with a version tag (`x.y.z` or `x.y`), `latest`, or `dev` (rebuilt on every push to `dev`, can break between releases). Keep production on a version tag or `latest`.

The container starts as root only long enough to give `PUID:PGID` (default `1000:1000`) ownership of `/data`, then runs the app as that user with `UMASK`. On a bind mount, set them to the owner you want on the host, for example `PUID=99` and `PGID=100` on Unraid. Starting the container with `--user` skips this and runs as that user, so `/data` must already be writable by it.

## Reverse proxy (Nginx Proxy Manager / Cloudflare)

- Set `PUBLIC_BASE_URL` to the public https URL and `TRUST_PROXY=1` (one proxy hop), or to your proxy's IP or CIDR. Behind Cloudflare plus Nginx Proxy Manager, use `TRUST_PROXY=2`.
- Proxy everything (`/`, `/api`, `/healthz`) to the container's port 3000. No WebSocket configuration is needed.
- Live updates use a long-lived HTTP response (Server-Sent Events). The bot sends `X-Accel-Buffering: no`, so Nginx Proxy Manager streams it without extra config. A heartbeat every 25 seconds keeps Cloudflare's idle timeout from cutting it off.

## Backups

Everything lives in one SQLite file. Take a consistent online backup with SQLite's backup API:

```bash
docker compose exec Bernard node -e "require('better-sqlite3')('/data/bernard.db').backup('/data/backup.db').then(()=>console.log('ok'))"
```

The backup appears on the host at `./data/backup.db`.

To restore or move to another machine: stop the container, delete `bernard.db`, `bernard.db-wal` and `bernard.db-shm` from `./data`, copy the backup in as `./data/bernard.db`, and start it again. Copy a backup made this way rather than a live `bernard.db`, which can leave recent changes behind in the `-wal` file.
