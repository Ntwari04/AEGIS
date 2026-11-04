import Docker from 'dockerode';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface RunSpec {
  name: string;
  image: string;
  network: string;
  env: string[];
  labels: Record<string, string>;
  memoryMb?: number | null;
  cpus?: number | null;
}

/** Everything the engine needs from Docker and Nginx, so the engine is testable and the surface is small. */
export interface DockerOps {
  pull(image: string): Promise<void>;
  run(spec: RunSpec): Promise<void>;
  /** True when GET http://<container>:<port><path> returns 2xx from inside the container network. */
  probe(container: string, port: number, path: string, network: string): Promise<boolean>;
  /** GET an arbitrary URL from inside the container network, optionally with a Host header (-k: origin certs are Cloudflare-only). */
  probeUrl(url: string, network: string, host?: string): Promise<boolean>;
  tail(container: string, lines: number): Promise<string>;
  remove(container: string): Promise<void>;
  listManaged(project: string, environment: string): Promise<string[]>;
}

export interface Router {
  /** Atomically installs a route file: write, `nginx -t`, reload. On any failure the previous file is restored and this throws. */
  apply(fileName: string, content: string): Promise<void>;
  remove(fileName: string): Promise<void>;
}

const PROBE_IMAGE = 'curlimages/curl:8.11.0';

export class DockerodeOps implements DockerOps {
  constructor(
    private readonly docker = new Docker(),
    private readonly registryAuth?: { username: string; password: string; serveraddress: string },
    /** Tests only: use an image already present locally instead of pulling. */
    private readonly allowLocalImages = false,
  ) {}

  async pull(image: string) {
    if (this.allowLocalImages && (await this.hasImage(image))) return;
    const auth = this.registryAuth && image.startsWith(`${this.registryAuth.serveraddress}/`) ? this.registryAuth : undefined;
    await this.pullImage(image, auth);
  }

  private pullImage(image: string, authconfig?: object) {
    return new Promise<void>((resolve, reject) => {
      this.docker.pull(image, { authconfig }, (err: Error | null, stream?: NodeJS.ReadableStream) => {
        if (err || !stream) return reject(err ?? new Error("no pull stream"));
        this.docker.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve()));
      });
    });
  }

  /** Images built/loaded locally (tests, air-gapped hosts) need no pull. */
  async hasImage(image: string) {
    return this.docker.getImage(image).inspect().then(() => true, () => false);
  }

  async run(s: RunSpec) {
    const c = await this.docker.createContainer({
      name: s.name,
      Image: s.image,
      Env: s.env,
      Labels: s.labels,
      HostConfig: {
        NetworkMode: s.network,
        RestartPolicy: { Name: 'unless-stopped' },
        // Hardening defaults for deployed apps: no new privileges, no Linux capabilities.
        SecurityOpt: ['no-new-privileges:true'],
        CapDrop: ['ALL'],
        ...(s.memoryMb ? { Memory: s.memoryMb * 1024 * 1024 } : {}),
        ...(s.cpus ? { NanoCpus: Math.round(s.cpus * 1e9) } : {}),
      },
    });
    await c.start();
  }

  probe(container: string, port: number, path: string, network: string) {
    return this.probeUrl(`http://${container}:${port}${path}`, network);
  }

  async probeUrl(url: string, network: string, host?: string) {
    if (!(await this.hasImage(PROBE_IMAGE))) await this.pullImage(PROBE_IMAGE);
    const p = await this.docker.createContainer({
      Image: PROBE_IMAGE,
      Cmd: ['-fsSk', '--max-time', '3', '-o', '/dev/null', ...(host ? ['-H', `Host: ${host}`] : []), url],
      HostConfig: { NetworkMode: network, AutoRemove: false, CapDrop: ['ALL'] },
    });
    try {
      await p.start();
      const { StatusCode } = await p.wait();
      return StatusCode === 0;
    } finally {
      await p.remove({ force: true }).catch(() => undefined);
    }
  }

  async tail(container: string, lines: number) {
    try {
      const buf = (await this.docker.getContainer(container).logs({ stdout: true, stderr: true, tail: lines })) as Buffer;
      // Strip the 8-byte multiplex headers that Docker adds for non-TTY containers.
      const out: string[] = [];
      let i = 0;
      while (i + 8 <= buf.length) {
        const len = buf.readUInt32BE(i + 4);
        out.push(buf.subarray(i + 8, i + 8 + len).toString('utf8'));
        i += 8 + len;
      }
      return out.join('');
    } catch {
      return '';
    }
  }

  async remove(container: string) {
    await this.docker.getContainer(container).remove({ force: true }).catch((e: { statusCode?: number }) => {
      if (e.statusCode !== 404) throw e;
    });
  }

  async listManaged(project: string, environment: string) {
    const list = await this.docker.listContainers({
      all: true,
      filters: { label: ['aegisops.managed=true', `aegisops.project=${project}`, `aegisops.environment=${environment}`] },
    });
    return list.map((c) => c.Names[0].replace(/^\//, ''));
  }

  // ---- container controls (FR-INFRA-2). Names are resolved by the caller from the database or a fixed allowlist, never from a request. ----

  async labelsOf(name: string): Promise<Record<string, string> | null> {
    try {
      return (await this.docker.getContainer(name).inspect()).Config.Labels ?? {};
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return null;
      throw e;
    }
  }

  async control(name: string, action: 'start' | 'stop' | 'restart') {
    const c = this.docker.getContainer(name);
    try {
      if (action === 'start') await c.start();
      else if (action === 'stop') await c.stop({ t: 10 });
      else await c.restart({ t: 10 });
    } catch (e) {
      // 304 = already in that state: starting a running container or stopping a stopped one is not an error.
      if ((e as { statusCode?: number }).statusCode !== 304) throw e;
    }
  }

  async listManagedRunning() {
    const list = await this.docker.listContainers({ filters: { label: ['aegisops.managed=true'], status: ['running'] } });
    return list.map((c) => c.Names[0].replace(/^\//, ''));
  }

  get raw() {
    return this.docker;
  }
}

export class NginxRouter implements Router {
  constructor(private readonly docker: Docker, private readonly confDir: string, private readonly nginxContainer: string) {}

  private async exec(cmd: string[]) {
    const c = this.docker.getContainer(this.nginxContainer);
    const ex = await c.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
    const stream = await ex.start({});
    let out = '';
    await new Promise<void>((resolve) => {
      stream.on('data', (d: Buffer) => (out += d.toString('utf8')));
      stream.on('end', resolve);
    });
    const { ExitCode } = await ex.inspect();
    return { code: ExitCode ?? 1, out };
  }

  async remove(fileName: string) {
    await fs.rm(join(this.confDir, fileName), { force: true });
    const r = await this.exec(['nginx', '-s', 'reload']);
    if (r.code !== 0) throw new Error('nginx reload failed');
  }

  async apply(fileName: string, content: string) {
    const target = join(this.confDir, fileName);
    const previous = await fs.readFile(target, 'utf8').catch(() => null);
    await fs.writeFile(target, content, { mode: 0o644 });
    try {
      const test = await this.exec(['nginx', '-t']);
      if (test.code !== 0) throw new Error(`nginx -t failed: ${test.out.replace(/[^\x20-\x7e\n]/g, '').slice(-300)}`);
      const reload = await this.exec(['nginx', '-s', 'reload']);
      if (reload.code !== 0) throw new Error('nginx reload failed');
    } catch (e) {
      if (previous === null) await fs.rm(target, { force: true });
      else await fs.writeFile(target, previous);
      await this.exec(['nginx', '-s', 'reload']).catch(() => undefined);
      throw e;
    }
  }
}
