// @vitest-environment jsdom
import { act, render, screen, fireEvent, setupDomGlobals } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CapabilityReplayDrawer } from "./capability-replay-drawer"

const mocks = vi.hoisted(() => ({ read: vi.fn(async (): Promise<unknown[]> => []), project: { path: "E:/Novel" } as unknown })) 
vi.mock("@/lib/agent/capability-trace-store", () => ({ readCapabilityTraces: mocks.read }))
vi.mock("@/stores/wiki-store", () => ({ useWikiStore: (sel: (s: unknown) => unknown) => sel({ project: mocks.project }) }))
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string, d?: string) => d ?? k }) }))

beforeEach(() => { vi.clearAllMocks(); mocks.read.mockResolvedValue([]); mocks.project = { path: "E:/Novel" } as unknown; setupDomGlobals() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("CapabilityReplayDrawer", () => {
  it("空态", async () => {
    render(<CapabilityReplayDrawer />)
    fireEvent.click(screen.getByRole("button"))
    expect(await screen.findByText("暂无能力规划记录")).toBeInTheDocument()
    await act(async () => {})
  })
  it("有记录展示链", async () => {
    mocks.read.mockResolvedValue([{ query: "q", intent: "write", mode: "deep", retrieved: [], filteredOut: [], planned: [{ id: "a" }, { id: "b" }], outcome: "success", at: 1 }])
    render(<CapabilityReplayDrawer />)
    fireEvent.click(screen.getByRole("button"))
    expect(await screen.findByText("write · deep · success")).toBeInTheDocument()
    await act(async () => {})
  })

  it("读 trace 失败：错误上屏并退化为空态（不阻断诊断面板）", async () => {
    mocks.read.mockRejectedValue(new Error("trace boom"))
    render(<CapabilityReplayDrawer />)
    fireEvent.click(screen.getByRole("button"))
    // 旁路观测失败只上屏错误文案 + 空态，不抛错
    expect(await screen.findByText("trace boom")).toBeInTheDocument()
    expect(screen.getByText("暂无能力规划记录")).toBeInTheDocument()
    await act(async () => {})
  })

  it("planned 为空数组时链路显示 (empty)", async () => {
    mocks.read.mockResolvedValue([{ query: "q", intent: "chat", mode: "fast", retrieved: [], filteredOut: [], planned: [], outcome: "skipped", at: 2 }])
    render(<CapabilityReplayDrawer />)
    fireEvent.click(screen.getByRole("button"))
    expect(await screen.findByText("chat · fast · skipped")).toBeInTheDocument()
    expect(screen.getByText("(empty)")).toBeInTheDocument()
    await act(async () => {})
  })

  it("再次点击收起抽屉：不重复读取 trace", async () => {
    mocks.read.mockResolvedValue([{ query: "q", intent: "write", mode: "deep", retrieved: [], filteredOut: [], planned: [{ id: "a" }], outcome: "success", at: 3 }])
    render(<CapabilityReplayDrawer />)
    const button = screen.getByRole("button")
    fireEvent.click(button)
    expect(await screen.findByText("write · deep · success")).toBeInTheDocument()
    await act(async () => {})
    fireEvent.click(button)
    // 收起：记录区消失，且不再触发读取
    expect(screen.queryByText("write · deep · success")).toBeNull()
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })

  it("无项目路径：按钮禁用且不读取 trace", async () => {
    mocks.project = null
    render(<CapabilityReplayDrawer />)
    const button = screen.getByRole("button")
    expect(button).toBeDisabled()
    fireEvent.click(button)
    await act(async () => {})
    expect(mocks.read).not.toHaveBeenCalled()
    expect(screen.queryByText("暂无能力规划记录")).toBeNull()
  })
})
