# Claudesington Bot - Improvement Plan

## Quick Wins (do now)

### 1. Fix intent routing - banter patterns missing
"what up", "what's good", "how's it going" fall through to general_qna and get relayed to Notion.
Add more greeting/banter patterns to intent.js.

### 2. Add ack message for relay path
Post "looking into that..." immediately, then edit when relay responds. Users stop thinking bot is dead.

### 3. Summarize relay responses
After getting raw Notion content, run it through a fast Haiku call:
"Rewrite this as a 1-2 sentence conversational Slack reply."

## Medium Term

### 4. Cache Notion content locally
Use cron job to snapshot key Notion pages. Serve from cache instead of relay for common questions.

### 5. Replace regex intent classifier with Haiku
One-shot classification call handles ambiguity far better than pattern matching.

## Long Term

### 6. Replace relay with local Notion cache + embeddings
Build embedding index of Notion pages (refresh daily via cron).
Cosine similarity to find relevant chunks, pass to Claude as context.
Response drops from 55s to 2-3s. Eliminates timeout problem entirely.
