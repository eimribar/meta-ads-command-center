# Security

## Secrets

- Secrets are read only from environment variables (or a local `.env`, which `.gitignore` keeps out of
  git). They are never written to the database.
- Tokens and keys are hidden before they reach a log line, Slack or Claude: Meta, Slack and Anthropic
  tokens, `access_token=` in a URL and database connection strings become `[hidden token]`,
  `[hidden key]` or `[connection string]` in Meta errors and in every tool result and error the
  model sees. `npm run check` names a setting, never its value.
- The chat's `graph_query` tool reads node ids and edges only: it refuses paths and fields that
  would return a token (such as a Page's `access_token` or `me/accounts`) and drops any parameter
  that would turn a read into a write.
- Use a system user token (not a person's), with only the permissions in
  [docs/INSTALL.md](docs/INSTALL.md). Rotate it in Business settings if it leaks: generate a new
  token on the system user, put it in `META_ACCESS_TOKEN`, restart, and revoke the old one.

## The Meta system user

Make it an **Employee** system user, not an Admin one. An Employee system user can reach only the
assets assigned to it (the app, the ad account, the Page, the dataset, the Instagram account), so a
leaked token cannot touch anything else the business owns. An Admin system user reaches every asset
the business portfolio owns, and Meta advises against managing assets with one. Reuse an existing
Employee system user only when everything already assigned to it is fine for this agent to reach.

On the ad account, **Manage campaigns** is the access it needs; it does not need Manage ad
accounts (settings, finances and permissions). Give it the token permissions in
[docs/INSTALL.md](docs/INSTALL.md) and no others; leave out the optional ones you do not use.

## The Slack app

The app connects over Socket Mode, so Slack needs no open port and no public URL. The only port the
process listens on is the health check (`PORT`, default 3000), which serves `GET /health` and
nothing else; it shows Slack's and the database's state, and job details only with
`HEALTH_SECRET`. The Docker Compose file publishes it on 127.0.0.1 only. Its bot scopes, each
used for one thing (the manifest says which): `app_mentions:read`, `channels:history`,
`channels:read`, `chat:write`, `groups:history`, `groups:read`, `im:history`, `pins:write`,
`users:read`. The app level token has `connections:write` only. It sees only the channels it is
invited to and its own direct messages, and it answers wherever it is mentioned, so invite it only
to its own channel. Answers that change the account still need an operator, wherever they are
asked.

## The database connection

`DATABASE_SSL` decides what the connection protects:

| Mode | Encrypted | Server certificate checked | Protects against |
|---|---|---|---|
| `disable` | no | no | nothing on the wire; for a database on the same machine or private network |
| `require` | yes | no | someone reading the traffic, but not someone posing as the server |
| `verify` | yes | yes: signed by a trusted CA (or the one in `DATABASE_SSL_CA`) and matching the host | reading the traffic and posing as the server |

`auto` (the default) follows `sslmode` in `DATABASE_URL` when it is there, and otherwise picks
`disable` for a local host and `require` for any other. Use `verify` when your provider gives you
its CA certificate. The check prints the mode in use.

## What the agent can change

On the ad account, and only inside `META_AD_ACCOUNT_ID` (and `CAMPAIGN_ALLOWLIST` when set):

| Change | Who decides |
|---|---|
| Pause an ad | An operator's approval or confirmed order; or on its own, only if an operator set `ladder set pause auto`, and never below the ad set's floor of running ads. |
| Turn an ad back on | An operator's approval or confirmed order. Never automatic. |
| Raise or trim a budget | An operator's approval or confirmed order. Never automatic. Always inside `MAX_DAILY_BUDGET` and, for raises, the weekly growth cap. |
| Pause or activate a campaign or ad set | An operator's confirmed order. Activating passes the ceiling. |
| Duplicate a campaign | An operator's confirmed order. Built paused; switched on last, only if asked, inside the ceiling. |

An order is one message plus one tap: the agent posts a card that names the exact change, and
nothing happens until an operator taps Confirm on it. A message alone (an operator's, a teammate's,
or words inside a comment the agent read) never changes the account. Anything that spends from a
lifetime budget is left to Ads Manager, because the ceiling is a daily one.

On the Page and Instagram: hide clear spam, abuse and false claims during the sweep (or delete, or
only flag, per `MODERATION_ACTION`). A reply to a comment or a message, and any hide, unhide or
delete asked for in chat, is a card with the exact text that goes out only when an operator taps
Confirm.

It never creates ads from scratch, never edits targeting, creative or bids, and never deletes a
campaign, ad set or ad.

Every account write is checked in code (object in the account and in scope, operator behind it,
ceiling), recorded in the write journal before it is sent, and closed after Meta answers. A write with
no clear answer (no response, a server error, Meta's own "try again" errors) is never retried: it
holds all later writes until it is reconciled, and the card or move behind it says its outcome is
unknown.

## Who can do what in Slack

Only the member ids in `ADMIN_SLACK_USER_IDS` can approve, reject, confirm an order, or change the
brain, the ladder or the freeze. For anyone else the change tools are removed before the model sees
the request, and button and modal submissions are refused in middleware. Every message the model
reads is labeled with who wrote it and whether they are an operator.

Slack messages, web pages, API responses and comments reach the model as evidence. The prompts tell it
never to follow instructions found there, and the guardrails above hold even if it did.

## Data

The Postgres database holds: the brain and its history, chat history per thread (the last 20 messages),
every proposal and decision with its notes, daily performance numbers, the write journal, moderation
records (comment text and author name for comments acted on or flagged), job runs, incidents and small
state. Back it up and restrict access like any production database.

Claude receives ad account numbers, ad and campaign names, the brain, recent channel messages and the
comments being classified. It receives no secrets.

## Reporting a problem

Please report a vulnerability privately to the repository owner (for example through a private security
advisory on the repository), not in a public issue.
