# T29b canon 写路径编辑 UI + F-27 卡文引导流入口

| 字段 | 值 |
|------|----------------|
| date | 2026-08-28 |
| task_id | T29b (TASK-P3-29b) |
| decision_type | 裁决 / 基线值 |
| value | 校正写路径=canon_supersede_edges 复用；known_by 白名单 fail-closed；A-22.6 自洽机械定义 |
| evidence_ref | `src/components/novel/canon-editor.tsx` + `src/components/novel/wish-drive.tsx`（spec 同目录；`npx vitest run canon-editor wish-drive` 60/60 绿 + `npx tsc --build` 0 错） |

## 一、关键决策

### 1. 写路径不新开 Rust 面：校正 = supersede（旧边封顶 + 后继插入）

canon_commands.rs 已有 `canon_supersede_edges`（T13），人工校正 known_by/revealed_at
复用该命令，零新增 Rust 面：

- **cap_chapter = old.valid_at ?? 0**：旧边自生效点起被后继取代（无缝替换），
  且恒满足 `valid_at <= invalid_at` 时态不变量；已封顶旧边重复封顶无害。
- **后继边继承旧边全部字段**（含 world 时态 valid_at/invalid_at 与技法列），
  仅覆盖 id/known_by/revealed_at 并重算 digest——校正只动认知轴，不改世界时态。
- 后继 id = `corr:<oldId>:<salt>`（调用方生成，符合 T13「新边由调用方生成」约定）；
  digest 为 FNV-1a 32 位确定性摘要（同内容同值，可复核）。

### 2. POV 防泄密：known_by 白名单校验 fail-closed

编辑面必须看到原始边上的 `known_by`（T14 `projectEdge` 读出口剥离契约不适用于
编辑面），防泄密职责由写入守卫承担：

- `povAllowlist`（项目角色注册表投影，props 注入）为唯一增补来源；
  白名单外条目在客户端拦截，不触达 IPC；
- **白名单空/缺省 = 禁止一切增补**（fail-closed）；移除方向不受限
  （缩减知晓集永不泄密）；
- 空白条目 / 重复条目同样拦截。

### 3. revealed_at 时态不变量客户端先行拦截

与 Rust `validate_edge_temporal` 对齐（RevealedBeforeValid）：revealed_at >= valid_at、
≥1 整数章号或留空、非空则 known_by 不得为空。revealed_at 输入框用
`type="text" inputMode="numeric"` 而非 `type="number"`——number 输入会把非法值
静默清洗为空串，绕过校验面。

### 4. A-22.6「wish 与 arc_stage 自洽」的机械定义

蓝图原文只给判定目标未给规则；本任务定稿可构造用例命中的机械口径（零 LLM）：

1. wish 清单非空（至少一条非空白项）；
2. arc_stage 是 U-04 提案 7 值注册表合法值（上游脏值在装配门拦下）；
3. 承诺后推进段（commitment/active/crisis/climax）wish 必须已有行动证据
   （wma_action 非空）——愿望—行动断层即卡文根因；觉醒前两段
   （ghost_exposed/refusal）与收束段（resolution）不强制。

校验不过 → 引导入口关闭（blocked 态），不产出半成品引导。引导问题序列源自
craft.wish-motive-action 规则包口径（plot_stall_recovery="ask_wish_motive"，T27b）。

### 5. 数据源边界

- canon-editor.tsx 直连 `canon_query_batch`（与 T18a 同一 IPC 缝合点），
  仅 type-only 引用 `@/lib/novel/canon-graph-client` 的 wire 类型，不触碰
  `src/components/canon-editor/`（T18a 只读版）与 craft/ UI 目录（归 T29a）。
- wish-drive.tsx 零 IO、零 invoke：profile 由调用方注入（props-DI，与
  arc-workbench 同型态），数据源为 T26 entities 技法字段投影。

## 二、验证证据

```
npx vitest run canon-editor wish-drive   # 3 files, 60 tests passed（含 T18a 回归）
npx tsc --build                          # exit 0，0 错误
```

## 三、债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20260828-01 | ESLint 全仓不可运行：eslint.config.js 依赖 typescript-eslint 但 package.json 未声明且 node_modules 缺失（WIP 工作树现状，非本任务引入）；boundaries 门禁暂无法对本任务四文件出报告 | 依赖修复后跑 `npx eslint src/components/novel/{canon-editor,wish-drive}*` 补验 | **已核销（W1 波修复）** |
