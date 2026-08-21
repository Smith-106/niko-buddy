/**
 * de-ai-tiered-table.ts — F-009: 去 AI 分级替换表 (112 词 3 档)
 *
 * 基于 avoid-ai-writing MIT 模式提取思路，适配中文小说叙事。
 * 保持「信号非证据」立场 (误报率 >60%)，1B 低权重仅轻提示不升压为 Anti-AI(P1) 硬门控。
 *
 * 分级:
 *   1A (高权重 62): 强 AI 信号 — 总结腔/解释腔/模板句首/机械公式/套话
 *   1B (低权重 38): 弱 AI 信号 — 装饰副词/模糊限制/机械过渡/冗余修饰
 *   3  (弱提示 12): 边缘信号 — 轻度 AI 腔/弱解释/通用模糊
 *
 * 参考资源 (MIT):
 *   - avoid-ai-writing: https://github.com/hylarucoder/ai-flavor-remover
 *   - stop-slop: https://github.com/drm-collab/stop-slop
 *   - de-ai-rules.ts CHINESE_NOVEL_DE_AI_RULES (已验证中文词库)
 *   - mechanical-slop-detector.ts TIER1/2/3 词库
 */

/** 3 档分级: 1A 高权重 / 1B 低权重 / 3 弱提示 */
export type TieredDeAiTier = "1A" | "1B" | "3"

/** 分类标签 (7 类 + 补充) */
export type TieredDeAiCategory =
  | "总结腔"
  | "解释腔"
  | "模板句首"
  | "空洞形容"
  | "转折滥用"
  | "AI特征词"
  | "套话"
  | "机械句式"
  | "叙事缺陷"
  | "冗余"
  | "装饰副词"
  | "模糊限制"
  | "节奏拖沓"
  | "机械过渡"
  | "平淡动作"
  | "冗余修饰"
  | "解释腔弱化"
  | "轻度AI腔"
  | "弱解释"
  | "通用模糊"

/** 分级表条目 */
export interface TieredDeAiEntry {
  /** 匹配词/短语 */
  term: string
  /** 3 档分级: 1A 高 / 1B 低 / 3 弱 */
  tier: TieredDeAiTier
  /** 分类标签 */
  category: TieredDeAiCategory
  /** 权重 0-1 (1A 默认 0.8-1.0, 1B 默认 0.3-0.5, 3 默认 0.1-0.2) */
  weight: number
  /** 改写建议 */
  suggestion: string
}

/**
 * TIERED_DEAI_TABLE — 112 词 3 档分级替换表。
 *
 * 保持「信号非证据」立场: 1A 高权重提供强信号但非硬门控,
 * 1B 低权重仅轻提示, 3 弱提示供参考不阻断。
 *
 * 总数: 62 (1A) + 38 (1B) + 12 (3) = 112
 */
export const TIERED_DEAI_TABLE: readonly TieredDeAiEntry[] = [
  // ============================================================================
  // 1A 高权重 (62) — 强 AI 信号: 总结腔/解释腔/模板句首/机械公式/套话
  // ============================================================================
  // ── 总结腔 (13) ──
  { term: "这一切", tier: "1A", category: "总结腔", weight: 1.0, suggestion: "删掉或改为具体所指" },
  { term: "显然", tier: "1A", category: "总结腔", weight: 1.0, suggestion: "删掉，让事实自己说话" },
  { term: "事实上", tier: "1A", category: "总结腔", weight: 0.9, suggestion: "删掉，直接陈述" },
  { term: "实际上", tier: "1A", category: "总结腔", weight: 0.9, suggestion: "删掉，直接陈述" },
  { term: "毫无疑问", tier: "1A", category: "总结腔", weight: 1.0, suggestion: "删掉，用具体情节替代" },
  { term: "无可否认", tier: "1A", category: "总结腔", weight: 1.0, suggestion: "删掉，信任读者判断" },
  { term: "综上所述", tier: "1A", category: "总结腔", weight: 1.0, suggestion: "小说中禁用，直接推进" },
  { term: "总而言之", tier: "1A", category: "总结腔", weight: 1.0, suggestion: "小说中禁用，直接推进" },
  { term: "值得一提的是", tier: "1A", category: "总结腔", weight: 0.9, suggestion: "删掉，信息自然嵌入叙事" },
  { term: "不难发现", tier: "1A", category: "总结腔", weight: 0.9, suggestion: "删掉，直接呈现" },
  { term: "显而易见", tier: "1A", category: "总结腔", weight: 1.0, suggestion: "删掉，让描写替代结论" },
  { term: "众所周知", tier: "1A", category: "总结腔", weight: 0.9, suggestion: "删掉，小说世界不需要外提示" },
  { term: "不可否认", tier: "1A", category: "总结腔", weight: 0.9, suggestion: "删掉，直接推进叙事" },
  // ── 解释腔 (9) ──
  { term: "其实", tier: "1A", category: "解释腔", weight: 0.8, suggestion: "删掉，信任读者理解" },
  { term: "说白了", tier: "1A", category: "解释腔", weight: 0.9, suggestion: "删掉，直接说" },
  { term: "换句话说", tier: "1A", category: "解释腔", weight: 0.9, suggestion: "删掉，只保留一种表达" },
  { term: "简单来说", tier: "1A", category: "解释腔", weight: 0.9, suggestion: "删掉，直接说" },
  { term: "通俗点讲", tier: "1A", category: "解释腔", weight: 0.9, suggestion: "删掉，保持叙事统一" },
  { term: "也就是", tier: "1A", category: "解释腔", weight: 0.8, suggestion: "替换为'即'或直接删" },
  { term: "也就是说", tier: "1A", category: "解释腔", weight: 0.8, suggestion: "删掉，不重复解释" },
  { term: "本质上", tier: "1A", category: "解释腔", weight: 0.8, suggestion: "删掉，用叙事呈现本质" },
  { term: "从根本上说", tier: "1A", category: "解释腔", weight: 0.9, suggestion: "删掉，直接推进" },
  // ── 模板句首 (5) ──
  { term: "与此同时", tier: "1A", category: "模板句首", weight: 0.8, suggestion: "每章 ≤1 次，换'同时'或直接续写" },
  { term: "紧接着", tier: "1A", category: "模板句首", weight: 0.8, suggestion: "删掉，动作直接衔接" },
  { term: "就在这时", tier: "1A", category: "模板句首", weight: 0.8, suggestion: "每章 ≤1 次，换具体时间提示" },
  { term: "恰在此时", tier: "1A", category: "模板句首", weight: 0.8, suggestion: "删掉，直接写事件" },
  { term: "正当此刻", tier: "1A", category: "模板句首", weight: 0.8, suggestion: "删掉，直接写事件" },
  // ── 空洞形容 (5) ──
  { term: "复杂", tier: "1A", category: "空洞形容", weight: 0.7, suggestion: "用具体细节替代'复杂'" },
  { term: "微妙", tier: "1A", category: "空洞形容", weight: 0.7, suggestion: "用具体动作/环境替代" },
  { term: "深刻", tier: "1A", category: "空洞形容", weight: 0.7, suggestion: "删掉，用具体描写呈现" },
  { term: "独特", tier: "1A", category: "空洞形容", weight: 0.7, suggestion: "用具体特征替代'独特'" },
  { term: "特殊", tier: "1A", category: "空洞形容", weight: 0.7, suggestion: "用具体细节替代'特殊'" },
  // ── 转折滥用 (4) ──
  { term: "然而", tier: "1A", category: "转折滥用", weight: 0.7, suggestion: "一段内不超过 1 个转折" },
  { term: "但是", tier: "1A", category: "转折滥用", weight: 0.6, suggestion: "一段内不超过 1 个'但是'" },
  { term: "不过", tier: "1A", category: "转折滥用", weight: 0.6, suggestion: "一段内不超过 1 个转折" },
  { term: "可是", tier: "1A", category: "转折滥用", weight: 0.6, suggestion: "一段内不超过 1 个转折" },
  // ── AI 特征词 (5) ──
  { term: "似乎", tier: "1A", category: "AI特征词", weight: 0.7, suggestion: "合理语境保留，过度使用(≥3次/段)删" },
  { term: "仿佛", tier: "1A", category: "AI特征词", weight: 0.7, suggestion: "合理语境保留，过度使用(≥3次/段)删" },
  { term: "如同", tier: "1A", category: "AI特征词", weight: 0.7, suggestion: "换'像'或直接描写" },
  { term: "宛如", tier: "1A", category: "AI特征词", weight: 0.7, suggestion: "每章 ≤2 次，换'像'或直接描写" },
  { term: "犹如", tier: "1A", category: "AI特征词", weight: 0.7, suggestion: "每章 ≤2 次，换'像'或直接描写" },
  // ── 套话 (5) ──
  { term: "值得注意的是", tier: "1A", category: "套话", weight: 0.9, suggestion: "小说中禁用，信息自然嵌入" },
  { term: "需要指出的是", tier: "1A", category: "套话", weight: 0.9, suggestion: "小说中禁用，直接呈现" },
  { term: "毋庸置疑", tier: "1A", category: "套话", weight: 1.0, suggestion: "删掉，信任读者" },
  { term: "不言而喻", tier: "1A", category: "套话", weight: 1.0, suggestion: "删掉，信任读者" },
  { term: "在某种程度上", tier: "1A", category: "套话", weight: 0.8, suggestion: "删掉，直接陈述" },
  // ── 机械句式 (6) ──
  { term: "目光交汇的瞬间", tier: "1A", category: "机械句式", weight: 0.9, suggestion: "换具体动作描写" },
  { term: "空气仿佛凝固", tier: "1A", category: "机械句式", weight: 0.9, suggestion: "换具体感官细节" },
  { term: "心中五味杂陈", tier: "1A", category: "机械句式", weight: 0.9, suggestion: "用动作/对白替代情绪总结" },
  { term: "眼神变得坚定", tier: "1A", category: "机械句式", weight: 0.9, suggestion: "用行动展示坚定" },
  { term: "时间一分一秒过去", tier: "1A", category: "机械句式", weight: 0.8, suggestion: "删掉，直接写结果" },
  { term: "双方陷入僵持", tier: "1A", category: "机械句式", weight: 0.8, suggestion: "用具体对峙细节替代" },
  // ── 叙事缺陷 (5) ──
  { term: "他这么做是因为", tier: "1A", category: "叙事缺陷", weight: 0.9, suggestion: "删掉解释，信任读者" },
  { term: "她感到失望", tier: "1A", category: "叙事缺陷", weight: 0.8, suggestion: "用动作/对白表现失望" },
  { term: "她感到欣慰", tier: "1A", category: "叙事缺陷", weight: 0.8, suggestion: "用动作/对白表现欣慰" },
  { term: "百感交集", tier: "1A", category: "叙事缺陷", weight: 0.8, suggestion: "用具体细节替代情绪总结" },
  { term: "情绪复杂", tier: "1A", category: "叙事缺陷", weight: 0.8, suggestion: "用动作/对白呈现情绪" },
  // ── 冗余 (5) ──
  { term: "多维度", tier: "1A", category: "冗余", weight: 0.8, suggestion: "用具体层面替代'维度'" },
  { term: "深层次", tier: "1A", category: "冗余", weight: 0.8, suggestion: "删掉，直接呈现" },
  { term: "淋漓尽致", tier: "1A", category: "冗余", weight: 0.8, suggestion: "用具体描写替代" },
  { term: "彰显", tier: "1A", category: "冗余", weight: 0.8, suggestion: "换'显出'或'体现'" },
  { term: "令人印象深刻", tier: "1A", category: "冗余", weight: 0.9, suggestion: "用具体细节让读者自己判断" },

  // ============================================================================
  // 1B 低权重 (38) — 弱 AI 信号: 装饰副词/模糊限制/机械过渡/冗余修饰/解释腔弱化
  // ============================================================================
  // ── 装饰副词 (8) ──
  { term: "缓缓", tier: "1B", category: "装饰副词", weight: 0.4, suggestion: "非必要即删，保留风格用法" },
  { term: "慢慢", tier: "1B", category: "装饰副词", weight: 0.3, suggestion: "非必要即删，保留风格用法" },
  { term: "轻轻", tier: "1B", category: "装饰副词", weight: 0.3, suggestion: "非必要即删，保留风格用法" },
  { term: "默默", tier: "1B", category: "装饰副词", weight: 0.4, suggestion: "非必要即删，保留风格用法" },
  { term: "微微", tier: "1B", category: "装饰副词", weight: 0.3, suggestion: "非必要即删，保留风格用法" },
  { term: "悄悄", tier: "1B", category: "装饰副词", weight: 0.3, suggestion: "非必要即删，保留风格用法" },
  { term: "渐渐", tier: "1B", category: "装饰副词", weight: 0.3, suggestion: "非必要即删，保留风格用法" },
  { term: "逐渐", tier: "1B", category: "装饰副词", weight: 0.3, suggestion: "非必要即删，保留风格用法" },
  // ── 模糊限制 (6) ──
  { term: "有点", tier: "1B", category: "模糊限制", weight: 0.4, suggestion: "换具体程度或删" },
  { term: "有些", tier: "1B", category: "模糊限制", weight: 0.4, suggestion: "换具体程度或删" },
  { term: "大概", tier: "1B", category: "模糊限制", weight: 0.3, suggestion: "合理语境保留，过度使用删" },
  { term: "或许", tier: "1B", category: "模糊限制", weight: 0.3, suggestion: "合理语境保留，过度使用删" },
  { term: "可能", tier: "1B", category: "模糊限制", weight: 0.3, suggestion: "合理语境保留，过度使用删" },
  // ── 冗余修饰 (5) ──
  { term: "非常", tier: "1B", category: "冗余修饰", weight: 0.3, suggestion: "用具体程度替代或删" },
  { term: "十分", tier: "1B", category: "冗余修饰", weight: 0.3, suggestion: "用具体程度替代或删" },
  { term: "特别", tier: "1B", category: "冗余修饰", weight: 0.3, suggestion: "用具体程度替代或删" },
  { term: "相当", tier: "1B", category: "冗余修饰", weight: 0.3, suggestion: "用具体程度替代或删" },
  { term: "极其", tier: "1B", category: "冗余修饰", weight: 0.3, suggestion: "用具体程度替代或删" },
  // ── 节奏拖沓 (5) ──
  { term: "过了一会儿", tier: "1B", category: "节奏拖沓", weight: 0.4, suggestion: "直接写时间点或删" },
  { term: "过了片刻", tier: "1B", category: "节奏拖沓", weight: 0.4, suggestion: "直接写时间点或删" },
  { term: "不知过了多久", tier: "1B", category: "节奏拖沓", weight: 0.4, suggestion: "每章 ≤1 次，保留悬念用法" },
  { term: "良久", tier: "1B", category: "节奏拖沓", weight: 0.3, suggestion: "合理语境保留，过度使用删" },
  { term: "片刻之后", tier: "1B", category: "节奏拖沓", weight: 0.3, suggestion: "直接写时间点或删" },
  // ── 机械过渡 (5) ──
  { term: "然后", tier: "1B", category: "机械过渡", weight: 0.3, suggestion: "一段内不超过 1 次" },
  { term: "接着", tier: "1B", category: "机械过渡", weight: 0.3, suggestion: "一段内不超过 1 次" },
  { term: "随后", tier: "1B", category: "机械过渡", weight: 0.3, suggestion: "一段内不超过 1 次" },
  { term: "之后", tier: "1B", category: "机械过渡", weight: 0.3, suggestion: "直接写结果或删" },
  { term: "接下来", tier: "1B", category: "机械过渡", weight: 0.3, suggestion: "直接写结果或删" },
  // ── 平淡动作 (4) ──
  { term: "点了点头", tier: "1B", category: "平淡动作", weight: 0.4, suggestion: "用具体动作或对白替代" },
  { term: "摇了摇头", tier: "1B", category: "平淡动作", weight: 0.4, suggestion: "用具体动作或对白替代" },
  { term: "抬起头", tier: "1B", category: "平淡动作", weight: 0.3, suggestion: "保留必要用法，过度使用删" },
  { term: "低下头", tier: "1B", category: "平淡动作", weight: 0.3, suggestion: "保留必要用法，过度使用删" },
  // ── 解释腔弱化 (5) ──
  { term: "毕竟", tier: "1B", category: "解释腔弱化", weight: 0.4, suggestion: "合理语境保留，过度使用删" },
  { term: "终究", tier: "1B", category: "解释腔弱化", weight: 0.4, suggestion: "合理语境保留，过度使用删" },
  { term: "说到底", tier: "1B", category: "解释腔弱化", weight: 0.4, suggestion: "删掉，直接陈述" },
  { term: "索性", tier: "1B", category: "解释腔弱化", weight: 0.3, suggestion: "合理语境保留，过度使用删" },
  { term: "好歹", tier: "1B", category: "解释腔弱化", weight: 0.3, suggestion: "合理语境保留，过度使用删" },
  { term: "姑且", tier: "1B", category: "解释腔弱化", weight: 0.3, suggestion: "合理语境保留，过度使用删" },

  // ============================================================================
  // 3 弱提示 (12) — 边缘信号: 轻度 AI 腔/弱解释/通用模糊
  // ============================================================================
  // ── 轻度 AI 腔 (4) ──
  { term: "不禁", tier: "3", category: "轻度AI腔", weight: 0.2, suggestion: "合理语境保留，过频(≥3次/章)删" },
  { term: "不由", tier: "3", category: "轻度AI腔", weight: 0.2, suggestion: "合理语境保留，过频(≥3次/章)删" },
  { term: "忍不住", tier: "3", category: "轻度AI腔", weight: 0.2, suggestion: "合理语境保留，过频(≥3次/章)删" },
  { term: "下意识", tier: "3", category: "轻度AI腔", weight: 0.2, suggestion: "合理语境保留，过频(≥3次/章)删" },
  // ── 弱解释 (4) ──
  { term: "可以说", tier: "3", category: "弱解释", weight: 0.2, suggestion: "删掉或少用，直接陈述" },
  { term: "某种意义上", tier: "3", category: "弱解释", weight: 0.2, suggestion: "删掉，直接陈述" },
  { term: "某种程度上", tier: "3", category: "弱解释", weight: 0.2, suggestion: "删掉，直接陈述" },
  { term: "某种意义上说", tier: "3", category: "弱解释", weight: 0.2, suggestion: "删掉，直接陈述" },
  // ── 通用模糊 (4) ──
  { term: "某种", tier: "3", category: "通用模糊", weight: 0.1, suggestion: "用具体名词替代'某种'" },
  { term: "某种程度", tier: "3", category: "通用模糊", weight: 0.1, suggestion: "用具体程度替代" },
  { term: "某种意义", tier: "3", category: "通用模糊", weight: 0.1, suggestion: "用具体所指替代" },
  { term: "感觉", tier: "3", category: "通用模糊", weight: 0.1, suggestion: "用感官动词替代'感觉'" },
] as const

// ============================================================================
// 辅助函数
// ============================================================================

/** 按 tier 分组统计 */
export function groupTieredDeAiByTier(): Record<TieredDeAiTier, readonly TieredDeAiEntry[]> {
  const groups: Record<TieredDeAiTier, TieredDeAiEntry[]> = { "1A": [], "1B": [], "3": [] }
  for (const entry of TIERED_DEAI_TABLE) {
    groups[entry.tier].push(entry)
  }
  return groups as Record<TieredDeAiTier, readonly TieredDeAiEntry[]>
}

/** 按 category 分组统计 */
export function groupTieredDeAiByCategory(): Record<TieredDeAiCategory, readonly TieredDeAiEntry[]> {
  const groups = {} as Record<TieredDeAiCategory, TieredDeAiEntry[]>
  for (const entry of TIERED_DEAI_TABLE) {
    if (!groups[entry.category]) groups[entry.category] = []
    groups[entry.category].push(entry)
  }
  return groups as Record<TieredDeAiCategory, readonly TieredDeAiEntry[]>
}

/** 分级表统计信息 */
export interface TieredDeAiStats {
  totalEntries: number
  tierCounts: Record<TieredDeAiTier, number>
  categoryCounts: Record<string, number>
  uniqueTerms: number
  weightRange: { min: number; max: number }
}

/** 计算分级表统计 */
export function computeTieredDeAiStats(): TieredDeAiStats {
  const byTier = groupTieredDeAiByTier()
  const tierCounts: Record<TieredDeAiTier, number> = {
    "1A": byTier["1A"].length,
    "1B": byTier["1B"].length,
    "3": byTier["3"].length,
  }
  const byCategory = groupTieredDeAiByCategory()
  const categoryCounts: Record<string, number> = {}
  for (const [cat, entries] of Object.entries(byCategory)) {
    categoryCounts[cat] = entries.length
  }
  const terms = new Set(TIERED_DEAI_TABLE.map((e) => e.term))
  const weights = TIERED_DEAI_TABLE.map((e) => e.weight)
  return {
    totalEntries: TIERED_DEAI_TABLE.length,
    tierCounts,
    categoryCounts,
    uniqueTerms: terms.size,
    weightRange: { min: Math.min(...weights), max: Math.max(...weights) },
  }
}

/** 在文本中检测分级表命中 */
export interface TieredDeAiHit {
  entry: TieredDeAiEntry
  count: number
}

/** 在文本中检测所有分级表命中 */
export function detectTieredDeAi(text: string): TieredDeAiHit[] {
  if (!text) return []
  const hits: TieredDeAiHit[] = []
  for (const entry of TIERED_DEAI_TABLE) {
    let count = 0
    let idx = text.indexOf(entry.term)
    while (idx !== -1) {
      count++
      idx = text.indexOf(entry.term, idx + entry.term.length)
    }
    if (count > 0) {
      hits.push({ entry, count })
    }
  }
  return hits
}

/** 按 tier 过滤检测结果 */
export function filterTieredDeAiHitsByTier(
  hits: TieredDeAiHit[],
  tier: TieredDeAiTier,
): TieredDeAiHit[] {
  return hits.filter((h) => h.entry.tier === tier)
}