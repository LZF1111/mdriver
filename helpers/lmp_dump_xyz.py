#!/usr/bin/env python3
"""Mdriver helper: convert a LAMMPS custom dump file to XYZ format (all frames)."""
import argparse, sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dump', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    f = open(args.dump, 'r', errors='replace')
    g = open(args.out, 'w')
    line = f.readline()
    frame = 0
    while line:
        if line.startswith('ITEM: TIMESTEP'):
            ts = f.readline().strip()
            line = f.readline()  # NUMBER OF ATOMS
            n = int(f.readline().strip())
            line = f.readline()  # BOX BOUNDS
            for _ in range(3): f.readline()
            line = f.readline()  # ATOMS line
            cols = line.replace('ITEM: ATOMS', '').split()
            try:
                xi = cols.index('x') if 'x' in cols else cols.index('xs')
                yi = cols.index('y') if 'y' in cols else cols.index('ys')
                zi = cols.index('z') if 'z' in cols else cols.index('zs')
                ti = cols.index('type') if 'type' in cols else None
            except ValueError:
                sys.stderr.write(f'[err] cannot find x/y/z columns in: {cols}\n'); return 1
            g.write(f'{n}\nframe {frame} timestep {ts}\n')
            for _ in range(n):
                parts = f.readline().split()
                t = parts[ti] if ti is not None else '1'
                g.write(f'{t} {parts[xi]} {parts[yi]} {parts[zi]}\n')
            frame += 1
            line = f.readline()
        else:
            line = f.readline()
    f.close(); g.close()
    print(f'wrote {args.out} with {frame} frames')
    return 0


if __name__ == '__main__':
    sys.exit(main())
