import { useMemo, useState, type FormEvent } from "react";
import {
  Check,
  ChevronDown,
  Edit3,
  Globe2,
  Plus,
  Search,
  Trash2,
  Power,
  X,
} from "lucide-react";
import {
  detachModelFromRoutes,
  endpointError,
  HOSTS,
  modelError,
  NAMES,
  PROVIDERS,
  type Config,
  type Model,
  type Provider,
} from "../domain";
import defaultRoutes from "../default-routes.json";
import { Dialog } from "./ui";

type Props = {
  config: Config;
  onChange: (c: Config) => void;
  editable: boolean;
};
type ModelDraft = {
  label: string;
  provider: Provider;
  model: string;
  reasoning_effort: string;
  reasoning_format: string;
};
type ConfirmAction = { label: string; action: "enable" | "disable" | "remove" };
const EXTRA_EFFORT = ["low", "medium", "high"] as const;
const EXTRA_FORMAT = ["hidden", "raw", "parsed"] as const;

function routeTitle(key: string): string {
  if (key.startsWith("utility:"))
    return `Utility · ${key.slice("utility:".length).replaceAll("_", " ")}`;
  if (key.startsWith("mode:")) {
    const [, mode, role] = key.split(":");
    return `${mode?.[0]?.toUpperCase()}${mode?.slice(1)} · ${role}`;
  }
  return key;
}

function draftFrom(model?: Model): ModelDraft {
  return {
    label: model?.label ?? "",
    provider: model?.provider ?? "groq",
    model: model?.model ?? "",
    reasoning_effort: model?.extra.reasoning_effort ?? "",
    reasoning_format: model?.extra.reasoning_format ?? "",
  };
}

export default function Models({ config, onChange, editable }: Props) {
  const [providerFilter, setProviderFilter] = useState<Provider | "all">("all");
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<"cards" | "table">("cards");
  const [draft, setDraft] = useState<ModelDraft | null>(null);
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [modelIssue, setModelIssue] = useState("");
  const [endpointProvider, setEndpointProvider] = useState<Provider | null>(
    null,
  );
  const [endpointRaw, setEndpointRaw] = useState("");
  const [endpointIssue, setEndpointIssue] = useState("");
  const [endpointConfirm, setEndpointConfirm] = useState(false);
  const [pendingAction, setPendingAction] = useState<ConfirmAction | null>(
    null,
  );
  const [detachIssue, setDetachIssue] = useState("");

  const visibleModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return config.models.filter(
      (model) =>
        (providerFilter === "all" || model.provider === providerFilter) &&
        (!needle ||
          `${model.label} ${model.model} ${NAMES[model.provider]}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [config.models, providerFilter, query]);

  const routeReferences = (label: string) => {
    const refs: string[] = [];
    for (const [key, bundled] of Object.entries(defaultRoutes)) {
      const isOverride = Object.hasOwn(config.routes, key);
      const effective = isOverride ? config.routes[key] : bundled;
      if (effective.includes(label))
        refs.push(
          `${isOverride ? "Override" : "Bundled"} · ${routeTitle(key)}`,
        );
    }
    for (const [key, labels] of Object.entries(config.routes)) {
      if (!Object.hasOwn(defaultRoutes, key) && labels.includes(label))
        refs.push(`Override · ${routeTitle(key)}`);
    }
    return refs;
  };

  function openModelEditor(model?: Model) {
    if (!editable) return;
    setEditingLabel(model?.label ?? null);
    setDraft(draftFrom(model));
    setModelIssue("");
  }

  function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || !draft) return;
    const candidate: Model = {
      label: draft.label.trim(),
      provider: draft.provider,
      model: draft.model.trim(),
      enabled: editingLabel
        ? (config.models.find((m) => m.label === editingLabel)?.enabled ?? true)
        : true,
      extra: {
        ...(draft.reasoning_effort
          ? { reasoning_effort: draft.reasoning_effort }
          : {}),
        ...(draft.reasoning_format
          ? { reasoning_format: draft.reasoning_format }
          : {}),
      },
    };
    const issue =
      modelError(candidate) ??
      (config.models.some(
        (m) => m.label === candidate.label && m.label !== editingLabel,
      )
        ? "Yeh label pehle se registry mein hai."
        : null) ??
      (!editingLabel && config.models.length >= 100
        ? "Registry limit 100 models hai."
        : null);
    if (issue) {
      setModelIssue(issue);
      return;
    }

    let models: Model[];
    let routes = config.routes;
    if (editingLabel) {
      models = config.models.map((m) =>
        m.label === editingLabel ? candidate : m,
      );
      if (editingLabel !== candidate.label) {
        const renamed = Object.fromEntries(
          Object.entries(config.routes).map(([key, labels]) => [
            key,
            labels.map((label) =>
              label === editingLabel ? candidate.label : label,
            ),
          ]),
        );
        for (const [key, bundled] of Object.entries(defaultRoutes)) {
          const active = Object.hasOwn(config.routes, key)
            ? config.routes[key]
            : bundled;
          if (active.includes(editingLabel))
            renamed[key] = active.map((label) =>
              label === editingLabel ? candidate.label : label,
            );
        }
        routes = renamed;
      }
    } else models = [...config.models, candidate];
    onChange({ ...config, models, routes });
    setDraft(null);
    setEditingLabel(null);
  }

  function openEndpoint(provider: Provider) {
    if (!editable) return;
    setEndpointProvider(provider);
    setEndpointRaw(config.providers[provider].base_url);
    setEndpointIssue("");
    setEndpointConfirm(false);
  }

  function reviewEndpoint(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable || !endpointProvider) return;
    const issue = endpointError(endpointProvider, endpointRaw.trim());
    if (issue) {
      setEndpointIssue(issue);
      setEndpointConfirm(false);
      return;
    }
    setEndpointIssue("");
    setEndpointConfirm(true);
  }

  function stageEndpoint() {
    if (
      !editable ||
      !endpointProvider ||
      endpointError(endpointProvider, endpointRaw.trim())
    )
      return;
    onChange({
      ...config,
      providers: {
        ...config.providers,
        [endpointProvider]: { base_url: endpointRaw.trim() },
      },
    });
    setEndpointProvider(null);
    setEndpointConfirm(false);
  }

  function confirmModelAction(detach = false) {
    if (!editable || !pendingAction) return;
    const { label, action } = pendingAction;
    const model = config.models.find((m) => m.label === label);
    if (!model) {
      setPendingAction(null);
      return;
    }
    const refs = routeReferences(label);
    if ((action === "remove" || action === "disable") && refs.length) {
      if (!detach) return;
      // One step: take the model out of every route that uses it, then remove/disable it.
      const result = detachModelFromRoutes(
        config,
        defaultRoutes as Record<string, string[]>,
        label,
      );
      if (!result.ok) {
        setDetachIssue(result.error);
        return;
      }
      onChange({
        ...config,
        routes: result.routes,
        models:
          action === "remove"
            ? config.models.filter((m) => m.label !== label)
            : config.models.map((m) =>
                m.label === label ? { ...m, enabled: false } : m,
              ),
      });
      setDetachIssue("");
      setPendingAction(null);
      return;
    }
    if (action === "remove")
      onChange({
        ...config,
        models: config.models.filter((m) => m.label !== label),
      });
    else
      onChange({
        ...config,
        models: config.models.map((m) =>
          m.label === label ? { ...m, enabled: action === "enable" } : m,
        ),
      });
    setPendingAction(null);
  }

  return (
    <section className="page-module">
      <div className="toolbar">
        <div>
          <h1 className="page-title">Models &amp; providers</h1>
          <p className="muted">
            Registry ke labels, provider IDs aur HTTPS endpoints manage karo.
            Changes draft mein rahenge.
          </p>
        </div>
        {editable && (
          <button className="btn primary" onClick={() => openModelEditor()}>
            <Plus size={16} /> Model add karo
          </button>
        )}
      </div>

      <section className="card">
        <div className="toolbar">
          <div>
            <h2>Provider endpoints</h2>
            <p className="help">
              Sirf fixed provider host par HTTPS base URL supported hai. Custom
              protocol, arbitrary host, headers ya API keys nahi.
            </p>
          </div>
        </div>
        <div className="grid">
          {PROVIDERS.map((provider) => (
            <article className="row" key={provider}>
              <div>
                <strong>{NAMES[provider]}</strong>
                <div className="mono muted">{HOSTS[provider]}</div>
                <div className="mono">
                  {config.providers[provider].base_url}
                </div>
              </div>
              {editable && (
                <button
                  className="btn secondary"
                  onClick={() => openEndpoint(provider)}
                >
                  <Globe2 size={15} /> Endpoint edit
                </button>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="toolbar">
          <div>
            <h2>
              Model registry{" "}
              <span className="badge">{config.models.length}</span>
            </h2>
            <p className="muted">
              Sirf yahan listed provider models routing mein select ho sakte
              hain.
            </p>
          </div>
          <div className="toolbar">
            <label className="field">
              <Search size={16} />
              <span className="sr-only">Model search</span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Label, model ID search"
              />
            </label>
            <label className="field">
              <span className="sr-only">Provider filter</span>
              <select
                value={providerFilter}
                onChange={(e) =>
                  setProviderFilter(e.target.value as Provider | "all")
                }
              >
                <option value="all">Sab providers</option>
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {NAMES[p]}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </label>
            <div className="toolbar" role="group" aria-label="Registry layout">
              <button
                className={`btn ${layout === "cards" ? "primary" : "secondary"}`}
                onClick={() => setLayout("cards")}
              >
                Cards
              </button>
              <button
                className={`btn ${layout === "table" ? "primary" : "secondary"}`}
                onClick={() => setLayout("table")}
              >
                Table
              </button>
            </div>
          </div>
        </div>
        {visibleModels.length === 0 ? (
          <div className="empty">
            <h3>
              {config.models.length
                ? "Koi matching model nahi"
                : "Registry khaali hai"}
            </h3>
            <p>
              Search/filter badlo ya permitted model ID ke saath model add karo.
            </p>
          </div>
        ) : layout === "cards" ? (
          <div className="grid">
            {visibleModels.map((model) => {
              const refs = routeReferences(model.label);
              return (
                <article className="model-card" key={model.label}>
                  <div className="toolbar">
                    <div>
                      <h3>{model.label}</h3>
                      <span
                        className={`badge ${model.enabled ? "success" : "muted"}`}
                      >
                        {model.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </div>
                    <span className="badge">{NAMES[model.provider]}</span>
                  </div>
                  <p className="mono">{model.model}</p>
                  <div className="help">
                    {Object.keys(model.extra).length
                      ? Object.entries(model.extra).map(([key, value]) => (
                          <span className="badge" key={key}>
                            {key}: {value}
                          </span>
                        ))
                      : "No reasoning extras"}
                  </div>
                  {refs.length > 0 && (
                    <p className="warning">
                      Active route references: {refs.join(" · ")}.
                      Remove/Disable dabane par ye model in routes se apne aap
                      hat jayega.
                    </p>
                  )}
                  {editable && (
                    <div className="form-actions">
                      <button
                        className="btn secondary"
                        onClick={() => openModelEditor(model)}
                      >
                        <Edit3 size={15} /> Edit
                      </button>
                      <button
                        className="btn secondary"
                        onClick={() =>
                          setPendingAction({
                            label: model.label,
                            action: model.enabled ? "disable" : "enable",
                          })
                        }
                      >
                        <Power size={15} />
                        {model.enabled ? "Disable" : "Enable"}
                      </button>
                      <button
                        className="btn secondary"
                        onClick={() =>
                          setPendingAction({
                            label: model.label,
                            action: "remove",
                          })
                        }
                      >
                        <Trash2 size={15} /> Remove
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Provider</th>
                  <th>Provider model ID</th>
                  <th>State</th>
                  <th>Explicit routes</th>
                  {editable && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {visibleModels.map((model) => {
                  const refs = routeReferences(model.label);
                  return (
                    <tr key={model.label}>
                      <td>{model.label}</td>
                      <td>{NAMES[model.provider]}</td>
                      <td className="mono">{model.model}</td>
                      <td>
                        <span className="badge">
                          {model.enabled ? "Enabled" : "Disabled"}
                        </span>
                      </td>
                      <td>{refs.join(" · ") || "—"}</td>
                      {editable && (
                        <td>
                          <div className="form-actions">
                            <button
                              className="text-btn"
                              onClick={() => openModelEditor(model)}
                            >
                              Edit
                            </button>
                            <button
                              className="text-btn"
                              onClick={() =>
                                setPendingAction({
                                  label: model.label,
                                  action: model.enabled ? "disable" : "enable",
                                })
                              }
                            >
                              {model.enabled ? "Disable" : "Enable"}
                            </button>
                            <button
                              className="text-btn"
                              onClick={() =>
                                setPendingAction({
                                  label: model.label,
                                  action: "remove",
                                })
                              }
                            >
                              Remove
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {draft && (
        <Dialog
          title={
            editingLabel
              ? `Model edit · ${editingLabel}`
              : "Registry mein model add karo"
          }
          onClose={() => setDraft(null)}
        >
          <form onSubmit={saveModel}>
            <label className="field">
              Registry label
              <input
                autoFocus
                maxLength={60}
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder="e.g. groq-fast"
                required
              />
            </label>
            <label className="field">
              Provider
              <select
                value={draft.provider}
                onChange={(e) =>
                  setDraft({ ...draft, provider: e.target.value as Provider })
                }
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {NAMES[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Provider model ID
              <input
                maxLength={200}
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                placeholder="Exact provider model ID"
                required
              />
            </label>
            <fieldset>
              <legend>Reasoning extras · optional whitelist</legend>
              <label className="field">
                reasoning_effort
                <select
                  value={draft.reasoning_effort}
                  onChange={(e) =>
                    setDraft({ ...draft, reasoning_effort: e.target.value })
                  }
                >
                  <option value="">Unset</option>
                  {EXTRA_EFFORT.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                reasoning_format
                <select
                  value={draft.reasoning_format}
                  onChange={(e) =>
                    setDraft({ ...draft, reasoning_format: e.target.value })
                  }
                >
                  <option value="">Unset</option>
                  {EXTRA_FORMAT.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
            </fieldset>
            <p className="help">
              Arbitrary tools, custom JSON, headers aur credentials supported
              nahi.{" "}
              {modelIssue && (
                <span role="alert" className="warning">
                  {modelIssue}
                </span>
              )}
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="btn secondary"
                onClick={() => setDraft(null)}
              >
                Cancel
              </button>
              <button className="btn primary" type="submit">
                <Check size={16} /> Draft mein stage
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {endpointProvider && (
        <Dialog
          title={`${NAMES[endpointProvider]} endpoint edit`}
          onClose={() => {
            setEndpointProvider(null);
            setEndpointConfirm(false);
          }}
        >
          {!endpointConfirm ? (
            <form onSubmit={reviewEndpoint}>
              <p className="help">
                Allowed exact host:{" "}
                <strong className="mono">{HOSTS[endpointProvider]}</strong>.
                HTTPS base URL only; path/query/credentials/port restrictions
                apply. Cloudflare URL mein literal{" "}
                <code>{"{CLOUDFLARE_ACCOUNT_ID}"}</code> rakho.
              </p>
              <label className="field">
                Base URL
                <input
                  autoFocus
                  value={endpointRaw}
                  onChange={(e) => {
                    setEndpointRaw(e.target.value);
                    setEndpointIssue("");
                  }}
                  spellCheck={false}
                />
              </label>
              {endpointIssue && (
                <p className="warning" role="alert">
                  {endpointIssue}
                </p>
              )}
              <p className="help">
                Keys kabhi yahan enter/send nahi hote; arbitrary protocol ya
                host supported nahi.
              </p>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => setEndpointProvider(null)}
                >
                  Cancel
                </button>
                <button className="btn primary" type="submit">
                  Host review
                </button>
              </div>
            </form>
          ) : (
            <div>
              <p>
                Is endpoint ko draft config mein stage karna confirm karo.{" "}
                <strong>
                  Host: <span className="mono">{HOSTS[endpointProvider]}</span>
                </strong>
              </p>
              <p className="mono">{endpointRaw.trim()}</p>
              <p className="help">
                Koi key ya request provider ko nahi bheji jayegi.
              </p>
              <div className="form-actions">
                <button
                  className="btn secondary"
                  onClick={() => setEndpointConfirm(false)}
                >
                  <X size={15} /> Wapas edit
                </button>
                <button className="btn primary" onClick={stageEndpoint}>
                  <Check size={15} /> Confirm &amp; stage
                </button>
              </div>
            </div>
          )}
        </Dialog>
      )}

      {pendingAction && (
        <Dialog
          title={`${pendingAction.action === "remove" ? "Model remove" : pendingAction.action === "disable" ? "Model disable" : "Model enable"} confirmation`}
          onClose={() => setPendingAction(null)}
        >
          {(() => {
            const refs = routeReferences(pendingAction.label);
            const blocked =
              refs.length > 0 &&
              (pendingAction.action === "remove" ||
                pendingAction.action === "disable");
            return (
              <>
                <p>
                  <strong>{pendingAction.label}</strong> ke liye{" "}
                  <strong>{pendingAction.action}</strong> action draft mein
                  stage hoga; parent Save ke baad hi persist hoga.
                </p>
                {blocked && (
                  <div className="warning">
                    <p>
                      Ye model in routes mein use ho raha hai. Neeche wala button
                      isse har route se hata dega; jahan chain ka koi zaroori
                      provider (Groq, OpenRouter, Gemini) kam padega wahan
                      same provider ka dusra enabled model jod dega. Save aap
                      khud karoge.
                    </p>
                    <ul>
                      {refs.map((ref) => (
                        <li key={ref}>{ref}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {detachIssue && <p className="error">{detachIssue}</p>}
                <div className="form-actions">
                  <button
                    className="btn secondary"
                    onClick={() => {
                      setDetachIssue("");
                      setPendingAction(null);
                    }}
                  >
                    Cancel
                  </button>
                  {blocked ? (
                    <button
                      className="btn primary"
                      onClick={() => confirmModelAction(true)}
                    >
                      Routes se hata ke {pendingAction.action} karo
                    </button>
                  ) : (
                    <button
                      className="btn primary"
                      onClick={() => confirmModelAction()}
                    >
                      Confirm action
                    </button>
                  )}
                </div>
              </>
            );
          })()}
        </Dialog>
      )}
    </section>
  );
}
