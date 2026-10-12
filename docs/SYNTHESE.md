# Synthèse de la conception de nirs4all preflight

12 octobre 2026 — Spécification et roadmap mises à jour après reviews Codex, Opus initial, Astra et Opus final. La phase s'arrête à la documentation ; aucun développement ou déploiement n'est lancé.

Le projet est pertinent : qualifier un dataset NIRS avant entraînement, en distinguant intégrité, mesure, couverture, structure, relation X–Y et validation. Le document initial avait les bonnes questions, mais ses protocoles laissaient trois risques majeurs : traiter des acquisitions répétées comme des observations indépendantes, sélectionner un prétraitement avec Y puis réutiliser sa géométrie sans validation imbriquée, et appeler SNR un ratio dépendant de la diversité de la population. La spécification corrige ces points et conserve une synthèse par dimensions, sans note globale.

## Architecture retenue

Le moteur de qualification et les nouvelles statistiques sont en Rust. Les parsers restent dans `nirs4all-formats`, l'assemblage et les identités dans IO/Data, les PCA/PLS/prétraitements existants dans Methods, et les boucles de validation dans DAG-ML. Les bindings Python, R, WASM et MATLAB convertissent les objets vers les mêmes contrats ; Core expose le domaine de qualification et `nirs4all-r` porte la façade R utilisateur. Aucun calcul scientifique n'est recopié en TypeScript ou dans un binding.

La page vit dans `nirs4all-web/web-app` et réutilise les composants `viz`, `lab`, `dataset` et `runtime` de `nirs4all-ui`. Les cartes de qualification manquantes seront créées dans UI, avec résumé et tables accessibles, sans worker, IO ou état applicatif dans ce package. Quality reste un consommateur possible pour sa phase amont, avec son parcours de laboratoire distinct.

Le navigateur associe Preflight Rust/WASM, DAG Rust/WASM et libn4m/Emscripten. Le premier lot teste leur transport, leurs copies, la propriété des états, une sonde groupée réelle et l'annulation. Le profil complet est livré seulement s'il passe ces gates ; sinon la page propose les diagnostics réellement calculables ou une démo explicitement bornée. MATLAB doit être exécuté sous licence ; les tests Octave ne ferment pas ce gate.

## Protections scientifiques intégrées

Les identités liées sont contrôlées avant agrégation et dans chaque fold. Les voisins excluent l'unité indépendante déclarée. Les références censurées ou composites ne deviennent pas des valeurs ponctuelles indépendantes ; les absences, plans impossibles et effets confondus ont des statuts explicites. Répétabilité absolue et ICC de mesure unique sont définis, avec leurs limites.

La vue native décrit la mesure, la canonique la structure non supervisée, et la vue AOM reste cible-dépendante. DAG-ML possède sélection et validation interne/externe ; les scores OOF et baselines ont les mêmes samples et poids. Les partitions de clustering sont évaluées par sous-échantillonnage sans remise, en publiant bruit, stabilité et fraction réellement comparée. Les règles non calibrées restent exploratoires, avec confiance unknown.

Les reviews finales ont aussi renforcé le contrat des permutations, les préconditions de l'ABI C, la liaison de libn4m, les résultats partiels après Cancel et les budgets de mémoire linéaire WASM. Les suggestions qui ne valaient pas comme règles universelles sont motivées dans le registre de décisions, notamment sur le R², le plafond lié au bruit de référence et l'analyse parallèle naïve des colonnes NIRS.

## Roadmap et estimation

| Étape | Valeur livrée |
| --- | --- |
| PF-00 à PF-03 | Contrats, faisabilité, bindings verticaux, intégrité, répétabilité, couverture et cohérence locale : premier MVP utile. |
| PF-04 à PF-06 | Sonde groupée, clusters robustes, confounding et comparaison de domaines. |
| PF-07 à PF-09 | Page/composants complets, packages et façades, qualification scientifique et RC cinq langages. |
| PF-10 et PF-11 | AOM/REML/mélanges en extensions ; réseaux spectraux expérimentaux hors V1. |

Le MVP représente **48–68 jours-personnes**, avant adaptations amont et réserve. La V1 représente **124–196 jours-personnes**, dont 8–22 d'adaptations amont bornées. Une réserve indicative de 20–30 % porte l'enveloppe à **149–255 jours-personnes**. À deux personnes disponibles, l'ordre de grandeur est 18–30 semaines, à réestimer après PF-00 selon les releases amont, les runners et MATLAB. Il ne s'agit pas d'une date d'engagement.

Les reviews initiale Opus et finales Astra/Opus sont conservées en PDF avec leurs limites de pages vérifiées. La spécification, la roadmap, l'audit et le registre des décisions sont disponibles dans ce dossier ; les features PF-00 à PF-11 sont enregistrées comme proposées et non démarrées dans le backlog consolidé. La prochaine étape d'implémentation est PF-00.
