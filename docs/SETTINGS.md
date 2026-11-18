# Settings

Every setting is an environment variable. A `.env` file in the repo folder is read for convenience;
real environment variables win over it. A missing or invalid setting is reported by its name, never
by its value. `npm run check` lists every problem at once, and catches the usual mix-ups before
anything connects: the two Slack tokens swapped, a channel name or a channel link where the id goes
(for a link it names the id in it), a name or email where a member id goes, a misspelled time zone,
an on or off setting written as anything but `true` or `false`, a password in `DATABASE_URL` that
needs URL-encoding, and a value in `.env` cut short by a `#` (an unquoted `#` starts a comment
there).

On and off settings take `true` or `false`, in any case. Anything else, `yes`, `off` or `1`
included, is refused with the spelling to use, so a value is never guessed.

A change to any setting takes effect when the process restarts.

## Required

| Setting | What |
|---|---|
| `META_ACCESS_TOKEN` | The system user token (see [INSTALL.md](INSTALL.md), step 3). |
| `META_AD_ACCOUNT_ID` | The ad account, like `act_1234567890`. `act_` is added if you leave it out. |
| `RESULT_EVENT` | The event that counts as a result, for example `Purchase`, `Lead`, `CompleteRegistration`, `Schedule`, a custom event name, or a custom conversion id. |
| `ANTHROPIC_API_KEY` | Your Anthropic API key. |
| `SLACK_BOT_TOKEN` | The bot token, `xoxb-...`. |
| `SLACK_APP_TOKEN` | The app level token with `connections:write`, `xapp-...`. |
| `SLACK_CHANNEL` | The channel id (`C...`) the agent works in, not its name. |
| `DATABASE_URL` | A Postgres connection string, `postgres://user:password@host:5432/dbname`. Any of `@ : / ? # [ ] %` or a space in the password must be URL-encoded (`@` is `%40`, `:` is `%3A`, `/` is `%2F`, `?` is `%3F`, `#` is `%23`, `[` is `%5B`, `]` is `%5D`, `%` is `%25`, a space is `%20`); [INSTALL.md](INSTALL.md), step 2, has a one line command that does it. |

## Your numbers

| Setting | Default | What |
|---|---|---|
| `TARGET_COST_PER_RESULT` | not set | What one result is worth paying for. Every guardrail is a multiple of it. The optimizer proposes nothing until there is one. An operator can also set it in Slack (`brain set policy/target 40`), and then the brain's value wins; `status` and the check say which one is in use. `1250` and `1,250` both work; a currency symbol is ignored. |
| `MAX_DAILY_BUDGET` | not set | The ceiling on the total daily budget across everything in scope. Every budget write (approvals and direct orders) is refused if it would take one budget, or the total, above it. While it is not set, budget changes are turned off. Only this setting sets it, on purpose: nobody can raise it from Slack. |

Both are in the ad account's own currency. The agent reads the currency from the ad account and
writes every amount in it, in Slack and in its prompts.

## Meta

| Setting | Default | What |
|---|---|---|
| `META_PAGE_ID` | not set | The Facebook Page id (digits). Needed for comment moderation and message replies. |
| `META_PIXEL_ID` | not set | The dataset (pixel) id. The check and the `pixel_health` tool use it. |
| `META_IG_USER_ID` | found from the Page | The Instagram business account id. |
| `META_API_VERSION` | `v25.0` | The Graph API version. `25`, `v25` and `v25.0` all mean `v25.0`. |
| `CAMPAIGN_ALLOWLIST` | not set (whole account) | Comma separated campaign ids (digits, from the Campaign ID column in Ads Manager). When set, the agent reads and changes only these campaigns (plus copies it makes of them). |

## What counts as a result

| Setting | Default | What |
|---|---|---|
| `RESULT_LABEL` | the event name | The word the agent uses for a result in Slack, for example `purchases`, `leads` or `test rides`. |
| `RESULT_ACTION_TYPE` | mapped from `RESULT_EVENT` | The exact Insights action type to count, when the mapping picks the wrong one. Comma separated for a list; the first one reported wins. `npm run check` prints the candidates the account reported. |
| `SECONDARY_EVENT` | not set | A second event to watch and report (for example `Lead` next to `Schedule`). It is reported, never optimized. |
| `SECONDARY_LABEL` | the event name | Its word in Slack. |
| `SECONDARY_ACTION_TYPE` | mapped | Same as `RESULT_ACTION_TYPE`, for the secondary event. |

Each row is counted once: of the candidate action types for an event, only the first one Meta reports
is used, so an event that appears under two names is never counted twice.

## Claude

| Setting | Default | What |
|---|---|---|
| `MODEL` | `claude-opus-5-5` | The model for chat, the optimizer, moderation and the report. |
| `MODEL_EFFORT` | `high` | How hard the model thinks: `low`, `medium`, `high`, `xhigh` or `max`. Higher costs more tokens per answer. |
| `WEB_RESEARCH_ENABLED` | `true` | Lets chat answers use Claude's web search (for example to look up a Meta policy). An admin can turn web search off for the organization on the Claude Console's Capabilities page; if yours is off, set this to `false` ([INSTALL.md](INSTALL.md), step 5). The agent also stops offering it after the first refusal. Each search is billed on top of tokens. |

## Slack

| Setting | Default | What |
|---|---|---|
| `ADMIN_SLACK_USER_IDS` | empty | Comma separated member ids (`U...`) of the operators. Only they can approve, reject, give orders, change the brain or the ladder. Empty means nobody can. Adding or removing an operator is a change here and a restart. |

## Database

| Setting | Default | What |
|---|---|---|
| `DATABASE_SSL` | `auto` | How the connection uses SSL: `disable`, `require` (encrypted, the certificate is not checked), or `verify` (encrypted, and the certificate must be signed by a trusted CA and match the host). `auto` uses the URL's `sslmode` when it has one, otherwise `disable` for a local host (`localhost`, `127.0.0.1`, `::1`, `postgres`, `db`, `host.docker.internal`) and `require` for any other. Any value other than `auto` wins over the URL. [SECURITY.md](../SECURITY.md) says what each one protects against. |
| `DATABASE_SSL_CA` | not set | The path to your provider's CA certificate file, for `verify` when the CA is not one the system trusts. |

## Schedule

| Setting | Default | What |
|---|---|---|
| `TIMEZONE` | the ad account's time zone | An IANA name like `America/New_York`. Days and schedule times use it. |
| `INTERNAL_SCHEDULER` | `true` | `false` turns the timers off; run `npm run job -- <name>` from your own scheduler (see [INSTALL.md](INSTALL.md), step 9). |
| `REPORT_ENABLED` | `true` | `false` stops the daily report's timer. `report` in Slack and `npm run job -- report` still post one on demand. |
| `REPORT_TIME` | `09:00` | 24 hour time. The weekly review also runs at this time. |
| `OPTIMIZER_ENABLED` | `true` | `false` turns the optimizer off everywhere: its timers stop, and `npm run job -- optimizer` (or `optimizer-check`) and `optimize` in Slack refuse with one line. Cards already posted still work, and direct orders still work. `status` and the Home tab say it is off. |
| `OPTIMIZER_TIME` | `08:45` | The full daily run. |
| `OPTIMIZER_EVERY_HOURS` | `6` | The lighter check between mornings; `0` turns it off. 0 to 24. |
| `WEEKLY_DAY` | `monday` | The day of the weekly review. |

## Comment moderation

| Setting | Default | What |
|---|---|---|
| `MODERATION_ENABLED` | `true` | `false` stops the comment sweep's timer (the sweep needs `META_PAGE_ID`). `scan comments` in Slack and `npm run job -- moderation` still run it on demand. |
| `MODERATION_EVERY_MINUTES` | `60` | 10 to 1440. |
| `MODERATION_ACTION` | `hide` | `hide` hides clear spam, abuse and false claims (reversible). `delete` deletes them (falls back to hide when Meta refuses). `flag` acts on nothing and only reports. |
| `MODERATION_MIN_CONFIDENCE` | `0.7` | Below this the comment is left up and flagged to the channel once. |

## Process

| Setting | Default | What |
|---|---|---|
| `PORT` | `3000` | The health endpoint, `GET /health` (the only path served; others answer 404). |
| `HEALTH_SECRET` | not set | When set, `GET /health` with the header `x-health-secret: <value>` returns job health and open issues as JSON ([INSTALL.md](INSTALL.md), step 8). |

## Thresholds you can tune from Slack

The guardrails are fixed rules in code, scaled by the target. The defaults suit an expensive result on
a modest budget. An operator can change any of them without a deploy, one number at a time, in Slack
(or from the terminal with `npm run cmd -- ...`). [PLAYBOOK.md](PLAYBOOK.md) explains each one in
plain words for the team; this section is the exact rule, for the developer:

```
thresholds                                   every threshold and its value now
threshold pause.zeroResultSpend 4            change one
threshold pause.zeroResultSpend default      put it back to the default
brain set policy/target 180                  the target, overriding TARGET_COST_PER_RESULT
```

All the changes live in one brain row, `policy/thresholds`, as JSON. A developer can write several
at once: `brain set policy/thresholds {"pause":{"zeroResultSpend":4},"scale":{"stepPct":15}}`
(from a terminal, wrap the JSON in single quotes, or type it on a line of `npm run cmd`). Every write is checked: an unknown name, a value
that is not a number or one outside the allowed range is refused with what was wrong, and nothing is
saved. `status` shows the target's source and every threshold that differs from its default.

`T` below is the target cost per result.

| Group | Key | Default | Allowed | Meaning |
|---|---|---|---|---|
| `pause` | `zeroResultSpend` | 3 | 0.5 to 50 | An ad with zero results after spending 3 T is a clear loser. |
| | `overTargetMult` | 3 | 1 to 20 | Or an ad costing 3 T per result ... |
| | `minDays` | 3 | 1 to 30 | ... over at least 3 mature days. |
| | `heavyOverMult` | 1.5 | 1 to 10 | Or an ad 1.5 T per result ... |
| | `heavySpendMult` | 10 | 1 to 100 | ... after spending 10 T. |
| | `keepMinActive` | 1 | 0 to 20 | A pause must leave at least this many active ads in the ad set, or it goes to a person. |
| `scale` | `stepPct` | 20 | 1 to 100 | A raise is at most 20% at a time ... |
| | `minHours` | 48 | 0 to 720 | ... at least 48 hours after the last budget change ... |
| | `minResults` | 5 | 1 to 1000 | ... for an ad set or campaign with at least 5 results in the window ... |
| | `accountCapMult` | 1.3 | 1 to 10 | ... keeping the total daily budget under 1.3 times its level a week ago. |
| `descale` | `stepPct` | 20 | 1 to 100 | A trim is at most 20% at a time ... |
| | `minHours` | 48 | 0 to 720 | ... at least 48 hours after the last budget change ... |
| | `overTargetMult` | 1.25 | 1 to 10 | ... only when cost per result is more than 25% over T. |
| `winner` | `minProb` | 0.9 | 0.5 to 0.999 | A proven winner is at least 90% likely to cost under T ... |
| | `minDays` | 4 | 1 to 30 | ... over at least 4 mature days. |
| | `priorResults` | 3 | 0 to 100 | How much weight the starting assumption (cost = T) carries, in results. |
| `data` | `lagDays` | 2 | 0 to 7 | Days younger than this are not judged (Meta keeps attributing results for about two days). |
| | `windowDays` | 10 | 3 to 60 | The window the optimizer reads. |
| `suppression` | `rejectCooldownDays` | 7 | 0 to 90 | A rejected move is not proposed again for 7 days, unless its numbers move clearly. |
| | `budgetRecommitDays` | 2 | 0 to 30 | An applied budget move can be revisited after 2 days. |

"Likely to cost under T" comes from a Gamma-Poisson model of results per unit of spend: each ad starts from
the assumption that it costs T, worth `priorResults` results, and its own spend and results move it
from there. Small numbers move it a little; large numbers decide it.

## Brain rows the code reads

Most brain rows are free text the prompts read as written. Three are read as data and checked when
they are written:

| Row | What it must be |
|---|---|
| `policy/target` | A plain number in the ad account's currency, like `150`. |
| `policy/thresholds` | JSON as above, or use the `threshold` command. |
| `moderation/extra_posts` | Post ids separated by commas, like `123456789_987654321`. |

Any other `policy/...` row is refused, because nothing would read it.
