# Self-assign role panels

A role panel is a message with buttons or a dropdown menu that members use to give themselves roles: game roles, or ping roles like "MC updates" and "Movie night".

Create panels on the dashboard's **Role panels** page:

- **Style:** _Buttons_ shows one button per role, and clicking it adds or removes that role. _Menu_ shows a dropdown: picking a role adds it, and picking one you already have removes it.
- **Mode:** _Any number_ lets members pick as many roles as they like. _Only one_ swaps roles: picking a new one removes the panel's other roles.
- Each role gets a label, an optional emoji (a Unicode emoji or a custom one like `<:creeper:123456789012345678>`) and an optional description.

Then pick a channel and **Post**. Edits update the posted message automatically. Bernard replies to each click privately with what changed. The role changes show up in the `members` log as usual, with the panel's name as the reason in Discord's audit log.

For safety, a panel can't offer @everyone, roles managed by an integration or bot, roles at or above Bernard's highest role, or roles with moderator or admin permissions (Administrator, Manage Server/Roles/Channels/Messages, Ban, Kick, Timeout and similar). This is checked when the panel is saved and again on every click, so a role that later gains such a permission stops being handed out.

| Command                         | Node                | Notes                                                        |
| ------------------------------- | ------------------- | ------------------------------------------------------------ |
| `/rolepanel list`               | `config:rolepanels` |                                                              |
| `/rolepanel post panel channel` | `config:rolepanels` | Moves the panel if it was posted elsewhere.                  |
| `/rolepanel refresh panel`      | `config:rolepanels` | Re-renders the message, e.g. after renaming a role.          |
| `/rolepanel delete panel`       | `config:rolepanels` | Deletes the panel and its message. Members keep their roles. |

Clicking a panel needs no permission node: anyone who can see the message can use it.
