/**
 * Platform leads: the /org contact form, kept whole.
 *
 * A platform that writes in says who they are, what they move a month, when
 * they want to be live and what would stop it — and every one of those is
 * the reason for the call back, so every one is stored. Public and
 * rate-limited by address; a honeypot for the bots that fill every field;
 * an email to LEADS_EMAIL when it is set, and the row in the staff console
 * whether or not it is. Nothing is unique: an organization that writes twice
 * has more to say, not a duplicate.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { PrismaClient, type Lead } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { NotFoundError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { Mailer } from '../../utils/mail-service';
import { AuthModule } from '../auth/auth.module';
import { Public, RequireStaff, RequireSurface } from '../auth/decorators';

export class LeadDto {
  @ApiProperty({ example: 'Bimbo Marketplace' }) @IsString() @Length(2, 160) organization!: string;
  @ApiProperty() @IsEmail() @MaxLength(254) email!: string;
  @ApiPropertyOptional({ example: 'Head of Product' }) @IsOptional() @IsString() @MaxLength(120) role?: string;
  @ApiPropertyOptional({ example: '5,000 images and 200 reels' }) @IsOptional() @IsString() @MaxLength(160) volume?: string;
  @ApiPropertyOptional({ example: 'Before the December sale' }) @IsOptional() @IsString() @MaxLength(160) timeline?: string;
  @ApiPropertyOptional({ description: 'Anything that would stop this working.' }) @IsOptional() @IsString() @MaxLength(4000) notes?: string;
  @ApiPropertyOptional({ default: 'org-contact' }) @IsOptional() @IsString() @Matches(/^[a-z0-9-]{1,40}$/) source?: string;
  /** Honeypot. People never see it; a bot fills it; a filled one is dropped quietly. */
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) website?: string;
}

export class LeadsQueryDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() cursor?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) take?: number;
  /** `open` (default) hides handled leads; `all` shows them too. */
  @ApiPropertyOptional({ enum: ['open', 'all'] }) @IsOptional() @Matches(/^(open|all)$/) show?: 'open' | 'all';
}

export class LeadPatchDto {
  @ApiProperty() @IsBoolean() handled!: boolean;
}

export interface LeadView {
  id: string;
  organization: string;
  email: string;
  role: string | null;
  volume: string | null;
  timeline: string | null;
  notes: string | null;
  source: string;
  handledAt: string | null;
  createdAt: string;
}

const clean = (s: string | undefined) => {
  const t = s?.trim();
  return t ? t : null;
};

@Injectable()
export class LeadsService {
  constructor(
    private readonly db: PrismaClient,
    private readonly mailer: Mailer,
  ) {}

  async create(dto: LeadDto, req: Request): Promise<{ ok: true; id?: string }> {
    if (dto.website?.trim()) {
      logger.warn({ ip: req.ip, source: dto.source ?? 'org-contact' }, 'lead dropped: honeypot');
      return { ok: true };
    }
    const lead = await this.db.lead.create({
      data: {
        organization: dto.organization.trim(),
        email: dto.email.trim().toLowerCase(),
        role: clean(dto.role),
        volume: clean(dto.volume),
        timeline: clean(dto.timeline),
        notes: clean(dto.notes),
        source: dto.source ?? 'org-contact',
        ip: req.ip ?? null,
      },
    });
    logger.info({ leadId: lead.id, source: lead.source }, 'lead received');
    await this.announce(lead);
    return { ok: true, id: lead.id };
  }

  /**
   * The email is the whole form, plain text, because the person reading it
   * on a phone wants to reply, not click through. Never fatal: the row is
   * already there, and the console shows it whether or not this lands.
   */
  private async announce(lead: Lead) {
    const to = process.env.LEADS_EMAIL?.trim();
    if (!to) {
      logger.warn({ leadId: lead.id }, 'LEADS_EMAIL is not set; the lead is only in the staff console');
      return;
    }
    const line = (label: string, value: string | null) => `${label}: ${value ?? '—'}`;
    const text = [
      line('Organization', lead.organization),
      line('Email', lead.email),
      line('Role', lead.role),
      line('Images and reels per month', lead.volume),
      line('Wants to be live', lead.timeline),
      '',
      'Anything that would stop this working:',
      lead.notes ?? '—',
      '',
      `Reply to ${lead.email}. Staff console → Platform leads.`,
    ].join('\n');
    await this.mailer
      .send({ to, subject: `Platform lead: ${lead.organization}`, text })
      .catch((err: unknown) => logger.error({ err, leadId: lead.id }, 'lead alert failed'));
  }

  async list(q: LeadsQueryDto): Promise<{ rows: LeadView[]; nextCursor: string | null }> {
    const take = q.take ?? 25;
    const rows = await this.db.lead.findMany({
      where: q.show === 'all' ? {} : { handledAt: null },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, take);
    return { rows: page.map(view), nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null };
  }

  async setHandled(id: string, handled: boolean): Promise<LeadView> {
    const lead = await this.db.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundError('That lead is not here.');
    const updated = await this.db.lead.update({ where: { id }, data: { handledAt: handled ? new Date() : null } });
    return view(updated);
  }
}

function view(l: Lead): LeadView {
  return {
    id: l.id,
    organization: l.organization,
    email: l.email,
    role: l.role,
    volume: l.volume,
    timeline: l.timeline,
    notes: l.notes,
    source: l.source,
    handledAt: l.handledAt?.toISOString() ?? null,
    createdAt: l.createdAt.toISOString(),
  };
}

@ApiTags('marketing')
@Controller({ path: 'leads', version: '1' })
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Public()
  @Post('/')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'A platform asks to talk (the /org contact form)' })
  create(@Body() body: LeadDto, @Req() req: Request) {
    return this.leads.create(body, req);
  }
}

@ApiTags('admin')
@RequireSurface('ADMIN')
@RequireStaff('SUPPORT')
@Controller({ path: 'admin/leads', version: '1' })
export class AdminLeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get('/')
  @ApiOperation({ summary: 'Platform leads, newest first' })
  list(@Query() q: LeadsQueryDto) {
    return this.leads.list(q);
  }

  @Patch('/:id')
  @ApiOperation({ summary: 'Mark a lead handled, or open it again' })
  patch(@Param('id', ParseUUIDPipe) id: string, @Body() body: LeadPatchDto) {
    return this.leads.setHandled(id, body.handled);
  }
}

@Module({ imports: [AuthModule], controllers: [LeadsController, AdminLeadsController], providers: [LeadsService] })
export class LeadsModule {}
