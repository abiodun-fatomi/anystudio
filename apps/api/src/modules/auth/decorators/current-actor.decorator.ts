import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { SessionActor } from '../policy';

/** The Actor the guard assembled for this request. */
export const CurrentActor = createParamDecorator((_: unknown, ctx: ExecutionContext): SessionActor => {
  return ctx.switchToHttp().getRequest().actor;
});
