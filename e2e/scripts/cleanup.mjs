#!/usr/bin/env node
// Removes what the end-to-end tests leave behind on the LOCAL stack, and nothing else: projects whose slug starts with "e2e-"
// (their environments, databases and keys go with them), their containers and Nginx routes, the databases and roles provisioned for
// them (app_e2e_*) and the restore copies of those (restore_db_*), and test users in Keycloak (username starts with "e2e-").
//
//   node e2e/scripts/cleanup.mjs            show what would be removed
//   node e2e/scripts/cleanup.mjs --yes      remove it
//
// It never touches object storage: the encrypted archives of those test databases stay in the bucket until a person deletes the
// aegisops/db/ folder there (nothing refers to them any more, and they are unreadable without the backup key).
import { execFileSync } from 'node:child_process';

const yes = process.argv.includes('--yes');
const PG = process.env.E2E_POSTGRES_CONTAINER ?? 'aegisops-postgres';
const KC = process.env.E2E_KEYCLOAK_CONTAINER ?? 'aegisops-keycloak';
const NGINX = process.env.E2E_NGINX_CONTAINER ?? 'aegisops-nginx';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const psql = (db, sql) => docker('exec', PG, 'psql', '-U', 'postgres', '-d', db, '-At', '-c', sql);
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

const projects = lines(psql('aegisops', `select slug from "Project" where slug like 'e2e-%'`));
const containers = lines(docker('ps', '-a', '--format', '{{.Names}}')).filter((n) => /^aegis-e2e-/.test(n));
const routes = lines(docker('exec', NGINX, 'sh', '-c', 'ls /etc/nginx/conf.d/managed 2>/dev/null || true')).filter((f) => /^project-e2e-/.test(f));
const databases = lines(psql('postgres', `select datname from pg_database where datname like 'app\\_e2e\\_%' or datname like 'restore\\_db\\_%'`));
const roles = lines(psql('postgres', `select rolname from pg_roles where rolname like 'app\\_e2e\\_%'`));

const kcadm = (...args) => docker('exec', KC, '/opt/keycloak/bin/kcadm.sh', ...args, '--config', '/tmp/e2e-cleanup.cfg');
docker('exec', KC, 'sh', '-c', '/opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 --realm master --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" --config /tmp/e2e-cleanup.cfg >/dev/null');
const users = lines(kcadm('get', 'users', '-r', 'aegisops', '-q', 'username=e2e-', '--fields', 'id,username', '--format', 'csv', '--noquotes'))
  .map((l) => l.split(',')).filter(([, name]) => name?.startsWith('e2e-'));

console.log(`projects: ${projects.length}  containers: ${containers.length}  nginx routes: ${routes.length}  databases: ${databases.length}  roles: ${roles.length}  keycloak users: ${users.length}`);
if (!yes) { console.log('Nothing removed. Run again with --yes to remove these.'); process.exit(0); }

psql('aegisops', `delete from "Project" where slug like 'e2e-%'`);
for (const c of containers) docker('rm', '-f', c);
if (routes.length) {
  docker('exec', NGINX, 'sh', '-c', `rm -f ${routes.map((r) => `/etc/nginx/conf.d/managed/${r}`).join(' ')} && nginx -s reload`);
}
for (const d of databases) psql('postgres', `drop database "${d}" with (force)`);
for (const r of roles) psql('postgres', `drop role "${r}"`);
for (const [id] of users) kcadm('delete', `users/${id}`, '-r', 'aegisops');
console.log('Removed. Object-storage archives under aegisops/db/ are left for you to delete.');
