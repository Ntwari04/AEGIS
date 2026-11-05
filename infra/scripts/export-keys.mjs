#!/usr/bin/env node
// Helps you keep OFF-SERVER copies of the two encryption keys (docs/secrets-review.md). Losing BACKUP_ENCRYPTION_KEY makes every backup
// unreadable; losing SECRETS_ENCRYPTION_KEY makes every stored environment secret unreadable.
//
//   node infra/scripts/export-keys.mjs                  fingerprints only (safe to paste anywhere): store them next to your copies
//   node infra/scripts/export-keys.mjs --reveal         prints the keys, in YOUR terminal only, to copy into a password manager
//   node infra/scripts/export-keys.mjs --verify NAME    paste your copy on stdin; says MATCH or MISMATCH, never prints either value
//
// --reveal refuses unless stdout is a terminal, so the keys cannot be piped into a file, a log or another program by accident.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const NAMES = ['BACKUP_ENCRYPTION_KEY', 'SECRETS_ENCRYPTION_KEY'];
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
const envPath = arg('--env') ? resolve(arg('--env')) : join(here, '..', '.env');

if (!existsSync(envPath)) { console.error(`FAIL  ${envPath} not found`); process.exit(1); }
const values = new Map();
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (m) values.set(m[1], m[2].trim());
}
for (const n of NAMES) {
  if (!values.get(n)) { console.error(`FAIL  ${n} is missing or empty in ${envPath}`); process.exit(1); }
}

// A fingerprint of a random 256-bit key reveals nothing about it, so it is safe to write down or paste.
const fingerprint = (v) => createHash('sha256').update(v.trim()).digest('hex').slice(0, 12);

if (process.argv.includes('--reveal')) {
  if (!process.stdout.isTTY) { console.error('FAIL  --reveal only prints to an interactive terminal (not a pipe or a file).'); process.exit(1); }
  console.log('Copy each value into a password manager (or print it and keep it in a safe). Then clear this terminal.\n');
  for (const n of NAMES) console.log(`${n}\n${values.get(n)}\nfingerprint ${fingerprint(values.get(n))}\n`);
} else if (arg('--verify')) {
  const name = arg('--verify');
  if (!NAMES.includes(name)) { console.error(`FAIL  --verify takes one of: ${NAMES.join(', ')}`); process.exit(1); }
  const pasted = readFileSync(0, 'utf8').trim();
  if (!pasted) { console.error('FAIL  nothing was pasted on stdin'); process.exit(1); }
  const ok = fingerprint(pasted) === fingerprint(values.get(name));
  console.log(ok ? `MATCH     your copy of ${name} is correct` : `MISMATCH  your copy of ${name} does NOT match the key in use`);
  process.exit(ok ? 0 : 1);
} else {
  console.log('Fingerprints (safe to share; they cannot be turned back into the keys):\n');
  for (const n of NAMES) console.log(`  ${n.padEnd(24)} ${fingerprint(values.get(n))}`);
  console.log('\nNext: run with --reveal in your own terminal, save both keys off this machine, then check each copy with --verify NAME.');
}
