/**
 * Composition root.
 *
 * Global pieces are registered here once — the auth guard, the exception
 * filter, the response envelope, the request-id middleware — so no module can
 * opt out by omission. Feature modules own their controllers and services and
 * import only what they need.
 */
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../config/database/prisma.module';
import { RateLimitModule } from '../config/rate-limit/rate-limit.module';
import { RateLimitGuard } from '../config/rate-limit/rate-limit.guard';
import { RequestIdMiddleware } from '../config/globals/RequestMiddleWareId';
import { GlobalExceptionFilter } from '../config/globals/exceptionHandler';
import { ResponseEnvelopeInterceptor } from '../config/globals/responseEnvelope';
import { MailModule } from './utils/mail.module';
import { AuthGuard } from './modules/auth/guards/auth.guard';
import { HealthController } from './modules/health/health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { WorkspaceModule } from './modules/workspace/workspace.module';
import { GenerationModule } from './modules/generation/generation.module';
import { QueueModule } from './modules/queue/queue.module';
import { ProviderModule } from './modules/provider/provider.module';
import { MediaModule } from './modules/media/media.module';
import { BrandModule } from './modules/brand/brand.module';
import { AccountModule } from './modules/account/account.module';
import { MemberModule } from './modules/member/member.module';
import { BillingModule } from './modules/billing/billing.module';
import { LibraryModule } from './modules/library/library.module';
import { InsightsModule } from './modules/insights/insights.module';
import { AudioModule } from './modules/audio/audio.module';
import { DeveloperModule } from './modules/developer/developer.module';
import { WhatsappModule } from './modules/whatsapp/whatsapp.module';
import { NotificationModule } from './modules/notification/notification.module';
import { AdminModule } from './modules/admin/admin.module';
import { SupportModule } from './modules/support/support.module';
import { PublishingModule } from './modules/publishing/publishing.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    MailModule,
    RateLimitModule,
    QueueModule,
    ProviderModule,
    MediaModule,
    AuthModule,
    OnboardingModule,
    LedgerModule,
    WalletModule,
    WorkspaceModule,
    GenerationModule,
    BrandModule,
    AccountModule,
    MemberModule,
    BillingModule,
    LibraryModule,
    InsightsModule,
    AudioModule,
    DeveloperModule,
    WhatsappModule,
    NotificationModule,
    AdminModule,
    SupportModule,
    PublishingModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // '{*path}' is Express 5's spelling of "every route".
    consumer.apply(RequestIdMiddleware).forRoutes('{*path}');
  }
}
