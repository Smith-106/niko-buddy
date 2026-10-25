// S5 切片 #3（chapter-ingest 拆分第 3 步）：community-summaries last-good 备份/恢复对。
// 尽力而为语义（绝不阻断主流程）；chapter-ingest 经 re-export 保持既有 import 面不变。
import { listDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"

/**
 * #7（三模型共识 2026-09-07）：community_summary 确定性兜底。
 * backupCommunitySummariesLastGood：generate 前把现版摘要复制为 <file>.last-good
 * 快照（首次生成无现版则跳过）；restoreCommunitySummariesLastGood：整体生成失败
 * 时把 last-good 快照复制回原位（防静默空档）。读取端按 `*.json` 过滤，
 * `.json.last-good` 后缀文件不会混入正常读取。均尽力而为，绝不阻断主流程。
 */
export async function backupCommunitySummariesLastGood(ppRaw: string): Promise<void> {
  const pp = normalizePath(ppRaw)
  const summaryDir = `${pp}/.novel/community-summaries`
  let nodes: Array<{ name: string; path: string; is_dir: boolean }>
  try {
    nodes = await listDirectory(summaryDir)
  } catch {
    return // 首次生成，无现版可备份
  }
  for (const node of nodes) {
    if (node.is_dir || !node.name.endsWith(".json")) continue
    try {
      const raw = await readFile(node.path)
      await writeFileAtomic(`${node.path}.last-good`, raw)
    } catch {
      // 备份失败不阻断生成主流程
    }
  }
}

export async function restoreCommunitySummariesLastGood(ppRaw: string): Promise<void> {
  const pp = normalizePath(ppRaw)
  const summaryDir = `${pp}/.novel/community-summaries`
  let nodes: Array<{ name: string; path: string; is_dir: boolean }>
  try {
    nodes = await listDirectory(summaryDir)
  } catch {
    return
  }
  for (const node of nodes) {
    if (node.is_dir || !node.name.endsWith(".json.last-good")) continue
    try {
      const raw = await readFile(node.path)
      await writeFileAtomic(node.path.replace(/\.last-good$/, ""), raw)
    } catch {
      // 尽力恢复，失败仍保留 failed 审计留痕
    }
  }
}
