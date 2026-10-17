/**
 * 开书导演阶段产物摘要（面板展示用，纯函数零 IO）。
 *
 * 面板要显示「每阶段生成了什么」，但组件不该知道各阶段产物结构细节；
 * 这里把产物折成带 i18n key + 计数参数的摘要行，组件只负责渲染。
 */

import type { DirectorStageArtifacts } from "./director-auto-advance"
import type { DirectorStageKey, DirectorStageOutputMap } from "./director-stage-generation"

export interface StageArtifactSummary {
  stage: DirectorStageKey
  /** i18n key（directorPanel.*）。 */
  key: string
  /** 插值参数。 */
  params: Record<string, string | number>
}

function asIdea(value: unknown): DirectorStageOutputMap["idea"] | null {
  const rec = value as Partial<DirectorStageOutputMap["idea"]> | null
  if (!rec || typeof rec.title !== "string" || typeof rec.genre !== "string") return null
  if (!Array.isArray(rec.hooks)) return null
  return rec as DirectorStageOutputMap["idea"]
}

function asCharacter(value: unknown): DirectorStageOutputMap["character"] | null {
  const rec = value as Partial<DirectorStageOutputMap["character"]> | null
  if (!rec || !Array.isArray(rec.characters)) return null
  return rec as DirectorStageOutputMap["character"]
}

function asOutline(value: unknown): DirectorStageOutputMap["outline"] | null {
  const rec = value as Partial<DirectorStageOutputMap["outline"]> | null
  if (!rec || typeof rec.framework !== "string" || !Array.isArray(rec.volumes)) return null
  return rec as DirectorStageOutputMap["outline"]
}

function asChapters(value: unknown): DirectorStageOutputMap["chapters"] | null {
  const rec = value as Partial<DirectorStageOutputMap["chapters"]> | null
  if (!rec || !rec.firstChapter || !Array.isArray(rec.firstChapter.beats)) return null
  return rec as DirectorStageOutputMap["chapters"]
}

/**
 * 渲染顺序固定为 DIRECTOR 阶段序；结构不认（旧存档/被外部改坏）的阶段跳过，
 * 不抛错——面板信息缺失比整页崩掉好。
 */
export function summarizeStageArtifacts(artifacts: DirectorStageArtifacts | null | undefined): StageArtifactSummary[] {
  if (!artifacts) return []
  const out: StageArtifactSummary[] = []

  const idea = asIdea(artifacts.idea)
  if (idea) {
    out.push({
      stage: "idea",
      key: "directorPanel.artifactIdea",
      params: { title: idea.title, genre: idea.genre, hooks: idea.hooks.length },
    })
  }

  const character = asCharacter(artifacts.character)
  if (character) {
    const protagonist = character.characters.find((c) => c.role === "protagonist")
    out.push({
      stage: "character",
      key: "directorPanel.artifactCharacter",
      params: { count: character.characters.length, protagonist: protagonist?.name ?? "-" },
    })
  }

  const outline = asOutline(artifacts.outline)
  if (outline) {
    out.push({
      stage: "outline",
      key: "directorPanel.artifactOutline",
      params: {
        framework: outline.framework,
        volumes: outline.volumes.length,
        chapters: outline.volumes.reduce((sum, v) => sum + (Number(v.chapterCount) || 0), 0),
      },
    })
  }

  const chapters = asChapters(artifacts.chapters)
  if (chapters) {
    out.push({
      stage: "chapters",
      key: "directorPanel.artifactChapters",
      params: { title: chapters.firstChapter.title, beats: chapters.firstChapter.beats.length },
    })
  }

  return out
}
