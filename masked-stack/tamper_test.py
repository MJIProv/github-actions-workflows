#!/usr/bin/env python3
"""Two-sided test that --require-hashes enforcement is real AND discriminating.

CONTROL  : the package's full, correct hash block  -> pip MUST succeed
TAMPERED : same block, every hash's last char flipped -> pip MUST fail

A one-sided test is worthless: feeding a single wrong hash fails for the trivial
reason that it is not the hash of the wheel pip selects for this platform. Only
the paired control/tamper result proves the check discriminates. (This repo
shipped that broken one-sided test once.)
"""
import re, subprocess, sys, tempfile, pathlib

REQ = pathlib.Path(__file__).with_name("requirements-all-platforms.txt")
PKG = "contourpy"


def block(text, pkg):
    m = re.search(rf"^{re.escape(pkg)}==(\S+)(.*?)(?=\n\n|\Z)", text, re.S | re.M)
    if not m:
        sys.exit(f"could not locate the {pkg} block in {REQ.name}")
    return m.group(1), re.findall(r"--hash=sha256:([0-9a-f]{64})", m.group(2))


def write(path, ver, digests):
    lines = [f"{PKG}=={ver} \\"]
    for i, d in enumerate(digests):
        lines.append(f"    --hash=sha256:{d}" + (" \\" if i < len(digests) - 1 else ""))
    path.write_text("\n".join(lines) + "\n")


def run(req, out):
    return subprocess.run(
        [sys.executable, "-m", "pip", "download", "--no-deps", "--require-hashes",
         "--no-cache-dir", "-d", str(out), "-r", str(req)],
        capture_output=True, text=True).returncode


def main():
    ver, digests = block(REQ.read_text(), PKG)
    if not digests:
        sys.exit("no digests parsed")
    flipped = [d[:-1] + ("b" if d[-1] == "a" else "a") for d in digests]
    rc = 0
    with tempfile.TemporaryDirectory() as td:
        td = pathlib.Path(td)
        write(td / "control.txt", ver, digests)
        write(td / "tamper.txt", ver, flipped)
        c = run(td / "control.txt", td / "c")
        t = run(td / "tamper.txt", td / "t")
        print(f"  {PKG}=={ver}, {len(digests)} digests in the block")
        if c == 0:
            print("  PASS  CONTROL  correct hash block accepted")
        else:
            print(f"  FAIL  CONTROL  correct block REJECTED (exit {c}) -> the pin is broken")
            rc = 1
        if t != 0:
            print("  PASS  TAMPERED all-digits-flipped block rejected")
        else:
            print("  FAIL  TAMPERED flipped block ACCEPTED -> enforcement is dead")
            rc = 1
        if rc == 0:
            print("  -> test discriminates: accepts truth, rejects tampering")
    return rc


if __name__ == "__main__":
    sys.exit(main())
