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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule, MailModule,
    AuthModule, OnboardingModule, LedgerModule, WalletModule, WorkspaceModule,
  ],
  controllers: [HealthController],
  providers: [
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
