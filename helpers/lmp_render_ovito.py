#!/usr/bin/env python3
"""Mdriver helper: render a frame of a LAMMPS dump file.

Priority: OVITO (if ovito python package present) > matplotlib 3D scatter fallback.

Usage:
    python lmp_render_ovito.py --dump dump.lammpstrj --frame -1 \
        --color-by type --view iso --out frame.png
"""
import argparse, os, sys

def try_ovito(args):
    try:
        from ovito.io import import_file
        from ovito.vis import Viewport, TachyonRenderer
    except Exception:
        return False
    pipe = import_file(args.dump)
    n = pipe.source.num_frames
    frame = args.frame if args.frame >= 0 else n + args.frame
    if frame < 0 or frame >= n:
        sys.stderr.write(f'[err] frame {frame} out of [0,{n-1}]\n')
        return False
    pipe.add_to_scene()

    # color by type or property
    if args.color_by:
        try:
            from ovito.modifiers import ColorCodingModifier
            pipe.modifiers.append(ColorCodingModifier(
                property=args.color_by,
                gradient=ColorCodingModifier.Gradient.Viridis))
        except Exception:
            pass

    vp_type_map = {
        'iso':   Viewport.Type.Perspective,
        'top':   Viewport.Type.Top,
        'front': Viewport.Type.Front,
        'side':  Viewport.Type.Right,
    }
    vp = Viewport(type=vp_type_map.get(args.view, Viewport.Type.Perspective))
    vp.zoom_all()
    vp.render_image(filename=args.out, size=(800, 600), frame=frame,
                    renderer=TachyonRenderer())
    print(f'[ovito] wrote {args.out}')
    return True


def fallback_matplotlib(args):
    """Read LAMMPS custom or xyz dump → matplotlib 3D scatter (single frame)."""
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        from mpl_toolkits.mplot3d import Axes3D  # noqa
    except ImportError:
        sys.stderr.write('[err] matplotlib not installed; pip install matplotlib\n')
        return False

    frame_idx = args.frame
    frames = []
    cur = None
    with open(args.dump, 'r', errors='replace') as f:
        first = f.readline()
        f.seek(0)
        is_xyz = first.strip().isdigit()
        if is_xyz:
            while True:
                line = f.readline()
                if not line: break
                try:
                    n = int(line.strip())
                except ValueError:
                    break
                f.readline()  # comment
                atoms = []
                for _ in range(n):
                    parts = f.readline().split()
                    if len(parts) >= 4:
                        atoms.append((parts[0], float(parts[1]), float(parts[2]), float(parts[3])))
                frames.append({'atoms': atoms})
        else:
            # LAMMPS custom dump: parse frame-by-frame
            line = f.readline()
            while line:
                if line.startswith('ITEM: TIMESTEP'):
                    cur = {'atoms': [], 'cols': None}
                    f.readline()  # timestep value
                    line = f.readline()
                    if line.startswith('ITEM: NUMBER OF ATOMS'):
                        n = int(f.readline().strip())
                    else: n = 0
                    line = f.readline()
                    if line.startswith('ITEM: BOX BOUNDS'):
                        for _ in range(3): f.readline()
                    line = f.readline()
                    if line.startswith('ITEM: ATOMS'):
                        cur['cols'] = line.replace('ITEM: ATOMS', '').split()
                    for _ in range(n):
                        parts = f.readline().split()
                        cur['atoms'].append(parts)
                    frames.append(cur)
                    line = f.readline()
                else:
                    line = f.readline()

    if not frames:
        sys.stderr.write('[err] no frames parsed\n')
        return False
    idx = frame_idx if frame_idx >= 0 else len(frames) + frame_idx
    if idx < 0 or idx >= len(frames):
        sys.stderr.write(f'[err] frame {idx} out of [0,{len(frames)-1}]\n')
        return False
    fr = frames[idx]
    xs, ys, zs, cs = [], [], [], []
    if 'cols' in fr and fr['cols']:
        cols = fr['cols']
        xi = next((i for i, c in enumerate(cols) if c in ('x', 'xs', 'xu')), None)
        yi = next((i for i, c in enumerate(cols) if c in ('y', 'ys', 'yu')), None)
        zi = next((i for i, c in enumerate(cols) if c in ('z', 'zs', 'zu')), None)
        ti = next((i for i, c in enumerate(cols) if c == 'type'), None)
        for p in fr['atoms']:
            if xi is None or len(p) <= max(xi, yi, zi): continue
            xs.append(float(p[xi])); ys.append(float(p[yi])); zs.append(float(p[zi]))
            cs.append(int(p[ti]) if ti is not None else 1)
    else:
        for a in fr['atoms']:
            xs.append(a[1]); ys.append(a[2]); zs.append(a[3])
            try: cs.append(int(a[0]))
            except (ValueError, TypeError): cs.append(1)

    fig = plt.figure(figsize=(8, 7))
    ax = fig.add_subplot(111, projection='3d')
    ax.scatter(xs, ys, zs, c=cs, s=4, cmap='viridis')
    ax.set_xlabel('x'); ax.set_ylabel('y'); ax.set_zlabel('z')
    ax.set_title(f'{os.path.basename(args.dump)} frame {idx}/{len(frames)-1}  N={len(xs)}')
    if args.view == 'top':   ax.view_init(elev=90, azim=-90)
    elif args.view == 'front': ax.view_init(elev=0, azim=-90)
    elif args.view == 'side':  ax.view_init(elev=0, azim=0)
    else: ax.view_init(elev=30, azim=45)
    fig.tight_layout()
    fig.savefig(args.out, dpi=120)
    print(f'[matplotlib] wrote {args.out}')
    return True


def parse_lammps_data(path):
    """Parse a LAMMPS data file → single frame {'atoms': [(type,x,y,z),...]} for初始构型可视化."""
    with open(path, 'r', errors='replace') as f:
        lines = f.readlines()
    # 找 Atoms 段
    start = None
    style_hint = ''
    for i, ln in enumerate(lines):
        s = ln.strip()
        if s.startswith('Atoms'):
            start = i
            # "Atoms # charge" 之类的注释提示列格式
            if '#' in s:
                style_hint = s.split('#', 1)[1].strip().lower()
            break
    if start is None:
        return None
    atoms = []
    for ln in lines[start + 1:]:
        s = ln.strip()
        if not s:
            if atoms:
                break  # 段结束
            continue
        # 下一段开头（字母开头的段名）→ 停
        if s[0].isalpha():
            break
        parts = s.split()
        if len(parts) < 5:
            continue
        # 列格式按 atom_style 猜：
        #   atomic   id type x y z              → type=1, xyz=2,3,4
        #   charge   id type q x y z            → type=1, xyz=3,4,5
        #   full     id mol type q x y z        → type=2, xyz=4,5,6
        #   molecular id mol type x y z         → type=2, xyz=3,4,5
        try:
            if 'full' in style_hint:
                t, x, y, z = int(parts[2]), float(parts[4]), float(parts[5]), float(parts[6])
            elif 'molecular' in style_hint:
                t, x, y, z = int(parts[2]), float(parts[3]), float(parts[4]), float(parts[5])
            elif 'charge' in style_hint:
                t, x, y, z = int(parts[1]), float(parts[3]), float(parts[4]), float(parts[5])
            elif 'atomic' in style_hint or len(parts) == 5:
                t, x, y, z = int(parts[1]), float(parts[2]), float(parts[3]), float(parts[4])
            elif len(parts) == 6:  # 无注释，6 列 → charge
                t, x, y, z = int(parts[1]), float(parts[3]), float(parts[4]), float(parts[5])
            elif len(parts) >= 7:  # 无注释，7 列 → full
                t, x, y, z = int(parts[2]), float(parts[4]), float(parts[5]), float(parts[6])
            else:
                t, x, y, z = int(parts[1]), float(parts[2]), float(parts[3]), float(parts[4])
        except (ValueError, IndexError):
            continue
        atoms.append((str(t), x, y, z))
    if not atoms:
        return None
    return {'atoms': atoms}


def looks_like_data_file(path):
    try:
        with open(path, 'r', errors='replace') as f:
            head = f.read(4000)
    except Exception:
        return False
    if 'ITEM: TIMESTEP' in head:
        return False
    return ('atoms' in head and ('xlo' in head or 'Atoms' in head))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dump', required=True)
    ap.add_argument('--frame', type=int, default=-1)
    ap.add_argument('--color-by', default=None)
    ap.add_argument('--view', default='iso', choices=['iso', 'top', 'front', 'side'])
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    # 初始构型：传进来的是 LAMMPS data 文件（无 dump）→ 直接渲染单帧（OVITO 原生支持，matplotlib 走 data 解析）
    if looks_like_data_file(args.dump):
        if try_ovito(args):  # OVITO import_file 能直接读 data 文件
            return 0
        try:
            import matplotlib
            matplotlib.use('Agg')
            import matplotlib.pyplot as plt
            from mpl_toolkits.mplot3d import Axes3D  # noqa
        except ImportError:
            sys.stderr.write('[err] matplotlib not installed; pip install matplotlib\n')
            return 1
        fr = parse_lammps_data(args.dump)
        if not fr:
            sys.stderr.write('[err] 无法从 data 文件解析 Atoms 段\n')
            return 1
        xs = [a[1] for a in fr['atoms']]; ys = [a[2] for a in fr['atoms']]; zs = [a[3] for a in fr['atoms']]
        cs = [int(a[0]) for a in fr['atoms']]
        fig = plt.figure(figsize=(8, 7))
        ax = fig.add_subplot(111, projection='3d')
        ax.scatter(xs, ys, zs, c=cs, s=6, cmap='viridis')
        ax.set_xlabel('x'); ax.set_ylabel('y'); ax.set_zlabel('z')
        ax.set_title(f'{os.path.basename(args.dump)} (初始构型)  N={len(xs)}')
        if args.view == 'top':   ax.view_init(elev=90, azim=-90)
        elif args.view == 'front': ax.view_init(elev=0, azim=-90)
        elif args.view == 'side':  ax.view_init(elev=0, azim=0)
        else: ax.view_init(elev=30, azim=45)
        fig.tight_layout()
        fig.savefig(args.out, dpi=120)
        print(f'[matplotlib] wrote {args.out} (data file initial frame)')
        return 0

    if try_ovito(args):
        return 0
    if fallback_matplotlib(args):
        return 0
    return 1


if __name__ == '__main__':
    sys.exit(main())
