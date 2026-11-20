// §4 Estimated signal-to-noise ratio, rendered from the rubric blocks.
import type { Scope } from "../../Sections";
import { RubricView, useSnrBlocks } from "./blocks";

export function SnrPanel(scope: Scope) {
  const blocks = useSnrBlocks(scope);
  return blocks ? <RubricView scope={scope} blocks={blocks} /> : null;
}
