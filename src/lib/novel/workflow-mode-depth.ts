import type { AiWorkflowMode } from "@/lib/agent/workflow-mode"
import type { NovelConfig } from "@/stores/wiki-store-config"

/**
 * DEBT-20261108-01：把工作流档位（`workflowMode`）映射成深章管线的**真实**深度开关。
 *
 * 背景：`pipeline.run_chapter` / `chapter.batch` / `run_chapter_workflow` 三个入口都接受
 * `workflowMode`，但深章管线（`DeepChapterGenerationInput`）没有「档位」这个参数，
 * 于是过去它被校验完就丢掉——调用方以为传了有效值，实际零影响。
 *
 * 修法：不新增一个没人读的字段，而是把档位映射到管线**已经在读**的两个加厚阶段：
 *   - `consensusEnabled`：共识写作 / 共识审查旁路（`consensus-writing.ts`、
 *     `dimension-review-adapter.ts` 读；模型组为空时内部直通单模型）；
 *   - `literaryPolishAfterGate`：一致性门控之后的文学打磨阶段
 *     （`deep-chapter-review-repair.ts` 读）。
 *
 * 口径：
 *   - `fast`：上述两个加厚阶段关掉，阶段数最少、耗时最短。
 *   - `standard`：完全按应用设置（默认行为，连对象引用都不换，保证零行为变更）。
 *   - `strict`：两个加厚阶段打开；共识是否真起多模型仍取决于
 *     `consensusWritingModels` / `consensusReviewModels` 是否配置（未配置则直通单模型）。
 *
 * 边界：**任何档位都不跳一致性门控**（Consistency P0 > Anti-AI P1 > Quality P2 是硬门）。
 * `fast` 只是少做「加厚」，不是少做「验收」。
 */
export function applyWorkflowModeDepth(
  config: NovelConfig,
  mode: AiWorkflowMode | undefined,
): NovelConfig {
  if (mode === "fast") {
    return { ...config, consensusEnabled: false, literaryPolishAfterGate: false }
  }
  if (mode === "strict") {
    return { ...config, consensusEnabled: true, literaryPolishAfterGate: true }
  }
  return config
}
