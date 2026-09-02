import { Module } from '@nestjs/common';
import { WalletsController } from './wallets.controller';
import { LedgerModule } from '../ledger/ledger.module';

@Module({ imports: [LedgerModule], controllers: [WalletsController] })
export class WalletsModule {}
