import { api } from '@/lib/api';

type Schema = { type?: string; enum?: unknown[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; pattern?: string; format?: string; items?: Schema; properties?: Record<string, Schema> };
type Param = { name: string; in: string; required?: boolean; schema?: Schema };
type Operation = {
  summary: string; description?: string; tags: string[];
  parameters?: Param[];
  requestBody?: { content: Record<string, { schema: Schema & { required?: string[] } }> };
  responses: Record<string, { description?: string; $ref?: string }>;
  'x-roles'?: string[]; 'x-project-access'?: string; 'x-audit-action'?: string;
};
type Doc = { info: { title: string; version: string; description: string }; paths: Record<string, Record<string, Operation>>; tags: { name: string }[] };

/** A validation rule set in words: `string, 2 to 40 characters, matches ^[a-z]+$`. */
function rules(s: Schema | undefined): string {
  if (!s) return '';
  const out: string[] = [];
  const base = s.type === 'array' ? `list of ${s.items?.type ?? 'values'}` : s.type;
  if (base) out.push(s.format ? `${base} (${s.format})` : base);
  if (s.enum) out.push(`one of ${s.enum.join(', ')}`);
  if (s.minLength !== undefined || s.maxLength !== undefined) out.push(`${s.minLength ?? 0} to ${s.maxLength ?? '∞'} characters`);
  if (s.minimum !== undefined || s.maximum !== undefined) out.push(`${s.minimum ?? '−∞'} to ${s.maximum ?? '∞'}`);
  if (s.pattern) out.push(`matches ${s.pattern}`);
  return out.join(', ');
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
/** Group names as a person would say them; the document itself keeps the controller names. */
const TAG_LABEL: Record<string, string> = { Ci: 'CI deployments (API key)', Data: 'Databases and backups', Docs: 'This reference', Health: 'Health check', Infra: 'Infrastructure and logs', Users: 'Current user', Webhooks: 'GitHub webhook', Audit: 'Audit log', Deployments: 'Deployments', Projects: 'Projects, members and keys' };

/** PRD 10: the API reference, rendered from the generated OpenAPI document. Signed-in users only (the middleware and the API both enforce it). */
export default async function ApiDocsPage() {
  const doc = await api<Doc>('/openapi.json');
  const ops = Object.entries(doc.paths).flatMap(([path, byMethod]) =>
    METHODS.filter((m) => byMethod[m]).map((m) => ({ path, method: m, op: byMethod[m] })));
  const byTag = new Map<string, typeof ops>();
  for (const o of ops) byTag.set(o.op.tags[0], [...(byTag.get(o.op.tags[0]) ?? []), o]);

  return (
    <>
      <div className="row">
        <h1>{doc.info.title}</h1>
        <a className="btn" href="/api/docs/openapi.json" data-testid="openapi-download">Download openapi.json</a>
      </div>
      <p className="note">
        Version {doc.info.version}. {doc.info.description} Every operation lists the roles that may call it; the API checks the same list on every request,
        and project routes additionally need membership of that project. Generated from the running API, so it cannot disagree with it.
      </p>
      <p className="muted" data-testid="api-count">{ops.length} operations in {byTag.size} groups</p>

      {[...byTag.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([tag, list]) => (
        <div className="card" key={tag} data-testid={`api-tag-${tag}`}>
          <strong>{TAG_LABEL[tag] ?? tag}</strong>
          {list.map(({ path, method, op }) => (
            <details key={`${method} ${path}`} className="operation" data-testid={`api-op-${method}-${path}`}>
              <summary>
                <span className="method" data-method={method}>{method.toUpperCase()}</span>{' '}
                <span className="mono">{path}</span>{' '}
                <span className="muted">{op.summary}</span>
                {(op['x-roles'] ?? []).length > 0
                  ? <span className="roles">{op['x-roles']!.map((r) => <span className="role" key={r}>{r}</span>)}</span>
                  : <span className="roles"><span className="role">no user token</span></span>}
              </summary>
              <p className="note">{op.description}</p>
              {(op.parameters ?? []).length > 0 && (
                <table className="kv">
                  <thead><tr><th>Parameter</th><th>In</th><th>Required</th><th>Rules</th></tr></thead>
                  <tbody>{op.parameters!.map((p) => <tr key={`${p.in}-${p.name}`}><td className="mono">{p.name}</td><td>{p.in}</td><td>{p.required ? 'yes' : ''}</td><td className="muted">{rules(p.schema)}</td></tr>)}</tbody>
                </table>
              )}
              {op.requestBody && Object.entries(op.requestBody.content).map(([type, c]) => (
                <table className="kv" key={type}>
                  <thead><tr><th>Body field ({type})</th><th>Required</th><th>Rules</th></tr></thead>
                  <tbody>{Object.entries(c.schema.properties ?? {}).map(([name, s]) => <tr key={name}><td className="mono">{name}</td><td>{c.schema.required?.includes(name) ? 'yes' : ''}</td><td className="muted">{rules(s)}</td></tr>)}</tbody>
                </table>
              ))}
              <p className="note">Responses: {Object.keys(op.responses).join(', ')}{op['x-audit-action'] ? ` · audit action ${op['x-audit-action']}` : ''}</p>
            </details>
          ))}
        </div>
      ))}
    </>
  );
}
