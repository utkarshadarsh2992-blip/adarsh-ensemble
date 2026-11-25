import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregate,
  endpointError,
  modelError,
  routeError,
  type Config,
  type State,
} from "./domain";
const base: Config = {
  schema_version: 1,
  providers: {
    groq: { base_url: "https://api.groq.com/openai/v1" },
    openrouter: { base_url: "https://openrouter.ai/api/v1" },
    gemini: {
      base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    },
    nvidia: { base_url: "https://integrate.api.nvidia.com/v1" },
    cloudflare: {
      base_url:
        "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    },
  },
  models: [
    {
      label: "g",
      provider: "groq",
      model: "openai/model",
      enabled: true,
      extra: {},
    },
    {
      label: "o",
      provider: "openrouter",
      model: "vendor/model:free",
      enabled: true,
      extra: {},
    },
    {
      label: "m",
      provider: "gemini",
      model: "gemini-flash",
      enabled: true,
      extra: {},
    },
  ],
  routes: {},
  quality: {},
  limits: {},
};
test("endpoint validator permits fixed provider HTTPS hosts and Cloudflare account placeholder only", () => {
  assert.equal(endpointError("groq", base.providers.groq.base_url), null);
  assert.equal(
    endpointError("cloudflare", base.providers.cloudflare.base_url),
    null,
  );
});
test("endpoint validator rejects host/protocol/userinfo/port/query/hash/path traversal and wrong endpoint shape", () => {
  for (const url of [
    "http://api.groq.com/openai/v1",
    "https://evil.example/openai/v1",
    "https://user@api.groq.com/openai/v1",
    "https://api.groq.com:443/openai/v1",
    "https://api.groq.com/openai/v1?x=1",
    "https://api.groq.com/openai/v1#fragment",
    "https://api.groq.com/openai/../secret",
    "https://api.groq.com/openai/v1/chat/completions",
  ])
    assert.ok(endpointError("groq", url), url);
  assert.ok(
    endpointError(
      "cloudflare",
      "https://api.cloudflare.com/client/v4/accounts/123/ai/v1",
    ),
  );
});
test("model ID/label rules reject invalid user input", () => {
  assert.equal(modelError(base.models[0]), null);
  assert.ok(modelError({ ...base.models[0], label: "bad label" }));
  assert.ok(modelError({ ...base.models[0], model: "bad id with spaces" }));
  assert.ok(modelError({ ...base.models[0], model: "x".repeat(201) }));
});
test("every role route, including Standard, keeps all core providers and a cross-provider first fallback", () => {
  assert.equal(
    routeError("mode:standard:architect", ["g", "o", "m"], base),
    null,
  );
  assert.ok(routeError("mode:standard:architect", ["g", "g", "m"], base));
  assert.ok(routeError("mode:standard:architect", ["g", "o"], base));
  assert.ok(routeError("mode:standard:architect", ["g", "o", "missing"], base));
});
test("route length, uniqueness and enabled state are mandatory", () => {
  assert.ok(routeError("mode:math:judge", [], base));
  assert.ok(routeError("mode:math:judge", ["g", "g", "o"], base));
  assert.ok(
    routeError(
      "mode:math:judge",
      ["g", "o", "m", "g", "o", "m", "g", "o", "m", "g", "o"],
      base,
    ),
  );
  assert.ok(
    routeError(
      "mode:math:judge",
      ["g", "o", "m", { ...base.models[2], enabled: false }.label],
      base,
    ),
  );
});
test("dashboard aggregates only the selected UTC day across devices without losing provider splits", () => {
  const mk = (
    device_id: string,
    day_utc: string,
    tok: number,
  ): State["usage"][number] => ({
    device_id,
    day_utc,
    updated_at: "2026-11-25T00:00:00Z",
    report: {
      day_utc,
      totals: { req: 3, tok },
      providers: [{ id: "groq", name: "Groq", req: 2, tok, set: 1 }],
      days: [],
    },
  });
  const s: State = {
    ok: true,
    revision: 1,
    config: base,
    devices: [],
    history: [],
    usage: [
      mk("d1", "2026-11-25", 100),
      mk("d2", "2026-11-25", 50),
      mk("d1", "2026-11-24", 900),
    ],
  };
  const a = aggregate(s, "2026-11-25");
  assert.equal(a.reports.length, 2);
  assert.equal(a.req, 6);
  assert.equal(a.tok, 150);
  assert.equal(a.providers.find((p) => p.id === "groq")?.tok, 150);
});

test("endpoint rules align with device Cloudflare path and hostname casing", () => {
  assert.ok(
    endpointError(
      "cloudflare",
      "https://api.cloudflare.com/wrong/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    ),
  );
  assert.ok(
    endpointError(
      "cloudflare",
      "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    ),
  );
  assert.equal(endpointError("groq", "https://API.GROQ.COM/openai/v1"), null);
});
