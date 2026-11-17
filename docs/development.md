# Development

## Local setup

Needs Node.js 22.12+ and pnpm 10. Fill in the Discord values from [Setup](setup.md#discord-developer-portal-setup).

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

For the dashboard with hot reload, run `pnpm dev:web` alongside `pnpm dev` and open <http://localhost:5173>. Set `PUBLIC_BASE_URL=http://localhost:5173` and add `http://localhost:5173/api/auth/callback` as a redirect in the Developer Portal, so login and the same-origin checks go through Vite's proxy.

To look around without a bot, run `pnpm build:web && pnpm demo` and open <http://localhost:3100>. This runs the real API and dashboard against in-memory fake data, and "Log in with Discord" signs you straight in as the owner.

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
- **What's covered:** the permission resolver (every precedence case), tier qualification, demotion and the floor, activity scoring and voice-minute rules, the temporary voice channel lifecycle and startup reconcile, moderation guards, purge and temporary bans, log routing, the OAuth flow, sessions, CSRF and per-route permission gates, every dashboard endpoint, the live event stream and the job scheduler.
- `pnpm test:coverage` measures our own code and leaves out thin discord.js glue (adapters, gateway event handlers, startup wiring), which only a live gateway can exercise. An HTML report is written to `coverage/`.
- `pnpm demo` serves the real dashboard and API on fake data for hands-on checks.

## Project layout

```
src/
  config/     env + settings schemas (zod)
  db/         Drizzle schema, migrations, client
  shared/     types and helpers shared with the dashboard (option descriptors, permission nodes, API shapes)
  services/   all business logic: permissions, commands, moderation, logs, voice, members, activity,
              tiers, status (Uptime Kuma), role panels, issue reports (Belltower), settings, audit,
              sessions, dashboard queries, live events
  discord/    narrow ports + discord.js adapters
  bot/        client, gateway events, slash command definitions, registration
  api/        Fastify server: auth, dashboard routes, management routes, live event stream
  jobs/       scheduled tasks (unbans, retention, voice minutes, tier sync, status refresh, Belltower poll,
              session cleanup)
web/          React dashboard (Vite + Tailwind), built into dist/web and served by the API
scripts/      invite URL generator, dashboard demo
tests/        vitest tests with in-memory SQLite and fake Discord ports
docs/         user documentation
```

See [Releasing](releasing.md) for branches, CI and how releases are published.
