import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const GITHUB_APP = Symbol('GITHUB_APP');

export interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export type GitHubDeploymentState = 'in_progress' | 'success' | 'failure' | 'error';

export interface DeploymentContext {
  repo: string; // owner/repo
  sha: string;
  environment: string;
  isProduction: boolean;
  environmentUrl?: string;
  logUrl?: string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/**
 * GitHub App client (FR-PROJ-2): the platform authenticates AS THE APP, never with a personal access token.
 * App JWT (RS256, 9 min) -> installation access token (cached until 1 min before expiry) -> API calls scoped
 * to the repositories the App is installed on. The private key is read from a mounted file, never from env/logs.
 */
export class GitHubApp {
  private readonly cfg: Required<Omit<GitHubAppConfig, 'now'>> & { now: () => number };
  private token?: { value: string; expiresAt: number };

  constructor(cfg: GitHubAppConfig) {
    this.cfg = { apiBase: 'https://api.github.com', fetchImpl: fetch, now: Date.now, ...cfg } as any;
  }

  /** Returns null (feature off) when the App is not configured; throws if it is configured but the key is unreadable. */
  static fromEnv(source: NodeJS.ProcessEnv = process.env): GitHubApp | null {
    const { GITHUB_APP_ID: appId, GITHUB_INSTALLATION_ID: installationId, GITHUB_APP_PRIVATE_KEY_PATH: path } = source;
    if (!appId || appId === '0' || !installationId || installationId === '0' || !path) return null;
    return new GitHubApp({ appId, installationId, privateKeyPem: readFileSync(path, 'utf8') });
  }

  /** RS256 JWT identifying the App itself (valid <= 10 minutes; iat backdated 60s for clock skew). */
  appJwt(): string {
    const iat = Math.floor(this.cfg.now() / 1000) - 60;
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify({ iat, exp: iat + 9 * 60 + 60, iss: this.cfg.appId }));
    const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(this.cfg.privateKeyPem);
    return `${head}.${body}.${b64url(sig)}`;
  }

  private async call(path: string, init: RequestInit & { auth: 'app' | 'installation' }) {
    const { auth, ...rest } = init;
    const bearer = auth === 'app' ? this.appJwt() : await this.installationToken();
    return this.cfg.fetchImpl(`${this.cfg.apiBase}${path}`, {
      ...rest,
      signal: AbortSignal.timeout(8_000),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'aegisops',
        Authorization: `Bearer ${bearer}`,
        ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  }

  async installationToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.cfg.now()) return this.token.value;
    const res = await this.call(`/app/installations/${encodeURIComponent(this.cfg.installationId)}/access_tokens`, { method: 'POST', auth: 'app' });
    if (!res.ok) throw new Error(`GitHub installation token request failed (${res.status})`);
    const body = (await res.json()) as { token: string; expires_at: string };
    this.token = { value: body.token, expiresAt: Date.parse(body.expires_at) };
    return body.token;
  }

  /** True when the App installation can see this repository (so the project can be linked to it). */
  async repoAccessible(fullName: string): Promise<boolean> {
    const res = await this.call(`/repos/${fullName}`, { auth: 'installation' });
    if (res.status === 200) return true;
    if (res.status === 404 || res.status === 403) return false;
    throw new Error(`GitHub repository check failed (${res.status})`);
  }

  /** Creates a GitHub Deployment for the commit and returns its id; later updated with {@link setDeploymentState}. */
  async createDeployment(ctx: DeploymentContext): Promise<number> {
    const res = await this.call(`/repos/${ctx.repo}/deployments`, {
      method: 'POST', auth: 'installation',
      body: JSON.stringify({
        ref: ctx.sha, environment: ctx.environment, auto_merge: false, required_contexts: [],
        production_environment: ctx.isProduction, transient_environment: !ctx.isProduction,
        description: 'AegisOps deployment',
      }),
    });
    if (res.status !== 201) throw new Error(`GitHub create deployment failed (${res.status})`);
    return ((await res.json()) as { id: number }).id;
  }

  async setDeploymentState(ctx: DeploymentContext, deploymentId: number, state: GitHubDeploymentState, description: string) {
    const res = await this.call(`/repos/${ctx.repo}/deployments/${deploymentId}/statuses`, {
      method: 'POST', auth: 'installation',
      body: JSON.stringify({
        state, description: description.slice(0, 140),
        ...(ctx.environmentUrl ? { environment_url: ctx.environmentUrl } : {}),
        ...(ctx.logUrl ? { log_url: ctx.logUrl } : {}),
      }),
    });
    if (res.status !== 201) throw new Error(`GitHub deployment status failed (${res.status})`);
  }
}

/**
 * What the deploy engine calls. Reporting to GitHub is a courtesy: every method swallows its own errors, so
 * a GitHub outage or a missing permission can never fail or roll back a deployment.
 */
export interface DeployReporter {
  started(ctx: DeploymentContext): Promise<unknown>;
  finished(handle: unknown, ctx: DeploymentContext, state: GitHubDeploymentState, description: string): Promise<void>;
}

export class GitHubDeployReporter implements DeployReporter {
  constructor(private readonly app: GitHubApp, private readonly warn: (m: string) => void = () => undefined) {}

  async started(ctx: DeploymentContext) {
    try {
      const id = await this.app.createDeployment(ctx);
      await this.app.setDeploymentState(ctx, id, 'in_progress', 'Deployment started');
      return id;
    } catch (e) {
      this.warn(`GitHub deployment report (start) skipped: ${(e as Error).message}`);
      return undefined;
    }
  }

  async finished(handle: unknown, ctx: DeploymentContext, state: GitHubDeploymentState, description: string) {
    if (typeof handle !== 'number') return;
    try {
      await this.app.setDeploymentState(ctx, handle, state, description);
    } catch (e) {
      this.warn(`GitHub deployment report (finish) skipped: ${(e as Error).message}`);
    }
  }
}
