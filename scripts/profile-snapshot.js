// Snapshot and restore every profile in KV.
//
// WHY: a distill run is NOT reversible on its own. mergeChannelIntel appends
// to profile.channelNotes and profile.lifeEvents and there is no undo, no
// versioning, and no record of which notes came from which run. Deduping on
// merge means a re-run is idempotent, but it does not mean a bad run can be
// taken back - a hallucinated or badly-phrased note that lands in a profile is
// there until someone removes it by hand.
//
// So: snapshot first, always.
//
//   node --env-file=.env scripts/profile-snapshot.js save
//   node --env-file=.env scripts/profile-snapshot.js list
//   node --env-file=.env scripts/profile-snapshot.js diff <file>
//   node --env-file=.env scripts/profile-snapshot.js restore <file>
//   node --env-file=.env scripts/profile-snapshot.js restore <file> --confirm
//
// restore is a DESTRUCTIVE overwrite of every key in the snapshot and refuses
// to run without --confirm.

import fs from 'fs';
import path from 'path';
import { kv } from '@vercel/kv';

const SNAP_DIR = path.join('automation', 'profile-snapshots');
// Every key namespace a distill run can touch. hist: is included because a
// backfill writes message history too, and roster:/known-users because a
// restore should put the whole memory layer back where it was.
const PREFIXES = ['user:', 'hist:', 'chanlog:', 'roster:'];
const SINGLETONS = ['known-users'];

function requireKv() {
  if (!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)) {
    console.error('profile-snapshot: KV_REST_API_URL / KV_REST_API_TOKEN not set.');
    console.error('  run with: node --env-file=.env scripts/profile-snapshot.js <cmd>');
    process.exit(1);
  }
}

async function collectKeys() {
  const keys = [];
  for (const prefix of PREFIXES) {
    keys.push(...(await kv.keys(`${prefix}*`)));
  }
  for (const k of SINGLETONS) {
    if ((await kv.get(k)) !== null) keys.push(k);
  }
  return [...new Set(keys)].sort();
}

async function save() {
  requireKv();
  const keys = await collectKeys();
  const data = {};
  for (const key of keys) data[key] = await kv.get(key);

  fs.mkdirSync(SNAP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(SNAP_DIR, `${stamp}.json`);

  const snapshot = {
    takenAt: new Date().toISOString(),
    keyCount: keys.length,
    // Recorded so a restore can warn if the snapshot came from a different
    // deployment than the one being restored into.
    commit: process.env.VERCEL_GIT_COMMIT_SHA || 'local',
    data,
  };
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n');

  const profiles = keys.filter((k) => k.startsWith('user:'));
  console.log(`profile-snapshot: saved ${keys.length} keys to ${file}`);
  console.log(`  profiles: ${profiles.length}`);
  for (const key of profiles) {
    const p = data[key];
    console.log(
      `    ${(p?.displayName || key).padEnd(24)} ` +
        `channelNotes=${p?.channelNotes?.length ?? 0} lifeEvents=${p?.lifeEvents?.length ?? 0}`,
    );
  }
  console.log('');
  console.log('  RESTORE COMMAND (destructive, overwrites these keys):');
  console.log(`    node --env-file=.env scripts/profile-snapshot.js restore ${file} --confirm`);
  return file;
}

function loadSnapshot(file) {
  if (!file) {
    console.error('profile-snapshot: need a snapshot file path');
    process.exit(1);
  }
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!snap?.data) {
    console.error(`profile-snapshot: ${file} has no data block`);
    process.exit(1);
  }
  return snap;
}

// What a restore would change, per person. Run this before restoring so the
// overwrite is a decision rather than a hope.
async function diff(file) {
  requireKv();
  const snap = loadSnapshot(file);
  console.log(`profile-snapshot: diff against ${file} (taken ${snap.takenAt})`);
  let changed = 0;

  for (const [key, before] of Object.entries(snap.data)) {
    const now = await kv.get(key);
    const same = JSON.stringify(before) === JSON.stringify(now);
    if (same) continue;
    changed += 1;
    if (key.startsWith('user:')) {
      const bn = before?.channelNotes?.length ?? 0;
      const nn = now?.channelNotes?.length ?? 0;
      const be = before?.lifeEvents?.length ?? 0;
      const ne = now?.lifeEvents?.length ?? 0;
      console.log(`  ${(now?.displayName || before?.displayName || key).padEnd(24)} notes ${bn} -> ${nn}   lifeEvents ${be} -> ${ne}`);
      for (const note of (now?.channelNotes || []).filter((n) => !(before?.channelNotes || []).includes(n))) {
        console.log(`      + note: ${JSON.stringify(note)}`);
      }
      for (const ev of now?.lifeEvents || []) {
        const had = (before?.lifeEvents || []).some((e) => e.note === ev.note && e.type === ev.type);
        if (!had) console.log(`      + lifeEvent [${ev.type}]: ${JSON.stringify(ev.note)}`);
      }
    } else {
      const len = (v) => (Array.isArray(v) ? `${v.length} entries` : typeof v);
      console.log(`  ${key.padEnd(24)} ${len(before)} -> ${len(now)}`);
    }
  }

  // A key that exists now but not in the snapshot would SURVIVE a restore.
  const live = await collectKeys();
  const extra = live.filter((k) => !(k in snap.data));
  if (extra.length) {
    console.log('');
    console.log('  keys created since the snapshot (a restore will NOT remove these):');
    for (const k of extra) console.log(`    ${k}`);
  }

  if (changed === 0) console.log('  no differences');
  return changed;
}

async function restore(file, confirmed) {
  requireKv();
  const snap = loadSnapshot(file);
  const keys = Object.keys(snap.data);

  if (!confirmed) {
    console.log(`profile-snapshot: would restore ${keys.length} keys from ${file}`);
    console.log('  this OVERWRITES current values. re-run with --confirm to do it.');
    await diff(file);
    return;
  }

  // Snapshot the current state first. Restoring is itself a destructive act,
  // and the state being overwritten may be the one someone actually wanted.
  console.log('profile-snapshot: taking a safety snapshot of current state first...');
  const safety = await save();

  let restored = 0;
  for (const [key, value] of Object.entries(snap.data)) {
    if (value === null || value === undefined) {
      await kv.del(key);
    } else {
      // Match the TTLs the app itself uses, so a restore does not
      // accidentally make a key immortal.
      const ttl = key.startsWith('user:') || key.startsWith('hist:') ? 90 * 24 * 3600 : null;
      if (ttl) await kv.set(key, value, { ex: ttl });
      else await kv.set(key, value);
    }
    restored += 1;
  }
  console.log(`profile-snapshot: restored ${restored} keys from ${file}`);
  console.log(`  the state you just overwrote is saved at ${safety}`);
}

function list() {
  if (!fs.existsSync(SNAP_DIR)) {
    console.log('profile-snapshot: no snapshots yet');
    return;
  }
  const files = fs.readdirSync(SNAP_DIR).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) {
    console.log('profile-snapshot: no snapshots yet');
    return;
  }
  console.log('profile-snapshot: available snapshots (newest last)');
  for (const f of files) {
    const p = path.join(SNAP_DIR, f);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* ignore */ }
    console.log(`  ${p}  ${meta.keyCount ?? '?'} keys  taken ${meta.takenAt ?? '?'}`);
  }
}

const [cmd, arg] = process.argv.slice(2);
const confirmed = process.argv.includes('--confirm');

switch (cmd) {
  case 'save': await save(); break;
  case 'list': list(); break;
  case 'diff': await diff(arg); break;
  case 'restore': await restore(arg, confirmed); break;
  default:
    console.log('usage: profile-snapshot.js save | list | diff <file> | restore <file> [--confirm]');
    process.exitCode = 1;
}
