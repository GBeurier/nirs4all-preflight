# Roadmap d'implémentation de nirs4all preflight

12 octobre 2026 — Lots proposés, aucune implémentation démarrée. La [spécification](SPECIFICATION.md) définit le comportement cible ; le backlog consolidé `../../_backlogs/BACKLOG_CONSOLIDE.md` conserve le statut des features. Les identifiants PF servent à relier détails de conception, futures issues et preuves de qualification.

Le chemin critique est contrat/identités → ABI et passerelle WASM → diagnostics utiles → sonde validée → qualification multi-langages. UI progresse dès les premières sorties ; AOM et réseaux ne bloquent pas le MVP. Les charges sont des jours-personnes d'ingénierie, incluant tests et docs de chaque lot, pour des contributeurs connaissant l'écosystème. Elles restent à réestimer après les spikes.

## 1 Lots et critères d'acceptation

| Lot | Charge | Dépendances | Livrables et gate de sortie |
| --- | --- | --- | --- |
| PF-00 Contrats et faisabilité | 10–14 j | Aucune | Schémas input/report/capabilities, composantes d'identités indivisibles, matrice réutilisation/manque, cohorte épinglée. Spikes IO→PCA→Rust et vrai DAG train/transform/predict à deux folds groupés CPU/navigateur ; callbacks synchrones/repli unifié, copies, liaison et annulation ; compilation R/MEX et accès MATLAB confirmés. |
| PF-01 Socle Rust et bindings verticaux | 16–22 j | PF-00 | Workspace, C ABI versionnée, CLI, packages Python/R/WASM/MATLAB et validation d'entrée. Le même petit dataset passe validate/analyze/report dans chaque hôte ; erreurs, strides, ownership, libération, outillage R/Cargo et import sans Python complet testés. |
| PF-02 Intégrité, mesure et restitution initiale | 12–18 j | PF-01 | Intégrité, unités, répétabilité absolue, ICC(1,1) équilibré qualifié, masque/λ et noise proxy ; JSON/HTML ; première page Web, contrats/components UI. Bruit connu et répétitions inégales ; aucun SNR inventé ; cancel/snapshots partiels. |
| PF-03 Couverture et cohérence X–Y | 10–14 j | PF-02 + API PCA de PF-00 | PCA canonique, dimension, couverture X/Y, références partielles, contradictions/kNN hors répétitions, associations métadonnées–Y et recommandations. Politiques censure/composites et permutations explicites ; règles qualifiées ou confiance unknown ; nul local conditionnel ; parité CPU/WASM. **MVP utile.** |
| PF-04 Sonde et validation groupée | 16–24 j | PF-03 + fournisseurs Methods/DAG qualifiés | Sonde PLS/PCR, baseline, OOF par sample, plans groupés et sélection de composantes interne. Tests de fuite et dataset à batch confondu ; mêmes folds et score dans chaque langage ; état indisponible si plan impossible. |
| PF-05 Clusters et stabilité | 12–18 j | PF-03 ; spike HDBSCAN PF-00 | Implémentation Rust qualifiée, paramètres sémantiques fixés, sous-échantillonnages sans remise, bruit/intersections/ARI, sensibilité PCA et modèle nul. Continuum et partitions fragiles rendus incertains ; aucune obligation de trouver des groupes. |
| PF-06 Confounding et domain shift | 10–16 j | PF-04 ; PF-05 pour explication des clusters | Effets marginaux, design/alias, PERMDISP et permutations valides ; comparaison de domaines dans un espace appris sur référence. Tests contre oracles et exemples non identifiables ; recommandation liée à l'usage et à métadonnées–Y. |
| PF-07 Produits et composants complets | 14–22 j | PF-02 en continu ; PF-03→06 pour données finales | Page Web complète dans le profil qualifié, composants UI partageables, FR/EN, vue experte, rapports, adaptation pilote Studio/Quality sans migration générale. Clavier/lecteur d'écran, tables équivalentes, persistance opt-in, dépendances npm épinglées sans chemin sibling. |
| PF-08 Packaging et intégration des façades | 8–12 j | PF-01 en continu ; PF-04→07 pour matrice finale | Wheels, package R, npm/WASM, Rust et MATLAB/MEX installables ; domaine Core et façade R ; symboles/versions/notices/SBOM. Tests depuis distributions installées, pas uniquement checkout ; qualification MATLAB réelle distincte d'Octave. |
| PF-09 Qualification scientifique et RC | 8–14 j | PF-02→08 | Campagne synthétique + corpus public, seuils/règles versionnés, parité cinq surfaces, budgets navigateur, rapports reproductibles, docs et changelog. Aucune anomalie P0/P1 sans résolution ou exclusion explicite du profil ; dossier RC concret avant publication. **Version 1.** |
| PF-10 Extensions ciblées | 24–40 j, optionnel | PF-09 | AOM imbriqué avec stabilité d'opérateurs, ICC REML déséquilibré, mixtures Y qualifiées et visualization non linéaire. Activer séparément chaque capacité avec témoins de calcul ; estimation à détailler après V1. |
| PF-11 Réseaux spectraux | Hors estimation V1 | PF-09 + objectif scientifique validé | Prototype descriptif avec sensibilité au seuil/autocorrélation, bootstrap de samples et validation de son intérêt utilisateur. Décision de poursuivre fondée sur un benchmark, sans score de calibrabilité. |

PF-05 et PF-06 peuvent être décalés après une première release MVP s'ils retardent la valeur utile. Ils restent requis pour le périmètre V1 décrit ; un décalage ne transforme pas une release partielle en V1 complète.

## 2 Jalons et organisation

La somme PF-00 à PF-09 est **116–174 jours-personnes**, après réestimation des spikes et cinq bindings à la suite des reviews. Les adaptations amont additionnelles ci-dessous ajoutent **8–22 jours-personnes**, soit une enveloppe V1 de **124–196 jours-personnes avant réserve**. La durée calendaire dépend du chemin critique, des propriétaires amont et de l'accès MATLAB ; elle n'est pas le quotient automatique de la charge par deux contributeurs. PF-10 ajoute 24–40 jours-personnes ; PF-11 est une exploration distincte.

Cette enveloppe couvre les tâches Preflight et les adaptations bornées d'interface, pas la résolution d'une dette amont de grande ampleur. J0 confirme charges, releases, disponibilités des propriétaires et matrice minimale OS × langage × opération. Ajouter ensuite une réserve de 20–30 % si les spikes restent incertains ; elle n'est pas incluse dans les sommes précédentes. Les tâches des différents propriétaires ne deviennent pas parallèles du seul fait que deux personnes travaillent sur Preflight.

À périmètre inchangé, appliquer 20 % au bas et 30 % au haut donne environ **149–255 jours-personnes**, hors dette amont supplémentaire. À deux personnes disponibles, un ordre de grandeur calendaire de **18–30 semaines** tient compte d'intégration et de dépendances ; il reste à recalculer à J0 et n'engage aucune date. Le MVP PF-00→03 représente **48–68 jours-personnes**, avant adaptations amont requises et réserve, avec une valeur utile plus tôt que V1.

| Jalon | Contenu livrable | Condition de passage |
| --- | --- | --- |
| J0, fin PF-00 | Contrats et décision navigateur | Spike réel, API/propriétaires clarifiés, risques chiffrés ; réduction de profil si nécessaire. |
| J1, fin PF-01 | Squelette exécutable cinq surfaces | Entrée et rapport identiques, erreurs et ownership, binding MEX réel. |
| J2, fin PF-03 | MVP utile CPU + Web | Mesure/couverture/cohérence et recommandations ; limites visibles ; présentation et exports. |
| J3, fin PF-04 | Sonde de signal | Aucune fuite démontrée sur fixtures adversariales ; folds/OOF inspectables. |
| J4, fin PF-05/06 | Diagnostics de structure | Stabilité, incertitude et non-identifiabilité correctement rendues. |
| J5, fin PF-07→09 | RC puis V1 | Packages installés et cinq bindings qualifiés ; matrices et budgets publiés. |

La phase documentation actuelle s'arrête avant PF-00. Lors de l'implémentation, le responsable moteur porte contrats/statistiques/CLI et ABI ; le responsable produit porte adaptateurs UI, page Web et intégration hôtes. Chaque lot touchant Methods, IO, DAG, Core ou R reçoit une issue/PR dans son dépôt propriétaire, avec dépendances explicites. Les modifications ne sont pas regroupées comme si les dépôts étaient un monorepo.

Une interface de fournisseur peut être simulée pour tester le protocole Rust mais le mock ne ferme jamais le gate d'exécution réel. Les tests end-to-end sont réalisés sur une cohorte de versions concrètes et conservés dans une preuve machine-readable. Les décisions de review ne modifient pas un statut en « livré » avant ces témoins.

## 3 Travail amont et dépendances

| Projet | Demande prévue | Gate lié |
| --- | --- | --- |
| Methods | Diagnostic PCA public : valeurs propres/moments complets, loadings/scores/résidus, convention numérique ; vérifier PLS/PCR, prétraitements et fold_ids AOM sur la cohorte. | PF-00/03/04/10 ; changements ABI avec snapshots/changelog. |
| IO et Data | Adapter le dataset assemblé au contrat de qualification, vérifier observation/sample/reference IDs, groupes, types de répétition et sources partielles. Les ajouts de données restent amont. | PF-00/01/03. |
| DAG-ML | Fournisseur de validation groupée, populations FIT/EVAL et OOF ; qualifier les phases internes/externes et le protocole demande/réponse. | PF-04 et PF-10. |
| UI | Réutiliser `viz`/`lab` et publier `qualification` pour les champs scientifiques supplémentaires ; contrats de présentation purs. | PF-02/07. |
| Web | Ajouter route et worker adaptateur ; injecter modules Rust et Emscripten distribués, budget mémoire et état des modules manquants. | PF-00/02/07. |
| Core et R produit | Réexport `qualification`, façade R, registry de compatibilité et matrice par opération. | PF-08. |
| Studio et Quality | Pilote de consommation des rapports/composants ; pas de remplacement du parcours ni de migration générale. | PF-07, puis extension selon priorité. |

Les dettes existantes QUA-02/03, MTH-10, NEW-01 et NEW-08 du backlog restent des dépendances ou réutilisations possibles, pas des tâches automatiquement absorbées. Un registre de capacités commun peut être consommé s'il existe ; sa réalisation globale n'est pas une condition pour un registre local honnête.

| Adaptation amont bornée | Charge indicative | Comptabilisation et release |
| --- | --- | --- |
| Methods : getters diagnostics PCA et exposition qualifiée | 4–8 j | Additionnel ; version/ABI et release publique avant PF-03. Réutiliser les getters existants s'ils suffisent. |
| DAG-ML : tranche de sonde groupée et adaptateur vers contrôleurs Methods existants | 4–10 j | Additionnel ; API existante à vérifier, pas hypothèse d'absence. Release avec phases requises avant PF-04. |
| IO/Data : lacunes de transport d'identités/références seulement | 0–4 j | Additionnel si lacune constatée ; sinon zéro. Adaptateur Preflight déjà dans PF-01/03. |
| UI : contrats et composants partagés | 4–8 j | Inclus dans PF-07 ; package UI épinglé avant packaging final, pas ajouté deux fois. |
| Core/R produit : réexports et façades | 3–6 j | Inclus dans PF-08 ; releases compatibles dans la cohorte, pas ajouté deux fois. |

Ces charges additionnelles totalisent 8–22 jours-personnes. Si une opération existe déjà, J0 réduit sa ligne avec preuve ; si une tranche de validation générale manque, elle constitue un nouveau périmètre à chiffrer plutôt qu'une extension cachée de PF-04.

## 4 Risques et décisions de repli

| Risque | Détection précoce | Décision |
| --- | --- | --- |
| Deux mémoires WASM trop coûteuses | PF-00 : copies, pic RSS/heap, job réel | Réduire le profil navigateur ou livrer démo/MVP ; analyses complètes via CLI/bindings natifs. Aucun calcul scientifique JS de remplacement. |
| API PCA incomplète | Vérification des headers/getters et test sur valeurs propres | Extension dans Methods ; description/intégrité livrables avant elle, couverture géométrique indisponible tant que non qualifiée. |
| HDBSCAN Rust insuffisant | Fixtures de densités, bruit, ex aequo et persistance | Reporter PF-05 ; PCA/coverage et résumé « clustering indisponible ». Aucune imitation de persistance. |
| Identités ou domaines absents | PF-01 : validation et configuration | Hypothèses enregistrées ; analyses descriptives seulement ; ne pas prétendre à indépendance ou généralisabilité. |
| Trop peu de groupes ou confounding exact | PF-04/06 : plan et rang du design | Refus de la sonde concernée/non-identifiabilité, recommandation de compléter les croisements. |
| MATLAB non accessible sous licence | PF-00 puis PF-01 | Préparer MEX/Octave et matrices ; garder MATLAB non qualifié et gate V1 cinq bindings ouvert. Pas de revendication de parité MATLAB. |
| Seuils d'alerte fragiles | PF-09 : corpus synthétique et réel | Déclasser en observation exploratoire ou confiance basse ; pas de blocage statistique ni de score agrégé. |

## 5 Qualification et clôture des lots

Chaque lot produit : diff/PR dans le dépôt propriétaire, contrats et capacités mis à jour, tests appropriés, fixtures avec provenance, preuve d'exécution, documentation utilisateur et risques restants. Rust passe fmt/clippy/tests ; l'ABI vérifie version et symboles ; les bindings passent leurs tests depuis des installations isolées ; UI/Web passent leurs contrôles et smokes appropriés. Les comparaisons scientifiques contrôlent formules, invariants et références indépendantes, pas seulement une seconde exécution du même code.

Les seuils, règles et niveaux de confiance ont leur gate minimal dans le lot qui les expose. Les modules non calibrés sont exploratoires avec confiance unknown dès le MVP ; PF-09 étend la validation sans attendre pour corriger une règle qui produirait déjà une alerte trompeuse. Les familles de tests, budgets et résolution de permutations sont des contrats du module, pas une décision tardive de la RC.

La RC exige un jeu réel public et des cas adversariaux pour : repetitions inégales, référence manquante/constante, répétitions exclues des voisins et folds, fuite volontaire rejetée, plan instrument/site aliasé, continuum, bruit pur et décalage de domaine. Native-versus-binding et références-versus-moteur sont deux gates distincts. Les métriques aléatoires ont RNG, paramètres, tolérances et limites de stabilité déclarés.

La publication ultérieure passe par les pratiques de release des dépôts concernés. Cette roadmap prépare un résultat reviewable ; elle ne lance ni développement, ni commit, ni publication. La synthèse finale et le registre des reviews décrivent les décisions retenues et ce qui reste à prouver.
