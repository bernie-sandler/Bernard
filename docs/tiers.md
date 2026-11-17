# Tenure, activity and tiers

Tiers are roles members earn from how long they've been in the server (tenure) and how active they've been recently (activity).

## Tenure

- **Tenure** is the number of days since the member joined.
- **Backfill:** at every startup the bot syncs the member list. New members are backfilled from Discord's join date, and anyone who left while the bot was offline is marked as gone.
- **First join:** Discord only reports the most recent join, so the first join from before the bot arrived can't be recovered. From then on, the bot keeps the earliest join it has seen.
- **Rejoins:** when someone leaves and rejoins, tenure restarts by default. Use `/activity settings reset_tenure_on_rejoin:false` to keep it. A newer join date seen at startup counts as a rejoin.

## Activity

- **No message content is stored.** The score is built from counts kept per member per day: messages, image and link bonuses, reactions given and received that earned points, and voice minutes.
- **Cooldown:** each kind (message, image, link, reaction given) earns at most once per `message_cooldown` seconds (default 60) per member, so spamming doesn't farm points. The kinds cool down separately.
- **Messages:** `points_per_message` per message (default 1).
- **Images and links:** a message with an image attachment earns `points_per_image` (default 1) and a message with a link earns `points_per_link` (default 0.5), on top of the message point.
- **Reactions:** adding a reaction to someone else's message earns `points_per_reaction` (default 0.25). Removing it doesn't take points away, and reacting to your own message earns nothing.
- **Reactions received:** when someone reacts to your message within a few minutes of you posting it (default 5), you earn `points_per_reaction_received` (default 0.25). Each member counts once per message, however many emojis they add. Bot and webhook messages earn nothing.
  - **Grace period:** a member who receives a set number of point-earning reactions within a set time (default 20 within 60 minutes) earns no reaction points at all, given or received, for the grace length (default 6 hours). A threshold of 0 turns this off. The receive window and grace settings are on the dashboard Settings page.
- **Voice:** `points_per_voice_minute` per minute in voice (default 0.2, so 1 point per 5 minutes; servers set up before this change keep their saved value).
  - AFK-channel time doesn't count, nor does time with no other human in the channel (bots don't count as company).
  - Self-deafened time doesn't count by default. Change this with `count_deafened`.
  - **Long sessions:** after `voice_long_session_minutes` of continuous voice time (default 120), each further minute is multiplied by `voice_long_session_multiplier` (default 1, no change). Set it below 1 so all-day lounge sitting counts for less, or above 1 to reward long hangouts. A session survives gaps of up to 5 minutes, such as a reconnect. Changing the multiplier re-scores past activity; changing the session length only affects minutes from then on.
  - Session lengths, grace periods and cooldowns are kept in memory, so a restart clears them.
- **Rolling window:** the score used for tiers covers the last `window_days` (default 30). Weights are applied when scores are read, so changing them re-scores past activity too. That can move members above or below a tier's activity requirement, so review tier thresholds after changing weights.
- **History:** daily rows are kept for 400 days, for the dashboard charts.

```
/activity settings message_cooldown:60 points_per_message:1 points_per_image:1 points_per_link:0.5 points_per_reaction:0.25 points_per_voice_minute:0.2 window_days:30
```

## Tiers

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
- **Floor** (`/tiers settings floor:Member`): members who meet the floor tier's **tenure** requirement are never demoted below it. They're also placed in it without any activity, so long-standing members never end up in the lowest tier. Members short of that tenure follow the normal rules.
- **Excluded roles** (for example staff, or bots, which are always skipped) are left alone.
- **When tiers are evaluated:**
  - everyone, every `sync_minutes` (default 60);
  - a single member, a few seconds after their score crosses a tier threshold, and when they join (so a tier with 0 tenure and 0 activity applies straight away);
  - everyone, on demand with `/tiers sync`.
- Tier changes are posted to the `members` log.
- **The bot's role must sit above every tier role.** Tier roles it can't manage are skipped and reported by `/tiers check`, `/tiers list` and a warning at startup.
