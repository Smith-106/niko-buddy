/**
 * 55 号设计覆盖度 100% (M-nos-2): 编辑影响分析 — 事前冲击面 (Novel-OS 模式借鉴, MIT 只借模式)。
 *
 * 编辑某实体/章节前, 计算会受影响的章节列表 (引用关系 = canon episode 的
 * entity_id / reference_time 结构化列)。零 LLM 纯函数, 确定性可测。
 * 与 canon 双写对账 (事后 diff) 互补: 本模块是事前冲击面。
 */

export type EditImpactTarget =
  | { kind: "entity"; id: string }
  | { kind: "chapter"; number: number }

export interface EditImpactEpisode {
  id: string
  chapter_number: number
  entity_id: string
  reference_time?: number | null
}

export interface EditImpactResult {
  /** 受影响章节号 (去重升序) */
  affectedChapters: number[]
  /** 受影响 episode id 列表 */
  affectedEpisodes: string[]
  /** 直接命中 (目标自身所在章节) */
  directChapters: number[]
  /** 间接命中 (引用目标的章节) */
  indirectChapters: number[]
}

/**
 * 计算编辑影响面: 目标实体 → 所有以该实体为 POV 的章节;
 * 目标章节 → 引用该章节时间点的章节 (reference_time 指向)。
 * 无引用 → 空数组 (零开销路径)。
 */
export function computeEditImpact(
  episodes: readonly EditImpactEpisode[],
  target: EditImpactTarget,
): EditImpactResult {
  const direct = new Set<number>()
  const indirect = new Set<number>()
  const affectedEpisodes: string[] = []

  // 第一遍: 直接命中 (entity → POV 章节; chapter → 自身)
  for (const ep of episodes) {
    if (target.kind === "entity") {
      if (ep.entity_id === target.id) {
        direct.add(ep.chapter_number)
        affectedEpisodes.push(ep.id)
      }
    } else if (ep.chapter_number === target.number) {
      direct.add(ep.chapter_number)
      affectedEpisodes.push(ep.id)
    }
  }

  // 第二遍: 间接命中 (reference_time 指向目标; entity 目标 = 指向其 POV 章节,
  // chapter 目标 = 等于目标章号; 已在 direct 的章节不重复计)
  for (const ep of episodes) {
    const pointsAtTarget =
      target.kind === "chapter"
        ? ep.reference_time === target.number
        : ep.reference_time != null && direct.has(ep.reference_time)
    if (pointsAtTarget && !direct.has(ep.chapter_number)) {
      indirect.add(ep.chapter_number)
      affectedEpisodes.push(ep.id)
    }
  }

  const affectedChapters = [...new Set([...direct, ...indirect])].sort((a, b) => a - b)
  // affectedEpisodes 保持输入顺序 (去重)
  const seen = new Set(affectedEpisodes)
  const orderedEpisodes = episodes.filter((ep) => seen.has(ep.id)).map((ep) => ep.id)
  return {
    affectedChapters,
    affectedEpisodes: orderedEpisodes,
    directChapters: [...direct].sort((a, b) => a - b),
    indirectChapters: [...indirect].sort((a, b) => a - b),
  }
}
