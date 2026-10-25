import { createDirectory, readFile, writeFile } from "@/commands/fs"
import { logger, toErrorMessage } from "@/lib/utils"
import { getFileName, getRelativePath, getUniqueOutlinePath, normalizePath } from "@/lib/path-utils"
import { makeSafeFileSlug, yamlEscape } from "@/lib/wiki-filename"

export type SourceOutlineImportTarget =
  | "story-outline"
  | "chapter-outline"
  | "character-briefs"
  | "locations"
  | "organizations"
  | "power-system"
  | "foreshadowing-plan"

interface SourceOutlineImportConfig {
  id: SourceOutlineImportTarget
  title: string
  folderName: string
  outlineType?: "story-outline" | "chapter-outline" | "volume-outline"
  category: string
}

export const SOURCE_OUTLINE_IMPORT_TARGETS: SourceOutlineImportConfig[] = [
  { id: "story-outline", title: "总大纲", folderName: "总大纲", outlineType: "story-outline", category: "story" },
  { id: "chapter-outline", title: "章节细纲", folderName: "章节细纲", outlineType: "chapter-outline", category: "chapter" },
  { id: "character-briefs", title: "人物小传", folderName: "人物小传", category: "characters" },
  { id: "locations", title: "地点设定", folderName: "地点设定", category: "locations" },
  { id: "organizations", title: "势力设定", folderName: "势力设定", category: "organizations" },
  { id: "power-system", title: "能力体系", folderName: "能力体系", category: "power-system" },
  { id: "foreshadowing-plan", title: "伏笔计划", folderName: "伏笔计划", category: "foreshadowing" },
]

function getTargetConfig(target: SourceOutlineImportTarget): SourceOutlineImportConfig {
  const config = SOURCE_OUTLINE_IMPORT_TARGETS.find((item) => item.id === target)
  if (!config) throw new Error(`Unknown outline import target: ${target}`)
  return config
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "")
}

function buildSourceSection(sourcePath: string, relativeSourcePath: string, sourceContent: string): string {
  const sourceName = getFileName(sourcePath) || relativeSourcePath
  return [
    `## 来源：${sourceName}`,
    "",
    `> 原始来源：${relativeSourcePath}`,
    "",
    sourceContent.trim(),
    "",
  ].join("\n")
}

function buildOutlinePage(
  config: SourceOutlineImportConfig,
  pageTitle: string,
  relativeSourcePath: string,
  section: string,
): string {
  const frontmatter = [
    "---",
    "type: outline",
    `title: "${yamlEscape(pageTitle)}"`,
    ...(config.outlineType ? [`outline_type: ${config.outlineType}`] : []),
    `outline_category: ${config.category}`,
    `outline_folder: "${yamlEscape(config.folderName)}"`,
    `sources: ["${yamlEscape(relativeSourcePath)}"]`,
    "---",
    "",
    `# ${pageTitle}`,
    "",
  ]
  return `${frontmatter.join("\n")}${section}`
}

export async function addSourceToOutlineCategory(
  projectPath: string,
  sourcePath: string,
  target: SourceOutlineImportTarget,
): Promise<string> {
  const pp = normalizePath(projectPath)
  const normalizedSourcePath = normalizePath(sourcePath)
  const config = getTargetConfig(target)
  const outlinesDir = `${pp}/wiki/outlines`
  const targetDir = `${outlinesDir}/${config.folderName}`
  const relativeSourcePath = getRelativePath(normalizedSourcePath, pp)
  const sourceContent = await readFile(normalizedSourcePath)
  const sourceName = getFileName(normalizedSourcePath) || relativeSourcePath
  const pageTitle = stripExtension(sourceName)
  const outlinePath = await getUniqueOutlinePath(targetDir, `${makeSafeFileSlug(pageTitle)}.md`)
  const section = buildSourceSection(normalizedSourcePath, relativeSourcePath, sourceContent)

  await createDirectory(outlinesDir)
  await createDirectory(targetDir)
  await writeFile(outlinePath, buildOutlinePage(config, pageTitle, relativeSourcePath, section))
  return outlinePath
}

/** 单条大纲导入结果（汇总口径）。 */
export interface OutlineImportBatchItem {
  sourcePath: string
  target: SourceOutlineImportTarget
  ok: boolean
  /** 成功时为落盘 outlinePath；失败时为空字符串。 */
  outlinePath: string
  /** 脱敏失败原因（toErrorMessage，已去 provider 明细）；成功时为空字符串。 */
  error: string
}

/**
 * ISS-20260712-REL-1: outline-import 失败汇总收敛。
 * 批量导入多来源时逐条 try/catch（单条失败不阻断其余），返回逐条结果 +
 * 汇总日志（成功数/失败数 + 脱敏原因）。单文件 addSourceToOutlineCategory
 * 语义不变（本函数仅编排 + 汇总，不改单条写入路径）。
 */
export async function importOutlinesWithSummary(
  projectPath: string,
  items: Array<{ sourcePath: string; target: SourceOutlineImportTarget }>,
): Promise<{ results: OutlineImportBatchItem[]; succeeded: number; failed: number }> {
  const results: OutlineImportBatchItem[] = []
  for (const item of items) {
    try {
      const outlinePath = await addSourceToOutlineCategory(projectPath, item.sourcePath, item.target)
      results.push({ sourcePath: item.sourcePath, target: item.target, ok: true, outlinePath, error: "" })
    } catch (err) {
      const message = toErrorMessage(err)
      logger.warn("Outline Import", "single source import failed (batch continues)", {
        source: item.sourcePath,
        target: item.target,
        error: message,
      })
      results.push({ sourcePath: item.sourcePath, target: item.target, ok: false, outlinePath: "", error: message })
    }
  }
  const succeeded = results.filter((r) => r.ok).length
  const failed = results.length - succeeded
  // 汇总行：成功/失败计数 + 失败来源清单（脱敏 message，不含原文/provider 明细）。
  logger.warn("Outline Import", "batch summary", {
    total: results.length,
    succeeded,
    failed,
    failures: results.filter((r) => !r.ok).map((r) => ({ source: r.sourcePath, error: r.error })),
  })
  return { results, succeeded, failed }
}
