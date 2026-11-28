# masked-stack v1.1.0

A verified, hash-pinned numpy/scipy/contourpy set, plus the reasoning for why these three
pin together.

```sh
pip install --require-hashes -r requirements-all-platforms.txt
./verify.sh
```

## Checked into this repository

This directory is the durable copy. It was built in an ephemeral cloud container and
delivered as a one-file archive plus bootstrap; checking it in supersedes that route, so
`install.sh` and `masked-stack-<ver>.tar.gz` are deliberately NOT committed — git is the
distribution mechanism now. The archive instructions below are kept only for recreating a
standalone bundle from this tree.

```sh
pip install --require-hashes -r requirements-all-platforms.txt
./verify.sh
```

## Rebuilding a standalone archive

Nothing here needs this; it exists because the toolkit predates the repo. If you want a
single self-verifying file again — to carry it somewhere with no git — rebuild the archive
from this tree:

```sh
tar czf masked-stack.tar.gz --sort=name --owner=0 --group=0 --numeric-owner \
    --mtime='2026-11-13 00:00:00' --exclude='*.egg-info' --exclude='__pycache__' \
    --exclude='*.pyc' --transform 's,^\./,masked-stack/,' .
sha256sum masked-stack.tar.gz
```

Those flags make the result **byte-reproducible**: same tree in, same digest out, so a
second person can rebuild and compare. Hand the digest over out of band (it cannot live
inside the archive it describes — it would never match) and have the recipient check it
before extracting.

The original bootstrap script is deliberately **not** committed: it hard-coded one
archive's digest, which goes stale the moment anything here changes. `git` does that job
now, and `verify.sh` is the integrity check.

## The pin

| Package | Version | Why it is here |
|---------|---------|----------------|
| `numpy` | 2.3.4 | **Defines** the missing-data contract: `MaskedArray` = data + boolean mask |
| `scipy` | 1.16.1 | **Consumes** it — `csgraph_from_masked` tells "0-weight edge" from "no edge" |
| `contourpy` | 1.3.3 | **Consumes** it — `_remove_z_mask` + `corner_mask` exclude invalid cells |

Pinned as a **set**. Evidence, not caution: contourpy removes `# type: ignore` comments
from `_remove_z_mask` each time numpy annotates another `np.ma` function it calls — at
1.3.3 (`is_masked`, `getmask`) and again at 1.4.0 (`asarray`, `masked_invalid`). The logic
never changes; only the suppressions. Bumping one alone relocates the skew.

`contourpy 1.3.3` is **already the newest release installable on Python 3.11** — 1.4.0
declares `Requires-Python >=3.12`. Same for numpy 2.5.x and scipy 1.18.x. See
`CHANGE-ORDER.md` for the current upgrade ceiling.

`matplotlib` declares only floors (`contourpy>=1.0.1`, `numpy>=1.25`) with no ceiling, so
it accepts this pin unchanged — verified with matplotlib 3.11.2 contouring a `MaskedArray`.

## Files

| File | Purpose |
|------|---------|
| `requirements.txt` | **The single pin source.** `verify.sh` and `gen_hashes.py` read it |
| `constraints.txt` | Same pins for `pip install -c` |
| `requirements-all-platforms.txt` | 201 hashes — every wheel, cp311–cp314 + pp311, all OS/arch, + sdists |
| `pyproject.toml` | Installable form of the pin |
| `gen_hashes.py` | Regenerate the hash file from `requirements.txt` after a bump |
| `verify.sh` | 6 checks; exits non-zero on any failure |
| `tamper_test.py` | Two-sided proof that `--require-hashes` discriminates |
| `verify_digests.py` | Downloads artifacts and hashes them locally — independent of PyPI's JSON |
| `masked_contract_demo.py` | Runnable evidence for every claim in `CONSOLIDATED.md` |
| `canonical/` | The three deduped `__init__.py` files under real import paths |
| `superseded/` | contourpy 1.3.0–1.3.2's `__init__.py`, kept for rollback |
| `CONSOLIDATED.md` | Full analysis, 8 usage rules, unverified register |
| `MANIFEST.md` | Dedupe and pin decisions, with every defect found along the way |
| `CHANGE-ORDER.md` | Proposed (not applied) pin bump, with verified impact analysis |

## Bumping a version

1. Edit `requirements.txt` — **all three together**. Mirror into `constraints.txt` and
   `pyproject.toml`.
2. `python3 gen_hashes.py`
3. Re-fetch the `canonical/` files at the new tags.
4. `./verify.sh` — must print `ALL CHECKS PASSED`.

Do not hand-edit `requirements-all-platforms.txt`. `verify.sh` needs no edit: it reads the
pins from `requirements.txt`.

## Four traps this repo exists to document

**`--dry-run` silently skips hash validation.** `pip install --require-hashes --dry-run` on
an already-satisfied environment reports success without checking a single digest. Only
`pip download --require-hashes`, or a real install into a clean environment, validates.

**A one-sided tamper test proves nothing.** Feeding one wrong hash always fails — not
because tampering was detected, but because that digest is not the wheel pip selects for
the current platform. `tamper_test.py` runs a **control** (correct full block, must be
accepted) alongside the tampered case (must be rejected). Both outcomes are required.

**setuptools auto-discovery breaks a flat repo.** With `canonical/` and `superseded/`
present, `pip install .` dies with *"Multiple top-level packages discovered in a
flat-layout"*. There is no importable package here, so `pyproject.toml` sets
`[tool.setuptools] py-modules = []`. `verify.sh` step 6 guards it — and the guard builds a
**full** copy of the tree, because a scratch dir holding only `pyproject.toml` makes that
test pass vacuously.

**"Latest on PyPI" is not "latest for your Python."** A version check that ignores
`Requires-Python` reports contourpy 1.4.0 as available when it cannot be installed on
Python 3.11 at all.
