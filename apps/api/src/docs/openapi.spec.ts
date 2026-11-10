import 'reflect-metadata';
import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { Audited } from '../audit/audit.interceptor';
import { ProjectAccess, Public, Roles } from '../auth/decorators';
import { buildOpenApi, routesOf, schemaOf } from './openapi';

class CreateThingDto {
  @IsString() @Length(2, 40) @Matches(/^[a-z]+$/) name!: string;
  @IsOptional() @IsIn(['a', 'b']) kind?: 'a' | 'b';
  @IsOptional() @IsInt() @Min(1) @Max(9) size?: number;
  @IsString({ each: true }) tags!: string[];
}
class ListQuery {
  @IsOptional() @IsInt() @Min(1) page: number = 1;
  @IsIn(['SUCCESS', 'DENIED']) result!: string;
}

@Controller('things')
class ThingsController {
  @Get()
  @Roles('platform_admin', 'auditor')
  list(@Query() _q: ListQuery) { return []; }

  @Post(':projectId')
  @Roles('platform_admin', 'devops_engineer')
  @ProjectAccess('manage')
  @Audited({ action: 'thing.create', targetType: 'thing' })
  create(@Param('projectId') _p: string, @Body() _b: CreateThingDto, @Headers('idempotency-key') _k?: string) { return {}; }

  @Post('hook')
  @Public()
  @HttpCode(204)
  hook(@Headers('x-signature') _s: string) { return; }

  @Post('ci')
  @Public()
  ci(@Headers('x-api-key') _k: string) { return {}; }
}

const doc = buildOpenApi([ThingsController]) as any;
const op = (path: string, method: string) => doc.paths[path][method];

describe('schemaOf (class-validator rules as JSON Schema)', () => {
  const { schema, required } = schemaOf(CreateThingDto);
  const p = (schema as any).properties;
  it('maps types, lengths, patterns, enums and numeric bounds', () => {
    expect(p.name).toMatchObject({ type: 'string', minLength: 2, maxLength: 40, pattern: '^[a-z]+$' });
    expect(p.kind).toMatchObject({ enum: ['a', 'b'] });
    expect(p.size).toMatchObject({ type: 'integer', minimum: 1, maximum: 9 });
    expect(p.tags).toMatchObject({ type: 'array', items: { type: 'string' } });
  });
  it('lists as required exactly the properties that are not @IsOptional', () => {
    expect(required.sort()).toEqual(['name', 'tags']);
  });
  it('forbids unknown properties, like the API\'s validation pipe does', () => {
    expect((schema as any).additionalProperties).toBe(false);
  });
});

describe('buildOpenApi', () => {
  it('turns :params into {params}, and documents every route once', () => {
    expect(Object.keys(doc.paths).sort()).toEqual(['/things', '/things/ci', '/things/hook', '/things/{projectId}']);
    expect(routesOf([ThingsController]).map((r) => `${r.method} ${r.path}`).sort()).toEqual(['get /things', 'post /things/ci', 'post /things/hook', 'post /things/:projectId'].sort());
  });

  it('states the roles the guard checks, the project access, and the audit action', () => {
    const o = op('/things/{projectId}', 'post');
    expect(o['x-roles']).toEqual(['platform_admin', 'devops_engineer']);
    expect(o['x-project-access']).toBe('manage');
    expect(o['x-audit-action']).toBe('thing.create');
    expect(o.security).toEqual([{ bearerAuth: [] }]);
    expect(o.description).toMatch(/Roles: platform_admin, devops_engineer/);
    expect(o.summary).toBe('Thing create');
  });

  it('describes the path parameter, the body (with required fields) and a header', () => {
    const o = op('/things/{projectId}', 'post');
    expect(o.parameters).toEqual(expect.arrayContaining([
      { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'idempotency-key', in: 'header', required: false, schema: { type: 'string' } },
    ]));
    expect(o.requestBody.content['application/json'].schema.required.sort()).toEqual(['name', 'tags']);
  });

  it('turns a query DTO into query parameters with their rules', () => {
    const q = op('/things', 'get').parameters;
    expect(q.find((x: any) => x.name === 'result')).toMatchObject({ in: 'query', required: true, schema: { enum: ['SUCCESS', 'DENIED'] } });
    expect(q.find((x: any) => x.name === 'page')).toMatchObject({ in: 'query', required: false, schema: { type: 'integer', minimum: 1 } });
  });

  it('marks a public route as unauthenticated by a token, and a key route as using the API key', () => {
    expect(op('/things/hook', 'post').security).toEqual([]);
    expect(op('/things/hook', 'post')['x-roles']).toEqual([]);
    expect(op('/things/ci', 'post').security).toEqual([{ apiKey: [] }]);
    expect(doc.components.securitySchemes.apiKey).toMatchObject({ in: 'header', name: 'X-API-Key' });
  });

  it('uses the right success status and only the errors that can happen', () => {
    expect(Object.keys(op('/things/hook', 'post').responses)).toEqual(['204']);
    expect(Object.keys(op('/things/{projectId}', 'post').responses).sort()).toEqual(['201', '400', '401', '403', '404']);
    expect(Object.keys(op('/things', 'get').responses).sort()).toEqual(['200', '400', '401', '403']);
  });

  it('is valid OpenAPI 3 in shape: version, info, servers, components', () => {
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.servers).toEqual([{ url: '/api/v1' }]);
    expect(doc.components.schemas.Error.properties.error.required).toEqual(['code', 'message']);
    for (const ref of ['Invalid', 'Unauthorized', 'Forbidden', 'NotFound']) expect(doc.components.responses[ref]).toBeDefined();
  });
});
