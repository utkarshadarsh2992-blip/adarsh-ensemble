import test from "node:test";
import assert from "node:assert/strict";
import { keyIdentityLabel, keyUsageGroups } from "./keyUsage";
import type { Report } from "./domain";

const base: Report = {
  day_utc: "2026-11-26",
  totals: { req: 0, tok: 0 },
  providers: [],
};

test("a report always exposes 5 providers with three slots each, never inventing configured keys", () => {
  const groups = keyUsageGroups(base);
  assert.equal(groups.length, 5);
  assert.equal(groups.flatMap((g) => g.slots).length, 15);
  assert.ok(groups.every((g) => g.slots.every((s) => s.current === undefined)));
});
test("replacement key usage remains separate from previous and legacy slot counters", () => {
  const legacy = {
    slot: 1,
    set: true,
    active: false,
    req: 5,
    tok: 500,
    state: "ok",
    models: [],
  };
  const previous = {
    ...legacy,
    generation: "a".repeat(32),
    req: 10,
    tok: 1000,
  };
  const current = {
    ...legacy,
    generation: "b".repeat(32),
    active: true,
    req: 1,
    tok: 40,
  };
  const report: Report = {
    ...base,
    totals: { req: 16, tok: 1540 },
    providers: [
      {
        id: "groq",
        name: "Groq",
        req: 16,
        tok: 1540,
        keys: [legacy, previous, current],
      },
    ],
  };
  const slot = keyUsageGroups(report)[0].slots[0];
  assert.equal(slot.current?.generation, current.generation);
  assert.equal(slot.current?.tok, 40);
  assert.equal(slot.previous.length, 2);
  assert.equal(
    slot.previous.reduce((n, k) => n + k.tok, 0),
    1500,
  );
  assert.match(keyIdentityLabel(legacy), /unknown/);
  assert.equal(keyIdentityLabel(current), "ID bbbbbbbb");
});
test("older reports without generation IDs remain usable with explicit unknown attribution", () => {
  const row = { slot: 2, set: true, req: 3, tok: 70, state: "ok", models: [] };
  const report: Report = {
    ...base,
    providers: [{ id: "gemini", name: "Gemini", req: 3, tok: 70, keys: [row] }],
  };
  const group = keyUsageGroups(report, "gemini")[0];
  assert.equal(group.slots[1].current?.tok, 70);
  assert.equal(
    keyIdentityLabel(group.slots[1].current!),
    "Key identity unknown",
  );
});
test("provider filtering retains exactly its three slots without merging different devices", () => {
  assert.equal(keyUsageGroups(base, "cloudflare").length, 1);
  assert.equal(keyUsageGroups(base, "cloudflare")[0].slots.length, 3);
});

test("explicit missing-key slots remain Not configured while archived generations stay historical", () => {
  const missing = {
    slot: 1,
    set: false,
    active: false,
    state: "nokey",
    req: 0,
    tok: 0,
    models: [],
  };
  const archived = {
    ...missing,
    generation: "a".repeat(32),
    state: "ok",
    req: 2,
    tok: 55,
  };
  const report: Report = {
    ...base,
    providers: [
      { id: "groq", name: "Groq", req: 2, tok: 55, keys: [archived, missing] },
    ],
  };
  const slot = keyUsageGroups(report, "groq")[0].slots[0];
  assert.equal(slot.current, missing);
  assert.equal(slot.current?.set, false);
  assert.deepEqual(slot.previous, [archived]);
});
