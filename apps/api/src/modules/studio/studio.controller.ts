import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { RequireWorkspaceRole } from '../auth/decorators';
import { CaptionsDto, IdeasDto } from './studio.dto';
import { StudioService } from './studio.service';

@ApiTags('studio')
@ApiCookieAuth('session')
@Controller({ version: '1' })
export class StudioController {
  constructor(private readonly studio: StudioService) {}

  @Post('/workspaces/:workspaceId/studio/ideas')
  @RequireWorkspaceRole('MEMBER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Three creative directions for this product and this tool, written by the copy model from the photo' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  ideas(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() dto: IdeasDto) {
    return this.studio.ideas(workspaceId, dto);
  }

  @Post('/workspaces/:workspaceId/studio/captions')
  @RequireWorkspaceRole('MEMBER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Three captions with hashtags for a post, aimed at a platform and a goal, from the picture and the seller' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  captions(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() dto: CaptionsDto) {
    return this.studio.captions(workspaceId, dto);
  }
}
