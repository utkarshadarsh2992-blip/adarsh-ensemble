import type { FetchLike, NewsItem, Region, Store } from './types.ts';
import { REGIONS } from './types.ts';
import { budget } from './budget.ts';
import { extractJson } from './scoring.ts';
import { groq } from './providers.ts';

export const PATTERN_CACHE_KEY = 'patterns:latest';
export const PATTERN_ATTEMPT_KEY = 'patterns:last_attempt';
export const PATTERN_WINDOW_H = 72;
export const PATTERN_CACHE_H = 6;
export const PATTERN_THROTTLE_MS = 30 * 60 * 1000;

const TYPES = ['ai-race', 'compute/datacentre buildout', 'capital flow', 'policy wave', 'supply chain', 'space race', 'talent', 'other'] as const;
const SIGNALS = ['strong', 'medium', 'weak'] as const;

type PatternType = typeof TYPES[number];
type PatternSignal = typeof SIGNALS[number];

export interface PatternRegion {
  region: Region;
  what: string;
  item_ids: string[];
}

export interface PatternItem {
  id: string;
  title: string;
  url: string;
  source: string;
  region: Region;
}

export interface NewsPattern {
  title: string;
  pattern: string;
  type: PatternType;
  regions: PatternRegion[];
  signal: PatternSignal;
  why_it_matters: string;
  watch_next: string;
  assumption: string;
  items: PatternItem[];
}

export interface PatternCache {
  generated_at: string;
  window_h: number;
  n_items: number;
  model: string;
  patterns: NewsPattern[];
}

export interface PatternResponse extends PatternCache {
  ok: true;
  cached?: boolean;
  reason?: string;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

function itemId(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 80) : '';
}

function region(value: unknown): Region | null {
  return typeof value === 'string' && (REGIONS as readonly string[]).includes(value) ? value as Region : null;
}

function readCache(value: unknown): PatternCache | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.generated_at !== 'string' || !Array.isArray(raw.patterns)) return null;
  const generated = Date.parse(raw.generated_at);
  if (!Number.isFinite(generated)) return null;
  return {
    generated_at: raw.generated_at,
    window_h: Number(raw.window_h) || PATTERN_WINDOW_H,
    n_items: Math.max(0, Number(raw.n_items) || 0),
    model: text(raw.model, 80) || 'openai/gpt-oss-120b',
    patterns: raw.patterns.filter((x) => x && typeof x === 'object') as NewsPattern[],
  };
}

export function selectPatternItems(items: NewsItem[], now = new Date(), limit = 150): NewsItem[] {
  const since = now.getTime() - PATTERN_WINDOW_H * 3600e3;
  const candidates = items
    .filter((item) => item.status === 'scored' && item.created_at && Date.parse(item.created_at) >= since)
    .sort((a, b) => {
      const score = Number(b.score || 0) - Number(a.score || 0);
      const preferred = Number((b.score || 0) >= 5) - Number((a.score || 0) >= 5);
      return preferred || score || b.created_at.localeCompare(a.created_at);
    });
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of candidates) {
    const title = item.title.replace(/\s+/g, ' ').trim().toLowerCase();
    const key = item.cluster_key?.trim() || title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function compactItems(items: NewsItem[]): string {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const line = [
      item.id,
      item.region,
      item.tag,
      item.activity,
      text(item.company, 30),
      text(item.title, 92),
      text(item.points?.[0] || item.raw_summary, 70),
    ].join('|');
    const rows = groups.get(item.region) || [];
    rows.push(line.slice(0, 205));
    groups.set(item.region, rows);
  }
  return [...groups.entries()].map(([r, rows]) => `${r}\n${rows.join('\n')}`).join('\n').slice(0, 21000);
}

export function patternPrompt(items: NewsItem[]): string {
  return `Tum cross-country news pattern finder ho. Roman Hinglish mein strict JSON only do, markdown nahi. Input ki scored news lines region groups mein hain; URLs invent mat karo. Sirf tab pattern banao jab kam se kam 2 alag regions aur 2 alag item ids ka real link ho. WORLD akela region nahi count hota; WORLD ko named region (IN/CN/US/RU/EU) ke saath hi use karo. Har region ka what short rakho. Inference ko assumption mein likho, fact ki tarah nahi. Max 6 patterns. JSON shape: {"patterns":[{"title":"...","pattern":"1-2 lines","type":"ai-race|compute/datacentre buildout|capital flow|policy wave|supply chain|space race|talent|other","regions":[{"region":"IN|CN|US|RU|EU|WORLD","what":"...","item_ids":["id"]}],"signal":"strong|medium|weak","why_it_matters":"...","watch_next":"...","assumption":"..."}]}. News lines: ${compactItems(items)}`;
}

/** Strictly validates model output and reattaches all item metadata from the database. */
export function validatePatterns(raw: unknown, items: NewsItem[], max = 6): NewsPattern[] {
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).patterns)
      ? (raw as Record<string, unknown>).patterns as unknown[]
      : [];
  const byId = new Map(items.map((item) => [String(item.id), item]));
  const out: NewsPattern[] = [];
  for (const value of rows) {
    if (out.length >= max || !value || typeof value !== 'object') continue;
    const row = value as Record<string, unknown>;
    const title = text(row.title, 180);
    const pattern = text(row.pattern, 520);
    const type = TYPES.includes(row.type as PatternType) ? row.type as PatternType : 'other';
    const signal = SIGNALS.includes(row.signal as PatternSignal) ? row.signal as PatternSignal : 'weak';
    if (!title || !pattern || !Array.isArray(row.regions)) continue;
    const regions: PatternRegion[] = [];
    const used = new Set<string>();
    for (const rawRegion of row.regions) {
      if (!rawRegion || typeof rawRegion !== 'object') continue;
      const rr = rawRegion as Record<string, unknown>;
      const r = region(rr.region);
      if (!r) continue;
      const ids: string[] = [];
      for (const idValue of Array.isArray(rr.item_ids) ? rr.item_ids : []) {
        const id = itemId(idValue);
        const item = byId.get(id);
        if (!item || item.region !== r || used.has(id)) continue;
        used.add(id);
        ids.push(id);
      }
      if (ids.length) regions.push({ region: r, what: text(rr.what, 240), item_ids: ids });
    }
    const actualRegions = new Set(regions.map((x) => x.region));
    const namedRegions = [...actualRegions].filter((x) => x !== 'WORLD');
    // A WORLD row is useful only when another named region is present, and every
    // pattern must still span two distinct actual regions.
    if (actualRegions.size < 2 || !namedRegions.length || used.size < 2) continue;
    const attached = [...used].map((id) => byId.get(id)!).map((item) => ({
      id: String(item.id), title: text(item.title, 220), url: text(item.url, 700), source: text(item.source, 120), region: item.region,
    }));
    if (attached.length < 2) continue;
    out.push({
      title,
      pattern,
      type,
      regions: regions.slice(0, 8),
      signal,
      why_it_matters: text(row.why_it_matters, 420),
      watch_next: text(row.watch_next, 320),
      assumption: text(row.assumption, 320),
      items: attached,
    });
  }
  return out;
}

function cachedResponse(cache: PatternCache | null, reason: string): PatternResponse | { ok: false; error: string; reason: string } {
  if (cache) return { ok: true, ...cache, cached: true, reason };
  return { ok: false, error: 'Patterns abhi available nahi hain.', reason };
}

function attemptTime(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Date.parse(value) || 0;
  if (value && typeof value === 'object') {
    const x = (value as Record<string, unknown>).attempted_at;
    return typeof x === 'number' ? x : Date.parse(String(x || '')) || 0;
  }
  return 0;
}

export async function getPatterns(
  store: Store,
  fetcher: FetchLike = fetch,
  now = new Date(),
  refresh = false,
): Promise<PatternResponse | { ok: false; error: string; reason: string }> {
  const cached = readCache(await store.getKV(PATTERN_CACHE_KEY));
  const age = cached ? now.getTime() - Date.parse(cached.generated_at) : Infinity;
  if (!refresh && cached && age < PATTERN_CACHE_H * 3600e3) return { ok: true, ...cached, cached: true, reason: 'fresh-cache' };

  const lastAttempt = attemptTime(await store.getKV(PATTERN_ATTEMPT_KEY));
  if (lastAttempt && now.getTime() - lastAttempt < PATTERN_THROTTLE_MS) return cachedResponse(cached, 'throttled');

  const state = await budget(store, now);
  if (state.groq.state === 'stopped') return cachedResponse(cached, 'budget-stopped');

  const items = selectPatternItems(await store.listItems({ status: 'scored', since: new Date(now.getTime() - PATTERN_WINDOW_H * 3600e3).toISOString(), limit: 300 }), now);
  if (items.length < 2) return cachedResponse(cached, 'not-enough-news');

  await store.setKV(PATTERN_ATTEMPT_KEY, { attempted_at: now.getTime(), ok: false });
  try {
    const result = await groq(store, fetcher, patternPrompt(items), 'patterns', now, {
      model: 'openai/gpt-oss-120b',
      maxTokens: 1400,
      fallbackModel: 'openai/gpt-oss-20b',
    });
    const patterns = validatePatterns(extractJson(result.text), items);
    const next: PatternCache = {
      generated_at: now.toISOString(),
      window_h: PATTERN_WINDOW_H,
      n_items: items.length,
      model: result.model || 'openai/gpt-oss-120b',
      patterns,
    };
    await store.setKV(PATTERN_CACHE_KEY, next);
    await store.setKV(PATTERN_ATTEMPT_KEY, { attempted_at: now.getTime(), ok: true });
    return { ok: true, ...next, cached: false };
  } catch (error) {
    // Never replace a good result with a failed attempt. Keep a short reason for
    // the caller, while the detailed provider error stays out of the API response.
    await store.setKV(PATTERN_ATTEMPT_KEY, { attempted_at: now.getTime(), ok: false });
    return cachedResponse(cached, 'generation-failed');
  }
}
