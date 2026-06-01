import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import fs from 'fs/promises';
import fssync from 'fs';
import { fileURLToPath } from 'url';
import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import os from 'os';
import { LAMMPS_TOOLS, LAMMPS_TOOL_NAMES, LAMMPS_NEEDS_APPROVAL, execLammpsTool, waitForRun, getRunVerdict } from './lammps.js';
import * as Skills from './skills.js';

// 可选：HTTPS_PROXY / HTTP_PROXY 支持（GitHub 偶发 fetch failed 时可设置代理）
try {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy) {
    const undici = await import('undici');
    if (undici.setGlobalDispatcher && undici.ProxyAgent) {
      undici.setGlobalDispatcher(new undici.ProxyAgent(proxy));
      console.log('[net] 已启用代理:', proxy);
    }
  }
} catch {}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
Skills.initSkills(path.join(__dirname, 'skills'));
const IS_WIN = process.platform === 'win32';

const DEFAULT_SETTINGS = {
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  provider: 'sf',                  // 'sf' (SiliconFlow / 兼容 OpenAI) | 'copilot' (GitHub Copilot)
  copilotModel: 'gpt-4.1',         // 当 provider=copilot 时使用
  paraviewExe: '',
  paraviewPython: '',
  openfoamBash: '',
  pythonPath: '',
  foamRoot: process.env.FOAM_ROOT || '',  // OpenFOAM 安装根（含 tutorials/ src/ applications/）
  foamMode: false,                          // Beta：OpenFOAM 仿真智能体模式
  mfixRoot: process.env.MFIX_ROOT || '',    // MFIX 安装根（含 tutorials/ model/）
  mfixBash: process.env.MFIX_BASH || '',    // MFIX activate/bashrc（source 后能跑 mfixsolver）
  mfixMode: false,                          // Beta：MFIX 仿真智能体模式
  lbmTutorialRoot: process.env.LBM_TUTORIAL_ROOT || '',  // 用户提供的 LBM 算例根目录（无固定框架）
  lbmRunCmd: '',                            // LBM 默认运行命令模板（如 "python run.py" / "./lb_main"）
  lbmMode: false,                           // Beta：LBM 仿真智能体模式
  customMode: false,                        // Beta：用户自定义工作流 prompt 模式
  customName: '',                           // 自定义工作流名称（如 "DEM 颗粒料仓"）
  customRoot: '',                           // 自定义工作流可选根目录（传给 agent 作为上下文）
  customPrompt: '',                         // 用户手写的流水式提示词（会拼到 system prompt）
  activeSkill: '',                          // 训练模式：当前激活的领域技能 id（空=关闭）
  activeSkillName: '',                       // 该领域的显示名
  // V4.1: 专用视觉模型路由 —— 主模型不是 VLM 也能读图
  // 默认 SiliconFlow 的 Kimi VL；visionAnalyze 会优先走这个端点 + 这个模型，读完在把文字回传主模型。
  visionProvider: 'sf',
  visionBaseUrl: 'https://api.siliconflow.cn',
  visionModel: 'Pro/moonshotai/Kimi-K2.6',  // 可在 ui 里改，如 Qwen/Qwen2.5-VL-72B-Instruct
  visionApiKey: '',                          // 为空时复用主 apiKey
  workspace: process.env.WORKSPACE_DIR || process.cwd()
};
let SETTINGS = { ...DEFAULT_SETTINGS };
let WORKSPACE = path.resolve(DEFAULT_SETTINGS.workspace);

async function loadSettings() {
  try { SETTINGS = { ...DEFAULT_SETTINGS, ...JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')) }; } catch {}
  WORKSPACE = path.resolve(SETTINGS.workspace || process.cwd());
}
async function saveSettings() { await fs.writeFile(SETTINGS_FILE, JSON.stringify(SETTINGS, null, 2), 'utf8'); }

// ====================== 启动期自动探测（Linux/Mac/WSL 无配置即可用）======================
function whichSync(name) {
  try {
    const r = spawnSync(IS_WIN ? 'where' : 'which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) return r.stdout.split(/\r?\n/)[0].trim();
  } catch {}
  return '';
}
async function pathExistsSync(p) { try { await fs.access(p); return true; } catch { return false; } }
async function autoProbeEnvironment() {
  let changed = false;
  // ParaView
  if (!SETTINGS.paraviewExe) {
    const cand = [whichSync('paraview'), '/usr/bin/paraview', '/usr/local/bin/paraview', '/Applications/ParaView.app/Contents/MacOS/paraview'].filter(Boolean);
    for (const c of cand) { if (await pathExistsSync(c)) { SETTINGS.paraviewExe = c; changed = true; break; } }
  }
  if (!SETTINGS.paraviewPython) {
    const cand = [whichSync('pvpython'), '/usr/bin/pvpython', '/usr/local/bin/pvpython', '/Applications/ParaView.app/Contents/bin/pvpython'].filter(Boolean);
    for (const c of cand) { if (await pathExistsSync(c)) { SETTINGS.paraviewPython = c; changed = true; break; } }
  }
  // OpenFOAM root + bashrc：扫常见安装路径
  if (!SETTINGS.foamRoot && !IS_WIN) {
    const candDirs = ['/usr/lib/openfoam', '/opt/openfoam', '/opt/OpenFOAM', '/opt'];
    const FOAM_RE = /^(?:openfoam|OpenFOAM[-_]?)[\w.-]*$/i;
    for (const base of candDirs) {
      try {
        const ents = await fs.readdir(base, { withFileTypes: true });
        for (const e of ents) {
          if (!e.isDirectory()) continue;
          if (!FOAM_RE.test(e.name)) continue;
          const root = path.join(base, e.name);
          // OpenFOAM 真正源码根：含 etc/bashrc + tutorials
          if (await pathExistsSync(path.join(root, 'etc', 'bashrc')) && await pathExistsSync(path.join(root, 'tutorials'))) {
            SETTINGS.foamRoot = root; SETTINGS.openfoamBash = path.join(root, 'etc', 'bashrc'); changed = true; break;
          }
          // ESI 风格：openfoam2312/{etc,tutorials} 嵌一层
          for (const sub of [e.name, 'OpenFOAM-' + e.name.replace(/^openfoam/i, ''), '']) {
            const inner = sub ? path.join(root, sub) : root;
            if (await pathExistsSync(path.join(inner, 'etc', 'bashrc')) && await pathExistsSync(path.join(inner, 'tutorials'))) {
              SETTINGS.foamRoot = inner; SETTINGS.openfoamBash = path.join(inner, 'etc', 'bashrc'); changed = true; break;
            }
          }
          if (SETTINGS.foamRoot) break;
        }
      } catch {}
      if (SETTINGS.foamRoot) break;
    }
  }
  // 环境变量后备
  if (!SETTINGS.foamRoot && process.env.FOAM_INST_DIR) {
    if (await pathExistsSync(process.env.FOAM_INST_DIR)) { SETTINGS.foamRoot = process.env.FOAM_INST_DIR; changed = true; }
  }
  if (!SETTINGS.openfoamBash && process.env.FOAM_BASH) {
    if (await pathExistsSync(process.env.FOAM_BASH)) { SETTINGS.openfoamBash = process.env.FOAM_BASH; changed = true; }
  }
  if (changed) { try { await saveSettings(); } catch {} }
}

// 端口优先级：命令行参数 > 环境变量 > 默认 5174
// 支持：node server.js --port 5180 / -p 5180 / --port=5180 / 5180（首个数字位置参数）
function parseCliPort() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') { const v = parseInt(argv[i+1], 10); if (v > 0 && v < 65536) return v; }
    const m = a.match(/^--port=(\d+)$/); if (m) { const v = parseInt(m[1], 10); if (v > 0 && v < 65536) return v; }
    if (/^\d+$/.test(a)) { const v = parseInt(a, 10); if (v > 0 && v < 65536) return v; }
  }
  return null;
}
function parseCliHost() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--host' || a === '-h') { const v = argv[i+1]; if (v) return v; }
    const m = a.match(/^--host=(.+)$/); if (m) return m[1];
  }
  return null;
}
const PORT = parseCliPort() || parseInt(process.env.PORT || '5174', 10);
const IGNORE = new Set(['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.venv', 'venv']);
const MAX_AUTO_STEPS = 80;

// ====================== 内存防护（防 OOM） ======================
// 单条工具返回最大字符数（超过则截断保存到上下文，但仍把原文回送给前端做显示）
const MAX_TOOL_RESULT_CHARS = parseInt(process.env.MAX_TOOL_RESULT_CHARS || '20000', 10);
// 整段对话上下文软上限（字符）。超过则自动压缩（保留 system + 最近 6 条）
const MAX_HISTORY_CHARS    = parseInt(process.env.MAX_HISTORY_CHARS    || '700000', 10);
function clipForHistory(s) {
  s = s == null ? '' : String(s);
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  const head = s.slice(0, Math.floor(MAX_TOOL_RESULT_CHARS * 0.7));
  const tail = s.slice(-Math.floor(MAX_TOOL_RESULT_CHARS * 0.2));
  return head + `\n...[已截断：原文 ${s.length} 字符，仅保留头尾，避免上下文越限]...\n` + tail;
}
function historyCharCount(messages) {
  let n = 0;
  for (const m of messages) {
    const c = m.content;
    if (typeof c === 'string') n += c.length;
    else if (Array.isArray(c)) for (const p of c) n += (p && p.text) ? p.text.length : 0;
    if (m.tool_calls) for (const t of m.tool_calls) n += (t.function?.arguments || '').length + (t.function?.name || '').length;
  }
  return n;
}
function autoCompactIfNeeded(session, ws) {
  const total = historyCharCount(session.messages);
  if (total <= MAX_HISTORY_CHARS) return false;
  const before = session.messages.length;
  if (before > 10) {
    const sys = session.messages[0];
    // 安全切点：从 -6 起，若切点落在 role:'tool' 上，向左回退到拥有它的 assistant（含 tool_calls）。
    // 否则 tail 里的 tool 消息会指向已被压缩进 summary 的 tool_call_id → OpenAI 返回 400。
    let cutIdx = Math.max(1, before - 6);
    while (cutIdx > 1 && session.messages[cutIdx].role === 'tool') cutIdx--;
    // 若切点上方是 assistant + tool_calls，且其全部 tool 响应都在 tail 中，则保持 cut 不变；
    // 否则把这个 assistant 也并入 tail，避免它在 middle 里却没有对应工具响应。
    const tailMsgs = session.messages.slice(cutIdx);
    const middle = session.messages.slice(1, cutIdx);
    // 再保险：丢弃 tail 顶端找不到对应 assistant.tool_calls 的孤儿 tool 消息
    const tailIds = new Set();
    for (const m of tailMsgs) if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) tailIds.add(tc.id);
    const cleanTail = tailMsgs.filter(m => m.role !== 'tool' || tailIds.has(m.tool_call_id));
    const summary = middle.map(x => {
      if (x.role === 'user')      return `[用户] ${(typeof x.content === 'string' ? x.content : JSON.stringify(x.content)).slice(0, 200)}`;
      if (x.role === 'assistant') return `[助手] ${(x.content || '').toString().slice(0, 300)}` + (x.tool_calls ? ` (调用 ${x.tool_calls.map(t => t.function?.name).join(',')})` : '');
      if (x.role === 'tool')      return `[工具返回] ${String(x.content || '').slice(0, 160)}`;
      return '';
    }).filter(Boolean).join('\n');
    session.messages = [sys, { role: 'user', content: '以下是之前会话的压缩总结，请继续任务：\n' + summary }, ...cleanTail];
  }
  if (ws) try { ws.send(JSON.stringify({ type: 'term', line: `[自动压缩上下文：${(total/1024).toFixed(0)} KB 超限，消息 ${before} → ${session.messages.length}] `})); } catch {}
  return true;
}

// glob → RegExp（支持 **、*、?）
function globToRegExp(glob) {
  let re = '^'; let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i+1] === '*') { re += '.*'; i += 2; if (glob[i] === '/') i++; }
      else { re += '[^/]*'; i++; }
    } else if (c === '?') { re += '[^/]'; i++; }
    else if ('.+^$|()[]{}\\'.includes(c)) { re += '\\' + c; i++; }
    else { re += c; i++; }
  }
  re += '$';
  return new RegExp(re);
}

const TOOLS = [
  { type: 'function', function: { name: 'list_dir', description: '列出目录内容', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'read_file', description: '读取文本文件。可传 start_line/end_line (1-indexed, 闭区间) 只读一部分。', parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: '写入/创建文件', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: '在文件中精确替换字符串。old_str 必须唯一匹配。', parameters: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } } },
  { type: 'function', function: { name: 'multi_edit', description: '对同一个文件依次应用多个 edit_file 替换（原子：任一失败全部不写入）。快于多次调 edit_file。', parameters: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['old_str','new_str'] } } }, required: ['path','edits'] } } },
  { type: 'function', function: { name: 'glob', description: '按通配符查找文件（支持 ** 、 *）。例：**/*.py 、 src/**/*.ts。', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'grep_search', description: '正则搜索代码（返回文件:行号: 内容）', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'run_command', description: '执行 shell 命令（用户审批）。命令中的 python/python3/pip/jupyter 会被自动替换为用户在顶部选中的解释器。', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'update_todos', description: '维护待办清单', parameters: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, done: { type: 'boolean' } }, required: ['text'] } } }, required: ['items'] } } },
  { type: 'function', function: { name: 'task_complete', description: '声明任务完成', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } },
  { type: 'function', function: { name: 'web_search', description: '联网搜索。自动按优先级选用 Tavily(若 TAVILY_API_KEY) → Serper(SERPER_API_KEY) → Brave(BRAVE_API_KEY) → SearXNG(SEARXNG_URL) → DuckDuckGo HTML → Bing → Baidu。Tavily 会附带 LLM 摘要 answer。可指定 topic=news/general、time_range=day|week|month|year。', parameters: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'number' }, topic: { type: 'string', enum: ['general','news'] }, time_range: { type: 'string', enum: ['day','week','month','year'] }, include_answer: { type: 'boolean', description: '默认 true（仅 Tavily 生效）' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'paper_search', description: '【学术】文献检索（合并 Semantic Scholar + arXiv，去重按 DOI/标题；无需 API Key）。返回 title / authors / year / venue / citationCount / abstract / DOI / openAccessPdf 链接，按引用数与年份综合排序。比 web_search 更适合找算法原文。', parameters: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'number' }, year: { type: 'string', description: '如 2020-2025 / 2023- / -2018' }, open_access_only: { type: 'boolean' }, fields_of_study: { type: 'string', description: 'Semantic Scholar 字段过滤，如 Physics,Engineering,Computer Science（逗号分隔）' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'paper_fetch', description: '【学术】按 ID 取论文详情（abstract + tldr + references 列表 + OA PDF 链接）。id 可为 DOI:10.x/x、ARXIV:2106.15928、Semantic Scholar paperId（40 位 hex），或裸 arXiv id。可选 download=true 把 OA PDF 下载到 downloads/papers/ 便于后续 read_paper。', parameters: { type: 'object', properties: { id: { type: 'string' }, download: { type: 'boolean' }, max_refs: { type: 'number' } }, required: ['id'] } } },
  { type: 'function', function: { name: 'read_paper', description: '【学术】比 read_document 更强：先 read_document 拿全文，再做章节切分与关键信息抽取——Abstract / Introduction / Methods / Equations / Results / Conclusion / References。返回结构化 Markdown。可选 focus 定位特定章节段落。', parameters: { type: 'object', properties: { path: { type: 'string' }, focus: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'paper_extract_params', description: '【学术·参数抽取】有论文 PDF 时可用：从 PDF 中精准抽取所有 MD 仿真参数（T / P / ρ / dt / N / box / cutoff / 力场名 / ε / σ / 退火曲线 / ensemble / 模拟时长 …）。流程：① read_document 取全文+逐页 PNG；② 正则扫"T = 300 K"等数值；③ 对所有含 Table/Methods 的页面图调 vision_analyze 让 VLM 读表；④ 三路合并去重，标 confidence；⑤ 若 to_units 给定则自动调 lmp_unit_convert 换到目标 LAMMPS 单位。返回结构化 JSON：{ params: [{name,value,unit,kind,source,page,confidence}], converted, warnings, raw_pages }。', parameters: { type: 'object', properties: { path: { type: 'string' }, to_units: { type: 'string', enum: ['lj','real','metal','si','cgs','electron','micro','nano'], description: '可选；填了就自动换算' }, max_pages_vlm: { type: 'number', description: '调用 VLM 看几页（含 Methods/Table 的页面），默认 6' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'vision_analyze', description: '【视觉】对一张或多张本地/网络图片做"高清细看"——以 detail=high 把图片发给多模态模型并按 question 抽取结构化信息。适用于：读图表数值、读公式、读表格、读流程图。images 是路径数组（相对工作区或绝对，或 http(s) URL）。', parameters: { type: 'object', properties: { images: { type: 'array', items: { type: 'string' } }, question: { type: 'string' }, max_tokens: { type: 'number' } }, required: ['images','question'] } } },
  { type: 'function', function: { name: 'image_search', description: '【图片搜索】专门搜图片（Bing Images），返回缩略图+原图 URL+来源页。结果会自动出现在右侧"图片库"面板中可双击大图、可下载。适合"找论文里 XX 现象的图"。', parameters: { type: 'object', properties: { query: { type: 'string' }, top_k: { type: 'number', description: '默认 12，最多 30' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'fetch_url', description: '拉取网页可读文本；自动追加图片链接列表（最多前 20 张）和正文图片描述。', parameters: { type: 'object', properties: { url: { type: 'string' }, max_chars: { type: 'number' }, with_images: { type: 'boolean' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'read_document', description: '读取本地 PDF/DOCX/PPTX/XLSX/图片(OCR)/纯文本 文件，返回提取出的纯文本内容。需用户已配置 Python 解释器。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'request_user_digitize', description: '【V3 手动标注】当你从论文图表/截图里需要精准的 (x,y) 数据点作为参考或对比基准，但大模型抽不准时调用。会在用户界面弹出手动标注仪（类 WebPlotDigitizer），用户点何点为数据点后保存为 CSV，返回该 CSV 的路径供后续读取。阻塞等待，默认超时 600s。', parameters: { type: 'object', properties: { image_path: { type: 'string', description: '可选，工作区内的图片路径；传了会预加载到标注仪。不传则让用户自己选图。' }, hint: { type: 'string', description: '给用户的提示，如 “请标 Fig.5 里 baseline 曲线上 8–10 个点”' }, name: { type: 'string', description: '保存 CSV 的名字（默认 plot）' }, timeout_sec: { type: 'number', description: '等待用户完成的超时（秒），默认 600' } }, required: [] } } },
  { type: 'function', function: { name: 'download_file', description: '从 URL 下载到本地（默认到 downloads/ 目录）。可用于保存网页里的图片或 PDF/zip 等。', parameters: { type: 'object', properties: { url: { type: 'string' }, save_as: { type: 'string' } }, required: ['url'] } } },
  // ====================== Mdriver: LAMMPS 工具集（16 个）======================
  ...LAMMPS_TOOLS,
  // ====================== 以下旧 OpenFOAM/MFIX/LBM/Opt 工具未在 TOOL_GROUPS 中启用 ======================
  // 它们的 dispatcher case 仍存在以保持 server.js 稳定，但 filterTools(DEFAULT_ENABLED) 不会把它们暴露给 LLM。
  { type: 'function', function: { name: 'git_log_recent', description: '【V8 招1】列出最近 N 个 git commit（SHA + 消息 + 改动文件数）。出错/越改越差时**第一步**调它定位"上一个能跑的快照"。', parameters: { type: 'object', properties: { n: { type: 'integer', default: 10 } } } } },
  { type: 'function', function: { name: 'git_diff', description: '【V8 招1】查看两个 commit 之间的 diff（默认 HEAD~1..HEAD）。可选 path_glob 只看某些文件。', parameters: { type: 'object', properties: { from: { type: 'string', description: 'SHA 或 HEAD~N，缺省 HEAD~1' }, to: { type: 'string', description: 'SHA，缺省 HEAD' }, path_glob: { type: 'string' } } } } },
  { type: 'function', function: { name: 'git_revert_to', description: '【V8 招1】把工作区文件还原到指定 SHA 的快照，并生成一次新 commit（不丢失历史）。同一报错连续修多次未果时可调它回滚。', parameters: { type: 'object', properties: { sha: { type: 'string', description: '目标 SHA（git_log_recent 给的）' }, note: { type: 'string', description: '回滚原因，写进 commit msg' } }, required: ['sha'] } } },
  { type: 'function', function: { name: 'diagnose_error', description: '【报错诊断】把工具返回的报错文本（log tail 或 [error] 段）传进来，按内置错误模式匹配，返回 {category, causes, next_steps}。工具返回非零 exit / 抛异常时可以先调它定位原因。', parameters: { type: 'object', properties: { text: { type: 'string', description: 'log tail 或错误段落（≤ 8000 字符即可）' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'list_case_library', description: '【案例库】列出 MDriver 预编辑的开源 LAMMPS / ReaxFF 参考案例库（cases/case_library.json）。返回官方 examples / potentials / tutorials / moltemplate / OpenKIM / NIST / EMC / PyLAT 等的 URL、许可、适用场景与 fetch 方式。遇到“找案例 / 找力场 / 参考输入脚本”的需求优先调这个，能过滤 tags 或词。', parameters: { type: 'object', properties: { filter: { type: 'string', description: '在 name/scope/tags 中模糊匹配（可选）' }, only_ids: { type: 'array', items: { type: 'string' }, description: '仅返回这些 id（可选）' } } } } },
];

// 工具分组（用于 UI 开关；编辑类始终开启）
// MDriver: 只保留通用 + LAMMPS
const TOOL_GROUPS = {
  edit:  ['list_dir','read_file','write_file','edit_file','multi_edit','glob','grep_search','update_todos','task_complete','git_log_recent','git_diff','git_revert_to','diagnose_error','list_case_library'],
  shell: ['run_command'],
  web:   ['web_search','fetch_url','download_file','image_search','paper_search','paper_fetch'],
  doc:   ['read_document','read_paper','paper_extract_params','vision_analyze','request_user_digitize'],
  lammps:[
    // 常用核心：覆盖 90% 教学/中等难度任务
    'lmp_env_info','lmp_find_example','lmp_find_source','lmp_find_potential','lmp_doc_lookup',
    'lmp_clone_example','lmp_inspect_case','lmp_validate_input','lmp_lint','lmp_template_search','lmp_template_get','lmp_run_probe',
    'lmp_run_async','lmp_run_status','lmp_run_stop','lmp_run_wait',
    'lmp_parse_log','lmp_dump_summary','lmp_plot_thermo','lmp_render_traj',
    'lmp_post_msd','lmp_post_rdf','lmp_dump_convert','lmp_post_all',
    'lmp_diagnose_error',
  ],
  // ReaxFF 反应力场工具链：默认启用，否则智能体永远无法做热解/燃烧/成键断键类反应 MD。
  // 路由由 LAMMPS_PROMPT 控制：仅在出现“化学反应/热解/燃烧/成键断键”信号时才走这条链。
  lammps_reaxff:[
    'lmp_packmol_build','lmp_ff_select_reaxff','lmp_render_in_template','lmp_reaxff_pipeline',
  ],
  // 专家工具：通用 data 文件构造器，最易诱导简单任务误走 data 路径，默认关闭。
  lammps_expert:[
    'lmp_build_data_file',
  ]
};
const DEFAULT_ENABLED = new Set([
  ...TOOL_GROUPS.edit, ...TOOL_GROUPS.shell, ...TOOL_GROUPS.web,
  ...TOOL_GROUPS.doc,  ...TOOL_GROUPS.lammps, ...TOOL_GROUPS.lammps_reaxff
  // 注意：lammps_expert（通用 data 构造器）默认不启用（去掉"工具名诱导"）
]);
function filterTools(enabled) { return TOOLS.filter(t => enabled.has(t.function.name)); }

const NEEDS_APPROVAL = new Set([
  'run_command',
  ...LAMMPS_NEEDS_APPROVAL,            // lmp_clone_example / lmp_run_async / lmp_build_data_file
  'git_revert_to'
]);
const MODIFYING = new Set(['write_file', 'edit_file', 'multi_edit']);

// ====================== v0.9.0 (V8) 招1 + 招3 + 四步法 辅助层 ======================
//
// 招1：所有 write_file / edit_file / multi_edit **自动**前后 commit；新增 git_log_recent / git_diff / git_revert_to。
// 招3：内置 16 条 OpenFOAM/C++ 报错模式表；diagnose_error(text) 匹配后给 category/causes/next_steps。
// 四步法：算法植入分 4 步走（extract_contract / probe_facts / audit / 受控植入）。
//
const V9_GIT = { stepCounter: 0, repoInitDone: false };

function _spawnP(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('close', code => resolve({ code, out, err }));
    p.on('error', e => resolve({ code: -1, out, err: String(e.message || e) }));
  });
}

async function ensureGitRepo() {
  if (V9_GIT.repoInitDone) return { ok: true, init: false };
  try {
    await fs.stat(path.join(WORKSPACE, '.git'));
    V9_GIT.repoInitDone = true;
    return { ok: true, init: false };
  } catch {}
  // 初始化 + 写最小 .gitignore + 首次 baseline commit
  await _spawnP('git', ['init', '-q'], { cwd: WORKSPACE });
  await _spawnP('git', ['config', 'user.email', 'Mdriver@local'], { cwd: WORKSPACE });
  await _spawnP('git', ['config', 'user.name', 'Mdriver'], { cwd: WORKSPACE });
  try {
    const gi = path.join(WORKSPACE, '.gitignore');
    let cur = ''; try { cur = await fs.readFile(gi, 'utf8'); } catch {}
    if (!/# Mdriver auto-generated/.test(cur)) {
      cur += '\n# Mdriver auto-generated (V8)\nprocessor*/\n*.foam\npostProcessing/\nVTK/\n*.vtk\n*.vtu\n*.pvd\n*.log\n';
      await fs.writeFile(gi, cur, 'utf8');
    }
  } catch {}
  await _spawnP('git', ['add', '-A'], { cwd: WORKSPACE });
  await _spawnP('git', ['commit', '-q', '-m', '[Mdriver init] baseline', '--allow-empty'], { cwd: WORKSPACE });
  V9_GIT.repoInitDone = true;
  return { ok: true, init: true };
}

async function gitAutoCommit(message) {
  try {
    await ensureGitRepo();
    await _spawnP('git', ['add', '-A'], { cwd: WORKSPACE });
    const c = await _spawnP('git', ['commit', '-q', '-m', message, '--allow-empty'], { cwd: WORKSPACE });
    const sh = await _spawnP('git', ['rev-parse', '--short', 'HEAD'], { cwd: WORKSPACE });
    return { ok: c.code === 0, sha: (sh.out || '').trim(), msg: message };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function gitStep() { return ++V9_GIT.stepCounter; }

// 错误模式表（V8 招3）—— 每条 {re, category, causes, steps}
const ERROR_PATTERNS = [
  { re: /floating point exception|FOAM FATAL ERROR.*FPE|signal\s+FPE/i,
    category: 'NaN/Inf 数值发散 (FPE)',
    causes: ['CFL 过大 → dt 减小或 deltaT 自适应', 'BC 不一致致初始时刻除零', '0/ 未做 setFields，alpha/T 仍是默认 → 整场 0 或 1', '物性常数为 0（如 mu=0、sigma=0）'],
    steps: ['foam_solver_status(run_id) 看哪一步首次出现 nan/Inf', 'foam_residual_series 看哪个场先发散', 'case_probe_facts 确认物性 + 求解器假设', 'foam_inspect_case 看 0/ 各场 dimensions 与 internalField'] },
  { re: /Cannot find file.*system\/(controlDict|fvSchemes|fvSolution|blockMeshDict)/i,
    category: 'system/ dict 缺失',
    causes: ['case 没准备完整（缺 controlDict/fvSchemes/fvSolution）', 'cwd 不在 case 目录'],
    steps: ['list_dir <case>/system 验证', '看是不是 cd 错地方了'] },
  { re: /keyword (\w+) is undefined in dictionary/i,
    category: 'dict keyword 缺失/拼错',
    causes: ['模板与求解器版本不匹配', 'fvSchemes/fvSolution 缺必填项', 'OpenFOAM 新版 keyword 改名'],
    steps: ['foam_find_tutorial 找同求解器同版本模板对照', 'foam_inspect_case 看真实可用 keyword 列表'] },
  { re: /unknown patch type|Unknown patchField type|unknown boundary condition/i,
    category: 'BC / patch 类型未注册',
    causes: ['BC 名拼错（如 nutkWallFunction 写成 nutWallFunction）', '需要的 lib 未在 controlDict.libs 链入', '求解器不支持该 BC'],
    steps: ['foam_find_source bc <name> 查正确写法', 'controlDict 末尾加 libs ("...")', 'case_probe_facts 看求解器实际兼容的 BC'] },
  { re: /dimensions of .* are not (correct|consistent|dimensionally)/i,
    category: '量纲不一致',
    causes: ['0/ 场 dimensions 错（k 应为 [0 2 -2 0 0 0 0]）', 'BC value 给的数字单位错', '0/ 与 0.orig/ 不同步'],
    steps: ['read_file 看出错场 dimensions 行', 'algo_extract_contract 看论文标的单位', '从 0.orig 重新 cp -r 0'] },
  { re: /Maximum number of iterations exceeded.*GAMG|smoothSolver.*did not converge|PCG.*did not converge/i,
    category: '线性求解器不收敛',
    causes: ['网格质量差 maxNonOrtho > 70', 'tolerance/relTol 过严', 'smoother 选错'],
    steps: ['checkMesh log tail 看 maxNonOrtho/skewness', '调 fvSolution: tolerance 放宽 / smoother→GaussSeidel / preconditioner→DIC'] },
  { re: /Inconsistent\s+addressing|negative volume|negative determinant|skewness exceeds/i,
    category: '网格坏点',
    causes: ['snappyHexMesh 抠空了某区域', '极薄 sliver cell', 'STL 法向反了'],
    steps: ['foam_mesh_verify(case_path, stage="final")', 'foam_mesh_stl_check(case_path, ref_stl, patches)', '提高 minVol / 减小 first_layer_thickness'] },
  { re: /Cannot find cellSet|Cannot find cellZone/i,
    category: 'setFields region 选择器失效',
    causes: ['boxToCell bbox 超出网格域', 'cellSet/cellZone 名拼错', '没先 setSet/topoSet'],
    steps: ['edit_file system/setFieldsDict 缩小 bbox 到网格范围', 'run_command("foamDictionary system/setFieldsDict") 验证'] },
  { re: /Maximum number of nonlinear iterations|Continuity error/i,
    category: '连续性 / p-U 耦合失衡',
    causes: ['PIMPLE nOuterCorrectors 不够', 'inlet/outlet 不通量守恒', 'atmosphere BC 类型错'],
    steps: ['加 nOuterCorrectors 到 3-5', 'case_probe_facts 看 patch 是否成对（一进一出）'] },
  { re: /undefined reference to|error: .*was not declared|fatal error: .*\.H: No such file/i,
    category: 'C++ 编译错',
    causes: ['头文件路径未在 Make/options 的 EXE_INC', '库未在 Make/options 的 LIB_LIBS', '类继承的虚函数没实现'],
    steps: ['foam_dry_compile <module> 抓首错', 'read_file Make/options 看 -I 和 -l', 'foam_find_source 看参考实现'] },
  { re: /signal\s+(11|SIGSEGV)|segmentation fault/i,
    category: 'SegFault',
    causes: ['内存越界（容器索引超界）', '并行 decompose 不一致', 'fvSchemes 含未注册 scheme 名'],
    steps: ['串行重跑（去掉 mpirun）复现', '看 fvSchemes 每行 scheme 名是否合法'] },
  { re: /not in patches|patches do not match|patches don't match/i,
    category: 'patch 名不匹配',
    causes: ['0/ 里 patch 名 ≠ polyMesh/boundary 里 patch 名', 'blockMesh 重生成后 0/ 未同步'],
    steps: ['foam_inspect_case 列实际 patch', '改 0/ 各场 boundaryField 对齐'] },
  { re: /Time step continuity errors.*sum local = [\d.eE+-]+, global = [\d.eE+-]+, cumulative/i,
    category: '质量守恒漂移',
    causes: ['inlet/outlet 通量不平衡', 'p BC 类型用错（应 zeroGradient 用了 fixedValue 等）'],
    steps: ['case_probe_facts 看入出口对应关系', 'foam_inspect_case 看 0/p 的 boundaryField'] },
  { re: /No such file or directory/i,
    category: '文件不存在',
    causes: ['路径写错', '上一步没生成（如 blockMesh 没跑就找 polyMesh）'],
    steps: ['list_dir 验证父目录', '看上一步 exit code'] },
  { re: /Floating point exception.*nan|Foam::error::printStack|FOAM aborting/i,
    category: 'OpenFOAM 主动 abort',
    causes: ['场含 nan 后求解器主动停', 'patch 配对错误'],
    steps: ['看 abort 前 50 行 log', 'diagnose_error 重新匹配上一段错误'] },
];

function diagnoseErrorText(text) {
  const s = String(text || '');
  if (!s.trim()) return { matched: false, hint: 'text 为空' };
  const hits = [];
  for (const p of ERROR_PATTERNS) {
    const m = s.match(p.re);
    if (m) hits.push({ category: p.category, matched_snippet: m[0].slice(0, 120), causes: p.causes, next_steps: p.steps });
  }
  if (!hits.length) {
    return { matched: false, hint: '未匹配已知模式（16 条）。\n建议：① 把 log tail 200 行回贴让模型逐行读；② 若是新错，记到 deviations.log.md；③ run_stage_done({passed:false,memo:...}) 转人工。' };
  }
  return { matched: true, count: hits.length, hits };
}

// 算法契约抽取（V8 四步法·步1）
async function algoExtractContract({ source_file, algorithm_name }) {
  const f = safePath(source_file);
  const ext = path.extname(source_file).toLowerCase();
  let raw = '';
  try { raw = await fs.readFile(f, 'utf8'); } catch (e) { throw new Error(`读取失败: ${e.message}`); }
  const contract = {
    algorithm: algorithm_name || path.basename(source_file, ext),
    source_file: source_file,
    source_kind: ext,
    inputs: [],
    outputs: [],
    equations: [],
    governing_type: null,
    assumes: { compressible: null, phases: null, turbulence: null, dimensions: null },
    raw_notes: []
  };
  // ---- .H / .C：抽 OpenFOAM 风格的类继承 + 关键虚函数签名 ----
  if (ext === '.h' || ext === '.c' || ext === '.cpp' || ext === '.cxx') {
    const inherit = raw.match(/class\s+(\w+)\s*:\s*public\s+([\w:]+)/);
    if (inherit) {
      contract.raw_notes.push(`class ${inherit[1]} : public ${inherit[2]}`);
      const base = inherit[2].toLowerCase();
      if (/dragmodel/.test(base)) { contract.governing_type = 'two-phase drag (Euler-Euler)'; contract.assumes.phases = 2; }
      else if (/turbulencemodel|rasmodel|lesmodel/.test(base)) { contract.governing_type = 'turbulence closure'; }
      else if (/phasemodel/.test(base)) { contract.governing_type = 'phase model'; contract.assumes.phases = 2; }
      else if (/fvpatchfield/.test(base)) { contract.governing_type = 'boundary condition'; }
      else if (/fvoption/.test(base)) { contract.governing_type = 'fvOption / source term'; }
    }
    // virtual function signatures: 返回类型 函数名(参数) const?
    const fnRe = /(?:virtual\s+)?(\w+(?:::\w+)*)\s+(\w+)\s*\(([^)]*)\)\s*(?:const)?\s*[{;]/g;
    let mm; let cnt = 0;
    while ((mm = fnRe.exec(raw)) !== null && cnt < 12) {
      const [, ret, name, params] = mm;
      if (/^(operator|if|for|while|switch|return)$/.test(name)) continue;
      if (/^[A-Z]\w*$/.test(name) && name === (inherit ? inherit[1] : '')) continue; // 构造函数
      contract.outputs.push({ name, return_type: ret, params: params.trim().slice(0, 200) });
      cnt++;
    }
    // 公式：捕获注释里的 ~ Eq. (N) 或 K = ... 这种行
    for (const line of raw.split(/\r?\n/)) {
      if (/\b(Eq\.?|Equation)\s*\(?\d/.test(line) || /^\s*\/\/\s*[A-Za-z_]+\s*=\s*/.test(line)) {
        const s = line.replace(/^\s*\/\/\s*/, '').trim();
        if (s && s.length < 200) contract.equations.push(s);
        if (contract.equations.length >= 8) break;
      }
    }
  } else if (ext === '.pdf') {
    contract.raw_notes.push('source 是 PDF —— 请配合 read_document 拿正文，再人工填 inputs/outputs/equations。本工具仅占位。');
  } else if (ext === '.py') {
    // 抽函数签名 + docstring 第一行
    const fnRe = /def\s+(\w+)\s*\(([^)]*)\):\s*(?:\n\s*"""([^"]+)""")?/g;
    let mm;
    while ((mm = fnRe.exec(raw)) !== null) {
      contract.outputs.push({ name: mm[1], params: mm[2], doc: (mm[3] || '').trim().slice(0, 200) });
      if (contract.outputs.length >= 10) break;
    }
  }
  // 全局关键字嗅探
  if (/compressible/i.test(raw)) contract.assumes.compressible = true;
  if (/incompressible/i.test(raw)) contract.assumes.compressible = false;
  if (/twoPhase|two-?phase|alpha\.water|alpha\.air/i.test(raw)) contract.assumes.phases = 2;
  if (/singlePhase|single-?phase/i.test(raw)) contract.assumes.phases = 1;
  for (const t of ['kEpsilon','kOmegaSST','SpalartAllmaras','LES','RAS','laminar']) {
    if (new RegExp(`\\b${t}\\b`).test(raw)) { contract.assumes.turbulence = t; break; }
  }
  contract.note = '⚠ 这是启发式抽取。`inputs/outputs` 来自函数签名；`equations` 来自注释行。**请人工核对一遍再当作契约用**。';
  return contract;
}

// case 体检（V8 四步法·步2）—— 返回 case 真实事实
async function caseProbeFacts({ case_path }) {
  const cd = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
  const facts = { case_path: case_path, solver: null, governing: null, compressible: null, phases: null, turbulence: null, dimensions_xyz: null, patches: [], fields_in_0: [], extras: {} };
  // controlDict.application
  try {
    const cd1 = await fs.readFile(path.join(cd, 'system/controlDict'), 'utf8');
    const m = cd1.match(/^\s*application\s+(\w+)\s*;/m);
    if (m) {
      facts.solver = m[1];
      const sv = m[1];
      // 求解器 → 物理类型映射（启发式）
      if (/^(simpleFoam|pimpleFoam|icoFoam)$/.test(sv)) { facts.governing = 'incompressible single-phase'; facts.compressible = false; facts.phases = 1; }
      else if (/^rho/.test(sv)) { facts.governing = 'compressible single-phase'; facts.compressible = true; facts.phases = 1; }
      else if (/^(interFoam|interIsoFoam|compressibleInterFoam)$/.test(sv)) { facts.governing = 'VOF two-phase'; facts.phases = 2; }
      else if (/twoPhaseEulerFoam|reactingTwoPhaseEulerFoam|multiphaseEulerFoam/.test(sv)) { facts.governing = 'Euler-Euler multi-phase'; facts.phases = 2; }
      else if (/buoyant/.test(sv)) { facts.governing = 'buoyant (T-coupled)'; }
    }
    const lm = cd1.match(/libs\s*\(([^)]+)\)/);
    if (lm) facts.extras.libs = lm[1].trim();
  } catch {}
  // turbulenceProperties
  try {
    const tp = await fs.readFile(path.join(cd, 'constant/turbulenceProperties'), 'utf8');
    const mm = tp.match(/RAS\s*\{[^}]*RASModel\s+(\w+)/) || tp.match(/LES\s*\{[^}]*LESModel\s+(\w+)/);
    if (mm) facts.turbulence = mm[1];
    else if (/simulationType\s+laminar/.test(tp)) facts.turbulence = 'laminar';
  } catch {}
  // blockMeshDict 维度
  try {
    const bm = await fs.readFile(path.join(cd, 'system/blockMeshDict'), 'utf8');
    const verts = [...bm.matchAll(/\(([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)\)/g)].slice(0, 8).map(m => m.slice(1, 4).map(Number));
    if (verts.length >= 8) {
      const xs = verts.map(v => v[0]), ys = verts.map(v => v[1]), zs = verts.map(v => v[2]);
      facts.dimensions_xyz = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs)].map(x => +x.toFixed(6));
    }
  } catch {}
  // 0/ 字段 + 任一字段读 patches
  try {
    const ents = await fs.readdir(path.join(cd, '0'));
    facts.fields_in_0 = ents.filter(n => !n.startsWith('.'));
    for (const fn of facts.fields_in_0.slice(0, 4)) {
      try {
        const txt = await fs.readFile(path.join(cd, '0', fn), 'utf8');
        const bf = txt.match(/boundaryField\s*\{([\s\S]*?)\n\}/);
        if (bf) {
          const patches = [...bf[1].matchAll(/^\s*(\w+)\s*\n?\s*\{/gm)].map(m => m[1]);
          if (patches.length > facts.patches.length) facts.patches = patches;
        }
      } catch {}
    }
  } catch {}
  // transportProperties 看物性（启发式抽 nu / rho / sigma）
  try {
    const tp = await fs.readFile(path.join(cd, 'constant/transportProperties'), 'utf8');
    const ex = {};
    for (const k of ['nu', 'rho', 'mu', 'sigma']) {
      const re = new RegExp(`\\b${k}\\s+\\[[^\\]]+\\]\\s+([-\\d.eE+]+)`);
      const mm = tp.match(re);
      if (mm) ex[k] = Number(mm[1]);
    }
    if (Object.keys(ex).length) facts.extras.transport = ex;
  } catch {}
  return facts;
}

// 契约 vs case 审计（V8 四步法·步3）
function algoCaseAudit({ contract, case_facts }) {
  const mismatches = [];
  const c = contract || {}, f = case_facts || {};
  const A = c.assumes || {};
  if (A.compressible != null && f.compressible != null && A.compressible !== f.compressible) {
    mismatches.push({ axis: '可压性', contract: A.compressible, case: f.compressible, severity: 'high',
      hint: 'compressible 假设不一致 → 算法的连续性方程会用错（ρ 是变量还是常量）' });
  }
  if (A.phases != null && f.phases != null && A.phases !== f.phases) {
    mismatches.push({ axis: '相数', contract: A.phases, case: f.phases, severity: 'high',
      hint: 'phases 不一致 → Euler-Euler 算法不能直接放进 VOF case，或反之' });
  }
  if (A.turbulence && f.turbulence && A.turbulence.toLowerCase() !== f.turbulence.toLowerCase() && !/laminar/i.test(f.turbulence)) {
    mismatches.push({ axis: '湍流模型', contract: A.turbulence, case: f.turbulence, severity: 'mid',
      hint: '湍流模型不一致 → 算法用到的湍流量（k, ε, ω, νt）可能不存在或定义不同' });
  }
  // governing_type vs solver family
  if (c.governing_type && f.governing) {
    const cgt = String(c.governing_type).toLowerCase();
    const fgt = String(f.governing).toLowerCase();
    if (cgt.includes('euler-euler') && fgt.includes('vof')) {
      mismatches.push({ axis: '控制方程族', contract: cgt, case: fgt, severity: 'high',
        hint: '契约要求 Euler-Euler，case 是 VOF（interFoam）→ 不能直接植入，需先换求解器或换模板 case' });
    }
    if (cgt.includes('compressible') && !fgt.includes('compressible')) {
      mismatches.push({ axis: '控制方程族', contract: cgt, case: fgt, severity: 'high',
        hint: '契约要求可压求解器，case 是不可压（如 simpleFoam）→ 求解器要换' });
    }
  }
  // 字段存在性：契约 outputs 里若有"K"/"alpha"等关键字段，看 0/ 是否有
  const fields0 = new Set(f.fields_in_0 || []);
  for (const o of (c.outputs || [])) {
    const n = String(o.name || '').toLowerCase();
    for (const target of ['k', 'omega', 'epsilon', 'nut', 'alpha.water', 'alpha.air', 't']) {
      if (n.includes(target) && !fields0.has(target.charAt(0).toUpperCase() + target.slice(1)) && !fields0.has(target)) {
        mismatches.push({ axis: '0/ 缺字段', contract: o.name, case: `0/ 无 ${target}`, severity: 'low',
          hint: `算法输出涉及 ${target}，但 0/ 里没有，需先建初值或换 case` });
        break;
      }
    }
  }
  return {
    pass: mismatches.length === 0,
    mismatch_count: mismatches.length,
    mismatches,
    verdict: mismatches.length === 0
      ? '✅ 契约与 case 兼容。可进入第 4 步受控植入。'
      : `❌ 发现 ${mismatches.length} 处不匹配。**禁止**进入第 4 步。先解决 mismatch 或得到用户豁免。`
  };
}

// 不连接的语法 / 包含检查（V8 四步法·步4 辅助）
async function foamDryCompile({ module_path }) {
  const mp = safePath(module_path);
  // 校验存在 Make/files + Make/options
  for (const need of ['Make/files', 'Make/options']) {
    try { await fs.stat(path.join(mp, need)); }
    catch { return `[foam_dry_compile] 缺 ${need}，不是合法 OpenFOAM 源码模块。`; }
  }
  // 列出 .C 文件
  const ents = await fs.readdir(mp);
  const sources = ents.filter(n => /\.C$/.test(n));
  if (!sources.length) return `[foam_dry_compile] ${mp} 下未发现 .C 源文件。`;
  // 简单语法检查：调 wmake，捕获第一个 error 行后立即返回
  const r = await _spawnP('bash', ['-c', `cd "${mp}" && (wmake 2>&1 || true) | head -120`], {});
  const out = r.out || r.err || '';
  if (!out.trim()) return '[foam_dry_compile] wmake 无输出。建议手动 `wmake libso` 看是否环境未 source。';
  const firstErr = out.split(/\r?\n/).findIndex(l => /error:|fatal error:|undefined reference/.test(l));
  if (firstErr === -1) return `[foam_dry_compile] ✅ 未捕获到首错（可能已编译通过或全是 warning）。\n--- wmake head ---\n${out}`;
  const ctx = out.split(/\r?\n/).slice(Math.max(0, firstErr - 3), firstErr + 6).join('\n');
  return `[foam_dry_compile] ❌ 首错（行 ${firstErr + 1}）：\n${ctx}\n\n建议下一步 diagnose_error 把这段传入。`;
}
// ====================== V8 辅助层结束 ======================

function safePath(p) {
  const target = path.resolve(WORKSPACE, p || '.');
  const rel = path.relative(WORKSPACE, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`路径越界：${p}`);
  return target;
}

// OpenFOAM 场文件保护：把 `nonuniform List<scalar|vector|tensor> N ( ...几百万个值... )`
// 折叠成 head/tail 样本 + 计数，避免单次 read_file 把上下文塞爆。
// boundaryField 段不受影响（在数组之外），照常返回。
function collapseFoamFieldBody(text) {
  const re = /nonuniform\s+List<([A-Za-z]+)>\s*\n?\s*(\d+)\s*\(/g;
  let out = '', lastEnd = 0, m, hits = 0;
  while ((m = re.exec(text)) !== null) {
    const startBody = m.index + m[0].length;
    // 配对 ')'，场体内可能含子括号（vector/tensor 用 (x y z)）
    let depth = 1, j = startBody;
    while (j < text.length && depth > 0) {
      const c = text[j];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      j++;
    }
    if (depth !== 0) break;
    const endBody = j - 1;
    const body = text.slice(startBody, endBody);
    const n = m[2];
    const head = body.slice(0, 240).replace(/\s+/g, ' ').trim();
    const tail = body.slice(-240).replace(/\s+/g, ' ').trim();
    out += text.slice(lastEnd, m.index);
    out += `nonuniform List<${m[1]}> ${n} ( /* [已折叠 internalField 数组：${body.length} B, ${n} 项]\n   head: ${head.slice(0,200)}\n   tail: ${tail.slice(-200)}\n*/ )`;
    lastEnd = j;
    re.lastIndex = j;
    hits++;
  }
  out += text.slice(lastEnd);
  return { text: out, hits };
}

function broadcastTodos(ws) { const s = sessions.get(ws); if (!s) return; ws.send(JSON.stringify({ type: 'todos', list: s.todos })); }
function broadcastEdits(ws) { const s = sessions.get(ws); if (!s) return; ws.send(JSON.stringify({ type: 'pending_edits', list: s.pendingEdits })); }
function broadcastCheckpoints(ws) { const s = sessions.get(ws); if (!s) return; ws.send(JSON.stringify({ type: 'checkpoints', list: s.checkpoints || [] })); }

function addPendingEdit(session, edit) {
  session.pendingEdits.push(edit);
  if (session.currentCheckpoint && !(edit.path in session.currentCheckpoint.files))
    session.currentCheckpoint.files[edit.path] = edit.oldContent;
}

// ====================== ParaView 窗口投影（核心新功能） ======================
//
// 思路：spawn 真正的 paraview GUI，记录其 PID，每隔 N ms 截取该窗口区域到 PNG
// 通过 WebSocket 推送给前端显示。Linux/Windows 各走一套实现。
//
const PV_STATE = { proc: null, pid: null, captureTimer: null, lastFrame: null, subscribers: new Set(), fps: 4, lastError: null, errorCount: 0, ready: false };

function pvBroadcast(obj) { const msg = JSON.stringify(obj); for (const ws of PV_STATE.subscribers) if (ws.readyState === 1) ws.send(msg); }

async function captureWindowsWindow(pid) {
  const tmp = path.join(os.tmpdir(), `pv_${process.pid}.png`);
  const outEsc = tmp.replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
if (-not ([System.Management.Automation.PSTypeName]'CMaxW').Type) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CMaxW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
}
function Find-PvWindow($targetPid) {
  $found = $null; $best = 0
  $cb = [CMaxW+EnumProc]{ param($h,$l)
    $opid = 0
    [void][CMaxW]::GetWindowThreadProcessId($h, [ref]$opid)
    if ($opid -ne $targetPid) { return $true }
    if (-not [CMaxW]::IsWindowVisible($h)) { return $true }
    if ([CMaxW]::GetParent($h) -ne [IntPtr]::Zero) { return $true }
    $tl = [CMaxW]::GetWindowTextLength($h)
    $r = New-Object CMaxW+RECT
    [void][CMaxW]::GetWindowRect($h, [ref]$r)
    $area = ($r.R - $r.L) * ($r.B - $r.T)
    # 取面积最大的可见顶层窗口（避开 splash / 子对话）
    $score = $area + ($tl * 100)
    if ($script:best -lt $score) { $script:best = $score; $script:found = $h }
    return $true
  }
  $script:best = 0; $script:found = [IntPtr]::Zero
  [void][CMaxW]::EnumWindows($cb, [IntPtr]::Zero)
  return $script:found
}
try {
  $h = Find-PvWindow ${pid}
  if ($h -eq $null -or $h -eq [IntPtr]::Zero) {
    # 兜底：尝试子进程
    Get-Process | Where-Object { $_.Parent.Id -eq ${pid} -or $_.Id -eq ${pid} } | ForEach-Object {
      if ($h -eq $null -or $h -eq [IntPtr]::Zero) {
        $sub = Find-PvWindow $_.Id
        if ($sub -ne $null -and $sub -ne [IntPtr]::Zero) { $h = $sub }
      }
    }
  }
  if ($h -eq $null -or $h -eq [IntPtr]::Zero) { Write-Error 'NO_WINDOW'; exit 2 }
  if ([CMaxW]::IsIconic($h)) { [void][CMaxW]::ShowWindowAsync($h, 9); Start-Sleep -Milliseconds 200 }
  $r = New-Object CMaxW+RECT
  [void][CMaxW]::GetWindowRect($h, [ref]$r)
  $w = $r.R - $r.L; $hh = $r.B - $r.T
  if ($w -le 0 -or $hh -le 0) { Write-Error 'ZERO_SIZE'; exit 3 }
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  # PW_RENDERFULLCONTENT = 0x00000002（Win8.1+，能抓 OpenGL/DWM 合成内容）
  $ok = [CMaxW]::PrintWindow($h, $hdc, 0x2)
  $g.ReleaseHdc($hdc)
  if (-not $ok) {
    # 兜底：屏幕拷贝
    $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size $w, $hh))
  }
  $g.Dispose()
  $bmp.Save('${outEsc}', [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
} catch { Write-Error $_; exit 9 }
`;
  return await new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true });
    let err = '';
    ps.stderr.on('data', d => err += d);
    const to = setTimeout(() => { try { ps.kill(); } catch {} }, 4000);
    ps.on('close', async (code) => {
      clearTimeout(to);
      if (code !== 0) {
        const tag = code === 2 ? '未找到顶层窗口' : code === 3 ? '窗口尺寸为 0' : 'PowerShell 异常';
        return reject(new Error(`${tag} (code=${code}) ${err.replace(/\s+/g,' ').slice(0,200)}`));
      }
      try { resolve(await fs.readFile(tmp)); } catch (e) { reject(e); }
    });
    ps.on('error', reject);
    ps.stdin.end(script);
  });
}

async function captureLinuxWindow(pid) {
  const tmp = path.join(os.tmpdir(), `pv_${process.pid}.png`);
  // 用 xdotool 找窗口 → import 抓
  const wid = await new Promise((res) => {
    const p = spawn('xdotool', ['search', '--pid', String(pid)]);
    let o = ''; p.stdout.on('data', d => o += d);
    p.on('close', () => { const ids = o.trim().split('\n').filter(Boolean); res(ids[ids.length - 1] || null); });
    p.on('error', () => res(null));
  });
  if (!wid) throw new Error('xdotool 找不到 ParaView 窗口（请安装 xdotool 与 imagemagick）');
  await new Promise((res, rej) => {
    const p = spawn('import', ['-window', wid, tmp]);
    p.on('close', c => c === 0 ? res() : rej(new Error('import 失败')));
    p.on('error', rej);
  });
  return await fs.readFile(tmp);
}

async function captureParaViewFrame() {
  if (!PV_STATE.pid) return null;
  try {
    const buf = IS_WIN ? await captureWindowsWindow(PV_STATE.pid) : await captureLinuxWindow(PV_STATE.pid);
    if (PV_STATE.lastError) { PV_STATE.lastError = null; PV_STATE.errorCount = 0; pvBroadcast({ type: 'term', line: '[ParaView 投影已恢复]' }); }
    return 'data:image/png;base64,' + buf.toString('base64');
  } catch (e) {
    const msg = String(e.message || e).slice(0, 240);
    if (msg !== PV_STATE.lastError) {
      PV_STATE.lastError = msg;
      PV_STATE.errorCount = 0;
      pvBroadcast({ type: 'term', line: '[ParaView 抓帧失败] ' + msg });
      pvBroadcast({ type: 'sim_error', message: msg });
    } else {
      PV_STATE.errorCount++;
      if (PV_STATE.errorCount === 5) pvBroadcast({ type: 'term', line: '[ParaView 抓帧持续失败 ×5，已静音同类报错]' });
    }
    return null;
  }
}

function startParaViewCapture() {
  if (PV_STATE.captureTimer) return;
  const interval = Math.max(150, Math.round(1000 / PV_STATE.fps));
  PV_STATE.captureTimer = setInterval(async () => {
    if (PV_STATE.subscribers.size === 0) return;
    const frame = await captureParaViewFrame();
    if (!frame) return;
    PV_STATE.lastFrame = frame;
    const msg = JSON.stringify({ type: 'sim_frame', dataUrl: frame });
    for (const ws of PV_STATE.subscribers) if (ws.readyState === 1) ws.send(msg);
  }, interval);
}
function stopParaViewCapture() {
  if (PV_STATE.captureTimer) { clearInterval(PV_STATE.captureTimer); PV_STATE.captureTimer = null; }
}

async function launchParaView(casePath) {
  if (!SETTINGS.paraviewExe) throw new Error('未配置 ParaView 主程序路径，请到 ⚙ 设置中填入（如 paraview.exe 或 /usr/bin/paraview）');
  // 已在运行 → 重用
  if (PV_STATE.proc && !PV_STATE.proc.killed) {
    return { reused: true, pid: PV_STATE.pid };
  }
  const args = [];
  if (casePath) {
    let target = path.isAbsolute(casePath) ? casePath : path.resolve(WORKSPACE, casePath);
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) {
        const foam = path.join(target, 'case.foam');
        try { await fs.access(foam); } catch { await fs.writeFile(foam, '', 'utf8'); }
        target = foam;
      }
    } catch {}
    args.push(`--data=${target}`);
  }
  const proc = spawn(SETTINGS.paraviewExe, args, { detached: false, stdio: 'ignore', windowsHide: false });
  PV_STATE.proc = proc; PV_STATE.pid = proc.pid; PV_STATE.ready = false; PV_STATE.lastError = null; PV_STATE.errorCount = 0;
  proc.on('exit', () => { PV_STATE.proc = null; PV_STATE.pid = null; PV_STATE.lastFrame = null; PV_STATE.ready = false;
    for (const ws of PV_STATE.subscribers) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'sim_closed' })); });
  // 等窗口就位（最多 12s）
  pvBroadcast({ type: 'term', line: `[ParaView 启动中 PID=${proc.pid}，等待窗口…]` });
  (async () => {
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (!PV_STATE.proc) return;
      try {
        const buf = IS_WIN ? await captureWindowsWindow(PV_STATE.pid) : await captureLinuxWindow(PV_STATE.pid);
        if (buf) { PV_STATE.ready = true; pvBroadcast({ type: 'term', line: '[ParaView 窗口已就位，开始投影]' }); return; }
      } catch {}
    }
    pvBroadcast({ type: 'term', line: '[警告] 12s 内未抓到 ParaView 窗口；将持续重试。可手动把 ParaView 窗口拖到前台一次。' });
  })();
  startParaViewCapture();
  return { reused: false, pid: proc.pid };
}

function killParaView() {
  if (PV_STATE.proc) { try { PV_STATE.proc.kill(); } catch {} }
  stopParaViewCapture();
}

// ====================== 跨平台交互终端（每会话一个 shell） ======================
function spawnShell(cwd) {
  if (IS_WIN) return spawn(process.env.COMSPEC || 'cmd.exe', ['/Q'], { cwd, env: process.env });
  return spawn(process.env.SHELL || '/bin/bash', ['-i'], { cwd, env: process.env });
}

// ====================== OpenFOAM 命令（agent 调用） ======================
async function runOpenFoam({ casePath, command }, ws) {
  const cd = path.isAbsolute(casePath) ? casePath : path.resolve(WORKSPACE, casePath);
  let shell, shellArgs;
  if (IS_WIN && SETTINGS.openfoamBash) {
    shell = 'cmd.exe';
    shellArgs = ['/c', `call "${SETTINGS.openfoamBash}" && cd /d "${cd}" && ${command}`];
  } else if (IS_WIN) {
    shell = 'cmd.exe'; shellArgs = ['/c', `cd /d "${cd}" && ${command}`];
  } else {
    // Linux/Mac：优先用用户设置的 openfoamBash，其次 $FOAM_BASH，再试从 foamRoot/etc/bashrc 推断
    let bashrc = SETTINGS.openfoamBash || '';
    if (!bashrc && SETTINGS.foamRoot) {
      const cand = path.join(SETTINGS.foamRoot, 'etc', 'bashrc');
      try { if ((await fs.stat(cand)).isFile()) bashrc = cand; } catch {}
    }
    const sourceLine = bashrc ? `source "${bashrc}"` : `source "$FOAM_BASH" 2>/dev/null || true`;
    shell = 'bash'; shellArgs = ['-c', `cd "${cd}" && (${sourceLine}); ${command}`];
  }
  return await new Promise((resolve) => {
    ws.send(JSON.stringify({ type: 'term', line: `$ [OF] ${command}  (${cd})` }));
    const child = spawn(shell, shellArgs, { cwd: cd });
    let out = '';
    const onData = d => { const s = d.toString(); out += s; s.split(/\r?\n/).forEach(l => l && ws.send(JSON.stringify({ type: 'term', line: l }))); };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    const t = setTimeout(() => { try { child.kill(); } catch {} }, 600000);
    child.on('close', code => { clearTimeout(t); ws.send(JSON.stringify({ type: 'term', line: `[退出码 ${code}]` })); resolve(`[退出码 ${code}]\n${out.slice(0, 50000)}`); });
    child.on('error', err => { clearTimeout(t); resolve(`[启动失败] ${err.message}`); });
  });
}

// ====================== OpenFOAM Beta：教程/源码/克隆/检查 ======================
function foamRoot() {
  const r = SETTINGS.foamRoot && String(SETTINGS.foamRoot).trim();
  if (!r) throw new Error('未设置 OpenFOAM 根目录。请在右侧 "OpenFOAM (Beta)" 面板填写，或 POST /api/foam/config {root}');
  return r;
}
async function pathExists(p) { try { await fs.access(p); return true; } catch { return false; } }

// 递归走目录，回调 (relPath, absPath, dirent) for file/dir
async function walkDir(root, onEntry, opts = {}) {
  const maxDepth = opts.maxDepth ?? 8;
  const skip = new Set(['.git', '.svn', 'node_modules', 'doc', 'doxygen', '.lib-openmpi', 'lnInclude', 'linux64GccDPInt32Opt', 'linux64GccDPInt64Opt', 'linux64Gcc', '.idea']);
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let ents = [];
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (skip.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      try {
        const stop = await onEntry(rel, abs, e);
        if (stop === 'stop') return;
      } catch {}
      if (e.isDirectory() && depth < maxDepth) stack.push({ dir: abs, depth: depth + 1 });
    }
  }
}

async function foamFindTutorial(query, topK = 12) {
  const root = foamRoot();
  const tutDir = path.join(root, 'tutorials');
  if (!await pathExists(tutDir)) throw new Error(`未找到 tutorials/ 目录：${tutDir}`);
  const q = String(query || '').toLowerCase().split(/[\s,/]+/).filter(Boolean);
  const hits = [];
  await walkDir(tutDir, async (rel, abs, e) => {
    if (!e.isDirectory()) return;
    // case 目录的判定：含 system/controlDict
    if (await pathExists(path.join(abs, 'system', 'controlDict'))) {
      const lower = rel.toLowerCase().replace(/\\/g, '/');
      let score = 0;
      for (const t of q) if (lower.includes(t)) score += 10;
      // 每段命中加权
      const segs = lower.split('/');
      for (const t of q) for (const s of segs) if (s === t) score += 5;
      if (q.length === 0 || score > 0) hits.push({ rel: rel.replace(/\\/g, '/'), abs, score });
      return; // 不再深入 case 内部找子 case
    }
  }, { maxDepth: 8 });
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, topK);
  if (!top.length) return `未找到匹配教程：${query}\n建议在 ${tutDir} 下手动浏览。`;
  return `[foam_find_tutorial] "${query}" → ${top.length} 条候选（按相关度）：\n` +
    top.map((h, i) => `${i+1}. ${h.rel}\n   绝对路径：${h.abs}`).join('\n');
}

async function foamFindSource(query, kind = 'all', topK = 12) {
  const root = foamRoot();
  const q = String(query || '').toLowerCase();
  if (!q) throw new Error('query 必填');
  // 选搜索根
  const roots = [];
  if (kind === 'solver' || kind === 'all') roots.push(path.join(root, 'applications', 'solvers'));
  if (kind === 'model' || kind === 'all')  roots.push(path.join(root, 'src'));
  if (kind === 'bc' || kind === 'all')     roots.push(path.join(root, 'src', 'finiteVolume', 'fields', 'fvPatchFields'));
  if (kind === 'all') roots.push(path.join(root, 'applications', 'utilities'));
  const hits = [];
  for (const base of roots) {
    if (!await pathExists(base)) continue;
    await walkDir(base, async (rel, abs, e) => {
      if (!e.isFile()) return;
      const name = e.name;
      const ext = path.extname(name).toLowerCase();
      if (!['.h', '.hpp', '.c', '.cpp', '.cxx', '.h.in', ''].includes(ext) && !['files','options'].includes(name)) return;
      const lower = name.toLowerCase();
      let score = 0;
      if (lower.includes(q)) score += 10;
      // 文件名片段精确匹配（大小写不敏感）
      const baseName = path.basename(name, ext).toLowerCase();
      if (baseName === q) score += 30;
      if (score > 0) hits.push({ rel: path.relative(root, abs).replace(/\\/g, '/'), abs, score, base: path.basename(base) });
    }, { maxDepth: 10 });
  }
  hits.sort((a, b) => b.score - a.score);
  const top = hits.slice(0, topK);
  if (!top.length) return `未找到匹配源码：${query} (kind=${kind})`;
  return `[foam_find_source] "${query}" kind=${kind} → ${top.length} 条候选：\n` +
    top.map((h, i) => `${i+1}. [${h.base}] ${h.rel}\n   绝对路径：${h.abs}`).join('\n');
}

async function foamCloneTutorial(tutorialPath, dest) {
  const root = foamRoot();
  if (!tutorialPath || !dest) throw new Error('tutorial_path 和 dest 必填');
  let src = tutorialPath;
  if (!path.isAbsolute(src)) src = path.join(root, 'tutorials', tutorialPath);
  if (!await pathExists(src)) throw new Error(`tutorial 不存在：${src}`);
  if (!await pathExists(path.join(src, 'system', 'controlDict'))) {
    return `警告：${src} 看起来不是一个 case 目录（缺 system/controlDict），未复制。请先用 foam_find_tutorial 定位到具体 case。`;
  }
  const target = safePath(dest);
  await fs.mkdir(target, { recursive: true });
  // 用 fs.cp（Node 16.7+）递归复制
  await fs.cp(src, target, { recursive: true, force: false, errorOnExist: false });
  return `已复制 tutorial：\n  源：${src}\n  目标：${path.relative(WORKSPACE, target)}\n建议下一步：foam_inspect_case("${path.relative(WORKSPACE, target)}")`;
}

// 解析 boundaryField { patch { type X; ... } }
function parseBoundaryField(text) {
  const out = {};
  const m = text.match(/boundaryField\s*\{([\s\S]*)\}/);
  if (!m) return out;
  const body = m[1];
  // 简化：找形如 patchName\s*{...} 的块（一层大括号匹配）
  let i = 0;
  while (i < body.length) {
    // 跳空白与注释
    while (i < body.length && /[\s\n\r]/.test(body[i])) i++;
    if (body[i] === '/' && body[i+1] === '/') { while (i < body.length && body[i] !== '\n') i++; continue; }
    if (body[i] === '/' && body[i+1] === '*') { i += 2; while (i < body.length && !(body[i] === '*' && body[i+1] === '/')) i++; i += 2; continue; }
    if (i >= body.length) break;
    // 读 patch 名
    const nameMatch = body.slice(i).match(/^([A-Za-z_][\w\.]*)/);
    if (!nameMatch) { i++; continue; }
    const pname = nameMatch[1];
    i += nameMatch[0].length;
    while (i < body.length && /[\s\n\r]/.test(body[i])) i++;
    if (body[i] !== '{') continue;
    // 一层大括号匹配
    let depth = 1; i++; const start = i;
    while (i < body.length && depth) { if (body[i] === '{') depth++; else if (body[i] === '}') depth--; if (depth) i++; }
    const block = body.slice(start, i);
    i++; // skip '}'
    const typeM = block.match(/\btype\s+([A-Za-z][\w]*)\s*;/);
    out[pname] = { type: typeM ? typeM[1] : '?', raw: block.trim().slice(0, 200) };
  }
  return out;
}

async function foamInspectCase(casePath) {
  if (!casePath) throw new Error('case_path 必填');
  const cd = path.isAbsolute(casePath) ? casePath : safePath(casePath);
  if (!await pathExists(cd)) throw new Error(`case 不存在：${cd}`);
  const lines = [`# 算例检查：${path.relative(WORKSPACE, cd) || cd}`];
  // 1) 列三大目录
  for (const d of ['0', 'constant', 'system']) {
    const dd = path.join(cd, d);
    if (!await pathExists(dd)) { lines.push(`\n## ${d}/  (不存在)`); continue; }
    const items = (await fs.readdir(dd, { withFileTypes: true })).map(e => e.name + (e.isDirectory()?'/':''));
    lines.push(`\n## ${d}/  (${items.length} 项)\n  ${items.join('  ')}`);
  }
  // 2) controlDict 摘要
  try {
    const cd_text = await fs.readFile(path.join(cd, 'system', 'controlDict'), 'utf8');
    const grab = (k) => (cd_text.match(new RegExp(`\\b${k}\\s+([^;\\n]+);`)) || [])[1] || '';
    lines.push(`\n## system/controlDict 关键项`);
    ['application','startTime','endTime','deltaT','writeInterval','writeControl','adjustTimeStep','maxCo'].forEach(k => {
      const v = grab(k); if (v) lines.push(`  ${k} = ${v.trim()}`);
    });
  } catch {}
  // 3) constant 关键 dict
  try {
    const ents = await fs.readdir(path.join(cd, 'constant'), { withFileTypes: true });
    const keyDicts = ents.filter(e => /Properties$|^transportProperties$|^turbulenceProperties$|^thermophysicalProperties$|^phaseProperties$|^MRFProperties$/.test(e.name)).map(e => e.name);
    if (keyDicts.length) {
      lines.push(`\n## constant/ 关键 dict`);
      for (const k of keyDicts.slice(0, 6)) {
        const t = await fs.readFile(path.join(cd, 'constant', k), 'utf8').catch(()=>'');
        lines.push(`  • ${k}：` + (t.slice(0, 240).replace(/\s+/g,' ')) + (t.length > 240 ? '…' : ''));
      }
    }
  } catch {}
  // 4) 0/ boundary 摘要
  try {
    const fields = (await fs.readdir(path.join(cd, '0'))).filter(n => !n.startsWith('.'));
    if (fields.length) {
      lines.push(`\n## 0/ 边界条件矩阵`);
      const matrix = {};
      const allPatches = new Set();
      for (const f of fields) {
        try {
          const txt = await fs.readFile(path.join(cd, '0', f), 'utf8');
          matrix[f] = parseBoundaryField(txt);
          Object.keys(matrix[f]).forEach(p => allPatches.add(p));
        } catch {}
      }
      const patches = [...allPatches];
      lines.push(`  patch \\ field   ${fields.map(f => f.padEnd(8)).join(' ')}`);
      for (const p of patches) {
        lines.push(`  ${p.padEnd(15)} ${fields.map(f => (matrix[f]?.[p]?.type || '-').padEnd(8)).join(' ')}`);
      }
    }
  } catch {}
  // 5) fvSchemes / fvSolution 摘要
  for (const f of ['fvSchemes','fvSolution']) {
    try {
      const t = await fs.readFile(path.join(cd, 'system', f), 'utf8');
      lines.push(`\n## system/${f}（前 280 字符）\n  ${t.slice(0, 280).replace(/\s+/g,' ')}…`);
    } catch {}
  }
  // 6) 完整文件树（递归）
  try {
    lines.push(`\n## 完整文件清单（递归）`);
    const all = [];
    await walkDir(cd, async (rel, abs, e) => {
      if (e.isDirectory()) return;
      let sz = 0; try { sz = (await fs.stat(abs)).size; } catch {}
      all.push({ rel: rel.replaceAll('\\','/'), size: sz });
    }, { maxDepth: 6 });
    all.sort((a,b) => a.rel.localeCompare(b.rel));
    for (const x of all.slice(0, 200)) lines.push(`  ${x.rel}  (${x.size}B)`);
    if (all.length > 200) lines.push(`  …(共 ${all.length} 文件，省略 ${all.length-200} 项)`);
  } catch {}
  return lines.join('\n');
}

// ====================== OpenFOAM 求解器异步监测 ======================
const SOLVER_RUNS = new Map();  // runId -> { proc, casePath, command, log:[], started, ended, exitCode, subs:Set<ws> }

async function foamRunSolverAsync({ case_path, command }, ws) {
  if (!case_path) throw new Error('case_path 必填');
  if (!command) throw new Error('command 必填');
  const cd = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
  const runId = crypto.randomBytes(4).toString('hex');
  const isWin = IS_WIN;
  let shell, shellArgs;
  if (isWin && SETTINGS.openfoamBash) {
    shell = 'cmd.exe'; shellArgs = ['/c', `call "${SETTINGS.openfoamBash}" && cd /d "${cd}" && ${command}`];
  } else if (isWin) {
    shell = 'cmd.exe'; shellArgs = ['/c', `cd /d "${cd}" && ${command}`];
  } else {
    let bashrc = SETTINGS.openfoamBash || '';
    if (!bashrc && SETTINGS.foamRoot) {
      const cand = path.join(SETTINGS.foamRoot, 'etc', 'bashrc');
      try { if ((await fs.stat(cand)).isFile()) bashrc = cand; } catch {}
    }
    const sourceLine = bashrc ? `source "${bashrc}"` : `source "$FOAM_BASH" 2>/dev/null || true`;
    shell = 'bash'; shellArgs = ['-c', `cd "${cd}" && (${sourceLine}); ${command}`];
  }
  const proc = spawn(shell, shellArgs, { cwd: cd });
  const run = { runId, proc, casePath: cd, command, log: [], started: Date.now(), ended: 0, exitCode: null, subs: new Set() };
  SOLVER_RUNS.set(runId, run);
  const onData = d => {
    const s = d.toString();
    s.split(/\r?\n/).forEach(l => { if (l) { run.log.push(l); if (run.log.length > 4000) run.log.splice(0, run.log.length - 4000); } });
    // 即时推送给订阅者
    for (const sub of run.subs) if (sub.readyState === 1) {
      sub.send(JSON.stringify({ type: 'solver_log', runId, lines: s.split(/\r?\n/).filter(Boolean) }));
    }
    // 也广播到所有连接的终端，方便用户在主终端里看到长任务的实时输出
    try {
      const tag = `[OF ${runId}]`;
      const lines = s.split(/\r?\n/).filter(Boolean);
      for (const l of lines) {
        const msg = JSON.stringify({ type: 'term', line: `${tag} ${l}` });
        for (const c of allClients) if (c.readyState === 1) c.send(msg);
      }
    } catch {}
  };
  // 限制单行长度，避免恶意/异常进程把单行刷成 GB
  const MAX_LINE_CHARS = 2000;
  const _origPush = run.log.push.bind(run.log);
  run.log.push = function(line) { return _origPush(line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + ' …[行过长截断]' : line); };
  proc.stdout.on('data', onData); proc.stderr.on('data', onData);
  proc.on('close', code => { run.ended = Date.now(); run.exitCode = code;
    for (const sub of run.subs) if (sub.readyState === 1) sub.send(JSON.stringify({ type: 'solver_done', runId, exitCode: code }));
    try {
      const msg = JSON.stringify({ type: 'runs_update', reason: 'solver_ended', runId });
      for (const c of allClients) if (c.readyState === 1) c.send(msg);
    } catch {}
  });
  proc.on('error', err => { run.ended = Date.now(); run.exitCode = -1; run.log.push('[启动失败] ' + err.message); });
  if (ws) run.subs.add(ws);
  // 启动时广播 runs_update
  try {
    const msg = JSON.stringify({ type: 'runs_update', reason: 'solver_started', runId });
    for (const c of allClients) if (c.readyState === 1) c.send(msg);
  } catch {}
  return `[已启动求解器]\n  runId: ${runId}\n  case:  ${cd}\n  cmd:   ${command}\n请用前端"求解器监测"面板订阅 runId=${runId}，或调用 foam_solver_status(${runId}) 轮询。`;
}

function foamSolverStatus(runId) {
  const run = SOLVER_RUNS.get(runId);
  if (!run) return '[未知 runId]';
  const lines = run.log;
  const tail = lines.slice(-40);
  // 解析时间步：Time = 0.001
  let lastTime = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^Time\s*=\s*([\d.eE+\-]+)/);
    if (m) { lastTime = m[1]; break; }
  }
  // 解析残差：Solving for X, Initial residual = 0.123, Final residual = 1e-7, No Iterations N
  const resLines = lines.filter(l => /Initial residual/.test(l)).slice(-20);
  const status = run.ended ? `已结束(exit=${run.exitCode})` : `运行中`;
  const dur = ((run.ended || Date.now()) - run.started) / 1000;
  return [
    `runId: ${runId}    状态: ${status}    用时: ${dur.toFixed(1)}s`,
    `case:  ${run.casePath}`,
    `cmd:   ${run.command}`,
    `当前 Time: ${lastTime || '(未识别)'}`,
    `\n--- 最近残差 (20 行) ---`,
    ...resLines,
    `\n--- 日志 tail (40 行) ---`,
    ...tail
  ].join('\n');
}

function foamSolverStop(runId) {
  const run = SOLVER_RUNS.get(runId);
  if (!run) return '[未知 runId]';
  if (run.ended) return '[已结束]';
  try { run.proc.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { run.proc.kill('SIGKILL'); } catch {} }, 3000);
  return `[已发送终止信号 runId=${runId}]`;
}

// ====================== 进度估算（求解器 Time / snappyHexMesh 阶段） ======================
async function _readEndTimeFromControlDict(casePath) {
  try {
    const cd = path.join(casePath, 'system', 'controlDict');
    const txt = await fs.readFile(cd, 'utf8');
    const m = txt.match(/^\s*endTime\s+([\d.eE+\-]+)\s*;/m);
    const m2 = txt.match(/^\s*startTime\s+([\d.eE+\-]+)\s*;/m);
    return { endTime: m ? Number(m[1]) : null, startTime: m2 ? Number(m2[1]) : 0 };
  } catch { return { endTime: null, startTime: 0 }; }
}

// 判断当前 command 属于哪一类工具：solver / snappy / blockMesh / 其他
function _classifyFoamCommand(cmd) {
  const s = String(cmd || '').toLowerCase();
  if (/snappyhexmesh/.test(s)) return 'snappy';
  if (/blockmesh|surfacefeature|extrudemesh|topo/.test(s)) return 'mesher';
  if (/foam$|simple|pimple|piso|ico|inter|rho|chthsf|laplacian|scalartransport|reactingfoam|interisofoam|dnsfoam|sonicfoam|buoyant/.test(s)) return 'solver';
  return 'other';
}

// snappyHexMesh 三大阶段的标志
function _snappyPhase(log) {
  // 反向扫描最近 200 行，找最新的阶段
  const tail = log.slice(-400);
  let phase = 'starting', percent = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const l = tail[i];
    if (/Layer addition iteration/i.test(l) || /Doing final layer addition/i.test(l) || /Layer addition phase/i.test(l)) { phase = 'layer'; percent = 85; break; }
    if (/Shell refinement iteration|Surface refinement iteration|Refinement phase/i.test(l)) { phase = 'castellated'; percent = 30; break; }
    if (/Morph iteration|Snapping iteration|Snapping phase/i.test(l)) { phase = 'snap'; percent = 65; break; }
    if (/Adding patches/i.test(l)) { phase = 'finalize'; percent = 95; break; }
  }
  if (/^Finished meshing/m.test(tail.join('\n'))) { phase = 'done'; percent = 100; }
  return { phase, percent };
}

async function _computeRunProgress(run) {
  const cls = _classifyFoamCommand(run.command);
  const wallSec = ((run.ended || Date.now()) - run.started) / 1000;
  const out = { kind: cls, wallSec, percent: null, phase: null, currentTime: null, endTime: null, etaSec: null, simRate: null };
  if (cls === 'solver') {
    // 缓存 endTime
    if (run._endTime === undefined) {
      const r = await _readEndTimeFromControlDict(run.casePath);
      run._endTime = r.endTime; run._startTime = r.startTime;
    }
    out.endTime = run._endTime;
    // 找出所有 Time = X 出现的位置，估算 sim/wall 速率
    let firstTime = null, lastTime = null, firstWall = null, lastWall = null;
    // 我们没有逐行时间戳；用 run.started 当起点，比例插值
    for (let i = run.log.length - 1; i >= 0; i--) {
      const m = run.log[i].match(/^Time\s*=\s*([\d.eE+\-]+)/);
      if (m) { lastTime = Number(m[1]); break; }
    }
    for (let i = 0; i < run.log.length; i++) {
      const m = run.log[i].match(/^Time\s*=\s*([\d.eE+\-]+)/);
      if (m) { firstTime = Number(m[1]); break; }
    }
    out.currentTime = lastTime;
    if (lastTime != null && out.endTime != null && out.endTime > (run._startTime || 0)) {
      const total = out.endTime - (run._startTime || 0);
      const done  = lastTime - (run._startTime || 0);
      if (total > 0 && done >= 0) out.percent = Math.min(100, Math.max(0, (done / total) * 100));
      // 简单速率：(lastTime - firstTime) / wallSec
      if (firstTime != null && lastTime > firstTime && wallSec > 1) {
        const simRate = (lastTime - firstTime) / wallSec;  // sim_time per wall_sec
        out.simRate = simRate;
        if (simRate > 0) out.etaSec = Math.max(0, (out.endTime - lastTime) / simRate);
      }
    }
    out.phase = run.ended ? 'finished' : 'running';
  } else if (cls === 'snappy') {
    const ph = _snappyPhase(run.log);
    out.phase = ph.phase; out.percent = ph.percent;
    // 经验 ETA：根据已用时间和当前阶段反推
    const phaseFraction = ph.percent / 100;
    if (phaseFraction > 0.05 && !run.ended) {
      out.etaSec = Math.max(0, wallSec * (1 - phaseFraction) / phaseFraction);
    }
  } else if (cls === 'mesher') {
    out.phase = run.ended ? 'finished' : 'running';
    // blockMesh 通常很快，没有可靠进度，给个占位
    out.percent = run.ended ? 100 : null;
  } else {
    out.phase = run.ended ? 'finished' : 'running';
  }
  return out;
}

// ============== STL 几何检查（ASCII / Binary 自动识别）==============
// ============== 几何工具：射线-三角形相交 + 点是否在 STL 内 ==============
// Möller–Trumbore 算法，返回 true 表示与三角形相交（从 ray 原点沿 +X 方向）
function _rayHitsTriPlusX(p, t) {
  const EPS = 1e-12;
  const v0 = t[0], v1 = t[1], v2 = t[2];
  // ray 方向 (1,0,0)
  const e1 = [v1[0]-v0[0], v1[1]-v0[1], v1[2]-v0[2]];
  const e2 = [v2[0]-v0[0], v2[1]-v0[1], v2[2]-v0[2]];
  // h = dir × e2 = (0,0,0)×e2 = (0*e2[2]-0*e2[1], 0*e2[0]-1*e2[2], 1*e2[1]-0*e2[0]) = (0, -e2[2], e2[1])
  const h = [0, -e2[2], e2[1]];
  const a = e1[0]*h[0] + e1[1]*h[1] + e1[2]*h[2];
  if (Math.abs(a) < EPS) return false;
  const fInv = 1/a;
  const s = [p[0]-v0[0], p[1]-v0[1], p[2]-v0[2]];
  const u = fInv * (s[0]*h[0] + s[1]*h[1] + s[2]*h[2]);
  if (u < 0 || u > 1) return false;
  // q = s × e1
  const q = [s[1]*e1[2]-s[2]*e1[1], s[2]*e1[0]-s[0]*e1[2], s[0]*e1[1]-s[1]*e1[0]];
  // v = fInv * (dir · q) = fInv * q[0]
  const v = fInv * q[0];
  if (v < 0 || u + v > 1) return false;
  // t = fInv * (e2 · q)
  const tHit = fInv * (e2[0]*q[0] + e2[1]*q[1] + e2[2]*q[2]);
  return tHit > EPS;
}
function _pointInsideMesh(tris, p) {
  let hits = 0;
  for (const t of tris) if (_rayHitsTriPlusX(p, t)) hits++;
  return (hits & 1) === 1;
}
// 在 bbox 网格上采样找最优"内部种子"和"外部种子"（外部=离表面最远的外点）
function _findSeeds(tris, bbMin, bbMax) {
  const size = [bbMax[0]-bbMin[0], bbMax[1]-bbMin[1], bbMax[2]-bbMin[2]];
  const N = 7; // 7^3 = 343 采样
  const internal = [];
  const external = [];
  for (let i = 1; i < N-1; i++)
    for (let j = 1; j < N-1; j++)
      for (let k = 1; k < N-1; k++) {
        const p = [bbMin[0] + size[0]*i/(N-1), bbMin[1] + size[1]*j/(N-1), bbMin[2] + size[2]*k/(N-1)];
        if (_pointInsideMesh(tris, p)) internal.push(p);
        else external.push(p);
      }
  // 选离质心最近的内部点作为 internal_seed（最稳）
  const cx = (bbMin[0]+bbMax[0])/2, cy = (bbMin[1]+bbMax[1])/2, cz = (bbMin[2]+bbMax[2])/2;
  const dist2 = (a,b) => (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;
  internal.sort((a,b) => dist2(a,[cx,cy,cz]) - dist2(b,[cx,cy,cz]));
  // 外部种子：bbox 外的"明显在外"点（沿 +X 偏移 maxDim）
  const maxDim = Math.max(...size);
  const externalSeed = [bbMax[0] + maxDim*0.2, cy, cz];
  return {
    internal_seed: internal.length ? internal[0] : null,
    external_seed: externalSeed,
    internal_sample_count: internal.length,
    external_sample_count: external.length,
    is_internal_flow_friendly: internal.length > external.length * 0.5 // STL 内部空间大→可能是容器/管道（内流场）
  };
}

async function foamStlInspect(stlPath) {
  if (!stlPath) throw new Error('stl_path 必填');
  const f = path.isAbsolute(stlPath) ? stlPath : path.resolve(WORKSPACE, stlPath);
  const buf = await fs.readFile(f);
  const head = buf.slice(0, Math.min(80, buf.length)).toString('ascii').toLowerCase();
  let tris = [];
  // ASCII STL：以 "solid" 开头但要确认是文本
  const looksAscii = head.startsWith('solid') && buf.includes(Buffer.from('facet normal'));
  if (looksAscii) {
    const txt = buf.toString('utf8');
    const re = /vertex\s+([\-\deE.+]+)\s+([\-\deE.+]+)\s+([\-\deE.+]+)/g;
    let m, verts = [];
    while ((m = re.exec(txt)) !== null) verts.push([+m[1], +m[2], +m[3]]);
    for (let i = 0; i + 2 < verts.length; i += 3) tris.push([verts[i], verts[i+1], verts[i+2]]);
  } else {
    // Binary：80 字节头 + uint32 数 + 50 字节/三角形
    if (buf.length < 84) throw new Error('STL 文件过小');
    const n = buf.readUInt32LE(80);
    if (84 + n * 50 !== buf.length) {
      // 兼容尾部多余字节但小于 50；至少检验 n 合理
      if (n * 50 + 84 > buf.length) throw new Error(`STL 三角形数声明 ${n} 与文件大小不一致`);
    }
    let p = 84;
    for (let i = 0; i < n; i++) {
      // 跳过法向量 12 字节
      const v0 = [buf.readFloatLE(p+12), buf.readFloatLE(p+16), buf.readFloatLE(p+20)];
      const v1 = [buf.readFloatLE(p+24), buf.readFloatLE(p+28), buf.readFloatLE(p+32)];
      const v2 = [buf.readFloatLE(p+36), buf.readFloatLE(p+40), buf.readFloatLE(p+44)];
      tris.push([v0, v1, v2]);
      p += 50;
    }
  }
  if (!tris.length) return '[STL 解析失败：未读到三角形]';
  // bbox / centroid / 面积近似 / 体积（Σ v0·(v1×v2)/6 带符号）
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let cx = 0, cy = 0, cz = 0, area = 0, vol = 0;
  for (const t of tris) {
    for (const v of t) {
      for (let k = 0; k < 3; k++) { if (v[k] < min[k]) min[k] = v[k]; if (v[k] > max[k]) max[k] = v[k]; }
      cx += v[0]; cy += v[1]; cz += v[2];
    }
    const a = t[0], b = t[1], c = t[2];
    const ab = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
    const ac = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
    const cr = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]];
    area += 0.5 * Math.hypot(cr[0], cr[1], cr[2]);
    vol += (a[0]*(b[1]*c[2]-b[2]*c[1]) - a[1]*(b[0]*c[2]-b[2]*c[0]) + a[2]*(b[0]*c[1]-b[1]*c[0])) / 6;
  }
  const nv = tris.length * 3;
  const cent = [cx/nv, cy/nv, cz/nv];
  const size = [max[0]-min[0], max[1]-min[1], max[2]-min[2]];
  const maxDim = Math.max(...size);
  const minDim = Math.min(...size);
  const recCell = +(maxDim / 30).toPrecision(3);
  // 单位推测：所有坐标绝对值都很小 (<0.01) 可能是米；若 1~10 m 可能是米；几十~几千更可能是 mm
  let unitGuess = '不确定';
  if (maxDim < 0.05) unitGuess = '可能为 m（极小物体）';
  else if (maxDim < 50) unitGuess = '可能为 m';
  else if (maxDim < 5000) unitGuess = '可能为 mm（建议 surfaceTransformPoints -scale 0.001 转 m）';
  // —— v6 薄壁特征长度估算：取所有三角形最短边的 5% / 50% 分位数 ——
  const shortEdges = [];
  for (const t of tris) {
    const a = t[0], b = t[1], c = t[2];
    const eAB = Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]);
    const eBC = Math.hypot(c[0]-b[0], c[1]-b[1], c[2]-b[2]);
    const eCA = Math.hypot(a[0]-c[0], a[1]-c[1], a[2]-c[2]);
    shortEdges.push(Math.min(eAB, eBC, eCA));
  }
  shortEdges.sort((a,b)=>a-b);
  const q05 = shortEdges[Math.floor(shortEdges.length*0.05)] || 0;
  const q50 = shortEdges[Math.floor(shortEdges.length*0.50)] || 0;
  // —— 几何种子：内部点 / 外部点（snappy locationInMesh 用） ——
  let seeds = { internal_seed:null, external_seed:null, internal_sample_count:0, external_sample_count:0, is_internal_flow_friendly:false };
  try {
    // tris 数量大时降采样，加速点云内外测试
    const sampleTris = tris.length > 4000 ? (() => {
      const step = Math.ceil(tris.length / 4000);
      const sub = []; for (let i = 0; i < tris.length; i += step) sub.push(tris[i]); return sub;
    })() : tris;
    seeds = _findSeeds(sampleTris, min, max);
  } catch {}
  return JSON.stringify({
    type: looksAscii ? 'ascii' : 'binary',
    file: path.relative(WORKSPACE, f) || f,
    triangles: tris.length,
    bbox_min: min.map(x => +x.toPrecision(6)),
    bbox_max: max.map(x => +x.toPrecision(6)),
    bbox_size: size.map(x => +x.toPrecision(6)),
    max_dim: +maxDim.toPrecision(6),
    min_dim: +minDim.toPrecision(6),
    centroid: cent.map(x => +x.toPrecision(6)),
    surface_area: +area.toPrecision(6),
    signed_volume: +vol.toPrecision(6),
    closed_estimate: Math.abs(vol) > 1e-9 ? '近似封闭' : '可能不封闭',
    unit_guess: unitGuess,
    recommend_cell_size: recCell,
    recommend_blockmesh_padding: +(maxDim * 1.5).toPrecision(3),
    recommend_location_in_mesh: seeds.internal_seed
      ? seeds.internal_seed.map(x => +x.toPrecision(6))
      : [ +(cent[0]).toPrecision(4), +(cent[1]).toPrecision(4), +(max[2] + size[2] * 0.1).toPrecision(4) ],
    // v6 新增字段：用于 foam_mesh_plan v2 自动决策
    narrow_feature_q05: +q05.toPrecision(4),       // 最细 5% 边长（薄壁/小特征指示）
    narrow_feature_q50: +q50.toPrecision(4),       // 中位边长
    internal_seed: seeds.internal_seed ? seeds.internal_seed.map(x => +x.toPrecision(6)) : null,
    external_seed: seeds.external_seed ? seeds.external_seed.map(x => +x.toPrecision(6)) : null,
    internal_sample_count: seeds.internal_sample_count,
    external_sample_count: seeds.external_sample_count,
    is_likely_internal_flow: seeds.is_internal_flow_friendly,
    domain_type_hint: seeds.is_internal_flow_friendly
      ? '建议 domain.type=internal（流体在 STL 内部）'
      : '建议 domain.type=external（流体在 STL 外，绕物体流动）'
  }, null, 2);
}

// ============== 自动生成 blockMesh + snappyHexMesh + surfaceFeatures 草案（v6 史诗增强版）==============
//
// 核心升级：
//   1) 引入 domain 显式参数（external / internal / box / wrap）—— 计算域不再"瞎猜"，必须告诉它流体在哪
//   2) surfaces[] 多 STL/多 patch + 每 patch 独立 refinement level + 距离场 refinementRegions
//   3) first_layer_thickness 走绝对值（米），不再依赖背景 cell；自动校验薄壁不被层覆盖
//   4) 质量参数全面紧化：nCellsBetweenLevels 5、resolveFeatureAngle 25、nFeatureSnapIter 15、nSolveIter 50
//   5) locationInMesh 优先用 STL 射线测试得到的 internal_seed/external_seed（避免切反）
//   6) 边界层加 relaxedIter + relaxed{} 子块兜底（即使边角不达标也能加完）
//   7) 多 patch 时自动 patch_name 切割
//
// strategy 档位（兼容）：default | coarsen | minimal | box_stl
async function foamMeshPlan(args) {
  let {
    case_path, stl_path, target_cell_size,
    refinement_level_min = 1, refinement_level_max = 3,
    n_layers = 0, location_in_mesh, flow_direction = 'x', strategy = 'default',
    // —— v6 新增参数（全部可选；向后兼容）——
    domain,               // {type:'external'|'internal'|'box'|'wrap', ...} 见下
    surfaces,             // [{file, patch_name, level:[min,max], layers, region:{mode,distances,levels}}]
    first_layer_thickness,// 绝对米数；优先于 finalLayerThickness/relativeSizes
    feature_level,        // 默认 = max(surface levels)
    n_cells_between_levels = 5,
    resolve_feature_angle = 25,
    expansion_ratio = 1.2,
    max_global_cells = 8000000,
  } = args;
  // —— 策略调参 —— //
  const _strategyApplied = strategy;
  let _snapFlag = true;
  let _addLayersFlag = (n_layers > 0) || (first_layer_thickness && first_layer_thickness > 0);
  let _writeBoxStl = false;
  if (strategy === 'coarsen') {
    if (target_cell_size) target_cell_size = target_cell_size * 1.5;
    refinement_level_max = Math.max(refinement_level_min, refinement_level_max - 1);
    n_layers = 0; _addLayersFlag = false;
  } else if (strategy === 'minimal') {
    if (target_cell_size) target_cell_size = target_cell_size * 2;
    refinement_level_min = 0;
    refinement_level_max = 1;
    n_layers = 0; _addLayersFlag = false;
    _snapFlag = false;
  } else if (strategy === 'box_stl') {
    _writeBoxStl = true;
  }
  if (!case_path) throw new Error('case_path 必填');
  // 主 STL 路径来自 stl_path 或 surfaces[0].file
  if (!stl_path && (!surfaces || !surfaces.length)) throw new Error('stl_path 或 surfaces[] 至少给一个');
  const cd = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
  await fs.mkdir(cd, { recursive: true });
  await fs.mkdir(path.join(cd, 'system'), { recursive: true });
  await fs.mkdir(path.join(cd, 'constant', 'triSurface'), { recursive: true });

  // —— 规整 surfaces 列表（兼容旧的单 STL 路径）——
  const surfList = (surfaces && surfaces.length) ? surfaces.slice() : [{
    file: stl_path,
    patch_name: null,
    level: [refinement_level_min, refinement_level_max],
    layers: n_layers,
    region: null
  }];
  // 复制所有 STL 到 case 并 inspect 第一个
  const surfInfos = [];
  for (const s of surfList) {
    if (!s.file) throw new Error('surfaces[].file 必填');
    const abs = path.isAbsolute(s.file) ? s.file : path.resolve(WORKSPACE, s.file);
    const name = path.basename(abs);
    const dst = path.join(cd, 'constant', 'triSurface', name);
    await fs.copyFile(abs, dst);
    const info = JSON.parse(await foamStlInspect(abs));
    const base = name.replace(/\.stl$/i, '');
    const patch = s.patch_name || base;
    const lvl = (s.level && s.level.length === 2) ? s.level : [refinement_level_min, refinement_level_max];
    surfInfos.push({ abs, name, base, patch, info, level: lvl, layers: s.layers || 0, region: s.region || null });
  }
  const mainInfo = surfInfos[0].info;
  const [minX, minY, minZ] = mainInfo.bbox_min;
  const [maxX, maxY, maxZ] = mainInfo.bbox_max;
  const [sx, sy, sz] = mainInfo.bbox_size;
  const maxDim = Math.max(sx, sy, sz);
  const cell = +(target_cell_size || mainInfo.recommend_cell_size);

  // —— 决定 domain 类型 ——
  if (!domain) {
    // 没显式给，用 STL 内/外采样投票
    if (mainInfo.is_likely_internal_flow) domain = { type: 'internal' };
    else domain = { type: 'wrap' }; // 旧行为
  }
  const dt = domain.type || 'wrap';
  let bbMin, bbMax;
  if (dt === 'box') {
    if (!Array.isArray(domain.bbox_min) || !Array.isArray(domain.bbox_max))
      throw new Error('domain.type=box 时必须给 bbox_min[3] / bbox_max[3]（米）');
    bbMin = domain.bbox_min.slice();
    bbMax = domain.bbox_max.slice();
  } else if (dt === 'internal') {
    // STL 即外壁；背景域贴 bbox + 极小 padding（保证 blockMesh 包住整个 STL 即可）
    const pad = domain.padding != null ? domain.padding : 0.02 * maxDim;
    bbMin = [minX - pad, minY - pad, minZ - pad];
    bbMax = [maxX + pad, maxY + pad, maxZ + pad];
  } else if (dt === 'external') {
    // 外流场：按方向给上/下游/侧/顶/底倍数（以 maxDim 为单位）
    const up   = domain.upstream   != null ? domain.upstream   : 5;
    const down = domain.downstream != null ? domain.downstream : 10;
    const lat  = domain.lateral    != null ? domain.lateral    : 5;
    const top  = domain.vertical_top    != null ? domain.vertical_top    : (lat);
    const bot  = domain.vertical_bottom != null ? domain.vertical_bottom : (lat);
    if (flow_direction === 'x') {
      bbMin = [minX - up*maxDim, minY - lat*maxDim, minZ - bot*maxDim];
      bbMax = [maxX + down*maxDim, maxY + lat*maxDim, maxZ + top*maxDim];
    } else if (flow_direction === 'y') {
      bbMin = [minX - lat*maxDim, minY - up*maxDim, minZ - bot*maxDim];
      bbMax = [maxX + lat*maxDim, maxY + down*maxDim, maxZ + top*maxDim];
    } else {
      bbMin = [minX - lat*maxDim, minY - lat*maxDim, minZ - up*maxDim];
      bbMax = [maxX + lat*maxDim, maxY + lat*maxDim, maxZ + down*maxDim];
    }
  } else {
    // wrap (兼容旧版)
    const pad = maxDim * 0.5;
    bbMin = [minX - pad, minY - pad, minZ - pad];
    bbMax = [maxX + pad, maxY + pad, maxZ + pad];
    if (flow_direction === 'x') { bbMin[0] = minX - maxDim * 1.5; bbMax[0] = maxX + maxDim * 5; }
    else if (flow_direction === 'y') { bbMin[1] = minY - maxDim * 1.5; bbMax[1] = maxY + maxDim * 5; }
    else { bbMin[2] = minZ - maxDim * 1.5; bbMax[2] = maxZ + maxDim * 5; }
  }

  // —— 单元数预算与约束：估算后限制不超过 max_global_cells ——
  let nx = Math.max(8, Math.round((bbMax[0]-bbMin[0]) / cell));
  let ny = Math.max(8, Math.round((bbMax[1]-bbMin[1]) / cell));
  let nz = Math.max(8, Math.round((bbMax[2]-bbMin[2]) / cell));
  let bgCells = nx*ny*nz;
  // 估算 snappy 后单元数：表面附近 ≈ bgCells * 4^maxLevel * (surface/volume ratio)。粗算只按背景的 10x 上限。
  const maxLvl = Math.max(...surfInfos.map(s => s.level[1]));
  const estTotal = bgCells * Math.max(1, 4 ** (maxLvl - 1));
  if (estTotal > max_global_cells) {
    // 等比放大 base cell
    const factor = Math.cbrt(estTotal / max_global_cells);
    nx = Math.max(8, Math.round(nx / factor));
    ny = Math.max(8, Math.round(ny / factor));
    nz = Math.max(8, Math.round(nz / factor));
    bgCells = nx*ny*nz;
  }
  const actualCell = ((bbMax[0]-bbMin[0])/nx + (bbMax[1]-bbMin[1])/ny + (bbMax[2]-bbMin[2])/nz) / 3;

  // —— locationInMesh ——
  let lim;
  if (location_in_mesh && location_in_mesh.length === 3) {
    lim = location_in_mesh;
  } else if (dt === 'external') {
    // 外流场：用 STL inspect 给的 external_seed（明显在外）
    lim = mainInfo.external_seed || [bbMax[0] - 0.01*maxDim, (bbMin[1]+bbMax[1])/2, (bbMin[2]+bbMax[2])/2];
  } else if (dt === 'internal') {
    // 内流场：必须用 internal_seed
    lim = mainInfo.internal_seed;
    if (!lim) throw new Error('domain.type=internal 但 STL 射线测试找不到内部点；STL 可能不封闭或法向反了。请先 foam_stl_render 检查。');
  } else {
    lim = mainInfo.recommend_location_in_mesh;
  }

  // —— patch 命名（按主流方向 / domain 类型）——
  // internal 时背景域所有 6 面默认走 wall（用户在 0/ 改）；external 走 inlet/outlet/side
  const faceNames = { x: { in: 'inlet', out: 'outlet', side: ['front','back','top','bottom'] },
                      y: { in: 'inlet', out: 'outlet', side: ['left','right','top','bottom'] },
                      z: { in: 'inlet', out: 'outlet', side: ['left','right','front','back'] } }[flow_direction];
  const fHeader = (cls, obj) => `/*--------------------------------*- C++ -*----------------------------------*\\
| Auto-generated by Mdriver foam_mesh_plan v6                             |
\\*---------------------------------------------------------------------------*/
FoamFile { version 2.0; format ascii; class ${cls}; object ${obj}; }
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //
`;
  // —— blockMeshDict ——
  const f = (n) => n.toFixed(6);
  // internal 时 6 面都用 wall；其它情况按主流方向命名
  let boundaryBlock;
  if (dt === 'internal') {
    boundaryBlock =
      'xMin   { type wall; faces ((0 4 7 3)); }\n' +
      '    xMax   { type wall; faces ((1 2 6 5)); }\n' +
      '    yMin   { type wall; faces ((0 1 5 4)); }\n' +
      '    yMax   { type wall; faces ((3 7 6 2)); }\n' +
      '    zMin   { type wall; faces ((0 3 2 1)); }\n' +
      '    zMax   { type wall; faces ((4 5 6 7)); }';
  } else if (flow_direction === 'x') {
    boundaryBlock = 'inlet  { type patch; faces ((0 4 7 3)); }\n    outlet { type patch; faces ((1 2 6 5)); }\n    front  { type patch; faces ((0 1 5 4)); }\n    back   { type patch; faces ((3 7 6 2)); }\n    bottom { type wall;  faces ((0 3 2 1)); }\n    top    { type patch; faces ((4 5 6 7)); }';
  } else if (flow_direction === 'y') {
    boundaryBlock = 'inlet  { type patch; faces ((0 1 5 4)); }\n    outlet { type patch; faces ((3 7 6 2)); }\n    left   { type patch; faces ((0 4 7 3)); }\n    right  { type patch; faces ((1 2 6 5)); }\n    bottom { type wall;  faces ((0 3 2 1)); }\n    top    { type patch; faces ((4 5 6 7)); }';
  } else {
    boundaryBlock = 'inlet  { type patch; faces ((0 3 2 1)); }\n    outlet { type patch; faces ((4 5 6 7)); }\n    left   { type patch; faces ((0 4 7 3)); }\n    right  { type patch; faces ((1 2 6 5)); }\n    front  { type patch; faces ((0 1 5 4)); }\n    back   { type patch; faces ((3 7 6 2)); }';
  }
  const bmd = fHeader('dictionary','blockMeshDict') + `
convertToMeters 1;

vertices
(
    (${f(bbMin[0])} ${f(bbMin[1])} ${f(bbMin[2])})
    (${f(bbMax[0])} ${f(bbMin[1])} ${f(bbMin[2])})
    (${f(bbMax[0])} ${f(bbMax[1])} ${f(bbMin[2])})
    (${f(bbMin[0])} ${f(bbMax[1])} ${f(bbMin[2])})
    (${f(bbMin[0])} ${f(bbMin[1])} ${f(bbMax[2])})
    (${f(bbMax[0])} ${f(bbMin[1])} ${f(bbMax[2])})
    (${f(bbMax[0])} ${f(bbMax[1])} ${f(bbMax[2])})
    (${f(bbMin[0])} ${f(bbMax[1])} ${f(bbMax[2])})
);

blocks
(
    hex (0 1 2 3 4 5 6 7) (${nx} ${ny} ${nz}) simpleGrading (1 1 1)
);

edges ();

boundary
(
    ${boundaryBlock}
);

mergePatchPairs ();
`;
  // —— snappyHexMeshDict ——
  const featLvl = feature_level != null ? feature_level : maxLvl;
  // geometry 块（多 STL）
  const geomBlocks = surfInfos.map(s => `    ${s.base}
    {
        type triSurfaceMesh;
        name ${s.patch};
        file "${s.name}";
    }`).join('\n');
  // refinementSurfaces 块（每个 STL 独立 level + patchInfo）
  const refSurfBlocks = surfInfos.map(s => `        ${s.base}
        {
            level (${s.level[0]} ${s.level[1]});
            patchInfo { type wall; }
        }`).join('\n');
  // features 块（每个 STL 一条 eMesh）
  const featBlocks = surfInfos.map(s => `            { file "${s.base}.eMesh"; level ${featLvl}; }`).join('\n');
  // refinementRegions（距离场加密）
  const refRegBlocks = surfInfos.filter(s => s.region).map(s => {
    const r = s.region;
    if (r.mode === 'distance') {
      const lvls = (r.levels || []).map(([d,l]) => `(${d} ${l})`).join(' ');
      return `        ${s.base}
        {
            mode distance;
            levels ( ${lvls} );
        }`;
    } else if (r.mode === 'inside') {
      return `        ${s.base}
        {
            mode inside;
            levels ((1E15 ${r.level || s.level[1]}));
        }`;
    }
    return '';
  }).filter(Boolean).join('\n');

  // —— 边界层（绝对厚度优先，自动加 relaxed 兜底）——
  const layersPatches = surfInfos.filter(s => (s.layers && s.layers > 0) || (n_layers > 0 && surfInfos.length === 1)).map(s => {
    const nL = s.layers || n_layers;
    return `        "${s.patch}.*" { nSurfaceLayers ${nL}; }`;
  }).join('\n');
  const useAbsLayer = first_layer_thickness && first_layer_thickness > 0;
  const layersBlock = _addLayersFlag ? `
addLayersControls
{
    relativeSizes ${useAbsLayer ? 'false' : 'true'};
    layers
    {
${layersPatches || '        // (no layers configured)'}
    }
    expansionRatio ${expansion_ratio};
${useAbsLayer
  ? `    firstLayerThickness ${first_layer_thickness};
    minThickness ${(first_layer_thickness * 0.1).toExponential(3)};`
  : `    finalLayerThickness 0.4;
    minThickness 0.05;`}
    nGrow 0;
    featureAngle 130;          // 仅在折角小于此角度处生层（更宽容才能贴边角）
    slipFeatureAngle 30;
    nRelaxIter 8;              // 加多次松弛
    nSmoothSurfaceNormals 3;
    nSmoothNormals 5;
    nSmoothThickness 10;
    maxFaceThicknessRatio 0.5;
    maxThicknessToMedialRatio 0.3;
    minMedialAxisAngle 90;
    nBufferCellsNoExtrude 0;
    nLayerIter 50;
    nRelaxedIter 20;           // 失败回退用更松质量阈值（关键！）
    additionalReporting true;
}
` : `
addLayersControls
{
    relativeSizes true;
    layers {}
    expansionRatio 1.2;
    finalLayerThickness 0.4;
    minThickness 0.05;
    nGrow 0;
    featureAngle 130;
    slipFeatureAngle 30;
    nRelaxIter 5;
    nSmoothSurfaceNormals 1;
    nSmoothNormals 3;
    nSmoothThickness 10;
    maxFaceThicknessRatio 0.5;
    maxThicknessToMedialRatio 0.3;
    minMedialAxisAngle 90;
    nBufferCellsNoExtrude 0;
    nLayerIter 50;
    nRelaxedIter 20;
}
`;

  const shm = fHeader('dictionary','snappyHexMeshDict') + `
castellatedMesh true;
snap            ${_snapFlag ? 'true' : 'false'};
addLayers       ${_addLayersFlag ? 'true' : 'false'};

geometry
{
${geomBlocks}
}

castellatedMeshControls
{
    maxLocalCells   ${Math.floor(max_global_cells / 4)};
    maxGlobalCells  ${max_global_cells};
    minRefinementCells 10;
    nCellsBetweenLevels ${n_cells_between_levels};
    features
    (
${featBlocks}
    );
    refinementSurfaces
    {
${refSurfBlocks}
    }
    resolveFeatureAngle ${resolve_feature_angle};
    refinementRegions
    {
${refRegBlocks || ''}
    }
    locationInMesh (${f(lim[0])} ${f(lim[1])} ${f(lim[2])});
    allowFreeStandingZoneFaces true;
}

snapControls
{
    nSmoothPatch 5;
    tolerance 1.0;
    nSolveIter 50;
    nRelaxIter 8;
    nFeatureSnapIter 15;
    implicitFeatureSnap false;
    explicitFeatureSnap true;
    multiRegionFeatureSnap false;
}
${layersBlock}
meshQualityControls
{
    maxNonOrtho 65;
    maxBoundarySkewness 20;
    maxInternalSkewness 4;
    maxConcave 80;
    minVol 1e-13;
    minTetQuality 1e-15;
    minArea -1;
    minTwist 0.02;
    minDeterminant 0.001;
    minFaceWeight 0.05;
    minVolRatio 0.01;
    minTriangleTwist -1;
    nSmoothScale 4;
    errorReduction 0.75;
    relaxed
    {
        maxNonOrtho 75;
    }
}

writeFlags ( scalarLevels layerSets layerFields );
mergeTolerance 1e-6;
`;
  // —— surfaceFeaturesDict（OF >= 1706）/ surfaceFeatureExtractDict（旧）——
  // 多 STL 用列表
  const stlNamesList = surfInfos.map(s => `"${s.name}"`).join(' ');
  const sfd = fHeader('dictionary','surfaceFeaturesDict') + `
surfaces ( ${stlNamesList} );
includedAngle   150;
subsetFeatures
{
    nonManifoldEdges no;
    openEdges        yes;
}
writeObj            yes;
`;
  const sfeBlocks = surfInfos.map(s => `${s.name}
{
    extractionMethod    extractFromSurface;
    extractFromSurfaceCoeffs { includedAngle   150; }
    subsetFeatures { nonManifoldEdges no; openEdges yes; }
    writeObj                yes;
}`).join('\n');
  const sfedict = fHeader('dictionary','surfaceFeatureExtractDict') + sfeBlocks + '\n';

  // —— 写文件 ——
  const written = [];
  async function w(rel, content) {
    const fp = path.join(cd, rel);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, content);
    written.push(rel);
  }
  await w('system/blockMeshDict', bmd);
  await w('system/snappyHexMeshDict', shm);
  await w('system/surfaceFeaturesDict', sfd);
  await w('system/surfaceFeatureExtractDict', sfedict);

  // 策略 box_stl：额外写一个外域 box STL（可被手动加入 snappy）
  let boxStlNote = '';
  if (_writeBoxStl) {
    const boxName = 'domain_box.stl';
    const boxPath = path.join(cd, 'constant', 'triSurface', boxName);
    await writeBoxStl(boxPath, bbMin, bbMax, 'domain');
    boxStlNote = `\n额外生成: constant/triSurface/${boxName}（外域包围盒 STL，可手动加入 snappy 的 refinementRegions / 改成 internalCellZones 策略）`;
  }

  // —— 自检 & 警告 ——
  const warnings = [];
  if (dt === 'internal' && !mainInfo.is_likely_internal_flow)
    warnings.push('⚠ domain=internal 但 STL 射线测试显示内部空间偏小，请确认 STL 是封闭容器外壁，或法向反了。');
  if (dt === 'external' && mainInfo.is_likely_internal_flow)
    warnings.push('⚠ domain=external 但 STL 看起来是容器（内部空间大）。如果你想算容器内流，改 domain.type=internal。');
  if (useAbsLayer && first_layer_thickness > mainInfo.narrow_feature_q05)
    warnings.push(`⚠ first_layer_thickness=${first_layer_thickness} 大于 STL 最薄边长 5% 分位 ${mainInfo.narrow_feature_q05}，薄壁/小特征上 layer 可能失败。`);
  if (mainInfo.unit_guess && mainInfo.unit_guess.includes('mm'))
    warnings.push(`⚠ STL 单位疑似 mm（max_dim=${mainInfo.max_dim}），建议先 surfaceTransformPoints -scale 0.001。`);

  return [
    `[\u5df2\u751f\u6210\u7f51\u683c\u65b9\u6848 v6] case=${path.relative(WORKSPACE, cd) || cd}  策略=${_strategyApplied}  domain=${dt}`,
    ``,
    `STL：${surfInfos.length} 个 (` + surfInfos.map(s=>s.name).join(', ') + `)`,
    `主 STL 摘要：tris=${mainInfo.triangles}, bbox=${mainInfo.bbox_size.join('×')}, 单位=${mainInfo.unit_guess}, 最薄边长 q05=${mainInfo.narrow_feature_q05}`,
    `计算域 bbox: (${bbMin.map(x=>x.toFixed(3)).join(', ')}) → (${bbMax.map(x=>x.toFixed(3)).join(', ')})`,
    `背景网格: ${nx}×${ny}×${nz} = ${bgCells.toLocaleString()} cells (cell≈${actualCell.toFixed(4)} m)`,
    `表面加密: ` + surfInfos.map(s=>`${s.patch} L${s.level[0]}-${s.level[1]}`).join('; '),
    `feature_level=${featLvl}, nCellsBetweenLevels=${n_cells_between_levels}, resolveFeatureAngle=${resolve_feature_angle}°`,
    `snap: nFeatureSnapIter=15, nSolveIter=50, tolerance=1.0 (尖角保留参数已紧化)`,
    `边界层: ${_addLayersFlag ? (useAbsLayer ? `firstLayerThickness=${first_layer_thickness} m (绝对值)` : 'relativeSizes=true (finalLayerThickness=0.4)') + `, n=${surfInfos.filter(s=>s.layers).map(s=>`${s.patch}:${s.layers}`).join(', ') || n_layers}, expansion=${expansion_ratio}, relaxedIter=20` : '无'}`,
    `locationInMesh = (${lim.map(x=>x.toFixed(3)).join(', ')})  [${dt==='internal'?'STL内部种子':dt==='external'?'STL外部种子':'auto'}]`,
    ``,
    warnings.length ? '⚠ 警告：\n  ' + warnings.join('\n  ') + '\n' : '',
    `生成文件:`,
    ...written.map(x => `  - ${x}`),
    ...surfInfos.map(s => `  - constant/triSurface/${s.name}`),
    ``,
    `建议执行序列（用 foam_run_solver_async 后台执行）：`,
    `  1) blockMesh`,
    `  2) surfaceFeatures   # OF >=1706；旧版用 surfaceFeatureExtract`,
    `  3) snappyHexMesh -overwrite`,
    `  4) checkMesh -allTopology -allGeometry`,
    `  5) foam_mesh_verify(case_path, stage='final') —— 必走，会解析 snappy log 算 layer coverage`,
    boxStlNote
  ].filter(Boolean).join('\n');
}

// ============== 写一个 axis-aligned box 的 ASCII STL ==============
async function writeBoxStl(filepath, bbMin, bbMax, solidName = 'box') {
  const [x0,y0,z0] = bbMin, [x1,y1,z1] = bbMax;
  // 8 顶点
  const v = [
    [x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],
    [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]
  ];
  // 12 三角面（每面 2 个），法向朝外
  const faces = [
    // bottom z=z0, n=(0,0,-1)
    [[0,2,1],[0,3,2], [0,0,-1]],
    // top z=z1, n=(0,0,1)
    [[4,5,6],[4,6,7], [0,0,1]],
    // front y=y0, n=(0,-1,0)
    [[0,1,5],[0,5,4], [0,-1,0]],
    // back y=y1, n=(0,1,0)
    [[3,7,6],[3,6,2], [0,1,0]],
    // left x=x0, n=(-1,0,0)
    [[0,4,7],[0,7,3], [-1,0,0]],
    // right x=x1, n=(1,0,0)
    [[1,2,6],[1,6,5], [1,0,0]],
  ];
  let out = `solid ${solidName}\n`;
  for (const grp of faces) {
    const n = grp[2];
    for (let i = 0; i < 2; i++) {
      const tri = grp[i];
      out += `  facet normal ${n[0]} ${n[1]} ${n[2]}\n`;
      out += `    outer loop\n`;
      for (const idx of tri) out += `      vertex ${v[idx][0]} ${v[idx][1]} ${v[idx][2]}\n`;
      out += `    endloop\n  endfacet\n`;
    }
  }
  out += `endsolid ${solidName}\n`;
  await fs.mkdir(path.dirname(filepath), { recursive: true });
  await fs.writeFile(filepath, out);
  return filepath;
}

// 工具入口：生成域 box STL
async function foamMeshBoxStl(args) {
  const { case_path, bbox_min, bbox_max, name = 'domain_box' } = args || {};
  if (!case_path || !Array.isArray(bbox_min) || !Array.isArray(bbox_max)) throw new Error('case_path / bbox_min[3] / bbox_max[3] 必填');
  const cd = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
  const fp = path.join(cd, 'constant', 'triSurface', `${name}.stl`);
  await writeBoxStl(fp, bbox_min, bbox_max, name);
  return `[已生成 box STL] ${path.relative(WORKSPACE, fp) || fp}\nbbox: (${bbox_min.join(', ')}) → (${bbox_max.join(', ')})`;
}

// ============== y+ 反算第一层厚度（v6 新增） ==============
// Schlichting 平板：Cf = 0.026 Re^(-1/7)，u* = U*sqrt(Cf/2)，Δy1 = y+·ν/u*
// BL 厚度 δ99 ≈ 0.37·L·Re^(-1/5)；几何级数总厚 = Δy1·(r^N - 1)/(r-1) 覆盖 δ99 → 反推 N
function foamComputeFirstLayer(args) {
  const { U_ref, L_ref, nu = 1.5e-5, y_plus_target = 1.0, expansion_ratio = 1.2, coverage = 0.7 } = args || {};
  if (!(U_ref > 0) || !(L_ref > 0)) throw new Error('U_ref(>0) 和 L_ref(>0) 必填（米/秒、米）');
  const Re = U_ref * L_ref / nu;
  const Cf = 0.026 * Math.pow(Re, -1/7);
  const u_star = U_ref * Math.sqrt(Cf / 2);
  const dy1 = y_plus_target * nu / u_star;
  const delta99 = 0.37 * L_ref * Math.pow(Re, -1/5);
  // 用几何级数反求 N：dy1 * (r^N - 1) / (r - 1) = coverage * delta99
  const r = expansion_ratio;
  const target = coverage * delta99;
  let N = 1;
  while (N < 30) {
    const total = dy1 * (Math.pow(r, N) - 1) / (r - 1);
    if (total >= target) break;
    N++;
  }
  const totalThick = dy1 * (Math.pow(r, N) - 1) / (r - 1);
  // 推荐区间：5≤N≤15 比较稳；超出范围给出告警
  const warnings = [];
  if (N < 4) warnings.push(`N=${N} 偏少，可能 BL 解析不够；建议放宽 y+ 目标或降低 expansion_ratio`);
  if (N > 15) warnings.push(`N=${N} 偏多，会拖累网格；建议放宽 y+ 目标（如 y+=30 走壁函数）或加大 expansion_ratio 到 1.25`);
  if (dy1 < 1e-7) warnings.push(`Δy1=${dy1.toExponential(2)} m 极小，对应几何尺度可能过细，请确认 L_ref 的物理含义`);
  return JSON.stringify({
    inputs: { U_ref, L_ref, nu, y_plus_target, expansion_ratio, coverage },
    derived: {
      Re: +Re.toPrecision(4),
      Cf: +Cf.toPrecision(4),
      u_star: +u_star.toPrecision(4),
      delta99_estimate_m: +delta99.toPrecision(4)
    },
    output: {
      first_layer_thickness_m: +dy1.toPrecision(4),
      recommended_n_layers: N,
      expansion_ratio: r,
      total_layer_thickness_m: +totalThick.toPrecision(4),
      coverage_actual: +(totalThick / delta99).toPrecision(3),
      foam_mesh_plan_usage: {
        first_layer_thickness: +dy1.toPrecision(4),
        n_layers: N,
        expansion_ratio: r,
        comment: '把这三项直接传给 foam_mesh_plan（同名参数），并设 domain=external|internal 等显式 domain。'
      }
    },
    warnings
  }, null, 2);
}

// ============== 残差时序结构化 ==============
function foamResidualSeries(runId, maxPoints = 60, fields = null) {
  const run = SOLVER_RUNS.get(runId);
  if (!run) return '[未知 runId]';
  const lines = run.log;
  // 解析模型：扫描行，遇 "Time = X" 切到新时间步；行内 "Solving for FIELD, Initial residual = A, Final residual = B, No Iterations N"
  const series = []; // [{t, residuals: {U:{init,final,iters}, p:..., ...}}]
  let cur = null;
  const reTime = /^Time\s*=\s*([\d.eE+\-]+)/;
  const reRes = /Solving for ([A-Za-z][\w]*),\s*Initial residual\s*=\s*([\d.eE+\-]+),\s*Final residual\s*=\s*([\d.eE+\-]+),\s*No Iterations\s*(\d+)/;
  for (const l of lines) {
    const tm = l.match(reTime);
    if (tm) { cur = { t: +tm[1], res: {} }; series.push(cur); continue; }
    if (!cur) continue;
    const rm = l.match(reRes);
    if (rm) {
      const fld = rm[1];
      if (fields && !fields.includes(fld)) continue;
      // 同一时间步内同一 field 出现多次（PISO 多次校正）→ 取最后一次
      cur.res[fld] = { init: +rm[2], final: +rm[3], iters: +rm[4] };
    }
  }
  const tail = series.slice(-maxPoints);
  // 收敛趋势：取每个 field 最近 10 步初始残差，做对数斜率
  const allFields = new Set();
  tail.forEach(s => Object.keys(s.res).forEach(k => allFields.add(k)));
  const trends = {};
  for (const f of allFields) {
    const xs = tail.filter(s => s.res[f] && isFinite(s.res[f].init) && s.res[f].init > 0).slice(-10);
    if (xs.length < 3) { trends[f] = { samples: xs.length, status: 'insufficient' }; continue; }
    const ys = xs.map(s => Math.log10(s.res[f].init));
    const n = ys.length;
    const meanX = (n - 1) / 2;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - meanX) * (ys[i] - meanY); den += (i - meanX) ** 2; }
    const slope = den > 0 ? num / den : 0; // log10 残差/步
    const last = ys[ys.length - 1], first = ys[0];
    let status;
    if (slope < -0.05) status = '收敛中';
    else if (slope > 0.05) status = '发散/震荡';
    else if (last > -3) status = '停滞-高残差';
    else status = '停滞-已稳态';
    trends[f] = { samples: n, slope_log10_per_step: +slope.toFixed(3), last_log10: +last.toFixed(2), first_log10: +first.toFixed(2), status };
  }
  return JSON.stringify({
    runId, total_time_steps: series.length, returned: tail.length,
    last_time: tail.length ? tail[tail.length-1].t : null,
    fields: [...allFields],
    trends,
    series: tail.map(s => ({ t: s.t, ...Object.fromEntries(Object.entries(s.res).map(([k,v]) => [k, v.init])) }))
  }, null, 2);
}

// ============== 算例对比并排渲染 ==============
async function foamCompareRender(args, ws) {
  const { case_a, case_b, label_a, label_b, field, time_step, azimuth = 30, elevation = 15 } = args;
  if (!case_a || !case_b) throw new Error('case_a 和 case_b 必填');
  const a = path.isAbsolute(case_a) ? case_a : path.resolve(WORKSPACE, case_a);
  const b = path.isAbsolute(case_b) ? case_b : path.resolve(WORKSPACE, case_b);
  // 串行渲染（pvpython 同时跑会抢 GPU；并行也行但风险大）
  const r1 = await pvRenderOffscreen({ casePath: a, azimuth, elevation, field: field || '', timeStep: time_step ?? null });
  const r2 = await pvRenderOffscreen({ casePath: b, azimuth, elevation, field: field || '', timeStep: time_step ?? null });
  // 通过 ws 推一条 sim_compare 给前端，前端把两个 dataUrl 并排渲染
  const labelA = label_a || path.basename(a);
  const labelB = label_b || path.basename(b);
  const payload = {
    type: 'sim_compare',
    a: { dataUrl: r1.dataUrl, label: labelA, meta: r1.meta || {} },
    b: { dataUrl: r2.dataUrl, label: labelB, meta: r2.meta || {} },
    field: field || '', timeStep: time_step ?? null
  };
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
  else for (const c of allClients) if (c.readyState === 1) c.send(JSON.stringify(payload));
  return [
    `[对比渲染完成] field=${field || '(默认)'}  t=${time_step ?? '(默认)'}`,
    `A: ${labelA}  →  ${a}`,
    `B: ${labelB}  →  ${b}`,
    `已推送 sim_compare 到聊天界面（左右并排）。`,
    r1.meta && r1.meta.fields ? `A 可用场: ${(r1.meta.fields||[]).join(', ')}` : '',
    r2.meta && r2.meta.fields ? `B 可用场: ${(r2.meta.fields||[]).join(', ')}` : ''
  ].filter(Boolean).join('\n');
}

// ============================================================
// v6 优化模块：Optuna ask-tell 驱动 + KPI 提取 + 字典写入
// ============================================================
const OPT_BASE_DIR = path.join(WORKSPACE, '.nullflux', 'opt');

async function _runOptDriver(subArgs) {
  const py = SETTINGS.pythonPath || (IS_WIN ? 'python' : 'python3');
  const script = path.join(__dirname, 'opt_driver.py');
  await fs.mkdir(OPT_BASE_DIR, { recursive: true });
  return await new Promise((resolve, reject) => {
    const proc = spawn(py, [script, ...subArgs], { windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', e => reject(new Error('spawn opt_driver.py 失败: ' + e.message)));
    proc.on('close', code => {
      if (code !== 0 && !out) return reject(new Error(`opt_driver 退出码 ${code}\nstderr: ${err.slice(-500)}`));
      // 取最后一行 JSON（避免 numpy/optuna 输出干扰）
      const last = out.trim().split(/\r?\n/).filter(Boolean).pop();
      try { resolve(JSON.parse(last)); }
      catch (e) { reject(new Error('opt_driver 返回非 JSON：' + (last || out).slice(0, 400) + '\nstderr: ' + err.slice(-300))); }
    });
  });
}

// foamDictionary -entry <path> -set <val> <file>
async function _foamDictSet(absFile, entry, value) {
  return await new Promise((resolve, reject) => {
    const cmd = ['-entry', entry, '-set', String(value), absFile];
    const proc = spawn('foamDictionary', cmd, { windowsHide: true });
    let err = '';
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', e => reject(new Error('foamDictionary 未找到（OpenFOAM 环境未 source？）：' + e.message)));
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`foamDictionary 退出码 ${code}: ${err.slice(-300)}`));
      else resolve(true);
    });
  });
}

async function optStudyCreate(args) {
  if (!args.study_id) throw new Error('study_id 必填');
  if (!Array.isArray(args.search_space) || args.search_space.length === 0) throw new Error('search_space 必填且至少一项');
  if (!args.objective || !args.objective.name) throw new Error('objective.name 必填');
  const spec = {
    study_id: args.study_id,
    base_case: args.base_case || null,
    objective: {
      name: args.objective.name,
      direction: args.objective.direction === 'maximize' ? 'maximize' : 'minimize',
      target: args.objective.target ?? null,   // 可选，论文/任务给的参考值
    },
    search_space: args.search_space,
    sampler: args.sampler || 'TPE',
    pruner: args.pruner || null,
    n_trials_budget: args.n_trials_budget || 30,
    seed: args.seed ?? null,
    kpi_extract: args.kpi_extract || null,     // 可选缺省 KPI 提取配置（method, regex/script_path/pvpython）
    param_mapping: args.param_mapping || null, // 可选缺省字典映射
    notes: args.notes || '',
  };
  const r = await _runOptDriver(['create', '--study_id', args.study_id, '--base_dir', OPT_BASE_DIR, '--spec', JSON.stringify(spec)]);
  return `[opt_study_create] ok=${r.ok} study=${r.study_id}\n` +
    `dir: ${r.study_dir}\n` +
    `sampler=${r.sampler}  direction=${r.direction}  n_params=${r.n_params}\n` +
    `JSON:\n${JSON.stringify(r, null, 2)}`;
}

async function optSuggestNext(args) {
  if (!args.study_id) throw new Error('study_id 必填');
  const r = await _runOptDriver(['suggest', '--study_id', args.study_id, '--base_dir', OPT_BASE_DIR]);
  return `[opt_suggest_next] trial_id=${r.trial_id}\nparams=${JSON.stringify(r.params, null, 2)}\nsuggested trial dir name: ${r.trial_dir_suggested}\nJSON:\n${JSON.stringify(r, null, 2)}`;
}

async function optApplyParams(args) {
  if (!args.case_path) throw new Error('case_path 必填');
  if (!args.params || typeof args.params !== 'object') throw new Error('params 必填 {name:value}');
  if (!args.mapping || typeof args.mapping !== 'object') throw new Error('mapping 必填 {name: "<file>::<entry>"}');
  const cd = path.isAbsolute(args.case_path) ? args.case_path : path.resolve(WORKSPACE, args.case_path);
  if (!await pathExistsSync(cd)) throw new Error('case_path 不存在: ' + cd);
  const applied = [], failed = [];
  for (const [name, value] of Object.entries(args.params)) {
    const target = args.mapping[name];
    if (!target) { failed.push({ name, error: 'no mapping' }); continue; }
    const idx = target.indexOf('::');
    if (idx < 0) { failed.push({ name, target, error: '格式应为 "<file>::<entry>"' }); continue; }
    const file = target.slice(0, idx);
    const entry = target.slice(idx + 2);
    const abs = path.isAbsolute(file) ? file : path.join(cd, file);
    try {
      await _foamDictSet(abs, entry, value);
      applied.push({ name, value, file, entry });
    } catch (e) {
      failed.push({ name, value, file, entry, error: e.message });
    }
  }
  return `[opt_apply_params] case=${path.relative(WORKSPACE, cd) || cd}\napplied (${applied.length}):\n` +
    applied.map(a => `  ✅ ${a.name} = ${a.value}   @ ${a.file}::${a.entry}`).join('\n') +
    (failed.length ? `\nfailed (${failed.length}):\n` + failed.map(f => `  ❌ ${f.name}: ${f.error}`).join('\n') : '') +
    `\nJSON:\n${JSON.stringify({ applied, failed }, null, 2)}`;
}

async function optExtractKpi(args) {
  if (!args.case_path) throw new Error('case_path 必填');
  if (!args.method) throw new Error('method 必填: regex|pvpython|script');
  const cd = path.isAbsolute(args.case_path) ? args.case_path : path.resolve(WORKSPACE, args.case_path);
  let value = null;
  let detail = '';
  if (args.method === 'regex') {
    if (!args.file || !args.pattern) throw new Error('regex 方法需 file 和 pattern');
    const abs = path.isAbsolute(args.file) ? args.file : path.join(cd, args.file);
    const txt = await fs.readFile(abs, 'utf-8');
    const re = new RegExp(args.pattern, args.flags || 'm');
    const m = txt.match(re);
    if (!m) throw new Error(`regex 未匹配：${args.pattern}`);
    const captured = m[1] !== undefined ? m[1] : m[0];
    value = parseFloat(captured);
    if (!isFinite(value)) throw new Error('正则捕获值非数字: ' + captured);
    detail = `regex match=${captured} (line: ${m[0].slice(0,120)})`;
  } else if (args.method === 'pvpython' || args.method === 'script') {
    const exe = args.method === 'pvpython'
      ? (SETTINGS.paraviewPython || 'pvpython')
      : (SETTINGS.pythonPath || (IS_WIN ? 'python' : 'python3'));
    if (!args.script) throw new Error(args.method + ' 方法需 script 路径');
    const scriptAbs = path.isAbsolute(args.script) ? args.script : path.resolve(WORKSPACE, args.script);
    const scriptArgs = Array.isArray(args.script_args) ? args.script_args.map(String) : [];
    const r = await new Promise((resolve) => {
      const proc = spawn(exe, [scriptAbs, cd, ...scriptArgs], { windowsHide: true });
      let out = '', err = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.stderr.on('data', d => { err += d.toString(); });
      proc.on('error', e => resolve({ ok: false, err: e.message }));
      proc.on('close', code => resolve({ ok: code === 0, out, err, code }));
    });
    if (!r.ok) throw new Error(`${args.method} 退出码 ${r.code}: ${(r.err||'').slice(-300)}`);
    // 取 stdout 最后一行（脚本约定：最后一行打印数字，或 JSON {"kpi": <num>}）
    const last = (r.out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    try {
      const j = JSON.parse(last);
      value = (typeof j === 'number') ? j : (j && typeof j.kpi === 'number' ? j.kpi : null);
    } catch { value = parseFloat(last); }
    if (!isFinite(value)) throw new Error(`脚本最后一行无法解析为数字: "${last}"`);
    detail = `${args.method} stdout 末行: ${last}`;
  } else {
    throw new Error('未知 method: ' + args.method);
  }
  return `[opt_extract_kpi] value=${value}\nmethod=${args.method}  case=${path.relative(WORKSPACE, cd) || cd}\n${detail}\nJSON:\n${JSON.stringify({ value, method: args.method, case_path: cd, detail }, null, 2)}`;
}

async function optRecordResult(args) {
  if (!args.study_id) throw new Error('study_id 必填');
  if (args.trial_id === undefined || args.trial_id === null) throw new Error('trial_id 必填');
  const driverArgs = ['record',
    '--study_id', args.study_id,
    '--base_dir', OPT_BASE_DIR,
    '--trial_id', String(args.trial_id),
    '--state', args.state || 'COMPLETE'];
  if (args.value !== undefined && args.value !== null) driverArgs.push('--value', String(args.value));
  const r = await _runOptDriver(driverArgs);
  let txt = `[opt_record_result] trial=${args.trial_id} state=${r.state} value=${r.value}\nn_done=${r.n_done}`;
  if (r.best) txt += `\nbest so far: trial=${r.best.trial_id} value=${r.best.value}\nparams=${JSON.stringify(r.best.params)}`;
  return txt + `\nJSON:\n${JSON.stringify(r, null, 2)}`;
}

async function optStatus(args) {
  if (!args.study_id) throw new Error('study_id 必填');
  const r = await _runOptDriver(['status', '--study_id', args.study_id, '--base_dir', OPT_BASE_DIR]);
  const lines = [
    `[opt_status] study=${r.study_id}  sampler=${r.sampler}  direction=${r.direction}`,
    `done=${r.n_done}  pruned=${r.n_pruned}  failed=${r.n_failed}  running=${r.n_running}  budget=${r.budget}`,
  ];
  if (r.best) lines.push(`best: trial=${r.best.trial_id} value=${r.best.value}`,
                         `      params=${JSON.stringify(r.best.params)}`);
  if (r.convergence && r.convergence.length) {
    const tail = r.convergence.slice(-5);
    lines.push('convergence (last 5):');
    for (const c of tail) lines.push(`  trial ${c.trial_id}: value=${c.value}  running_best=${c.running_best}`);
  }
  if (r.importance && !r.importance._error) {
    const sorted = Object.entries(r.importance).sort((a,b) => b[1]-a[1]).slice(0, 8);
    lines.push('param importance:');
    for (const [k, v] of sorted) lines.push(`  ${k}: ${(v*100).toFixed(1)}%`);
  }
  return lines.join('\n') + `\nJSON:\n${JSON.stringify(r, null, 2)}`;
}

async function optRender(args, ws) {
  if (!args.study_id) throw new Error('study_id 必填');
  const kind = args.kind || 'history';
  const outDir = path.join(OPT_BASE_DIR, args.study_id, 'plots');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${kind}_${Date.now().toString(36)}.png`);
  const r = await _runOptDriver(['render', '--study_id', args.study_id, '--base_dir', OPT_BASE_DIR, '--kind', kind, '--out', outPath]);
  if (!r.ok) throw new Error('opt_render 失败: ' + (r.error || 'unknown'));
  // 推到聊天（复用 sim_render 风格的消息）
  try {
    const buf = await fs.readFile(outPath);
    const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
    const payload = { type: 'sim_render', dataUrl, label: `opt_${kind} (${args.study_id})`, meta: { study: args.study_id, kind } };
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
    else for (const c of allClients) if (c.readyState === 1) c.send(JSON.stringify(payload));
  } catch {}
  return `[opt_render] kind=${kind}  ok=true\npath: ${outPath}\n已推送到聊天界面。`;
}

// ====================== v6 \u7f51\u683c\u81ea\u52a8\u6838\u5bf9 / STL 预检 / patch 对照 ======================
// 把 dataUrl(base64 PNG) 写到 tmp 路径，返回路径（给 visionAnalyze 用）
async function _dataUrlToTmpPng(dataUrl, tag) {
  const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw new Error('dataUrl 解析失败');
  const buf = Buffer.from(m[1], 'base64');
  const p = path.join(os.tmpdir(), `dscm_mv_${tag || 'x'}_${crypto.randomBytes(6).toString('hex')}.png`);
  await fs.writeFile(p, buf);
  return p;
}

function _parseCheckMeshOutput(txt) {
  const out = { meshOk: null, nCells: null, nFaces: null, nPoints: null, maxNonOrtho: null, maxSkew: null, maxAspectRatio: null, nNegativeVolumeCells: 0, nOpenCells: 0, failedChecks: [], warnings: [] };
  const m1 = /Mesh OK\./.exec(txt); if (m1) out.meshOk = true;
  const m2 = /Failed\s+(\d+)\s+mesh checks/i.exec(txt); if (m2) { out.meshOk = false; out.failedChecks.push(`Failed ${m2[1]} checks`); }
  const grab = (re, key) => { const m = re.exec(txt); if (m) out[key] = parseFloat(m[1]); };
  grab(/cells:\s*(\d+)/i, 'nCells');
  grab(/faces:\s*(\d+)/i, 'nFaces');
  grab(/points:\s*(\d+)/i, 'nPoints');
  grab(/Max non-orthogonality\s*=\s*([\d.eE+-]+)/, 'maxNonOrtho');
  grab(/Max skewness\s*=\s*([\d.eE+-]+)/, 'maxSkew');
  grab(/Max aspect ratio\s*=\s*([\d.eE+-]+)/, 'maxAspectRatio');
  const neg = /([\d]+)\s+cells with negative volume/i.exec(txt); if (neg) out.nNegativeVolumeCells = parseInt(neg[1], 10);
  const open = /Number of open cells.*?:\s*(\d+)/i.exec(txt); if (open) out.nOpenCells = parseInt(open[1], 10);
  // 收集 *** Warning / *** Failed 行
  for (const line of txt.split(/\r?\n/)) {
    if (/^\s*\*{2,3}\s*/.test(line)) out.warnings.push(line.trim().slice(0, 200));
  }
  // 兜底判断：没有显式 Mesh OK 但也没有 negVol/failed，就按 warnings 判
  if (out.meshOk === null) {
    out.meshOk = (out.nNegativeVolumeCells === 0 && out.failedChecks.length === 0 && (out.maxNonOrtho === null || out.maxNonOrtho < 70) && (out.maxSkew === null || out.maxSkew < 4));
  }
  return out;
}

function _meshVerifyJudge(metrics, stage) {
  const issues = [];
  const suggestions = [];
  if (metrics.nNegativeVolumeCells > 0) { issues.push(`存在 ${metrics.nNegativeVolumeCells} 个负体积 cell`); suggestions.push('降低 snappy refinementSurfaces level 或 location_in_mesh 远离表面；blockMesh 可粗化背景网格'); }
  if (metrics.nOpenCells > 0) { issues.push(`存在 ${metrics.nOpenCells} 个 open cell（拓扑破洞）`); suggestions.push('STL 不封闭或 snappy 没切干净：先 foam_stl_render 检 STL 法向/封闭，必要时 surfaceFeatures 改 includedAngle'); }
  if (metrics.maxNonOrtho !== null && metrics.maxNonOrtho > 70) { issues.push(`maxNonOrtho=${metrics.maxNonOrtho} > 70°`); suggestions.push('加 nNonOrthogonalCorrectors=2~3；或在 fvSchemes 用 limited 0.5'); }
  if (metrics.maxSkew !== null && metrics.maxSkew > 4) { issues.push(`maxSkew=${metrics.maxSkew} > 4`); suggestions.push('降低 snappy refinement 跨级差；增加 nSmoothPatch / nRelaxIter'); }
  if (metrics.maxAspectRatio !== null && metrics.maxAspectRatio > 1000) { issues.push(`maxAspectRatio=${metrics.maxAspectRatio} > 1000`); suggestions.push('边界层第一层太薄：减小 finalLayerThickness 或 expansionRatio'); }
  if (metrics.failedChecks.length) { issues.push(...metrics.failedChecks); }
  const pass = metrics.meshOk === true && metrics.nNegativeVolumeCells === 0 && metrics.nOpenCells === 0 && issues.length === 0;
  return { pass, issues, suggestions };
}

// ============== v6 解析 snappyHexMesh log 的 layer addition 总结 ==============
// 兼容多种 OpenFOAM 版本输出格式：
//   patch              faces    layers   overall thickness
//                       [n]              [m]     (%)
//   impeller          12345    5         1.2e-3  87.2%
// 也兼容 OF v12 / .com 的：
//   Extruding 5 layers on patch impeller, average thickness = 0.0012 m (94%)
function _parseSnappyLayerLog(txt) {
  const out = { patches: {}, overall_coverage_pct: null, layers_warning: [] };
  if (!txt) return out;
  // 形式 A：表格
  const reTable = /^\s*([A-Za-z_][\w.\-]*)\s+(\d+)\s+(\d+)\s+([\d.eE+\-]+)\s+([\d.]+)\s*%/gm;
  let m;
  while ((m = reTable.exec(txt)) !== null) {
    const name = m[1];
    if (['Patch','faces','layers'].includes(name)) continue;
    out.patches[name] = {
      faces: parseInt(m[2], 10),
      layers_added: parseInt(m[3], 10),
      thickness_m: parseFloat(m[4]),
      coverage_pct: parseFloat(m[5])
    };
  }
  // 形式 B：单行 Extruding
  const reLine = /Extruding\s+(\d+)\s+layers? on patch\s+([\w.\-]+).*?thickness\s*=\s*([\d.eE+\-]+).*?\(\s*([\d.]+)\s*%\s*\)/gi;
  while ((m = reLine.exec(txt)) !== null) {
    const name = m[2];
    if (out.patches[name]) continue;
    out.patches[name] = {
      faces: null,
      layers_added: parseInt(m[1], 10),
      thickness_m: parseFloat(m[3]),
      coverage_pct: parseFloat(m[4])
    };
  }
  // 全局总结：取最低 coverage
  const vals = Object.values(out.patches).map(p => p.coverage_pct).filter(v => isFinite(v));
  if (vals.length) {
    out.overall_coverage_pct = Math.min(...vals);
    for (const [k, v] of Object.entries(out.patches)) {
      if (v.coverage_pct < 80) out.layers_warning.push(`${k}: 仅 ${v.coverage_pct.toFixed(1)}% 层覆盖`);
    }
  }
  // 没解析到 layers 也不是错——可能根本没开 addLayers
  if (!vals.length && /addLayers\s+true/i.test(txt) === false) {
    out.layers_warning.push('snappy log 中未启用 addLayers，跳过 layer 解析');
  }
  return out;
}
async function _readSnappyLogIfAny(casePath) {
  // 常见 log 位置：log.snappyHexMesh / log/snappyHexMesh / runs/<id>/log.snappyHexMesh
  const cands = [
    path.join(casePath, 'log.snappyHexMesh'),
    path.join(casePath, 'log', 'snappyHexMesh.log'),
    path.join(casePath, 'log', 'snappyHexMesh'),
  ];
  for (const c of cands) {
    try { const s = await fs.stat(c); if (s.isFile()) return await fs.readFile(c, 'utf8'); } catch {}
  }
  return null;
}

async function foamMeshVerify(args, ws, session) {
  const { case_path, stage = 'final', ask_vision = true, n_views = 2 } = args || {};
  if (!case_path) throw new Error('foam_mesh_verify: case_path 必填');
  const abs = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
  // 1) checkMesh
  const checkOut = await runOpenFoam({ casePath: abs, command: 'checkMesh -allTopology -allGeometry' }, ws);
  const metrics = _parseCheckMeshOutput(checkOut);
  // 1b) snappyHexMesh log 解析 layer coverage（如果有）
  const snapLog = await _readSnappyLogIfAny(abs);
  const layers = _parseSnappyLayerLog(snapLog || '');
  // 2) 渲染 n_views 张（覆盖等角 + 顶视，stage=snappy 时多加一个侧切）
  const camPresets = [
    { azimuth: 30, elevation: 20, tag: 'iso' },
    { azimuth: 0,  elevation: 89, tag: 'top' },
    { azimuth: 90, elevation: 0,  tag: 'side' },
    { azimuth: 60, elevation: -10, tag: 'iso2' }
  ];
  const k = Math.max(1, Math.min(4, n_views | 0 || 2));
  const renders = [];
  for (let i = 0; i < k; i++) {
    try {
      const cam = camPresets[i];
      const r = await pvRenderOffscreen({ casePath: abs, azimuth: cam.azimuth, elevation: cam.elevation });
      const p = await _dataUrlToTmpPng(r.dataUrl, `${stage}_${cam.tag}`);
      renders.push({ tag: cam.tag, path: p });
      // 顺手广播到前端 ParaView 面板
      try { pvBroadcast({ type: 'sim_frame', dataUrl: r.dataUrl, meta: { ...(r.meta||{}), label: `mesh_verify/${stage}/${cam.tag}` } }); } catch {}
    } catch (e) {
      renders.push({ tag: camPresets[i].tag, error: e.message });
    }
  }
  // 3) 视觉裁判（可选）
  let vision = '';
  const okRenders = renders.filter(x => x.path).map(x => x.path);
  if (ask_vision && okRenders.length) {
    const q = `这是 OpenFOAM 算例在 ${stage} 阶段的网格渲染图（${okRenders.length} 个视角）。请按以下硬性 checklist 逐条判断并只输出 JSON：\n` +
      `{"shape_ok": true/false, "shape_reason": "...",\n` +
      ` "boundary_clean": true/false, "boundary_reason": "...",\n` +
      ` "refinement_reasonable": true/false, "refinement_reason": "...",\n` +
      ` "obvious_defects": ["..."],\n` +
      ` "overall_pass": true/false}\n` +
      `检查点：① 整体几何外形是否与预期 case 一致（不要变形/缺角）；② 边界面是否干净、没有锯齿状破裂；③ 加密区域是否合理（贴近物体、不浪费在空气）；④ 有无明显的孔洞、悬空 cell、超长拉伸。回答全部用中文。`;
    try {
      const progress = session && typeof session._progressPub === 'function' ? session._progressPub : null;
      vision = await visionAnalyze(okRenders, q, 800, progress);
    } catch (e) { vision = 'vision_analyze 调用失败：' + e.message; }
  }
  // 4) 综合裁决
  const j = _meshVerifyJudge(metrics, stage);
  // 4b) layer coverage 纳入判定（stage=layers 或 final 时硬性要求 >=80%）
  const layerIssues = [];
  const layerSuggestions = [];
  if (layers && Object.keys(layers.patches).length) {
    for (const [k, v] of Object.entries(layers.patches)) {
      if (v.coverage_pct != null && v.coverage_pct < 80 && (stage === 'layers' || stage === 'final')) {
        layerIssues.push(`patch ${k}: layer 覆盖仅 ${v.coverage_pct.toFixed(1)}% (<80%)`);
      }
    }
    if (layerIssues.length) {
      layerSuggestions.push('边角 layer 覆盖不足→ ① 调小 first_layer_thickness 或 expansionRatio；② 加大 nLayerIter、nRelaxedIter；③ 把 featureAngle 调大到 130~150；④ 若是薄壁/小特征，提高表面 refinement level 让 cell 更细。');
    }
  }
  // 视觉若明显反对，也降为 fail
  let visionPass = null;
  const mvJson = /\{[\s\S]*"overall_pass"\s*:\s*(true|false)[\s\S]*\}/.exec(vision || '');
  if (mvJson) visionPass = mvJson[1] === 'true';
  const finalPass = j.pass && (visionPass !== false) && layerIssues.length === 0;
  const allIssues = [...j.issues, ...layerIssues];
  const allSugg = [...j.suggestions, ...layerSuggestions];
  const result = {
    pass: finalPass,
    stage,
    metrics,
    layers: layers && Object.keys(layers.patches).length ? layers : null,
    issues: allIssues,
    suggestions: allSugg,
    renders: renders.map(r => r.path ? { tag: r.tag, path: r.path } : { tag: r.tag, error: r.error }),
    vision_pass: visionPass,
    vision: vision || '(未调用 VLM)'
  };
  // 给 LLM 一个紧凑可读的文本 + JSON 双视图
  const head = finalPass ? `✓ [mesh_verify/${stage}] 通过` : `✗ [mesh_verify/${stage}] 未通过 (${allIssues.length} 项问题)`;
  const layerSummary = layers && Object.keys(layers.patches).length
    ? `\nlayers: ` + Object.entries(layers.patches).map(([k,v])=>`${k}=${v.layers_added}层/${v.coverage_pct?.toFixed?.(0) ?? '?'}%`).join(', ')
    : '';
  return `${head}\n` +
    `metrics: cells=${metrics.nCells} faces=${metrics.nFaces} maxNonOrtho=${metrics.maxNonOrtho} maxSkew=${metrics.maxSkew} negVol=${metrics.nNegativeVolumeCells} openCells=${metrics.nOpenCells}` + layerSummary + `\n` +
    (allIssues.length ? `issues:\n  - ${allIssues.join('\n  - ')}\n` : '') +
    (allSugg.length ? `suggestions:\n  - ${allSugg.join('\n  - ')}\n` : '') +
    (vision ? `\n=== VLM 视觉评审 ===\n${vision.slice(0, 1200)}\n` : '') +
    `\n=== JSON ===\n${JSON.stringify(result, null, 2)}`;
}

// ============== v6 · STL 贴合度核验 (foam_mesh_stl_check) ==============
async function foamMeshStlCheck(args, ws) {
  const { case_path, ref_stl, patches, samples = 5000,
          tol_mean_pct = 2.0, tol_p95_pct = 5.0, tol_max_pct = 10.0 } = args || {};
  if (!case_path) throw new Error('foam_mesh_stl_check: case_path 必填');
  if (!ref_stl)   throw new Error('foam_mesh_stl_check: ref_stl 必填（原始 STL 路径）');
  if (!Array.isArray(patches) || patches.length === 0)
    throw new Error('foam_mesh_stl_check: patches 必填，至少一个 patch 名');

  const absCase = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
  if (!await pathExistsSync(absCase)) throw new Error('case_path 不存在: ' + absCase);
  const refAbs = path.isAbsolute(ref_stl) ? ref_stl : path.resolve(absCase, ref_stl);
  if (!await pathExistsSync(refAbs)) throw new Error('ref_stl 不存在: ' + refAbs);

  // 1) 用 surfaceMeshTriangulate 把 patch 网格表面导出 STL
  const triDir = path.join(absCase, 'constant', 'triSurface');
  await fs.mkdir(triDir, { recursive: true });
  const extracted = path.join(triDir, '_nullflux_mesh_extracted.stl');
  try { await fs.unlink(extracted); } catch {}
  const patchList = '(' + patches.join(' ') + ')';
  // 注意：surfaceMeshTriangulate 接受相对 case 的输出路径
  const relOut = path.relative(absCase, extracted).replace(/\\/g, '/');
  const cmd = `surfaceMeshTriangulate -patches '${patchList}' '${relOut}'`;
  const ofOut = await runOpenFoam({ casePath: absCase, command: cmd }, ws);
  if (!await pathExistsSync(extracted)) {
    return `❌ [foam_mesh_stl_check] surfaceMeshTriangulate 未产出 STL：${extracted}\n` +
      `常见原因：patch 名拼错、网格没生成、polyMesh/ 不存在。\n` +
      `OpenFOAM 输出 tail:\n${ofOut.slice(-1500)}`;
  }

  // 2) 调 Python 核验
  const py = SETTINGS.pythonPath || (IS_WIN ? 'python' : 'python3');
  const script = path.join(__dirname, 'mesh_stl_check.py');
  const pyArgs = [script,
    '--ref', refAbs,
    '--mesh', extracted,
    '--samples', String(samples),
    '--tol_mean_pct', String(tol_mean_pct),
    '--tol_p95_pct',  String(tol_p95_pct),
    '--tol_max_pct',  String(tol_max_pct),
  ];
  const r = await new Promise((resolve, reject) => {
    const proc = spawn(py, pyArgs, { windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', e => reject(new Error('spawn mesh_stl_check.py 失败: ' + e.message)));
    proc.on('close', code => {
      const last = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      try { resolve(JSON.parse(last)); }
      catch (e) {
        reject(new Error(`mesh_stl_check 退出码 ${code}，stdout 末尾非 JSON：\n${last.slice(0,400)}\nstderr:${err.slice(-400)}`));
      }
    });
  });

  if (!r.ok) {
    return `❌ [foam_mesh_stl_check] python 报错：${r.error || '(unknown)'}\n${(r.trace || '').slice(-600)}`;
  }
  const verdict = r.pass ? '✅ PASS' : '❌ FAIL';
  const lines = [];
  lines.push(`${verdict} [foam_mesh_stl_check]  patches=${patches.join(',')}`);
  lines.push(`  bbox 对角线 L = ${r.L_diag_ref}  (单位与 STL 一致)`);
  lines.push(`  bbox 偏差   = ${r.bbox_diff_pct_of_L}% L`);
  lines.push(`  表面积比 mesh/ref = ${(r.area_ratio_mesh_over_ref*100).toFixed(1)}%`);
  lines.push(`  ref→mesh: mean=${r.forward_ref_to_mesh.mean.toFixed(6)}  p95=${r.forward_ref_to_mesh.p95.toFixed(6)}  max=${r.forward_ref_to_mesh.max.toFixed(6)}`);
  lines.push(`  mesh→ref: mean=${r.reverse_mesh_to_ref.mean.toFixed(6)}  p95=${r.reverse_mesh_to_ref.p95.toFixed(6)}  max=${r.reverse_mesh_to_ref.max.toFixed(6)}`);
  lines.push(`  → 占 L %: mean=${r.mean_pct_of_L}%  p95=${r.p95_pct_of_L}%  Hausdorff=${r.hausdorff_pct_of_L}%`);
  if (r.issues && r.issues.length) {
    lines.push('  ⚠ 检出问题:');
    r.issues.forEach(s => lines.push('    - ' + s));
  }
  if (!r.pass) {
    lines.push('  🔧 修复建议（按顺序试）:');
    lines.push('    1) 提高 snappyHexMeshDict 的 refinement level (面 → +1)，加 featureEdgeMesh 提取边');
    lines.push('    2) snap{ nSmoothPatch ↑ 5→10, tolerance ↓ 2→1, nSolveIter ↑ 30→100 }');
    lines.push('    3) 检查 locationInMesh 是否落在期望的流场域内部（不是固体内）');
    lines.push('    4) 若 castellated 漏面：提高 maxLocalCells / maxGlobalCells，或减小 minRefinementCells');
    lines.push('    5) layer 鼓包（mesh→ref max 大）：finalLayerThickness 减小、relativeSizes=true');
  }
  lines.push(`  triangles: ref=${r.tri_count_ref}, mesh=${r.tri_count_mesh}, samples=${r.samples}`);
  lines.push('\n=== JSON ===\n' + JSON.stringify(r, null, 2));
  return lines.join('\n');
}

async function foamStlRender(args, ws) {
  const { stl_path, n_views = 3 } = args || {};
  if (!stl_path) throw new Error('foam_stl_render: stl_path 必填');
  const abs = path.isAbsolute(stl_path) ? stl_path : path.resolve(WORKSPACE, stl_path);
  await fs.access(abs);
  // 先取一份几何元数据（复用现有 inspect）
  let inspect = null;
  try { inspect = await foamStlInspect(stl_path); } catch (e) { inspect = '(foam_stl_inspect 失败: ' + e.message + ')'; }
  const presets = [
    { azimuth: 0,  elevation: 0,  tag: 'front' },
    { azimuth: 0,  elevation: 89, tag: 'top' },
    { azimuth: 30, elevation: 20, tag: 'iso' },
    { azimuth: 90, elevation: 0,  tag: 'side' }
  ];
  const k = Math.max(1, Math.min(4, n_views | 0 || 3));
  const out = [];
  for (let i = 0; i < k; i++) {
    const cam = presets[i];
    try {
      const r = await pvRenderOffscreen({ casePath: abs, azimuth: cam.azimuth, elevation: cam.elevation });
      const p = await _dataUrlToTmpPng(r.dataUrl, `stl_${cam.tag}`);
      out.push({ tag: cam.tag, path: p });
      try { pvBroadcast({ type: 'sim_frame', dataUrl: r.dataUrl, meta: { label: `stl_render/${cam.tag}` } }); } catch {}
    } catch (e) { out.push({ tag: cam.tag, error: e.message }); }
  }
  const head = `[foam_stl_render] ${path.basename(abs)} → ${out.filter(x => x.path).length}/${k} 视角已渲染并推送到 ParaView 面板。`;
  return head + '\n\n=== foam_stl_inspect ===\n' + (typeof inspect === 'string' ? inspect : JSON.stringify(inspect, null, 2)) +
    '\n\n=== 渲染图路径（可传给 vision_analyze） ===\n' + JSON.stringify(out, null, 2);
}

// 解析 constant/polyMesh/boundary（OpenFOAM 文本字典）→ [{name,type,nFaces,startFace}]
function _parseFoamBoundary(txt) {
  const patches = [];
  // 找顶层 ( ... ) 区块
  const top = /\(([\s\S]*)\)\s*\/\/?\s*\*?\s*$/.exec(txt) || /\(([\s\S]*)\)\s*$/.exec(txt);
  const body = top ? top[1] : txt;
  // 每个 patch 形如：name { type ...; nFaces ...; startFace ...; }
  const re = /([A-Za-z_][A-Za-z0-9_.\-]*)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(body))) {
    const name = m[1];
    if (name === 'FoamFile') continue;
    const block = m[2];
    const get = (k) => { const r = new RegExp(k + '\\s+([^;\\s]+)\\s*;').exec(block); return r ? r[1] : null; };
    patches.push({
      name,
      type: get('type'),
      physicalType: get('physicalType'),
      nFaces: parseInt(get('nFaces') || '0', 10) || 0,
      startFace: parseInt(get('startFace') || '0', 10) || 0
    });
  }
  return patches;
}

async function foamPatchDiff(args) {
  const { case_path, snapshot_before } = args || {};
  if (!case_path) throw new Error('foam_patch_diff: case_path 必填');
  const abs = path.isAbsolute(case_path) ? case_path : path.resolve(WORKSPACE, case_path);
  const bfile = path.join(abs, 'constant', 'polyMesh', 'boundary');
  let txt;
  try { txt = await fs.readFile(bfile, 'utf8'); }
  catch (e) { throw new Error('读不到 constant/polyMesh/boundary（mesh 还没生成？）: ' + e.message); }
  const patches = _parseFoamBoundary(txt);
  let diff = null;
  if (snapshot_before) {
    try {
      const prev = JSON.parse(snapshot_before);
      const prevMap = new Map((prev.patches || prev).map(p => [p.name, p]));
      const curMap = new Map(patches.map(p => [p.name, p]));
      const added = [], removed = [], changed = [];
      for (const [n, p] of curMap) if (!prevMap.has(n)) added.push(p);
      for (const [n, p] of prevMap) if (!curMap.has(n)) removed.push(p);
      for (const [n, p] of curMap) {
        const pv = prevMap.get(n);
        if (pv && (pv.type !== p.type || pv.nFaces !== p.nFaces)) changed.push({ name: n, before: pv, after: p });
      }
      diff = { added, removed, changed };
    } catch (e) { diff = { error: 'snapshot_before 解析失败: ' + e.message }; }
  }
  const summary = patches.map(p => `  ${p.name.padEnd(20)} ${String(p.type).padEnd(14)} nFaces=${p.nFaces}`).join('\n');
  return `[foam_patch_diff] ${path.relative(WORKSPACE, abs)} 共 ${patches.length} 个 patch:\n${summary}\n\n=== JSON ===\n${JSON.stringify({ patches, diff }, null, 2)}`;
}

// ====================== v0.6.0 自治可靠性模块 ======================
// 1) 微型 JSON Schema 校验器（仅支持 server 内 TOOLS 使用的子集：type/properties/required/items/enum/minimum/maximum/pattern）
function _schemaCheck(schema, value, p, issues) {
  if (!schema || typeof schema !== 'object') return;
  const t = schema.type;
  if (t === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) { issues.push(`${p} 应为 object`); return; }
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) if (!(k in value)) issues.push(`${p}.${k} 缺失（required）`);
    }
    if (schema.properties) {
      for (const k of Object.keys(value)) {
        if (schema.properties[k]) _schemaCheck(schema.properties[k], value[k], `${p}.${k}`, issues);
      }
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) { issues.push(`${p} 应为 array`); return; }
    if (schema.items) for (let i = 0; i < value.length; i++) _schemaCheck(schema.items, value[i], `${p}[${i}]`, issues);
  } else if (t === 'string') {
    if (typeof value !== 'string') { issues.push(`${p} 应为 string`); return; }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) issues.push(`${p}="${value}" 不在 enum=${JSON.stringify(schema.enum)}`);
    if (schema.pattern) { try { if (!new RegExp(schema.pattern).test(value)) issues.push(`${p} 不匹配 ${schema.pattern}`); } catch {} }
  } else if (t === 'number' || t === 'integer') {
    if (typeof value !== 'number' || !isFinite(value)) { issues.push(`${p} 应为 number`); return; }
    if (t === 'integer' && !Number.isInteger(value)) issues.push(`${p} 应为整数`);
    if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push(`${p} < minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push(`${p} > maximum ${schema.maximum}`);
  } else if (t === 'boolean') {
    if (typeof value !== 'boolean') issues.push(`${p} 应为 boolean`);
  }
}
function validateToolInput(name, args) {
  const t = TOOLS.find(x => x.function && x.function.name === name);
  if (!t) return { ok: true, issues: [] }; // 未知工具交给后续 default 分支
  const issues = [];
  _schemaCheck(t.function.parameters || { type: 'object' }, args == null ? {} : args, '$', issues);
  return { ok: issues.length === 0, issues };
}

// v6.0.1: 宽容参数名别名 —— 不同大模型会发 file_path/text/body/…，这里统一归位到准的 path/content。
const TOOL_ARG_ALIAS = {
  // 路径类
  file_path: 'path', filePath: 'path', filepath: 'path', file: 'path', target: 'path', filename: 'path', file_name: 'path',
  dir: 'path', directory: 'path', folder: 'path',
  // 内容类
  text: 'content', body: 'content', data: 'content', source: 'content', code: 'content', file_content: 'content', fileContent: 'content', new_content: 'content', newContent: 'content',
  // edit_file
  oldStr: 'old_str', old_string: 'old_str', oldString: 'old_str', search: 'old_str', find: 'old_str',
  newStr: 'new_str', new_string: 'new_str', newString: 'new_str', replace: 'new_str', replacement: 'new_str',
  // run_command
  cmd: 'command', shell: 'command', script: 'command', bash: 'command'
};
// 工具级别名（仅特定工具适用，避免污染 query/url 等通用字段）
const TOOL_ARG_ALIAS_BY_TOOL = {
  grep_search: { query: 'pattern', regex: 'pattern', text: 'pattern' }
};
function normalizeToolArgs(args, toolName) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const perTool = (toolName && TOOL_ARG_ALIAS_BY_TOOL[toolName]) || null;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    let canon = k;
    if (perTool && perTool[k]) canon = perTool[k];
    else if (TOOL_ARG_ALIAS[k]) canon = TOOL_ARG_ALIAS[k];
    // 不覆盖已存在的准名字段
    if (out[canon] === undefined) out[canon] = v;
  }
  return out;
}

// 2) Run/Stage 状态机（落盘 runs/<runId>/state.json + memo.json，方便重启接续）
const _RUNS_DIR = () => path.join(WORKSPACE, 'runs');
function _ensureRunState(session) {
  if (!session.runState) session.runState = { runId: null, label: '', stages: [], failCount: {}, memos: [], startedAt: 0 };
  return session.runState;
}
async function _writeRunState(rs) {
  if (!rs.runId) return;
  try {
    const dir = path.join(_RUNS_DIR(), rs.runId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(rs, null, 2), 'utf8');
  } catch {}
}
async function startRun(session, label) {
  const rs = _ensureRunState(session);
  rs.runId = 'run_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  rs.label = String(label || '').slice(0, 80);
  rs.stages = []; rs.failCount = {}; rs.memos = []; rs.startedAt = Date.now();
  await _writeRunState(rs);
  return rs;
}
async function stageStart(session, stageName) {
  const rs = _ensureRunState(session);
  if (!rs.runId) await startRun(session, stageName);
  rs.stages.push({ name: stageName, status: 'in_progress', startedAt: Date.now(), endedAt: 0, verify: null, artifacts: [], memo: '' });
  await _writeRunState(rs);
  return rs.stages[rs.stages.length - 1];
}
async function stageDone(session, stageName, opts) {
  const rs = _ensureRunState(session);
  const s = [...rs.stages].reverse().find(x => x.name === stageName && x.status === 'in_progress') || rs.stages[rs.stages.length - 1];
  if (s) {
    s.status = (opts && opts.passed === false) ? 'failed' : 'done';
    s.endedAt = Date.now();
    if (opts && opts.verify) s.verify = opts.verify;
    if (opts && Array.isArray(opts.artifacts)) s.artifacts = opts.artifacts;
    if (opts && opts.memo) { s.memo = String(opts.memo); rs.memos.push({ stage: stageName, t: Date.now(), text: s.memo }); }
  }
  await _writeRunState(rs);
  return s;
}

// 3) Watchdog
const WATCHDOG = { maxFailPerTool: 5, maxRunMs: 6 * 3600 * 1000 };
function recordToolResult(session, name, ok) {
  const rs = _ensureRunState(session);
  if (ok) rs.failCount[name] = 0;
  else rs.failCount[name] = (rs.failCount[name] || 0) + 1;
}
function checkWatchdog(session) {
  const rs = _ensureRunState(session);
  if (rs.startedAt && (Date.now() - rs.startedAt) > WATCHDOG.maxRunMs) {
    return { stop: true, reason: `Run 运行已超过 ${(WATCHDOG.maxRunMs/3600000).toFixed(1)} 小时硬上限` };
  }
  for (const [k, v] of Object.entries(rs.failCount || {})) {
    if (v >= WATCHDOG.maxFailPerTool) return { stop: true, reason: `工具 ${k} 连续失败 ${v} 次，已熔断` };
  }
  return { stop: false };
}

// 4) 通用视觉 Verifier（统一 JSON 返回）
async function genericVisionVerify(stage, prompt, imagePaths, expected) {
  if (!imagePaths || !imagePaths.length) return { passed: false, score: 0, reasons: ['无渲染图可供验证'], suggestions: ['先渲染后再校验'] };
  const q = `【${stage} 验证】\n${prompt || ''}\n${expected ? '\n期望特征：' + expected : ''}\n\n请严格按以下 JSON 格式输出（且只输出 JSON，不要任何额外文字）：\n{"passed": true|false, "score": 0~100, "reasons": ["..."], "suggestions": ["..."]}`;
  const ans = await visionAnalyze(imagePaths.slice(0, 4), q, 800);
  const m = String(ans).match(/\{[\s\S]*\}/);
  if (!m) return { passed: false, score: 0, reasons: ['VLM 输出非 JSON'], suggestions: [], raw: String(ans).slice(0, 400) };
  try { const j = JSON.parse(m[0]); return { passed: !!j.passed, score: +j.score || 0, reasons: j.reasons || [], suggestions: j.suggestions || [], raw: m[0] }; }
  catch (e) { return { passed: false, score: 0, reasons: ['JSON 解析失败: ' + e.message], suggestions: [], raw: m[0] }; }
}

// 5) 读文档视觉回退：读失败 / 文本过短 → 把已渲染的页面图丢给 VLM 转回基线
const _DOC_FALLBACK_MIN_CHARS = 200;
async function readWithVisionFallback(kind, args, session, baseFn) {
  let baseResult = null, baseErr = null;
  try { baseResult = await baseFn(); }
  catch (e) { baseErr = e; }
  // 抽取实际文本量评估（read_document 返回带头部 [pdf · 12 页]）
  const txt = typeof baseResult === 'string' ? baseResult : '';
  // 去掉头部 [..] 与"--- 提取的图片..." 之后的尾部
  const body = txt.replace(/^\[[^\]]*\]\s*/, '').split('\n--- 提取的图片')[0] || '';
  const stripped = body.replace(/\s/g, '');
  const baselineEmpty = baseErr || !txt || /^(读取失败|解析失败|调用 Python 失败)/.test(txt) || stripped.length < _DOC_FALLBACK_MIN_CHARS;
  if (!baselineEmpty) return baseResult;

  // 触发视觉回退：先尝试用 readDocument 获取已渲染的扫描页图片清单
  const progress = session && session._progressPub ? session._progressPub : () => {};
  progress(`[vision_fallback] 基线读取失败/过短，尝试用 VLM 识别 ${args.path} …`);
  let pageImages = [];
  try {
    const abs = path.isAbsolute(args.path) ? args.path : safePath(args.path);
    const py = SETTINGS.pythonPath || (IS_WIN ? 'python' : 'python3');
    const script = path.join(__dirname, 'doc_reader.py');
    const safeBase = path.basename(abs).replace(/[^\w.\-]+/g, '_').slice(0, 80);
    const imgOutAbs = path.join(WORKSPACE, '.cache', 'pdf_images', safeBase + '_vfb_' + Date.now().toString(36));
    await fs.mkdir(imgOutAbs, { recursive: true });
    const out = await new Promise((resolve) => {
      const proc = spawn(py, [script, abs], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PDF_IMG_OUT_DIR: imgOutAbs, PDF_FORCE_RENDER: '1' } });
      let buf = '', err = '';
      proc.stdout.on('data', d => { buf += d.toString('utf8'); });
      proc.stderr.on('data', d => { err += d.toString('utf8'); });
      proc.on('error', () => resolve({ ok: false, err: 'spawn' }));
      proc.on('close', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, err: err.slice(-300) }); } });
    });
    if (out && Array.isArray(out.images)) {
      pageImages = out.images.filter(im => im.kind === 'scan_page' || im.kind === 'page').map(im => im.path);
      if (!pageImages.length) pageImages = out.images.slice(0, 6).map(im => im.path).filter(Boolean);
    }
  } catch (e) {
    return `[vision_fallback 失败] 渲染页面阶段：${e.message}\n(基线错误：${baseErr ? baseErr.message : (txt || '').slice(0, 200)})`;
  }
  if (!pageImages.length) {
    return `[vision_fallback 失败] 无法获得页面图像\n(基线错误：${baseErr ? baseErr.message : (txt || '').slice(0, 200)})`;
  }
  progress(`[vision_fallback] 取得 ${pageImages.length} 页图片，调用 VLM 并发识别 …`);
  const MAX_PAGES = 8;
  const targets = pageImages.slice(0, MAX_PAGES);
  // 并发 3 路 VLM（顺序逐页会到 8*60s=480s，主 LLM 端早就空闲超时；并发降到 ~3 批 ≈ 180s）
  const CONC = Math.max(1, parseInt(process.env.VLM_FALLBACK_CONCURRENCY || '3', 10));
  const pagesArr = new Array(targets.length);
  let nextIdx = 0;
  let doneCount = 0;
  async function _worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= targets.length) return;
      const q = `这是 ${kind === 'paper' ? '论文' : '文档'} 第 ${i+1} 页的图像。请准确转录页面中的全部文字（含标题、正文、表格、图注、公式用 LaTeX）。仅输出该页文字，不要解释。`;
      let ans = '';
      try { ans = await visionAnalyze([targets[i]], q, 1500, progress, { detail: 'low' }); } catch (e) { ans = '[识别失败: ' + e.message + ']'; }
      pagesArr[i] = { page: i + 1, text: String(ans).replace(/^\[vision_analyze[^\]]*\]\s*/, '') };
      doneCount++;
      progress(`[vision_fallback] 已完成 ${doneCount}/${targets.length} 页`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, targets.length) }, () => _worker()));
  const pages = pagesArr.filter(Boolean);
  const merged = pages.map(p => `\n--- 第 ${p.page} 页 ---\n${p.text}`).join('\n');
  const tail = pageImages.length > MAX_PAGES ? `\n... [仅识别前 ${MAX_PAGES} 页，共 ${pageImages.length} 页] ...` : '';
  return `[vision_fallback · ${pages.length}/${pageImages.length} 页]\n基线读取失败/文本过短，已用 VLM 转回文本基线。${tail}${merged}`;
}
// ====================== v0.6.0 模块结束 ======================

async function execTool(name, args, session, ws) {
  // v6.0.1: 先做参数名别名归位，避免模型发错 key 被当成 schema 错误冲起 watchdog
  args = normalizeToolArgs(args, name);
  // v6: 输入 Schema 校验（找不到工具的不拦截，交给 default）
  try {
    const v = validateToolInput(name, args || {});
    if (!v.ok) {
      // v6.0.1: schema 错不计入 watchdog failCount——只是参数名错了，不是真正的执行失败。
      // 避免“模型意图是对的但 key 反复发错”则5次就熔断。
      return `[SCHEMA_INPUT_ERROR] 工具 ${name} 参数不合法：\n - ` + v.issues.join('\n - ') + `\n请按 JSON Schema 修正后重试。\n提示：准字段名是 path / content / old_str / new_str / pattern / command，不要用 file_path / text / body / oldStr 之类。`;
    }
  } catch {}
  // v6: Watchdog 熔断检查
  try {
    const wd = checkWatchdog(session);
    if (wd.stop) return `[WATCHDOG_HALT] ${wd.reason}\n建议：告知用户、调 run_stage_done({passed:false,memo:...}) 后停止本轮。`;
  } catch {}
  switch (name) {
    // ====================== Mdriver: LAMMPS 工具优先分发 ======================
    case 'lmp_env_info':
    case 'lmp_find_example':
    case 'lmp_find_source':
    case 'lmp_find_potential':
    case 'lmp_doc_lookup':
    case 'lmp_clone_example':
    case 'lmp_inspect_case':
    case 'lmp_validate_input':
    case 'lmp_lint':
    case 'lmp_template_search':
    case 'lmp_template_get':
    case 'lmp_run_probe':
    case 'lmp_run_async':
    case 'lmp_run_status':
    case 'lmp_run_stop':
    case 'lmp_run_wait':
    case 'lmp_parse_log':
    case 'lmp_dump_summary':
    case 'lmp_plot_thermo':
    case 'lmp_render_traj':
    case 'lmp_post_msd':
    case 'lmp_post_rdf':
    case 'lmp_dump_convert':
    case 'lmp_post_all':
    case 'lmp_build_data_file':
    case 'lmp_packmol_build':
    case 'lmp_ff_select_reaxff':
    case 'lmp_render_in_template':
    case 'lmp_reaxff_pipeline':
    case 'lmp_diagnose_error': {
      try {
        return await execLammpsTool(name, args, {
          WORKSPACE,
          lammpsBin: SETTINGS.lammpsBin || '',
          lammpsRoot: SETTINGS.lammpsRoot || '',
          // 后处理脚本（plot_thermo / render_traj / post_*）用用户在顶部选的解释器，
          // 而不是盲目猜 PATH 上的 python（Windows/conda 常常猜不到 → "找不到 python 路径"）。
          pythonPath: SETTINGS.pythonPath || '',
          // 训练模式：把当前领域的硬规则下发给 lmp_lint（及内部调用 lint 的 pipeline）强制执行
          domainLintRules: SETTINGS.activeSkill ? (() => { try { return Skills.getLintRules(SETTINGS.activeSkill); } catch { return []; } })() : [],
          pushImage: (p, caption) => { try { ws.send(JSON.stringify({ type: 'image', path: p, caption })); } catch {} },
          // 记录本轮启动的异步 runId —— 训练模式据此在评测前确保跑完；普通模式辅助用。
          onAsyncLaunch: (runId) => { try { const _s = sessions.get(ws); if (_s) _s._lastAsyncRunId = runId; } catch {} },
          // 让 lmp_run_wait 这类阻塞工具能在用户点"停止"时立即返回，不被长等卡住。
          isAborted: () => { try { return !!sessions.get(ws)?.aborted; } catch { return false; } },
          // ====== A) 实时 thermo ticks ======
          pushThermo: (payload) => { try { ws.send(JSON.stringify({ type: 'lammps_thermo', ...payload })); } catch {} },
          // ====== E) 跑完总结卡片 ======
          pushSummary: (payload) => {
            try { ws.send(JSON.stringify({ type: 'lammps_run_summary', ...payload })); } catch {}
            // 训练模式：完整异步 run 跑完 → 记一次（区别于本轮 lint/probe 收尾）
            try {
              if (SETTINGS.activeSkill) {
                const ok = payload && (payload.verdict === 'ok' || payload.exit_code === 0);
                const res = Skills.recordRun(SETTINGS.activeSkill, { active: true, touched: true, ranAsync: true, runCompleted: !!ok, lintPass: true, probeHealthy: !!ok, toolFails: ok ? 0 : 1, rounds: 0, taskText: `完整run ${payload.case_path || ''}` });
                emitSkillLearned(ws, res);
              }
            } catch {}
          },
        });
      } catch (e) { return `[${name}] 失败：${e.message}\n${e.stack || ''}`.slice(0, 4000); }
    }
    case 'list_dir': {
      const dir = safePath(args.path || '.');
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.map(e => e.isDirectory() ? e.name + '/' : e.name).sort().join('\n');
    }
    case 'read_file': {
      const f = safePath(args.path);
      let c = await fs.readFile(f, 'utf8');
      // OpenFOAM 场文件保护：路径形如 0/U、0.5/alpha.water、processor0/0/p、constant/<region>/<field>
      // 或文件头里出现 vol*Field / surface*Field / pointScalarField 等类型 → 自动折叠 internalField 巨数组体
      const relPath = String(args.path || '').replace(/\\/g, '/');
      const looksLikeTimeStepField = /(^|\/)\d+(\.\d+)?\/[A-Za-z][\w.]*$/.test(relPath);
      const headSniff = c.slice(0, 800);
      const looksLikeFoamField = /class\s+(vol|surface|point)\w*Field/.test(headSniff);
      if ((looksLikeTimeStepField || looksLikeFoamField) && c.length > 8192) {
        const { text: collapsed, hits } = collapseFoamFieldBody(c);
        if (hits > 0 && collapsed.length < c.length) {
          c = `[Mdriver 已自动折叠 ${hits} 处 OpenFOAM internalField 数组体（原 ${c.length} B → ${collapsed.length} B）。\n 头部 / dimensions / boundaryField 完整保留；数组体替换为 head/tail 样本 + 计数。\n 若需查看具体场值统计：用 foam_inspect_case 或 run_command('foamDictionary <file> -keyword internalField | head -5')。\n 严禁强行整文件读：场文件正常情况下就是几百万行数字，读了也只是把上下文撑爆。]\n\n` + collapsed;
        }
      }
      const sl = args.start_line, el = args.end_line;
      if (sl || el) {
        const lines = c.split('\n');
        const a = Math.max(1, sl || 1) - 1;
        const b = Math.min(lines.length, el || lines.length);
        const slice = lines.slice(a, b).map((line, i) => `${a + i + 1}\t${line}`).join('\n');
        return `${args.path} (行 ${a+1}-${b}, 共 ${lines.length} 行)\n${slice}`;
      }
      return c.length > 100_000 ? c.slice(0, 100_000) + `\n...[已截断，原文 ${c.length} B，请用 start_line/end_line]` : c;
    }
    case 'write_file': {
      const f = safePath(args.path);
      let oldContent = null; try { oldContent = await fs.readFile(f, 'utf8'); } catch {}
      // V8 招1：写之前 snapshot
      const stepN = gitStep();
      const pre = await gitAutoCommit(`[step ${stepN}] before write_file ${args.path}`);
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, args.content, 'utf8');
      addPendingEdit(session, { id: crypto.randomBytes(4).toString('hex'), path: args.path, action: oldContent === null ? 'create' : 'write', oldContent, newContent: args.content, timestamp: Date.now() });
      broadcastEdits(ws); broadcastTree();
      const post = await gitAutoCommit(`[step ${stepN}] after write_file ${args.path}`);
      return `已写入 ${args.path}（${args.content.length} 字符）\n[V8 git] pre=${pre.sha || '?'}  post=${post.sha || '?'}`;
    }
    case 'edit_file': {
      const f = safePath(args.path);
      const orig = await fs.readFile(f, 'utf8');
      const idx = orig.indexOf(args.old_str);
      if (idx === -1) return `错误：未找到 old_str`;
      if (orig.indexOf(args.old_str, idx + 1) !== -1) return `错误：old_str 匹配多处`;
      const updated = orig.slice(0, idx) + args.new_str + orig.slice(idx + args.old_str.length);
      // V8 招1：写之前 snapshot
      const stepN = gitStep();
      const pre = await gitAutoCommit(`[step ${stepN}] before edit_file ${args.path}`);
      await fs.writeFile(f, updated, 'utf8');
      addPendingEdit(session, { id: crypto.randomBytes(4).toString('hex'), path: args.path, action: 'edit', oldContent: orig, newContent: updated, timestamp: Date.now() });
      broadcastEdits(ws); broadcastTree();
      const post = await gitAutoCommit(`[step ${stepN}] after edit_file ${args.path}`);
      return `已编辑 ${args.path}\n[V8 git] pre=${pre.sha || '?'}  post=${post.sha || '?'}`;
    }
    case 'multi_edit': {
      const f = safePath(args.path);
      const orig = await fs.readFile(f, 'utf8');
      let cur = orig;
      const edits = Array.isArray(args.edits) ? args.edits : [];
      if (edits.length === 0) return '错误：edits 为空';
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        const idx = cur.indexOf(e.old_str);
        if (idx === -1) return `错误：第 ${i+1} 个 edit 未找到 old_str`;
        if (cur.indexOf(e.old_str, idx + 1) !== -1) return `错误：第 ${i+1} 个 edit 匹配多处`;
        cur = cur.slice(0, idx) + e.new_str + cur.slice(idx + e.old_str.length);
      }
      // V8 招1：写之前 snapshot
      const stepN = gitStep();
      const pre = await gitAutoCommit(`[step ${stepN}] before multi_edit ${args.path} (${edits.length} 处)`);
      await fs.writeFile(f, cur, 'utf8');
      addPendingEdit(session, { id: crypto.randomBytes(4).toString('hex'), path: args.path, action: 'edit', oldContent: orig, newContent: cur, timestamp: Date.now() });
      broadcastEdits(ws); broadcastTree();
      const post = await gitAutoCommit(`[step ${stepN}] after multi_edit ${args.path}`);
      return `已应用 ${edits.length} 处编辑到 ${args.path}\n[V8 git] pre=${pre.sha || '?'}  post=${post.sha || '?'}`;
    }
    case 'glob': {
      const root = safePath(args.path || '.');
      const pat = args.pattern || '**/*';
      const re = globToRegExp(pat);
      const out = []; const max = 200;
      async function walkG(dir) {
        if (out.length >= max) return;
        let entries = []; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (out.length >= max) return;
          if (IGNORE.has(e.name)) continue;
          const full = path.join(dir, e.name);
          const rel = path.relative(WORKSPACE, full).replace(/\\/g, '/');
          if (e.isDirectory()) await walkG(full);
          else if (re.test(rel)) out.push(rel);
        }
      }
      await walkG(root);
      return out.length ? out.join('\n') + (out.length === max ? `\n...[已截断@${max}]` : '') : '（无匹配）';
    }
    case 'grep_search': {
      const re = new RegExp(args.pattern, 'gm');
      const root = safePath(args.path || '.');
      const results = [];
      async function walk(dir) {
        if (results.length >= 50) return;
        let entries = []; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (results.length >= 50) return;
          if (IGNORE.has(e.name)) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else if (e.isFile()) {
            try { const c = await fs.readFile(full, 'utf8');
              c.split('\n').forEach((line, i) => { if (results.length >= 50) return; if (re.test(line)) results.push(`${path.relative(WORKSPACE, full)}:${i+1}: ${line.trim().slice(0,200)}`); re.lastIndex = 0; });
            } catch {}
          }
        }
      }
      await walk(root);
      return results.length ? results.join('\n') : '（无匹配）';
    }
    case 'run_command': return await runShell(args.command, args.timeout_ms || 60000, session, ws);
    case 'update_todos': {
      session.todos = (args.items || []).map(it => ({ text: String(it.text || ''), done: !!it.done }));
      broadcastTodos(ws);
      const total = session.todos.length, done = session.todos.filter(t => t.done).length;
      return `已更新待办：${done}/${total} 完成`;
    }
    case 'task_complete': {
      session.taskComplete = true;
      ws.send(JSON.stringify({ type: 'task_complete', summary: args.summary || '' }));
      return `任务标记完成：${args.summary || ''}`;
    }

    // ====================== V8 招1：Git 自动版本 ======================
    case 'git_log_recent': {
      await ensureGitRepo();
      const n = Math.min(Math.max(args.n || 10, 1), 50);
      const r = await _spawnP('git', ['log', `-n`, String(n), '--pretty=format:%h|%ad|%s', '--date=format:%H:%M:%S', '--shortstat'], { cwd: WORKSPACE });
      if (r.code !== 0) return `[git_log_recent] git log 失败：${r.err || r.out}`;
      const out = (r.out || '').trim();
      if (!out) return '[git_log_recent] 仓库无 commit。';
      return `[git_log_recent] 最近 ${n} 个 commit（最新在上）：\n${out}\n\n用法：找到"上一个能跑的 SHA"后调 git_revert_to(sha) 回滚。`;
    }
    case 'git_diff': {
      await ensureGitRepo();
      const from = args.from || 'HEAD~1';
      const to = args.to || 'HEAD';
      const argv = ['diff', '--stat', `${from}..${to}`];
      if (args.path_glob) argv.push('--', args.path_glob);
      const r = await _spawnP('git', argv, { cwd: WORKSPACE });
      if (r.code !== 0) return `[git_diff] 失败：${r.err || r.out}`;
      const stat = (r.out || '').trim() || '(no changes)';
      // 再取完整 diff 头 200 行
      const argv2 = ['diff', `${from}..${to}`];
      if (args.path_glob) argv2.push('--', args.path_glob);
      const r2 = await _spawnP('git', argv2, { cwd: WORKSPACE });
      const body = (r2.out || '').split(/\r?\n/).slice(0, 200).join('\n');
      return `[git_diff ${from}..${to}]\n--- stat ---\n${stat}\n\n--- diff (head 200) ---\n${body}`;
    }
    case 'git_revert_to': {
      if (!args.sha) return '[git_revert_to] sha 必填';
      await ensureGitRepo();
      // 用 `git checkout <sha> -- .` 把工作区文件还原到该 SHA，再 commit 一次新提交（不丢历史）
      const co = await _spawnP('git', ['checkout', args.sha, '--', '.'], { cwd: WORKSPACE });
      if (co.code !== 0) return `[git_revert_to] 还原工作区失败：${co.err || co.out}`;
      const note = args.note ? ` (${args.note})` : '';
      const stepN = gitStep();
      const c = await gitAutoCommit(`[step ${stepN}] revert workspace to ${args.sha}${note}`);
      // 通知前端刷新文件树（因为大量文件被回滚）
      try { broadcastTree(); } catch {}
      return `[git_revert_to] ✅ 工作区已回滚到 ${args.sha}。\n新 commit: ${c.sha}\n${note}\n\n下一步：重新规划（**不要**立刻按"老路"再改一遍，先 case_probe_facts + algo_extract_contract 看为什么会跑偏）。`;
    }

    // ====================== V8 招3：错误诊断 ======================
    case 'diagnose_error': {
      const r = diagnoseErrorText(args.text || '');
      if (!r.matched) return `[diagnose_error] ${r.hint}`;
      const out = [`[diagnose_error] 匹配 ${r.count} 条模式：`];
      for (const h of r.hits) {
        out.push(`\n■ ${h.category}`);
        out.push(`  命中片段: ${h.matched_snippet}`);
        out.push(`  可能原因：`);
        for (const c of h.causes) out.push(`    - ${c}`);
        out.push(`  排查步骤（按顺序）：`);
        h.next_steps.forEach((s, i) => out.push(`    ${i+1}) ${s}`));
      }
      return out.join('\n');
    }

    case 'list_case_library': {
      try {
        const fp = path.join(__dirname, 'cases', 'case_library.json');
        const j = JSON.parse(await fs.readFile(fp, 'utf8'));
        let entries = j.entries || [];
        if (Array.isArray(args.only_ids) && args.only_ids.length) {
          const ids = new Set(args.only_ids);
          entries = entries.filter(e => ids.has(e.id));
        }
        if (args.filter) {
          const q = String(args.filter).toLowerCase();
          entries = entries.filter(e =>
            (e.name||'').toLowerCase().includes(q) ||
            (e.scope||'').toLowerCase().includes(q) ||
            (e.tags||[]).some(t => String(t).toLowerCase().includes(q))
          );
        }
        const lines = [`[list_case_library] ${entries.length} entries (v${j.version})`];
        // 优先列本地已捆绑案例（智能体可直接 read_file/grep_search 0 网络延迟）
        if (Array.isArray(j.local_bundles) && j.local_bundles.length) {
          lines.push(`\n========== 📦 本地已捆绑（直接 read_file / list_dir / grep_search）==========`);
          for (const b of j.local_bundles) {
            lines.push(`\n▪ ${b.id}  ·  ${b.name}  [LOCAL ${b.size_mb||'?'} MB]`);
            lines.push(`  path:    ${b.local_path}`);
            lines.push(`  license: ${b.license}`);
            for (const c of (b.contents||[])) lines.push(`    · ${c}`);
            if (b.usage) lines.push(`  usage:   ${b.usage}`);
          }
          lines.push(`\n========== 🌐 远程索引（需 fetch_url / git clone）==========`);
        }
        for (const e of entries) {
          lines.push(`\n▪ ${e.id}  ·  ${e.name}`);
          if (e.bundled_subset) lines.push(`  bundled: ${e.bundled_subset}`);
          lines.push(`  repo:    ${e.repo}${e.repo_path?'  ('+e.repo_path+')':''}`);
          lines.push(`  license: ${e.license}`);
          lines.push(`  scope:   ${e.scope}`);
          lines.push(`  tags:    ${(e.tags||[]).join(', ')}`);
          if (e.fetch) lines.push(`  fetch:   ${e.fetch.mode} ← ${e.fetch.url}`);
        }
        lines.push(`\n提示：先看本地 cases/lammps-official/ 下的真实输入卡；不够再 fetch_url 远程仓库到 cases/_external/<id>/。`);
        return lines.join('\n');
      } catch (e) {
        return `[list_case_library] error: ${e.message}`;
      }
    }

    // ====================== V8 算法植入四步法 ======================
    case 'sim_open_paraview': {
      try {
        const r = await launchParaView(args.case_path);
        ws.send(JSON.stringify({ type: 'sim_started', pid: r.pid, casePath: args.case_path || '' }));
        return r.reused ? `ParaView 已在运行（PID ${r.pid}），已切换到投影` : `已启动 ParaView（PID ${r.pid}），开始投影窗口`;
      } catch (e) { return `启动失败：${e.message}`; }
    }
    case 'web_search': return await webSearch(args.query, args.top_k || 6, { topic: args.topic, time_range: args.time_range, include_answer: args.include_answer, progress: session?._progressPub });
    case 'image_search': {
      try {
        const imgs = await imageSearch(args.query, Math.min(30, args.top_k || 12));
        // 把图片广播到所有客户端的图片库
        broadcastImages(imgs, args.query);
        if (!imgs.length) return '未找到图片（可能被反爬，可尝试改换关键词或开代理）';
        return `[image_search] "${args.query}" → ${imgs.length} 张图片，已发到右侧"图片库"面板。\n` +
          imgs.slice(0, 8).map((x, i) => `${i+1}. ${x.title || ''}\n   图片: ${x.image}\n   来源: ${x.source || ''}`).join('\n');
      } catch (e) { return '搜图失败：' + e.message; }
    }
    case 'fetch_url': return await fetchUrlText(args.url, args.max_chars || 6000, args.with_images !== false, session?._progressPub);
    case 'read_document': return await readWithVisionFallback('doc', args, session, () => readDocument(args.path, session?._progressPub));
    case 'request_user_digitize': return await requestUserDigitize(args || {}, ws, session);
    case 'read_paper': return await readWithVisionFallback('paper', args, session, () => readPaper(args.path, args.focus || '', session?._progressPub));
    case 'paper_extract_params': return await paperExtractParams(args.path, args.to_units, args.max_pages_vlm || 6, session?._progressPub);
    case 'paper_search': return await paperSearch(args.query, { topK: args.top_k || 8, year: args.year, openAccessOnly: !!args.open_access_only, fieldsOfStudy: args.fields_of_study, progress: session?._progressPub });
    case 'paper_fetch': return await paperFetch(args.id, { download: !!args.download, maxRefs: args.max_refs || 30, progress: session?._progressPub });
    case 'vision_analyze': return await visionAnalyze(args.images || [], args.question || '', args.max_tokens || 1500, session?._progressPub);
    case 'download_file': return await downloadFile(args.url, args.save_as);
    case 'sim_render': {
      try {
        const r = await pvRenderOffscreen({ casePath: args.case_path, azimuth: args.azimuth, elevation: args.elevation, zoom: args.zoom, field: args.field, timeStep: args.time_step });
        pvBroadcast({ type: 'sim_frame', dataUrl: r.dataUrl, meta: r.meta });
        ws.send(JSON.stringify({ type: 'sim_started', pid: 0, casePath: args.case_path }));
        // 落盘一份 PNG 到 .nullflux/renders/，便于后续 vision_analyze / foam_post_verify 引用
        let savedPath = '';
        try {
          const tag = `${path.basename(String(args.case_path || 'case'))}_${args.field || 'default'}_${args.time_step || 'latest'}`.replace(/[^\w\-.]+/g, '_');
          const absPng = await _dataUrlToTmpPng(r.dataUrl, tag);
          savedPath = path.relative(WORKSPACE, absPng).replace(/\\/g, '/');
        } catch {}
        return `已渲染 ${args.case_path}（${r.width}x${r.height}，${r.bytes} bytes）。画面已发到右侧面板。` +
          (savedPath ? `\n📁 已落盘: ${savedPath}` : '') +
          (r.meta ? `\n可用场：${r.meta.fields.join(', ') || '(无)'}\n时间步数：${r.meta.times.length}` : '') +
          `\n\n⚠️ 下一步必须做：调 \`vision_analyze(images=['${savedPath || '<上面那个路径>'}'], question='...')\` 让 VLM 检查这张图——别只凭"渲染成功"就下结论。建议问：① 流场结构是否物理合理（对称/无突变/无 NaN 块）② 量级是否符合预期 ③ 颜色梯度是否平滑 ④ 与论文图（如有）是否定性一致。`;
      } catch (e) { return `渲染失败：${e.message}`; }
    }
    default: return `未知工具：${name}`;
  }
}

async function runShell(command, timeout, session, ws) {
  return await new Promise((resolve) => {
    const shell = IS_WIN ? (process.env.COMSPEC || 'cmd.exe') : 'bash';
    let cmd = command;
    if (SETTINGS.pythonPath) {
      const py = `"${SETTINGS.pythonPath}"`;
      const dir = path.dirname(SETTINGS.pythonPath);
      const pip = IS_WIN ? `"${path.join(dir, 'Scripts', 'pip.exe')}"` : `"${path.join(dir, 'pip')}"`;
      const tokenPy = /(^|\s|&&\s*|\|\|\s*|;\s*|\(\s*)(python(?:3)?(?:\.exe)?|py(?:\s+-3)?)\b/g;
      const tokenPip = /(^|\s|&&\s*|\|\|\s*|;\s*|\(\s*)(pip(?:3)?(?:\.exe)?)\b/g;
      const tokenJp = /(^|\s|&&\s*|\|\|\s*|;\s*|\(\s*)(jupyter(?:\.exe)?)\b/g;
      cmd = cmd.replace(tokenPy, (_,p) => p + py);
      cmd = cmd.replace(tokenPip, (_,p) => p + py + ' -m pip');
      cmd = cmd.replace(tokenJp, (_,p) => p + py + ' -m jupyter');
    }
    const shellArgs = IS_WIN ? ['/c', cmd] : ['-c', cmd];
    ws.send(JSON.stringify({ type: 'term', line: `$ ${cmd}` }));
    const env = { ...process.env };
    if (SETTINGS.pythonPath) {
      const dir = path.dirname(SETTINGS.pythonPath);
      env.PATH = dir + path.delimiter + (env.PATH || env.Path || '');
      env.VIRTUAL_ENV = dir.replace(/[\\/](Scripts|bin)$/i, '');
      env.PYTHONIOENCODING = 'utf-8';
    }
    const child = spawn(shell, shellArgs, { cwd: WORKSPACE, env });
    session.currentProc = child;
    let out = '';

    // —— 如果命令里含 OpenFOAM 求解器/网格工具，自动登记到 SOLVER_RUNS，
    //    让"求解器监测"面板能选到这次 run_command 起的进程
    let foamRun = null;
    try {
      const _foamRegex = /\b(blockMesh|snappyHexMesh|surfaceFeature(?:Extract|s)?|extrudeMesh|topoSet|refineMesh|checkMesh|renumberMesh|decomposePar|reconstructPar(?:Mesh)?|foamToVTK|setFields|mapFields|potentialFoam|simpleFoam|pimpleFoam|pisoFoam|icoFoam|interFoam|interIsoFoam|rhoSimpleFoam|rhoPimpleFoam|sonicFoam|chtMultiRegionFoam|buoyantSimpleFoam|buoyantPimpleFoam|reactingFoam|reactingTwoPhaseEulerFoam|multiphaseEulerFoam|driftFluxFoam|laplacianFoam|scalarTransportFoam|dnsFoam|foamRun)\b/i;
      if (_foamRegex.test(command)) {
        // 从命令里抽 case 路径
        let foamCase = '';
        const mWin = command.match(/\bcd\s+\/d\s+["']?([^"'&|;]+?)["']?(?=\s*(?:&&|;|\|\||$))/i);
        const mNix = command.match(/\bcd\s+["']?([^"'&|;]+?)["']?(?=\s*(?:&&|;|\|\||$))/i);
        foamCase = (mWin && mWin[1]) || (mNix && mNix[1]) || WORKSPACE;
        foamCase = foamCase.trim();
        const runId = crypto.randomBytes(4).toString('hex');
        foamRun = {
          runId, proc: child, casePath: foamCase, command, log: [],
          started: Date.now(), ended: 0, exitCode: null, subs: new Set()
        };
        // 单行截断保护
        const _MAX = 2000;
        const _push = foamRun.log.push.bind(foamRun.log);
        foamRun.log.push = function(line) { return _push(line.length > _MAX ? line.slice(0, _MAX) + ' …[行过长截断]' : line); };
        SOLVER_RUNS.set(runId, foamRun);
        // 广播运行列表变更，让前端"求解器监测"面板自动刷新下拉
        try {
          const msg = JSON.stringify({ type: 'runs_update', reason: 'run_command_detected', runId });
          for (const c of allClients) if (c.readyState === 1) c.send(msg);
        } catch {}
        // 立即提示用户：哪个 runId 可以监测
        try { ws.send(JSON.stringify({ type: 'term', line: `[Mdriver] 检测到 OpenFOAM 命令 → 已登记 runId=${runId}（监测面板可选）  case=${foamCase}` })); } catch {}
      }
    } catch {}

    const onData = d => {
      const s = d.toString();
      out += s;
      const lines = s.split(/\r?\n/);
      lines.forEach(l => l && ws.send(JSON.stringify({ type: 'term', line: l })));
      // 同步落到 SOLVER_RUNS
      if (foamRun) {
        lines.forEach(l => { if (l) foamRun.log.push(l); });
        if (foamRun.log.length > 4000) foamRun.log.splice(0, foamRun.log.length - 4000);
        for (const sub of foamRun.subs) if (sub.readyState === 1) {
          sub.send(JSON.stringify({ type: 'solver_log', runId: foamRun.runId, lines: lines.filter(Boolean) }));
        }
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    const t = setTimeout(() => { try { child.kill(); } catch {}; ws.send(JSON.stringify({ type: 'term', line: '[超时已终止]' })); }, timeout);
    child.on('close', code => { clearTimeout(t); session.currentProc = null;
      ws.send(JSON.stringify({ type: 'term', line: `[退出码 ${code}]` })); broadcastTree();
      if (foamRun) {
        foamRun.ended = Date.now(); foamRun.exitCode = code;
        for (const sub of foamRun.subs) if (sub.readyState === 1) sub.send(JSON.stringify({ type: 'solver_done', runId: foamRun.runId, exitCode: code }));
        try {
          const msg = JSON.stringify({ type: 'runs_update', reason: 'run_command_ended', runId: foamRun.runId });
          for (const c of allClients) if (c.readyState === 1) c.send(msg);
        } catch {}
      }
      resolve(`[退出码 ${code}]\n${out.slice(0, 50000)}`); });
    child.on('error', err => { clearTimeout(t); session.currentProc = null; resolve(`[启动失败] ${err.message}`); });
  });
}

async function undoEdit(session, editId) {
  const idx = session.pendingEdits.findIndex(e => e.id === editId);
  if (idx === -1) throw new Error('编辑记录不存在');
  const edit = session.pendingEdits[idx];
  const f = safePath(edit.path);
  if (edit.oldContent === null) { try { await fs.unlink(f); } catch {} } else await fs.writeFile(f, edit.oldContent, 'utf8');
  session.pendingEdits.splice(idx, 1); return edit;
}
function keepEdit(session, editId) { const idx = session.pendingEdits.findIndex(e => e.id === editId); if (idx === -1) throw new Error('编辑记录不存在'); return session.pendingEdits.splice(idx, 1)[0]; }
function newCheckpoint(session, label) { const cp = { id: crypto.randomBytes(4).toString('hex'), label: label || '新任务', timestamp: Date.now(), files: {} }; session.checkpoints.push(cp); session.currentCheckpoint = cp; return cp; }
async function restoreCheckpoint(session, id) {
  const idx = session.checkpoints.findIndex(c => c.id === id);
  if (idx === -1) throw new Error('检查点不存在');
  const earliest = {};
  for (let i = idx; i < session.checkpoints.length; i++)
    for (const [p, oc] of Object.entries(session.checkpoints[i].files)) if (!(p in earliest)) earliest[p] = oc;
  let restored = 0;
  for (const [rel, oc] of Object.entries(earliest)) {
    const f = safePath(rel);
    if (oc === null) { try { await fs.unlink(f); } catch {} }
    else { await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, oc, 'utf8'); }
    restored++;
  }
  session.checkpoints.splice(idx); session.currentCheckpoint = null;
  session.pendingEdits = session.pendingEdits.filter(e => !(e.path in earliest));
  return restored;
}

async function buildTree(dir = WORKSPACE, depth = 0) {
  const name = path.basename(dir); const children = [];
  if (depth <= 6) {
    let entries = []; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return { name, path: '.', type: 'dir', children }; }
    entries.sort((a, b) => (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (IGNORE.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) children.push(await buildTree(full, depth + 1));
      else children.push({ name: e.name, path: path.relative(WORKSPACE, full).replaceAll('\\', '/'), type: 'file' });
    }
  }
  return { name, path: path.relative(WORKSPACE, dir).replaceAll('\\', '/') || '.', type: 'dir', children };
}

const allClients = new Set();
const sessions = new Map();
let treeBT = null;
function broadcastTree() {
  if (treeBT) return;
  treeBT = setTimeout(async () => { treeBT = null;
    try { const tree = await buildTree(); const msg = JSON.stringify({ type: 'tree', tree });
      for (const ws of allClients) if (ws.readyState === 1) ws.send(msg); } catch {}
  }, 200);
}

async function flatList() {
  const out = [];
  async function walk(dir) {
    let entries = []; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORE.has(e.name) || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(path.relative(WORKSPACE, full).replaceAll('\\', '/'));
      if (out.length > 2000) return;
    }
  }
  await walk(WORKSPACE); return out;
}

async function buildUserContent(text, attachments) {
  let textPart = text || '';
  // 附件上限：防止把大 PDF / 二进制文件当 utf8 塞进 prompt导致 LLM 400 token 超限
  const ATT_MAX_CHARS = parseInt(process.env.ATT_MAX_CHARS || '80000', 10);
  const BIN_EXT = new Set(['pdf','docx','pptx','xlsx','doc','ppt','xls','png','jpg','jpeg','gif','webp','bmp','tiff','tif','zip','tar','gz','7z','exe','dll','so','bin','stl','vtu','vtk','mp3','mp4','wav','avi','mov']);
  for (const a of (attachments || [])) {
    if (a.type === 'context_file' && a.path) {
      try {
        const abs = safePath(a.path);
        const st = await fs.stat(abs);
        const ext = (path.extname(a.path) || '').slice(1).toLowerCase();
        // 按扩展名直接判定为二进制类附件 → 不读文本，让 agent 自己调 read_document
        if (BIN_EXT.has(ext)) {
          textPart += `\n\n--- 附件 ${a.path} (.${ext} · ${st.size} 字节) 为二进制文档；请调用 read_document("${a.path}") 提取文本与图片 ---`;
          continue;
        }
        if (st.size > 8 * 1024 * 1024) {
          textPart += `\n\n--- 附件 ${a.path} 过大（${(st.size/1024/1024).toFixed(1)} MB）已跳过；请调 read_document("${a.path}") 提取文本 ---`;
          continue;
        }
        // 二进制探测：前 4KB 调 NUL
        const fh = await fs.open(abs, 'r'); const buf = Buffer.alloc(Math.min(4096, st.size));
        await fh.read(buf, 0, buf.length, 0); await fh.close();
        let nul = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 0) { nul++; if (nul > 2) break; }
        if (nul > 2) {
          textPart += `\n\n--- 附件 ${a.path} 为二进制/PDF（${st.size} 字节），不能当文本读；请调 read_document("${a.path}") ---`;
          continue;
        }
        let c = await fs.readFile(abs, 'utf8');
        let banner = '';
        if (c.length > ATT_MAX_CHARS) {
          banner = `\n... [附件共 ${c.length} 字符，仅截取前 ${ATT_MAX_CHARS}；需全文调 read_file/read_document] ...`;
          c = c.slice(0, ATT_MAX_CHARS);
        }
        textPart += `\n\n--- 附件文件 ${a.path} (${st.size} 字节) ---\n${c}${banner}\n--- 文件结束 ---`;
      } catch (e) {
        textPart += `\n\n[附件 ${a.path} 读取失败：${e.message}]`;
      }
    }
  }
  const imgs = (attachments || []).filter(a => a.type === 'image');
  if (imgs.length === 0) return textPart;
  const content = [{ type: 'text', text: textPart }];
  for (const im of imgs) content.push({ type: 'image_url', image_url: { url: im.dataUrl, detail: 'high' } });
  return content;
}

async function callLLM(messages, ws, abortSignal, toolsForCall) {
  if (SETTINGS.provider === 'copilot') return callCopilot(messages, ws, abortSignal, toolsForCall);
  if (!SETTINGS.apiKey) throw new Error('未配置 API Key，请到设置中填入');
  const TOOLS_FOR_CALL = toolsForCall || TOOLS;
  const url = `${SETTINGS.baseUrl.replace(/\/$/,'')}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SETTINGS.apiKey}` };
  const body = JSON.stringify({ model: SETTINGS.model, messages, tools: TOOLS_FOR_CALL, tool_choice: 'auto', stream: true, stream_options: { include_usage: true }, temperature: 0.2 });
  // v0.8.0 连接超时 + 一次重试（首 token 超时由 consumeOpenAIStream 的 IDLE 看门狗保障）
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let connectTimer = null;
    const connectCtrl = new AbortController();
    connectTimer = setTimeout(() => { try { connectCtrl.abort(new Error('connect_timeout_180s')); } catch {} }, 180_000);
    const signal = _combineSignals(abortSignal, connectCtrl.signal);
    try {
      const resp = await fetch(url, { method: 'POST', headers, body, signal });
      clearTimeout(connectTimer);
      if (!resp.ok) {
        const txt = await resp.text();
        const hint = resp.status === 404 ? '（模型名不存在？请到 ⚙ 设置中改成 deepseek-ai/DeepSeek-V3 等有效模型）' : '';
        // 4xx 不重试（业务错）；5xx 重试一次
        if (resp.status >= 400 && resp.status < 500) {
          throw new Error(`API ${resp.status} ${hint}: ${txt.slice(0, 400)}`);
        }
        lastErr = new Error(`API ${resp.status}: ${txt.slice(0, 400)}`);
        if (attempt === 1) {
          try { ws.send(JSON.stringify({ type: 'term', line: `[LLM 5xx 重试 ${attempt}/1] ${resp.status}` })); } catch {}
          continue;
        }
        throw lastErr;
      }
      return await consumeOpenAIStream(resp, ws);
    } catch (e) {
      clearTimeout(connectTimer);
      // 用户主动 abort 不重试
      if (abortSignal && abortSignal.aborted) throw e;
      const msg = String(e && e.message || e);
      const isRetryable = /timeout|aborted|ECONN|ENET|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network|TimeoutError/i.test(msg) || (e && e.name === 'AbortError' && connectCtrl.signal.aborted);
      lastErr = e;
      if (attempt === 1 && isRetryable) {
        try { ws.send(JSON.stringify({ type: 'term', line: `[LLM 网络异常重试 ${attempt}/1] ${msg.slice(0, 200)}` })); } catch {}
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('callLLM exhausted retries');
}

// v0.8.0 合并多个 AbortSignal：任一触发则 abort
function _combineSignals(...signals) {
  signals = signals.filter(Boolean);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    try { return AbortSignal.any(signals); } catch {}
  }
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { try { ctrl.abort(s.reason); } catch { ctrl.abort(); } break; }
    s.addEventListener('abort', () => { try { ctrl.abort(s.reason); } catch { ctrl.abort(); } }, { once: true });
  }
  return ctrl.signal;
}

async function consumeOpenAIStream(resp, ws) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assistantMsg = { role: 'assistant', content: '', tool_calls: [] };
  let usage = null;
  // 流空闲看门狗：超过 IDLE_MS 没收到任何 chunk 就主动断开，避免 LLM/代理静默卡住把整个 agent 卡死
  // 注：读完图/PDF 转录后上下文可能很大，主模型首 token 会较慢；给 120s 兜底（前端 40s 已可手动恢复）
  const IDLE_MS = parseInt(process.env.LLM_IDLE_MS || '120000', 10);
  let idleTimer = null;
  let idleAborted = false;
  function armIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleAborted = true;
      try { reader.cancel('idle-timeout'); } catch {}
    }, IDLE_MS);
  }
  armIdle();
  // 阶段心跳：在首个 token 到达前每 2s 向前端推一次 phase ，之后转入 streaming
  let firstChunk = true;
  let waitStart = Date.now();
  let phaseTimer = setInterval(() => {
    if (firstChunk) {
      const sec = ((Date.now() - waitStart) / 1000).toFixed(1);
      try { ws.send(JSON.stringify({ type: 'agent_phase', phase: 'llm_thinking', detail: `等 LLM 首个 token ${sec}s`, elapsed_ms: Date.now() - waitStart })); } catch {}
    }
  }, 2000);
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim(); if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          if (j.usage) usage = j.usage;
          const delta = j.choices?.[0]?.delta; if (!delta) continue;
          if (delta.content) { assistantMsg.content += delta.content; if (firstChunk) { firstChunk = false; try { ws.send(JSON.stringify({ type: 'agent_phase', phase: 'streaming', detail: 'LLM 输出中' })); } catch {} } ws.send(JSON.stringify({ type: 'delta', text: delta.content })); }
          if (delta.tool_calls) {
            if (firstChunk) { firstChunk = false; try { ws.send(JSON.stringify({ type: 'agent_phase', phase: 'streaming', detail: 'LLM 决定调用工具' })); } catch {} }
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!assistantMsg.tool_calls[idx]) assistantMsg.tool_calls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
              const slot = assistantMsg.tool_calls[idx];
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.function.name += tc.function.name;
              if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
            }
          }
        } catch {}
      }
    }
    // 处理流结束后残留的最后一段（部分上游不会以 \n 结尾），避免漏掉最后一个 tool_call/usage
    if (buffer && buffer.startsWith('data:')) {
      const data = buffer.slice(5).trim();
      if (data && data !== '[DONE]') {
        try {
          const j = JSON.parse(data);
          if (j.usage) usage = j.usage;
          const delta = j.choices?.[0]?.delta;
          if (delta) {
            if (delta.content) { assistantMsg.content += delta.content; if (firstChunk) { firstChunk = false; try { ws.send(JSON.stringify({ type: 'agent_phase', phase: 'streaming', detail: 'LLM 输出中' })); } catch {} } ws.send(JSON.stringify({ type: 'delta', text: delta.content })); }
            if (delta.tool_calls) {
              if (firstChunk) { firstChunk = false; try { ws.send(JSON.stringify({ type: 'agent_phase', phase: 'streaming', detail: 'LLM 决定调用工具' })); } catch {} }
              for (const tc of delta.tool_calls) {
                const idx = tc.index;
                if (!assistantMsg.tool_calls[idx]) assistantMsg.tool_calls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
                const slot = assistantMsg.tool_calls[idx];
                if (tc.id) slot.id = tc.id;
                if (tc.function?.name) slot.function.name += tc.function.name;
                if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
              }
            }
          }
        } catch {}
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (phaseTimer) clearInterval(phaseTimer);
  }
  if (idleAborted) throw new Error(`LLM 流空闲超时 ${IDLE_MS/1000}s（已自动中止，可重试）`);
  if (assistantMsg.tool_calls.length === 0) delete assistantMsg.tool_calls;
  if (usage) ws.send(JSON.stringify({ type: 'usage', usage }));
  return assistantMsg;
}

// ============ GitHub Copilot Provider ============
const COPILOT = {
  clientId: 'Iv1.b507a08c87ecfe98',         // VSCode 的 GitHub OAuth client_id
  ghToken: '',                               // gho_... (long-lived OAuth)
  apiToken: '',                              // 短期 Copilot token
  apiTokenExpires: 0,                        // unix seconds
  modelsCache: null, modelsCacheTs: 0,
};
const COPILOT_FILE = path.join(__dirname, 'copilot.json');

async function loadCopilotState() {
  try {
    const j = JSON.parse(await fs.readFile(COPILOT_FILE, 'utf8'));
    COPILOT.ghToken = j.ghToken || '';
  } catch {}
}
async function saveCopilotState() {
  await fs.writeFile(COPILOT_FILE, JSON.stringify({ ghToken: COPILOT.ghToken }, null, 2), 'utf8');
}

async function copilotDeviceStart() {
  const r = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'GithubCopilot/1.155.0' },
    body: JSON.stringify({ client_id: COPILOT.clientId, scope: 'read:user' })
  });
  if (!r.ok) throw new Error('GitHub device 接口失败：' + r.status);
  return await r.json();    // {device_code, user_code, verification_uri, interval, expires_in}
}
async function copilotDevicePoll(deviceCode) {
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'GithubCopilot/1.155.0' },
        body: JSON.stringify({ client_id: COPILOT.clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
      });
      return await r.json();
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 800 * (i + 1))); }
  }
  throw lastErr;
}
async function copilotRefreshApiToken() {
  if (!COPILOT.ghToken) throw new Error('未登录 GitHub Copilot，请先点 🔑 登录');
  const now = Math.floor(Date.now() / 1000);
  if (COPILOT.apiToken && COPILOT.apiTokenExpires - now > 120) return COPILOT.apiToken;
  const r = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: { 'Authorization': `token ${COPILOT.ghToken}`, 'Accept': 'application/json', 'User-Agent': 'GithubCopilot/1.155.0', 'Editor-Version': 'vscode/1.95.0', 'Editor-Plugin-Version': 'copilot-chat/0.20.0' }
  });
  if (!r.ok) {
    const t = await r.text();
    if (r.status === 401 || r.status === 403) { COPILOT.ghToken = ''; await saveCopilotState(); throw new Error('GitHub 凭据失效，请重新登录：' + t.slice(0, 200)); }
    throw new Error('Copilot token 失败 ' + r.status + ': ' + t.slice(0, 200));
  }
  const j = await r.json();
  COPILOT.apiToken = j.token; COPILOT.apiTokenExpires = j.expires_at || (now + 1500);
  return COPILOT.apiToken;
}
function copilotHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Editor-Version': 'vscode/1.95.0',
    'Editor-Plugin-Version': 'copilot-chat/0.20.0',
    'Copilot-Integration-Id': 'vscode-chat',
    'User-Agent': 'GitHubCopilotChat/0.20.0',
    'Openai-Intent': 'conversation-panel',
    'X-Github-Api-Version': '2025-04-01'
  };
}
async function copilotListModels() {
  const now = Date.now();
  if (COPILOT.modelsCache && now - COPILOT.modelsCacheTs < 5 * 60 * 1000) return COPILOT.modelsCache;
  const tok = await copilotRefreshApiToken();
  const r = await fetch('https://api.githubcopilot.com/models', { headers: copilotHeaders(tok) });
  if (!r.ok) throw new Error('列出模型失败 ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  // 兼容多种返回结构：{data:[]} 或直接 []
  const raw = Array.isArray(j) ? j : (j.data || j.models || []);
  // 只保留 chat 类（排除 embedding）；如果 capabilities 缺失则一律保留
  const list = raw.filter(m => {
    const t = m?.capabilities?.type;
    return !t || t === 'chat' || t === 'completion';
  }).map(m => ({
    id: m.id,
    name: m.name || m.id,
    vendor: m.vendor || (m.id || '').split('-')[0] || '',
    tool: !!(m?.capabilities?.supports?.tool_calls),
    streaming: !!(m?.capabilities?.supports?.streaming),
    picker: m.model_picker_enabled !== false,
  }));
  COPILOT.modelsCache = list; COPILOT.modelsCacheTs = now;
  return list;
}
async function callCopilot(messages, ws, abortSignal, toolsForCall) {
  const tok = await copilotRefreshApiToken();
  const TOOLS_FOR_CALL = toolsForCall || TOOLS;
  const body = { model: SETTINGS.copilotModel || 'gpt-4.1', messages, stream: true, stream_options: { include_usage: true }, temperature: 0.2 };
  // 非所有 Copilot 模型都支持 tools；先尝试带，失败时去掉重试
  body.tools = TOOLS_FOR_CALL; body.tool_choice = 'auto';
  let resp = await fetch('https://api.githubcopilot.com/chat/completions', { method: 'POST', headers: copilotHeaders(tok), body: JSON.stringify(body), signal: abortSignal });
  if (!resp.ok) {
    const txt = await resp.text();
    if (resp.status === 400 && /tool|function/i.test(txt)) {
      delete body.tools; delete body.tool_choice;
      resp = await fetch('https://api.githubcopilot.com/chat/completions', { method: 'POST', headers: copilotHeaders(tok), body: JSON.stringify(body), signal: abortSignal });
      if (!resp.ok) throw new Error('Copilot ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
      ws.send(JSON.stringify({ type: 'term', line: `[Copilot] 模型 ${body.model} 不支持 tools，已降级为纯对话` }));
    } else if (resp.status === 401) {
      COPILOT.apiToken = ''; throw new Error('Copilot 401：' + txt.slice(0, 200));
    } else {
      throw new Error('Copilot ' + resp.status + ': ' + txt.slice(0, 300));
    }
  }
  return await consumeOpenAIStream(resp, ws);
}



const SYSTEM_PROMPT_BASE = (ws) => `你是 MDriver — 本机 LAMMPS / 分子动力学仿真助手（${process.platform}）。
工作目录：${ws}
Python：${SETTINGS.pythonPath || '（未配置）'}

# 风格（强制）
- 简洁中文、编号清单。不复述用户、不解释流程。
- 每轮 ≤ 5 行；调工具时只说 1 句"做什么"，结果让工具说话。
- 看图必须 vision_analyze。公式 KaTeX：\`$...$\` / \`$$...$$\`。

# 工作流（按需）
- 大任务才用 update_todos（≤ 8 项）；结束调 task_complete。
- 改文件先 1 句意图，再 edit_file。缺依赖 run_command \`pip install ...\`。

# 联网/读文
web_search · paper_search · paper_fetch · fetch_url · read_paper · paper_extract_params · vision_analyze · image_search
`;

const LAMMPS_PROMPT = `

# LAMMPS 模式
- 可执行：${SETTINGS.lammpsBin || 'lmp'}　根目录：${SETTINGS.lammpsRoot || '未设置（可仍走背板查例/查源码）'}
- 反幻觉背板（按需查，本地、0 延迟）：
  · \`cases/lammps-official/examples/\` 90+ 算例
  · \`cases/lammps-official/potentials/\` 260+ 力场
  · \`cases/lammps-official/src/\` 核心源码
  · \`cases/lammps-official/doc/src/\` 1000+ rst

# 两种合法构型风格 — 根据题目自己挑，不要混
**A. 自包含小脚本（教学/简单流-壁/晶体熔化/界面）**
   in.* 里 \`lattice + region + create_atoms\` 一气呵成。**不需要 data 文件、不需要 packmol、不需要 clone_example**。
   路径：① \`lmp_template_search\` 找最近模板（**强烈推荐**） → \`lmp_template_get\` 取全文 ② 心里过一遍物理量是否要换算（要换才调 \`lmp_unit_convert\`） ③ \`write_file\` 写 in.* ④ \`lmp_lint\`（**必跑**）→ ⑤ \`lmp_run_probe\` ⑥ \`lmp_run_async\`。

**B. 复杂体系（聚合物/蛋白/混合物/ReaxFF 热解/MOF 等需要预构型的）**
   ① \`paper_extract_params\`（若有论文） ② \`lmp_find_example\` → \`lmp_clone_example\` → 只改差异 ③ 或 \`lmp_packmol_build\` 生成 data.* ④ \`lmp_lint\` → \`lmp_run_probe\` → \`lmp_run_async\`。

判断：题目里出现"流-壁 / Couette / Poiseuille / 简单 LJ / FCC 块体 / 单组分熔化" → 走 A；出现"聚合物链 / 蛋白 / 混合密度装箱 / 热解" → 走 B。**不要默认 B**。

# ⚡ 何时必须用 ReaxFF（反应力场）—— 别再用普通 pair_style 糊弄化学反应
**触发词（命中任意一个就该上 ReaxFF 工具链，而不是 LJ/EAM/Tersoff）**：热解 / pyrolysis / 燃烧 / combustion / 氧化 / 裂解 / 成键断键 / bond breaking / 化学反应 / 自由基 / 含能材料 / 推进剂 / 焦炭 / char / 聚合反应 / 碳化。
- 这类体系**普通力场（LJ/EAM/Tersoff/AIREBO）算不出键的生成与断裂**，必须 ReaxFF。判错力场 = 结果整篇作废。
- ReaxFF 专用工具链（已默认启用，直接调）：
  1. \`lmp_ff_select_reaxff\` elements=[...] → 从 \`forcefields/reaxff_catalog.json\` 选覆盖目标元素的 ffield 文件（**别瞎填 ffield.reax**）。
  2. \`lmp_packmol_build\` → 把分子按数量/密度装进盒子生成 data.*（需要 packmol；缺则报清楚怎么装）。
  3. \`lmp_render_in_template\` → 用内置 ReaxFF 模板渲染 in.*（自动含 \`pair_style reaxff\` + \`fix qeq/reaxff\` + 可选 \`reaxff/bonds\` 键级输出）。
  4. \`lmp_reaxff_pipeline\` → 一把梭：装盒 → 选力场 → 渲染 → 探针。**首选这个**，省得手搓。
- **强烈建议直接调 \`lmp_reaxff_pipeline\` 这一个工具，而不是手动分步**：它内部把"选真实力场→拷贝 ffield→渲染→lint→200 步探针"按固定顺序跑完，且有代码级硬门（力场不覆盖元素直接停、lint 不过不往下、timestep>0.25 自动夹住）。你的活只剩**抽参数**（molecules/box/elements/温度/步数），顺序和校验交给流水线——这比逐步调可靠一个量级。只有体系特殊到模板套不上时才手动分步。
- ReaxFF 硬性纪律：\`atom_style charge\`（带电荷列）、**必须** \`fix qeq/reaxff\` 或 \`fix acks2/reaxff\` 做电荷平衡（lint 规则 L12 会拦）、**timestep ≤ 0.25 fs**、键级分析加 \`dump ... reaxff/bonds\`。
- 渲染/装盒完照样走五段式：\`lmp_lint\` → \`lmp_run_probe 200\` → \`2000\` → \`lmp_run_async\`。

# 写完 in.* 跑长 run 前的「**模板 → lint → 探针 → 短跑 → 长跑**」五段式（**强烈推荐，能少调 5-10 轮**）
跑 100k 步出错再回头改 = 浪费 5 分钟。改成下面这套：
0. **\`lmp_template_search\` query="<体系关键字>"**（**最先来这个**，0 成本）：从 MDriver 自带 5 模板里挑最近的 → \`lmp_template_get\` 取全文 → 只改差异行（晶格常数、势函数、温度、box）。**抄模板的翻车率比凭空写低一个数量级**。若题目太特殊一个模板都不沾边再凭空写。
1. **\`lmp_lint\`**（**写完必跑、毫秒级**）：纯静态检查 12 类常见翻车 — units/atom_style/pair_style 三者一致 / pair_coeff 元素列对齐 / 势文件存在 / ReaxFF 缺 qeq / boundary 缺失 / timestep 缺失 等。返回 {ok, errors:[{rule,line,msg,fix}]}。**ok=false 必须按 fix 字段改完再 lmp_lint 复查，通过后才能往下走**。
2. **\`lmp_run_probe\` probe_steps=200**：内部把 run N 改成 run 200 同步跑 ≤ 60s，返回 thermo 序列 + verdict（healthy/lost-atoms/temp-nan/energy-spike/timeout/crashed）+ suggested_next。**比 validate_input(run 0) 强 10×**，能抓动力学问题（原子飞掉 / NaN / 能量爆涨）。
3. 若 verdict ≠ healthy → 调 \`lmp_diagnose_error\` 拿修法 → 改 in.* → 回 step 1（lint 再过一遍）。
4. healthy → **\`lmp_run_probe\` probe_steps=2000** 再确认稳态。
5. 仍 healthy → **\`lmp_run_async\` 跑完整步数** 提交 → **紧接着 \`lmp_run_wait\` 阻塞等它跑完** → 拿到最终 verdict + thermo → 报告/后处理。前端同时有实时 thermo 曲线 + 结束总结卡。

# 把问题「**一次跑到完整结束**」——这是默认目标（最高优先级纪律）
用户要的是**结果**，不是"已提交"。提交完就撒手、或者反复换方案，都等于没跑完。标准动作只有一套：
- ✅ **提交 → 等待 → 报告**：① probe healthy 后 \`lmp_run_async\` **提交一次** → ② **立刻 \`lmp_run_wait(run_id, timeout_sec)\` 阻塞等它真正跑完**（一个工具调用里把活干完，期间前端有实时 thermo）→ ③ 等到 \`verdict=ok\` → 做后处理（\`lmp_plot_thermo\`/\`lmp_post_*\`/\`lmp_render_traj\`）并向用户汇报**最终结果**，这才算"完整结束"。
- ⏳ **没等到也别慌**：\`lmp_run_wait\` 返回 \`still-running\` 只表示大体系还没跑完（正常现象）→ **再调一次 \`lmp_run_wait\` 续等**（可加大 timeout_sec），或交给结束总结卡。**绝不可**因为"还在跑/跑得久"就改 in.*、换力场、换 timestep、换构型、重启 run、或另开一个 run "试试别的"。
- ❌ **死循环反模式（严禁，你最容易犯）**：提交 → 秒级 \`lmp_run_status\` → 看到「还在跑」→ 没耐心 → 推倒重来 / 换方案。每一次重启都让你离结果更远，且你永远等不到任何一次跑完。
- **何时才允许动手**：只有 \`lmp_run_wait\`/\`lmp_run_status\` 明确返回 \`verdict=crashed\` 或 \`status=error\`，或总结卡 \`verdict=crashed/lost-atoms/nan\` 时，才去 \`lmp_diagnose_error\` → 改 in.* → 重跑。**"跑得久 / step 在涨但没跑完"绝不是动手的理由。**
- 只有当用户**明确说**"超长跑/后台跑/不用等"时，才用"提交后撒手、靠总结卡"模式；否则一律 \`lmp_run_wait\` 等到底。

# 并行计算 (MPI)
- \`lmp_run_probe\` 和 \`lmp_run_async\` 都接受 **\`np\`** 参数，默认 1（串行）。设 np=4 自动拼成 \`mpiexec -np 4 -localonly lmp ...\`（Windows，跳过 smpd 认证）或 \`mpirun -np 4 lmp ...\`（Linux/macOS）。
- 前提：① 系统装了 MS-MPI（Windows）/ MPICH / OpenMPI ② LAMMPS 用 MPI 版编译（\`lmp_mpi\` 而不是 \`lmp_serial\`）。设置面板里把 LAMMPS_BIN 指向 MPI 版。
- 经验：metal/EAM 8k 原子 → np=4 大约 3-4× 加速；ReaxFF 即使 1k 原子 np=4 也明显快。**别瞎开 np > 物理核数**。
- 串行 LAMMPS 也支持把 \`OMP_NUM_THREADS=4\` 设进环境（package omp 4），但要 in.* 配合，**不如直接 MPI 干脆**。

# 后处理：跑完调一个工具看完一切
- **首选 \`lmp_post_all\`**：一键扫描当前文件夹的 log.* / dump.* / *.lammpstrj / *.out，自动调 parse_log + dump_summary + plot_thermo + render_traj 出一份完整报告。**不知道有什么数据就先调它**。
- **看初始构型**：跑之前 / 还没 dump 时，直接 \`lmp_render_traj dump_file="data.lammps"\`（传 data 文件即渲染初始几何），用户"看不到初始状态"用这个。
- 单项工具（按需调）：
  · \`lmp_parse_log\`：log → 结构化 thermo 表 + ns/day + 收敛状态
  · \`lmp_dump_summary\`：dump 文件原子数/帧数/box/字段（**看不到轨迹时第一个查这个**）
  · \`lmp_plot_thermo y=["Temp","PotEng"]\`：thermo 时间序列图
  · \`lmp_render_traj frame=-1\`：OVITO / matplotlib 渲染最末帧 PNG；\`frame=0\` 看初始、\`dump_file=data.*\` 看建模初始构型
  · \`lmp_post_msd dump_file=... dt_ps=...\`：MSD + 扩散系数 D (m²/s)，dump 需 xu yu zu 或 x y z ix iy iz 列
  · \`lmp_post_rdf dump_file=...\`：径向分布函数 g(r)（≤ 10k 原子可用，含 PBC 最小镜像）
  · \`lmp_dump_convert dump_file=...\`：lammpstrj → xyz，给 NGL / VMD / OVITO 直接看
- **看热解 / 成链 / 分子团簇**（ReaxFF）：in.* 里要 \`fix ... reaxff/species\` 和 \`fix ... reaxff/bonds\`（lmp_render_in_template 默认带 output_reaxff 段就有）。跑完 \`species.out\` 直接列出每帧的分子式与数目（看裂解产物/成链最直接）；\`bonds.reaxff\` 给键级。**装了 OVITO 时** \`lmp_render_traj color_by=type\` 可视化构型；要按分子团簇上色需在 OVITO 里做 cluster analysis（无 OVITO 时 matplotlib 只能按 type 散点）。
- **dump 配置建议**：写 in.* 时用 \`dump 1 all custom 1000 dump.x id type xu yu zu vx vy vz\`，**带 xu yu zu**（unwrapped），这样 MSD/扩散系数无需后续推算。
- **Python 解释器**：后处理脚本用你在顶部选中的解释器（已自动下发），**无须自己猜 python 路径**；若报 "render/plot failed" 多半是该解释器缺 matplotlib/numpy → 提示用户 pip install。

辅助验证：
- **\`lmp_dump_summary\`** 看 dump 文件真实原子数 / box 尺寸（"上壁面 0 原子"在这步暴露）
- **\`lmp_render_traj\` frame=0** 第 0 帧渲染眼瞅几何

\`lmp_validate_input\` 仍可用，但只查语法（run 0），**短跑能力被 lmp_run_probe 替代**。

# LAMMPS 翻车清单（**每次写 in.\\* 前先想一遍**）
**A) Lost atoms / Out of range（占失败 50%+）**
- 初始重叠：两层晶格 z 间隙 < a → 势能瞬间爆 → 原子飞掉。**对策：建完几何先 \`minimize 0 1e-8 1000 10000\` 再 run**。
- timestep 过大：LJ ≈ 0.005；real (有机) 0.5-1 fs；**ReaxFF ≤ 0.25 fs**；metal 1-2 fs。
- 非周期 \`f f f\` 边界没 \`fix wall/reflect\` → 流出 box 算 lost。**流-壁：boundary p p f + 顶底 fix wall**。
- 没 \`velocity all create T seed mom yes rot yes\` → 整体漂移飞光。

**B) FCC 上下壁面/槽道的 origin 坑（"上壁面 0 原子" 通常就是这个）**
- \`lattice fcc a\` 默认 \`origin 0 0 0\`，FCC 单胞 4 原子在 (0,0,0)(½,½,0)(½,0,½)(0,½,½)。
- 上壁 \`region top block 0 Lx 0 Ly Lz-a Lz\` 时，**Lz 必须是 a 的整数倍**，否则上一层原子刚好不在 region 内 → 上壁 0 原子。
- **安全写法**：region 用 \`units lattice\` 写 + 加 ε 缓冲，例如 \`region top block 0 nx 0 ny nz-1 nz+0.01 units lattice\`；或显式 \`lattice fcc a origin 0.0 0.0 0.0 orient x 1 0 0 ...\` 钉死，并保证 box 高度 = lattice 整数倍。
- 验证：\`lmp_validate_input\` 后看 thermo 头一行 \`atoms = N\`，N 应等于 4·nx·ny·nz（FCC）。

**C) atom_style / data 列数不匹配** → atomic=5 列 / charge=6 列 / full=7 列。

**D) pair_coeff 元素顺序 ≠ mass 顺序** → 算的不是你想要的体系。mass 行注释清楚元素，pair_coeff 末尾元素按 type 顺序列。

**E) 限域/通道流（Poiseuille/Couette/纳米管内流）的控温陷阱（看着简单、最容易静悄悄算错）**
- **先 \`lmp_template_search query="限域流动 poiseuille"\` 取 \`confined_flow_poiseuille\` 黄金模板照抄**，别凭空写。
- 三条铁律（lint 规则 L13 会拦）：① 控温**只挂流体组**(group flow = all 减壁面)，别挂 all；② 温度要**去掉流向流速偏置**：\`compute mobile flow temp\` + \`fix_modify <控温> temp mobile\` + \`thermo_modify temp mobile\`；③ 壁面 \`velocity ... set 0\` + \`setforce\` 冻结，2D 必 \`fix enforce2d\`。
- 漏了②的典型症状：流动被慢慢"刹停"、温度读数虚高——**不报错但结果是错的**。驱动力用 \`fix addforce\`（Poiseuille）或移动壁 \`velocity upper set\`（Couette）。

# 提醒（按需查）
- 拿不准的命令/参数顺序 → \`lmp_doc_lookup\`
- 势函数文件名拿不准 → \`lmp_find_potential\`
- 复杂单位换算 → \`lmp_unit_convert\`
- Windows MPI：mpiexec 已自动注入 \`-localonly\`
`;

const CASE_LIB_PROMPT = '';

// ====================== Express App ======================
const app = express();
app.use(express.json({ limit: '50mb' }));
// 欢迎页路由（必须放在 express.static 之前）
app.get(['/', '/welcome', '/welcome.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
});
app.get(['/app', '/app.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => res.json({ workspace: WORKSPACE, model: SETTINGS.model, name: 'MDriver', author: 'LZF', platform: process.platform, hasApiKey: !!SETTINGS.apiKey, pythonPath: SETTINGS.pythonPath || '', provider: SETTINGS.provider || 'sf', baseUrl: SETTINGS.baseUrl || '', copilotModel: SETTINGS.copilotModel || 'gpt-4.1', copilotLoggedIn: !!COPILOT.ghToken, lammpsRoot: SETTINGS.lammpsRoot || '', lammpsBin: SETTINGS.lammpsBin || '' }));

// ---- 健康检查 + 案例库 ----
app.get('/healthz', async (req, res) => {
  // 用 stdout 实际包含 LAMMPS/Packmol/OpenBabel 字样来判定，避免 shell exit=1 误判
  const has = async (bin, marker) => new Promise(r => {
    const p = spawn(bin, ['-h'], { windowsHide: true, shell: true });
    let buf = '';
    p.stdout.on('data', d => buf += d.toString());
    p.stderr.on('data', d => buf += d.toString());
    p.on('error', () => r(false));
    const to = setTimeout(() => { try { p.kill(); } catch {} r(marker.test(buf)); }, 3000);
    p.on('close', () => { clearTimeout(to); r(marker.test(buf)); });
  });
  const [lmp, packmol, obabel] = await Promise.all([
    has(SETTINGS.lammpsBin || 'lmp', /LAMMPS|Large-scale Atomic/i),
    has(SETTINGS.packmolBin || 'packmol', /PACKMOL/i),
    has(SETTINGS.obabelBin || 'obabel', /Open Babel|obabel/i)
  ]);
  res.json({ ok: true, version: '0.1.0', name: 'MDriver',
    port: PORT, sessions: sessions.size,
    lammps: lmp, packmol, obabel,
    pythonPath: SETTINGS.pythonPath || null,
    workspace: WORKSPACE
  });
});
app.get('/api/case-library', async (req, res) => {
  try {
    const fp = path.join(__dirname, 'cases', 'case_library.json');
    const j = JSON.parse(await fs.readFile(fp, 'utf8'));
    res.json(j);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 文件树 / 工作区切换 / 绝对路径浏览（被欢迎页和文件浏览面板使用）----
app.get('/api/tree', async (_, res) => {
  try { res.json(await buildTree()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/workspace', async (req, res) => {
  try {
    const dir = (req.body && req.body.dir) || '';
    if (!dir) return res.status(400).json({ error: '缺少 dir' });
    const abs = path.resolve(dir);
    const st = await fs.stat(abs);
    if (!st.isDirectory()) return res.status(400).json({ error: '不是目录: ' + abs });
    WORKSPACE = abs;
    SETTINGS.workspace = abs;
    await saveSettings();
    try { broadcastTree(); } catch {}
    res.json({ ok: true, workspace: WORKSPACE });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 浏览任意目录（用于前端的文件夹/文件 picker）
// GET /api/list-abs?path=C:\Users\xxx  →  { cwd, parent, items:[{name,path,isDir,size}] }
app.get('/api/list-abs', async (req, res) => {
  try {
    let p = req.query.path;
    if (!p) {
      // 默认起点：当前工作区；若不存在，回退到用户主目录
      try { await fs.access(WORKSPACE); p = WORKSPACE; }
      catch { p = process.env.USERPROFILE || process.env.HOME || (process.platform === 'win32' ? 'C:\\' : '/'); }
    }
    const abs = path.resolve(p);
    const st = await fs.stat(abs).catch(() => null);
    if (!st || !st.isDirectory()) return res.json({ error: '不是有效目录: ' + abs });
    const parent = path.dirname(abs);
    const items = [];
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name));
    for (const e of entries) {
      // 跳过 Windows 系统隐藏 + node_modules 这种大目录提升响应速度
      if (e.name === 'node_modules' || e.name === '$RECYCLE.BIN' || e.name === 'System Volume Information') continue;
      const full = path.join(abs, e.name);
      let size = 0;
      if (!e.isDirectory()) { try { size = (await fs.stat(full)).size; } catch {} }
      items.push({ name: e.name, path: full, isDir: e.isDirectory(), size });
      if (items.length > 800) break;
    }
    res.json({ cwd: abs, parent: parent === abs ? null : parent, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- 兼容旧前端：legacy 求解器监测面板还会 8 秒轮询一次；返回空数组 ----
app.get('/api/foam/runs', (_, res) => res.json({ runs: [] }));
app.get('/api/foam/config', (_, res) => res.json({ foamMode: false, root: '' }));
app.get('/api/mfix/config', (_, res) => res.json({ mfixMode: false, root: '', bash: '' }));
app.get('/api/lbm/config', (_, res) => res.json({ lbmMode: false, tutorialRoot: '', runCmd: '' }));
app.get('/api/pv/probe', (_, res) => res.json({ ok: false, error: 'ParaView 通道已移除' }));

// ====================== 文件读写（编辑器 / 预览）======================
// GET /api/file?path=relPath          → JSON { content, size, mtime, binary }
// GET /api/file?path=relPath&raw=1    → 原始字节（图片 / STL / PDF / VTK 用）
// POST /api/file  { path, content }   → 保存文本
const _isProbablyBinary = (buf) => {
  // 检查前 8KB 是否包含 NUL 字节
  const n = Math.min(8192, buf.length);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
};
const _mimeByExt = (ext) => ({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.stl': 'model/stl',
  '.vtu': 'application/xml', '.vtp': 'application/xml', '.vti': 'application/xml',
  '.vtk': 'application/octet-stream', '.pvd': 'application/xml',
  '.json': 'application/json', '.xml': 'application/xml', '.csv': 'text/csv',
  '.txt': 'text/plain', '.md': 'text/markdown'
}[ext] || 'application/octet-stream');

app.get('/api/file', async (req, res) => {
  try {
    const p = String(req.query.path || '').replace(/^[\\\/]+/, '');
    if (!p) return res.status(400).json({ error: 'missing path' });
    const abs = path.resolve(WORKSPACE, p);
    const root = path.resolve(WORKSPACE);
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      return res.status(403).json({ error: 'forbidden: outside workspace' });
    }
    let st;
    try { st = await fs.stat(abs); } catch { return res.status(404).json({ error: 'not found: ' + p }); }
    if (st.isDirectory()) return res.status(400).json({ error: 'is a directory: ' + p });
    if (req.query.raw === '1' || req.query.raw === 'true') {
      const ext = path.extname(abs).toLowerCase();
      res.set('content-type', _mimeByExt(ext));
      res.set('content-length', st.size);
      res.set('cache-control', 'no-cache');
      const stream = fssync.createReadStream(abs);
      stream.on('error', err => { if (!res.headersSent) res.status(500).send(err.message); else res.end(); });
      return stream.pipe(res);
    }
    // 文本读取（限制 8MB 防爆）
    if (st.size > 8 * 1024 * 1024) {
      return res.json({ binary: true, size: st.size, mtime: st.mtimeMs, note: 'file too large (>8MB)' });
    }
    const buf = await fs.readFile(abs);
    if (_isProbablyBinary(buf)) {
      return res.json({ binary: true, size: st.size, mtime: st.mtimeMs });
    }
    res.json({ content: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs, binary: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/file', async (req, res) => {
  try {
    const { path: p, content } = req.body || {};
    if (!p) return res.status(400).json({ error: 'missing path' });
    if (typeof content !== 'string') return res.status(400).json({ error: 'content must be string' });
    const abs = path.resolve(WORKSPACE, String(p).replace(/^[\\\/]+/, ''));
    const root = path.resolve(WORKSPACE);
    if (!abs.startsWith(root + path.sep) && abs !== root) {
      return res.status(403).json({ error: 'forbidden: outside workspace' });
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    const st = await fs.stat(abs);
    // 通知客户端文件树有变动（轻量）
    try { broadcastTree && broadcastTree(); } catch {}
    res.json({ ok: true, bytes: st.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/settings', (req, res) => res.json({ ...SETTINGS, apiKey: SETTINGS.apiKey ? '***' + SETTINGS.apiKey.slice(-4) : '', visionApiKey: SETTINGS.visionApiKey ? '***' + SETTINGS.visionApiKey.slice(-4) : '' }));
app.post('/api/settings', async (req, res) => {
  const u = req.body || {};
  if (u.apiKey !== undefined && !u.apiKey.startsWith('***')) SETTINGS.apiKey = u.apiKey;
  if (u.baseUrl !== undefined) SETTINGS.baseUrl = u.baseUrl;
  if (u.model !== undefined) SETTINGS.model = u.model;
  if (u.provider !== undefined) SETTINGS.provider = u.provider;
  if (u.copilotModel !== undefined) SETTINGS.copilotModel = u.copilotModel;
  if (u.pythonPath !== undefined) SETTINGS.pythonPath = u.pythonPath;
  if (u.lammpsRoot !== undefined) SETTINGS.lammpsRoot = u.lammpsRoot;
  if (u.lammpsBin !== undefined) SETTINGS.lammpsBin = u.lammpsBin;
  if (u.visionProvider !== undefined) SETTINGS.visionProvider = u.visionProvider;
  if (u.visionBaseUrl !== undefined) SETTINGS.visionBaseUrl = u.visionBaseUrl;
  if (u.visionModel !== undefined) SETTINGS.visionModel = u.visionModel;
  if (u.visionApiKey !== undefined && !u.visionApiKey.startsWith('***')) SETTINGS.visionApiKey = u.visionApiKey;
  await saveSettings(); res.json({ ok: true });
});

// ============ GitHub Copilot 端点 ============
app.get('/api/copilot/status', (req, res) => res.json({ loggedIn: !!COPILOT.ghToken, provider: SETTINGS.provider, model: SETTINGS.copilotModel }));
app.post('/api/copilot/auth/start', async (req, res) => {
  try { res.json(await copilotDeviceStart()); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/copilot/auth/poll', async (req, res) => {
  try {
    const j = await copilotDevicePoll(req.body?.device_code);
    if (j.access_token) { COPILOT.ghToken = j.access_token; await saveCopilotState(); COPILOT.apiToken = ''; return res.json({ ok: true }); }
    res.json({ pending: true, ...j });
  } catch (e) {
    const msg = String(e.message || e);
    if (/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(msg)) {
      return res.json({ pending: true, error: 'authorization_pending', error_description: '网络抖动：' + msg });
    }
    res.status(500).json({ error: msg });
  }
});
app.post('/api/copilot/logout', async (req, res) => { COPILOT.ghToken = ''; COPILOT.apiToken = ''; await saveCopilotState(); res.json({ ok: true }); });

// ====================== LAMMPS 一键部署 / 自动检测 ======================
function findExecOnPath(cmd) {
  const exts = process.platform === 'win32' ? ['.exe', '.bat', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const e of exts) {
      const full = path.join(dir, cmd + e);
      try { if (fssync.statSync(full).isFile()) return full; } catch {}
    }
  }
  return null;
}
// shell-based which/where (覆盖 .bat/.cmd/别名/winget shim)
function whichShell(cmd) {
  return new Promise(resolve => {
    const isWin = process.platform === 'win32';
    const tool = isWin ? 'where' : 'which';
    const p = spawn(tool, [cmd], { windowsHide: true, shell: true });
    let buf = '';
    p.stdout.on('data', d => buf += d.toString());
    p.on('error', () => resolve(null));
    p.on('close', code => {
      if (code !== 0) return resolve(null);
      const first = buf.split(/\r?\n/).map(s => s.trim()).find(Boolean);
      resolve(first || null);
    });
  });
}

app.get('/api/deploy/detect', async (req, res) => {
  const candidates = ['lmp', 'lmp_serial', 'lmp_mpi', 'lammps', 'lmp.exe'];
  const looksReal = (p) => p && !/\.(js|py|ps1|sh|rb|ts)$/i.test(p);
  let found = (SETTINGS.lammpsBin && looksReal(SETTINGS.lammpsBin) && (await fs.access(SETTINGS.lammpsBin).then(() => true).catch(() => false))) ? SETTINGS.lammpsBin : null;
  if (!found) {
    for (const c of candidates) {
      const p = findExecOnPath(c);
      if (p) { found = p; break; }
    }
  }
  // fallback: shell where/which（处理 winget shim、别名、PATHEXT 之外的扩展）
  if (!found) {
    for (const c of candidates) {
      const p = await whichShell(c);
      // 过滤掉 .js/.py/.ps1 这种被 PATHEXT 误命中的脚本
      if (p && /\.(exe|bat|cmd)$/i.test(p)) { found = p; break; }
      if (p && process.platform !== 'win32') { found = p; break; }
    }
  }
  if (!found) return res.json({ ok: false, error: '未在 PATH / 设置中找到 LAMMPS 可执行文件。请手动填写 lmp 路径，或先安装。' });
  // 获取版本
  let version = '';
  try {
    const out = await new Promise(resolve => {
      const p = spawn(found, ['-h'], { windowsHide: true });
      let buf = '';
      p.stdout.on('data', d => buf += d.toString());
      p.stderr.on('data', d => buf += d.toString());
      const to = setTimeout(() => { try { p.kill(); } catch {}; resolve(buf); }, 4000);
      p.on('close', () => { clearTimeout(to); resolve(buf); });
    });
    const m = out.match(/LAMMPS \(([^)]+)\)/);
    if (m) version = m[1];
  } catch {}
  // 自动写入设置
  SETTINGS.lammpsBin = found;
  SETTINGS.lammpsRoot = SETTINGS.lammpsRoot || path.dirname(path.dirname(found));
  await saveSettings();
  res.json({ ok: true, bin: found, version });
});

app.post('/api/deploy/lammps', async (req, res) => {
  const { platform } = req.body || {};
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  const w = (s) => { res.write(s + '\n'); };
  const runStream = (cmd, argv) => new Promise(resolve => {
    w(`[info] $ ${cmd} ${argv.join(' ')}`);
    const p = spawn(cmd, argv, { windowsHide: true, shell: process.platform === 'win32' });
    p.stdout.on('data', d => res.write(d));
    p.stderr.on('data', d => res.write(d));
    p.on('error', e => { w(`[err] ${e.message}`); resolve(-1); });
    p.on('close', code => { w(`[info] exit ${code}`); resolve(code); });
  });
  try {
    if (platform === 'linux') {
      w('[info] 使用 apt-get 安装（需要 sudo 权限）');
      const code = await runStream('sh', ['-c', 'sudo -n apt-get update && sudo -n apt-get install -y lammps']);
      if (code === 0) w('[ok] 安装完成，请点"已安装/自动检测"刷新路径');
      else w('[err] apt 失败；若提示需要密码，请在终端手动 `sudo apt install lammps`');
    } else if (platform === 'mac') {
      w('[info] 使用 Homebrew 安装');
      const code = await runStream('sh', ['-c', 'brew install lammps']);
      if (code === 0) w('[ok] 安装完成');
      else w('[err] brew 失败；请确认已安装 Homebrew');
    } else if (platform === 'win') {
      w('[info] 优先尝试 winget...');
      const code = await runStream('winget', ['install', '--id', 'LAMMPS.LAMMPS', '--accept-package-agreements', '--accept-source-agreements']);
      if (code !== 0) {
        w('[info] winget 不可用，请手动下载：');
        w('[info] https://packages.lammps.org/windows.html');
        w('[info] 下载安装后，把 lmp.exe 路径填到右侧设置面板，或点"已安装/自动检测"');
      } else {
        w('[ok] 安装完成');
      }
    } else {
      w(`[err] 未知平台：${platform}`);
    }
  } catch (e) {
    w(`[err] 异常：${e.message}`);
  }
  res.end();
});

// ---- 从 GitHub Releases 下载 LAMMPS Windows 安装包并自动安装 ----
// 流：GET /api/deploy/lammps-github   (Server-Sent text 流)
app.get('/api/deploy/lammps-github', async (req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  const w = (s) => { res.write(s + '\n'); };
  if (process.platform !== 'win32') {
    w('[err] 该通道仅支持 Windows。Linux 请用 apt / macOS 请用 brew。');
    return res.end();
  }
  try {
    w('[info] 查询 GitHub: lammps/lammps releases ...');
    const ghHeaders = { 'user-agent': 'MDriver/0.1', 'accept': 'application/vnd.github+json' };
    // 取最近 10 个 release，找带 .exe 的 Windows 安装包
    const listR = await fetch('https://api.github.com/repos/lammps/lammps/releases?per_page=10', { headers: ghHeaders });
    if (!listR.ok) { w(`[err] GitHub API ${listR.status}：${await listR.text()}`); return res.end(); }
    const releases = await listR.json();
    let asset = null, tag = '';
    for (const r of releases) {
      const a = (r.assets || []).find(x => /\.exe$/i.test(x.name) && /win|64.?bit|MSMPI|64bit/i.test(x.name));
      if (a) { asset = a; tag = r.tag_name; break; }
    }
    // 后备：lammps/lammps 仓库的 release 经常没绑 Windows 安装包
    if (!asset) {
      w('[info] lammps/lammps 的 release 未挂 Windows .exe，回退到官方镜像 packages.lammps.org');
      const fallbackUrl = 'https://download.lammps.org/static/admin/LAMMPS-64bit-latest-MSMPI.exe';
      asset = { browser_download_url: fallbackUrl, name: 'LAMMPS-64bit-latest-MSMPI.exe', size: 0 };
      tag = 'latest-mirror';
    }
    w(`[ok] 选定版本: ${tag}`);
    w(`[ok] 资源: ${asset.name}` + (asset.size ? ` (${(asset.size/1024/1024).toFixed(1)} MB)` : ''));
    w(`[info] URL: ${asset.browser_download_url}`);

    // 下载到临时目录
    const tmpDir = path.join(__dirname, '.cache', 'lammps-installer');
    await fs.mkdir(tmpDir, { recursive: true });
    const exePath = path.join(tmpDir, asset.name);
    w(`[info] 下载到: ${exePath}`);
    const dlR = await fetch(asset.browser_download_url, { redirect: 'follow' });
    if (!dlR.ok) { w(`[err] 下载失败 HTTP ${dlR.status}`); return res.end(); }
    const total = Number(dlR.headers.get('content-length') || 0);
    let got = 0, lastPct = -1;
    const ws = fssync.createWriteStream(exePath);
    for await (const chunk of dlR.body) {
      ws.write(chunk);
      got += chunk.length;
      if (total > 0) {
        const pct = Math.floor(got / total * 100);
        if (pct !== lastPct && pct % 5 === 0) { w(`[info] 下载进度 ${pct}% (${(got/1024/1024).toFixed(1)}/${(total/1024/1024).toFixed(1)} MB)`); lastPct = pct; }
      } else if (got % (4*1024*1024) < 1024) {
        w(`[info] 已下载 ${(got/1024/1024).toFixed(1)} MB`);
      }
    }
    await new Promise(r => ws.end(r));
    w(`[ok] 下载完成: ${(got/1024/1024).toFixed(1)} MB`);

    // 静默安装（NSIS 安装包用 /S）
    const installDir = path.join('C:\\', 'LAMMPS-' + tag.replace(/[^a-z0-9.-]+/gi, '_'));
    w(`[info] 静默安装到: ${installDir}`);
    w(`[info] $ ${exePath} /S /D=${installDir}`);
    const code = await new Promise(resolve => {
      const p = spawn(exePath, ['/S', `/D=${installDir}`], { windowsHide: false });
      p.on('error', e => { w(`[err] 启动安装器失败: ${e.message}`); resolve(-1); });
      p.on('close', c => resolve(c));
    });
    if (code !== 0) {
      w(`[warn] 静默安装退出码 ${code}。可能 NSIS 不支持 /S 或需管理员权限。`);
      w(`[info] 已尝试运行 GUI 安装器，请按提示完成（或右键以管理员身份运行 ${exePath}）。`);
      // 启动 GUI 兜底
      spawn(exePath, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } else {
      w('[ok] 安装完成');
    }

    // 自动尝试找 lmp.exe
    const guessBins = [
      path.join(installDir, 'bin', 'lmp.exe'),
      path.join(installDir, 'lmp.exe'),
      path.join(installDir, 'bin', 'lmp_mpi.exe'),
    ];
    for (const g of guessBins) {
      try { await fs.access(g); SETTINGS.lammpsBin = g; SETTINGS.lammpsRoot = installDir; await saveSettings(); w(`[ok] 已自动写入设置: ${g}`); break; } catch {}
    }
    w('[done] 请点"已安装/自动检测"刷新状态。');
  } catch (e) {
    w(`[err] 异常: ${e.message}`);
  }
  res.end();
});

// ====================== 轨迹文件服务（NGL Viewer 用）======================
app.get('/api/traj', async (req, res) => {
  try {
    const p = req.query.path;
    if (!p) return res.status(400).send('missing path');
    const abs = path.resolve(WORKSPACE, p);
    if (!abs.startsWith(path.resolve(WORKSPACE))) return res.status(403).send('forbidden');
    try { await fs.access(abs); } catch { return res.status(404).send('not found: ' + p); }
    const st = await fs.stat(abs);
    if (st.isDirectory()) return res.status(400).send('is a directory: ' + p);
    const ext = path.extname(abs).toLowerCase();
    const ctype = ext === '.xyz' ? 'chemical/x-xyz' :
                  ext === '.pdb' ? 'chemical/x-pdb' :
                  ext === '.gro' ? 'chemical/x-gro' :
                  ext === '.lammpstrj' || ext === '.atom' ? 'chemical/x-lammps' :
                  ext === '.cif' ? 'chemical/x-cif' :
                  'application/octet-stream';
    res.set('content-type', ctype);
    res.set('content-length', st.size);
    res.set('cache-control', 'no-cache');
    res.set('access-control-allow-origin', '*');
    const stream = fssync.createReadStream(abs);
    stream.on('error', err => { if (!res.headersSent) res.status(500).send(err.message); else res.end(); });
    stream.pipe(res);
  } catch (e) { res.status(500).send(e.message); }
});

// ====================== 图片搜索 / 下载 HTTP ======================
app.post('/api/image_search', async (req, res) => {
  try {
    const { query, top_k } = req.body || {};
    if (!query) return res.json({ error: 'missing query' });
    const imgs = await imageSearch(query, Math.min(30, top_k || 12));
    broadcastImages(imgs, query);
    res.json({ ok: true, count: imgs.length, images: imgs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/download_image', async (req, res) => {
  try {
    const { url, save_as } = req.body || {};
    if (!url) return res.json({ error: 'missing url' });
    const out = await downloadFile(url, save_as);
    res.json({ ok: true, message: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ \u6c42\u89e3\u5668\u540e\u53f0\u4f5c\u4e1a HTTP ============

// ====================== 自定义工作流 Beta HTTP ======================
app.get('/api/custom/config', (req, res) => {
  res.json({
    customMode: !!SETTINGS.customMode,
    name:   SETTINGS.customName   || '',
    root:   SETTINGS.customRoot   || '',
    prompt: SETTINGS.customPrompt || ''
  });
});
app.post('/api/custom/config', async (req, res) => {
  try {
    if (typeof req.body?.name === 'string')   SETTINGS.customName   = req.body.name.slice(0, 200);
    if (typeof req.body?.root === 'string')   SETTINGS.customRoot   = req.body.root.slice(0, 500);
    if (typeof req.body?.prompt === 'string') SETTINGS.customPrompt = req.body.prompt.slice(0, 20000);
    if (typeof req.body?.customMode === 'boolean') SETTINGS.customMode = req.body.customMode;
    await saveSettings();
    res.json({
      ok: true,
      customMode: !!SETTINGS.customMode,
      name:   SETTINGS.customName   || '',
      root:   SETTINGS.customRoot   || '',
      prompt: SETTINGS.customPrompt || ''
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ====================== Digitizer (V3) HTTP ======================
// 序列化 request_id → { resolve, reject, timer } 为了等用户亲手标注后调用 tool 返回。
const PENDING_DIGITIZE = new Map();

app.post('/api/digitize/save', async (req, res) => {
  try {
    const body = req.body || {};
    const name = (body.name || 'plot').toString().replace(/[^\w\-]/g, '_').slice(0, 60) || 'plot';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dir = path.join(WORKSPACE, 'digitized');
    await fs.mkdir(dir, { recursive: true });
    const csvPath = path.join(dir, `${ts}_${name}.csv`);
    const pts = Array.isArray(body.points) ? body.points : [];
    const head = `# digitized at ${new Date().toISOString()}\n# axis_x=${body.axis_x} axis_y=${body.axis_y}\n# calibration: X1=(${body?.calibration?.x1?.x},${body?.calibration?.x1?.y})→${body?.calibration?.x1?.value}  X2=(${body?.calibration?.x2?.x},${body?.calibration?.x2?.y})→${body?.calibration?.x2?.value}  Y1=(${body?.calibration?.y1?.x},${body?.calibration?.y1?.y})→${body?.calibration?.y1?.value}  Y2=(${body?.calibration?.y2?.x},${body?.calibration?.y2?.y})→${body?.calibration?.y2?.value}\nx,y\n`;
    const lines = pts.map(p => `${Number(p.x)},${Number(p.y)}`).join('\n') + '\n';
    await fs.writeFile(csvPath, head + lines);
    // 也可选保存原始图片
    let imgRel = null;
    if (body.image_base64) {
      const imgPath = path.join(dir, `${ts}_${name}.png`);
      await fs.writeFile(imgPath, Buffer.from(body.image_base64, 'base64'));
      imgRel = path.relative(WORKSPACE, imgPath).replace(/\\/g, '/');
    }
    const rel = path.relative(WORKSPACE, csvPath).replace(/\\/g, '/');

    // 如果是 agent 发起的 request → 解锁 pending
    if (body.request_id && PENDING_DIGITIZE.has(body.request_id)) {
      const entry = PENDING_DIGITIZE.get(body.request_id);
      PENDING_DIGITIZE.delete(body.request_id);
      try { clearTimeout(entry.timer); } catch {}
      entry.resolve({ csvPath: rel, imagePath: imgRel, points: pts, axis_x: body.axis_x, axis_y: body.axis_y, name });
    }
    // 广播给所有 ws：让聊天出一条系统提示
    if (body.send_to_chat) {
      for (const c of allClients) {
        try { c.send(JSON.stringify({ type: 'term', line: `[标注完成] ${pts.length} 个数据点 → ${rel}` })); } catch {}
      }
    }
    res.json({ ok: true, path: rel, image_path: imgRel, count: pts.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/digitize/cancel', (req, res) => {
  const id = req.body?.request_id;
  if (id && PENDING_DIGITIZE.has(id)) {
    const entry = PENDING_DIGITIZE.get(id);
    PENDING_DIGITIZE.delete(id);
    try { clearTimeout(entry.timer); } catch {}
    entry.resolve({ canceled: true });
  }
  res.json({ ok: true });
});

// Agent 端工具：让用户手动标注一张图表
async function requestUserDigitize(args, ws, session) {
  const reqId = 'dig-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const timeoutSec = Math.max(30, Math.min(3600, args.timeout_sec || 600));
  let imageBase64 = null;
  let imageNote = '';
  if (args.image_path) {
    try {
      const abs = path.isAbsolute(args.image_path) ? args.image_path : path.resolve(WORKSPACE, args.image_path);
      const buf = await fs.readFile(abs);
      imageBase64 = buf.toString('base64');
      imageNote = ` (已预加载 ${path.relative(WORKSPACE, abs)})`;
    } catch (e) {
      imageNote = ` (预加载失败: ${e.message}，用户需自行选图)`;
    }
  }
  // 推送给当前 ws + 所有 ws（让用户能从任意标签页响应）
  const payload = { type: 'digitize_open', request_id: reqId, image_base64: imageBase64, hint: args.hint || '', name: args.name || 'plot' };
  try { ws.send(JSON.stringify(payload)); } catch {}
  // 同步等用户
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (PENDING_DIGITIZE.has(reqId)) {
        PENDING_DIGITIZE.delete(reqId);
        resolve(`[超时] 用户在 ${timeoutSec}s 内未完成标注${imageNote}`);
      }
    }, timeoutSec * 1000);
    PENDING_DIGITIZE.set(reqId, {
      timer,
      resolve: (r) => {
        if (r.canceled) return resolve(`[用户取消] 标注被取消${imageNote}`);
        const lines = [
          `[标注完成]${imageNote}`,
          `CSV: ${r.csvPath}`,
          r.imagePath ? `IMG: ${r.imagePath}` : null,
          `axis_x=${r.axis_x}, axis_y=${r.axis_y}, n=${r.points.length}`,
          ``,
          `数据点（x, y）：`,
          ...r.points.slice(0, 80).map((p, i) => `  ${i+1}. ${Number(p.x).toPrecision(6)}, ${Number(p.y).toPrecision(6)}`)
        ].filter(Boolean);
        if (r.points.length > 80) lines.push(`  ... 还有 ${r.points.length - 80} 个点见 CSV`);
        resolve(lines.join('\n'));
      },
      reject: () => resolve(`[标注失败]`)
    });
  });
}

// ====================== Python 环境发现 ======================
function probePython(exe) {
  return new Promise((resolve) => {
    const p = spawn(exe, ['-c', 'import sys,platform,os; print(sys.version.split()[0]); print(sys.executable); print(os.environ.get("CONDA_DEFAULT_ENV",""))'], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    const to = setTimeout(() => { try { p.kill(); } catch {} resolve(null); }, 4000);
    p.on('close', (code) => { clearTimeout(to); if (code !== 0) return resolve(null);
      const [ver, real, conda] = out.trim().split(/\r?\n/);
      resolve({ path: real || exe, version: ver || '', conda: conda || '' });
    });
    p.on('error', () => { clearTimeout(to); resolve(null); });
  });
}

async function discoverPythons() {
  const candidates = new Set();
  // 1. PATH 上的
  if (IS_WIN) ['python.exe', 'python3.exe', 'py.exe'].forEach(n => candidates.add(n));
  else ['python3', 'python'].forEach(n => candidates.add(n));
  // 2. 常见 conda 位置
  const home = os.homedir();
  const condaRoots = IS_WIN
    ? [path.join(home, 'anaconda3'), path.join(home, 'miniconda3'), path.join(home, 'miniforge3'), 'C:\\ProgramData\\Anaconda3', 'C:\\ProgramData\\miniconda3']
    : [path.join(home, 'anaconda3'), path.join(home, 'miniconda3'), path.join(home, 'miniforge3'), '/opt/anaconda3', '/opt/miniconda3'];
  for (const root of condaRoots) {
    try { await fs.access(root);
      candidates.add(IS_WIN ? path.join(root, 'python.exe') : path.join(root, 'bin', 'python'));
      const envsDir = path.join(root, 'envs');
      try { const entries = await fs.readdir(envsDir, { withFileTypes: true });
        for (const e of entries) if (e.isDirectory())
          candidates.add(IS_WIN ? path.join(envsDir, e.name, 'python.exe') : path.join(envsDir, e.name, 'bin', 'python'));
      } catch {}
    } catch {}
  }
  // 3. 当前工作区的 venv
  for (const sub of ['.venv', 'venv', 'env', '.env']) {
    const py = IS_WIN ? path.join(WORKSPACE, sub, 'Scripts', 'python.exe') : path.join(WORKSPACE, sub, 'bin', 'python');
    try { await fs.access(py); candidates.add(py); } catch {}
  }
  // 4. Windows: py.exe -0p 列出所有安装
  if (IS_WIN) {
    try {
      const out = await new Promise((res) => {
        const p = spawn('py.exe', ['-0p'], { windowsHide: true });
        let o = ''; p.stdout.on('data', d => o += d);
        p.on('close', () => res(o)); p.on('error', () => res(''));
        setTimeout(() => { try { p.kill(); } catch {} res(o); }, 3000);
      });
      out.split(/\r?\n/).forEach(l => { const m = l.match(/([A-Z]:\\[^\r\n]+python\.exe)/i); if (m) candidates.add(m[1]); });
    } catch {}
  }
  // 探测并去重
  const results = []; const seen = new Set();
  for (const c of candidates) {
    const info = await probePython(c);
    if (!info) continue;
    if (seen.has(info.path)) continue;
    seen.add(info.path);
    results.push({ path: info.path, version: info.version, conda: info.conda, requested: c });
  }
  results.sort((a, b) => b.version.localeCompare(a.version));
  return results;
}

let PY_CACHE = null;
app.get('/api/python/list', async (req, res) => {
  if (req.query.refresh === '1') PY_CACHE = null;
  if (!PY_CACHE) PY_CACHE = await discoverPythons();
  res.json({ envs: PY_CACHE, current: SETTINGS.pythonPath || '' });
});
app.post('/api/python/select', async (req, res) => {
  const { path: p } = req.body || {};
  if (p) {
    const info = await probePython(p);
    if (!info) return res.status(400).json({ error: '路径不是有效的 Python 解释器' });
    SETTINGS.pythonPath = info.path;
  } else SETTINGS.pythonPath = '';
  await saveSettings();
  res.json({ ok: true, current: SETTINGS.pythonPath });
});

// ====================== pvpython 自检（诊断 IMPORT_ERR） ======================
app.get('/api/pv/probe', async (req, res) => {
  const exe = pvpythonExe();
  const result = {
    chosenExe: exe,
    settings: {
      paraviewExe: SETTINGS.paraviewExe || '',
      paraviewPython: SETTINGS.paraviewPython || ''
    },
    exists: fssync.existsSync(exe),
    basenameLooksRight: /pvpython/i.test(path.basename(exe)),
    hostEnv: {
      PYTHONHOME: process.env.PYTHONHOME || '',
      PYTHONPATH: process.env.PYTHONPATH || '',
      CONDA_PREFIX: process.env.CONDA_PREFIX || ''
    },
    test: null,
    suggestion: ''
  };
  if (!result.exists) {
    result.suggestion = `所选 pvpython 不存在：${exe}。请在「设置 → ParaView Python 路径」里指向 ParaView 安装目录下的 bin/pvpython.exe（不是普通 python.exe）。`;
    return res.json(result);
  }
  if (!result.basenameLooksRight) {
    result.suggestion = `当前路径文件名 (${path.basename(exe)}) 不像 pvpython。普通 python.exe 不带 paraview 模块，请改成 ParaView 安装目录下 bin/pvpython.exe。`;
  }
  await new Promise((resolve) => {
    const p = spawn(exe, ['-c', 'import sys;print(sys.executable);import paraview;print(paraview.__file__);print(getattr(paraview,"__version__",""))'], {
      windowsHide: true, env: pvCleanEnv()
    });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    const to = setTimeout(() => { try { p.kill(); } catch {} resolve(); }, 8000);
    p.on('close', (code) => {
      clearTimeout(to);
      const lines = out.trim().split(/\r?\n/);
      result.test = {
        exitCode: code,
        sysExecutable: lines[0] || '',
        paraviewModule: lines[1] || '',
        paraviewVersion: lines[2] || '',
        stderr: err.trim().slice(-500)
      };
      if (code !== 0 || !lines[1]) {
        if (/No module named 'paraview'/i.test(err)) {
          if (!result.basenameLooksRight) {
            result.suggestion = `用户把 ParaView Python 路径设成了 ${path.basename(exe)}，普通 python 不带 paraview 模块。请改成 ParaView 安装目录下 bin/pvpython.exe。`;
          } else if (process.env.PYTHONHOME || process.env.PYTHONPATH) {
            result.suggestion = `pvpython 启动了但 import paraview 失败。检测到宿主 PYTHONHOME/PYTHONPATH（conda/系统 Python 在劫持 pvpython 内嵌解释器）。已自动剔除这两个变量再启动；若仍失败说明 ParaView 安装目录不完整。`;
          } else {
            result.suggestion = `pvpython 找不到 paraview 模块——通常是 ParaView 安装不完整。请从官网重新下载 (paraview.org/download)，解压后用其 bin/pvpython.exe。`;
          }
        } else {
          result.suggestion = `pvpython 启动失败 (exit ${code})：${err.trim().slice(-300)}`;
        }
      } else {
        result.suggestion = `OK：pvpython 工作正常，paraview ${lines[2] || ''} @ ${lines[1] || ''}`;
      }
      resolve();
    });
    p.on('error', (e) => {
      clearTimeout(to);
      result.test = { exitCode: -1, error: e.message };
      result.suggestion = `pvpython 启动失败：${e.message}（路径：${exe}）`;
      resolve();
    });
  });
  res.json(result);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ============== WebSocket 心跳（防代理空闲断开 / 自动清理僵尸连接）==============
const WS_PING_MS = 25_000;
const wsHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
    try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'heartbeat', t: Date.now() })); } catch {}
  }
}, WS_PING_MS);
wss.on('close', () => clearInterval(wsHeartbeat));

// 构造完整 system prompt（基础 + LAMMPS 方法论 + 案例库索引）。
// 早期版本里多处直接拼接，已统一为一个函数避免引用未定义。
function buildSystemPrompt(_session) {
  let p = SYSTEM_PROMPT_BASE(WORKSPACE) + LAMMPS_PROMPT + CASE_LIB_PROMPT;
  // 训练模式：把当前领域技能包（硬经验/参数/模板）注入系统提示
  if (SETTINGS.activeSkill) {
    try { p += Skills.buildSkillInjection(SETTINGS.activeSkill); } catch {}
  }
  return p;
}

// ============ Agent Loop ============
// 接收用户消息 → callLLM 流式 → 派发 tool_calls → 再次 callLLM ... 直到无 tool_calls 或步数耗尽。
// ============ Agent FSM ============
// 状态机：plan → act → observe → (reflect)? → act … → done / await_user / aborted
//   plan       初始化 fsm（仅每次 runAgent 开头跑一次）
//   act        调用 LLM，可能产出 tool_calls
//   observe    顺序执行 tool_calls，写回历史
//   reflect    检测到循环或连续失败时注入一条系统反思，下一轮强制换路线
//   await_user 助手给出 1)/2)/3) 选项，等用户回答
//   done       LLM 无 tool_calls 且非选项，或 taskComplete=true
//   aborted    session.aborted
function _toolSig(name, args) {
  try { return name + '|' + JSON.stringify(args).slice(0, 200); } catch { return name; }
}

// 训练模式：从 LAMMPS 工具结果里抽取领域信号（lint 报错/通过、探针 verdict、是否跑了完整 run）
function captureSkillSignal(turn, name, rstr, ok) {
  const lammpsish = /^lmp_/.test(name);
  if (lammpsish) turn.touched = true;
  if (name === 'lmp_run_async') { turn.launchedAsync = turn.launchedAsync || ok; }
  if (!ok) turn.toolFails++;
  // 完整 run 跑完：lmp_run_wait / lmp_run_status 返回 verdict=ok（或 status=done 且 exit=0）→ 置 runCompleted。
  // 这是评测 run_completed 判据的关键来源——少了它会"明明跑完却判未跑完"。
  if (name === 'lmp_run_wait' || name === 'lmp_run_status') {
    try {
      const j = JSON.parse(rstr);
      const v = String(j.verdict || '').toLowerCase();
      if (v === 'ok') turn.runCompleted = true;
      else if (!v && j.status === 'done' && (j.exit_code === 0 || j.exit_code == null)) turn.runCompleted = true;
    } catch { /* 非 JSON 文本忽略 */ }
  }
  // lint：解析 {ok, errors:[{rule,msg,fix}], warnings:[...]}
  if (name === 'lmp_lint') {
    try {
      const j = JSON.parse(rstr);
      turn.lintPass = !!j.ok;
      for (const e of [...(j.errors || []), ...(j.warnings || [])]) {
        if (e && e.rule && e.msg && !turn.lintFiredRules.some(x => x.rule === e.rule)) {
          turn.lintFiredRules.push({ rule: e.rule, msg: String(e.msg).slice(0, 120), fix: String(e.fix || '').slice(0, 160) });
        }
      }
    } catch {}
  }
  // probe / pipeline：抓 verdict
  if (name === 'lmp_run_probe' || name === 'lmp_reaxff_pipeline') {
    turn.ranProbe = true;
    const verds = [];
    const m = rstr.match(/"verdict"\s*:\s*"([a-z\-]+)"/gi);
    if (m) for (const x of m) { const v = x.match(/"([a-z\-]+)"\s*$/i); if (v) verds.push(v[1]); }
    const m2 = rstr.match(/verdict[=:]\s*([a-z\-]+)/gi);
    if (m2) for (const x of m2) { const v = x.split(/[=:]\s*/)[1]; if (v) verds.push(v.trim()); }
    for (const v of verds) { turn.probeVerdicts.push(v); if (v === 'healthy') turn.probeHealthy = true; }
    // probe 健康 = 真跑了一小段且无报错 → 比静态 lint 更强的证据，顺带满足 lint_clean 判据
    // （agent 常用 probe 代替 lint，否则会"明明能跑却判 lint 未通过"）。
    if (turn.probeHealthy) turn.lintPass = true;
    // pipeline 通过 lint gate 时其结果也代表 lint 通过
    if (name === 'lmp_reaxff_pipeline' && /lint.*(通过|ok|pass)/i.test(rstr)) turn.lintPass = true;
  }
}

// 只读「监控/轮询」类工具：查长 run / 求解器状态。反复调用这些≠卡死循环，不该触发"换个思路"，
// 否则会把一个正常跑着的长 run 误判成死循环、催 agent 推倒重来（用户反馈的"没耐心来回窜"根因之一）。
const MONITOR_TOOLS = new Set([
  'lmp_run_status', 'foam_solver_status', 'mfix_solver_status', 'lbm_solver_status',
]);

function _ensureFsm(session) {
  if (!session.fsm) {
    session.fsm = { state: 'plan', lastSig: '', repeatSig: 0, noToolStreak: 0, reflections: 0, reflectQueued: '', monitorStreak: 0 };
  }
  return session.fsm;
}

async function runAgent(ws, userText, attachments) {
  const session = sessions.get(ws);
  if (!session) return;
  // 重置每轮状态
  session.aborted = false;
  session.aborter = new AbortController();
  session.taskComplete = false;
  session.fsm = { state: 'plan', lastSig: '', repeatSig: 0, noToolStreak: 0, reflections: 0, reflectQueued: '', monitorStreak: 0 };
  const fsm = session.fsm;
  // 训练模式：本轮领域信号收集器
  session._skillTurn = { active: !!session.activeSkill, touched: false, launchedAsync: false, runCompleted: false, ranProbe: false, probeVerdicts: [], probeHealthy: false, lintPass: false, lintFiredRules: [], toolFails: 0, rounds: 0, taskText: String(userText || '').slice(0, 120) };

  // 推送用户消息（含附件文本/图片）
  let userContent;
  try { userContent = await buildUserContent(userText, attachments); }
  catch (e) { userContent = String(userText || ''); ws.send(JSON.stringify({ type: 'term', line: `[附件处理失败] ${e.message}` })); }
  session.messages.push({ role: 'user', content: userContent });

  const MAX_STEPS = parseInt(process.env.AGENT_MAX_STEPS || '60', 10);
  const MAX_REFLECTIONS = 3;
  const runStart = Date.now();
  const sendPhase = (phase, detail, step, extra) => {
    try { ws.send(JSON.stringify({ type: 'agent_phase', phase, detail, step, max_steps: MAX_STEPS, elapsed_ms: Date.now() - runStart, fsm: fsm.state, ...(extra || {}) })); } catch {}
  };
  // 自训练（_benchMode）内部会反复调用 runAgent，不应每次都翻转前端发送/停止按钮状态。
  const isBench = !!session._benchMode;
  // 关键：每轮开始发 agent_start、结束（无论正常/异常/中止/超步数）必发 agent_end，
  // 保证前端发送按钮一定能恢复，杜绝“卡住后再也发不出消息”。
  if (!isBench) { try { ws.send(JSON.stringify({ type: 'agent_start' })); } catch {} }
  // 让用户看见“正在套用你调好的领域经验/模板”，把自进化的成果显性化。
  if (!isBench && SETTINGS.activeSkill) {
    try {
      const st = Skills.skillStatus(SETTINGS.activeSkill);
      if (st) {
        const nL = (st.lessons || []).length, nT = (st.templates || []).length, nR = (st.lintRules || []).length;
        const nP = Object.keys(st.params || {}).length;
        const bits = [];
        if (nL) bits.push(`${nL} 条经验`);
        if (nT) bits.push(`${nT} 个已验证模板`);
        if (nP) bits.push(`${nP} 项参数偏好`);
        if (nR) bits.push(`${nR} 条硬规则`);
        if (bits.length) ws.send(JSON.stringify({ type: 'term', line: `🧠 训练模式[${st.name}] 已套用：${bits.join(' · ')}（同类工况将优先照最优流程走）` }));
      }
    } catch {}
  }
  sendPhase('planning', '开始处理', 0);
  fsm.state = 'act';

  try {
    let step = 0;
    while (step < MAX_STEPS && fsm.state !== 'done' && fsm.state !== 'aborted' && fsm.state !== 'await_user') {
      if (session.aborted) { fsm.state = 'aborted'; ws.send(JSON.stringify({ type: 'term', line: '[已中止]' })); break; }

      // ---------- reflect：在 act 前注入反思 ----------
      if (fsm.reflectQueued) {
        // 用 user 角色 + 短句温和提示，避免被"训斥"后开始 over-explain
        session.messages.push({ role: 'user', content: fsm.reflectQueued });
        ws.send(JSON.stringify({ type: 'term', line: `[fsm.reflect] ${fsm.reflectQueued}` }));
        fsm.reflectQueued = '';
        fsm.reflections++;
      }

      // ---------- act ----------
      fsm.state = 'act';
      step++;
      const tools = filterTools(session.enabledTools);
      sendPhase('llm_thinking', `第 ${step} 轮思考`, step);
      ws.send(JSON.stringify({ type: 'assistant_start' }));

      let assistantMsg;
      try {
        assistantMsg = await callLLM(session.messages, ws, session.aborter.signal, tools);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'assistant_end' }));
        if (session.aborted || (e && e.name === 'AbortError')) { fsm.state = 'aborted'; break; }
        throw e;
      }
      ws.send(JSON.stringify({ type: 'assistant_end' }));
      session.messages.push(assistantMsg);

      const toolCalls = Array.isArray(assistantMsg.tool_calls) ? assistantMsg.tool_calls : [];

      // ---------- 转移条件 1：无 tool_calls ----------
      if (toolCalls.length === 0) {
        const txt = String(assistantMsg.content || '');
        if (/(^|\n)\s*1[\)\.](\s|\S)/.test(txt) && /(^|\n)\s*2[\)\.](\s|\S)/.test(txt)) {
          session.awaitingUserChoice = true;
          fsm.state = 'await_user';
          sendPhase('await_user', '等待用户选择', step);
          break;
        }
        fsm.noToolStreak++;
        // 连续 2 轮没有任何工具调用，且未声明完成 → 认为对话已结束，退出避免空转
        fsm.state = 'done';
        sendPhase('done', '本轮结束', step);
        break;
      }
      fsm.noToolStreak = 0;

      // ---------- observe ----------
      fsm.state = 'observe';
      sendPhase('tool_running', `执行 ${toolCalls.length} 个工具`, step, { tools: toolCalls.map(t => t.function?.name) });

      let roundFailures = 0;
      const roundSigs = [];
      for (const tc of toolCalls) {
        if (session.aborted) { fsm.state = 'aborted'; break; }
        const name = tc.function?.name || '';
        const toolStart = Date.now();
        sendPhase('tool_exec', `正在调用 ${name}`, step, { tool: name });
        let args = {};
        try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
        catch (e) {
          const result = `[ARG_PARSE_ERROR] 工具 ${name} 的 arguments 不是合法 JSON：${e.message}\n原始：${(tc.function?.arguments || '').slice(0, 400)}`;
          ws.send(JSON.stringify({ type: 'tool_call', id: tc.id, name, args: {} }));
          ws.send(JSON.stringify({ type: 'tool_result', id: tc.id, result, ok: false }));
          session.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: result });
          roundFailures++;
          continue;
        }
        const sig = _toolSig(name, args);
        roundSigs.push(sig);

        ws.send(JSON.stringify({ type: 'tool_call', id: tc.id, name, args }));

        let result;
        let ok = true;
        try { result = await execTool(name, args, session, ws); }
        catch (e) {
          ok = false;
          result = `[TOOL_RUNTIME_ERROR] ${name}: ${e && e.message || e}\n${(e && e.stack || '').split('\n').slice(0, 4).join('\n')}`;
        }
        const rstr = typeof result === 'string' ? result : JSON.stringify(result);
        if (/^\[(SCHEMA_INPUT_ERROR|WATCHDOG_HALT|TOOL_RUNTIME_ERROR|ARG_PARSE_ERROR)\]/.test(rstr)) ok = false;
        if (!ok) roundFailures++;
        try { recordToolResult(session, name, ok); } catch {}
        try { if (session._skillTurn) captureSkillSignal(session._skillTurn, name, rstr, ok); } catch {}
        // 自训练模式：收集本轮工具输出文本，供 benchmark 判据匹配
        try { if (session._benchCollect) session._benchCollect.text += `\n[${name}] ${rstr}`; } catch {}

        ws.send(JSON.stringify({ type: 'tool_result', id: tc.id, result: rstr, ok }));
        sendPhase('tool_done', `${name} 完成 (${((Date.now() - toolStart) / 1000).toFixed(1)}s)`, step, { tool: name, tool_ms: Date.now() - toolStart, ok });
        const clipped = clipForHistory(rstr);
        if (clipped.length !== rstr.length) {
          try { ws.send(JSON.stringify({ type: 'term', line: `[ctx] ${name} 返回 ${(rstr.length/1024).toFixed(1)} KB → 写回历史时裁剪到 ${(clipped.length/1024).toFixed(1)} KB（完整内容已在前端显示）` })); } catch {}
        }
        session.messages.push({ role: 'tool', tool_call_id: tc.id, name, content: clipped });
      }

      try { autoCompactIfNeeded(session, ws); } catch {}

      if (session.aborted) { fsm.state = 'aborted'; break; }
      if (session.taskComplete) { fsm.state = 'done'; sendPhase('done', '任务完成', step); break; }

      // ---------- 转移条件 2：循环/失败 → reflect ----------
      // 监控类轮询单独处理：反复查长 run/求解器状态 ≠ 卡死，绝不能催"换个思路"把正常的长 run 推倒。
      const roundNames = toolCalls.map(t => t.function?.name || '');
      const monitorOnly = roundNames.length > 0 && roundNames.every(n => MONITOR_TOOLS.has(n));
      // 循环：本轮所有 sig 与上轮完全相同
      const sigKey = roundSigs.join(';');
      let reflect = '';
      if (monitorOnly) {
        // 长 run 还在跑、agent 却在反复轮询 → 提醒收手等自动总结，而不是换方案
        fsm.monitorStreak = (fsm.monitorStreak || 0) + 1;
        fsm.repeatSig = 0; fsm.lastSig = sigKey;   // 不计入死循环判定
        const stillRunning = roundFailures === 0;
        if (fsm.monitorStreak >= 2 && stillRunning && fsm.reflections < MAX_REFLECTIONS) {
          reflect = '你在反复轮询状态——别这样。改用 `lmp_run_wait(run_id, timeout_sec)` **一次阻塞等它真正跑完**，拿到最终 verdict + thermo 再汇报/后处理。run 还在正常跑，**不要改 in.*、不要换力场/参数/构型/方案、不要重启**，耐心等完即可。';
          ws.send(JSON.stringify({ type: 'term', line: '[fsm] 反复轮询长 run 状态 → 改用 lmp_run_wait 阻塞等完（勿换方案）' }));
        }
      } else {
        fsm.monitorStreak = 0;
        if (sigKey && sigKey === fsm.lastSig) {
          fsm.repeatSig++;
        } else {
          fsm.repeatSig = 0;
          fsm.lastSig = sigKey;
        }
        if (fsm.repeatSig >= 2 && fsm.reflections < MAX_REFLECTIONS) {
          reflect = `同样参数已连续试了 3 次，换个思路试试。`;
        } else if (roundFailures >= 3 && fsm.reflections < MAX_REFLECTIONS) {
          reflect = `本轮有 ${roundFailures} 个工具报错，先看一下报错原因再决定下一步。`;
        } else {
          // 工具级熔断
          const rs = session.runState || {};
          for (const [k, v] of Object.entries(rs.failCount || {})) {
            if (v >= 3 && fsm.reflections < MAX_REFLECTIONS) { reflect = `工具 ${k} 多次失败，考虑换个思路。`; break; }
          }
        }
      }
      if (reflect) {
        fsm.reflectQueued = reflect;
        fsm.state = 'reflect';
        sendPhase('reflect', '检测到循环/失败，注入反思', step);
        // continue while loop, reflectQueued 会在下一轮 act 之前注入
      } else {
        fsm.state = 'act';
      }
    }
    if (step >= MAX_STEPS && fsm.state !== 'done' && fsm.state !== 'await_user') {
      ws.send(JSON.stringify({ type: 'term', line: `[fsm] 达到最大步数 ${MAX_STEPS}（可设 AGENT_MAX_STEPS 调整）` }));
    }
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', message: String(e && e.message || e) }));
    ws.send(JSON.stringify({ type: 'term', line: `[agent 异常] ${e && e.stack || e}` }));
  } finally {
    session.aborter = null;
    // 任务结束：沉淀领域经验。不再依赖专门的“训练模式”，改为“跑出明确成果就问用户要不要存进 skill”。
    try {
      const t = session._skillTurn;
      if (t && t.touched && !session._benchMode) {
        t.rounds = step;
        // 已激活某 skill：仍静默沉淀客观硬经验（lint 坑→修法/探针由坏转好）+ 累计统计
        if (t.active && SETTINGS.activeSkill) {
          try {
            const res = Skills.recordRun(SETTINGS.activeSkill, t);
            if (res && res.auto && res.auto.length) ws.send(JSON.stringify({ type: 'term', line: `🧠 自动沉淀 ${res.auto.length} 条客观经验：${res.auto.join(' / ')}` }));
          } catch (e) { try { ws.send(JSON.stringify({ type: 'term', line: `[skill] 记录失败 ${e.message}` })); } catch {} }
        }
        // 任务有明确成果（完整跑完 / 探针健康）→ 出“对话内沉淀卡”，让用户决定是否存为经验（可选目标/新建+设触发词）
        if (t.runCompleted || t.probeHealthy) emitDistillCard(ws, t);
        // 用户中途暂停/停止 agent（且本轮确实动过 LAMMPS 工具）→ 也出沉淀卡：把“已做的步骤/踩的坑”留作经验
        else if (session.aborted) emitDistillCard(ws, t, { stopped: true });
      }
    } catch (e) { try { ws.send(JSON.stringify({ type: 'term', line: `[skill] 沉淀异常 ${e.message}` })); } catch {} }
    sendPhase('idle', `完成 (总耗时 ${((Date.now() - runStart) / 1000).toFixed(1)}s, fsm=${fsm.state})`, 0);
    // 收尾：必发 agent_end，让前端恢复输入/发送按钮（异常、超步数、await_user 都会到这里）。
    if (!isBench) { try { ws.send(JSON.stringify({ type: 'agent_end' })); } catch {} }
  }
}

// 训练模式：把一次学习结果推给前端（自动经验 + 待确认候选）
function emitSkillLearned(ws, res) {
  if (!res) return;
  try {
    if ((res.auto && res.auto.length) || res.candidate) {
      ws.send(JSON.stringify({ type: 'skill_learned', skill: SETTINGS.activeSkill, auto: res.auto || [], candidate: res.candidate || null, health: res.health, runs: res.runs }));
    }
    if (res.auto && res.auto.length) ws.send(JSON.stringify({ type: 'term', line: `[训练] 自动沉淀 ${res.auto.length} 条经验：${res.auto.join(' / ')}` }));
    if (res.candidate) ws.send(JSON.stringify({ type: 'term', line: `[训练] 新候选待确认：${res.candidate.text}` }));
  } catch {}
}

// 任务跑出明确成果后，推一张“对话内经验沉淀卡”：用户可编辑经验文本、选存到哪个/新建 skill、填触发词。
function emitDistillCard(ws, t, opts = {}) {
  try {
    const task = String(t.taskText || '').slice(0, 80);
    const stopped = !!opts.stopped;
    const outcome = stopped ? '被手动停止（中途）' : (t.runCompleted ? '完整跑完' : (t.probeHealthy ? '探针验证健康' : '跑通'));
    const text = task
      ? (stopped ? `「${task}」中途停止 —— 已做的步骤/踩过的坑可存为经验` : `「${task}」已${outcome}，本轮做法可复用`)
      : (stopped ? `本轮中途停止 —— 已做的步骤可存为经验` : `本轮任务已${outcome}，做法可复用`);
    let triggers = [];
    try { triggers = Skills.suggestTriggersFromText(t.taskText || ''); } catch {}
    const skills = Skills.listSkills().map(k => ({ id: k.id, name: k.name }));
    ws.send(JSON.stringify({ type: 'skill_distill', text, fix: '', triggers, skills,
      activeSkill: SETTINGS.activeSkill || '', activeName: SETTINGS.activeSkillName || '',
      signals: { runCompleted: !!t.runCompleted, probeHealthy: !!t.probeHealthy, stopped } }));
  } catch {}
}

// 自训练闭环：对领域的基准集反复跑 → 按可判定判据评分 → 失败提炼"具体坑→修法" → 重跑 → 通过率曲线
// keep-or-revert（留存检验，默认开）：每轮新加的经验必须让通过率超过基线才保留，否则整批回滚。
// 与被动学习互补：被动学习从你的真实任务里顺手沉淀；自训练是主动对固定回归集刷通过率。
async function runSelfTrain(ws, session, skillId, opts = {}) {
  if (session._trainRunning) { ws.send(JSON.stringify({ type: 'term', line: '[自训练] 已在运行中' })); return; }
  const benches = Skills.listBenchmarks(skillId);
  if (!benches.length) { ws.send(JSON.stringify({ type: 'term', line: '[自训练] 该领域还没有基准任务，请先在面板里添加。' })); ws.send(JSON.stringify({ type: 'skill_train_done', skill: skillId, aborted: false, empty: true })); return; }
  const maxIters = Math.max(1, Math.min(20, parseInt(opts.iterations, 10) || 1));
  const validate = opts.validate !== false; // 默认开启 keep-or-revert
  // 续训检查点：默认接着上次最优继续；opts.fresh=true 时从头重训
  if (opts.fresh) Skills.resetTrainState(skillId);
  const tstate = Skills.getTrainState(skillId);
  const benchCountSame = (tstate.total === benches.length);
  // 续训判定：只要"基线已测过"（baselineDone 或已有累计轮次）就能续，不能再要求 cumulativeIter>0——
  // 否则在第一轮迭代跑完前就停止 → cumulativeIter 还是 0 → 续训被误判为"从头来"，把基线重测一遍（用户反馈的坑）。
  const baselineMeasured = (tstate.bestPassed != null) && (tstate.baselineDone || tstate.cumulativeIter > 0);
  const canResume = !opts.fresh && benchCountSame && baselineMeasured;
  const iterOffset = canResume ? (tstate.cumulativeIter || 0) : 0;
  session._trainRunning = true; session._trainAbort = false;
  const emitProgress = (o) => { try { ws.send(JSON.stringify({ type: 'skill_train_progress', skill: skillId, ...o })); } catch {} };
  const term = (line) => { try { ws.send(JSON.stringify({ type: 'term', line })); } catch {} };
  term(`[自训练] 开始：${benches.length} 个基准 × ${maxIters} 轮 · 留存检验=${validate ? '开' : '关'}（领域：${SETTINGS.activeSkillName || skillId}）`);
  if (canResume) term(`[自训练] ▶ 续训：从历史最优 ${tstate.bestPassed}/${benches.length}（${Math.round(tstate.bestPassed / benches.length * 100)}%）继续，已累计训练 ${iterOffset} 轮 —— **跳过基线重测**，直接往上叠。`);
  else if (!benchCountSame && tstate.cumulativeIter > 0) term('[自训练] 基准集已变化，重置检查点并重新测基线。');
  // 保存用户真实会话，自训练用隔离的临时上下文，结束后还原
  const savedMessages = session.messages;
  // 跑单个基准 → 返回 { ev, sig }
  const runOne = async (b, iterLabel, iter, idx) => {
    emitProgress({ phase: 'running', iter, maxIters, benchIndex: idx + 1, benchTotal: benches.length, benchName: b.name, label: iterLabel });
    term(`[自训练] ${iterLabel} (${idx + 1}/${benches.length})：${b.name}`);
    session.messages = [{ role: 'system', content: buildSystemPrompt(session) }]; // 干净独立上下文
    session._benchCollect = { text: '' };
    session._benchMode = true;
    session._lastAsyncRunId = null;
    try { await runAgent(ws, b.taskText, []); }
    catch (e) { term(`[自训练] 运行异常：${e.message}`); }
    // 安全网：本基准若启动了异步 run 但 agent 没等它跑完就收尾，这里阻塞补等，
    // 保证"跑到完整结束"后再评测——否则基准基于半截输出误判，正是"以为跑完其实没跑完"的根源。
    // 分段轮询并检查 _trainAbort，确保训练停止时不会被这里的等待拖住。
    if (session._lastAsyncRunId && !session._trainAbort) {
      term(`[自训练] 等待异步 run ${session._lastAsyncRunId} 跑完后再评测…`);
      const hardDeadline = Date.now() + 900000;
      while (!session._trainAbort && Date.now() < hardDeadline) {
        let fin = false;
        try { fin = await waitForRun(session._lastAsyncRunId, 2000); } catch { fin = true; }
        if (fin) break;
      }
      // 跑完后把"完整跑完"信号写回本轮 sig —— agent 没主动调 lmp_run_wait 时，
      // 评测的 run_completed 判据全靠这里补，否则会把成功的一轮误判成失败。
      try {
        const verdict = getRunVerdict(session._lastAsyncRunId);
        if (session._skillTurn) {
          if (verdict === 'ok') session._skillTurn.runCompleted = true;
          else if (verdict === 'crashed') session._skillTurn.toolFails = (session._skillTurn.toolFails || 0) + 1;
        }
        term(`[自训练] 异步 run 结束判定：${verdict}`);
      } catch { /* ignore */ }
    }
    session._lastAsyncRunId = null;
    const sig = session._skillTurn || {};
    const outText = (session._benchCollect && session._benchCollect.text) || '';
    session._benchMode = false; session._benchCollect = null;
    const ev = Skills.evalChecks(b.checks, sig, outText);
    const infoStr = ev.details.map(d => d.info).join('；');
    Skills.recordBenchmarkResult(skillId, b.id, ev.pass, infoStr);
    emitProgress({ phase: 'bench_done', iter, benchIndex: idx + 1, benchTotal: benches.length, benchName: b.name, pass: ev.pass, info: infoStr });
    term(`[自训练] └ ${ev.pass ? '✓ 通过' : '✗ 未过'}：${infoStr}`);
    return { ev, sig };
  };
  try {
    // —— 基线测评：续训时直接沿用历史最优，省掉重复测评；否则现测当前水平 ——
    let basePassed = 0; let baseRate = 0;
    if (canResume) {
      basePassed = tstate.bestPassed;
      baseRate = Math.round((basePassed / benches.length) * 100);
      term(`[自训练] 沿用历史最优基线 ${baseRate}%（${basePassed}/${benches.length}）`);
    } else {
      term('[自训练] 基线测评（不改经验，测当前水平）…');
      for (let i = 0; i < benches.length && !session._trainAbort; i++) {
        const { ev } = await runOne(benches[i], '基线', iterOffset, i);
        if (ev.pass) basePassed++;
      }
      baseRate = Math.round((basePassed / benches.length) * 100);
      Skills.recordTrainPass(skillId, { total: benches.length, passed: basePassed, iter: iterOffset });
      emitProgress({ phase: 'iter_done', iter: iterOffset, maxIters, passRate: baseRate, passed: basePassed, total: benches.length, kept: true });
      term(`[自训练] 基线通过率 ${baseRate}%（${basePassed}/${benches.length}）`);
    }
    // 持久化检查点（即使一轮没训完，下次也能从这接着来）。
    // baselineDone 仅在基线完整测完（未中途停止）时置 true —— 这样"基线跑一半被停"不会被误当成已测完。
    Skills.saveTrainState(skillId, { bestPassed: basePassed, total: benches.length, cumulativeIter: iterOffset, lastBaselineTs: Date.now(), baselineDone: !session._trainAbort });

    // —— 训练迭代：每轮试加经验，按 keep-or-revert 决定保留/回滚 ——
    for (let iter = 1; iter <= maxIters && !session._trainAbort; iter++) {
      const dispIter = iterOffset + iter; // 跨多次训练会话累计的轮次（曲线横轴持续增长）
      const snap = validate ? Skills.snapshotLessons(skillId) : null;
      let passed = 0; let learnedCount = 0; let objLearned = 0;
      for (let i = 0; i < benches.length && !session._trainAbort; i++) {
        const b = benches[i];
        const { ev, sig } = await runOne(b, `第${dispIter}轮`, dispIter, i);
        if (ev.pass) { passed++; continue; }
        // 失败 → 提炼"具体坑→修法"经验并写入（下一题/下一轮即生效）
        const specs = Skills.lessonsFromSignal(sig, ev.details);
        if (specs.length) { for (const sp of specs) { Skills.learnLesson(skillId, sp); learnedCount++; objLearned++; } }  // 客观经验=durable
        else { Skills.learnLesson(skillId, { text: `基准「${b.name}」未通过：${ev.details.filter(d => !d.ok).map(d => d.info).join('；')}`.slice(0, 280), rule: `bench:${b.id}` }); learnedCount++; }  // 兜底=投机
        session.messages[0] = { role: 'system', content: buildSystemPrompt(session) }; // 让新经验立刻进上下文
      }
      // 中途被停在本轮内：该轮未跑完，回滚投机经验（保留客观垫脚石），不计入累计轮次
      if (session._trainAbort) {
        if (validate && snap) Skills.revertSpeculative(skillId, snap);
        term(`[自训练] 本轮未跑完即停止，已回滚投机经验、保留 ${objLearned} 条客观经验（垫脚石），历史最优进度不变。`);
        break;
      }
      const rate = Math.round((passed / benches.length) * 100);
      let kept = true;
      if (validate) {
        if (passed > basePassed) { kept = true; basePassed = passed; baseRate = rate; }
        else { kept = false; Skills.revertSpeculative(skillId, snap); } // 没提升 → 回滚投机经验，但客观「坑→修法」永久保留
      } else { basePassed = passed; baseRate = rate; }
      // 记录"决策后保留的真实能力"（回滚轮维持基线，曲线诚实反映留存能力）
      Skills.recordTrainPass(skillId, { total: benches.length, passed: basePassed, iter: dispIter });
      // 持久化检查点：累计轮次 + 历史最优，下次可无缝续训
      Skills.saveTrainState(skillId, { cumulativeIter: dispIter, bestPassed: basePassed, total: benches.length });
      try { session.messages[0] = { role: 'system', content: buildSystemPrompt(session) }; } catch {}
      emitProgress({ phase: 'iter_done', iter: dispIter, maxIters, passRate: baseRate, passed: basePassed, total: benches.length, kept, attemptRate: rate, learned: learnedCount, objLearned });
      term(`[自训练] 第${dispIter}轮：试跑 ${rate}%（${passed}/${benches.length}）→ ${kept ? `✓ 保留(+${learnedCount}条经验)` : `✗ 未提升，回滚投机经验（仍留 ${objLearned} 条客观经验）`}。当前保留通过率 ${baseRate}%`);
    }
  } finally {
    session._trainRunning = false;
    const aborted = !!session._trainAbort;
    session._trainAbort = false; session._benchMode = false; session._benchCollect = null;
    // 还原用户真实会话
    try { session.messages = savedMessages; } catch {}
    const fin = Skills.getTrainState(skillId);
    const st = Skills.skillStatus(skillId);
    try { ws.send(JSON.stringify({ type: 'skill_status', status: st })); } catch {}
    ws.send(JSON.stringify({ type: 'skill_train_done', skill: skillId, aborted, cumulativeIter: fin.cumulativeIter, bestPassed: fin.bestPassed, total: fin.total }));
    if (aborted) ws.send(JSON.stringify({ type: 'term', line: `[自训练] 已中止 —— 进度已保存（累计 ${fin.cumulativeIter} 轮 · 最优 ${fin.bestPassed ?? '-'}/${fin.total}）。再次点开始即从这里续训。` }));
    else ws.send(JSON.stringify({ type: 'term', line: `[自训练] 完成 —— 累计 ${fin.cumulativeIter} 轮 · 最优 ${fin.bestPassed ?? '-'}/${fin.total}。下次点开始会接着往上叠。` }));
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const session = {
    messages: [{ role: 'system', content: SYSTEM_PROMPT_BASE(WORKSPACE) + LAMMPS_PROMPT + CASE_LIB_PROMPT }],
    checkpoints: [], currentCheckpoint: null,
    pendingEdits: [], todos: [], taskComplete: false,
    runState: { runId: null, label: '', stages: [], failCount: {}, memos: [], startedAt: 0 },
    autoMode: true,
    foamMode: !!SETTINGS.foamMode,
    mfixMode: !!SETTINGS.mfixMode,
    lbmMode:  !!SETTINGS.lbmMode,
    customMode: !!SETTINGS.customMode,
    enabledTools: new Set(DEFAULT_ENABLED),
    pendingApproval: null, aborter: null, aborted: false, currentProc: null,
    shell: null, shellCwd: WORKSPACE,
    // V4: 人在回路 — 当 agent 抛出 1)/2)/3) 编号选项且无 tool_call 时，置 true；下一条 user 消息会清零
    awaitingUserChoice: false,
    // 工具进度推送：让 visionAnalyze / readDocument / web_search 等长耗时工具能实时在前端终端可见
    _progressPub: (msg) => {
      try {
        if (ws.readyState !== 1) return;
        if (typeof msg === 'string') ws.send(JSON.stringify({ type: 'term', line: msg }));
        else if (msg && msg.type) ws.send(JSON.stringify(msg));
        else ws.send(JSON.stringify({ type: 'term', line: JSON.stringify(msg) }));
      } catch {}
    }
  };
  sessions.set(ws, session); allClients.add(ws);
  // 训练模式：连接时若已激活领域技能，注入到系统提示
  session.activeSkill = SETTINGS.activeSkill || '';
  if (session.activeSkill) { try { session.messages[0].content = buildSystemPrompt(session); } catch {} }
  ws.send(JSON.stringify({ type: 'tools_state', enabled: [...session.enabledTools], groups: TOOL_GROUPS }));
  buildTree().then(t => ws.send(JSON.stringify({ type: 'tree', tree: t }))).catch(()=>{});
  broadcastCheckpoints(ws); broadcastEdits(ws); broadcastTodos(ws);

  // —— 交互式 shell ——
  function ensureShell() {
    if (session.shell && !session.shell.killed) return session.shell;
    const sh = spawnShell(session.shellCwd);
    session.shell = sh;
    const onData = d => { d.toString().split(/\r?\n/).forEach(line => { if (line !== undefined) ws.send(JSON.stringify({ type: 'pty_out', line })); }); };
    sh.stdout.on('data', onData); sh.stderr.on('data', onData);
    sh.on('exit', (code) => { ws.send(JSON.stringify({ type: 'pty_out', line: `[shell 退出 ${code}]` })); session.shell = null; });
    ws.send(JSON.stringify({ type: 'pty_out', line: `[已启动 ${IS_WIN ? 'cmd.exe' : (process.env.SHELL || 'bash')} @ ${session.shellCwd}]` }));
    return sh;
  }

  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    const s = sessions.get(ws); if (!s) return;
    if (m.type === 'user') { s.awaitingUserChoice = false; s.messages[0] = { role: 'system', content: buildSystemPrompt(s) }; try { const sugg = Skills.matchTriggers(m.text).filter(x => x.id !== SETTINGS.activeSkill); if (sugg.length) ws.send(JSON.stringify({ type: 'skill_suggest', suggestions: sugg.slice(0, 3) })); } catch {} runAgent(ws, m.text, m.attachments || []); }
    else if (m.type === 'set_auto') s.autoMode = !!m.value;
    else if (m.type === 'nb_open') {
      const k = nbKernelStart(m.path); k.subscribers.add(ws);
      ws.send(JSON.stringify({ type: 'nb_msg', path: m.path, msg: { type: k.ready ? 'ready' : 'starting' } }));
    }
    else if (m.type === 'nb_execute') { nbKernelStart(m.path).subscribers.add(ws); nbKernelSend(m.path, { action: 'execute', code: m.code, cell_id: m.cell_id }); }
    else if (m.type === 'nb_interrupt') { nbKernelSend(m.path, { action: 'interrupt' }); }
    else if (m.type === 'nb_restart') { nbKernelSend(m.path, { action: 'restart' }); }
    else if (m.type === 'nb_close') { const k = NB_KERNELS.get(m.path); if (k) k.subscribers.delete(ws); }
    else if (m.type === 'set_tools') {
      const incoming = Array.isArray(m.tools) ? m.tools : [];
      const enabled = new Set([...TOOL_GROUPS.edit, ...incoming]);  // 编辑类始终开启
      s.enabledTools = enabled;
      ws.send(JSON.stringify({ type: 'tools_state', enabled: [...enabled] }));
    }
    // set_sim removed in v2; ParaView frame subscription is opened by set_foam/set_mfix/set_lbm when any Beta mode is enabled.
    else if (m.type === 'set_foam') {
      s.foamMode = !!m.value;
      // 同时把 foam 工具组并入启用集合（关掉时不强制移除，让用户自己取消）
      if (s.foamMode) for (const t of TOOL_GROUPS.foam) s.enabledTools.add(t);
      // ParaView 帧推送：任一 Beta 模式启用即订阅，全部关闭才取消
      if (s.foamMode || s.mfixMode || s.lbmMode) PV_STATE.subscribers.add(ws);
      else PV_STATE.subscribers.delete(ws);
      s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
      SETTINGS.foamMode = s.foamMode; await saveSettings();
      ws.send(JSON.stringify({ type: 'tools_state', enabled: [...s.enabledTools], groups: TOOL_GROUPS }));
      ws.send(JSON.stringify({ type: 'foam_state', enabled: s.foamMode, root: SETTINGS.foamRoot || '' }));
      ws.send(JSON.stringify({ type: 'term', line: `[OpenFOAM Beta ${s.foamMode ? '开启' : '关闭'}]` }));
    }
    else if (m.type === 'set_mfix') {
      s.mfixMode = !!m.value;
      if (s.mfixMode) for (const t of TOOL_GROUPS.mfix) s.enabledTools.add(t);
      if (s.foamMode || s.mfixMode || s.lbmMode) PV_STATE.subscribers.add(ws);
      else PV_STATE.subscribers.delete(ws);
      s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
      SETTINGS.mfixMode = s.mfixMode; await saveSettings();
      ws.send(JSON.stringify({ type: 'tools_state', enabled: [...s.enabledTools], groups: TOOL_GROUPS }));
      ws.send(JSON.stringify({ type: 'mfix_state', enabled: s.mfixMode, root: SETTINGS.mfixRoot || '', bash: SETTINGS.mfixBash || '' }));
      ws.send(JSON.stringify({ type: 'term', line: `[MFIX Beta ${s.mfixMode ? '开启' : '关闭'}]` }));
    }
    else if (m.type === 'set_lbm') {
      s.lbmMode = !!m.value;
      if (s.lbmMode) for (const t of TOOL_GROUPS.lbm) s.enabledTools.add(t);
      if (s.foamMode || s.mfixMode || s.lbmMode) PV_STATE.subscribers.add(ws);
      else PV_STATE.subscribers.delete(ws);
      s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
      SETTINGS.lbmMode = s.lbmMode; await saveSettings();
      ws.send(JSON.stringify({ type: 'tools_state', enabled: [...s.enabledTools], groups: TOOL_GROUPS }));
      ws.send(JSON.stringify({ type: 'lbm_state', enabled: s.lbmMode, tutorialRoot: SETTINGS.lbmTutorialRoot || '', runCmd: SETTINGS.lbmRunCmd || '' }));
      ws.send(JSON.stringify({ type: 'term', line: `[LBM Beta ${s.lbmMode ? '开启' : '关闭'}]` }));
    }
    else if (m.type === 'set_custom') {
      // 设置自定义工作流：{ enabled, name?, root?, prompt? }
      s.customMode = !!m.enabled;
      if (typeof m.name === 'string')   SETTINGS.customName   = m.name.slice(0, 200);
      if (typeof m.root === 'string')   SETTINGS.customRoot   = m.root.slice(0, 500);
      if (typeof m.prompt === 'string') SETTINGS.customPrompt = m.prompt.slice(0, 20000);
      SETTINGS.customMode = s.customMode;
      await saveSettings();
      s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
      ws.send(JSON.stringify({ type: 'custom_state', enabled: s.customMode, name: SETTINGS.customName || '', root: SETTINGS.customRoot || '', prompt: SETTINGS.customPrompt || '' }));
      const wc = (SETTINGS.customPrompt || '').length;
      ws.send(JSON.stringify({ type: 'term', line: `[自定义工作流 ${s.customMode ? '开启' : '关闭'}] ${SETTINGS.customName || '(未命名)'} · prompt ${wc} 字符` }));
    }
    // ===== 训练模式：领域技能包（按领域持续优化）=====
    else if (m.type === 'skill_list') {
      ws.send(JSON.stringify({ type: 'skill_list', skills: Skills.listSkills(), active: SETTINGS.activeSkill || '', activeName: SETTINGS.activeSkillName || '' }));
    }
    else if (m.type === 'set_skill') {
      // { id, name?, enabled }  enabled=false → 关闭训练模式（不删数据）
      const enabled = m.enabled !== false && !!m.id;
      if (enabled) {
        const sk = Skills.createSkill(m.id, m.name || m.id);
        SETTINGS.activeSkill = sk.id;
        SETTINGS.activeSkillName = sk.name;
      } else {
        SETTINGS.activeSkill = '';
        SETTINGS.activeSkillName = '';
      }
      s.activeSkill = SETTINGS.activeSkill;
      await saveSettings();
      s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
      ws.send(JSON.stringify({ type: 'skill_state', active: SETTINGS.activeSkill || '', activeName: SETTINGS.activeSkillName || '' }));
      ws.send(JSON.stringify({ type: 'skill_list', skills: Skills.listSkills(), active: SETTINGS.activeSkill || '', activeName: SETTINGS.activeSkillName || '' }));
      if (SETTINGS.activeSkill) { const st = Skills.skillStatus(SETTINGS.activeSkill); if (st) ws.send(JSON.stringify({ type: 'skill_status', status: st })); }
      ws.send(JSON.stringify({ type: 'term', line: `[训练模式 ${SETTINGS.activeSkill ? '开启：' + SETTINGS.activeSkillName : '关闭'}]` }));
    }
    else if (m.type === 'skill_status') {
      const id = m.id || SETTINGS.activeSkill;
      const st = id ? Skills.skillStatus(id) : null;
      ws.send(JSON.stringify({ type: 'skill_status', status: st }));
    }
    else if (m.type === 'skill_promote') {
      // 确认候选 → 写入正式经验。{ id?, candidateId, text? }
      const id = m.id || SETTINGS.activeSkill;
      const r = id ? Skills.promoteCandidate(id, m.candidateId, m.text) : { ok: false, msg: '未激活领域' };
      ws.send(JSON.stringify({ type: 'skill_status', status: id ? Skills.skillStatus(id) : null }));
      ws.send(JSON.stringify({ type: 'term', line: r.ok ? `[训练] 已晋升经验：${r.lesson.text}` : `[训练] 晋升失败：${r.msg}` }));
      if (id === SETTINGS.activeSkill) s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
    }
    else if (m.type === 'skill_dismiss') {
      const id = m.id || SETTINGS.activeSkill;
      if (id) Skills.dismissCandidate(id, m.candidateId);
      ws.send(JSON.stringify({ type: 'skill_status', status: id ? Skills.skillStatus(id) : null }));
    }
    else if (m.type === 'skill_add_lesson') {
      const id = m.id || SETTINGS.activeSkill;
      if (id && m.text) Skills.addLesson(id, String(m.text).slice(0, 300), String(m.fix || '').slice(0, 300));
      ws.send(JSON.stringify({ type: 'skill_status', status: id ? Skills.skillStatus(id) : null }));
      if (id === SETTINGS.activeSkill) s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
    }
    else if (m.type === 'skill_remove_lesson') {
      const id = m.id || SETTINGS.activeSkill;
      if (id && m.lessonId) Skills.removeLesson(id, m.lessonId);
      ws.send(JSON.stringify({ type: 'skill_status', status: id ? Skills.skillStatus(id) : null }));
      if (id === SETTINGS.activeSkill) s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
    }
    else if (m.type === 'skill_set_param') {
      const id = m.id || SETTINGS.activeSkill;
      if (id && m.key) Skills.setParam(id, m.key, m.value);
      ws.send(JSON.stringify({ type: 'skill_status', status: id ? Skills.skillStatus(id) : null }));
      if (id === SETTINGS.activeSkill) s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
    }
    // —— 晋升阶梯顶端：经验 → 领域硬规则 / 模板 ——
    else if (m.type === 'skill_promote_rule') {
      // { id?, lessonId, kind, pattern, msg?, fix?, severity? }
      const id = m.id || SETTINGS.activeSkill;
      const r = id ? Skills.promoteLessonToRule(id, m.lessonId, { kind: m.kind, pattern: m.pattern, msg: m.msg, fix: m.fix, severity: m.severity, name: m.name }) : { ok: false, msg: '未激活领域' };
      ws.send(JSON.stringify({ type: 'skill_status', status: id ? Skills.skillStatus(id) : null }));
      ws.send(JSON.stringify({ type: 'term', line: r.ok ? `[训练] 已升级为领域硬规则：${r.rule.msg}` : `[训练] 升级失败：${r.msg}` }));
      if (id === SETTINGS.activeSkill) s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
    }
    else if (m.type === 'skill_add_rule') {
      const id = m.id || SETTINGS.activeSkill;
      const r = id ? Skills.addLintRule(id, { name: m.name, kind: m.kind, pattern: m.pattern, msg: m.msg, fix: m.fix, severity: m.severity }) : { ok: false, msg: '未激活领域' };
      ws.send(JSON.stringify({ type: 'skill_status', status: id ? Skills.skillStatus(id) : null }));
      ws.send(JSON.stringify({ type: 'term', line: r.ok ? `[训练] 已加领域硬规则：${r.rule.msg}` : `[训练] 失败：${r.msg}` }));
      if (id === SETTINGS.activeSkill) s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
    }
    else if (m.type === 'skill_remove_rule') {
      const id = m.id || SETTINGS.activeSkill;
      if (id && m.ruleId) Skills.removeLintRule(id, m.ruleId);
      ws.send(JSON.stringify({ type: 'skill_status', status: id ? Skills.skillStatus(id) : null }));
      if (id === SETTINGS.activeSkill) s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
    }
    else if (m.type === 'skill_add_template') {
      const id = m.id || SETTINGS.activeSkill;
      if (id && m.name) Skills.addTemplate(id, String(m.name).slice(0, 80));
      ws.send(JSON.stringify({ type: 'skill_status', status: id ? Skills.skillStatus(id) : null }));
      if (id === SETTINGS.activeSkill) s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
    }
    else if (m.type === 'skill_remove_template') {
      const id = m.id || SETTINGS.activeSkill;
      if (id && m.name) Skills.removeTemplate(id, m.name);
      ws.send(JSON.stringify({ type: 'skill_status', status: id ? Skills.skillStatus(id) : null }));
      if (id === SETTINGS.activeSkill) s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
    }
    // —— 触发词：提到关键词就提示启用该 skill ——
    else if (m.type === 'skill_set_triggers') {
      const id = m.id || SETTINGS.activeSkill;
      if (id) Skills.setTriggers(id, m.triggers || []);
      ws.send(JSON.stringify({ type: 'skill_status', status: id ? Skills.skillStatus(id) : null }));
    }
    // —— 对话内经验沉淀卡：把本轮经验存进某 skill（可新建）+ 设触发词 ——
    else if (m.type === 'skill_distill_save') {
      // { skillId?, newName?, text, fix?, triggers? }
      let id = m.skillId ? Skills.safeId(m.skillId) : '';
      if (!id && m.newName && String(m.newName).trim()) { const sk = Skills.createSkill(String(m.newName).trim(), String(m.newName).trim()); id = sk.id; }
      if (!id) { ws.send(JSON.stringify({ type: 'term', line: '[经验] 未指定目标技能，已忽略' })); }
      else {
        if (m.text && String(m.text).trim()) Skills.addLesson(id, String(m.text).slice(0, 300), String(m.fix || '').slice(0, 300));
        if (Array.isArray(m.triggers) && m.triggers.length) { const cur = (Skills.loadSkill(id)?.triggers) || []; Skills.setTriggers(id, [...cur, ...m.triggers]); }
        const nm = Skills.loadSkill(id)?.name || id;
        ws.send(JSON.stringify({ type: 'skill_list', skills: Skills.listSkills(), active: SETTINGS.activeSkill || '', activeName: SETTINGS.activeSkillName || '' }));
        ws.send(JSON.stringify({ type: 'skill_status', status: Skills.skillStatus(id) }));
        ws.send(JSON.stringify({ type: 'term', line: `✅ 已把本轮经验存入「${nm}」` }));
        if (id === SETTINGS.activeSkill) s.messages[0] = { role: 'system', content: buildSystemPrompt(s) };
      }
    }
    else if (m.type === 'skill_add_benchmark') {
      const id = m.id || SETTINGS.activeSkill;
      let r = { ok: false, msg: '无效领域' };
      if (id) r = Skills.addBenchmark(id, m.bench || {});
      if (!r.ok) ws.send(JSON.stringify({ type: 'term', line: `[自训练] 添加基准失败：${r.msg}` }));
      ws.send(JSON.stringify({ type: 'skill_status', status: id ? Skills.skillStatus(id) : null }));
    }
    else if (m.type === 'skill_remove_benchmark') {
      const id = m.id || SETTINGS.activeSkill;
      if (id && m.benchId) Skills.removeBenchmark(id, m.benchId);
      ws.send(JSON.stringify({ type: 'skill_status', status: id ? Skills.skillStatus(id) : null }));
    }
    else if (m.type === 'skill_train_start') {
      const id = m.id || SETTINGS.activeSkill;
      if (!id) ws.send(JSON.stringify({ type: 'term', line: '[自训练] 请先激活一个领域' }));
      else if (s._trainRunning) ws.send(JSON.stringify({ type: 'term', line: '[自训练] 已在运行中' }));
      else { runSelfTrain(ws, s, id, { iterations: m.iterations, validate: m.validate, fresh: m.fresh }).catch(e => { try { ws.send(JSON.stringify({ type: 'term', line: '[自训练] 失败 ' + e.message })); } catch {} }); }
    }
    else if (m.type === 'skill_train_stop') {
      s._trainAbort = true;
      // 关键：不能只等"当前基准结束"——一个基准内部可能跑着完整 agent 流程（含长 run），
      // 只设 _trainAbort 会让停止拖很久。这里同时中止正在跑的那次 runAgent：置 aborted、
      // abort 掉 LLM 流、杀掉当前同步子进程，让当前基准立刻收尾，再由 _trainAbort 拦住后续基准。
      s.aborted = true;
      if (s.aborter) try { s.aborter.abort(); } catch {}
      if (s.currentProc) {
        const pid = s.currentProc.pid;
        try { s.currentProc.kill(); } catch {}
        if (IS_WIN && pid) { try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch {} }
        else if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
      ws.send(JSON.stringify({ type: 'term', line: '[自训练] 收到停止 → 立即中止当前基准并停止训练（进度已保存）' }));
    }
    else if (m.type === 'skill_delete') {
      if (m.id) {
        Skills.deleteSkill(m.id);
        if (SETTINGS.activeSkill === Skills.safeId(m.id)) { SETTINGS.activeSkill = ''; SETTINGS.activeSkillName = ''; s.activeSkill = ''; await saveSettings(); s.messages[0] = { role: 'system', content: buildSystemPrompt(s) }; }
      }
      ws.send(JSON.stringify({ type: 'skill_list', skills: Skills.listSkills(), active: SETTINGS.activeSkill || '', activeName: SETTINGS.activeSkillName || '' }));
    }
    else if (m.type === 'pty_input') { try { ensureShell().stdin.write(m.data); } catch (e) { ws.send(JSON.stringify({ type: 'pty_out', line: '[shell 错误] ' + e.message })); } }
    else if (m.type === 'pty_kill') { if (s.shell) try { s.shell.kill(); } catch {} }
    else if (m.type === 'approval' && s.pendingApproval) { const fn = s.pendingApproval; s.pendingApproval = null; fn(!!m.approved); }
    else if (m.type === 'stop') {
      s.aborted = true;
      if (s.aborter) try { s.aborter.abort(); } catch {}
      // 递归杀当前 agent 同步子进程树（run_command 等）。
      // ⚠ 重要边界：仅杀 s.currentProc，不动 SOLVER_RUNS — 那是用户显式启的后台求解，
      // 必须靠 foam_solver_stop / mfix_solver_stop / lbm_solver_stop 或面板按钮单独控制，
      // 不能让"停止 agent"误杀正在跑的 OpenFOAM/MFIX/LBM 仿真。
      if (s.currentProc) {
        const pid = s.currentProc.pid;
        try { s.currentProc.kill(); } catch {}
        if (IS_WIN && pid) {
          try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch {}
        } else if (pid) {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
      }
      if (s.pendingApproval) { const fn = s.pendingApproval; s.pendingApproval = null; fn(false); }
      const liveRuns = [...SOLVER_RUNS.values()].filter(r => !r.ended).length;
      const tail = liveRuns ? `（${liveRuns} 个后台求解器未受影响，仍在跑；如要停请在面板/工具里单独 stop）` : '';
      ws.send(JSON.stringify({ type: 'term', line: `[Agent 已停止]${tail}` }));
      ws.send(JSON.stringify({ type: 'agent_end' }));
    } else if (m.type === 'kill_all') {
      // v0.7.0: 强行终止 —— 杀光所有受 Mdriver 管控的子进程
      // 包括：当前 agent 同步进程、所有 SOLVER_RUNS（OpenFOAM/MFIX/LBM 异步求解）、ParaView、pty shell
      s.aborted = true;
      if (s.aborter) try { s.aborter.abort(); } catch {}
      const killTree = (pid) => {
        if (!pid) return;
        if (IS_WIN) {
          try { spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); } catch {}
        } else {
          try { process.kill(-pid, 'SIGKILL'); } catch {}
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
      };
      let killedCount = 0;
      // 1) 当前 agent 子进程
      if (s.currentProc && !s.currentProc.killed) {
        try { s.currentProc.kill(); } catch {}
        killTree(s.currentProc.pid);
        killedCount++;
      }
      // 2) 所有未结束的后台求解器
      for (const run of SOLVER_RUNS.values()) {
        if (run.ended) continue;
        try { run.proc.kill('SIGTERM'); } catch {}
        killTree(run.proc && run.proc.pid);
        setTimeout(() => { try { if (run.proc && !run.proc.killed) run.proc.kill('SIGKILL'); } catch {} }, 1500);
        run.ended = Date.now(); run.exitCode = run.exitCode == null ? -9 : run.exitCode;
        for (const sub of run.subs) if (sub.readyState === 1) {
          try { sub.send(JSON.stringify({ type: 'solver_done', runId: run.runId, exitCode: -9 })); } catch {}
        }
        killedCount++;
      }
      // 3) ParaView
      try { if (typeof killParaView === 'function') killParaView(); } catch {}
      // 4) pty shell（用户终端）
      if (s.shell && !s.shell.killed) { try { s.shell.kill(); } catch {} killedCount++; }
      if (s.pendingApproval) { const fn = s.pendingApproval; s.pendingApproval = null; fn(false); }
      ws.send(JSON.stringify({ type: 'term', line: `[强行终止] 已杀 ${killedCount} 个进程（含后台求解器、ParaView、shell）` }));
      ws.send(JSON.stringify({ type: 'agent_end' }));
    } else if (m.type === 'reset') {
      s.messages = [{ role: 'system', content: buildSystemPrompt(s) }];
      s.checkpoints = []; s.pendingEdits = []; s.todos = []; s.taskComplete = false;
      ws.send(JSON.stringify({ type: 'reset_done' }));
      broadcastCheckpoints(ws); broadcastEdits(ws); broadcastTodos(ws);
    } else if (m.type === 'compact') {
      try {
        const before = s.messages.length;
        // 保留 system + 最近 6 条；把中间用一段总结替代
        if (before > 10) {
          const sys = s.messages[0];
          const tail = s.messages.slice(-6);
          const middle = s.messages.slice(1, -6);
          const summary = middle.map(x => {
            if (x.role === 'user') return `[\u7528\u6237] ${(x.content || '').toString().slice(0, 200)}`;
            if (x.role === 'assistant') return `[\u52a9\u624b] ${(x.content || '').toString().slice(0, 300)}` + (x.tool_calls ? ` (\u8c03\u7528 ${x.tool_calls.map(t => t.function?.name).join(',')})` : '');
            if (x.role === 'tool') return `[\u5de5\u5177\u8fd4\u56de] ${String(x.content || '').slice(0, 200)}`;
            return '';
          }).filter(Boolean).join('\n');
          s.messages = [sys, { role: 'user', content: '\u4ee5\u4e0b\u662f\u4e4b\u524d\u4f1a\u8bdd\u7684\u538b\u7f29\u603b\u7ed3\uff1a\n' + summary }, ...tail];
        }
        ws.send(JSON.stringify({ type: 'term', line: `[\u5df2\u538b\u7f29\u4e0a\u4e0b\u6587\uff1a${before} \u2192 ${s.messages.length} \u6761\u6d88\u606f]` }));
      } catch (e) { ws.send(JSON.stringify({ type: 'error', message: '\u538b\u7f29\u5931\u8d25\uff1a' + e.message })); }
    } else if (m.type === 'restore_checkpoint') {
      try { const n = await restoreCheckpoint(s, m.id);
        ws.send(JSON.stringify({ type: 'term', line: `[已回滚 ${n} 个文件]` }));
        broadcastCheckpoints(ws); broadcastEdits(ws); broadcastTree();
      } catch (e) { ws.send(JSON.stringify({ type: 'error', message: '回滚失败：' + e.message })); }
    } else if (m.type === 'keep_edit') { try { keepEdit(s, m.id); broadcastEdits(ws); } catch (e) { ws.send(JSON.stringify({ type: 'error', message: e.message })); } }
    else if (m.type === 'undo_edit') { try { const e = await undoEdit(s, m.id); ws.send(JSON.stringify({ type: 'term', line: `[已撤销 ${e.path}]` })); broadcastEdits(ws); broadcastTree(); } catch (err) { ws.send(JSON.stringify({ type: 'error', message: '撤销失败：' + err.message })); } }
    else if (m.type === 'keep_all') { s.pendingEdits = []; broadcastEdits(ws); }
    else if (m.type === 'undo_all') {
      const ids = s.pendingEdits.map(e => e.id);
      for (const id of ids) { try { await undoEdit(s, id); } catch {} }
      broadcastEdits(ws); broadcastTree();
      ws.send(JSON.stringify({ type: 'term', line: `[已撤销全部待审编辑]` }));
    }
  });
  ws.on('close', () => {
    if (session.shell) try { session.shell.kill(); } catch {}
    PV_STATE.subscribers.delete(ws);
    // 从所有求解器订阅集合中移除，避免向已关闭 socket 推送
    for (const run of SOLVER_RUNS.values()) run.subs.delete(ws);
    // 中断进行中的审批/agent 循环，防止内存悬挂
    if (session.pendingApproval) { try { session.pendingApproval(false); } catch {} session.pendingApproval = null; }
    if (session.aborter) { try { session.aborter.abort(); } catch {} }
    session.aborted = true;
    sessions.delete(ws); allClients.delete(ws);
  });
});

// v0.7.4 全局兜底：把静默崩溃暴露出来，避免 agent 神秘停掉
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  console.error('[unhandledRejection]', msg);
  try { for (const ws of allClients || []) ws.send(JSON.stringify({ type: 'term', line: `[诊断·unhandledRejection] ${String(reason && reason.message || reason)}` })); } catch {}
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack || err);
  try { for (const ws of allClients || []) ws.send(JSON.stringify({ type: 'term', line: `[诊断·uncaughtException] ${String(err && err.message || err)}` })); } catch {}
});

// ====================== web / paper / vision / download 实现 ======================
// 历史上仅声明了 schema 与 dispatch，未实现实际函数。这里一次性补齐，避免运行期 "X is not defined"。
const _UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
function _stripHtml(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t\r]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
async function _safeFetch(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': _UA, ...(opts.headers || {}) } });
  } finally { clearTimeout(tm); }
}

async function webSearch(query, topK = 6, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return '[err] 空查询';
  const progress = opts.progress || (() => {});
  // 优先级：Tavily → Serper → Brave → SearXNG → DDG HTML → Bing → Baidu
  try {
    if (process.env.TAVILY_API_KEY) {
      progress(`[web_search] Tavily: ${q}`);
      const r = await _safeFetch('https://api.tavily.com/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: q, max_results: topK, topic: opts.topic || 'general', time_range: opts.time_range, include_answer: opts.include_answer !== false }),
      });
      const j = await r.json();
      const lines = [];
      if (j.answer) lines.push(`【Tavily 摘要】${j.answer}\n`);
      for (const it of (j.results || []).slice(0, topK)) lines.push(`• ${it.title}\n  ${it.url}\n  ${(it.content || '').slice(0, 300)}`);
      return lines.join('\n\n') || '[web_search] Tavily 无结果';
    }
    if (process.env.SERPER_API_KEY) {
      progress(`[web_search] Serper: ${q}`);
      const r = await _safeFetch('https://google.serper.dev/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-KEY': process.env.SERPER_API_KEY },
        body: JSON.stringify({ q, num: topK }),
      });
      const j = await r.json();
      const items = (j.organic || []).slice(0, topK).map(it => `• ${it.title}\n  ${it.link}\n  ${it.snippet || ''}`);
      return items.join('\n\n') || '[web_search] Serper 无结果';
    }
    if (process.env.BRAVE_API_KEY) {
      progress(`[web_search] Brave: ${q}`);
      const r = await _safeFetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${topK}`, { headers: { 'X-Subscription-Token': process.env.BRAVE_API_KEY, Accept: 'application/json' } });
      const j = await r.json();
      const items = ((j.web && j.web.results) || []).slice(0, topK).map(it => `• ${it.title}\n  ${it.url}\n  ${_stripHtml(it.description || '').slice(0, 280)}`);
      return items.join('\n\n') || '[web_search] Brave 无结果';
    }
    if (process.env.SEARXNG_URL) {
      progress(`[web_search] SearXNG: ${q}`);
      const r = await _safeFetch(`${process.env.SEARXNG_URL.replace(/\/$/, '')}/search?q=${encodeURIComponent(q)}&format=json&safesearch=0`);
      const j = await r.json();
      const items = (j.results || []).slice(0, topK).map(it => `• ${it.title}\n  ${it.url}\n  ${(it.content || '').slice(0, 280)}`);
      return items.join('\n\n') || '[web_search] SearXNG 无结果';
    }
  } catch (e) { progress(`[web_search] 上游失败 → 回退 HTML 爬取：${e.message}`); }
  // HTML 兜底
  const tries = [
    { name: 'DuckDuckGo', url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: html => {
      const out = [];
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let m; while ((m = re.exec(html)) && out.length < topK) {
        let href = m[1]; const uddg = href.match(/uddg=([^&]+)/); if (uddg) try { href = decodeURIComponent(uddg[1]); } catch {}
        out.push(`• ${_stripHtml(m[2])}\n  ${href}\n  ${_stripHtml(m[3]).slice(0, 280)}`);
      } return out;
    } },
    { name: 'Bing', url: `https://www.bing.com/search?q=${encodeURIComponent(q)}&cc=us`, parse: html => {
      const out = [];
      const re = /<li class="b_algo"[^>]*>[\s\S]*?<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;
      let m; while ((m = re.exec(html)) && out.length < topK) out.push(`• ${_stripHtml(m[2])}\n  ${m[1]}\n  ${_stripHtml(m[3]).slice(0, 280)}`);
      return out;
    } },
  ];
  for (const t of tries) {
    try {
      progress(`[web_search] ${t.name} HTML: ${q}`);
      const r = await _safeFetch(t.url);
      const html = await r.text();
      const out = t.parse(html);
      if (out.length) return `【${t.name}】\n` + out.join('\n\n');
    } catch (e) { progress(`[web_search] ${t.name} 失败：${e.message}`); }
  }
  return '[web_search] 所有上游均失败。建议：(1) 设置 TAVILY_API_KEY；(2) 改用 paper_search 找文献；(3) lmp_doc_lookup 查 LAMMPS 文档。';
}

async function fetchUrlText(url, maxChars = 6000, withImages = true, progress) {
  progress && progress(`[fetch_url] ${url}`);
  try {
    const r = await _safeFetch(url, {}, 20000);
    const ct = r.headers.get('content-type') || '';
    if (/application\/pdf/i.test(ct) || /\.pdf(\?|$)/i.test(url)) {
      const buf = Buffer.from(await r.arrayBuffer());
      const dl = path.join(WORKSPACE, '.cache', 'fetched');
      fssync.mkdirSync(dl, { recursive: true });
      const fp = path.join(dl, `fetch_${Date.now().toString(36)}.pdf`);
      fssync.writeFileSync(fp, buf);
      return `[fetch_url] 已保存 PDF → ${path.relative(WORKSPACE, fp)}（${(buf.length/1024).toFixed(1)} KB）\n建议：read_paper("${path.relative(WORKSPACE, fp)}")`;
    }
    const html = await r.text();
    const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleM ? _stripHtml(titleM[1]) : '';
    const body = _stripHtml(html);
    const trimmed = body.length > maxChars ? body.slice(0, maxChars) + `\n...[已截断，原文 ${body.length} 字符]` : body;
    let images = '';
    if (withImages) {
      const imgs = [...html.matchAll(/<img[^>]+src="([^"]+)"/gi)].map(m => m[1]).filter(s => /^https?:/i.test(s)).slice(0, 10);
      if (imgs.length) images = '\n\n[页面图片]\n' + imgs.map(u => '  ' + u).join('\n');
    }
    return `[fetch_url] ${url}\n标题：${title}\n\n${trimmed}${images}`;
  } catch (e) { return `[fetch_url 失败] ${url}\n${e.message}`; }
}

async function paperSearch(query, opts = {}) {
  const q = String(query || '').trim();
  const topK = opts.topK || 8;
  const progress = opts.progress || (() => {});
  const yearFilter = opts.year || '';
  // Semantic Scholar
  const items = [];
  try {
    progress(`[paper_search] Semantic Scholar: ${q}`);
    const headers = { Accept: 'application/json' };
    if (process.env.SEMANTIC_SCHOLAR_API_KEY) headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;
    let url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${Math.min(50, topK * 2)}&fields=title,authors,year,venue,citationCount,abstract,externalIds,openAccessPdf,isOpenAccess`;
    if (yearFilter) url += `&year=${encodeURIComponent(yearFilter)}`;
    if (opts.fieldsOfStudy) url += `&fieldsOfStudy=${encodeURIComponent(opts.fieldsOfStudy)}`;
    const r = await _safeFetch(url, { headers }, 20000);
    const j = await r.json();
    for (const it of (j.data || [])) {
      if (opts.openAccessOnly && !(it.openAccessPdf && it.openAccessPdf.url)) continue;
      items.push({
        source: 'S2', id: (it.externalIds && (it.externalIds.DOI || it.externalIds.ArXiv)) || it.paperId,
        title: it.title, authors: (it.authors || []).map(a => a.name).slice(0, 6).join(', '),
        year: it.year, venue: it.venue, citationCount: it.citationCount || 0,
        abstract: it.abstract || '', pdf: (it.openAccessPdf && it.openAccessPdf.url) || '',
      });
    }
  } catch (e) { progress(`[paper_search] S2 失败：${e.message}`); }
  // arXiv
  try {
    progress(`[paper_search] arXiv: ${q}`);
    const r = await _safeFetch(`http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&start=0&max_results=${topK}`, {}, 20000);
    const xml = await r.text();
    const re = /<entry>([\s\S]*?)<\/entry>/g;
    let m;
    while ((m = re.exec(xml))) {
      const e = m[1];
      const get = (tag) => { const mm = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return mm ? _stripHtml(mm[1]).trim() : ''; };
      const id = (e.match(/<id>([^<]+)<\/id>/) || ['', ''])[1];
      const arxivId = id.split('/abs/')[1] || '';
      items.push({
        source: 'arXiv', id: arxivId, title: get('title'),
        authors: [...e.matchAll(/<name>([^<]+)<\/name>/g)].map(x => x[1]).slice(0, 6).join(', '),
        year: ((e.match(/<published>(\d{4})/) || [])[1]) || '',
        venue: 'arXiv', citationCount: 0, abstract: get('summary'),
        pdf: id ? id.replace('/abs/', '/pdf/') + '.pdf' : '',
      });
    }
  } catch (e) { progress(`[paper_search] arXiv 失败：${e.message}`); }
  // 去重 + 排序
  const seen = new Set();
  const dedup = items.filter(it => {
    const key = (it.id || it.title || '').toLowerCase().replace(/\W+/g, '');
    if (seen.has(key)) return false; seen.add(key); return true;
  }).sort((a, b) => (b.citationCount || 0) - (a.citationCount || 0) || (parseInt(b.year || 0) - parseInt(a.year || 0)));
  const top = dedup.slice(0, topK);
  if (!top.length) return `[paper_search] 无结果。建议改 query 或加 year=2018-2025`;
  return top.map((it, i) => `${i + 1}. [${it.source}] ${it.title}\n   作者: ${it.authors}\n   ${it.year} · ${it.venue || ''} · 引用 ${it.citationCount}\n   id: ${it.id}\n   pdf: ${it.pdf || '(无开放 PDF)'}\n   ${(it.abstract || '').slice(0, 280).replace(/\s+/g, ' ')}`).join('\n\n');
}

async function paperFetch(id, opts = {}) {
  const progress = opts.progress || (() => {});
  if (!id) return '[err] 缺少 id（DOI 或 arXivId）';
  // arXiv id 直接走 PDF
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(id)) {
    const pdfUrl = `https://arxiv.org/pdf/${id}.pdf`;
    if (opts.download) {
      const r = await _safeFetch(pdfUrl, {}, 30000);
      const buf = Buffer.from(await r.arrayBuffer());
      const dl = path.join(WORKSPACE, 'papers'); fssync.mkdirSync(dl, { recursive: true });
      const fp = path.join(dl, `arxiv_${id.replace(/[^\w.]/g, '_')}.pdf`);
      fssync.writeFileSync(fp, buf);
      return `[paper_fetch] 已下载 → ${path.relative(WORKSPACE, fp)}（${(buf.length/1024).toFixed(1)} KB）\n下一步：read_paper("${path.relative(WORKSPACE, fp)}")`;
    }
    return `[paper_fetch] arXiv ${id}\nPDF: ${pdfUrl}\n（如需下载，传 download=true）`;
  }
  // 否则 Semantic Scholar
  try {
    progress(`[paper_fetch] S2: ${id}`);
    const headers = { Accept: 'application/json' };
    if (process.env.SEMANTIC_SCHOLAR_API_KEY) headers['x-api-key'] = process.env.SEMANTIC_SCHOLAR_API_KEY;
    const r = await _safeFetch(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(id)}?fields=title,authors,year,venue,citationCount,abstract,openAccessPdf,references.title,references.year,references.authors`, { headers }, 20000);
    const it = await r.json();
    if (it.error) return `[paper_fetch] S2 错误：${it.error}`;
    const refs = (it.references || []).slice(0, opts.maxRefs || 30).map((r, i) => `  ${i + 1}. ${r.title} (${r.year || '?'})`).join('\n');
    let out = `[paper_fetch] ${it.title}\n作者: ${(it.authors || []).map(a => a.name).join(', ')}\n${it.year} · ${it.venue || ''} · 引用 ${it.citationCount || 0}\nPDF: ${(it.openAccessPdf && it.openAccessPdf.url) || '(无开放 PDF)'}\n\n摘要：${it.abstract || '(无)'}\n\n参考文献 (${(it.references || []).length} 条，前 ${opts.maxRefs || 30})：\n${refs}`;
    if (opts.download && it.openAccessPdf && it.openAccessPdf.url) {
      const rr = await _safeFetch(it.openAccessPdf.url, {}, 30000);
      const buf = Buffer.from(await rr.arrayBuffer());
      const dl = path.join(WORKSPACE, 'papers'); fssync.mkdirSync(dl, { recursive: true });
      const fp = path.join(dl, `s2_${id.replace(/[^\w.]/g, '_')}.pdf`);
      fssync.writeFileSync(fp, buf);
      out += `\n\n已下载 → ${path.relative(WORKSPACE, fp)}`;
    }
    return out;
  } catch (e) { return `[paper_fetch 失败] ${e.message}`; }
}

async function imageSearch(query, topK = 12) {
  const q = String(query || '').trim();
  try {
    const r = await _safeFetch(`https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`);
    const html = await r.text();
    const tokenM = html.match(/vqd=['"]?([\d-]+)['"]?/);
    if (!tokenM) return [];
    const j = await _safeFetch(`https://duckduckgo.com/i.js?q=${encodeURIComponent(q)}&o=json&vqd=${tokenM[1]}`, { headers: { Referer: 'https://duckduckgo.com/' } });
    const data = await j.json();
    return (data.results || []).slice(0, topK).map(it => ({ title: it.title, url: it.image, thumbnail: it.thumbnail, source: it.url }));
  } catch { return []; }
}

async function downloadFile(url, saveAs) {
  if (!url) return '[err] 缺少 url';
  try {
    const r = await _safeFetch(url, {}, 60000);
    const buf = Buffer.from(await r.arrayBuffer());
    const rel = saveAs || `downloads/dl_${Date.now().toString(36)}`;
    const abs = path.isAbsolute(rel) ? rel : path.join(WORKSPACE, rel);
    fssync.mkdirSync(path.dirname(abs), { recursive: true });
    fssync.writeFileSync(abs, buf);
    return `[download_file] ${url}\n  → ${path.relative(WORKSPACE, abs)} (${(buf.length/1024).toFixed(1)} KB)`;
  } catch (e) { return `[download_file 失败] ${e.message}`; }
}

// visionAnalyze（流式 + 心跳）：
//   options.detail: 'high'|'low'（默认 high；fallback/批量 OCR 走 low 快 3~5×）
//   progress(string|{type,...})：每 3s 心跳 + 每个 SSE chunk 实时推送（前端能看到字逐个吐）
async function visionAnalyze(images, question, maxTokens = 1500, progress, options = {}) {
  if (!images || !images.length) return '[vision_analyze] 无输入图片';
  const imgArr = Array.isArray(images) ? images : [images];
  const base = (SETTINGS.visionBaseUrl || SETTINGS.baseUrl || 'https://api.siliconflow.cn').replace(/\/$/, '');
  const key = SETTINGS.visionApiKey || SETTINGS.apiKey;
  const model = SETTINGS.visionModel || 'Pro/moonshotai/Kimi-K2.6';
  const detail = options.detail || 'high';
  const pub = typeof progress === 'function' ? progress : () => {};
  if (!key) return '[vision_analyze] 未配置 API Key（visionApiKey 或 apiKey）';
  const py = SETTINGS.pythonPath || (process.platform === 'win32' ? 'python' : 'python3');
  const normalizer = path.join(__dirname, 'img_normalize.py');
  const normalizeLocal = async (absPath) => {
    if (!fssync.existsSync(normalizer)) return null;
    return new Promise(resolve => {
      const tmpOut = path.join(path.dirname(absPath), `.norm_${Date.now().toString(36)}_${path.basename(absPath, path.extname(absPath))}.jpg`);
      const env = { ...process.env };
      if (detail === 'low') { env.IMG_MAX_SIDE = env.IMG_MAX_SIDE || '1024'; env.IMG_JPEG_QUALITY = env.IMG_JPEG_QUALITY || '78'; }
      const proc = spawn(py, [normalizer, absPath, tmpOut], { windowsHide: true, env });
      proc.stderr.on('data', () => {});
      proc.on('error', () => resolve(null));
      proc.on('close', code => resolve(code === 0 && fssync.existsSync(tmpOut) ? tmpOut : null));
    });
  };
  const content = [{ type: 'text', text: question || '请详细描述图片并提取所有文字内容（含公式用 LaTeX）。' }];
  const _cleanup = [];
  for (const img of imgArr.slice(0, 6)) {
    let url = img;
    if (!/^(https?:|data:)/i.test(img)) {
      const abs = path.isAbsolute(img) ? img : path.join(WORKSPACE, img);
      if (!fssync.existsSync(abs)) { content.push({ type: 'text', text: `[图片不存在: ${img}]` }); continue; }
      let bytesPath = abs, mime = 'png';
      const normalized = await normalizeLocal(abs);
      if (normalized) { bytesPath = normalized; mime = 'jpeg'; _cleanup.push(normalized); }
      else {
        const ext = (path.extname(abs).slice(1) || 'png').toLowerCase();
        mime = ext === 'jpg' ? 'jpeg' : ext;
      }
      const buf = fssync.readFileSync(bytesPath);
      url = `data:image/${mime};base64,${buf.toString('base64')}`;
    }
    content.push({ type: 'image_url', image_url: { url, detail } });
  }
  const startTs = Date.now();
  pub(`[vision_analyze] ${model} · ${imgArr.length} 图 · detail=${detail} · 已发送，等首 token …`);
  // 3s 心跳 ticker，让前端不再"卡住"
  let ticker = setInterval(() => {
    const sec = ((Date.now() - startTs) / 1000).toFixed(0);
    pub({ type: 'agent_phase', phase: 'tool_exec', detail: `vision_analyze 等待 ${sec}s（${model}）`, tool: 'vision_analyze' });
    pub(`[vision_analyze] … 等待 ${sec}s`);
  }, 3000);
  const cleanupTicker = () => { if (ticker) { clearInterval(ticker); ticker = null; } };

  // 真正调用：stream:true → SSE 实时推送增量
  let r, lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      r = await _safeFetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: maxTokens, temperature: 0.2, stream: true }),
      }, 180000);
      if (!r.ok) {
        if (r.status >= 500 && attempt === 1) {
          lastErr = new Error('vision 上游 ' + r.status);
          pub(`[vision_analyze] 5xx 重试 1/1`);
          await new Promise(rs => setTimeout(rs, 1500));
          continue;
        }
        // 4xx → 读非流响应文本报错
        const errText = await r.text();
        cleanupTicker();
        for (const p of _cleanup) { try { fssync.unlinkSync(p); } catch {} }
        return `[vision_analyze 失败] 上游 HTTP ${r.status}: ${errText.slice(0, 400)}\n（已尝试本地 PIL 规范化为 JPEG；若仍失败请到设置改 visionModel）`;
      }
      break;
    } catch (e) {
      lastErr = e;
      const msg = String(e && e.message || e);
      if (attempt === 1 && /timeout|aborted|ECONN|ENET|fetch failed|socket hang up/i.test(msg)) {
        pub(`[vision_analyze] 网络异常重试 1/1: ${msg.slice(0,120)}`);
        await new Promise(rs => setTimeout(rs, 1500));
        continue;
      }
      cleanupTicker();
      for (const p of _cleanup) { try { fssync.unlinkSync(p); } catch {} }
      return `[vision_analyze 失败] ${msg}`;
    }
  }

  // 消费 SSE 流，按 chunk 推送到前端
  let full = '';
  let firstTokenMs = 0;
  try {
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const jj = JSON.parse(data);
          // 上游错误（SiliconFlow 把 {code,message} 也塞到流里）
          if (jj.error || jj.code) {
            const m = (jj.error && (jj.error.message || JSON.stringify(jj.error))) || jj.message || JSON.stringify(jj);
            cleanupTicker();
            for (const p of _cleanup) { try { fssync.unlinkSync(p); } catch {} }
            return `[vision_analyze 失败] 上游错误：${m}\n（已尝试 PIL 规范化）`;
          }
          const delta = jj.choices?.[0]?.delta?.content;
          if (delta) {
            if (!firstTokenMs) {
              firstTokenMs = Date.now() - startTs;
              cleanupTicker();
              pub(`[vision_analyze] 首 token ${firstTokenMs}ms，开始输出 …`);
            }
            full += delta;
            // 把片段推到前端（前端会聚合到 tool 详情面板）
            pub({ type: 'tool_stream', tool: 'vision_analyze', text: delta });
          }
        } catch {}
      }
    }
  } catch (e) {
    cleanupTicker();
    for (const p of _cleanup) { try { fssync.unlinkSync(p); } catch {} }
    if (full) return `[vision_analyze · ${model} · 流中断]\n${full}\n\n[err] 流读取异常：${e.message}`;
    return `[vision_analyze 失败] 流读取异常：${e.message}`;
  } finally {
    cleanupTicker();
    for (const p of _cleanup) { try { fssync.unlinkSync(p); } catch {} }
  }
  const totalMs = Date.now() - startTs;
  pub(`[vision_analyze] 完成 · 首token=${firstTokenMs}ms · 总耗时=${totalMs}ms · ${full.length}字`);
  return full ? `[vision_analyze · ${model}]\n${full}` : `[vision_analyze] 空响应（${totalMs}ms）`;
}

async function readDocument(p, progress) {
  if (!p) return '[err] 缺少 path';
  const abs = path.isAbsolute(p) ? p : path.join(WORKSPACE, p);
  if (!fssync.existsSync(abs)) return `[err] 文件不存在：${abs}`;
  const py = SETTINGS.pythonPath || (process.platform === 'win32' ? 'python' : 'python3');
  const script = path.join(__dirname, 'doc_reader.py');
  if (!fssync.existsSync(script)) return '[err] doc_reader.py 不存在';
  const safeBase = path.basename(abs).replace(/[^\w.\-]+/g, '_').slice(0, 80);
  // 以 mtime+size 作缓存 key，同一 PDF 重复读直接返回缓存（含图片清单）
  const st = fssync.statSync(abs);
  const cacheKey = `${st.mtimeMs.toString(36)}_${st.size.toString(36)}`;
  const cacheDir = path.join(WORKSPACE, '.cache', 'pdf_images', `${safeBase}_${cacheKey}`);
  const cacheText = path.join(cacheDir, 'result.txt');
  if (fssync.existsSync(cacheText)) {
    progress && progress(`[read_document] cache hit: ${path.basename(abs)}`);
    try { return fssync.readFileSync(cacheText, 'utf8'); } catch {}
  }
  progress && progress(`[read_document] ${path.basename(abs)} → 解析+渲染（首次会慢，后续走缓存）`);
  fssync.mkdirSync(cacheDir, { recursive: true });
  return await new Promise(resolve => {
    const proc = spawn(py, [script, abs], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PDF_IMG_OUT_DIR: cacheDir } });
    let buf = '', err = '';
    proc.stdout.on('data', d => { buf += d.toString('utf8'); });
    proc.stderr.on('data', d => { err += d.toString('utf8'); });
    proc.on('error', e => resolve(`[read_document 调用 Python 失败] ${e.message}`));
    proc.on('close', () => {
      let parsed = null; try { parsed = JSON.parse(buf); } catch {}
      if (!parsed || !parsed.ok) return resolve(`[read_document 解析失败] ${err.slice(-400) || buf.slice(-400)}`);
      const head = `[${parsed.kind || 'doc'} · ${parsed.pages || '?'} 页] ${path.basename(abs)}`;
      const imgList = (parsed.images || []).slice(0, 30).map(im => `  - ${im.kind || 'img'} p${im.page || '?'}: ${im.path}`).join('\n');
      const tail = parsed.images && parsed.images.length ? `\n\n--- 提取的图片（${parsed.images.length} 张，前 30 路径） ---\n${imgList}\n（可传给 vision_analyze）` : '';
      const result = `${head}\n${parsed.text || ''}${tail}`;
      try { fssync.writeFileSync(cacheText, result, 'utf8'); } catch {}
      resolve(result);
    });
  });
}

async function readPaper(p, focus, progress) {
  const base = await readDocument(p, progress);
  if (/^\[err\]|^\[read_document/.test(base)) return base;
  // 章节切分（按常见标题）+ focus 抽取
  const text = base.replace(/^\[[^\]]*\][^\n]*\n?/, '');
  const sections = {};
  const secNames = ['Abstract', 'Introduction', 'Method', 'Methods', 'Approach', 'Experiment', 'Experiments', 'Result', 'Results', 'Discussion', 'Conclusion', 'References', 'Related Work'];
  const idx = secNames.map(s => ({ s, i: text.search(new RegExp(`(^|\\n)\\s*\\d?\\.?\\s*${s}\\b`, 'i')) })).filter(x => x.i >= 0).sort((a, b) => a.i - b.i);
  for (let k = 0; k < idx.length; k++) {
    const cur = idx[k], next = idx[k + 1];
    sections[cur.s] = text.slice(cur.i, next ? next.i : Math.min(text.length, cur.i + 4000)).trim().slice(0, 2500);
  }
  const focusHit = focus ? text.match(new RegExp(`[^.\\n]*${focus.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^.\\n]*\\.`, 'gi')) : null;
  const head = base.split('\n')[0];
  const summary = ['Abstract', 'Introduction', 'Method', 'Methods', 'Results', 'Conclusion'].map(s => sections[s] ? `\n=== ${s} ===\n${sections[s]}` : '').filter(Boolean).join('\n');
  return `${head}\n${summary || text.slice(0, 4000)}${focusHit ? `\n\n=== 与 focus="${focus}" 相关句 ===\n${focusHit.slice(0, 20).join('\n')}` : ''}`;
}
// ====================== /web/paper/vision 实现结束 ======================

// ====================== paper_extract_params ======================
// 把 read_document 全文 + 关键页 VLM 识图 + 正则规则三路合并，输出结构化 MD 参数清单。
async function paperExtractParams(p, toUnits, maxPagesVlm = 6, progress) {
  if (!p) return '[err] 缺少 path';
  progress && progress(`[paper_extract_params] ${p} → units=${toUnits || '(不换算)'}`);
  // 1) 跑 readDocument 拿全文 + 页面图清单
  const raw = await readDocument(p, progress);
  if (/^\[err\]|^\[read_document 解析失败/.test(raw)) return raw;
  const headM = raw.match(/^\[([^\]]+)\]\s*([^\n]+)/);
  const text = raw.replace(/^\[[^\]]*\][^\n]*\n?/, '').split('\n--- 提取的图片')[0] || '';
  const imgBlock = (raw.split('\n--- 提取的图片')[1] || '');
  const pageImages = [...imgBlock.matchAll(/[-•]\s+(?:scan_)?(?:page|img)[^:]*:\s*(\S+)/g)].map(m => m[1]).filter(Boolean);

  // 2) 正则扫文本：常见 MD 参数模式
  // 形如 "T = 300 K", "ρ = 0.85 g/cm3", "Δt = 1 fs", "Lx = 40 Å", "N = 512 atoms", "ε/kB = 120 K", "σ = 3.405 Å", "cutoff = 12 Å"
  const NUM = `(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`;
  const UNIT = `(K|eV|meV|kcal\\s*/\\s*mol|kJ\\s*/\\s*mol|J|Hartree|Ry|fs|ps|ns|s|atm|bar|GPa|MPa|kPa|Pa|psi|kbar|nm|Å|A|pm|um|μm|m|cm|amu|g\\s*/\\s*mol|kg|g|g\\s*/\\s*cm\\s*\\^?\\s*3|kg\\s*/\\s*m\\s*\\^?\\s*3|atoms?|molecules?)`;
  const tokenSets = [
    { kind: 'temperature', names: ['T','temperature','temp','T_target','target temperature'], unitDefault: 'K' },
    { kind: 'pressure',    names: ['P','pressure','target pressure'], unitDefault: 'atm' },
    { kind: 'density',     names: ['ρ','rho','density'], unitDefault: 'g/cm^3' },
    { kind: 'time',        names: ['dt','δt','Δt','timestep','time step'], unitDefault: 'fs' },
    { kind: 'length',      names: ['Lx','Ly','Lz','box','box size','side length','cutoff','r_cut','rcut','σ','sigma'], unitDefault: 'A' },
    { kind: 'energy',      names: ['ε','epsilon','well depth','binding energy','E_total','E','U'], unitDefault: 'kcal/mol' },
    { kind: 'count',       names: ['N','N_atoms','number of atoms','N_part','particles','molecules','chains'], unitDefault: '' },
  ];
  const found = [];
  for (const ts of tokenSets) {
    for (const nm of ts.names) {
      const re = new RegExp(`\\b${nm.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*[=:]\\s*${NUM}\\s*${UNIT}?`, 'gi');
      let m;
      while ((m = re.exec(text)) && found.length < 80) {
        const ctxStart = Math.max(0, m.index - 60), ctxEnd = Math.min(text.length, m.index + 100);
        found.push({
          name: nm, kind: ts.kind === 'count' ? 'number' : ts.kind,
          value: parseFloat(m[1]),
          unit: (m[2] || ts.unitDefault).replace(/\s+/g, '').replace('Å', 'A'),
          source: 'regex', confidence: m[2] ? 0.85 : 0.6,
          context: text.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim(),
        });
      }
    }
  }
  // 力场识别（ReaxFF / OPLS-AA / AMBER / CHARMM / TIP3P / SPC/E / EAM / Tersoff / SW / AIREBO / DREIDING / COMPASS / GAFF）
  const ffPatterns = ['ReaxFF', 'OPLS-AA', 'OPLS', 'AMBER', 'CHARMM', 'GROMOS', 'COMPASS', 'GAFF', 'DREIDING', 'AIREBO', 'Tersoff', 'Stillinger-Weber', 'SW potential', 'EAM', 'MEAM', 'SNAP', 'TIP3P', 'TIP4P', 'SPC/E', 'SPCE'];
  const ffHits = ffPatterns.filter(ff => new RegExp(`\\b${ff.replace(/[.*+?]/g, '\\$&')}\\b`, 'i').test(text)).map(ff => ({ name: 'force_field', kind: 'string', value: ff, source: 'regex', confidence: 0.9, context: ff }));
  // 系综（NVT/NPT/NVE/μVT）
  const ensembles = [...text.matchAll(/\b(NPT|NVT|NVE|μVT|GCMC)\b/g)].slice(0, 3).map(m => ({ name: 'ensemble', kind: 'string', value: m[1], source: 'regex', confidence: 0.95 }));

  // 3) VLM 看 Methods/Table 页
  //    —— 智能选页：根据 readDocument 的图片清单里"page"字段，
  //       结合正文中 "Method/Simulation details/Computational/Table/Parameter"
  //       关键字位置粗估出页码，优先送 VLM，比盲取前 N 页准很多。
  //    —— 并发：3 路 worker pool 跑（之前是 for-await 串行，6 页 × 30s = 3 分钟，
  //       现在 ~60-80s 全部完成）
  //    —— 早停：如果正则已经抓到 ≥5 个核心参数（含 force_field / ensemble），
  //       VLM 只看 2 页做兜底，不全跑。
  const coreFound = new Set();
  for (const f of [...found, ...ffHits, ...ensembles]) {
    if (typeof f.value !== 'undefined' && f.value !== null) coreFound.add(f.kind + '|' + (f.name || ''));
  }
  const enoughByRegex = coreFound.size >= 5 && ffHits.length > 0;
  let effectiveMaxPages = enoughByRegex ? Math.min(2, maxPagesVlm) : maxPagesVlm;
  if (enoughByRegex) progress && progress(`[paper_extract_params] 正则已抓到 ${coreFound.size} 个参数 (含力场)，VLM 只看 ${effectiveMaxPages} 页兜底`);

  // 智能选页：image 清单里有 page 字段；正文里搜关键字位置 → 估算页码（按字符比例）
  // 优先级排序：Method/Methods/Simulation details > Computational > Table > Parameter > 中段页 > 头部
  let vlmTargets = [];
  try {
    // 重新从 raw 取图片清单（含 page 字段）
    const parsedImagesMatches = [...imgBlock.matchAll(/[-•]\s+(\w+)\s+p(\d+)[^:]*:\s*(\S+)/g)];
    const allImgs = parsedImagesMatches.map(m => ({ kind: m[1], page: +m[2], path: m[3] })).filter(x => x.path);
    if (allImgs.length) {
      const totalPages = Math.max(...allImgs.map(x => x.page));
      const textLen = text.length || 1;
      const keywords = [
        { re: /\b(Methods?|Methodology|Computational details?|Simulation details?|Simulation method|MD simulations?|Modeling|Model setup)\b/gi, w: 3 },
        { re: /\b(Table\s+\d+|Parameters?|Force\s+field|Potential)\b/gi, w: 2 },
        { re: /\b(System|Setup|Initial configuration|Box|Ensemble|Thermostat)\b/gi, w: 1 },
      ];
      const pageScore = new Map();
      for (const kw of keywords) {
        let mm;
        while ((mm = kw.re.exec(text)) !== null) {
          const pageGuess = Math.max(1, Math.min(totalPages, Math.ceil((mm.index / textLen) * totalPages)));
          pageScore.set(pageGuess, (pageScore.get(pageGuess) || 0) + kw.w);
          // 同时给相邻页 +1（关键字落在页边界时常见）
          if (pageGuess + 1 <= totalPages) pageScore.set(pageGuess + 1, (pageScore.get(pageGuess + 1) || 0) + 1);
        }
      }
      // 把第 1 页（多半是 title/abstract，几乎没参数）降权
      pageScore.set(1, (pageScore.get(1) || 0) - 5);
      // 按分排序，但只选有 page 对应图片的
      const pagesWithImg = new Set(allImgs.map(x => x.page));
      const ranked = [...pageScore.entries()].filter(([p]) => pagesWithImg.has(p)).sort((a, b) => b[1] - a[1]).map(([p]) => p);
      // 取 top-N 唯一页码对应的图片
      const seen = new Set();
      for (const pg of ranked) {
        if (seen.size >= effectiveMaxPages) break;
        const img = allImgs.find(x => x.page === pg && !seen.has(pg));
        if (img) { vlmTargets.push(img.path); seen.add(pg); }
      }
      // 不足则用"中段页"补齐（往往是 Methods/Results 主体）
      if (vlmTargets.length < effectiveMaxPages) {
        const midStart = Math.floor(totalPages * 0.2);
        const midEnd = Math.floor(totalPages * 0.7);
        for (const im of allImgs) {
          if (vlmTargets.length >= effectiveMaxPages) break;
          if (seen.has(im.page)) continue;
          if (im.page >= midStart && im.page <= midEnd) { vlmTargets.push(im.path); seen.add(im.page); }
        }
      }
      progress && progress(`[paper_extract_params] 选页完成：${vlmTargets.length} 张（基于关键字定位，跳过封面页）`);
    }
  } catch (e) { progress && progress(`[paper_extract_params] 选页降级到取前 N 页：${e.message}`); }
  // 兜底：选页失败 → 用原逻辑取前 N 张
  if (!vlmTargets.length) vlmTargets = pageImages.slice(0, effectiveMaxPages);

  const vlmParams = [];
  const VLM_CONC = Math.max(1, parseInt(process.env.VLM_PAPER_CONCURRENCY || '3', 10));
  let vlmDone = 0;
  let vlmCursor = 0;
  async function _vlmWorker() {
    while (true) {
      const i = vlmCursor++;
      if (i >= vlmTargets.length) return;
      const q = `这是论文一页的扫描图。请只关注分子动力学/计算化学的**仿真参数**，提取所有形如 "T = 300 K"、"density 0.85 g/cm³"、"timestep 1 fs"、"cut-off 12 Å"、"N = 512"、"NPT/NVT/NVE" 等内容。
严格按 JSON 数组输出（**只输出 JSON**，不要任何解释）：
[{"name":"T","value":300,"unit":"K","kind":"temperature","note":"NVT target T"},...]
kind 取自：temperature/pressure/density/time/length/energy/mass/force/count/string。若是力场名（ReaxFF/OPLS/EAM…）用 kind=string。`;
      let ans = '';
      try { ans = await visionAnalyze([vlmTargets[i]], q, 1200, progress, { detail: 'low' }); } catch (e) { ans = '[err] ' + e.message; }
      const jm = String(ans).match(/\[[\s\S]*\]/);
      if (jm) {
        try {
          const arr = JSON.parse(jm[0]);
          for (const it of arr) {
            if (it.value == null) continue;
            vlmParams.push({ ...it, source: `vlm_p${i + 1}`, confidence: 0.7, page: i + 1 });
          }
        } catch {}
      }
      vlmDone++;
      progress && progress(`[paper_extract_params] VLM 完成 ${vlmDone}/${vlmTargets.length} 页`);
    }
  }
  if (vlmTargets.length) {
    await Promise.all(Array.from({ length: Math.min(VLM_CONC, vlmTargets.length) }, () => _vlmWorker()));
  }

  // 4) 合并去重（同 name+kind 取最高 confidence，注明所有来源）
  const merged = new Map();
  for (const p of [...found, ...ffHits, ...ensembles, ...vlmParams]) {
    const key = (p.name + '|' + p.kind).toLowerCase();
    const prev = merged.get(key);
    if (!prev || p.confidence > prev.confidence) {
      merged.set(key, { ...p, all_sources: [...(prev?.all_sources || []), p.source] });
    } else {
      prev.all_sources.push(p.source);
    }
  }
  const params = [...merged.values()];

  // 5) 自动单位换算
  let converted = null, warnings = [];
  if (toUnits) {
    const items = params.filter(p => typeof p.value === 'number' && ['temperature','pressure','density','time','length','energy','mass','force'].includes(p.kind))
                        .map(p => ({ name: p.name, value: p.value, unit: p.unit, kind: p.kind }));
    try {
      const raw = await execLammpsTool('lmp_unit_convert', { to_units: toUnits, items }, { WORKSPACE });
      const r = JSON.parse(raw);
      if (r.error) warnings.push('unit_convert: ' + r.error);
      else { converted = r.converted; warnings = r.warnings || []; }
    } catch (e) { warnings.push('unit_convert 失败: ' + e.message); }
  }

  // 6) 一致性自检
  const T = params.find(x => x.kind === 'temperature');
  const dt = params.find(x => x.kind === 'time');
  const ff = params.find(x => x.name === 'force_field');
  if (ff && /ReaxFF/i.test(ff.value) && dt && dt.unit && /fs/i.test(dt.unit) && dt.value > 0.5) warnings.push(`ReaxFF 推荐 dt ≤ 0.25 fs，论文给的 ${dt.value} ${dt.unit} 可能不稳`);
  if (T && T.value > 2000) warnings.push(`T=${T.value} K 已进入高温分解/热解区，确认 ensemble 与势函数适用范围`);
  if (!ff) warnings.push('未识别到力场名，必须 lmp_doc_lookup query="pair_style" 并 lmp_find_potential 验证');

  return JSON.stringify({
    file: p, head: headM ? headM[0] : '',
    n_params: params.length,
    params,
    converted,
    warnings,
    next_step: toUnits ? `把 converted 里的值直接写进 in.${toUnits}；再 lmp_clone_example 抄一个相同力场的样例做骨架。`
                       : '建议传 to_units=real(ReaxFF) 或 metal(EAM) 自动换算；再 lmp_clone_example 复制同力场算例做骨架。',
  }, null, 2);
}
// ====================== /paper_extract_params ======================

await loadSettings();
await loadCopilotState();
await autoProbeEnvironment();
const HOST = parseCliHost() || process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`\n  MDriver v0.1.0 已启动  (AI-driven Molecular Dynamics for LAMMPS)`);
  console.log(`  平台: ${process.platform}`);
  console.log(`  工作目录: ${WORKSPACE}`);
  console.log(`  Provider:${SETTINGS.provider}  模型: ${SETTINGS.provider === 'copilot' ? SETTINGS.copilotModel : SETTINGS.model}`);
  console.log(`  LAMMPS root:${SETTINGS.lammpsRoot || '(未设置 — 欢迎页点"一键部署 LAMMPS")'}`);
  console.log(`  LAMMPS 可执行:${SETTINGS.lammpsBin || 'lmp (默认 PATH)'}`);
  console.log(`  Python:${SETTINGS.pythonPath || '(默认 PATH)'}`);
  {
    const flags = [];
    if (process.env.TAVILY_API_KEY) flags.push('Tavily');
    if (process.env.SERPER_API_KEY) flags.push('Serper');
    if (process.env.BRAVE_API_KEY) flags.push('Brave');
    if (process.env.SEARXNG_URL) flags.push('SearXNG');
    if (process.env.SEMANTIC_SCHOLAR_API_KEY) flags.push('S2');
    console.log(`  联网搜索：${flags.length ? flags.join(' + ') + ' + HTML 兜底' : 'HTML 爬取 (DDG/Bing/Baidu)；可设置 TAVILY_API_KEY 获得 SOTA'}`);
    console.log(`  学术：Semantic Scholar + arXiv (无需 Key)`);
  }
  console.log(`  监听:    ${HOST}:${PORT}`);
  console.log(`  打开:    http://${HOST === '0.0.0.0' ? '<服务器IP>' : HOST}:${PORT}\n`);
});
