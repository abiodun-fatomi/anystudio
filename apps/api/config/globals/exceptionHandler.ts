/**
 * The one place errors become HTTP responses.
 *
 * Errors are logged ONCE, here, with the stack and the request id. Services do
 * not log-and-rethrow — that turns one failure into five lines and buries the
 * cause. The body carries the request id so a customer can quote it and
 * support finds the exact request in one search.
 *
 * The error body mirrors the success envelope — `status`, `message`, `data` —
 * with `error` and `requestId` alongside, so a client parses one shape.
 */

import { type ArgumentsHost, BadRequestException, Catch, type ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, PolicyToHttp } from './errors';
import { PolicyError } from '../../src/modules/auth/policy';
import { logger } from '../logger';

interface ErrorBody {
  status: number;
  message: string;
  error: string;
  data: null;
  fields?: Array<{ path: string; message: string }>;
  requestId?: string;
  [k: string]: unknown;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  /** Maps any thrown value to a response, logging what deserves a log. */
  catch(err: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const requestId = req.requestId;

    let body: ErrorBody = {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'internal',
      message: 'Something went wrong on our side.',
      data: null,
    };

    if (err instanceof AppError) {
      body = { status: err.status, error: err.code, message: err.message, data: null, ...(err.details ?? {}) };
      // A service-level ValidationError names fields in `details`; expose them
      // in the same `fields` shape as class-validator so a form shows them inline.
      if (err.code === 'invalid_input' && err.details) {
        body.fields = Object.entries(err.details)
          .filter(([, v]) => typeof v === 'string')
          .map(([path, message]) => ({ path, message: String(message) }));
      }
      if (err.code === 'rate_limited' && typeof err.details?.retryAfterSec === 'number') {
        res.setHeader('Retry-After', String(err.details.retryAfterSec));
      }
    } else if (err instanceof PolicyError) {
      body = { status: PolicyToHttp[err.code], error: err.code.toLowerCase(), message: err.message, data: null };
    } else if (err instanceof BadRequestException) {
      // class-validator, via the global ValidationPipe: one line per field.
      const r = err.getResponse() as { message?: string | string[] };
      const lines = Array.isArray(r.message) ? r.message : [r.message ?? err.message];
      body = {
        status: HttpStatus.BAD_REQUEST,
        error: 'invalid_input',
        message: 'Some of that did not look right.',
        data: null,
        fields: lines.map((m) => ({ path: String(m).split(' ')[0] ?? '', message: String(m) })),
      };
    } else if (err instanceof HttpException) {
      const r = err.getResponse();
      body = {
        status: err.getStatus(),
        error: 'http',
        data: null,
        message: typeof r === 'string' ? r : ((r as { message?: string }).message ?? err.message),
      };
    }

    // 5xx is our fault and gets the stack. 4xx is the caller's and gets a line.
    if (body.status >= 500) {
      logger.error({ err, requestId, path: req.path, method: req.method }, 'request failed');
    } else if (body.status !== 404) {
      logger.info({ requestId, status: body.status, error: body.error, path: req.path }, 'request rejected');
    }

    res.status(body.status).json({ ...body, requestId });
  }
}
