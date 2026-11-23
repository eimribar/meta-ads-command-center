# Using it

This page is for everyone on the team. The agent lives in one Slack channel. You talk to it by
mentioning it, **@Ads Command Center** (whoever set it up may have given it another name), by replying
in a thread it started, or in a direct message. It also has a Home tab: click its name in Slack.

## The words it uses

| Word | What it means |
|---|---|
| **Operator** | A person allowed to approve cards and confirm orders. Whoever set up the agent decides who the operators are; `status` lists them. Everyone else can ask anything and gets answers, but cannot change the account. |
| **Result** | The one thing your ads are for: a purchase, a lead, a booked test ride. The agent calls it by your team's word for it. |
| **Target** | What one result is worth paying for. Every judgment is against it. |
| **Ceiling** | The most the account may spend per day in total. Nothing the agent does can go above it. |
| **Desk** | The one message it posts and pins in the channel each day. The report, the cards and the alerts go in its thread, so the channel stays readable. |
| **Card** | One proposed move (pause an ad, raise a budget...) with the numbers behind it and Approve and Reject buttons. Cards the agent files have a number, like `#14`. An order is a card too, with Confirm and Cancel, but it has no number. |
| **Brain** | What the agent knows about your business: the company, the offer, the buyer, the words to use. Your team writes it. See [PLAYBOOK.md](PLAYBOOK.md). |
| **Ladder** | Which kinds of moves wait for a person and which may happen on their own. Everything starts as waiting. |
| **Threshold** | One of the numbers the agent judges ads by, like how much an ad may spend with no result before it is called a loser. Each is a multiple of the target. |
| **Journal** | The agent's record of every change it sent to Meta. When Meta never answered one, the journal holds every later change until a person checks it. |
| **Decision** | Something the team decided, kept with its reason, like "no budget changes during the spring launch, because we need one clean week to compare". The agent works within the active ones. |
| **Hypothesis** | What the team believes works, or is testing, graded confirmed or refuted once the numbers settle it. |

## What it never does on its own

- It never turns an ad back on, raises a budget or trims one without an operator's tap.
- It never pauses an ad on its own unless an operator set `ladder set pause auto`, and even then it
  never pauses the last running ads of an ad set.
- It never changes anything because of a message alone, someone else's words, or words inside a
  comment it read. A change needs an operator's tap on a card.
- It never goes over the daily budget ceiling.
- It never creates ads from scratch, never edits targeting, creative or bids, and never deletes a
  campaign, ad set or ad.
- It never sends a reply or a message without an operator's tap on the exact text.
- The one thing it does by itself every hour is the comment sweep: it hides clear spam, abuse and
  false claims (or deletes them, if whoever set it up chose that).

## The daily report

Every morning the agent posts the report under the desk. A short read at the top is written by
Claude from the numbers; the numbers themselves come straight from Meta:

- spend and results yesterday, against the target and the 7 day average;
- the second thing you watch, if your team has one (for example leads next to purchases);
- the last 7 days;
- the best ads yesterday, and the ads that spent with no result;
- comments hidden or flagged, cards waiting, open issues.

Yesterday can still go up: Meta keeps counting results for about two days.

Right after it comes the scoreboard: the 15 ads that spent most in the last 7 days, best first, each
marked winning, on track, behind, losing or too early. Losing uses the same bar as a pause: no result
after spending a few times the target.

All amounts are in your ad account's currency.

## Cards

A card is one proposed move with the numbers behind it:

```
Pause ad: Spring video v2
480 spent over 8 days with no test rides.
#14
[Approve] [Reject]
```

(The example leaves out the currency symbol; your cards show your account's.)

A card marked `#14 · needs a person` is a move the ladder would let happen on its own, held for a
person this time: someone undid or reversed the same move before, or it would leave too few ads
running in its ad set.

Approve or Reject opens a small window with an optional "why". Write one when you can: once a week
the agent turns the notes into lessons it follows from then on ("we never pause a new creative
before day 5", "this campaign is a brand play, leave it").

What happens when an operator taps Approve:

- the agent checks the card was not already decided;
- for a budget card, it reads the budget from Meta again; if someone changed it in Ads Manager
  since the card was made, the card is refused as out of date and the next run proposes again
  with fresh numbers;
- it checks the ceiling again, and for a raise, the weekly growth cap with today's budgets;
- it makes the change in Meta, and the card turns into a one line record of who approved it and
  why. If Meta gives no clear answer, the card says the outcome is unknown and `journal` lists it
  (see "When Meta never answered a change").

When two or more pause or turn-back-on cards arrive together, the message just above them in the
desk thread has an Approve all button. Budget cards are always one tap each.

A card that stops making sense closes itself: the ad was paused by hand, the budget already changed,
or a week went by.

## Asking questions

Mention it in the channel, reply in one of its threads, or send it a direct message:

- "how did we do yesterday?"
- "which ad is winning this week?"
- "why did cost per purchase jump on Tuesday?"
- "break down last week by placement"
- "what changed on the account in the last 3 days?"
- "show me the comments on our ads from today"
- "how far do people watch our video ads?"
- "which lead forms are live and how many leads did each get?"

It pulls live numbers before it answers and says when data is thin or not yet final.

**Threads.** In a thread the agent started (the desk, a report, a card) or one where it was
mentioned or already answered, just reply: no mention needed. It reads the whole thread first, so
"and the week before?" works. A reply that mentions someone else is left for that person.

Under every answer there is a line written by the system, not by the model:

```
Actions this turn: posted a card to confirm: Pause ad Spring video v2 (nothing changes until an operator taps Confirm)
```

or `No account changes this turn (read only).` If the answer ever claims a change that this line
does not show, the line is right.

## Orders (operators)

Say it plainly:

- "pause the Retargeting campaign"
- "set the Broad ad set to 150 a day"
- "activate ad set Lookalike 2%"
- "duplicate the Spring campaign and activate the copy"

It answers with a card that names the exact change, with the numbers as they are now:

```
Set the daily budget of ad set Broad from 100 to 150
[Confirm] [Cancel]
```

Nothing changes until an operator taps Confirm. Only an operator's own message files an order: a
message from someone else, or words inside a comment the agent read, never do. A card nobody
confirms expires after 24 hours. Cancel closes it with nothing changed. The operator who gave the
order can confirm it, and so can any other operator.

On Confirm, the ceiling is checked again with the live numbers: an order that would take a budget or
the daily total above it is refused, and the card says so. After each order it reads the change
back from Meta and keeps your words with the record. A copied campaign is built paused and switched
on only at the end, and only if you asked. A campaign or ad set on a lifetime budget is left to Ads
Manager, because the ceiling is a daily one.

**Taking an order back.** `undo 14` is for the agent's own moves, the cards with a number. To
reverse a confirmed order, give the opposite order: "turn the Retargeting campaign back on", "set the
Broad ad set back to 100 a day". The agent never deletes anything, so a copied campaign stays in the
account: pause it, or delete it in Ads Manager.

When the agent itself thinks something should change, it posts a card instead of acting. Ask it
"what would you change?" and it posts its ideas as cards.

## Comments and messages

Every hour the agent reads the comments on your live ads and recent posts. It hides clear spam,
harassment and flat false claims ("this is a scam"). Honest criticism, questions (even skeptical
ones) and jokes stay up. Anything it is unsure about stays up and is listed once in the desk thread. If whoever set it up
chose delete instead of hide, the sweep deletes those comments, and a deleted comment cannot be
brought back.
Each comment in that list ends with its id in code font, like `123_456`.

**Replying to a comment or a message:**

1. Ask in the channel: "reply to comment 123_456 thanking them and pointing to the pricing page".
   The id comes from the sweep list, or ask "show me today's comments" and it lists them with ids.
2. It posts a card with the comment and the exact text it would send, and sends nothing yet. Ask
   for changes in the thread ("shorter, and no exclamation mark") and it posts a new card.
3. An operator taps Confirm on the card. Only then is it sent, and the card says so. Once sent, a
   reply or a message cannot be taken back by the agent.

Hiding, unhiding or deleting a comment you ask for works the same way: a card, then Confirm. Meta
allows replies to a message only within 24 hours of the person's last message. To undo a hide:
"unhide comment 123_456".

## The brain

The brain is what the agent knows about your business. Each row is named by a section and a name
joined by a slash, like `business/offer` (the section `business`, the name `offer`), and holds a
paragraph of text. Capitals make no difference: `Business/Offer` is the same row.

```
brain                                   list every row
brain set business/company <text>       add a row, or replace it
brain rm business/old_offer             remove a row
```

A `brain set` without the slash, or without text after the name, saves nothing and says how to write
it. A row you replace is not kept anywhere, so send `brain` to see the current text before you
change it.

When the agent learns a lasting fact in conversation, it proposes a brain change as a card with
Apply and Dismiss. When only the team can answer something, it asks with answer buttons.
[PLAYBOOK.md](PLAYBOOK.md) lists the rows to write on day one.

## Decisions and hypotheses

The brain says what the business is. Decisions and hypotheses say what the team chose and what it
is betting on, each with its reason, so the agent (and anyone who joins later) knows why things are
the way they are. The agent, the optimizer and the daily report read the active decisions and the
open hypotheses every time, so a decision made in a thread last month still counts today.

```
decisions                                               the active decisions (decisions all: every one)
decision budget: no budget changes during the spring launch because we need one clean week to compare
decision targeting: commuters and students because students matched in week two (replaces 3)
decision 3 reversed because the launch is over
hypotheses                                              the open hypotheses (hypotheses all: every one)
hypothesis Theft angle brings cheaper test rides [audience=commuters, angle=theft]
hypothesis test Short videos beat stills for test rides [format=video]
hypothesis 7 confirmed because $92 a test ride against $150, 14 days
```

- **A decision needs its reason**, after `because`. Without it nothing is saved. The word before
  the colon is an optional topic (one or two words, like `budget` or `targeting`).
- **`(replaces 3)`** at the end marks decision 3 as replaced by the new one. `(brain business/offer)`
  notes the brain row the decision changed. Both can go together: `(replaces 3, brain business/offer)`.
- **Reversing** keeps the decision in `decisions all`, marked reversed, with the reason.
- **Labels** in square brackets name the segment a hypothesis is about, in your team's words:
  an audience, an angle, a format, a market. Any short `name=value` pairs work.
- **`hypothesis test ...`** records a test that starts today. Grading it closes it.
- **A grade** is `confirmed` or `refuted`, with the numbers after `because`. A graded hypothesis can
  be graded again when the numbers change; the earlier verdict stays in the timeline.
- Every one is saved with who wrote it, and the reply names them.

**From the conversation.** When an operator states a decision in a thread, or says what they believe
works, the agent puts it on a card with Record and Dismiss. Nothing is saved until an operator taps
Record, and the operator who taps is kept as the one who decided. The same goes for a grade: when
the numbers settle an open hypothesis, the agent proposes the verdict with the numbers. A decision
without a reason never reaches a card; the agent asks for the why first.

When the evidence argues against an active decision, the agent says so and names it by its number.
Changing it stays with the team.

**Your own results.** If your team keeps its own results in the database (for example what happened
after the click: qualified leads, booked calls, sales by angle), name those tables or views in the
brain row `context/result_views` and the agent reads them every turn, next to Meta's numbers, and
says which number comes from where. See [SETTINGS.md](SETTINGS.md#brain-rows-the-code-reads).
`status` and `npm run check` say when a named view is not set up.

## Commands

Mention the agent (or DM it) with one of these. They answer at once, without the model:

| Command | What |
|---|---|
| `help` | this list |
| `report` | yesterday's report now |
| `scoreboard`, `scoreboard 14` | the 15 ads that spent most in the last 7 days (or 14), best first, ranked against the target |
| `pending` | every card waiting, posted again |
| `status` | what counts as a result, the target and where it comes from, the ceiling, the currency, the operators, changed thresholds, how many decisions and hypotheses are open and whether each result view reads, job health, open issues |
| `optimize` | look for moves now (the lighter run, not the full morning one): it posts cards in today's desk thread, and pauses ads on its own only if the ladder allows it |
| `ladder` | which kinds of moves wait for a person and which happen on their own |
| `ladder set pause auto` | let clear losing ads pause on their own |
| `ladder set pause ask` | send pauses back to waiting for a person |
| `undo 14` | reverse the move with card number 14 (orders have no number: give the opposite order). An undo of a budget move is refused if the budget changed since that move. |
| `freeze <why>`, `unfreeze` | stop the agent proposing moves (cards already posted still work), or let it start again |
| `brain`, `brain set ...`, `brain rm ...` | see "The brain" above |
| `decisions`, `decision ... because ...` | the active decisions, or record one (see "Decisions and hypotheses" above) |
| `hypotheses`, `hypothesis ...` | the open hypotheses, record one, or grade one |
| `thresholds` | every threshold and its value now |
| `threshold pause.zeroResultSpend 4` | change one threshold (`default` instead of the number puts it back) |
| `scan comments` | run the comment sweep now |
| `journal` | changes Meta never answered (see "When Meta never answered a change" below) |
| `journal clear 7` | clear number 7, after you checked it |

**Who can use what.** Anyone can read: `help`, `report`, `scoreboard`, `pending`, `status`,
`ladder`, `brain`, `thresholds`, `journal`, `decisions` and `hypotheses`. `report` only posts
numbers, so anyone can ask for one. Everything else needs an operator, because it can change the
account or the agent: `optimize` can pause ads on its own when pauses are set to automatic,
`scan comments` hides comments on your Page, and the rest change the brain, the record, the ladder,
the thresholds or the freeze.
Anyone else who tries gets "That needs an operator", with how to become one.

**Where the numbers come from:** a card's number is the `#14` at the bottom of the card; an
automatic move's message ends with its undo command, number included; a journal number comes from
`journal`; a comment id is at the end of its line in the comment sweep; a post id (for
`moderation/extra_posts`, see [PLAYBOOK.md](PLAYBOOK.md)) comes from asking "list our recent Page
posts with their ids", or "what is the post id of the ad Spring video v2?"

## The ladder

Every kind of move starts as waiting for a person. `ladder set pause auto` lets clear losing ads
pause on their own; each one is posted in the desk thread with its undo command. Undoing an
automatic pause puts pauses back to waiting. Raising a budget, trimming a budget and turning an ad
back on always wait for a person.

## When it stops itself

The agent stops proposing moves, and says why in the channel, when:

- the numbers look broken: far more results than clicks, impressions with no spend, or no results
  at all on spend of several times the target (usually broken tracking; tell whoever set up the
  agent);
- it could not read fresh numbers from Meta, or has none for the days it judges (a gap in the
  data), or one of these checks could not run;
- something looks wrong: a day's spend far past the budget, cost per result jumping to over 3
  times its usual level, or a live campaign suddenly not delivering;
- an operator sent `freeze`.

It says once when it trusts the numbers again. When it cannot read Meta at all, it says so as an
issue in the channel after a few failed tries.

## When Meta never answered a change

If Meta does not answer a change clearly (a timeout, a dropped connection, a server error), the
agent cannot know whether it happened, so it never sends it again on its own. It holds every later
change until that one is settled, and the card or message behind it says the outcome is unknown. It tries to settle it on its
own the next time it starts. Otherwise `journal` lists it, with what it changed. To settle one:

1. Open the ad, ad set or campaign it names in Ads Manager.
2. Look at what the change was about: the status (on or paused) or the daily budget.
3. If the change is there, or you make it by hand now, send `journal clear <number>`.

## The Home tab

Click the agent's name, then Home: the last 7 days, the target and ceiling, whether it is frozen,
the cards waiting (with Approve and Reject for operators), open issues, the ladder and how each
scheduled job is doing.

## Weekly review

Once a week: how many cards were approved, rejected or automatic, the lessons it now follows (from
the last 30 days of "why" notes), what each move from the last 3 weeks did (results a day, cost per
result and spend a day, before against after), and the ad scoreboard.

## Who sets the numbers

- **The target:** whoever set up the agent sets it at install, and an operator can change it any
  time in Slack: `brain set policy/target 45`. The one in the brain wins; `status` says which is in
  use. `brain rm policy/target` goes back to the target in the settings.
- **The ceiling:** only whoever set up the agent, in the settings, followed by a restart. Nobody can
  raise it from Slack, on purpose: it is the one number that caps every budget the agent touches.
- **Who the operators are and what counts as a result:** whoever set up the agent, in the settings.

## For whoever set it up

Who the operators are, the target, the ceiling and what counts as a result are settings. See
[SETTINGS.md](SETTINGS.md). Adding or removing an operator is a settings change and a restart.
`OPTIMIZER_ENABLED=false` turns the optimizer off: `status` then says so, and `optimize` refuses.
