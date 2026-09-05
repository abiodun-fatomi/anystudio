import { Module } from '@nestjs/common';
import { AdminRefundsController, BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { GatewayRegistry } from './gateways/gateway.registry';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { UsageBillingModule } from '../usage-billing/usage-billing.module';

@Module({
  imports: [AuthModule, LedgerModule, UsageBillingModule],
  controllers: [BillingController, AdminRefundsController],
  providers: [BillingService, GatewayRegistry],
  exports: [BillingService],
})
export class BillingModule {}
