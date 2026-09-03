/**
 * Wrap every successful response in `{ status, message, data }`.
 *
 * Services that care about the message return `Helpers.successResponse(...)`
 * themselves and pass through untouched. Anything else — a plain object from
 * a read endpoint — is wrapped with the HTTP status and a generic message, so
 * the shape is uniform without every handler having to remember it.
 *
 * Handlers that write the response directly (redirects, 204s) are not
 * touched: Nest skips interceptors' map when the handler took `@Res()`.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import { STATUS_CODES } from 'node:http';
import { map, Observable } from 'rxjs';
import { Helpers } from '../../src/utils/helpers';

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = ctx.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((body: unknown) => {
        if (body === undefined || Helpers.isEnvelope(body)) return body;
        // The reason phrase for whatever status the handler set — 'OK', 'Created',
        // 'Service Unavailable' — so the message never contradicts the code.
        return Helpers.successResponse(res.statusCode, STATUS_CODES[res.statusCode] ?? 'OK', body);
      }),
    );
  }
}
