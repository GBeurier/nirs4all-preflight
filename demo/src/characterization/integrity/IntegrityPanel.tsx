// §3 Spectra with isolated peaks and abrupt changes (+ T²/Q atypical spectra), rendered from the rubric blocks.
import type { Scope } from "../../Sections";
import { RubricView, useIntegrityBlocks } from "./blocks";

export { SERIES_COLORS, scanLabel } from "./blocks";

export function IntegrityPanel(scope: Scope) {
  const blocks = useIntegrityBlocks(scope);
  return blocks ? <RubricView scope={scope} blocks={blocks} /> : null;
}
