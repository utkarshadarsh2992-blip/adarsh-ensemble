import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CREDENTIAL_SLOTS,
  DEFAULT_NEWS_RESET_TIME,
  credentialDeletePayload,
  credentialInputError,
  credentialSetPayload,
  firebaseFieldsError,
  groupSlotsByProvider,
  isHHMM,
  parseOpenProviders,
  parseCredentialsState,
  parseGoogleServicesJson,
  setupUrlError,
} from "./credentials";

const answerTavily = CREDENTIAL_SLOTS.find(
  (slot) => slot.scope === "app" && slot.provider === "tavily",
)!;
const newsTavily = CREDENTIAL_SLOTS.find(
  (slot) =>
    slot.scope === "news" && slot.provider === "tavily" && slot.slot === 1,
)!;
const cloudflare = CREDENTIAL_SLOTS.find(
  (slot) =>
    slot.scope === "app" && slot.provider === "cloudflare" && slot.slot === 1,
)!;

test("slot catalog distinguishes Answer/research Tavily from News Tavily scopes", () => {
  assert.equal(answerTavily.label, "Answer / research Tavily");
  assert.equal(answerTavily.scope, "app");
  assert.equal(answerTavily.slot, 1);
  assert.equal(newsTavily.label, "News Tavily · slot 1");
  assert.equal(newsTavily.scope, "news");
  assert.equal(
    CREDENTIAL_SLOTS.filter((s) => s.scope === "app" && s.provider !== "tavily")
      .length,
    15,
  );
  assert.equal(
    CREDENTIAL_SLOTS.filter(
      (s) => s.scope === "news" && s.provider === "tavily",
    ).length,
    2,
  );
});

test("Tavily set/delete requests preserve their independent app and News scopes", () => {
  assert.deepEqual(credentialSetPayload(answerTavily, "temporary-answer-key"), {
    action: "credentials_set",
    scope: "app",
    provider: "tavily",
    slot: 1,
    key: "temporary-answer-key",
  });
  assert.deepEqual(credentialSetPayload(newsTavily, "temporary-news-key"), {
    action: "credentials_set",
    scope: "news",
    provider: "tavily",
    slot: 1,
    key: "temporary-news-key",
  });
  assert.deepEqual(credentialDeletePayload(answerTavily), {
    action: "credentials_delete",
    scope: "app",
    provider: "tavily",
    slot: 1,
  });
  assert.deepEqual(credentialDeletePayload(newsTavily), {
    action: "credentials_delete",
    scope: "news",
    provider: "tavily",
    slot: 1,
  });
});

test("normal slots require a non-blank key, and scope is part of the slot identity", () => {
  assert.equal(
    credentialInputError(answerTavily, "temporary-test-value", ""),
    null,
  );
  assert.match(
    credentialInputError(answerTavily, "   ", "") ?? "",
    /zaroori|required/i,
  );
  assert.notEqual(answerTavily.scope, newsTavily.scope);
});

test("Cloudflare Account ID may be updated without a key, but must be 32 hex chars", () => {
  assert.equal(
    credentialInputError(cloudflare, "", "0123456789abcdef0123456789abcdef"),
    null,
  );
  assert.ok(credentialInputError(cloudflare, "", "not-an-account-id"));
  assert.ok(credentialInputError(cloudflare, "", ""));
});

test("reset time accepts strict 24-hour HH:MM and defaults to 05:00", () => {
  assert.equal(DEFAULT_NEWS_RESET_TIME, "05:00");
  assert.equal(isHHMM("00:00"), true);
  assert.equal(isHHMM("23:59"), true);
  for (const value of ["5:00", "24:00", "12:60", "05:00:00", "", "2500"])
    assert.equal(isHHMM(value), false, value);
});

function metadataState() {
  return {
    ok: true,
    slots: [
      ...CREDENTIAL_SLOTS.map(({ scope, provider, slot }) => ({
        scope,
        provider,
        slot,
        key_set: scope === "app" && provider === "tavily",
        ...(provider === "cloudflare" ? { account_id_set: false } : {}),
        generation:
          scope === "app" && provider === "tavily" ? "answer-gen" : null,
        updated_at: null,
      })),
      {
        scope: "setup",
        provider: "firebase",
        slot: 1,
        key_set: true,
        generation: "gen-c",
        updated_at: null,
      },
      {
        scope: "setup",
        provider: "news",
        slot: 1,
        key_set: true,
        generation: "news-gen",
        updated_at: null,
      },
    ],
    reset_time: "05:00",
    timezone: "Asia/Kolkata",
    device_settings: {
      briefingOn: false,
      briefingTime: "08:00",
      newsBriefing: true,
      briefingTelegram: false,
    },
    setup_status: { news: true, firebase: false },
  };
}

test("credentials state accepts metadata and strips unknown fields by rejecting secret-bearing payloads", () => {
  const parsed = parseCredentialsState(metadataState());
  assert.ok(parsed);
  assert.equal(
    parsed?.slots.find(
      (slot) => slot.scope === "app" && slot.provider === "tavily",
    )?.generation,
    "answer-gen",
  );
  assert.equal(
    parsed?.slots.find(
      (slot) => slot.scope === "news" && slot.provider === "tavily",
    )?.key_set,
    false,
  );
  assert.equal(
    parseCredentialsState({ ...metadataState(), key: "must-not-be-returned" }),
    null,
  );
  const leakedSlot = {
    ...metadataState().slots[0],
    value: "must-not-be-returned",
  };
  assert.equal(
    parseCredentialsState({ ...metadataState(), slots: [leakedSlot] }),
    null,
  );
});

test("metadata time, timezone, and provider/scope combinations are validated", () => {
  assert.equal(
    parseCredentialsState({ ...metadataState(), reset_time: "24:00" }),
    null,
  );
  assert.equal(
    parseCredentialsState({ ...metadataState(), timezone: "UTC" }),
    null,
  );
  const wrongScope = { ...metadataState().slots[0], scope: "news", slot: 3 };
  assert.equal(
    parseCredentialsState({ ...metadataState(), slots: [wrongScope] }),
    null,
  );
});

test("News setup URL must be HTTPS and Firebase fields are non-empty bounded strings", () => {
  assert.equal(setupUrlError("https://news.example/api"), null);
  assert.ok(setupUrlError("http://news.example/api"));
  assert.ok(setupUrlError("https://user:pass@news.example/api"));
  assert.ok(
    firebaseFieldsError({
      apiKey: "a",
      appId: "b",
      projectId: "c",
      senderId: "d",
    }) === null,
  );
  assert.ok(
    firebaseFieldsError({
      apiKey: "",
      appId: "b",
      projectId: "c",
      senderId: "d",
    }),
  );
});

test("google-services parsing extracts only supported Firebase fields from local JSON", () => {
  const parsed = parseGoogleServicesJson(
    JSON.stringify({
      project_info: { project_number: "123456789", project_id: "adarsh-app" },
      client: [
        {
          client_info: { mobilesdk_app_id: "1:123456789:android:abc" },
          api_key: [{ current_key: "temporary-firebase-key" }],
          services: { analytics_service: { arbitrary: "ignored" } },
        },
      ],
      extra_private_field: "ignored",
    }),
  );
  assert.deepEqual(parsed, {
    apiKey: "temporary-firebase-key",
    appId: "1:123456789:android:abc",
    projectId: "adarsh-app",
    senderId: "123456789",
  });
  assert.equal(parseGoogleServicesJson("not-json"), null);
  assert.equal(
    parseGoogleServicesJson(JSON.stringify({ project_info: {}, client: [] })),
    null,
  );
});

test("provider cards hold all three App slots together in slot order", () => {
  const groups = groupSlotsByProvider(
    CREDENTIAL_SLOTS.filter((slot) => slot.group === "App providers"),
  );
  assert.deepEqual(
    groups.map((group) => group.key),
    [
      "app:groq",
      "app:openrouter",
      "app:gemini",
      "app:nvidia",
      "app:cloudflare",
    ],
  );
  for (const group of groups) {
    assert.deepEqual(
      group.definitions.map((slot) => slot.slot),
      [1, 2, 3],
    );
  }
  assert.equal(groups[0].name, "Groq");
  assert.equal(groups[4].name, "Cloudflare Workers AI");
  const news = groupSlotsByProvider(
    CREDENTIAL_SLOTS.filter((slot) => slot.scope === "news"),
  );
  assert.deepEqual(
    news.map((group) => [group.key, group.definitions.length]),
    [
      ["news:groq", 2],
      ["news:tavily", 2],
    ],
  );
});

test("remembered open provider list keeps only known provider keys", () => {
  assert.deepEqual(parseOpenProviders(null), []);
  assert.deepEqual(parseOpenProviders("not json"), []);
  assert.deepEqual(parseOpenProviders('{"a":1}'), []);
  assert.deepEqual(
    parseOpenProviders('["app:groq","app:groq","news:tavily","app:evil",7]'),
    ["app:groq", "news:tavily"],
  );
});
