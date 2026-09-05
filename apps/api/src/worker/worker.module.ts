/**
 * The worker's composition root. The same modules the API uses — one Prisma
 * client, the ledger, the generation service, the provider plane, media —
 * without the HTTP layer. It is the same codebase on purpose: a rule about
 * money that exists in one process and not the other is a rule that will be
 * broken by whichever process forgot it.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../config/database/prisma.module';
import { LedgerModule } from '../modules/ledger/ledger.module';
import { GenerationModule } from '../modules/generation/generation.module';
import { MediaModule } from '../modules/media/media.module';
import { ProviderModule } from '../modules/provider/provider.module';
import { QueueModule } from '../modules/queue/queue.module';
import { GenerationRunner } from './runner';
import { Pipelines } from './pipelines';
import { WorkerSupervisor } from './supervisor';
import { DeveloperModule } from '../modules/developer/developer.module';
import { WhatsappModule } from '../modules/whatsapp/whatsapp.module';
import { NotificationModule } from '../modules/notification/notification.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, QueueModule, ProviderModule, MediaModule, LedgerModule, GenerationModule, DeveloperModule, WhatsappModule, NotificationModule],
  providers: [Pipelines, GenerationRunner, WorkerSupervisor],
  exports: [WorkerSupervisor],
})
export class WorkerModule {}
