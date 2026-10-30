// @vitest-environment jsdom
/**
 * useChatPlanning — 计划模式面板开合 / 加载成功与失败 / 目标章 ref 的 hook 契约。
 * planning 与 path-utils 全 mock，避免触碰 FS。
 */
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WikiProject } from "@/types/wiki"
import { useChatPlanning } from "./use-chat-planning"

const mocks = vi.hoisted(() => ({
  buildChapterPlan: vi.fn(),
}))

vi.mock("@/lib/novel/planning", () => ({
  buildChapterPlan: mocks.buildChapterPlan,
}))

vi.mock("@/lib/path-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/path-utils")>()
  return {
    ...actual,
    normalizePath: (p: string) => p.replace(/\\/g, "/"),
  }
})

const PROJECT: WikiProject = {
  name: "demo",
  path: "D:\\novel",
} as unknown as WikiProject

function setup(project: WikiProject | null = PROJECT) {
  return renderHook(() => useChatPlanning({ project }))
}

describe("useChatPlanning", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildChapterPlan.mockReset()
  })

  it("初始状态：面板关闭、计划为空、未加载、无错误", () => {
    const { result } = setup()
    expect(result.current.planningOpen).toBe(false)
    expect(result.current.planningPlan).toBeNull()
    expect(result.current.planningLoading).toBe(false)
    expect(result.current.planningError).toBeNull()
    expect(result.current.planningChapterRef.current).toBeUndefined()
  })

  it("openPlanning 打开面板并按目标章加载（缺省 0）", async () => {
    mocks.buildChapterPlan.mockResolvedValue({ chapterNumber: 7, scenes: [] })
    const { result } = setup()
    await act(async () => {
      result.current.planningChapterRef.current = 7
    })
    await act(async () => {
      result.current.openPlanning()
    })
    expect(result.current.planningOpen).toBe(true)
    expect(mocks.buildChapterPlan).toHaveBeenCalledWith("D:/novel", 7)
    expect(result.current.planningPlan).toEqual({ chapterNumber: 7, scenes: [] })
    expect(result.current.planningLoading).toBe(false)
    expect(result.current.planningError).toBeNull()
  })

  it("loadPlanning 未设置目标章时传 0", async () => {
    mocks.buildChapterPlan.mockResolvedValue({ chapterNumber: 0, scenes: [] })
    const { result } = setup()
    await act(async () => {
      await result.current.loadPlanning()
    })
    expect(mocks.buildChapterPlan).toHaveBeenCalledWith("D:/novel", 0)
  })

  it("loadPlanning 成功：loading 结束后写入 plan 并清空错误", async () => {
    let release: (() => void) | undefined
    mocks.buildChapterPlan.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ chapterNumber: 3, scenes: [] })
      }),
    )
    const { result } = setup()
    let pending: Promise<void> | undefined
    await act(async () => {
      pending = result.current.loadPlanning(3)
    })
    expect(result.current.planningLoading).toBe(true)
    expect(result.current.planningError).toBeNull()
    await act(async () => {
      release?.()
      await pending
    })
    expect(result.current.planningPlan).toEqual({ chapterNumber: 3, scenes: [] })
    expect(result.current.planningLoading).toBe(false)
  })

  it("loadPlanning 失败：写入错误信息并结束 loading", async () => {
    mocks.buildChapterPlan.mockRejectedValue(new Error("plan boom"))
    const { result } = setup()
    await act(async () => {
      await result.current.loadPlanning(9)
    })
    expect(result.current.planningError).toContain("plan boom")
    expect(result.current.planningPlan).toBeNull()
    expect(result.current.planningLoading).toBe(false)
  })

  it("project 为 null 时不加载", async () => {
    const { result } = setup(null)
    await act(async () => {
      await result.current.loadPlanning(1)
    })
    expect(mocks.buildChapterPlan).not.toHaveBeenCalled()
    expect(result.current.planningLoading).toBe(false)
  })

  it("setPlanningPlan(null) 清空 one-shot 快照", async () => {
    mocks.buildChapterPlan.mockResolvedValue({ chapterNumber: 1, scenes: [] })
    const { result } = setup()
    await act(async () => {
      await result.current.loadPlanning(1)
    })
    expect(result.current.planningPlan).not.toBeNull()
    await act(async () => {
      result.current.setPlanningPlan(null)
    })
    expect(result.current.planningPlan).toBeNull()
  })

  it("setPlanningOpen 可独立开合面板", async () => {
    const { result } = setup()
    await act(async () => {
      result.current.setPlanningOpen(true)
    })
    expect(result.current.planningOpen).toBe(true)
    await act(async () => {
      result.current.setPlanningOpen(false)
    })
    expect(result.current.planningOpen).toBe(false)
  })

  it("planningChapterRef 在同一实例内跨渲染持久", async () => {
    const { result, rerender } = setup()
    await act(async () => {
      result.current.planningChapterRef.current = 42
    })
    rerender()
    expect(result.current.planningChapterRef.current).toBe(42)
  })
})
