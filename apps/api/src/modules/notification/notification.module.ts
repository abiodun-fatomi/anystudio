import { Global, Module } from '@nestjs/common';
import { GenerationModule } from '../generation/generation.module';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

/** Global: billing, members and the admin console all write to the bell. */
@Global()
@Module({ imports: [GenerationModule], controllers: [NotificationController], providers: [NotificationService], exports: [NotificationService] })
export class NotificationModule {}
