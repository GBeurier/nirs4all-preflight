# Audit de l'intégration de nirs4all preflight

État des checkouts locaux inspectés le 12 octobre 2026. Cet inventaire établit les frontières et les points d'intégration ; il ne qualifie pas les exécutables ni les distributions publiques. Les versions de catalogue et les symboles ne suffisent pas à prouver la disponibilité d'une opération dans un langage.

## Sources et périmètre

Source principale : `qualification_nirs_architecture_plan.docx`, version du 14 septembre 2026, SHA-256 `7670941ce51943f37a8b92b7c1df16ca3b67b5b4970f1a96d41555853db77d1c`.

Le fichier voisin `audit_metriques.docx` concerne surtout des métriques de comparaison de modèles et un manuscrit. Il ne constitue pas un deuxième cahier des charges de Preflight. Son exigence de définitions, dénominateurs et seuils explicites est pertinente ; ses corrections de Nemenyi et de CRPS restent hors périmètre.

Les instructions racine et celles des dépôts pertinents sont prises en compte. Formats, IO, Methods et Web ont été interrogés via CodeGraph avant les recherches de code. Les exports UI, manifestes, catalogues et en-têtes publics complètent cet examen. Les répertoires privés Lab et Drafts sont exclus ; aucun contenu privé n'a été utilisé.

La vérification ciblée après review inclut aussi DAG-ML via CodeGraph. `crates/dag-ml-wasm/Cargo.toml` utilise wasm-bindgen, js-sys et wasm-bindgen-futures : DAG-ML est un module Rust/WASM, distinct du module Emscripten libn4m. `crates/dag-ml-wasm/src/initial_refit.rs` expose une exécution REFIT avec contrôleurs runtime et callback JS synchrone. L'index identifie `crates/dag-ml-core/src/methods_estimator.rs` ; une absence générale d'API estimateur Rust ne peut donc pas être déduite d'anciennes notes. La couverture exacte de la sonde imbriquée reste à qualifier au lot 0.

## Responsabilités et réutilisation

| Dépôt | Contrat constaté | Conséquence pour Preflight |
| --- | --- | --- |
| `nirs4all-formats` | Workspace Rust 2021 ; records spectraux avec axes, dimensions, unités, type de signal et provenance ; lectures mémoire distinguées des lectures nécessitant le filesystem. | Réutiliser les lecteurs ; disponibilité par format et cible à vérifier. |
| `nirs4all-io` | `DatasetSpec`, sources, partitions et folds ; séparation core pur/façade IO ; assembleur sans filesystem utilisé en WASM ; contrats JSON canoniques. | Consommer les objets assemblés ; ne pas reconstruire joins, identités ou splits aléatoires dans le loader. |
| `dag-ml-data` et `dag-ml` | Couche de données et orchestration ML séparées ; agrégat et Web s'appuient sur ces contrats. | Consommer les plans de validation groupée et les exécutions de sonde ; auditer les capacités exactes au premier lot. |
| `nirs4all-methods` | Méthodes natives, ABI C, vues de matrices avec strides, wrappers multi-langages et WASM. | Réutiliser PCA, prétraitements, PLS et AOM existants via un fournisseur, avec versions et limites explicites. |
| `nirs4all-core` | Agrégat portable, sans nouvelles méthodes ni nouveaux loaders. R produit déplacé dans `nirs4all-r`. | Ajouter un domaine de qualification après livraison du package amont ; ne pas ajouter de moteur dans Core. |
| `nirs4all-r` | Produit utilisateur `nirs4all`, composant n4m/DAG/IO ; aucune réimplémentation numérique. | Prévoir un binding amont puis une façade produit R. |
| `nirs4all-ui` | Composants React sans état applicatif, IO, browser globals ou runtime ; domaines `viz`, `lab`, `dataset`, `runtime`. | Réutiliser graphiques et alertes ; ajouter des composants de qualification et leurs contrats de présentation. |
| `nirs4all-web` | Client React/Vite/WASM actif sous `web-app/`, worker avec progress/cancel, GitHub Pages. | Ajouter la page de qualification et son adaptateur worker dans le client actif. |
| `nirs4all-quality` | Produit guidé de laboratoire : re-mesure, sélection HPLC, calibration, prédiction et maintenance. | Consommateur possible du moteur et des composants ; préserver son parcours distinct. |

## Points de code confirmés

`nirs4all-ui/src/viz/index.ts` exporte notamment `SpectraPlot`, `Histogram`, `PcaScatter`, `BoxPlot`, `FeatureImportanceBar`, `FoldStabilityLines` et `ScoreHeatmap`. `src/lab/index.ts` exporte `DecisionCard`, `HealthFindingRow`, `StepProgress` et `WorklistTable`. Le contrat `HealthFindingInput` ne transporte pas encore toute la provenance, l'incertitude et les scopes nécessaires à la qualification scientifique. Son adaptation doit conserver ces champs dans la vue experte.

`nirs4all-methods/cpp/include/n4m/decomposition.h` expose `n4m_decomposition_flexible_pca_*` pour create/fit/transform/output-cols. Ces déclarations n'offrent pas d'accesseur dédié aux valeurs propres, loadings et résidus complets. Le helper interne `cpp/src/core/common/pca_helper.c` calcule scores et variances expliquées ; il ne doit pas être lié directement comme API publique. Une extension de diagnostic publique est donc un point de gate.

Le catalogue `catalog/methods/aom_pop.aom_pls.yaml` décrit `n4m_model_selection_aom_pls_select`, des getters de résultats et l'entrée `fold_ids`. Il contient aussi une tolérance de parité `tbd` et ne constitue pas une preuve de qualification. Une campagne ciblée doit vérifier les folds, la sélection de prétraitement et le transfert des états appris dans chaque environnement.

`nirs4all-web/web-app/src/engine/worker-engine.ts` fournit déjà le mécanisme de jobs, progression, refus typés et annulation par destruction du worker. La passerelle Rust/WASM de Preflight pourra s'appuyer sur ce mécanisme, mais devra traiter explicitement les copies et ownership entre les mémoires Preflight/wasm-bindgen, DAG/wasm-bindgen et libn4m/Emscripten.

## Révisions locales inspectées

| Dépôt | HEAD |
| --- | --- |
| Formats | `8c6acd6b02b0bb746ae8df43efa062515ef4a774` |
| IO | `27c7cf064bb5e31b13b8b67f9c47a370b999d75d` |
| Methods | `1adf214c3c2204095e21a9ff1cdebf6faaf2d4d2` |
| UI | `db401cdcee0d60b102b0894310d6bb994701255a` |
| Core | `5668796aaac9a02d8d0146ec05ead04f9c76657c` |
| R | `1c6f4a7f1b42a5d550cabc4809e957680630a4d7` |
| Web | `0ec8790b4afc896a01c0f85ef59f9e347a83c3a2` |
| Quality | `6d68810b4b5961eb6a77f881f35f8cf7e33480a2` |
| DAG-ML | `c6b52979745397ae4e8662580df79341f0378d28` |
| DAG-ML-Data | `5ab19aec77fdca443c83a24a6b9d663c41a82b4a` |

Ces SHA servent de point de départ documentaire, pas de versions minimales de distribution. La cohorte d'implémentation devra être épinglée sur des releases réellement installables et les tests exécutés à nouveau.

## Références scientifiques externes

La [documentation de validation imbriquée](https://scikit-learn.org/stable/auto_examples/model_selection/plot_nested_cross_validation_iris.html) décrit le biais produit par une sélection et une évaluation sur les mêmes folds. Cela justifie une sonde avec sélection interne et évaluation externe distinctes.

La [documentation HDBSCAN](https://hdbscan.readthedocs.io/en/latest/faq.html) précise les limites en haute dimension. La [prédiction de nouvelles affectations](https://hdbscan.readthedocs.io/en/stable/api.html) maintient une partition existante et ne correspond pas à un reclustering de l'ensemble augmenté. La politique de stabilité de Preflight devra choisir et déclarer le cas évalué.

La [publication de Ray et al.](https://nph.onlinelibrary.wiley.com/doi/10.1111/nph.71513), publiée initialement le 17 août 2026, est bien identifiable. Elle présente des architectures de corrélations de longueurs d'onde dans une étude de populations végétales. Cette portée ne justifie pas des seuils génériques de calibrabilité ni un effectif minimal universel. Les valeurs de rarefaction mentionnées dans le DOCX ne sont donc pas reprises comme règles produit.

Les [choix de modèle d'ICC](https://pmc.ncbi.nlm.nih.gov/articles/4913118/) et les [interfaces MEX](https://www.mathworks.com/help/matlab/ref/mex.html) servent de références aux exigences correspondantes. Les protocoles retenus sont détaillés dans la spécification, avec leurs limites de support.
