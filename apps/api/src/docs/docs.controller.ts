import { Controller, Get, Module } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Roles } from '../auth/decorators';
import { buildOpenApi } from './openapi';

type Ctor = new (...args: never[]) => unknown;

/**
 * Every controller registered in the running application. `/metrics` is left out: it is outside the public API tree and Nginx has no
 * route to it, so documenting it would only mislead.
 */
export function allControllers(modules: ModulesContainer): Ctor[] {
  const seen = new Set<Ctor>();
  for (const m of modules.values()) {
    for (const w of m.controllers.values()) {
      const c = w.metatype as Ctor | null;
      if (c && Reflect.getMetadata(PATH_METADATA, c) !== 'metrics') seen.add(c);
    }
  }
  return [...seen];
}

/** PRD 10: the OpenAPI document, for any signed-in user (it describes routes, never data). The dashboard renders it at /api/docs. */
@Controller('openapi.json')
export class DocsController {
  private cached?: Record<string, unknown>;
  constructor(private readonly modules: ModulesContainer) {}

  @Get()
  @Roles('platform_admin', 'devops_engineer', 'developer', 'auditor')
  spec() {
    return (this.cached ??= buildOpenApi(allControllers(this.modules), { version: process.env.APP_VERSION }));
  }
}

@Module({ controllers: [DocsController] })
export class DocsModule {}
