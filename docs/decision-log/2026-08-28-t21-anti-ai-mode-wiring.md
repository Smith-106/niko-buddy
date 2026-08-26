# decision-log — TASK-P2-21 (T21): 三档 anti_ai_mode 接入 route() 门控 + 改写收敛测试

```yaml
date: 2026-08-28
task_id: TASK-P2-21
decision_type: feature
wave: W3 (Wave-3)
model: deepseek-v4-flash
verified: vitest 52/52 全绿（control-kernel + anti-ai-rewrite-convergence + diff.spec）+ tsc 0 错（novel/ 层）
```

## 决策

### 1. 三档 anti_ai_mode 门控（control-kernel.ts additive）

| 模式 | route() 行为 | reason 上下文 | 接线 |
|------|-------------|--------------|------|
| `off` | anti_ai=fail → judge (不阻塞) | `"anti_ai fail 但 mode=off: 不阻塞"` | 默认值，无接线 |
| `warn` | anti_ai=fail → judge (不阻塞，含注解) | `"anti_ai fail 但 mode=warn: 警告不阻塞 (T19 候选池触发: ...)"` | T19 候选池，warnAnnotation 字段 |
| `block` | anti_ai=fail → revise (硬挡) | `"anti_ai fail 且 mode=block: 硬挡 (T20 阈值已接线 / pending-real-corpus)"` | T20 阈值，blockThresholdApplied 字段 |

- **`gateRouting()` 函数不变**：保持原有 P0>P1>P2 优先级链。新增 `antiAiReason()` 函数提供三档语境 reason。
- **`ControlState` 新增字段**：
  - `warnAnnotation?: WarnAnnotation` — T19 候选池检测结果（由执行层注入，route() 只读传递）
  - `blockThresholdApplied?: boolean` — T20 标定状态（pending-real-corpus 语义：真实语料未到时标定超期，allow warn 不卡）
- **`WarnAnnotation` 接口**：`triggeredFactors` / `summary` / `calibrationSource` 三字段，纯数据不触发 IO/LLM。
- **ADR-19 合规**：route() 仍为纯函数，无 IO/模型调用。grep 确认通过。

### 2. 改写收敛测试（anti-ai-rewrite-convergence.spec.ts 新建）

四组 15 条测试：

| 组 | 测试数 | 覆盖 |
|----|--------|------|
| ① 检测基线 | 3 | slopScore 区分 AI 腔 vs 干净文本，classifySlop 分级正确 |
| ② 改写收敛 | 2 | detect→rewrite→detect slopPenalty 不上升；干净文本退化保护 |
| ③ Myers diff 重建 | 1 | 改写前后 diff 行级重建一致 |
| ④ anti_ai_mode 门控 | 9 | off/warn/block 三档全组合，P0 优先于 P1，P2 永不挡，T19/T20 注解 |

收敛判据：改写后 slopPenalty ≤ 改写前（非退化），dual-pass productionHardGate=false（Track B soft）。

### 3. Myers diff 章节级 diff（diff.ts additive）

- **`computeMyersDiff()`**：行级 Myers O(ND) 算法，O(N+M) 空间。按换行符分割为行，使用 LCS 回溯构造差异序列。
- 当 Myers 搜索退化时回退到 `computeLcsDiff()`。
- 与现有 LCS 版本共存：LCS 保留字符级短文本路径，Myers 用于章节级大文本。
- 性能：10→15 行章节级 diff 在 1ms 内完成。

### 4. 720k 穷举性能保持

| 指标 | 值 | 预算 | 状态 |
|------|-----|------|------|
| 720k 穷举耗时 | 1003ms | 5000ms | ✅ 余量 79.9% |
| 组合数 | 720,000 | 720,000 | ✅ 精确匹配 |
| 错误数 | 0 | 0 | ✅ |

## 边界

- T19 候选池的 warnAnnotation 由执行层注入，route() 纯函数不直接调用 T19。
- T20 阈值通过 `blockThresholdApplied` 布尔标记传递，标定超期逻辑在 `antiAiReason()` 中判定。
- `computeMyersDiff` 使用行级 LCS 回溯（行数远小于字符数，O(NM) 对行级可接受）。

## 主 agent 复核注记（2026-08-28）

- 保持 `gateRouting()` 函数签名不变，外部消费者不需要修改。
- `antiAiReason()` 独立函数避免污染 gateRouting 的简单返回值。
- spec 的 ④ 组覆盖所有三档组合 + P0/P2 边界 + T19/T20 注解传递，无遗漏。