#!/usr/bin/env python
"""
把任意图片(PNG/JPG/WEBP/BMP/TIFF)规范化成"严格 PIL.verify() 通过"的 JPEG。
用于绕过 SiliconFlow/Kimi-VL 上游的 "Verify image file failed: verify
must be called directly after open" 类错误（PyMuPDF 等渲染出的 PNG 会触发）。

用法:
  python img_normalize.py <in_path> [out_path]
不写 out_path 则在源同目录生成 <stem>_norm.jpg。
长边超过 max_side(默认 1600) 会等比缩放。
"""
import sys, os, io
try:
    from PIL import Image
except Exception as e:
    print('[err] PIL 不可用: ' + str(e), file=sys.stderr); sys.exit(2)

def main():
    if len(sys.argv) < 2:
        print('usage: img_normalize.py <in_path> [out_path]', file=sys.stderr); sys.exit(2)
    inp = sys.argv[1]
    if not os.path.exists(inp):
        print('[err] not found: ' + inp, file=sys.stderr); sys.exit(2)
    if len(sys.argv) >= 3:
        out = sys.argv[2]
    else:
        stem, _ = os.path.splitext(inp)
        out = stem + '_norm.jpg'
    max_side = int(os.environ.get('IMG_MAX_SIDE', '1600'))
    quality  = int(os.environ.get('IMG_JPEG_QUALITY', '88'))
    try:
        im = Image.open(inp)
        im.load()  # 先 load 完整解码，再做后续操作（绕过 verify 时序问题）
        if im.mode != 'RGB':
            # P/RGBA/L/LA/I/F → 一律转 RGB；带 alpha 的用白底贴回
            if im.mode in ('RGBA', 'LA'):
                bg = Image.new('RGB', im.size, (255, 255, 255))
                bg.paste(im, mask=im.split()[-1])
                im = bg
            else:
                im = im.convert('RGB')
        # 等比缩放
        w, h = im.size
        if max(w, h) > max_side:
            r = max_side / max(w, h)
            im = im.resize((int(w * r), int(h * r)), Image.LANCZOS)
        # 用全新的 IO 写出，避免源文件元数据穿过
        buf = io.BytesIO()
        im.save(buf, 'JPEG', quality=quality, optimize=True, progressive=False)
        with open(out, 'wb') as f:
            f.write(buf.getvalue())
        print(out)  # stdout 只输出最终路径
    except Exception as e:
        print('[err] ' + type(e).__name__ + ': ' + str(e), file=sys.stderr); sys.exit(1)

if __name__ == '__main__':
    main()
