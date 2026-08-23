/**
 * control-sentinels.ts — T08 哨兵常量/阈值表 (F-10 / A-02.3)
 *
 * 职责 (蓝图 §6 P1 T08 + §8 风险表):
 *   集中公布 route() 内核的哨兵常量与阈值表: 13 分支互斥、720k 穷举组合数、
 *   ≤5s 硬时间界 (超时触发 C-07 Rust 移植预案)、死锁 3×/5× 预算哨兵、
 *   门控优先级 P0>P1>P2、三档 anti_ai_mode、三开关 shell 模式。
 *
 * 定位与边界:
 *   - 机械层零模型调用 (ADR-19): 本文件只含纯数据常量, 无 IO / 无模型调用。
 *   - 与 `offline-replay-config.ts` (T02) 同型态: 常量 + 类型契约, 无运行时依赖。
 *   - 消费方: `control-kernel.ts` (route 内核) 与 `control-kernel.spec.ts` (穷举/属性测试)。
 *
 * 数值口径 (蓝图原文):
 *   - "纯函数 13 分支可穷举" (§10.1) → ROUTE_BRANCH_COUNT = 13
 *   - "720k 穷举+≤5s 硬时间界" (§8 风险表) → EXHAUSTIVE_COMBINATION_COUNT = 720_000,
 *     EXHAUSTIVE_TIME_BUDGET_MS = 5_000 (超时记录并触发 C-07 Rust 移植预案)
 *   - "死锁 3×/5×" (§8 风险表, ainovel-cli 铁律二: 3 次咨询 Arbiter、5 次硬熔断暂停)
 *     → ARBITER_CONSULT_LIMIT = 3, HARD_FUSE_LIMIT = 5
 *   - "门控优先级固定 Consistency(P0) > Anti-AI(P1) > Quality(P2)" (CLAUDE.md 硬约束 3)
 *     → GATE_PRIORITY
 *   - "三开关默认全 legacy" (§4) → ROUTE_SHELL_MODES / ANTI_AI_MODES
 */

// ============================================================================
// route() 分支哨兵 (13 分支互斥, §4 / §10.1)
// ============================================================================

/** route() 互斥分支总数 (蓝图: "纯函数 13 分支可穷举")。 */
export const ROUTE_BRANCH_COUNT = 13

/**
 * 13 个互斥分支 (优先级自上而下第一个命中, 与 route() 实现一一对应):
 *   1. halt              — 终态 (phase=complete / 写作期无进度)
 *   2. foundation_fill   — 规划期缺设定且规划师 tier 已知
 *   3. arbitrate         — 人工介入标记 (僵局/干预, 压过一切自动派单)
 *   4. rewrite           — 重写队列非空 (队列头绝对优先)
 *   5. arc_transition    — 弧末边界 (子步: 弧评审→弧摘要→卷摘要→展开→新卷)
 *   6. global_review     — 周期全局审阅 (每 reviewInterval 章)
 *   7. context_assembly  — 上下文装配
 *   8. scene_breakdown   — 场景拆解
 *   9. task_brief        — 任务简报
 *   10. write_draft      — 写稿 (下一章)
 *   11. review           — 评审 (草稿已就绪, 门控未评估)
 *   12. revise           — 修订 (门控失败 / 修订中)
 *   13. judge            — 终审 (门控通过 / 阶段完成)
 */
export const ROUTE_ACTIONS = [
  "halt",
  "foundation_fill",
  "arbitrate",
  "rewrite",
  "arc_transition",
  "global_review",
  "context_assembly",
  "scene_breakdown",
  "task_brief",
  "write_draft",
  "review",
  "revise",
  "judge",
] as const

/** arc_transition 子步 (弧末事务顺序, 与 ainovel-cli 弧末链同构)。 */
export const ARC_TRANSITION_STEPS = [
  "arc_review",
  "arc_summary",
  "volume_summary",
  "expand_arc",
  "new_volume",
] as const

// ============================================================================
// 720k 穷举 + ≤5s 硬时间界 (A-02.3 / C-07)
// ============================================================================

/**
 * 穷举组合数: 14,400 控制维组合 × 50 弧边界用例 = 720,000。
 * 与 ainovel-cli `internal/flow/router_exhaustive_test.go` 的 720,000
 * (14,400 基础组合 × 50 boundaryCase) 逐项对照, 对照表见
 * `docs/decision-log/2026-08-20-t08.md`。
 */
export const EXHAUSTIVE_COMBINATION_COUNT = 720_000

/**
 * 720k 单循环硬时间界 (毫秒)。超时 → 记录并触发 C-07 Rust 移植预案
 * (蓝图 §8 风险表: "720k 单循环 >5s → 保 TS; 实测爆炸→提前触发 C7 Rust 移植")。
 */
export const EXHAUSTIVE_TIME_BUDGET_MS = 5_000

// ============================================================================
// 死锁预算哨兵 (蓝图 §8: "死锁 3×/5×"; ainovel-cli 铁律二)
// ============================================================================

/** 僵局时咨询 Arbiter 的次数上限 (3 次后转硬熔断)。 */
export const ARBITER_CONSULT_LIMIT = 3

/** 硬熔断暂停阈值: 同一 Agent+Task 连续 5 次路由后置条件未满足 → 暂停。 */
export const HARD_FUSE_LIMIT = 5

// ============================================================================
// 门控优先级 + 三档 anti_ai_mode (CLAUDE.md 硬约束 3 / T21)
// ============================================================================

/** 门控优先级: Consistency(P0) > Anti-AI(P1) > Quality(P2), Quality 永不覆盖 P0/P1。 */
export const GATE_PRIORITY = ["consistency", "anti_ai", "quality"] as const

/** 三档 anti_ai_mode (T21): off=不挡 / warn=警告不挡 / block=硬挡。 */
export const ANTI_AI_MODES = ["off", "warn", "block"] as const

/** 三开关 shell 模式 (§4, 默认全 legacy): legacy=旧行为 / consult=咨询 / authoritative=权威。 */
export const ROUTE_SHELL_MODES = ["legacy", "consult", "authoritative"] as const

/** 门控裁定三值。 */
export const GATE_VERDICTS = ["pending", "pass", "fail"] as const

/** 周期全局审阅默认间隔 (章, ainovel-cli ReviewInterval=5 同源)。 */
export const DEFAULT_REVIEW_INTERVAL = 5

// ============================================================================
// 类型枚举哨兵 (与 control-kernel.ts 类型契约同源)
// ============================================================================

/** 阶段枚举 (7 值, 与 deep-chapter-generation 的 resume stage 链同构)。 */
export const ROUTE_STAGES = [
  "context",
  "scene_breakdown",
  "task_brief",
  "draft",
  "review",
  "revision",
  "done",
] as const

/** 执行角色 (T33 注册表接入点, 默认全角色单模型 = 现状, A-35 位级等价不破)。 */
export const ROUTE_ROLES = [
  "writer",
  "reviewer",
  "arbiter",
  "judge",
  "architect",
  "editor",
] as const
