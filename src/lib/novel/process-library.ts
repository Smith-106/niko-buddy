import { loadCharacterStates } from "./character-state"
import { loadCognitionState, resolveCanonicalName, type CognitionState } from "./character-cognition"
import { loadForeshadowingTracker, type ForeshadowingStore } from "./foreshadowing-tracker"
import { loadSubplotBoard } from "./subplot-board"
import { loadEmotionalArcs } from "./emotional-arcs"
import { loadResourceLedger, type ResourceLedgerStore } from "./resource-ledger"
import { loadEncounterMatrix, metBefore, type EncounterMatrixStore } from "./encounter-matrix"
import { loadChapterSummaries, recentChapterSummaries } from "./chapter-summaries"
import { loadParticleLedger, currentParticleState, type ParticleKind, type ParticleLedgerStore } from "./particle-ledger"
import {
  detectKnowledgeLeak,
  detectLostItem,
  detectForeshadowingConfiscation,
  normalizeEvidenceText,
  type ContinuityFinding,
  type KnowledgeLeakInput,
  type LostItemInput,
} from "./deterministic-continuity-engine"

/**
 * ProcessLibrary 门面 — Grok 过程库（7 类真相文件）在 QMAI 的只读装配入口。
 * 三模型共识（2026-08-27，deepseek-v4-pro + GLM-5.2 + hy3，参考 Grok
 * "Different Knowledge Bases for Writing AI"）：
 *   - 过程库 = 当前作品的活状态（动态、精确召回、可校验、按章节回溯），
 *     与 .workflow/（knowhow/specs/wiki/kg 通用知识）按「实然 vs 应然」分工。
 *   - 调用规则：规划读 current_state + pending_hooks + 近 3 章摘要；起草只
 *     注入可见信息；写完审计更新（模型不得直接覆写真相文件）。
 *   - 冲突时过程库优先（Consistency P0 门由确定性引擎兜底）。
 *
 * 本门面不写盘、不复制数据、不持有状态 — 纯组合现有 .novel/*.json 投影
 * loader（零新真源，守 ADR-26 + A23 + ANL-013 C4）。审计函数只产 findings，
 * 不产写入；真相文件更新只经 chapter-ingest 投影循环的确定性 fold 函数。
 */

export interface PlanningContext {
  currentState: string
  pendingHooks: string
  recentSummaries: string
  subplotBoard: string
  emotionalArcs: string
}

/**
 * 规划阶段装配：current_state + pending_hooks + 近 3 章摘要 + subplot_board +
 * emotional_arcs（Grok 调用规则 1）。只读。
 */
export async function loadForPlanning(
  projectPath: string,
  currentChapter: number,
): Promise<PlanningContext> {
  const [characters, cognition, foreshadowing, subplots, emotions, summaries] =
    await Promise.all([
      loadCharacterStates(projectPath),
      loadCognitionState(projectPath),
      loadForeshadowingTracker(projectPath),
      loadSubplotBoard(projectPath),
      loadEmotionalArcs(projectPath),
      loadChapterSummaries(projectPath),
    ])

  const currentStateLines: string[] = []
  for (const c of characters.characters ?? []) {
    const rel = c.relationships && Object.keys(c.relationships).length
      ? `；关系：${Object.entries(c.relationships).map(([k, v]) => `${k}(${v})`).join("、")}`
      : ""
    currentStateLines.push(
      `第${c.lastUpdatedChapter ?? "?"}章 ${c.characterName}：位于${c.currentLocation ?? "?"}，状态${c.status ?? "?"}${rel}`,
    )
  }
  const knows = cognition?.characters ?? []
  const cognitionLines = knows
    .filter((k) => (k.doesNotKnow ?? []).length > 0)
    .map((k) => `${k.character} 不知道：${(k.doesNotKnow ?? []).join("、")}`)

  const pending = foreshadowing.items.filter((f) => f.status === "planted" || f.status === "advanced")
  const pendingLines = pending.map(
    (f) => `F:${f.id ?? "?"}（第${f.plantedChapter}章埋）${f.description ?? ""}`,
  )

  return {
    currentState: [
      `【当前状态】截至第${currentChapter}章`,
      ...currentStateLines,
      ...cognitionLines,
    ].join("\n"),
    pendingHooks: pendingLines.length
      ? `【未收伏笔 ${pendingLines.length} 条】\n${pendingLines.join("\n")}`
      : "【未收伏笔】无",
    recentSummaries: chapterSummariesToText(summaries),
    subplotBoard: subplotBoardToText(subplots),
    emotionalArcs: emotionalArcsToText(emotions),
  }
}

/**
 * E-03 (C-7, 三模型共识 2026-09-04): 单一可见性契约的输入源。
 * 纯数据 (loader 产物), 无 IO。
 */
export interface VisibilitySources {
  cognition: CognitionState | null
  matrix: EncounterMatrixStore
  resources: ResourceLedgerStore
  particles: ParticleLedgerStore
}

/**
 * E-03 (C-7): 单一可见性契约 — 给定 POV + 章号, 返回该角色「可见」与
 * 「不可见」的事实集。纯函数, 无 IO, 无写句柄 (零新真源)。
 *
 * 注入侧 (visibleInfoFor) 全量复用; 审计侧 (auditChapter) 仅 knowledge-leak
 * 装配复用 (对每个在场角色求值), lost-item 保持全量 holders 视图输入
 * (强行统一是伪契约 — GLM 限定范围裁决)。
 *
 * join key 一致性 (验收⑦): 查询前先 resolveCanonicalName(pov) 归一
 * (NFKC + 中黑点折叠), 与 fold 入键归一 (aliasMaps → canonical) 两端一致;
 * 别名形态查询不再静默漏配。
 */
export function computeVisibility(
  pov: string,
  chapter: number,
  sources: VisibilitySources,
): {
  /** 该 POV 不知道的事实 (must not inject, 注入即为 knowledge_boundary)。 */
  doesNotKnow: string[]
  /** 截至 chapter 已见过的角色 (信息互通边界)。 */
  metBefore: string[]
  /** 该 POV 持有的物品 (resource-ledger join)。 */
  heldItems: string[]
  /** 该 POV 的粒子状态 (money/injury/technique)。 */
  particles: Array<{ kind: ParticleKind; name: string; state: string }>
} {
  const canonicalPov = resolveCanonicalName(pov)
  const me = sources.cognition?.characters?.find((k) => k.character === canonicalPov)
  const doesNotKnow = me && (me.doesNotKnow ?? []).length > 0 ? [...(me.doesNotKnow ?? [])] : []
  const met = metBefore(sources.matrix, canonicalPov, chapter)
  const heldItems = sources.resources.entries
    .filter((e) => e.currentHolder === canonicalPov)
    .map((e) => e.item)
  const particles: Array<{ kind: ParticleKind; name: string; state: string }> = []
  for (const kind of ["money", "injury", "technique"] as const) {
    const p = currentParticleState(sources.particles, canonicalPov, kind)
    if (p) particles.push({ kind, name: p.name, state: p.state })
  }
  return { doesNotKnow, metBefore: met, heldItems, particles }
}

/**
 * 起草阶段可见信息装配：仅注入 POV 角色可见信息（Grok 调用规则 2）。
 * 过滤依据：cognition.doesNotKnow（角色不知道的事实不注入）+ encounter-matrix
 * metBefore（未共场角色不互通信息）+ particle 仅 POV 持有项。只读。
 * E-03 (C-7): 改为复用 computeVisibility 契约函数 (注入/审计契约漂移成为
 * 编译期不可能), 查询 join key 经 resolveCanonicalName 归一。
 */
export async function visibleInfoFor(
  projectPath: string,
  povCharacter: string,
  chapter: number,
): Promise<string> {
  const [cognition, matrix, particles, resources] = await Promise.all([
    loadCognitionState(projectPath),
    loadEncounterMatrix(projectPath),
    loadParticleLedger(projectPath),
    loadResourceLedger(projectPath),
  ])

  const vis = computeVisibility(povCharacter, chapter, { cognition, matrix, resources, particles })
  const lines: string[] = []
  if (vis.doesNotKnow.length > 0) {
    lines.push(`【${povCharacter} 不知道】${vis.doesNotKnow.join("、")}`)
  }
  if (vis.metBefore.length > 0) {
    lines.push(`【${povCharacter} 已见过】${vis.metBefore.join("、")}`)
  }
  if (vis.heldItems.length > 0) {
    lines.push(`【${povCharacter} 持有】${vis.heldItems.join("、")}`)
  }
  for (const p of vis.particles) {
    lines.push(`【${povCharacter} ${p.kind}】${p.name} → ${p.state}`)
  }
  return lines.join("\n")
}

export interface AuditReport {
  findings: ContinuityFinding[]
  summary: string
}

/**
 * E-04 (ds D-5 共识): 从本章正文确定性提取审计在场实体 — 角色名 (cognition
 * canonical, 经 resolveCanonicalName 归一) / 物品名 (resource-ledger) / 粒子名
 * (particle-ledger) 子串匹配。纯函数, 零 LLM。提取失败/空输入 → 空数组,
 * 审计自然降级 (无在场角色 → 无 knowledge_boundary/lost_item findings, 不误报)。
 */
export function extractAuditInputsFromText(
  text: string,
  sources: {
    cognition?: CognitionState | null
    resources?: ResourceLedgerStore | null
    particles?: ParticleLedgerStore | null
  },
): {
  presentCharacters: string[]
  presentItems: string[]
  presentParticles: Record<string, string[]>
} {
  const norm = normalizeEvidenceText(text)
  const presentCharacters: string[] = []
  const seenChars = new Set<string>()
  for (const c of sources.cognition?.characters ?? []) {
    const canonical = resolveCanonicalName(c.character)
    if (canonical && !seenChars.has(canonical) && norm.includes(normalizeEvidenceText(canonical))) {
      seenChars.add(canonical)
      presentCharacters.push(canonical)
    }
  }
  const presentItems: string[] = []
  const seenItems = new Set<string>()
  for (const e of sources.resources?.entries ?? []) {
    if (e.item && !seenItems.has(e.item) && norm.includes(normalizeEvidenceText(e.item))) {
      seenItems.add(e.item)
      presentItems.push(e.item)
    }
  }
  const presentParticles: Record<string, string[]> = {}
  for (const e of sources.particles?.entries ?? []) {
    if (e.name && norm.includes(normalizeEvidenceText(e.name))) {
      presentParticles[e.character] ??= []
      if (!presentParticles[e.character].includes(e.name)) presentParticles[e.character].push(e.name)
    }
  }
  return { presentCharacters, presentItems, presentParticles }
}

/**
 * E-04 (三模型共识 C-9): auditChapter additive 可选入参。
 * - chapterText/chapterFacts: 证据分级通道 (验收⑤) — 符号命中 → critical,
 *   未命中/无输入 → info (不妄断)。
 * - sources: 已加载 store 注入 (守 S-20260718-ito3 不重复 reload; 缺省自 load)。
 */
export interface AuditChapterOptions {
  /** 本章正文 (证据分级辅助通道). */
  chapterText?: string
  /** 本章在场事实 (snapshot 提取, 证据分级主通道). */
  chapterFacts?: string[]
  /** 已加载 store 注入 (缺省自 load). */
  sources?: {
    cognition?: CognitionState
    matrix?: EncounterMatrixStore
    resources?: ResourceLedgerStore
    particles?: ParticleLedgerStore
    foreshadowing?: ForeshadowingStore
    characterStates?: Awaited<ReturnType<typeof loadCharacterStates>>
  }
}

/**
 * 审计阶段装配：写完一章后的三类检查（Grok 调用规则 3 + 口诀）。
 *   - 「他不该知道」→ detectKnowledgeLeak（P0 信息边界）
 *   - 「东西丢了」→ detectLostItem（物品连续性）
 *   - 「伏笔没收」→ 由调用方复用 analyzeForeshadowingDebt（foreshadowing-debt.ts）
 *     与引擎 unresolved_foreshadowing 检测（本门面不重复实现）
 * 只产 findings，不产写入；模型不得直接覆写真相文件。
 */
export async function auditChapter(
  projectPath: string,
  chapter: number,
  presentCharacters: string[],
  presentItems: string[],
  presentParticles?: Record<string, string[]>,
  options?: AuditChapterOptions,
): Promise<AuditReport> {
  const [cognition, matrix, resources, particles, foreshadowing, characterStates] = options?.sources
    ? [
        options.sources.cognition ?? (await loadCognitionState(projectPath)),
        options.sources.matrix ?? (await loadEncounterMatrix(projectPath)),
        options.sources.resources ?? (await loadResourceLedger(projectPath)),
        options.sources.particles ?? (await loadParticleLedger(projectPath)),
        options.sources.foreshadowing ?? (await loadForeshadowingTracker(projectPath)),
        options.sources.characterStates ?? (await loadCharacterStates(projectPath)),
      ]
    : await Promise.all([
        loadCognitionState(projectPath),
        loadEncounterMatrix(projectPath),
        loadResourceLedger(projectPath),
        loadParticleLedger(projectPath),
        loadForeshadowingTracker(projectPath),
        loadCharacterStates(projectPath),
      ])

  const doesNotKnow: Record<string, string[]> = {}
  const metMap: Record<string, string[]> = {}
  // E-03 (C-7): knowledge-leak 装配复用 computeVisibility 契约函数 — 对每个
  // 在场角色求值 (join key 经 resolveCanonicalName 归一), 替换手写 map 构造。
  for (const c of presentCharacters) {
    const vis = computeVisibility(c, chapter, { cognition, matrix, resources, particles })
    if (vis.doesNotKnow.length > 0) doesNotKnow[c] = vis.doesNotKnow
    if (vis.metBefore.length > 0) metMap[c] = vis.metBefore
  }

  const knowledgeInput: KnowledgeLeakInput = {
    presentCharacters,
    doesNotKnow,
    metBefore: metMap,
    chapter,
    // E-04 (验收⑤): 证据分级通道 — 符号命中 → critical; 未命中/无输入 → info。
    chapterFacts: options?.chapterFacts,
    chapterBody: options?.chapterText,
  }
  const previousHolders: Record<string, string> = {}
  for (const e of resources.entries) previousHolders[e.item] = e.currentHolder
  const particleStates: Record<string, Record<string, string>> = {}
  const particleEvidence: Record<string, Record<string, "ledger" | "text">> = {}
  for (const kind of ["money", "injury", "technique"] as const) {
    for (const e of particles.entries) {
      if (e.kind !== kind) continue
      particleStates[e.character] ??= {}
      particleStates[e.character][e.name] = e.state
      // E-04 (验收⑤): 粒子状态串来源分级 — 文本启发式映射 (E-03 C-12) 证据链最弱
      // → 降级 warning; 结构化账本条目 → critical。
      particleEvidence[e.character] ??= {}
      particleEvidence[e.character][e.name] = e.note === "text-heuristic" ? "text" : "ledger"
    }
  }
  const lostInput: LostItemInput = {
    previousHolders,
    presentItems,
    explicitTransfers: {},
    chapter,
    particleStates,
    presentParticles,
    particleEvidence,
  }

  // E-04 (C-1): 口诀③「伏笔没收」装配 — 复用引擎检测器, 终态信号含关联角色死亡。
  const deadCharacters = characterStates.characters
    .filter((c) => c.isAlive === false)
    .map((c) => c.characterName)
  const foreshadowingFindings = detectForeshadowingConfiscation({
    items: foreshadowing.items,
    currentChapter: chapter,
    deadCharacters,
  })

  const findings = [
    ...detectKnowledgeLeak(knowledgeInput),
    ...detectLostItem(lostInput),
    ...foreshadowingFindings,
  ]
  const critical = findings.filter((f) => f.severity === "critical").length
  const summary = `第${chapter}章审计：${findings.length} 项 finding（critical ${critical}）`
  return { findings, summary }
}

// ---- 内部文本渲染（与各投影 *ToContextText 同款，门面内私有） ----

function chapterSummariesToText(store: Awaited<ReturnType<typeof loadChapterSummaries>>): string {
  const recent = recentChapterSummaries(store, 3)
  if (recent.length === 0) return "【近 3 章摘要】无"
  return `【近 3 章摘要】\n${recent
    .map((e) => `第${e.chapter}章：${e.happened}`)
    .join("\n")}`
}

function subplotBoardToText(store: Awaited<ReturnType<typeof loadSubplotBoard>>): string {
  const active = store.items.filter((s) => s.status === "active" || s.status === "proposed")
  if (active.length === 0) return "【支线板】无活跃支线"
  return `【支线板】\n${active
    .map((s) => `${s.title}（${s.status}，第${s.startChapter}章起）`)
    .join("\n")}`
}

function emotionalArcsToText(store: Awaited<ReturnType<typeof loadEmotionalArcs>>): string {
  if (store.beats.length === 0) return "【情绪弧】无"
  const last = store.beats.slice(-5)
  return `【情绪弧（近 5 拍）】\n${last
    .map((b) => `第${b.chapterNumber}章 ${b.character} ${b.emotion}(${b.intensity})：${b.trigger}`)
    .join("\n")}`
}
