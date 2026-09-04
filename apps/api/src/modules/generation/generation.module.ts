import { Module } from '@nestjs/common';
import { GenerationService } from './generation.service';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  providers: [GenerationService],
  exports: [GenerationService],
})
export class GenerationModule {}
