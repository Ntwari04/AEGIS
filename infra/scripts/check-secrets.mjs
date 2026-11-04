#!/usr/bin/env node
// Audits infra/.env against infra/.env.example (PRD 8.3). It NEVER prints a secret's value: only variable names and verdicts.
//
//   node infra/scripts/check-secrets.mjs [--env infra/.env] [--example infra/.env.example]
//
// Exit code 1 if anything FAILS. WARN is advice, not a failure.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > -1 ? resolve(process.argv[i + 1]) : fallback; };
const envPath = arg('--env', join(here, '..', '.env'));
const examplePath = arg('--example', join(here, '..', '.env.example'));

const SECRETISH = /PASSWORD|SECRET|TOKEN|_KEY$/;
// Secrets that are legitimately empty until the feature they belong to is switched on.
const OPTIONAL = new Set(['GHCR_TOKEN', 'S3_SECRET_ACCESS_KEY', 'ALERT_SMTP_PASSWORD']);
// Secrets that are raw 32-byte keys, base64-encoded.
const KEY32 = new Set(['BACKUP_ENCRYPTION_KEY', 'SECRETS_ENCRYPTION_KEY']);

const parse = (text) => {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
};

const results = [];
const add = (level, name, message) => results.push({ level, name, message });

if (!existsSync(envPath)) { console.error(`FAIL  ${envPath} not found`); process.exit(1); }
const env = parse(readFileSync(envPath, 'utf8'));
const example = existsSync(examplePath) ? parse(readFileSync(examplePath, 'utf8')) : new Map();

// 1. every secret the example declares is set to a real value
for (const [name, exampleValue] of example) {
  if (!SECRETISH.test(name) || exampleValue !== 'CHANGE_ME') continue;
  const v = env.get(name);
  if (v === undefined || v === '' || v === 'CHANGE_ME') {
    if (OPTIONAL.has(name)) add('WARN', name, 'not set (optional until that feature is used)');
    else add('FAIL', name, v === 'CHANGE_ME' ? 'still the CHANGE_ME placeholder' : 'missing or empty');
  }
}

// 2. strength and format of the values that are set
const secrets = [...env].filter(([n, v]) => SECRETISH.test(n) && v && v !== 'CHANGE_ME');
for (const [name, v] of secrets) {
  if (KEY32.has(name)) {
    if (Buffer.from(v, 'base64').length !== 32) add('FAIL', name, 'is not a base64-encoded 32-byte key (openssl rand -base64 32)');
  } else if (v.length < 16 && !OPTIONAL.has(name)) {
    add('WARN', name, `is short (${v.length} characters); use at least 16 random characters`);
  }
  if (/^(password|changeme|secret|admin|test)/i.test(v)) add('FAIL', name, 'looks like a placeholder or common password');
}

// 3. the same value must not protect two different things (one leak would open both)
const byValue = new Map();
for (const [name, v] of secrets) byValue.set(v, [...(byValue.get(v) ?? []), name]);
for (const names of byValue.values()) if (names.length > 1) add('FAIL', names.join(', '), 'share the SAME value: use a different secret for each');

// 4. file permissions (POSIX) and git
try {
  const mode = statSync(envPath).mode & 0o777;
  if (process.platform !== 'win32' && mode & 0o077) add('FAIL', '.env', `is readable by other users (mode ${mode.toString(8)}); run: chmod 600 ${envPath}`);
  else if (process.platform === 'win32') add('WARN', '.env', 'file permissions cannot be checked on Windows; on the server it must be chmod 600');
} catch { /* unreadable stat: already reported above */ }
try {
  execFileSync('git', ['ls-files', '--error-unmatch', envPath], { stdio: 'ignore', cwd: dirname(envPath) });
  add('FAIL', '.env', 'is TRACKED BY GIT: remove it from the index (git rm --cached) and rotate every secret in it');
} catch { /* not tracked (or not a git checkout): good */ }

// 5. a local key file must not be committed or world-readable
const keyFile = join(dirname(envPath), 'secrets', 'github-app.pem');
if (existsSync(keyFile)) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', keyFile], { stdio: 'ignore', cwd: dirname(envPath) });
    add('FAIL', 'secrets/github-app.pem', 'is TRACKED BY GIT: remove it and regenerate the key in GitHub');
  } catch { /* not tracked */ }
  if (process.platform !== 'win32' && statSync(keyFile).mode & 0o037) add('FAIL', 'secrets/github-app.pem', 'is readable by other users (use chmod 640 at most)');
}

const fails = results.filter((r) => r.level === 'FAIL');
for (const r of results.sort((a, b) => (a.level < b.level ? -1 : 1))) console.log(`${r.level.padEnd(5)} ${r.name}: ${r.message}`);
console.log(fails.length ? `\n${fails.length} problem(s) to fix.` : `\nOK: ${secrets.length} secret(s) checked, no failures.`);
process.exit(fails.length ? 1 : 0);
