import { type Config, type Quality as QualityConfig } from "../domain";
import { Toggle } from "./ui";

type Props = {
  config: Config;
  onChange: (c: Config) => void;
  editable: boolean;
};

export default function Quality({ config, onChange, editable }: Props) {
  function setTruth(value: QualityConfig["truthLevel"] | "inherit") {
    const quality = { ...config.quality };
    if (value === "inherit") delete quality.truthLevel;
    else quality.truthLevel = value;
    onChange({ ...config, quality });
  }
  function setFactCheck(value: QualityConfig["factCheck"] | "inherit") {
    const quality = { ...config.quality };
    if (value === "inherit") delete quality.factCheck;
    else quality.factCheck = value;
    onChange({ ...config, quality });
  }
  function setFlag(
    key:
      | "builtInWebSearch"
      | "audit"
      | "ground"
      | "research"
      | "review"
      | "debate",
    value: boolean | undefined,
  ) {
    const quality = { ...config.quality };
    if (value === undefined) delete quality[key];
    else quality[key] = value;
    onChange({ ...config, quality });
  }

  return (
    <section className="page-module">
      <div className="toolbar">
        <div>
          <h1 className="page-title">Quality &amp; safeguards</h1>
          <p className="muted">
            Unset values app ke existing default ko preserve karte hain; yeh
            controls sirf config draft update karte hain.
          </p>
        </div>
      </div>
      <section className="card">
        <h2>Response profile</h2>
        <label className="field">
          Truth level
          <select
            disabled={!editable}
            value={config.quality.truthLevel ?? "inherit"}
            onChange={(e) =>
              setTruth(
                e.target.value as QualityConfig["truthLevel"] | "inherit",
              )
            }
          >
            <option value="inherit">App default</option>
            <option value="strict">Strict</option>
            <option value="balanced">Balanced</option>
            <option value="creative">Creative</option>
          </select>
        </label>
        <p className="help">
          App default select karne par truthLevel unset rahega—koi app default
          yahan assume nahi hota.
        </p>
        <label className="field">
          Fact-check policy
          <select
            disabled={!editable}
            value={config.quality.factCheck ?? "inherit"}
            onChange={(e) =>
              setFactCheck(
                e.target.value as QualityConfig["factCheck"] | "inherit",
              )
            }
          >
            <option value="inherit">App default</option>
            <option value="off">Off</option>
            <option value="auto">Auto</option>
            <option value="always">Always</option>
          </select>
        </label>
        <p className="help">
          Unset factCheck app ka existing local fallback preserve karta hai.
        </p>
      </section>

      <section className="card">
        <h2>Built-in search &amp; review controls</h2>
        <p className="help">
          App default = property unset; On/Off explicit override hai.
        </p>
        <Toggle
          label="Built-in web search"
          note="Search capability ko config mein allow/disable karo; availability/coverage guarantee nahi."
          value={config.quality.builtInWebSearch}
          disabled={!editable}
          onChange={(value) => setFlag("builtInWebSearch", value)}
        />
        <Toggle
          label="Audit"
          note="Audit behavior inherit karo, ya explicitly on/off set karo."
          value={config.quality.audit}
          disabled={!editable}
          onChange={(value) => setFlag("audit", value)}
        />
        <Toggle
          label="Ground"
          note="Ground behavior inherit karo, ya explicitly on/off set karo."
          value={config.quality.ground}
          disabled={!editable}
          onChange={(value) => setFlag("ground", value)}
        />
        <Toggle
          label="Research"
          note="Research behavior inherit karo, ya explicitly on/off set karo."
          value={config.quality.research}
          disabled={!editable}
          onChange={(value) => setFlag("research", value)}
        />
        <Toggle
          label="Review"
          note="Review behavior inherit karo, ya explicitly on/off set karo."
          value={config.quality.review}
          disabled={!editable}
          onChange={(value) => setFlag("review", value)}
        />
        <Toggle
          label="Debate"
          note="Debate behavior inherit karo, ya explicitly on/off set karo."
          value={config.quality.debate}
          disabled={!editable}
          onChange={(value) => setFlag("debate", value)}
        />
      </section>
      <aside className="warning">
        <strong>Safeguard caveat:</strong> Strict mode, fact-checking, search,
        grounding, audit ya review se factual accuracy guarantee nahi hoti. In
        controls ko accuracy certification ya safety guarantee na samjhein.
      </aside>
    </section>
  );
}
