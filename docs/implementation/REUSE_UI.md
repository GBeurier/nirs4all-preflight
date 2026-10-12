# UI reuse audit (frontend)

12 octobre 2026. Audit ciblé de `nirs4all-ui` (AGENTS.md, `viz`, `lab`, `brand`, `styles`, `dataset`). Le root a déjà audité Methods, DAG-ML et Core (`REUSE_ROOT.md`, `REUSE_ENGINE.md`) ; aucun appel CodeGraph/MCP ici.

| Besoin | Existant | Décision |
| --- | --- | --- |
| Spectres | `viz/SpectraPlot` (SVG, description textuelle) | **Réutilisé** dans l'onglet Données pour tracer les valeurs d'entrée brutes (pas de moyenne/enveloppe calculée en JS). |
| Palette, couleurs partition | `viz/theme` (`N4_CATEGORICAL`) | **Réutilisé**. |
| Scatter PCA | `viz/PcaScatter` | **Réutilisé** (onglet Structure) : points lus tels quels dans `structure.pca_scores` du moteur, sans calcul ; pas de pourcentage de variance par axe (non rapporté par le moteur), fraction retenue affichée depuis `structure.explained_variance_retained`. Table des scores via `ChartDataTable`. |
| Équivalent tabulaire | `viz/description.ts` (résumés de données pour SVG) | Réutilisé comme principe ; ajout de `ChartDataTable` (tableau « Données du graphique » pour toute figure). |
| Lignes de constat | `lab/HealthFindingRow` + `lab/health.ts` | **Non réutilisé** : modèle « santé » (catégories fixes, action accept/remeasure, compte d'affectés, classes Tailwind `text-success`) ≠ constat Preflight (rule_id, confiance `unknown`, preuves = metric_id, sévérité). `FindingList` dédié. |
| Statuts de décision / badges | `lab/DecisionBadge`, `runtime/RuntimeResultStatusBadge` | Non réutilisés : sémantique feu tricolore/décision ; Preflight n'émet pas de décision (profil exploratoire). Badges dédiés (statut de profil, disponibilité + raison, confiance). |
| Locale FR/EN | `lab/locale.ts` (`Locale`, `LocalizedText`, `loc`) | **Réutilisé** par le domaine `qualification` et la démo. |
| Marque | `brand` + `assets/brands/nirs4all/icon.svg`, `theme.css` | **Réutilisé** (icône flagship copiée en `public/brand-icon.svg`, teal `#058E96` / rouge `#E9362D`, CSS thème partagé). Pas de nouvelle marque inventée. |
| Wizard / upload | `datasetBuilder`, `dataset` | Non réutilisé : ce wizard assemble des fichiers/colonnes ; la démo ne charge que le JSON canonique déjà assemblé (pas de parseur). |
| Tableaux | aucun composant générique de table de preuves | Créés : `EvidenceTable`, `CapabilityTable` (tables natives, `scope="col/row"`, région focusable). |

## Domaine ajouté `nirs4all-ui/qualification`

Pur et sans état : `types.ts` (contrats), `report.ts` (adaptateur rapport moteur snake_case → modèle d'affichage, normalisation conservatrice : statut de profil inconnu → exploratoire, disponibilité inconnue → erreur, confiance inconnue → `unknown`, valeur forcée à `null` hors `computed`), `locale.ts`, composants `ProfileStatusBadge`, `AvailabilityBadge`, `ConfidenceBadge`, `SeverityBadge`, `EvidenceTable`, `FindingList`, `CapabilityTable`, `AvailabilitySummary` (barre SVG + tableau), `ChartDataTable`, `QualificationOverview`. Feuille de style : `assets/qualification.css`. Aucun calcul numérique (seulement comptage de statuts pour l'affichage), aucune E/S, aucun global navigateur.

## Frontière démo

La démo (`demo/`) n'implémente aucune statistique. Le générateur « synthétique » ne produit que du JSON d'entrée, déclenché par des boutons étiquetés. Sans moteur WASM (`src/runtime.ts`), l'analyse échoue avec `ENGINE_UNAVAILABLE` et aucun résultat n'est affiché. Le HTML téléchargeable vient de `runtime.reportHtml`.
