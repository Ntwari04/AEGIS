import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

const CODES: Record<number, string> = {
  400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found',
  409: 'conflict', 429: 'rate_limited',
};

/** PRD 10: consistent error shape { error: { code, message, details? } }. Never leaks stack traces. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message = typeof body === 'string' ? body : ((body as any).message ?? exception.message);
      const isList = Array.isArray(message);
      res.status(status).json({
        error: {
          code: CODES[status] ?? 'error',
          message: isList ? 'Validation failed' : message,
          ...(isList ? { details: message } : {}),
        },
      });
      return;
    }
    this.logger.error(exception instanceof Error ? exception.message : 'Unknown error');
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  }
}
