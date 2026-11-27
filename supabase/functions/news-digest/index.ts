import { supabaseStore } from '../_shared/store.ts';
import { json } from '../_shared/types.ts';
import { digestDue, localDay } from '../_shared/budget.ts';
import { telegram, htmlEscape, logDelivery } from '../_shared/alerts.ts';
import { sendFcm } from '../_shared/fcm.ts';
import type { Store, FetchLike } from '../_shared/types.ts';
import { auth, authStatus } from '../news-ingest/index.ts';
export { auth };
import { safeFunctionError } from '../_shared/diagnostics.ts';
import { getPatterns } from '../_shared/patterns.ts';

export async function run(
  store: Store,
  fetcher: FetchLike = fetch,
  now = new Date(),
  force = false,
) {
  const settings = await store.getSettings();
  const day = localDay(now, settings.tz);
  const last = String((await store.getKV('digest:last_day')) || '');

  if (!force && !digestDue(now, settings.digest_time, settings.tz, last)) {
    return { sent: false, items: 0, reason: 'not-due' };
  }

  // A unique, transaction-locked DB claim blocks parallel/retried cron calls.
  // Reserve the day before any message is sent: downstream FCM/logging failures
  // must never cause the same Telegram digest to be delivered again every 10 min.
  if (!(await store.claimDigest(day))) {
    return { sent: false, items: 0, reason: 'already-claimed' };
  }

  const rows = (await store.listItems({
    status: 'scored',
    since: new Date(now.getTime() - 864e5).toISOString(),
    limit: 100,
  }))
    .filter((item) => (item.score || 0) >= settings.list_min_score)
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 8);

  let patternLines: string[] = [];
  try {
    const patternResult = await getPatterns(store, fetcher, now, false);
    if (patternResult.ok && patternResult.patterns.length) {
      patternLines = patternResult.patterns.slice(0, 3).map((pattern) => {
        const regions = [...new Set(pattern.regions.map((entry) => entry.region))].join('/');
        return `• <b>${htmlEscape(pattern.title)}</b> [${htmlEscape(regions)}] — ${htmlEscape(pattern.pattern)}`;
      });
    }
  } catch {
    // Pattern generation is optional and must never block or duplicate the digest.
  }

  const patternsText = patternLines.length ? `\n\n<b>Patterns</b>\n${patternLines.join('\n')}` : '';
  const text = `<b>Adarsh News Digest</b>\n${rows.map((item, index) =>
    `${index + 1}. <b>${htmlEscape(item.title)}</b> — ${(item.points || []).map(htmlEscape).join(' ')}`
  ).join('\n') || 'Aaj top news nahi mili.'}${patternsText}`;
  const chat = String((await store.getKV('telegram:chat_id')) || '');
  const telegramResult = await telegram(
    fetcher,
    Deno.env.get('TELEGRAM_BOT_TOKEN') || '',
    chat,
    text,
  );
  await logDelivery(
    store,
    null,
    'telegram',
    'digest',
    telegramResult.ok,
    telegramResult.error || '',
    day,
  );

  let fcmSent = 0;
  let fcmError = 'No FCM device';
  try {
    fcmSent = await sendFcm(
      store,
      fetcher,
      Deno.env.get('FCM_SERVICE_ACCOUNT') || '',
      {
        title: 'Adarsh News Digest',
        points: [rows.slice(0, 5).map((item) => item.title).join(' | ')],
        tag: 'WORLD',
        state_media: false,
      },
      'digest',
      'OPEN_NEWS',
    );
    fcmError = fcmSent ? '' : 'No FCM device';
  } catch {
    // Do not fail the whole digest after Telegram was already handled.
    fcmError = 'FCM digest delivery failed';
  }
  await logDelivery(store, null, 'fcm', 'digest', fcmSent > 0, fcmError, day);

  return {
    sent: true,
    items: rows.length,
    telegram: telegramResult.ok,
    fcm: fcmSent,
  };
}

if (import.meta.main) {
  Deno.serve(async (req) => {
    const authCode=authStatus(req); if(authCode!==200)return json({ok:false,error:authCode===503?'server not configured':'Cron auth galat'},authCode);
    try {
      return json({ ok: true, ...await run(supabaseStore()) });
    } catch (errorValue) {
      const error = safeFunctionError(errorValue);
      console.error('[news-digest] failed:', error);
      return json({ ok: false, error }, 500);
    }
  });
}
