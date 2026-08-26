/**
 * de-ai-dual-pass.ts — F-009 迁移兼容重导出。
 *
 * 原 Wave C "双遍软编排" (mechanical slop + avoid-ai patterns + 分位) 已由
 * F-009 分级两遍检测 (112 词分级表 · detect → rewrite → re-detect) 替换。
 * 真源实现位于 de-ai-rules.ts；本文件保持消费点模块路径兼容
 * (de-ai-batch/scheduler.ts 静态导入、novel-skill-hooks.ts 动态导入)。
 *
 * 语义: 保持「信号非证据」立场, 1B 低权重仅轻提示, 不升压为 Anti-AI(P1) 硬门控。
 */
export {
  runDeAiDualPass,
  formatDualPassSummary,
  formatDualPassPromptFragment,
} from "./de-ai-rules"
export type { DualPassResult } from "./de-ai-rules"
