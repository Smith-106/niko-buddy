// @vitest-environment jsdom
/** C4 冒烟覆盖：src/components/novel/story-simulation/framework-confirm-panel.tsx（自动生成，核心行为由专项 spec 加深） */
import { afterEach, describe, expect, it, vi } from "vitest"
import { FrameworkConfirmPanel } from "./framework-confirm-panel"
import { act, fireEvent, render, screen, within } from "@/test-helpers/component-test-utils"
import { cleanup } from "@testing-library/react"
import type { ComponentType } from "react"
import { useStorySimulationStore } from "@/stores/story-simulation-store"
import type { StoryFramework, StoryNode } from "@/lib/novel"
import zh from "@/i18n/zh.json"

const dndCapture: {
  onDragEnd?: (e: { active: { id: number | string }; over: { id: number | string } | null }) => void
} = {}

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>()
  return {
    ...actual,
    DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd?: unknown }) => {
      dndCapture.onDragEnd = onDragEnd as typeof dndCapture.onDragEnd
      return <>{children}</>
    },
    useSensors: (...args: unknown[]) => args,
    useSensor: (sensor: unknown, opts?: unknown) => ({ sensor, opts }),
    KeyboardSensor: function KeyboardSensor() {},
    PointerSensor: function PointerSensor() {},
    closestCenter: vi.fn(),
  }
})

vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>()
  return {
    ...actual,
    SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useSortable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => {},
      transform: null,
      transition: undefined,
      isDragging: false,
    }),
    verticalListSortingStrategy: vi.fn(),
  }
})

vi.mock("@dnd-kit/utilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/utilities")>()
  return { ...actual, CSS: { Transform: { toString: () => "" } } }
})

const T = zh.storySimulation as unknown as Record<string, string>
const TC = zh.common as unknown as Record<string, string>

function makeNode(index: number, overrides: Partial<StoryNode> = {}): StoryNode {
  return {
    index,
    phase: (["起", "承", "转", "合"] as const)[index % 4],
    title: `节点${index + 1}`,
    coreConflict: `冲突${index + 1}`,
    involvedCharacters: ["寨主", "军师"],
    goal: `目标${index + 1}`,
    causeFromPrev: `起因${index + 1}`,
    expectedOutcome: `结局${index + 1}`,
    ...overrides,
  }
}

function makeFramework(overrides: Record<string, unknown> = {}): StoryFramework {
  return {
    id: "f1",
    title: "测试框架",
    shortTitle: "短标题",
    premise: "这是前提",
    targetWords: 10000,
    simulationMode: "quick",
    sourceChapters: 0,
    nodes: [makeNode(0), makeNode(1)],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as unknown as StoryFramework
}

afterEach(() => {
  cleanup()
  useStorySimulationStore.setState({ currentFramework: null } as never)
})

describe("framework-confirm-panel.tsx smoke", () => {
  it("renders FrameworkConfirmPanel without crashing", () => {
    const C = FrameworkConfirmPanel as ComponentType
    const { unmount } = render(<C />)
    expect(document.body.innerHTML.length).toBeGreaterThan(0)
    unmount()
  })

  it("批次二·9：生成失败回退的空框架不能确认，提示先重新生成", () => {
    const empty = {
      id: "f1",
      title: "故事框架（生成失败，已回退为空框架）",
      shortTitle: "生成失败",
      premise: "llm-down",
      targetWords: 1000,
      simulationMode: "quick",
      sourceChapters: 0,
      nodes: [],
      createdAt: "2026-10-30T00:00:00.000Z",
    } as unknown as StoryFramework
    useStorySimulationStore.setState({ currentFramework: empty } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    expect(screen.getByTestId("framework-empty-hint")).toBeTruthy()
    const confirm = screen.getByRole("button", { name: /confirmFramework|确认框架/ }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
  })
})

describe("FrameworkConfirmPanel 基础渲染与空态", () => {
  it("currentFramework 为 null 时渲染 null", () => {
    useStorySimulationStore.setState({ currentFramework: null } as never)
    const { container } = render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    expect(container.innerHTML).toBe("")
  })

  it("正常框架渲染标题/短标题/前提/节点与四个阶段配色", () => {
    useStorySimulationStore.setState({
      currentFramework: makeFramework({ nodes: [makeNode(0), makeNode(1), makeNode(2), makeNode(3)] }),
    } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    expect(screen.getByText("测试框架")).toBeTruthy()
    expect(screen.getByText("短标题")).toBeTruthy()
    expect(screen.getByText("这是前提")).toBeTruthy()
    for (const t of ["节点1", "节点2", "节点3", "节点4"]) {
      expect(screen.getByText(t)).toBeTruthy()
    }
    for (const p of ["起", "承", "转", "合"]) {
      expect(screen.getByText(p)).toBeTruthy()
    }
    expect(screen.getByText(T.frameworkNodes)).toBeTruthy()
  })

  it("无 premise 显示 noPremise；无 onSave 时不渲染保存按钮", () => {
    useStorySimulationStore.setState({
      currentFramework: makeFramework({ premise: "", shortTitle: undefined }),
    } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    expect(screen.getByText(T.noPremise)).toBeTruthy()
    expect(screen.queryByText(T.saveFramework)).toBeNull()
  })

  it("非空框架确认可用，空框架主按钮变为重新生成", () => {
    const onConfirm = vi.fn()
    const onRegenerate = vi.fn()
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    const { unmount } = render(
      <FrameworkConfirmPanel onConfirm={onConfirm} onRegenerate={onRegenerate} />,
    )
    const confirm = screen.getByText(T.confirmFramework).closest("button") as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText(T.regenerateFramework))
    expect(onRegenerate).toHaveBeenCalledTimes(1)
    unmount()
  })

  it("onViewHistory 缺省时点击不抛错；传入时被调用", () => {
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    const { unmount } = render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    fireEvent.click(screen.getByText(T.viewHistory))
    unmount()
    const onViewHistory = vi.fn()
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} onViewHistory={onViewHistory} />)
    fireEvent.click(screen.getByText(T.viewHistory))
    expect(onViewHistory).toHaveBeenCalledTimes(1)
  })
})

describe("FrameworkConfirmPanel 保存", () => {
  it("点击保存调用 onSave 并显示已保存提示", () => {
    const onSave = vi.fn()
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} onSave={onSave} />)
    fireEvent.click(screen.getByText(T.saveFramework))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(screen.getByText(T.saved)).toBeTruthy()
  })
})

describe("FrameworkConfirmPanel 标题编辑", () => {
  it("编辑保存更新标题与短标题（去空格）", () => {
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: T.editTitle }))
    const titleInput = screen.getByDisplayValue("测试框架") as HTMLInputElement
    fireEvent.change(titleInput, { target: { value: "  新框架名  " } })
    const shortInput = screen.getByDisplayValue("短标题") as HTMLInputElement
    fireEvent.change(shortInput, { target: { value: "  短  " } })
    fireEvent.click(screen.getByRole("button", { name: TC.save }))
    const st = useStorySimulationStore.getState()
    expect(st.currentFramework?.title).toBe("新框架名")
    expect(st.currentFramework?.shortTitle).toBe("短")
    expect(screen.getByText("新框架名")).toBeTruthy()
  })

  it("空短标题保存为 undefined；编辑中隐藏顶部操作按钮", () => {
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} onSave={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: T.editTitle }))
    const shortInput = screen.getByDisplayValue("短标题") as HTMLInputElement
    fireEvent.change(shortInput, { target: { value: "   " } })
    fireEvent.click(screen.getByRole("button", { name: TC.save }))
    expect(useStorySimulationStore.getState().currentFramework?.shortTitle).toBeUndefined()
    // 编辑态隐藏操作区：确认按钮不在文档中
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
  })

  it("空标题不保存（守卫 return，仍停留在编辑态）", () => {
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: T.editTitle }))
    const titleInput = screen.getByDisplayValue("测试框架") as HTMLInputElement
    fireEvent.change(titleInput, { target: { value: "   " } })
    fireEvent.click(screen.getByRole("button", { name: TC.save }))
    expect(useStorySimulationStore.getState().currentFramework?.title).toBe("测试框架")
    // 仍在编辑态：标题输入框还在且值保持空白
    const boxes = screen.getAllByRole("textbox") as HTMLInputElement[]
    expect(boxes[0].value).toBe("   ")
  })

  it("取消放弃修改；Enter 保存、Escape 取消", () => {
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: T.editTitle }))
    fireEvent.change(screen.getByDisplayValue("测试框架"), { target: { value: "改了但取消" } })
    fireEvent.click(screen.getByRole("button", { name: TC.cancel }))
    expect(useStorySimulationStore.getState().currentFramework?.title).toBe("测试框架")
    // Enter 保存
    fireEvent.click(screen.getByRole("button", { name: T.editTitle }))
    const titleInput = screen.getByDisplayValue("测试框架") as HTMLInputElement
    fireEvent.change(titleInput, { target: { value: "回车保存" } })
    fireEvent.keyDown(titleInput, { key: "Enter" })
    expect(useStorySimulationStore.getState().currentFramework?.title).toBe("回车保存")
    // Escape 取消
    fireEvent.click(screen.getByRole("button", { name: T.editTitle }))
    const titleInput2 = screen.getByDisplayValue("回车保存") as HTMLInputElement
    fireEvent.change(titleInput2, { target: { value: "按了逃逸" } })
    fireEvent.keyDown(titleInput2, { key: "Escape" })
    expect(useStorySimulationStore.getState().currentFramework?.title).toBe("回车保存")
  })

  it("短标题输入 IME 组合中按 Enter 不保存", () => {
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: T.editTitle }))
    const shortInput = screen.getByDisplayValue("短标题") as HTMLInputElement
    fireEvent.change(shortInput, { target: { value: "拼" } })
    fireEvent.keyDown(shortInput, { key: "Enter", keyCode: 229 })
    // 未保存：仍在编辑态，store 未变
    expect(useStorySimulationStore.getState().currentFramework?.shortTitle).toBe("短标题")
    expect(screen.getByDisplayValue("拼")).toBeTruthy()
    // 正常 Enter 保存
    fireEvent.keyDown(shortInput, { key: "Enter", keyCode: 13 })
    expect(useStorySimulationStore.getState().currentFramework?.shortTitle).toBe("拼")
  })
})

describe("FrameworkConfirmPanel 前提编辑", () => {
  it("编辑保存更新 premise；取消放弃", () => {
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: T.editPremise }))
    const area = screen.getByDisplayValue("这是前提") as HTMLTextAreaElement
    fireEvent.change(area, { target: { value: "新前提内容" } })
    fireEvent.click(screen.getByText(T.save))
    expect(useStorySimulationStore.getState().currentFramework?.premise).toBe("新前提内容")
    // 再编辑后取消
    fireEvent.click(screen.getByRole("button", { name: T.editPremise }))
    fireEvent.change(screen.getByDisplayValue("新前提内容"), { target: { value: "丢弃" } })
    fireEvent.click(screen.getByText(TC.cancel))
    expect(useStorySimulationStore.getState().currentFramework?.premise).toBe("新前提内容")
  })
})

describe("FrameworkConfirmPanel 节点编辑", () => {
  it("编辑保存更新字段：标题去空格、人物按分隔符切分过滤", () => {
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    const editBtns = screen.getAllByRole("button", { name: T.editNode })
    expect(editBtns).toHaveLength(2)
    fireEvent.click(editBtns[0])
    fireEvent.change(screen.getByDisplayValue("节点1"), { target: { value: "  新节点名  " } })
    fireEvent.change(screen.getByDisplayValue("寨主、军师"), {
      target: { value: " 寨主，军师、 路人,, " },
    })
    fireEvent.change(screen.getByDisplayValue("冲突1"), { target: { value: "新冲突" } })
    fireEvent.click(screen.getByRole("button", { name: TC.save }))
    const node = useStorySimulationStore.getState().currentFramework?.nodes[0]
    expect(node?.title).toBe("新节点名")
    expect(node?.coreConflict).toBe("新冲突")
    expect(node?.involvedCharacters).toEqual(["寨主", "军师", "路人"])
    expect(screen.getByText("新节点名")).toBeTruthy()
  })

  it("空标题回退原标题；取消放弃修改", () => {
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    const editBtns = screen.getAllByRole("button", { name: T.editNode })
    fireEvent.click(editBtns[1])
    fireEvent.change(screen.getByDisplayValue("节点2"), { target: { value: "   " } })
    fireEvent.click(screen.getByRole("button", { name: TC.save }))
    expect(useStorySimulationStore.getState().currentFramework?.nodes[1].title).toBe("节点2")
    // 第二个节点取消路径
    fireEvent.click(screen.getAllByRole("button", { name: T.editNode })[1])
    fireEvent.change(screen.getByDisplayValue("节点2"), { target: { value: "丢弃" } })
    fireEvent.click(screen.getByRole("button", { name: TC.cancel }))
    expect(useStorySimulationStore.getState().currentFramework?.nodes[1].title).toBe("节点2")
  })

  it("节点标题 Enter 保存、Escape 取消；IME 组合中 Enter 不保存", () => {
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    fireEvent.click(screen.getAllByRole("button", { name: T.editNode })[0])
    const titleInput = screen.getByDisplayValue("节点1") as HTMLInputElement
    fireEvent.change(titleInput, { target: { value: "拼" } })
    fireEvent.keyDown(titleInput, { key: "Enter", keyCode: 229 })
    expect(useStorySimulationStore.getState().currentFramework?.nodes[0].title).toBe("节点1")
    fireEvent.keyDown(titleInput, { key: "Enter", keyCode: 13 })
    expect(useStorySimulationStore.getState().currentFramework?.nodes[0].title).toBe("拼")
    fireEvent.click(screen.getAllByRole("button", { name: T.editNode })[0])
    const titleInput2 = screen.getByDisplayValue("拼") as HTMLInputElement
    fireEvent.change(titleInput2, { target: { value: "逃逸" } })
    fireEvent.keyDown(titleInput2, { key: "Escape" })
    expect(useStorySimulationStore.getState().currentFramework?.nodes[0].title).toBe("拼")
  })

})

describe("FrameworkConfirmPanel 标题编辑补充", () => {
  it("无短标题框架进入编辑时短标题输入为空", () => {
    useStorySimulationStore.setState({
      currentFramework: makeFramework({ shortTitle: undefined }),
    } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: T.editTitle }))
    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[]
    expect(inputs).toHaveLength(2)
    expect(inputs[1].value).toBe("")
  })

  it("短标题输入 Escape 取消标题编辑", () => {
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    fireEvent.click(screen.getByRole("button", { name: T.editTitle }))
    const shortInput = screen.getByDisplayValue("短标题") as HTMLInputElement
    fireEvent.change(shortInput, { target: { value: "改了" } })
    fireEvent.keyDown(shortInput, { key: "Escape" })
    expect(useStorySimulationStore.getState().currentFramework?.shortTitle).toBe("短标题")
    expect(screen.getByText("测试框架")).toBeTruthy()
  })

  it("保存提示 2s 后消失", () => {
    vi.useFakeTimers()
    try {
      const onSave = vi.fn()
      useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
      render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} onSave={onSave} />)
      fireEvent.click(screen.getByText(T.saveFramework))
      expect(screen.getByText(T.saved)).toBeTruthy()
      act(() => {
        vi.advanceTimersByTime(2000)
      })
      expect(screen.queryByText(T.saved)).toBeNull()
      expect(screen.getByText(T.saveFramework)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("FrameworkConfirmPanel 节点编辑补充", () => {
  it("编辑保存更新目标/起因/结局字段", () => {
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    fireEvent.click(screen.getAllByRole("button", { name: T.editNode })[0])
    fireEvent.change(screen.getByDisplayValue("目标1"), { target: { value: "新目标" } })
    fireEvent.change(screen.getByDisplayValue("起因1"), { target: { value: "新起因" } })
    fireEvent.change(screen.getByDisplayValue("结局1"), { target: { value: "新结局" } })
    fireEvent.click(screen.getByRole("button", { name: TC.save }))
    const node = useStorySimulationStore.getState().currentFramework?.nodes[0]
    expect(node?.goal).toBe("新目标")
    expect(node?.causeFromPrev).toBe("新起因")
    expect(node?.expectedOutcome).toBe("新结局")
  })
})

describe("FrameworkConfirmPanel 拖拽排序", () => {
  it("跨节点拖拽重排并按新顺序重建 index", () => {
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    expect(dndCapture.onDragEnd).toBeTypeOf("function")
    act(() => {
      dndCapture.onDragEnd!({ active: { id: 0 }, over: { id: 1 } })
    })
    const nodes = useStorySimulationStore.getState().currentFramework?.nodes
    expect(nodes?.map((n) => n.title)).toEqual(["节点2", "节点1"])
    expect(nodes?.map((n) => n.index)).toEqual([0, 1])
    // 渲染顺序跟随新 index
    const cards = within(screen.getByText(T.frameworkNodes).parentElement as HTMLElement)
    expect(cards).toBeTruthy()
  })

  it("over 为空 / 同节点 / 未知 id 时不重排", () => {
    useStorySimulationStore.setState({ currentFramework: makeFramework() } as never)
    render(<FrameworkConfirmPanel onConfirm={vi.fn()} onRegenerate={vi.fn()} />)
    const before = JSON.stringify(useStorySimulationStore.getState().currentFramework?.nodes)
    act(() => {
      dndCapture.onDragEnd!({ active: { id: 0 }, over: null })
    })
    act(() => {
      dndCapture.onDragEnd!({ active: { id: 0 }, over: { id: 0 } })
    })
    act(() => {
      dndCapture.onDragEnd!({ active: { id: 99 }, over: { id: 1 } })
    })
    expect(JSON.stringify(useStorySimulationStore.getState().currentFramework?.nodes)).toBe(before)
  })
})
