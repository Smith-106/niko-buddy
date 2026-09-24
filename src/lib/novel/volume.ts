import { searchWiki } from "@/lib/search"
import { logger } from "@/lib/utils"
import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { parseFrontmatter } from "@/lib/frontmatter"

/**
 * 卷册元数据结构。
 * MIT licensed implementation.
 */
export interface VolumeMeta {
  volumeNumber: number
  title: string
  summary: string
  chapterRangeStart: number | undefined
  chapterRangeEnd: number | undefined
}

/**
 * 从 Frontmatter 对象解析卷册元数据。
 * MIT licensed implementation.
 *
 * @param fm - frontmatter 键值对对象
 * @returns VolumeMeta 或 null（无效数据）
 */
export function parseVolumeMeta(fm: Record<string, unknown>): VolumeMeta | null {
  const rawVolumeNumber = fm.volume_number
  const volumeNumber = typeof rawVolumeNumber === "string" ? Number(rawVolumeNumber) : typeof rawVolumeNumber === "number" ? rawVolumeNumber : null
  if (volumeNumber === null || !Number.isFinite(volumeNumber) || volumeNumber <= 0) return null

  return {
    volumeNumber,
    title: typeof fm.title === "string" ? fm.title : `第${volumeNumber}卷`,
    summary: typeof fm.summary === "string" ? fm.summary : "",
    chapterRangeStart: typeof fm.chapter_range_start === "number" ? fm.chapter_range_start
      : typeof fm.chapter_range_start === "string" ? Number(fm.chapter_range_start) : undefined,
    chapterRangeEnd: typeof fm.chapter_range_end === "number" ? fm.chapter_range_end
      : typeof fm.chapter_range_end === "string" ? Number(fm.chapter_range_end) : undefined,
  }
}

/**
 * 判断页面是否为卷册类型。
 * MIT licensed implementation.
 *
 * @param fm - frontmatter 键值对对象
 * @returns true 如果是卷册页面
 */
export function isVolumePage(fm: Record<string, unknown>): boolean {
  if (fm.type === "volume") return true
  if (fm.outline_type === "volume-outline") return true
  if (typeof fm.volume_number === "number" || typeof fm.volume_number === "string") {
    return true
  }
  return false
}

/**
 * 获取包含指定章节的卷册列表。
 * MIT licensed implementation.
 *
 * @param projectPath - 项目根路径
 * @param chapterNumber - 章节编号
 * @returns 包含该章节的卷册元数据列表
 */
export async function getChapterVolumes(
  projectPath: string,
  chapterNumber: number,
): Promise<VolumeMeta[]> {
  const pp = normalizePath(projectPath)
  const results: VolumeMeta[] = []
  try {
    const searchResults = await searchWiki(pp, "volume 第 卷 chapter_range")
    for (const r of searchResults) {
      try {
        const content = await readFile(r.path)
        const fm = parseFrontmatterFromMarkdown(content)
        if (!fm) continue
        const meta = parseVolumeMeta(fm)
        if (!meta) continue
        if (
          meta.chapterRangeStart !== undefined &&
          meta.chapterRangeEnd !== undefined &&
          chapterNumber >= meta.chapterRangeStart &&
          chapterNumber <= meta.chapterRangeEnd
        ) {
          results.push(meta)
        }
      } catch {
        logger.warn("volume", "silent-degrade: 降级返回空值（吞错已标记）", { line: 88 })
      }
    }
  } catch {
    logger.warn("volume", "silent-degrade: 降级返回空值（吞错已标记）", { line: 90 })
  }
  return results
}

/**
 * 从 Markdown 内容中解析 Frontmatter。
 * MIT licensed implementation.
 *
 * @param content - Markdown 文件内容
 * @returns frontmatter 键值对或 null
 */
// 收敛 canonical frontmatter 解析（arch-risk W3）——私有 regex 全字段解析
// 改委托 canonical parseFrontmatter（真 YAML parse，容错 wikilink 修复），
// 返回 Record<string, unknown> 与旧私有实现同构（调用方读 fm[key]）。
function parseFrontmatterFromMarkdown(content: string): Record<string, unknown> | null {
  const { frontmatter } = parseFrontmatter(content)
  return frontmatter as Record<string, unknown> | null
}

// ============================================================================
// 64 号实施（63 号共识 §6 缺口 15）：director volumeArc — 卷弧滚动
// ============================================================================

/**
 * 卷弧四段（与 story-simulation 的起承转合同构；卷级写作节奏）。
 */
export type ArcSegment = "起" | "承" | "转" | "合"

export const ARC_SEGMENTS: readonly ArcSegment[] = ["起", "承", "转", "合"]

/**
 * 卷弧分配：把卷的章节区间按比例映射到四段（比例缺省 2:3:3:2）。
 * 确定性纯函数：同输入同输出。区间过小（<4 章）时压缩为可用段。
 */
export function allocateVolumeArc(
  _volumeNumber: number,
  chapterRangeStart: number,
  chapterRangeEnd: number,
  ratios: Record<ArcSegment, number> = { 起: 2, 承: 3, 转: 3, 合: 2 },
): Array<{ segment: ArcSegment; startChapter: number; endChapter: number }> {
  const total = Math.max(0, chapterRangeEnd - chapterRangeStart + 1)
  if (total <= 0) return []

  const sum = ratios.起 + ratios.承 + ratios.转 + ratios.合
  const base = Math.floor(total * (ratios.起 / sum))
  const segments: number[] = [
    base,
    Math.floor(total * (ratios.承 / sum)),
    Math.floor(total * (ratios.转 / sum)),
    total - base - Math.floor(total * (ratios.承 / sum)) - Math.floor(total * (ratios.转 / sum)),
  ]

  const result: Array<{ segment: ArcSegment; startChapter: number; endChapter: number }> = []
  let cursor = chapterRangeStart
  ARC_SEGMENTS.forEach((segment, i) => {
    const count = Math.max(segments[i], 0)
    if (count === 0) return
    result.push({ segment, startChapter: cursor, endChapter: cursor + count - 1 })
    cursor += count
  })
  // 兜底：浮点取整导致的总数不足时并入末段
  if (cursor <= chapterRangeEnd && result.length > 0) {
    const last = result[result.length - 1]
    last.endChapter = chapterRangeEnd
  }
  return result
}

/** 查询章节属于卷弧哪一段；未覆盖 → null。 */
export function arcSegmentForChapter(
  allocations: Array<{ segment: ArcSegment; startChapter: number; endChapter: number }>,
  chapterNumber: number,
): ArcSegment | null {
  const hit = allocations.find(
    (a) => chapterNumber >= a.startChapter && chapterNumber <= a.endChapter,
  )
  return hit ? hit.segment : null
}

/**
 * 卷弧滚动状态机：当前卷 + 当前段。
 * advanceVolumeArc：段内章节推进 → 段末滚入下一段 → 卷末（合段结束）→
 * nextVolume。确定性：同输入同输出。
 */
export interface VolumeArcState {
  volumeNumber: number
  /** 当前弧段（卷内）。 */
  segment: ArcSegment | null
  /** 卷内已完成章节数。 */
  completedInVolume: number
  lastUpdated: string
}

export function createVolumeArcState(volumeNumber: number): VolumeArcState {
  return {
    volumeNumber,
    segment: null,
    completedInVolume: 0,
    lastUpdated: new Date().toISOString(),
  }
}

export interface VolumeArcAdvanceResult {
  state: VolumeArcState
  /** 卷内滚入新段。 */
  rolled: boolean
  /** 卷末完成 → 需要滚动到下一卷。 */
  volumeComplete: boolean
  /** 下一卷号（volumeComplete 时）。 */
  nextVolume?: number
}

/**
 * 推进一章（纯函数；now 可注入保持纯性）：
 * - 无当前段 → 进入第 1 段（起）；
 * - 段内 → completedInVolume+1；
 * - 到段末 → 滚入下一段；
 * - 合段结束 → volumeComplete。
 */
export function advanceVolumeArc(
  state: VolumeArcState,
  allocations: Array<{ segment: ArcSegment; startChapter: number; endChapter: number }>,
  opts: { now?: string } = {},
): VolumeArcAdvanceResult {
  const now = opts.now ?? new Date().toISOString()
  if (allocations.length === 0) {
    return { state: { ...state, lastUpdated: now }, rolled: false, volumeComplete: false }
  }

  if (state.segment === null) {
    return {
      state: { ...state, segment: allocations[0].segment, completedInVolume: 1, lastUpdated: now },
      rolled: true,
      volumeComplete: false,
    }
  }

  const idx = ARC_SEGMENTS.indexOf(state.segment)
  const segAlloc = allocations.find((a) => a.segment === state.segment)
  const segChapterCount = segAlloc ? segAlloc.endChapter - segAlloc.startChapter + 1 : 0
  const completedInVolume = state.completedInVolume + 1

  if (idx === ARC_SEGMENTS.length - 1 && completedInVolume >= segChapterCount) {
    // 合段结束 → 卷末
    return {
      state: { ...state, completedInVolume, lastUpdated: now },
      rolled: false,
      volumeComplete: true,
      nextVolume: state.volumeNumber + 1,
    }
  }

  const nextSegment = ARC_SEGMENTS[idx + 1]
  if (nextSegment && completedInVolume >= segChapterCount) {
    return {
      state: { ...state, segment: nextSegment, completedInVolume, lastUpdated: now },
      rolled: true,
      volumeComplete: false,
    }
  }

  return { state: { ...state, completedInVolume, lastUpdated: now }, rolled: false, volumeComplete: false }
}

// ── §GAP-89-01 收官卷自动完结判定（story-compass.ts 配套）────────────────
// advanceVolumeArc 只知道"卷末"（volumeComplete）；故事是否整书完结取决于
// 收官卷语义：final 卷写完、卷末评审与摘要齐备后系统自动完结，无需再调
// complete_book（ainovel architect-long 原文 §创建下一卷模式第 4 步）。
// 本函数纯拼装该判定：非 final 卷的 volumeComplete 只是普通续卷信号。
// 纯函数，now 无需注入（无时间字段），同输入同输出。
export interface FinaleAutoCompleteInput {
  volumeComplete: boolean
  finalVolumeDeclared: boolean
  currentVolumeNumber: number
  finalVolumeNumber?: number
}

export function checkFinaleAutoComplete(
  input: FinaleAutoCompleteInput,
): { completed: boolean; reason: string } {
  if (!input.volumeComplete) return { completed: false, reason: "" }
  if (
    input.finalVolumeDeclared &&
    input.finalVolumeNumber !== undefined &&
    input.currentVolumeNumber === input.finalVolumeNumber
  ) {
    return { completed: true, reason: `第${input.currentVolumeNumber}卷为收官卷且已写完：自动完结，无需 complete_book` }
  }
  if (input.finalVolumeDeclared) {
    return { completed: false, reason: "收官卷已宣告但当前卷末非收官卷终点：继续推进" }
  }
  return { completed: false, reason: "普通卷末：滚动进入下一卷" }
}