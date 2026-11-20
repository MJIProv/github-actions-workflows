"""
The single contract that unifies the three uploaded __init__.py files:
how a numeric array declares "there is no value here".

  LAYER 1  numpy.ma               DEFINES the contract   (data + boolean mask)
  LAYER 2  scipy.sparse.csgraph   CONSUMES it to tell "0-weight edge" from "no edge"
  LAYER 3  contourpy              CONSUMES it to exclude invalid grid cells

Run:  python3 masked_contract_demo.py

Do NOT add -I unless you mean it. `python3 -I` isolates the interpreter and excludes
user site-packages (~/.local/lib/...). This script needs nothing from there, so -I
works -- but the same flag makes matplotlib look broken when one of its dependencies
(e.g. python-dateutil) lives in user site. That exact false alarm happened while
building this repo.
"""
import numpy as np
from scipy.sparse.csgraph import (
    csgraph_from_dense, csgraph_from_masked, csgraph_to_masked, shortest_path,
)
import contourpy


def nverts(lines_out):
    """Total vertices across all line groups, for any LineType."""
    if lines_out is None:
        return 0
    return sum(len(np.asarray(a)) for a in lines_out if a is not None)


import scipy
print(f"numpy {np.__version__} | scipy {scipy.__version__} | contourpy {contourpy.__version__}")
print("=" * 70)

# ------------------------------------------------------------------ LAYER 1
print("\nLAYER 1  numpy.ma - define absence once\n" + "-" * 70)
x = np.array([2, 1, 3, np.nan, 5, 2, 3, np.nan])
m = np.ma.masked_array(x, np.isnan(x))
print(f"  np.mean(x) = {np.mean(x)}         <- NaN poisons the whole reduction")
print(f"  np.mean(m) = {np.mean(m):.10f}   <- mask EXCLUDES; it does not impute")
print(f"  mask       = {m.mask.astype(int)}")
print(f"  count      = {m.count()}/{m.size} cells participate")

# ------------------------------------------------------------------ LAYER 2
print("\nLAYER 2  scipy.sparse.csgraph - '0' means two different things\n" + "-" * 70)
INF = np.inf
#  0 --0-- 1 --0-- 2 --5-- 3    (two GENUINE zero-weight edges)
dense = np.array([[INF,   0, INF, INF],
                  [  0, INF,   0, INF],
                  [INF,   0, INF,   5],
                  [INF, INF,   5, INF]])
cases = (
    ("null_value=0    WRONG", csgraph_from_dense(dense, null_value=0)),
    ("null_value=inf  RIGHT", csgraph_from_dense(dense, null_value=INF)),
    ("from_masked     RIGHT", csgraph_from_masked(np.ma.masked_invalid(dense))),
)
for label, g in cases:
    print(f"  {label}   edges={g.nnz:2d}   shortest_path 0->3 = {shortest_path(g, directed=False)[0, 3]}")
right = cases[1][1]
print(f"\n  explicit zeros survive in .data : {np.sort(right.data)}")
print(f"  csgraph_to_masked round-trip    : {int(csgraph_to_masked(right).mask.sum())}/16 cells masked as non-edges")
print("  Collapsing 0 -> 'no edge' silently disconnected the graph. No exception raised.")

# ------------------------------------------------------------------ LAYER 3
print("\nLAYER 3  contourpy - the mask selects which cells are contoured\n" + "-" * 70)
y, xx = np.mgrid[0:5, 0:5]
z = (xx + y).astype(float)
z[2, 2] = np.nan
print("  5x5 ramp, 1 NaN at [2,2] -> masked automatically (np.ma.masked_invalid)")
for cm in (False, True):
    cg = contourpy.contour_generator(z=z, name="serial", corner_mask=cm)
    print(f"  corner_mask={str(cm):5}  vertices at z=4.0: {nverts(cg.lines(4.0))}"
          f"   ({'entire quad discarded' if not cm else 'only the masked triangle discarded'})")
print("  corner_mask=True recovers geometry that corner_mask=False throws away.")

# ------------------------------------------------------------------ CHAIN
print("\nEND-TO-END  one mask, three consumers\n" + "-" * 70)
rng = np.random.default_rng(7)
field = rng.random((12, 12)) * 10
field[3:6, 3:6] = np.nan
mfield = np.ma.masked_invalid(field)
graph = csgraph_from_masked(np.ma.masked_greater(mfield, 8))
cg = contourpy.contour_generator(z=mfield)
print(f"  L1  masked cells          : {int(mfield.mask.sum())}/144")
print(f"  L2  graph edges retained  : {graph.nnz}")
print(f"  L3  contour vertices @5.0 : {nverts(cg.lines(5.0))}")
print("\n  The mask was authored once and consumed three times.")
print("  No layer re-invented a sentinel value. That is the whole point.")
