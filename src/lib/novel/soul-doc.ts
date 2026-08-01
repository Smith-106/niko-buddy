import { readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

/** Soul 角色文档的文件名常量。
 * MIT licensed implementation.
 */
export const SOUL_DOC_FILENAME = "soul.md"

/**
 * 读取 Soul 角色文档。
 * MIT licensed implementation.
 *
 * @param projectPath - 项目路径
 * @returns 文件内容（如果不存在则返回空字符串）
 */
export async function readSoulDoc(projectPath: string): Promise<string> {
  const pp = normalizePath(projectPath)
  try {
    return await readFile(`${pp}/${SOUL_DOC_FILENAME}`)
  } catch {
    return ""
  }
}

/**
 * 写入 Soul 角色文档（原子写）。
 * MIT licensed implementation.
 *
 * @param projectPath - 项目路径
 * @param content - 文档内容
 */
export async function writeSoulDoc(projectPath: string, content: string): Promise<void> {
  const pp = normalizePath(projectPath)
  await writeFileAtomic(`${pp}/${SOUL_DOC_FILENAME}`, content)
}