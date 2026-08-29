/**
 * 采访对话持久化
 *
 * 将 Agent 采访对话保存到项目的 .qmai/simulations/interviews/ 目录下，
 * 方便后续回顾和查看。
 */

import { createDirectory, writeFileAtomic, listDirectory, deleteFile, readFile } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"
import type { AgentChatSession } from "./types"
import type { SerializedSimulationSnapshot } from "./simulation-serializer"

const INTERVIEWS_DIR = ".qmai/simulations/interviews"

function interviewsDir(projectPath: string): string {
  return `${normalizePath(projectPath)}/${INTERVIEWS_DIR}`
}

function interviewFilePath(projectPath: string, interviewId: string): string {
  return `${interviewsDir(projectPath)}/${interviewId}.json`
}

export interface SavedInterview {
  id: string
  agentName: string
  frameworkId?: string
  frameworkTitle?: string
  createdAt: string
  updatedAt: string
  session: AgentChatSession
  /** 推演时的 agent 快照，用于继续对话时恢复角色状态 */
  agentSnapshot?: SerializedSimulationSnapshot
}

/**
 * 保存采访对话到项目。
 * @returns interviewId
 */
export async function saveInterview(
  projectPath: string,
  session: AgentChatSession,
  options?: {
    frameworkId?: string
    frameworkTitle?: string
    existingId?: string
    agentSnapshot?: SerializedSimulationSnapshot
  },
): Promise<string> {
  const dir = interviewsDir(projectPath)
  await createDirectory(dir)

  const now = new Date().toISOString()
  const id = options?.existingId ?? `interview-${Date.now()}`
  const payload: SavedInterview = {
    id,
    agentName: session.agentName,
    frameworkId: options?.frameworkId,
    frameworkTitle: options?.frameworkTitle,
    createdAt: now,
    updatedAt: now,
    session,
    agentSnapshot: options?.agentSnapshot,
  }

  // 如果已存在，保留原始 createdAt
  try {
    const existing = await readFile(interviewFilePath(projectPath, id))
    const parsed = JSON.parse(existing) as SavedInterview
    payload.createdAt = parsed.createdAt
  } catch {
    // 新文件，使用当前时间
  }

  await writeFileAtomic(interviewFilePath(projectPath, id), JSON.stringify(payload, null, 2))
  return id
}

/**
 * 加载所有采访对话，按 updatedAt 降序排列。
 */
export async function loadInterviews(projectPath: string): Promise<SavedInterview[]> {
  const dir = interviewsDir(projectPath)
  let entries: FileNode[]
  try {
    entries = await listDirectory(dir)
  } catch {
    return []
  }

  const interviews: SavedInterview[] = []
  for (const entry of entries) {
    if (entry.is_dir) continue
    if (!entry.name.toLowerCase().endsWith(".json")) continue
    try {
      const content = await readFile(entry.path)
      const parsed = JSON.parse(content) as SavedInterview
      if (parsed && parsed.session) {
        interviews.push(parsed)
      }
    } catch {
      // 跳过无法读取的文件
    }
  }

  interviews.sort((a, b) => {
    if (a.updatedAt < b.updatedAt) return 1
    if (a.updatedAt > b.updatedAt) return -1
    return 0
  })
  return interviews
}

/**
 * 删除指定采访对话。
 */
export async function deleteInterview(
  projectPath: string,
  interviewId: string,
): Promise<void> {
  try {
    await deleteFile(interviewFilePath(projectPath, interviewId))
  } catch {
    // 文件可能不存在
  }
}
