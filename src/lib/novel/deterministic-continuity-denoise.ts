/**
 * deterministic-continuity-denoise.ts — 三段式去噪合并链 + canonical_family 归一
 *（纯搬迁，零逻辑变更；来自 deterministic-continuity-engine.ts 的 P1 巨文件拆分）
 *
 * 53 号报告 P0-1: pagegod 三段去噪（merge → canonical family → suppress）。
 */
// ============================================================================
// 53 号报告 P0-1: pagegod 三段式去噪合并链 + canonical_family 归一
// ============================================================================

/**
 * CONTINUITY_CANONICAL_FAMILY (53 号报告 P0-1): ContinuityFindingType → 9 族
 * canonical family 映射。镜像 pagegod V38 CANONICAL_FAMILY (14 code→9 family)
 * 语义, 按 Niko Buddy 现有 14 类 finding 适配 (Apache-2.0 借模式)。所有映射机械
 * 赋值, 非 LLM。
 */
export const CONTINUITY_CANONICAL_FAMILY: Record<ContinuityFindingType, string> = {
  knowledge_boundary: "knowledge_route_or_leak",
  barrier_state: "barrier_or_layout",
  presence_path: "presence_path",
  container_state: "container_state",
  set_count_drift: "count_or_inventory",
  numeric_drift: "count_or_inventory",
  lost_item: "object_custody",
  timeline_drift: "temporal",
  dormant_thread: "thread_or_foreshadowing",
  overdue_thread: "thread_or_foreshadowing",
  unresolved_foreshadowing: "thread_or_foreshadowing",
  absent_character: "character_state",
  dead_character_state: "character_state",
  data_gap: "data_gap",
}

/** 去噪链配置: merge 章号间距阈值 (镜像 pagegod gap_limit 3/6/12 保守档) */
import type {
  ContinuityFinding,
  ContinuityFindingType,
  ContinuitySeverity,
} from "./deterministic-continuity-engine"

export interface DenoiseConfig {
  /** 普通 family merge 最大章号间距 (默认 6) */
  maxGap?: number
  /** set_count_drift family 最大章号间距 (默认 3, 镜像 pagegod count drift 3) */
  countDriftMaxGap?: number
  /** 是否启用去噪 (默认 true; 测试/兼容可关, 守 additive) */
  enabled?: boolean
}

export const DEFAULT_DENOISE_CONFIG: Required<DenoiseConfig> = {
  maxGap: 6,
  countDriftMaxGap: 3,
  enabled: true,
}

/**
 * mergeContinuityFindings (53 号报告 P0-1): 按 (canonicalFamily, ref) 分组,
 * 章号间距 ≤ 阈值成链合并。同链合并为一条: 保留最高 severity、合并 evidence
 * (逗号连接)、chapter 取链首、message 标注「合并 N 条」。data_gap 不参与
 * (独立分组守 IC-02)。镜像 pagegod merge_count_drift_chains /
 * merge_object_custody_chains 同对象成链语义 (Apache-2.0 借模式)。
 */
export function mergeContinuityFindings(
  findings: readonly ContinuityFinding[],
  config: DenoiseConfig = DEFAULT_DENOISE_CONFIG,
): ContinuityFinding[] {
  if (!config.enabled) return [...findings]
  const merged: ContinuityFinding[] = []
  for (const finding of findings) {
    if (finding.subtype === "data_gap" || !finding.canonicalFamily) {
      merged.push(finding)
      continue
    }
    const last = merged[merged.length - 1]
    const maxGap =
      finding.canonicalFamily === "count_or_inventory"
        ? (config.countDriftMaxGap ?? DEFAULT_DENOISE_CONFIG.countDriftMaxGap)
        : (config.maxGap ?? DEFAULT_DENOISE_CONFIG.maxGap)
    if (
      last &&
      last.subtype !== "data_gap" &&
      last.type === finding.type &&
      last.canonicalFamily === finding.canonicalFamily &&
      last.ref === finding.ref &&
      finding.chapter - last.chapter <= maxGap &&
      finding.chapter - last.chapter >= 0
    ) {
      const severityRank: Record<ContinuitySeverity, number> = {
        critical: 3,
        warning: 2,
        info: 1,
      }
      const higher =
        severityRank[finding.severity] > severityRank[last.severity]
          ? finding
          : last
      const mergedCount = (last as { mergedCount?: number }).mergedCount
        ? ((last as { mergedCount?: number }).mergedCount as number) + 1
        : 2
      merged[merged.length - 1] = {
        ...higher,
        // chapter 取链尾 (保持连续成链的 gap 判定一致, 镜像 pagegod 同对象链)
        chapter: finding.chapter,
        // 合并后保留两条 message (逗号连接), 任何一条语义信息都不丢失
        message: `${last.message} + ${finding.message} (合并 ${mergedCount} 条)`,
        evidence: higher.evidence
          ? last.evidence
            ? `${last.evidence}, ${higher.evidence}`
            : higher.evidence
          : last.evidence,
        mergedCount,
      } as ContinuityFinding & { mergedCount?: number }
      continue
    }
    merged.push(finding)
  }
  return merged
}

/**
 * suppressContinuityFindings (53 号报告 P0-1): 4 条抑制规则, 镜像 pagegod
 * suppress 语义中与 Niko Buddy 14 类 finding 可对应的子集 (Apache-2.0 借模式):
 * ① 同段冗余: 同 ref+family+chapter 多条 → 保留 severity 最高者;
 * ② barrier_entry_then_lock: barrier_state critical 抑制同 ref 相邻章
 *    presence_path 同因;③ knowledge_shadowed_custody: knowledge_boundary
 *    critical 抑制同 ref 同章 lost_item warning;
 * ④ 同 ref 同 family 连续章重复 → 保留首条 (后续由 merge 链已处理, 此处兜底
 *    同章重复)。data_gap 不参与抑制 (独立分组守 IC-02)。
 */
export function suppressContinuityFindings(
  findings: readonly ContinuityFinding[],
): ContinuityFinding[] {
  const result: ContinuityFinding[] = []
  for (const finding of findings) {
    if (finding.subtype === "data_gap" || !finding.canonicalFamily) {
      result.push(finding)
      continue
    }
    const rank: Record<ContinuitySeverity, number> = {
      critical: 3,
      warning: 2,
      info: 1,
    }
    // 同键冗余候选: 同 type+family+ref+chapter+message (检测器重复产出)
    const dupIndex = result.findIndex(
      (prev) =>
        prev.type === finding.type &&
        prev.canonicalFamily === finding.canonicalFamily &&
        prev.ref === finding.ref &&
        prev.chapter === finding.chapter &&
        prev.message === finding.message,
    )
    if (dupIndex >= 0) {
      // 当前 severity 更高 → 替换已保留 (保留最高); 否则抑制当前
      if (rank[finding.severity] > rank[result[dupIndex]!.severity]) {
        result[dupIndex] = finding
      }
      continue
    }
    let suppressed = false
    for (const prev of result) {
      // ② barrier_entry_then_lock: barrier critical 抑制相邻章 presence_path 同 ref 同因
      if (
        finding.type === "presence_path" &&
        prev.type === "barrier_state" &&
        prev.severity === "critical" &&
        prev.ref === finding.ref &&
        Math.abs(finding.chapter - prev.chapter) <= 1
      ) {
        suppressed = true
        break
      }
      // ③ knowledge_shadowed_custody: knowledge_boundary critical 抑制同 ref
      //    同章 lost_item warning
      if (
        finding.type === "lost_item" &&
        prev.type === "knowledge_boundary" &&
        prev.severity === "critical" &&
        prev.ref === finding.ref &&
        prev.chapter === finding.chapter
      ) {
        suppressed = true
        break
      }
    }
    if (!suppressed) result.push(finding)
  }
  return result
}

/**
 * fillCanonicalFamily (53 号报告 P0-1): 为缺失 canonicalFamily 的 finding 机械
 * 赋值 (幂等, 已存在则保留)。纯函数零 LLM, additive (undefined → 赋值)。
 */
export function fillCanonicalFamily(
  findings: readonly ContinuityFinding[],
): ContinuityFinding[] {
  return findings.map((f) =>
    f.canonicalFamily ? f : { ...f, canonicalFamily: CONTINUITY_CANONICAL_FAMILY[f.type] },
  )
}

/**
 * denoiseContinuityFindings (53 号报告 P0-1, 权威入口): 三段式去噪链
 * detect(已由 detectors 完成) → merge → suppress, 镜像 pagegod run()
 * detect→merge→suppress→enrich 顺序。纯函数零 IO 零 LLM (守 ADR-29), 不
 * 修改入参 (返回新数组)。
 */
export function denoiseContinuityFindings(
  findings: readonly ContinuityFinding[],
  config: DenoiseConfig = DEFAULT_DENOISE_CONFIG,
): ContinuityFinding[] {
  if (!config.enabled) return [...findings]
  const merged = mergeContinuityFindings(fillCanonicalFamily(findings), config)
  return suppressContinuityFindings(merged)
}
