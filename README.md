# MDriver

> 自动化分子动力学智能体 · AI for LAMMPS / ReaxFF
> 任意大模型可接入 · 国产模型性价比之选 · 数据不出本机 · by LZF · 封装发行版 · Windows x64 + Linux x64

![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows%20x64%20%7C%20Linux%20x64-blue)
![Status](https://img.shields.io/badge/Status-Sealed%20Release-success)
![License](https://img.shields.io/badge/License-Evaluation%20Only-lightgrey)

---

## 这是什么

**MDriver** 是一个本地部署、原生中文的 AI Agent，专为 **分子动力学（MD）/ LAMMPS / 计算材料与化学** 场景设计。
它把一台工作站变成一个会"自己动手"的助手：读论文、查 LAMMPS 安装包、复用 `examples/` 算例、写输入脚本、跑仿真、做后处理、画 thermo 曲线、渲染轨迹、诊断报错——全程对话驱动。

> 一句话：ChatGPT 的多轮对话 × Cursor 的工具调用 × MD 工程师的工作流，全部跑在你自己的机器上。

MDriver 与 [CFDriver / NullFlux](https://github.com/LZF1111/nullflux) 同源——沿用同一套 LLM × 工具调用框架，把 OpenFOAM 工具栈替换为 **LAMMPS 工具栈**。

---

## 为什么选 MDriver

### 一、国产模型即可打穿通用 Coding Agent 在 MD 场景的天花板

通用 Coding Agent（Claude Code / Cursor / Cline）面对 LAMMPS 输入脚本、`pair_style`、`fix`、ReaxFF 力场、`log.lammps` 这类强领域知识时，会反复试错、瞎改参数、误判力场。MDriver 把 **MD 工程师的工作流直接编码进 System Prompt 与工具语义**：

- DeepSeek-V3 / Qwen3 / GLM-4.6 / Kimi-K2 等国产模型，在 MD 任务上的成功率显著高于通用模型裸调
- 无需 $20/月订阅、无需翻墙、无需把你的算例上传到境外服务器
- API Key 直接对接 DeepSeek 官方 / 硅基流动 / 火山方舟 / 阿里百炼，也能接局域网 vLLM / Ollama

### 二、为 LAMMPS 深度优化

不是"能调 shell 就算支持 LAMMPS"。MDriver 内置一整套 LAMMPS 专用工具：

- **看安装包**：`lmp_env_info` 查版本+包 · `lmp_find_example` 全包搜算例 · `lmp_find_source` 找 fix/pair/compute · `lmp_find_potential` 列势函数 · `lmp_doc_lookup` 查官方 rst 文档
- **复用算例**：`lmp_clone_example` 拉到工作区 → `lmp_inspect_case` 自动解析 units/atom_style/pair_style/fix/compute/dump/run 及依赖
- **改 + 静态检查**：`lmp_lint` 毫秒级查 12 类常见翻车（units / atom_style / 力场 / qeq …）· `lmp_validate_input` 跑 `run 0` 语法预检
- **跑仿真**：`lmp_run_probe` 小步探针 → `lmp_run_async` 后台启动 → `lmp_run_status` 看实时 thermo → `lmp_run_stop` 中止
- **后处理**：`lmp_parse_log` 结构化 log → `lmp_plot_thermo` 出图 · `lmp_post_msd` / `lmp_post_rdf` · `lmp_render_traj` 用 OVITO 渲染轨迹
- **建数据 / 排错**：`lmp_build_data_file` 按 lattice 生成 data · `lmp_diagnose_error` 内置错误模式库快速定位

### 三、ReaxFF 反应力场专用工具链

热解 / 燃烧 / 成键断键类反应 MD 普通力场（LJ/EAM/Tersoff）算不出，MDriver 内置 ReaxFF 一条龙：

- `lmp_ff_select_reaxff` 按元素从力场库挑真实 ReaxFF 势 · `lmp_packmol_build` 用 Packmol 装盒生成 data · `lmp_render_in_template` 用内置 ReaxFF 模板渲染 in.* · `lmp_reaxff_pipeline` 一把梭（装盒→选力场→渲染→探针）

### 四、越用越聪明 —— 领域技能包 / 自训练

- **被动学习**：跑真实任务时自动沉淀"踩坑→修法"经验，强信号自动固化、弱信号产候选待确认
- **主动自训练**：对你预设的基准集反复刷通过率，失败自动提炼具体经验，并用 **keep-or-revert（留存检验）** 只保留能提升通过率的经验
- 经验、硬规则、参数偏好全部存本地、纯私有资产

### 五、真·本地化、真·可控

| | MDriver | 云端通用 Agent |
|---|---|---|
| 算例数据出境 | 不出本机 | 上传到境外服务器 |
| 离线运行 | 配本地 LLM 即可 | 必须连官网 |
| 工具调用审批 | 每步可视化授权 | 局部支持 |
| 工作目录沙箱 | 越界即拦截 | 全盘可写 |
| 成本 | 仅 LLM token 费用 | $20/月起 + token |

### 六、一个 bundle，零依赖部署

- 不需要 `npm install`——所有第三方库已 bundle 进 `server.bundle.mjs`
- 一条命令起飞：Windows `start.bat` / Linux `./start.sh --port 5180`
- Agent 本体纯 CPU，GPU 留给你的 LLM 推理

---

## 系统要求

| | 最低 | 推荐 |
|---|---|---|
| OS | Windows x64 / Linux x64 (glibc ≥ 2.28) | Win 10/11 · Ubuntu 22.04 |
| Node.js | 18.x | 20.x LTS |
| 内存 | 2 GB | 8 GB+ |
| 磁盘 | 500 MB | + 工作目录所需 |
| 可选 | LAMMPS · Python 3.9+ · OVITO · Packmol / OpenBabel | 都装上体验最佳 |

> ⚠️ Node 版本必须 ≥ 18（用到 `fetch`、ESM、`AbortSignal.timeout` 等特性，Node 16 会启动失败）。

---

## 快速开始

### Windows x64

```powershell
# 1. 下载并解压 mdriver-win-x64-sealed.zip
# 2. 进入解压目录，双击 start.bat（或在 PowerShell 里）
.\start.bat
# 默认监听 http://127.0.0.1:5174
```

### Linux x64

```bash
# 1. 下载并解压
wget https://github.com/LZF1111/mdriver/releases/latest/download/mdriver-linux-sealed.tar.gz
tar xzf mdriver-linux-sealed.tar.gz
cd mdriver-linux-sealed

# 2. 启动（默认 0.0.0.0:5174）
./start.sh
./start.sh --port 5180            # 自定义端口
./start.sh --port 5180 --host 127.0.0.1
```

启动后浏览器打开 `http://<IP>:<端口>`，点右上角 ⚙ 设置：

1. 填 LLM Provider + API Key（或自定义 BaseURL）
2. 可选：填 LAMMPS 可执行文件 / Python / Packmol 路径
3. 选择**工作目录**（Agent 的所有文件操作都在这里）

完事，开聊。

---

## 目录结构（封装版）

```
mdriver-(win-x64|linux)-sealed/
├── server.bundle.mjs   ← 主程序（封装混淆，所有 npm 依赖已内联）
├── public/             ← 前端静态资源（编辑器 + 聊天 UI + 文件查看器）
├── cases/              ← 本地案例库（智能体的领域知识）
├── helpers/            ← LAMMPS 后处理 Python：log 解析 / 轨迹渲染 / dump→xyz
├── doc_reader.py       ← 文档解析辅助
├── nb_kernel_host.py   ← Notebook 内核辅助
├── .env.example        ← 配置模板（也可在 UI ⚙ 面板里改）
├── start.bat / start.sh ← 启动脚本（支持端口参数）
└── README.md
```

封装版不需要 `npm install`，所有第三方依赖已 bundle 进 `server.bundle.mjs`。

---

## 安全与可控

- 工具调用前前端弹审批，可勾选"本会话内自动批准"
- 工作目录隔离，命令默认禁止越出
- 全程本地运行，对话不上云（除调用 LLM 本身的 API）
- 源码已经过 RC4 字符串加密 + 控制流扁平化 + Self-Defending 多重封装

---

## 联系作者

- 作者：LZF
- 邮箱：[lizifeng@ipe.ac.cn](mailto:lizifeng@ipe.ac.cn)
- 机构：中国科学院过程工程研究所 (IPE, CAS)

欢迎商业合作与科研合作来信：商业部署 / 授权、科研合作（MD 课题联合攻关、论文复现、AI4Science）、新力场 / 新工具链定制、团队培训与演示。

---

## 许可

封装发行版仅供评估、个人学习、内部部署使用，**禁止反混淆、二次分发、商用转售**。
商业授权 / 技术合作请联系作者：[lizifeng@ipe.ac.cn](mailto:lizifeng@ipe.ac.cn)

MDriver · Drive the dynamics, automate the rest. © 2026 LZF — All rights reserved.
