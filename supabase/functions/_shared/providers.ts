import type {
  FetchLike,
  NewsItem,
  NewsProvider,
  ProviderKey,
  Store,
} from "./types.ts";
import { scoringPrompt } from "./scoring.ts";
import { blockNewsKey, newsKeyBlocked, providerKeys } from "./news-keys.ts";

export type GroqStage = "scoring" | "review" | "patterns";
export interface GroqOptions {
  model?: string;
  maxTokens?: number;
  fallbackModel?: string;
}

async function availableKeys(
  store: Store,
  provider: NewsProvider,
  now: Date,
): Promise<ProviderKey[]> {
  const rows = await providerKeys(store, provider), out: ProviderKey[] = [];
  for (const row of rows) {
    if (!(await newsKeyBlocked(store, provider, row, now))) out.push(row);
  }
  return out;
}

export async function hasAvailableProviderKey(
  store: Store,
  provider: NewsProvider,
  now = new Date(),
): Promise<boolean> {
  return (await availableKeys(store, provider, now)).length > 0;
}

export async function groq(
  store: Store,
  fetcher: FetchLike,
  prompt: string,
  stage: GroqStage,
  now = new Date(),
  options: GroqOptions = {},
): Promise<{ text: string; usage: any; model: string; finish?: string }> {
  const primary = options.model || "openai/gpt-oss-20b";
  const maxTokens = options.maxTokens || 700;
  const models = [
    primary,
    ...(options.fallbackModel && options.fallbackModel !== primary
      ? [options.fallbackModel]
      : []),
  ];
  const keys = await providerKeys(store, "groq");
  const transientThisCall = new Set<string>();
  for (const [modelIndex, model] of models.entries()) {
    const candidates: ProviderKey[] = [];
    for (const key of keys) {
      const identity = `${key.slot}:${key.generation}`;
      // Permit the configured fallback model once after a transient failure;
      // the cooldown still suppresses this generation in later invocations.
      if (modelIndex > 0 && transientThisCall.has(identity)) {
        candidates.push(key);
      } else if (!(await newsKeyBlocked(store, "groq", key, now))) {
        candidates.push(key);
      }
    }
    if (!candidates.length) break;
    for (const key of candidates) {
      const identity = `${key.slot}:${key.generation}`;
      let response: Response;
      try {
        response = await fetcher(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${key.key}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: prompt }],
              reasoning_effort: "low",
              max_completion_tokens: maxTokens,
              temperature: .2,
            }),
          },
        );
      } catch {
        await blockNewsKey(store, "groq", key, "cooldown", now);
        transientThisCall.add(identity);
        continue;
      }
      if (response.status === 429 || response.status === 402) {
        await blockNewsKey(store, "groq", key, "daily", now);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await blockNewsKey(store, "groq", key, "auth", now);
        continue;
      }
      if (response.status >= 500) {
        await blockNewsKey(store, "groq", key, "cooldown", now);
        transientThisCall.add(identity);
        continue;
      }
      if (!response.ok) {
        throw new Error(`Groq request failed (${response.status})`);
      }
      let payload: any;
      try {
        payload = await response.json();
      } catch {
        await blockNewsKey(store, "groq", key, "cooldown", now);
        transientThisCall.add(identity);
        continue;
      }
      const usage = payload.usage || {};
      try {
        await store.bumpUsage({
          day: now.toISOString().slice(0, 10),
          provider: "groq",
          model,
          stage,
          calls: 1,
          tokens_in: usage.prompt_tokens || 0,
          tokens_out: usage.completion_tokens || 0,
        });
      } catch {
        // The upstream call succeeded; do not retry it if usage persistence fails.
        throw new Error("Groq usage accounting failed");
      }
      return {
        text: String(payload.choices?.[0]?.message?.content || ""),
        usage,
        model,
        finish: String(payload.choices?.[0]?.finish_reason || ""),
      };
    }
  }
  throw new Error("Groq keys unavailable");
}

export async function tavily(
  store: Store,
  fetcher: FetchLike,
  query: string,
  now = new Date(),
): Promise<any> {
  const keys = await availableKeys(store, "tavily", now);
  for (const key of keys) {
    let response: Response;
    try {
      response = await fetcher("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          authorization: `Bearer ${key.key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          api_key: key.key,
          query,
          search_depth: "advanced",
          max_results: 8,
        }),
      });
    } catch {
      await blockNewsKey(store, "tavily", key, "cooldown", now);
      continue;
    }
    // Tavily documents 432 (key/plan limit) and 433 (PayGo spending limit).
    if ([402, 429, 432, 433].includes(response.status)) {
      await blockNewsKey(store, "tavily", key, "daily", now);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      await blockNewsKey(store, "tavily", key, "auth", now);
      continue;
    }
    if (response.status >= 500) {
      await blockNewsKey(store, "tavily", key, "cooldown", now);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Tavily request failed (${response.status})`);
    }
    try {
      return await response.json();
    } catch {
      await blockNewsKey(store, "tavily", key, "cooldown", now);
    }
  }
  throw new Error("Tavily keys unavailable");
}

export function independentSources(
  results: any[],
  original: string,
  stateDomains: string[],
): number {
  let domain = "";
  try {
    domain = new URL(original).hostname;
  } catch {}
  const seen = new Set<string>();
  for (const x of results || []) {
    try {
      const d = new URL(x.url).hostname;
      if (d !== domain && !stateDomains.some((s) => d.endsWith(s))) seen.add(d);
    } catch {}
  }
  return seen.size;
}
export { scoringPrompt };
