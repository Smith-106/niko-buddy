/**
 * 开书导演 B 范围（宽）：推进链路 = 生成 → 出口门 → journal 幂等 → 推进。
 *
 * `director-orchestrator.tryAdvanceDirectorFromProject` 只做确定性门校验（不生成），
 * 因此门未过时用户只能看到 gap 提示。本模块把「补齐产物」接进推进：
 *
 *   currentPhase（未 done）
 *     → 生成该阶段产物（director-stage-generation，journal 幂等）
 *     → 落盘到门能读到的真实产物位置（角色实体 / 分卷大纲 / 首章草稿）
 *     → collectProjectSnapshot 采门输入 → advanceDirectorPhase 判门
 *     → 过门：推进并原子持久化；未过门：failed + retryCount + lastError（可重试恢复）
 *
 * 状态不可逆：done 阶段不回退、currentPhase 不后移、已完成管线不再推进。
 * Draft-first：本模块只写草稿（`writeDraft`）与过程状态（`.novel/`），绝不写正式正文。
 */

import {
  advanceDirectorPhase,
  createDirectorPipeline,
  DIRECTOR_PHASES,
  type DirectorPhase,
  type DirectorPipelineState,
} from "./director-pipeline"
import {
  collectProjectSnapshot,
  directorStatePath,
  type DirectorSnapshot,
} from "./director-orchestrator"
import {
  generateDirectorStage,
  type DirectorStageGenerationDeps,
  type DirectorStageInstruction,
  type DirectorStageKey,
  type DirectorStageOutputMap,
  type StageValidationFinding,
} from "./director-stage-generation"
import { validateWorldBlueprint } from "./world-blueprint"
import type { StageJournalRuntime } from "./stage-output-journal"
import { recordModuleHit } from "./module-heat"
import { createDirectory, readFile, writeFileAtomic } from "@/commands/fs"
import type { LlmConfig } from "@/stores/wiki-store"
import { toErrorMessage } from "@/lib/utils"

/** 阶段产物存档（供后续阶段当上游、供面板展示摘要）。 */
export const DIRECTOR_ARTIFACTS_FILE = "director-stage-artifacts.json"

export function directorArtifactsPath(projectPath: string): string {
  return `${projectPath}/.novel/${DIRECTOR_ARTIFACTS_FILE}`
}

export type DirectorStageArtifacts = Partial<Record<DirectorStageKey, unknown>>

export async function loadStageArtifacts(projectPath: string): Promise<DirectorStageArtifacts> {
  try {
    const raw = await readFile(directorArtifactsPath(projectPath))
    const parsed = JSON.parse(raw) as { stages?: DirectorStageArtifacts }
    return parsed.stages ?? {}
  } catch {
    return {}
  }
}

export async function saveStageArtifacts(projectPath: string, stages: DirectorStageArtifacts): Promise<void> {
  await createDirectory(`${projectPath}/.novel`)
  await writeFileAtomic(directorArtifactsPath(projectPath), JSON.stringify({ version: "1.0", stages }, null, 2))
}

// ──────────────────────────────────────────────────────────────────────────
// 产物落盘（写到出口门真正会读的位置——否则「生成成功但门永远不过」）
// ──────────────────────────────────────────────────────────────────────────

function characterEntityDoc(entry: { name: string; role: string; desire: string; flaw: string }): string {
  return [
    "---",
    `name: ${entry.name}`,
    `role: ${entry.role}`,
    "---",
    "",
    `# ${entry.name}`,
    "",
    `- 欲望：${entry.desire}`,
    `- 缺陷：${entry.flaw}`,
    "",
  ].join("\n")
}

function outlineDoc(title: string, body: readonly string[]): string {
  return [`# ${title}`, "", ...body.map((line) => `- ${line}`), ""].join("\n")
}

/** 默认落盘：角色 → wiki/entities/characters/*.md；大纲 → wiki/outlines/*.md；其余阶段只存档。 */
export async function persistStageArtifacts(
  projectPath: string,
  stage: DirectorStageKey,
  output: unknown,
): Promise<void> {
  if (stage === "character") {
    const characters = (output as DirectorStageOutputMap["character"]).characters
    const dir = `${projectPath}/wiki/entities/characters`
    await createDirectory(dir)
    for (const entry of characters) {
      const safe = entry.name.replace(/[\\/:*?"<>|]/g, "_")
      await writeFileAtomic(`${dir}/${safe}.md`, characterEntityDoc(entry))
    }
    return
  }
  if (stage === "outline") {
    const outline = output as DirectorStageOutputMap["outline"]
    const dir = `${projectPath}/wiki/outlines`
    await createDirectory(dir)
    await writeFileAtomic(
      `${dir}/00-framework.md`,
      outlineDoc("情节框架", [outline.framework, `共 ${outline.volumes.length} 卷`]),
    )
    for (let i = 0; i < outline.volumes.length; i += 1) {
      const volume = outline.volumes[i]
      await writeFileAtomic(
        `${dir}/${String(i + 1).padStart(2, "0")}-${volume.title.replace(/[\\/:*?"<>|]/g, "_")}.md`,
        outlineDoc(volume.title, [volume.arc, `计划 ${volume.chapterCount} 章`]),
      )
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// 首章正文（chapters 阶段）：生成 → 落草稿（Draft-first，不写正式章节）
// ──────────────────────────────────────────────────────────────────────────

export const DIRECTOR_PROSE_SYSTEM_PROMPT =
  "你是中文长篇小说写手。按给定的立意、角色与首章节拍写出可读的开篇正文，直接给正文，不要标题、不要解释、不要代码围栏。"

export function buildFirstChapterPrompt(
  instruction: {
    idea: { title: string; genre: string; coreConflict: string }
    plan: DirectorStageOutputMap["chapters"]["firstChapter"]
    characters?: DirectorStageOutputMap["character"]
    brief?: string
  },
): string {
  const lines = [
    `# 任务：写《${instruction.idea.title}》（${instruction.idea.genre}）的第一章正文`,
    `核心冲突：${instruction.idea.coreConflict}`,
    `## 首章计划\n标题：${instruction.plan.title}\n节拍：\n${instruction.plan.beats.map((b) => `- ${b}`).join("\n")}\n章末钩子：${instruction.plan.hook}`,
  ]
  if (instruction.characters) {
    lines.push(
      `## 角色\n${instruction.characters.characters
        .map((c) => `- ${c.name}（${c.role}）：欲望「${c.desire}」，缺陷「${c.flaw}」`)
        .join("\n")}`,
    )
  }
  if (instruction.brief?.trim()) lines.push(`## 附加要求\n${instruction.brief.trim()}`)
  lines.push("## 要求\n1500-2500 字，中文正文，直接开写，结尾落在给定钩子上。")
  return lines.join("\n\n")
}

/** 正文最低可接受长度（低于视为模型截断/跑偏，判失败不落盘）。 */
export const MIN_FIRST_CHAPTER_CHARS = 300

// ──────────────────────────────────────────────────────────────────────────
// 推进
// ──────────────────────────────────────────────────────────────────────────

export interface DirectorAutoAdvanceDeps {
  llmConfig: LlmConfig
  /** journal 运行时（缺省 = 不缓存）。 */
  journal?: StageJournalRuntime
  signal?: AbortSignal
  /** 阶段产物 LLM 注入（测试用）。 */
  complete?: DirectorStageGenerationDeps["complete"]
  /** 首章正文 LLM 注入（测试用）。 */
  completeProse?: (messages: Array<{ role: "system" | "user"; content: string }>, signal?: AbortSignal) => Promise<string>
  /** 世界观类型（world 阶段派生用，缺省 fantasy）。 */
  worldType?: string
  brief?: string
  targetVolumes?: number
  /** 门输入采集（默认 collectProjectSnapshot；测试可注入）。 */
  collectSnapshot?: (projectPath: string, idea: { title: string; genre: string; coreConflict: string }) => Promise<DirectorSnapshot>
  /** 产物落盘（默认 persistStageArtifacts；测试可注入）。 */
  persistArtifacts?: (projectPath: string, stage: DirectorStageKey, output: unknown) => Promise<void>
  /** 首章草稿写入（默认 draft-manager.writeDraft；测试可注入）。 */
  writeFirstChapterDraft?: (projectPath: string, chapterName: string, content: string) => Promise<{ id: string; chars: number }>
  /** world 阶段派生（默认 deriveAndSaveWorldBlueprint；测试可注入）。 */
  deriveWorld?: (projectPath: string, worldType: string) => Promise<void>
}

export interface DirectorDraftReceipt {
  id: string
  chapterName: string
  chars: number
}

export interface DirectorRecoveryCursor {
  phase: DirectorPhase
  retryCount: number
  lastError?: string
}

export interface DirectorAutoAdvanceOutcome {
  state: DirectorPipelineState
  advanced: boolean
  completed: boolean
  /** 本次是否真的执行了生成（已 done/已完成管线时为 false）。 */
  generated: boolean
  stage?: DirectorStageKey
  /** 生成产物是否来自 journal 缓存（未调 LLM）。 */
  cached?: boolean
  /** 未过门原因（确定性门）。 */
  blockedReason?: string
  gap?: string
  /** 生成/落盘失败信息（失败时状态已置 failed + retryCount+1）。 */
  error?: string
  findings?: StageValidationFinding[]
  drafts?: DirectorDraftReceipt[]
  /** 恢复游标（失败或未过门时给出，供 UI 重试）。 */
  recovery?: DirectorRecoveryCursor
}

/** 已完成（全阶段 done）。 */
export function isPipelineCompleted(state: DirectorPipelineState): boolean {
  return DIRECTOR_PHASES.every((phase) => state.statuses[phase] === "done")
}

/**
 * 不可逆断言：done 不回退、currentPhase 不后移、已完成管线不重开。
 * 违反即抛错（不改状态）——这类情况只可能是外部改坏了状态文件。
 */
export function assertIrreversible(previous: DirectorPipelineState, next: DirectorPipelineState): void {
  for (const phase of DIRECTOR_PHASES) {
    if (previous.statuses[phase] === "done" && next.statuses[phase] !== "done") {
      throw new Error(`导演状态不可逆：阶段 ${phase} 已 done，不允许回退为 ${next.statuses[phase]}`)
    }
  }
  const prevIndex = DIRECTOR_PHASES.indexOf(previous.currentPhase)
  const nextIndex = DIRECTOR_PHASES.indexOf(next.currentPhase)
  if (nextIndex < prevIndex) {
    throw new Error(`导演状态不可逆：currentPhase 不允许从 ${previous.currentPhase} 回退到 ${next.currentPhase}`)
  }
}

/** 恢复游标：当前阶段 + 重试次数 + 上次错误。 */
export function recoveryCursor(state: DirectorPipelineState): DirectorRecoveryCursor {
  return { phase: state.currentPhase, retryCount: state.retryCount[state.currentPhase] ?? 0, lastError: state.lastError }
}

/** 持久化导演状态（原子写）。 */
export async function persistDirectorState(projectPath: string, state: DirectorPipelineState): Promise<void> {
  await createDirectory(`${projectPath}/.novel`)
  await writeFileAtomic(directorStatePath(projectPath), JSON.stringify(state, null, 2))
}

/** 阶段生成失败：置 failed + retryCount+1 + lastError（不动 currentPhase）。 */
export function failDirectorPhase(state: DirectorPipelineState, error: string): DirectorPipelineState {
  const phase = state.currentPhase
  return {
    ...state,
    statuses: { ...state.statuses, [phase]: "failed" },
    retryCount: { ...state.retryCount, [phase]: (state.retryCount[phase] ?? 0) + 1 },
    lastError: error,
    lastUpdated: new Date().toISOString(),
  }
}

async function defaultWriteDraft(
  projectPath: string,
  chapterName: string,
  content: string,
): Promise<{ id: string; chars: number }> {
  const { writeDraft } = await import("./draft-manager")
  const draft = await writeDraft(projectPath, chapterName, content)
  return { id: draft.id, chars: draft.content.length }
}

async function defaultDeriveWorld(projectPath: string, worldType: string): Promise<void> {
  const { deriveAndSaveWorldBlueprint } = await import("./world-blueprint")
  await deriveAndSaveWorldBlueprint(projectPath, worldType)
}

/**
 * 自动推进一层：生成当前阶段产物 → 采门输入 → 判门 → 推进（或 failed 留恢复游标）。
 * 只推进一步（一次调用一个阶段），由调用方循环 —— 让面板能逐步展示每阶段状态。
 */
export async function advanceDirectorAutomatically(
  projectPath: string,
  state: DirectorPipelineState,
  idea: { title: string; genre: string; coreConflict: string },
  deps: DirectorAutoAdvanceDeps,
): Promise<DirectorAutoAdvanceOutcome> {
  const phase = state.currentPhase
  const collectSnapshot = deps.collectSnapshot ?? collectProjectSnapshot
  const persistArtifacts = deps.persistArtifacts ?? persistStageArtifacts

  if (isPipelineCompleted(state)) {
    return { state, advanced: false, completed: true, generated: false, recovery: undefined }
  }

  const artifacts = await loadStageArtifacts(projectPath).catch(() => ({}) as DirectorStageArtifacts)
  const drafts: DirectorDraftReceipt[] = []
  let effectiveIdea = { ...idea }
  let generated = false
  let stage: DirectorStageKey | undefined
  let cached: boolean | undefined

  try {
    if (phase === "world") {
      const blueprint = await collectSnapshot(projectPath, effectiveIdea)
      if (!blueprint.worldComplete) {
        generated = true
        await (deps.deriveWorld ?? defaultDeriveWorld)(projectPath, deps.worldType ?? "fantasy")
      }
    } else {
      stage = phase
      // 只喂「本阶段之前」的产物：保证同一阶段复跑时 digest 稳定（幂等键不受本轮新产物影响）。
      const upstream = upstreamArtifacts(stage, artifacts)
      const instruction: DirectorStageInstruction = {
        idea: effectiveIdea,
        ...(deps.brief ? { brief: deps.brief } : {}),
        ...(deps.targetVolumes ? { targetVolumes: deps.targetVolumes } : {}),
        ...(upstream ? { upstream } : {}),
      }
      const result = await generateDirectorStage(stage, instruction, {
        llmConfig: deps.llmConfig,
        journal: deps.journal,
        signal: deps.signal,
        complete: deps.complete,
      })
      generated = true
      cached = result.cached
      artifacts[stage] = result.output
      await saveStageArtifacts(projectPath, artifacts)
      await persistArtifacts(projectPath, stage, result.output)

      if (stage === "idea") {
        const output = result.output as DirectorStageOutputMap["idea"]
        effectiveIdea = { title: output.title, genre: output.genre, coreConflict: output.coreConflict }
      }

      if (stage === "chapters") {
        const plan = (result.output as DirectorStageOutputMap["chapters"]).firstChapter
        const prompt = buildFirstChapterPrompt({
          idea: effectiveIdea,
          plan,
          characters: artifacts.character as DirectorStageOutputMap["character"] | undefined,
          brief: deps.brief,
        })
        const prose = deps.completeProse
          ? await deps.completeProse(
              [
                { role: "system", content: DIRECTOR_PROSE_SYSTEM_PROMPT },
                { role: "user", content: prompt },
              ],
              deps.signal,
            )
          : await defaultProse(deps.llmConfig, prompt, deps.signal)
        const body = stripFence(prose)
        if (body.length < MIN_FIRST_CHAPTER_CHARS) {
          throw new Error(`首章正文过短（${body.length} 字 < ${MIN_FIRST_CHAPTER_CHARS}），判为生成失败：${body.slice(0, 40)}`)
        }
        const receipt = await (deps.writeFirstChapterDraft ?? defaultWriteDraft)(projectPath, plan.title, body)
        drafts.push({ id: receipt.id, chapterName: plan.title, chars: receipt.chars })
      }
    }

    const snapshot = await collectSnapshot(projectPath, effectiveIdea)
    const blueprint = await loadBlueprintForGate(projectPath)
    const gateInput = {
      idea: effectiveIdea,
      worldComplete: blueprint ? validateWorldBlueprint(blueprint).verdict === "complete" : snapshot.worldComplete,
      protagonistNamed: snapshot.protagonistNamed,
      antagonistNamed: snapshot.antagonistNamed,
      frameworkChosen: snapshot.frameworkChosen,
      volumesPlanned: snapshot.volumesPlanned,
      firstChapterReady: snapshot.firstChapterReady,
    }
    const result = advanceDirectorPhase(state, gateInput)
    assertIrreversible(state, result.state)
    const nextState = result.advanced ? { ...result.state, lastError: undefined } : result.state
    await persistDirectorState(projectPath, nextState)
    recordModuleHit({
      path: "src/lib/novel/director-auto-advance.ts",
      at: Date.now(),
      ok: result.advanced,
      detail: `开书导演自动推进 ${phase} → ${result.state.currentPhase}${result.blockedReason ? ` (${result.blockedReason})` : ""}`,
    })

    return {
      state: nextState,
      advanced: result.advanced,
      completed: result.completed,
      generated,
      ...(stage ? { stage } : {}),
      ...(cached !== undefined ? { cached } : {}),
      ...(result.blockedReason ? { blockedReason: result.blockedReason } : {}),
      ...(result.advanced ? {} : { recovery: recoveryCursor(nextState) }),
      ...(drafts.length > 0 ? { drafts } : {}),
    }
  } catch (err) {
    const message = toErrorMessage(err)
    const failedState = failDirectorPhase(state, message)
    await persistDirectorState(projectPath, failedState).catch(() => {})
    const findings = (err as { findings?: StageValidationFinding[] }).findings
    return {
      state: failedState,
      advanced: false,
      completed: false,
      generated,
      ...(stage ? { stage } : {}),
      ...(cached !== undefined ? { cached } : {}),
      error: message,
      ...(findings ? { findings } : {}),
      ...(drafts.length > 0 ? { drafts } : {}),
      recovery: recoveryCursor(failedState),
    }
  }
}

/** 本阶段可用的上游产物（严格前序，顺序与 DIRECTOR_PHASES 一致）。 */
export function upstreamArtifacts(
  stage: DirectorStageKey,
  artifacts: DirectorStageArtifacts,
): DirectorStageInstruction["upstream"] | undefined {
  const order: DirectorStageKey[] = ["idea", "character", "outline", "chapters"]
  const index = order.indexOf(stage)
  const out: NonNullable<DirectorStageInstruction["upstream"]> = {}
  for (const earlier of order.slice(0, Math.max(index, 0))) {
    const value = artifacts[earlier]
    if (value !== undefined) (out as Record<string, unknown>)[earlier] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

async function loadBlueprintForGate(projectPath: string) {
  try {
    const { loadWorldBlueprint } = await import("./world-blueprint")
    return await loadWorldBlueprint(projectPath)
  } catch {
    return null
  }
}

async function defaultProse(
  llmConfig: LlmConfig,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const { streamChat } = await import("@/lib/llm-client")
  let text = ""
  let failure: Error | null = null
  await streamChat(
    llmConfig,
    [
      { role: "system", content: DIRECTOR_PROSE_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    {
      onToken: (token) => {
        text += token
      },
      onDone: () => {},
      onError: (error) => {
        failure = error
      },
    },
    signal,
  )
  if (failure) throw failure
  return text
}

function stripFence(text: string): string {
  const trimmed = text.trim()
  const fence = trimmed.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
  return (fence ? fence[1] : trimmed).trim()
}

/**
 * 连续推进到无法前进（过门失败或生成失败）或管线完成。
 * `maxSteps` 防御失控循环（缺省 5 = 阶段数）。
 */
export async function advanceDirectorToStall(
  projectPath: string,
  idea: { title: string; genre: string; coreConflict: string },
  deps: DirectorAutoAdvanceDeps,
  options?: { state?: DirectorPipelineState; maxSteps?: number },
): Promise<{ state: DirectorPipelineState; steps: DirectorAutoAdvanceOutcome[] }> {
  let state = options?.state ?? createDirectorPipeline()
  const steps: DirectorAutoAdvanceOutcome[] = []
  const maxSteps = options?.maxSteps ?? DIRECTOR_PHASES.length
  for (let i = 0; i < maxSteps; i += 1) {
    if (isPipelineCompleted(state)) break
    const outcome = await advanceDirectorAutomatically(projectPath, state, idea, deps)
    steps.push(outcome)
    state = outcome.state
    if (!outcome.advanced) break
  }
  return { state, steps }
}
