/**
 * A workspace as its members see it. Small for now: identity and the profile
 * the welcome screen collects. Members, brand kit and settings land here as
 * they are built.
 */
import { Injectable } from '@nestjs/common';
import { SIGNUP_PROMO_CREDITS, currencyForCountry, regionForCountry, signupGrantKey } from '@anystudio/shared';
import { PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import type { Request } from 'express';
import { authLog } from '../auth/auth.log';
import { Helpers } from '../../utils/helpers';
import { MediaService } from '../media/media.service';
import { LedgerService } from '../ledger/ledger.service';
import type { WorkspaceCreateDto, WorkspaceDeleteDto, WorkspaceProfileDto, WorkspaceUpdateDto } from './workspace.dto';
import { RegistrationService } from '../auth/registration.service';

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly db: PrismaClient,
    private readonly media: MediaService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * A workspace for a signed-in person: they own it and it has its own wallet.
   * Five per person keeps the switcher a list and not a search.
   *
   * THE FIRST ONE IS DIFFERENT, AND THIS IS NOW THE ONLY PLACE THAT KNOWS IT
   * ----------------------------------------------------------------------
   * This used to be strictly the SECOND-workspace path — "the welcome credits
   * were for their first one" — because every first workspace was born in
   * `registration.service.ts` or the WhatsApp onboarding, each of which
   * creates a PERSONAL studio, sets the region from the person's country, and
   * grants SIGNUP_PROMO_CREDITS.
   *
   * Google sign-in never created one at all: it wrote a User and sent them to
   * /welcome, which had no workspace to patch and bounced to /today, which
   * bounced back to /welcome. Anyone who signed up with Google could not reach
   * the product. The welcome screen now creates the workspace here, which
   * makes this the third first-workspace door — and the only one that granted
   * no credits, defaulted the region to `ng` whatever the person confirmed,
   * and called the result a BUSINESS.
   *
   * So the rule moves into the code rather than being repeated at each door:
   * if this is the person's first workspace it gets the first-workspace
   * treatment, whoever asked. The grant is idempotent on the workspace id
   * (`signupGrantKey`), so a retried request cannot mint a second 150.
   */
  async create(actorId: string, dto: WorkspaceCreateDto, req: Request) {
    const owned = await this.db.workspaceMember.count({ where: { userId: actorId, role: 'OWNER', workspace: { deletedAt: null } } });
    if (owned >= 5) throw new ConflictError('Five workspaces is the limit for one account. Delete one you no longer use first.');
    const seed = await this.db.workspaceMember.findFirst({
      where: { userId: actorId },
      include: { workspace: { select: { currency: true, region: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const first = seed === null;
    // PERSONAL is the shape of a first studio and nothing else; a second one
    // is a BUSINESS or an ORGANIZATION. Asking for PERSONAL when you already
    // have a workspace is a client bug, not a thing to silently honour.
    if (dto.type === 'PERSONAL' && !first) {
      throw new ValidationError(
        { type: 'A personal studio is only the first workspace on an account.' },
        'A personal studio is only the first workspace on an account.',
      );
    }

    const ws = await this.db.$transaction(async (tx) => {
      const created = await tx.workspace.create({
        data: {
          type: dto.type,
          name: dto.name.trim(),
          currency: dto.billingCountry
            ? currencyForCountry(dto.billingCountry)
            : (seed?.workspace.currency ?? currencyForCountry(RegistrationService.countryOfRequest(req))),
          profile: dto.billingCountry ? { billingCountry: dto.billingCountry.toUpperCase() } : {},
          // A first workspace takes its region from the country the person
          // just confirmed. Falling back to `ng` for someone who told us
          // otherwise is how a Kenyan seller ends up on Nigerian routing.
          region: first ? regionForCountry(dto.billingCountry ?? RegistrationService.countryOfRequest(req)) : (seed?.workspace.region ?? 'ng'),
          members: { create: { userId: actorId, role: 'OWNER' } },
          wallet: { create: {} },
        },
        select: { id: true, type: true, name: true, currency: true, region: true, wallet: { select: { id: true } } },
      });

      if (first && created.wallet) {
        await this.ledger.grant(
          { walletId: created.wallet.id, amount: SIGNUP_PROMO_CREDITS, idempotencyKey: signupGrantKey(created.id), reason: 'Welcome credits' },
          tx,
        );
      }
      return created;
    });

    const { wallet: _wallet, ...body } = ws;
    authLog('workspace.create', 'succeeded', { userId: actorId, workspaceId: ws.id, type: ws.type, first }, req);
    return Helpers.successResponse(201, 'Workspace created', body);
  }

  /** Name, type, currency, region, and the welcome answers. */
  async get(workspaceId: string) {
    const ws = await this.db.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true, type: true, name: true, currency: true, region: true, profile: true, createdAt: true },
    });
    if (!ws) throw new NotFoundError('workspace');
    return Helpers.successResponse(200, 'OK', ws);
  }

  /**
   * Merge the supplied fields into the profile. Omitted fields are left
   * alone, so the welcome screen and a later settings page can each send
   * only what they own.
   */
  async patchProfile(workspaceId: string, patch: WorkspaceProfileDto) {
    const current = await this.db.workspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { profile: true } });
    if (!current) throw new NotFoundError('workspace');
    const merged = { ...((current.profile as WorkspaceProfileDto | null) ?? {}), ...patch };
    const ws = await this.db.workspace.update({ where: { id: workspaceId }, data: { profile: merged }, select: { id: true, profile: true } });
    return Helpers.successResponse(200, 'Profile saved', ws);
  }

  /** Rename. Small on purpose: region and currency are support actions. */
  async update(workspaceId: string, dto: WorkspaceUpdateDto, actorId: string, req: Request) {
    const current = await this.db.workspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { id: true, currency: true } });
    if (!current) throw new NotFoundError('workspace');
    // The logo is a media asset of this workspace — the same READY check the
    // studio applies to a source photo, so a half-uploaded file never shows.
    let logo: { logoKey: string | null } | Record<string, never> = {};
    if (dto.logoKey !== undefined) {
      if (dto.logoKey === null) logo = { logoKey: null };
      else {
        const asset = await this.db.mediaAsset.findUnique({ where: { key: dto.logoKey }, select: { workspaceId: true } });
        if (!asset || asset.workspaceId !== workspaceId) throw new NotFoundError('logo');
        await this.media.requireReady(workspaceId, dto.logoKey);
        logo = { logoKey: dto.logoKey };
      }
    }
    // A gateway subscription is permanently denominated in the currency it
    // was created with. Letting the workspace change currency underneath it
    // makes a legitimate renewal look like the wrong amount/currency and can
    // leave a paid customer without credits. Packs remain portable because
    // credits themselves have no currency, but a live or pending plan must be
    // cancelled/finished before the checkout currency can change.
    const updateData = {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
      ...logo,
    };
    // Region (where files live) stays a support action. Currency changes and
    // subscription checkout take the same workspace-row lock, closing the
    // race where each request could pass its check before either wrote.
    const select = { id: true, name: true, currency: true, region: true, logoKey: true } as const;
    const ws =
      dto.currency !== undefined && dto.currency !== current.currency
        ? await this.db.$transaction(async (tx) => {
            const [lockedWorkspace] = await tx.$queryRaw<Array<{ id: string }>>`
              SELECT "id" FROM "workspaces" WHERE "id" = CAST(${workspaceId} AS uuid) AND "deletedAt" IS NULL FOR UPDATE
            `;
            if (!lockedWorkspace) throw new NotFoundError('workspace');
            const [subscription, pendingPlan] = await Promise.all([
              tx.subscription.findFirst({
                where: { workspaceId, status: { in: ['ACTIVE', 'PAST_DUE', 'PAUSED'] } },
                select: { id: true },
              }),
              tx.payment.findFirst({
                where: { workspaceId, kind: 'SUBSCRIPTION', status: 'PENDING' },
                select: { id: true },
              }),
            ]);
            if (subscription || pendingPlan) {
              throw new ConflictError('Currency cannot change while a plan is active or its checkout is pending. Cancel the plan first, then change currency.');
            }
            return tx.workspace.update({ where: { id: workspaceId }, data: updateData, select });
          })
        : await this.db.workspace.update({ where: { id: workspaceId }, data: updateData, select });
    authLog(
      'workspace.update',
      'succeeded',
      {
        userId: actorId,
        workspaceId,
        fields: Object.keys(dto),
        ...(dto.currency && dto.currency !== current.currency ? { currencyFrom: current.currency, currencyTo: dto.currency } : {}),
      },
      req,
    );
    return Helpers.successResponse(200, 'Saved', ws);
  }

  /**
   * Soft-delete. The rows stay (the ledger must balance and the audit trail
   * must read), but the workspace disappears from every member's list and
   * nothing in it can be spent or generated. Refused for a person's only
   * workspace — deleting the account is the honest version of that.
   */
  async remove(workspaceId: string, dto: WorkspaceDeleteDto, actorId: string, req: Request) {
    const ws = await this.db.workspace.findFirst({ where: { id: workspaceId, deletedAt: null }, select: { id: true, name: true } });
    if (!ws) throw new NotFoundError('workspace');
    if (dto.confirmName.trim() !== ws.name) throw new ValidationError({ confirmName: 'Type the workspace name exactly as it is shown.' });
    const others = await this.db.workspaceMember.count({ where: { userId: actorId, workspaceId: { not: workspaceId }, workspace: { deletedAt: null } } });
    if (others === 0) throw new ConflictError('This is your only workspace. To close everything, delete your account instead.');
    const live = await this.db.generation.count({ where: { workspaceId, status: { in: ['QUEUED', 'RUNNING'] } } });
    if (live > 0) throw new ConflictError(`${live} generation${live === 1 ? ' is' : 's are'} still running. Wait for them, or cancel them, first.`);
    await this.db.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "workspaces" WHERE "id" = CAST(${workspaceId} AS uuid) AND "deletedAt" IS NULL FOR UPDATE
      `;
      if (!locked) throw new NotFoundError('workspace');
      const [subscription, pendingPayment, outstandingInvoice, creditLine] = await Promise.all([
        tx.subscription.findFirst({
          where: { workspaceId, OR: [{ status: { in: ['ACTIVE', 'PAST_DUE', 'PAUSED'] } }, { providerCancelPending: true }] },
          select: { id: true },
        }),
        tx.payment.findFirst({ where: { workspaceId, status: 'PENDING' }, select: { id: true } }),
        tx.invoice.findFirst({ where: { workspaceId, status: { in: ['OPEN', 'OVERDUE', 'DISPUTED'] } }, select: { id: true } }),
        tx.billingAccount.findFirst({ where: { workspaceId, status: { not: 'CLOSED' } }, select: { id: true } }),
      ]);
      if (subscription || pendingPayment || outstandingInvoice || creditLine) {
        throw new ConflictError(
          'Billing must be closed before this workspace can be deleted. Cancel its plan, reconcile pending payments, and settle or close its credit line first.',
        );
      }
      await tx.workspace.update({ where: { id: workspaceId }, data: { deletedAt: new Date() } });
    });
    authLog('workspace.delete', 'succeeded', { userId: actorId, workspaceId }, req);
    return Helpers.successResponse(200, 'Workspace deleted', { id: workspaceId, deleted: true });
  }
}
