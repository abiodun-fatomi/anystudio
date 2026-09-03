import { Global, Module } from '@nestjs/common';
import { Mailer, mailerFromEnv } from './mail-service';

/** Global so any module can inject `Mailer` without re-declaring the provider. */
@Global()
@Module({
  providers: [{ provide: Mailer, useFactory: () => mailerFromEnv(process.env) }],
  exports: [Mailer],
})
export class MailModule {}
