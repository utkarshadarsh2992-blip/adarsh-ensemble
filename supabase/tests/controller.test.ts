import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUNDLED_ROUTE_CHAINS, DEFAULT_MODELS, DEFAULT_PROVIDERS,
  sanitizeReport, secureRandomBase64Url, sha256Hex, validateConfig,
} from '../functions/_shared/controller.ts';

function validConfig() {
  return {
    schema_version: 1,
    providers: structuredClone(DEFAULT_PROVIDERS),
    models: structuredClone(DEFAULT_MODELS),
    routes: {},
    quality: {},
    limits: {},
  };
}

function validReport() {
  return {
    day_utc: new Date().toISOString().slice(0, 10),
    totals: { req: 3, tok: 120 },
    providers: [{
      id: 'groq', name: 'Groq', set: 1, req: 3, tok: 120, limits: 'discarded',
      keys: [{ slot: 1, set: true, state: 'ok', cool_s: 0, req: 3, tok: 120, models: [{
        model: 'openai/gpt-oss-120b', label: 'gpt-oss-120b', req: 3, tok: 120,
        req_limit: 100, tok_limit: 1000, frac: 0.12, out_s: 0, cool_s: 0,
        rpm: 30, tpm: 8000, min_req: 1, min_tok: 50, prompt: 'do not keep me',
      }] }],
    }],
    features: { standard: 2, unknown_feature: 800 },
    days: [{ day: new Date().toISOString().slice(0, 10), req: 3, tok: 120, by: { groq: 3, unsupported: 100 } }],
    truth: { answers: 1, ok: 1, shak: 0, galat: 0 },
    standard: { state: 'ok', left: 0.8 },
    margin: 0.95,
    reserve: 0.8,
    reset_in_s: 100,
    prompt: 'never persist arbitrary extra fields',
  };
}

test('bundled seed and all bundled route defaults validate', () => {
  const config = validConfig();
  const result = validateConfig(config);
  assert.equal(result.schema_version, 1);
  assert.equal(result.models.length, 29);
  assert.equal(Object.keys(result.providers).length, 5);
  assert.deepEqual(result.routes, {});
  assert.deepEqual(result.quality, {});
  assert.deepEqual(result.limits, {});
  assert.equal(Object.keys(BUNDLED_ROUTE_CHAINS).length, 100);
  assert.equal('standard:single' in BUNDLED_ROUTE_CHAINS, false);
});

test('accepts valid partial overrides and only the permitted extra fields', () => {
  const config = validConfig();
  config.routes = {
    'mode:standard:theorist': ['gpt-oss-20b', 'gemini-3.5-flash-lite', 'nemotron-lightning'],
    'mode:verified:architect': ['gemma-4-31b-g', 'gpt-oss-120b', 'nemotron-super-vl', 'gemini-3.1-flash-lite'],
  };
  config.quality = { truthLevel: 'strict', factCheck: 'auto', builtInWebSearch: true, audit: false };
  config.limits = { groq: { daily_tokens: 200000, daily_requests: 1000 } };
  assert.equal(validateConfig(config).routes['mode:standard:theorist'].length, 3);
  const bad = validConfig();
  (bad.models[0].extra as Record<string, unknown>).tools = [];
  assert.throws(() => validateConfig(bad));
});

test('rejects unknown provider hosts, insecure URLs, URL credentials, ports, queries, hashes, traversal, and chat endpoints', () => {
  const invalid = [
    'http://api.groq.com/openai/v1',
    'https://evil.example/openai/v1',
    'https://user@api.groq.com/openai/v1',
    'https://api.groq.com:443/openai/v1',
    'https://api.groq.com/openai/v1?key=x',
    'https://api.groq.com/openai/v1#hash',
    'https://api.groq.com/a/../openai/v1',
    'https://api.groq.com/a/%2e%2e/openai/v1',
    'https://api.groq.com/openai/v1/chat/completions',
  ];
  for (const base_url of invalid) {
    const config = validConfig();
    config.providers.groq.base_url = base_url;
    assert.throws(() => validateConfig(config), `expected rejection: ${base_url}`);
  }
  const cloudflare = validConfig();
  cloudflare.providers.cloudflare.base_url = 'https://api.cloudflare.com/client/v4/accounts/123456/ai/v1';
  assert.throws(() => validateConfig(cloudflare));
});

test('all Standard and nonstandard role routes require core providers and a different-provider first fallback', () => {
  const standard = validConfig();
  standard.routes = { 'mode:standard:architect': ['gemini-3.8-flash', 'gpt-oss-120b'] };
  assert.throws(() => validateConfig(standard));
  const missingCore = validConfig();
  missingCore.routes = { 'mode:math:judge': ['gpt-oss-120b', 'qwen3.8-27b', 'nemotron-ultra'] };
  assert.throws(() => validateConfig(missingCore));
  const sameProviderFirstFallback = validConfig();
  sameProviderFirstFallback.routes = { 'utility:quick': ['gpt-oss-120b', 'gpt-oss-20b', 'nemotron-ultra', 'gemini-3.8-flash'] };
  assert.throws(() => validateConfig(sameProviderFirstFallback));
  const duplicate = validConfig();
  duplicate.routes = { 'utility:quick': ['gpt-oss-120b', 'gpt-oss-120b', 'nemotron-ultra', 'gemini-3.8-flash'] };
  assert.throws(() => validateConfig(duplicate));
});

test('unused disabled models are permitted, but removed bundled references fail with actionable route labels', () => {
  const config = validConfig();
  config.models = config.models.map((model) => model.label === 'nemotron-nano-omni' ? { ...model, enabled: false } : model);
  assert.doesNotThrow(() => validateConfig(config));
  config.models = config.models.filter((model) => model.label !== 'nemotron-ultra');
  assert.throws(() => validateConfig(config), (error: any) => {
    const routes = error?.details?.invalid_routes as Array<Record<string, unknown>> | undefined;
    return Array.isArray(routes) && routes.some((route) => route.reason === 'unavailable-model' &&
      (route.unavailable_labels as string[] | undefined)?.includes('nemotron-ultra'));
  });
});

test('report sanitizer emits only whitelisted aggregate fields and known provider/features', () => {
  const clean = sanitizeReport(validReport());
  assert.equal(clean.day_utc, new Date().toISOString().slice(0, 10));
  assert.equal('prompt' in clean, false);
  const providers = clean.providers as Array<Record<string, unknown>>;
  assert.equal(providers[0].name, 'Groq');
  assert.equal('limits' in providers[0], false);
  const keys = providers[0].keys as Array<Record<string, unknown>>;
  const models = keys[0].models as Array<Record<string, unknown>>;
  assert.equal('prompt' in models[0], false);
  assert.deepEqual(clean.features, { standard: 2 });
  const days = clean.days as Array<Record<string, unknown>>;
  assert.deepEqual(days[0].by, { groq: 3 });
});

test('report rejects invalid dates, unbounded counters, invalid providers and excessive history', () => {
  const invalidDate = validReport();
  invalidDate.day_utc = '2026-99-99';
  assert.throws(() => sanitizeReport(invalidDate));
  const tooLarge = validReport();
  tooLarge.totals.req = 1_000_000_000_001;
  assert.throws(() => sanitizeReport(tooLarge));
  const unknownProvider = validReport();
  (unknownProvider.providers[0] as Record<string, unknown>).id = 'arbitrary';
  assert.throws(() => sanitizeReport(unknownProvider));
});

test('random pairing code/token sizes are URL-safe and token has 256 bits; SHA-256 is hex', async () => {
  const code = secureRandomBase64Url(24);
  const token = secureRandomBase64Url(32);
  assert.equal(code.length, 32);
  assert.equal(token.length, 43);
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.match(await sha256Hex(token), /^[0-9a-f]{64}$/);
});

test('Cloudflare requires the same local account path as the native adapter', () => {
  for (const base_url of [
    'https://api.cloudflare.com/wrong/{CLOUDFLARE_ACCOUNT_ID}/ai/v1',
    'https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_ACCOUNT_ID}/ai/v1',
  ]) {
    const config = validConfig();
    config.providers.cloudflare.base_url = base_url;
    assert.throws(() => validateConfig(config));
  }
  const config = validConfig();
  config.providers.groq.base_url = 'https://API.GROQ.COM/openai/v1';
  assert.doesNotThrow(() => validateConfig(config));
});

test('historical unavailable Standard quota is honest unknown, not a fake live balance', () => {
  const report = validReport();
  report.standard = { state: 'unknown', left: 0 };
  assert.deepEqual(sanitizeReport(report).standard, { state: 'unknown', left: 0 });
});
