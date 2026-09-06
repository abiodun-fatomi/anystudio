/**
 * The waitlist: an email and where it was left. Public, rate-limited by
 * address, one row per email per source; a repeat is a 409 the page treats
 * as success, because the person's intent is met either way.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Injectable, Module, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Prisma, PrismaClient } from '@prisma/client';
import { IsEmail, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { Request } from 'express';
import { ConflictError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { AuthModule } from '../auth/auth.module';
import { Public, RequireStaff, RequireSurface } from '../auth/decorators';

export class WaitlistDto {
  @ApiProperty() @IsEmail() @MaxLength(254) email!: string;
  @ApiPropertyOptional({ default: 'mobile' }) @IsOptional() @IsString() @Matches(/^[a-z0-9-]{1,40}$/) source?: string;
}

@Injectable()
export class WaitlistService {
  constructor(private readonly db: PrismaClient) {}

  async join(dto: WaitlistDto, req: Request) {
    const email = dto.email.trim().toLowerCase();
    const source = dto.source ?? 'mobile';
    try {
      await this.db.waitlistSignup.create({ data: { email, source, ip: req.ip ?? null } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictError('Already on the list.');
      throw e;
    }
    logger.info({ source }, 'waitlist signup');
    return { ok: true };
  }

  async summary() {
    const rows = await this.db.waitlistSignup.groupBy({ by: ['source'], _count: true });
    const latest = await this.db.waitlistSignup.findMany({ orderBy: { createdAt: 'desc' }, take: 50, select: { email: true, source: true, createdAt: true } });
    return { bySource: rows.map((r) => ({ source: r.source, count: r._count })), latest };
  }
}

@ApiTags('marketing')
@Controller({ path: 'waitlist', version: '1' })
export class WaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Public()
  @Post('/')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Join the waitlist' })
  join(@Body() body: WaitlistDto, @Req() req: Request) {
    return this.waitlist.join(body, req);
  }
}

@ApiTags('admin')
@RequireSurface('ADMIN')
@RequireStaff('SUPPORT')
@Controller({ path: 'admin/waitlist', version: '1' })
export class AdminWaitlistController {
  constructor(private readonly waitlist: WaitlistService) {}

  @Get('/')
  @ApiOperation({ summary: 'Counts per source and the latest signups' })
  summary() {
    return this.waitlist.summary();
  }
}

@Module({ imports: [AuthModule], controllers: [WaitlistController, AdminWaitlistController], providers: [WaitlistService] })
export class WaitlistModule {}
