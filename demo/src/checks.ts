// Plain-language control points read from engine values. A point is "ok" only for an engine
// count of zero; nothing here is a calibrated threshold or a global score.
import type { Locale } from "nirs4all-ui/lab";
import {
  extractConfounding,
  extractDomainShift,
  extractDuplicates,
  extractIntegrity,
  extractObservationFlow,
  extractPca,
  extractProbes,
  extractRepeatability,
  extractTarget,
  formatEngineNumber,
  type CheckItem,
  type QualificationReportView,
} from "nirs4all-ui/qualification";
import type { T } from "./App";
import { fill, type TextKey } from "./i18n";
import type { EngineInput } from "./input";

const n = (v: number, locale: Locale) => (Number.isInteger(v) ? v.toLocaleString(locale) : Number(v.toPrecision(3)).toLocaleString(locale));

export function buildChecks(view: QualificationReportView, input: EngineInput, sourceId: string | null, targetId: string | null, t: T, locale: Locale): CheckItem[] {
  const f = (k: TextKey, vars: Record<string, string | number> = {}) => fill(t(k), vars);
  const items: CheckItem[] = [];
  const integrity = sourceId ? extractIntegrity(view, sourceId) : null;

  const leak = integrity?.partitionDuplicatePairs ?? null;
  items.push({
    id: "leak",
    title: t("chkLeak"),
    status: leak === null ? "unavailable" : leak > 0 ? "critical" : "ok",
    detail: leak === null ? undefined : leak > 0 ? f("chkLeakKo", { n: leak }) : t("chkLeakOk"),
    href: "#ev-integrity.cross_partition_exact_duplicate_pairs",
  });

  const dup = integrity?.physicalDuplicatePairs ?? null;
  items.push({
    id: "duplicates",
    title: t("chkDup"),
    status: dup === null ? "unavailable" : dup > 0 ? "attention" : "ok",
    detail: dup === null ? undefined : dup > 0 ? f("chkDupKo", { n: dup }) : t("chkDupOk"),
    href: "#ev-integrity.cross_physical_exact_duplicate_pairs",
  });

  const missing = integrity?.missingCells ?? null;
  const cells = integrity?.totalCells !== null && integrity?.totalCells !== undefined ? n(integrity.totalCells, locale) : "—";
  items.push({
    id: "missing",
    title: t("chkMissing"),
    status: missing === null ? "unavailable" : missing > 0 ? "attention" : "ok",
    detail: missing === null ? undefined : missing > 0 ? f("chkMissingKo", { n: missing, cells }) : f("chkMissingOk", { cells }),
    href: "#data-spectra",
  });

  const flow = sourceId ? extractObservationFlow(view, sourceId) : null;
  if (flow) {
    items.push({
      id: "repeats",
      title: t("chkRepeats"),
      status: flow.excludedAmbiguousRepeat > 0 ? "attention" : "ok",
      detail: flow.excludedAmbiguousRepeat > 0 ? f("chkRepeatsKo", { n: flow.excludedAmbiguousRepeat }) : t("chkRepeatsOk"),
      href: "#s-populations",
    });
  }

  const contexts = sourceId ? extractRepeatability(view, sourceId) : [];
  items.push({
    id: "repeatability",
    title: t("chkRepeat"),
    status: contexts.length ? "ok" : "unavailable",
    detail: contexts.length ? f("chkRepeatOk", { n: contexts.length }) : t("chkRepeatNa"),
    href: "#s-repeat",
  });

  if (targetId) {
    const target = extractTarget(view, targetId);
    const d = target.denominators;
    const excluded = (d.n_excluded_censored ?? 0) + (d.n_excluded_composite ?? 0);
    const inconsistent = d.n_inconsistent_samples ?? 0;
    items.push({
      id: "target",
      title: `${t("chkTarget")} · ${targetId}`,
      status: target.eligible === null ? "unavailable" : inconsistent > 0 ? "critical" : excluded > 0 ? "attention" : "ok",
      detail: inconsistent > 0 ? f("chkTargetKo", { x: inconsistent }) : excluded > 0 ? f("chkTargetWarn", { n: target.eligible ?? 0, x: excluded }) : f("chkTargetOk", { n: target.eligible ?? 0 }),
      href: "#s-target",
    });
  } else {
    items.push({ id: "target", title: t("chkTarget"), status: "unavailable", detail: t("chkTargetNa") });
  }

  const pca = sourceId ? extractPca(view, sourceId) : null;
  items.push({
    id: "structure",
    title: t("chkStructure"),
    status: pca ? "ok" : "unavailable",
    detail: pca ? f("chkStructureOk", { n: pca.sampleIds.length, d: pca.effectiveDimension === null ? "—" : n(pca.effectiveDimension, locale) }) : t("chkStructureNa"),
    href: "#s-structure",
  });

  if (sourceId) items.push(...blockChecks(view, sourceId, targetId, t, locale));

  const unit = input.options.independence_unit ?? "unknown";
  items.push({
    id: "unit",
    title: t("chkUnit"),
    status: unit === "unknown" ? "attention" : "ok",
    detail: unit === "unknown" ? t("chkUnitKo") : f("chkUnitOk", { u: t(`unit_${unit}` as TextKey) }),
  });
  return items;
}

export const needsReview = (items: readonly CheckItem[]) => items.filter((i) => i.status === "attention" || i.status === "critical").length;

/** Control points of the 0.1.0 blocks, only when the report carries them. */
function blockChecks(view: QualificationReportView, sourceId: string, targetId: string | null, t: T, locale: Locale): CheckItem[] {
  const f = (k: TextKey, vars: Record<string, string | number> = {}) => fill(t(k), vars);
  const items: CheckItem[] = [];
  const dups = extractDuplicates(view, sourceId).filter((d) => d.state.status === "computed");
  const cross = dups.find((d) => d.id === "integrity.cross_partition_quasi_duplicate_pairs");
  if (cross) {
    items.push({ id: "quasi-leak", title: t("chkQuasiLeak"), status: (cross.pairs ?? 0) > 0 ? "critical" : "ok", detail: (cross.pairs ?? 0) > 0 ? f("chkQuasiLeakKo", { n: cross.pairs ?? 0 }) : t("chkQuasiLeakOk"), href: "#s-duplicates" });
  }
  const conflicts = dups.filter((d) => d.id.startsWith("reference.") && (d.targetId === targetId || targetId === null));
  if (conflicts.length) {
    const nConf = conflicts.reduce((acc, d) => acc + (d.pairs ?? 0), 0);
    items.push({ id: "conflicts", title: t("chkConflicts"), status: nConf > 0 ? "attention" : "ok", detail: nConf > 0 ? f("chkConflictsKo", { n: nConf }) : t("chkConflictsOk"), href: "#s-duplicates" });
  }
  const conf = extractConfounding(view, sourceId);
  if (conf?.factors.length) {
    const aliased = conf.factors.filter((x) => x.aliasedWithOtherFactorCells && x.identifiableUnderAdditiveModel !== true).map((x) => x.factor);
    items.push({ id: "aliased", title: t("chkAliased"), status: aliased.length ? "attention" : "ok", detail: aliased.length ? f("chkAliasedKo", { f: aliased.join(", ") }) : t("chkAliasedOk"), href: "#s-confounding" });
  }
  const shift = extractDomainShift(view, sourceId).filter((x) => !x.audit && x.test?.state.status === "computed");
  if (shift.length) {
    const rejected = shift.filter((x) => x.test?.rejects).map((x) => x.factor);
    items.push({ id: "shift", title: t("chkShift"), status: rejected.length ? "attention" : "ok", detail: rejected.length ? f("chkShiftKo", { f: rejected.join(", ") }) : t("chkShiftOk"), href: "#s-shift" });
  }
  const probes = extractProbes(view).filter((p) => p.sourceId === sourceId && (!targetId || p.targetId === targetId));
  for (const p of probes) {
    const title = `${t("chkProbe")} · ${p.targetId}${p.estimator ? ` · ${p.estimator.toUpperCase()}` : ""}`;
    if (p.state.status !== "computed" || !p.skill) {
      items.push({ id: `probe-${p.targetId}-${p.estimator ?? ""}`, title, status: "unavailable", detail: f("chkProbeNa", { r: p.unavailable["probe.skill_vs_train_mean"]?.reasonCode ?? p.state.reasonCode ?? "—" }), href: "#s-probe" });
      continue;
    }
    const positive = p.skill.kind === "double" ? p.skill.value > 0 : p.skill.significand > 0;
    const s = formatEngineNumber(p.skill.kind === "double" ? p.skill.value : { significand: p.skill.significand, exponent: p.skill.exponent, representation: "significand_times_2_pow_exponent" }, locale) ?? "—";
    items.push({ id: `probe-${p.targetId}-${p.estimator ?? ""}`, title, status: positive ? "ok" : "attention", detail: f(positive ? "chkProbeOk" : "chkProbeKo", { s }), href: "#s-probe" });
  }
  return items;
}
