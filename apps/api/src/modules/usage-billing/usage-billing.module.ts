import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AdminUsageBillingController, UsageBillingController } from './usage-billing.controller';
import { UsageBillingService } from './usage-billing.service';

@Module({
  imports: [AuthModule, LedgerModule],
  controllers: [UsageBillingController, AdminUsageBillingController],
  providers: [UsageBillingService],
  exports: [UsageBillingService],
})
export class UsageBillingModule {}
