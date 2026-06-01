// MDriver 大清洗：从 server.js 物理删除所有 OpenFOAM/MFIX/LBM/Opt/v6/v8-四步法 痕迹
// 只保留通用框架 + LAMMPS（lammps.js 外置）+ ParaView 通用面板。
import fs from 'fs';
import path from 'path';

const SRC = path.resolve('server.js');
let txt = fs.readFileSync(SRC, 'utf8');
const before = txt.length;

// ------------------------------------------------------------------
// 1. 删除 startup 自动探测里的 OpenFOAM 段
// ------------------------------------------------------------------
txt = txt.replace(
  /\s*\/\/ OpenFOAM root \+ bashrc[\s\S]*?if \(changed\) \{ try \{ await saveSettings\(\); \} catch \{\} \}\n\}/,
  `\n}`
);

// ------------------------------------------------------------------
// 2. 删除 TOOLS array 里的所有 foam_/mfix_/lbm_/opt_/sim_run_openfoam/algo_extract_contract/case_probe_facts/algo_case_audit/foam_dry_compile/run_status_load/run_stage_*/paper_param_verify 条目
//    它们都是 { type: 'function', function: { name: '...', ... } }，独立成行（多行）。
//    我们用括号匹配：从"包含 name: 'X'" 的对象起点 { 算起，找到对应的 }, 然后删除。
// ------------------------------------------------------------------
const REMOVE_TOOL_NAMES = new Set([
  'sim_run_openfoam',
  'foam_find_tutorial','foam_find_source','foam_clone_tutorial','foam_inspect_case',
  'foam_run_solver_async','foam_solver_status','foam_solver_stop',
  'foam_stl_inspect','foam_mesh_plan','foam_compute_first_layer','foam_mesh_box_stl',
  'foam_residual_series','foam_compare_render','foam_mesh_verify','foam_mesh_stl_check',
  'foam_stl_render','foam_patch_diff',
  'mfix_find_tutorial','mfix_clone_tutorial','mfix_inspect_case',
  'mfix_run_solver_async','mfix_solver_status','mfix_solver_stop',
  'lbm_find_tutorial','lbm_clone_tutorial','lbm_inspect_case',
  'lbm_run_async','lbm_solver_status','lbm_solver_stop',
  'run_status_load','run_stage_start','run_stage_done',
  'foam_geom_verify','foam_solve_verify','foam_post_verify','paper_param_verify',
  'opt_study_create','opt_suggest_next','opt_apply_params','opt_extract_kpi',
  'opt_record_result','opt_status','opt_render',
  'algo_extract_contract','case_probe_facts','algo_case_audit','foam_dry_compile'
]);

function removeToolEntries(src) {
  const out = [];
  let i = 0;
  const lines = src.split('\n');
  while (i < lines.length) {
    const line = lines[i];
    // 整行起 "  { type: 'function', function: { name: 'XXX'"
    const m = line.match(/^\s*\{\s*type:\s*'function',\s*function:\s*\{\s*name:\s*'([^']+)'/);
    if (m && REMOVE_TOOL_NAMES.has(m[1])) {
      // 从该 { 起平衡括号
      let depth = 0, started = false;
      let j = i;
      let removed = 0;
      while (j < lines.length) {
        for (const c of lines[j]) {
          if (c === '{') { depth++; started = true; }
          else if (c === '}') depth--;
        }
        removed++;
        if (started && depth === 0) break;
        j++;
      }
      // 跳过被吃掉的行
      i = j + 1;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}
txt = removeToolEntries(txt);

// ------------------------------------------------------------------
// 3. 删除"以下旧 OpenFOAM/MFIX/LBM/Opt 工具未在 TOOL_GROUPS"那个注释 + "MFIX Beta", "LBM Beta"等分隔注释
// ------------------------------------------------------------------
txt = txt.replace(/^\s*\/\/ =+ 以下旧 OpenFOAM\/MFIX\/LBM\/Opt 工具未在.*?\n.*?filterTools\(DEFAULT_ENABLED\).*?\n/m, '');
txt = txt.replace(/^\s*\/\/ ---------- (MFIX|LBM|v0\.6\.0)[^\n]*\n/gm, '');
txt = txt.replace(/^\s*\/\/ =+ v0\.9\.0 \(V8\) 招1：Git[^\n]*\n/gm, '\n');
txt = txt.replace(/^\s*\/\/ =+ v0\.9\.0 \(V8\) 招3：错误诊断[^\n]*\n/gm, '');
txt = txt.replace(/^\s*\/\/ =+ v0\.9\.0 \(V8\) 算法植入四步法[^\n]*\n/gm, '');

// ------------------------------------------------------------------
// 4. 删除 dispatcher case clauses（多行 case + 单行 case）
//    单行：case 'foam_xxx': return await xxx(...);
//    多行：case 'xxx': { ... }
// ------------------------------------------------------------------
function removeCaseClauses(src) {
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // case 'name':
    const m = line.match(/^\s*case\s+'([^']+)':/);
    if (m && REMOVE_TOOL_NAMES.has(m[1])) {
      // 是同一行 return?  如  case 'foam_xxx': return await xxx(args); 
      if (/return\s+/.test(line)) {
        i++;
        continue;
      }
      // 多行块 case 'X': { ... break; }
      // 检测当前行是否带 { 
      let depth = 0, started = false;
      let j = i;
      while (j < lines.length) {
        for (const c of lines[j]) {
          if (c === '{') { depth++; started = true; }
          else if (c === '}') depth--;
        }
        if (started && depth === 0) { j++; break; }
        if (!started && /;\s*$/.test(lines[j]) && j > i) { j++; break; }
        j++;
      }
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}
txt = removeCaseClauses(txt);

// ------------------------------------------------------------------
// 5. 删除大块实现段（用 "// ====== TITLE ======" 起止）
// ------------------------------------------------------------------
function sliceMarker(src, startMarkerRegex, endMarkerRegex) {
  const m = src.match(startMarkerRegex);
  if (!m) return src;
  const i = m.index;
  const rest = src.slice(i);
  const e = rest.match(endMarkerRegex);
  if (!e) return src;
  const j = i + e.index + e[0].length;
  return src.slice(0, i) + src.slice(j);
}

// 5a. OpenFOAM 命令、Beta、辅助 → v0.6.0 模块结束（983-3040 范围）
txt = sliceMarker(txt,
  /\/\/ =+ OpenFOAM 命令（agent 调用） =+/,
  /\/\/ =+ v0\.6\.0 模块结束 =+\n/
);

// 5b. MFIX-Beta 实现 → 末尾的 lbmSolverStop
txt = sliceMarker(txt,
  /\/\/ =+ MFIX-Beta 实现 =+/,
  /^function lbmSolverStop\(runId\) \{[\s\S]*?return `\[已发送终止信号 runId=\$\{runId\}\]`;\n\}/m
);

// 5c. V8 四步法辅助层（caseProbeFacts / algoCaseAudit / foamDryCompile）
txt = sliceMarker(txt,
  /\/\/ 招1：所有 write_file/,
  /\/\/ =+ V8 辅助层结束 =+\n/
);

// 5d. ParaView 窗口投影 (788-994) - 保留（通用面板，可显示 LAMMPS dump 转 VTK）
// 不删

// 5e. v6 v8 辅助层最前的引言（去掉）
txt = txt.replace(/\/\/ =+ v0\.9\.0 \(V8\) 招1 \+ 招3 \+ 四步法 辅助层 =+[\s\S]*?const V9_GIT = \{[^}]*\};\n/, '');

// ------------------------------------------------------------------
// 6. 删除 V9_PROMPT_BLOCK（V8 全局规则）、FOAM_PROMPT、MFIX_PROMPT、LBM_PROMPT 整体定义
// ------------------------------------------------------------------
txt = txt.replace(/const FOAM_PROMPT = `[\s\S]*?`;\n/, '');
txt = txt.replace(/const MFIX_PROMPT = `[\s\S]*?`;\n/, '');
txt = txt.replace(/const LBM_PROMPT = `[\s\S]*?`;\n/, '');
txt = txt.replace(/\/\/ =+ V8 全局规则 Prompt[^\n]*\nconst V9_PROMPT_BLOCK = `[\s\S]*?`;\n/, '');

// ------------------------------------------------------------------
// 7. 更新 buildSystemPrompt：去掉 foamMode/mfixMode/lbmMode 分支与 V9_PROMPT_BLOCK 引用
// ------------------------------------------------------------------
txt = txt.replace(
  /function buildSystemPrompt\(s\) \{[\s\S]*?return p;\n\}/,
`function buildSystemPrompt(s) {
  let p = SYSTEM_PROMPT_BASE(WORKSPACE);
  if (s.customMode && SETTINGS.customPrompt && SETTINGS.customPrompt.trim()) {
    const name = SETTINGS.customName || '自定义工作流';
    const root = SETTINGS.customRoot ? \`根目录：\${SETTINGS.customRoot}\\n\` : '';
    p += \`\\n\\n========== 已启用《\${name}》工作流（用户自定义 Beta）==========\\n\${root}\${SETTINGS.customPrompt.trim()}\\n========== 工作流定义结束 ==========\\n\`;
  }
  p += LAMMPS_PROMPT;
  return p;
}`
);

// ------------------------------------------------------------------
// 8. 启动 banner / saveSettings 日志中删除 OpenFOAM / MFIX / LBM 提示
// ------------------------------------------------------------------
txt = txt.replace(/^.*(OpenFOAM root|OpenFOAM bashrc|MFIX root|MFIX bashrc|LBM tutorial root).*\n/gm, '');
txt = txt.replace(/^.*foamRoot[^\n]*console\.log[^\n]*\n/gm, '');

// ------------------------------------------------------------------
// 9. 删除 HTTP routes：OpenFOAM Beta HTTP / 求解器后台作业 HTTP / MFIX Beta HTTP / LBM Beta HTTP
// ------------------------------------------------------------------
function sliceHttpSection(src, title) {
  const re = new RegExp(`\\/\\/ =+ ${title} =+`);
  const m = src.match(re);
  if (!m) return src;
  const start = m.index;
  // 找下一个 "// ===" 之前
  const rest = src.slice(start + m[0].length);
  const nextSec = rest.match(/^\/\/ =+ /m);
  if (!nextSec) return src;
  return src.slice(0, start) + src.slice(start + m[0].length + nextSec.index);
}
txt = sliceHttpSection(txt, 'OpenFOAM Beta HTTP');
txt = sliceHttpSection(txt, '\\u6c42\\u89e3\\u5668\\u540e\\u53f0\\u4f5c\\u4e1a HTTP');
txt = sliceHttpSection(txt, '求解器后台作业 HTTP');
txt = sliceHttpSection(txt, 'MFIX Beta HTTP');
txt = sliceHttpSection(txt, 'LBM Beta HTTP');

// ------------------------------------------------------------------
// 10. 删除 V8 git 辅助（write_file/edit_file 自动 commit）——简化，只保留 git_log_recent / git_diff / git_revert_to
//     （它们是通用的，无关 foam）。但 V9_GIT.repoInitDone / stepCounter 已删，需复查。
//     如果没引用就 OK。
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// 11. 删掉 TOOL_TIMEOUT_OVERRIDES 里 foam/mfix/lbm 条目（避免引用错）
// ------------------------------------------------------------------
txt = txt.replace(
  /const TOOL_TIMEOUT_OVERRIDES = \{[\s\S]*?\};\n/,
`const TOOL_TIMEOUT_OVERRIDES = {
    lmp_run_async:    30_000,
    lmp_run_status:   15_000,
    lmp_run_stop:     15_000,
    run_command:      1_200_000,
  };
`
);

// ------------------------------------------------------------------
// 12. 替换主 SYSTEM_PROMPT_BASE 文案为 MDriver 风
// ------------------------------------------------------------------
txt = txt.replace(
  /const SYSTEM_PROMPT_BASE = \(ws\) => `你是 Mdriver[\s\S]*?# 规则\n- 修改文件前一句话说明意图；优先 edit_file\.\n- 中文回答、中文注释。\n`/,
`const SYSTEM_PROMPT_BASE = (ws) => \`你是 MDriver —— 自动化分子动力学 (LAMMPS) 仿真智能体（作者 LZF），运行在用户本机（\${process.platform}）。

# 工作目录
\${ws}

# Python 解释器（用户在顶部 🐍 按钮选择的）
\${SETTINGS.pythonPath ? SETTINGS.pythonPath : '（未选择，将使用 PATH 上默认 python）'}
> 你只需照常写 "python xxx.py" / "pip install xxx"，后端会自动替换为上面这个解释器。

# 重要：运行代码的规则
- 用户说"运行 xxx.py" / "执行 xxx" / "跑一下" → **立即调 run_command**，不要先咨询。
- 输出会实时出现在本地终端面板。
- 缺依赖先 \\\`pip install xxx\\\` 也用 run_command（会自动装到选中的环境）。

# 联网工具（如启用）
- web_search(query, top_k?, topic?, time_range?)：通用联网搜索。
- paper_search(query, top_k?, year?, open_access_only?)：**学术论文检索**（Semantic Scholar + arXiv 合并），找算法原文优先用它。
- paper_fetch(id, download?, max_refs?)：按 DOI/ARXIV/S2-ID 拿摘要 + TLDR + references。
- fetch_url(url, max_chars?, with_images?)：拉网页正文。
- read_paper(path, focus?)：自动切 Abstract/Methods/Results/References。
- vision_analyze(images[], question)：**高清细看图片**。
- image_search(query)：图片搜索。

# 🔴 图像分析铁律
你自己看不见图片像素，任何"图里画了什么"的结论必须先调 \\\`vision_analyze\\\` 或对应 *_verify 让 VLM 看完再下。

# 🔴 公式书写铁律（前端已挂 KaTeX，用 LaTeX）
- 行内 \\\`$...$\\\`，独立块 \\\`$$...$$\\\`，希腊字母 \\\\rho \\\\mu \\\\nabla 等。

# 文献工作流
1. paper_search → 用户选编号 → paper_fetch(download=true) → read_paper(focus="...")
2. 关键图表 → vision_analyze 提取数值
3. update_todos 拆 5–15 项再按 LAMMPS 工作流落地。

# 长程任务
1. 先 update_todos 拆 5–20 项可验证待办。
2. 完成一项 → done=true。
3. 改完代码 → run_command 跑试试 → 失败读错 → 修→再跑。
4. 全部完成才调 task_complete。

# 规则
- 修改文件前一句话说明意图；优先 edit_file。
- 中文回答、中文注释。
\``
);

// ------------------------------------------------------------------
// 13. 注入 LAMMPS_PROMPT（如果还没有）
// ------------------------------------------------------------------
if (!/const LAMMPS_PROMPT = /.test(txt)) {
  const insertAfter = /const SYSTEM_PROMPT_BASE = [^;]*?;\n/;
  const m = txt.match(insertAfter);
  if (m) {
    const idx = m.index + m[0].length;
    const promptCode = `\nconst LAMMPS_PROMPT = \`

# LAMMPS / ReaxFF MD 仿真模式（MDriver 默认开启）
LAMMPS 根目录：\${SETTINGS.lammpsRoot || '（未设置 — 请在欢迎页或右侧面板选择，或一键部署）'}
LAMMPS 可执行：\${SETTINGS.lammpsBin || 'lmp'}

## 17 个 LAMMPS 工具
- lmp_env_info：体检 LAMMPS 安装；找不到 lmp 时**第一步**调它。
- lmp_find_example / lmp_find_source / lmp_find_potential / lmp_doc_lookup：检索内置 examples、src、potentials、文档。
- lmp_clone_example：把 examples/xxx 拷到工作区（需审批）。
- lmp_inspect_case / lmp_validate_input：解析 in.* 抽 units/atom_style/pair_style/fix/compute/dump/run；validate 用 \\\`run 0 post no\\\` 验证。
- lmp_run_async / lmp_run_status / lmp_run_stop：长任务后台跑（需审批）；status 拿最新 Step / thermo 末行 / Loop time。
- lmp_parse_log / lmp_dump_summary：解析 log.lammps / dump 文件元信息。
- lmp_plot_thermo / lmp_render_traj：调 helpers/lmp_log_parse.py 出热力学曲线；OVITO/Tachyon 渲染轨迹（无 OVITO 自动 matplotlib 备选）。
- lmp_build_data_file：纯 JS 写 fcc/bcc/sc/diamond 晶格 data 文件（需审批）。
- lmp_diagnose_error：17 条 LAMMPS 报错模式匹配（pair_style mismatch / Lost atoms / Out of memory / bond too long…）。
- lmp_packmol_build：调 packmol 用 PDB 单体堆砌成混合体系，自动转 LAMMPS data 文件。
- lmp_ff_select_reaxff：按元素列表从本地 ReaxFF 力场目录挑合适 ffield.reax。
- lmp_render_in_template：用内置 YAML 模板 + 参数渲染 in.* 文件（init/read_data/reaxff/ensemble_n[vp]t/output_std|reaxff/run）。
- lmp_reaxff_pipeline：**一键端到端** — 给一段描述（如「PE 在 300→3000 K 100 ps 热解」），自动建模 → 选力场 → 渲染 in → 后台跑。

## 🌊 标准工作流（5 步，对应欢迎页流程图）

**第 1 步 · 初始构型** packmol → data.lammps（lmp_packmol_build）
**第 2 步 · 力场选取** ffield.reax（lmp_ff_select_reaxff）
**第 3 步 · 配置脚本** in.lammps（lmp_render_in_template 或 lmp_clone_example + edit_file）
**第 4 步 · 运行 LAMMPS** lmp_run_async → 监测面板自动刷新
**第 5 步 · 后处理** lmp_plot_thermo + lmp_render_traj + 浏览器内置 NGL 实时轨迹查看器

## 重要纪律
- **回答短**，多用编号清单。
- **没问明白前不动 edit_file**。
- 长任务一律走 lmp_run_async；同步 run_command 仅用于秒级命令。
- 若 lammpsBin 未设：先告诉用户点欢迎页"一键部署 LAMMPS"，或在右侧面板填路径。
- 中文回答、中文注释。
\`;
`;
    txt = txt.slice(0, idx) + promptCode + txt.slice(idx);
  }
}

// ------------------------------------------------------------------
// 14. 删除 buildSystemPrompt 之前的 SIM_PROMPT 注释
// ------------------------------------------------------------------
txt = txt.replace(/\/\/ SIM_PROMPT removed in v2[^\n]*\n(?:\/\/[^\n]*\n)*/, '');

// ------------------------------------------------------------------
// 15. 处理 _ensureRunState / startRun / stageStart / stageDone / genericVisionVerify
//     在 v6 自治模块里，已经被 5a 删除了。检查是否还有遗留引用。
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// 完成
// ------------------------------------------------------------------
fs.writeFileSync(SRC, txt, 'utf8');
const after = txt.length;
console.log(`server.js 清洗完成: ${before} → ${after} 字符 (减少 ${before - after} = ${((before-after)/before*100).toFixed(1)}%)`);
console.log(`行数: 之前 ${(fs.readFileSync(SRC.replace(/\.js$/, '.js.bak'), 'utf8').split('\n').length) || '?'} → 现在 ${txt.split('\n').length}`);
