import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { RequestIdMiddleware } from './common/http/request-id.middleware';
import { HealthController } from './modules/health/health.controller';

/**
 * One Prisma client for the process. Creating one per module exhausts the
 * connection pool under load, which shows up as intermittent timeouts that look
 * like a database problem and are not.
 */
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['warn', 'error'],
});

@Module({
  controllers: [HealthController],
  providers: [{ provide: PrismaClient, useValue: prisma }],
  exports: [PrismaClient],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
