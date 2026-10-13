import { useState, type DragEvent } from "react";
import type { T } from "./App";
import type { SyntheticScenario } from "./synthetic";

/** Decorative NIR-like curves (not data): a few smooth absorption profiles for the hero backdrop. */
function heroCurve(k: number, w = 1200, h = 320, n = 120): string {
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    const y = 0.55 - 0.08 * k
      + 0.22 * Math.exp(-(((x - 0.3 - 0.02 * k) / 0.07) ** 2))
      + 0.3 * Math.exp(-(((x - 0.72) / 0.11) ** 2)) * (0.7 + 0.12 * k)
      + 0.12 * x;
    pts.push(`${(x * w).toFixed(1)},${(h - y * h * 0.94).toFixed(1)}`);
  }
  return `M${pts.join("L")}`;
}
const HERO_COLORS = ["#0d9488", "#06b6d4", "#10b981", "#0f766e", "#2dd4bf"];

function MiniSpectra({ pitfalls }: { pitfalls: boolean }) {
  return (
    <svg viewBox="0 0 120 48" className="demo-spark" aria-hidden="true">
      {[0, 1, 2, 3].map((k) => (
        <path key={k} d={heroCurve(k, 120, 52, 40)} stroke={HERO_COLORS[k]} />
      ))}
      {pitfalls ? <circle cx="38" cy="16" r="4" className="demo-spark-flag" /> : null}
    </svg>
  );
}

export function Landing({ t, error, onFile, onSynthetic }: { t: T; error: string | null; onFile: (file: File) => void; onSynthetic: (sc: SyntheticScenario) => void }) {
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };
  return (
    <>
      <section className="hero">
        <div className="hero-dots" aria-hidden="true" />
        <svg className="hero-spectra" viewBox="0 0 1200 320" preserveAspectRatio="none" aria-hidden="true">
          {HERO_COLORS.map((c, k) => <path key={c} d={heroCurve(k)} stroke={c} />)}
        </svg>
        <div className="container hero-content">
          <span className="eyebrow">{t("eyebrow")}</span>
          <h1 className="hero-title">{t("heroA")} <em>{t("heroB")}</em> {t("heroC")}</h1>
          <p className="hero-sub">{t("heroSub")}</p>

          <label
            className="dropzone"
            data-over={over || undefined}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden="true" className="dropzone-icon">
              <path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
            </svg>
            <span className="dropzone-title">{over ? t("dropActive") : t("drop")}</span>
            <span className="dropzone-or">{t("dropOr")} <u>{t("browse")}</u></span>
            <span className="dropzone-hint">{t("dropHint")}</span>
            <input
              type="file"
              accept="application/json,.json"
              className="visually-hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onFile(file);
                e.target.value = "";
              }}
            />
          </label>
          {error ? <p role="alert" className="alert">{error}</p> : null}

          <p className="demo-title">{t("tryDemo")}</p>
          <div className="demo-cards">
            {(["clean", "pitfalls"] as const).map((sc) => (
              <button key={sc} className="demo-card" onClick={() => onSynthetic(sc)}>
                <MiniSpectra pitfalls={sc === "pitfalls"} />
                <span className="demo-card-text">
                  <strong>{t(sc === "clean" ? "scClean" : "scPitfalls")}</strong>
                  <span>{t(sc === "clean" ? "scCleanDesc" : "scPitfallsDesc")}</span>
                </span>
                <span className="demo-card-arrow" aria-hidden="true">→</span>
              </button>
            ))}
          </div>
          <p className="note center">{t("syntheticNote")}</p>
        </div>
      </section>
      <section className="how">
        <div className="container how-grid">
          {(["1", "2", "3"] as const).map((n) => (
            <div key={n} className="how-step">
              <span className="how-num">0{n}</span>
              <strong>{t(`how${n}`)}</strong>
              <span>{t(`how${n}d`)}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
