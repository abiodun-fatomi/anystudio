/**
 * The staff console's API. Every route requires an ADMIN-surface session
 * (which only exists past a second factor) and a staff rank; mutations
 * additionally refuse self-dealing and a stale factor in the service.
 */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentActor, RequireStaff, RequireSurface } from '../auth/decorators';
import type { Actor } from '../auth/policy';
import { AdminService } from './admin.service';
import {
  AuditQueryDto,
  CreditsDto,
  GenerationsQueryDto,
  PaymentsQueryDto,
  PlatformMessageDto,
  PlatformMessagePatchDto,
  PricePatchDto,
  ProviderPatchDto,
  ReasonDto,
  SearchDto,
  StaffGrantDto,
} from './admin.dto';

@ApiTags('admin')
@ApiCookieAuth('session')
@RequireSurface('ADMIN')
@RequireStaff('SUPPORT')
@Controller({ path: 'admin', version: '1' })
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('/overview') overview() {
    return this.admin.overview();
  }

  @Get('/customers') customers(@Query() q: SearchDto) {
    return this.admin.customers(q);
  }
  @Get('/customers/:userId') customer(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.admin.customer(userId);
  }
  @Post('/customers/:userId/suspend') @HttpCode(HttpStatus.OK) suspend(
    @CurrentActor() a: Actor,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() b: ReasonDto,
    @Req() req: Request,
  ) {
    return this.admin.setCustomerStatus(a, userId, 'SUSPENDED', b.reason, req);
  }
  @Post('/customers/:userId/unsuspend') @HttpCode(HttpStatus.OK) unsuspend(
    @CurrentActor() a: Actor,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() b: ReasonDto,
    @Req() req: Request,
  ) {
    return this.admin.setCustomerStatus(a, userId, 'ACTIVE', b.reason, req);
  }

  @Get('/workspaces/:workspaceId') workspace(@Param('workspaceId', ParseUUIDPipe) id: string) {
    return this.admin.workspace(id);
  }
  @Post('/workspaces/:workspaceId/credits') @HttpCode(HttpStatus.OK) credits(
    @CurrentActor() a: Actor,
    @Param('workspaceId', ParseUUIDPipe) id: string,
    @Body() b: CreditsDto,
    @Req() req: Request,
  ) {
    return this.admin.adjustCredits(a, id, b, req);
  }

  @Get('/generations') generations(@Query() q: GenerationsQueryDto) {
    return this.admin.generations(q);
  }
  @Get('/generations/:id') generation(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.generation(id);
  }
  @Post('/generations/:id/fail') @HttpCode(HttpStatus.OK) failGeneration(
    @CurrentActor() a: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: ReasonDto,
    @Req() req: Request,
  ) {
    return this.admin.failGeneration(a, id, b.reason, req);
  }
  @Post('/generations/:id/refund') @HttpCode(HttpStatus.OK) refundGeneration(
    @CurrentActor() a: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: ReasonDto,
    @Req() req: Request,
  ) {
    return this.admin.refundGeneration(a, id, b.reason, req);
  }

  @Get('/providers') providers() {
    return this.admin.providers();
  }
  @Patch('/providers/:capability/:key') patchProvider(
    @CurrentActor() a: Actor,
    @Param('capability') capability: string,
    @Param('key') key: string,
    @Body() b: ProviderPatchDto,
    @Req() req: Request,
  ) {
    return this.admin.patchProvider(a, key, capability, b, req);
  }
  @Post('/providers/:capability/:key/reset-breaker') @HttpCode(HttpStatus.OK) resetBreaker(
    @CurrentActor() a: Actor,
    @Param('capability') capability: string,
    @Param('key') key: string,
    @Req() req: Request,
  ) {
    return this.admin.resetBreaker(a, key, capability, req);
  }

  @Get('/prices') prices() {
    return this.admin.prices();
  }
  @Patch('/prices/:code') patchPrice(@CurrentActor() a: Actor, @Param('code') code: string, @Body() b: PricePatchDto, @Req() req: Request) {
    return this.admin.patchPrice(a, code, b, req);
  }

  @Get('/payments') payments(@Query() q: PaymentsQueryDto) {
    return this.admin.payments(q);
  }
  @Post('/payments/:id/refund') @HttpCode(HttpStatus.OK) refundPayment(
    @CurrentActor() a: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: ReasonDto,
    @Req() req: Request,
  ) {
    return this.admin.refundPayment(a, id, b.reason, req);
  }

  @Get('/audit') audit(@Query() q: AuditQueryDto) {
    return this.admin.audit(q);
  }

  @Get('/staff') staff() {
    return this.admin.staff();
  }
  @Post('/staff') grantStaff(@CurrentActor() a: Actor, @Body() b: StaffGrantDto, @Req() req: Request) {
    return this.admin.grantStaff(a, b, req);
  }
  @Delete('/staff/:grantId') @HttpCode(HttpStatus.OK) revokeStaff(
    @CurrentActor() a: Actor,
    @Param('grantId', ParseUUIDPipe) grantId: string,
    @Req() req: Request,
  ) {
    return this.admin.revokeStaff(a, grantId, req);
  }

  @Get('/messages') messages() {
    return this.admin.messages();
  }
  @Post('/messages') createMessage(@CurrentActor() a: Actor, @Body() b: PlatformMessageDto, @Req() req: Request) {
    return this.admin.createMessage(a, b, req);
  }
  @Patch('/messages/:id') updateMessage(
    @CurrentActor() a: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() b: PlatformMessagePatchDto,
    @Req() req: Request,
  ) {
    return this.admin.updateMessage(a, id, b, req);
  }
  @Delete('/messages/:id') @HttpCode(HttpStatus.OK) deleteMessage(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.admin.deleteMessage(a, id, req);
  }
}
