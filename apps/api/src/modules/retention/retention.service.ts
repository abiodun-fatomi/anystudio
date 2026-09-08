/**
 * Retention: the sweeper that makes the privacy policy true.
 *
 * The policy (apps/web: /privacy §9–10) promises four things on a clock, and
 * each is one method here, run by the worker a few times a day:
 *
 *   accounts     a person who asked to leave is anonymised DELETION_GRACE_DAYS
 *                later — email, phone, name, picture, credentials, sessions and
 *                contact rows go; the User row stays as a tombstone so the
 *                ledger and audit trail still add up. Workspaces where they
 *                were the only member are soft-deleted with them.
 *   objects      files in storage behind soft-deleted media, and behind
 *                soft-deleted workspaces, are removed after the same grace
 *                period — soft-delete is undoable for thirty days, then real.
 *   events       security events older than a year, request-level detail
 *                nobody needs after that.
 *   applications job applications a year after the posting closed, with the CV.
 *   support      support conversations two years after they closed.
 *
 * Every method is idempotent and bounded (a batch per run), so a run that
 * dies halfway is finished by the next one. Nothing here touches the ledger,
 * payments or invoices: those are kept as tax law requires, anonymised by
 * the account step because they point at the tombstone, not at a name.
 */
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { logger } from '../../../config/logger';
import { MediaService } from '../media/media.service';
import { DELETION_GRACE_DAYS } from '../account/account.service';

export const AUTH_EVENT_DAYS = 365;
export const APPLICATION_DAYS = 365;
export const SUPPORT_DAYS = 730;
const BATCH = 200;

const ago = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60_000);

export interface RetentionReport {
  accounts: number;
  workspaces: number;
  objects: number;
  events: number;
  applications: number;
  support: number;
}

@Injectable()
export class RetentionService {
  constructor(
    private readonly db: PrismaClient,
    private readonly media: MediaService,
  ) {}

  /** One pass over everything due. Each step is guarded so one failing does not hold the rest. */
  async run(): Promise<RetentionReport> {
    const report: RetentionReport = { accounts: 0, workspaces: 0, objects: 0, events: 0, applications: 0, support: 0 };
    const step = async (name: keyof RetentionReport, fn: () => Promise<number>, also?: (n: number) => void) => {
      try {
        const n = await fn();
        report[name] = n;
        also?.(n);
      } catch (err) {
        logger.error({ err, step: name }, 'retention step failed');
      }
    };
    await step('accounts', async () => {
      const r = await this.purgeAccounts();
      report.workspaces = r.workspaces;
      return r.accounts;
    });
    await step('objects', () => this.purgeObjects());
    await step('events', () => this.pruneAuthEvents());
    await step('applications', () => this.pruneApplications());
    await step('support', () => this.pruneSupport());
    if (Object.values(report).some((n) => n > 0)) logger.info(report, 'retention sweep');
    return report;
  }

  // ------------------------------------------------------------- accounts

  async purgeAccounts(): Promise<{ accounts: number; workspaces: number }> {
    const due = await this.db.user.findMany({
      where: { deleteRequestedAt: { lte: ago(DELETION_GRACE_DAYS) }, deletedAt: null },
      select: { id: true, email: true, phone: true },
      take: BATCH,
      orderBy: { deleteRequestedAt: 'asc' },
    });
    let workspaces = 0;
    for (const user of due) {
      workspaces += await this.anonymise(user.id);
      logger.info({ userId: user.id }, 'account anonymised');
    }
    return { accounts: due.length, workspaces };
  }

  /**
   * Everything that names the person goes; everything that counts stays.
   * Returns how many workspaces went with them.
   */
  private async anonymise(userId: string): Promise<number> {
    const now = new Date();
    // Workspaces where this was the only member die with the account. Where
    // others remain, the membership row is dropped and the workspace lives on.
    const memberships = await this.db.workspaceMember.findMany({
      where: { userId },
      select: { workspaceId: true, workspace: { select: { deletedAt: true, _count: { select: { members: true } } } } },
    });
    const solo = memberships.filter((m) => !m.workspace.deletedAt && m.workspace._count.members === 1).map((m) => m.workspaceId);

    await this.db.$transaction([
      this.db.user.update({
        where: { id: userId },
        data: {
          email: null,
          emailVerifiedAt: null,
          phone: null,
          phoneVerifiedAt: null,
          phoneIsWhatsApp: false,
          name: null,
          avatarKey: null,
          prefs: {},
          passwordHash: null,
          status: 'DELETED',
          credentialEpoch: { increment: 1 },
          deletedAt: now,
        },
      }),
      this.db.identity.deleteMany({ where: { userId } }),
      this.db.mfaFactor.deleteMany({ where: { userId } }),
      this.db.recoveryCode.deleteMany({ where: { userId } }),
      this.db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, revokedReason: 'account_deleted' } }),
      this.db.whatsappContact.deleteMany({ where: { userId } }),
      this.db.notification.deleteMany({ where: { userId } }),
      this.db.onboardingState.deleteMany({ where: { userId } }),
      this.db.workspaceMember.deleteMany({ where: { userId, workspaceId: { notIn: solo } } }),
      ...(solo.length ? [this.db.workspace.updateMany({ where: { id: { in: solo }, deletedAt: null }, data: { deletedAt: now } })] : []),
      // The security trail keeps its rows (they are what proves the deletion
      // happened when asked) but loses the request-level detail now.
      this.db.authEvent.updateMany({ where: { userId }, data: { ip: null, userAgent: null } }),
      this.db.authEvent.create({ data: { userId, type: 'ACCOUNT_DELETION_REQUESTED', detail: { stage: 'anonymised' } } }),
    ]);
    return solo.length;
  }

  // -------------------------------------------------------------- objects

  /**
   * Storage behind soft-deleted media/workspaces once the undo window passes,
   * plus retired pipeline scratch immediately. Scratch has no customer-facing
   * undo contract and a failed immediate delete must not occupy storage for a
   * month before its first retry.
   */
  async purgeObjects(): Promise<number> {
    const cutoff = ago(DELETION_GRACE_DAYS);
    const assets = await this.db.mediaAsset.findMany({
      where: {
        status: { not: 'PURGED' },
        OR: [
          { deletedAt: { lte: cutoff } },
          { workspace: { deletedAt: { lte: cutoff } } },
          { kind: 'DERIVED', deletedAt: { not: null }, key: { contains: '/work/' } },
        ],
      },
      select: { id: true, key: true },
      take: BATCH,
      orderBy: { createdAt: 'asc' },
    });
    let n = 0;
    for (const a of assets) {
      const gone = await this.media.deleteObject(a.key);
      if (!gone) continue;
      await this.db.mediaAsset.update({ where: { id: a.id }, data: { status: 'PURGED', deletedAt: new Date() } });
      n += 1;
    }
    return n;
  }

  // --------------------------------------------------------------- events

  async pruneAuthEvents(): Promise<number> {
    const { count } = await this.db.authEvent.deleteMany({ where: { createdAt: { lt: ago(AUTH_EVENT_DAYS) } } });
    return count;
  }

  // --------------------------------------------------------- applications

  async pruneApplications(): Promise<number> {
    const apps = await this.db.jobApplication.findMany({
      where: { job: { closedAt: { lt: ago(APPLICATION_DAYS) } } },
      select: { id: true, cvKey: true },
      take: BATCH,
    });
    for (const a of apps) {
      if (a.cvKey) await this.media.deleteObject(a.cvKey);
      await this.db.jobApplication.delete({ where: { id: a.id } });
    }
    return apps.length;
  }

  // -------------------------------------------------------------- support

  async pruneSupport(): Promise<number> {
    const { count } = await this.db.supportConversation.deleteMany({ where: { closedAt: { lt: ago(SUPPORT_DAYS) } } });
    return count;
  }
}
