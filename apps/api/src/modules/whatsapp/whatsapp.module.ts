import { Module } from '@nestjs/common';
import { AudioModule } from '../audio/audio.module';
import { BillingModule } from '../billing/billing.module';
import { GenerationModule } from '../generation/generation.module';
import { LedgerModule } from '../ledger/ledger.module';
import { WhatsappClient } from './whatsapp.client';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

@Module({
  imports: [LedgerModule, GenerationModule, AudioModule, BillingModule],
  controllers: [WhatsappController],
  providers: [WhatsappClient, WhatsappService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
