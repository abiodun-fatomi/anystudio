import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { BrandService } from './brand.service';
import { BrandKitDto } from './brand.dto';
import { RequireWorkspaceRole } from '../auth/decorators';

@ApiTags('brand')
@ApiCookieAuth('session')
@Controller({ path: 'workspaces/:workspaceId/brand', version: '1' })
export class BrandController {
  constructor(private readonly brand: BrandService) {}

  @Get()
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'The brand kit, or an empty one' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  get(@Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.brand.get(workspaceId);
  }

  @Patch()
  @RequireWorkspaceRole('ADMIN')
  @ApiOperation({ summary: 'Save what changed; omitted fields stay as they are' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  @ApiBody({ type: BrandKitDto })
  patch(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: BrandKitDto) {
    return this.brand.patch(workspaceId, body);
  }
}
