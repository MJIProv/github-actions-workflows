# Manifest — v1.1.0

Pin: **numpy 2.3.4 / scipy 1.16.1 / contourpy 1.3.3**, declared once in `requirements.txt`.

## canonical/ — 3 files, one per package

| Path | SHA-256 (16) | Version |
|------|--------------|---------|
| `numpy/ma/__init__.py` | `5e90d6617c1ab837` | numpy 2.3.4 |
| `scipy/sparse/csgraph/__init__.py` | `ce7ac4778f0914b7` | scipy 1.16.1 |
| `contourpy/__init__.py` | `eac7fe2b40f8c5a1` | contourpy 1.3.3 |

## Dropped
`581bf30e-__init__.py` — **DELETED**. Byte-identical (`ce7ac477…`) to `29c76dbf`.
Zero information loss; identity re-verified immediately before `rm`.

## Quarantined, not deleted
`superseded/contourpy-1.3.0_1.3.2__init__.py` (`562d986ed52133d5`) — contourpy
1.3.0/1.3.1/1.3.2, **not** a duplicate. Distinct bytes (two extra
`# type: ignore[no-untyped-call]` comments). Rollback artifact.

## v1.1.0 — rebuilt after container loss

The container holding v1.0.0 was reclaimed. Lost: the whole toolkit, the release archive,
`install.sh`, the original uploaded files, and the installed packages. The delivered
archive and `install.sh` survived as conversation attachments — which is the entire reason
the bundle exists.

Reconstruction was **not** from memory. All four `__init__.py` files were re-fetched from
upstream release tags and verified against the SHA-256 digests recorded from the original
uploads. All four matched, so the provenance link is intact despite the uploads being gone.

### Structural fix: `verify.sh` step 4 no longer hardcodes versions

It previously carried `want = {"numpy": "2.3.4", ...}` inline, so every pin bump would
silently desynchronise the check from the actual pin — it would keep passing against the
old numbers. It now parses `requirements.txt`, making that file the single pin source.
Negative-tested: setting `contourpy==1.4.0` in `requirements.txt` with 1.3.3 installed
yields `FAIL contourpy is 1.3.3, requirements.txt says 1.4.0` and exit 1.

### Pin staleness re-checked

numpy 2.3.4 → 2.4.6, scipy 1.16.1 → 1.17.1 available on Python 3.11. contourpy 1.3.3 is
**already the ceiling** — 1.4.0 needs ≥3.12, as do numpy 2.5.x and scipy 1.18.x. numpy
2.4.0 is yanked. Both sets produce **identical demo output**; see `CHANGE-ORDER.md`.
Recommendation: hold.

## Defects found and fixed across both versions

| Defect | Detail |
|--------|--------|
| `pyproject.toml` would not build | Shipped as "the installable form" without ever running `pip install .`. setuptools saw `canonical/` and `superseded/` as rival packages. Fixed with `[tool.setuptools] py-modules = []`; guarded by step 6 |
| Step 6 guard passed vacuously | "Cleaning up" the litter by building in a scratch dir holding only `pyproject.toml` removed the directories the bug needs. It passed *with the bug reintroduced*. Fixed by copying the whole tree. **A cleanup that touches a test's fixtures can invalidate it without failing it** |
| One-sided tamper test | Extracted the *first* hash in contourpy's sorted block, not the wheel pip selects. The control case failed too, so it had no discriminating power. Replaced with `tamper_test.py` |
| `--dry-run` validated nothing | First "verification" reported `Requirement already satisfied` and checked zero digests |
| Circular hash | The archive's own digest was written into `README.md`/`MANIFEST.md`, which are *inside* the archive. Could never match. The digest moved to the bootstrap, outside the archive; since the move to git neither is committed |
| Build residue shipped | An earlier `pip wheel` left `masked_stack.egg-info/` in the first archive. `.gitignore` + `tar --exclude` now |
| `-I` footgun in the demo | Docstring recommended `python3 -I`, which excludes user site-packages — what made matplotlib look broken mid-build (`python-dateutil` was in `/root/.local/...`) |
| False repo scan | `gh api` writes a 404 body to **stdout**, so a non-empty-output test reported every repo as containing `requirements.txt`. Corrected to use exit codes: none of the six repos contains any `.py` file |
| Broken system Pillow | On rebuild, matplotlib failed to import: `/usr/lib/python3/dist-packages/PIL` lacked `_imaging`. A container defect, not a pin problem. Fixed with `pip install --upgrade pillow` |

## Release bundle

The bootstrap lived **outside** the archive and was the only place the expected digest
appeared. Writing the digest into any bundled file makes it self-referential. Neither the
bootstrap nor the archive is committed here -- see README.md.

Tested each build: extract into a clean directory, run `./verify.sh` from the *extracted*
copy, corrupt the archive by one byte (must refuse, exit 1), clobber guard, `FORCE=1`
override, and a rebuild producing a byte-identical digest.
