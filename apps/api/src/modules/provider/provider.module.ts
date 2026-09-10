/**
 * The provider plane: the registry of adapters this process can use and the
 * router that picks between them from config rows. Global, because the
 * worker's pipelines and the studio's cost quotes both ask it questions.
 */
import { Global, Module } from '@nestjs/common';
import { ProviderRegistry } from './provider.registry';
import { ProviderRouter } from './provider.router';

@Global()
@Module({
  providers: [ProviderRegistry, ProviderRouter],
  exports: [ProviderRegistry, ProviderRouter],
})
export class ProviderModule {}
