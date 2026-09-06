/**
 * 64 号实施（63 号共识 §6 P0-3）：FanficCanonImport — 同人正典合并导入器.
 *
 * 吸收来源：book-analysis 拆书资产（library-state 的已提取角色）→ 目标书
 * 正典合并。确定性零 LLM：重名 → bind_existing；锁冲突 → conflicts + skip；
 * LLM 不参与匹配。合并产物是 **pending 工件**（Draft-first：accept 后才写
 * 正式 wiki），提案 JSON 落 `.novel/fanfic-merge-pending.json`。
 *
 * 本文件是「已存在锚点（book-analysis 库 / book-rules 四模式）的同域辅助
 * 文件」；四模式语义由 book-rules.ts 提供（validateFanficChapter）。
 */

import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { BookAnalysisLibraryBook } from "./book-analysis/library-state"
import type { BookRules, FanficMode } from "./book-rules"

export type CanonMergeAction = "bind_existing" | "create_new" | "skip"

export interface CanonMergeConflict {
  code: "name_collision" | "lock_mismatch" | "cp_third_wheel"
  message: string
}

export interface CanonMergeProposal {
  sourceBookId: string
  mode: FanficMode
  characters: Array<{
    sourceId: string
    canonicalName: string
    aliases: string[]
    action: CanonMergeAction
    targetAuraId?: string
  }>
  conflicts: CanonMergeConflict[]
}

export interface CanonMergeInput {
  source: BookAnalysisLibraryBook
  /** 目标书已有角色名+别名（正典名册）。 */
  targetNames: string[]
  rules: BookRules
}

/**
 * 生成正典合并提案（纯函数零 IO 零 LLM）：
 * 重名 → bind_existing；角色名/别名冲突不可消解 → skip + conflict；
 * cp 模式中第三角色抢镜 → cp_third_wheel warn。
 * 不写盘——由调用方落 pending 工件。
 */
export function proposeCanonMerge(input: CanonMergeInput): CanonMergeProposal {
  const { source, targetNames, rules } = input
  const targetSet = new Set(targetNames.map((n) => n.trim()).filter(Boolean))
  const characters: CanonMergeProposal["characters"] = (source.characters ?? []).map((c) => {
    const allNames = [c.name, ...(c.aliases ?? [])]
    const hit = allNames.find((n) => targetSet.has(n))
    if (hit) {
      return {
        sourceId: c.id,
        canonicalName: hit,
        aliases: c.aliases ?? [],
        action: "bind_existing" as const,
      }
    }
    return {
      sourceId: c.id,
      canonicalName: c.name,
      aliases: c.aliases ?? [],
      action: "create_new" as const,
    }
  })

  const conflicts: CanonMergeConflict[] = []
  const seen = new Set<string>()
  for (const ch of characters) {
    if (ch.action === "bind_existing") continue
    if (seen.has(ch.canonicalName)) {
      ch.action = "skip"
      conflicts.push({
        code: "name_collision",
        message: `「${ch.canonicalName}」在源书内多名同现，无法自动合并`,
      })
    }
    seen.add(ch.canonicalName)
  }

  if (rules.fanficMode === "cp") {
    const appearing = new Set(characters.map((c) => c.canonicalName))
    if (appearing.size >= 2 && characters.length >= 3) {
      // 群像章误杀保护：不单独 violate，仅 warn
      conflicts.push({
        code: "cp_third_wheel",
        message: `cp 模式下源书含 ${characters.length} 名角色（配对判定由 validateFanficChapter 承接）`,
      })
    }
  }

  return { sourceBookId: source.id, mode: rules.fanficMode ?? "canon", characters, conflicts }
}

const PENDING_FILE = ".novel/fanfic-merge-pending.json"

export function fanficMergePendingPath(projectPath: string): string {
  return `${normalizePath(projectPath)}/${PENDING_FILE}`
}

/** 落 pending 工件（Draft-first：accept 前不写正式 wiki）。 */
export async function saveFanficMergeProposal(
  projectPath: string,
  proposal: CanonMergeProposal,
): Promise<void> {
  const dir = `${normalizePath(projectPath)}/.novel`
  await createDirectory(dir)
  await writeFileAtomic(fanficMergePendingPath(projectPath), JSON.stringify(proposal, null, 2))
}

/** 读取 pending 工件；缺失/损坏 → null（不抛）。 */
export async function loadFanficMergeProposal(
  projectPath: string,
): Promise<CanonMergeProposal | null> {
  try {
    const raw = await readFile(fanficMergePendingPath(projectPath))
    const parsed = JSON.parse(raw) as CanonMergeProposal
    if (parsed && parsed.sourceBookId && Array.isArray(parsed.characters)) return parsed
  } catch {
    // missing / unreadable
  }
  return null
}
