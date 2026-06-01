// MDriver frontend — 浮动面板 + ParaView 投影 + 跨平台交互终端
const $ = (id) => document.getElementById(id);

// ====================== 浮动面板：拖拽 + 缩放 + 持久化 ======================
const LAYOUT_KEY = 'codemax.layout.v3';
function loadLayout() { try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}'); } catch { return {}; } }
function saveLayout(l) { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); }

let layout = loadLayout();
let zCounter = 10;

function applyPanelLayout(panel) {
  const pid = panel.dataset.pid;
  const def = panel.dataset.default.split(';').reduce((o, kv) => { const [k, v] = kv.split(':'); o[k] = parseInt(v, 10); return o; }, {});
  const saved = layout[pid] || {};
  panel.style.left = (saved.left ?? def.left) + 'px';
  panel.style.top = (saved.top ?? def.top) + 'px';
  panel.style.width = (saved.width ?? def.width) + 'px';
  panel.style.height = (saved.height ?? def.height) + 'px';
  if (saved.z) panel.style.zIndex = saved.z;
}

function makePanelMovableResizable(panel) {
  applyPanelLayout(panel);
  // V4: 8 个方向都可拉大小（n/e/s/w + 4 个角）
  ['n','e','s','w','ne','nw','se','sw'].forEach(d => { const r = document.createElement('div'); r.className = 'resize-' + d; panel.appendChild(r); attachResize(panel, r, d); });
  const head = panel.querySelector('.panel-head');
  let dragStart = null;
  head.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, input, select, textarea, option, label, [contenteditable], .x, .tab')) return;
    bringFront(panel);
    dragStart = { mx: e.clientX, my: e.clientY, x: panel.offsetLeft, y: panel.offsetTop };
    panel.classList.add('dragging');
    e.preventDefault();
  });
  panel.addEventListener('mousedown', () => bringFront(panel));
  document.addEventListener('mousemove', (e) => {
    if (!dragStart) return;
    let nx = dragStart.x + (e.clientX - dragStart.mx);
    let ny = dragStart.y + (e.clientY - dragStart.my);
    const desk = $('desktop').getBoundingClientRect();
    nx = Math.max(0, Math.min(nx, desk.width - 80));
    ny = Math.max(0, Math.min(ny, desk.height - 28));
    panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragStart) return;
    dragStart = null; panel.classList.remove('dragging');
    persistPanel(panel);
  });
}

function attachResize(panel, handle, dir) {
  let s = null;
  handle.addEventListener('mousedown', (e) => {
    bringFront(panel);
    s = { mx: e.clientX, my: e.clientY, w: panel.offsetWidth, h: panel.offsetHeight, left: panel.offsetLeft, top: panel.offsetTop };
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', (e) => {
    if (!s) return;
    const dx = e.clientX - s.mx;
    const dy = e.clientY - s.my;
    if (dir.includes('e')) panel.style.width = Math.max(200, s.w + dx) + 'px';
    if (dir.includes('s')) panel.style.height = Math.max(100, s.h + dy) + 'px';
    if (dir.includes('w')) {
      const newW = Math.max(200, s.w - dx);
      panel.style.width = newW + 'px';
      panel.style.left = (s.left + (s.w - newW)) + 'px';
    }
    if (dir.includes('n')) {
      const newH = Math.max(100, s.h - dy);
      panel.style.height = newH + 'px';
      panel.style.top = (s.top + (s.h - newH)) + 'px';
    }
    if (panel.dataset.pid === 'editor' && editor) editor.layout();
  });
  document.addEventListener('mouseup', () => { if (!s) return; s = null; persistPanel(panel); if (editor) editor.layout(); });
}

function bringFront(panel) {
  zCounter++; panel.style.zIndex = zCounter;
  document.querySelectorAll('.panel.active').forEach(p => p.classList.remove('active'));
  panel.classList.add('active');
  persistPanel(panel);
}
function persistPanel(panel) {
  const pid = panel.dataset.pid;
  layout[pid] = { left: panel.offsetLeft, top: panel.offsetTop, width: panel.offsetWidth, height: panel.offsetHeight, z: parseInt(panel.style.zIndex || '10', 10) };
  saveLayout(layout);
}

document.querySelectorAll('.panel').forEach(makePanelMovableResizable);

$('reset-layout').onclick = () => { layout = {}; saveLayout(layout); document.querySelectorAll('.panel').forEach(applyPanelLayout); if (editor) editor.layout(); };

// ====================== 面板可见性 + 视图菜单 ======================
const PANELS_KEY = 'codemax.panels.v1';
// pid → { label, group, defaultHidden }
const PANEL_META = {
  files:          { label: '资源管理器',  group: '工作区' },
  editor:         { label: '编辑器',      group: '工作区' },
  todos:          { label: '待办',        group: '工作区' },
  checkpoints:    { label: '检查点',      group: '工作区' },
  terminal:       { label: '终端',        group: '工作区' },
  chat:           { label: '聊天 / 智能体', group: '工作区' },
  ngl:            { label: '🎞️ NGL 轨迹查看器', group: '后处理', defaultHidden: true },
  scholar:        { label: '🎓 Agent 观察员',  group: '智能体', defaultHidden: false },
  gallery:        { label: '图片库',      group: '其他',   defaultHidden: true },
};
function loadPanelVis() { try { return JSON.parse(localStorage.getItem(PANELS_KEY) || '{}'); } catch { return {}; } }
function savePanelVis(o) { localStorage.setItem(PANELS_KEY, JSON.stringify(o)); }
let panelVis = loadPanelVis();

function isPanelVisible(pid) {
  if (pid in panelVis) return panelVis[pid];
  return !PANEL_META[pid]?.defaultHidden;
}
function setPanelVisible(pid, on) {
  panelVis[pid] = !!on; savePanelVis(panelVis);
  const el = document.querySelector(`.panel[data-pid="${pid}"]`);
  if (el) el.style.display = on ? '' : 'none';
  if (on && pid === 'editor' && editor) setTimeout(() => editor.layout(), 50);
  // 同步勾选
  const cb = document.querySelector(`#view-menu input[data-pid="${pid}"]`);
  if (cb) cb.checked = !!on;
}
function applyAllPanelVis() {
  for (const pid of Object.keys(PANEL_META)) {
    const el = document.querySelector(`.panel[data-pid="${pid}"]`);
    if (!el) continue;
    el.style.display = isPanelVisible(pid) ? '' : 'none';
  }
}
applyAllPanelVis();

function buildViewMenu() {
  const menu = $('view-menu'); if (!menu) return;
  const groups = {};
  for (const [pid, meta] of Object.entries(PANEL_META)) {
    (groups[meta.group] = groups[meta.group] || []).push([pid, meta]);
  }
  let html = '';
  for (const [g, items] of Object.entries(groups)) {
    html += `<div class="vm-section">${g}</div>`;
    for (const [pid, meta] of items) {
      const on = isPanelVisible(pid);
      html += `<label><input type="checkbox" data-pid="${pid}" ${on?'checked':''}/> ${meta.label}</label>`;
    }
  }
  html += `<hr/><label style="opacity:.85"><span style="color:var(--purple2)">⊞</span> 重置面板位置 <button class="mini" id="vm-reset-pos" style="margin-left:auto">执行</button></label>`;
  menu.innerHTML = html;
  menu.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => setPanelVisible(cb.dataset.pid, cb.checked));
  });
  const rb = $('vm-reset-pos'); if (rb) rb.onclick = (e) => { e.stopPropagation(); $('reset-layout').click(); };
}
buildViewMenu();
$('view-btn').onclick = (e) => {
  e.stopPropagation();
  const m = $('view-menu');
  m.style.display = (m.style.display === 'none' ? 'block' : 'none');
};
document.addEventListener('click', (e) => {
  const m = $('view-menu'); if (!m || m.style.display === 'none') return;
  if (e.target.closest('#view-menu') || e.target.closest('#view-btn')) return;
  m.style.display = 'none';
});

// 压缩历史
$('compact-btn').onclick = () => {
  if (!confirm('把较早的对话折叠成摘要？\n用于长会话防止 Node 内存溢出（OOM）。\n最近 6 条原文会保留。')) return;
  ws && ws.readyState === 1 && ws.send(JSON.stringify({ type: 'compact' }));
};

// ====================== Monaco 编辑器 ======================
let editor = null, diffEditor = null, monacoReady;
const tabs = new Map();
let activeTab = null;

monacoReady = new Promise((resolve) => {
  require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
  require(['vs/editor/editor.main'], () => { ensureEditor(); resolve(); });
});
function ensureEditor() {
  if (editor) return;
  const el = document.getElementById('editor-host');
  editor = monaco.editor.create(el, { value: '', language: 'plaintext', theme: 'vs-dark', automaticLayout: true, fontSize: 13, minimap: { enabled: false }, wordWrap: 'on', scrollBeyondLastLine: false });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveActive());
  editor.onDidChangeModelContent(() => {
    if (!activeTab) return;
    const t = tabs.get(activeTab); if (!t) return;
    const cur = t.model.getValue();
    const dirty = cur !== t.originalContent;
    if (t.dirty !== dirty) { t.dirty = dirty; renderTabs(); $('save-file').disabled = !dirty; }
    // 防抖保存草稿到 localStorage
    clearTimeout(t._draftTimer);
    t._draftTimer = setTimeout(() => saveDraft(activeTab, cur, t.originalContent), 400);
  });
}
function showView(which) {
  // which: 'editor' | 'nb' | 'image' | 'stl' | 'vtu' | 'pdf' | 'empty'
  document.getElementById('editor-host').style.display = which === 'editor' ? '' : 'none';
  document.getElementById('nb-host').style.display = which === 'nb' ? '' : 'none';
  const imgHost = document.getElementById('img-host'); if (imgHost) imgHost.style.display = which === 'image' ? '' : 'none';
  const stlHost = document.getElementById('stl-host'); if (stlHost) stlHost.style.display = which === 'stl' ? '' : 'none';
  const vtuHost = document.getElementById('vtu-host'); if (vtuHost) vtuHost.style.display = which === 'vtu' ? '' : 'none';
  const pdfHost = document.getElementById('pdf-host'); if (pdfHost) pdfHost.style.display = which === 'pdf' ? '' : 'none';
  document.getElementById('editor-empty').style.display = which === 'empty' ? '' : 'none';
  if (which === 'editor' && editor) setTimeout(() => editor.layout(), 0);
  if (which === 'stl' && window.__stlResize) window.__stlResize();
  if (which === 'vtu' && window.__vtuResize) window.__vtuResize();
}
function setEditorEmpty() { showView('empty'); }
setEditorEmpty();

const detectLang = p => ({ js:'javascript', ts:'typescript', jsx:'javascript', tsx:'typescript', py:'python', json:'json', md:'markdown', html:'html', css:'css', java:'java', c:'c', cpp:'cpp', h:'cpp', cs:'csharp', go:'go', rs:'rust', sh:'shell', yml:'yaml', yaml:'yaml', xml:'xml', sql:'sql' }[p.split('.').pop().toLowerCase()] || 'plaintext');

async function openFile(p) {
  if (p && p.endsWith && p.endsWith('.ipynb')) return openNotebook(p);
  // 图片预览
  if (p && /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(p)) return openImage(p);
  // STL 三维预览
  if (p && /\.stl$/i.test(p)) return openSTL(p);
  // VTK / VTU / VTP / VTI 科学可视化（vtk.js）
  if (p && /\.(vtu|vtp|vti|vtk|pvd)$/i.test(p)) return openVTU(p);
  // PDF 预览（浏览器原生）
  if (p && /\.pdf$/i.test(p)) return openPDF(p);
  // MD 轨迹文件 → 自动塞到 NGL 面板
  if (p && /\.(lammpstrj|xyz|gro|atom|dump)$/i.test(p)) return openTrajectory(p);
  await monacoReady; ensureEditor();
  // 切走前保存当前 tab 的 viewState
  if (activeTab && tabs.has(activeTab) && editor.getModel() === tabs.get(activeTab).model) {
    tabs.get(activeTab).viewState = editor.saveViewState();
  }
  let tab = tabs.get(p);
  if (!tab) {
    let r, j;
    try { r = await fetch('/api/file?path=' + encodeURIComponent(p)); j = await r.json(); }
    catch (e) { addSystem('打开失败（网络）：' + e.message); return; }
    if (j.error) { addSystem('打开失败：' + j.error); return; }
    if (j.binary) { addSystem(`二进制文件不能预览：${p}（${j.size} 字节）`); return; }
    const diskContent = j.content || '';
    // 检查 localStorage 中是否有未保存草稿
    const draft = loadDraft(p);
    let content = diskContent, dirty = false;
    if (draft && draft.diskContent === diskContent && draft.value !== diskContent) {
      // 磁盘未变，且草稿不同 → 恢复草稿
      content = draft.value; dirty = true;
      addTerm(`[草稿] 恢复 ${p} 未保存编辑`, 'sys');
    }
    tab = { model: monaco.editor.createModel(content, detectLang(p)), originalContent: diskContent, dirty, viewState: null };
    tabs.set(p, tab);
  }
  activeTab = p; editor.setModel(tab.model);
  if (tab.viewState) editor.restoreViewState(tab.viewState);
  editor.focus();
  $('save-file').disabled = !tab.dirty;
  showView('editor');
  renderTabs(); updateActiveFileChip();
  document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  const n = document.querySelector(`.tree-node[data-path="${CSS.escape(p)}"]`); if (n) n.classList.add('selected');
}

async function openImage(p) {
  // \u5728\u7f16\u8f91\u533a\u53f3\u8fb9\u5c55\u793a\u56fe\u7247
  const host = document.getElementById('img-host');
  if (!host) return;
  host.innerHTML = '';
  const img = document.createElement('img');
  img.src = '/api/file?path=' + encodeURIComponent(p) + '&raw=1&_t=' + Date.now();
  img.alt = p;
  img.onerror = () => { host.innerHTML = `<div class="muted small" style="padding:24px;">\u65e0\u6cd5\u52a0\u8f7d\u56fe\u7247\uff1a${p}</div>`; };
  const wrap = document.createElement('div'); wrap.className = 'img-wrap';
  const meta = document.createElement('div'); meta.className = 'muted small img-meta'; meta.textContent = p;
  wrap.appendChild(img);
  host.appendChild(meta);
  host.appendChild(wrap);
  activeTab = p;
  showView('image');
  renderTabs(); updateActiveFileChip();
  document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  const tn = document.querySelector(`.tree-node[data-path="${CSS.escape(p)}"]`); if (tn) tn.classList.add('selected');
  // 占个空 tab 描述项，让 closeTab 能关闭
  if (!tabs.has(p)) tabs.set(p, { image: true, model: null, dirty: false, originalContent: '' });
}

async function openPDF(p) {
  // 用 iframe 让浏览器自带 PDF.js 渲染
  const host = document.getElementById('pdf-host');
  if (!host) return;
  host.innerHTML = '';
  const url = '/api/file?path=' + encodeURIComponent(p) + '&raw=1&_t=' + Date.now();
  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line2);font-size:11px;align-items:center;';
  bar.innerHTML = `<span class="muted" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📄 ${p}</span>
    <button class="mini" id="pdf-newtab">新标签打开</button>
    <button class="mini" id="pdf-readdoc">让 agent 读取(read_document)</button>`;
  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.style.cssText = 'flex:1;width:100%;height:calc(100% - 36px);border:0;background:#fff;';
  iframe.onerror = () => { host.innerHTML = `<div class="muted small" style="padding:24px;">无法加载 PDF：${p}</div>`; };
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;width:100%;height:100%;';
  wrap.appendChild(bar);
  wrap.appendChild(iframe);
  host.appendChild(wrap);
  bar.querySelector('#pdf-newtab').onclick = () => window.open(url, '_blank');
  bar.querySelector('#pdf-readdoc').onclick = () => {
    const inp = $('input');
    inp.value = (inp.value ? inp.value + '\n' : '') + `请调用 read_document("${p}") 提取这份 PDF 的文本与图片。`;
    inp.focus();
  };
  activeTab = p;
  showView('pdf');
  renderTabs(); updateActiveFileChip();
  document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  const tn = document.querySelector(`.tree-node[data-path="${CSS.escape(p)}"]`); if (tn) tn.classList.add('selected');
  if (!tabs.has(p)) tabs.set(p, { pdf: true, model: null, dirty: false, originalContent: '' });
}

// ===================== STL 三维预览（懒加载 three.js） =====================
const STL_VIEW = { renderer: null, scene: null, camera: null, mesh: null, raf: 0, controls: null };
// 把 STLLoader / OrbitControls 里的 `from 'three'` / `from 'three/...'` 改写成完整 URL，避免依赖 importmap
async function _importThreeAddon(url, threeUrl) {
  const src = await (await fetch(url)).text();
  const patched = src
    .replace(/from\s+['"]three['"]/g, `from '${threeUrl}'`)
    .replace(/from\s+['"]three\/([^'"]+)['"]/g, (_, p) => `from 'https://cdn.jsdelivr.net/npm/three@0.160.0/${p}'`);
  const blob = new Blob([patched], { type: 'text/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  try { return await import(blobUrl); }
  finally { setTimeout(() => URL.revokeObjectURL(blobUrl), 30000); }
}
async function ensureThree() {
  if (window.THREE && window.THREE.STLLoader) return window.THREE;
  const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
  const mod = await import(THREE_URL);
  const stlMod = await _importThreeAddon('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/STLLoader.js', THREE_URL);
  const ctrlMod = await _importThreeAddon('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js', THREE_URL);
  // ESM namespace 对象是 frozen 的，不能直接挂属性，先拷成普通对象
  const THREE = { ...mod };
  THREE.STLLoader = stlMod.STLLoader;
  THREE.OrbitControls = ctrlMod.OrbitControls;
  console.log('[STL] THREE keys =', Object.keys(THREE).length, 'STLLoader =', typeof THREE.STLLoader, 'OrbitControls =', typeof THREE.OrbitControls);
  window.THREE = THREE;
  return THREE;
}
async function openSTL(p) {
  const host = document.getElementById('stl-host');
  if (!host) return;
  host.innerHTML = '<div class="muted small" style="padding:18px;">加载 STL 中…</div>';
  showView('stl');
  activeTab = p;
  if (!tabs.has(p)) tabs.set(p, { stl: true, model: null, dirty: false, originalContent: '' });
  renderTabs(); updateActiveFileChip();
  document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  const tn = document.querySelector(`.tree-node[data-path="${CSS.escape(p)}"]`); if (tn) tn.classList.add('selected');
  let THREE;
  try { THREE = await ensureThree(); } catch (e) { host.innerHTML = `<div class="muted small" style="padding:18px;color:#f88;">three.js 加载失败：${e.message}</div>`; return; }
  let buf;
  try {
    const r = await fetch('/api/file?path=' + encodeURIComponent(p) + '&raw=1');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    buf = await r.arrayBuffer();
  } catch (e) { host.innerHTML = `<div class="muted small" style="padding:18px;color:#f88;">读取失败：${e.message}</div>`; return; }
  console.log('[STL] buf bytes =', buf && buf.byteLength);
  try {
  // 清空旧场景
  if (STL_VIEW.raf) cancelAnimationFrame(STL_VIEW.raf);
  if (STL_VIEW.renderer) { STL_VIEW.renderer.dispose(); }
  host.innerHTML = '';
  const w = host.clientWidth || 600, h = host.clientHeight || 400;
  console.log('[STL] host size', w, h);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0a0612);
  const camera = new THREE.PerspectiveCamera(45, w/h, 0.01, 100000);
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h);
  host.appendChild(renderer.domElement);
  // 模型
  const geom = new THREE.STLLoader().parse(buf);
  console.log('[STL] parsed triangles =', (geom.attributes.position.count/3)|0);
  geom.computeBoundingBox(); geom.computeVertexNormals();
  const bb = geom.boundingBox; const c = new THREE.Vector3(); bb.getCenter(c);
  geom.translate(-c.x, -c.y, -c.z);
  const sz = new THREE.Vector3(); bb.getSize(sz);
  const maxD = Math.max(sz.x, sz.y, sz.z) || 1;
  const mat = new THREE.MeshPhongMaterial({ color: 0xa78bfa, specular: 0x222244, shininess: 30, flatShading: false });
  const mesh = new THREE.Mesh(geom, mat); scene.add(mesh);
  // 网格线（线框，浅色）
  const wire = new THREE.LineSegments(new THREE.WireframeGeometry(geom), new THREE.LineBasicMaterial({ color: 0x6b21a8, transparent:true, opacity:0.15 }));
  scene.add(wire);
  // 灯光
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dl = new THREE.DirectionalLight(0xffffff, 0.9); dl.position.set(1,1,1).multiplyScalar(maxD*3); scene.add(dl);
  const dl2 = new THREE.DirectionalLight(0xffffff, 0.4); dl2.position.set(-1,-0.5,-1).multiplyScalar(maxD*3); scene.add(dl2);
  // 坐标轴 + 网格
  scene.add(new THREE.AxesHelper(maxD * 0.7));
  const grid = new THREE.GridHelper(maxD * 4, 20, 0x444466, 0x222233); grid.position.y = -sz.y/2 - maxD*0.02; scene.add(grid);
  // 相机
  camera.position.set(maxD*1.6, maxD*1.6, maxD*1.6);
  camera.lookAt(0,0,0);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  STL_VIEW.scene = scene; STL_VIEW.camera = camera; STL_VIEW.renderer = renderer; STL_VIEW.mesh = mesh; STL_VIEW.controls = controls;
  function loop() { STL_VIEW.raf = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); }
  loop();
  // 信息条
  const info = document.createElement('div');
  info.style.cssText = 'position:absolute;top:6px;left:8px;font-size:11px;color:#c4b5fd;background:rgba(20,10,40,.7);padding:4px 8px;border-radius:4px;pointer-events:none;';
  const tris = (geom.index ? geom.index.count : geom.attributes.position.count) / 3;
  info.textContent = `${p}  ·  三角形 ${tris.toLocaleString()}  ·  尺寸 ${sz.x.toFixed(2)}×${sz.y.toFixed(2)}×${sz.z.toFixed(2)}  ·  鼠标拖拽旋转 / 滚轮缩放`;
  host.appendChild(info);
  window.__stlResize = () => {
    const nw = host.clientWidth, nh = host.clientHeight;
    if (nw && nh) { renderer.setSize(nw, nh); camera.aspect = nw/nh; camera.updateProjectionMatrix(); }
  };
  } catch (e) {
    console.error('[STL] render error', e);
    host.innerHTML = `<div class="muted small" style="padding:18px;color:#f88;white-space:pre-wrap;">STL 渲染错误：${e.message}\n${e.stack || ''}</div>`;
  }
}
window.addEventListener('resize', () => { if (window.__stlResize) window.__stlResize(); });

// ===================== VTU / VTP / VTI 科学可视化（懒加载 vtk.js） =====================
// 支持 .vtu / .vtp / .vti / .vtk / .pvd（pvd 只读第一个 timestep）
const VTU_VIEW = { fullScreenRenderer: null, renderer: null, renderWindow: null, actor: null, mapper: null, reader: null, lut: null, currentField: '', source: null, currentRep: 'Surface', currentSlice: null };
async function ensureVtkJs() {
  if (window.vtk) return window.vtk;
  // 用 ESM 直接 import vtk.js（注意：vtk.js 在浏览器里依赖 macroFactory + ESM 入口）
  const mod = await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/+esm');
  window.vtk = mod.default || mod;
  return window.vtk;
}
async function openVTU(p) {
  const host = document.getElementById('vtu-host');
  if (!host) return;
  host.innerHTML = '<div class="muted small" style="padding:18px;">加载 vtk.js 中…（首次需要从 CDN 下 ~1MB）</div>';
  showView('vtu');
  activeTab = p;
  if (!tabs.has(p)) tabs.set(p, { vtu: true, model: null, dirty: false, originalContent: '' });
  renderTabs(); updateActiveFileChip();
  document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  const tn = document.querySelector(`.tree-node[data-path="${CSS.escape(p)}"]`); if (tn) tn.classList.add('selected');
  let vtkNs;
  try { vtkNs = await ensureVtkJs(); }
  catch (e) { host.innerHTML = `<div class="muted small" style="padding:18px;color:#f88;">vtk.js 加载失败：${e.message}<br/>如离线环境请联网或换 CDN。</div>`; return; }
  // 解析 .pvd → 找第一个 timestep 的 dataset 文件
  let dataPath = p;
  if (/\.pvd$/i.test(p)) {
    try {
      const r = await fetch('/api/file?path=' + encodeURIComponent(p));
      const j = await r.json(); const txt = j.content || '';
      const m = txt.match(/file=["']([^"']+)["']/);
      if (m) {
        const baseDir = p.split('/').slice(0, -1).join('/');
        dataPath = baseDir ? baseDir + '/' + m[1] : m[1];
        addSystem(`pvd → 首个 timestep: ${dataPath}`);
      }
    } catch (e) { /* ignore */ }
  }
  // 拉取二进制
  let buf;
  try {
    const r = await fetch('/api/file?path=' + encodeURIComponent(dataPath) + '&raw=1');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    buf = await r.arrayBuffer();
  } catch (e) { host.innerHTML = `<div class="muted small" style="padding:18px;color:#f88;">读取失败：${e.message}</div>`; return; }
  // 选 reader
  const ext = (dataPath.split('.').pop() || '').toLowerCase();
  let Reader, defaultRep = 'Surface';
  try {
    if (ext === 'vtu') Reader = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/IO/XML/XMLUnstructuredGridReader/+esm')).default;
    else if (ext === 'vtp') Reader = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/IO/XML/XMLPolyDataReader/+esm')).default;
    else if (ext === 'vti') Reader = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/IO/XML/XMLImageDataReader/+esm')).default;
    else if (ext === 'vtk') Reader = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/IO/Legacy/LegacyAsciiReader/+esm')).default;
    else throw new Error('不支持的扩展名：.' + ext);
  } catch (e) {
    host.innerHTML = `<div class="muted small" style="padding:18px;color:#f88;">加载 reader 失败：${e.message}</div>`; return;
  }
  const FullScreenRenderWindow = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/Rendering/Misc/FullScreenRenderWindow/+esm')).default;
  const Mapper = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/Rendering/Core/Mapper/+esm')).default;
  const Actor = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/Rendering/Core/Actor/+esm')).default;
  const ColorTransferFunction = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/Rendering/Core/ColorTransferFunction/+esm')).default;
  const ColorMaps = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/Rendering/Core/ColorTransferFunction/ColorMaps/+esm')).default;

  // 清空旧实例
  if (VTU_VIEW.fullScreenRenderer) { try { VTU_VIEW.fullScreenRenderer.delete(); } catch {} }
  host.innerHTML = '';
  // 上方控件条
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'position:absolute;top:6px;left:8px;right:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px;color:#c4b5fd;background:rgba(20,10,40,.78);padding:5px 8px;border-radius:4px;z-index:5;';
  toolbar.innerHTML = `
    <span style="font-weight:600;">vtk.js</span>
    <span class="muted">${dataPath}</span>
    <span style="flex:1;"></span>
    <span class="small muted">场</span>
    <select id="vtu-field" style="font-size:10px;background:var(--bg2);border:1px solid var(--line2);color:var(--text);border-radius:3px;padding:1px 4px;"></select>
    <span class="small muted">调色板</span>
    <select id="vtu-cmap" style="font-size:10px;background:var(--bg2);border:1px solid var(--line2);color:var(--text);border-radius:3px;padding:1px 4px;">
      <option value="Cool to Warm">CoolWarm</option>
      <option value="Rainbow Desaturated">Rainbow</option>
      <option value="Viridis (matplotlib)">Viridis</option>
      <option value="Plasma (matplotlib)">Plasma</option>
      <option value="Black-Body Radiation">BlackBody</option>
      <option value="Grayscale">Grayscale</option>
    </select>
    <span class="small muted">表现</span>
    <select id="vtu-rep" style="font-size:10px;background:var(--bg2);border:1px solid var(--line2);color:var(--text);border-radius:3px;padding:1px 4px;">
      <option value="Surface">Surface</option>
      <option value="Surface with edges">Surface+Edges</option>
      <option value="Wireframe">Wireframe</option>
      <option value="Points">Points</option>
    </select>
    <button class="mini" id="vtu-reset" title="重置视图">重置</button>
    <button class="mini" id="vtu-parallel" title="合并所有 processor*/VTK 分块（并行结果）" style="display:none;">合并并行</button>
  `;
  host.appendChild(toolbar);

  // 渲染窗
  const fsrw = FullScreenRenderWindow.newInstance({ rootContainer: host, background: [0.04, 0.024, 0.078] });
  const renderer = fsrw.getRenderer();
  const renderWindow = fsrw.getRenderWindow();
  const reader = Reader.newInstance();
  try { reader.parseAsArrayBuffer(buf); } catch (e) {
    // legacy reader 用 text
    try { const txt = new TextDecoder().decode(buf); reader.parseAsText(txt); } catch (e2) {
      host.innerHTML = `<div class="muted small" style="padding:18px;color:#f88;">解析失败：${e.message}</div>`; return;
    }
  }
  const source = reader.getOutputData(0);
  const mapper = Mapper.newInstance({ interpolateScalarsBeforeMapping: true });
  mapper.setInputData(source);
  const actor = Actor.newInstance(); actor.setMapper(mapper);
  // 调色板
  const lut = ColorTransferFunction.newInstance();
  const applyColormap = (name) => {
    const preset = ColorMaps.getPresetByName(name) || ColorMaps.getPresetByName('Cool to Warm');
    lut.removeAllPoints(); lut.applyColorMap(preset);
    mapper.setLookupTable(lut);
  };
  applyColormap('Cool to Warm');
  mapper.setScalarVisibility(true);
  renderer.addActor(actor);

  // 收集可用场（point/cell data）
  const fields = [];
  try {
    const pd = source.getPointData(); const cd = source.getCellData();
    for (let i = 0; i < pd.getNumberOfArrays(); i++) fields.push({ name: pd.getArrayByIndex(i).getName(), loc: 'point' });
    for (let i = 0; i < cd.getNumberOfArrays(); i++) fields.push({ name: cd.getArrayByIndex(i).getName(), loc: 'cell' });
  } catch {}
  const sel = toolbar.querySelector('#vtu-field');
  sel.innerHTML = '<option value="">(单色)</option>' + fields.map(f => `<option value="${f.loc}::${f.name}">${f.name} (${f.loc})</option>`).join('');
  const applyField = (val) => {
    if (!val) { mapper.setScalarVisibility(false); renderWindow.render(); return; }
    const [loc, name] = val.split('::');
    try {
      const arr = (loc === 'point' ? source.getPointData() : source.getCellData()).getArrayByName(name);
      if (!arr) return;
      const [lo, hi] = arr.getRange();
      lut.setMappingRange(lo, hi); lut.updateRange();
      mapper.setScalarModeToUsePointFieldData ? null : null;
      if (loc === 'point') { source.getPointData().setActiveScalars(name); mapper.setScalarModeToUsePointFieldData(); }
      else { source.getCellData().setActiveScalars(name); mapper.setScalarModeToUseCellFieldData(); }
      mapper.setColorByArrayName(name);
      mapper.setScalarVisibility(true);
      renderWindow.render();
    } catch (e) { addSystem('场切换失败：' + e.message); }
  };
  sel.onchange = () => applyField(sel.value);
  // 默认选第一个 vector / scalar
  if (fields.length) { sel.value = `${fields[0].loc}::${fields[0].name}`; applyField(sel.value); }

  toolbar.querySelector('#vtu-cmap').onchange = (e) => { applyColormap(e.target.value); renderWindow.render(); };
  toolbar.querySelector('#vtu-rep').onchange = (e) => {
    const v = e.target.value;
    const prop = actor.getProperty();
    if (v === 'Surface') { prop.setRepresentation(2); prop.setEdgeVisibility(false); }
    else if (v === 'Surface with edges') { prop.setRepresentation(2); prop.setEdgeVisibility(true); prop.setEdgeColor(0.4, 0.3, 0.7); }
    else if (v === 'Wireframe') { prop.setRepresentation(1); prop.setEdgeVisibility(false); }
    else if (v === 'Points') { prop.setRepresentation(0); prop.setPointSize(2); }
    renderWindow.render();
  };
  toolbar.querySelector('#vtu-reset').onclick = () => { renderer.resetCamera(); renderWindow.render(); };

  // —— 并行（processorN/VTK/…） 合并按钮 ——
  const parallelBtn = toolbar.querySelector('#vtu-parallel');
  const procMatch = dataPath.match(/^(.*?)\/processor(\d+)\/VTK\/(.+?)_(\d+)\.vtu$/i);
  if (procMatch && parallelBtn) {
    parallelBtn.style.display = '';
    parallelBtn.onclick = async () => {
      try {
        parallelBtn.textContent = '加载分块中…';
        parallelBtn.disabled = true;
        const [, caseDir, , base, tsIdx] = procMatch;
        const flat = await (await fetch('/api/flat')).json();
        const pat = new RegExp(`^${caseDir.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')}/processor\\d+/VTK/${base.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')}_${tsIdx}\\.vtu$`);
        const parts = (flat.files || []).map(f => f.path || f).filter(p => pat.test(p));
        if (!parts.length) { addSystem('未找到并行分块'); parallelBtn.textContent = '合并并行'; parallelBtn.disabled = false; return; }
        addSystem(`合并 ${parts.length} 个 processor 分块…`);
        // 拉所有分块，给每个建独立 actor，共享 lut + colorByArrayName
        const ReaderU = (await import('https://cdn.jsdelivr.net/npm/@kitware/vtk.js@30.7.0/IO/XML/XMLUnstructuredGridReader/+esm')).default;
        // 先移除原 actor
        renderer.removeActor(actor);
        const partActors = [];
        for (const pp of parts) {
          const r2 = await fetch('/api/file?raw=1&path=' + encodeURIComponent(pp));
          if (!r2.ok) continue;
          const b2 = await r2.arrayBuffer();
          const rd = ReaderU.newInstance();
          rd.parseAsArrayBuffer(b2);
          const src2 = rd.getOutputData(0);
          const map2 = Mapper.newInstance({ interpolateScalarsBeforeMapping: true });
          map2.setInputData(src2);
          map2.setLookupTable(lut);
          map2.setScalarVisibility(mapper.getScalarVisibility());
          const sa = mapper.getColorByArrayName ? mapper.getColorByArrayName() : null;
          if (sa) { map2.setColorByArrayName(sa); map2.setScalarModeToUsePointFieldData(); }
          const ac = Actor.newInstance(); ac.setMapper(map2);
          renderer.addActor(ac);
          partActors.push({ ac, map2, src2 });
        }
        renderer.resetCamera();
        renderWindow.render();
        addSystem(`并行合并完成：${partActors.length} 块`);
        parallelBtn.textContent = `已合并 ${partActors.length} 块`;
        // 重写场切换：作用到所有 actor
        const oldOnChange = sel.onchange;
        sel.onchange = () => {
          const v = sel.value;
          if (!v) { partActors.forEach(p => p.map2.setScalarVisibility(false)); renderWindow.render(); return; }
          const [loc, name] = v.split('::');
          partActors.forEach(p => {
            try {
              const arr = (loc === 'point' ? p.src2.getPointData() : p.src2.getCellData()).getArrayByName(name);
              if (!arr) return;
              if (loc === 'point') { p.src2.getPointData().setActiveScalars(name); p.map2.setScalarModeToUsePointFieldData(); }
              else { p.src2.getCellData().setActiveScalars(name); p.map2.setScalarModeToUseCellFieldData(); }
              p.map2.setColorByArrayName(name);
              p.map2.setScalarVisibility(true);
            } catch {}
          });
          // 用第一块的范围设 LUT
          try {
            const arr0 = (loc === 'point' ? partActors[0].src2.getPointData() : partActors[0].src2.getCellData()).getArrayByName(name);
            if (arr0) { const [lo, hi] = arr0.getRange(); lut.setMappingRange(lo, hi); lut.updateRange(); }
          } catch {}
          renderWindow.render();
        };
        if (sel.value) sel.onchange();
      } catch (e) {
        addSystem('并行合并失败：' + e.message);
        parallelBtn.disabled = false; parallelBtn.textContent = '合并并行';
      }
    };
  }

  renderer.resetCamera();
  renderWindow.render();

  // 信息条
  const info = document.createElement('div');
  info.style.cssText = 'position:absolute;bottom:6px;left:8px;font-size:10px;color:#c4b5fd;background:rgba(20,10,40,.7);padding:4px 8px;border-radius:4px;pointer-events:none;';
  let nPts = 0, nCells = 0;
  try { nPts = source.getNumberOfPoints(); nCells = source.getNumberOfCells(); } catch {}
  info.textContent = `点 ${nPts.toLocaleString()} · 单元 ${nCells.toLocaleString()} · 场 ${fields.length} · 鼠标拖拽旋转 / 滚轮缩放 / 右键平移`;
  host.appendChild(info);

  VTU_VIEW.fullScreenRenderer = fsrw;
  VTU_VIEW.renderer = renderer; VTU_VIEW.renderWindow = renderWindow;
  VTU_VIEW.mapper = mapper; VTU_VIEW.actor = actor; VTU_VIEW.lut = lut; VTU_VIEW.reader = reader; VTU_VIEW.source = source;

  window.__vtuResize = () => {
    try { fsrw.resize(); } catch {}
  };
}
window.addEventListener('resize', () => { if (window.__vtuResize) window.__vtuResize(); });

function reloadOpenFile(p) {
  const t = tabs.get(p); if (!t) return;
  if (t.dirty) return; // 脉守未保存草稿
  fetch('/api/file?path=' + encodeURIComponent(p)).then(r => r.json()).then(j => {
    if (typeof j.content !== 'string') return;
    if (j.content === t.originalContent) return;
    t.model.setValue(j.content); t.originalContent = j.content; t.dirty = false;
    if (activeTab === p) $('save-file').disabled = true; renderTabs();
  }).catch(()=>{});
}

// 草稿持久化 (localStorage)
const DRAFT_KEY = 'codemax.drafts.v1';
function loadAllDrafts() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); } catch { return {}; } }
function loadDraft(p) { return loadAllDrafts()[p] || null; }
function saveDraft(p, value, diskContent) {
  const all = loadAllDrafts();
  if (value === diskContent) delete all[p];
  else all[p] = { value, diskContent, ts: Date.now() };
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(all)); } catch {}
}
function clearDraft(p) { const all = loadAllDrafts(); delete all[p]; try { localStorage.setItem(DRAFT_KEY, JSON.stringify(all)); } catch {} }
function closeTab(p) {
  const t = tabs.get(p); if (!t) return;
  if (t.dirty && !confirm(`${p} 未保存，关闭？（草稿将保留在本地缓存）`)) return;
  t.model.dispose(); tabs.delete(p);
  if (activeTab === p) {
    const r = [...tabs.keys()];
    if (r.length) openFile(r[r.length-1]);
    else { activeTab = null; setEditorEmpty(); $('save-file').disabled = true; renderTabs(); updateActiveFileChip(); }
  } else renderTabs();
}
function renderTabs() {
  const tabsEl = $('tabs'); tabsEl.innerHTML = '';
  for (const [p, t] of tabs) {
    const div = document.createElement('div');
    div.className = 'tab' + (p === activeTab ? ' active' : '') + (t.dirty ? ' dirty' : '');
    div.innerHTML = `<span class="name"></span><span class="x">×</span>`;
    div.querySelector('.name').textContent = p.split('/').pop();
    div.title = p;
    div.onclick = (e) => { if (e.target.classList.contains('x')) return closeTab(p); openFile(p); };
    div.querySelector('.x').onclick = (e) => { e.stopPropagation(); closeTab(p); };
    tabsEl.appendChild(div);
  }
}
async function saveActive() {
  if (!activeTab) return; const t = tabs.get(activeTab); if (!t || !t.dirty) return;
  const content = t.model.getValue();
  const r = await fetch('/api/file', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: activeTab, content }) });
  const j = await r.json();
  if (j.ok) { t.originalContent = content; t.dirty = false; $('save-file').disabled = true; renderTabs(); clearDraft(activeTab); addTerm(`[已保存 ${activeTab}（${j.bytes}B）]`, 'sys'); }
  else addSystem('保存失败：' + (j.error || '未知错误'));
}
$('save-file').onclick = saveActive;

function updateActiveFileChip() {
  if (activeTab) { $('active-file-chip').style.display = ''; $('active-file-name').textContent = activeTab; }
  else { $('active-file-chip').style.display = 'none'; $('active-file-toggle').checked = false; }
}

// ====================== WS 与状态 ======================
let ws, currentAssistantBubble = null;
const toolEls = new Map();
const toolNames = new Map();
let attachments = [];
let allFiles = [];
let platform = 'win32';

function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = (e) => { noteServerActivity(); handleMessage(JSON.parse(e.data)); };
  ws.onclose = () => { addSystem('连接断开，重连中...'); setTimeout(connect, 1000); };
  ws.onopen = () => { addTerm('[已连接 MDriver]', 'sys');
    ws.send(JSON.stringify({ type: 'set_auto', value: $('auto-mode').checked }));
    try { ws.send(JSON.stringify({ type: 'skill_list' })); } catch {} };
}
connect();

fetch('/api/config').then(r => r.json()).then(c => {
  $('ws-display').textContent = c.workspace;
  // 顶部不再重复显示模型名（按钮里已有）
  document.title = c.name || 'MDriver';
  platform = c.platform;
  $('shell-name').textContent = '· ' + (platform === 'win32' ? 'cmd.exe' : 'bash');
  $('term-prompt').textContent = platform === 'win32' ? '>' : '$';
  updatePyLabel(c.pythonPath || '');
});

// ====================== Python 解释器选择器 ======================
let pyCurrent = '';
function updatePyLabel(p) {
  pyCurrent = p || '';
  const el = $('py-label'); if (!el) return;
  if (!p) { el.textContent = '未选择'; return; }
  const name = p.split(/[\\/]/).pop();
  const parent = p.split(/[\\/]/).slice(-2, -1)[0] || '';
  el.textContent = parent ? `${parent}/${name}` : name;
}
function renderPyList(envs, current) {
  const list = $('py-list');
  if (!envs.length) { list.innerHTML = '<div class="muted small" style="padding:20px;text-align:center;">未发现 Python（请用「手动选择」）</div>'; return; }
  list.innerHTML = '';
  for (const e of envs) {
    const div = document.createElement('div');
    div.className = 'py-item' + (e.path === current ? ' current' : '');
    const conda = e.conda ? `<span class="py-conda">conda: ${e.conda}</span>` : '';
    div.innerHTML = `<div><span class="py-ver">Python ${e.version || '?'}</span>${conda}</div><div class="py-path">${e.path}</div>`;
    div.onclick = async () => {
      const r = await fetch('/api/python/select', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: e.path }) });
      const j = await r.json();
      if (j.ok) { updatePyLabel(j.current); $('py-modal').style.display='none'; addTerm(`[Python] 已切换为 ${j.current}`, 'ok'); }
      else addTerm(`[Python] ${j.error || '切换失败'}`, 'err');
    };
    list.appendChild(div);
  }
}
async function loadPyList(refresh) {
  $('py-list').innerHTML = '<div class="muted small" style="padding:20px;text-align:center;">扫描中…</div>';
  const r = await fetch('/api/python/list' + (refresh ? '?refresh=1' : ''));
  const j = await r.json();
  renderPyList(j.envs || [], j.current || '');
}
$('py-picker').onclick = () => { $('py-modal').style.display = 'flex'; loadPyList(false); };
$('py-close').onclick = $('py-cancel').onclick = () => $('py-modal').style.display = 'none';
$('py-refresh').onclick = () => loadPyList(true);
$('py-clear').onclick = async () => {
  await fetch('/api/python/select', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: '' }) });
  updatePyLabel(''); loadPyList(false); addTerm('[Python] 已清除选择', 'sys');
};
$('py-browse').onclick = async () => {
  const p = prompt('输入 Python 解释器完整路径（如 C:\\Python311\\python.exe）：', pyCurrent);
  if (!p) return;
  const r = await fetch('/api/python/select', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: p }) });
  const j = await r.json();
  if (j.ok) { updatePyLabel(j.current); addTerm(`[Python] 已切换为 ${j.current}`, 'ok'); loadPyList(false); }
  else addTerm(`[Python] ${j.error || '路径无效'}`, 'err');
};
function refreshFlat() { fetch('/api/flat').then(r => r.json()).then(j => { allFiles = j.files || []; }).catch(()=>{}); }
refreshFlat();

// ====================== 头部按钮 ======================
$('reset').onclick = () => { if (!confirm('清空对话和检查点？')) return; ws.send(JSON.stringify({ type: 'reset' })); $('chat').innerHTML=''; toolEls.clear(); clearChatHistory(); };
$('stop').onclick = () => {
  ws.send(JSON.stringify({ type: 'stop' }));
  addTerm('[请求停止...]', 'sys');
  // 安全网：服务端如果没能及时发 agent_end（网络卡/总结生成中），2.5s 后强制释放输入框
  setTimeout(() => { setRunning(false); $('input').focus(); }, 2500);
};
if ($('kill-all')) $('kill-all').onclick = () => {
  if (!confirm('强行终止会杀死所有后台进程：\n· 当前 Agent 以及 run_command 进程\n· 所有 LAMMPS 后台作业（lmp_run_async 启动的）\n· 后台 Python / Packmol / 渲染进程\n· 用户终端 shell\n\n未保存的计算结果会丢失。确定？')) return;
  ws.send(JSON.stringify({ type: 'kill_all' }));
  addTerm('[强行终止] 已发送...', 'sys');
  setTimeout(() => { setRunning(false); $('input').focus(); }, 1500);
};
$('send').onclick = send;
$('input').addEventListener('keydown', onInputKey);
$('input').addEventListener('input', onInputChange);
$('auto-mode').onchange = () => ws.send(JSON.stringify({ type: 'set_auto', value: $('auto-mode').checked }));
$('clear-term').onclick = () => { $('terminal').innerHTML = ''; };
$('kill-shell').onclick = () => { ws.send(JSON.stringify({ type: 'pty_kill' })); addTerm('[shell 已重启]', 'sys'); };

// ====================== 发送 ======================
let _isRunning = false;
function send() {
  const text = $('input').value.trim();
  // 运行中拦截普通消息：避免并发开第二个 agent，把会话状态搞乱。斜杠命令仍放行。
  if (_isRunning && !text.startsWith('/')) {
    addSystem('⏳ Agent 还在运行中，请等当前任务结束（或点 ⏹ 停止）后再发送。');
    return;
  }
  if (!text && attachments.length === 0 && !$('active-file-toggle').checked) return;
  if (ws.readyState !== WebSocket.OPEN) return;
  // 斜杠命令（不发给模型）
  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ');
    if (cmd === 'clear' || cmd === 'reset') { ws.send(JSON.stringify({ type: 'reset' })); $('chat').innerHTML=''; toolEls.clear(); clearChatHistory(); $('input').value=''; USAGE.input=0; USAGE.output=0; USAGE.calls=0; updateModelLabel(); addSystem('对话已清空'); return; }
    if (cmd === 'compact') { ws.send(JSON.stringify({ type: 'compact' })); $('input').value=''; addSystem('正在压缩上下文…'); return; }
    if (cmd === 'model') { $('input').value=''; $('model-picker').click(); return; }
    if (cmd === 'tools') { $('input').value=''; $('tools-btn').click(); return; }
    if (cmd === 'py' || cmd === 'python') { $('input').value=''; $('py-picker').click(); return; }
    if (cmd === 'help') { $('input').value=''; addSystem('可用命令：/clear 清空对话 · /compact 压缩历史 · /model 切换模型 · /tools 工具开关 · /py 切换 Python · /help'); return; }
    addSystem('未知命令：/' + cmd + '（输入 /help 查看）'); return;
  }
  const finalAtts = [...attachments];
  if ($('active-file-toggle').checked && activeTab) finalAtts.push({ type: 'context_file', path: activeTab, name: activeTab });
  let textOut = text;
  for (const a of attachments) if (a.type === 'file' && a.inlineContent !== undefined) textOut += `\n\n--- 附件 ${a.name} ---\n${a.inlineContent}\n--- 结束 ---`;
  addUser(text, finalAtts);
  ws.send(JSON.stringify({ type: 'user', text: textOut, attachments: finalAtts.filter(a => a.type === 'image' || a.type === 'context_file').map(a => a.type === 'image' ? { type:'image', dataUrl:a.dataUrl, name:a.name } : { type:'context_file', path:a.path }) }));
  $('input').value = ''; attachments = []; renderAttachments(); setRunning(true);
}
function setRunning(r) {
  _isRunning = r;
  const sendBtn = $('send');
  sendBtn.disabled = r; $('stop').disabled = !r;
  // 清晰的视觉状态：运行中按钮变“运行中…”并置灰，结束恢复“发送 ⏎”，用户一眼能分辨。
  if (r) {
    sendBtn.textContent = '运行中…';
    sendBtn.classList.add('running');
    $('input').setAttribute('placeholder', 'Agent 运行中… 结束后即可继续输入（⏹ 可随时停止）');
    _lastProgressAt = Date.now();
    showPhase('llm_thinking', '启动中…'); _phaseStart = Date.now(); startPhaseTick();
  } else {
    sendBtn.textContent = '发送 ⏎';
    sendBtn.classList.remove('running');
    $('input').setAttribute('placeholder', '向 MDriver 发出指令… @文件 引用，Ctrl/⌘+Enter 发送');
    clearStuckWatchdog(); stopPhaseTick(); hidePhase();
  }
}

// ============== Agent 状态带（V4 step/tool/elapsed） ==============
let _phaseState = { phase: 'idle', detail: '', tool: '', step: 0, maxSteps: 0, startedAt: 0, lastEventAt: 0 };
let _phaseStart = 0;
let _phaseTick = 0;
const _actionLog = []; // [{t, phase, tool, detail, ok, ms}]
function ensurePhaseBar() {
  let bar = document.getElementById('agent-phase-bar');
  if (bar) return bar;
  bar = document.createElement('div');
  bar.id = 'agent-phase-bar';
  bar.className = 'agent-phase-bar';
  bar.innerHTML = `
    <span class="ph-spin"></span>
    <span class="ph-icon" id="ph-icon">🤔</span>
    <span class="ph-step" id="ph-step">·/·</span>
    <span class="ph-text" id="ph-text">启动中…</span>
    <span class="ph-tool" id="ph-tool" style="display:none;"></span>
    <span class="ph-clock" id="ph-clock">0s</span>
    <span class="ph-elapsed" id="ph-elapsed"></span>
    <button class="ph-toggle-log" id="ph-toggle-log" title="展开/收起动作历史">📜</button>
  `;
  document.body.appendChild(bar);
  // 动作历史下拉
  const log = document.createElement('div');
  log.id = 'agent-action-log';
  log.className = 'agent-action-log';
  log.style.display = 'none';
  document.body.appendChild(log);
  document.getElementById('ph-toggle-log').onclick = () => {
    log.style.display = log.style.display === 'none' ? 'block' : 'none';
  };
  return bar;
}
function showPhase(phase, detail, tool, extra = {}) {
  const bar = ensurePhaseBar();
  bar.style.display = 'flex';
  _phaseState.phase = phase; _phaseState.detail = detail || ''; _phaseState.tool = tool || '';
  if (typeof extra.step === 'number') _phaseState.step = extra.step;
  if (typeof extra.maxSteps === 'number') _phaseState.maxSteps = extra.maxSteps;
  _phaseState.lastEventAt = Date.now();
  const ico = { llm_thinking: '🤔', streaming: '✍️', tool_exec: '⚙️', tool_running: '⚙️', tool_done: '✅', planning: '📋', awaiting_user: '✋', idle: '✅' }[phase] || '⏳';
  document.getElementById('ph-icon').textContent = ico;
  document.getElementById('ph-text').textContent = detail || phase;
  const stepEl = document.getElementById('ph-step');
  if (_phaseState.maxSteps) stepEl.textContent = `${_phaseState.step}/${_phaseState.maxSteps}`; else stepEl.textContent = '';
  const toolEl = document.getElementById('ph-tool');
  if (tool) { toolEl.style.display = 'inline-block'; toolEl.textContent = tool; } else { toolEl.style.display = 'none'; }
  bar.classList.toggle('streaming', phase === 'streaming');
  bar.classList.toggle('tool', phase === 'tool_exec' || phase === 'tool_running');
  bar.classList.toggle('thinking', phase === 'llm_thinking');
  bar.classList.toggle('stuck', false);
  // 入历史
  if (phase === 'tool_exec' || phase === 'tool_done' || phase === 'llm_thinking' || phase === 'idle') {
    _actionLog.push({ t: Date.now(), phase, tool: tool || '', detail: detail || '', ok: extra.ok !== false, ms: extra.tool_ms || 0 });
    if (_actionLog.length > 200) _actionLog.shift();
    renderActionLog();
  }
}
function renderActionLog() {
  const el = document.getElementById('agent-action-log');
  if (!el || el.style.display === 'none') return;
  const html = _actionLog.slice(-50).reverse().map(a => {
    const ts = new Date(a.t).toLocaleTimeString('en-GB');
    const icon = a.phase === 'tool_done' ? (a.ok ? '✅' : '❌') : (a.phase === 'tool_exec' ? '⚙️' : (a.phase === 'llm_thinking' ? '🤔' : '·'));
    const ms = a.ms ? ` <span class="al-ms">${(a.ms/1000).toFixed(1)}s</span>` : '';
    const tool = a.tool ? ` <code>${a.tool}</code>` : '';
    return `<div class="al-row"><span class="al-ts">${ts}</span> ${icon}${tool}${ms} <span class="al-detail">${a.detail}</span></div>`;
  }).join('');
  el.innerHTML = `<div class="al-header">动作历史 (最近 ${Math.min(_actionLog.length, 50)} / 共 ${_actionLog.length})</div>` + html;
}
function hidePhase() {
  const bar = document.getElementById('agent-phase-bar');
  if (bar) bar.style.display = 'none';
  const log = document.getElementById('agent-action-log');
  if (log) log.style.display = 'none';
}
function startPhaseTick() {
  stopPhaseTick();
  _phaseTick = setInterval(() => {
    const clk = document.getElementById('ph-clock');
    const el = document.getElementById('ph-elapsed'); if (!el || !clk) return;
    const totalSec = Math.floor((Date.now() - _phaseStart) / 1000);
    const sinceProgress = Math.floor((Date.now() - _lastProgressAt) / 1000);
    clk.textContent = `${totalSec}s`;
    let warn = '';
    if (_phaseState.phase === 'llm_thinking' && sinceProgress > 15) warn = ` ⚠ LLM 无响应 ${sinceProgress}s`;
    else if ((_phaseState.phase === 'tool_exec' || _phaseState.phase === 'tool_running') && sinceProgress > 30) warn = ` ⚠ 工具卡 ${sinceProgress}s`;
    el.textContent = warn;
    document.getElementById('agent-phase-bar')?.classList.toggle('stuck', !!warn);
    checkStall();
  }, 500);
}
function stopPhaseTick() { if (_phaseTick) { clearInterval(_phaseTick); _phaseTick = 0; } }

// ============== 卡死自愈：基于"真实进度"判定，避免 2s 心跳把卡死掩盖 ==============
// 关键修复：等首个 token 时服务端每 2s 发一次 phase 心跳，若用"收到任何消息"判活，
// 永远不会触发恢复。改为只在 delta/工具/流式 等"真实进度"事件时刷新 _lastProgressAt。
const STALL_MS = 40_000; // 40s 没有任何真实进度就给出可点击的强制恢复入口
let _lastServerMsgAt = Date.now();
let _lastProgressAt = Date.now();
function noteServerActivity() { _lastServerMsgAt = Date.now(); }
function noteProgress() { _lastProgressAt = Date.now(); _removeRecoverBar(); }
function _removeRecoverBar() { const b = document.getElementById('stuck-recover-bar'); if (b) b.remove(); }
function _showRecoverBar(idleSec) {
  let bar = document.getElementById('stuck-recover-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'stuck-recover-bar';
    bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:64px;z-index:10000;display:flex;gap:8px;align-items:center;background:#3a2326;border:1px solid #bf616a;color:#ffd9d9;padding:8px 12px;border-radius:8px;font-size:12px;box-shadow:0 4px 16px rgba(0,0,0,.45);';
    document.body.appendChild(bar);
  } else {
    bar.innerHTML = '';
  }
  const msg = document.createElement('span');
  msg.innerHTML = `⚠ 已 <b>${idleSec}s</b> 无新进度（可能 LLM/网络卡住）。`;
  bar.appendChild(msg);
  const stopBtn = document.createElement('button');
  stopBtn.textContent = '⏹ 停止并恢复';
  stopBtn.style.cssText = 'padding:4px 10px;border-radius:6px;border:1px solid #bf616a;background:#bf616a;color:#fff;cursor:pointer;';
  stopBtn.onclick = () => { try { ws.send(JSON.stringify({ type: 'stop' })); } catch {} setRunning(false); $('input').focus(); _removeRecoverBar(); };
  const waitBtn = document.createElement('button');
  waitBtn.textContent = '继续等待';
  waitBtn.style.cssText = 'padding:4px 10px;border-radius:6px;border:1px solid #4c566a;background:#2e3440;color:#d8dee9;cursor:pointer;';
  waitBtn.onclick = () => { _lastProgressAt = Date.now(); _removeRecoverBar(); };
  bar.appendChild(stopBtn); bar.appendChild(waitBtn);
}
// 由 startPhaseTick（每 500ms）调用：运行中且超过 STALL_MS 无真实进度 → 弹恢复条
function checkStall() {
  if (!_isRunning) { _removeRecoverBar(); return; }
  // 只在"等 LLM / 流式输出"阶段判卡死；工具可能合法长跑（如 lmp 仿真），不误报。
  const llmPhase = _phaseState.phase === 'llm_thinking' || _phaseState.phase === 'streaming' || _phaseState.phase === 'planning';
  if (!llmPhase) { _removeRecoverBar(); return; }
  const idle = Date.now() - _lastProgressAt;
  if (idle >= STALL_MS) _showRecoverBar(Math.round(idle / 1000));
}
function clearStuckWatchdog() { _removeRecoverBar(); }

// ====================== @mention ======================
let mentionState = null;
function onInputChange() {
  const v = $('input').value, cur = $('input').selectionStart;
  let i = cur - 1;
  while (i >= 0 && !/\s/.test(v[i])) {
    if (v[i] === '@') { const q = v.slice(i+1, cur).toLowerCase(); const it = allFiles.filter(f => f.toLowerCase().includes(q)).slice(0,30);
      if (it.length) { mentionState = { start:i, query:q, items:it, selected:0 }; return renderMentions(); } break; }
    i--;
  }
  hideMentions();
}
function onInputKey(e) {
  if (mentionState && $('mention-pop').style.display !== 'none') {
    if (e.key === 'ArrowDown') { e.preventDefault(); mentionState.selected = (mentionState.selected+1) % mentionState.items.length; return renderMentions(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); mentionState.selected = (mentionState.selected-1+mentionState.items.length) % mentionState.items.length; return renderMentions(); }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) { e.preventDefault(); return pickMention(mentionState.items[mentionState.selected]); }
    if (e.key === 'Escape') return hideMentions();
  }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
}
function renderMentions() {
  const pop = $('mention-pop'); pop.innerHTML = '';
  mentionState.items.forEach((f, i) => { const d = document.createElement('div'); d.className = 'mention-item' + (i === mentionState.selected ? ' selected' : ''); d.textContent = f;
    d.onmousedown = (e) => { e.preventDefault(); pickMention(f); }; pop.appendChild(d); });
  pop.style.display = '';
}
function hideMentions() { $('mention-pop').style.display = 'none'; mentionState = null; }
function pickMention(f) {
  if (!mentionState) return;
  const v = $('input').value, before = v.slice(0, mentionState.start), after = v.slice($('input').selectionStart);
  $('input').value = before + '@' + f + ' ' + after;
  const c = before.length + f.length + 2; $('input').setSelectionRange(c, c); $('input').focus(); hideMentions();
}

// ====================== 附件 ======================
$('attach-file').onclick = () => $('file-picker').click();
$('attach-image').onclick = () => $('image-picker').click();
$('file-picker').onchange = async (e) => {
  for (const f of e.target.files) {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const BIN_EXT = new Set(['pdf','docx','pptx','xlsx','doc','ppt','xls','png','jpg','jpeg','gif','webp','bmp','tiff','tif','zip','tar','gz','7z','exe','dll','so','bin','stl','vtu','vtk']);
    const isBin = BIN_EXT.has(ext) || f.size > 2 * 1024 * 1024; // >2MB 也走上传，避免 utf8 串爆 prompt
    if (isBin) {
      try {
        const buf = await f.arrayBuffer();
        // base64 编码（分块避免 call stack 溢出）
        let bin = ''; const u8 = new Uint8Array(buf); const CH = 0x8000;
        for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
        const b64 = btoa(bin);
        const r = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name, base64: b64 }) });
        const j = await r.json();
        if (j.ok) {
          attachments.push({ type: 'context_file', name: f.name, path: j.path, size: f.size, _binary: true });
          addTerm(`[附件] ${f.name} → ${j.path} (${(f.size/1024).toFixed(1)} KB) — 已保存到工作区，agent 可调 read_document 读取`, 'sys');
        } else {
          addSystem('附件上传失败：' + (j.error || '未知'));
        }
      } catch (err) {
        addSystem('附件上传失败：' + err.message);
      }
    } else {
      const t = await f.text().catch(() => '');
      attachments.push({ type:'file', name:f.name, inlineContent:t, size:f.size });
    }
  }
  renderAttachments(); $('file-picker').value = '';
};
$('image-picker').onchange = async (e) => {
  for (const f of e.target.files) { const d = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); }); attachments.push({ type:'image', name:f.name, dataUrl:d, size:f.size }); }
  renderAttachments(); $('image-picker').value = '';
};
function renderAttachments() {
  const el = $('attachments'); el.innerHTML = '';
  attachments.forEach((a, i) => {
    const d = document.createElement('span'); d.className = 'chip ' + (a.type === 'image' ? 'image' : '');
    if (a.type === 'image') d.innerHTML = `<img src="${a.dataUrl}"/><span class="name"></span><span class="x">×</span>`;
    else d.innerHTML = `📎 <span class="name"></span><span class="x">×</span>`;
    d.querySelector('.name').textContent = a.name;
    d.querySelector('.x').onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    el.appendChild(d);
  });
}

// ====================== 新建/打开 ======================
$('refresh-tree') && ($('refresh-tree').onclick = async () => {
  try { const r = await fetch('/api/tree'); const j = await r.json(); renderTree(j); addSystem('资源管理器已刷新'); }
  catch (e) { addSystem('刷新失败：' + e.message); }
});
$('new-file').onclick = async () => { const n = prompt('新文件相对路径', 'untitled.txt'); if (!n) return;
  const r = await fetch('/api/fs', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({op:'create', path:n, isDir:false})});
  const j = await r.json(); if (j.ok) setTimeout(() => openFile(n), 300); else addSystem('新建失败：' + j.error); };
$('new-folder').onclick = async () => { const n = prompt('新目录', 'newfolder'); if (!n) return;
  const r = await fetch('/api/fs', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({op:'create', path:n, isDir:true})});
  const j = await r.json(); if (!j.ok) addSystem('新建失败：' + j.error); };

const pickerModal = $('picker-modal'), pickerList = $('picker-list'), pickerCwd = $('picker-cwd'), pickerTitle = $('picker-title');
let pickerMode = 'folder', pickerCb = null, pickerCurrent = '';
async function openPicker(mode, cb, start) {
  pickerMode = mode; pickerCb = cb;
  pickerTitle.textContent = mode === 'folder' ? '选择文件夹' : '选择文件';
  pickerModal.style.display = ''; await loadPickerDir(start || '');
}
async function loadPickerDir(p) {
  const r = await fetch('/api/list-abs' + (p ? '?path=' + encodeURIComponent(p) : '')); const j = await r.json();
  if (j.error) { addSystem(j.error); return; }
  pickerCurrent = j.cwd; pickerCwd.value = j.cwd; pickerList.innerHTML = '';
  if (j.parent) { const u = document.createElement('div'); u.className = 'picker-item dir'; u.textContent = '⬆ ..'; u.onclick = () => loadPickerDir(j.parent); pickerList.appendChild(u); }
  for (const it of j.items) {
    if (pickerMode === 'folder' && !it.isDir) continue;
    const d = document.createElement('div'); d.className = 'picker-item ' + (it.isDir ? 'dir' : 'file');
    d.textContent = (it.isDir ? '📁 ' : '📄 ') + it.name;
    d.ondblclick = () => { if (it.isDir) loadPickerDir(it.path); else if (pickerMode !== 'folder') { pickerCb && pickerCb(it.path); pickerModal.style.display='none'; } };
    d.onclick = () => { if (it.isDir) loadPickerDir(it.path); };
    pickerList.appendChild(d);
  }
}
$('picker-up').onclick = () => { const p = pickerCurrent.replace(/[/\\][^/\\]+[/\\]?$/, ''); if (p) loadPickerDir(p); };
$('picker-go').onclick = () => loadPickerDir(pickerCwd.value);
pickerCwd.onkeydown = (e) => { if (e.key === 'Enter') loadPickerDir(pickerCwd.value); };
$('picker-pick').onclick = () => { if (pickerCb) pickerCb(pickerCurrent); pickerModal.style.display = 'none'; };
$('picker-cancel').onclick = $('picker-close').onclick = () => { pickerModal.style.display = 'none'; };

$('open-folder').onclick = () => openPicker('folder', async (p) => {
  const r = await fetch('/api/workspace', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({dir:p})});
  const j = await r.json(); if (j.workspace) { $('ws-display').textContent = j.workspace; addSystem('已切换工作目录：' + j.workspace); refreshFlat(); }
});
$('open-file').onclick = () => openPicker('file', async (p) => {
  const ws = $('ws-display').textContent;
  if (p.toLowerCase().startsWith(ws.toLowerCase())) {
    openFile(p.slice(ws.length).replace(/^[\\\/]+/, '').replaceAll('\\','/'));
  } else if (confirm('文件不在当前工作目录内。切换工作目录？')) {
    const dir = p.replace(/[/\\][^/\\]+$/, '');
    await fetch('/api/workspace', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({dir})});
    $('ws-display').textContent = dir; refreshFlat();
    setTimeout(() => openFile(p.slice(dir.length).replace(/^[\\\/]+/, '').replaceAll('\\','/')), 300);
  }
});

// ====================== 设置（LAMMPS 运行环境）======================
$('settings-btn').onclick = async () => {
  const j = await (await fetch('/api/settings')).json();
  if ($('set-lammps-bin'))   $('set-lammps-bin').value   = j.lammpsBin   || '';
  if ($('set-lammps-root'))  $('set-lammps-root').value  = j.lammpsRoot  || '';
  if ($('set-packmol'))      $('set-packmol').value      = j.packmolBin  || '';
  if ($('set-obabel'))       $('set-obabel').value       = j.obabelBin   || '';
  $('settings-modal').style.display = '';
};
$('settings-close').onclick = $('settings-cancel').onclick = () => $('settings-modal').style.display = 'none';
$('settings-save').onclick = async () => {
  const body = {
    lammpsBin:  $('set-lammps-bin')  ? $('set-lammps-bin').value  : undefined,
    lammpsRoot: $('set-lammps-root') ? $('set-lammps-root').value : undefined,
    packmolBin: $('set-packmol')     ? $('set-packmol').value     : undefined,
    obabelBin:  $('set-obabel')      ? $('set-obabel').value      : undefined
  };
  const j = await (await fetch('/api/settings', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)})).json();
  if (j.ok) { addSystem('设置已保存'); $('settings-modal').style.display = 'none'; }
};

// ====================== NGL 轨迹查看（MD 后处理）======================
let __nglStage = null, __nglComp = null, __nglPlayTimer = null;
function ensureNglStage() {
  if (__nglStage) return __nglStage;
  if (typeof NGL === 'undefined') { addSystem('NGL 库未加载（请检查网络）'); return null; }
  __nglStage = new NGL.Stage('ngl-host', { backgroundColor: '#0a0612' });
  window.addEventListener('resize', () => __nglStage.handleResize());
  return __nglStage;
}
// 文件树双击 .lammpstrj / .xyz / .gro / .dump / .atom → 自动塞进 NGL 面板并载入
async function openTrajectory(p) {
  if (typeof setPanelVisible === 'function') setPanelVisible('ngl', true);
  const inp = $('ngl-path'); const sel = $('ngl-ext');
  if (inp) inp.value = p;
  if (sel) {
    const ext = p.split('.').pop().toLowerCase();
    // NGL 不认 .atom/.dump 后缀；按 lammpstrj 解析
    const mapped = (ext === 'atom' || ext === 'dump') ? 'lammpstrj' : ext;
    const opt = Array.from(sel.options).find(o => o.value === mapped);
    sel.value = opt ? mapped : '';
  }
  const btn = $('ngl-load'); if (btn) btn.click();
}
function setNglFrame(i) {
  if (!__nglComp) return;
  const trajComp = __nglComp.__trajComp;
  // addTrajectory() 返回的是 TrajectoryElement，自身就带 .trajectory；
  // 兜底再从 component.trajList[0] 取（不同 NGL 版本结构略有差异）。
  const traj = (trajComp && trajComp.trajectory) ? trajComp
             : (__nglComp.trajList && __nglComp.trajList[0]) || null;
  if (traj && traj.trajectory) {
    const tot = traj.trajectory.frameCount || 1;
    const idx = Math.max(0, Math.min(tot - 1, i|0));
    traj.trajectory.setFrame(idx);
    const lbl = $('ngl-frame-label'); if (lbl) lbl.textContent = `${idx+1} / ${tot}`;
    const sl = $('ngl-frame'); if (sl) sl.value = idx;
  }
}
// 统一应用「表示模式 / 原子大小 / 配色」——所有相关控件都走它，保证渲染参数一致。
function applyNglRep() {
  if (!__nglComp) return;
  const rep = ($('ngl-rep') && $('ngl-rep').value) || 'ball+stick';
  const scale = parseFloat($('ngl-size') && $('ngl-size').value) || 1;
  const scheme = ($('ngl-color') && $('ngl-color').value) || 'element';
  const params = { multipleBond: 'symmetric', radiusScale: scale };
  if (scheme === 'uniform') {
    params.colorScheme = 'uniform';
    const cv = ($('ngl-color-val') && $('ngl-color-val').value) || '#4aa3ff';
    params.colorValue = parseInt(cv.replace('#', '0x'));
  } else {
    params.colorScheme = scheme; // element / atomindex
  }
  try {
    __nglComp.removeAllRepresentations();
    __nglComp.addRepresentation(rep, params);
  } catch (e) { console.warn('[NGL] applyNglRep failed', e); }
}
// NGL 2.x 把 lammpstrj 当“轨迹格式”而不是“结构格式”，loadFile 直接喂会报
// `autoLoad: ext 'lammpstrj' unknown`。这里把 LAMMPS dump 文本就地转成多帧 .xyz，
// 再以 Blob 形式喂给 NGL（xyz 是 NGL 原生支持的多帧结构格式）。
function __pickCol(idx, names) { for (const n of names) if (idx[n] !== undefined) return idx[n]; return undefined; }
// NGL 2.x 没有 xyz/lammpstrj 解析器（只支持 pdb/gro/mol2/cif/sdf...），所以统一转成
// 多 MODEL 的 PDB——NGL 原生解析，且 MODEL/ENDMDL 会被读成多帧轨迹。固定列宽很关键。
function __pdbLine(serial, el, x, y, z) {
  const E = String(el || 'C').toUpperCase().replace(/[^A-Z]/g, '') || 'C';
  const ser = String(serial % 100000).padStart(5);
  const name = (E.length >= 4 ? E.slice(0, 4) : (' ' + E).padEnd(4)); // 13-16，元素左对齐留首空格
  const xs = (Number.isFinite(x) ? x : 0).toFixed(3).padStart(8);
  const ys = (Number.isFinite(y) ? y : 0).toFixed(3).padStart(8);
  const zs = (Number.isFinite(z) ? z : 0).toFixed(3).padStart(8);
  const elem = E.padStart(2).slice(0, 2); // 77-78 元素符号，NGL 据此上色/定半径
  return 'ATOM  ' + ser + ' ' + name + ' MOL A   1    ' + xs + ys + zs + '  1.00  0.00          ' + elem;
}
function __framesToPdb(frames, PAL) {
  let out = '';
  let m = 0;
  for (const fr of frames) {
    m++;
    out += 'MODEL     ' + String(m).padStart(4) + '\n';
    let serial = 0;
    for (const at of fr.atoms) {
      serial++;
      let el = at.t;
      if (/^\d+$/.test(String(el))) { const n = parseInt(el, 10); el = PAL[(n - 1) % PAL.length] || 'C'; }
      out += __pdbLine(serial, el, at.x, at.y, at.z) + '\n';
    }
    out += 'ENDMDL\n';
  }
  out += 'END\n';
  return out;
}
function lammpstrjToXyz(text) {
  const lines = text.split(/\r?\n/); const N = lines.length; let i = 0; const frames = [];
  // 元素调色板：dump 只有 type 编号时，按编号映射到真实元素符号，便于 NGL 上色/定半径
  const PAL = ['C', 'H', 'O', 'N', 'S', 'P', 'F', 'Cl', 'Na', 'Mg', 'Al', 'Si', 'K', 'Ca', 'Fe', 'Zn', 'Cu', 'Ar'];
  while (i < N) {
    if (!/^ITEM:\s*TIMESTEP/i.test(lines[i] || '')) { i++; continue; }
    i++; const timestep = (lines[i] || '').trim(); i++;
    while (i < N && !/^ITEM:\s*NUMBER OF ATOMS/i.test(lines[i])) i++;
    i++; const natoms = parseInt((lines[i] || '0').trim(), 10) || 0; i++;
    let box = null;
    if (/^ITEM:\s*BOX BOUNDS/i.test(lines[i] || '')) {
      i++; const bl = [];
      for (let k = 0; k < 3 && i < N; k++) { bl.push((lines[i] || '').trim().split(/\s+/).map(Number)); i++; }
      box = bl;
    }
    while (i < N && !/^ITEM:\s*ATOMS/i.test(lines[i])) i++;
    const header = (lines[i] || '').replace(/^ITEM:\s*ATOMS\s*/i, '').trim().split(/\s+/); i++;
    const idx = {}; header.forEach((h, k) => idx[h] = k);
    const cx = __pickCol(idx, ['x', 'xu', 'xs', 'xsu']);
    const cy = __pickCol(idx, ['y', 'yu', 'ys', 'ysu']);
    const cz = __pickCol(idx, ['z', 'zu', 'zs', 'zsu']);
    const ct = idx.element !== undefined ? idx.element : (idx.type !== undefined ? idx.type : -1);
    const scaled = cx !== undefined && (header[cx] === 'xs' || header[cx] === 'xsu');
    if (cx === undefined || cy === undefined || cz === undefined) { i += natoms; continue; }
    const atoms = [];
    for (let a = 0; a < natoms && i < N; a++, i++) {
      const parts = (lines[i] || '').trim().split(/\s+/);
      if (parts.length < header.length) continue;
      let x = parseFloat(parts[cx]), y = parseFloat(parts[cy]), z = parseFloat(parts[cz]);
      if (scaled && box) { x = box[0][0] + x * (box[0][1] - box[0][0]); y = box[1][0] + y * (box[1][1] - box[1][0]); z = box[2][0] + z * (box[2][1] - box[2][0]); }
      atoms.push({ t: ct >= 0 ? parts[ct] : '1', x, y, z });
    }
    frames.push({ timestep, atoms });
  }
  return { text: __framesToPdb(frames, PAL), frames: frames.length };
}
// 兜底：有人把 LAMMPS *data* 文件命名成 .atom/.dump。data 文件没有 ITEM:，
// 这里解析 Atoms 段（atomic=id type x y z；charge=id type q x y z）出单帧 xyz。
function lammpsDataToXyz(text) {
  const PAL = ['C', 'H', 'O', 'N', 'S', 'P', 'F', 'Cl', 'Na', 'Mg', 'Al', 'Si', 'K', 'Ca', 'Fe', 'Zn', 'Cu', 'Ar'];
  const lines = text.split(/\r?\n/); const N = lines.length;
  let ai = -1;
  for (let i = 0; i < N; i++) { if (/^\s*Atoms\b/.test(lines[i])) { ai = i; break; } }
  if (ai < 0) return { xyz: '', frames: 0 };
  let i = ai + 1;
  while (i < N && lines[i].trim() === '') i++;
  const atoms = [];
  for (; i < N; i++) {
    const ln = lines[i].split('#')[0].trim();
    if (ln === '') break;
    const p = ln.split(/\s+/).map(Number);
    if (p.length < 5) continue;
    // 判定坐标起始列：6+ 列视为带电荷(charge/full)，否则 atomic
    const hasQ = p.length >= 6;
    const type = p[1];
    const x = hasQ ? p[p.length - 3] : p[2];
    const y = hasQ ? p[p.length - 2] : p[3];
    const z = hasQ ? p[p.length - 1] : p[4];
    atoms.push({ type, x, y, z });
  }
  if (!atoms.length) return { xyz: '', frames: 0 };
  let out = 'MODEL        1\n';
  let serial = 0;
  for (const at of atoms) {
    serial++;
    const el = PAL[((at.type | 0) - 1) % PAL.length] || 'C';
    out += __pdbLine(serial, el, at.x, at.y, at.z) + '\n';
  }
  out += 'ENDMDL\nEND\n';
  return { text: out, frames: 1 };
}
if ($('ngl-load')) $('ngl-load').onclick = async () => {
  const stage = ensureNglStage();
  if (!stage) return;
  const p = $('ngl-path').value.trim();
  if (!p) { addSystem('请填写轨迹文件路径'); return; }
  const userExt = ($('ngl-ext').value || '').trim();
  const ext = (userExt && userExt !== 'auto') ? userExt : (p.split('.').pop().toLowerCase());
  $('ngl-status').textContent = '加载中…';
  // 停掉旧的播放定时器
  if (__nglPlayTimer) { clearInterval(__nglPlayTimer); __nglPlayTimer = null; const pb = $('ngl-play'); if (pb) pb.textContent = '▶▶'; }
  try {
    stage.removeAllComponents();
    // 预检：先 HEAD 一下 /api/traj，路径不存在/为空直接给清晰错误，免得 NGL 抛 undefined。
    const probe = await fetch('/api/traj?path=' + encodeURIComponent(p) + '&_t=' + Date.now(), { method: 'HEAD' });
    if (!probe.ok) {
      const reason = probe.status === 404 ? '文件不存在（LAMMPS 可能未跑出 dump）' : `HTTP ${probe.status}`;
      throw new Error(`${reason}  →  ${p}`);
    }
    const url = '/api/traj?path=' + encodeURIComponent(p) + '&_t=' + Date.now();
    let loadSrc = url, loadExt = ext, convertedMultiFrame = false;
    if (['lammpstrj', 'atom', 'dump'].includes(ext)) {
      // LAMMPS dump → 取回文本就地转多帧 PDB，绕开 NGL 'lammpstrj'/'xyz' unknown
      const txt = await (await fetch(url)).text();
      // 二进制 dump（dump *.bin）头部不是文本，直接拦下给提示
      if (/\u0000/.test(txt.slice(0, 256))) {
        throw new Error('这是二进制 dump（.bin），NGL 读不了。请用文本 dump（dump custom/atom 不加 binary），或用下面的「OVITO 服务端渲染」。');
      }
      let conv = lammpstrjToXyz(txt);
      if (!conv.frames) conv = lammpsDataToXyz(txt); // 兜底：其实是 data 文件
      if (!conv.frames) {
        const head = txt.split(/\r?\n/).filter(l => l.trim()).slice(0, 3).join(' ⏎ ');
        throw new Error('解析为 0 帧：既不是含 x/y/z 列的 LAMMPS dump，也不是 data 文件。文件开头：「' + (head || '空文件') + '」');
      }
      loadSrc = new Blob([conv.text], { type: 'text/plain' });
      loadExt = 'pdb';
      convertedMultiFrame = conv.frames > 1; // 多 MODEL PDB：要 asTrajectory 才会被读成帧
    }
    const comp = await stage.loadFile(loadSrc, { ext: loadExt, defaultRepresentation: false, asTrajectory: convertedMultiFrame });
    __nglComp = comp;
    // LAMMPS dump 轨迹的“坑”：NGL 只在第 0 帧算一次键拓扑，之后切帧只挪原子不重算键。
    // 于是高温/扩散后，原本相邻的原子跑远，球棍的键会被拉成跨盒长线（用户说的“拖两下看不到原本面貌”）。
    // 对策：多帧 dump 默认用「填充球」（无键，干净），用户仍可手动切回球棍。单帧 data 文件不受影响，保留球棍。
    if (convertedMultiFrame) {
      const repSel = $('ngl-rep');
      if (repSel && repSel.value === 'ball+stick') {
        repSel.value = 'spacefill';
        addSystem('提示：轨迹默认用「填充球」——NGL 的键只按第 0 帧计算，切帧后球棍的键会被拉成长线。需要看连键可手动切「球棍」。');
      }
    }
    applyNglRep();
    comp.autoView();
    const ee = $('ngl-empty'); if (ee) ee.style.display = 'none';
    // NGL 对 lammpstrj / 多帧 pdb / xyz 是把帧解析到 structure.frames 里，
    // 然后用 stage.addTrajectory() 把 structure 作为轨迹包装（不是再去拉 URL）。
    // 之前的 addTrajectory(url) 会 404 或解析为单帧。
    const multiFrameExts = ['lammpstrj', 'pdb', 'xyz', 'gro'];
    let total = 1;
    try {
      const frames = comp.structure && comp.structure.frames;
      if (frames && frames.length > 1) {
        const trajComp = comp.addTrajectory(); // 用 structure.frames 作为轨迹
        __nglComp.__trajComp = trajComp;
        total = frames.length;
      } else if (multiFrameExts.includes(loadExt)) {
        // 走一次显式 addTrajectory（针对某些 NGL 版本不会自动填 frames 的情况）
        const trajComp = await comp.addTrajectory();
        __nglComp.__trajComp = trajComp;
        const tot = trajComp.trajectory && trajComp.trajectory.frameCount || 1;
        if (tot > 1) total = tot;
      }
    } catch (e) { console.warn('[NGL] addTrajectory failed:', e); }
    const fSlider = $('ngl-frame'); if (fSlider) { fSlider.max = Math.max(0, total - 1); fSlider.value = 0; }
    const fLabel = $('ngl-frame-label'); if (fLabel) fLabel.textContent = total > 1 ? `1 / ${total}` : '— / —';
    $('ngl-status').textContent = total > 1 ? `已加载 · ${total} 帧` : '已加载 · 单帧';
  } catch (e) {
    $('ngl-status').textContent = '失败';
    const msg = (e && (e.message || e.statusText)) || (typeof e === 'string' ? e : '') || (e && e.toString && e.toString()) || '未知错误（看 F12 Console）';
    addSystem('NGL 加载失败：' + msg + '（路径需相对工作区；扩展名错可在格式下拉里手选）');
    console.error('[NGL] load error', e);
  }
};
if ($('ngl-reset')) $('ngl-reset').onclick = () => { if (__nglComp) __nglComp.autoView(800); };
if ($('ngl-rep')) $('ngl-rep').onchange = applyNglRep;
if ($('ngl-size')) $('ngl-size').oninput = () => {
    // 只改半径缩放，不重建表示——避免每次拖动都 removeAll+add 造成的闪烁/视角漂移。
    if (!__nglComp) return;
    const scale = parseFloat($('ngl-size').value) || 1;
    let touched = false;
    try { __nglComp.eachRepresentation(r => { try { r.setParameters({ radiusScale: scale }); touched = true; } catch (e) {} }); } catch (e) {}
    if (!touched) applyNglRep();
  };
if ($('ngl-color')) $('ngl-color').onchange = () => {
  const cv = $('ngl-color-val'); if (cv) cv.style.display = ($('ngl-color').value === 'uniform') ? '' : 'none';
  applyNglRep();
};
if ($('ngl-color-val')) $('ngl-color-val').oninput = () => { if (($('ngl-color')||{}).value === 'uniform') applyNglRep(); };

// 首页「快速上手」：把最小 ReaxFF 热解示例任务填进对话框，方便一键试跑
if ($('quickstart-reaxff')) $('quickstart-reaxff').onclick = () => {
  const prompt = [
    '帮我跑 pe_min 文件夹里的「最小 ReaxFF 热解案例」：',
    '1) 读入 pe_min/data.pe_min（atom_style charge，type 1=C / 2=H 的聚乙烯短链）；',
    '2) pair_style reaxff NULL + pair_coeff 用 ffield.reax.CHO（C H），配 fix qeq/reaxff 做电荷平衡；',
    '3) 先能量最小化，再用 NVT 在 12.5 ps 内把温度从 300 K 升到 3000 K 触发热解；',
    '4) 用 fix reaxff/species 每 250 步统计产物到 species.out，并把轨迹 dump 到 dump.atom；',
    '5) 跑完用 NGL 查看 dump.atom 轨迹，告诉我生成了哪些主要小分子产物。',
    '参考输入脚本：pe_min/in.pe_pyrolysis_min（若缺 ffield.reax.CHO，请从 LAMMPS potentials 目录取或提示我）。'
  ].join('\n');
  const box = $('input');
  if (box) { box.value = prompt; box.focus(); box.dispatchEvent(new Event('input')); try { box.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {} }
  addSystem('已把「最小 ReaxFF 热解案例」任务填入对话框，按 Ctrl+Enter 或点「发送」即可开跑。');
};
// 自动旋转
let __nglSpin = false;
if ($('ngl-spin')) $('ngl-spin').onclick = () => {
  if (!__nglStage) return;
  __nglSpin = !__nglSpin; __nglStage.setSpin(__nglSpin);
  $('ngl-spin').style.background = __nglSpin ? 'var(--accent,#4aa3ff)' : '';
};
// 背景明暗切换
let __nglBgDark = true;
if ($('ngl-bg')) $('ngl-bg').onclick = () => {
  if (!__nglStage) return;
  __nglBgDark = !__nglBgDark;
  __nglStage.setParameters({ backgroundColor: __nglBgDark ? '#0a0612' : '#f5f5fa' });
};
// 截图：把当前画面保存成 PNG
if ($('ngl-shot')) $('ngl-shot').onclick = () => {
  if (!__nglStage) { addSystem('请先载入轨迹'); return; }
  __nglStage.makeImage({ factor: 2, antialias: true, trim: false, transparent: false }).then(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ngl-frame-' + (($('ngl-frame')||{}).value || 0) + '.png';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }).catch(e => addSystem('截图失败：' + (e && e.message || e)));
};
if ($('ngl-frame')) $('ngl-frame').oninput = (e) => setNglFrame(+e.target.value);
if ($('ngl-frame-prev')) $('ngl-frame-prev').onclick = () => setNglFrame(Math.max(0, (+$('ngl-frame').value) - 1));
if ($('ngl-frame-next')) $('ngl-frame-next').onclick = () => setNglFrame(Math.min((+$('ngl-frame').max), (+$('ngl-frame').value) + 1));
function __nglStartPlay() {
  const ms = parseInt(($('ngl-speed') && $('ngl-speed').value), 10) || 80;
  __nglPlayTimer = setInterval(() => {
    const cur = +$('ngl-frame').value, max = +$('ngl-frame').max;
    setNglFrame(cur >= max ? 0 : cur + 1);
  }, ms);
}
if ($('ngl-play')) $('ngl-play').onclick = () => {
  if (__nglPlayTimer) { clearInterval(__nglPlayTimer); __nglPlayTimer = null; $('ngl-play').textContent = '▶▶'; return; }
  $('ngl-play').textContent = '⏸';
  __nglStartPlay();
};
// 播放中改速度：立即按新速度重启定时器
if ($('ngl-speed')) $('ngl-speed').onchange = () => {
  if (__nglPlayTimer) { clearInterval(__nglPlayTimer); __nglStartPlay(); }
};
if ($('ngl-close')) $('ngl-close').onclick = () => {
  if (typeof setPanelVisible === 'function') setPanelVisible('ngl', false);
};

function showSimFrame(_) { /* legacy noop — ParaView 通道已移除 */ }

// ====================== 交互终端 ======================
$('term-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const cmd = e.target.value;
    addTerm((platform === 'win32' ? '> ' : '$ ') + cmd, 'user');
    ws.send(JSON.stringify({ type: 'pty_input', data: cmd + '\n' }));
    e.target.value = '';
  }
});

// ====================== 消息处理 ======================
function handleMessage(m) {
  switch (m.type) {
    case 'agent_start': setRunning(true); break;
    case 'agent_end': setRunning(false); $('input').focus(); break;
    case 'assistant_start': noteProgress(); currentAssistantBubble = addAssistantBubble(); break;
    case 'delta': noteProgress(); if (currentAssistantBubble) { currentAssistantBubble._raw = (currentAssistantBubble._raw || '') + m.text; currentAssistantBubble.textContent = currentAssistantBubble._raw; scrollChat(); } break;
    case 'assistant_end': noteProgress(); if (currentAssistantBubble) { renderMarkdownInto(currentAssistantBubble, currentAssistantBubble._raw || currentAssistantBubble.textContent); } currentAssistantBubble = null; break;
    case 'tool_call': { noteProgress(); const el = renderTool(m.id, m.name, m.args); toolEls.set(m.id, el); toolNames.set(m.id, m.name); addTerm(`▶ [agent] ${m.name}(${shortArgs(m.args)})`, 'agent'); break; }
    case 'approval_request': renderApproval(m); addTerm(`⚠ [需审批] ${m.name}: ${m.args.command || m.args.case_path || ''}`, 'err'); break;
    case 'tool_result': { noteProgress(); const el = toolEls.get(m.id);
      const tname = m.name || toolNames.get(m.id) || 'tool';
      const isErr = String(m.result).includes('错误') || String(m.result).startsWith('执行失败') || String(m.result).startsWith('启动失败');
      addTerm(`◀ [agent] ${tname} → ` + String(m.result).split('\n')[0].slice(0,140), isErr ? 'err' : 'ok');
      if (el) {
        const tr = el.querySelector('.tool-result');
        tr.textContent = m.result;
        // 提取结果里的 http(s) 或 本地 /api/file?raw=1 图片 URL，渲染缩略图
        try {
          const urls = (String(m.result).match(/(?:https?:\/\/[^\s<>"'`]+|\/api\/file\?[^\s<>"'`]+)\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?[^\s<>"'`]*)?/gi) || []);
          if (urls.length || m.name === 'download_file') {
            const gal = document.createElement('div'); gal.className = 'tool-images';
            gal.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;';
            urls.slice(0, 12).forEach(u => {
              const a = document.createElement('a'); a.href = u; a.target = '_blank';
              a.title = u + '  (点击新标签打开 · 右键另存)';
              a.style.cssText = 'display:inline-block;width:120px;height:90px;overflow:hidden;border:1px solid var(--line2);border-radius:4px;background:#0a0612;';
              const img = document.createElement('img'); img.src = u; img.referrerPolicy = 'no-referrer';
              img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
              img.onerror = () => { a.innerHTML = '<div style="font-size:9px;padding:4px;color:#fca5a5;">' + u.slice(-40) + ' 加载失败</div>'; };
              a.appendChild(img); gal.appendChild(a);
            });
            // 下载并保存按钮：让模型/用户一键收藏到 downloads/
            if (urls.length) {
              const bar = document.createElement('div');
              bar.style.cssText = 'margin-top:4px;font-size:10px;';
              bar.innerHTML = `<span class="muted">共 ${urls.length} 张图片，agent 可调用 download_file 下载</span>`;
              tr.appendChild(bar);
            }
            tr.appendChild(gal);
          }
        } catch {}
        const st = el.querySelector('.status');
        st.textContent = isErr ? '✗ 失败' : '✓ 完成'; st.className = 'status ' + (isErr ? 'err' : 'ok');
        // D) 一键修复按钮：lmp_diagnose_error 返回 JSON 中含 fix_actions[] → 渲染按钮
        if (m.name === 'lmp_diagnose_error') {
          try { const j = JSON.parse(String(m.result)); _renderFixActionButtons(tr, j); } catch { /* ignore */ }
        }
      } break; }
    case 'term': addTerm(m.line); break;
    case 'pty_out': addTerm(m.line); break;
    case 'tree': renderTree(m.tree); break;
    case 'checkpoints': renderCheckpoints(m.list); break;
    case 'pending_edits': renderPending(m.list); break;
    case 'todos': renderTodos(m.list); break;
    case 'usage': showUsage(m.usage); break;
    case 'task_complete': addSystem('任务完成：' + (m.summary || '')); break;
    case 'sim_state': case 'sim_started': case 'sim_closed': case 'sim_frame': case 'sim_error': case 'sim_compare': break; // legacy ParaView channels — no-op
    case 'runs_update': {
      // 后台有新的 OpenFOAM 进程被登记或结束 → 刷新求解器监测面板下拉
      try {
        if (typeof smRefreshRuns === 'function') {
          smRefreshRuns().then(() => {
            // 若用户当前没选 runId 且来的是新启动事件，自动选中
            if (m.reason && /started|run_command_detected/.test(m.reason) && m.runId) {
              const sel = $('sm-run');
              if (sel && (!SM.runId || !sel.value)) {
                sel.value = m.runId; SM.runId = m.runId;
                SM.snaps = []; SM.lastResidSig = '';
                if (typeof smRenderSnapStrip === 'function') smRenderSnapStrip();
                if (typeof smPoll === 'function') smPoll();
                if (typeof smRestartTimer === 'function') smRestartTimer();
                addSystem(`📡 检测到新求解器作业 runId=${m.runId}，已自动选入监测面板`);
              }
            }
          });
        }
      } catch {}
      break;
    }
    case 'heartbeat': /* 仅作活跃信号 */ break;
    case 'images': addToGallery(m.images, m.query); break;
    case 'foam_state': updateFoamState(m.enabled, m.root); break;
    case 'mfix_state': updateMfixState(m.enabled, m.root, m.bash); break;
    case 'lbm_state':  updateLbmState(m.enabled, m.tutorialRoot, m.runCmd); break;
    case 'custom_state': updateCustomState(m.enabled, m.name, m.root, m.prompt); break;
    case 'skill_list':   if (window.Skill) window.Skill.onList(m); break;
    case 'skill_state':  if (window.Skill) window.Skill.onState(m); break;
    case 'skill_status': if (window.Skill) window.Skill.onStatus(m.status); break;
    case 'skill_learned': if (window.Skill) window.Skill.onLearned(m); break;
    case 'skill_suggest': if (window.Skill) window.Skill.onSuggest(m); break;
    case 'skill_distill': if (window.Skill) window.Skill.onDistill(m); break;
    case 'skill_train_progress': if (window.Skill) window.Skill.onTrainProgress(m); break;
    case 'skill_train_done': if (window.Skill) window.Skill.onTrainDone(m); break;
    case 'lammps_thermo': _renderLmpThermo(m); break;            // A) 实时跑表盘
    case 'lammps_run_summary': _renderLmpSummary(m); break;       // E) 总结卡
    case 'agent_phase': {
      _phaseStart = _phaseStart || Date.now();
      // 真实工作阶段算作进度；llm_thinking 是等首 token 的 2s 心跳，不刷新进度计时，
      // 这样真卡住时恢复条才能正常弹出。
      if (m.phase && m.phase !== 'llm_thinking' && m.phase !== 'planning' && m.phase !== 'idle') noteProgress();
      showPhase(m.phase, m.detail, m.tool, { step: m.step, maxSteps: m.max_steps, tool_ms: m.tool_ms, ok: m.ok });
      try { window.NFScholar && window.NFScholar.onPhase && window.NFScholar.onPhase(m.phase, m.detail || '', m.tool || ''); } catch {}
      break;
    }
    case 'digitize_open': {
      // 后端请求用户打开标注界面（可能携带图片 base64 / hint / request_id）
      if (window.NFDigitizer) {
        window.NFDigitizer.open({
          imageBase64: m.image_base64 || null,
          imageUrl: m.image_url || null,
          hint: m.hint || '',
          name: m.name || 'plot',
          requestId: m.request_id || null
        });
        try { addSystem('📍 Agent 请你亲手标注一张图表的数据点。完成后请点「保存 CSV 并发送到聊天」。' + (m.hint ? ' 提示：' + m.hint : '')); } catch {}
      }
      break;
    }
    case 'error': addSystem('错误：' + m.message); addTerm('[错误] ' + m.message, 'err'); setRunning(false); break;
    case 'reset_done': {
      const chat = $('chat'); if (chat) chat.innerHTML = '';
      clearChatHistory();
      const td = $('todos'); if (td) td.innerHTML = '<div class="muted small">尚无任务</div>';
      const cp = $('checkpoints'); if (cp) cp.innerHTML = '<div class="muted small">尚无检查点</div>';
      const pl = $('pending-list'); if (pl) pl.innerHTML = '';
      const pb = $('pending-bar'); if (pb) pb.style.display = 'none';
      addSystem('对话已清空');
      break;
    }
  }
  window.dispatchEvent(new CustomEvent('dscm-msg', { detail: m }));
}

function shortArgs(a) {
  if (!a) return '';
  if (a.command) return a.command.slice(0, 60);
  if (a.case_path) return a.case_path + (a.command ? ' ' + a.command : '');
  if (a.path) return a.path; if (a.pattern) return a.pattern;
  if (a.items) return `${a.items.length} 项`;
  return '';
}
function addUser(text, atts) {
  const div = document.createElement('div'); div.className = 'msg user';
  div.innerHTML = `<div class="role">你</div><div class="bubble"></div>`;
  const b = div.querySelector('.bubble'); b.textContent = text;
  for (const a of (atts || [])) {
    if (a.type === 'image') { const im = document.createElement('img'); im.src = a.dataUrl; b.appendChild(im); }
    else { const p = document.createElement('div'); p.style.fontSize='10px'; p.style.color='#aaccff'; p.textContent = (a.type === 'context_file' ? '📄 ' : '📎 ') + (a.path || a.name); b.appendChild(p); }
  }
  $('chat').appendChild(div); scrollChat();
}
function addAssistantBubble() { const div = document.createElement('div'); div.className = 'msg assistant'; div.innerHTML = `<div class="role">MDriver</div><div class="bubble"></div>`; $('chat').appendChild(div); scrollChat(); return div.querySelector('.bubble'); }
function addSystem(text) { const div = document.createElement('div'); div.className = 'msg system'; div.innerHTML = `<div class="bubble"></div>`; div.querySelector('.bubble').textContent = text; $('chat').appendChild(div); scrollChat(); }

// ============== LAMMPS 实时跑表盘 + 总结卡 + 一键修复（A / E / D） ==============
const _lmpCharts = new Map();      // run_id -> { bubble, svg, data: {step:[], series:{}}, lastStep }
const _lmpSummaries = new Map();   // run_id -> summary card element（避免重复推送）

function _fmtNum(v, digits = 3) {
  if (v == null || !isFinite(+v)) return '-';
  const n = +v;
  if (Math.abs(n) >= 1000 || Math.abs(n) < 0.01 && n !== 0) return n.toExponential(digits);
  return n.toFixed(digits);
}
function _sparkSvg(xs, ys, w = 320, h = 60, color = '#7dd3fc') {
  if (!ys.length) return '';
  const min = Math.min(...ys), max = Math.max(...ys);
  const range = (max - min) || 1;
  const xmin = xs[0], xmax = xs[xs.length - 1] || xmin + 1;
  const xr = (xmax - xmin) || 1;
  const pts = xs.map((x, i) => {
    const px = ((x - xmin) / xr) * (w - 4) + 2;
    const py = h - 2 - ((ys[i] - min) / range) * (h - 6);
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  }).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;display:block;">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"/>
    <text x="2" y="10" font-size="9" fill="#94a3b8">${_fmtNum(max)}</text>
    <text x="2" y="${h - 2}" font-size="9" fill="#94a3b8">${_fmtNum(min)}</text>
  </svg>`;
}
function _renderLmpThermo(payload) {
  const { run_id, header = [], rows = [], cmd = '', case_path = '' } = payload;
  let entry = _lmpCharts.get(run_id);
  if (!entry) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.style.cssText = '';
    div.innerHTML = `<div class="bubble" style="background:#0a0612;border:1px solid #4338ca;padding:10px 12px;">
      <div style="font-size:11px;color:#a5b4fc;display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span>📊 <b>LAMMPS run ${run_id}</b> 实时 thermo · <code style="font-size:10px;color:#cbd5e1;">${case_path}</code></span>
        <span class="lmp-step" style="font-size:10px;color:#cbd5e1;">step: -</span>
      </div>
      <div class="lmp-grid" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;"></div>
      <div class="lmp-meta" style="font-size:10px;color:#64748b;margin-top:6px;">cmd: <code style="color:#94a3b8;">${cmd.slice(0, 100)}</code></div>
    </div>`;
    $('chat').appendChild(div);
    entry = { bubble: div, gridEl: div.querySelector('.lmp-grid'), stepEl: div.querySelector('.lmp-step'), data: { step: [] }, lastStep: -1, header };
    _lmpCharts.set(run_id, entry);
    scrollChat();
  }
  // 把 rows append
  for (const r of rows) {
    const st = +(r.Step ?? r.step ?? 0);
    if (st <= entry.lastStep) continue;
    entry.lastStep = st;
    entry.data.step.push(st);
    for (const k of Object.keys(r)) {
      if (k === 'Step' || k === 'step') continue;
      if (!entry.data[k]) entry.data[k] = [];
      entry.data[k].push(+r[k]);
    }
  }
  entry.stepEl.textContent = `step: ${entry.lastStep}`;
  // 渲染 4 个最重要的列：Temp, PotEng / TotEng, Press, Density (按存在性)
  const wantOrder = ['Temp', 'TotEng', 'PotEng', 'KinEng', 'Press', 'Density', 'Volume', 'Enthalpy'];
  const have = wantOrder.filter(k => entry.data[k] && entry.data[k].length);
  const palette = { Temp: '#fca5a5', TotEng: '#7dd3fc', PotEng: '#a78bfa', KinEng: '#fcd34d', Press: '#86efac', Density: '#fdba74', Volume: '#67e8f9', Enthalpy: '#f9a8d4' };
  // 只画最近 200 点，避免越来越慢
  const N = entry.data.step.length;
  const sliceFrom = Math.max(0, N - 200);
  const xs = entry.data.step.slice(sliceFrom);
  entry.gridEl.innerHTML = have.slice(0, 4).map(k => {
    const ys = entry.data[k].slice(sliceFrom);
    const cur = ys[ys.length - 1];
    return `<div style="background:#1e1b2e;border-radius:4px;padding:6px 8px;">
      <div style="display:flex;justify-content:space-between;font-size:10px;color:#cbd5e1;">
        <span style="color:${palette[k] || '#cbd5e1'};">${k}</span><span>${_fmtNum(cur)}</span>
      </div>
      ${_sparkSvg(xs, ys, 320, 56, palette[k] || '#7dd3fc')}
    </div>`;
  }).join('');
  scrollChat();
}
function _renderLmpSummary(payload) {
  const { run_id } = payload;
  // 同一个 run_id 只渲染一次
  if (_lmpSummaries.has(run_id)) return;
  // 总结卡来了就关掉对应的实时图（保留显示，停止更新）
  const div = document.createElement('div');
  div.className = 'msg system';
  const verdictColor = payload.verdict === 'ok' ? '#86efac' : payload.verdict === 'crashed' ? '#fca5a5' : '#fcd34d';
  const verdictIcon = payload.verdict === 'ok' ? '✓' : payload.verdict === 'crashed' ? '✗' : '⚠';
  const kpi = (label, val, unit) => `<div style="background:#1e1b2e;border-radius:4px;padding:8px;text-align:center;">
    <div style="font-size:18px;color:#e2e8f0;font-weight:600;">${val ?? '-'}<span style="font-size:10px;color:#94a3b8;margin-left:2px;">${unit || ''}</span></div>
    <div style="font-size:9px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.5px;">${label}</div>
  </div>`;
  // 取最后一行 thermo 关键列
  const rows = payload.thermo_rows || [];
  const last = rows[rows.length - 1] || {};
  const first = rows[0] || {};
  // 用 spark 画 Temp + TotEng 全程
  let chartsHtml = '';
  if (rows.length > 1) {
    const xs = rows.map(r => +(r.Step ?? r.step ?? 0));
    const series = ['Temp', 'TotEng', 'PotEng', 'Press'].filter(k => rows[0][k] != null);
    const palette = { Temp: '#fca5a5', TotEng: '#7dd3fc', PotEng: '#a78bfa', Press: '#86efac' };
    chartsHtml = `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-top:8px;">
      ${series.slice(0, 4).map(k => {
        const ys = rows.map(r => +r[k]);
        return `<div style="background:#1e1b2e;border-radius:4px;padding:4px 6px;">
          <div style="font-size:10px;color:${palette[k] || '#cbd5e1'};">${k}: ${_fmtNum(first[k])} → ${_fmtNum(last[k])}</div>
          ${_sparkSvg(xs, ys, 280, 44, palette[k] || '#7dd3fc')}
        </div>`;
      }).join('')}
    </div>`;
  }
  const errsHtml = (payload.errors || []).length ? `<div style="margin-top:8px;background:#3b1818;border-left:3px solid #fca5a5;padding:6px 8px;font-size:10px;color:#fecaca;"><b>ERROR (${payload.errors.length})</b><br>${payload.errors.slice(-3).map(e => e.trim()).join('<br>')}</div>` : '';
  // 0s 崩溃且 log 几乎空：把 stdout/stderr 尾部当“需看现场”显出来。
  const stderrHtml = (!payload.errors || !payload.errors.length) && payload.stderr_tail ? `<div style="margin-top:8px;background:#2a1818;border-left:3px solid #fca5a5;padding:6px 8px;font-size:10px;color:#fecaca;"><b>stdout/stderr tail</b>（log 很空，真问题在这里）<br><pre style="white-space:pre-wrap;margin:4px 0;color:#fca5a5;">${payload.stderr_tail.replace(/</g,'&lt;')}</pre></div>` : '';
  const warnsHtml = (payload.warnings || []).length ? `<div style="margin-top:6px;background:#332a14;border-left:3px solid #fcd34d;padding:6px 8px;font-size:10px;color:#fde68a;"><b>WARNING (${payload.warnings.length})</b><br>${payload.warnings.slice(0, 3).map(e => e.trim()).join('<br>')}</div>` : '';
  div.innerHTML = `<div class="bubble" style="background:#0a0612;border:1px solid ${verdictColor};padding:12px;max-width:680px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <span style="font-size:13px;color:#e2e8f0;"><span style="color:${verdictColor};font-size:16px;margin-right:4px;">${verdictIcon}</span><b>LAMMPS run ${run_id}</b> · <code style="font-size:10px;color:#94a3b8;">${payload.case_path}</code></span>
      <span style="font-size:11px;color:${verdictColor};text-transform:uppercase;">${payload.verdict}</span>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;">
      ${kpi('atoms', payload.atoms ?? '-', '')}
      ${kpi('steps', payload.last_step ?? '-', '')}
      ${kpi('loop time', _fmtNum(payload.loop_time_sec, 1), 's')}
      ${kpi('ns/day', _fmtNum(payload.ns_per_day, 2), '')}
    </div>
    ${chartsHtml}
    ${errsHtml}${stderrHtml}${warnsHtml}
    <div style="margin-top:8px;font-size:10px;color:#64748b;">exit=${payload.exit_code} · ${payload.duration_sec}s · ${payload.procs ?? 1} proc · log=${payload.log_name}</div>
  </div>`;
  $('chat').appendChild(div);
  _lmpSummaries.set(run_id, div);
  scrollChat();
}
function _renderFixActionButtons(toolResultEl, parsed) {
  if (!parsed || !Array.isArray(parsed.fix_actions) || !parsed.fix_actions.length) return;
  const bar = document.createElement('div');
  bar.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px dashed #4338ca;display:flex;flex-wrap:wrap;gap:6px;';
  const hint = document.createElement('div');
  hint.style.cssText = 'width:100%;font-size:10px;color:#a5b4fc;margin-bottom:4px;';
  hint.innerHTML = `🔧 <b>一键修复</b>（点击按钮让 agent 应用对应修法并重跑）：`;
  bar.appendChild(hint);
  for (const act of parsed.fix_actions.slice(0, 6)) {
    const btn = document.createElement('button');
    btn.textContent = `${act.category}: ${act.label}`;
    btn.title = act.instruction;
    btn.style.cssText = 'background:#4338ca;color:#fff;border:none;border-radius:4px;padding:4px 8px;font-size:10px;cursor:pointer;max-width:280px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    btn.onmouseover = () => btn.style.background = '#6366f1';
    btn.onmouseout = () => btn.style.background = '#4338ca';
    btn.onclick = () => {
      try {
        ws.send(JSON.stringify({ type: 'user', text: act.instruction, attachments: [] }));
        btn.disabled = true; btn.textContent = '✓ ' + btn.textContent; btn.style.background = '#16a34a';
      } catch (e) { addTerm('[err] ' + e.message, 'err'); }
    };
    bar.appendChild(btn);
  }
  toolResultEl.appendChild(bar);
}

// ====================== Markdown + KaTeX (lazy CDN) ======================
let _mdReady = null;
async function ensureMD() {
  if (_mdReady) return _mdReady;
  _mdReady = (async () => {
    const out = {};
    try {
      const m = await import('https://cdn.jsdelivr.net/npm/marked@12.0.0/lib/marked.esm.js');
      out.marked = m.marked || m.default || m;
    } catch (e) { out.marked = null; }
    try {
      const k = await import('https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.mjs');
      out.katex = k.default || k;
    } catch (e) { out.katex = null; }
    return out;
  })();
  return _mdReady;
}
function _escHtmlBasic(s) { return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
async function renderMarkdownInto(bubble, raw) {
  if (!bubble) return;
  const text = String(raw || '');
  if (!text.trim()) { bubble.textContent = text; return; }
  try {
    const { marked, katex } = await ensureMD();
    if (!marked) { bubble.textContent = text; return; }
    // 抽出公式占位
    const blocks = []; let t = text;
    t = t.replace(/\$\$([\s\S]+?)\$\$/g, (_, e) => { blocks.push({ d: true, e }); return `\u0000KTX${blocks.length-1}\u0000`; });
    t = t.replace(/(^|[^\\$])\$([^\n$]{1,500}?)\$(?!\d)/g, (_m, pre, e) => { blocks.push({ d: false, e }); return `${pre}\u0000KTX${blocks.length-1}\u0000`; });
    let html;
    try { html = marked.parse(t, { breaks: true, gfm: true }); } catch { html = '<pre>' + _escHtmlBasic(text) + '</pre>'; }
    html = html.replace(/\u0000KTX(\d+)\u0000/g, (_m, i) => {
      const b = blocks[+i]; if (!b) return '';
      if (!katex) return `<code>${_escHtmlBasic(b.e)}</code>`;
      try { return katex.renderToString(b.e, { displayMode: b.d, throwOnError: false, output: 'html' }); }
      catch { return `<code>${_escHtmlBasic(b.e)}</code>`; }
    });
    // 仅对气泡内的渲染，外部消息保持安全：用 textContent 注入 HTML 是必要的
    bubble.innerHTML = html;
    // 代码块右上角加复制按钮
    bubble.querySelectorAll('pre > code').forEach(code => {
      const pre = code.parentElement;
      pre.style.position = 'relative';
      const btn = document.createElement('button');
      btn.textContent = '复制'; btn.className = 'mini';
      btn.style.cssText = 'position:absolute;top:4px;right:4px;font-size:9px;padding:1px 6px;opacity:.7;';
      btn.onclick = () => { navigator.clipboard.writeText(code.textContent || ''); btn.textContent = '✓'; setTimeout(() => btn.textContent = '复制', 1200); };
      pre.appendChild(btn);
    });
    scrollChat();
  } catch (e) {
    bubble.textContent = text;
  }
}function renderTool(id, name, args) {
  const div = document.createElement('div'); div.className = 'tool';
  div.innerHTML = `<div class="tool-head"><span>🔧 ${name}</span><span class="status">运行中…</span></div><div class="tool-args"></div><div class="tool-result"></div>`;
  div.querySelector('.tool-args').textContent = JSON.stringify(args, null, 2);
  $('chat').appendChild(div); scrollChat(); return div;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function addCompareFrame(m) {
  const div = document.createElement('div'); div.className = 'msg system';
  const fld = m.field || '(默认)';
  const ts = (m.timeStep === null || m.timeStep === undefined || m.timeStep === '') ? '(默认时间步)' : ('t-idx ' + m.timeStep);
  div.innerHTML = `<div class="bubble" style="max-width:96%;">
    <div class="muted small" style="margin-bottom:4px;">📊 算例对比 · 场: ${escapeHtml(fld)} · ${escapeHtml(ts)}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;">
      <div style="flex:1;min-width:280px;">
        <div class="small" style="text-align:center;color:#a78bfa;margin-bottom:2px;">A · ${escapeHtml(m.a.label || '')}</div>
        <img src="${m.a.dataUrl}" style="width:100%;border:1px solid #6b21a8;border-radius:4px;cursor:zoom-in;" onclick="window.open(this.src,'_blank')" />
      </div>
      <div style="flex:1;min-width:280px;">
        <div class="small" style="text-align:center;color:#22d3ee;margin-bottom:2px;">B · ${escapeHtml(m.b.label || '')}</div>
        <img src="${m.b.dataUrl}" style="width:100%;border:1px solid #0e7490;border-radius:4px;cursor:zoom-in;" onclick="window.open(this.src,'_blank')" />
      </div>
    </div>
  </div>`;
  $('chat').appendChild(div); scrollChat();
}
function renderApproval(m) {
  const div = document.createElement('div'); div.className = 'approval';
  const cmd = m.args.command || `${m.args.case_path || ''} → ${m.args.command || ''}`;
  div.innerHTML = `<p>⚠ 智能体请求：<b></b></p><button class="ok">允许</button><button class="no">拒绝</button>`;
  div.querySelector('b').textContent = `${m.name}: ${cmd}`;
  div.querySelector('.ok').onclick = () => { ws.send(JSON.stringify({ type:'approval', approved:true })); div.remove(); };
  div.querySelector('.no').onclick = () => { ws.send(JSON.stringify({ type:'approval', approved:false })); div.remove(); };
  $('chat').appendChild(div); scrollChat();
}
function addTerm(line, cls) {
  const div = document.createElement('div');
  div.className = 'term-line' + (cls ? ' ' + cls : '');
  if (line.startsWith('$ ') || line.startsWith('> ')) div.classList.add('cmd');
  if (line.startsWith('[')) div.classList.add('sys');
  div.textContent = line; $('terminal').appendChild(div);
  while ($('terminal').childElementCount > 800) $('terminal').firstChild.remove();
  $('terminal').scrollTop = $('terminal').scrollHeight;
}

function renderTree(tree) { $('tree').innerHTML = ''; if (!tree?.children) return; $('tree').appendChild(renderNode(tree, true, 0)); refreshFlat(); }
function renderNode(node, isRoot, depth) {
  depth = depth || 0;
  const wrap = document.createElement('div');
  if (!isRoot) {
    const el = document.createElement('div'); el.className = 'tree-node ' + node.type;
    el.dataset.path = node.path;
    el.style.paddingLeft = (8 + depth * 12) + 'px';
    if (node.type === 'file') {
      // 按扩展名给小图标，方便一眼定位 PDF/图片/STL 等
      const lower = (node.name || '').toLowerCase();
      let icon = '📄';
      if (/\.pdf$/.test(lower)) icon = '📕';
      else if (/\.(png|jpe?g|gif|webp|bmp|svg|ico)$/.test(lower)) icon = '🖼';
      else if (/\.stl$/.test(lower)) icon = '🧊';
      else if (/\.(vtu|vtp|vti|vtk|pvd)$/.test(lower)) icon = '🌈';
      else if (/\.ipynb$/.test(lower)) icon = '📓';
      else if (/\.(md|markdown)$/.test(lower)) icon = '📝';
      else if (/\.(py|js|ts|jsx|tsx|cpp|c|h|hpp|f90|f|cu|rs|go|java|sh)$/.test(lower)) icon = '⚙';
      el.textContent = icon + ' ' + node.name;
      el.onclick = () => openFile(node.path);
    }
    if (node.type === 'dir') {
      // 默认折叠，顶层（depth=0）展开
      let exp = (depth === 0);
      const ch = document.createElement('div'); ch.className = 'tree-children';
      ch.style.display = exp ? '' : 'none';
      const arrow = () => exp ? '▾' : '▸';
      const icon  = () => exp ? '📂' : '📁';
      el.textContent = `${arrow()} ${icon()} ${node.name}`;
      let loaded = false;
      const loadChildren = () => { if (loaded) return; loaded = true;
        (node.children || []).forEach(c => ch.appendChild(renderNode(c, false, depth + 1)));
      };
      if (exp) loadChildren();
      el.onclick = () => {
        exp = !exp;
        if (exp) loadChildren();
        ch.style.display = exp ? '' : 'none';
        el.textContent = `${arrow()} ${icon()} ${node.name}`;
      };
      wrap.appendChild(el); wrap.appendChild(ch); return wrap;
    }
    wrap.appendChild(el); return wrap;
  }
  (node.children || []).forEach(c => wrap.appendChild(renderNode(c, false, 0)));
  return wrap;
}
function renderCheckpoints(list) {
  if (!list.length) { $('checkpoints').innerHTML = '<div class="muted small">尚无检查点</div>'; return; }
  $('checkpoints').innerHTML = '';
  [...list].reverse().forEach(c => {
    const d = document.createElement('div'); d.className = 'cp-item';
    const tm = new Date(c.timestamp).toLocaleTimeString();
    d.innerHTML = `<div class="label"></div><div class="meta-row"><span>${tm} · ${c.fileCount} 文件</span><button>↶ 回滚</button></div>`;
    d.querySelector('.label').textContent = c.label;
    d.querySelector('button').onclick = () => {
      if (!confirm('回滚到此检查点？会丢弃之后的所有文件修改。')) return;
      ws.send(JSON.stringify({ type:'restore_checkpoint', id:c.id }));
      // 回滚后重载所有打开的 tab
      setTimeout(() => { for (const p of tabs.keys()) reloadOpenFile(p); }, 400);
    };
    $('checkpoints').appendChild(d);
  });
}
function renderPending(list) {
  if (!list.length) { $('pending-bar').style.display = 'none'; $('pending-list').innerHTML = ''; return; }
  $('pending-bar').style.display = ''; $('pending-count').textContent = list.length; $('pending-list').innerHTML = '';
  [...list].reverse().forEach(e => {
    const d = document.createElement('div'); d.className = 'pending-item';
    const badge = e.action === 'create' ? 'create' : 'edit';
    const lbl = e.action === 'create' ? '新建' : (e.action === 'edit' ? '编辑' : '写入');
    d.innerHTML = `<div class="row1"><span class="badge ${badge}">${lbl}</span><span class="pname"></span></div>
      <div class="row2"><button class="mini" data-act="diff">👁</button><button class="mini" data-act="open">📝</button><button class="mini ok" data-act="keep">✓ Keep</button><button class="mini no" data-act="undo">↶ Undo</button></div>`;
    d.querySelector('.pname').textContent = e.path;
    d.querySelector('[data-act="keep"]').onclick = () => ws.send(JSON.stringify({type:'keep_edit', id:e.id}));
    d.querySelector('[data-act="undo"]').onclick = () => { ws.send(JSON.stringify({type:'undo_edit', id:e.id})); reloadOpenFile(e.path); };
    d.querySelector('[data-act="open"]').onclick = () => openFile(e.path);
    d.querySelector('[data-act="diff"]').onclick = () => showDiff(e);
    $('pending-list').appendChild(d);
  });
  list.forEach(e => reloadOpenFile(e.path));
}
function renderTodos(list) {
  if (!list?.length) { $('todos').innerHTML = '<div class="muted small">尚无任务</div>'; return; }
  const done = list.filter(t => t.done).length;
  $('todos').innerHTML = `<div class="todo-progress">进度 ${done}/${list.length}</div>`;
  list.forEach(t => { const d = document.createElement('div'); d.className = 'todo-item' + (t.done ? ' done' : '');
    d.innerHTML = `<span>${t.done ? '✅' : '⬜'}</span><span class="text"></span>`;
    d.querySelector('.text').textContent = t.text; $('todos').appendChild(d); });
}
$('keep-all').onclick = () => ws.send(JSON.stringify({type:'keep_all'}));
$('undo-all').onclick = () => { if (confirm('撤销全部？')) ws.send(JSON.stringify({type:'undo_all'})); };

let currentDiffEdit = null;
async function showDiff(edit) {
  await monacoReady; currentDiffEdit = edit;
  $('diff-title').textContent = `${edit.action === 'create' ? '新建' : '修改'} · ${edit.path}`;
  $('diff-modal').style.display = '';
  if (!diffEditor) diffEditor = monaco.editor.createDiffEditor($('diff-editor'), { theme: 'vs-dark', automaticLayout: true, readOnly: true, renderSideBySide: true, fontSize: 12 });
  const lang = detectLang(edit.path);
  diffEditor.setModel({ original: monaco.editor.createModel(edit.oldContent || '', lang), modified: monaco.editor.createModel(edit.newContent || '', lang) });
}
$('diff-close').onclick = () => { $('diff-modal').style.display = 'none'; currentDiffEdit = null; };
$('diff-keep').onclick = () => { if (currentDiffEdit) ws.send(JSON.stringify({type:'keep_edit', id:currentDiffEdit.id})); $('diff-modal').style.display='none'; currentDiffEdit=null; };
$('diff-undo').onclick = () => { if (currentDiffEdit) { ws.send(JSON.stringify({type:'undo_edit', id:currentDiffEdit.id})); reloadOpenFile(currentDiffEdit.path); } $('diff-modal').style.display='none'; currentDiffEdit=null; };

function scrollChat() { $('chat').scrollTop = $('chat').scrollHeight; saveChatHistory(); }

// ====================== 聊天历史本地持久化（刷新页面恢复） ======================
const CHAT_HISTORY_KEY = 'codemax.chatHistory.v1';
const CHAT_HISTORY_MAX = 800_000; // ~800 KB innerHTML 上限
let _chatSaveTimer = 0;
function saveChatHistory() {
  if (_chatSaveTimer) return;
  _chatSaveTimer = setTimeout(() => {
    _chatSaveTimer = 0;
    try {
      const chat = $('chat'); if (!chat) return;
      let html = chat.innerHTML || '';
      if (html.length > CHAT_HISTORY_MAX) html = html.slice(html.length - CHAT_HISTORY_MAX);
      localStorage.setItem(CHAT_HISTORY_KEY, html);
    } catch {}
  }, 600);
}
function clearChatHistory() { try { localStorage.removeItem(CHAT_HISTORY_KEY); } catch {} }
function restoreChatHistory() {
  try {
    const html = localStorage.getItem(CHAT_HISTORY_KEY);
    const chat = $('chat'); if (!chat || !html) return;
    chat.innerHTML = html;
    // 恢复后追加一条系统提示
    const tip = document.createElement('div');
    tip.className = 'msg system';
    tip.innerHTML = '<div class="bubble" style="opacity:.7;font-size:12px;">— 上方为本地缓存历史（仅前端可见，新对话仍是新上下文；输入 /clear 可清空）—</div>';
    chat.appendChild(tip);
    chat.scrollTop = chat.scrollHeight;
  } catch {}
}
restoreChatHistory();

// ====================== 图片库面板 ======================
const GALLERY = []; // {image, thumb, title, source, host, query}
function addToGallery(images, query) {
  if (!Array.isArray(images) || !images.length) return;
  for (const img of images) {
    if (!img || !img.image) continue;
    if (GALLERY.find(g => g.image === img.image)) continue;
    GALLERY.unshift({ ...img, query: query || '' });
  }
  if (GALLERY.length > 200) GALLERY.length = 200;
  renderGallery();
}
function renderGallery() {
  const grid = $('gallery-grid'); const empty = $('gallery-empty');
  $('gal-count').textContent = GALLERY.length;
  if (!GALLERY.length) { empty.style.display = 'block'; grid.innerHTML = ''; return; }
  empty.style.display = 'none';
  grid.innerHTML = '';
  GALLERY.forEach((g, i) => {
    const card = document.createElement('div');
    card.style.cssText = 'background:#0a0612;border:1px solid var(--line2);border-radius:5px;overflow:hidden;cursor:pointer;display:flex;flex-direction:column;';
    card.title = (g.title || '') + '\n' + g.image + (g.host ? '\n来源: ' + g.host : '');
    card.innerHTML = `
      <div style="width:100%;height:120px;background:#111;display:flex;align-items:center;justify-content:center;overflow:hidden;">
        <img src="${g.thumb || g.image}" referrerpolicy="no-referrer" style="max-width:100%;max-height:100%;object-fit:cover;" onerror="this.parentElement.innerHTML='<div style=&quot;font-size:9px;color:#fca5a5;padding:4px;&quot;>缩略图加载失败</div>'" />
      </div>
      <div style="padding:4px 6px;font-size:10px;line-height:1.3;color:#aaa;height:32px;overflow:hidden;">
        <div style="color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${(g.title||'(无标题)').replace(/[<>]/g,'')}</div>
        <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${g.host || (g.query ? '搜:'+g.query : '')}</div>
      </div>
      <div style="display:flex;gap:2px;padding:0 4px 4px;">
        <button class="mini" data-act="view" style="flex:1;font-size:9px;">大图</button>
        <button class="mini" data-act="dl" style="flex:1;font-size:9px;">下载</button>
        <button class="mini" data-act="open" style="flex:1;font-size:9px;">原页</button>
      </div>`;
    card.querySelectorAll('button').forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const act = b.dataset.act;
        if (act === 'view') openLightbox(g);
        else if (act === 'dl') downloadGalleryImage(g);
        else if (act === 'open') window.open(g.source || g.image, '_blank');
      };
    });
    card.onclick = () => openLightbox(g);
    grid.appendChild(card);
  });
}
function openLightbox(g) {
  $('img-lightbox-img').src = g.image;
  $('img-lightbox-img').referrerPolicy = 'no-referrer';
  $('img-lightbox-open').href = g.image;
  $('img-lightbox-meta').textContent = (g.title || '') + '  ·  ' + g.image + (g.host ? '  ·  ' + g.host : '');
  $('img-lightbox-dl').onclick = () => downloadGalleryImage(g);
  $('img-lightbox').style.display = 'flex';
}
$('img-lightbox-close').onclick = () => $('img-lightbox').style.display = 'none';
$('img-lightbox').onclick = (e) => { if (e.target.id === 'img-lightbox') $('img-lightbox').style.display = 'none'; };
async function downloadGalleryImage(g) {
  try {
    const r = await fetch('/api/download_image', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url: g.image }) });
    const j = await r.json();
    if (j.error) addSystem('下载失败：' + j.error);
    else addSystem('已下载：' + j.message);
  } catch (e) { addSystem('下载失败：' + e.message); }
}
$('gal-search').onclick = async () => {
  const q = $('gal-prompt').value.trim(); if (!q) return;
  $('gal-search').disabled = true; $('gal-search').textContent = '搜索中…';
  try {
    const r = await fetch('/api/image_search', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ query: q, top_k: 16 }) });
    const j = await r.json();
    if (j.error) addSystem('搜图失败：' + j.error);
    else if (!j.count) addSystem('未找到图片（可能被反爬）');
  } catch (e) { addSystem('搜图失败：' + e.message); }
  finally { $('gal-search').disabled = false; $('gal-search').textContent = '搜索'; }
};
$('gal-prompt').addEventListener('keydown', e => { if (e.key === 'Enter') $('gal-search').click(); });
$('gal-clear').onclick = () => { GALLERY.length = 0; renderGallery(); };

// ====================== OpenFOAM Beta 面板 ======================
const FOAM_STATE = { enabled: false, root: '' };

// —— 顶栏模式徽章 —— 任意 Beta 模式开启/关闭时同步渲染
function renderModePills() {
  const host = $('mode-pills'); if (!host) return;
  const pills = [];
  if (typeof FOAM_STATE !== 'undefined' && FOAM_STATE.enabled)     pills.push({ cls: 'foam',   label: 'OpenFOAM', pid: 'foam' });
  if (typeof MFIX_STATE !== 'undefined' && MFIX_STATE.enabled)     pills.push({ cls: 'mfix',   label: 'MFIX',     pid: 'mfix' });
  if (typeof LBM_STATE  !== 'undefined' && LBM_STATE.enabled)      pills.push({ cls: 'lbm',    label: 'LBM',      pid: 'lbm' });
  if (typeof CUSTOM_STATE !== 'undefined' && CUSTOM_STATE.enabled) pills.push({ cls: 'custom', label: CUSTOM_STATE.name || '自定义', pid: 'custom' });
  if (!pills.length) { host.innerHTML = ''; return; }
  host.innerHTML = pills.map(p =>
    `<span class="pill ${p.cls}" data-pid="${p.pid}" title="点击聚焦面板"><span class="dot"></span>${p.label}</span>`
  ).join('');
  // 点击 pill → 显示并滚动到对应面板
  host.querySelectorAll('.pill').forEach(el => {
    el.onclick = () => {
      const pid = el.getAttribute('data-pid');
      if (typeof setPanelVisible === 'function') setPanelVisible(pid, true);
      const panel = document.querySelector(`.panel[data-pid="${pid}"]`);
      if (panel) { panel.style.zIndex = 999; panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); setTimeout(() => panel.style.zIndex = '', 1200); }
    };
  });
}

function updateFoamState(enabled, root) {
  const wasEnabled = FOAM_STATE.enabled;
  FOAM_STATE.enabled = !!enabled; FOAM_STATE.root = root || '';
  $('foam-state').textContent = FOAM_STATE.enabled ? 'Beta 已启用' : '未启用';
  $('foam-state').style.color = FOAM_STATE.enabled ? '#a3e635' : '';
  $('foam-toggle').textContent = FOAM_STATE.enabled ? '关闭' : '启用';
  $('foam-root-text').textContent = FOAM_STATE.root || '(未设置 — 点 ⚙ 配置)';
  $('foam-cfg-root').value = FOAM_STATE.root || '';
  // 启用时自动打开 OpenFOAM、求解器监测、ParaView 面板
  if (FOAM_STATE.enabled && !wasEnabled) {
    setPanelVisible('foam', true);
    setPanelVisible('solver-monitor', true);
    setPanelVisible('paraview', true);
  }
  renderModePills();
}
async function refreshFoamConfig() {
  try { const r = await fetch('/api/foam/config').then(r => r.json()); updateFoamState(r.foamMode, r.root); } catch {}
}
if ($('foam-state')) { // legacy OpenFOAM UI — only run if HTML elements still present
refreshFoamConfig();

$('foam-toggle').onclick = () => {
  if (!FOAM_STATE.enabled && !FOAM_STATE.root) { $('foam-config').click(); return; }
  ws.send(JSON.stringify({ type: 'set_foam', value: !FOAM_STATE.enabled }));
};
$('foam-config').onclick = () => { $('foam-cfg-root').value = FOAM_STATE.root || ''; $('foam-cfg-status').textContent = ''; $('foam-cfg-modal').style.display = 'flex'; $('foam-cfg-root').focus(); };
$('foam-cfg-cancel').onclick = () => $('foam-cfg-modal').style.display = 'none';
$('foam-cfg-save').onclick = async () => {
  const root = $('foam-cfg-root').value.trim();
  $('foam-cfg-status').textContent = '检查中…';
  try {
    await fetch('/api/foam/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ root, foamMode: true }) });
    const r = await fetch('/api/foam/config').then(r => r.json());
    if (!r.exists) { $('foam-cfg-status').textContent = '⚠ 路径不存在或无权限：' + r.root; $('foam-cfg-status').style.color = '#fca5a5'; return; }
    if (!r.hasTutorials) { $('foam-cfg-status').textContent = '⚠ 路径下未发现 tutorials/ 子目录'; $('foam-cfg-status').style.color = '#fbbf24'; }
    else { $('foam-cfg-status').textContent = '✓ tutorials/ ' + (r.hasSrc ? '+ src/' : '') + ' 检测通过'; $('foam-cfg-status').style.color = '#a3e635'; }
    ws.send(JSON.stringify({ type: 'set_foam', value: true }));
    setTimeout(() => $('foam-cfg-modal').style.display = 'none', 700);
  } catch (e) { $('foam-cfg-status').textContent = '失败：' + e.message; $('foam-cfg-status').style.color = '#fca5a5'; }
};

function foamRenderResults(text, kind) {
  const el = $('foam-results');
  if (!text || /^未找到/.test(text)) { el.innerHTML = `<div class="muted small" style="padding:10px;">${text || '(空)'}</div>`; return; }
  // 解析每条 "1. <rel>\n   绝对路径：<abs>"
  const blocks = text.split(/\n(?=\d+\.\s)/).filter(b => /^\d+\./.test(b));
  if (!blocks.length) { el.textContent = text; return; }
  el.innerHTML = '';
  blocks.forEach(b => {
    const m1 = b.match(/^\d+\.\s+(?:\[([^\]]+)\]\s+)?(.+?)\n\s+绝对路径：(.+?)$/m);
    const tag = m1 ? (m1[1] || '') : '';
    const rel = m1 ? m1[2].trim() : b.split('\n')[0];
    const abs = m1 ? m1[3].trim() : '';
    const row = document.createElement('div');
    row.style.cssText = 'border-bottom:1px dashed var(--line2);padding:4px 0;display:flex;flex-direction:column;gap:3px;';
    row.innerHTML = `
      <div style="color:#ddd;word-break:break-all;">${tag ? `<span style="color:#a3e635;">[${tag}]</span> ` : ''}${rel}</div>
      <div class="muted" style="font-size:9px;word-break:break-all;">${abs}</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;">
        ${kind === 'tutorial' ? '<button class="mini" data-act="clone">克隆到工作区</button>' : ''}
        <button class="mini" data-act="ask">问 agent</button>
        ${kind !== 'tutorial' ? '<button class="mini" data-act="read">读源码片段</button>' : ''}
      </div>`;
    row.querySelectorAll('button').forEach(btn => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        if (act === 'clone') foamCloneFromUI(rel);
        else if (act === 'ask') foamAskAgent(rel, abs, kind);
        else if (act === 'read') foamAskRead(rel, abs);
      };
    });
    el.appendChild(row);
  });
}

async function foamCloneFromUI(rel) {
  const dest = prompt('克隆到工作区的目标目录（相对路径）：', rel.split('/').pop());
  if (!dest) return;
  try {
    const r = await fetch('/api/foam/clone', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tutorial_path: rel, dest }) }).then(r => r.json());
    if (r.error) { addSystem('克隆失败：' + r.error); return; }
    addSystem(r.message || '克隆完成');
    // 顺手让 agent 接手
    foamSendChat(`我刚把 OpenFOAM 教程 ${rel} 克隆到了 ${dest}。\n请按流水式工作流接手：\n1. 调 foam_inspect_case("${dest}") 摘要算例。\n2. 用 update_todos 列出所有需要我确认的边界条件 / 物性 / 网格 / 求解器 / 时间步项。\n3. 然后**一次只问我一项**（每项给默认值与可选范围），我答完你 edit_file 改 dictionary，再问下一项。\n4. 全部确认后跑 blockMesh→checkMesh→求解器，最后 sim_render 看结果。`);
  } catch (e) { addSystem('克隆失败：' + e.message); }
}
function foamAskAgent(rel, abs, kind) {
  if (kind === 'tutorial') {
    foamSendChat(`请基于 OpenFOAM 教程 ${rel}（绝对路径 ${abs}）按流水式工作流帮我建立算例：\n1. 先 foam_inspect_case 该教程；\n2. 问我目标工作区目录名（默认 ${rel.split('/').pop()}）；\n3. foam_clone_tutorial 到该目录；\n4. update_todos 列出所有边界条件/物性/网格/时间步需要确认的项（5–20 项）；\n5. 一次只问我一项，我答了就 edit_file 改 dictionary 并把这一项 todo 标 done；\n6. 全确认后跑 blockMesh→checkMesh→求解器→sim_render。`);
  } else {
    foamSendChat(`请把 OpenFOAM 源码 ${rel}（${abs}）作为参考帮我实现/修改模型：\n1. 先 read_file 这个文件，把关键类/函数贴给我；\n2. 问我是"原地用"还是"fork 到 user-libs/<MyModel>/ 改写后 wmake"；\n3. 按我的回答执行，包括写 Make/files 和 Make/options、wmake，并在我的算例 constant/ 中切到新模型名；\n4. 一步一确认，不要全自动跑完。`);
  }
}
function foamAskRead(rel, abs) {
  foamSendChat(`请 read_file ${abs}（OpenFOAM 路径 ${rel}）的前 200 行，并用 3–5 行中文概述这个类/函数干什么、关键参数有哪些。`);
}

function foamSendChat(text) {
  // 把 text 填进输入框并触发 send
  $('input').value = text;
  $('send').click();
}

$('foam-search').onclick = async () => {
  if (!FOAM_STATE.root) { addSystem('请先点 ⚙ 设置 OpenFOAM 根目录'); return; }
  const q = $('foam-q').value.trim();
  const kindSel = $('foam-kind').value;
  if (!q) { $('foam-results').innerHTML = '<div class="muted small" style="padding:10px;">请输入关键词</div>'; return; }
  $('foam-search').disabled = true; $('foam-search').textContent = '…';
  try {
    let url, isTutorial = (kindSel === 'tutorial');
    if (isTutorial) url = `/api/foam/tutorials?q=${encodeURIComponent(q)}&top_k=30`;
    else url = `/api/foam/source?q=${encodeURIComponent(q)}&kind=${encodeURIComponent(kindSel)}&top_k=20`;
    const r = await fetch(url);
    const t = await r.text();
    if (!r.ok) { $('foam-results').innerHTML = `<div class="small" style="color:#fca5a5;padding:10px;">${t}</div>`; }
    else foamRenderResults(t, isTutorial ? 'tutorial' : 'src');
  } catch (e) { $('foam-results').textContent = '失败：' + e.message; }
  finally { $('foam-search').disabled = false; $('foam-search').textContent = '搜索'; }
};
$('foam-q').addEventListener('keydown', e => { if (e.key === 'Enter') $('foam-search').click(); });

// 流水式工作流引导按钮
$('foam-flow-have') && ($('foam-flow-have').onclick = () => {
  if (!FOAM_STATE.enabled) { addSystem('请先启用 OpenFOAM Beta 模式'); return; }
  const p = prompt('告诉智能体你已经有的算例的相对路径或绝对路径：', '');
  if (!p) return;
  foamSendChat(`我已经有具体算例了，路径是 \`${p}\`。请严格按流水式工作流：\n1. 先调 foam_inspect_case("${p}") 一次性摘要并递归列出所有文件；\n2. 用 update_todos 列出 5–20 项可改项（边界条件/物性/网格/求解器/时间步/写出频率…）；\n3. 在聊天里给我**带编号的推荐选项**，每项标注默认值；\n4. **一次只问我一项**，我答了就改 dictionary 并继续；\n5. 全确认后用 foam_run_solver_async 后台跑 blockMesh→checkMesh→求解器，每个 runId 让我在监测面板看。`);
});
$('foam-flow-need') && ($('foam-flow-need').onclick = () => {
  if (!FOAM_STATE.enabled) { addSystem('请先启用 OpenFOAM Beta 模式'); return; }
  const kw = prompt('告诉智能体你的关键词（如 bubbleColumn / twoPhaseEulerFoam / RANS / 自然对流）：', '');
  if (!kw) return;
  foamSendChat(`我没有具体算例，关键词：${kw}。请：\n1. 调 foam_find_tutorial("${kw}", 12) 列本地 tutorials 候选；\n2. 用 update_todos 把候选写成清单；\n3. 在聊天里用 1) 2) 3) 编号列出（每行一个候选 + 一行说明），等我回编号；\n4. **不要替我做选择**。我选了之后再 foam_clone_tutorial，然后 foam_inspect_case，然后再按流水式工作流逐项问我。`);
});
$('foam-flow-paper') && ($('foam-flow-paper').onclick = () => {
  if (!FOAM_STATE.enabled) { addSystem('请先启用 OpenFOAM Beta 模式'); return; }
  const p = prompt('给我论文 PDF / DOCX 路径（绝对或相对工作区）：\n例: papers/wenyu2003_drag.pdf', '');
  if (!p) return;
  const hint = prompt('（可选）一句话提示这是关于什么的算法，例：\n  WenYu 曳力修正 / k-omega SST / VOF surface tension /\n  population balance / 翼型颤振气动力\n直接回车跳过：', '') || '';
  foamSendChat([
    `请按"📄 论文 → OpenFOAM 植入工作流"严格执行：`,
    ``,
    `**论文文件**：\`${p}\``,
    hint ? `**用户提示**：${hint}` : ``,
    ``,
    `开始：`,
    `P1. 调 read_document("${p}") 读全文。`,
    `P2. 用 update_todos 写 4 项摘要：①算法名/类别 ②核心公式（含 Eq. 编号）③变量与常数 ④应替换/扩展的 OpenFOAM 模块类别。`,
    `P3. 调 foam_find_source 找最近的"参考实现"（例如同类 drag/turbulence/bc），read_file 读其 .H/.C，把骨架贴回（≤80 行核心段）。`,
    `P4. **给我决策菜单**（4 个 1)2)3) 编号问题，每个标 ✅ 默认）：实现方式 / 落地目录 / 参数传入方式 / 验证 case。等我回完 4 个再继续。`,
    `P5. 我选完后逐文件 write_file 创建 .H/.C/Make/files/Make/options，每个文件 commit 前贴 diff 摘要；用 foam_run_solver_async 跑 wmake libso 编译。`,
    `P6. 编译过了再跑验证 case，最后 sim_render 出图。`,
    ``,
    `纪律：每步问之前先在聊天里讲清楚"我现在在第 P? 步"。**严禁** 跳过 P3/P4 直接写 .C 文件。`
  ].filter(Boolean).join('\n'));
});

$('foam-flow-stl') && ($('foam-flow-stl').onclick = () => {
  if (!FOAM_STATE.enabled) { addSystem('请先启用 OpenFOAM Beta 模式'); return; }
  const stl = prompt('STL 文件路径（绝对或相对工作区）：\n例: geom/sphere.stl', '');
  if (!stl) return;
  const cd = prompt('目标 case 目录（会自动创建；相对或绝对）：\n例: cases/sphere_extflow', '');
  if (!cd) return;
  foamSendChat([
    `请按"🔧 STL → 网格自动化工作流"严格执行：`,
    ``,
    `**STL**: \`${stl}\`     **case**: \`${cd}\``,
    ``,
    `M1. 调 foam_stl_inspect("${stl}") 取 bbox/单位猜测/推荐 cell_size 并贴回（≤8 行）。`,
    `M2. **一次性问完** 7 个工况选项（流动类型/主流方向/雷诺数或来流速度/求解器/湍流/网格细度/边界层），每项标 ✅ 默认值，等我回 7 个数字（用 1234567 格式或逐项回）。`,
    `M3. 我回完后再调 foam_mesh_plan("${cd}", "${stl}", target_cell_size=…, refinement_level_min=1, refinement_level_max=…, n_layers=…, flow_direction="…")。然后 foam_run_solver_async 顺序跑 blockMesh → surfaceFeatures → snappyHexMesh -overwrite → checkMesh，**每步 exit=0** 才走下一步。`,
    `M4. 用 foam_clone_tutorial 拉模板的 0/ + constant，按 M2 答案改边界条件。**绝不**手写 0/。`,
    `M5. foam_run_solver_async 启动求解器；每隔几次轮询调 foam_residual_series 只贴 trends 段。`,
    `M6. 收敛后 sim_render 出 U / p / k 图。`,
    ``,
    `纪律：每步开头先报"现在 M? 步"。**严禁**跳过 M2 直接 foam_mesh_plan。`
  ].join('\n'));
});

$('foam-flow-compare') && ($('foam-flow-compare').onclick = () => {
  if (!FOAM_STATE.enabled) { addSystem('请先启用 OpenFOAM Beta 模式'); return; }
  const a = prompt('case A 路径（相对或绝对）：', '');
  if (!a) return;
  const b = prompt('case B 路径（相对或绝对）：', '');
  if (!b) return;
  const field = prompt('要对比的场（U / p / alpha.water / T 等，空=默认）：', 'U') || '';
  const ts = prompt('时间步索引（空=最后一步，0=第一步，-1=最后一步）：', '') || '';
  foamSendChat(`请调 foam_compare_render({ case_a: "${a}", case_b: "${b}", label_a: "A", label_b: "B"${field ? `, field: "${field}"` : ''}${ts ? `, time_step: "${ts}"` : ''} }) 并排出图。出完图后**用 3-5 句话**比较两侧的定性差异（流场结构、再循环区、剪切层位置等），不要超过 5 句。`);
});

$('foam-flow-residual') && ($('foam-flow-residual').onclick = () => {
  if (!FOAM_STATE.enabled) { addSystem('请先启用 OpenFOAM Beta 模式'); return; }
  const sel = $('sm-run');
  let runId = sel && sel.value ? sel.value : '';
  if (!runId) runId = prompt('输入 runId（在求解器监测面板可看到）：', '') || '';
  if (!runId) return;
  foamSendChat(`请调 foam_residual_series({ run_id: "${runId}", max_points: 40, fields: ["U","Ux","Uy","Uz","p","k","omega","epsilon","T","alpha.water"] })，**只贴 trends 段** + 最后 3 个时间步的初始残差，然后**用 1-3 条具体可执行建议**告诉我下一步该改什么（松弛因子/校正次数/网格质量/时间步），别贴整张表。`);
});

} // end legacy foam UI guard

// ====================== 求解器监测面板 ======================
const SM = { runId: '', timer: null, snapTimer: 0, snaps: [], lastSnapTime: -1, lastResidSig: '' };
function smSetStatus(s, color) { const el = $('sm-status'); if (!el) return; el.textContent = s; el.style.color = color || ''; }
async function smRefreshRuns() {
  const sel = $('sm-run'); if (!sel) return;
  try {
    const r = await fetch('/api/foam/runs'); const j = await r.json();
    const cur = sel.value;
    sel.innerHTML = '<option value="">-- 选择 runId --</option>' +
      (j.runs || []).map(x => `<option value="${x.runId}">${x.runId} · ${x.command.slice(0,30)} · ${x.running?'运行中':'已结束'}</option>`).join('');
    if (cur && (j.runs || []).find(x => x.runId === cur)) sel.value = cur;
  } catch (e) { /* 忽略 */ }
}
// 残差曲线绘制（log10 自动缩放，多场叠加）
const RESID_COLORS = ['#a78bfa','#22d3ee','#bef264','#fb923c','#f472b6','#fde047','#34d399','#fca5a5','#7dd3fc','#c084fc'];
function smDrawResidChart(series, fields) {
  const cv = $('sm-resid-canvas'); const lg = $('sm-resid-legend');
  if (!cv || !lg) return;
  if (!series || series.length < 2 || !fields || !fields.length) {
    cv.style.display = 'none'; lg.style.display = 'none'; return;
  }
  cv.style.display = ''; lg.style.display = 'flex';
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 360, h = cv.clientHeight || 120;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.fillStyle = '#0a0612'; ctx.fillRect(0,0,w,h);
  // 选最多 6 个场（按方差大的优先）；过滤无效值
  const fldList = fields.slice(0, 6);
  // y 轴：log10(initial residual)
  let ymin = Infinity, ymax = -Infinity;
  const xs = series.map(s => s.t);
  const xmin = xs[0], xmax = xs[xs.length-1] || (xmin+1);
  const lines = fldList.map(f => {
    const pts = [];
    for (const s of series) { const v = s[f]; if (typeof v === 'number' && isFinite(v) && v > 0) pts.push([s.t, Math.log10(v)]); }
    pts.forEach(p => { if (p[1] < ymin) ymin = p[1]; if (p[1] > ymax) ymax = p[1]; });
    return { f, pts };
  });
  if (!isFinite(ymin) || !isFinite(ymax)) { cv.style.display = 'none'; lg.style.display = 'none'; return; }
  if (ymin === ymax) { ymin -= 1; ymax += 1; }
  const pad = { l: 28, r: 8, t: 8, b: 16 };
  const W = w - pad.l - pad.r, H = h - pad.t - pad.b;
  const sx = t => pad.l + (xmax > xmin ? (t - xmin) / (xmax - xmin) * W : W/2);
  const sy = y => pad.t + (1 - (y - ymin) / (ymax - ymin)) * H;
  // 网格 + log 标签
  ctx.strokeStyle = '#1f1438'; ctx.lineWidth = 1; ctx.font = '9px monospace'; ctx.fillStyle = '#7c6f99';
  for (let yv = Math.ceil(ymin); yv <= Math.floor(ymax); yv++) {
    const py = sy(yv);
    ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(pad.l + W, py); ctx.stroke();
    ctx.fillText(`1e${yv}`, 2, py + 3);
  }
  // x 轴
  ctx.fillText(`t=${xmin.toFixed(3)}`, pad.l, h - 3);
  ctx.fillText(`t=${xmax.toFixed(3)}`, pad.l + W - 50, h - 3);
  // 各场曲线
  lg.innerHTML = '';
  lines.forEach((ln, i) => {
    const c = RESID_COLORS[i % RESID_COLORS.length];
    if (ln.pts.length < 2) return;
    ctx.strokeStyle = c; ctx.lineWidth = 1.4; ctx.beginPath();
    ln.pts.forEach((p, k) => { const x = sx(p[0]), y = sy(p[1]); if (k === 0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    ctx.stroke();
    const span = document.createElement('span');
    span.style.cssText = `display:inline-flex;align-items:center;gap:3px;color:${c};`;
    span.innerHTML = `<span style="display:inline-block;width:8px;height:8px;background:${c};border-radius:1px;"></span>${ln.f}`;
    lg.appendChild(span);
  });
}

async function smPoll() {
  if (!SM.runId) { $('sm-tail').textContent = '(未选择作业)'; $('sm-summary').textContent = '未选择作业。'; smSetStatus('空闲'); smDrawResidChart(null, null); return; }
  try {
    const r = await fetch('/api/foam/run/' + encodeURIComponent(SM.runId));
    if (!r.ok) { smSetStatus('未知 runId', '#fca5a5'); return; }
    const j = await r.json();
    const dur = ((j.ended || Date.now()) - j.started) / 1000;
    smSetStatus(j.running ? '运行中' : `已结束(exit=${j.exitCode})`, j.running ? '#a3e635' : (j.exitCode === 0 ? '#a3e635' : '#fca5a5'));
    // trends 摘要拼到 summary 行
    const trendStr = j.trends ? Object.entries(j.trends).slice(0,4).map(([k,v]) => `${k}:${v.status||'?'}`).join('  ') : '';
    $('sm-summary').textContent = `cmd: ${j.command} · 用时 ${dur.toFixed(1)}s · Time=${j.lastTime || '?'} · ${trendStr}`;
    // 进度条 + ETA
    try {
      const pg = j.progress || null;
      const wrap = $('sm-progress-wrap');
      if (wrap) {
        if (pg && (pg.percent != null || pg.phase)) {
          wrap.style.display = 'flex';
          const pct = pg.percent != null ? Math.max(0, Math.min(100, pg.percent)) : 0;
          $('sm-progress-bar').style.width = pct.toFixed(1) + '%';
          const phaseTxt = pg.phase ? ` · 阶段 ${pg.phase}` : '';
          const curT = pg.currentTime != null ? ` · t=${Number(pg.currentTime).toFixed(4)}` : '';
          const endT = pg.endTime != null ? `/${pg.endTime}` : '';
          $('sm-progress-label').textContent = `进度 ${pct.toFixed(1)}%${phaseTxt}${curT}${endT}`;
          if (pg.etaSec != null && pg.etaSec >= 0) {
            const s = Math.round(pg.etaSec);
            const hh = Math.floor(s/3600), mm = Math.floor((s%3600)/60), ss = s%60;
            const txt = hh > 0 ? `${hh}h${mm}m${ss}s` : (mm > 0 ? `${mm}m${ss}s` : `${ss}s`);
            const rate = pg.simRate ? `  速率 ${pg.simRate.toExponential(2)} sim/s` : '';
            $('sm-progress-eta').textContent = `ETA ${txt}${rate}`;
          } else if (j.ended) {
            $('sm-progress-eta').textContent = '已完成';
          } else {
            $('sm-progress-eta').textContent = 'ETA - ';
          }
        } else {
          wrap.style.display = 'none';
        }
      }
    } catch {}
    smDrawResidChart(j.series || [], j.fields || []);
    const block = [
      '--- 最近残差 (' + (j.residuals?.length || 0) + ') ---',
      ...(j.residuals || []),
      '',
      '--- 日志 tail (' + (j.tail?.length || 0) + ') ---',
      ...(j.tail || [])
    ].join('\n');
    $('sm-tail').textContent = block;
    $('sm-tail').scrollTop = $('sm-tail').scrollHeight;
    // 自动快照逻辑
    if (j.running && $('sm-snap-auto') && $('sm-snap-auto').checked) {
      const sig = j.lastTime || '';
      // 仅当 lastTime 推进时才考虑抓帧（否则纯日志刷屏没意义）
      if (sig && sig !== SM.lastResidSig) { SM.lastResidSig = sig; }
    }
  } catch (e) { smSetStatus('网络错误', '#fca5a5'); }
}
function smRestartTimer() {
  if (SM.timer) { clearInterval(SM.timer); SM.timer = null; }
  if ($('sm-auto').checked && SM.runId) {
    const sec = Math.max(2, parseInt($('sm-interval').value, 10) || 5);
    SM.timer = setInterval(smPoll, sec * 1000);
  }
}

// ============== 快照演化轴 ==============
function smRenderSnapStrip() {
  const strip = $('sm-snap-strip'); if (!strip) return;
  if (!SM.snaps.length) {
    strip.innerHTML = '<div class="muted small" style="padding:8px;">📸 快照演化轴：跑求解器时点 📸 抓帧或勾选自动；点缩略图放大对比。</div>';
    return;
  }
  strip.innerHTML = '';
  SM.snaps.forEach((s, idx) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'flex:0 0 auto;display:flex;flex-direction:column;align-items:center;gap:2px;cursor:pointer;';
    wrap.title = `t=${s.t}  field=${s.field}\n${s.casePath}`;
    wrap.innerHTML = `<img src="${s.dataUrl}" style="width:60px;height:42px;object-fit:cover;border:1px solid #4c1d95;border-radius:3px;" /><span class="small" style="font-size:9px;color:#a78bfa;">${s.label}</span>`;
    wrap.onclick = () => smShowSnapModal(idx);
    strip.appendChild(wrap);
  });
}
function smShowSnapModal(idx) {
  const s = SM.snaps[idx]; if (!s) return;
  // 简单大图查看 + 左右切换 + 与上一帧对比按钮
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;';
  const card = document.createElement('div');
  card.style.cssText = 'background:#0a0612;padding:12px;border-radius:8px;border:1px solid #4c1d95;max-width:92vw;max-height:92vh;display:flex;flex-direction:column;gap:8px;';
  let cur = idx;
  function render() {
    const s = SM.snaps[cur];
    card.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;color:#c4b5fd;font-size:12px;">
      <span>📸 ${cur+1}/${SM.snaps.length} · ${s.label} · field=${s.field} · ${s.casePath}</span>
      <button id="snap-close" class="mini">✕</button>
    </div>
    <img src="${s.dataUrl}" style="max-width:88vw;max-height:75vh;object-fit:contain;border:1px solid #4c1d95;border-radius:4px;" />
    <div style="display:flex;gap:6px;justify-content:center;">
      <button class="mini" id="snap-prev">◀</button>
      <button class="mini" id="snap-next">▶</button>
      <button class="mini" id="snap-cmp" ${cur===0?'disabled':''}>vs 上一帧</button>
      <button class="mini" id="snap-del" style="background:rgba(239,68,68,.2);border-color:#dc2626;color:#fca5a5;">删除</button>
    </div>`;
    card.querySelector('#snap-close').onclick = () => overlay.remove();
    card.querySelector('#snap-prev').onclick = () => { if (cur > 0) { cur--; render(); } };
    card.querySelector('#snap-next').onclick = () => { if (cur < SM.snaps.length-1) { cur++; render(); } };
    card.querySelector('#snap-cmp').onclick = () => {
      if (cur === 0) return;
      const prev = SM.snaps[cur-1], curS = SM.snaps[cur];
      addCompareFrame({ field: curS.field, timeStep: '', a: { dataUrl: prev.dataUrl, label: prev.label }, b: { dataUrl: curS.dataUrl, label: curS.label } });
      overlay.remove();
    };
    card.querySelector('#snap-del').onclick = () => {
      SM.snaps.splice(cur, 1); smRenderSnapStrip();
      if (!SM.snaps.length) overlay.remove();
      else { if (cur >= SM.snaps.length) cur = SM.snaps.length - 1; render(); }
    };
  }
  render();
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.appendChild(card); document.body.appendChild(overlay);
}
async function smCaptureSnapshot() {
  if (!SM.runId) { addSystem('请先选择 runId 才能抓快照'); return; }
  try {
    const rj = await (await fetch('/api/foam/run/' + encodeURIComponent(SM.runId))).json();
    const cd = rj.casePath; if (!cd) { addSystem('未拿到 case 路径'); return; }
    const field = ($('sm-snap-field').value || 'U').trim();
    const t = rj.lastTime || '';
    smSetStatus('抓快照中…', '#fbbf24');
    const r = await fetch('/api/sim/render', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ case_path: cd, field, time_step: -1, width: 480, height: 320 })
    });
    const j = await r.json();
    if (j.error) { addSystem('快照失败：' + j.error); smSetStatus('快照失败','#fca5a5'); return; }
    // sim_frame 已经被广播，但我们要拿到 dataUrl —— 直接复用 PV_STATE 不现实，重新拿一次原图
    // /api/sim/render 不返回 dataUrl，改用 sim_frame 监听
    // 简化：发起一个直接拿 dataUrl 的请求？此处利用 sim_frame 事件监听最新一帧
    smSetStatus('已抓帧（等帧广播）', '#a3e635');
  } catch (e) { addSystem('快照失败：' + e.message); smSetStatus('快照失败','#fca5a5'); }
}
// 监听 sim_frame：自动追加为快照（只在 sm-snap-auto 勾选 OR 用户主动点了 📸）
let _snapCaptureArmed = false;
function smArmCapture() { _snapCaptureArmed = true; setTimeout(() => _snapCaptureArmed = false, 8000); }
function smOnSimFrame(dataUrl, meta) {
  // 自动模式：每隔 N 秒抓一次（由定时器驱动）
  // 主动模式：smArmCapture 设置 _snapCaptureArmed=true 后下一帧入轴
  if (!_snapCaptureArmed && !($('sm-snap-auto') && $('sm-snap-auto').checked)) return;
  // 防抖：避免 PV 面板点几次刷新都被抓进来
  const last = SM.snaps[SM.snaps.length-1];
  if (last && Date.now() - last.captured < 1500) return;
  _snapCaptureArmed = false;
  const field = (meta && meta.field_used) || ($('sm-snap-field').value || 'U');
  const t = (meta && meta.time_value !== undefined && meta.time_value !== null) ? meta.time_value : '';
  const label = `t=${typeof t === 'number' ? t.toPrecision(4) : (t || '?')}`;
  SM.snaps.push({ dataUrl, field, t, label, casePath: (meta && meta.case_path) || '', captured: Date.now() });
  if (SM.snaps.length > 60) SM.snaps.shift();
  smRenderSnapStrip();
}

$('sm-refresh-runs') && ($('sm-refresh-runs').onclick = smRefreshRuns);
$('sm-run') && ($('sm-run').onchange = () => { SM.runId = $('sm-run').value; SM.snaps = []; SM.lastResidSig = ''; smRenderSnapStrip(); smPoll(); smRestartTimer(); });
$('sm-interval') && ($('sm-interval').addEventListener('input', () => { $('sm-interval-text').textContent = $('sm-interval').value + 's'; smRestartTimer(); }));
$('sm-auto') && ($('sm-auto').addEventListener('change', smRestartTimer));
$('sm-stop') && ($('sm-stop').onclick = async () => {
  if (!SM.runId) return;
  if (!confirm('终止 runId=' + SM.runId + ' ?')) return;
  await fetch('/api/foam/run/' + encodeURIComponent(SM.runId) + '/stop', { method: 'POST' });
  smPoll();
});
$('sm-snap-now') && ($('sm-snap-now').onclick = () => { smArmCapture(); smCaptureSnapshot(); });
$('sm-snap-clear') && ($('sm-snap-clear').onclick = () => { SM.snaps = []; smRenderSnapStrip(); });
// 自动快照定时器
function smRestartSnapTimer() {
  if (SM.snapTimer) { clearInterval(SM.snapTimer); SM.snapTimer = 0; }
  if ($('sm-snap-auto') && $('sm-snap-auto').checked) {
    const sec = Math.max(5, parseInt($('sm-snap-every').value, 10) || 30);
    SM.snapTimer = setInterval(() => { if (SM.runId) { smArmCapture(); smCaptureSnapshot(); } }, sec * 1000);
  }
}
$('sm-snap-auto') && ($('sm-snap-auto').addEventListener('change', smRestartSnapTimer));
$('sm-snap-every') && ($('sm-snap-every').addEventListener('change', smRestartSnapTimer));
// 启动时及每 8 秒拉一次作业列表 — legacy OpenFOAM endpoint removed, gate on DOM
if ($('sm-run')) {
  setTimeout(smRefreshRuns, 1500);
  setInterval(smRefreshRuns, 8000);
  smRenderSnapStrip();
}


// ====================== 工具开关 ======================
// 与 server.js TOOL_GROUPS 对齐：通用 + LAMMPS（OpenFOAM/MFIX/LBM 已下线）
const TOOL_LABELS = {
  // 通用 shell / 网络 / 文档
  run_command:   ['执行 shell / Python（需审批）', 'shell'],
  web_search:    ['联网搜索（Tavily→Serper→Brave→SearX→爬虫）', 'web'],
  paper_search:  ['学术检索（Semantic Scholar + arXiv）', 'web'],
  fetch_url:     ['抓取网页正文（含图片清单）', 'web'],
  image_search:  ['图片搜索（Bing Images，入图片库）', 'web'],
  download_file: ['下载 URL 到 downloads/', 'web'],
  read_document: ['读 PDF/DOCX/PPTX/XLSX/图片(OCR)', 'doc'],
  read_paper:    ['解析论文（带 OCR 兜底）', 'doc'],
  vision_analyze:['用 VLM 看图回答问题', 'doc'],
  // LAMMPS 检索 / 算例 / 运行 / 后处理
  lmp_env_info:        ['查 LAMMPS 安装与可用包', 'lammps'],
  lmp_find_example:    ['检索本地 examples/', 'lammps'],
  lmp_find_source:     ['检索 LAMMPS 源码', 'lammps'],
  lmp_find_potential:  ['查 potentials/ 力场文件', 'lammps'],
  lmp_doc_lookup:      ['查 LAMMPS 命令文档', 'lammps'],
  lmp_clone_example:   ['克隆官方算例到工作区', 'lammps'],
  lmp_inspect_case:    ['摘要 in.* + data.* + dump', 'lammps'],
  lmp_validate_input:  ['静态语法/单位/包依赖检查', 'lammps'],
  lmp_build_data_file: ['由 PDB/XYZ/Packmol 生成 data.*', 'lammps'],
  lmp_packmol_build:   ['Packmol 装箱（多组分初构）', 'lammps'],
  lmp_ff_select_reaxff:['挑选合适的 ReaxFF ffield', 'lammps'],
  lmp_render_in_template: ['模板渲染 in.lammps', 'lammps'],
  lmp_reaxff_pipeline: ['ReaxFF 一键流水线', 'lammps'],
  lmp_run_async:       ['后台运行 lmp（流式日志）', 'lammps'],
  lmp_run_status:      ['查询后台作业状态', 'lammps'],
  lmp_run_stop:        ['中止后台作业', 'lammps'],
  lmp_parse_log:       ['解析 log.lammps thermo 段', 'lammps'],
  lmp_dump_summary:    ['摘要 dump 轨迹（帧数/原子数）', 'lammps'],
  lmp_plot_thermo:     ['绘制 thermo 曲线（PNG）', 'lammps'],
  lmp_render_traj:     ['NGL/VMD 风格渲染轨迹快照', 'lammps'],
  lmp_diagnose_error:  ['分析 LAMMPS 报错给修复建议', 'lammps']
};
let TOOL_STATE = { enabled: new Set(['run_command','web_search','fetch_url']) };
function renderToolsList() {
  const list = $('tools-list'); list.innerHTML = '';
  Object.entries(TOOL_LABELS).forEach(([name, [label, group]]) => {
    const id = 'tool-' + name;
    const wrap = document.createElement('label');
    wrap.className = 'tool-row';
    wrap.innerHTML = `<input type="checkbox" id="${id}" ${TOOL_STATE.enabled.has(name)?'checked':''}/> <span>${label}</span> <span class="tool-grp">${group}</span>`;
    wrap.querySelector('input').onchange = (e) => {
      if (e.target.checked) TOOL_STATE.enabled.add(name); else TOOL_STATE.enabled.delete(name);
      ws.send(JSON.stringify({ type: 'set_tools', tools: [...TOOL_STATE.enabled] }));
    };
    list.appendChild(wrap);
  });
}
$('tools-btn').onclick = () => { renderToolsList(); $('tools-modal').style.display = 'flex'; };
$('tools-close').onclick = $('tools-cancel').onclick = () => $('tools-modal').style.display = 'none';
// 初次连接后服务端会推 tools_state，由 onmessage 处理

// ====================== Digitizer (V3) 手动标注按钮 ======================
const _digBtn = document.getElementById('digitize-btn');
if (_digBtn) {
  _digBtn.onclick = () => {
    if (!window.NFDigitizer) { alert('digitizer.js 未加载'); return; }
    window.NFDigitizer.open({
      name: 'plot',
      hint: '从论文截图 / 本地 PNG 手动标注数据点'
    });
  };
}

// ====================== 模型选择 / GitHub Copilot / 阿里云 ======================
const MODEL_STATE = { provider: 'sf', sfModel: '', baseUrl: '', copilotModel: 'gpt-4.1', copilotLoggedIn: false, devicePoll: null };

function isAliyun() {
  return MODEL_STATE.provider === 'sf' && /dashscope\.aliyuncs\.com/i.test(MODEL_STATE.baseUrl || '');
}
function updateModelLabel() {
  const lab = $('model-label'); if (!lab) return;
  if (MODEL_STATE.provider === 'copilot') lab.textContent = 'Copilot:' + (MODEL_STATE.copilotModel || '?');
  else if (isAliyun()) lab.textContent = '阿里云:' + (MODEL_STATE.sfModel || 'qwen-plus');
  else lab.textContent = MODEL_STATE.sfModel || 'DeepSeek';
}
const USAGE = { input: 0, output: 0, calls: 0 };
function showUsage(u) {
  if (!u) return;
  USAGE.input += (u.prompt_tokens || u.input_tokens || 0);
  USAGE.output += (u.completion_tokens || u.output_tokens || 0);
  USAGE.calls += 1;
  const lab = $('model-label'); if (!lab) return;
  const base = (MODEL_STATE.provider === 'copilot' ? 'Copilot:' + (MODEL_STATE.copilotModel || '?') : (isAliyun() ? '阿里云:' + (MODEL_STATE.sfModel || 'qwen-plus') : (MODEL_STATE.sfModel || 'DeepSeek')));
  lab.textContent = `${base} · ${(USAGE.input/1000).toFixed(1)}k↑ ${(USAGE.output/1000).toFixed(1)}k↓`;
  lab.title = `本会话累计：输入 ${USAGE.input} tokens · 输出 ${USAGE.output} tokens · ${USAGE.calls} 次调用`;
}
async function refreshModelStatus() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    MODEL_STATE.provider = cfg.provider || 'sf';
    MODEL_STATE.copilotModel = cfg.copilotModel || 'gpt-4.1';
    MODEL_STATE.copilotLoggedIn = !!cfg.copilotLoggedIn;
    MODEL_STATE.sfModel = cfg.model || '';
    MODEL_STATE.baseUrl = cfg.baseUrl || '';
    updateModelLabel();
  } catch {}
}
function selectModelTab(prov) {
  document.querySelectorAll('.mtab').forEach(t => t.classList.toggle('active', t.dataset.prov === prov));
  document.querySelectorAll('.mpane').forEach(p => p.style.display = (p.dataset.prov === prov) ? 'block' : 'none');
  if (prov === 'copilot') refreshCopilotPane();
}
async function refreshCopilotPane() {
  await refreshModelStatus();
  $('cp-loggedout').style.display = MODEL_STATE.copilotLoggedIn ? 'none' : 'block';
  $('cp-loggedin').style.display = MODEL_STATE.copilotLoggedIn ? 'block' : 'none';
  if (MODEL_STATE.copilotLoggedIn) loadCopilotModels(false);
}
async function loadCopilotModels(force) {
  const list = $('cp-models');
  list.innerHTML = '<div class="muted small" style="padding:20px;text-align:center;">加载中…</div>';
  try {
    const r = await fetch('/api/copilot/models'); const j = await r.json();
    if (j.error) { list.innerHTML = `<div class="small" style="color:#fca5a5;padding:10px;white-space:pre-wrap;">${j.error}</div>`; return; }
    const models = j.models || [];
    if (!models.length) { list.innerHTML = '<div class="muted small" style="padding:20px;">没有可用模型（订阅可能不含 chat 权限）</div>'; return; }
    list.innerHTML = '';
    models.forEach(m => {
      const div = document.createElement('div');
      div.className = 'py-item' + (m.id === MODEL_STATE.copilotModel && MODEL_STATE.provider === 'copilot' ? ' current' : '');
      const tools = m.tool ? '<span class="py-conda">tools</span>' : '';
      div.innerHTML = `<div><span class="py-ver">${m.name}</span>${tools}</div><div class="py-path">${m.id} · ${m.vendor}</div>`;
      div.onclick = async () => {
        try {
          const r = await fetch('/api/copilot/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'copilot', model: m.id }) });
          const jj = await r.json();
          if (jj.ok) {
            MODEL_STATE.provider = 'copilot'; MODEL_STATE.copilotModel = m.id;
            updateModelLabel(); addTerm(`[Model] 已切换到 GitHub Copilot · ${m.id}`, 'ok');
            $('model-modal').style.display = 'none';
          } else addSystem('切换失败：' + (jj.error || '未知'));
        } catch (e) { addSystem('切换失败：' + e.message); }
      };
      list.appendChild(div);
    });
  } catch (e) { list.innerHTML = `<div class="small" style="color:#fca5a5;padding:10px;">${e.message}</div>`; }
}
$('model-picker').onclick = async () => {
  $('model-modal').style.display = 'flex';
  await refreshModelStatus();
  // 加载完整 settings，回填 SF / VLM 表单
  try {
    const s = await (await fetch('/api/settings')).json();
    if ($('sf-apikey'))  $('sf-apikey').value  = (s.apiKey && !s.apiKey.startsWith('***')) ? s.apiKey : '';
    if ($('sf-baseurl')) $('sf-baseurl').value = s.baseUrl || 'https://api.deepseek.com';
    if ($('sf-model'))   $('sf-model').value   = s.model || MODEL_STATE.sfModel || '';
    if ($('vlm-baseurl')) $('vlm-baseurl').value = s.visionBaseUrl || 'https://api.siliconflow.cn';
    if ($('vlm-model'))   $('vlm-model').value   = s.visionModel || 'Pro/moonshotai/Kimi-K2.6';
    if ($('vlm-apikey'))  $('vlm-apikey').value  = (s.visionApiKey && !s.visionApiKey.startsWith('***')) ? s.visionApiKey : '';
  } catch {}
  // 默认 tab：阿里云 > Copilot > sf
  let tab = 'sf';
  if (isAliyun()) tab = 'aliyun';
  else if (MODEL_STATE.provider === 'copilot' || MODEL_STATE.copilotLoggedIn) tab = 'copilot';
  if (isAliyun() && $('aliyun-model') && MODEL_STATE.sfModel) {
    $('aliyun-model').value = MODEL_STATE.sfModel;
  }
  selectModelTab(tab);
};
$('model-close').onclick = $('model-cancel').onclick = () => {
  $('model-modal').style.display = 'none';
  if (MODEL_STATE.devicePoll) { clearInterval(MODEL_STATE.devicePoll); MODEL_STATE.devicePoll = null; }
};
document.querySelectorAll('.mtab').forEach(t => t.onclick = () => selectModelTab(t.dataset.prov));
$('sf-apply').onclick = async () => {
  const m = $('sf-model').value.trim();
  const k = $('sf-apikey').value.trim();
  const u = $('sf-baseurl').value.trim();
  if (!m) { addSystem('请填模型名'); return; }
  if (!u) { addSystem('请填 Base URL'); return; }
  const body = { provider: 'sf', model: m, baseUrl: u };
  if (k) body.apiKey = k;  // 留空保留原有
  await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  MODEL_STATE.provider = 'sf'; MODEL_STATE.sfModel = m; MODEL_STATE.baseUrl = u;
  updateModelLabel(); addTerm(`[Model] 已切换到 ${m} (${u})`, 'ok');
  $('model-modal').style.display = 'none';
};
// VLM 视觉模型保存
if ($('vlm-apply')) {
  $('vlm-apply').onclick = async () => {
    const body = {
      visionBaseUrl: $('vlm-baseurl').value.trim() || undefined,
      visionModel: $('vlm-model').value.trim() || undefined
    };
    const vk = $('vlm-apikey').value.trim();
    if (vk) body.visionApiKey = vk;
    await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    addTerm(`[VLM] 已保存视觉模型配置 · ${body.visionModel || '(未设)'}`, 'ok');
  };
}
// 阿里云 / 通义千问：DashScope OpenAI 兼容
if ($('aliyun-apply')) {
  $('aliyun-apply').onclick = async () => {
    const apiKey = $('aliyun-key').value.trim();
    const model = $('aliyun-model').value.trim();
    const alsoVision = $('aliyun-also-vlm').checked;
    if (!apiKey) { addSystem('请填阿里云百炼 API Key（sk- 开头）'); return; }
    try {
      const r = await fetch('/api/aliyun/select', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, model, alsoVision })
      });
      const j = await r.json();
      if (!j.ok) { addSystem('切换失败：' + (j.error || '未知')); return; }
      MODEL_STATE.provider = 'sf';
      MODEL_STATE.sfModel = model;
      MODEL_STATE.baseUrl = j.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode';
      updateModelLabel();
      addTerm(`[Model] 已切换到阿里云百炼 · ${model}${alsoVision ? ' (+VLM=qwen-vl-max)' : ''}`, 'ok');
      $('model-modal').style.display = 'none';
    } catch (e) { addSystem('切换失败：' + e.message); }
  };
}
$('cp-login').onclick = async () => {
  $('cp-login').disabled = true;
  try {
    const r = await fetch('/api/copilot/auth/start', { method:'POST' });
    const j = await r.json(); if (j.error) throw new Error(j.error);
    $('cp-uri').textContent = j.verification_uri; $('cp-uri').href = j.verification_uri;
    $('cp-code').textContent = j.user_code;
    $('cp-device').style.display = 'block';
    $('cp-poll-status').textContent = '等待你在浏览器完成授权…';
    MODEL_STATE.deviceCode = j.device_code;
    try { window.open(j.verification_uri, '_blank'); } catch {}
    if (MODEL_STATE.devicePoll) clearInterval(MODEL_STATE.devicePoll);
    let interval = Math.max(5, j.interval || 5) * 1000;
    const expiresAt = Date.now() + (j.expires_in || 900) * 1000;
    let inflight = false;
    const tick = async () => {
      if (inflight) return false; inflight = true;
      try {
        if (Date.now() > expiresAt) { stopPoll(); $('cp-poll-status').textContent = '⏳ 设备码过期，请重试'; $('cp-login').disabled = false; return false; }
        const r2 = await fetch('/api/copilot/auth/poll', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ device_code: MODEL_STATE.deviceCode }) });
        const j2 = await r2.json();
        if (j2.ok) {
          stopPoll();
          $('cp-poll-status').textContent = '✅ 登录成功'; $('cp-login').disabled = false;
          $('cp-device').style.display = 'none';
          MODEL_STATE.copilotLoggedIn = true; addTerm('[Copilot] GitHub 登录成功', 'ok');
          await refreshCopilotPane();
          return true;
        }
        if (j2.error === 'slow_down') {
          // RFC 8628: 轮询过快，间隔 +5s 后重新计时
          interval += 5000;
          $('cp-poll-status').textContent = `⏳ GitHub 限流，已降速到每 ${interval/1000}s 检查一次…`;
          if (MODEL_STATE.devicePoll) clearInterval(MODEL_STATE.devicePoll);
          MODEL_STATE.devicePoll = setInterval(tick, interval);
        } else if (j2.error === 'authorization_pending') {
          $('cp-poll-status').textContent = `等待你在浏览器完成授权…（每 ${interval/1000}s 检查一次）`;
        } else if (j2.error_description) {
          $('cp-poll-status').textContent = '… ' + j2.error_description;
        } else if (j2.error) {
          $('cp-poll-status').textContent = '⚠ ' + j2.error;
        }
      } catch (e) {
        $('cp-poll-status').textContent = '⚠ 网络抖动：' + e.message + '（点 "立即检查" 重试）';
      } finally { inflight = false; }
      return false;
    };
    function stopPoll() { if (MODEL_STATE.devicePoll) clearInterval(MODEL_STATE.devicePoll); MODEL_STATE.devicePoll = null; }
    MODEL_STATE.devicePoll = setInterval(tick, interval);
    MODEL_STATE.deviceTick = tick;
    MODEL_STATE.stopPoll = stopPoll;
  } catch (e) { $('cp-poll-status').textContent = '❌ ' + e.message; $('cp-login').disabled = false; }
};
$('cp-recheck').onclick = async () => {
  if (!MODEL_STATE.deviceCode) { $('cp-poll-status').textContent = '请先点击登录获取设备码'; return; }
  $('cp-poll-status').textContent = '正在检查…';
  if (MODEL_STATE.deviceTick) await MODEL_STATE.deviceTick();
};
$('cp-cancel').onclick = () => {
  if (MODEL_STATE.stopPoll) MODEL_STATE.stopPoll();
  MODEL_STATE.deviceCode = null;
  $('cp-device').style.display = 'none';
  $('cp-login').disabled = false;
};
$('cp-copy').onclick = () => { try { navigator.clipboard.writeText($('cp-code').textContent); $('cp-copy').textContent = '已复制'; setTimeout(()=>$('cp-copy').textContent='复制', 1500); } catch {} };
$('cp-refresh').onclick = () => loadCopilotModels(true);
$('cp-logout').onclick = async () => { await fetch('/api/copilot/logout', { method:'POST' }); MODEL_STATE.copilotLoggedIn = false; refreshCopilotPane(); addTerm('[Copilot] 已退出登录', 'sys'); };
refreshModelStatus();


// ====================== .ipynb 笔记本（含 Jupyter kernel 客户端） ======================
const NB_STATE = new Map(); // path -> { nb, cells:Map<cell_id, {div, srcEl, outEl, monaco?, status, count}>, ready, kernelReady }

async function openNotebook(p) {
  await monacoReady; ensureEditor();
  const r = await fetch('/api/file?path=' + encodeURIComponent(p));
  const j = await r.json(); if (j.error) return addSystem('打开失败：' + j.error);
  let nb; try { nb = JSON.parse(j.content); } catch (e) { return addSystem('ipynb JSON 解析失败：' + e.message); }

  // 注入到固定 host，不要破坏 #editor-host
  const host = document.getElementById('nb-host');
  host.innerHTML = `
    <div class="nb-toolbar">
      <span class="nb-title"></span>
      <span id="nb-kernel-state" class="nb-state">⚪ 未连接</span>
      <button class="mini ok" id="nb-run-all">▶▶ 运行全部</button>
      <button class="mini" id="nb-add-cell">＋ 单元</button>
      <button class="mini" id="nb-save">保存</button>
      <button class="mini" id="nb-interrupt" title="中断 kernel">■</button>
      <button class="mini" id="nb-restart" title="重启 kernel">⟳</button>
      <button class="mini" id="nb-reload" title="重读磁盘">↻</button>
    </div>
    <div class="nb-cells"></div>`;
  host.querySelector('.nb-title').textContent = `${p} · ${(nb.cells||[]).length} cells`;

  const state = { path: p, nb, cells: new Map(), ready: false };
  NB_STATE.set(p, state);

  const cellsEl = host.querySelector('.nb-cells');
  cellsEl.innerHTML = '';
  for (const c of (nb.cells || [])) {
    if (!c.metadata) c.metadata = {};
    if (!c.metadata.dscm_id) c.metadata.dscm_id = 'c-' + Math.random().toString(36).slice(2,10);
    if (!c.cell_type) c.cell_type = 'code';
    if (!('source' in c)) c.source = '';
    if (c.cell_type === 'code' && !('outputs' in c)) c.outputs = [];
    if (c.cell_type === 'code' && !('execution_count' in c)) c.execution_count = null;
    renderCell(state, c, cellsEl);
  }

  activeTab = p; $('save-file').disabled = true;
  showView('nb');
  renderTabs(); updateActiveFileChip();
  document.querySelectorAll('.tree-node.selected').forEach(n => n.classList.remove('selected'));
  const tn = document.querySelector(`.tree-node[data-path="${CSS.escape(p)}"]`); if (tn) tn.classList.add('selected');

  host.querySelector('#nb-run-all').onclick = () => runAllCells(state);
  host.querySelector('#nb-add-cell').onclick = () => { const c = newCell(); state.nb.cells.push(c); renderCell(state, c, cellsEl); };
  host.querySelector('#nb-save').onclick = () => saveNotebook(state);
  host.querySelector('#nb-interrupt').onclick = () => ws.send(JSON.stringify({ type: 'nb_interrupt', path: p }));
  host.querySelector('#nb-restart').onclick = () => { setKernelState(p, '⏳ 重启中'); ws.send(JSON.stringify({ type: 'nb_restart', path: p })); };
  host.querySelector('#nb-reload').onclick = () => openNotebook(p);

  // 启动 / 复用 kernel
  setKernelState(p, '⏳ 启动中');
  ws.send(JSON.stringify({ type: 'nb_open', path: p }));
}

function newCell() { return { cell_type: 'code', source: '', outputs: [], execution_count: null, metadata: { dscm_id: 'c-' + Math.random().toString(36).slice(2,10) } }; }

function renderCell(state, cell, parentEl) {
  const id = cell.metadata.dscm_id;
  const div = document.createElement('div'); div.className = 'nb-cell ' + cell.cell_type; div.dataset.cid = id;
  const isCode = cell.cell_type === 'code';
  div.innerHTML = `
    <div class="nb-cell-head">
      <span class="nb-cnum">${isCode ? `In [<span class="cn">${cell.execution_count||' '}</span>]:` : '— Markdown —'}</span>
      <span class="nb-cell-actions">
        ${isCode ? '<button class="mini ok nb-run">▶ 运行</button>' : ''}
        <select class="mini nb-type"><option value="code"${isCode?' selected':''}>code</option><option value="markdown"${!isCode?' selected':''}>markdown</option></select>
        <button class="mini nb-up" title="上移">▲</button>
        <button class="mini nb-down" title="下移">▼</button>
        <button class="mini no nb-del" title="删除">×</button>
      </span>
    </div>
    <div class="nb-src-wrap"></div>
    <div class="nb-out"></div>`;
  parentEl.appendChild(div);
  const srcWrap = div.querySelector('.nb-src-wrap');
  const initial = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
  const ed = monaco.editor.create(srcWrap, {
    value: initial, language: isCode ? 'python' : 'markdown', theme: 'vs-dark', automaticLayout: true,
    fontSize: 12, minimap: { enabled: false }, scrollBeyondLastLine: false, lineNumbers: isCode ? 'on' : 'off',
    wordWrap: 'on', renderLineHighlight: 'none'
  });
  const fitHeight = () => {
    const lines = ed.getModel().getLineCount();
    const h = Math.min(400, Math.max(38, lines * 19 + 12));
    srcWrap.style.height = h + 'px'; ed.layout();
  };
  fitHeight(); ed.onDidChangeModelContent(() => { cell.source = ed.getValue(); fitHeight(); markNbDirty(state); });
  ed.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => runCell(state, cell));

  const outEl = div.querySelector('.nb-out');
  // 渲染已存在的输出
  if (isCode) renderCellOutputs(outEl, cell.outputs || []);

  state.cells.set(id, { div, ed, outEl, cell });

  div.querySelector('.nb-run')?.addEventListener('click', () => runCell(state, cell));
  div.querySelector('.nb-type').onchange = (e) => {
    cell.cell_type = e.target.value;
    if (cell.cell_type === 'code') { cell.outputs = []; cell.execution_count = null; }
    rerenderCells(state); markNbDirty(state);
  };
  div.querySelector('.nb-up').onclick = () => moveCell(state, id, -1);
  div.querySelector('.nb-down').onclick = () => moveCell(state, id, 1);
  div.querySelector('.nb-del').onclick = () => {
    if (!confirm('删除该 cell？')) return;
    state.nb.cells = state.nb.cells.filter(c => c.metadata?.dscm_id !== id);
    rerenderCells(state); markNbDirty(state);
  };
}

function rerenderCells(state) {
  const host = document.getElementById('nb-host');
  const cellsEl = host.querySelector('.nb-cells'); cellsEl.innerHTML = '';
  // dispose old monacos
  for (const v of state.cells.values()) { try { v.ed.dispose(); } catch {} }
  state.cells.clear();
  for (const c of state.nb.cells) renderCell(state, c, cellsEl);
}
function moveCell(state, id, dir) {
  const arr = state.nb.cells; const i = arr.findIndex(c => c.metadata?.dscm_id === id);
  const j = i + dir; if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]]; rerenderCells(state); markNbDirty(state);
}
function markNbDirty(state) { /* 自动保存或显示 dirty 角标，简单起见保留手动保存 */ }

function renderCellOutputs(outEl, outputs) {
  outEl.innerHTML = '';
  for (const o of (outputs || [])) appendOutput(outEl, o);
  outEl.style.display = (outputs && outputs.length) ? '' : 'none';
}
function appendOutput(outEl, o) {
  outEl.style.display = '';
  if (o.output_type === 'stream' || o.type === 'stream') {
    const pre = document.createElement('pre'); pre.className = 'nb-stream ' + (o.name||'stdout');
    pre.textContent = Array.isArray(o.text) ? o.text.join('') : (o.text || ''); outEl.appendChild(pre);
  } else if (o.output_type === 'error' || o.type === 'error') {
    const pre = document.createElement('pre'); pre.className = 'nb-stream stderr';
    const tb = (o.traceback || []).map(s => String(s).replace(/\x1b\[[0-9;]*m/g,'')).join('\n');
    pre.textContent = (o.ename||'') + ': ' + (o.evalue||'') + (tb ? '\n' + tb : ''); outEl.appendChild(pre);
  } else if (o.output_type === 'display_data' || o.output_type === 'execute_result') {
    const data = o.data || {};
    if (data['image/png']) { const img = document.createElement('img'); img.src = 'data:image/png;base64,' + data['image/png']; img.className = 'nb-img'; outEl.appendChild(img); }
    else if (data['text/html']) { const w = document.createElement('div'); w.className = 'nb-html'; w.innerHTML = Array.isArray(data['text/html'])?data['text/html'].join(''):data['text/html']; outEl.appendChild(w); }
    else if (data['text/plain']) { const pre = document.createElement('pre'); pre.className = 'nb-stream stdout'; pre.textContent = Array.isArray(data['text/plain'])?data['text/plain'].join(''):data['text/plain']; outEl.appendChild(pre); }
  } else if (o.type === 'display') {
    if (o.mime === 'image/png') { const img = document.createElement('img'); img.src = 'data:image/png;base64,' + o.data; img.className = 'nb-img'; outEl.appendChild(img); }
    else if (o.mime === 'text/html') { const w = document.createElement('div'); w.className = 'nb-html'; w.innerHTML = o.data; outEl.appendChild(w); }
    else { const pre = document.createElement('pre'); pre.className = 'nb-stream stdout'; pre.textContent = o.data; outEl.appendChild(pre); }
  }
}

function runCell(state, cell) {
  if (cell.cell_type !== 'code') return;
  const id = cell.metadata.dscm_id;
  const slot = state.cells.get(id); if (!slot) return;
  cell.outputs = []; renderCellOutputs(slot.outEl, []);
  slot.outEl.style.display = ''; slot.outEl.classList.add('running');
  slot.div.querySelector('.cn').textContent = '*';
  ws.send(JSON.stringify({ type: 'nb_execute', path: state.path, code: cell.source || '', cell_id: id }));
}
async function runAllCells(state) {
  for (const c of state.nb.cells) {
    if (c.cell_type !== 'code') continue;
    runCell(state, c);
    // 等待该 cell 的 done 消息（顺序运行）
    await new Promise((res) => {
      const id = c.metadata.dscm_id;
      const handler = (ev) => { const m = ev.detail; if (m.type === 'nb_msg' && m.path === state.path && m.msg.type === 'done' && m.msg.cell_id === id) { window.removeEventListener('dscm-msg', handler); res(); } };
      window.addEventListener('dscm-msg', handler);
    });
  }
}
function setKernelState(path, text) {
  if (activeTab !== path) return;
  const el = document.getElementById('nb-kernel-state'); if (el) el.textContent = text;
}
async function saveNotebook(state) {
  // 把 state.nb 标准化后保存
  const out = JSON.parse(JSON.stringify(state.nb));
  out.nbformat = out.nbformat || 4; out.nbformat_minor = out.nbformat_minor || 5;
  out.metadata = out.metadata || {};
  for (const c of out.cells) {
    c.source = (typeof c.source === 'string') ? c.source : (Array.isArray(c.source) ? c.source.join('') : '');
    if (c.cell_type === 'code') { if (!Array.isArray(c.outputs)) c.outputs = []; if (!('execution_count' in c)) c.execution_count = null; }
    else { delete c.outputs; delete c.execution_count; }
  }
  const r = await fetch('/api/notebook/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: state.path, json: out }) });
  const j = await r.json(); if (j.ok) addTerm(`[Notebook] 已保存 ${state.path}`, 'ok'); else addSystem('保存失败：' + (j.error || ''));
}

// 把 kernel 推过来的消息渲染到对应 cell
function handleNbMsg(path, msg) {
  const state = NB_STATE.get(path); if (!state) return;
  if (msg.type === 'ready') { state.kernelReady = true; setKernelState(path, '🟢 就绪'); return; }
  if (msg.type === 'starting') { setKernelState(path, '⏳ 启动中'); return; }
  if (msg.type === 'fatal') { setKernelState(path, '🔴 ' + (msg.message || '错误')); addSystem('Kernel: ' + msg.message); return; }
  if (msg.type === 'status') { setKernelState(path, msg.state === 'busy' ? '🟡 忙' : '🟢 就绪'); return; }
  const cellId = msg.cell_id; if (!cellId) return;
  const slot = state.cells.get(cellId); if (!slot) return;
  if (msg.type === 'exec_count') { slot.cell.execution_count = msg.n; slot.div.querySelector('.cn').textContent = msg.n; return; }
  if (msg.type === 'done') { slot.outEl.classList.remove('running'); return; }
  if (msg.type === 'stream') {
    appendOutput(slot.outEl, { type: 'stream', name: msg.name, text: msg.text });
    slot.cell.outputs = slot.cell.outputs || []; slot.cell.outputs.push({ output_type: 'stream', name: msg.name, text: msg.text });
  } else if (msg.type === 'display') {
    appendOutput(slot.outEl, { type: 'display', mime: msg.mime, data: msg.data });
    slot.cell.outputs = slot.cell.outputs || []; slot.cell.outputs.push({ output_type: 'display_data', data: { [msg.mime]: msg.data }, metadata: {} });
  } else if (msg.type === 'error') {
    appendOutput(slot.outEl, { type: 'error', ename: msg.ename, evalue: msg.evalue, traceback: msg.traceback });
    slot.cell.outputs = slot.cell.outputs || []; slot.cell.outputs.push({ output_type: 'error', ename: msg.ename, evalue: msg.evalue, traceback: msg.traceback });
    slot.outEl.classList.remove('running');
  }
}

window.addEventListener('dscm-msg', (ev) => {
  const m = ev.detail;
  if (m.type === 'tools_state') {
    TOOL_STATE.enabled = new Set(m.enabled.filter(n => TOOL_LABELS[n]));
    if ($('tools-modal').style.display === 'flex') renderToolsList();
  } else if (m.type === 'nb_msg') {
    handleNbMsg(m.path, m.msg);
  }
});


// ====================== MFIX Beta 面板 ======================
const MFIX_STATE = { enabled: false, root: '', bash: '' };
function updateMfixState(enabled, root, bash) {
  const was = MFIX_STATE.enabled;
  MFIX_STATE.enabled = !!enabled; MFIX_STATE.root = root || ''; MFIX_STATE.bash = bash || '';
  const stEl = $('mfix-state'); if (stEl) { stEl.textContent = MFIX_STATE.enabled ? 'Beta 已启用' : '未启用'; stEl.style.color = MFIX_STATE.enabled ? '#a3e635' : ''; }
  const tgEl = $('mfix-toggle'); if (tgEl) tgEl.textContent = MFIX_STATE.enabled ? '关闭' : '启用';
  const txt = $('mfix-root-text'); if (txt) txt.textContent = MFIX_STATE.root || '(未设置 — 点 ⚙ 配置)';
  const cfgRoot = $('mfix-cfg-root'); if (cfgRoot) cfgRoot.value = MFIX_STATE.root || '';
  const cfgBash = $('mfix-cfg-bash'); if (cfgBash) cfgBash.value = MFIX_STATE.bash || '';
  if (MFIX_STATE.enabled && !was) {
    setPanelVisible('mfix', true);
    setPanelVisible('solver-monitor', true);
    setPanelVisible('paraview', true);
  }
  renderModePills();
}
async function refreshMfixConfig() {
  try { const r = await fetch('/api/mfix/config').then(r => r.json()); updateMfixState(r.mfixMode, r.root, r.bash); } catch {}
}
refreshMfixConfig();

$('mfix-toggle') && ($('mfix-toggle').onclick = () => {
  if (!MFIX_STATE.enabled && !MFIX_STATE.root) { $('mfix-config').click(); return; }
  ws.send(JSON.stringify({ type: 'set_mfix', value: !MFIX_STATE.enabled }));
});
$('mfix-config') && ($('mfix-config').onclick = () => { $('mfix-cfg-root').value = MFIX_STATE.root || ''; $('mfix-cfg-bash').value = MFIX_STATE.bash || ''; $('mfix-cfg-status').textContent = ''; $('mfix-cfg-modal').style.display = 'flex'; $('mfix-cfg-root').focus(); });
$('mfix-cfg-cancel') && ($('mfix-cfg-cancel').onclick = () => $('mfix-cfg-modal').style.display = 'none');
$('mfix-cfg-save') && ($('mfix-cfg-save').onclick = async () => {
  const root = $('mfix-cfg-root').value.trim();
  const bash = $('mfix-cfg-bash').value.trim();
  $('mfix-cfg-status').textContent = '检查中…';
  try {
    await fetch('/api/mfix/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ root, bash, mfixMode: true }) });
    const r = await fetch('/api/mfix/config').then(r => r.json());
    if (!r.exists) { $('mfix-cfg-status').textContent = '⚠ 路径不存在或无权限：' + r.root; $('mfix-cfg-status').style.color = '#fca5a5'; return; }
    if (!r.hasTutorials) { $('mfix-cfg-status').textContent = '⚠ 路径下未发现 tutorials/ 子目录（仍会启用，但 mfix_find_tutorial 会报错）'; $('mfix-cfg-status').style.color = '#fbbf24'; }
    else { $('mfix-cfg-status').textContent = '✓ tutorials/ 检测通过'; $('mfix-cfg-status').style.color = '#a3e635'; }
    ws.send(JSON.stringify({ type: 'set_mfix', value: true }));
    setTimeout(() => $('mfix-cfg-modal').style.display = 'none', 700);
  } catch (e) { $('mfix-cfg-status').textContent = '失败：' + e.message; $('mfix-cfg-status').style.color = '#fca5a5'; }
});

$('mfix-search') && ($('mfix-search').onclick = async () => {
  if (!MFIX_STATE.root) { addSystem('请先点 ⚙ 设置 MFIX 根目录'); return; }
  const q = $('mfix-q').value.trim();
  if (!q) { $('mfix-results').innerHTML = '<div class="muted small" style="padding:10px;">请输入关键词</div>'; return; }
  $('mfix-search').disabled = true; $('mfix-search').textContent = '…';
  try {
    const r = await fetch(`/api/mfix/tutorials?q=${encodeURIComponent(q)}&top_k=30`);
    const t = await r.text();
    if (!r.ok) { $('mfix-results').innerHTML = `<div class="small" style="color:#fca5a5;padding:10px;">${t}</div>`; }
    else $('mfix-results').textContent = t;
  } catch (e) { $('mfix-results').textContent = '失败：' + e.message; }
  finally { $('mfix-search').disabled = false; $('mfix-search').textContent = '搜索'; }
});
$('mfix-q') && $('mfix-q').addEventListener('keydown', e => { if (e.key === 'Enter') $('mfix-search').click(); });

$('mfix-flow-have') && ($('mfix-flow-have').onclick = () => {
  if (!MFIX_STATE.enabled) { addSystem('请先启用 MFIX Beta 模式'); return; }
  const p = prompt('告诉智能体你已经有的 MFIX 算例的相对路径或绝对路径：', '');
  if (!p) return;
  $('input').value = `我已经有具体 MFIX 算例了，路径是 \`${p}\`。请严格按 MFIX 流水式工作流：\n1. 调 mfix_inspect_case("${p}") 一次性摘要并列文件；\n2. update_todos 列出 5–15 项可改项（DT/TIME/IMAX/BC_*/IC_*/物性/输出频率）；\n3. 在聊天里给我**带编号的推荐选项**，每项标注默认值；\n4. **一次只问我一项**，我答了就改 keyword（注意 MFIX 是 \`KEYWORD = value\` 大写格式）；\n5. 全确认后用 mfix_run_solver_async 后台跑，让我在监测面板看。`;
  $('send').click();
});
$('mfix-flow-need') && ($('mfix-flow-need').onclick = () => {
  if (!MFIX_STATE.enabled) { addSystem('请先启用 MFIX Beta 模式'); return; }
  const kw = prompt('告诉智能体你的关键词（如 fluidBed / Geldart-B / DEM / TFM / 喷动床）：', '');
  if (!kw) return;
  $('input').value = `我没有具体 MFIX 算例，关键词：${kw}。请：\n1. 调 mfix_find_tutorial("${kw}", 12) 列 tutorials 候选；\n2. update_todos 写成清单；\n3. 在聊天里用 1) 2) 3) 编号列出，等我回编号；\n4. **不要替我做选择**。我选了之后 mfix_clone_tutorial → mfix_inspect_case → 流水式工作流。`;
  $('send').click();
});


// ====================== LBM Beta 面板 ======================
const LBM_STATE = { enabled: false, tutorialRoot: '', runCmd: '' };
function updateLbmState(enabled, tutorialRoot, runCmd) {
  const was = LBM_STATE.enabled;
  LBM_STATE.enabled = !!enabled; LBM_STATE.tutorialRoot = tutorialRoot || ''; LBM_STATE.runCmd = runCmd || '';
  const stEl = $('lbm-state'); if (stEl) { stEl.textContent = LBM_STATE.enabled ? 'Beta 已启用' : '未启用'; stEl.style.color = LBM_STATE.enabled ? '#a3e635' : ''; }
  const tgEl = $('lbm-toggle'); if (tgEl) tgEl.textContent = LBM_STATE.enabled ? '关闭' : '启用';
  const txt = $('lbm-root-text'); if (txt) txt.textContent = LBM_STATE.tutorialRoot || '(未设置 — 点 ⚙ 配置)';
  const cfgRoot = $('lbm-cfg-root'); if (cfgRoot) cfgRoot.value = LBM_STATE.tutorialRoot || '';
  const cfgRun  = $('lbm-cfg-runcmd'); if (cfgRun) cfgRun.value = LBM_STATE.runCmd || '';
  if (LBM_STATE.enabled && !was) {
    setPanelVisible('lbm', true);
    setPanelVisible('solver-monitor', true);
    setPanelVisible('paraview', true);
  }
  renderModePills();
}
async function refreshLbmConfig() {
  try { const r = await fetch('/api/lbm/config').then(r => r.json()); updateLbmState(r.lbmMode, r.tutorialRoot, r.runCmd); } catch {}
}
refreshLbmConfig();

$('lbm-toggle') && ($('lbm-toggle').onclick = () => {
  if (!LBM_STATE.enabled && !LBM_STATE.tutorialRoot) { $('lbm-config').click(); return; }
  ws.send(JSON.stringify({ type: 'set_lbm', value: !LBM_STATE.enabled }));
});
$('lbm-config') && ($('lbm-config').onclick = () => { $('lbm-cfg-root').value = LBM_STATE.tutorialRoot || ''; $('lbm-cfg-runcmd').value = LBM_STATE.runCmd || ''; $('lbm-cfg-status').textContent = ''; $('lbm-cfg-modal').style.display = 'flex'; $('lbm-cfg-root').focus(); });
$('lbm-cfg-cancel') && ($('lbm-cfg-cancel').onclick = () => $('lbm-cfg-modal').style.display = 'none');
$('lbm-cfg-save') && ($('lbm-cfg-save').onclick = async () => {
  const tutorialRoot = $('lbm-cfg-root').value.trim();
  const runCmd = $('lbm-cfg-runcmd').value.trim();
  $('lbm-cfg-status').textContent = '检查中…';
  try {
    await fetch('/api/lbm/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tutorialRoot, runCmd, lbmMode: true }) });
    const r = await fetch('/api/lbm/config').then(r => r.json());
    if (!r.exists) { $('lbm-cfg-status').textContent = '⚠ 路径不存在或无权限：' + r.tutorialRoot; $('lbm-cfg-status').style.color = '#fca5a5'; return; }
    $('lbm-cfg-status').textContent = '✓ 路径检测通过'; $('lbm-cfg-status').style.color = '#a3e635';
    ws.send(JSON.stringify({ type: 'set_lbm', value: true }));
    setTimeout(() => $('lbm-cfg-modal').style.display = 'none', 700);
  } catch (e) { $('lbm-cfg-status').textContent = '失败：' + e.message; $('lbm-cfg-status').style.color = '#fca5a5'; }
});

$('lbm-search') && ($('lbm-search').onclick = async () => {
  if (!LBM_STATE.tutorialRoot) { addSystem('请先点 ⚙ 设置 LBM 算例根目录'); return; }
  const q = $('lbm-q').value.trim();
  if (!q) { $('lbm-results').innerHTML = '<div class="muted small" style="padding:10px;">请输入关键词</div>'; return; }
  $('lbm-search').disabled = true; $('lbm-search').textContent = '…';
  try {
    const r = await fetch(`/api/lbm/tutorials?q=${encodeURIComponent(q)}&top_k=30`);
    const t = await r.text();
    if (!r.ok) { $('lbm-results').innerHTML = `<div class="small" style="color:#fca5a5;padding:10px;">${t}</div>`; }
    else $('lbm-results').textContent = t;
  } catch (e) { $('lbm-results').textContent = '失败：' + e.message; }
  finally { $('lbm-search').disabled = false; $('lbm-search').textContent = '搜索'; }
});
$('lbm-q') && $('lbm-q').addEventListener('keydown', e => { if (e.key === 'Enter') $('lbm-search').click(); });

$('lbm-flow-have') && ($('lbm-flow-have').onclick = () => {
  if (!LBM_STATE.enabled) { addSystem('请先启用 LBM Beta 模式'); return; }
  const p = prompt('告诉智能体你已经有的 LBM 算例路径：', '');
  if (!p) return;
  const algo = prompt('（可选）告诉智能体算法（如 D2Q9 BGK / D3Q19 MRT / Cumulant / Shan-Chen 多相）。直接回车跳过：', '') || '';
  $('input').value = `我已经有 LBM 算例了，路径 \`${p}\`${algo ? '，算法：' + algo : ''}。请按 LBM 工作流：\n1. 调 lbm_inspect_case("${p}"${algo ? ', "' + algo + '"' : ''}) 摘要 + 自动识别算法骨架；\n2. update_todos 列出可改项（NX/NY/NZ、Re、tau、u_lb、总步数、输出频率、BC、IC）；\n3. 在聊天里给我**带编号的推荐选项**；\n4. **一次只问我一项**，我答完你 edit_file 改源码 / params；\n5. 全确认后 lbm_run_async 跑（C++ 算例先编译），让我在监测面板看。`;
  $('send').click();
});
$('lbm-flow-need') && ($('lbm-flow-need').onclick = () => {
  if (!LBM_STATE.enabled) { addSystem('请先启用 LBM Beta 模式'); return; }
  const kw = prompt('告诉智能体你的关键词（如 D3Q19 / MRT / Shan-Chen / cavity / Poiseuille）：', '');
  if (!kw) return;
  $('input').value = `我没有具体 LBM 算例，关键词：${kw}。请：\n1. 调 lbm_find_tutorial("${kw}", 12) 列候选；\n2. update_todos 写成清单；\n3. 在聊天里用 1) 2) 3) 编号列出，等我回编号；\n4. **不要替我做选择**。我选了之后 lbm_clone_tutorial → lbm_inspect_case → 工作流。`;
  $('send').click();
});
$('lbm-flow-algo') && ($('lbm-flow-algo').onclick = () => {
  if (!LBM_STATE.enabled) { addSystem('请先启用 LBM Beta 模式'); return; }
  const algo = prompt('告诉智能体你要用的算法（核心三件套：格子+碰撞+边界）：\n例：D3Q19 MRT + Zou-He 入口 + bounce-back 壁面\n   D2Q9 BGK + extrapolation 入口\n   D3Q19 Cumulant + half-way bounce-back', '');
  if (!algo) return;
  $('input').value = `我希望用以下 LBM 算法：${algo}。\n请：\n1. 先问我"你想从已有算例改写还是从零搭"；\n2. 如果是改写 → 调 lbm_find_tutorial 找最近的；\n3. 如果是从零 → 列出实现清单（equilibrium / collision / streaming 三大核心函数 + BC + IO），用 update_todos 跟踪；\n4. 然后按 LBM 工作流（一次问一项 + 立即应用）继续。`;
  $('send').click();
});

// ====================== 自定义工作流 (Beta) ======================
const CUSTOM_STATE = { enabled: false, name: '', root: '', prompt: '', _firstPush: true };
function updateCustomState(enabled, name, root, promptText) {
  const wasEnabled = CUSTOM_STATE.enabled;
  const oldLen = (CUSTOM_STATE.prompt || '').length;
  CUSTOM_STATE.enabled = !!enabled;
  if (typeof name === 'string') CUSTOM_STATE.name = name;
  if (typeof root === 'string') CUSTOM_STATE.root = root;
  if (typeof promptText === 'string') CUSTOM_STATE.prompt = promptText;
  const newLen = (CUSTOM_STATE.prompt || '').length;
  const stEl = $('custom-state'); if (stEl) {
    stEl.textContent = CUSTOM_STATE.enabled ? `已启用 · ${CUSTOM_STATE.name || '未命名'}` : '未启用';
    stEl.style.color = CUSTOM_STATE.enabled ? '#c4b5fd' : '';
  }
  const tg = $('custom-toggle'); if (tg) tg.textContent = CUSTOM_STATE.enabled ? '关闭' : '启用';
  const nt = $('custom-name-text'); if (nt) nt.textContent = CUSTOM_STATE.name || '(未命名)';
  const rt = $('custom-root-text'); if (rt) rt.textContent = CUSTOM_STATE.root || '(可选/未设置)';
  const pv = $('custom-preview'); if (pv) {
    const t = (CUSTOM_STATE.prompt || '').trim();
    pv.textContent = t ? (t.length > 600 ? t.slice(0, 600) + ' …(共 ' + t.length + ' 字符)' : t)
                       : '(尚未配置 prompt 流水。点 ⚙ 写一段，或塞参考示例。)';
  }
  renderModePills();
  // —— 显式反馈：仅在状态实际变化时往聊天区报告（初次连接时的状态推送不算）
  if (!CUSTOM_STATE._firstPush) {
    if (CUSTOM_STATE.enabled !== wasEnabled) {
      if (CUSTOM_STATE.enabled) {
        try { addSystem(`✅ 自定义工作流已启用：「${CUSTOM_STATE.name || '未命名'}」（${newLen} 字符已注入到 system prompt）。可点面板里"🧪 测试"按钮验证生效。`); } catch {}
        // 启用时自动把面板调出来 + 弹到顶
        try { setPanelVisible('custom', true); } catch {}
        const panel = document.querySelector('.panel[data-pid="custom"]');
        if (panel) { panel.style.zIndex = 999; setTimeout(() => panel.style.zIndex = '', 1500); }
      } else {
        try { addSystem(`⚪ 自定义工作流已关闭（system prompt 移除 ${oldLen} 字符）`); } catch {}
      }
    } else if (CUSTOM_STATE.enabled && newLen !== oldLen) {
      try { addSystem(`✏ 自定义工作流已更新：「${CUSTOM_STATE.name || '未命名'}」（${oldLen} → ${newLen} 字符）`); } catch {}
    }
  }
  CUSTOM_STATE._firstPush = false;
}

// 参考示例：Matplotlib 学术绘图工作流（一个流程化、画图规范的样板）
const CUSTOM_EXAMPLE_PROMPT = `========== Matplotlib 学术出版图绘图工作流 ==========
你是一个"学术绘图助手"。用户给你数据或脚本，你按下面流水线一步步走，**每一步都先确认再动手**，不要一口气把图画完。

## 第 1 步：理解需求（必须）
- 问用户三件事，一次问一项：
  1) 这张图用在哪里？（论文正文 / 答辩 PPT / 期刊封面）
  2) 数据来自哪里？（提供文件路径，或贴一段示例）
  3) 想要什么图型？（line / scatter / bar / heatmap / contour / errorbar / violin）
- 收齐再继续。不要猜。

## 第 2 步：检查数据
- 用 read_file / run_command 看一眼数据头部（前 20 行）。
- 列出列名、单位、数据规模、缺失值情况。
- 如果数据不干净，先在聊天里报告，问用户是否要清洗。

## 第 3 步：规范约束（写代码必须遵守）
- 使用 matplotlib，禁止依赖 seaborn 主题（除非用户明确同意）。
- 字体：英文 'Arial' 或 'Helvetica'；中文 'SimHei' 或 'Source Han Sans'。字号正文 10pt，刻度 9pt，标题 11pt。
- 颜色：≤4 条线时用 ['#1f77b4', '#d62728', '#2ca02c', '#9467bd']；多条线用 viridis / cividis。
- 线宽 1.4；marker size 5；网格 alpha=0.3 dashed。
- 必须有：xlabel + ylabel + 单位（如 "Velocity [m/s]"）、legend（loc='best'，frameon=False）。
- 图尺寸默认 figsize=(3.5, 2.6) 英寸（单栏），双栏用 (7.2, 2.6)。
- dpi=300，bbox_inches='tight'，输出 PDF + PNG 两份。
- 不允许 plt.show() 留在脚本里（会卡 headless）。

## 第 4 步：先出"骨架版"（mandatory dry-run）
- 写出**最小可运行脚本**，只画轴 + 一条假数据，验证字体、尺寸、保存路径都对。
- 用 run_command 跑一遍，检查输出文件存在。
- 给用户看一下骨架截图（用 read_file 把 PNG 路径报上去）。

## 第 5 步：接真数据 + 出正式版
- 把真实数据接进去。
- 跑完后必须自检：
  - 输出文件存在 ✓
  - 文件大小 > 10 KB（防止空图）✓
  - 用 python -c "from PIL import Image; print(Image.open('xxx.png').size)" 验证尺寸 ✓

## 第 6 步：交付清单
- 在聊天里列出：脚本路径 / PDF 路径 / PNG 路径 / 用到的字体 / 颜色方案。
- 问用户：要不要调整？（颜色 / 字号 / 图例位置 / 标注）
- 一次只调一项，调完立刻重跑保存。

## 禁止事项
- ❌ 不要主动加 seaborn 风格。
- ❌ 不要把脚本写成 Jupyter cell 形式（要纯 .py，可命令行跑）。
- ❌ 不要静默改变用户给的数值（如把对数轴换成线性轴）— 必须先问。
- ❌ 不要画完不验证就说"已完成"。

## 终止条件
- 用户说"OK 收工" → 把最终脚本、PDF、PNG 路径汇总成一行 markdown 链接发给用户，结束。
========================================================`;

// 多套工作流模板库（用户可以一键塞入）
const CUSTOM_TEMPLATES = {
  plot: { name: 'Matplotlib 学术绘图', prompt: CUSTOM_EXAMPLE_PROMPT },
  paper: { name: '论文 Review 工作流', prompt: `========== 论文 Review 工作流 ==========
你是"论文审稿助手"。用户会给你一篇 PDF 或 markdown 路径，你按下面流程走。

## 第 1 步：定位与扫读
- 用 read_file 读取首页/摘要/结论；如果是 PDF，调用 fetch_url 或 run_command 跑 pdftotext。
- 用 1-2 句话总结：本文做了什么、贡献点是什么、属于什么领域。
- 列出 3-5 个 key concepts。等用户确认再继续。

## 第 2 步：结构化拆解
按以下小标题逐节拆，每节 ≤ 80 字：
- 问题与动机（problem statement）
- 相关工作的差距（gap）
- 方法核心（method, 3 句话）
- 实验设置（dataset / metric / baseline）
- 主要结果（带数字）
- 局限与未来工作

## 第 3 步：可信度审查
- 实验是否复现可行？（数据集公开？代码公开？）
- 关键数字与图表是否一致？
- 是否存在 cherry-picking 嫌疑？
- 数学/公式有无明显错误？

## 第 4 步：横向对照
- 用 web_search / paper_search 查 2-3 篇近年同方向最强 baseline。
- 列表对比：方法 / 结果 / 算力代价。
- 指出本文的真实优势位置（不要夸大也不要贬低）。

## 第 5 步：审稿意见输出
按 NeurIPS/ICML 风格生成：
- Summary（不超过 150 字）
- Strengths（≥ 3 条，每条带证据）
- Weaknesses（≥ 3 条，分轻重）
- Questions to authors（≥ 3 个尖锐问题）
- Soundness / Presentation / Contribution 三项打分 1-4
- Overall recommendation（accept / weak accept / weak reject / reject）+ 一句话 justification

## 禁止
- ❌ 不要笼统说"创新性不足"，必须指出具体缺哪个 baseline / 哪个 ablation。
- ❌ 不要复述摘要假装是 review。
========================================================`},
  code: { name: '代码 Review 工作流', prompt: `========== 代码 Review 工作流 ==========
你是"严肃的 senior 工程师"。用户给你一个文件/目录/diff，你按下面流程走。

## 第 1 步：边界确认
- 问用户：(1) 这段代码用在哪里（生产/原型/一次性脚本）？(2) 性能是否敏感？(3) 关注点是什么（安全/可读/性能/正确性）？
- 不收齐不开始。

## 第 2 步：地形勘察
- 用 list_dir 看项目结构、用 read_file 读入口文件、用 grep_search 找依赖。
- 列出：语言/框架/构建系统/测试现状。

## 第 3 步：分层 Review（按优先级）
1) **正确性 bug**（最高优先级）— 用 grep_search 找可疑模式（null 解引用、未释放资源、未关闭 fd、race condition）。
2) **安全漏洞**（OWASP Top 10 + 注入 + 反序列化 + 越权）— 报具体行号 + 攻击 PoC。
3) **性能陷阱**（N+1、热路径上的 O(n²)、不必要的 alloc / clone、同步阻塞 I/O）— 报具体行号 + 优化建议。
4) **可读性与命名**。
5) **测试覆盖**（边界值、错误路径有没有 cover）。

## 第 4 步：输出格式（必须）
每个发现写成一行：
\`[严重度] file:line — 问题 — 推荐做法\`
严重度：🔴 必须改 / 🟡 应该改 / 🟢 建议改 / 💡 nit。

## 第 5 步：自动补丁
- 对 🔴 项给出 edit_file 补丁（每个一份）。
- 不要批量改超过 3 处而不让用户确认。

## 禁止
- ❌ 不要笼统说"代码风格不好"。
- ❌ 不要复述代码作用。
- ❌ 不要瞎猜没看到的文件，先 read_file。
========================================================`},
  data: { name: '数据清洗与分析', prompt: `========== 数据清洗与分析工作流 ==========
你是"数据分析师"。用户给你 csv/parquet/xlsx 路径，你按下面流程走。

## 第 1 步：体检（profiling）
- 用 run_command 跑：行数、列数、dtypes、缺失率、唯一值 top 10。
- 一律先在 jupyter 风格的 python 脚本里输出 head(10) / describe() / info()。
- 在聊天里报告"数据画像"。

## 第 2 步：清洗清单
列出（不要执行）：
- 缺失值如何处理（drop / fill mean/median/mode / 插值）？
- 异常值如何处理（IQR / z-score / 业务规则）？
- 时间列格式统一？时区？
- 重复行？主键定义？
- 字符串列：trim / lower / 编码？
- 数值列单位统一？

让用户逐条确认。

## 第 3 步：清洗执行
- 每一步用一个独立的 cell（或函数），保留中间状态。
- 每步后输出：处理了多少行、剩多少行、关键统计前后对比。

## 第 4 步：分析
- 先做单变量分布（直方图 + 箱线图）。
- 再做相关性矩阵（数值列）/ 列联表（类别列）。
- 业务问题驱动的可视化。
- 用 update_todos 跟踪分析问题清单。

## 第 5 步：交付
- 清洗脚本（.py，可独立跑）
- 清洗后数据（parquet 优先，csv 次之）
- 分析图表（PNG + PDF）
- markdown 报告（结论先行，证据后置）

## 禁止
- ❌ 不要不看数据画像就动手清洗。
- ❌ 不要无声修改类型/单位/时区。
- ❌ 不要把"缺失值"和"零"混为一谈。
========================================================`},
  research: { name: '通用研究助手', prompt: `========== 通用研究助手工作流 ==========
你是"研究助手"。用户给你一个问题/题目，你按下面流程走。

## 第 1 步：澄清范围
- 复述问题，列出 3-5 个 sub-question。
- 问用户：(1) 目标是综述 / 论证 / 实操？(2) 时效要求（最近 1 年 / 5 年）？(3) 语言（中/英/中英）？
- 不澄清不开始。

## 第 2 步：检索
- 优先 paper_search（学术）+ web_search（背景与新闻）。
- 每个 sub-question 至少检索 1 轮。
- 在聊天里报告：找了哪些关键词 / 拿到几篇 / 排序依据。

## 第 3 步：来源审查
对每条引用：
- 来源（arxiv / 期刊 / 博客 / 官方文档）
- 时间
- 可信度评估（一星到五星）
- 与问题相关度

低质量来源（个人博客无引用、营销稿）必须剔除。

## 第 4 步：综合
- 先写"已确认事实"清单（带引用）。
- 再写"分歧/不确定"清单（带各方观点）。
- 最后写"未解决问题"清单。

## 第 5 步：交付
- markdown 报告（结论先行 + 分层论证 + 引用列表）
- 引用必须 [^n] 脚注 + 末尾 References
- 关键数字必须有出处

## 禁止
- ❌ 不要编造引用（fabricated citation 是死罪）。
- ❌ 不要说"研究表明……"而无具体出处。
- ❌ 不要把 AI 自己的训练知识当作 source（必须 web_search 验证）。
========================================================`},
};

$('custom-toggle') && ($('custom-toggle').onclick = () => {
  if (!CUSTOM_STATE.enabled && !(CUSTOM_STATE.prompt || '').trim()) {
    $('custom-config').click();
    return;
  }
  ws.send(JSON.stringify({ type: 'set_custom', enabled: !CUSTOM_STATE.enabled }));
});
$('custom-config') && ($('custom-config').onclick = () => {
  $('custom-cfg-name').value   = CUSTOM_STATE.name   || '';
  $('custom-cfg-root').value   = CUSTOM_STATE.root   || '';
  $('custom-cfg-prompt').value = CUSTOM_STATE.prompt || '';
  $('custom-cfg-status').textContent = '';
  $('custom-cfg-modal').style.display = 'flex';
});
$('custom-cfg-cancel') && ($('custom-cfg-cancel').onclick = () => $('custom-cfg-modal').style.display = 'none');
$('custom-cfg-example') && ($('custom-cfg-example').onclick = () => {
  const sel = $('custom-cfg-template');
  const key = sel ? sel.value : 'plot';
  const tpl = CUSTOM_TEMPLATES[key] || CUSTOM_TEMPLATES.plot;
  const ta = $('custom-cfg-prompt');
  if (ta.value.trim() && !confirm(`将覆盖当前内容为模板「${tpl.name}」，确定？`)) return;
  ta.value = tpl.prompt;
  if (!$('custom-cfg-name').value.trim()) $('custom-cfg-name').value = tpl.name;
  $('custom-cfg-status').textContent = `✓ 已应用模板「${tpl.name}」，可按需修改后保存`;
});
$('custom-cfg-clear') && ($('custom-cfg-clear').onclick = () => { $('custom-cfg-prompt').value = ''; });
async function _customSave(enable) {
  const name   = $('custom-cfg-name').value.trim();
  const root   = $('custom-cfg-root').value.trim();
  const promptText = $('custom-cfg-prompt').value;
  if (enable && !promptText.trim()) { $('custom-cfg-status').textContent = '✗ Prompt 流水不能为空'; return; }
  $('custom-cfg-status').textContent = '保存中…';
  try {
    const r = await fetch('/api/custom/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, root, prompt: promptText })
    }).then(r => r.json());
    if (!r.ok) throw new Error(r.error || 'save failed');
    ws.send(JSON.stringify({ type: 'set_custom', enabled: !!enable, name, root, prompt: promptText }));
    $('custom-cfg-status').textContent = enable ? '✓ 已保存并启用' : '✓ 已保存（未启用）';
    setTimeout(() => $('custom-cfg-modal').style.display = 'none', 600);
  } catch (e) { $('custom-cfg-status').textContent = '失败：' + e.message; }
}
$('custom-cfg-save')        && ($('custom-cfg-save').onclick        = () => _customSave(false));
$('custom-cfg-save-enable') && ($('custom-cfg-save-enable').onclick = () => _customSave(true));
$('custom-test') && ($('custom-test').onclick = () => {
  if (!CUSTOM_STATE.enabled) {
    addSystem('⚠ 自定义工作流尚未启用，先点"启用"或在 ⚙ 里"保存并启用"。');
    return;
  }
  const probe =
`[自检] 请用一段话告诉我：你当前在执行哪个自定义工作流？它的名称、核心步骤、禁止事项分别是什么？` +
`\n仅作回答，不要执行任何工具。`;
  const inp = $('input'); if (inp) { inp.value = probe; $('send') && $('send').click(); }
});

// ============================================================================
//  训练模式 UI（领域技能包）—— 自包含注入，不依赖 index.html 结构
//  · 手动选/命名领域 · 全闭环：注入→反思→晋升→适应度面板
//  · 强信号自动沉淀（显示在“经验”里）；弱信号候选（“待确认”，需点确认）
// ============================================================================
(function () {
  const send = (o) => { try { ws && ws.readyState === 1 && ws.send(JSON.stringify(o)); } catch {} };
  const STATE = { active: '', activeName: '', skills: [], status: null, training: false, trainMsg: '', trainIters: 3, trainValidate: true, trainFresh: false };
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // —— 启动器按钮 ——
  const btn = document.createElement('button');
  btn.id = 'skill-launcher';
  btn.title = '技能库：按领域沉淀可复用经验';
  btn.textContent = '🧠 技能';
  btn.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:10001;padding:8px 12px;border-radius:20px;border:1px solid #3b4252;background:#2e3440;color:#d8dee9;cursor:pointer;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.35);';
  document.body.appendChild(btn);
  function refreshBtn() {
    btn.textContent = STATE.active ? `🧠 ${STATE.activeName || STATE.active}` : '🧠 技能';
    btn.style.background = STATE.active ? '#3b5e3b' : '#2e3440';
    btn.style.color = STATE.active ? '#d8ffd8' : '#d8dee9';
  }

  // —— 面板 ——
  const panel = document.createElement('div');
  panel.id = 'skill-panel';
  panel.style.cssText = 'position:fixed;left:16px;bottom:60px;width:420px;max-height:72vh;overflow:auto;z-index:10002;background:#22272e;border:1px solid #3b4252;border-radius:10px;padding:14px;color:#d8dee9;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.5);display:none;';
  document.body.appendChild(panel);
  // —— 面板可拖动 + 位置持久化（修复“面板没法移动 / 时有时无”）——
  function restorePanelPos() {
    try {
      const p = JSON.parse(localStorage.getItem('skillPanelPos') || 'null');
      if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) {
        // 夹回可视区域，避免存了一个屏幕外的位置导致“看不到面板”
        const left = Math.max(0, Math.min(p.left, window.innerWidth - 80));
        const top = Math.max(0, Math.min(p.top, window.innerHeight - 40));
        panel.style.left = left + 'px'; panel.style.top = top + 'px';
        panel.style.right = 'auto'; panel.style.bottom = 'auto';
      }
    } catch {}
  }
  let _skDrag = null;
  panel.addEventListener('mousedown', (e) => {
    const head = e.target.closest('#sk-drag-head');
    if (!head || e.target.closest('#sk-close')) return;
    const r = panel.getBoundingClientRect();
    // 转成 left/top 定位再拖，避免 right/bottom 锚点造成跳动
    panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    _skDrag = { mx: e.clientX, my: e.clientY, left: r.left, top: r.top };
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!_skDrag) return;
    let nx = _skDrag.left + (e.clientX - _skDrag.mx);
    let ny = _skDrag.top + (e.clientY - _skDrag.my);
    nx = Math.max(0, Math.min(nx, window.innerWidth - 80));
    ny = Math.max(0, Math.min(ny, window.innerHeight - 40));
    panel.style.left = nx + 'px'; panel.style.top = ny + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!_skDrag) return;
    _skDrag = null;
    try { localStorage.setItem('skillPanelPos', JSON.stringify({ left: panel.offsetLeft, top: panel.offsetTop })); } catch {}
  });
  btn.onclick = () => {
    const show = panel.style.display === 'none';
    panel.style.display = show ? 'block' : 'none';
    if (show) { restorePanelPos(); send({ type: 'skill_list' }); if (STATE.active) send({ type: 'skill_status' }); }
  };

  function render() {
    const s = STATE.status;
    const opts = STATE.skills.map(k => `<option value="${esc(k.id)}" ${k.id === STATE.active ? 'selected' : ''}>${esc(k.name)} · ${k.runs}次/${k.health}%</option>`).join('');
    let html = `
      <div id="sk-drag-head" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;cursor:move;user-select:none;">
        <b style="font-size:14px;">🧠 技能库（领域经验沉淀）</b>
        <span id="sk-close" style="cursor:pointer;opacity:.6;">✕</span>
      </div>
      <div style="background:#2b313a;border-radius:8px;padding:8px;margin-bottom:8px;">
        <div style="display:flex;gap:6px;align-items:center;">
          <select id="sk-select" style="flex:1;background:#1c2128;color:#d8dee9;border:1px solid #3b4252;border-radius:6px;padding:4px;">
            <option value="">— 选择领域 —</option>${opts}
          </select>
          <button id="sk-activate" style="padding:4px 8px;border-radius:6px;border:1px solid #3b4252;background:${STATE.active ? '#3b5e3b' : '#2e3440'};color:#d8dee9;cursor:pointer;">${STATE.active ? '关闭注入' : '启用注入'}</button>
        </div>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <input id="sk-newname" placeholder="新建领域名，如：限域流动 / 热解反应" style="flex:1;background:#1c2128;color:#d8dee9;border:1px solid #3b4252;border-radius:6px;padding:4px;">
          <button id="sk-create" style="padding:4px 8px;border-radius:6px;border:1px solid #3b4252;background:#2e3440;color:#d8dee9;cursor:pointer;">新建并启用</button>
        </div>
        <div style="font-size:11px;opacity:.6;margin-top:5px;">启用后，该领域的硬经验会注入系统提示；任务跑出明确成果时，会在对话里问你要不要把本轮经验存进技能。</div>
      </div>`;
    if (s) {
      const c = s.curve || [];
      html += `<div style="background:#2b313a;border-radius:8px;padding:8px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;"><b>${esc(s.name)}</b><span style="opacity:.7;">健康率 ${s.health}% · 跑过 ${s.stats.runs} 次</span></div>
        <div style="font-size:11px;opacity:.7;margin:3px 0;">lint通过 ${s.stats.lintPass} · 探针健康 ${s.stats.healthy} · 完整完成 ${s.stats.completed} · 含失败 ${s.stats.failures}</div>
        ${sparkline(c)}
      </div>`;
      // 候选（待确认）
      if ((s.candidates || []).length) {
        html += `<div style="margin-bottom:6px;"><b>🕓 待确认候选（${s.candidates.length}）</b></div>`;
        for (const cd of s.candidates) {
          html += `<div style="background:#3a3326;border-radius:6px;padding:6px;margin-bottom:5px;">
            <div>${esc(cd.text)}</div>
            <div style="font-size:11px;opacity:.6;margin:2px 0;">${esc(cd.why || '')}</div>
            <div style="display:flex;gap:6px;margin-top:4px;">
              <button class="sk-promote" data-id="${esc(cd.id)}" style="padding:3px 8px;border-radius:5px;border:1px solid #4c6e4c;background:#3b5e3b;color:#d8ffd8;cursor:pointer;">✓ 晋升为经验</button>
              <button class="sk-dismiss" data-id="${esc(cd.id)}" style="padding:3px 8px;border-radius:5px;border:1px solid #3b4252;background:#2e3440;color:#d8dee9;cursor:pointer;">忽略</button>
            </div>
          </div>`;
        }
      }
      // 经验
      html += `<div style="margin:6px 0;"><b>📚 已学经验（${(s.lessons || []).length}）</b></div>`;
      if (!(s.lessons || []).length) html += `<div style="opacity:.5;font-size:12px;">暂无，跑几个任务后自动积累。</div>`;
      for (const l of (s.lessons || [])) {
        const tag = l.source === 'auto' ? '<span style="color:#88c0d0;">自动</span>' : '<span style="color:#a3be8c;">手动</span>';
        const durTag = l.durable ? '<span title="客观坑→修法，永久保留，自训练不回滚" style="color:#ebcb8b;">· 客观🛡</span>' : '';
        html += `<div style="background:#2b313a;border-radius:6px;padding:6px;margin-bottom:5px;">
          <div style="display:flex;justify-content:space-between;"><span>${esc(l.text)}</span><span class="sk-del" data-id="${esc(l.id)}" style="cursor:pointer;opacity:.5;margin-left:6px;">🗑</span></div>
          ${l.fix ? `<div style="font-size:11px;color:#8fbcbb;margin-top:2px;">→ ${esc(l.fix)}</div>` : ''}
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;opacity:.6;margin-top:2px;">
            <span>${tag} · 命中 ${l.hits || 1} 次 ${durTag}</span>
            <button class="sk-up" data-id="${esc(l.id)}" data-text="${esc(l.text)}" data-fix="${esc(l.fix || '')}" style="padding:2px 6px;border-radius:5px;border:1px solid #5e5040;background:#3a3326;color:#ead9b0;cursor:pointer;">⬆ 升级为硬规则</button>
          </div>
        </div>`;
      }
      // 领域硬规则（lmp_lint 强制检查）
      html += `<div style="margin:8px 0 4px;"><b>🛡 领域硬规则（${(s.lintRules || []).length}）</b> <span style="font-size:11px;opacity:.6;">违反会被 lmp_lint 拦截</span></div>`;
      if (!(s.lintRules || []).length) html += `<div style="opacity:.5;font-size:12px;">暂无。可把上面的经验“升级为硬规则”。</div>`;
      for (const r of (s.lintRules || [])) {
        html += `<div style="background:#2e2a22;border-radius:6px;padding:6px;margin-bottom:5px;border:1px solid #5e5040;">
          <div style="display:flex;justify-content:space-between;"><span>${r.kind === 'require' ? '必须含' : '禁止'} · ${esc(r.msg || r.name)}</span><span class="sk-delrule" data-id="${esc(r.id)}" style="cursor:pointer;opacity:.5;margin-left:6px;">🗑</span></div>
          <div style="font-size:11px;color:#bf8f6f;margin-top:2px;font-family:monospace;">/${esc(r.pattern)}/  <span style="color:${r.severity === 'warning' ? '#ebcb8b' : '#bf616a'};">${r.severity}</span></div>
          ${r.fix ? `<div style="font-size:11px;color:#8fbcbb;margin-top:2px;">→ ${esc(r.fix)}</div>` : ''}
        </div>`;
      }
      // 领域已验证模板
      html += `<div style="margin:8px 0 4px;"><b>📦 领域模板（${(s.templates || []).length}）</b></div>`;
      html += `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:4px;">`;
      for (const t of (s.templates || [])) html += `<span style="background:#2b313a;border-radius:5px;padding:2px 8px;">${esc(t)} <span class="sk-deltpl" data-name="${esc(t)}" style="cursor:pointer;opacity:.5;">✕</span></span>`;
      html += `</div>
        <div style="display:flex;gap:6px;margin-bottom:8px;">
          <input id="sk-tplname" placeholder="登记已验证模板名，如 confined_flow_poiseuille" style="flex:1;background:#1c2128;color:#d8dee9;border:1px solid #3b4252;border-radius:6px;padding:4px;">
          <button id="sk-tplbtn" style="padding:4px 8px;border-radius:6px;border:1px solid #3b4252;background:#2e3440;color:#d8dee9;cursor:pointer;">登记</button>
        </div>
        <div id="sk-rule-form" style="display:none;background:#2e2a22;border:1px solid #5e5040;border-radius:6px;padding:8px;margin-bottom:8px;">
          <div style="font-size:12px;margin-bottom:4px;">升级为硬规则：<span id="sk-rule-from" style="opacity:.7;"></span></div>
          <div style="display:flex;gap:6px;margin-bottom:4px;">
            <select id="sk-rule-kind" style="background:#1c2128;color:#d8dee9;border:1px solid #3b4252;border-radius:6px;padding:4px;"><option value="forbid">禁止匹配（出现即报错）</option><option value="require">必须匹配（缺失即报错）</option></select>
            <select id="sk-rule-sev" style="background:#1c2128;color:#d8dee9;border:1px solid #3b4252;border-radius:6px;padding:4px;"><option value="error">error</option><option value="warning">warning</option></select>
          </div>
          <input id="sk-rule-pat" placeholder="正则，例如：^fix\\s+\\S+\\s+all\\s+nvt   (检测把 nvt 挂到 all)" style="width:100%;box-sizing:border-box;background:#1c2128;color:#d8dee9;border:1px solid #3b4252;border-radius:6px;padding:4px;margin-bottom:4px;font-family:monospace;">
          <input id="sk-rule-fix" placeholder="修复建议（可选）" style="width:100%;box-sizing:border-box;background:#1c2128;color:#d8dee9;border:1px solid #3b4252;border-radius:6px;padding:4px;margin-bottom:4px;">
          <div style="display:flex;gap:6px;"><button id="sk-rule-ok" style="padding:4px 10px;border-radius:6px;border:1px solid #4c6e4c;background:#3b5e3b;color:#d8ffd8;cursor:pointer;">确认升级</button><button id="sk-rule-cancel" style="padding:4px 10px;border-radius:6px;border:1px solid #3b4252;background:#2e3440;color:#d8dee9;cursor:pointer;">取消</button></div>
        </div>`;
      // 触发词：提到这些关键词时，新对话会提示“是否启用本领域经验”
      html += `<div style="margin:10px 0 4px;border-top:1px solid #3b4252;padding-top:8px;"><b>🔔 触发词（${(s.triggers || []).length}）</b> <span style="font-size:11px;opacity:.6;">提到这些词，对话里会提示启用本领域</span></div>`;
      html += `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:4px;">`;
      for (const tg of (s.triggers || [])) html += `<span style="background:#2b313a;border-radius:5px;padding:2px 8px;">${esc(tg)} <span class="sk-deltrig" data-name="${esc(tg)}" style="cursor:pointer;opacity:.5;">✕</span></span>`;
      if (!(s.triggers || []).length) html += `<span style="opacity:.5;font-size:12px;">暂无。加几个关键词，如 热解 / pyrolysis。</span>`;
      html += `</div>
        <div style="display:flex;gap:6px;margin-bottom:8px;">
          <input id="sk-trigname" placeholder="添加触发词，如 热解 / reaxff" style="flex:1;background:#1c2128;color:#d8dee9;border:1px solid #3b4252;border-radius:6px;padding:4px;">
          <button id="sk-trigbtn" style="padding:4px 8px;border-radius:6px;border:1px solid #3b4252;background:#2e3440;color:#d8dee9;cursor:pointer;">添加</button>
        </div>`;
      // 手动加经验
      html += `<div style="display:flex;gap:6px;margin-top:6px;">
        <input id="sk-addlesson" placeholder="手动加一条经验..." style="flex:1;background:#1c2128;color:#d8dee9;border:1px solid #3b4252;border-radius:6px;padding:4px;">
        <button id="sk-addbtn" style="padding:4px 8px;border-radius:6px;border:1px solid #3b4252;background:#2e3440;color:#d8dee9;cursor:pointer;">加入</button>
      </div>`;
    }
    panel.innerHTML = html;
    wire();
  }

  function sparkline(curve) {
    if (!curve.length) return '<div style="opacity:.5;font-size:11px;">（暂无适应度数据）</div>';
    const pts = curve.slice(-40);
    const w = 380, h = 40, n = pts.length;
    const x = i => n <= 1 ? 0 : (i / (n - 1)) * w;
    const y = v => h - v * h;
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');
    return `<svg width="${w}" height="${h}" style="margin-top:4px;"><polyline points="0,${h} ${w},${h}" stroke="#3b4252" fill="none"/><path d="${d}" stroke="#a3be8c" stroke-width="2" fill="none"/></svg>
      <div style="font-size:11px;opacity:.6;">适应度曲线（近 ${pts.length} 次，越高越好）</div>`;
  }

  function trainSparkline(curve) {
    if (!curve.length) return '';
    const pts = curve.slice(-40);
    const w = 380, h = 36, n = pts.length;
    const x = i => n <= 1 ? 0 : (i / (n - 1)) * w;
    const y = v => h - (v / 100) * h;
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.passRate).toFixed(1)}`).join(' ');
    const last = pts[pts.length - 1];
    return `<svg width="${w}" height="${h}" style="margin:2px 0;"><polyline points="0,${h} ${w},${h}" stroke="#3b4252" fill="none"/><path d="${d}" stroke="#88c0d0" stroke-width="2" fill="none"/></svg>
      <div style="font-size:11px;opacity:.6;">通过率曲线（近 ${pts.length} 轮，最新 ${last.passRate}% = ${last.passed}/${last.total}）</div>`;
  }

  function wire() {
    const close = panel.querySelector('#sk-close'); if (close) close.onclick = () => panel.style.display = 'none';
    const act = panel.querySelector('#sk-activate');
    const sel = panel.querySelector('#sk-select');
    if (act) act.onclick = () => {
      if (STATE.active) { send({ type: 'set_skill', enabled: false }); }
      else { const id = sel && sel.value; if (!id) { addSystem('先在下拉里选一个领域，或在下面新建。'); return; } const name = STATE.skills.find(k => k.id === id)?.name || id; send({ type: 'set_skill', id, name, enabled: true }); }
    };
    if (sel) sel.onchange = () => { const id = sel.value; if (id) send({ type: 'skill_status', id }); };
    const create = panel.querySelector('#sk-create');
    if (create) create.onclick = () => { const nm = (panel.querySelector('#sk-newname') || {}).value || ''; if (!nm.trim()) { addSystem('请输入新领域名。'); return; } send({ type: 'set_skill', id: nm.trim(), name: nm.trim(), enabled: true }); };
    panel.querySelectorAll('.sk-promote').forEach(b => b.onclick = () => send({ type: 'skill_promote', candidateId: b.dataset.id }));
    panel.querySelectorAll('.sk-dismiss').forEach(b => b.onclick = () => send({ type: 'skill_dismiss', candidateId: b.dataset.id }));
    panel.querySelectorAll('.sk-del').forEach(b => b.onclick = () => send({ type: 'skill_remove_lesson', lessonId: b.dataset.id }));
    const addbtn = panel.querySelector('#sk-addbtn');
    if (addbtn) addbtn.onclick = () => { const t = (panel.querySelector('#sk-addlesson') || {}).value || ''; if (t.trim()) send({ type: 'skill_add_lesson', text: t.trim() }); };
    // 硬规则 / 模板
    panel.querySelectorAll('.sk-delrule').forEach(b => b.onclick = () => send({ type: 'skill_remove_rule', ruleId: b.dataset.id }));
    panel.querySelectorAll('.sk-deltpl').forEach(b => b.onclick = () => send({ type: 'skill_remove_template', name: b.dataset.name }));
    const tplbtn = panel.querySelector('#sk-tplbtn');
    if (tplbtn) tplbtn.onclick = () => { const n = (panel.querySelector('#sk-tplname') || {}).value || ''; if (n.trim()) send({ type: 'skill_add_template', name: n.trim() }); };
    // 升级为硬规则表单
    const form = panel.querySelector('#sk-rule-form');
    let upLessonId = '';
    panel.querySelectorAll('.sk-up').forEach(b => b.onclick = () => {
      upLessonId = b.dataset.id;
      if (!form) return;
      form.style.display = 'block';
      const fr = panel.querySelector('#sk-rule-from'); if (fr) fr.textContent = b.dataset.text || '';
      form.scrollIntoView({ block: 'nearest' });
    });
    const rcancel = panel.querySelector('#sk-rule-cancel'); if (rcancel) rcancel.onclick = () => { if (form) form.style.display = 'none'; };
    const rok = panel.querySelector('#sk-rule-ok');
    if (rok) rok.onclick = () => {
      const pat = (panel.querySelector('#sk-rule-pat') || {}).value || '';
      if (!pat.trim()) { addSystem('请填正则 pattern。'); return; }
      send({ type: 'skill_promote_rule', lessonId: upLessonId,
        kind: (panel.querySelector('#sk-rule-kind') || {}).value || 'forbid',
        severity: (panel.querySelector('#sk-rule-sev') || {}).value || 'error',
        pattern: pat.trim(), fix: (panel.querySelector('#sk-rule-fix') || {}).value || '' });
      if (form) form.style.display = 'none';
    };
    // 触发词增删（按当前选中/激活的领域）
    const _trigSkillId = () => (STATE.status && STATE.status.id) || STATE.active || '';
    panel.querySelectorAll('.sk-deltrig').forEach(b => b.onclick = () => {
      const id = _trigSkillId(); if (!id) return;
      const cur = (STATE.status && STATE.status.triggers) || [];
      send({ type: 'skill_set_triggers', id, triggers: cur.filter(t => t !== b.dataset.name) });
    });
    const trigBtn = panel.querySelector('#sk-trigbtn');
    if (trigBtn) trigBtn.onclick = () => {
      const id = _trigSkillId(); if (!id) { addSystem('先选择/启用一个领域，再加触发词。'); return; }
      const v = ((panel.querySelector('#sk-trigname') || {}).value || '').trim();
      if (!v) return;
      const cur = (STATE.status && STATE.status.triggers) || [];
      send({ type: 'skill_set_triggers', id, triggers: [...cur, v] });
    };
  }

  window.Skill = {
    onList(m) { STATE.skills = m.skills || []; STATE.active = m.active || ''; STATE.activeName = m.activeName || ''; refreshBtn(); if (panel.style.display !== 'none') render(); },
    onState(m) { STATE.active = m.active || ''; STATE.activeName = m.activeName || ''; refreshBtn(); render(); },
    onStatus(st) { STATE.status = st; if (panel.style.display !== 'none') render(); },
    onLearned(m) {
      if (m.auto && m.auto.length) addSystem(`🧠 自动沉淀客观经验：${m.auto.join('；')}`);
      if (STATE.active) send({ type: 'skill_status' });
    },
    // 触发词命中 → 对话里提示“是否启用本领域”（用户点了才注入）
    onSuggest(m) {
      const sugg = (m && m.suggestions) || [];
      if (!sugg.length) return;
      const div = document.createElement('div'); div.className = 'msg system';
      const items = sugg.map(s => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:4px;">
        <span>🔔 检测到可用技能 <b>${esc(s.name)}</b> <span style="opacity:.6;font-size:11px;">（命中：${esc((s.matched || []).join('、'))}）</span></span>
        <button class="sk-sug-on" data-id="${esc(s.id)}" data-name="${esc(s.name)}" style="padding:3px 10px;border-radius:6px;border:1px solid #4c6e4c;background:#3b5e3b;color:#d8ffd8;cursor:pointer;white-space:nowrap;">启用</button>
      </div>`).join('');
      div.innerHTML = `<div class="bubble" style="border-left:3px solid #88c0d0;">
        <div style="font-size:12px;opacity:.85;">提到了相关关键词，是否启用领域经验？</div>${items}
        <div style="margin-top:6px;"><button class="sk-sug-no" style="padding:3px 10px;border-radius:6px;border:1px solid #3b4252;background:#2e3440;color:#d8dee9;cursor:pointer;">忽略</button></div>
      </div>`;
      div.querySelectorAll('.sk-sug-on').forEach(b => b.onclick = () => { send({ type: 'set_skill', id: b.dataset.id, name: b.dataset.name, enabled: true }); div.remove(); });
      const no = div.querySelector('.sk-sug-no'); if (no) no.onclick = () => div.remove();
      $('chat').appendChild(div); scrollChat();
    },
    // 任务跑出成果 → 对话里出“要不要把本轮经验存进技能库”卡（可编辑、选目标/新建、填触发词）
    onDistill(m) {
      const skills = (m && m.skills) || [];
      const opts = skills.map(k => `<option value="${esc(k.id)}" ${k.id === m.activeSkill ? 'selected' : ''}>${esc(k.name)}</option>`).join('');
      const div = document.createElement('div'); div.className = 'msg system';
      div.innerHTML = `<div class="bubble" style="border-left:3px solid #a3be8c;">
        <div style="font-weight:600;margin-bottom:4px;">💡 本轮跑出成果，要把经验存进技能库吗？</div>
        <textarea class="sk-ds-text" style="width:100%;box-sizing:border-box;height:48px;background:#1c2128;color:#d8dee9;border:1px solid #3b4252;border-radius:6px;padding:5px;">${esc(m.text || '')}</textarea>
        <div style="display:flex;gap:6px;align-items:center;margin-top:5px;">
          <span style="font-size:12px;opacity:.7;">存到</span>
          <select class="sk-ds-skill" style="flex:1;background:#1c2128;color:#d8dee9;border:1px solid #3b4252;border-radius:6px;padding:4px;">${opts}<option value="__new__">＋ 新建领域…</option></select>
        </div>
        <input class="sk-ds-newname" placeholder="新领域名，如：热解反应" style="display:none;width:100%;box-sizing:border-box;margin-top:5px;background:#1c2128;color:#d8dee9;border:1px solid #3b4252;border-radius:6px;padding:4px;">
        <div style="display:flex;gap:6px;align-items:center;margin-top:5px;">
          <span style="font-size:12px;opacity:.7;">触发词</span>
          <input class="sk-ds-trig" value="${esc((m.triggers || []).join(' '))}" placeholder="空格分隔，如 热解 reaxff" style="flex:1;background:#1c2128;color:#d8dee9;border:1px solid #3b4252;border-radius:6px;padding:4px;">
        </div>
        <div style="display:flex;gap:6px;margin-top:7px;">
          <button class="sk-ds-save" style="padding:4px 12px;border-radius:6px;border:1px solid #4c6e4c;background:#3b5e3b;color:#d8ffd8;cursor:pointer;">存入技能库</button>
          <button class="sk-ds-no" style="padding:4px 12px;border-radius:6px;border:1px solid #3b4252;background:#2e3440;color:#d8dee9;cursor:pointer;">忽略</button>
        </div>
        <div style="font-size:11px;opacity:.55;margin-top:4px;">下次提到触发词时，会提示启用这个领域的经验。</div>
      </div>`;
      const selEl = div.querySelector('.sk-ds-skill');
      const newEl = div.querySelector('.sk-ds-newname');
      if (selEl) selEl.onchange = () => { newEl.style.display = selEl.value === '__new__' ? 'block' : 'none'; };
      if (!skills.length && selEl) { selEl.value = '__new__'; newEl.style.display = 'block'; }
      const save = div.querySelector('.sk-ds-save');
      if (save) save.onclick = () => {
        const text = (div.querySelector('.sk-ds-text') || {}).value || '';
        const trig = ((div.querySelector('.sk-ds-trig') || {}).value || '').split(/[\s,，、]+/).map(x => x.trim()).filter(Boolean);
        const pick = selEl ? selEl.value : '';
        const payload = { type: 'skill_distill_save', text, triggers: trig };
        if (pick === '__new__') { const nm = (newEl.value || '').trim(); if (!nm) { addSystem('请填写新领域名。'); return; } payload.newName = nm; }
        else if (pick) payload.skillId = pick;
        else { addSystem('请选择目标领域。'); return; }
        send(payload); div.remove();
      };
      const no = div.querySelector('.sk-ds-no'); if (no) no.onclick = () => div.remove();
      $('chat').appendChild(div); scrollChat();
    },
    onTrainProgress(m) {
      STATE.training = true;
      if (m.phase === 'running') STATE.trainMsg = `${m.label || ('第' + m.iter + '轮')} · 跑基准 ${m.benchIndex}/${m.benchTotal}：${m.benchName}`;
      else if (m.phase === 'bench_done') STATE.trainMsg = `${m.benchName}：${m.pass ? '✓ 通过' : '✗ 未过'}`;
      else if (m.phase === 'iter_done') {
        if (m.iter === 0) STATE.trainMsg = `基线通过率 ${m.passRate}%（${m.passed}/${m.total}）`;
        else STATE.trainMsg = `第${m.iter}轮：${m.kept ? '✓保留' : '✗回滚'}${m.attemptRate != null ? ' 试跑' + m.attemptRate + '%' : ''} · 当前保留 ${m.passRate}%`;
      }
      if (panel.style.display !== 'none') render();
    },
    onTrainDone(m) {
      STATE.training = false;
      STATE.trainMsg = m.empty ? '没有基准任务' : (m.aborted ? `⏸ 已中止（进度已存：累计${m.cumulativeIter || 0}轮·最优${m.bestPassed ?? '-'}/${m.total || '?'}，可续训）` : `✅ 完成（累计${m.cumulativeIter || 0}轮·最优${m.bestPassed ?? '-'}/${m.total || '?'}）`);
      if (STATE.active) send({ type: 'skill_status' });
      if (panel.style.display !== 'none') render();
    },
  };
  refreshBtn();
})();


