// Lightweight in-memory relay job tracker.
// Persists across warm Vercel invocations; cold starts get a fresh map.
// Primary purpose: dedup within warm instances + structured logging.

const JOB_TTL_MS = 120_000;
const jobs = new Map();

export function createJob(requestId, eventKey, event) {
  pruneJobs();
  const job = {
    requestId,
    eventKey,
    status: 'received', // received | relayed | answered | posted | complete | timeout | failed
    originalChannel: event.channel,
    originalThreadTs: event.thread_ts || event.ts,
    originalMessageTs: event.ts,
    originalUser: event.user || '',
    relayMessageTs: null,
    matchedResponseTs: null,
    finalPostTs: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + JOB_TTL_MS,
    error: null,
  };
  jobs.set(requestId, job);
  return job;
}

export function updateJob(requestId, updates) {
  const job = jobs.get(requestId);
  if (job) Object.assign(job, updates);
  return job;
}

export function getJob(requestId) {
  return jobs.get(requestId) || null;
}

export function hasActiveJobForEvent(eventKey) {
  for (const job of jobs.values()) {
    if (
      job.eventKey === eventKey &&
      !['complete', 'failed', 'timeout'].includes(job.status)
    ) {
      return true;
    }
  }
  return false;
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now > job.expiresAt) jobs.delete(id);
  }
}

export function _resetStore() {
  jobs.clear();
}

export function _getJobs() {
  return jobs;
}
