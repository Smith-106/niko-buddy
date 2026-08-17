// @vitest-environment jsdom
/**
 * W4 / maintenance-section.tsx 全口径覆盖 spec。
 * - vi.hoisted 提供可写 wiki store state + 全部 lib mock。
 * - dedup-queue 的 groupKey 用真实实现（与源码匹配逻辑一致）。
 * - getQueue 返回可外部变更的 queue 数组；轮询 tick 用真实定时器等待。
 */
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup } from "@testing-library/react"
import {
  render,
  screen,
  fireEvent,
  waitFor,
  setupDomGlobals,
} from "@/test-helpers/component-test-utils"
import { MaintenanceSection } from "./maintenance-section"

/* eslint-disable @typescript-eslint/no-explicit-any */

interface TaskLike {
  id: string
  projectId: string
  group: { slugs: string[]; reason: string; confidence: string }
  canonicalSlug: string
  status: "pending" | "processing" | "done" | "failed"
  addedAt: number
  error: string | null
  retryCount: number
}

const mocks = vi.hoisted(() => {
  const state: Record<string, any> = {
    llmConfig: { provider: "openai", apiKey: "k", model: "m" },
    project: null,
  }
  const queue: TaskLike[] = []
  return {
    state,
    queue,
    groupKey: (slugs: readonly string[]) =>
      [...slugs].map((s) => String(s).toLowerCase()).sort().join(","),
    hasUsableLlm: vi.fn(() => true),
    runDuplicateDetection: vi.fn(),
    addNotDuplicate: vi.fn(),
    enqueueMerge: vi.fn(async () => "task-1"),
    cancelTask: vi.fn(async () => {}),
    retryTask: vi.fn(async () => {}),
    getQueue: vi.fn(() => queue),
    t: vi.fn((key: string) => key),
  }
})

vi.mock("@/stores/wiki-store", () => ({
  useWikiStore: (selector: (s: Record<string, any>) => unknown) => selector(mocks.state),
}))

vi.mock("@/lib/has-usable-llm", () => ({ hasUsableLlm: mocks.hasUsableLlm }))

vi.mock("@/lib/dedup-runner", () => ({ runDuplicateDetection: mocks.runDuplicateDetection }))

vi.mock("@/lib/dedup-storage", () => ({ addNotDuplicate: mocks.addNotDuplicate }))

vi.mock("@/lib/dedup-queue", () => ({
  enqueueMerge: mocks.enqueueMerge,
  cancelTask: mocks.cancelTask,
  retryTask: mocks.retryTask,
  getQueue: mocks.getQueue,
  groupKey: mocks.groupKey,
}))

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }))

// ── Fixtures ────────────────────────────────────────────────────────

const PROJECT = { id: "p1", name: "T", path: "/p/test" }

function makeGroup(overrides: Record<string, any> = {}): any {
  return {
    slugs: ["张三", "张先生"],
    reason: "可能是同一个人物的不同称呼",
    confidence: "high",
    ...overrides,
  }
}

function makeTask(overrides: Record<string, any> = {}): TaskLike {
  return {
    id: "t1",
    projectId: "p1",
    group: makeGroup(),
    canonicalSlug: "张三",
    status: "pending",
    addedAt: 0,
    error: null,
    retryCount: 0,
    ...overrides,
  }
}

function setState(patch: Record<string, any>): void {
  Object.assign(mocks.state, patch)
}

function resetBaseline(): void {
  mocks.queue.length = 0
  mocks.state.project = null
  mocks.state.llmConfig = { provider: "openai", apiKey: "k", model: "m" }
  mocks.hasUsableLlm.mockReturnValue(true)
  mocks.runDuplicateDetection.mockReset()
  mocks.addNotDuplicate.mockReset()
  mocks.enqueueMerge.mockReset()
  mocks.enqueueMerge.mockImplementation(async () => "task-1")
  mocks.cancelTask.mockReset()
  mocks.retryTask.mockReset()
}

/** 等待 1s 轮询 tick（recentlyMerged 检测需要 tick 触发）。 */
async function tickPoll(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1100))
  })
}

afterEach(() => {
  cleanup()
})

describe("MaintenanceSection — 初始状态 / 提示 / 帮助面板", () => {
  beforeEach(() => {
    resetBaseline()
    setupDomGlobals()
  })

  it("无项目：显示 noProject 提示，扫描按钮禁用", () => {
    setState({ project: null })
    render(<MaintenanceSection />)
    expect(screen.getByText("settings.sections.maintenance.noProject")).toBeTruthy()
    const scanButton = screen.getByText("settings.sections.maintenance.dedup.scanButton").closest("button")!
    expect(scanButton).toBeDisabled()
  })

  it("有项目但无可用 LLM：显示 noLlm 提示，扫描按钮禁用", () => {
    mocks.hasUsableLlm.mockReturnValue(false)
    setState({ project: PROJECT })
    render(<MaintenanceSection />)
    expect(screen.getByText("settings.sections.maintenance.noLlm")).toBeTruthy()
    const scanButton = screen.getByText("settings.sections.maintenance.dedup.scanButton").closest("button")!
    expect(scanButton).toBeDisabled()
  })

  it("小说帮助面板展开与折叠", () => {
    setState({ project: PROJECT })
    render(<MaintenanceSection />)
    const toggle = screen.getByText("settings.sections.maintenance.dedup.novelHelpTitle").closest("button")!
    fireEvent.click(toggle)
    expect(screen.getByText("settings.sections.maintenance.dedup.novelHelpIntro")).toBeTruthy()
    expect(screen.getByText("settings.sections.maintenance.dedup.novelHelpExample1Title")).toBeTruthy()
    expect(screen.getByText("settings.sections.maintenance.dedup.novelHelpExample2Title")).toBeTruthy()
    expect(screen.getByText("settings.sections.maintenance.dedup.novelHelpHowTitle")).toBeTruthy()
    expect(screen.getByText("settings.sections.maintenance.dedup.novelHelpTip")).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.queryByText("settings.sections.maintenance.dedup.novelHelpIntro")).toBeNull()
  })
})

describe("MaintenanceSection — 扫描流程", () => {
  beforeEach(() => {
    resetBaseline()
    setupDomGlobals()
  })

  it("扫描中按钮切换为 scanning 并禁用", async () => {
    let resolveScan!: (value: unknown) => void
    mocks.runDuplicateDetection.mockReturnValue(
      new Promise((resolve) => {
        resolveScan = resolve
      }),
    )
    setState({ project: PROJECT })
    const { unmount } = render(<MaintenanceSection />)
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.scanButton"))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.maintenance.dedup.scanning")).toBeTruthy()
    })
    expect(
      screen.getByText("settings.sections.maintenance.dedup.scanning").closest("button"),
    ).toBeDisabled()
    expect(mocks.runDuplicateDetection).toHaveBeenCalledWith("/p/test", mocks.state.llmConfig)
    await act(async () => {
      resolveScan([])
    })
    unmount()
  })

  it("扫描成功渲染分组卡片：置信度徽标、理由、候选数、canonical 单选默认值", async () => {
    mocks.runDuplicateDetection.mockResolvedValue([
      makeGroup({ slugs: ["张三", "张先生"], confidence: "high", reason: "同音字" }),
      makeGroup({ slugs: ["九阳神功", "九阳真经"], confidence: "medium", reason: "同义" }),
      makeGroup({ slugs: ["青云宗", "青云派", "青云门"], confidence: "low", reason: "" }),
    ])
    setState({ project: PROJECT })
    render(<MaintenanceSection />)
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.scanButton"))
    await waitFor(() => {
      expect(screen.getByText("high")).toBeTruthy()
    })
    expect(screen.getByText("medium")).toBeTruthy()
    expect(screen.getByText("low")).toBeTruthy()
    expect(screen.getAllByText("同音字").length).toBeGreaterThan(0)
    expect(screen.getAllByText("同义").length).toBeGreaterThan(0)
    expect(screen.getAllByText("settings.sections.maintenance.dedup.candidates").length).toBeGreaterThan(0)
    // canonical 单选：默认第一个 slug 选中；radio 组按 slugs.join(",") 命名
    const firstRadio = screen.getByLabelText("张三") as HTMLInputElement
    expect(firstRadio.checked).toBe(true)
    // 切换 canonical → 合并按钮文案使用新 slug
    fireEvent.click(screen.getByLabelText("张先生"))
    expect((screen.getByLabelText("张先生") as HTMLInputElement).checked).toBe(true)
  })

  it("扫描完成且无分组 → noneFound 提示", async () => {
    mocks.runDuplicateDetection.mockResolvedValue([])
    setState({ project: PROJECT })
    render(<MaintenanceSection />)
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.scanButton"))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.maintenance.dedup.noneFound")).toBeTruthy()
    })
  })

  it("扫描失败：Error 实例与普通字符串都展示错误", async () => {
    mocks.runDuplicateDetection.mockRejectedValueOnce(new Error("boom"))
    setState({ project: PROJECT })
    const { unmount } = render(<MaintenanceSection />)
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.scanButton"))
    await waitFor(() => {
      expect(screen.getByText("boom")).toBeTruthy()
    })
    unmount()

    mocks.runDuplicateDetection.mockRejectedValueOnce("plain-failure")
    const view = render(<MaintenanceSection />)
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.scanButton"))
    await waitFor(() => {
      expect(screen.getByText("plain-failure")).toBeTruthy()
    })
    view.unmount()
  })

  it("sharedScanState 与当前项目不匹配时回退空状态（跨实例隔离）", async () => {
    mocks.runDuplicateDetection.mockResolvedValue([makeGroup()])
    setState({ project: PROJECT })
    const first = render(<MaintenanceSection />)
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.scanButton"))
    await waitFor(() => {
      expect(screen.getByText("high")).toBeTruthy()
    })
    first.unmount()
    // 同一模块 sharedScanState 残留 projectPath=/p/test，但新实例项目不同 → 空状态
    setState({ project: { id: "p2", name: "Other", path: "/p/other" } })
    render(<MaintenanceSection />)
    expect(screen.queryByText("high")).toBeNull()
    expect(screen.getByText("settings.sections.maintenance.dedup.scanButton")).toBeTruthy()
  })
})

describe("MaintenanceSection — 合并队列与卡片交互", () => {
  beforeEach(() => {
    resetBaseline()
    setupDomGlobals()
  })

  it("合并：enqueueMerge 携带 canonicalSlug，卡片转 queued（0 位）", async () => {
    mocks.runDuplicateDetection.mockResolvedValue([makeGroup()])
    setState({ project: PROJECT })
    const { unmount } = render(<MaintenanceSection />)
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.scanButton"))
    await waitFor(() => {
      expect(screen.getByText("high")).toBeTruthy()
    })
    fireEvent.click(screen.getByLabelText("张先生"))
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.mergeButton"))
    await waitFor(() => {
      expect(mocks.enqueueMerge).toHaveBeenCalledWith("p1", expect.objectContaining({ slugs: ["张三", "张先生"] }), "张先生")
    })
    // enqueue 成功后立即刷新队列 → 卡片显示 queued
    mocks.queue.push(makeTask({ id: "t1", status: "pending", canonicalSlug: "张先生" }))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.maintenance.dedup.queued")).toBeTruthy()
    })
    // pending 且 0 位 → 取消按钮（inFlight）
    expect(screen.getByText("settings.sections.maintenance.dedup.cancel")).toBeTruthy()
    unmount()
  })

  it("pending 任务带前方数量：第二个 pending 显示 queuedAhead", async () => {
    mocks.runDuplicateDetection.mockResolvedValue([
      makeGroup({ slugs: ["A1", "A2"] }),
      makeGroup({ slugs: ["B1", "B2"] }),
    ])
    mocks.queue.push(
      makeTask({ id: "ta", group: makeGroup({ slugs: ["A1", "A2"] }), status: "pending" }),
      makeTask({ id: "tb", group: makeGroup({ slugs: ["B1", "B2"] }), status: "pending" }),
    )
    setState({ project: PROJECT })
    const { unmount } = render(<MaintenanceSection />)
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.scanButton"))
    await waitFor(() => {
      expect(screen.getAllByText("settings.sections.maintenance.dedup.queued").length).toBeGreaterThan(0)
    })
    expect(screen.getByText("settings.sections.maintenance.dedup.queuedAhead")).toBeTruthy()
    unmount()
  })

  it("processing 任务显示 merging；取消调用 cancelTask 并刷新队列", async () => {
    mocks.runDuplicateDetection.mockResolvedValue([makeGroup()])
    mocks.queue.push(makeTask({ id: "t1", status: "processing" }))
    setState({ project: PROJECT })
    const { unmount } = render(<MaintenanceSection />)
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.scanButton"))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.maintenance.dedup.merging")).toBeTruthy()
    })
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.cancel"))
    await waitFor(() => {
      expect(mocks.cancelTask).toHaveBeenCalledWith("t1")
    })
    unmount()
  })

  it("failed 任务显示错误与重试/删除；重试调用 retryTask", async () => {
    mocks.runDuplicateDetection.mockResolvedValue([makeGroup()])
    mocks.queue.push(
      makeTask({ id: "t1", status: "failed", error: "merge exploded", retryCount: 2 }),
    )
    setState({ project: PROJECT })
    const { unmount } = render(<MaintenanceSection />)
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.scanButton"))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.maintenance.dedup.failed")).toBeTruthy()
    })
    expect(screen.getByText("merge exploded")).toBeTruthy()
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.retry"))
    await waitFor(() => {
      expect(mocks.retryTask).toHaveBeenCalledWith("t1")
    })
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.delete"))
    await waitFor(() => {
      expect(mocks.cancelTask).toHaveBeenCalledWith("t1")
    })
    unmount()
  })

  it("任务完成移出队列 → 卡片标记 merged（最近观察过 in-flight）", async () => {
    mocks.runDuplicateDetection.mockResolvedValue([makeGroup()])
    mocks.queue.push(makeTask({ id: "t1", status: "processing" }))
    setState({ project: PROJECT })
    const { unmount } = render(<MaintenanceSection />)
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.scanButton"))
    await waitFor(() => {
      expect(screen.getByText("settings.sections.maintenance.dedup.merging")).toBeTruthy()
    })
    // 任务完成（队列移除）→ 下一 tick 检测到 in-flight → gone → merged
    mocks.queue.length = 0
    await tickPoll()
    expect(screen.getByText("settings.sections.maintenance.dedup.merged")).toBeTruthy()
    unmount()
  })

  it("标记不是重复：addNotDuplicate + skipped 状态", async () => {
    mocks.runDuplicateDetection.mockResolvedValue([
      makeGroup({ slugs: ["张三", "张先生"] }),
      makeGroup({ slugs: ["九阳神功", "九阳真经"] }),
    ])
    setState({ project: PROJECT })
    const { unmount } = render(<MaintenanceSection />)
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.scanButton"))
    await waitFor(() => {
      expect(screen.getAllByText("high").length).toBe(2)
    })
    // 点击第一组卡片的“不是重复”
    const notDupButtons = screen.getAllByText("settings.sections.maintenance.dedup.notDuplicates")
    fireEvent.click(notDupButtons[0])
    await waitFor(() => {
      expect(mocks.addNotDuplicate).toHaveBeenCalledWith("/p/test", ["张三", "张先生"])
    })
    expect(screen.getByText("settings.sections.maintenance.dedup.skipped")).toBeTruthy()
    // skipped 组操作区消失，仅剩第二组的 merge 按钮
    expect(screen.getAllByText("settings.sections.maintenance.dedup.mergeButton").length).toBe(1)
    // 第二组卡片保持可操作（map 的 else 分支）
    expect(screen.getByText("settings.sections.maintenance.dedup.mergeButton")).toBeTruthy()
    unmount()
  })

  it("enqueue 失败与 addNotDuplicate 失败仅 console.error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.runDuplicateDetection.mockResolvedValue([makeGroup()])
    mocks.enqueueMerge.mockRejectedValueOnce(new Error("queue down"))
    mocks.addNotDuplicate.mockRejectedValueOnce(new Error("storage down"))
    setState({ project: PROJECT })
    const { unmount } = render(<MaintenanceSection />)
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.scanButton"))
    await waitFor(() => {
      expect(screen.getByText("high")).toBeTruthy()
    })
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.mergeButton"))
    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith("[Maintenance] enqueue failed:", expect.any(Error))
    })
    fireEvent.click(screen.getByText("settings.sections.maintenance.dedup.notDuplicates"))
    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith("[Maintenance] addNotDuplicate failed:", expect.any(Error))
    })
    errorSpy.mockRestore()
    unmount()
  })
})

describe("MaintenanceSection — 孤儿任务列表（无匹配卡片）", () => {
  beforeEach(() => {
    resetBaseline()
    setupDomGlobals()
  })

  it("队列任务无对应分组卡片时展示 orphan 列表（状态/重试/删除/错误）", async () => {
    mocks.queue.push(
      makeTask({ id: "o1", status: "pending", group: makeGroup({ slugs: ["旧A", "旧B"] }), canonicalSlug: "旧A" }),
      makeTask({ id: "o2", status: "done", group: makeGroup({ slugs: ["完成A", "完成B"] }), canonicalSlug: "完成A" }),
      makeTask({ id: "o3", status: "failed", group: makeGroup({ slugs: ["失败A", "失败B"] }), canonicalSlug: "失败A", error: "连接超时", retryCount: 1 }),
      makeTask({ id: "o4", status: "processing", group: makeGroup({ slugs: ["处理A", "处理B"] }), canonicalSlug: "处理A" }),
    )
    setState({ project: PROJECT })
    const { unmount } = render(<MaintenanceSection />)
    await waitFor(() => {
      expect(screen.getByText("settings.sections.maintenance.dedup.queueTitle")).toBeTruthy()
    })
    expect(screen.getByText("旧A + 旧B")).toBeTruthy()
    expect(screen.getByText("完成A + 完成B")).toBeTruthy()
    expect(screen.getByText("失败A + 失败B")).toBeTruthy()
    expect(screen.getByText("处理A + 处理B")).toBeTruthy()
    // 状态 chip：queued / done(无 chip) / failed（含 retry 按钮）/ merging
    expect(screen.getByText("settings.sections.maintenance.dedup.queued")).toBeTruthy()
    expect(screen.getByText("settings.sections.maintenance.dedup.failed")).toBeTruthy()
    expect(screen.getByText("settings.sections.maintenance.dedup.merging")).toBeTruthy()
    expect(screen.getByText("连接超时")).toBeTruthy()
    // failed 任务同时有 retry 与 delete 按钮
    const retryButtons = screen.getAllByText("settings.sections.maintenance.dedup.retry")
    expect(retryButtons.length).toBe(1)
    fireEvent.click(retryButtons[0])
    await waitFor(() => {
      expect(mocks.retryTask).toHaveBeenCalledWith("o3")
    })
    // delete 对所有 orphan 渲染（4 个 + failed 卡片内的 delete 不在此列表）
    const deleteButtons = screen.getAllByText("settings.sections.maintenance.dedup.delete")
    expect(deleteButtons.length).toBe(4)
    fireEvent.click(deleteButtons[0])
    await waitFor(() => {
      expect(mocks.cancelTask).toHaveBeenCalledWith("o1")
    })
    unmount()
  })

  it("无孤儿任务（全部匹配卡片或队列为空）→ 不渲染 orphan 列表", async () => {
    setState({ project: PROJECT })
    render(<MaintenanceSection />)
    expect(screen.queryByText("settings.sections.maintenance.dedup.queueTitle")).toBeNull()
  })
})
