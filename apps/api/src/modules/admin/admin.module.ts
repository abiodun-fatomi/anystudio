import { Module } from '@nestjs/common';
import { GenerationModule } from '../generation/generation.module';
import { TemplateModule } from '../template/template.module';
import { LedgerModule } from '../ledger/ledger.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({ imports: [LedgerModule, GenerationModule, TemplateModule], controllers: [AdminController], providers: [AdminService] })
export class AdminModule {}
