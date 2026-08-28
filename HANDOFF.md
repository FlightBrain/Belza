# Handoff — session of 2026-08-28

State at close: **all work committed, pushed, and deployed.** `local == origin == deployed`.
Verify with `git rev-parse --short HEAD` vs `curl -s https://claudesington.vercel.app/api/version`.

---

## How to check the bot is alive (do this first, next session)

```bash
# 1. deployed commit == HEAD?
git rev-parse --short HEAD
gh api repos/FlightBrain/Belza/deployments --jq '.[0].sha[0:7]'
curl -s https://claudesington.vercel.app/api/version | python3 -m json.tool

# 2. endpoints
curl -s -o /dev/null -w '%{http_code}\n' https://claudesington.vercel.app/api/slack-events   # 405 = alive
curl -s -o /dev/null -w '%{http_code}\n' https://claudesington.vercel.app/api/cron/check-reminders  # 401 = alive

# 3. tests
npm test        # 657 passing

# 4. is it actually replying? (Braintrust, not logs)
#    query project_logs for metadata.trace_kind = 'production_reply', sort created desc
```

`/api/version` exists specifically because guessing at prod config wasted hours.
It reports the commit and effective config. Trust it over inference.

---

## What was done this session

### Pre-work cleanup
- Deleted `api/test-bt.js` — an **unauthenticated** endpoint that wrote to Braintrust on any GET.
- Unscheduled `api/cron/task-reconciler.js` (posted a personal Notion task list into a group channel), then deleted it.
- `.env`: `SLACK_BOT_USER_ID` was still the placeholder `U0YOURBOTUSERID`. Real value `U0AR6BMV46B`.
- Fixed two object-vs-string bugs in the EOD cron that meant it could only ever post nothing.

### Phase 1 — Slack identity (done, 100%)
Root cause: `lib/parse.js` rewrote `<@U09GGU5ED24>` to the literal string `@U09GGU5ED24`,
then name-matching compared a **user ID against a display name**. A tagged person never
resolved. `lib/guardrails.js` rewrites `/U[A-Z0-9]{8,12}/` → `"someone"`, so it failed invisibly.

New: `lib/roster.js` (roster from `conversations.members` + `users.info`, KV-cached, lazy TTL
refresh — **not** cron, because Vercel Hobby caps cron at once/day and GitHub Actions has
fired `memory-distill` zero times), `lib/identity.js` (tags resolved by exact ID **before**
any fuzzy match; ambiguity asked, never guessed), `lib/names.js`.

Verified: **39/39** resolution, **117/117** with live model calls asserted pre-guardrails.

Then an adversarial review found **10 real bugs** in that code, all fixed — including
retry sleeps that were capped per-attempt not cumulatively (3×24s = 72s inside a 60s
function, which made my own change *worse* than what it replaced).

### Relay (done)
`RELAY_ENABLED` is **true** in prod — the Phase 0 audit inferred otherwise from local `.env`
and was wrong. Measured latency **18.8–31.2s** over 14 real round trips. Responder is always
`bot_id B071TMT4A0N`.

- Allowlist defaults to `B071TMT4A0N`; the `>10 chars` fallback is **gone**, `REQUEST_ID` required.
  Previously an unrelated Zapier/human message in a relay thread could be spoken as a grounded answer.
- `lib/source-visibility.js` — the relay agent authenticates as a person, so it can see private
  Notion pages, other Slack channels and 1:1 notes that the destination channel cannot.
  Observed leaking: **every** reply carried an internal Notion agent URL, and one echoed the
  agent's own system prompt including Kensington's name and email.
- Timeout capped at 48s so polling can't overrun the 60s function and leave the user with
  only the filler.

### One Notion path (done)
Deleted `lib/context.js`, `@notionhq/client`, `NOTION_API_KEY`. Relay is the only Notion path.
Exposed a gap: "what marketing events are upcoming" never relayed and was served only by the
dead API path — now folded into the relay signal.

### Calendar — CUT
A Google **API key** gives anonymous access to *public* data only (verified verbatim in
Google's docs). Workspace calendars aren't public → 404 for every teammate. Needs per-user
OAuth or a service account with **domain-wide delegation authorized by a super admin**.
`lib/calendar.js` deleted rather than left returning `[not connected]` forever.

### Phase 2 — the blank "dunno" (done)
`lib/answer-floor.js`. Built from a real failure in-channel where the bot declined *and*
invented a referral to Maddy Ahlborn about someone she has no connection to.
- fact known → untouched; fact unknown but person known → rewritten to offer what it has;
  person unknown → **untouched** (correct answer, never manufacture a substitute);
  a departure on file is never volunteered.
- `enforcePronouns` — the prompt-only pronoun fix **drifted within one commit** (live output:
  `"he's the guy who still runs a 1080ti"` for someone with no pronoun data). Code guard now
  rewrites to they/them, only when nobody referenced has published pronouns.

### Phase 4 — backfill (built, NOT run)
`scripts/backfill-history.js`. Real dry run against the live channel:
```
history pages 50 | messages 11895 | threads 538 | replies 2090
storable 10767 | sensitive filtered 162 | people 13 | slack calls 588
distill: 86 calls, ~323326 tokens, ~$0.06 on qwen/qwen3.8-27b
pacing: 8000 tok/min, pacing at 6800 (85%), largest call 4810
PROJECTED WALL CLOCK: 46m 33s
```
Reviewing the agent's work found **5 departure-guardrail defects**, including job anxiety
being laundered into durable notes (`"i think im getting fired"` → kept as
`"i think im getting left the company"`).

### Phase 6 — failure-mode register (done)
`docs/FAILURE-MODES.md`, 32 modes, 153 `file:line` citations. Verified and fixed its three
sharpest findings: a live timezone bug (UTC server stamped 4:30pm PT as tomorrow, and that
wrong date persisted 90 days on a `lifeEvent`), silent distill misattribution between two
same-first-name people, and **zero client-side timeouts on any outbound fetch**.

### The @mention outage (found and fixed live)
The bot had been silent for **18.3 hours**. Not tokens. `api/slack-events.js` unconditionally
dropped every `message` event containing the bot's mention, betting `app_mention` would
arrive. When it stopped arriving, every direct address vanished while ambient logging kept
working — and the skip logged like normal operation. Now: atomic KV claim on
`channel+ts+user`, whichever event arrives first wins. Confirmed replying again.

---

## Models and quotas — important

| | model | limits |
|---|---|---|
| **Live bot** (`lib/claude.js`) | `openai/gpt-oss-20b` | 8000 tok/**min**, 200k/**day** |
| **Distill** (`scripts/*`) | `qwen/qwen3.8-27b` | 8000 tok/**min**, 2M/**day** |

**Groq rate limits are per model per key** — verified from live headers showing different
remaining counts and unrelated reset clocks on the same key at the same instant. That's why
the distiller is on a different model: a 46-minute batch can't starve the live bot. A test
asserts `MODEL !== 'openai/gpt-oss-20b'` so this can't silently regress.

The gpt-oss **daily** cap was hit twice this session by test runs. One reply ≈ 2.5k tokens,
so ~3 replies/minute for the whole workspace. `lib/token-pacer.js` is a token bucket that
waits *before* sending; use it for anything batch.

---

## Open items, in priority order

1. **`BRAINTRUST_API_KEY` in the Vercel dashboard** — prod still holds the old key. The new
   one is in local `.env` and verified working (write + read round-trip). **You must do this;
   I can't reach Vercel env.**
2. **Rotate that Braintrust key** — it was pasted into a chat transcript.
3. **KV list migration** (`docs/FAILURE-MODES.md` section J, item D). The register's proposed
   diff is **unsafe as written**: `kv.rpush` onto `chanlog:`/`hist:` throws
   `WRONGTYPE Operation against a key holding the wrong kind of value` because those keys hold
   JSON strings today. Verified against live KV. Needs a migration with a WRONGTYPE fallback
   on read. Decide migrate-first vs backfill-first — **recommend migrate first.**
4. **One-month distill slice**, then the full corpus. Snapshot already taken:
   ```
   automation/profile-snapshots/2026-08-28T17-01-59-622Z.json   (25 keys, 13 profiles)
   # restore (destructive, takes its own safety snapshot first):
   node --env-file=.env scripts/profile-snapshot.js restore <file> --confirm
   ```
   **A distill run is not reversible** — `mergeChannelIntel` appends with no undo or versioning.
5. **Finish Phase 3.** The eval suite exists (`evals/`, 21 rows, 7 scorers, paced, **not run**)
   and reaction→`logFeedback` already worked. Still missing: **online scoring** on production
   traffic, and the **auto-correct loop** (scheduled job that clusters low-scoring traces and
   proposes a prompt/skill diff for review — proposes, never self-applies).
6. **Slack app config**, if you want it: confirm `app_mention` is subscribed under Event
   Subscriptions. The code no longer depends on it, but it's the only event that fires in
   channels where the bot can't read all messages. Optional: `user_change`, `team_join`,
   `member_joined_channel`, `member_left_channel` for event-driven roster invalidation —
   handlers exist and are inert without the subscriptions.

---

## Known-fragile / accepted risks

- **`api/slack-events.js` is ~750 lines with no direct test coverage.** Test harnesses
  *reproduce* its logic rather than calling it, so they can drift. Most bugs this session
  lived here.
- **All KV writes are unlocked read-modify-write.** Real race, unfixed (item 3 above).
- **`node_modules/@notionhq` is still on disk** but unreferenced; Vercel installs fresh.
- Relay adds ~25s latency behind a filler message on any relayed answer.
- `enforcePronouns` produces "they're the guy" — awkward but honest.
- Surname-only reference ("belza", "sloan") is intentionally not an alias.

---

## Hard-won lessons worth not relearning

- **Assert against `result.rawReply`, before `applyGuardrails`.** It rewrites raw user IDs to
  `"someone"`, which turns a failed identity lookup into a fluent, passing sentence. Proven:
  three synthetic leaks all came out clean post-guardrails.
- **Don't run two agents against one repo.** Two concurrent writers on `tests/unit.test.js`
  produced a commit whose test file didn't parse (duplicate `estimateTokens` import), and
  `git add -A` swept unreviewed code in. Sequence them, or scope each to disjoint new files.
- **Verify prod config, never infer it.** The Phase 0 audit called the relay disabled from
  local `.env`; it was on. That's what `/api/version` is for.
- **Prompt-only fixes drift, measurably.** The pronoun rule failed within one commit of
  shipping. Prompt *and* code, every time.
- **Retry budgets must be cumulative, not per-attempt.**
- Unit tests with hand-typed fixtures miss real-world input. The curly-apostrophe bug in
  `enforcePronouns` (`he’s` → `they’s`) passed every unit test and failed the first live call.
