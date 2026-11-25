import {
  ArrowUpRight,
  ArrowRight,
  Cpu,
  ShieldCheck,
  Activity,
  Smartphone,
  CircleHelp,
} from "lucide-react";
import type { Config, State } from "../domain";
import { aggregate, NAMES, PROVIDERS, number } from "../domain";
import { Badge, Card } from "./ui";
export default function Overview({
  state,
  config,
  navigate,
}: {
  state: State | null;
  config: Config;
  navigate: (tab: string) => void;
}) {
  const a = aggregate(state);
  const active = config.models.filter((m) => m.enabled);
  const devices = state?.devices.filter((d) => !d.revoked_at) ?? [];
  return (
    <>
      <div className="page-title">
        <div className="eyebrow">CONTROL PLANE / 01</div>
        <h1>
          System overview<span className="orange">.</span>
        </h1>
        <p>ADARSH ka behavior, ek jagah se.</p>
      </div>
      <section className="hero-panel">
        <div className="hero-content">
          <Badge tone={state ? "good" : "muted"}>
            {state ? "Owner authenticated" : "Owner access required"}
          </Badge>
          <h2>
            Your AI.
            <br />
            Your control.
          </h2>
          <p>
            Model badlo. Safeguards tune karo.
            <br />
            App ka usage dekho — keys share kiye bina.
          </p>
          <button className="btn primary" onClick={() => navigate("models")}>
            Model registry <ArrowUpRight size={17} />
          </button>
        </div>
        <div
          className="architecture"
          aria-label="ADARSH secure connection diagram"
        >
          <div className="orbit-ring" />
          <div className="architecture-center">
            <img src="/icon.svg" alt="" />
            <b>ADARSH</b>
            <span>ENGINE</span>
          </div>
          {PROVIDERS.map((p, i) => (
            <div className={`provider-node node-${i}`} key={p}>
              <span className={`provider-dot ${p}`} />
              <span>{NAMES[p]}</span>
            </div>
          ))}
          <div className="arch-caption">
            <ShieldCheck size={13} /> Keys stay on your device
          </div>
        </div>
        <div className="hero-bottom">
          <span>
            <span className="tiny-dot" />{" "}
            {state ? "Secure config channel" : "Bundled configuration"}
          </span>
          <span className="mono">
            {state
              ? `REV ${String(state.revision).padStart(3, "0")}`
              : "LOCAL / READ-ONLY"}{" "}
            <span className="separator">/</span> 5 PROVIDERS
          </span>
        </div>
      </section>
      <div className="metrics">
        <Card>
          <div className="metric-label">
            Enabled models <Cpu size={16} />
          </div>
          <strong>{number(active.length)}</strong>
          <small>Compatible chat registry</small>
        </Card>
        <Card>
          <div className="metric-label">
            Requests today <Activity size={16} />
          </div>
          <strong>{a.reports.length ? number(a.req) : "—"}</strong>
          <small>
            {a.reports.length
              ? "App-reported · UTC day"
              : "No device report yet"}
          </small>
        </Card>
        <Card>
          <div className="metric-label">
            Tokens today <span className="mono">TK</span>
          </div>
          <strong>{a.reports.length ? number(a.tok) : "—"}</strong>
          <small>Observed usage, not live balance</small>
        </Card>
        <Card>
          <div className="metric-label">
            Paired devices <Smartphone size={16} />
          </div>
          <strong>{state ? devices.length : "—"}</strong>
          <small>
            {devices.length ? "Revocable access" : "Pair an app to see usage"}
          </small>
        </Card>
      </div>
      <div className="overview-lower">
        <Card>
          <div className="section-head">
            <div>
              <div className="eyebrow">PROVIDER NETWORK</div>
              <h2>Five routes. One engine.</h2>
            </div>
            <button
              className="icon-btn"
              aria-label="View providers"
              onClick={() => navigate("models")}
            >
              <ArrowUpRight size={20} />
            </button>
          </div>
          {PROVIDERS.map((p) => (
            <button
              className="provider-row"
              key={p}
              onClick={() => navigate("models")}
            >
              <span className={`provider-avatar ${p}`}>
                {NAMES[p].slice(0, 1)}
              </span>
              <div>
                <b>{NAMES[p]}</b>
                <small>
                  {active.filter((m) => m.provider === p).length} enabled model
                  definitions
                </small>
              </div>
              <span className="provider-protocol mono">OPENAI COMPATIBLE</span>
              <ArrowUpRight size={15} />
            </button>
          ))}
        </Card>
        <div className="quick-rail">
          <Card>
            <ShieldCheck className="orange" size={25} />
            <h2>Trust, with safeguards.</h2>
            <p className="muted">
              Fact-check, grounding aur research ko control karo. Koi setting
              accuracy ki guarantee nahi deti.
            </p>
            <button className="text-btn" onClick={() => navigate("quality")}>
              Quality controls <ArrowRight size={16} />
            </button>
          </Card>
          <Card className="data-boundary">
            <CircleHelp size={20} />
            <h3>No hidden balance claims.</h3>
            <p>
              Available tokens configured cap aur observed usage ka estimate
              hoga. Provider ka official remaining balance alag ho sakta hai.
            </p>
            <button className="text-btn" onClick={() => navigate("usage")}>
              Usage details <ArrowUpRight size={15} />
            </button>
          </Card>
        </div>
      </div>
    </>
  );
}
