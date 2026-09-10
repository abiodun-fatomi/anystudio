/** Only workflows that enforce a preservation score belong in this list. */
export const PRESERVATION_POLICIES = [
  {
    id: 'design',
    label: 'Design / flyer with a source photo',
    key: 'vertex:gemini-3-pro-image',
    capability: 'IMAGE_EDIT',
    advice: 'Start at 0.86 for exact labels and branding. Lower cautiously when layouts reposition the subject.',
  },
  {
    id: 'ironing',
    label: 'Merchant Shots — Press it',
    key: 'photoroom:edit',
    capability: 'PRODUCT_SHOT',
    advice: 'Start at 0.86. Allow wrinkle changes, but check fabric colour, logos and garment shape.',
  },
  {
    id: 'expand',
    label: 'Merchant Shots — Show more room',
    key: 'photoroom:edit',
    capability: 'PRODUCT_SHOT',
    advice: 'Start at 0.86. Added surroundings are expected; the original subject should remain intact.',
  },
  {
    id: 'text_removal',
    label: 'Merchant Shots — Take the writing off',
    key: 'photoroom:edit',
    capability: 'PRODUCT_SHOT',
    advice: 'Start at 0.86. Lower only after reviewing legitimate text removal; product labels can also be affected.',
  },
  {
    id: 'edit',
    label: 'Merchant Shots — Describe a change',
    key: 'photoroom:edit',
    capability: 'PRODUCT_SHOT',
    advice: 'Start at 0.86. Intentional changes may score lower; inspect samples before relaxing this check.',
  },
] as const;
export type PreservationUseCase = (typeof PRESERVATION_POLICIES)[number]['id'];
export function preservationAcceptance(config: unknown, useCase: string): number {
  const value = (config as { preservationAcceptance?: Record<string, unknown> } | null)?.preservationAcceptance?.[useCase];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.1 && value <= 1 ? value : 0.86;
}
export const PRESERVATION_NOT_APPLICABLE = [
  {
    label: 'Enhance / Restyle / Merchant beautify',
    advice: 'Local colour and sharpness processing, not a generative preservation gate. No acceptance score or AI provider order applies.',
  },
  {
    label: 'On-model / Ghost mannequin / Flat lay',
    advice: 'These deliberately change geometry. Scores are diagnostic only; an acceptance gate would reject intended transformations.',
  },
  {
    label: 'Image generation without a reference',
    advice: 'No original subject to compare against. Configure providers below; review visual quality and typography.',
  },
  {
    label: 'Cutout / Direct background replacement / Relight / Upscale',
    advice:
      'No enforced preservation score in these standalone paths. Provider priorities are below. New Scene background fallback uses the New Scene threshold.',
  },
  {
    label: 'Reels / UGC / Video stitching',
    advice: 'No image-preservation acceptance gate. Review motion, identity, voice and lip sync; an image threshold cannot measure these.',
  },
  {
    label: 'Text / Voiceover / Music / Dubbing / Lip sync',
    advice: 'Image preservation does not apply. Configure provider priorities below and evaluate the relevant text or audio quality.',
  },
  { label: 'Batch / Collage', advice: 'Batch children use the policy for their individual tool. Collage assembles images without a preservation score.' },
] as const;
