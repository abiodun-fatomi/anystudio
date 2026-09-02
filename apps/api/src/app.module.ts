/**
 * Composition root.
 *
 * Global pieces are registered here once — the auth guard, the exception
 * filter, the request-id middleware — so no module can opt out by omission.
 * Feature modules own their controllers and services and import only what
 * they need (dependency inversion: LedgerModule exposes LedgerService, and
 * WalletsModule depends on that interface, not on Prisma tables).
 */

import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { MailModule } from './common/mail/mail.module';
import { RequestIdMiddleware } from './common/http/request-id.middleware';
import { HttpExceptionFilter } from './common/errors/http-exception.filter';
import { AuthGuard } from './common/guards';
import { HealthController } from './modules/health/health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';

@Module({
  imports: [PrismaModule, MailModule, AuthModule, OnboardingModule, LedgerModule, WalletsModule, WorkspacesModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
