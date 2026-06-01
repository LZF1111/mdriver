#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""lmp_post_rdf.py — 从 LAMMPS custom dump 算径向分布函数 g(r)

策略：只用最后 N 帧的平均；O(N_atoms²) 朴素实现，≤ 10k 原子可用。
用法:
  python lmp_post_rdf.py <dump> [--rmax 10] [--bins 200] [--types 1 1] [--last-frames 5] [--out rdf.png]
"""
import sys, os, json, traceback, argparse, math
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

def parse_dump(path):
    frames = []
    with open(path, 'r', encoding='utf-8', errors='ignore') as f:
        line = f.readline()
        while line:
            if line.startswith('ITEM: TIMESTEP'):
                step = int(f.readline())
                f.readline(); n = int(f.readline())
                f.readline()
                box = []
                for _ in range(3):
                    p = f.readline().split()
                    box.append((float(p[0]), float(p[1])))
                header = f.readline().split()
                cols = header[2:]
                atoms = []
                for _ in range(n):
                    atoms.append(f.readline().split())
                frames.append({'step': step, 'box': box, 'cols': cols, 'atoms': atoms})
            line = f.readline()
    return frames

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dump')
    ap.add_argument('--rmax', type=float, default=None, help='默认 min(Lx,Ly,Lz)/2')
    ap.add_argument('--bins', type=int, default=200)
    ap.add_argument('--types', nargs=2, type=int, default=None, help='--types A B  仅 A-B 对')
    ap.add_argument('--last-frames', type=int, default=5)
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    try:
        frames = parse_dump(args.dump)
        if not frames:
            return print(json.dumps({'ok': False, 'error': 'dump 解析为 0 帧'}, ensure_ascii=False))
        cols = frames[0]['cols']
        def ci(n): 
            try: return cols.index(n)
            except: return -1
        i_id = ci('id'); i_tp = ci('type')
        i_x, i_y, i_z = ci('x'), ci('y'), ci('z')
        if min(i_x, i_y, i_z) < 0:
            i_x, i_y, i_z = ci('xu'), ci('yu'), ci('zu')
        if min(i_x, i_y, i_z) < 0:
            return print(json.dumps({'ok': False, 'error': f'dump 无 x/y/z (cols={cols})'}, ensure_ascii=False))

        # 选最后 N 帧
        sel = frames[-args.last_frames:] if len(frames) >= args.last_frames else frames
        # box（用第一帧的尺寸）
        box = sel[0]['box']
        Lx = box[0][1] - box[0][0]; Ly = box[1][1] - box[1][0]; Lz = box[2][1] - box[2][0]
        V = Lx * Ly * Lz
        rmax = args.rmax if args.rmax else 0.5 * min(Lx, Ly, Lz)
        dr = rmax / args.bins
        hist = [0] * args.bins
        n_atoms_total = 0
        N_pairs_a = 0; N_pairs_b = 0
        ta, tb = (args.types if args.types else (None, None))
        for fr in sel:
            xs = []; ys = []; zs = []; tps = []
            for a in fr['atoms']:
                xs.append(float(a[i_x])); ys.append(float(a[i_y])); zs.append(float(a[i_z]))
                tps.append(int(a[i_tp]))
            n = len(xs); n_atoms_total += n
            # 朴素 O(n²) ;  对 n>5000 太慢，但教学/中型够用
            if ta is not None:
                idx_a = [i for i in range(n) if tps[i] == ta]
                idx_b = [i for i in range(n) if tps[i] == tb]
            else:
                idx_a = list(range(n)); idx_b = list(range(n))
            for i in idx_a:
                xi, yi, zi = xs[i], ys[i], zs[i]; ti = tps[i]
                for j in idx_b:
                    if ta is None and j <= i: continue
                    if ta is not None and i == j: continue
                    dx = xs[j] - xi; dy = ys[j] - yi; dz = zs[j] - zi
                    # 最小镜像
                    if   dx >  Lx * 0.5: dx -= Lx
                    elif dx < -Lx * 0.5: dx += Lx
                    if   dy >  Ly * 0.5: dy -= Ly
                    elif dy < -Ly * 0.5: dy += Ly
                    if   dz >  Lz * 0.5: dz -= Lz
                    elif dz < -Lz * 0.5: dz += Lz
                    r = math.sqrt(dx * dx + dy * dy + dz * dz)
                    if r < rmax and r > 1e-6:
                        b = int(r / dr)
                        if b < args.bins: hist[b] += 1
            if ta is None: N_pairs_a += n * (n - 1) // 2
        n_frames = len(sel)
        # 归一化 g(r)
        # g(r) = hist(r) / (rho * 4π r² dr * N_a * n_frames)  （AA 同类对）
        # 双类对 A-B：g(r) = hist / (N_a * rho_b * 4π r² dr * n_frames)
        rho = (n_atoms_total / n_frames) / V
        gr = [0.0] * args.bins
        r_centers = [0.0] * args.bins
        for k in range(args.bins):
            r = (k + 0.5) * dr
            shell = 4.0 * math.pi * r * r * dr
            r_centers[k] = r
            if ta is None:
                # 同类对：每帧 N(N-1)/2 对；归一时 *2 是因为我们只数了 j>i
                norm = rho * shell * 0.5 * (n_atoms_total / n_frames) * n_frames
            else:
                # A-B 异类
                norm = rho * shell * (n_atoms_total / n_frames) * n_frames
            gr[k] = (hist[k] / norm) if norm > 0 else 0.0

        # 找第一峰
        peak_idx = max(range(args.bins), key=lambda k: gr[k])
        peak = {'r': r_centers[peak_idx], 'g': gr[peak_idx]}
        result = {'ok': True, 'n_frames_used': n_frames, 'box': [Lx, Ly, Lz], 'rho_avg': rho,
                  'rmax': rmax, 'bins': args.bins, 'types_pair': args.types,
                  'r': r_centers, 'g_r': gr, 'first_peak': peak}
        if args.out:
            try:
                import matplotlib
                matplotlib.use('Agg')
                import matplotlib.pyplot as plt
                fig, ax = plt.subplots(figsize=(6, 4))
                ax.plot(r_centers, gr, '-')
                ax.axhline(1.0, color='gray', alpha=0.3, ls='--')
                ax.set_xlabel('r (Å)'); ax.set_ylabel('g(r)')
                ttl = 'RDF' + (f'  (types {ta}-{tb})' if ta else '  (all-all)')
                ttl += f"  first peak r={peak['r']:.2f} Å, g={peak['g']:.2f}"
                ax.set_title(ttl); ax.grid(alpha=0.3)
                fig.tight_layout(); fig.savefig(args.out, dpi=120); plt.close(fig)
                result['plot'] = args.out
            except Exception as e:
                result['plot_error'] = str(e)
        # 序列化时把 r/g_r 抽稀避免 token 爆
        if len(r_centers) > 80:
            step = max(1, len(r_centers) // 80)
            result['r']   = r_centers[::step]
            result['g_r'] = gr[::step]
            result['_sampled_for_json'] = True
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e), 'tb': traceback.format_exc()}, ensure_ascii=False))

if __name__ == '__main__':
    main()
