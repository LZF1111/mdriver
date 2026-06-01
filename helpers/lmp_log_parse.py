#!/usr/bin/env python3
"""Mdriver helper: parse LAMMPS log.lammps thermo blocks and plot.

Usage:
    python lmp_log_parse.py --log log.lammps --x Step --y Temp,PotEng --out thermo.png
    python lmp_log_parse.py --log log.lammps --dump-json --out thermo.json
"""
import argparse, json, os, re, sys

def parse_log(path):
    with open(path, 'r', errors='replace') as f:
        lines = f.readlines()
    blocks = []
    cur = None
    for l in lines:
        t = l.strip()
        if re.match(r'^Step\s+', t):
            cur = {'header': t.split(), 'rows': []}
            blocks.append(cur)
            continue
        if cur and t.startswith('Loop time of'):
            cur['loop'] = t
            cur = None
            continue
        if cur:
            parts = t.split()
            if len(parts) == len(cur['header']) and re.match(r'^-?\d', parts[0] or ''):
                try:
                    cur['rows'].append([float(x) for x in parts])
                except ValueError:
                    pass
    return blocks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--log', required=True)
    ap.add_argument('--x', default='Step')
    ap.add_argument('--y', default='Temp')
    ap.add_argument('--out', required=True)
    ap.add_argument('--dump-json', action='store_true')
    args = ap.parse_args()

    blocks = parse_log(args.log)
    if not blocks:
        sys.stderr.write(f'[err] no thermo block found in {args.log}\n')
        return 1
    last = blocks[-1]
    header = last['header']
    rows = last['rows']
    if not rows:
        sys.stderr.write('[err] last block has no rows\n')
        return 1

    if args.dump_json:
        with open(args.out, 'w') as f:
            json.dump({'header': header, 'rows': rows, 'loop': last.get('loop'),
                       'n_blocks': len(blocks)}, f)
        print(f'wrote {args.out}')
        return 0

    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        sys.stderr.write('[err] matplotlib not installed\n')
        return 2

    if args.x not in header:
        sys.stderr.write(f'[err] x column {args.x} not in {header}\n')
        return 1
    xi = header.index(args.x)
    xs = [r[xi] for r in rows]

    ys = [c.strip() for c in args.y.split(',') if c.strip()]
    fig, ax = plt.subplots(len(ys), 1, figsize=(8, 2.4 * len(ys)), sharex=True)
    if len(ys) == 1: ax = [ax]
    for i, col in enumerate(ys):
        if col not in header:
            sys.stderr.write(f'[warn] column {col} not in {header}\n')
            continue
        ci = header.index(col)
        ax[i].plot(xs, [r[ci] for r in rows], '-', lw=1.2)
        ax[i].set_ylabel(col)
        ax[i].grid(True, alpha=0.3)
    ax[-1].set_xlabel(args.x)
    fig.tight_layout()
    fig.savefig(args.out, dpi=120)
    print(f'wrote {args.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
