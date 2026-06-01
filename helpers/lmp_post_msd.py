#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""lmp_post_msd.py — 从 LAMMPS custom dump 算 MSD + 扩散系数 D

要求 dump 含 id type 以及 unwrapped 坐标 xu yu zu（或带 ix iy iz 用于还原 unwrap）。

用法:
  python lmp_post_msd.py <dump> [--types 1 2] [--out msd.png] [--units metal]
输出 JSON:
  {ok, n_frames, n_atoms, dt_ps_per_frame, msd:[{t_ps, msd_A2, per_type:{...}}],
   D_total_m2s, D_per_type:{...}, fit_window:[i0,i1], note, plot}
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
                f.readline()                              # ITEM: NUMBER OF ATOMS
                n = int(f.readline())
                f.readline()                              # ITEM: BOX BOUNDS ...
                box = []
                for _ in range(3):
                    parts = f.readline().split()
                    box.append((float(parts[0]), float(parts[1])))
                header = f.readline().split()             # ITEM: ATOMS id type ...
                cols = header[2:]
                atoms = []
                for _ in range(n):
                    atoms.append(f.readline().split())
                frames.append({'step': step, 'box': box, 'cols': cols, 'atoms': atoms})
            line = f.readline()
    return frames

def col_index(cols, name):
    try: return cols.index(name)
    except ValueError: return -1

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dump')
    ap.add_argument('--types', nargs='*', type=int, default=None)
    ap.add_argument('--out', default=None)
    ap.add_argument('--units', default='metal', choices=['metal','real','lj','si'])
    ap.add_argument('--dt-ps', type=float, default=None, help='每帧的 ps 数（不指定就只输出 step 单位 MSD）')
    args = ap.parse_args()
    try:
        frames = parse_dump(args.dump)
        if len(frames) < 2:
            return print(json.dumps({'ok': False, 'error': f'dump 帧数={len(frames)} 不够算 MSD（需 ≥ 2 帧）'}, ensure_ascii=False))
        cols = frames[0]['cols']
        i_id = col_index(cols, 'id')
        i_tp = col_index(cols, 'type')
        # 优先 xu yu zu（unwrapped），否则 x+ix*Lx 还原
        i_xu, i_yu, i_zu = col_index(cols, 'xu'), col_index(cols, 'yu'), col_index(cols, 'zu')
        i_x , i_y , i_z  = col_index(cols, 'x'),  col_index(cols, 'y'),  col_index(cols, 'z')
        i_ix, i_iy, i_iz = col_index(cols, 'ix'), col_index(cols, 'iy'), col_index(cols, 'iz')
        unwrap_mode = None
        if i_xu >= 0 and i_yu >= 0 and i_zu >= 0:
            unwrap_mode = 'xu_yu_zu'
        elif i_x >= 0 and i_y >= 0 and i_z >= 0 and i_ix >= 0 and i_iy >= 0 and i_iz >= 0:
            unwrap_mode = 'wrap_plus_image'
        elif i_x >= 0 and i_y >= 0 and i_z >= 0:
            unwrap_mode = 'wrap_only'  # 警告：MSD 会被 PBC 截断错
        else:
            return print(json.dumps({'ok': False, 'error': f'dump 缺坐标列（cols={cols}）；至少需要 x y z'}, ensure_ascii=False))

        def get_xyz(frame, atom):
            box = frame['box']
            Lx = box[0][1] - box[0][0]; Ly = box[1][1] - box[1][0]; Lz = box[2][1] - box[2][0]
            if unwrap_mode == 'xu_yu_zu':
                return float(atom[i_xu]), float(atom[i_yu]), float(atom[i_zu])
            elif unwrap_mode == 'wrap_plus_image':
                return (float(atom[i_x]) + int(atom[i_ix]) * Lx,
                        float(atom[i_y]) + int(atom[i_iy]) * Ly,
                        float(atom[i_z]) + int(atom[i_iz]) * Lz)
            else:
                return float(atom[i_x]), float(atom[i_y]), float(atom[i_z])

        # 按 id 索引，第 0 帧为参考
        # 按 id 把每帧建索引
        per_frame = []
        for fr in frames:
            d = {}
            for a in fr['atoms']:
                d[int(a[i_id])] = a
            per_frame.append({'step': fr['step'], 'box': fr['box'], 'idx': d})
        ref = per_frame[0]
        types_filter = set(args.types) if args.types else None
        # 收集每个 type 的 id 列表
        type_ids = {}
        for aid, a in ref['idx'].items():
            tp = int(a[i_tp])
            if types_filter and tp not in types_filter: continue
            type_ids.setdefault(tp, []).append(aid)
        all_ids = [i for ids in type_ids.values() for i in ids]
        n_atoms = len(all_ids)
        if n_atoms == 0:
            return print(json.dumps({'ok': False, 'error': 'types 过滤后 0 原子'}, ensure_ascii=False))

        # 参考位置
        ref_pos = {aid: get_xyz(ref, ref['idx'][aid]) for aid in all_ids}

        msd_series = []
        for fi, fr in enumerate(per_frame):
            entry = {'frame': fi, 'step': fr['step']}
            if args.dt_ps is not None:
                entry['t_ps'] = fi * args.dt_ps
            # 总体 + 分 type
            tot_sq = 0.0; tot_n = 0
            per_type_sq = {tp: 0.0 for tp in type_ids}
            per_type_n  = {tp: 0   for tp in type_ids}
            for tp, ids in type_ids.items():
                for aid in ids:
                    a = fr['idx'].get(aid)
                    if not a: continue
                    x, y, z = get_xyz(fr, a)
                    rx0, ry0, rz0 = ref_pos[aid]
                    sq = (x - rx0) ** 2 + (y - ry0) ** 2 + (z - rz0) ** 2
                    tot_sq += sq; tot_n += 1
                    per_type_sq[tp] += sq; per_type_n[tp] += 1
            entry['msd_A2'] = tot_sq / tot_n if tot_n else 0.0
            entry['per_type'] = {str(tp): (per_type_sq[tp] / per_type_n[tp] if per_type_n[tp] else 0.0) for tp in type_ids}
            msd_series.append(entry)

        # 线性拟合 D：取后 60% 区间
        i0 = int(len(msd_series) * 0.4); i1 = len(msd_series) - 1
        if i1 - i0 < 2: i0 = 0
        result = {'ok': True, 'unwrap_mode': unwrap_mode, 'n_frames': len(frames), 'n_atoms_tracked': n_atoms,
                  'types_tracked': sorted(type_ids.keys()), 'fit_window': [i0, i1],
                  'msd': msd_series, 'note': ''}
        if unwrap_mode == 'wrap_only':
            result['note'] = '⚠ dump 只有 wrapped 坐标，MSD 会被 PBC 截断错。重跑时 dump custom 加 xu yu zu 列。'

        # 拟合 D = slope / 6（3D，metal: MSD Å²/ps → D Å²/ps → ×1e-8 = m²/s）
        if args.dt_ps is not None and i1 > i0:
            xs = [msd_series[i]['t_ps'] for i in range(i0, i1 + 1)]
            ys = [msd_series[i]['msd_A2'] for i in range(i0, i1 + 1)]
            n = len(xs); sx = sum(xs); sy = sum(ys)
            sxx = sum(x * x for x in xs); sxy = sum(x * y for x, y in zip(xs, ys))
            den = n * sxx - sx * sx
            if den != 0:
                slope = (n * sxy - sx * sy) / den           # Å²/ps
                D_A2_ps = slope / 6.0
                D_m2_s = D_A2_ps * 1e-8                     # Å²=1e-20 m², 1/ps=1e12 → ×1e-8
                result['D_A2_per_ps'] = D_A2_ps
                result['D_m2_per_s'] = D_m2_s
                result['slope_A2_per_ps'] = slope

        # 画图
        if args.out:
            try:
                import matplotlib
                matplotlib.use('Agg')
                import matplotlib.pyplot as plt
                fig, ax = plt.subplots(figsize=(6, 4))
                xs = [m.get('t_ps', m['step']) for m in msd_series]
                ys = [m['msd_A2'] for m in msd_series]
                xlabel = 't (ps)' if args.dt_ps is not None else 'Step'
                ax.plot(xs, ys, 'o-', label='MSD total', ms=3)
                for tp in type_ids:
                    ys_t = [m['per_type'][str(tp)] for m in msd_series]
                    ax.plot(xs, ys_t, '--', label=f'type {tp}', alpha=0.6)
                ax.set_xlabel(xlabel); ax.set_ylabel('MSD (Å²)')
                ax.legend(); ax.grid(alpha=0.3)
                if 'D_m2_per_s' in result:
                    ax.set_title(f"MSD,  D = {result['D_m2_per_s']:.3e} m²/s  (fit slope/6)")
                fig.tight_layout(); fig.savefig(args.out, dpi=120); plt.close(fig)
                result['plot'] = args.out
            except Exception as e:
                result['plot_error'] = str(e)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e), 'tb': traceback.format_exc()}, ensure_ascii=False))

if __name__ == '__main__':
    main()
