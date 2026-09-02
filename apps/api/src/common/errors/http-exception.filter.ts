/**
 * The one place errors become HTTP responses.
 *
 * Errors are logged ONCE, here, with the stack and the request id. Services do
 * not log-and-rethrow — that turns one failure into five lines and buries the
 * cause. The response body carries the request id so the customer can quote it.
 */

import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, PolicyToHttp } from './app-error';
import { PolicyError } from '../policy/policy';
import { logger } from '../logging/logger';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  /** Maps any thrown value to a response, logging what deserves a log. */
  catch(err: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = req.requestId;

    let status = 500;
    let body: Record<string, unknown> = { code: 'internal', message: 'Something went wrong on our side.' };

    if (err instanceof AppError) {
      status = err.status;
      body = { code: err.code, message: err.message, ...(err.details ?? {}) };
      if (err.code === 'rate_limited' && typeof err.details?.retryAfterSec === 'number') {
        res.setHeader('Retry-After', String(err.details.retryAfterSec));
      }
    } else if (err instanceof PolicyError) {
      status = PolicyToHttp[err.code];
      body = { code: err.code.toLowerCase(), message: err.message };
    } else if (err instanceof ZodError) {
      status = 400;
      body = { code: 'invalid_input', message: 'Some of that did not look right.',
        fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
    } else if (err instanceof HttpException) {
      status = err.getStatus();
      const r = err.getResponse();
      body = typeof r === 'string' ? { code: 'http', message: r } : { code: 'http', ...(r as object) };
    }

    // 5xx is our fault and gets the stack. 4xx is the caller's and gets a line.
    if (status >= 500) {
      logger.error({ err, requestId, path: req.path, method: req.method }, 'request failed');
    } else if (status !== 404) {
      logger.info({ requestId, status, code: body.code, path: req.path }, 'request rejected');
    }

    res.status(status).json({ ...body, requestId });
  }
}
