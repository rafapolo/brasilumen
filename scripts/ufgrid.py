#!/usr/bin/env python3
"""Build data/ufgrid.json: a coarse grid saying which state each patch of ground
belongs to, so the map can tell which state is under the centre of the screen.

State bounding boxes overlap (SP, MG, RJ, PR...) and there are no polygons here,
so each cell takes the state with the most points inside it, counted from the
extractor's raw files (RAW2, see repack.py). Cells with no points stay empty and
the page looks for the nearest labelled one. Borders are only as sharp as the
cell, ~22 km at 0.2 degrees.

Output, JSON: x0/y0 origin (west, south), step in degrees, w/h in cells, `ufs`
(codes, in order) and `rle`: row-major runs as [code, length, ...] with code 0 =
empty and code k = ufs[k - 1].

Usage: python3 scripts/ufgrid.py [raw_dir] [out_file]
"""

import gzip
import json
import struct
import sys
from pathlib import Path

import numpy as np

X0, Y0, STEP, W, H = -74.0, -34.0, 0.2, 230, 200


def main():
    here = Path(__file__).resolve().parent.parent
    raw_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else here.parent / "rodado/docs/pesquisa/viz-uf/dados"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else here / "data/ufgrid.json"

    files = sorted(p for p in raw_dir.glob("*.bin.gz") if p.name != "br.bin.gz")
    ufs = [p.name.split(".")[0].upper() for p in files]
    counts = np.zeros((len(ufs), W * H), dtype=np.int64)
    for k, path in enumerate(files):
        raw = gzip.decompress(path.read_bytes())
        if raw[:4] != b"RAW2":
            raise SystemExit(f"{path}: esperava RAW2")
        n = struct.unpack_from("<I", raw, 4)[0]
        lng = np.frombuffer(raw, "<f4", n, 8)
        lat = np.frombuffer(raw, "<f4", n, 8 + 4 * n)
        cx = np.floor((lng - X0) / STEP).astype(np.int64)
        cy = np.floor((lat - Y0) / STEP).astype(np.int64)
        ok = (cx >= 0) & (cx < W) & (cy >= 0) & (cy < H)
        counts[k] = np.bincount(cy[ok] * W + cx[ok], minlength=W * H)

    code = np.where(counts.max(axis=0) > 0, counts.argmax(axis=0) + 1, 0)
    flat = code.tolist()
    rle = []
    run, cur = 0, flat[0]
    for c in flat:
        if c == cur:
            run += 1
        else:
            rle += [cur, run]
            cur, run = c, 1
    rle += [cur, run]

    out.write_text(json.dumps({"x0": X0, "y0": Y0, "step": STEP, "w": W, "h": H, "ufs": ufs, "rle": rle},
                              separators=(",", ":")))
    print(f"{out}: {len(ufs)} UFs, {int((code > 0).sum())} células rotuladas, {out.stat().st_size / 1e3:.1f} KB")


if __name__ == "__main__":
    main()
