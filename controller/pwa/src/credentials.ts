export type CredentialScope = "app" | "news";
export type CredentialProvider =
  | "groq"
  | "openrouter"
  | "gemini"
  | "nvidia"
  | "cloudflare"
  | "tavily";

export type CredentialSlotDefinition = {
  scope: CredentialScope;
  provider: CredentialProvider;
  slot: number;
  label: string;
  group: string;
};

const APP_PROVIDERS = [
  "groq",
  "openrouter",
  "gemini",
  "nvidia",
  "cloudflare",
] as const;

export const CREDENTIAL_SLOTS: readonly CredentialSlotDefinition[] = [
  ...APP_PROVIDERS.flatMap((provider) =>
    [1, 2, 3].map((slot) => ({
      scope: "app" as const,
      provider,
      slot,
      label: `${provider === "cloudflare" ? "Cloudflare Workers AI" : provider[0].toUpperCase() + provider.slice(1)} · slot ${slot}`,
      group: "App providers",
    })),
  ),
  {
    scope: "app",
    provider: "tavily",
    slot: 1,
    label: "Answer / research Tavily",
    group: "App search",
  },
  ...["groq", "tavily"].flatMap((provider) =>
    [1, 2].map((slot) => ({
      scope: "news" as const,
      provider: provider as "groq" | "tavily",
      slot,
      label: `${provider === "groq" ? "News Groq" : "News Tavily"} · slot ${slot}`,
      group: provider === "groq" ? "News Groq" : "News Tavily",
    })),
  ),
];

/** One tappable provider card: all of its slots (App providers have three) open together. */
export type ProviderSlotGroup = {
  key: string;
  name: string;
  definitions: CredentialSlotDefinition[];
};

export function groupSlotsByProvider(
  definitions: readonly CredentialSlotDefinition[],
): ProviderSlotGroup[] {
  const groups = new Map<string, ProviderSlotGroup>();
  for (const definition of definitions) {
    const key = `${definition.scope}:${definition.provider}`;
    const current = groups.get(key);
    if (current) {
      current.definitions.push(definition);
    } else {
      groups.set(key, {
        key,
        name: definition.label.replace(/ · slot \d+$/, ""),
        definitions: [definition],
      });
    }
  }
  for (const group of groups.values()) {
    group.definitions.sort((a, b) => a.slot - b.slot);
  }
  return [...groups.values()];
}

export const OPEN_PROVIDERS_STORAGE_KEY = "adarshctl.keys.openProviders.v1";

/** Remembered open provider cards (UI layout only; never credential data). */
export function parseOpenProviders(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const valid = new Set(
      CREDENTIAL_SLOTS.map((slot) => `${slot.scope}:${slot.provider}`),
    );
    return [
      ...new Set(
        value.filter(
          (item): item is string => typeof item === "string" && valid.has(item),
        ),
      ),
    ];
  } catch {
    return [];
  }
}

export type CredentialSlotMetadata = {
  scope: "app" | "news" | "setup";
  provider: string;
  slot: number;
  key_set: boolean;
  account_id_set?: boolean;
  generation: string | null;
  updated_at: string | null;
};

export type DeviceSettings = {
  briefingOn: boolean;
  briefingTime: string;
  newsBriefing: boolean;
  briefingTelegram: boolean;
};

export type CredentialsState = {
  ok: true;
  slots: CredentialSlotMetadata[];
  reset_time: string;
  timezone: "Asia/Kolkata";
  device_settings: DeviceSettings;
  setup_status: { news: boolean; firebase: boolean };
};

export type FirebaseFields = {
  apiKey: string;
  appId: string;
  projectId: string;
  senderId: string;
};

export const DEFAULT_NEWS_RESET_TIME = "05:00";
export const RESET_TIMEZONE = "Asia/Kolkata" as const;

export function isHHMM(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validMetadataSlot(value: unknown): value is CredentialSlotMetadata {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "scope",
      "provider",
      "slot",
      "key_set",
      "account_id_set",
      "generation",
      "updated_at",
    ])
  )
    return false;
  if (
    !(
      value.scope === "app" ||
      value.scope === "news" ||
      value.scope === "setup"
    )
  )
    return false;
  if (typeof value.provider !== "string" || value.provider.length > 40)
    return false;
  if (
    !Number.isInteger(value.slot) ||
    (value.slot as number) < 1 ||
    (value.slot as number) > 3
  )
    return false;
  if (typeof value.key_set !== "boolean") return false;
  if (
    value.account_id_set !== undefined &&
    typeof value.account_id_set !== "boolean"
  )
    return false;
  if (
    value.generation !== null &&
    (typeof value.generation !== "string" || value.generation.length > 128)
  )
    return false;
  if (
    value.updated_at !== null &&
    (typeof value.updated_at !== "string" || value.updated_at.length > 64)
  )
    return false;

  if (value.scope === "app") {
    if (
      !(APP_PROVIDERS as readonly string[]).includes(value.provider) &&
      value.provider !== "tavily"
    )
      return false;
    if (value.provider === "tavily" && value.slot !== 1) return false;
    if (value.provider === "cloudflare")
      return (
        value.account_id_set === undefined ||
        typeof value.account_id_set === "boolean"
      );
    return value.account_id_set === undefined;
  }
  if (value.scope === "news")
    return (
      (value.provider === "groq" || value.provider === "tavily") &&
      (value.slot as number) <= 2 &&
      value.account_id_set === undefined
    );
  return (
    (value.provider === "news" || value.provider === "firebase") &&
    value.slot === 1 &&
    value.account_id_set === undefined
  );
}

export function parseCredentialsState(value: unknown): CredentialsState | null {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "ok",
      "slots",
      "reset_time",
      "timezone",
      "device_settings",
      "setup_status",
    ])
  )
    return null;
  if (
    value.ok !== true ||
    !Array.isArray(value.slots) ||
    !value.slots.every(validMetadataSlot)
  )
    return null;
  const expectedSlotKeys = new Set([
    ...CREDENTIAL_SLOTS.map(
      ({ scope, provider, slot }) => `${scope}:${provider}:${slot}`,
    ),
    "setup:news:1",
    "setup:firebase:1",
  ]);
  const receivedSlotKeys = value.slots.map(
    (slot) => `${slot.scope}:${slot.provider}:${slot.slot}`,
  );
  if (
    receivedSlotKeys.length !== expectedSlotKeys.size ||
    new Set(receivedSlotKeys).size !== expectedSlotKeys.size ||
    receivedSlotKeys.some((key) => !expectedSlotKeys.has(key))
  )
    return null;
  if (!isHHMM(value.reset_time) || value.timezone !== RESET_TIMEZONE)
    return null;
  if (
    !isRecord(value.device_settings) ||
    !onlyKeys(value.device_settings, [
      "briefingOn",
      "briefingTime",
      "newsBriefing",
      "briefingTelegram",
    ])
  )
    return null;
  const settings = value.device_settings;
  if (
    typeof settings.briefingOn !== "boolean" ||
    !isHHMM(settings.briefingTime) ||
    typeof settings.newsBriefing !== "boolean" ||
    typeof settings.briefingTelegram !== "boolean"
  )
    return null;
  if (
    !isRecord(value.setup_status) ||
    !onlyKeys(value.setup_status, ["news", "firebase"]) ||
    typeof value.setup_status.news !== "boolean" ||
    typeof value.setup_status.firebase !== "boolean"
  )
    return null;

  return {
    ok: true,
    slots: value.slots.map((slot) => ({ ...slot })),
    reset_time: value.reset_time,
    timezone: RESET_TIMEZONE,
    device_settings: { ...settings } as DeviceSettings,
    setup_status: { ...value.setup_status } as CredentialsState["setup_status"],
  };
}

export function credentialInputError(
  definition: CredentialSlotDefinition,
  key: string,
  accountId: string,
): string | null {
  if (
    key.length > 8192 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(key)
  )
    return "Key field invalid hai. Value check karke dobara enter karo.";
  if (definition.provider === "cloudflare") {
    const account = accountId.trim();
    if (account && !/^[a-f0-9]{32}$/i.test(account))
      return "Cloudflare Account ID 32 hexadecimal characters ka hona chahiye.";
    if (key && !key.trim())
      return "Key blank hai; Account ID-only update ke liye key field empty rakho.";
    if (!key && !account)
      return "Key ya Cloudflare Account ID mein se ek enter karo.";
  } else {
    if (accountId) return "Account ID sirf Cloudflare slot ke liye hai.";
    if (!key.trim()) return "Key value zaroori hai.";
  }
  return null;
}

export function credentialSetPayload(
  definition: CredentialSlotDefinition,
  key: string,
  accountId = "",
) {
  return {
    action: "credentials_set",
    scope: definition.scope,
    provider: definition.provider,
    slot: definition.slot,
    key,
    ...(definition.provider === "cloudflare" && accountId.trim()
      ? { account_id: accountId.trim() }
      : {}),
  };
}

export function credentialDeletePayload(definition: CredentialSlotDefinition) {
  return {
    action: "credentials_delete",
    scope: definition.scope,
    provider: definition.provider,
    slot: definition.slot,
  };
}

export function setupUrlError(value: string): string | null {
  if (!value || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value))
    return "HTTPS setup URL zaroori hai.";
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.hostname === "localhost" ||
      url.hostname.endsWith(".local")
    )
      return "News setup ke liye public HTTPS URL chahiye; query/fragment nahi.";
    return null;
  } catch {
    return "Valid HTTPS setup URL chahiye.";
  }
}

export function setupSecretError(value: string, label: string): string | null {
  if (
    !value.trim() ||
    value.length > 8192 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    return `${label} required hai; value ko check karo.`;
  return null;
}

export function firebaseFieldsError(fields: FirebaseFields): string | null {
  for (const [name, value] of Object.entries(fields)) {
    if (
      !value.trim() ||
      value.length > 1024 ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      return `Firebase ${name} field required hai.`;
  }
  return null;
}

/** Parse the selected file locally; return only the four supported Firebase fields. */
export function parseGoogleServicesJson(text: string): FirebaseFields | null {
  try {
    const root: unknown = JSON.parse(text);
    if (
      !isRecord(root) ||
      !isRecord(root.project_info) ||
      !Array.isArray(root.client)
    )
      return null;
    const projectId = root.project_info.project_id;
    const senderNumber = root.project_info.project_number;
    const senderId =
      typeof senderNumber === "string"
        ? senderNumber
        : typeof senderNumber === "number" && Number.isSafeInteger(senderNumber)
          ? String(senderNumber)
          : null;
    if (typeof projectId !== "string" || !senderId) return null;
    for (const client of root.client) {
      if (
        !isRecord(client) ||
        !isRecord(client.client_info) ||
        !Array.isArray(client.api_key)
      )
        continue;
      const appId = client.client_info.mobilesdk_app_id;
      const apiKey = client.api_key.find(
        (entry) => isRecord(entry) && typeof entry.current_key === "string",
      );
      if (typeof appId === "string" && isRecord(apiKey)) {
        const result = {
          apiKey: apiKey.current_key as string,
          appId,
          projectId,
          senderId,
        };
        return firebaseFieldsError(result) ? null : result;
      }
    }
    return null;
  } catch {
    return null;
  }
}
