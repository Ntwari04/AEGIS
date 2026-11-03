import { createHmac } from 'node:crypto';
import { verifyGithubSignature, imageRepoFor } from './github';
import { renderRoute, routeFileName } from './nginx-config';

const sign = (secret: string, body: Buffer) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('verifyGithubSignature', () => {
  const body = Buffer.from('{"action":"completed"}');
  it('accepts a correct signature', () => expect(verifyGithubSignature('s3cret', body, sign('s3cret', body))).toBe(true));
  it('rejects a wrong secret', () => expect(verifyGithubSignature('s3cret', body, sign('other', body))).toBe(false));
  it('rejects a tampered body', () => expect(verifyGithubSignature('s3cret', Buffer.from('{"action":"x"}'), sign('s3cret', body))).toBe(false));
  it('rejects missing / malformed / wrong-length headers without throwing', () => {
    for (const h of [undefined, '', 'sha256=', 'sha1=abc', 'sha256=zz', 'sha256=abcd']) {
      expect(verifyGithubSignature('s3cret', body, h)).toBe(false);
    }
  });
});

describe('imageRepoFor', () => {
  it('lowercases the project repo for GHCR', () => {
    expect(imageRepoFor({ project: { githubRepo: 'Ntwari04/AEGIS' } })).toBe('ghcr.io/ntwari04/aegis');
  });
  it('prefers an explicit imageRepo', () => {
    expect(imageRepoFor({ imageRepo: 'ghcr.io/Org/App', project: { githubRepo: 'x/y' } })).toBe('ghcr.io/org/app');
  });
  it('returns null when nothing is configured', () => expect(imageRepoFor({})).toBeNull());
});

describe('nginx route rendering (injection safety)', () => {
  const ok = { projectSlug: 'billing', environment: 'production', domain: 'billing.example.com', containerName: 'aegis-billing-production-abc12345', port: 3000 };

  it('renders TLS + redirect blocks pointing at the container', () => {
    const c = renderRoute(ok);
    expect(c).toContain('server_name billing.example.com;');
    expect(c).toContain('set $upstream http://aegis-billing-production-abc12345:3000;');
    expect(c).toContain('listen 443 ssl');
    expect(c).toContain('return 301 https://');
  });
  it('names files deterministically per project+environment', () => {
    expect(routeFileName('billing', 'production')).toBe('project-billing-production.conf');
  });
  it.each([
    ['domain with directive', { domain: 'a.com; return 200 x' }],
    ['domain with newline', { domain: 'a.com\nserver {}' }],
    ['domain with brace', { domain: 'a.com}' }],
    ['container with semicolon', { containerName: 'x; evil' }],
    ['container with space', { containerName: 'x y' }],
    ['port zero', { port: 0 }],
    ['non-integer port', { port: 80.5 }],
    ['slug traversal', { projectSlug: '../etc' }],
    ['uppercase env', { environment: 'Prod' }],
  ])('refuses %s', (_n, patch) => {
    expect(() => renderRoute({ ...ok, ...patch })).toThrow();
  });
});
