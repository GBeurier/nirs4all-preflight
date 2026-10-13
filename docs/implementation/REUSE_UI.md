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

## Refonte de l'interface (13 octobre 2026)

La démo devient un rapport unique défilant (style nirs4all.org, clair/sombre, FR/EN, mobile). Graphiques ajoutés à `nirs4all-ui/qualification`, tous en SVG sans dépendance, avec survol, clavier et légende : `PopulationFlow` (comptages du moteur, étape par étape), `RepeatabilityProfile` (écart-type poolé et ICC par bande en deux panneaux alignés, sans double axe ; trous aux bandes non calculées, bande de statut par contexte), `EigenvalueScree` (valeur propre / trace rapportée par le moteur et cumul sur le même axe en %), `ScoreMap` (scores ACP colorés par campagne, instrument ou valeur cible), `TargetDistribution` (boîte à quartiles Methods + valeurs déclarées, censurées en creux), `ClassCountBars`, `CapabilityGrid`, `StatTile`. Sélecteurs purs `extract.ts` (aucune statistique ; seules des soustractions de comptages et le rapport valeur propre / trace pour l'affichage). Libellés lisibles des métriques et capacités (`metricLabel`, `capabilityLabel`). La démo ne trace toujours ni les lignes du test réservé, ni ses valeurs Y.

Parcours en étapes (même jour) : **Vos données → Diagnostic → Preuves → Export**. La vue Données n'affiche que l'entrée (aucun calcul, uniquement des comptages) : `SpectraExplorer` (survol de la courbe la plus proche, sélection clic/clavier, trous et triangles aux cellules manquantes ; les lignes de développement incomplètes sont désormais tracées avec leurs trous), composition (partitions, scans par échantillon, campagnes, instruments via `PopulationFlow` à une étape), références déclarées du développement et table d'échantillons triable liée à l'explorateur (valeurs du test réservé masquées). Le diagnostic s'ouvre sur `CheckList` : points de contrôle en clair dérivés des comptages du moteur (zéro → OK ; aucun seuil calibré, aucun score global), chacun lié à son graphique ou à sa preuve.
