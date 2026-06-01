// ============================================================================
//  skills.js —— 领域技能包（按用户、按领域的本地持续优化）
//  设计：每个领域一个 skills/<id>/skill.json，随真实任务积累“经验/参数/模板/统计”。
//  晋升策略（两者结合）：
//   · 强信号（lint 错误被修复后跑健康 / 探针由坏转好）→ 自动写入 lessons（客观、可复现）
//   · 弱信号（整体跑通的一次任务）→ 只产候选，等用户 skill_promote 确认
//  本模块不依赖 LLM，纯确定性 + 文件存储，便于无头测试。
// ============================================================================
import fs from 'fs';
import path from 'path';

let BASE = null;
const LESSON_CAP = 40;        // 单领域 lessons 上限（超出按 hits 淘汰）
const INJECT_LESSON_MAX = 15; // 注入 prompt 的最多条数
const INJECT_CHAR_CAP = 3000; // 注入 prompt 的字符上限
const HISTORY_CAP = 100;      // 适应度曲线保留点数

export function initSkills(dir) {
  BASE = dir;
  try { fs.mkdirSync(BASE, { recursive: true }); } catch {}
}
function _ensureBase() { if (!BASE) throw new Error('skills 未初始化（initSkills）'); }
export function safeId(id) {
  return String(id || '').trim().replace(/[^\w\u4e00-\u9fa5\-]+/g, '_').slice(0, 64) || 'default';
}
function dirOf(id) { return path.join(BASE, safeId(id)); }
function fileOf(id) { return path.join(dirOf(id), 'skill.json'); }

function _blank(id, name) {
  return {
    id: safeId(id), name: name || id, createdAt: Date.now(), updatedAt: Date.now(),
    stats: { runs: 0, healthy: 0, lintPass: 0, completed: 0, failures: 0 },
    history: [],            // [{ ts, score, outcome }]
    lessons: [],            // [{ id, text, fix, source:'auto'|'user', rule, hits, ts }]
    candidates: [],         // [{ id, text, why, signals, ts }]
    params: {},             // 领域默认参数偏好
    templates: [],          // 已验证模板名
    triggers: [],           // 触发词：用户消息含这些词时提示启用本 skill（如 热解/pyrolysis）
    lintRules: [],          // 领域硬规则 [{id,name,kind:'forbid'|'require',pattern,msg,fix,severity}]
    benchmarks: [],         // 自训练回归集 [{id,name,taskText,checks:[{type,...}],lastPass,lastInfo,ts}]
    trainHistory: [],       // 自训练通过率曲线 [{ts,total,passed,passRate,iter}]
    train: _blankTrain(),   // 自训练检查点（支持中途停止后续训）
  };
}
function _blankTrain() {
  return { cumulativeIter: 0, bestPassed: null, total: 0, lastTs: 0, lastBaselineTs: 0, baselineDone: false };
}

export function listSkills() {
  _ensureBase();
  let names = [];
  try { names = fs.readdirSync(BASE, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; }
  const out = [];
  for (const n of names) {
    const s = loadSkill(n);
    if (!s) continue;
    out.push({ id: s.id, name: s.name, runs: s.stats.runs, lessons: s.lessons.length, candidates: s.candidates.length, health: _healthRate(s) });
  }
  return out.sort((a, b) => b.runs - a.runs);
}

export function loadSkill(id) {
  _ensureBase();
  try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch { return null; }
}
function saveSkill(s) {
  _ensureBase();
  s.updatedAt = Date.now();
  fs.mkdirSync(dirOf(s.id), { recursive: true });
  fs.writeFileSync(fileOf(s.id), JSON.stringify(s, null, 2), 'utf8');
  return s;
}
export function createSkill(id, name) {
  _ensureBase();
  const existing = loadSkill(id);
  if (existing) return existing;
  return saveSkill(_blank(id, name));
}
export function deleteSkill(id) {
  _ensureBase();
  try { fs.rmSync(dirOf(id), { recursive: true, force: true }); return true; } catch { return false; }
}

function _healthRate(s) {
  return s.stats.runs ? Math.round((s.stats.healthy / s.stats.runs) * 100) : 0;
}
function _norm(t) { return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function _uid() { return Math.random().toString(36).slice(2, 10); }

// 注入 system prompt 的领域知识块（封顶 + 蒸馏）
// 经验排序很关键：大模型对靠前/重复出现的内容权重更高，所以把“最具体、可执行”的坑放最前。
const _LOW_VALUE_RULES = new Set(['bench:run', 'bench:probe', 'bench:lint']); // 泛泛的流程提醒，且常与成功事实矛盾→不注入
function _lessonRank(l) {
  let r = 0;
  if (l.fix) r += 4;                          // 带“正确做法”的最可执行
  if (/^L\d/i.test(l.rule || '')) r += 3;     // lint 规则=具体坑
  if (/^probe:/.test(l.rule || '')) r += 2;   // 探针失败模式
  if (l.durable) r += 1;
  return r;
}
export function buildSkillInjection(id) {
  const s = loadSkill(id);
  if (!s) return '';
  const useful = (s.lessons || []).filter(l => !_LOW_VALUE_RULES.has(l.rule));
  const top = useful.sort((a, b) => (_lessonRank(b) - _lessonRank(a)) || (b.hits - a.hits) || (b.ts - a.ts)).slice(0, INJECT_LESSON_MAX);
  const lines = [];
  lines.push(`\n# 🧠 领域技能：${s.name}（已积累 ${useful.length} 条可执行经验 · 跑过 ${s.stats.runs} 次 · 健康率 ${_healthRate(s)}%）`);
  lines.push('下面是你在该领域用真实任务沉淀的硬经验，**按重要性从上到下排列，务必优先遵守**（与通用规则冲突时以这里为准）：');
  if (top.length === 0) {
    lines.push('- （暂无经验，跑几个任务后会自动积累）');
  } else {
    for (const l of top) {
      const fix = l.fix ? `　正确做法：${l.fix}` : '';
      lines.push(`- ${l.text}${fix}`);
    }
  }
  const pk = Object.entries(s.params || {});
  if (pk.length) lines.push(`默认参数偏好（无特殊说明就按这些填，别从零猜）：${pk.map(([k, v]) => `${k}=${v}`).join('；')}`);
  if ((s.templates || []).length) {
    lines.push(`本领域已验证模板：${s.templates.join(', ')}`);
    lines.push('⚙️ 复用准则：遇到本领域的同类/相似工况，**先 lmp_template_get 取用上面已验证的模板**，再按“默认参数偏好”微调，不要从零另写脚本。已调好的最优流程要直接照搬。');
  }
  if ((s.lintRules || []).length) {
    lines.push('本领域硬规则（lmp_lint 会强制检，违反会报错）：');
    for (const r of s.lintRules.slice(0, 10)) lines.push(`- ${r.msg || r.name}${r.fix ? '（' + r.fix + '）' : ''}`);
  }
  let block = lines.join('\n');
  if (block.length > INJECT_CHAR_CAP) block = block.slice(0, INJECT_CHAR_CAP) + '\n- …（经验已截断，可在状态面板蒸馏）';
  return block + '\n';
}

// 把一条 lesson 合并进 lessons（去重 / 累加 hits / 控容量）
function _mergeLesson(s, lesson) {
  const key = lesson.rule ? `rule:${lesson.rule}` : `txt:${_norm(lesson.text)}`;
  const found = s.lessons.find(l => (l.rule ? `rule:${l.rule}` : `txt:${_norm(l.text)}`) === key);
  if (found) { found.hits = (found.hits || 1) + 1; found.ts = Date.now(); if (lesson.fix && !found.fix) found.fix = lesson.fix; if (lesson.durable) found.durable = true; return found; }
  const l = { id: _uid(), text: lesson.text, fix: lesson.fix || '', source: lesson.source || 'auto', rule: lesson.rule || '', durable: !!lesson.durable, hits: 1, ts: Date.now() };
  s.lessons.push(l);
  if (s.lessons.length > LESSON_CAP) {
    // 淘汰时优先保留 durable（客观经验=达尔文式垫脚石），其次按命中数/新鲜度
    s.lessons.sort((a, b) => (Number(!!b.durable) - Number(!!a.durable)) || (b.hits - a.hits) || (b.ts - a.ts));
    s.lessons = s.lessons.slice(0, LESSON_CAP);
  }
  return l;
}

// 评分（0~1）：跑健康/lint通过/任务完成加分，失败扣分 —— 适应度曲线用
function _score(sig) {
  let v = 0.0;
  if (sig.lintPass) v += 0.25;
  if (sig.probeHealthy) v += 0.4;
  if (sig.runCompleted) v += 0.35;
  if (sig.toolFails > 0) v -= Math.min(0.3, sig.toolFails * 0.1);
  return Math.max(0, Math.min(1, v));
}

// 核心：一次任务结束后记录信号，按强/弱信号产出 lessons / candidates
// sig: {
//   lintFiredRules: [{rule,msg,fix}],   // 本轮 lint 报过的错误规则
//   lintPass: bool,                      // 本轮最后一次 lint 是否通过
//   probeVerdicts: [str],                // 探针 verdict 序列
//   probeHealthy: bool,                  // 是否出现过 healthy
//   ranProbe: bool, ranAsync: bool, runCompleted: bool,
//   toolFails: int, rounds: int,
//   taskText: str,                       // 用户任务原文（截断）
// }
export function recordRun(id, sig) {
  const s = loadSkill(id) || createSkill(id, id);
  s.stats.runs++;
  if (sig.lintPass) s.stats.lintPass++;
  if (sig.probeHealthy) s.stats.healthy++;
  if (sig.runCompleted) s.stats.completed++;
  if (sig.toolFails > 0) s.stats.failures++;
  s.history.push({ ts: Date.now(), score: _score(sig), outcome: sig.runCompleted ? 'completed' : (sig.probeHealthy ? 'healthy' : (sig.lintPass ? 'lint-ok' : 'incomplete')) });
  if (s.history.length > HISTORY_CAP) s.history = s.history.slice(-HISTORY_CAP);

  const autoLessons = [];
  // —— 强信号①：lint 报过错 + 最终通过 + 跑健康/完成 → 这条错被“修对了”，自动沉淀
  const objectiveGood = sig.lintPass && (sig.probeHealthy || sig.runCompleted);
  if (objectiveGood && Array.isArray(sig.lintFiredRules)) {
    for (const r of sig.lintFiredRules) {
      if (!r || !r.msg) continue;
      const l = _mergeLesson(s, {
        text: `避免「${r.rule || ''} ${r.msg}」`.trim(),
        fix: r.fix || '', source: 'auto', rule: r.rule || '', durable: true,
      });
      autoLessons.push(l.text);
    }
  }
  // —— 强信号②：探针由坏转好 → 沉淀该失败模式
  if (Array.isArray(sig.probeVerdicts) && sig.probeHealthy) {
    const bad = sig.probeVerdicts.find(v => v && v !== 'healthy');
    if (bad) {
      const map = {
        'lost-atoms': '曾出现 lost atoms：建几何后先 minimize、检查初始重叠、非周期边界配 fix wall',
        'temp-nan': '曾出现 temp=NaN：timestep 太大或初速没设，先减小 timestep + velocity create',
        'energy-spike': '曾出现能量爆涨：初始构型重叠，先 minimize 或拉大原子间距',
        'timeout': '探针超时：体系偏大，先缩小规模或减步数验证物理再放大',
      };
      const txt = map[bad] || `曾出现探针异常(${bad})，已修复`;
      const l = _mergeLesson(s, { text: txt, source: 'auto', rule: `probe:${bad}`, durable: true });
      autoLessons.push(l.text);
    }
  }

  // —— 弱信号：整体跑通的一次任务 → 产候选，等用户确认
  let candidate = null;
  if ((sig.ranAsync && sig.runCompleted) || (sig.ranProbe && sig.probeHealthy && !sig.lintFiredRules?.length)) {
    candidate = {
      id: _uid(),
      text: (sig.taskText ? `任务“${String(sig.taskText).slice(0, 60)}”跑通` : '一次任务跑通'),
      why: '整体顺利完成，可能含可复用的做法；确认后写入经验',
      signals: { lintPass: !!sig.lintPass, probeHealthy: !!sig.probeHealthy, runCompleted: !!sig.runCompleted, rounds: sig.rounds || 0 },
      ts: Date.now(),
    };
    s.candidates.unshift(candidate);
    s.candidates = s.candidates.slice(0, 20);
  }

  saveSkill(s);
  return { auto: autoLessons, candidate, health: _healthRate(s), runs: s.stats.runs };
}

// 用户把候选晋升为正式经验（可改写文本）
export function promoteCandidate(id, candidateId, overrideText) {
  const s = loadSkill(id);
  if (!s) return { ok: false, msg: 'skill 不存在' };
  const idx = s.candidates.findIndex(c => c.id === candidateId);
  if (idx < 0) return { ok: false, msg: '候选不存在' };
  const c = s.candidates[idx];
  const l = _mergeLesson(s, { text: overrideText || c.text, source: 'user' });
  s.candidates.splice(idx, 1);
  saveSkill(s);
  return { ok: true, lesson: l };
}
export function dismissCandidate(id, candidateId) {
  const s = loadSkill(id);
  if (!s) return { ok: false };
  s.candidates = s.candidates.filter(c => c.id !== candidateId);
  saveSkill(s);
  return { ok: true };
}

// 用户手动加一条经验 / 删一条
export function addLesson(id, text, fix) {
  const s = loadSkill(id) || createSkill(id, id);
  const l = _mergeLesson(s, { text, fix: fix || '', source: 'user' });
  saveSkill(s);
  return l;
}
export function removeLesson(id, lessonId) {
  const s = loadSkill(id);
  if (!s) return false;
  const n = s.lessons.length;
  s.lessons = s.lessons.filter(l => l.id !== lessonId);
  saveSkill(s);
  return s.lessons.length < n;
}
export function setParam(id, key, value) {
  const s = loadSkill(id) || createSkill(id, id);
  if (value === null || value === undefined || value === '') delete s.params[key];
  else s.params[key] = value;
  saveSkill(s);
  return s.params;
}
export function addTemplate(id, name) {
  const s = loadSkill(id) || createSkill(id, id);
  if (!s.templates.includes(name)) s.templates.push(name);
  saveSkill(s);
  return s.templates;
}
export function removeTemplate(id, name) {
  const s = loadSkill(id);
  if (!s) return [];
  s.templates = s.templates.filter(t => t !== name);
  saveSkill(s);
  return s.templates;
}

// —— 触发词：让 skill 能被“提到关键词就浮出” ——
export function setTriggers(id, arr) {
  const s = loadSkill(id) || createSkill(id, id);
  const seen = new Set(); const out = [];
  for (const t of (Array.isArray(arr) ? arr : [])) {
    const k = String(t || '').trim();
    if (!k) continue;
    const lc = k.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc); out.push(k.slice(0, 40));
    if (out.length >= 24) break;
  }
  s.triggers = out;
  saveSkill(s);
  return s.triggers;
}
// 扫描所有 skill，返回触发词命中该文本的 [{id,name,matched:[...]}]
export function matchTriggers(text) {
  _ensureBase();
  const hay = String(text || '').toLowerCase();
  if (!hay.trim()) return [];
  const out = [];
  for (const meta of listSkills()) {
    const s = loadSkill(meta.id);
    if (!s || !Array.isArray(s.triggers) || !s.triggers.length) continue;
    const matched = s.triggers.filter(t => t && hay.includes(String(t).toLowerCase()));
    if (matched.length) out.push({ id: s.id, name: s.name, matched });
  }
  return out;
}
// 从任务文本里猜几个领域关键词，预填进沉淀卡的“触发词”（用户可自由改）
const _KW_DICT = [
  '热解', 'pyrolysis', '燃烧', 'combustion', '氧化', 'oxidation', '裂解', 'cracking',
  '聚合', 'polymer', '水合物', '扩掲', 'diffusion', '扩散', '黏度', 'viscosity',
  '导热', '宆子', 'reaxff', '反应力场', 'eam', 'tersoff', 'airebo', '金属', '水',
  '限域', '流动', '剖面', 'shock', '冲击', '拉伸', '弹性', '熔化', '结晶',
];
export function suggestTriggersFromText(text) {
  const hay = String(text || '').toLowerCase();
  const out = [];
  for (const kw of _KW_DICT) { if (hay.includes(kw.toLowerCase()) && !out.includes(kw)) out.push(kw); if (out.length >= 5) break; }
  return out;
}

// ===== 晋升阶梯顶端：经验 → 领域硬规则（被 lmp_lint 强制执行）=====
function _validRegex(p) { try { new RegExp(p, 'im'); return true; } catch { return false; } }
export function getLintRules(id) {
  const s = loadSkill(id);
  return s ? (s.lintRules || []) : [];
}
export function addLintRule(id, rule) {
  const s = loadSkill(id) || createSkill(id, id);
  if (!rule || !rule.pattern || !_validRegex(rule.pattern)) return { ok: false, msg: '正则非法或为空' };
  const r = {
    id: 'D' + _uid().slice(0, 4),
    name: String(rule.name || '').slice(0, 80),
    kind: rule.kind === 'require' ? 'require' : 'forbid',
    pattern: String(rule.pattern).slice(0, 400),
    msg: String(rule.msg || rule.name || '').slice(0, 200),
    fix: String(rule.fix || '').slice(0, 240),
    severity: rule.severity === 'warning' ? 'warning' : 'error',
    fromLesson: rule.fromLesson || '',
    ts: Date.now(),
  };
  s.lintRules = s.lintRules || [];
  s.lintRules.push(r);
  saveSkill(s);
  return { ok: true, rule: r };
}
export function removeLintRule(id, ruleId) {
  const s = loadSkill(id);
  if (!s) return false;
  const n = (s.lintRules || []).length;
  s.lintRules = (s.lintRules || []).filter(r => r.id !== ruleId);
  saveSkill(s);
  return s.lintRules.length < n;
}
// 把一条经验晋升为硬规则（用户给 pattern/kind，文案默认取经验文本）
export function promoteLessonToRule(id, lessonId, spec) {
  const s = loadSkill(id);
  if (!s) return { ok: false, msg: 'skill 不存在' };
  const l = (s.lessons || []).find(x => x.id === lessonId);
  const r = addLintRule(id, {
    name: spec.name || (l ? l.text : ''),
    kind: spec.kind, pattern: spec.pattern,
    msg: spec.msg || (l ? l.text : ''),
    fix: spec.fix || (l ? l.fix : ''),
    severity: spec.severity || 'error',
    fromLesson: lessonId,
  });
  return r;
}

// ===== 自训练：回归基准集 + 可判定判据 + 通过率曲线 =====
// benchmark: { id, name, taskText, checks:[{type, pattern?, min?, max?}], lastPass, lastInfo, ts }
// 判据类型（全部可机器判定）：
//   probe_healthy   探针 verdict 必须出现 healthy
//   lint_clean      lmp_lint 必须通过（无 error）
//   run_completed   异步完整 run 必须 exit 0（信号 runCompleted）
//   output_present  本轮工具输出里必须匹配 pattern（正则）
//   output_absent   本轮工具输出里必须不出现 pattern（正则）
//   value_range     output 用 pattern 提取 capture group 1 的数值，落在 [min,max]
export function listBenchmarks(id) {
  const s = loadSkill(id);
  return s ? (s.benchmarks || []) : [];
}
export function addBenchmark(id, bench) {
  const s = loadSkill(id) || createSkill(id, id);
  if (!bench || !bench.taskText) return { ok: false, msg: '缺少任务描述' };
  const checks = Array.isArray(bench.checks) ? bench.checks.filter(c => c && c.type).slice(0, 12) : [];
  // 校验 value_range/output_* 的正则
  for (const c of checks) {
    if ((c.pattern != null && c.pattern !== '') && !_validRegex(c.pattern)) return { ok: false, msg: `判据 ${c.type} 的正则非法` };
  }
  if (!checks.length) return { ok: false, msg: '至少要一个通过判据' };
  const b = {
    id: 'B' + _uid().slice(0, 5),
    name: String(bench.name || bench.taskText).slice(0, 80),
    taskText: String(bench.taskText).slice(0, 1200),
    checks, lastPass: null, lastInfo: '', ts: Date.now(),
  };
  s.benchmarks = s.benchmarks || [];
  s.benchmarks.push(b);
  saveSkill(s);
  return { ok: true, benchmark: b };
}
export function removeBenchmark(id, benchId) {
  const s = loadSkill(id);
  if (!s) return false;
  const n = (s.benchmarks || []).length;
  s.benchmarks = (s.benchmarks || []).filter(b => b.id !== benchId);
  saveSkill(s);
  return s.benchmarks.length < n;
}
// 纯函数判定：给定一组判据 + 本轮信号 + 工具输出文本 → {pass, details:[{type,ok,info}]}
export function evalChecks(checks, sig, outputText) {
  sig = sig || {}; outputText = String(outputText || '');
  const details = [];
  for (const c of (checks || [])) {
    let ok = false, info = '';
    switch (c.type) {
      case 'probe_healthy': ok = !!sig.probeHealthy; info = ok ? '探针健康✓' : '探针未出现 healthy'; break;
      case 'lint_clean':    ok = !!sig.lintPass;     info = ok ? 'lint通过✓' : 'lint 未通过'; break;
      case 'run_completed': ok = !!sig.runCompleted; info = ok ? '完整跑完✓' : '未完整跑完'; break;
      case 'output_present': {
        try { ok = new RegExp(c.pattern, 'im').test(outputText); } catch { ok = false; }
        info = `${ok ? '命中✓' : '未命中'} /${c.pattern}/`; break;
      }
      case 'output_absent': {
        let hit = false; try { hit = new RegExp(c.pattern, 'im').test(outputText); } catch { hit = false; }
        ok = !hit; info = `${ok ? '未出现✓' : '出现了✗'} /${c.pattern}/`; break;
      }
      case 'value_range': {
        let m = null; try { m = outputText.match(new RegExp(c.pattern, 'im')); } catch {}
        if (m && m[1] != null) {
          const v = parseFloat(m[1]);
          const lo = (c.min === '' || c.min == null) ? -Infinity : parseFloat(c.min);
          const hi = (c.max === '' || c.max == null) ? Infinity : parseFloat(c.max);
          ok = isFinite(v) && v >= lo && v <= hi;
          info = `取值 ${m[1]} ∈[${c.min ?? '-∞'},${c.max ?? '+∞'}]? ${ok ? '✓' : '✗'}`;
        } else { ok = false; info = `未提取到数值 /${c.pattern}/`; }
        break;
      }
      default: ok = false; info = '未知判据 ' + c.type;
    }
    details.push({ type: c.type, ok, info });
  }
  const pass = details.length > 0 && details.every(d => d.ok);
  return { pass, details };
}
// 记录某基准一次评估结果
export function recordBenchmarkResult(id, benchId, pass, info) {
  const s = loadSkill(id);
  if (!s) return false;
  const b = (s.benchmarks || []).find(x => x.id === benchId);
  if (!b) return false;
  b.lastPass = !!pass; b.lastInfo = String(info || '').slice(0, 300); b.ts = Date.now();
  saveSkill(s);
  return true;
}
// 记录一轮自训练（整个基准集跑一遍）的通过率
export function recordTrainPass(id, { total, passed, iter }) {
  const s = loadSkill(id);
  if (!s) return null;
  const passRate = total ? Math.round((passed / total) * 100) : 0;
  const rec = { ts: Date.now(), total, passed, passRate, iter: iter || 0 };
  s.trainHistory = s.trainHistory || [];
  s.trainHistory.push(rec);
  if (s.trainHistory.length > HISTORY_CAP) s.trainHistory = s.trainHistory.slice(-HISTORY_CAP);
  saveSkill(s);
  return rec;
}

// 自训练检查点：读取（旧 skill.json 自动补字段）/ 保存补丁
export function getTrainState(id) {
  const s = loadSkill(id);
  if (!s) return _blankTrain();
  return { ..._blankTrain(), ...(s.train || {}) };
}
export function saveTrainState(id, patch) {
  const s = loadSkill(id);
  if (!s) return null;
  s.train = { ..._blankTrain(), ...(s.train || {}), ...(patch || {}), lastTs: Date.now() };
  saveSkill(s);
  return s.train;
}
// 清空检查点（用户选择“从头训练”时调用）
export function resetTrainState(id) {
  const s = loadSkill(id);
  if (!s) return null;
  s.train = _blankTrain();
  saveSkill(s);
  return s.train;
}

// ===== 自训练的"具体坑→修法"提炼 + keep-or-revert 经验留存检验 =====
const _PROBE_LESSON = {
  'lost-atoms':  { text: '曾出现 lost atoms：建几何后先 minimize、检查初始重叠、非周期边界配 fix wall', fix: 'minimize 0 1e-8 1000 10000；检查 region 重叠；boundary 配 fix wall' },
  'temp-nan':    { text: '曾出现 temp=NaN：timestep 太大或初速没设，先减小 timestep + velocity create', fix: '减小 timestep；velocity all create T seed' },
  'energy-spike':{ text: '曾出现能量爆涨：初始构型重叠，先 minimize 或拉大原子间距', fix: 'minimize 或增大 lattice 间距' },
  'timeout':     { text: '探针超时：体系偏大，先缩小规模或减步数验证物理再放大', fix: '减小 N / probe_steps，先验证物理再放大' },
};
// 从一次运行的信号 + 失败判据里，提炼"具体坑→修法"经验规格（不写库，返回数组）
export function lessonsFromSignal(sig, failedDetails) {
  sig = sig || {}; failedDetails = failedDetails || [];
  const out = [];
  // ① 探针坏 verdict → 对应坑笔记
  if (Array.isArray(sig.probeVerdicts)) {
    const bad = sig.probeVerdicts.find(v => v && v !== 'healthy');
    if (bad) { const m = _PROBE_LESSON[bad]; out.push({ text: m ? m.text : `曾出现探针异常(${bad})`, fix: m ? m.fix : '', rule: `probe:${bad}` }); }
  }
  // ② lint 报过的规则 → 直接固化（带规则自带的 msg/fix）
  if (Array.isArray(sig.lintFiredRules)) {
    for (const r of sig.lintFiredRules) if (r && r.msg) out.push({ text: `避免「${(r.rule || '')} ${r.msg}」`.trim(), fix: r.fix || '', rule: r.rule || '' });
  }
  // ③ 判据失败兜底（信号没覆盖到时，按判据类型给一条可执行建议）
  for (const d of failedDetails) {
    if (!d || d.ok) continue;
    if (d.type === 'value_range') out.push({ text: `数值未达标：${d.info}；检查物理参数/采样窗口/拟合区间`, rule: 'bench:value' });
    else if (d.type === 'output_present') out.push({ text: `期望输出缺失：${d.info}；确认流程确实跑到该阶段`, rule: 'bench:present' });
    else if (d.type === 'output_absent') out.push({ text: `出现禁止信号：${d.info}`, rule: 'bench:absent' });
    else if (d.type === 'probe_healthy' && !(Array.isArray(sig.probeVerdicts) && sig.probeVerdicts.length)) out.push({ text: '探针未健康：先用 lmp_run_probe 小步排查再放大', rule: 'bench:probe' });
    else if (d.type === 'run_completed') out.push({ text: '未完整跑完：先用探针/小步确认稳定，再 lmp_run_async 跑完整步数', rule: 'bench:run' });
    else if (d.type === 'lint_clean' && !(sig.lintFiredRules && sig.lintFiredRules.length)) out.push({ text: 'lint 未通过：跑前先 lmp_lint 把 error 修净', rule: 'bench:lint' });
  }
  // 去重（按 rule / 规范化 text）
  const seen = new Set(); const uniq = [];
  for (const o of out) { const k = o.rule ? 'r:' + o.rule : 't:' + _norm(o.text); if (seen.has(k)) continue; seen.add(k); uniq.push(o); }
  // 这些都是来自确定性信号的“客观坑→修法”，标为 durable 永久归档（不被 keep-or-revert 回滚）
  for (const u of uniq) u.durable = true;
  return uniq;
}
// 写入一条经验（自动来源，带 rule/fix），返回 lesson
// spec.durable=true 表示“客观坑→修法”垫脚石，永久归档，不被 keep-or-revert 回滚
export function learnLesson(id, spec) {
  const s = loadSkill(id) || createSkill(id, id);
  const l = _mergeLesson(s, { text: spec.text, fix: spec.fix || '', rule: spec.rule || '', source: spec.source || 'auto', durable: !!spec.durable });
  saveSkill(s);
  return l;
}
// 经验快照 / 还原：keep-or-revert 用，整批保留或整批回滚
export function snapshotLessons(id) {
  const s = loadSkill(id);
  return s ? JSON.parse(JSON.stringify(s.lessons || [])) : [];
}
export function restoreLessons(id, snap) {
  const s = loadSkill(id);
  if (!s) return false;
  s.lessons = Array.isArray(snap) ? JSON.parse(JSON.stringify(snap)) : [];
  saveSkill(s);
  return true;
}
// 达尔文式部分回滚：仅回滚“投机经验”，所有 durable（客观坑→修法）作为垫脚石永久保留。
// 即使本轮基准没提升，客观经验也会留下，让失败也能积累线索。
export function revertSpeculative(id, snap) {
  const s = loadSkill(id);
  if (!s) return false;
  const snapList = Array.isArray(snap) ? snap : [];
  const out = []; const seen = new Set();
  // ① 保留当前所有 durable 经验（含本轮刚学到的客观坑→修法）——归档为垫脚石
  for (const l of (s.lessons || [])) { if (l.durable) { out.push(l); seen.add(l.id); } }
  // ② 投机经验回滚到快照：丢弃本轮新增的投机经验，恢复被改动的旧投机经验
  for (const l of snapList) { if (!l.durable && !seen.has(l.id)) { out.push(JSON.parse(JSON.stringify(l))); seen.add(l.id); } }
  s.lessons = out;
  if (s.lessons.length > LESSON_CAP) {
    s.lessons.sort((a, b) => (Number(!!b.durable) - Number(!!a.durable)) || (b.hits - a.hits) || (b.ts - a.ts));
    s.lessons = s.lessons.slice(0, LESSON_CAP);
  }
  saveSkill(s);
  return true;
}

// 状态面板数据：统计 + 适应度曲线 + 经验/候选
export function skillStatus(id) {
  const s = loadSkill(id);
  if (!s) return null;
  return {
    id: s.id, name: s.name,
    stats: s.stats, health: _healthRate(s),
    curve: s.history.map(h => ({ ts: h.ts, score: h.score, outcome: h.outcome })),
    lessons: [...s.lessons].sort((a, b) => (b.hits - a.hits) || (b.ts - a.ts)),
    candidates: s.candidates,
    params: s.params, templates: s.templates,
    triggers: s.triggers || [],
    lintRules: s.lintRules || [],
    benchmarks: s.benchmarks || [],
    trainCurve: (s.trainHistory || []).map(t => ({ ts: t.ts, passRate: t.passRate, passed: t.passed, total: t.total, iter: t.iter })),
    train: { ..._blankTrain(), ...(s.train || {}) },
  };
}
