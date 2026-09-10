import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { MemberService } from './member.service';
import { AcceptInviteDto, InviteDto, RoleDto, TransferDto } from './member.dto';
import { CurrentActor, RequireWorkspaceRole } from '../auth/decorators';
import type { Actor } from '../auth/policy';

@ApiTags('members')
@ApiCookieAuth('session')
@Controller({ path: 'workspaces', version: '1' })
export class MemberController {
  constructor(private readonly members: MemberService) {}

  /** Not under :workspaceId — the workspace comes from the token, and the caller is not a member yet. */
  @Post('/invites/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept an invitation; must be signed in as the invited email' })
  accept(@CurrentActor() actor: Actor, @Body() body: AcceptInviteDto, @Req() req: Request) {
    return this.members.accept(actor, body.token, req);
  }

  @Get('/:workspaceId/members')
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'Members and open invitations' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  list(@Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.members.list(workspaceId);
  }

  @Post('/:workspaceId/members/invites')
  @RequireWorkspaceRole('ADMIN')
  @ApiOperation({ summary: 'Invite someone by email' })
  invite(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: InviteDto, @Req() req: Request) {
    return this.members.invite(actor, workspaceId, body, req);
  }

  @Delete('/:workspaceId/members/invites/:inviteId')
  @RequireWorkspaceRole('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an open invitation' })
  cancelInvite(
    @CurrentActor() actor: Actor,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
    @Req() req: Request,
  ) {
    return this.members.cancelInvite(actor, workspaceId, inviteId, req);
  }

  @Patch('/:workspaceId/members/:userId')
  @RequireWorkspaceRole('ADMIN')
  @ApiOperation({ summary: "Change a member's role" })
  setRole(
    @CurrentActor() actor: Actor,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: RoleDto,
    @Req() req: Request,
  ) {
    return this.members.setRole(actor, workspaceId, userId, body.role, req);
  }

  @Delete('/:workspaceId/members/:userId')
  @RequireWorkspaceRole('AUDITOR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a member, or leave (your own id)' })
  remove(
    @CurrentActor() actor: Actor,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: Request,
  ) {
    return this.members.remove(actor, workspaceId, userId, req);
  }

  @Post('/:workspaceId/members/transfer')
  @RequireWorkspaceRole('OWNER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Transfer ownership to another member' })
  transfer(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: TransferDto, @Req() req: Request) {
    return this.members.transfer(actor, workspaceId, body.userId, req);
  }
}
