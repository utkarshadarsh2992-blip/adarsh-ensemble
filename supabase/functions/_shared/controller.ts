export const PROVIDER_HOSTS = {
  groq: 'api.groq.com',
  openrouter: 'openrouter.ai',
  gemini: 'generativelanguage.googleapis.com',
  nvidia: 'integrate.api.nvidia.com',
  cloudflare: 'api.cloudflare.com',
} as const;

export type ProviderId = keyof typeof PROVIDER_HOSTS;
export type ControllerModel = {
  label: string;
  provider: ProviderId;
  model: string;
  enabled: boolean;
  extra: Record<string, string>;
};
export type ControllerConfig = {
  schema_version: 1;
  revision?: number;
  issued_at?: string;
  rollback_of?: number;
  providers: Record<ProviderId, { base_url: string }>;
  models: ControllerModel[];
  routes: Record<string, string[]>;
  quality: Record<string, string | boolean>;
  limits: Record<string, Record<string, number>>;
};

export class ControllerFault extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(status: number, code: string, details?: Record<string, unknown>) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function fault(status: number, code: string, details?: Record<string, unknown>): never {
  throw new ControllerFault(status, code, details);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], code = 'invalid_config'): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fault(400, code);
}

function boundedString(value: unknown, max: number, code: string, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.trim().length ===  0) || /[\u0000-\u001f\u007f]/.test(value)) {
    fault(400, code);
  }
  return value;
}

function looksSecretLike(value: string): boolean {
  return /(?:bearer\s+\S+|(?:sk|rk|pk|nvapi|gsk)[_-][A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.|[A-Za-z0-9_-]{40,})/i.test(value);
}

function integer(value: unknown, min: number, max: number, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fault(400, code);
  return value;
}

function bool(value: unknown, code: string): boolean {
  if (typeof value !== 'boolean') fault(400, code);
  return value;
}

const providerIds = Object.keys(PROVIDER_HOSTS) as ProviderId[];
const modelIdPattern = /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,127}$/;
const labelPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const knownFeatures = new Set(['standard', 'briefing', 'checks', 'factcheck', 'guard', 'voice', 'news', 'council', 'other']);
const providerNames: Record<ProviderId, string> = {
  groq: 'Groq', openrouter: 'OpenRouter', gemini: 'Gemini', nvidia: 'NVIDIA', cloudflare: 'Cloudflare',
};

export const DEFAULT_PROVIDERS: ControllerConfig['providers'] = {
  groq: { base_url: 'https://api.groq.com/openai/v1' },
  openrouter: { base_url: 'https://openrouter.ai/api/v1' },
  gemini: { base_url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  nvidia: { base_url: 'https://integrate.api.nvidia.com/v1' },
  cloudflare: { base_url: 'https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1' },
};

// Registry labels, IDs, and safe extras mirror the bundled config.py registry. Keys and endpoint credentials are never included.
export const DEFAULT_MODELS: ControllerModel[] = [
  { label: 'gpt-oss-120b', provider: 'groq', model: 'openai/gpt-oss-120b', enabled: true, extra: { reasoning_effort: 'medium' } },
  { label: 'gpt-oss-20b', provider: 'groq', model: 'openai/gpt-oss-20b', enabled: true, extra: { reasoning_effort: 'medium' } },
  { label: 'qwen3.8-27b', provider: 'groq', model: 'qwen/qwen3.8-27b', enabled: true, extra: { reasoning_format: 'hidden' } },
  { label: 'safeguard-20b', provider: 'groq', model: 'openai/gpt-oss-safeguard-20b', enabled: true, extra: { reasoning_effort: 'low' } },
  { label: 'prompt-guard-22m', provider: 'groq', model: 'meta-llama/llama-prompt-guard-2-22m', enabled: true, extra: {} },
  { label: 'prompt-guard-86m', provider: 'groq', model: 'meta-llama/llama-prompt-guard-2-86m', enabled: true, extra: {} },
  { label: 'nemotron-ultra', provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', enabled: true, extra: {} },
  { label: 'nemotron-lightning', provider: 'openrouter', model: 'nvidia/nemotron-3.5-lightning:free', enabled: true, extra: {} },
  { label: 'nemotron-super-vl', provider: 'openrouter', model: 'nvidia/nemotron-3.5-super-vl:free', enabled: true, extra: {} },
  { label: 'nemotron-nano-omni', provider: 'openrouter', model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', enabled: true, extra: {} },
  { label: 'gemma-4-31b', provider: 'openrouter', model: 'google/gemma-4-31b-it:free', enabled: true, extra: {} },
  { label: 'gemma-4-26b', provider: 'openrouter', model: 'google/gemma-4-26b-a4b-it:free', enabled: true, extra: {} },
  { label: 'ernie-5.5-flash', provider: 'openrouter', model: 'baidu/ernie-5.5-flash-preview:free', enabled: true, extra: {} },
  { label: 'ling-3.2-flash', provider: 'openrouter', model: 'inclusionai/ling-3.2-flash:free', enabled: true, extra: {} },
  { label: 'particle-1', provider: 'openrouter', model: 'particle-ai/particle-1:free', enabled: true, extra: {} },
  { label: 'flint', provider: 'openrouter', model: 'recursive/flint-v1.0:free', enabled: true, extra: {} },
  { label: 'lfm-3-1.7b', provider: 'openrouter', model: 'liquid/lfm-3-1.7b:free', enabled: true, extra: {} },
  { label: 'or-free-router', provider: 'openrouter', model: 'openrouter/free', enabled: true, extra: {} },
  { label: 'gemini-3.8-flash', provider: 'gemini', model: 'gemini-3.8-flash', enabled: true, extra: {} },
  { label: 'gemini-3.1-flash-lite', provider: 'gemini', model: 'gemini-3.1-flash-lite', enabled: true, extra: { reasoning_effort: 'low' } },
  { label: 'gemma-4-31b-g', provider: 'gemini', model: 'gemma-4-31b-it', enabled: true, extra: {} },
  { label: 'gemma-4-26b-g', provider: 'gemini', model: 'gemma-4-26b-a4b-it', enabled: true, extra: {} },
  { label: 'gemini-3.5-flash-lite', provider: 'gemini', model: 'gemini-3.5-flash-lite', enabled: true, extra: { reasoning_effort: 'low' } },
  { label: 'cf-gpt-oss-120b', provider: 'cloudflare', model: '@cf/openai/gpt-oss-120b', enabled: true, extra: {} },
  { label: 'cf-gemma-4-26b', provider: 'cloudflare', model: '@cf/google/gemma-4-26b-a4b-it', enabled: true, extra: {} },
  { label: 'mistral-large-4', provider: 'nvidia', model: 'mistralai/mistral-large-4-1t-a52b', enabled: true, extra: {} },
  { label: 'laguna-xs-2.1', provider: 'nvidia', model: 'poolside/laguna-xs-2.1', enabled: true, extra: {} },
  { label: 'glm-5-3-flash', provider: 'nvidia', model: 'z-ai/glm-5-3-flash', enabled: true, extra: {} },
  { label: 'inkling-2-small', provider: 'openrouter', model: 'thinkingmachines/inkling-2-small:free', enabled: true, extra: {} },
];

const chain = (primary: string, ...fallbacks: string[]) => [primary, ...fallbacks];

// Canonical routes copied from the generated src/default-routes.json; partial overrides resolve against these exact chains.
export const BUNDLED_ROUTE_CHAINS: Readonly<Record<string, readonly string[]>> = {
  'mode:standard:architect': chain('gemini-3.1-flash-lite', 'gpt-oss-20b', 'nemotron-lightning', 'gemini-3.5-flash-lite'),
  'mode:standard:theorist': chain('gpt-oss-20b', 'gemini-3.5-flash-lite', 'gpt-oss-120b', 'ling-3.2-flash'),
  'mode:standard:empiricist': chain('gemma-4-26b-g', 'qwen3.8-27b', 'ling-3.2-flash', 'gemini-3.5-flash-lite'),
  'mode:standard:specialist': chain('gemini-3.8-flash', 'gpt-oss-120b', 'nemotron-super-vl', 'gemma-4-31b-g', 'mistral-large-4'),
  'mode:standard:pattern': chain('mistral-large-4', 'gemini-3.5-flash-lite', 'gpt-oss-120b', 'nemotron-lightning'),
  'mode:standard:skeptic': chain('gemini-3.1-flash-lite', 'gpt-oss-20b', 'nemotron-lightning'),
  'mode:standard:debater': chain('gpt-oss-120b', 'gemini-3.5-flash-lite', 'nemotron-ultra', 'mistral-large-4'),
  'mode:standard:judge': chain('gemini-3.8-flash', 'gpt-oss-120b', 'nemotron-ultra', 'mistral-large-4', 'or-free-router'),
  'mode:standard:method': chain('qwen3.8-27b', 'gemini-3.5-flash-lite', 'nemotron-lightning'),
  'mode:standard:evidence': chain('gpt-oss-120b', 'gemini-3.5-flash-lite', 'nemotron-lightning', 'mistral-large-4'),
  'mode:standard:refiner': chain('gemini-3.5-flash-lite', 'gpt-oss-120b', 'nemotron-ultra', 'gemini-3.8-flash'),
  'mode:standard:verifier': chain('qwen3.8-27b', 'gemini-3.8-flash', 'particle-1', 'gpt-oss-120b', 'flint'),
  'mode:standard:falsifier1': chain('gpt-oss-120b', 'gemini-3.5-flash-lite', 'nemotron-lightning'),
  'mode:standard:falsifier2': chain('gemma-4-31b-g', 'qwen3.8-27b', 'ernie-5.5-flash'),
  'mode:standard:falsifier3': chain('nemotron-ultra', 'gpt-oss-20b', 'gemini-3.1-flash-lite'),

  'mode:verified:architect': chain('gemma-4-31b-g', 'gpt-oss-120b', 'nemotron-super-vl', 'gemini-3.1-flash-lite'),
  'mode:verified:theorist': chain('gpt-oss-120b', 'gemma-4-31b-g', 'nemotron-ultra', 'qwen3.8-27b', 'cf-gpt-oss-120b'),
  'mode:verified:empiricist': chain('qwen3.8-27b', 'gemma-4-26b-g', 'particle-1', 'gpt-oss-120b'),
  'mode:verified:specialist': chain('nemotron-ultra', 'gemma-4-26b-g', 'gpt-oss-20b', 'glm-5-3-flash'),
  'mode:verified:pattern': chain('mistral-large-4', 'gemini-3.5-flash-lite', 'gpt-oss-20b', 'nemotron-super-vl'),
  'mode:verified:skeptic': chain('gpt-oss-20b', 'gemini-3.1-flash-lite', 'nemotron-lightning'),
  'mode:verified:debater': chain('gpt-oss-120b', 'gemini-3.8-flash', 'nemotron-ultra', 'mistral-large-4'),
  'mode:verified:judge': chain('gemini-3.8-flash', 'nemotron-ultra', 'gpt-oss-120b', 'mistral-large-4', 'or-free-router'),
  'mode:verified:method': chain('qwen3.8-27b', 'gemini-3.5-flash-lite', 'nemotron-ultra', 'gpt-oss-120b'),
  'mode:verified:evidence': chain('gpt-oss-120b', 'gemini-3.5-flash-lite', 'mistral-large-4', 'nemotron-ultra'),
  'mode:verified:refiner': chain('mistral-large-4', 'gemini-3.8-flash', 'gpt-oss-120b', 'nemotron-ultra'),
  'mode:verified:verifier': chain('qwen3.8-27b', 'gemini-3.8-flash', 'particle-1', 'gpt-oss-120b', 'flint'),
  'mode:verified:falsifier1': chain('gemma-4-31b-g', 'gpt-oss-20b', 'ernie-5.5-flash'),
  'mode:verified:falsifier2': chain('ernie-5.5-flash', 'gemini-3.5-flash-lite', 'gpt-oss-120b'),
  'mode:verified:falsifier3': chain('glm-5-3-flash', 'gemini-3.5-flash-lite', 'qwen3.8-27b', 'ling-3.2-flash'),

  'mode:physics:architect': chain('gemma-4-31b-g', 'gpt-oss-20b', 'nemotron-super-vl', 'gemini-3.1-flash-lite'),
  'mode:physics:theorist': chain('gpt-oss-120b', 'gemini-3.8-flash', 'nemotron-ultra', 'qwen3.8-27b', 'cf-gpt-oss-120b'),
  'mode:physics:empiricist': chain('gemini-3.8-flash', 'qwen3.8-27b', 'nemotron-super-vl', 'gemma-4-31b-g'),
  'mode:physics:specialist': chain('nemotron-ultra', 'qwen3.8-27b', 'gemini-3.5-flash-lite', 'glm-5-3-flash'),
  'mode:physics:pattern': chain('mistral-large-4', 'gemma-4-31b-g', 'gpt-oss-20b', 'nemotron-ultra'),
  'mode:physics:skeptic': chain('gpt-oss-20b', 'gemini-3.1-flash-lite', 'nemotron-lightning'),
  'mode:physics:debater': chain('gpt-oss-120b', 'gemini-3.8-flash', 'nemotron-ultra', 'mistral-large-4'),
  'mode:physics:judge': chain('gemini-3.8-flash', 'nemotron-ultra', 'gpt-oss-120b', 'mistral-large-4', 'or-free-router'),
  'mode:physics:method': chain('qwen3.8-27b', 'gemini-3.5-flash-lite', 'nemotron-ultra', 'gpt-oss-120b'),
  'mode:physics:evidence': chain('gpt-oss-120b', 'gemini-3.5-flash-lite', 'mistral-large-4', 'nemotron-lightning'),
  'mode:physics:refiner': chain('gemini-3.8-flash', 'gpt-oss-120b', 'nemotron-ultra', 'mistral-large-4'),
  'mode:physics:verifier': chain('qwen3.8-27b', 'gemini-3.8-flash', 'particle-1', 'gpt-oss-120b', 'flint'),
  'mode:physics:falsifier1': chain('qwen3.8-27b', 'gemini-3.5-flash-lite', 'nemotron-ultra'),
  'mode:physics:falsifier2': chain('gemma-4-31b-g', 'gpt-oss-20b', 'ernie-5.5-flash'),
  'mode:physics:falsifier3': chain('glm-5-3-flash', 'gemini-3.5-flash-lite', 'gpt-oss-120b', 'ling-3.2-flash'),

  'mode:math:architect': chain('gpt-oss-20b', 'gemini-3.1-flash-lite', 'nemotron-lightning', 'gemma-4-31b-g'),
  'mode:math:theorist': chain('gpt-oss-120b', 'gemini-3.8-flash', 'nemotron-ultra', 'qwen3.8-27b', 'cf-gpt-oss-120b'),
  'mode:math:empiricist': chain('qwen3.8-27b', 'gemini-3.8-flash', 'particle-1', 'gpt-oss-120b', 'glm-5-3-flash'),
  'mode:math:specialist': chain('nemotron-ultra', 'gpt-oss-120b', 'gemini-3.8-flash', 'glm-5-3-flash'),
  'mode:math:pattern': chain('gemini-3.5-flash-lite', 'gpt-oss-20b', 'mistral-large-4', 'nemotron-super-vl'),
  'mode:math:skeptic': chain('gemini-3.1-flash-lite', 'gpt-oss-20b', 'nemotron-lightning'),
  'mode:math:debater': chain('gpt-oss-120b', 'gemini-3.8-flash', 'nemotron-ultra', 'mistral-large-4'),
  'mode:math:judge': chain('gemini-3.8-flash', 'nemotron-ultra', 'gpt-oss-120b', 'mistral-large-4', 'or-free-router'),
  'mode:math:method': chain('qwen3.8-27b', 'gemini-3.8-flash', 'nemotron-ultra', 'gpt-oss-120b'),
  'mode:math:evidence': chain('gpt-oss-20b', 'gemini-3.5-flash-lite', 'nemotron-lightning'),
  'mode:math:refiner': chain('gemini-3.8-flash', 'gpt-oss-120b', 'nemotron-ultra'),
  'mode:math:verifier': chain('qwen3.8-27b', 'gemini-3.8-flash', 'particle-1', 'gpt-oss-120b', 'flint'),
  'mode:math:falsifier1': chain('nemotron-ultra', 'qwen3.8-27b', 'gemini-3.8-flash'),
  'mode:math:falsifier2': chain('gpt-oss-20b', 'gemini-3.5-flash-lite', 'ling-3.2-flash'),
  'mode:math:falsifier3': chain('glm-5-3-flash', 'gemma-4-31b-g', 'gpt-oss-120b', 'nemotron-super-vl'),

  'mode:business:architect': chain('gemini-3.1-flash-lite', 'gpt-oss-20b', 'ernie-5.5-flash'),
  'mode:business:theorist': chain('gpt-oss-120b', 'gemini-3.8-flash', 'nemotron-ultra', 'mistral-large-4'),
  'mode:business:empiricist': chain('gemini-3.8-flash', 'gpt-oss-20b', 'ernie-5.5-flash', 'gemma-4-31b-g'),
  'mode:business:specialist': chain('mistral-large-4', 'gemma-4-26b-g', 'gpt-oss-20b', 'ernie-5.5-flash', 'gemini-3.1-flash-lite'),
  'mode:business:pattern': chain('nemotron-ultra', 'gemini-3.5-flash-lite', 'gpt-oss-120b'),
  'mode:business:skeptic': chain('gpt-oss-20b', 'gemini-3.5-flash-lite', 'nemotron-lightning'),
  'mode:business:debater': chain('gpt-oss-120b', 'gemini-3.8-flash', 'nemotron-ultra', 'mistral-large-4'),
  'mode:business:judge': chain('gemini-3.8-flash', 'mistral-large-4', 'nemotron-ultra', 'gpt-oss-120b', 'or-free-router'),
  'mode:business:method': chain('qwen3.8-27b', 'gemini-3.5-flash-lite', 'nemotron-ultra'),
  'mode:business:evidence': chain('gpt-oss-120b', 'gemini-3.5-flash-lite', 'mistral-large-4', 'nemotron-ultra'),
  'mode:business:refiner': chain('gemini-3.8-flash', 'gpt-oss-120b', 'nemotron-ultra', 'mistral-large-4'),
  'mode:business:verifier': chain('qwen3.8-27b', 'gemini-3.8-flash', 'particle-1', 'gpt-oss-120b', 'flint'),
  'mode:business:falsifier1': chain('qwen3.8-27b', 'gemini-3.5-flash-lite', 'ernie-5.5-flash'),
  'mode:business:falsifier2': chain('gemma-4-31b-g', 'gpt-oss-120b', 'ling-3.2-flash'),
  'mode:business:falsifier3': chain('glm-5-3-flash', 'gemini-3.5-flash-lite', 'gpt-oss-20b', 'nemotron-lightning'),

  'mode:coding:architect': chain('gemma-4-31b-g', 'gpt-oss-20b', 'particle-1', 'gemini-3.1-flash-lite'),
  'mode:coding:theorist': chain('gpt-oss-120b', 'gemini-3.8-flash', 'nemotron-ultra', 'cf-gpt-oss-120b'),
  'mode:coding:empiricist': chain('qwen3.8-27b', 'gemini-3.8-flash', 'particle-1', 'laguna-xs-2.1'),
  'mode:coding:specialist': chain('glm-5-3-flash', 'gemini-3.8-flash', 'nemotron-ultra', 'gpt-oss-20b', 'laguna-xs-2.1'),
  'mode:coding:pattern': chain('mistral-large-4', 'gemini-3.5-flash-lite', 'gpt-oss-20b', 'flint'),
  'mode:coding:skeptic': chain('gpt-oss-20b', 'gemini-3.1-flash-lite', 'flint'),
  'mode:coding:debater': chain('gpt-oss-120b', 'gemini-3.8-flash', 'nemotron-ultra', 'mistral-large-4'),
  'mode:coding:judge': chain('gemini-3.8-flash', 'nemotron-ultra', 'gpt-oss-120b', 'mistral-large-4', 'or-free-router'),
  'mode:coding:method': chain('qwen3.8-27b', 'gemini-3.8-flash', 'particle-1', 'gpt-oss-120b'),
  'mode:coding:evidence': chain('gpt-oss-120b', 'gemini-3.5-flash-lite', 'nemotron-lightning'),
  'mode:coding:refiner': chain('gemini-3.8-flash', 'qwen3.8-27b', 'nemotron-ultra'),
  'mode:coding:verifier': chain('qwen3.8-27b', 'gemini-3.8-flash', 'particle-1', 'gpt-oss-120b', 'flint'),
  'mode:coding:falsifier1': chain('qwen3.8-27b', 'gemma-4-31b-g', 'particle-1'),
  'mode:coding:falsifier2': chain('laguna-xs-2.1', 'gpt-oss-120b', 'gemini-3.5-flash-lite', 'nemotron-lightning'),
  'mode:coding:falsifier3': chain('gemma-4-26b-g', 'gpt-oss-20b', 'flint'),

  'utility:quick': chain('gpt-oss-120b', 'gemini-3.1-flash-lite', 'nemotron-lightning', 'gpt-oss-20b', 'gemini-3.8-flash'),
  'utility:auditor': chain('gpt-oss-120b', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'mistral-large-4', 'nemotron-ultra', 'qwen3.8-27b', 'gemini-3.8-flash'),
  'utility:master_writer': chain('mistral-large-4', 'gemini-3.8-flash', 'gpt-oss-120b', 'nemotron-ultra', 'cf-gpt-oss-120b'),
  'utility:master_auditor': chain('cf-gpt-oss-120b', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'mistral-large-4', 'gpt-oss-120b', 'nemotron-lightning'),
  'utility:classifier': chain('safeguard-20b', 'gemini-3.1-flash-lite', 'lfm-3-1.7b', 'gpt-oss-20b'),
  'utility:stripper': chain('gemini-3.1-flash-lite', 'nemotron-lightning', 'gpt-oss-20b', 'gemini-3.8-flash', 'ling-3.2-flash', 'gemini-3.5-flash-lite'),
  'utility:verifier': chain('qwen3.8-27b', 'gemini-3.8-flash', 'particle-1', 'gpt-oss-120b', 'flint'),
  'utility:judge': chain('gemini-3.8-flash', 'nemotron-ultra', 'gpt-oss-120b', 'mistral-large-4', 'or-free-router'),
  'utility:synthesizer': chain('gemini-3.8-flash', 'nemotron-ultra', 'gpt-oss-120b', 'mistral-large-4', 'or-free-router'),
  'utility:guard_llm': chain('gemini-3.1-flash-lite', 'nemotron-lightning', 'gpt-oss-20b'),
};

const routePattern = /^mode:(?:standard|verified|physics|math|business|coding):(?:architect|theorist|empiricist|specialist|pattern|skeptic|debater|judge|method|evidence|refiner|verifier|falsifier[123])$|^utility:(?:quick|auditor|master_writer|master_auditor|classifier|stripper|verifier|judge|synthesizer|guard_llm)$/;

function validateBaseUrl(provider: ProviderId, raw: unknown): string {
  const value = boundedString(raw, 500, 'invalid_config');
  if (looksSecretLike(value)) fault(400, 'invalid_config');
  if (value !== value.trim() || /[\s\u0000-\u001f\u007f\\]/.test(value) || /[?#]/.test(value)) fault(400, 'invalid_config');
  const match = /^https:\/\/([^/?#]+)([^?#]*)$/i.exec(value);
  if (!match) fault(400, 'invalid_config');
  const authority = match[1];
  const rawPath = match[2] || '/';
  if (authority.includes('@') || authority.includes(':') || authority.toLowerCase() !== PROVIDER_HOSTS[provider]) fault(400, 'invalid_config');
  if (rawPath.includes('%')) fault(400, 'invalid_config');
  const segments = rawPath.split('/');
  for (const segment of segments) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { fault(400, 'invalid_config'); }
    if (decoded === '.' || decoded === '..' || decoded.includes('\\') || /[\u0000-\u001f\u007f]/.test(decoded)) fault(400, 'invalid_config');
  }
  let url: URL;
  try { url = new URL(value); } catch { fault(400, 'invalid_config'); }
  if (url.protocol !== 'https:' || url.hostname !== PROVIDER_HOSTS[provider] || url.username || url.password || url.port || url.search || url.hash) fault(400, 'invalid_config');
  if (/\/(?:chat\/completions)\/?$/i.test(url.pathname)) fault(400, 'invalid_config');
  const placeholder = '{CLOUDFLARE_ACCOUNT_ID}';
  if (provider === 'cloudflare') {
    if (!rawPath.includes('/accounts/{CLOUDFLARE_ACCOUNT_ID}/') || rawPath.split(placeholder).length !== 2 || rawPath.replace(placeholder, '').includes('{') || rawPath.replace(placeholder, '').includes('}')) fault(400, 'invalid_config');
  } else if (/[{}]/.test(value)) {
    fault(400, 'invalid_config');
  }
  return value;
}

function validRouteKey(key: string): boolean {
  return routePattern.test(key);
}

function routeInvariantIssue(labels: string[], models: Map<string, ControllerModel>): Record<string, unknown> | undefined {
  const chainModels = labels.map((label) => models.get(label)!);
  const providers = new Set(chainModels.map((model) => model.provider));
  const missingProviders = ['groq', 'openrouter', 'gemini'].filter((provider) => !providers.has(provider as ProviderId));
  if (missingProviders.length) return { reason: 'missing-core-provider', missing_providers: missingProviders };
  if (chainModels.length > 1 && chainModels[1].provider === chainModels[0].provider) return { reason: 'first-fallback-same-provider' };
  return undefined;
}

export function validateConfig(input: unknown): ControllerConfig {
  if (!isObject(input)) fault(400, 'invalid_config');
  exactKeys(input, ['schema_version', 'revision', 'issued_at', 'rollback_of', 'providers', 'models', 'routes', 'quality', 'limits']);
  if (input.schema_version !== 1 || (input.revision !== undefined && (typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 1)) || (input.rollback_of !== undefined && (typeof input.rollback_of !== 'number' || !Number.isSafeInteger(input.rollback_of) || input.rollback_of < 1)) || (input.issued_at !== undefined && (typeof input.issued_at !== 'string' || Number.isNaN(Date.parse(input.issued_at)))) || !isObject(input.providers) || !isObject(input.routes) || !isObject(input.quality) || !isObject(input.limits) || !Array.isArray(input.models)) fault(400, 'invalid_config');
  exactKeys(input.providers, providerIds);
  const providers = {} as ControllerConfig['providers'];
  for (const id of providerIds) {
    const provider = input.providers[id];
    if (!isObject(provider)) fault(400, 'invalid_config');
    exactKeys(provider, ['base_url']);
    providers[id] = { base_url: validateBaseUrl(id, provider.base_url) };
  }

  if (input.models.length > 100) fault(400, 'invalid_config');
  const labels = new Set<string>();
  const models: ControllerModel[] = input.models.map((raw) => {
    if (!isObject(raw)) fault(400, 'invalid_config');
    exactKeys(raw, ['label', 'provider', 'model', 'enabled', 'extra']);
    const label = boundedString(raw.label, 80, 'invalid_config');
    if (!labelPattern.test(label)) fault(400, 'invalid_config');
    const provider = boundedString(raw.provider, 30, 'invalid_config') as ProviderId;
    const model = boundedString(raw.model, 128, 'invalid_config');
    if (!modelIdPattern.test(model)) fault(400, 'invalid_config');
    if (looksSecretLike(label) || looksSecretLike(model)) fault(400, 'invalid_config');
    if (!providerIds.includes(provider) || labels.has(label) || !isObject(raw.extra)) fault(400, 'invalid_config');
    labels.add(label);
    exactKeys(raw.extra, ['reasoning_effort', 'reasoning_format']);
    const extra: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.extra)) {
      const allowed = key === 'reasoning_effort' ? ['low', 'medium', 'high'] : ['hidden', 'raw', 'parsed'];
      if (typeof value !== 'string' || !allowed.includes(value)) fault(400, 'invalid_config');
      extra[key] = value;
    }
    return { label, provider, model, enabled: bool(raw.enabled, 'invalid_config'), extra };
  });
  const enabledByLabel = new Map(models.filter((model) => model.enabled).map((model) => [model.label, model]));

  const routes: Record<string, string[]> = {};
  for (const [key, rawChain] of Object.entries(input.routes)) {
    if (!validRouteKey(key) || !Object.prototype.hasOwnProperty.call(BUNDLED_ROUTE_CHAINS, key) || !Array.isArray(rawChain) || rawChain.length < 1 || rawChain.length > 10) fault(400, 'invalid_route');
    const routeLabels = rawChain.map((item) => boundedString(item, 80, 'invalid_route'));
    if (new Set(routeLabels).size !== routeLabels.length) fault(400, 'invalid_route', { invalid_routes: [{ route_key: key, reason: 'duplicate-model-label' }] });
    routes[key] = routeLabels;
  }

  // Resolve the exact effective chain for every bundled route; disabling/removing a default reference is rejected until overridden.
  const routeIssues: Record<string, unknown>[] = [];
  for (const [key, bundled] of Object.entries(BUNDLED_ROUTE_CHAINS)) {
    const effective = routes[key] ?? [...bundled];
    if (effective.length < 1 || effective.length > 10 || new Set(effective).size !== effective.length) {
      routeIssues.push({ route_key: key, reason: 'invalid-chain-length-or-duplicates' });
      continue;
    }
    const unavailable = effective.filter((label) => !enabledByLabel.has(label));
    if (unavailable.length) {
      routeIssues.push({
        route_key: key,
        reason: 'unavailable-model',
        unavailable_labels: unavailable.filter((label) => /^[A-Za-z0-9._:/@+-]{1,128}$/.test(label) && !looksSecretLike(label)),
      });
      continue;
    }
    const invariant = routeInvariantIssue(effective, enabledByLabel);
    if (invariant) routeIssues.push({ route_key: key, ...invariant });
  }
  if (routeIssues.length) throw new ControllerFault(400, 'invalid_route', { invalid_routes: routeIssues });

  const quality: Record<string, string | boolean> = {};
  exactKeys(input.quality, ['truthLevel', 'factCheck', 'builtInWebSearch', 'audit', 'ground', 'research', 'review', 'debate']);
  for (const [key, value] of Object.entries(input.quality)) {
    if (key === 'truthLevel') {
      if (!['strict', 'balanced', 'creative'].includes(String(value))) fault(400, 'invalid_config');
    } else if (key === 'factCheck') {
      if (!['off', 'auto', 'always'].includes(String(value))) fault(400, 'invalid_config');
    } else if (typeof value !== 'boolean') fault(400, 'invalid_config');
    quality[key] = value as string | boolean;
  }

  const limits: Record<string, Record<string, number>> = {};
  for (const [provider, rawLimits] of Object.entries(input.limits)) {
    if (!providerIds.includes(provider as ProviderId) || !isObject(rawLimits)) fault(400, 'invalid_config');
    exactKeys(rawLimits, ['daily_tokens', 'daily_requests']);
    const row: Record<string, number> = {};
    for (const [key, value] of Object.entries(rawLimits)) row[key] = integer(value, 0, 1_000_000_000_000, 'invalid_config');
    limits[provider] = row;
  }
  return { schema_version: 1, ...(input.revision === undefined ? {} : { revision: input.revision as number }), ...(input.issued_at === undefined ? {} : { issued_at: input.issued_at as string }), ...(input.rollback_of === undefined ? {} : { rollback_of: input.rollback_of as number }), providers, models, routes, quality, limits };
}

function dateOnly(value: unknown, code: string): string {
  const day = boundedString(value, 10, code);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fault(400, code);
  try {
    if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) fault(400, code);
  } catch { fault(400, code); }
  return day;
}

function countMap(value: unknown, code: string, allowed?: Set<string>): Record<string, number> {
  if (!isObject(value)) fault(400, code);
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(value)) {
    if (allowed && !allowed.has(key)) continue;
    if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(key)) continue;
    result[key] = integer(item, 0, 1_000_000_000_000, code);
  }
  return result;
}

function boundedFraction(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fault(400, code);
  return value;
}

export type CleanReport = Record<string, unknown> & { day_utc: string };

export function sanitizeReport(input: unknown): CleanReport {
  const code = 'invalid_report';
  if (!isObject(input)) fault(400, code);
  const day = dateOnly(input.day_utc, code);
  const nowDay = new Date().toISOString().slice(0, 10);
  const minDay = new Date(Date.parse(`${nowDay}T00:00:00Z`) - 13 * 86_400_000).toISOString().slice(0, 10);
  if (day < minDay || day > nowDay) fault(400, code);
  if (!isObject(input.totals) || !Array.isArray(input.providers) || input.providers.length > providerIds.length || !isObject(input.features) || !Array.isArray(input.days) || input.days.length > 14 || !isObject(input.truth) || !isObject(input.standard)) fault(400, code);
  const totals = {
    req: integer(input.totals.req, 0, 1_000_000_000_000, code),
    tok: integer(input.totals.tok, 0, 1_000_000_000_000, code),
  };
  const seenProviders = new Set<string>();
  const providers = input.providers.map((rawProvider) => {
    if (!isObject(rawProvider) || typeof rawProvider.id !== 'string' || !providerIds.includes(rawProvider.id as ProviderId) || seenProviders.has(rawProvider.id)) fault(400, code);
    const id = rawProvider.id as ProviderId;
    seenProviders.add(id);
    if (!Array.isArray(rawProvider.keys) || rawProvider.keys.length > 60) fault(400, code);
    const keysComplete = rawProvider.keys_complete === undefined ? undefined : bool(rawProvider.keys_complete, code);
    if (keysComplete && (input.sampled_at === undefined || rawProvider.keys.some((key) => !isObject(key) || typeof key.active !== 'boolean'))) fault(400, code);
    const seenIdentities = new Set<string>();
    const activeSlots = new Set<number>();
    const keys = rawProvider.keys.map((rawKey) => {
      if (!isObject(rawKey)) fault(400, code);
      const slot = integer(rawKey.slot, 1, 3, code);
      let generation: string | undefined;
      if (rawKey.generation !== undefined) {
        if (typeof rawKey.generation !== 'string' || !/^[0-9a-f]{32}$/.test(rawKey.generation)) fault(400, code);
        generation = rawKey.generation;
      }
      const identity = `${slot}:${generation ?? 'legacy'}`;
      if (seenIdentities.has(identity) || !['nokey', 'cool', 'out', 'low', 'ok'].includes(String(rawKey.state))) fault(400, code);
      seenIdentities.add(identity);
      const active = rawKey.active === undefined ? undefined : bool(rawKey.active, code);
      if (active !== false) {
        if (activeSlots.has(slot)) fault(400, code);
        activeSlots.add(slot);
      }
      let trackedSince: string | undefined;
      if (rawKey.tracked_since_day !== undefined) {
        trackedSince = dateOnly(rawKey.tracked_since_day, code);
        if (trackedSince > day || !generation) fault(400, code);
      }
      if (!Array.isArray(rawKey.models) || rawKey.models.length > 100) fault(400, code);
      const seenModels = new Set<string>();
      const models = rawKey.models.map((rawModel) => {
        if (!isObject(rawModel)) fault(400, code);
        const model = boundedString(rawModel.model, 200, code);
        if (looksSecretLike(model)) fault(400, code);
        if (seenModels.has(model)) fault(400, code);
        seenModels.add(model);
        const label = boundedString(rawModel.label, 100, code, true);
        if (looksSecretLike(label)) fault(400, code);
        return {
          model, label,
          req: integer(rawModel.req, 0, 1_000_000_000_000, code),
          tok: integer(rawModel.tok, 0, 1_000_000_000_000, code),
          req_limit: integer(rawModel.req_limit, 0, 1_000_000_000_000, code),
          tok_limit: integer(rawModel.tok_limit, 0, 1_000_000_000_000, code),
          frac: boundedFraction(rawModel.frac, code),
          out_s: integer(rawModel.out_s, 0, 86_400, code),
          cool_s: integer(rawModel.cool_s, 0, 86_400, code),
          rpm: integer(rawModel.rpm, 0, 1_000_000_000_000, code),
          tpm: integer(rawModel.tpm, 0, 1_000_000_000_000, code),
          min_req: integer(rawModel.min_req, 0, 1_000_000_000_000, code),
          min_tok: integer(rawModel.min_tok, 0, 1_000_000_000_000, code),
        };
      });
      return {
        slot, set: bool(rawKey.set, code), state: rawKey.state as string,
        ...(generation ? { generation } : {}),
        ...(active === undefined ? {} : { active }),
        ...(trackedSince ? { tracked_since_day: trackedSince } : {}),
        cool_s: integer(rawKey.cool_s, 0, 86_400, code),
        req: integer(rawKey.req, 0, 1_000_000_000_000, code),
        tok: integer(rawKey.tok, 0, 1_000_000_000_000, code), models,
      };
    });
    return {
      id, name: providerNames[id],
      set: integer(rawProvider.set, 0, 3, code),
      req: integer(rawProvider.req, 0, 1_000_000_000_000, code),
      tok: integer(rawProvider.tok, 0, 1_000_000_000_000, code), keys,
      ...(keysComplete === undefined ? {} : { keys_complete: keysComplete }),
    };
  });
  const seenDays = new Set<string>();
  const days = input.days.map((rawDay) => {
    if (!isObject(rawDay)) fault(400, code);
    const date = dateOnly(rawDay.day, code);
    if (seenDays.has(date) || date < minDay || date > nowDay) fault(400, code);
    seenDays.add(date);
    const by = countMap(rawDay.by, code, new Set<string>(providerIds));
    return { day: date, req: integer(rawDay.req, 0, 1_000_000_000_000, code), tok: integer(rawDay.tok, 0, 1_000_000_000_000, code), by };
  });
  const truth = {
    answers: integer(input.truth.answers, 0, 1_000_000_000_000, code),
    ok: integer(input.truth.ok, 0, 1_000_000_000_000, code),
    shak: integer(input.truth.shak, 0, 1_000_000_000_000, code),
    galat: integer(input.truth.galat, 0, 1_000_000_000_000, code),
  };
  if (!['nokey', 'low', 'tight', 'ok', 'unknown'].includes(String(input.standard.state))) fault(400, code);
  const standard = { state: input.standard.state, left: boundedFraction(input.standard.left, code) };
  const features = countMap(input.features, code, knownFeatures);
  const margin = boundedFraction(input.margin, code);
  const reserve = boundedFraction(input.reserve, code);
  const reset_in_s = integer(input.reset_in_s, 0, 86_400, code);
  const sampled_at = input.sampled_at === undefined ? undefined : integer(input.sampled_at, 0, 8_640_000_000_000_000, code);
  return { day_utc: day, totals, providers, features, days, truth, standard, margin, reserve, reset_in_s,
    ...(sampled_at === undefined ? {} : { sampled_at }) };
}

export function sanitizeReports(input: unknown): CleanReport[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 14) fault(400, 'invalid_report');
  const reports = input.map(sanitizeReport);
  if (new Set(reports.map((item) => item.day_utc)).size !== reports.length) fault(400, 'invalid_report');
  return reports;
}

export function validateName(value: unknown): string {
  const name = boundedString(value, 60, 'invalid_request');
  if (name.trim() !== name || looksSecretLike(name)) fault(400, 'invalid_request');
  return name;
}

export function validateAppVersion(value: unknown): string {
  const version = boundedString(value, 80, 'invalid_request', true);
  if (looksSecretLike(version)) fault(400, 'invalid_request');
  return version;
}

export function validateReason(value: unknown): string {
  const reason = boundedString(value, 300, 'invalid_request');
  if (reason.trim() !== reason || /(?:api[_ -]?key|secret|token)\s*[:=]/i.test(reason) || looksSecretLike(reason)) fault(400, 'invalid_request');
  return reason;
}

export async function readJsonBody(request: Request, maxBytes = 262_144): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(contentType)) fault(400, 'invalid_request');
  const length = request.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) fault(413, 'body_too_large');
  if (!request.body) fault(400, 'invalid_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        fault(413, 'body_too_large');
      }
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch {
      fault(400, 'invalid_request');
    }
  } finally {
    reader.releaseLock();
  }
}

export function secureRandomBase64Url(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function jsonResponse(body: unknown, status: number, cors: HeadersInit = {}): Response {
  const headers = new Headers(cors);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  headers.set('Pragma', 'no-cache');
  headers.set('Expires', '0');
  return new Response(JSON.stringify(body), { status, headers });
}

export function safeFaultResponse(error: unknown, cors: HeadersInit = {}): Response {
  if (error instanceof ControllerFault) {
    const messages: Record<string, string> = {
      unauthorized: 'Authentication required.', not_allowed: 'Administrator access required.',
      invalid_request: 'Invalid request.', invalid_config: 'Configuration validation failed.',
      invalid_route: 'Route validation failed.', invalid_report: 'Usage report validation failed.',
      revision_conflict: 'Configuration revision conflict.', not_found: 'Resource not found.',
      body_too_large: 'Request is too large.', unavailable: 'Controller temporarily unavailable.',
      rate_limited: 'Pairing code limit reached. Thoda wait karke dobara try karo.',
    };
    return jsonResponse({ ok: false, error: { code: error.code, message: messages[error.code] ?? 'Request could not be completed.', ...(error.details ? { details: error.details } : {}) } }, error.status, cors);
  }
  return jsonResponse({ ok: false, error: { code: 'unavailable', message: 'Controller temporarily unavailable.' } }, 500, cors);
}
