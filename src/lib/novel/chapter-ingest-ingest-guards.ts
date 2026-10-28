/**
 * chapter-ingest (A) 波拆分第 1 步：ingestChapter 的前置解析与守卫。
 *
 * 本模块承载 `ingestChapter` 进入主流程之前的**全部早退判定**：
 *   novelMode 关闭 / LLM 配置不可用 / 非章节页 / 非终章 / 非法章号。
 *
 * 设计约束（只搬不改）：
 *   - 5 个 `failReason` 字面值与判定**顺序**零变化。调用方按顺序短路，
 *     顺序改变会让 `not_chapter` 与 `no_llm` 等分支的可观测结果互换。
 *   - `{ snapshot: null }`（novelMode 关闭，不带 failReason）与
 *     `{ snapshot: null, failReason: "..." }` 的**形状差异**是既有对外契约
 *     （behavior spec 有断言），不得统一。
 *
 * 返回 discriminated union：`ok: false` 时 `result` 已是可直接 return 的
 * `IngestResult`，调用方无需再拼装。
 */
import { readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { logger } from "@/lib/utils"
import { useWikiStore, type LlmConfig, type NovelConfig } from "@/stores/wiki-store"
import { parseFrontmatter } from "@/lib/frontmatter"
import { isChapterPage, isFinalChapter, parseChapterNumber } from "./chapter-meta"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { resolveNovelModel } from "./model-resolver"
import type { IngestChapterOptions, IngestFailReason, IngestResult } from "./chapter-ingest"

export interface IngestTargetReady {
  ok: true
  /** 归一化后的项目路径（后续所有 IO 都用它）。 */
  pp: string
  /** 运行时解析后的提取模型配置（含供应商切换）。 */
  runtimeLlmConfig: LlmConfig
  /** 原始 llmConfig（社区摘要重建需要）。 */
  llmConfig: LlmConfig
  /** 原始 novelConfig（社区摘要开关需要）。 */
  novelConfig: NovelConfig
  /** 已校验为正整数的章号。 */
  chapterNumber: number
  /** 章节正文（不含 frontmatter）。 */
  body: string
  /** 章节原始全文（embedding 需要）。 */
  content: string
  /** 解析后的 frontmatter（canon 双写与标题提取需要）。 */
  fm: Record<string, unknown>
}

export interface IngestTargetRejected {
  ok: false
  /** 可直接作为 ingestChapter 返回值。 */
  result: IngestResult
}

export type IngestTarget = IngestTargetReady | IngestTargetRejected

function reject(failReason?: IngestFailReason): IngestTargetRejected {
  return {
    ok: false,
    result: failReason === undefined
      ? { snapshot: null }
      : { snapshot: null, failReason },
  }
}

/**
 * 解析并校验摄取目标。返回 `ok: false` 时调用方直接返回 `result`。
 *
 * 判定顺序（不可调换，见模块注释）：novelMode → no_llm → not_chapter
 * → not_final → invalid_chapter_number。
 */
export async function resolveIngestTarget(
  projectPath: string,
  chapterPath: string,
  options: IngestChapterOptions = {},
): Promise<IngestTarget> {
  const pp = normalizePath(projectPath)
  // ISS-20260709-023 (DC-7) 渐进式 DI: 注入优先, 缺省回退 store（向后兼容）
  const novelMode = options.novelMode ?? useWikiStore.getState().novelMode
  if (!novelMode) return reject()

  const llmConfig = options.llmConfig ?? useWikiStore.getState().llmConfig
  const novelConfig = options.novelConfig ?? useWikiStore.getState().novelConfig
  // 使用 resolveNovelModel 正确解析提取模型（含供应商配置切换）
  const runtimeLlmConfig = resolveNovelModel(llmConfig, novelConfig, "extract")
  if (!hasUsableLlm(runtimeLlmConfig)) return reject("no_llm")

  const content = await readFile(chapterPath)
  const parsed = parseFrontmatter(content)
  const fm = parsed.frontmatter as Record<string, unknown> | null
  if (!fm || !isChapterPage(fm)) return reject("not_chapter")
  if (!isFinalChapter(fm)) {
    logger.warn("Chapter Ingest", "Chapter status is not final, skipping ingest.")
    return reject("not_final")
  }

  const chapterNumber = parseChapterNumber(fm.chapter_number) ?? 0
  if (chapterNumber <= 0) {
    logger.warn("Chapter Ingest", "Invalid chapter number, skipping ingest.")
    return reject("invalid_chapter_number")
  }

  return {
    ok: true,
    pp,
    runtimeLlmConfig,
    llmConfig,
    novelConfig,
    chapterNumber,
    body: parsed.body,
    content,
    fm,
  }
}
