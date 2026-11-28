import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregate,
  endpointError,
  modelError,
  routeError,
  detachModelFromRoutes,
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

test("display-only daily limits allow zero as an unknown/unset estimate", () => {
  const limits = { daily_tokens: 0, daily_requests: 0 };
  assert.equal(limits.daily_tokens, 0);
  assert.equal(limits.daily_requests, 0);
});

test("detachModelFromRoutes removes a model from every route and keeps chains valid", () => {
  const cfg: Config = {
    ...base,
    models: [
      { label: "g", provider: "groq", model: "a/g", enabled: true, extra: {} },
      { label: "g2", provider: "groq", model: "a/g2", enabled: true, extra: {} },
      { label: "o", provider: "openrouter", model: "a/o", enabled: true, extra: {} },
      { label: "m", provider: "gemini", model: "a/m", enabled: true, extra: {} },
      { label: "x", provider: "nvidia", model: "a/x", enabled: true, extra: {} },
    ],
    routes: { "mode:math:judge": ["x", "g", "o", "m"] },
  };
  const defaults = { "utility:quick": ["g", "x", "o", "m"] };
  const r = detachModelFromRoutes(cfg, defaults, "g");
  assert.ok(r.ok);
  if (r.ok) {
    assert.deepEqual(r.changed.sort(), ["mode:math:judge", "utility:quick"]);
    assert.ok(r.routes["mode:math:judge"].includes("g2"));
    assert.ok(!r.routes["mode:math:judge"].includes("g"));
    assert.ok(!r.routes["utility:quick"].includes("g"));
    assert.equal(r.routes["utility:quick"][0], "g2".length ? r.routes["utility:quick"][0] : "");
  }
  const none = detachModelFromRoutes({ ...cfg, models: cfg.models.filter((m) => m.label !== "g2") }, defaults, "g");
  assert.equal(none.ok, false);
});

test("Standard model picker keeps Groq-only Standard chain and valid quick route", async () => {
  const { setStandardPrimary, standardChain, routeError } = await import("./domain");
  const m = (label: string, provider: string, enabled = true) => ({ label, provider, model: label, enabled, extra: {} });
  const config: any = {
    schema_version: 1, providers: {}, quality: {}, limits: {}, routes: {},
    models: [m("gpt-oss-120b", "groq"), m("gpt-oss-20b", "groq"), m("llama-x", "groq", false),
      m("gem", "gemini"), m("or", "openrouter")],
  };
  const bundled = { "utility:quick": ["gpt-oss-120b", "gem", "or", "gpt-oss-20b"] };
  assert.deepEqual(standardChain(config, bundled), ["gpt-oss-120b"]);
  const r = setStandardPrimary(config, "gpt-oss-20b", bundled);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.config.routes["utility:quick"], ["gpt-oss-20b", "gem", "or", "gpt-oss-120b"]);
  assert.equal(routeError("utility:quick", r.config.routes["utility:quick"], r.config), null);
  assert.deepEqual(standardChain(r.config, bundled), ["gpt-oss-20b", "gpt-oss-120b"]);
  assert.equal(setStandardPrimary(config, "gem", bundled).ok, false);
  assert.equal(setStandardPrimary(config, "llama-x", bundled).ok, false);
});
test("Standard other-provider toggle allows non-Groq primary and full chain", async () => {
  const { setStandardOtherProviders, setStandardPrimary, standardChain, routeError } = await import("./domain");
  const m = (label: string, provider: string) => ({ label, provider, model: label, enabled: true, extra: {} });
  const config: any = {
    schema_version: 1, providers: {}, quality: {}, limits: {}, routes: {},
    models: [m("gpt-oss-120b", "groq"), m("gem", "gemini"), m("or", "openrouter"), m("or2", "openrouter")],
  };
  const bundled = { "utility:quick": ["gpt-oss-120b", "gem", "or"] };
  assert.equal(setStandardPrimary(config, "or", bundled).ok, false);
  const on = setStandardOtherProviders(config, true, bundled);
  assert.ok(on.ok);
  if (!on.ok) return;
  assert.equal(on.config.quality.standardOtherProviders, true);
  assert.deepEqual(standardChain(on.config, bundled), ["gpt-oss-120b", "gem", "or"]);
  const p = setStandardPrimary(on.config, "or", bundled);
  assert.ok(p.ok);
  if (!p.ok) return;
  assert.equal(p.config.routes["utility:quick"][0], "or");
  assert.equal(routeError("utility:quick", p.config.routes["utility:quick"], p.config), null);
  const off = setStandardOtherProviders(p.config, false, bundled);
  assert.ok(off.ok);
  if (!off.ok) return;
  assert.equal("standardOtherProviders" in off.config.quality, false);
  assert.deepEqual(standardChain(off.config, bundled), ["gpt-oss-120b"]);
});
