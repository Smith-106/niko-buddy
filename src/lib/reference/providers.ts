/**
 * Wave 2 @引用系统 — 三类 provider 候选装载。
 *
 * IO 集中在候选装载（读 wiki/entities + snapshots + aura bindings）；
 * 打分是纯函数（resolve.ts 的 scoreCandidate）。
 */

import type { ReferenceCandidate, ReferenceKind } from "./types"
import { listBindableNovelCharacters } from "@/lib/novel/bindable-characters"
import { listSnapshots } from "@/lib/novel/chapter-ingest"
import { listDirectory, readFile } from "@/commands/fs"

/** 候选装载接口：每类 provider 提供 listCandidates(projectPath) */
export interface ReferenceProvider {
  kind: ReferenceKind
  listCandidates(projectPath: string): Promise<ReferenceCandidate[]>
}

/** 角色 provider：bindable characters（wiki/entities + outlines 解析） */
export const characterProvider: ReferenceProvider = {
  kind: "character",
  async listCandidates(projectPath) {
    const names = await listBindableNovelCharacters(projectPath)
    return names.map((name) => ({
      id: `character:${name}`,
      kind: "character" as const,
      name,
      score: 0,
    }))
  },
}

/** 章节 provider：snapshots 章节号通道（第N章） */
export const chapterProvider: ReferenceProvider = {
  kind: "chapter",
  async listCandidates(projectPath) {
    const numbers = await listSnapshots(projectPath)
    return numbers.map((n) => ({
      id: `chapter:${n}`,
      kind: "chapter" as const,
      name: `第${n}章`,
      score: 0,
    }))
  },
}

/** 设定 provider：wiki entities（type:setting / location / organization / item） */
export const settingProvider: ReferenceProvider = {
  kind: "setting",
  async listCandidates(projectPath) {
    const candidates: ReferenceCandidate[] = []
    const entityDir = `${projectPath}/wiki/entities`
    let tree: Awaited<ReturnType<typeof listDirectory>>
    try {
      tree = await listDirectory(entityDir)
    } catch {
      return candidates
    }
    const files = flattenMarkdownNodes(tree)
    await Promise.all(
      files.map(async (file) => {
        try {
          const content = await readFile(file.path)
          const typeMatch = content.match(/^type:\s*(.+)$/m)
          const type = typeMatch?.[1]?.trim()
          if (!type || !SETTING_TYPES.has(type)) return
          const titleMatch = content.match(/^title:\s*(.+)$/m)
          const title = titleMatch?.[1]?.trim() ?? file.name.replace(/\.md$/, "")
          candidates.push({
            id: `setting:${title}`,
            kind: "setting",
            name: title,
            score: 0,
          })
        } catch {
          // 单文件读取失败跳过（与既有数据源同款失败降级）
        }
      }),
    )
    return candidates
  },
}

const SETTING_TYPES = new Set(["setting", "location", "organization", "item"])

/** 全部 provider（角色 > 章节 > 设定 内置权重顺序） */
export const ALL_REFERENCE_PROVIDERS: ReferenceProvider[] = [
  characterProvider,
  chapterProvider,
  settingProvider,
]

/** 装载全部候选（并行，失败降级空数组） */
export async function loadAllReferenceCandidates(projectPath: string): Promise<ReferenceCandidate[]> {
  const results = await Promise.all(
    ALL_REFERENCE_PROVIDERS.map((p) =>
      p.listCandidates(projectPath).catch(() => [] as ReferenceCandidate[]),
    ),
  )
  return results.flat()
}

interface MarkdownNode {
  name: string
  path: string
  is_dir: boolean
  children?: MarkdownNode[]
}

function flattenMarkdownNodes(nodes: MarkdownNode[]): MarkdownNode[] {
  const out: MarkdownNode[] = []
  for (const node of nodes) {
    if (node.is_dir && Array.isArray(node.children)) {
      out.push(...flattenMarkdownNodes(node.children))
      continue
    }
    if (!node.is_dir && node.name.toLowerCase().endsWith(".md")) {
      out.push(node)
    }
  }
  return out
}
