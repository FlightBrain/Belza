// Token-bucket pacer for a tokens-per-minute API limit.
//
// WHY A BUCKET AND NOT A RETRY
// lib/claude.js reacts to 429s: send, get refused, sleep, send again. That is
// right for the live bot, where a request either happens now or a person is
// left hanging. It is the wrong shape for a batch job:
//   - Every 429 is a wasted round trip, and Groq's suggested wait covers the
//     whole window, so a batch that reacts spends most of its life asleep.
//   - The Phase 1 review found reactive retries with a PER-ATTEMPT cap slept
//     72s inside a 60s budget. Reacting is hard to bound correctly.
//   - A 429 means you were already too fast. A bucket means you never were.
// So this WAITS BEFORE SENDING, computing the wait from what it has already
// spent. A correctly paced run should see zero 429s; if it sees any, an
// estimate was low and settle() pays the difference back.
//
// GROQ'S LIMITS ARE PER MODEL, verified from live response headers on one key
// at the same moment:
//   qwen/qwen3.8-27b    limit-tokens 8000, remaining 7986, reset  105ms
//   openai/gpt-oss-20b  limit-tokens 8000, remaining 7927, reset  547ms
// Different remaining counts and unrelated reset clocks, so pacing the
// distiller on qwen does not spend the live bot's gpt-oss budget.
//
// ONE IMPLEMENTATION OF THE MATH. `peekWaitMs` + `commit` are the whole
// bucket; `reserve` is those two plus real sleeping, and `projectWallClockMs`
// is those two plus a virtual clock. A projection that used separate
// arithmetic could disagree with the run it is predicting.
//
// Clock and sleep are injectable so behaviour is asserted with a fake clock in
// tests rather than inferred from watching a real run.

// Reserve against a fraction of the real limit. Token counts are estimates
// (chars/4), the API bills what it bills, and a bucket aiming at exactly 100%
// drifts into 429s on any underestimate.
const DEFAULT_SAFETY = 0.85;

export function createTokenPacer({
  tokensPerMinute,
  safety = DEFAULT_SAFETY,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!Number.isFinite(tokensPerMinute) || tokensPerMinute <= 0) {
    throw new Error(`token-pacer: tokensPerMinute must be positive, got ${tokensPerMinute}`);
  }
  if (!(safety > 0 && safety <= 1)) {
    throw new Error(`token-pacer: safety must be in (0, 1], got ${safety}`);
  }

  const capacity = Math.floor(tokensPerMinute * safety);
  const perMs = capacity / 60_000;

  // Start full: nothing has been spent on this model yet as far as this
  // process knows, and a cold key agrees (remaining ~= limit).
  let available = capacity;
  let last = now();
  let waitedMs = 0;
  let reservations = 0;
  let corrections = 0;
  let syncs = 0;

  function refill() {
    const t = now();
    const elapsed = t - last;
    if (elapsed > 0) {
      available = Math.min(capacity, available + elapsed * perMs);
      last = t;
    }
  }

  // The most important guard in the file: a request bigger than the whole
  // bucket can NEVER be satisfied, so it must fail loudly instead of looping
  // forever on a budget that will never arrive. This is what enforces
  // "chunk size must stay under the per-minute limit".
  function assertSatisfiable(tokens) {
    if (!Number.isFinite(tokens) || tokens < 0) {
      throw new Error(`token-pacer: tokens must be a non-negative number, got ${tokens}`);
    }
    if (tokens > capacity) {
      throw new Error(
        `token-pacer: a single request of ${tokens} tokens can never fit the usable ` +
          `budget of ${capacity} (${tokensPerMinute}/min x ${safety} safety). ` +
          `Reduce chunk size or raise the limit - waiting cannot help.`,
      );
    }
  }

  const api = {
    capacity,
    tokensPerMinute,
    safety,

    // How long a request this size must wait right now. Consumes nothing.
    peekWaitMs(tokens) {
      assertSatisfiable(tokens);
      refill();
      if (available >= tokens) return 0;
      return Math.ceil((tokens - available) / perMs);
    },

    // Debit without waiting. Only valid once peekWaitMs has returned 0 (real
    // run) or the caller has advanced its own clock by that much (projection).
    commit(tokens) {
      assertSatisfiable(tokens);
      refill();
      available -= tokens;
      reservations += 1;
    },

    // Wait until `tokens` fit, then debit. Returns ms actually slept.
    async reserve(tokens) {
      assertSatisfiable(tokens);
      let slept = 0;
      // A loop, not one sleep: the clock may not advance exactly as predicted,
      // and settle() can push `available` negative.
      for (;;) {
        const wait = api.peekWaitMs(tokens);
        if (wait === 0) break;
        await sleep(wait);
        slept += wait;
      }
      api.commit(tokens);
      waitedMs += slept;
      return slept;
    },

    // Reconcile the estimate with what the API actually billed. An
    // underestimate has to be paid back or the bucket drifts optimistic and
    // the run starts collecting 429s halfway through.
    settle(reservedTokens, actualTokens) {
      if (!Number.isFinite(actualTokens) || actualTokens < 0) return;
      const delta = actualTokens - reservedTokens;
      if (delta === 0) return;
      refill();
      // Going below zero is intentional - the next reserve() waits longer.
      available -= delta;
      if (available > capacity) available = capacity;
      corrections += 1;
    },

    // Trust the API over our own bookkeeping.
    //
    // The bucket starts full because a fresh process has no idea what it has
    // spent. That assumption is WRONG whenever a previous process just spent
    // budget: the API's window does not reset because our process did. Found
    // this the hard way - running the verification script twice inside a
    // minute produced a 429 on the second run, with the pacer believing it had
    // a full bucket:
    //
    //   Rate limit reached ... TPM: Limit 8000, Used 7672, Requested 726
    //
    // Groq returns x-ratelimit-remaining-tokens on every response, which is
    // ground truth. Clamping to it makes the first call of a run self-correct
    // instead of the whole run being optimistic.
    syncFromHeaders(headers) {
      if (!headers || typeof headers.get !== 'function') return null;
      const raw = headers.get('x-ratelimit-remaining-tokens');
      if (raw == null) return null;
      const remaining = Number.parseFloat(raw);
      if (!Number.isFinite(remaining) || remaining < 0) return null;

      refill();
      // Scale the API's remaining budget by our safety fraction, since our
      // capacity is deliberately below the real limit.
      const trueAvailable = remaining * safety;
      if (trueAvailable < available) {
        available = trueAvailable;
        syncs += 1;
        return { corrected: true, remaining, available: Math.floor(available) };
      }
      return { corrected: false, remaining, available: Math.floor(available) };
    },

    stats() {
      refill();
      return {
        capacity,
        available: Math.floor(available),
        reservations,
        waitedMs,
        corrections,
        syncs,
      };
    },
  };

  return api;
}

// Projected wall clock for a whole batch. Synchronous, costs nothing, sleeps
// nothing - it drives the SAME bucket the real run uses, against a virtual
// clock.
//
// units: [{ tokens }] where tokens is input + max output for that call.
export function projectWallClockMs(units, { tokensPerMinute, safety = DEFAULT_SAFETY } = {}) {
  let clock = 0;
  const pacer = createTokenPacer({ tokensPerMinute, safety, now: () => clock });

  let waitMs = 0;
  let maxWait = 0;
  for (const unit of units) {
    const wait = pacer.peekWaitMs(unit.tokens);
    if (wait > 0) {
      clock += wait;
      waitMs += wait;
      if (wait > maxWait) maxWait = wait;
    }
    pacer.commit(unit.tokens);
  }

  return {
    ms: clock,
    waitMs,
    longestWaitMs: maxWait,
    calls: units.length,
    capacity: pacer.capacity,
  };
}

export function formatDuration(ms) {
  if (ms == null) return 'unknown';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
