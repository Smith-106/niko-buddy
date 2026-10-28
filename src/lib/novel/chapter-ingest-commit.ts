/**
 * chapter-ingest (A) 波拆分第 2 步：快照提交段。
 *
 * 承载 `ingestChapter` 的**提交点**（commit-then-project 的 commit 部分）：
 *   实体链接/校验 → 快照落盘 → 章节摄取产物 → memory-op 预演 → facts-store
 *   接线 → canon 影子双写钩子。
 *
 * 设计约束（只搬不改）：
 *   - 三个非致命 `try/catch`（校验失败、memory-op 预演、facts-store 写入）的
 *     **吞错边界与日志文案零变化**。它们的存在是既有契约：任何一环失败都不得
 *     阻断提交点，否则「章已摄取但快照未落盘」的中间态会变成不可恢复。
 *   - 提交顺序不可调换：`saveSnapshot` 先于 `saveChapterIngestOutput`，两者都
 *     先于 facts-store 与 canon 双写。
 *
 * `runCanonDualWriteHook` 由调用方注入（它定义在母模块，直接 import 会造成
 * 运行时循环依赖），签名与母模块导出一致。
 */
import { readFile, writeFileAtomic } from "@/commands/fs"
import { logger, toErrorMessage } from "@/lib/utils"
import { clearTemporalFactsCache } from "./context-engine"
import {
  linkSnapshotEntities,
  validateCanonConflicts,
  validateEntityReferences,
} from "./chapter-ingest-entity-validation"
import { parseFactsSubject } from "./chapter-ingest-utils"
import { runTruthAuthorityCheck } from "./truth-authority-adapter"
import { saveChapterIngestOutput, saveSnapshot } from "./chapter-ingest-snapshot-io"
import type { CanonDualWriteDeps } from "./canon-dual-write"
import type { ChapterSnapshot } from "./chapter-ingest"

export interface CommitIngestSnapshotParams {
  pp: string
  snapshot: ChapterSnapshot
  /** 章节 frontmatter（canon 双写资格判定与标题提取）。 */
  fm: Record<string, unknown>
  /** canon 双写依赖（缺省 = 空操作）。 */
  canonDualWriteDeps?: CanonDualWriteDeps
  /**
   * canon 影子双写钩子。由母模块注入以避免 `chapter-ingest` ↔ 本模块的
   * 运行时循环依赖；语义与母模块导出的 `runCanonDualWriteHook` 完全一致。
   */
  runCanonDualWriteHook: (
    deps: CanonDualWriteDeps | undefined,
    projectPath: string,
    fm: Record<string, unknown>,
    snapshot: ChapterSnapshot,
    now: number,
  ) => Promise<void>
}

/**
 * 提交一章的摄取结果。**永不抛错**：内部所有失败都降级为 warn，
 * 保证调用方拿到的 snapshot 已尽可能落盘。
 */
export async function commitIngestSnapshot(params: CommitIngestSnapshotParams): Promise<void> {
  const { pp, snapshot, fm, canonDualWriteDeps, runCanonDualWriteHook } = params

  try {
    const linkWarnings = await linkSnapshotEntities(pp, snapshot)
    const entityWarnings = await validateEntityReferences(pp, snapshot)
    const canonWarnings = await validateCanonConflicts(pp, snapshot)
    // 48号报告 §六-① truth-authority 生产接线（孤儿激活）:
    // validateCanonConflicts 后、runCanonDualWriteHook 前插入纯机械冲突检测。
    // 冲突转 NovelReviewResult[] 追加到 validationWarnings（可见不阻断 Track A 门控）。
    // 纯函数零 IO/LLM，失败不阻断主 ingest（与外层 try/catch 安全网一致）。
    const truthAuthorityWarnings = runTruthAuthorityCheck(snapshot)
    snapshot.validationWarnings = [...linkWarnings, ...entityWarnings, ...canonWarnings, ...truthAuthorityWarnings]
    snapshot.entityIsNew = snapshot.entityIsNew || {}
  } catch (err) {
    logger.warn("Chapter Ingest", "Validation failed", { error: toErrorMessage(err) })
    snapshot.validationWarnings = []
    snapshot.entityIsNew = {}
  }

  await saveSnapshot(pp, snapshot)
  await saveChapterIngestOutput(pp, snapshot, {
    title: typeof fm.title === "string" ? fm.title : undefined,
  })

  // Wave B: plan Mem0-style ADD ops from newCanonFacts (pure; log only).
  // Does not dual-write a fact store — temporal VIEW remains derived from snapshots.
  try {
    const { planAddOpsFromCanonFacts, applyMemoryOps } = await import("./memory-op")
    const ops = planAddOpsFromCanonFacts(
      snapshot.chapterNumber,
      snapshot.newCanonFacts ?? [],
    )
    if (ops.length > 0) {
      const planned: import("./temporal-memory").TemporalFact[] = []
      const results = applyMemoryOps(planned, ops)
      const ok = results.filter((r) => r.ok).length
      logger.info("Chapter Ingest", `memory-op planned ADD ${ok}/${ops.length} (view-only rehearsal)`)
    }
  } catch (err) {
    logger.warn("Chapter Ingest", "memory-op plan skipped", {
      error: toErrorMessage(err),
    })
  }

  // 54 号设计 ③: facts-store 接线 (graphiti Fact 契约吸收)。
  // newCanonFacts → facts 表 (JSON 文件唯一持久化源, ADR-26 无第二真源);
  // 投影层 (temporal-memory) 仍为派生视图。additive: 写入失败仅 warn 不阻塞 ingest;
  // 文件不存在自动重建 (emptyFactsFile)。
  try {
    const { emptyFactsFile, loadFactsFile, saveFactsFile, addFact, recordEpisode } = await import("./facts-store")
    const factsPath = `${pp}/.novel/facts.json`
    let factsState = emptyFactsFile()
    try {
      const raw = await readFile(factsPath)
      factsState = loadFactsFile(raw)
    } catch (err) {
      // 无 facts.json → 空表重建 (零迁移成本)
      // ISS-20260709-025 PAT-IM2: 记诊断（首次建表为预期路径，warn 弱提示），控制流不变。
      logger.warn("Chapter Ingest", "facts file missing or corrupt, rebuild empty (non-fatal)", { error: toErrorMessage(err) })
    }
    const canonFacts = snapshot.newCanonFacts ?? []
    if (canonFacts.length > 0) {
      let next = factsState
      const addedIds: string[] = []
      for (const rawFact of canonFacts) {
        const subject = parseFactsSubject(rawFact)
        const before = next
        next = addFact(next, {
          subject,
          predicate: "状态",
          object: rawFact,
          valid_at: snapshot.chapterNumber,
          source: "chapter-ingest newCanonFacts",
        })
        if (next.facts.length > before.facts.length) {
          addedIds.push(next.facts[next.facts.length - 1]!.id)
        }
      }
      if (addedIds.length > 0) {
        next = recordEpisode(next, snapshot.chapterNumber, addedIds)
        await writeFileAtomic(factsPath, saveFactsFile(next))
        // 54 ③ 读侧接线：facts.json 变更后失效 temporal cache（空路径键 0:0:0:0 不变）
        clearTemporalFactsCache(pp)
        logger.info("Chapter Ingest", `facts-store ADD ${addedIds.length} facts (chapter ${snapshot.chapterNumber})`)
      }
    }
  } catch (err) {
    logger.warn("Chapter Ingest", "facts-store write skipped", {
      error: toErrorMessage(err),
    })
  }

  // T16 / F-14: canon 影子双写钩子（仅 final/accepted 章触发，deps 缺省空操作）。
  // reject 先于双写断言：draft 章提前 return（not_final）不触达此处。
  await runCanonDualWriteHook(
    canonDualWriteDeps,
    pp,
    fm as Record<string, unknown>,
    snapshot,
    Date.now(),
  )
}
