import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { LedgerModule } from '../ledger/ledger.module';

@Module({ imports: [LedgerModule], controllers: [WalletController], providers: [WalletService] })
export class WalletModule {}
