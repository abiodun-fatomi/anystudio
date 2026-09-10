import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { WorkspaceService } from './workspace.service';
import { WorkspaceDeleteDto, WorkspaceProfileDto, WorkspaceUpdateDto } from './workspace.dto';
import { CurrentActor, RequireWorkspaceRole } from '../auth/decorators';
import type { Actor } from '../auth/policy';

@ApiTags('workspace')
@ApiCookieAuth('session')
@Controller({ path: 'workspaces/:workspaceId', version: '1' })
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Get()
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'Read the workspace, including its profile' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  get(@Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.workspaceService.get(workspaceId);
  }

  @Patch('/profile')
  @RequireWorkspaceRole('ADMIN')
  @ApiOperation({ summary: 'Save the welcome answers, or update them from settings' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  @ApiBody({ type: WorkspaceProfileDto })
  patchProfile(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: WorkspaceProfileDto) {
    return this.workspaceService.patchProfile(workspaceId, body);
  }

  @Patch()
  @RequireWorkspaceRole('ADMIN')
  @ApiOperation({ summary: 'Rename the workspace' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  update(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: WorkspaceUpdateDto, @Req() req: Request) {
    return this.workspaceService.update(workspaceId, body, actor.userId, req);
  }

  @Delete()
  @RequireWorkspaceRole('OWNER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete the workspace (soft); owner only, name typed to confirm' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  remove(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: WorkspaceDeleteDto, @Req() req: Request) {
    return this.workspaceService.remove(workspaceId, body, actor.userId, req);
  }
}
