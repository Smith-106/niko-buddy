/**
 * main-control-view.spec — 主控 Agent 面板（jsdom）。
 * 覆盖：空目标不触发运行 / 运行后轨迹与草稿渲染 / 错误提示 / 跳热力图入口 /
 * Draft-first 提示可见。
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

const runMainControlAgent = vi.fn()
const resolveWikiPath = vi.fn(async () => "/proj/wiki")
const setActiveView = vi.fn()

vi.mock("@/commands/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/commands/fs")>()
  return { ...actual, fileExists: vi.fn(async () => true) }
})

vi.mock("@/lib/novel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/novel")>()
  return { ...actual, runMainControlAgent, resolveWikiPath }
})

vi.mock("@/stores/wiki-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/wiki-store")>()
  const state = {
    project: { id: "p1", path: "/proj" },
    llmConfig: { provider: "openai", model: "gpt-test", apiKey: "k", baseUrl: "" },
    setActiveView,
  }
  const useWikiStore = <T,>(selector: (s: typeof state) => T) => selector(state)
  return { ...actual, useWikiStore }
})

const { MainControlView } = await import("./main-control-view")

afterEach(() => {
  cleanup()
  runMainControlAgent.mockReset()
  setActiveView.mockReset()
})

describe("MainControlView", () => {
  it("渲染目标输入与空态轨迹", () => {
    render(<MainControlView />)
    expect(screen.getByTestId("main-control-view")).toBeTruthy()
    expect(screen.getByTestId("main-control-goal")).toBeTruthy()
    expect(screen.getByTestId("main-control-steps").textContent).toContain("还没有工具调用")
    expect(screen.getByTestId("main-control-drafts").textContent).toContain("Draft-first")
  })

  it("空目标点击运行不会调用 Agent", () => {
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-run"))
    expect(runMainControlAgent).not.toHaveBeenCalled()
  })

  it("运行后渲染轨迹、草稿与终稿", async () => {
    runMainControlAgent.mockResolvedValue({
      ok: true,
      finalText: "已读完上下文并产出草稿。",
      roundsUsed: 3,
      steps: [
        { callId: "c1", name: "read_chapter", params: { name: "第12章" }, status: "done", result: "正文", at: 1 },
      ],
      drafts: [{ id: "draft_1_abc", chapterName: "第12章 旧梦", words: 1800 }],
    })
    render(<MainControlView />)
    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "给第12章写开头" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-step-read_chapter")).toBeTruthy())
    expect(screen.getByTestId("main-control-drafts").textContent).toContain("第12章 旧梦")
    expect(screen.getByTestId("main-control-drafts").textContent).toContain("1800")
    expect(screen.getByTestId("main-control-final").textContent).toContain("已读完上下文并产出草稿")
    expect(runMainControlAgent).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: "/proj", wikiPath: "/proj/wiki", goal: "给第12章写开头" }),
    )
  })

  it("Agent 返回错误时显示错误提示", async () => {
    runMainControlAgent.mockResolvedValue({
      ok: false,
      finalText: "",
      roundsUsed: 0,
      steps: [],
      drafts: [],
      error: "模型不支持工具调用",
    })
    render(<MainControlView />)
    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "任意目标" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-error")).toBeTruthy())
    expect(screen.getByTestId("main-control-error").textContent).toContain("模型不支持工具调用")
  })

  it("可以跳转到热力图", () => {
    render(<MainControlView />)
    fireEvent.click(screen.getByTestId("main-control-heatmap"))
    expect(setActiveView).toHaveBeenCalledWith("moduleHeatmap")
  })
})

describe("MainControlView 运行轨迹与证据", () => {
  it("每步显示输入摘要，展开后可见原始证据", async () => {
    runMainControlAgent.mockResolvedValue({
      ok: true,
      finalText: "完成",
      roundsUsed: 2,
      steps: [
        {
          callId: "c1",
          name: "read_chapter",
          params: { name: "第12章" },
          status: "done",
          result: "第12章正文全文……",
          at: 1000,
          finishedAt: 1420,
        },
      ],
      drafts: [],
    })
    render(<MainControlView />)
    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "读第12章" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-trace-entry-read_chapter")).toBeTruthy())
    expect(screen.getByTestId("main-control-trace-input-read_chapter").textContent).toContain("第12章")
    expect(screen.getByTestId("main-control-trace").textContent).toContain("420")
    expect(screen.queryByTestId("main-control-trace-raw-read_chapter")).toBeNull()
    fireEvent.click(screen.getByTestId("main-control-trace-toggle-read_chapter"))
    expect(screen.getByTestId("main-control-trace-raw-read_chapter").textContent).toContain("第12章正文全文")
  })

  it("失败步骤显示失败原因", async () => {
    runMainControlAgent.mockResolvedValue({
      ok: false,
      finalText: "",
      roundsUsed: 1,
      steps: [
        { callId: "c9", name: "write_chapter", params: {}, status: "error", error: "磁盘只读", at: 5 },
      ],
      drafts: [],
      error: "磁盘只读",
    })
    render(<MainControlView />)
    fireEvent.change(screen.getByTestId("main-control-goal"), { target: { value: "写第2章" } })
    fireEvent.click(screen.getByTestId("main-control-run"))
    await waitFor(() => expect(screen.getByTestId("main-control-trace-entry-write_chapter")).toBeTruthy())
    expect(screen.getByTestId("main-control-trace-entry-write_chapter").textContent).toContain("磁盘只读")
  })
})
