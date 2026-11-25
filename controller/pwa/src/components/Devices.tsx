import { useState, useEffect } from "react";
import {
  Smartphone,
  Plus,
  History,
  RotateCcw,
  Link2,
  Copy,
  Check,
  ShieldOff,
} from "lucide-react";
import type { State, Device } from "../domain";
import { admin } from "../api";
import { Card, Badge, Empty, Dialog } from "./ui";
export default function Devices({
  state,
  editable,
  onRefresh,
  onError,
}: {
  state: State | null;
  editable: boolean;
  onRefresh: () => Promise<void>;
  onError: (m: string) => void;
}) {
  const [pairOpen, setPairOpen] = useState(false);
  const [name, setName] = useState("ADARSH phone");
  const [pair, setPair] = useState<{ code: string; expires_at: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [revoke, setRevoke] = useState<Device | null>(null);
  const [rollback, setRollback] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!pair) return;
    const timer = window.setTimeout(
      () => setPair(null),
      Math.max(0, Date.parse(pair.expires_at) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [pair]);
  async function makePair() {
    setBusy(true);
    try {
      const result = await admin<{
        ok: true;
        code: string;
        expires_at: string;
      }>({ action: "pair_code", name: name.trim() });
      setPair(result);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Pair code create nahi hua.");
    } finally {
      setBusy(false);
    }
  }
  async function change() {
    setBusy(true);
    try {
      if (revoke) await admin({ action: "revoke", device_id: revoke.id });
      if (rollback !== null && state)
        await admin({
          action: "rollback",
          expected_revision: state.revision,
          target_revision: rollback,
        });
      setRevoke(null);
      setRollback(null);
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Change fail hua.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-title">
        <div className="eyebrow">CONTROL PLANE / 06</div>
        <h1>
          Connected devices<span className="orange">.</span>
        </h1>
        <p>Pair once. Sync safely. Revoke anytime.</p>
      </div>
      <div className="toolbar">
        <Badge tone="good">Encrypted app-side token</Badge>
        <button
          className="btn primary"
          disabled={!editable}
          onClick={() => setPairOpen(true)}
        >
          <Plus size={16} /> Pair a device
        </button>
      </div>
      <Card>
        <div className="section-head">
          <h2>
            <Smartphone size={19} /> ADARSH devices
          </h2>
          <button
            className="text-btn"
            disabled={!editable || busy}
            onClick={() => void onRefresh()}
          >
            Refresh
          </button>
        </div>
        {!state?.devices.length ? (
          <Empty title="No paired devices yet">
            Owner login ke baad pairing code banao. ADARSH Settings → Controller
            mein code enter karke link karo.
          </Empty>
        ) : (
          state.devices.map((d) => (
            <div className="device-row" key={d.id}>
              <div className="device-icon">
                <Smartphone size={23} />
              </div>
              <div className="device-info">
                <h3>{d.name}</h3>
                <p>
                  Last sync:{" "}
                  {d.last_seen
                    ? new Date(d.last_seen).toLocaleString()
                    : "Waiting for first sync"}
                </p>
                <code>
                  Applied acknowledgement:{" "}
                  {d.applied_revision ?? "Waiting / bundled"}
                </code>
                <p className="help">
                  Last sent revision: {d.config_revision}. Applied state app ke
                  next successful sync par acknowledge hoti hai.
                </p>
              </div>
              <Badge tone={d.revoked_at ? "bad" : "good"}>
                {d.revoked_at ? "Revoked" : "Paired"}
              </Badge>
              <button
                className="icon-btn danger"
                disabled={!editable || !!d.revoked_at}
                aria-label={`Revoke ${d.name}`}
                onClick={() => setRevoke(d)}
              >
                <ShieldOff size={19} />
              </button>
            </div>
          ))
        )}
      </Card>
      <Card>
        <div className="section-head">
          <div>
            <div className="eyebrow">VERSIONED CONTROL</div>
            <h2>
              <History size={19} /> Change history
            </h2>
          </div>
          <span className="mono muted">
            {state ? `REV ${state.revision}` : "NO LIVE REVISION"}
          </span>
        </div>
        <p className="help">
          Rollback nayi config revision banata hai. Chats, usage, phone data aur
          News rows kabhi rollback/delete nahi hoti.
        </p>
        {!state?.history.length ? (
          <Empty title="History login ke baad available hogi">
            Har saved configuration ke saath revision aur change reason record
            hoga.
          </Empty>
        ) : (
          state.history.map((h) => (
            <div className="history-row" key={h.revision}>
              <div className="revision mono">
                r{String(h.revision).padStart(3, "0")}
              </div>
              <div>
                <h3>{h.reason || "Configuration saved"}</h3>
                <p>{new Date(h.created_at).toLocaleString()}</p>
              </div>
              {h.revision === state.revision ? (
                <Badge tone="good">Current</Badge>
              ) : (
                <button
                  className="text-btn"
                  disabled={!editable || busy}
                  onClick={() => setRollback(h.revision)}
                >
                  <RotateCcw size={14} /> Restore
                </button>
              )}
            </div>
          ))
        )}
      </Card>
      <div className="notice">
        <Link2 size={18} />
        <span>
          Pairing aur config sirf ADARSH ke next supported app update mein
          available honge. Is task mein APK build nahi hua hai.
        </span>
      </div>
      {pairOpen && (
        <Dialog
          title="Pair ADARSH app"
          onClose={() => {
            setPairOpen(false);
            setPair(null);
            setCopied(false);
          }}
        >
          {!pair ? (
            <>
              <p className="muted">
                One-time code 10 minutes tak valid hai. API keys ya News
                APP_SECRET yahan use mat karo.
              </p>
              <label className="field">
                Device name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={60}
                  placeholder="ADARSH phone"
                />
              </label>
              <button
                className="btn primary full"
                disabled={busy || !name.trim()}
                onClick={() => void makePair()}
              >
                {busy ? "Code ban raha hai…" : "Create pairing code"}
              </button>
            </>
          ) : (
            <>
              <div
                className="pair-code mono"
                aria-label="One time device pairing code"
              >
                {pair.code}
              </div>
              <button
                className="btn secondary full"
                onClick={() => {
                  navigator.clipboard
                    .writeText(pair.code)
                    .then(() => setCopied(true))
                    .catch(() =>
                      onError("Copy unavailable. Code manually enter karo."),
                    );
                }}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}{" "}
                {copied ? "Copied" : "Copy pairing code"}
              </button>
              <p className="help">
                Expires: {new Date(pair.expires_at).toLocaleTimeString()}.
                ADARSH Settings → Controller mein enter karo. Ye device API
                token nahi hai aur browser mein persist nahi hota.
              </p>
              <button
                className="text-btn"
                onClick={() => {
                  setPairOpen(false);
                  setPair(null);
                  void onRefresh();
                }}
              >
                Done, refresh devices
              </button>
            </>
          )}
        </Dialog>
      )}
      {(revoke || rollback !== null) && (
        <Dialog
          title={revoke ? "Revoke device access?" : "Restore configuration?"}
          onClose={() => {
            if (!busy) {
              setRevoke(null);
              setRollback(null);
            }
          }}
        >
          <p>
            {revoke ? (
              <>
                {revoke.name} next sync par controller access kho dega. Existing
                usage history aur local app data preserve rahenge.
              </>
            ) : (
              <>
                Revision {rollback} ko nayi revision ke roop mein restore karna
                hai? App next successful sync/start par config apply karega;
                existing data unchanged rahega.
              </>
            )}
          </p>
          <div className="form-actions">
            <button
              className="btn secondary"
              disabled={busy}
              onClick={() => {
                setRevoke(null);
                setRollback(null);
              }}
            >
              Cancel
            </button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => void change()}
            >
              {busy ? "Apply ho raha hai…" : "Confirm"}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
