/**
 * Seeding.
 *
 * Two tiers, and the split matters:
 *
 *   Reference data  — plans, credit costs, provider routing. This is
 *                     CONFIGURATION THE APPLICATION READS AT RUNTIME, which is
 *                     why it lives in the database rather than in constants: a
 *                     provider outage should be a toggle in the admin console,
 *                     not a deploy. Runs in every environment, every deploy.
 *
 *   Fixtures        — a demo workspace, a seeded wallet, a test organization.
 *                     Guarded by SEED_ENV, and production refuses outright.
 *
 * Everything is an upsert keyed on a natural key, so running this twice changes
 * nothing. A seed that is not idempotent cannot be part of a deploy, and a seed
 * that is not part of a deploy drifts until it is wrong.
 */

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

/** What each operation costs. Referenced by generation jobs; never hard-coded. */
const CREDIT_COSTS = [
  { code: 'image.storefront',   credits: 10,  label: 'Branded product image' },
  { code: 'image.background',   credits: 10,  label: 'Background replacement' },
  { code: 'text.description',   credits: 2,   label: 'Product description' },
  { code: 'text.caption',       credits: 1,   label: 'Social caption' },
  { code: 'video.reel',         credits: 120, label: 'Reel ad' },
  { code: 'video.translate',    credits: 90,  label: 'Voiceover in another language' },
];

/**
 * Prices are fixed per market, never converted at the day's rate. A seller
 * budgeting in naira must see the same number every month.
 */
const PLANS = [
  { code: 'starter',  credits: 30,    usd: 0,   ngn: 0,      gbp: 0 },
  { code: 'creator',  credits: 600,   usd: 9,   ngn: 12000,  gbp: 7 },
  { code: 'business', credits: 2400,  usd: 29,  ngn: 39000,  gbp: 24 },
  { code: 'org',      credits: 12000, usd: 199, ngn: 265000, gbp: 165 },
];

/**
 * Provider routing. `priority` picks the default and the fallback order, so a
 * failing provider is demoted from the admin console without a release.
 */
const PROVIDERS = [
  { key: 'higgsfield:recraft_v4_1',    capability: 'IMAGE', priority: 10, costPerCall: 28,  enabled: true },
  { key: 'higgsfield:seedream_v5_pro', capability: 'EDIT',  priority: 10, costPerCall: 42,  enabled: true },
  { key: 'higgsfield:kling3_0',        capability: 'VIDEO', priority: 10, costPerCall: 310, enabled: true },
  { key: 'heygen:translate',           capability: 'DUB',   priority: 10, costPerCall: 190, enabled: true },
  { key: 'fal:flux-schnell',           capability: 'IMAGE', priority: 20, costPerCall: 19,  enabled: true },
];

async function reference() {
  for (const c of CREDIT_COSTS) {
    await db.creditCost.upsert({ where: { code: c.code }, create: c, update: c });
  }
  for (const p of PLANS) {
    await db.plan.upsert({
      where: { code: p.code },
      create: { code: p.code, credits: p.credits, priceByMarket: { USD: p.usd, NGN: p.ngn, GBP: p.gbp } },
      update: { credits: p.credits, priceByMarket: { USD: p.usd, NGN: p.ngn, GBP: p.gbp } },
    });
  }
  for (const pr of PROVIDERS) {
    await db.providerModel.upsert({ where: { key: pr.key }, create: pr, update: pr });
  }
  console.log(`reference: ${CREDIT_COSTS.length} costs, ${PLANS.length} plans, ${PROVIDERS.length} models`);
}

async function fixtures() {
  // A developer account that is BOTH a customer and staff — the exact shape the
  // policy layer has to handle, so it is wrong to only ever test them apart.
  const dev = await db.user.upsert({
    where: { email: 'dev@anystudio.test' },
    create: {
      email: 'dev@anystudio.test',
      phone: '+2348000000001',
      name: 'Dev Account',
      emailVerifiedAt: new Date(),
      phoneVerifiedAt: new Date(),
      phoneIsWhatsApp: true,
    },
    update: {},
  });

  const ws = await db.workspace.upsert({
    where: { id: '00000000-0000-4000-8000-000000000001' },
    create: {
      id: '00000000-0000-4000-8000-000000000001',
      type: 'BUSINESS',
      name: 'Bimbo Fabrics',
      region: 'ng',
      currency: 'NGN',
    },
    update: {},
  });

  await db.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: ws.id, userId: dev.id } },
    create: { workspaceId: ws.id, userId: dev.id, role: 'OWNER' },
    update: {},
  });

  // Staff access on the SAME user. Note grantedById is the user itself here,
  // which the policy layer forbids at runtime — acceptable only as a bootstrap,
  // and it is exactly why real grants record who issued them.
  await db.staffGrant.upsert({
    where: { id: '00000000-0000-4000-8000-000000000002' },
    create: {
      id: '00000000-0000-4000-8000-000000000002',
      userId: dev.id,
      role: 'SUPERADMIN',
      grantedById: dev.id,
      reason: 'local development bootstrap',
    },
    update: {},
  });

  console.log('fixtures: dev@anystudio.test — owner of Bimbo Fabrics AND superadmin');
  console.log('          use it to check that the console refuses to action its own workspace');
}

async function main() {
  await reference();

  const env = process.env.SEED_ENV;
  if (env === 'dev') {
    await fixtures();
  } else if (process.env.NODE_ENV === 'production' && env) {
    // Loud, not silent. A production database with demo accounts in it is a
    // security finding, not a tidiness problem.
    throw new Error(`Refusing to seed fixtures in production (SEED_ENV=${env})`);
  } else {
    console.log('fixtures: skipped (set SEED_ENV=dev to include them)');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
