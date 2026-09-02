/**
 * A workspace's credits, as the customer sees them.
 *
 * Read-only from the outside. Credits are moved by generation jobs, payments
 * and staff adjustments — never by a customer-facing write endpoint.
 */

import { Controller, Get, Param, Query } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { LedgerService } from '../ledger/ledger.service';
import { RequireWorkspaceRole, CurrentActor } from '../../common/guards';
import { NotFoundError } from '../../common/errors/app-error';
import type { Actor } from '../../common/policy/policy';

@Controller('workspaces/:workspaceId/wallet')
export class WalletsController {
  constructor(private readonly db: PrismaClient, private readonly ledger: LedgerService) {}

  /**
   * Balance and plan context for the Today screen.
   *
   * WHAT     Current credits, derived from the ledger's last row.
   * WHO      Any member of the workspace, including BILLING and AUDITOR.
   * COSTS    Nothing.
   * WRITES   Nothing.
   */
  @Get()
  @RequireWorkspaceRole('AUDITOR')
  async balance(@Param('workspaceId') workspaceId: string, @CurrentActor() _actor: Actor) {
    const wallet = await this.db.wallet.findUnique({ where: { workspaceId } });
    if (!wallet) throw new NotFoundError('wallet');
    return { walletId: wallet.id, currency: wallet.currency, balance: await this.ledger.balance(wallet.id) };
  }

  /**
   * The ledger, newest first.
   *
   * WHAT     Every row that ever touched this wallet: date, kind, delta,
   *          balance after. This IS the customer's statement.
   * WHO      Any member of the workspace.
   * COSTS    Nothing.
   * WRITES   Nothing. There is no write endpoint for the ledger, anywhere.
   */
  @Get('history')
  @RequireWorkspaceRole('AUDITOR')
  async history(@Param('workspaceId') workspaceId: string, @Query() q: unknown) {
    const { cursor, take } = z.object({
      cursor: z.string().uuid().optional(),
      take: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(q ?? {});
    const wallet = await this.db.wallet.findUnique({ where: { workspaceId }, select: { id: true } });
    if (!wallet) throw new NotFoundError('wallet');
    const rows = await this.ledger.history(wallet.id, take, cursor);
    return { rows, nextCursor: rows.length === take ? rows[rows.length - 1]?.id : null };
  }
}
