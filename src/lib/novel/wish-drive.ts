/**
 * wish-drive.ts — TASK-P4-29b (T29b): 卡文引导流（wish 清单装配可见）
 *
 * 蓝图 §6 P4 T29b（F-27 / A-22.6）：
 *   卡文引导流入口——主角 wish 清单（wish/motive/ghost/arc_stage）从 canon 事实
 *   装配为可见清单，供 UI 展示与引导提示。纯函数逻辑层（UI 组件消费本模块）。
 *
 * 数据源：canon 实体技法字段（craft/canon-craft-fields.ts 的 EntityCraftFields 契约）。
 *
 * 执行纪律:
 *   - ADR-19 机械层零 LLM：纯函数，零 IO / 零 Tauri invoke。
 *   - Draft-first (ADR-08)：不写入运行时会话状态文件。
 */
import type { ArcStage } from "./craft/canon-craft-fields"

// ============================================================================
// 类型定义
// ============================================================================

/** 主角 wish 清单条目（装配产物）。 */
export interface WishDriveItem {
  /** 愿望（W-M-A 的 W）。 */
  wish: string
  /** 动机（为什么想要）。 */
  motive: string
  /** 麦基鬼魂（深层创伤，可空）。 */
  ghost: string | null
  /** 当前弧光阶段。 */
  arcStage: ArcStage | null
  /** 来源事实 digest（审计）。 */
  sourceDigest: string
}

/** 卡文引导流装配结果。 */
export interface WishDriveAssembly {
  protagonistId: string
  items: WishDriveItem[]
  /** 装配完整性（0-1：wish/motive/ghost/arc_stage 填充率）。 */
  completeness: number
  /** 缺失字段清单（引导提示用）。 */
  missing: string[]
}

/** 卡文检测结果。 */
export interface WriterBlockReport {
  blocked: boolean
  reasons: string[]
  /** 建议动作（纯文本引导，不调 LLM）。 */
  suggestions: string[]
}

/** canon 实体投影（读出口契约：不含内部句柄）。 */
export interface CanonEntityProjection {
  digest: string
  name: string
  wish?: string[]
  motive?: string[]
  mckee_ghost?: string | null
  arc_stage?: ArcStage | null
}

// ============================================================================
// wish 清单装配（纯函数）
// ============================================================================

/**
 * 从 canon 实体投影装配主角 wish 清单。
 * completeness = 四字段（wish/motive/ghost/arc_stage）填充率；
 * missing 列出未填充字段（引导提示用）。
 */
export function assembleWishList(
  protagonistId: string,
  entities: CanonEntityProjection[],
): WishDriveAssembly {
  const protagonist = entities.find((e) => e.digest === protagonistId) ?? entities[0]
  if (!protagonist) {
    return { protagonistId, items: [], completeness: 0, missing: ["wish", "motive", "ghost", "arc_stage"] }
  }
  const wish = protagonist.wish?.[0] ?? ""
  const motive = protagonist.motive?.[0] ?? ""
  const ghost = protagonist.mckee_ghost ?? null
  const arcStage = protagonist.arc_stage ?? null

  const fields: Array<[string, boolean]> = [
    ["wish", wish.length > 0],
    ["motive", motive.length > 0],
    ["ghost", ghost !== null && ghost.length > 0],
    ["arc_stage", arcStage !== null],
  ]
  const filled = fields.filter(([, ok]) => ok).length
  const missing = fields.filter(([, ok]) => !ok).map(([name]) => name)

  const items: WishDriveItem[] = wish.length > 0
    ? [{ wish, motive, ghost, arcStage, sourceDigest: protagonist.digest }]
    : []

  return {
    protagonistId,
    items,
    completeness: fields.length > 0 ? filled / fields.length : 0,
    missing,
  }
}

// ============================================================================
// 卡文检测（纯函数）
// ============================================================================

/**
 * 卡文检测：wish 清单缺失（wish/motive 空）或弧光未推进（arc_stage 缺失）→ 卡文。
 * 返回引导建议（纯文本，不调 LLM）。
 */
export function detectWriterBlock(assembly: WishDriveAssembly): WriterBlockReport {
  const reasons: string[] = []
  const suggestions: string[] = []
  if (assembly.items.length === 0) {
    reasons.push("主角 wish 清单为空（wish 未装配）")
    suggestions.push("先为主角装配 wish（想要什么）与 motive（为什么想要）")
  }
  if (assembly.missing.includes("motive")) {
    reasons.push("motive 缺失（动机未装配）")
    suggestions.push("补充主角动机：wish 与 motive 必须强制区分（A-22.1）")
  }
  if (assembly.missing.includes("ghost")) {
    reasons.push("ghost 缺失（麦基鬼魂未装配）")
    suggestions.push("补充麦基鬼魂（深层创伤），驱动弧光推进")
  }
  if (assembly.missing.includes("arc_stage")) {
    reasons.push("arc_stage 缺失（弧光阶段未装配）")
    suggestions.push("标注当前弧光阶段（ARC_STAGE_VALUES），确认推进方向")
  }
  return {
    blocked: reasons.length > 0,
    reasons,
    suggestions,
  }
}

/**
 * 构建卡文引导提示（纯函数装配；消费方决定是否送 LLM）。
 */
export function buildWishDrivePrompt(assembly: WishDriveAssembly, report: WriterBlockReport): string {
  const lines: string[] = []
  lines.push(`【卡文引导】主角 ${assembly.protagonistId} wish 清单装配度 ${(assembly.completeness * 100).toFixed(0)}%`)
  if (assembly.items.length > 0) {
    const item = assembly.items[0]
    lines.push(`- wish: ${item.wish}`)
    lines.push(`- motive: ${item.motive || "（未装配）"}`)
    lines.push(`- ghost: ${item.ghost ?? "（未装配）"}`)
    lines.push(`- arc_stage: ${item.arcStage ?? "（未装配）"}`)
  }
  if (report.blocked) {
    lines.push("卡文原因:")
    for (const r of report.reasons) lines.push(`  - ${r}`)
    lines.push("建议:")
    for (const s of report.suggestions) lines.push(`  - ${s}`)
  } else {
    lines.push("wish 清单完整，可继续推进。")
  }
  return lines.join("\n")
}
