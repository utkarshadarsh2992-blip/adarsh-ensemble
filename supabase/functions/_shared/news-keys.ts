import type { NewsProvider, ProviderKey, Store } from "./types.ts";

export const NEWS_KEY_RESET_TIME_KEY = "news:key_reset_time";
export const DEFAULT_NEWS_KEY_RESET_TIME = "05:00";
export const NEWS_KEY_COOLDOWN_MS = 60_000;
const INDIA_OFFSET_MS = 330 * 60_000;

type BlockKind = "daily" | "auth" | "cooldown";
interface KeyBlock {
  version: 1;
  kind: BlockKind;
  until: number | null;
}

export function validResetTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export async function newsKeyResetTime(store: Store): Promise<string> {
  const value = await store.getKV(NEWS_KEY_RESET_TIME_KEY);
  return validResetTime(value) ? value : DEFAULT_NEWS_KEY_RESET_TIME;
}

/** Strictly next reset instant (not the current one), in the fixed Asia/Kolkata zone. */
export function nextNewsKeyReset(
  now: Date,
  resetTime = DEFAULT_NEWS_KEY_RESET_TIME,
): Date {
  const time = validResetTime(resetTime)
    ? resetTime
    : DEFAULT_NEWS_KEY_RESET_TIME;
  const [hour, minute] = time.split(":").map(Number);
  const local = new Date(now.getTime() + INDIA_OFFSET_MS);
  const candidate = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    hour,
    minute,
  ) - INDIA_OFFSET_MS;
  return new Date(
    candidate <= now.getTime() ? candidate + 24 * 60 * 60_000 : candidate,
  );
}

export async function nextConfiguredNewsKeyReset(
  store: Store,
  now: Date,
): Promise<Date> {
  return nextNewsKeyReset(now, await newsKeyResetTime(store));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function opaqueProviderGeneration(
  provider: NewsProvider,
  slot: number,
  key: string,
): Promise<string> {
  return `derived-${
    (await sha256Hex(`${provider}\0${slot}\0${key}`)).slice(0, 40)
  }`;
}

/** Opaque, stable generation for legacy env keys. Never persist the key itself. */
export async function legacyProviderKeys(
  provider: NewsProvider,
): Promise<ProviderKey[]> {
  const values: Array<{ slot: number; key: string }> = [];
  if (provider === "groq") {
    for (const slot of [1, 2]) {
      const key = Deno.env.get(`GROQ_API_KEY_${slot}`)?.trim();
      if (key) values.push({ slot, key });
    }
  } else {
    const one = Deno.env.get("TAVILY_API_KEY_1")?.trim() ||
      Deno.env.get("TAVILY_API_KEY")?.trim();
    const two = Deno.env.get("TAVILY_API_KEY_2")?.trim();
    if (one) values.push({ slot: 1, key: one });
    if (two) values.push({ slot: 2, key: two });
  }
  const rows: ProviderKey[] = [];
  for (const row of values) {
    rows.push({
      ...row,
      generation: `legacy-${
        (await sha256Hex(`${provider}\0${row.key}`)).slice(0, 40)
      }`,
    });
  }
  return dedupeProviderKeys(rows);
}

/** Sorts slots, removes invalid/duplicate secrets, and caps news to its two allowed slots. */
export function dedupeProviderKeys(keys: ProviderKey[]): ProviderKey[] {
  const seen = new Set<string>();
  const slots = new Set<number>();
  const out: ProviderKey[] = [];
  for (const row of [...keys].sort((a, b) => a.slot - b.slot)) {
    if (
      !Number.isInteger(row.slot) || row.slot < 1 || row.slot > 2 || !row.key ||
      !row.generation || seen.has(row.key) || slots.has(row.slot)
    ) continue;
    seen.add(row.key);
    slots.add(row.slot);
    out.push({ slot: row.slot, key: row.key, generation: row.generation });
  }
  return out;
}

export async function providerKeys(
  store: Store,
  provider: NewsProvider,
): Promise<ProviderKey[]> {
  const keys = store.getProviderKeys
    ? await store.getProviderKeys(provider)
    : await legacyProviderKeys(provider);
  return dedupeProviderKeys(keys);
}

async function stateKey(
  provider: NewsProvider,
  key: ProviderKey,
): Promise<string> {
  // Hash the generation again before placing it in the KV key: even a malformed
  // upstream generation must never make credential-like text part of state.
  const fingerprint =
    (await sha256Hex(`${provider}\0${key.slot}\0${key.generation}`)).slice(
      0,
      40,
    );
  return `news:key_block:${provider}:${key.slot}:${fingerprint}`;
}

function validBlock(value: unknown): KeyBlock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    !["daily", "auth", "cooldown"].includes(String(row.kind))
  ) return null;
  if (row.kind === "auth") return { version: 1, kind: "auth", until: null };
  const until = Number(row.until);
  return Number.isFinite(until)
    ? { version: 1, kind: row.kind as BlockKind, until }
    : null;
}

export async function newsKeyBlocked(
  store: Store,
  provider: NewsProvider,
  key: ProviderKey,
  now: Date,
): Promise<boolean> {
  const block = validBlock(await store.getKV(await stateKey(provider, key)));
  if (!block) return false;
  if (block.kind === "auth") return true;
  // At the exact reset/cooldown boundary a daily block is expired.
  return (block.until || 0) > now.getTime();
}

export async function blockNewsKey(
  store: Store,
  provider: NewsProvider,
  key: ProviderKey,
  kind: BlockKind,
  now: Date,
): Promise<void> {
  let until: number | null = null;
  if (kind === "daily") {
    until = (await nextConfiguredNewsKeyReset(store, now)).getTime();
  } else if (kind === "cooldown") until = now.getTime() + NEWS_KEY_COOLDOWN_MS;
  await store.setKV(
    await stateKey(provider, key),
    { version: 1, kind, until } satisfies KeyBlock,
  );
}
