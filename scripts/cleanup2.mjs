// MDriver 二次清洗 v2：安全模式 — 只删 PROMPT 字符串块 + 替换 SYSTEM_PROMPT_BASE
import fs from 'fs';
const SRC = './server.js';
let lines = fs.readFileSync(SRC, 'utf8').split('\n');
const before = lines.length;
const isCloseBacktick = l => /^\s*`\s*;\s*$/.test(l);

function dropBlock(startPredicate, endPredicate, replacementLines = []) {
  let i = 0;
  while (i < lines.length) {
    if (startPredicate(lines[i])) {
      let j = i;
      while (j < lines.length && !endPredicate(lines[j])) j++;
      if (j < lines.length) {
        lines.splice(i, j - i + 1, ...replacementLines);
        i += replacementLines.length;
        continue;
      }
    }
    i++;
  }
}

dropBlock(l => /^const FOAM_PROMPT = `/.test(l), isCloseBacktick);
dropBlock(l => /^const MFIX_PROMPT = `/.test(l), isCloseBacktick);
dropBlock(l => /^const LBM_PROMPT = `/.test(l), isCloseBacktick);
dropBlock(l => /^const V9_PROMPT_BLOCK = `/.test(l), isCloseBacktick);

const baseRepl = `const SYSTEM_PROMPT_BASE = (ws) => \`你是 MDriver —— 自动化分子动力学 (LAMMPS) 仿真智能体（作者 LZF），运行在用户本机（\${process.platform}）。

# 工作目录
\${ws}

# Python 解释器
\${SETTINGS.pythonPath ? SETTINGS.pythonPath : '（未选择）'}

# 运行代码
- 用户说"运行 / 执行 / 跑一下" → 立即调 run_command。
- 缺依赖 \\\`pip install xxx\\\` 也用 run_command。

# 联网工具
web_search / paper_search / paper_fetch / fetch_url / read_paper / vision_analyze / image_search

# 🔴 图像分析铁律
你看不见图片像素，凡是"图里画了什么"必须 vision_analyze 让 VLM 看。

# 🔴 公式书写（前端 KaTeX）
- 行内 \\\`$...$\\\`，独立块 \\\`$$...$$\\\`，希腊字母 \\\\rho \\\\mu \\\\nabla 等。

# 长程任务
update_todos 拆 5–20 项；完成一项 → done=true；最后 task_complete。

# 规则
- 修改文件前一句话说明意图；优先 edit_file。
- 中文回答、中文注释。
\`;`.split('\n');

dropBlock(l => /^const SYSTEM_PROMPT_BASE = /.test(l), isCloseBacktick, baseRepl);

// 在 SYSTEM_PROMPT_BASE 后插入 LAMMPS_PROMPT
let inserted = false;
for (let i = 0; i < lines.length; i++) {
  if (/^const SYSTEM_PROMPT_BASE = /.test(lines[i])) {
    let j = i;
    while (j < lines.length && !isCloseBacktick(lines[j])) j++;
    const lp = `
const LAMMPS_PROMPT = \`

# LAMMPS / ReaxFF MD 模式
LAMMPS 根目录：\${SETTINGS.lammpsRoot || '（未设置，请欢迎页点"一键部署 LAMMPS"或右侧面板填写）'}
LAMMPS 可执行：\${SETTINGS.lammpsBin || 'lmp'}

## 17 个 LAMMPS 工具
- lmp_env_info / lmp_find_example / lmp_find_source / lmp_find_potential / lmp_doc_lookup
- lmp_clone_example（需审批）/ lmp_inspect_case / lmp_validate_input
- lmp_run_async / lmp_run_status / lmp_run_stop
- lmp_parse_log / lmp_dump_summary / lmp_plot_thermo / lmp_render_traj
- lmp_build_data_file（需审批）/ lmp_diagnose_error
- lmp_packmol_build / lmp_ff_select_reaxff / lmp_render_in_template / lmp_reaxff_pipeline

## 5 步标准工作流
1. 初始构型 → packmol → data.lammps（lmp_packmol_build）
2. 力场 → ffield.reax（lmp_ff_select_reaxff）
3. 配置 → in.lammps（lmp_render_in_template 或 lmp_clone_example + edit_file）
4. 运行 → lmp_run_async
5. 后处理 → lmp_plot_thermo + lmp_render_traj + NGL 浏览器实时查看

## 纪律
- 回答短，编号清单。
- 长任务用 lmp_run_async。
- 中文回答。
\`;
`;
    lines.splice(j + 1, 0, ...lp.split('\n'));
    inserted = true;
    break;
  }
}
console.log('LAMMPS_PROMPT inserted:', inserted);

fs.writeFileSync(SRC, lines.join('\n'), 'utf8');
console.log(`二次清洗 v2: ${before} → ${lines.length} 行`);
