# T33b decision-log 条目 — 精品模式项目配置

> 任务：TASK-P6-33b（T33b）
> 日期：2026-08-28
> 蓝图参照：§7 T33b

## 一、决策条目

| 字段 | 值 |
|------|-----|
| date | 2026-08-28 |
| task_id | T33b |
| decision_type | 定稿 / 基线值 |
| value | **premium-config.ts** 新建模块：`premium_mode` 默认 off；`DEFAULT_PREMIUM_MODE_TRIGGERS` 四开关（GCR 开 / 共识门 开 / 双提案 off / 双判官 off）；`rollbackToSingleModel` 一键回退——还原所有字段到单模型默认；`checkPrefixCacheEligibility` 前缀缓存安全检测——复用 T25b 前缀字节稳定不变量，检查时间戳/随机ID/最小长度后判定；`checkHardPreconditions` 硬前置检查——`canon_migration ≥ dual` 且 reconcile 零差异持续 ≥ N 章（缺省 3）；`tryEnablePremium` 组合入口——前置不满足拒绝启用，前缀不安全自动降级缓存（不阻断精品模式整体启用）。纯函数零 IO。 |
| evidence_ref | `QMAI/src/lib/novel/premium-config.ts`（44 tests passed, 0 tsc errors in premium files）; `QMAI/src/lib/novel/premium-config.spec.ts`（44 tests, 100% 覆盖率） |

## 二、设计决策

### D1 四模式开关细粒度：默认保留 GCR + 共识门，双提案/双判官 off

- **value**：`gcr: true, consensusGate: true, dualProposal: false, dualJudge: false`
- **rationale**：GCR（Gate Control Routing）和共识门是精品模式的基础多模型协作机制，默认开启。双提案（双 writer 独立生成后仲裁）和双判官（双 judge 独立判定后融合）属于高级增强，默认关闭。用户可按需开启，保持向后兼容。

### D2 一键回退的语义：关闭所有精品特性，不清除 requiredZeroDiffChapters

- **value**：`rollbackToSingleModel` 保留 `requiredZeroDiffChapters` 字段（仅清空开关/缓存/fallback 链）
- **rationale**：requiredZeroDiffChapters 是项目配置偏好，不是启用态。回退后用户可重新启用时复用该值，无需重新设置。

### D3 前缀缓存检查顺序：随机 ID 先于时间戳

- **value**：`checkPrefixCacheEligibility` 先检查 UUID/随机 ID 模式，再检查时间戳模式
- **rationale**：UUID 末段 12 位 hex 会被 `\b\d{10,}\b` 时间戳模式误判。先检查精确的 UUID 模式可避免误报。

### D4 前缀缓存降级策略：不阻断精品模式整体启用

- **value**：`tryEnablePremium` 中前缀缓存不安全时仅关闭 `prefixCacheEnabled`，继续返回 `ok: true` 的启用配置
- **rationale**：前缀缓存性能优化而不是功能必要性。不因缓存条件不满足而拒绝整个精品模式启用。

### D5 硬前置检查缺省 N=3

- **value**：`requiredZeroDiffChapters` 默认值 3
- **rationale**：N=3 要求至少连续 3 章 reconcile 零差异，兼顾安全性和可操作性。过短（1-2）抗噪声不足，过长（≥5）延迟启用。

## 三、验收关联

| 检查项 | 结果 |
|--------|------|
| vitest run premium-config | 44/44 passed |
| tsc 0 错误（新文件） | 0 errors in premium-config.ts/.spec.ts（26 既有 errors 未新增） |
| 纯函数 zero IO | ADR-19 合规：grep 0 匹配 fetch/llm/openai/invoke/fs |
| 100% 覆盖率 | 7 describe 块 / 44 tests，覆盖全导出函数 |
| decision-log 条目 | 本文已落 |

## 四、残留风险

- 硬前置检查函数当前为纯函数，不 IO。实际运行时 canon_migration 和 reconcile 数据需调用方注入 —— 调用方需确保数据新鲜度。
- 前缀缓存检测只做静态模式匹配，不验证实际的 T25b 字节稳定性测试。调用方应在开启前缀缓存前额外运行 `context-pack-freeze.spec.ts` 的 Invariant 3 测试。