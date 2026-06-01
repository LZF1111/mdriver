// cleanup3: 删除孤儿 + 所有 CFD 路由 + 顶层函数
import fs from 'fs';
const SRC = './server.js';
let lines = fs.readFileSync(SRC, 'utf8').split('\n');
const before = lines.length;

// helper: 删除范围 [i, j]，含两端
function spliceRange(i, j) { lines.splice(i, j - i + 1); }

// 1. 删除从 LAMMPS_PROMPT 收尾 `; 之后到第一个 `// 浏览工作区` 注释行之前的全部，
//    并包含 /api/sim/browse 段（一直删到 "// ====================== 图片搜索"）
let startIdx = -1, endIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (startIdx < 0 && /^const LAMMPS_PROMPT = /.test(lines[i])) {
    // 找其 `; 收尾
    let j = i;
    while (j < lines.length && !/^\s*`\s*;\s*$/.test(lines[j])) j++;
    startIdx = j + 1; // 收尾之后第一行
  }
  if (startIdx > 0 && lines[i].includes('图片搜索')) { endIdx = i - 1; break; }
}
if (startIdx > 0 && endIdx > startIdx) {
  console.log(`段 1 删除: ${startIdx + 1} ~ ${endIdx + 1}`);
  spliceRange(startIdx, endIdx);
}

// 2. 删除所有顶层 async function (foam|mfix|lbm|opt|launchParaView|runOpenFoam|pvRender|stlRender|caseProbe|algoCase|_ensureRunState|startRun|stageStart|stageDone|genericVision)\w*
const FN_RE = /^(async )?function (foam|mfix|lbm|opt|launchParaView|runOpenFoam|pvRender|stlRender|caseProbe|algoCase|_ensureRunState|startRun|stageStart|stageDone|genericVision|algoExtract)\w*/;
for (let i = 0; i < lines.length; ) {
  if (FN_RE.test(lines[i])) {
    // 找下一个 col=0 的 `}` 行
    let j = i + 1;
    while (j < lines.length && lines[j] !== '}') j++;
    if (j < lines.length) {
      console.log(`删函数 ${lines[i].slice(0, 80)} @ ${i + 1}-${j + 1}`);
      spliceRange(i, j);
      continue;
    }
  }
  i++;
}

// 3. 删除所有 app.(get|post|put|delete)('/api/(foam|mfix|lbm|opt|sim|stl)...
const ROUTE_RE = /^app\.(get|post|put|delete)\(['"`]\/api\/(foam|mfix|lbm|opt|sim|stl)/;
for (let i = 0; i < lines.length; ) {
  if (ROUTE_RE.test(lines[i])) {
    // 找下一个以 `});` 单独成行的（col=0）
    let j = i + 1;
    while (j < lines.length && !/^\}\);?\s*$/.test(lines[j])) j++;
    if (j < lines.length) {
      console.log(`删路由 ${lines[i].slice(0, 80)} @ ${i + 1}-${j + 1}`);
      spliceRange(i, j);
      continue;
    }
  }
  i++;
}

fs.writeFileSync(SRC, lines.join('\n'), 'utf8');
console.log(`cleanup3: ${before} → ${lines.length} 行`);
