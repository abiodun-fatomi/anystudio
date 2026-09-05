/**
 * Help & support in the staff console: every chat, the assistant's answers,
 * and a way in.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentActor, RequireStaff, RequireSurface } from '../auth/decorators';
import type { Actor } from '../auth/policy';
import { SupportService } from './support.service';
import { StaffReplyDto, SupportListQueryDto } from './support.dto';

@ApiTags('admin')
@ApiCookieAuth('session')
@RequireSurface('ADMIN')
@RequireStaff('SUPPORT')
@Controller({ path: 'admin/support', version: '1' })
export class SupportAdminController {
  constructor(private readonly support: SupportService) {}

  @Get() list(@Query() q: SupportListQueryDto) { return this.support.list(q); }
  @Get('/:id') one(@Param('id', ParseUUIDPipe) id: string) { return this.support.staffOne(id); }
  @Post('/:id/reply') @HttpCode(HttpStatus.OK) reply(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() b: StaffReplyDto, @Req() req: Request) { return this.support.staffReply(a, id, b, req); }
  @Post('/:id/resolve') @HttpCode(HttpStatus.OK) resolve(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.support.staffResolve(a, id, req); }
  @Post('/:id/close') @HttpCode(HttpStatus.OK) close(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request) { return this.support.staffClose(a, id, req); }
}
