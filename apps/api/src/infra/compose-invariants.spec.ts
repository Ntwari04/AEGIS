import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const compose = parse(read('infra/docker-compose.yml')) as { services: Record<string, any> };

describe('infra/docker-compose.yml security invariants (PRD 8.3, 8.6, 8.7)', () => {
  it('only nginx publishes ports to the host', () => {
    const published = Object.entries(compose.services).filter(([, s]) => s.ports).map(([n]) => n);
    expect(published).toEqual(['nginx']);
  });

  it('only the deployer and the read-only docker-proxy mount the Docker socket (never api, web, nginx, or any monitoring service)', () => {
    const mounting = Object.entries(compose.services)
      .filter(([, s]) => (s.volumes ?? []).some((v: string) => String(v).includes('docker.sock')))
      .map(([n]) => n);
    expect(mounting.sort()).toEqual(['deployer', 'docker-proxy']);
    expect(compose.services.deployer.ports).toBeUndefined();
    expect(compose.services.deployer.cap_drop).toContain('ALL');

    // The proxy is how cAdvisor and Promtail see Docker: read-only mount, and no write (POST) or management API enabled.
    const proxy = compose.services['docker-proxy'];
    expect((proxy.volumes as string[]).find((v) => v.includes('docker.sock'))).toMatch(/:ro$/);
    expect(proxy.ports).toBeUndefined();
    expect(String(proxy.environment.POST)).toBe('0');
    for (const k of ['IMAGES', 'VOLUMES', 'EXEC', 'SECRETS', 'SERVICES', 'BUILD', 'COMMIT', 'SYSTEM', 'AUTH']) {
      expect(String(proxy.environment[k])).toBe('0');
    }
  });

  it('monitoring services never publish ports and all join aegisops-net (reachable only internally or through Nginx)', () => {
    for (const n of ['prometheus', 'alertmanager', 'loki', 'promtail', 'container-exporter', 'node-exporter', 'blackbox', 'grafana', 'docker-proxy']) {
      expect(compose.services[n]).toBeDefined();
      expect(compose.services[n].ports).toBeUndefined();
      expect(compose.services[n].networks).toContain('aegisops-net');
    }
  });

  it('Grafana: local login form off, anonymous off, SSO on with strict role mapping (developers are refused)', () => {
    const env = compose.services.grafana.environment;
    expect(env.GF_AUTH_DISABLE_LOGIN_FORM).toBe('true');
    expect(env.GF_AUTH_ANONYMOUS_ENABLED).toBe('false');
    expect(env.GF_USERS_ALLOW_SIGN_UP).toBe('false');
    expect(env.GF_AUTH_GENERIC_OAUTH_ENABLED).toBe('true');
    expect(env.GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_STRICT).toBe('true');
    expect(env.GF_AUTH_GENERIC_OAUTH_ROLE_ATTRIBUTE_PATH).not.toMatch(/developer/);
    expect(env.GF_AUTH_GENERIC_OAUTH_USE_PKCE).toBe('true');
  });

  it('no service uses network_mode: host or privileged mode', () => {
    for (const s of Object.values(compose.services)) {
      expect(s.network_mode).toBeUndefined();
      expect(s.privileged).toBeUndefined();
    }
  });

  it('every credential-like environment value is a ${VAR} reference, never a literal', () => {
    const secretKey = /PASSWORD|SECRET|TOKEN|_KEY$/i;
    for (const [name, s] of Object.entries(compose.services)) {
      for (const [k, v] of Object.entries(s.environment ?? {})) {
        if (secretKey.test(k) && !/_URL$/.test(k) && !/^(true|false|0|1)$/.test(String(v))) {
          expect({ name, k, ok: String(v).includes('${') }).toEqual({ name, k, ok: true });
        }
      }
    }
  });

  it('DATABASE_URL / REDIS_URL passwords come from variables', () => {
    const api = compose.services.api.environment;
    expect(api.DATABASE_URL).toContain('${AEGISOPS_DB_PASSWORD}');
    expect(api.REDIS_URL).toContain('${REDIS_PASSWORD}');
  });

  it('postgres, redis, keycloak, api and web all join aegisops-net', () => {
    for (const n of ['postgres', 'redis', 'keycloak', 'api', 'web']) {
      expect(compose.services[n].networks).toContain('aegisops-net');
    }
  });

  it('third-party images are version-pinned (no :latest / untagged)', () => {
    for (const s of Object.values(compose.services)) {
      if (s.image && !s.build) expect(s.image).toMatch(/:[\w.-]+$/);
      if (s.image && !s.build) expect(s.image).not.toMatch(/:latest$/);
    }
  });

  it('app containers have a read-only root filesystem', () => {
    expect(compose.services.api.read_only).toBe(true);
    expect(compose.services.web.read_only).toBe(true);
  });

  it('the dev override only binds to 127.0.0.1', () => {
    const dev = parse(read('infra/docker-compose.dev.yml')) as { services: Record<string, any> };
    for (const s of Object.values(dev.services)) {
      for (const p of s.ports ?? []) expect(String(p)).toMatch(/^127\.0\.0\.1:/);
    }
  });

  it('.env files are gitignored and .env.example holds placeholders only', () => {
    expect(read('.gitignore')).toMatch(/^\.env$/m);
    expect(read('infra/.gitignore')).toMatch(/^\.env$/m);
    const example = read('infra/.env.example');
    for (const line of example.split('\n')) {
      const m = line.match(/^([A-Z_]*(PASSWORD|SECRET)[A-Z_]*)=(.*)$/);
      if (m) expect(m[3]).toBe('CHANGE_ME');
    }
  });

  it('Dockerfiles run as a non-root user', () => {
    for (const f of ['apps/api/Dockerfile', 'apps/web/Dockerfile']) {
      expect(read(f)).toMatch(/^USER node$/m);
    }
  });

  it('the realm file contains no literal secrets', () => {
    const realm = JSON.parse(read('infra/keycloak/realm-aegisops.json'));
    expect(realm.clients[0].secret).toBe('${KEYCLOAK_CLIENT_SECRET}');
  });
});
