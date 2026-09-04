import { Global, Module } from '@nestjs/common';
import { QueueService } from './queue.service';

/** Global: the generation service and the worker both produce jobs. */
@Global()
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
