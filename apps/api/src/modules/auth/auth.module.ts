import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { RegistrationService } from './registration.service';
import { PasswordResetService } from './password-reset.service';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  controllers: [AuthController],
  providers: [AuthService, SessionService, RegistrationService, PasswordResetService],
  exports: [AuthService, SessionService],
})
export class AuthModule {}
