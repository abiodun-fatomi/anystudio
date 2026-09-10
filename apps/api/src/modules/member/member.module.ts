import { Module } from '@nestjs/common';
import { MemberController } from './member.controller';
import { MemberService } from './member.service';
import { AuthModule } from '../auth/auth.module';

@Module({ imports: [AuthModule], controllers: [MemberController], providers: [MemberService] })
export class MemberModule {}
