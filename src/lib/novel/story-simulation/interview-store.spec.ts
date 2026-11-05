/**
 * interview-store 真实行为测试（原位重写 C4 空壳）。
 * 覆盖：保存新建/保存保留 createdAt/读取排序与过滤/删除/目录缺失与容错。
 * 文件写入与读取一律 mock，不触碰真实文件系统。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  createDirectory,
  writeFileAtomic,
  listDirectory,
  deleteFile,
  readFile,
} from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import type { AgentChatSession } from "./types"
import {
  saveInterview,
  loadInterviews,
  deleteInterview,
  type SavedInterview,
} from "./interview-store"

vi.mock("@/commands/fs", () => ({
  createDirectory: vi.fn(async () => undefined),
  writeFileAtomic: vi.fn(async () => undefined),
  listDirectory: vi.fn(async () => []),
  deleteFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => ""),
}))

const mockedMkdir = vi.mocked(createDirectory)
const mockedWrite = vi.mocked(writeFileAtomic)
const mockedList = vi.mocked(listDirectory)
const mockedDelete = vi.mocked(deleteFile)
const mockedRead = vi.mocked(readFile)

function session(name = "阿明"): AgentChatSession {
  return {
    agentId: "c-1",
    agentName: name,
    messages: [
      {
        id: "m-1",
        role: "user",
        content: "你好",
        timestamp: "2026-03-01T10:00:00.000Z",
      },
    ],
  }
}

function node(name: string, isDir = false): FileNode {
  return {
    name,
    path: `/proj/.niko-buddy/simulations/interviews/${name}`,
    is_dir: isDir,
  }
}

function stored(id: string, updatedAt: string): SavedInterview {
  return {
    id,
    agentName: "阿明",
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt,
    session: session(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks 不恢复实现，显式复位跨用例残留
  mockedMkdir.mockResolvedValue(undefined)
  mockedWrite.mockResolvedValue(undefined)
  mockedList.mockResolvedValue([])
  mockedDelete.mockResolvedValue(undefined)
  mockedRead.mockRejectedValue(new Error("not found"))
})

describe("saveInterview", () => {
  it("新建采访返回 interview- 前缀 id 并写入 JSON", async () => {
    mockedRead.mockRejectedValueOnce(new Error("not found"))
    const id = await saveInterview("/proj", session(), {
      frameworkId: "fw-1",
      frameworkTitle: "勇者传说",
    })

    expect(id.startsWith("interview-")).toBe(true)
    expect(mockedMkdir).toHaveBeenCalledWith(
      "/proj/.niko-buddy/simulations/interviews",
    )
    expect(mockedWrite).toHaveBeenCalledTimes(1)
    const [path, raw] = mockedWrite.mock.calls[0] as unknown as [string, string]
    expect(path).toBe(`/proj/.niko-buddy/simulations/interviews/${id}.json`)
    const payload = JSON.parse(raw) as SavedInterview
    expect(payload.id).toBe(id)
    expect(payload.agentName).toBe("阿明")
    expect(payload.frameworkId).toBe("fw-1")
    expect(payload.frameworkTitle).toBe("勇者传说")
    expect(payload.session.messages).toHaveLength(1)
    expect(payload.createdAt).toBe(payload.updatedAt)
  })

  it("existingId 复写时保留原始 createdAt", async () => {
    mockedRead.mockResolvedValueOnce(
      JSON.stringify(stored("interview-9", "2026-03-02T00:00:00.000Z")),
    )
    const id = await saveInterview("/proj", session(), { existingId: "interview-9" })
    expect(id).toBe("interview-9")
    const [, raw] = mockedWrite.mock.calls[0] as unknown as [string, string]
    const payload = JSON.parse(raw) as SavedInterview
    // 原始 createdAt 被保留，updatedAt 为新时间
    expect(payload.createdAt).toBe("2026-03-01T09:00:00.000Z")
    expect(payload.updatedAt).not.toBe(payload.createdAt)
  })

  it("携带 agentSnapshot 一并持久化", async () => {
    mockedRead.mockRejectedValueOnce(new Error("not found"))
    const snapshot = { agents: [], state: {} } as unknown as SavedInterview["agentSnapshot"]
    await saveInterview("/proj", session(), {
      existingId: "interview-s",
      agentSnapshot: snapshot,
    })
    const [, raw] = mockedWrite.mock.calls[0] as unknown as [string, string]
    expect(JSON.parse(raw)).toMatchObject({ agentSnapshot: snapshot })
  })
})

describe("loadInterviews", () => {
  it("按 updatedAt 降序返回并过滤非 json/目录/坏文件/无 session 条目", async () => {
    mockedList.mockResolvedValueOnce([
      node("b.json"),
      node("a.json"),
      node("c.json"),
      node("notes.md"),
      node("subdir", true),
      node("broken.json"),
      node("nosession.json"),
      node("null.json"),
    ])
    mockedRead.mockImplementation(async (p: string) => {
      if (p.endsWith("a.json")) return JSON.stringify(stored("a", "2026-03-01T00:00:00.000Z"))
      if (p.endsWith("b.json")) return JSON.stringify(stored("b", "2026-03-03T00:00:00.000Z"))
      if (p.endsWith("c.json")) return JSON.stringify(stored("c", "2026-03-02T00:00:00.000Z"))
      if (p.endsWith("broken.json")) throw new Error("unreadable")
      if (p.endsWith("nosession.json")) return JSON.stringify({ id: "x" })
      if (p.endsWith("null.json")) return "null"
      throw new Error(`unexpected read ${p}`)
    })

    const list = await loadInterviews("/proj")
    expect(list.map((i) => i.id)).toEqual(["b", "c", "a"])
    // 目录、md、坏文件、无 session 条目均被跳过
    expect(mockedRead).not.toHaveBeenCalledWith(
      expect.stringContaining("notes.md"),
    )
  })

  it("updatedAt 相等时保持稳定顺序", async () => {
    mockedList.mockResolvedValueOnce([node("a.json"), node("b.json")])
    mockedRead.mockImplementation(async (p: string) =>
      JSON.stringify(stored(p.includes("a.json") ? "a" : "b", "2026-03-02T00:00:00.000Z")),
    )
    const list = await loadInterviews("/proj")
    expect(list.map((i) => i.id)).toEqual(["a", "b"])
  })

  it("目录不存在时返回空数组", async () => {
    mockedList.mockRejectedValueOnce(new Error("no such dir"))
    await expect(loadInterviews("/proj")).resolves.toEqual([])
  })
})

describe("deleteInterview", () => {
  it("按 id 删除对应 json 文件", async () => {
    await deleteInterview("/proj", "interview-1")
    expect(mockedDelete).toHaveBeenCalledWith(
      "/proj/.niko-buddy/simulations/interviews/interview-1.json",
    )
  })

  it("文件不存在时不抛错", async () => {
    mockedDelete.mockRejectedValueOnce(new Error("gone"))
    await expect(deleteInterview("/proj", "missing")).resolves.toBeUndefined()
  })
})
