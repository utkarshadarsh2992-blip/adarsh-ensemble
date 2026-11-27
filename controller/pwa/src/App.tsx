import { useEffect, useState, useCallback, useRef } from "react";
import {
  LayoutDashboard,
  Cpu,
  GitBranch,
  ShieldCheck,
  BarChart3,
  Smartphone,
  Newspaper,
  RefreshCw,
  LogIn,
  LogOut,
  ChevronRight,
  Save,
  Menu,
  X,
  ArrowUpRight,
  WifiOff,
  Sun,
  Moon,
  LockKeyhole,
  Check,
} from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import { auth, admin } from "./api";
import type { Config, State } from "./domain";
import bundled from "./bundled.json";
import { mergeStatePage } from "./pagination";
import { Badge, Dialog, Locked } from "./components/ui";
import Login from "./components/Login";
import Overview from "./components/Overview";
import Models from "./components/Models";
import Routing from "./components/Routing";
import Quality from "./components/Quality";
import Usage from "./components/Usage";
import Devices from "./components/Devices";
import News from "./components/News";
const tabs = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "models", label: "Model registry", icon: Cpu },
  { id: "routing", label: "Routing", icon: GitBranch },
  { id: "quality", label: "Quality controls", icon: ShieldCheck },
  { id: "usage", label: "Usage", icon: BarChart3 },
  { id: "news", label: "News & alerts", icon: Newspaper },
  { id: "devices", label: "Devices & changes", icon: Smartphone },
];
const local = bundled as Config;
function initialTab() {
  const hash = window.location.hash.slice(1);
  return tabs.some((t) => t.id === hash) ? hash : "overview";
}
export default function App() {
  const [tab, setTab] = useState(initialTab);
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<Config>(structuredClone(local));
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobile, setMobile] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [online, setOnline] = useState(navigator.onLine);
  const [light, setLight] = useState(
    () => localStorage.getItem("adarsh-controller-theme") === "light",
  );
  const generation = useRef(0);
  const dirty =
    !!state && JSON.stringify(draft) !== JSON.stringify(state.config);
  const editable = !!state && !!session && !busy && online;
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await admin<State>({ action: "state" });
      if (request !== generation.current) return;
      setState(result);
      setDraft(structuredClone(result.config));
    } catch (e) {
      if (request === generation.current)
        setError(e instanceof Error ? e.message : "Sync failed.");
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }, []);
  async function loadMore() {
    if (!state?.next_cursor || busy) return;
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const page = await admin<State>({
        action: "state",
        cursor: state.next_cursor,
      });
      if (request !== generation.current) return;
      setState(mergeStatePage(state, page));
    } catch (e) {
      if (request === generation.current)
        setError(e instanceof Error ? e.message : "Next page load nahi hui.");
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    auth.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    });
    const { data } = auth.auth.onAuthStateChange((_event, s) => {
      if (active) setSession(s);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (session) {
      void refresh();
    } else {
      ++generation.current;
      setState(null);
      setDraft(structuredClone(local));
      setBusy(false);
      setError("");
      setSaveOpen(false);
    }
  }, [session?.user.id, refresh]);
  useEffect(() => {
    const h = () => setTab(initialTab());
    window.addEventListener("hashchange", h);
    const on = () => setOnline(true),
      off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("hashchange", h);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = light ? "light" : "dark";
    localStorage.setItem("adarsh-controller-theme", light ? "light" : "dark");
  }, [light]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!dirty) return;
    const before = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  function navigate(id: string) {
    window.location.hash = id === "overview" ? "" : id;
    setTab(id);
    setMobile(false);
  }
  async function save() {
    if (!state) return;
    setBusy(true);
    setError("");
    try {
      await admin({
        action: "save",
        expected_revision: state.revision,
        config: draft,
        reason: reason.trim() || "Owner updated controller settings",
      });
      setSaveOpen(false);
      setReason("");
      await refresh();
      setNotice(
        "Config save hua. App next successful sync/start par apply karega.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setBusy(false);
    }
  }
  function reload() {
    if (
      dirty &&
      !window.confirm(
        "Unsaved draft discard karke latest config load karna hai?",
      )
    )
      return;
    void refresh();
  }
  const Icon = tabs.find((t) => t.id === tab)?.icon ?? LayoutDashboard;
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobile ? "open" : ""}`}>
        <a
          className="wordmark"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("overview");
          }}
        >
          <img src="/icon.svg" alt="ADARSH mark" />
          <div>
            <b>ADARSH</b>
            <span>CONTROL CENTER</span>
          </div>
          <button
            className="icon-btn mobile-only"
            aria-label="Close menu"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMobile(false);
            }}
          >
            <X size={18} />
          </button>
        </a>
        <div className="sidebar-group mono">
          WORKSPACE <span>01</span>
        </div>
        <nav aria-label="Controller sections">
          {tabs.map((t) => (
            <a
              key={t.id}
              href={t.id === "overview" ? "#" : `#${t.id}`}
              className={`nav-item ${tab === t.id ? "active" : ""}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(t.id);
              }}
              aria-current={tab === t.id ? "page" : undefined}
            >
              <t.icon size={19} />
              <span>{t.label}</span>
              {tab === t.id && <ChevronRight size={15} />}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="secure-card">
            <LockKeyhole size={17} />
            <h3>Owner-only control</h3>
            <p>
              API keys app mein.
              <br />
              Config cloud mein.
            </p>
            <span className="mono">ENCRYPTED DEVICE LINK</span>
          </div>
          <button
            className="account-btn"
            onClick={() =>
              session ? void auth.auth.signOut() : setLogin(true)
            }
          >
            <span className="account-avatar">
              {session ? "A" : <LogIn size={17} />}
            </span>
            <div>
              <b>{session ? "Owner account" : "Owner login"}</b>
              <small>
                {session
                  ? "Supabase authenticated"
                  : "Connect your control plane"}
              </small>
            </div>
            {session ? <LogOut size={15} /> : <ArrowUpRight size={16} />}
          </button>
        </div>
      </aside>
      {mobile && (
        <div className="mobile-scrim" onClick={() => setMobile(false)} />
      )}
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-btn mobile-only"
              aria-label="Open menu"
              onClick={() => setMobile(true)}
            >
              <Menu size={20} />
            </button>
            <span className="desktop-only">Workspace</span>
            <ChevronRight size={13} className="desktop-only" />
            <Icon size={15} />
            <b>{tabs.find((t) => t.id === tab)?.label}</b>
          </div>
          <div className="topbar-actions">
            <Badge tone={!online ? "bad" : state ? "good" : "muted"}>
              {!online ? "Offline" : state ? "Connected" : "Not paired"}
            </Badge>
            <button
              className="icon-btn"
              aria-label={light ? "Use dark theme" : "Use light theme"}
              onClick={() => setLight(!light)}
            >
              {light ? <Moon size={18} /> : <Sun size={18} />}
            </button>
            <button
              className={`icon-btn ${busy ? "spin" : ""}`}
              disabled={!session || busy || !online}
              aria-label="Refresh controller state"
              onClick={reload}
            >
              <RefreshCw size={17} />
            </button>
          </div>
        </header>
        <main>
          {!state && <Locked onLogin={() => setLogin(true)} />}{" "}
          {!online && (
            <div className="notice warning">
              <WifiOff size={17} /> Offline · changes save nahi hongi. App apni
              last-known-good config use karega.
            </div>
          )}
          {error && (
            <div className="error alert" role="alert">
              <span>{error}</span>
              <button
                className="icon-btn"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="success alert" role="status">
              <Check size={17} />
              {notice}
            </div>
          )}
          {state?.next_cursor && (
            <div className="notice warning" role="status">
              <span>
                Report partial hai: aur devices, usage ya change history baaki
                hai. Totals sirf loaded snapshots ke hain.
              </span>
              <button
                className="btn secondary"
                disabled={busy || !online}
                onClick={() => void loadMore()}
              >
                {busy ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
          {tab === "overview" && (
            <Overview state={state} config={draft} navigate={navigate} />
          )}{" "}
          {tab === "models" && (
            <Models config={draft} onChange={setDraft} editable={editable} />
          )}{" "}
          {tab === "routing" && (
            <Routing config={draft} onChange={setDraft} editable={editable} />
          )}{" "}
          {tab === "quality" && (
            <Quality config={draft} onChange={setDraft} editable={editable} />
          )}{" "}
          {tab === "usage" && (
            <Usage
              state={state}
              config={draft}
              onChange={setDraft}
              editable={editable}
            />
          )}{" "}
          {tab === "news" &&
            (session ? (
              <News
                active
                online={online}
                onError={setError}
                onNotice={setNotice}
              />
            ) : (
              <Locked onLogin={() => setLogin(true)} />
            ))}
          {tab === "devices" && (
            <Devices
              state={state}
              editable={editable && !dirty}
              onRefresh={refresh}
              onError={setError}
            />
          )}
          <footer>
            <span>
              ADARSH <span className="orange">/</span> CONTROL CENTER
            </span>
            <span className="mono">CONFIG V1 · NO PROVIDER KEYS</span>
          </footer>
        </main>
        {dirty && (
          <div className="save-bar">
            <div>
              <span className="tiny-dot" />
              <b>Unsaved changes</b>
              <small>r{state?.revision} → next revision</small>
            </div>
            <button
              className="btn secondary"
              disabled={busy}
              onClick={() => {
                if (state) setDraft(structuredClone(state.config));
              }}
            >
              Discard
            </button>
            <button
              className="btn primary"
              disabled={!editable}
              onClick={() => setSaveOpen(true)}
            >
              <Save size={16} /> Review & save
            </button>
          </div>
        )}
      </div>
      {login && <Login onClose={() => setLogin(false)} />}{" "}
      {saveOpen && (
        <Dialog
          title="Review configuration change"
          onClose={() => {
            if (!busy) setSaveOpen(false);
          }}
        >
          <p>
            Revision {state?.revision} ke against config save hogi. Conflict
            aaye to refresh karke dobara review karo.
          </p>
          <div className="review-summary">
            <span>
              {draft.models.filter((m) => m.enabled).length} enabled models
            </span>
            <span>{Object.keys(draft.routes).length} routing overrides</span>
            <span>{Object.keys(draft.quality).length} quality overrides</span>
          </div>
          <p className="warning help">
            Endpoint change sirf same provider ke allowed host par apply hoga.
            Existing encrypted API keys na expose hongi na overwrite. Model
            ID/provider format compatibility app ke supported adapter par depend
            karti hai.
          </p>
          <label className="field">
            Change reason
            <textarea
              value={reason}
              maxLength={240}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Kya change kiya aur kyun?"
            />
          </label>
          <div className="form-actions">
            <button
              className="btn secondary"
              disabled={busy}
              onClick={() => setSaveOpen(false)}
            >
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={busy || !online}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Confirm save"}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
