import type { EngineReport, QualificationMetricView } from "nirs4all-ui/qualification";
import { downloadText } from "./download";

export const metricKey = (m: QualificationMetricView) => JSON.stringify([m.id, m.sourceId, m.targetId, m.viewId, m.populationId, m.parameters]);

/** Export selection keeps report provenance; a finding requires all its evidence. */
export function selectedReport(report: EngineReport, selected: ReadonlySet<string>): EngineReport {
  const metrics = report.metrics.filter((m) => m.metric_id === "analysis.selection" || selected.has(metricKey({ id: m.metric_id, sourceId: m.source_id ?? null, targetId: m.target_id ?? null, viewId: m.view_id, populationId: m.population_id, parameters: m.parameters ?? {} } as QualificationMetricView)));
  const kept = new Set(metrics);
  const omittedIds = new Set(report.metrics.filter((m) => !kept.has(m)).map((m) => m.metric_id));
  return { ...report, status: metrics.length === report.metrics.length ? report.status ?? "partial" : "partial", metrics, findings: report.findings.filter((f) => f.evidence.every((id) => !omittedIds.has(id))), limitations: [...(report.limitations ?? []), ...(metrics.length < report.metrics.length ? [`This export includes ${metrics.length} of ${report.metrics.length} indicators, retaining analysis.selection provenance. Findings requiring omitted evidence are excluded.`] : [])] };
}

const cell = (value: string) => `"${(/^[=+@\t\r-]/.test(value) && !Number.isFinite(Number(value)) ? "'" : "") + value.replaceAll('"', '""')}"`;

/** Visible and collapsed chart tables are exported together, with captions and headers. */
export function exportTables(section: HTMLElement, name: string): void {
  const tables = [...section.querySelectorAll("table")];
  const text = tables.map((table) => [
    cell(table.caption?.textContent ?? section.querySelector("h2")?.textContent ?? name),
    ...[...table.rows].map((row) => [...row.cells].map((c) => cell(c.getAttribute("data-value") ?? c.textContent?.trim() ?? "")).join(",")),
  ].join("\r\n")).join("\r\n\r\n");
  downloadText(`${name}-tables.csv`, "text/csv;charset=utf-8", `\uFEFF${text}`);
}

/** Resolve theme styles so a downloaded SVG remains readable outside the app. */
export function exportSvg(svg: SVGSVGElement, name: string): void {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const sourceNodes = [svg, ...svg.querySelectorAll("*")];
  const copyNodes = [copy, ...copy.querySelectorAll("*")];
  for (let i = 0; i < sourceNodes.length; i++) {
    const style = getComputedStyle(sourceNodes[i]!);
    for (const property of ["opacity", "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "font-family", "font-size", "font-weight", "color"]) {
      (copyNodes[i] as SVGElement).style.setProperty(property, style.getPropertyValue(property));
    }
  }
  const namespace = "http://www.w3.org/2000/svg";
  const figure = svg.closest("figure");
  const bounds = svg.viewBox.baseVal;
  const readableText = (element: Element) => [...element.childNodes].map((node) => node.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
  const legendItems = [...(figure?.querySelectorAll("figcaption li") ?? []), ...(svg.closest(".card")?.querySelectorAll(".explorer-foot .n4q-legend li") ?? [])];
  const ramp = figure?.querySelector(".n4q-colorbar-ramp") ?? svg.closest(".card")?.querySelector(".explorer-foot .n4q-colorbar-ramp");
  const rampColors = ramp ? getComputedStyle(ramp).backgroundImage.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/gi) ?? [] : [];
  const notes = [
    document.querySelector(".ws-title")?.textContent?.trim() ?? "Preflight",
    ...[...(figure?.querySelectorAll("figcaption li, .n4q-reference-notes, .n4q-colorbar") ?? [])].map((element) => readableText(element)),
    ...[...(svg.closest(".card")?.querySelectorAll(".explorer-foot .n4q-legend li, .explorer-foot .n4q-colorbar") ?? [])].map((element) => readableText(element)),
  ].filter(Boolean);
  const maxCharacters = Math.max(24, Math.floor((bounds.width - 24) / 7));
  const lines = notes.flatMap((note) => note.match(new RegExp(`.{1,${maxCharacters}}(?:\\s|$)|.{1,${maxCharacters}}`, "g")) ?? [note]);
  if (lines.length && bounds.width && bounds.height) {
    copy.setAttribute("viewBox", `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height + lines.length * 20 + 16 + (rampColors.length ? 24 : 0)}`);
    for (const [i, line] of lines.entries()) {
      const text = document.createElementNS(namespace, "text");
      text.setAttribute("x", "12");
      text.setAttribute("y", String(bounds.height + 20 + i * 20));
      text.setAttribute("fill", getComputedStyle(svg).color);
      text.setAttribute("font-size", "13");
      text.setAttribute("font-family", "sans-serif");
      text.textContent = line;
      const legendItem = legendItems.find((element) => readableText(element) === line.trim());
      const key = legendItem?.querySelector("[aria-hidden='true']");
      if (key) {
        const marker = document.createElementNS(namespace, "rect");
        marker.setAttribute("x", "12"); marker.setAttribute("y", String(bounds.height + 10 + i * 20));
        marker.setAttribute("width", "10"); marker.setAttribute("height", "10");
        marker.setAttribute("fill", getComputedStyle(key).backgroundColor);
        copy.append(marker); text.setAttribute("x", "28");
      }
      copy.append(text);
    }
  }
  if (rampColors.length) {
    const defs = document.createElementNS(namespace, "defs");
    const gradient = document.createElementNS(namespace, "linearGradient");
    gradient.setAttribute("id", "preflight-export-ramp");
    rampColors.forEach((color, i) => { const stop = document.createElementNS(namespace, "stop"); stop.setAttribute("offset", String(i / Math.max(1, rampColors.length - 1))); stop.setAttribute("stop-color", color); gradient.append(stop); });
    defs.append(gradient); copy.append(defs);
    const rectangle = document.createElementNS(namespace, "rect");
    rectangle.setAttribute("x", "12"); rectangle.setAttribute("y", String(bounds.height + lines.length * 20 + 8));
    rectangle.setAttribute("width", "128"); rectangle.setAttribute("height", "12"); rectangle.setAttribute("fill", "url(#preflight-export-ramp)"); copy.append(rectangle);
  }
  for (const element of copy.querySelectorAll("[tabindex]")) element.removeAttribute("tabindex");
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.style.background = getComputedStyle(document.body).backgroundColor;
  downloadText(`${name}.svg`, "image/svg+xml", new XMLSerializer().serializeToString(copy));
}
