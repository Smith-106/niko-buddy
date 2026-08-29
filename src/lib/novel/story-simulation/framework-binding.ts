/**
 * AI 会话绑定
 *
 * 将一个 StoryFramework 绑定到目标章节数，把章节按"起承转合"节点
 * 分配，并把绑定信息 + 框架上下文注入到 AI 写作会话中。
 */

import { createDirectory, deleteFile, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type {
  ChapterAllocation,
  FrameworkBinding,
  StoryFramework,
} from "./types"

const BINDING_FILE = ".qmai/simulations/bindings/active-binding.json"

function bindingFilePath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${BINDING_FILE}`
}

/**
 * 将 targetChapterCount 分配到各节点：
 * baseChaptersPerNode = floor(target / nodeCount)，余数依次分配给前面的节点。
 */
function allocateChapters(
  nodes: StoryFramework["nodes"],
  targetChapterCount: number,
): ChapterAllocation[] {
  const sorted = [...nodes].sort((a, b) => a.index - b.index)
  if (sorted.length === 0) return []

  const base = Math.floor(targetChapterCount / sorted.length)
  const remainder = targetChapterCount % sorted.length

  const allocations: ChapterAllocation[] = []
  let cursor = 1
  for (let i = 0; i < sorted.length; i++) {
    const count = base + (i < remainder ? 1 : 0)
    const startChapter = cursor
    const endChapter = cursor + count - 1
    allocations.push({
      nodeIndex: sorted[i].index,
      nodeTitle: sorted[i].title,
      startChapter,
      endChapter,
    })
    cursor += Math.max(count, 0)
  }
  return allocations
}

/** 读取当前激活的框架绑定，不存在时返回 null。 */
export async function loadBinding(
  projectPath: string,
): Promise<FrameworkBinding | null> {
  try {
    const content = await readFile(bindingFilePath(projectPath))
    const parsed = JSON.parse(content) as FrameworkBinding
    if (!parsed || !parsed.frameworkId) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 保存绑定：根据框架节点与目标章节数生成章节分配，写入绑定文件。
 */
export async function saveBinding(
  projectPath: string,
  framework: StoryFramework,
  targetChapterCount: number,
): Promise<FrameworkBinding> {
  const chapterAllocation = allocateChapters(framework.nodes, targetChapterCount)
  const binding: FrameworkBinding = {
    frameworkId: framework.id,
    frameworkTitle: framework.title,
    targetChapterCount,
    chapterAllocation,
    boundAt: new Date().toISOString(),
  }

  // createDirectory 使用 create_dir_all，会递归创建 .qmai/simulations/bindings
  await createDirectory(
    `${normalizePath(projectPath)}/.qmai/simulations/bindings`,
  )
  await writeFileAtomic(bindingFilePath(projectPath), JSON.stringify(binding, null, 2))
  return binding
}

/** 清除当前激活的框架绑定。 */
export async function clearBinding(projectPath: string): Promise<void> {
  try {
    await deleteFile(bindingFilePath(projectPath))
  } catch {
    // 绑定文件可能不存在
  }
}

/**
 * 构建注入 AI 会话的上下文文本：
 * 框架标题 + 目标章节数 + 章节分配表（第X-Y章 → 起承转合节点）+ 要求。
 */
export function buildBindingContext(
  binding: FrameworkBinding,
  framework: StoryFramework,
): string {
  const lines: string[] = []
  lines.push("# 故事框架绑定")
  lines.push("")
  lines.push(`- 框架标题：${framework.title}`)
  lines.push(`- 目标章节数：${binding.targetChapterCount}`)
  lines.push("")
  lines.push("## 章节分配")
  for (const allocation of binding.chapterAllocation) {
    const node = framework.nodes.find((n) => n.index === allocation.nodeIndex)
    const phaseLabel = node ? `【${node.phase}】` : ""
    const range =
      allocation.endChapter < allocation.startChapter
        ? "无章节分配"
        : allocation.startChapter === allocation.endChapter
          ? `第${allocation.startChapter}章`
          : `第${allocation.startChapter}-${allocation.endChapter}章`
    lines.push(`- ${range} → ${phaseLabel}${allocation.nodeTitle}`)
  }
  lines.push("")
  lines.push("## 要求")
  lines.push("- 请严格遵循上述故事框架推进剧情，按章节分配在对应节点完成相应情节。")
  lines.push("- 保持各节点核心冲突与预期结果的连贯性。")
  return lines.join("\n")
}
