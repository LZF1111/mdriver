// ============================================================================
//  lammps.js — MDriver LAMMPS Intelligence Module
//  ----------------------------------------------------------------------------
//  16 个工具：让 LLM 能在 LAMMPS 安装包 / 工作区里"看懂—找到—复用—跑—收—评"。
//  设计哲学（沿用 CFDriver 的 FOAM-Beta 经验）：
//    1. 「读」类工具便宜、可并行、不审批 → find/doc/inspect/parse
//    2. 「写/跑」类工具需审批 → clone/build/run
//    3. 所有长任务异步 (run_async/status/stop)，主对话不被阻塞
//    4. 错误诊断内置 LAMMPS 常见 17 条 pattern，配合 diagnose 路径输出建议
//    5. 后处理优先调 OVITO Python 脚本接口（无 OVITO 时降级 matplotlib 3D）
//  ----------------------------------------------------------------------------
//  公开 API：
//    - LAMMPS_TOOLS:    ChatCompletion tools 数组
//    - LAMMPS_TOOL_NAMES: Set<string>
//    - LAMMPS_NEEDS_APPROVAL: Set<string>
//    - execLammpsTool(name, args, ctx): 工具分发
//  ctx 由 server.js 注入：{ WORKSPACE, runPython, runShell, postJob, getJob, jobs }
// ============================================================================

import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import os from 'os';

// ---- helpers/ 目录解析（dev 和 dist 都能用）----
// dist 下 process.cwd() 是用户启动目录而不是安装目录，会找不到 helpers/。
// 用 import.meta.url 解析本模块所在目录的 helpers/ 才稳。
const _MODULE_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
function resolveHelper(name) {
  const candidates = [
    path.join(_MODULE_DIR, 'helpers', name),
    path.join(process.cwd(), 'helpers', name),
    path.join(_MODULE_DIR, '..', 'helpers', name),
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return null;
}

// ---------- 安装包自动发现 ----------
// MDriver 自带 cases/lammps-official/ 作为"反幻觉背板"：
// 即使用户没装 LAMMPS 源码也能查 examples / doc/src / src/ 头文件 / potentials。
// 解析顺序：环境变量 > 已安装 LAMMPS 源码 > MDriver 自带 bundle。
function findBundledLammps() {
  // server.js 启动后 cwd 通常是 MDriver 根目录；同时尝试本文件目录上溯。
  const tries = [
    path.resolve(process.cwd(), 'cases', 'lammps-official'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'cases', 'lammps-official'),
  ];
  for (const t of tries) {
    try {
      if (fs.existsSync(path.join(t, 'examples')) || fs.existsSync(path.join(t, 'potentials'))) {
        return t;
      }
    } catch { /* ignore */ }
  }
  return null;
}
const BUNDLED_LAMMPS_ROOT = findBundledLammps();

const LAMMPS_CANDIDATES = [
  process.env.LAMMPS_ROOT,
  process.env.LAMMPS_HOME,
  'C:/lammps',
  'C:/Program Files/LAMMPS',
  '/opt/lammps',
  '/usr/local/lammps',
  path.join(os.homedir(), 'lammps'),
  path.join(os.homedir(), 'src', 'lammps'),
  BUNDLED_LAMMPS_ROOT,  // 最后兜底：MDriver 自带 bundle（必定可用）
].filter(Boolean);

function detectLammpsRoot() {
  for (const c of LAMMPS_CANDIDATES) {
    try {
      const stat = fs.statSync(c);
      if (stat.isDirectory()) {
        // 必须至少包含 src/ 或 examples/ 才算
        if (fs.existsSync(path.join(c, 'src')) || fs.existsSync(path.join(c, 'examples'))) {
          return c;
        }
      }
    } catch { /* ignore */ }
  }
  return null;
}

let LAMMPS_ROOT = detectLammpsRoot();
// 导出给 server.js 用：构建 system prompt 时告诉 LLM 背板根目录
export { BUNDLED_LAMMPS_ROOT };

// —— 动态解析 LAMMPS 可执行：优先级 ctx.lammpsBin > env.LAMMPS_BIN > PATH(where/which) > 默认名 ——
// 之前是 const，模块加载时定死成 'lmp.exe'，无法读取用户在 UI 里保存的 SETTINGS.lammpsBin，
// 导致用户安装 LAMMPS 到非 PATH 目录后智能体永远找不到。
let _LMP_CACHE = { ctxBin: '', resolved: '' };
function _whichSync(cmd) {
  try {
    const isWin = process.platform === 'win32';
    const tool = isWin ? 'where' : 'which';
    const out = execFileSync(tool, [cmd], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString();
    const first = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (first && (isWin ? /\.(exe|bat|cmd)$/i.test(first) : true)) return first;
  } catch { /* ignore */ }
  return null;
}
function resolveLammpsBin(ctx) {
  const ctxBin = (ctx && ctx.lammpsBin) ? String(ctx.lammpsBin).trim() : '';
  if (ctxBin) {
    try { if (fs.existsSync(ctxBin)) { _LMP_CACHE = { ctxBin, resolved: ctxBin }; return ctxBin; } } catch { /* ignore */ }
  }
  if (_LMP_CACHE.resolved && _LMP_CACHE.ctxBin === ctxBin) return _LMP_CACHE.resolved;
  if (process.env.LAMMPS_BIN) {
    const e = process.env.LAMMPS_BIN.trim();
    if (e) { _LMP_CACHE = { ctxBin, resolved: e }; return e; }
  }
  const candidates = process.platform === 'win32'
    ? ['lmp.exe', 'lmp_mpi.exe', 'lmp_serial.exe', 'lammps.exe', 'lmp']
    : ['lmp', 'lmp_serial', 'lmp_mpi', 'lammps'];
  for (const c of candidates) {
    const p = _whichSync(c);
    if (p) { _LMP_CACHE = { ctxBin, resolved: p }; return p; }
  }
  // PATH 找不到时，扫描各平台常见安装目录（很多 Windows 安装器不写 PATH，导致 where 落空）。
  const scanned = _scanInstalledLammpsBin();
  if (scanned) { _LMP_CACHE = { ctxBin, resolved: scanned }; return scanned; }
  // 没找到：返回兜底名但**不缓存**，这样用户稍后装好 LAMMPS 再调用时会重新检测。
  return process.platform === 'win32' ? 'lmp.exe' : 'lmp_serial';
}

// 扫描常见安装目录里的 LAMMPS 可执行（PATH 没配也能找到）。返回首个存在的绝对路径或 null。
function _scanInstalledLammpsBin() {
  const isWin = process.platform === 'win32';
  const exeNames = isWin ? ['lmp.exe', 'lmp_serial.exe', 'lmp_mpi.exe', 'lammps.exe'] : ['lmp', 'lmp_serial', 'lmp_mpi', 'lammps'];
  // 1) 固定常见目录（含 bin/ 子目录）
  const baseDirs = [];
  if (isWin) {
    const pf = process.env['ProgramFiles'] || 'C:/Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
    const la = process.env['LOCALAPPDATA'] || '';
    for (const root of [pf, pf86, 'C:/', la].filter(Boolean)) {
      // 枚举 root 下名字含 "LAMMPS" 的目录
      try {
        for (const d of fs.readdirSync(root, { withFileTypes: true })) {
          if (d.isDirectory() && /lammps/i.test(d.name)) {
            baseDirs.push(path.join(root, d.name), path.join(root, d.name, 'bin'));
          }
        }
      } catch { /* ignore */ }
    }
  } else {
    for (const d of ['/opt/lammps', '/usr/local/lammps', '/usr/local', '/usr']) {
      baseDirs.push(d, path.join(d, 'bin'));
    }
    try { baseDirs.push(path.join(os.homedir(), 'lammps'), path.join(os.homedir(), 'lammps', 'build')); } catch {}
  }
  // 2) env 指定的根
  for (const r of [process.env.LAMMPS_ROOT, process.env.LAMMPS_HOME].filter(Boolean)) {
    baseDirs.push(r, path.join(r, 'bin'), path.join(r, 'src'), path.join(r, 'build'));
  }
  for (const dir of baseDirs) {
    for (const exe of exeNames) {
      const full = path.join(dir, exe);
      try { if (fs.existsSync(full) && fs.statSync(full).isFile()) return full; } catch { /* ignore */ }
    }
  }
  return null;
}
const LAMMPS_BIN = process.env.LAMMPS_BIN
  || (process.platform === 'win32' ? 'lmp.exe' : 'lmp_serial');

// ---------- 工具列表（schema） ----------
export const LAMMPS_TOOLS = [
  { type: 'function', function: { name: 'lmp_env_info', description: '【LAMMPS】列出当前 LAMMPS 安装根目录、可执行文件、版本号、可用 packages 与 examples 数量。开局或换机器后先调一次。', parameters: { type: 'object', properties: {} } } },

  { type: 'function', function: { name: 'lmp_find_example', description: '【LAMMPS】在 LAMMPS 安装包的 examples/（含 in.* 的所有子目录）中按关键字搜索算例。query 可写 keyword（如 melt / friction / polymer / nemd）。返回候选路径列表及简短摘要。', parameters: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'number', description: '默认 10' } }, required: ['query'] } } },

  { type: 'function', function: { name: 'lmp_find_source', description: '【LAMMPS】在 LAMMPS src/ 与 src/*/ 子包中按风格名/命令名搜索源码（.cpp/.h）。kind=pair/bond/fix/compute/dump/all。常用于："这种 fix/pair/compute 在哪儿实现的？" "有没有现成的 XX style？"', parameters: { type: 'object', properties: { query: { type: 'string', description: '风格名或关键字（如 lj/cut, eam, langevin, nve, msd, custom）' }, kind: { type: 'string', enum: ['pair','bond','angle','fix','compute','dump','all'] }, top_k: { type: 'number' } }, required: ['query'] } } },

  { type: 'function', function: { name: 'lmp_find_potential', description: '【LAMMPS】列出 potentials/ 目录的势函数文件（eam/meam/tersoff/sw/reax 等）。可按元素 / pattern 过滤。返回路径 + 文件大小 + 头部 1-2 行注释（常含元素名）。', parameters: { type: 'object', properties: { pattern: { type: 'string', description: '可选，如 Cu / Si / ReaxFF / Tersoff（大小写不敏感，子串匹配）' }, top_k: { type: 'number' } } } } },

  { type: 'function', function: { name: 'lmp_doc_lookup', description: '【LAMMPS】在 doc/src/*.rst 中按命令名 / 关键字搜索官方文档。返回最相关的 rst 标题段 + 前 80 行 + 文件路径。比 web_search 准。例：query="fix nvt" / query="pair_style eam"。', parameters: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'number' } }, required: ['query'] } } },

  { type: 'function', function: { name: 'lmp_clone_example', description: '【LAMMPS】把安装包 examples/ 下的一个算例完整复制到工作区。tutorial_path 既可绝对，也可相对 examples/（如 melt / FRICTION/lj/in.friction.lj）。需审批。', parameters: { type: 'object', properties: { tutorial_path: { type: 'string' }, dest: { type: 'string', description: '相对工作区的目标目录' } }, required: ['tutorial_path','dest'] } } },

  { type: 'function', function: { name: 'lmp_inspect_case', description: '【LAMMPS】检查工作区的一个 LAMMPS 算例：解析所有 in.* 脚本，提取 units / atom_style / boundary / pair_style / pair_coeff / fix / compute / dump / thermo / timestep / run；列出 data.* 与势函数依赖；递归文件清单。**改算例前必走**。', parameters: { type: 'object', properties: { case_path: { type: 'string' } }, required: ['case_path'] } } },

  { type: 'function', function: { name: 'lmp_validate_input', description: '【LAMMPS】对一个输入脚本做"只读不跑"语法检查：用 lmp -echo screen -in script -screen none，但在脚本前注入 "log none" 并把 run 改成 run 0；捕获 ERROR / WARNING。比真跑快几十倍。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, script: { type: 'string', description: '相对 case_path 的 in.* 脚本名（默认自动找 in.*）' } }, required: ['case_path'] } } },

  { type: 'function', function: { name: 'lmp_run_probe', description: '【LAMMPS】**短跑健康探针**：把 in.* 里的 run N 替换成 run probe_steps（默认 200），同步等待结果（最长 wait_seconds，默认 90s）。返回 thermo 序列 + 实际原子数 + lost atoms / 温度 NaN / 能量突变 / Loop time 等健康判定 + verdict (healthy/lost-atoms/temp-nan/energy-spike/timeout/crashed) + suggested_next。**长跑前推荐先 probe(200) → probe(2000) → 再 run_async(full)**，比 validate_input（run 0）能多发现 90% 的动力学问题。支持 np 多核加速。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, script: { type: 'string', description: '相对 case_path 的 in.* 脚本名（默认自动找 in.*）' }, probe_steps: { type: 'number', description: '探针步数，默认 200。建议梯度：200 → 2000 → 20000 → 长跑' }, wait_seconds: { type: 'number', description: '最大等待秒数，默认 90' }, ensure_minimize: { type: 'boolean', description: '是否在 run 前自动插入 minimize 0 1e-8 1000 10000（消重叠，默认 false；若 in.* 已经有 minimize 不要再开）' }, np: { type: 'number', description: 'MPI 进程数，默认 1（串行）。设 4 则自动走 mpiexec -np 4 -localonly（Windows）或 mpirun -np 4。需系统装 MS-MPI / MPICH / OpenMPI。' } }, required: ['case_path'] } } },

  { type: 'function', function: { name: 'lmp_lint', description: '【LAMMPS·静态检查】**写完 in.* 必跑的零成本检查**（不调 LAMMPS、纯文本/data 解析，毫秒级）。一次性查 12 类常见翻车：units/atom_style/pair_style 三者一致 / pair_coeff 元素列与 data atom types 对齐 / 势文件存在 / read_data 文件存在 / pair_coeff 顺序在 pair_style 之后 / ReaxFF 缺 qeq / NPT 缺 timestep / units 与 timestep 量级对应 / atom_style charge|full 但 data 缺 q 列 / boundary 缺失 等。返回 JSON {ok, errors:[{rule,line,msg,fix}], warnings, summary}。**lmp_run_probe 之前必走**。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, script: { type: 'string', description: '相对 case_path 的 in.* 脚本名（默认自动找）' } }, required: ['case_path'] } } },

  { type: 'function', function: { name: 'lmp_template_search', description: '【LAMMPS·模板库】**写新 in.* 前先调它找模板再改**。MDriver 自带的 5 个金标准 in.* 模板（FCC 金属 EAM NPT / LJ Argon NVE / Si Tersoff / 石墨烯 AIREBO / 二元合金 EAM/alloy），按 tag 与体系类型语义匹配。返回候选 [{id, name, tags, units, atom_style, potential, desc, score}]，再用 lmp_template_get 把全文取出来改差异。**抄模板的翻车率比凭空写低一个数量级**。', parameters: { type: 'object', properties: { query: { type: 'string', description: '体系/势函数/系综关键字，例 "FCC Cu 金属 EAM" / "石墨烯" / "LJ 教学" / "Si 退火"' }, top_k: { type: 'number', description: '默认 3' } }, required: ['query'] } } },

  { type: 'function', function: { name: 'lmp_template_get', description: '【LAMMPS·模板库】取出指定模板的完整 in.* 文本和元数据，配合 lmp_template_search 用。返回 {id, meta, content}。改造时只动差异行，骨架别动。', parameters: { type: 'object', properties: { id: { type: 'string', description: '由 lmp_template_search 返回的 id，如 "fcc_metal_eam_npt"' } }, required: ['id'] } } },

  { type: 'function', function: { name: 'lmp_run_async', description: '【LAMMPS】后台启动 LAMMPS 求解器。返回 runId 供轮询。command 缺省=`${LAMMPS_BIN} -in <auto>`；可写 `mpirun -np 4 lmp_mpi -in in.script -var T 300`。**推荐不写 command 只传 np 参数让工具自己拼**（充分发挥多核）。需审批。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, command: { type: 'string', description: '可选；不写则自动拼 `lmp -in <auto> -log <log_name>`，np>1 时自动加 mpiexec/mpirun 前缀' }, log_name: { type: 'string', description: '默认 log.lammps' }, np: { type: 'number', description: 'MPI 进程数，默认 1。设 4 自动变 `mpiexec -np 4 -localonly lmp ...`（Windows）或 `mpirun -np 4 lmp ...`。' } }, required: ['case_path'] } } },

  { type: 'function', function: { name: 'lmp_post_msd', description: '【LAMMPS·后处理】从 custom dump 算 MSD + 扩散系数 D（纯 Python，不调 LAMMPS）。**dump 需含 xu yu zu 或 x y z ix iy iz**（unwrapped 或可还原）。返回每帧 MSD、后 60% 区间线性拟合 → D (m²/s)。可分 type 输出。自动推 PNG 到聊天。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, dump_file: { type: 'string', description: '相对 case_path 的 dump 文件名（例 dump.lammpstrj）' }, dt_ps: { type: 'number', description: '每帧间隔的 ps。例 如果 timestep=0.001 ps 且 dump 频率=1000 → dt_ps=1.0。不传就不算 D，只出 MSD vs step' }, types: { type: 'array', items: { type: 'number' }, description: '只跟踪这些 atom type，不传则全部' }, save_as: { type: 'string', description: 'PNG 输出名，默认 msd.png' } }, required: ['case_path','dump_file'] } } },

  { type: 'function', function: { name: 'lmp_post_rdf', description: '【LAMMPS·后处理】从 custom dump 算径向分布函数 g(r)（纯 Python，不调 LAMMPS）。取最后 N 帧均化，含最小镜像 PBC。**适用原子数 ≤ 10k**（朵朵 O(N²)）。返回 g(r) 采样点 + 第一峰位置/高度，自动推 PNG。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, dump_file: { type: 'string' }, rmax: { type: 'number', description: '默认 min(Lx,Ly,Lz)/2' }, bins: { type: 'number', description: '默认 200' }, types: { type: 'array', items: { type: 'number' }, description: '两元 [A,B] 只算 A-B 对；不传则全-全' }, last_frames: { type: 'number', description: '默认 5，取最后 N 帧均化' }, save_as: { type: 'string', description: '默认 rdf.png' } }, required: ['case_path','dump_file'] } } },

  { type: 'function', function: { name: 'lmp_dump_convert', description: '【LAMMPS·后处理】把 LAMMPS custom dump（包括 .lammpstrj/.dump/.atom）转成 .xyz，供 NGL / VMD / OVITO 读取。保留全部帧。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, dump_file: { type: 'string' }, out_name: { type: 'string', description: '默认 同名.xyz' } }, required: ['case_path','dump_file'] } } },

  { type: 'function', function: { name: 'lmp_post_all', description: '【LAMMPS·后处理】**一键清点**：扫描 case 文件夹，自动识别 log.* / dump.* / *.lammpstrj / *.out，调用 parse_log + dump_summary + plot_thermo + render_traj，返回一份汇总报告（thermo 曲线、边界、帧数、最末帧渲染图）。**跑完 LAMMPS 后只调这个一个就能看完所有默认后处理**。', parameters: { type: 'object', properties: { case_path: { type: 'string' } }, required: ['case_path'] } } },

  { type: 'function', function: { name: 'lmp_run_status', description: '【LAMMPS】查询后台 LAMMPS 作业状态：是否还在跑、log tail、当前 timestep、最近 thermo 行、CPU%。', parameters: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] } } },

  { type: 'function', function: { name: 'lmp_run_stop', description: '【LAMMPS】中止后台 LAMMPS 作业。', parameters: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] } } },

  { type: 'function', function: { name: 'lmp_run_wait', description: '【LAMMPS】**阻塞等待**一个 lmp_run_async 作业跑完（最多 timeout_sec 秒，默认 600），跑完直接返回最终 verdict(ok/crashed/stopped/still-running) + 末段 thermo + exit_code。**这是"把问题一次跑到完整结束"的关键工具**：提交 lmp_run_async 后调它就能在本轮拿到真实结果，既不用 fire-and-forget 也不用反复轮询。返回 still-running 只表示还没跑完（大体系正常），可再调一次续等，**绝不可因此改 in./换方案/重启**。', parameters: { type: 'object', properties: { run_id: { type: 'string' }, timeout_sec: { type: 'number', description: '最多等多少秒，默认 600；大体系可设更大' } }, required: ['run_id'] } } },

  { type: 'function', function: { name: 'lmp_parse_log', description: '【LAMMPS】解析 log.lammps：提取 thermo 表头/数据 → 结构化 JSON、总 wall time、Loop time、性能 (ns/day、timesteps/s)、Minimization 收敛、终止状态。可指定 columns 只取关心的列。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, log_name: { type: 'string', description: '默认 log.lammps' }, columns: { type: 'array', items: { type: 'string' }, description: '只返回这些列（其他列忽略），减小响应体' }, max_rows: { type: 'number', description: '最多返回多少行（倒数），默认 200' } }, required: ['case_path'] } } },

  { type: 'function', function: { name: 'lmp_dump_summary', description: '【LAMMPS】扫描 case 下所有 dump 文件（custom/atom/xyz/lammpstrj）。返回每个：原子数 N、帧数、box bounds、字段列、文件大小。用于"渲染前先确认 dump 是否成功"。', parameters: { type: 'object', properties: { case_path: { type: 'string' } }, required: ['case_path'] } } },

  { type: 'function', function: { name: 'lmp_plot_thermo', description: '【LAMMPS】用 matplotlib 画 thermo 时间序列图，结果 PNG 推送到聊天。一次可画多个 y 列。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, log_name: { type: 'string' }, x: { type: 'string', description: '横坐标列，默认 Step' }, y: { type: 'array', items: { type: 'string' }, description: '纵坐标列名列表，如 ["Temp","PotEng"]' }, save_as: { type: 'string', description: '相对 case_path 的图片输出名（默认 thermo.png）' } }, required: ['case_path','y'] } } },

  { type: 'function', function: { name: 'lmp_render_traj', description: '【LAMMPS】渲染 dump 轨迹的一帧/动画为 PNG。优先 OVITO Python 脚本（若 ovito_pro/ovito_basic Python 包可用），否则降级用 matplotlib 3D scatter。frame=-1 表示最后一帧。**也可直接传 LAMMPS data 文件（如 data.lammps）来看「初始构型」**（跑之前/没有 dump 时）。结果图推送到聊天。', parameters: { type: 'object', properties: { case_path: { type: 'string' }, dump_file: { type: 'string', description: '相对 case_path 的 dump 文件名；也可填 data 文件名渲染初始构型' }, frame: { type: 'number', description: '帧号，-1 表示最后一帧（默认 -1）；data 文件忽略此项' }, color_by: { type: 'string', description: '上色字段，如 type/c_eng/vx' }, view: { type: 'string', enum: ['iso','top','front','side'], description: '默认 iso' }, save_as: { type: 'string' } }, required: ['case_path','dump_file'] } } },

  { type: 'function', function: { name: 'lmp_build_data_file', description: '【LAMMPS】根据高层描述生成 LAMMPS data 文件（initial coords + box + masses + types）。lattice=fcc/bcc/sc/diamond + a + box[nx,ny,nz]；或 atoms_xyz=[[type,x,y,z],...]。可附带 bond/angle topology（高分子常用）。', parameters: { type: 'object', properties: {
      case_path: { type: 'string' },
      out_name:  { type: 'string', description: '默认 data.generated' },
      units:     { type: 'string', description: 'metal/real/lj 等，仅作 header 注释' },
      atom_style:{ type: 'string', description: '默认 atomic' },
      lattice:   { type: 'object', description: '{ type:"fcc|bcc|sc|diamond", a:number, nx, ny, nz, atom_type:1 }（与 atoms_xyz 二选一）' },
      atoms_xyz: { type: 'array', items: { type: 'array' }, description: '[[type,x,y,z], ...]' },
      box:       { type: 'array', items: { type: 'number' }, description: '[xlo,xhi,ylo,yhi,zlo,zhi]（仅 atoms_xyz 模式必填）' },
      masses:    { type: 'object', description: '{ "1":63.55, "2":58.69 } 类型 -> 质量' }
    }, required: ['case_path'] } } },

  { type: 'function', function: { name: 'lmp_diagnose_error', description: '【LAMMPS】把 LAMMPS log 中的 ERROR/WARNING 文本传入，按内置 17 条 LAMMPS 错误模式匹配，返回 {category, likely_causes, next_steps}。任何 lmp_run_status 看到 ERROR 时下一步必须先调它。', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },

  // ========== ReaxFF MD 工作流（4 个新工具）==========
  { type: 'function', function: { name: 'lmp_unit_convert', description: '【LAMMPS·量纲】**写 in.* 前必跑**：把文献里的数值换算到目标 LAMMPS units 系统（lj/real/metal/si/cgs/electron/micro/nano）。一次可批量换算多个量；自动给出公式与中间步骤、可疑值的告警。也能由 (density,box) 反推粒子数 N，或由 (N,density) 反推 box 尺寸。', parameters: { type: 'object', properties: {
      to_units: { type: 'string', enum: ['lj','real','metal','si','cgs','electron','micro','nano'], description: '目标 LAMMPS units（如 ReaxFF→real, EAM→metal）' },
      items:    { type: 'array', items: { type: 'object' }, description: '[{ name:"T", value:300, unit:"K", kind:"temperature" }, { name:"density", value:0.85, unit:"g/cm^3", kind:"density" }, { name:"box", value:[40,40,40], unit:"A", kind:"length" }, { name:"epsilon", value:0.238, unit:"kcal/mol", kind:"energy" }, { name:"sigma", value:3.405, unit:"A", kind:"length" }, { name:"dt", value:1, unit:"fs", kind:"time" }] ；kind ∈ length/energy/temperature/time/pressure/mass/force/density/number_density/charge' },
      derive:   { type: 'object', description: '可选派生：{ n_from: { density:..., box:[lx,ly,lz], unit_d:"g/cm^3", unit_l:"A", molar_mass:18.02 } } 或 { box_from: { density, n, molar_mass } }' }
    }, required: ['to_units','items'] } } },

  { type: 'function', function: { name: 'lmp_packmol_build', description: '【ReaxFF】调用 Packmol 把若干分子（PDB）填充到指定尺寸盒子里，输出 PDB + 自动转 LAMMPS data 文件。需 packmol 可执行 + obabel（OpenBabel）在 PATH。需审批。', parameters: { type: 'object', properties: {
      case_path: { type: 'string', description: '工作区相对路径，将在此目录写 packmol.inp / .pdb / data.lammps' },
      molecules: { type: 'array', items: { type: 'object' }, description: '[{ file:"PE.pdb", count:50 }, ...]；file 相对 case_path 或绝对路径' },
      box:       { type: 'array', items: { type: 'number' }, description: '[lx,ly,lz] 盒子尺寸（Å）' },
      tolerance: { type: 'number', description: 'Packmol tolerance，默认 2.0' },
      output_pdb:{ type: 'string', description: '输出 PDB 名（默认 packed.pdb）' },
      data_file: { type: 'string', description: '输出 data 文件名（默认 data.lammps）' }
    }, required: ['case_path','molecules','box'] } } },

  { type: 'function', function: { name: 'lmp_ff_select_reaxff', description: '【ReaxFF】扫描背板 potentials/ 里**真实存在**的 ffield.reax* 文件，解析每个文件的元素列表，按对目标元素的覆盖度排序。返回 {note, candidates:[{file,path,elements,covers_all,missing}]}，拿第一个的 path 传给 render/pipeline。', parameters: { type: 'object', properties: { elements: { type: 'array', items: { type: 'string' }, description: '如 ["C","H","O"]' }, top_k: { type: 'number', description: '默认 5' } }, required: ['elements'] } } },

  { type: 'function', function: { name: 'lmp_soft_pushoff', description: '【ReaxFF前置】**软势预平衡消重叠**：对已有 data 文件用 pair_style soft + ramp 前置因子 + fix nve/limit 把重叠原子温和推开，再 minimize，写出 data.relaxed。初始构型能量爆（如 1e8 kcal/mol）/ 力 NaN / lost atoms 时先跑它，然后用 data.relaxed 作 ReaxFF 的 read_data。同步等结果。需审批。', parameters: { type: 'object', properties: {
      case_path:    { type: 'string' },
      data_file:    { type: 'string', description: '输入 data，默认 data.lammps' },
      out_data:     { type: 'string', description: '输出松弛后的 data，默认 data.relaxed' },
      units:        { type: 'string', description: '默认 real' },
      steps:        { type: 'number', description: '软势 run 步数，默认 20000' },
      amax:         { type: 'number', description: 'soft 前置因子峰值，默认 100' },
      rcut:         { type: 'number', description: 'soft 截断（Å），默认 2.5' },
      temp:         { type: 'number', description: '控温，默认 300' },
      timestep:     { type: 'number', description: '默认 1.0 fs' },
      np:           { type: 'number', description: 'MPI 进程数，默认 1' },
      wait_seconds: { type: 'number', description: '最大等待，默认 180' }
    }, required: ['case_path'] } } },

  { type: 'function', function: { name: 'lmp_render_in_template', description: '【ReaxFF】用内置 ReaxFF 模板渲染 in.lammps（init + read_data + reaxff + 预松弛 + ensemble + output + run 模块拼装）。ensemble=nvt/npt/nve；bonds=true 则用 reaxff/bonds dump；reax_variant 按版本切 reax/c|reaxff；pre_relax 默认开（minimize+nve/limit 消重叠）。', parameters: { type: 'object', properties: {
      case_path:   { type: 'string' },
      out_name:    { type: 'string', description: '默认 in.lammps' },
      units:       { type: 'string', description: '默认 real' },
      atom_style:  { type: 'string', description: '默认 charge' },
      boundary:    { type: 'string', description: '默认 "p p p"' },
      data_file:   { type: 'string', description: '默认 data.lammps' },
      ffield_file: { type: 'string', description: '默认 ffield.reax' },
      elements:    { type: 'string', description: '与 pair_coeff 元素顺序对应，如 "C H O"' },
      ensemble:    { type: 'string', enum: ['nvt','npt','nve'], description: '默认 nvt' },
      temp_start:  { type: 'number', description: '默认 300' },
      temp_end:    { type: 'number', description: '默认 300' },
      temp_damp:   { type: 'number', description: '默认 100.0' },
      press_start: { type: 'number', description: 'npt 用，默认 1.0' },
      press_end:   { type: 'number', description: 'npt 用，默认 1.0' },
      press_damp:  { type: 'number', description: 'npt 用，默认 1000.0' },
      timestep:    { type: 'number', description: '默认 0.25 fs' },
      dump_freq:   { type: 'number', description: '默认 1000' },
      thermo_freq: { type: 'number', description: '默认 100' },
      nsteps:      { type: 'number', description: '默认 100000' },
      reax_variant:{ type: 'string', enum: ['auto','reaxff','reax/c'], description: 'ReaxFF 语法：auto 按版本（≤2021→reax/c，≥2022→reaxff），可强制' },
      pre_relax:   { type: 'boolean', description: '脚本内预松弛 minimize+nve/limit（默认 true）' },
      warmup_steps:{ type: 'number', description: '限位 warmup 步数，默认 2000' },
      bonds:       { type: 'boolean', description: '是否输出 reaxff/bonds（默认 true）' }
    }, required: ['case_path','elements'] } } },

  { type: 'function', function: { name: 'lmp_reaxff_pipeline', description: '【ReaxFF】预构型流水线：① packmol 建盒 → ② 扫描真实 ffield 选力场 → ③ 渲染 in.lammps（自动拷贝 ffield 进 case）→ ④ lmp_lint 体检 → ⑤ lmp_run_probe 200 步。**不直接跑完整 run**；healthy 后再 lmp_run_async。需审批。', parameters: { type: 'object', properties: {
      case_path:  { type: 'string', description: '工作区相对路径（不存在会创建）' },
      molecules:  { type: 'array', items: { type: 'object' }, description: '[{ file, count }] 见 lmp_packmol_build' },
      box:        { type: 'array', items: { type: 'number' } },
      elements:   { type: 'array', items: { type: 'string' }, description: '如 ["C","H"]；用于挑 ReaxFF + pair_coeff' },
      temp_start: { type: 'number' },
      temp_end:   { type: 'number' },
      timestep:   { type: 'number', description: 'ReaxFF 默认 0.25 fs' },
      nsteps:     { type: 'number' },
      ensemble:   { type: 'string', enum: ['nvt','npt','nve'] },
      bonds:      { type: 'boolean' },
      reax_variant: { type: 'string', enum: ['auto','reaxff','reax/c'], description: 'ReaxFF 语法，默认 auto 按装的版本选（旧版用 reax/c）' },
      soft_pushoff: { description: "是否跨 soft 势预平衡消重叠：true / false / 'auto'（默认 auto：最近原子距离<1Å 自动跑）" },
      pre_relax:  { type: 'boolean', description: 'ReaxFF 脚本内预松弛（默认 true）' },
      np:         { type: 'number', description: 'MPI 进程数，默认 1（传给探针）' }
    }, required: ['case_path','molecules','box','elements'] } } },
];

export const LAMMPS_TOOL_NAMES = new Set(LAMMPS_TOOLS.map(t => t.function.name));
export const LAMMPS_NEEDS_APPROVAL = new Set(['lmp_clone_example', 'lmp_run_async', 'lmp_build_data_file', 'lmp_packmol_build', 'lmp_reaxff_pipeline', 'lmp_soft_pushoff']);

// ============================================================================
//  ReaxFF 模板（内置，无 YAML 依赖）
// ============================================================================
const REAXFF_TEMPLATES = {
  init: `# 初始化
units           {{units}}
atom_style      {{atom_style}}
dimension       3
boundary        {{boundary}}
`,
  read_data: `# 读取初始构型
read_data       {{data_file}}
`,
  reaxff: `# ReaxFF 反应力场（版本自适应：旧版 reax/c，新版 reaxff）
neighbor        2.0 bin
neigh_modify    delay 0 every 1 check no
pair_style      {{reax_pair}} NULL
pair_coeff      * * {{ffield_file}} {{elements}}
fix             qeq all {{reax_qeq}} 1 0.0 10.0 1e-6 {{reax_qeqtail}}
`,
  prerelax: `# 预松弛：消初始重叠（先最小化，再限位 warmup），防能量爆 / 力 NaN
min_style       cg
minimize        1.0e-4 1.0e-6 1000 10000
reset_timestep  0
velocity        all create {{temp_start}} 4928459 mom yes rot yes dist gaussian
timestep        {{warmup_ts}}
fix             warm all nve/limit 0.1
thermo          {{thermo_freq}}
run             {{warmup_steps}}
unfix           warm
`,
  ensemble_nvt: `# NVT 系综（恒温恒容）
fix             1 all nvt temp {{temp_start}} {{temp_end}} {{temp_damp}}
timestep        {{timestep}}
`,
  ensemble_npt: `# NPT 系综（恒温恒压）
fix             1 all npt temp {{temp_start}} {{temp_end}} {{temp_damp}} iso {{press_start}} {{press_end}} {{press_damp}}
timestep        {{timestep}}
`,
  ensemble_nve: `# NVE 系综（能量守恒）
fix             1 all nve
timestep        {{timestep}}
`,
  output_std: `# 输出
dump            1 all custom {{dump_freq}} dump.atom id type x y z
dump_modify     1 sort id
thermo          {{thermo_freq}}
thermo_style    custom step temp pe ke etotal press density
`,
  output_reaxff: `# 输出（含 ReaxFF 键级 + 分子物种，看裂解/成链）
dump            1 all custom {{dump_freq}} dump.atom id type x y z q
dump_modify     1 sort id
fix             bonds all {{reax_bonds}} {{dump_freq}} bonds.reaxff
fix             species all {{reax_species}} 1 1 {{dump_freq}} species.out
thermo          {{thermo_freq}}
thermo_style    custom step temp pe ke etotal press density
`,
  run: `# 运行模拟
run             {{nsteps}}
`,
};

function renderTpl(tpl, params) {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => params[k] !== undefined ? String(params[k]) : '');
}

// 解析已安装 / 背板 LAMMPS 的版本日期 → { raw, year, ts }，用于按版本切换语法。
// 允许用户在设置里用 ctx.lammpsVersion 固定目标版本（如 "7 Aug 2019" 或 "2019"），
// 这样即便背板是新版，也能生成旧版能跑的指令。
const _BIN_VERSION_CACHE = new Map();
function _lammpsVersionInfo(ctx) {
  let raw = (ctx && ctx.lammpsVersion) ? String(ctx.lammpsVersion) : null;
  if (!raw) {
    try {
      const root = (() => { try { return ensureRoot(); } catch { return null; } })();
      for (const r of [root, BUNDLED_LAMMPS_ROOT].filter(Boolean)) {
        const vh = path.join(r, 'src', 'version.h');
        if (fs.existsSync(vh)) {
          const m = fs.readFileSync(vh, 'utf8').match(/#define\s+LAMMPS_VERSION\s+"([^"]+)"/);
          if (m) { raw = m[1]; break; }
        }
      }
    } catch { /* ignore */ }
  }
  // version.h 没命中（常见：Windows 二进制包不带 src/）→ 直接问 LAMMPS 二进制的 banner。
  // banner 形如 "LAMMPS (2 Aug 2023)"，能可靠区分新旧版本。带模块级缓存避免重复 spawn。
  if (!raw) {
    try {
      const bin = resolveLammpsBin(ctx);
      if (bin && _BIN_VERSION_CACHE.has(bin)) {
        raw = _BIN_VERSION_CACHE.get(bin);
      } else if (bin) {
        let banner = '';
        try { banner = execFileSync(bin, ['-h'], { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch (e) { banner = (e && e.stdout) ? e.stdout.toString() : ''; }
        const bm = banner.match(/LAMMPS\s*\(([^)]+)\)/i) || banner.match(/-\s*(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})/);
        raw = bm ? bm[1].trim() : null;
        _BIN_VERSION_CACHE.set(bin, raw);
      }
    } catch { /* ignore */ }
  }
  if (!raw) return { raw: null, year: null, ts: null };
  const ts = Date.parse(raw);
  let year = null;
  if (!isNaN(ts)) year = new Date(ts).getFullYear();
  else { const ym = raw.match(/(19|20)\d{2}/); if (ym) year = +ym[0]; }
  return { raw, year, ts: isNaN(ts) ? null : ts };
}

// ReaxFF 在 2022 年由 reax/c 改名为 reaxff（qeq/reax→qeq/reaxff，reax/c/bonds→reaxff/bonds）。
// 旧版（≤2021，含 2019）只认 reax/c 系列；reax/c 别名在 2021 仍有效，2022 起被移除。
// variant: 'auto'（按版本）| 'reaxff' | 'reax/c'。
function _reaxSyntax(ctx, override) {
  let variant = override || 'auto';
  if (variant === 'auto') {
    const v = _lammpsVersionInfo(ctx);
    variant = (v.year && v.year <= 2021) ? 'reax/c' : 'reaxff';
  }
  if (variant === 'reax/c' || variant === 'reaxc') {
    return { variant: 'reax/c', pair: 'reax/c', qeq: 'qeq/reax', qeqTail: 'reax/c', bonds: 'reax/c/bonds', species: 'reax/c/species' };
  }
  return { variant: 'reaxff', pair: 'reaxff', qeq: 'qeq/reaxff', qeqTail: 'reaxff', bonds: 'reaxff/bonds', species: 'reaxff/species' };
}

// ============================================================================
//  实现
// ============================================================================
const JOBS = new Map();  // runId -> { proc, case_path, log_path, started, status }

function ensureRoot() {
  if (!LAMMPS_ROOT) LAMMPS_ROOT = detectLammpsRoot();
  if (!LAMMPS_ROOT) {
    throw new Error('未找到 LAMMPS 安装包。请设置环境变量 LAMMPS_ROOT 指向 LAMMPS 源码根目录（含 src/ examples/）。');
  }
  return LAMMPS_ROOT;
}

// MDriver 反幻觉背板：当用户实际安装的 LAMMPS 缺少子目录（如装的是 Win 二进制包没 doc/）时，
// 自动回退到 MDriver 自带 cases/lammps-official/。所有 find_* / doc_lookup 都用这个。
function resolveRefRoot(subdir) {
  const installed = (() => { try { return ensureRoot(); } catch { return null; } })();
  if (installed && fs.existsSync(path.join(installed, subdir))) return installed;
  if (BUNDLED_LAMMPS_ROOT && fs.existsSync(path.join(BUNDLED_LAMMPS_ROOT, subdir))) return BUNDLED_LAMMPS_ROOT;
  return installed || BUNDLED_LAMMPS_ROOT;  // 让下游报清晰错误
}

function abs(ctx, p) {
  if (!p) return ctx.WORKSPACE;
  if (path.isAbsolute(p)) return p;
  return path.join(ctx.WORKSPACE, p);
}

async function walk(dir, opts = {}) {
  const { maxDepth = 8, exts = null, names = null, includeDirs = false, skip = ['.git', 'node_modules', '__pycache__'] } = opts;
  const out = [];
  async function rec(d, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (includeDirs) out.push(p + path.sep);
        await rec(p, depth + 1);
      } else {
        if (exts && !exts.some(x => e.name.toLowerCase().endsWith(x.toLowerCase()))) continue;
        if (names && !names.some(n => e.name === n || e.name.startsWith(n))) continue;
        out.push(p);
      }
    }
  }
  await rec(dir, 0);
  return out;
}

// ---------- lmp_env_info ----------
async function lmpEnvInfo(ctx) {
  const root = (() => { try { return ensureRoot(); } catch { return null; } })();
  const resolvedBin = resolveLammpsBin(ctx);
  let binExists = false;
  try { binExists = fs.existsSync(resolvedBin); } catch { /* ignore */ }
  if (!binExists) { try { binExists = !!_whichSync(path.basename(resolvedBin)); } catch { /* ignore */ } }
  const binIsAbs = path.isAbsolute(resolvedBin);
  const binSource = (ctx && ctx.lammpsBin) ? 'settings(UI)'
    : (process.env.LAMMPS_BIN ? 'env'
    : (binExists ? (binIsAbs ? 'scanned/installed-dir' : 'PATH') : 'default(not found)'));
  const result = {
    LAMMPS_ROOT: root,
    BUNDLED_LAMMPS_ROOT,
    LAMMPS_BIN: resolvedBin,
    LAMMPS_BIN_source: binSource,
    LAMMPS_BIN_exists: binExists,
    src_exists: !!root && fs.existsSync(path.join(root, 'src')),
    examples_exists: !!root && fs.existsSync(path.join(root, 'examples')),
    potentials_exists: !!root && fs.existsSync(path.join(root, 'potentials')),
    doc_exists: !!root && fs.existsSync(path.join(root, 'doc', 'src')),
    bundled_examples: !!BUNDLED_LAMMPS_ROOT && fs.existsSync(path.join(BUNDLED_LAMMPS_ROOT, 'examples')),
    bundled_src: !!BUNDLED_LAMMPS_ROOT && fs.existsSync(path.join(BUNDLED_LAMMPS_ROOT, 'src')),
    bundled_doc: !!BUNDLED_LAMMPS_ROOT && fs.existsSync(path.join(BUNDLED_LAMMPS_ROOT, 'doc', 'src')),
    bundled_potentials: !!BUNDLED_LAMMPS_ROOT && fs.existsSync(path.join(BUNDLED_LAMMPS_ROOT, 'potentials')),
    anti_hallucination_note: 'find_example / find_source / find_potential / doc_lookup 已自动用 MDriver 自带 lammps-official 背板兜底，可直接调用、无需先 deploy。',
  };
  if (!root) {
    result.note = 'LAMMPS \u672a\u5b89\u88c5\uff1a\u8fd0\u884c\u9700 deploy/lammps\uff1b\u4f46\u53cd\u5e7b\u89c9\u67e5\u8be2\u5df2\u53ef\u7528\uff08\u80cc\u677f\uff09\u3002';
  }
  if (!binExists) {
    result.bin_hint = 'Windows 没检测到可执行：① 已装请到 ⚙ 设置里把 LAMMPS 可执行路径直接指到 lmp.exe（如 C:\\Program Files\\LAMMPS 64-bit\\bin\\lmp.exe）；② 或把该 bin 目录加进 PATH 后重开；③ 未装可用 lmp_install / winget install LAMMPS。已自动扫描 Program Files / C:\\ 下含 LAMMPS 的目录仍未命中。';
  }
  // 版本（优先读已安装源码，否则读 bundle）
  try {
    const vCandidates = [root, BUNDLED_LAMMPS_ROOT].filter(Boolean);
    for (const r of vCandidates) {
      const versionH = path.join(r, 'src', 'version.h');
      if (fs.existsSync(versionH)) {
        const v = fs.readFileSync(versionH, 'utf8');
        const m = v.match(/#define\s+LAMMPS_VERSION\s+"([^"]+)"/);
        if (m) { result.version = m[1]; break; }
      }
    }
  } catch { /* ignore */ }
  // 数 examples / packages（用 resolveRefRoot 兜底）
  try {
    const exRoot = resolveRefRoot('examples');
    if (exRoot && fs.existsSync(path.join(exRoot, 'examples'))) {
      const ex = await fs.promises.readdir(path.join(exRoot, 'examples'));
      result.examples_top_count = ex.length;
      result.examples_sample = ex.slice(0, 20);
      result.examples_root_used = exRoot;
    }
    const srcRoot = resolveRefRoot('src');
    if (srcRoot && fs.existsSync(path.join(srcRoot, 'src'))) {
      const dirs = (await fs.promises.readdir(path.join(srcRoot, 'src'), { withFileTypes: true }))
        .filter(d => d.isDirectory() && d.name === d.name.toUpperCase() && d.name.length > 1)
        .map(d => d.name);
      result.packages = dirs;
      result.src_root_used = srcRoot;
    }
  } catch { /* ignore */ }
  return JSON.stringify(result, null, 2);
}

// ---------- lmp_find_example ----------
async function lmpFindExample({ query, top_k = 10 }) {
  const root = resolveRefRoot('examples');
  const exDir = path.join(root || '', 'examples');
  if (!root || !fs.existsSync(exDir)) return `[err] examples/ not found (tried install + MDriver bundle)`;
  const inFiles = await walk(exDir, { exts: ['in.', '.lmp'], maxDepth: 6 });
  // also any file starting with "in." (LAMMPS convention)
  const all = await walk(exDir, { maxDepth: 6 });
  const candidates = all.filter(f => path.basename(f).startsWith('in.'));
  const q = query.toLowerCase();
  const scored = [];
  for (const f of candidates) {
    const rel = path.relative(exDir, f);
    let score = 0;
    if (rel.toLowerCase().includes(q)) score += 10;
    if (path.basename(f).toLowerCase().includes(q)) score += 5;
    // peek content
    try {
      const head = fs.readFileSync(f, 'utf8').slice(0, 4096).toLowerCase();
      if (head.includes(q)) score += 3;
    } catch { /* ignore */ }
    if (score > 0) scored.push({ rel, abs: f, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, top_k);
  const out = top.map(t => {
    let summary = '';
    try {
      const txt = fs.readFileSync(t.abs, 'utf8');
      const firstNonComment = txt.split('\n').find(l => l.trim() && !l.trim().startsWith('#')) || '';
      summary = firstNonComment.slice(0, 80);
    } catch { /* ignore */ }
    return `  - ${t.rel}  ::  ${summary}`;
  }).join('\n');
  return `共找到 ${scored.length} 个候选，前 ${top.length}:\n${out || '  (无)'}\n\n绝对根：${exDir}\n建议下一步：lmp_inspect_case 或 lmp_clone_example`;
}

// ---------- lmp_find_source ----------
async function lmpFindSource({ query, kind = 'all', top_k = 15 }) {
  const root = resolveRefRoot('src');
  const srcDir = path.join(root || '', 'src');
  if (!root || !fs.existsSync(srcDir)) return `[err] src/ not found (install 不带源码且 MDriver bundle 未包含 src/)`;
  const files = await walk(srcDir, { exts: ['.cpp', '.h'], maxDepth: 4 });
  const q = query.toLowerCase();
  const prefixMap = { pair: 'pair_', bond: 'bond_', angle: 'angle_', fix: 'fix_', compute: 'compute_', dump: 'dump_' };
  const prefix = prefixMap[kind];
  const scored = [];
  for (const f of files) {
    const base = path.basename(f).toLowerCase();
    if (prefix && !base.startsWith(prefix)) continue;
    let score = 0;
    if (base.includes(q)) score += 10;
    if (base.replace(/_/g, '/').includes(q)) score += 5;
    if (score > 0) scored.push({ f, score });
  }
  // fallback to content grep if few hits
  if (scored.length < 3) {
    for (const f of files.slice(0, 500)) {
      if (scored.find(s => s.f === f)) continue;
      try {
        const head = fs.readFileSync(f, 'utf8').slice(0, 8192).toLowerCase();
        if (head.includes(q)) scored.push({ f, score: 1 });
      } catch { /* ignore */ }
      if (scored.length >= top_k * 2) break;
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, top_k);
  return `共 ${scored.length} 命中，前 ${top.length}:\n` +
    top.map(t => `  - ${path.relative(root, t.f)}  [${t.score}]`).join('\n') +
    `\n\n提示：用 read_file 查看具体源码，关注 style name 注册（PairStyle/FixStyle/ComputeStyle 宏）。`;
}

// ---------- lmp_find_potential ----------
async function lmpFindPotential({ pattern, top_k = 30 }) {
  const root = resolveRefRoot('potentials');
  const potDir = path.join(root || '', 'potentials');
  if (!root || !fs.existsSync(potDir)) return `[err] potentials/ not found`;
  const files = await fs.promises.readdir(potDir);
  const q = (pattern || '').toLowerCase();
  const out = [];
  for (const f of files) {
    if (q && !f.toLowerCase().includes(q)) continue;
    const fp = path.join(potDir, f);
    let size = 0; let head = '';
    try {
      size = fs.statSync(fp).size;
      head = fs.readFileSync(fp, 'utf8').slice(0, 256).split('\n').slice(0, 2).join(' | ');
    } catch { /* ignore */ }
    out.push({ name: f, size, head });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  const top = out.slice(0, top_k);
  return `共 ${out.length} 个文件${pattern ? `（pattern=${pattern}）` : ''}，前 ${top.length}:\n` +
    top.map(t => `  - ${t.name}  (${(t.size / 1024).toFixed(1)} KB)  ${t.head.slice(0, 100)}`).join('\n');
}

// ---------- lmp_doc_lookup ----------
async function lmpDocLookup({ query, top_k = 5 }) {
  const root = resolveRefRoot(path.join('doc', 'src'));
  const docDir = path.join(root || '', 'doc', 'src');
  if (!root || !fs.existsSync(docDir)) return `[err] doc/src/ not found (install 不带文档且 MDriver bundle 未拉取 doc/src)`;
  const files = await walk(docDir, { exts: ['.rst'], maxDepth: 3 });
  const q = query.toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const f of files) {
    const base = path.basename(f, '.rst').toLowerCase();
    let s = 0;
    if (tokens.every(t => base.includes(t))) s += 20;
    if (base === q || base === q.replace(/\s+/g, '_')) s += 50;
    if (base.includes(tokens[0])) s += 5;
    if (s > 0) scored.push({ f, s });
  }
  // content fallback
  if (scored.length < top_k) {
    for (const f of files) {
      if (scored.find(x => x.f === f)) continue;
      try {
        const txt = fs.readFileSync(f, 'utf8').slice(0, 4096).toLowerCase();
        if (tokens.every(t => txt.includes(t))) scored.push({ f, s: 2 });
      } catch { /* ignore */ }
      if (scored.length >= top_k * 3) break;
    }
  }
  scored.sort((a, b) => b.s - a.s);
  const top = scored.slice(0, top_k);
  let out = `共 ${scored.length} 文档命中，前 ${top.length}:\n`;
  // 控制单次返回体积：每篇取前 40 行而不是 80 行（避免下一轮 LLM 首 token 因上下文过大而卡）
  const HEAD_LINES = parseInt(process.env.LMP_DOC_HEAD_LINES || '40', 10);
  for (const t of top) {
    out += `\n=== ${path.relative(root, t.f)} ===\n`;
    try {
      const lines = fs.readFileSync(t.f, 'utf8').split('\n').slice(0, HEAD_LINES);
      out += lines.join('\n') + '\n';
    } catch { /* ignore */ }
  }
  out += `\n提示：每篇仅返回前 ${HEAD_LINES} 行；如需完整内容用 read_file 打开具体路径。`;
  return out;
}

// ---------- lmp_clone_example ----------
async function lmpCloneExample({ tutorial_path, dest }, ctx) {
  // 优先用自带反幻觉背板的 examples/（即便未装 LAMMPS 也可用）
  const root = resolveRefRoot('examples');
  if (!root) return '[err] 无可用 examples/ 目录（未装 LAMMPS 且自带背板缺失）';
  const exDir = path.join(root, 'examples');
  let src = tutorial_path;
  if (!path.isAbsolute(src)) src = path.join(exDir, src);
  if (!fs.existsSync(src)) return `[err] 源路径不存在：${src}\n  examples 根：${exDir}\n  提示：先用 lmp_find_example query="<topic>" 拿到候选路径再 clone`;
  // 若指向 in.* 文件，clone 其所在目录
  if (fs.statSync(src).isFile()) src = path.dirname(src);
  const target = abs(ctx, dest);
  await fs.promises.mkdir(target, { recursive: true });
  await copyDir(src, target);
  return `已复制 example：\n  源：${src}\n  目标：${path.relative(ctx.WORKSPACE, target)}\n建议下一步：lmp_inspect_case("${path.relative(ctx.WORKSPACE, target)}")`;
}

async function copyDir(src, dst) {
  await fs.promises.mkdir(dst, { recursive: true });
  for (const e of await fs.promises.readdir(src, { withFileTypes: true })) {
    const sp = path.join(src, e.name), dp = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(sp, dp);
    else await fs.promises.copyFile(sp, dp);
  }
}

// ---------- lmp_inspect_case ----------
async function lmpInspectCase({ case_path }, ctx) {
  const cp = abs(ctx, case_path);
  if (!fs.existsSync(cp)) return `[err] case 不存在：${cp}`;
  const all = await walk(cp, { maxDepth: 6 });
  const inScripts = all.filter(f => /(^|[\\\/])in\.[^\\\/]+$/.test(f));
  const dataFiles = all.filter(f => /(^|[\\\/])data\.[^\\\/]+$/.test(f) || path.extname(f) === '.data');
  const dumps = all.filter(f => /dump\./.test(path.basename(f)) || path.extname(f) === '.lammpstrj' || path.extname(f) === '.xyz');
  const logs = all.filter(f => /^log\./.test(path.basename(f)));

  const parsed = {};
  for (const s of inScripts) {
    try {
      const txt = fs.readFileSync(s, 'utf8');
      parsed[path.relative(cp, s)] = parseInputScript(txt);
    } catch (e) { parsed[s] = { error: String(e) }; }
  }

  let out = `# LAMMPS 算例体检：${path.relative(ctx.WORKSPACE, cp)}\n\n`;
  out += `**输入脚本** (${inScripts.length}):\n`;
  for (const [rel, p] of Object.entries(parsed)) {
    out += `\n## ${rel}\n`;
    if (p.error) { out += `  解析失败：${p.error}\n`; continue; }
    if (p.units) out += `  - units: \`${p.units}\`\n`;
    if (p.atom_style) out += `  - atom_style: \`${p.atom_style}\`\n`;
    if (p.boundary) out += `  - boundary: \`${p.boundary}\`\n`;
    if (p.pair_style) out += `  - pair_style: \`${p.pair_style}\`\n`;
    if (p.pair_coeffs?.length) out += `  - pair_coeff 行: ${p.pair_coeffs.length}\n`;
    if (p.fixes?.length) out += `  - fix 共 ${p.fixes.length}: ${p.fixes.slice(0,6).map(f=>f.style).join(', ')}${p.fixes.length>6?'...':''}\n`;
    if (p.computes?.length) out += `  - compute 共 ${p.computes.length}: ${p.computes.slice(0,5).map(c=>c.style).join(', ')}\n`;
    if (p.dumps?.length) out += `  - dump 共 ${p.dumps.length}: ${p.dumps.slice(0,3).map(d=>d.style).join(', ')}\n`;
    if (p.runs?.length) out += `  - run 步数: ${p.runs.join(', ')}\n`;
    if (p.timestep) out += `  - timestep: ${p.timestep}\n`;
    if (p.read_data) out += `  - read_data: ${p.read_data}\n`;
    if (p.includes_potential) out += `  - 使用势函数: ${p.includes_potential}\n`;
  }
  out += `\n**data 文件** (${dataFiles.length}):\n` + (dataFiles.slice(0,10).map(f=>`  - ${path.relative(cp,f)}`).join('\n') || '  (无)') + '\n';
  out += `\n**dump 文件** (${dumps.length}):\n` + (dumps.slice(0,10).map(f=>`  - ${path.relative(cp,f)} (${(fs.statSync(f).size/1024).toFixed(1)} KB)`).join('\n') || '  (无)') + '\n';
  out += `\n**log** (${logs.length}):\n` + (logs.slice(0,5).map(f=>`  - ${path.relative(cp,f)}`).join('\n') || '  (无)') + '\n';
  out += `\n**全部文件清单**: 共 ${all.length} 个\n`;
  return out;
}

function parseInputScript(txt) {
  const out = { fixes: [], computes: [], dumps: [], pair_coeffs: [], runs: [], variables: [] };
  const lines = txt.split('\n');
  for (let raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [cmd, ...args] = line.split(/\s+/);
    switch (cmd) {
      case 'units': out.units = args[0]; break;
      case 'atom_style': out.atom_style = args.join(' '); break;
      case 'boundary': out.boundary = args.join(' '); break;
      case 'pair_style': out.pair_style = args.join(' '); break;
      case 'pair_coeff': out.pair_coeffs.push(args.join(' ')); break;
      case 'fix': out.fixes.push({ id: args[0], group: args[1], style: args[2], rest: args.slice(3).join(' ') }); break;
      case 'compute': out.computes.push({ id: args[0], group: args[1], style: args[2], rest: args.slice(3).join(' ') }); break;
      case 'dump': out.dumps.push({ id: args[0], group: args[1], style: args[2], every: args[3], file: args[4], rest: args.slice(5).join(' ') }); break;
      case 'run': out.runs.push(args[0]); break;
      case 'timestep': out.timestep = args[0]; break;
      case 'read_data': out.read_data = args[0]; break;
      case 'pair_write': case 'velocity': case 'group': /* ignore */ break;
      case 'variable': out.variables.push(args.join(' ')); break;
    }
    if (cmd === 'pair_coeff' && args.some(a => /\.(eam|meam|tersoff|sw|reax|airebo)/i.test(a))) {
      out.includes_potential = args.find(a => /\.(eam|meam|tersoff|sw|reax|airebo)/i.test(a));
    }
  }
  return out;
}

// ---------- lmp_validate_input ----------
async function lmpValidateInput({ case_path, script }, ctx) {
  const cp = abs(ctx, case_path);
  if (!fs.existsSync(cp)) return `[err] case 不存在：${cp}`;
  let scriptPath = script;
  if (!scriptPath) {
    const entries = (await fs.promises.readdir(cp)).filter(f => f.startsWith('in.'));
    if (!entries.length) return `[err] 未找到 in.* 脚本`;
    scriptPath = entries[0];
  }
  const absScript = path.join(cp, scriptPath);
  const txt = fs.readFileSync(absScript, 'utf8');

  // —— 静态交叉检查（在跑 LAMMPS 之前先抓常见错配）——
  const staticIssues = [];
  // 1) atom_style 与 data 文件 Bonds 段是否一致
  const atomStyleMatch = txt.match(/^\s*atom_style\s+(\S+)/m);
  const readDataMatch  = txt.match(/^\s*read_data\s+(\S+)/m);
  if (atomStyleMatch && readDataMatch) {
    const atomStyle = atomStyleMatch[1].toLowerCase();
    const dataFileName = readDataMatch[1];
    const dataAbs = path.isAbsolute(dataFileName) ? dataFileName : path.join(cp, dataFileName);
    const stylesWithBonds = ['full', 'molecular', 'bond', 'angle', 'template', 'hybrid'];
    if (fs.existsSync(dataAbs)) {
      const dataTxt = fs.readFileSync(dataAbs, 'utf8');
      const declaredBonds = parseInt((dataTxt.match(/^\s*(\d+)\s+bonds\s*$/im) || [0, '0'])[1], 10);
      const hasBondsSection = /^\s*Bonds\s*$/im.test(dataTxt);
      const atomStyleNeedsBonds = stylesWithBonds.some(s => atomStyle.startsWith(s));
      if ((declaredBonds > 0 || hasBondsSection) && !atomStyleNeedsBonds) {
        staticIssues.push(`❌ ATOM_STYLE 与 DATA 不匹配：${scriptPath} 写 \`atom_style ${atomStyle}\` 不支持 bonds，但 ${dataFileName} 含 ${declaredBonds} bonds 段。\n  修法 A（ReaxFF）：删 ${dataFileName} 的 Bonds 段及 "N bonds" 计数行 → ReaxFF 动态成键。\n  修法 B（普通力场）：把 in.* 改为 \`atom_style full\`（或 molecular/bond）`);
      }
      if (!hasBondsSection && atomStyleNeedsBonds && declaredBonds === 0) {
        staticIssues.push(`⚠ ${atomStyle} 通常含 bonds，但 ${dataFileName} 无 Bonds 段（OK 若是空拓扑，否则检查）`);
      }
    } else {
      staticIssues.push(`⚠ read_data 指向的文件不存在：${dataFileName} → ${dataAbs}`);
    }
  }
  // 2) pair_style reax/c 但缺 fix qeq/reax
  if (/pair_style\s+reax\/c|pair_style\s+reaxff/i.test(txt) && !/fix\s+\S+\s+all\s+qeq\/reax(ff)?/i.test(txt)) {
    staticIssues.push('⚠ 使用 reax/c|reaxff 但未见 `fix ... all qeq/reax` —— ReaxFF 几乎必须电荷平衡。');
  }
  // 3) pair_coeff 末尾元素列表与 atom types 个数对齐（粗检）
  const coeffM = txt.match(/^\s*pair_coeff\s+\*\s+\*\s+\S+\s+(.+)$/m);
  const massCount = (txt.match(/^\s*mass\s+\d+\s/gm) || []).length;
  if (coeffM && massCount) {
    const elemList = coeffM[1].split(/\s+/).filter(x => x && !x.startsWith('#')).length;
    if (elemList !== massCount) {
      staticIssues.push(`⚠ pair_coeff 末尾元素列数 (${elemList}) ≠ mass 行数 (${massCount}) → 元素映射可能错位`);
    }
  }

  // —— 动态校验：跑 LAMMPS run 0 ——
  const patched = txt.replace(/^\s*run\s+\d+.*$/gm, 'run 0 post no');
  const tmp = path.join(cp, '.mdriver_validate.in');
  fs.writeFileSync(tmp, patched);
  const _bin = resolveLammpsBin(ctx);
  try {
    const { code, out } = await runCmd(_bin, ['-in', '.mdriver_validate.in', '-screen', 'none', '-log', 'none', '-echo', 'screen'], { cwd: cp, timeout: 60000 });
    const errLines = out.split('\n').filter(l => /ERROR|WARNING/i.test(l));
    const head = staticIssues.length ? `=== 静态交叉检查（${staticIssues.length} 项） ===\n${staticIssues.join('\n\n')}\n\n` : '';
    return `${head}=== run 0 校验 ===\nexit=${code}\n${errLines.length ? '问题:\n' + errLines.slice(0, 20).join('\n') : '✓ 语法 OK'}\n\n--- tail ---\n${out.split('\n').slice(-30).join('\n')}`;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function runCmd(cmd, args, { cwd, timeout = 30000, env } = {}) {
  return new Promise(resolve => {
    let out = '';
    const spawnOpts = { cwd, shell: false };
    if (env) spawnOpts.env = env;
    const p = spawn(cmd, args, spawnOpts);
    p.stdout.on('data', d => out += d.toString('utf8'));
    p.stderr.on('data', d => out += d.toString('utf8'));
    const t = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve({ code: -1, out: out + '\n[TIMEOUT]' }); }, timeout);
    p.on('error', e => { clearTimeout(t); resolve({ code: -2, out: out + '\n[spawn error] ' + e.message }); });
    p.on('exit', code => { clearTimeout(t); resolve({ code, out }); });
  });
}

// ---------- lmp_run_probe ----------
// 同步短跑健康探针：把 run N 改成 run probe_steps，跑完返回 thermo 序列 + 健康判定。
// 比 validate_input(run 0) 能多抓动力学问题（lost atoms / NaN / 能量爆掉）。
async function lmpRunProbe({ case_path, script, probe_steps = 200, wait_seconds = 90, ensure_minimize = false, np = 1 }, ctx) {
  const cp = abs(ctx, case_path);
  if (!fs.existsSync(cp)) return `[err] case 不存在：${cp}`;
  let inScript = script;
  if (!inScript) {
    const entries = (await fs.promises.readdir(cp)).filter(f => f.startsWith('in.'));
    if (!entries.length) return `[err] 未找到 in.* 脚本`;
    inScript = entries[0];
  }
  const inPath = path.join(cp, inScript);
  if (!fs.existsSync(inPath)) return `[err] in.* 不存在：${inPath}`;
  const origTxt = fs.readFileSync(inPath, 'utf8');
  let patched = origTxt.replace(/^\s*run\s+\d+.*$/gm, `run ${probe_steps}`);
  if (ensure_minimize && !/^\s*minimize\b/m.test(patched)) {
    // 在第一个 run 前插入 minimize
    patched = patched.replace(/^(\s*run\s+\d+)/m, 'minimize 0 1e-8 1000 10000\n$1');
  }
  const tmpName = '.mdriver_probe.in';
  const tmpPath = path.join(cp, tmpName);
  fs.writeFileSync(tmpPath, patched);
  const probeLog = '.mdriver_probe.log';
  const _bin = resolveLammpsBin(ctx);
  const t0 = Date.now();
  try {
    // np > 1 走 mpiexec；否则直接跑 lmp
    const useMpi = (+np || 1) > 1;
    let runProg, runArgs;
    if (useMpi) {
      runProg = process.platform === 'win32' ? 'mpiexec' : 'mpirun';
      runArgs = process.platform === 'win32'
        ? ['-np', String(np), '-localonly', _bin, '-in', tmpName, '-log', probeLog, '-echo', 'screen', '-screen', 'none']
        : ['-np', String(np), _bin, '-in', tmpName, '-log', probeLog, '-echo', 'screen', '-screen', 'none'];
    } else {
      runProg = _bin;
      runArgs = ['-in', tmpName, '-log', probeLog, '-echo', 'screen', '-screen', 'none'];
    }
    const { code, out } = await runCmd(runProg, runArgs, { cwd: cp, timeout: Math.max(5, wait_seconds) * 1000 });
    const wallSec = (Date.now() - t0) / 1000;
    let logTxt = '';
    try { logTxt = fs.readFileSync(path.join(cp, probeLog), 'utf8'); } catch { /* ignore */ }
    // 解析 thermo 表
    const { header, rows } = parseThermoFull(logTxt + '\n' + out);
    const errs = (logTxt + '\n' + out).split('\n').filter(l => /ERROR/i.test(l)).slice(-5);
    const warns = (logTxt + '\n' + out).split('\n').filter(l => /WARNING/i.test(l)).slice(-5);
    // 健康判定
    let verdict = 'healthy';
    let reason = '';
    let atomsStart = null, atomsEnd = null;
    const atomsMatches = (logTxt + out).match(/(\d+)\s+atoms/g) || [];
    if (atomsMatches.length) {
      atomsStart = +(atomsMatches[0].match(/\d+/)[0]);
      atomsEnd = +(atomsMatches[atomsMatches.length - 1].match(/\d+/)[0]);
    }
    if (/Lost atoms:/i.test(logTxt + out)) { verdict = 'lost-atoms'; reason = 'Lost atoms 检出'; }
    else if (errs.length) { verdict = 'crashed'; reason = errs[errs.length - 1].trim(); }
    else if (code === -1) { verdict = 'timeout'; reason = `${wait_seconds}s 内未跑完，可能体系太大 / 死循环；适度调小 probe_steps`; }
    else if (rows.length) {
      const lastRow = rows[rows.length - 1];
      const t = lastRow.Temp ?? lastRow.temp;
      const eTotal = lastRow.TotEng ?? lastRow.toteng ?? lastRow.PotEng ?? lastRow.poteng;
      if (t != null && (!isFinite(+t) || Math.abs(+t) > 1e7)) { verdict = 'temp-nan'; reason = `Temp = ${t}（异常）`; }
      else if (rows.length >= 3) {
        const eFirst = rows[0].TotEng ?? rows[0].toteng ?? rows[0].PotEng ?? rows[0].poteng;
        if (eFirst != null && eTotal != null && isFinite(+eFirst) && isFinite(+eTotal)) {
          const ratio = Math.abs(+eTotal) / (Math.abs(+eFirst) + 1e-12);
          if (ratio > 50) { verdict = 'energy-spike'; reason = `总能 ${eFirst} → ${eTotal}（${ratio.toFixed(1)}x 爆涨）`; }
        }
      }
    }
    if (verdict === 'healthy' && !rows.length && code !== 0) {
      verdict = 'crashed'; reason = `退出码 ${code}，无 thermo 输出，看 tail`;
    }
    // 建议下一步
    let suggested = '';
    if (verdict === 'healthy') {
      if (probe_steps < 2000) suggested = `健康。建议再 probe(${probe_steps * 10}) 确认稳态，然后 lmp_run_async(full)`;
      else if (probe_steps < 20000) suggested = `健康稳态。可以 lmp_run_async 跑完整步数了`;
      else suggested = `已经稳态，可直接 run_async 完整步数`;
    } else if (verdict === 'lost-atoms') {
      suggested = `调 lmp_diagnose_error 看具体修法；多半是初始重叠 / timestep 太大 / 缺 minimize。初始重叠先跑 lmp_soft_pushoff 生成 data.relaxed 再跑。`;
    } else if (verdict === 'temp-nan' || verdict === 'energy-spike') {
      suggested = `极可能初始构型重叠（能量爆/力 NaN）→ 首选 lmp_soft_pushoff 软势预平衡出 data.relaxed 再用 ReaxFF；或加大 box / 减分子数；或 ensure_minimize=true + timestep 减到 1/4。`;
    } else if (verdict === 'timeout') {
      suggested = `减小 probe_steps（如 100），或增大 wait_seconds`;
    } else {
      suggested = `调 lmp_diagnose_error 传入下面的 text_tail`;
    }
    // 仅保留 thermo 表最近 max_rows 行，免得 token 爆
    const maxRows = 30;
    const trimmedRows = rows.length > maxRows ? rows.slice(0, 3).concat(rows.slice(-maxRows + 3)) : rows;
    return JSON.stringify({
      probe_steps, wall_seconds: +wallSec.toFixed(2), exit_code: code,
      atoms_start: atomsStart, atoms_end: atomsEnd, atoms_lost: (atomsStart && atomsEnd) ? (atomsStart - atomsEnd) : null,
      thermo_header: header,
      thermo_rows: trimmedRows,
      errors: errs, warnings: warns.slice(0, 3),
      verdict, reason,
      suggested_next: suggested,
      text_tail: (logTxt + out).slice(-1200),
    }, null, 2);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    try { fs.unlinkSync(path.join(cp, probeLog)); } catch { /* ignore */ }
  }
}

// 解析完整 thermo 表（带数值）
function parseThermoFull(txt) {
  const lines = txt.split('\n');
  let header = null;
  const rows = [];
  let inBlock = false;
  for (const l of lines) {
    const trimmed = l.trim();
    if (/^Step\s+/.test(trimmed) && /\b(Temp|TotEng|PotEng|KinEng|Press)\b/i.test(trimmed)) {
      header = trimmed.split(/\s+/);
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (/Loop time|^---|^WARNING|^ERROR/.test(trimmed)) { inBlock = false; continue; }
      const parts = trimmed.split(/\s+/);
      if (parts.length === header.length && /^-?\d/.test(parts[0])) {
        const row = {};
        for (let i = 0; i < header.length; i++) {
          const v = parts[i];
          row[header[i]] = /^-?\d/.test(v) ? +v : v;
        }
        rows.push(row);
      }
    }
  }
  return { header, rows };
}

// ---------- lmp_run_async / status / stop ----------
// 构造 MPI 前缀：Windows = mpiexec -np N -localonly；Linux/macOS = mpirun -np N。
// 返回空串表示不加前缀。
function _mpiPrefix(np) {
  const n = +np || 1;
  if (n <= 1) return '';
  if (process.platform === 'win32') {
    // 优先 mpiexec（MS-MPI / MPICH 都可用）；-localonly 跳过 smpd 认证
    return `mpiexec -np ${n} -localonly `;
  }
  return `mpirun -np ${n} `;
}

async function lmpRunAsync({ case_path, command, log_name = 'log.lammps', np = 1 }, ctx) {
  const cp = abs(ctx, case_path);
  if (!fs.existsSync(cp)) return `[err] case 不存在：${cp}`;
  let cmdline = command;
  const _bin = resolveLammpsBin(ctx);
  if (!cmdline) {
    const entries = (await fs.promises.readdir(cp)).filter(f => f.startsWith('in.'));
    if (!entries.length) return `[err] 未找到 in.* 脚本，必须显式指定 command`;
    const binQ = /\s/.test(_bin) ? `"${_bin}"` : _bin;
    // 自动 np > 1 加 MPI 前缀
    cmdline = `${_mpiPrefix(np)}${binQ} -in ${entries[0]} -log ${log_name}`;
  } else {
    cmdline = cmdline.replace(/^(\s*)(lmp(?:_serial|_mpi)?(?:\.exe)?|lammps(?:\.exe)?)\b/i, (m, sp) => {
      const binQ = /\s/.test(_bin) ? `"${_bin}"` : _bin;
      return sp + binQ;
    });
    // 用户未手动 mpiexec/mpirun 但设了 np > 1，自动补上
    if (np > 1 && !/^\s*(mpiexec|mpirun)\b/i.test(cmdline)) {
      cmdline = _mpiPrefix(np) + cmdline.trim();
    }
  }
  // Windows MPICH2 多核：smpd 没设密码时会反复弹 "unable to manage jobs with blank password"。
  // 自动注入 -localonly（同一节点 fork 子进程，不走 smpd 认证）。
  if (process.platform === 'win32' && /^\s*mpiexec(\.exe)?\b/i.test(cmdline) && !/-localonly\b/i.test(cmdline) && !/-machinefile|-hosts/i.test(cmdline)) {
    cmdline = cmdline.replace(/^(\s*mpiexec(?:\.exe)?\b)/i, '$1 -localonly');
  }
  const runId = randomUUID().slice(0, 8);
  // Windows: 直接把已带引号的整条 cmdline 交给 shell（保留路径空格的引号），
  //          切勿先 split + 去引号再 shell:true —— 那样 "C:\Program Files\..\lmp.exe"
  //          会被 cmd.exe 按空格拆开（经典「命令行路径空格」报错）。
  // Linux/mac: 用 parts 数组 + shell:false，spawn 直接按 argv 传参，空格天然安全。
  let proc;
  if (process.platform === 'win32') {
    proc = spawn(cmdline, { cwd: cp, shell: true, windowsVerbatimArguments: true });
  } else {
    const parts = cmdline.match(/(?:[^\s"]+|"[^"]*")+/g).map(s => s.replace(/^"|"$/g, ''));
    proc = spawn(parts[0], parts.slice(1), { cwd: cp, shell: false });
  }
  const logPath = path.join(cp, log_name);
  let tail = '';
  proc.stdout.on('data', d => { tail += d.toString(); if (tail.length > 16384) tail = tail.slice(-12288); });
  proc.stderr.on('data', d => { tail += d.toString(); if (tail.length > 16384) tail = tail.slice(-12288); });

  // ====== A) 实时 thermo 增量推送（每 2s 读 log，推增量行到前端） ======
  let lastEmittedStep = -1;
  let thermoHeader = null;
  const tickInterval = setInterval(() => {
    try {
      if (!fs.existsSync(logPath)) return;
      const buf = fs.readFileSync(logPath, 'utf8');
      const parsed = parseThermoFull(buf);
      if (parsed.header) thermoHeader = parsed.header;
      const newRows = parsed.rows.filter(r => (r.Step ?? r.step ?? 0) > lastEmittedStep);
      if (newRows.length) {
        lastEmittedStep = +(newRows[newRows.length - 1].Step ?? newRows[newRows.length - 1].step ?? lastEmittedStep);
        if (ctx && typeof ctx.pushThermo === 'function') {
          ctx.pushThermo({ run_id: runId, header: thermoHeader, rows: newRows.slice(-50), case_path: path.relative(ctx.WORKSPACE || cp, cp), cmd: cmdline });
        }
      }
    } catch { /* ignore */ }
  }, 2000);

  proc.on('exit', code => {
    clearInterval(tickInterval);
    const j = JOBS.get(runId); if (j) { j.status = 'done'; j.exitCode = code; j.endedAt = Date.now(); }
    // ====== E) 跑结束自动推送总结卡片 ======
    if (ctx && typeof ctx.pushSummary === 'function') {
      try {
        const buf = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
        // 关键：LAMMPS 早期崩溃时 log 文件可能根本没建（或只有 banner），
        // 真实错误在 stdout/stderr（这里的 tail 闭包变量），必须合并进来一起 grep ERROR。
        const combined = buf + '\n' + (tail || '');
        const { header, rows } = parseThermoFull(buf);
        const errs = combined.split('\n').filter(l => /ERROR|Cannot open|No such file|command not found|fatal/i.test(l)).slice(-5);
        const warns = combined.split('\n').filter(l => /WARNING/i.test(l)).slice(-5);
        const loopM = buf.match(/Loop time of ([\d.eE+-]+) on (\d+) procs/);
        const nsDayM = buf.match(/Performance:\s+([\d.eE+-]+) ns\/day/);
        const tspsM = buf.match(/Performance:.*?([\d.eE+-]+)\s+timesteps\/s/);
        const atomsM = buf.match(/(\d+)\s+atoms/);
        // 0s 崩溃 + log 几乎空：把 stderr/stdout 尾部直接当 "stderr_tail" 发给前端，便于用户秒诊断。
        const stderrTail = (!buf || buf.length < 200) && tail ? tail.split('\n').filter(l => l.trim()).slice(-12).join('\n') : '';
        ctx.pushSummary({
          run_id: runId,
          case_path: path.relative(ctx.WORKSPACE || cp, cp),
          log_name,
          cmd: cmdline,
          exit_code: code,
          duration_sec: ((Date.now() - (j ? j.started : Date.now())) / 1000) | 0,
          loop_time_sec: loopM ? +loopM[1] : null,
          procs: loopM ? +loopM[2] : null,
          ns_per_day: nsDayM ? +nsDayM[1] : null,
          timesteps_per_sec: tspsM ? +tspsM[1] : null,
          atoms: atomsM ? +atomsM[1] : null,
          thermo_header: header,
          thermo_rows: rows.length > 60 ? rows.slice(0, 3).concat(rows.slice(-57)) : rows,
          last_step: rows.length ? (rows[rows.length - 1].Step ?? rows[rows.length - 1].step) : null,
          errors: errs,
          warnings: warns,
          stderr_tail: stderrTail,
          verdict: errs.length ? 'crashed' : (code === 0 ? 'ok' : `exit_${code}`),
        });
      } catch { /* ignore */ }
    }
  });
  proc.on('error', e => { clearInterval(tickInterval); const j = JOBS.get(runId); if (j) { j.status = 'error'; j.error = e.message; } });
  JOBS.set(runId, { proc, case_path: cp, log_path: logPath, started: Date.now(), status: 'running', tail: () => tail, cmd: cmdline });
  if (ctx && typeof ctx.onAsyncLaunch === 'function') { try { ctx.onAsyncLaunch(runId); } catch { /* ignore */ } }
  return `runId=${runId} 已启动\n  cmd: ${cmdline}\n  cwd: ${path.relative(ctx.WORKSPACE, cp)}\n  log: ${log_name}\n` +
    `▶ 下一步：**立刻调 \`lmp_run_wait("${runId}")\` 阻塞等它跑完**，拿到最终结果再汇报/后处理——这才算把问题跑到完整结束。\n` +
    `期间前端有实时 thermo 曲线，跑完也会自动出总结卡。**除非 verdict=crashed，否则不要改 in.*、不要换方案、不要重启**；等到 still-running 就再 lmp_run_wait 续等。`;
}

async function lmpRunStatus({ run_id }, _ctx) {
  const j = JOBS.get(run_id);
  if (!j) return `[err] runId 不存在: ${run_id}`;
  let logTail = '';
  try {
    if (fs.existsSync(j.log_path)) {
      const buf = fs.readFileSync(j.log_path, 'utf8');
      logTail = buf.split('\n').slice(-40).join('\n');
    }
  } catch { /* ignore */ }
  const thermo = parseLogQuick(logTail);
  const running = j.status === 'running';
  const hint = running
    ? '仍在正常运行（step 在推进就是健康）。请勿重复轮询、勿改 in.*、勿换力场/参数/方案——跑完会自动出总结卡。本轮先收手等待；确需再查请隔≥30-60 秒。'
    : (j.status === 'error' || (j.exitCode != null && j.exitCode !== 0)
        ? '已异常结束 → 可调 lmp_diagnose_error 拿修法再重跑。'
        : '已结束。');
  return JSON.stringify({
    run_id, status: j.status, cmd: j.cmd,
    started_ms_ago: Date.now() - j.started,
    last_step: thermo.last_step,
    last_thermo: thermo.last_row,
    exit_code: j.exitCode ?? null,
    error: j.error ?? null,
    advice: hint,
    stdout_tail: j.tail().split('\n').slice(-15).join('\n'),
    log_tail: logTail,
  }, null, 2);
}

async function lmpRunStop({ run_id }, _ctx) {
  const j = JOBS.get(run_id);
  if (!j) return `[err] runId 不存在: ${run_id}`;
  try { j.proc.kill(); j.status = 'stopped'; return `已发送 SIGTERM 到 ${run_id}`; }
  catch (e) { return `[err] ${e.message}`; }
}

// 阻塞等待一个异步 run 跑完（最多 timeout_sec 秒），跑完返回最终判定 + 末段 thermo。
// 这是"把问题跑到完整结束"的关键原语：提交 lmp_run_async 后调它，本轮就能拿到真实结果，
// 不必 fire-and-forget 也不必反复轮询。超时只是"还没跑完"，不代表失败——可再等一次或交给总结卡。
async function lmpRunWait({ run_id, timeout_sec = 600 }, ctx) {
  const j = JOBS.get(run_id);
  if (!j) return `[err] runId 不存在: ${run_id}`;
  const deadline = Date.now() + Math.max(1, Math.min(7200, timeout_sec)) * 1000;
  // 等待期间也主动读 log 推实时 thermo（动态线图）——即便异步进程的 2s 推送漏了，
  // 这里也保证 lmp_run_wait 期间前端的曲线在动。前端按 step 去重，和异步推送不会冲突。
  let waitLastStep = -1;
  let waitHeader = null;
  const caseRel = (() => { try { return path.relative(ctx?.WORKSPACE || path.dirname(j.log_path), path.dirname(j.log_path)); } catch { return ''; } })();
  const pushLive = () => {
    try {
      if (!ctx || typeof ctx.pushThermo !== 'function') return;
      if (!fs.existsSync(j.log_path)) return;
      const parsed = parseThermoFull(fs.readFileSync(j.log_path, 'utf8'));
      if (parsed.header) waitHeader = parsed.header;
      const newRows = parsed.rows.filter(r => (+(r.Step ?? r.step ?? 0)) > waitLastStep);
      if (newRows.length) {
        waitLastStep = +(newRows[newRows.length - 1].Step ?? newRows[newRows.length - 1].step ?? waitLastStep);
        ctx.pushThermo({ run_id, header: waitHeader, rows: newRows.slice(-50), case_path: caseRel, cmd: j.cmd || '' });
      }
    } catch { /* ignore */ }
  };
  while (j.status === 'running' && Date.now() < deadline) {
    if (ctx && typeof ctx.isAborted === 'function' && ctx.isAborted()) break; // 用户点停止 → 立即返回
    pushLive();
    await new Promise(r => setTimeout(r, 1500));
  }
  pushLive(); // 收尾再推一次，确保末尾几行也上图
  let logTail = '';
  try {
    if (fs.existsSync(j.log_path)) logTail = fs.readFileSync(j.log_path, 'utf8').split('\n').slice(-60).join('\n');
  } catch { /* ignore */ }
  const thermo = parseLogQuick(logTail);
  const stillRunning = j.status === 'running';
  const errLines = logTail.split('\n').filter(l => /ERROR|Cannot open|No such file|fatal/i.test(l)).slice(-4);
  const verdict = stillRunning ? 'still-running'
    : (j.status === 'stopped' ? 'stopped'
      : (j.status === 'error' || errLines.length || (j.exitCode != null && j.exitCode !== 0) ? 'crashed' : 'ok'));
  const advice = stillRunning
    ? `等了 ${timeout_sec}s 还没跑完——这是大体系正常现象，不是错误。可以再 lmp_run_wait 续等，或先收手让它跑完自动出总结卡。**别因为没等到就改 in./换方案/重启**。`
    : (verdict === 'ok' ? '已完整跑完 ✓。可做后处理（lmp_plot_thermo / lmp_post_* / lmp_render_traj）或向用户汇报最终结果。'
      : verdict === 'crashed' ? '异常结束 → 调 lmp_diagnose_error 拿修法再重跑。'
        : '已被停止。');
  return JSON.stringify({
    run_id, status: j.status, verdict,
    waited_sec: Math.round((Date.now() - (deadline - Math.max(1, Math.min(7200, timeout_sec)) * 1000)) / 1000),
    elapsed_ms_total: Date.now() - j.started,
    exit_code: j.exitCode ?? null,
    last_step: thermo.last_step,
    last_thermo: thermo.last_row,
    errors: errLines,
    advice,
    log_tail: logTail.split('\n').slice(-20).join('\n'),
  }, null, 2);
}

// 给 server 自训练用：阻塞等某个 runId 的作业结束（或超时），不返回内容——只为"评测前确保真的跑完"。
export async function waitForRun(runId, maxMs = 600000) {
  const j = JOBS.get(runId);
  if (!j) return false;
  const deadline = Date.now() + maxMs;
  while (j.status === 'running' && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000));
  }
  return j.status !== 'running';
}

// 给 server 自训练用：拿某个 runId 的最终判定（ok / crashed / stopped / still-running / unknown）。
// 用于评测时把"完整跑完"信号写进 skillTurn，避免"明明跑完却判未跑完"。
export function getRunVerdict(runId) {
  const j = JOBS.get(runId);
  if (!j) return 'unknown';
  if (j.status === 'running') return 'still-running';
  if (j.status === 'stopped') return 'stopped';
  let errLines = 0;
  try {
    if (fs.existsSync(j.log_path)) {
      const tail = fs.readFileSync(j.log_path, 'utf8').split('\n').slice(-60).join('\n');
      errLines = tail.split('\n').filter(l => /ERROR|Cannot open|No such file|fatal/i.test(l)).length;
    }
  } catch { /* ignore */ }
  if (j.status === 'error' || errLines || (j.exitCode != null && j.exitCode !== 0)) return 'crashed';
  return 'ok';
}

function parseLogQuick(txt) {
  const lines = txt.split('\n');
  let header = null; let lastRow = null; let lastStep = null;
  for (const l of lines) {
    if (/^Step\s+/.test(l.trim())) { header = l.trim().split(/\s+/); continue; }
    if (header) {
      const parts = l.trim().split(/\s+/);
      if (parts.length === header.length && /^-?\d/.test(parts[0])) {
        lastRow = Object.fromEntries(header.map((h, i) => [h, parts[i]]));
        lastStep = parts[0];
      } else if (/Loop time/.test(l)) break;
    }
  }
  return { header, last_row: lastRow, last_step: lastStep };
}

// ---------- lmp_parse_log ----------
async function lmpParseLog({ case_path, log_name = 'log.lammps', columns, max_rows = 200 }, ctx) {
  const cp = abs(ctx, case_path);
  const lp = path.join(cp, log_name);
  if (!fs.existsSync(lp)) return `[err] log 不存在：${lp}`;
  const txt = fs.readFileSync(lp, 'utf8');
  const lines = txt.split('\n');
  const blocks = []; let cur = null;
  for (const l of lines) {
    const t = l.trim();
    if (/^Step\s/.test(t)) { cur = { header: t.split(/\s+/), rows: [] }; blocks.push(cur); continue; }
    if (cur && /^Loop time of /.test(t)) { cur.loop = t; cur = null; continue; }
    if (cur) {
      const parts = t.split(/\s+/);
      if (parts.length === cur.header.length && /^-?\d/.test(parts[0])) cur.rows.push(parts);
    }
  }
  const wallMatch = txt.match(/Total wall time:\s+(\S+)/);
  const perfMatches = [...txt.matchAll(/Performance:\s+([\d.]+)\s+ns\/day.*?(\d+\.\d+)\s+timesteps\/s/g)];
  const errors = lines.filter(l => /^ERROR/.test(l.trim())).slice(0, 5);
  const warnings = lines.filter(l => /^WARNING/.test(l.trim())).slice(0, 5);
  const version = (txt.match(/LAMMPS \(([^)]+)\)/) || ['', ''])[1];
  // 取最后一个 block, 截 max_rows, columns 过滤
  const lastBlock = blocks[blocks.length - 1];
  let result = {
    n_blocks: blocks.length,
    lammps_version: version || null,
    wall_time: wallMatch?.[1],
    performance: perfMatches.map(m => ({ ns_per_day: +m[1], steps_per_s: +m[2] })),
    errors,
    warnings,
    finished: blocks.some(b => b.loop),
  };
  if (lastBlock) {
    let hdr = lastBlock.header;
    let rows = lastBlock.rows.slice(-max_rows);
    if (columns) {
      const idx = columns.map(c => hdr.indexOf(c)).filter(i => i >= 0);
      hdr = idx.map(i => lastBlock.header[i]);
      rows = rows.map(r => idx.map(i => r[i]));
    }
    // 数值列 min/max/mean —— 帮助 LLM 一眼看趋势
    const stats = {};
    for (let c = 0; c < hdr.length; c++) {
      const vals = lastBlock.rows.map(r => parseFloat(r[c])).filter(v => Number.isFinite(v));
      if (vals.length > 1 && /Temp|Press|TotEng|PotEng|KinEng|Volume|Density|E_|c_/i.test(hdr[c])) {
        const mn = Math.min(...vals), mx = Math.max(...vals);
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        stats[hdr[c]] = { min: +mn.toFixed(4), max: +mx.toFixed(4), mean: +mean.toFixed(4), first: +vals[0].toFixed(4), last: +vals[vals.length - 1].toFixed(4), n: vals.length };
      }
    }
    result.header = hdr;
    result.rows_returned = rows.length;
    result.rows_total = lastBlock.rows.length;
    result.rows = rows;
    result.column_stats = stats;
    result.summary = {
      first_step: lastBlock.rows[0]?.[0] || null,
      last_step: lastBlock.rows[lastBlock.rows.length - 1]?.[0] || null,
      total_steps: lastBlock.rows.length,
      converged_temp: stats.Temp ? Math.abs(stats.Temp.last - stats.Temp.mean) / Math.max(1, stats.Temp.mean) < 0.05 : null,
      diverged: stats.TotEng ? !Number.isFinite(stats.TotEng.last) || Math.abs(stats.TotEng.last) > 1e10 : null,
    };
  }
  if (errors.length) result.recommended_next = 'lmp_diagnose_error 解析 errors[0]';
  return JSON.stringify(result, null, 2);
}

// ---------- lmp_dump_summary ----------
async function lmpDumpSummary({ case_path }, ctx) {
  const cp = abs(ctx, case_path);
  const files = (await walk(cp, { maxDepth: 4 })).filter(f => {
    const b = path.basename(f);
    return b.startsWith('dump.') || /\.(lammpstrj|xyz|dump)$/i.test(b);
  });
  const out = [];
  for (const f of files) {
    let info = { file: path.relative(cp, f), size_kb: (fs.statSync(f).size / 1024).toFixed(1) };
    try {
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(8192);
      fs.readSync(fd, buf, 0, 8192, 0); fs.closeSync(fd);
      const head = buf.toString('utf8').split('\n');
      // LAMMPS custom dump
      if (head[0]?.startsWith('ITEM:')) {
        const lines = head;
        const natomsIdx = lines.findIndex(l => l.includes('NUMBER OF ATOMS'));
        if (natomsIdx >= 0) info.n_atoms = +lines[natomsIdx + 1];
        const boxIdx = lines.findIndex(l => l.includes('BOX BOUNDS'));
        if (boxIdx >= 0) info.box = lines.slice(boxIdx + 1, boxIdx + 4).map(s => s.trim());
        const colIdx = lines.findIndex(l => l.includes('ITEM: ATOMS'));
        if (colIdx >= 0) info.columns = lines[colIdx].replace('ITEM: ATOMS', '').trim().split(/\s+/);
        // count frames cheap: grep ITEM: TIMESTEP via full read up to 64 KB extrapolation — actual full count via stream
        info.frames = await countFrames(f, 'ITEM: TIMESTEP');
      } else if (/^\d+\s*$/.test(head[0]?.trim())) {
        info.format = 'xyz';
        info.n_atoms = +head[0];
        info.frames = await countFrames(f, head[0].trim());
      }
    } catch (e) { info.error = String(e); }
    out.push(info);
  }
  return JSON.stringify(out, null, 2);
}

async function countFrames(file, marker) {
  return new Promise(resolve => {
    let count = 0;
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    let buf = '';
    stream.on('data', chunk => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf(marker)) >= 0) { count++; buf = buf.slice(idx + marker.length); }
      if (buf.length > marker.length * 4) buf = buf.slice(-marker.length * 2);
    });
    stream.on('end', () => resolve(count));
    stream.on('error', () => resolve(count));
  });
}

// ---------- lmp_plot_thermo ----------
// 后处理脚本要跑的 python 解释器候选：优先用户在 UI 选中的（ctx.pythonPath），
// 再退回 PATH 上的 python / python3。解决"后处理找不到 python 路径"。
function _pyCandidates(ctx) {
  const list = [];
  if (ctx && ctx.pythonPath) list.push(ctx.pythonPath);
  list.push('python', 'python3');
  return [...new Set(list.filter(Boolean))];
}
async function _runPy(ctx, args, opts) {
  let last = { code: -1, out: '[err] 没有可用的 python 解释器' };
  for (const py of _pyCandidates(ctx)) {
    last = await runCmd(py, args, opts);
    if (last.code === 0) return last;
  }
  return last;
}
async function lmpPlotThermo({ case_path, log_name = 'log.lammps', x = 'Step', y, save_as = 'thermo.png' }, ctx) {
  const cp = abs(ctx, case_path);
  const helperPath = resolveHelper('lmp_log_parse.py');
  if (!helperPath) return `[err] 找不到 helpers/lmp_log_parse.py（请检查安装目录 helpers/ 是否完整）`;
  const outImg = path.join(cp, save_as);
  const args = [helperPath, '--log', path.join(cp, log_name), '--x', x, '--y', y.join(','), '--out', outImg];
  const { code, out } = await _runPy(ctx, args, { cwd: cp, timeout: 60000 });
  if (code !== 0) {
    return `[err] plot failed (exit ${code})\n${out}\n提示：在顶部选对 Python 解释器，并 pip install matplotlib numpy`;
  }
  if (ctx.pushImage) ctx.pushImage(outImg, `thermo: ${y.join(', ')}`);
  return `已生成 ${path.relative(ctx.WORKSPACE, outImg)}`;
}

// ---------- lmp_render_traj ----------
async function lmpRenderTraj({ case_path, dump_file, frame = -1, color_by, view = 'iso', save_as }, ctx) {
  const cp = abs(ctx, case_path);
  const dump = path.isAbsolute(dump_file) ? dump_file : path.join(cp, dump_file);
  if (!fs.existsSync(dump)) return `[err] dump 不存在：${dump}`;
  // 提前体检：空文件 / 没有 ITEM:TIMESTEP 行 → 用户多半还没跑完或 dump 路径写错
  const st = fs.statSync(dump);
  if (st.size === 0) return `[err] dump 文件为空（0 B）：${dump}\n  → LAMMPS 还没写入任何帧，确认 run 已经跑过且 dump 间隔已触发`;
  // 允许直接渲染 LAMMPS data 文件 → 看「初始构型」（跑之前/没有 dump 时）
  const head0 = fs.readFileSync(dump, 'utf8').slice(0, 4000);
  const isDataFile = !/ITEM:\s*TIMESTEP/i.test(head0) && /\d+\s+atoms/i.test(head0) && /(xlo|^\s*Atoms)/im.test(head0);
  if (!isDataFile && st.size < 200) {
    if (!/ITEM:\s*TIMESTEP/i.test(head0) && !/^\d+\s*$/m.test(head0)) {
      return `[err] dump 文件格式不识别（既不是 LAMMPS custom 也不是 xyz / data）：\n${head0.slice(0, 400)}`;
    }
  }
  const outImg = path.join(cp, save_as || `traj_frame${frame}.png`);
  const helperPath = resolveHelper('lmp_render_ovito.py');
  if (!helperPath) return `[err] 找不到 helpers/lmp_render_ovito.py（请检查安装目录 helpers/ 是否完整）`;
  const args = [helperPath, '--dump', dump, '--frame', String(frame), '--view', view, '--out', outImg];
  if (color_by) { args.push('--color-by', color_by); }
  const { code, out } = await _runPy(ctx, args, { cwd: cp, timeout: 120000 });
  if (code !== 0) {
    const stderr = (out || '').slice(-2000);
    return `[err] render failed (exit ${code})\n${stderr}\n\n提示：在顶部选对 Python 解释器，并 pip install matplotlib（OVITO 可选：pip install ovito）`;
  }
  if (ctx.pushImage) ctx.pushImage(outImg, `${path.basename(dump)} frame=${frame}`);
  return `已渲染 ${path.relative(ctx.WORKSPACE, outImg)}`;
}

// ---------- lmp_build_data_file ----------
async function lmpBuildDataFile(args, ctx) {
  const cp = abs(ctx, args.case_path);
  await fs.promises.mkdir(cp, { recursive: true });
  const out_name = args.out_name || 'data.generated';
  const out = path.join(cp, out_name);
  let atoms = [];
  let box = null;
  if (args.lattice) {
    const L = args.lattice; const a = L.a;
    const basis = { fcc: [[0,0,0],[0.5,0.5,0],[0.5,0,0.5],[0,0.5,0.5]],
                    bcc: [[0,0,0],[0.5,0.5,0.5]],
                    sc:  [[0,0,0]],
                    diamond: [[0,0,0],[0.5,0.5,0],[0.5,0,0.5],[0,0.5,0.5],[0.25,0.25,0.25],[0.75,0.75,0.25],[0.75,0.25,0.75],[0.25,0.75,0.75]] }[L.type];
    if (!basis) return `[err] lattice type 不支持：${L.type}`;
    const type = L.atom_type || 1;
    for (let i = 0; i < L.nx; i++) for (let j = 0; j < L.ny; j++) for (let k = 0; k < L.nz; k++) {
      for (const b of basis) atoms.push([type, (i + b[0]) * a, (j + b[1]) * a, (k + b[2]) * a]);
    }
    box = [0, L.nx * a, 0, L.ny * a, 0, L.nz * a];
  } else if (args.atoms_xyz) {
    atoms = args.atoms_xyz;
    box = args.box;
    if (!box) return `[err] atoms_xyz 模式必须提供 box=[xlo,xhi,ylo,yhi,zlo,zhi]`;
  } else {
    return `[err] 必须提供 lattice 或 atoms_xyz`;
  }
  const types = new Set(atoms.map(a => a[0]));
  const lines = [];
  lines.push(`# LAMMPS data file generated by MDriver (${args.units || 'metal'} units, ${args.atom_style || 'atomic'})`);
  lines.push('');
  lines.push(`${atoms.length} atoms`);
  lines.push(`${types.size} atom types`);
  lines.push('');
  lines.push(`${box[0]} ${box[1]} xlo xhi`);
  lines.push(`${box[2]} ${box[3]} ylo yhi`);
  lines.push(`${box[4]} ${box[5]} zlo zhi`);
  lines.push('');
  if (args.masses) {
    lines.push('Masses');
    lines.push('');
    for (const [t, m] of Object.entries(args.masses)) lines.push(`${t} ${m}`);
    lines.push('');
  }
  // 按 atom_style 输出正确列数，避免 LAMMPS "Incorrect format in Atoms section" / 列数不符。
  //   atomic    → id type x y z            (5 列)
  //   charge    → id type q x y z          (6 列)  ← ReaxFF 用这个
  //   full      → id mol type q x y z      (7 列)
  //   molecular → id mol type x y z        (6 列)
  const style = (args.atom_style || 'atomic').toLowerCase();
  lines.push(`Atoms # ${style}`);
  lines.push('');
  atoms.forEach((a, i) => {
    const id = i + 1, type = a[0], x = a[1], y = a[2], z = a[3];
    const q = (a.length > 4 ? a[4] : 0.0); // 初始电荷默认 0（ReaxFF 由 fix qeq/reaxff 平衡）
    let row;
    switch (style) {
      case 'charge':    row = `${id} ${type} ${q} ${x} ${y} ${z}`; break;
      case 'full':      row = `${id} 1 ${type} ${q} ${x} ${y} ${z}`; break;
      case 'molecular':
      case 'bond':
      case 'angle':     row = `${id} 1 ${type} ${x} ${y} ${z}`; break;
      default:          row = `${id} ${type} ${x} ${y} ${z}`; // atomic
    }
    lines.push(row);
  });
  fs.writeFileSync(out, lines.join('\n'));
  return `已生成 ${path.relative(ctx.WORKSPACE, out)}\n  原子数: ${atoms.length}\n  类型数: ${types.size}\n  atom_style: ${style}\n  box: ${box.join(' ')}`;
}

// ---------- lmp_diagnose_error ----------
const ERROR_PATTERNS = [
  { re: /No bonds allowed with this atom style/i, cat: 'atom-style-no-bonds',
    causes: ['in.* 写了 atom_style atomic / charge / sphere，而 data 文件却有 Bonds 段', '常见于：用 ReaxFF 模板（charge）却读入了 molecular topology data；或忘了把 atom_style 改成 full/molecular/bond'],
    steps: [
      '① 如果是 ReaxFF：data 文件里**不应**有 Bonds/Angles/Dihedrals 段（ReaxFF 动态成键）。打开 data.* 删 Bonds 段及其上方 "X bonds" 计数行，或重新用 lmp_packmol_build 生成无 bond 拓扑',
      '② 如果是普通力场（OPLS/CHARMM/Dreiding）：把 in.* 里 `atom_style charge|atomic` 改为 `atom_style full`（含电荷+bonds+angles）或 `molecular`（无电荷）',
      '③ 双向确认：grep -i "atom_style" in.* 与 grep -i "bonds" data.* 必须匹配',
      '④ 若是 lmp_packmol_build 误生成 Bonds，回归到 ReaxFF 模板（charge）',
    ] },
  { re: /Incorrect atom format in data file/i, cat: 'data-format-mismatch',
    causes: ['data 文件 Atoms 段每行列数与 atom_style 期望不一致'],
    steps: [
      'atom_style atomic → 5 列 (id type x y z)',
      'atom_style charge → 6 列 (id type q x y z)  ← ReaxFF 用这个',
      'atom_style full   → 7 列 (id mol type q x y z)',
      'atom_style molecular → 6 列 (id mol type x y z)',
      '检查首行 Atoms 段下面紧跟的数据行列数，与上面对照',
    ] },
  { re: /Out of range atoms - cannot compute PPPM/i, cat: 'pppm-out-of-range', causes: ['原子飞出 box / 周期性条件设置错', 'timestep 过大导致原子炸飞'], steps: ['检查 boundary 是否周期', '缩小 timestep 或先 minimize', 'velocity 加 zero linear/angular', '检查初始构型是否过近 (用 minimize 或 lattice spacing)'] },
  { re: /Bond atoms .* missing/i, cat: 'bond-missing', causes: ['communication cutoff 不够', '原子飞出', 'data 文件 bond 不一致'], steps: ['neighbor 改大 / comm_modify cutoff', 'minimize 后再 run', '检查 data 中的 bond/angle topology'] },
  { re: /Communication cutoff (is )?0\.0|No ghost atoms will be generated/i, cat: 'comm-cutoff-zero', warn: true,
    causes: [
      '【多为警告，非报错】ghost（鬼原子）通信距离=0：当前 pair_style 截断 + neighbor skin 求得的通信距离为 0',
      '常见于只有 pair_style 但 pair_coeff 全 0 / 体系暂无有效相互作用 / 缺 neighbor 命令的预平衡脚本',
    ],
    steps: [
      '若 run 正常结束、原子数不丢，可忽略（只是提醒可能丢原子）',
      '想消除：显式加 `neighbor 2.0 bin` + `comm_modify cutoff <≈pair截断+skin>`（如 soft 势 2.5 → cutoff 4.5）',
      'ReaxFF 主程序已带 `neighbor 2.0 bin`，一般不会触发；触发多在 soft 预平衡/自写脚本里',
    ] },
  { re: /Lost atoms:/i, cat: 'lost-atoms',
    causes: [
      '【最常见】初始构型重叠（FCC 上下层 z 间隙 < a）→ 势能爆 → 原子瞬间飞出',
      '【常见】timestep 太大（ReaxFF 写 ≥ 1 fs / LJ ≥ 0.01 / metal ≥ 5 fs 都会飞）',
      '边界 f f f 但没 fix wall/reflect 兜住，流体冲出 box',
      '上下壁面 region 用真实单位写，Lz 不是 lattice 整数倍 → 表层原子被切掉',
      '没 velocity create → 初速度全 0，势能驱动单向暴跑',
    ],
    steps: [
      '**先 minimize 0 1e-8 1000 10000 再 run**（消重叠，最有效）',
      'ReaxFF: timestep 0.25 fs ；LJ: 0.005 ；real(有机): 0.5-1 fs ；metal: 1-2 fs',
      '"流-壁" 系统：boundary p p f + 顶/底 fix wall/reflect',
      'region 用 units lattice 写 + 加 0.01a 缓冲，或显式 lattice fcc a origin 0 0 0 钉死',
      'velocity all create T seed mom yes rot yes（消整体漂移）',
      '调 lmp_dump_summary 确认每个 group 实际原子数，再 lmp_render_traj frame=0 眼瞅几何',
    ] },
  { re: /Neighbor list overflow/i, cat: 'neighbor-overflow', causes: ['密度过高 / neighbor list 内存不足'], steps: ['neigh_modify page/one 提高', 'neighbor 距离调小', '减少原子数或分块跑'] },
  { re: /Cannot open file/i, cat: 'file-not-found', causes: ['路径错或文件未生成', 'cwd 不对'], steps: ['ls/list_dir 确认文件存在', '使用相对 case 目录的路径'] },
  { re: /Unknown pair_style/i, cat: 'pair-style-missing', causes: ['对应的 USER-* / EXTRA-PAIR 包未编译进 lammps'], steps: ['lmp_env_info 查 packages', '重编译 lammps 加入对应包', 'lmp -h | grep PairStyle 确认'] },
  { re: /Unknown fix style/i, cat: 'fix-style-missing', causes: ['对应包未编译'], steps: ['lmp -h 查可用 fix list', '重编译加包'] },
  { re: /Substituted for ZBL/i, cat: 'tersoff-warning', causes: ['Tersoff/ZBL 部分参数缺失'], steps: ['检查 .tersoff 势函数文件元素是否齐全'] },
  { re: /Energy was not tallied/i, cat: 'energy-warning', causes: ['pair_style hybrid 没 fix_modify energy yes'], steps: ['加 fix_modify ID energy yes'] },
  { re: /Cannot use neighbor bins/i, cat: 'bin-too-small', causes: ['box 比 cutoff 还小'], steps: ['增大 box 或减小 cutoff', '改 neighbor nsq'] },
  { re: /Inconsistent image flags/i, cat: 'image-flags', causes: ['data 文件 image flag 与位置不符'], steps: ['用 reset_atoms image 修', '或在 read_data 加 fix_atom_id'] },
  { re: /ERROR.*Atom IDs must be consecutive/i, cat: 'atom-id-gap', causes: ['delete_atoms 后 ID 不连续'], steps: ['reset_atoms id sort yes'] },
  { re: /Domain too large for neighbor bins/i, cat: 'box-too-big', causes: ['box 太大 / 维度异常'], steps: ['change_box 调整', '检查 displace_atoms 是否漂移'] },
  { re: /No pair coefficients set/i, cat: 'missing-coeff', causes: ['pair_coeff 行缺失或被注释'], steps: ['对每种 type-pair 都要 pair_coeff', '检查 hybrid 子 style 都设了'] },
  { re: /Variable name must be alphanumeric/i, cat: 'var-name', causes: ['variable 名含特殊字符'], steps: ['改用纯字母数字下划线'] },
  { re: /MPI_Abort/i, cat: 'mpi-abort', causes: ['某 rank 出错触发 abort'], steps: ['看本文上一段定位具体 ERROR', '减小并行规模 reproduce'] },
  { re: /Cuda error/i, cat: 'gpu-error', causes: ['GPU 包问题 / driver 版本不匹配'], steps: ['nvidia-smi 查 GPU', '回退 CPU 跑', '改 package gpu 选项'] },
  { re: /Incorrect args for pair coefficients/i, cat: 'pair-coeff-args', causes: ['pair_coeff 参数个数 / 顺序与 pair_style 不匹配'], steps: ['lmp_doc_lookup query="pair_<style>" 查文档', 'cases/lammps-official/examples 找该 style 真实样例', '检查势函数文件元素列与 type 顺序一致'] },
  { re: /Reaxff:.*atom .* has no .* parameters/i, cat: 'reaxff-missing-element', causes: ['ffield.reax.* 中缺该元素', '元素映射顺序错（pair_coeff 末尾的元素列表）'], steps: ['lmp_find_potential pattern="<element>" 找含目标元素的 ffield', '核对 pair_coeff * * ffield.reax.X H C O N S 元素列表与 atom type 严格对应'] },
  { re: /ERROR:.*Last command:/i, cat: 'last-command-extract', causes: ['LAMMPS 报错时通常打印最后一条命令'], steps: ['看 "Last command:" 一行，定位具体出错命令', '在该命令上下文 ±10 行检查'] },
];

function lmpDiagnoseError({ text }) {
  const t = String(text || '');
  const hits = [];
  for (const p of ERROR_PATTERNS) if (p.re.test(t)) hits.push(p);
  // 提取上下文：ERROR 行、Last command、版本
  const errorLine = (t.match(/^.*ERROR[: ].*$/im) || [''])[0].trim();
  const lastCmd   = (t.match(/Last command:\s*(.+)/i) || ['', ''])[1].trim();
  const version   = (t.match(/LAMMPS \(([^)]+)\)/) || ['', ''])[1].trim();
  const exitCode  = (t.match(/\[退出码\s*(-?\d+)\]/) || ['', ''])[1].trim();
  // 过滤掉 last-command-extract（仅作上下文标记）
  const real = hits.filter(h => h.cat !== 'last-command-extract');
  if (!real.length) {
    return JSON.stringify({
      matched: 0,
      error_line: errorLine || null,
      last_command: lastCmd || null,
      lammps_version: version || null,
      exit_code: exitCode || null,
      hint: '未匹配内置 LAMMPS 错误模式。下一步：(1) lmp_doc_lookup query="<Last command 名>"；(2) web_search 该错误原文；(3) 用 cases/lammps-official/examples 找相同 style 真实样例对比',
      text_tail: t.slice(-800),
    }, null, 2);
  }
  return JSON.stringify({
    matched: real.length,
    error_line: errorLine || null,
    last_command: lastCmd || null,
    lammps_version: version || null,
    exit_code: exitCode || null,
    findings: real.map(h => ({ category: h.cat, likely_causes: h.causes, next_steps: h.steps })),
    // ====== D) 前端"一键修复"按钮用：把 steps 转成可点击 actions ======
    fix_actions: real.flatMap(h => (h.steps || []).slice(0, 5).map(s => ({
      category: h.cat,
      label: s.length > 80 ? s.slice(0, 78) + '…' : s,
      instruction: `请根据 LAMMPS 错误诊断，应用以下修复并重新运行：\n类别: ${h.cat}\n操作: ${s}\n（直接修改对应的 in.* 文件，然后用 lmp_run_probe 短跑验证，再 lmp_run_async 跑完整）`,
    }))),
    recommended_next_tool: real[0].cat === 'atom-style-no-bonds' ? 'lmp_validate_input（cross-check atom_style × data Bonds）'
                          : real[0].cat.startsWith('pair-') ? 'lmp_doc_lookup query="pair_<style>"'
                          : real[0].cat === 'reaxff-missing-element' ? 'lmp_find_potential pattern="<element>"'
                          : real[0].cat === 'lost-atoms' ? 'lmp_run_probe ensure_minimize=true（消重叠重跑）'
                          : 'read_file 看 in.* 上下文',
  }, null, 2);
}

// ---------- lmp_unit_convert ----------
// LAMMPS 八套 units（来自 doc/src/units.rst）：
const LMP_UNITS = {
  lj:       { length: 'σ',          energy: 'ε',         time: 'τ',        mass: 'm',         temperature: 'ε/kB',  pressure: 'ε/σ^3', force: 'ε/σ',         charge: '√(4πε0εσ)', density: 'm/σ^3' },
  real:     { length: 'Angstrom',   energy: 'kcal/mol',  time: 'fs',       mass: 'g/mol',     temperature: 'K',     pressure: 'atm',   force: 'kcal/mol/A',  charge: 'e',         density: 'g/cm^3' },
  metal:    { length: 'Angstrom',   energy: 'eV',        time: 'ps',       mass: 'g/mol',     temperature: 'K',     pressure: 'bar',   force: 'eV/A',        charge: 'e',         density: 'g/cm^3' },
  si:       { length: 'm',          energy: 'J',         time: 's',        mass: 'kg',        temperature: 'K',     pressure: 'Pa',    force: 'N',           charge: 'C',         density: 'kg/m^3' },
  cgs:      { length: 'cm',         energy: 'erg',       time: 's',        mass: 'g',         temperature: 'K',     pressure: 'dyne/cm^2', force: 'dyne',    charge: 'statcoul',  density: 'g/cm^3' },
  electron: { length: 'Bohr',       energy: 'Hartree',   time: 'fs',       mass: 'amu',       temperature: 'K',     pressure: 'Pa',    force: 'Hartree/Bohr',charge: 'e',         density: 'amu/Bohr^3' },
  micro:    { length: 'micrometer', energy: 'pg*um^2/us^2', time: 'us',    mass: 'pg',        temperature: 'K',     pressure: 'pg/(um*us^2)', force: 'pg*um/us^2', charge: 'pC',  density: 'pg/um^3' },
  nano:     { length: 'nm',         energy: 'attogram*nm^2/ns^2', time: 'ns', mass: 'attogram', temperature: 'K',   pressure: 'attogram/(nm*ns^2)', force: 'attogram*nm/ns^2', charge: 'e', density: 'attogram/nm^3' },
};
// 物理常数（SI）
const NA = 6.02214076e23;
const KB_J = 1.380649e-23;          // J/K
const KB_eV = 8.617333262e-5;       // eV/K
const KB_kcal = 1.987204259e-3;     // kcal/mol/K
const J_per_eV = 1.602176634e-19;
const J_per_kcalmol = 4184 / NA;
const J_per_kJmol = 1000 / NA;
const J_per_Hartree = 4.3597447222071e-18;
const A_per_Bohr = 0.529177210903;
// SI 基准换算：把任意输入值先转成 SI（m / J / K / s / Pa / kg / N / C / kg·m^-3 / m^-3）
function _toSI(value, unit, kind) {
  const u = String(unit || '').trim();
  if (kind === 'length') {
    const map = { m: 1, cm: 1e-2, mm: 1e-3, um: 1e-6, micrometer: 1e-6, μm: 1e-6, nm: 1e-9, A: 1e-10, Å: 1e-10, angstrom: 1e-10, pm: 1e-12, Bohr: A_per_Bohr * 1e-10, bohr: A_per_Bohr * 1e-10, au: A_per_Bohr * 1e-10 };
    if (!(u in map)) throw new Error(`未知长度单位：${u}`);
    return value * map[u];
  }
  if (kind === 'energy') {
    if (u === 'J') return value;
    if (u === 'eV') return value * J_per_eV;
    if (u === 'meV') return value * J_per_eV * 1e-3;
    if (/^kcal\/mol$/i.test(u)) return value * J_per_kcalmol;
    if (/^kJ\/mol$/i.test(u)) return value * J_per_kJmol;
    if (u === 'Hartree' || u === 'Ha') return value * J_per_Hartree;
    if (u === 'Ry' || u === 'Rydberg') return value * J_per_Hartree / 2;
    if (u === 'erg') return value * 1e-7;
    if (u === 'K') return value * KB_J; // 温度当能量（kB·T）
    throw new Error(`未知能量单位：${u}`);
  }
  if (kind === 'temperature') {
    if (u === 'K') return value;
    if (u === 'eV') return value / KB_eV;
    if (/^kcal\/mol$/i.test(u)) return value / KB_kcal;
    throw new Error(`未知温度单位：${u}`);
  }
  if (kind === 'time') {
    const map = { s: 1, ms: 1e-3, us: 1e-6, μs: 1e-6, ns: 1e-9, ps: 1e-12, fs: 1e-15 };
    if (!(u in map)) throw new Error(`未知时间单位：${u}`);
    return value * map[u];
  }
  if (kind === 'pressure') {
    const map = { Pa: 1, kPa: 1e3, MPa: 1e6, GPa: 1e9, bar: 1e5, kbar: 1e8, atm: 101325, Torr: 133.322, psi: 6894.76 };
    if (!(u in map)) throw new Error(`未知压力单位：${u}`);
    return value * map[u];
  }
  if (kind === 'mass') {
    if (u === 'kg') return value;
    if (u === 'g') return value * 1e-3;
    if (u === 'amu' || u === 'u' || /^g\/mol$/i.test(u)) return value / NA * 1e-3; // 单粒子质量
    throw new Error(`未知质量单位：${u}`);
  }
  if (kind === 'force') {
    if (u === 'N') return value;
    if (u === 'dyne') return value * 1e-5;
    if (/^eV\/A$/i.test(u) || u === 'eV/Å') return value * J_per_eV / 1e-10;
    if (/^kcal\/mol\/A$/i.test(u)) return value * J_per_kcalmol / 1e-10;
    if (/^Hartree\/Bohr$/i.test(u)) return value * J_per_Hartree / (A_per_Bohr * 1e-10);
    throw new Error(`未知力单位：${u}`);
  }
  if (kind === 'density') {
    if (/^g\/cm\^?3$/i.test(u)) return value * 1e3;             // → kg/m^3
    if (/^kg\/m\^?3$/i.test(u)) return value;
    if (/^amu\/A\^?3$/i.test(u)) return value * 1e-3 / NA * 1e30;
    throw new Error(`未知密度单位：${u}`);
  }
  if (kind === 'number_density') {
    if (/^1\/m\^?3$|^m\^?-?3$/i.test(u)) return value;
    if (/^1\/cm\^?3$|^cm\^?-?3$/i.test(u)) return value * 1e6;
    if (/^1\/A\^?3$|^A\^?-?3$/i.test(u)) return value * 1e30;
    if (/^1\/nm\^?3$|^nm\^?-?3$/i.test(u)) return value * 1e27;
    throw new Error(`未知数密度单位：${u}`);
  }
  if (kind === 'charge') {
    if (u === 'C') return value;
    if (u === 'e') return value * 1.602176634e-19;
    throw new Error(`未知电荷单位：${u}`);
  }
  throw new Error(`未知 kind：${kind}`);
}
// 从 SI 转到目标 units 的“数值”
function _fromSI(siValue, toUnits, kind) {
  const U = LMP_UNITS[toUnits];
  if (!U) throw new Error(`未知 units：${toUnits}`);
  if (kind === 'length') {
    const inv = { real: 1e-10, metal: 1e-10, si: 1, cgs: 1e-2, electron: A_per_Bohr * 1e-10, micro: 1e-6, nano: 1e-9 };
    if (!(toUnits in inv)) throw new Error(`lj/length 无量纲：请提供 σ`); return siValue / inv[toUnits];
  }
  if (kind === 'energy') {
    if (toUnits === 'real')     return siValue / J_per_kcalmol;
    if (toUnits === 'metal')    return siValue / J_per_eV;
    if (toUnits === 'si')       return siValue;
    if (toUnits === 'cgs')      return siValue / 1e-7;
    if (toUnits === 'electron') return siValue / J_per_Hartree;
    throw new Error(`暂不支持 ${toUnits} 能量自动反演`);
  }
  if (kind === 'temperature') return siValue;          // 所有 units 温度都用 K
  if (kind === 'time') {
    const inv = { real: 1e-15, metal: 1e-12, si: 1, cgs: 1, electron: 1e-15, micro: 1e-6, nano: 1e-9 };
    return siValue / inv[toUnits];
  }
  if (kind === 'pressure') {
    const inv = { real: 101325, metal: 1e5, si: 1, cgs: 0.1, electron: 1 };
    if (!(toUnits in inv)) throw new Error(`暂不支持 ${toUnits} 压力反演`);
    return siValue / inv[toUnits];
  }
  if (kind === 'mass') {
    if (toUnits === 'real' || toUnits === 'metal') return siValue * NA * 1e3; // 单粒子 kg → g/mol
    if (toUnits === 'si')   return siValue;
    if (toUnits === 'cgs')  return siValue * 1e3;
    if (toUnits === 'electron') return siValue * NA * 1e3;                    // amu == g/mol 数值同
    throw new Error(`暂不支持 ${toUnits} 质量反演`);
  }
  if (kind === 'density') {
    if (toUnits === 'real' || toUnits === 'metal') return siValue / 1e3;      // g/cm^3
    if (toUnits === 'si') return siValue;
    if (toUnits === 'cgs') return siValue / 1e3;
    throw new Error(`暂不支持 ${toUnits} 密度反演`);
  }
  if (kind === 'force') {
    if (toUnits === 'real') return siValue * 1e-10 / J_per_kcalmol;
    if (toUnits === 'metal') return siValue * 1e-10 / J_per_eV;
    if (toUnits === 'si') return siValue;
    throw new Error(`暂不支持 ${toUnits} 力反演`);
  }
  if (kind === 'charge') {
    if (toUnits === 'real' || toUnits === 'metal' || toUnits === 'electron' || toUnits === 'nano') return siValue / 1.602176634e-19;
    if (toUnits === 'si') return siValue;
    throw new Error(`暂不支持 ${toUnits} 电荷反演`);
  }
  throw new Error(`未知 kind：${kind}`);
}
function _fmt(v) {
  if (!Number.isFinite(v)) return String(v);
  if (Math.abs(v) >= 1e6 || (Math.abs(v) < 1e-3 && v !== 0)) return v.toExponential(6);
  return +v.toPrecision(8);
}
function lmpUnitConvert({ to_units, items, derive }) {
  if (!LMP_UNITS[to_units]) return JSON.stringify({ error: `未知 to_units=${to_units}`, valid: Object.keys(LMP_UNITS) });
  const out = { to_units, target_table: LMP_UNITS[to_units], converted: [], warnings: [] };
  for (const it of (items || [])) {
    try {
      const isArr = Array.isArray(it.value);
      const vals = (isArr ? it.value : [it.value]).map(v => {
        const si = _toSI(v, it.unit, it.kind);
        return _fromSI(si, to_units, it.kind);
      });
      const native = LMP_UNITS[to_units][it.kind] || '?';
      out.converted.push({ name: it.name, kind: it.kind, input: { value: it.value, unit: it.unit }, output: { value: isArr ? vals.map(_fmt) : _fmt(vals[0]), unit: native } });
      // 合理性检查
      if (it.kind === 'time' && to_units === 'real' && (vals[0] < 0.1 || vals[0] > 5)) out.warnings.push(`dt=${_fmt(vals[0])} fs（real）通常 0.25-2 fs；过大易爆炸，过小浪费`);
      if (it.kind === 'time' && to_units === 'metal' && (vals[0] < 0.0001 || vals[0] > 0.01)) out.warnings.push(`dt=${_fmt(vals[0])} ps（metal）通常 0.0001-0.005 ps`);
      if (it.kind === 'temperature' && (vals[0] < 0)) out.warnings.push(`温度 <0 K 物理不可能`);
      if (it.kind === 'density' && to_units !== 'lj' && (vals[0] <= 0 || vals[0] > 25)) out.warnings.push(`density=${_fmt(vals[0])} ${LMP_UNITS[to_units].density}（异常，金属一般 1-23 g/cm^3，有机分子 0.5-1.5）`);
    } catch (e) { out.converted.push({ name: it.name, error: e.message }); }
  }
  // 派生：粒子数 N、盒子尺寸 L
  if (derive && derive.n_from) {
    try {
      const d = derive.n_from;
      const rho_SI = _toSI(d.density, d.unit_d || 'g/cm^3', 'density');
      const lens = (d.box || []).map(L => _toSI(L, d.unit_l || 'A', 'length'));
      const V = lens.reduce((a, b) => a * b, 1);
      const m_per_mol_kg = (d.molar_mass) * 1e-3;
      const N = rho_SI * V * NA / m_per_mol_kg;
      out.derived = { n_particles: Math.round(N), formula: 'N = ρ·V·NA / M', rho_SI, V_m3: V, molar_mass: d.molar_mass };
      if (N > 1e7) out.warnings.push(`N≈${N.toExponential(2)} 太大，建议缩小盒子或换更稀的密度`);
      if (N < 50) out.warnings.push(`N=${Math.round(N)} 太少，体相性质统计噪声大`);
    } catch (e) { out.derived = { error: e.message }; }
  }
  if (derive && derive.box_from) {
    try {
      const d = derive.box_from;
      const rho_SI = _toSI(d.density, d.unit_d || 'g/cm^3', 'density');
      const m_per_mol_kg = (d.molar_mass) * 1e-3;
      const V_m3 = d.n * m_per_mol_kg / (NA * rho_SI);
      const L_m = Math.cbrt(V_m3);
      const L_target = _fromSI(L_m, to_units, 'length');
      out.derived = { box_cubic_length: _fmt(L_target), unit: LMP_UNITS[to_units].length, formula: 'L = (N·M/(NA·ρ))^(1/3)', V_m3 };
    } catch (e) { out.derived = { error: e.message }; }
  }
  out.notes = [
    `units ${to_units} 下：length=${LMP_UNITS[to_units].length}, energy=${LMP_UNITS[to_units].energy}, time=${LMP_UNITS[to_units].time}, mass=${LMP_UNITS[to_units].mass}, pressure=${LMP_UNITS[to_units].pressure}`,
    `下一步：把 output[].value 直接写进 in.* 脚本；mass=g/mol 是“摩尔质量”，不是单粒子 SI 质量。`,
  ];
  return JSON.stringify(out, null, 2);
}


// ============================================================================
//  lmp_lint —— 零成本静态检查（不调 LAMMPS）
//  规则编号 L01..L12；每条返回 {rule, line?, severity, msg, fix?}
// ============================================================================
const VALID_UNITS = new Set(['lj','real','metal','si','cgs','electron','micro','nano']);
const ATOM_STYLES_NEED_BONDS = ['full','molecular','bond','angle','template','hybrid'];
const ATOM_STYLES_NEED_CHARGE = ['charge','full','dipole','electron','peri','sphere/charge'];
// pair_style → 需要的 atom_style 关键字（粗判，只列硬约束）
const PAIR_STYLE_NEEDS = {
  'reax/c': { atom_style: 'charge', units: 'real',  qeq_required: true },
  'reaxff': { atom_style: 'charge', units: 'real',  qeq_required: true },
  'eam':    { units: 'metal' },
  'eam/alloy': { units: 'metal' },
  'eam/fs': { units: 'metal' },
  'tersoff': { units: 'metal' },
  'sw':     { units: 'metal' },
  'airebo': { units: 'metal' },
  'rebo':   { units: 'metal' },
  'meam':   { units: 'metal' },
};

function _findLine(lines, regex) {
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) return i + 1;
  }
  return null;
}

async function lmpLint({ case_path, script }, ctx) {
  const cp = abs(ctx, case_path);
  if (!fs.existsSync(cp)) return JSON.stringify({ ok: false, errors: [{ rule: 'L00', msg: `case 不存在：${cp}` }] });
  let scriptName = script;
  if (!scriptName) {
    const entries = (await fs.promises.readdir(cp)).filter(f => f.startsWith('in.'));
    if (!entries.length) return JSON.stringify({ ok: false, errors: [{ rule: 'L00', msg: `未找到 in.* 脚本` }] });
    scriptName = entries[0];
  }
  const inPath = path.join(cp, scriptName);
  if (!fs.existsSync(inPath)) return JSON.stringify({ ok: false, errors: [{ rule: 'L00', msg: `in.* 不存在：${inPath}` }] });
  const txt = fs.readFileSync(inPath, 'utf8');
  // 去注释（# 之后），保留行号
  const lines = txt.split(/\r?\n/);
  const stripped = lines.map(l => l.replace(/#.*$/, '').trim());

  const errors = [];
  const warnings = [];

  // ---- 解析关键指令的行号与值 ----
  const grab = (re) => {
    for (let i = 0; i < stripped.length; i++) {
      const m = stripped[i].match(re);
      if (m) return { line: i + 1, match: m };
    }
    return null;
  };
  const grabAll = (re) => {
    const out = [];
    for (let i = 0; i < stripped.length; i++) {
      const m = stripped[i].match(re);
      if (m) out.push({ line: i + 1, match: m });
    }
    return out;
  };

  const unitsRec     = grab(/^units\s+(\S+)/i);
  const atomStyleRec = grab(/^atom_style\s+(\S+)/i);
  const boundaryRec  = grab(/^boundary\s+(\S+)\s+(\S+)\s+(\S+)/i);
  const pairStyleRec = grab(/^pair_style\s+(\S+)/i);
  const pairCoeffs   = grabAll(/^pair_coeff\s+(.+)$/i);
  const readDataRec  = grab(/^read_data\s+(\S+)/i);
  const masses       = grabAll(/^mass\s+(\S+)\s+(\S+)/i);
  const timestepRec  = grab(/^timestep\s+(\S+)/i);
  const runRecs      = grabAll(/^run\s+(\d+)/i);
  const fixRecs      = grabAll(/^fix\s+\S+\s+\S+\s+(\S+)/i);
  const createBoxRec = grab(/^create_box\s+(\d+)/i);
  const latticeRec   = grab(/^lattice\s+(\S+)/i);
  const velocityRec  = grab(/^velocity\s+/i);
  const minimizeRec  = grab(/^minimize\b/i);

  const units = unitsRec ? unitsRec.match[1].toLowerCase() : null;
  const atomStyle = atomStyleRec ? atomStyleRec.match[1].toLowerCase() : null;
  const pairStyle = pairStyleRec ? pairStyleRec.match[1].toLowerCase() : null;

  // ---- L01: units 缺失或值非法 ----
  if (!unitsRec) {
    errors.push({ rule: 'L01', severity: 'error', msg: '缺 `units` 指令', fix: '在最前面加 `units metal`（金属/EAM/Tersoff）或 `units real`（ReaxFF/有机分子）或 `units lj`（教学）' });
  } else if (!VALID_UNITS.has(units)) {
    errors.push({ rule: 'L01', line: unitsRec.line, severity: 'error', msg: `units 值非法: ${units}`, fix: `合法值: ${[...VALID_UNITS].join(' / ')}` });
  }

  // ---- L02: atom_style 缺失 ----
  if (!atomStyleRec) {
    errors.push({ rule: 'L02', severity: 'error', msg: '缺 `atom_style` 指令', fix: '常用：`atom_style atomic`（金属/LJ）/ `charge`（ReaxFF）/ `full`（有机分子带键）' });
  }

  // ---- L03: boundary 缺失（默认 p p p，警告级别）----
  if (!boundaryRec) {
    warnings.push({ rule: 'L03', severity: 'warning', msg: '未显式设 `boundary`，LAMMPS 默认 p p p；若是表面/2D 可能要 p p f 或 s s s', fix: '在 read_data/create_box 前加 `boundary p p p` 或对应方向' });
  }

  // ---- L04: pair_coeff 必须出现在 pair_style 之后 ----
  if (pairStyleRec && pairCoeffs.length) {
    const bad = pairCoeffs.filter(pc => pc.line < pairStyleRec.line);
    if (bad.length) {
      errors.push({ rule: 'L04', line: bad[0].line, severity: 'error', msg: `pair_coeff (行 ${bad[0].line}) 出现在 pair_style (行 ${pairStyleRec.line}) 之前`, fix: '把 pair_coeff 移到 pair_style 之后' });
    }
  } else if (pairCoeffs.length && !pairStyleRec) {
    errors.push({ rule: 'L04', line: pairCoeffs[0].line, severity: 'error', msg: '有 pair_coeff 但缺 pair_style', fix: '在 pair_coeff 之前加 `pair_style ...`' });
  }

  // ---- L05/L08: pair_style 与 atom_style / units 兼容 ----
  if (pairStyle) {
    const key = Object.keys(PAIR_STYLE_NEEDS).find(k => pairStyle.startsWith(k));
    if (key) {
      const need = PAIR_STYLE_NEEDS[key];
      if (need.units && units && units !== need.units) {
        errors.push({ rule: 'L08', line: pairStyleRec.line, severity: 'error',
          msg: `pair_style ${pairStyle} 通常用 units ${need.units}，但当前 units ${units}`,
          fix: `改 \`units ${need.units}\`，并把 timestep / 温度等数值按新 units 换算（用 lmp_unit_convert）` });
      }
      if (need.atom_style && atomStyle && !atomStyle.startsWith(need.atom_style)) {
        errors.push({ rule: 'L05', line: atomStyleRec.line, severity: 'error',
          msg: `pair_style ${pairStyle} 要求 atom_style 含 ${need.atom_style}（当前 ${atomStyle}）`,
          fix: `改 \`atom_style ${need.atom_style}\`；data 文件原子行需含 q 列` });
      }
      if (need.qeq_required) {
        const hasQeq = stripped.some(l => /^fix\s+\S+\s+\S+\s+qeq\/reax/i.test(l));
        if (!hasQeq) {
          errors.push({ rule: 'L12', line: pairStyleRec.line, severity: 'error',
            msg: 'ReaxFF 必须配 `fix ... all qeq/reax(ff) ...` 做电荷平衡，缺失会算崩',
            fix: '加 `fix qeq all qeq/reax 1 0.0 10.0 1.0e-6 reax/c`' });
        }
      }
    }
  }

  // ---- L06: pair_coeff 引用的势文件存在性 ----
  for (const pc of pairCoeffs) {
    const parts = pc.match[1].trim().split(/\s+/);
    // 形如: * * <potfile> [elements...]   或   1 1 <potfile> ...
    // 第 3 个 token 起，凡是看起来像文件名（含点 + 字母）且非纯数字的，认为是势文件路径
    for (let i = 2; i < parts.length; i++) {
      const tok = parts[i];
      if (/^[\d\.\-eE+]+$/.test(tok)) continue;            // 数字（如 cutoff）
      if (/^[A-Z][a-z]?$/.test(tok)) continue;             // 元素符号 Cu/Si/Al
      if (tok === 'NULL') continue;
      if (/[\/\\]|\.(eam|tersoff|sw|airebo|rebo|meam|reax|adp|sf|alloy|fs|spline|table|library|usc|comb|edip|tabulated)/i.test(tok)) {
        const potAbs = path.isAbsolute(tok) ? tok : path.join(cp, tok);
        if (!fs.existsSync(potAbs)) {
          // 再去 bundled potentials 找
          let bundled = null;
          if (BUNDLED_LAMMPS_ROOT) {
            const cand = path.join(BUNDLED_LAMMPS_ROOT, 'potentials', path.basename(tok));
            if (fs.existsSync(cand)) bundled = cand;
          }
          if (bundled) {
            warnings.push({ rule: 'L06', line: pc.line, severity: 'warning',
              msg: `势文件 "${tok}" 不在 case 目录，但 bundle 有 ${bundled}`,
              fix: `复制：\`copy "${bundled}" "${cp}\\${path.basename(tok)}"\` 或在 pair_coeff 中写绝对路径` });
          } else {
            errors.push({ rule: 'L06', line: pc.line, severity: 'error',
              msg: `势文件不存在：${tok}（找过 ${potAbs} 和 bundle/potentials/）`,
              fix: '调 lmp_find_potential pattern="<element>" 找替代' });
          }
        }
        break;  // 只检查第一个看起来像文件的 token
      }
    }
  }

  // ---- L07: read_data 文件存在 ----
  let dataAbs = null;
  let dataAtomTypes = null;
  if (readDataRec) {
    const dataFile = readDataRec.match[1];
    dataAbs = path.isAbsolute(dataFile) ? dataFile : path.join(cp, dataFile);
    if (!fs.existsSync(dataAbs)) {
      errors.push({ rule: 'L07', line: readDataRec.line, severity: 'error',
        msg: `read_data 指向的文件不存在：${dataFile} → ${dataAbs}`,
        fix: '检查路径拼写；或用 lmp_build_data_file / packmol 先生成' });
    } else {
      try {
        const dataTxt = fs.readFileSync(dataAbs, 'utf8');
        const atomTypesM = dataTxt.match(/^\s*(\d+)\s+atom\s+types\s*$/im);
        if (atomTypesM) dataAtomTypes = parseInt(atomTypesM[1], 10);
        // ---- L11: atom_style 与 bonds 段 ----
        const declaredBonds = parseInt((dataTxt.match(/^\s*(\d+)\s+bonds\s*$/im) || [0, '0'])[1], 10);
        const hasBondsSec = /^\s*Bonds\s*$/im.test(dataTxt);
        if (atomStyle) {
          const needBonds = ATOM_STYLES_NEED_BONDS.some(s => atomStyle.startsWith(s));
          if ((declaredBonds > 0 || hasBondsSec) && !needBonds) {
            errors.push({ rule: 'L11', line: atomStyleRec.line, severity: 'error',
              msg: `atom_style ${atomStyle} 不支持 bonds，但 ${path.basename(dataAbs)} 有 ${declaredBonds} bonds`,
              fix: 'A) ReaxFF：删 data 的 Bonds 段和 "N bonds" 计数 → ReaxFF 动态成键；B) 普通力场：改 atom_style full 或 molecular' });
          }
        }
      } catch { /* ignore */ }
    }
  }

  // ---- L05b: pair_coeff 末尾元素列 ↔ data atom types ↔ mass 行数 ----
  const wildCoeff = pairCoeffs.find(pc => /^\s*\*\s+\*\s+/.test(pc.match[1]));
  if (wildCoeff) {
    const parts = wildCoeff.match[1].split(/\s+/).filter(Boolean);
    // [* * file E1 E2 ...]
    const elemList = parts.slice(3).filter(t => /^[A-Z][a-z]?$|^NULL$/.test(t));
    if (elemList.length && masses.length && elemList.length !== masses.length) {
      errors.push({ rule: 'L05b', line: wildCoeff.line, severity: 'error',
        msg: `pair_coeff 末尾元素列(${elemList.length}: ${elemList.join(',')}) ≠ mass 行数(${masses.length})`,
        fix: '元素列必须严格按 atom type 1/2/... 顺序，不在体系里的位置写 NULL' });
    }
    if (elemList.length && dataAtomTypes && elemList.length !== dataAtomTypes) {
      errors.push({ rule: 'L05c', line: wildCoeff.line, severity: 'error',
        msg: `pair_coeff 末尾元素列(${elemList.length}) ≠ data 文件 atom types(${dataAtomTypes})`,
        fix: '改元素列与 data atom types 数对齐' });
    }
  }

  // ---- L09: run > 0 必须有 fix（thermostat/integrator）----
  if (runRecs.length && runRecs.some(r => +r.match[1] > 0)) {
    const integrators = ['nve','nvt','npt','nph','langevin','rigid','rigid/nve','rigid/nvt','rigid/npt','viscous'];
    const hasIntegrator = fixRecs.some(f => integrators.some(g => f.match[1].toLowerCase().startsWith(g)));
    if (!hasIntegrator && !minimizeRec) {
      errors.push({ rule: 'L09', severity: 'error',
        msg: 'run > 0 但没有 fix nve/nvt/npt/langevin 之类的积分器/控温',
        fix: '加 `fix 1 all nvt temp 300 300 0.1` 或对应系综' });
    }
  }

  // ---- L10: timestep 缺失（warning）----
  if (runRecs.length && !timestepRec) {
    const unitDefault = { metal: '0.001 ps (1 fs)', real: '1.0 fs', lj: '0.005', si: '1e-8 s' }[units || 'metal'];
    warnings.push({ rule: 'L10', severity: 'warning',
      msg: `未设 timestep，LAMMPS 默认值很可能不合适（units ${units || '?'} 推荐 ${unitDefault}）`,
      fix: `加 \`timestep ${ {metal:0.001, real:1.0, lj:0.005, si:1e-8}[units] ?? 0.001 }\`` });
  }

  // ---- L02b: atom_style charge|full 但 data 缺 q 列 ----
  if (atomStyle && dataAbs && fs.existsSync(dataAbs)) {
    const needCharge = ATOM_STYLES_NEED_CHARGE.some(s => atomStyle.startsWith(s));
    if (needCharge) {
      try {
        const dataTxt = fs.readFileSync(dataAbs, 'utf8');
        // Atoms 段第一个非空行的列数
        const atomsIdx = dataTxt.search(/^\s*Atoms[^\n]*\n/im);
        if (atomsIdx >= 0) {
          const rest = dataTxt.slice(atomsIdx).split('\n').slice(1);
          const firstRow = rest.find(l => l.trim() && !l.trim().startsWith('#'));
          if (firstRow) {
            const cols = firstRow.trim().split(/\s+/).length;
            // atomic=5, charge=6, full=7（id, mol, type, q, x, y, z）
            const minCols = atomStyle.startsWith('full') ? 7 : 6;
            if (cols < minCols) {
              errors.push({ rule: 'L02b', severity: 'error',
                msg: `atom_style ${atomStyle} 要求 data 文件 Atoms 段每行 ≥ ${minCols} 列（含 q 列），但实测 ${cols} 列`,
                fix: '在 Atoms 段每行加电荷列；或把 atom_style 改成不需电荷的 (如 atomic)' });
            }
          }
        }
      } catch { /* ignore */ }
    }
  }

  // ---- L13: 驱动流（限域/通道流）控温陷阱 ----
  // 现象：有 addforce/aveforce 驱动 或 velocity ... set 推墙（Couette），却把 nvt/langevin/temp/rescale
  //       直接挂在 all 上、又没有 compute temp 偏置修正 + fix_modify/thermo_modify temp。
  //       后果：控温器把流向流速当“热”给抽掉 → 流动被阻尼、温度读数虚高，结果静悄悄地错。
  {
    const hasDrive = stripped.some(l => /^fix\s+\S+\s+\S+\s+(add|ave)force\b/i.test(l))
      || stripped.some(l => /^velocity\s+\S+\s+set\b/i.test(l));
    const thermoFixes = grabAll(/^fix\s+\S+\s+(\S+)\s+(nvt|langevin|temp\/rescale|temp\/berendsen|temp\/csvr)\b/i);
    const hasBiasCompute = stripped.some(l => /^compute\s+\S+\s+\S+\s+temp\/(profile|deform|partial)\b/i.test(l));
    const hasFixModifyTemp = stripped.some(l => /^fix_modify\s+\S+\s+temp\s+\S+/i.test(l));
    if (hasDrive && thermoFixes.length) {
      const onAll = thermoFixes.filter(f => /^all$/i.test(f.match[1]));
      if (!hasBiasCompute && !hasFixModifyTemp) {
        warnings.push({ rule: 'L13', line: thermoFixes[0].line, severity: 'warning',
          msg: '检测到驱动流(addforce/aveforce/velocity set)，但控温器没有去流速偏置：缺 compute temp/profile(或 temp/partial) + fix_modify/thermo_modify temp，会把流向流速当热抽掉、阻尼流动且温度读数虚高',
          fix: '① 控温只挂流体组(group flow)别挂 all；② 加 `compute mobile flow temp`（或 temp/profile）；③ `fix_modify <控温fix> temp mobile` 和 `thermo_modify temp mobile`。参考模板 confined_flow_poiseuille' });
      } else if (onAll.length && !hasBiasCompute) {
        warnings.push({ rule: 'L13', line: onAll[0].line, severity: 'warning',
          msg: '驱动流里把控温器挂在了 all（含壁面）上：壁面也会被加热/扰动，且通常该只控流体组',
          fix: '把控温 fix 的作用组从 all 改成流体组（如 group flow = all 减去壁面）' });
      }
    }
  }

  // ---- 领域硬规则（训练模式晋升而来，按当前激活领域注入）----
  // ctx.domainLintRules: [{ id, name, kind:'forbid'|'require', pattern, msg, fix, severity }]
  if (Array.isArray(ctx && ctx.domainLintRules)) {
    const joined = stripped.join('\n');
    for (const r of ctx.domainLintRules) {
      if (!r || !r.pattern) continue;
      let re;
      try { re = new RegExp(r.pattern, 'im'); } catch { continue; }
      const present = re.test(joined);
      const violated = r.kind === 'require' ? !present : present;
      if (!violated) continue;
      const item = { rule: r.id || 'DOM', domain: true, severity: r.severity === 'warning' ? 'warning' : 'error',
        msg: `[领域规则] ${r.msg || r.name || '违反领域约束'}`, fix: r.fix || '' };
      (item.severity === 'warning' ? warnings : errors).push(item);
    }
  }

  // ---- 汇总 ----
  const ok = errors.length === 0;
  const summary = ok
    ? `✓ 静态检查通过（${warnings.length} 警告）。下一步：lmp_run_probe probe_steps=200。`
    : `✗ ${errors.length} 错误 / ${warnings.length} 警告。先按 fix 字段修，再 lmp_lint 复查，通过后再 lmp_run_probe。`;
  return JSON.stringify({ ok, script: scriptName, errors, warnings, summary }, null, 2);
}


// ============================================================================
//  lmp_template_search / lmp_template_get —— 模板库
// ============================================================================
function _templatesDir() {
  const cand = [
    path.join(_MODULE_DIR, 'cases', 'templates'),
    path.join(process.cwd(), 'cases', 'templates'),
    path.join(_MODULE_DIR, '..', 'cases', 'templates'),
  ];
  for (const c of cand) if (fs.existsSync(path.join(c, 'index.json'))) return c;
  return null;
}
function _loadTemplateIndex() {
  const dir = _templatesDir();
  if (!dir) return null;
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    return { dir, idx };
  } catch (e) { return null; }
}
async function lmpTemplateSearch({ query, top_k = 3 }) {
  const loaded = _loadTemplateIndex();
  if (!loaded) return `[err] 模板库未找到（应在 cases/templates/index.json）`;
  const q = String(query || '').toLowerCase();
  const tokens = q.split(/[\s,，、+/]+/).filter(Boolean);
  const scored = loaded.idx.map(t => {
    const hay = [t.name, t.desc, ...(t.tags || []), t.units, t.atom_style, t.potential || ''].join(' ').toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      if (!tok) continue;
      if (hay.includes(tok)) score += 2;
      if ((t.tags || []).some(tg => tg.toLowerCase() === tok)) score += 3;
    }
    return { ...t, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.filter(s => s.score > 0).slice(0, top_k);
  if (!hits.length) {
    return JSON.stringify({
      ok: true, query, matches: [],
      hint: '没有匹配模板。可用模板：' + loaded.idx.map(t => `${t.id}(${t.tags.slice(0, 4).join('/')})`).join('; ')
    }, null, 2);
  }
  return JSON.stringify({
    ok: true, query, matches: hits.map(h => ({
      id: h.id, name: h.name, tags: h.tags, units: h.units, atom_style: h.atom_style,
      potential: h.potential, potential_bundled: h.potential_bundled, desc: h.desc, score: h.score
    })),
    next: '调 lmp_template_get id="<id>" 取完整 in.* 文本'
  }, null, 2);
}
async function lmpTemplateGet({ id }) {
  const loaded = _loadTemplateIndex();
  if (!loaded) return `[err] 模板库未找到`;
  const meta = loaded.idx.find(t => t.id === id);
  if (!meta) return `[err] 未找到模板 id=${id}；可用：${loaded.idx.map(t => t.id).join(', ')}`;
  const filePath = path.join(loaded.dir, meta.file);
  if (!fs.existsSync(filePath)) return `[err] 模板文件丢失：${filePath}`;
  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.stringify({ ok: true, id: meta.id, meta, content }, null, 2);
}


// ============================================================================
//  后处理：lmp_post_msd / lmp_post_rdf / lmp_dump_convert / lmp_post_all
// ============================================================================
async function _runPyHelper(helperName, scriptArgs, cwd, ctx) {
  const helperPath = resolveHelper(helperName);
  if (!helperPath) return { code: -1, out: '', err: `[err] 找不到 helpers/${helperName}` };
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  // 优先用户选中的解释器（ctx.pythonPath），再回退 python / python3
  let last = { code: -1, out: '[err] 没有可用的 python 解释器' };
  for (const py of _pyCandidates(ctx)) {
    last = await runCmd(py, [helperPath, ...scriptArgs], { cwd, timeout: 180000, env });
    if (last.code === 0) return { code: 0, out: last.out };
  }
  return { code: last.code, out: last.out };
}

async function lmpPostMsd({ case_path, dump_file, dt_ps, types, save_as = 'msd.png' }, ctx) {
  const cp = abs(ctx, case_path);
  const dump = path.isAbsolute(dump_file) ? dump_file : path.join(cp, dump_file);
  if (!fs.existsSync(dump)) return `[err] dump 不存在：${dump}`;
  const outImg = path.join(cp, save_as);
  const args = [dump, '--out', outImg];
  if (dt_ps != null) { args.push('--dt-ps', String(dt_ps)); }
  if (types && types.length) { args.push('--types', ...types.map(String)); }
  const { code, out } = await _runPyHelper('lmp_post_msd.py', args, cp, ctx);
  if (code !== 0) return `[err] MSD 计算失败 (exit ${code})\n${out.slice(-1200)}`;
  // 推图
  if (fs.existsSync(outImg) && ctx.pushImage) ctx.pushImage(outImg, 'MSD + 扩散系数 D');
  // 仅返回 D + 摘要，避免 token 爆
  try {
    const r = JSON.parse(out);
    const compact = {
      ok: r.ok, unwrap_mode: r.unwrap_mode, n_frames: r.n_frames, n_atoms_tracked: r.n_atoms_tracked,
      types_tracked: r.types_tracked, fit_window: r.fit_window,
      D_A2_per_ps: r.D_A2_per_ps, D_m2_per_s: r.D_m2_per_s, slope_A2_per_ps: r.slope_A2_per_ps,
      note: r.note, plot: r.plot,
      msd_first_3: (r.msd || []).slice(0, 3), msd_last_3: (r.msd || []).slice(-3),
    };
    return JSON.stringify(compact, null, 2);
  } catch { return out.slice(0, 4000); }
}

async function lmpPostRdf({ case_path, dump_file, rmax, bins = 200, types, last_frames = 5, save_as = 'rdf.png' }, ctx) {
  const cp = abs(ctx, case_path);
  const dump = path.isAbsolute(dump_file) ? dump_file : path.join(cp, dump_file);
  if (!fs.existsSync(dump)) return `[err] dump 不存在：${dump}`;
  const outImg = path.join(cp, save_as);
  const args = [dump, '--bins', String(bins), '--last-frames', String(last_frames), '--out', outImg];
  if (rmax != null) { args.push('--rmax', String(rmax)); }
  if (types && types.length === 2) { args.push('--types', String(types[0]), String(types[1])); }
  const { code, out } = await _runPyHelper('lmp_post_rdf.py', args, cp, ctx);
  if (code !== 0) return `[err] RDF 计算失败 (exit ${code})\n${out.slice(-1200)}`;
  if (fs.existsSync(outImg) && ctx.pushImage) ctx.pushImage(outImg, 'RDF g(r)');
  try {
    const r = JSON.parse(out);
    // 抽稀
    const ridx = r.r || []; const gidx = r.g_r || [];
    const sampleN = 30;
    const step = Math.max(1, Math.floor(ridx.length / sampleN));
    const compact = {
      ok: r.ok, n_frames_used: r.n_frames_used, box: r.box, rho_avg: r.rho_avg,
      rmax: r.rmax, bins: r.bins, types_pair: r.types_pair, first_peak: r.first_peak,
      r_sample: ridx.filter((_, i) => i % step === 0),
      g_sample: gidx.filter((_, i) => i % step === 0),
      plot: r.plot,
    };
    return JSON.stringify(compact, null, 2);
  } catch { return out.slice(0, 4000); }
}

async function lmpDumpConvert({ case_path, dump_file, out_name }, ctx) {
  const cp = abs(ctx, case_path);
  const dump = path.isAbsolute(dump_file) ? dump_file : path.join(cp, dump_file);
  if (!fs.existsSync(dump)) return `[err] dump 不存在：${dump}`;
  const outRel = out_name || (path.basename(dump_file).replace(/\.(lammpstrj|dump|atom|custom)$/i, '') + '.xyz');
  const outAbs = path.join(cp, outRel);
  const { code, out } = await _runPyHelper('lmp_dump_xyz.py', ['--dump', dump, '--out', outAbs], cp, ctx);
  if (code !== 0) return `[err] 转换失败 (exit ${code})\n${out.slice(-1200)}`;
  let frames = 0;
  try {
    const txt = fs.readFileSync(outAbs, 'utf8');
    frames = (txt.match(/^\s*\d+\s*$/gm) || []).length;            // 粗略
  } catch { /* ignore */ }
  return JSON.stringify({ ok: true, out: path.relative(ctx.WORKSPACE || cp, outAbs), frames_estimate: frames, note: '可拖到 NGL/VMD/OVITO 直接看' }, null, 2);
}

async function lmpPostAll({ case_path }, ctx) {
  const cp = abs(ctx, case_path);
  if (!fs.existsSync(cp)) return `[err] case 不存在：${cp}`;
  const report = { case_path, found: {}, results: {} };
  const all = await fs.promises.readdir(cp);
  // log.* / *.log
  const logs = all.filter(f => /^log\./i.test(f) || /\.log$/i.test(f) || /^out(\.\w+)?$/i.test(f));
  // dump 类
  const dumps = all.filter(f => /^dump\./i.test(f) || /\.lammpstrj$/i.test(f) || /\.atom$/i.test(f) || /\.dump$/i.test(f));
  report.found.logs = logs;
  report.found.dumps = dumps;

  // 1) parse 第一个 log
  if (logs.length) {
    try {
      const r = await lmpParseLog({ case_path, log_name: logs[0], max_rows: 50 }, ctx);
      report.results.parse_log = { file: logs[0], summary: (typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 1500) };
    } catch (e) { report.results.parse_log = { error: e.message }; }
  }

  // 2) dump_summary
  if (dumps.length) {
    try {
      const r = await lmpDumpSummary({ case_path }, ctx);
      report.results.dump_summary = (typeof r === 'string' ? r : JSON.stringify(r)).slice(0, 2000);
    } catch (e) { report.results.dump_summary = { error: e.message }; }
  }

  // 3) plot_thermo（自动尝试 Temp/PotEng/Press）
  if (logs.length) {
    try {
      const r = await lmpPlotThermo({ case_path, log_name: logs[0], y: ['Temp', 'PotEng', 'TotEng'], save_as: 'thermo_auto.png' }, ctx);
      report.results.thermo_png = r;
    } catch (e) { report.results.thermo_png = { error: e.message }; }
  }

  // 4) 最末帧渲染（first dump）
  if (dumps.length) {
    try {
      const r = await lmpRenderTraj({ case_path, dump_file: dumps[0], frame: -1, save_as: 'last_frame.png' }, ctx);
      report.results.last_frame_png = r;
    } catch (e) { report.results.last_frame_png = { error: e.message }; }
  }

  report.next = [
    dumps.length ? `lmp_post_msd dump_file="${dumps[0]}" dt_ps=<frame_dt> → 扩散系数 D` : null,
    dumps.length ? `lmp_post_rdf dump_file="${dumps[0]}" → 径向分布 g(r)`              : null,
    dumps.length ? `lmp_dump_convert dump_file="${dumps[0]}" → .xyz 用于 NGL/VMD`        : null,
  ].filter(Boolean);
  return JSON.stringify(report, null, 2);
}


export async function execLammpsTool(name, args, ctx) {
  switch (name) {
    case 'lmp_env_info':         return await lmpEnvInfo(ctx);
    case 'lmp_find_example':     return await lmpFindExample(args);
    case 'lmp_find_source':      return await lmpFindSource(args);
    case 'lmp_find_potential':   return await lmpFindPotential(args);
    case 'lmp_doc_lookup':       return await lmpDocLookup(args);
    case 'lmp_clone_example':    return await lmpCloneExample(args, ctx);
    case 'lmp_inspect_case':     return await lmpInspectCase(args, ctx);
    case 'lmp_validate_input':   return await lmpValidateInput(args, ctx);
    case 'lmp_lint':             return await lmpLint(args, ctx);
    case 'lmp_template_search':  return await lmpTemplateSearch(args);
    case 'lmp_template_get':     return await lmpTemplateGet(args);
    case 'lmp_run_probe':        return await lmpRunProbe(args, ctx);
    case 'lmp_run_async':        return await lmpRunAsync(args, ctx);
    case 'lmp_run_status':       return await lmpRunStatus(args, ctx);
    case 'lmp_run_stop':         return await lmpRunStop(args, ctx);
    case 'lmp_run_wait':         return await lmpRunWait(args, ctx);
    case 'lmp_parse_log':        return await lmpParseLog(args, ctx);
    case 'lmp_dump_summary':     return await lmpDumpSummary(args, ctx);
    case 'lmp_plot_thermo':      return await lmpPlotThermo(args, ctx);
    case 'lmp_render_traj':      return await lmpRenderTraj(args, ctx);
    case 'lmp_post_msd':         return await lmpPostMsd(args, ctx);
    case 'lmp_post_rdf':         return await lmpPostRdf(args, ctx);
    case 'lmp_dump_convert':     return await lmpDumpConvert(args, ctx);
    case 'lmp_post_all':         return await lmpPostAll(args, ctx);
    case 'lmp_build_data_file':  return await lmpBuildDataFile(args, ctx);
    case 'lmp_diagnose_error':   return lmpDiagnoseError(args);
    case 'lmp_unit_convert':     return lmpUnitConvert(args);
    case 'lmp_packmol_build':    return await lmpPackmolBuild(args, ctx);
    case 'lmp_ff_select_reaxff': return await lmpFfSelectReaxff(args, ctx);
    case 'lmp_soft_pushoff':     return await lmpSoftPushoff(args, ctx);
    case 'lmp_render_in_template': return await lmpRenderInTemplate(args, ctx);
    case 'lmp_reaxff_pipeline':  return await lmpReaxffPipeline(args, ctx);
    default: return `[err] unknown lammps tool: ${name}`;
  }
}

// ============================================================================
//  ReaxFF MD 工作流实现
// ============================================================================
function safeWorkPath(ctx, rel) {
  const ws = ctx?.WORKSPACE || process.cwd();
  const abs = path.resolve(ws, rel || '.');
  if (!abs.startsWith(path.resolve(ws))) throw new Error('case_path 越界工作目录');
  return abs;
}

function which(cmd) {
  const exts = process.platform === 'win32' ? ['.exe', '.bat', '.cmd', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, cmd + e);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
  }
  return null;
}

async function lmpPackmolBuild(args, ctx) {
  const { case_path, molecules, box, tolerance = 2.0, output_pdb = 'packed.pdb', data_file = 'data.lammps' } = args;
  if (!Array.isArray(molecules) || molecules.length === 0) return '[err] molecules 不能为空';
  if (!Array.isArray(box) || box.length !== 3) return '[err] box 必须是 [lx,ly,lz]';
  const caseAbs = safeWorkPath(ctx, case_path);
  fs.mkdirSync(caseAbs, { recursive: true });

  const packmolBin = which('packmol');
  if (!packmolBin) return '[err] 未在 PATH 上找到 packmol。Linux: sudo apt install packmol；Mac: brew install packmol；Windows: 见 https://m3g.iqm.unicamp.br/packmol/';

  // 写 packmol.inp
  const blocks = molecules.map(m => {
    const fileAbs = path.isAbsolute(m.file) ? m.file : path.resolve(caseAbs, m.file);
    if (!fs.existsSync(fileAbs)) throw new Error(`分子文件不存在: ${m.file}`);
    return `structure ${fileAbs.replace(/\\/g, '/')}\n  number ${m.count}\n  inside box 0. 0. 0. ${box[0]} ${box[1]} ${box[2]}\nend structure`;
  }).join('\n');
  const inp = `tolerance ${tolerance}
output ${output_pdb}
filetype pdb
add_box_sides 1.0
${blocks}
`;
  const inpPath = path.join(caseAbs, 'packmol.inp');
  fs.writeFileSync(inpPath, inp, 'utf8');

  // 跑 packmol
  const packRes = await new Promise(resolve => {
    const p = spawn(packmolBin, [], { cwd: caseAbs, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('close', code => resolve({ code, out, err }));
    fs.createReadStream(inpPath).pipe(p.stdin);
  });
  if (packRes.code !== 0) return `[packmol 失败 code=${packRes.code}]\n${packRes.err || packRes.out.slice(-2000)}`;

  // PDB → XYZ → LAMMPS data（obabel）
  const pdbPath = path.join(caseAbs, output_pdb);
  if (!fs.existsSync(pdbPath)) return `[err] packmol 未输出 ${output_pdb}\n${packRes.out.slice(-1500)}`;
  const obabel = which('obabel');
  let dataMsg = '';
  if (obabel) {
    const xyzPath = pdbPath.replace(/\.pdb$/, '.xyz');
    await new Promise(resolve => {
      const p = spawn(obabel, [pdbPath, '-O', xyzPath]);
      p.on('close', () => resolve());
    });
    if (fs.existsSync(xyzPath)) {
      const lines = fs.readFileSync(xyzPath, 'utf8').split(/\r?\n/).filter(Boolean);
      const n = parseInt(lines[0], 10);
      const atoms = lines.slice(2, 2 + n).map(l => {
        const [el, x, y, z] = l.trim().split(/\s+/);
        return { el, x: parseFloat(x), y: parseFloat(y), z: parseFloat(z) };
      });
      const types = [...new Set(atoms.map(a => a.el))];
      const massTable = { H:1.008, C:12.011, N:14.007, O:15.999, F:18.998, P:30.974, S:32.065, Cl:35.453, Si:28.085, Mg:24.305, Al:26.982 };
      const dataAbs = path.join(caseAbs, data_file);
      let body = `# LAMMPS data generated by MDriver / packmol\n\n${n} atoms\n${types.length} atom types\n\n`;
      body += `0.0 ${box[0]} xlo xhi\n0.0 ${box[1]} ylo yhi\n0.0 ${box[2]} zlo zhi\n\nMasses\n\n`;
      types.forEach((t, i) => { body += `${i + 1} ${massTable[t] || 1.0}  # ${t}\n`; });
      body += `\nAtoms # charge\n\n`;
      atoms.forEach((a, i) => {
        const tIdx = types.indexOf(a.el) + 1;
        body += `${i + 1} ${tIdx} 0.0 ${a.x.toFixed(4)} ${a.y.toFixed(4)} ${a.z.toFixed(4)}\n`;
      });
      fs.writeFileSync(dataAbs, body, 'utf8');
      dataMsg = `\n✓ 已生成 ${data_file}（${n} 原子，${types.length} 类型：${types.join(',')}），元素列表："${types.join(' ')}"`;
    } else {
      dataMsg = `\n[警告] obabel 未生成 XYZ；请人工把 ${output_pdb} 转为 data 文件`;
    }
  } else {
    dataMsg = `\n[警告] 未在 PATH 找到 obabel；只生成了 ${output_pdb}。安装：sudo apt install openbabel`;
  }

  return `✓ Packmol 完成（${molecules.length} 种分子，盒子 ${box.join('×')} Å）\n输出：${output_pdb}${dataMsg}`;
}

// 解析 ReaxFF ffield 文件的元素列表（标准 ReaxFF 格式：
// 一行 "N   ! Nr of atoms"，随后 3 行表头，再 N 组、每组 4 行，组首行第一个 token 即元素符号）。
function _parseReaxElements(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const lines = text.split(/\r?\n/);
  let idx = -1, nAtoms = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(\d+)\s*!\s*Nr of atoms/i);
    if (m) { nAtoms = parseInt(m[1], 10); idx = i; break; }
  }
  if (idx < 0 || nAtoms <= 0) return null;
  const els = [];
  let cur = idx + 4;  // 跳过 "Nr of atoms" 行 + 3 行表头
  for (let a = 0; a < nAtoms && cur < lines.length; a++) {
    const tok = (lines[cur].trim().split(/\s+/)[0] || '').trim();
    if (/^[A-Z][a-z]?$/.test(tok)) els.push(tok);
    cur += 4;  // 每个原子块 4 行
  }
  return els.length ? els : null;
}

// 扫描真实存在的 ffield.reax* / ffield.ci-reax* 文件并解析元素，避免目录虚构文件名。
function _scanBundledReaxFiles() {
  const root = resolveRefRoot('potentials');
  const potDir = root ? path.join(root, 'potentials') : null;
  if (!potDir || !fs.existsSync(potDir)) return [];
  let names;
  try { names = fs.readdirSync(potDir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^ffield\.(ci-)?reax/i.test(n)) continue;
    const full = path.join(potDir, n);
    let stat; try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    const els = _parseReaxElements(full);
    out.push({ name: n, file: n, path: full, size: stat.size, elements: els || [] });
  }
  return out;
}

async function lmpFfSelectReaxff(args) {
  const { elements, top_k = 5 } = args;
  if (!Array.isArray(elements) || elements.length === 0) return '[err] elements 不能为空';
  const wanted = new Set(elements.map(e => e.toLowerCase()));

  // 描述信息（可选）：用 forcefields/reaxff_catalog.json 给真实文件补一句注释，没有也不影响。
  let descByElems = {};
  try {
    const catalogPath = path.join(_MODULE_DIR, 'forcefields', 'reaxff_catalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    for (const c of catalog) {
      const key = (c.elements || []).map(e => e.toLowerCase()).sort().join('-');
      if (key) descByElems[key] = c.description || '';
    }
  } catch { /* 目录可选，忽略 */ }

  const files = _scanBundledReaxFiles();
  if (files.length === 0) return '[err] 未在 potentials/ 找到任何 ffield.reax* 文件（背板缺失或路径异常）';

  const ranked = files.map(f => {
    const cov = f.elements.filter(e => wanted.has(e.toLowerCase())).length;
    const missing = elements.filter(e => !f.elements.some(x => x.toLowerCase() === e.toLowerCase()));
    const extra = f.elements.length - cov;
    const key = f.elements.map(e => e.toLowerCase()).sort().join('-');
    return {
      name: f.name, file: f.file, path: f.path, size: f.size,
      elements: f.elements,
      coverage: cov, covers_all: missing.length === 0, missing, extra,
      description: descByElems[key] || '',
      score: (missing.length === 0 ? 1000 : 0) + cov * 10 - extra * 0.1,
    };
  }).filter(c => c.coverage > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top_k);

  if (ranked.length === 0) return `未找到覆盖 [${elements.join(',')}] 的 ReaxFF ffield 文件（已扫描 ${files.length} 个）。`;
  const note = ranked[0].covers_all
    ? `推荐 ${ranked[0].file}（覆盖全部目标元素）。lmp_render_in_template / lmp_reaxff_pipeline 会自动把它拷进 case 目录。`
    : `⚠ 没有任何 ffield 完整覆盖 [${elements.join(',')}]，最优项缺 [${ranked[0].missing.join(',')}]。换力场或减元素。`;
  return JSON.stringify({ note, candidates: ranked }, null, 2);
}

// ReaxFF 动态成键：data 文件里不应有 Bonds/Angles/Dihedrals/Impropers 段，
// 否则 read_data 报 "No bonds allowed with this atom style"。读 charge 风格的
// data 前自动剥掉拓扑（计数行 + 类型计数行 + 段体），只保留 Masses/Atoms/Velocities。
function _sanitizeReaxData(dataAbs) {
  let txt;
  try { txt = fs.readFileSync(dataAbs, 'utf8'); } catch { return { changed: false }; }
  const TOPO_COUNT = /^\s*\d+\s+(bonds|angles|dihedrals|impropers)\s*$/i;
  const TOPO_TYPES = /^\s*\d+\s+(bond|angle|dihedral|improper)\s+types\s*$/i;
  const KEEP_SECTIONS = new Set(['masses', 'atoms', 'velocities']);
  // 所有合法 data 段头（用于界定要丢弃的段体范围）
  const SECTION_HEAD = /^(Masses|Atoms|Velocities|Bonds|Angles|Dihedrals|Impropers|Pair Coeffs|PairIJ Coeffs|Bond Coeffs|Angle Coeffs|Dihedral Coeffs|Improper Coeffs|BondBond Coeffs|BondAngle Coeffs|MiddleBondTorsion Coeffs|EndBondTorsion Coeffs|AngleTorsion Coeffs|AngleAngleTorsion Coeffs|BondBond13 Coeffs|AngleAngle Coeffs|Ellipsoids|Lines|Triangles|Bodies)\b/;
  const lines = txt.split(/\r?\n/);
  const out = [];
  let changed = false;
  let skipSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headMatch = line.match(SECTION_HEAD);
    if (headMatch) {
      const sec = headMatch[1].toLowerCase();
      if (KEEP_SECTIONS.has(sec)) { skipSection = false; out.push(line); continue; }
      // 丢弃该段：跳过段头及其后续行，直到下一个段头或 EOF
      skipSection = true; changed = true; continue;
    }
    if (skipSection) {
      // 段体行（空行/数据行）一并跳过；遇到下一个段头时上面的分支会接管
      continue;
    }
    if (TOPO_COUNT.test(line) || TOPO_TYPES.test(line)) { changed = true; continue; }
    out.push(line);
  }
  if (!changed) return { changed: false };
  // 收尾：去掉因删段产生的连续空行
  const cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n');
  try {
    fs.writeFileSync(dataAbs, cleaned, 'utf8');
  } catch { return { changed: false }; }
  return { changed: true };
}

async function lmpRenderInTemplate(args, ctx) {
  const caseAbs = safeWorkPath(ctx, args.case_path);
  fs.mkdirSync(caseAbs, { recursive: true });
  // 若传入的是绝对/背板路径的 ffield，拷进 case 目录并只在脚本里写文件名，保证 read 相对路径能命中。
  let ffieldName = args.ffield_file || 'ffield.reax';
  if (ffieldName && (path.isAbsolute(ffieldName) || ffieldName.includes('/') || ffieldName.includes('\\'))) {
    try {
      const base = path.basename(ffieldName);
      const dst = path.join(caseAbs, base);
      if (path.resolve(ffieldName) !== path.resolve(dst)) fs.copyFileSync(ffieldName, dst);
      ffieldName = base;
    } catch (e) {
      return `[err] 拷贝 ffield 文件失败：${e.message}（来源 ${args.ffield_file}）`;
    }
  } else if (ffieldName && !fs.existsSync(path.join(caseAbs, ffieldName))) {
    // 文件名形式但 case 里不存在：尝试从背板 potentials/ 找同名拷过来。
    const root = resolveRefRoot('potentials');
    const cand = root ? path.join(root, 'potentials', ffieldName) : null;
    if (cand && fs.existsSync(cand)) { try { fs.copyFileSync(cand, path.join(caseAbs, ffieldName)); } catch {} }
  }
  const rx = _reaxSyntax(ctx, args.reax_variant);
  const params = {
    units:       args.units || 'real',
    atom_style:  args.atom_style || 'charge',
    boundary:    args.boundary || 'p p p',
    data_file:   args.data_file || 'data.lammps',
    ffield_file: ffieldName,
    elements:    args.elements,
    reax_pair:    rx.pair,
    reax_qeq:     rx.qeq,
    reax_qeqtail: rx.qeqTail,
    reax_bonds:   rx.bonds,
    reax_species: rx.species,
    warmup_ts:    args.warmup_ts ?? 0.1,
    warmup_steps: args.warmup_steps ?? 2000,
    temp_start:  args.temp_start ?? 300,
    temp_end:    args.temp_end ?? 300,
    temp_damp:   args.temp_damp ?? 100.0,
    press_start: args.press_start ?? 1.0,
    press_end:   args.press_end ?? 1.0,
    press_damp:  args.press_damp ?? 1000.0,
    timestep:    args.timestep ?? 0.25,
    dump_freq:   args.dump_freq ?? 1000,
    thermo_freq: args.thermo_freq ?? 100,
    nsteps:      args.nsteps ?? 100000,
  };
  const ens = args.ensemble || 'nvt';
  const bonds = args.bonds !== false;
  const preRelax = args.pre_relax !== false;
  const parts = [
    REAXFF_TEMPLATES.init,
    REAXFF_TEMPLATES.read_data,
    REAXFF_TEMPLATES.reaxff,
    preRelax ? REAXFF_TEMPLATES.prerelax : null,
    REAXFF_TEMPLATES[`ensemble_${ens}`],
    bonds ? REAXFF_TEMPLATES.output_reaxff : REAXFF_TEMPLATES.output_std,
    REAXFF_TEMPLATES.run,
  ].filter(Boolean);
  const content = parts.map(p => renderTpl(p, params)).join('\n');
  const outName = args.out_name || 'in.lammps';
  fs.writeFileSync(path.join(caseAbs, outName), content, 'utf8');
  // ReaxFF（atom_style charge）动态成键——若 data 文件带 Bonds/Angles 段会直接报
  // "No bonds allowed with this atom style"。这里自动剥掉拓扑，避免反复翻车。
  let sanitizeMsg = '';
  if (String(params.atom_style).toLowerCase().startsWith('charge')) {
    const dataAbs = path.isAbsolute(params.data_file) ? params.data_file : path.join(caseAbs, params.data_file);
    if (fs.existsSync(dataAbs)) {
      try { if (_sanitizeReaxData(dataAbs).changed) sanitizeMsg = `\n🧹 已自动删除 ${params.data_file} 的 Bonds/Angles/Dihedrals 段（ReaxFF 动态成键，不读拓扑）`; } catch {}
    }
  }
  return `✓ 已渲染 ${outName}（ensemble=${ens}, reax=${rx.variant}, pre_relax=${preRelax}, bonds=${bonds}, ${params.nsteps} 步）${sanitizeMsg}`;
}

// 采样估算 data 文件里最近原子对距离（Å），判断初始重叠严重程度。
// charge 格式: id type q x y z；atomic 格式: id type x y z。
function _minPairDistance(dataAbs, sampleCap = 4000) {
  let txt; try { txt = fs.readFileSync(dataAbs, 'utf8'); } catch { return null; }
  const lines = txt.split(/\r?\n/);
  let i = lines.findIndex(l => /^\s*Atoms\b/.test(l));
  if (i < 0) return null;
  i += 1;
  const coords = [];
  for (let k = i; k < lines.length; k++) {
    const l = lines[k].trim();
    if (!l) { if (coords.length) break; else continue; }
    if (/^[A-Za-z]/.test(l)) break;  // 进入下一段（Velocities/Bonds...）
    const t = l.split(/\s+/).map(Number);
    let x, y, z;
    if (t.length >= 6) { x = t[3]; y = t[4]; z = t[5]; }       // charge/full
    else if (t.length >= 5) { x = t[2]; y = t[3]; z = t[4]; }  // atomic
    else continue;
    if ([x, y, z].some(v => !isFinite(v))) continue;
    coords.push([x, y, z]);
  }
  if (coords.length < 2) return null;
  let pts = coords;
  if (coords.length > sampleCap) {
    pts = [];
    const step = coords.length / sampleCap;
    for (let s = 0; s < coords.length; s += step) pts.push(coords[Math.floor(s)]);
  }
  let min2 = Infinity;
  for (let a = 0; a < pts.length; a++) {
    for (let b = a + 1; b < pts.length; b++) {
      const dx = pts[a][0] - pts[b][0], dy = pts[a][1] - pts[b][1], dz = pts[a][2] - pts[b][2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < min2) min2 = d2;
    }
  }
  return { min_dist: Math.sqrt(min2), n_atoms: coords.length, sampled: pts.length };
}

// ---------- lmp_soft_pushoff ----------
// 软势预平衡：pair_style soft + ramp 前置因子 + fix nve/limit，把重叠原子温和推开，
// 再 minimize + write_data data.relaxed。之后用 data.relaxed 作 ReaxFF 的 read_data。
async function lmpSoftPushoff(args, ctx) {
  const {
    case_path, data_file = 'data.lammps', out_data = 'data.relaxed',
    units = 'real', steps = 20000, amax = 100.0, rcut = 2.5,
    temp = 300, timestep = 1.0, np = 1, wait_seconds = 180,
  } = args;
  const cp = abs(ctx, case_path);
  const dataAbs = path.join(cp, data_file);
  if (!fs.existsSync(dataAbs)) return `[err] data 文件不存在：${dataAbs}`;
  const before = _minPairDistance(dataAbs);
  // soft 势 + 限位积分 + 朗之万控温，是 LAMMPS micelle/indent 例子里的标准消重叠手法。
  const script = `# 软势预平衡（soft pushoff）：把重叠原子温和推开，再切 ReaxFF
units           ${units}
atom_style      charge
boundary        p p p
read_data       ${data_file}
pair_style      soft ${rcut}
pair_coeff      * * 0.0
neighbor        2.0 bin
comm_modify     cutoff ${(rcut + 2.0).toFixed(1)}
variable        A equal ramp(0,${amax})
fix             push all adapt 1 pair soft a * * v_A
fix             integ all nve/limit 0.1
fix             therm all langevin ${temp} ${temp} 100.0 48279
velocity        all create ${temp} 9123 mom yes rot yes dist gaussian
timestep        ${timestep}
thermo          200
thermo_style    custom step temp pe press
run             ${steps}
unfix           push
unfix           therm
min_style       cg
minimize        1.0e-4 1.0e-6 2000 20000
write_data      ${out_data} nocoeff
`;
  const inName = 'in.softpush';
  fs.writeFileSync(path.join(cp, inName), script, 'utf8');
  const _bin = resolveLammpsBin(ctx);
  const useMpi = (+np || 1) > 1;
  let prog, pargs;
  if (useMpi) {
    prog = process.platform === 'win32' ? 'mpiexec' : 'mpirun';
    pargs = process.platform === 'win32'
      ? ['-np', String(np), '-localonly', _bin, '-in', inName, '-log', 'log.softpush', '-screen', 'none']
      : ['-np', String(np), _bin, '-in', inName, '-log', 'log.softpush', '-screen', 'none'];
  } else {
    prog = _bin; pargs = ['-in', inName, '-log', 'log.softpush', '-screen', 'none'];
  }
  const { code, out } = await runCmd(prog, pargs, { cwd: cp, timeout: Math.max(10, wait_seconds) * 1000 });
  const outAbs = path.join(cp, out_data);
  if (!fs.existsSync(outAbs)) {
    const tail = (out || '').split('\n').filter(Boolean).slice(-15).join('\n');
    return `[soft pushoff 失败] exit=${code}，未生成 ${out_data}\n${tail}`;
  }
  const after = _minPairDistance(outAbs);
  return JSON.stringify({
    ok: true,
    out_data,
    min_dist_before: before ? +before.min_dist.toFixed(3) : null,
    min_dist_after: after ? +after.min_dist.toFixed(3) : null,
    n_atoms: before?.n_atoms ?? after?.n_atoms ?? null,
    note: `软势预平衡完成。最近原子距离 ${before ? before.min_dist.toFixed(2) : '?'} → ${after ? after.min_dist.toFixed(2) : '?'} Å。`
      + `下一步：lmp_render_in_template data_file="${out_data}"（或 pipeline 已自动接管），ReaxFF 就不会再因初始重叠崩。`,
  }, null, 2);
}

async function lmpReaxffPipeline(args, ctx) {
  const { case_path, molecules, box, elements, np = 1 } = args;
  const out = [];
  out.push('=== ReaxFF MD 预构型流水线（装盒 → 消重叠 → 选力场 → 渲染 → lint → 探针）===');
  // 0. 输入契约校验（fail-fast，把模型可能填错的参数当场挡回，而不是跑到一半崩）
  if (!Array.isArray(elements) || elements.length === 0)
    return '[err] elements 不能为空，如 ["C","H","O"]。';
  if (!Array.isArray(molecules) || molecules.length === 0 || molecules.some(m => !m || !m.file || !(m.count > 0)))
    return '[err] molecules 必须是 [{file, count>0}, ...]，每项要有分子文件名和数量。';
  if (!Array.isArray(box) || box.length !== 3 || box.some(v => !(v > 0)))
    return '[err] box 必须是三个正数 [lx, ly, lz]（单位 Å）。';
  // ReaxFF timestep 硬约束：> 0.25 fs 容易飞，直接夹住（代码强制，模型改不动）
  let timestep = args.timestep ?? 0.25;
  let tsNote = '';
  if (timestep > 0.25) { tsNote = `（已把 timestep ${timestep}→0.25 fs：ReaxFF 上限）`; timestep = 0.25; }
  // 1. Packmol
  out.push('[1/6] Packmol 装盒...');
  const r1 = await lmpPackmolBuild({ case_path, molecules, box }, ctx);
  out.push(r1);
  if (r1.startsWith('[err]') || r1.startsWith('[packmol 失败')) return out.join('\n');
  // 1.5 重叠检测 + soft pushoff 消重叠（用户可用 soft_pushoff=true/false/'auto' 控制）
  const caseAbs = abs(ctx, case_path);
  let dataForReax = 'data.lammps';
  out.push('\n[2/6] 重叠检测...');
  const ov = _minPairDistance(path.join(caseAbs, 'data.lammps'));
  const softMode = args.soft_pushoff ?? 'auto';
  let needSoft = false;
  if (ov) {
    out.push(`最近原子距离 ≈ ${ov.min_dist.toFixed(2)} Å（${ov.n_atoms} 原子）`);
    needSoft = (softMode === true) || (softMode === 'auto' && ov.min_dist < 1.0);
  } else {
    out.push('无法采样最近距离（data 格式异常），跳过自动 soft pushoff。');
    needSoft = (softMode === true);
  }
  if (needSoft) {
    out.push('⚠ 初始构型重叠较重 → 跑 soft 势预平衡...');
    const rs = await lmpSoftPushoff({ case_path, data_file: 'data.lammps', out_data: 'data.relaxed', np }, ctx);
    out.push(rs);
    let softOk = false;
    try { softOk = JSON.parse(rs)?.ok === true; } catch { /* rs 是错误文本 */ }
    if (softOk) dataForReax = 'data.relaxed';
    else out.push('[警告] soft pushoff 未成功，仍用原始 data.lammps + 脚本内预松弛（若仍崩：加大 box / 减少分子数）。');
  } else {
    out.push('重叠可接受，依靠脚本内预松弛（minimize + nve/limit）即可。');
  }
  // 2. 选 ReaxFF（扫描真实 ffield 文件，返回绝对路径）
  out.push('\n[3/6] 选 ReaxFF...');
  const r2 = await lmpFfSelectReaxff({ elements, top_k: 3 });
  out.push(r2);
  let ffPath = '', top = null;
  try {
    const parsed = JSON.parse(r2);
    top = Array.isArray(parsed?.candidates) ? parsed.candidates[0] : (Array.isArray(parsed) ? parsed[0] : null);
    if (top?.path) ffPath = top.path;
    else if (top?.file) ffPath = top.file;
  } catch { /* r2 是错误文本 */ }
  if (!ffPath) { out.push('[err] 未能选到 ReaxFF ffield 文件，流水线中止。'); return out.join('\n'); }
  // 硬门：没有任何力场完整覆盖目标元素 → pair_coeff 必崩，直接停（不渲染半成品）
  if (top && top.covers_all === false) {
    out.push(`[err] 最优 ffield (${top.file}) 仍缺元素 [${(top.missing||[]).join(',')}]，强行渲染会在 pair_coeff 阶段崩。`);
    out.push('→ 换一组能完整覆盖的元素，或换力场（lmp_ff_select_reaxff 看其它候选），再重跑流水线。');
    return out.join('\n');
  }
  // 3. 渲染 in.lammps（render 内部会把 ffPath 拷进 case 目录）
  out.push('\n[4/6] 渲染 in.lammps...' + tsNote);
  const r3 = await lmpRenderInTemplate({
    case_path,
    data_file: dataForReax,
    elements: elements.join(' '),
    ffield_file: ffPath,
    reax_variant: args.reax_variant,
    pre_relax: args.pre_relax !== false,
    temp_start: args.temp_start ?? 300,
    temp_end: args.temp_end ?? 300,
    timestep,
    nsteps: args.nsteps ?? 100000,
    ensemble: args.ensemble || 'nvt',
    bonds: args.bonds !== false,
  }, ctx);
  out.push(r3);
  if (r3.startsWith('[err]')) return out.join('\n');
  // 4. 静态体检
  out.push('\n[5/6] lmp_lint 静态体检...');
  const r4 = await lmpLint({ case_path, script: 'in.lammps' }, ctx);
  out.push(r4);
  let lintOk = false;
  try { lintOk = JSON.parse(r4)?.ok === true; } catch {}
  if (!lintOk) { out.push('⚠ lint 未通过，请按 errors[].fix 改完再继续；不自动往下跑。'); return out.join('\n'); }
  // 5. 200 步探针（不直接跑完整 run，避免烧长时间）
  out.push('\n[6/6] lmp_run_probe 200 步...');
  const r5 = await lmpRunProbe({ case_path, script: 'in.lammps', probe_steps: 200, np }, ctx);
  out.push(r5);
  out.push('\n→ verdict=healthy 后再 lmp_run_probe probe_steps=2000 复核，最后 lmp_run_async 跑完整步数（可带 np）。');
  return out.join('\n');
}

