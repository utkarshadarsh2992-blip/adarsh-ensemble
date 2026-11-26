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
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,59}$/.test(m.label))
    return "Label: 1–60 letters, numbers, dots, hyphens.";
  if (
    !m.model.trim() ||
    m.model.length > 200 ||
    /[\s\u0000-\u001f]/.test(m.model)
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
