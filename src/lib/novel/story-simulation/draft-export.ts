/**
 * 故事草稿导出
 * 将 StoryDraft 导出为 Markdown 文件。
 */

import { createDirectory, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { StoryDraft, StoryFramework } from "./types"

const SIM_ROOT = ".qmai/simulations"
const EXPORTS_DIR = `${SIM_ROOT}/exports`

function exportsDir(projectPath: string): string {
  return `${normalizePath(projectPath)}/${EXPORTS_DIR}`
}

function draftFilePath(
  projectPath: string,
  frameworkTitle: string,
  timestamp: string,
): string {
  const safeTitle = frameworkTitle
    .replace(/[\\/:*?"<>|]/g, "_")
    .slice(0, 30)
  const safeTs = timestamp.replace(/[:.]/g, "-")
  return `${exportsDir(projectPath)}/故事草稿_${safeTitle}_${safeTs}.md`
}

/**
 * 导出故事草稿为 Markdown。
 * @returns 导出的文件路径
 */
export async function exportDraft(
  projectPath: string,
  framework: StoryFramework,
  draft: StoryDraft,
): Promise<string> {
  const dir = exportsDir(projectPath)
  await createDirectory(dir)

  const now = new Date()
  const timestamp = now.toISOString()
  const filePath = draftFilePath(projectPath, framework.shortTitle || framework.title, timestamp)

  const lines: string[] = []
  lines.push(`# ${framework.title}`)
  lines.push("")
  lines.push(`> 生成时间：${now.toLocaleString("zh-CN")}`)
  lines.push(`> 目标字数：${framework.targetWords}`)
  lines.push(`> 实际字数：${draft.totalWords}`)
  if (framework.premise) {
    lines.push(`>`)
    lines.push(`> ${framework.premise}`)
  }
  lines.push("")
  lines.push("---")
  lines.push("")

  for (const chapter of draft.chapters) {
    lines.push(`## ${chapter.title}`)
    lines.push("")
    lines.push(chapter.content)
    lines.push("")
  }

  const content = lines.join("\n")
  await writeFileAtomic(filePath, content)
  return filePath
}
