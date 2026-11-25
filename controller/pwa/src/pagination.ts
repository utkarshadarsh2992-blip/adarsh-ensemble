import type { State } from "./domain";

export function mergeStatePage(current: State, next: State): State {
  if (
    current.revision !== next.revision ||
    JSON.stringify(current.config) !== JSON.stringify(next.config)
  ) {
    throw new Error(
      "Config pagination ke beech badli hai. Refresh karke latest state load karo; draft abhi preserve hai.",
    );
  }
  const devices = new Map(current.devices.map((d) => [d.id, d]));
  for (const device of next.devices) devices.set(device.id, device);
  const usage = new Map(
    current.usage.map((u) => [`${u.device_id}:${u.day_utc}`, u]),
  );
  for (const snapshot of next.usage) {
    const key = `${snapshot.device_id}:${snapshot.day_utc}`;
    const previous = usage.get(key);
    if (!previous || snapshot.updated_at >= previous.updated_at)
      usage.set(key, snapshot);
  }
  const history = new Map(current.history.map((h) => [h.revision, h]));
  for (const item of next.history) history.set(item.revision, item);
  if (devices.size > 3000 || usage.size > 8400 || history.size > 3000) {
    throw new Error(
      "Is session ki report limit aa gayi; current loaded data preserve hai.",
    );
  }
  return {
    ...current,
    devices: [...devices.values()],
    usage: [...usage.values()],
    history: [...history.values()].sort((a, b) => b.revision - a.revision),
    next_cursor: next.next_cursor,
  };
}
