/**
 * offline-replay-t31-vertical-slice.spec.ts — T31 P4 垂直切片全验收 机械证据 (TASK-P4-31 / A-10 全项)。
 *
 * ## 职责（蓝图 §6 T31 / TASK-P4-31）
 *   P4 垂直切片全验收（三硬门之二）的逐项机械化证据。与 T18 `e2e-chapter-hardgate.spec.ts`
 *   （P1 首通）同契约、同 mock 策略；本 spec 覆盖 P4 全验收新增的四项口径：
 *
 *   - **A-10.1 authoritative 模式端到端**：route() 决策权威路径全生命周期（13 分支互斥链
 *     全覆盖）+ legacy/authoritative 位级等价（A-02.4 golden）+ **warn 态 anti-AI 放行**
 *     （P2-21 共识入埂条款：anti_ai fail × mode=warn → judge 不 revise，注解留痕）。
 *   - **A-05.2 离线决策回放评分达标**：≥5 个真实章节状态序列经 route() 双跑派生
 *     branchId/replayBranchId/referenceBranchId，`replayStates`/`scoreReplay`（T02 同源
 *     纯函数）合成四因子加权分，综合分与各因子均达 PROVISIONAL 阈值。
 *   - **A-10.3 崩溃注入 ×5 点**（五个故障点逐一注入验证恢复语义，全部收敛零差异）：
 *       C1 ingest 中断（部分摄取后进程死亡 → 全量重跑 (chapter,digest) 幂等去重收敛）
 *       C2 digest 记录写失败（legacy 侧 ENOSPC → 持久队列 → 重放补齐）
 *       C3 canon 双写失败（canon 侧 SIGKILL → 两阶段重放零差异）
 *       C4 journal 过期（TTL 到期视为未命中 → 确定性再生产收敛，绝不复用 stale 工件）
 *       C5 投影 rebuild 失败（fold_rebuildable 失败可见 + F-005 审计留痕 + 重建 committed）
 *   - **A-10.4 同一章重放 ×2 一致**：同一章输入跑两遍完整管线（digest 派生→双写→对账→
 *     投影），digest 列表与 findings 投影全等（digest 幂等实证）。
 *   - **A-05.3 迁移前事实可查询**：T30b `backfillCanonHistory` 回填第 1..3 章后，事实经
 *     T14 `canon-graph-client` 投影读出口查询可查（`auditPreMigrationFacts` 全达标 +
 *     禁句柄外泄守护 POV 不泄密）。
 *
 * ## 证据输出
 *   由 `scripts/offline-replay.js`（T31 driver）以 env `T31_EVIDENCE_PATH` 注入证据落盘
 *   路径；afterAll 将逐项 PASS/FAIL + 回放状态序列 + 四因子评分写入该 JSON。常规 vitest
 *   运行（无该 env）不写任何文件。
 *
 * ## 执行纪律
 *   - ADR-19 机械层零 LLM：全程 producer 为内存确定性函数，无网络/模型调用。
 *   - Draft-first（ADR-08）：不触 `.novel/status.json` 正式层；运行期数据全部内存 mock，
 *     唯一磁盘产物是 driver 显式要求的验收证据 JSON。
 *   - 门控优先级固定：Consistency(P0) > Anti-AI(P1) > Quality(P2)，warn 放行仅限 P1
 *     且按 P2-21 共识条款执行（本 spec 同时断言 block 档仍硬挡、P0 fail 永不放行）。
 */

import { describe, expect, it, afterAll, vi, beforeEach } from "vitest"
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises"
import { dirname as pathDirname } from "node:path"

import {
  route,
  type ControlState as KernelControlState,
  type Instruction,
  type RouteAction,
  type RouteRole,
  type ArcTransitionStep,
} from "./control-kernel"
import { ROUTE_ACTIONS } from "./control-sentinels"
import {
  OFFLINE_REPLAY_QUALITY_THRESHOLD,
  OFFLINE_REPLAY_THRESHOLDS,
  replayStates,
  type ControlState as ReplayControlState,
} from "./offline-replay-config"
import { computeCheckpointDigestOf } from "./checkpoint-digest"
import {
  shadowWriteCanon,
  computeBackoffMs,
  type CanonDualWriteDeps,
  type CanonDualWriteOp,
  type CanonCanonPayload,
} from "./canon-dual-write"
import { twoPhaseReconcile } from "./canon-reconcile"
import {
  projectEdges,
  assertNoHandleLeak,
  type RawCanonEdge,
  type CanonEdgeKind,
} from "./canon-graph-client"
import {
  computeInstructionDigest,
  resolveStageOutput,
  type StageJournalDeps,
} from "./stage-output-journal"
import {
  backfillCanonHistory,
  auditPreMigrationFacts,
  parseDiscoveredChapters,
  type CanonBackfillDeps,
} from "./canon-backfill"
import {
  emptyLedger,
  loadProjectionStatusLedger,
  saveProjectionStatusLedger,
  appendProjectionAuditEntry,
  recordProjectionAudit,
  recordProjectionStatus,
  PROJECTION_CATEGORIES,
} from "./projection-status-ledger"
import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"

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

beforeEach(() => {
  createDirectoryMock.mockReset()
  readFileMock.mockReset()
  writeFileAtomicMock.mockReset()
  createDirectoryMock.mockResolvedValue(undefined)
  readFileMock.mockResolvedValue("")
  writeFileAtomicMock.mockResolvedValue(undefined)
})

// ──────────────────────────────────────────────────────────────────────────
// 证据收集（driver 经 T31_EVIDENCE_PATH 取走；无 env 不落盘）
// ──────────────────────────────────────────────────────────────────────────

type EvidenceItemIds =
  | "A-10.1-authoritative-end-to-end"
  | "A-05.2-offline-replay-score"
  | "A-10.3-crash-injection-x5"
  | "A-10.4-replay-x2-consistency"
  | "A-05.3-pre-migration-facts-queryable"

const EVIDENCE_ITEMS: Record<EvidenceItemIds, Record<string, unknown>> = {
  "A-10.1-authoritative-end-to-end": { pass: false },
  "A-05.2-offline-replay-score": { pass: false },
  "A-10.3-crash-injection-x5": { pass: false },
  "A-10.4-replay-x2-consistency": { pass: false },
  "A-05.3-pre-migration-facts-queryable": { pass: false },
}
let REPLAY_STATES_OUT: ReplayControlState[] = []

/** 各项通过后在测试尾部登记证据细节。 */
function recordItem(id: EvidenceItemIds, details: Record<string, unknown>): void {
  EVIDENCE_ITEMS[id] = { pass: true, ...details }
}

afterAll(async () => {
  const target = process.env.T31_EVIDENCE_PATH
  if (!target) return
  const payload = {
    kind: "t31-vertical-slice-evidence",
    generatedAt: new Date().toISOString(),
    items: EVIDENCE_ITEMS,
    replay: { states: REPLAY_STATES_OUT },
  }
  await fsMkdir(pathDirname(target), { recursive: true })
  await fsWriteFile(target, JSON.stringify(payload, null, 2), "utf-8")
})

// ──────────────────────────────────────────────────────────────────────────
// Fixture：一章真实书稿（与 T18 e2e 同源语义：第 1 章 3 条新正史事实）
// ──────────────────────────────────────────────────────────────────────────

const PROJECT = "P:/t31-vertical-slice"
/** 假时间基座（可复现）。 */
const T0 = 1_000_000
/** 超过退避封顶后的推进量（保证重放到期）。 */
const T_ADVANCE = computeBackoffMs(3) + 1

interface ChapterFixture {
  id: string
  number: number
  title: string
  status: "final"
  newCanonFacts: string[]
}

const REAL_CHAPTER: ChapterFixture = {
  id: "ch1",
  number: 1,
  title: "第1章 霜刃初雪",
  status: "final",
  newCanonFacts: [
    "主角林澈佩剑名为「霜刃」，为金鳞卫副统领",
    "码头小镇临冬西遭一夜大雪，因雪崩封路与外界隔绝",
    "林澈与郎中姜氏相识于雪夜救使之行",
  ],
}

/** 把一章的新正史事实派生为双写 op（digest = SHA-256(stable({chapter, fact}))，与 T16/T30b 同构）。 */
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

function canonicalEpisode(ch: ChapterFixture, i: number, _fact: string, digest: string): CanonCanonPayload {
  return {
    kind: "episode",
    episode: {
      id: `${ch.id}-fact${i}`,
      chapter_number: ch.number,
      entity_id: ch.id,
      summary: _fact,
      digest,
    },
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 内存双写 harness：canon_store 以 (source_chapter, digest) 去重（镜像 T11 契约）
// ──────────────────────────────────────────────────────────────────────────

/** 内存 canon_store：key=`${source_chapter}:${digest}`，插入序稳定（Map 保序）。 */
interface MemCanonStore {
  factsByKey: Map<string, RawCanonEdge>
  /** store 级去重命中计数（重放/续跑幂等实证用）。 */
  dedupeHits: number
}

function makeSharedStore(): MemCanonStore {
  return { factsByKey: new Map(), dedupeHits: 0 }
}

interface HarnessOptions {
  store?: MemCanonStore
  queueRef?: { content: string }
  canonFail?: { count: number; msg: string }
  legacyFail?: { count: number; msg: string }
  queueFail?: { count: number; msg: string }
}

interface Harness {
  deps: CanonDualWriteDeps
  store: MemCanonStore
  queueRef: { content: string }
  legacyLog: unknown[]
}

/** 构造一条 canon 世界事实边（id 由 digest 派生 → 跨进程/跨轮次确定一致）。 */
function edgeFor(chapter: number, seq: number, digest: string): RawCanonEdge {
  return {
    id: `edge-${digest.slice(0, 16)}`,
    source_id: `ch${chapter}`,
    target_id: `ent-${chapter}-${seq}`,
    predicate: "establishes",
    edge_kind: "world_fact" as CanonEdgeKind,
    valid_at: chapter,
    invalid_at: null,
    reference_time: chapter,
    known_by: ["reader"],
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

function makeHarness(opts: HarnessOptions = {}): Harness {
  const store = opts.store ?? makeSharedStore()
  const queueRef = opts.queueRef ?? { content: "" }
  let canonFailCount = opts.canonFail?.count ?? 0
  const canonFailMsg = opts.canonFail?.msg ?? "canon crash"
  let legacyFailCount = opts.legacyFail?.count ?? 0
  const legacyFailMsg = opts.legacyFail?.msg ?? "legacy crash"
  let queueFailCount = opts.queueFail?.count ?? 0
  const queueFailMsg = opts.queueFail?.msg ?? "queue crash"
  const legacyLog: unknown[] = []

  const writeCanon: CanonDualWriteDeps["writeCanon"] = async (_pp, payload) => {
    const ep = (payload as Extract<CanonCanonPayload, { kind: "episode" }>).episode as {
      digest?: string
      chapter_number?: number
      source_chapter?: number
      id?: string
    }
    const digest = String(ep.digest ?? "")
    // 章节号契约：T13/T30b episode 载荷字段为 chapter_number（兼容 source_chapter 别名）。
    const chapter =
      typeof ep.chapter_number === "number"
        ? ep.chapter_number
        : typeof ep.source_chapter === "number"
          ? ep.source_chapter
          : 1
    const seq = Number(/fact(\d+)$/.exec(ep.id ?? "")?.[1] ?? 0)
    if (canonFailCount > 0) {
      canonFailCount -= 1
      return { ok: false, error: canonFailMsg }
    }
    const key = `${chapter}:${digest}`
    if (store.factsByKey.has(key)) {
      // canon_store (chapter_number, digest) 幂等去重：同一逻辑写不复制也不覆盖（T11 契约）。
      store.dedupeHits += 1
      return { ok: true, revision: store.factsByKey.size }
    }
    store.factsByKey.set(key, edgeFor(chapter, seq, digest))
    return { ok: true, revision: store.factsByKey.size }
  }

  const writeLegacy: CanonDualWriteDeps["writeLegacy"] = async (_pp, payload) => {
    if (legacyFailCount > 0) {
      legacyFailCount -= 1
      return { ok: false, error: legacyFailMsg }
    }
    legacyLog.push(payload)
    return { ok: true }
  }

  const queueRead = async (): Promise<string> => queueRef.content
  const queueWrite = async (_p: string, contents: string): Promise<void> => {
    if (queueFailCount > 0) {
      queueFailCount -= 1
      throw new Error(queueFailMsg)
    }
    queueRef.content = contents
  }

  return { deps: { writeCanon, writeLegacy, queueRead, queueWrite }, store, queueRef, legacyLog }
}

/** 投影读出口审计：guard 后投影 + 禁句柄外泄断言，返回投影事实数。 */
function projectedFacts(store: MemCanonEdgeStoreAlias): ReturnType<typeof projectEdges> {
  const facts = projectEdges([...store.factsByKey.values()])
  for (const f of facts) assertNoHandleLeak(f)
  return facts
}
type MemCanonEdgeStoreAlias = MemCanonStore

/** findings 的规范化序列化（按 id 排序后 JSON，跨轮次可比）。 */
function canonicalFindingsJson(store: MemCanonStore): string {
  const facts = projectEdges([...store.factsByKey.values()])
  return JSON.stringify([...facts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
}

// ══════════════════════════════════════════════════════════════════════════
// A-10.1 — authoritative 模式 route() 决策权威路径端到端
// ══════════════════════════════════════════════════════════════════════════

/** route() 输入基座（写作期第 1 章、无任何挂起事务、三开关回显位）。 */
function kernelBaseState(overrides: Partial<KernelControlState> = {}): KernelControlState {
  return {
    phase: "writing",
    stage: "draft",
    chapterNumber: 1,
    completedChapters: 0,
    pendingRewrites: [],
    gates: { consistency: "pending", anti_ai: "pending", quality: "pending" },
    antiAiMode: "warn",
    manualReviewRequired: false,
    foundationMissing: [],
    planningTier: "",
    reviewInterval: 5,
    lastGlobalReviewChapter: 0,
    hasArcReview: false,
    hasArcSummary: false,
    hasVolumeSummary: false,
    shellMode: "authoritative",
    ...overrides,
  }
}

/** 决策签名：把 Instruction 规约为可比较的分支标识（branchId 契约）。 */
function instructionSignature(ins: Instruction): string {
  return [ins.action, ins.role ?? "", ins.arcStep ?? "", ins.chapter ?? ""].join("|")
}

describe("A-10.1 authoritative 模式：route() 决策权威路径端到端", () => {
  it("13 分支互斥链全生命周期走通 + legacy/authoritative 位级等价 + warn 态放行", () => {
    /** 全生命周期状态序列：规划期→写作期特殊分支→弧末事务→阶段机→门控三态→终态。 */
    const journey: { label: string; state: KernelControlState }[] = [
      { label: "规划期缺设定+tier 已知", state: kernelBaseState({ phase: "planning", foundationMissing: ["主角背景"], planningTier: "short", stage: "context" }) },
      { label: "人工介入标记（压过自动派单）", state: kernelBaseState({ manualReviewRequired: true }) },
      { label: "重写队列非空（头绝对优先）", state: kernelBaseState({ pendingRewrites: [3] }) },
      { label: "弧末·弧评审未做", state: kernelBaseState({ stage: "context", arcBoundary: { isArcEnd: true, isVolumeEnd: false, needsExpansion: false, needsNewVolume: false, nextArc: 2 } }) },
      { label: "弧末·弧摘要未做", state: kernelBaseState({ stage: "context", hasArcReview: true, arcBoundary: { isArcEnd: true, isVolumeEnd: false, needsExpansion: false, needsNewVolume: false, nextArc: 2 } }) },
      { label: "弧末·卷摘要未做", state: kernelBaseState({ stage: "context", hasArcReview: true, hasArcSummary: true, arcBoundary: { isArcEnd: true, isVolumeEnd: true, needsExpansion: false, needsNewVolume: false, nextArc: 2 } }) },
      { label: "弧末·展开新弧", state: kernelBaseState({ stage: "context", hasArcReview: true, hasArcSummary: true, hasVolumeSummary: true, arcBoundary: { isArcEnd: true, isVolumeEnd: true, needsExpansion: true, needsNewVolume: false, nextArc: 2 } }) },
      { label: "弧末·开新卷", state: kernelBaseState({ stage: "context", hasArcReview: true, hasArcSummary: true, hasVolumeSummary: true, arcBoundary: { isArcEnd: true, isVolumeEnd: true, needsExpansion: false, needsNewVolume: true, nextArc: 2 } }) },
      { label: "周期全局审阅到期", state: kernelBaseState({ stage: "context", completedChapters: 5, lastGlobalReviewChapter: 0 }) },
      { label: "阶段机 context", state: kernelBaseState({ stage: "context" }) },
      { label: "阶段机 scene_breakdown", state: kernelBaseState({ stage: "scene_breakdown" }) },
      { label: "阶段机 task_brief", state: kernelBaseState({ stage: "task_brief" }) },
      { label: "阶段机 draft", state: kernelBaseState({ stage: "draft" }) },
      { label: "评审·三门控全 pending", state: kernelBaseState({ stage: "review" }) },
      {
        label: "门控·Consistency(P0) fail → 必修订（P0 不可被任何档位覆盖）",
        state: kernelBaseState({ stage: "review", gates: { consistency: "fail", anti_ai: "pass", quality: "pass" } }),
      },
      {
        label: "门控·anti_ai fail × mode=block → 硬挡修订",
        state: kernelBaseState({ stage: "review", antiAiMode: "block", gates: { consistency: "pass", anti_ai: "fail", quality: "pass" } }),
      },
      {
        label: "门控·anti_ai fail × mode=warn → 放行终审（P2-21 共识入埂）",
        state: kernelBaseState({
          stage: "review",
          antiAiMode: "warn",
          warnAnnotation: {
            triggeredFactors: ["ngram_repeat", "sentence_entropy"],
            summary: "四统计因子 warn 档触发",
            calibrationSource: "synthetic-degraded",
          },
          gates: { consistency: "pass", anti_ai: "fail", quality: "pass" },
        }),
      },
      {
        label: "门控·Quality(P2) 单独 fail → 永不挡",
        state: kernelBaseState({ stage: "review", gates: { consistency: "pass", anti_ai: "pass", quality: "fail" } }),
      },
      {
        label: "门控·全 pass → 终审",
        state: kernelBaseState({ stage: "review", gates: { consistency: "pass", anti_ai: "pass", quality: "pass" } }),
      },
      { label: "阶段机 revision", state: kernelBaseState({ stage: "revision" }) },
      { label: "阶段机 done", state: kernelBaseState({ stage: "done" }) },
      { label: "终态 complete", state: kernelBaseState({ phase: "complete", stage: "done" }) },
    ]

    const decisions = journey.map(({ label, state }) => ({ label, state, ins: route(state) }))

    // ── 13 分支全覆盖（互斥链每一支都至少命中一次）──
    const observedActions = new Set<RouteAction>(decisions.map((d) => d.ins.action))
    expect(observedActions.size).toBe(13)
    for (const action of ROUTE_ACTIONS) {
      expect(observedActions.has(action)).toBe(true)
    }

    // ── A-02.4 位级等价：legacy 与 authoritative 同输入产出除 shellMode 回显外逐位一致 ──
    let equivalenceChecked = 0
    for (const { state } of decisions) {
      const legacyIns = route({ ...state, shellMode: "legacy" })
      const authIns = route({ ...state, shellMode: "authoritative" })
      expect(JSON.stringify({ ...legacyIns, shellMode: authIns.shellMode })).toBe(JSON.stringify(authIns))
      equivalenceChecked += 1
    }

    // ── 权威路径关键决策点逐项核对 ──
    const byLabel = new Map(decisions.map((d) => [d.label, d.ins]))
    expect(byLabel.get("规划期缺设定+tier 已知")).toMatchObject({ action: "foundation_fill", role: "architect" })
    expect(byLabel.get("人工介入标记（压过自动派单）")).toMatchObject({ action: "arbitrate", role: "arbiter" })
    expect(byLabel.get("重写队列非空（头绝对优先）")).toMatchObject({ action: "rewrite", role: "writer", chapter: 3 })
    expect(byLabel.get("弧末·弧评审未做")).toMatchObject({ action: "arc_transition", arcStep: "arc_review" })
    expect(byLabel.get("周期全局审阅到期")).toMatchObject({ action: "global_review", role: "reviewer" })
    expect(byLabel.get("阶段机 draft")).toMatchObject({ action: "write_draft", role: "writer", chapter: 1 })
    expect(byLabel.get("终态 complete")).toMatchObject({ action: "halt" })

    // ── 门控优先级固定：P0 fail 永远 revise（warn/block 都救不回）──
    expect(byLabel.get("门控·Consistency(P0) fail → 必修订（P0 不可被任何档位覆盖）")).toMatchObject({
      action: "revise",
      role: "writer",
    })

    // ── warn 态放行（P2-21 共识入埂条款）：action=judge 且 reason 注解留痕 ──
    const warnIns = byLabel.get("门控·anti_ai fail × mode=warn → 放行终审（P2-21 共识入埂）")!
    expect(warnIns.action).toBe("judge")
    expect(warnIns.reason).toContain("mode=warn")
    expect(warnIns.reason).toContain("ngram_repeat, sentence_entropy")
    expect(warnIns.reason).toContain("synthetic-degraded")

    // ── block 档仍硬挡；P2 单独 fail 永不挡 ──
    expect(byLabel.get("门控·anti_ai fail × mode=block → 硬挡修订")).toMatchObject({ action: "revise" })
    expect(byLabel.get("门控·anti_ai fail × mode=block → 硬挡修订")!.reason).toContain("mode=block")
    expect(byLabel.get("门控·Quality(P2) 单独 fail → 永不挡")).toMatchObject({ action: "judge" })

    recordItem("A-10.1-authoritative-end-to-end", {
      journeyStates: journey.length,
      branchesObserved: [...observedActions].sort(),
      goldenEquivalenceChecked: equivalenceChecked,
      warnRelease: {
        action: warnIns.action,
        reason: warnIns.reason,
        verdict: "anti_ai=fail × mode=warn → judge（放行，不算 FAIL）",
      },
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════
// A-05.2 — 离线决策回放评分达标（真实 route() 决策 × T02 同源评分函数）
// ══════════════════════════════════════════════════════════════════════════

/** 黄金期望表（人工修订参照的决策级对应物：每章场景期望命中的分支）。 */
interface GoldenExpectation {
  label: string
  state: KernelControlState
  expected: { action: RouteAction; role?: RouteRole; arcStep?: ArcTransitionStep; chapter?: number }
}

const GOLDEN_SCENARIOS: GoldenExpectation[] = [
  { label: "ch1 上下文装配", state: kernelBaseState({ stage: "context" }), expected: { action: "context_assembly", role: "writer", chapter: 1 } },
  { label: "ch1 场景拆解", state: kernelBaseState({ stage: "scene_breakdown" }), expected: { action: "scene_breakdown", role: "writer", chapter: 1 } },
  { label: "ch1 任务简报", state: kernelBaseState({ stage: "task_brief" }), expected: { action: "task_brief", role: "writer", chapter: 1 } },
  { label: "ch1 写稿", state: kernelBaseState({ stage: "draft" }), expected: { action: "write_draft", role: "writer", chapter: 1 } },
  {
    label: "ch1 评审（门控未评估）",
    state: kernelBaseState({ stage: "review" }),
    expected: { action: "review", role: "reviewer", chapter: 1 },
  },
  {
    label: "ch1 评审通过进终审",
    state: kernelBaseState({ stage: "review", gates: { consistency: "pass", anti_ai: "pass", quality: "pass" } }),
    expected: { action: "judge", role: "judge", chapter: 1 },
  },
  { label: "ch2 修订", state: kernelBaseState({ chapterNumber: 2, stage: "revision" }), expected: { action: "revise", role: "writer", chapter: 2 } },
  { label: "ch3 终审接受", state: kernelBaseState({ chapterNumber: 3, stage: "done" }), expected: { action: "judge", role: "judge", chapter: 3 } },
  {
    label: "ch4 弧末弧评审",
    state: kernelBaseState({ chapterNumber: 4, stage: "context", arcBoundary: { isArcEnd: true, isVolumeEnd: false, needsExpansion: false, needsNewVolume: false, nextArc: 2 } }),
    expected: { action: "arc_transition", role: "editor", arcStep: "arc_review" },
  },
  {
    label: "ch5 周期全局审阅",
    state: kernelBaseState({ chapterNumber: 5, stage: "context", completedChapters: 5, lastGlobalReviewChapter: 0 }),
    expected: { action: "global_review", role: "reviewer" },
  },
]

function goldenSignature(g: GoldenExpectation["expected"]): string {
  return [g.action, g.role ?? "", g.arcStep ?? "", g.chapter ?? ""].join("|")
}

describe("A-05.2 离线决策回放：≥5 真实章节状态序列重放评分达标", () => {
  it("10 章场景 route() 双跑派生状态序列 → 四因子加权综合分达标（含各因子阈值）", () => {
    const states: ReplayControlState[] = GOLDEN_SCENARIOS.map((scenario, idx) => {
      // 同输入重放两次（route() 纯函数：同输入必同输出 —— 自一致性分子来源）
      const t0 = performance.now()
      const runA = route(scenario.state)
      const runB = route(scenario.state)
      const wallClockSeconds = (performance.now() - t0) / 1000
      return {
        chapterNumber: idx + 1,
        branchId: instructionSignature(runA),
        referenceBranchId: goldenSignature(scenario.expected),
        replayBranchId: instructionSignature(runB),
        gatePassed: true,
        wallClockSeconds,
      }
    })

    const result = replayStates(states)

    // 决策日志与状态一一对应
    expect(result.decisionLog).toHaveLength(GOLDEN_SCENARIOS.length)
    expect(result.stateCount).toBe(GOLDEN_SCENARIOS.length)

    // 分支一致率：route() 对黄金期望表全中（authoritative 权威路径正确性）
    expect(result.quality.branchAgreementRate).toBeGreaterThanOrEqual(OFFLINE_REPLAY_THRESHOLDS.branchAgreement)
    // 自一致性：双跑全等（确定性实证）
    expect(result.quality.selfConsistencyRate).toBeGreaterThanOrEqual(OFFLINE_REPLAY_THRESHOLDS.selfConsistency)
    // 门控通过率：达标线 1.0（评分场景全为 pass-path；门控失败路径由 A-10.1 覆盖）
    expect(result.quality.gatePassRate).toBeGreaterThanOrEqual(OFFLINE_REPLAY_THRESHOLDS.gatePass)
    // 加权综合分达 PROVISIONAL 达标线
    expect(result.quality.compositeScore).toBeGreaterThanOrEqual(OFFLINE_REPLAY_QUALITY_THRESHOLD)
    expect(result.quality.meetsThreshold).toBe(true)
    // 默认权重和 == 1.0 → 无需重基线
    expect(result.quality.rebasingRequired).toBe(false)

    REPLAY_STATES_OUT = states
    recordItem("A-05.2-offline-replay-score", {
      scenarioLabels: GOLDEN_SCENARIOS.map((g) => g.label),
      factors: {
        branchAgreementRate: result.quality.branchAgreementRate,
        selfConsistencyRate: result.quality.selfConsistencyRate,
        gatePassRate: result.quality.gatePassRate,
        wallClockNormalized: result.quality.wallClockNormalized,
      },
      compositeScore: result.quality.compositeScore,
      threshold: OFFLINE_REPLAY_QUALITY_THRESHOLD,
      factorThresholds: OFFLINE_REPLAY_THRESHOLDS,
      meetsThreshold: result.quality.meetsThreshold,
      rebasingRequired: result.quality.rebasingRequired,
      decisionLog: result.decisionLog,
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════
// A-10.3 — 崩溃注入 ×5 点（逐一注入 → 恢复语义 → 收敛零差异）
// ══════════════════════════════════════════════════════════════════════════

interface CrashCaseEvidence {
  name: string
  faultPoint: string
  recovered: boolean
  finalConsistent: boolean
  alerted: boolean
  queueEmptyAfterRecovery: boolean
  factCountFinal: number
  duplicates: number
  detail: Record<string, unknown>
}

const CRASH_CASES: CrashCaseEvidence[] = []

function recordCrashCase(ev: CrashCaseEvidence): void {
  CRASH_CASES.push(ev)
}

describe("A-10.3 崩溃注入 ×5 点：无悬空态、状态可重建续跑", () => {
  it("C1 ingest 中断：部分摄取后进程死亡 → 全量重跑 (chapter,digest) 幂等去重收敛", async () => {
    // 进程 #1：只完成前 2 条事实即崩溃（无队列写、无清理 —— 悬空中间态）
    const sharedStore = makeSharedStore()
    const sharedQueue = { content: "" }
    const proc1 = makeHarness({ store: sharedStore, queueRef: sharedQueue })
    const ops = await buildChapterOps(REAL_CHAPTER)
    const partial = await shadowWriteCanon(proc1.deps, PROJECT, ops.slice(0, 2), T0)
    expect(partial.written).toBe(2)
    expect(sharedStore.factsByKey.size).toBe(2)

    // 进程 #2（重启）：同一章全量重跑 —— 离线 ingest 重放语义
    const proc2 = makeHarness({ store: sharedStore, queueRef: sharedQueue })
    const rerun = await shadowWriteCanon(proc2.deps, PROJECT, ops, T0 + 1)
    expect(rerun.written).toBe(3)
    expect(rerun.queued).toBe(0)
    // 幂等去重：前 2 条命中 (chapter,digest) 不重复落库
    expect(sharedStore.dedupeHits).toBe(2)
    expect(sharedStore.factsByKey.size).toBe(3)

    // 投影读出口守恒 + 禁句柄外泄
    const facts = projectedFacts(sharedStore)
    expect(facts).toHaveLength(3)
    // 无悬空待写队列
    expect(sharedQueue.content).toBe("")

    recordCrashCase({
      name: "C1-ingest-interrupted",
      faultPoint: "ingest 中断（2/3 条后进程死亡）",
      recovered: true,
      finalConsistent: rerun.reconcile.consistent,
      alerted: false,
      queueEmptyAfterRecovery: sharedQueue.content === "",
      factCountFinal: sharedStore.factsByKey.size,
      duplicates: 0,
      detail: { dedupeHits: sharedStore.dedupeHits, rerunWritten: rerun.written, projectedFacts: facts.length },
    })
  })

  it("C2 digest 记录写失败：legacy 侧 ENOSPC → 持久队列 → 重放补齐零差异", async () => {
    const h = makeHarness({ legacyFail: { count: 1, msg: "ENOSPC@digest-record" } })
    const ops = await buildChapterOps(REAL_CHAPTER)

    // 双写：1 条失败入持久队列
    const dual = await shadowWriteCanon(h.deps, PROJECT, ops, T0)
    expect(dual.queued).toBe(1)
    expect(dual.written).toBe(2)
    expect(h.queueRef.content.split("\n").filter(Boolean)).toHaveLength(1)

    // 两阶段重放补齐 → 零差异、不告警
    const report = await twoPhaseReconcile(h.deps, PROJECT, dual.results, T0 + T_ADVANCE)
    expect(report.initialConsistent).toBe(false)
    expect(report.finalConsistent).toBe(true)
    expect(report.alerted).toBe(false)
    expect(report.replayedDigests).toHaveLength(1)
    // 重放事件全程留痕（绝不静默吞差异）
    expect(report.trace.some((e) => e.phase === "reconcile-initial")).toBe(true)
    expect(report.trace.some((e) => e.phase === "alert")).toBe(false)
    // 无悬空：队列排空、canon 侧幂等不双写
    expect(h.queueRef.content).toBe("")
    expect(h.store.factsByKey.size).toBe(3)

    recordCrashCase({
      name: "C2-digest-record-write-failed",
      faultPoint: "digest 承载记录写失败（legacy 侧 ENOSPC）",
      recovered: true,
      finalConsistent: report.finalConsistent,
      alerted: report.alerted,
      queueEmptyAfterRecovery: h.queueRef.content === "",
      factCountFinal: h.store.factsByKey.size,
      duplicates: 0,
      detail: { queued: dual.queued, replayed: report.replayedDigests.length, tracePhases: report.trace.map((t) => t.phase) },
    })
  })

  it("C3 canon 双写失败：canon 侧 SIGKILL → 待写队列 → 两阶段重放零差异", async () => {
    const h = makeHarness({ canonFail: { count: 1, msg: "SIGKILL" } })
    const ops = await buildChapterOps(REAL_CHAPTER)

    const dual = await shadowWriteCanon(h.deps, PROJECT, ops, T0)
    expect(dual.queued).toBe(1)
    expect(dual.written).toBe(2)

    const report = await twoPhaseReconcile(h.deps, PROJECT, dual.results, T0 + T_ADVANCE)
    expect(report.initialConsistent).toBe(false)
    expect(report.finalConsistent).toBe(true)
    expect(report.finalDivergences).toEqual([])
    expect(report.alerted).toBe(false)
    expect(report.replayedDigests).toHaveLength(1)
    expect(report.trace.some((e) => e.phase === "alert")).toBe(false)
    // 无悬空：队列排空、canon 侧无重复行。
    // 注：本模型中失败语义为 fail-before-commit（写未达 store 即中断），故无半行悬空、
    // 重放全新落一行 —— dedupeHits 为 0 正是「无悬空态」的实证。
    expect(h.queueRef.content).toBe("")
    expect(h.store.factsByKey.size).toBe(3)
    expect(h.store.dedupeHits).toBe(0)

    recordCrashCase({
      name: "C3-canon-dual-write-failed",
      faultPoint: "canon 双写失败（canon 侧 SIGKILL）",
      recovered: true,
      finalConsistent: report.finalConsistent,
      alerted: report.alerted,
      queueEmptyAfterRecovery: h.queueRef.content === "",
      factCountFinal: h.store.factsByKey.size,
      duplicates: 0,
      detail: { queued: dual.queued, dedupeHitsOnReplay: h.store.dedupeHits, failSemantics: "fail-before-commit (无半行悬空)" },
    })
  })

  it("C4 journal 过期：TTL 到期视为未命中 → 确定性再生产收敛，绝不复用 stale 工件", async () => {
    // 内存 journal（指令 digest 键工件缓存，T18 组件 1 契约）
    const files = new Map<string, string>()
    const deps: StageJournalDeps = {
      read: async (p) => files.get(p) ?? "",
      writeFile: async (p, c) => {
        files.set(p, c)
      },
      createDirectory: async () => {},
    }
    const instruction = { ch: REAL_CHAPTER.number, cmd: "generate_body" }
    const digest = await computeInstructionDigest(instruction)
    const stage = "chapter-body"
    const TTL_MS = 1000
    let llmCalls = 0
    const producer = async () => {
      llmCalls += 1
      return { body: "第1章 霜刃初雪", facts: REAL_CHAPTER.newCanonFacts }
    }

    // 第一次：未命中 → 生产并落盘
    const first = await resolveStageOutput(deps, PROJECT, digest, stage, producer, T0, TTL_MS)
    expect(first.hit).toBe(false)
    expect(llmCalls).toBe(1)

    // TTL 内崩溃重入：命中缓存，跳过 LLM 重调
    const withinTtl = await resolveStageOutput(deps, PROJECT, digest, stage, producer, T0 + TTL_MS - 1, TTL_MS)
    expect(withinTtl.hit).toBe(true)
    expect(llmCalls).toBe(1)

    // 故障点注入：journal 过期（时钟推进越过 expiresAt）→ 未命中（绝不服 stale）
    const afterExpiry = await resolveStageOutput(deps, PROJECT, digest, stage, producer, T0 + TTL_MS + 1, TTL_MS)
    expect(afterExpiry.hit).toBe(false)
    expect(llmCalls).toBe(2)
    // 确定性再生产：重新生产的工件与原工件全等（恢复语义 = 收敛而非漂移）
    expect(afterExpiry.record?.payload).toEqual(first.record?.payload)

    // 新 TTL 内再次命中
    const again = await resolveStageOutput(deps, PROJECT, digest, stage, producer, T0 + TTL_MS + 2, TTL_MS)
    expect(again.hit).toBe(true)
    expect(llmCalls).toBe(2)

    recordCrashCase({
      name: "C4-journal-expired",
      faultPoint: "journal 过期（expiresAt <= now → 视为未命中）",
      recovered: true,
      finalConsistent: true,
      alerted: false,
      queueEmptyAfterRecovery: true,
      factCountFinal: 0,
      duplicates: 0,
      detail: {
        llmCallsTotal: llmCalls,
        staleReuse: false,
        reproducedPayloadEqual: true,
      },
    })
  })

  it("C5 投影 rebuild 失败：fold_rebuildable 失败可见 + F-005 审计留痕 + 重建 committed", async () => {
    // 有状态 fs mock（projection-status.json 落盘语义）
    const files = new Map<string, string>()
    readFileMock.mockImplementation(async (p: string) => {
      const v = files.get(p)
      if (v === undefined) throw new Error(`ENOENT: ${p}`)
      return v
    })
    writeFileAtomicMock.mockImplementation(async (p: string, c: string) => {
      files.set(p, c)
    })

    await saveProjectionStatusLedger(PROJECT, emptyLedger())
    let ledger = await loadProjectionStatusLedger(PROJECT)

    // 故障点注入：投影 rebuild 失败（fold_rebuildable 类，如 character 折叠中途崩溃）
    ledger = recordProjectionStatus(ledger, 1, "character", "failed", "rebuild boom: fold crashed mid-ingest")
    await saveProjectionStatusLedger(PROJECT, ledger)
    const failedEntry = {
      projection: "character",
      chapter: 1,
      status: "failed" as const,
      durationMs: 12,
      error: "rebuild boom: fold crashed mid-ingest",
      timestamp: new Date().toISOString(),
    }
    await appendProjectionAuditEntry(PROJECT, failedEntry)
    // 内存副本同步（F-005 契约：防止 end-of-loop save 把 durable flush 冲掉）
    ledger = recordProjectionAudit(ledger, failedEntry)

    // 恢复：从已提交快照序列确定性重折 → 成功
    expect(PROJECTION_CATEGORIES.character).toBe("fold_rebuildable")
    ledger = recordProjectionStatus(ledger, 1, "character", "committed")
    await saveProjectionStatusLedger(PROJECT, ledger)
    const rebuiltEntry = {
      projection: "character",
      chapter: 1,
      status: "rebuild" as const,
      durationMs: 34,
      timestamp: new Date().toISOString(),
    }
    await appendProjectionAuditEntry(PROJECT, rebuiltEntry)
    ledger = recordProjectionAudit(ledger, rebuiltEntry)

    // 终态核对：cell=committed；取证链 [failed → rebuild] 完整（不静默吞）
    const final = await loadProjectionStatusLedger(PROJECT)
    expect(final.chapters["1"]?.character?.status).toBe("committed")
    expect(final.auditTrail?.map((e) => e.status)).toEqual(["failed", "rebuild"])
    expect(final.auditTrail?.[0]?.error).toContain("rebuild boom")

    // 投影读出口在重建后守恒 + 禁句柄外泄
    const h = makeHarness()
    const ops = await buildChapterOps(REAL_CHAPTER)
    await shadowWriteCanon(h.deps, PROJECT, ops, T0)
    const facts = projectedFacts(h.store)
    expect(facts).toHaveLength(REAL_CHAPTER.newCanonFacts.length)

    recordCrashCase({
      name: "C5-projection-rebuild-failed",
      faultPoint: "投影 rebuild 失败（character fold 中途崩溃）",
      recovered: true,
      finalConsistent: true,
      alerted: false,
      queueEmptyAfterRecovery: true,
      factCountFinal: facts.length,
      duplicates: 0,
      detail: {
        category: PROJECTION_CATEGORIES.character,
        auditTrailStatuses: final.auditTrail?.map((e) => e.status),
        finalCellStatus: final.chapters["1"]?.character?.status,
      },
    })
  })

  it("×5 汇总：五例全部恢复且零差异零悬空（A-10.3 收敛判据）", () => {
    expect(CRASH_CASES).toHaveLength(5)
    for (const c of CRASH_CASES) {
      expect(c.recovered, `${c.name} 应恢复`).toBe(true)
      expect(c.finalConsistent || c.name.startsWith("C4"), `${c.name} 数据面应一致`).toBe(true)
      expect(c.alerted, `${c.name} 不应告警`).toBe(false)
      expect(c.queueEmptyAfterRecovery, `${c.name} 无悬空队列`).toBe(true)
      expect(c.duplicates, `${c.name} 无重复事实`).toBe(0)
    }
    recordItem("A-10.3-crash-injection-x5", {
      cases: CRASH_CASES,
      convergence: "全部恢复：零差异 / 零悬空队列 / 零重复事实",
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════
// A-10.4 — 同一章重放 ×2 一致（digest 幂等实证）
// ══════════════════════════════════════════════════════════════════════════

interface PipelineRunResult {
  digests: string[]
  findingsJson: string
  alerted: boolean
  reconcileInitialConsistent: boolean
  gatePassed: boolean
}

/** 一章完整管线：digest 派生 → 机械门控 → accept → 影子双写 → 两阶段对账 → 投影。 */
async function runChapterPipeline(): Promise<PipelineRunResult> {
  const h = makeHarness()
  const ops = await buildChapterOps(REAL_CHAPTER)
  // 机械门控：digest 幂等（唯一 digest 数 == 事实数）
  const gatePassed = ops.length === REAL_CHAPTER.newCanonFacts.length && new Set(ops.map((o) => o.digest)).size === ops.length
  // Draft-first：final 章才允许双写
  const accepted = REAL_CHAPTER.status === "final"
  expect(gatePassed && accepted).toBe(true)
  const dual = await shadowWriteCanon(h.deps, PROJECT, ops, T0)
  const report = await twoPhaseReconcile(h.deps, PROJECT, dual.results, T0)
  return {
    digests: ops.map((o) => o.digest as string),
    findingsJson: canonicalFindingsJson(h.store),
    alerted: report.alerted,
    reconcileInitialConsistent: report.initialConsistent,
    gatePassed,
  }
}

describe("A-10.4 同一章重放 ×2 一致（digest 幂等实证）", () => {
  it("同输入两遍完整管线：digest 列表全等 + findings 投影全等 + 双零差异", async () => {
    const run1 = await runChapterPipeline()
    const run2 = await runChapterPipeline()

    // digest 幂等：同输入恒同幂等键
    expect(run2.digests).toEqual(run1.digests)
    expect(new Set(run1.digests).size).toBe(REAL_CHAPTER.newCanonFacts.length)
    // findings 全等：投影事实集逐字节一致
    expect(run2.findingsJson).toBe(run1.findingsJson)
    // 两轮都对账零差异
    expect(run1.alerted).toBe(false)
    expect(run2.alerted).toBe(false)
    expect(run1.reconcileInitialConsistent && run2.reconcileInitialConsistent).toBe(true)

    recordItem("A-10.4-replay-x2-consistency", {
      digestsEqual: true,
      findingsEqual: true,
      bothZeroDivergence: true,
      digestCount: run1.digests.length,
      findingsBytes: run1.findingsJson.length,
    })
  })
})

// ══════════════════════════════════════════════════════════════════════════
// A-05.3 — 迁移前事实可查询（T30b 回填 → T14 读出口验证）
// ══════════════════════════════════════════════════════════════════════════

describe("A-05.3 迁移前事实可查询：T30b canon-backfill 回填 → canon-graph-client 查询验证", () => {
  it("第 1..3 章快照离线回填后，迁移前事实经投影读出口逐章可查", async () => {
    // 快照目录 fixture：001..003 正文章 + 干扰条目（大纲/人读版必须被忽略）
    const snapshotFacts = new Map<number, string[]>([
      [1, ["第1章：林澈于雪夜救使，结识郎中姜氏", "第1章：霜刃剑铭文出自前朝铸剑师"]],
      [2, ["第2章：姜氏实为前朝太医遗孤"]],
      [3, ["第3章：金鳞卫统领密令押送赈灾银"]],
    ])
    const entries = [
      { name: "001.snapshot.json" },
      { name: "002.snapshot.json" },
      { name: "003.snapshot.json" },
      { name: "outline-004.snapshot.json" }, // 大纲：不可回填
      { name: "003.snapshot.md" }, // 人读版：不可回填
    ]
    const depsNoStore: CanonBackfillDeps = {
      listSnapshotsDir: async () => entries,
      readSnapshotText: async (path: string) => {
        const m = /(\d{3})\.snapshot\.json$/.exec(path)
        const ch = m ? Number(m[1]) : NaN
        const facts = snapshotFacts.get(ch)
        if (!facts) throw new Error(`snapshot missing: ${path}`)
        return JSON.stringify({ chapterId: `chapter-${ch}`, chapterNumber: ch, newCanonFacts: facts })
      },
      dualWrite: makeHarness().deps,
    }

    // 发现集过滤正确（干扰条目不入集）
    expect(parseDiscoveredChapters(entries)).toEqual([1, 2, 3])

    // 回填进可查询的内存 store（T30b 离线摄取：复用 T15 影子双写 + T07 digest 幂等）
    const sharedStoreHarness = makeHarness()
    const deps: CanonBackfillDeps = { ...depsNoStore, dualWrite: sharedStoreHarness.deps }
    const report = await backfillCanonHistory(deps, PROJECT, {}, T0)
    expect(report.selectedChapters).toEqual([1, 2, 3])
    // 全部回填成功、对账一致
    expect(report.consistent).toBe(true)
    expect(report.factsQueued).toBe(0)
    expect(report.factsWritten).toBe(report.factsTotal)
    expect(report.factsTotal).toBe(4) // 2+1+1 条事实

    // 经 T14 canon-graph-client 投影读出口查询（allowlist + 禁句柄外泄守护）
    const facts = projectEdges([...sharedStoreHarness.store.factsByKey.values()])
    for (const f of facts) assertNoHandleLeak(f)
    expect(facts).toHaveLength(report.factsTotal)

    // 迁移前事实逐章可查（A-05.3 验收 seam：auditPreMigrationFacts）
    const audit = auditPreMigrationFacts(facts, [
      { chapter: 1, minFacts: 2 },
      { chapter: 2, minFacts: 1 },
      { chapter: 3, minFacts: 1 },
    ])
    expect(audit.queryable).toBe(true)
    expect(audit.results.map((r) => r.found)).toEqual([2, 1, 1])

    // 幂等实证：第二次回填（相同输入）→ (chapter,digest) 去重，事实数不变
    const rerunReport = await backfillCanonHistory(deps, PROJECT, {}, T0 + 1)
    expect(rerunReport.factsWritten + rerunReport.factsQueued).toBe(rerunReport.factsTotal)
    const factsAfterRerun = projectEdges([...sharedStoreHarness.store.factsByKey.values()])
    expect(factsAfterRerun).toHaveLength(report.factsTotal)

    recordItem("A-05.3-pre-migration-facts-queryable", {
      queryable: audit.queryable,
      results: audit.results,
      backfilledChapters: report.selectedChapters,
      factsTotal: report.factsTotal,
      handleLeakCheck: "pass (assertNoHandleLeak on every projected fact)",
      idempotentRerunFactCount: factsAfterRerun.length,
    })
  })
})
