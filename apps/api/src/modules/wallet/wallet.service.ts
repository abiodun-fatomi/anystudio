/**
 * A workspace's credits, as the customer sees them.
 *
 * Read-only from the outside. Credits are moved by generation jobs, payments
 * and staff adjustments through LedgerService — never by a customer-facing
 * write endpoint, and there is no write endpoint for the ledger anywhere.
 */
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { LedgerService } from '../ledger/ledger.service';
import { NotFoundError } from '../../../config/globals/errors';
import { Helpers } from '../../utils/helpers';
import type { WalletHistoryQueryDto } from './wallet.dto';

@Injectable()
export class WalletService {
  constructor(private readonly db: PrismaClient, private readonly ledger: LedgerService) {}

  /** Current credits, derived from the ledger's last row. */
  async balance(workspaceId: string) {
    const wallet = await this.db.wallet.findUnique({ where: { workspaceId } });
    if (!wallet) throw new NotFoundError('wallet');
    const balance = await this.ledger.balance(wallet.id);
    return Helpers.successResponse(200, 'OK', { walletId: wallet.id, currency: wallet.currency, balance });
  }

  /** Every row that ever touched this wallet, newest first. This IS the statement. */
  async history(workspaceId: string, q: WalletHistoryQueryDto) {
    const take = q.take ?? 50;
    const wallet = await this.db.wallet.findUnique({ where: { workspaceId }, select: { id: true } });
    if (!wallet) throw new NotFoundError('wallet');
    const rows = await this.ledger.history(wallet.id, take, q.cursor);
    return Helpers.successResponse(200, 'OK', { rows, nextCursor: rows.length === take ? (rows[rows.length - 1]?.id ?? null) : null });
  }
}
