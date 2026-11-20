# Consolidated: 5 uploads → 3 unique files → 1 shared contract

> **v1.1.0, rebuilt 2026-11-13.** The container holding v1.0.0 was reclaimed, taking the
> toolkit and the original uploads with it. Everything here was reconstructed from
> upstream and **verified byte-for-byte against the hashes recorded from your uploads**.
> contourpy pinned at 1.3.3; duplicate dropped; 1.3.0–1.3.2 kept in `superseded/`.
> Pin staleness re-checked a month on — see `CHANGE-ORDER.md`.

## 1. Identification (VERIFIED)

| # | Upload | SHA-256 (16) | Bytes | Actual identity | Version |
|---|--------|--------------|-------|-----------------|---------|
| 1 | `f0e44ca9` | `5e90d6617c1ab837` | 1406 | `numpy/ma/__init__.py` | **numpy ≥2.3.0** (not 2.2.x) |
| 2 | `29c76dbf` | `ce7ac4778f0914b7` | 7842 | `scipy/sparse/csgraph/__init__.py` | **scipy 1.15.0–1.16.1** |
| 3 | `78a5d9ad` | `562d986ed52133d5` | 11831 | `contourpy/__init__.py` | **contourpy 1.3.0 / 1.3.1 / 1.3.2** |
| 4 | `581bf30e` | `ce7ac4778f0914b7` | 7842 | same as #2 | **byte-identical duplicate — deleted** |
| 5 | `a8363c7e` | `eac7fe2b40f8c5a1` | 11765 | `contourpy/__init__.py` | **contourpy 1.3.3** |

Method: SHA-256 of each upload against upstream `__init__.py` at every release tag,
then installed the matched versions and byte-compared. #1, #2, #4, #5 were byte-identical
to the installed files; #3 is the older contourpy.

### These are NOT ACP harness files
Zero references to ACP, acpx, OpenClaw, Pi, Codex, Cursor, `sessions_spawn`, or any
coding-harness concept. The `acp-router` skill text in the original session's context and
these uploads are unrelated artifacts. Named, not silently reconciled.

## 2. The route — every target verified to exist upstream

**`numpy.ma`** (3 lines of code) → `core.py`, `extras.py` (+ `mrecords`, `testutils`,
4 `.pyi` stubs). `from .core import *` gives `MaskedArray`, `masked_array`, `getmask`,
`is_masked`, `masked_invalid`, `masked_values`, `masked_greater`, `filled`;
`from .extras import *` adds `median`, `polyfit`, `corrcoef`, `cov`, `notmasked_edges`.

**`scipy.sparse.csgraph`** → 10 modules, **8 of them `.pyx`** (compiled; unreadable from
a wheel): `_laplacian`, `_shortest_path`, `_traversal`, `_min_spanning_tree`, `_flow`,
`_matching`, `_reordering`, `_tools`, `_validation`. 26 names in `__all__`, all resolve.

**`contourpy`** → `_contourpy` (C++ ext), `_version`, `chunk`, `convert`, `dechunk`,
`enum_util`, `array`, `typecheck`, `types`, `util/`. The only executable logic in the file
is `_remove_z_mask()` (12 lines) and `contour_generator()` (~115 lines of validation).

## 3. Why all three are one story

They answer one question: **how does a numeric array say "no value here"?**

| Layer | Role | Mechanism |
|-------|------|-----------|
| `numpy.ma` | **defines** the contract | `MaskedArray` = `data` + parallel boolean `mask` |
| `scipy.sparse.csgraph` | **consumes** it for topology | `csgraph_from_masked` / `csgraph_to_masked` |
| `contourpy` | **consumes** it for geometry | `_remove_z_mask` → `(data, mask)`; `corner_mask` |

The crux is the **sentinel-zero ambiguity**, stated outright in the csgraph docstring:

> "how can non-edges be represented if zero is a meaningful value?"

In a dense adjacency matrix `0` means both *no edge* and *edge of weight 0*. NaN/inf
sentinels have the same defect in a `z` grid. A mask is a **separate channel**, so it
cannot collide with the value domain. That is the whole architectural reason all three
APIs accept masked arrays.

### Measured cost of getting it wrong

Graph `0 --0-- 1 --0-- 2 --5-- 3`, two genuine zero-weight edges:

```
null_value=0    WRONG   edges= 2   shortest_path 0->3 = inf
null_value=inf  RIGHT   edges= 6   shortest_path 0->3 = 5.0
from_masked     RIGHT   edges= 6   shortest_path 0->3 = 5.0
```

Treating `0` as "no edge" **silently disconnected the graph**. No exception. `5.0`
became `inf`. Identical under numpy 2.3.4/scipy 1.16.1 and numpy 2.4.6/scipy 1.17.1.

## 4. How to use these effectively

**Rule 1 — author the mask once, at ingest.** `np.ma.masked_invalid(a)` for NaN/inf,
`masked_values(a, v)` for a sentinel, `masked_greater/less(a, t)` for thresholds. Pass the
masked array downstream; never let each layer re-derive absence.

**Rule 2 — never feed a dense 0-sentinel adjacency matrix to csgraph if 0 is a real weight.**
```python
csgraph_from_masked(np.ma.masked_invalid(dense))   # mask = non-edge. Unambiguous.
csgraph_from_dense(dense, null_value=np.inf)       # equivalent, explicit
csr_array(dense)                                   # WRONG: drops zero-weight edges
```
Confirm with `g.nnz` and `np.sort(g.data)` — explicit zeros must appear in `.data`.

**Rule 3 — prefer `corner_mask=True`.** `False` discards an entire quad touching any
masked point; `True` discards only the nearest triangular corner. Measured on a 5×5 ramp
with one masked point on the contour: 6 vertices (`False`) vs 8 (`True`). `mpl2005` does
not support it. Note `contour_generator` defaults `corner_mask=None` → resolved to
`cls.supports_corner_mask()`, i.e. **True for serial/threaded/mpl2014**.

**Rule 4 — do not pre-strip NaNs for contourpy.** `_remove_z_mask` already runs
`masked_invalid`. Passing a pre-filled array destroys what the mask would have carried.

**Rule 5 — pin all three together.** Now a **three-point trend**, not an inference:

| Transition | What changed in `_remove_z_mask` |
|-----------|----------------------------------|
| 1.3.2 → 1.3.3 | dropped `type: ignore[no-untyped-call]` on `np.ma.is_masked` / `getmask` |
| 1.3.3 → 1.4.0 | dropped them on `np.ma.asarray` / `masked_invalid`; last one became `[return-value]` |

The *logic* never changed — only type suppressions, each time numpy annotated another
`np.ma` function. contourpy's source tracks numpy's annotation state. Install the
hash-enforced pin with:
```bash
pip install --require-hashes -r requirements-all-platforms.txt
```

**Rule 6 — masking is not imputation.** `np.mean(m)` on 6 valid of 8 cells returns
`2.6666666667`: mean of the *valid* subset, denominator 6, not 8. If you need denominator
8 you want `filled(0)` — a different question. Report `m.count()` with any masked reduction.

**Rule 7 — `.pyx` means you cannot read it.** 8 of csgraph's 10 modules are Cython. From a
wheel you get docstrings and `.pyi` only. To read implementations, fetch the tagged source
— which is how the versions above were pinned.

**Rule 8 — check the ceiling, not the "latest".** numpy 2.5.x, scipy 1.18.x and contourpy
1.4.0 all declare `Requires-Python >=3.12`. On Python 3.11 the installable ceiling is numpy
2.4.6 / scipy 1.17.1 / contourpy 1.3.3, so the contourpy pin is **already current**. Python
3.11 is the binding constraint now, not the package versions.

## 5. Unverified Register

| Item | Status | What would close it |
|------|--------|---------------------|
| Why two contourpy versions were uploaded | **NOT VERIFIED** | Original absolute paths of the uploads (now deleted with the container) |
| Original uploads themselves | **GONE** — reconstructed and hash-verified | n/a; the recorded digests prove the reconstruction |
| 117 of 201 digests | **PyPI-reported only** | `python3 verify_digests.py --all` |
| Non-CPython / non-PyPI sources (conda, distro, Alpine) | **NOT COVERED** | These pins are PyPI + CPython only |
| numpy/scipy upper bounds of the *original* ranges | **PARTIAL** | Exact pins are verified; the range claims were not exhaustive |
| Python 3.12 move | **NOT ATTEMPTED** | Separate change order; unlocks contourpy 1.4.0 |
