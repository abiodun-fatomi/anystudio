import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MediaService } from './media.service';
import { CompleteUploadDto, MediaListQueryDto, PresignUploadDto, ReadUrlQueryDto } from './media.dto';
import { CurrentActor, RequireWorkspaceRole } from '../auth/decorators';
import type { SessionActor } from '../auth/policy';

@ApiTags('media')
@ApiCookieAuth('session')
@Controller({ path: 'workspaces/:workspaceId/media', version: '1' })
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('/uploads')
  @RequireWorkspaceRole('MEMBER')
  @ApiOperation({ summary: 'Announce an upload and get a URL to PUT the bytes to' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  @ApiBody({ type: PresignUploadDto })
  @ApiResponse({ status: 201, description: 'assetId, key, url, method, headers, expiresInSec' })
  presign(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @CurrentActor() actor: SessionActor, @Body() body: PresignUploadDto) {
    return this.media.presignUpload(workspaceId, actor.userId, body);
  }

  @Post('/uploads/complete')
  @RequireWorkspaceRole('MEMBER')
  @ApiOperation({ summary: 'The PUT finished: verify the object and make it usable' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  @ApiBody({ type: CompleteUploadDto })
  @ApiResponse({ status: 400, description: 'Rejected: not a usable file, or too large' })
  complete(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: CompleteUploadDto) {
    return this.media.complete(workspaceId, body.assetId);
  }

  @Get()
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'Files in this workspace, newest first' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  list(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query() query: MediaListQueryDto) {
    return this.media.list(workspaceId, query);
  }

  @Get('/url')
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'A short-lived URL to read one object' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  async url(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query() query: ReadUrlQueryDto) {
    return { url: await this.media.readUrl(workspaceId, query.key), expiresInSec: 15 * 60 };
  }

  @Delete('/:assetId')
  @RequireWorkspaceRole('MEMBER')
  @ApiOperation({ summary: 'Remove a file from the library (soft delete)' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  @ApiParam({ name: 'assetId', format: 'uuid' })
  async remove(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('assetId', ParseUUIDPipe) assetId: string) {
    await this.media.softDelete(workspaceId, assetId);
    return { deleted: true };
  }
}
