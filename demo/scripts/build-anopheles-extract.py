"""Rebuild the bundled Anopheles oocyst demo extract from the original Dataverse files.

Source: Maia et al., Harvard Dataverse, https://doi.org/10.7910/DVN/YD34OX (CC BY 4.0).
Input: the dataset's full download (``dataverse_files.zip``, guestbook-gated, never bundled).

The authors' oocyst (7-day) split is kept exactly: the 227 spectra in
``Spectra training dataset oocyst infection`` become Xtrain/Ytrain and the 106
spectra in ``Spectra test dataset oocyst infection`` become Xtest/Ytest, in file
name order. Spectra are decoded by nirs4all-formats (Galactic SPC reader). Labels
come from the authors' Stata tables: ``actual`` 1 = no oocysts (parasite load 0)
-> 0, ``actual`` 2 = oocysts present (parasite load > 0) -> 1.

Usage (a Python environment with ``nirs4all-formats``, ``pandas`` and ``openpyxl``)::

    python -I demo/scripts/build-anopheles-extract.py dataverse_files.zip demo/src/data/demo/anopheles
"""

from __future__ import annotations

import hashlib
import io
import re
import sys
import zipfile
from pathlib import Path

import nirs4all_formats
import pandas as pd

INNER = "NIRS spectra P falciparum infection/NIRS spectra P falciparum infection.zip"
CALIBRATION = "Calibration dataset.dta"
VALIDATION = "Validation dataset.dta"
PREDICTIONS = "Prediction outputs validation datasets.xlsx"
# MD5 checksums published by Harvard Dataverse for these files (dataset version 1.1).
DATAVERSE_MD5 = {
    INNER: "70613ce6daa5c58c45fa9761f66a3219",
    CALIBRATION: "a0982d0d9a410793743650928d7909d5",
    VALIDATION: "6053ea34835dbd96b3a0d8cac7c3e68b",
    PREDICTIONS: "4a63210d47b5b6c60e87b619aa9947be",
}
SPLITS = {
    # split: (SPC folder in the inner archive, Stata table, parasite-load column)
    "train": ("Spectra training dataset oocyst infection/", CALIBRATION, "parasite_load"),
    "test": ("Spectra test dataset oocyst infection/", VALIDATION, "parasiteload"),
}
AXIS = list(range(350, 2501))


def sample_key(text: str) -> tuple[str, str, int]:
    """Normalize a Stata sample id or an SPC file stem to (round, group, number)."""
    match = re.match(r"^21C(\d)(\d{5})$", text)  # files: 21C400005 -> round 214, control
    if match:
        return f"21{match[1]}", "C", int(match[2])
    for pattern in (
        r"^M(\d{3})([CG]?) *(\d+)$",  # Stata: M214C000, M113G27, M313 22
        r"^(\d{3})([CG])_?(\d{5})$",  # files: 113C_00003, 214G00011
        r"^(\d{3})()(\d{5})$",  # files: 31200001
    ):
        match = re.match(pattern, text)
        if match:
            return match[1], match[2], int(match[3])
    raise ValueError(f"Unrecognized sample identifier: {text!r}")


def value_text(value: float) -> str:
    """Seven decimals without trailing zeros (``10.0`` for integers), the existing demo number format."""
    text = f"{value:.7f}".rstrip("0")
    return text + "0" if text.endswith(".") else text


def read_member(archive: zipfile.ZipFile, name: str) -> bytes:
    payload = archive.read(name)
    digest = hashlib.md5(payload).hexdigest()
    if digest != DATAVERSE_MD5[name]:
        raise SystemExit(f"{name}: MD5 {digest} does not match Dataverse {DATAVERSE_MD5[name]}")
    return payload


def decode(name: str, payload: bytes) -> list[float]:
    (record,) = nirs4all_formats.open_bytes(name, payload)
    signal = record["signals"]["absorbance"]
    axis = signal["axis"]
    if axis["unit"] != "nm" or [float(v) for v in AXIS] != list(axis["values"]):
        raise SystemExit(f"{name}: unexpected axis")
    return list(signal["values"])


def write_csv(path: Path, header: list[str], rows: list[list[str]]) -> None:
    lines = [";".join(header)] + [";".join(row) for row in rows]
    path.write_bytes(("\r\n".join(lines) + "\r\n").encode("ascii"))


def main(zip_path: str, out_dir: str) -> None:
    outer = zipfile.ZipFile(zip_path)
    inner = zipfile.ZipFile(io.BytesIO(read_member(outer, INNER)))
    predictions = pd.read_excel(io.BytesIO(read_member(outer, PREDICTIONS)), sheet_name="7 days")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    for split, (folder, table_name, load_column) in SPLITS.items():
        table = pd.read_stata(io.BytesIO(read_member(outer, table_name)))
        table = table[table["Stage"] == "7_days"]
        infected = table["actual"] == 2
        if not (table["actual"].isin([1, 2]) & (infected == (table[load_column] > 0))).all():
            raise SystemExit(f"{split}: 'actual' disagrees with the parasite load")
        labels = {sample_key(sid): int(y) for sid, y in zip(table["sampleid"], infected, strict=True)}
        if len(labels) != len(table):
            raise SystemExit(f"{split}: duplicate sample keys in the Stata table")
        names = sorted(n for n in inner.namelist() if n.startswith(folder) and n.endswith(".spc"))
        keys = [sample_key(Path(n).stem) for n in names]
        if sorted(keys) != sorted(labels):
            raise SystemExit(f"{split}: SPC files and Stata sample ids do not match one to one")
        if split == "test":
            # Cross-check the file -> sample mapping: the authors' IQ Predict output for each file
            # equals the PLS score recorded for the mapped sample in the validation table.
            scores = dict(zip(map(sample_key, table["sampleid"]), table["PLS_score"], strict=True))
            for sample, value in zip(predictions["Sample"], predictions["Pred_Value"], strict=True):
                if abs(scores[sample_key(Path(sample.replace("\\", "/")).stem)] - value) > 1e-5:
                    raise SystemExit(f"{sample}: prediction output does not match the validation table")
        spectra = [[value_text(v) for v in decode(Path(n).name, inner.read(n))] for n in names]
        if len({tuple(s) for s in spectra}) != len(spectra):
            raise SystemExit(f"{split}: duplicated spectra")
        write_csv(out / f"X{split}.csv", [str(w) for w in AXIS], spectra)
        write_csv(out / f"Y{split}.csv", ["x"], [[str(labels[k])] for k in keys])
        print(f"{split}: {len(names)} spectra, {sum(labels[k] for k in keys)} with oocysts")

    for name in ("Xtrain.csv", "Ytrain.csv", "Xtest.csv", "Ytest.csv"):
        print(hashlib.sha256((out / name).read_bytes()).hexdigest(), name)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2])
