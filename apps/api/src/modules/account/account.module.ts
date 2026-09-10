import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AuthModule } from '../auth/auth.module';

@Module({ imports: [AuthModule], controllers: [AccountController], providers: [AccountService] })
export class AccountModule {}
