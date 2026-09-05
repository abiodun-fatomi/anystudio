import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { InsightsService } from './insights.service';
import { InsightsQueryDto } from './insights.dto';
import { RequireWorkspaceRole } from '../auth/decorators';

@ApiTags('insights')
@ApiCookieAuth('session')
@Controller({ path: 'workspaces/:workspaceId/insights', version: '1' })
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get()
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'What was made, what it cost, how fast, and how long the credits will last' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  overview(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query() q: InsightsQueryDto) { return this.insights.overview(workspaceId, { days: q.days ?? 30 }); }
}
