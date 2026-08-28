# Claudesington - Braintrust SDR Slack Bot

Slack bot for the Braintrust SDR team. Hangs out in team channels, answers questions, and remembers the people in them.

**Current reality check:** the Notion relay path is built but OFF (`RELAY_ENABLED=false`), so effectively every reply goes through the local Groq path. `NOTION_API_KEY` is currently invalid, so `lib/context.js` returns `[unavailable]`. Google Calendar is not configured.

Deployed on Vercel at `claudesington.vercel.app`.

## Architecture

```
User @mentions bot in Slack
        |
   slack-events.js (ACK immediately, process in background)
        |
   trigger.js -> parse.js -> intent.js
        |
   +---------+------------------+
   |                            |
   RELAY PATH                LOCAL PATH
   (help, calendar,          (banter, bot_meta,
    accounts, general)        braintrust resources)
   |                            |
   relay.js posts to         claude.js calls
   #kensington-belza         Claude Haiku
   |                            |
   Notion AI agent           responds directly
   responds in thread
   |
   bot polls, cleans,
   relays answer back
```

## Key Files

| File | Purpose |
|------|---------|
| `api/slack-events.js` | Main Slack webhook handler. ACKs, processes in background via waitUntil. |
| `api/cron/proactive-update.js` | Weekday EOD update (cron). |
| `lib/relay.js` | Core relay: post to relay channel, poll for Notion agent response, clean answer. |
| `lib/relay-config.js` | Relay config from env vars. |
| `lib/relay-store.js` | In-memory job state tracking for relay requests. |
| `lib/intent.js` | Deterministic intent classifier. Routes to relay vs local. |
| `lib/trigger.js` | Detects when bot should respond (direct mention, inferred questions). |
| `lib/parse.js` | Cleans Slack markup. Strips bot mention, preserves user/channel refs. |
| `lib/dedup.js` | In-memory event dedup. Prevents double-processing. |
| `lib/guardrails.js` | Post-processing: blocks forbidden phrases, strips em dashes. |
| `lib/slack.js` | Slack API: post messages, fetch threads/history, resolve users, format mrkdwn. |
| `lib/thread-context.js` | Builds conversation context from thread replies or channel history. |
| `lib/claude.js` | Calls Groq (`openai/gpt-oss-20b`) for local responses. Retries on 429 honoring Retry-After. Misnamed for history. |
| `lib/context.js` | Fetches Notion page content (currently limited, pages may be empty). |
| `lib/calendar.js` | Fetches Google Calendar events (needs env vars configured). |
| `lib/capabilities.js` | Runtime capability detection (what sources are connected). |
| `lib/roster.js` | Channel roster built from `conversations.members` + `users.info`. Lazy TTL-cached in KV. Source of truth for who exists. |
| `lib/identity.js` | Resolves `<@U…>` tags and typed names to people. Tags first, names second, ambiguity asked not guessed. |
| `lib/names.js` | Name normalization and alias building, shared by roster and resolver. |
| `lib/user-profiles.js` | KV-backed per-user profiles: history, personality, channel notes, life events, known-users index. |
| `lib/channel-log.js` | Channel-wide ambient message log (raw feed across everyone, mined by memory-distill). |
| `scripts/memory-distill.js` | Daily GitHub Actions job: extracts life events + banter notes from new ambient messages. |
| `scripts/backfill-history.js` | Local/Actions only: full Slack history + thread backfill, then a capped per-person distill pass. Never runs serverless. |
| `prompts/system.js` | System prompt for local Claude path. Casual SDR teammate tone. |
| `scripts/test-identity.js` | Phase 1 acceptance harness: every channel member by tag / first name / display name. Asserts pre-guardrails. |
| `tests/unit.test.js` | Unit tests covering all modules. |

## Intent Routing

| Intent | Relay? | Examples |
|--------|--------|----------|
| `banter` | No (local) | "lol", "lets go!", "good morning" |
| `bot_meta` | No (local) | "what can you do", "who are you" |
| `braintrust_resources` | No (local) | "case study for search", "pricing link" |
| `help_request` | Yes | "has anyone put together slides for X", "how do I set up a demo" |
| `calendar_whereabouts` | Yes | "where is ava", "what's on my calendar" |
| `account_or_pipeline` | Yes | "what's the pipeline", "who owns X account" |
| `identity_person_lookup` | Yes, unless the name matches a known SDR teammate we already have local memory on | "who is nick", "did alice leave" |
| `general_qna` | Yes | anything else |

## Ambient Memory (sdr-playersonly only)

Every message posted in the SDR friends channel (`SLACK_CHANNEL_ID`, default
`C093Z82DK18` / sdr-playersonly) gets remembered, not just messages directed
at the bot:
- `api/slack-events.js` logs the sender's own message into their per-user
  history (`lib/user-profiles.js`) and into a shared channel-wide log
  (`lib/channel-log.js`), even when no trigger fires and the bot never replies.
- A daily job (`scripts/memory-distill.js`, run via
  `.github/workflows/memory-distill.yml`) reads new channel-log entries,
  asks an LLM to pull out life events (left/promoted/new role) and banter-
  worthy notes per person, and merges them into that person's profile.
- When someone asks about a known teammate ("did alice leave?"), the bot
  answers locally from this memory instead of relaying to Notion.
- Departures are always phrased neutrally ("left the company") and are
  facts to state plainly if asked, never banter or roast material - see the
  guardrail in `prompts/system.js` and the extraction prompt in
  `scripts/memory-distill.js`.

## Relay Flow

1. Bot posts structured `[CLAUDESINGTON_RELAY_REQUEST]` to #kensington-belza (C0AQCKR9M2S)
2. Notion AI agent (Tranquil Ranger) watches channel, reads request, queries Notion/Calendar/Slack
3. Agent replies in the same thread with answer + `REQUEST_ID=<uuid>`
4. Bot polls thread every 3s for up to 55s
5. Bot matches response by REQUEST_ID, strips metadata, posts clean answer to original user
6. If timeout: posts fallback message

## Duplicate Prevention

Three layers:
1. **Event-type guard**: `message` events with bot @mention are skipped (app_mention handles them)
2. **Retry header**: Slack `x-slack-retry-num` header triggers immediate 200 with no processing
3. **In-memory dedup**: channel+ts+user key, 120s TTL

## Env Vars (Vercel Dashboard)

### Required
| Variable | Example |
|----------|---------|
| `SLACK_BOT_TOKEN` | `xoxb-...` |
| `SLACK_SIGNING_SECRET` | from Slack app settings |
| `SLACK_BOT_USER_ID` | `U0AR6BMV46B` |
| `ANTHROPIC_API_KEY` | `sk-ant-...` |

### Relay
| Variable | Default | Notes |
|----------|---------|-------|
| `RELAY_ENABLED` | `false` | Set `true` to activate relay |
| `RELAY_CHANNEL_ID` | `C0AQCKR9M2S` | #kensington-belza |
| `RELAY_TIMEOUT_MS` | `55000` | Max poll time. Hobby plan caps at ~55s. |
| `RELAY_POLL_INTERVAL_MS` | `3000` | How often to check for response |
| `RELAY_DEBUG_LOGGING` | `false` | Extra console logs |
| `RELAY_BOT_USER_IDS` | (empty) | Comma-separated allowlist of responder IDs |

### Optional
| Variable | Notes |
|----------|-------|
| `NOTION_API_KEY` | For direct Notion access (currently limited) |
| `GOOGLE_CALENDAR_API_KEY` | For direct calendar access |
| `GOOGLE_CALENDAR_IDS` | Comma-separated calendar IDs |
| `CRON_SECRET` | Auth for cron endpoint |
| `SLACK_CHANNEL_ID` | Default channel for cron posts |

## Notion AI Agent Setup

The relay depends on a Notion AI agent watching #kensington-belza:

1. **Triggers**: "Message posted in kensington-belza" must be ON
2. **Slack access**: #kensington-belza must be set to Read + Write (not None)
3. **Calendar**: Connect calendar account, enable "Read teammate's calendars"
4. **Notion**: "Pages shared with everyone in Braintrust" with Can View access
5. **Instructions**: See the finalized agent prompt (ask Kensington or check conversation history)

Key instruction rules for the agent:
- Respond within 30 seconds (Vercel timeout constraint)
- Reply IN THE THREAD, not as a top-level message
- Always end with `REQUEST_ID=<uuid>` from the relay request
- No "Answer:", "Confidence:", "Sources used:" labels
- Clean bullet-point formatting, not walls of text

## Running Tests

```bash
cd bot
node --test tests/unit.test.js
```

462 tests covering: dedup, parsing, intent, triggers, guardrails, slack formatting, system prompt, relay config, relay store, relay request/response, duplicate prevention, fallback behavior, identity claims, user profiles, ambient channel logging, memory distillation helpers, name normalization, roster shaping, identity resolution, and the history backfill (arg parsing, log dedupe, speaker resolution, the sensitive-material filter, departure neutralization, injection defense, chunking and the spend cap).

## Deploying

Push to `main`. Vercel auto-deploys from GitHub.

```bash
git add . && git commit -m "description" && git push origin main
```

After adding/changing env vars in Vercel dashboard, push an empty commit to trigger redeploy:
```bash
git commit --allow-empty -m "redeploy" && git push origin main
```

## Known Limitations

- **Vercel Hobby plan**: 60s max function duration. Relay timeout maxes at ~55s. If Notion agent is slow, upgrade to Pro ($20/month) for 300s max.
- **Notion content**: Direct Notion API access is limited (key points to personal workspace, not Braintrust). Relay to Notion agent is the workaround.
- **Google Calendar**: Not configured on the bot directly. Calendar questions go through the relay to the Notion agent instead.
- **No image support**: Bot cannot see images/attachments in Slack messages.
- **No full Slack search**: Bot reads thread/channel history but cannot search across all channels.
- **Private relay channel**: Bot skips relay when asked from #kensington-belza itself (loop prevention).

## Next Steps

- [ ] Upgrade to Vercel Pro for longer relay timeout
- [ ] Add image support (download from Slack, send to Claude Vision API)
- [ ] Build /refresh-bot-content skill to cache Notion snapshots
- [ ] Add scheduled auto-refresh of Notion content
- [ ] Get Braintrust Notion API key for direct access (long-term fix)
- [ ] Tune Notion agent speed (target <30s response time)

## History Backfill (Phase 4)

`scripts/backfill-history.js` is the one-off (rerunnable) job that seeds bot
memory from everything already said in the channel, as opposed to
`memory-distill` which only sees what arrived since the last run.

```bash
# see the plan and the bill, write nothing, spend nothing
node --env-file=.env scripts/backfill-history.js --dry-run

# fetch + store only, no LLM spend at all
node --env-file=.env scripts/backfill-history.js --no-distill

# the real thing, with an explicit budget
node --env-file=.env scripts/backfill-history.js --max-calls=20 --max-tokens=60000

node scripts/backfill-history.js --help
```

**Local / GitHub Actions only.** `assertNotServerless()` throws if `VERCEL`,
`AWS_LAMBDA_FUNCTION_NAME`, `LAMBDA_TASK_ROOT`, `NOW_REGION` or
`FUNCTIONS_WORKER_RUNTIME` is set. This paginates for minutes and sleeps on
`Retry-After`; a 60s function would be killed mid-write.

### What it fetches

`conversations.history` with cursor pagination over the whole channel, **plus
`conversations.replies` for every thread**. Thread replies are most of the
material worth remembering - a top-level message is usually just the setup, and
a history-only backfill misses the banter entirely.

`slackApi` is reused as-is so 429s are honored, but with
`totalWaitBudgetMs` raised to 120s (`--wait-budget-ms`). The 8s default exists
to keep a 60s Vercel function alive, which is not a constraint here.

### Resume and idempotency

Progress is checkpointed to `automation/backfill-history-state.json` after
**every** history page and after **every** thread, storing both the cursor and
the set of thread `ts` values already fetched. An interrupted run resumes
exactly where it stopped. A checkpoint belonging to a different channel is
ignored rather than silently resumed. People a previous run already distilled
are skipped so a resume does not re-spend the token budget (`--redistill` to
redo them).

Writes go through `appendChannelLogBulk` in `lib/channel-log.js`, which dedupes
by Slack `ts` (unique per channel). `appendChannelLog` on the live path appends
blindly, which is correct there and wrong here. Two full runs produce one copy
of every message.

### Spend cap

The distill plan is built and priced **before a single call is made**, in both
tokens and calls (`--max-tokens`, `--max-calls`, defaults 60000 / 20). Over
either one, the script prints the estimate and **refuses to proceed** - it does
not truncate, because a silently-truncated backfill looks complete in the
stats. The caps are re-checked against real reported usage during the run, so
an under-estimate cannot overspend.

Cost model: `estimateTokens` is chars/4; output is assumed to max out at 900
tokens per call; the rate defaults to Groq's published $0.10/$0.50 per 1M
in/out for `openai/gpt-oss-20b` and is overridable with `--price-in` /
`--price-out`.

### Merging, not overwriting

Distillation runs per person, in token-bounded chunks. A person's bucket is
everything they said **plus** everything anyone said about them (matched via
roster aliases), because "ava's last day is friday" never appears in ava's own
messages. Speakers are resolved through `lib/roster.js` + `lib/names.js`, never
ad-hoc name matching, and an alias two people share is dropped rather than
attributed to one of them.

Results are merged with `mergeChannelIntel`, the same additive/deduping path
`memory-distill` uses, so hand-written notes already on a profile survive.

### Guardrails (implemented, not just documented)

Every one of these exists in **both** the prompt and in code, because a
prompt-only guardrail drifts:

- **Sensitive material is excluded twice.** `isSensitive()` filters input
  messages before the model sees them, and `sanitizeExtractedNote()` filters
  the model's output before anything is written. Categories: health, family
  problems and bereavement, job anxiety and employment precarity, conflict
  with management or HR, distress, money trouble. The filter is deliberately
  biased toward false positives - a missed banter note costs nothing.
- **Departures are always neutral.** `neutralizeDepartureStrict()` wraps
  `neutralizeDeparture` from `memory-distill.js` and adds the noun/passive
  forms it misses ("after the layoffs", "let go", "pushed out"). It is applied
  after a check that the note is a plain departure rather than speculation, so
  "might get fired" is dropped as job anxiety instead of laundered into "might
  get left the company".
- **Channel text is DATA, never instructions.** The transcript is wrapped in a
  `<<<BEGIN_SLACK_TRANSCRIPT_DATA>>>` block, any fence token inside the content
  is redacted so a message cannot close the block early, and the prompt states
  that nothing inside may be obeyed. Post-hoc, `looksLikeInjection()` rejects
  any extracted note that reads like an instruction, a system prompt, code, a
  fence or a URL, and `sanitizeLifeEvent()` forces the event type back into a
  whitelist. Extracted names are only accepted if they resolve to a real roster
  member, so an injected person cannot create a profile.

Every rejection is counted by reason and printed in the end-of-run stats
(messages fetched, threads fetched, thread replies, stored, dupes skipped,
sensitive filtered, people seen, API calls, LLM calls, tokens spent, notes and
life events added per person).

## Identity Resolution (Phase 1)

The bot resolves who someone is talking about in a fixed order. The order is
the whole point: a tag is certain, a typed name is not, so the certain signal
is consumed first.

1. **Mention syntax, from RAW event text.** `<@U09GGU5ED24>` is matched to a
   roster entry by exact user ID. No fuzzy matching is involved.
2. **User groups and special mentions** (`<!subteam^S…>`, `<!here>`) are
   recognized as groups, never mistaken for a person.
3. **Typed names**, matched against roster aliases: real name, display name,
   Slack handle, first-name tokens, and any former names seen on a previous
   refresh.
4. **Ambiguity is asked about, never guessed.** Two people matching "alec"
   produces "which alec do you mean, ..." and no lookup.

### Why this was broken before

`lib/parse.js` rewrites `<@U09GGU5ED24>` to the literal string
`@U09GGU5ED24`, because Slack does not include a `|label` in modern mention
payloads. The old `findMentionedTeammates` then string-matched display names
against that text, i.e. compared a user ID to a display name. A tagged person
never resolved:

```
RAW    : <@U0AR6BMV46B> who is <@U09GGU5ED24>
CLEANED: @U0AR6BMV46B who is @U09GGU5ED24
MATCHED: (none)
```

`lib/guardrails.js` rewrites `/U[A-Z0-9]{8,12}/` to `"someone"` on the way
out, so the failure was invisible in Slack. **Any test of identity must assert
against `result.rawReply`, before guardrails run.**

### Roster refresh

Lazy, on demand, TTL-cached in KV (`roster:<channel>`, 6h). Deliberately not
scheduled:

- Vercel Hobby caps cron at once per day per job.
- GitHub Actions schedules are unreliable here: `memory-distill` has fired
  zero times, `feedback-watch` 3 times against a `*/15` cron.

A fresh roster is one KV read. A stale one is served immediately while it
refreshes behind the reply. Only a cold cache blocks. Identity always resolves
against the team channel roster (merged with the current channel's, if
different) so lookups still work in a DM.

Manual override: `@claudesington refresh roster`.

Optional event-driven invalidation is wired for `user_change`, `team_join`,
`member_joined_channel`, and `member_left_channel`. These are no-ops unless
the corresponding event subscriptions are enabled in the Slack app config.

### Facts stored per person

`userId`, `realName` (from `profile.real_name`, which is authoritative),
`displayName`, normalized forms of both, `handle`, `title`, `deleted`,
`isBot`, `isGuest`, `tz`, `updated`, `pastDisplayNames`, `pastRealNames`,
`aliases`, `preferredName`.

Two Slack API subtleties that are easy to get wrong and are load-bearing here:

- **`is_app_user` does not mean "is an app."** It means "is an authorized user
  of the calling app." Filtering bots on it drops real humans from the roster.
  Only `is_bot` is used, plus `USLACKBOT` by ID (Slack documents `is_bot` as
  false for Slackbot).
- **`profile.real_name` beats top-level `real_name`.** Slack's own `users.list`
  example ships them out of sync.

### Known limits

- Surname-only reference ("belza", "sloan") is intentionally not an alias.
  Surnames collide with ordinary words far more than first names do.
- Single-token aliases are filtered through a stopword list, so a display name
  like "Big Al" does not make "big" resolve to a person. The list covers filler
  words, not every English verb, so a teammate named e.g. "Mark" would still
  match "mark the calendar". Add such names to `ALIAS_STOPWORDS` if it happens.
- Aliases shorter than 3 characters are dropped.
- URLs, Slack link syntax and email addresses are stripped before name
  matching, but a hyphenated **document name** ("the ava-baker-onboarding doc")
  still matches. Accepted: a doc named after someone usually is about them.
- Ambiguity only blocks the reply for `identity_person_lookup`. For any other
  intent an ambiguous name is ignored and the actual question gets answered.

### Degradation behavior

- **Partial roster.** If `users.info` fails for some members, those people keep
  their previously cached record instead of vanishing, the roster is marked
  `partial`, and its effective TTL drops to 5 minutes so the next lookup
  retries. Before this, a rate-limited refresh cached a truncated roster as
  fresh for 6 hours, and a dropped member's `<@U…>` tag rendered as `@someone`.
- **Retry budgets are cumulative, not per-attempt.** `lib/claude.js` allows
  20s of total sleep, `slackApi` 8s. A per-attempt cap is useless: 3 attempts x
  24s is 72s of sleeping inside a function with a 60s `maxDuration`, which
  kills the invocation and posts nothing - worse than failing fast and letting
  the caller degrade to a graceful reply.
- `processEvent` has both a `catch` and a `finally`. `waitUntil` forwards the
  promise without catching, so an uncaught throw meant total silence.

## Groq rate limit

The on-demand tier caps **tokens per minute at 8000**, and one reply costs
roughly 2.5k. That is about **three bot replies per minute for the entire
workspace**. `lib/claude.js` retries 429s honoring `Retry-After` (up to 3
attempts, capped at 25s of waiting so the Vercel function budget survives).
Beyond that the caller degrades to a graceful message. Upgrading the Groq tier
is the real fix.
