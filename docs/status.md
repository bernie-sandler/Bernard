# Status embed (Uptime Kuma)

Bernard can keep one pinned message up to date with whether your services are up. It reads an [Uptime Kuma](https://github.com/louislam/uptime-kuma) **status page** through Kuma's public status page API. It needs no Kuma login or API key, and Bernard runs no checks of its own.

1. In Uptime Kuma, create a status page (for example slug `homelab`) and add the monitors you want in Discord, such as Tower, Plex and Minecraft. Kuma's groups become the embed's sections. Monitors that aren't on the page are never shown.
2. On the dashboard's **Status** page (or with `/status setup kuma_url slug`), enter Kuma's address as Bernard can reach it, for example `http://192.168.1.10:3001`, and the slug. **Test connection** reads the page without saving anything.
3. Pick a channel and **Post embed** (or `/status post channel`). Bernard posts the embed, pins it and edits it after every check (default every 60 seconds, 60–3600). If someone deletes the message, it's posted again.

Each line shows the monitor's state (🟢 up, 🔴 down, 🟡 pending, 🔧 maintenance), its response time and its uptime over the last 24 hours. If Kuma can't be reached, the embed keeps the last known state and says since when Kuma has been unreachable, rather than marking everything down.

**Alerts:** pick an alert channel and Bernard posts "🔴 Plex is down" and "🟢 Plex is back up" (with how long it was down) when a monitor changes state. Give a monitor a **ping role** (on the Status page, or `/status notify monitor role`) to mention that role in its alerts. This pairs well with a self-assign ping role like "MC updates" (see [role panels](role-panels.md)). Only that role is pinged, never @everyone. Pending and maintenance don't alert, and Kuma's own retry settings decide how quickly a monitor counts as down. Restarting Bernard or switching status pages never sends alerts for the state it starts with.

| Command                                  | Node            | Notes                                                               |
| ---------------------------------------- | --------------- | ------------------------------------------------------------------- |
| `/status show`                           | `public:status` | Current status, only visible to you. Open to everyone by default.   |
| `/status setup kuma_url slug [interval]` | `config:status` | Tests the status page before saving.                                |
| `/status post channel`                   | `config:status` | Posts (or moves) the pinned embed.                                  |
| `/status alerts [channel]`               | `config:status` | Leave `channel` empty to turn alerts off.                           |
| `/status notify monitor [role]`          | `config:status` | Role to ping for that monitor's alerts. Leave `role` empty to stop. |
| `/status refresh`                        | `config:status` | Reads Kuma and updates the embed now.                               |

Pinning needs the **Pin Messages** permission. Without it the embed still works, it just isn't pinned.
