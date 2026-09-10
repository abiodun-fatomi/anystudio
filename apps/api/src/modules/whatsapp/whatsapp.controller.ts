/**
 * Meta's door. GET is the subscription handshake; POST is every message and
 * status Meta has for us, signed with the app secret over the raw bytes.
 * Both are public routes — Meta has no session — and both answer 200 fast:
 * Meta retries anything slow or non-2xx, and a retry storm is worse than
 * one lost status.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { ForbiddenError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { authLog } from '../auth/auth.log';
import { Public } from '../auth/decorators';
import { WhatsappService } from './whatsapp.service';
import type { WebhookEnvelope } from './whatsapp.types';

@ApiExcludeController()
@Public()
@Controller({ path: 'whatsapp', version: '1' })
export class WhatsappController {
  constructor(private readonly whatsapp: WhatsappService) {}

  @Get('/webhook')
  verify(@Query() query: Record<string, unknown>, @Req() req: Request): string {
    const challenge = this.whatsapp.verify(query);
    authLog('whatsapp.webhook', challenge ? 'succeeded' : 'refused', { reason: challenge ? undefined : 'verify_token_mismatch', action: 'verify' }, req);
    if (!challenge) throw new ForbiddenError('Verification failed.');
    return challenge;
  }

  @Post('/webhook')
  @HttpCode(HttpStatus.OK)
  async receive(@Req() req: Request, @Body() body: WebhookEnvelope): Promise<{ received: true }> {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(body ?? {}));
    if (!this.whatsapp.signatureOk(raw, req.get('x-hub-signature-256'))) {
      authLog('whatsapp.webhook', 'refused', { reason: process.env.WHATSAPP_APP_SECRET ? 'bad_signature' : 'no_app_secret' }, req);
      throw new ForbiddenError('Bad signature.');
    }
    // Acknowledge now; the work happens after the response. Meta's clock is short.
    void this.whatsapp
      .receive(body)
      .then((r) => {
        if (r.handled || r.skipped) logger.info({ ...r, requestId: req.requestId }, 'whatsapp webhook processed');
      })
      .catch((err) => logger.error({ err, requestId: req.requestId }, 'whatsapp webhook processing failed'));
    return { received: true };
  }
}
