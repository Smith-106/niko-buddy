// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { BranchManagerPanel } from "./branch-manager-panel"
import type { SimulationBranch } from "@/lib/novel"

function makeBranch(overrides: Partial<SimulationBranch> = {}): SimulationBranch {
  return {
    id: "b1",
    name: "分支一",
    frameworkId: "fw1",
    mode: "event-driven",
    createdAt: "2026-10-30T11:21:00.000Z",
    timelineEvents: [],
    rumors: [],
    finalAgentSnapshots: [],
    directorEvaluations: [],
    overallScore: 80,
    scoreDetails: {
      avgDirectorScore: 7.25,
      eventCount: 12,
      characterDiversity: 0.456,
      plotProgression: 0.789,
    },
    ...overrides,
  }
}

function noopProps() {
  return {
    branches: [] as SimulationBranch[],
    activeBranchId: null as string | null,
    compareBranchIds: [] as string[],
    isCompareMode: false,
    onSaveBranch: vi.fn(),
    onDeleteBranch: vi.fn(),
    onRenameBranch: vi.fn(),
    onSwitchBranch: vi.fn(),
    onToggleCompareBranch: vi.fn(),
    onSetCompareMode: vi.fn(),
    onClearCompareSelection: vi.fn(),
  }
}

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("BranchManagerPanel 空态", () => {
  it("无分支时渲染空态提示与 0/10 计数", () => {
    render(<BranchManagerPanel {...noopProps()} />)
    expect(screen.getByText("暂无保存的分支")).toBeTruthy()
    expect(screen.getByText("输入分支名称 → 点击「创建分支」保存当前推演状态")).toBeTruthy()
    expect(screen.getByText("后续可在分支间切换对比")).toBeTruthy()
    expect(screen.getByText("0/10")).toBeTruthy()
    // 分支数 < 2 时不渲染对比区
    expect(screen.queryByText("对比选中的分支")).toBeNull()
  })
})

describe("BranchManagerPanel 创建分支", () => {
  it("输入合法名称点击创建 → 回调收到名称且输入框被清空", () => {
    const props = noopProps()
    render(<BranchManagerPanel {...props} />)
    const input = screen.getByPlaceholderText("输入分支名称...") as HTMLInputElement
    fireEvent.change(input, { target: { value: "  新分支  " } })
    fireEvent.click(screen.getByText("创建分支"))
    expect(props.onSaveBranch).toHaveBeenCalledTimes(1)
    expect(props.onSaveBranch).toHaveBeenCalledWith("新分支")
    expect(input.value).toBe("")
  })

  it("空白名称不创建且创建按钮禁用", () => {
    const props = noopProps()
    render(<BranchManagerPanel {...props} />)
    const input = screen.getByPlaceholderText("输入分支名称...") as HTMLInputElement
    const button = screen.getByText("创建分支").closest("button") as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.change(input, { target: { value: "   " } })
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    fireEvent.keyDown(input, { key: "Enter" })
    expect(props.onSaveBranch).not.toHaveBeenCalled()
  })

  it("Enter 键提交创建，非 Enter 键不提交", () => {
    const props = noopProps()
    render(<BranchManagerPanel {...props} />)
    const input = screen.getByPlaceholderText("输入分支名称...") as HTMLInputElement
    fireEvent.change(input, { target: { value: "分支A" } })
    fireEvent.keyDown(input, { key: "a" })
    expect(props.onSaveBranch).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: "Enter" })
    expect(props.onSaveBranch).toHaveBeenCalledWith("分支A")
  })

  it("达到 10 个分支时禁用输入并显示上限警告，且 handleSave 被上限拦截", () => {
    const props = noopProps()
    props.branches = Array.from({ length: 10 }, (_, i) =>
      makeBranch({ id: `b${i}`, name: `分支${i}`, overallScore: i }),
    )
    render(<BranchManagerPanel {...props} />)
    expect(screen.getByText("分支数量已达上限（10个），请先删除部分分支")).toBeTruthy()
    expect(screen.getByText("10/10")).toBeTruthy()
    const input = screen.getByPlaceholderText("输入分支名称...") as HTMLInputElement
    expect(input.disabled).toBe(true)
    // 即使绕过 DOM disabled（直接派发 change），handleSave 内部仍被 isMaxBranches 拦截
    fireEvent.change(input, { target: { value: "超额分支" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(props.onSaveBranch).not.toHaveBeenCalled()
  })
})

describe("BranchManagerPanel 列表渲染", () => {
  it("按 overallScore 降序排序并把推荐徽章给最高分", () => {
    const props = noopProps()
    props.branches = [
      makeBranch({ id: "low", name: "低分", overallScore: 10 }),
      makeBranch({ id: "high", name: "高分", overallScore: 99 }),
      makeBranch({ id: "mid", name: "中分", overallScore: 50 }),
    ]
    render(<BranchManagerPanel {...props} />)
    const names = screen.getAllByText(/^(低分|中分|高分)$/).map((n) => n.textContent)
    expect(names).toEqual(["高分", "中分", "低分"])
    // 仅第一名（推荐位）带「推荐」徽章
    expect(screen.getAllByText("推荐")).toHaveLength(1)
  })

  it("渲染分数明细：单值 toFixed(1)、百分比四舍五入", () => {
    const props = noopProps()
    props.branches = [
      makeBranch({
        overallScore: 87.654,
        scoreDetails: {
          avgDirectorScore: 7.25,
          eventCount: 12,
          characterDiversity: 0.456,
          plotProgression: 0.789,
        },
      }),
    ]
    render(<BranchManagerPanel {...props} />)
    expect(screen.getByText("87.7 分")).toBeTruthy()
    expect(screen.getByText("7.3")).toBeTruthy()
    expect(screen.getByText("12")).toBeTruthy()
    // 0.456*100 = 45.6 → 46；0.789*100 = 78.9 → 79
    expect(screen.getByText("46%")).toBeTruthy()
    expect(screen.getByText("79%")).toBeTruthy()
    expect(screen.getByText("事件驱动")).toBeTruthy()
  })

  it("激活分支显示当前分支徽章，非激活分支不显示", () => {
    const props = noopProps()
    props.branches = [
      makeBranch({ id: "a", name: "甲", overallScore: 90 }),
      makeBranch({ id: "b", name: "乙", overallScore: 50 }),
    ]
    props.activeBranchId = "b"
    render(<BranchManagerPanel {...props} />)
    expect(screen.getAllByText(/当前显示此分支/)).toHaveLength(1)
  })

  it("选中参与对比的分支 checkbox 为勾选态", () => {
    const props = noopProps()
    props.branches = [
      makeBranch({ id: "a", name: "甲", overallScore: 90 }),
      makeBranch({ id: "b", name: "乙", overallScore: 50 }),
    ]
    props.compareBranchIds = ["a"]
    render(<BranchManagerPanel {...props} />)
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[]
    expect(boxes[0].checked).toBe(true)
    expect(boxes[1].checked).toBe(false)
    fireEvent.click(boxes[1])
    expect(props.onToggleCompareBranch).toHaveBeenCalledWith("b")
  })

  it("未知模拟模式的 branch 回退到原始 mode 文本", () => {
    const props = noopProps()
    props.branches = [
      makeBranch({
        mode: "legacy-mode" as unknown as SimulationBranch["mode"],
      }),
    ]
    render(<BranchManagerPanel {...props} />)
    expect(screen.getByText("legacy-mode")).toBeTruthy()
  })
})

describe("BranchManagerPanel 重命名", () => {
  it("点击重命名进入编辑态并聚焦输入，Enter 提交去空格后的新名称", () => {
    const props = noopProps()
    props.branches = [makeBranch({ id: "a", name: "旧名" })]
    render(<BranchManagerPanel {...props} />)
    fireEvent.click(screen.getByTitle("重命名"))
    const editor = screen.getByDisplayValue("旧名") as HTMLInputElement
    expect(document.activeElement).toBe(editor)
    fireEvent.change(editor, { target: { value: "  新名  " } })
    fireEvent.keyDown(editor, { key: "Enter" })
    expect(props.onRenameBranch).toHaveBeenCalledWith("a", "新名")
    // 提交后退出编辑态，回到只读文本
    expect(screen.queryByDisplayValue("  新名  ")).toBeNull()
    expect(screen.getByText("旧名")).toBeTruthy()
  })

  it("Escape 取消编辑且不触发重命名回调", () => {
    const props = noopProps()
    props.branches = [makeBranch({ id: "a", name: "旧名" })]
    render(<BranchManagerPanel {...props} />)
    fireEvent.click(screen.getByTitle("重命名"))
    const editor = screen.getByDisplayValue("旧名") as HTMLInputElement
    fireEvent.change(editor, { target: { value: "改了但逃逸" } })
    fireEvent.keyDown(editor, { key: "Escape" })
    expect(props.onRenameBranch).not.toHaveBeenCalled()
    expect(screen.getByText("旧名")).toBeTruthy()
  })

  it("编辑态清空名称后失焦 → 不调用重命名，仅退出编辑态", () => {
    const props = noopProps()
    props.branches = [makeBranch({ id: "a", name: "旧名" })]
    render(<BranchManagerPanel {...props} />)
    fireEvent.click(screen.getByTitle("重命名"))
    const editor = screen.getByDisplayValue("旧名") as HTMLInputElement
    fireEvent.change(editor, { target: { value: "   " } })
    fireEvent.blur(editor)
    expect(props.onRenameBranch).not.toHaveBeenCalled()
    expect(screen.queryByDisplayValue("   ")).toBeNull()
  })
})

describe("BranchManagerPanel 删除", () => {
  it("确认框通过时删除分支，确认文案带分支名", () => {
    const props = noopProps()
    props.branches = [makeBranch({ id: "a", name: "待删" })]
    render(<BranchManagerPanel {...props} />)
    fireEvent.click(screen.getByTitle("删除"))
    expect(window.confirm).toHaveBeenCalledWith("确定要删除分支「待删」吗？")
    expect(props.onDeleteBranch).toHaveBeenCalledWith("a")
  })

  it("取消确认时不删除分支", () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    const props = noopProps()
    props.branches = [makeBranch({ id: "a", name: "待删" })]
    render(<BranchManagerPanel {...props} />)
    fireEvent.click(screen.getByTitle("删除"))
    expect(props.onDeleteBranch).not.toHaveBeenCalled()
  })
})

describe("BranchManagerPanel 查看与对比", () => {
  it("点击查看按钮切换到对应分支", () => {
    const props = noopProps()
    props.branches = [makeBranch({ id: "a" })]
    render(<BranchManagerPanel {...props} />)
    fireEvent.click(screen.getByTitle("查看此分支"))
    expect(props.onSwitchBranch).toHaveBeenCalledWith("a")
  })

  it("已选分支但未进入对比模式时显示清空条并可清空", () => {
    const props = noopProps()
    props.branches = [makeBranch({ id: "a" }), makeBranch({ id: "b", overallScore: 10 })]
    props.compareBranchIds = ["a"]
    render(<BranchManagerPanel {...props} />)
    expect(screen.getByText("已选 1/3 个分支")).toBeTruthy()
    fireEvent.click(screen.getByText("清空"))
    expect(props.onClearCompareSelection).toHaveBeenCalledTimes(1)
  })

  it("已在对比模式时不显示清空条", () => {
    const props = noopProps()
    props.branches = [makeBranch({ id: "a" }), makeBranch({ id: "b", overallScore: 10 })]
    props.compareBranchIds = ["a"]
    props.isCompareMode = true
    render(<BranchManagerPanel {...props} />)
    expect(screen.queryByText("清空")).toBeNull()
  })

  it("选中不足 2 个时对比按钮禁用并提示还差几个", () => {
    const props = noopProps()
    props.branches = [makeBranch({ id: "a" }), makeBranch({ id: "b", overallScore: 10 })]
    props.compareBranchIds = ["a"]
    render(<BranchManagerPanel {...props} />)
    const button = screen.getByText("对比选中的分支").closest("button") as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText("请再选择 1 个分支")).toBeTruthy()
    fireEvent.click(button)
    expect(props.onSetCompareMode).not.toHaveBeenCalled()
  })

  it("选中 2 个时对比按钮可用并进入对比模式", () => {
    const props = noopProps()
    props.branches = [
      makeBranch({ id: "a", overallScore: 90 }),
      makeBranch({ id: "b", overallScore: 10 }),
    ]
    props.compareBranchIds = ["a", "b"]
    render(<BranchManagerPanel {...props} />)
    const button = screen.getByText("对比选中的分支").closest("button") as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(props.onSetCompareMode).toHaveBeenCalledWith(true)
  })

  it("选中超过 3 个时对比按钮禁用且显示上限提示", () => {
    const props = noopProps()
    props.branches = ["a", "b", "c", "d"].map((id, i) =>
      makeBranch({ id, name: id, overallScore: 100 - i }),
    )
    props.compareBranchIds = ["a", "b", "c", "d"]
    render(<BranchManagerPanel {...props} />)
    const button = screen.getByText("对比选中的分支").closest("button") as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText("最多选择 3 个分支进行对比")).toBeTruthy()
  })
})
