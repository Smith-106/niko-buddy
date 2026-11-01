# 20261101 pipeline-remap P1 阶段一拓扑落地（G2 execute）

- session `20261101-ralph-pipeline-remap` / run `run-2863406d2bf5` / step `step-execute`（stage=execute，goal G2）
- orchestration_revision=18 / run_revision=1 / actor=niko
- 上游：`run-a428e46acc5b` plan（W1 TASK-001‖TASK-002 → W2 TASK-003 → W3 TASK-004）

## 锁定的四个决议（原样执行）

- **D1 有参考阈值（locked）**：仅显式范文ID/拆书报告ID才算有参考并触发 B 路；
  其余一律直写 A 路。分支点 evidence→outline；eventToStage 映射不上返回 null
  （只进计数与 log，不落节点）。实现：`hasExplicitReferenceId` /
  `resolveDraftRoute`（`src/lib/novel/skill-route-registry.ts`），面板 B 桩仅展示、
  无参考回落 A。不得用模糊匹配/链接猜测触发 B 路。
- **D2 路线口径（locked）**：A=大纲直写默认主路
  （goal→evidence→outline→chapter-plan→draft→self-gate→review-gate→ingest）；
  B=参考章仿写（有参考走 exemplar/拆书→draft，无参考回落 A）；
  C=碎片拼装（灵感/素材碎片→outline-assembler→draft，P1 仅留入口）；
  D=场景分镜装配（combat_scene/dialogue_scene 分发→draft→review，P1 分支桩，P2 闭环）。
- **D3 形态四名（locked）**：章回正文/卷纲合集/设定集/出版导出包。
  映射到 ingest→deliver→reflow→retrospective；实体导出走
  backupExport/exportCenter/dataManager 只读展示，不新增真源。
- **D4 能力池替代（locked）**：P1 以 12+8 泳道矩阵+6 库+skill 全集呈现能力池，
  不硬凑 17 个；17 库明细进 P2 回流反哺输入。

## P1/P2 切分（本 run 只做 P1）

- P1：拓扑+路由+能力池+硬门形态（V1–V9；V6/V8/V9 做分支桩+默认口径）。
- P2：装配闭环+终端联动+回流反哺（V10 全量，只读实现）；C 碎片拼装装配细节、
  D 场景分镜闭环、17 库逐一对拷均进 P2，不在本 run。
- 控制台只读投影锁定：未改 run-events 账本写入路径与 `.novel/status` 真源；
  管线 10s 只读轮询、零事件空态保留；只做投影+回放演示，不做执行入口。

## 改动清单（QMAI 工作树内，文件:行）

- `src/lib/novel/skill-route-registry.ts`：long_form_drafting 别名增量
  （范文仿写/拆书报告仿写，仅别名不改名）+ `EXPLICIT_REFERENCE_PATTERNS` /
  `hasExplicitReferenceId` / `resolveDraftRoute` + 导出
  `SKILL_ROUTE_DEFINITIONS` / `CHAPTER_OUTLINE_SUPPORT_SKILLS`（加 `export`，行为不变）。
- `src/lib/novel/pipeline-motion-projection.ts`：eventToStage 注释补 D1 口径
  （`null`=映射不上，只进计数与 log，不落节点），逻辑零改。
- `src/lib/novel/audit-taxonomy.ts`：零改（GateKey/GATE_MAPPING/37 维 15/10/12
  与优先级复用，Quality 不得覆盖 Consistency）。
- `src/components/novel/module-heatmap-view.tsx`：`MAIN_LANES` /
  `SUPPORT_LANES` 加 `export`（12/8 断言用，渲染零改）。
- `src/components/novel/pipeline-motion-panel.tsx`：TRUNK_ORDER 11 条主干边、
  NODE_XY、STAGE_CAPSULES、REVIEW_DIMS、空态、回流环、返工红边全部不动；
  新增 `REFERENCE_BRANCH_POINT`（evidence→outline）、B/C/D 路由桩虚线
  （`motion-route-stub-b/c/d`）、四形态徽（`motion-branch-morph-*`）、
  路线/形态 fieldset+legend 选择器（原生 button，aria-pressed，全键盘可达）。
- `src/components/layout/workbench-view.tsx`：零改（pipelineMotion dev 组入口保留，
  路线入口即面板内 A/B/C/D 选择器，经 dev 卡片进入）。
- `src/components/layout/content-area.tsx`：零改（pipelineMotion 挂载位保留，
  四形态分支展示位即面板内形态徽+选择器）。
- `src/i18n/zh.json` / `src/i18n/en.json`：新增顶层 `pipelineMotion` 15 键，
  zh/en 同构（routeA/B/C/D、routeADefault、hasReferenceHint、exemplarLinkHint、
  branchStubHint、routeLegend、morphLegend、morphChapter/Volume/Setting/Export、
  capabilityPoolTitle）。
- 新增 spec：`src/lib/novel/pipeline-remap-p1.spec.ts`（D1/16×3/7件套/门优先级/
  12+8+6），`src/components/novel/pipeline-motion-route-stub.spec.tsx`
  （选择器/桩/形态徽/空态回归）。
- 生成物：`npm run gen:atlas` 重生成 `src/lib/novel/module-atlas.generated.json`
  （新文件落盘后接线更新）。

## 门禁（实测记录见 run 报告与 self-check.json）

- `npm run typecheck` 0 错；相关 spec 全绿（tests ≥ 基线）；
  `npm run lint`；`node scripts/check-consistency.mjs`；
  `node scripts/check-generated.mjs` 6/6。
