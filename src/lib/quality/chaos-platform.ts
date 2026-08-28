/**
 * chaos-platform.ts — v2.7.2 混沌平台（影子环境隔离 + fault_id + P0 保护壳）
 *
 * 蓝图 `docs/p0/blueprint-v272-20260828.md`：
 *   - 默认 disabled + 仅影子环境（只读镜像流量回放，不触达生产草稿/正式记忆）
 *   - 双人授权开启 + 注入类型限可观测故障（网络/延迟/资源三类）+ 生产零注入
 *   - P0 一致性引擎只读保护壳（混沌注入下 P0 保持 100%）；不触碰 status.json 真源
 *
 * 执行纪律: ADR-19 零 LLM / 零 IO；纯函数
 */

// ============================================================================
// 混沌平台
// ============================================================================

/** 注入类型（限可观测故障三类）。 */
export type ChaosFault = "network" | "latency" | "resource"

/** 注入配置。 */
export interface ChaosInjection {
  faultId: string
  fault: ChaosFault
  /** 授权状态（双人授权）。 */
  authorized: boolean
  /** 影子环境隔离。 */
  shadowIsolated: boolean
  /** 是否触碰生产真源（必须 false）。 */
  touchesProduction: boolean
}

/** 混沌结果。 */
export interface ChaosResult {
  /** 平台是否默认 disabled。 */
  defaultDisabled: boolean
  /** P0 门控在注入下保持率（100% 硬门）。 */
  p0Retained: number
  /** 真源脏写数（必须=0）。 */
  sourceDirtyWrites: number
  /** 未授权注入数（必须=0）。 */
  unauthorizedCount: number
  /** 达标判定。 */
  passed: boolean
}

/**
 * 混沌平台校验（纯函数——确定性）。
 * 输入：注入配置序列 + P0 保持率；输出：隔离/授权/真源判定。
 * 语义：默认 disabled；注入须双人授权 + 影子隔离；P0 保持 100%；真源零脏写。
 */
export function evaluateChaos(
  injections: ChaosInjection[],
  p0Retained: number,
  defaultDisabled = true,
): ChaosResult {
  const unauthorizedCount = injections.filter((i) => !i.authorized).length
  const sourceDirtyWrites = injections.filter((i) => i.touchesProduction).length
  const notIsolated = injections.filter((i) => !i.shadowIsolated).length
  return {
    defaultDisabled,
    p0Retained,
    sourceDirtyWrites,
    unauthorizedCount,
    passed: defaultDisabled && p0Retained >= 1 && sourceDirtyWrites === 0 && unauthorizedCount === 0 && notIsolated === 0,
  }
}
