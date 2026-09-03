import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { WorkspaceService } from './workspace.service';
import { WorkspaceProfileDto } from './workspace.dto';
import { RequireWorkspaceRole } from '../auth/decorators';

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
}
