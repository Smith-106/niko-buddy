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

import { loadChatHistory, saveChatHistory, loadReviewItems, saveReviewItems } from "./persist"

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

describe("persist — full-coverage extensions", () => {
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

  const reviewPath = `${normalizedProjectPath}/.qmai/review.json`

  it("saves review items and creates storage directories", async () => {
    const item = { id: "r1", title: "Review", description: "d", options: [], resolved: false, createdAt: 1, type: "suggestion" } as ReviewItem

    await saveReviewItems(projectPath, [item])

    expect(fsState.createdDirs).toEqual(new Set([
      `${normalizedProjectPath}/.qmai`,
      `${normalizedProjectPath}/.qmai/chats`,
    ]))
    expect(JSON.parse(fsState.fileMap.get(reviewPath) ?? "null")).toEqual([item])
  })

  it("loads review items from disk", async () => {
    const item = { id: "r1", title: "Review", description: "d", options: [], resolved: false, createdAt: 1, type: "suggestion" } as ReviewItem
    fsState.fileMap.set(reviewPath, JSON.stringify([item]))

    expect(await loadReviewItems(projectPath)).toEqual([item])
  })

  it("returns [] when the review file is missing", async () => {
    expect(await loadReviewItems(projectPath)).toEqual([])
  })

  it("warns and returns [] when the review JSON is not an array", async () => {
    fsState.fileMap.set(reviewPath, JSON.stringify({ nope: 1 }))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(await loadReviewItems(projectPath)).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("不是数组"))
    warnSpy.mockRestore()
  })

  it("logs and returns [] when the review JSON is invalid", async () => {
    fsState.fileMap.set(reviewPath, "{not json")
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    expect(await loadReviewItems(projectPath)).toEqual([])
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it("throws when the write-then-read verification cannot read back", async () => {
    fsState.readFile.mockImplementationOnce(async () => {
      throw new Error("disk error")
    })

    await expect(saveChatHistory(projectPath, [baseConversation], baseMessages, 20))
      .rejects.toThrow("聊天会话索引 写入后回读失败")
  })

  it("renders non-Error read-back failures with String()", async () => {
    fsState.readFile.mockImplementationOnce(async () => {
      throw "raw disk failure"
    })

    await expect(saveChatHistory(projectPath, [baseConversation], baseMessages, 20))
      .rejects.toThrow("聊天会话索引 写入后回读失败（E:/Novel/.qmai/conversations.json）：raw disk failure")
  })

  it("swallows directory creation failures", async () => {
    fsState.createDirectory
      .mockRejectedValueOnce(new Error("denied"))
      .mockRejectedValueOnce(new Error("denied"))

    await saveReviewItems(projectPath, [{
      id: "r1", title: "Review", description: "d", options: [], resolved: false, createdAt: 1, type: "suggestion",
    } as ReviewItem])

    expect(fsState.writeFileAtomic).toHaveBeenCalled()
  })

  it("throws when the write-then-read verification returns invalid JSON", async () => {
    fsState.readFile.mockImplementationOnce(async () => "{not json")

    await expect(saveChatHistory(projectPath, [baseConversation], baseMessages, 20))
      .rejects.toThrow("聊天会话索引 写入后不是有效 JSON")
  })

  it("throws when the write-then-read verification fails validation", async () => {
    fsState.readFile.mockImplementationOnce(async () => JSON.stringify([{ id: "tampered", title: 123 }]))

    await expect(saveChatHistory(projectPath, [baseConversation], baseMessages, 20))
      .rejects.toThrow("聊天会话索引 写入后校验失败")
  })

  it("defaults to 100 messages when maxMessages is not provided", async () => {
    const many: DisplayMessage[] = Array.from({ length: 150 }, (_, i) => ({
      id: `m${i}`,
      role: "user",
      content: `c${i}`,
      timestamp: i,
      conversationId: "conv-1",
    }))

    await saveChatHistory(projectPath, [baseConversation], many)

    const written = JSON.parse(fsState.fileMap.get(conversationFilePath) ?? "null") as DisplayMessage[]
    expect(written).toHaveLength(100)
    expect(written[0]?.id).toBe("m50")
  })

  it("loads legacy flat-array chat history into the default conversation", async () => {
    fsState.fileMap.set(
      `${normalizedProjectPath}/.qmai/chat-history.json`,
      JSON.stringify(baseMessages),
    )

    const loaded = await loadChatHistory(projectPath)

    expect(loaded.conversations).toEqual([{
      id: "default",
      title: "Previous Conversations",
      createdAt: 10,
      updatedAt: 11,
      deAiMode: false,
    }])
    expect(loaded.messages).toEqual(baseMessages.map((m) => ({ ...m, conversationId: "default" })))
  })

  it("uses Date.now() for missing timestamps in legacy chat history", async () => {
    fsState.fileMap.set(
      `${normalizedProjectPath}/.qmai/chat-history.json`,
      JSON.stringify([{ id: "a", role: "user", content: "x", conversationId: "ignored" }]),
    )

    const loaded = await loadChatHistory(projectPath)

    expect(loaded.conversations[0]?.createdAt).toBeGreaterThan(0)
    expect(loaded.conversations[0]?.updatedAt).toBeGreaterThan(0)
    expect(loaded.messages[0]?.conversationId).toBe("default")
  })

  it("returns legacy object-format chat history as-is", async () => {
    const data = { conversations: [baseConversation], messages: baseMessages }
    fsState.fileMap.set(`${normalizedProjectPath}/.qmai/chat-history.json`, JSON.stringify(data))

    const loaded = await loadChatHistory(projectPath)

    expect(loaded).toEqual(data)
  })

  it("warns and returns empty when the legacy chat history payload is invalid", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    fsState.fileMap.set(`${normalizedProjectPath}/.qmai/chat-history.json`, "null")
    expect(await loadChatHistory(projectPath)).toEqual({ conversations: [], messages: [] })

    fsState.fileMap.set(`${normalizedProjectPath}/.qmai/chat-history.json`, "42")
    expect(await loadChatHistory(projectPath)).toEqual({ conversations: [], messages: [] })

    expect(warnSpy).toHaveBeenCalledTimes(2)
    warnSpy.mockRestore()
  })

  it("returns empty when no chat history exists at all", async () => {
    expect(await loadChatHistory(projectPath)).toEqual({ conversations: [], messages: [] })
  })
})
