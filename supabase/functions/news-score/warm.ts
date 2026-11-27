import type { FetchLike, Store } from '../_shared/types.ts';
import { getPatterns, inBackground } from '../_shared/patterns.ts';

/**
 * Cron pre-warm for the Pattern Finder (`news-score?patterns=1`).
 * Regenerates only when the cache is older than 6 h (getPatterns obeys the
 * 30-minute throttle and the Groq budget stop). Runs after the response so the
 * 5-120 s pg_net timeout and scoring are never blocked by the pattern call.
 */
export async function warmPatterns(req: Request, store: Store, fetcher: FetchLike = fetch): Promise<string | null> {
  let wanted = false;
  try { wanted = new URL(req.url).searchParams.get('patterns') === '1'; } catch { wanted = false; }
  if (!wanted) return null;
  const background = await inBackground(getPatterns(store, fetcher, new Date(), false));
  return background ? 'warming' : 'done';
}
