import type { ChapterPosition } from "./chapter-positioning"

/**
 * 爽点节律检查结果。
 *
 * @param positions - 章节定位数据
 * @param totalChapters - 总章节数
 * @returns 警告列表
 */
export function checkEnjoymentRhythm(
  positions: ChapterPosition[],
  totalChapters: number,
): string[] {
  const warnings: string[] = []

  if (totalChapters === 0) return warnings

  // 每章至少1个微爽点/微好奇/期待点 → 我们检查每章是否有高潮、转折或收束之外的定位
  // 如果某章定位为"opening"或"development"且情绪强度≤3，可能缺乏爽点
  for (const pos of positions) {
    if (
      (pos.type === "opening" || pos.type === "development") &&
      pos.emotionIntensity <= 3
    ) {
      warnings.push(
        `第${pos.chapterNumber}章为${pos.type}类型且情绪强度仅${pos.emotionIntensity}，可能存在微爽点/微好奇/期待点不足`,
      )
    }
  }

  // 每3章解决1个冲突 → 检查每3章的区间内是否有高潮或转折章
  for (let i = 0; i < totalChapters; i += 3) {
    const chunk = positions.filter(
      (p) => p.chapterNumber > i && p.chapterNumber <= i + 3,
    )
    if (chunk.length > 0 && !chunk.some((p) => p.type === "climax" || p.type === "turn")) {
      warnings.push(
        `第${i + 1}-${Math.min(i + 3, totalChapters)}章区间内无高潮或转折章，建议每3章至少解决1个冲突`,
      )
    }
  }

  // 每7章1个大爽点 → 检查每7章区间内是否有高潮章
  for (let i = 0; i < totalChapters; i += 7) {
    const chunk = positions.filter(
      (p) => p.chapterNumber > i && p.chapterNumber <= i + 7,
    )
    if (chunk.length > 0 && !chunk.some((p) => p.type === "climax")) {
      warnings.push(
        `第${i + 1}-${Math.min(i + 7, totalChapters)}章区间内无高潮章，建议每7章至少安排1个大爽点`,
      )
    }
  }

  // 期待不断原则：结尾章必须有合理的钩子或高潮
  // 检查最后几章（最后3章）是否都是低强度类型
  const lastChapters = positions.slice(-3)
  if (
    lastChapters.length === 3 &&
    lastChapters.every((p) => p.type === "resolution" || p.type === "development")
  ) {
    warnings.push(
      "结尾连续3章均为收束或发展类型，缺乏期待钩子，建议在最后章节安排钩子或高潮",
    )
  }

  return warnings
}

/**
 * 八节点结构检查（卷级）。
 *
 * 检查卷纲内容是否满足以下结构要求：
 * - 开篇（5-10%）是否有钩子
 * - 1/4位置是否有激励/格局转折
 * - 中点是否有情节逆转
 * - 3/4位置是否有情节转折
 * - 结尾是否有收束+下一卷钩子
 *
 * @param volumeContent - 卷纲 Markdown 文本内容
 * @returns 警告列表
 */
export function checkEightNodeStructure(volumeContent: string): string[] {
  const warnings: string[] = []
  const text = volumeContent

  // 检查是否包含对标结构坐标表
  const hasStructureTable =
    text.includes("对标结构坐标") ||
    text.includes("结构节点") ||
    text.includes("1/4 节点")

  if (!hasStructureTable) {
    warnings.push("缺少对标结构坐标表，建议补充1/4节点、中点、3/4节点、高潮节点的章节安排")
  }

  // 检查开篇钩子：卷纲中应包含"钩子"相关描述
  const hasOpeningHook =
    text.includes("章首钩子") ||
    text.includes("钩") ||
    text.includes("悬念") ||
    text.includes("开局")

  if (!hasOpeningHook) {
    warnings.push("开篇（5-10%）缺少钩子描述，建议在卷纲中明确开篇钩子内容")
  }

  // 检查1/4位置是否有激励/格局转折
  const hasQuarterTurn =
    text.includes("1/4") ||
    text.includes("激励事件") ||
    text.includes("格局转折") ||
    text.includes("第一转折")

  if (!hasQuarterTurn) {
    warnings.push("1/4位置缺少激励/格局转折描述，建议补充")
  }

  // 检查中点是否有情节逆转
  const hasMidpoint =
    text.includes("中点") ||
    text.includes("情节逆转") ||
    text.includes("关键事件")

  if (!hasMidpoint) {
    warnings.push("中点位置缺少情节逆转描述，建议补充")
  }

  // 检查3/4位置是否有情节转折
  const hasThreeQuarterTurn =
    text.includes("3/4") ||
    text.includes("最终高潮") ||
    text.includes("推进至")

  if (!hasThreeQuarterTurn) {
    warnings.push("3/4位置缺少情节转折描述，建议补充")
  }

  // 检查结尾是否有收束+下一卷钩子
  const hasEndingClosure =
    text.includes("收束") ||
    text.includes("结尾") ||
    text.includes("卷尾")

  const hasNextVolumeHook =
    text.includes("下一卷") ||
    text.includes("伏笔") ||
    text.includes("未解决问题")

  if (!hasEndingClosure) {
    warnings.push("结尾缺少收束描述，建议补充")
  }
  if (!hasNextVolumeHook) {
    warnings.push("结尾缺少下一卷钩子，建议补充伏笔或未解决问题")
  }

  // 检查情绪弧线
  const hasEmotionArc =
    text.includes("情绪弧线") ||
    text.includes("W形") ||
    text.includes("情绪基调")

  if (!hasEmotionArc) {
    warnings.push("缺少情绪弧线描述，建议补充W形折线或其他情绪变化曲线")
  }

  // 检查爽点节奏表
  const hasEnjoymentTable =
    text.includes("爽点节奏") ||
    text.includes("爽点类型")

  if (!hasEnjoymentTable) {
    warnings.push("缺少爽点节奏表，建议补充章节区间对应的爽点安排")
  }

  return warnings
}

/**
 * 情绪弧线检查。
 *
 * 检查卷纲情绪弧线是否有起伏，是否形成W形/阶梯上升等有效形态。
 *
 * @param volumeContent - 卷纲 Markdown 文本内容
 * @returns 警告列表
 */
export function checkEmotionArc(volumeContent: string): string[] {
  const warnings: string[] = []
  const text = volumeContent

  // 检查是否有情绪弧线描述
  const hasEmotionArcSection =
    text.includes("情绪弧线") ||
    text.includes("W形") ||
    text.includes("情绪变化") ||
    text.includes("情绪基调")

  if (!hasEmotionArcSection) {
    warnings.push("缺少情绪弧线描述，无法检查情绪起伏")
    return warnings
  }

  // 检查是否包含W形描述
  const hasWShape =
    text.includes("W形") ||
    text.includes("折线") ||
    text.includes("起点") ||
    text.includes("下降") ||
    text.includes("回升")

  if (!hasWShape) {
    warnings.push("情绪弧线未明确描述W形或其他有效形态，建议补充起点→下降→回升→再降→最终回升的路径")
  }

  // 检查是否有阶梯上升描述
  const hasStaircaseRise =
    text.includes("阶梯") ||
    text.includes("上升") ||
    text.includes("递增") ||
    text.includes("逐级")

  if (!hasStaircaseRise) {
    warnings.push("未检测到明确的阶梯上升描述，建议补充情绪强度递增路径")
  }

  // 检查是否有情绪起伏的具体数值或节点
  const hasEmotionNodes =
    text.includes("情绪强度") ||
    text.includes("情绪值") ||
    text.includes("节点") ||
    text.includes("压力级")

  if (!hasEmotionNodes) {
    warnings.push("情绪弧线缺少具体数值或节点描述，建议补充各阶段的情绪强度值")
  }

  const hasPositionTable =
    text.includes("| 章 | 定位 | 压力级") ||
    text.includes("| 章 | 定位 | 情绪强度")

  if (!hasPositionTable) {
    warnings.push("缺少章节定位分布表，无法逐章追踪情绪强度变化")
  }

  return warnings
}
