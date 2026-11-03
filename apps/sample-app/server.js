// Minimal app used to prove the deployment pipeline end to end (health gate, rollback, routing).
const http = require('node:http');
const fs = require('node:fs');

const PORT = Number(process.env.PORT || 3000);
const VERSION = process.env.AEGIS_COMMIT || 'dev';

// "ok" or "broken". Committing "broken" to health.flag is how you rehearse a bad deploy.
function healthy() {
  const flag = process.env.HEALTH_OVERRIDE || fs.readFileSync(`${__dirname}/health.flag`, 'utf8').trim();
  return flag === 'ok';
}

http.createServer((req, res) => {
  if (req.url === '/healthz') {
    const ok = healthy();
    res.writeHead(ok ? 200 : 500, { 'Content-Type': 'text/plain' });
    return res.end(ok ? 'ok\n' : 'broken\n');
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`AegisOps sample app, version ${VERSION}\n`);
}).listen(PORT, '0.0.0.0', () => console.log(`listening on ${PORT} (version ${VERSION})`));

// build marker: v3 (broken-health rehearsal)
