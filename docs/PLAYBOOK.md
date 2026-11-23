# Playbook: the first two weeks

This page is for the team that works with the agent. The agent starts out knowing the ad account and
nothing about your business. Everything else it knows comes from the **brain**: short rows of text
your team writes. A thin brain gives generic answers; a good one gives answers that sound like
someone who knows the company.

## Day one: the brain

An operator writes these rows by mentioning the agent in the channel, for example
`@Ads Command Center brain set business/company ...`. Before Slack is connected, whoever sets up the
agent can write the same rows from the terminal (see [INSTALL.md](INSTALL.md), step 7).

Write each row in your own words. The examples below are for one made up business, Northfield
Bikes, to show the kind of detail that helps.

**business/company**: who you are and what you sell.

```
brain set business/company Northfield Bikes sells city e-bikes online and from two showrooms, in Rotterdam and Utrecht. Most orders are one bike plus accessories.
```

**business/offer**: the one action the ads drive, and what counts as a result.

```
brain set business/offer The ads drive one action: book a free test ride at a showroom. A booked test ride is the result we pay for. Online purchases count too, but we do not optimize for them.
```

**business/buyer**: who buys, and what they care about.

```
brain set business/buyer Commuters, 25 to 50, living in cities, replacing a car or public transport. They care about range, theft and servicing.
```

**business/funnel**: what happens after the result, if anything.

```
brain set business/funnel Test ride booked, test ride taken, bike bought. About two thirds of booked rides are taken, and about a third of those riders buy within a month.
```

**business/voice**: how you talk.

```
brain set business/voice Plain and practical. No hype, no exclamation marks. We say e-bike, never electric bicycle.
```

**business/compliance**: what an ad or a reply must never say.

```
brain set business/compliance Never promise a delivery date. Never quote a range we have not tested ourselves. Never mention a customer by name.
```

**moderation/scope**: anything special about which comments to remove or keep.

```
brain set moderation/scope Remove comments that share someone's personal details. Keep complaints about price up and answer them.
```

The target (what one result is worth paying for), if you prefer setting it here over the settings,
as a plain number in the ad account's currency:

```
brain set policy/target 40
```

Write it without a thousands dot: `1250` or `1,250`, not `1.250` (that one could mean 1.25, so
it is refused). `brain rm policy/target` goes back to the target in the settings. A row you replace
is not kept, so send `brain` to see the current text before you change it.

Rows to add as you go:

| Row | What |
|---|---|
| `business/seasonality` | Busy and quiet months, holidays that matter. |
| `business/competitors` | Who you lose customers to, and why. |
| `business/campaigns` | What each campaign is for, especially ones that should be left alone (a brand campaign, a test). |
| `business/creative_rules` | What the team never wants in an ad. |
| `moderation/extra_posts` | Post ids to sweep beyond live ads and the latest posts, separated by commas. To find a post's id, ask the agent "list our recent Page posts with their ids". |
| `context/result_views` | Your own results tables or views in the agent's database (what happened after the click), read every turn. See [SETTINGS.md](SETTINGS.md#result-views). |

Record the decisions you already made, with their reasons, and what you believe works, so the
agent starts from them instead of proposing them again:

```
decision budget: no budget changes during the spring launch because we need one clean week to compare
hypothesis Theft angle brings cheaper test rides [audience=commuters, angle=theft]
```

[USING.md](USING.md#decisions-and-hypotheses) has the rest.

Check what it knows with `brain`. Ask it "what do you know about our business?" and correct what is
wrong; it proposes the fix as a card.

## Days 1 to 3: watch

- Every move waits for a person. Nothing changes without a tap: a card's Approve, or Confirm on the
  card an order posts.
- Read the morning cards. Approve the ones you agree with. Reject the rest, and write why: that is how
  it learns your account.
- Ask questions. Where an answer is generic, the brain is missing a row.
- If the number of results looks wrong against Ads Manager, send `status` and tell whoever set up
  the agent: the result may be counted as the wrong action type, which they can change in the
  settings (`npm run check` lists what the account reported).

## Days 4 to 7: tune

- If it pauses ads too early or too late for you, an operator changes a threshold. For example
  `threshold pause.zeroResultSpend 4` waits until an ad has spent 4 times the target with no result
  before calling it a loser. `thresholds` lists every one with its value, and "The thresholds in
  plain words" below says what each one does.
- If the target was a guess, set the real one: `brain set policy/target 45`.
- Check the ceiling (the most the account may spend per day) is where you want it: `status` shows
  it. It is the most important number you set; whoever set up the agent changes it in the settings.

## Week two: decide on automatic pauses

If its pause cards have been right for a week, `ladder set pause auto` lets clear losers stop on
their own. Every automatic pause is posted with its undo command, and one undo sends pauses back to
waiting for a person. A pause that would leave too few ads running in its ad set, or that repeats a
move someone undid, still comes as a card marked `needs a person`. Budget moves and turning an ad
back on always stay with people.

## Every week after

Read the weekly review: the lessons it now follows come from your "why" notes. If a lesson is wrong,
reject the next card that follows it and say why.

Go through `hypotheses` and grade the ones the numbers settled, with the numbers:
`hypothesis 7 confirmed because $92 a test ride against $150, 14 days`. When the team changes its
mind, record the new decision with `(replaces 3)` so the old one stops counting.

## The thresholds in plain words

Each threshold is one number the agent judges by. Most are a multiple of the target: change the
target and they move with it. The examples use a target of 40. An operator changes one with
`threshold <name> <number>`, and puts it back with `threshold <name> default`.

**When an ad is paused** (each rule proposes a pause card on its own):

| Threshold | Default | What it does, with an example |
|---|---|---|
| `pause.zeroResultSpend` | 3 | An ad that spent this many times the target with no result is a loser. At 3: 120 spent, nothing back. |
| `pause.overTargetMult` | 3 | An ad whose results cost this many times the target is a loser, once it has `pause.minDays` days of numbers. At 3: results at 120 each. |
| `pause.minDays` | 3 | How many days of numbers the two rules on cost per result need. At 3: an ad that started yesterday is never paused for its cost. |
| `pause.heavyOverMult` | 1.5 | A big spender whose results cost this many times the target is a loser too, even if it is not as far over. At 1.5: results at 60 each... |
| `pause.heavySpendMult` | 10 | ...once it has spent this many times the target. At 10: after 400 spent. |
| `pause.keepMinActive` | 1 | A pause must leave at least this many ads running in the ad set. At 1: the last ad running in an ad set is never paused on its own; that card waits for a person even when pauses are automatic. |

**When a budget is raised** (it must be a proven winner, below, and all four must hold; the ceiling always applies):

| Threshold | Default | What it does, with an example |
|---|---|---|
| `scale.stepPct` | 20 | The most one raise adds, in percent. At 20: 100 a day goes to 120 at most. |
| `scale.minHours` | 48 | How long after the last budget change the next raise may come. At 48: a budget changed Monday morning can be raised again Wednesday morning. |
| `scale.minResults` | 5 | How many results the ad set or campaign needs in the window before a raise. At 5: four booked test rides are not enough yet. |
| `scale.accountCapMult` | 1.3 | Raises keep the account's total daily budget under this many times what it was a week ago. At 1.3: a total of 1,000 a day a week ago stays under 1,300. |

**When a budget is trimmed:**

| Threshold | Default | What it does, with an example |
|---|---|---|
| `descale.stepPct` | 20 | The most one trim takes off, in percent. At 20: 100 a day goes to 80 at least. |
| `descale.minHours` | 48 | How long after the last budget change the next trim may come. At 48: two days. |
| `descale.overTargetMult` | 1.25 | A trim comes only when results cost more than this many times the target. At 1.25: above 50 each. |

**When an ad counts as a proven winner** (a raise needs one):

| Threshold | Default | What it does, with an example |
|---|---|---|
| `winner.minProb` | 0.9 | How sure the agent must be that the ad's results cost less than the target. At 0.9: 9 chances in 10. |
| `winner.minDays` | 4 | How many days of numbers a winner needs. At 4: no ad is a winner in its first four days. |
| `winner.priorResults` | 3 | How cautious it is with a new ad. It starts by assuming every ad costs the target, and that guess weighs as much as this many results. At 3: an ad with 2 cheap results is still mostly the guess; one with 30 is judged on its own numbers. |

**Which numbers it reads, and how often it repeats itself:**

| Threshold | Default | What it does, with an example |
|---|---|---|
| `data.lagDays` | 2 | The most recent days it leaves out, because Meta keeps adding results to them for about two days. At 2: today and yesterday are not judged yet. |
| `data.windowDays` | 10 | How many days back it reads. At 10: the last ten days, minus the two above. |
| `suppression.rejectCooldownDays` | 7 | After a card is rejected, how long before it proposes the same move again, unless the numbers change clearly. At 7: a week. |
| `suppression.budgetRecommitDays` | 2 | After a budget move is applied, how long before it may propose another move on that budget. At 2: two days. |

[SETTINGS.md](SETTINGS.md) has the exact rules and the range each number may be set to.
