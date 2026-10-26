/**
 * deterministic-continuity-core-detectors.ts — 核心机械检测器组 (零 IO 零 LLM 纯函数)
 *
 * M6-2 增量切片: 纯搬迁自 deterministic-continuity-engine.ts (零逻辑变更)。
 * 内聚块: ADR-31 阈值保底公式 (resolveDormantThreshold /
 * resolveUnresolvedForeshadowingThreshold) + pipeline-of-detectors 5 项核心检测
 * (detectDormantThread / detectAbsentCharacter / detectOverdueThread /
 * detectDeadCharacterState / detectThreadArcFinding) + subplot lastSeenChapter
 * fold 反推 (deriveSubplotLastSeenChapter)。
 * 已切片的去噪链 (deterministic-continuity-denoise.ts) 不在此块, 无双生实现。
 *
 * 纯函数纪律 (守 ADR-29 C-001): 本文件 import 仅限 type-only (ReadonlyStore /
 * ContinuityEngineConfig / ContinuityFinding 经 engine 类型回指, 已擦除零运行时) +
 * 纯函数 analyzeForeshadowingDebt (foreshadowing-debt.ts) + deriveThreadArcState /
 * detectArcTransitionViolations (story-thread-arcs.ts)。零 store loader / fs /
 * invoke / streamChat。新增文件零新依赖。
 */

import type { ForeshadowingStore } from "./foreshadowing-tracker"
import type { Subplot } from "./subplot-board"
import type { CharacterState } from "./character-state"
import type { ChapterSnapshot } from "./chapter-ingest"
import type {
  ContinuityEngineConfig,
  ContinuityFinding,
  ReadonlyStore,
} from "./deterministic-continuity-engine"
import { analyzeForeshadowingDebt } from "./foreshadowing-debt"
import { deriveThreadArcState, detectArcTransitionViolations } from "./story-thread-arcs"

/**
 * resolveDormantThreshold (ADR-31): 比例阈值保底公式 max(N, floor(total*ratio))。
 * 小章数保底 max 下限 (3), 大章数按比例防误报风暴 (0.02)。
 * totalChapters = store.currentChapter (当前章号作 total 估计)。
 */
export function resolveDormantThreshold(
  totalChapters: number,
  config: ContinuityEngineConfig,
): number {
  return Math.max(config.dormantThresholdChapters, Math.floor(totalChapters * 0.02))
}

/**
 * resolveUnresolvedForeshadowingThreshold (ADR-31): 伏笔未回收阈值保底公式
 * max(10, floor(total*unresolvedForeshadowingRatio))。保底 10 章, 独立 ratio
 * 0.05 不复用 overdueRatio (守 C-004)。
 */
export function resolveUnresolvedForeshadowingThreshold(
  totalChapters: number,
  config: ContinuityEngineConfig,
): number {
  return Math.max(10, Math.floor(totalChapters * config.unresolvedForeshadowingRatio))
}

// ============================================================================
// 内部检测函数 (各产 ContinuityFinding[], pipeline-of-detectors ADR-29)
// ============================================================================

/**
 * Subplot 扩展类型: Subplot 接口已有 lastSeenChapter? (subplot-board.ts additive
 * optional A19 引擎休眠检测用字段)。writehook (updateSubplotLastSeenChapter,
 * 落 sibling 薄包装) 增量更新落盘值后引擎直接读; undefined 调
 * deriveSubplotLastSeenChapter fold 反推, 仍 undefined 产 data_gap finding
 * (显式标注缺数据, 不静默降级守 IC-02)。
 */
type SubplotWithLastSeen = Subplot & { lastSeenChapter?: number }

/**
 * detectDormantThread: 遍历未 resolved 的 subplot, 优先读 s.lastSeenChapter
 * (writehook 增量更新落盘值), undefined 调 deriveSubplotLastSeenChapter fold
 * 反推, 仍 undefined 产 data_gap (info, 守 IC-02 不静默降级), 否则
 * currentChapter - lastSeen > resolveDormantThreshold(currentChapter, config)
 * 产 dormant_thread (warning, consistency_mechanical)。
 *
 * severity warning 对齐 blueprint ADR-30 (dormant_thread/absent_character/
 * unresolved_foreshadowing=warning 提醒不阻断; critical 只 dead_character_state/
 * overdue_thread)。
 */
export function detectDormantThread(
  store: ReadonlyStore,
  config: ContinuityEngineConfig,
): ContinuityFinding[] {
  const findings: ContinuityFinding[] = []
  const threshold = resolveDormantThreshold(store.currentChapter, config)
  for (const s of store.subplots) {
    if (s.status === "resolved") continue
    const stored = (s as SubplotWithLastSeen).lastSeenChapter
    const lastSeen = stored ?? deriveSubplotLastSeenChapter(s, store.snapshots)
    if (lastSeen === undefined) {
      findings.push({
        type: "data_gap",
        subtype: "data_gap",
        severity: "info",
        ref: `subplot:${s.id}`,
        message: `subplot ${s.title} 缺 lastSeenChapter 字段且 fold 反推无匹配`,
        chapter: store.currentChapter,
        missingField: "lastSeenChapter",
      })
      continue
    }
    const gap = store.currentChapter - lastSeen
    if (gap > threshold) {
      findings.push({
        type: "dormant_thread",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: `subplot:${s.id}`,
        message: `subplot ${s.title} 休眠 ${gap} 章 (lastSeen ${lastSeen}, current ${store.currentChapter}, threshold ${threshold})`,
        chapter: store.currentChapter,
        taxonomyDimId: "subplot_resolution",
      })
    }
  }
  return findings
}

/**
 * detectAbsentCharacter: 遍历 characters, 先读 c.lastSeenChapter? (Phase 4
 * deferred 字段, undefined 回退), 回退 currentChapter - lastUpdatedChapter >
 * absentThresholdChapters 产 absent_character。protagonist (config.protagonistNames
 * 含 characterName) 产 warning, 配角降级 info (absent_character protagonist-only
 * ADR-31)。subtype consistency_mechanical。
 */
export function detectAbsentCharacter(
  store: ReadonlyStore,
  config: ContinuityEngineConfig,
): ContinuityFinding[] {
  const findings: ContinuityFinding[] = []
  const charWithLastSeen = store.characters as readonly (CharacterState & {
    lastSeenChapter?: number
  })[]
  for (const c of charWithLastSeen) {
    const lastSeen = c.lastSeenChapter ?? c.lastUpdatedChapter
    const gap = store.currentChapter - lastSeen
    if (gap > config.absentThresholdChapters) {
      const isProtagonist = config.protagonistNames.includes(c.characterName)
      findings.push({
        type: "absent_character",
        subtype: "consistency_mechanical",
        severity: isProtagonist ? "warning" : "info",
        ref: `character:${c.characterName}`,
        message: `${c.characterName} 缺席 ${gap} 章 (lastSeen ${lastSeen})`,
        chapter: store.currentChapter,
        taxonomyDimId: "character_consistency",
      })
    }
  }
  return findings
}

/**
 * detectOverdueThread: 复用 analyzeForeshadowingDebt (foreshadowing-debt.ts:34)
 * 产 ForeshadowingDebtReport, debtLevel==='critical' 产 overdue_thread (critical,
 * consistency_mechanical), debtLevel==='warning' 产 unresolved_foreshadowing
 * (warning)。不重写逾期检测 (守 Niko Buddy CLAUDE.md 禁止 clean-room 重写)。
 *
 * Phase 3 (LE-1): Subplot targetResolutionChapter?/abandoned? 结构化逾期标记
 * 已接入 — 优先读 s.targetResolutionChapter?/s.abandoned?，字段存在则判 critical
 * （结构化逾期），undefined 回退 data_gap 降级（不阻断，守 IC-02）。
 * 既有 foreshadowing 逾期检测保留不变。
 */
export function detectOverdueThread(
  store: ReadonlyStore,
  _config: ContinuityEngineConfig,
): ContinuityFinding[] {
  const findings: ContinuityFinding[] = []

  // Phase 3: Subplot 结构化逾期检测（优先读结构化字段）
  for (const s of store.subplots) {
    if (s.status === "resolved") continue

    // 结构化 abandoned=true → 废弃标记
    if (s.abandoned === true) {
      findings.push({
        type: "overdue_thread",
        subtype: "consistency_mechanical",
        severity: "critical",
        ref: `subplot:${s.id}`,
        message: `subplot ${s.title} 被标记为废弃 (abandoned=true, 结构化逾期)`,
        chapter: store.currentChapter,
        taxonomyDimId: "subplot_resolution",
      })
      continue
    }

    // 结构化 targetResolutionChapter 存在且 ≤ currentChapter → 逾期
    if (s.targetResolutionChapter !== undefined) {
      if (s.targetResolutionChapter <= store.currentChapter) {
        findings.push({
          type: "overdue_thread",
          subtype: "consistency_mechanical",
          severity: "critical",
          ref: `subplot:${s.id}`,
          message: `subplot ${s.title} targetResolutionChapter ${s.targetResolutionChapter} <= current ${store.currentChapter} (结构化逾期)`,
          chapter: store.currentChapter,
          taxonomyDimId: "subplot_resolution",
        })
      }
      // targetResolutionChapter > currentChapter → 未到期，不产 finding
      continue
    }

    // 结构化字段均 undefined → data_gap 降级（不阻断，守 IC-02）
    findings.push({
      type: "data_gap",
      subtype: "data_gap",
      severity: "info",
      ref: `subplot:${s.id}`,
      message: `subplot ${s.title} 缺 targetResolutionChapter/abandoned 字段，无法判断逾期`,
      chapter: store.currentChapter,
      missingField: "targetResolutionChapter",
    })
  }

  // 既有 foreshadowing 逾期检测（保留不变）
  const report = analyzeForeshadowingDebt(
    { items: [...store.foreshadowing] } as ForeshadowingStore,
    store.currentChapter,
  )
  for (const item of report.items) {
    if (item.debtLevel === "critical") {
      findings.push({
        type: "overdue_thread",
        subtype: "consistency_mechanical",
        severity: "critical",
        ref: `foreshadowing:${item.id}`,
        message: `foreshadowing ${item.name} 逾期未回收 (debtLevel critical, planted ${item.plantedChapter}, current ${store.currentChapter})`,
        chapter: store.currentChapter,
        taxonomyDimId: "foreshadowing_integrity",
      })
    } else if (item.debtLevel === "warning") {
      findings.push({
        type: "unresolved_foreshadowing",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: `foreshadowing:${item.id}`,
        message: `foreshadowing ${item.name} 未回收 (debtLevel warning, status ${item.status})`,
        chapter: store.currentChapter,
        taxonomyDimId: "foreshadowing_integrity",
      })
    }
  }
  return findings
}

/**
 * detectDeadCharacterState: 遍历 characters, 先读 c.deathChapter? (Phase 2
 * deferred 结构化字段, undefined 回退) → c.isAlive? (Phase 2, undefined 回退) →
 * 回退 status 自由文本正则匹配 deadCharacterPatterns (现状兼容守 NFR-compat-001)。
 * 匹配死亡且 lastUpdatedChapter >= currentChapter - 3 (死亡后近期仍有状态变更即
 * 活跃态) 产 dead_character_state (critical, consistency_mechanical)。
 */
export function detectDeadCharacterState(
  store: ReadonlyStore,
  config: ContinuityEngineConfig,
): ContinuityFinding[] {
  const findings: ContinuityFinding[] = []
  const charWithDeath = store.characters as readonly (CharacterState & {
    isAlive?: boolean
    deathChapter?: number
  })[]
  for (const c of charWithDeath) {
    // 先读结构化字段 (Phase 2 deferred), undefined 回退 status 自由文本正则匹配。
    const isDeadByStructural =
      c.isAlive === false ||
      (c.deathChapter !== undefined && c.deathChapter <= store.currentChapter)
    // LE-2 Phase 2: isAlive === true 作为活态守卫, 跳过 regex fallback,
    // 消除「死不瞑目」等成语假阳性 (AC-002.6)。isAlive undefined 时仍回退正则。
    const isAliveGuard = c.isAlive === true
    const isDeadByText =
      isAliveGuard
        ? false
        : !c.status
          ? false
          : config.deadCharacterPatterns.some((p) => c.status.includes(p))
    const isDead = isDeadByStructural || isDeadByText
    if (!isDead) continue
    if (c.lastUpdatedChapter >= store.currentChapter - 3) {
      findings.push({
        type: "dead_character_state",
        subtype: "consistency_mechanical",
        severity: "critical",
        ref: `character:${c.characterName}`,
        message: `${c.characterName} 标记死亡 (status:${c.status || "structural"}) 但 lastUpdatedChapter ${c.lastUpdatedChapter} 接近 currentChapter ${store.currentChapter} 疑似死亡角色活跃态`,
        chapter: store.currentChapter,
        taxonomyDimId: "character_consistency",
      })
    }
  }
  return findings
}

// ============================================================================
// S2c (roadmap R08): Quillica Story Threads 6 状态机合并检测器
// ============================================================================

/**
 * detectThreadArcFinding (S2c): 基于 Quillica 6 态 (Setup/Rising/Climax/
 * Falling/Resolved/Unresolved) 派生每个 subplot 的弧位, 只报两类 finding:
 * ① 弧断裂: Resolved/Unresolved 终态后仍有 progress 条目 (状态机转移违反)
 * ② 高潮段后断裂: 曾达 Climax (progress≥5) 但 long-gap 回落 → Falling 断裂
 * 不重复 dormant_thread (休眠仍由 detectDormantThread 报, 守 roadmap 合并非双轨)。
 * subtype consistency_mechanical (同其它机械检测器), 进 consistency gate。
 */
export function detectThreadArcFinding(
  store: ReadonlyStore,
  config: ContinuityEngineConfig,
): ContinuityFinding[] {
  const findings: ContinuityFinding[] = []
  const climaxProgressCount = 5
  for (const s of store.subplots) {
    const derived = detectArcTransitionViolations(
      s,
      deriveThreadArcState(s, store.currentChapter, {
        climaxProgressCount,
        fallingGapChapters: resolveDormantThreshold(store.currentChapter, config),
      }),
    )
    // ① 状态机转移违反 (Resolved 后仍推进)
    if (derived.transitionViolation) {
      findings.push({
        type: "dormant_thread", // 复用 dormant_thread 类型槽 (不新增 finding type 破坏下游)
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: `subplot:${s.id}`,
        message: `thread ${s.title} 弧状态违反: ${derived.transitionViolation} (Quillica 6 态)`,
        chapter: store.currentChapter,
        taxonomyDimId: "arc_structural", // T24: 弧位语义归 T22 arc_structural (非支线闭环)
      })
      continue
    }
    // ② 高潮段后断裂: progress≥5 曾达 Climax 且 Falling 由 long-gap 造成
    const progressCount = s.progress?.length ?? 0
    if (derived.arcState === "Falling" && progressCount >= climaxProgressCount) {
      findings.push({
        type: "dormant_thread",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: `subplot:${s.id}`,
        message: `thread ${s.title} 高潮段后断裂 (Quillica: Climax→Falling, ${derived.basis})`,
        chapter: store.currentChapter,
        taxonomyDimId: "arc_structural", // T24: 同上, 弧结构槽位
      })
    }
  }
  return findings
}

// ============================================================================
// subplot lastSeenChapter 反推 (纯函数 — 调用方已加载 snapshots)
// ============================================================================

/**
 * deriveSubplotLastSeenChapter: 纯函数从 chapter-snapshot chain fold 反推
 * subplot 最后出现章号。反向遍历 snapshots (chapterNumber 降序, 取最新匹配),
 * 找第一个 snapshot 其 summary / characterStateChanges / foreshadowingChanges
 * 文本 includes(subplot.title) 的 chapterNumber 返回。无匹配返回 undefined
 * (调用方产 data_gap finding, 守 IC-02 不静默降级)。
 *
 * 纯函数零 IO 零 LLM: 入参 subplot + snapshots (调用方已加载), 返回 number|undefined。
 * O(C×S) 大书下放大但只在线下 backfill (writehook 未接入或旧数据一次性计算) 触发,
 * 正常运行时 writehook 增量更新 lastSeenChapter 落盘, 引擎直接读落盘值不调 fold。
 */
export function deriveSubplotLastSeenChapter(
  subplot: Subplot,
  snapshots: readonly ChapterSnapshot[],
): number | undefined {
  // 按章号降序取最新匹配 (snapshots 可能未预排序, 显式排序保证最新优先)。
  const sorted = [...snapshots].sort((a, b) => b.chapterNumber - a.chapterNumber)
  for (const snap of sorted) {
    const haystack = [
      snap.summary,
      ...snap.characterStateChanges,
      ...snap.foreshadowingChanges,
    ].join("\n")
    if (haystack.includes(subplot.title)) {
      return snap.chapterNumber
    }
  }
  return undefined
}
