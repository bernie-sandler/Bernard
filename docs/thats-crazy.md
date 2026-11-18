# That's crazy

Someone said something wild in voice or chat? Anyone runs `/thatscrazy user:@them`. Bernard posts a short poll in
that channel, and if enough people agree, the member gets a voice penalty for a few minutes and a DM about it. The
more often it happens, the bigger the penalty.

It's off until you turn it on in the **That's crazy** section of the dashboard's Settings page.

## How a vote works

- `/thatscrazy` posts the poll with a **That's crazy** button. The person who started it counts as the first vote.
- While a poll on someone is open, another `/thatscrazy` on them doesn't start a second one; it adds a vote to the
  open poll. Pressing the button does the same. Everyone votes once, and the target can't vote on their own poll.
- **Votes needed** is the higher of _Votes needed at least_ (default 3) and _Share of voice channel_ (default 50%) of
  the other people in the target's voice channel, rounded up. If the target isn't in voice, the minimum applies.
  It's fixed when the poll opens. Anyone with `public:thatscrazy` can vote, in voice or not.
- The poll passes as soon as it has enough votes, and fails when time runs out (default 2 minutes).

## Strikes and penalties

A passed vote is a strike. Strikes older than _Strikes count for_ (default 30 days) stop counting. Strike 1 gets
the first step of the penalty ladder, strike 2 the second, and so on; the last step repeats. The default ladder:

| Strike | Penalty                   |
| ------ | ------------------------- |
| 1      | Server mute, 1 min        |
| 2      | Server mute, 5 min        |
| 3      | Keep out of voice, 10 min |
| 4+     | Timeout, 30 min           |

- **Server mute** and **server deafen** start right away if the member is in voice. Otherwise they wait until the
  member next joins voice (if their time hasn't run out by then). When the time is up Bernard undoes them, or on
  the member's next join if they had left voice by then.
- **Keep out of voice** disconnects the member, and disconnects them again every time they join until it ends.
- **Timeout** is Discord's own timeout (max 28 days). It starts right away, also blocks chat, and Discord ends it.

If Discord refuses a penalty (for example, missing permissions or a target above Bernard's role), the poll message
says so.

Lifting a mute or deafen undoes it even if a moderator also server-muted the member in the meantime.

## The DM

Each strike can have its own message, set one per line on the Settings page; the last line repeats for later
strikes. Placeholders: `{count}` (strike number), `{action}` (e.g. "muted"), `{minutes}` and `{server}`. Leave it
empty for no DM. Members with DMs closed just don't get it.

## Abuse limits

- **After a passed vote** (default 15 min) and **after a failed vote** (default 5 min): no new poll on that member.
- **Between starts** (default 5 min): how often one member can start a poll. Voting on someone else's poll is
  always allowed.
- **Exempt roles:** members with any of these can't be voted on. Bots and the server owner never can, and nobody can
  start one on themselves.

## Commands

| Command               | Node                | Notes                                                                         |
| --------------------- | ------------------- | ----------------------------------------------------------------------------- |
| `/thatscrazy user`    | `public:thatscrazy` | Start a poll, or vote in the open one. Discord only (not the Command Runner). |
| `/crazy strikes user` | `admin:crazy`       | Strike count, running penalties and recent passed votes.                      |
| `/crazy reset user`   | `admin:crazy`       | Clears the member's strikes and ends their penalties. Audited.                |

The poll's button checks `public:thatscrazy` too. Settings need `config:settings`.

Bernard needs the **Mute Members** and **Deafen Members** permissions for mutes and deafens, **Move Members** to
disconnect, and **Moderate Members** for timeouts. Re-invite with `pnpm invite-url` to add the first two to an
existing install.
