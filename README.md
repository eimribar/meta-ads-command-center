# Meta Ads Command Center

A Slack agent for a Meta (Facebook and Instagram) ads account. It works with your team from one
Slack channel, where it shows up as **@Ads Command Center**.

It reads the account live, posts a daily report, proposes budget and pause moves as approve or reject
cards, carries out direct orders from the people you name as operators, answers questions about the
account in plain words, and keeps the comments on your ads clean. Claude does the thinking. Fixed
rules in code check every move before anything changes, and a daily budget ceiling you set binds
every write.

## What it does

| | |
|---|---|
| **Daily report** | Every morning: yesterday's spend and results against your target and the week before, the best and worst ads, comments handled, and what waits for a person, followed by a scoreboard of every ad that spent this week. |
| **Optimizer** | Every morning and every few hours: looks at mature numbers per ad, ad set and campaign, and proposes four kinds of moves: pause an ad, turn an ad back on, raise a budget, trim a budget. Each move passes fixed checks against live numbers before it becomes a card. |
| **Approve or reject** | Each card has Approve and Reject, with an optional "why" box. The why notes become the lessons the optimizer follows from then on. |
| **Direct orders** | An operator can say "pause campaign X", "set the Broad ad set to 150 a day" or "duplicate campaign X" in the channel. It is done that turn, inside the ceiling. |
| **Questions** | Anyone in the channel can ask "how did we do yesterday?", "which ad is winning?", "why did cost go up?". It pulls live numbers before it answers. |
| **Comments** | Every hour: reads the comments on live ads and recent posts, hides clear spam, abuse and false claims, and flags the unsure ones to the channel. Replies and message answers go out only after a person approves the exact text. |
| **Weekly review** | Every week: the decisions made, the lessons the optimizer now follows, and an ad scoreboard. |
| **The brain** | What the agent knows about your business, written by your team (`brain set business/company ...`). The code carries no business facts; every prompt reads them from here. |

Every amount is in the ad account's own currency, which it reads from Meta. It works for any kind
of result: purchases, leads, booked calls, signups.

## How it stays safe

- **You set the money.** `TARGET_COST_PER_RESULT` is what a result is worth to you. Every threshold is a
  multiple of it. `MAX_DAILY_BUDGET` caps the total daily budget across everything in scope; with no
  ceiling set, every budget change is refused.
- **People decide money.** Budget moves and turning an ad back on always wait for a person. Pauses wait
  too, until an operator moves them to automatic (`ladder set pause auto`). Undoing an automatic
  move sends that kind of move back to waiting.
- **Operators only.** Only the Slack users in `ADMIN_SLACK_USER_IDS` can approve, reject or give orders.
  Everyone else gets read only answers.
- **Every write is journaled.** A write with no clear answer from Meta holds every later write until it is
  checked, so nothing is ever sent twice by accident.
- **Bad data freezes it.** If the numbers look broken (results with no clicks, spend with no results,
  spend running past budget), the optimizer proposes nothing and tells the channel why.

## Quick start

You need Node 22 or newer (or Docker), a Postgres database, a Meta system user token, a Slack app and
an Anthropic API key. [docs/INSTALL.md](docs/INSTALL.md) walks through each one, in this order:

```bash
git clone <this repository> meta-ads-command-center && cd meta-ads-command-center
npm install
cp .env.example .env          # fill it in as you go; docs/SETTINGS.md explains every line
npm run db:setup              # creates the tables (safe to run again)
npm run check                 # one line per piece; every FIX line says how to fix it
npm start
```

Or with Docker and a bundled Postgres: fill in `.env`, then `docker compose up -d`.

The target cost per result, the daily budget ceiling, what counts as a result and who the operators
are come from whoever owns the ad budget. Until the target and the ceiling are set, it runs with the
optimizer off and every budget change refused.

It runs anywhere a long lived Node process can run: a laptop, a virtual machine, a container
platform, a Kubernetes pod. It needs no public URL (Slack connects over Socket Mode). The scheduled
jobs run on internal timers, or from your own scheduler with `npm run job -- <name>`.

## Docs

- [docs/INSTALL.md](docs/INSTALL.md): for whoever sets it up. Postgres, Meta, Slack and Anthropic, running it, scheduling, upgrades.
- [docs/SETTINGS.md](docs/SETTINGS.md): every setting and its default, and the thresholds you can tune.
- [docs/USING.md](docs/USING.md): for the whole team. Daily life in Slack: the report, cards, questions, orders, commands.
- [docs/PLAYBOOK.md](docs/PLAYBOOK.md): what to write in the brain on day one, and the first two weeks.
- [SECURITY.md](SECURITY.md): what it can and cannot touch, where data lives, reporting a problem.

## From the terminal

```bash
npm test                                  # no keys, no network, no database needed
npm run check                             # checks every setting and connection
npm run cmd -- brain                      # any Slack command, run as an operator
npm run cmd -- brain set business/company 'One paragraph.'   # single quotes keep the text as typed
npm run job -- optimizer --dry-run        # a real run that files and posts nothing
npm run ask -- "how did we do yesterday?" # one read only answer
```

## License

MIT. See [LICENSE](LICENSE).
