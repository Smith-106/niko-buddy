import { loadCharacterStates } from "./character-state"
import { loadCognitionState } from "./character-cognition"
import { loadForeshadowingTracker } from "./foreshadowing-tracker"
import { loadSubplotBoard } from "./subplot-board"
import { loadEmotionalArcs } from "./emotional-arcs"
import { loadResourceLedger } from "./resource-ledger"
import { loadEncounterMatrix, metBefore } from "./encounter-matrix"
import { loadChapterSummaries, recentChapterSummaries } from "./chapter-summaries"
import { loadParticleLedger, currentParticleState } from "./particle-ledger"
import {
  detectKnowledgeLeak,
  detectLostItem,
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
 * 起草阶段可见信息装配：仅注入 POV 角色可见信息（Grok 调用规则 2）。
 * 过滤依据：cognition.doesNotKnow（角色不知道的事实不注入）+ encounter-matrix
 * metBefore（未共场角色不互通信息）+ particle 仅 POV 持有项。只读。
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

  const lines: string[] = []
  const me = cognition?.characters?.find((k) => k.character === povCharacter)
  if (me && (me.doesNotKnow ?? []).length > 0) {
    lines.push(`【${povCharacter} 不知道】${(me.doesNotKnow ?? []).join("、")}`)
  }
  const met = metBefore(matrix, povCharacter, chapter)
  if (met.length > 0) {
    lines.push(`【${povCharacter} 已见过】${met.join("、")}`)
  }
  const myItems = resources.entries.filter((e) => e.currentHolder === povCharacter)
  if (myItems.length > 0) {
    lines.push(`【${povCharacter} 持有】${myItems.map((e) => e.item).join("、")}`)
  }
  for (const kind of ["money", "injury", "technique"] as const) {
    const p = currentParticleState(particles, povCharacter, kind)
    if (p) lines.push(`【${povCharacter} ${kind}】${p.name} → ${p.state}`)
  }
  return lines.join("\n")
}

export interface AuditReport {
  findings: ContinuityFinding[]
  summary: string
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
): Promise<AuditReport> {
  const [cognition, matrix, resources, particles] = await Promise.all([
    loadCognitionState(projectPath),
    loadEncounterMatrix(projectPath),
    loadResourceLedger(projectPath),
    loadParticleLedger(projectPath),
  ])

  const doesNotKnow: Record<string, string[]> = {}
  for (const k of cognition?.characters ?? []) {
    if ((k.doesNotKnow ?? []).length > 0) doesNotKnow[k.character] = k.doesNotKnow ?? []
  }
  const metMap: Record<string, string[]> = {}
  for (const c of presentCharacters) metMap[c] = metBefore(matrix, c, chapter)

  const knowledgeInput: KnowledgeLeakInput = {
    presentCharacters,
    doesNotKnow,
    metBefore: metMap,
    chapter,
  }
  const previousHolders: Record<string, string> = {}
  for (const e of resources.entries) previousHolders[e.item] = e.currentHolder
  const particleStates: Record<string, Record<string, string>> = {}
  for (const kind of ["money", "injury", "technique"] as const) {
    for (const e of particles.entries) {
      if (e.kind !== kind) continue
      particleStates[e.character] ??= {}
      particleStates[e.character][e.name] = e.state
    }
  }
  const lostInput: LostItemInput = {
    previousHolders,
    presentItems,
    explicitTransfers: {},
    chapter,
    particleStates,
    presentParticles,
  }

  const findings = [...detectKnowledgeLeak(knowledgeInput), ...detectLostItem(lostInput)]
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
