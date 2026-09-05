import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { SupportAssistant } from './support.assistant';
import { SupportService } from './support.service';
import { SupportController } from './support.controller';
import { SupportAdminController } from './support-admin.controller';

/** Help & support: the chat floater, its assistant, and the console's view of it. */
@Module({
  imports: [LedgerModule],
  controllers: [SupportController, SupportAdminController],
  providers: [SupportAssistant, SupportService],
  exports: [SupportService],
})
export class SupportModule {}
