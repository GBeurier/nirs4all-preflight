# Real demonstration datasets

CSV files copied byte for byte from `nirs4all-web/web-app/src/data/demo` at
commit `0ec8790b4afc896a01c0f85ef59f9e347a83c3a2`. `SHA256SUMS` records the copied files. Both datasets are
real observations, not synthetic data. The existing train/test assignments are
preserved; they are demonstration splits, not newly qualified validation plans.

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
See `CC-BY-4.0.txt`. This is a derived CSV selection from nirs4all-web: the oocyst
reference was converted there to binary absence/presence (0/1), and a train/test
split was selected. Preflight retains those bytes and labels 0/1 as categories;
it does not imply endorsement by the original authors.

These provenance and license records were checked on 2026-10-29. Corn and Meat
from Web are not bundled here because its source notes do not establish a
redistribution license for those copies.
