import type { Tool } from "../types"

export interface QualityToolDeps {
  /** 六维评分：返回维度 → 分数（0-10）。实现方自行决定走 LLM 还是本地启发式。 */
  scoreChapter: (content: string) => Promise<Record<string, number>>
  /** 定向重写：按 brief 只改未达标维度，返回重写后的正文（不落盘）。 */
  reviseChapter: (content: string, brief: string) => Promise<string>
}

/**
 * `score_chapter`：给一段正文打六维分。
 *
 * 只读工具（不写盘）。让主控 Agent 自己判断「该不该继续改」，而不是靠外部固定循环。
 */
export function createScoreChapterTool(deps: QualityToolDeps): Tool {
  return {
    name: "score_chapter",
    description:
      "给一段章节正文打六维分（thrill/consistency/pacing/character/continuity/pull，0-10）。参数 content 为正文全文。返回各维分数与中位分。",
    category: "read",
    permission: "auto",
    parameters: {
      content: { type: "string", description: "待评分的正文全文", required: true },
    },
    execute: async (params) => {
      const content = String(params.content ?? "")
      if (!content.trim()) return "错误：content 为空"
      try {
        const dims = await deps.scoreChapter(content)
        const values = Object.values(dims).filter((v) => Number.isFinite(v))
        const sorted = [...values].sort((a, b) => a - b)
        const mid = Math.floor(sorted.length / 2)
        const median =
          sorted.length === 0
            ? 0
            : sorted.length % 2 === 0
              ? (sorted[mid - 1] + sorted[mid]) / 2
              : sorted[mid]
        return `${JSON.stringify({ dims, median: Math.round(median * 100) / 100 })}`
      } catch (err) {
        return `错误：评分失败 — ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }
}

/**
 * `revise_chapter`：按评分缺口定向重写，只返回文本（不落盘，正式写入仍走 write_chapter 草稿）。
 */
export function createReviseChapterTool(deps: QualityToolDeps): Tool {
  return {
    name: "revise_chapter",
    description:
      "按未达标维度定向重写正文，返回重写后的文本（不会写盘）。参数 content 为原文，brief 为重写指令（可用 score_chapter 的缺口信息自行撰写）。",
    category: "action",
    permission: "auto",
    parameters: {
      content: { type: "string", description: "待重写的正文全文", required: true },
      brief: { type: "string", description: "定向重写指令：要改哪些维度、保留什么", required: true },
    },
    execute: async (params) => {
      const content = String(params.content ?? "")
      const brief = String(params.brief ?? "")
      if (!content.trim()) return "错误：content 为空"
      if (!brief.trim()) return "错误：brief 为空"
      try {
        return await deps.reviseChapter(content, brief)
      } catch (err) {
        return `错误：重写失败 — ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }
}
