/**
 * R-inkos-1 (23-inkos-coverage): PlotForecast — 剧情多线推演.
 *
 * 吸收来源：reference/inkos packages/core/src/forecast（剧情多线分支推演，
 * 预演不同走向的一致性与伏笔影响）— 23 号覆盖审计三模型 3/3 absorb_now 共识
 * 第一名（2/3 票 P0）。
 *
 * niko-buddy 落地形态：确定性纯函数（不调 LLM、机械可验证），只读
 * SubplotBoardStore 与候选分支做写前预检，与 subplot-board /
 * foreshadowing-tracker 同层。inkos 的 forecast 面向 agent 决策；本模块面向
 * Draft-first 写作前的 Consistency(P0) 预检——risk 在草稿生成前暴露，
 * 不替代 accept 时硬门（门控优先级固定，Quality 不得覆盖 Consistency）。
 *
 * 纪律：不引入第二真源（A23 / ADR-26 / ANL-013 C4）——forecast 不落盘、
 * 不回写任何 store；fold-rebuild 语义不受影响。
 */

import type { Subplot, SubplotBoardStore } from "./subplot-board"

/** 候选分支：一条支线的一个拟议走向。 */
export interface ForecastBranch {
  id: string
  subplotId: string
  /** 拟议走向的一句话描述（预检对象，不落盘）。 */
  direction: string
  /** 预计该走向推进/回收到的章号。 */
  projectedChapter: number
}

/** 推演风险：确定性规则命中结果。 */
export interface ForecastRisk {
  code:
    | "dormant_revive" // 已回收（resolved）支线被推进
    | "abandoned_reference" // 已废弃支线被推进
    | "paused_advance" // 暂停支线被直接推进（需先恢复）
    | "target_overshoot" // 超出目标回收章（逾期风险）
    | "concurrent_collision" // 同章多线并发推进（伏笔/节奏冲突风险）
  severity: "error" | "warn"
  message: string
}

/** 单分支推演结论。 */
export interface ForecastResult {
  branchId: string
  subplotId: string
  risks: ForecastRisk[]
  /** error 存在 → revise（需修订走向）；否则 advance（可进入草稿）。 */
  verdict: "advance" | "revise"
}

function findSubplot(
  store: SubplotBoardStore,
  subplotId: string,
): Subplot | undefined {
  return store.items.find((s) => s.id === subplotId)
}

/**
 * 对一组候选分支做多线推演预检。确定性：相同输入必产生相同输出；
 * 顺序遵循 branches 输入序，concurrent_collision 以 projectedChapter 分组
 * 按输入序注入首个命中分支之后（不重排输入）。
 */
export function forecastBranches(
  store: SubplotBoardStore,
  branches: ForecastBranch[],
): ForecastResult[] {
  // 并发组：同章被 ≥2 个分支推进 → 全组标记 concurrent_collision。
  const chapterCounts = new Map<number, number>()
  for (const b of branches) {
    chapterCounts.set(b.projectedChapter, (chapterCounts.get(b.projectedChapter) ?? 0) + 1)
  }

  const results: ForecastResult[] = []
  for (const branch of branches) {
    const risks: ForecastRisk[] = []
    const subplot = findSubplot(store, branch.subplotId)

    if (!subplot) {
      risks.push({
        code: "abandoned_reference",
        severity: "error",
        message: `分支 ${branch.id} 引用不存在的支线 ${branch.subplotId}（幽灵引用）`,
      })
    } else {
      if (subplot.abandoned) {
        risks.push({
          code: "abandoned_reference",
          severity: "error",
          message: `支线「${subplot.title}」已显式废弃，不可推进（连续性错误）`,
        })
      }
      if (subplot.status === "resolved") {
        risks.push({
          code: "dormant_revive",
          severity: "error",
          message: `支线「${subplot.title}」已在第 ${subplot.resolvedChapter ?? "?"} 章回收，推进即复活已闭合线`,
        })
      }
      if (subplot.status === "paused") {
        risks.push({
          code: "paused_advance",
          severity: "warn",
          message: `支线「${subplot.title}」处于暂停态，直接推进需先恢复（否则读者视角断线）`,
        })
      }
      if (
        typeof subplot.targetResolutionChapter === "number" &&
        branch.projectedChapter > subplot.targetResolutionChapter
      ) {
        risks.push({
          code: "target_overshoot",
          severity: "warn",
          message: `预计章 ${branch.projectedChapter} 超出目标回收章 ${subplot.targetResolutionChapter}（支线逾期）`,
        })
      }
    }

    if ((chapterCounts.get(branch.projectedChapter) ?? 0) >= 2) {
      risks.push({
        code: "concurrent_collision",
        severity: "warn",
        message: `第 ${branch.projectedChapter} 章有 ${chapterCounts.get(branch.projectedChapter)} 条线并发推进，核查伏笔与节奏冲突`,
      })
    }

    const hasError = risks.some((r) => r.severity === "error")
    results.push({
      branchId: branch.id,
      subplotId: branch.subplotId,
      risks,
      verdict: hasError ? "revise" : "advance",
    })
  }
  return results
}

/**
 * 汇总渲染：把推演结果转成可注入写作上下文的文本（空结果返回 ""，
 * 与 subplotBoardToContextText 的静默约定一致）。
 */
export function forecastResultsToContextText(results: ForecastResult[]): string {
  if (results.length === 0) return ""
  return results
    .map((r) => {
      if (r.risks.length === 0) {
        return `- [可推进] ${r.branchId}（支线 ${r.subplotId}）：无预检风险`
      }
      const label = r.verdict === "revise" ? "需修订" : "可推进"
      const riskText = r.risks.map((rk) => `${rk.severity === "error" ? "错误" : "警告"}:${rk.message}`).join("；")
      return `- [${label}] ${r.branchId}（支线 ${r.subplotId}）：${riskText}`
    })
    .join("\n")
}
