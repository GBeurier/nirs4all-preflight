# SPDX-License-Identifier: CECILL-2.1 OR AGPL-3.0-or-later
"""Generate crates/nirs4all-preflight/tests/fixtures/clustering_v2_golden.json.

Test-only, independent Python implementation of the Preflight `clustering.v2`
protocol, used as the full-chain golden for the native and WASM engines. It
pins numpy==2.4.6, scipy==1.18.1 and scikit-learn==1.9.1 (BSD-3-Clause); none
of them is a runtime dependency.

Chain per dataset: canonical eligible rows (sample ids in lexical order) ->
centered PCA by numpy SVD (min(10, n-2, p) components, eigenvalues ddof 1) ->
score grid 2^(e-24) (half away from zero) -> scikit-learn 1.9.1 HDBSCAN with
the stable MST edge order of Methods (`stable_single_linkage`) -> 50 subsample
plans from numpy default_rng(seed).permutation(U) with the Preflight seed
derivation -> refit, ARI (scikit-learn adjusted_rand_score), Jaccard matching
with scipy linear_sum_assignment -> 99 Gaussian null replicates drawn by
numpy multivariate_normal(method="cholesky"). Summaries use numpy type-7
quantiles. The stock scikit-learn partition is recorded for information.

Usage: python scripts/generate_clustering_golden.py [output.json]
"""

from __future__ import annotations

import importlib.metadata as metadata
import json
import math
import sys
import warnings
from pathlib import Path

import numpy as np
import sklearn.cluster._hdbscan.hdbscan as skh
from scipy.optimize import linear_sum_assignment
from sklearn.cluster import HDBSCAN
from sklearn.metrics import adjusted_rand_score

PINNED = {"numpy": "2.4.6", "scipy": "1.18.1", "scikit-learn": "1.9.1"}
PROTOCOL = "clustering.v2"
MASK = (1 << 64) - 1
N_SUBSAMPLES, N_NULL, MIN_ARI, GRID_BITS = 50, 99, 10, 24


def derive_seed(root: int, domain: str) -> int:
    h = 0xCBF29CE484222325
    for byte in domain.encode():
        h = ((h ^ byte) * 0x100000001B3) & MASK
    z = root ^ h
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK
    return z ^ (z >> 31)


def pca(x: np.ndarray, k: int) -> tuple[np.ndarray, np.ndarray]:
    xc = x - x.mean(axis=0)
    u, s, _ = np.linalg.svd(xc, full_matrices=False)
    return u[:, :k] * s[:k], s[:k] ** 2 / (x.shape[0] - 1)


def quantize(scores: np.ndarray) -> np.ndarray:
    largest = float(np.abs(scores).max())
    if largest == 0.0:
        return scores
    step = math.ldexp(1.0, math.frexp(largest)[1] - GRID_BITS)
    q = scores / step
    return np.sign(q) * np.floor(np.abs(q) + 0.5) * step + 0.0


def stable_single_linkage(x: np.ndarray, min_samples: int) -> np.ndarray:
    core = skh.NearestNeighbors(n_neighbors=min_samples).fit(x).kneighbors(x, min_samples)[0][:, -1]
    metric = skh.DistanceMetric.get_metric("euclidean")
    mst = skh.mst_from_data_matrix(np.ascontiguousarray(x), np.ascontiguousarray(core), metric, 1.0)
    return skh.make_single_linkage(mst[np.argsort(mst["distance"], kind="stable")])


def hdbscan(scores: np.ndarray, mcs: int, ms: int) -> np.ndarray:
    x = np.ascontiguousarray(quantize(scores))
    labels, _ = skh.tree_to_labels(stable_single_linkage(x, min(ms, len(x))), mcs, "eom", False, 0.0, None)
    return labels.astype(np.int64)


def refit(matrix: np.ndarray, rows: list[int]) -> np.ndarray:
    sub = matrix[rows]
    return pca(sub, min(10, len(rows) - 2, sub.shape[1]))[0]


def summary(values: list[float]):
    if not values:
        return None
    v = np.asarray(values, dtype=float)
    q = np.percentile(v, [25, 50, 75])
    return {"count": len(v), "min": float(v.min()), "q25": float(q[0]), "median": float(q[1]),
            "q75": float(q[2]), "max": float(v.max()), "mean": float(v.mean())}


def compare(full: np.ndarray, rows: list[int], sub: np.ndarray) -> dict:
    ref = full[rows]
    both = (ref >= 0) & (sub >= 0)
    a, b = ref[both], sub[both]
    ari = None
    if len(a) >= MIN_ARI and len(set(a)) >= 2 and len(set(b)) >= 2:
        ari = float(adjusted_rand_score(a, b))
    return {"intersection_size": len(rows), "assigned_in_both_size": int(both.sum()), "ari": ari,
            "cluster_count": int(sub.max() + 1) if (sub >= 0).any() else 0,
            "noise": int((sub < 0).sum())}


def units_of(spec: dict, n: int) -> list[list[int]]:
    mode = spec["unit"]
    if mode in ("sample", "unknown"):
        return [[i] for i in range(n)]
    key = spec["group_of"]
    groups: dict[str, list[int]] = {}
    for i in range(n):
        groups.setdefault(key[i], []).append(i)
    return sorted(groups.values(), key=lambda rows: rows[0])


def plans_of(units: list[list[int]], seed: int) -> tuple[list[list[int]], list[list[int]]]:
    rng = np.random.default_rng(seed)
    m = (4 * len(units) + 4) // 5
    unit_plans, row_plans = [], []
    for _ in range(N_SUBSAMPLES):
        chosen = sorted(int(u) for u in rng.permutation(len(units))[:m])
        unit_plans.append(chosen)
        row_plans.append(sorted(r for u in chosen for r in units[u]))
    return unit_plans, row_plans


def appearance(full: np.ndarray, k: int, plans, partitions) -> list[dict]:
    matched = [[] for _ in range(k)]
    for rows, sub in zip(plans, partitions):
        ref = full[rows]
        ks = int(sub.max() + 1) if (sub >= 0).any() else 0
        best = np.zeros(k)
        sizes = np.array([(ref == c).sum() for c in range(k)])
        if ks:
            jac = np.zeros((k, ks))
            for i in range(k):
                for j in range(ks):
                    inter = ((ref == i) & (sub == j)).sum()
                    jac[i, j] = inter / ((ref == i).sum() + (sub == j).sum() - inter)
            r, c = linear_sum_assignment(jac, maximize=True)
            best[r] = jac[r, c]
        for i in range(k):
            if sizes[i] > 0:
                matched[i].append(float(best[i]))
    return [{"label": i, "n_evaluable_subsamples": len(matched[i]),
             "n_appeared": sum(j > 0.5 for j in matched[i]),
             "matched_jaccard": summary(matched[i])} for i in range(k)]


def protocol(x: np.ndarray, spec: dict, root: int, source_id: str) -> dict:
    n = len(x)
    mcs = max(5, math.ceil(n / 20))
    scores, eig = pca(x, min(10, n - 2, x.shape[1]))
    full = hdbscan(scores, mcs, mcs)
    stock = HDBSCAN(min_cluster_size=mcs, min_samples=mcs, copy=True).fit(quantize(scores)).labels_
    k = int(full.max() + 1) if (full >= 0).any() else 0
    units = units_of(spec, n)
    plan_seed = derive_seed(root, f"nirs4all-preflight\0methods\0{PROTOCOL}\0subsample_plans\0{source_id}")
    unit_plans, plans = plans_of(units, plan_seed)
    out = {"n": n, "min_cluster_size": mcs, "labels": full.tolist(), "cluster_count": k,
           "noise": int((full < 0).sum()), "stock_sklearn_ari": float(adjusted_rand_score(full, stock)),
           "n_resampling_units": len(units), "plan_seed": str(plan_seed), "unit_plans": unit_plans, "variants": {}}
    scaled = (max(2, (4 * mcs + 4) // 5), max(1, (4 * mcs + 4) // 5))
    for name, params in (("scaled", scaled), ("constant", (mcs, mcs))):
        partitions = [hdbscan(refit(x, rows), *params) for rows in plans]
        comparisons = [compare(full, rows, sub) for rows, sub in zip(plans, partitions)]
        aris = [c["ari"] for c in comparisons if c["ari"] is not None]
        out["variants"][name] = {
            "per_subsample": comparisons,
            "ari_assigned_in_both": summary(aris),
            "assigned_in_both_fraction_of_eligible": summary([c["assigned_in_both_size"] / n for c in comparisons]),
            "appearance": appearance(full, k, plans, partitions) if k else None,
        }
    obs_ari = (out["variants"]["scaled"]["ari_assigned_in_both"] or {}).get("median")
    ridge = 1e-6 * eig.mean()
    cov = np.diag(eig + ridge)
    replicates = []
    for b in range(N_NULL):
        seed = derive_seed(root, f"nirs4all-preflight\0methods\0{PROTOCOL}\0gaussian_null\0{source_id}\0{b}")
        draw = np.random.default_rng(seed).multivariate_normal(np.zeros(len(eig)), cov, size=n, method="cholesky")
        null_full = hdbscan(refit(draw, list(range(n))), mcs, mcs)
        aris = []
        for rows in plans:
            c = compare(null_full, rows, hdbscan(refit(draw, rows), *scaled))
            if c["ari"] is not None:
                aris.append(c["ari"])
        replicates.append({"cluster_count": int(null_full.max() + 1) if (null_full >= 0).any() else 0,
                           "noise_fraction": float((null_full < 0).sum() / n),
                           "median_ari": float(np.median(aris)) if aris else None})
    out["null"] = {"per_replicate": replicates}
    if obs_ari is not None:
        ge = sum(r["median_ari"] is not None and r["median_ari"] >= obs_ari for r in replicates)
        out["null"]["median_ari_upper_tail_fraction"] = (1 + ge) / (1 + N_NULL)
        noise = out["noise"] / n
        joint = sum(r["cluster_count"] >= k and r["noise_fraction"] <= noise and r["median_ari"] is not None
                    and r["median_ari"] >= obs_ari for r in replicates)
        out["null"]["joint_dominance_upper_tail_fraction"] = (1 + joint) / (1 + N_NULL)
    return out


def source_input(source_id: str, x: np.ndarray, spec: dict, root: int) -> dict:
    n = len(x)
    ids = [f"s{i:03d}" for i in range(n)]
    samples = []
    for i, sid in enumerate(ids):
        s = {"sample_id": sid, "physical_sample_id": sid}
        if spec["unit"] == "group":
            s["independence_group"] = spec["group_of"][i]
        samples.append(s)
    targets = []
    if spec["unit"] == "reference_group":
        targets.append({"target_id": "composite", "kind": "continuous", "values": [
            {"sample_id": sid, "value": float(i % 7), "status": "composite",
             "reference_group_id": spec["group_of"][i]} for i, sid in enumerate(ids)]})
    return {"schema_version": 1, "data_origin": "synthetic",
            "sources": [{"source_id": source_id, "observation_ids": [f"o{sid}" for sid in ids],
                         "sample_ids": ids, "x": x.tolist(), "axis": list(range(1, x.shape[1] + 1))}],
            "samples": samples, "targets": targets,
            "options": {"independence_unit": spec["unit"], "seed": root}}


def datasets() -> list[tuple[str, np.ndarray, dict, int]]:
    rng = np.random.default_rng(20261014)
    grid = np.round(rng.normal(0, 1.5, (70, 2)))
    ties = np.vstack([grid, np.repeat(grid[:4], 5, axis=0)])
    blobs = np.vstack([rng.normal(c, 0.35, (20, 4)) for c in ([0, 0, 0, 0], [6, 0, 1, 0], [0, 6, 0, 1])])
    continuum = rng.multivariate_normal(np.zeros(3), np.diag([4.0, 1.0, 0.25]), size=60)
    # The `duplicates_ties` case of Methods parity/generators/hdbscan_v1.py (same
    # draw sequence from default_rng(20261013)), on which the 2026-10-13 review
    # found 7 CPU and 8 WASM groups with undeclared units and seed 7.
    review = np.random.default_rng(20261013)
    for size in ((40, 2), (40, 2), (40, 2), (60, 2), (40, 2)):
        review.normal(0, 1, size)
    review.uniform(-3, 9, (10, 2))
    review.uniform(-1, 1, (100, 3))
    review.uniform(0, 1, 120)
    review.normal(0, 0.01, (120, 2))
    review_grid = np.round(review.normal(0, 1.5, (70, 2)))
    review_ties = np.vstack([review_grid, np.repeat(review_grid[:4], 5, axis=0)])
    return [
        ("review_duplicates_ties", review_ties, {"unit": "unknown"}, 7),
        ("duplicates_ties", ties, {"unit": "sample"}, 7),
        ("separated_blobs", blobs, {"unit": "group", "group_of": [f"g{i // 2:02d}" for i in range(60)]}, 11),
        ("gaussian_continuum", continuum,
         {"unit": "reference_group", "group_of": [f"r{i // 3:02d}" for i in range(60)]}, 13),
    ]


def main() -> None:
    versions = {name: metadata.version(name) for name in PINNED}
    if versions != PINNED:
        raise SystemExit(f"pinned reference versions required: {PINNED}, found {versions}")
    warnings.filterwarnings("ignore", category=FutureWarning)
    cases = []
    for name, x, spec, root in datasets():
        cases.append({"name": name, "input": source_input(name, x, spec, root),
                      "expected": protocol(x, spec, root, name)})
        e = cases[-1]["expected"]
        print(f"{name}: clusters={e['cluster_count']} noise={e['noise']} stock_ari={e['stock_sklearn_ari']:.3f}"
              f" scaled_median_ari={(e['variants']['scaled']['ari_assigned_in_both'] or {}).get('median')}"
              f" null_joint_tail={e['null'].get('joint_dominance_upper_tail_fraction')}")
    body = {"format": "n4pf_clustering_v2_golden", "protocol": PROTOCOL,
            "reference": {**versions, "python": sys.version.split()[0],
                          "hdbscan": "scikit-learn 1.9.1 internals with a stable MST edge sort (Methods tie rule)"},
            "cases": cases}
    out = (Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
           / "crates" / "nirs4all-preflight" / "tests" / "fixtures" / "clustering_v2_golden.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(body, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
