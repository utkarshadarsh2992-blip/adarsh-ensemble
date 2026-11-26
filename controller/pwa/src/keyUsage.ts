import {
  NAMES,
  PROVIDERS,
  type Provider,
  type Report,
  type UsageProvider,
} from "./domain";

export type KeyUsage = NonNullable<UsageProvider["keys"]>[number];
export type SlotUsage = {
  slot: number;
  current?: KeyUsage;
  previous: KeyUsage[];
};

export function keyUsageGroups(
  report: Report,
  provider: Provider | "all" = "all",
) {
  return PROVIDERS.filter((id) => provider === "all" || id === provider).map(
    (id) => {
      const rows = report.providers.find((p) => p.id === id)?.keys ?? [];
      return {
        id,
        name: NAMES[id],
        slots: [1, 2, 3].map((slot): SlotUsage => {
          const matching = rows.filter((k) => k.slot === slot);
          const current =
            matching.find((k) => k.active === true) ??
            matching.find((k) => k.active === undefined) ??
            matching.find(
              (k) => !k.generation && !k.set && k.state === "nokey",
            );
          return {
            slot,
            current,
            previous: matching.filter((k) => k !== current),
          };
        }),
      };
    },
  );
}

export function keyIdentityLabel(key: KeyUsage) {
  return key.generation
    ? `ID ${key.generation.slice(0, 8)}`
    : "Key identity unknown";
}
