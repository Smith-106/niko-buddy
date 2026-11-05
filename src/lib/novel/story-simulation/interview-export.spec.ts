/**
 * exportInterview 真实行为测试（原位重写 C4 空壳）。
 * 覆盖：字符串形式/对象形式/标题与元信息/消息渲染/文件名清洗/空消息。
 * 文件写入一律 mock，不触碰真实文件系统。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createDirectory, writeFileAtomic } from "@/commands/fs"
import type { AgentChatMessage } from "./types"
import type { SavedInterview } from "./interview-store"
import { exportInterview } from "./interview-export"

vi.mock("@/commands/fs", () => ({
  createDirectory: vi.fn(async () => undefined),
  writeFileAtomic: vi.fn(async () => undefined),
}))

const mockedMkdir = vi.mocked(createDirectory)
const mockedWrite = vi.mocked(writeFileAtomic)

function msg(overrides: Partial<AgentChatMessage> = {}): AgentChatMessage {
  return {
    id: "m-1",
    role: "agent",
    agentId: "c-1",
    agentName: "阿明",
    content: "  我在，请讲。  ",
    timestamp: "2026-03-01T10:05:00.000Z",
    ...overrides,
  }
}

function saved(overrides: Partial<SavedInterview> = {}): SavedInterview {
  return {
    id: "interview-1",
    agentName: "阿明",
    frameworkId: "fw-1",
    frameworkTitle: "勇者传说",
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-01T10:00:00.000Z",
    session: {
      agentId: "c-1",
      agentName: "阿明",
      messages: [msg()],
    },
    ...overrides,
  }
}

function written(): { path: string; content: string } {
  expect(mockedWrite).toHaveBeenCalledTimes(1)
  return {
    path: String(mockedWrite.mock.calls[0]?.[0] ?? ""),
    content: String(mockedWrite.mock.calls[0]?.[1] ?? ""),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("exportInterview 字符串形式", () => {
  it("渲染标题、导出元信息与消息", async () => {
    const filePath = await exportInterview("/proj", "阿明", [
      msg(),
      msg({
        id: "m-2",
        role: "user",
        agentName: undefined,
        content: "你从哪里来？",
        timestamp: "2026-03-01T10:06:00.000Z",
      }),
    ])

    expect(mockedMkdir).toHaveBeenCalledWith(
      "/proj/.niko-buddy/simulations/interviews",
    )
    expect(filePath).toContain("/proj/.niko-buddy/simulations/interviews/")
    expect(filePath).toContain("阿明_")
    expect(filePath.endsWith(".md")).toBe(true)
    // 时间戳中的 : . 已被替换
    expect(filePath).not.toMatch(/:\d\d\./)
    expect(written().path).toBe(filePath)

    const content = written().content
    expect(content).toContain("# 与「阿明」的对话")
    expect(content).toContain("导出时间：")
    expect(content).toContain("消息数量：2")
    // agent 消息使用消息自带 agentName，内容被 trim，且标签与内容正确关联
    expect(content).toContain("阿明：**")
    const lines = content.split("\n")
    const agentLabelIdx = lines.findIndex((l) => l.includes("阿明：**"))
    expect(lines[agentLabelIdx + 2]).toBe("我在，请讲。")
    expect(content).not.toContain("  我在，请讲。  ")
    // user 消息标记为采访者，且标签与内容正确关联
    const userLabelIdx = lines.findIndex((l) => l.includes("采访者：**"))
    expect(lines[userLabelIdx + 2]).toBe("你从哪里来？")
  })

  it("agent 消息缺名时回退到传入的 agentName", async () => {
    await exportInterview("/proj", "阿红", [
      msg({ agentName: undefined, agentId: undefined }),
    ])
    expect(written().content).toContain("阿红：**")
  })

  it("默认消息为空数组时仍导出头部", async () => {
    const filePath = await exportInterview("/proj", "阿明")
    expect(filePath.endsWith(".md")).toBe(true)
    const content = written().content
    expect(content).toContain("消息数量：0")
    expect(content).toContain("# 与「阿明」的对话")
  })

  it("清洗文件名中的非法字符", async () => {
    const filePath = await exportInterview("/proj", '阿:明/小*名?"<>|')
    const fileName = filePath.split("/").pop() ?? ""
    expect(fileName).not.toMatch(/[\\/:*?"<>|]/)
    expect(fileName).toContain("阿_明_小_名_____")
  })
})

describe("exportInterview 对象形式", () => {
  it("携带框架标题与创建时间", async () => {
    const filePath = await exportInterview("/proj", saved())
    expect(filePath).toContain("阿明_")
    const content = written().content
    expect(content).toContain("> 故事框架：勇者传说")
    expect(content).toContain("> 创建时间：")
    expect(content).toContain("消息数量：1")
  })

  it("无框架标题与创建时间时省略对应行", async () => {
    await exportInterview(
      "/proj",
      saved({ frameworkTitle: undefined, createdAt: "2026-03-01T09:00:00.000Z" }),
    )
    // createdAt 仍存在时会输出；去掉两者则都不输出
    await exportInterview(
      "/proj",
      saved({ frameworkTitle: undefined, createdAt: undefined as unknown as string }),
    )
    const contents = mockedWrite.mock.calls.map(([_, c]) => String(c))
    expect(contents[1]).not.toContain("故事框架：")
    expect(contents[1]).not.toContain("创建时间：")
    expect(contents[1]).toContain("导出时间：")
  })
})
