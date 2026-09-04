import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { RegistrationService } from './registration.service';
import { PasswordResetService } from './password-reset.service';
import { VerificationService } from './verification.service';
import { GoogleProvider } from './providers/google.provider';
import { AuthGuard } from './guards/auth.guard';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [LedgerModule],
  controllers: [AuthController],
  providers: [AuthService, SessionService, RegistrationService, PasswordResetService, VerificationService, GoogleProvider, AuthGuard],
  exports: [AuthService, SessionService, AuthGuard],
})
export class AuthModule {}
