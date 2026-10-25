/**
 * 上下文遥测分层（ISS-20260713-005）。
 *
 * 职责边界：context-engine 只负责“产出遥测样本数据”，“写到哪里/怎么写”
 * 归本模块。engine 持有的是 `RoutingTelemetrySink` 接口，不再直连
 * cognition-state.json 的写入实现（character-cognition.appendRoutingROISample
 * 下沉为本模块默认 sink 的内部细节）。
 *
 * 行为等价保证：
 * - buildRoutingROISample：纯函数，与原 buildContextPackUnlocked 内联
 *   variant / irrelevantRatio / chapterId / timestamp 组装逐行一致。
 * - defaultRoutingTelemetrySink：fire-and-forget 追加 + 失败 warn 日志，
 *   与原 `void appendRoutingROISample(...).catch(...)` 语义一致。
 * - reportRoutingROI：组装 + 投递；未传 sink 时用默认 sink（= 原行为）。
 */
import { logger, toErrorMessage } from "@/lib/utils"
import { appendRoutingROISample, type RoutingROISample } from "./character-cognition"
import { computeIrrelevantRatio } from "./context-retrieval"
import type { ContextEntity, ContextPack } from "./context-engine"

export type { RoutingROISample }

/** 遥测投递接口 —— engine 只依赖此签名，不感知具体落盘位置。 */
export type RoutingTelemetrySink = (
  projectPath: string,
  sample: RoutingROISample,
) => void | Promise<void>

export interface RoutingSampleInput {
  pack: ContextPack
  activeEntities: ContextEntity[]
  chapterNumber?: number
  conditionalRoutingEnabled: boolean
}

/**
 * 纯函数：由装配产物构建 ROI 样本（原内联组装逻辑逐字搬迁）。
 */
export function buildRoutingROISample(input: RoutingSampleInput): RoutingROISample {
  const variant: RoutingROISample["variant"] = input.conditionalRoutingEnabled
    ? "enabled"
    : "disabled"
  const irrelevantRatio = computeIrrelevantRatio(input.pack, input.activeEntities)
  return {
    variant,
    irrelevantRatio,
    chapterId: input.chapterNumber != null ? String(input.chapterNumber) : "unknown",
    timestamp: new Date().toISOString(),
  }
}

/**
 * 默认 sink：写 cognition-state.json routingBuckets（HARD-1 守恒既有 key）。
 * fire-and-forget，非致命失败只记 warn，不阻断主链（原语义）。
 */
export function defaultRoutingTelemetrySink(
  projectPath: string,
  sample: RoutingROISample,
): void {
  void appendRoutingROISample(projectPath, sample).catch((error) => {
    // non-fatal — ROI 采集失败不阻塞主链装配
    logger.warn("ContextEngine", "routing ROI sample append failed (non-fatal)", { error: toErrorMessage(error) })
  })
}

/**
 * 组装并投递一条 ROI 样本。sink 缺省 → 默认 sink（= 原 engine 内联行为）。
 */
export function reportRoutingROI(
  projectPath: string,
  input: RoutingSampleInput,
  sink?: RoutingTelemetrySink,
): void {
  const sample = buildRoutingROISample(input)
  const deliver = sink ?? defaultRoutingTelemetrySink
  try {
    const ret = deliver(projectPath, sample)
    if (ret instanceof Promise) {
      ret.catch((error) => {
        logger.warn("ContextEngine", "routing ROI sample append failed (non-fatal)", { error: toErrorMessage(error) })
      })
    }
  } catch (error) {
    logger.warn("ContextEngine", "routing ROI sample append failed (non-fatal)", { error: toErrorMessage(error) })
  }
}
