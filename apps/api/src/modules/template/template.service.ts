import { Injectable } from '@nestjs/common';
import { PrismaClient, type Prisma, type Template } from '@prisma/client';
import { isTemplateAssetKey, isTemplateCategory, type PresetSwatch, type TemplateView } from '@anystudio/shared';
import { MediaService } from '../media/media.service';

/**
 * The template catalogue, as the studio reads it.
 *
 * One list, global, identical for everybody — which is exactly why it is
 * cached here for a short window rather than rebuilt per request. The cost is
 * not the query; it is signing a URL for every tile, every time a panel
 * opens. Signatures are local HMAC and individually cheap, but a picker with
 * forty tiles doing it on every mount is forty for nothing.
 *
 * The cache window is deliberately well under the signature's own lifetime.
 * A URL handed out at the last moment of the window still has most of its
 * validity left, so nobody is ever served a link that expires while they are
 * looking at it. That is the only invariant this cache has to hold, and
 * tying it to a fraction of READ_TTL keeps it true if the TTL ever moves.
 */
const CACHE_TTL_MS = 4 * 60 * 1000;

interface Cached {
  at: number;
  templates: TemplateView[];
}

@Injectable()
export class TemplateService {
  private cache: Cached | null = null;

  constructor(
    private readonly db: PrismaClient,
    private readonly media: MediaService,
  ) {}

  /** Every template a seller can pick, in catalogue order within each category. */
  async list(): Promise<TemplateView[]> {
    const hit = this.cache;
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.templates;

    const rows = await this.db.template.findMany({
      where: { active: true },
      orderBy: [{ category: 'asc' }, { sort: 'asc' }, { name: 'asc' }],
    });
    const templates = await Promise.all(rows.map((row) => this.view(row)));
    this.cache = { at: Date.now(), templates };
    return templates;
  }

  /**
   * Drop the memo.
   *
   * The console calls this after every write. Without it an operator retires
   * a bad template, reloads the studio, still sees it, and reasonably
   * concludes the console does not work — four minutes of that is four
   * minutes too many when the reason someone is in there is usually that
   * something is wrong on the customer's screen right now.
   */
  invalidate(): void {
    this.cache = null;
  }

  private async view(row: Template): Promise<TemplateView> {
    return {
      code: row.code,
      name: row.name,
      note: row.note,
      // An operator can type a category that no longer exists in the shared
      // list. That is a copy mistake, not a reason to fail the whole picker,
      // so it lands in the escape-hatch chip where somebody will find it.
      category: isTemplateCategory(row.category) ? row.category : 'general',
      kind: row.kind === 'cut' ? 'cut' : 'scene',
      params: params(row.params),
      thumbnailUrl: await this.thumbnailUrl(row.thumbnailKey),
      swatch: swatch(row.swatch),
      ...(row.keywords ? { keywords: row.keywords } : {}),
    };
  }

  /**
   * A signed read for catalogue art.
   *
   * `MediaService.readUrl` refuses any key that does not begin with the
   * caller's workspace id. That check is right everywhere else and wrong
   * here: a template belongs to nobody, so there is no workspace to match.
   * `signRead` skips it — which means the prefix check below is the only
   * thing standing between this method and signing an arbitrary object, and
   * it is not optional.
   */
  private async thumbnailUrl(key: string | null): Promise<string | null> {
    if (!key || !isTemplateAssetKey(key)) return null;
    try {
      return await this.media.signRead(key);
    } catch {
      // A missing or unsignable render is a tile that falls back to its
      // gradient, never a picker that fails to open.
      return null;
    }
  }
}

function params(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The gradient a tile falls back to.
 *
 * Defaulted rather than validated away, because a template with a malformed
 * swatch must still draw something: this is the fallback's fallback, and the
 * one case where being quietly boring beats being loudly correct.
 */
function swatch(value: Prisma.JsonValue): PresetSwatch {
  const raw = value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const colors = Array.isArray(raw.colors) ? raw.colors.filter((c): c is string => typeof c === 'string' && /^#[0-9A-Fa-f]{3,8}$/.test(c)) : [];
  const ink = raw.ink === 'light' ? 'light' : 'dark';
  if (colors.length === 0) return { colors: ['#EFEBE4'], ink: 'dark' };
  return {
    colors: colors.length >= 2 ? [colors[0]!, colors[1]!] : [colors[0]!],
    ink,
    ...(raw.transparent === true ? { transparent: true } : {}),
  };
}
