import { Module } from '@nestjs/common';
import { AudioModule } from '../audio/audio.module';
import { GenerationModule } from '../generation/generation.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ApiKeyGuard } from './api-key.guard';
import { DeveloperController } from './developer.controller';
import { DeveloperService } from './developer.service';
import { PublicApiController } from './public-api.controller';
import { PublicApiService } from './public-api.service';
import { WebhookDispatcher } from './webhook.dispatcher';

@Module({
  imports: [LedgerModule, GenerationModule, AudioModule],
  controllers: [DeveloperController, PublicApiController],
  providers: [DeveloperService, PublicApiService, WebhookDispatcher, ApiKeyGuard],
  exports: [WebhookDispatcher],
})
export class DeveloperModule {}
