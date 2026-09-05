/**
 * 60 号设计（director-connect）持久化补件（C-glm 共识 D3/D4）：
 * - hasPersistedDirectorState：显式「开书启动」门（缺文件 → 全新管线不再静默冒泡）
 * - ideaInput：书名/题材/核心冲突落盘 director-pipeline.json（不碰 project.json 契约）
 * 走 createAtomicJsonStore（.novel/ 原子写，与 status.json 同目录）。
 */

import { createAtomicJsonStore } from "./projection-store"
import { directorStatePath, isDirectorStateValid } from "./director-orchestrator"
import { createDirectorPipeline, type DirectorPipelineState } from "./director-pipeline"
import { fileExists } from "@/commands/fs"

export interface DirectorIdeaInput {
  title: string
  genre: string
  coreConflict: string
}

export interface DirectorPersistedFile {
  fileVersion: 1
  state: DirectorPipelineState
  ideaInput: DirectorIdeaInput
}

export const EMPTY_IDEA_INPUT: DirectorIdeaInput = { title: "", genre: "", coreConflict: "" }

function emptyFile(): DirectorPersistedFile {
  return { fileVersion: 1, state: createDirectorPipeline(), ideaInput: EMPTY_IDEA_INPUT }
}

const directorStore = createAtomicJsonStore<DirectorPersistedFile>("director-pipeline.json", emptyFile, {
  currentVersion: 1,
  // Windows Rust read_file 缺文件文案："The system cannot find the file specified. (os error 2)"
  //（对齐 character-state.ts:93 既有先例，含中文 locale 文案）
  isMissingError: (err) =>
    err instanceof Error &&
    /ENOENT|not found|no such file|does not exist|os error 2|系统找不到/i.test(err.message),
})

/** 磁盘上是否已有持久化管线（显式启动门：false → UI 显示「开书启动」）。 */
export async function hasPersistedDirectorState(projectPath: string): Promise<boolean> {
  return fileExists(directorStatePath(projectPath))
}

/** 加载持久化文件（缺文件/结构损坏 → 新管线 + 空立意输入）。 */
export async function loadDirectorPersisted(projectPath: string): Promise<DirectorPersistedFile> {
  const file = await directorStore.load(projectPath)
  // P3（R-glm review）：合法 JSON 但缺 state 字段的文件会让面板抛 TypeError —
  // 结构校验不过关则降级 emptyFile。
  if (!file || !isDirectorStateValid(file.state) || typeof file.ideaInput !== "object") {
    return emptyFile()
  }
  return file
}

/** 原子落盘（.novel/director-pipeline.json）。 */
export async function saveDirectorPersisted(
  projectPath: string,
  file: DirectorPersistedFile,
): Promise<void> {
  await directorStore.save(projectPath, file)
}

/** 保存立意输入（只改 ideaInput，管线状态不动）。 */
export async function saveDirectorIdeaInput(
  projectPath: string,
  ideaInput: DirectorIdeaInput,
): Promise<void> {
  const file = await directorStore.load(projectPath)
  await directorStore.save(projectPath, { ...file, ideaInput })
}
