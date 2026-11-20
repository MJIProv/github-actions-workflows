#!/usr/bin/env bash
# Re-verify the whole pin from scratch. Exits non-zero on any integrity failure.
#   ./verify.sh
set -uo pipefail
cd "$(dirname "$0")"
PY=${PYTHON:-python3}
fail=0
step(){ printf '\n\033[1m%s\033[0m\n%s\n' "$1" "----------------------------------------------------------------"; }
ok(){   printf '  PASS  %s\n' "$1"; }
bad(){  printf '  FAIL  %s\n' "$1"; fail=1; }

step "1. Hash pin actually downloads and validates"
tmp=$(mktemp -d)
if $PY -m pip download --no-deps --require-hashes -d "$tmp" \
      -r requirements-all-platforms.txt >/dev/null 2>&1; then
  n=$(ls "$tmp" | wc -l)
  d=$(grep -c 'hash=sha256' requirements-all-platforms.txt)
  ok "hash-enforced download OK: $n artifact(s) selected for THIS platform"
  echo "        ($d digests declared across all platforms; pip validates only"
  echo "         the ones it selects here -- expected, not partial coverage)"
else
  bad "hash-enforced download failed"
fi
rm -rf "$tmp"

step "2. Hash enforcement is real AND discriminating (two-sided)"
if $PY tamper_test.py; then :; else bad "tamper test did not discriminate"; fi

step "3. Canonical files byte-match the installed packages"
$PY - <<'PYEOF' || fail=1
import hashlib, sys
import numpy.ma, scipy.sparse.csgraph, contourpy
h = lambda p: hashlib.sha256(open(p, "rb").read()).hexdigest()
pairs = [("canonical/numpy/ma/__init__.py",            numpy.ma.__file__,             "numpy.ma"),
         ("canonical/scipy/sparse/csgraph/__init__.py", scipy.sparse.csgraph.__file__, "scipy.sparse.csgraph"),
         ("canonical/contourpy/__init__.py",            contourpy.__file__,            "contourpy")]
rc = 0
for c, i, n in pairs:
    if h(c) == h(i): print(f"  PASS  {n} byte-identical")
    else:            print(f"  FAIL  {n} MISMATCH"); rc = 1
sys.exit(rc)
PYEOF

step "4. Installed versions equal the pins declared in requirements.txt"
# Pins are READ from requirements.txt, never hardcoded here. Hardcoding them meant
# every pin bump silently desynchronised this check from the actual pin.
$PY - <<'PYEOF' || fail=1
import importlib, re, sys
from pathlib import Path
want = {}
for line in Path("requirements.txt").read_text().splitlines():
    line = line.split("#", 1)[0].strip()
    m = re.fullmatch(r"([A-Za-z0-9._-]+)==([^\s;]+)", line)
    if m: want[m.group(1).lower()] = m.group(2)
if not want:
    print("  FAIL  no pins parsed from requirements.txt"); sys.exit(1)
rc = 0
for pkg, ver in want.items():
    try:
        got = importlib.import_module(pkg).__version__
    except Exception as e:
        print(f"  FAIL  {pkg} not importable ({type(e).__name__})"); rc = 1; continue
    if got == ver: print(f"  PASS  {pkg} == {ver}")
    else:          print(f"  FAIL  {pkg} is {got}, requirements.txt says {ver}"); rc = 1
sys.exit(rc)
PYEOF

step "5. Behavioural demo"
if $PY masked_contract_demo.py >/dev/null 2>&1; then ok "masked_contract_demo.py ran clean"
else bad "demo failed"; fi

step "6. pyproject.toml builds (regression guard)"
# Build in a throwaway FULL COPY of the tree. Two requirements fight here:
#   - `pip install .` writes *.egg-info into the source tree, so build elsewhere;
#   - the bug guarded is setuptools auto-discovery seeing canonical/ and superseded/
#     as rival top-level packages, so those dirs MUST be present or the test passes
#     vacuously. (It did, for one revision, after a "cleanup".)
bt=$(mktemp -d)
tar cf - --exclude='*.egg-info' --exclude='__pycache__' --exclude='*.pyc' . \
  | (cd "$bt" && tar xf -)
if $PY -m pip install --no-deps --dry-run "$bt" >/dev/null 2>&1; then
  ok "pip install . resolves (built in a scratch copy; source tree untouched)"
else
  bad "pip install . FAILED -- without [tool.setuptools] py-modules=[],"
  bad "  setuptools treats canonical/ and superseded/ as rival top-level packages"
fi
rm -rf "$bt"

printf '\n================================================================\n'
[ "$fail" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "INTEGRITY FAILURE - see FAIL lines above"
exit "$fail"
