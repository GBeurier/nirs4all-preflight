# Review initiale du document source par Opus

12 octobre 2026. Modèle exécuté : `claude-opus-5-5`, via Claude Code CLI. Avis indépendant, reçu avant rédaction des spécifications.

## Verdict

**Révision majeure avant WP1.** Le cadre est sain : diagnostic orienté questions, contrat commun, pas de note unique, séparation entre vues non supervisée et supervisée. Trois défauts invalideraient cependant les sorties : l'unité statistique n'est pas définie (pseudo-réplication), la vue V1 est réutilisée sans imbrication (fuite de cible), et le SNR/ICC est mal défini.

Les capacités et références citées n'ont pas été vérifiées et ne doivent pas être présumées. C'est le cas de SpectralQualityFilter, `aom_preprocess` supervisé, du caractère global d'AOM, de Ray et al. 2026 et du contenu de quali.nirs4all.org. Leur vérification relève du WP0.

## Findings

**P0-1 — Pseudo-réplication.** Les répétitions entrent comme observations dans la PCA, HDBSCAN, les kNN, le bootstrap, la détection de doublons, PERMANOVA et la CV des métadonnées. Effets attendus :
- cohérence locale triviale, car le plus proche voisin est souvent une répétition avec le même Y ;
- « quasi-doublons » massifs ;
- stabilité gonflée ;
- instrument surestimé comme prédictible.

*Décision :* rendre `physical_sample_id` et une hiérarchie de groupes (lot, site, campagne) obligatoires en entrée. Les analyses structurelles se font après agrégation. Bootstrap, permutations et CV opèrent au niveau sample ou groupe. `n_effective` passe en WP0.

**P0-2 — Fuite de cible via V1.** « Sélectionné sous CV » ne suffit pas. Un opérateur choisi avec tout Y, puis réutilisé pour la sonde PLS, la cohérence locale ou les clusters, rend tout optimiste.

*Décision :*
- V1 reste descriptif et étiqueté « supervisé ».
- Toute métrique prédictive refait la sélection AOM dans chaque pli externe (CV imbriquée et groupée), avec PCA et normalisation ajustées dans le pli.
- La stabilité de l'opérateur entre plis est publiée.
- V1 désigne X transformé par l'opérateur, jamais l'espace des scores PLS.

**P0-3 — SNR/ICC.** σ_between/σ_within n'est pas un SNR : le numérateur mesure la diversité de la population. Le même instrument « gagne » donc en SNR sur un jeu hétérogène. Sur l'absorbance brute, la variance inter-sample est dominée par la diffusion et la ligne de base, ce qui donne un ICC élevé sans information chimique.

*Décision :*
- Rapporter d'abord σ_r(λ), la répétabilité absolue en unités instrument.
- Traiter l'ICC(λ) comme une mesure relative à la population, estimée par composantes de variance (REML, plan déséquilibré), en précisant le type de répétition : rescan, repositionnement ou re-préparation.
- Calculer sur la vue native et sur la vue canonique.
- Bannir le terme SNR.

**P1-4 — Confounding.** « L'instrument explique 31 % » est indéfendable si instrument, site et année sont colinéaires : les parts dépendent alors de l'ordre d'entrée.

*Décision :*
- Fractions uniques et partagées, PERMDISP en complément de PERMANOVA, permutations restreintes.
- Prédiction des métadonnées en CV groupée.
- Surtout, ajouter une matrice métadonnées × Y : c'est elle qui détermine si un split aléatoire est trompeur.

**P1-5 — Clustering et bootstrap.**
- Le bootstrap avec remise crée des doublons qui faussent les densités HDBSCAN. Préférer un sous-échantillonnage sans remise (environ 80 %) avec ARI sur l'intersection.
- La règle 95–99 % de variance donne d = 1–2 sur NIRS brut, où PC1 capte la diffusion, et capte du bruit à 99 %. Préférer l'analyse parallèle ou la CV-PCA.
- Le modèle nul doit être spécifié (gaussienne de même covariance).
- Avec n = 50–300, conclure « continuum » par défaut, sauf preuve contraire.
- Les lectures « V0 seul / V1 seul » sont des hypothèses à croiser avec les métadonnées.
- Scinder V0 en deux : natif (mesure) et canonique fixe, non supervisé et versionné (structure).

**P1-6 — Y et cohérence locale.** Une GMM avec BIC sur un Y arrondi ou censuré produit de faux modes. Limiter cette partie au test de multimodalité et à la couverture. Pour la cohérence locale :
- exclure les voisins du même groupe ;
- fixer k relativement à n ;
- intégrer l'erreur de référence si des répétitions labo existent.

**P2-7 — Réseaux spectraux.** Leur valeur pour la calibrabilité n'est pas démontrée, et densité et transitivité sont dominées par l'autocorrélation des λ adjacentes. Les sortir du MVP et du chiffrage. La référence reste à vérifier.

**P2-8 — Périmètre.** Les lots 1–7 couvrent presque tout le plan. MVP proposé :
- intégrité ;
- unité statistique et n_eff ;
- répétabilité ;
- couverture X/Y ;
- confounding métadonnées × Y ;
- sonde imbriquée et groupée ;
- recommandation de validation.

Le clustering vient ensuite. Aucune alerte « blocking » avant calibration des seuils sur des jeux synthétiques.

## Décisions d'architecture recommandées

1. **Package distinct de nirs4all-quality.** L'inventaire WP0 de quali sert à éviter les doublons, pas à importer du code ni à fusionner les produits.
2. **Aucun parser.** L'entrée est un dataset assemblé par nirs4all-io, avec les clés de groupe exigées. nirs4all-formats reste seul propriétaire des lecteurs.
3. **Périmètre du moteur Rust.** Uniquement les algorithmes propres à la qualification : composantes de variance, kNN, HDBSCAN, permutations, contrat de résultat. PLS, AOM, prétraitements et T²/Q passent par la C ABI n4m de nirs4all-methods, sans réimplémentation.
4. **Risque de faisabilité n°1 : la liaison Rust ↔ C++ n4m en WASM.** Les cibles wasm32-unknown-unknown et Emscripten sont incompatibles. Un spike est obligatoire en WP0. Repli possible : deux modules WASM orchestrés, sans logique en TypeScript.
5. **Une seule surface stable.** C ABI plus JSON à schéma versionné. PyO3, extendr et MEX restent des couches minces au-dessus. La façade R produit passe par nirs4all-r. MATLAB vient en dernier.
6. **Agrégation et sérialisation portables dans nirs4all-core.** Les règles de sévérité sont des données versionnées, séparées des calculs numériques.
7. **Web.** La page vit dans nirs4all-web. Les cartes de rendu sans état vont dans nirs4all-ui. Aucune statistique en TypeScript.
8. **Reproductibilité.** UMAP et t-SNE restent des visualisations optionnelles. Graines fixées et tests golden contre des références (vegan, lme4, hdbscan) pour chaque binding.
