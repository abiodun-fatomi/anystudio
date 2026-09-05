/** Catalogue routes: the stores a workspace has connected and the products read from them. */
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CatalogueService } from './catalogue.service';
import { ConnectStoreDto, ProductsQueryDto } from './catalogue.dto';
import { CurrentActor, RequireWorkspaceRole } from '../auth/decorators';
import type { Actor } from '../auth/policy';

@ApiTags('catalogue')
@ApiCookieAuth('session')
@Controller({ path: 'workspaces/:workspaceId/catalogue', version: '1' })
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Get('/stores')
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'Connected stores and when they were last read' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  stores(@Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.catalogue.stores(workspaceId);
  }

  @Post('/stores')
  @RequireWorkspaceRole('ADMIN')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Connect a Shopify or WooCommerce store with a read-only credential; the first sync starts at once' })
  connect(@CurrentActor() actor: Actor, @Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Body() body: ConnectStoreDto, @Req() req: Request) {
    return this.catalogue.connect(actor, workspaceId, body, req);
  }

  @Post('/stores/:storeId/sync')
  @RequireWorkspaceRole('MEMBER')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Read the store again now' })
  sync(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('storeId', ParseUUIDPipe) storeId: string) {
    return this.catalogue.syncNow(workspaceId, storeId);
  }

  @Delete('/stores/:storeId')
  @RequireWorkspaceRole('ADMIN')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Forget the credential. Products already read stay in the library.' })
  disconnect(
    @CurrentActor() actor: Actor,
    @Param('workspaceId', ParseUUIDPipe) workspaceId: string,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Req() req: Request,
  ) {
    return this.catalogue.disconnect(actor, workspaceId, storeId, req);
  }

  @Get('/products')
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'Products across connected stores, searchable' })
  products(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query() q: ProductsQueryDto) {
    return this.catalogue.products(workspaceId, q);
  }

  @Get('/products/:productId')
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'One product with its pictures signed' })
  product(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Param('productId', ParseUUIDPipe) productId: string) {
    return this.catalogue.product(workspaceId, productId);
  }
}
