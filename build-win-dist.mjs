// 一键产出 Windows 分发包：
//   dist/MDriver-win-x64-sealed/    —— 封装版（server.bundle.mjs 混淆+RC4，源码不可见）
//   dist/MDriver-win-x64-sealed.zip —— 同上压缩包
//
// 用法：
//   npm i -D esbuild javascript-obfuscator
//   node build-win-dist.mjs
//
// 启动：用户解压后双击 start.bat 即可（自动打开浏览器）。
// 注意：用户机器需要装 Node.js >= 18（终端 `node -v` 能输出）。
//      如果想完全免 Node，请额外用 yao-pkg 把 server.bundle.mjs 二次打包为 mdriver.exe（脚本末尾给出可选步骤）。

import { build } from 'esbuild';
import JavaScriptObfuscator from 'javascript-obfuscator';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const OUT = path.join(DIST, 'MDriver-win-x64-sealed');
const BUNDLE = path.join(OUT, 'server.bundle.mjs');

async function rmrf(p) { try { await fs.rm(p, { recursive: true, force: true }); } catch {} }
async function copyDir(src, dst, filter) {
  await fs.mkdir(dst, { recursive: true });
  for (const ent of await fs.readdir(src, { withFileTypes: true })) {
    // 全局过滤：跳过 .git/node_modules 等大目录
    if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === '.DS_Store') continue;
    if (filter && !filter(ent.name, ent.isDirectory())) continue;
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) await copyDir(s, d, filter);
    else await fs.copyFile(s, d);
  }
}

console.log('[1/5] 清理旧产物 ...');
await rmrf(OUT);
await rmrf(OUT + '.zip');
await fs.mkdir(OUT, { recursive: true });

console.log('[2/5] esbuild 打包 server.js（ESM → 单文件，所有依赖内联）...');
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
  supported: {
    'class-private-field': false,
    'class-private-method': false,
    'class-private-static-field': false,
    'class-private-static-method': false,
    'class-private-brand-check': false,
    'class-private-accessor': false,
  },
  banner: { js: '#!/usr/bin/env node\n/* MDriver — sealed bundle */\nimport { createRequire as _createRequire } from "node:module";\nconst require = _createRequire(import.meta.url);' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
console.log('    bundle 完成: ' + (fsSync.statSync(BUNDLE).size/1024/1024).toFixed(2) + ' MB');

console.log('[3/5] javascript-obfuscator 混淆（字符串数组 + RC4 + 控制流扁平化）...');
const src = await fs.readFile(BUNDLE, 'utf8');
const shebang = src.startsWith('#!') ? src.split('\n')[0] + '\n' : '';
const body = shebang ? src.slice(shebang.length) : src;
const obf = JavaScriptObfuscator.obfuscate(body, {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.55,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.2,
  stringArray: true,
  stringArrayEncoding: ['rc4'],
  stringArrayThreshold: 0.75,
  splitStrings: true,
  splitStringsChunkLength: 8,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: true,
  unicodeEscapeSequence: false,
  target: 'node',
}).getObfuscatedCode();
await fs.writeFile(BUNDLE, shebang + obf, 'utf8');
console.log('    混淆完成: ' + (fsSync.statSync(BUNDLE).size/1024/1024).toFixed(2) + ' MB');

console.log('[4/5] 拷贝运行时资源（前端/案例库/Python 脚本）...');
// 前端
if (fsSync.existsSync(path.join(__dirname, 'public'))) {
  await copyDir(path.join(__dirname, 'public'), path.join(OUT, 'public'));
}
// 案例库 (重要！智能体的本地知识)
if (fsSync.existsSync(path.join(__dirname, 'cases'))) {
  await copyDir(path.join(__dirname, 'cases'), path.join(OUT, 'cases'),
    (name, isDir) => !(isDir && (name === '.git' || name === 'node_modules' || name === '__pycache__')));
}
// 可选资源
for (const d of ['potentials', 'templates', 'assets', 'docs']) {
  if (fsSync.existsSync(path.join(__dirname, d))) {
    await copyDir(path.join(__dirname, d), path.join(OUT, d));
  }
}
// Python 辅助脚本（明文，Python 解释器要直接读）
for (const f of ['doc_reader.py', 'nb_kernel_host.py', 'opt_driver.py', 'mesh_stl_check.py', 'img_normalize.py']) {
  if (fsSync.existsSync(path.join(__dirname, f))) {
    await fs.copyFile(path.join(__dirname, f), path.join(OUT, f));
  }
}
// helpers/ 目录（LAMMPS 后处理用：log 解析、轨迹渲染、dump→xyz 转换）
if (fsSync.existsSync(path.join(__dirname, 'helpers'))) {
  await copyDir(path.join(__dirname, 'helpers'), path.join(OUT, 'helpers'));
}
// .env 模板
const envTpl = `# MDriver 配置（可选）。运行时也可以在 /app 右上角 ⚙ 面板里改。
# PORT=3777
# HOST=127.0.0.1
# LAMMPS_BIN=C:\\LAMMPS\\bin\\lmp.exe
# PYTHON=C:\\Python311\\python.exe
`;
await fs.writeFile(path.join(OUT, '.env.example'), envTpl, 'utf8');

// start.bat — 检查 Node、启动、开浏览器
const startBat = `@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

REM ---- 检查 Node ----
where node >nul 2>&1
if errorlevel 1 (
  echo [ERR] 未检测到 Node.js。请先安装 Node.js 18 或更高版本：
  echo       https://nodejs.org/zh-cn/download/prebuilt-installer
  pause
  exit /b 1
)

REM ---- 端口解析 ----
set "PORT=3777"
:parse_args
if "%~1"=="" goto run
if /i "%~1"=="--port" set "PORT=%~2" & shift & shift & goto parse_args
if /i "%~1"=="-p"     set "PORT=%~2" & shift & shift & goto parse_args
if /i "%~1"=="--host" set "HOST=%~2" & shift & shift & goto parse_args
shift
goto parse_args
:run

echo.
echo  MDriver v0.1.0 — AI-driven Molecular Dynamics for LAMMPS
echo  端口: %PORT%
echo  打开: http://127.0.0.1:%PORT%
echo.

REM ---- 启动 3 秒后自动开浏览器 ----
start "" /MIN cmd /c "ping -n 4 127.0.0.1 >nul && start http://127.0.0.1:%PORT%/"

node server.bundle.mjs
endlocal
`;
// cmd.exe 要求 CRLF + UTF-8 BOM（因为 bat 里有中文）
const BOM = '\uFEFF';
const toCRLF = (s) => BOM + s.replace(/\r?\n/g, '\r\n');
await fs.writeFile(path.join(OUT, 'start.bat'), toCRLF(startBat), 'utf8');

// 停止脚本
await fs.writeFile(path.join(OUT, 'stop.bat'), toCRLF(`@echo off
chcp 65001 >nul
echo 正在停止 MDriver ...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3777.*LISTENING"') do taskkill /F /PID %%a >nul 2>&1
echo 完成。
`), 'utf8');

// README
await fs.writeFile(path.join(OUT, 'README.txt'), `MDriver v0.1.0 — Windows x64 (sealed)
AI-driven Molecular Dynamics for LAMMPS

================================================================
启动
================================================================

  双击 start.bat

  默认端口 3777，浏览器会自动打开 http://127.0.0.1:3777

  自定义端口：
    start.bat --port 5180
    start.bat -p 5180

  停止服务：
    双击 stop.bat

================================================================
依赖
================================================================

必需：
  - Node.js 18+              https://nodejs.org/

可选（按需）：
  - LAMMPS (含 ReaxFF)       欢迎页点"一键部署 LAMMPS" → 从 GitHub 下载安装
  - Packmol (建模)           https://m3g.iqm.unicamp.br/packmol/
  - Open Babel (格式转换)    https://openbabel.org/
  - Python 3.9+              用于 PDF/Notebook 读取

================================================================
首次配置
================================================================

启动后，在 /app 右上角 ⚙ 面板填：
  - LLM Provider + API Key（DashScope / OpenAI / GitHub Copilot ...）
  - LAMMPS 可执行路径（若已装，欢迎页一键检测）
  - Python 路径（用于 PDF 读取）

设置写入本目录 settings.json，下次启动自动加载。

================================================================
文件构成
================================================================

  server.bundle.mjs   主程序（已混淆 + RC4 加密字符串，源码不可读）
  public/             前端（HTML/CSS/JS 浏览器原本可见）
  cases/              本地案例库（PE 热解 + 13 个权威源代码索引）
  doc_reader.py       PDF/DOCX 读取（依赖 PyMuPDF）
  nb_kernel_host.py   Jupyter 内核（依赖 jupyter_client）
  start.bat / stop.bat
  .env.example        环境变量模板
  settings.json       首次启动后生成

================================================================
故障排查
================================================================

Q: 双击 start.bat 闪退？
A: 在 cmd 里手动 cd 到目录后运行 start.bat，看错误信息。
   多半是 Node 没装或版本太低。

Q: 端口 3777 被占用？
A: start.bat -p 8080  改用别的端口。

Q: WS 一直 "连接断开重连中"？
A: 看防火墙是否拦截了 127.0.0.1:3777。或换端口。

Q: 智能体说找不到 lmp？
A: 欢迎页点"一键部署 LAMMPS"→ 选 GitHub 下载，或手动填路径。
`, 'utf8');

console.log('[5/5] 压缩成 .zip ...');
// 用 PowerShell Compress-Archive（Windows 自带）
try {
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${OUT}\\*' -DestinationPath '${OUT}.zip' -Force"`, { stdio: 'inherit' });
  console.log('\n✓ 完成: ' + OUT + '.zip  (' + (fsSync.statSync(OUT + '.zip').size/1024/1024).toFixed(2) + ' MB)');
} catch (e) {
  console.log('\n✓ 完成: 产物目录 = ' + OUT);
  console.log('  （Compress-Archive 失败，手动压缩此目录即可）');
}

console.log(`
[i] 该包要求用户机器装 Node 18+。若要生成"完全免 Node"的单 exe：
    npm i -D @yao-pkg/pkg
    npx pkg ${BUNDLE} --targets node18-win-x64 --output dist/MDriver-win-x64-sealed/mdriver.exe
    # 然后改 start.bat 用 mdriver.exe 代替 node server.bundle.mjs
`);
