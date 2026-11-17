# Permissions

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

`/permcheck` shows which rule decided.

Slash commands register without `default_member_permissions`, so Discord shows every command to everyone. The bot checks permissions when a command runs and replies privately when it denies one.

The dashboard checks the same nodes; see [what each page needs](dashboard.md#what-each-page-needs).
