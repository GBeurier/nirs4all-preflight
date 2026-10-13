"""Independent scikit-learn reference for preflight validation_probe.v1.

Test-only golden: GroupKFold outer/inner splits, PLSRegression(scale=False)
and PCA + LinearRegression (PCR), component selection by pooled inner-OOF
RMSE (ties to fewer components), fold-train mean baseline, pooled OOF RMSE,
MAE, R2 and skill = 1 - SSE_model / SSE_train_mean. Group sizes are distinct
so GroupKFold has no ties. Run: python3 generate_probe_sklearn_v1.py
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

rng = np.random.default_rng(20261013)
sizes = list(range(1, 11))  # ten individuals, distinct component sizes
n = sum(sizes)
p = 12
individual = np.repeat([f"ind{i:02d}" for i in range(len(sizes))], sizes)
sample_ids = [f"s{i:02d}" for i in range(n)]
campaign = np.array(["C1" if i % 2 == 0 else "C2" for i in range(n)])
latent = rng.normal(size=(n, 3))
loadings = rng.normal(size=(3, p))
x = latent @ loadings + 0.05 * rng.normal(size=(n, p)) + 0.3 * (campaign == "C2")[:, None]
y = 1.5 * latent[:, 0] - 0.8 * latent[:, 1] + 0.2 * latent[:, 2] + 0.1 * rng.normal(size=n) + 10.0
# Preflight component name: smallest sample ID of the linked individual.
component = {ind: min(s for s, j in zip(sample_ids, individual) if j == ind) for ind in set(individual)}
groups = np.array([f"component:{component[j]}" for j in individual])

# Plan rule of validation_probe.v1 (protocol, not numerics).
outer_k, inner_k = min(5, len(sizes)), min(3, min(5, len(sizes)) - 1)
bound = math.floor((n * (1 - 1 / outer_k) - max(sizes)) * (1 - 1 / inner_k) - max(sizes))
grid = list(range(1, min(10, p, bound - 1) + 1))


def estimator(kind, k):
    if kind == "pls":
        return PLSRegression(n_components=k, scale=False)
    return make_pipeline(PCA(n_components=k), LinearRegression())


def fit_predict(kind, k, train, test):
    model = estimator(kind, k).fit(x[train], y[train])
    return np.asarray(model.predict(x[test])).ravel()


def probe(kind):
    outer = list(GroupKFold(n_splits=outer_k).split(x, y, groups))
    pred = np.empty(n)
    base = np.empty(n)
    folds = []
    for train, test in outer:
        inner = list(GroupKFold(n_splits=inner_k).split(x[train], y[train], groups[train]))
        scores = []
        for k in grid:
            err = np.empty(len(train))
            for itrain, itest in inner:
                err[itest] = fit_predict(kind, k, train[itrain], train[itest]) - y[train[itest]]
            scores.append(float(np.sqrt(np.mean(err**2))))
        best = grid[int(np.argmin(scores))]  # argmin keeps the first (fewest components)
        pred[test] = fit_predict(kind, best, train, test)
        base[test] = y[train].mean()
        folds.append({
            "validation_sample_ids": sorted(sample_ids[i] for i in test),
            "inner_validation_sample_ids": [sorted(sample_ids[train[i]] for i in it) for _, it in inner],
            "inner_rmse": scores,
            "selected_components": best,
            "train_mean": float(y[train].mean()),
        })
    sse, sse_base = float(np.sum((y - pred) ** 2)), float(np.sum((y - base) ** 2))
    domains = {}
    for c in ("C1", "C2"):
        m = campaign == c
        domains[c] = {
            "n_samples": int(m.sum()),
            "rmse": float(np.sqrt(np.mean((y[m] - pred[m]) ** 2))),
            "train_mean_rmse": float(np.sqrt(np.mean((y[m] - base[m]) ** 2))),
        }
    return {
        "folds": folds,
        "prediction": pred.tolist(),
        "train_mean_prediction": base.tolist(),
        "rmse": math.sqrt(sse / n),
        "mae": float(mean_absolute_error(y, pred)),
        "r2_oof": float(r2_score(y, pred)),
        "skill_vs_train_mean": 1 - sse / sse_base,
        "train_mean_rmse": math.sqrt(sse_base / n),
        "domains": domains,
    }


golden = {
    "provenance": {
        "generator": "crates/nirs4all-preflight-dagml/tests/fixtures/generate_probe_sklearn_v1.py",
        "python": platform.python_version(),
        "numpy": np.__version__,
        "scikit_learn": sklearn.__version__,
        "test_only": True,
    },
    "protocol": "validation_probe.v1",
    "outer_splits": outer_k,
    "inner_splits": inner_k,
    "component_grid": grid,
    "sample_ids": sample_ids,
    "individual_ids": individual.tolist(),
    "campaigns": campaign.tolist(),
    "x": x.tolist(),
    "y": y.tolist(),
    "pls": probe("pls"),
    "pcr": probe("pcr"),
}
out = Path(__file__).with_name("probe_sklearn_v1.json")
out.write_text(json.dumps(golden, indent=1) + "\n")
print(f"wrote {out}", file=sys.stderr)
