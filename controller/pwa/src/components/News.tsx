import { useCallback, useEffect, useMemo, useState } from "react";
import { Newspaper, BellRing, Save, RefreshCw } from "lucide-react";
import { admin } from "../api";
import { number } from "../domain";
import { Card, Empty, Badge } from "./ui";

type Limits = {
  alerts_per_day: number;
  alert_min_score: number;
  list_min_score: number;
  groq_tokens_cap: number;
  groq_calls_cap: number;
  tavily_day_cap: number;
  tavily_month_cap: number;
};
type UsageRow = {
  day: string;
  provider: string;
  model: string;
  stage: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
};
type NewsState = {
  ok: true;
  local_day: string;
  tz: string;
  settings: Limits;
  budget: {
    day: string;
    groq: { tokens_used: number; tokens_cap: number; calls_used: number; calls_cap: number; state: string };
    tavily: { day_used: number; day_cap: number; month_used: number; month_cap: number };
    alerts: { today: number; cap: number };
  };
  usage: UsageRow[];
  alerts: { day: string; alerts: number; telegram: number; fcm: number }[];
};

const FIELDS: { key: keyof Limits; label: string; hint: string; min: number; max: number }[] = [
  { key: "alerts_per_day", label: "Notifications / day", hint: "0 = push alert band", min: 0, max: 10 },
  { key: "alert_min_score", label: "Alert min score", hint: "1-10, 3 alerts ke baad +1", min: 1, max: 10 },
  { key: "list_min_score", label: "App list min score", hint: "1-10", min: 1, max: 10 },
  { key: "tavily_day_cap", label: "Tavily credits / day", hint: "1 verify = 2 credits, 0 = band", min: 0, max: 1000 },
  { key: "tavily_month_cap", label: "Tavily credits / month", hint: "monthly safety stop", min: 2, max: 100000 },
  { key: "groq_tokens_cap", label: "Groq tokens / day", hint: "news scoring + review", min: 1000, max: 10000000 },
  { key: "groq_calls_cap", label: "Groq calls / day", hint: "news scoring + review", min: 1, max: 100000 },
];

function pct(used: number, cap: number) {
  return cap > 0 ? Math.min(100, (used / cap) * 100) : 100;
}
function Meter({ label, used, cap, unit }: { label: string; used: number; cap: number; unit: string }) {
  return (
    <Card>
      <div className="metric-label">{label}</div>
      <strong>{number(used)}</strong>
      <small>
        {cap > 0 ? `of ${number(cap)} ${unit} · ${number(Math.max(0, cap - used))} left` : `cap 0 · band`}
      </small>
      <div className="usage-bar">
        <i style={{ width: `${pct(used, cap)}%` }} />
      </div>
    </Card>
  );
}

export default function News({
  active,
  online,
  onError,
  onNotice,
}: {
  active: boolean;
  online: boolean;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
}) {
  const [data, setData] = useState<NewsState | null>(null);
  const [draft, setDraft] = useState<Partial<Record<keyof Limits, string>>>({});
  const [busy, setBusy] = useState(false);
  const [day, setDay] = useState("");
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await admin<NewsState>({ action: "news_state" });
      setData(r);
      setDraft({});
      setDay((d) => d || r.budget.day);
    } catch (e) {
      onError(e instanceof Error ? e.message : "News data load nahi hua.");
    } finally {
      setBusy(false);
    }
  }, [onError]);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const days = useMemo(
    () => [...new Set((data?.usage ?? []).map((u) => u.day))].sort().reverse(),
    [data],
  );
  const rows = (data?.usage ?? []).filter((u) => u.day === day);
  const perDay = useMemo(() => {
    const m = new Map<string, { groq: number; tavily: number }>();
    for (const u of data?.usage ?? []) {
      const s = m.get(u.day) ?? { groq: 0, tavily: 0 };
      if (u.provider === "tavily") s.tavily += u.tokens_in;
      else s.groq += u.tokens_in + u.tokens_out;
      m.set(u.day, s);
    }
    return [...m.entries()].sort().slice(-7);
  }, [data]);
  const maxTok = Math.max(1, ...perDay.map(([, v]) => v.groq));

  const changed = FIELDS.filter((f) => {
    const raw = draft[f.key];
    return raw !== undefined && raw !== "" && Number(raw) !== data?.settings[f.key];
  });
  async function save() {
    const settings: Record<string, number> = {};
    for (const f of changed) {
      const v = Number(draft[f.key]);
      if (!Number.isSafeInteger(v) || v < f.min || v > f.max) {
        onError(`${f.label}: ${f.min} se ${f.max} ke beech chahiye.`);
        return;
      }
      settings[f.key] = v;
    }
    setBusy(true);
    try {
      await admin({ action: "news_settings", settings });
      onNotice("News limits save ho gayi. Agle cron run se lagu.");
      await load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Limits save nahi hui.");
      setBusy(false);
    }
  }

  const b = data?.budget;
  return (
    <>
      <div className="page-title">
        <div className="eyebrow">CONTROL PLANE / 06</div>
        <h1>
          News & alerts<span className="orange">.</span>
        </h1>
        <p>Groq aur Tavily ka news use, notification limit, sab yahin se.</p>
      </div>
      <div className="toolbar">
        <button className="btn secondary" disabled={busy || !online} onClick={() => void load()}>
          <RefreshCw size={15} /> {busy ? "Loading…" : "Refresh"}
        </button>
        {data && <Badge>{data.local_day} · {data.tz}</Badge>}
        {b && <Badge tone={b.groq.state === "ok" ? "success" : "warning"}>Groq {b.groq.state}</Badge>}
      </div>
      {!data || !b ? (
        <Card>
          <Empty title="News data abhi nahi aaya">
            Owner login ke baad Refresh dabao. Backend naya deploy hona chahiye.
          </Empty>
        </Card>
      ) : (
        <>
          <div className="metrics usage-metrics">
            <Meter label="Notifications today" used={b.alerts.today} cap={b.alerts.cap} unit="alerts" />
            <Meter label="Tavily credits / day (UTC)" used={b.tavily.day_used} cap={b.tavily.day_cap} unit="credits" />
            <Meter label="Tavily credits / month" used={b.tavily.month_used} cap={b.tavily.month_cap} unit="credits" />
            <Meter label="Groq tokens today" used={b.groq.tokens_used} cap={b.groq.tokens_cap} unit="tokens" />
            <Meter label="Groq calls today" used={b.groq.calls_used} cap={b.groq.calls_cap} unit="calls" />
          </div>
          <Card>
            <div className="section-head">
              <h2>
                <BellRing size={19} /> Limits
              </h2>
              <span className="mono muted">NEWS BACKEND</span>
            </div>
            <p className="help">
              Notification limit poore din ke alerts rokti hai (Telegram + app, ek alert ek ginti). Tavily quota
              khatam hone par news score hoti rehti hai par verify nahi hoti, isliye naye alert band rehte hain.
            </p>
            {FIELDS.map((f) => (
              <div className="setting-row" key={f.key}>
                <div>
                  <h3>{f.label}</h3>
                  <p>{f.hint}</p>
                </div>
                <label className="field">
                  Value
                  <input
                    className="cap-input"
                    aria-label={f.label}
                    type="number"
                    min={f.min}
                    max={f.max}
                    disabled={busy || !online}
                    value={draft[f.key] ?? String(data.settings[f.key])}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  />
                </label>
              </div>
            ))}
            <div className="form-actions">
              <button className="btn primary" disabled={!changed.length || busy || !online} onClick={() => void save()}>
                <Save size={15} /> Save {changed.length ? `(${changed.length})` : ""}
              </button>
            </div>
          </Card>
          <Card>
            <div className="section-head">
              <h2>
                <Newspaper size={19} /> Recent Groq tokens
              </h2>
              <span className="mono muted">UTC / 7 DAYS</span>
            </div>
            {perDay.length ? (
              <div className="chart">
                {perDay.map(([d, v]) => (
                  <button
                    key={d}
                    className={`chart-col ${d === day ? "selected" : ""}`}
                    onClick={() => setDay(d)}
                    aria-label={`${d}: ${number(v.groq)} Groq tokens, ${number(v.tavily)} Tavily credits`}
                  >
                    <small>{number(v.groq)}</small>
                    <span style={{ height: `${Math.max(3, (v.groq / maxTok) * 120)}px` }} />
                    <label>{d.slice(5)}</label>
                  </button>
                ))}
              </div>
            ) : (
              <p className="help">Abhi koi news AI use record nahi hua.</p>
            )}
          </Card>
          <Card>
            <div className="section-head">
              <h2>Model / provider use</h2>
              <select aria-label="News usage day" value={day} onChange={(e) => setDay(e.target.value)}>
                {[...new Set([data.budget.day, ...days])].map((d) => (
                  <option key={d} value={d}>
                    {d} · UTC
                  </option>
                ))}
              </select>
            </div>
            {rows.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Model</th>
                      <th>Stage</th>
                      <th>Calls</th>
                      <th>Tokens in</th>
                      <th>Tokens out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((u) => (
                      <tr key={`${u.provider}-${u.model}-${u.stage}`}>
                        <td>{u.provider}</td>
                        <td className="mono">{u.model}</td>
                        <td>{u.stage}</td>
                        <td>{number(u.calls)}</td>
                        <td>{number(u.tokens_in)}{u.provider === "tavily" ? " credits" : ""}</td>
                        <td>{u.provider === "tavily" ? "-" : number(u.tokens_out)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="help">Is din ka koi news use record nahi.</p>
            )}
          </Card>
          <Card>
            <div className="section-head">
              <h2>Alerts bheje gaye</h2>
              <span className="mono muted">LAST 7 DAYS</span>
            </div>
            {data.alerts.length ? (
              data.alerts.map((a) => (
                <div className="model-usage-row" key={a.day}>
                  <code>{a.day}</code>
                  <span>
                    {a.alerts} alerts · Telegram {a.telegram} · App {a.fcm}
                  </span>
                </div>
              ))
            ) : (
              <p className="help">Abhi tak koi alert nahi gaya.</p>
            )}
          </Card>
        </>
      )}
    </>
  );
}
