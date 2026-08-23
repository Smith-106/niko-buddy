/**
 * control-kernel.spec.ts — T08 route() 纯函数 + 720k 单循环 + fast-check 属性面
 *
 * 蓝图 §6 P1 T08 收敛条件:
 *   "720k 单循环全绿 ≤5s (Node 目标); route() grep 无 IO/模型调用; 属性测试绿"
 *
 * 本 spec 三面 (与 ainovel-cli `router_exhaustive_test.go` 同型, 组合数对照见
 * `docs/decision-log/2026-08-20-t08.md`):
 *   ① 单分支意图文档 (unit): 13 分支各一用例 + 阶段机 7×3×3=63 组合穷举
 *   ② 720k 单 test 循环: 14,400 控制维组合 × 50 弧边界用例 = 720,000,
 *      每组合 4 断言 (规格镜像匹配 / 守恒 / 纯函数 / 确定性),
 *      批收集失败 + 末尾单次断言 (避免 vitest 5s 默认超时), 循环耗时 ≤5s
 *   ③ fast-check 属性面: 守恒 / 纯函数 DeepEqual / 确定性 三属性 (与单循环互补)
 *
 * 执行纪律:
 *   - ADR-19 机械层零模型调用: 本 spec 不调用任何模型 / IO / Tauri invoke。
 *   - Draft-first (ADR-08): 本 spec 是新增测试文件, 不触及 .novel/status.json 正式层。
 *   - 规格镜像 `expectedDecision` 独立于 route() 实现 (与 ainovel-cli
 *     expectedInstruction 同型): 实现重构后行为偏移立刻红灯。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import fc from "fast-check"
import {
  route,
  firstFailedGate,
  type ArcBoundary,
  type ArcTransitionStep,
  type ControlState,
  type Instruction,
  type RouteAction,
  type RouteGates,
  type RouteRole,
} from "./control-kernel"
import {
  ANTI_AI_MODES,
  ARBITER_CONSULT_LIMIT,
  ARC_TRANSITION_STEPS,
  DEFAULT_REVIEW_INTERVAL,
  EXHAUSTIVE_COMBINATION_COUNT,
  EXHAUSTIVE_TIME_BUDGET_MS,
  GATE_PRIORITY,
  GATE_VERDICTS,
  HARD_FUSE_LIMIT,
  ROUTE_ACTIONS,
  ROUTE_BRANCH_COUNT,
  ROUTE_ROLES,
  ROUTE_SHELL_MODES,
  ROUTE_STAGES,
} from "./control-sentinels"

// ============================================================================
// 测试夹具
// ============================================================================

/** 基准控制态: 写作期第 3 章, 无任何优先级触发, 阶段=draft。 */
function baseState(overrides: Partial<ControlState> = {}): ControlState {
  return {
    phase: "writing",
    stage: "draft",
    chapterNumber: 3,
    completedChapters: 2,
    pendingRewrites: [],
    gates: { consistency: "pass", anti_ai: "pass", quality: "pass" },
    antiAiMode: "off",
    manualReviewRequired: false,
    foundationMissing: [],
    planningTier: "",
    reviewInterval: 0,
    lastGlobalReviewChapter: 0,
    arcBoundary: undefined,
    hasArcReview: false,
    hasArcSummary: false,
    hasVolumeSummary: false,
    shellMode: "legacy",
    ...overrides,
  }
}

/** 弧末边界夹具 (isArcEnd=true)。 */
function arcEndBoundary(overrides: Partial<ArcBoundary> = {}): ArcBoundary {
  return {
    isArcEnd: true,
    isVolumeEnd: false,
    needsExpansion: false,
    needsNewVolume: false,
    nextArc: 0,
    ...overrides,
  }
}

/** 三组已评估门控 (720k 循环与阶段机穷举共用)。 */
const GATE_SETS: readonly RouteGates[] = [
  { consistency: "pass", anti_ai: "pass", quality: "pass" },
  { consistency: "fail", anti_ai: "pass", quality: "pass" },
  { consistency: "pass", anti_ai: "fail", quality: "pass" },
]

/** 弧边界用例枚举 (50 例: 1 无边界 + 1 弧中 + 48 弧末, 与 ainovel-cli 同构)。 */
interface BoundaryCase {
  name: string
  arcBoundary?: ArcBoundary
  hasArcReview: boolean
  hasArcSummary: boolean
  hasVolumeSummary: boolean
}

function enumerateBoundaryCases(): BoundaryCase[] {
  const cases: BoundaryCase[] = []
  cases.push({ name: "no-boundary", hasArcReview: false, hasArcSummary: false, hasVolumeSummary: false })
  cases.push({
    name: "mid-arc",
    arcBoundary: { isArcEnd: false, isVolumeEnd: false, needsExpansion: false, needsNewVolume: false, nextArc: 0 },
    hasArcReview: false,
    hasArcSummary: false,
    hasVolumeSummary: false,
  })
  const volCases = [
    { name: "vol-mid", volumeEnd: false, volSummary: false },
    { name: "vol-end-nosum", volumeEnd: true, volSummary: false },
    { name: "vol-end-sum", volumeEnd: true, volSummary: true },
  ] as const
  const followCases = [
    { name: "settled", expansion: false, nextArc: 0, newVolume: false },
    { name: "expand", expansion: true, nextArc: 4, newVolume: false },
    { name: "expand-no-nextarc", expansion: true, nextArc: 0, newVolume: false },
    { name: "new-volume", expansion: false, nextArc: 0, newVolume: true },
  ] as const
  for (const review of [false, true]) {
    for (const summary of [false, true]) {
      for (const vc of volCases) {
        for (const fc2 of followCases) {
          cases.push({
            name: `arc-end rev=${review} sum=${summary} ${vc.name} ${fc2.name}`,
            arcBoundary: {
              isArcEnd: true,
              isVolumeEnd: vc.volumeEnd,
              needsExpansion: fc2.expansion,
              needsNewVolume: fc2.newVolume,
              nextArc: fc2.nextArc,
            },
            hasArcReview: review,
            hasArcSummary: summary,
            hasVolumeSummary: vc.volSummary,
          })
        }
      }
    }
  }
  return cases
}

/** 快照控制态的可变部分 (守恒断言用)。 */
function snapshotState(state: ControlState): {
  q: number[]
  m: string[]
  b: ArcBoundary | undefined
} {
  return {
    q: state.pendingRewrites.slice(),
    m: state.foundationMissing.slice(),
    b: state.arcBoundary === undefined ? undefined : { ...state.arcBoundary },
  }
}

/** 快照与当前状态的可变部分是否一致 (守恒断言)。 */
function sameSnapshot(snap: ReturnType<typeof snapshotState>, state: ControlState): boolean {
  if (snap.q.length !== state.pendingRewrites.length) return false
  for (let i = 0; i < snap.q.length; i++) if (snap.q[i] !== state.pendingRewrites[i]) return false
  if (snap.m.length !== state.foundationMissing.length) return false
  for (let i = 0; i < snap.m.length; i++) if (snap.m[i] !== state.foundationMissing[i]) return false
  const b = state.arcBoundary
  if (snap.b === undefined || b === undefined) return snap.b === b
  return (
    snap.b.isArcEnd === b.isArcEnd &&
    snap.b.isVolumeEnd === b.isVolumeEnd &&
    snap.b.needsExpansion === b.needsExpansion &&
    snap.b.needsNewVolume === b.needsNewVolume &&
    snap.b.nextArc === b.nextArc
  )
}

/** 两条指令逐字段一致 (确定性断言, 避免 DeepEqual 开销)。 */
function sameInstruction(a: Instruction, b: Instruction): boolean {
  return (
    a.action === b.action &&
    a.arcStep === b.arcStep &&
    a.chapter === b.chapter &&
    a.role === b.role &&
    a.reason === b.reason &&
    a.shellMode === b.shellMode
  )
}

/** 紧凑状态描述 (失败信息用)。 */
function describeState(s: ControlState): string {
  return `phase=${s.phase} stage=${s.stage} ch=${s.chapterNumber} done=${s.completedChapters} q=[${s.pendingRewrites}] gates=${s.gates.consistency}/${s.gates.anti_ai}/${s.gates.quality} antiAi=${s.antiAiMode} manual=${s.manualReviewRequired} missing=[${s.foundationMissing}] tier=${s.planningTier} interval=${s.reviewInterval} lastGlobal=${s.lastGlobalReviewChapter} arc=${s.arcBoundary?.isArcEnd ?? "-"}/${s.hasArcReview}/${s.hasArcSummary}/${s.hasVolumeSummary}`
}

// ============================================================================
// 规格镜像 (独立于 route() 实现, 与 ainovel-cli expectedInstruction 同型)
// ============================================================================

interface ExpectedDecision {
  action: RouteAction
  arcStep?: ArcTransitionStep
  chapter?: number
  role?: RouteRole
}

/**
 * 按架构规格计算某控制态应得的裁定 (优先级自上而下第一个命中):
 *   1. 终态 (complete / 写作期无进度)          → halt
 *   2. 规划期: 缺设定且 tier 已知 → foundation_fill; 否则 → halt
 *   3. 人工介入标记                            → arbitrate
 *   4. 重写队列非空                            → rewrite (队列头)
 *   5. 弧末: 评审→摘要→卷摘要→展开→新卷        → arc_transition
 *   6. 周期全局审阅到期                        → global_review
 *   7-13. 阶段机: context→scene_breakdown→task_brief→draft→review→revision→done
 *          (stage=review: consistency fail → revise; anti_ai fail 且 block → revise; 否则 judge)
 */
function expectedDecision(s: ControlState): ExpectedDecision {
  const terminal = s.phase === "complete" || (s.phase === "writing" && s.chapterNumber <= 0)
  if (terminal) return { action: "halt" }
  if (s.phase === "planning") {
    if (s.foundationMissing.length > 0 && s.planningTier !== "") {
      return { action: "foundation_fill", role: "architect" }
    }
    return { action: "halt" }
  }
  if (s.manualReviewRequired) return { action: "arbitrate", role: "arbiter" }
  if (s.pendingRewrites.length > 0) {
    return { action: "rewrite", role: "writer", chapter: s.pendingRewrites[0] }
  }
  const arc = s.arcBoundary
  if (arc !== undefined && arc.isArcEnd) {
    if (!s.hasArcReview) return { action: "arc_transition", arcStep: "arc_review", role: "editor" }
    if (!s.hasArcSummary) return { action: "arc_transition", arcStep: "arc_summary", role: "editor" }
    if (arc.isVolumeEnd && !s.hasVolumeSummary) {
      return { action: "arc_transition", arcStep: "volume_summary", role: "editor" }
    }
    if (arc.needsExpansion && arc.nextArc > 0) {
      return { action: "arc_transition", arcStep: "expand_arc", role: "architect" }
    }
    if (arc.needsNewVolume) return { action: "arc_transition", arcStep: "new_volume", role: "architect" }
  }
  const globalDue =
    s.reviewInterval > 0 &&
    s.completedChapters > 0 &&
    s.completedChapters % s.reviewInterval === 0 &&
    s.lastGlobalReviewChapter < s.completedChapters
  if (globalDue) return { action: "global_review", role: "reviewer" }
  switch (s.stage) {
    case "context":
      return { action: "context_assembly", role: "writer", chapter: s.chapterNumber }
    case "scene_breakdown":
      return { action: "scene_breakdown", role: "writer", chapter: s.chapterNumber }
    case "task_brief":
      return { action: "task_brief", role: "writer", chapter: s.chapterNumber }
    case "draft":
      return { action: "write_draft", role: "writer", chapter: s.chapterNumber }
    case "review": {
      const allPending =
        s.gates.consistency === "pending" &&
        s.gates.anti_ai === "pending" &&
        s.gates.quality === "pending"
      if (allPending) return { action: "review", role: "reviewer", chapter: s.chapterNumber }
      if (s.gates.consistency === "fail") return { action: "revise", role: "writer", chapter: s.chapterNumber }
      if (s.gates.anti_ai === "fail" && s.antiAiMode === "block") {
        return { action: "revise", role: "writer", chapter: s.chapterNumber }
      }
      return { action: "judge", role: "judge", chapter: s.chapterNumber }
    }
    case "revision":
      return { action: "revise", role: "writer", chapter: s.chapterNumber }
    case "done":
      return { action: "judge", role: "judge", chapter: s.chapterNumber }
  }
}

/** 4 断言/组合: 规格镜像匹配 (含 reason 非空 + shellMode 回显)。 */
function assertMirrorMatch(inst: Instruction, want: ExpectedDecision, state: ControlState, ctx: string, failures: string[]): void {
  if (
    inst.action !== want.action ||
    inst.arcStep !== want.arcStep ||
    inst.chapter !== want.chapter ||
    inst.role !== want.role ||
    inst.shellMode !== state.shellMode ||
    inst.reason.length === 0
  ) {
    failures.push(`[${ctx}] 规格镜像不匹配: got=${JSON.stringify(inst)} want=${JSON.stringify(want)} state=${describeState(state)}`)
  }
}

// ============================================================================
// ① 哨兵常量/阈值表
// ============================================================================

describe("T08 control-kernel (F-10 / A-02.3)", () => {
  describe("control-sentinels 哨兵常量/阈值表", () => {
    it("13 分支互斥 + 720k 组合数 + ≤5s 硬时间界哨兵", () => {
      expect(ROUTE_BRANCH_COUNT).toBe(13)
      expect(ROUTE_ACTIONS).toHaveLength(13)
      expect(new Set(ROUTE_ACTIONS).size).toBe(13)
      expect(EXHAUSTIVE_COMBINATION_COUNT).toBe(720_000)
      expect(EXHAUSTIVE_TIME_BUDGET_MS).toBe(5_000)
    })

    it("门控优先级 P0>P1>P2 + 三档 anti_ai_mode + 三开关 shell 模式", () => {
      expect(GATE_PRIORITY).toEqual(["consistency", "anti_ai", "quality"])
      expect(ANTI_AI_MODES).toEqual(["off", "warn", "block"])
      expect(ROUTE_SHELL_MODES).toEqual(["legacy", "consult", "authoritative"])
      expect(GATE_VERDICTS).toEqual(["pending", "pass", "fail"])
    })

    it("死锁 3×/5× 预算哨兵 + 周期审阅默认间隔 + 枚举哨兵", () => {
      expect(ARBITER_CONSULT_LIMIT).toBe(3)
      expect(HARD_FUSE_LIMIT).toBe(5)
      expect(DEFAULT_REVIEW_INTERVAL).toBe(5)
      expect(ROUTE_STAGES).toHaveLength(7)
      expect(ARC_TRANSITION_STEPS).toEqual(["arc_review", "arc_summary", "volume_summary", "expand_arc", "new_volume"])
      expect(ROUTE_ROLES).toContain("writer")
      expect(ROUTE_ROLES).toContain("judge")
    })

    it("ADR-19 机械层零模型调用: control-kernel.ts grep 无 IO/模型 token", () => {
      const src = readFileSync(resolve(__dirname, "control-kernel.ts"), "utf-8")
      // 与收敛命令同口径 (意图): 无 fetch / LLM / openai 调用 token。
      // 注: "shellMode" 是蓝图 §4 强制命名 (RouteShellMode), 含 "llm" 子串,
      // 故用词边界匹配 (\bllm\b) 而非子串匹配。
      expect(/\b(?:fetch|llm|openai)\b/i.test(src)).toBe(false)
      // 从严: 无 Tauri invoke / node fs / http / WebSocket
      expect(/(?:invoke|node:fs|node:http|readFileSync|writeFileSync|createServer|WebSocket|XMLHttpRequest)/i.test(src)).toBe(false)
    })
  })

  // ============================================================================
  // ② 单分支意图文档 (unit)
  // ============================================================================

  describe("route() 13 分支单测 (意图文档)", () => {
    it("halt: 终态 (phase=complete / 写作期无进度 / 规划期无缺项)", () => {
      const complete = route(baseState({ phase: "complete" }))
      expect(complete.action).toBe("halt")
      expect(complete.role).toBeUndefined()
      expect(complete.reason.length).toBeGreaterThan(0)

      const noProgress = route(baseState({ phase: "writing", chapterNumber: 0 }))
      expect(noProgress.action).toBe("halt")

      const planningIdle = route(baseState({ phase: "planning", foundationMissing: [], planningTier: "" }))
      expect(planningIdle.action).toBe("halt")
    })

    it("foundation_fill: 规划期缺设定且 tier 已知 → 派规划师; tier 未定 → halt", () => {
      const inst = route(baseState({ phase: "planning", foundationMissing: ["characters", "world_rules"], planningTier: "long" }))
      expect(inst.action).toBe("foundation_fill")
      expect(inst.role).toBe("architect")
      expect(inst.reason).toContain("characters")

      const tierUnknown = route(baseState({ phase: "planning", foundationMissing: ["characters"], planningTier: "" }))
      expect(tierUnknown.action).toBe("halt")
    })

    it("arbitrate: 人工介入标记压过重写队列与一切自动派单", () => {
      const inst = route(baseState({ manualReviewRequired: true, pendingRewrites: [7, 9] }))
      expect(inst.action).toBe("arbitrate")
      expect(inst.role).toBe("arbiter")
    })

    it("rewrite: 重写队列头绝对优先 (压过弧末/全局审阅/阶段机)", () => {
      const inst = route(
        baseState({
          pendingRewrites: [7, 9],
          arcBoundary: arcEndBoundary(),
          hasArcReview: false,
          reviewInterval: 5,
          completedChapters: 5,
        }),
      )
      expect(inst.action).toBe("rewrite")
      expect(inst.chapter).toBe(7)
      expect(inst.role).toBe("writer")
    })

    it("arc_transition: 弧末五子步按事务顺序 (评审→摘要→卷摘要→展开→新卷)", () => {
      const step = (over: Partial<ControlState>): Instruction =>
        route(baseState({ arcBoundary: arcEndBoundary(), ...over }))

      expect(step({ hasArcReview: false }).action).toBe("arc_transition")
      expect(step({ hasArcReview: false }).arcStep).toBe("arc_review")
      expect(step({ hasArcReview: false }).role).toBe("editor")

      expect(step({ hasArcReview: true, hasArcSummary: false }).arcStep).toBe("arc_summary")

      expect(
        step({ hasArcReview: true, hasArcSummary: true, arcBoundary: arcEndBoundary({ isVolumeEnd: true }), hasVolumeSummary: false }).arcStep,
      ).toBe("volume_summary")

      expect(
        step({ hasArcReview: true, hasArcSummary: true, arcBoundary: arcEndBoundary({ needsExpansion: true, nextArc: 4 }) }).arcStep,
      ).toBe("expand_arc")
      expect(step({ hasArcReview: true, hasArcSummary: true, arcBoundary: arcEndBoundary({ needsExpansion: true, nextArc: 4 }) }).role).toBe("architect")

      expect(
        step({ hasArcReview: true, hasArcSummary: true, arcBoundary: arcEndBoundary({ needsNewVolume: true }) }).arcStep,
      ).toBe("new_volume")

      // 弧末事务全部完成 → 落入常规流程 (write_draft)
      const settled = step({ hasArcReview: true, hasArcSummary: true })
      expect(settled.action).toBe("write_draft")

      // 展开位缺失 (nextArc=0) → 不可展开, 落入常规流程
      const noNextArc = step({ hasArcReview: true, hasArcSummary: true, arcBoundary: arcEndBoundary({ needsExpansion: true, nextArc: 0 }) })
      expect(noNextArc.action).toBe("write_draft")
    })

    it("global_review: 周期到期触发 + lastGlobalReviewChapter 去重 + interval=0 关闭", () => {
      const due = route(baseState({ reviewInterval: 5, completedChapters: 5, lastGlobalReviewChapter: 0 }))
      expect(due.action).toBe("global_review")
      expect(due.role).toBe("reviewer")

      const deduped = route(baseState({ reviewInterval: 5, completedChapters: 5, lastGlobalReviewChapter: 5 }))
      expect(deduped.action).toBe("write_draft")

      const off = route(baseState({ reviewInterval: 0, completedChapters: 5 }))
      expect(off.action).toBe("write_draft")

      const notDue = route(baseState({ reviewInterval: 5, completedChapters: 3 }))
      expect(notDue.action).toBe("write_draft")
    })

    it("review 待评审: stage=review 且门控全 pending → review", () => {
      const inst = route(
        baseState({ stage: "review", gates: { consistency: "pending", anti_ai: "pending", quality: "pending" } }),
      )
      expect(inst.action).toBe("review")
      expect(inst.role).toBe("reviewer")
      expect(inst.chapter).toBe(3)
    })

    it("quality (P2) 永不挡: quality=fail 时三档 anti_ai_mode 均 → judge", () => {
      for (const antiAiMode of ANTI_AI_MODES) {
        const inst = route(
          baseState({ stage: "review", antiAiMode, gates: { consistency: "pass", anti_ai: "pass", quality: "fail" } }),
        )
        expect(inst.action).toBe("judge")
      }
    })

    it("shellMode 回显不分支: 同状态三开关产出同决策, shellMode 原样回显", () => {
      const legacy = route(baseState({ shellMode: "legacy" }))
      const consult = route(baseState({ shellMode: "consult" }))
      const authoritative = route(baseState({ shellMode: "authoritative" }))
      expect(consult.action).toBe(legacy.action)
      expect(authoritative.action).toBe(legacy.action)
      expect(consult.shellMode).toBe("consult")
      expect(authoritative.shellMode).toBe("authoritative")
    })

    it("13 分支全部可达 (reachability): 每分支至少一个状态命中", () => {
      const reachable = new Map<RouteAction, ControlState>([
        ["halt", baseState({ phase: "complete" })],
        ["foundation_fill", baseState({ phase: "planning", foundationMissing: ["characters"], planningTier: "long" })],
        ["arbitrate", baseState({ manualReviewRequired: true })],
        ["rewrite", baseState({ pendingRewrites: [7] })],
        ["arc_transition", baseState({ arcBoundary: arcEndBoundary(), hasArcReview: false })],
        ["global_review", baseState({ reviewInterval: 5, completedChapters: 5 })],
        ["context_assembly", baseState({ stage: "context" })],
        ["scene_breakdown", baseState({ stage: "scene_breakdown" })],
        ["task_brief", baseState({ stage: "task_brief" })],
        ["write_draft", baseState({ stage: "draft" })],
        ["review", baseState({ stage: "review", gates: { consistency: "pending", anti_ai: "pending", quality: "pending" } })],
        ["revise", baseState({ stage: "review", gates: { consistency: "fail", anti_ai: "pass", quality: "pass" } })],
        ["judge", baseState({ stage: "done" })],
      ])
      expect(reachable.size).toBe(ROUTE_BRANCH_COUNT)
      for (const [action, state] of reachable) {
        expect(route(state).action, `分支 ${action} 应可达`).toBe(action)
      }
    })

    it("firstFailedGate: P0>P1>P2 优先级序", () => {
      expect(firstFailedGate({ consistency: "pass", anti_ai: "pass", quality: "pass" })).toBeUndefined()
      expect(firstFailedGate({ consistency: "fail", anti_ai: "fail", quality: "fail" })).toBe("consistency")
      expect(firstFailedGate({ consistency: "pass", anti_ai: "fail", quality: "fail" })).toBe("anti_ai")
      expect(firstFailedGate({ consistency: "pass", anti_ai: "pass", quality: "fail" })).toBe("quality")
    })
  })

  // ============================================================================
  // ③ 阶段机穷举: 7 阶段 × 3 门控 × 3 档 = 63 组合 (4 断言/组合)
  // ============================================================================

  describe("阶段机穷举 (7×3×3=63 组合, 4 断言/组合)", () => {
    it("全阶段 × 全门控 × 全 anti_ai_mode 组合与规格镜像一致且守恒/纯函数/确定", () => {
      const failures: string[] = []
      let total = 0
      for (const stage of ROUTE_STAGES) {
        for (const gates of GATE_SETS) {
          for (const antiAiMode of ANTI_AI_MODES) {
            total++
            const state = baseState({ stage, gates: { ...gates }, antiAiMode })
            const snap = snapshotState(state)
            const inst = route(state)
            const want = expectedDecision(state)
            assertMirrorMatch(inst, want, state, `stage=${stage} gates=${gates.consistency}/${gates.anti_ai}/${gates.quality} antiAi=${antiAiMode}`, failures)
            if (!sameSnapshot(snap, state)) failures.push(`[stage=${stage}] 守恒失败: 输入被修改`)
            if (Object.is(inst, state)) failures.push(`[stage=${stage}] 纯函数失败: 输出别名输入`)
            const again = route(state)
            if (!sameInstruction(inst, again)) failures.push(`[stage=${stage}] 确定性失败`)
          }
        }
      }
      expect(total).toBe(ROUTE_STAGES.length * GATE_SETS.length * ANTI_AI_MODES.length)
      expect(failures).toEqual([])
    })
  })

  // ============================================================================
  // ④ 720k 单循环穷举 (A-02.3): 14,400 控制维 × 50 弧边界 = 720,000
  // ============================================================================

  describe("720k 单循环穷举 (A-02.3, ≤5s 硬时间界)", () => {
    it(
      "720,000 组合 × 4 断言 (规格镜像/守恒/纯函数/确定性), 批收集失败 + 末尾单次断言, 循环耗时 ≤5s",
      { timeout: 30_000 },
      () => {
        const phases = ["planning", "writing"] as const
        const stages = ["draft", "review"] as const
        const tiers = ["", "long"] as const
        const antiAiModes = ANTI_AI_MODES
        const completedSets = [0, 1, 3, 5, 7]
        const intervals = [0, 3, 5, 7, 10]
        const queues = [[], [7, 9]] as const
        const manualReviews = [false, true]
        const missingSets = [[], ["characters", "world_rules"]] as const
        const boundaries = enumerateBoundaryCases()

        const failures: string[] = []
        let total = 0
        const t0 = performance.now()
        for (const phase of phases) {
          for (const stage of stages) {
            for (const tier of tiers) {
              for (const gates of GATE_SETS) {
                for (const antiAiMode of antiAiModes) {
                  for (const completed of completedSets) {
                    for (const interval of intervals) {
                      for (const queue of queues) {
                        for (const manual of manualReviews) {
                          for (const missing of missingSets) {
                            for (const bc of boundaries) {
                              total++
                              const state: ControlState = {
                                phase,
                                stage,
                                chapterNumber: completed + 1,
                                completedChapters: completed,
                                pendingRewrites: queue.slice(),
                                gates: { ...gates },
                                antiAiMode,
                                manualReviewRequired: manual,
                                foundationMissing: missing.slice(),
                                planningTier: tier,
                                reviewInterval: interval,
                                lastGlobalReviewChapter: 0,
                                arcBoundary: bc.arcBoundary === undefined ? undefined : { ...bc.arcBoundary },
                                hasArcReview: bc.hasArcReview,
                                hasArcSummary: bc.hasArcSummary,
                                hasVolumeSummary: bc.hasVolumeSummary,
                                shellMode: "legacy",
                              }
                              const snap = snapshotState(state)
                              const inst = route(state)
                              const want = expectedDecision(state)
                              // 断言 1: 规格镜像匹配 (含 reason 非空 + shellMode 回显)
                              assertMirrorMatch(inst, want, state, `#${total} ${bc.name}`, failures)
                              // 断言 2: 守恒 — 输入不被修改
                              if (!sameSnapshot(snap, state)) {
                                failures.push(`[#${total} ${bc.name}] 守恒失败: 输入被修改 state=${describeState(state)}`)
                              }
                              // 断言 3: 纯函数 — 输出为全新对象, 不别名输入
                              if (Object.is(inst, state)) {
                                failures.push(`[#${total} ${bc.name}] 纯函数失败: 输出别名输入`)
                              }
                              // 断言 4: 确定性 — 同输入两次调用逐字段一致
                              const again = route(state)
                              if (!sameInstruction(inst, again)) {
                                failures.push(`[#${total} ${bc.name}] 确定性失败: got=${JSON.stringify(inst)} again=${JSON.stringify(again)}`)
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        const elapsedMs = performance.now() - t0

        expect(total).toBe(EXHAUSTIVE_COMBINATION_COUNT)
        expect(failures).toEqual([])
        // 硬时间界: 超时记录并触发 C-07 Rust 移植预案 (蓝图 §8 风险表)
        expect(elapsedMs).toBeLessThanOrEqual(EXHAUSTIVE_TIME_BUDGET_MS)
      },
    )
  })

  // ============================================================================
  // ⑤ fast-check 属性面 (与单循环互补: 随机输入覆盖 720k 未枚举的维度组合)
  // ============================================================================

  describe("fast-check 属性面 (守恒/纯函数/确定性三属性)", () => {
    const stateArb: fc.Arbitrary<ControlState> = fc.record({
      phase: fc.constantFrom("planning", "writing", "complete"),
      stage: fc.constantFrom("context", "scene_breakdown", "task_brief", "draft", "review", "revision", "done"),
      chapterNumber: fc.integer({ min: 0, max: 50 }),
      completedChapters: fc.integer({ min: 0, max: 50 }),
      pendingRewrites: fc.array(fc.integer({ min: 1, max: 50 }), { maxLength: 3 }),
      gates: fc.record({
        consistency: fc.constantFrom("pending", "pass", "fail"),
        anti_ai: fc.constantFrom("pending", "pass", "fail"),
        quality: fc.constantFrom("pending", "pass", "fail"),
      }),
      antiAiMode: fc.constantFrom("off", "warn", "block"),
      manualReviewRequired: fc.boolean(),
      foundationMissing: fc.array(fc.constantFrom("characters", "world_rules", "magic"), { maxLength: 3 }),
      planningTier: fc.constantFrom("", "short", "long"),
      reviewInterval: fc.integer({ min: 0, max: 10 }),
      lastGlobalReviewChapter: fc.integer({ min: 0, max: 50 }),
      arcBoundary: fc
        .option(
          fc.record({
            isArcEnd: fc.boolean(),
            isVolumeEnd: fc.boolean(),
            needsExpansion: fc.boolean(),
            needsNewVolume: fc.boolean(),
            nextArc: fc.integer({ min: 0, max: 10 }),
          }),
        )
        .map((v) => v ?? undefined),
      hasArcReview: fc.boolean(),
      hasArcSummary: fc.boolean(),
      hasVolumeSummary: fc.boolean(),
      shellMode: fc.constantFrom("legacy", "consult", "authoritative"),
    })

    it("守恒: route() 不修改输入状态 (调用前后 DeepEqual)", () => {
      fc.assert(
        fc.property(stateArb, (state) => {
          const before = structuredClone(state)
          route(state)
          expect(state).toEqual(before)
        }),
        { numRuns: 200 },
      )
    })

    it("纯函数: 输出为全新对象, 不别名输入, 跨调用互不共享", () => {
      fc.assert(
        fc.property(stateArb, (state) => {
          const first = route(state)
          const second = route(state)
          expect(Object.is(first, state)).toBe(false)
          expect(Object.is(second, state)).toBe(false)
          expect(Object.is(first, second)).toBe(false)
        }),
        { numRuns: 200 },
      )
    })

    it("确定性: 同输入两次调用 DeepEqual 同输出", () => {
      fc.assert(
        fc.property(stateArb, (state) => {
          expect(route(state)).toEqual(route(state))
        }),
        { numRuns: 200 },
      )
    })
  })
})
