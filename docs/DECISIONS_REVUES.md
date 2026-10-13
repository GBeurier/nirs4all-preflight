# Décisions issues des reviews de nirs4all preflight

12 octobre 2026. Les avis originaux sont conservés dans `reviews/`. Les corrections ci-dessous sont intégrées à la spécification 0.2 et à la roadmap. Il s'agit d'une validation de conception ; les gates scientifiques, ABI et produit restent à exécuter pendant l'implémentation.

## 1 Review du document source

La review Codex et la review Opus ont été réalisées avant rédaction de la spécification. Opus a effectivement été exécuté via Claude Code CLI avec le modèle `claude-opus-5-5`. Son avis initial est livré sur deux pages A4. Le DOCX original est conservé sans modification, avec son SHA dans l'audit.

| Finding | Décision intégrée |
| --- | --- |
| Pseudo-réplication | Observation, sample, référence et groupes distingués ; analyses de structure après agrégation homogène ; voisins/folds/rééchantillonnages respectent les unités. Pas de n effectif universel. |
| Fuite par AOM | Trois vues nommées ; vue supervisée descriptive ; sélection interne et évaluation externe ; AOM reporté après V1 ; géométries de folds non concaténées. |
| SNR/ICC | Répétabilité absolue prioritaire. Ratio inter/intra nommé discrimination relative ; SNR instrumental hors profil initial ; ICC modèle/plan/conditions déclarés. |
| Confounding | Associations métadonnées–Y dès le MVP ; effets marginaux/non-identifiables, dispersion et permutations adaptées ensuite. Aucune part additive ou causalité inventée. |
| Clusters/bootstrap | Sous-échantillonnage sans remise, comparaisons sur identités communes, bruit et fraction comparée. Profil PCA borné avec sensibilité ; analyse parallèle/CV-PCA possible ultérieurement. |
| Y, censure et mixtures | Couverture d'abord ; censure et références exactes distinguées ; GMM/multimodalité conditionnelles, hors MVP. |
| WASM et réutilisation | Spikes des deux mémoires et fournisseur asynchrone ; Methods/DAG conservés ; aucune statistique TypeScript ; page Web et composants UI. |
| MVP trop large | MVP utile PF-00→03 ; sonde PF-04 ; structure avancée PF-05/06 ; réseaux PF-11 hors estimation V1. |

Trois avis sont adaptés avec justification. Les groupes physiques inconnus n'interdisent pas l'intégrité et les descriptions, mais limitent les inférences. Le terme SNR reste réservé à un éventuel protocole instrumental défini, plutôt qu'interdit comme concept. Les erreurs techniques certaines d'alignement ou de mémoire restent bloquantes avant calcul ; les seuils statistiques ne bloquent pas automatiquement une calibration. La sonde est livrée juste après le MVP pour éviter qu'une dépendance DAG retarde les diagnostics de mesure.

## 2 Review finale Astra

La review indépendante Astra porte sur le draft 0.1 écrit après réception de l'avis initial d'Opus. Son verdict est favorable au lancement du lot de faisabilité sous réserves ciblées. Tous ses findings sont traités dans le contrat 0.2 ; les preuves d'exécution correspondantes deviennent des gates, pas des réussites supposées.

| Finding Astra | Traitement dans la spécification et la roadmap |
| --- | --- |
| P0-1 Étanchéité des identités liées | §3/4 : composantes indivisibles avant agrégation ; intersections physiques/parents/individus à chaque partition et niveau CV. Fixture de mêmes objets sous observation_ids distincts, PF-00/04. |
| P1-2 Permutations contractuelles | §6 : PermutationPlan avec hypothèse, unité, restrictions, modèle réduit, cardinalité/résolution et refus de schémas non qualifiés. Appliqué dès PF-03. |
| P1-3 Nul des contrastes locaux | §5.5 : contraste global préspécifié ; absence de seuil brut commun ; nul conditionnel pour test local ultérieur ; proportions catégorielles sur voisins admissibles. |
| P1-4 Censure et référence composite | §3 : valeurs exactes admises, exclusions explicites sans LOD/2, dépendance reference_group_id ; pas de duplication comme labels indépendants. |
| P1-5 Seuils tardifs | §6 et roadmap : gate scientifique dans chaque lot ; unknown/exploratoire avant calibration ; PF-09 élargit la preuve. |
| P1-6 Spike DAG/WASM | §8 et PF-00 : deuxième spike train/transform/predict réel à deux folds groupés ; ownership phases/états et refus de réponses tardives. |
| P1-7 Garantie des pointeurs | §7 : préconditions C explicites, wrappers responsables, pas de preuve impossible d'allocation ; durée de vie/mutation/handles/panic définis. |
| P2-8 ICC par bande | §5.2/6 : ICC(1,1) de mesure unique et ANOVA nommée ; équilibre après masque ; undefined/unsupported distingués ; valeurs négatives conservées. |
| P2-9 Clusters et annulation | §5.7 : confiance conditionnée à fraction comparée, appariement Jaccard versionné ; §9 : snapshots terminés gardés par l'hôte avant destruction. |
| P1-10 Estimation et dépendances | Roadmap §2 : dette amont séparée, réserve 20–30 %, matrice OS/langage et capacité des propriétaires à confirmer à J0. |

## 3 Review finale Opus

La review finale Opus est une review documentaire du même draft 0.1. Aucun outil de dépôt n'était activé pour ce reviewer ; des intentions de commandes apparaissent dans sa session comme texte, sans exécution. Les notes de session qu'il cite sur DAG-ML ne sont pas une preuve de capacité actuelle. Le contrôle ciblé du principal confirme un module DAG Rust/wasm-bindgen et l'existence d'un adaptateur Methods ; leur couverture de sonde reste à qualifier.

| Finding Opus | Décision intégrée |
| --- | --- |
| P0-1 Voisins/permutations et indépendance | Unité d'indépendance déclarée, exclusion par défaut de cette unité ; sensibilité intragroupe étiquetée ; tests non identifiables si unité unknown ; aucun échange automatique de blocs non qualifié. |
| P0-2 Répétitions inconnues | Contrôle obligatoire de répétitions présumées sous hypothèse d'unicité, taux de paires/observations suspectes et confiance limitée ; ne pas reconstruire des identités certaines à partir de Y identique. |
| P0-3 Pilote de sonde | DAG-ML possède toute la CV et la sélection ; ValidationProvider reçoit une sonde complète et rend OOF/folds/populations ; Preflight ne recrée pas la boucle. Gate et charge amont explicites. |
| P1-1 Transport synchrone/asynchrone | Spike callback synchrone dans le même worker en priorité ; repli via une seule machine à états Rust commune CPU/WASM ; pas de deux implémentations de protocole. |
| P1-2 Instances n4m | Résolveur par hôte, ABI/hash vérifiés ; instance Emscripten partagée dans la page ; copie privée statique isolée et interdiction d'échanger des handles. |
| P1-3 Dimension PCA | d95 n'est plus le seul sélecteur ; compression modérée bornée, sensibilités et dominante PC1 signalée. Une variance dominante ne prouve pas une nuisance. Horn par permutation naïve des colonnes n'est pas retenu par défaut car l'autocorrélation NIRS serait détruite. |
| P1-4 Résolution des permutations | Budget 999 initial par test global et plan avec cardinalité/résolution ; absence de conclusion si multiplicité et résolution l'empêchent. Ne pas augmenter automatiquement le budget sans borne. |
| P1-5 Mémoire WASM | Somme des high-water marks des modules et buffers JS ; snapshots/recréation de worker possibles ; profil étendu non qualifié avant mesure. |
| P1-6 Chiffrage | PF-00 10–14 j, PF-01 16–22 j ; coûts amont bornés additionnels 8–22 j, autres coûts inclus identifiés ; V1 124–196 j avant réserve, 149–255 avec réserve indicative. |
| P2 Dimension effective | Moments exacts via fournisseur ou calcul Rust par blocs, avec budget ; pas de D_eff exact à partir d'un spectre tronqué. |
| P2 Répétitions inégales | Dispersion des r_i et sensibilité équilibrée documentées ; pas de suppression silencieuse des samples non répétés. |
| P2 R² et OOF | R² descriptif standard et skill_vs_train_mean distincts ; baseline apprise dans les trains ; une prédiction par sample après agrégation homogène. |
| P2 Clusters, métadonnées, RNG | Mise à l'échelle déclarée des paramètres de densité ; holdout de dépendance pertinent et classes évaluables ; RNG core figé, seeds fournisseurs exactes et distinctes. |
| P2 Bindings et MVP | R/Cargo/vendorisation et conflits libstdc++ MATLAB qualifiés ; ICC équilibré dans PF-02 ; permutation/descriptif explicités dès PF-03 ; profileStatus obligatoire dans UI. |
| Amendement 2026-10-13 : noyaux numériques | Règle « n4m first » : statistiques d'association, permutations (PCG64), HDBSCAN et ARI sont des noyaux C++ de Methods ; Preflight garde le protocole et la dérivation des seeds. Remplace « RNG core figé » et l'implémentation Rust candidate de HDBSCAN. |

Deux suggestions statistiques ne sont pas reprises comme assertions générales. La moyenne des Y d'évaluation dans le dénominateur du R² standard ne fuit pas vers le modèle : elle normalise son évaluation ; le gain face à une baseline de train est une autre métrique, fournie séparément. Le plafond proposé `1 − σ_ref²/s_y²` pour un contraste local exige des hypothèses de bruit indépendant, homogène et de signal parfait ; ce n'est pas une borne universelle des observations. La précision de référence reste publiée et utilisée dans un protocole explicite, sans plafond présenté comme certain.

## 4 Limites de la clôture documentaire

Les reviews ne prouvent ni justesse de l'implémentation Rust, ni exécution dans les cinq langages, ni disponibilité MATLAB. Les points nécessitant des essais deviennent des critères d'acceptation explicites. La première action de développement est PF-00 ; aucune publication ou modification de code produit n'est réalisée dans cette phase.
