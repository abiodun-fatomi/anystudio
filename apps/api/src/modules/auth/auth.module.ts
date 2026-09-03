import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { GoogleController } from './google.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { RegistrationService } from './registration.service';
import { PasswordResetService } from './password-reset.service';
import { VerificationService } from './verification.service';
import { GoogleService } from './google.service';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  controllers: [AuthController, GoogleController],
  providers: [AuthService, SessionService, RegistrationService, PasswordResetService, VerificationService, GoogleService],
  exports: [AuthService, SessionService],
})
export class AuthModule {}
