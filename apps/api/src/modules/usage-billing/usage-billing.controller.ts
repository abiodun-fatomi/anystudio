/**
 * Usage-based billing routes. Two families: what an organization sees of its
 * own credit line and invoices, and the staff console's terms and
 * settlement actions. Paying an invoice online is a checkout, so that one
 * route lives with the gateways in BillingController.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { UsageBillingService } from './usage-billing.service';
import { AccountPatchDto, AccountTermsDto, AdminInvoicesQueryDto, InvoicesQueryDto, MarkPaidDto, StaffReasonDto } from './usage-billing.dto';
import { CurrentActor, RequireStaff, RequireSurface, RequireWorkspaceRole } from '../auth/decorators';
import type { Actor } from '../auth/policy';

@ApiTags('billing')
@Controller({ version: '1' })
export class UsageBillingController {
  constructor(private readonly usage: UsageBillingService) {}

  @Get('/workspaces/:workspaceId/billing/account')
  @RequireWorkspaceRole('AUDITOR')
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'The credit line, this period so far, and what is open. account is null for prepaid workspaces.' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  account(@Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.usage.account(workspaceId);
  }

  @Patch('/workspaces/:workspaceId/billing/account')
  @RequireWorkspaceRole('AUDITOR')
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Billing address and email (owner, admin or billing contact). Terms are set by staff.' })
  patchAccount(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: AccountPatchDto, @Req() req: Request) {
    return this.usage.patchAccount(actor, workspaceId, body, req);
  }

  @Get('/workspaces/:workspaceId/billing/invoices')
  @RequireWorkspaceRole('AUDITOR')
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'Invoices, newest period first' })
  invoices(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query() q: InvoicesQueryDto) {
    return this.usage.invoices(workspaceId, q);
  }

  @Get('/workspaces/:workspaceId/billing/invoices/:invoiceId')
  @RequireWorkspaceRole('AUDITOR')
  @ApiCookieAuth('session')
  @ApiOperation({ summary: 'One invoice with its lines — what the printable page shows' })
  invoice(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('invoiceId', ParseUUIDPipe) invoiceId: string) {
    return this.usage.invoice(workspaceId, invoiceId);
  }
}

@ApiTags('admin')
@RequireSurface('ADMIN')
@RequireStaff('SUPPORT')
@Controller({ path: 'admin/billing', version: '1' })
export class AdminUsageBillingController {
  constructor(private readonly usage: UsageBillingService) {}

  @Get('/accounts')
  @ApiOperation({ summary: 'Every credit line with its balance and open invoices' })
  accounts() {
    return this.usage.accounts();
  }

  @Get('/rates')
  @ApiOperation({ summary: 'The list rate card' })
  rates() {
    return this.usage.rates();
  }

  @Get('/invoices')
  @ApiOperation({ summary: 'Invoices across organizations' })
  invoices(@Query() q: AdminInvoicesQueryDto) {
    return this.usage.adminInvoices(q);
  }

  @Put('/accounts/:workspaceId')
  @ApiOperation({ summary: 'Open a credit line or change its terms (staff ADMIN, recent second factor)' })
  setTerms(@CurrentActor() a: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() b: AccountTermsDto, @Req() req: Request) {
    return this.usage.setTerms(a, workspaceId, b, req);
  }

  @Post('/accounts/:workspaceId/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Back to prepaid; invoices the partial period now' })
  closeAccount(@CurrentActor() a: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() b: StaffReasonDto, @Req() req: Request) {
    return this.usage.closeAccount(a, workspaceId, b.reason, req);
  }

  @Post('/accounts/:workspaceId/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Lift a suspension by hand' })
  reactivate(@CurrentActor() a: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() b: StaffReasonDto, @Req() req: Request) {
    return this.usage.reactivate(a, workspaceId, b.reason, req);
  }

  @Post('/accounts/:workspaceId/close-period')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Invoice the period so far, without waiting for month end' })
  closePeriod(@CurrentActor() a: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() b: StaffReasonDto, @Req() req: Request) {
    return this.usage.closePeriodNow(a, workspaceId, b.reason, req);
  }

  @Post('/invoices/:invoiceId/mark-paid')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Record a bank transfer against an invoice' })
  markPaid(@CurrentActor() a: Actor, @Param('invoiceId', ParseUUIDPipe) invoiceId: string, @Body() b: MarkPaidDto, @Req() req: Request) {
    return this.usage.markPaid(a, invoiceId, b, req);
  }

  @Post('/invoices/:invoiceId/void')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Void an unpaid invoice; its credits go back to the line' })
  voidInvoice(@CurrentActor() a: Actor, @Param('invoiceId', ParseUUIDPipe) invoiceId: string, @Body() b: StaffReasonDto, @Req() req: Request) {
    return this.usage.voidInvoice(a, invoiceId, b.reason, req);
  }
}
