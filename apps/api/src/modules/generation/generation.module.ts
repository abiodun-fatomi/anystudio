import { Module } from '@nestjs/common';
import { GenerationController } from './generation.controller';
import { GenerationEvents } from './generation.events';
import { GenerationService } from './generation.service';
import { GenerationHooks } from './generation.hooks';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  controllers: [GenerationController],
  providers: [GenerationService, GenerationEvents, GenerationHooks],
  exports: [GenerationService, GenerationEvents, GenerationHooks],
})
export class GenerationModule {}
