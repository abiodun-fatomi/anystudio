/**
 * Anthropic — Claude for copy that has to hold a brand voice.
 *
 * Structured output is asked for as a forced tool call whose input schema is
 * the JSON schema the pipeline supplied: the model cannot answer except by
 * filling the schema, which is the most reliable JSON any vendor offers.
 */

import { ProviderError, type Capability, type ProviderInput, type ProviderOpts, type ProviderResult } from '@anystudio/shared';
import { BaseProvider } from './base';
import { fetchBytes, http, pick } from './http';

const KNOWN: Record<string, { capability: Capability; model: string }> = {
  'anthropic:claude-haiku-4.5': { capability: 'TEXT_GENERATE', model: 'claude-haiku-4-5' },
};

export class AnthropicProvider extends BaseProvider {
  static all(apiKey: string): AnthropicProvider[] {
    return Object.entries(KNOWN).map(([key, k]) => new AnthropicProvider(apiKey, key, k.capability, k.model));
  }

  constructor(
    private readonly apiKey: string,
    key: string,
    capability: Capability,
    private readonly defaultModel: string,
  ) {
    super(key, [capability]);
  }

  async generate(input: ProviderInput, opts: ProviderOpts): Promise<ProviderResult> {
    const req = input.prompt;
    if (input.capability !== 'TEXT_GENERATE' || !req) throw new ProviderError('INVALID_INPUT', `${this.key}: needs a prepared prompt`, this.key);
    const model = this.str(input.config, 'model', this.defaultModel);

    const content: unknown[] = [];
    for (const part of req.parts) {
      if ('text' in part) content.push({ type: 'text', text: part.text });
      else {
        const { bytes, mime } = await fetchBytes(this.key, part.imageUrl, opts.timeoutMs);
        content.push({ type: 'image', source: { type: 'base64', media_type: mime, data: Buffer.from(bytes).toString('base64') } });
      }
    }

    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxTokens ?? 2048,
      temperature: req.temperature ?? 0.7,
      system: req.system,
      messages: [{ role: 'user', content }],
    };
    if (req.jsonSchema) {
      body.tools = [{ name: 'emit', description: 'Return the result in the required structure.', input_schema: req.jsonSchema }];
      body.tool_choice = { type: 'tool', name: 'emit' };
    }

    const res = await http<unknown>(this.key, 'https://api.anthropic.com/v1/messages', {
      headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });

    const stop = pick<string>(res.json, 'stop_reason');
    const blocks = pick<Array<{ type: string; text?: string; input?: unknown }>>(res.json, 'content') ?? [];
    if (req.jsonSchema) {
      const tool = blocks.find((b) => b.type === 'tool_use');
      if (!tool) throw new ProviderError('RETRYABLE', `${this.key}: no tool_use block (stop=${stop})`, this.key, { raw: res.json });
      return {
        providerKey: this.key,
        providerJobId: pick<string>(res.json, 'id'),
        artifacts: [{ mime: 'application/json', role: 'text', text: tool.input }],
        meta: { model, usage: pick(res.json, 'usage') },
      };
    }
    const text = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    if (!text) throw new ProviderError('RETRYABLE', `${this.key}: empty completion (stop=${stop})`, this.key);
    return {
      providerKey: this.key,
      providerJobId: pick<string>(res.json, 'id'),
      artifacts: [{ mime: 'text/plain', role: 'text', text }],
      meta: { model, usage: pick(res.json, 'usage') },
    };
  }
}
