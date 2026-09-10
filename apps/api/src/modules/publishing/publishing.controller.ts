import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { SocialPlatform } from '@prisma/client';
import { CurrentActor, Public, RequireWorkspaceRole } from '../auth/decorators';
import type { Actor } from '../auth/policy';
import { ValidationError } from '../../../config/globals/errors';
import { PublishingService } from './publishing.service';
import { ConnectCallbackQueryDto, ConnectStartQueryDto, PublishCreateDto, PublishListQueryDto, PublishPatchDto, ShareDto } from './publishing.dto';

function platformOf(raw: string): SocialPlatform {
  const p = raw.toUpperCase();
  if (p === 'INSTAGRAM' || p === 'TIKTOK') return p;
  throw new ValidationError({ platform: 'instagram or tiktok' });
}

@ApiTags('publishing')
@ApiCookieAuth('session')
@Controller({ path: 'workspaces/:workspaceId/publishing', version: '1' })
export class PublishingController {
  constructor(private readonly publishing: PublishingService) {}

  @Get('/platforms')
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'Which platforms can be connected in this environment, and what each takes' })
  platforms() {
    return this.publishing.platforms();
  }

  @Get('/accounts')
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'Connected accounts (tokens never included)' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  accounts(@Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.publishing.accounts(workspaceId);
  }

  @Get('/connect/:platform/start')
  @RequireWorkspaceRole('ADMIN')
  @ApiOperation({ summary: 'Begin connecting an account (navigate here, do not fetch): redirects to the platform' })
  @ApiQuery({ name: 'next', required: false })
  @ApiResponse({ status: 302 })
  connectStart(
    @CurrentActor() actor: Actor,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('platform') platform: string,
    @Query() q: ConnectStartQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.publishing.connectStart(actor, workspaceId, platformOf(platform), q.next, req, res);
  }

  @Delete('/accounts/:accountId')
  @RequireWorkspaceRole('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disconnect an account; anything scheduled through it is cancelled' })
  async disconnect(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('accountId', ParseUUIDPipe) accountId: string) {
    await this.publishing.disconnect(workspaceId, accountId);
    return { status: 'disconnected' as const };
  }

  @Post('/jobs')
  @RequireWorkspaceRole('MEMBER')
  @ApiOperation({ summary: 'Post now or schedule; one job per account' })
  create(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: PublishCreateDto) {
    return this.publishing.create(actor, workspaceId, body);
  }

  @Get('/jobs')
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'Upcoming (soonest first) or history (latest first)' })
  list(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query() q: PublishListQueryDto) {
    return this.publishing.list(workspaceId, q);
  }

  @Patch('/jobs/:id')
  @RequireWorkspaceRole('MEMBER')
  @ApiOperation({ summary: 'Change the caption or the time of a post that has not gone out' })
  patch(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: PublishPatchDto) {
    return this.publishing.patch(workspaceId, id, body);
  }

  @Post('/jobs/:id/cancel')
  @RequireWorkspaceRole('MEMBER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a scheduled post' })
  cancel(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.publishing.cancel(workspaceId, id);
  }

  @Post('/jobs/:id/retry')
  @RequireWorkspaceRole('MEMBER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Try a failed post again' })
  retry(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.publishing.retry(workspaceId, id);
  }

  @Post('/share')
  @RequireWorkspaceRole('AUDITOR')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'A one-hour link to a file, for WhatsApp Status and native share sheets' })
  share(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: ShareDto) {
    return this.publishing.share(workspaceId, body.mediaKey);
  }
}

/**
 * The OAuth return leg. One fixed URL per platform per environment — it is
 * what gets registered in the Meta and TikTok developer consoles — so it
 * cannot carry a workspace id in its path; that rides in the state cookie.
 */
@ApiTags('publishing')
@Controller({ path: 'publishing', version: '1' })
export class PublishingCallbackController {
  constructor(private readonly publishing: PublishingService) {}

  @Public()
  @Get('/callback/:platform')
  @ApiOperation({ summary: 'Where the platform sends the browser after consent' })
  @ApiResponse({ status: 302, description: 'Back to the publishing page with ?connected= or ?error=' })
  callback(@Param('platform') platform: string, @Query() q: ConnectCallbackQueryDto, @Req() req: Request, @Res() res: Response) {
    return this.publishing.connectCallback(platformOf(platform), q, req, res);
  }
}
