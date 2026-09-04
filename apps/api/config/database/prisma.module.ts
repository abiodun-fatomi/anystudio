/**
 * One Prisma client for the whole process, provided globally.
 *
 * A client per module exhausts the connection pool under load, which surfaces
 * as intermittent timeouts that look like a database problem and are not.
 */
import { Global, Module, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

const client = new PrismaClient({ log: ['warn', 'error'] });

class PrismaLifecycle implements OnModuleDestroy {
  /** Closes the pool on shutdown so a deploy does not leave connections dangling. */
  async onModuleDestroy(): Promise<void> {
    await client.$disconnect();
  }
}

@Global()
@Module({
  providers: [{ provide: PrismaClient, useValue: client }, PrismaLifecycle],
  exports: [PrismaClient],
})
export class PrismaModule {}
