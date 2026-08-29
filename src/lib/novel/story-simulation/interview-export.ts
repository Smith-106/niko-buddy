/**
 * 角色采访对话导出
 * 将 AgentChatMessage[] 导出为 Markdown 文件，保存到项目目录。
 */

import { createDirectory, writeFileAtomic } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import type { AgentChatMessage } from "./types"
import type { SavedInterview } from "./interview-store"

const SIM_ROOT = ".qmai/simulations"
const INTERVIEWS_DIR = `${SIM_ROOT}/interviews`

function interviewsDir(projectPath: string): string {
  return `${normalizePath(projectPath)}/${INTERVIEWS_DIR}`
}

function interviewFilePath(projectPath: string, agentName: string, timestamp: string): string {
  const safeName = agentName.replace(/[\\/:*?"<>|]/g, "_")
  const safeTs = timestamp.replace(/[:.]/g, "-")
  return `${interviewsDir(projectPath)}/${safeName}_${safeTs}.md`
}

/**
 * 将对话记录导出为 Markdown 文件。
 * @returns 导出的文件路径
 */
export async function exportInterview(
  projectPath: string,
  agentNameOrInterview: string | SavedInterview,
  messages?: AgentChatMessage[],
): Promise<string> {
  let agentName: string
  let msgs: AgentChatMessage[]
  let frameworkTitle: string | undefined
  let createdAt: string | undefined

  if (typeof agentNameOrInterview === "string") {
    agentName = agentNameOrInterview
    msgs = messages || []
  } else {
    agentName = agentNameOrInterview.agentName
    msgs = agentNameOrInterview.session.messages
    frameworkTitle = agentNameOrInterview.frameworkTitle
    createdAt = agentNameOrInterview.createdAt
  }

  const dir = interviewsDir(projectPath)
  await createDirectory(dir)

  const now = new Date()
  const timestamp = now.toISOString()
  const filePath = interviewFilePath(projectPath, agentName, timestamp)

  const lines: string[] = []
  lines.push(`# 与「${agentName}」的对话`)
  lines.push("")
  if (frameworkTitle) {
    lines.push(`> 故事框架：${frameworkTitle}`)
  }
  if (createdAt) {
    lines.push(`> 创建时间：${new Date(createdAt).toLocaleString("zh-CN")}`)
  }
  lines.push(`> 导出时间：${now.toLocaleString("zh-CN")}`)
  lines.push(`> 消息数量：${msgs.length}`)
  lines.push("")
  lines.push("---")
  lines.push("")

  for (const msg of msgs) {
    const time = new Date(msg.timestamp).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    })
    if (msg.role === "user") {
      lines.push(`**[${time}] 采访者：**`)
    } else {
      lines.push(`**[${time}] ${msg.agentName || agentName}：**`)
    }
    lines.push("")
    lines.push(msg.content.trim())
    lines.push("")
    lines.push("---")
    lines.push("")
  }

  const content = lines.join("\n")
  await writeFileAtomic(filePath, content)
  return filePath
}
