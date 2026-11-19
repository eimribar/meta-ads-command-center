# Install

This guide is for whoever sets the agent up. It needs five things: the code, a Postgres database,
a Meta system user token, a Slack app and an Anthropic API key. Plan on about an hour the first
time. Do the steps in order; each one fills a few lines of `.env`. At the end, `npm run check`
shows one green line per piece.

Where you host it is your choice. It is one long lived Node process that needs no public address,
so it runs on a laptop, a virtual machine, a container platform or a Kubernetes pod alike.

Four values are business decisions, not technical ones: what counts as a result, the target cost
per result, the daily budget ceiling and who the operators are. Get them, and the facts for the
brain (step 7), from whoever owns the ad budget before step 3.6. Without the target and the ceiling the agent still runs, with the
optimizer off and every budget change refused, and the check's last line says so.

## 1. The code

You need Node 22 or newer (`node --version`), or Docker.

```bash
git clone https://github.com/eimribar/meta-ads-command-center.git
cd meta-ads-command-center
npm install
cp .env.example .env
```

If your team keeps its own copy of the repository (a fork), clone that URL instead.

Fill `.env` as you go through the next steps. Write values without quotes, and never use `#` in a
value: in `.env` an unquoted `#` starts a comment and cuts the value off (the check says when that
happened). On a server or a container platform you can set the same names as environment variables
instead; [SETTINGS.md](SETTINGS.md) explains every one.

## 2. Postgres: the database

Any Postgres 13 or newer works. The agent needs one database and a user that can create tables in
it.

- **You have a Postgres** (a managed one from any provider, or your own): create a database for the
  agent and copy its connection string.
- **You have none yet:**
  - on a Mac, install Postgres.app (postgresapp.com), open it and click Initialize;
  - on Linux, install your distribution's package (`sudo apt install postgresql` on Debian and
    Ubuntu; `sudo dnf install postgresql-server`, then `sudo postgresql-setup --initdb` and
    `sudo systemctl enable --now postgresql` on Fedora);
  - on Windows, use the installer from postgresql.org;
  - or create a database at any hosted Postgres provider and copy its connection string. This is
    also the way on a machine where you cannot install anything.
- **You use Docker Compose:** skip this step; `docker compose up` brings its own Postgres (step 8).

On your own Postgres, create a user and a database for the agent. Run this as the Postgres admin
user, in `psql` (`sudo -u postgres psql` on Linux; on a Mac with Postgres.app, double click a
database in its window) or in any SQL console (a hosted provider's web console works), with a
password of your own:

```sql
CREATE ROLE agent LOGIN PASSWORD 'choose-a-password';
CREATE DATABASE agent OWNER agent;
```

Put the connection string in `DATABASE_URL`. For the database above, on the same machine:

```
DATABASE_URL=postgres://agent:choose-a-password@localhost:5432/agent
```

A password with any of `@ : / ? # [ ] %` or a space must be URL-encoded in the string: `@` is `%40`,
`:` is `%3A`, `/` is `%2F`, `?` is `%3F`, `#` is `%23`, `[` is `%5B`, `]` is `%5D`, `%` is `%25`, a
space is `%20`. This prints the encoded form of a password:

```bash
node -e "console.log(encodeURIComponent(process.argv[1]))" 'the password'
```

The check catches an unencoded one before anything connects.

SSL is decided like this: an `sslmode` in the URL is followed; without one, SSL is off for a local
host (`localhost`, `127.0.0.1`, `::1`, `postgres`, `db`, `host.docker.internal`) and on for any other.
`DATABASE_SSL=require` or `disable` sets it yourself. `DATABASE_SSL=verify` also checks the server's
certificate; if your provider uses its own CA, download its certificate file and put its path in
`DATABASE_SSL_CA`. [SECURITY.md](../SECURITY.md) says what each mode protects against.

Create the tables:

```bash
npm run db:setup
```

It prints `Created 14 tables; all 14 are ready (SSL: disable).` (with your SSL mode), and is safe to
run again: the second time it prints `All 14 tables were already there; nothing changed`. `npm start`
also creates any missing table on its own. On a database from an older version, both add what the
new version needs (a column, an index) and name it.

**When a database admin creates the tables** instead (for example your team runs
[`db/schema.sql`](../db/schema.sql) with its own tools, and the agent's user may not create tables),
the tables belong to the admin's user, and the agent's user needs access to them. Connected as the
user that owns the tables (or a database admin), run this in the agent's database, with your own
names for `owner` and `agent`:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agent;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agent;
ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agent;
ALTER DEFAULT PRIVILEGES FOR ROLE owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO agent;
```

The last two lines make the tables a later upgrade adds usable by the agent too, as long as the same
owner creates them. The other way is to hand the tables to the agent's user, so upgrades need nobody
else: `ALTER TABLE <name> OWNER TO agent;` for each of the 14 tables, run by a superuser. On a
managed Postgres that gives you no superuser, use the GRANT lines above. `npm run check` and
`npm run db:setup` print both, with your real user names and every table name, when they find
tables the agent cannot use. When the agent's user may not create tables in an empty database,
they print the GRANT for that instead.

The database is all the brain needs, so you can fill it in from this terminal now (step 7), before
Meta and Slack are set up.

## 3. Meta: a system user token

The agent reads and changes the ad account through a system user: a non human account inside your
Meta business portfolio, whose token does not depend on any person's login. You need someone who is
an admin of the business portfolio for this step.

**3.1 A Meta app.** Go to developers.facebook.com/apps/creation.

1. **App details:** a name (for example "Ads Command Center") and a contact email.
2. **Use cases:** pick **Create & manage ads with Marketing API**. This is the one that matters. Add,
   if you want them:
   - **Manage everything on your Page**, for comment moderation;
   - **Engage with customers on Messenger from Meta**, for replies to Page messages;
   - **Manage messaging & content on Instagram**, for Instagram comments and messages. When it asks
     for an API setup, pick **API setup with Facebook login**: the agent reaches Instagram through
     the Page, with the `instagram_basic`, `instagram_manage_comments` and
     `instagram_manage_messages` permissions. The Instagram login setup gives other permissions
     (named `instagram_business_...`) that the agent does not use, and Meta allows only one of the
     two setups per app;
   - the use case about ad leads (on screen it speaks of capturing and managing ad leads), for
     reading lead forms: it carries `leads_retrieval`. If your screen shows no such use case, open
     each picked use case's Customize page and look for `leads_retrieval` and `pages_manage_ads`
     there.

   A greyed out use case cannot be combined with the ones you already picked, and use cases cannot
   be removed once the app exists. A second app does not help, because the agent uses one token
   from one app: create the app again and pick the use cases you need together. Every use case but
   the first is optional: the agent works without each of the others, and loses only the feature
   named next to it above.
3. **Business:** connect the business portfolio that owns the ad account and the Page. The system
   user must be in the same portfolio as the app.
4. **Requirements:** read what it lists. If it lists Business Verification, an admin of the
   portfolio starts it in Business settings (Security Center). Meta asks for it before it grants a
   permission's higher access level (below). Then **Overview**, then **Go to dashboard**.

**Access.** You do not need App Review to run your own ad account: the default access to
`ads_read` and `ads_management` covers an app that manages its own business's ad account, with
lower rate limits. If the agent's reads start failing with Meta error 17 or 80004 (too many
calls), apply for the higher access level in the app dashboard, under App Review (the screen calls
it Advanced or Full access); this is where Meta asks for Business Verification. Reading lead forms
uses `leads_retrieval` and `pages_manage_ads`, which can also need App Review; the agent works
without them and only the lead form numbers are missing.

**Development and Live.** A new app starts in Development mode. In Development, Meta gives the app
data only about people who have a role on it, so comments and messages from the public can come back
without the person's details, or not at all. Once the check is green, switch the app to Live (the
mode switch in the dashboard; some dashboards call it Publish). Live needs a Privacy Policy URL in
App settings > Basic: a public page with your own company's privacy policy.

**3.2 A system user.** In Business settings (business.facebook.com/settings): Users > System
users > Add. Give it a name and pick a role:

- **Employee** (recommended): it can touch only the assets you assign to it in 3.3.
- **Admin** works too, but reaches every asset the portfolio owns; Meta advises against managing
  assets with an admin system user.

A portfolio starts with room for one system user and one admin system user. If yours already has an
Employee system user, you can reuse it when everything assigned to it is something you are fine with
this agent reaching, because the token reaches all of it. If it reaches more, or it is the admin
system user, give the agent a system user of its own: Add on the System users page shows whether the
portfolio has room for another. [SECURITY.md](../SECURITY.md) says why this matters.

**3.3 Assign the app and the assets.** On the system user, Assign assets (some screens call it Add
assets), and give it:

| Asset | Access |
|---|---|
| Your app (Apps) | Manage app (older screens say Full control) |
| The ad account | **Manage campaigns** (partial access; it covers pausing, budgets and copying campaigns) |
| The Facebook Page the ads run from | **Everything** (full access), or at least Content, Community activity (comments), Messages and calls (message replies), Ads and Insights |
| The dataset (pixel) | the lowest access the screen offers: the agent only reads when it last fired |
| The Instagram account, if your ads run there | Content, Community activity and Messages. The Instagram account must be linked to the Page. |

If the ad account belongs to another business portfolio (an agency's, or a client's), someone with
full access to that portfolio first shares it with yours: Settings > Partners > Add > Give a
partner access to your assets, with your portfolio's ID. Then assign it to the system user as above.

**3.4 The token.** On the system user, Generate new token. Pick your app, choose the expiry, and
tick the permissions below. For the expiry, pick the one that never expires if the screen offers it.
Otherwise the token lasts 60 days: put a reminder in your calendar a week before the date it shows,
and generate a new one then (step 10). An expired token stops every job, and the check and the jobs
say Meta error 190.

| Permission | Why |
|---|---|
| `ads_read`, `ads_management` | read numbers, pause, budgets, copy campaigns |
| `business_management` | read the assets the business owns (optional) |
| `pages_show_list`, `pages_read_engagement`, `pages_read_user_content` | read the Page, its posts and comments |
| `pages_manage_engagement` | hide, reply to or delete comments |
| `pages_messaging` | answer messages to the Page (optional) |
| `instagram_basic`, `instagram_manage_comments` | read and moderate Instagram comments (optional) |
| `instagram_manage_messages` | read and answer Instagram messages (optional) |
| `pages_manage_ads`, `leads_retrieval` | read the Page's lead forms and their lead counts (optional) |

A permission missing from the list comes with a use case the app does not have yet. In the app
dashboard, Use cases, each use case's Customize page lists its permissions: look for the missing one
there, add the use case whose list has it (3.1), then generate the token again. The ones marked
optional can stay missing. The token is shown once: copy it into
`META_ACCESS_TOKEN` and treat it like a password.

**3.5 The ids.**

- `META_AD_ACCOUNT_ID`: in Ads Manager, the number after `act=` in the address bar. Write it as
  `act_1234567890` (the `act_` is added for you if you leave it out). If you paste the whole
  Ads Manager link, the check names the number in it.
- `META_PAGE_ID`: Business settings > Accounts > Pages, or the Page's About section.
- `META_PIXEL_ID`: Events Manager > Data sources, the dataset id.
- The Instagram account is found from the Page; set `META_IG_USER_ID` only if that fails.

**3.6 The result** (from whoever owns the ad budget). In Events Manager, find the event that counts
as a result for you: `Purchase` for a store, `Lead` for a lead form, `Schedule` for a booked call or
visit, `CompleteRegistration` for a signup. Put its name in `RESULT_EVENT` and your team's word for
it in `RESULT_LABEL`. A second event you watch goes in `SECONDARY_EVENT`. Each event is counted as
exactly one Meta action type (`Lead` as `lead`, which counts website and instant form leads alike;
`Schedule` as `schedule_website`; the table is in [SETTINGS.md](SETTINGS.md#what-counts-as-a-result)).
A custom event, a name of your own, is reported by Meta only through a custom conversion: create one
for it in Events Manager (Custom conversions) and put its id in `RESULT_EVENT`, or set
`RESULT_ACTION_TYPE=offsite_conversion.custom.<its id>`. The check reads the last 30 days and prints
the action type it counts, how many it saw and every other type the account reported, so a wrong
pick is easy to change.

**3.7 The numbers** (from whoever owns the ad budget). `TARGET_COST_PER_RESULT` is what one result
is worth paying for, and `MAX_DAILY_BUDGET` the most the account may spend per day in total, both in
the ad account's currency. Until there is a target, the optimizer proposes nothing; until there is a
ceiling, every budget change is refused, orders included. The ceiling is a daily one, so the agent leaves
campaigns and ad sets on a lifetime budget to Ads Manager: it reports on them, and refuses to change
their budget or switch them on.

## 4. Slack: the app

1. On api.slack.com/apps: Create New App > From a manifest. Pick your workspace. The manifest box
   opens on JSON: switch it to YAML, then paste the contents of
   [`slack-app-manifest.yaml`](../slack-app-manifest.yaml). It turns on Socket Mode, so the agent
   needs no public address. The app is called **Ads Command Center**; change both names in the file
   first if you want another.
2. In the app's settings, Install App (in the left menu, under Settings) > Install to Workspace. If
   your workspace requires approval for new apps, this sends a request to the Workspace Owners (or
   app managers), and the app works once they approve it. Then, under OAuth & Permissions, copy the
   Bot User OAuth Token (starts with `xoxb-`) into `SLACK_BOT_TOKEN`.
3. Under Basic Information > App-Level Tokens, generate a token with the `connections:write` scope.
   Copy it (starts with `xapp-`) into `SLACK_APP_TOKEN`.
4. Pick the channel the agent works in (public or private). In it, type
   `/invite @Ads Command Center`. Click the channel name: the Channel ID (starts with `C`) is at the
   bottom of the About tab. Put it in `SLACK_CHANNEL` (the id, not `#name`).
5. Operators (from whoever owns the ad budget) are the people who can approve cards and confirm orders.
   For each, open their profile, the three dots menu, Copy member ID (starts with `U`). Put the ids
   in `ADMIN_SLACK_USER_IDS`, separated by commas. Adding or removing one later is a change here and
   a restart.

## 5. Claude: the key

In the Claude Console (platform.claude.com):

1. **Billing.** API calls run on prepaid credits, and stop when they run out. Someone with the Admin
   or Billing role buys them under Settings > Billing (auto reload is available).
2. **A spend limit.** Set a monthly spend limit for the organization on the Spend limits page
   (platform.claude.com/settings/spend-limits). To cap the agent alone, create a workspace for it,
   set a limit on that workspace there (the Default Workspace cannot have one) and create the key
   inside it.
3. **The key.** API keys > Create key. Put it in `ANTHROPIC_API_KEY`.

The agent uses `claude-opus-5-5` at high effort by default; `MODEL` and `MODEL_EFFORT` change that.
Chat answers can use Claude's web search, which is billed per search on top of tokens. An admin can
turn web search off for the whole organization on the Console's Capabilities page
(platform.claude.com/settings/capabilities). If yours is off, set `WEB_RESEARCH_ENABLED=false`; the
agent also stops offering it on its own after the first refusal.

## 6. The check

```bash
npm run check
```

With Docker Compose, create the tables in the bundled database first, then run the check (each
command starts the database if it is not running):

```bash
docker compose run --rm agent npm run db:setup
docker compose run --rm agent npm run check
```

It prints one line per piece, never a value, and every problem once:

```
Settings
OK    every setting is present and valid

Meta
OK    reads the ad account (currency EUR, time zone Europe/Amsterdam)
OK    scope: the whole ad account
OK    the token has the permissions the agent needs
OK    reads the Page and its Page token
OK    reads the dataset (pixel); it last fired 2026-11-17
OK    result "test rides" seen: 212 in the last 30 days, counted as schedule_website
      the account also reported: lead, contact_website

Slack
OK    the bot token works (workspace Northfield Bikes)
FIX   the bot is not in the channel
      fix: in that channel, type /invite and pick the app
OK    2 operators found
OK    the app token can open a Socket Mode connection

Database
OK    connected (SSL: require)
OK    tables: every table exists and this user can use them

Claude
OK    the key works and can use claude-opus-5-5

Your numbers
OK    target cost per result: €40, from TARGET_COST_PER_RESULT
OK    daily budget ceiling: €1,500, from MAX_DAILY_BUDGET

1 thing to fix. Fix it and run npm run check again.
```

It exits with an error while any line says FIX. "Your numbers" shows the target and the ceiling as it read them, in the account's
currency, and where the target comes from (the setting, or the brain when an operator set it in Slack) and warns when the target or the ceiling is
missing or the optimizer is turned off; then a last line says what stays off until they are set.

## 7. First day: the brain and a dry run

1. **The brain.** Without it the agent knows the ad account and nothing about your business. Write
   the rows in [PLAYBOOK.md](PLAYBOOK.md), in Slack once it runs, or from this terminal now. The
   terminal takes the same commands as Slack and counts as an operator. For one command, wrap the
   text in single quotes, so the shell keeps its quotes, braces and `#` as typed:

   ```bash
   npm run cmd -- brain set business/company 'Northfield Bikes sells city e-bikes online and from two showrooms.'
   npm run cmd -- brain
   ```

   For several rows, or text with an apostrophe in it, run `npm run cmd` on its own and type (or
   paste) one command per line, exactly as you would in Slack; `exit` or Ctrl+D ends. It also reads
   a file or a here document, one command per line:

   ```bash
   npm run cmd <<'EOF'
   brain set business/voice Plain and practical. We say e-bike, never electric bicycle.
   brain set moderation/scope Remove comments that share someone's personal details.
   EOF
   ```

   With Docker Compose: `docker compose run --rm agent npm run cmd -- brain` and so on (add `-T`
   after `run` when you pipe commands in).
2. **A dry run.** `npm run job -- optimizer --dry-run` prints what it would propose today, and
   files and posts nothing.
3. **A question.** `npm run ask -- "how did we do last week?"` prints one read only answer.

With Docker Compose, put `docker compose run --rm agent` in front of each, or
`docker compose exec agent` when the agent is already running.

## 8. Run it

It is one long lived process. Run one copy.

**With Node:**

```bash
npm ci --omit=dev
npm start
```

Keep it running with whatever your team already uses for services. Two examples, if you have none
yet (paths and the user name are yours to change):

A systemd unit on Linux, `/etc/systemd/system/meta-ads-command-center.service`, then
`sudo systemctl enable --now meta-ads-command-center`:

```ini
[Unit]
Description=Meta Ads Command Center
After=network-online.target

[Service]
WorkingDirectory=/srv/meta-ads-command-center
# the full path to npm: the output of `which npm` on this machine (nvm and other
# installers put it somewhere else than /usr/bin/npm)
ExecStart=/usr/bin/npm start
Restart=always
User=agent

[Install]
WantedBy=multi-user.target
```

Or pm2: `npm install -g pm2`, then, in the repo folder,
`pm2 start npm --name meta-ads-command-center -- start` and `pm2 save`.

**With Docker:**

```bash
docker build -t meta-ads-command-center .
docker run --env-file .env -p 127.0.0.1:3000:3000 meta-ads-command-center
```

The image has a health check of its own (`GET /health`), so `docker ps` shows it healthy or not.
Two things to know about `docker run`:

- `--env-file` passes each value exactly as written, quotes included, so write `.env` without quotes.
- Inside a container, `localhost` is the container itself. A database on the host machine is
  `host.docker.internal` on Docker Desktop (on Linux, add `--add-host=host.docker.internal:host-gateway`).

**With Docker Compose and a bundled Postgres:** leave `DATABASE_URL` empty in `.env`, run the two
commands in step 6 once, then `docker compose up -d`. The data stays in a Docker volume. Compose reads
a `$` in `.env` as the start of a variable, so a value with a `$` in it comes out changed: in a
database password, write it URL-encoded as `%24`. The health check is published on `127.0.0.1`
only. `docker compose logs -f agent` shows its log. The bundled database is reached from
inside Compose: `docker compose exec db psql -U agent agent` opens it, and
`docker compose exec db pg_dump -U agent agent > backup.sql` backs it up. To reach it from your own
tools on this machine, uncomment the `ports` line under `db` in `docker-compose.yml`.

**On a container platform:** build from the Dockerfile, set the settings as environment variables,
point the platform's health check at `GET /health` on `PORT`, and run exactly one instance:
minimum and maximum one, never scaled to zero, with CPU always allocated. The agent gets no incoming
requests; it holds an outgoing connection to Slack and runs its own timers, so a platform that
pauses an idle instance, or gives it CPU only while a request is open, stops it from working. No
public URL or open port is needed for Slack.

On start it logs `[health] listening`, the tables it created or upgraded (if any), `[slack] connected
(Socket Mode)` and the next time of each scheduled job. It stops, with one line that says why, when a
required setting is missing, the database cannot be reached, Slack cannot be reached
(`[slack] Slack could not be reached`, a network or DNS problem on this machine) or Slack refuses a
token (`Slack refused the bot token`, with Slack's reason): whatever keeps it running (a process
manager, a container platform) starts it again, and the log says what to fix. `DEBUG=1` adds the full
error stack under that line.

**Health:** `GET /health` on `PORT` (default 3000) answers three lines, `ok`, `slack: <state>` and
`database: <state>`; every other path answers 404. It is up from the first second, before Slack
connects. When the database stops answering, it answers 503 with `not ok` and
`database: not answering`, so a platform's health check sees it. Slack's states:

| State | What |
|---|---|
| `starting` | reading the settings, the database and the ad account, and checking the Slack tokens |
| `connecting` | opening the connection to Slack |
| `connected` | working |
| `reconnecting` | the connection dropped and is coming back on its own |
| `disconnected` | the connection is closed (the process is stopping) |

The database line is `starting` in the first seconds of a start, before the database is connected,
then `ok`, or `not answering` (with the 503).

With the header `x-health-secret` set to `HEALTH_SECRET`, it returns JSON instead: `ok`, `slack`
(the state), `database`, `reason` (when not ok), `started_at`, `jobs` (each job's last run and
failures) and `incidents` (the open issues). `jobs` and `incidents` are `null` in the first seconds of
a start, until the database is connected, and while the database does not answer.

**One copy, and rolling deploys.** Two copies running at once, for example while a rolling deploy
swaps the old one for the new one, do not double anything: each scheduled job claims its slot in
the database before it runs, and Slack hands each message and button press to only one of the open
connections. A second copy adds nothing, so keep one.

## 9. Scheduling

By default the process runs its own timers, in `TIMEZONE` (or the ad account's time zone when
`TIMEZONE` is not set):

| Job | When | What |
|---|---|---|
| `optimizer` | daily at `OPTIMIZER_TIME` (08:45) | the full run: investigates, then proposes |
| `report` | daily at `REPORT_TIME` (09:00) | the daily report |
| `optimizer-check` | every `OPTIMIZER_EVERY_HOURS` (6), on the UTC clock | a lighter run between mornings |
| `moderation` | every `MODERATION_EVERY_MINUTES` (60), on the UTC clock; only with `META_PAGE_ID` | the comment sweep |
| `weekly` | on `WEEKLY_DAY` (monday) at `REPORT_TIME` | the weekly review and fresh lessons; it runs even with `REPORT_ENABLED=false` |

A process started after a daily job's time still runs that day's job. The two "every" jobs run on
the UTC clock, not in `TIMEZONE`: every 6 hours means just after 00:00, 06:00, 12:00 and 18:00 UTC.
Without `META_PAGE_ID` there is no comment sweep timer, and the start log says so.

**Your own scheduler instead:** set `INTERNAL_SCHEDULER=false`. The process keeps serving Slack and
your scheduler (cron, a cloud scheduler, a CI schedule) runs the jobs as commands:

```bash
npm run job -- report
npm run job -- optimizer
npm run job -- optimizer-check
npm run job -- moderation
npm run job -- weekly
```

Each job claims its slot in the database (the day, the hour window, the week). Running it again after
it succeeded in that slot does nothing, so a double trigger is harmless. Running it again after it
failed runs it again. A job that fails (for example because Meta refused the token) exits with an
error and is recorded as failed, and three failures in a row open an issue in Slack. Add `--force`
to run one again after a success anyway, and `--dry-run` to see what it would do without filing or
posting anything. With `OPTIMIZER_ENABLED=false`, `npm run job -- optimizer` and `optimizer-check`
refuse with one line and exit with an error.

Example crontab, in the server's time zone. Cron starts with a short `PATH` that often has no Node
in it, so the first line gives it one: put the folder that holds `node` and `npm` there
(`dirname "$(command -v node)"` prints it; with nvm it is under `~/.nvm`).

```
PATH=/usr/local/bin:/usr/bin:/bin
45 8 * * *    cd /srv/meta-ads-command-center && npm run job -- optimizer
0 9 * * *     cd /srv/meta-ads-command-center && npm run job -- report
0 */6 * * *   cd /srv/meta-ads-command-center && npm run job -- optimizer-check
5 * * * *     cd /srv/meta-ads-command-center && npm run job -- moderation
0 9 * * 1     cd /srv/meta-ads-command-center && npm run job -- weekly
```

## 10. Later

- **Operators, or any other setting:** change it (in `.env` or the platform's environment) and
  restart. Settings are read once, at start.
- **A new Meta token:** put it in `META_ACCESS_TOKEN` and restart. When a token expires, the check
  and every job say Meta error 190.
- **Upgrades:** pull the new code, `npm ci`, restart. Missing tables, and the columns and indexes a
  new version adds, are added on start and named in the log (`npm run db:setup` does the same by
  hand). When a database admin owns the tables (step 2), the agent's user cannot change them: the
  check says `the tables need an upgrade (...), and only their owner, <owner>, can add it`, and the
  owner runs the new [`db/schema.sql`](../db/schema.sql) in the agent's database (`psql -d <database>
  -f db/schema.sql`, connected as the owner). It only adds what is missing and is safe to run again;
  with the default privileges from step 2 the agent can use the new tables right away. If `slack-app-manifest.yaml` changed, paste it into the
  app's App Manifest page and reinstall the app. With Compose: `git pull && docker compose up -d --build`.
- **Backups:** the database holds the brain, every decision and the write journal. Back it up like
  any Postgres database.
