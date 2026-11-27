/**
 * Agent Tools - 文件操作工具层
 *
 * 为 AI Agent 提供安全的文件读写能力：
 * - 读取指定范围的文件
 * - 应用修改（search & replace）
 * - 列出可操作的文件
 */

import { readFile, writeFile, listDirectory } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getFileStem, normalizePath } from "@/lib/path-utils"
import { isSafeIngestPath } from "@/lib/ingest"
import type { FileEditAction } from "./agent-parser"
import { discardChapterDraft, writeDraft } from "./draft-manager"
import { DRAFTS_DIR } from "./lifecycle-types"
import { toErrorMessage } from "@/lib/utils"

export interface FileEditResult {
  filePath: string
  success: boolean
  error?: string
  /** 修改前的完整内容（用于 undo） */
  originalContent?: string
  /** 修改后的完整内容 */
  newContent?: string
  /** 是否因 Draft-first 边界改道写入待审草稿箱（.qm-drafts/）而非直写正式章 */
  routedToDraft?: boolean
  /** 改道写入草稿箱时生成的草稿 ID */
  draftId?: string
  /** 改道写入草稿箱时的草稿文件路径 */
  draftPath?: string
}

function isSafeAgentEditPath(filePath: string): boolean {
  if (isSafeIngestPath(filePath)) return true
  if (typeof filePath !== "string" || filePath.trim().length === 0) return false
  if (/[\x00-\x1f]/.test(filePath)) return false
  if (filePath.startsWith("/") || filePath.startsWith("\\")) return false
  if (/^[a-zA-Z]:/.test(filePath)) return false
  const normalized = filePath.replace(/\\/g, "/")
  if (!normalized.startsWith("QM/chapters/")) return false
  return isSafeIngestPath(`wiki/${normalized.slice("QM/".length)}`)
}

/**
 * 列出指定目录下的所有 markdown 文件
 */
export async function listScopeFiles(
  projectPath: string,
  scope: "chapters" | "outlines",
): Promise<{ name: string; path: string }[]> {
  const pp = normalizePath(projectPath)
  const dir = scope === "chapters" ? `${pp}/wiki/chapters` : `${pp}/wiki/outlines`
  try {
    const tree = await listDirectory(dir)
    return tree
      .filter((f) => f.name.endsWith(".md"))
      .map((f) => ({ name: f.name, path: `${dir}/${f.name}` }))
  } catch {
    return []
  }
}

/**
 * 读取指定范围内的文件内容（用于注入 Agent 上下文）
 */
export async function readScopeFileContents(
  projectPath: string,
  scope: "chapters" | "outlines",
  maxFiles = 20,
): Promise<{ name: string; path: string; content: string }[]> {
  const files = await listScopeFiles(projectPath, scope)
  // PAT-IM: 独立项并行 —— 并发 readFile（Promise.all 保序回填），再按切片原序串行 push，顺序与跳过语义不变。
  const scopeSlice = files.slice(0, maxFiles)
  const scopeContents = await Promise.all(
    scopeSlice.map((file) => readFile(file.path).then(
      (content) => ({ ok: true as const, content }),
      () => ({ ok: false as const, content: "" }),
    )),
  )
  const results: { name: string; path: string; content: string }[] = []
  for (let scopeIndex = 0; scopeIndex < scopeSlice.length; scopeIndex += 1) {
    const read = scopeContents[scopeIndex]
    if (!read.ok) continue
    try {
      results.push({ ...scopeSlice[scopeIndex], content: read.content })
    } catch {
      // skip unreadable files
    }
  }

  return results
}

/**
 * 应用单个文件修改
 * 使用 search & replace 策略：在文件中找到 search 文本，替换为 replace 文本
 */
export async function applyFileEdit(
  projectPath: string,
  edit: FileEditAction,
): Promise<FileEditResult> {
  const pp = normalizePath(projectPath)
  
  // 🔴 ISS-20260731-001: 路径遍历守卫 (PAT-G2 twin mirror fix, 对齐 ingest.ts:253)
  // LLM 可构造 wiki/chapters/../../../../etc/passwd 绕过字符串包含检查
  // 拒绝：绝对路径 / .. segments / 控制字符 / 非 wiki/ 或 QM/chapters/ 前缀
  if (!isSafeAgentEditPath(edit.filePath)) {
    console.warn(`[agent-tools] Blocked unsafe path: ${edit.filePath}`)
    return {
      filePath: edit.filePath,
      success: false,
      error: "路径不安全：必须位于 wiki/ 或 QM/chapters/ 下，禁止 '..'、绝对路径和控制字符",
    }
  }
  
  // 安全检查：确保路径在允许范围内
  const fullPath = edit.filePath.startsWith(pp)
    ? edit.filePath
    : `${pp}/${edit.filePath}`

  const normalizedPath = normalizePath(fullPath)

  // 检查路径是否在 wiki/chapters、QM/chapters 或 wiki/outlines 下（双重防御）
  const isChapterTarget =
    normalizedPath.includes("/wiki/chapters/") || normalizedPath.includes("/QM/chapters/")
  const isOutlineTarget = normalizedPath.includes("/wiki/outlines/")
  if (!isChapterTarget && !isOutlineTarget) {
    return {
      filePath: edit.filePath,
      success: false,
      error: "只能修改 wiki/chapters/、QM/chapters/ 或 wiki/outlines/ 下的文件",
    }
  }

  try {
    const originalContent = await readFile(normalizedPath)

    if (!originalContent.includes(edit.search)) {
      return {
        filePath: edit.filePath,
        success: false,
        error: "未找到要替换的内容（search 文本不匹配）",
        originalContent,
      }
    }

    // 替换所有匹配项（如果有多处相同内容）
    const newContent = originalContent.split(edit.search).join(edit.replace)

    // Draft-first 边界：章节目标一律改道写入 .qm-drafts/ 待审草稿箱，禁止直写正式章节
    if (isChapterTarget) {
      const parsed = parseFrontmatter(newContent.replace(/^\uFEFF/, ""))
      const draftBody = parsed.rawBlock
        ? parsed.body.replace(/^(?:\r?\n)+/, "")
        : newContent
      const chapterName = getFileStem(normalizedPath).trim() || "chapter"
      const draft = await writeDraft(pp, chapterName, draftBody, {
        sourceConversationId: "agent:file-edit",
      })
      const root = pp.replace(/\/+$/, "")
      const draftPath = `${root}/${DRAFTS_DIR}/${draft.id}.md`
      return {
        filePath: edit.filePath,
        success: true,
        originalContent,
        newContent,
        routedToDraft: true,
        draftId: draft.id,
        draftPath,
      }
    }

    // wiki/outlines/ 维持直写，保持大纲对话体验不受影响
    await writeFile(normalizedPath, newContent)

    return {
      filePath: edit.filePath,
      success: true,
      originalContent,
      newContent,
      routedToDraft: false,
    }
  } catch (err) {
    return {
      filePath: edit.filePath,
      success: false,
      error: toErrorMessage(err),
    }
  }
}

/**
 * 批量应用文件修改
 */
export async function applyFileEdits(
  projectPath: string,
  edits: FileEditAction[],
): Promise<FileEditResult[]> {
  const results: FileEditResult[] = []
  for (const edit of edits) {
    results.push(await applyFileEdit(projectPath, edit))
  }
  return results
}

/**
 * 撤销文件修改（恢复原始内容；改道草稿箱的章节修改仅丢弃草稿，绝不覆盖正式章节）
 */
export async function undoFileEdit(
  result: FileEditResult,
  projectPath?: string,
): Promise<boolean> {
  if (!result.success) return false
  if (result.routedToDraft === true) {
    if (!projectPath || !result.draftId) return false
    try {
      await discardChapterDraft(projectPath, result.draftId)
      return true
    } catch {
      return false
    }
  }
  if (!result.originalContent) return false
  try {
    const pp = result.filePath
    await writeFile(pp, result.originalContent)
    return true
  } catch {
    return false
  }
}
