/**
 * Request ids.
 *
 * Every request gets a ULID-ish id, echoed in `x-request-id` and shown in the
 * UI on any error, so support can find the exact request from a string the
 * customer reads off their screen. It propagates into queued jobs, which makes
 * one id cover the whole chain from tap to generated file.
 */

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
  }
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Accept an inbound id so a call that crosses services keeps one thread,
    // but bound the length — this value ends up in logs and headers.
    const inbound = req.get('x-request-id');
    req.requestId = inbound && inbound.length <= 64 ? inbound : randomUUID();
    res.setHeader('x-request-id', req.requestId);
    next();
  }
}
