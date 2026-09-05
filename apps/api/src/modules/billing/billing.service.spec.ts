/**
 * Payments: the properties that keep money honest.
 *
 * The signature checks are pure and run everywhere. The settlement tests run
 * against Postgres (skipped without DATABASE_URL, always in CI) with the stub
 * gateway, because the properties that matter — one grant per payment however
 * many times we are told, credits withheld on a mismatch, a refund taking
 * them back — are ledger properties.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { NotificationService } from '../notification/notification.service';
import { GenerationHooks } from '../generation/generation.hooks';
import { PrismaClient } from '@prisma/client';
import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import { PaddleGateway } from './gateways/paddle.gateway';
import { FlutterwaveGateway } from './gateways/flutterwave.gateway';
import { GatewayRegistry } from './gateways/gateway.registry';
import { BillingService, priceIn } from './billing.service';
import { providerForCurrency, toMinor } from './billing.types';
import { LedgerService } from '../ledger/ledger.service';
import type { AuthService } from '../auth/auth.service';
import type { Actor } from '../auth/policy';

describe('Paddle signature', () => {
  const secret = 'pdl_ntfset_test';
  const body = Buffer.from('{"event_id":"evt_1","event_type":"transaction.completed","data":{"id":"txn_1"}}');
  it('accepts ts:h1 over the raw body and rejects a tampered body or an old timestamp', () => {
    const ts = Math.floor(Date.now() / 1000);
    const h1 = createHmac('sha256', secret).update(`${ts}:`).update(body).digest('hex');
    expect(PaddleGateway.verifySignature(`ts=${ts};h1=${h1}`, body, secret)).toBe(true);
    expect(PaddleGateway.verifySignature(`ts=${ts};h1=${h1}`, Buffer.from(body.toString() + ' '), secret)).toBe(false);
    expect(PaddleGateway.verifySignature(`ts=${ts};h1=${h1}`, body, 'other')).toBe(false);
    expect(PaddleGateway.verifySignature(`ts=${ts - 3600};h1=${createHmac('sha256', secret).update(`${ts - 3600}:`).update(body).digest('hex')}`, body, secret)).toBe(false);
    // Key rotation: two h1 values, either may match.
    expect(PaddleGateway.verifySignature(`ts=${ts};h1=deadbeef;h1=${h1}`, body, secret)).toBe(true);
  });
  it('parses a webhook into a receipt id and an intent', () => {
    const g = new PaddleGateway('key', secret, 'sandbox');
    const ts = Math.floor(Date.now() / 1000);
    const raw = Buffer.from(JSON.stringify({ event_id: 'evt_9', event_type: 'transaction.completed', data: { id: 'txn_9', customer_id: 'ctm_1', subscription_id: null, custom_data: { reference: 'as_pack_abc' } } }));
    const parsed = g.parseWebhook(raw, { 'paddle-signature': `ts=${ts};h1=${createHmac('sha256', secret).update(`${ts}:`).update(raw).digest('hex')}` });
    expect(parsed.signatureOk).toBe(true);
    expect(parsed.eventId).toBe('evt_9');
    expect(g.interpret(parsed)).toMatchObject({ kind: 'charge', reference: 'as_pack_abc', providerRef: 'txn_9', status: 'succeeded' });
  });
});

describe('Flutterwave signature', () => {
  const g = new FlutterwaveGateway('FLWSECK-x', 'my-dashboard-hash');
  const raw = Buffer.from(JSON.stringify({ event: 'charge.completed', data: { id: 123, tx_ref: 'as_pack_x', amount: 5000, currency: 'NGN', status: 'successful', customer: { email: 'A@b.ng' } } }));
  it('accepts the dashboard hash in verif-hash and the v4 HMAC, rejects anything else', () => {
    expect(g.parseWebhook(raw, { 'verif-hash': 'my-dashboard-hash' }).signatureOk).toBe(true);
    expect(g.parseWebhook(raw, { 'verif-hash': 'wrong' }).signatureOk).toBe(false);
    expect(g.parseWebhook(raw, {}).signatureOk).toBe(false);
    expect(g.parseWebhook(raw, { 'flutterwave-signature': createHmac('sha256', 'my-dashboard-hash').update(raw).digest('hex') }).signatureOk).toBe(true);
  });
  it('derives a stable event id and a charge intent', () => {
    const p = g.parseWebhook(raw, { 'verif-hash': 'my-dashboard-hash' });
    expect(p.eventId).toBe('charge.completed:123');
    expect(g.interpret(p)).toMatchObject({ kind: 'charge', reference: 'as_pack_x', providerRef: '123', status: 'succeeded', customerRef: 'a@b.ng' });
  });
});

describe('pricing helpers', () => {
  it('routes African currencies to Flutterwave and the rest to Paddle', () => {
    expect(providerForCurrency('NGN')).toBe('FLUTTERWAVE');
    expect(providerForCurrency('kes')).toBe('FLUTTERWAVE');
    expect(providerForCurrency('USD')).toBe('PADDLE');
    expect(providerForCurrency('EUR')).toBe('PADDLE');
  });
  it('never converts: a missing tier is null, not a guess', () => {
    expect(priceIn({ USD: 9, NGN: 12000 }, 'ngn')).toBe(12000);
    expect(priceIn({ USD: 9 }, 'GBP')).toBeNull();
    expect(toMinor(12000, 'NGN')).toBe(1_200_000);
    expect(toMinor(5000, 'UGX')).toBe(5000);
  });
});

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('BillingService (stub gateway, real ledger)', () => {
  const db = new PrismaClient();
  const ledger = new LedgerService(db);
  const registry = new GatewayRegistry();
  const auth = { publicOrigin: () => 'https://app.test' } as unknown as AuthService;
  const service = new BillingService(db, ledger, registry, auth, new NotificationService(db, new GenerationHooks()));
  const req = { ip: '127.0.0.1', requestId: 'req_test', get: () => 'test' } as unknown as Request;

  let workspaceId: string; let walletId: string; let userId: string;
  const actor = (role = 'OWNER'): Actor => ({ userId, surface: 'APP', staffRole: null, workspaceRoles: new Map([[workspaceId, role as 'OWNER']]), mfaLevel: 0, lastStepUpAt: null, impersonating: false });

  beforeAll(async () => {
    await db.$connect();
    await db.creditPack.upsert({ where: { code: 'test.pack' }, create: { code: 'test.pack', credits: 200, priceByMarket: { NGN: 5000, USD: 4 } }, update: { credits: 200, priceByMarket: { NGN: 5000, USD: 4 }, active: true } });
    await db.plan.upsert({ where: { code: 'test.plan' }, create: { code: 'test.plan', credits: 600, priceByMarket: { NGN: 12000, USD: 9 }, yearlyPriceByMarket: { NGN: 120000, USD: 90 } }, update: { credits: 600, priceByMarket: { NGN: 12000, USD: 9 }, yearlyPriceByMarket: { NGN: 120000, USD: 90 }, active: true } });
  });
  afterAll(async () => { await db.$disconnect(); });

  beforeEach(async () => {
    const user = await db.user.create({ data: { email: `bill-${crypto.randomUUID()}@test.local`, name: 'Buyer' } });
    userId = user.id;
    const ws = await db.workspace.create({ data: { type: 'BUSINESS', name: 'Shop', currency: 'NGN', members: { create: { userId, role: 'OWNER' } }, wallet: { create: {} } }, include: { wallet: true } });
    workspaceId = ws.id; walletId = ws.wallet!.id;
  });

  it('prices on the server, and the catalogue speaks the workspace currency', async () => {
    const c = await service.catalogue(workspaceId);
    expect(c.currency).toBe('NGN');
    expect(c.provider).toBe('STUB');
    expect(c.packs.find((p) => p.code === 'test.pack')?.price).toBe(5000);
    expect(c.plans.find((p) => p.code === 'test.plan')?.year?.price).toBe(120000);
  });

  it('a pack: checkout writes a PENDING row at the server price; verifying grants once however often it is asked', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    expect(out.amountMinor).toBe(500_000);
    expect(out.url).toContain('/billing/return?ref=');
    const row = await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } });
    expect(row.status).toBe('PENDING');
    expect(await ledger.balance(walletId)).toBe(0);

    const first = await service.verifyPayment(workspaceId, out.paymentId, { providerRef: 'stub_x' }, req);
    expect(first.status).toBe('SUCCEEDED');
    expect(await ledger.balance(walletId)).toBe(200);
    // The return page checks again, and the webhook arrives twice.
    await service.verifyPayment(workspaceId, out.paymentId, {}, req);
    const hook = JSON.stringify({ id: 'evt_a_' + out.reference, type: 'charge', reference: out.reference, providerRef: 'stub_x', status: 'succeeded' });
    expect((await service.handleWebhook('STUB', Buffer.from(hook), { 'x-stub-signature': 'stub' })).outcome).toBe('already_settled');
    expect((await service.handleWebhook('STUB', Buffer.from(hook), { 'x-stub-signature': 'stub' })).status).toBe('duplicate');
    expect(await ledger.balance(walletId)).toBe(200);
    expect(await db.ledgerEntry.count({ where: { walletId } })).toBe(1);
  });

  it('a webhook with a bad signature is recorded and does nothing', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    const hook = JSON.stringify({ id: 'evt_b_' + out.reference, type: 'charge', reference: out.reference, status: 'succeeded' });
    const r = await service.handleWebhook('STUB', Buffer.from(hook), { 'x-stub-signature': 'nope' });
    expect(r.status).toBe('rejected');
    expect(await ledger.balance(walletId)).toBe(0);
    const receipt = await db.webhookReceipt.findUnique({ where: { provider_eventId: { provider: 'STUB', eventId: 'evt_b_' + out.reference } } });
    expect(receipt?.signatureOk).toBe(false);
    expect(receipt?.outcome).toBe('bad_signature');
  });

  it('a charge that does not match the priced row withholds credits and marks the row', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await db.payment.update({ where: { id: out.paymentId }, data: { providerPayload: { stub: 'short' } } });
    const r = await service.verifyPayment(workspaceId, out.paymentId, {}, req);
    expect(r.status).toBe('FAILED');
    expect(r.failureReason).toMatch(/mismatch/);
    expect(await ledger.balance(walletId)).toBe(0);
  });

  it('a pending charge stays pending; a declined one fails without a grant', async () => {
    const a = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await db.payment.update({ where: { id: a.paymentId }, data: { providerPayload: { stub: 'pending' } } });
    expect((await service.verifyPayment(workspaceId, a.paymentId, {}, req)).status).toBe('PENDING');
    const b = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await db.payment.update({ where: { id: b.paymentId }, data: { providerPayload: { stub: 'failed' } } });
    expect((await service.verifyPayment(workspaceId, b.paymentId, {}, req)).status).toBe('FAILED');
    expect(await ledger.balance(walletId)).toBe(0);
  });

  it('a plan: creates the subscription, refuses a second plan, renews from a gateway charge, cancels at period end', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan', interval: 'year' }, req);
    expect(out.amountMinor).toBe(12_000_000);
    await service.verifyPayment(workspaceId, out.paymentId, {}, req);
    const sub = await service.subscription(workspaceId);
    expect(sub).toMatchObject({ planCode: 'test.plan', interval: 'year', status: 'ACTIVE' });
    expect(await ledger.balance(walletId)).toBe(600);
    await expect(service.checkout(actor(), workspaceId, { kind: 'plan', code: 'test.plan' }, req)).rejects.toMatchObject({ status: 409 });

    // The gateway renews: a charge we have no row for, on a subscription we know.
    const renew = JSON.stringify({ id: 'evt_renew_' + workspaceId, type: 'charge', providerRef: 'stub_renew', status: 'succeeded', subscriptionRef: `stubsub_${workspaceId.slice(0, 8)}` });
    const r = await service.handleWebhook('STUB', Buffer.from(renew), { 'x-stub-signature': 'stub' });
    expect(r.outcome).toBe('granted');
    expect(await ledger.balance(walletId)).toBe(1200);
    expect(await db.payment.count({ where: { workspaceId, kind: 'RENEWAL', status: 'SUCCEEDED' } })).toBe(1);

    const cancelled = await service.cancelSubscription(actor(), workspaceId, req);
    expect(cancelled.cancelAtPeriodEnd).toBe(true);
    const gone = JSON.stringify({ id: 'evt_cancel_' + workspaceId, type: 'subscription', subscriptionRef: `stubsub_${workspaceId.slice(0, 8)}`, subStatus: 'cancelled' });
    await service.handleWebhook('STUB', Buffer.from(gone), { 'x-stub-signature': 'stub' });
    expect(await service.subscription(workspaceId)).toBeNull();
  });

  it('a refund takes the credits back once, and a refund after they were spent is recorded for a person', async () => {
    const out = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, out.paymentId, { providerRef: 'stub_r1' }, req);
    expect(await ledger.balance(walletId)).toBe(200);
    const refund = JSON.stringify({ id: 'evt_refund_' + out.reference, type: 'refund', providerRef: 'stub_r1' });
    expect((await service.handleWebhook('STUB', Buffer.from(refund), { 'x-stub-signature': 'stub' })).outcome).toBe('refunded');
    expect(await ledger.balance(walletId)).toBe(0);
    expect((await db.payment.findUniqueOrThrow({ where: { id: out.paymentId } })).status).toBe('REFUNDED');

    const again = await service.checkout(actor(), workspaceId, { kind: 'pack', code: 'test.pack' }, req);
    await service.verifyPayment(workspaceId, again.paymentId, { providerRef: 'stub_r2' }, req);
    await ledger.debit({ walletId, amount: 150, idempotencyKey: `spend-${again.paymentId}` });
    const r = await service.handleWebhook('STUB', Buffer.from(JSON.stringify({ id: 'evt_refund_' + again.reference, type: 'refund', providerRef: 'stub_r2' })), { 'x-stub-signature': 'stub' });
    expect(r.outcome).toBe('refunded_clawback_failed');
    expect(await ledger.balance(walletId)).toBe(50);
  });

  it('only the owner, an admin or the billing contact can buy', async () => {
    await expect(service.checkout(actor('MEMBER'), workspaceId, { kind: 'pack', code: 'test.pack' }, req)).rejects.toMatchObject({ status: 403 });
    await expect(service.checkout(actor('BILLING'), workspaceId, { kind: 'pack', code: 'test.pack' }, req)).resolves.toMatchObject({ credits: 200 });
  });
});
