import 'reflect-metadata';
import { getMetadataStorage } from 'class-validator';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA, HEADERS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { IS_PUBLIC, PROJECT_ACCESS, ROLES_KEY } from '../auth/decorators';
import { AUDIT_SPEC, type AuditSpec } from '../audit/audit.interceptor';

/**
 * The OpenAPI document (PRD 10) is built from what the API actually enforces, not from a second set of annotations that could drift:
 * the route and parameter metadata Nest already holds, our own @Roles / @Public / @ProjectAccess / @Audited decorators, and the
 * class-validator rules on the DTOs. If a route exists it is documented, and the roles shown are the roles the guard checks.
 */
type Json = Record<string, unknown>;
type Ctor = new (...args: never[]) => unknown;

// Nest's RouteParamtypes (an internal enum): the ones this document needs.
const BODY = 3, QUERY = 4, PARAM = 5, HEADERS = 6;
const METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'get', [RequestMethod.POST]: 'post', [RequestMethod.PUT]: 'put', [RequestMethod.DELETE]: 'delete', [RequestMethod.PATCH]: 'patch',
};
const ALL_ROLES = ['platform_admin', 'devops_engineer', 'developer', 'auditor'];

/** class-validator rules on a DTO class, as a JSON Schema. Unknown rules are left out rather than guessed at. */
export function schemaOf(cls: Ctor): { schema: Json; required: string[] } {
  const rules = getMetadataStorage().getTargetValidationMetadatas(cls as never, '', true, false);
  const props = new Map<string, Json>();
  const optional = new Set<string>();
  for (const r of rules) {
    const prop = r.propertyName;
    const s = props.get(prop) ?? {};
    props.set(prop, s);
    if (r.type === 'conditionalValidation') { optional.add(prop); continue; }
    const c = (r.constraints ?? []) as unknown[];
    const target = r.each ? ((s.items as Json | undefined) ?? (s.items = {}), s.type = 'array', s.items as Json) : s;
    switch (r.name) {
      case 'isString': target.type = 'string'; break;
      case 'isInt': target.type = 'integer'; break;
      case 'isNumber': target.type = 'number'; break;
      case 'isBoolean': target.type = 'boolean'; break;
      case 'isArray': s.type = 'array'; break;
      case 'isDateString': target.type = 'string'; target.format = 'date-time'; break;
      case 'isUuid': target.type = 'string'; target.format = 'uuid'; break;
      case 'isEmail': target.type = 'string'; target.format = 'email'; break;
      case 'isIn': target.enum = c[0]; break;
      case 'isLength': target.minLength = c[0]; if (c[1] !== undefined) target.maxLength = c[1]; break;
      case 'minLength': target.minLength = c[0]; break;
      case 'maxLength': target.maxLength = c[0]; break;
      case 'min': target.minimum = c[0]; break;
      case 'max': target.maximum = c[0]; break;
      case 'matches': target.type ??= 'string'; target.pattern = c[0] instanceof RegExp ? c[0].source : String(c[0]); break;
      default: break;
    }
  }
  const properties: Json = {};
  for (const [k, v] of props) properties[k] = v;
  return { schema: { type: 'object', properties, additionalProperties: false }, required: [...props.keys()].filter((k) => !optional.has(k)) };
}

const humanize = (name: string) => name.replace(/([A-Z])/g, ' $1').toLowerCase().replace(/^./, (c) => c.toUpperCase());

const NOUNS: Record<string, string> = { apikey: 'API key', api_key: 'API key', ci: 'CI' };
const cap = (s: string) => s.replace(/^./, (c) => c.toUpperCase());

/**
 * What a person reads in the list: "Create API key", "Add project member". Audited routes have a dotted action (`project.member.add`)
 * whose last word is the verb, so it is turned around; anything else falls back to the handler's name.
 */
export function summaryOf(auditAction: string | undefined, handler: string): string {
  if (!auditAction) return humanize(handler);
  if (auditAction === 'auth.session_revoked') return 'End my session (sign out everywhere)';
  const words = auditAction.split('.');
  const verb = words[words.length - 1];
  const noun = words.slice(0, -1).map((w) => NOUNS[w] ?? w.replace(/_/g, ' ')).join(' ');
  return cap(`${verb} ${noun}`);
}
const joinPath = (...parts: string[]) => '/' + parts.map((p) => p.replace(/^\/|\/$/g, '')).filter(Boolean).join('/');
const toOpenApiPath = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

export interface RouteInfo { controller: string; handler: string; method: string; path: string; roles: string[]; public: boolean }

/** Every route of the given controllers: also what the "every route declares authorization" test iterates. */
export function routesOf(controllers: Ctor[]): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const ctrl of controllers) {
    const base: string = Reflect.getMetadata(PATH_METADATA, ctrl) ?? '';
    for (const name of Object.getOwnPropertyNames(ctrl.prototype).filter((n) => n !== 'constructor')) {
      const handler = (ctrl.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler);
      if (method === undefined || METHODS[method as number] === undefined) continue;
      out.push({
        controller: ctrl.name, handler: name, method: METHODS[method as number],
        path: joinPath(base, Reflect.getMetadata(PATH_METADATA, handler) ?? ''),
        roles: Reflect.getMetadata(ROLES_KEY, handler) ?? [], public: Reflect.getMetadata(IS_PUBLIC, handler) === true,
      });
    }
  }
  return out;
}

export function buildOpenApi(controllers: Ctor[], opts: { version?: string } = {}): Json {
  const paths: Record<string, Record<string, Json>> = {};
  const tags = new Set<string>();

  for (const ctrl of controllers) {
    const tag = ctrl.name.replace(/Controller$/, '');
    for (const r of routesOf([ctrl])) {
      const handler = (ctrl.prototype as Record<string, unknown>)[r.handler] as object;
      const params: Json[] = [];
      let requestBody: Json | undefined;
      let apiKey = false;

      const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, ctrl, r.handler) ?? {}) as Record<string, { index: number; data?: string }>;
      const types = (Reflect.getMetadata('design:paramtypes', ctrl.prototype, r.handler) ?? []) as Ctor[];
      for (const [key, arg] of Object.entries(args)) {
        const kind = Number(key.split(':')[0]);
        const dto = types[arg.index];
        if (kind === PARAM && arg.data) params.push({ name: arg.data, in: 'path', required: true, schema: { type: 'string' } });
        else if (kind === HEADERS && arg.data) {
          if (arg.data.toLowerCase() === 'x-api-key') apiKey = true;
          else params.push({ name: arg.data, in: 'header', required: false, schema: { type: 'string' } });
        } else if (kind === QUERY && dto && dto !== Object) {
          const { schema, required } = schemaOf(dto);
          for (const [name, s] of Object.entries(schema.properties as Json)) params.push({ name, in: 'query', required: required.includes(name), schema: s });
        } else if (kind === BODY && dto && dto !== Object) {
          const { schema, required } = schemaOf(dto);
          requestBody = { required: true, content: { 'application/json': { schema: { ...schema, ...(required.length ? { required } : {}) } } } };
        }
      }

      const audit = Reflect.getMetadata(AUDIT_SPEC, handler) as AuditSpec | undefined;
      const access = Reflect.getMetadata(PROJECT_ACCESS, handler) as string | undefined;
      const customStatus = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined;
      const status = customStatus ?? (r.method === 'post' ? 201 : 200);
      const headers = (Reflect.getMetadata(HEADERS_METADATA, handler) ?? []) as { name: string; value: string }[];
      const contentType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value.split(';')[0];

      const notes: string[] = [];
      if (r.public) notes.push(apiKey ? 'Authenticated with an API key (X-API-Key), not a user token.' : 'Public: authenticated by something other than a user token (for example a signed webhook).');
      else notes.push(`Roles: ${r.roles.join(', ')}.`);
      if (access) notes.push(`Project access: ${access}. A non-member gets 404, so a project's existence is not disclosed.`);
      if (audit) notes.push(`Recorded in the audit log as ${audit.action}.`);

      const operation: Json = {
        operationId: `${r.controller.replace(/Controller$/, '')}_${r.handler}`,
        tags: [tag],
        summary: summaryOf(audit?.action, r.handler),
        description: notes.join(' '),
        'x-roles': r.public ? [] : r.roles,
        ...(access ? { 'x-project-access': access } : {}),
        ...(audit ? { 'x-audit-action': audit.action } : {}),
        ...(r.public ? (apiKey ? { security: [{ apiKey: [] }] } : { security: [] }) : { security: [{ bearerAuth: [] }] }),
        ...(params.length ? { parameters: params } : {}),
        ...(requestBody ? { requestBody } : {}),
        responses: {
          [status]: status === 204 ? { description: 'No content' } : { description: 'Success', ...(contentType ? { content: { [contentType]: { schema: { type: 'string' } } } } : {}) },
          ...(requestBody || params.some((p) => p.in === 'query') ? { 400: { $ref: '#/components/responses/Invalid' } } : {}),
          ...(r.public && !apiKey ? {} : { 401: { $ref: '#/components/responses/Unauthorized' } }),
          ...(!r.public && r.roles.length < ALL_ROLES.length ? { 403: { $ref: '#/components/responses/Forbidden' } } : {}),
          ...(access ? { 404: { $ref: '#/components/responses/NotFound' } } : {}),
        },
      };
      const path = toOpenApiPath(r.path);
      (paths[path] ??= {})[r.method] = operation;
      tags.add(tag);
    }
  }

  const errorResponse = (description: string) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
  return {
    openapi: '3.0.3',
    info: {
      title: 'AegisOps API', version: opts.version ?? '0.1.0',
      description: 'Generated from the routes, guards and validation rules the API enforces. All paths are under /api/v1. Errors share one shape: { error: { code, message, details? } }.',
    },
    servers: [{ url: '/api/v1' }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A Keycloak access token (the dashboard obtains and refreshes it for you).' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'A project-scoped CI key. It can call one route only: POST /ci/deployments.' },
      },
      schemas: { Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } } } },
      responses: {
        Invalid: errorResponse('The request failed validation.'),
        Unauthorized: errorResponse('Missing, invalid, expired or revoked credentials.'),
        Forbidden: errorResponse('Your role may not do this.'),
        NotFound: errorResponse('Not found, or you are not a member of the project.'),
      },
    },
  };
}
