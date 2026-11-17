# Issue reports (Belltower)

Friends tell you "Plex is down" in Discord, and the message scrolls away. With [Belltower](https://github.com/bernie-sandler/Belltower) connected, they can report it properly instead: Bernard opens a Belltower ticket and messages them when it's fixed.

1. In Belltower (**1.6 or later**), open **Account → Your tokens** and create a **full** token. A read-only token can't open tickets. Use an account that sees every tag, or Bernard loses track of tickets it can't see. The token doesn't need "may complete tickets".
2. Set `BELLTOWER_URL` (as Bernard can reach it, e.g. `http://192.168.1.10:8080`) and `BELLTOWER_TOKEN`, then restart Bernard. On the dashboard's **Issue reports** page, **Test connection** checks both.
3. Optionally post a **Report an issue** panel (on that page, or `/belltower panel channel`). Its button opens a short form, so members don't need the command.

Members report with `/report service [details]` or the panel. `service` suggests the monitors from your [status page](status.md), but anything can be typed. Each report becomes a ticket titled after the service, with the details and who reported it, tagged `Discord` by default. Tags, priority, column and a per-member cooldown (default 2 minutes) are on the Issue reports page.

**Reports join Uptime Kuma's tickets.** When a report names a Kuma monitor, Bernard uses the same key as Belltower's Uptime Kuma webhook (`uptime-kuma:<monitor id>`). If Kuma has already opened a ticket for that monitor, the report is added to it as a note instead of opening another, and so are later reports from other members. When Kuma sees the monitor come back up and resolves the ticket, everyone who reported it hears about it. Reports for something that isn't a monitor always open their own ticket.

**Hearing back.** Bernard checks Belltower every minute. When a ticket is done, each reporter gets a DM with the ticket number and the resolution reason ("Fixed", "Won't fix"…). If their DMs are closed, Bernard mentions them in the channel they reported from instead. A ticket that's deleted closes the report too, with a short note. If Belltower can't be reached, nothing is closed; the dashboard shows the error until it's back. Reporting can be paused on the Issue reports page; reports already filed are still followed up.

| Command                      | Node               | Notes                                                                                                                                              |
| ---------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/report service [details]`  | `public:report`    | Open to everyone by default. The reply is only visible to the reporter. With the submit page, `service` can be left out and the reply is the link. |
| `/belltower panel [channel]` | `config:belltower` | Posts (or moves) the report panel. Leave `channel` empty to remove it.                                                                             |
| `/belltower test`            | `config:belltower` | Checks the address and token.                                                                                                                      |

The panel's button uses `public:report` too: deny that node to a role and its members can't report either way.

## Using Belltower's submit page instead

If you'd rather have people use Belltower's own [submit page](https://github.com/bernie-sandler/Belltower/blob/main/docs/SUBMIT-PAGE.md) (request types, their questions, screenshots), set **The Report an issue button** to **Opens Belltower's submit page** on the Issue reports page and paste the link from **Settings → Submit page** in Belltower.

- The panel's button becomes a link to the submit page, and `/report` answers with the link. This part needs only the link, not `BELLTOWER_URL` or `BELLTOWER_TOKEN`. Everyone who can see the panel's channel can open the link.
- With `BELLTOWER_URL` and `BELLTOWER_TOKEN` set (Belltower **1.6.0 or later**), **Open reports** lists the tickets sent through the submit page, with the name people typed there and where each stands, and **Recently closed** the finished ones. Bernard checks for changes every minute. Older Belltower versions don't say which tickets came from the submit page; the page then shows an error asking you to update.
- Bernard doesn't know who sent a submit-page ticket, so nobody is messaged when it's done. The submit page gives each sender a status link instead.
- Turning off **Accept reports** removes the button from the panel. The submit page itself stays open; switch it off in Belltower if you need to.
- Reports filed through `/report` before the switch are still followed up, and their reporters still hear back.
