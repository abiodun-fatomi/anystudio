/**
 * Guided tour definitions.
 *
 * Tours are DATA, not components. A step names a CSS selector on the target
 * portal and the words to show beside it, so changing the copy is a content
 * change rather than a deploy of the tour engine.
 *
 * The version suffix in each key ("app.first-run@1") is deliberate. Onboarding
 * state is stored per user per key, so bumping the version is the only way to
 * re-run a tour for people who already finished it — which is what you want
 * after a genuine redesign, and never otherwise.
 *
 * A person who is both a customer and staff sees the app tour and the admin
 * tour once each. They are different products to learn.
 */

export type Placement = 'top' | 'bottom' | 'left' | 'right' | 'center';

export interface TourStep {
  /** Stable id, so analytics can say which step people quit on. */
  id: string;
  /** Element to spotlight. Omit for a centred step with no target. */
  target?: string;
  title: string;
  body: string;
  placement?: Placement;
  /** Optional: skip this step when the predicate is false at runtime. */
  when?: 'hasWorkspace' | 'hasStaffAccess' | 'isOrgOwner';
}

export interface TourDefinition {
  key: string;
  surface: 'APP' | 'ORG' | 'ADMIN';
  /** Shown on the opening step. Keep it to one line. */
  intro: string;
  steps: TourStep[];
}

/** The customer portal. Written for someone who has never used a design tool. */
export const APP_FIRST_RUN: TourDefinition = {
  key: 'app.first-run@1',
  surface: 'APP',
  intro: 'Four things and you are done — about a minute.',
  steps: [
    {
      id: 'welcome',
      placement: 'center',
      title: 'This is your studio.',
      body: 'Everything you make on WhatsApp shows up here too, because your phone number is the account. Let me point out four things, then leave you alone.',
    },
    {
      id: 'create',
      target: '[data-tour="create"]',
      placement: 'right',
      title: 'Start here',
      body: 'One photo of a product, its name and its price. You get back branded images, a description, captions and a reel.',
    },
    {
      id: 'credits',
      target: '[data-tour="credits"]',
      placement: 'bottom',
      title: 'What things cost',
      body: 'An image is 10 credits, a reel is 120. You always see the price before you spend it, and a failed generation gives the credits straight back.',
    },
    {
      id: 'brand',
      target: '[data-tour="brand-kit"]',
      placement: 'right',
      title: 'Set this up once',
      body: 'Your logo, colours and the way you write. After this, everything comes out looking like you without being asked.',
    },
    {
      id: 'publish',
      target: '[data-tour="publishing"]',
      placement: 'right',
      title: 'Send it out',
      body: 'Connect Instagram, TikTok or WhatsApp Status once. Nothing is ever posted without you confirming it first.',
    },
  ],
};

/** The organization portal. Written for the engineer, who decides whether it stays. */
export const ORG_FIRST_RUN: TourDefinition = {
  key: 'org.first-run@1',
  surface: 'ORG',
  intro: 'The five things worth knowing before your first call.',
  steps: [
    {
      id: 'welcome',
      placement: 'center',
      title: 'Your organization is live.',
      body: 'Test keys work immediately, on 500 free credits. Nothing here needs a card or a conversation.',
    },
    {
      id: 'projects',
      target: '[data-tour="projects"]',
      placement: 'right',
      title: 'One project per environment',
      body: 'Staging and production get separate keys, quotas, rate limits and webhooks — so a test run can never bill against production.',
    },
    {
      id: 'keys',
      target: '[data-tour="keys"]',
      placement: 'right',
      title: 'Keys rotate without downtime',
      body: 'Creating a new key leaves the old one working. Both are live until you revoke the old one yourself — no cutover at 2am.',
    },
    {
      id: 'requests',
      target: '[data-tour="requests"]',
      placement: 'right',
      title: 'Every call is here',
      body: 'Status, latency, credit cost and a request id. Quote that id to support and we find the exact call — usually faster than writing the ticket.',
    },
    {
      id: 'merchants',
      target: '[data-tour="merchants"]',
      placement: 'right',
      title: 'Usage per merchant, from the first call',
      body: 'Pass a merchant id and we account for it separately, so you can check your billing model works before you commit to anything.',
    },
  ],
};

/**
 * The staff console. Shorter and blunter, because the audience is internal and
 * the risk is different: the thing a new operator most needs to understand is
 * what is permanent.
 */
export const ADMIN_FIRST_RUN: TourDefinition = {
  key: 'admin.first-run@1',
  surface: 'ADMIN',
  intro: 'Three rules, then the console.',
  steps: [
    {
      id: 'welcome',
      placement: 'center',
      title: 'Everything you do here is recorded.',
      body: 'Name, timestamp, address and the reason you typed. That log has no delete, including for superadmins. Work as though it will be read, because one day it will be.',
    },
    {
      id: 'ledger',
      target: '[data-tour="ledgers"]',
      placement: 'right',
      title: 'The ledger is never edited',
      body: 'A correction is a new ADJUSTMENT row with a reason. You cannot change history here, and that is deliberate — it is what makes the balance defensible when a customer disputes it.',
    },
    {
      id: 'impersonation',
      target: '[data-tour="people"]',
      placement: 'right',
      title: 'Viewing an account is read-only',
      body: 'You can see exactly what the customer sees. You cannot act as them, and they can see afterwards that you looked.',
    },
    {
      id: 'conflict',
      placement: 'center',
      title: 'You cannot action your own workspace',
      body: 'If you are a customer as well as staff, the console will refuse anything touching your own account. Ask a colleague — that is the whole control.',
    },
  ],
};

export const TOURS: Record<string, TourDefinition> = {
  [APP_FIRST_RUN.key]: APP_FIRST_RUN,
  [ORG_FIRST_RUN.key]: ORG_FIRST_RUN,
  [ADMIN_FIRST_RUN.key]: ADMIN_FIRST_RUN,
};

/** The tour a surface offers to someone who has not seen it. */
export const FIRST_RUN_BY_SURFACE = {
  APP: APP_FIRST_RUN.key,
  ORG: ORG_FIRST_RUN.key,
  ADMIN: ADMIN_FIRST_RUN.key,
} as const;
