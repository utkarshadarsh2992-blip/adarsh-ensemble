import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleControllerDevice } from "../functions/controller-device/index.ts";
import {
  DEFAULT_MODELS,
  DEFAULT_PROVIDERS,
  sha256Hex,
} from "../functions/_shared/controller.ts";
import { validateDeviceSettings } from "../functions/_shared/credentials.ts";
import {
  NEWS_LIMITS,
  validateNewsSettingsPatch,
} from "../functions/_shared/newsadmin.ts";

const token = "A".repeat(43);
const tokenHash = await sha256Hex(token);
const deviceId = "d45ce111-90a4-41d0-8000-245f35411001";
const config = {
  schema_version: 1,
  revision: 3,
  issued_at: "2026-11-28T00:00:00Z",
  providers: structuredClone(DEFAULT_PROVIDERS),
  models: structuredClone(DEFAULT_MODELS),
  routes: {},
  quality: { truthLevel: "balanced", audit: true },
  limits: { groq: { daily_tokens: 10000, daily_requests: 200 } },
};

function request(body: unknown, authorization?: string): Request {
  return new Request(
    "https://controller.example/functions/v1/controller-device",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

Deno.test("assistant schema and limit helpers reject unapproved fields and invalid ranges", () => {
  assertThrows(() => validateNewsSettingsPatch({ alerts_per_day: 11 }));
  assertThrows(() => validateNewsSettingsPatch({ groq_tokens_cap: 999 }));
  assertThrows(() => validateNewsSettingsPatch({ tz: "UTC" }));
  assertThrows(() => validateNewsSettingsPatch({ alerts_per_day: 2.5 }));
  assertEquals(
    validateNewsSettingsPatch({ alerts_per_day: 0, tavily_day_cap: 1000 }),
    {
      alerts_per_day: 0,
      tavily_day_cap: 1000,
    },
  );
  assertEquals(NEWS_LIMITS.groq_calls_cap.max, 100_000);
  assertThrows(() =>
    validateDeviceSettings({
      action: "device_settings_set",
      settings: { briefingOn: true, setup: "bad" },
    })
  );
  assertThrows(() =>
    validateDeviceSettings({
      action: "device_settings_set",
      settings: { briefingTime: "24:00" },
    })
  );
  assertThrows(() =>
    validateDeviceSettings({
      action: "device_settings_set",
      settings: { briefingTelegram: "true" },
    })
  );
});

Deno.test("assistant device actions authenticate, return a secret-free state, enforce revision CAS, and delegate audited writes", async () => {
  const oldUrl = Deno.env.get("SUPABASE_URL");
  const oldKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const oldOrigins = Deno.env.get("ALLOWED_ORIGINS");
  const originalFetch = globalThis.fetch;
  const seenRpc: Array<{ name: string; args: Record<string, unknown> }> = [];
  let deviceRevoked = false;
  let conflict = false;
  Deno.env.set("SUPABASE_URL", "https://unit-test.invalid");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "unit-test-service-role-key");
  Deno.env.set("ALLOWED_ORIGINS", "https://controller.example");

  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : input.url,
    );
    const method = init?.method ?? "GET";
    if (url.pathname.endsWith("/rest/v1/controller_devices")) {
      if (deviceRevoked) return Response.json([]);
      assertEquals(url.searchParams.get("token_hash"), `eq.${tokenHash}`);
      assertEquals(url.searchParams.get("revoked_at"), "is.null");
      return Response.json([{ id: deviceId }]);
    }
    if (url.pathname.endsWith("/rest/v1/controller_config_revisions")) {
      return Response.json([{ revision: 7, config }]);
    }
    if (
      url.pathname.endsWith("/rest/v1/rpc/controller_device_assistant_settings")
    ) {
      return Response.json({
        briefingOn: true,
        briefingTime: "21:30",
        newsBriefing: false,
        briefingTelegram: true,
      });
    }
    if (url.pathname.endsWith("/rest/v1/settings")) {
      return Response.json([
        { key: "digest_time", value: "21:30" },
        { key: "tz", value: "Asia/Kolkata" },
        { key: "alerts_per_day", value: 5 },
        { key: "alert_min_score", value: 8 },
        { key: "list_min_score", value: 5 },
        { key: "groq_tokens_cap", value: 150000 },
        { key: "groq_calls_cap", value: 400 },
        { key: "tavily_day_cap", value: 20 },
        { key: "tavily_month_cap", value: 700 },
        { key: "require_verify", value: true },
      ]);
    }
    if (
      url.pathname.endsWith("/rest/v1/ai_usage") ||
      url.pathname.endsWith("/rest/v1/alert_log")
    ) return Response.json([]);
    if (url.pathname.endsWith("/rest/v1/kv")) {
      return Response.json([{ value: 0 }]);
    }
    if (url.pathname.includes("/rest/v1/rpc/")) {
      const name = url.pathname.split("/").at(-1)!;
      const args = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      seenRpc.push({ name, args });
      if (name === "controller_device_save_config" && conflict) {
        return Response.json({
          code: "40001",
          message: "revision conflict",
          details: null,
          hint: null,
        }, { status: 409 });
      }
      if (name === "controller_device_save_config") return Response.json(8);
      if (name === "controller_device_news_settings_update") {
        return Response.json({ ok: true });
      }
      if (name === "controller_device_briefing_settings_update") {
        return Response.json({
          ok: true,
          revision: 14,
          device_settings: {
            briefingOn: false,
            briefingTime: "06:45",
            newsBriefing: false,
            briefingTelegram: true,
          },
        });
      }
      throw new Error(`Unexpected RPC ${name}`);
    }
    throw new Error(`Unexpected Supabase request ${method} ${url}`);
  };

  try {
    const noBearer = await handleControllerDevice(
      request({ action: "assistant_state" }),
    );
    assertEquals(noBearer.status, 401);
    const malformedBearer = await handleControllerDevice(
      request({ action: "assistant_state" }, "Bearer not-a-paired-token"),
    );
    assertEquals(malformedBearer.status, 401);

    const unknownField = await handleControllerDevice(
      request(
        { action: "assistant_state", include_credentials: true },
        `Bearer ${token}`,
      ),
    );
    assertEquals(unknownField.status, 400);
    const invalidKind = await handleControllerDevice(
      request({
        action: "assistant_update",
        kind: "credentials",
        values: {},
        reason: "No",
      }, `Bearer ${token}`),
    );
    assertEquals(invalidKind.status, 400);
    const extraTopLevel = await handleControllerDevice(request({
      action: "assistant_update",
      kind: "news_settings",
      values: { alerts_per_day: 5 },
      reason: "set cap",
      actor_id: "owner",
    }, `Bearer ${token}`));
    assertEquals(extraTopLevel.status, 400);

    deviceRevoked = true;
    const revoked = await handleControllerDevice(
      request({ action: "assistant_state" }, `Bearer ${token}`),
    );
    assertEquals(revoked.status, 401);
    deviceRevoked = false;

    const stateResponse = await handleControllerDevice(
      request({ action: "assistant_state" }, `Bearer ${token}`),
    );
    assertEquals(stateResponse.status, 200);
    const state = await stateResponse.json();
    assertEquals(Object.keys(state).sort(), [
      "config",
      "device_settings",
      "news",
      "ok",
      "revision",
    ]);
    assertEquals(state.revision, 7);
    assertEquals(state.config.providers, config.providers);
    assertEquals(state.config.quality, config.quality);
    assertEquals(state.config.limits, config.limits);
    assertEquals(state.device_settings, {
      briefingOn: true,
      briefingTime: "21:30",
      newsBriefing: false,
      briefingTelegram: true,
    });
    assertEquals(state.news.settings.alerts_per_day, 5);
    assertEquals(state.news.tz, "Asia/Kolkata");
    assertEquals("usage" in state.news, false);
    assertEquals("alerts" in state.news, false);
    assertEquals("setup" in state, false);
    assertEquals("credentials" in state, false);
    const serializedState = JSON.stringify(state);
    for (
      const secretLike of [
        "API_KEY",
        "device_token",
        "auth_session",
        "owner@example.com",
        "private-test-secret",
      ]
    ) {
      assertEquals(serializedState.includes(secretLike), false);
    }

    const configUpdate = await handleControllerDevice(request({
      action: "assistant_update",
      kind: "config",
      values: { models: config.models, routes: config.routes },
      expected_revision: 7,
      reason: "Update model registry",
    }, `Bearer ${token}`));
    assertEquals(configUpdate.status, 200);
    const configRpc = seenRpc.find((call) =>
      call.name === "controller_device_save_config"
    )!;
    assertEquals(configRpc.args.p_device_token_hash, tokenHash);
    assertEquals(configRpc.args.p_expected_revision, 7);
    const savedConfig = configRpc.args.p_config as Record<string, unknown>;
    assertEquals(savedConfig.providers, config.providers);
    assertEquals(savedConfig.quality, config.quality);
    assertEquals(savedConfig.limits, config.limits);
    assertEquals(savedConfig.issued_at, config.issued_at);
    assertEquals(configRpc.args.p_reason, "Update model registry");

    conflict = true;
    const conflictResponse = await handleControllerDevice(request({
      action: "assistant_update",
      kind: "config",
      values: { models: config.models, routes: config.routes },
      expected_revision: 7,
      reason: "Concurrent edit",
    }, `Bearer ${token}`));
    assertEquals(conflictResponse.status, 409);
    conflict = false;

    const newsUpdate = await handleControllerDevice(request({
      action: "assistant_update",
      kind: "news_settings",
      values: { alerts_per_day: 3, tavily_day_cap: 0 },
      reason: "Reduce News alerts",
    }, `Bearer ${token}`));
    assertEquals(newsUpdate.status, 200);
    const newsRpc = seenRpc.find((call) =>
      call.name === "controller_device_news_settings_update"
    )!;
    assertEquals(newsRpc.args.p_device_token_hash, tokenHash);
    assertEquals(newsRpc.args.p_settings, {
      alerts_per_day: 3,
      tavily_day_cap: 0,
    });
    assertEquals(newsRpc.args.p_reason, "Reduce News alerts");

    const briefingUpdate = await handleControllerDevice(request({
      action: "assistant_update",
      kind: "briefing_settings",
      values: { briefingOn: false, briefingTime: "06:45" },
      reason: "Change briefing schedule",
    }, `Bearer ${token}`));
    assertEquals(briefingUpdate.status, 200);
    const briefingRpc = seenRpc.find((call) =>
      call.name === "controller_device_briefing_settings_update"
    )!;
    assertEquals(briefingRpc.args.p_device_token_hash, tokenHash);
    assertEquals(briefingRpc.args.p_device_settings, {
      briefingOn: false,
      briefingTime: "06:45",
    });
    assertEquals(briefingRpc.args.p_reason, "Change briefing schedule");

    const migration = await Deno.readTextFile(
      new URL(
        "../migrations/20261128000000_controller_device_assistant_actions.sql",
        import.meta.url,
      ),
    );
    assertStringIncludes(
      migration,
      "insert into public.controller_audit_log(event, revision, actor_id, device_id, reason, metadata)",
    );
    assertStringIncludes(
      migration,
      "values('news_settings_saved', null, v_device, p_reason",
    );
    assertStringIncludes(
      migration,
      "values('briefing_settings_saved', null, v_device, p_reason",
    );
    assertStringIncludes(
      migration,
      "credential_revision = credential_revision + 1",
    );
    assertStringIncludes(
      migration,
      "grant execute on function public.controller_device_briefing_settings_update(text,jsonb,text) to service_role",
    );
    assertEquals(migration.includes("device_token text not null"), false);
    assert(migration.includes("'config_saved', v_next, null, v_device"));
  } finally {
    globalThis.fetch = originalFetch;
    if (oldUrl === undefined) Deno.env.delete("SUPABASE_URL");
    else Deno.env.set("SUPABASE_URL", oldUrl);
    if (oldKey === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", oldKey);
    if (oldOrigins === undefined) Deno.env.delete("ALLOWED_ORIGINS");
    else Deno.env.set("ALLOWED_ORIGINS", oldOrigins);
  }
});
