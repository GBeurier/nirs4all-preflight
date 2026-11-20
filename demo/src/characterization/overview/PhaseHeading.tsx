// Heading between the large phases of the characterization page (overview → detailed diagnostics →
// preprocessing explorer → quality map), following the page mockup.
import "./overview.css";

export function PhaseHeading({ id, index, title, lead }: { id: string; index: string; title: string; lead: string }) {
  return (
    <div className="ov-phase" id={id} role="group" aria-labelledby={`${id}-h`}>
      <span className="ov-phase-arrow" aria-hidden="true">↓</span>
      <div>
        <span className="eyebrow">{index}</span>
        <h2 id={`${id}-h`}>{title}</h2>
        <p>{lead}</p>
      </div>
    </div>
  );
}
