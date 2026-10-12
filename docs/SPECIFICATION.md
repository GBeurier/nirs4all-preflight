# Spécification de nirs4all preflight

Version 0.2 — 12 octobre 2026 — Conception revue par Astra et Opus, sans implémentation démarrée.

`nirs4all-preflight` qualifie un dataset NIRS avant entraînement. Il aide à décider si les mesures sont exploitables, quel domaine est couvert, quels problèmes vérifier et quelle validation choisir. Le moteur et les nouveaux diagnostics sont écrits en Rust. Une seule implémentation alimente Rust, Python, R, WASM et MATLAB ; la page navigateur compose les composants partagés de `nirs4all-ui`.

La [roadmap](ROADMAP.md) définit les lots et gates. L'[audit d'intégration](AUDIT_ECOSYSTEME.md), la [review Codex](reviews/review_codex_source.md) et la [review initiale Opus](reviews/review_opus_source.md) motivent les décisions. Le backlog de travail de l'écosystème reste `../../_backlogs/BACKLOG_CONSOLIDE.md` ; la présente roadmap détaille les features proposées, sans créer un deuxième registre de statut.

## 1 Objectifs et périmètre

Le public principal est un analyste NIRS disposant de spectres, de références éventuellement partielles et de métadonnées. Un utilisateur expert doit pouvoir auditer chaque résultat, retrouver le protocole et reproduire le calcul dans son langage. Aucune sortie ne promet à elle seule qu'une calibration atteindra une performance donnée.

Le parcours comporte six questions : les données sont-elles techniquement valides ; les acquisitions sont-elles répétables ; les domaines X et Y sont-ils couverts ; quels facteurs structurent les données ; les voisins spectraux sont-ils cohérents avec les références ; quelle validation répond à l'usage visé ? La synthèse conserve ces dimensions et des constats hiérarchisés. Elle ne calcule pas de note globale sur 100.

| Livrable | Périmètre |
| --- | --- |
| MVP utile | Intégrité, identités et groupes, répétabilité absolue, bruit indirect, couverture X/Y, contradictions locales, associations métadonnées–Y, recommandations de validation, export JSON/HTML et page web. |
| Version 1 qualifiée | MVP, sonde PLS/PCR groupée, clusters avec stabilité, confounding multivarié, domain shift, bindings installables dans les cinq environnements. |
| Extensions | AOM supervisé, ICC déséquilibré avancé, mélanges de Y, visualisation UMAP/t-SNE et réseaux spectraux. |
| Hors périmètre | Calibration de production, active learning/HPLC, surveillance des modèles, remplacement de Quality/Studio, parsers propriétaires, backend de calcul Python, prise en charge générale des images ou séries ragged. |

L'entrée V1 est une ou plusieurs sources spectrales denses, chacune avec son propre axe ; les analyses se font par source et par cible. Une jointure de sources n'est pas implicite. Les objets N-D ou ragged reçoivent un refus de profil explicite ; un hôte peut proposer un extrait dense via IO en conservant sa provenance. Les cibles continues et catégorielles ont des protocoles distincts. Censure, arrondi, limites de détection et précision de référence doivent être transportés lorsque disponibles.

## 2 Architecture et responsabilités

| Couche | Propriétaire | Responsabilité |
| --- | --- | --- |
| Décodage des fichiers | `nirs4all-formats` | Records, axes et provenance instrumentale ; support mémoire/WASM par format. |
| Dataset | `nirs4all-io` / `dag-ml-data` | Assemblage, identités, alignement, partitions, groupes et plan de données. |
| Qualification | `nirs4all-preflight` | Protocoles Rust, nouvelles statistiques propres au diagnostic, règles, contrats, orchestration des analyses et résultats. |
| Méthodes existantes | `nirs4all-methods` | PCA/SVD, prétraitements, T²/Q, PCR/PLS et AOM via API publique ; extensions de diagnostics dans ce dépôt. |
| Validation ML | `dag-ml` | Plans de folds, sélection, exécution de sonde par phase et fold ; pas de second moteur CV dans les bindings. |
| Agrégat | `nirs4all-core` | Réexports, compatibilité et packaging du domaine `qualification` ; aucune nouvelle statistique. |
| R produit | `nirs4all-r` | Façade `nirs4all::qualify()` au-dessus du binding amont. |
| Présentation | `nirs4all-ui` | Contrats de vues et composants sans état applicatif, IO ou runtime. |
| Page web | `nirs4all-web/web-app` | Import, configuration, worker, persistance facultative et téléchargement de rapports. |
| Autres hôtes | Python complet, Studio, Quality | Adaptation de leurs datasets et restitution ; aucune copie du moteur. |

Cette répartition maintient la doctrine de réutilisation tout en respectant Rust pour le nouveau moteur. Les diagnostics nouveaux, comme la répétabilité, les tests d'association et la stabilité de partitions, ont leur source de vérité ici. Une méthode générique déjà disponible en Methods est consommée via fournisseur, jamais recodée en Rust ou TypeScript pour contourner une capacité absente. Si une future statistique devient une méthode partagée, un transfert explicite de propriété doit précéder sa duplication.

Le workspace proposé contient `crates/nirs4all-preflight-core` pour les données, statistiques et règles pures ; `crates/nirs4all-preflight` pour l'API d'analyse et ses adaptateurs ; `crates/nirs4all-preflight-capi` pour l'ABI ; `crates/nirs4all-preflight-cli` pour l'outil en ligne de commande ; et `bindings/{python,r,wasm,matlab}`. Les bindings utilisant un outillage spécifique sont exclus du workspace principal, comme dans Formats/IO. Le core n'accède ni au filesystem ni au réseau. Les dépendances intra-workspace ont `path` et `version`, une édition Rust 2021 et des versions synchronisées.

`nirs4all-quality` demeure le produit de laboratoire. Il pourra consommer ce moteur pour sa phase amont ; sa calibration, sélection de références et maintenance restent indépendantes. Le terme `qualification` est utilisé dans les façades publiques pour éviter la confusion avec les contrôles d'installation/pipeline déjà nommés preflight.

## 3 Données et unités statistiques

L'adaptateur consomme un dataset déjà assemblé. Il construit un `QualificationInput` sans réinterpréter les joins ou conventions IO. Chaque source transporte `source_id`, `observation_ids`, `sample_ids`, matrice X, masque de validité, axe, unités, type de signal et provenance. Chaque cible transporte `target_id`, type, valeurs, masque, unités et identifiants de référence. Les métadonnées sont typées ; aucune chaîne numérique n'est convertie silencieusement.

Une observation est une acquisition. Un `physical_sample_id` est l'objet physique sur lequel peuvent exister plusieurs acquisitions. Un `reference_id` désigne une mesure de laboratoire. Les clés de lot, site, instrument, campagne, parent d'augmentation ou individu décrivent des dépendances ou domaines de généralisation ; elles ne sont pas substituées automatiquement à l'identité physique.

| Champ | Exigence et comportement |
| --- | --- |
| Identités | L'alignement explicite par identifiant est obligatoire ; l'égalité du nombre de lignes ne suffit pas. Les acquisitions répétées ont des observation_ids distincts. |
| Identité physique inconnue | Intégrité et descriptions restent possibles. L'hôte peut déclarer « une acquisition par objet » ; cette hypothèse est enregistrée. Les inférences indépendantes restent limitées tant qu'elle n'est pas justifiée. |
| Répétitions | Type déclaré : rescan, repositionnement, re-préparation, biologique ou inconnu. Les groupes mixtes ne sont pas combinés en une seule erreur de mesure. |
| Groupes | Hiérarchie et facteurs croisés conservés. Le profil de validation choisit explicitement l'unité indépendante et la clé tenue à l'écart. |
| Références | Une valeur de Y peut être commune aux acquisitions d'un sample ; ses répétitions labo restent distinctes. Pas de moyenne implicite de références contradictoires. |
| Sources partielles | Analyse source par source sur l'intersection explicite de samples et du masque de la cible ; publication du dénominateur et des exclus. |
| Augmentations | Les acquisitions générées sont exclues par défaut de la qualification du dataset réel et des OOF ; provenance parent conservée. |
| Partitions | Train/développement, test réservé et prédiction sans Y restent distincts. Aucun FIT sur le test réservé. |

Le rapport publie `n_observations`, `n_physical_samples`, `n_reference_measurements`, `n_independent_units` et `n_validation_groups`, avec les hypothèses. Le champ `n_effective` reste nullable et ne reçoit une valeur que si un estimateur nommé est réellement calculé. Compter les samples n'est pas une correction universelle de corrélation intra-lot.

Les diagnostics de mesure utilisent les acquisitions natives. Les diagnostics de structure utilisent, par défaut, la moyenne des acquisitions techniques d'un même sample dans un contexte source × instrument × campagne homogène, avec poids égal par sample. Les contextes différents restent séparés ou utilisent un protocole explicitement multicontexte ; aucune moyenne ne gomme un effet instrument. L'agrégation et le dénominateur sont inscrits dans chaque résultat.

Avant toute agrégation, le plan construit les composantes d'identités indivisibles pour l'analyse : objet physique, acquisitions liées, parents d'augmentation et individu partagé lorsque pertinent. Il distingue ces liens d'identité des facteurs instrument/site servant à décrire le domaine. Les intersections entre composantes FIT et EVAL sont vérifiées sur les partitions d'origine, puis dans chaque niveau de CV. Les facteurs croisés ne sont pas supposés emboîtés : un individu mesuré sur deux sites peut rendre un holdout de site incompatible. Le moteur refuse ce plan ou demande un profil explicitement adapté ; il ne supprime pas des lignes en silence. Une agrégation ne mélange jamais acquisitions des deux partitions. Les hashes de lignes disjoints complètent ce contrôle mais ne le remplacent pas.

Pour X–Y, une référence composite partagée entre plusieurs objets crée aussi une dépendance de référence, transportée par `reference_group_id` et prise en compte dans les folds et permutations. Les mesures exactes individuelles sont admises. Cibles censurées/intervalle et références composites sans protocole adapté sont exclues des calculs exigeant des valeurs ponctuelles, avec effectifs et domaine d'interprétation restants. Aucun remplacement par LOD/2, borne ou duplication de référence en valeurs indépendantes. Des références incompatibles d'un sample demandent une décision de référence traçable avant calcul X–Y ; la qualification de X reste disponible.

Le plan déclare `independence_unit` (sample, reference_group, groupe nommé ou unknown), distinct des clés de domaine. Les voisins excluent par défaut cette unité entière ; inclure des voisins du même groupe constitue une sensibilité étiquetée. Avec unité unknown, couvertures et contrastes sont descriptifs, leurs tests sont `not_identifiable` et la sonde inférentielle est indisponible. Une hypothèse d'unicité déclenche un contrôle de répétitions présumées : quasi-identité spectrale et indices concordants de référence, acquisition ou métadonnées. Rapporter seuil/protocole, taux de paires suspectes et fraction d'observations concernées ; ce contrôle ne découvre pas une identité certaine. Tant qu'une suspicion ou l'hypothèse d'indépendance n'est pas résolue, confiance unknown ou low, sans p-value ou sonde présentée comme validée.

Les effectifs de répétition r_i et leur dispersion sont publiés. Une moyenne de plusieurs acquisitions peut être moins bruitée qu'une acquisition unique ; les profils de structure proposent une sensibilité à nombre de répétitions équilibré, avec sous-échantillonnage déclaré et seed. L'absence de répétitions d'un sample ne conduit pas à supprimer ce sample pour fabriquer artificiellement un plan équilibré.

## 4 Vues spectrales et garde contre la fuite

Trois vues sont nommées sans ambiguïté : `native`, `canonical:<protocol>` et `supervised:<target>:<protocol>`. La vue native conserve le signal mesuré. La vue canonique applique une recette non supervisée fixe, déclarée avant inspection de Y ; le profil initial utilise le centrage des variables, sans autoscaling ni whitening. Une sensibilité SNV optionnelle est étiquetée car elle peut supprimer de l'information d'amplitude. Les masques et conversions d'axe sont conservés ; aucune interpolation ou conversion reflectance/absorbance ne se fait sans provenance et paramètres.

La vue supervisée contient X transformé par le prétraitement sélectionné pour une cible, pas les scores PLS. Elle est désactivée dans le MVP et ajoutée après qualification d'AOM. Une vue refittée sur tout le développement est descriptive : clusters et cohérence locale y sont exploratoires, jamais une preuve indépendante de relation X–Y.

Pour toute mesure de performance, un plan externe groupé tient à l'écart des unités indépendantes. Chaque entraînement externe contient une sélection interne groupée des prétraitements et du nombre de composantes. Imputation, centrage, PCA, références MSC et autres états sont appris dans l'entraînement approprié puis appliqués aux lignes tenues à l'écart. Une sonde à recette fixée avant analyse n'exige pas de boucle de sélection des prétraitements, mais toute sélection de composantes reste interne. Les géométries apprises séparément par fold ne sont pas concaténées en un unique espace de clustering.

Le test réservé n'alimente ni sélection, ni seuil, ni recommandation. Une comparaison volontaire du domaine test aux données de développement peut lire X_test dans un profil `external_domain_audit`, sans apprentissage dessus. L'affichage de Y_test requiert un profil d'audit après évaluation ; le rapport marque alors le test comme consulté. Une décision de modèle ou de collecte prise après cette consultation nécessite une autre évaluation indépendante. Les hashes des populations FIT et EVAL, leurs intersections, les folds et le statut du test sont des artefacts obligatoires.

## 5 Protocoles analytiques

Les règles ci-dessous sont des protocoles proposés à versionner et calibrer sur fixtures. Un résultat manquant ne devient pas zéro et une absence de preuve ne devient pas une preuve d'absence. Une erreur d'alignement ou de mémoire peut bloquer une exécution ; une valeur statistique isolée ne bloque pas une calibration.

### 5.1 Intégrité

Contrôler dimensions, overflow, masque, finitude, identités, couverture, doublons et incompatibilité des unités. Un axe spectral connu doit être fini, ordonné et sans doublons ; un axe décroissant peut être renversé avec toutes ses colonnes et une transformation tracée. Les index sans unité permettent les descriptions matricielles mais pas les interprétations physiques de bandes. Les sources dont les grilles diffèrent ne sont pas concaténées silencieusement.

Les NaN/Inf sont rapportés comme anomalies ; le moteur n'apprend pas une imputation par défaut. Chaque protocole déclare s'il accepte un masque, un sous-ensemble complet ou exige des données complètes. La cause de l'exclusion et le nombre de samples restant sont rendus. Les doublons exacts sont calculés après normalisation documentée des floats et du masque ; un doublon technique reconnu n'est pas une erreur. Les quasi-doublons sont testés dans une vue et un contexte déclarés.

### 5.2 Répétabilité et qualité de mesure

Pour une bande λ et des groupes techniques homogènes ayant au moins deux acquisitions, la variance de répétabilité poolée vaut `s_r²(λ) = Σ_i Σ_j (x_ij(λ) − x̄_i(λ))² / Σ_i (r_i(λ) − 1)`. Les effectifs disponibles sont propres à λ. `s_r` est exprimé dans l'unité native ; le poids par degré de liberté, les r_i et la part de samples répétés sont publiés. Une dispersion robuste intra-sample complète cette estimation, avec une formule séparée et versionnée. Les intervalles sont obtenus en rééchantillonnant l'unité indépendante déclarée ; avec trop peu d'unités, le point descriptif reste accompagné de `insufficient_data` pour l'incertitude.

Un modèle `x_ij = μ + u_i + ε_ij` donne, si ses hypothèses sont pertinentes, `ICC = σ_sample² / (σ_sample² + σ_repeat²)`. Le profil initial est l'ICC unidirectionnel de mesure unique, ICC(1,1), équilibré après application du masque propre à λ : `ICC_hat = (MS_between − MS_within) / [MS_between + (r−1) MS_within]`, avec MS les carrés moyens ANOVA, r répétitions et n samples complets. Il ne mesure pas la fiabilité d'une moyenne de r acquisitions. Les plans déséquilibrés reçoivent la répétabilité poolée, et ICC `unsupported`. Variance totale nulle donne `undefined` ; un estimateur ANOVA négatif reste visible et n'est pas ramené à zéro. REML déséquilibré, effets croisés et intervalles associés forment une extension ; les variances contraintes déclarent leur frontière. Un ICC élevé reste relatif à la population et peut refléter diffusion/ligne de base.

Le ratio de dispersions inter/intra est nommé « discrimination relative à la répétabilité » et ne reçoit pas le label SNR. Un SNR instrumental exige un protocole séparé avec bruit et signal de référence instrumentaux ; il n'est pas livré par défaut. Sans répétitions techniques, un résidu de lissage ou une énergie de différences finies est un `noise_proxy` : axe, fenêtre physique, normalisation et comportement aux bords sont déclarés. Le lissage existant passe par Methods.

Saturation n'est confirmée que si les bornes de l'instrument et l'unité sont connues. Une accumulation aux extrema observés est une suspicion de clipping. Le stitching est confirmé seulement sur une jonction connue ; une rupture détectée ailleurs peut être une bande chimique. La carte par λ conserve ses composantes (missingness, répétabilité, suspicion de clipping, rupture), leur disponibilité et leur incertitude, sans moyenne cachée en score de fiabilité.

### 5.3 Dimension et couverture de X

Une PCA du fournisseur Methods est apprise sur les samples de développement dans la vue canonique. Les valeurs propres utilisent la convention de variance `n−1`. Le profil initial choisit une compression modérée `d = min(10, n_samples−2, rang_numérique)` ; n<3 ou rang nul entraîne un résultat indisponible. `d_95` reste un diagnostic, pas le seul sélecteur de géométrie. La fraction expliquée réellement retenue est publiée. Les diagnostics de stabilité comparent d à `d_95`, 5 et 20 lorsque ces dimensions sont admissibles, sans choisir celle donnant le meilleur accord avec Y. Une première composante expliquant au moins 90 % déclenche un constat descriptif `first_component_dominant`, sans l'attribuer automatiquement à une nuisance. Une sensibilité SNV non supervisée est requise avant une conclusion forte de structure/coverage sensible à l'amplitude. Les seuils et cette règle de dimension restent des heuristiques à qualifier dans PF-00/03 ; avant cette preuve, confiance unknown. L'analyse parallèle naïve par permutation de colonnes n'est pas le défaut car elle détruit l'autocorrélation spectrale ; un nul adapté ou CV-PCA exige son propre protocole.

`D_eff = (Σ_a λ_a)² / Σ_a λ_a²` utilise les moments complets, même si les composantes PCA sont tronquées. Ils peuvent provenir du fournisseur ou être calculés exactement en Rust : pour X centré, `Σλ = ‖Xc‖²_F/(n−1)` et `Σλ² = ‖Xc Xcᵀ‖²_F/(n−1)²`. Le calcul de Gram se fait par blocs avec budget d'opérations explicite ; ne pas matérialiser n² doubles par défaut. Si ni ces moments ni le spectre complet ne sont disponibles dans le budget, D_eff est `unsupported`, jamais une dimension exacte issue des seules composantes retenues. `d_90`, `d_95`, `d_99` ont aussi un état d'absence si le spectre qualifié ne permet pas de les déterminer. Un helper interne ne constitue pas une API ; scores/loadings/résidus nécessaires restent des extensions publiques de Methods.

La couverture combine distances à un centre déclaré, T²/leverage lorsqu'ils sont qualifiés, résidus Q et distances aux voisins dans l'espace PCA. Les voisins excluent par défaut la même unité indépendante déclarée, dont toutes les acquisitions du même sample. Les classes descriptives « central, frontière, isolé, extrême » correspondent à des quantiles internes versionnés ; elles ne sont pas des classes de qualité ni une probabilité OOD. Les tailles de voisinage, normalisations et taux de données ignorées sont affichés.

### 5.4 Cibles et références

Pour chaque cible continue : effectif de samples référencés, quantiles, MAD, IQR, étendue, trous entre quantiles/valeurs ordonnées, valeurs censurées et distribution par métadonnée. Des répétitions de laboratoire fournissent une répétabilité de référence séparée. Le coefficient de variation est absent lorsque le niveau moyen est proche de zéro ; une normalisation par IQR vaut `undefined` si l'IQR est nul.

Pour une cible catégorielle : vocabulaire fixé, effectif indépendant par classe et groupe, classes absentes de folds et matrice classe × domaine. Les métriques de régression ne s'y appliquent pas. Cibles manquantes ou constantes permettent la qualification de X mais désactivent les diagnostics X–Y correspondants.

La multimodalité et les mélanges GMM sont des extensions : BIC/ICL, type de distribution, arrondi/censure, régularisation, convergence et stabilité doivent être explicites. Une GMM sur une concentration bornée ou des références discrétisées ne prouve pas plusieurs populations physiques.

### 5.5 Cohérence locale et contradictions

Le profil initial utilise `k = min(10, max(3, floor(sqrt(n_eligible))))`, borné par le nombre de voisins indépendants disponibles ; s'il reste moins de trois voisins, le résultat est indisponible. Les distances sont euclidiennes sur les scores PCA non blanchis. Les voisins sont choisis sans Y dans la vue canonique. Une sensibilité de k est rapportée dans le mode expert.

Pour Y continu, la statistique par sample est `L_i = 1 − mean_{j∈N_i}[(y_i−y_j)²] / (2 s_y²)`, avec variance globale des samples éligibles et poids égal par sample. Elle peut être négative et n'est pas tronquée en score 0–1. Les valeurs de référence et leur précision accompagnent la détection de contradictions. Pour Y catégoriel, rapporter la fraction de voisins de même classe et son écart au niveau attendu avec les proportions des classes. Aucun des deux résultats n'est une performance de modèle.

La calibration compare une statistique globale préspécifiée aux permutations de Y autorisées par le plan ; les alertes locales sont exploratoires ou soumises à un contrôle de multiplicité. Une permutation de Y se fait au niveau du sample/groupe, jamais acquisition par acquisition. Si Y est constant dans chaque bloc autorisé et ne peut être permuté, le test est `not_identifiable`. Les doublons spectraux avec Y incompatible déclenchent « vérifier référence/appariement », sans suppression automatique. La tolérance de quasi-identité et celle de contradiction sont déclarées ; une précision labo absente ne devient pas une tolérance arbitraire.

Le contraste local brut n'est pas comparable directement entre samples : son niveau nul conditionnel dépend de y_i et peut être plus bas pour une référence extrême, même sans relation spectrale. Le MVP publie sa synthèse globale préspécifiée et des différences de référence avec distances spectrales ; il ne déduit pas de contradiction d'un seuil commun sur L_i. Un test local ultérieur maintient la référence focale et construit le nul conditionnel sur les voisins admissibles selon le plan qualifié. Pour une cible catégorielle, le niveau attendu utilise les proportions de classes dans la population de voisins admissibles, sans auto-inclusion.

### 5.6 Sonde de prédictibilité

PLS/PCR viennent de Methods et l'exécution de validation de DAG-ML. Le profil régression teste une grille bornée de composantes sur les entraînements internes, avec folds groupés explicites et budget de fits. La baseline est la moyenne de Y calculée dans le train de chaque fold externe. Publier prédictions OOF, RMSE sample-pondérée, MAE et R² global sur OOF lorsque son dénominateur est non nul, puis l'écart à la baseline et la variabilité par domaine. Les répétitions d'un sample ne créent pas plusieurs votes dans le score.

Une sonde de classification n'est activée qu'après qualification d'un estimateur et de ses probabilités/labels sur tous les hôtes concernés. Balanced accuracy est la moyenne des recalls des classes évaluables selon un vocabulaire fixe ; folds sans classes nécessaires sont signalés et peuvent rendre le profil inapplicable. Un split aléatoire et un split de domaine peuvent être comparés à titre de sensibilité, mais le choix du plus flatteur n'est pas une recommandation.

Une CV externe de 5 folds et interne de 3 constitue un objectif quand les groupes le permettent ; avec moins de groupes, le profil fixe un plan valide plus petit ou un refus. Les intervalles ne traitent pas les folds comme observations indépendantes. La sonde décrit le signal accessible à une famille limitée de modèles ; une sonde faible ne conclut pas que toute calibration est impossible.

Le profil initial agrège les répétitions techniques homogènes avant fit/predict, sans traverser une partition, et produit une prédiction OOF par sample ; aucune moyenne implicite de prédictions sur des contextes différents. Deux scores distincts sont publiés : `R²_OOF = 1 − Σ(y_i−ŷ_i)² / Σ(y_i−ȳ_eval)²`, définition descriptive standard ; et `skill_vs_train_mean = 1 − SSE_model / SSE_fold_train_mean`, où la baseline prédit chaque fold avec sa seule moyenne d'entraînement. Calculer ȳ_eval pour normaliser le score d'évaluation n'apprend rien au modèle et ne constitue pas une fuite. Baseline et modèle ont exactement les mêmes samples et poids ; dénominateur nul donne undefined.

### 5.7 Clustering robuste

L'algorithme principal envisagé est HDBSCAN sur PCA modérée, après un gate comparant une implémentation Rust candidate à une référence. Semantique de `min_samples`, MST, sélection des clusters, gestion des ex aequo et score d'appartenance sont figées. Une implémentation candidate sans persistance ou sans sémantique compatible ne reçoit pas le label de parité HDBSCAN. Ward/GMM sont optionnels ; le MVP ne dépend pas de leur disponibilité.

La stabilité refait agrégation autorisée, centrage, PCA et clustering sur 50 sous-échantillons sans remise de 80 % des unités indépendantes. Les identités communes portent la comparaison. Rapporter ARI sur les samples assignés dans les deux partitions, accord assigné/bruit séparé, taille de l'intersection, fraction comparée et fréquence d'apparition de chaque groupe. Avec moins de deux clusters ou trop peu d'identités communes, ARI est indisponible. Le score d'appartenance HDBSCAN n'est pas une probabilité statistique de groupe réel.

Le protocole fixe `min_cluster_size` dans le jeu complet et le réplique `ceil(0.8 × min_cluster_size)` dans chaque sous-échantillon, sous la borne minimale admise par l'implémentation ; `min_samples` suit la même règle déclarée. Cette politique de mise à l'échelle, l'arrondi et les cas de tailles trop faibles sont figés dans le golden et comparés à la variante à paramètres constants, sans sélection par Y.

Un modèle nul unimodal gaussien avec covariance régularisée dans l'espace PCA, sous les mêmes effectifs et protocole, sert de comparaison exploratoire ; il ne couvre pas toutes les structures continues possibles. Le nombre de clusters n'est annoncé fermement que si stabilité, séparation et taille minimale satisfont des règles calibrées. Sinon : « partition incertaine » ou « données compatibles avec une structure continue ». Les structures natives/canoniques/supervisées sont comparées sur les mêmes samples et accompagnées des taux de bruit. Leur différence suggère une sensibilité au prétraitement, sans attribuer automatiquement la cause à une nuisance ou à la chimie.

La confiance d'une partition dépend aussi de la fraction d'identités effectivement comparée ; un excellent ARI sur un petit sous-ensemble ne donne pas `high`. La fréquence d'apparition d'un cluster utilise un appariement par overlap/Jaccard sur identités communes, avec affectation univoque, seuil et gestion des égalités versionnés. Si l'appariement n'est pas qualifié, seules les distributions du nombre de groupes, de bruit et d'ARI global sont rendues.

### 5.8 Métadonnées et confounding

Le MVP montre tables croisées, couverture de Y par instrument/site/lot, tailles indépendantes et associations univariées adaptées au type, sans langage causal. L'objectif est d'identifier où une validation aléatoire ne couvre pas l'usage annoncé.

La version avancée utilise variance multivariée et PERMANOVA sur des distances euclidiennes PCA, avec effets marginaux, rang du design, facteurs aliassés et diagnostic de dispersion PERMDISP. Les R² marginaux ne sont pas additionnés comme parts exclusives. Le choix de permutation dépend de l'effet testé : permuter des labels de sample, des blocs entiers ou des résidus sous modèle réduit selon un protocole qualifié. Restreindre les permutations à un lot où l'instrument est constant ne teste pas l'effet instrument ; il faut des unités de domaine échangeables et suffisamment répétées. Un plan instrument=site=année peut rendre les effets séparés non identifiables.

Les explications de clusters sont descriptives. La prédictibilité de métadonnées depuis X se mesure sous validation groupée et se compare à une baseline ; elle n'établit pas que la métadonnée cause le signal. Les recommandations se fondent aussi sur les associations métadonnées–Y, l'usage prévu et la couverture des croisements.

La clé de validation tient à l'écart le niveau supérieur de dépendance pertinent (lot/campagne/individu) selon le plan, en vérifiant que les classes de la métadonnée restent évaluables. Si une classe instrument n'existe que dans un unique lot indépendant, sa prédictibilité hors lot n'est pas identifiable, plutôt que qualifiée par un split de samples du même lot.

### 5.9 Domain shift

Une comparaison de campagnes/instruments ou splits utilise un espace appris sur la population de référence puis appliqué à la population comparée. Le rapport sépare déplacement de centre, dispersion, couverture et changement de Y, avec unités et masques constants. Energy/MMD et classifier two-sample sont des profils avancés ; bandwidth, normalisation, échanges de groupes et sélection du classifieur sont déclarés et qualifiés. Un écart spectral ne prouve pas une baisse de performance et une absence de détection ne garantit pas l'équivalence.

Les seuils OOD appris sur développement s'appliquent sans refit aux nouveaux samples. Ils déclarent s'ils sont quantiles empiriques, tests théoriques ou heuristiques ; ils ne sont pas des probabilités d'échec. Le test réservé n'est jamais utilisé pour optimiser le bandwidth ou la règle d'alerte.

### 5.10 Réseaux spectraux

Le module expérimental utilise des bandes/λ comme nœuds et des corrélations entre samples indépendants comme arêtes, par source et vue. Il déclare signe, pondération, seuil, grille/bands, exclusion de liens adjacents et algorithme de communautés. Densité `2m/[p(p−1)]`, centralisation, modularité et transitivité sont accompagnées de sensibilité au seuil et de rééchantillonnages de samples. Graphe vide, isolats et dénominateurs nuls ont une sémantique explicite.

La [publication de Ray et al.](https://nph.onlinelibrary.wiley.com/doi/10.1111/nph.71513) fournit une motivation pour décrire une architecture de corrélations dans des populations végétales. Le présent produit ne transforme pas cette approche en score de qualité et n'adopte pas les effectifs ou seuils de l'étude comme minima génériques. Ce module ne conditionne aucune release V1.

## 6 Contrat de résultat et moteur de règles

Un `QualificationReport` porte `schema_version`, `engine_version`, `protocol_bundle_version`, `capabilities`, identité/hashes du dataset, populations, vues, paramètres, résultats, constats, recommandations et assets. JSON Schema versionne chaque enveloppe et vérifie les discriminants. Le résultat peut être `complete`, `partial`, `failed` ou `cancelled` ; les modules terminés d'un rapport partiel restent consultables mais la synthèse ne cache pas ceux qui manquent.

| Objet | Champs essentiels |
| --- | --- |
| Résultat scientifique | `metric_id`, `protocol_version`, `status`, `reason_code`, `scope`, `source_id`, `target_id`, `view_id`, `population_id`, valeur et unité, dénominateurs, incertitude, paramètres, artefacts. |
| Disponibilité | `computed`, `not_applicable`, `insufficient_data`, `unsupported`, `not_identifiable`, `undefined`, `cancelled`, `error`. `value=null` hors computed, raison obligatoire. |
| Incertitude | Méthode, unité de rééchantillonnage, niveau nominal, bornes, réplicats valides/total et hypothèses ; nullable si non estimable. |
| Constat | ID de règle/version, observations/résultats justificatifs, sévérité, niveau de confiance, conséquence, action, limites, échantillons concernés. |
| Preuve de calcul | Version backend/ABI, seed et RNG, folds, populations FIT/EVAL, recette, masques/agrégation, durée, pic mémoire et approximation. |
| Asset | Table/array/graphique avec schéma, unités, description, shape, référence et hash ; pas de HTML exécutable dans le JSON scientifique. |

Le JSON scientifique conserve nombres f64, pas NaN/Inf, valeurs nulles explicites et clés canoniques ; les grandes séries sortent en buffers ou fichiers référencés. La sérialisation structurelle est identique entre bindings ; la parité des nombres utilise des tolérances définies par protocole. Les différences de temps et d'environnement ne font pas partie du golden numérique.

Les niveaux de confiance `low`, `medium`, `high`, `unknown` décrivent la preuve et les conditions ; ils ne sont pas une probabilité. Les règles versionnées dérivent ces niveaux de la stabilité, disponibilité, effectifs et conformité aux hypothèses. Le seuil initial est une heuristique à valider, visible dans la vue experte. Seuls des défauts techniques certains peuvent être `blocking` ; les autres constats sont `info`, `warning` ou `high`. Aucun échantillon ou λ n'est retiré automatiquement.

Les p-values de permutation utilisent `(1+b)/(1+B)` pour les tirages Monte Carlo ; les tests exhaustifs ont leur propre dénominateur et convention. Les familles d'hypothèses sont enregistrées. Les tests confirmatoires préspécifiés utilisent Holm à 5 % ; la vue exploratoire peut publier Benjamini–Hochberg séparément et annoncer ses hypothèses de dépendance. Aucune étoile de significativité seule ne produit une confiance élevée. Les seeds de modules sont dérivées de manière stable d'une seed globale, du module, de la source et de la cible, avec RNG/version figés.

Le RNG des statistiques de qualification est implémenté dans le core Rust, algorithme/version figés, indépendamment de Python/R/JS. La racine u64 et les seeds DAG/n4m sont transmises sans arrondi JS, avec domaine de dérivation séparé pour chaque fournisseur ; une même seed ne prouve pas que deux RNG différents génèrent les mêmes tirages. Les plans/tirages nécessaires aux comparaisons sont conservés quand la reproductibilité exacte l'exige.

Chaque test transporte une `PermutationPlan` : hypothèse nulle et effet testé, unité échangeable, restrictions, tailles de blocs, modèle réduit éventuel, méthode de tirage, nombre de permutations distinctes admissibles, nombre exécuté et résolution. Le MVP admet une permutation uniforme de labels au niveau sample seulement si l'hypothèse d'échangeabilité des samples est déclarée ; les plans restreints/croisés doivent disposer d'un protocole qualifié. Il ne déplace pas automatiquement des blocs de tailles différentes et ne prend pas PERMDISP comme validation de l'échangeabilité. Budget initial : 999 permutations Monte Carlo par test global, révisable ; si la résolution ne permet pas de soutenir un seuil après multiplicité, aucune conclusion de significativité n'est produite. Les analyses descriptives ne sont pas interdites par un plan de permutation indisponible.

Chaque lot qualifie ses règles dès sa livraison, avec fixtures et version de protocole ; PF-09 étend cette preuve au corpus de RC. Avant validation d'une règle, confiance `unknown`, constat exploratoire et aucune classe affirmée comme fiable. Taille élevée et p-value faible ne suffisent pas. La recommandation de validation déclare domaine de généralisation visé, unités retenues, couverture et limites d'identifiabilité.

Un exemple de résultat d'absence est : `metric_id="measurement.icc"`, `status="unsupported"`, `reason_code="UNBALANCED_REPLICATES_UNSUPPORTED"`, `value=null`, tandis que `measurement.repeatability_sd` peut être computed. Ce comportement doit être identique dans tous les bindings.

## 7 API et bindings

L'API Rust cible `capabilities()`, `validate_input()`, `plan()`, `analyze()` et un job incrémental `step()/cancel()/report()`. Le plan expose modules, populations, coûts estimés et capacités requises avant allocation lourde. Une façade de haut niveau accepte les objets IO ; une API matrice accepte X/Y avec identités et options explicites. Les tableaux sans identités ne contournent pas les règles d'alignement.

L'ABI publique proposée utilise le préfixe `n4pf_*`, une version indépendante des packages, un contexte opaque et des vues de matrices f64 avec shape, strides, longueur de buffer et masque. Un handle n'est utilisable que dans son contexte. Créer/détruire contexte, valider l'entrée, créer le job, step/cancel, récupérer JSON/table/buffer, libérer le résultat, lire l'erreur et vérifier la compatibilité couvrent la surface initiale. Les noms exacts et snapshots sont figés au lot 0.

Les wrappers vérifient nullité, alignement, longueurs, shapes et overflow des offsets. Une ABI C ne peut pas prouver qu'un pointeur arbitraire appartient à une allocation valide : cette validité, la durée de vie et l'absence de mutation concurrente sont des préconditions obligatoires de l'appelant. Les wrappers sûrs les garantissent avant création de la vue. Le support initial couvre strides positifs et layouts ligne/colonne ; strides négatifs et dtype non f64 imposent une copie explicite ou un refus. Les bindings conservent les objets propriétaires pendant les appels. Les buffers sont empruntés pour un appel synchrone ; un job incrémental copie ses données ou détient un propriétaire dont la durée de vie est explicitement attachée au job. Aucun job n'emprunte un tableau temporaire. Les handles invalidés ne sont pas réutilisables ; après panic récupéré, le contexte passe en erreur et doit être détruit, puis recréé.

Le contexte contient ses erreurs et son fournisseur Methods ; l'ABI retourne un statut et ne fait traverser ni panic Rust ni exception C++. Les allocations core sont libérées par le core qui les a créées ; les buffers fournis par l'appelant restent à lui. `catch_unwind` est appliqué aux frontières quand la stratégie de panic le permet ; erreurs d'allocation et panics non récupérables sont documentés. Un contexte par job/thread évite le partage non sûr du backend n4m. Les callbacks n'appellent jamais le runtime R/MATLAB depuis un thread de travail.

| Binding amont proposé | Façade utilisateur | Particularités |
| --- | --- | --- |
| Python `nirs4all-preflight`, import `nirs4all_preflight` | `nirs4all_core.qualification`, adaptateur optionnel du Python complet | NumPy, masques, GIL libéré, typage ; aucune dépendance runtime obligatoire à la bibliothèque Python complète. |
| R `nirs4allpreflight` | `nirs4all::qualify()` dans `nirs4all-r` | R/.Call vers C ABI, matrices colonne-major, NA explicites, finalizers ; éviter une dépendance obligatoire à Python. |
| npm `@nirs4all/preflight-wasm` | Domaine `qualification` de l'agrégat `nirs4all` | TypeScript typé, TypedArrays, jobs incrémentaux, module WASM versionné ; aucun calcul scientifique JS. |
| MATLAB `+nirs4allpreflight` | `nirs4all.qualify()` dans Core | Dispatcher MEX fin vers ABI C, tableaux réels double colonne-major, tables/strings adaptés ; erreurs MATLAB cohérentes. |
| Rust crate `nirs4all-preflight` | Domaine de la crate agrégée `nirs4all` | Types sûrs et API bas niveau sans chargement des bindings hôtes. |

Ces noms sont des propositions à vérifier dans les registres avant publication. Le binding Python peut utiliser PyO3 pour la conversion mais appelle la même façade native ; R utilise une passerelle C stable, sans deuxième implémentation extendr des statistiques. Les distributions contiennent ou déclarent leurs dépendances natives selon le profil, avec ABI et licences vérifiables. Python/R/MATLAB importent un rapport même si une méthode optionnelle n'est pas exécutable.

La distribution R vise d'abord GitHub/R-universe et un build source avec crates vendorisées, Cargo/rustc de versions déclarées et outillage de plateforme ; Rtools seul ne fournit pas la chaîne Rust. Un binaire peut être fourni par la matrice de build, avec provenance et même ABI. Les MEX Linux doivent tester les interactions avec la libstdc++ embarquée par MATLAB et la dépendance C++ de Methods ; l'ABI C n'élimine pas un conflit du chargeur. Liaison/visibility et bibliothèque retenue sont qualifiées sur un vrai MATLAB avant release.

La matrice de qualification est par opération × version × langage × OS × profil. `available`, `qualified`, `experimental` et `unavailable` sont distingués ; un module compilé n'est pas automatiquement qualifié. MATLAB doit être exécuté sous licence sur une version déclarée, avec MEX, layouts et cycles d'allocation. Octave est un gate complémentaire, jamais un substitut à cette preuve. La version 1 « cinq bindings » reste incomplète tant que ce gate MATLAB manque.

La matrice suivante est une cible de livraison, entièrement non implémentée à cette phase. « Tous » inclut Rust, Python, R, WASM et MATLAB ; aucune case ne constitue une disponibilité actuelle.

| Opération | Jalon cible | Environnements visés | Condition supplémentaire |
| --- | --- | --- | --- |
| Validation, intégrité et rapport | PF-01/02 | Tous | ABI et mêmes erreurs/statuts. |
| Répétabilité et noise proxy | PF-02 | Tous | Recette Methods disponible pour le proxy qui l'utilise. |
| PCA, dimension et couverture | PF-03 | Tous | Fournisseur et getters PCA qualifiés ; spectre complet ou résultat limité déclaré. |
| Cibles, cohérence et associations descriptives | PF-03 | Tous | Références admissibles et identités. |
| Sonde régression groupée | PF-04 | Tous | Vrai DAG/Methods dans l'hôte ; navigateur peut rester partiel si son gate échoue. |
| Clusters, confounding et shift | PF-05/06 | Tous | Profil de données, permutations et budget qualifiés. |
| AOM, ICC REML et mélanges Y | PF-10 | Selon capacités qualifiées | Aucun repli caché dans un binding. |
| Réseaux | PF-11 | Profil expérimental | Non requis pour V1. |

PF-00 fixe les versions de Python 3.11+, R, Node, compilateurs Rust/C et MATLAB réellement testées. Les profils natifs visent Linux x64, Windows x64 et macOS arm64 ; l'accès aux runners et dépendances de chaque surface est confirmé avant engagement. Le navigateur vise Chromium, Firefox et WebKit avec versions consignées ; tests Node/WASM complètent mais ne remplacent pas les navigateurs. Une cible non exécutée reste explicitement non qualifiée.

## 8 Fournisseurs numériques et WASM

Un `MethodsProvider` expose les opérations publiques nécessaires à PCA, lissage, prétraitements et diagnostics. Le `ValidationProvider` reçoit la spécification complète de sonde, le plan de données/validation et le budget ; DAG-ML possède toute la boucle externe/interne, sélection et phases, puis renvoie OOF, scores, folds et populations. Preflight ne pilote pas lui-même une seconde boucle CV et ne traite pas DAG comme simple splitter. Les appels Methods de la sonde passent par les contrôleurs DAG qualifiés. Sur CPU, les diagnostics Rust appellent n4m par ABI C via un adaptateur versionné. Le core peut produire les analyses qui n'exigent pas ces fournisseurs sans charger leur bibliothèque ; les autres sont `unsupported`, sans fallback scientifique caché.

Dans le navigateur, Preflight est un module Rust `wasm32-unknown-unknown`, Methods/libn4m un module Emscripten, et DAG-ML possède son propre module Rust/wasm-bindgen ; DAG-ML n'est pas assimilé à Emscripten. Le worker transporte requêtes, tableaux et résultats entre les mémoires, sans implémenter PCA, PLS ou règles statistiques. Rust décide les modules de diagnostic et demande une sonde complète au fournisseur DAG. PF-00 teste d'abord une importation synchrone dans le même worker pour les diagnostics Methods : wasm-bindgen → adaptateur JS de transport → export Emscripten, sans ASYNCIFY. La cohérence de runtime, propriété et erreurs doit être démontrée ; cette option n'est pas présumée fonctionner.

Le repli asynchrone `step → provider_request → provider_response → step` n'est activé que par une seule machine à états Rust partagée CPU/WASM, avec adaptateur CPU qui la fait avancer jusqu'à terminaison. La réponse est liée à job, request_id, hash des entrées, phase et fold ; une réponse étrangère/périmée est rejetée. Il ne doit pas exister deux algorithmes de protocole ni deux boucles CV. PF-00 fige l'option qui ferme ses gates ; le transport de sonde suit les capacités réelles DAG et reste distinct du callback de diagnostic.

L'échange de matrices implique des copies mesurées ; il ne promet pas de partage de pointeurs entre modules. La liaison directe d'un Rust wasm-bindgen avec Emscripten n'est pas supposée fonctionner. Une alternative de build unifié `wasm32-unknown-emscripten` ne sera choisie qu'après preuve, sans modifier les algorithmes ni créer une dépendance browser dans le core.

Chaque hôte déclare un résolveur de dépendances natives : préférer l'instance Methods déjà chargée par l'agrégat/paquet amont, vérifier version/ABI et ne jamais échanger des handles entre deux instances. Dans une page/worker, Core et Preflight partagent une seule instance Emscripten n4m. Si un package autonome embarque statiquement une copie privée, ses symboles sont cachés, son fournisseur/ABI distincts et aucun handle ne traverse cette frontière. La politique de liaison, les hashes et les conflits au chargement font partie de la matrice de capacités et du packaging.

Le spike du lot 0 doit exécuter une petite chaîne IO → matrice → Methods PCA → résultat Rust, dans Node et un vrai navigateur, avec résultats comparés au CPU, pic mémoire, messages asynchrones et annulation. Une dépendance n4m absente réduit les capacités annoncées ; elle n'active pas une PCA JS. Si les méthodes lourdes ne sont pas qualifiées, la page livre le MVP calculable et une démo explicitement bornée, en affichant les modules indisponibles et la commande native pour le dataset complet.

Un deuxième spike exécute une sonde minimale à recette fixée, avec deux folds groupés et vrai train/transform/predict DAG-ML sur CPU et navigateur. Le `ValidationProvider` possède les plans, phases et handles d'exécution DAG ; le `MethodsProvider` possède les états numériques dont il reçoit le fit. Rust décrit les requêtes et collecte les résultats ; l'hôte n'invente ni folds ni phases. Tout état porte backend, job, source, population FIT, phase et fold ; aucune réponse tardive après annulation ni aucun état d'un autre fold n'est accepté. Ce spike ne qualifie pas à lui seul la recherche AOM imbriquée, réservée à PF-10.

Le checkout DAG-ML contient déjà un adaptateur natif Methods et des contrôleurs runtime WASM. Cela ne prouve pas leur couverture de la sonde imbriquée ciblée : PF-00 établit la tranche réutilisable et les extensions requises, avec charge amont. PF-04 ne démarre pas sa qualification tant que le contrôleur estimateur et les phases nécessaires ne sont pas réellement livrés.

## 9 Page web et composants partagés

La page de qualification est une route de `nirs4all-web/web-app`, accessible dès qu'un dataset est assemblé. Le parcours est : importer via IO/Formats ; confirmer identité, répétitions, sources/cibles, groupes et objectif de généralisation ; consulter le plan ; lancer l'analyse ; parcourir les constats ; exporter. Les métadonnées manquantes donnent des questions de configuration et des états d'absence explicites, sans bloquer la description de X.

L'analyse reste locale au navigateur ; aucun téléversement automatique de spectres. La persistance IndexedDB est facultative, avec suppression accessible. Le worker restitue progression, erreurs et résultats partiels ; Cancel détruit le worker ou utilise le signal natif, puis libère les modules. Le rapport contient les versions exactes et le profil complet/partiel. Les jeux de démo sont redistribuables, décrivent leurs anomalies et portent le label « démonstration » dans chaque export.

Chaque module terminé émet un snapshot immuable avec sa provenance avant de lancer le suivant. L'hôte conserve ces snapshots ; une destruction du worker reconstruit un rapport `cancelled` avec seulement les résultats confirmés, sans faire passer le module interrompu en computed. Les buffers/handles dépendant de la mémoire détruite ne sont jamais réutilisés. Des messages terminés après Cancel sont ignorés via la génération du job.

| Réutilisation vérifiée | Usage |
| --- | --- |
| `DatasetPreviewCard`, `StepProgress` | Population et progression. |
| `SpectraPlot`, `Histogram`, `PcaScatter`, `BoxPlot` | Spectres, références et structure déjà calculés. |
| `FeatureImportanceBar`, `FoldStabilityLines`, `ScoreHeatmap` | Effets et stabilité lorsqu'ils sont disponibles. |
| `HealthFindingRow`, `DecisionCard`, badges runtime | Constats et état d'exécution, via adaptation conservant sévérité et disponibilité. |

Créer dans `nirs4all-ui` un domaine de présentation `qualification` avec `QualificationSummary`, `QualificationFindingCard`, `WavelengthReliabilityPanel`, `CoveragePanel`, `ClusterStabilityPanel`, `ValidationAdvice` et `MetricEvidenceTable` lorsque les contrats existants sont insuffisants. Les props fournissent données, descriptions, textes localisés et actions de l'hôte. Ni API scientifique, ni route, ni worker, ni IndexedDB dans UI. Les textes sont FR/EN ; les IDs scientifiques restent indépendants de la langue.

Chaque graphique répond à une question, affiche unités/population/vue et dispose d'un résumé visible et d'une table filtrable synchronisée. CSV complète les grandes tables mais ne remplace pas le résumé HTML. Les états ne reposent pas sur la seule couleur ; clavier, focus, zoom 400 %, 320 pixels, contraste, reduced motion et lecteur d'écran sont des gates. Les composants SVG existants fournissent des descriptions mais l'hôte doit ajouter les données structurées utiles. Export HTML conserve texte et tables ; PDF conserve les conclusions et les valeurs nécessaires, avec qualification d'accessibilité séparée.

Les composants de qualification exigent une prop `profileStatus` (complete, partial, demo, cancelled) et la liste des modules indisponibles. Ce marquage reste visible dans les cartes et exports ; un jeu démonstratif ou profil partiel ne prend pas le titre d'une qualification complète.

## 10 Budgets et performances

Les profils initiaux sont des budgets à mesurer, pas des performances promises. Petit navigateur : jusqu'à 500 samples indépendants × 2 000 λ × une source/une cible. Profil étendu visé : 2 000 × 4 000 × deux sources, sous budgets mémoire et opérations explicites. Le seul X f64 de 2 000 × 4 000 occupe 64 Mo décimaux ; quatre copies, vues et temporaires peuvent dépasser 256 Mo avant clustering. La planification comptabilise ces copies et les buffers des deux modules.

Le plafond proposé du worker est 256 Mio pour le petit profil, 512 Mio pour le profil étendu après mesure. Clustering all-pairs est interdit au-delà d'un n qualifié ; kNN par blocs et index exact/approximatif déclarés, budgets de sous-échantillons, de permutations et de fits sont requis. Les approximations produisent un marqueur de protocole et une preuve d'écart au calcul exact. Une limite déclenche un résultat partiel/refus explicite, jamais un sous-échantillonnage silencieux de l'intégrité.

Le budget mémoire inclut la somme des high-water marks des mémoires linéaires Rust, DAG et Emscripten, plus les TypedArrays JS et sorties conservées. Libérer un buffer ne fait pas rétrécir la mémoire linéaire existante. Les snapshots permettent de terminer/recréer le worker entre phases lourdes quand le plan le prévoit ; cette stratégie ne conserve pas des handles devenus invalides. Le profil étendu reste non qualifié tant que le pic cumulé n'a pas été mesuré. Les 512 Mio sont un plafond de refus et non une promesse que le profil y tient.

Objectifs initiaux à confirmer : intégrité/description <2 s, MVP sans rééchantillonnage lourd <15 s sur le petit profil, progression observable et annulation <1 s entre blocs, hors appel fournisseur non interruptible. Un fournisseur non interruptible est annulé par destruction du worker dans le navigateur. La sonde et les modules avancés annoncent leur budget, sans promesse de durée fixe. Les temps sont mesurés sur une machine et des navigateurs publiés avec p50/p95 et pic mémoire. Aucun thread WASM partagé ou header COOP/COEP n'est requis dans le premier build Pages.

## 11 Validation et livraison

Les gates Rust sont `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, rustdoc et licences. Les tests d'ABI vérifient symboles/version/ownership, erreurs et layouts ; sanitizers/fuzzing ciblent les frontières et entrées adversariales. Pas d'accès à des données privées dans CI.

Les fixtures synthétiques isolent corruption d'alignement, répétitions inégales, bruit connu, rang contrôlé, cible constante/partielle/censurée, contradictions, confounding exact, shift, continuum et clusters instables. Les tests d'invariants contrôlent changement d'ordre des lignes/colonnes, conversion de layout, réplication technique sans gain artificiel et absence de fuite. Des fixtures réelles publiques apportent une validation contextualisée avec source, licence et SHA, sans prétendre à des seuils universels.

Chaque protocole possède une référence pertinente : formules analytiques pour répétabilité ; outils R dédiés pour composantes de variance et PERMANOVA ; hdbscan pour partitions ; Python complet/Methods pour PCA/PLS/prétraitements. Les références sont test-only et leurs licences n'entrent pas implicitement dans le runtime. Les goldens sont générés avec versions, provenance et tolérances ; aucune mise à jour pour faire passer une divergence inexpliquée. PCA se compare par variance, projecteurs et reconstruction, pas par signe brut de vecteurs ; clustering par équivalence des partitions et gestion des ex aequo.

Toutes les surfaces exécutent les mêmes cas via leurs packages installés, y compris données column-major R/MATLAB et erreurs typées. Les manifests, capability matrices et docs sont générés à partir des preuves de tests. Le build web se fait avec des packages épinglés distribuables, sans chemin local de frère ni WASM copié à la main. UI exécute typecheck/build/Vitest et rendu SSR ; Web ajoute worker, accessibilité et smoke navigateur ; Studio suit ses gates lint/test si intégré.

La licence proposée suit `CECILL-2.1 OR AGPL-3.0-or-later` des couches Rust/UI actuelles, sous vérification des dépendances et du packaging. Fournir notices, provenance de copies, SBOM et hashes. Ne pas revendiquer CRAN, App Store ou certification normative ; aucune publication n'est réalisée par la présente phase de rédaction.

## 12 Décisions et limites restantes

Sont fixés pour lancer le travail : core Rust pur ; trois vues nommées ; unités explicites ; contrat commun et états d'absence ; réutilisation de Methods/DAG ; worker à deux modules ; page Web et composants UI ; MVP indépendant du clustering ; absence de score global et de suppression automatique.

Le lot 0 ferme les décisions dépendantes d'un test : cohorte publique compatible, API de diagnostic PCA, transport asynchrone, outillage MEX et accès MATLAB, disponibilité Rust HDBSCAN, coûts des copies. Si un spike échoue, la roadmap réduit un profil en le rendant visible ; elle ne change pas silencieusement de langage ou d'algorithme. Les réseaux restent hors calendrier de V1. Les reviews finales et leur traitement sont enregistrés dans [les décisions de review](DECISIONS_REVUES.md).

