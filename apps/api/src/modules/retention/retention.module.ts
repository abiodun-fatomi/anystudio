import { Module } from '@nestjs/common';
import { RetentionService } from './retention.service';

/** The sweeper behind the privacy policy's retention table. Runs from the worker. */
@Module({ providers: [RetentionService], exports: [RetentionService] })
export class RetentionModule {}
