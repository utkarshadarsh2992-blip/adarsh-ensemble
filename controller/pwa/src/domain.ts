export const PROVIDERS = [
  "groq",
  "openrouter",
  "gemini",
  "nvidia",
  "cloudflare",
] as const;
export type Provider = (typeof PROVIDERS)[number];
export const NAMES: Record<Provider, string> = {
  groq: "Groq",
  openrouter: "OpenRouter",
  gemini: "Gemini",
  nvidia: "NVIDIA",
  cloudflare: "Cloudflare",
};
export const HOSTS: Record<Provider, string> = {
  groq: "api.groq.com",
  openrouter: "openrouter.ai",
  gemini: "generativelanguage.googleapis.com",
  nvidia: "integrate.api.nvidia.com",
  cloudflare: "api.cloudflare.com",
};
export type Model = {
  label: string;
  provider: Provider;
  model: string;
  enabled: boolean;
  extra: Record<string, string>;
};
export type Quality = {
  truthLevel?: "strict" | "balanced" | "creative";
  factCheck?: "off" | "auto" | "always";
  builtInWebSearch?: boolean;
  /** Standard chat may use the non-Groq models of utility:quick (owner order). */
  standardOtherProviders?: boolean;
  audit?: boolean;
  ground?: boolean;
  research?: boolean;
  review?: boolean;
  debate?: boolean;
};
export type Config = {
  schema_version: 1;
  providers: Record<Provider, { base_url: string }>;
  models: Model[];
  routes: Record<string, string[]>;
  quality: Quality;
  limits: Partial<
    Record<Provider, { daily_tokens?: number; daily_requests?: number }>
  >;
};
export type ModelUsage = {
  model: string;
  label: string;
  req: number;
  tok: number;
  req_limit: number;
  tok_limit: number;
};
export type UsageProvider = {
  id: Provider;
  name: string;
  req: number;
  tok: number;
  set?: number;
  keys?: {
    slot: number;
    set: boolean;
    generation?: string;
    active?: boolean;
    tracked_since_day?: string;
    req: number;
    tok: number;
    state: string;
    models: ModelUsage[];
  }[];
};
export type Report = {
  day_utc: string;
  sampled_at?: number;
  totals: { req: number; tok: number };
  providers: UsageProvider[];
  features?: Record<string, number>;
  truth?: Record<string, number>;
  days?: {
    day: string;
    req: number;
    tok: number;
    by: Record<string, number>;
  }[];
};
export type Device = {
  id: string;
  name: string;
  last_seen: string | null;
  revoked_at: string | null;
  config_revision: number;
  applied_revision?: number | null;
};
export type State = {
  ok: true;
  revision: number;
  config: Config;
  devices: Device[];
  usage: {
    device_id: string;
    day_utc: string;
    report: Report;
    updated_at: string;
  }[];
  history: {
    revision: number;
    created_at: string;
    actor_id: string;
    reason: string;
  }[];
  next_cursor?: string;
};
export const number = (n: number) => new Intl.NumberFormat("en-IN").format(n);
export function endpointError(provider: Provider, raw: string): string | null {
  try {
    if (
      raw.includes("\\") ||
      /[\s\u0000-\u001f]/.test(raw) ||
      raw.includes("%") ||
      /(?:\/\.\.?\/)/i.test(raw)
    )
      return "Unsafe endpoint path.";
    const u = new URL(raw.replace("{CLOUDFLARE_ACCOUNT_ID}", "LOCAL_ACCOUNT"));
    const authority = raw.match(/^https:\/\/([^/]+)/i)?.[1]?.toLowerCase();
    if (
      u.protocol !== "https:" ||
      u.hostname !== HOSTS[provider] ||
      authority !== HOSTS[provider] ||
      u.username ||
      u.password ||
      u.port ||
      u.search ||
      u.hash
    )
      return `Sirf HTTPS ${HOSTS[provider]} allowed hai.`;
    if (
      raw.endsWith("/chat/completions") ||
      raw.includes("..") ||
      /\{/.test(raw.replace("{CLOUDFLARE_ACCOUNT_ID}", ""))
    )
      return "Base URL do; chat/completions nahi.";
    if (
      provider === "cloudflare" &&
      (raw.split("{CLOUDFLARE_ACCOUNT_ID}").length !== 2 ||
        !raw.includes("/accounts/{CLOUDFLARE_ACCOUNT_ID}/"))
    )
      return "Cloudflare account placeholder zaroori hai; ID app mein rahegi.";
    return null;
  } catch {
    return "Valid HTTPS endpoint chahiye.";
  }
}
export function modelError(m: Model): string | null {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(m.label))
    return "Label: 1–60 letters, numbers, dots, hyphens.";
  if (
    !m.model.trim() ||
    m.model.length > 128 ||
    /[\s\u0000-\u001f]/.test(m.model) || !/^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,127}$/.test(m.model)
  )
    return "Valid provider model ID chahiye (max 200).";
  if (!PROVIDERS.includes(m.provider)) return "Unsupported provider.";
  return null;
}
export function routeError(
  key: string,
  labels: string[],
  config: Config,
): string | null {
  if (
    !labels.length ||
    labels.length > 10 ||
    new Set(labels).size !== labels.length
  )
    return "1–10 unique models choose karo.";
  const models = labels.map((l) =>
    config.models.find((m) => m.label === l && m.enabled),
  );
  if (models.some((m) => !m))
    return "Disabled ya missing model chain mein nahi aa sakta.";
  const p = models.map((m) => m!.provider);
  if (
    !["groq", "openrouter", "gemini"].every((id) => p.includes(id as Provider))
  )
    return "Fallback mein Groq, OpenRouter aur Gemini teeno chahiye.";
  if (p[0] === p[1]) return "Pehla fallback primary se alag provider ka ho.";
  return null;
}
export function aggregate(
  state: State | null,
  day = new Date().toISOString().slice(0, 10),
) {
  const reports =
    state?.usage.filter((u) => u.day_utc === day).map((u) => u.report) ?? [];
  const providers = PROVIDERS.map((id) => ({
    id,
    name: NAMES[id],
    req: reports.reduce(
      (s, r) => s + (r.providers.find((p) => p.id === id)?.req ?? 0),
      0,
    ),
    tok: reports.reduce(
      (s, r) => s + (r.providers.find((p) => p.id === id)?.tok ?? 0),
      0,
    ),
  }));
  return {
    reports,
    providers,
    req: reports.reduce((s, r) => s + r.totals.req, 0),
    tok: reports.reduce((s, r) => s + r.totals.tok, 0),
  };
}

export type DetachResult =
  | { ok: true; routes: Record<string, string[]>; changed: string[] }
  | { ok: false; error: string };

/**
 * Remove (or disable) `label` from every route that uses it, so the model can be
 * removed in one step. Each touched chain keeps the app's rules (1-10 unique models,
 * Groq + OpenRouter + Gemini present, first fallback from another provider): when
 * removing the label breaks a rule, another enabled model of the missing provider is
 * added to the end of that chain. The result is returned as full route overrides.
 */
export function detachModelFromRoutes(
  config: Config,
  defaults: Record<string, string[]>,
  label: string,
): DetachResult {
  const after: Config = {
    ...config,
    models: config.models.filter((m) => m.label !== label),
  };
  const keys = new Set([...Object.keys(defaults), ...Object.keys(config.routes)]);
  const routes = { ...config.routes };
  const changed: string[] = [];
  const providerOf = (l: string) => after.models.find((m) => m.label === l)?.provider;
  for (const key of keys) {
    const current = Object.hasOwn(config.routes, key)
      ? config.routes[key]
      : defaults[key];
    if (!current || !current.includes(label)) continue;
    let chain = current.filter((l) => l !== label);
    for (let guard = 0; guard < 12; guard++) {
      const issue = routeError(key, chain, after);
      if (!issue) break;
      const have = new Set(chain.map(providerOf));
      const missing = (["groq", "openrouter", "gemini"] as const).find(
        (p) => !have.has(p),
      );
      if (missing) {
        const pick = after.models.find(
          (m) => m.enabled && m.provider === missing && !chain.includes(m.label),
        );
        if (!pick || chain.length >= 10)
          return { ok: false, error: `${key}: ${missing} ka koi enabled model nahi mila.` };
        chain = [...chain, pick.label];
        continue;
      }
      if (chain.length >= 2 && providerOf(chain[0]) === providerOf(chain[1])) {
        const j = chain.findIndex((l, i) => i > 1 && providerOf(l) !== providerOf(chain[0]));
        if (j < 0)
          return { ok: false, error: `${key}: doosre provider ka fallback nahi mila.` };
        chain = [chain[0], chain[j], ...chain.filter((_, i) => i !== 0 && i !== j)];
        continue;
      }
      return { ok: false, error: `${key}: ${issue}` };
    }
    if (routeError(key, chain, after))
      return { ok: false, error: `${key}: chain theek nahi ban payi.` };
    routes[key] = chain;
    changed.push(key);
  }
  return { ok: true, routes, changed };
}
/** Route whose Groq entries drive the direct Standard chat (Groq-only, in order). */
export const STANDARD_ROUTE = "utility:quick";
function quickBase(config: Config, bundled: Record<string, string[]>) {
  const raw = config.routes[STANDARD_ROUTE] ?? bundled[STANDARD_ROUTE] ?? [];
  return raw.filter((label) =>
    config.models.some((m) => m.label === label && m.enabled),
  );
}
/** True when the owner let Standard chat use other providers (needs an explicit utility:quick route). */
export function standardOtherOn(config: Config): boolean {
  return config.quality.standardOtherProviders === true;
}
/** Models Standard chat will call, primary first (what the app resolves at runtime). */
export function standardChain(
  config: Config,
  bundled: Record<string, string[]>,
): string[] {
  const explicit = Object.hasOwn(config.routes, STANDARD_ROUTE);
  if (standardOtherOn(config) && explicit) return quickBase(config, bundled);
  const groq = (label: string) =>
    config.models.find((m) => m.label === label)?.provider === "groq";
  const labels = quickBase(config, bundled).filter(groq);
  // Without an explicit override the app uses only the first bundled Groq entry.
  return explicit ? labels : labels.slice(0, 1);
}
/** Turn "Standard may use other providers" on/off. On pins the current utility:quick chain as an override. */
export function setStandardOtherProviders(
  config: Config,
  on: boolean,
  bundled: Record<string, string[]>,
): { ok: true; config: Config } | { ok: false; error: string } {
  const quality = { ...config.quality };
  if (on) quality.standardOtherProviders = true;
  else delete quality.standardOtherProviders;
  const routes = { ...config.routes };
  if (on && !Object.hasOwn(routes, STANDARD_ROUTE)) {
    const chain = quickBase(config, bundled);
    const issue = routeError(STANDARD_ROUTE, chain, config);
    if (issue) return { ok: false, error: issue };
    routes[STANDARD_ROUTE] = chain;
  }
  if (!on && !standardChain({ ...config, quality, routes }, bundled).length)
    return { ok: false, error: "Groq-only ke liye utility:quick mein ek enabled Groq model chahiye." };
  return { ok: true, config: { ...config, quality, routes } };
}
/**
 * Make `label` the Standard primary (Groq only, unless other providers are allowed).
 * The utility:quick chain becomes [label, other-provider fallbacks..., same-provider models...]
 * so it keeps the Groq + OpenRouter + Gemini coverage and a different-provider first fallback.
 */
export function setStandardPrimary(
  config: Config,
  label: string,
  bundled: Record<string, string[]>,
): { ok: true; config: Config } | { ok: false; error: string } {
  const model = config.models.find((m) => m.label === label);
  const other = standardOtherOn(config);
  if (!model || !model.enabled || (!other && model.provider !== "groq"))
    return {
      ok: false,
      error: other
        ? "Standard mode ke liye enabled model choose karo."
        : "Standard mode sirf enabled Groq model use karta hai.",
    };
  const providerOf = (l: string) =>
    config.models.find((m) => m.label === l)?.provider;
  const base = quickBase(config, bundled).filter((l) => l !== label);
  let chain = [
    label,
    ...base.filter((l) => providerOf(l) !== model.provider),
    ...base.filter((l) => providerOf(l) === model.provider),
  ];
  for (const need of ["groq", "openrouter", "gemini"] as Provider[]) {
    if (chain.some((l) => providerOf(l) === need)) continue;
    const extra = config.models.find((m) => m.enabled && m.provider === need);
    if (extra) chain.splice(1, 0, extra.label);
  }
  chain = chain.slice(0, 10);
  const next = { ...config, routes: { ...config.routes, [STANDARD_ROUTE]: chain } };
  const issue = routeError(STANDARD_ROUTE, chain, next);
  return issue ? { ok: false, error: issue } : { ok: true, config: next };
}
