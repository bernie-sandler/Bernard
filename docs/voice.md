# Join-to-create voice

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
