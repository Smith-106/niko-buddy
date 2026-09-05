/**
 * 60 号设计（goal: 覆盖超越 ANWA 全功能）: DirectorOrchestrator —
 * 将 director-pipeline 纯函数阶段门接线为可推进的开书导演流程。
 *
 * 对齐 ANWA DirectorLangGraphPilot 的自动编排：每阶段从项目真实状态
 * 收集出口门输入（零 LLM 依赖的阶段检查），未过门时给出可操作缺口信息；
 * LLM 生成（开书大纲等）由现有模块（outline-wizard/outline-generation/
 * world-blueprint）承担，本编排器只做状态机推进 + 门输入收集 + 持久化。
 *
 * 持久化：{project}/.novel/director-pipeline.json（与 status.json 同目录，
 * Draft-first 纪律：导演进度是过程状态，非正式正文）。
 */

import { createDirectorPipeline, advanceDirectorPhase, retryDirectorPhase, type DirectorPipelineState, type PhaseGateInput, type DirectorPhase } from "./director-pipeline"
import { validateWorldBlueprint, type WorldBlueprint } from "./world-blueprint"
import { readFile } from "@/commands/fs"

const DIRECTOR_STATE_FILE = "director-pipeline.json"

/** 项目级导演状态路径（.novel/ 目录，同步拼接避免 tauri path 异步依赖）。 */
export function directorStatePath(projectPath: string): string {
  return `${projectPath}/.novel/${DIRECTOR_STATE_FILE}`
}

export interface DirectorSnapshot {
  idea: { title: string; genre: string; coreConflict: string }
  worldComplete: boolean
  protagonistNamed: boolean
  antagonistNamed: boolean
  frameworkChosen: boolean
  volumesPlanned: boolean
  firstChapterReady: boolean
}

/**
 * 从项目真实状态收集各阶段出口门输入（零 LLM 确定性检查）。
 * - idea：调用方提供（LLM 开书或用户填写）
 * - world：读取 world-blueprint 校验
 * - character：由调用方提供主角/对手名（canon 角色账本）
 * - outline：由调用方提供框架选型/分卷状态
 * - chapters：由调用方提供首章就绪标记
 */
export function collectPhaseGateInput(
  snapshot: DirectorSnapshot,
  worldBlueprint?: WorldBlueprint | null,
): PhaseGateInput {
  const worldComplete = worldBlueprint
    ? validateWorldBlueprint(worldBlueprint).verdict === "complete"
    : snapshot.worldComplete
  return {
    idea: snapshot.idea,
    worldComplete,
    protagonistNamed: snapshot.protagonistNamed,
    antagonistNamed: snapshot.antagonistNamed,
    frameworkChosen: snapshot.frameworkChosen,
    volumesPlanned: snapshot.volumesPlanned,
    firstChapterReady: snapshot.firstChapterReady,
  }
}

export interface DirectorAdvanceOutcome {
  state: DirectorPipelineState
  advanced: boolean
  completed: boolean
  blockedReason?: string
  /** 未过门时：当前阶段缺什么（对用户可操作）。 */
  gap?: string
}

/**
 * 推进当前阶段：收集门输入 → advanceDirectorPhase。
 * advanced=false 时 blockedReason 为缺口说明（非 LLM，纯确定性）。
 */
export function tryAdvanceDirector(
  state: DirectorPipelineState,
  snapshot: DirectorSnapshot,
  worldBlueprint?: WorldBlueprint | null,
): DirectorAdvanceOutcome {
  const input = collectPhaseGateInput(snapshot, worldBlueprint)
  const result = advanceDirectorPhase(state, input)
  if (result.advanced) {
    return { state: result.state, advanced: true, completed: result.completed }
  }
  return {
    state: result.state,
    advanced: false,
    completed: false,
    blockedReason: result.blockedReason,
    gap: phaseGapHint(state.currentPhase, snapshot),
  }
}

/** 未过门时给用户的缺口提示（对齐 ANWA director 阶段质量策略的收缩态）。 */
export function phaseGapHint(phase: DirectorPhase, snapshot: DirectorSnapshot): string {
  switch (phase) {
    case "idea":
      if (!snapshot.idea.title.trim()) return "请先填写书名"
      if (!snapshot.idea.genre.trim()) return "请先选择题材"
      if (!snapshot.idea.coreConflict.trim()) return "请先描述核心冲突"
      return "开书立意信息不完整"
    case "world":
      return "世界骨架未完备（可运行世界蓝图校验查看缺层）"
    case "character":
      if (!snapshot.protagonistNamed) return "主角尚未建立"
      return "对手（反派）尚未建立"
    case "outline":
      if (!snapshot.frameworkChosen) return "情节框架未选型"
      return "分卷尚未规划"
    case "chapters":
      return "首章尚未生成"
  }
}

/** 重试失败阶段（委托纯函数）。 */
export function retryDirector(state: DirectorPipelineState): DirectorPipelineState {
  return retryDirectorPhase(state)
}

/** 从磁盘加载导演状态；不存在时返回全新管线。 */
export async function loadDirectorState(projectPath: string): Promise<DirectorPipelineState> {
  const path = directorStatePath(projectPath)
  try {
    const raw = await readFile(path)
    return JSON.parse(raw) as DirectorPipelineState
  } catch {
    return createDirectorPipeline()
  }
}

/** 序列化导演状态到 .novel/（调用方负责写盘，此处给出 JSON）。 */
export function serializeDirectorState(state: DirectorPipelineState): string {
  return JSON.stringify(state, null, 2)
}

/** 校验反序列化状态结构完整（防旧版本损坏）。 */
export function isDirectorStateValid(state: unknown): state is DirectorPipelineState {
  if (!state || typeof state !== "object") return false
  const s = state as DirectorPipelineState
  return (
    typeof s.version === "string" &&
    typeof s.currentPhase === "string" &&
    typeof s.statuses === "object" &&
    typeof s.lastUpdated === "string"
  )
}
