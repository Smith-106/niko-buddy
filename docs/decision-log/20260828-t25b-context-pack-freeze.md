# 20260828 — T25b ContextPack 冻结不变量（同章共享 pack + canon 哈希并入 task_brief + 前缀字节稳定）

> 任务：TASK-P3-25b / 蓝图 §6 T25b
> 交付物：`QMAI/src/lib/novel/context-pack-freeze.spec.ts`（三条不变量）+ `QMAI/src/lib/novel/deep-chapter-task-brief.ts`（additive canonHash 参数）
> 验证证据：`npx vitest run context-pack-freeze context-engine` 全绿 + `npx tsc --build` 0 错

## 一、decision-log 条目

| 字段 | 值 |
|------|------|
| date | 2026-08-28 |
| task_id | T25b |
| decision_type | 冻结不变量定稿 |
| evidence_ref | `QMAI/src/lib/novel/context-pack-freeze.spec.ts` / `deep-chapter-task-brief.ts`（additive `canonHash` 参数） |

### D1 同章共享 pack 不变量 = digest 断言（剔除 sourceTimingsMs 后）

- **value**：对同一 `buildContextPack` 输入（projectPath / task / chapterNumber），两次调用所得 `ContextPack` 的 `computeCheckpointDigestOf` 摘要一致。摘要前剥离 `sourceTimingsMs` 字段（遥测计时点随 execution 差异，不属于语义内容）。
- **rationale**：T25 三源并行段含 `performance.now()` 计时探针，同输入两次 build 的 `sourceTimingsMs` 必然不同；但语义内容（task/outline/canonRules/…）应完全一致。剥离计时字段后 digest 一致即证明同输入共享同一 pack——provider prefix cache 的地基。
- **替代方案**：mock `performance.now()` 固定值。但剥离字段更贴近真实语义「共享同一 pack」的意图，不依赖 mock 实现细节。
- **影响**：正向——provider prefix cache 可安全复用同章 pack；零负向。
- **验证**：`context-pack-freeze.spec.ts` Invariant 1 用例。

### D2 canon 事实集哈希并入 task_brief = additive `canonHash` 参数

- **value**：`buildFallbackTaskBrief` 新增可选第 5 参数 `canonHash?: string`；传入时在 task_brief 末尾追加 `正史指纹：${canonHash}` 行。`canonHash` 由 `computeCheckpointDigestOf(canonRules)` 计算，随 canon 事实集变化而变。
- **rationale**：provider prefix cache 需要 task_brief 携带 canon 指纹，使 LLM 能检测 canon 是否变化。同步 `computeCheckpointDigestOf` 复用 T07 checkpoint-digest 的 SHA-256 幂等键，零新依赖。
- **替代方案**：自动计算 `contextPack.canonRules` 的 digest 而不暴露参数。拒绝理由：`computeCheckpointDigestOf` 是异步 API（`crypto.subtle.digest`），`buildFallbackTaskBrief` 是同步函数，加参数保持同步签名不破坏调用方。
- **影响**：正向——task_brief 可溯源 canon 版本；零负向——可选参数，不传时行为完全不变。
- **验证**：`context-pack-freeze.spec.ts` Invariant 2 用例：hash 出现在 task_brief 中且随 canon 事实集变化。

### D3 前缀字节稳定性 = `contextPackToPrompt` 两次输出前 N 字节一致

- **value**：同一输入两次 `buildContextPack` → `contextPackToPrompt` 转换，输出字符串的前 100 字节完全一致。`sourceTimingsMs` 不被 `contextPackToPrompt` 渲染（不在 `FIELD_CONFIGS` 中），故前缀天然稳定。
- **rationale**：LLM provider prefix cache 的前提是 prompt 前缀字节逐字节一致。T25 三源并行段引入的 `sourceTimingsMs` 不被 prompt 渲染，因此前缀不变。本测试固化此属性。
- **替代方案**：mock `performance.now()` 确保全量一致。但 prompt 层面已不渲染计时字段，无需 mock。
- **影响**：正向——provider prefix cache 前提确认；零负向。
- **验证**：`context-pack-freeze.spec.ts` Invariant 3 用例。

## 二、债条目

| 债 ID | 描述 | 偿还触发 | 到期阶段 |
|-------|------|----------|----------|
| DEBT-20260828-t25b-1 | `buildFallbackTaskBrief` 的 `canonHash` 参数在 `deep-chapter-generation.ts` 的两个调用点尚未传值（传 undefined = 现有行为不变）。需在 T33 五角色编排层接线时计算 `computeCheckpointDigestOf(contextPack.canonRules)` 并传入。 | T33 角色编排层 task_brief 构建接线 | P3 收口 |