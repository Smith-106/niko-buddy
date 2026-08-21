/**
 * e2e-chapter-hardgate.spec.ts — T18 组件 3：一章端到端垂直切片硬门（TASK-P1-14）。
 *
 * ## 职责（蓝图 §6 T18 P1 垂直切片硬门）
 *   用 vitest 编排「一章」完整端到端 6 阶段主链，验证 canon 影子双写 → 两阶段重放对账
 *   在 **真实章 / ×5 崩溃 / ×2 重放** 三族场景下始终收敛到 **零差异**（`twoPhaseReconcile`
 *   .alerted === false），作为 T18 P1 硬门的机械收敛判据。硬门未过不进入 P2/P3。
 *
 *   6 阶段（一章）：
 *   1. canon —— 章的新正史事实摄取为 canon 边（T11/T13 语义，in-memory canon_store）
 *   2. 审计 —— 经 T14 `canon-graph-client` 投影读出口 `CanonFact`，禁句柄外泄守护 POV
 *   3. 门控 —— 机械门控：digest 幂等 / 事实数守恒 / 无句柄外泄
 *   4. accept —— final 章允许影子双写（Draft-first：reject 先于双写）
 *   5. 双写 —— T15 `shadowWriteCanon`：legacy 影子 + canon_store 并行写，失败入持久待写队列
 *   6. reconcile —— T17 `twoPhaseReconcile`：先按 digest 重放补齐差异 → 仍不一致才告警
 *
 * ## 场景矩阵
 *   - **真实章场景**：一章含 3 条新正史事实，6 阶段全绿，零差异不告警（alerted === false）。
 *   - **×5 崩溃注入**：SIGKILL(op中断) / 磁盘满(ENOSPC) / 文件锁(EBUSY) / 时钟偏移(重放
 *     期未到→推进后补齐) / producer 中断后 journal 命中跳 LLM —— 一律收敛到零差异。
 *   - **×2 重放**：单缺口重放补齐（replayed=1 → zero）/ 双缺口重放补齐（replayed=2 → zero）。
 *
 * ## mock 策略
 *   全程 **mock LLM**（`producer` 计数 spy，绝不真实调用）；Tauri IPC 用 `@tauri-apps/api/core`
 *   `invoke` mock 成 in-memory canon_store；`@/commands/fs` mock 成内存文件。fixture 内联构造。
 *
 * 遵循 QMAI/CLAUDE.md：T18 组件 3 新增锚点，落 `src/lib/novel/`，纯机械编排零真实 LLM。
 */

import { describe, expect, it, vi, beforeEach } from "vitest"
import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import {
  shadowWriteCanon,
  computeBackoffMs,
  type CanonDualWriteOp,
  type CanonDualWriteDeps,
  type CanonCanonPayload,
  type WriteOutcome,
} from "./canon-dual-write"
import { twoPhaseReconcile, type TwoPhaseReconcileReport } from "./canon-reconcile"
import {
  projectEdges,
  assertNoHandleLeak,
  type RawCanonEdge,
  type CanonEdgeKind,
} from "./canon-graph-client"
import { computeCheckpointDigestOf } from "./checkpoint-digest"
import {
  computeInstructionDigest,
  resolveStageOutput,
  type StageJournalDeps,
} from "./stage-output-journal"

// ──────────────────────────────────────────────────────────────────────────
// Module mock（不依赖 Tauri 运行时，与 T15/T17/T18 spec 同契约）
// ──────────────────────────────────────────────────────────────────────────

vi.mock("@/commands/fs", () => ({
  createDirectory: vi.fn(async () => {}),
  readFile: vi.fn(async () => ""),
  writeFileAtomic: vi.fn(async () => {}),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))

const createDirectoryMock = vi.mocked(createDirectory)
const readFileMock = vi.mocked(readFile)
const writeFileAtomicMock = vi.mocked(writeFileAtomic)

// ──────────────────────────────────────────────────────────────────────────
// Fixture（内联真实书稿章节）
// ──────────────────────────────────────────────────────────────────────────

const CH_ID = "ch1"
const PROJECT = "P:/hardgate"
/** 假时间基座（可复现；时钟偏移场景在其上推进）。 */
const T0 = 1_000_000
/** 超过退避封顶后仍重放的推进量（保证下一条退避已到期）。 */
const T_ADVANCE = computeBackoffMs(3) + 1

/** 一章真实书稿的内联 fixture：第 1 章，含 3 条新正史事实。 */
interface ChapterFixture {
  id: string
  number: number
  title: string
  status: "final"
  newCanonFacts: string[]
}

const REAL_CHAPTER: ChapterFixture = {
  id: CH_ID,
  number: 1,
  title: "第1章 霜刃初雪",
  status: "final",
  newCanonFacts: [
    "主角林澈佩剑名为「霜刃」，为金鳞卫副统领",
    "码头小镇临冬西遭一夜大雪，因雪崩封路与外界隔绝",
    "林澈与郎中姜氏相识于雪夜救使之行",
  ],
}

// ──────────────────────────────────────────────────────────────────────────
// 双写 op 派生（对齐 T1 buildCanonDualWriteOps 的 digest 幂等约定）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 把一章的新正史事实派生为一条双写 op（legacy 影子 + canon episode），
 * digest = T0 source 派生 SHA-256 幂等键；同一事实恒同 digest。
 */
async function buildChapterOps(ch: ChapterFixture): Promise<CanonDualWriteOp[]> {
  return Promise.all(
    ch.newCanonFacts.map(async (fact, i) => {
      const content = { chapter: ch.number, fact }
      const digest = await computeCheckpointDigestOf(content)
      return {
        digest,
        content,
        legacyPayload: { kind: "snapshot_fact", chapterNumber: ch.number, fact },
        canonPayload: canonicalEpisode(ch, i, fact, digest),
      }
    }),
  )
}

/** canon episode 负载（episode 内含写路径幂等键 digest）。 */
function canonicalEpisode(ch: ChapterFixture, i: number, fact: string, digest: string): CanonCanonPayload {
  return {
    kind: "episode",
    episode: {
      id: `${ch.id}-fact${i}`,
      chapter_number: ch.number,
      entity_id: ch.id,
      summary: fact,
      digest,
    },
  }
}

/** 审计投影：guard 后投影，返回投影事实数（无句柄外泄）。 */
function projectAuditCount(edges: RawCanonEdge[]): number {
  const projected = projectEdges(edges)
  for (const f of projected) assertNoHandleLeak(f)
  return projected.length
}

// ──────────────────────────────────────────────────────────────────────────
// in-memory harness（canon_store + dual-write deps）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 内存双写 harness：持有 `edges`(canon_store) 与 `.novel/canon-pending`(queue)。
 * 可注入逐次 canon 失败 / 队列写失败（模拟 SIGKILL/磁盘满/文件锁）。
 */
interface Harness {
  deps: CanonDualWriteDeps
  edges: RawCanonEdge[]
  queue: string
  digestToFact: Map<string, string>
  canonFailCount: number
  canonFailMsg: string
  queueFailCount: number
  queueFailMsg: string
}

/** 构造一条 canon 世界事实边（内部幂等键 digest 在投影后须剥离）。 */
function rawEdge(id: string, chapter: number, digest: string): RawCanonEdge {
  return {
    id: `edge-${id}`,
    source_id: CH_ID,
    target_id: `ent-${id}`,
    predicate: "mentions",
    edge_kind: "world_fact" as CanonEdgeKind,
    valid_at: chapter,
    invalid_at: null,
    reference_time: chapter,
    known_by: ["reader", "林澈"],
    revealed_at: chapter,
    confidence: 1,
    source_chapter: chapter,
    beat_label: null,
    beat_hit: null,
    foreshadow_planted_at: null,
    hook_type: null,
    payoff_chapter: null,
    archived: false,
    digest,
  }
}

function makeHarness(opts: {
  canonFail?: { count: number; msg: string }
  queueFail?: { count: number; msg: string }
} = {}): Harness {
  const h: Harness = {
    deps: undefined as unknown as CanonDualWriteDeps,
    edges: [],
    queue: "",
    digestToFact: new Map(),
    canonFailCount: opts.canonFail?.count ?? 0,
    canonFailMsg: opts.canonFail?.msg ?? "canon crash",
    queueFailCount: opts.queueFail?.count ?? 0,
    queueFailMsg: opts.queueFail?.msg ?? "queue crash",
  }

  const writeCanon: CanonDualWriteDeps["writeCanon"] = async (_projectPath, payload) => {
    const ep = (payload as Extract<CanonCanonPayload, { kind: "episode" }>).episode as {
      digest?: string
      source_chapter?: number
    } & Record<string, unknown>
    const digest = String(ep.digest ?? "")
    if (h.canonFailCount > 0) {
      h.canonFailCount -= 1
      return { ok: false, error: h.canonFailMsg } satisfies WriteOutcome
    }
    const chapter = typeof ep.source_chapter === "number" ? ep.source_chapter : 1
    h.edges.push(rawEdge(`e${h.edges.length}`, chapter, digest))
    return { ok: true, revision: h.edges.length } satisfies WriteOutcome
  }

  const writeLegacy: CanonDualWriteDeps["writeLegacy"] = async () => ({ ok: true } satisfies WriteOutcome)
  const queueRead = async (): Promise<string> => h.queue
  const queueWrite = async (_p: string, contents: string): Promise<void> => {
    if (h.queueFailCount > 0) {
      h.queueFailCount -= 1
      throw new Error(h.queueFailMsg)
    }
    h.queue = contents
  }

  h.deps = { writeCanon, writeLegacy, queueRead, queueWrite }
  return h
}

// ──────────────────────────────────────────────────────────────────────────
// 顶层：一章 6 阶段 runner
// ──────────────────────────────────────────────────────────────────────────

/**
 * 一章端到端：digest 化 → (3)gate → (4)accept → (5)双写 → (6)reconcile →
 * (2)审计。`canonNow` / `reconcileNow` 分离以覆盖重放退避语义。
 */
async function runChapterE2E(
  ch: ChapterFixture,
  h: Harness,
  canonNow: number,
  reconcileNow: number,
): Promise<{
  ops: CanonDualWriteOp[]
  gate: boolean
  accepted: boolean
  written: number
  queued: number
  auditCount: number
  report: TwoPhaseReconcileReport
}> {
  const ops = await buildChapterOps(ch)
  h.digestToFact.clear()
  ops.forEach((op, i) => h.digestToFact.set(op.digest!, ch.newCanonFacts[i]!))

  // (3) gate：digest 幂等 + 事实数守恒
  const gate = ops.length === ch.newCanonFacts.length && new Set(ops.map((o) => o.digest)).size === ops.length
  // (4) accept：final 放行双写
  const accepted = ch.status === "final"

  // (5) 双写
  const dual = await shadowWriteCanon(h.deps, PROJECT, ops, canonNow)
  // (6) reconcile
  const report = await twoPhaseReconcile(h.deps, PROJECT, dual.results, reconcileNow)
  // (2) audit：重放完成后 canon_store 回读投影
  const auditCount = projectAuditCount(h.edges)

  return { ops, gate, accepted, written: dual.written, queued: dual.queued, auditCount, report }
}

/** 内存 journal deps（T18 组件1 指令 digest 键工件缓存）。 */
function memJournal(): { deps: StageJournalDeps; files: Map<string, string> } {
  const files = new Map<string, string>()
  const deps: StageJournalDeps = {
    read: async (p) => files.get(p) ?? "",
    writeFile: async (p, c) => {
      files.set(p, c)
    },
    createDirectory: async () => {},
  }
  return { deps, files }
}

beforeEach(() => {
  createDirectoryMock.mockReset()
  readFileMock.mockReset()
  writeFileAtomicMock.mockReset()
  createDirectoryMock.mockResolvedValue(undefined)
  readFileMock.mockResolvedValue("")
  writeFileAtomicMock.mockResolvedValue(undefined)
})

// ══════════════════════════════════════════════════════════════════════════
// 真实章六阶段全绿
// ══════════════════════════════════════════════════════════════════════════

describe("场景① 真实章（canon→审计→门控→accept→双写→reconcile 零差异）", () => {
  it("一章 3 条新正史事实全绿：gate/accept 通过、零入队、reconcile 不告警", async () => {
    const h = makeHarness()
    const { gate, accepted, written, queued, auditCount, report } = await runChapterE2E(REAL_CHAPTER, h, T0, T0)

    // 门控 / accept
    expect(gate).toBe(true)
    expect(accepted).toBe(true)
    // 双写：全部一致、零入队
    expect(written).toBe(REAL_CHAPTER.newCanonFacts.length)
    expect(queued).toBe(0)
    // 审计：canon_store 回读投影，禁句柄无外泄，事实数守恒
    expect(auditCount).toBe(REAL_CHAPTER.newCanonFacts.length)
    // reconcile：初始一致、零差异、不告警
    expect(report.initialConsistent).toBe(true)
    expect(report.finalConsistent).toBe(true)
    expect(report.replayReport).toBeNull()
    expect(report.finalDivergences).toEqual([])
    expect(report.alerted).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════════════
//  ×5 崩溃注入：一律收敛到零差异
// ══════════════════════════════════════════════════════════════════════════

describe("场景② ×5 崩溃注入 —— 每例最终 reconcile 零差异不告警", () => {
  it("崩溃-1 SIGKILL（canon 写中断一次）→ 落待写队列 → 重放补齐 → zero", async () => {
    const h = makeHarness({ canonFail: { count: 1, msg: "SIGKILL" } })
    const out = await runChapterE2E(REAL_CHAPTER, h, T0, T0 + T_ADVANCE)
    expect(out.queued).toBe(1)
    expect(out.written).toBe(REAL_CHAPTER.newCanonFacts.length - 1)
    expect(out.report.replayedDigests).toHaveLength(1)
    expect(out.report.initialConsistent).toBe(false)
    expect(out.report.finalConsistent).toBe(true)
    expect(out.report.finalDivergences).toEqual([])
    expect(out.report.alerted).toBe(false)
    // 不静默吞：重放 gap 已补齐，但 trace 留有 reconcile-initial 阶段证据
    expect(out.report.trace.some((e) => e.phase === "reconcile-initial")).toBe(true)
    expect(out.report.trace.some((e) => e.phase === "alert")).toBe(false)
  })

  it("崩溃-2 磁盘满(ENOSPC)：队列持久化写失败 → 重run 收敛 zero", async () => {
    // 首次：canon 失败 1 次产生 pending，队列写 ENOSPC 抛错（无法落盘）
    const h = makeHarness({ canonFail: { count: 1, msg: "canon boom" }, queueFail: { count: 1, msg: "ENOSPC" } })
    const ops = await buildChapterOps(REAL_CHAPTER)
    h.digestToFact.clear()
    ops.forEach((op, i) => h.digestToFact.set(op.digest!, REAL_CHAPTER.newCanonFacts[i]!))
    await expect(shadowWriteCanon(h.deps, PROJECT, ops, T0)).rejects.toThrow("ENOSPC")

    // 磁盘修复后全新一轮 → 收敛零差异
    const h2 = makeHarness()
    const out = await runChapterE2E(REAL_CHAPTER, h2, T0, T0)
    expect(out.queued).toBe(0)
    expect(out.auditCount).toBe(REAL_CHAPTER.newCanonFacts.length)
    expect(out.report.alerted).toBe(false)
  })

  it("崩溃-3 文件锁(EBUSY)：队列持久化写被锁 → 重试收敛 zero", async () => {
    const h = makeHarness({ canonFail: { count: 1, msg: "canon boom" }, queueFail: { count: 1, msg: "EBUSY" } })
    const ops = await buildChapterOps(REAL_CHAPTER)
    h.digestToFact.clear()
    ops.forEach((op, i) => h.digestToFact.set(op.digest!, REAL_CHAPTER.newCanonFacts[i]!))
    await expect(shadowWriteCanon(h.deps, PROJECT, ops, T0)).rejects.toThrow("EBUSY")

    const h2 = makeHarness()
    const out2 = await runChapterE2E(REAL_CHAPTER, h2, T0, T0)
    expect(out2.report.alerted).toBe(false)
  })

  it("崩溃-4 时钟偏移：重放在退避窗口内被跳过 → 推进时钟后重放补齐 zero", async () => {
    const h = makeHarness({ canonFail: { count: 1, msg: "clock skew op" } })
    const ops = await buildChapterOps(REAL_CHAPTER)
    h.digestToFact.clear()
    ops.forEach((op, i) => h.digestToFact.set(op.digest!, REAL_CHAPTER.newCanonFacts[i]!))

    // 双写：1 失败入队
    const dual = await shadowWriteCanon(h.deps, PROJECT, ops, T0)
    expect(dual.queued).toBe(1)

    // 时钟偏移：仍在退避窗口内重放 → 未到期 skip → 如实：仍不一致 + 告警
    const early = await twoPhaseReconcile(h.deps, PROJECT, dual.results, T0)
    expect(early.replayReport!.skipped).toBe(1)
    expect(early.alerted).toBe(true)

    // 推进时钟（> 退避封顶）→ 重放到期补齐 → zero
    const late = await twoPhaseReconcile(h.deps, PROJECT, dual.results, T0 + T_ADVANCE)
    expect(late.replayReport!.succeeded).toBe(1)
    expect(late.replayedDigests).toHaveLength(1)
    expect(late.alerted).toBe(false)
  })

  it("崩溃-5 producer 中断：journal 命中 → 跳过 LLM 重调 → 双写仍收敛 zero", async () => {
    const { deps } = memJournal() // in-memory journal（指令 digest 键缓存）
    const instruction = { ch: 2, cmd: "generate_body" }
    const digest = await computeInstructionDigest(instruction)
    const stage = "chapter-body"

    // 第一次：未命中 → 由 producer（充当 LLM）生产并落盘
    let llmCalls = 0
    const producer = async () => {
      llmCalls += 1
      return { body: "第2章 长夜" }
    }
    const first = await resolveStageOutput(deps, PROJECT, digest, stage, producer, T0)
    expect(first.hit).toBe(false)
    expect(llmCalls).toBe(1)

    // "崩溃重入"：同一 digest+stage → 命中缓存，producer 不被调（跳过 LLM 重叫）
    const second = await resolveStageOutput(deps, PROJECT, digest, stage, producer, T0 + 1)
    expect(second.hit).toBe(true)
    expect(llmCalls).toBe(1)

    // 双写层不背 LLM 影响 → 零差异
    const h = makeHarness()
    const out = await runChapterE2E(REAL_CHAPTER, h, T0, T0)
    expect(out.report.alerted).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════════════
//  ×2 重放：缺口重放补齐后零差异
// ══════════════════════════════════════════════════════════════════════════

describe("场景③ ×2 重放（缺口补齐 → zero）", () => {
  it("单缺口：1 条事实入队 → 重放补齐 1 → zero", async () => {
    const h = makeHarness({ canonFail: { count: 1, msg: "boom" } })
    const out = await runChapterE2E(REAL_CHAPTER, h, T0, T0 + T_ADVANCE)
    expect(out.queued).toBe(1)
    expect(out.report.replayedDigests).toHaveLength(1)
    expect(out.report.finalConsistent).toBe(true)
    expect(out.report.alerted).toBe(false)
  })

  it("双缺口：2 条事实入队 → 重放补齐 2 → zero", async () => {
    const h = makeHarness({ canonFail: { count: 2, msg: "boom" } })
    const out = await runChapterE2E(REAL_CHAPTER, h, T0, T0 + T_ADVANCE)
    expect(out.queued).toBe(2)
    expect(out.report.replayedDigests).toHaveLength(2)
    expect(out.report.finalConsistent).toBe(true)
    expect(out.report.finalDivergences).toEqual([])
    expect(out.report.alerted).toBe(false)
  })
})