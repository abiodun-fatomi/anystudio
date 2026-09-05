import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Query, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { LibraryService } from './library.service';
import { LibraryItemPatchDto, LibraryQueryDto } from './library.dto';
import { RequireWorkspaceRole } from '../auth/decorators';

@ApiTags('library')
@ApiCookieAuth('session')
@Controller({ path: 'workspaces/:workspaceId/library', version: '1' })
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  @Get()
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'Everything made in this workspace, newest first, with search and filters' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  list(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query() q: LibraryQueryDto) { return this.library.list(workspaceId, q); }

  @Get('/products')
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'The catalogue: one row per product with a count and the newest picture' })
  products(@Param('workspaceId', ParseUUIDPipe) workspaceId: string) { return this.library.products(workspaceId); }

  @Get('/:id')
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'One item with every output signed for download and the params to make it again' })
  get(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('id', ParseUUIDPipe) id: string) { return this.library.get(workspaceId, id); }

  @Patch('/:id')
  @RequireWorkspaceRole('MEMBER')
  @ApiOperation({ summary: 'Rename, star, or move under a product' })
  patch(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: LibraryItemPatchDto) { return this.library.patch(workspaceId, id, body); }

  @Delete('/:id')
  @RequireWorkspaceRole('MEMBER')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hide it from the library; files are removed later' })
  remove(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('id', ParseUUIDPipe) id: string) { return this.library.remove(workspaceId, id); }

  @Get('/:id/download')
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'Every output as one zip, streamed' })
  download(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) { return this.library.download(workspaceId, id, res); }
}
