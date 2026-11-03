import 'reflect-metadata';
import { createServer } from 'node:http';
import Docker from 'dockerode';
import { ContainerCollector } from './monitoring/container-collector';

/**
 * Container exporter process (FR-MON-2). It has NO database, NO secrets and NO Docker socket: it reads the Docker API
 * through the read-only docker-proxy (GET only) and serves Prometheus metrics on an internal port. A compromise of it can
 * read container metadata and stats, nothing more.
 */
async function main() {
  const docker = new Docker({ host: process.env.DOCKER_PROXY_HOST ?? 'docker-proxy', port: Number(process.env.DOCKER_PROXY_PORT ?? 2375) });
  const collector = new ContainerCollector(docker as any, Date.now, undefined, process.env.DOCKER_NETWORK ?? 'aegisops-net');
  const intervalMs = Number(process.env.REFRESH_INTERVAL_MS ?? 10_000);

  let ready = false;
  const tick = async () => {
    try {
      await collector.refresh();
      ready = true;
    } catch (e) {
      console.error(`refresh failed: ${(e as Error).message}`);
    }
  };
  await tick();
  setInterval(tick, intervalMs).unref();

  const port = Number(process.env.PORT ?? 9102);
  createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(await collector.metrics());
    } else if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(ready ? 200 : 503).end(ready ? 'ok' : 'starting');
    } else {
      res.writeHead(404).end();
    }
  }).listen(port, '0.0.0.0', () => console.log(`container exporter listening on ${port}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
