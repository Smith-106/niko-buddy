/**
 * 48号报告 §六-① truth-authority 生产接线（孤儿激活）.
 *
 * 仲裁结论（B-ds vs B-glm 主模型综合）：
 * - 模块命名取 B-glm（truth-authority-adapter.ts），明确「适配器」角色而非第二真源
 * - 冲突处理取折中：冲突转为 ValidationWarning[]（type="truth_authority_conflict"）追加到
 *   snapshot.validationWarnings，**可见但不进门控 hard-short-circuit**（守 B-ds 的 Draft-first
 *   保护 + Track A 不被新增维度污染），与 B-glm「转 finding」对齐但 severity 随 conflict
 * - 插入点取 B-glm：validateCanonConflicts 之后、runCanonDualWriteHook 之前
 *
 * 纯机械、零 LLM、零 IO（只读 snapshot 派生 TruthEntry[]，调既有 detectTruthConflicts）。
 * 不构成第二真源（守 A23/ADR-26）：事实内容仍在 Truth Files/status.json 体系。
 */

import {
  type TruthEntry,
  type TruthConflict,
  type AuthorityLevel,
  detectTruthConflicts,
} from "./truth-authority"
import type { ValidationWarning, ChapterSnapshot } from "./chapter-ingest"

/**
 * 从 snapshot 的 canon/模态事实派生 TruthEntry[].
 * - newCanonFacts → established（正史已确立）
 * - beliefFacts → hypothesis（信念层，待验证）
 * - hypothesisFacts → hypothesis（推测层）
 * entryId 对齐 buildCanonDualWriteOps 的 episode id（ch{N}-fact{i}），保持审计链一致。
 */
export function deriveTruthEntries(snapshot: ChapterSnapshot): TruthEntry[] {
  const chapter = snapshot.chapterNumber
  const entries: TruthEntry[] = []

  const canonFacts = snapshot.newCanonFacts ?? []
  canonFacts.forEach((fact: string, i: number) => {
    entries.push({
      entryId: `ch${chapter}-fact${i}`,
      subject: extractSubject(fact),
      statement: fact,
      level: "established" as AuthorityLevel,
      revision: 0,
    })
  })

  const beliefFacts = snapshot.beliefFacts ?? []
  beliefFacts.forEach((f: { subject: string; predicate: string; object: string }) => {
    entries.push({
      entryId: `ch${chapter}-belief-${f.subject}-${f.predicate}-${f.object}`,
      subject: f.subject,
      statement: `${f.subject}${f.predicate}${f.object}`,
      level: "hypothesis" as AuthorityLevel,
      revision: 0,
    })
  })

  const hypothesisFacts = snapshot.hypothesisFacts ?? []
  hypothesisFacts.forEach((f: { subject: string; predicate: string; object: string }) => {
    entries.push({
      entryId: `ch${chapter}-hyp-${f.subject}-${f.predicate}-${f.object}`,
      subject: f.subject,
      statement: `${f.subject}${f.predicate}${f.object}`,
      level: "hypothesis" as AuthorityLevel,
      revision: 0,
    })
  })

  return entries
}

/**
 * 从事实文本启发式提取 subject（主语）.
 * 中文事实常见格式「A是B」「A位于C」——取首个实体名词；纯降级为截前 20 字符。
 */
function extractSubject(fact: string): string {
  const trimmed = fact.trim()
  // 常见关系分隔符取前半
  const relMatch = trimmed.match(/^(.+?)(?:是|位于|属于|有|为|在|于|与)/)
  if (relMatch?.[1]) return relMatch[1].slice(0, 30)
  return trimmed.slice(0, 20)
}

/**
 * 将 TruthConflict[] 转为 ValidationWarning[]（追加到 validationWarnings，可见不阻断）.
 * type="truth_authority_conflict" 稳定标识，供审计链消费。
 */
export function truthConflictsToValidationWarnings(conflicts: TruthConflict[]): ValidationWarning[] {
  return conflicts.map((c) => ({
    type: "truth_authority_conflict" as const,
    message: c.message,
  }))
}

/**
 * 单点接线入口：从 snapshot 派生 TruthEntry[]，检测冲突，返回 validation warnings.
 * 纯函数、零 IO。调用方（chapter-ingest）将结果追加到 validationWarnings。
 *
 * @returns truth-authority 冲突 warnings（空数组=无冲突或无事实）
 */
export function runTruthAuthorityCheck(snapshot: ChapterSnapshot): ValidationWarning[] {
  const entries = deriveTruthEntries(snapshot)
  if (entries.length === 0) return []
  const conflicts = detectTruthConflicts(entries)
  if (conflicts.length === 0) return []
  return truthConflictsToValidationWarnings(conflicts)
}
