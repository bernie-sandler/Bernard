# Changelog

All notable changes to Bernard are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Images, links and reactions now earn activity points. A message with an image attachment earns an image bonus (default +1) and a message with a link earns a link bonus (default +0.5), on top of the normal message point. Reacting to someone else's message earns points too (default 0.25). The message cooldown applies to each kind separately, so one message can earn the message point and both bonuses. Set the weights on the Settings page or with `/activity settings points_per_image`, `points_per_link` and `points_per_reaction`.
- The member page shows images, links and reactions, and its activity chart now stacks the points each kind earned per day.
- The bot uses the `GuildMessageReactions` gateway intent. It isn't privileged, so nothing needs changing in the Developer Portal.
- A `dev` Docker image (`ghcr.io/bernie-sandler/bernard:dev`) built from the `dev` branch after every change, for trying unreleased changes. It can break between releases; use a version tag or `latest` for your real server.

### Changed

- Release candidates (`X.Y.Z-rc.N` images and GitHub prereleases) are published from `dev` by running the new Prerelease workflow, with no version bump. Pushing an `-rc` tag by hand no longer publishes anything. GitHub keeps at most one release and one release candidate.
- New installs score voice at 0.2 points per minute (1 point per 5 minutes) instead of 1. Existing servers keep their saved value. Lowering it re-scores past activity, which can move members below a tier's activity requirement, so review your tier thresholds when you change it.

### Removed

- Docker images are no longer tagged `sha-<commit>`. Pin a version tag (`0.1.3`, `0.1`) or `latest` instead.

## [0.1.3] - 2026-11-16

### Fixed

- Bot failing to start with `LOG_PRETTY=true` in the Docker image (`unable to determine transport target for "pino-pretty"`). `pino-pretty` was a dev-only dependency and was pruned from the production image; it is now a runtime dependency, and if it is ever missing the bot logs a warning and falls back to JSON logs instead of crashing.

## [0.1.2] - 2026-11-16

### Fixed

- Slash commands failing with "The application did not respond" (Discord error 10062, `Unknown interaction`). Commands are now acknowledged as soon as the permission check passes instead of after a 2-second wait, and replies no longer wait for the command log to be posted to its log channel.

### Changed

- When a reply to an interaction fails, the log now includes `ageOnArrivalMs` (how old the interaction was when the bot received it) and `handlingMs` (time spent handling it), to tell network or gateway lag apart from slow commands.

## [0.1.1] - 2026-11-16

### Changed

- `docker-compose.yml` now bind-mounts the project's `./data` folder at `/data` instead of using the `bernard-data` named volume, so the SQLite database is a plain file on the host (`./data/bernard.db`).
- The Compose service is now named `Bernard`, so `docker compose exec`/`logs` commands use `Bernard` instead of `bernard`.
- README: updated backup and restore steps for the bind mount, including clearing the `-wal`/`-shm` files when restoring.
- New logo design.
- CI: GitHub Actions bumped to their latest major versions.

### Upgrade notes

- If you deployed v0.1.0 with Docker Compose, your database is in the `bernard-data` volume. Copy it into `./data` before starting with the new compose file, or Bernard will start with an empty database.

## [0.1.0] - 2026-11-16

First release. A self-hosted Discord bot and admin dashboard for one private server, running bot, API and dashboard in a single Node process on SQLite.

### Added

#### Foundation

- TypeScript (strict) on Node 22.12+ / 26, with SQLite + Drizzle and migrations that run on startup.
- Environment validated with zod at startup; the app exits with a list of every problem.
- Declarative command framework: one option definition drives the Discord command, its validation and the dashboard form. Slash and dashboard runs share one execution path (permission check, validation, command log).
- Guild-scoped command registration that skips re-registering when nothing changed.
- `/help`, `/ping`, and a `/healthz` endpoint.
- `pnpm invite-url` prints the invite link and the exact bot permissions.

#### Permissions

- Role-based permission system layered on Discord, with wildcards (`admin:*`, `*`): owner bypass, optional Administrator bypass, most-specific rule wins, named roles beat `@everyone`, deny wins between roles.
- `/permset`, `/permunset`, `/permlist` and `/permcheck`, which shows which rule decided.

#### Moderation and logging

- Ban (including temporary bans with a scheduled, retried unban), unban, kick, timeout/untimeout, warn and warnings, purge, slowmode, lock/unlock, role add/remove, nickname and announcements.
- Hierarchy guards for self, owner, bot, moderator vs target and role position.
- Numbered mod cases for every action, including bans, kicks and timeouts done in Discord's own UI; optional DMs to targets.
- Moderation, member, message, voice, server and command logs, each routed to its own channel and stored for searching, with daily retention pruning.
- `/logs`, `/userinfo`, `/serverinfo`, `/case`.

#### Join-to-create voice

- Public or private hubs with category, name templates (`{user}`, `{username}`, `{count}`), default user limit and optional hiding.
- Temporary channels deleted after a grace period, with owner hand-off to the longest-present member.
- Owner commands: `/vc lock`, `unlock`, `limit`, `rename`, `invite`, `kick`, `transfer`, `claim`.
- Per-user hub cooldown.
- Startup clean-up so a restart never leaves orphan channels.
- `/voice hub` and `/voice settings`.

#### Tenure, activity and tiers

- Member tenure synced at every startup, backfilled from Discord join dates; tenure reset on rejoin is configurable.
- Activity scoring from messages (with cooldown) and voice minutes (AFK, alone and self-deafened rules configurable), over a rolling window. Message content is never stored.
- Up to 10 tiers requiring both tenure and activity, in stacking or highest-only mode, with excluded roles and scheduled sync.
- Step-by-step demotion, one tier per grace period, down to a configurable floor tier (`/tiers settings floor:`).
- `/tiers tenure-sync` places members by tenure alone, for fresh installs with no activity history yet. Supports a `preview` dry run.
- `/tiers`, `/activity settings`, `/rank`.

#### Web dashboard

- Discord OAuth2 login, gated by the same permission nodes as the commands and re-checked on every request.
- Server-side sessions, CSRF protection, Origin checks, CSP and security headers, and rate limits.
- Pages: Overview, Members (with member detail and actions), Moderation, Logs, Command Runner, Permissions, Tiers, Voice hubs, Settings and Audit log.
- Audit log of every config change and dashboard action, with before/after values.
- Live updates over Server-Sent Events, with a Live / Reconnecting / Offline indicator. Works behind Nginx Proxy Manager and Cloudflare.
- Bernard logo favicon and login screen (`pnpm icons` regenerates them).
- `pnpm demo` runs the dashboard on fake data with no Discord connection.

#### Deployment

- Docker image and Compose file, with `PUID`, `PGID` and `UMASK` so the container runs as a chosen user and owns `/data` correctly on bind mounts (e.g. Unraid).
- CI on pull requests and `main`: Biome, typecheck, tests on Node 22 and 26, build and Docker image build.
- Tag-driven releases: pushing `vX.Y.Z` publishes a multi-arch (amd64/arm64) image to GHCR and creates a GitHub release.
- Weekly grouped Dependabot updates, with patch and minor updates auto-merged once checks pass.

[Unreleased]: https://github.com/bernie-sandler/bernard/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/bernie-sandler/bernard/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/bernie-sandler/bernard/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/bernie-sandler/bernard/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/bernie-sandler/bernard/releases/tag/v0.1.0
