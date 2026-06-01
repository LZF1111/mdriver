# PE 热解 ReaxFF MD 测试案例 · 端到端

> 目标：用 ReaxFF 模拟废塑料 **聚乙烯 (PE)** 在 **300 K → 3000 K 线性升温**、**100 ps** 内的热解反应路径与产物分布。
> 这是 MDriver 的一个完整 5 步法回归测试，覆盖：**packmol 建盒 → 力场选择 → 模板渲染 → 异步运行 → 后处理 / NGL 可视化**。

---

## 物理设定

| 参数 | 值 | 说明 |
|---|---|---|
| 体系 | 纯 PE | 单体 -CH2-CH2-，每条链 PE10（20 C + 42 H） |
| 链数 | 20 | 模拟密度 ~0.9 g/cm³ |
| 盒子 | 40 × 40 × 40 Å | 周期边界，立方 |
| 力场 | ReaxFF CHO-2008 | C/H 烃类热解经典参数集 |
| 时间步 | 0.1 fs | ReaxFF 推荐 |
| 总时长 | 100 ps = 1,000,000 步 | 注意：若想压缩到 10 ps（10 万步）做冒烟测试，把下方 prompt 里的 `100 ps` 改成 `10 ps` |
| 系综 | NVT (Nose-Hoover) | T_damp = 10 fs |
| 升温 | 300 → 3000 K 线性 | fix nvt temp 300 3000 ${Tdamp} |
| thermo | 1000 步 | |
| dump | 1000 步，自定义 dump.atom | id type x y z q |
| species | 500 步，species.out | 用于产物谱分析 |

---

## 一步到位的 Prompt

打开 MDriver，新建对话，粘贴下面这段，回车即可：

```
请用 ReaxFF MD 完整做一个 PE（聚乙烯）热解算例，按你内置的 5 步法跑：

1. **建盒**：调 lmp_packmol_build，把 cases/PE_pyrolysis/monomer.pdb 在 40×40×40 Å 立方盒里
   填 20 个分子，输出 cases/PE_pyrolysis/system.pdb 和 data.lammps。
2. **选力场**：调 lmp_ff_select_reaxff，体系只含 C/H，请优先匹配 CHO-2008，
   把 ffield.reax 拷到 cases/PE_pyrolysis/。
3. **渲染输入**：调 lmp_render_in_template，模板用 reaxff 五段：init / read_data / reaxff /
   ensemble_nvt / output_reaxff / run。参数：
     - units real, atom_style charge, timestep 0.1
     - pair_style reax/c NULL, fix qeq/reax 1 1 0.0 10.0 1e-6 reax/c
     - fix nvt temp ramp 300 3000，Tdamp=10
     - thermo 1000, thermo_style custom step temp press pe ke etotal
     - dump dump.atom 1000，文件 dump.atom，列 id type x y z q
     - fix reaxc/species 500，文件 species.out
     - run 1000000  ←(100 ps)
   输出到 cases/PE_pyrolysis/in.lammps。
4. **运行**：调 lmp_run_async，工作目录 cases/PE_pyrolysis/，输入 in.lammps，
   每 5 秒推送 thermo 进度。
5. **后处理**：跑完后
     - 调 lmp_plot_thermo 画 temp / pe / etotal 三条曲线。
     - 调 lmp_reaxff_species_parse 解析 species.out，给出 t=0 / 50 ps / 100 ps 三个时刻
       的前 10 大物种丰度（应能看到 PE 链段 → 小分子片段 → C2H4/CH4/H2 演化）。
     - 在 NGL 面板载入 cases/PE_pyrolysis/dump.atom，格式选 lammpstrj，
       表示模式 球棍，让我手动切帧观察键断裂。

每一步执行完简短汇报，再继续下一步。如果 lmp 二进制还没部署，先提醒我去欢迎页一键部署。
```

---

## 预期产物

| 产物 | t < 30 ps | 30–60 ps | 60–100 ps |
|---|---|---|---|
| 长链 PE | 100% | 减少 | 极少 |
| C2H4 (乙烯) | 0 | 出现 | 主峰之一 |
| CH4 | 0 | 微量 | 显著 |
| H2 | 0 | 微量 | 显著 |
| 自由基 (CHx·) | 0 | 短暂峰 | 持续中等 |

---

## 准备好的文件

- `monomer.pdb` → 拷贝自 `monomers/PE.pdb`，packmol 建盒输入。
- `packmol.inp` → 已写好的 packmol 配置（备用：如果智能体跳过 lmp_packmol_build，可手工 `packmol < packmol.inp`）。
- `in.lammps.ref` → 参考 LAMMPS 输入脚本（仅作对照；正式运行应由 lmp_render_in_template 重新渲染以保持模板版本一致）。

## 冒烟测试模式

如果只想验证管线、不等 100 ps：把 prompt 里 `run 1000000` 改成 `run 100000`（=10 ps），
其它不变。整套流程应在分钟级跑完。
