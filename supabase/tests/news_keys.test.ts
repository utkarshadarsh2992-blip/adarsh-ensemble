import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { MemoryStore } from "../functions/_shared/store.ts";
import { groq, tavily } from "../functions/_shared/providers.ts";
import { run as runScore } from "../functions/news-score/index.ts";
import {
  blockNewsKey,
  NEWS_KEY_RESET_TIME_KEY,
  nextNewsKeyReset,
} from "../functions/_shared/news-keys.ts";
import type { ProviderKey } from "../functions/_shared/types.ts";

const keyRows = (
  a = "secret-groq-one",
  b = "secret-groq-two",
  g1 = "g1",
  g2 = "g2",
): ProviderKey[] => [
  { slot: 1, key: a, generation: g1 },
  { slot: 2, key: b, generation: g2 },
];
const okGroq = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
const authSlot = (init?: RequestInit) =>
  new Headers(init?.headers).get("authorization") || "";

Deno.test("Groq 429 and 402 immediately fail over, persist slot-1 block across invocations, and charge only successful calls", async () => {
  for (const exhaustedStatus of [429, 402]) {
    const store = new MemoryStore(), keys = keyRows();
    store.setProviderKeys("groq", keys);
    const requested: string[] = [];
    let first = true;
    const fetcher: typeof fetch = async (_input, init) => {
      const auth = authSlot(init);
      requested.push(auth);
      if (auth === "Bearer secret-groq-one" && first) {
        first = false;
        return new Response("not recorded", { status: exhaustedStatus });
      }
      return okGroq();
    };
    const now = new Date("2026-11-27T12:00:00.000Z");
    await groq(store, fetcher, "prompt", "scoring", now);
    await groq(store, fetcher, "prompt", "scoring", now);
    assertEquals(requested, [
      "Bearer secret-groq-one",
      "Bearer secret-groq-two",
      "Bearer secret-groq-two",
    ]);
    assertEquals(store.usage.reduce((n, x) => n + x.calls, 0), 2);
    assert(!JSON.stringify([...store.kv.entries()]).includes("secret-groq"));
  }
});

Deno.test("Groq all quota-exhausted slots are durably skipped on later invocations", async () => {
  const store = new MemoryStore();
  store.setProviderKeys("groq", keyRows());
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response("limited", { status: 429 });
  };
  const now = new Date("2026-11-27T12:00:00.000Z");
  await assertRejects(
    () => groq(store, fetcher, "prompt", "scoring", now),
    Error,
    "Groq keys unavailable",
  );
  assertEquals(calls, 2);
  await assertRejects(
    () => groq(store, fetcher, "prompt", "scoring", now),
    Error,
    "Groq keys unavailable",
  );
  assertEquals(calls, 2);
  assert(!JSON.stringify([...store.kv.entries()]).includes("limited"));
});

Deno.test("all suppressed Groq keys make scoring stop honestly and leave items queued", async () => {
  const store = new MemoryStore(), keys = keyRows();
  store.setProviderKeys("groq", keys);
  const now = new Date("2026-11-27T12:00:00.000Z");
  for (const key of keys) await blockNewsKey(store, "groq", key, "daily", now);
  const item = await store.insertItem({ title: "Pending item", status: "new" });
  let calls = 0;
  const result = await runScore(store, async () => {
    calls++;
    return okGroq();
  }, now);
  assertEquals(result.stopped, true);
  assertEquals(result.claimed, 1);
  assertEquals(result.scored, 0);
  assertEquals((await store.getItem(item.id))?.status, "new");
  assertEquals(calls, 0);
});

Deno.test("an explicitly empty managed slot set does not resurrect a legacy environment key", async () => {
  const old = Deno.env.get("GROQ_API_KEY_1");
  Deno.env.set("GROQ_API_KEY_1", "legacy-env-secret");
  try {
    const store = new MemoryStore();
    store.setProviderKeys("groq", []);
    let calls = 0;
    await assertRejects(
      () =>
        groq(
          store,
          async () => {
            calls++;
            return okGroq();
          },
          "p",
          "scoring",
        ),
      Error,
      "Groq keys unavailable",
    );
    assertEquals(calls, 0);
  } finally {
    if (old === undefined) Deno.env.delete("GROQ_API_KEY_1");
    else Deno.env.set("GROQ_API_KEY_1", old);
  }
});

Deno.test("News key reset uses exact configured Asia/Kolkata boundary; slot 1 resumes first at 05:00", async () => {
  const store = new MemoryStore();
  store.setProviderKeys("groq", keyRows());
  await store.setKV(NEWS_KEY_RESET_TIME_KEY, "05:00");
  const before = new Date("2026-11-27T23:29:59.999Z"); // 04:59:59.999 IST, 28 Nov
  assertEquals(
    nextNewsKeyReset(before).toISOString(),
    "2026-11-27T23:30:00.000Z",
  );
  assertEquals(
    nextNewsKeyReset(new Date("2026-11-27T23:30:00.000Z")).toISOString(),
    "2026-11-28T23:30:00.000Z",
  );
  const slots: string[] = [];
  let oneExhausts = true;
  const fetcher: typeof fetch = async (_input, init) => {
    const auth = authSlot(init);
    slots.push(auth);
    if (auth === "Bearer secret-groq-one" && oneExhausts) {
      oneExhausts = false;
      return new Response("", { status: 429 });
    }
    return okGroq();
  };
  await groq(store, fetcher, "p", "scoring", before);
  await groq(
    store,
    fetcher,
    "p",
    "scoring",
    new Date("2026-11-27T23:30:00.000Z"),
  );
  assertEquals(slots, [
    "Bearer secret-groq-one",
    "Bearer secret-groq-two",
    "Bearer secret-groq-one",
  ]);
  await store.setKV(NEWS_KEY_RESET_TIME_KEY, "06:15");
  assertEquals(
    nextNewsKeyReset(new Date("2026-11-27T23:30:00.000Z"), "06:15")
      .toISOString(),
    "2026-11-28T00:45:00.000Z",
  );
});

Deno.test("Auth failure blocks only its generation until replacement; new generation gets priority", async () => {
  const store = new MemoryStore();
  store.setProviderKeys("groq", keyRows());
  const requested: string[] = [];
  let rejectOriginal = true;
  const fetcher: typeof fetch = async (_input, init) => {
    const auth = authSlot(init);
    requested.push(auth);
    if (auth === "Bearer secret-groq-one" && rejectOriginal) {
      rejectOriginal = false;
      return new Response("", { status: 401 });
    }
    return okGroq();
  };
  const now = new Date("2026-11-27T12:00:00Z");
  await groq(store, fetcher, "p", "scoring", now);
  store.setProviderKeys(
    "groq",
    keyRows("secret-groq-one-new", "secret-groq-two", "g1-new", "g2"),
  );
  await groq(store, fetcher, "p", "scoring", now);
  assertEquals(requested, [
    "Bearer secret-groq-one",
    "Bearer secret-groq-two",
    "Bearer secret-groq-one-new",
  ]);
  assert(!JSON.stringify([...store.kv.entries()]).includes("secret-groq-one"));
});

Deno.test("Tavily 402/429/432/433 fail over to slot 2 and skip the exhausted slot on the next invocation", async () => {
  for (const exhaustedStatus of [402, 429, 432, 433]) {
    const store = new MemoryStore();
    store.setProviderKeys("tavily", [{
      slot: 1,
      key: "secret-tavily-one",
      generation: "tv1",
    }, { slot: 2, key: "secret-tavily-two", generation: "tv2" }]);
    const requested: string[] = [];
    let exhaust = true;
    const fetcher: typeof fetch = async (_input, init) => {
      const auth = authSlot(init);
      requested.push(auth);
      if (auth === "Bearer secret-tavily-one" && exhaust) {
        exhaust = false;
        return new Response("", { status: exhaustedStatus });
      }
      return new Response(
        JSON.stringify({ results: [{ url: "https://source.test/a" }] }),
        { status: 200 },
      );
    };
    const now = new Date("2026-11-27T12:00:00Z");
    assertEquals(
      (await tavily(store, fetcher, "query", now)).results.length,
      1,
    );
    await tavily(store, fetcher, "query", now);
    assertEquals(requested, [
      "Bearer secret-tavily-one",
      "Bearer secret-tavily-two",
      "Bearer secret-tavily-two",
    ]);
    assert(!JSON.stringify([...store.kv.entries()]).includes("secret-tavily"));
  }
});

Deno.test("score skips blocked Tavily slots without spending safety credits", async () => {
  const store = new MemoryStore();
  const groqKey = { slot: 1, key: "secret-score-groq", generation: "score-g1" };
  const tavilyKeys = [
    { slot: 1, key: "secret-tv-one", generation: "tv-g1" },
    { slot: 2, key: "secret-tv-two", generation: "tv-g2" },
  ];
  store.setProviderKeys("groq", [groqKey]);
  store.setProviderKeys("tavily", tavilyKeys);
  const now = new Date("2026-11-27T12:00:00.000Z");
  for (const key of tavilyKeys) {
    await blockNewsKey(store, "tavily", key, "daily", now);
  }
  const item = await store.insertItem({
    title: "OpenAI frontier model release",
    status: "new",
  });
  let tavilyCalls = 0;
  const score = JSON.stringify([{
    tag: "AI",
    tags: ["AI"],
    region: "US",
    company: "OpenAI",
    activity: "model",
    score: 9,
    points: ["One", "Two"],
  }]);
  const fetcher: typeof fetch = async (input) => {
    if (String(input).includes("api.groq.com")) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: score } }],
          usage: { prompt_tokens: 2, completion_tokens: 4 },
        }),
        { status: 200 },
      );
    }
    tavilyCalls++;
    return new Response("unexpected Tavily call", { status: 200 });
  };
  await runScore(store, fetcher, now);
  assertEquals(tavilyCalls, 0);
  assertEquals(await store.getKV("tavily:day:2026-11-27"), undefined);
  assertEquals((await store.getItem(item.id))?.verified, "unconfirmed");
});

Deno.test("network/server failures cool down only the affected key and make the alternate available", async () => {
  const store = new MemoryStore();
  store.setProviderKeys("groq", keyRows());
  const slots: string[] = [];
  let serverError = true;
  const fetcher: typeof fetch = async (_input, init) => {
    const auth = authSlot(init);
    slots.push(auth);
    if (auth === "Bearer secret-groq-one" && serverError) {
      serverError = false;
      return new Response("", { status: 503 });
    }
    return okGroq();
  };
  const now = new Date("2026-11-27T12:00:00Z");
  await groq(store, fetcher, "p", "scoring", now);
  await groq(store, fetcher, "p", "scoring", new Date(now.getTime() + 30_000));
  await groq(store, fetcher, "p", "scoring", new Date(now.getTime() + 61_000));
  assertEquals(slots, [
    "Bearer secret-groq-one",
    "Bearer secret-groq-two",
    "Bearer secret-groq-two",
    "Bearer secret-groq-one",
  ]);
});
