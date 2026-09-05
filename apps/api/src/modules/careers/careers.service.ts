/**
 * Careers: openings staff write in the console, shown on the marketing site;
 * applications come back with a CV in storage and a note to whoever hires.
 *
 * The public side is deliberately small — read the open roles, presign one
 * CV, post one application — and defends itself the cheap ways: a honeypot
 * field, an address-scoped rate limit, one application per opening per
 * email address, and CVs accepted only as PDF or Word up to 8 MB, checked
 * again by HEAD after the upload so a claimed size is not a trusted one.
 */
import { Injectable } from '@nestjs/common';
import { PrismaClient, type JobApplication, type JobPosting } from '@prisma/client';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { marketingHost, type AppEnv } from '@anystudio/shared';
import { ConflictError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { applicationReceived } from '../../assets/email-templates';
import { Mailer } from '../../utils/mail-service';
import { authLog } from '../auth/auth.log';
import { assertStaff, type Actor } from '../auth/policy';
import { slug as slugify } from '../generation/generation.service';
import { MediaService } from '../media/media.service';
import type { ApplicationPatchDto, ApplicationsQueryDto, ApplyDto, CvUploadDto, JobDto, JobPatchDto } from './careers.dto';

const CV_MAX_BYTES = 8 * 1024 * 1024;
const CV_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

@Injectable()
export class CareersService {
  constructor(
    private readonly db: PrismaClient,
    private readonly media: MediaService,
    private readonly mailer: Mailer,
  ) {}

  // ---------------------------------------------------------------- public

  async openings() {
    const rows = await this.db.jobPosting.findMany({ where: { status: 'OPEN' }, orderBy: [{ publishedAt: 'desc' }] });
    return rows.map((j) => this.jobView(j));
  }

  async opening(slug: string) {
    const job = await this.db.jobPosting.findFirst({ where: { slug, status: 'OPEN' } });
    if (!job) throw new NotFoundError('opening');
    return this.jobView(job);
  }

  /** A signed PUT for the CV. The key is random, so nobody can guess another applicant's file. */
  async presignCv(dto: CvUploadDto) {
    const ext = CV_EXT[dto.mime];
    if (!ext) throw new ValidationError({ mime: 'PDF or Word only.' });
    if (dto.bytes > CV_MAX_BYTES) throw new ValidationError({ bytes: 'Up to 8 MB.' });
    const key = `careers/${new Date().toISOString().slice(0, 7)}/${randomBytes(18).toString('base64url')}.${ext}`;
    const { url, expiresInSec } = await this.media.presignRaw(key, dto.mime, dto.bytes);
    return { key, url, method: 'PUT', headers: { 'content-type': dto.mime }, expiresInSec };
  }

  async apply(dto: ApplyDto, req: Request) {
    // Bots fill every field, including the one people cannot see.
    if (dto.website?.trim()) {
      logger.warn({ ip: req.ip, slug: dto.slug }, 'application dropped: honeypot');
      return { ok: true };
    }
    const job = await this.db.jobPosting.findFirst({ where: { slug: dto.slug, status: 'OPEN' } });
    if (!job) throw new NotFoundError('opening');
    const email = dto.email.trim().toLowerCase();
    const dup = await this.db.jobApplication.findFirst({ where: { jobId: job.id, email }, select: { id: true } });
    if (dup) throw new ConflictError('You have already applied for this opening. Reply to your confirmation email to add anything.');
    if (!dto.cvKey && !dto.links?.trim()) throw new ValidationError({ cvKey: 'Attach a CV, or give at least one link.' });
    if (dto.cvKey) {
      if (!/^careers\/\d{4}-\d{2}\/[A-Za-z0-9_-]{20,}\.(pdf|docx?)$/.test(dto.cvKey)) throw new ValidationError({ cvKey: 'That upload is not recognised.' });
      const head = await this.media.head(dto.cvKey);
      if (!head) throw new ValidationError({ cvKey: 'The CV did not finish uploading. Try attaching it again.' });
      if (head.bytes > CV_MAX_BYTES) throw new ValidationError({ cvKey: 'The CV is larger than 8 MB.' });
    }
    const app = await this.db.jobApplication.create({
      data: {
        jobId: job.id,
        name: dto.name.trim(),
        email,
        phone: dto.phone?.trim() || null,
        links: dto.links?.trim() || null,
        coverNote: dto.coverNote?.trim() || null,
        cvKey: dto.cvKey ?? null,
        cvName: dto.cvName?.trim().slice(0, 200) || null,
        ip: req.ip ?? null,
      },
    });
    logger.info({ applicationId: app.id, jobId: job.id, slug: job.slug }, 'application received');
    const raw = process.env.APP_ENV;
    const env: AppEnv = raw === 'production' || raw === 'staging' || raw === 'dev' ? raw : 'local';
    // Never from a request header: this mail goes to an address anyone can type in.
    const origin = env === 'local' ? 'http://localhost:3000' : `https://${marketingHost(env)}`;
    await this.mailer
      .send(applicationReceived(email, app.name, { title: job.title, team: job.team, url: `${origin}/careers/${job.slug}` }))
      .catch((err: unknown) => logger.error({ err, applicationId: app.id }, 'application mail failed'));
    const alert = process.env.CAREERS_EMAIL?.trim();
    if (alert)
      await this.mailer
        .send({
          to: alert,
          subject: `New application: ${job.title} — ${app.name}`,
          text: `${app.name} <${email}>${app.phone ? ` · ${app.phone}` : ''}\n${app.links ?? ''}\n\n${app.coverNote ?? ''}\n\nStaff console → Careers → ${job.title}.`,
        })
        .catch((err: unknown) => logger.error({ err, applicationId: app.id }, 'application alert failed'));
    return { ok: true, id: app.id };
  }

  // ----------------------------------------------------------------- staff

  async jobs() {
    const rows = await this.db.jobPosting.findMany({ orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }] });
    const counts = await this.db.jobApplication.groupBy({ by: ['jobId', 'status'], _count: true });
    return rows.map((j) => ({
      ...this.jobView(j),
      applications: counts.filter((c) => c.jobId === j.id).reduce((n, c) => n + c._count, 0),
      newApplications: counts.filter((c) => c.jobId === j.id && c.status === 'NEW').reduce((n, c) => n + c._count, 0),
    }));
  }

  async createJob(actor: Actor, dto: JobDto, req: Request) {
    assertStaff(actor, 'ADMIN');
    const slug = await this.freeSlug(dto.slug ?? slugify(dto.title));
    const status = dto.status ?? 'DRAFT';
    const job = await this.db.jobPosting.create({
      data: {
        slug,
        title: dto.title.trim(),
        team: dto.team.trim(),
        location: dto.location.trim(),
        remote: dto.remote ?? true,
        type: dto.type ?? 'FULL_TIME',
        summary: dto.summary.trim(),
        description: dto.description.trim(),
        salary: dto.salary?.trim() || null,
        status,
        publishedAt: status === 'OPEN' ? new Date() : null,
        createdById: actor.userId,
      },
    });
    authLog('careers.job', 'succeeded', { userId: actor.userId, jobId: job.id, slug: job.slug, status: job.status, created: true }, req);
    return this.jobView(job);
  }

  async updateJob(actor: Actor, id: string, dto: JobPatchDto, req: Request) {
    assertStaff(actor, 'ADMIN');
    const job = await this.db.jobPosting.findUnique({ where: { id } });
    if (!job) throw new NotFoundError('opening');
    const data: Record<string, unknown> = {};
    for (const k of ['title', 'team', 'location', 'summary', 'description'] as const) if (dto[k] !== undefined) data[k] = dto[k]!.trim();
    if (dto.remote !== undefined) data.remote = dto.remote;
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.salary !== undefined) data.salary = dto.salary?.trim() || null;
    if (dto.slug !== undefined && dto.slug !== job.slug) data.slug = await this.freeSlug(dto.slug);
    if (dto.status !== undefined && dto.status !== job.status) {
      data.status = dto.status;
      if (dto.status === 'OPEN') data.publishedAt = job.publishedAt ?? new Date();
      if (dto.status === 'CLOSED') data.closedAt = new Date();
      if (dto.status === 'DRAFT') data.closedAt = null;
    }
    const updated = await this.db.jobPosting.update({ where: { id }, data });
    authLog('careers.job', 'succeeded', { userId: actor.userId, jobId: id, slug: updated.slug, status: updated.status, fields: Object.keys(data) }, req);
    return this.jobView(updated);
  }

  async deleteJob(actor: Actor, id: string, req: Request) {
    assertStaff(actor, 'ADMIN');
    const job = await this.db.jobPosting.findUnique({ where: { id }, include: { _count: { select: { applications: true } } } });
    if (!job) throw new NotFoundError('opening');
    if (job._count.applications > 0) throw new ConflictError('This opening has applications. Close it instead of deleting it, so they are kept.');
    await this.db.jobPosting.delete({ where: { id } });
    authLog('careers.job', 'succeeded', { userId: actor.userId, jobId: id, slug: job.slug, deleted: true }, req);
    return { id, deleted: true };
  }

  async applications(actor: Actor, q: ApplicationsQueryDto) {
    assertStaff(actor, 'SUPPORT');
    const take = q.take ?? 25;
    const rows = await this.db.jobApplication.findMany({
      where: { ...(q.jobId ? { jobId: q.jobId } : {}), ...(q.status ? { status: q.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { job: { select: { id: true, title: true, slug: true, team: true } } },
    });
    const page = rows.slice(0, take);
    return { rows: page.map((a) => this.applicationView(a)), nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null };
  }

  async application(actor: Actor, id: string) {
    assertStaff(actor, 'SUPPORT');
    const a = await this.db.jobApplication.findUnique({ where: { id }, include: { job: { select: { id: true, title: true, slug: true, team: true } } } });
    if (!a) throw new NotFoundError('application');
    const cvUrl = a.cvKey ? await this.media.signRead(a.cvKey, 15 * 60).catch(() => null) : null;
    return { ...this.applicationView(a), cvUrl };
  }

  async updateApplication(actor: Actor, id: string, dto: ApplicationPatchDto, req: Request) {
    assertStaff(actor, 'OPERATOR');
    const a = await this.db.jobApplication.findUnique({ where: { id } });
    if (!a) throw new NotFoundError('application');
    const updated = await this.db.jobApplication.update({
      where: { id },
      data: { ...(dto.status !== undefined ? { status: dto.status } : {}), ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}) },
      include: { job: { select: { id: true, title: true, slug: true, team: true } } },
    });
    authLog('careers.application', 'succeeded', { userId: actor.userId, applicationId: id, jobId: a.jobId, status: updated.status }, req);
    return this.applicationView(updated);
  }

  // ---------------------------------------------------------------- private

  private async freeSlug(base: string): Promise<string> {
    const root = slugify(base) || 'role';
    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? root : `${root}-${i + 1}`;
      const taken = await this.db.jobPosting.findUnique({ where: { slug: candidate }, select: { id: true } });
      if (!taken) return candidate;
    }
    throw new ConflictError('Could not find a free URL name for that title.');
  }

  private jobView(j: JobPosting) {
    return {
      id: j.id,
      slug: j.slug,
      title: j.title,
      team: j.team,
      location: j.location,
      remote: j.remote,
      type: j.type,
      summary: j.summary,
      description: j.description,
      salary: j.salary,
      status: j.status,
      publishedAt: j.publishedAt,
      closedAt: j.closedAt,
      updatedAt: j.updatedAt,
    };
  }

  private applicationView(a: JobApplication & { job: { id: string; title: string; slug: string; team: string } }) {
    return {
      id: a.id,
      job: a.job,
      name: a.name,
      email: a.email,
      phone: a.phone,
      links: a.links,
      coverNote: a.coverNote,
      cvName: a.cvName,
      hasCv: Boolean(a.cvKey),
      status: a.status,
      notes: a.notes,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  }
}
