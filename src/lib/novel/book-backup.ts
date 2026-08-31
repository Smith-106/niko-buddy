/**
 * R-allrepo-3 (29 全仓吸收落地): BookBackup — 全书备份快照与 pre-restore 校验.
 *
 * 吸收来源：累积残余 roadmap（25 号 ds value 6 / 29 号 hy3 7 P1——2/3
 * residual）——inkos book-backup 模式（全书快照+pre-restore 完整性校验+
 * 回滚污染防护）。niko 已有单章 chapter-workspace 快照，本模块补全书级。
 */

export interface BookSnapshot {
  snapshotId: string
  createdAt: string
  /** 快照基于的 status.json 版本号（用于还原时版本匹配校验）。 */
  statusVersion: string
  /** 章节文件清单（chapter → 内容摘要哈希）。 */
  chapters: Array<{ chapter: number; contentHash: string; wordCount: number }>
  /** 快照说明。 */
  note?: string
}

export function createBookSnapshot(input: {
  snapshotId: string
  statusVersion: string
  chapters: Array<{ chapter: number; contentHash: string; wordCount: number }>
  note?: string
}): BookSnapshot {
  return {
    snapshotId: input.snapshotId,
    createdAt: new Date().toISOString(),
    statusVersion: input.statusVersion,
    chapters: [...input.chapters].sort((a, b) => a.chapter - b.chapter),
    note: input.note,
  }
}

/** 快照内 chapter → hash 索引。 */
function hashIndex(snapshot: BookSnapshot): Map<number, string> {
  return new Map(snapshot.chapters.map((c) => [c.chapter, c.contentHash]))
}

export interface PreRestoreCheck {
  errors: string[]
  warnings: string[]
  /** errors 空 → 允许还原。 */
  allowed: boolean
}

/**
 * pre-restore 门禁校验（吸收 inkos book-backup pre-restore 语义）：
 * ①快照非空 ②statusVersion 匹配（不匹配 → warning 可覆盖）
 * ③当前内容与快照完全一致 → warning「无需还原」
 * ④快照完整性：章节号重复/内容哈希空 → error。
 */
export function preRestoreCheck(
  snapshot: BookSnapshot,
  current: { statusVersion: string; chapters: Array<{ chapter: number; contentHash: string }> },
): PreRestoreCheck {
  const errors: string[] = []
  const warnings: string[] = []

  if (snapshot.chapters.length === 0) {
    errors.push("快照为空（无章节记录），拒绝还原")
  }
  const seen = new Set<number>()
  for (const c of snapshot.chapters) {
    if (seen.has(c.chapter)) errors.push(`快照章节号重复：${c.chapter}`)
    seen.add(c.chapter)
    if (!c.contentHash.trim()) errors.push(`快照章节 ${c.chapter} 内容哈希为空`)
  }

  if (snapshot.statusVersion !== current.statusVersion) {
    warnings.push(`版本不匹配：快照 ${snapshot.statusVersion} vs 当前 ${current.statusVersion}（覆盖还原需显式确认）`)
  }

  const snapHashes = hashIndex(snapshot)
  const curHashes = new Map(current.chapters.map((c) => [c.chapter, c.contentHash]))
  let diffCount = 0
  for (const [chapter, hash] of snapHashes) {
    if (curHashes.get(chapter) !== hash) diffCount++
  }
  if (current.chapters.length > 0 && diffCount === 0 && current.chapters.length === snapshot.chapters.length) {
    warnings.push("当前内容与快照完全一致，还原无效果")
  }

  return { errors, warnings, allowed: errors.length === 0 }
}

/** 还原影响面报告：快照有而当前内容不同的章节（将被恢复）与当前独有章节（不受影响）。 */
export function restoreImpactReport(
  snapshot: BookSnapshot,
  current: { chapters: Array<{ chapter: number; contentHash: string }> },
): { willRestore: number[]; untouched: number[] } {
  const snapHashes = hashIndex(snapshot)
  const curHashes = new Map(current.chapters.map((c) => [c.chapter, c.contentHash]))
  const willRestore: number[] = []
  for (const [chapter, hash] of snapHashes) {
    if (curHashes.get(chapter) !== hash) willRestore.push(chapter)
  }
  const untouched: number[] = [...curHashes.keys()].filter((c) => !snapHashes.has(c))
  return { willRestore, untouched }
}
