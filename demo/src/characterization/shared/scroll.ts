// Anchor scrolling that survives late layout: sections above the target (charts measuring their width,
// lazy panels, worker results) keep growing after the first smooth scroll, which used to leave the
// target too high or too low. After the smooth scroll, the target is re-aligned instantly whenever the
// page layout changes, until the layout has been quiet for a moment, a time limit passes, or the reader
// scrolls by hand (wheel, touch, keys or pointer), which always wins.

/** Re-alignment window after the jump (ms) and the quiet period that ends it early (ms). */
const SETTLE_MS = 3000;
const QUIET_MS = 800;
/** Time left to the initial smooth scroll before layout corrections start (ms). */
const SMOOTH_MS = 700;
/** Tolerated drift (px) before a correction. */
const TOLERANCE = 3;

let cancelCurrent: (() => void) | null = null;

/** Offset the browser keeps above an anchored element (`scroll-margin-top`). */
function marginTop(el: Element): number {
  const v = typeof getComputedStyle === "function" ? parseFloat(getComputedStyle(el).scrollMarginTop) : 0;
  return Number.isFinite(v) ? v : 0;
}

/**
 * Smooth-scrolls to `id` and keeps it aligned while the layout settles. Returns a cancel function.
 * A no-op (returns a no-op) when the element is absent.
 */
export function scrollToSettled(id: string): () => void {
  cancelCurrent?.();
  const target = typeof document !== "undefined" ? document.getElementById(id) : null;
  if (!target) return () => {};
  target.scrollIntoView?.({ behavior: "smooth", block: "start" });
  if (typeof window === "undefined" || typeof ResizeObserver === "undefined") return () => {};
  const started = performance.now();
  let lastChange = started;
  let frame = 0;
  let stopped = false;
  const check = () => {
    frame = 0;
    if (stopped) return;
    const now = performance.now();
    if (now - started > SETTLE_MS || (now - started > SMOOTH_MS && now - lastChange > QUIET_MS)) return stop();
    if (now - started > SMOOTH_MS) {
      const el = document.getElementById(id);
      if (!el) return stop();
      const drift = el.getBoundingClientRect().top - marginTop(el);
      if (Math.abs(drift) > TOLERANCE) el.scrollIntoView({ behavior: "auto", block: "start" });
    }
    frame = requestAnimationFrame(check);
  };
  const observer = new ResizeObserver(() => {
    lastChange = performance.now();
  });
  observer.observe(document.body);
  const main = target.closest(".diag-main") ?? target.parentElement;
  if (main) observer.observe(main);
  const userEvents = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    for (const e of userEvents) window.removeEventListener(e, stop, true);
    if (cancelCurrent === stop) cancelCurrent = null;
  };
  // The click that started the jump has already been dispatched: later user input cancels the corrections.
  for (const e of userEvents) window.addEventListener(e, stop, { capture: true, passive: true });
  frame = requestAnimationFrame(check);
  cancelCurrent = stop;
  return stop;
}
