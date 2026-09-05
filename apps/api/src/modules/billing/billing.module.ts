import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { GatewayRegistry } from './gateways/gateway.registry';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({ imports: [AuthModule, LedgerModule], controllers: [BillingController], providers: [BillingService, GatewayRegistry], exports: [BillingService] })
export class BillingModule {}
