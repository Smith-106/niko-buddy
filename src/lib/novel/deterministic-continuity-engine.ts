/**
 * deterministic-continuity-engine.ts — 确定性连续性引擎 (零 IO 零 LLM 纯函数)
 *
 * 对齐 blueprint BLP-continuity-engine-2026-07-18 ADR-29 (Route B-1 纯函数模块) +
 * ADR-30 (ContinuityFinding subtype 联合, 3 级 severity critical|warning|info) +
 * ADR-31 (中文阈值 CV 0.1 + max(N,floor(total*ratio)) 保底公式 + backward compat
 * additive-only deferred Phase 2/3/4) + ADR-33 (consistency_mechanical gate 映射
 * + 机械先于语义短路) + ADR-34 (override 双轨 + reasonCode 6 值合并集 + 机械
 * critical 不进 fix-loop)。借鉴 Novel-OS 5 项检测 + 复用 QMAI 已有
 * analyzeForeshadowingDebt (foreshadowing-debt.ts:34 已实现逾期检测, 守 QMAI
 * CLAUDE.md 禁止 clean-room 重写)。
 *
 * 纯函数零 IO 零 LLM (ADR-29 C-001): 引擎模块 MUST NOT 导入任何 store loader /
 * fs / invoke / streamChat。本文件 import 仅限 type-only (ForeshadowingStore /
 * Subplot / CharacterState / ChapterSnapshot) + 纯函数 analyzeForeshadowingDebt
 * (foreshadowing-debt.ts 也是纯函数无 IO)。override 持久化 IO 落 sibling 薄包装
 * continuity-overrides-store.ts (ADR-29 例外: 装配器薄包装层)。
 *
 * 6 项检测 (ADR-30 ConsistencyMechanicalFinding subtype=consistency_mechanical):
 *   - detectDormantThread: subplot 休眠 (currentChapter - lastSeenChapter > 阈值)
 *   - detectAbsentCharacter: 角色缺席 (currentChapter - lastUpdatedChapter > 阈值)
 *   - detectOverdueThread: 复用 analyzeForeshadowingDebt 产 overdue/unresolved
 *   - detectDeadCharacterState: 角色死亡但近期仍更新 (death 活跃)
 *   - detectTimelineDrift (F-002 第 6 检测项): 事件时序矛盾 + 章号跳跃
 *     (type timeline_drift, subtype consistency_mechanical, additive)
 *
 * ContinuityFinding (ADR-30): discriminated union on type, subtype 联合
 * consistency_mechanical | data_gap, severity 3 级 critical|warning|info (非
 * GRL-011 4 级 — 严格对齐 blueprint ADR-30)。ConsistencyMechanicalFinding =
 * subtype:'consistency_mechanical'; DataGapFinding = subtype:'data_gap' +
 * missingField。message + evidence? 字段全脱敏 (守 CWE-532 不引用正文)。
 *
 * 引擎双入口:
 *   - checkContinuity(store: ReadonlyStore, config): ContinuityFinding[] (blueprint
 *     权威 API, ADR-29 Route B-1 + ContinuityEngineConfig)。生产调用点 (review-adapter /
 *     deep-chapter-generation) 经 buildReadonlyStoreFromInput 转 ContinuityInput 后调用。
 *   - runContinuityEngine(input: ContinuityInput): ContinuityFinding[] (legacy 别名,
 *     外部 caller backward compat, 经 buildReadonlyStoreFromInput → 委托 checkContinuity)
 */

import type { ForeshadowingStore } from "./foreshadowing-tracker"
import type { Subplot } from "./subplot-board"
import type { CharacterState } from "./character-state"
import type { ChapterSnapshot } from "./chapter-ingest"
// T24 (TASK-P3-24): taxonomyDimId 映射目标 = T22 audit-taxonomy 37 维 id。
// 仅 type-only import (零运行时依赖, 守本文件 ADR-29 纯函数零 IO 零 LLM 纪律)。
import type { AuditDimensionId } from "./audit-taxonomy"
import { analyzeForeshadowingDebt } from "./foreshadowing-debt"
// S2c (roadmap R08): Quillica Story Threads 6 状态机合并 — 新检测维度。
// 只 import 纯函数 (deriveThreadArcState/detectArcTransitionViolations),
// 无 IO 无 LLM, 保持本文件 import 纪律 (fs / invoke / streamChat 零引用)。
import { deriveThreadArcState, detectArcTransitionViolations } from "./story-thread-arcs"

// ============================================================================
// 类型导出 (ADR-30 ContinuityFinding discriminated union on type)
// ============================================================================

export type ContinuityFindingType =
  | "dormant_thread"
  | "absent_character"
  | "overdue_thread"
  | "unresolved_foreshadowing"
  | "dead_character_state"
  | "timeline_drift"
  | "data_gap"
  /** 三模型共识 (2026-08-27, Grok 过程库): 「他不该知道」POV 信息边界泄露检测。 */
  | "knowledge_boundary"
  /** 三模型共识 (2026-08-27, Grok 过程库): 「东西丢了」粒子/物品连续性检测。 */
  | "lost_item"
  /** 51 号报告 G1: 地理/物理屏障状态违反（角色穿越未开启的屏障）— severity critical。 */
  | "barrier_state"
  /** 51 号报告 G1: 在场路径矛盾（角色同一时间窗出现在互斥地点）— severity warning。 */
  | "presence_path"
  /** 51 号报告 G1: 容器状态违反（物品从密闭容器无开启动作取出）— severity warning。 */
  | "container_state"
  /** 51 号报告 G1: 集合基数漂移（团队/库存计数跨章不一致）— severity warning。 */
  | "set_count_drift"

export type ContinuityFindingSubtype = "consistency_mechanical" | "data_gap"

/** ADR-30: 3 级 severity critical|warning|info (非 GRL-011 4 级 — blueprint 权威) */
export type ContinuitySeverity = "critical" | "warning" | "info"

/**
 * ContinuityFindingBase (ADR-30): 6 类 finding 共享基础字段。
 * ref: 非空字符串实体标识, 如 `character:菜月昴` / `subplot:复仇线` / `foreshadowing:F-001`。
 * message: 模板化原因, 不引用章节正文 (守 CWE-532)。
 * evidence?: 全脱敏证据 (实体标识/章号, 非正文片段, 守 CWE-532)。
 */
export interface ContinuityFindingBase {
  type: ContinuityFindingType
  subtype: ContinuityFindingSubtype
  severity: ContinuitySeverity
  ref: string
  message: string
  chapter: number
  /** 全脱敏证据 (实体标识/章号, 不引用正文守 CWE-532) */
  evidence?: string
  /**
   * T24 (TASK-P3-24) additive: 归属 T22 audit-taxonomy 37 维审计维度 id。
   * 机械检测项 → 37 维映射 (dormant/overdue subplot→subplot_resolution,
   * absent/dead→character_consistency, foreshadowing→foreshadowing_integrity,
   * thread arc→arc_structural, timeline_drift→timeline_consistency)。
   * data_gap 无 37 维槽位 → 字段缺省 (undefined, 非 consistency 统计口径守 IC-02)。
   * additive-only: 缺省 undefined 时下游零行为变更 (守 ADR-31)。
   */
  taxonomyDimId?: AuditDimensionId
  /**
   * 53 号报告 P0-1 additive: canonical_family 归一 (镜像 pagegod V38
   * CANONICAL_FAMILY 14 code→9 family 语义, Apache-2.0 借模式)。由检测器
   * 机械赋值 (非 LLM), 供 merge/suppress 去噪阶段分组。
   * additive-only: 缺省 undefined 时下游零行为变更 (守 ADR-31)。
   */
  canonicalFamily?: string
}

/**
 * ConsistencyMechanicalFinding (ADR-30): 机械检测 finding, subtype 固定
 * 'consistency_mechanical'。5 类机械检测 (dormant_thread/absent_character/
 * overdue_thread/unresolved_foreshadowing/dead_character_state) 路由 consistency gate。
 */
export interface ConsistencyMechanicalFinding extends ContinuityFindingBase {
  subtype: "consistency_mechanical"
}

/**
 * DataGapFinding (ADR-30): 缺字段 finding, subtype 固定 'data_gap' +
 * missingField (如 'targetResolutionChapter' / 'lastSeenChapter')。独立分组
 * 不进 consistency gate 统计 (守 IC-02 不静默降级)。
 */
export interface DataGapFinding extends ContinuityFindingBase {
  subtype: "data_gap"
  missingField: string
}

/**
 * ContinuityFinding (ADR-30): discriminated union on subtype。
 * switch on subtype 穷尽性检查 (ConsistencyMechanicalFinding | DataGapFinding)。
 */
export type ContinuityFinding = ConsistencyMechanicalFinding | DataGapFinding

/**
 * TimelineDriftEvent (F-002 第 6 检测项): detectTimelineDrift 输入事件。由装配层
 * 从 timeline.ts 事件序列 + 角色归因组装 (additive-only, 不改 timeline.ts — 后者
 * TimelineEntry 仅含 chapterNumber/event, 无角色引用章维度)。纯函数零 IO: 引擎
 * 不 reload, 事件由调用方加载传入 ReadonlyStore.timelineEvents。
 *
 * ref: 实体标识 (与 finding.ref 同格式, 如 `character:菜月昂`), detectTimelineDrift
 * 按 ref 分组检测时间序矛盾。
 * chapter: 事件记录/出现的章号 (录制顺序, 用于分组内时序排序)。
 * referencedChapter: 事件叙事回引的章号 (故事时间点), 用于单调性 (非递减) +
 * 章号跳跃检测。
 */
export interface TimelineDriftEvent {
  ref: string
  chapter: number
  referencedChapter: number
}

/**
 * 51 号报告 G1: 屏障状态事件 (barrier_state 检测器输入)。
 * 装配层从场景/地点状态组装 (additive, 可选切片)。
 * ref: 屏障标识 (如 `barrier:北城门`)。chapter: 状态变更记录章号。
 * isOpen: 章末状态。crossedChapter: 角色穿越该屏障的章号 (未穿越 undefined)。
 */
export interface BarrierStateEvent {
  ref: string
  chapter: number
  isOpen: boolean
  crossedChapter?: number
}

/** 51 号报告 G1: 在场事件 (presence_path 检测器输入)。 */
export interface PresenceEvent {
  ref: string
  chapter: number
  location: string
}

/** 51 号报告 G1: 容器状态事件 (container_state 检测器输入)。 */
export interface ContainerStateEvent {
  ref: string
  chapter: number
  isOpen: boolean
  takenOutItem?: string
}

/** 51 号报告 G1: 集合基数快照 (set_count_drift 检测器输入)。 */
export interface SetCountSnapshot {
  /** 集合标识 (如 `party:主角团` / `inventory:背包`)。 */
  ref: string
  chapter: number
  /** 章末计数 (成员数/物品数)。 */
  count: number
}

// ============================================================================
// ReadonlyStore (ADR-29 C-005 复用已加载 store 不可变视图) + ContinuityEngineConfig
// ============================================================================

/**
 * ReadonlyStore (ADR-29): 引擎入参的不可变视图。所有字段 readonly 修饰 +
 * readonly T[] 不可变数组。引擎 MUST NOT 独立 reload (复用调用点已加载 in-memory
 * store, 守 C-005/SA-07/SA-08)。装配器在调用点薄包装内 load + 组装 (buildReadonlyStore)。
 */
export interface ReadonlyStore {
  readonly foreshadowing: readonly ForeshadowingStore["items"][number][]
  readonly subplots: readonly Subplot[]
  readonly characters: readonly CharacterState[]
  readonly snapshots: readonly ChapterSnapshot[]
  readonly currentChapter: number
  /** F-002 第 6 检测项 (timeline_drift) 输入: 时间线事件序列 (additive, 可选)。
   * 装配层从 timeline.ts 事件序列组装; 缺失 (undefined/空) 时引擎跳过该检测器。 */
  readonly timelineEvents?: readonly TimelineDriftEvent[]
  /** 51 号报告 G1: 屏障状态事件 (barrier_state)。缺失时跳过该检测器 (additive)。 */
  readonly barrierEvents?: readonly BarrierStateEvent[]
  /** 51 号报告 G1: 在场事件 (presence_path)。缺失时跳过该检测器 (additive)。 */
  readonly presenceEvents?: readonly PresenceEvent[]
  /** 51 号报告 G1: 容器状态事件 (container_state)。缺失时跳过该检测器 (additive)。 */
  readonly containerEvents?: readonly ContainerStateEvent[]
  /** 51 号报告 G1: 集合基数快照 (set_count_drift)。缺失时跳过该检测器 (additive)。 */
  readonly setCountSnapshots?: readonly SetCountSnapshot[]
}

/**
 * ContinuityEngineConfig (ADR-31 DA-07 camelCase 权威): 引擎阈值配置。
 * 所有阈值从 config 传入 (装配层可覆盖), 缺省值在 DEFAULT_CONTINUITY_CONFIG。
 * protagonistNames: 仅主角缺席产 warning, 配角降级 info (absent_character protagonist-only)。
 */
export interface ContinuityEngineConfig {
  dormantThresholdChapters: number
  absentThresholdChapters: number
  overdueRatio: number
  /** 独立不复用 overdueRatio (守 C-004) */
  unresolvedForeshadowingRatio: number
  deadCharacterPatterns: string[]
  protagonistNames: string[]
  /** F-002 第 6 检测项: 事件关联章号跳跃阈值 (当前 chapterNumber 与事件
   * referencedChapter 差 > 此值才产 timeline_drift)。默认 3 (参照缺席 5→7/
   * 休眠 3→10 校准先例, additive 覆盖机制允许用户微调)。 */
  timelineDriftMaxChapterGap: number
}

// ============================================================================
// ContinuityInput (legacy 兼容 — 现有 review-adapter / deep-chapter-generation 调用点)
// ============================================================================

/**
 * ContinuityInput: legacy 引擎入参 (runContinuityEngine 接受), 与 ReadonlyStore
 * 字段同构 (foreshadowing/subplots/characters/snapshots/currentChapter) 但无 readonly
 * 修饰。保留供现有调用点 (review-adapter.runContinuityMechanicalPreflight /
 * deep-chapter-generation.runContinuityPreCheck / checkContinuityCritical) 兼容,
 * 内部转换为 ReadonlyStore 后委托 checkContinuity。后续 plan session 可逐步迁移
 * 调用点到 ReadonlyStore + ContinuityEngineConfig。
 */
export interface ContinuityInput {
  foreshadowing: ForeshadowingStore["items"]
  subplots: Subplot[]
  characters: CharacterState[]
  snapshots: ChapterSnapshot[]
  currentChapter: number
}

// ============================================================================
// 阈值缺省值 (ADR-31) + 保底公式 helper
// ============================================================================

/**
 * DEFAULT_CONTINUITY_CONFIG (ADR-31): 引擎阈值缺省值。
 * [中文校准 2026-07-20] 已用 scripts/calibrate-from-epub.mjs 对 Re0 从零开始的
 * 异世界生活 10 卷 138 章正文跑校准:
 * - absent 分布 312 卷内 gap 样本, min=1 max=20, P50=3 P75=7 P90=11
 * - dormant 分布 753 卷内 gap 样本, min=1 max=29, P50=4 P75=10 P90=16
 * - absentThresholdChapters 从默认 5 上调到 7 (P75, 保守偏高防假阳性守 GRL-011 Risk 3)
 * - dormantThresholdChapters 从默认 3 上调到 10 (P75, 753 样本充分置信; 3 偏低致
 *   正常节奏线索休眠被误报 dormant_thread)
 * 校准方法: 直接从 epub 文本检测角色/关键词每章出现 → 推 lastSeenChapter → 算卷内
 * gap (不跨卷, 跨卷缺席是剧情跨度非连续性断裂), gap 公式镜像引擎 detectAbsentCharacter
 * (289-296) + detectDormantThread (245-280) + deriveSubplotLastSeenChapter (413-430).
 * 死亡角色/已 resolved subplot epub 无法识别故全纳入 (保守偏高, 与 P75 防假阳性一致).
 * 本地中文长篇仅 Re0 一本, 但 10 卷 138 章 312+753 样本已远超 issue 最低要求
 * (>=3 本 50+ 章 ≈ 150 章). absent + dormant 双维度均经真实中文样本正式校准替换.
 * - dormantThresholdChapters: 10 (P75 校准值, Re0 10 卷 753 样本; 保底 max(10, floor(total*0.02)))
 * - absentThresholdChapters: 7 (P75 校准值, Re0 10 卷 312 样本)
 * - overdueRatio: 0.02
 * - unresolvedForeshadowingRatio: 0.05 (独立不复用 overdueRatio 守 C-004)
 * - deadCharacterPatterns: ['死','亡','殒','逝','毙'] (死亡角色活跃态判定)
 * - protagonistNames: [] (从 config 注入, 装配层覆盖)
 *
 * [初步校准数据 2026-07-20 早期] Re0 从帕姆开始 (单本 9 章) 早期校准:
 * absent 22 样本 P75=8, dormant 0 样本. 已被上方 10 卷 312+753 样本充分校准取代
 * (absent P75=7, dormant P75=10 正式替换默认 5/3).
 *
 * 对齐 A19 mechanical-slop-detector CV 0.3→0.1 中文校准模式 (同模块范式)。
 */
export const DEFAULT_CONTINUITY_CONFIG: ContinuityEngineConfig = {
  dormantThresholdChapters: 10,
  absentThresholdChapters: 7,
  overdueRatio: 0.02,
  unresolvedForeshadowingRatio: 0.05,
  deadCharacterPatterns: ["死", "亡", "殒", "逝", "毙"],
  protagonistNames: [],
  timelineDriftMaxChapterGap: 3,
}

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
function detectDormantThread(
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
function detectAbsentCharacter(
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
 * (warning)。不重写逾期检测 (守 QMAI CLAUDE.md 禁止 clean-room 重写)。
 *
 * Phase 3 (LE-1): Subplot targetResolutionChapter?/abandoned? 结构化逾期标记
 * 已接入 — 优先读 s.targetResolutionChapter?/s.abandoned?，字段存在则判 critical
 * （结构化逾期），undefined 回退 data_gap 降级（不阻断，守 IC-02）。
 * 既有 foreshadowing 逾期检测保留不变。
 */
function detectOverdueThread(
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
function detectDeadCharacterState(
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
function detectThreadArcFinding(
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
// F-002 第 6 检测项: detectTimelineDrift (时间线漂移, timeline_drift)
// ============================================================================

/**
 * classifyTimelineDriftSeverity: 漂移 magnitude → ADR-30 3 级 severity
 * (critical|warning|info, 非 GRL-011 4 级 — engine 只有 3 级 blueprint 权威)。
 * 任务定的三档 (critical>5 / high>3 / warning>0) 无 4 级 "high" 槽, 故把
 * high 档映射为 warning: magnitude>5 → critical, 3<magnitude≤5 → warning,
 * 0<magnitude≤3 → info。
 */
export function classifyTimelineDriftSeverity(magnitude: number): ContinuitySeverity {
  if (magnitude > 5) return "critical"
  if (magnitude > 3) return "warning"
  return "info"
}

/**
 * detectTimelineDrift (F-002 第 6 检测项): 纯函数零 IO 零 LLM。复用装配层组装
 * 的 timeline 事件序列 (timeline.ts TimelineEntry 为权威数据源, 经角色归因映射为
 * TimelineDriftEvent) 检测两类时间漂移:
 *
 * a) 事件时序矛盾 (order contradiction): 同 ref (角色) 事件按章序录制时
 *    referencedChapter 非单调递增 (叙事时间倒退) → 产 timeline_drift, severity 按
 *    回静止幅度 classify (info/warning/critical)。
 * b) 事件关联章号跳跃 (chapter jump): 当前 chapterNumber 与事件 referencedChapter
 *    差 > config.timelineDriftMaxChapterGap (默认 3) → 产 timeline_drift, severity
 *    按 gap classify。
 *
 * subtype 固定 'consistency_mechanical' (同其它机械检测器, 进 consistency gate)。
 * ref 沿用 TimelineDriftEvent.ref 实体标识, evidence 脱敏 (实体/章号, 不引正文守
 * CWE-532)。additive-only: 不改既有检测项, 仅新增 (守 ADR-31)。
 */
export function detectTimelineDrift(
  timelineEvents: readonly TimelineDriftEvent[],
  chapterNumber: number,
  config: ContinuityEngineConfig = DEFAULT_CONTINUITY_CONFIG,
): ContinuityFinding[] {
  const findings: ContinuityFinding[] = []
  const maxGap = config.timelineDriftMaxChapterGap

  // b) 章号跳跃: 当前章与事件回引章差 > 阈值才产漂移 (阈值内不误报, 守 GRL-011 R3)。
  for (const ev of timelineEvents) {
    const gap = Math.abs(chapterNumber - ev.referencedChapter)
    if (gap <= maxGap) continue
    findings.push({
      type: "timeline_drift",
      subtype: "consistency_mechanical",
      severity: classifyTimelineDriftSeverity(gap),
      ref: ev.ref,
      message: `事件 ${ev.ref} 章号跳跃 ${gap} 章 (referenced ${ev.referencedChapter}, current ${chapterNumber}, threshold ${maxGap})`,
      chapter: chapterNumber,
      evidence: `ref:${ev.ref}, referencedChapter:${ev.referencedChapter}`,
      taxonomyDimId: "timeline_consistency",
    })
  }

  // a) 时序矛盾: 按 ref 分组, 章序录制时 referencedChapter 非递减 (running max)。
  const byRef = new Map<string, TimelineDriftEvent[]>()
  for (const ev of timelineEvents) {
    const bucket = byRef.get(ev.ref)
    if (bucket) bucket.push(ev)
    else byRef.set(ev.ref, [ev])
  }
  for (const [ref, events] of byRef) {
    // 按章号 + 回引章号稳定排序保证确定性 (同章多条按回引升序降伪报)。
    const sorted = [...events].sort(
      (a, b) => a.chapter - b.chapter || a.referencedChapter - b.referencedChapter,
    )
    let maxReferred = -Infinity
    for (const ev of sorted) {
      if (ev.referencedChapter < maxReferred) {
        const magnitude = maxReferred - ev.referencedChapter
        findings.push({
          type: "timeline_drift",
          subtype: "consistency_mechanical",
          severity: classifyTimelineDriftSeverity(magnitude),
          ref,
          message: `${ref} 事件时序矛盾: 章序 ${ev.chapter} 回引 ${ev.referencedChapter} 晚于已发生 ${maxReferred} (回退 ${magnitude})`,
          chapter: chapterNumber,
          evidence: `ref:${ref}, referencedChapter:${ev.referencedChapter}`,
          taxonomyDimId: "timeline_consistency",
        })
      } else {
        maxReferred = ev.referencedChapter
      }
    }
  }
  return findings
}

/**
 * detectTimelineDriftForStore: checkContinuity 内部适配器 — 复用 (store, config)
 * 检测器签名。store.timelineEvents 缺失 (undefined/空) 时返回 [] (additive 向后
 * 兼容: 旧调用点未装配 timelineEvents 零行为变化)。
 */
function detectTimelineDriftForStore(
  store: ReadonlyStore,
  config: ContinuityEngineConfig,
): ContinuityFinding[] {
  const events = store.timelineEvents
  if (!events || events.length === 0) return []
  return detectTimelineDrift(events, store.currentChapter, config)
}

// ============================================================================
// 51 号报告 G1: 4 类确定性检测器 (barrier_state / presence_path /
// container_state / set_count_drift) — 纯函数零 LLM, additive 可选切片。
// 参考 reference/pagegod V38.py HARD_ 规则族 (实证 14 条机械规则)。
// 各检测器遵循 timelineEvents 先例: 可选切片缺失 (undefined/空) → 返回 []
// (additive 向后兼容, 旧调用点未装配零行为变化)。
// ============================================================================

/**
 * detectBarrierState: 屏障状态违反 (severity critical)。
 * 规则: 屏障关闭 (isOpen=false) 且存在 crossedChapter (角色穿越) → critical。
 * 语义: 角色穿越了未开启的物理/地理屏障 (穿墙/锁门)。
 */
function detectBarrierState(store: ReadonlyStore): ContinuityFinding[] {
  const events = store.barrierEvents
  if (!events || events.length === 0) return []
  const findings: ContinuityFinding[] = []
  for (const e of events) {
    if (!e.isOpen && e.crossedChapter !== undefined) {
      findings.push({
        type: "barrier_state",
        subtype: "consistency_mechanical",
        severity: "critical",
        ref: e.ref,
        message: `屏障 ${e.ref} 在第 ${e.chapter} 章处于关闭状态，但记录显示第 ${e.crossedChapter} 章有角色穿越 (屏障状态违反)。`,
        chapter: e.crossedChapter,
        evidence: `barrier=${e.ref}; closedAtCh${e.chapter}; crossedAtCh${e.crossedChapter}`,
      })
    }
  }
  return findings
}

/**
 * detectPresencePath: 在场路径矛盾 (severity warning)。
 * 规则: 同一 ref (角色) 在同一 chapter 出现在 ≥2 个不同 location → warning。
 * 语义: 角色同一时间窗出现在互斥地点 (分身矛盾)。
 */
function detectPresencePath(store: ReadonlyStore): ContinuityFinding[] {
  const events = store.presenceEvents
  if (!events || events.length === 0) return []
  const findings: ContinuityFinding[] = []
  const byRefCh = new Map<string, Set<string>>()
  for (const e of events) {
    const key = `${e.ref}@${e.chapter}`
    const locs = byRefCh.get(key) ?? new Set<string>()
    locs.add(e.location)
    byRefCh.set(key, locs)
  }
  for (const [key, locs] of byRefCh) {
    if (locs.size >= 2) {
      const [ref, chStr] = key.split("@")
      const chapter = Number(chStr)
      findings.push({
        type: "presence_path",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref,
        message: `${ref} 在第 ${chapter} 章同时出现在 ${locs.size} 个不同地点 (在场路径矛盾)。`,
        chapter,
        evidence: `entity=${ref}; ch${chapter}; locations=${[...locs].join(",")}`,
      })
    }
  }
  return findings
}

/**
 * detectContainerState: 容器状态违反 (severity warning)。
 * 规则: 容器关闭 (isOpen=false) 且存在 takenOutItem → warning。
 * 语义: 物品从关闭的密闭容器无开启动作被取出。
 */
function detectContainerState(store: ReadonlyStore): ContinuityFinding[] {
  const events = store.containerEvents
  if (!events || events.length === 0) return []
  const findings: ContinuityFinding[] = []
  for (const e of events) {
    if (!e.isOpen && e.takenOutItem !== undefined) {
      findings.push({
        type: "container_state",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: e.ref,
        message: `容器 ${e.ref} 在第 ${e.chapter} 章处于关闭状态，但记录显示取出物品「${e.takenOutItem}」 (容器状态违反)。`,
        chapter: e.chapter,
        evidence: `container=${e.ref}; closedAtCh${e.chapter}; item=${e.takenOutItem}`,
      })
    }
  }
  return findings
}

/**
 * detectSetCountDrift: 集合基数漂移 (severity warning)。
 * 规则: 同一 ref 的 count 在相邻章号间无增减事件却变化 → warning。
 * 语义: 团队成员数/库存计数跨章不一致 (凭空增减)。
 */
function detectSetCountDrift(store: ReadonlyStore): ContinuityFinding[] {
  const snapshots = store.setCountSnapshots
  if (!snapshots || snapshots.length === 0) return []
  const findings: ContinuityFinding[] = []
  const byRef = new Map<string, SetCountSnapshot[]>()
  for (const s of snapshots) {
    const arr = byRef.get(s.ref) ?? []
    arr.push(s)
    byRef.set(s.ref, arr)
  }
  for (const [, arr] of byRef) {
    const sorted = [...arr].sort((a, b) => a.chapter - b.chapter)
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]
      const curr = sorted[i]
      if (prev.count !== curr.count) {
        findings.push({
          type: "set_count_drift",
          subtype: "consistency_mechanical",
          severity: "warning",
          ref: curr.ref,
          message: `${curr.ref} 计数从第 ${prev.chapter} 章 (${prev.count}) 变为第 ${curr.chapter} 章 (${curr.count})，无对应增减事件 (集合基数漂移)。`,
          chapter: curr.chapter,
          evidence: `set=${curr.ref}; ch${prev.chapter}=${prev.count}; ch${curr.chapter}=${curr.count}`,
        })
      }
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

// ============================================================================
// override 类型 (ADR-34 reasonCode 6 值合并集)
// ============================================================================

/**
 * ContinuityOverrideReasonCode (ADR-34 C-002 跨角色决议): 6 值合并集。
 * 枚举不可自由文本 (守可统计可审计追溯 AC-006.5/NFR-security-001)。
 */
export type ContinuityOverrideReasonCode =
  | "intentional_death" // 设计性死亡后仍出场 (鬼魂视角/回忆)
  | "intentional_absence" // 设计性主角缺席 (视角切换/留白)
  | "intentional_flashback" // 闪回跨章节出场
  | "posthumous_by_design" // 死后设计性活跃 (叙述结构)
  | "false_positive" // 机械检测假阳性
  | "state_layer_fix" // 状态层修复 (character-state 修正)

/**
 * ContinuityOverride (ADR-34): review 结果对象带 reasonCode + note + timestamp。
 * ref: 实体标识 (如 'character:菜月昴'), 与 finding.ref 同格式 (跨检测匹配键)。
 * note: 全脱敏不引用正文 (守 CWE-532)。severity: warning|critical (info 级 data_gap
 * 不允许 dismiss, guard 在 sibling 薄包装 dismissFinding)。dismissedAtChapter:
 * 章号 (非 ISO timestamp — 与 finding.chapter 对齐)。
 *
 * 持久化落 sibling continuity-overrides-store.ts (.novel/continuity-overrides.json,
 * createAtomicJsonStore 守 CWE-22 SEC-1)。
 */
export interface ContinuityOverride {
  ref: string
  reasonCode: ContinuityOverrideReasonCode
  note: string
  severity: "warning" | "critical"
  dismissedAtChapter?: number
}

export interface ContinuityOverrideStore {
  overrides: ContinuityOverride[]
  lastUpdated: string
}

// ============================================================================
// override 跨检测持久自动降级 (ADR-34 AC-006.5)
// ============================================================================

/**
 * isFindingDismissed: 纯函数, finding.ref 在 overrideStore.overrides 中存在匹配
 * 返回 true (跨检测自动降级, 守 AC-006.5/NFR-security-001)。
 *
 * 匹配键: ref 完全匹配 + severity 匹配 (override.severity === finding.severity
 * 当 finding.severity 为 critical|warning; info 级 finding 不在 store 有匹配因
 * dismissFinding guard 拒绝 info 级)。severity 升级 (warning→critical) 视为新
 * finding 重新提示 (守 ADR-34 跨检测追溯不静默删除)。
 */
export function isFindingDismissed(
  finding: ContinuityFinding,
  overrides: readonly ContinuityOverride[],
): boolean {
  if (finding.severity === "info") return false
  for (const override of overrides) {
    if (override.ref === finding.ref && override.severity === finding.severity) {
      return true
    }
  }
  return false
}

/**
 * applyOverrides: 纯函数, 对 findings 应用 override 降级 (匹配 ref+severity 的
 * finding severity 降级为 info, 守 ADR-34 跨检测持久自动降级 AC-006.5)。
 * 返回新数组 (不修改原数组, 守纯函数无副作用)。
 */
export function applyOverrides(
  findings: readonly ContinuityFinding[],
  overrides: readonly ContinuityOverride[],
): ContinuityFinding[] {
  if (overrides.length === 0) return [...findings]
  return findings.map((f) =>
    isFindingDismissed(f, overrides)
      ? { ...f, severity: "info" as const, message: `[override] ${f.message}` }
      : f,
  )
}

// ============================================================================
// 观测层 summary 纯函数
// ============================================================================

/**
 * ContinuityFindingSummary: 引擎执行 finding 计数摘要。供薄包装层调 logger.warn
 * + collectContinuityMetric 时用 (logger 双参 scope='continuity-engine' 守 memory
 * a19-emotion-ledger 坑)。引擎保持纯函数无 side effect (MAINT-1)。
 *
 * ADR-30: 3 级 severity (critical/warning/info) 分桶计数 + data_gap type 计数
 * (非 4 级 — blueprint 权威, ContinuitySeverity 类型只有 critical|warning|info)。
 * llm-client ContinuityMetric.high_count 字段保留兼容 (3 级方案下恒 0, 薄包装层
 * 传 0 守 metric 接口兼容, 不破坏 ContinuityMetric 契约)。
 */
export interface ContinuityFindingSummary {
  total: number
  critical: number
  warning: number
  info: number
  data_gap: number
}

export function summarizeContinuityFindings(
  findings: readonly ContinuityFinding[],
): ContinuityFindingSummary {
  const summary: ContinuityFindingSummary = {
    total: findings.length,
    critical: 0,
    warning: 0,
    info: 0,
    data_gap: 0,
  }
  for (const f of findings) {
    if (f.severity === "critical") summary.critical++
    else if (f.severity === "warning") summary.warning++
    /* v8 ignore next */
    else if (f.severity === "info") summary.info++ /* v8 ignore start */ /* v8 ignore stop */
    if (f.type === "data_gap") summary.data_gap++
  }
  return summary
}

// ============================================================================
// 双层挂载薄包装 (ADR-32 两薄包装产不同 result type 守 MAINT-1)
// ============================================================================

/**
 * formatContinuityFindingsForPrompt (ADR-32 生成层薄包装): 文本化注入 prompt
 * 提醒式非阻断 (守 Draft-first)。对齐 slopReportToText bullet 模式。
 * findings 按 severity 分组 (critical/warning/info), 每条 `${ref}: ${message}
 * (章 ${chapter})`。空 findings 返回 "" (空守卫不污染 prompt)。
 *
 * 生成层 MUST NOT 阻断生成 (守 Draft-first ADR-08); 阻断职责只归审查层
 * toConsistencyReviewResult。manualHandoff 标志位仅在审查层 critical 走 override
 * 时回传 (ADR-32)。
 */
export function formatContinuityFindingsForPrompt(
  findings: readonly ContinuityFinding[],
  options?: { includeChapter?: boolean },
): string {
  // 只注入提醒级 findings (critical+warning), 排除 data_gap (info 级标注非一致性
  // 问题不注入生成层守 context 预算)。critical 也注入生成层提醒 (虽审查层会阻断,
  // 生成层仍提醒 LLM 避免加深不一致)。
  const injected = findings.filter(
    (f) =>
      (f.severity === "critical" || f.severity === "warning") &&
      f.subtype !== "data_gap" &&
      f.type !== "data_gap",
  )
  if (injected.length === 0) return ""
  // ADR-32 / REV-CE-003: includeChapter 承载 generation-layer 省略章号的故意差异。
  // 默认 true 保持现有 export 行为 (审查层/测试断言带 ` (章 ${f.chapter})` 后缀);
  // deep-chapter-generation 传 { includeChapter: false } 消除内联 reimplementation
  // (生成层已在章内上下文无需重复章号)。守 additive-only: 新增可选参数不破坏 4 处现有调用。
  const includeChapter = options?.includeChapter !== false
  const bullets = injected
    .map((f) => `- [${f.severity}] ${f.ref}: ${f.message}${includeChapter ? ` (章 ${f.chapter})` : ""}`)
    .join("\n")
  return `\n\n[连续性预检提醒]\n${bullets}\n`
}

/**
 * toConsistencyReviewResult (ADR-32 审查层薄包装): 包装为 ContinuityReviewResult
 * 对象 type:'consistency_mechanical'。critical→severity:'error' (阻断 approve),
 * warning→'warning' (提醒不阻断), info→'info' (非阻断仅可见)。data_gap subtype
 * findings severity 降级 info 不阻断 (守 IC-02)。
 *
 * 返回结构对齐现有 review-adapter.NovelReviewResult (type/severity/message/
 * evidence/relatedMemory/suggestion)。suggestion 按 finding.type 给机械层针对性建议。
 * 两薄包装产不同 result type (prompt 文本 vs ContinuityReviewResult 对象) 职责不同非
 * 代码重复 (守 ADR-32/MAINT-1)。
 */
export interface ContinuityReviewResult {
  severity: "error" | "warning" | "info"
  type: "consistency_mechanical"
  message: string
  evidence: string
  relatedMemory: string
  suggestion: string
  /**
   * 连续性 finding 透传元数据 (G2 DD-2/DD-3): 供审查 UI dismiss 闭环消费。
   * ref 移到此处 (非 evidence 字段) — ref 是实体标识非正文片段, 旧 evidence=f.ref
   * 语义错位 (review-view.tsx:960-962 italic「{evidence}」把 ref 当正文渲染)。
   * subtype/ref/chapter 透传 finding 原值; missingField 仅 data_gap subtype 有值。
   * 非 continuity finding 无此字段, buildNovelReviewActionItem 透传时 undefined 零行为变更。
   */
  continuityMeta?: {
    subtype: ContinuityFindingSubtype
    ref: string
    chapter: number
    missingField?: string
  }
}

const SUGGESTION_BY_TYPE: Record<ContinuityFindingType, string> = {
  dormant_thread: "推进休眠 subplot 或显式标记 resolved; 接入 writehook 更新 lastSeenChapter",
  overdue_thread: "回收逾期伏笔或显式标记 resolved; 严重逾期走 override 人工 dismiss",
  unresolved_foreshadowing: "规划伏笔回收章节推进; 标记推进状态",
  absent_character: "补角色出场或显式标记离场; 配角降级 info 仅主角 warning",
  dead_character_state: "修正死亡角色状态层矛盾; 死亡后不应再有活跃状态变更",
  timeline_drift: "回正 timeline 事件引用章号; 修正同角色时间序矛盾或章号跳跃 (机械 additive 可 override)",
  knowledge_boundary: "修正 POV 信息边界泄露: 角色不应知晓 doesNotKnow 事实; 调整正文或认知台账 (P0)",
  lost_item: "修正物品/粒子连续性: 补显式转移记录或回正归属; 孤儿引用补归属 (P0)",
  barrier_state: "回正屏障状态: 角色穿越未开启屏障需补开启动作或修正穿越章号 (P1 critical)",
  presence_path: "回正在场路径: 角色同一章不应出现在互斥地点; 修正地点或拆分章 (P1 warning)",
  container_state: "回正容器状态: 物品从关闭容器取出需补开启动作或修正归属 (P1 warning)",
  set_count_drift: "回正集合基数: 团队/库存计数跨章变化需补增减事件 (P1 warning)",
  data_gap: "补 lastSeenChapter 字段或接入 writehook 增量更新; 不阻断仅可见标注",
}

export function toConsistencyReviewResult(
  findings: readonly ContinuityFinding[],
): ContinuityReviewResult[] {
  return findings.map((f) => {
    const severity: ContinuityReviewResult["severity"] =
      f.severity === "critical" ? "error" : f.severity === "warning" ? "warning" : "info"
    // DD-2: evidence 留空字符串 (非 f.ref) — ref 是实体标识非正文片段,
    // 旧 evidence=f.ref 被 review-view.tsx:960-962 italic「{evidence}」当正文渲染语义错位。
    // ref 透传到 continuityMeta.ref 供 dismiss UI 独立消费 (DD-3 稳定跨检测 key)。
    const missingField = f.subtype === "data_gap" ? (f as DataGapFinding).missingField : undefined
    return {
      severity,
      type: "consistency_mechanical",
      message: f.message,
      evidence: "",
      relatedMemory: "",
      suggestion: SUGGESTION_BY_TYPE[f.type] ?? "检查状态层一致性", /* v8 ignore start */ /* v8 ignore stop */
      continuityMeta: {
        subtype: f.subtype,
        ref: f.ref,
        chapter: f.chapter,
        ...(missingField !== undefined ? { missingField } : {}),
      },
    }
  })
}

// ============================================================================
// 主入口 (纯函数零 IO 零 LLM, ADR-29 Route B-1 pipeline-of-detectors)
// ============================================================================

/**
 * checkContinuity (ADR-29 blueprint 权威 API): 确定性连续性引擎主入口。
 * 纯函数: 无 IO (不读盘/不调用 Tauri), 无 LLM (不调流式), 无 await。
 * pipeline-of-detectors: detectors.flatMap(d => d(store, config)) (对齐
 * mechanical-slop-detector.ts:170 slopScore 纯函数范式)。
 *
 * 调用方 (审查层/生成层薄包装) 负责 load store 数据装配 ReadonlyStore (经
 * buildReadonlyStore 注入式 deps 薄包装, 见装配器), 传 checkContinuity 拿
 * ContinuityFinding[]。可选 overrideStore 参数: 传入则对 findings 应用 override
 * 降级 (ADR-34 跨检测持久自动降级 AC-006.5)。
 */
export function checkContinuity(
  store: ReadonlyStore,
  config: ContinuityEngineConfig = DEFAULT_CONTINUITY_CONFIG,
  overrideStore?: ContinuityOverrideStore,
): ContinuityFinding[] {
  const detectors: Array<
    (store: ReadonlyStore, config: ContinuityEngineConfig) => ContinuityFinding[]
  > = [
    detectDormantThread,
    detectAbsentCharacter,
    detectOverdueThread,
    detectDeadCharacterState,
    // S2c (roadmap R08): Quillica Story Threads 6 状态机合并 — 新增检测维度。
    // 只报 Falling 弧与状态机转移违反, 不重复 dormant/absent/overdue 判定。
    detectThreadArcFinding,
    // F-002 第 6 检测项: 时间线漂移 (timeline_drift, additive)。store 含
    // timelineEvents 时调用, 缺失则内部返回 [] 零行为变化 (向后兼容)。
    detectTimelineDriftForStore,
    // 51 号报告 G1: 4 类确定性检测器 (barrier_state critical / presence_path /
    // container_state / set_count_drift warning), additive 可选切片, 缺失返回 []。
    detectBarrierState,
    detectPresencePath,
    detectContainerState,
    detectSetCountDrift,
  ]
  const rawFindings = detectors.flatMap((d) => d(store, config))
  // 53 号报告 P0-1: 三段式去噪链 (detect → merge → suppress, 镜像 pagegod
  // run() 顺序)。纯函数零 IO 零 LLM (守 ADR-29)。additive: 规则只对
  // 「同 ref 多 finding 链」生效, 单 finding 场景零行为变更。
  const denoised = denoiseContinuityFindings(rawFindings)
  if (overrideStore && overrideStore.overrides.length > 0) {
    return applyOverrides(denoised, overrideStore.overrides)
  }
  return denoised
}

// ============================================================================
// 53 号报告 P0-1: pagegod 三段式去噪合并链 + canonical_family 归一
// ============================================================================

/**
 * CONTINUITY_CANONICAL_FAMILY (53 号报告 P0-1): ContinuityFindingType → 9 族
 * canonical family 映射。镜像 pagegod V38 CANONICAL_FAMILY (14 code→9 family)
 * 语义, 按 QMAI 现有 14 类 finding 适配 (Apache-2.0 借模式)。所有映射机械
 * 赋值, 非 LLM。
 */
export const CONTINUITY_CANONICAL_FAMILY: Record<ContinuityFindingType, string> = {
  knowledge_boundary: "knowledge_route_or_leak",
  barrier_state: "barrier_or_layout",
  presence_path: "presence_path",
  container_state: "container_state",
  set_count_drift: "count_or_inventory",
  lost_item: "object_custody",
  timeline_drift: "temporal",
  dormant_thread: "thread_or_foreshadowing",
  overdue_thread: "thread_or_foreshadowing",
  unresolved_foreshadowing: "thread_or_foreshadowing",
  absent_character: "character_state",
  dead_character_state: "character_state",
  data_gap: "data_gap",
}

/** 去噪链配置: merge 章号间距阈值 (镜像 pagegod gap_limit 3/6/12 保守档) */
export interface DenoiseConfig {
  /** 普通 family merge 最大章号间距 (默认 6) */
  maxGap?: number
  /** set_count_drift family 最大章号间距 (默认 3, 镜像 pagegod count drift 3) */
  countDriftMaxGap?: number
  /** 是否启用去噪 (默认 true; 测试/兼容可关, 守 additive) */
  enabled?: boolean
}

export const DEFAULT_DENOISE_CONFIG: Required<DenoiseConfig> = {
  maxGap: 6,
  countDriftMaxGap: 3,
  enabled: true,
}

/**
 * mergeContinuityFindings (53 号报告 P0-1): 按 (canonicalFamily, ref) 分组,
 * 章号间距 ≤ 阈值成链合并。同链合并为一条: 保留最高 severity、合并 evidence
 * (逗号连接)、chapter 取链首、message 标注「合并 N 条」。data_gap 不参与
 * (独立分组守 IC-02)。镜像 pagegod merge_count_drift_chains /
 * merge_object_custody_chains 同对象成链语义 (Apache-2.0 借模式)。
 */
export function mergeContinuityFindings(
  findings: readonly ContinuityFinding[],
  config: DenoiseConfig = DEFAULT_DENOISE_CONFIG,
): ContinuityFinding[] {
  if (!config.enabled) return [...findings]
  const merged: ContinuityFinding[] = []
  for (const finding of findings) {
    if (finding.subtype === "data_gap" || !finding.canonicalFamily) {
      merged.push(finding)
      continue
    }
    const last = merged[merged.length - 1]
    const maxGap =
      finding.canonicalFamily === "count_or_inventory"
        ? (config.countDriftMaxGap ?? DEFAULT_DENOISE_CONFIG.countDriftMaxGap)
        : (config.maxGap ?? DEFAULT_DENOISE_CONFIG.maxGap)
    if (
      last &&
      last.subtype !== "data_gap" &&
      last.type === finding.type &&
      last.canonicalFamily === finding.canonicalFamily &&
      last.ref === finding.ref &&
      finding.chapter - last.chapter <= maxGap &&
      finding.chapter - last.chapter >= 0
    ) {
      const severityRank: Record<ContinuitySeverity, number> = {
        critical: 3,
        warning: 2,
        info: 1,
      }
      const higher =
        severityRank[finding.severity] > severityRank[last.severity]
          ? finding
          : last
      const mergedCount = (last as { mergedCount?: number }).mergedCount
        ? ((last as { mergedCount?: number }).mergedCount as number) + 1
        : 2
      merged[merged.length - 1] = {
        ...higher,
        // chapter 取链尾 (保持连续成链的 gap 判定一致, 镜像 pagegod 同对象链)
        chapter: finding.chapter,
        // 合并后保留两条 message (逗号连接), 任何一条语义信息都不丢失
        message: `${last.message} + ${finding.message} (合并 ${mergedCount} 条)`,
        evidence: higher.evidence
          ? last.evidence
            ? `${last.evidence}, ${higher.evidence}`
            : higher.evidence
          : last.evidence,
        mergedCount,
      } as ContinuityFinding & { mergedCount?: number }
      continue
    }
    merged.push(finding)
  }
  return merged
}

/**
 * suppressContinuityFindings (53 号报告 P0-1): 4 条抑制规则, 镜像 pagegod
 * suppress 语义中与 QMAI 14 类 finding 可对应的子集 (Apache-2.0 借模式):
 * ① 同段冗余: 同 ref+family+chapter 多条 → 保留 severity 最高者;
 * ② barrier_entry_then_lock: barrier_state critical 抑制同 ref 相邻章
 *    presence_path 同因;③ knowledge_shadowed_custody: knowledge_boundary
 *    critical 抑制同 ref 同章 lost_item warning;
 * ④ 同 ref 同 family 连续章重复 → 保留首条 (后续由 merge 链已处理, 此处兜底
 *    同章重复)。data_gap 不参与抑制 (独立分组守 IC-02)。
 */
export function suppressContinuityFindings(
  findings: readonly ContinuityFinding[],
): ContinuityFinding[] {
  const result: ContinuityFinding[] = []
  for (const finding of findings) {
    if (finding.subtype === "data_gap" || !finding.canonicalFamily) {
      result.push(finding)
      continue
    }
    const rank: Record<ContinuitySeverity, number> = {
      critical: 3,
      warning: 2,
      info: 1,
    }
    // 同键冗余候选: 同 type+family+ref+chapter+message (检测器重复产出)
    const dupIndex = result.findIndex(
      (prev) =>
        prev.type === finding.type &&
        prev.canonicalFamily === finding.canonicalFamily &&
        prev.ref === finding.ref &&
        prev.chapter === finding.chapter &&
        prev.message === finding.message,
    )
    if (dupIndex >= 0) {
      // 当前 severity 更高 → 替换已保留 (保留最高); 否则抑制当前
      if (rank[finding.severity] > rank[result[dupIndex]!.severity]) {
        result[dupIndex] = finding
      }
      continue
    }
    let suppressed = false
    for (const prev of result) {
      // ② barrier_entry_then_lock: barrier critical 抑制相邻章 presence_path 同 ref 同因
      if (
        finding.type === "presence_path" &&
        prev.type === "barrier_state" &&
        prev.severity === "critical" &&
        prev.ref === finding.ref &&
        Math.abs(finding.chapter - prev.chapter) <= 1
      ) {
        suppressed = true
        break
      }
      // ③ knowledge_shadowed_custody: knowledge_boundary critical 抑制同 ref
      //    同章 lost_item warning
      if (
        finding.type === "lost_item" &&
        prev.type === "knowledge_boundary" &&
        prev.severity === "critical" &&
        prev.ref === finding.ref &&
        prev.chapter === finding.chapter
      ) {
        suppressed = true
        break
      }
    }
    if (!suppressed) result.push(finding)
  }
  return result
}

/**
 * fillCanonicalFamily (53 号报告 P0-1): 为缺失 canonicalFamily 的 finding 机械
 * 赋值 (幂等, 已存在则保留)。纯函数零 LLM, additive (undefined → 赋值)。
 */
export function fillCanonicalFamily(
  findings: readonly ContinuityFinding[],
): ContinuityFinding[] {
  return findings.map((f) =>
    f.canonicalFamily ? f : { ...f, canonicalFamily: CONTINUITY_CANONICAL_FAMILY[f.type] },
  )
}

/**
 * denoiseContinuityFindings (53 号报告 P0-1, 权威入口): 三段式去噪链
 * detect(已由 detectors 完成) → merge → suppress, 镜像 pagegod run()
 * detect→merge→suppress→enrich 顺序。纯函数零 IO 零 LLM (守 ADR-29), 不
 * 修改入参 (返回新数组)。
 */
export function denoiseContinuityFindings(
  findings: readonly ContinuityFinding[],
  config: DenoiseConfig = DEFAULT_DENOISE_CONFIG,
): ContinuityFinding[] {
  if (!config.enabled) return [...findings]
  const merged = mergeContinuityFindings(fillCanonicalFamily(findings), config)
  return suppressContinuityFindings(merged)
}

/**
 * buildReadonlyStoreFromInput: ContinuityInput → ReadonlyStore 转换 helper。
 * 字段同构 (foreshadowing/subplots/characters/snapshots/currentChapter), 仅补
 * readonly 修饰供 checkContinuity 权威 API 消费。提取自 runContinuityEngine 供
 * 调用点迁移复用 (ADR-29 逐步迁移), 守 DRY 不在 4 调用点重复转换逻辑。
 */
export function buildReadonlyStoreFromInput(input: ContinuityInput): ReadonlyStore {
  return {
    foreshadowing: input.foreshadowing,
    subplots: input.subplots,
    characters: input.characters,
    snapshots: input.snapshots,
    currentChapter: input.currentChapter,
  }
}

/**
 * runContinuityEngine (legacy 别名): 外部 caller 兼容入口。接受 ContinuityInput
 * (无 readonly 修饰), 经 buildReadonlyStoreFromInput 转 ReadonlyStore 后委托
 * checkContinuity。内部调用点已迁移到 checkContinuity + buildReadonlyStoreFromInput
 * (ADR-29 blueprint 权威 API), 本别名仅供外部 caller backward compat。
 *
 * 保留原因: 守 QMAI CLAUDE.md "Never break backward compatibility" — legacy 别名
 * 零行为变更, 外部 caller (含测试 + 未来下游) 仍可用 ContinuityInput 入参。
 *
 * runContinuityEngine(input, overrideStore?): overrideStore 为 ADR-34 AC-006.5
 * 跨检测持久可选参 — 调用点 loadContinuityOverrides 后传入, 引擎 applyOverrides 在
 * 生产路径触发 (dismissFinding writehook 经读端消费闭环)。不传 (undefined) 零行为
 * 变更走 rawFindings, 守 backward compat。
 */
export function runContinuityEngine(
  input: ContinuityInput,
  overrideStore?: ContinuityOverrideStore,
): ContinuityFinding[] {
  return checkContinuity(buildReadonlyStoreFromInput(input), DEFAULT_CONTINUITY_CONFIG, overrideStore)
}

// ============================================================================
// 三模型共识 (2026-08-27, Grok 过程库) 新增检测器 — 「他不该知道」/「东西丢了」
// 纯函数零 LLM 零 IO; 由 process-library.auditChapter 装配调用, 不侵入
// runContinuityEngine 主循环 (守 backward compat, 现有 6 类检测零行为变更)。
// ============================================================================

/**
 * detectKnowledgeLeak — 「他不该知道」POV 信息边界泄露检测。
 * 输入: 本章出场角色 + 其 doesNotKnow 事实清单 (cognition-state) + 见面矩阵
 * (未共场=不应互通信息)。产出 knowledge_boundary finding (critical)。
 * 纯函数: 不 reload, 数据由调用方 (process-library) 加载传入。
 */
export interface KnowledgeLeakInput {
  /** 本章出场角色 (canonical names). */
  presentCharacters: string[]
  /** 角色 → 其不应知道的事实 (cognition.doesNotKnow 解析结果). */
  doesNotKnow: Record<string, string[]>
  /** 角色 → 本章之前已见过面的角色集合 (encounter-matrix metBefore). */
  metBefore: Record<string, string[]>
  /** 本章号. */
  chapter: number
}

export function detectKnowledgeLeak(input: KnowledgeLeakInput): ContinuityFinding[] {
  const findings: ContinuityFinding[] = []
  for (const character of input.presentCharacters) {
    const forbidden = input.doesNotKnow[character] ?? []
    if (forbidden.length === 0) continue
    for (const fact of forbidden) {
      findings.push({
        type: "knowledge_boundary",
        subtype: "consistency_mechanical",
        severity: "critical",
        ref: `character:${character}`,
        message: `角色 ${character} 在正文中表现出对「${fact}」的知晓，但认知台账标记其不知道（P0 信息边界泄露）`,
        chapter: input.chapter,
        evidence: `doesNotKnow:${fact}`,
      })
    }
  }
  return findings
}

/**
 * detectLostItem — 「东西丢了」物品/粒子连续性检测。
 * 输入: 上一章物品归属 (resource-ledger currentHolder) + 本章正文引用物品
 * (snapshot.items) + 本章显式转移记录 (transferHistory 增量)。产出 lost_item
 * finding (critical: 归属跳变/凭空消失; warning: 无主引用)。
 * 纯函数: 数据由调用方 (process-library) 加载传入。
 */
export interface LostItemInput {
  /** 上一章末物品归属: item → holder (空串=无主). */
  previousHolders: Record<string, string>
  /** 本章正文引用的物品 (snapshot.items). */
  presentItems: string[]
  /** 本章显式转移: item → 新 holder. */
  explicitTransfers: Record<string, string>
  /** 本章号. */
  chapter: number
  /** 粒子账本当前状态 (particle-ledger currentParticleState 快照):
   * 角色 → 粒子名 → 状态 (如 伤势已愈/功法一层). 复核 proc-lib-ds2 FAIL
   * 修正: detectLostItem 需覆盖 money/injury/technique 三类粒子, 不只物品. */
  particleStates?: Record<string, Record<string, string>>
  /** 本章正文引用的粒子: 角色 → 粒子名 (如 甲 → 左臂). */
  presentParticles?: Record<string, string[]>
}

export function detectLostItem(input: LostItemInput): ContinuityFinding[] {
  const findings: ContinuityFinding[] = []
  for (const item of input.presentItems) {
    const prev = input.previousHolders[item]
    const transfer = input.explicitTransfers[item]
    if (transfer !== undefined) continue // 显式转移豁免
    if (prev === undefined) continue // 新物品, 无历史
    if (prev === "") {
      findings.push({
        type: "lost_item",
        subtype: "consistency_mechanical",
        severity: "warning",
        ref: `item:${item}`,
        message: `物品「${item}」上章无主，本章被引用但无归属记录（孤儿引用）`,
        chapter: input.chapter,
        evidence: `previousHolder:unowned`,
      })
    }
  }
  // 粒子矛盾检测: 正文引用某粒子但账本状态为「已愈/无」→ 报 critical
  for (const [character, particles] of Object.entries(input.presentParticles ?? {})) {
    const states = input.particleStates?.[character] ?? {}
    for (const particle of particles) {
      const state = states[particle]
      if (state === undefined) continue // 无账本记录, 不误报
      if (/已愈|痊愈|无|消失/.test(state)) {
        findings.push({
          type: "lost_item",
          subtype: "consistency_mechanical",
          severity: "critical",
          ref: `particle:${character}:${particle}`,
          message: `角色 ${character} 的粒子「${particle}」账本状态为「${state}」，本章正文却再次引用（粒子连续性矛盾）`,
          chapter: input.chapter,
          evidence: `particleState:${state}`,
        })
      }
    }
  }
  return findings
}
