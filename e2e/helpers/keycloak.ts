import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/**
 * Test users are created with kcadm INSIDE the Keycloak container: the admin API and the master realm are
 * deliberately not reachable from the internet (nginx returns 404), so a test cannot use them over HTTPS.
 * No password is ever read or printed here: the container already holds the bootstrap credentials.
 */
const CONTAINER = process.env.E2E_KEYCLOAK_CONTAINER ?? 'aegisops-keycloak';
const REALM = 'aegisops';
const KCADM = '/opt/keycloak/bin/kcadm.sh';
const CFG = '/tmp/e2e-kcadm.config';

function sh(script: string): string {
  return execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let loggedIn = false;
function login() {
  if (loggedIn) return;
  sh(
    `${KCADM} config credentials --server http://localhost:8080 --realm master ` +
      `--user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" --config ${CFG} >/dev/null`,
  );
  loggedIn = true;
}

/** Creates a throwaway user with the given realm role. A temporary password forces the real first-login flow. */
export async function createUser(role: string, opts: { temporary: boolean }) {
  login();
  const username = `e2e-${role.replace('_', '')}-${randomBytes(3).toString('hex')}`;
  const password = `Pw-${randomBytes(9).toString('base64url')}-1a`;

  sh(
    `${KCADM} create users -r ${REALM} --config ${CFG} -s username=${username} -s email=${username}@example.test ` +
      `-s enabled=true -s emailVerified=true -s firstName=E2E -s lastName=${role}`,
  );
  sh(`${KCADM} set-password -r ${REALM} --config ${CFG} --username ${username} --new-password '${password}' ${opts.temporary ? '--temporary' : ''}`);
  sh(`${KCADM} add-roles -r ${REALM} --config ${CFG} --uusername ${username} --rolename ${role}`);
  const id = sh(`${KCADM} get users -r ${REALM} --config ${CFG} -q username=${username} --fields id --format csv --noquotes`).trim();
  return { id, username, password };
}

/** Removes the user again so repeated runs leave the realm as they found it. */
export function deleteUser(id: string) {
  try {
    login();
    sh(`${KCADM} delete users/${id} -r ${REALM} --config ${CFG}`);
  } catch {
    /* best effort */
  }
}
