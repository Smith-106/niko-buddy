/**
 * style-radar-projection.ts — 风格 / 节奏雷达（**只读投影**）。
 *
 * 用户诉求：「把小说风格化，用类似雷达图可视化管理要做什么风格、怎么控节奏」。
 *
 * ## 为什么不是「九维文风雷达」
 * 既有 `BookStyleProfile`（`book-analysis/types.ts:254-281`）的九个维度全是**自由文本**
 * （narrativeDensity / descriptionWeight / sentenceStyle / …），没有有限数值范围，
 * **不能**当雷达半径。硬画就是把字符串编成数字（造假），因此这些维度只以「目标风格（无数值）」
 * 文本列表呈现，不进半径。
 *
 * ## 雷达半径只放「可机算、有界」的量
 * 六个轴全部来自既有机械打分器 `assessChapter`（`self-assessment.ts:93-126`），每轴 0–100，
 * 由章节正文抽样统计得到：篇幅 / 对话节奏 / 段落节奏 / 句式变化 / 场景分段 / 开篇钩子。
 * 它们是**机械代理指标**，不是文学评分 —— 面板标题与图例都如实这么写。
 *
 * 目标节奏（卷纲定位表 `ChapterPosition.pressureLevel 1–5` / `emotionIntensity 1–10`）
 * 是**另一套量纲**，单独以数值卡片呈现，绝不与 0–100 的雷达叠在同一张图上冒充可比。
 *
 * 纯函数、零 IO、零时钟、零模型调用；无正文 → 空 + 显式 N/A，绝不画 0 分雷达。
 *
 * @license MIT © Niko Buddy
 */

import {
  DIMENSION_KEYS,
  DIMENSION_LABELS,
  assessDimension,
  extractSignals,
} from "./self-assessment"
import type { SelfAssessmentDimensionKey } from "./self-assessment"

/** 缺真源时的中文 N/A（面板直接渲染）。 */
export const STYLE_RADAR_NOT_APPLICABLE = [
  {
    id: "text-style-axes",
    label: "文风九维当半径",
    reason: "`BookStyleProfile` 的九个维度是自由文本（无有限数值范围），画成半径等于把字符串编成数字；只以文本列表呈现。",
  },
  {
    id: "literary-score",
    label: "文学质量分",
    reason: "本雷达是机械代理指标（字符统计），不是文学评分；不把代理值当质量结论。",
  },
  {
    id: "cross-scale-overlay",
    label: "目标节奏叠雷达",
    reason: "卷纲定位是压力级 1–5 / 情绪 1–10，与 0–100 代理指标不同量纲，不叠在一张图上比较。",
  },
] as const;

/** 一个雷达轴（可缺 = N/A）。 */
export interface StyleRadarAxis {
  readonly key: SelfAssessmentDimensionKey
  readonly label: string
  /** 0–100 机械代理值；`null` = 缺真源（不画这个顶点，也不填 0）。 */
  readonly value: number | null
}

/** 目标节奏（卷纲定位；与雷达不同量纲，单独展示）。 */
export interface StyleRadarTarget {
  readonly chapterLabel: string | null
  /** 压力级 1–5；null = 无定位真源。 */
  readonly pressureLevel: number | null
  /** 情绪强度 1–10；null = 无定位真源。 */
  readonly emotionIntensity: number | null
}

/** 只读投影结果。 */
export interface StyleRadarProjection {
  /** 雷达轴（固定 6 轴顺序，缺值处 value=null）。 */
  readonly axes: readonly StyleRadarAxis[]
  /** 有值的轴数量（画多边形用）。 */
  readonly usableAxisCount: number
  /** 目标节奏（不同量纲）。 */
  readonly target: StyleRadarTarget
  /** 目标风格文本维度（无数值，不进半径）。 */
  readonly targetStyleText: readonly { readonly label: string; readonly value: string }[]
  /** 机械层均分（0–100）；无正文 → null。 */
  readonly overall: number | null
  readonly missingSources: readonly string[]
  readonly notApplicable: readonly { readonly id: string; readonly label: string; readonly reason: string }[]
}

export interface StyleRadarInput {
  /** 当前章正文；空/缺失 → 全轴 N/A（不画 0 分雷达）。 */
  readonly text?: string | null
  /** 卷纲定位（可选）：压力级/情绪强度。 */
  readonly target?: {
    readonly chapterLabel?: string | null
    readonly pressureLevel?: number | null
    readonly emotionIntensity?: number | null
  } | null
  /** 目标风格文本维度（来自 `BookStyleProfile` 的九个自由文本维，只展示不画轴）。 */
  readonly targetStyle?: {
    readonly narrativeVoice?: string | null
    readonly dialogueStyle?: string | null
    readonly sentenceStyle?: string | null
    readonly emotionRendering?: string | null
    readonly narrativeDensity?: string | null
    readonly descriptionWeight?: string | null
    readonly rhetoricDensity?: string | null
    readonly transitionStyle?: string | null
    readonly thematicHabits?: string | null
  } | null
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** 0–100 归一（打分器已在该区间，这里只做防御性钳制，不改语义）。 */
function clampScore(value: unknown): number | null {
  const n = finiteOrNull(value)
  if (n === null) return null
  return Math.max(0, Math.min(100, n))
}

function clampRange(value: unknown, min: number, max: number): number | null {
  const n = finiteOrNull(value)
  if (n === null) return null
  return n >= min && n <= max ? n : null
}

const TARGET_STYLE_LABELS: Record<string, string> = {
  narrativeVoice: "叙事视角",
  dialogueStyle: "对白风格",
  sentenceStyle: "句式特征",
  emotionRendering: "情绪呈现",
  narrativeDensity: "叙事密度",
  descriptionWeight: "描写比重",
  rhetoricDensity: "修辞密度",
  transitionStyle: "转场风格",
  thematicHabits: "主题习惯",
}

/** 九个自由文本维的固定顺序（渲染顺序稳定）。 */
const TARGET_STYLE_KEYS = [
  "narrativeVoice",
  "dialogueStyle",
  "sentenceStyle",
  "emotionRendering",
  "narrativeDensity",
  "descriptionWeight",
  "rhetoricDensity",
  "transitionStyle",
  "thematicHabits",
] as const

/**
 * 投影某章的风格/节奏雷达。
 *
 * `text` 为空 → 六轴全 `null` 且 `missingSources` 指出缺正文（**不**返回 0 分）。
 */
export function projectStyleRadar(input: StyleRadarInput = {}): StyleRadarProjection {
  const text = typeof input.text === "string" ? input.text : ""
  const hasText = text.trim().length > 0

  const missingSources: string[] = []
  let axes: StyleRadarAxis[] = DIMENSION_KEYS.map((key) => ({
    key,
    label: DIMENSION_LABELS[key],
    value: null,
  }))
  let overall: number | null = null

  if (hasText) {
    // 只用同步机械层（`assessChapter` 是 async 且需要 LLM 注入；投影必须保持纯同步）。
    const signals = extractSignals(text)
    const scored = DIMENSION_KEYS.map((key) => assessDimension(key, signals))
    axes = scored.map((item) => ({
      key: item.key,
      label: item.label,
      value: clampScore(item.score),
    }))
    overall = scored.length === 0 ? null : clampScore(scored.reduce((sum, i) => sum + i.score, 0) / scored.length)
    missingSources.push(
      "LLM 评估器未注入 → 仅机械代理层（degraded）。这是设计如此，不是失败；面板不会把它写成「已评审」。",
    )
  } else {
    missingSources.push("章节正文（没有正文就无法计算任何代理指标；不画 0 分雷达）")
  }

  const target: StyleRadarTarget = {
    chapterLabel:
      typeof input.target?.chapterLabel === "string" && input.target.chapterLabel
        ? input.target.chapterLabel
        : null,
    // 卷纲契约是压力级 1–5 / 情绪 1–10：越界值不当真，落 null（N/A），不照画。
    pressureLevel: clampRange(input.target?.pressureLevel, 1, 5),
    emotionIntensity: clampRange(input.target?.emotionIntensity, 1, 10),
  }
  if (target.pressureLevel === null && target.emotionIntensity === null) {
    missingSources.push("章纲定位子弹（`- 压力级：…` / `- 情绪强度：…`）—— 未读到目标节奏，本面 N/A")
  }

  const targetStyleText: { label: string; value: string }[] = []
  const style = input.targetStyle
  if (style) {
    for (const key of TARGET_STYLE_KEYS) {
      const raw = style[key]
      if (typeof raw === "string" && raw.trim()) {
        targetStyleText.push({ label: TARGET_STYLE_LABELS[key] ?? key, value: raw.trim() })
      }
    }
  }
  if (targetStyleText.length === 0) {
    missingSources.push("目标风格文本（`BookStyleProfile` 未选定作品库风格画像）")
  }

  return {
    axes,
    usableAxisCount: axes.filter((axis) => axis.value !== null).length,
    target,
    targetStyleText,
    overall,
    missingSources,
    notApplicable: STYLE_RADAR_NOT_APPLICABLE.map((item) => ({ ...item })),
  }
}

/** 装载器签名：从项目读当前章正文 + 定位（真实实现由面板注入）。 */
export type StyleRadarLoader = (projectPath: string) => Promise<StyleRadarInput | null>

/**
 * 把轴映射成 SVG 多边形顶点（纯几何，便于单测）。
 *
 * **`value === null` 的轴不产生顶点**——把缺值画到圆心就等同把缺失画成 0 分。
 * 因此本函数只返回有值轴的顶点（顺序保持原轴序），调用方应据此判断能否成多边形。
 *
 * @param axes 轴（null 值的轴会被跳过）
 * @param radius 外接圆半径（像素）
 * @param center 圆心
 */
export function radarPoints(
  axes: readonly StyleRadarAxis[],
  radius: number,
  center: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number }[] {
  const n = axes.length
  if (n === 0) return []
  const points: { x: number; y: number }[] = []
  for (let i = 0; i < n; i += 1) {
    const axis = axes[i]!
    if (axis.value === null) continue
    // 从 12 点方向顺时针分布（角度仍按**原始轴位**算，缺值不会挤动其余顶点）。
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2
    const ratio = Math.max(0, Math.min(100, axis.value)) / 100
    points.push({
      x: center.x + Math.cos(angle) * radius * ratio,
      y: center.y + Math.sin(angle) * radius * ratio,
    })
  }
  return points
}

/** 顶点 → SVG `points` 属性字符串（保留 2 位小数，便于稳定快照）。 */
export function toPointsAttr(points: readonly { x: number; y: number }[]): string {
  return points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ")
}
