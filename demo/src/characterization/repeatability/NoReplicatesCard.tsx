// Explicit "no technical replicates" state (request §6, chat §7): no zero, no empty gauge, no ICC.
// A direct link to the dataset settings and the noise-proxy alternative, with its limit.
import { NO_REPLICATES_MESSAGE } from "./summary";

export const NOISE_PROXY_STILL_AVAILABLE = "The per-band noise proxy remains available, but it does not replace an experimental measurement of repeatability.";

function Icon({ kind }: { kind: "info" | "check" | "settings" }) {
  const common = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (kind === "info") return <svg {...common} className="rp-icon rp-icon-info"><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.01" /></svg>;
  if (kind === "check") return <svg {...common} className="rp-icon rp-icon-ok"><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.6 2.5L16 9.5" /></svg>;
  return <svg {...common} className="rp-icon rp-icon-info"><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></svg>;
}

export function NoReplicatesCard({ onOpenSettings }: { onOpenSettings?: (() => void) | undefined }) {
  return (
    <section className="cz-card rp-norep" data-testid="repeat-none" aria-label="Technical repeatability not available">
      <header className="rp-norep-head">
        <h4 className="cz-card-title">Technical repeatability</h4>
        <span className="rp-badge">Not available</span>
      </header>
      <div className="rp-norep-row">
        <Icon kind="info" />
        <div>
          <p className="rp-norep-main">No technical replicate groups have been declared.</p>
          <p className="rp-norep-text">{NO_REPLICATES_MESSAGE}</p>
          <p className="rp-norep-text">Declare measurements belonging to the same physical sample to distinguish measurement variability from actual sample diversity. Keep physical sample identifiers, repeat identifiers, biological repeats and the acquisition context (instrument, session, operator) distinct.</p>
        </div>
      </div>
      <div className="rp-norep-alt">
        <p className="rp-norep-label">Available alternative</p>
        <p className="rp-norep-row"><Icon kind="check" /><span>Per-band fine-scale noise proxy</span></p>
        <p className="cz-card-foot">{NOISE_PROXY_STILL_AVAILABLE} It estimates local spectral fluctuations but cannot quantify true technical repeatability.</p>
      </div>
      {onOpenSettings ? (
        <button type="button" className="btn btn-outline btn-sm rp-norep-btn" onClick={onOpenSettings}>
          <Icon kind="settings" />Configure technical replicate groups in dataset settings
        </button>
      ) : null}
    </section>
  );
}
