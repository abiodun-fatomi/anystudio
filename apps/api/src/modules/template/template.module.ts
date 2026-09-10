import { Module } from '@nestjs/common';
import { TemplateController } from './template.controller';
import { TemplateService } from './template.service';

/** Exported because the admin console writes the catalogue and must drop the read memo. */
@Module({ controllers: [TemplateController], providers: [TemplateService], exports: [TemplateService] })
export class TemplateModule {}
