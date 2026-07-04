import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Conversation, DisplayMessage } from "@/stores/chat-store"
import { __resetProjectLocksForTesting } from "@/lib/project-mutex"

const fsState = vi.hoisted(() => {
  const fileMap = new Map<string, string>()
  const createdDirs = new Set<string>()
  return {
    fileMap,
    createdDirs,
    createDirectory: vi.fn(async (path: string) => {
      createdDirs.add(path)
    }),
    readFile: vi.fn(async (path: string) => {
      const content = fileMap.get(path)
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`)
      }
      return content
    }),
    writeFileAtomic: vi.fn(async (path: string, content: string) => {
      fileMap.set(path, content)
    }),
  }
})

vi.mock("@/commands/fs", () => ({
  createDirectory: fsState.createDirectory,
  readFile: fsState.readFile,
  writeFileAtomic: fsState.writeFileAtomic,
}))

import { loadChatHistory, saveChatHistory } from "./persist"

const projectPath = "E:\\Novel"
const normalizedProjectPath = "E:/Novel"
const conversationsPath = `${normalizedProjectPath}/.qmai/conversations.json`
const conversationFilePath = `${normalizedProjectPath}/.qmai/chats/conv-1.json`

const baseConversation: Conversation = {
  id: "conv-1",
  title: "Conversation 1",
  createdAt: 1,
  updatedAt: 2,
  deAiMode: false,
}

const baseMessages: DisplayMessage[] = [
  {
    id: "msg-1",
    role: "user",
    content: "继续未完成",
    timestamp: 10,
    conversationId: "conv-1",
  },
  {
    id: "msg-2",
    role: "assistant",
    content: "已暂停，准备恢复。",
    timestamp: 11,
    conversationId: "conv-1",
  },
]

describe("persist chat history", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsState.fileMap.clear()
    fsState.createdDirs.clear()
    __resetProjectLocksForTesting()
    fsState.readFile.mockImplementation(async (path: string) => {
      const content = fsState.fileMap.get(path)
      if (content === undefined) {
        throw new Error(`ENOENT: ${path}`)
      }
      return content
    })
    fsState.writeFileAtomic.mockImplementation(async (path: string, content: string) => {
      fsState.fileMap.set(path, content)
    })
  })

  it("writes conversation snapshots atomically and can load them back", async () => {
    await saveChatHistory(projectPath, [baseConversation], baseMessages, 20)

    expect(fsState.createdDirs).toEqual(new Set([
      `${normalizedProjectPath}/.qmai`,
      `${normalizedProjectPath}/.qmai/chats`,
    ]))
    expect(JSON.parse(fsState.fileMap.get(conversationsPath) ?? "null")).toEqual([baseConversation])
    expect(JSON.parse(fsState.fileMap.get(conversationFilePath) ?? "null")).toEqual(baseMessages)

    const loaded = await loadChatHistory(projectPath)
    expect(loaded.conversations).toEqual([baseConversation])
    expect(loaded.messages).toEqual(baseMessages)
  })

  it("serializes overlapping saves so the newer snapshot wins", async () => {
    let releaseFirstWrite!: () => void
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    let firstWriteStarted!: () => void
    const firstWriteStartedPromise = new Promise<void>((resolve) => {
      firstWriteStarted = resolve
    })
    let writeCount = 0

    fsState.writeFileAtomic.mockImplementation(async (path: string, content: string) => {
      writeCount += 1
      if (writeCount === 1) {
        firstWriteStarted()
        await firstWriteBlocked
      }
      fsState.fileMap.set(path, content)
    })

    const olderMessages = [baseMessages[0]]
    const newerMessages = [...baseMessages]

    const firstSave = saveChatHistory(projectPath, [baseConversation], olderMessages, 20)
    await firstWriteStartedPromise

    const secondSave = saveChatHistory(projectPath, [baseConversation], newerMessages, 20)
    await Promise.resolve()
    await Promise.resolve()

    expect(fsState.writeFileAtomic).toHaveBeenCalledTimes(1)

    releaseFirstWrite()
    await Promise.all([firstSave, secondSave])

    const loaded = await loadChatHistory(projectPath)
    expect(loaded.messages).toEqual(newerMessages)
  })
})
