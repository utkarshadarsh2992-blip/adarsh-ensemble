// Owner-only News controls for the ADARSH Controller PWA (read usage, set notification and quota limits).
// Called from controller-admin after the Auth + allowlist check; never exposes keys or secrets.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.86.0';
import { SupabaseStore } from './store.ts';
import { budget, localDay } from './budget.ts';
import { fault, isObject } from './controller.ts';
import type { Settings } from './types.ts';

type Rule = { min: number; max: number };
export const NEWS_LIMITS: Record<string, Rule> = {
  alerts_per_day: { min: 0, max: 10 }, // 0 = no push alerts at all
  alert_min_score: { min: 1, max: 10 },
  list_min_score: { min: 1, max: 10 },
  groq_tokens_cap: { min: 1000, max: 10_000_000 },
  groq_calls_cap: { min: 1, max: 100_000 },
  tavily_day_cap: { min: 0, max: 1000 }, // Tavily credits per UTC day, 0 = never call Tavily
  tavily_month_cap: { min: 2, max: 100_000 },
};
const PUBLIC_KEYS = Object.keys(NEWS_LIMITS) as (keyof Settings)[];

function pick(settings: Settings): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of PUBLIC_KEYS) out[key] = Number(settings[key]);
  return out;
}
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

export async function newsState(service: SupabaseClient): Promise<Record<string, unknown>> {
  const store = new SupabaseStore(service);
  const now = new Date();
  const settings = await store.getSettings();
  const [b, usage, alerts] = await Promise.all([
    budget(store, now),
    service.from('ai_usage').select('day,provider,model,stage,calls,tokens_in,tokens_out')
      .gte('day', daysAgo(13)).order('day', { ascending: false }).limit(600),
    service.from('alert_log').select('news_id,channel,ok,day_local')
      .eq('kind', 'alert').eq('ok', true).gte('day_local', daysAgo(8)).limit(2000),
  ]);
  if (usage.error || alerts.error) fault(503, 'unavailable');
  const perDay = new Map<string, { ids: Set<string>; telegram: number; fcm: number }>();
  for (const [i, row] of (alerts.data ?? []).entries()) {
    const slot = perDay.get(row.day_local) ?? { ids: new Set<string>(), telegram: 0, fcm: 0 };
    slot.ids.add(row.news_id ?? `row-${i}`);
    if (row.channel === 'telegram') slot.telegram++;
    if (row.channel === 'fcm') slot.fcm++;
    perDay.set(row.day_local, slot);
  }
  return {
    ok: true,
    now: now.toISOString(),
    tz: settings.tz,
    local_day: localDay(now, settings.tz),
    settings: pick(settings),
    budget: b,
    usage: usage.data ?? [],
    alerts: [...perDay.entries()].sort((a, c) => (a[0] < c[0] ? 1 : -1)).map(([day, v]) => ({
      day, alerts: v.ids.size, telegram: v.telegram, fcm: v.fcm,
    })),
  };
}

export async function newsSettingsSet(service: SupabaseClient, value: unknown): Promise<Record<string, unknown>> {
  if (!isObject(value)) fault(400, 'invalid_request');
  const patch: Partial<Settings> = {};
  for (const [key, raw] of Object.entries(value)) {
    const rule = NEWS_LIMITS[key];
    if (!rule) fault(400, 'invalid_request');
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < rule.min || raw > rule.max) fault(400, 'invalid_request');
    (patch as Record<string, number>)[key] = raw;
  }
  if (!Object.keys(patch).length) fault(400, 'invalid_request');
  const store = new SupabaseStore(service);
  const saved = await store.setSettings(patch);
  return { ok: true, settings: pick(saved) };
}
