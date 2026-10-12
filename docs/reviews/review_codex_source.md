# Review du document source par Codex

12 octobre 2026. Source : `qualification_nirs_architecture_plan.docx`, version du 14 septembre 2026. Review de conception, sans validation expérimentale des algorithmes.

Le projet a une bonne orientation : séparer intégrité, mesure, couverture, structure, relation X–Y et validation, puis restituer des constats accompagnés d'actions. Le refus d'une note unique et la distinction entre géométrie intrinsèque et vue supervisée doivent être conservés. Le plan initial exige toutefois des corrections avant de devenir une spécification implémentable.

## Corrections prioritaires

**P0 — Définir les unités indépendantes.** Une acquisition, une répétition technique et un échantillon physique ne sont pas interchangeables. Chaque résultat doit compter observations, échantillons, groupes et références disponibles. Les voisins doivent exclure les répétitions du même échantillon. Splits, rééchantillonnages et permutations doivent respecter la dépendance réelle. Le nombre d'identifiants distincts ne suffit pas à établir un « n effectif » statistique universel.

**P0 — Fermer le protocole supervisé.** La mention « AOM sous CV » est insuffisante. Sélection de prétraitement, nombre de composantes, imputation et centrage doivent être appris dans les entraînements internes ; la sonde se mesure sur les folds externes. Les géométries apprises séparément par fold ne peuvent pas être empilées comme un unique espace spectral. Une vue AOM refittée sur les données de développement sert à l'exploration, avec un étiquetage explicite. Toute décision après inspection d'un test rend ce test exploratoire pour la suite.

**P0 — Corriger les définitions scientifiques.** Le ratio de dispersions inter/intra du DOCX mesure une discrimination entre échantillons relativement à la répétabilité ; il ne constitue pas automatiquement un SNR instrumental. L'ICC doit déclarer son modèle, ses conditions et ses intervalles. Saturation et raccordement instrumentaux exigent les unités, limites et jonctions connues ; sinon seule une suspicion peut être rendue. Une cible constante, un axe absent ou une information manquante doit produire un état explicite.

**P0 — Préserver les frontières des dépôts.** Les parsers restent dans Formats, l'assemblage et les identités dans IO, les méthodes existantes dans Methods, la validation ML dans DAG-ML. Le moteur de qualification et ses statistiques nouvelles peuvent être écrits en Rust ; PCA, PLS, prétraitements et AOM existants sont consommés via un fournisseur. La couche UI conserve des composants de présentation ; le navigateur conserve workers et persistance. Aucune réimplémentation scientifique dans les bindings.

**P1 — Réduire le MVP.** L'ordre initial fait dépendre la valeur utilisateur de HDBSCAN, de modèles de mélanges et d'AOM. Un premier livrable utile doit qualifier l'intégrité, la répétabilité, la couverture X/Y et les contradictions locales. Clustering robuste et explication par métadonnées forment un lot ultérieur ; les réseaux restent expérimentaux.

**P1 — Définir la stabilité des partitions.** Le bootstrap avec remise déforme les densités et crée des doublons. Préférer des sous-échantillonnages sans remise d'unités indépendantes, comparer les identités communes, puis rapporter ARI, fractions assignées et bruit séparément. Un sous-ensemble assigné trop petit ne permet pas une conclusion forte. Les probabilités HDBSCAN décrivent une force d'appartenance, pas une probabilité de vérité.

**P1 — Encadrer confounding et seuils.** Les parts expliquées par site, instrument et cible ne sont pas nécessairement additives. Un plan confondu doit pouvoir conclure « effets non identifiables ». Les tests doivent déclarer l'échangeabilité, la dispersion et la multiplicité. Une structure continue ou une puissance insuffisante sont des conclusions recevables ; aucun seuil universel ne garantit la calibrabilité.

**P1 — Rendre la portabilité vérifiable.** Le navigateur existe déjà avec un worker ; les composants `viz` et `lab` sont réutilisables. La présence d'un symbole C ou d'un catalogue n'atteste pas une exécution WASM ni cinq bindings complets. La roadmap doit fixer une matrice par opération et langage, les propriétaires des extensions ABI, les limites mémoire et une qualification MATLAB réelle distincte des tests Octave.

## Verdict

Conserver l'architecture par questions utilisateur et remplacer le plan initial par une progression à gates scientifiques, ABI et produit. Le nouveau nom désigne la qualification des datasets ; les vérifications d'installation/pipeline déjà appelées « preflight » et le produit Quality gardent leurs responsabilités.
