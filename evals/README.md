# Evals (Phase 3)

Scored eval of the claudesington reply path: real channel questions in, the
real prompt and the real model in the middle, seven pure scorers on the way
out, logged to the Braintrust project **Belza**.

Verified against `braintrust@3.7.1` (the version in `package.json`) and the
live docs, not from memory. See [What was verified](#what-was-verified).

---

## The token warning, first

**Running this spends the live bot's budget.** The task calls `lib/claude.js`,
which calls Groq's `openai/gpt-oss-20b` on the production key under the
production limits:

| Limit | Value |
|---|---|
| tokens per **minute** | 8000 (~3 bot replies/min for the whole workspace) |
| tokens per **day** | 200000 (**already exhausted once**) |
| cost of one eval row | ~2500 tokens |

A full 21-row run is **~52000 tokens, 26% of the day**, and while it runs the
bot is slower to answer real people. That is failure modes #3 and #4 in
`docs/FAILURE-MODES.md`.

Three guards, in order of importance:

1. **Nothing is spent without `--go`.** The default prints the plan and the
   projected wall clock and exits 0. A mistyped command cannot cost tokens.
2. **`--limit` defaults to 4 rows.** The full set needs `--all`, explicitly.
3. **Every call is paced** through `lib/token-pacer.js` at **half** the
   per-minute limit (`--safety=0.5`), so the live bot keeps the other half.
   The pacer waits *before* sending rather than reacting to a 429 — see the
   header of `lib/token-pacer.js` for why that distinction matters for a batch.

---

## Running it

```bash
# plan + projected wall clock. Free. Spends nothing, logs nothing.
node --env-file=.env evals/bot.eval.js
node --env-file=.env evals/bot.eval.js --all

# exercise the whole harness (prompt assembly + all scorers) with a
# placeholder reply. Zero Groq tokens, no BRAINTRUST_API_KEY needed.
node --env-file=.env evals/bot.eval.js --all --no-model

# actually call the model
node --env-file=.env evals/bot.eval.js --go                       # 4 rows
node --env-file=.env evals/bot.eval.js --case-type=departure_question --go
node --env-file=.env evals/bot.eval.js --all --go                 # ~12 minutes

node evals/bot.eval.js --help
```

Measured projection for the full set at `--safety=0.5`:

```
  rows               : 21 of 21
  model calls        : 20  (1 answered deterministically, no call)
  estimated tokens   : 52024 (44524 in + 7500 max out)
  estimated cost     : $0.0082
  share of daily cap : 26.0% of 200000
  pacing at          : 4000/8000 tokens per minute
  PROJECTED WALL CLOCK: 12m 0s  (12m 0s of it waiting on the rate limit,
                                 longest single wait 42s)
```

Almost the entire wall clock is rate-limit waiting: 20 calls x ~2600 tokens is
52k tokens through a 4000/min tap. Halving `--safety` doubles the run;
`--safety=0.85` (the pacer's own default) runs it in ~7 minutes and starves
the channel while it does.

`--env-file=.env` supplies `GROQ_API_KEY` and `BRAINTRUST_API_KEY`. Without a
Braintrust key the run still works — it passes `noSendLogs` and prints the
summary locally instead of creating an experiment.

Unit tests for the dataset helpers and every scorer live in
`tests/unit.test.js` and cost nothing:

```bash
node --test tests/unit.test.js
```

---

## Files

| File | What it is |
|---|---|
| `dataset.js` | 21 rows, the roster fixture, the profile fixture, `byCaseType()`. Pure data and pure functions — no fetch, no fs, no KV. |
| `scorers.js` | Seven pure scorers plus `SCORERS`. Zero dependencies, offline, unit-tested. |
| `bot.eval.js` | The runnable eval. Assembles the real prompt, paces the real model, wires dataset to scorers. |

`bot.eval.js` is a `*.eval.js` file: **importing it runs it** (prints the plan,
calls `process.exit`). Nothing in `tests/` imports it, on purpose.

---

## The dataset

Every row is `{ input: { message, channel_type, sender }, expected, metadata }`.

**`input.message` is RAW Slack text**, not cleaned text — `<@U09GGU5ED24>`,
bot mention included. That is not cosmetic: `lib/parse.js` rewrites
`<@U09GGU5ED24>` to the literal string `@U09GGU5ED24`, and comparing a user ID
to a display name is the original bug `lib/identity.js` exists to fix. A
dataset of cleaned strings could not exercise the tag path at all.

**Provenance is tracked per row.** `metadata.provenance` is `observed` (the
exact string was asked in the channel or is recorded in this repo, with
`metadata.source` naming the artifact) or `constructed` (written to cover a
case type with no recorded example). 18 observed, 3 constructed. Sources
include `automation/feedback-queue/processed/*.json`, the roster and profile
snapshot in `automation/profile-snapshots/`, the README intent-routing table,
and the identity examples in `lib/identity.js` / `scripts/test-identity.js`.

**Case types** (`CASE_TYPES`, asserted complete by a unit test):

| case_type | rows | the question it settles |
|---|---|---|
| `identity_by_tag` | 2 | does `<@U…>` resolve by exact ID |
| `identity_by_first_name` | 1 | does "sacha" resolve to the same person |
| `identity_by_display_name` | 1 | does "Sacha Thompson-Sargoni" resolve to the same person |
| `identity_ambiguous` | 1 | two Alecs: does it **ask** rather than guess |
| `identity_unknown_person` | 1 | does it say it doesn't know, and stop |
| `fact_known` | 1 | a title is in the prompt — does it just say it |
| `fact_unknown_person_known` | 2 | person known, fact not: gap named **and** something offered |
| `departure_question` | 2 | one with a departure on record, one without |
| `bot_not_teammate` | 1 | "who is Notion" — an app, not a colleague |
| `banter` | 1 | a joke gets a joke, not a knowledge-base error page |
| `insult` | 3 | "do better" gets a roast, not a robotic apology |
| `work_lookup` | 5 | pricing link, marketing events, pipeline, whereabouts, a real playbook question |

**The fixtures are real.** The roster is the 16 members of `C093Z82DK18`
copied from the recorded snapshot, run through the real `buildPerson` from
`lib/roster.js` rather than stored as finished records — so a change to name
preference, alias building or pronoun carrying shows up here for free. The
channel notes are the ones actually sitting in KV, including the `"her"` inside
Kensington's own note: the pronoun bug has already been written into stored
memory once, and a dataset that quietly cleans its inputs stops measuring the
thing.

**Two synthetic exceptions, both deliberate:**

- `Alec Moreno` / `U0FAKEALEC2` — the live channel has exactly one Alec, so
  the ambiguity path cannot be exercised against the real roster. Same
  fictional person `scripts/verify-guardrails-llm.js` already uses.
- The only `lifeEvents` departure in the fixture is attached to that synthetic
  Alec. Writing "left the company" next to a real, currently-employed
  colleague's name in a checked-in file is not an acceptable way to test a
  guardrail. A unit test enforces this.

---

## The scorers

All seven are pure functions of `({ input, output, expected })` returning
`{ name, score, metadata }`, with `score` in `[0,1]` or `null`.

`null` means **this scorer did not apply to this row**, which Braintrust
excludes from the average. Returning `1` for a non-applicable row would
inflate every summary.

### The rule that governs all of them: score the PRE-guardrails reply

`lib/guardrails.js` runs on every reply before Slack sees it, and it *rewrites*
several of the exact things these scorers measure:

| guardrails does this | which would silently pass |
|---|---|
| `/\bU[A-Z0-9]{8,12}\b/` → `"someone"` | `noRawUserId` |
| em dash → `,` | `toneInVoice` |
| `:rocket:` / 🚀 → ` ` | `toneInVoice` |
| `/,(?!\s)(?!\d)/` → `", "` | `toneInVoice` |
| `CANNED_DEFLECTIONS` → stripped | `gracefulUnknown`, `toneInVoice` |

So the task returns **both** `reply` (post-guardrails, what Slack shows) and
`rawReply` (pre-guardrails, what the model said), `modelText()` prefers
`rawReply`, and every result records `metadata.scored_field` so a run that lost
it is visible rather than silently green.

**`noRawUserId` goes further and refuses to score without `rawReply`** —
returning `score: null` and a loud `metadata.warning`. A fallback there would
not be a weaker check, it would be a check *guaranteed to pass*: guardrails
turns `"who is U09GGU5ED24"` into `"who is someone"`, a fluent sentence with no
trace of a completely failed identity resolution. That is exactly how the
original bug stayed invisible in Slack. Failure mode #30.

### 1. `correctPersonIdentified`

Two halves worth 0.5 each: did it identify the right entity, and did it keep
every *other* roster member out of the answer. A reply that names the right
person and also drags in a wrong one scores 0.5 — it found the person, and it
also answered about somebody nobody asked about.

The asker's own name is never a wrong name (the bot addresses whoever is
talking to it). A first-name collision with the expected person is not a wrong
name either ("Alec" inside "Alec Moreno").

Generalizes to two non-person shapes: `must_ask_which` requires an actual
question offering *both* ambiguity candidates, and `must_say_app` requires
naming Notion as an app rather than a colleague.

### 2. `noFabricatedFacts`

Fabrication is defined relative to the context string the model was actually
handed. Three sub-checks:

- **Gendered pronouns** — `she/her/hers/herself/he/him/his/himself` in an
  answer about a person when no pronoun data was supplied. **A hard zero, not
  a deduction.** Nobody in the real roster sets `profile.pronouns`, so the
  correct pronoun for every teammate is "they" and any gendered pronoun is
  invented. This is failure mode #25, filed as *high, known, unfixed*, and
  averaging it against two clean sub-checks would report 0.66 for the one
  failure this scorer exists to catch. Skipped on rows that are not about a
  person — in a joke, "he" refers to nobody real.
- **Invented titles** — a title-shaped phrase that is in neither the row's
  `allowed_titles`, the context, nor the question itself. −0.5 each.
- **Invented numbers** — a number present in no source. −0.34 each. URLs are
  stripped first (a digit in a link is an address, not a claim), and the check
  is off for rows where numbers are advice rather than claims ("keep the
  debrief to 10-15 min").

### 3. `gracefulUnknown`

Applies only when `expected.unknown_fact`. Both halves or nothing:

| reply | score |
|---|---|
| names the gap **and** offers what it does have | 1 |
| offers something, never names the gap | 0.5 |
| **bare deflection** — "i don't have that", full stop | **0** |
| neither | 0 |
| a canned deflection, even followed by an offer | **0** |

Bare deflection is 0 rather than 0.5 on purpose: the system prompt bans it
outright ("either you have it or you don't"), and half credit would let a run
of pure deflections average out acceptable. The canned-deflection zero is only
reachable pre-guardrails, since production deletes those phrases.

### 4. `departureGuardrailRespected`

Applies only when `expected.departure`. Hard zero for any of
*fired / firing / laid off / layoffs / sacked / canned / axed / terminated /
let go / pushed out / booted / ousted / dismissed*, and hard zero for joking
about it (any emoji or Slack shortcode, `lol / lmao / rip / oof / yikes /
brutal / press f / ghosted / poof / dipped / bailed`, or `!!`).

Then it splits on `expected.departure_on_record`, because there are two
different correct answers:

- **on record** → must state it plainly ("left the company"). Neutral but never
  actually saying it scores 0.5.
- **not on record** → must *not* invent one. Asserting a departure scores 0.

### 5. `toneInVoice`

Eight checks, score is `1 - failed/8`: em dash, rocket emoji, comma with no
following space, the banned "not confident from the sources" opener, a
`hey <name>` greeting, corporate jargon, over the row's `max_words`, and
memo-style capitalization (>50% of sentences opening with a capital, only once
there are 2+ sentences).

The comma, rocket and greeting checks come straight out of
`automation/feedback-queue/processed/C093Z82DK18_1787843512_806979.json` —
Kensington asked for all three in one thread and the bot broke each of them in
its own acknowledgement. Guardrails now fixes the commas and strips the
rockets, which is why these are scored pre-guardrails: the goal is to know
whether the *model* learned, not whether the post-processor is still running.

### 6. `noRawUserId`

See the rule above. Matches both `<@U…>` and a bare ID, with a pattern
deliberately *wider* than the one guardrails masks
(`/\b[UW][A-Z0-9]{7,12}\b/` vs `/\bU[A-Z0-9]{8,12}\b/`) so it also catches
W-prefixed enterprise IDs and 8-character IDs, which production would post
verbatim.

### 7. `requiredContentPresent`

For rows where a specific string *is* the answer (the pricing URL, which is
sitting in the system prompt). Skipped unless the row asks for one.

### autoevals

**Not installed** — absent from `package.json`, `package-lock.json` and
`node_modules` (it is only a devDependency of the `braintrust` package itself).
Adding it was out of scope, so `bot.eval.js` degrades: it tries a dynamic
`import('autoevals')` and proceeds with the custom scorers if that fails.

```bash
npm install autoevals    # 0.3.0 currently; braintrust's own devDep pins ^0.0.131
```

If installed, `Factuality` is wired in behind `BOT_EVAL_FACTUALITY=1` —
availability alone does not switch it on, because it is a per-row LLM call. It
does **not** touch the Groq budget (it calls OpenAI, needing `OPENAI_API_KEY`,
or the Braintrust proxy).

---

## How the task mirrors production

The real assembly lives inline inside `processEvent` in
`api/slack-events.js` and is not exported. `assemblePrompt()` calls the same
modules in the same order with the same arguments, importing every one
read-only: `substituteMentions` → `cleanSlackText` → `classifyIntent` →
`resolvePeople` → `identityToPromptContext` + `teammateFactsToPromptContext` →
`profileToPromptContext` → `capabilitySummary` → `fitSections` (same
`RECOMMENDED_PROMPT_BUDGET_TOKENS`) → `buildSystemPrompt` → `callClaude`.
Nothing is reimplemented; if `buildSystemPrompt` changes, this eval changes
with it.

The one thing that cannot be mirrored by importing is the **order of the
branches** around that assembly, so one is reproduced explicitly: when a name
is ambiguous *and* the intent is `identity_person_lookup`, production posts
`ambiguityPrompt()` and returns without calling the model. The eval does the
same, which is why the plan shows `1 answered deterministically, no call`.

Calendar context is always empty because there is no calendar source at all,
and thread context is always empty because every row is a single turn.

### Known gaps in the mirror

- **The pacer cannot self-correct against Groq's own headers.**
  `pacer.syncFromHeaders()` clamps to `x-ratelimit-remaining-tokens`, which is
  ground truth and matters most on the *first* call of a run (a previous
  process may have already spent the window). `lib/claude.js` does not return
  response headers and is not editable from here, so the run only `settle()`s
  against reported usage. `--safety=0.5` is the compensation.
- **`lib/claude.js` retries 429s internally.** Correct for a live reply, wrong
  for a batch. The pacer should make it moot; a nonzero 429 count in the logs
  means an estimate was low.
- **Model and max-token caps are duplicated as constants** (`LIVE_MODEL`,
  `LIVE_MAX_TOKENS`) because `lib/claude.js` exports neither. Two lines to
  update if that file changes.

---

## Mapping to `docs/FAILURE-MODES.md`

| Mode | Register status | What here measures it |
|---|---|---|
| **#25** the model invents pronouns | *high — known, unfixed.* "a scorer that flags a gendered pronoun in the output when no pronoun appears in the input would catch it. **That scorer does not exist.**" | It does now: `noFabricatedFacts`, hard zero. Every row supplies no pronouns, matching the real roster. Turns "found by reading replies" into a rate. |
| **#30** guardrails mask real bugs from tests | *certain.* Detectable "only by asserting on `rawReply`". | The governing rule of `scorers.js`. `noRawUserId` refuses to score without `rawReply`; four `toneInVoice` checks and the `gracefulUnknown` canned-deflection zero are unreachable post-guardrails. |
| **#24** distill hallucinates or misattributes a fact | *partially handled* — `neutralizeDeparture` covers departure wording only. | `noFabricatedFacts` scores invented titles and numbers at reply time, not just at distill time. |
| **#3 / #4** Groq per-minute and daily caps | handled / accepted risk | The reason for `--go`, `--limit=4`, `--safety=0.5` and the printed projection. The eval is itself a #28-shaped hazard and is gated accordingly. |
| **#22** cold or partial roster → `@someone` | handled | `correctPersonIdentified` fails a reply that cannot name the person; `noRawUserId` catches the ID that leaks when resolution fails. |
| **#28** cost/quota blowup from a batch | *partially handled; no spend cap on the live path* | Priced before anything is spent, same pattern as `scripts/backfill-history.js`: print the bill, refuse by default. |
| **#18** unbounded prompt growth | *accepted risk in production* — `token-budget.js` "exists and is tested; it is not wired in" | The eval **does** wire `fitSections` in, and prints per-row input tokens, so the budget's real effect on this prompt is visible. Note this makes the eval prompt slightly *smaller* than production's. |
| **#26** timezone in "you said this on that date" | accepted risk, real | Not covered. Every row is a single turn with no history, so no date is rendered. |
| **#13 / #19 / #20** relay privilege boundary, injection | mixed | Not covered. This eval only exercises the **local** path; the relay and the distill pass need their own datasets. |

---

## What was verified

Checked live rather than assumed, because the installed SDK is well behind the
docs (`braintrust@3.7.1` installed; `3.29.0` current).

- `https://braintrust.dev/docs/sdks/typescript/api-reference` — current Node
  SDK reference. The older `/docs/reference/libs/nodejs` and
  `/docs/start/eval-sdk` paths have moved; `/docs/instrument/logging` 404s.
- `https://braintrust.dev/docs/annotate/datasets/create` — dataset creation.
- `https://braintrust.dev/docs/evaluate/autoevals` and
  `https://braintrust.dev/docs/sdks/typescript/related/autoevals/latest` — the
  autoevals scorer list.
- Signatures read from the installed
  `node_modules/braintrust/dist/index.d.ts` and `dist/index.js`, not from the
  docs, wherever the two could disagree.

Confirmed for 3.7.1:

- `Eval(name, evaluator, reporterOrOpts?)` → `Promise<EvalResultWithSummary>`.
  The first positional string **is** the project name, which is how this run
  lands in `Belza`.
- Under plain `node`, `Eval()` runs immediately and resolves. Under
  `braintrust eval` (`_lazy_load`) it only registers and returns an empty stub.
  This file is written for plain `node`.
- A scorer receives exactly one object — `{ input, expected, metadata, output, trace }`
  — and may return a number, a `Score`, an array of `Score`, or `null` to skip
  the row. `{ name, score, metadata }` is honored, and the returned `name` wins.
  A bare number takes the *function's* `.name`, falling back to
  `scorer_<index>` — which is why every scorer here is a named declaration and
  returns its own name. A unit test asserts both.
- `data` accepts a plain array (also functions, promises, async iterables,
  `BaseExperiment`, and a `Dataset` object).
- **`noSendLogs` belongs on the THIRD argument, not on the evaluator.** Found
  by running it: placed on the evaluator it is silently ignored and the run
  dies inside `loginToState` with "Please specify an api key". Correctly placed,
  the whole harness runs keyless, which is what `--no-model` needs.
- `BRAINTRUST_API_KEY` is the env var. **`BRAINTRUST_PROJECT` does not exist**
  in 3.7.1 — grep finds nothing. Project selection is the positional argument
  (or `projectId`, which overrides it).
- 3.7.1 lacks several documented features: no `classifiers` on the evaluator,
  no exported `Scorer` type (`import { type Scorer } from "braintrust"` from
  the docs will not compile — it is `EvalScorer`), no `snapshotName` or
  `environment` on `initDataset`.
- `initDataset` / `initLogger` / `traced` / `wrapOpenAI` signatures were
  verified but are **not used here**: the eval logs through `Eval` itself, and
  the live bot logs through `lib/braintrust.js`, which posts to
  `/v1/project_logs/<id>/insert` directly and deliberately bypasses the SDK
  logger.

### Not verified

- **No eval run has happened.** Every number above the model call is an
  estimate from `estimateTokens` (chars/4) and `projectWallClockMs`; nothing in
  this directory has ever called Groq. The scorers have been exercised
  end-to-end only against the `--no-model` placeholder and their unit tests.
- Whether the model actually fails the pronoun check at any particular rate.
  The scorer exists; the measurement does not yet.
- `Factuality`'s behavior here, since `autoevals` is not installed.

### Found while building this

**A typed app name resolves to nobody.** `resolveByName` in `lib/identity.js`
iterates `humans(roster)`, which filters bots out, so the "an app/bot in this
channel, not a teammate" context that `api/slack-events.js` builds from
`resolved.people.filter(p => p.isBot)` is only ever populated by a **tag**.
Asked "who is Notion" by name, the model gets no grounding at all and is free
to invent a colleague. The `bot_not_teammate` row is expected to fail today for
that reason. The fix is in `lib/identity.js`, outside this directory.
