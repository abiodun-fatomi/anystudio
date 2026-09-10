import { Body, Controller, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { WorkspaceService } from './workspace.service';
import { WorkspaceCreateDto } from './workspace.dto';
import { CurrentActor } from '../auth/decorators';
import type { Actor } from '../auth/policy';

@ApiTags('workspace')
@ApiCookieAuth('session')
@Controller({ path: 'workspaces', version: '1' })
export class WorkspacesController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Post()
  @ApiOperation({ summary: 'Create another workspace — a business, or an organization for the API' })
  @ApiBody({ type: WorkspaceCreateDto })
  create(@CurrentActor() actor: Actor, @Body() body: WorkspaceCreateDto, @Req() req: Request) {
    return this.workspaceService.create(actor.userId, body, req);
  }
}
