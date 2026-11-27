import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from "react";
import {
  BellRing,
  ChevronDown,
  Cloud,
  KeyRound,
  Link2,
  Newspaper,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Smartphone,
  Trash2,
} from "lucide-react";
import { admin, adminWriteOnly } from "../api";
import {
  CREDENTIAL_SLOTS,
  DEFAULT_NEWS_RESET_TIME,
  OPEN_PROVIDERS_STORAGE_KEY,
  groupSlotsByProvider,
  parseOpenProviders,
  RESET_TIMEZONE,
  credentialDeletePayload,
  credentialInputError,
  credentialSetPayload,
  firebaseFieldsError,
  isHHMM,
  parseCredentialsState,
  parseGoogleServicesJson,
  setupSecretError,
  setupUrlError,
  type CredentialSlotDefinition,
  type CredentialsState,
  type DeviceSettings,
  type FirebaseFields,
} from "../credentials";
import { Badge, Card, Empty } from "./ui";

type Props = {
  active: boolean;
  online: boolean;
  onNotice: (message: string) => void;
};

type NewsDraft = { url: string; secret: string };
const EMPTY_FIREBASE: FirebaseFields = {
  apiKey: "",
  appId: "",
  projectId: "",
  senderId: "",
};
const OPERATIONS = [
  {
    operation: "telegram_link",
    label: "Link Telegram",
    icon: Link2,
    success: "Telegram link request sent to the protected News service.",
  },
  {
    operation: "telegram_test",
    label: "Telegram Test",
    icon: Send,
    success: "Telegram test requested.",
  },
  {
    operation: "digest_now",
    label: "Digest now",
    icon: Newspaper,
    success: "News digest requested.",
  },
  {
    operation: "fcm_test",
    label: "Push Test",
    icon: Smartphone,
    success: "Push test requested.",
  },
] as const;

function slotKey(scope: string, provider: string, slot: number) {
  return `${scope}:${provider}:${slot}`;
}
function metadataFor(
  state: CredentialsState,
  definition: CredentialSlotDefinition,
) {
  return state.slots.find(
    (row) =>
      row.scope === definition.scope &&
      row.provider === definition.provider &&
      row.slot === definition.slot,
  );
}

export default function KeysSettings({ active, online, onNotice }: Props) {
  const [metadata, setMetadata] = useState<CredentialsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [formError, setFormError] = useState("");
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [accountDrafts, setAccountDrafts] = useState<Record<string, string>>(
    {},
  );
  const [resetDraft, setResetDraft] = useState(DEFAULT_NEWS_RESET_TIME);
  const [settingsDraft, setSettingsDraft] = useState<DeviceSettings | null>(
    null,
  );
  const [newsDraft, setNewsDraft] = useState<NewsDraft>({
    url: "",
    secret: "",
  });
  const [firebaseDraft, setFirebaseDraft] =
    useState<FirebaseFields>(EMPTY_FIREBASE);

  const loadMetadata = useCallback(async () => {
    setLoading(true);
    setUnavailable(false);
    setFormError("");
    try {
      const response = await admin<unknown>({ action: "credentials_state" });
      const safeState = parseCredentialsState(response);
      if (!safeState) throw new Error("metadata response invalid");
      setMetadata(safeState);
      setResetDraft(safeState.reset_time || DEFAULT_NEWS_RESET_TIME);
      setSettingsDraft({ ...safeState.device_settings });
    } catch {
      setMetadata(null);
      setSettingsDraft(null);
      setResetDraft(DEFAULT_NEWS_RESET_TIME);
      setUnavailable(true);
      setKeyDrafts({});
      setAccountDrafts({});
      setNewsDraft({ url: "", secret: "" });
      setFirebaseDraft({ ...EMPTY_FIREBASE });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (active) void loadMetadata();
  }, [active, loadMetadata]);

  const canWrite = !!metadata && online && !loading && pending === null;
  const groupedSlots = useMemo(() => {
    const groups = new Map<string, CredentialSlotDefinition[]>();
    for (const definition of CREDENTIAL_SLOTS) {
      const rows = groups.get(definition.group) ?? [];
      rows.push(definition);
      groups.set(definition.group, rows);
    }
    return [...groups.entries()].map(
      ([group, definitions]) =>
        [group, groupSlotsByProvider(definitions)] as const,
    );
  }, []);
  /* Provider cards: one tap opens every slot of that provider together and the
     choice is remembered, so opened providers stay open on every visit. */
  const [openProviders, setOpenProviders] = useState<string[]>(() => {
    try {
      return parseOpenProviders(
        window.localStorage.getItem(OPEN_PROVIDERS_STORAGE_KEY),
      );
    } catch {
      return [];
    }
  });
  const allProviderKeys = useMemo(
    () => groupedSlots.flatMap(([, providers]) => providers.map((p) => p.key)),
    [groupedSlots],
  );
  function rememberOpen(next: string[]) {
    setOpenProviders(next);
    try {
      window.localStorage.setItem(
        OPEN_PROVIDERS_STORAGE_KEY,
        JSON.stringify(next),
      );
    } catch {
      /* layout preference only */
    }
  }
  function toggleProvider(key: string) {
    rememberOpen(
      openProviders.includes(key)
        ? openProviders.filter((item) => item !== key)
        : [...openProviders, key],
    );
  }
  const allOpen = allProviderKeys.every((key) => openProviders.includes(key));

  async function finishMetadataRefresh() {
    await loadMetadata();
  }

  async function saveCredential(definition: CredentialSlotDefinition) {
    const id = slotKey(definition.scope, definition.provider, definition.slot);
    const key = keyDrafts[id] ?? "";
    const accountId = accountDrafts[id] ?? "";
    const error = credentialInputError(definition, key, accountId);
    if (error) {
      setFormError(error);
      return;
    }
    setFormError("");
    setPending(`key:${id}`);
    try {
      await adminWriteOnly(credentialSetPayload(definition, key, accountId));
      setKeyDrafts((current) => ({ ...current, [id]: "" }));
      setAccountDrafts((current) => ({ ...current, [id]: "" }));
      onNotice(
        `${definition.label} save request complete. Value dobara nahi dikhayi jayegi.`,
      );
      await finishMetadataRefresh();
    } catch {
      setFormError(
        "Secure save unavailable. Sensitive input clear kar diya; owner access, connection, ya backend check karo.",
      );
    } finally {
      setKeyDrafts((current) => ({ ...current, [id]: "" }));
      setAccountDrafts((current) => ({ ...current, [id]: "" }));
      setPending(null);
    }
  }

  async function deleteCredential(definition: CredentialSlotDefinition) {
    const id = slotKey(definition.scope, definition.provider, definition.slot);
    if (
      !window.confirm(
        `${definition.label} clear karein? Vault value aur paired phone ki is slot ki purani local value agle sync par remove hogi.`,
      )
    )
      return;
    setFormError("");
    setPending(`key:${id}`);
    try {
      await adminWriteOnly(credentialDeletePayload(definition));
      onNotice(`${definition.label} delete request complete.`);
      await finishMetadataRefresh();
    } catch {
      setFormError(
        "Secure delete unavailable. Owner access, connection, ya backend check karke retry karo.",
      );
    } finally {
      setKeyDrafts((current) => ({ ...current, [id]: "" }));
      setAccountDrafts((current) => ({ ...current, [id]: "" }));
      setPending(null);
    }
  }

  async function saveDeviceSettings() {
    if (!metadata || !settingsDraft) return;
    if (!isHHMM(settingsDraft.briefingTime)) {
      setFormError("Briefing time HH:MM (24-hour) format mein enter karo.");
      return;
    }
    setFormError("");
    setPending("device-settings");
    try {
      await adminWriteOnly({
        action: "device_settings_set",
        settings: settingsDraft,
      });
      onNotice(
        "Briefing settings save hui. Privacy consent phone-local hi rahegi.",
      );
      await finishMetadataRefresh();
    } catch {
      setFormError(
        "Briefing settings save nahi hui. Backend/access check karke retry karo.",
      );
    } finally {
      setPending(null);
    }
  }

  async function saveResetTime() {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(resetDraft)) {
      setFormError("Reset time HH:MM (24-hour) format mein enter karo.");
      return;
    }
    setFormError("");
    setPending("reset-time");
    try {
      await adminWriteOnly({ action: "news_key_reset", time: resetDraft });
      onNotice(`News key reset ${resetDraft} ${RESET_TIMEZONE} par set hui.`);
      await finishMetadataRefresh();
    } catch {
      setFormError(
        "News reset time save nahi hui. Backend/access check karke retry karo.",
      );
    } finally {
      setPending(null);
    }
  }

  async function saveNewsSetup() {
    const urlError = setupUrlError(newsDraft.url);
    const secretError = setupSecretError(newsDraft.secret, "APP_SECRET");
    if (urlError || secretError) {
      setFormError(urlError ?? secretError ?? "News setup invalid hai.");
      return;
    }
    setFormError("");
    setPending("news-setup");
    try {
      await adminWriteOnly({
        action: "setup_set",
        news: { url: newsDraft.url, secret: newsDraft.secret },
      });
      setNewsDraft({ url: "", secret: "" });
      onNotice(
        "News setup save request complete. URL/secret dobara nahi dikhte.",
      );
      await finishMetadataRefresh();
    } catch {
      setFormError(
        "News setup save nahi hui. Values clear karke backend/access check karo.",
      );
    } finally {
      setNewsDraft({ url: "", secret: "" });
      setPending(null);
    }
  }

  async function saveFirebaseSetup() {
    const error = firebaseFieldsError(firebaseDraft);
    if (error) {
      setFormError(error);
      return;
    }
    setFormError("");
    setPending("firebase-setup");
    try {
      await adminWriteOnly({ action: "setup_set", firebase: firebaseDraft });
      setFirebaseDraft({ ...EMPTY_FIREBASE });
      onNotice(
        "Firebase setup save request complete. Values dobara nahi dikhte.",
      );
      await finishMetadataRefresh();
    } catch {
      setFormError(
        "Firebase setup save nahi hui. Values clear karke backend/access check karo.",
      );
    } finally {
      setFirebaseDraft({ ...EMPTY_FIREBASE });
      setPending(null);
    }
  }

  async function deleteSetup(provider: "news" | "firebase") {
    const label =
      provider === "news" ? "News URL/APP_SECRET" : "Firebase configuration";
    if (
      !window.confirm(
        `${label} clear karein? Vault aur paired phone ka setup agle sync par remove hoga.`,
      )
    )
      return;
    setFormError("");
    setPending(`setup:${provider}`);
    try {
      await adminWriteOnly({ action: "setup_delete", provider });
      if (provider === "news") setNewsDraft({ url: "", secret: "" });
      else setFirebaseDraft({ ...EMPTY_FIREBASE });
      onNotice(`${label} delete request complete.`);
      await finishMetadataRefresh();
    } catch {
      setFormError(
        `${label} delete nahi hua. Owner access, connection, ya backend check karo.`,
      );
    } finally {
      if (provider === "news") setNewsDraft({ url: "", secret: "" });
      else setFirebaseDraft({ ...EMPTY_FIREBASE });
      setPending(null);
    }
  }

  async function runOperation(
    operation: (typeof OPERATIONS)[number]["operation"],
    success: string,
  ) {
    setFormError("");
    setPending(`operation:${operation}`);
    try {
      await adminWriteOnly({ action: "news_operation", operation });
      onNotice(success);
    } catch {
      setFormError(
        "News operation unavailable. Owner access, connection, ya backend version check karo.",
      );
    } finally {
      setPending(null);
    }
  }

  async function readFirebaseFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setFormError("google-services.json 2 MB se chhoti honi chahiye.");
      return;
    }
    try {
      const parsed = parseGoogleServicesJson(await file.text());
      if (!parsed) {
        setFormError(
          "Firebase fields parse nahi hue. Valid google-services.json select karo.",
        );
        return;
      }
      setFirebaseDraft(parsed);
      setFormError("");
      onNotice(
        "Firebase fields local browser mein parse hue; file upload nahi hui. Save se pehle review karo.",
      );
    } catch {
      setFormError(
        "Firebase config file read nahi hui. File locally select karke retry karo.",
      );
    }
  }

  const currentSettingsDirty =
    !!metadata &&
    !!settingsDraft &&
    JSON.stringify(metadata.device_settings) !== JSON.stringify(settingsDraft);

  function renderSlot(definition: CredentialSlotDefinition) {
    const id = slotKey(definition.scope, definition.provider, definition.slot);
    const row = metadata ? metadataFor(metadata, definition) : undefined;
    const configured = !!row?.key_set;
    const cloudflareSlot = definition.provider === "cloudflare";
    const hasAccount = !!row?.account_id_set;
    return (
      <article className="keys-slot-card" key={id}>
        <div className="keys-slot-head">
          <div>
            <h4>Slot {definition.slot}</h4>
            <p className="mono">
              {definition.scope} / {definition.provider} / {definition.slot}
            </p>
          </div>
          <Badge tone={configured ? "good" : "muted"}>
            {configured ? "Configured" : "Missing"}
          </Badge>
        </div>
        {row ? (
          <div
            className="keys-meta"
            aria-label={`${definition.label} metadata`}
          >
            <span>
              Key set <b>{row.key_set ? "Yes" : "No"}</b>
            </span>
            {cloudflareSlot && (
              <span>
                Account ID set <b>{hasAccount ? "Yes" : "No"}</b>
              </span>
            )}
            {row.generation && (
              <span className="mono keys-generation">
                Generation {row.generation}
              </span>
            )}
            {row.updated_at && (
              <span className="mono keys-updated">
                Updated {row.updated_at}
              </span>
            )}
          </div>
        ) : (
          <p className="help">
            Slot metadata abhi nahi mila; koi credential value display nahi
            hoti.
          </p>
        )}
        <label className="field">
          {configured ? "Replace key" : "Enter key"}
          <input
            type="password"
            value={keyDrafts[id] ?? ""}
            autoComplete="new-password"
            data-1p-ignore="true"
            data-lpignore="true"
            data-form-type="other"
            spellCheck={false}
            disabled={!canWrite}
            placeholder={
              cloudflareSlot
                ? "Optional for Account-ID-only update"
                : "Write-only value"
            }
            onChange={(event) =>
              setKeyDrafts((current) => ({
                ...current,
                [id]: event.target.value,
              }))
            }
          />
        </label>
        {cloudflareSlot && (
          <label className="field">
            Cloudflare Account ID
            <input
              type="password"
              value={accountDrafts[id] ?? ""}
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              spellCheck={false}
              disabled={!canWrite}
              placeholder="32-character account ID"
              inputMode="text"
              onChange={(event) =>
                setAccountDrafts((current) => ({
                  ...current,
                  [id]: event.target.value,
                }))
              }
            />
          </label>
        )}
        <div className="form-actions keys-slot-actions">
          <button
            className="btn primary"
            disabled={
              !canWrite ||
              (!(keyDrafts[id] ?? "") && !(accountDrafts[id] ?? "").trim())
            }
            onClick={() => void saveCredential(definition)}
          >
            <Save size={14} /> Save slot
          </button>
          <button
            className="btn secondary danger-action"
            disabled={!canWrite}
            onClick={() => void deleteCredential(definition)}
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </article>
    );
  }
  return (
    <div className="page-module keys-settings">
      <div className="toolbar">
        <div className="page-title">
          <div className="eyebrow">CONTROL PLANE / OWNER</div>
          <h1>
            Keys & settings<span className="orange">.</span>
          </h1>
          <p>
            Owner-managed, write-only credentials and News delivery controls.
            Values are never read back.
          </p>
        </div>
        <button
          className="btn secondary"
          disabled={loading || !online}
          onClick={() => void loadMetadata()}
        >
          <RefreshCw size={15} /> {loading ? "Loading…" : "Refresh metadata"}
        </button>
      </div>

      <div className="notice keys-security-note" role="note">
        <ShieldCheck size={17} />
        <span>
          Owner API se encrypted Vault storage. Keys/setup secrets sirf save
          request mein jaate hain; browser unhe store ya reveal nahi karta. App
          Tavily aur News Tavily independent slots hain—koi shared fallback
          nahi.
        </span>
      </div>
      {!online && (
        <div className="notice warning">
          Offline · secure writes unavailable. Sensitive fields save nahi hongi.
        </div>
      )}
      {formError && (
        <div className="error alert" role="alert">
          {formError}
        </div>
      )}

      {loading && !metadata ? (
        <Card>
          <Empty title="Owner metadata load ho raha hai">
            Secret values fetch nahi ki jaati; sirf slot/status metadata load
            hota hai.
          </Empty>
        </Card>
      ) : unavailable || !metadata ? (
        <Card className="keys-unavailable">
          <Empty title="Secure settings backend unavailable">
            `credentials_state` metadata API available nahi hai ya response
            contract se match nahi karta. Secret controls fail-safe disabled
            hain; existing models, routes, usage aur News views alag se
            available rahenge. Backend update ke baad Refresh metadata karo.
          </Empty>
          <div className="form-actions">
            <button
              className="btn secondary"
              disabled={loading || !online}
              onClick={() => void loadMetadata()}
            >
              <RefreshCw size={15} /> Retry metadata
            </button>
          </div>
        </Card>
      ) : (
        <>
          <div className="toolbar keys-state-toolbar">
            <Badge tone="good">Owner API metadata connected</Badge>
            <Badge>
              News reset · {metadata.reset_time} {metadata.timezone}
            </Badge>
            <Badge tone={metadata.setup_status.news ? "good" : "muted"}>
              News setup {metadata.setup_status.news ? "set" : "missing"}
            </Badge>
            <Badge tone={metadata.setup_status.firebase ? "good" : "muted"}>
              Firebase {metadata.setup_status.firebase ? "set" : "missing"}
            </Badge>
          </div>

          <Card>
            <div className="section-head">
              <h2>
                <KeyRound size={19} /> Provider credentials
              </h2>
              <span className="mono muted">WRITE-ONLY · VAULT</span>
            </div>
            <p className="help">
              Har slot ka secret alag submit/delete hota hai. Save ke baad sirf
              configured status, generation aur update time dikhte hain; key
              dobara fetch ya reveal nahi hoti. Untouched phone keys retain
              rahti hain; Delete se purani local slot bhi clear hogi.
            </p>
            <div className="keys-open-toolbar">
              <span className="help">
                Provider par tap karo · uske saare slots ek saath khulenge aur
                khule rahenge.
              </span>
              <button
                type="button"
                className="text-btn"
                onClick={() => rememberOpen(allOpen ? [] : allProviderKeys)}
              >
                {allOpen ? "Sab band karo" : "Sab kholo"}
              </button>
            </div>
            <div className="keys-groups">
              {groupedSlots.map(([group, providers]) => (
                <section className="keys-group" key={group}>
                  <div className="keys-group-head">
                    <h3>{group}</h3>
                    {group === "App search" && (
                      <Badge tone="orange">Answer / research</Badge>
                    )}
                    {group === "News Tavily" && (
                      <Badge tone="orange">
                        News scope · no shared fallback
                      </Badge>
                    )}
                    {group === "News Groq" && <Badge>News scope</Badge>}
                  </div>
                  <div className="keys-provider-list">
                    {providers.map((provider) => {
                      const open = openProviders.includes(provider.key);
                      const setCount = provider.definitions.filter(
                        (definition) =>
                          !!metadataFor(metadata, definition)?.key_set,
                      ).length;
                      const total = provider.definitions.length;
                      const tone =
                        setCount === total
                          ? "good"
                          : setCount > 0
                            ? "warn"
                            : "muted";
                      const panelId = `keys-panel-${provider.key.replace(":", "-")}`;
                      return (
                        <div
                          className={`keys-provider${open ? " open" : ""}`}
                          key={provider.key}
                        >
                          <button
                            type="button"
                            className="keys-provider-head"
                            aria-expanded={open}
                            aria-controls={panelId}
                            onClick={() => toggleProvider(provider.key)}
                          >
                            <span
                              className={`provider-avatar ${provider.definitions[0].provider}`}
                              aria-hidden="true"
                            >
                              {provider.name[0]}
                            </span>
                            <span className="keys-provider-title">
                              <b>{provider.name}</b>
                              <small>
                                {total === 1
                                  ? "1 slot"
                                  : `${total} slots · ek tap mein sab`}
                              </small>
                            </span>
                            <Badge tone={tone}>
                              {setCount}/{total} set
                            </Badge>
                            <ChevronDown
                              size={17}
                              className="keys-provider-chevron"
                            />
                          </button>
                          {open && (
                            <div className="keys-slot-grid" id={panelId}>
                              {provider.definitions.map(renderSlot)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </Card>

          <Card>
            <div className="section-head">
              <h2>
                <BellRing size={19} /> Briefing controls
              </h2>
              <span className="mono muted">PAIRED DEVICE</span>
            </div>
            <p className="help">
              Controller se briefing behavior set hota hai. Privacy consent aur
              phone permissions device par hi manage honge.
            </p>
            {!settingsDraft ? (
              <p className="help">Device setting metadata unavailable.</p>
            ) : (
              <>
                <label className="settings-check-row">
                  <span>
                    <b>Briefing on</b>
                    <small>Scheduled briefing enabled/disabled.</small>
                  </span>
                  <input
                    type="checkbox"
                    disabled={!canWrite}
                    checked={settingsDraft.briefingOn}
                    onChange={(event) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        briefingOn: event.target.checked,
                      })
                    }
                  />
                </label>
                <div className="setting-row">
                  <div>
                    <h3>Briefing time</h3>
                    <p>Device schedule time; server validates HH:MM.</p>
                  </div>
                  <input
                    className="settings-time"
                    aria-label="Briefing time"
                    type="time"
                    disabled={!canWrite}
                    value={settingsDraft.briefingTime}
                    onChange={(event) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        briefingTime: event.target.value,
                      })
                    }
                  />
                </div>
                <label className="settings-check-row">
                  <span>
                    <b>Include News</b>
                    <small>Include News items in the briefing.</small>
                  </span>
                  <input
                    type="checkbox"
                    disabled={!canWrite}
                    checked={settingsDraft.newsBriefing}
                    onChange={(event) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        newsBriefing: event.target.checked,
                      })
                    }
                  />
                </label>
                <label className="settings-check-row">
                  <span>
                    <b>Copy briefing to Telegram</b>
                    <small>
                      Send the briefing through the linked Telegram destination.
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    disabled={!canWrite}
                    checked={settingsDraft.briefingTelegram}
                    onChange={(event) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        briefingTelegram: event.target.checked,
                      })
                    }
                  />
                </label>
                <div className="form-actions">
                  <button
                    className="btn primary"
                    disabled={!canWrite || !currentSettingsDirty}
                    onClick={() => void saveDeviceSettings()}
                  >
                    <Save size={14} /> Save briefing settings
                  </button>
                </div>
              </>
            )}
          </Card>

          <Card>
            <div className="section-head">
              <h2>
                <RefreshCw size={19} /> News key reset
              </h2>
              <span className="mono muted">
                FIXED {RESET_TIMEZONE.toUpperCase()}
              </span>
            </div>
            <p className="help">
              Groq/Tavily key-specific suppression agle daily reset tak rahegi.
              Reset time editable hai; timezone fixed Asia/Kolkata hai.
            </p>
            <div className="keys-reset-row">
              <label className="field">
                Reset time ({RESET_TIMEZONE})
                <input
                  className="settings-time"
                  aria-label="News key reset time"
                  type="time"
                  value={resetDraft || DEFAULT_NEWS_RESET_TIME}
                  disabled={!canWrite}
                  onChange={(event) => setResetDraft(event.target.value)}
                />
              </label>
              <button
                className="btn primary"
                disabled={!canWrite || resetDraft === metadata.reset_time}
                onClick={() => void saveResetTime()}
              >
                <Save size={14} /> Save reset time
              </button>
            </div>
          </Card>

          <Card>
            <div className="section-head">
              <h2>
                <Cloud size={19} /> News service setup
              </h2>
              <Badge tone={metadata.setup_status.news ? "good" : "muted"}>
                {metadata.setup_status.news ? "Configured" : "Missing"}
              </Badge>
            </div>
            <p className="help">
              News URL aur APP_SECRET write-only set/delete hain. Secret browser
              se News operations ko nahi bheja jaata.
            </p>
            <label className="field">
              News service URL
              <input
                type="url"
                inputMode="url"
                autoComplete="url"
                disabled={!canWrite}
                value={newsDraft.url}
                placeholder="https://…"
                onChange={(event) =>
                  setNewsDraft({ ...newsDraft, url: event.target.value })
                }
              />
            </label>
            <label className="field">
              APP_SECRET
              <input
                type="password"
                autoComplete="new-password"
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                spellCheck={false}
                disabled={!canWrite}
                value={newsDraft.secret}
                placeholder="Write-only value"
                onChange={(event) =>
                  setNewsDraft({ ...newsDraft, secret: event.target.value })
                }
              />
            </label>
            <div className="form-actions">
              <button
                className="btn primary"
                disabled={!canWrite || !newsDraft.url || !newsDraft.secret}
                onClick={() => void saveNewsSetup()}
              >
                <Save size={14} /> Save News setup
              </button>
              <button
                className="btn secondary danger-action"
                disabled={!canWrite}
                onClick={() => void deleteSetup("news")}
              >
                <Trash2 size={14} /> Delete setup
              </button>
            </div>
          </Card>

          <Card>
            <div className="section-head">
              <h2>
                <Smartphone size={19} /> Firebase / push setup
              </h2>
              <Badge tone={metadata.setup_status.firebase ? "good" : "muted"}>
                {metadata.setup_status.firebase ? "Configured" : "Missing"}
              </Badge>
            </div>
            <p className="help">
              Google services file optional hai. Browser selected file ko
              locally parse karta hai; file upload nahi hoti. `apiKey` bhi
              write-only field hai.
            </p>
            <label className="field firebase-file-field">
              Optional google-services.json
              <input
                type="file"
                accept="application/json,.json"
                disabled={!canWrite}
                onChange={(event) => void readFirebaseFile(event)}
              />
            </label>
            <div className="firebase-fields">
              <label className="field">
                Firebase API key
                <input
                  type="password"
                  autoComplete="new-password"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-form-type="other"
                  spellCheck={false}
                  disabled={!canWrite}
                  value={firebaseDraft.apiKey}
                  onChange={(event) =>
                    setFirebaseDraft({
                      ...firebaseDraft,
                      apiKey: event.target.value,
                    })
                  }
                />
              </label>
              <label className="field">
                App ID
                <input
                  type="text"
                  autoComplete="off"
                  disabled={!canWrite}
                  value={firebaseDraft.appId}
                  onChange={(event) =>
                    setFirebaseDraft({
                      ...firebaseDraft,
                      appId: event.target.value,
                    })
                  }
                />
              </label>
              <label className="field">
                Project ID
                <input
                  type="text"
                  autoComplete="off"
                  disabled={!canWrite}
                  value={firebaseDraft.projectId}
                  onChange={(event) =>
                    setFirebaseDraft({
                      ...firebaseDraft,
                      projectId: event.target.value,
                    })
                  }
                />
              </label>
              <label className="field">
                Sender ID
                <input
                  type="text"
                  autoComplete="off"
                  inputMode="numeric"
                  disabled={!canWrite}
                  value={firebaseDraft.senderId}
                  onChange={(event) =>
                    setFirebaseDraft({
                      ...firebaseDraft,
                      senderId: event.target.value,
                    })
                  }
                />
              </label>
            </div>
            <div className="form-actions">
              <button
                className="btn primary"
                disabled={!canWrite}
                onClick={() => void saveFirebaseSetup()}
              >
                <Save size={14} /> Save Firebase setup
              </button>
              <button
                className="btn secondary danger-action"
                disabled={!canWrite}
                onClick={() => void deleteSetup("firebase")}
              >
                <Trash2 size={14} /> Delete setup
              </button>
            </div>
          </Card>

          <Card>
            <div className="section-head">
              <h2>
                <Send size={19} /> News & delivery operations
              </h2>
              <span className="mono muted">PROTECTED NEWS API</span>
            </div>
            <p className="help">
              Requests owner-authenticated Controller API ke through jaati hain.
              APP_SECRET browser payload mein nahi jaata.
            </p>
            <div className="operation-grid">
              {OPERATIONS.map(({ operation, label, icon: Icon, success }) => (
                <button
                  className="btn secondary operation-button"
                  key={operation}
                  disabled={!canWrite}
                  onClick={() => void runOperation(operation, success)}
                >
                  <Icon size={15} />{" "}
                  {pending === `operation:${operation}` ? "Sending…" : label}
                </button>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
