# Claudesington - Braintrust SDR Slack Bot

Slack bot for the Braintrust SDR team. Hangs out in team channels, answers questions, and relays knowledge requests to a Notion AI agent for grounded answers.

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
| `lib/claude.js` | Calls Claude Haiku for local responses. |
| `lib/context.js` | Fetches Notion page content (currently limited, pages may be empty). |
| `lib/calendar.js` | Fetches Google Calendar events (needs env vars configured). |
| `lib/capabilities.js` | Runtime capability detection (what sources are connected). |
| `prompts/system.js` | System prompt for local Claude path. Casual SDR teammate tone. |
| `tests/unit.test.js` | 94 unit tests covering all modules. |

## Intent Routing

| Intent | Relay? | Examples |
|--------|--------|----------|
| `banter` | No (local) | "lol", "lets go!", "good morning" |
| `bot_meta` | No (local) | "what can you do", "who are you" |
| `braintrust_resources` | No (local) | "case study for search", "pricing link" |
| `help_request` | Yes | "has anyone put together slides for X", "how do I set up a demo" |
| `calendar_whereabouts` | Yes | "where is ava", "what's on my calendar" |
| `account_or_pipeline` | Yes | "what's the pipeline", "who owns X account" |
| `identity_person_lookup` | Yes | "who is nick" |
| `general_qna` | Yes | anything else |

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

94 tests covering: dedup, parsing, intent, triggers, guardrails, slack formatting, system prompt, relay config, relay store, relay request/response, duplicate prevention, fallback behavior, identity claims.

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
