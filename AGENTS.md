# Repository Guidelines

Follow the workspace instructions in `../AGENTS.md` and the repository-specific guidance in `CLAUDE.md` when present.

## Language Policy

All application and project content must be in English, including UI text, subtitles, tooltips, errors, documentation, comments and docstrings, test and fixture prose, reports, pull requests, commits, and generated content. Conversation with the maintainer may be in French. Preserve proper names, identifiers, filenames, source quotations, and historical or provenance records where translation would change their meaning or provenance.

## Versioning

- Versioning: versions are `X.Y.Z`. `Z` (patch) = fixes and purely additive, backward-compatible features (existing outputs, wire formats, schemas and ABI symbols unchanged); `Y` (minor) = any compatibility break (changed/removed API signature, ABI break or ABI version change, wire/byte/schema/fixture change, renamed ids, changed numerical results of existing operations); `X` = product version. The package that bumps classifies its change. Cross-repository dependencies accept one tested series, `>=X.Y[.Z],<X.(Y+1)` (patch floor only when a fix or feature from that patch is required); for 1.x packages never npm `^1.x` or Cargo `"1.x"` (they accept the next minor): use `~1.4.1`, `">=1.4.1, <1.5"`, `>=1.4.1,<1.5`. Exact pins only in lockfiles, wheel locks and product install lists; intra-repo lockstep may stay exact. Crates, npm and the Python wheel of this repository stay in exact lockstep. See the [ecosystem version constraints](https://github.com/GBeurier/nirs4all-ecosystem/blob/main/docs/contracts/release/VERSION_CONSTRAINTS.md).
