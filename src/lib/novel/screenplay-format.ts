/**
 * R-inkos-7 (23-inkos-coverage roadmap P2): ScreenplayFormat — 剧本格式解析与校验.
 *
 * 吸收来源：reference/inkos packages/core/skills/inkos-script-writing（按幕/
 * 场次结构生成影视剧本）— 23 号覆盖审计终裁 roadmap P2；本 goal 落地其
 * 引擎层组件（场景标题 slug line 解析 + 格式校验），LLM 生成属产品层。
 *
 * slug line 规范（中文剧本适配）：场景标题以 INT./EXT./I-E.（内景/外景/内外）
 * 开头，后随地点与时间OfDay（如 "INT. 废弃工厂 - 夜"）。无场景标题的正文
 * 报 findings（error）；格式不规范的场景标题报 warn。
 */

export type SceneHeadingIntExt = "INT" | "EXT" | "I-E"

export interface ParsedSlugLine {
  intExt: SceneHeadingIntExt
  location: string
  timeOfDay: string
}

const SLUG_RE =
  /^(INT|EXT|I-E)\s*[.．]\s*(.+?)\s*[-－—–]\s*(.+?)\s*$/u

const TIME_OF_DAY_HINTS = [
  "日",
  "夜",
  "晨",
  "黄昏",
  "傍晚",
  "凌晨",
  "清晨",
  "正午",
  "DAY",
  "NIGHT",
  "DAWN",
  "DUSK",
  "CONTINUOUS",
] as const

/** 解析一行场景标题；非场景标题或格式不完整返回 null。 */
export function parseSlugLine(line: string): ParsedSlugLine | null {
  const trimmed = line.trim()
  const m = SLUG_RE.exec(trimmed)
  if (!m) return null
  const intExt = m[1] as SceneHeadingIntExt
  const location = m[2].trim()
  const timeOfDay = m[3].trim()
  if (location === "" || timeOfDay === "") return null
  return { intExt, location, timeOfDay }
}

export interface ScreenplayFinding {
  code:
    | "missing_slug_after_action" // 正文段前无任何场景标题
    | "slug_time_unknown" // 场景标题时间OfDay不在惯用清单（warn）
    | "empty_scene" // 两个场景标题之间无正文（warn）
    | "consecutive_slugs" // 连续场景标题（warn）
  severity: "error" | "warn"
  line: number
  message: string
}

export interface ScreenplayValidation {
  sceneCount: number
  findings: ScreenplayFinding[]
}

/**
 * 校验剧本草稿结构（确定性）：统计场景数并输出 findings。
 * 结构校验（标题存在性/连续性/空场景）不涉及内容质量判断。
 */
export function validateScreenplayDraft(text: string): ScreenplayValidation {
  const lines = text.split(/\r?\n/)
  const findings: ScreenplayFinding[] = []
  let sceneCount = 0
  let seenSlug = false
  let lastSlugLine = -1
  let contentSinceSlug = 0

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (trimmed === "") continue
    const slug = parseSlugLine(trimmed)
    if (slug) {
      // 时间OfDay 惯用提示（warn 级，非硬规范）
      const known = TIME_OF_DAY_HINTS.some((h) =>
        slug.timeOfDay.toUpperCase().includes(h.toUpperCase()),
      )
      if (!known) {
        findings.push({
          code: "slug_time_unknown",
          severity: "warn",
          line: i + 1,
          message: `场景标题时间「${slug.timeOfDay}」不在惯用清单（日/夜/晨/黄昏…）`,
        })
      }
      if (seenSlug && contentSinceSlug === 0) {
        findings.push({
          code: "consecutive_slugs",
          severity: "warn",
          line: i + 1,
          message: `第 ${lastSlugLine + 1} 行场景标题后无正文，连续出现场景标题`,
        })
      }
      sceneCount++
      seenSlug = true
      lastSlugLine = i
      contentSinceSlug = 0
    } else {
      contentSinceSlug++
      if (!seenSlug) {
        findings.push({
          code: "missing_slug_after_action",
          severity: "error",
          line: i + 1,
          message: `正文出现在首个场景标题（INT./EXT.）之前`,
        })
        // 只报首个，避免刷屏
        seenSlug = true
        lastSlugLine = -1
        contentSinceSlug = 1
        // 将此前正文视为"无标题场景"，继续校验后续
        sceneCount++
      }
    }
  }

  if (seenSlug && contentSinceSlug === 0 && lines.some((l) => l.trim() !== "")) {
    findings.push({
      code: "empty_scene",
      severity: "warn",
      line: lastSlugLine + 1,
      message: `最后一个场景标题之后无正文（空场景）`,
    })
  }

  return { sceneCount, findings }
}
