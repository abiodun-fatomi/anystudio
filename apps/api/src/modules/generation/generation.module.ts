import { Module } from '@nestjs/common';
import { GenerationController } from './generation.controller';
import { GenerationEvents } from './generation.events';
import { GenerationService } from './generation.service';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  controllers: [GenerationController],
  providers: [GenerationService, GenerationEvents],
  exports: [GenerationService, GenerationEvents],
})
export class GenerationModule {}
