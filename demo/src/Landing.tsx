import type { Locale } from "nirs4all-ui/lab";
import { DatasetPicker, HERO_COLORS, heroCurve, type LoadDataset } from "./DatasetPicker";
import type { T } from "./App";
import type { SyntheticScenario } from "./synthetic";

export function Landing({ t, locale, onDataset, onSynthetic }: { t: T; locale: Locale; onDataset: LoadDataset; onSynthetic: (sc: SyntheticScenario) => void }) {
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
          <DatasetPicker t={t} locale={locale} onLoad={onDataset} onSynthetic={onSynthetic} />
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
