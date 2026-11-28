# Change Order CO-001 — proposed pin bump

**Status: PROPOSED, not applied.** The pin remains numpy 2.3.4 / scipy 1.16.1 /
contourpy 1.3.3. Nothing in this repo was changed to the candidate values.

## Requested change

| Package | Current (established) | Proposed | Rationale |
|---------|----------------------|----------|-----------|
| numpy | 2.3.4 | **2.4.6** | 8 releases since the pin; 2.4.6 is newest installable on Python 3.11 |
| scipy | 1.16.1 | **1.17.1** | newest installable on Python 3.11 |
| contourpy | 1.3.3 | **1.3.3 — no change** | 1.3.3 is ALREADY the newest release for Python 3.11 |
| matplotlib (extra) | >=3.9 | no change | 3.11.2 is current; floors only, no ceiling |

## Why contourpy does NOT move

`contourpy 1.4.0` exists but declares `Requires-Python >=3.12`. On Python 3.11 the
pin is already at the ceiling. A raw "latest version" check reports 1.4.0 and is
misleading; the installable ceiling is what matters.

## Upstream verification of Requires-Python

| Package | Version | Requires-Python | Installable on 3.11 |
|---------|---------|-----------------|---------------------|
| numpy | 2.5.4 | `>=3.12` | no |
| numpy | 2.4.6 | `>=3.11` | yes |
| numpy | 2.4.0 | — | **YANKED** |
| scipy | 1.18.1 | `>=3.12` | no |
| scipy | 1.17.1 | `>=3.11` | yes |
| contourpy | 1.4.0 | `>=3.12` | no |
| contourpy | 1.3.3 | `>=3.11` | yes |

## Cascading downstream impacts

1. **Behaviour: none measured.** `masked_contract_demo.py` was run under both sets.
   Diffing the output with the version banner excluded gives **zero differences** —
   every masked-array, csgraph and contourpy number is identical. The sentinel-zero
   result (`shortest_path 0->3` = `inf` wrong vs `5.0` right) and the `corner_mask`
   vertex counts (6 vs 8) hold under both.
2. **`canonical/` files change.** They are byte-copies of the pinned releases'
   `__init__.py`. Bumping numpy/scipy means re-fetching `numpy/ma/__init__.py` and
   `scipy/sparse/csgraph/__init__.py` at the new tags, and they will **no longer
   byte-match the files originally uploaded**. The current canonical set is the
   provenance record for those uploads; bumping breaks that link. Keep the 2.3.4 /
   1.16.1 copies under `superseded/` if the link matters.
3. **`requirements-all-platforms.txt` must be regenerated** (`python3 gen_hashes.py`).
   Digest count will change: numpy and scipy ship different artifact counts per release.
4. **`verify.sh` needs no edit.** Step 4 reads pins from `requirements.txt`. (It used
   to hardcode them — that was fixed precisely so a bump is a one-file change.)
5. **mypy.** `warn_unused_ignores = false` must stay. contourpy drops `type: ignore`
   comments as numpy annotates the `np.ma` functions it calls, so the suppressions and
   the numpy version are coupled in both directions.
6. **Python 3.12 is the real unlock.** Moving to 3.12+ raises the ceiling to numpy
   2.5.4 / scipy 1.18.1 / contourpy 1.4.0. That is a separate, larger change order.

## To apply

1. Edit the three lines in `requirements.txt` (and mirror into `constraints.txt`,
   `pyproject.toml`).
2. `python3 gen_hashes.py`
3. Re-fetch `canonical/numpy/ma/__init__.py` and
   `canonical/scipy/sparse/csgraph/__init__.py` at the new tags.
4. `pip install --require-hashes -r requirements-all-platforms.txt`
5. `./verify.sh` — must print `ALL CHECKS PASSED`.

## Recommendation

**Hold.** The pin works, is hash-verified, and matches the uploaded files byte-for-byte.
The bump buys no measured behaviour change and costs the provenance link in `canonical/`.
Apply it when something concrete needs a numpy 2.4 or scipy 1.17 feature or fix — or
fold it into the Python 3.12 move, where contourpy 1.4.0 also becomes available and the
set advances together, which is the whole point of pinning it as a set.
