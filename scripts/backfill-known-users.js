// One-off/rerunnable: rebuilds the known-users index from every profile
// already sitting in KV. Needed because the index was added to the code
// after profiles already existed in KV (the manual sdr-playersonly
// channel-history backfill, commit 4f380de) - those profiles were never
// indexed. Run with: node --env-file=.env scripts/backfill-known-users.js

import { rebuildKnownUsersIndex } from '../lib/user-profiles.js';

const known = await rebuildKnownUsersIndex();
console.log(`known-users index rebuilt: ${known.length} users`);
for (const u of known) console.log(`- ${u.displayName} (${u.userId})`);
