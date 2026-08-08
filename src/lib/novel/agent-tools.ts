/**
 * Agent Tools - 文件操作工具层
 *
 * 为 AI Agent 提供安全的文件读写能力：
 * - 读取指定范围的文件
 * - 应用修改（search & replace）
 * - 列出可操作的文件
 */

import { readFile, writeFile, listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { isSafeIngestPath } from "@/lib/ingest"
import type { FileEditAction } from "./agent-parser"

export interface FileEditResult {
  filePath: string
  success: boolean
  error?: string
  /** 修改前的完整内容（用于 undo） */
  originalContent?: string
  /** 修改后的完整内容 */
  newContent?: string
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
  const results: { name: string; path: string; content: string }[] = []

  for (const file of files.slice(0, maxFiles)) {
    try {
      const content = await readFile(file.path)
      results.push({ ...file, content })
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
  // isSafeIngestPath 拒绝：绝对路径 / .. segments / 控制字符 / 非 wiki/ 前缀
  if (!isSafeIngestPath(edit.filePath)) {
    console.warn(`[agent-tools] Blocked unsafe path: ${edit.filePath}`)
    return {
      filePath: edit.filePath,
      success: false,
      error: "路径不安全：必须位于 wiki/ 下，禁止 '..'、绝对路径和控制字符",
    }
  }
  
  // 安全检查：确保路径在允许范围内
  const fullPath = edit.filePath.startsWith(pp)
    ? edit.filePath
    : `${pp}/${edit.filePath}`

  const normalizedPath = normalizePath(fullPath)

  // 检查路径是否在 wiki/chapters 或 wiki/outlines 下（双重防御）
  if (!normalizedPath.includes("/wiki/chapters/") && !normalizedPath.includes("/wiki/outlines/")) {
    return {
      filePath: edit.filePath,
      success: false,
      error: "只能修改 wiki/chapters/ 或 wiki/outlines/ 下的文件",
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
    await writeFile(normalizedPath, newContent)

    return {
      filePath: edit.filePath,
      success: true,
      originalContent,
      newContent,
    }
  } catch (err) {
    return {
      filePath: edit.filePath,
      success: false,
      error: err instanceof Error ? err.message : String(err),
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
 * 撤销文件修改（恢复原始内容）
 */
export async function undoFileEdit(result: FileEditResult): Promise<boolean> {
  if (!result.success || !result.originalContent) return false
  try {
    const pp = result.filePath
    await writeFile(pp, result.originalContent)
    return true
  } catch {
    return false
  }
}
