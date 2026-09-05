/**
 * A voiceover: the seller's script, read by a voice from the catalogue.
 *
 * The voice row names the vendor and the vendor's id for the voice; the
 * runner has already routed to that vendor alone (see routingConstraint in
 * runner.ts), so all this pipeline adds is the vendor id and a clean
 * script — line breaks kept, double spaces and stray markdown removed, so
 * the read is what the seller typed and not what a text box did to it.
 */
import { ProviderError, type CapabilityParams } from '@anystudio/shared';
import type { Pipeline } from './index';

export const voiceoverPipeline: Pipeline = async (ctx) => {
  const p = ctx.row.input as CapabilityParams<'VOICEOVER'>;
  let providerVoiceId: string | undefined;
  let language = p.language;
  if (p.voiceId) {
    const voice = await ctx.db.voiceProfile.findUnique({ where: { key: p.voiceId } });
    if (!voice || !voice.active) throw new ProviderError('INVALID_INPUT', `unknown voice "${p.voiceId}"`, 'voiceover-pipeline');
    providerVoiceId = voice.providerVoiceId;
    // A Nigerian-English voice reads Nigerian English; the language follows the voice unless the seller chose another.
    if (!p.language || p.language === 'en') language = voice.language.split('-')[0] ?? 'en';
  }
  const script = p.script.replace(/[*_#`>]/g, '').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  await ctx.stage('generating', 30, 'recording');
  const result = await ctx.callProvider(
    { generationId: ctx.row.id, workspaceId: ctx.row.workspaceId, capability: 'VOICEOVER', files: ctx.files, params: { ...p, script, language, providerVoiceId } },
    { timeoutMs: ctx.budgetMs, signal: ctx.signal, onProgress: (detail, progress) => void ctx.stage('generating', progress ?? 50, detail) },
  );
  const words = script.split(/\s+/).filter(Boolean).length;
  return {
    artifacts: [...result.artifacts, { text: { script, words, voice: p.voiceId ?? null, language }, mime: 'application/json', role: 'text' }],
    providerKey: result.providerKey, providerJobId: result.providerJobId, costMinor: result.costMinor,
  };
};
