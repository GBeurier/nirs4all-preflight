# Réutilisation avant implémentation — intégration

12 octobre 2026. CodeGraph interrogé sur Methods et DAG-ML avant les lectures de code.

- Methods : `n4m_matrix_view_t` public, context/error lifecycle, PCA interne existante. L’adaptateur natif utilise l’ABI publique et des buffers privés. Aucun noyau scientifique dans les bindings.
- DAG-ML : `NestedFoldSet::validate_for_outer`, validation groupée et OOF présents. Pas de seconde boucle CV ; la sonde reste indisponible dans le profil alpha tant que son intégration n’est pas qualifiée.
- Core : agrégat Rust/Python/WASM existant, registry et résolution `libn4m` dynamique. Pas de domaine de qualification existant dans ses exports inspectés. Preflight fournit un package amont indépendant avant un futur réexport.
- UI : domaines viz/lab/brand existants. La démo importe le nouveau domaine de présentation pur et les graphiques existants ; elle ne calcule aucune statistique.
- IO/Formats : import limité au JSON de dataset déjà assemblé. Aucun lecteur propriétaire ni jointure ajoutés ici.

Le profil livré est explicitement alpha/exploratoire. Les gates cinq langages, CV imbriquée, clustering, permutation et domain shift restent ouverts ; leur disponibilité est publiée dans chaque rapport.
