/**
 * P14 风格画像辅助层 (S5 Optional Sidecar)。
 *
 * 把 BookStyleProfile 作为 sidecar 辅助输入渲染为 compressible-tier
 * 提示块文本。本模块只产注入文本，不接管主链写入——由 context-engine
 * 决定是否注入 compressible tier。无 styleProfile 时返回 ""。
 *
 * 边界契约：sidecar 仅辅助层，不触碰 status.json / draft-first / 门控
 * 主链真源，也不修改 context-engine.ts / task-router.ts。
 */
import type { BookStyleProfile } from "./book-analysis/types"
import { loadStyleProfile } from "./book-analysis/result-loader"

export interface StyleProfileSidecarInput {
  /** 启用的风格画像（从作品库选定），undefined 时 sidecar 不注入。 */
  styleProfile?: BookStyleProfile
  /** 源作品名（provenance）。 */
  sourceBook?: string
}

/** samples 取前 2 段，避免 sidecar 文本过长侵占 compressible tier 预算。 */
const MAX_SAMPLES = 2

/**
 * 渲染风格画像为 compressible-tier 辅助提示块。
 *
 * 不接管主链写入——只产出注入文本，由 context-engine 决定是否注入
 * compressible tier。无 styleProfile 时返回 ""（caller 可无条件 concat）。
 */
export function renderStyleProfileSidecar(input: StyleProfileSidecarInput): string {
  const profile = input?.styleProfile
  if (!profile) return ""

  const lines: string[] = ["# 风格画像辅助 (P14 sidecar)"]

  if (input.sourceBook) {
    lines.push(`源作品：${input.sourceBook}`)
  }

  // 风格宪法：注入用硬约束（load-bearing），完整保留。
  if (profile.constitution && profile.constitution.trim()) {
    lines.push("")
    lines.push("## 风格宪法（硬约束）")
    lines.push(profile.constitution.trim())
  }

  // 关键维度：narrativeVoice / dialogueStyle / sentenceStyle。
  const dimensions: Array<[string, string]> = [
    ["叙事视角", profile.narrativeVoice],
    ["对白风格", profile.dialogueStyle],
    ["句式特征", profile.sentenceStyle],
  ]
  const dimensionLines = dimensions.filter(([, v]) => v && v.trim())
  if (dimensionLines.length > 0) {
    lines.push("")
    lines.push("## 关键维度")
    for (const [label, value] of dimensionLines) {
      lines.push(`- ${label}：${value!.trim()}`)
    }
  }

  // few-shot 模仿锚点：取前 2 段，避免过长。
  const samples = (profile.samples ?? []).filter((s) => s && s.trim()).slice(0, MAX_SAMPLES)
  if (samples.length > 0) {
    lines.push("")
    lines.push("## 模仿锚点（few-shot）")
    for (const sample of samples) {
      lines.push("")
      lines.push("```")
      lines.push(sample.trim())
      lines.push("```")
    }
  }

  return lines.join("\n")
}

/**
 * 从作品库路径加载启用的风格画像作为 sidecar 输入。
 *
 * bookPath undefined 或加载失败（含文件不存在）返回 `{}`（空 input，
 * sidecar 不注入）。sidecar 可选，不阻塞主链——任何失败都非阻断降级。
 */
export async function loadStyleProfileSidecar(
  bookPath: string | undefined,
): Promise<StyleProfileSidecarInput> {
  if (!bookPath) return {}
  try {
    const profile = await loadStyleProfile(bookPath)
    if (!profile) return {}
    return { styleProfile: profile, sourceBook: deriveSourceBook(bookPath) }
  } catch {
    // sidecar 可选：任何加载失败非阻断降级为空 input，不阻塞主链。
    return {}
  }
}

/**
 * 从 bookPath 推导源作品名作为 provenance 标注。
 * bookPath 形如 .../book-analysis/{bookId}，取末段为 bookId；无可靠标题
 * 来源时退化为 bookId（sidecar provenance 仅为可读标注，非真源）。
 */
function deriveSourceBook(bookPath: string): string {
  const trimmed = bookPath.replace(/[\\/]+$/, "")
  const segments = trimmed.split(/[\\/]/)
  return segments[segments.length - 1] || bookPath
}
