import { KeyRound } from "lucide-react";
import { number, type Provider, type Report } from "../domain";
import { keyIdentityLabel, keyUsageGroups, type KeyUsage } from "../keyUsage";
import "./keyUsage.css";

function Models({ row }: { row: KeyUsage }) {
  if (!row.models.length)
    return <p className="help">Is key se koi model call report nahi hui.</p>;
  return (
    <details className="key-models">
      <summary>
        {row.models.length} model{row.models.length === 1 ? "" : "s"}
      </summary>
      {row.models.map((model, index) => (
        <div className="model-usage-row" key={`${model.model}-${index}`}>
          <code>{model.model}</code>
          <span>
            {number(model.req)} req / {number(model.tok)} tok
          </span>
        </div>
      ))}
    </details>
  );
}

export default function KeySlots({
  report,
  provider,
}: {
  report: Report;
  provider: Provider | "all";
}) {
  const groups = keyUsageGroups(report, provider);
  return (
    <div className="key-groups">
      <p className="help">
        5 providers × 3 slots = 15. ID ek device-local opaque identifier hai,
        API key ka hissa nahi. Replacement key ki usage alag rahegi; provider
        totals mein history bhi hai.
      </p>
      {groups.map((group) => (
        <section key={group.id} className="key-group">
          <h3>
            {group.name} <span className="muted mono">3 slots</span>
          </h3>
          <div className="key-slot-grid">
            {group.slots.map(({ slot, current, previous }) => (
              <div key={slot} className="key-slot">
                <div className="section-head">
                  <h4>
                    <KeyRound size={14} /> Key {slot}
                  </h4>
                  <span className="badge">
                    {!current
                      ? "Unknown"
                      : !current.set
                        ? "Not configured"
                        : current.active === true
                          ? "Current"
                          : "Reported slot"}
                  </span>
                </div>
                <p className="mono key-identity">
                  {current ? keyIdentityLabel(current) : "No key report yet"}
                </p>
                <div className="key-counters">
                  <span>
                    <strong>{current ? number(current.req) : "—"}</strong>
                    <small>Requests</small>
                  </span>
                  <span>
                    <strong>{current ? number(current.tok) : "—"}</strong>
                    <small>Tokens</small>
                  </span>
                </div>
                {current && (
                  <>
                    <p className="help">
                      State: {current.state}
                      {current.tracked_since_day
                        ? ` · tracked from ${current.tracked_since_day}`
                        : " · old slot history; key changes were not tracked"}
                    </p>
                    <Models row={current} />
                  </>
                )}
                {previous.length > 0 && (
                  <details className="key-history">
                    <summary>
                      {previous.length} previous / unattributed{" "}
                      {previous.length === 1 ? "entry" : "entries"}
                    </summary>
                    {previous.map((row, index) => (
                      <div
                        className="key-history-row"
                        key={row.generation ?? `legacy-${index}`}
                      >
                        <p className="mono">
                          {keyIdentityLabel(row)} · Historical
                        </p>
                        <p>
                          {number(row.req)} requests / {number(row.tok)} tokens
                        </p>
                        <Models row={row} />
                      </div>
                    ))}
                  </details>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
