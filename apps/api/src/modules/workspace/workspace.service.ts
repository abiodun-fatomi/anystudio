/**
 * A workspace as its members see it. Small for now: identity and the profile
 * the welcome screen collects. Members, brand kit and settings land here as
 * they are built.
 */
import { Injectable } from '@nestjs/common';
import { currencyForCountry } from '@anystudio/shared';
import { PrismaClient } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import type { Request } from 'express';
import { authLog } from '../auth/auth.log';
import { Helpers } from '../../utils/helpers';
import { MediaService } from '../media/media.service';
import type { WorkspaceCreateDto, WorkspaceDeleteDto, WorkspaceProfileDto, WorkspaceUpdateDto } from './workspace.dto';
import { RegistrationService } from '../auth/registration.service';

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly db: PrismaClient,
    private readonly media: MediaService,
  ) {}

  /**
   * A second workspace for a signed-in person: they own it, it has its own
   * wallet, and it starts empty — the welcome credits were for their first
   * one. An ORGANIZATION is what unlocks the developer section. Five per
   * person keeps the switcher a list and not a search.
   */
  async create(actorId: string, dto: WorkspaceCreateDto, req: Request) {
    const owned = await this.db.workspaceMember.count({ where: { userId: actorId, role: 'OWNER', workspace: { deletedAt: null } } });
    if (owned >= 5) throw new ConflictError('Five workspaces is the limit for one account. Delete one you no longer use first.');
    const seed = await this.db.workspaceMember.findFirst({
      where: { userId: actorId },
      include: { workspace: { select: { currency: true, region: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const ws = await this.db.workspace.create({
      data: {
        type: dto.type,
        name: dto.name.trim(),
        currency: dto.billingCountry
          ? currencyForCountry(dto.billingCountry)
          : (seed?.workspace.currency ?? currencyForCountry(RegistrationService.countryOfRequest(req))),
        profile: dto.billingCountry ? { billingCountry: dto.billingCountry.toUpperCase() } : {},
        region: seed?.workspace.region ?? 'ng',
        members: { create: { userId: actorId, role: 'OWNER' } },
        wallet: { create: {} },
      },
      select: { id: true, type: true, name: true, currency: true, region: true },
    });
    authLog('workspace.create', 'succeeded', { userId: actorId, workspaceId: ws.id, type: ws.type }, req);
    return Helpers.successResponse(201, 'Workspace created', ws);
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
