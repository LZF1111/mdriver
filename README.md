# MDriver

> **MDriver** — 自动化 LAMMPS 分子动力学智能体。
> 沿用 [CFDriver / nullflux](https://github.com/LZF1111/nullflux) 的 LLM × 工具调用框架，
> 把 OpenFOAM 工具栈替换为 LAMMPS 工具栈：让大语言模型能"看懂"你本地的 LAMMPS 安装包、
> 复用 `examples/` 算例、阅读 `src/` 源码与 `doc/` 文档、生成新算例、跑仿真、做后处理。

## 一、核心理念

LLM 单独读源码/查文档/写脚本都很慢；MDriver 的做法是把"分子动力学常见动作"封装成 16 个**LAMMPS 专用工具**，让 LLM 用很少的步数就能：

1. **看安装包**：`lmp_env_info` 查版本 + 包；`lmp_find_example` 在 `examples/` 全包搜算例；`lmp_find_source` 在 `src/` 找 fix/pair/compute 风格；`lmp_find_potential` 列势函数；`lmp_doc_lookup` 查 rst 官方文档。
2. **复用算例**：`lmp_clone_example` 拉到工作区 → `lmp_inspect_case` 自动解析 in.* 的 units/atom_style/pair_style/fix/compute/dump/run，识别 data 与势函数依赖。
3. **改 + 验证**：用通用 `edit_file` 改输入脚本，`lmp_validate_input` 跑 `run 0` 做语法预检。
4. **跑仿真**：`lmp_run_async` 后台启动 → `lmp_run_status` 看 thermo → `lmp_run_stop` 中止。
5. **后处理**：`lmp_parse_log` 把 log.lammps 结构化成 JSON；`lmp_plot_thermo` 出 PNG；`lmp_dump_summary` 扫 dump；`lmp_render_traj` 用 OVITO（或 matplotlib 回退）渲染一帧。
6. **建数据/排错**：`lmp_build_data_file` 按 lattice 生成 data；`lmp_diagnose_error` 内置 17 条 LAMMPS 错误模式快速定位原因+下一步。

## 二、目录结构

```
MDriver-v1/
├── server.js               # 主服务（Express + WebSocket + LLM 路由 + 工具分发）
├── lammps.js               # LAMMPS 工具模块（16 个 lmp_* 工具实现）
├── helpers/
│   ├── lmp_log_parse.py    # 解析/绘图 thermo
│   ├── lmp_render_ovito.py # OVITO/matplotlib 渲染 dump
│   └── lmp_dump_xyz.py     # dump → XYZ 转换
├── public/                 # 前端（Monaco 编辑器 + 聊天 UI + 文件查看器）
├── .env.example            # 配置模板
├── build-sealed.mjs        # 打包 + 混淆
└── build-linux-dist.mjs    # Linux 发行版打包
```

## 三、安装与启动

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env：必填 LAMMPS_ROOT + 至少一个 LLM key

# 3. 启动
npm start
# 浏览器打开 http://localhost:3000
```

> Python 端建议环境：`pip install matplotlib`；如要更高质量渲染：`pip install ovito`。

## 四、LAMMPS 工具一览（16 个）

| 工具 | 用途 | 审批 |
|---|---|---|
| `lmp_env_info` | 检测安装包/版本/包/示例数量 | ✗ |
| `lmp_find_example` | 在 examples/ 搜算例（按 keyword） | ✗ |
| `lmp_find_source` | 在 src/ 搜源码（pair/bond/fix/compute/dump） | ✗ |
| `lmp_find_potential` | 列 potentials/ 势函数 | ✗ |
| `lmp_doc_lookup` | 搜 doc/src/*.rst 官方文档 | ✗ |
| `lmp_clone_example` | 复制 example 到工作区 | ✓ |
| `lmp_inspect_case` | 体检算例（in.*/data/dump/log 清单+解析） | ✗ |
| `lmp_validate_input` | 把 run N 改 run 0 做语法预检 | ✗ |
| `lmp_run_async` | 后台启动求解器 | ✓ |
| `lmp_run_status` | 查后台作业状态 + thermo tail | ✗ |
| `lmp_run_stop` | 中止后台作业 | ✗ |
| `lmp_parse_log` | log.lammps → JSON（thermo/wall/perf/errors） | ✗ |
| `lmp_dump_summary` | 扫 dump（N/帧数/box/字段列） | ✗ |
| `lmp_plot_thermo` | 用 matplotlib 画 thermo 时序 PNG | ✗ |
| `lmp_render_traj` | OVITO/matplotlib 渲染轨迹帧 | ✗ |
| `lmp_build_data_file` | 按 fcc/bcc/sc/diamond + a + nxnynz 生成 data | ✓ |
| `lmp_diagnose_error` | 17 条内置 LAMMPS 错误模式匹配 | ✗ |

## 五、典型工作流（让 LLM 自动跑）

> 用户提示：「用 LAMMPS 在金属 Cu 上做一个 NVT 升温例子，从 300K 升到 800K，跑 50ps，画温度-时间和势能曲线。」

LLM 调用链（约 8-10 步）：

1. `lmp_env_info` → 拿到 LAMMPS_ROOT 与版本
2. `lmp_find_example query="melt"` → 找到 `examples/melt/in.melt`
3. `lmp_clone_example tutorial_path="melt" dest="cu_heat"` → 复制
4. `lmp_inspect_case case_path="cu_heat"` → 看到 units=lj
5. `lmp_find_potential pattern="Cu"` → 找到 `Cu_u3.eam`
6. `edit_file` 改 in.melt：换 units real / atom_style atomic / pair_style eam / fix nvt 300→800
7. `lmp_validate_input` → 语法过
8. `lmp_run_async` → runId
9. 几分钟后 `lmp_run_status` → 完成
10. `lmp_plot_thermo y=["Temp","PotEng"]` → PNG 推送到聊天

如果某步出错 → 自动 `lmp_diagnose_error(log_tail)` → 拿到 category + next_steps → 修 → 重试。

## 六、与 CFDriver 的关系

MDriver 直接复用 nullflux/CFDriver 的所有通用能力：
聊天 UI、Monaco 多文件编辑器、WebSocket 流式输出、Markdown 渲染、KaTeX 公式、Mermaid 图、
图片库、PDF/DOCX 阅读、网页抓取、学术检索、手动数据标注（Digitizer）、
GitHub Copilot/OpenAI/Claude/Gemini 多 Provider 路由、Git 自动版本回滚、通用错误诊断。

唯一不同：把"OpenFOAM/MFIX/LBM/Opt"那一整组仿真工具替换为"LAMMPS"工具集（见 `lammps.js`）。

## 七、TODO（未来增强）

- [ ] 集成 `lmp_msd` / `lmp_rdf` / `lmp_diffusion` 等专用后处理（基于 OVITO Python API）
- [ ] `lmp_build_polymer` 高分子拓扑生成器（bond/angle/dihedral）
- [ ] `lmp_build_water` SPC/E、TIP4P 等常用水盒子
- [ ] 自动 NPT 平衡 + NVT 生产链
- [ ] 体系尺寸/timestep/cutoff 自动诊断与建议
- [ ] OVITO 渲染调色板预设（type / coordination / displacement）

## License

参考 nullflux 项目（不公开源码，仅可执行发行版授权使用）。
