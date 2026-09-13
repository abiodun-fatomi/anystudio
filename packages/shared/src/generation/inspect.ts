/**
 * The shape of a product check — what a marketplace hears back when it asks
 * "is this photo the product the merchant says it is?"
 *
 * WHY THIS EXISTS
 * ---------------
 * A merchant on a marketplace uploads a screenshot instead of a photograph,
 * last week's price list, or a picture of themselves holding nothing. The
 * listing goes live with it, and the platform finds out from a buyer. This is
 * the call that finds out first — and it is one credit, so a platform can
 * afford to run it on every upload.
 *
 * WHAT IT NEVER DOES
 * ------------------
 * It never blocks. The answer is a verdict, a reason and one sentence of
 * advice a merchant can act on; what the platform does with that is the
 * platform's decision. A merchant who is told what is wrong fixes it. A
 * merchant who is refused opens a support ticket.
 *
 * The issue codes are a closed list on purpose: a platform localises them
 * once, and a new code is an API change rather than a new string that
 * silently appears in production one afternoon.
 */

import { z } from 'zod';

/** Every reason a check can give. Closed, so a platform can map each to its own words. */
export const INSPECT_ISSUES = [
  'screenshot',
  'document_or_text',
  'person_is_subject',
  'no_product_visible',
  'multiple_products',
  'blurry',
  'too_dark',
  'watermark_or_overlay',
  'category_mismatch',
  'name_mismatch',
  /** Added by us from the file's own dimensions, never by the model. */
  'low_resolution',
] as const;
export type InspectIssue = (typeof INSPECT_ISSUES)[number];

export const INSPECT_VERDICTS = [
  /** A photograph of a product, consistent with what was declared (if anything was). */
  'product',
  /** A product, but not the one the platform was told to expect. */
  'mismatch',
  /** A screenshot, a document, a person, an empty room — not a product photo at all. */
  'not_a_product',
  /** Too dark, too blurred or too small to say. */
  'unclear',
] as const;
export type InspectVerdict = (typeof INSPECT_VERDICTS)[number];

/** The model's half of the answer, checked on receipt. */
export const inspectModelSchema = z.object({
  verdict: z.enum(INSPECT_VERDICTS),
  confidence: z.number().min(0).max(1),
  saw: z.string().min(2).max(160),
  issues: z.array(z.enum(INSPECT_ISSUES.filter((i) => i !== 'low_resolution') as [InspectIssue, ...InspectIssue[]])).max(6),
  advice: z.string().min(5).max(240),
});

/** The whole answer, as the caller receives it. */
export const inspectOutputSchema = inspectModelSchema.extend({
  issues: z.array(z.enum(INSPECT_ISSUES)).max(8),
  /** What the platform declared, echoed so a webhook consumer need not join it back. */
  declared: z.object({ name: z.string().optional(), category: z.string().optional() }).optional(),
});
export type InspectOutput = z.infer<typeof inspectOutputSchema>;

/** The same thing as JSON Schema, handed to the model's structured-output mode. */
export const INSPECT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'confidence', 'saw', 'issues', 'advice'],
  properties: {
    verdict: {
      type: 'string',
      enum: [...INSPECT_VERDICTS],
      description:
        '"product": a photograph of a product, consistent with what was declared. "mismatch": a product, but clearly not the declared category or name. "not_a_product": a screenshot, a document, a person as the subject, or no product visible. "unclear": too dark, blurred or small to judge.',
    },
    confidence: { type: 'number', minimum: 0, maximum: 1, description: 'How sure you are of the verdict, 0 to 1' },
    saw: { type: 'string', description: 'What is actually in the picture, in at most twelve plain words' },
    issues: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string', enum: INSPECT_ISSUES.filter((i) => i !== 'low_resolution') },
      description: 'Every problem that applies, from the list only. Empty when the photo is fine.',
    },
    advice: {
      type: 'string',
      description: 'One sentence to the merchant, in plain words, saying what to do instead. Never mention AI, models or confidence.',
    },
  },
};

/** Below this on the long edge, a listing photo will not survive a product page. */
export const INSPECT_MIN_EDGE_PX = 600;
