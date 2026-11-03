import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap, catchError, throwError } from 'rxjs';
import { AuditService } from './audit.service';

export interface AuditSpec {
  action: string;
  targetType: string;
  /** Request param holding the target id; if omitted the id is read from the response body. */
  targetParam?: string;
}
export const AUDIT_SPEC = 'aegis:audit';
/** Marks a mutating handler so its outcome is written to the audit log (FR-AUDIT-1). */
export const Audited = (spec: AuditSpec) => SetMetadata(AUDIT_SPEC, spec);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, private readonly audit: AuditService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const spec = this.reflector.get<AuditSpec | undefined>(AUDIT_SPEC, ctx.getHandler());
    if (!spec) return next.handle();
    const req = ctx.switchToHttp().getRequest();
    const base = {
      actorId: req.user?.id,
      actorName: req.user?.username,
      action: spec.action,
      targetType: spec.targetType,
      sourceIp: req.ip,
    };
    const paramId = spec.targetParam ? req.params?.[spec.targetParam] : undefined;
    return next.handle().pipe(
      tap((body: any) => {
        void this.audit.record({ ...base, targetId: paramId ?? body?.id, result: 'SUCCESS' });
      }),
      catchError((err) => {
        void this.audit.record({ ...base, targetId: paramId, result: 'ERROR', metadata: { status: err?.status } });
        return throwError(() => err);
      }),
    );
  }
}
