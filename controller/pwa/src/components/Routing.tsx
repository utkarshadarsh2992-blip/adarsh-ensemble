import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";
import { routeError, type Config } from "../domain";
import { Dialog } from "./ui";

type Props = {
  config: Config;
  onChange: (c: Config) => void;
  editable: boolean;
};
const MODES = [
  "standard",
  "verified",
  "physics",
  "math",
  "business",
  "coding",
] as const;
const ROLES = [
  "architect",
  "theorist",
  "empiricist",
  "specialist",
  "pattern",
  "skeptic",
  "debater",
  "judge",
  "method",
  "evidence",
  "refiner",
  "verifier",
  "falsifier1",
  "falsifier2",
  "falsifier3",
] as const;
const UTILITIES = [
  "quick",
  "auditor",
  "master_writer",
  "master_auditor",
  "classifier",
  "stripper",
  "verifier",
  "judge",
  "synthesizer",
  "guard_llm",
] as const;
type RouteOption = { key: string; title: string; group: string };
const ROUTE_OPTIONS: RouteOption[] = [
  ...MODES.flatMap((mode) =>
    ROLES.map((role) => ({
      key: `mode:${mode}:${role}`,
      title: `${mode[0].toUpperCase()}${mode.slice(1)} · ${role}`,
      group: "Mode roles",
    })),
  ),
  ...UTILITIES.map((name) => ({
    key: `utility:${name}`,
    title: `Utility · ${name.replaceAll("_", " ")}`,
    group: "Utility",
  })),
];

function byGroup(options: RouteOption[]) {
  return ["Mode roles", "Utility"]
    .map((group) => ({
      group,
      options: options.filter((option) => option.group === group),
    }))
    .filter((item) => item.options.length);
}

export default function Routing({ config, onChange, editable }: Props) {
  const [newRoute, setNewRoute] = useState("");
  const [showReset, setShowReset] = useState<string | null>(null);
  const enabled = useMemo(
    () => config.models.filter((model) => model.enabled),
    [config.models],
  );
  const entries = ROUTE_OPTIONS.filter((option) =>
    Object.hasOwn(config.routes, option.key),
  );
  const available = ROUTE_OPTIONS.filter(
    (option) => !Object.hasOwn(config.routes, option.key),
  );

  function stageChain(key: string, chain: string[]) {
    if (!editable) return;
    onChange({ ...config, routes: { ...config.routes, [key]: chain } });
  }
  function resetOverride(key: string) {
    if (!editable) return;
    const routes = { ...config.routes };
    delete routes[key];
    onChange({ ...config, routes });
    setShowReset(null);
  }
  function addOverride() {
    if (!editable || !newRoute) return;
    onChange({ ...config, routes: { ...config.routes, [newRoute]: [] } });
    setNewRoute("");
  }
  function move(key: string, chain: string[], index: number, offset: number) {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= chain.length) return;
    const next = [...chain];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    stageChain(key, next);
  }

  return (
    <section className="page-module">
      <div className="toolbar">
        <div>
          <h1 className="page-title">Routing</h1>
          <p className="muted">
            Sirf explicit overrides dikh rahe hain. Missing override par bundled
            fallback runtime mein current registry se resolve hota hai; bundled
            chain yahan assume/display nahi ki jaati.
          </p>
        </div>
      </div>
      <div className="warning">
        <strong>Validation:</strong> Har role/utility chain mein enabled models
        chahiye. Bundled routes ke provider-coverage/fallback invariants retain
        karne hain. Direct Standard chat sirf Groq use karta hai: uske models
        <code> utility:quick </code> ke Groq entries se select hote hain.
        <code> mode:standard:* </code> council-role routes alag hain; unhe
        badalne se direct Standard multi-provider nahi banega.
      </div>
      {available.length > 0 && (
        <details className="card">
          <summary>
            Bundled fallback · {available.length} supported routes without an
            explicit override
          </summary>
          <p className="help">
            In keys par koi override nahi hai. Runtime current registry se
            bundled chain resolve karta hai; yahan us chain ka order assume nahi
            hota.
          </p>
          {byGroup(available).map((group) => (
            <section key={group.group}>
              <h3>{group.group}</h3>
              <div className="grid">
                {group.options.map((option) => (
                  <div className="row" key={option.key}>
                    <span>{option.title}</span>
                    <span className="badge">Bundled fallback</span>
                    <span className="mono muted">{option.key}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </details>
      )}
      {editable && (
        <section className="card">
          <h2>Override add karo</h2>
          <p className="help">
            Supported contract keys mein se select karo. Existing key ki jagah
            bundled fallback use hota hai.
          </p>
          <div className="toolbar">
            <label className="field">
              <span className="sr-only">Supported route key</span>
              <select
                value={newRoute}
                onChange={(e) => setNewRoute(e.target.value)}
              >
                <option value="">Supported route choose karo</option>
                {byGroup(available).map((group) => (
                  <optgroup key={group.group} label={group.group}>
                    {group.options.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.title} · Bundled fallback
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <button
              className="btn primary"
              disabled={!newRoute}
              onClick={addOverride}
            >
              <Plus size={16} /> Override add
            </button>
          </div>
        </section>
      )}
      {entries.length === 0 ? (
        <div className="empty">
          <h2>Koi explicit override nahi</h2>
          <p>
            App ke bundled fallback defaults as-is rahenge. Koi bundled route ya
            model chain fabricate nahi ki gayi.
          </p>
        </div>
      ) : (
        <div className="grid">
          {entries.map((option) => {
            const chain = config.routes[option.key] ?? [];
            const issue = routeError(option.key, chain, config);
            const remaining = enabled.filter(
              (model) => !chain.includes(model.label),
            );
            return (
              <section className="card" key={option.key}>
                <div className="toolbar">
                  <div>
                    <h2>{option.title}</h2>
                    <div className="mono muted">{option.key}</div>
                  </div>
                  {editable && (
                    <button
                      className="text-btn"
                      onClick={() => setShowReset(option.key)}
                    >
                      <RotateCcw size={15} /> Bundled default par wapas
                    </button>
                  )}
                </div>
                <div className="help">
                  Order = primary se fallback sequence. Disabled model is chain
                  mein valid nahi hai.
                </div>
                {chain.length === 0 ? (
                  <div className="warning">
                    Override draft empty hai—chain mein 1–10 unique enabled
                    model chahiye.
                  </div>
                ) : (
                  <ol className="grid">
                    {chain.map((label, index) => {
                      const model = config.models.find(
                        (item) => item.label === label,
                      );
                      return (
                        <li className="row" key={`${label}-${index}`}>
                          <span className="badge">
                            {index === 0 ? "Primary" : `Fallback ${index}`}
                          </span>
                          <label className="field">
                            <span className="sr-only">
                              Chain position {index + 1}
                            </span>
                            <select
                              disabled={!editable}
                              value={label}
                              onChange={(e) =>
                                stageChain(
                                  option.key,
                                  chain.map((value, i) =>
                                    i === index ? e.target.value : value,
                                  ),
                                )
                              }
                            >
                              <option value={label}>
                                {label}
                                {model
                                  ? ` · ${model.provider}${model.enabled ? "" : " · disabled"}`
                                  : " · missing registry entry"}
                              </option>
                              {remaining
                                .filter((item) => item.label !== label)
                                .map((item) => (
                                  <option key={item.label} value={item.label}>
                                    {item.label} · {item.provider}
                                  </option>
                                ))}
                            </select>
                          </label>
                          {editable && (
                            <div className="toolbar">
                              <button
                                className="btn secondary"
                                aria-label={`Move ${label} up`}
                                disabled={index === 0}
                                onClick={() =>
                                  move(option.key, chain, index, -1)
                                }
                              >
                                <ArrowUp size={15} />
                              </button>
                              <button
                                className="btn secondary"
                                aria-label={`Move ${label} down`}
                                disabled={index === chain.length - 1}
                                onClick={() =>
                                  move(option.key, chain, index, 1)
                                }
                              >
                                <ArrowDown size={15} />
                              </button>
                              <button
                                className="btn secondary"
                                aria-label={`Remove ${label}`}
                                onClick={() =>
                                  stageChain(
                                    option.key,
                                    chain.filter((_, i) => i !== index),
                                  )
                                }
                              >
                                <Trash2 size={15} />
                              </button>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
                {editable && chain.length < 10 && (
                  <label className="field">
                    Chain mein model add karo
                    <select
                      value=""
                      onChange={(e) => {
                        if (e.target.value)
                          stageChain(option.key, [...chain, e.target.value]);
                      }}
                    >
                      <option value="">Enabled unique model choose karo</option>
                      {remaining.map((model) => (
                        <option key={model.label} value={model.label}>
                          {model.label} · {model.provider}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {issue && (
                  <p className="warning" role="alert">
                    {issue}
                  </p>
                )}
              </section>
            );
          })}
        </div>
      )}
      {Object.keys(config.routes).some(
        (key) => !ROUTE_OPTIONS.some((option) => option.key === key),
      ) && (
        <section className="card">
          <h2>Unsupported stored route keys</h2>
          <p className="warning">
            Contract mein nahi hone wale keys is editor mein modify nahi kiye
            jaate; existing draft data preserve hai.
          </p>
          <ul>
            {Object.keys(config.routes)
              .filter(
                (key) => !ROUTE_OPTIONS.some((option) => option.key === key),
              )
              .map((key) => (
                <li className="mono" key={key}>
                  {key}
                </li>
              ))}
          </ul>
        </section>
      )}
      {showReset && (
        <Dialog
          title="Bundled default par reset"
          onClose={() => setShowReset(null)}
        >
          <p>
            <strong>
              {ROUTE_OPTIONS.find((option) => option.key === showReset)
                ?.title ?? showReset}
            </strong>{" "}
            ka explicit override draft se delete hoga. Parent Save se pehle
            change local draft hi rahega; default chain yahan display nahi hoti.
          </p>
          <div className="form-actions">
            <button
              className="btn secondary"
              onClick={() => setShowReset(null)}
            >
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() => resetOverride(showReset)}
            >
              Override hatao
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
