# Real demonstration datasets

Beer CSV files are copied byte for byte from `nirs4all-web/web-app/src/data/demo`
at commit `0ec8790b4afc896a01c0f85ef59f9e347a83c3a2`; the Anopheles CSV files were
rebuilt from the original source files (see the correction record below).
`SHA256SUMS` records the bundled files. Both datasets are real observations, not
synthetic data, and use their published train/test assignments; they are
demonstration splits, not newly qualified validation plans.

## Beer (OHPL)

60 NIR spectra, 576 bands, original extract target; 40 development / 20 retained test.
Source: the `beer` dataset in OHPL by You-Wu Lin and Nan Xiao (the package credits
and data documentation are at https://github.com/nanxstats/OHPL and
https://ohpl.io/doc/). The OHPL package declares GPL-3 as a license option:
https://github.com/nanxstats/OHPL/blob/master/DESCRIPTION.
The included copy uses that GPL-3 option; see `GPL-3.0.txt`.
CSV extraction and the split are inherited from nirs4all-web; no further data
transformation is performed by preflight.

## Anopheles gambiae: oocyst presence

333 NIR spectra, 2,151 bands; 227 development / 106 retained test.
Source: Maia, Marta F.; Kapulu, Melissa; Muthui, Michelle; Wagah, Martin G.;
Fergusson, Heather M.; Dowell, Floyd E.; Baldini, Franscesco;
Ranford-Cartwright, Lisa. *Replication Data for: Near infrared spectra and
calibration for detection of malaria infection in Anopheles gambiae (Keele
strain)*. Harvard Dataverse. https://doi.org/10.7910/DVN/YD34OX.

The source dataset's terms explicitly grant CC BY 4.0:
https://dataverse.harvard.edu/api/datasets/:persistentId/?persistentId=doi:10.7910/DVN/YD34OX.
See `CC-BY-4.0.txt`. The CSV files follow the authors' oocyst (7-day) split
exactly: the 227 spectra of `Spectra training dataset oocyst infection` are the
development set and the 106 spectra of `Spectra test dataset oocyst infection` are
the retained test, both in file name order, on the original 350–2500 nm axis
(Log(1/R)). The reference is coded as oocyst presence: 0 when the Stata `actual`
code is 1 (parasite load 0), 1 when it is 2 (parasite load > 0). Preflight labels
0/1 as categories; this does not imply endorsement by the original authors.

**Correction record (2026-11-20).** The extract previously bundled here (inherited
from nirs4all-web, which took it from an earlier standardized export) had a correct
development set but a defective retained test: `Xtest.csv` rows 47–105 copied
oocyst calibration spectra (labels disagreed in 26 of those 59 pairs) and rows 0–46
were sporozoite (14-day) calibration spectra, so none of the 106 test rows was an
oocyst validation spectrum. This was established by matching every row against the
authors' `.tdfx` calibration files. The four CSV files were rebuilt with
`demo/scripts/build-anopheles-extract.py` from the Dataverse full download
`dataverse_files.zip` (SHA-256
`6bec398578f647a01cc2f1f855778d715ea1fdfe3046a8d75c3a36308d95defa`; the archive is
guestbook-gated and not redistributed here). The script checks the Dataverse MD5 of
each member it reads (`NIRS spectra P falciparum infection.zip`
`70613ce6daa5c58c45fa9761f66a3219`, `Calibration dataset.dta`
`a0982d0d9a410793743650928d7909d5`, `Validation dataset.dta`
`6053ea34835dbd96b3a0d8cac7c3e68b`, `Prediction outputs validation datasets.xlsx`
`4a63210d47b5b6c60e87b619aa9947be`), decodes the `.spc` files with
nirs4all-formats, maps each file to its Stata sample id one to one (checked against
the authors' per-file prediction outputs) and refuses duplicated spectra. The
rebuilt development rows and labels equal the previous ones (only the row order
changed); the retained test now holds the 106 authors' validation spectra (53 / 53)
and shares no spectrum with the development set.

These provenance and license records were checked on 2026-10-29. Corn and Meat
from Web are not bundled here because its source notes do not establish a
redistribution license for those copies.
