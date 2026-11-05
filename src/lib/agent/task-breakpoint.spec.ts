/** 真实行为测试：src/lib/agent/task-breakpoint.ts（替代 C4 空壳） */
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildBreakpointResumePrompt,
  clearTaskBreakpoint,
  createTaskBreakpoint,
  loadTaskBreakpoint,
  saveTaskBreakpoint,
  updateBreakpointStage,
  type TaskBreakpoint,
} from "./task-breakpoint"

const writeFileAtomicMock = vi.hoisted(() => vi.fn(async (_path: string, _content: string) => {}))
const readFileMock = vi.hoisted(() => vi.fn(async (_path: string): Promise<string> => ""))
const fileExistsMock = vi.hoisted(() => vi.fn(async (_path: string): Promise<boolean> => false))

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return {
    ...actual,
    writeFileAtomic: writeFileAtomicMock,
    readFile: readFileMock,
    fileExists: fileExistsMock,
  }
})

function baseBreakpoint(overrides: Partial<TaskBreakpoint> = {}): TaskBreakpoint {
  return {
    taskId: "task_1",
    taskGoal: "写一本赛博朋克小说",
    completedStages: ["soul-doc"],
    currentStage: "characters",
    usedSkills: ["writing:soul"],
    usedTools: ["search"],
    searches: [
      {
        query: "赛博朋克",
        provider: "mock",
        status: "ok",
        resultCount: 1,
        sources: ["s1"],
        searchedAt: 1700000000500,
      },
    ],
    mcpCalls: [],
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    ...overrides,
  }
}

describe("createTaskBreakpoint", () => {
  it("默认生成 taskId 与空集合并固化时间戳", () => {
    const before = Date.now()
    const bp = createTaskBreakpoint({ taskGoal: "g", currentStage: "soul-doc" })
    const after = Date.now()
    expect(bp.taskGoal).toBe("g")
    expect(bp.taskId).toMatch(/^task_\d+_[a-z0-9]+$/)
    expect(bp.completedStages).toEqual([])
    expect(bp.usedSkills).toEqual([])
    expect(bp.usedTools).toEqual([])
    expect(bp.searches).toEqual([])
    expect(bp.mcpCalls).toEqual([])
    expect(bp.createdAt).toBeGreaterThanOrEqual(before)
    expect(bp.createdAt).toBeLessThanOrEqual(after)
    expect(bp.updatedAt).toBe(bp.createdAt)
  })

  it("显式传入的字段原样透传", () => {
    const bp = createTaskBreakpoint({
      taskId: "fixed-id",
      taskGoal: "g",
      completedStages: ["a"],
      currentStage: "b",
      usedSkills: ["s"],
      usedTools: ["t"],
    })
    expect(bp.taskId).toBe("fixed-id")
    expect(bp.completedStages).toEqual(["a"])
    expect(bp.currentStage).toBe("b")
    expect(bp.usedSkills).toEqual(["s"])
    expect(bp.usedTools).toEqual(["t"])
  })

  it("两次默认创建的 taskId 不同", () => {
    const a = createTaskBreakpoint({ taskGoal: "g", currentStage: "s" })
    const b = createTaskBreakpoint({ taskGoal: "g", currentStage: "s" })
    expect(a.taskId).not.toBe(b.taskId)
  })
})

describe("updateBreakpointStage", () => {
  it("带 completedStage 时追加已完成并切换当前阶段", () => {
    const bp = baseBreakpoint()
    const next = updateBreakpointStage(bp, "outline", "characters")
    expect(next.completedStages).toEqual(["soul-doc", "characters"])
    expect(next.currentStage).toBe("outline")
    expect(next.updatedAt).toBeGreaterThanOrEqual(bp.updatedAt)
  })

  it("不带 completedStage 时保留已完成列表", () => {
    const bp = baseBreakpoint()
    const next = updateBreakpointStage(bp, "outline")
    expect(next.completedStages).toEqual(["soul-doc"])
    expect(next.currentStage).toBe("outline")
  })

  it("不修改原对象（返回新引用）", () => {
    const bp = baseBreakpoint()
    const next = updateBreakpointStage(bp, "outline", "characters")
    expect(next).not.toBe(bp)
    expect(bp.completedStages).toEqual(["soul-doc"])
    expect(bp.currentStage).toBe("characters")
  })
})

describe("buildBreakpointResumePrompt", () => {
  it("包含目标、已完成链、当前阶段与技能", () => {
    const prompt = buildBreakpointResumePrompt(baseBreakpoint())
    expect(prompt).toContain("写一本赛博朋克小说")
    expect(prompt).toContain("soul-doc")
    expect(prompt).toContain("characters")
    expect(prompt).toContain("writing:soul")
    expect(prompt).toContain("请基于以上已完成的阶段继续执行，不要从头开始。")
  })

  it("空集合时显示“无”且省略搜索/MCP 行", () => {
    const prompt = buildBreakpointResumePrompt(
      baseBreakpoint({ completedStages: [], usedSkills: [], searches: [], mcpCalls: [] }),
    )
    expect(prompt).toContain("已完成阶段：无")
    expect(prompt).toContain("已使用的 Skill：无")
    expect(prompt).not.toContain("已执行的搜索")
    expect(prompt).not.toContain("已完成的 MCP 调用")
  })

  it("有搜索与 MCP 调用时渲染对应行", () => {
    const prompt = buildBreakpointResumePrompt(
      baseBreakpoint({
        mcpCalls: [
          {
            serverId: "fs",
            serverName: "fs",
            toolName: "read",
            status: "ok",
            calledAt: 1700000000600,
          },
        ],
      }),
    )
    expect(prompt).toContain("赛博朋克")
    expect(prompt).toContain("已完成的 MCP 调用：1 次")
  })
})

describe("save/load/clearTaskBreakpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fileExistsMock.mockResolvedValue(false)
  })

  it("save 写入 <project>/.qm/breakpoint.json 且内容可回读", async () => {
    const bp = baseBreakpoint()
    await saveTaskBreakpoint("C:\\proj\\book", bp)
    expect(writeFileAtomicMock).toHaveBeenCalledTimes(1)
    const [filePath, content] = writeFileAtomicMock.mock.calls[0] as [string, string]
    expect(filePath).toBe("C:/proj/book/.qm/breakpoint.json")
    expect(JSON.parse(content)).toEqual({ ...bp })
  })

  it("load 在文件不存在时返回 null", async () => {
    fileExistsMock.mockResolvedValue(false)
    await expect(loadTaskBreakpoint("/proj")).resolves.toBeNull()
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it("load 在文件存在时解析返回断点", async () => {
    const bp = baseBreakpoint()
    fileExistsMock.mockResolvedValue(true)
    readFileMock.mockResolvedValue(JSON.stringify(bp))
    const loaded = await loadTaskBreakpoint("/proj")
    expect(loaded).toEqual(bp)
    expect(readFileMock).toHaveBeenCalledWith("/proj/.qm/breakpoint.json")
  })

  it("load 在读取失败或 JSON 非法时返回 null", async () => {
    fileExistsMock.mockResolvedValue(true)
    readFileMock.mockRejectedValueOnce(new Error("io"))
    await expect(loadTaskBreakpoint("/proj")).resolves.toBeNull()
    readFileMock.mockResolvedValueOnce("not-json{{{")
    await expect(loadTaskBreakpoint("/proj")).resolves.toBeNull()
  })

  it("clear 写入 null 哨兵且吞掉写失败", async () => {
    await clearTaskBreakpoint("/proj")
    expect(writeFileAtomicMock).toHaveBeenCalledWith("/proj/.qm/breakpoint.json", JSON.stringify(null))
    writeFileAtomicMock.mockRejectedValueOnce(new Error("io"))
    await expect(clearTaskBreakpoint("/proj")).resolves.toBeUndefined()
  })
})
