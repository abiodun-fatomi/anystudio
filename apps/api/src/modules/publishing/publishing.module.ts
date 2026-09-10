import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../media/media.module';
import { NotificationModule } from '../notification/notification.module';
import { PublishingService } from './publishing.service';
import { PublishingController, PublishingCallbackController } from './publishing.controller';

/** Publishing: connected Instagram and TikTok accounts, scheduled posts, the share sheet. */
@Module({
  imports: [AuthModule, MediaModule, NotificationModule],
  controllers: [PublishingController, PublishingCallbackController],
  providers: [PublishingService],
  exports: [PublishingService],
})
export class PublishingModule {}
