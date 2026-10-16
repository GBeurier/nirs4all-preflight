"""Independent scikit-learn reference for preflight validation_probe.v1.

Test-only golden. For each case it writes the preflight input JSON and the
expected outer/inner GroupKFold assignments, selected components, OOF
predictions, fold-train means and scores:
PLSRegression(scale=False) and PCA + LinearRegression (PCR), component
selection by pooled inner-OOF RMSE (ties to fewer components), fold-train
mean baseline, pooled RMSE, MAE, R2 and skill = 1 - SSE_model/SSE_mean, and
per (instrument, campaign) domain scores.

Cases:
- base: 55 samples, ten individuals of distinct sizes (GroupKFold has no
  ties), domains whose names contain the '|' separator;
- rank_deficient: rank-2 spectra on 6 bands (grid capped at the numerical
  rank, NumPy matrix_rank rule on the centered matrix);
- repeats: 1 to 3 technical rescans per sample, averaged (NumPy mean)
  before fitting.
Run: python3 generate_probe_sklearn_v1.py
"""
import json
import math
import platform
import sys
from pathlib import Path

import numpy as np
import sklearn
from sklearn.cross_decomposition import PLSRegression
from sklearn.decomposition import PCA
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, r2_score
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline


def make_input(case, rng):
    sizes = list(range(1, 11))
    n = sum(sizes)
    p = 12 if case != "rank_deficient" else 6
    individual = np.repeat([f"ind{i:02d}" for i in range(len(sizes))], sizes)
    ids = [f"s{i:02d}" for i in range(n)]
    domains = [("A|B", "C"), ("A", "B|C"), (None, "C")]
    domain = [domains[i % 3] for i in range(n)]
    latent = rng.normal(size=(n, 3))
    if case == "rank_deficient":
        latent[:, 2] = 0.0
        x = latent[:, :2] @ rng.normal(size=(2, p))
    else:
        x = latent @ rng.normal(size=(3, p)) + 0.05 * rng.normal(size=(n, p))
        x += 0.3 * np.array([i % 3 == 1 for i in range(n)])[:, None]
    y = 1.5 * latent[:, 0] - 0.8 * latent[:, 1] + 0.2 * latent[:, 2] + 0.1 * rng.normal(size=n) + 10.0
    repeats = [1 + (i % 3) if case == "repeats" else 1 for i in range(n)]
    obs_ids, obs_samples, obs_x, rep_types = [], [], [], []
    aggregated = np.empty_like(x)
    for i, sid in enumerate(ids):
        rows = x[i] + (0.02 * rng.normal(size=(repeats[i], p)) if repeats[i] > 1 else 0.0)
        rows = np.atleast_2d(rows)
        aggregated[i] = rows.mean(axis=0)
        for r, row in enumerate(rows):
            obs_ids.append(f"o-{sid}-{r}")
            obs_samples.append(sid)
            obs_x.append(row.tolist())
            rep_types.append("rescan")
    data = {
        "schema_version": 1,
        "data_origin": "synthetic",
        "sources": [{
            "source_id": "nir", "observation_ids": obs_ids, "sample_ids": obs_samples,
            "x": obs_x, "axis": [1000 + 10 * i for i in range(p)], "axis_unit": "nm",
            "signal_unit": "absorbance", "repetition_types": rep_types,
        }],
        "samples": [
            {"sample_id": sid, "individual_id": individual[i],
             **({"instrument": domain[i][0]} if domain[i][0] is not None else {}),
             "campaign": domain[i][1]}
            for i, sid in enumerate(ids)
        ],
        "targets": [{
            "target_id": "y", "kind": "continuous", "unit": "%",
            "values": [{"sample_id": sid, "value": float(y[i]), "status": "exact"}
                       for i, sid in enumerate(ids)],
        }],
        "options": {"independence_unit": "sample", "seed": "7", "snv_sensitivity": False},
    }
    return data, ids, individual, domain, aggregated, y


def probe(kind, x, y, groups, grid, outer_k, inner_k, ids, domain):
    def fit_predict(k, train, test):
        model = (PLSRegression(n_components=k, scale=False) if kind == "pls"
                 else make_pipeline(PCA(n_components=k), LinearRegression()))
        return np.asarray(model.fit(x[train], y[train]).predict(x[test])).ravel()

    n = len(y)
    pred, base, folds = np.empty(n), np.empty(n), []
    for train, test in GroupKFold(n_splits=outer_k).split(x, y, groups):
        inner = list(GroupKFold(n_splits=inner_k).split(x[train], y[train], groups[train]))
        scores = []
        for k in grid:
            err = np.empty(len(train))
            for itrain, itest in inner:
                err[itest] = fit_predict(k, train[itrain], train[itest]) - y[train[itest]]
            scores.append(float(np.sqrt(np.mean(err ** 2))))
        best = grid[int(np.argmin(scores))]  # first minimum: fewest components
        pred[test] = fit_predict(best, train, test)
        base[test] = y[train].mean()
        folds.append({
            "validation_sample_ids": sorted(ids[i] for i in test),
            "inner_validation_sample_ids": [sorted(ids[train[i]] for i in it) for _, it in inner],
            "inner_rmse": scores,
            "selected_components": best,
            "train_mean": float(y[train].mean()),
        })
    sse, sse_base = float(np.sum((y - pred) ** 2)), float(np.sum((y - base) ** 2))
    domains = []
    for d in sorted(set(domain), key=lambda t: (t[0] is not None, t[0] or "", t[1])):
        m = np.array([dd == d for dd in domain])
        domains.append({
            "instrument": d[0], "campaign": d[1], "n_samples": int(m.sum()),
            "rmse": float(np.sqrt(np.mean((y[m] - pred[m]) ** 2))),
            "train_mean_rmse": float(np.sqrt(np.mean((y[m] - base[m]) ** 2))),
        })
    return {
        "folds": folds, "prediction": pred.tolist(), "train_mean_prediction": base.tolist(),
        "rmse": math.sqrt(sse / n), "mae": float(mean_absolute_error(y, pred)),
        "r2_oof": float(r2_score(y, pred)), "skill_vs_train_mean": 1 - sse / sse_base,
        "train_mean_rmse": math.sqrt(sse_base / n), "domains": domains,
    }


cases = {}
for seed, case in enumerate(["base", "rank_deficient", "repeats"]):
    rng = np.random.default_rng(20261013 + seed)
    data, ids, individual, domain, x, y = make_input(case, rng)
    component = {ind: min(s for s, j in zip(ids, individual) if j == ind) for ind in set(individual)}
    groups = np.array([f"component:{component[j]}" for j in individual])
    sizes = np.unique(groups, return_counts=True)[1]
    n, p = x.shape
    outer_k = min(5, len(sizes))
    inner_k = min(3, outer_k - 1)
    rank = int(np.linalg.matrix_rank(x - x.mean(axis=0)))
    bound = math.floor((n * (1 - 1 / outer_k) - sizes.max()) * (1 - 1 / inner_k) - sizes.max())
    grid = list(range(1, min(10, p, rank, bound - 1) + 1))
    ids_arr = np.array(ids)
    cases[case] = {
        "input": data, "numerical_rank": rank, "outer_splits": outer_k, "inner_splits": inner_k,
        "component_grid": grid, "sample_ids": ids,
        "pls": probe("pls", x, y, groups, grid, outer_k, inner_k, ids_arr, domain),
        "pcr": probe("pcr", x, y, groups, grid, outer_k, inner_k, ids_arr, domain),
    }

golden = {
    "provenance": {
        "generator": "crates/nirs4all-preflight/tests/fixtures/generate_probe_sklearn_v1.py",
        "python": platform.python_version(), "numpy": np.__version__,
        "scikit_learn": sklearn.__version__, "test_only": True,
    },
    "protocol": "validation_probe.v1",
    "cases": cases,
}
out = Path(__file__).with_name("probe_sklearn_v1.json")
out.write_text(json.dumps(golden, indent=1) + "\n")
print(f"wrote {out}", file=sys.stderr)
