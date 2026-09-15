/**
 * Platform leads: the /org contact form, kept whole.
 *
 * A platform that writes in says who they are, what they move a month, when
 * they want to be live and what would stop it — and every one of those is
 * the reason for the call back, so every one is stored. Public and
 * rate-limited by address; a honeypot for the bots that fill every field;
 * an acknowledgement to the sender with what they wrote, so the promise on
 * the page ("within one working day") has a record behind it; the whole
 * form emailed to the MAIL_FROM inbox — the address every reply already
 * lands in, so there is no second one to keep in step — and the row in the
 * staff console either way. Nothing is unique: an organization that writes
 * twice has more to say, not a duplicate.
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Injectable, Module, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { PrismaClient, type Lead } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { NotFoundError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { surfaceOriginFor, type AppEnv } from '@anystudio/shared';
import { leadAlert, leadReceived } from '../../assets/email-templates';
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
  /** Everything by default; `new` is what still needs a reply, `handled` what has one. */
  @ApiPropertyOptional({ enum: ['all', 'new', 'handled'], default: 'all' }) @IsOptional() @Matches(/^(all|new|handled)$/) status?: 'all' | 'new' | 'handled';
  /** Received on or after this day (YYYY-MM-DD, UTC). */
  @ApiPropertyOptional({ example: '2026-09-01' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  /** Received on or before this day (YYYY-MM-DD, UTC), inclusive. */
  @ApiPropertyOptional({ example: '2026-09-30' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
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
    await this.acknowledge(lead);
    await this.announce(lead);
    return { ok: true, id: lead.id };
  }

  /** The sender's copy. Never fatal: the row and the alert do not depend on it. */
  private async acknowledge(lead: Lead) {
    await this.mailer
      .send(leadReceived(lead.email, { organization: lead.organization, role: lead.role, volume: lead.volume, timeline: lead.timeline, notes: lead.notes }))
      .catch((err: unknown) => logger.error({ err, leadId: lead.id }, 'lead acknowledgement failed'));
  }

  /**
   * The email is the whole form, laid out to be read and answered from a
   * phone: the reply is the button. It goes to the MAIL_FROM inbox, which is
   * where a platform's reply to the acknowledgement lands anyway. Never
   * fatal: the row is already there, and the console shows it whether or
   * not this lands.
   */
  private async announce(lead: Lead) {
    const to = inboxOf(process.env.MAIL_FROM);
    if (!to) {
      logger.warn({ leadId: lead.id }, 'MAIL_FROM is not set; the lead is only in the staff console');
      return;
    }
    const raw = process.env.APP_ENV;
    const env: AppEnv = raw === 'production' || raw === 'staging' || raw === 'dev' ? raw : 'local';
    await this.mailer
      .send(
        leadAlert(to, {
          organization: lead.organization,
          email: lead.email,
          role: lead.role,
          volume: lead.volume,
          timeline: lead.timeline,
          notes: lead.notes,
          consoleUrl: `${surfaceOriginFor('ADMIN', env)}/admin/leads`,
        }),
      )
      .catch((err: unknown) => logger.error({ err, leadId: lead.id }, 'lead alert failed'));
  }

  async list(q: LeadsQueryDto): Promise<{ rows: LeadView[]; nextCursor: string | null }> {
    const take = q.take ?? 25;
    const createdAt = {
      ...(q.from ? { gte: new Date(`${q.from}T00:00:00.000Z`) } : {}),
      ...(q.to ? { lt: new Date(new Date(`${q.to}T00:00:00.000Z`).getTime() + 86_400_000) } : {}),
    };
    const rows = await this.db.lead.findMany({
      where: {
        ...(q.status === 'new' ? { handledAt: null } : q.status === 'handled' ? { handledAt: { not: null } } : {}),
        ...(Object.keys(createdAt).length ? { createdAt } : {}),
      },
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

/** The bare address in a `Name <addr>` or plain `addr` sender line; null when there is none. */
export function inboxOf(from: string | undefined): string | null {
  const m = from?.trim().match(/<([^<>\s]+@[^<>\s]+)>\s*$/) ?? from?.trim().match(/^([^\s<>]+@[^\s<>]+)$/);
  return m?.[1] ?? null;
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
