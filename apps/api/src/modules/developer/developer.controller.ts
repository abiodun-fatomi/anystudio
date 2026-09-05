/** The portal side: projects, keys, webhooks and usage, for the workspace's admins. */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentActor, RequireWorkspaceRole } from '../auth/decorators';
import type { Actor } from '../auth/policy';
import { DeveloperService } from './developer.service';
import { CreateApiKeyDto, CreateProjectDto, CreateWebhookDto, DeliveriesQueryDto, UpdateProjectDto, UpdateWebhookDto, UsageQueryDto } from './developer.dto';

@ApiTags('developer')
@ApiCookieAuth('session')
@ApiParam({ name: 'workspaceId', format: 'uuid' })
@Controller({ path: 'workspaces/:workspaceId/developer', version: '1' })
export class DeveloperController {
  constructor(private readonly dev: DeveloperService) {}

  @Get('/usage') @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'API usage by day, project, key and merchant' })
  usage(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query() q: UsageQueryDto) { return this.dev.usage(workspaceId, q.days, q.projectId); }

  @Get('/projects') @RequireWorkspaceRole('AUDITOR')
  projects(@Param('workspaceId', ParseUUIDPipe) workspaceId: string) { return this.dev.projects(workspaceId); }

  @Post('/projects') @RequireWorkspaceRole('ADMIN')
  createProject(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: CreateProjectDto, @Req() req: Request) { return this.dev.createProject(actor, workspaceId, body, req); }

  @Patch('/projects/:projectId') @RequireWorkspaceRole('ADMIN')
  updateProject(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() body: UpdateProjectDto, @Req() req: Request) { return this.dev.updateProject(actor, workspaceId, projectId, body, req); }

  @Get('/keys') @RequireWorkspaceRole('AUDITOR')
  keys(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query('projectId') projectId?: string) { return this.dev.keys(workspaceId, projectId || undefined); }

  @Post('/keys') @RequireWorkspaceRole('ADMIN')
  @ApiOperation({ summary: 'Mint a key. The key is in this response and nowhere else, ever.' })
  createKey(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: CreateApiKeyDto, @Req() req: Request) { return this.dev.createKey(actor, workspaceId, body, req); }

  @Delete('/keys/:keyId') @RequireWorkspaceRole('ADMIN') @HttpCode(HttpStatus.OK)
  revokeKey(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('keyId', ParseUUIDPipe) keyId: string, @Req() req: Request) { return this.dev.revokeKey(actor, workspaceId, keyId, req); }

  @Get('/webhooks') @RequireWorkspaceRole('AUDITOR')
  webhooks(@Param('workspaceId', ParseUUIDPipe) workspaceId: string) { return this.dev.webhooks(workspaceId); }

  @Post('/webhooks') @RequireWorkspaceRole('ADMIN')
  @ApiOperation({ summary: 'Add an endpoint. The signing secret is in this response and nowhere else.' })
  createWebhook(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: CreateWebhookDto, @Req() req: Request) { return this.dev.createWebhook(actor, workspaceId, body, req); }

  @Patch('/webhooks/:webhookId') @RequireWorkspaceRole('ADMIN')
  updateWebhook(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('webhookId', ParseUUIDPipe) webhookId: string, @Body() body: UpdateWebhookDto, @Req() req: Request) { return this.dev.updateWebhook(actor, workspaceId, webhookId, body, req); }

  @Delete('/webhooks/:webhookId') @RequireWorkspaceRole('ADMIN') @HttpCode(HttpStatus.OK)
  deleteWebhook(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('webhookId', ParseUUIDPipe) webhookId: string, @Req() req: Request) { return this.dev.deleteWebhook(actor, workspaceId, webhookId, req); }

  @Post('/webhooks/:webhookId/test') @RequireWorkspaceRole('ADMIN') @HttpCode(HttpStatus.OK)
  testWebhook(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('webhookId', ParseUUIDPipe) webhookId: string, @Req() req: Request) { return this.dev.testWebhook(actor, workspaceId, webhookId, req); }

  @Get('/webhooks/:webhookId/deliveries') @RequireWorkspaceRole('AUDITOR')
  deliveries(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('webhookId', ParseUUIDPipe) webhookId: string, @Query() q: DeliveriesQueryDto) { return this.dev.deliveries(workspaceId, webhookId, q.take); }

  @Post('/webhooks/:webhookId/deliveries/:deliveryId/redeliver') @RequireWorkspaceRole('ADMIN') @HttpCode(HttpStatus.OK)
  redeliver(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('webhookId', ParseUUIDPipe) webhookId: string, @Param('deliveryId', ParseUUIDPipe) deliveryId: string) { return this.dev.redeliver(workspaceId, webhookId, deliveryId); }
}
