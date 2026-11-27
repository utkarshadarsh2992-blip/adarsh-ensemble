import { useState } from "react";
import { BarChart3, Info } from "lucide-react";
import type { State, Config, Provider } from "../domain";
import { aggregate, number, NAMES, PROVIDERS } from "../domain";
import { Card, Empty, Badge } from "./ui";
import KeySlots from "./KeySlots";
export default function Usage({
  state,
  config,
  onChange,
  editable,
}: {
  state: State | null;
  config: Config;
  onChange: (c: Config) => void;
  editable: boolean;
}) {
  const [provider, setProvider] = useState<Provider | "all">("all");
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const a = aggregate(state, day);
  const days = [...new Set(state?.usage.map((u) => u.day_utc) ?? [])]
    .sort()
    .reverse();
  const selected =
    provider === "all"
      ? a.providers
      : a.providers.filter((p) => p.id === provider);
  const history = [...new Set(state?.usage.map((u) => u.day_utc) ?? [])]
    .sort()
    .slice(-7)
    .map((d) => ({ day: d, ...aggregate(state, d) }));
  const max = Math.max(1, ...history.map((h) => h.tok));
  return (
    <>
      <div className="page-title">
        <div className="eyebrow">CONTROL PLANE / 05</div>
        <h1>
          Usage intelligence<span className="orange">.</span>
        </h1>
        <p>App counters. Clear estimates. Zero prompt history.</p>
      </div>
      <div className="notice">
        <Info size={17} />
        <span>
          Report app se sync hone par hi dikhega. Doosre apps/account usage
          ismein nahi aata. Available tokens official provider balance nahi hai.
        </span>
      </div>
      <div className="toolbar">
        <select
          aria-label="Provider usage filter"
          value={provider}
          onChange={(e) => setProvider(e.target.value as Provider | "all")}
        >
          <option value="all">All providers</option>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {NAMES[p]}
            </option>
          ))}
        </select>
        <select
          aria-label="Usage day UTC"
          value={day}
          onChange={(e) => setDay(e.target.value)}
        >
          {[...new Set([new Date().toISOString().slice(0, 10), ...days])]
            .sort()
            .reverse()
            .map((d) => (
              <option key={d} value={d}>
                {d} · UTC
              </option>
            ))}
        </select>
        <Badge>{state?.usage.length ?? 0} snapshots</Badge>
      </div>
      {!a.reports.length ? (
        <Card>
          <Empty title="Abhi usage report nahi aayi">
            ADARSH app pair karo. Existing local history delete nahi hogi; next
            sync par available aggregate days yahan dikhengi.
          </Empty>
        </Card>
      ) : (
        <>
          <div className="metrics usage-metrics">
            <Card>
              <div className="metric-label">Requests / {day}</div>
              <strong>{number(selected.reduce((s, p) => s + p.req, 0))}</strong>
              <small>Counted HTTP attempts</small>
            </Card>
            <Card>
              <div className="metric-label">Tokens / {day}</div>
              <strong>{number(selected.reduce((s, p) => s + p.tok, 0))}</strong>
              <small>Provider-reported tokens where present</small>
            </Card>
            <Card>
              <div className="metric-label">Reporting devices</div>
              <strong>{a.reports.length}</strong>
              <small>One absolute snapshot per day/device</small>
            </Card>
          </div>
          <Card>
            <div className="section-head">
              <h2>
                <BarChart3 size={19} /> Recent token use
              </h2>
              <span className="mono muted">UTC / 7 DAYS</span>
            </div>
            <div className="chart">
              {history.map((h) => (
                <button
                  key={h.day}
                  className={`chart-col ${h.day === day ? "selected" : ""}`}
                  onClick={() => setDay(h.day)}
                  aria-label={`${h.day}: ${number(h.tok)} tokens`}
                >
                  <small>{number(h.tok)}</small>
                  <span
                    style={{ height: `${Math.max(3, (h.tok / max) * 120)}px` }}
                  />
                  <label>{h.day.slice(5)}</label>
                </button>
              ))}
            </div>
          </Card>
          <Card>
            <div className="section-head">
              <h2>Provider totals</h2>
              <span className="mono muted">{day}</span>
            </div>
            {selected.map((p) => {
              const cap = config.limits[p.id]?.daily_tokens;
              return (
                <div key={p.id} className="usage-provider">
                  <div className="section-head">
                    <h3>{p.name}</h3>
                    <span className="mono">
                      {number(p.req)} req / {number(p.tok)} tok
                    </span>
                  </div>
                  <div className="usage-bar">
                    <i
                      style={{
                        width: cap
                          ? `${Math.min(100, (p.tok / cap) * 100)}%`
                          : "0%",
                      }}
                    />
                  </div>
                  <p>
                    {cap
                      ? `${number(Math.max(0, cap - p.tok))} tokens remaining · estimate against configured cap`
                      : "Remaining unknown · configured cap nahi hai"}
                  </p>
                </div>
              );
            })}
          </Card>
          <Card>
            <div className="section-head">
              <h2>15 API key slots / device</h2>
            </div>
            {state?.usage
              .filter((u) => u.day_utc === day)
              .map((u) => (
                <details className="usage-device" key={u.device_id} open>
                  <summary>
                    {state.devices.find((d) => d.id === u.device_id)?.name ??
                      "Paired device"}{" "}
                    <span className="muted mono">
                      {number(u.report.totals.tok)} tokens
                    </span>
                  </summary>
                  <KeySlots report={u.report} provider={provider} />
                </details>
              ))}
          </Card>
        </>
      )}
      <Card>
        <div className="section-head">
          <div>
            <div className="eyebrow">OPTIONAL CAP ESTIMATES</div>
            <h2>Apni daily cap set karo</h2>
          </div>
        </div>
        <p className="help">
          Blank = unknown. Ye controller estimates hain, runtime provider quota
          ya account balance ko change nahi karte. Reported devices combined
          hain.
        </p>
        {PROVIDERS.map((p) => (
          <div className="setting-row" key={p}>
            <div>
              <h3>{NAMES[p]}</h3>
              <p>Observed tokens aur requests ke against estimate</p>
            </div>
            {(["daily_tokens", "daily_requests"] as const).map((field) => (
              <label className="field" key={field}>
                {field === "daily_tokens" ? "Tokens / day" : "Requests / day"}
                <input
                  className="cap-input"
                  aria-label={`${NAMES[p]} estimated ${field} cap`}
                  type="number"
                  min="0"
                  max="1000000000000"
                  placeholder="Unknown"
                  disabled={!editable}
                  value={config.limits[p]?.[field] ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const limit = { ...config.limits[p] };
                    if (!raw) delete limit[field];
                    else {
                      const value = Number(raw);
                      if (
                        !Number.isSafeInteger(value) ||
                        value < 0 ||
                        value > 1000000000000
                      )
                        return;
                      limit[field] = value;
                    }
                    onChange({
                      ...config,
                      limits: { ...config.limits, [p]: limit },
                    });
                  }}
                />
              </label>
            ))}
          </div>
        ))}
      </Card>
    </>
  );
}
