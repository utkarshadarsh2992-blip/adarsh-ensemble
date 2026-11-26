import { supabaseStore } from '../_shared/store.ts';
import { json } from '../_shared/types.ts';
import { fetchFeed, sha256, findCluster, relevant, sourceFor, feedTag, isStateMedia } from '../_shared/parser.ts';
import type { Feed, FetchLike, Store } from '../_shared/types.ts';
import { safeFunctionError } from '../_shared/diagnostics.ts';

export function auth(req: Request): boolean {
  const configured = Deno.env.get('CRON_SECRET')?.trim() || '';
  if (configured.length < 16) return false;
  const supplied = req.headers.get('x-cron-secret')?.trim() || '';
  if (!supplied) return false;
  const a = new TextEncoder().encode(supplied);
  const b = new TextEncoder().encode(configured);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i % Math.max(1, a.length)] || 0) ^ (b[i % Math.max(1, b.length)] || 0);
  }
  return diff === 0;
}

export function authStatus(req: Request): 200 | 401 | 503 { return (Deno.env.get('CRON_SECRET')?.trim() || '').length < 16 ? 503 : (auth(req) ? 200 : 401); }

function lastFetchedAt(feed: Feed): number {
  if (!feed.last_fetch) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(feed.last_fetch);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

/** Return due feeds oldest-first so a slow batch cannot starve later feeds. */
export function selectDueFeeds(feeds: Feed[], now = new Date()): Feed[] {
  const nowMs = now.getTime();
  return feeds
    .filter((feed) => {
      const lastFetch = lastFetchedAt(feed);
      if (!Number.isFinite(lastFetch)) return true;
      const intervalMinutes = Math.max(5, Number(feed.every_min) || 30);
      return nowMs - lastFetch >= intervalMinutes * 60_000;
    })
    .sort((a, b) => {
      const left = lastFetchedAt(a);
      const right = lastFetchedAt(b);
      if (left !== right) return left < right ? -1 : 1;
      return a.id.localeCompare(b.id);
    });
}

export async function run(store: Store, fetcher: FetchLike = fetch, now = new Date()) {
  const feeds = selectDueFeeds(await store.listFeeds(), now);
  const watch = (await store.listWatch()).map((x) => x.keyword);
  const summary: any = { feeds: 0, items: 0, skipped: 0, errors: 0, per_feed: [] };
  const started = Date.now();

  for (const feed of feeds) {
    if (Date.now() - started > 85_000) break;
    const result = await fetchFeed(feed, fetcher, feed.kind === 'hf_papers' ? 50 : 30);
    await store.updateFeed(feed.id, {
      last_fetch: now.toISOString(),
      last_status: result.status,
      fail_count: result.status === 200 ? 0 : (feed.fail_count || 0) + 1,
    });
    summary.feeds++;
    summary.per_feed.push({
      feed: feed.id,
      status: result.status,
      bytes: result.bytes,
      parsed: result.items.length,
      error: result.error || '',
    });
    if (result.status !== 200) {
      summary.errors++;
      continue;
    }

    for (const parsed of result.items) {
      const canonical = parsed.source_url || parsed.url;
      const hash = await sha256(canonical);
      if (!(await store.claimSeen(hash))) continue;
      if (!relevant(parsed.title, parsed.summary, feed, watch)) {
        summary.skipped++;
        continue;
      }

      const state = isStateMedia(canonical, feed.state_media);
      const source = sourceFor(parsed, feed.url, state);
      const cluster = await findCluster(parsed.title, store, now.getTime());
      if (cluster) {
        const old = await store.getItem(cluster);
        if (old) {
          const sources = [...(old.sources || []), source];
          const allState = sources.every((item) => item.state_media);
          await store.updateItem(cluster, {
            n_sources: sources.length,
            sources,
            state_media: allState,
            claim_tag: sources.some((item) => item.state_media) ? 'sarkari daava' : '',
          });
          continue;
        }
      }

      try { await store.insertItem({
        title: parsed.title,
        title_norm: parsed.title.toLowerCase(),
        url: parsed.url,
        raw_summary: parsed.summary,
        published_at: parsed.published_at,
        source: parsed.publisher || new URL(parsed.url).hostname,
        feed_id: feed.id,
        tag: feedTag(feed),
        tags: [feedTag(feed)],
        region: feed.region,
        kind: feed.kind === 'hf_papers' ? 'paper' : 'news',
        state_media: state,
        claim_tag: state ? 'sarkari daava' : '',
        cluster_key: cluster,
        sources: [source],
        status: 'new',
      });
      summary.items++; } catch (error) { if (!(error && typeof error === 'object' && (error as any).code === '23505')) throw error; }
    }
  }

  return summary;
}

if (import.meta.main) {
  Deno.serve(async (req) => {
    const authCode=authStatus(req); if (authCode !== 200) return json({ ok: false, error: authCode===503 ? 'server not configured' : 'Cron auth galat' }, authCode);
    try {
      return json({ ok: true, ...await run(supabaseStore()) });
    } catch (error) {
      const safeError = safeFunctionError(error);
      console.error('[news-ingest] failed:', safeError);
      return json({ ok: false, error: safeError }, 500);
    }
  });
}
