/**
 * Renders the per-environment Nginx server block (PRD FR-DEPLOY-2). Every interpolated value is
 * validated against a strict pattern first, so a project name, domain or container name can never
 * inject Nginx directives.
 */
const SLUG = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export interface RouteSpec {
  projectSlug: string;
  environment: string;
  domain: string;
  containerName: string;
  port: number;
  /** false only in tests, where there are no certificates. */
  tls?: boolean;
}

export function routeFileName(projectSlug: string, environment: string): string {
  if (!SLUG.test(projectSlug) || !SLUG.test(environment)) throw new Error('invalid project or environment name');
  return `project-${projectSlug}-${environment}.conf`;
}

export function renderRoute(spec: RouteSpec): string {
  routeFileName(spec.projectSlug, spec.environment);
  if (!DOMAIN.test(spec.domain)) throw new Error('invalid domain');
  if (!CONTAINER.test(spec.containerName)) throw new Error('invalid container name');
  if (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535) throw new Error('invalid port');
  const tls = spec.tls !== false;

  const proxy = `
    set $upstream http://${spec.containerName}:${spec.port};
    location / {
        proxy_pass $upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }`;

  const header = `# Managed by AegisOps — generated for ${spec.projectSlug}/${spec.environment}. Do not edit by hand.\n`;
  if (!tls) {
    return `${header}server {
    listen 80;
    server_name ${spec.domain};${proxy}
}
`;
  }
  return `${header}server {
    listen 80;
    server_name ${spec.domain};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${spec.domain};

    ssl_certificate     /etc/nginx/certs/cert.pem;
    ssl_certificate_key /etc/nginx/certs/key.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
${proxy}
}
`;
}
