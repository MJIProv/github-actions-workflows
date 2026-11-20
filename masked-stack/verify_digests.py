#!/usr/bin/env python3
"""Independently verify pinned digests by DOWNLOADING artifacts and hashing them.

The digests in requirements-all-platforms.txt come from PyPI's JSON API -- that is
PyPI telling you what PyPI thinks the hash is. This fetches the actual bytes and
computes sha256 locally, which is a different claim.

    python3 verify_digests.py              # contourpy in full + cross-platform samples
    python3 verify_digests.py --all        # every artifact (slow, several GB)
    python3 verify_digests.py --pkg numpy  # one package in full

Exits non-zero if any downloaded artifact disagrees with the pin.
"""
from __future__ import annotations
import argparse, hashlib, json, re, ssl, sys, urllib.request
from pathlib import Path

CA = "/root/.ccr/ca-bundle.crt"
REQ = Path(__file__).with_name("requirements-all-platforms.txt")
PINS_FILE = Path(__file__).with_name("requirements.txt")
# contourpy wheels are ~300 KB so all of them are cheap; numpy/scipy wheels are
# 17-35 MB, so sample a NON-native platform to exercise digests never used locally.
SAMPLE_SUBSTR = {"numpy": ["aarch64"], "scipy": ["aarch64"]}


def ctx():
    try:
        return ssl.create_default_context(cafile=CA)
    except OSError:
        return ssl.create_default_context()


def pins():
    out = {}
    for line in PINS_FILE.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        m = re.fullmatch(r"([A-Za-z0-9._-]+)==([^\s;]+)", line)
        if m:
            out[m.group(1).lower()] = m.group(2)
    return out


def artifacts(pkg, ver):
    with urllib.request.urlopen(f"https://pypi.org/pypi/{pkg}/{ver}/json",
                                context=ctx(), timeout=45) as r:
        return json.load(r)["urls"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--pkg")
    a = ap.parse_args()

    pinned = set(re.findall(r"--hash=sha256:([0-9a-f]{64})", REQ.read_text()))
    print(f"pin file declares {len(pinned)} digests\n")

    bad = checked = skipped = 0
    nbytes = 0
    for pkg, ver in pins().items():
        if a.pkg and pkg != a.pkg:
            continue
        files = artifacts(pkg, ver)
        if not (a.all or a.pkg):
            if pkg == "contourpy":
                files = [f for f in files if f["filename"].endswith(".whl")]
            else:
                files = [f for f in files
                         if any(s in f["filename"] for s in SAMPLE_SUBSTR.get(pkg, []))]
        print(f"{pkg}=={ver}: downloading {len(files)} artifact(s)")
        for f in files:
            want = f["digests"]["sha256"]
            if want not in pinned:
                print(f"  SKIP  {f['filename']} (not in pin file)")
                skipped += 1
                continue
            with urllib.request.urlopen(f["url"], context=ctx(), timeout=180) as r:
                blob = r.read()
            got = hashlib.sha256(blob).hexdigest()
            nbytes += len(blob)
            checked += 1
            if got != want:
                print(f"  MISMATCH {f['filename']}\n    pinned {want}\n    actual {got}")
                bad += 1
        print(f"  {len(files)} done")

    print(f"\n{'=' * 64}")
    print(f"independently hashed : {checked} artifact(s), {nbytes / 1e6:.1f} MB")
    print(f"mismatches           : {bad}")
    if skipped:
        print(f"skipped (not pinned) : {skipped}")
    print(f"coverage             : {checked}/{len(pinned)} pinned digests confirmed locally")
    print("VERDICT: all downloaded artifacts match the pin" if bad == 0
          else "VERDICT: PIN IS WRONG OR ARTIFACTS CHANGED")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
