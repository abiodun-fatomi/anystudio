/**
 * Billing routes. Two families: workspace-scoped (behind the session and a
 * membership check) and the webhook receivers, which are public by
 * necessity and authenticated by signature inside the service.
 */
import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { BillingService } from './billing.service';
import { CheckoutDto, PaymentsQueryDto, VerifyPaymentDto } from './billing.dto';
import { CurrentActor, Public, RequireWorkspaceRole } from '../auth/decorators';
import type { Actor } from '../auth/policy';

@ApiTags('billing')
@Controller({ version: '1' })
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('/workspaces/:workspaceId/billing/catalogue')
  @RequireWorkspaceRole('AUDITOR')
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Packs and plans in this workspace\'s currency, and the current plan' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  catalogue(@Param('workspaceId', ParseUUIDPipe) workspaceId: string) { return this.billing.catalogue(workspaceId); }

  @Post('/workspaces/:workspaceId/billing/checkout')
  @RequireWorkspaceRole('AUDITOR')
  @ApiCookieAuth('session')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Price an item server-side and open a hosted checkout (owner, admin or billing contact)' })
  checkout(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: CheckoutDto, @Req() req: Request) {
    return this.billing.checkout(actor, workspaceId, body, req);
  }

  @Post('/workspaces/:workspaceId/billing/payments/:paymentId/verify')
  @RequireWorkspaceRole('AUDITOR')
  @ApiCookieAuth('session')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask the gateway whether this payment went through; grants credits if so (idempotent)' })
  verify(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('paymentId', ParseUUIDPipe) paymentId: string, @Body() body: VerifyPaymentDto, @Req() req: Request) {
    return this.billing.verifyPayment(workspaceId, paymentId, body, req);
  }

  @Get('/workspaces/:workspaceId/billing/payments')
  @RequireWorkspaceRole('AUDITOR')
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Settled payments, newest first' })
  payments(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query() q: PaymentsQueryDto) { return this.billing.payments(workspaceId, q); }

  @Get('/workspaces/:workspaceId/billing/payments/:paymentId')
  @RequireWorkspaceRole('AUDITOR')
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'One payment' })
  payment(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('paymentId', ParseUUIDPipe) paymentId: string) { return this.billing.payment(workspaceId, paymentId); }

  @Get('/workspaces/:workspaceId/billing/subscription')
  @RequireWorkspaceRole('AUDITOR')
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'The current plan, if any' })
  subscription(@Param('workspaceId', ParseUUIDPipe) workspaceId: string) { return this.billing.subscription(workspaceId); }

  @Post('/workspaces/:workspaceId/billing/subscription/cancel')
  @RequireWorkspaceRole('AUDITOR')
  @ApiCookieAuth('session')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stop the plan at the end of the paid period' })
  cancel(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Req() req: Request) { return this.billing.cancelSubscription(actor, workspaceId, req); }

  // ---- webhooks: no session, signature-checked inside, always 200 once recorded.

  @Public()
  @Post('/billing/webhooks/flutterwave')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  flutterwave(@Req() req: Request, @Headers() headers: Record<string, string | string[] | undefined>) {
    return this.billing.handleWebhook('FLUTTERWAVE', rawOf(req), headers);
  }

  @Public()
  @Post('/billing/webhooks/paddle')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  paddle(@Req() req: Request, @Headers() headers: Record<string, string | string[] | undefined>) {
    return this.billing.handleWebhook('PADDLE', rawOf(req), headers);
  }

  @Public()
  @Post('/billing/webhooks/stub')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  stub(@Req() req: Request, @Headers() headers: Record<string, string | string[] | undefined>) {
    return this.billing.handleWebhook('STUB', rawOf(req), headers);
  }
}

/** The bytes as sent: `rawBody` is populated by Nest when the app is created with `rawBody: true`. */
function rawOf(req: Request): Buffer {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  return raw ?? Buffer.from(JSON.stringify(req.body ?? {}));
}
