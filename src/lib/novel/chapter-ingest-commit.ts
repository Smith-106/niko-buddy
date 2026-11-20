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
import { computeCheckpointDigest } from "./checkpoint-digest"
import { clearTemporalFactsCache } from "./context-engine"
import {
  linkSnapshotEntities,
  validateCanonConflicts,
  validateEntityReferences,
} from "./chapter-ingest-entity-validation"
import { parseFactsSubject } from "./chapter-ingest-utils"
import { runTruthAuthorityCheck } from "./truth-authority-adapter"
import { saveChapterIngestOutput, saveSnapshot } from "./chapter-ingest-snapshot-io"
import type { CanonDualWriteDeps, ShadowWriteReport } from "./canon-dual-write"
import type { ChapterSnapshot } from "./chapter-ingest"

/**
 * 本次 ingest 实际读到章节源（仅局部/内部传递；`originalContent` 绝不进入
 * 对外 receipt 或日志）。`readPath` 是 ingestChapter 自己的 chapterPath 实参，
 * 即 resolveIngestTarget 传给它 readFile 的同一个字符串。
 */
export interface IngestSourceRead extends IngestSourceBinding {
  originalContent: string
}

/** 可发布的无正文源引用（receipt / sourceBinding 的唯一形态）。 */
export interface IngestSourceBinding {
  readPath: string
  chapterNumber: number
  /** 完整 parsed.body 原始字符串的 SHA-256（无 trim/slice/规范化）。 */
  bodySha256: string
  /** 完整章节文件 content 原始字符串的 SHA-256。 */
  contentSha256: string
}

/**
 * 本次实际 Canon 双写 outcome（原 report/跳过/失败原样透传）。
 * `skipped` 只表示未发生 canon 写；`completed` 携带既有 ShadowWriteReport。
 */
export type CanonDualWriteOutcome =
  | { status: "skipped"; reason: "no_deps" | "not_eligible" | "no_facts" }
  | { status: "completed"; report: ShadowWriteReport }
  | { status: "failed"; reason: string }

/**
 * 提取提交点的瞬时 receipt：绑定本次读到的源、saver 实际序列化的 normalized
 * snapshot 身份/JSON SHA 与同一调用的 Canon outcome。不含正文文本。
 */
export interface IngestCommitReceipt {
  readPath: string
  chapterNumber: number
  bodySha256: string
  contentSha256: string
  /** saver 写盘对象的 snapshotId（取自 ensureSnapshotIdentity）。 */
  snapshotIdAtExtractionCommit: string | null
  /** snapshot 自身 revision（≠ 正文 revision，≠ Canon IPC max_revision）。 */
  snapshotRevisionAtExtractionCommit: number | null
  /** 与 saver 实际 JSON 写入同样序列化的 normalized snapshot 的 SHA-256。 */
  snapshotJsonSha256AtExtractionCommit: string
  canonOutcome: CanonDualWriteOutcome
}

/**
 * 提交点的 discriminated 结果：成功只有 `committed`，拒绝三分支只携带无正文的
 * `sourceReadRef`（未捕获源时为 null），绝不携带 snapshot/Canon 字段。
 */
export type CommitIngestSnapshotResult =
  | {
      status: "committed"
      /** saver 实际返回并序列化落盘的 normalized snapshot（identity 已就位）。 */
      snapshot: ChapterSnapshot
      canonOutcome: CanonDualWriteOutcome
      /** 本次提交实际绑定的源；legacy 无 sourceRead 调用为 null（不等于已绑定）。 */
      sourceBinding: IngestSourceBinding | null
      /** 成功 receipt；legacy 无 sourceRead 调用为 null。 */
      receipt: IngestCommitReceipt | null
    }
  | { status: "source_changed"; sourceReadRef: IngestSourceBinding | null }
  | { status: "source_unavailable"; sourceReadRef: IngestSourceBinding | null; reason: string }
  | { status: "cancelled"; sourceReadRef: IngestSourceBinding | null }

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
  ) => Promise<CanonDualWriteOutcome>
  /**
   * 本次实际读取的章节源（生产 ingest 必须传入）。缺省 = 既有 leaf 直调兼容
   * 路径：不去读第二遍源、sourceBinding/receipt 为 null。
   */
  sourceRead?: IngestSourceRead
  /** 同一 AbortSignal（提交前取消检查用；缺省 = 无取消语义）。 */
  signal?: AbortSignal
}

/** 内部源观察值 → 可发布的无正文引用。 */
function toSourceBinding(sourceRead: IngestSourceRead): IngestSourceBinding {
  return {
    readPath: sourceRead.readPath,
    chapterNumber: sourceRead.chapterNumber,
    bodySha256: sourceRead.bodySha256,
    contentSha256: sourceRead.contentSha256,
  }
}

/**
 * 提交一章的摄取结果。**永不抛错**：内部所有失败都降级为 warn，
 * 保证调用方拿到的 snapshot 已尽可能落盘。
 *
 * 源守卫（仅 sourceRead 存在时）：实体校验结束后、saveSnapshot 之前对**同一**
 * readPath 读一次完整内容，与本次提取实际使用的 originalContent 严格相等才提交。
 * 该检查在 validation 的非致命 catch 之外——changed/unavailable/cancelled 都是
 * 本次提交的明确拒绝，不会降级成警告后继续落盘。
 */
export async function commitIngestSnapshot(params: CommitIngestSnapshotParams): Promise<CommitIngestSnapshotResult> {
  const { pp, snapshot, fm, canonDualWriteDeps, runCanonDualWriteHook, sourceRead, signal } = params
  const sourceReadRef = sourceRead ? toSourceBinding(sourceRead) : null

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

  // 提交前源守卫：同路径完整内容严格比对 + 同一 AbortSignal 检查，均在
  // saveSnapshot 之前。仅覆盖本次章节提取提交；不含之后 syncSnapshotToMemory、
  // 跨进程 CAS 或 ABA。
  if (sourceRead) {
    let currentContent: string
    try {
      currentContent = await readFile(sourceRead.readPath)
    } catch (err) {
      logger.warn("Chapter Ingest", "Pre-commit source read failed (rejecting this commit)", {
        path: sourceRead.readPath,
        error: toErrorMessage(err),
      })
      return { status: "source_unavailable", sourceReadRef, reason: toErrorMessage(err) }
    }
    if (currentContent !== sourceRead.originalContent) {
      logger.warn("Chapter Ingest", "Chapter source changed before commit (rejecting this commit)", {
        path: sourceRead.readPath,
      })
      return { status: "source_changed", sourceReadRef }
    }
    if (signal?.aborted) {
      return { status: "cancelled", sourceReadRef }
    }
  }

  // saver 返回**它实际序列化落盘**的 normalized snapshot；提交点内部的 output/
  // Canon/receipt 共用这一个值（snapshot JSON 可能含 extraction 时不存在的新身份）。
  const committedSnapshot = await saveSnapshot(pp, snapshot)
  await saveChapterIngestOutput(pp, committedSnapshot, {
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
  const canonOutcome = await runCanonDualWriteHook(
    canonDualWriteDeps,
    pp,
    fm as Record<string, unknown>,
    committedSnapshot,
    Date.now(),
  )

  const sourceBinding = sourceRead ? toSourceBinding(sourceRead) : null
  const receipt: IngestCommitReceipt | null = sourceRead && sourceBinding
    ? {
        ...sourceBinding,
        snapshotIdAtExtractionCommit: committedSnapshot.snapshotId ?? null,
        snapshotRevisionAtExtractionCommit: committedSnapshot.revision ?? null,
        snapshotJsonSha256AtExtractionCommit: await computeCheckpointDigest(
          JSON.stringify(committedSnapshot, null, 2),
        ),
        canonOutcome,
      }
    : null

  return { status: "committed", snapshot: committedSnapshot, canonOutcome, sourceBinding, receipt }
}
