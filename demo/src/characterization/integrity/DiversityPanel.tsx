// §5 Distance from the mean spectrum (spectral diversity; never coloured good/bad), rendered from the rubric blocks.
import type { Scope } from "../../Sections";
import { RubricView, useDiversityBlocks } from "./blocks";

export function DiversityPanel(scope: Scope) {
  const blocks = useDiversityBlocks(scope);
  return blocks ? <RubricView scope={scope} blocks={blocks} /> : null;
}
