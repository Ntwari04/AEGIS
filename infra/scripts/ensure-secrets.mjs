#!/usr/bin/env node
// Adds any MISSING generated secrets to infra/.env, each on its own line. Never overwrites an existing value and never
// prints a value. Safe to run repeatedly.
//
//   node infra/scripts/ensure-secrets.mjs
//
// It exists because `Add-Content` / `>>` onto a file with no trailing newline glues the new line onto the last one.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (!existsSync(envPath)) {
  console.error('infra/.env not found. Copy infra/.env.example to infra/.env first.');
  process.exit(1);
}

// name -> generator. Only secrets this platform generates for itself belong here (never third-party credentials).
const GENERATED = {
  GRAFANA_ADMIN_PASSWORD: () => randomBytes(24).toString('base64url'),
  GRAFANA_OAUTH_SECRET: () => randomBytes(32).toString('base64url'),
};

let text = readFileSync(envPath, 'utf8');
const has = (name) => new RegExp(`^${name}=.+$`, 'm').test(text) && !new RegExp(`^${name}=CHANGE_ME$`, 'm').test(text);
const added = [];
for (const [name, gen] of Object.entries(GENERATED)) {
  if (has(name)) continue;
  // Replace a placeholder line in place, otherwise append.
  const placeholder = new RegExp(`^${name}=(CHANGE_ME)?$`, 'm');
  if (placeholder.test(text)) {
    text = text.replace(placeholder, `${name}=${gen()}`);
  } else {
    if (!text.endsWith('\n')) text += '\n';
    text += `${name}=${gen()}\n`;
  }
  added.push(name);
}
if (!text.endsWith('\n')) text += '\n';
writeFileSync(envPath, text);
console.log(added.length ? `Added: ${added.join(', ')} (values not shown)` : 'Nothing to add: all generated secrets are already set.');
