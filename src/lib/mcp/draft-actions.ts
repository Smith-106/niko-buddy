/**
 * MCP 草稿写入动作（方案 `d23eb1df` P2）。
 *
 * ## 为什么两个写动作都只写草稿
 *
 * 硬边界「Draft-first」：AI 输出先进草稿，accept 后才回填正式正文与正式记忆。
 * MCP 这条路上没有"用户点确认"的时机，所以**只能**产出草稿——把确认权留给应用
 * 界面。任何在这里直接写正式章节/正式记忆的实现都是越界，无论调用方多想要。
 *
 * 因此：
 * - `chapter.write` → 复用既有 `writeDraft`（与主控 Agent 的 `write_chapter`
 *   draftMode 同一入口），落在 `.novel/drafts/`。
 * - `memory.write` → 落在 `.novel/drafts/memory/`，frontmatter `status: draft`
 *   与正式 `QM/memory/*.md` 物理隔离。**不**复用 `write_memory` 工具——那个
 *   直接写正式记忆，靠 UI 的 confirm 兜底，MCP 没有这层。
 */

import { createDirectory, fileExists, writeFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { DRAFTS_DIR, writeDraft } from "@/lib/novel"
import type { ChapterDraft } from "@/lib/novel"

/**
 * 记忆草稿目录（项目相对）。与正式记忆 `QM/memory/` 分开，误认不了。
 *
 * 为什么章节草稿与记忆草稿不在同一个根下：章节草稿复用应用既有的 `writeDraft`，
 * 落在它自己的 `DRAFTS_DIR`（`.qm-drafts`）——那个目录被 accept 流程扫描，不能
 * 往里塞非章节文件。记忆草稿没有既有落点，放在 `.novel/`（机读运行态根）下。
 * 两处都是草稿，都不会被当成正式数据。
 */
const MEMORY_DRAFTS_DIR = ".novel/drafts/memory"

export interface ChapterDraftResult {
  draftId: string
  chapterName: string
  /** 草稿文件路径（相对项目根）。 */
  path: string
  chars: number
  /** 落盘位置说明，让调用方明白这不是正式章节。 */
  note: string
}

export interface MemoryDraftResult {
  name: string
  path: string
  chars: number
  note: string
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} 需要非空字符串`)
  }
  return value
}

/** 章节名不得带路径分隔符——否则草稿文件会落到草稿目录之外。 */
function sanitizeName(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]/g, "_")
  if (!cleaned) throw new Error("名称清洗后为空")
  return cleaned
}

/**
 * 写一章草稿。复用 `writeDraft`，不自己拼 frontmatter。
 */
export async function writeChapterDraft(
  projectPath: string,
  params: { chapterName?: unknown; content?: unknown },
): Promise<ChapterDraftResult> {
  const chapterName = sanitizeName(requireText(params.chapterName, "chapterName"))
  const content = requireText(params.content, "content")

  const draft: ChapterDraft = await writeDraft(projectPath, chapterName, content, {
    sourceConversationId: "mcp:external-agent",
  })

  return {
    draftId: draft.id,
    chapterName: draft.chapterName,
    // 路径必须与写入器同一个常量：手拼字符串会和真实落点漂移（`.qm-drafts` vs
    // `.novel/drafts`），调用方拿到一个不存在的路径却以为写成功了。
    path: `${normalizePath(projectPath)}/${DRAFTS_DIR}/${draft.id}.md`,
    chars: content.length,
    note: "已写入草稿区，尚未进入正式章节。需在应用内确认后才会回填正式正文。",
  }
}

/**
 * 写一条记忆草稿。
 *
 * frontmatter 带 `status: draft` 与 `source: mcp-external-agent`，正式记忆读取路径
 * 不会把它当成正式条目；同时留下来源，便于事后追溯是谁写的。
 */
export async function writeMemoryDraft(
  projectPath: string,
  params: { name?: unknown; content?: unknown },
): Promise<MemoryDraftResult> {
  const name = sanitizeName(requireText(params.name, "name"))
  const content = requireText(params.content, "content")

  const dir = `${normalizePath(projectPath)}/${MEMORY_DRAFTS_DIR}`
  if (!(await fileExists(dir))) {
    await createDirectory(dir)
  }

  const createdAt = Date.now()
  const body = [
    "---",
    `name: ${name}`,
    "status: draft",
    "source: mcp-external-agent",
    `created_at: ${createdAt}`,
    "---",
    "",
    content,
  ].join("\n")

  const path = `${dir}/${name}.md`
  await writeFile(path, body)

  return {
    name,
    path,
    chars: content.length,
    note: "已写入记忆草稿区（.novel/drafts/memory），未进入正式记忆。需在应用内确认。",
  }
}
