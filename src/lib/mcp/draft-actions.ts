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
 *   draftMode 同一入口），落在 `.qm-drafts/`，由 `chapter-draft-dock` 呈现并可
 *   accept。这条路是通的。
 * - `memory.write` → **当前明确拒绝**，理由见下。
 *
 * ## 为什么 memory.write 拒绝而不是"写到一个草稿目录"
 *
 * 第一版把记忆草稿写进 `.novel/drafts/memory/`，看着符合 Draft-first。但真机验收
 * 追查「产物可在应用界面看到」时发现：应用里**没有任何界面读那个目录**——
 * `list_memories` 只列 `QM/memory/*.md`，也没有全局待确认队列。也就是说写进去的
 * 东西用户永远看不到、也无法 accept。
 *
 * 一个没人能审阅的"草稿"不是草稿，是静默丢弃。宁可拒绝并说清原因，也不要产出
 * 看不见的数据——后者会让调用方以为交付了记忆。
 *
 * 启用条件（任一满足即可放开）：应用出现记忆草稿收件箱；或写入权威矩阵放宽为
 * 「Draft-first 是默认、带强制审计可写正式记忆」（见 `#272`）。
 */

import { normalizePath } from "@/lib/path-utils"
import { DRAFTS_DIR, writeDraft } from "@/lib/novel"
import type { ChapterDraft } from "@/lib/novel"

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

/** 记忆写入被拒的统一原因（前端与工具描述共用同一套说法）。 */
export const MEMORY_WRITE_REFUSAL =
  "记忆写入暂不支持：应用里没有记忆草稿的审阅/确认入口，MCP 写入要么直接改正式记忆（违反 Draft-first），要么落在一个没人看得到的目录（等于静默丢弃）。请让用户在应用界面里写入记忆。启用条件见方案 #272。";


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
 * 记忆写入：当前**明确拒绝**（原因见文件头与 [`MEMORY_WRITE_REFUSAL`]）。
 *
 * 保留函数与工具注册是为了给调用方一个说清原因的答复，而不是让它对着
 * "unknown tool" 猜。启用条件满足后在这里换成真实实现即可，工具契约不变。
 */
export async function writeMemoryDraft(
  _projectPath: string,
  _params: { name?: unknown; content?: unknown },
): Promise<MemoryDraftResult> {
  throw new Error(MEMORY_WRITE_REFUSAL)
}
