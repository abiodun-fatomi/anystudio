import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WalletService } from './wallet.service';
import { WalletHistoryQueryDto } from './wallet.dto';
import { RequireWorkspaceRole } from '../auth/decorators';

@ApiTags('wallet')
@ApiCookieAuth('session')
@Controller({ path: 'workspaces/:workspaceId/wallet', version: '1' })
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'Credit balance for the Today screen' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'walletId, currency, balance' })
  @ApiResponse({ status: 403, description: 'Not a member of this workspace' })
  balance(@Param('workspaceId', ParseUUIDPipe) workspaceId: string) {
    return this.walletService.balance(workspaceId);
  }

  @Get('/history')
  @RequireWorkspaceRole('AUDITOR')
  @ApiOperation({ summary: 'The ledger, newest first — the customer\'s statement' })
  @ApiParam({ name: 'workspaceId', format: 'uuid' })
  history(@Param('workspaceId', ParseUUIDPipe) workspaceId: string, @Query() query: WalletHistoryQueryDto) {
    return this.walletService.history(workspaceId, query);
  }
}
