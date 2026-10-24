# 20261025 全栈 Odyssey Loop（3 轮自发现与自修复）

> 路径：`QMAI/docs/decision-log/20261025-fullstack-odyssey-loop.md`
> 模式映射：Round1 = improve + review（接线/假状态） · Round2 = ui（核心创作流可视化） · Round3 = review（边界/无障碍/测试加固）
> 收官门禁：3 轮全部落盘 + `npm run typecheck` 0 错 + `eslint` 0 错 + `vitest` 受影响域绿。未完成全部 3 轮前 verifier 必须判 fail。

## 立项（INTAKE）

| 字段 | 值 |
|------|-----|
| date | 2026-10-25 |
| target | `QMAI/src/components/` + `QMAI/src/lib/novel/` |
| modes | ui / improve / review（maestro-odyssey 三模式分轮执行） |
| session | goal d51adfa8 active；Todo #1-#5 |
| 约束 | 只改已存在锚点文件；禁止 `src/lib/novel/` 外平行复制主链；`status.json` 唯一真源；Draft-first；门禁 P0>P1>P2；`smith` 为唯一产品推送远端 |

## Round 1 — 前后端接线与假状态猎取（improve/review）

目标：扫描“后端已有能力但前端传硬编码占位/吞掉错误/只读无操作入口/状态未同步”，挑最高价值 2 处打通。

- R1-F1（状态未同步，高价值）：`chapter-selection-panel.tsx` 工作台草稿仅 `workstationDraftsRef` 内存态，卸载即丢，`initialDrafts` 快照陈旧。修复：写透 `localStorage(niko-buddy.workstationDrafts.v1)`，挂载恢复+破坏 JSON 洗掉。
- R1-F2（吞掉错误，高价值）：`deep-chapter-generation.ts` 两处 `statusMerger.flush().catch(()=>{})` 裸吞，`status.json` 写失败不可见。修复：catch 内 `logger.warn("deep-chapter", ...)` 留痕，行为仍不阻断返回。

状态：已完成。

- R1-F1 落盘：组件写透 + spec 在原内存断言上追加 localStorage 断言与清理。`vitest run chapter-selection-panel.spec.tsx` 37/37 绿。
- R1-F2 落盘：两处 flush 失败记 warn（已按 `logger.warn(scope,message)` 双参签名修正）。`typecheck` 全量 0 错。
- 扫描说明：canon 编辑器已具备校正写路径（非只读断层）；按钮嵌套全仓无命中；其余 `.catch(()=>{})` 多为 mkdir 幂等，不列入本轮。

## Round 2 — 核心创作流 UX 与可视化（ui）

目标：大纲编辑、拆书库、故事推演室、角色工作台四路径，修信息过载/步骤繁琐/纯文字堆砌，升级为视觉指示器。browser 实测优先，无可用 browser 时以代码级渲染断言+spec 代证。

- R2-F1：`dismantling-view.tsx` 结果区计数徽标（X 章 · Y 条）+ 进度指示器（已拆/进行中/失败色点）+ `StatusBadge` 色点化 + 章节标题 `truncate+title`。
- R2-F2：`character-workstation-view.tsx` 切换 tab 补 `focus-visible` 环，工位头新增草稿指示器（空/已保存·N字+色点，`station-draft-indicator-*`）。

状态：已完成。

- 验证：`vitest run dismantling-view.spec + character-workstation-view.spec` 25/25 绿（后与 R3 合跑 62/62）。
- browser 说明：本环境无可用 browser 通道，以代码级渲染断言+spec 代证，如实记录，未虚构实测。

## Round 3 — 边界容错、无障碍与测试加固（review）

目标：空项目/超长文本/离线无 Key 下不崩；按钮嵌套、焦点环缺失、并行 timer 串扰清零；typecheck/eslint/vitest 全绿。

- R3-F1（边界）：`dismantling-view.tsx` 对 `chapters/structureMemory/analyses` 加 `Array.isArray` 守卫 + 全选按钮守卫 + 超长标题/记忆 `truncate+title`，损坏 library JSON 不崩。
- R3-F2（无障碍）：工作台 tab / 拆文 checkbox + select 补 `focus-visible:ring-2`；全仓扫描确认无 `<button>` 嵌套。
- R3-F3（测试）：`dismantling-view.spec` 与 `character-workstation-view.spec` 的 `afterEach` 补 `vi.useRealTimers()`（拆文侧另加 `restoreAllMocks`），防并行 timer 串扰。

状态：已完成。

- 验证：`vitest run` 三文件（dismantling + workstation + chapter-selection）62/62 绿；`npm run typecheck` 0 错；`npm run lint`（eslint + boundaries 5/5）PASS。

## 验收（END）

- [x] R1 两修复+spec 落盘
- [x] R2 可视化落盘+渲染验证（spec 代证，browser 缺位如实记录）
- [x] R3 加固落盘+三门禁绿
- [x] 本账本三轮小节齐全，方可收官
