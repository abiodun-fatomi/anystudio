/**
 * Catalogue sync: a seller's store read into the workspace.
 *
 * A connection is a domain and an encrypted credential; a sync reads every
 * product the store has, upserts it, and fetches the pictures it has not
 * seen before into the media library as READY sources — so the studio can
 * start from a product with its name, price and description already known.
 *
 * Syncs run from the worker every few hours and on demand. A store that
 * refuses its credential is marked NEEDS_ATTENTION with a sentence the
 * person can act on; a store that is merely slow is tried again later.
 * Nothing here writes to the store: the credential is read-only by
 * instruction, and the connectors only ever GET.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type CatalogueProduct, type StoreConnection, type StoreKind } from '@prisma/client';
import type { Request } from 'express';
import { ConflictError, NotFoundError, ValidationError } from '../../../config/globals/errors';
import { logger } from '../../../config/logger';
import { decrypt, encrypt } from '../../utils/crypto/encrypt';
import { authLog } from '../auth/auth.log';
import type { Actor } from '../auth/policy';
import { slug } from '../generation/generation.service';
import { MediaService } from '../media/media.service';
import { NotificationService } from '../notification/notification.service';
import type { ConnectStoreDto, ProductsQueryDto } from './catalogue.dto';
import { ShopifyConnector, shopifyDomain } from './connectors/shopify';
import { StoreError, type RemoteProduct, type StoreConnector } from './connectors/types';
import { WooCommerceConnector, wooOrigin } from './connectors/woocommerce';

/** How often a connected store is re-read on its own. */
const SYNC_EVERY_MS = 6 * 60 * 60_000;
/** A claim older than this belongs to a worker that died mid-sync. */
const STALE_CLAIM_MS = 30 * 60_000;
const MAX_STORES = 5;
const MAX_PRODUCTS = 2000;

type ImageRef = { src: string; key: string };

@Injectable()
export class CatalogueService {
  private readonly connectors: Record<StoreKind, StoreConnector> = { SHOPIFY: new ShopifyConnector(), WOOCOMMERCE: new WooCommerceConnector() };

  constructor(
    private readonly db: PrismaClient,
    private readonly media: MediaService,
    private readonly notifications: NotificationService,
  ) {}

  // ------------------------------------------------------------ connections

  async stores(workspaceId: string) {
    const rows = await this.db.storeConnection.findMany({ where: { workspaceId, disconnectedAt: null }, orderBy: { createdAt: 'asc' } });
    return rows.map((s) => this.storeView(s));
  }

  /** Prove the credential against the store, then keep it. The first sync starts at once. */
  async connect(actor: Actor, workspaceId: string, dto: ConnectStoreDto, req: Request) {
    const live = await this.db.storeConnection.count({ where: { workspaceId, disconnectedAt: null } });
    if (live >= MAX_STORES) throw new ConflictError(`Up to ${MAX_STORES} stores per workspace. Disconnect one first.`);
    const { domain, credentials } = this.credentialsFor(dto);
    let info;
    try {
      info = await this.connectors[dto.kind].probe(domain, credentials);
    } catch (e) {
      if (e instanceof StoreError) throw new ValidationError({ domain: e.hint ?? 'The store could not be reached with those details.' });
      throw e;
    }
    const existing = await this.db.storeConnection.findUnique({ where: { workspaceId_kind_domain: { workspaceId, kind: dto.kind, domain: info.domain } } });
    const data = {
      label: info.name,
      credentialsEnc: encrypt(JSON.stringify(credentials)),
      status: 'CONNECTED' as const,
      lastError: null,
      nextSyncAt: new Date(),
      disconnectedAt: null,
      connectedById: actor.userId,
    };
    const store = existing
      ? await this.db.storeConnection.update({ where: { id: existing.id }, data })
      : await this.db.storeConnection.create({ data: { workspaceId, kind: dto.kind, domain: info.domain, ...data } });
    authLog(
      'catalogue.store',
      'succeeded',
      { userId: actor.userId, workspaceId, storeId: store.id, kind: dto.kind, domain: info.domain, reconnected: Boolean(existing) },
      req,
    );
    logger.info({ storeId: store.id, workspaceId, kind: dto.kind, domain: info.domain }, existing ? 'store reconnected' : 'store connected');
    // The first read happens now, in the background; the page polls the count.
    void this.sync(store.id, info.currency).catch((err: unknown) => logger.error({ err, storeId: store.id }, 'first sync failed'));
    return this.storeView(store);
  }

  async disconnect(actor: Actor, workspaceId: string, storeId: string, req: Request) {
    const store = await this.db.storeConnection.findFirst({ where: { id: storeId, workspaceId, disconnectedAt: null } });
    if (!store) throw new NotFoundError('store');
    // Products stay — the pictures are in the library and the generations
    // made from them are the seller's. Only the credential goes.
    await this.db.storeConnection.update({
      where: { id: store.id },
      data: { status: 'DISCONNECTED', disconnectedAt: new Date(), credentialsEnc: '', nextSyncAt: null },
    });
    await this.db.catalogueProduct.updateMany({ where: { storeId: store.id }, data: { active: false } });
    authLog('catalogue.store', 'succeeded', { userId: actor.userId, workspaceId, storeId: store.id, disconnected: true }, req);
    return { id: store.id, disconnected: true };
  }

  /** Read the store again now. Returns at once; the page watches lastSyncAt. */
  async syncNow(workspaceId: string, storeId: string) {
    const store = await this.db.storeConnection.findFirst({ where: { id: storeId, workspaceId, disconnectedAt: null } });
    if (!store) throw new NotFoundError('store');
    if (store.syncingSince && Date.now() - store.syncingSince.getTime() < STALE_CLAIM_MS) return { started: false, reason: 'A sync is already running.' };
    void this.sync(store.id).catch((err: unknown) => logger.error({ err, storeId: store.id }, 'sync failed'));
    return { started: true };
  }

  // --------------------------------------------------------------- products

  async products(workspaceId: string, q: ProductsQueryDto) {
    const take = q.take ?? 40;
    const rows = await this.db.catalogueProduct.findMany({
      where: {
        workspaceId,
        active: true,
        ...(q.storeId ? { storeId: q.storeId } : {}),
        ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { handle: { contains: q.q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      take: take + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      include: { store: { select: { id: true, kind: true, label: true } } },
    });
    const page = rows.slice(0, take);
    const keys = page.flatMap((p) => (p.images as ImageRef[]).map((i) => i.key)).filter(Boolean);
    const urls = keys.length ? await this.media.readUrls(workspaceId, keys).catch(() => ({}) as Record<string, string>) : {};
    return {
      rows: page.map((p) => this.productView(p, urls)),
      nextCursor: rows.length > take ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async product(workspaceId: string, id: string) {
    const p = await this.db.catalogueProduct.findFirst({ where: { id, workspaceId }, include: { store: { select: { id: true, kind: true, label: true } } } });
    if (!p) throw new NotFoundError('product');
    const keys = (p.images as ImageRef[]).map((i) => i.key).filter(Boolean);
    const urls = keys.length ? await this.media.readUrls(workspaceId, keys).catch(() => ({}) as Record<string, string>) : {};
    return this.productView(p, urls);
  }

  // ---------------------------------------------------------------- worker

  /** Stores whose next read is due. One at a time per worker; the claim is the row. */
  async syncDue(now = new Date()): Promise<number> {
    const due = await this.db.storeConnection.findMany({
      where: {
        disconnectedAt: null,
        status: { in: ['CONNECTED', 'NEEDS_ATTENTION'] },
        nextSyncAt: { lte: now },
        OR: [{ syncingSince: null }, { syncingSince: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } }],
      },
      select: { id: true },
      take: 20,
    });
    let n = 0;
    for (const s of due) {
      try {
        if (await this.sync(s.id)) n++;
      } catch (err) {
        logger.error({ err, storeId: s.id }, 'sync failed');
      }
    }
    return n;
  }

  /**
   * One full read of a store. Claims the row (conditional update), pages
   * through the products, upserts each, fetches new pictures, then marks
   * what disappeared as inactive. Returns false when someone else held the
   * claim.
   */
  async sync(storeId: string, currencyHint?: string | null): Promise<boolean> {
    const now = new Date();
    const claimed = await this.db.storeConnection.updateMany({
      where: { id: storeId, disconnectedAt: null, OR: [{ syncingSince: null }, { syncingSince: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } }] },
      data: { syncingSince: now },
    });
    if (claimed.count === 0) return false;
    const store = await this.db.storeConnection.findUniqueOrThrow({ where: { id: storeId } });
    const connector = this.connectors[store.kind];
    let credentials: Record<string, string>;
    try {
      credentials = JSON.parse(decrypt(store.credentialsEnc)) as Record<string, string>;
    } catch (err) {
      await this.finish(store, { status: 'NEEDS_ATTENTION', lastError: 'The stored credential could not be read. Connect the store again.' });
      logger.error({ err, storeId }, 'store credential unreadable');
      return true;
    }

    const seen = new Set<string>();
    let currency = currencyHint ?? null;
    let fetched = 0;
    let newPictures = 0;
    try {
      if (!currency) currency = (await connector.probe(store.domain, credentials)).currency;
      for await (const batch of connector.products(store.domain, credentials)) {
        for (const remote of batch) {
          if (fetched >= MAX_PRODUCTS) break;
          fetched++;
          seen.add(remote.externalId);
          newPictures += await this.upsert(store, remote, currency);
        }
        if (fetched >= MAX_PRODUCTS) break;
      }
      const gone = await this.db.catalogueProduct.updateMany({ where: { storeId, active: true, externalId: { notIn: [...seen] } }, data: { active: false } });
      const count = await this.db.catalogueProduct.count({ where: { storeId, active: true } });
      await this.finish(store, { status: 'CONNECTED', lastError: null, lastSyncAt: new Date(), productCount: count });
      logger.info({ storeId, workspaceId: store.workspaceId, kind: store.kind, products: count, fetched, newPictures, gone: gone.count }, 'store synced');
      if (!store.lastSyncAt && count > 0)
        await this.notifications.notifyWorkspace(store.workspaceId, null, {
          kind: 'SYSTEM',
          title: `${store.label}: ${count} product${count === 1 ? '' : 's'} ready`,
          body: 'Open the studio and start from any of them.',
          href: '/catalogue',
          refId: `store-first-sync:${storeId}`,
        });
    } catch (err) {
      const permanent = err instanceof StoreError && err.permanent;
      const hint = err instanceof StoreError ? (err.hint ?? err.message) : 'The store could not be read. It will be tried again.';
      await this.finish(store, { status: permanent ? 'NEEDS_ATTENTION' : store.status, lastError: hint });
      logger.warn({ err, storeId, workspaceId: store.workspaceId, permanent }, 'store sync did not complete');
      if (permanent)
        await this.notifications.notifyWorkspace(store.workspaceId, null, {
          kind: 'SYSTEM',
          title: `${store.label} needs attention`,
          body: hint,
          href: '/catalogue',
          refId: `store-attention:${storeId}:${new Date().toISOString().slice(0, 10)}`,
        });
    }
    return true;
  }

  // ---------------------------------------------------------------- private

  /** Returns how many pictures were fetched fresh. */
  private async upsert(store: StoreConnection, remote: RemoteProduct, currency: string | null): Promise<number> {
    const existing = await this.db.catalogueProduct.findUnique({ where: { storeId_externalId: { storeId: store.id, externalId: remote.externalId } } });
    const have = new Map<string, string>(((existing?.images as ImageRef[] | undefined) ?? []).map((i) => [i.src, i.key]));
    const images: ImageRef[] = [];
    let fresh = 0;
    for (const src of remote.imageUrls) {
      const known = have.get(src);
      if (known) {
        images.push({ src, key: known });
        continue;
      }
      try {
        const asset = await this.media.ingestUrl(store.workspaceId, store.connectedById, src);
        images.push({ src, key: asset.key });
        fresh++;
      } catch (err) {
        logger.warn({ err, storeId: store.id, externalId: remote.externalId, src }, 'product picture not fetched');
      }
    }
    const data = {
      handle: remote.handle,
      title: remote.title.slice(0, 200),
      description: remote.description,
      priceMinor: remote.priceMinor,
      currency: remote.currency ?? currency,
      url: remote.url,
      productKey: slug(remote.handle || remote.title) || remote.externalId,
      images: images as unknown as Prisma.InputJsonValue,
      active: remote.active,
      externalUpdatedAt: remote.updatedAt,
      syncedAt: new Date(),
    };
    if (existing) await this.db.catalogueProduct.update({ where: { id: existing.id }, data });
    else await this.db.catalogueProduct.create({ data: { workspaceId: store.workspaceId, storeId: store.id, externalId: remote.externalId, ...data } });
    return fresh;
  }

  private finish(store: StoreConnection, patch: Partial<Pick<StoreConnection, 'status' | 'lastError' | 'lastSyncAt' | 'productCount'>>) {
    return this.db.storeConnection.update({
      where: { id: store.id },
      data: { ...patch, syncingSince: null, nextSyncAt: new Date(Date.now() + SYNC_EVERY_MS) },
    });
  }

  private credentialsFor(dto: ConnectStoreDto): { domain: string; credentials: Record<string, string> } {
    try {
      if (dto.kind === 'SHOPIFY') {
        if (!dto.accessToken?.trim()) throw new ValidationError({ accessToken: 'The Admin API access token is needed.' });
        return { domain: shopifyDomain(dto.domain), credentials: { accessToken: dto.accessToken.trim() } };
      }
      if (!dto.consumerKey?.trim() || !dto.consumerSecret?.trim()) throw new ValidationError({ consumerKey: 'Both the consumer key and secret are needed.' });
      return { domain: wooOrigin(dto.domain), credentials: { consumerKey: dto.consumerKey.trim(), consumerSecret: dto.consumerSecret.trim() } };
    } catch (e) {
      if (e instanceof StoreError) throw new ValidationError({ domain: e.hint ?? e.message });
      throw e;
    }
  }

  private storeView(s: StoreConnection) {
    return {
      id: s.id,
      kind: s.kind,
      label: s.label,
      domain: s.domain,
      status: s.status,
      lastError: s.lastError,
      lastSyncAt: s.lastSyncAt,
      nextSyncAt: s.nextSyncAt,
      syncing: Boolean(s.syncingSince && Date.now() - s.syncingSince.getTime() < STALE_CLAIM_MS),
      productCount: s.productCount,
      connectedAt: s.createdAt,
    };
  }

  private productView(p: CatalogueProduct & { store: { id: string; kind: StoreKind; label: string } }, urls: Record<string, string>) {
    const images = (p.images as ImageRef[]).map((i) => ({ key: i.key, url: urls[i.key] ?? null })).filter((i) => i.key);
    return {
      id: p.id,
      storeId: p.storeId,
      store: p.store,
      externalId: p.externalId,
      handle: p.handle,
      title: p.title,
      description: p.description,
      priceMinor: p.priceMinor,
      currency: p.currency,
      url: p.url,
      productKey: p.productKey,
      images,
      thumbUrl: images[0]?.url ?? null,
      syncedAt: p.syncedAt,
    };
  }
}
