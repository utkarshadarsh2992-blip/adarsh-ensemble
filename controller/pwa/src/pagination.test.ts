import test from "node:test";
import assert from "node:assert/strict";
import { mergeStatePage } from "./pagination";
import bundled from "./bundled.json";
import type { Config, State } from "./domain";
const state = (): State => ({
  ok: true,
  revision: 1,
  config: bundled as Config,
  devices: [],
  usage: [],
  history: [],
  next_cursor: "v1:30:420:30",
});
test("page merge preserves cursor and deduplicates stable identities", () => {
  const a = state(),
    b = state();
  a.history = [
    { revision: 1, created_at: "2026-11-25", actor_id: "a", reason: "seed" },
  ];
  b.history = [
    ...a.history,
    { revision: 2, created_at: "2026-11-25", actor_id: "a", reason: "change" },
  ];
  b.next_cursor = undefined;
  const merged = mergeStatePage(a, b);
  assert.equal(merged.history.length, 2);
  assert.equal(merged.next_cursor, undefined);
  assert.deepEqual(
    merged.history.map((h) => h.revision),
    [2, 1],
  );
});
test("revision/config changes reject pagination and leave caller data intact", () => {
  const a = state();
  assert.throws(
    () => mergeStatePage(a, { ...state(), revision: 2 }),
    /Refresh/,
  );
  const b = state();
  b.config = { ...b.config, quality: { audit: false } };
  assert.throws(() => mergeStatePage(a, b), /Refresh/);
  assert.equal(a.revision, 1);
  assert.equal(a.history.length, 0);
});
test("duplicate snapshots do not double-count and newest absolute snapshot wins", () => {
  const a = state(),
    b = state();
  const snapshot: State["usage"][number] = {
    device_id: "d1",
    day_utc: "2026-11-25",
    updated_at: "2026-11-25T10:00:00Z",
    report: {
      day_utc: "2026-11-25",
      totals: { req: 1, tok: 10 },
      providers: [],
    },
  };
  a.usage = [snapshot];
  b.usage = [
    {
      ...snapshot,
      updated_at: "2026-11-25T11:00:00Z",
      report: { ...snapshot.report, totals: { req: 2, tok: 20 } },
    },
  ];
  const merged = mergeStatePage(a, b);
  assert.equal(merged.usage.length, 1);
  assert.equal(merged.usage[0].report.totals.tok, 20);
});
