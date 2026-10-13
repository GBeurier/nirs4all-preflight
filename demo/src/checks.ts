// Plain-language control points read from engine values. A point is "ok" only for an engine
// count of zero; nothing here is a calibrated threshold or a global score.
import type { Locale } from "nirs4all-ui/lab";
import { extractIntegrity, extractObservationFlow, extractPca, extractRepeatability, extractTarget, type CheckItem, type QualificationReportView } from "nirs4all-ui/qualification";
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
