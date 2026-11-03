import { createVerify, generateKeyPairSync } from 'node:crypto';
import { GitHubApp, GitHubDeployReporter, type DeploymentContext } from './github-app';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, // GitHub issues PKCS#1 ("BEGIN RSA PRIVATE KEY")
});

const ctx: DeploymentContext = {
  repo: 'o/r', sha: 'a'.repeat(40), environment: 'staging', isProduction: false, environmentUrl: 'https://x.example.com',
};

function makeApp(handler: (url: string, init: any) => { status: number; body?: unknown }, now = () => 1_700_000_000_000) {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body } as any;
  }) as typeof fetch;
  return { app: new GitHubApp({ appId: '123', installationId: '456', privateKeyPem: privateKey, fetchImpl, now }), calls };
}

const tokenOk = { status: 201, body: { token: 'ghs_installtoken', expires_at: new Date(1_700_000_000_000 + 3600_000).toISOString() } };
const isTokenCall = (url: string) => url.includes('access_tokens');

describe('GitHubApp', () => {
  it('signs an RS256 app JWT that verifies against the public key, with a <10 min lifetime', () => {
    const { app } = makeApp(() => tokenOk);
    const [h, p, s] = app.appJwt().split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(claims.iss).toBe('123');
    expect(claims.exp - Math.floor(1_700_000_000_000 / 1000)).toBeLessThanOrEqual(600);
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('caches the installation token until a minute before expiry', async () => {
    let t = 1_700_000_000_000;
    const { app, calls } = makeApp(() => tokenOk, () => t);
    expect(await app.installationToken()).toBe('ghs_installtoken');
    await app.installationToken();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/app/installations/456/access_tokens');
    expect(calls[0].init.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    t += 3600_000 - 30_000; // inside the 60s refresh window
    await app.installationToken();
    expect(calls).toHaveLength(2);
  });

  it('repoAccessible matches only repositories the installation covers (case-insensitive), not any public repo', async () => {
    const list = (names: string[]) => ({ status: 200, body: { repositories: names.map((full_name) => ({ full_name })) } });
    const { app, calls } = makeApp((url) => (isTokenCall(url) ? tokenOk : list(['Acme/App', 'acme/other'])));
    expect(await app.repoAccessible('acme/app')).toBe(true);
    expect(await app.repoAccessible('octocat/Hello-World')).toBe(false); // exists and is public, but not installed
    expect(calls.some((c) => c.url.includes('/installation/repositories'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/repos/'))).toBe(false);
  });

  it('repoAccessible pages through large installations and surfaces API failures', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ full_name: 'o/r' + i }));
    const { app } = makeApp((url) =>
      isTokenCall(url) ? tokenOk : url.endsWith('&page=1') ? { status: 200, body: { repositories: full } } : { status: 200, body: { repositories: [{ full_name: 'o/last' }] } },
    );
    expect(await app.repoAccessible('o/last')).toBe(true);
    const { app: broken } = makeApp((url) => (isTokenCall(url) ? tokenOk : { status: 500 }));
    await expect(broken.repoAccessible('o/r')).rejects.toThrow('500');
  });

  it('uses the installation token (not the app JWT) for repository calls', async () => {
    const { app, calls } = makeApp((url) => (isTokenCall(url) ? tokenOk : { status: 200, body: { repositories: [] } }));
    await app.repoAccessible('o/r');
    expect(calls[1].init.headers.Authorization).toBe('Bearer ghs_installtoken');
  });

  it('creates a deployment then posts statuses with environment and log urls', async () => {
    const { app, calls } = makeApp((url) =>
      isTokenCall(url) ? tokenOk : url.endsWith('/deployments') ? { status: 201, body: { id: 77 } } : { status: 201 },
    );
    const id = await app.createDeployment(ctx);
    expect(id).toBe(77);
    await app.setDeploymentState({ ...ctx, logUrl: 'https://d.example.com/l' }, id, 'success', 'ok');
    const dep = JSON.parse(calls[1].init.body);
    expect(dep).toMatchObject({ ref: ctx.sha, environment: 'staging', auto_merge: false, required_contexts: [], production_environment: false });
    const st = JSON.parse(calls[2].init.body);
    expect(st).toMatchObject({ state: 'success', environment_url: 'https://x.example.com', log_url: 'https://d.example.com/l' });
    expect(calls[2].url).toContain('/repos/o/r/deployments/77/statuses');
  });

  it('fromEnv is null unless the App is fully configured', () => {
    expect(GitHubApp.fromEnv({})).toBeNull();
    expect(GitHubApp.fromEnv({ GITHUB_APP_ID: '0', GITHUB_INSTALLATION_ID: '0', GITHUB_APP_PRIVATE_KEY_PATH: '/x' })).toBeNull();
    expect(GitHubApp.fromEnv({ GITHUB_APP_ID: '1', GITHUB_INSTALLATION_ID: '2' })).toBeNull();
  });
});

describe('GitHubDeployReporter', () => {
  it('never throws: GitHub failures only produce warnings, so a deploy cannot fail because of reporting', async () => {
    const { app } = makeApp(() => ({ status: 500 }));
    const warnings: string[] = [];
    const rep = new GitHubDeployReporter(app, (m) => warnings.push(m));
    const handle = await rep.started(ctx);
    expect(handle).toBeUndefined();
    await expect(rep.finished(handle, ctx, 'success', 'x')).resolves.toBeUndefined();
    await expect(rep.finished(123, ctx, 'failure', 'x')).resolves.toBeUndefined();
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  });
});
