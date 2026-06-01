<div align="center">

# MDriver

**自动化分子动力学仿真智能体 · AI for LAMMPS / ReaxFF**
**任意大模型可接入 · 国产模型性价比之选 · 数据不出本机**
<sub>by **LZF** · 封装发行版 · Windows x64 / Linux x64</sub>

[![Node](https://img.shields.io/badge/node-%3E%3D18-43853d)]()
[![Platform](https://img.shields.io/badge/platform-win--x64%20%7C%20linux--x64-blue)]()
[![Status](https://img.shields.io/badge/build-sealed-purple)]()
[![License](https://img.shields.io/badge/license-Proprietary-lightgrey)]()

**[🌐 在线演示（含实时轨迹查看器）](https://lzf1111.github.io/mdriver/)** · **[⬇ 下载发行版](https://github.com/LZF1111/mdriver/releases/latest)**

</div>

---

## 这是什么

**MDriver** 是一个**本地部署、原生中文**的 AI Agent，专为 **分子动力学（MD）/ LAMMPS / ReaxFF** 场景设计。
它把你的工作站变成一个会"自己动手"的仿真工程师：读论文、建模、写 `in.*` 输入脚本、跑 LAMMPS、解析 `log`、画 thermo 曲线、在浏览器里旋转轨迹、解释结果——全程对话驱动。

> 一句话：**ChatGPT 的多轮对话 × Cursor 的工具调用 × MD 工程师的工作流**，全部跑在你自己的机器上。

通用 Coding Agent 会写 Python，却**不懂仿真**；手工跑 LAMMPS 准，但**慢且易错**。MDriver 两者兼得。

---

## 为什么选 MDriver —— 六大不可替代优势

### 一、国产模型即可打穿 Claude Code 在 MD 场景的天花板

通用 Coding Agent（Claude Code / Cursor / Cline）面对 LAMMPS 的 `units`、`atom_style`、`pair_style`、`fix`、势函数依赖、`ERROR:` 日志这类**强领域知识**时，会反复试错、瞎改脚本、误读报错。
MDriver 把 **MD 工程师的工作流**直接编码进 System Prompt 与工具语义，于是：

- **DeepSeek-V3 / Qwen3 / GLM-4.6 / Kimi-K2 等国产模型，在 LAMMPS 任务上的成功率显著高于通用模型调 Claude Code**
- 无需 $20/月订阅、无需翻墙、无需把你的算例上传到境外服务器，**几毛钱就能跑完别家几块钱的算例调试**
- API Key 直接对接 DeepSeek 官方 / 硅基流动 / 火山方舟 / 阿里百炼——开机就用，**断网也能接局域网 vLLM / Ollama**

### 二、为 LAMMPS 深度优化 —— 16 个专用工具

不是"能调 shell 就算支持 LAMMPS"。MDriver 把"分子动力学常见动作"封装成 **16 个 `lmp_*` 专用工具**，让 LLM 用很少的步数完成全链路：

- **看懂你的安装包**：自动检测 LAMMPS 版本与已编译的 package，在 `examples/` 全包搜算例、在 `src/` 找 fix/pair/compute、列 `potentials/` 势函数、查 `doc/` 官方 rst 文档
- **复用并体检算例**：一键克隆 example → 自动解析 `in.*` 的 units / atom_style / pair_style / fix / compute / dump / run，识别 data 与势函数依赖
- **改 + 预检**：按行号 / diff 改输入脚本，`run 0` 语法预检，跑之前先把低级错误挡住
- **异步跑算**：后台启动求解器 → 实时回传 thermo → 随时中止
- **错误图谱**：内置 **17 条 LAMMPS 错误模式**，读 log 尾巴 → 定位原因 + 给出下一步

### 三、浏览器内实时轨迹后处理 —— 告别 VMD/OVITO 切来切去

LAMMPS `dump` 轨迹**直接在浏览器里 WebGL（NGL）渲染**：

- 填充球 / 球棍 / 线条 / 表面，可**旋转、缩放、逐帧播放、自动旋转、截图**
- 多帧轨迹按真实坐标演化，扩散 / 反应体系一目了然
- `log.lammps` 一键结构化成 JSON，thermo 时序曲线（温度 / 势能 / 压力…）直接出 PNG 贴回对话
- 👉 **[点这里看在线实时查看器](https://lzf1111.github.io/mdriver/)**（拖动旋转 · 滚轮缩放 · 右键平移）

### 四、ReaxFF 反应力场，从建模到产物统计

- 一键搭建**热解 / 燃烧 / 氧化**体系，配置 `qeq` 电荷平衡、升温退火方案
- `species` 反应产物统计，把"哪些键断了、生成了什么"讲清楚
- 经典势（EAM / Tersoff / AIREBO / LJ …）与反应力场都在求解器图谱里，选错会被立刻指出

### 五、真·本地化、真·可控

| 维度 | MDriver | Claude Code / Cursor |
|---|---|---|
| 算例数据出境 | 不出本机 | 上传到境外服务器 |
| 离线运行 | 配本地 LLM 即可 | 必须连官网 |
| 工具调用审批 | 每步可视化授权 | 局部支持 |
| 工作目录沙箱 | 越界即拦截 | 全盘可写 |
| 商用合规 | 数据本地、源码封装 | 受出口管制 / 条款约束 |
| 成本 | 仅 LLM token 费用 | $20/月起 + token |

### 六、一个封装包，零依赖部署

- **不需要 `npm install`**——所有第三方库已 bundle 进单文件 `server.bundle.mjs`（RC4 加密 + 控制流扁平化封装，源码不可读）
- **不需要 Docker / GPU**——Windows 双击 `start.bat`，Linux 一条 `./start.sh` 起飞
- 装个 **Node.js 18+** 就能跑；内网工作站 / HPC 登录节点 / 老服务器皆可

> 一句话：**MDriver 把"读论文 → 建模 → 写脚本 → 跑算 → 后处理 → 出图"六步压缩成一段对话。**
> 这是科研型 MD 工作者真正需要的生产力，而不是又一个会写 Python 脚本的玩具。

---

## 它能做什么

### 智能体核心
- **OpenAI Function-Calling 风格**的工具循环：模型自主拆解任务、调用工具、读结果、修正、再调用，直到达成目标
- **多轮上下文自动压缩**（Auto-Compact）：长会话不爆 token，关键工具调用-响应配对绝不被切断
- **流式输出 + 中途打断**：随时按停，正在运行的进程会被干净地终止
- **多模型支持**：DeepSeek / 智谱 GLM / 硅基流动 / GitHub Copilot / OpenAI 兼容端点，UI 一键切换；Auto 模式自动选工具链

### LAMMPS 工具集（可视化授权 / 一键批准）

| 类别 | 代表工具 | 用途 |
|---|---|---|
| 看安装包 | `lmp_env_info` / `lmp_find_example` / `lmp_find_source` / `lmp_find_potential` / `lmp_doc_lookup` | 查版本+包、搜 examples / src / potentials / 官方 rst 文档 |
| 复用算例 | `lmp_clone_example` / `lmp_inspect_case` | 克隆算例、自动解析 in.* 与依赖 |
| 改 + 预检 | `edit_file` / `lmp_validate_input` | 按行/diff 改脚本、`run 0` 语法预检 |
| 跑算 | `lmp_run_async` / `lmp_run_status` / `lmp_run_stop` | 后台启动、看 thermo、中止 |
| 后处理 | `lmp_parse_log` / `lmp_plot_thermo` / `lmp_dump_summary` / `lmp_render_traj` | log→JSON、thermo→PNG、扫 dump、渲染轨迹帧 |
| 建模 / 排错 | `lmp_build_data_file` / `lmp_diagnose_error` | 按晶格生成 data、17 条错误模式诊断 |

### 安全与可控
- 工具调用前**前端弹审批**，可勾选"本会话内自动批准"
- 工作目录隔离，命令默认禁止越出
- 全程本地运行，**对话不上云**（除调用 LLM 本身的 API）
- 发行版经 RC4 字符串加密 + 控制流扁平化多重封装

### 前端
- 暗色玻璃拟态界面，**Markdown + KaTeX + Mermaid + 代码高亮**
- 工具调用以可折叠卡片展示，输入/输出一目了然
- 内置 **Monaco 多文件编辑器** + **Jupyter Notebook** 内核
- **NGL 轨迹查看器**、内嵌图片预览、PDF/DOCX 阅读、手动数据标注（Digitizer）
- WebSocket 双向同步，多标签页共享会话状态

---

## 系统要求

| 项 | 最低 | 推荐 |
|---|---|---|
| OS | Windows x64 / Linux x64 | Win 10+ · Ubuntu 22.04 |
| Node.js | 18.x | 20.x LTS |
| 内存 | 2 GB | 8 GB+ |
| 磁盘 | 300 MB | + 工作目录所需 |
| 可选 | LAMMPS（含 ReaxFF）· Python 3.9+ · OVITO | 都装上体验最佳 |

> LAMMPS 未安装也能用：欢迎页点"一键部署 LAMMPS"从 GitHub 下载安装。

---

## 快速开始

先确保 `node -v` 输出 ≥ `v18.0.0`（[官网下载](https://nodejs.org/)）。

### Windows x64

```text
1. 到 Releases 下载 mdriver-win-x64-sealed.zip 并解压
2. 双击 start.bat            （默认端口 3777，浏览器自动打开）
   自定义端口： start.bat --port 5180
   停止服务：   双击 stop.bat
3. 浏览器打开 http://127.0.0.1:3777
```

### Linux x64

```bash
# 到 Releases 下载并解压
wget https://github.com/LZF1111/mdriver/releases/latest/download/mdriver-linux-sealed.tar.gz
tar xzf mdriver-linux-sealed.tar.gz
cd mdriver-linux-sealed

# 启动（默认端口 5174）
./start.sh
./start.sh --port 5180        # 或自定义端口
```

启动后在 `/app` 右上角 **⚙ 设置**：

1. 填 **LLM Provider + API Key**（或自定义 BaseURL）
2. 可选：指定 **LAMMPS 可执行路径 / Python 路径**
3. 选择 **工作目录**（Agent 的所有文件操作都在这里）

完事，开聊。

---

## 典型工作流（让 LLM 自动跑）

> 提示：「用 LAMMPS 在金属 Cu 上做一个 NVT 升温例子，从 300K 升到 800K，跑 50ps，画温度-时间和势能曲线。」

LLM 自动调用链（约 8–10 步）：

1. `lmp_env_info` → 拿到 LAMMPS 根目录与版本
2. `lmp_find_example query="melt"` → 找到 `examples/melt/in.melt`
3. `lmp_clone_example` → 复制到工作区
4. `lmp_inspect_case` → 解析 units / pair_style / fix
5. `lmp_find_potential pattern="Cu"` → 找到 `Cu_u3.eam`
6. `edit_file` → 改 units / atom_style / pair_style eam / fix nvt 300→800
7. `lmp_validate_input` → `run 0` 语法过
8. `lmp_run_async` → 后台开跑
9. `lmp_run_status` → 完成
10. `lmp_plot_thermo y=["Temp","PotEng"]` → PNG 推回对话

某步出错 → 自动 `lmp_diagnose_error(log_tail)` → 拿到原因 + 下一步 → 修 → 重试。

---

## 常见问题

<details>
<summary><b>没装 LAMMPS 也能用吗？</b></summary>

可以。MDriver 内置一键部署引导，能帮你检测环境并安装 / 编译 LAMMPS，也支持指向你已有的 `lmp` 可执行。
</details>

<details>
<summary><b>需要联网吗？数据安全吗？</b></summary>

除大语言模型推理需访问 API，其余建模、计算、文件读写、轨迹渲染全部在本地完成。算例数据、dump 轨迹、脚本都不离开本机。接局域网 vLLM / Ollama 可完全离线。
</details>

<details>
<summary><b>支持哪些模型？</b></summary>

DeepSeek、智谱 GLM、硅基流动、GitHub Copilot、OpenAI 兼容端点等，界面随时切换；Auto 模式自动选工具链。
</details>

<details>
<summary><b>轨迹可视化为什么默认用「填充球」？</b></summary>

NGL 只在第 0 帧计算一次成键拓扑，扩散 / 反应体系后续帧原子位移大，球棍的键会被拉成长线。多帧轨迹默认填充球更真实，需要看连键时手动切回球棍即可。
</details>

<details>
<summary><b>能做 ReaxFF 反应模拟吗？</b></summary>

能。可自动搭建热解 / 燃烧 / 氧化体系，配置 qeq 电荷平衡、升温方案与 species 产物统计，并把结果轨迹直接渲染出来。
</details>

---

## 联系作者

- **作者**：LZF
- **邮箱**：[lizifeng@ipe.ac.cn](mailto:lizifeng@ipe.ac.cn)
- **机构**：中国科学院过程工程研究所 (IPE, CAS)

**欢迎商业合作与科研合作来信**：

| 合作方向 | 说明 |
|---|---|
| 商业部署 / 授权 | 多节点 license、企业内私有模型对接、二次开发、定制功能 |
| 科研合作 | 高校 / 院所 MD 课题联合攻关、论文复现、AI4Science |
| 新工具 / 新体系定制 | 描述场景与需求，提供专属工具链封装 |
| 培训与演示 | 团队内训、MD + AI Agent 工作坊 |

一般 Bug 反馈与使用咨询亦可通过邮箱联系，请附启动日志、模型名称与复现步骤。

---

## 许可

封装发行版仅供**评估、个人学习、内部部署**使用，**禁止反混淆、二次分发、商用转售**。
商业授权 / 技术合作请联系作者：**lizifeng@ipe.ac.cn**

<div align="center">

**MDriver** · *Drive the dynamics, automate the rest.*
© 2026 **LZF** — All rights reserved.

</div>
