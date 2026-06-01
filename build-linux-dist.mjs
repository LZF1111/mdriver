// 一键产出两个 Linux 分发包：
//   1) mdriver-linux-src.tar.gz      —— 含源码版（server.js 明文）
//   2) mdriver-linux-sealed.tar.gz   —— 封装版（server.bundle.mjs 混淆，源码不可见）
//
// 两个包都通过 start.sh 启动，且支持命令行端口选择：
//   ./start.sh                  → 默认 5174
//   ./start.sh --port 5180      → 指定端口
//   ./start.sh -p 5180          → 同上
//   ./start.sh 5180             → 同上（首个数字位置参数）
//   ./start.sh --host 0.0.0.0 --port 5180
//
// 用法：node build-linux-dist.mjs

import { build } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const OUT_SRC = path.join(DIST, 'mdriver-linux-src');
const OUT_SEAL = path.join(DIST, 'mdriver-linux-sealed');

async function rmrf(p) { try { await fs.rm(p, { recursive: true, force: true }); } catch {} }
async function copyDir(src, dst, filter) {
  await fs.mkdir(dst, { recursive: true });
  for (const ent of await fs.readdir(src, { withFileTypes: true })) {
    if (filter && !filter(ent.name, ent.isDirectory())) continue;
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) await copyDir(s, d, filter);
    else await fs.copyFile(s, d);
  }
}

const startSh = `#!/usr/bin/env bash
# mdriver 启动脚本 (by LZF)
# 用法:
#   ./start.sh                          # 默认端口 5174, 监听 0.0.0.0
#   ./start.sh --port 5180              # 指定端口
#   ./start.sh -p 5180                  # 同上
#   ./start.sh 5180                     # 同上 (首个数字)
#   ./start.sh --port 5180 --host 127.0.0.1
#   PORT=5180 ./start.sh                # 也支持环境变量
set -e
cd "$(dirname "$0")"
export NODE_OPTIONS="\${NODE_OPTIONS:---max-old-space-size=4096}"
export HOST="\${HOST:-0.0.0.0}"
__ENTRY__
`;
const startShSrc = startSh.replace('__ENTRY__',
  `[ -d node_modules ] || npm install --omit=dev\nexec node server.js "$@"`);
const startShSeal = startSh.replace('__ENTRY__',
  `exec node server.bundle.mjs "$@"`);

const readmeSrc = `# mdriver (Linux · Source) — by LZF

> CFD AI Agent. 含源码版，便于二次开发。

## 一、安装依赖（首次）

\`\`\`bash
# 需要 Node.js >= 18  (推荐 nvm install 20)
cd mdriver-linux-src
./start.sh           # 首次运行会自动执行 npm install --omit=dev
\`\`\`

## 二、启动 / 指定端口

\`\`\`bash
./start.sh                        # 默认 0.0.0.0:5174
./start.sh --port 5180            # 自定义端口
./start.sh -p 5180                # 缩写
./start.sh 5180                   # 直接给数字
./start.sh --port 5180 --host 127.0.0.1
\`\`\`

## 三、可选系统依赖

- Python 3.9+      （doc_reader.py / Notebook 内核需要；可在 ⚙ 中选解释器）
- ParaView 5.x     （pvpython 离屏渲染；可选）
- OpenFOAM v2206+  （Beta CFD 模式；可选）

## 四、首次配置

打开浏览器访问 \`http://<服务器>:<端口>\`，点击 ⚙ 设置：
- LLM Provider + API Key
- ParaView / OpenFOAM 路径

## 五、文件构成

\`\`\`
mdriver-linux-src/
├── server.js          ← 主程序（含完整源码）
├── doc_reader.py
├── nb_kernel_host.py
├── public/            ← 前端
├── package.json
├── start.sh           ← 启动脚本（支持端口参数）
└── README.md
\`\`\`
`;

const readmeSeal = `# mdriver (Linux · Sealed) — by LZF

> CFD AI Agent. 封装版，源码已混淆封装，外部不可读取。

## 一、安装依赖（首次）

\`\`\`bash
# 仅需 Node.js >= 18 (sealed 版不需要 npm install，所有依赖已内联)
cd mdriver-linux-sealed
\`\`\`

## 二、启动 / 指定端口

\`\`\`bash
./start.sh                        # 默认 0.0.0.0:5174
./start.sh --port 5180            # 自定义端口
./start.sh -p 5180                # 缩写
./start.sh 5180                   # 直接给数字
./start.sh --port 5180 --host 127.0.0.1
\`\`\`

## 三、可选系统依赖

- Python 3.9+      （doc_reader.py / Notebook 内核需要；可在 ⚙ 中选解释器）
- ParaView 5.x     （pvpython 离屏渲染；可选）
- OpenFOAM v2206+  （Beta CFD 模式；可选）

## 四、首次配置

打开浏览器访问 \`http://<服务器>:<端口>\`，点击 ⚙ 设置：
- LLM Provider + API Key
- ParaView / OpenFOAM 路径

## 五、文件构成

\`\`\`
mdriver-linux-sealed/
├── server.bundle.mjs  ← 主程序（已混淆封装，源码不可见）
├── doc_reader.py      ← Python 辅助脚本（必须明文）
├── nb_kernel_host.py  ← 同上
├── public/            ← 前端
├── start.sh           ← 启动脚本（支持端口参数）
└── README.md
\`\`\`
`;

// ====================== Step 1: 含源码版 ======================
console.log('[1/2] 构建含源码版 mdriver-linux-src ...');
await rmrf(OUT_SRC);
await fs.mkdir(OUT_SRC, { recursive: true });

// 拷贝源码 + 前端 + python + package.json
for (const f of ['server.js', 'doc_reader.py', 'nb_kernel_host.py', 'package.json']) {
  if (fsSync.existsSync(path.join(__dirname, f))) {
    await fs.copyFile(path.join(__dirname, f), path.join(OUT_SRC, f));
  }
}
await copyDir(path.join(__dirname, 'public'), path.join(OUT_SRC, 'public'));

// 用一份最小化的 package.json 给 src 包（只保留运行时依赖）
const pkg = JSON.parse(await fs.readFile(path.join(__dirname, 'package.json'), 'utf8'));
const slim = {
  name: pkg.name || 'mdriver',
  displayName: pkg.displayName || 'mdriver',
  version: pkg.version || '0.1.0',
  author: pkg.author || 'LZF',
  description: pkg.description || 'mdriver — CFD AI Agent (by LZF)',
  type: pkg.type || 'module',
  main: 'server.js',
  scripts: { start: 'node server.js' },
  dependencies: pkg.dependencies || {}
};
await fs.writeFile(path.join(OUT_SRC, 'package.json'), JSON.stringify(slim, null, 2), 'utf8');

await fs.writeFile(path.join(OUT_SRC, 'start.sh'), startShSrc, { mode: 0o755 });
await fs.writeFile(path.join(OUT_SRC, 'README.md'), readmeSrc, 'utf8');
console.log('    含源码版完成: ' + OUT_SRC);

// ====================== Step 2: 封装版 ======================
console.log('\n[2/2] 构建封装版 mdriver-linux-sealed ...');
await rmrf(OUT_SEAL);
await fs.mkdir(OUT_SEAL, { recursive: true });

const BUNDLE = path.join(OUT_SEAL, 'server.bundle.mjs');
console.log('   ↳ esbuild bundle ...');
await build({
  entryPoints: [path.join(__dirname, 'server.js')],
  bundle: true,
  platform: 'node',
  // 关键：限制为 es2019，消除 #privateField / ?? / ?. 等可能被某些 Node ESM 解析器卡住的语法
  target: ['node20'],
  format: 'esm',
  outfile: BUNDLE,
  minify: true,
  legalComments: 'none',
  external: [],
  banner: { js: '#!/usr/bin/env node\n/* mdriver — sealed bundle  (c) LZF */\nimport { createRequire as _createRequire } from "node:module";\nconst require = _createRequire(import.meta.url);' },
  define: { 'process.env.NODE_ENV': '"production"' },
  supported: { 'class-private-field': false, 'class-private-method': false, 'class-private-accessor': false },
});
console.log('     bundle: ' + (fsSync.statSync(BUNDLE).size/1024/1024).toFixed(2) + ' MB');

console.log('   ↳ obfuscate (RC4 + 控制流扁平化 + 死代码 + self-defending) ...');
const src = await fs.readFile(BUNDLE, 'utf8');
const shebang = src.startsWith('#!') ? src.split('\n')[0] + '\n' : '';
const body = shebang ? src.slice(shebang.length) : src;
const obf = JavaScriptObfuscator.obfuscate(body, {
  compact: true,
  // 降低强度：避免 selfDefending 注入私有字段 / 控制流扁平化在某些 Node ESM 上引入语法分歧
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.3,
  deadCodeInjection: false,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 0.7,
  splitStrings: true,
  splitStringsChunkLength: 10,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: false,
  unicodeEscapeSequence: false,
  target: 'node',
}).getObfuscatedCode();
await fs.writeFile(BUNDLE, shebang + obf, 'utf8');
console.log('     obfuscated: ' + (fsSync.statSync(BUNDLE).size/1024/1024).toFixed(2) + ' MB');

// 拷贝运行时资源
await copyDir(path.join(__dirname, 'public'), path.join(OUT_SEAL, 'public'));
// 案例库（重要！智能体的本地知识）
if (fsSync.existsSync(path.join(__dirname, 'cases'))) {
  await copyDir(path.join(__dirname, 'cases'), path.join(OUT_SEAL, 'cases'),
    (name, isDir) => !(isDir && (name === '.git' || name === 'node_modules' || name === '__pycache__')));
}
// 可选资源
for (const d of ['potentials', 'templates', 'assets', 'docs']) {
  if (fsSync.existsSync(path.join(__dirname, d))) {
    await copyDir(path.join(__dirname, d), path.join(OUT_SEAL, d));
  }
}
// Python 辅助脚本（明文，Python 解释器要直接读）
for (const f of ['doc_reader.py', 'nb_kernel_host.py', 'opt_driver.py', 'mesh_stl_check.py', 'img_normalize.py']) {
  if (fsSync.existsSync(path.join(__dirname, f))) {
    await fs.copyFile(path.join(__dirname, f), path.join(OUT_SEAL, f));
  }
}
// helpers/ 目录（LAMMPS 后处理用：log 解析、轨迹渲染、dump→xyz 转换）
if (fsSync.existsSync(path.join(__dirname, 'helpers'))) {
  await copyDir(path.join(__dirname, 'helpers'), path.join(OUT_SEAL, 'helpers'));
}
// .env 模板
await fs.writeFile(path.join(OUT_SEAL, '.env.example'), `# MDriver 配置（可选）。运行时也可以在 /app 右上角 ⚙ 面板里改。
# PORT=5174
# HOST=0.0.0.0
# LAMMPS_BIN=/usr/bin/lmp
# PYTHON=/usr/bin/python3
`, 'utf8');
await fs.writeFile(path.join(OUT_SEAL, 'start.sh'), startShSeal, { mode: 0o755 });
await fs.writeFile(path.join(OUT_SEAL, 'README.md'), readmeSeal, 'utf8');
console.log('    封装版完成: ' + OUT_SEAL);

// ====================== Step 3: 打 tar.gz ======================
console.log('\n[3/3] 打 tar.gz ...');
function tarOf(dirAbs, outTar) {
  const parent = path.dirname(dirAbs);
  const name = path.basename(dirAbs);
  try {
    execSync(`tar -czf "${outTar}" -C "${parent}" "${name}"`, { stdio: 'inherit' });
    const sz = fsSync.statSync(outTar).size;
    console.log('  ✓ ' + outTar + '  (' + (sz/1024/1024).toFixed(2) + ' MB)');
  } catch (e) {
    console.log('  ✗ tar 失败，可手动压缩目录: ' + dirAbs);
  }
}
tarOf(OUT_SRC,  path.join(DIST, 'mdriver-linux-src.tar.gz'));
tarOf(OUT_SEAL, path.join(DIST, 'mdriver-linux-sealed.tar.gz'));

console.log('\n========= 完成 =========');
console.log('源码版：    dist/mdriver-linux-src.tar.gz');
console.log('封装版：    dist/mdriver-linux-sealed.tar.gz');
console.log('');
console.log('部署到 Linux 服务器：');
console.log('  scp dist/mdriver-linux-sealed.tar.gz user@server:/opt/');
console.log('  ssh user@server "cd /opt && tar xzf mdriver-linux-sealed.tar.gz && cd mdriver-linux-sealed && ./start.sh --port 5180"');
