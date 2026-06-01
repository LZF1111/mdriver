// 一键封装脚本：esbuild 把 server.js + 所有 node_modules 打成一个 CJS bundle，
// 再用 javascript-obfuscator 混淆。产物 = dist/sealed/server.bundle.js（外人无法读源码）。
//
// 使用：
//   npm i -D esbuild javascript-obfuscator
//   node build-sealed.mjs
//
// 产物结构：
//   dist/sealed/
//     server.bundle.js   ← 单文件、混淆、压缩；外人完全看不到 server.js / FOAM_PROMPT 等
//     public/            ← 前端原样（HTML/CSS/前端 JS 本来就是浏览器可见的）
//     doc_reader.py      ← 必须明文（运行时由 python 调用）
//     start.sh           ← 启动脚本
//     start.bat          ← Windows 启动脚本
//     README.md          ← 用户说明
//   dist/sealed.tar.gz   ← 一键打包

import { build } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'dist', 'sealed');
const BUNDLE = path.join(OUT, 'server.bundle.mjs');

async function rmrf(p) { try { await fs.rm(p, { recursive: true, force: true }); } catch {} }
async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  for (const ent of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

console.log('[1/4] 清理旧产物 ...');
await rmrf(OUT);
await fs.mkdir(OUT, { recursive: true });

console.log('[2/4] esbuild 打包 server.js（ESM → 单 CJS 文件，所有依赖内联）...');
await build({
  entryPoints: [path.join(__dirname, 'server.js')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: BUNDLE,
  minify: true,
  legalComments: 'none',
  external: [],
  // 关键：把所有 # 私有字段/方法降级成 WeakMap shim，避免 javascript-obfuscator
  // 的 controlFlowFlattening / deadCodeInjection 破坏 class 结构后产生
  // “Unexpected identifier '#e'” 的语法错误。
  supported: {
    'class-private-field': false,
    'class-private-method': false,
    'class-private-static-field': false,
    'class-private-static-method': false,
    'class-private-brand-check': false,
    'class-private-accessor': false,
  },
  banner: { js: '#!/usr/bin/env node\n/* Mdriver — sealed bundle  (c) LZF */\nimport { createRequire as _createRequire } from "node:module";\nconst require = _createRequire(import.meta.url);' },
  define: { 'process.env.NODE_ENV': '"production"' },
}).then(() => console.log('    bundle 完成: ' + (fsSync.statSync(BUNDLE).size/1024/1024).toFixed(2) + ' MB'));

console.log('[3/4] javascript-obfuscator 混淆（字符串数组+RC4+控制流扁平化）...');
const src = await fs.readFile(BUNDLE, 'utf8');
// 第一行是 shebang，需要先剥离再混淆，最后拼回
const shebang = src.startsWith('#!') ? src.split('\n')[0] + '\n' : '';
const body = shebang ? src.slice(shebang.length) : src;
const obf = JavaScriptObfuscator.obfuscate(body, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.6,   // 过高会拖慢 Express/WS 热路径
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 0.75,
  splitStrings: true,
  splitStringsChunkLength: 8,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,                  // 关键：bundle 里有 node 全局/require，不能改
  selfDefending: true,
  // 避免破坏 Express/路由：保留正则与运行时 reflection
  unicodeEscapeSequence: false,
  // 跳过对超大正则/模板字符串的处理
  reservedStrings: [],
  target: 'node',
}).getObfuscatedCode();
await fs.writeFile(BUNDLE, shebang + obf, 'utf8');
console.log('    混淆完成: ' + (fsSync.statSync(BUNDLE).size/1024/1024).toFixed(2) + ' MB');

console.log('[4/4] 拷贝运行时资源 ...');
// 前端
if (fsSync.existsSync(path.join(__dirname, 'public'))) {
  await copyDir(path.join(__dirname, 'public'), path.join(OUT, 'public'));
}
// Python 辅助脚本（必须明文，python 解释器要读）
  for (const f of ['doc_reader.py', 'nb_kernel_host.py', 'opt_driver.py', 'mesh_stl_check.py']) {
  if (fsSync.existsSync(path.join(__dirname, f))) {
    await fs.copyFile(path.join(__dirname, f), path.join(OUT, f));
  }
}
// 启动脚本
await fs.writeFile(path.join(OUT, 'start.sh'), `#!/usr/bin/env bash
cd "$(dirname "$0")"
exec node server.bundle.mjs "$@"
`, 'utf8');
await fs.writeFile(path.join(OUT, 'start.bat'), `@echo off
cd /d "%~dp0"
node server.bundle.mjs %*
`, 'utf8');
try { execSync(`chmod +x "${path.join(OUT, 'start.sh')}"`); } catch {}

// README
await fs.writeFile(path.join(OUT, 'README.md'), `# Mdriver

> CFD AI Agent — by LZF

## 运行

\`\`\`bash
# Linux / macOS
./start.sh

# Windows
start.bat
\`\`\`

需要本机已安装：
- Node.js >= 18
- Python 3.9+（用于 doc_reader.py / Notebook 内核）
- 可选：ParaView 5.x（pvpython 用于离屏渲染）
- 可选：OpenFOAM v2206+（Beta 仿真模式）

默认地址：http://127.0.0.1:5175

## 配置

首次启动后到 ⚙ 面板填写：
- LLM Provider + API Key（保存在本地 settings.json）
- ParaView 路径（可选）
- OpenFOAM root + bashrc（可选）

## 文件构成

- server.bundle.mjs ← 主程序（已混淆封装，源码不可见）
- public/           ← 前端
- doc_reader.py     ← PDF/DOCX 读取（明文，依赖 PyMuPDF）
- start.sh / .bat   ← 启动脚本
`, 'utf8');

// 打 tar.gz
const tar = path.join(__dirname, 'dist', 'mdriver-linux.tar.gz');
try {
  execSync(`tar -czf "${tar}" -C "${path.join(__dirname, 'dist')}" sealed`, { stdio: 'inherit' });
  console.log('\n✓ 完成: ' + tar + '  (' + (fsSync.statSync(tar).size/1024/1024).toFixed(2) + ' MB)');
} catch (e) {
  console.log('\n✓ 完成: 产物目录 = ' + OUT + '  （未找到 tar，可手动压缩此目录）');
}
console.log('\n外人拿到 server.bundle.mjs 后：');
console.log('  - 直接打开 = 长达数 MB 的乱码字符串数组 + RC4 解密器 + 控制流跳转');
console.log('  - strings 也挖不出 Mdriver 内部 prompt 等明文（已被 RC4 加密）');
console.log('  - 仍可运行，但反编译还原源码需要专业逆向工程师 + 数十小时');
