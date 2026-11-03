import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const compose = parse(read('infra/docker-compose.yml')) as { services: Record<string, any> };

describe('monitoring configuration (Phase 4, PRD 6.6)', () => {
  const rules = parse(read('infra/monitoring/prometheus/rules/aegisops.rules.yml')) as {
    groups: { name: string; rules: { alert: string; expr: string; labels?: Record<string, string>; annotations?: Record<string, string> }[] }[];
  };
  const alerts = rules.groups.flatMap((g) => g.rules);
  const byName = new Map(alerts.map((a) => [a.alert, a]));

  it('ships every default alert required by FR-MON-3', () => {
    for (const name of [
      'ContainerDown',            // container down > 1 min
      'DiskUsageHigh',            // disk > 85%
      'HostMemoryHigh',           // memory > 90%
      'ContainerHighMemory',
      'CertificateExpiringSoon',  // certificate within 14 days
      'RepeatedFailedLogins',     // failed logins (PRD 8)
      'BackupFailed',             // backup job failed (FR-BACKUP-5)
    ]) {
      expect(byName.has(name)).toBe(true);
    }
  });

  it('uses the thresholds the PRD names', () => {
    expect(byName.get('ContainerDown')!.expr).toContain('aegisops_container_up == 1');
    expect((byName.get('ContainerDown') as any).for).toBe('1m');
    expect(byName.get('DiskUsageHigh')!.expr).toContain('0.85');
    expect(byName.get('HostMemoryHigh')!.expr).toContain('0.90');
    expect(byName.get('CertificateExpiringSoon')!.expr).toMatch(/14 \* 86400/);
  });

  it('every rule has a severity and a human summary, and alert names are unique', () => {
    expect(new Set(alerts.map((a) => a.alert)).size).toBe(alerts.length);
    for (const a of alerts) {
      expect(a.expr.trim().length).toBeGreaterThan(0);
      expect(['critical', 'warning']).toContain(a.labels?.severity);
      expect(a.annotations?.summary).toBeTruthy();
    }
  });

  it('Prometheus scrapes the API, the container exporter, node, Keycloak and the TLS probe, and sends alerts to Alertmanager', () => {
    const cfg = parse(read('infra/monitoring/prometheus/prometheus.yml')) as any;
    const jobs = cfg.scrape_configs.map((j: any) => j.job_name);
    for (const j of ['aegisops-api', 'containers', 'node', 'keycloak', 'tls-expiry', 'loki', 'promtail']) expect(jobs).toContain(j);
    expect(cfg.alerting.alertmanagers[0].static_configs[0].targets).toContain('alertmanager:9093');
    expect(cfg.scrape_configs.find((j: any) => j.job_name === 'aegisops-api').static_configs[0].targets).toContain('api:4000');
  });

  it('managed-container labels become project/environment labels automatically (FR-MON-2)', () => {
    // the engine puts the labels on every container it launches...
    const engine = read('apps/api/src/deployments/deploy-engine.ts');
    expect(engine).toContain("'aegisops.project'");
    expect(engine).toContain("'aegisops.environment'");
    // ...the exporter turns exactly those into metric labels, and Promtail into log labels
    const collector = read('apps/api/src/monitoring/container-collector.ts');
    expect(collector).toContain("'aegisops.project'");
    expect(collector).toContain("'aegisops.environment'");
    expect(read('infra/monitoring/promtail/promtail.yml')).toContain('aegisops_project');
  });

  it('the container exporter has no host mounts, no secrets, no Docker socket, and reaches Docker only through the proxy', () => {
    const s = compose.services['container-exporter'];
    expect(s.volumes).toBeUndefined();
    expect(s.cap_drop).toContain('ALL');
    expect(s.read_only).toBe(true);
    expect(s.environment.DOCKER_PROXY_HOST).toBe('docker-proxy');
    expect(JSON.stringify(s.environment)).not.toMatch(/PASSWORD|SECRET|TOKEN|DATABASE_URL/);
    expect(compose.services.cadvisor).toBeUndefined(); // cAdvisor needed /, /sys and /var/lib/docker mounted
  });

  it('Promtail and the exporter read only the platform network (never other workloads on the host)', () => {
    const promtail = parse(read('infra/monitoring/promtail/promtail.yml')) as any;
    const sd = promtail.scrape_configs[0].docker_sd_configs[0];
    expect(sd.filters).toEqual([{ name: 'network', values: ['aegisops-net'] }]);
    expect(compose.services['container-exporter'].environment.DOCKER_NETWORK).toBe('aegisops-net');
  });

  it('Alertmanager routing is config, the channel comes from the environment and no secret is committed', () => {
    const base = parse(read('infra/monitoring/alertmanager/alertmanager.base.yml')) as any;
    expect(base.route.receiver).toBe('default');
    expect(base.route.group_by).toEqual(expect.arrayContaining(['alertname', 'project', 'environment']));
    const entry = read('infra/monitoring/alertmanager/entrypoint.sh');
    expect(entry).toContain('ALERT_SLACK_WEBHOOK_URL');
    expect(entry).toContain('api_url_file'); // the webhook URL lives in a file, not in the rendered config
    expect(entry).not.toMatch(/hooks\.slack\.com/);
    expect(compose.services.alertmanager.environment.ALERT_SLACK_WEBHOOK_URL).toContain('${');
  });

  it('every file or directory the monitoring services mount exists in the repository', () => {
    const missing: string[] = [];
    for (const n of ['prometheus', 'alertmanager', 'loki', 'promtail', 'blackbox', 'grafana']) {
      for (const v of compose.services[n].volumes as string[]) {
        const host = String(v).split(':')[0];
        if (host.startsWith('./') && !existsSync(join(root, 'infra', host))) missing.push(`${n}: ${host}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('Grafana dashboards are valid, have stable uids, and read the labels the dashboard links rely on', () => {
    const dir = join(root, 'infra/monitoring/grafana/dashboards');
    const uids: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      expect(d.uid).toMatch(/^aegisops-/);
      expect(d.panels.length).toBeGreaterThanOrEqual(2);
      uids.push(d.uid);
    }
    expect(uids.sort()).toEqual(['aegisops-env', 'aegisops-logs', 'aegisops-platform']);
    const env = JSON.parse(readFileSync(join(dir, 'aegisops-env.json'), 'utf8'));
    expect(env.templating.list.map((v: any) => v.name)).toEqual(['project', 'environment']);
  });

  it('Nginx: /metrics is a hard 404 on the public hosts, Grafana has its own TLS host, and unknown hosts are dropped', () => {
    const t = read('infra/nginx/templates/default.conf.template');
    expect((t.match(/location = \/metrics \{ return 404; \}/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(t).toContain('server_name grafana.${DOMAIN};');
    expect(t).toContain('listen 443 ssl http2 default_server');
    expect(t).toContain('return 444');
  });
});
