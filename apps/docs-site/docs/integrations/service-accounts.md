---
title: Service Accounts
slug: /integrations/service-accounts
---

A service account is a long-lived Chronote MCP token for an unattended agent. It exists because the normal MCP flow signs a person in through Discord in a browser, which a headless agent on a server cannot do.

A service account acts as a Discord application (bot) that is already a member of your server. It never gets its own access list. Everything it can read is decided by that bot's Discord roles and channel permissions, exactly as Chronote decides access for a person.

## Why It Acts As A Bot

Binding the token to a bot rather than a person means:

- **Access follows Discord.** Give the bot a role that can see the channels you want it to read, and that is the boundary. Nothing about it lives only inside Chronote.
- **Revoking is one act.** Remove the role in Discord and the agent loses access within about a minute, the same as removing a person's access.
- **Nobody's personal reach leaks.** A token bound to a human would inherit their personal meetings and their access in every other server. A server manager cannot grant that, so Chronote does not allow it.

Chronote refuses to create a service account for a bot holding Administrator, because Administrator overrides every channel permission and there would be no boundary left to set.

## Creating One

You need Manage Server permission in the target Discord server.

1. Invite the agent's bot to your server if it is not already there.
2. Give that bot a role that can view and connect to the voice channels whose meetings the agent should read, and read message history in the matching notes channels.
3. In Chronote, create a service account for that server and choose:
   - the bot's Discord user ID
   - a name you will recognize later
   - the scopes the agent needs
   - an optional channel allowlist
   - an optional expiry in days

The token is shown once. Chronote stores only a hash of it, so a lost token has to be revoked and replaced.

## Scopes

Grant the narrowest set that does the job:

| Scope              | Allows                             |
| ------------------ | ---------------------------------- |
| `meetings:read`    | Listing meetings and reading notes |
| `transcripts:read` | Reading transcript text            |
| `meetings:start`   | Starting a recording               |
| `meetings:stop`    | Stopping a recording               |

`meetings:read` on its own is a useful tier: the agent gets meeting notes and summaries but never the raw transcript.

## Channel Allowlist

The optional channel allowlist narrows a token further, and only ever narrows. A meeting has to pass the bot's Discord permissions **and** be in an allowed channel.

Use it when you want a limit visible inside Chronote without restructuring Discord roles, or as a second layer in front of channels that hold sensitive material. It is not a substitute for Discord permissions, because it only constrains this one token.

When a token has a channel allowlist, `start_meeting` must name `voiceChannelId`. There is no voice presence to infer a channel from, so an unnamed channel could not be checked against the list.

## Scope Of A Token

Every service account token is pinned to the one server it was created in. `list_servers` returns only that server, and any call naming a different server is refused. This is enforced on the server side, not by the agent's configuration.

## Using The Token

Send it as a bearer token to the MCP endpoint. There is no browser step and no refresh cycle.

```json
{
  "mcpServers": {
    "chronote": {
      "type": "http",
      "url": "https://api.chronote.gg/mcp",
      "headers": {
        "Authorization": "Bearer ${CHRONOTE_SERVICE_TOKEN}"
      }
    }
  }
}
```

Keep the token in your agent host's secret store, not in a repository.

Prefer `list_meetings` with `serverId` over `list_my_meetings`. `list_my_meetings` defaults to meetings the caller attended, and a bot never attends one.

## Revoking

Revoke a service account from the same screen you created it on. Revocation is immediate. Setting an expiry gives you a backstop if a token is forgotten.

Removing the bot's role in Discord, or removing the bot from the server, also cuts off access without touching the token.
