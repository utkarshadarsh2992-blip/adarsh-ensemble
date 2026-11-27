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
export const PATTERN_MAX_ITEMS = 90;
export const PATTERN_MIN_SCORE = 3;
/** An empty result is retried sooner than a real one (news changes; don't show "no pattern" for 6 h). */
export const PATTERN_EMPTY_CACHE_MS = 60 * 60 * 1000;
const freshFor = (cache: PatternCache): number => cache.patterns.length ? PATTERN_CACHE_H * 3600e3 : PATTERN_EMPTY_CACHE_MS;
export const PATTERN_MAX_TOKENS = 3200;

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
  /** Government/state-media publisher: its text is a claim, not independent evidence. */
  state_media?: boolean;
  verified?: string;
  n_sources?: number;
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
  // Low-score items (score < 3) are mostly off-mission noise; use them only when the window is thin.
  const relevant = candidates.filter((item) => Number(item.score || 0) >= PATTERN_MIN_SCORE);
  const pool = relevant.length >= 30 ? relevant : candidates;
  const seen = new Set<string>();
  const byRegion = new Map<string, NewsItem[]>();
  for (const item of pool) {
    const title = item.title.replace(/\s+/g, ' ').trim().toLowerCase();
    const key = item.cluster_key?.trim() || title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const rows = byRegion.get(item.region) || [];
    rows.push(item);
    byRegion.set(item.region, rows);
  }
  // Items whose company/product/person name also appears in another named region come first inside their region:
  // taking only each region's top scorers threw away the very stories (Nvidia in US and CN) that can link countries.
  const nameRegions = new Map<string, Set<string>>();
  const namesOf = (item: NewsItem) => new Set([...properNames(item.title), ...properNames(item.company)].map((w) => w.toLowerCase().slice(0, 5)));
  for (const [r, rows] of byRegion) {
    if (r === 'WORLD') continue;
    for (const item of rows) for (const k of namesOf(item)) nameRegions.set(k, (nameRegions.get(k) || new Set<string>()).add(r));
  }
  const crossLinked = (item: NewsItem) => [...namesOf(item)].some((k) => (nameRegions.get(k)?.size || 0) >= 2 && item.region !== 'WORLD');
  for (const [r, rows] of byRegion) byRegion.set(r, [...rows.filter(crossLinked), ...rows.filter((x) => !crossLinked(x))]);
  // Round-robin across regions (best-scored first inside each) so one busy region
  // (usually US/WORLD) cannot crowd out IN/CN/RU/EU — cross-country links need all of them.
  const order = [...PATTERN_REGION_ORDER.filter((r) => byRegion.has(r)), ...[...byRegion.keys()].filter((r) => !PATTERN_REGION_ORDER.includes(r))];
  const out: NewsItem[] = [];
  for (let i = 0; out.length < limit; i++) {
    let added = false;
    for (const r of order) {
      const item = byRegion.get(r)![i];
      if (!item) continue;
      out.push(item);
      added = true;
      if (out.length >= limit) break;
    }
    if (!added) break;
  }
  return out;
}
const PATTERN_REGION_ORDER = ['US', 'CN', 'IN', 'RU', 'EU', 'WORLD'];

/** Short prompt alias for an item: n1, n2, ... (UUIDs cost ~20 tokens each and models mangle them). */
export const patternAlias = (index: number): string => `n${index + 1}`;

/** Map model-written aliases (n12) back to real DB ids; real ids pass through unchanged. */
export function resolvePatternAliases(raw: unknown, items: NewsItem[]): unknown {
  const byAlias = new Map(items.map((item, i) => [patternAlias(i), String(item.id)]));
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).patterns)
      ? (raw as Record<string, unknown>).patterns as unknown[]
      : [];
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || !Array.isArray((row as Record<string, unknown>).regions)) return row;
    const r = row as Record<string, unknown>;
    return {
      ...r,
      regions: (r.regions as unknown[]).map((g) => {
        if (!g || typeof g !== 'object') return g;
        const gg = g as Record<string, unknown>;
        const ids = Array.isArray(gg.item_ids) ? gg.item_ids : [];
        return { ...gg, item_ids: ids.map((v) => { const k = typeof v === 'string' ? v.trim().toLowerCase() : ''; return byAlias.get(k) || v; }) };
      }),
    };
  });
}

function compactItems(items: NewsItem[]): string {
  const groups = new Map<string, string[]>();
  for (const [index, item] of items.entries()) {
    const line = [
      patternAlias(index),
      item.region,
      item.tag,
      item.activity,
      text(item.company, 24),
      text(item.title, 90),
      text(item.points?.[0] || item.raw_summary, 60),
      item.state_media || item.claim_tag === 'sarkari daava' ? 'SM' : '',
    ].join('|');
    const rows = groups.get(item.region) || [];
    rows.push(line.slice(0, 190));
    groups.set(item.region, rows);
  }
  return [...groups.entries()].map(([r, rows]) => `${r}\n${rows.join('\n')}`).join('\n').slice(0, 15000);
}

/**
 * Cheap, deterministic candidate themes: the same tag/activity seen in >= 2 named
 * regions (WORLD excluded). Gives the model concrete leads instead of an open search.
 */
export function themeHints(items: NewsItem[], max = 8): string {
  const groups = new Map<string, Map<string, string[]>>();
  for (const [index, item] of items.entries()) {
    if (item.region === 'WORLD' || GENERIC_TAGS.has(String(item.tag))) continue; // ECON/BIG-TECH/WORLD hints only lead the model to forced links
    const key = item.activity && item.activity !== 'other' ? `${item.tag}/${item.activity}` : String(item.tag);
    const byRegion = groups.get(key) || new Map<string, string[]>();
    const ids = byRegion.get(item.region) || [];
    ids.push(patternAlias(index));
    byRegion.set(item.region, ids);
    groups.set(key, byRegion);
  }
  return [...groups.entries()]
    .filter(([, byRegion]) => byRegion.size >= 2)
    .sort((a, b) => b[1].size - a[1].size || [...b[1].values()].flat().length - [...a[1].values()].flat().length)
    .slice(0, max)
    .map(([key, byRegion]) => `${key}: ${[...byRegion.entries()].map(([r, ids]) => `${r}(${ids.slice(0, 4).join(',')})`).join(' ')}`)
    .join('\n');
}
const NAME_SKIP = new Set([
  'china', 'chinese', 'india', 'indian', 'russia', 'russian', 'europe', 'european', 'america', 'american', 'united', 'states', 'union',
  'beijing', 'delhi', 'moscow', 'washington', 'brussels', 'president', 'minister', 'government', 'ministry', 'times', 'news', 'daily',
  'street', 'journal', 'group', 'launch', 'technologies', 'technology', 'korea', 'update', 'breaking', 'price', 'office', 'electronics', 'ukrainian', 'ukraine', 'kiev', 'kyiv', 'limited', 'india', 'asia', 'asian', 'global', 'international', 'national', 'monday', 'tuesday', 'wednesday',
  'thursday', 'friday', 'saturday', 'sunday', 'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october',
  'november', 'december',
]);
/** Capitalised names (companies, people, products) from a headline, without the trailing "- Publisher" part. */
function properNames(title: unknown): string[] {
  const head = String(title ?? '').split(/\s[-|\u2013\u2014]\s/)[0];
  const words = head.match(/[A-Za-z][A-Za-z0-9]+/g) || [];
  return words.filter((w) => w.length >= 4 && /^[A-Z]/.test(w) && !NAME_SKIP.has(w.toLowerCase()) && !STOP_WORDS.has(w.toLowerCase()));
}
/**
 * Concrete shared names: a company/person/product that shows up in the headlines of 2+ named regions,
 * e.g. "Nvidia: US(n3) CN(n8)". Much stronger leads than the coarse 9-tag taxonomy; rare names rank first.
 */
export function sharedNameHints(items: NewsItem[], max = 8): string {
  const byStem = new Map<string, { word: string; regions: Map<string, string[]>; count: number }>();
  for (const [index, item] of items.entries()) {
    if (item.region === 'WORLD') continue;
    const seen = new Set<string>();
    for (const w of [...properNames(item.title), ...properNames(item.company)]) {
      const key = w.toLowerCase().slice(0, 5);
      if (seen.has(key)) continue;
      seen.add(key);
      const e = byStem.get(key) || { word: w, regions: new Map<string, string[]>(), count: 0 };
      const ids = e.regions.get(item.region) || [];
      ids.push(patternAlias(index));
      e.regions.set(item.region, ids);
      e.count++;
      byStem.set(key, e);
    }
  }
  return [...byStem.values()]
    .filter((e) => e.regions.size >= 2 && e.count <= 10)
    .sort((a, b) => b.regions.size - a.regions.size || a.count - b.count)
    .slice(0, max)
    .map((e) => `${e.word}: ${[...e.regions.entries()].map(([r, ids]) => `${r}(${ids.slice(0, 3).join(',')})`).join(' ')}`)
    .join('\n');
}
export function patternPrompt(items: NewsItem[]): string {
  const hints = themeHints(items);
  const names = sharedNameHints(items);
  return `Tum cross-country news pattern finder ho. Roman Hinglish mein strict JSON only do, markdown nahi. Input ki scored news lines region groups mein hain; URLs invent mat karo. Har line ka pehla field item id hai (n1, n2, ...); item_ids mein wahi short ids likho, lekin title/pattern/what/why text mein ids mat likho. Pattern ka matlab: alag countries mein EK HI TARAH ka move (jaise chip export control, datacentre/compute buildout, national AI strategy, launch/space push, funding/IPO wave, policy crackdown). "pattern" field mein headlines ki list nahi, balki common underlying trend/mechanism 1-2 lines mein likho (kya ho raha hai aur kyun saath ho raha hai). Sabse real 2-5 patterns do (sach mein kam hon to kam). Real link = alag countries ki headlines EK HI move ki hon (jaise US chip export control aur China ke apne AI chips; India ka Chinese AI models host karna aur China ke open-weight model releases). Nakli link = sirf same sector/tag ya generic shabd (jaise ek solar stock aur ek liquor stock, ya roundup headline) — aise links skip karo, unse pattern mat banao. Neeche "Candidate themes" code ne nikale hain (same tag/activity 2+ countries mein) — inhe headlines padh kar verify karo, aur khud bhi dhoondo. Alag-alag topic ki news ko zabardasti mat jodo; har pattern ka signal imaandari se do (strong = dono jagah seedha same move, medium = same direction ka move, weak = sirf loose link). Sirf tab pattern banao jab kam se kam 2 alag regions aur 2 alag item ids ka real link ho. Jawab chhota: har text field 1 line. Alag countries (IN/CN/US/RU/EU) ke beech link sabse pehle dhoondo; WORLD sirf support ke liye. Saare text fields Roman Hinglish mein likho (Hindi Latin script mein, technical words English mein; pure English sentences nahi). WORLD akela region nahi count hota; WORLD ko named region (IN/CN/US/RU/EU) ke saath hi use karo. Har region ka what short rakho aur wahi event likho jo us region ki linked headlines mein hai (headline ke asli shabd/naam use karo, koi aur event ya company nahi). Ek item ko pattern mein tabhi daalo jab uski headline seedha usi move ki baat kare (alag sector ka stock ya roundup mat jodo). Inference ko assumption mein likho, fact ki tarah nahi. Line ke end mein SM = sarkari/state-media daava: use "X ka daava" likho, independent fact nahi; sirf SM lines ya ek hi publisher se pattern mat banao. Text mein koi aisa desh/company/actor mat jodo jo lines mein nahi hai. Max 6 patterns. JSON shape: {"patterns":[{"title":"...","pattern":"1-2 lines","type":"ai-race|compute/datacentre buildout|capital flow|policy wave|supply chain|space race|talent|other","regions":[{"region":"IN|CN|US|RU|EU|WORLD","what":"...","item_ids":["n1"]}],"signal":"strong|medium|weak","why_it_matters":"...","watch_next":"...","assumption":"..."}]}. ${hints ? `Candidate themes:\n${hints}\n` : ''}${names ? `Shared names (headline mein 2+ regions mein aaye, verify karo):\n${names}\n` : ''}News lines: ${compactItems(items)}`;
}

/** Strictly validates model output and reattaches all item metadata from the database. */
/** Removes leaked prompt aliases like "(n2)", "[n3, n7]" or "n12:" from model prose. */
export function stripAliases(value: string): string {
  return value
    .replace(/[([]\s*n\d{1,3}(?:\s*[,/&]\s*n\d{1,3})*\s*[)\]]/gi, '')
    .replace(/\bn\d{1,3}\s*:\s*/gi, '')
    .replace(/\s+([,.;])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
const SIGNAL_RANK: Record<string, number> = { strong: 0, medium: 1, weak: 2 };
/**
 * Guard against forced links. The tag list is coarse (9 tags), so a shared GENERIC tag (ECON, BIG-TECH, WORLD)
 * proves nothing: a solar-EPC stock and a liquor stock are both "ECON". Two items from different regions are linked
 * only by a shared SPECIFIC tag (AI, SPACE, PHYSICS...) or by a shared concrete word/company in their headlines.
 */
const GENERIC_TAGS = new Set(['WORLD', 'ECON', 'BIG-TECH', 'OTHER', 'PAPER']);
const STOP_WORDS = new Set([
  'with', 'from', 'that', 'this', 'have', 'will', 'over', 'into', 'after', 'about', 'their', 'while', 'amid', 'says', 'said', 'news',
  'shares', 'share', 'stock', 'stocks', 'market', 'markets', 'global', 'world', 'report', 'reports', 'growth', 'billion', 'million',
  'first', 'record', 'sees', 'more', 'than', 'year', 'years', 'could', 'would', 'what', 'when', 'ahead', 'plan', 'plans', 'deal', 'move',
  'none', 'unknown', 'null', 'other', 'company', 'upside', 'downside', 'rises', 'rise', 'falls', 'fall', 'surge', 'surges', 'jump', 'jumps', 'analysts', 'guidance', 'boost', 'today', 'shows', 'highlights', 'strong', 'stronger', 'higher', 'lower', 'update', 'latest', 'launches', 'announces', 'raises', 'aur', 'ke', 'ki', 'ka', 'mein', 'par', 'hai', 'dono', 'kuch', 'wala', 'wali', 'jaise', 'taaki',
]);
function stems(...parts: unknown[]): Set<string> {
  const out = new Set<string>();
  for (const w of String(parts.map((x) => String(x ?? '')).join(' ')).toLowerCase().match(/[a-z0-9]{4,}/g) || []) {
    if (!STOP_WORDS.has(w)) out.add(w.slice(0, 4));
  }
  return out;
}
function linkedPair(a: NewsItem, b: NewsItem): boolean {
  // A tag alone never links two stories ("AI" covers a Russian chatbot launch and a US chip-export pause).
  // Evidence must be in the headlines themselves: a shared name (Nvidia, DeepSeek...) or, with a shared SPECIFIC tag, a shared content word.
  const names = (x: NewsItem) => new Set(properNames(x.title).map((w) => w.toLowerCase()));
  const na = names(a), nb = names(b);
  if ([...na].some((w) => nb.has(w))) return true;
  const tags = (x: NewsItem) => new Set([x.tag, ...(Array.isArray(x.tags) ? x.tags : [])].filter((t) => t && !GENERIC_TAGS.has(t)));
  const ta = tags(a), tb = tags(b);
  const sa = stems(a.title), sb = stems(b.title);
  const shared = [...sa].filter((w) => sb.has(w)).length;
  return [...ta].some((t) => tb.has(t)) ? shared >= 1 : shared >= 2;
}
export function coherent(items: NewsItem[]): boolean {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].region !== items[j].region && linkedPair(items[i], items[j])) return true;
    }
  }
  return false;
}
/** Only these regions may be represented by state media (their own government's voice). */
const STATE_VOICE_REGIONS = new Set(['RU', 'CN', 'WORLD']);
/**
 * Keeps an item only if it really links to an item of ANOTHER region (same topic tag or activity), and
 * state media may stand for RU/CN only: a TASS story about the EU budget is not "the EU's move".
 * The model often adds loose extras (a pharma stock inside a renewable-energy pattern) next to one good pair.
 */
export function tightLinks(items: NewsItem[]): NewsItem[] {
  return items.filter((it) =>
    !(isStateClaim(it) && !STATE_VOICE_REGIONS.has(it.region)) &&
    items.some((o) => o.region !== it.region && linkedPair(it, o)));
}
const isStateClaim = (item: NewsItem): boolean => !!item.state_media || item.claim_tag === 'sarkari daava';
export function validatePatterns(raw: unknown, items: NewsItem[], max = 6, why: string[] = []): NewsPattern[] {
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
    const title = stripAliases(text(row.title, 180));
    const pattern = stripAliases(text(row.pattern, 520));
    const type = TYPES.includes(row.type as PatternType) ? row.type as PatternType : 'other';
    const signal = SIGNALS.includes(row.signal as PatternSignal) ? row.signal as PatternSignal : 'weak';
    // Weak/forced links are noise for a pattern finder: only strong or medium survive.
    if (signal === 'weak' || !title || !pattern || !Array.isArray(row.regions)) { why.push(`${title.slice(0, 40)}: weak/shape`); continue; }
    // The DB region of each item wins over the model's label (it often files a Kyiv/Arctic
    // story under the "wrong" country); an item is attached once, under its real region.
    const byRegion = new Map<string, PatternRegion>();
    const used = new Set<string>();
    const listed = new Set<string>();
    for (const rawRegion of row.regions) {
      if (!rawRegion || typeof rawRegion !== 'object') continue;
      for (const idValue of Array.isArray((rawRegion as Record<string, unknown>).item_ids) ? (rawRegion as Record<string, unknown>).item_ids as unknown[] : []) {
        const found = byId.get(itemId(idValue));
        if (found) listed.add(String(found.id));
      }
    }
    const allowed = new Set(tightLinks([...listed].map((id) => byId.get(id)!)).map((x) => String(x.id)));
    for (const rawRegion of row.regions) {
      if (!rawRegion || typeof rawRegion !== 'object') continue;
      const rr = rawRegion as Record<string, unknown>;
      const label = region(rr.region);
      // The model sometimes describes an event that is not in the linked headline (a "Shenzhou-24 launch" under a
      // Huawei trial story): the region's text must share a concrete word with at least one of its own items.
      const said = stems(rr.what);
      if (said.size) {
        const own = (Array.isArray(rr.item_ids) ? rr.item_ids : []).map((v) => byId.get(itemId(v))).filter((x): x is NewsItem => !!x);
        if (own.length && !own.some((it) => { const real = stems(it.title, ...(Array.isArray(it.points) ? it.points.slice(0, 2) : [])); return [...said].some((w) => real.has(w)); })) { why.push(`${title.slice(0, 40)}: ${text(rr.region, 4)} what!=headline`); continue; }
      }
      for (const idValue of Array.isArray(rr.item_ids) ? rr.item_ids : []) {
        const id = itemId(idValue);
        const item = byId.get(id);
        if (!item || used.has(id) || !allowed.has(String(item.id))) continue;
        const r = item.region;
        used.add(id);
        const slot = byRegion.get(r) || { region: r, what: label === r ? stripAliases(text(rr.what, 240)) : '', item_ids: [] };
        if (!slot.what && label === r) slot.what = stripAliases(text(rr.what, 240));
        slot.item_ids.push(id);
        byRegion.set(r, slot);
      }
    }
    const regions: PatternRegion[] = [...byRegion.values()].map((g) => ({ ...g, what: g.what || text(byId.get(g.item_ids[0])?.title, 240) }));
    const actualRegions = new Set(regions.map((x) => x.region));
    const namedRegions = [...actualRegions].filter((x) => x !== 'WORLD');
    // A WORLD row is useful only when another named region is present, and every
    // pattern must still span two distinct actual regions.
    // WORLD is only support: one country's event re-reported by wire/aggregator sites is not a cross-country pattern.
    if (actualRegions.size < 2 || namedRegions.length < 2 || used.size < 2) { why.push(`${title.slice(0, 40)}: <2 regions after pruning (listed ${listed.size}, kept ${used.size})`); continue; }
    if (!coherent([...used].map((id) => byId.get(id)!))) { why.push(`${title.slice(0, 40)}: incoherent`); continue; }
    const linked = [...used].map((id) => byId.get(id)!);
    const attached = linked.map((item) => ({
      id: String(item.id), title: text(item.title, 220), url: text(item.url, 700), source: text(item.source, 120), region: item.region,
      state_media: isStateClaim(item), verified: text(item.verified, 16), n_sources: Math.max(0, Number(item.n_sources) || 0),
    }));
    if (attached.length < 2) continue;
    // One government's own claims (or one publisher under two region labels) is a narrative, not a cross-country pattern.
    const publishers = new Set(linked.map((item) => text(item.source, 120).toLowerCase() || String(item.id)));
    const stateShare = attached.filter((i) => i.state_media).length / attached.length;
    if (stateShare === 1 || publishers.size < 2) { why.push(`${title.slice(0, 40)}: all state media or one publisher`); continue; }
    const trusted: PatternSignal = stateShare >= 0.5 && signal === 'strong' ? 'medium' : signal;
    out.push({
      title,
      pattern,
      type,
      regions: regions.slice(0, 8),
      signal: trusted,
      why_it_matters: stripAliases(text(row.why_it_matters, 420)),
      watch_next: stripAliases(text(row.watch_next, 320)),
      assumption: stripAliases(text(row.assumption, 320)),
      items: attached,
    });
  }
  return out.sort((a, b) => SIGNAL_RANK[a.signal] - SIGNAL_RANK[b.signal]);
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

/** Cache-only read for fast callers (the phone has a 10 s read timeout). `stale` = older than PATTERN_CACHE_H. */
export async function peekPatterns(store: Store, now = new Date()): Promise<(PatternResponse & { stale: boolean }) | null> {
  const cached = readCache(await store.getKV(PATTERN_CACHE_KEY));
  if (!cached) return null;
  const age = now.getTime() - Date.parse(cached.generated_at);
  return { ok: true, ...cached, cached: true, stale: !(age < freshFor(cached)) };
}

/** Finish a task after the HTTP response when the Edge Runtime supports it; otherwise await it. */
export async function inBackground(task: Promise<unknown>): Promise<boolean> {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  const safe = task.catch(() => null);
  if (rt && typeof rt.waitUntil === 'function') {
    rt.waitUntil(safe);
    return true;
  }
  await safe;
  return false;
}

export async function getPatterns(
  store: Store,
  fetcher: FetchLike = fetch,
  now = new Date(),
  refresh = false,
): Promise<PatternResponse | { ok: false; error: string; reason: string }> {
  const cached = readCache(await store.getKV(PATTERN_CACHE_KEY));
  const age = cached ? now.getTime() - Date.parse(cached.generated_at) : Infinity;
  if (!refresh && cached && age < freshFor(cached)) return { ok: true, ...cached, cached: true, reason: 'fresh-cache' };

  const lastAttempt = attemptTime(await store.getKV(PATTERN_ATTEMPT_KEY));
  if (lastAttempt && now.getTime() - lastAttempt < PATTERN_THROTTLE_MS) return cachedResponse(cached, 'throttled');

  const state = await budget(store, now);
  if (state.groq.state === 'stopped') return cachedResponse(cached, 'budget-stopped');

  const items = selectPatternItems(await store.listItems({ status: 'scored', since: new Date(now.getTime() - PATTERN_WINDOW_H * 3600e3).toISOString(), limit: 300 }), now, PATTERN_MAX_ITEMS);
  if (items.length < 2) return cachedResponse(cached, 'not-enough-news');

  await store.setKV(PATTERN_ATTEMPT_KEY, { attempted_at: now.getTime(), ok: false });
  try {
    const result = await groq(store, fetcher, patternPrompt(items), 'patterns', now, {
      model: 'openai/gpt-oss-120b',
      maxTokens: PATTERN_MAX_TOKENS,
      fallbackModel: 'openai/gpt-oss-20b',
    });
    const raw = extractJson(result.text);
    const parsed = Array.isArray(raw) || (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).patterns));
    // A cut-off or non-JSON answer is a failed attempt, never an "empty" result that replaces a good cache.
    if (result.finish === 'length' || !parsed) throw new Error('pattern output truncated or not JSON');
    const resolved = resolvePatternAliases(raw, items);
    const why: string[] = [];
    const patterns = validatePatterns(resolved, items, 6, why);
    // Small ops trace (titles/signals only) so "why so few patterns?" is answerable from the kv table.
    const rawRows = Array.isArray(resolved) ? resolved : [];
    const diag = {
      raw: rawRows.length,
      kept: patterns.length,
      why: why.slice(0, 8),
      rows: rawRows.slice(0, 8).map((r) => {
        const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
        const regs = Array.isArray(x.regions) ? x.regions as Record<string, unknown>[] : [];
        return { t: text(x.title, 80), s: text(x.signal, 10), r: regs.map((g) => text(g?.region, 6)).join(',') };
      }),
    };
    // Nothing usable this round: keep a recent good cache instead of replacing it with "no patterns".
    if (!patterns.length && cached?.patterns.length && age < 24 * 3600e3) {
      await store.setKV(PATTERN_ATTEMPT_KEY, { attempted_at: now.getTime(), ok: true, empty: true, ...diag });
      return cachedResponse(cached, 'no-new-patterns');
    }
    const next: PatternCache = {
      generated_at: now.toISOString(),
      window_h: PATTERN_WINDOW_H,
      n_items: items.length,
      model: result.model || 'openai/gpt-oss-120b',
      patterns,
    };
    await store.setKV(PATTERN_CACHE_KEY, next);
    await store.setKV(PATTERN_ATTEMPT_KEY, { attempted_at: now.getTime(), ok: true, ...diag });
    return { ok: true, ...next, cached: false };
  } catch (error) {
    // Never replace a good result with a failed attempt. Keep a short reason for
    // the caller, while the detailed provider error stays out of the API response.
    await store.setKV(PATTERN_ATTEMPT_KEY, { attempted_at: now.getTime(), ok: false });
    return cachedResponse(cached, 'generation-failed');
  }
}
